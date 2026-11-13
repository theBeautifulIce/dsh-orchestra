// src/service/dispatcher.ts —— 主脑派发：把 run 下排队的节点交给生产执行器（审计 F-01）
import { runNode, type RunNodeDeps } from '../executor/run-node.ts'
import type { ToolPolicy } from '../executor/session.ts'

export type NodeSpec = {
  toolPolicy: ToolPolicy
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

// 只派发排队中的节点：一个节点失败不拖垮同批别的节点
export async function dispatchRun(deps: RunNodeDeps, p: DispatchParams): Promise<DispatchOutcome[]> {
  const rows = deps.db.raw.prepare(
    "SELECT node_run_id, node_id, seq, attempt FROM node_runs WHERE run_id = ? AND status = 'queued' ORDER BY seq ASC",
  ).all(p.runId) as { node_run_id: string; node_id: string; seq: number; attempt: number }[]
  const outcomes: DispatchOutcome[] = []
  for (const row of rows) {
    const spec = p.nodes[row.node_id]
    if (!spec) {
      outcomes.push({ node_run_id: row.node_run_id, node_id: row.node_id, status: 'skipped', reason: 'no_node_spec' })
      continue
    }
    try {
      const res = await runNode(deps, {
        nodeRunId: row.node_run_id,
        nodeId: row.node_id,
        attempt: Number(row.attempt),
        input: spec.input ?? {},
        outputSchema: spec.outputSchema ?? {},
        toolPolicy: spec.toolPolicy,
        tools: spec.tools,
        now: p.now,
        ownerEpoch: p.ownerEpoch ?? deps.db.epoch,
        leaseTtlMs: p.leaseTtlMs ?? 600000,
      })
      outcomes.push({
        node_run_id: row.node_run_id,
        node_id: row.node_id,
        status: res.final_status === 'done' ? 'done' : 'failed',
        reason: res.final_status === 'done' ? undefined : 'final_status_' + res.final_status,
        agent_id: res.agent_id,
        evidence_source: res.evidence?.source,
      })
    } catch (err) {
      outcomes.push({
        node_run_id: row.node_run_id,
        node_id: row.node_id,
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
        error_code: (err as { code?: string }).code ?? '',
      })
    }
  }
  return outcomes
}
