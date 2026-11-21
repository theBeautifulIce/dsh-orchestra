// 执行调度器单测：配置里的 concurrency 与 human_slots 真正限制同时执行的任务数（评审 P1）
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { SystemClock } from '../../src/core/clock.ts'
import { parseConfig } from '../../src/core/config.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { openDb } from '../../src/infra/sqlite/driver.ts'
import { dispatchRun, type DispatchDeps } from '../../src/service/dispatcher.ts'
import { definitionHashOf, WorkflowCatalog } from '../../src/service/workflows.ts'
import {
  createExecutionScheduler,
  createExecutionSchedulerFromConfig,
  DEFAULT_EXECUTION_CONCURRENCY,
  DEFAULT_HUMAN_SLOTS,
  DEFAULT_MAX_WAITING,
  runThroughScheduler,
} from '../../src/service/execution-scheduler.ts'

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

const CONFIG_SAMPLE = {
  phase: 'S2',
  service: { db_path: 'storages/dsh-orchestra/orchestra.db', busy_timeout_ms: 5000 },
  execution: {
    concurrency: 3, human_slots: 1, startup_timeout_ms: 60000, unknown_watchdog_ms: 120000,
    verify_timeout_ms: 120000, lease_ttl_ms: 30000, lease_renew_interval_ms: 10000,
    action_timeout_ms: 120000, cancel_grace_ms: 30000,
  },
  bridge: { buffer_high_water_bytes: 4194304, buffer_limit_bytes: 8388608, spill_dir: 'storages/dsh-orchestra/bridge-spill' },
  retention: { receipt_days: 7, in_flight_timeout_minutes: 10 },
  memory: { bridge_id: 'local', eval_timeout_ms: 30000, judge_content_limit: 20000, approval_ttl_hours: 24 },
}

describe('执行调度器', () => {
  it('returns a cancelled workflow wait slot immediately and leaves newer attempts alone', async () => {
    const scheduler = createExecutionScheduler({ concurrency: 2, maxWaiting: 1 })
    scheduler.configureWorkflowLimits(() => ({ runLimit: 1, nodeLimit: null }))
    const workflowScope = { runId: 'r', workflowId: 'w', nodeId: 'review' }
    const gate = Promise.withResolvers<void>()
    const first = scheduler.run(() => gate.promise, { workflowScope })
    try {
      const blocked = scheduler.run(() => { throw new Error('cancelled body ran') },
        { nodeRunId: 'n', attempt: 2, workflowScope })
      scheduler.cancelWaiting?.('n', 1)
      expect(scheduler.waiting).toBe(1)
      scheduler.cancelWaiting?.('n', 2)
      await expect(blocked).rejects.toThrow('已取消排队')
      expect(scheduler.waiting).toBe(0)
      const next = scheduler.run(() => 'ok', { workflowScope })
      gate.resolve()
      await expect(next).resolves.toBe('ok')
    } finally { gate.resolve(); await first; await scheduler.close() }
  })
  it('同时执行的任务数真的受 concurrency 限制', async () => {
    const sched = createExecutionScheduler({ concurrency: 2 })
    let active = 0
    let maxActive = 0
    const tasks = Array.from({ length: 5 }, (_, i) => sched.run(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(5)
      active -= 1
      return i
    }))
    const results = await Promise.all(tasks)
    expect(results).toEqual([0, 1, 2, 3, 4])
    expect(maxActive).toBe(2)
    expect(sched.inFlight).toBe(0)
    expect(sched.waiting).toBe(0)
  })

  it('排队等名额：先进先出，谁先到谁先跑', async () => {
    const sched = createExecutionScheduler({ concurrency: 1 })
    const order: number[] = []
    const tasks = [0, 1, 2, 3].map((i) => sched.run(async () => {
      order.push(i)
      await delay(2)
      return i
    }))
    await Promise.all(tasks)
    expect(order).toEqual([0, 1, 2, 3])
  })

  it('任务抛错也释放名额：后面的任务照跑', async () => {
    const sched = createExecutionScheduler({ concurrency: 1 })
    await expect(sched.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(sched.inFlight).toBe(0)
    const good = await sched.run(async () => 'ok')
    expect(good).toBe('ok')
    expect(sched.inFlight).toBe(0)
  })

  it('在跑与排队的数量可观测', async () => {
    const sched = createExecutionScheduler({ concurrency: 1 })
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const first = sched.run(() => gate)
    expect(sched.inFlight).toBe(1)
    expect(sched.waiting).toBe(0)
    const second = sched.run(async () => 'second')
    // 名额只有一个：第二笔在排队
    expect(sched.inFlight).toBe(1)
    expect(sched.waiting).toBe(1)
    release()
    await first
    await second
    expect(sched.inFlight).toBe(0)
    expect(sched.waiting).toBe(0)
  })

  it('人工名额单独限：占人工名额的任务同时最多 human_slots 个', async () => {
    const sched = createExecutionScheduler({ concurrency: 3, humanSlots: 1 })
    let humanActive = 0
    let maxHuman = 0
    const human = (i: number) => sched.run(async () => {
      humanActive += 1
      maxHuman = Math.max(maxHuman, humanActive)
      await delay(5)
      humanActive -= 1
      return i
    }, { human: true })
    await Promise.all([human(0), human(1), human(2)])
    expect(maxHuman).toBe(1)
    expect(sched.inFlight).toBe(0)
  })

  it('人工名额满了也不许把普通任务堵死', async () => {
    const sched = createExecutionScheduler({ concurrency: 2, humanSlots: 1 })
    let normalStarted = false
    const humanTask = sched.run(async () => {
      await delay(10)
      return 'human'
    }, { human: true })
    const normalTask = sched.run(async () => {
      normalStarted = true
      return 'normal'
    })
    await Promise.all([humanTask, normalTask])
    expect(normalStarted).toBe(true)
  })

  it('排队上限满了直接拒：SERVICE_UNAVAILABLE', async () => {
    const sched = createExecutionScheduler({ concurrency: 1, maxWaiting: 1 })
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const first = sched.run(() => gate)
    const second = sched.run(async () => 'second')
    await expect(sched.run(async () => 'third')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    release()
    await first
    await second
  })

  it('热缩容保留在跑和已排队节点，提高并发后立即补位', async () => {
    const scheduler = createExecutionScheduler({ concurrency: 2, maxWaiting: 3 })
    const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>())
    const started: number[] = []
    const jobs = gates.map((gate, index) => scheduler.run(() => {
      started.push(index)
      return gate.promise
    }))
    scheduler.setCapacity({ concurrency: 1, maxWaiting: 1 })
    expect(scheduler.stats()).toMatchObject({ inFlight: 2, waiting: 2, concurrency: 1, maxWaiting: 1 })
    await expect(scheduler.run(() => { throw new Error('queue full') })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    gates[0]!.resolve()
    await jobs[0]
    expect(started).toEqual([0, 1])
    gates[1]!.resolve()
    await jobs[1]
    expect(started).toEqual([0, 1, 2])
    scheduler.setCapacity({ concurrency: 2, maxWaiting: 1 })
    expect(started).toEqual([0, 1, 2, 3])
    for (const gate of gates) gate.resolve()
    await Promise.all(jobs)
    await scheduler.close()
  })

  it('三个名额原子检查，在队列满时也允许可直接开跑的分组通过', async () => {
    const scheduler = createExecutionScheduler({ concurrency: 3, maxWaiting: 2 })
    scheduler.configureWorkflowLimits(() => ({ runLimit: 1, nodeLimit: 1 }))
    const gates = Array.from({ length: 5 }, () => Promise.withResolvers<void>())
    const started: number[] = []
    const submit = (index: number, runId: string, workflowId: string, nodeId: string) => scheduler.run(() => {
      started.push(index)
      return gates[index]!.promise
    }, { nodeRunId: String(index), workflowScope: { runId, workflowId, nodeId } })
    const active = submit(0, 'r1', 'wf1', 'x')
    const byRun = submit(1, 'r1', 'wf1', 'y')
    const byNode = submit(2, 'r2', 'wf1', 'x')
    expect(scheduler.isWaiting?.('1')).toBe(true)
    expect(scheduler.isWaiting?.('2')).toBe(true)
    const sameNodeInOtherWorkflow = submit(3, 'r3', 'wf2', 'x')
    const sameWorkflowDifferentNode = submit(4, 'r2', 'wf1', 'z')
    expect(started).toEqual([0, 3, 4])
    await expect(scheduler.run(() => { throw new Error('queue full') })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    const releasedOnFailure = expect(sameNodeInOtherWorkflow).rejects.toThrow('test failure')
    gates[3]!.reject(new Error('test failure'))
    await releasedOnFailure
    expect(started).toEqual([0, 3, 4])
    scheduler.configureWorkflowLimits(() => ({ runLimit: 2, nodeLimit: 2 }))
    expect(started).toEqual([0, 3, 4, 1])
    gates[4]!.resolve()
    await sameWorkflowDifferentNode
    expect(started).toEqual([0, 3, 4, 1, 2])
    for (const gate of gates) gate.resolve()
    await Promise.all([active, byRun, byNode])
    await scheduler.close()
  })

  it('启用分组收紧时会计入已开始的节点，释放到新限额以下才补位', async () => {
    const scheduler = createExecutionScheduler({ concurrency: 3 })
    const scope = { workflowScope: { runId: 'r1', workflowId: 'wf', nodeId: 'x' } }
    const firstGate = Promise.withResolvers<void>()
    const secondGate = Promise.withResolvers<void>()
    const first = scheduler.run(() => firstGate.promise, scope)
    const second = scheduler.run(() => secondGate.promise, scope)
    scheduler.configureWorkflowLimits(() => ({ runLimit: 1, nodeLimit: 1 }))
    const third = scheduler.run(() => 'accepted', scope)
    expect(scheduler.stats()).toMatchObject({ inFlight: 2, waiting: 1 })
    firstGate.resolve()
    await first
    expect(scheduler.stats()).toMatchObject({ inFlight: 1, waiting: 1 })
    secondGate.resolve()
    await second
    await expect(third).resolves.toBe('accepted')
    await scheduler.close()
  })

  it('缺省值与配置定值一致：并发 3、人工名额 1、排队上限有界', () => {
    const sched = createExecutionScheduler()
    expect(sched.concurrency).toBe(DEFAULT_EXECUTION_CONCURRENCY)
    expect(sched.humanSlots).toBe(DEFAULT_HUMAN_SLOTS)
    expect(DEFAULT_EXECUTION_CONCURRENCY).toBe(3)
    expect(DEFAULT_HUMAN_SLOTS).toBe(1)
    expect(DEFAULT_MAX_WAITING).toBe(1000)
    expect(sched.stats().maxWaiting).toBe(DEFAULT_MAX_WAITING)
  })

  it('配置里的 execution.concurrency、human_slots 与 max_waiting 真的接到调度上', () => {
    const cfg = parseConfig(CONFIG_SAMPLE)
    const sched = createExecutionSchedulerFromConfig(cfg)
    expect(sched.concurrency).toBe(cfg.execution.concurrency)
    expect(sched.humanSlots).toBe(cfg.execution.human_slots)
    expect(sched.stats().maxWaiting).toBe(DEFAULT_MAX_WAITING)
    expect(sched.stats()).toMatchObject({ inFlight: 0, waiting: 0, concurrency: 3, humanSlots: 1 })
    const tight = parseConfig({ ...CONFIG_SAMPLE, execution: { ...CONFIG_SAMPLE.execution, max_waiting: 7 } })
    expect(createExecutionSchedulerFromConfig(tight).stats().maxWaiting).toBe(7)
  })

  it('直接传非法 max_waiting 在装配期拒绝', () => {
    expect(() => createExecutionScheduler({ maxWaiting: 0 })).toThrow(/执行调度的参数不合法/)
    expect(() => createExecutionScheduler({ maxWaiting: -1 })).toThrow(/执行调度的参数不合法/)
    expect(() => createExecutionScheduler({ maxWaiting: 1.5 })).toThrow(/执行调度的参数不合法/)
  })

  it('close({drain:true}) 停收新任务，但把已在排队的任务跑完', async () => {
    const sched = createExecutionScheduler({ concurrency: 1 })
    const order: number[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const first = sched.run(async () => { order.push(1); await gate })
    const second = sched.run(async () => { order.push(2) })
    const closing = sched.close({ drain: true })
    await expect(sched.run(async () => 'late')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(sched.waiting).toBe(1)
    release()
    await Promise.all([first, second])
    await closing
    expect(order).toEqual([1, 2])
    expect(sched.inFlight).toBe(0)
    expect(sched.waiting).toBe(0)
  })

  it('close({drain:false}) 立即拒掉排队任务，在跑任务收尾后关闭', async () => {
    const sched = createExecutionScheduler({ concurrency: 1 })
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const first = sched.run(() => gate)
    const waiting = sched.run(async () => 'waiting')
    const closing = sched.close({ drain: false })
    await expect(waiting).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(sched.waiting).toBe(0)
    release()
    await first
    await closing
    expect(sched.inFlight).toBe(0)
  })

  it('参数不合法在装配期就拒掉', () => {
    expect(() => createExecutionScheduler({ concurrency: 0 })).toThrowError(/执行调度的参数不合法/)
    expect(() => createExecutionScheduler({ humanSlots: 0 })).toThrowError(/执行调度的参数不合法/)
  })
})

describe('dispatcher 与调度器接线', () => {
  it.each(['容量恢复', '取消', '关停', '拒绝结算时关停'])('队列满时拒绝的后继在后续派发周期处理：%s', async (scenario) => {
    const scheduler = createExecutionScheduler({ concurrency: 2, maxWaiting: 1 })
    const db = openDb(':memory:')
    const abort = new AbortController()
    const ticks = new EventTarget()
    const predecessor = Promise.withResolvers<void>()
    const long = Promise.withResolvers<void>()
    const independent = Promise.withResolvers<void>()
    const extraFinished = Promise.withResolvers<void>()
    const rejectDuringShutdown = scenario === '拒绝结算时关停'
    const now = '2026-11-20T00:00:00.000Z'
    const nodeIds = ['predecessor', 'long', 'independent', 'successor']
    const definition = {
      workflow_id: 'flow', workflow_version: '1',
      nodes: nodeIds.map((node_id) => ({ node_id, type: 'agent' as const })),
      edges: [{ from: 'predecessor', to: 'successor' }],
    }
    const catalog = new WorkflowCatalog('S6')
    catalog.load(definition)
    applySteps(db, loadSteps(defaultMigrationsDir()))
    db.raw.prepare("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','容量回归','running',?,?)").run(now, now)
    db.raw.prepare(`INSERT INTO runs(run_id,task_id,workflow_id,workflow_version,workflow_definition_hash,status,created_at,updated_at)
      VALUES('r','t','flow',1,?,'running',?,?)`).run(definitionHashOf(definition), now, now)
    for (const [seq, id] of nodeIds.entries()) {
      const status = rejectDuringShutdown && id !== 'successor' ? 'done' : 'queued'
      db.raw.prepare(`INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,created_at,updated_at)
        VALUES(?,'r',?,?,'agent',?,?,?)`).run(id, id, seq, status, now, now)
    }
    const otherRunJobs = rejectDuringShutdown
      ? Array.from({ length: 3 }, () => scheduler.run(() => independent.promise))
      : []
    const nodes = Object.fromEntries(nodeIds.map((id) => [id, { tools: [] }]))
    const writeStatus = db.raw.prepare('UPDATE node_runs SET status=? WHERE node_run_id=?')
    const submitted: string[] = []
    const started: string[] = []
    const runtime = { db, catalog, secret: 'test', phase: 'S6' as const, clock: new SystemClock('test') }
    const dispatch = dispatchRun({ ...runtime, runtime, executeNode: async ({ nodeRunId }) => {
      submitted.push(nodeRunId)
      const job = scheduler.run(async () => {
        started.push(nodeRunId)
        writeStatus.run('started', nodeRunId)
        if (nodeRunId === 'predecessor') await predecessor.promise
        if (nodeRunId === 'long') await long.promise
        if (nodeRunId === 'independent') {
          // The freed slot admitted this branch. A job from another run fills the freed queue entry.
          void scheduler.run(() => {}).then(extraFinished.resolve, extraFinished.reject)
          await independent.promise
        }
        writeStatus.run('done', nodeRunId)
        return { node_run_id: nodeRunId, final_status: 'done', evidence: null, agent_id: nodeRunId }
      })
      if (rejectDuringShutdown) abort.abort()
      return job
    } }, { runId: 'r', nodes, now }, { signal: abort.signal, ticks, now: () => now, resolve: async () => nodes })

    try {
      if (rejectDuringShutdown) {
        // The abort wakes the pump before the rejection has settled. No normal tick will follow.
        await expect(Promise.race([dispatch.then(() => true), setImmediate(false)])).resolves.toBe(true)
        expect(submitted).toEqual(['successor'])
        expect(started).toEqual([])
        return
      }
      predecessor.resolve()
      await setImmediate()
      expect(scheduler.stats()).toMatchObject({ inFlight: 2, waiting: 1 })
      expect(submitted).toEqual(nodeIds)
      expect(started).toEqual(nodeIds.slice(0, 3))
      if (scenario === '取消') db.raw.prepare("UPDATE runs SET cancel_requested_at=? WHERE run_id='r'").run(now)
      if (scenario === '关停') abort.abort()
      independent.resolve()
      await extraFinished.promise
      ticks.dispatchEvent(new Event('tick'))
      await setImmediate()
      const readStatus = db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id=?')
      expect(readStatus.get('long')).toMatchObject({ status: 'started' })
      if (scenario === '容量恢复') {
        expect(submitted).toEqual([...nodeIds, 'successor'])
        expect(started).toEqual(nodeIds)
        expect(readStatus.get('successor')).toMatchObject({ status: 'done' })
      } else {
        expect(submitted).toEqual(nodeIds)
        expect(started).toEqual(nodeIds.slice(0, 3))
        expect(readStatus.get('successor')).toMatchObject({ status: 'queued' })
      }
    } finally {
      abort.abort()
      ticks.dispatchEvent(new Event('tick'))
      predecessor.resolve()
      independent.resolve()
      long.resolve()
      try { await dispatch; await Promise.all(otherRunJobs) } finally { await scheduler.close(); db.raw.close() }
    }
  })

  it('不显式传调度器时，兜底闸仍把并发压到默认上限', async () => {
    let active = 0
    let maxActive = 0
    const tasks = Array.from({ length: DEFAULT_EXECUTION_CONCURRENCY + 3 }, () =>
      runThroughScheduler(undefined, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
      }),
    )
    await Promise.all(tasks)
    expect(maxActive).toBe(DEFAULT_EXECUTION_CONCURRENCY)
  })

  it('dispatcher 只调注入的已调度执行函数，自己不再排一次队', async () => {
    const db = openDb(':memory:')
    applySteps(db, loadSteps(defaultMigrationsDir()))
    const now = '2026-11-14T00:00:00.000Z'
    const secret = 'unit-dispatch-scheduler'
    const catalog = new WorkflowCatalog('S2')
    const runtime = { db, secret, catalog, phase: 'S2' as const, clock: new SystemClock('unit-boot') }
    const nodeIds = ['check-one', 'check-two']
    db.raw.prepare("INSERT INTO tasks (task_id,title,status,created_at,updated_at) VALUES ('task','Check','running',?,?)").run(now, now)
    db.raw.prepare("INSERT INTO runs (run_id,task_id,status,created_at,updated_at) VALUES ('run1','task','running',?,?)").run(now, now)
    const insert = db.raw.prepare("INSERT INTO node_runs (node_run_id,run_id,node_id,seq,node_type,status,side_effect_policy,created_at,updated_at)"
      + " VALUES (?,'run1',?,?,'agent','queued','pure',?,?)")
    for (const [seq, id] of nodeIds.entries()) insert.run(id, id, seq + 1, now, now)
    const base = createExecutionScheduler({ concurrency: 2 })
    const calls: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const executeNode: DispatchDeps['executeNode'] = ({ nodeRunId }) => runThroughScheduler(base, async () => {
      calls.push(nodeRunId)
      maxInFlight = Math.max(maxInFlight, ++inFlight)
      await delay(5)
      inFlight -= 1
      throw Object.assign(new Error('执行器无法启动测试节点'), { code: 'NOT_FOUND' })
    })
    try {
      const nodes = Object.fromEntries(nodeIds.map(id => [id, { tools: [] }]))
      const outcome = await dispatchRun({ db, secret, runtime, executeNode }, { runId: 'run1', nodes, now })
      expect(calls).toEqual(nodeIds)
      expect(maxInFlight).toBe(2)
      expect(outcome).toMatchObject(nodeIds.map(id => ({ node_run_id: id, status: 'failed', error_code: 'NOT_FOUND' })))
    } finally {
      await base.close()
      db.raw.close()
    }
  })
})
