// 决定控制面命令客户端：两条写命令（接手 / 处理）。
// 规则：写操作一律带 operation_id（UUIDv7）；结果不可确认时只按同一 operation_id 查回执，绝不重发。
import { ApiError, type ApiClient } from './client.ts'
import type { OperationRow } from './types.ts'
import { operatorReason } from '../../core/operator-language.ts'
// UUIDv7 的造号实现在流程命令客户端里；本任务不许新增文件，直接复用同一份，避免两份实现走样。
import { newOperationId } from './workflow-commands.ts'

export type DecisionCommandKind = 'decision.acknowledge' | 'decision.resolve'

/** 面板控制面只允许这两条决定写命令。 */
export const DECISION_COMMAND_KINDS: readonly DecisionCommandKind[] = ['decision.acknowledge', 'decision.resolve']

export type DecisionAcknowledgeInput = { decisionId: string; revision: number }

export type DecisionConfirmation = { operationId: string; challenge: string }
export type DecisionResolveInput = { decisionId: string; revision: number; resolution: string; contentHash?: string; selectedNodeId?: string; confirmation?: DecisionConfirmation }

export class DecisionConfirmationRequired extends Error {
  readonly confirmation: DecisionConfirmation

  constructor(confirmation: DecisionConfirmation) {
    super('请确认这次裁决')
    this.confirmation = confirmation
  }
}

export type DecisionAcknowledgeResult = { decisionId: string; revision: number; status?: string }

export type DecisionResolveResult = { decisionId: string; revision: number }

export type DecisionCommandOutcome<T> = {
  operation_id: string
  kind: DecisionCommandKind
  replayed: boolean
  result: T
}

export type DecisionCommandsApi = {
  acknowledgeDecision(input: DecisionAcknowledgeInput): Promise<DecisionCommandOutcome<DecisionAcknowledgeResult>>
  resolveDecision(input: DecisionResolveInput): Promise<DecisionCommandOutcome<DecisionResolveResult>>
}

/** 错误分型的中文提示：每类一条可辨识的话，面板直接显示。 */
export const DECISION_ERROR_TEXT: Record<string, string> = {
  DECISION_REVISION_CONFLICT: '状态已变，请刷新后重试',
  COMMAND_BUSY: '命令正在处理中，请稍后再试',
  OPERATION_ID_CONFLICT: '命令编号冲突，请稍后重试',
  OPERATION_EXPIRED: '命令已过期，请重新发起',
  CONFIRMATION_EXPIRED: '确认已过期，请重新选择处理方式',
  CONFIRMATION_MISMATCH: '确认与本次处理不再匹配，请重新选择',
  FORBIDDEN: '没有权限处理这条决定',
  RESOLUTION_NOT_AVAILABLE: '当前状态下无法执行这项处理，请刷新后查看可用选项',
  NOT_FOUND: '找不到这条决定，可能已被处理',
  OPERATION_TIMEOUT: '结果未知，正在查回执',
  OPERATION_OUTCOME_UNKNOWN: '结果未知，正在查回执',
  SERVICE_UNAVAILABLE: '结果未知，正在查回执',
}

/** 把服务端错误翻译成面板上的一句中文。 */
export function describeDecisionError(error: unknown): string {
  if (error instanceof ApiError) {
    return Object.hasOwn(DECISION_ERROR_TEXT, error.code)
      ? DECISION_ERROR_TEXT[error.code]!
      : operatorReason(error.message || error.code)
  }
  return '操作没成功'
}

// 结果不可确认的错误：只能查回执，不能重发。
const AMBIGUOUS_CODES = new Set(['OPERATION_TIMEOUT', 'OPERATION_OUTCOME_UNKNOWN', 'SERVICE_UNAVAILABLE'])

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

async function submitDecisionCommand<T>(
  client: ApiClient,
  kind: DecisionCommandKind,
  path: string,
  body: Record<string, unknown>,
  operationId = newOperationId(),
): Promise<DecisionCommandOutcome<T>> {
  try {
    const posted = await client.post<T>(path, { ...body, operation_id: operationId })
    const result = posted.data as T & { replayed?: boolean }
    return { operation_id: operationId, kind, replayed: result.replayed === true, result }
  } catch (error) {
    if (kind === 'decision.resolve' && error instanceof ApiError && error.code === 'CONFIRMATION_REQUIRED') {
      const challenge = (error.details as { confirm_challenge?: unknown } | undefined)?.confirm_challenge
      if (typeof challenge === 'string' && challenge.length > 0) throw new DecisionConfirmationRequired({ operationId, challenge })
    }
    if (!(error instanceof ApiError) || !AMBIGUOUS_CODES.has(error.code)) throw error
    const recovered = await recoverResult(client, operationId)
    if (recovered === null) {
      throw new ApiError('OPERATION_OUTCOME_UNKNOWN', '结果未知，正在查回执', true, { operation_id: operationId, kind })
    }
    return { operation_id: operationId, kind, replayed: true, result: recovered as T }
  }
}

export function createDecisionCommandsApi(client: ApiClient): DecisionCommandsApi {
  return {
    acknowledgeDecision: (input) => submitDecisionCommand<DecisionAcknowledgeResult>(
      client,
      'decision.acknowledge',
      '/v1/decisions/acknowledge',
      { decisionId: input.decisionId, revision: input.revision },
    ),
    resolveDecision: (input) => submitDecisionCommand<DecisionResolveResult>(
      client,
      'decision.resolve',
      '/v1/decisions/resolve',
      {
        decisionId: input.decisionId,
        revision: input.revision,
        resolution: input.resolution,
        ...(input.contentHash ? { contentHash: input.contentHash } : {}),
        ...(input.selectedNodeId ? { payload: { selected_node_id: input.selectedNodeId } } : {}),
        ...(input.confirmation ? { confirm_challenge: input.confirmation.challenge } : {}),
      },
      input.confirmation?.operationId,
    ),
  }
}
