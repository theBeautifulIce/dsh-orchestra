// 执行调度器单测：配置里的 concurrency 与 human_slots 真正限制同时执行的任务数（评审 P1）
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../../src/core/config.ts'
import { dispatchRun, type DispatchDeps } from '../../src/service/dispatcher.ts'
import type { Db } from '../../src/infra/sqlite/driver.ts'
import {
  createExecutionScheduler,
  createExecutionSchedulerFromConfig,
  DEFAULT_EXECUTION_CONCURRENCY,
  DEFAULT_HUMAN_SLOTS,
  DEFAULT_MAX_WAITING,
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
  it('dispatcher 只调注入的已调度执行函数，自己不再排一次队', async () => {
    const rows = [
      { node_run_id: 'nr1', node_id: 'check', seq: 1, attempt: 1 },
      { node_run_id: 'nr2', node_id: 'check', seq: 2, attempt: 1 },
    ]
    // 只假造 dispatcher 用到的那一次查表
    const fakeDb = {
      raw: { prepare: () => ({ all: () => rows, get: () => undefined }), exec: () => {} },
      epoch: 0,
    } as unknown as Db
    const base = createExecutionScheduler({ concurrency: 2 })
    let calls = 0
    let inFlight = 0
    let maxInFlight = 0
    const executeNode = async () => {
      calls += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      throw Object.assign(new Error('节点不存在'), { code: 'NOT_FOUND' })
    }
    const outcome = await dispatchRun(
      { db: fakeDb, executeNode } as unknown as DispatchDeps,
      { runId: 'run1', nodes: { check: { tools: [] } }, now: '2026-11-14T00:00:00.000Z' },
    )
    // 两个节点各执行一次，没有因为 dispatcher 自己再包一层而翻倍
    expect(calls).toBe(2)
    for (const row of outcome) {
      expect(row.status).toBe('failed')
      expect(row.error_code).toBe('NOT_FOUND')
    }
  })
})