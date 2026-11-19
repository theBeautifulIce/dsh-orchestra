import { describe, expect, it } from 'vitest'
import { TEST_SECRET, countOf, freshLedger } from '../fixtures/ledger.ts'
import { inTx } from '../../src/infra/db/tx.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { contentHash, type MemoryItemInput } from '../../src/core/memory-canonical.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import type { ClockProvider } from '../../src/core/clock.ts'
import { startMemoryRun } from '../../src/service/commands/memory.ts'
import { resolveMemoryApproval } from '../../src/service/commands/memory-approval.ts'
import { sweepExpiredLeases } from '../../src/service/commands/lease.ts'
import { createMemoryPorts, type MemoryJudge, type MemoryWriteGoverned } from '../../src/service/commands/memory-ports.ts'
import { advanceMemoryRuntime, createMemoryRuntime, type MemoryRuntimeDeps } from '../../src/service/commands/memory-runtime.ts'
import { createMemoryHost } from '../../src/service/memory-host.ts'

const NOW = '2026-11-18T03:00:00.000Z'
const LATER = '2026-11-18T04:00:00.000Z'
const OPERATION_ID = '0192c3a4-5b6d-7e8f-9a0b-1c2d3e4f5061'
const SOURCE_RUN = 'run_src_1'
const BOOT = 'boot_memory_lease' as ClockProvider['bootId']

type Stmt = { all: (...params: unknown[]) => unknown[]; get: (...params: unknown[]) => unknown }

function all<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return (db.raw.prepare(sql) as unknown as Stmt).all(...params) as T[]
}

function one<T>(db: Db, sql: string, ...params: unknown[]): T | undefined {
  return (db.raw.prepare(sql) as unknown as Stmt).get(...params) as T | undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** 从基准时刻起按真实速度前进的墙钟：租约到期、续租、维护扫描都用它，同一条时间线。 */
function advancingClock(baseIso: string): ClockProvider {
  const base = Date.parse(baseIso)
  const origin = Date.now()
  const elapsed = (): number => Date.now() - origin
  return {
    bootId: BOOT,
    sample: () => ({ bootId: BOOT, monotonicNs: elapsed() * 1e6, wallClockMs: base + elapsed() }),
    decide: () => ({ kind: 'pending', remainingMs: 1000 }),
  }
}

function seedSourceRun(db: Db, runId = SOURCE_RUN, status = 'succeeded'): void {
  withTx(db, (tx) => {
    tx.run(
      "INSERT OR IGNORE INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('tsk_mem_1', '记忆任务', 'running', 0, ?, ?)",
      [NOW, NOW],
    )
    tx.run(
      "INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, started_at, created_at, updated_at) VALUES (?, ?, 'wf_main', 1, ?, 0, ?, ?, ?)",
      [runId, 'tsk_mem_1', status, NOW, NOW, NOW],
    )
  })
}

function startRun(db: Db, requestKey = 'req_1', sourceRunId = SOURCE_RUN) {
  seedSourceRun(db, sourceRunId)
  return startMemoryRun(db, {
    source_run_id: sourceRunId,
    reason: '整理这次任务的记忆',
    request_key: requestKey,
    operation_id: sourceRunId === SOURCE_RUN ? OPERATION_ID : uuidv7(),
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

function judgeBody(verdict: string, clientKeys: string[]): string {
  return JSON.stringify({
    items: clientKeys.map((key) => ({ client_key: key, verdict, reason: '测试判定', confidence: 0.9 })),
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
  prepareItems?: () => Promise<{ items: unknown[] }>
  clock?: ClockProvider
  leaseTtlMs?: number
  leaseRenewIntervalMs?: number
  stepTimeoutMs?: number
  writeCalls?: WriteCall[]
}

function makeDeps(db: Db, over: DepsOptions = {}): MemoryRuntimeDeps {
  const writeCalls = over.writeCalls ?? []
  const ports = createMemoryPorts({
    db,
    judge: over.judge ?? (async () => judgeBody('approve', ['item_1'])),
    writeMemory: over.writeMemory ?? (async (input) => {
      writeCalls.push({ batch_id: input.batch_id, items: input.items })
      return {
        applied_count: input.items.length,
        skipped_count: 0,
        applied_item_ids: input.items.map((entry) => `memitem_${entry.client_key}`),
      }
    }),
  })
  return {
    db,
    secret: TEST_SECRET,
    ports,
    prepareItems: over.prepareItems ?? (async () => ({ items: over.items ?? [item('item_1')] })),
    ...(over.clock === undefined ? {} : { clock: over.clock }),
    ...(over.leaseTtlMs === undefined ? {} : { leaseTtlMs: over.leaseTtlMs }),
    ...(over.leaseRenewIntervalMs === undefined ? {} : { leaseRenewIntervalMs: over.leaseRenewIntervalMs }),
    ...(over.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: over.stepTimeoutMs }),
  }
}

function nodeStatus(db: Db, runId: string, nodeId: string): string | undefined {
  return one<{ status: string }>(db, 'SELECT status FROM node_runs WHERE run_id = ? AND node_id = ?', runId, nodeId)?.status
}

function nodeRunId(db: Db, runId: string, nodeId: string): string | undefined {
  return one<{ node_run_id: string }>(
    db,
    'SELECT node_run_id FROM node_runs WHERE run_id = ? AND node_id = ?',
    runId,
    nodeId,
  )?.node_run_id
}

describe('记忆运行时的租约与异步时间语义', () => {
  it('AC1 有效续租：异步步骤耗时超过租约 TTL，按 ≤TTL/3 续租后维护扫描不把节点改成 startup_unknown', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const leaseTtlMs = 500
    const clock = advancingClock(NOW)
    const prepareNode = nodeRunId(db, started.memory_run_id, 'mem_prepare')
    expect(prepareNode).toBeTruthy()

    const observed: Array<{ status: string; swept: string[]; expires_at: string | null }> = []
    let wallStart = 0
    let wallEnd = 0
    const prepareItems = async () => {
      wallStart = clock.sample().wallClockMs
      for (let index = 0; index < 16; index += 1) {
        await sleep(50)
        const now = new Date(clock.sample().wallClockMs).toISOString()
        // 维护扫描按同一条时间线判过期：租约有效时它不许碰这个节点
        const swept = inTx(db, (tx) => sweepExpiredLeases(tx, TEST_SECRET, { now, leaseTtlMs }))
        const row = one<{ status: string; lease_expires_at: string | null }>(
          db,
          'SELECT status, lease_expires_at FROM node_runs WHERE run_id = ? AND node_id = ?',
          started.memory_run_id,
          'mem_prepare',
        )
        observed.push({ status: row?.status ?? '', swept, expires_at: row?.lease_expires_at ?? null })
      }
      wallEnd = clock.sample().wallClockMs
      return { items: [item('item_1')] }
    }

    const deps = makeDeps(db, {
      clock,
      leaseTtlMs,
      leaseRenewIntervalMs: 150,
      prepareItems,
      judge: async () => judgeBody('reject', ['item_1']),
    })
    const result = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id })

    // 步骤确实比租约 TTL 长：不续租的话维护扫描早就把它判过期了
    expect(wallEnd - wallStart).toBeGreaterThan(leaseTtlMs)
    expect(observed.length).toBe(16)
    // 扫描期间节点始终是 started：没被扫成 startup_unknown / stopping
    expect(observed.every((row) => row.status === 'started')).toBe(true)
    expect(observed.every((row) => !row.swept.includes(prepareNode!))).toBe(true)
    // 续租确实发生过：到期时刻被一次次往后推
    const firstExpiry = Date.parse(observed[0]!.expires_at!)
    const lastExpiry = Date.parse(observed[observed.length - 1]!.expires_at!)
    expect(lastExpiry).toBeGreaterThan(firstExpiry)

    expect(nodeStatus(db, started.memory_run_id, 'mem_prepare')).toBe('done')
    expect(
      all<{ status: string }>(db, 'SELECT status FROM node_runs WHERE run_id = ?', started.memory_run_id)
        .filter((row) => row.status === 'startup_unknown').length,
    ).toBe(0)
    expect(result.status).toBe('completed')
  })

  it('AC2 失权拒收：租约属主变了以后原执行者不能提交节点结果，也不许执行写端', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const writeCalls: WriteCall[] = []
    let preempted = false
    // 模拟别的执行者抢走租约：mem_apply 节点进入 started 之后把 owner_epoch 顶掉
    const clock: ClockProvider = {
      bootId: BOOT,
      sample: () => {
        if (!preempted) {
          const row = one<{ status: string }>(
            db,
            'SELECT status FROM node_runs WHERE run_id = ? AND node_id = ?',
            started.memory_run_id,
            'mem_apply',
          )
          if (row?.status === 'started') {
            preempted = true
            withTx(db, (tx) => {
              tx.run(
                'UPDATE node_runs SET owner_epoch = owner_epoch + 1 WHERE run_id = ? AND node_id = ?',
                [started.memory_run_id, 'mem_apply'],
              )
            })
          }
        }
        return { bootId: BOOT, monotonicNs: 0, wallClockMs: Date.parse(NOW) }
      },
      decide: () => ({ kind: 'pending', remainingMs: 1000 }),
    }
    const deps = makeDeps(db, { clock, writeCalls })

    await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })
    const waiting = one<{ decision_id: string }>(
      db,
      'SELECT decision_id FROM memory_batches WHERE batch_id = ?',
      started.batch_id,
    )
    inTx(db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: started.batch_id,
      decision_id: waiting!.decision_id,
      resolution: 'approved',
      now: LATER,
      actor: { kind: 'human', id: 'tester' },
    }))

    await expect(
      advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: LATER }),
    ).rejects.toMatchObject({ code: 'STALE_GENERATION' })

    expect(preempted).toBe(true)
    // 写端一次都没被调到，节点也没有被标成 done
    expect(writeCalls.length).toBe(0)
    expect(nodeStatus(db, started.memory_run_id, 'mem_apply')).toBe('started')
    const lost = all<{ type: string }>(
      db,
      "SELECT type FROM node_run_events WHERE node_run_id = ? AND type = 'lease_lost'",
      nodeRunId(db, started.memory_run_id, 'mem_apply'),
    )
    expect(lost.length).toBe(1)
  })

  it('AC3 超时可控：prepareItems 超时后节点不算完成，批次与条目都不落库，租约释放', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const writeCalls: WriteCall[] = []
    const deps = makeDeps(db, {
      writeCalls,
      stepTimeoutMs: 100,
      prepareItems: () => new Promise<{ items: unknown[] }>(() => {}),
    })

    const result = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })

    expect(result.status).toBe('failed')
    expect(result.error_code).toBe('OPERATION_TIMEOUT')
    expect(nodeStatus(db, started.memory_run_id, 'mem_prepare')).toBe('failed')
    expect(countOf(db, 'memory_batches')).toBe(0)
    expect(countOf(db, 'memory_items')).toBe(0)
    expect(writeCalls.length).toBe(0)
    const lease = one<{ lease_id: string | null }>(
      db,
      'SELECT lease_id FROM node_runs WHERE run_id = ? AND node_id = ?',
      started.memory_run_id,
      'mem_prepare',
    )
    expect(lease?.lease_id).toBeNull()
  })

  it.each([
    { scenario: '属主变更后的成功回执', code: 'STALE_GENERATION', wrote: true },
    { scenario: '租约到期后的零写入回执', code: 'LEASE_EXPIRED', wrote: false },
  ])('$scenario 不改变账本，由写入端权威对账恢复', async ({ code, wrote }) => {
    const { db } = freshLedger()
    const started = startRun(db)
    const actor = { kind: 'human', id: 'tester' } as const
    const approved = item('item_1')
    const appliedId = 'memitem_1'
    let writeCalls = 0
    let wallClockMs = Date.parse(NOW)
    const clock: ClockProvider = {
      bootId: BOOT,
      sample: () => ({ bootId: BOOT, wallClockMs, monotonicNs: 0 }),
      decide: () => ({ kind: 'pending', remainingMs: 1000 }),
    }
    let enteredWrite!: () => void
    const inFlight = new Promise<void>((resolve) => { enteredWrite = resolve })
    let releaseReceipt!: () => void
    const receiptReady = new Promise<void>((resolve) => { releaseReceipt = resolve })
    const runtime = createMemoryRuntime({
      db, secret: TEST_SECRET, clock, now: () => new Date(wallClockMs).toISOString(),
      prepareItems: async () => ({ items: [approved] }),
      judge: async () => judgeBody('approve', ['item_1']),
      writer: {
        async writeMemory() {
          writeCalls++
          enteredWrite()
          await receiptReady
          return wrote
            ? { applied_count: 1, skipped_count: 0, applied_item_ids: [appliedId] }
            : { outcome: 'not_written' }
        },
        async fenceAndInspect(scope) {
          return { ...scope, stopped_at: new Date(wallClockMs).toISOString(),
            entries: wrote ? [{ client_key: approved.client_key, content_hash: contentHash(approved), applied_item_id: appliedId }] : [] }
        },
      },
    })
    await runtime.advance({ memory_run_id: started.memory_run_id })
    const waiting = one<{ decision_id: string }>(db, 'SELECT decision_id FROM memory_batches WHERE batch_id = ?', started.batch_id)
    inTx(db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: started.batch_id, decision_id: waiting!.decision_id, resolution: 'approved', now: NOW, actor,
    }))
    const advance = runtime.advance({ memory_run_id: started.memory_run_id })
    await inFlight
    const applyNode = nodeRunId(db, started.memory_run_id, 'mem_apply')!
    if (wrote) db.raw.prepare('UPDATE node_runs SET owner_epoch = owner_epoch + 1 WHERE node_run_id = ?').run(applyNode)
    else wallClockMs += 31_000
    releaseReceipt()
    await expect(advance).rejects.toMatchObject({ code, details: { ownership_lost: true } })
    expect(nodeStatus(db, started.memory_run_id, 'mem_apply')).toBe('started')
    expect(one(db, 'SELECT status, applied_count, error_code FROM memory_batches WHERE batch_id = ?', started.batch_id))
      .toEqual({ status: 'applying', applied_count: 0, error_code: null })
    expect(one(db, 'SELECT status, applied_item_id FROM memory_items WHERE batch_id = ?', started.batch_id))
      .toEqual({ status: 'approved', applied_item_id: null })
    expect(all(db, "SELECT type FROM node_run_events WHERE node_run_id = ? AND type = 'lease_lost'", applyNode))
      .toEqual([{ type: 'lease_lost' }])
    await expect(runtime.advance({ memory_run_id: started.memory_run_id })).resolves.toMatchObject({ status: 'blocked' })
    const proof = await runtime.inspectBatch(started.batch_id)
    const resolution = wrote ? 'confirm_applied' : 'confirm_not_applied'
    expect(proof.allowed_resolutions).toEqual([resolution])
    expect(runtime.resolveRecovery(actor, {
      batch_id: started.batch_id, decision_id: proof.decision_id, revision: proof.revision,
      evidence_id: proof.evidence_id, stopped_at: proof.stopped_at, resolution, operation_id: uuidv7(),
    })).toMatchObject({ status: wrote ? 'confirmed_applied' : 'confirmed_not_applied' })
    if (wrote) {
      await expect(runtime.advance({ memory_run_id: started.memory_run_id }))
        .resolves.toMatchObject({ terminal: 'succeeded', batch_status: 'applied' })
    }
    expect(writeCalls).toBe(1)
  })

  it('宿主插件回执哈希冲突保留 MEMORY_APPLY_CONFLICT，等待权威对账而不重写', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const approved = item('item_1')
    let writes = 0
    const host = createMemoryHost(db, TEST_SECRET, {
      clock: {
        bootId: BOOT,
        sample: () => ({ bootId: BOOT, wallClockMs: Date.parse(NOW), monotonicNs: 0 }),
        decide: () => ({ kind: 'pending', remainingMs: 1000 }),
      },
      prepareItems: async () => ({ items: [approved] }),
      judge: async () => judgeBody('approve', ['item_1']),
      plugin: {
        protocol: 1,
        async writeMemory(input) {
          writes++
          expect(input.items).toEqual([{ ...approved, content_hash: contentHash(approved) }])
          return [{ client_key: approved.client_key, content_hash: '0'.repeat(64), applied_item_id: 'external-id' }]
        },
        async fenceAndInspect(scope) {
          return { ...scope, stopped_at: new Date().toISOString(),
            entries: [{ client_key: approved.client_key, content_hash: contentHash(approved), applied_item_id: 'external-id' }] }
        },
      },
    }, (error) => { throw error })
    try {
      host.resume(NOW)
      await expect.poll(() => nodeStatus(db, started.memory_run_id, 'mem_confirm')).toBe('blocked_pre')
      const waiting = one<{ decision_id: string }>(db, 'SELECT decision_id FROM memory_batches WHERE batch_id = ?', started.batch_id)
      inTx(db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
        batch_id: started.batch_id, decision_id: waiting!.decision_id, resolution: 'approved', now: NOW,
        actor: { kind: 'human', id: 'tester' },
      }))
      await expect.poll(() => {
        host.resume(NOW)
        return nodeStatus(db, started.memory_run_id, 'mem_apply')
      }).toBe('indeterminate_side_effect')
      const event = one<{ payload_redacted: string }>(db, "SELECT payload_redacted FROM events WHERE run_id = ? AND type = 'memory.apply.outcome_unknown'",
        started.memory_run_id)
      expect(JSON.parse(event!.payload_redacted)).toMatchObject({ batch_id: started.batch_id, error_code: 'MEMORY_APPLY_CONFLICT' })
      expect(one(db, 'SELECT status FROM memory_batches WHERE batch_id = ?', started.batch_id)).toEqual({ status: 'applying' })
      expect(one(db, 'SELECT status FROM memory_items WHERE batch_id = ?', started.batch_id)).toEqual({ status: 'approved' })
      host.resume(NOW)
      await expect(host.inspect(started.batch_id)).resolves.toMatchObject({ allowed_resolutions: ['confirm_applied'] })
      expect(writes).toBe(1)
    } finally {
      await host.close()
    }
  })

  it('受控写先拒绝跨 run 批次，再检查批准状态和节点归属', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const writeCalls: WriteCall[] = []
    const deps = makeDeps(db, { writeCalls })
    await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })
    const waiting = one<{ decision_id: string }>(db, 'SELECT decision_id FROM memory_batches WHERE batch_id = ?', started.batch_id)
    const scope = {
      batch_id: started.batch_id, run_id: started.memory_run_id, decision_id: waiting!.decision_id,
      node_run_id: nodeRunId(db, started.memory_run_id, 'mem_confirm')!, now: NOW,
    }
    const neverRenew = () => { throw new Error('拒绝批次时不应续租') }
    const other = startRun(db, 'req_other', 'source_other')
    await expect(deps.ports.applyGoverned({ ...scope, batch_id: 'missing' }, neverRenew))
      .rejects.toMatchObject({ code: 'MEMORY_BATCH_NOT_FOUND' })
    await expect(deps.ports.applyGoverned({ ...scope, run_id: other.memory_run_id }, neverRenew))
      .rejects.toMatchObject({ code: 'MEMORY_BATCH_NOT_FOUND' })
    await expect(deps.ports.applyGoverned(scope, neverRenew)).rejects.toMatchObject({ code: 'MEMORY_BATCH_NOT_APPROVED' })
    inTx(db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: scope.batch_id, decision_id: scope.decision_id, resolution: 'approved', now: NOW,
      actor: { kind: 'human', id: 'tester' },
    }))
    await expect(deps.ports.applyGoverned(scope, neverRenew)).rejects.toMatchObject({ code: 'MEMORY_APPLY_BINDING_INVALID' })
    expect(writeCalls).toHaveLength(0)
    expect(one(db, 'SELECT status, apply_node_run_id FROM memory_batches WHERE batch_id = ?', started.batch_id))
      .toEqual({ status: 'approved', apply_node_run_id: null })
  })

  it('运行 A 的批准批次拒绝运行 B 的已批准 decision_id', async () => {
    const { db } = freshLedger()
    const first = startRun(db)
    const second = startRun(db, 'req_other', 'source_other')
    const writeCalls: WriteCall[] = []
    const deps = makeDeps(db, { writeCalls })
    const actor = { kind: 'human', id: 'tester' } as const
    const decisions: string[] = []
    for (const run of [first, second]) {
      await advanceMemoryRuntime(deps, { memory_run_id: run.memory_run_id, now: NOW })
      const decision = one<{ decision_id: string }>(db, 'SELECT decision_id FROM memory_batches WHERE batch_id = ?', run.batch_id)!
      inTx(db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
        batch_id: run.batch_id, decision_id: decision.decision_id, resolution: 'approved', now: NOW, actor,
      }))
      decisions.push(decision.decision_id)
    }
    const apply = deps.ports.applyGoverned
    deps.ports.applyGoverned = (scope, renew) => apply({ ...scope, decision_id: decisions[1]! }, renew)
    await expect(advanceMemoryRuntime(deps, { memory_run_id: first.memory_run_id, now: NOW }))
      .resolves.toMatchObject({ error_code: 'MEMORY_APPLY_BINDING_INVALID' })
    expect(writeCalls).toHaveLength(0)
    expect(all(db, 'SELECT applied_count FROM memory_batches')).toEqual([{ applied_count: 0 }, { applied_count: 0 }])
  })

  it('同一批次与相同批准哈希重放返回 already_applied，写端仍只调用一次', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const writeCalls: WriteCall[] = []
    const deps = makeDeps(db, { writeCalls })
    await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })
    const waiting = one<{ decision_id: string }>(db, 'SELECT decision_id FROM memory_batches WHERE batch_id = ?', started.batch_id)
    inTx(db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: started.batch_id, decision_id: waiting!.decision_id, resolution: 'approved', now: NOW,
      actor: { kind: 'human', id: 'tester' },
    }))
    await expect(advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW }))
      .resolves.toMatchObject({ terminal: 'succeeded', batch_status: 'applied' })
    expect(one(db, 'SELECT b.source_run_id, b.memory_run_id, i.batch_id, b.decision_id, i.client_key FROM memory_items i'
      + ' JOIN memory_batches b ON b.batch_id = i.batch_id WHERE i.applied_item_id = ?', 'memitem_item_1')).toEqual({
      source_run_id: SOURCE_RUN, memory_run_id: started.memory_run_id, batch_id: started.batch_id,
      decision_id: waiting!.decision_id, client_key: 'item_1',
    })
    const events = countOf(db, 'events')
    const nodeEvents = countOf(db, 'node_run_events')
    const replay = await deps.ports.applyGoverned({
      batch_id: started.batch_id, run_id: started.memory_run_id, decision_id: waiting!.decision_id,
      node_run_id: nodeRunId(db, started.memory_run_id, 'mem_apply')!, now: NOW,
    }, () => { throw new Error('已应用回执重放无需续租') })
    expect(replay).toMatchObject({ already_applied: true, applied_count: 0 })
    expect(writeCalls).toHaveLength(1)
    expect(countOf(db, 'events')).toBe(events)
    expect(countOf(db, 'node_run_events')).toBe(nodeEvents)
  })

  it('AC4 写不确定不重复：写步骤超时后只调一次写端，走既有不确定/对账路径，再推进也不重写', async () => {
    const { db } = freshLedger()
    const started = startRun(db)
    const writeCalls: WriteCall[] = []
    const deps = makeDeps(db, {
      writeCalls,
      stepTimeoutMs: 100,
      writeMemory: async (input) => {
        writeCalls.push({ batch_id: input.batch_id, items: input.items })
        // 写端不回执：结果不确定，但这次调用已经发生
        return new Promise<never>(() => {})
      },
    })

    await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: NOW })
    const waiting = one<{ decision_id: string }>(
      db,
      'SELECT decision_id FROM memory_batches WHERE batch_id = ?',
      started.batch_id,
    )
    inTx(db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: started.batch_id,
      decision_id: waiting!.decision_id,
      resolution: 'approved',
      now: LATER,
      actor: { kind: 'human', id: 'tester' },
    }))

    const result = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: LATER })

    expect(result).toMatchObject({ status: 'blocked', batch_status: 'applying', run_status: 'paused', terminal: null })
    expect(nodeStatus(db, started.memory_run_id, 'mem_apply')).toBe('indeterminate_side_effect')
    expect(writeCalls.length).toBe(1)

    // 再推进也不许第二次写：走的是既有对账路径
    const again = await advanceMemoryRuntime(deps, { memory_run_id: started.memory_run_id, now: LATER })
    expect(again.status).toBe('blocked')
    expect(writeCalls.length).toBe(1)
  })
})
