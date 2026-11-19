import { useEffect, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { RunSummary, WorkflowView } from '../api/types.ts'
import type { WorkflowCommandsApi } from '../api/workflow-commands.ts'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { WorkflowCanvasView } from './workflow-canvas-view.tsx'
import { WorkflowEditor } from './workflow-editor.tsx'
import { taskStatusView } from './tasks-screen.tsx'

export type WorkflowCanvasProps = {
  api: ResourcesApi
  workflowId: string
  onBack: () => void
  onOpenRun?: (taskId: string, runId: string) => void
  reloadVersion?: number
  onSnapshot?: (asOfSeq: number) => void
  /** 给了命令客户端就把草稿编辑、保存、发布接到本屏；没给仍是只读检查页。 */
  commands?: WorkflowCommandsApi | null
}

export function WorkflowCanvas({ api, workflowId, onBack, onOpenRun, reloadVersion = 0, onSnapshot, commands = null }: WorkflowCanvasProps) {
  const [workflow, setWorkflow] = useState<WorkflowView | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [view, setView] = useState<'design' | 'versions' | 'runs'>('design')

  useEffect(() => {
    let current = true
    setLoading(true)
    setFailed(false)
    void api.getWorkflow(workflowId).then((result) => {
      if (!current) return
      setWorkflow(result.data)
      onSnapshot?.(result.as_of_seq)
    }).catch(() => {
      if (current) setFailed(true)
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [api, workflowId, retry, reloadVersion, onSnapshot])

  const editable = commands !== null
  const draftDefinition = workflow?.draft?.definition ?? null
  const publishedDefinition = workflow?.current?.definition ?? null
  const definition = draftDefinition ?? publishedDefinition
  const shownDefinition = editable ? publishedDefinition : definition
  const draftMode = Boolean(workflow?.draft)
  return <section aria-labelledby="workflow-canvas-title" style={{ display: 'grid', gap: 18 }}>
    <button type="button" onClick={onBack} style={buttonStyle}>返回流程列表</button>
    <header>
      <p style={kickerStyle}>流程检查</p>
      <h1 id="workflow-canvas-title" style={titleStyle}>{workflow?.workflow.name ?? '流程详情'}</h1>
      <p style={mutedStyle}>{draftMode ? `当前查看未发布草稿（修订 ${workflow?.draft?.revision ?? '未知'}）` : `当前查看已发布版本 v${workflow?.current?.version ?? '—'}；此版本只读`}</p>
    </header>
    <div style={noticeStyle}>{editable
      ? '草稿可编辑。已发布版本只读，保存与发布都走控制面命令，结果以回执为准。'
      : '此屏只读。草稿编辑、保存和发布尚未接入控制面命令与回执。'}</div>
    {failed && <div role="alert" style={errorStyle}><span>{COPY.queryFailed}</span><button type="button" onClick={() => setRetry((value) => value + 1)} style={buttonStyle}>{COPY.retry}</button></div>}
    {loading && <p role="status" style={mutedStyle}>正在读取流程定义…</p>}
    {!failed && workflow && <>
      <div role="group" aria-label="流程视图" style={{ display: 'flex', gap: 8 }}>
        <button type="button" aria-pressed={view === 'design'} style={view === 'design' ? activeButtonStyle : buttonStyle} onClick={() => setView('design')}>设计画布</button>
        <button type="button" aria-pressed={view === 'versions'} style={view === 'versions' ? activeButtonStyle : buttonStyle} onClick={() => setView('versions')}>版本记录</button>
        <button type="button" aria-pressed={view === 'runs'} style={view === 'runs' ? activeButtonStyle : buttonStyle} onClick={() => setView('runs')}>运行记录</button>
      </div>
      <div hidden={view !== 'design'}>
      {editable
        ? <WorkflowEditor commands={commands!} workflow={workflow} onRefresh={() => setRetry((value) => value + 1)} />
        : <section aria-labelledby="workflow-validation-title" style={cardStyle}>
          <h2 id="workflow-validation-title" style={sectionTitleStyle}>检查结果</h2>
          <IssueGroup title="需要修正" issues={workflow.validation.errors} tone="error" />
          <IssueGroup title="提醒" issues={workflow.validation.warnings} tone="warning" />
          {workflow.validation.errors.length === 0 && workflow.validation.warnings.length === 0 && <p style={mutedStyle}>当前查询没有返回结构错误或提醒。</p>}
        </section>}
      </div>
      <section hidden={view === 'runs' || (view !== 'versions' && editable)} aria-labelledby="workflow-definition-title" style={cardStyle}>
        <h2 id="workflow-definition-title" style={sectionTitleStyle}>{editable ? '已发布定义（只读）' : '流程定义'}</h2>
        {shownDefinition === null
          ? <p style={mutedStyle}>{editable ? '还没有已发布版本。' : '流程定义暂不可用。'}</p>
          : (
            <>
              <WorkflowCanvasView
                definition={shownDefinition}
                readOnly
                canvasId={editable ? 'published-canvas' : 'readonly-canvas'}
                inspectNodes
              />
              <details><summary>查看定义 JSON</summary><pre style={jsonStyle}>{JSON.stringify(shownDefinition, null, 2)}</pre></details>
            </>
          )}
        {!(editable ? definition : publishedDefinition) && <p style={mutedStyle}>定义摘要：{workflow.draft?.definition_hash ?? workflow.current?.definition_hash}</p>}
      </section>
      {view === 'runs' && <WorkflowRuns api={api} workflowId={workflowId} reloadVersion={reloadVersion} onSnapshot={onSnapshot} onOpenRun={onOpenRun} />}
      <section hidden={view !== 'versions'} aria-labelledby="workflow-versions-title" style={cardStyle}>
        <h2 id="workflow-versions-title" style={sectionTitleStyle}>已发布版本</h2>
        {workflow.versions.length === 0 ? <p style={mutedStyle}>还没有已发布版本。</p> : <ul style={{ marginBottom: 0 }}>
          {workflow.versions.map((version) => <li key={version.version}>v{version.version} · {formatDate(version.published_at)} · {version.publish_note || '没有发布说明'}</li>)}
        </ul>}
      </section>
    </>}
  </section>
}

function WorkflowRuns({ api, workflowId, reloadVersion, onSnapshot, onOpenRun }: Pick<WorkflowCanvasProps, 'api' | 'workflowId' | 'reloadVersion' | 'onSnapshot' | 'onOpenRun'>) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [retry, refresh] = useState(0)

  useEffect(() => {
    let current = true
    setFailed(false)
    void api.listRuns({ workflow_id: workflowId, limit: 50 }).then(({ data, as_of_seq }) => {
      if (!current) return
      setRuns(data.items)
      onSnapshot?.(as_of_seq)
    }).catch(() => { if (current) setFailed(true) })
    return () => { current = false }
  }, [api, workflowId, reloadVersion, onSnapshot, retry])

  return <section aria-label="最近 50 次运行" style={cardStyle}>
    {failed && <div role="alert">{COPY.queryFailed} <button type="button" style={buttonStyle} onClick={() => refresh((value) => value + 1)}>{COPY.retry}</button></div>}
    {!failed && !runs && <p role="status">正在读取运行记录…</p>}
    {!failed && runs?.length === 0 && <p>此流程还没有运行记录。</p>}
    {!failed && runs && runs.length > 0 && <ul>
      {runs.map((run) => <li key={run.run_id} style={{ marginBottom: 10 }}>
        {onOpenRun && run.task_id
          ? <button type="button" style={buttonStyle} onClick={() => onOpenRun(run.task_id, run.run_id)}>{run.task_title || '查看任务运行'}</button>
          : <strong>{run.task_title || run.run_id}</strong>}
        <span> · {run.workflow_version === null ? '版本未知' : `v${run.workflow_version}`} · {taskStatusView(run.status, run.display_status).label ?? run.status} · {formatDate(run.created_at)}</span>
      </li>)}
    </ul>}
  </section>
}

function IssueGroup({ title, issues, tone }: { title: string; issues: Array<{ path: string; code: string; message: string }>; tone: 'error' | 'warning' }) {
  if (issues.length === 0) return <p style={mutedStyle}>{title}：没有项目</p>
  return <div style={{ marginTop: 12 }}>
    <h3 style={{ ...sectionTitleStyle, color: tone === 'error' ? COLOR.danger : COLOR.warning }}>{title}（{issues.length}）</h3>
    <ul>{issues.map((issue, index) => <li key={`${issue.path}-${issue.code}-${index}`}><strong>{issue.path || '流程'}</strong> · {issue.message}</li>)}</ul>
  </div>
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString()
}

const kickerStyle = { margin: '0 0 5px', color: COLOR.inkMuted, fontSize: FONT_PX.helper } as const
const titleStyle = { margin: 0, fontSize: FONT_PX.title }
const sectionTitleStyle = { margin: 0, fontSize: 16 }
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body }
const cardStyle = { minWidth: 0, padding: 18, border: `1px solid ${COLOR.line}`, borderRadius: 9, background: COLOR.surface }
const jsonStyle = { maxHeight: 560, overflow: 'auto', padding: 16, borderRadius: 8, background: COLOR.canvas, color: COLOR.ink, fontSize: FONT_PX.helper, whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const }
const buttonStyle = { minHeight: 36, justifySelf: 'start' as const, padding: '0 12px', border: `1px solid ${COLOR.line}`, borderRadius: 7, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer' }
const activeButtonStyle = { ...buttonStyle, background: '#eff3f8', borderColor: '#c2d0df', fontWeight: 650 }
const noticeStyle = { padding: 12, borderRadius: 8, background: '#fff8e9', color: COLOR.warning, fontSize: FONT_PX.body }
const errorStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 14, color: COLOR.danger, background: '#fff1f0', borderRadius: 8 }
