import { PlanMaterialPanel, PlanMaterialList } from './plan-material-panel.tsx'
import { PlanningProgressPanel } from './planning-progress.tsx'
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../api/client.ts'
import type { ResourcesApi } from '../api/resources.ts'
import type { TaskCommands } from '../api/task-commands.ts'
import type { TaskPlanView } from '../../service/task-planning.ts'
import type { TaskRequirement } from '../../core/task-requirements.ts'
import { MODEL_LEVELS } from '../../executor/model-routing.ts'
import { PanelCommandButton } from './shell.tsx'
import { COLOR, FONT_PX } from './tokens.ts'

const checkLabels = {
  workflow: '流程版本', coverage: '目标覆盖', deliverables: '交付物验收',
  tools: '工具可用及授权', dependencies: '执行依赖', risks: '风险及应对',
}
const severityLabels = { low: '低风险', medium: '中风险', high: '高风险' }

function requirementLabel(constraint: TaskRequirement): string {
  switch (constraint.kind) {
    case 'chat_only': return '在本次聊天中交付正文'
    case 'no_workspace_files': return '不创建或修改工作区文件'
    case 'no_workspace_read': return '不读取工作区文件（可用已授权内部材料）'
    case 'no_network': return '执行工具不访问网络（模型服务连接不变）'
    case 'read_only': return '仅执行只读操作'
    case 'no_external_send': return '不通过执行工具向外发送内容'
    case 'no_extra_agents': return '由任务指定的代理执行，返工沿用原有角色'
    case 'report_data_gap': return '如实报告材料缺口，并完成可独立处理的工作'
    case 'preserve_input': return `保持输入材料不变：${constraint.target}`
    case 'approval_before': {
      const reviewer = constraint.reviewer.kind === 'named' ? constraint.reviewer.name : '当前操作人'
      return constraint.scope === 'task' ? `开始任务前由${reviewer}批准`
        : `执行「${constraint.action}」前由${reviewer}批准`
    }
  }
}

function proposalFailure(error: unknown): string {
  if (error instanceof ApiError && error.code === 'OPERATION_TIMEOUT'
      && error.details && typeof error.details === 'object' && 'boundary' in error.details) {
    if (error.details.boundary === 'inactivity') return '等待可用的规划回复超时。已保留输入，可以重试。'
    if (error.details.boundary === 'maximum') return '规划已达到服务的处理时限。已保留输入，可以重试。'
  }
  return error instanceof Error ? error.message : '暂未生成任务计划。'
}

function Brief({ plan }: { plan: TaskPlanView }) {
  const { brief, proposal } = plan
  return <div style={contentStyle}>
    <div><strong>目标</strong><p style={descriptionStyle}>{brief.goal}</p></div>
    {brief.requirements.length > 0 && <div><strong>必须满足</strong>
      <ul style={listStyle}>{brief.requirements.map(({ id, text }) => <li key={id}>{text}</li>)}</ul></div>}
    {brief.requirements_contract && <section aria-label="执行约束">
      <strong>执行约束</strong>
      <p style={descriptionStyle}>{brief.requirements_contract.start_policy === 'plan_only'
        ? '本次只生成计划，后续执行需另行确认。' : '按已确认的执行条件开始任务。'}</p>
      {brief.requirements_contract.constraints.length > 0 && <ul style={listStyle}>
        {brief.requirements_contract.constraints.map(constraint => <li key={constraint.id}>
          {requirementLabel(constraint)}
          <p style={descriptionStyle}>原始要求：{constraint.quote}</p>
        </li>)}
      </ul>}
    </section>}
    <div><strong>交付物与验收条件</strong>
      <ul style={listStyle}>
        {proposal.deliverables.map(({ title, node_id, goal_ids, acceptance }, index) => <li key={index}>
          {title}。
          {acceptance.kind === 'artifact'
            ? `交付文件「${acceptance.file_name}」，内容由你核对。`
            : acceptance.kind === 'chat/text_result' ? '完成后在本次会话直接查看正文。' : '使用系统工具记录核对执行结果。'}
          {/* 文件大小、退出码、目标编号和节点号留给核对用，不占人工阅读主线（P04）。 */}
          <details style={detailStyle}><summary>技术依据</summary>
            <p style={descriptionStyle}>节点 {node_id} · 目标 {goal_ids.join('、')}</p>
            <p style={descriptionStyle}>{acceptance.kind === 'artifact'
              ? `文件规则：至少 ${acceptance.minimum_bytes} 字节。`
              : acceptance.kind === 'tool_evidence'
                ? `工具规则：${acceptance.tool} 退出码为 ${acceptance.exit_code}。`
                : '核对负责步骤提交的正文版本，内容由你审核。'}</p>
          </details>
        </li>)}
      </ul>
    </div>
  </div>
}

export function TaskPlanBrief({ api, taskId }: { api: ResourcesApi; taskId: string }) {
  const [record, setRecord] = useState<{ taskId: string; plan: TaskPlanView } | null>(null)
  useEffect(() => {
    let current = true
    void api.getTaskPlanForTask(taskId).then(({ data }) => {
      if (current) setRecord(data?.launch?.task_id === taskId && data.brief && data.proposal ? { taskId, plan: data } : null)
    }).catch(() => { if (current) setRecord(null) })
    return () => { current = false }
  }, [api, taskId])
  if (record?.taskId !== taskId) return null
  return <section aria-label="已确认任务简报" style={panelStyle}>
    <strong>任务简报</strong><Brief plan={record.plan} /><PlanMaterialList plan={record.plan} api={api}/>
  </section>
}

export type WorkflowPlanRequest = { id: string; version: string; goal: string }
type PlanFormBusy = 'propose' | 'start' | 'discard' | 'materials' | null

type TaskPlanFormProps = {
  api: ResourcesApi; commands: TaskCommands; onStarted?: (taskId: string) => void
  onOpenRun?: (taskId: string, trigger: HTMLButtonElement, runId: string) => void
  workflowRequest?: WorkflowPlanRequest
  onClearWorkflow?: () => void
}

export function TaskPlanForm(props:TaskPlanFormProps) {
  const [source,setSource]=useState({api:props.api,commands:props.commands,epoch:0})
  if(source.api!==props.api || source.commands!==props.commands)
    setSource({api:props.api,commands:props.commands,epoch:source.epoch+1})
  return <TaskPlanFormBody key={source.epoch} {...props}/>
}

function TaskPlanFormBody({api,commands,onStarted,onOpenRun,workflowRequest,onClearWorkflow}:TaskPlanFormProps) {
  const active=useRef(true)
  useEffect(()=>{active.current=true;return()=>{active.current=false}},[])
  const [open, setOpen] = useState(Boolean(workflowRequest))
  const [capability, setCapability] = useState<'loading' | 'enabled' | 'unavailable' | 'error'>('loading')
  const [goal, setGoal] = useState(workflowRequest?.goal ?? '')
  const [criteria, setCriteria] = useState('')
  const [plan, setPlan] = useState<TaskPlanView | null>(null)
  const [draftReadFailed, setDraftReadFailed] = useState(false)
  const [draftRetry, setDraftRetry] = useState(0)
  const [drafts, setDrafts] = useState<TaskPlanView[]>([])
  const [draftPage, setDraftPage] = useState<string | undefined>(undefined)
  const [draftNext, setDraftNext] = useState<string | null>(null)
  const [draftLoading, setDraftLoading] = useState(false)
  const [editingDraft, setEditingDraft] = useState<TaskPlanView | null>(null)
  const scopeVersion = useRef(0)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusyState] = useState<PlanFormBusy>(null)
  const busyRef = useRef<PlanFormBusy>(null)
  // Close the response race immediately, before React commits the disabled UI.
  function setBusy(value: PlanFormBusy | ((previous: PlanFormBusy) => PlanFormBusy)) {
    const next = typeof value === 'function' ? value(busyRef.current) : value
    busyRef.current = next
    setBusyState(next)
  }
  const proposal = useRef<AbortController | null>(null)
  const [proposalCancelled, setProposalCancelled] = useState(false)
  const [failure, setFailure] = useState('')
  useLayoutEffect(() => {
    scopeVersion.current += 1
    setEditingDraft(null)
    setDraftPage(undefined)
    setDraftNext(null)
    setBusy((value) => value === 'propose' ? null : value)
    return () => {
      scopeVersion.current += 1
      proposal.current?.abort()
      proposal.current = null
    }
  }, [api, commands])
  useEffect(() => {
    if (!open) return
    let current = true
    setCapability('loading')
    void api.getTaskPlanCapability().then(({ data }) => {
      if (current) setCapability(data.enabled ? 'enabled' : 'unavailable')
    }).catch(() => { if (current) setCapability('error') })
    return () => { current = false }
  }, [api, open])

  // 生成过但没启动的计划可以取回，不必重填目标（P01）。
  useEffect(() => {
    if (!open || capability !== 'enabled') return
    let current = true
    setDraftReadFailed(false)
    setDraftLoading(true)
    if (!draftPage) setDrafts([])
    void api.listPlanDrafts(undefined, draftPage).then(({ data }) => {
      if (!current) return
      setDrafts(previous => draftPage ? [...new Map([...previous, ...data.items].map(item => [item.plan_id, item])).values()] : data.items)
      setDraftNext(data.next_cursor ?? null)
    }).catch(() => { if (current) setDraftReadFailed(true) })
      .finally(() => { if (current) setDraftLoading(false) })
    return () => { current = false }
  }, [api, open, capability, draftRetry, draftPage])

  function resume(draft: TaskPlanView) {
    if (busyRef.current !== null) return
    setEditingDraft(null)
    setGoal(draft.brief.goal)
    setCriteria(draft.brief.requirements.map((entry) => entry.text).join('\n'))
    setFailure('')
    setConfirmed(false)
    setPlan(draft)
  }

  async function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busyRef.current || proposal.current || !goal.trim()) return
    const requirements = criteria.split('\n').map((entry) => entry.trim()).filter(Boolean)
    if (requirements.length > 12 || requirements.some((entry) => entry.length > 300)) {
      setFailure('最多 12 项要求，每项不超过 300 字。')
      return
    }
    const request = new AbortController()
    proposal.current = request
    setProposalCancelled(false)
    setBusy('propose')
    setFailure('')
    setConfirmed(false)
    try {
      const pin = workflowRequest
        ? { workflow_id: workflowRequest.id, workflow_version: workflowRequest.version }
        : editingDraft?.brief.workflow_id ? { workflow_id: editingDraft.brief.workflow_id,
          workflow_version: editingDraft.brief.workflow_version } : undefined
      const revises = editingDraft ? { plan_id: editingDraft.plan_id, content_hash: editingDraft.content_hash } : undefined
      const proposed = await commands.proposeTaskPlan(goal.trim(), requirements, request.signal, pin, revises)
      if (proposal.current !== request) return
      if (workflowRequest && (proposed.proposal.workflow_id !== workflowRequest.id
        || proposed.proposal.workflow_version !== workflowRequest.version)) {
        setFailure('主脑给出的流程或版本与所选流程不同。请调整目标或重新选择已发布流程。')
        return
      }
      setPlan(proposed)
      setEditingDraft(null)
      setDraftPage(undefined)
      setDraftRetry(value => value + 1)
    } catch (error) {
      if (proposal.current === request) setFailure(proposalFailure(error))
    } finally {
      if (proposal.current === request) {
        proposal.current = null
        setBusy(null)
      }
    }
  }

  async function start() {
    if (busyRef.current || !confirmed || !plan?.quality.ready || plan.launch) return
    const version = scopeVersion.current
    setBusy('start')
    setFailure('')
    try {
      const launch = await commands.confirmTaskPlan(plan.plan_id, plan.content_hash)
      if (!active.current || version !== scopeVersion.current) return
      setPlan({ ...plan, launch })
      setDrafts(items => items.filter(item => item.plan_id !== plan.plan_id))
      onStarted?.(launch.task_id)
    } catch (error) {
      if (version === scopeVersion.current) setFailure(error instanceof Error ? error.message : '暂未获取启动回执。')
    } finally { if (version === scopeVersion.current) setBusy(null) }
  }

  async function discard(draft: TaskPlanView) {
    if (busyRef.current) return
    const version = scopeVersion.current
    setBusy('discard')
    setFailure('')
    try {
      await commands.discardTaskPlan(draft.plan_id, draft.content_hash)
      if (version !== scopeVersion.current) return
      setDraftPage(undefined)
      setDraftRetry(value => value + 1)
      if (plan?.plan_id === draft.plan_id) setPlan(null)
      if (editingDraft?.plan_id === draft.plan_id) setEditingDraft(null)
      setConfirmed(false)
    } catch (error) {
      if (version === scopeVersion.current) setFailure(error instanceof Error ? error.message : '计划尚未放弃，请重试。')
    } finally { if (version === scopeVersion.current) setBusy(null) }
  }

  return <><PlanningProgressPanel api={api} disabled={busy !== null} onResume={value=>{
    if (busyRef.current !== null) return
    setOpen(true);resume(value)
  }}/><details style={panelStyle} open={open} onToggle={(event) => {
    if (event.target !== event.currentTarget) return
    const opened = event.currentTarget.open
    if (!opened && proposal.current) {
      proposal.current.abort()
      proposal.current = null
      setBusy(null)
      setProposalCancelled(true)
    }
    setOpen(opened)
  }}>
    <summary>用自然语言规划任务</summary>
    <div style={contentStyle}>
      {workflowRequest && <button type="button" disabled={busy === 'start'} style={editStyle} onClick={onClearWorkflow}>
        不指定流程，从目标开始
      </button>}
      {draftReadFailed && <p aria-live="polite">未能读取未启动的计划。 <button className="ops-button" type="button"
        onClick={() => setDraftRetry(n => n + 1)}>重新读取</button></p>}
      {draftLoading && <p style={descriptionStyle} aria-live="polite">正在读取未启动的计划…</p>}
      {draftNext && !draftReadFailed && <button className="ops-button" type="button" disabled={draftLoading || busy !== null}
        onClick={() => setDraftPage(draftNext)}>加载更早的计划</button>}
      {drafts.length > 0 && <details style={detailStyle} open={!plan && drafts.length > 0}>
        <summary>继续未启动的计划（{drafts.length}）</summary>
        <ul style={listStyle}>
          {drafts.map((draft) => <li key={draft.plan_id}>
            <button type="button" style={editStyle} disabled={busy !== null} onClick={() => resume(draft)}>{draft.proposal.title}</button>
            <span style={descriptionStyle}> · {draft.proposal.steps.length} 步 · {formatDraftTime(draft)}</span>
            <PanelCommandButton disabled={busy !== null} onClick={() => { void discard(draft) }}>放弃计划</PanelCommandButton>
          </li>)}
        </ul>
        <p style={descriptionStyle}>取回后会重新显示计划内容，确认启动前仍可修改目标与要求。</p>
      </details>}
      {capability === 'loading' && <p role="status" style={descriptionStyle}>检查主脑规划服务…</p>}
      {capability === 'unavailable' && <p role="status" style={descriptionStyle}>当前宿主尚未启用主脑规划。</p>}
      {capability === 'error' && <p role="alert" style={descriptionStyle}>暂时无法获取主脑规划状态。</p>}
      {capability === 'enabled' && !plan && <div>
        <p style={descriptionStyle}>需要本地材料时，请先在这里生成计划，再在「为本次任务补充材料」中选择文件和可读取步骤，最后确认启动。</p>
        <form onSubmit={(event) => { void propose(event) }} style={contentStyle} aria-busy={busy === 'propose'}>
          <label style={contentStyle}>要完成什么
            <textarea className="ops-field" required rows={3} maxLength={2000} value={goal} disabled={busy !== null} autoFocus={Boolean(workflowRequest)}
              placeholder="例如，复核本周项目交付清单并整理差异" onChange={(event) => setGoal(event.target.value)} />
          </label>
          <label style={contentStyle}>必须满足的要求（可选，每行一项）
            <textarea className="ops-field" rows={2} maxLength={3612} value={criteria} disabled={busy !== null}
              onChange={(event) => setCriteria(event.target.value)} />
          </label>
          <PanelCommandButton type="submit" disabled={busy !== null || !goal.trim()}>{busy === 'propose' ? '正在规划…' : '生成计划'}</PanelCommandButton>
        </form>
        <div role="status" aria-atomic="true">
          {busy === 'propose' && <p style={descriptionStyle}>
            正在生成计划。如果没有合适的已发布流程，可能会先生成流程，再编排步骤。收起表单会取消这次生成，输入会保留。
          </p>}
          {proposalCancelled && <p style={descriptionStyle}>已取消生成，输入已保留。可以重新生成计划。</p>}
        </div>
      </div>}
      {editingDraft && <p style={descriptionStyle}>正在调整「{editingDraft.proposal.title}」。新计划保存成功后，原计划将被替代。
        {editingDraft.brief.requirements_contract && '原有执行约束和指定流程版本会继续保留；需要解除约束或改用另一流程时，请新建任务并重新核对。'}
      </p>}
      {plan && <section style={contentStyle} aria-label="计划复核">
        <h2 style={headingStyle}>{plan.proposal.title}</h2>
        <details style={detailStyle}><summary>固定流程版本</summary>
          <p>{plan.proposal.workflow_id} · v{plan.proposal.workflow_version}</p>
        </details>
        <Brief plan={plan} />
        <div>
          <strong>{plan.quality.ready ? '质量检查通过，待你确认' : '质量检查发现阻断项'}</strong>
          {plan.quality.checks.filter(check => !check.passed).map(check => <div key={check.check}>
            {checkLabels[check.check]}需要调整
            <ul style={listStyle}>{check.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
          </div>)}
        </div>
        {plan.proposal.risks.length > 0 && <section aria-label="确认前要了解的风险">
          <strong>确认前要了解的风险</strong>
          {plan.proposal.risks.map((risk, index) => <p key={index} style={descriptionStyle}>
            {severityLabels[risk.severity]} · {risk.description}。{risk.mitigation}
          </p>)}
        </section>}
        <details>
          <summary>步骤与模型建议</summary>
          <ul style={listStyle}>{plan.proposal.steps.map((step, index) => <li key={index}>
            {step.description} · {MODEL_LEVELS[step.complexity].label}。{step.model_reason}
            <details style={detailStyle}><summary>技术依据</summary>
              <p style={descriptionStyle}>步骤编号 {step.node_id} · 依赖 {step.depends_on.length > 0 ? step.depends_on.join('、') : '无'} · 工具 {step.tools.length > 0 ? step.tools.join('、') : '未指定'}</p>
            </details>
            {step.preferred_model_ref && <span> · 建议模型 {step.preferred_model_ref}</span>}
          </li>)}</ul>

        </details>
        {!plan.launch && <PlanMaterialPanel key={plan.plan_id} plan={plan} api={api} commands={commands}
          onPlan={next=>{setPlan(next);setConfirmed(false);setDraftPage(undefined);setDraftRetry(n=>n+1);setBusy(null)}}
          onBusy={value=>setBusy(value?'materials':null)}/>}
        {plan.launch && <PlanMaterialList plan={plan} api={api}/>}
        {!plan.launch && <div style={contentStyle}>
          {plan.quality.ready && <>
            <label><input type="checkbox" checked={confirmed} disabled={busy !== null}
              onChange={(event) => setConfirmed(event.target.checked)} /> 我已核对目标、执行约束、交付物、风险和固定流程版本。</label>
            <PanelCommandButton disabled={!confirmed || busy !== null} onClick={() => { void start() }}>
              {busy === 'start' ? '正在取得启动回执…' : '确认后启动任务'}
            </PanelCommandButton>
          </>}
          <button type="button" disabled={busy !== null} style={editStyle}
            onClick={() => { setEditingDraft(plan); setPlan(null); setConfirmed(false); setFailure('') }}>调整目标并重新规划</button>
          <PanelCommandButton disabled={busy !== null} onClick={() => { void discard(plan) }}>放弃这份计划</PanelCommandButton>
        </div>}
        {plan.launch && <div>
          <p role="status" style={descriptionStyle}>已建立受监督的任务运行。</p>
          {onOpenRun && <button className="ops-button" type="button" onClick={(event) => {
            if (plan.launch) onOpenRun(plan.launch.task_id, event.currentTarget, plan.launch.run_id)
          }}>查看本次运行</button>}
        </div>}
      </section>}
      {failure && <p role="alert" style={{ ...descriptionStyle, color: COLOR.danger }}>{failure}</p>}
    </div>
  </details></>
}

const panelStyle = { padding: 20, border: `1px solid ${COLOR.line}`, borderRadius: 12, background: COLOR.surface, color: COLOR.ink }
const contentStyle = { display: 'grid', gap: 8, marginTop: 5, fontSize: FONT_PX.body, minWidth: 0 }
const headingStyle = { fontSize: FONT_PX.section, margin: '4px 0' }
const descriptionStyle = { margin: '4px 0', color: COLOR.inkMuted, overflowWrap: 'anywhere' as const }
const detailStyle = { marginTop: 4, fontSize: FONT_PX.menu, color: COLOR.inkMuted }
const formatDraftTime = (draft: TaskPlanView) => draft.created_at ? draft.created_at.slice(0, 16).replace('T', ' ') : '时间未记录'
const listStyle = { margin: '5px 0', paddingLeft: 22, overflowWrap: 'anywhere' as const }
const editStyle = { justifySelf: 'start' as const, color: COLOR.ink, background: COLOR.surface, border: `1px solid ${COLOR.line}`, borderRadius: 8, minHeight: 44, padding: '0 14px' }
