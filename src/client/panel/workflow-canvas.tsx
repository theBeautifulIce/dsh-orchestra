import { useEffect, useRef, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { RunSummary, WorkflowView } from '../api/types.ts'
import type { WorkflowCommandsApi } from '../api/workflow-commands.ts'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { WorkflowCanvasView } from './workflow-canvas-view.tsx'
import { WorkflowEditor } from './workflow-editor.tsx'
import { taskOriginLabel, taskStatusView } from './tasks-screen.tsx'
import { PanelCommandButton } from './shell.tsx'
import { WorkflowStatusBadge } from './workflow-list.tsx'
import { formatTaskDate, runDuration } from './task-run-steps.tsx'
import { readCanvasDoc } from './workflow-canvas-nodes.tsx'
import { WorkflowDependencyView } from './workflow-dependency-view.tsx'

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
  const [confirmStatus, setConfirmStatus] = useState(false)
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusProblem, setStatusProblem] = useState('')

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

  const status = workflow?.workflow.status
  const changeable = status === 'active' || status === 'disabled'
  const action = status === 'active' ? '停用' : '启用'
  const reload = () => setRetry((value) => value + 1)
  async function changeStatus() {
    if (!commands?.setWorkflowStatus || !changeable || statusBusy || failed) return
    setStatusBusy(true)
    setStatusProblem('')
    try {
      await commands.setWorkflowStatus({ workflow_id: workflowId, status: status === 'active' ? 'disabled' : 'active', expected_status: status })
      setConfirmStatus(false)
    } catch (cause) {
      setStatusProblem(cause instanceof Error ? cause.message : '无法确认 Workflow 状态')
    } finally {
      setStatusBusy(false)
      reload()
    }
  }
  return <section aria-labelledby="workflow-canvas-title" className="ops-page">
    <header className="ops-page-header">
      <div>
        <button type="button" onClick={onBack} className="ops-button ops-button--link" style={{ paddingInline: 0 }}>← 返回流程列表</button>
        <h1 id="workflow-canvas-title">{workflow?.workflow.name ?? 'Workflow 详情'}</h1>
        {workflow && <div className="ops-actions ops-meta">
          <WorkflowStatusBadge status={workflow.workflow.status} />
          <span>{workflow.current ? `已发布 v${workflow.current.version}` : '未发布'}</span>
          {workflow.draft && <span className="ops-status" data-tone="info">草稿 · 修订 {workflow.draft.revision}</span>}
          {workflow.workflow.node_count !== null && <span>{workflow.workflow.node_count} 步</span>}
          <span>{workflow.workflow.active_task_count} 个活跃任务</span>
        </div>}
      </div>
      {commands?.setWorkflowStatus && changeable && <PanelCommandButton className="ops-button" aria-expanded={confirmStatus}
        disabled={statusBusy || loading || failed} onClick={() => setConfirmStatus((open) => !open)}>{action} Workflow</PanelCommandButton>}
    </header>
    {confirmStatus && changeable && <div className="ops-surface ops-inset ops-toolbar">
      <span>{status === 'active' ? '停用会阻止新任务和后续触发；已创建的运行继续执行。' : '启用后可以启动新任务，已启用的触发器按原配置运行。'}</span>
      <div className="ops-actions">
        <button className="ops-button" type="button" onClick={() => setConfirmStatus(false)} disabled={statusBusy}>取消</button>
        <PanelCommandButton className="ops-button ops-button--primary" disabled={statusBusy || loading || failed} onClick={() => { void changeStatus() }}>确认{action}</PanelCommandButton>
      </div>
    </div>}
    {statusProblem && <p role="alert" className="ops-meta">{statusProblem}</p>}
    {failed && <div role="alert" style={errorStyle}><span>{COPY.queryFailed}</span><button type="button" onClick={reload} className="ops-button">{COPY.retry}</button></div>}
    {loading && !workflow && <p role="status" className="ops-meta">正在读取流程定义…</p>}
    {workflow && <>
      <div role="group" aria-label="流程视图" className="ops-tabs">
        <button type="button" aria-pressed={view === 'design'} onClick={() => setView('design')}>设计画布</button>
        <button type="button" aria-pressed={view === 'versions'} onClick={() => setView('versions')}>版本记录</button>
        <button type="button" aria-pressed={view === 'runs'} onClick={() => setView('runs')}>运行记录</button>
      </div>
      <div hidden={view !== 'design'}>
        <div className="ops-stack">
          {(!commands || !workflow.draft) && <DefinitionPanel definition={workflow.draft?.definition ?? workflow.current?.definition ?? null} />}
          {commands && <WorkflowEditor commands={commands} workflow={workflow} onRefresh={reload} snapshotStale={failed} />}
          {!commands && (workflow.validation.errors.length > 0 || workflow.validation.warnings.length > 0) &&
            <section className="ops-surface ops-inset" aria-label="检查结果">
              <IssueGroup title="需要修正" issues={workflow.validation.errors} tone="error" />
              <IssueGroup title="提醒" issues={workflow.validation.warnings} tone="warning" />
            </section>}
        </div>
      </div>
      {view === 'runs' && <>
        <WorkflowRuns api={api} workflowId={workflowId} reloadVersion={reloadVersion} onSnapshot={onSnapshot} onOpenRun={onOpenRun} />
        {workflow.recent_tests && <section aria-labelledby="workflow-tests-title" className="ops-surface">
          <header className="ops-surface-head"><h2 id="workflow-tests-title">结构与模拟流转测试记录</h2></header>
          <div className="ops-inset">
          {workflow.recent_tests.length === 0 && <p style={mutedStyle}>此流程尚无结构与模拟流转测试记录。</p>}
          {workflow.recent_tests.map((test) => <details key={test.test_id}>
            <summary>修订 {test.revision} · {test.passed ? '结构与模拟流转测试通过' : '结构与模拟流转测试未通过'} · {formatDate(test.tested_at)}</summary>
            {test.passed
              ? <ol>{test.order.map((step) => <li key={step.node_id}>{step.title}</li>)}</ol>
              : <ul>{test.issues.errors.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>}
          </details>)}
          </div>
        </section>}
      </>}
      {view === 'versions' && <section aria-labelledby="workflow-versions-title" className="ops-surface">
        <header className="ops-surface-head"><h2 id="workflow-versions-title">已发布版本</h2></header>
        {workflow.versions.length === 0 ? <p className="ops-empty">还没有已发布版本。</p> :
          <div className="ops-table-scroll"><table className="ops-table"><thead><tr><th>版本</th><th>发布时间</th><th>发布说明</th></tr></thead>
          <tbody>{workflow.versions.map((version) => <tr key={version.version}>
            <td><strong>v{version.version}</strong>{workflow.current?.version === version.version && <span className="ops-status" data-tone="info" style={{ marginLeft: 6 }}>当前</span>}</td>
            <td><time dateTime={version.published_at}>{formatDate(version.published_at)}</time></td><td>{version.publish_note || '—'}</td>
          </tr>)}</tbody></table></div>}
      </section>}
    </>}
  </section>
}

function DefinitionPanel({ definition }: { definition: unknown }) {
  const doc = readCanvasDoc(definition)
  return <section aria-labelledby="workflow-definition-title" className="ops-surface">
    <header className="ops-surface-head"><h2 id="workflow-definition-title">流程定义</h2><span className="ops-status">只读</span></header>
    {definition == null ? <p className="ops-empty">流程定义暂不可用。</p> : <div className="ops-inset">
      {doc && <WorkflowDependencyView doc={doc} />}
      <WorkflowCanvasView definition={definition} readOnly runtimeCompact inspectNodes workspace canvasId="published-canvas" />
      <details><summary>查看定义 JSON</summary><pre style={jsonStyle}>{JSON.stringify(definition, null, 2)}</pre></details>
    </div>}
  </section>
}

function WorkflowRuns({ api, workflowId, reloadVersion, onSnapshot, onOpenRun }: Pick<WorkflowCanvasProps, 'api' | 'workflowId' | 'reloadVersion' | 'onSnapshot' | 'onOpenRun'>) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [retry, refresh] = useState(0)
  const [cursor, setCursor] = useState<string>()
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const lastGeneration = useRef(reloadVersion)
  useEffect(() => {
    if (lastGeneration.current === reloadVersion) return
    lastGeneration.current = reloadVersion
    setCursor(undefined)
    refresh((value) => value + 1)
  }, [reloadVersion])

  useEffect(() => {
    let current = true
    setFailed(false)
    setLoading(true)
    void api.listRuns({ workflow_id: workflowId, limit: 30, cursor }).then(({ data, as_of_seq }) => {
      if (!current) return
      setRuns((prior) => cursor ? [...prior ?? [], ...data.items.filter((run) => !prior?.some((item) => item.run_id === run.run_id))] : data.items)
      setNext(data.next_cursor ?? null)
      onSnapshot?.(as_of_seq)
    }).catch(() => { if (current) setFailed(true) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, workflowId, onSnapshot, retry, cursor])

  return <section aria-label="历史运行" className="ops-surface">
    <header className="ops-surface-head"><h2>历史运行</h2></header>
    {failed && <div role="alert" className="ops-empty">{COPY.queryFailed} <button type="button" className="ops-button" onClick={() => { setCursor(undefined); refresh((value) => value + 1) }}>{COPY.retry}</button></div>}
    {!failed && !runs && <p role="status" className="ops-empty">正在读取运行记录…</p>}
    {!failed && runs?.length === 0 && <p className="ops-empty">此流程还没有运行记录。</p>}
    {runs && runs.length > 0 && <div className="ops-table-scroll"><table className="ops-table ops-table--wide">
      <thead><tr><th>任务</th><th>结果</th><th>版本</th><th>触发方式</th><th>开始时间</th><th>耗时</th></tr></thead>
      <tbody>{runs.map((run) => <tr key={run.run_id}>
        <td>{onOpenRun && run.task_id
          ? <button type="button" className="ops-button ops-button--link" style={{ whiteSpace: 'normal', textAlign: 'left' }} onClick={() => onOpenRun(run.task_id, run.run_id)}>{run.task_title || '查看任务运行'}</button>
          : <strong>{run.task_title || '未命名任务'}</strong>}
          <details><summary>查看运行登记明细</summary><p>运行编号 <code>{run.run_id}</code> · 状态 <code>{run.status}</code></p></details></td>
        <td><span className="ops-status">{taskStatusView(run.status, run.display_status).label ?? COPY.oldPanel}</span></td>
        <td>{run.workflow_version === null ? '—' : `v${run.workflow_version}`}</td>
        <td>{taskOriginLabel(run)}</td><td><time dateTime={run.started_at ?? run.created_at}>{formatTaskDate(run.started_at ?? run.created_at)}</time></td>
        <td>{runDuration(run.started_at, run.ended_at) ?? '—'}</td>
      </tr>)}</tbody>
    </table></div>}
    {next && !failed && <div className="ops-inset"><button type="button" disabled={loading} className="ops-button" onClick={() => setCursor(next)}>加载更早的运行</button></div>}
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

const sectionTitleStyle = { margin: 0, fontSize: 16 }
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body }
const jsonStyle = { maxHeight: 560, overflow: 'auto', padding: 16, borderRadius: 8, background: COLOR.canvas, color: COLOR.ink, fontSize: FONT_PX.helper, whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const }
const errorStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 14, color: COLOR.danger, background: '#fff1f0', borderRadius: 8 }
