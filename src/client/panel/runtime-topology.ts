import type { RunTopology } from '../api/rework.ts'
export type { RunTopology } from '../api/rework.ts'
import { useEffect, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { NodeRunView } from '../api/types.ts'
import { arrangePositions, readCanvasDoc, type CanvasDoc } from './workflow-canvas-nodes.tsx'

export type RuntimeAttempt = Pick<NodeRunView, 'node_id' | 'status' | 'status_label' | 'execution_state'> & Partial<Pick<NodeRunView, 'attempt' | 'replacement_node_run_id' | 'node_run_id'>>
/** Selection is independent of query order and shared by the graph and step inspector. */
export function currentAttempts<T extends RuntimeAttempt>(nodes: readonly T[]): Map<string, T> {
  const selected = new Map<string, T>()
  for (const node of nodes) {
    if (node.replacement_node_run_id) continue
    const previous = selected.get(node.node_id)
    if (!previous || (node.attempt ?? 0) > (previous.attempt ?? 0)) selected.set(node.node_id, node)
  }
  return selected
}
/** Runtime additions only: never mutate the pinned workflow object used by the editor. */
export function runtimeCanvasDoc(definition: unknown, topology?: RunTopology | null): CanvasDoc | null {
  const base = readCanvasDoc(definition)
  if (!base || !topology) return base
  const nodes = [...base.nodes]
  for (const [index, step] of topology.steps.entries()) {
    if (nodes.some(n => n.node_id === step.node_id)) continue
    const source = base.nodes.find(n => n.node_id === step.before_node_id)
    nodes.push({ node_id: step.node_id, type: 'agent', title: `新增步骤 ${index + 1}`, position: { x: 40, y: 40 },
      raw: { contract: { description: step.instruction }, runtime_step: { ...step, source_title: source?.title || '来源步骤名称暂不可用' } } })
  }
  const edges = [...base.edges]
  for (const edge of topology.edges) {
    if (!edges.some(e => e.from === edge.from && e.to === edge.to)) edges.push({ ...edge, raw: { runtime_added: true } })
  }
  const merged = { ...base, nodes, edges }
  if (topology.edges.length || topology.steps.length) {
    const arranged = arrangePositions(merged)
    if (arranged.ok) return { ...merged, nodes: arranged.nodes }
  }
  return merged
}
export function useRunTopology(api: ResourcesApi, runId: string | undefined, enabled: boolean, reloadVersion: number) {
  const [loaded, setLoaded] = useState<{ key: string; data: RunTopology | null; failed: boolean }>()
  useEffect(() => {
    if (!runId || !enabled) return
    let active = true
    void api.getReworkTopology(runId).then(({ data }) => { if (active) setLoaded({ key: runId, data, failed: false }) })
      .catch(() => { if (active) setLoaded({ key: runId, data: null, failed: true }) })
    return () => { active = false }
  }, [api, runId, enabled, reloadVersion])
  return enabled && runId ? loaded?.key === runId ? { ...loaded, loading: false } : { data: null, failed: false, loading: true } : { data: null, failed: false, loading: false }
}
