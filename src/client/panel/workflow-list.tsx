import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client.ts'
import type { ResourcesApi } from '../api/resources.ts'
import type { WorkflowListItem } from '../api/types.ts'
import type { WorkflowCommandsApi } from '../api/workflow-commands.ts'
import type { WorkflowDoc } from '../../core/workflow-doc.ts'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { PanelCommandButton, UnknownState } from './shell.tsx'
import { WorkflowCanvasView } from './workflow-canvas-view.tsx'

export function WorkflowStatusBadge({ status }: { status: string }) {
  if (status === 'active') return <span className="ops-status" data-tone="on">已启用</span>
  if (status === 'disabled' || status === 'archived') return <span className="ops-status" data-tone="off">已停用</span>
  return <UnknownState value={status} />
}

export type WorkflowListScreenProps = {
  api: ResourcesApi
  onSelectWorkflow: (workflowId: string) => void
  reloadVersion?: number
  onSnapshot?: (asOfSeq: number) => void
  /** 给了命令客户端就能新建流程；没给仍是只读列表。 */
  commands?: WorkflowCommandsApi | null
}

export function WorkflowListScreen({ api, onSelectWorkflow, reloadVersion = 0, onSnapshot, commands = null }: WorkflowListScreenProps) {
  const [items, setItems] = useState<WorkflowListItem[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const lastReloadVersion = useRef(reloadVersion)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [creationMode, setCreationMode] = useState<'manual' | 'generate' | null>(null)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (lastReloadVersion.current === reloadVersion) return
    lastReloadVersion.current = reloadVersion
    setItems([])
    setCursor(undefined)
    setNextCursor(null)
    setRetry((value) => value + 1)
  }, [reloadVersion])

  useEffect(() => {
    let current = true
    setLoading(true)
    setFailed(false)
    void api.listWorkflows({ limit: 50, cursor, query: query || undefined, status: status || undefined }).then((result) => {
      if (!current) return
      setItems((previous) => cursor ? [...previous, ...result.data.items] : result.data.items)
      setNextCursor(result.data.next_cursor)
      onSnapshot?.(result.as_of_seq)
    }).catch(() => {
      if (current) setFailed(true)
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [api, cursor, retry, onSnapshot, query, status])

  function refresh() { setCursor(undefined); setRetry((value) => value + 1) }
  function openNewDraft(id: string) {
    setCreationMode(null)
    refresh()
    onSelectWorkflow(id)
  }

  /** 新建流程走控制面命令：先建工作流与 revision=1 的草稿，编辑与发布在详情页做。 */
  async function createFlow() {
    if (!commands || creating) return
    const name = newName.trim()
    if (name.length < 1 || name.length > 80) {
      setCreateError('流程名必须是 1–80 字')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const outcome = await commands.createWorkflow({
        workflow_id: newWorkflowId(),
        name,
        definition: starterDefinition(name),
      })
      setNewName('')
      openNewDraft(outcome.result.workflow_id)
    } catch (error) {
      setCreateError(error instanceof ApiError ? `${error.code}：${error.message}` : '新建流程失败')
    } finally {
      setCreating(false)
    }
  }

  return <section aria-labelledby="workflow-list-title" className="ops-page">
    <header className="ops-page-header">
      <div>
        <h1 id="workflow-list-title">Workflow 管理</h1>
        {!commands && <p className="ops-meta">只读访问</p>}
      </div>
      {commands && <div className="ops-actions">
        <PanelCommandButton className="ops-button" aria-expanded={creationMode === 'generate'}
          onClick={() => setCreationMode((current) => current === 'generate' ? null : 'generate')}>自然语言生成</PanelCommandButton>
        <PanelCommandButton className="ops-button ops-button--primary" aria-expanded={creationMode === 'manual'}
          onClick={() => setCreationMode((current) => current === 'manual' ? null : 'manual')}>新建 Workflow</PanelCommandButton>
      </div>}
    </header>
    {commands && creationMode === 'generate' && <GenerateWorkflow commands={commands} onCreated={openNewDraft} />}
    {commands && creationMode === 'manual' && (
      <form className="ops-surface ops-entry-form" aria-label="新建 Workflow"
        onSubmit={(event) => { event.preventDefault(); void createFlow() }}>
        <label htmlFor="workflow-new-name">流程名称</label>
        <div className="ops-actions">
          <input id="workflow-new-name" className="ops-field" value={newName} maxLength={80}
            onChange={(event) => setNewName(event.target.value)} />
          <PanelCommandButton type="submit" className="ops-button ops-button--primary" disabled={creating || !newName.trim()}>
            {creating ? '正在新建…' : '创建草稿'}
          </PanelCommandButton>
        </div>
        {createError && <p role="alert" style={errorTextStyle}>{createError}</p>}
      </form>
    )}
    <div className="ops-surface">
    <div className="ops-surface-head ops-toolbar">
    <form role="search" className="ops-actions" onSubmit={(event) => {
      event.preventDefault(); setQuery(search.trim()); setItems([]); setNextCursor(null); refresh()
    }}>
      <input aria-label="搜索 Workflow" className="ops-field" value={search} maxLength={200} placeholder="搜索名称或 ID" onChange={(event) => setSearch(event.target.value)} />
      <button type="submit" className="ops-button">搜索</button>
      <select aria-label="启用状态" className="ops-field" value={status} onChange={(event) => {
        setStatus(event.target.value); setItems([]); setNextCursor(null); refresh()
      }}><option value="">全部状态</option><option value="active">已启用</option><option value="disabled">已停用</option></select>
    </form>
    <button type="button" onClick={refresh} disabled={loading} className="ops-button">{loading ? '正在更新…' : '刷新'}</button>
    </div>
    {failed && <div role="alert" className="ops-empty"><span>{COPY.queryFailed} </span><button type="button" onClick={refresh} className="ops-button">{COPY.retry}</button></div>}
    {loading && items.length === 0 && <p role="status" className="ops-empty">正在读取流程…</p>}
    {!loading && !failed && items.length === 0 && <p className="ops-empty">{query || status ? '没有符合条件的 Workflow。' : '当前没有已保存的流程'}</p>}
    {items.length > 0 && <div className="ops-table-scroll">
      <table className="ops-table ops-table--wide" aria-label="Workflow 列表">
        <thead><tr><th scope="col">名称</th><th scope="col">启用状态</th><th scope="col">版本</th><th scope="col">步骤</th>
          <th scope="col">活跃任务</th><th scope="col">最近发布</th><th scope="col">操作</th></tr></thead>
        <tbody>{items.map((workflow) => <tr key={workflow.workflow_id}>
          <td><strong>{workflow.name}</strong><p className="ops-meta">
            {workflow.scope === 'task_local' ? '任务专属' : workflow.scope === 'reusable' ? '可复用' : <UnknownState value={workflow.scope} />}
            {' · '}{workflow.workflow_id}</p></td>
          <td><WorkflowStatusBadge status={workflow.status} /></td>
          <td>{workflow.current_version === null ? '未发布' : `v${workflow.current_version}`}
            {workflow.has_draft && <p className="ops-meta">草稿 · 修订 {workflow.draft_revision ?? '未知'}</p>}</td>
          <td className="ops-number">{workflow.node_count ?? '未知'}</td>
          <td className="ops-number">{workflow.active_task_count}</td>
          <td>{workflow.published_at ? <time dateTime={workflow.published_at}>{formatDate(workflow.published_at)}</time> : '—'}</td>
          <td><button type="button" onClick={() => onSelectWorkflow(workflow.workflow_id)} className="ops-button ops-button--link">查看流程</button></td>
        </tr>)}</tbody>
      </table>
    </div>}
    {nextCursor && !failed && <div className="ops-inset"><button type="button" disabled={loading} onClick={() => setCursor(nextCursor)} className="ops-button">加载更多</button></div>}
    </div>
  </section>
}

function GenerateWorkflow({ commands, onCreated }: { commands: WorkflowCommandsApi; onCreated: (id: string) => void }) {
  const [enabled, setEnabled] = useState(false)
  const [goal, setGoal] = useState('')
  const [draft, setDraft] = useState<WorkflowDoc>()
  const [busy, setBusy] = useState<'generating' | 'saving'>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void commands.canGenerateWorkflow?.().then((value) => { if (active) setEnabled(value) }).catch(() => {})
    return () => { active = false }
  }, [commands])

  async function generate() {
    if (!commands.generateWorkflow || !goal.trim() || busy) return
    setBusy('generating'); setError(''); setDraft(undefined)
    try { setDraft(await commands.generateWorkflow(goal.trim())) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '生成草稿失败') }
    finally { setBusy(undefined) }
  }

  async function create() {
    if (!draft || busy) return
    setBusy('saving'); setError('')
    try {
      const result = await commands.createWorkflow({ workflow_id: newWorkflowId(), name: draft.name, definition: draft })
      onCreated(result.result.workflow_id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存草稿失败') }
    finally { setBusy(undefined) }
  }

  return <section className="ops-surface ops-inset" aria-label="从自然语言生成 Workflow">
    {enabled ? <>
      <form className="ops-entry-form" style={{ padding: 0 }} onSubmit={(event) => { event.preventDefault(); void generate() }}>
        <label htmlFor="workflow-generate-goal">目标、步骤和验收要求</label>
        <textarea id="workflow-generate-goal" value={goal} rows={3} maxLength={2000} className="ops-field"
          onChange={(event) => { setGoal(event.target.value); setDraft(undefined) }} disabled={!!busy} />
        <PanelCommandButton type="submit" className="ops-button ops-button--primary" disabled={!!busy || !goal.trim()}>{busy === 'generating' ? '正在生成…' : '生成草稿'}</PanelCommandButton>
      </form>
      {draft && <section>
        <h3>{draft.name}</h3>
        <p>{draft.nodes.length} 个节点 · {draft.edges.length} 条依赖</p>
        <WorkflowCanvasView definition={draft} readOnly runtimeCompact inspectNodes canvasId="generated-workflow-canvas" />
        <PanelCommandButton type="button" disabled={!!busy} onClick={() => { void create() }}>确认保存草稿</PanelCommandButton>
      </section>}
    </> : <p style={mutedStyle}>启用宿主的 Workflow 生成能力后，可以从这里生成草稿。</p>}
    {error && <p role="alert" style={errorTextStyle}>{error}</p>}
  </section>
}

/** 新建流程的初始定义：一个 trigger 节点；名字必须与工作流名一致，否则保存层会拒。 */
function starterDefinition(name: string) {
  return {
    name,
    nodes: [{ node_id: 'trigger', type: 'trigger', title: '开始', position: { x: 0, y: 0 } }],
    edges: [],
  }
}

function newWorkflowId(): string {
  const stamp = Date.now().toString(36)
  const salt = Math.floor(Math.random() * 0x100000).toString(36).padStart(4, '0')
  return `wf-${stamp}-${salt}`
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString()
}

const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body }
const errorTextStyle = { margin: '10px 0 0', padding: 12, color: COLOR.danger, background: '#fff1f0', borderRadius: 8, fontSize: FONT_PX.body } as const
