// S5-Gb：记忆审批卡生成与批准落库
// 规格 §9.6 / §4.8 行 419、行 651：
// - 固定图推进到 mem_confirm 开一张 kind='audit_result' 的审批卡；同 run 同 kind 已有活跃卡就复用它
//   （同一 decision_id，绝不新建第二张卡；mem_apply 的前置批准复用 mem_confirm 的这张卡）；
// - 人批准：同一笔事务先写 memory_items.approved_content_hash=content_hash，再把批次 UPDATE 成 approved
//   （approved_proposal_hash=proposal_hash(items)、approved_item_hashes_json=[client_key, content_hash] 对、
//   decided_at、decision_id 回写）；批准后改正文/改哈希/增删行都被 030 迁移的触发器拒绝；
// - 人拒绝：批次 declined，不写快照；审批卡 24 小时过期：批次 expired；两条路都不碰 apply。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { memoryCopy } from '../../src/client/panel/memory-panel.tsx'
import type { MemoryBatchView } from '../../src/client/api/types.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { contentHash, proposalHash, type MemoryItemInput } from '../../src/core/memory-canonical.ts'
import { buildApprovalCard, type ApprovalCard, type EvalItem } from '../../src/core/memory-eval.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { serveOrchestra } from '../../src/index.ts'
import { saveMemoryProposal, startMemoryRun } from '../../src/service/commands/memory.ts'
import {
  expireMemoryApproval,
  openMemoryApprovalCard,
  resolveMemoryApproval,
} from '../../src/service/commands/memory-approval.ts'
import { countOf, freshLedger, TEST_SECRET } from '../fixtures/ledger.ts'

const NOW = '2026-11-18T03:00:00.000Z'
const APPROVED_AT = '2026-11-18T04:00:00.000Z'
const EXPIRED_AT = '2026-11-19T04:00:00.000Z'
const OP = '0192c3a4-5b6d-7e8f-9a0b-1c2d3e4f5061'

type BatchView = {
  batch_id: string
  status: string
  outcome: string | null
  proposal_hash: string | null
  approved_proposal_hash: string | null
  approved_item_hashes_json: string | null
  decision_id: string | null
  confirm_node_run_id: string | null
  decided_at: string | null
}

type ItemView = {
  client_key: string
  status: string
  verdict: string | null
  content_hash: string
  approved_content_hash: string | null
}

type DecisionView = {
  decision_id: string
  run_id: string
  node_run_id: string | null
  kind: string
  status: string
  revision: number
  closed_reason: string | null
  decided_at: string | null
  payload_json: string
  content_hash: string | null
  expires_at: string | null
  approver: string
}

function item(clientKey: string): MemoryItemInput {
  return {
    client_key: clientKey,
    action: 'update',
    target_id: 'target_' + clientKey,
    layer: 'L4',
    title: '标题 ' + clientKey,
    content: '内容 ' + clientKey,
    tags: [],
    questions: [],
    key: null,
    importance: 5,
    ttl_days: null,
    quote: '引文',
    reason: '原因',
  }
}

const EVALS: EvalItem[] = [
  { client_key: 'item_1', verdict: 'approve', reason: '这条以后还用得上', confidence: 0.9 },
  { client_key: 'item_2', verdict: 'reject', reason: '一次性的，不用记', confidence: 0.8 },
]

type Fixture = {
  db: Db
  batch_id: string
  memory_run_id: string
  confirm_node_run_id: string
  apply_node_run_id: string
  items: MemoryItemInput[]
  card: ApprovalCard
}

function setup(): Fixture {
  const { db } = freshLedger()
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('tsk_mem_1', '记忆任务', 'running', 0, ?, ?)",
      [NOW, NOW],
    )
    tx.run(
      'INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, started_at, created_at, updated_at) '
        + 'VALUES (?, ?, ?, 1, ?, 0, ?, ?, ?)',
      ['run_src_1', 'tsk_mem_1', 'wf_main', 'succeeded', NOW, NOW, NOW],
    )
  })
  const started = startMemoryRun(db, {
    source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP, now: NOW,
  })
  const items = [item('item_1'), item('item_2')]
  withTx(db, (tx) => saveMemoryProposal(tx, { batch_id: started.batch_id, items, now: NOW }))
  const nodes = db.raw.prepare('SELECT node_id, node_run_id FROM node_runs WHERE run_id = ?').all(started.memory_run_id) as
    Array<{ node_id: string; node_run_id: string }>
  const confirm = nodes.find((node) => node.node_id === 'mem_confirm')
  const apply = nodes.find((node) => node.node_id === 'mem_apply')
  if (!confirm || !apply) throw new Error('记忆固定图缺少 mem_confirm / mem_apply 节点')
  return {
    db,
    batch_id: started.batch_id,
    memory_run_id: started.memory_run_id,
    confirm_node_run_id: confirm.node_run_id,
    apply_node_run_id: apply.node_run_id,
    items,
    card: buildApprovalCard(items, EVALS),
  }
}

/** 评估结论落库（与 memory-ports 的评估落库同形）。 */
function writeVerdicts(db: Db, batchId: string): void {
  withTx(db, (tx) => {
    for (const item of EVALS) {
      tx.run(
        'UPDATE memory_items SET verdict = ?, confidence = ?, judge_reason = ? WHERE batch_id = ? AND client_key = ?',
        [item.verdict, item.confidence, item.reason, batchId, item.client_key],
      )
    }
  })
}

function openCard(f: Fixture, now = NOW, nodeRunId?: string) {
  return withTx(f.db, (tx) => openMemoryApprovalCard(tx, {
    run_id: f.memory_run_id,
    node_run_id: nodeRunId ?? f.confirm_node_run_id,
    batch_id: f.batch_id,
    card: f.card,
    now,
  }))
}

function batchOf(db: Db, batchId: string): BatchView {
  return db.raw.prepare(
    'SELECT batch_id, status, outcome, proposal_hash, approved_proposal_hash, approved_item_hashes_json, '
      + 'decision_id, confirm_node_run_id, decided_at FROM memory_batches WHERE batch_id = ?',
  ).get(batchId) as BatchView
}

function itemsOf(db: Db, batchId: string): ItemView[] {
  return db.raw.prepare(
    'SELECT client_key, status, verdict, content_hash, approved_content_hash FROM memory_items WHERE batch_id = ? ORDER BY client_key',
  ).all(batchId) as ItemView[]
}

function decisionOf(db: Db, decisionId: string): DecisionView {
  return db.raw.prepare(
    'SELECT decision_id, run_id, node_run_id, kind, status, revision, closed_reason, decided_at, payload_json, '
      + 'content_hash, expires_at, approver FROM decisions WHERE decision_id = ?',
  ).get(decisionId) as DecisionView
}

/** 跑一段应当被拒的写入，回传「错误码 + 报错文本」。 */
function errorMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof Error) {
      const code = (err as { code?: unknown }).code
      return typeof code === 'string' ? code + '|' + err.message : err.message
    }
    return String(err)
  }
  throw new Error('本该被拒绝，却通过了')
}

describe('记忆审批卡：开卡与复用', () => {
  it('推进到 mem_confirm 开一张 audit_result 卡：批次等审批，卡上带批次与提案哈希，24 小时到期', () => {
    const f = setup()
    const before = countOf(f.db, 'decisions')
    const opened = openCard(f)
    expect(opened.reused).toBe(false)
    expect(countOf(f.db, 'decisions')).toBe(before + 1)

    const decision = decisionOf(f.db, opened.decision_id)
    expect(decision.kind).toBe('audit_result')
    expect(decision.status).toBe('pending')
    expect(decision.revision).toBe(1)
    expect(decision.approver).toBe('human')
    expect(decision.decided_at).toBe(null)
    expect(decision.expires_at).toBe('2026-11-19T03:00:00.000Z')
    const batch = batchOf(f.db, f.batch_id)
    expect(decision.content_hash).toBe(batch.proposal_hash)

    const payload = JSON.parse(decision.payload_json) as Record<string, unknown>
    expect(payload.kind).toBe('audit_result')
    expect(payload.batch_id).toBe(f.batch_id)
    expect(payload.proposal_hash).toBe(batch.proposal_hash)
    expect(payload.title).toBe(f.card.title)
    expect(payload.buttons).toEqual(f.card.buttons)

    const after = batchOf(f.db, f.batch_id)
    expect(after.status).toBe('awaiting_human')
    expect(after.decision_id).toBe(opened.decision_id)
    expect(after.confirm_node_run_id).toBe(f.confirm_node_run_id)
    f.db.raw.close()
  })

  it('同一 run 同一 kind 已有活跃卡 → 复用同一个 decision_id，decisions 行数不增', () => {
    const f = setup()
    const first = openCard(f)
    const second = openCard(f, APPROVED_AT)
    expect(second.decision_id).toBe(first.decision_id)
    expect(second.reused).toBe(true)
    expect(countOf(f.db, 'decisions')).toBe(1)
    f.db.raw.close()
  })

  it('批次没绑卡但同 run 同 kind 还有活跃卡 → 复用那张卡，不新建第二张', () => {
    const f = setup()
    const first = openCard(f)
    withTx(f.db, (tx) => {
      tx.run("UPDATE memory_batches SET decision_id = NULL, status = 'draft' WHERE batch_id = ?", [f.batch_id])
    })
    const second = openCard(f, APPROVED_AT)
    expect(second.decision_id).toBe(first.decision_id)
    expect(second.reused).toBe(true)
    expect(countOf(f.db, 'decisions')).toBe(1)
    f.db.raw.close()
  })

  it('mem_apply 的前置批准复用 mem_confirm 的 audit_result：同一 decision_id，不新建第二张卡', () => {
    const f = setup()
    const first = openCard(f)
    const applyOpen = openCard(f, APPROVED_AT, f.apply_node_run_id)
    expect(applyOpen.decision_id).toBe(first.decision_id)
    expect(applyOpen.reused).toBe(true)
    expect(countOf(f.db, 'decisions')).toBe(1)
    const batch = batchOf(f.db, f.batch_id)
    expect(batch.decision_id).toBe(first.decision_id)
    expect(batch.confirm_node_run_id).toBe(f.confirm_node_run_id)
    f.db.raw.close()
  })
})

describe('记忆审批卡：批准落库', () => {
  it('批准 → 条目快照与批次快照三件套逐字相符，卡也收口', () => {
    const f = setup()
    writeVerdicts(f.db, f.batch_id)
    const opened = openCard(f)
    const resolved = withTx(f.db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: f.batch_id,
      decision_id: opened.decision_id,
      resolution: 'approved',
      now: APPROVED_AT,
      actor: { kind: 'human', id: 'user_1' },
    }))
    expect(resolved.batch_status).toBe('approved')
    expect(resolved.approved_count).toBe(1)
    expect(resolved.skipped_count).toBe(1)

    const batch = batchOf(f.db, f.batch_id)
    expect(batch.status).toBe('approved')
    expect(batch.outcome).toBe(null)
    expect(batch.decided_at).toBe(APPROVED_AT)
    expect(batch.decision_id).toBe(opened.decision_id)
    expect(batch.approved_proposal_hash).toBe(proposalHash(f.items))
    expect(batch.approved_item_hashes_json).toBe(JSON.stringify([
      ['item_1', contentHash(f.items[0]!)],
      ['item_2', contentHash(f.items[1]!)],
    ]))

    const rows = itemsOf(f.db, f.batch_id)
    expect(rows.map((row) => row.status)).toEqual(['approved', 'skipped'])
    for (const row of rows) {
      expect(row.approved_content_hash).toBe(row.content_hash)
    }

    const decision = decisionOf(f.db, opened.decision_id)
    expect(decision.status).toBe('resolved')
    expect(decision.closed_reason).toBe('approved')
    expect(decision.decided_at).toBe(APPROVED_AT)
    f.db.raw.close()
  })

  it('批准 → 每条 memory_items.approved_content_hash 都等于自己的 content_hash', () => {
    const f = setup()
    writeVerdicts(f.db, f.batch_id)
    const opened = openCard(f)
    withTx(f.db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: f.batch_id,
      decision_id: opened.decision_id,
      resolution: 'approved',
      now: APPROVED_AT,
      actor: { kind: 'human', id: 'user_1' },
    }))
    const rows = itemsOf(f.db, f.batch_id)
    for (const row of rows) {
      expect(row.approved_content_hash).toBe(row.content_hash)
    }
    f.db.raw.close()
  })

  it('普通 Agent 不能批这张卡 → FORBIDDEN，批次仍等审批', () => {
    const f = setup()
    writeVerdicts(f.db, f.batch_id)
    const opened = openCard(f)
    const message = errorMessage(() => withTx(f.db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: f.batch_id,
      decision_id: opened.decision_id,
      resolution: 'approved',
      now: APPROVED_AT,
      actor: { kind: 'agent', id: 'agent_1' },
    })))
    expect(message).toContain('FORBIDDEN')
    expect(batchOf(f.db, f.batch_id).status).toBe('awaiting_human')
    expect(batchOf(f.db, f.batch_id).approved_proposal_hash).toBe(null)
    f.db.raw.close()
  })
})

describe('记忆审批卡：拒绝与过期', () => {
  it('Q-51 跨过 24 小时后生产维护扫描关卡 → 拒绝迟到批准，API 和面板呈现过期且未写入', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-approval-expiry-'))
    const writeMemory = vi.fn(async () => { throw new Error('过期审批卡不允许调用写端') })
    const proposed = item('expiry_item')
    let service: Awaited<ReturnType<typeof serveOrchestra>> | undefined
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date(NOW))
    try {
      service = await serveOrchestra({
        dbFile: join(dir, 'orchestra.db'), secret: TEST_SECRET, phase: 'S5',
        asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
        appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
        memory: {
          prepareItems: async () => ({ items: [proposed] }),
          judge: async () => JSON.stringify({
            items: [{ client_key: proposed.client_key, verdict: 'approve', reason: '保留', confidence: 0.95 }],
            summary: '建议写入', duration_ms: 1, model: { provider: 'fixture', name: 'fixture', prompt_version: '1' },
          }),
          plugin: {
            protocol: 1,
            fenceAndInspect: async () => { throw new Error('过期审批卡不应进入恢复') },
            writeMemory,
          },
        },
      })
      const { orchestra: { db }, endpoint } = service
      const sourceRunId = 'run_expiring_source'
      const taskId = 'task_expiring_source'
      withTx(db, (tx) => {
        tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES (?, '源任务', 'running', 1, ?, ?)", [taskId, NOW, NOW])
        tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, created_at, updated_at) VALUES (?, ?, 'wf', 1, 'succeeded', 1, ?, ?)", [sourceRunId, taskId, NOW, NOW])
      })
      const headers = { 'content-type': 'application/json', 'x-orchestra-secret': TEST_SECRET }
      const request = (path: string, body?: object) => fetch(endpoint + path, {
        headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
      })
      const start = await request('/v1/memory/runs/start', {
        source_run_id: sourceRunId, request_key: 'expiry', reason: '记忆审批', operation_id: uuidv7(),
      })
      expect(start.status).toBe(200)
      const { data: { batch_id: batchId, memory_run_id: memoryRunId } } = await start.json() as {
        data: { batch_id: string; memory_run_id: string }
      }
      await expect.poll(() => batchOf(db, batchId)?.status).toBe('awaiting_human')
      const decisionId = batchOf(db, batchId).decision_id!
      const decision = decisionOf(db, decisionId)
      expect(decision.status).toBe('pending')
      expect(Date.parse(decision.expires_at!) - Date.parse(NOW)).toBe(24 * 60 * 60 * 1000)
      const decisionPath = '/v1/decisions/get?decision_id=' + encodeURIComponent(decisionId)
      const activePath = '/v1/decisions?run_id=' + encodeURIComponent(memoryRunId)
      expect(await (await request(decisionPath)).json()).toMatchObject({ data: { allowed_resolutions: ['approved', 'rejected'] } })

      const expiresAt = Date.parse(decision.expires_at!)
      vi.setSystemTime(expiresAt - 2001)
      await vi.advanceTimersByTimeAsync(2000)
      expect(batchOf(db, batchId).status).toBe('awaiting_human')
      expect(decisionOf(db, decisionId).status).toBe('pending')

      const approve = (revision: number) => request('/v1/decisions/resolve', {
        decisionId, revision, contentHash: decision.content_hash, resolution: 'approved', operation_id: uuidv7(),
      })
      vi.setSystemTime(expiresAt)
      const due = await approve(decision.revision)
      expect(due.status).toBe(422)
      expect(await due.json()).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
      expect(batchOf(db, batchId).status).toBe('awaiting_human')

      await vi.advanceTimersByTimeAsync(2000)
      expect(batchOf(db, batchId)).toMatchObject({ status: 'expired', outcome: 'expired', approved_proposal_hash: null, approved_item_hashes_json: null })
      expect(itemsOf(db, batchId)).toEqual([expect.objectContaining({ client_key: proposed.client_key, status: 'skipped', approved_content_hash: null })])
      const expired = decisionOf(db, decisionId)
      // DC4 / §8 / S5 effect-resolution addendum: expired is the conclusion, persisted as resolved/expired_final.
      expect(expired).toMatchObject({ status: 'resolved', closed_reason: 'expired_final', revision: decision.revision + 1 })
      expect(Date.parse(expired.decided_at!)).toBeGreaterThanOrEqual(expiresAt)

      const late = await approve(expired.revision)
      expect(late.status).toBe(409)
      expect(await late.json()).toMatchObject({ error: { code: 'DECISION_REVISION_CONFLICT' } })
      expect(await (await request(decisionPath)).json()).toMatchObject({ data: {
        decision_id: decisionId, current_revision: expired.revision, status: 'resolved', closed_reason: 'expired_final', allowed_resolutions: [],
      } })
      expect(await (await request(activePath)).json()).toMatchObject({ data: { items: [] } })
      expect(await (await request(activePath + '&status=resolved')).json()).toMatchObject({ data: { items: [expect.objectContaining({
        decision_id: decisionId, status: 'resolved', closed_reason: 'expired_final', allowed_resolutions: [],
      })] } })
      const batchResponse = await request('/v1/memory/batches?task_id=' + encodeURIComponent(taskId))
      expect(batchResponse.status).toBe(200)
      const { data: { items: [batch] } } = await batchResponse.json() as { data: { items: MemoryBatchView[] } }
      expect(batch).toMatchObject({ batch_id: batchId, decision_id: decisionId, status: 'expired', outcome: 'expired', allowed_resolutions: null,
        pending_count: 0, applied_count: 0, skipped_count: 1, items: [{ client_key: proposed.client_key, status: 'skipped' }] })
      expect(memoryCopy(batch!)).toEqual({ text: '超过 24 小时没确认，这次没写', tone: 'warn' })
      expect(writeMemory).not.toHaveBeenCalled()
      expect(countOf(db, 'decisions')).toBe(1)
    } finally {
      try { await service?.close() } finally {
        vi.useRealTimers()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('拒绝 → 批次 declined，不写快照，也不写记忆', () => {
    const f = setup()
    writeVerdicts(f.db, f.batch_id)
    const opened = openCard(f)
    const resolved = withTx(f.db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: f.batch_id,
      decision_id: opened.decision_id,
      resolution: 'rejected',
      now: APPROVED_AT,
      actor: { kind: 'human', id: 'user_1' },
    }))
    expect(resolved.batch_status).toBe('declined')
    const batch = batchOf(f.db, f.batch_id)
    expect(batch.status).toBe('declined')
    expect(batch.outcome).toBe('declined')
    expect(batch.decided_at).toBe(APPROVED_AT)
    expect(batch.approved_proposal_hash).toBe(null)
    expect(batch.approved_item_hashes_json).toBe(null)
    for (const row of itemsOf(f.db, f.batch_id)) {
      expect(row.status).toBe('skipped')
      expect(row.approved_content_hash).toBe(null)
    }
    const decision = decisionOf(f.db, opened.decision_id)
    expect(decision.status).toBe('resolved')
    expect(decision.closed_reason).toBe('rejected')
    f.db.raw.close()
  })

  it('24 小时未确认 → 批次 expired，不写快照', () => {
    const f = setup()
    writeVerdicts(f.db, f.batch_id)
    const opened = openCard(f)
    const expired = withTx(f.db, (tx) => expireMemoryApproval(tx, TEST_SECRET, {
      batch_id: f.batch_id,
      decision_id: opened.decision_id,
      now: EXPIRED_AT,
    }))
    expect(expired.expired).toBe(true)
    const batch = batchOf(f.db, f.batch_id)
    expect(batch.status).toBe('expired')
    expect(batch.outcome).toBe('expired')
    expect(batch.approved_proposal_hash).toBe(null)
    expect(batch.approved_item_hashes_json).toBe(null)
    for (const row of itemsOf(f.db, f.batch_id)) {
      expect(row.status).not.toBe('applied')
    }
    const decision = decisionOf(f.db, opened.decision_id)
    expect(decision.status).toBe('resolved')
    expect(decision.closed_reason).toBe('expired_final')
    f.db.raw.close()
  })

  it('还没到期不算过期：批次仍等审批', () => {
    const f = setup()
    const opened = openCard(f)
    const expired = withTx(f.db, (tx) => expireMemoryApproval(tx, TEST_SECRET, {
      batch_id: f.batch_id,
      decision_id: opened.decision_id,
      now: APPROVED_AT,
    }))
    expect(expired.expired).toBe(false)
    expect(batchOf(f.db, f.batch_id).status).toBe('awaiting_human')
    f.db.raw.close()
  })

  it('过期之后不能再批准 → RESOLUTION_NOT_AVAILABLE', () => {
    const f = setup()
    writeVerdicts(f.db, f.batch_id)
    const opened = openCard(f)
    const message = errorMessage(() => withTx(f.db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: f.batch_id,
      decision_id: opened.decision_id,
      resolution: 'approved',
      now: EXPIRED_AT,
      actor: { kind: 'human', id: 'user_1' },
    })))
    expect(message).toContain('RESOLUTION_NOT_AVAILABLE')
    expect(batchOf(f.db, f.batch_id).status).toBe('awaiting_human')
    f.db.raw.close()
  })
})

describe('记忆审批卡：批准之后不许偷偷改', () => {
  function approved(): Fixture & { decisionId: string } {
    const f = setup()
    writeVerdicts(f.db, f.batch_id)
    const opened = openCard(f)
    withTx(f.db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: f.batch_id,
      decision_id: opened.decision_id,
      resolution: 'approved',
      now: APPROVED_AT,
      actor: { kind: 'human', id: 'user_1' },
    }))
    return { ...f, decisionId: opened.decision_id }
  }

  it('批准后改正文 → MEMORY_APPLY_BINDING_INVALID', () => {
    const f = approved()
    const message = errorMessage(() => withTx(f.db, (tx) => {
      tx.run("UPDATE memory_items SET content = '偷偷改的正文' WHERE batch_id = ? AND client_key = 'item_1'", [f.batch_id])
    }))
    expect(message).toContain('MEMORY_APPLY_BINDING_INVALID')
    f.db.raw.close()
  })

  it('批准后改哈希 → MEMORY_APPLY_BINDING_INVALID', () => {
    const f = approved()
    const message = errorMessage(() => withTx(f.db, (tx) => {
      tx.run("UPDATE memory_items SET content_hash = 'deadbeef' WHERE batch_id = ? AND client_key = 'item_1'", [f.batch_id])
    }))
    expect(message).toContain('MEMORY_APPLY_BINDING_INVALID')
    f.db.raw.close()
  })

  it('批准后不能改非正文元数据或通过修改 client_key 换序', () => {
    const f = approved()
    for (const assignment of ["title = '改过的标题'", "client_key = 'zz_moved'"]) {
      const message = errorMessage(() => withTx(f.db, (tx) => {
        tx.run("UPDATE memory_items SET " + assignment + " WHERE batch_id = ? AND client_key = 'item_1'", [f.batch_id])
      }))
      expect(message).toContain('MEMORY_APPLY_BINDING_INVALID')
    }
    f.db.raw.close()
  })

  it('批准后新增行 → MEMORY_APPLY_BINDING_INVALID', () => {
    const f = approved()
    const message = errorMessage(() => withTx(f.db, (tx) => {
      tx.run(
        'INSERT INTO memory_items (item_id, batch_id, client_key, action, target_id, layer, title, content, tags_json, questions_json, key, importance, ttl_days, quote, reason, content_hash, status) '
          + "VALUES ('memitem_new', ?, 'item_3', 'update', 'target_item_3', 'L4', '新条目', '新内容', '[]', '[]', NULL, 5, NULL, '引文', '原因', 'hash3', 'proposed')",
        [f.batch_id],
      )
    }))
    expect(message).toContain('MEMORY_APPLY_BINDING_INVALID')
    f.db.raw.close()
  })

  it('批准后删除行 → MEMORY_APPLY_BINDING_INVALID', () => {
    const f = approved()
    const message = errorMessage(() => withTx(f.db, (tx) => {
      tx.run("DELETE FROM memory_items WHERE batch_id = ? AND client_key = 'item_1'", [f.batch_id])
    }))
    expect(message).toContain('MEMORY_APPLY_BINDING_INVALID')
    f.db.raw.close()
  })
})
