import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../api/client.ts'
import type { ResourcesApi } from '../api/resources.ts'
import type { TaskCommands } from '../api/task-commands.ts'
import type { TaskPlanView } from '../../service/task-planning.ts'
import { MODEL_LEVELS } from '../../executor/model-routing.ts'
import { PanelCommandButton } from './shell.tsx'
import { COLOR, FONT_PX } from './tokens.ts'

const checkLabels = {
  workflow: '流程版本', coverage: '目标覆盖', deliverables: '交付物验收',
  tools: '工具可用及授权', dependencies: '执行依赖', risks: '风险及应对',
}
const severityLabels = { low: '低风险', medium: '中风险', high: '高风险' }

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
      <ul style={listStyle}>{brief.requirements.map(({ id, text }) => <li key={id}>{id} · {text}</li>)}</ul></div>}
    <div><strong>交付物与验收条件</strong>
      <ul style={listStyle}>
        {proposal.deliverables.map(({ title, node_id, goal_ids, acceptance }, index) => <li key={index}>
          {title} · {goal_ids.join('、')} · 由 {node_id} 提交。
          {acceptance.kind === 'artifact'
            ? `验收文件「${acceptance.file_name}」至少 ${acceptance.minimum_bytes} 字节。`
            : `验收需有 ${acceptance.tool} 退出码为 ${acceptance.exit_code} 的系统证据。`}
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
    <strong>任务简报</strong><Brief plan={record.plan} />
  </section>
}

export function TaskPlanForm({ api, commands, onStarted, onOpenRun }: {
  api: ResourcesApi; commands: TaskCommands; onStarted?: (taskId: string) => void
  onOpenRun?: (taskId: string, trigger: HTMLButtonElement, runId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [capability, setCapability] = useState<'loading' | 'enabled' | 'unavailable' | 'error'>('loading')
  const [goal, setGoal] = useState('')
  const [criteria, setCriteria] = useState('')
  const [plan, setPlan] = useState<TaskPlanView | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState<'propose' | 'start' | null>(null)
  const proposal = useRef<AbortController | null>(null)
  const [proposalCancelled, setProposalCancelled] = useState(false)
  const [failure, setFailure] = useState('')
  useLayoutEffect(() => {
    setBusy((value) => value === 'propose' ? null : value)
    return () => {
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

  async function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || proposal.current || !goal.trim()) return
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
      const proposed = await commands.proposeTaskPlan(goal.trim(), requirements, request.signal)
      if (proposal.current === request) setPlan(proposed)
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
    if (busy || !confirmed || !plan?.quality.ready || plan.launch) return
    setBusy('start')
    setFailure('')
    try {
      const launch = await commands.confirmTaskPlan(plan.plan_id, plan.content_hash)
      setPlan({ ...plan, launch })
      onStarted?.(launch.task_id)
    } catch (error) { setFailure(error instanceof Error ? error.message : '暂未获取启动回执。') }
    finally { setBusy(null) }
  }

  return <details style={panelStyle} onToggle={(event) => {
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
      {capability === 'loading' && <p role="status" style={descriptionStyle}>检查主脑规划服务…</p>}
      {capability === 'unavailable' && <p role="status" style={descriptionStyle}>当前宿主尚未启用主脑规划。</p>}
      {capability === 'error' && <p role="alert" style={descriptionStyle}>暂时无法获取主脑规划状态。</p>}
      {capability === 'enabled' && !plan && <div>
        <form onSubmit={(event) => { void propose(event) }} style={contentStyle} aria-busy={busy === 'propose'}>
          <label style={contentStyle}>要完成什么
            <textarea required rows={3} maxLength={2000} value={goal} disabled={busy !== null}
              placeholder="例如，复核本周项目交付清单并整理差异" onChange={(event) => setGoal(event.target.value)} />
          </label>
          <label style={contentStyle}>必须满足的要求（可选，每行一项）
            <textarea rows={2} maxLength={3612} value={criteria} disabled={busy !== null}
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
      {plan && <section style={contentStyle} aria-label="计划复核">
        <h2 style={headingStyle}>{plan.proposal.title}</h2>
        <p style={descriptionStyle}>{plan.proposal.workflow_id} · 固定 v{plan.proposal.workflow_version}</p>
        <Brief plan={plan} />
        <div>
          <strong>{plan.quality.ready ? '质量检查通过，待你确认' : '质量检查发现阻断项'}</strong>
          <ul style={listStyle}>{plan.quality.checks.map((check) => <li key={check.check}>
            {checkLabels[check.check]} · {check.passed ? '通过' : '需要调整'}
            {!check.passed && <ul style={listStyle}>{check.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
          </li>)}</ul>
        </div>
        <details>
          <summary>步骤、模型建议与风险</summary>
          <ul style={listStyle}>{plan.proposal.steps.map((step, index) => <li key={index}>
            <strong>{step.node_id}</strong> · {step.description} · {MODEL_LEVELS[step.complexity].label}。{step.model_reason}
            {step.preferred_model_ref && <span> · 建议模型 {step.preferred_model_ref}</span>}
            {step.depends_on.length > 0 && <p style={descriptionStyle}>依赖 {step.depends_on.join('、')}</p>}
            {step.tools.length > 0 && <p style={descriptionStyle}>工具 {step.tools.join('、')}</p>}
          </li>)}</ul>
          {plan.proposal.risks.map((risk, index) => <p key={index} style={descriptionStyle}>
            {severityLabels[risk.severity]} · {risk.description}。应对措施为{risk.mitigation}。
          </p>)}
        </details>
        {!plan.launch && <div style={contentStyle}>
          {plan.quality.ready && <>
            <label><input type="checkbox" checked={confirmed} disabled={busy !== null}
              onChange={(event) => setConfirmed(event.target.checked)} /> 我已核对目标、交付物、风险和固定流程版本。</label>
            <PanelCommandButton disabled={!confirmed || busy !== null} onClick={() => { void start() }}>
              {busy === 'start' ? '正在取得启动回执…' : '确认后启动任务'}
            </PanelCommandButton>
          </>}
          <button type="button" disabled={busy !== null} style={editStyle}
            onClick={() => { setPlan(null); setConfirmed(false); setFailure('') }}>调整目标并重新规划</button>
        </div>}
        {plan.launch && <div>
          <p role="status" style={descriptionStyle}>已建立受监督的任务运行。</p>
          {onOpenRun && <button type="button" onClick={(event) => {
            if (plan.launch) onOpenRun(plan.launch.task_id, event.currentTarget, plan.launch.run_id)
          }}>查看本次运行</button>}
        </div>}
      </section>}
      {failure && <p role="alert" style={{ ...descriptionStyle, color: COLOR.danger }}>{failure}</p>}
    </div>
  </details>
}

const panelStyle = { padding: 12, border: `1px solid ${COLOR.line}`, borderRadius: 8, background: COLOR.surface, color: COLOR.ink }
const contentStyle = { display: 'grid', gap: 8, marginTop: 5, fontSize: FONT_PX.body, minWidth: 0 }
const headingStyle = { fontSize: FONT_PX.section, margin: '4px 0' }
const descriptionStyle = { margin: '4px 0', color: COLOR.inkMuted, overflowWrap: 'anywhere' as const }
const listStyle = { margin: '5px 0', paddingLeft: 22, overflowWrap: 'anywhere' as const }
const editStyle = { justifySelf: 'start' as const, color: COLOR.ink, background: COLOR.surface, border: `1px solid ${COLOR.line}`, borderRadius: 5, minHeight: 36 }
