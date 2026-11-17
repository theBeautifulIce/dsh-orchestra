import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client.ts'
import type { ResourcesApi } from '../api/resources.ts'
import type { WorkflowListItem } from '../api/types.ts'
import type { WorkflowCommandsApi } from '../api/workflow-commands.ts'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { UnknownState } from './shell.tsx'

const STATUS_LABEL: Record<string, string> = { active: '可使用', archived: '已归档', draft: '草稿' }

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
  const [createReceipt, setCreateReceipt] = useState<string | null>(null)

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
    void api.listWorkflows({ limit: 50, cursor }).then((result) => {
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
  }, [api, cursor, retry, onSnapshot])

  function refresh() { setCursor(undefined); setRetry((value) => value + 1) }

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
      setCreateReceipt(`已新建流程 ${outcome.result.workflow_id}；草稿修订 ${outcome.result.revision}；operation_id ${outcome.operation_id}`)
      setNewName('')
      refresh()
    } catch (error) {
      setCreateError(error instanceof ApiError ? `${error.code}：${error.message}` : '新建流程失败')
    } finally {
      setCreating(false)
    }
  }

  return <section aria-labelledby="workflow-list-title" style={{ display: 'grid', gap: 18 }}>
    <header>
      <p style={kickerStyle}>已发布流程与草稿</p>
      <h1 id="workflow-list-title" style={titleStyle}>流程</h1>
      <p style={mutedStyle}>{commands
        ? '查看已保存的流程定义。可以新建流程；编辑与发布在流程详情页进行。'
        : '查看已保存的流程定义。当前页面只读，尚未接入新建、编辑和发布操作。'}</p>
    </header>
    {commands && (
      <section aria-labelledby="workflow-create-title" style={cardStyle}>
        <h2 id="workflow-create-title" style={sectionTitleStyle}>新建流程</h2>
        <label htmlFor="workflow-new-name" style={labelStyle}>流程名称</label>
        <input
          id="workflow-new-name"
          style={inputStyle}
          value={newName}
          placeholder="流程名称"
          onChange={(event) => setNewName(event.target.value)}
        />
        <button type="button" style={buttonStyle} disabled={creating} onClick={() => { void createFlow() }}>{creating ? '正在新建…' : '新建流程'}</button>
        {createError && <p role="alert" style={errorTextStyle}>{createError}</p>}
        {createReceipt && <p style={mutedStyle}>{createReceipt}</p>}
      </section>
    )}
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <h2 style={sectionTitleStyle}>流程列表</h2>
      <button type="button" onClick={refresh} disabled={loading} style={buttonStyle}>{loading ? '正在更新…' : '刷新'}</button>
    </div>
    {failed && <div role="alert" style={errorStyle}><span>{COPY.queryFailed}</span><button type="button" onClick={refresh} style={buttonStyle}>{COPY.retry}</button></div>}
    {loading && <p role="status" style={mutedStyle}>正在读取流程…</p>}
    {!loading && !failed && items.length === 0 && <div style={emptyStyle}>当前没有已保存的流程</div>}
    {!failed && items.map((workflow) => <article key={workflow.workflow_id} style={cardStyle}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h2 style={cardTitleStyle}>{workflow.name}</h2>
          <p style={mutedStyle}>{workflow.scope === 'task_local' ? '任务专属流程' : workflow.scope === 'reusable' ? '可复用流程' : <UnknownState value={workflow.scope} />}</p>
        </div>
        <button type="button" onClick={() => onSelectWorkflow(workflow.workflow_id)} style={buttonStyle}>查看流程</button>
      </div>
      <dl style={detailGridStyle}>
        <dt>当前版本</dt><dd>{workflow.current_version === null ? '尚未发布' : `v${workflow.current_version}`}</dd>
        <dt>草稿</dt><dd>{workflow.has_draft ? `有未发布草稿（修订 ${workflow.draft_revision ?? '未知'}）` : '没有未发布草稿'}</dd>
        <dt>步骤数</dt><dd>{workflow.node_count === null ? '暂不可用' : `${workflow.node_count} 个步骤`}</dd>
        <dt>正在使用</dt><dd>{workflow.active_task_count} 个任务</dd>
        <dt>最近发布</dt><dd>{workflow.published_at ? formatDate(workflow.published_at) : '还没有发布版本'}</dd>
        <dt>状态</dt><dd>{STATUS_LABEL[workflow.status] ?? <UnknownState value={workflow.status} />}</dd>
      </dl>
      {workflow.projection_missing.length > 0 && <p style={mutedStyle}>部分流程信息当前不可用：{workflow.projection_missing.join('、')}</p>}
    </article>)}
    {nextCursor && !failed && <button type="button" disabled={loading} onClick={() => setCursor(nextCursor)} style={buttonStyle}>加载更多</button>}
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

const kickerStyle = { margin: '0 0 5px', color: COLOR.inkMuted, fontSize: FONT_PX.helper } as const
const titleStyle = { margin: 0, fontSize: FONT_PX.title }
const sectionTitleStyle = { margin: 0, fontSize: 16 }
const cardTitleStyle = { margin: 0, fontSize: 16 }
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body }
const cardStyle = { minWidth: 0, padding: 18, border: `1px solid ${COLOR.line}`, borderRadius: 9, background: COLOR.surface }
const detailGridStyle = { display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: '8px 12px', margin: '16px 0 0', fontSize: FONT_PX.body }
const emptyStyle = { border: `1px dashed ${COLOR.line}`, borderRadius: 9, padding: 32, textAlign: 'center' as const, color: COLOR.inkMuted }
const buttonStyle = { minHeight: 36, justifySelf: 'start' as const, padding: '0 12px', border: `1px solid ${COLOR.line}`, borderRadius: 7, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer' }
const errorStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 14, color: COLOR.danger, background: '#fff1f0', borderRadius: 8 }
const errorTextStyle = { margin: '10px 0 0', padding: 12, color: COLOR.danger, background: '#fff1f0', borderRadius: 8, fontSize: FONT_PX.body } as const
const labelStyle = { display: 'block', margin: '12px 0 4px', fontSize: FONT_PX.body } as const
const inputStyle = { width: '100%', minHeight: 34, padding: '0 8px', borderRadius: 7, border: `1px solid ${COLOR.line}`, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.body } as const
