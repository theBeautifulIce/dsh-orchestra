import { currentAttempts, runtimeCanvasDoc, type RuntimeAttempt, type RunTopology } from './runtime-topology.ts'
// 流程画布视图：草稿可拖动 / 连线 / 增删，已发布只读。
// 画布只认一份定义：definition 由外部给，改动通过 onChange 把新定义交回去，
// 画布内部不另存一份「自己的」定义，所以画布和 JSON 抽屉永远同步。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { COLOR, FONT_PX } from './tokens.ts'
import {
  CANVAS_NODE_TYPES,
  MULTI_OUT_TYPES,
  NODE_TYPE_LABEL,
  arrangePositions,
  canConnect,
  clampCoordinate,
  nextNodeIdentity,
  routeForNewEdge,
  serializeCanvasDoc,
  type CanvasDoc,
  type CanvasNode,
} from './workflow-canvas-nodes.tsx'

export type WorkflowCanvasViewProps = {
  /** 当前这一份 WorkflowDefinition；不是对象就画不了。 */
  definition: unknown
  /** 已发布版本只读：拖动、连线、增删入口全部禁用。 */
  readOnly: boolean
  /** 画布改了定义就交回来（草稿）；只读时不会调用。 */
  onChange?: (definition: Record<string, unknown>) => void
  /** 给测试与页面区分多块画布用。 */
  canvasId?: string
  inspectNodes?: boolean
  runtimeNodes?: readonly RuntimeAttempt[]
  runtimeTopology?: RunTopology | null
  runtimeCompact?: boolean
  workspace?: boolean
}

const REWORK_STATUS: Record<string, string> = { proposed: '等待授权', needs_human_approval: '等待人工授权', scheduled: '等待返工', awaiting_review: '等待重新验收', escalated: '等待处理', closed: '验收通过', declined: '未批准', cancelled: '已取消' }
const NODE_WIDTH = 160
const NODE_HEIGHT = 56
const MIN_CANVAS_WIDTH = 1100
const MIN_CANVAS_HEIGHT = 620

type DragState =
  | { kind: 'none' }
  | { kind: 'move'; nodeId: string; startClientX: number; startClientY: number; originX: number; originY: number }
  | { kind: 'palette'; nodeType: string }
  | { kind: 'link'; fromNodeId: string }

export function WorkflowCanvasView({
  definition, readOnly, onChange, canvasId, inspectNodes = false, runtimeNodes, runtimeTopology, runtimeCompact = false, workspace = false,
}: WorkflowCanvasViewProps) {
  const compact = readOnly && runtimeCompact
  const doc = useMemo(() => runtimeCanvasDoc(definition, readOnly ? runtimeTopology : null), [definition, readOnly, runtimeTopology])
  const nodeHeight = readOnly && runtimeTopology ? 108 : NODE_HEIGHT
  const [alert, setAlert] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // 拖拽与连线跨事件发生：引用里始终放最新的定义、回调与只读标记。
  const docRef = useRef<CanvasDoc | null>(doc)
  const onChangeRef = useRef(onChange)
  const readOnlyRef = useRef(readOnly)
  docRef.current = doc
  onChangeRef.current = onChange
  readOnlyRef.current = readOnly

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState>({ kind: 'none' })

  const size = useMemo(() => {
    let width = compact || workspace ? NODE_WIDTH : MIN_CANVAS_WIDTH
    let height = workspace ? (readOnly ? 130 : 220) : compact ? NODE_HEIGHT : MIN_CANVAS_HEIGHT
    const padding = workspace ? 44 : compact ? 32 : 120
    for (const node of doc?.nodes ?? []) {
      width = Math.max(width, node.position.x + NODE_WIDTH + padding)
      height = Math.max(height, node.position.y + nodeHeight + padding)
    }
    return { width, height }
  }, [compact, doc, readOnly, workspace, nodeHeight])

  function emit(next: CanvasDoc) {
    if (readOnlyRef.current) return
    onChangeRef.current?.(serializeCanvasDoc(next))
  }

  function addNode(type: string, x: number, y: number) {
    const current = docRef.current
    if (!current) return
    const identity = nextNodeIdentity(current, type)
    const node: CanvasNode = {
      node_id: identity.nodeId,
      type,
      title: identity.title,
      position: { x, y },
      raw: {},
    }
    emit({ ...current, nodes: [...current.nodes, node] })
    setAlert(null)
  }

  function connect(from: string, to: string) {
    const current = docRef.current
    if (!current) return
    const check = canConnect(current, from, to)
    if (!check.ok) {
      setAlert(check.message)
      return
    }
    const route = routeForNewEdge(current, from)
    emit({
      ...current,
      edges: [...current.edges, { from, to, ...(route ? { route } : {}), raw: {} }],
    })
    setAlert(null)
  }

  function deleteNode(nodeId: string) {
    const current = docRef.current
    if (!current) return
    emit({
      ...current,
      nodes: current.nodes.filter((node) => node.node_id !== nodeId),
      edges: current.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    })
    setAlert(null)
  }

  function deleteEdge(from: string, to: string) {
    const current = docRef.current
    if (!current) return
    emit({
      ...current,
      edges: current.edges.filter((edge) => !(edge.from === from && edge.to === to)),
    })
    setAlert(null)
  }

  function arrange() {
    const current = docRef.current
    if (!current) return
    const result = arrangePositions(current)
    if (!result.ok) {
      setAlert(result.message)
      return
    }
    emit({ ...current, nodes: result.nodes })
    setAlert(null)
  }

  function startMove(event: ReactMouseEvent, node: CanvasNode) {
    if (readOnlyRef.current) return
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = {
      kind: 'move',
      nodeId: node.node_id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: node.position.x,
      originY: node.position.y,
    }
  }

  function startPalette(event: ReactMouseEvent, nodeType: string) {
    if (readOnlyRef.current) return
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = { kind: 'palette', nodeType }
  }

  function startLink(event: ReactMouseEvent, node: CanvasNode) {
    if (readOnlyRef.current) return
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = { kind: 'link', fromNodeId: node.node_id }
  }

  function handleDoubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (readOnlyRef.current) return
    const target = event.target as Element | null
    if (target && typeof target.closest === 'function' && target.closest('[data-node-id]')) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    addNode('agent', clampCoordinate(event.clientX - rect.left), clampCoordinate(event.clientY - rect.top))
  }

  // 拖拽与连线跨元素：统一挂在 document 上，鼠标松开时按落点判断。
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const drag = dragRef.current
      if (drag.kind !== 'move') return
      const current = docRef.current
      if (!current) return
      const x = clampCoordinate(drag.originX + (event.clientX - drag.startClientX))
      const y = clampCoordinate(drag.originY + (event.clientY - drag.startClientY))
      emit({
        ...current,
        nodes: current.nodes.map((node) => (
          node.node_id === drag.nodeId ? { ...node, position: { x, y } } : node
        )),
      })
    }
    const onUp = (event: MouseEvent) => {
      const drag = dragRef.current
      dragRef.current = { kind: 'none' }
      if (drag.kind === 'palette') {
        const canvas = canvasRef.current
        const target = event.target as Node | null
        if (!canvas || !target || !canvas.contains(target)) return
        const rect = canvas.getBoundingClientRect()
        addNode(drag.nodeType, clampCoordinate(event.clientX - rect.left), clampCoordinate(event.clientY - rect.top))
        return
      }
      if (drag.kind === 'link') {
        const target = event.target as Element | null
        const holder = target && typeof target.closest === 'function' ? target.closest('[data-node-id]') : null
        const targetId = holder?.getAttribute('data-node-id') ?? null
        if (!targetId) {
          setAlert('连线要落在另一个节点上。')
          return
        }
        connect(drag.fromNodeId, targetId)
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  const nodes = doc?.nodes ?? []
  const edges = doc?.edges ?? []
  const selected = nodes.find((node) => node.node_id === selectedId) ?? (workspace ? nodes[0] : undefined)
  const runtimeByNode = currentAttempts(runtimeNodes ?? [])

  return <div data-canvas-id={canvasId ?? 'workflow-canvas'} data-canvas-root="true" data-canvas-readonly={readOnly ? 'true' : 'false'} style={rootStyle}>
    {!compact && <div style={workspace ? workspaceToolbar : toolbarStyle}>
      <div>
        {!workspace && <><h3 style={sectionTitleStyle}>节点条</h3>
          <p style={mutedStyle}>按住节点拖到画布空白处就新建一个节点。</p></>}
        <div style={paletteStyle}>
          {CANVAS_NODE_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              data-node-palette={type}
              aria-label={`拖出${NODE_TYPE_LABEL[type] ?? type}节点`}
              aria-disabled={readOnly || !doc ? 'true' : 'false'}
              disabled={readOnly || !doc}
              title="拖到画布添加节点"
              onMouseDown={(event) => startPalette(event, type)}
              style={paletteButtonStyle}
            >
              {NODE_TYPE_LABEL[type] ?? type}
            </button>
          ))}
        </div>
      </div>
      <div>
        <button
          type="button"
          data-canvas-action="arrange"
          aria-label="按拓扑整理节点"
          aria-disabled={readOnly || !doc ? 'true' : 'false'}
          disabled={readOnly || !doc}
          onClick={arrange}
          style={buttonStyle}
        >
          整理
        </button>
        {!workspace && <p style={mutedStyle}>{readOnly ? '已发布版本只读，不能改。' : '整理按拓扑序重排节点位置。'}</p>}
      </div>
    </div>}
    {alert && <p role="alert" data-canvas-alert="true" style={alertStyle}>{alert}</p>}
    {doc === null && <p style={mutedStyle}>流程定义 JSON 还没解析成对象，画布暂时是空的。</p>}
    <div className={workspace && inspectNodes ? 'ops-workflow-stage' : undefined} style={inspectNodes && !workspace ? inspectionLayout : undefined}>
    <div style={workspace ? workspaceViewport : viewportStyle}>
      <div
        ref={canvasRef}
        data-canvas-surface="true"
        aria-label="流程画布"
        role="group"
        onDoubleClick={handleDoubleClick}
        style={{ ...surfaceStyle, ...(workspace ? workspaceSurface : {}), width: size.width, height: size.height }}
      >
        <svg width={size.width} height={size.height} style={edgeLayerStyle} aria-hidden="true">
          {edges.map((edge) => {
            const from = nodes.find((node) => node.node_id === edge.from)
            const to = nodes.find((node) => node.node_id === edge.to)
            if (!from || !to) return null
            return <line
              key={`${edge.from}->${edge.to}`}
              data-edge-from={edge.from}
              data-edge-to={edge.to}
              data-runtime-edge={edge.raw.runtime_added ? 'true' : undefined}
              x1={from.position.x + NODE_WIDTH}
              y1={from.position.y + nodeHeight / 2}
              x2={to.position.x}
              y2={to.position.y + nodeHeight / 2}
              stroke={edge.raw.runtime_added ? COLOR.link : workspace ? '#8c9ebb' : COLOR.line}
              strokeDasharray={edge.raw.runtime_added ? '6 3' : undefined}
              strokeWidth={2}
            />
          })}
        </svg>
        {nodes.map((node) => (
          <div
            key={node.node_id}
            data-node-id={node.node_id}
            data-node-type={node.type}
            data-runtime-status={runtimeByNode.get(node.node_id)?.status}
            data-runtime-attempt={runtimeByNode.get(node.node_id)?.attempt}
            data-runtime-added={node.raw.runtime_step ? 'true' : undefined}
            data-runtime-held={runtimeTopology?.held_node_ids.includes(node.node_id) ? 'true' : undefined}
            data-node-x={node.position.x}
            data-node-y={node.position.y}
            data-node-readonly={readOnly ? 'true' : 'false'}
            aria-label={`节点 ${node.node_id} ${node.title}`}
            aria-disabled={readOnly ? 'true' : 'false'}
            onMouseDown={(event) => startMove(event, node)}
            style={{ ...nodeStyle, height: nodeHeight, left: node.position.x, top: node.position.y, ...(workspace ? {
              boxSizing: 'border-box', cursor: readOnly ? 'default' : 'move',
              borderColor: selected === node ? '#83a9dc' : '#d2deec', background: selected === node ? '#edf5ff' : COLOR.surface,
            } : {}) }}
          >
            {inspectNodes ? <button type="button" aria-pressed={selected === node}
              onClick={() => setSelectedId(node.node_id)}
              style={nodeSelectStyle}>{node.title}</button> : <span style={nodeTitleStyle}>{node.title}</span>}
            <span style={nodeMetaStyle}>
              {runtimeNodes ? runtimeByNode.get(node.node_id)?.status_label || '尚无运行记录' : <>
                {NODE_TYPE_LABEL[node.type] ?? node.type}{MULTI_OUT_TYPES.has(node.type) ? ' · 可多条出边' : ''}
              </>}
            </span>
            {runtimeNodes && runtimeByNode.get(node.node_id)?.attempt != null && <span style={nodeMetaStyle}>第 {runtimeByNode.get(node.node_id)?.attempt} 次执行</span>}
            {node.raw.runtime_step != null && <span style={nodeMetaStyle}>来源角色：{String((node.raw.runtime_step as {source_title: string}).source_title)}</span>}
            {runtimeTopology?.held_node_ids.includes(node.node_id) && <span style={{ ...nodeMetaStyle, color: COLOR.warning }}>等待返工或验收</span>}
            {runtimeTopology?.requests.filter(r => r.target_node_id === node.node_id).slice(-1).map(r => <span key={r.request_id} style={{ ...nodeMetaStyle, color: COLOR.warning }}>成果反馈 · 第 {r.round_no} 轮</span>)}
            {!compact && <><button
              type="button"
              data-node-handle={node.node_id}
              aria-label={`从 ${node.node_id} 拉出连线`}
              aria-disabled={readOnly ? 'true' : 'false'}
              disabled={readOnly}
              onMouseDown={(event) => startLink(event, node)}
              style={handleStyle}
            />
            <button
              type="button"
              data-node-delete={node.node_id}
              aria-label={`删除节点 ${node.node_id}`}
              aria-disabled={readOnly ? 'true' : 'false'}
              disabled={readOnly}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); deleteNode(node.node_id) }}
              style={deleteStyle}
            >
              ×
            </button></>}
          </div>
        ))}
      </div>
    </div>
    {inspectNodes && <aside style={inspectionPanel} aria-label="节点详情">
      <h3 style={sectionTitleStyle}>节点详情</h3>
      {!selected && <p style={mutedStyle}>点选画布中的节点查看依赖。</p>}
      {selected && <>
        <p><strong>{selected.title}</strong></p>
        <p style={mutedStyle}>{NODE_TYPE_LABEL[selected.type] ?? selected.type} · {selected.node_id}</p>
        {runtimeByNode.get(selected.node_id) && <p>{runtimeByNode.get(selected.node_id)?.status_label} · 第 {runtimeByNode.get(selected.node_id)?.attempt ?? '未知'} 次执行</p>}
        {selected.raw.runtime_step != null && <><p>来源角色：{String((selected.raw.runtime_step as {source_title: string}).source_title)}</p><p>{String((selected.raw.runtime_step as {instruction: string}).instruction)}</p></>}
        {runtimeTopology?.requests.filter(r => r.target_node_id === selected.node_id).map(r => <p key={r.request_id}>反馈 {r.request_id} · 第 {r.round_no} 轮 · {REWORK_STATUS[r.status] ?? r.status}</p>)}
        {runtimeTopology?.held_node_ids.includes(selected.node_id) && <p>受影响步骤：等待返工或验收</p>}
        <p>上游 · {edges.filter((edge) => edge.to === selected.node_id).map((edge) => nodes.find((node) => node.node_id === edge.from)?.title ?? edge.from).join('、') || '无'}</p>
        <p>下游 · {edges.filter((edge) => edge.from === selected.node_id).map((edge) => nodes.find((node) => node.node_id === edge.to)?.title ?? edge.to).join('、') || '无'}</p>
      </>}
    </aside>}
    </div>
    <div hidden={workspace && readOnly}>
      {workspace ? <details><summary>连线（{edges.length}）</summary>{renderEdges()}</details> : <>
        <h3 style={sectionTitleStyle}>连线（{edges.length}）</h3>{renderEdges()}</>}
    </div>
  </div>

  function renderEdges() {
    return <>
      {edges.length === 0
        ? <p style={mutedStyle}>还没有连线。</p>
        : <ul style={edgeListStyle}>
          {edges.map((edge) => (
            <li key={`${edge.from}->${edge.to}`} data-edge-row={`${edge.from}->${edge.to}`}>
              <span>{compact ? nodes.find((node) => node.node_id === edge.from)?.title ?? edge.from : edge.from}
                {' → '}
                {compact ? nodes.find((node) => node.node_id === edge.to)?.title ?? edge.to : edge.to}
                {edge.route?.priority === undefined ? '' : ` （优先级 ${edge.route.priority}）`}</span>
              {!compact && <button
                type="button"
                data-edge-delete-from={edge.from}
                data-edge-delete-to={edge.to}
                aria-label={`删除连线 ${edge.from} 到 ${edge.to}`}
                aria-disabled={readOnly ? 'true' : 'false'}
                disabled={readOnly}
                onClick={() => deleteEdge(edge.from, edge.to)}
                style={edgeDeleteStyle}
              >
                删除
              </button>}
            </li>
          ))}
        </ul>}
    </>
  }
}

const rootStyle = { display: 'grid', gap: 12 } as const
const toolbarStyle = { display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' } as const
const workspaceToolbar = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' } as const
const sectionTitleStyle = { margin: '0 0 4px', fontSize: 14 } as const
const mutedStyle = { margin: '0 0 6px', color: COLOR.inkMuted, fontSize: FONT_PX.helper } as const
const paletteStyle = { display: 'flex', flexWrap: 'wrap', gap: 5 } as const
const paletteButtonStyle = {
  minHeight: 30,
  padding: '0 10px',
  border: `1px solid ${COLOR.line}`,
  borderRadius: 6,
  background: COLOR.surface,
  color: COLOR.ink,
  fontSize: FONT_PX.helper,
  cursor: 'grab',
} as const
const buttonStyle = {
  minHeight: 32,
  padding: '0 12px',
  border: `1px solid ${COLOR.line}`,
  borderRadius: 7,
  background: COLOR.surface,
  color: COLOR.ink,
  fontSize: FONT_PX.menu,
  cursor: 'pointer',
} as const
const alertStyle = { margin: 0, padding: 10, color: COLOR.danger, background: '#fff1f0', borderRadius: 8, fontSize: FONT_PX.body } as const
const viewportStyle = {
  maxHeight: 520,
  overflow: 'auto',
  border: `1px solid ${COLOR.line}`,
  borderRadius: 8,
  background: COLOR.canvas,
} as const
const surfaceStyle = {
  position: 'relative',
  minWidth: '100%',
  backgroundImage: 'linear-gradient(to right, #f1f2f4 1px, transparent 1px), linear-gradient(to bottom, #f1f2f4 1px, transparent 1px)',
  backgroundSize: '40px 40px',
} as const
const workspaceViewport = { ...viewportStyle, maxHeight: 400, padding: 12, background: '#f5f8fc' } as const
const workspaceSurface = { backgroundImage: 'radial-gradient(#cad6e6 1px, transparent 1px)', backgroundSize: '18px 18px' } as const
const edgeLayerStyle = { position: 'absolute', left: 0, top: 0, pointerEvents: 'none' } as const
const nodeStyle = {
  position: 'absolute',
  width: NODE_WIDTH,
  height: NODE_HEIGHT,
  display: 'grid',
  alignContent: 'center',
  gap: 2,
  padding: '6px 10px',
  border: `1px solid ${COLOR.line}`,
  borderRadius: 8,
  background: COLOR.surface,
  boxShadow: '0 1px 2px rgba(17, 19, 22, 0.08)',
  cursor: 'move',
} as const
const nodeTitleStyle = { fontSize: FONT_PX.body, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const
const nodeSelectStyle = { ...nodeTitleStyle, background: 'transparent', border: 0, color: COLOR.link, textAlign: 'left', cursor: 'pointer', padding: 0 } as const
const inspectionLayout = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(120px, 24%)', gap: 10, minWidth: 0 }
const inspectionPanel = { padding: 10, borderRadius: 8, border: `1px solid ${COLOR.line}`, minWidth: 0, overflowWrap: 'anywhere' } as const
const nodeMetaStyle = { color: COLOR.inkMuted, fontSize: FONT_PX.helper } as const
const handleStyle = {
  position: 'absolute',
  right: -7,
  top: NODE_HEIGHT / 2 - 7,
  width: 14,
  height: 14,
  padding: 0,
  border: `2px solid ${COLOR.link}`,
  borderRadius: '50%',
  background: COLOR.canvas,
  cursor: 'crosshair',
} as const
const deleteStyle = {
  position: 'absolute',
  right: 2,
  top: 2,
  width: 20,
  height: 20,
  padding: 0,
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: COLOR.inkMuted,
  fontSize: FONT_PX.helper,
  cursor: 'pointer',
} as const
const edgeListStyle = { margin: 0, paddingLeft: 18, display: 'grid', gap: 4, fontSize: FONT_PX.body } as const
const edgeDeleteStyle = {
  marginLeft: 8,
  minHeight: 24,
  padding: '0 8px',
  border: `1px solid ${COLOR.line}`,
  borderRadius: 6,
  background: COLOR.surface,
  color: COLOR.ink,
  fontSize: FONT_PX.helper,
  cursor: 'pointer',
} as const
