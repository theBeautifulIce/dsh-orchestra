import { deepFreeze } from '../core/freeze.ts'
import type { WorkflowDefinition, WorkflowNodeDef } from '../core/workflow-def.ts'
import type { RuntimeEdge } from './rework-edges.ts'
import { definitionHashOf } from './workflows.ts'

export type PinnedTopology = {
  edges: readonly RuntimeEdge[]
  hasRoutes: boolean
  hasParallel: boolean
  predecessors: (nodeId: string) => readonly string[]
  /** Undefined for an ordinary node, null for an ambiguous or inconsistent owner. */
  parallelOwner: (nodeId: string) => string | null | undefined
}

const NO_PREDECESSORS: readonly string[] = Object.freeze([])
const CACHE_LIMIT = 16
const verifiedTopologies = new Map<string, { json: string; topology: PinnedTopology }>()
const catalogTopologies = new WeakMap<WorkflowDefinition, { hash: string; topology: PinnedTopology }>()

export function indexTopology(edges: readonly RuntimeEdge[], nodes: readonly WorkflowNodeDef[] = []): PinnedTopology {
  const byTarget = new Map<string, Set<string>>()
  for (const { from, to } of edges) {
    const existing = byTarget.get(to)
    if (existing) existing.add(from)
    else byTarget.set(to, new Set([from]))
  }
  const predecessors = new Map(Array.from(byTarget, ([to, from]) => [to, Object.freeze([...from])]))
  const parallel = new Set(nodes.filter(node => node.type === 'parallel').map(node => node.node_id))
  const owners = new Map<string, string | null>()
  for (const [to, from] of predecessors) {
    const owner = from.find(nodeId => parallel.has(nodeId))
    if (owner !== undefined) owners.set(to, from.length === 1 ? owner : null)
  }
  return {
    edges, hasRoutes: edges.some(edge => Object.hasOwn(edge, 'route')), hasParallel: parallel.size > 0,
    predecessors: nodeId => predecessors.get(nodeId) ?? NO_PREDECESSORS,
    parallelOwner: nodeId => owners.get(nodeId),
  }
}

/** The catalog supplies a deeply frozen definition that can be checked against the run once per snapshot. */
export function catalogTopology(definition: WorkflowDefinition, expectedHash: string): PinnedTopology | null {
  const cached = catalogTopologies.get(definition)
  if (cached) return cached.hash === expectedHash ? cached.topology : null
  const hash = definitionHashOf(definition)
  if (hash !== expectedHash) return null
  const topology = indexTopology(definition.edges ?? [], definition.nodes)
  catalogTopologies.set(definition, { hash, topology })
  return topology
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
    const topology = indexTopology(deepFreeze(edges), definition.nodes)
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
