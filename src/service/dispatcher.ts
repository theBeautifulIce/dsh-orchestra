// src/service/dispatcher.ts —— 主脑派发：把 run 下排队的节点交给生产执行器（审计 F-01）
// 评审 P1：agent 执行是长时间任务，不许占着写队列的名额；并发闸由装配层统一注入。
// 调度器不再由 dispatcher 自己持有：否则 /v1/node-runs/run 与 /v1/runs/dispatch 各走一套，
// 或者同一次 runNode 被调度两次、重复占用名额（S2 第三十七轮 P0-01）。
import { DEFAULT_LEASE_TTL_MS, runNode, type RunNodeDeps, type RunNodeParams, type RunNodeResult } from '../executor/run-node.ts'
import { inTx } from '../infra/db/tx.ts'
import { closeRun } from './commands/run-close.ts'

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

// 派发依赖 = 执行器那套 + 装配层注入的「已经过调度」的执行函数。
// 注入后 dispatcher 不再自己调 scheduler：一次节点执行只占一个名额。
export type DispatchDeps = RunNodeDeps & {
  executeNode?: (p: RunNodeParams) => Promise<RunNodeResult>
  // 生产装配从配置读出的执行时限；缺省时由 runNode 使用默认值。
  executionLimits?: Pick<RunNodeParams, 'actionTimeoutMs' | 'startupTimeoutMs' | 'verifyTimeoutMs'>
}

// 只派发排队中的节点：一个节点失败不拖垮同批别的节点
export async function dispatchRun(deps: DispatchDeps, p: DispatchParams): Promise<DispatchOutcome[]> {
  const rows = deps.db.raw.prepare(
    "SELECT node_run_id, node_id, seq, attempt FROM node_runs WHERE run_id = ? AND status = 'queued' ORDER BY seq ASC",
  ).all(p.runId) as { node_run_id: string; node_id: string; seq: number; attempt: number }[]
  // 装配层给了执行函数，它已经带并发闸：同批节点可以一起排，谁先拿到名额谁先跑。
  // 没给执行函数（老装配/单测）时保持原来的串行次序，不凭空放并发。
  const outcomes = deps.executeNode
    ? await Promise.all(rows.map((row) => dispatchOne(deps, p, row)))
    : await (async () => {
        const out: DispatchOutcome[] = []
        for (const row of rows) out.push(await dispatchOne(deps, p, row))
        return out
      })()
  // 这一轮跑完后收口 run：所有子节点都已终态才写，未满足条件保持原状。
  inTx(deps.db, (tx) => { closeRun(tx, p.runId, p.now) })
  return outcomes
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
  try {
    const params: RunNodeParams = {
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
      ...deps.executionLimits,
    }
    const res = deps.executeNode
      ? await deps.executeNode(params)
      : await runNode(deps, params)
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
