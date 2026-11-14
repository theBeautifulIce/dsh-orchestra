// src/service/commands/run-close.ts —— 运行终态收口（规格 4.8 行 403）
import type { Tx } from '../../infra/sqlite/driver.ts'
import { appendEvent } from '../../infra/db/ledger.ts'
import { assertRunCanTerminal, refreshRunSettling } from './parallel.ts'

export type RunTerminal = 'succeeded' | 'succeeded_with_unverified' | 'failed' | 'failed_with_unverified' | 'orphaned'

type NodeRow = {
  node_run_id: string
  status: string
  side_effect_policy: string
  side_effect_verified_none: number
  stop_evidence: string | null
  replacement_node_run_id: string | null
}

/**
 * 一轮执行结束后收口 run：
 * - 先按账本重算 settling / pending，再检查未终态节点、活跃 decision 与子 run；
 * - 终态优先级严格按 §4.8：失败/超时 > 未替换 orphaned > 未验证副作用 > succeeded。
 * - 已有终态或条件未满足时返回 null，不写半截。
 */
export function closeRun(tx: Tx, runId: string, now: string): RunTerminal | null {
  const run = tx.get<{ status: string }>('SELECT status FROM runs WHERE run_id = ?', [runId])
  if (!run || ['succeeded', 'succeeded_with_unverified', 'failed', 'failed_with_unverified', 'orphaned', 'paused'].includes(run.status)) {
    return null
  }
  refreshRunSettling(tx, runId, now)
  const nodes = tx.all<NodeRow>(
    'SELECT node_run_id, status, side_effect_policy, side_effect_verified_none, stop_evidence, replacement_node_run_id FROM node_runs WHERE run_id = ?',
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

  const unverified = (node: NodeRow) => node.side_effect_policy !== 'pure' && node.side_effect_verified_none !== 1 && !node.stop_evidence
  const failed = nodes.some((node) => ['failed', 'timeout', 'failed_with_unverified'].includes(node.status))
  const orphaned = nodes.some((node) => node.status === 'orphaned' && !node.replacement_node_run_id)
  const hasUnverified = nodes.some(unverified)
  let terminalStatus: RunTerminal
  if (failed) terminalStatus = nodes.some((node) => node.status === 'failed_with_unverified') || hasUnverified ? 'failed_with_unverified' : 'failed'
  else if (orphaned) terminalStatus = 'orphaned'
  else if (hasUnverified) terminalStatus = 'succeeded_with_unverified'
  else terminalStatus = 'succeeded'

  const res = tx.run(
    "UPDATE runs SET status = ?, ended_at = ?, revision = revision + 1, updated_at = ? WHERE run_id = ? AND status NOT IN ('succeeded','succeeded_with_unverified','failed','failed_with_unverified','orphaned')",
    [terminalStatus, now, now, runId],
  )
  if (res.changes !== 1) return null
  appendEvent(tx, { type: 'run.terminal', runId, payload: { status: terminalStatus } })
  return terminalStatus
}
