// src/service/dispatcher.ts —— 主脑派发：把 run 下排队的节点交给生产执行器（审计 F-01）
// 评审 P1：agent 执行是长时间任务，不许占着写队列的名额；并发闸交给 ExecutionScheduler。
// 同一 run 的多个节点各占一个并发名额，名额总数由配置 execution.concurrency 定。
import { DEFAULT_LEASE_TTL_MS, runNode, type RunNodeDeps } from '../executor/run-node.ts'
import type { ExecutionScheduler } from './execution-scheduler.ts'

export type NodeSpec = {
  tools: { command: string; args: string[]; cwd: string; timeoutMs: number }[]
  input?: unknown
  outputSchema?: unknown
}

export type DispatchParams = {
  runId: string
  // 按 node_id 给每个节点要跑的工具与策略；没给的节点这一轮跳过
  nodes: Record<string, NodeSpec>
  now: string
  ownerEpoch?: number
  leaseTtlMs?: number
  leaseRenewIntervalMs?: number
}

export type DispatchOutcome = {
  node_run_id: string
  node_id: string
  status: 'done' | 'failed' | 'skipped'
  reason?: string
  error_code?: string
  agent_id?: string
  evidence_source?: string
}

// 派发依赖 = 执行器那套 + 可选的并发闸
export type DispatchDeps = RunNodeDeps & {
  // 并发闸：长任务在这里排队等名额，不占写队列的位置
  // 没装配时直接跑，老装配不受影响
  scheduler?: ExecutionScheduler
}

// 只派发排队中的节点：一个节点失败不拖垮同批别的节点
export async function dispatchRun(deps: DispatchDeps, p: DispatchParams): Promise<DispatchOutcome[]> {
  const rows = deps.db.raw.prepare(
    "SELECT node_run_id, node_id, seq, attempt FROM node_runs WHERE run_id = ? AND status = 'queued' ORDER BY seq ASC",
  ).all(p.runId) as { node_run_id: string; node_id: string; seq: number; attempt: number }[]
  // 没装调度器时按原来的次序一个一个跑：并发上限归调度器说了算，没有闸就不自己放并发
  if (!deps.scheduler) {
    const outcomes: DispatchOutcome[] = []
    for (const row of rows) outcomes.push(await dispatchOne(deps, p, row))
    return outcomes
  }
  // 装了调度器：同一 run 的节点一起排，谁先拿到名额谁先跑，并发总数受调度器限制
  // 结果按 seq 顺序返回，调用方看到的次序不受谁先跑完影响
  return await Promise.all(rows.map((row) => dispatchOne(deps, p, row)))
}

async function dispatchOne(
  deps: DispatchDeps,
  p: DispatchParams,
  row: { node_run_id: string; node_id: string; seq: number; attempt: number },
): Promise<DispatchOutcome> {
  const spec = p.nodes[row.node_id]
  if (!spec) {
    return { node_run_id: row.node_run_id, node_id: row.node_id, status: 'skipped', reason: 'no_node_spec' }
  }
  // 一个节点失败不拖垮同批别的节点：异常在这里收成一条 failed 结果
  const execute = async (): Promise<DispatchOutcome> => {
    try {
      const res = await runNode(deps, {
        nodeRunId: row.node_run_id,
        nodeId: row.node_id,
        attempt: Number(row.attempt),
        input: spec.input ?? {},
        outputSchema: spec.outputSchema ?? {},
        tools: spec.tools,
        now: p.now,
        ownerEpoch: p.ownerEpoch ?? deps.db.epoch,
        leaseTtlMs: p.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
        leaseRenewIntervalMs: p.leaseRenewIntervalMs,
      })
      return {
        node_run_id: row.node_run_id,
        node_id: row.node_id,
        status: res.final_status === 'done' ? 'done' : 'failed',
        reason: res.final_status === 'done' ? undefined : 'final_status_' + res.final_status,
        agent_id: res.agent_id,
        evidence_source: res.evidence?.source,
      }
    } catch (err) {
      return {
        node_run_id: row.node_run_id,
        node_id: row.node_id,
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
        error_code: (err as { code?: string }).code ?? '',
      }
    }
  }
  // 有并发闸就排队等名额；没有闸就直接跑
  if (!deps.scheduler) return await execute()
  return await deps.scheduler.run(execute, { label: row.node_id })
}