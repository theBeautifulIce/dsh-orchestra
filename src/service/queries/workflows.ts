import { OrchError } from '../../core/errors.ts'
import { validateSaveLayer, type ValidationIssue } from '../../core/workflow-doc.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { decodeCursor, encodeCursor, makeCursor } from './cursor.ts'
import { withReadTx, type ReadCtx } from './read-tx.ts'

const WORKFLOWS_LIMIT_MAX = 100
const WORKFLOW_VERSIONS_MAX = 20

export type WorkflowListItem = {
  workflow_id: string
  name: string
  status: string
  scope: string
  owner_task_id: string | null
  current_version: number | null
  has_draft: boolean
  draft_revision: number | null
  node_count: number | null
  published_at: string | null
  updated_at: string
  projection_missing: string[]
}

export type WorkflowVersionView = {
  workflow_id: string
  version: number
  based_on_version: number | null
  definition: unknown
  definition_hash: string
  publish_note: string
  published_at: string
  published_by: string | null
  projection_missing: string[]
}

export type WorkflowView = {
  workflow: WorkflowListItem
  draft: {
    revision: number
    based_on_version: number | null
    definition: unknown
    definition_hash: string
    updated_at: string
    updated_by: string
  } | null
  current: WorkflowVersionView | null
  validation: { errors: ValidationIssue[]; warnings: ValidationIssue[] }
  versions: Array<{ version: number; published_at: string; publish_note: string }>
}

export type ListWorkflowParams = {
  owner_task_id?: string
  status?: string
  query?: string
  limit?: number
  cursor?: string
  now?: number
}

type SummaryRow = Record<string, unknown> & { workflow_id: string; name: string; updated_at: string }

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function parseJson(raw: unknown): unknown | null {
  if (typeof raw !== 'string') return null
  try { return JSON.parse(raw) as unknown } catch { return null }
}

function nodeCount(raw: unknown): number | null {
  const value = parseJson(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const nodes = (value as { nodes?: unknown }).nodes
  return Array.isArray(nodes) ? nodes.length : null
}

function summaryFromRow(row: SummaryRow): WorkflowListItem {
  const draftOpen = row.draft_revision !== null && row.draft_published_version === null
  const count = nodeCount(draftOpen ? row.draft_doc_json : row.current_doc_json ?? row.current_runtime_json)
  return {
    workflow_id: row.workflow_id,
    name: row.name,
    status: String(row.status ?? 'unknown'),
    scope: String(row.scope ?? 'unknown'),
    owner_task_id: nullableString(row.owner_task_id),
    current_version: row.current_version === null || row.current_version === undefined ? null : Number(row.current_version),
    has_draft: draftOpen,
    draft_revision: draftOpen ? Number(row.draft_revision) : null,
    node_count: count,
    published_at: nullableString(row.current_published_at),
    updated_at: row.updated_at,
    projection_missing: count === null ? ['node_count'] : [],
  }
}

const SUMMARY_SELECT = `SELECT w.workflow_id, w.name, w.status, w.scope, w.owner_task_id,
  w.current_version, w.updated_at, d.revision AS draft_revision,
  d.published_version AS draft_published_version, d.doc_json AS draft_doc_json,
  d.based_on_version AS draft_based_on_version, d.definition_hash AS draft_definition_hash,
  d.updated_at AS draft_updated_at, d.updated_by AS draft_updated_by,
  v.doc_json AS current_doc_json, v.definition_json AS current_runtime_json,
  v.created_at AS current_published_at
FROM workflows w
LEFT JOIN workflow_drafts d ON d.workflow_id = w.workflow_id
LEFT JOIN workflow_versions v ON v.workflow_id = w.workflow_id AND v.version = w.current_version`

function workflowVersionRow(ctx: ReadCtx, workflowId: string, version: string): Record<string, unknown> | undefined {
  return ctx.tx.get<Record<string, unknown>>(
    'SELECT workflow_id, version, content_hash, definition_json, created_at, doc_json, published_by, based_on_version, publish_note '
    + 'FROM workflow_versions WHERE workflow_id = ? AND version = ?',
    [workflowId, version],
  )
}

function versionView(row: Record<string, unknown>): WorkflowVersionView {
  const document = parseJson(row.doc_json)
  const runtime = parseJson(row.definition_json)
  return {
    workflow_id: String(row.workflow_id),
    version: Number(row.version),
    based_on_version: row.based_on_version === null || row.based_on_version === undefined ? null : Number(row.based_on_version),
    definition: document ?? runtime,
    definition_hash: String(row.content_hash ?? ''),
    publish_note: String(row.publish_note ?? ''),
    published_at: String(row.created_at ?? ''),
    published_by: nullableString(row.published_by),
    projection_missing: document === null ? ['workflow_doc'] : [],
  }
}

export function listWorkflowSummaries(db: Db, params: ListWorkflowParams = {}): {
  items: WorkflowListItem[]
  next_cursor: string | null
  as_of_seq: number
} {
  const limit = params.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit })
  if (limit > WORKFLOWS_LIMIT_MAX) throw new OrchError('RANGE_TOO_LARGE', '一次最多要 ' + String(WORKFLOWS_LIMIT_MAX) + ' 条', { limit })
  const filter = {
    owner_task_id: params.owner_task_id ?? null,
    status: params.status ?? null,
    query: params.query?.toLocaleLowerCase() ?? null,
  }
  return withReadTx(db, (ctx) => {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.owner_task_id !== null) { where.push('w.owner_task_id = ?'); values.push(filter.owner_task_id) }
    if (filter.status !== null) { where.push('w.status = ?'); values.push(filter.status) }
    if (filter.query !== null) { where.push('INSTR(LOWER(w.name), ?) > 0'); values.push(filter.query) }
    if (params.cursor) {
      const cursor = decodeCursor(params.cursor, 'workflows', filter, params.now)
      where.push('(w.updated_at < ? OR (w.updated_at = ? AND w.workflow_id < ?))')
      values.push(cursor.last_key, cursor.last_key, cursor.last_id)
    }
    const rows = ctx.tx.all<SummaryRow>(
      SUMMARY_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '')
      + ' ORDER BY w.updated_at DESC, w.workflow_id DESC LIMIT ?',
      [...values, limit + 1],
    )
    const hasMore = rows.length > limit
    const page = (hasMore ? rows.slice(0, limit) : rows).map(summaryFromRow)
    const last = page[page.length - 1]
    const next_cursor = hasMore && last
      ? encodeCursor(makeCursor('workflows', filter, last.updated_at, last.workflow_id, ctx.as_of_seq, params.now))
      : null
    return { items: page, next_cursor, as_of_seq: ctx.as_of_seq }
  })
}

export function getWorkflowSnapshot(db: Db, workflowId: string): { item: WorkflowView; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const row = ctx.tx.get<SummaryRow>(SUMMARY_SELECT + ' WHERE w.workflow_id = ?', [workflowId])
    if (!row) throw new OrchError('WORKFLOW_NOT_FOUND', '工作流不存在', { workflow_id: workflowId })
    const workflow = summaryFromRow(row)
    const draft = workflow.has_draft
      ? {
          revision: Number(row.draft_revision),
          based_on_version: row.draft_based_on_version === null || row.draft_based_on_version === undefined
            ? null : Number(row.draft_based_on_version),
          definition: parseJson(row.draft_doc_json),
          definition_hash: String(row.draft_definition_hash ?? ''),
          updated_at: String(row.draft_updated_at ?? ''),
          updated_by: String(row.draft_updated_by ?? ''),
        }
      : null
    const currentRow = row.current_version === null || row.current_version === undefined
      ? undefined
      : workflowVersionRow(ctx, workflowId, String(row.current_version))
    const current = currentRow ? versionView(currentRow) : null
    let errors: ValidationIssue[] = []
    let warnings: ValidationIssue[] = []
    if (draft) {
      const result = validateSaveLayer(draft.definition)
      errors = result.report.errors
      warnings = result.hints.errors
    }
    const versions = ctx.tx.all<Record<string, unknown>>(
      'SELECT version, created_at, publish_note FROM workflow_versions WHERE workflow_id = ? ORDER BY CAST(version AS INTEGER) DESC LIMIT ?',
      [workflowId, WORKFLOW_VERSIONS_MAX],
    ).map((version) => ({
      version: Number(version.version),
      published_at: String(version.created_at ?? ''),
      publish_note: String(version.publish_note ?? ''),
    }))
    return {
      item: { workflow, draft, current, validation: { errors, warnings }, versions },
      as_of_seq: ctx.as_of_seq,
    }
  })
}

export function getWorkflowVersionSnapshot(db: Db, workflowId: string, version: number): { item: WorkflowVersionView; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    if (!ctx.tx.get('SELECT workflow_id FROM workflows WHERE workflow_id = ?', [workflowId])) {
      throw new OrchError('WORKFLOW_NOT_FOUND', '工作流不存在', { workflow_id: workflowId })
    }
    const row = workflowVersionRow(ctx, workflowId, String(version))
    if (!row) throw new OrchError('WORKFLOW_VERSION_NOT_FOUND', '没找到这个版本', { workflow_id: workflowId, version })
    return { item: versionView(row), as_of_seq: ctx.as_of_seq }
  })
}
