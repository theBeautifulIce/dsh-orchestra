// src/service/commands/memory-run.ts —— 记忆固定图的专用运行骨架（规格 §9.3）
//
// 记忆运行只走这条专用路径：不进通用 workflow 的节点类型表、不进 dispatcher、
// 不进普通 agent 的工具面。节点表与显式拓扑序的唯一声明源是 src/core/memory-graph-schema.ts，
// 这里只做派生与推进，不重新声明任何节点，也不实现 evaluate/apply/inspect 端口处理器
// （端口处理器归 S5-Gb / S5-H）。
import { OrchError } from '../../core/errors.ts'
import {
  MEMORY_GRAPH_NODES,
  findMemoryNode,
  memoryGraphEdges,
  memoryGraphNodeSpecs,
} from '../../core/memory-graph-schema.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { insertNodeRunsInTx, type CreatedNodeRun } from '../runs.ts'

/** 分支路由名：从固定图的分支持久化路由派生（ready / empty / blocked）。 */
export const MEMORY_ROUTE_NAMES: readonly string[] = Array.from(new Set(
  memoryGraphEdges().map((edge) => edge.route).filter((route): route is string => route !== undefined),
))

/** 记忆运行的起始节点：固定图里唯一的 trigger。 */
export function memoryRunStartNode(): string {
  const trigger = MEMORY_GRAPH_NODES.find((node) => node.kind === 'trigger')
  if (!trigger) {
    throw new OrchError('WORKFLOW_NO_TRIGGER', '记忆固定图里没有触发节点', {})
  }
  return trigger.node_id
}

/** 起推校验：记忆运行只能从触发节点起推，其余节点一律 fail closed。 */
export function assertMemoryRunStart(node_id: string): string {
  const node = findMemoryNode(node_id)
  if (!node) {
    throw new OrchError('WORKFLOW_NODE_ID_INVALID', '记忆固定图里没有这个节点', { node_id })
  }
  const start = memoryRunStartNode()
  if (node_id !== start) {
    throw new OrchError('WORKFLOW_NODE_CONFIG_INVALID', '记忆运行只能从触发节点起推', { node_id, start })
  }
  return node_id
}

export type MemoryAdvance = {
  from: string
  to: string
  /** 非分支节点推进时为 null。 */
  route: string | null
}

/**
 * 推进原语：给定当前节点与分支路由，算出下一节点（路由与后继都由固定图派生）。
 * 非法路由、未知节点、非分支节点带路由、没有后继一律 fail closed，抛既有错误码。
 */
export function advanceMemoryRun(current_node_id: string, route?: string | null): MemoryAdvance {
  const node = findMemoryNode(current_node_id)
  if (!node) {
    throw new OrchError('WORKFLOW_NODE_ID_INVALID', '记忆固定图里没有这个节点', { node_id: current_node_id })
  }
  const edges = memoryGraphEdges().filter((edge) => edge.from === current_node_id)
  if (node.kind === 'branch') {
    if (route === undefined || route === null || route === '') {
      throw new OrchError('WORKFLOW_BRANCH_ROUTE_INVALID', '分支节点推进必须给路由', {
        node_id: current_node_id,
        routes: MEMORY_ROUTE_NAMES,
      })
    }
    const edge = edges.find((candidate) => candidate.route === route)
    if (!edge) {
      throw new OrchError('WORKFLOW_BRANCH_ROUTE_INVALID', '分支路由不在固定图里', {
        node_id: current_node_id,
        route,
        routes: MEMORY_ROUTE_NAMES,
      })
    }
    return { from: current_node_id, to: edge.to, route }
  }
  if (route !== undefined && route !== null && route !== '') {
    throw new OrchError('WORKFLOW_BRANCH_ROUTE_INVALID', '非分支节点不接受路由', {
      node_id: current_node_id,
      route,
    })
  }
  const next = edges[0]
  if (!next) {
    throw new OrchError('WORKFLOW_NODE_FANOUT_INVALID', '记忆节点没有后继', { node_id: current_node_id })
  }
  return { from: current_node_id, to: next.to, route: null }
}

/**
 * 按固定图建记忆运行的节点行（规格 §9.3 的 9 个节点，seq 按显式拓扑序）。
 * 必须由发起记忆运行的那笔事务调用：这里只收 tx，不自己开事务。
 * 同一个 run 已经有节点行时直接拒，避免重复建行。
 */
export function createMemoryRunNodeRuns(tx: Tx, memoryRunId: string, now: string): CreatedNodeRun[] {
  const existing = tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM node_runs WHERE run_id = ?', [memoryRunId])
  const count = existing?.n ?? 0
  if (count > 0) {
    throw new OrchError('MEMORY_RUN_ACTIVE', '这条记忆运行已经有节点行，不能重复建', {
      memory_run_id: memoryRunId,
      node_runs: count,
    })
  }
  return insertNodeRunsInTx(tx, memoryRunId, memoryGraphNodeSpecs(), now)
}
