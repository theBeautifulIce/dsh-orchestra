import { useMemo } from 'react'
import type { NodeRunView } from '../api/types.ts'
import { currentAttempts } from './runtime-topology.ts'
import { nodeExecutionLabel } from './task-node-status.ts'
import { topologicalOrder, type CanvasDoc, type CanvasNode } from './workflow-canvas-nodes.tsx'
import { COLOR } from './tokens.ts'

export function WorkflowDependencyView({ doc, nodes }: { doc: CanvasDoc; nodes?: readonly NodeRunView[] }) {
  const topology = useMemo(() => topologicalOrder(doc), [doc])
  if (!doc.nodes.length) return null
  if (!topology.ok) return <p role="status">流程依赖存在环路，无法按层展示。</p>
  const attempts = currentAttempts(nodes ?? [])
  const byId = new Map(doc.nodes.map((node) => [node.node_id, node]))
  const levels = new Map<number, CanvasNode[]>()
  const incoming = new Map<string, Set<string>>()
  const outgoing = new Map<string, Set<string>>()
  for (const id of topology.order) {
    const layer = topology.layer.get(id)!
    const level = levels.get(layer) ?? []
    level.push(byId.get(id)!)
    levels.set(layer, level)
  }
  for (const { from, to } of doc.edges) {
    const sources = incoming.get(to) ?? new Set<string>()
    sources.add(from)
    incoming.set(to, sources)
    const destinations = outgoing.get(from) ?? new Set<string>()
    destinations.add(to)
    outgoing.set(from, destinations)
  }
  const title = (id: string) => attempts.get(id)?.title || byId.get(id)?.title || '未命名步骤'
  const names = (ids: Set<string>) => [...ids].map(title).join('、')

  return <section className="ops-surface ops-inset" aria-label="流程步骤依赖">
    <h3 style={{ margin: '0 0 8px' }}>步骤依赖</h3>
    <ol style={layersStyle}>
      {[...levels].sort(([left], [right]) => left - right).map(([layer, peers]) => <li key={layer}>
        <h4 style={headingStyle}>第 {layer + 1} 层{peers.length > 1 && ` · 同层 ${peers.length} 步`}</h4>
        <ul style={peersStyle}>
          {peers.map(({ node_id: id, type }) => {
            const before = incoming.get(id)
            const after = outgoing.get(id)
            const attempt = attempts.get(id)
            return <li key={id} style={peerStyle}>
              <strong>{title(id)}</strong>
              {attempt && <span>{nodeExecutionLabel(attempt)}</span>}
              {before && <small>{before.size > 1 ? '汇合，依赖' : '依赖'} {names(before)}</small>}
              {after && after.size > 1 && <small>{type === 'branch' ? '可选出口' : '分支至'} {names(after)}</small>}
              {before && !after && <small>流程终点</small>}
            </li>
          })}
        </ul>
      </li>)}
    </ol>
  </section>
}

const layersStyle = { display: 'grid', gap: 12, listStyle: 'none', margin: 0, padding: 0 }
const headingStyle = { margin: '0 0 4px', color: COLOR.inkMuted, fontSize: 'inherit' }
const peersStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))',
  gap: 6, listStyle: 'none', margin: 0, padding: 0 }
const peerStyle = { display: 'grid', gap: 2, alignContent: 'start', minWidth: 0, overflowWrap: 'anywhere' as const,
  border: `1px solid ${COLOR.line}`, borderRadius: 6, padding: '6px 8px' }
