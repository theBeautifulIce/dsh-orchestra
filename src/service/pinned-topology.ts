import { deepFreeze } from '../core/freeze.ts'
import type { WorkflowDefinition } from '../core/workflow-def.ts'
import type { RuntimeEdge } from './rework-edges.ts'
import { definitionHashOf } from './workflows.ts'

export type PinnedTopology = {
  edges: readonly RuntimeEdge[]
  predecessors: (nodeId: string) => readonly string[]
}

const NO_PREDECESSORS: readonly string[] = Object.freeze([])
const CACHE_LIMIT = 16
const verifiedTopologies = new Map<string, { json: string; topology: PinnedTopology }>()

export function indexTopology(edges: readonly RuntimeEdge[]): PinnedTopology {
  const byTarget = new Map<string, Set<string>>()
  for (const { from, to } of edges) {
    const existing = byTarget.get(to)
    if (existing) existing.add(from)
    else byTarget.set(to, new Set([from]))
  }
  const predecessors = new Map(Array.from(byTarget, ([to, from]) => [to, Object.freeze([...from])]))
  return { edges, predecessors: nodeId => predecessors.get(nodeId) ?? NO_PREDECESSORS }
}

/** Cache static topology only. The exact persisted bytes must still match on every use. */
export function verifiedTopology(json: string, hash: string | null): PinnedTopology | null {
  const cached = hash ? verifiedTopologies.get(hash) : undefined
  if (cached?.json === json) return cached.topology
  try {
    const definition = JSON.parse(json) as WorkflowDefinition
    if (hash && definitionHashOf(definition) !== hash) return null
    const edges = definition.edges ?? []
    if (!Array.isArray(edges) || !edges.every(edge => typeof edge?.from === 'string' && typeof edge.to === 'string')) return null
    const topology = indexTopology(deepFreeze(edges))
    if (hash) {
      if (!verifiedTopologies.has(hash) && verifiedTopologies.size >= CACHE_LIMIT) {
        const oldest = verifiedTopologies.keys().next()
        if (!oldest.done) verifiedTopologies.delete(oldest.value)
      }
      verifiedTopologies.set(hash, { json, topology })
    }
    return topology
  } catch {
    return null
  }
}
