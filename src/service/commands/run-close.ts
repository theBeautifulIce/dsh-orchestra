// src/service/commands/run-close.ts —— 运行终态收口（规格 4.8 行 403）
import type { Tx } from '../../infra/sqlite/driver.ts'
import { appendEvent, chainBreakOf, readChain } from '../../infra/db/ledger.ts'
import { UNVERIFIED_EFFECT } from '../../infra/db/unverified-effects.ts'
import { assertRunCanTerminal, refreshRunSettling } from './parallel.ts'

export type RunTerminal = 'succeeded' | 'succeeded_with_unverified' | 'failed' | 'failed_with_unverified' | 'orphaned' | 'cancelled'

const RUN_TERMINAL: readonly RunTerminal[] = ['succeeded', 'succeeded_with_unverified', 'failed', 'failed_with_unverified', 'orphaned', 'cancelled']

type NodeRow = {
  node_run_id: string
  status: string
  unverified: number
  replacement_node_run_id: string | null
}

/**
 * 一轮执行结束后收口 run：
 * - 先按账本重算 settling / pending，再检查未终态节点、活跃 decision 与子 run；
 * - 业务结果优先级严格按 §4.8：失败/超时 > 未替换 orphaned > 未验证副作用 > succeeded；
 * - `cancelled` 只表示“停止意图已生效”，不代表副作用都已核实：
 *   run.terminal 事件同时写 outcome（业务结果，忽略取消意图）与 failed/unverified 节点清单，
 *   调用方判定业务成败要看 outcome，不能只看 runs.status。
 * - 已有终态或条件未满足时返回 null，不写半截。
 */
export function closeRun(tx: Tx, secret: string, runId: string, now: string): RunTerminal | null {
  const run = tx.get<{ status: string; cancel_requested_at: string | null; cancel_result: string | null }>(
    'SELECT status, cancel_requested_at, cancel_result FROM runs WHERE run_id = ?',
    [runId],
  )
  if (!run || RUN_TERMINAL.includes(run.status as RunTerminal) || run.status === 'paused') {
    return null
  }
  refreshRunSettling(tx, runId, now)
  const nodes = tx.all<NodeRow>(
    `SELECT node_run_id, status, replacement_node_run_id, (${UNVERIFIED_EFFECT}) AS unverified FROM node_runs n WHERE run_id = ?`,
    [runId],
  )
  const terminal = new Set(['done', 'failed', 'timeout', 'abandoned_unverified', 'failed_with_unverified', 'orphaned', 'superseded'])
  if (nodes.length === 0 || nodes.some((node) => !terminal.has(node.status))) return null
  const openDecisions = tx.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM decisions WHERE node_run_id IN (SELECT node_run_id FROM node_runs WHERE run_id = ?) AND status IN ('pending','acknowledged','blocked_for_human')",
    [runId],
  )
  if (Number(openDecisions?.n ?? 0) > 0) return null
  try {
    assertRunCanTerminal(tx, runId)
  } catch {
    return null
  }
  // 断链闸门：run 里只要有一个节点的链断了，就不按它的状态收口。
  // 放在所有早退之后：只有真要收口时才做整链校验，不给每轮扫描加固定开销（S3 r19 P1-1）
  for (const node of nodes) {
    if (chainBreakOf(secret, readChain(tx, node.node_run_id))) return null
  }

  const unverified = (node: NodeRow) => node.unverified === 1
  const failed = nodes.some((node) => ['failed', 'timeout', 'failed_with_unverified'].includes(node.status))
  const orphaned = nodes.some((node) => node.status === 'orphaned' && !node.replacement_node_run_id)
  const hasUnverified = nodes.some(unverified)
  // 业务结果：不看取消意图，只按节点事实算，供调用方与面板区分“停了”和“成了/败了”
  const outcome: RunTerminal = failed
    ? (nodes.some((node) => node.status === 'failed_with_unverified') || hasUnverified ? 'failed_with_unverified' : 'failed')
    : orphaned ? 'orphaned'
      : hasUnverified ? 'succeeded_with_unverified'
        : 'succeeded'
  const terminalStatus: RunTerminal = run.cancel_requested_at ? 'cancelled' : outcome

  const res = tx.run(
    "UPDATE runs SET status = ?, ended_at = ?, revision = revision + 1, updated_at = ? WHERE run_id = ? AND status NOT IN ('succeeded','succeeded_with_unverified','failed','failed_with_unverified','orphaned','cancelled')",
    [terminalStatus, now, now, runId],
  )
  if (res.changes !== 1) return null
  // cancelled 只说明“按要求停了”，不说明副作用都已核实：
  // 把失败与未核实节点一并写进终态事件，调用方不必再去翻节点账本才能发现风险。
  appendEvent(tx, {
    type: 'run.terminal',
    runId,
    payload: {
      status: terminalStatus,
      // cancelled 下的真实业务结果：这是唯一能区分“取消时已经失败了”的字段
      outcome,
      cancel_result: run.cancel_result,
      cancel_requested: run.cancel_requested_at !== null,
      failed_nodes: nodes.filter((node) => ['failed', 'timeout', 'failed_with_unverified'].includes(node.status)).map((node) => node.node_run_id),
      unverified_nodes: nodes.filter(unverified).map((node) => node.node_run_id),
      orphaned_nodes: nodes.filter((node) => node.status === 'orphaned' && !node.replacement_node_run_id).map((node) => node.node_run_id),
      superseded_nodes: nodes.filter((node) => node.status === 'superseded').map((node) => node.node_run_id),
    },
  })
  return terminalStatus
}
