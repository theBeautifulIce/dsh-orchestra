// 流程控制面命令客户端：四条写命令 + 回执查询。
// 规则：写操作一律带 operation_id（UUIDv7）；结果不可确认时只按同一 operation_id 查回执，绝不重发。
import { ApiError, type ApiClient } from './client.ts'
import type { OperationRow } from './types.ts'

export type WorkflowCommandKind = 'workflow.create' | 'workflow.open_draft' | 'workflow.update' | 'workflow.publish'

export type CommandValidationIssue = { path: string; code: string; message: string }

export type CommandValidationReport = {
  errors: CommandValidationIssue[]
  truncated: boolean
  total: number
}

export type CreateWorkflowResult = {
  workflow_id: string
  revision: number
  validation: CommandValidationReport
}

export type OpenDraftResult = {
  workflow_id: string
  revision: number
  definition: unknown
  based_on_version: string | null
  created: boolean
}

export type UpdateDraftResult = {
  revision: number
  changed: boolean
  validation: CommandValidationReport
}

export type PublishWorkflowResult = {
  workflow_id: string
  version: string
  definition_hash: string
  based_on_version: string | null
  definition: unknown
}

export type WorkflowCommandOutcome<T> = {
  operation_id: string
  kind: WorkflowCommandKind
  replayed: boolean
  result: T
  receipt: OperationRow | null
}

export type CreateWorkflowInput = {
  workflow_id: string
  name: string
  definition: unknown
  scope?: 'reusable' | 'task_local'
}

export type OpenDraftInput = { workflow_id: string; base_version: number }

export type UpdateDraftInput = { workflow_id: string; revision: number; definition: unknown }

export type PublishWorkflowInput = {
  workflow_id: string
  revision: number
  base_version: number
  publish_note: string
}

export type WorkflowCommandsApi = {
  createWorkflow(input: CreateWorkflowInput): Promise<WorkflowCommandOutcome<CreateWorkflowResult>>
  openWorkflowDraft(input: OpenDraftInput): Promise<WorkflowCommandOutcome<OpenDraftResult>>
  updateWorkflowDraft(input: UpdateDraftInput): Promise<WorkflowCommandOutcome<UpdateDraftResult>>
  publishWorkflow(input: PublishWorkflowInput): Promise<WorkflowCommandOutcome<PublishWorkflowResult>>
  getOperation(operationId: string): Promise<OperationRow>
}

// 结果不可确认的错误：只能查回执，不能重发。
const AMBIGUOUS_CODES = new Set(['OPERATION_TIMEOUT', 'OPERATION_OUTCOME_UNKNOWN', 'SERVICE_UNAVAILABLE'])

const HEX = '0123456789abcdef'

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const source = globalThis.crypto
  if (source && typeof source.getRandomValues === 'function') {
    source.getRandomValues(bytes)
    return bytes
  }
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256)
  }
  return bytes
}

/** 客户端自造 UUIDv7：服务端幂等层只认 v7 形状（小写、版本位 7、变体位 8-b）。 */
export function newOperationId(now: number = Date.now()): string {
  const bytes = randomBytes(16)
  let timestamp = now
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256
    timestamp = Math.floor(timestamp / 256)
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f)
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)
  let hex = ''
  for (let index = 0; index < 16; index += 1) {
    hex += HEX.charAt((bytes[index]! >> 4) & 0x0f) + HEX.charAt(bytes[index]! & 0x0f)
    if (index === 3 || index === 5 || index === 7 || index === 9) hex += '-'
  }
  return hex
}

function isAmbiguous(error: unknown): error is ApiError {
  return error instanceof ApiError && AMBIGUOUS_CODES.has(error.code)
}

function receiptResult(row: OperationRow): unknown {
  if (!row.receipt_json) return null
  try {
    const parsed: unknown = JSON.parse(row.receipt_json)
    if (parsed && typeof parsed === 'object' && 'result' in parsed) {
      return (parsed as { result: unknown }).result
    }
    return parsed
  } catch {
    return null
  }
}

async function fetchReceipt(client: ApiClient, operationId: string): Promise<OperationRow | null> {
  try {
    const row = await client.get<OperationRow>('/v1/operations/get', { operation_id: operationId })
    return row.data
  } catch {
    return null
  }
}

/** 结果不可确认时按同一 operation_id 查回执；查不到就报未知，绝不换 id 重发。 */
async function recoverResult(client: ApiClient, operationId: string): Promise<unknown | null> {
  try {
    const row = await client.get<OperationRow>('/v1/operations/get', { operation_id: operationId })
    if (row.data.status !== 'applied') return null
    return receiptResult(row.data)
  } catch {
    return null
  }
}

async function submitCommand<T>(
  client: ApiClient,
  kind: WorkflowCommandKind,
  path: string,
  body: Record<string, unknown>,
): Promise<WorkflowCommandOutcome<T>> {
  const operationId = newOperationId()
  let result: T
  let replayed = false
  try {
    const posted = await client.post<T & { replayed?: boolean }>(path, { ...body, operation_id: operationId })
    result = posted.data
    replayed = posted.data?.replayed === true
  } catch (error) {
    if (!isAmbiguous(error)) throw error
    const recovered = await recoverResult(client, operationId)
    if (recovered === null) {
      throw new ApiError(
        'OPERATION_OUTCOME_UNKNOWN',
        '操作结果暂不可确认；请稍后查询回执，不要重新提交',
        true,
        { operation_id: operationId },
      )
    }
    result = recovered as T
    replayed = true
  }
  const receipt = await fetchReceipt(client, operationId)
  return { operation_id: operationId, kind, replayed, result, receipt }
}

export function createWorkflowCommandsApi(client: ApiClient): WorkflowCommandsApi {
  return {
    createWorkflow: (input) => submitCommand<CreateWorkflowResult>(client, 'workflow.create', '/v1/workflows', {
      workflow_id: input.workflow_id,
      name: input.name,
      definition: input.definition,
      ...(input.scope ? { scope: input.scope } : {}),
    }),
    openWorkflowDraft: (input) => submitCommand<OpenDraftResult>(client, 'workflow.open_draft', '/v1/workflows/open-draft', {
      workflow_id: input.workflow_id,
      base_version: input.base_version,
    }),
    updateWorkflowDraft: (input) => submitCommand<UpdateDraftResult>(client, 'workflow.update', '/v1/workflows/update', {
      workflow_id: input.workflow_id,
      revision: input.revision,
      definition: input.definition,
    }),
    publishWorkflow: (input) => submitCommand<PublishWorkflowResult>(client, 'workflow.publish', '/v1/workflows/publish', {
      workflow_id: input.workflow_id,
      revision: input.revision,
      base_version: input.base_version,
      publish_note: input.publish_note,
    }),
    getOperation: async (operationId) => (await client.get<OperationRow>('/v1/operations/get', { operation_id: operationId })).data,
  }
}
