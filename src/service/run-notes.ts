import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'
import { chatRun } from './chat-task-receipts.ts'
import { requireReviewOperator } from './delivery-review.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'
import { dependencyReadiness, nodePredecessors, pinnedRunTopology, readRunBinding } from './run-readiness.ts'

const scopes = z.enum(['run', 'downstream', 'brain'])
const runId = z.string().min(1).max(128)
const bodyText = z.string().trim().min(1).max(2000)
  .refine((text) => !text.includes('\0') && [...text].length <= 500, '便条最多 500 字')
const cursor = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const humanInput = z.strictObject({ run_id: runId, body: bodyText, operation_id: z.uuidv7() })
export const runNoteHumanInput = humanInput
export const runNoteNodeInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('add'), scope: scopes, body: bodyText }),
  z.strictObject({ action: z.literal('list'), before_seq: cursor.optional() }),
])
export type RunNoteBinding = { node_run_id: string; attempt: number; action_generation: number; executor_session_id: string }
type Scope = z.infer<typeof scopes>
type Reader = { kind: 'node'; nodeRun: string; nodeId: string; predecessors: ReadonlySet<string> } | { kind: 'human' | 'chat' }
type Authority = {
  run_id: string
  node_run_id: string | null
  actor_kind: 'human' | 'node'
  author: string
  attempt?: number
  action_generation?: number
}
type NoteRow = { seq: number; event_id: string; run_id: string; node_run_id: string | null; occurred_at: string; payload_redacted: string; body: string; author: string }
type NotePayload = Omit<Authority, 'run_id' | 'node_run_id' | 'author'> & { scope: Scope; body_digest: string }
const perNode = 5
const perRun = 200
const toolPage = 20
const active = `
  FROM events e JOIN run_note_bodies b ON b.event_seq=e.seq
  WHERE e.type='run.note_created' AND e.run_id=?
  AND NOT EXISTS(SELECT 1 FROM events ev WHERE ev.idempotency_key='run-note-evict:' || e.event_id)`

function liveNode(tx: ReadTx, binding: RunNoteBinding, now: string) {
  const node = tx.get<{ run_id: string; node_id: string }>(`
    SELECT n.run_id,n.node_id FROM node_runs n JOIN runs r USING(run_id)
    WHERE n.node_run_id=? AND n.attempt=? AND n.action_generation=? AND n.executor_session_id=?
      AND n.node_type='agent' AND n.status='started' AND n.replacement_node_run_id IS NULL
      AND julianday(n.lease_expires_at)>julianday(?) AND r.status='running' AND r.cancel_requested_at IS NULL`,
  [binding.node_run_id, binding.attempt, binding.action_generation, binding.executor_session_id, now])
  if (!node) throw new OrchError('FORBIDDEN', '便条仅供当前运行中、租约仍有效的节点尝试使用')
  return node
}

function canRead(tx: ReadTx, secret: string, note: NoteRow, payload: NotePayload, reader: Reader): boolean {
  if (payload.scope === 'run') return true
  if (payload.scope !== 'downstream' || reader.kind !== 'node' || !note.node_run_id) return false
  const source = tx.get<{ node_id: string }>(`SELECT node_id FROM node_runs
    WHERE run_id=? AND node_run_id=? AND attempt=? AND action_generation=? AND replacement_node_run_id IS NULL AND status='done'
      AND node_run_id=(SELECT latest.node_run_id FROM node_runs latest WHERE latest.run_id=node_runs.run_id AND latest.node_id=node_runs.node_id ORDER BY latest.attempt DESC,latest.seq DESC LIMIT 1)`,
  [note.run_id, note.node_run_id, payload.attempt, payload.action_generation])
  return Boolean(source && reader.predecessors.has(source.node_id)
    && dependencyReadiness(tx, note.run_id, reader.nodeRun, [source.node_id], reader.nodeId, secret).ready)
}

export function createRunNotes(db: Db, secret: string) {
  const digest = (run: string, node: string | null, payload: Omit<NotePayload, 'body_digest'>, author: string, body: string) =>
    createHmac('sha256', secret).update('run-note-body\0')
      .update(JSON.stringify([run, node, payload.actor_kind, author, payload.scope, payload.attempt, payload.action_generation, body])).digest('hex')

  function list(tx: ReadTx, run: string, reader: Reader, before = Number.MAX_SAFE_INTEGER) {
    const available = tx.all<NoteRow>(`SELECT e.seq,e.event_id,e.run_id,e.node_run_id,e.occurred_at,e.payload_redacted,b.body,b.author
      ${active} AND e.seq<? AND (json_extract(e.payload_redacted, '$.scope')='run'
        OR (?=1 AND json_extract(e.payload_redacted, '$.scope')='downstream'))
      ORDER BY e.seq DESC LIMIT ${perRun}`, [run, before, reader.kind === 'node' ? 1 : 0])
    const visible = available.flatMap((row) => {
      const payload = JSON.parse(row.payload_redacted) as NotePayload
      if (payload.body_digest !== digest(row.run_id, row.node_run_id, payload, row.author, row.body) || !canRead(tx, secret, row, payload, reader)) return []
      return [{ note_id: row.event_id, seq: row.seq, run_id: row.run_id, node_run_id: row.node_run_id,
        author: row.author, source: payload.actor_kind, attempt: payload.attempt ?? null,
        scope: payload.scope, body: row.body, created_at: row.occurred_at, evidence_strength: 'none' as const }]
    })
    const limit = reader.kind === 'human' ? perRun : toolPage
    const items = visible.slice(0, limit)
    return { items, next_before_seq: visible.length > limit ? items.at(-1)?.seq ?? null : null }
  }

  function add(tx: Tx, authority: Authority, scope: Scope, text: string, requestId: string) {
    const { run_id, node_run_id, author, ...source } = authority
    const key = 'run-note-add:' + sha256Hex(JSON.stringify([authority, requestId]))
    const body_digest = digest(run_id, node_run_id, { ...source, scope }, author, text)
    const prior = tx.get<{ event_id: string; seq: number; payload_redacted: string }>(
      'SELECT event_id,seq,payload_redacted FROM events WHERE idempotency_key=?', [key])
    if (prior) {
      const payload = JSON.parse(prior.payload_redacted) as NotePayload
      if (payload.body_digest !== body_digest || payload.scope !== scope) throw new OrchError('OPERATION_ID_CONFLICT', '便条操作号已用于另一条内容')
      return { note_id: prior.event_id, seq: prior.seq }
    }
    const created = appendEvent(tx, { type: 'run.note_created', runId: run_id, nodeRunId: node_run_id,
      idempotencyKey: key, payload: { ...source, scope, body_digest, evidence_strength: 'none' } })
    tx.run('INSERT INTO run_note_bodies(event_seq,body,author) VALUES (?,?,?)', [created.seq, text, author])
    const evict = (constraint: string, params: unknown[], limit: number, reason: string) => {
      const rows = tx.all<{ seq: number; event_id: string; node_run_id: string | null }>(
        `SELECT e.seq,e.event_id,e.node_run_id ${active} ${constraint} ORDER BY e.seq DESC LIMIT -1 OFFSET ?`, [run_id, ...params, limit])
      for (const row of rows) {
        appendEvent(tx, { type: 'run.note_evicted', runId: run_id, nodeRunId: row.node_run_id,
          idempotencyKey: 'run-note-evict:' + row.event_id, payload: { note_id: row.event_id, reason } })
        tx.run('DELETE FROM run_note_bodies WHERE event_seq=?', [row.seq])
      }
    }
    if (node_run_id) evict('AND e.node_run_id=?', [node_run_id], perNode, 'node_quota')
    evict('', [], perRun, 'run_quota')
    return { note_id: created.event_id, seq: created.seq }
  }

  return {
    listHuman(run: string, actor: string) {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        requireReviewOperator(tx, secret, actor, run, true)
        return { ...list(tx, run, { kind: 'human' }), as_of_seq }
      })
    },
    addHuman(input: z.infer<typeof humanInput>, actor: string) {
      const body = humanInput.parse(input)
      return withTx(db, (tx) => {
        requireReviewOperator(tx, secret, actor, body.run_id, true)
        return add(tx, { run_id: body.run_id, node_run_id: null, actor_kind: 'human', author: actor }, 'run', body.body, body.operation_id)
      })
    },
    listChatShared(run: string, actor: string, before?: number) {
      if (chatRun(db, actor, run) !== run) throw new OrchError('FORBIDDEN', '请在创建任务的会话查询本次运行便条')
      return withReadTx(db, ({ tx }) => {
        requireReviewOperator(tx, secret, actor, run, true)
        return list(tx, run, { kind: 'chat' }, before)
      })
    },
    callNode(binding: RunNoteBinding, input: unknown, requestId: string, now: string) {
      const parsed = runNoteNodeInput.safeParse(input)
      if (!parsed.success) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '便条请求格式不正确；便条最多 500 字')
      const body = parsed.data
      if (body.action === 'add') return withTx(db, (tx) => {
        const node = liveNode(tx, binding, now)
        if (body.scope === 'brain') {
          throw new OrchError('SERVICE_UNAVAILABLE', '主脑专属便条暂不支持新建，已有便条保持原权限')
        }
        return add(tx, { run_id: node.run_id, node_run_id: binding.node_run_id, actor_kind: 'node', author: node.node_id,
          attempt: binding.attempt, action_generation: binding.action_generation }, body.scope, body.body, requestId)
      })
      return withReadTx(db, ({ tx }) => {
        const node = liveNode(tx, binding, now)
        const run = readRunBinding(tx, node.run_id)
        const topology = run?.workflow_definition_hash ? pinnedRunTopology(run) : null
        const predecessors = topology ? nodePredecessors(tx, node.run_id, topology, node.node_id) : []
        return list(tx, node.run_id, { kind: 'node', nodeRun: binding.node_run_id, nodeId: node.node_id, predecessors: new Set(predecessors) }, body.before_seq)
      })
    },
  }
}
export type RunNotes = ReturnType<typeof createRunNotes>
