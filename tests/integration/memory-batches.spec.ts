// S5-I：记忆批次只读投影（面板 GET /v1/memory/batches 的服务端读模型）
// 钉住四件事：
// ① 字段逐字对齐 src/client/api/types.ts:52-71（MemoryBatchView / MemoryItemView）；
// ② 四个计数从 memory_items 真数出来，不读批次表上的冗余列；
// ③ allowed_resolutions 按批次状态取口径：awaiting_human 读裁决 payload_json、indeterminate 只给 abandon、其余 null；
// ④ 只读：跑完投影前后 memory_batches / memory_items / decisions 行数不变。
import { describe, expect, it } from 'vitest'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { listMemoryBatches } from '../../src/service/queries/memory-batches.ts'
import { countOf, freshLedger } from '../fixtures/ledger.ts'

const NOW = '2026-11-18T05:00:00.000Z'
const LATER = '2026-11-18T06:00:00.000Z'
const LATEST = '2026-11-18T07:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const LONG_TEXT = '长'.repeat(120)

function seedTask(db: Db, taskId: string): void {
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES (?, '记忆任务', 'running', 0, ?, ?)",
      [taskId, NOW, NOW],
    )
  })
}

function seedRuns(db: Db, taskId: string, runIds: readonly string[]): void {
  withTx(db, (tx) => {
    for (const runId of runIds) {
      tx.run(
        "INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, started_at, created_at, updated_at) "
        + "VALUES (?, ?, 'wf_main', 1, 'succeeded', 0, ?, ?, ?)",
        [runId, taskId, NOW, NOW, NOW],
      )
    }
  })
}

type BatchSpec = {
  batch_id: string
  task_id: string
  source_run_id: string
  memory_run_id: string
  attempt?: number
  created_at?: string
  updated_at?: string
  status?: string
  outcome?: string | null
  proposal_hash?: string | null
  evaluation_id?: string | null
  error_message?: string | null
}

function insertBatch(db: Db, spec: BatchSpec): void {
  withTx(db, (tx) => {
    tx.run(
      'INSERT INTO memory_batches (batch_id, task_id, source_run_id, memory_run_id, attempt, status, outcome, '
      + 'proposal_hash, evaluation_id, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        spec.batch_id,
        spec.task_id,
        spec.source_run_id,
        spec.memory_run_id,
        spec.attempt ?? 1,
        spec.status ?? 'draft',
        spec.outcome ?? null,
        spec.proposal_hash ?? null,
        spec.evaluation_id ?? null,
        spec.error_message ?? null,
        spec.created_at ?? NOW,
        spec.updated_at ?? NOW,
      ],
    )
  })
}

type ItemSpec = {
  item_id: string
  batch_id: string
  client_key: string
  layer?: string
  title?: string
  content?: string
  status?: string
  verdict?: string | null
  judge_reason?: string | null
}

function insertItem(db: Db, spec: ItemSpec): void {
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO memory_items (item_id, batch_id, client_key, action, target_id, layer, title, content, "
      + "tags_json, questions_json, content_hash, status, verdict, judge_reason) "
      + "VALUES (?, ?, ?, 'update', ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?)",
      [
        spec.item_id,
        spec.batch_id,
        spec.client_key,
        'target_' + spec.client_key,
        spec.layer ?? 'L4',
        spec.title ?? ('标题 ' + spec.client_key),
        spec.content ?? ('内容 ' + spec.client_key),
        'hash_' + spec.client_key,
        spec.status ?? 'proposed',
        spec.verdict ?? null,
        spec.judge_reason ?? null,
      ],
    )
  })
}

function insertDecision(db: Db, spec: { decision_id: string; run_id: string; revision?: number; payload: unknown }): void {
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO decisions (decision_id, run_id, node_run_id, kind, status, revision, payload_json, created_at) "
      + "VALUES (?, ?, NULL, 'audit_result', 'pending', ?, ?, ?)",
      [spec.decision_id, spec.run_id, spec.revision ?? 1, JSON.stringify(spec.payload), NOW],
    )
  })
}

/**
 * 走真实审批路径把批次推到终态：draft → awaiting_human → approved（写批准快照）→ 终态。
 * 030 迁移的触发器只认这条顺序，直接 UPDATE 成终态会被 MEMORY_APPLY_BINDING_INVALID 拒。
 */
function closeBatch(db: Db, batchId: string, finalStatus: 'applied' | 'indeterminate'): void {
  withTx(db, (tx) => {
    tx.run("UPDATE memory_batches SET status = 'awaiting_human', updated_at = ? WHERE batch_id = ?", [NOW, batchId])
    tx.run(
      "UPDATE memory_batches SET status = 'approved', approved_proposal_hash = ?, approved_item_hashes_json = '[]', updated_at = ? "
      + 'WHERE batch_id = ?',
      ['ph_' + batchId, NOW, batchId],
    )
    tx.run(
      'UPDATE memory_batches SET status = ?, outcome = ?, updated_at = ? WHERE batch_id = ?',
      [finalStatus, finalStatus === 'applied' ? 'written' : 'indeterminate', LATER, batchId],
    )
  })
}

/** 跑一段应当被拒的调用，回传错误码。 */
function errorCode(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? code : String(err)
  }
  throw new Error('本该被拒绝，却通过了')
}

describe('记忆批次只读投影', () => {
  it('字段逐字对齐客户端契约，四个计数从 items 真数出来', () => {
    const { db } = freshLedger()
    seedTask(db, 'tsk_1')
    seedRuns(db, 'tsk_1', ['run_src_1', 'run_mem_1'])
    insertBatch(db, {
      batch_id: 'membatch_1',
      task_id: 'tsk_1',
      source_run_id: 'run_src_1',
      memory_run_id: 'run_mem_1',
    })
    insertItem(db, { item_id: 'memitem_1', batch_id: 'membatch_1', client_key: 'item_1', status: 'proposed', content: LONG_TEXT })
    insertItem(db, { item_id: 'memitem_2', batch_id: 'membatch_1', client_key: 'item_2', status: 'proposed' })
    insertItem(db, {
      item_id: 'memitem_3',
      batch_id: 'membatch_1',
      client_key: 'item_3',
      status: 'skipped',
      verdict: 'reject',
      judge_reason: '一次性的，不用记',
    })
    insertItem(db, { item_id: 'memitem_4', batch_id: 'membatch_1', client_key: 'item_4', status: 'applied', verdict: 'approve' })

    const page = listMemoryBatches(db, {})
    expect(page.as_of_seq).toBeGreaterThanOrEqual(0)
    expect(page.next_cursor).toBeNull()
    expect(page.items).toHaveLength(1)
    const batch = page.items[0]
    if (!batch) throw new Error('投影没有批次')

    expect(Object.keys(batch).sort()).toEqual([
      'allowed_resolutions', 'applied_count', 'attempt', 'batch_id', 'created_at', 'decision_id',
      'decision_revision', 'error_message', 'evaluation_id', 'items', 'outcome', 'pending_count',
      'proposal_hash', 'skipped_count', 'status', 'task_id', 'total_count', 'updated_at',
    ])
    expect(batch).toEqual({
      batch_id: 'membatch_1',
      task_id: 'tsk_1',
      status: 'draft',
      attempt: 1,
      outcome: null,
      total_count: 4,
      pending_count: 2,
      applied_count: 1,
      skipped_count: 1,
      items: [
        {
          client_key: 'item_1',
          layer: 'L4',
          title: '标题 item_1',
          digest: LONG_TEXT.slice(0, 80),
          content: LONG_TEXT,
          source: null,
          status: 'proposed',
          verdict: null,
          judge_reason: null,
        },
        {
          client_key: 'item_2',
          layer: 'L4',
          title: '标题 item_2',
          digest: '内容 item_2',
          content: '内容 item_2',
          source: null,
          status: 'proposed',
          verdict: null,
          judge_reason: null,
        },
        {
          client_key: 'item_3',
          layer: 'L4',
          title: '标题 item_3',
          digest: '内容 item_3',
          content: '内容 item_3',
          source: null,
          status: 'skipped',
          verdict: 'reject',
          judge_reason: '一次性的，不用记',
        },
        {
          client_key: 'item_4',
          layer: 'L4',
          title: '标题 item_4',
          digest: '内容 item_4',
          content: '内容 item_4',
          source: null,
          status: 'applied',
          verdict: 'approve',
          judge_reason: null,
        },
      ],
      evaluation_id: null,
      proposal_hash: null,
      decision_id: null,
      decision_revision: null,
      allowed_resolutions: null,
      error_message: null,
      created_at: NOW,
      updated_at: NOW,
    })
    db.raw.close()
  })

  it('awaiting_human：allowed_resolutions 从裁决 payload 读；没绑裁决给空数组', () => {
    const { db } = freshLedger()
    seedTask(db, 'tsk_1')
    seedRuns(db, 'tsk_1', ['run_src_1', 'run_mem_1', 'run_src_2', 'run_mem_2'])
    insertBatch(db, { batch_id: 'membatch_1', task_id: 'tsk_1', source_run_id: 'run_src_1', memory_run_id: 'run_mem_1' })
    insertItem(db, { item_id: 'memitem_1', batch_id: 'membatch_1', client_key: 'item_1' })
    insertDecision(db, {
      decision_id: 'dec_1',
      run_id: 'run_mem_1',
      revision: 3,
      payload: { kind: 'audit_result', batch_id: 'membatch_1', allowed_resolutions: ['approved', 'rejected'] },
    })
    withTx(db, (tx) => {
      tx.run("UPDATE memory_batches SET status = 'awaiting_human', decision_id = 'dec_1', updated_at = ? WHERE batch_id = 'membatch_1'", [NOW])
    })
    insertBatch(db, { batch_id: 'membatch_2', task_id: 'tsk_1', source_run_id: 'run_src_2', memory_run_id: 'run_mem_2' })
    insertItem(db, { item_id: 'memitem_2', batch_id: 'membatch_2', client_key: 'item_1' })
    withTx(db, (tx) => {
      tx.run("UPDATE memory_batches SET status = 'awaiting_human', updated_at = ? WHERE batch_id = 'membatch_2'", [NOW])
    })

    const page = listMemoryBatches(db, {})
    const byId = new Map(page.items.map((batch) => [batch.batch_id, batch] as const))
    const bound = byId.get('membatch_1')
    if (!bound) throw new Error('投影没有批次')
    expect(bound.status).toBe('awaiting_human')
    expect(bound.allowed_resolutions).toEqual(['approved', 'rejected'])
    expect(bound.decision_id).toBe('dec_1')
    expect(bound.decision_revision).toBe(3)
    expect(bound.pending_count).toBe(1)
    expect(bound.total_count).toBe(1)

    const unbound = byId.get('membatch_2')
    if (!unbound) throw new Error('投影没有批次')
    expect(unbound.status).toBe('awaiting_human')
    expect(unbound.allowed_resolutions).toEqual([])
    expect(unbound.decision_id).toBe(null)
    expect(unbound.decision_revision).toBe(null)
    db.raw.close()
  })

  it('indeterminate 只给 abandon；别的状态一律 null；计数照样从 items 数', () => {
    const { db } = freshLedger()
    seedTask(db, 'tsk_1')
    seedRuns(db, 'tsk_1', ['run_src_1', 'run_mem_1', 'run_src_2', 'run_mem_2', 'run_src_3', 'run_mem_3'])
    insertBatch(db, { batch_id: 'membatch_1', task_id: 'tsk_1', source_run_id: 'run_src_1', memory_run_id: 'run_mem_1' })
    insertItem(db, { item_id: 'memitem_1', batch_id: 'membatch_1', client_key: 'item_1', status: 'approved', verdict: 'approve' })
    insertItem(db, { item_id: 'memitem_2', batch_id: 'membatch_1', client_key: 'item_2', status: 'approved', verdict: 'merge' })
    closeBatch(db, 'membatch_1', 'indeterminate')

    insertBatch(db, { batch_id: 'membatch_2', task_id: 'tsk_1', source_run_id: 'run_src_2', memory_run_id: 'run_mem_2' })
    insertItem(db, { item_id: 'memitem_3', batch_id: 'membatch_2', client_key: 'item_1', status: 'applied', verdict: 'approve' })
    insertItem(db, { item_id: 'memitem_4', batch_id: 'membatch_2', client_key: 'item_2', status: 'skipped', verdict: 'reject' })
    closeBatch(db, 'membatch_2', 'applied')

    insertBatch(db, {
      batch_id: 'membatch_3',
      task_id: 'tsk_1',
      source_run_id: 'run_src_3',
      memory_run_id: 'run_mem_3',
      status: 'declined',
      outcome: 'declined',
    })

    const page = listMemoryBatches(db, {})
    const byId = new Map(page.items.map((batch) => [batch.batch_id, batch] as const))
    const indeterminate = byId.get('membatch_1')
    if (!indeterminate) throw new Error('投影没有批次')
    expect(indeterminate.status).toBe('indeterminate')
    expect(indeterminate.outcome).toBe('indeterminate')
    expect(indeterminate.allowed_resolutions).toEqual(['abandon'])
    expect(indeterminate.total_count).toBe(2)
    expect(indeterminate.pending_count).toBe(2)
    expect(indeterminate.applied_count).toBe(0)
    expect(indeterminate.skipped_count).toBe(0)

    const applied = byId.get('membatch_2')
    if (!applied) throw new Error('投影没有批次')
    expect(applied.status).toBe('applied')
    expect(applied.outcome).toBe('written')
    expect(applied.allowed_resolutions).toBe(null)
    expect(applied.applied_count).toBe(1)
    expect(applied.skipped_count).toBe(1)
    // 批次表上的 applied_count / skipped_count 仍是 0：投影的计数确实来自 items，不是读冗余列。
    const columns = db.raw.prepare('SELECT applied_count, skipped_count FROM memory_batches WHERE batch_id = ?')
      .get('membatch_2') as { applied_count: number; skipped_count: number }
    expect(columns.applied_count).toBe(0)
    expect(columns.skipped_count).toBe(0)

    const declined = byId.get('membatch_3')
    if (!declined) throw new Error('投影没有批次')
    expect(declined.status).toBe('declined')
    expect(declined.allowed_resolutions).toBe(null)
    expect(declined.total_count).toBe(0)
    db.raw.close()
  })

  it('task_id 过滤：只回这个任务的批次', () => {
    const { db } = freshLedger()
    seedTask(db, 'tsk_1')
    seedTask(db, 'tsk_2')
    seedRuns(db, 'tsk_1', ['run_src_1', 'run_mem_1'])
    seedRuns(db, 'tsk_2', ['run_src_2', 'run_mem_2'])
    insertBatch(db, { batch_id: 'membatch_1', task_id: 'tsk_1', source_run_id: 'run_src_1', memory_run_id: 'run_mem_1' })
    insertBatch(db, { batch_id: 'membatch_2', task_id: 'tsk_2', source_run_id: 'run_src_2', memory_run_id: 'run_mem_2' })

    const all = listMemoryBatches(db, {})
    expect(all.items.map((batch) => batch.batch_id).sort()).toEqual(['membatch_1', 'membatch_2'])

    const filtered = listMemoryBatches(db, { task_id: 'tsk_1' })
    expect(filtered.items).toHaveLength(1)
    expect(filtered.items[0]?.task_id).toBe('tsk_1')
    expect(filtered.next_cursor).toBe(null)
    db.raw.close()
  })

  it('游标分页：limit 生效，next_cursor 续页不重不漏', () => {
    const { db } = freshLedger()
    seedTask(db, 'tsk_1')
    seedRuns(db, 'tsk_1', ['run_src_1', 'run_mem_1', 'run_src_2', 'run_mem_2', 'run_src_3', 'run_mem_3'])
    insertBatch(db, {
      batch_id: 'membatch_1', task_id: 'tsk_1', source_run_id: 'run_src_1', memory_run_id: 'run_mem_1',
      created_at: NOW, updated_at: NOW,
    })
    insertBatch(db, {
      batch_id: 'membatch_2', task_id: 'tsk_1', source_run_id: 'run_src_2', memory_run_id: 'run_mem_2',
      created_at: LATER, updated_at: LATER,
    })
    insertBatch(db, {
      batch_id: 'membatch_3', task_id: 'tsk_1', source_run_id: 'run_src_3', memory_run_id: 'run_mem_3',
      created_at: LATEST, updated_at: LATEST,
    })

    const first = listMemoryBatches(db, { limit: 2, now: NOW_MS })
    expect(first.items.map((batch) => batch.batch_id)).toEqual(['membatch_3', 'membatch_2'])
    expect(first.next_cursor).toBeTruthy()

    const second = listMemoryBatches(db, { limit: 2, cursor: first.next_cursor ?? undefined, now: NOW_MS })
    expect(second.items.map((batch) => batch.batch_id)).toEqual(['membatch_1'])
    expect(second.next_cursor).toBe(null)
    db.raw.close()
  })

  it('换了 task_id 再用旧游标报 CURSOR_FILTER_MISMATCH', () => {
    const { db } = freshLedger()
    seedTask(db, 'tsk_1')
    seedTask(db, 'tsk_2')
    seedRuns(db, 'tsk_1', ['run_src_1', 'run_mem_1', 'run_src_2', 'run_mem_2'])
    seedRuns(db, 'tsk_2', ['run_src_3', 'run_mem_3'])
    insertBatch(db, { batch_id: 'membatch_1', task_id: 'tsk_1', source_run_id: 'run_src_1', memory_run_id: 'run_mem_1' })
    insertBatch(db, { batch_id: 'membatch_2', task_id: 'tsk_1', source_run_id: 'run_src_2', memory_run_id: 'run_mem_2' })
    insertBatch(db, { batch_id: 'membatch_3', task_id: 'tsk_2', source_run_id: 'run_src_3', memory_run_id: 'run_mem_3' })

    const first = listMemoryBatches(db, { task_id: 'tsk_1', limit: 1, now: NOW_MS })
    expect(first.next_cursor).toBeTruthy()
    expect(errorCode(() => listMemoryBatches(db, { task_id: 'tsk_2', cursor: first.next_cursor ?? undefined, now: NOW_MS })))
      .toBe('CURSOR_FILTER_MISMATCH')
    db.raw.close()
  })

  it('limit 越界报 RANGE_TOO_LARGE，非正整数报 PAYLOAD_SCHEMA_INVALID', () => {
    const { db } = freshLedger()
    expect(errorCode(() => listMemoryBatches(db, { limit: 101 }))).toBe('RANGE_TOO_LARGE')
    expect(errorCode(() => listMemoryBatches(db, { limit: 0 }))).toBe('PAYLOAD_SCHEMA_INVALID')
    expect(errorCode(() => listMemoryBatches(db, { limit: -1 }))).toBe('PAYLOAD_SCHEMA_INVALID')
    expect(errorCode(() => listMemoryBatches(db, { limit: 1.5 }))).toBe('PAYLOAD_SCHEMA_INVALID')
    db.raw.close()
  })

  it('只读：投影前后 memory_batches / memory_items / decisions 行数不变', () => {
    const { db } = freshLedger()
    seedTask(db, 'tsk_1')
    seedRuns(db, 'tsk_1', ['run_src_1', 'run_mem_1'])
    insertBatch(db, { batch_id: 'membatch_1', task_id: 'tsk_1', source_run_id: 'run_src_1', memory_run_id: 'run_mem_1' })
    insertItem(db, { item_id: 'memitem_1', batch_id: 'membatch_1', client_key: 'item_1' })

    const before = [
      countOf(db, 'memory_batches'),
      countOf(db, 'memory_items'),
      countOf(db, 'decisions'),
      countOf(db, 'events'),
    ]
    listMemoryBatches(db, {})
    listMemoryBatches(db, { task_id: 'tsk_1', limit: 1 })
    // 坏游标也要只读地报错，不许留下半截写入。
    expect(errorCode(() => listMemoryBatches(db, { task_id: 'tsk_1', limit: 1, cursor: 'not-a-cursor' })))
      .toBe('CURSOR_EXPIRED')
    const after = [
      countOf(db, 'memory_batches'),
      countOf(db, 'memory_items'),
      countOf(db, 'decisions'),
      countOf(db, 'events'),
    ]
    expect(after).toEqual(before)
    db.raw.close()
  })
})
