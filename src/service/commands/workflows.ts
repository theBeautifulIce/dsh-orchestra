// 工作流写模型四条命令（规格 6.1–6.4，S4 计划 Task 5–8）
//
// 分工：
// - create / update 只做保存层校验（结构性问题阻断，图语义问题作为 validation.errors 返回）；
// - publish 做发布层全量校验，并在同一笔事务里完成「插版本 + 上调 current_version + 消费草稿 + 事件」；
// - 版本行不可变（027/028 的触发器兜底），current_version 只许上调。
import { type Tx } from '../../infra/sqlite/driver.ts'
import { appendEvent } from '../../infra/db/ledger.ts'
import { OrchError } from '../../core/errors.ts'
import {
  validatePublishLayer,
  validateSaveLayer,
  toReport,
  type PublishContext,
  type ValidationReport,
  type WorkflowDoc,
} from '../../core/workflow-doc.ts'
import { definitionHashOf } from '../workflows.ts'
import { requestHashOf, runIdempotentCommand } from './idempotency.ts'
import type { WorkflowDefinition, WorkflowNodeDef } from '../../core/workflow-def.ts'

export type WorkflowScope = 'reusable' | 'task_local'

type WorkflowRow = {
  workflow_id: string
  name: string
  status: string
  current_version: string | null
  scope: WorkflowScope
  owner_task_id: string | null
}

type DraftRow = {
  workflow_id: string
  revision: number
  doc_json: string
  based_on_version: string | null
  definition_hash: string | null
  published_version: string | null
}

const readWorkflow = (tx: Tx, workflowId: string): WorkflowRow | undefined =>
  tx.get<WorkflowRow>('SELECT workflow_id, name, status, current_version, scope, owner_task_id FROM workflows WHERE workflow_id = ?', [workflowId])

const readDraft = (tx: Tx, workflowId: string): DraftRow | undefined =>
  tx.get<DraftRow>('SELECT workflow_id, revision, doc_json, based_on_version, definition_hash, published_version FROM workflow_drafts WHERE workflow_id = ?', [workflowId])

const readVersionDoc = (tx: Tx, workflowId: string, version: string): WorkflowDoc | null => {
  const row = tx.get<{ doc_json: string | null }>('SELECT doc_json FROM workflow_versions WHERE workflow_id = ? AND version = ?', [workflowId, version])
  return row?.doc_json ? (JSON.parse(row.doc_json) as WorkflowDoc) : null
}

/** 草稿文档直接存原文：保存层已经过一遍 schema，读回来不用再猜 */
const saveDraft = (tx: Tx, p: {
  workflowId: string
  revision: number
  doc: WorkflowDoc
  basedOnVersion: string | null
  definitionHash: string
  actor: string
  now: string
  expectPreviousRevision?: number
}): void => {
  if (p.expectPreviousRevision === undefined) {
    tx.run(
      'INSERT INTO workflow_drafts (workflow_id, revision, doc_json, updated_by, updated_at, based_on_version, definition_hash, published_version) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
      [p.workflowId, p.revision, JSON.stringify(p.doc), p.actor, p.now, p.basedOnVersion, p.definitionHash],
    )
    return
  }
  const res = tx.run(
    'UPDATE workflow_drafts SET revision = ?, doc_json = ?, updated_by = ?, updated_at = ?, based_on_version = ?, definition_hash = ? '
    + 'WHERE workflow_id = ? AND revision = ? AND published_version IS NULL',
    [p.revision, JSON.stringify(p.doc), p.actor, p.now, p.basedOnVersion, p.definitionHash, p.workflowId, p.expectPreviousRevision],
  )
  if (res.changes !== 1) {
    throw new OrchError('WORKFLOW_REVISION_CONFLICT', '草稿 revision 不匹配或已被消费', {
      workflow_id: p.workflowId,
      expected_revision: p.expectPreviousRevision,
    })
  }
}

const draftHash = (doc: WorkflowDoc): string => definitionHashOf(runtimeProjection('draft', '0', doc))

/** 把 S4 文档投影成运行面定义：trigger 只是图入口，不进运行面节点表 */
export function runtimeProjection(workflowId: string, version: string, doc: WorkflowDoc): WorkflowDefinition {
  const nodes: WorkflowNodeDef[] = []
  for (const node of doc.nodes) {
    if (node.type === 'trigger') continue
    const cfg = (node.config ?? {}) as Record<string, unknown>
    const out: WorkflowNodeDef = {
      node_id: node.node_id,
      type: node.type as WorkflowNodeDef['type'],
    }
    if (cfg.tools !== undefined) out.tools = cfg.tools as WorkflowNodeDef['tools']
    if (cfg.pass_conditions !== undefined) out.pass_conditions = cfg.pass_conditions as WorkflowNodeDef['pass_conditions']
    if (cfg.required_hashes !== undefined) out.required_hashes = cfg.required_hashes as WorkflowNodeDef['required_hashes']
    if (node.type === 'wait') {
      out.wait = {
        wait_kind: cfg.wait_kind as 'event' | 'timer',
        match: cfg.match as { type: string; path?: string; equals?: unknown },
        max_wait_ms: cfg.max_wait_ms as number,
        from_seq: cfg.from_seq as number | undefined,
      }
    }
    if (node.type === 'subworkflow') {
      out.subworkflow = {
        workflow_id: cfg.workflow_id as string,
        pinned_version: cfg.pinned_version as number,
        resume_from: (cfg.resume_from ?? null) as string | null,
      }
    }
    nodes.push(out)
  }
  return { workflow_id: workflowId, workflow_version: version, nodes }
}

export type CreateWorkflowParams = {
  workflowId: string
  name: string
  definition: unknown
  scope?: WorkflowScope
  ownerTaskId?: string | null
  actor: string
  now: string
}

export function createWorkflow(tx: Tx, p: CreateWorkflowParams): { workflow_id: string; revision: number; validation: ValidationReport } {
  if (readWorkflow(tx, p.workflowId)) {
    throw new OrchError('WORKFLOW_VERSION_CONFLICT', '工作流已经存在', { workflow_id: p.workflowId })
  }
  const saved = validateSaveLayer(p.definition, { expectedName: p.name })
  if (saved.report.errors.length > 0) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', '定义没有通过保存层校验', {
      errors: saved.report.errors,
      total: saved.report.total,
      truncated: saved.report.truncated,
    })
  }
  const doc = saved.saved!
  tx.run(
    'INSERT INTO workflows (workflow_id, name, status, current_version, created_by, updated_by, created_at, updated_at, scope, owner_task_id) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)',
    [p.workflowId, p.name, 'active', p.actor, p.actor, p.now, p.now, p.scope ?? doc.scope ?? 'reusable', p.ownerTaskId ?? null],
  )
  saveDraft(tx, {
    workflowId: p.workflowId,
    revision: 1,
    doc,
    basedOnVersion: null,
    definitionHash: draftHash(doc),
    actor: p.actor,
    now: p.now,
  })
  return { workflow_id: p.workflowId, revision: 1, validation: toReport(saved.hints.errors) }
}

export type OpenDraftParams = { workflowId: string; actor: string; now: string }
export type OpenDraftResult = {
  workflow_id: string
  revision: number
  definition: WorkflowDoc
  based_on_version: string | null
  created: boolean
}

export function openDraft(tx: Tx, p: OpenDraftParams): OpenDraftResult {
  const workflow = readWorkflow(tx, p.workflowId)
  if (!workflow) {
    throw new OrchError('WORKFLOW_NOT_FOUND', '工作流不存在', { workflow_id: p.workflowId })
  }
  const draft = readDraft(tx, p.workflowId)
  if (draft && draft.published_version === null) {
    throw new OrchError('WORKFLOW_DRAFT_EXISTS', '已经有一张未发布的草稿', {
      workflow_id: p.workflowId,
      revision: draft.revision,
    })
  }
  if (!workflow.current_version) {
    // 从未发布过：没有可复用的基线，只能先 create + update
    throw new OrchError('WORKFLOW_NOT_PUBLISHED', '工作流还没有已发布版本，先补草稿再发布', {
      workflow_id: p.workflowId,
    })
  }
  const baseDoc = readVersionDoc(tx, p.workflowId, workflow.current_version)
  if (!baseDoc) {
    throw new OrchError('WORKFLOW_VERSION_NOT_FOUND', '当前版本的文档缺失', {
      workflow_id: p.workflowId,
      version: workflow.current_version,
    })
  }
  if (!draft) {
    saveDraft(tx, {
      workflowId: p.workflowId,
      revision: 1,
      doc: baseDoc,
      basedOnVersion: workflow.current_version,
      definitionHash: draftHash(baseDoc),
      actor: p.actor,
      now: p.now,
    })
    return { workflow_id: p.workflowId, revision: 1, definition: baseDoc, based_on_version: workflow.current_version, created: true }
  }
  // 已消费的草稿：重置成新草稿，revision 加一，基线指向当前版本（规格 6.3）
  const nextRevision = draft.revision + 1
  tx.run(
    'UPDATE workflow_drafts SET revision = ?, doc_json = ?, based_on_version = ?, definition_hash = ?, published_version = NULL, updated_by = ?, updated_at = ? WHERE workflow_id = ?',
    [nextRevision, JSON.stringify(baseDoc), workflow.current_version, draftHash(baseDoc), p.actor, p.now, p.workflowId],
  )
  return { workflow_id: p.workflowId, revision: nextRevision, definition: baseDoc, based_on_version: workflow.current_version, created: true }
}

export type UpdateDraftParams = {
  workflowId: string
  revision: number
  definition: unknown
  actor: string
  now: string
}

export function updateDraft(tx: Tx, p: UpdateDraftParams): { revision: number; validation: ValidationReport } {
  const workflow = readWorkflow(tx, p.workflowId)
  if (!workflow) throw new OrchError('WORKFLOW_NOT_FOUND', '工作流不存在', { workflow_id: p.workflowId })
  const draft = readDraft(tx, p.workflowId)
  if (!draft || draft.published_version !== null) {
    throw new OrchError('WORKFLOW_DRAFT_NOT_OPEN', '草稿不存在或已经被发布消费', { workflow_id: p.workflowId })
  }
  if (draft.revision !== p.revision) {
    throw new OrchError('WORKFLOW_REVISION_CONFLICT', '草稿 revision 已变', {
      workflow_id: p.workflowId,
      expected: p.revision,
      actual: draft.revision,
    })
  }
  const saved = validateSaveLayer(p.definition)
  if (saved.report.errors.length > 0) {
    const first = saved.report.errors[0]!
    throw new OrchError(first.code as 'WORKFLOW_VALIDATION_FAILED', first.message, {
      path: first.path,
      errors: saved.report.errors,
      total: saved.report.total,
      truncated: saved.report.truncated,
    })
  }
  const doc = saved.saved!
  saveDraft(tx, {
    workflowId: p.workflowId,
    revision: p.revision + 1,
    doc,
    basedOnVersion: draft.based_on_version,
    definitionHash: draftHash(doc),
    actor: p.actor,
    now: p.now,
    expectPreviousRevision: p.revision,
  })
  return { revision: p.revision + 1, validation: toReport(saved.hints.errors) }
}

export type PublishParams = {
  workflowId: string
  revision: number
  baseVersion: number | null
  note?: string | null
  actor: string
  now: string
}

export type PublishResult = {
  workflow_id: string
  version: string
  definition_hash: string
  based_on_version: string | null
}

/** 规格 6.2：步骤 2–9 同笔事务，任何一步失败整笔回滚 */
export function publishDraft(tx: Tx, p: PublishParams, ctx: PublishContext): PublishResult {
  const workflow = readWorkflow(tx, p.workflowId)
  if (!workflow) throw new OrchError('WORKFLOW_NOT_FOUND', '工作流不存在', { workflow_id: p.workflowId })

  const draft = readDraft(tx, p.workflowId)
  if (!draft) {
    throw new OrchError('WORKFLOW_REVISION_CONFLICT', '没有可发布的草稿', { workflow_id: p.workflowId })
  }
  if (draft.published_version !== null) {
    throw new OrchError('WORKFLOW_DRAFT_NOT_OPEN', '这张草稿已经被发布过', {
      workflow_id: p.workflowId,
      published_version: draft.published_version,
    })
  }
  if (draft.revision !== p.revision) {
    throw new OrchError('WORKFLOW_REVISION_CONFLICT', '草稿 revision 已变', {
      workflow_id: p.workflowId,
      expected: p.revision,
      actual: draft.revision,
    })
  }
  const base = workflow.current_version === null ? 0 : Number(workflow.current_version)
  if (p.baseVersion !== base) {
    throw new OrchError('WORKFLOW_VERSION_CONFLICT', '当前版本已经变了', {
      workflow_id: p.workflowId,
      expected_base: p.baseVersion,
      actual_base: base,
    })
  }

  const doc = JSON.parse(draft.doc_json) as WorkflowDoc
  const issues = validatePublishLayer(doc, ctx)
  if (issues.length > 0) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', '定义没有通过发布层校验', {
      errors: toReport(issues).errors,
      total: issues.length,
      truncated: issues.length > 100,
    })
  }

  const version = String(base + 1)
  const runtime = runtimeProjection(p.workflowId, version, doc)
  const definitionHash = definitionHashOf(runtime)
  const basedOn = base === 0 ? null : String(base)
  tx.run(
    'INSERT INTO workflow_versions (workflow_id, version, content_hash, definition_json, created_at, doc_json, published_by, based_on_version, publish_note) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [p.workflowId, version, definitionHash, JSON.stringify(runtime), p.now, JSON.stringify(doc), p.actor, basedOn, p.note ?? null],
  )
  // current_version 只许从 NULL 或 base 上调到 base+1，不许回退
  const bumped = tx.run(
    'UPDATE workflows SET current_version = ?, updated_by = ?, updated_at = ? WHERE workflow_id = ? AND (current_version IS NULL OR current_version = ?)',
    [version, p.actor, p.now, p.workflowId, basedOn],
  )
  if (bumped.changes !== 1) {
    throw new OrchError('WORKFLOW_VERSION_CONFLICT', '当前版本在发布过程中被改动', { workflow_id: p.workflowId })
  }
  const consumed = tx.run(
    'UPDATE workflow_drafts SET published_version = ?, updated_by = ?, updated_at = ? WHERE workflow_id = ? AND revision = ? AND published_version IS NULL',
    [version, p.actor, p.now, p.workflowId, p.revision],
  )
  if (consumed.changes !== 1) {
    throw new OrchError('WORKFLOW_REVISION_CONFLICT', '草稿在发布过程中被改动', { workflow_id: p.workflowId })
  }
  appendEvent(tx, {
    type: 'workflow.published',
    payload: { workflow_id: p.workflowId, version, based_on_version: basedOn, definition_hash: definitionHash },
  })
  return { workflow_id: p.workflowId, version, definition_hash: definitionHash, based_on_version: basedOn }
}

/** 对外入口：发布带幂等与回执（规格 6.2 步骤 10），业务与回执同笔 */
export function publishWorkflowCommand(
  tx: Tx,
  p: PublishParams & { operationId: string },
  ctx: PublishContext,
): PublishResult & { replayed: boolean } {
  const requestHash = requestHashOf('workflow.publish', {
    workflow_id: p.workflowId,
    revision: p.revision,
    base_version: p.baseVersion,
    publish_note: p.note ?? null,
  })
  const { result, replayed } = runIdempotentCommand(tx, {
    kind: 'workflow.publish',
    operationId: p.operationId,
    requestHash,
    now: p.now,
  }, () => publishDraft(tx, p, ctx))
  return { ...result, replayed }
}

export type WorkflowSummary = {
  workflow_id: string
  name: string
  status: string
  scope: WorkflowScope
  owner_task_id: string | null
  current_version: string | null
  draft_revision: number | null
  draft_published_version: string | null
}

export function getWorkflow(tx: Tx, workflowId: string): WorkflowSummary {
  const workflow = readWorkflow(tx, workflowId)
  if (!workflow) throw new OrchError('WORKFLOW_NOT_FOUND', '工作流不存在', { workflow_id: workflowId })
  const draft = readDraft(tx, workflowId)
  return {
    workflow_id: workflow.workflow_id,
    name: workflow.name,
    status: workflow.status,
    scope: workflow.scope,
    owner_task_id: workflow.owner_task_id,
    current_version: workflow.current_version,
    draft_revision: draft?.revision ?? null,
    draft_published_version: draft?.published_version ?? null,
  }
}

export function listWorkflows(tx: Tx, opts: { ownerTaskId?: string | null } = {}): WorkflowSummary[] {
  const rows = tx.all<{ workflow_id: string }>(
    opts.ownerTaskId === undefined
      ? 'SELECT workflow_id FROM workflows ORDER BY workflow_id'
      : 'SELECT workflow_id FROM workflows WHERE owner_task_id = ? ORDER BY workflow_id',
    opts.ownerTaskId === undefined ? [] : [opts.ownerTaskId],
  )
  return rows.map((row) => getWorkflow(tx, row.workflow_id))
}
