/**
 * 记忆 run 运行驱动的集成测试。
 *
 * 覆盖：固定图推进、节点/run 事件、批次落库、评估端口失败口径、inspect_batch 证据口径、
 * 受控写失败口径、幂等、崩溃续跑、租约失效、终态收口、审批卡复用同一 decision_id。
 */
import { describe, expect, it } from 'vitest'
import { TEST_SECRET, countOf, freshLedger } from '../fixtures/ledger.ts'
import { inTx } from '../../src/infra/db/tx.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { findMemoryNode, memoryGraphOrder } from '../../src/core/memory-graph-schema.ts'
import type { MemoryItemInput } from '../../src/core/memory-canonical.ts'
import { startMemoryRun } from '../../src/service/commands/memory.ts'
import { resolveMemoryApproval } from '../../src/service/commands/memory-approval.ts'
import { inspectMemoryRecovery, resolveMemoryRecovery } from '../../src/service/commands/memory-recovery.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import {
  createMemoryPorts,
  type MemoryJudge,
  type MemoryWriteGoverned,
} from '../../src/service/commands/memory-ports.ts'
import {
  advanceMemoryRuntime,
  MEMORY_RUNTIME_EVENTS,
  type MemoryRuntimeDeps,
} from '../../src/service/commands/memory-runtime.ts'

const NOW = '2026-11-18T03:00:00.000Z'
const LATER = '2026-11-18T04:00:00.000Z'
const OPERATION_ID = '0192c3a4-5b6d-7e8f-9a0b-1c2d3e4f5061'
const SOURCE_RUN = 'run_src_1'

type Stmt = { all: (...params: unknown[]) => unknown[]; get: (...params: unknown[]) => unknown }

function all<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return (db.raw.prepare(sql) as unknown as Stmt).all(...params) as T[]
}

function one<T>(db: Db, sql: string, ...params: unknown[]): T | undefined {
  return (db.raw.prepare(sql) as unknown as Stmt).get(...params) as T | undefined
}

function seedSourceRun(db: Db, runId = SOURCE_RUN, status = 'succeeded'): void {
  withTx(db, (tx) => {
    tx.run(
      "INSERT OR IGNORE INTO tasks (task_id, title, status, revision, created_at, updated_at)" +
        " VALUES ('tsk_mem_1', '记忆任务', 'running', 0, ?, ?)",
      [NOW, NOW],
    )
    tx.run(
      "INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision," +
        " started_at, created_at, updated_at) VALUES (?, ?, 'wf_main', 1, ?, 0, ?, ?, ?)",
      [runId, 'tsk_mem_1', status, NOW, NOW, NOW],
    )
  })
}

function startRun(db: Db, requestKey = 'req_1') {
  seedSourceRun(db)
  return startMemoryRun(db, {
    source_run_id: SOURCE_RUN,
    reason: '整理这次任务的记忆',
    request_key: requestKey,
    operation_id: OPERATION_ID,
    now: NOW,
  })
}

function item(clientKey: string, over: Partial<MemoryItemInput> = {}): MemoryItemInput {
  return {
    client_key: clientKey,
    action: 'create',
    target_id: null,
    layer: 'L4',
    title: `标题 ${clientKey}`,
    content: `内容 ${clientKey}`,
    tags: [],
    questions: [],
    key: null,
    importance: 5,
    ttl_days: null,
    quote: '引文',
    reason: '原因',
    ...over,
  }
}

/** 裁判响应：字段照 parseJudgeResponse 的严格 schema 给，不带 recommendation（由逐条判定推导）。 */
function judgeBody(verdict: string, clientKeys: string[]): string {
  return JSON.stringify({
    items: clientKeys.map((key) => ({
      client_key: key,
      verdict,
      reason: '测试判定',
      confidence: 0.9,
    })),
    summary: '测试评估',
    duration_ms: 12,
    model: { provider: 'test', name: 'judge', prompt_version: 'v1' },
  })
}

type WriteCall = { batch_id: string; items: readonly MemoryItemInput[] }

type DepsOptions = {
  items?: unknown[]
  judge?: MemoryJudge
  writeMemory?: MemoryWriteGoverned
  evalEnabled?: () => boolean
  leaseTtlMs?: number
  writeCalls?: WriteCall[]
}

function makeDeps(db: Db, over: DepsOptions = {}): MemoryRuntimeDeps {
  const writeCalls = over.writeCalls ?? []
  const ports = createMemoryPorts({
    db,
    judge: over.judge ?? (async () => judgeBody('approve', ['item_1'])),
    writeMemory:
      over.writeMemory ??
      (async (input) => {
        writeCalls.push({ batch_id: input.batch_id, items: input.items })
        return {
          applied_count: input.items.length,
          skipped_count: 0,
          applied_item_ids: input.items.map((entry) => `memitem_${entry.client_key}`),
        }
      }),
    ...(over.evalEnabled ? { evalEnabled: over.evalEnabled } : {}),
  })
  return {
    db,
    secret: TEST_SECRET,
    ports,
    prepareItems: async () => ({ items: over.items ?? [item('item_1')] }),
    now: () => NOW,
    ...(over.leaseTtlMs === undefined ? {} : { leaseTtlMs: over.leaseTtlMs }),
  }
}

function nodeStatus(db: Db, runId: string, nodeId: string): string | undefined {
  return one<{ status: string }>(
    db,
    'SELECT status FROM node_runs WHERE run_id = ? AND node_id = ?',
    runId,
    nodeId,
  )?.status
}

describe('记忆 run 运行驱动', () => {
  it('节点严格按固定图顺序与节点类型建出来，不引入图外节点', () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const nodeRows = all<{ node_id: string; node_type: string }>(
      db,
      'SELECT node_id, node_type FROM node_runs WHERE run_id = ? ORDER BY seq',
      started.memory_run_id,
    )
    expect(nodeRows.map((row) => row.node_id)).toEqual([...memoryGraphOrder()])
    expect(nodeRows.map((row) => row.node_type)).toEqual(
      memoryGraphOrder().map((nodeId) => findMemoryNode(nodeId)?.kind),
    )
  })

  it('每个节点推进写一条节点链事件与一条 run 级事件', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const deps = makeDeps(db, { judge: async () => judgeBody('reject', ['item_1']) })
    await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })

    const nodeEvents = all<{ type: string }>(
      db,
      'SELECT type FROM node_run_events WHERE node_run_id IN' +
        ' (SELECT node_run_id FROM node_runs WHERE run_id = ?)',
      started.memory_run_id,
    )
    const advanced = nodeEvents.filter((row) => row.type === MEMORY_RUNTIME_EVENTS.nodeAdvanced)
    expect(advanced.length).toBe(memoryGraphOrder().length)

    const runEvents = all<{ type: string }>(
      db,
      'SELECT type FROM events WHERE type = ?',
      MEMORY_RUNTIME_EVENTS.runNodeAdvanced,
    )
    expect(runEvents.length).toBe(memoryGraphOrder().length)
  })

  it('mem_prepare 的产出落进 memory_batches 与 memory_items', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const deps = makeDeps(db, { judge: async () => judgeBody('reject', ['item_1']) })
    await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })

    expect(countOf(db, 'memory_items')).toBe(1)
    const batch = one<{ status: string; proposal_hash: string | null }>(
      db,
      'SELECT status, proposal_hash FROM memory_batches WHERE batch_id = ?',
      started.batch_id,
    )
    expect(batch?.proposal_hash).toBeTruthy()
  })

  it('准备输出不合法时节点失败且批次不落行', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const deps = makeDeps(db, { items: [{ ...item('item_1'), client_key: '非法 key' }] })
    const result = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })

    expect(result.status).toBe('failed')
    expect(result.error_code).toBe('MEMORY_PROPOSAL_INVALID')
    expect(countOf(db, 'memory_batches')).toBe(0)
    expect(countOf(db, 'memory_items')).toBe(0)
    expect(nodeStatus(db, started.memory_run_id, 'mem_prepare')).toBe('failed')
  })

  it('裁判返回非 JSON 时批次 failed、无审批卡、无写入、剩余 proposed 全部 skipped', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const writeCalls: WriteCall[] = []
    const deps = makeDeps(db, { judge: async () => 'not-json', writeCalls })
    const result = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })

    expect(result.status).toBe('failed')
    expect(result.error_code).toBe('MEMORY_EVAL_INVALID_OUTPUT')
    expect(countOf(db, 'decisions')).toBe(0)
    expect(writeCalls.length).toBe(0)
    const batch = one<{ status: string; error_code: string | null }>(
      db,
      'SELECT status, error_code FROM memory_batches WHERE batch_id = ?',
      started.batch_id,
    )
    expect(batch?.status).toBe('failed')
    expect(batch?.error_code).toBe('MEMORY_EVAL_INVALID_OUTPUT')
    const items = all<{ status: string }>(
      db,
      'SELECT status FROM memory_items WHERE batch_id = ?',
      started.batch_id,
    )
    expect(items.length).toBe(1)
    expect(items[0]?.status).toBe('skipped')
  })

  it('评估端口三种失败口径可区分：超时、不可用、开关关闭', async () => {
    const cases: Array<{ name: string; code: string; opts: DepsOptions }> = [
      {
        name: '裁判超时',
        code: 'MEMORY_EVAL_TIMEOUT',
        opts: {
          judge: async () => {
            const timeout = new Error('judge timeout')
            timeout.name = 'TimeoutError'
            throw timeout
          },
        },
      },
      {
        name: '裁判不可用',
        code: 'MEMORY_EVAL_UNAVAILABLE',
        opts: {
          judge: async () => {
            throw new Error('judge down')
          },
        },
      },
      {
        name: '开关关闭',
        code: 'MEMORY_EVAL_DISABLED',
        opts: { evalEnabled: () => false },
      },
    ]
    for (const entry of cases) {
      const { db } = freshLedger()
      const started = startRun(db)
      const writeCalls: WriteCall[] = []
      const deps = makeDeps(db, { ...entry.opts, writeCalls })
      const result = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })

      expect(result.status, entry.name).toBe('failed')
      expect(result.error_code, entry.name).toBe(entry.code)
      expect(countOf(db, 'decisions'), entry.name).toBe(0)
      expect(writeCalls.length, entry.name).toBe(0)
      const batch = one<{ status: string; error_code: string | null }>(
        db,
        'SELECT status, error_code FROM memory_batches WHERE batch_id = ?',
        started.batch_id,
      )
      expect(batch?.status, entry.name).toBe('failed')
      expect(batch?.error_code, entry.name).toBe(entry.code)
      const items = all<{ status: string }>(
        db,
        'SELECT status FROM memory_items WHERE batch_id = ?',
        started.batch_id,
      )
      expect(items.every((row) => row.status === 'skipped'), entry.name).toBe(true)
    }
  })

  it('评估端口按 batch_id + prepare_node_run_id 找批次，对不上报 MEMORY_BATCH_NOT_FOUND', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const deps = makeDeps(db)
    const ports = deps.ports
    const error = await ports
      .evaluate({
        batch_id: started.batch_id,
        prepare_node_run_id: 'node_run_not_mine',
        source: {
          run_id: SOURCE_RUN,
          task_title: '记忆任务',
          goal: '',
          result_summary: '',
          evidence_refs: [],
        },
      })
      .catch((err: unknown) => err)
    expect((error as { code?: string }).code).toBe('MEMORY_BATCH_NOT_FOUND')
  })

  it('needs_user 时不生成审批卡、走 mem_report_blocked 且 run 收口为 succeeded', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const deps = makeDeps(db, { judge: async () => judgeBody('needs_user', ['item_1']) })
    const result = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })

    expect(result.status).toBe('completed')
    expect(result.steps.map((step) => step.node_id)).toEqual([
      'mem_trigger',
      'mem_prepare',
      'mem_check',
      'mem_route',
      'mem_report_blocked',
    ])
    expect(result.batch_status).toBe('blocked')
    expect(result.terminal).toBe('succeeded')
    expect(countOf(db, 'decisions')).toBe(0)
  })

  it('全 reject 时走 mem_report_empty，run 收口为 succeeded', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const deps = makeDeps(db, { judge: async () => judgeBody('reject', ['item_1']) })
    const result = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })

    expect(result.status).toBe('completed')
    expect(result.steps.map((step) => step.node_id)).toEqual([
      'mem_trigger',
      'mem_prepare',
      'mem_check',
      'mem_route',
      'mem_report_empty',
    ])
    expect(result.batch_status).toBe('empty')
    expect(result.terminal).toBe('succeeded')
    expect(result.run_status).toBe('succeeded')
  })

  it('ready 路线：人批准后 mem_apply 复用同一 decision_id，全 run 只有一张 audit_result 卡', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const writeCalls: WriteCall[] = []
    const deps = makeDeps(db, { judge: async () => judgeBody('approve', ['item_1']), writeCalls })

    const first = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })
    expect(first.status).toBe('blocked')
    expect(first.steps.map((step) => step.node_id)).toEqual([
      'mem_trigger',
      'mem_prepare',
      'mem_check',
      'mem_route',
      'mem_confirm',
    ])

    const waiting = one<{ status: string; decision_id: string | null }>(
      db,
      'SELECT status, decision_id FROM memory_batches WHERE batch_id = ?',
      started.batch_id,
    )
    expect(waiting?.status).toBe('awaiting_human')
    const decisionId = waiting?.decision_id ?? ''
    expect(decisionId).not.toBe('')
    expect(nodeStatus(db, started.memory_run_id, 'mem_confirm')).toBe('blocked_pre')

    const resolved = inTx(db, (tx) =>
      resolveMemoryApproval(tx, TEST_SECRET, {
        batch_id: started.batch_id,
        decision_id: decisionId,
        resolution: 'approved',
        now: LATER,
        actor: { kind: 'human', id: 'tester' },
      }),
    )
    expect(resolved.batch_status).toBe('approved')
    expect(resolved.approved_count).toBe(1)

    const second = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: LATER })
    expect(second.status).toBe('completed')
    expect(second.steps.map((step) => step.node_id)).toEqual(['mem_confirm', 'mem_apply', 'mem_report'])
    expect(second.terminal).toBe('succeeded')

    // 全 run 只有一张 audit_result 卡
    expect(countOf(db, 'decisions')).toBe(1)
    const cards = all<{ decision_id: string; kind: string }>(
      db,
      "SELECT decision_id, kind FROM decisions WHERE kind = 'audit_result'",
    )
    expect(cards.length).toBe(1)
    expect(cards[0]?.decision_id).toBe(decisionId)

    // mem_apply 复用同一张卡
    const reused = all<{ payload: string }>(
      db,
      "SELECT payload FROM node_run_events WHERE type = ? AND node_run_id IN" +
        " (SELECT node_run_id FROM node_runs WHERE run_id = ? AND node_id = 'mem_apply')",
      MEMORY_RUNTIME_EVENTS.approvalReused,
      started.memory_run_id,
    )
    expect(reused.length).toBe(1)
    expect(JSON.parse(reused[0]?.payload ?? '{}')['decision_id']).toBe(decisionId)

    // 受控写只发生一次，写的是批准过的那一条
    expect(writeCalls.length).toBe(1)
    expect(writeCalls[0]?.items.map((entry) => entry.client_key)).toEqual(['item_1'])

    const batch = one<{
      status: string
      outcome: string | null
      applied_count: number
      approved_proposal_hash: string | null
      approved_item_hashes_json: string | null
    }>(
      db,
      'SELECT status, outcome, applied_count, approved_proposal_hash, approved_item_hashes_json' +
        ' FROM memory_batches WHERE batch_id = ?',
      started.batch_id,
    )
    expect(batch?.status).toBe('applied')
    expect(batch?.outcome).toBe('written')
    expect(batch?.applied_count).toBe(1)
    expect(batch?.approved_proposal_hash).toBeTruthy()

    const rows = all<{
      client_key: string
      status: string
      content_hash: string
      approved_content_hash: string | null
    }>(
      db,
      'SELECT client_key, status, content_hash, approved_content_hash FROM memory_items WHERE batch_id = ?',
      started.batch_id,
    )
    expect(rows[0]?.status).toBe('applied')
    expect(rows[0]?.approved_content_hash).toBe(rows[0]?.content_hash)
    const pairs = JSON.parse(batch?.approved_item_hashes_json ?? '[]') as Array<[string, string]>
    expect(pairs).toEqual([['item_1', rows[0]?.content_hash]])
  })

  it('inspect_batch 口径齐全，evidence_id 记进节点事件', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const deps = makeDeps(db, { judge: async () => judgeBody('approve', ['item_1']) })
    await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })
    const waiting = one<{ decision_id: string | null }>(
      db,
      'SELECT decision_id FROM memory_batches WHERE batch_id = ?',
      started.batch_id,
    )
    inTx(db, (tx) =>
      resolveMemoryApproval(tx, TEST_SECRET, {
        batch_id: started.batch_id,
        decision_id: waiting?.decision_id ?? '',
        resolution: 'approved',
        now: LATER,
        actor: { kind: 'human', id: 'tester' },
      }),
    )
    await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: LATER })

    const inspected = deps.ports.inspectBatch({ batch_id: started.batch_id })
    expect(inspected.batch_id).toBe(started.batch_id)
    expect(inspected.batch_status).toBe('applied')
    expect(inspected.items.length).toBe(1)
    expect(inspected.items[0]?.status).toBe('applied')
    expect(inspected.written_count).toBe(1)
    expect(inspected.missing_count).toBe(0)
    expect(inspected.partial).toBe(false)
    expect(inspected.evidence_id.startsWith('mev_')).toBe(true)

    const reportEvents = all<{ payload: string }>(
      db,
      "SELECT payload FROM node_run_events WHERE type = ? AND node_run_id IN" +
        " (SELECT node_run_id FROM node_runs WHERE run_id = ? AND node_id = 'mem_report')",
      MEMORY_RUNTIME_EVENTS.nodeAdvanced,
      started.memory_run_id,
    )
    expect(reportEvents.length).toBe(1)
    const payload = JSON.parse(reportEvents[0]?.payload ?? '{}') as Record<string, unknown>
    expect(payload['evidence_id']).toBe(inspected.evidence_id)
  })

  it('受控写失败时批次 failed、approved 条目全 failed、不留 proposed、不自动重试', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const writeCalls: WriteCall[] = []
    const deps = makeDeps(db, {
      judge: async () => judgeBody('approve', ['item_1']),
      writeCalls,
      writeMemory: async (input) => {
        writeCalls.push({ batch_id: input.batch_id, items: input.items })
        return { outcome: 'not_written' }
      },
    })
    await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })
    const waiting = one<{ decision_id: string | null }>(
      db,
      'SELECT decision_id FROM memory_batches WHERE batch_id = ?',
      started.batch_id,
    )
    inTx(db, (tx) =>
      resolveMemoryApproval(tx, TEST_SECRET, {
        batch_id: started.batch_id,
        decision_id: waiting?.decision_id ?? '',
        resolution: 'approved',
        now: LATER,
        actor: { kind: 'human', id: 'tester' },
      }),
    )
    const result = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: LATER })

    expect(result.status).toBe('failed')
    expect(result.error_code).toBe('MEMORY_APPLY_FAILED')
    const batch = one<{ status: string; error_code: string | null }>(
      db,
      'SELECT status, error_code FROM memory_batches WHERE batch_id = ?',
      started.batch_id,
    )
    expect(batch?.status).toBe('failed')
    expect(batch?.error_code).toBe('MEMORY_APPLY_FAILED')
    const items = all<{ status: string }>(
      db,
      'SELECT status FROM memory_items WHERE batch_id = ?',
      started.batch_id,
    )
    expect(items.every((row) => row.status === 'failed')).toBe(true)

    // 不自动重试：再推进一次不会再调受控写
    const again = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: LATER })
    expect(again.status).toBe('failed')
    expect(writeCalls.length).toBe(1)
  })

  it.each(['lost_receipt', 'invalid_receipt', 'mismatched_snapshot'] as const)('%s 无法冒充确认写入或触发重放', async (scenario) => {
    const { db } = freshLedger()
    const started = startRun(db)
    let writes = 0
    const deps = makeDeps(db, {
      writeMemory: async () => {
        writes += 1
        if (scenario === 'lost_receipt') throw new Error('写入后连接断开')
        return { applied_count: 1, skipped_count: 0, applied_item_ids: [] }
      },
    })
    await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })
    const waiting = one<{ decision_id: string }>(db, 'SELECT decision_id FROM memory_batches WHERE batch_id = ?', started.batch_id)
    inTx(db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: started.batch_id, decision_id: waiting!.decision_id, resolution: 'approved',
      now: LATER, actor: { kind: 'human', id: 'tester' },
    }))
    if (scenario === 'mismatched_snapshot') {
      withTx(db, (tx) => {
        const trigger = tx.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'memory_items_proposal_immutable_after_approval'")
        tx.run('DROP TRIGGER memory_items_proposal_immutable_after_approval')
        tx.run("UPDATE memory_items SET title = '批准后遭篡改的标题' WHERE batch_id = ?", [started.batch_id])
        tx.run(trigger!.sql)
      })
      const result = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: LATER })
      expect(result.error_code).toBe('MEMORY_APPLY_BINDING_INVALID')
      expect(writes).toBe(0)
      return
    }

    const result = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: LATER })
    expect(result).toMatchObject({ status: 'blocked', batch_status: 'applying', run_status: 'paused', terminal: null })
    expect(nodeStatus(db, started.memory_run_id, 'mem_apply')).toBe('indeterminate_side_effect')
    expect(() => deps.ports.inspectBatch({ batch_id: started.batch_id })).toThrow(/写入端对账/)
    const retry = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: LATER })
    expect(retry.status).toBe('blocked')
    expect(writes).toBe(1)
  })

  it('零写入确认后，旧 attempt 的迟到失败回执不能关闭新 attempt', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const actor = { kind: 'human', id: 'tester' } as const
    let announceWrite!: () => void
    const enteredWrite = new Promise<void>((resolve) => { announceWrite = resolve })
    let returnOld!: (value: { outcome: 'not_written' }) => void
    const oldReceipt = new Promise<{ outcome: 'not_written' }>((resolve) => { returnOld = resolve })
    const deps = makeDeps(db, { writeMemory: async () => { announceWrite(); return oldReceipt } })
    await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })
    const waiting = one<{ decision_id: string }>(db, 'SELECT decision_id FROM memory_batches WHERE batch_id = ?', started.batch_id)
    inTx(db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: started.batch_id, decision_id: waiting!.decision_id, resolution: 'approved', now: LATER, actor,
    }))
    const first = advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: LATER })
    await enteredWrite
    const recovery = { db, secret: TEST_SECRET, now: () => LATER, inspectWrite: async (scope: {
      batch_id: string; node_run_id: string
    }) => ({ ...scope, stopped_at: LATER, entries: [] }) }
    const proof = await inspectMemoryRecovery(recovery, started.batch_id)
    resolveMemoryRecovery(recovery, actor, {
      batch_id: started.batch_id, decision_id: proof.decision_id, revision: proof.revision,
      evidence_id: proof.evidence_id, stopped_at: proof.stopped_at,
      resolution: 'confirm_not_applied', operation_id: uuidv7(),
    })
    returnOld({ outcome: 'not_written' })
    expect(await first).toMatchObject({ status: 'blocked', batch_status: 'applying', run_status: 'running' })
    expect(await advanceMemoryRuntime(makeDeps(db), { memory_run_id: started.memory_run_id, now: LATER }))
      .toMatchObject({ terminal: 'succeeded', batch_status: 'applied' })
  })

  it('人驳回时批次 declined、run failed、受控写没被调用', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const writeCalls: WriteCall[] = []
    const deps = makeDeps(db, { judge: async () => judgeBody('approve', ['item_1']), writeCalls })
    await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })
    const waiting = one<{ decision_id: string | null }>(
      db,
      'SELECT decision_id FROM memory_batches WHERE batch_id = ?',
      started.batch_id,
    )
    inTx(db, (tx) =>
      resolveMemoryApproval(tx, TEST_SECRET, {
        batch_id: started.batch_id,
        decision_id: waiting?.decision_id ?? '',
        resolution: 'rejected',
        now: LATER,
        actor: { kind: 'human', id: 'tester' },
      }),
    )
    const result = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: LATER })

    expect(result.status).toBe('failed')
    expect(result.batch_status).toBe('declined')
    expect(result.terminal).toBe('failed')
    expect(writeCalls.length).toBe(0)
    expect(nodeStatus(db, started.memory_run_id, 'mem_apply')).toBe('superseded')
    const items = all<{ status: string }>(
      db,
      'SELECT status FROM memory_items WHERE batch_id = ?',
      started.batch_id,
    )
    expect(items.every((row) => row.status === 'skipped')).toBe(true)
  })

  it('重复推进不重跑已完成的节点、不重复写事件、不重复写批次', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const writeCalls: WriteCall[] = []
    const deps = makeDeps(db, { judge: async () => judgeBody('approve', ['item_1']), writeCalls })
    await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })
    const waiting = one<{ decision_id: string | null }>(
      db,
      'SELECT decision_id FROM memory_batches WHERE batch_id = ?',
      started.batch_id,
    )
    inTx(db, (tx) =>
      resolveMemoryApproval(tx, TEST_SECRET, {
        batch_id: started.batch_id,
        decision_id: waiting?.decision_id ?? '',
        resolution: 'approved',
        now: LATER,
        actor: { kind: 'human', id: 'tester' },
      }),
    )
    const done = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: LATER })
    expect(done.status).toBe('completed')

    const eventsBefore = countOf(db, 'node_run_events')
    const advancedBefore = all<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM node_run_events WHERE type = ?",
      MEMORY_RUNTIME_EVENTS.nodeAdvanced,
    )[0]?.n
    const batchBefore = one<{ status: string; applied_count: number }>(
      db,
      'SELECT status, applied_count FROM memory_batches WHERE batch_id = ?',
      started.batch_id,
    )

    const again = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: LATER })
    expect(again.status).toBe('completed')
    expect(again.steps.length).toBe(0)
    expect(countOf(db, 'node_run_events')).toBe(eventsBefore)
    const advancedAfter = all<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM node_run_events WHERE type = ?",
      MEMORY_RUNTIME_EVENTS.nodeAdvanced,
    )[0]?.n
    expect(advancedAfter).toBe(advancedBefore)
    expect(writeCalls.length).toBe(1)
    const batchAfter = one<{ status: string; applied_count: number }>(
      db,
      'SELECT status, applied_count FROM memory_batches WHERE batch_id = ?',
      started.batch_id,
    )
    expect(batchAfter).toEqual(batchBefore)
  })

  it('同一批次第二次评估是新 eval_attempt，旧评估保留', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const deps = makeDeps(db, { judge: async () => judgeBody('approve', ['item_1']) })
    // 只推进到 mem_prepare：批次停在 draft，条目已落库
    await expect(
      advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW, max_steps: 2 }),
    ).rejects.toThrow(/步数上限/)

    const batch = one<{ prepare_node_run_id: string | null; status: string }>(
      db,
      'SELECT prepare_node_run_id, status FROM memory_batches WHERE batch_id = ?',
      started.batch_id,
    )
    expect(batch?.status).toBe('draft')
    const source = {
      run_id: SOURCE_RUN,
      task_title: '记忆任务',
      goal: '目标',
      result_summary: '结果',
      evidence_refs: [],
    }
    const first = await deps.ports.evaluate({
      batch_id: started.batch_id,
      prepare_node_run_id: batch?.prepare_node_run_id ?? '',
      source,
      now: NOW,
    })
    const second = await deps.ports.evaluate({
      batch_id: started.batch_id,
      prepare_node_run_id: batch?.prepare_node_run_id ?? '',
      source,
      now: LATER,
    })
    expect(first.eval_attempt).toBe(1)
    expect(second.eval_attempt).toBe(2)
    const evaluations = all<{ eval_attempt: number; recommendation: string }>(
      db,
      'SELECT eval_attempt, recommendation FROM memory_evaluations WHERE batch_id = ? ORDER BY eval_attempt',
      started.batch_id,
    )
    expect(evaluations.length).toBe(2)
    expect(evaluations.map((row) => row.eval_attempt)).toEqual([1, 2])
  })

  it('崩溃续跑：从当前节点继续推进，不重跑已 done 的节点', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const deps = makeDeps(db, { judge: async () => judgeBody('reject', ['item_1']) })
    await expect(
      advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW, max_steps: 1 }),
    ).rejects.toThrow(/步数上限/)
    expect(nodeStatus(db, started.memory_run_id, 'mem_trigger')).toBe('done')
    expect(nodeStatus(db, started.memory_run_id, 'mem_prepare')).toBe('queued')
    const triggerEvents = all<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id IN' +
        " (SELECT node_run_id FROM node_runs WHERE run_id = ? AND node_id = 'mem_trigger')",
      started.memory_run_id,
    )[0]?.n

    const resumed = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })
    expect(resumed.status).toBe('completed')
    expect(resumed.steps.map((step) => step.node_id)).not.toContain('mem_trigger')
    const triggerEventsAfter = all<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id IN' +
        " (SELECT node_run_id FROM node_runs WHERE run_id = ? AND node_id = 'mem_trigger')",
      started.memory_run_id,
    )[0]?.n
    expect(triggerEventsAfter).toBe(triggerEvents)
  })

  it('租约失效时推进失败，不在无租约下写节点状态', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const deps = makeDeps(db, { leaseTtlMs: 0 })
    const error = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW }).catch(
      (err: unknown) => err,
    )
    expect((error as { code?: string }).code).toBe('LEASE_EXPIRED')
    expect(nodeStatus(db, started.memory_run_id, 'mem_trigger')).toBe('started')
    const advanced = all<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM node_run_events WHERE type = ?',
      MEMORY_RUNTIME_EVENTS.nodeAdvanced,
    )[0]?.n
    expect(advanced).toBe(0)
  })
})
