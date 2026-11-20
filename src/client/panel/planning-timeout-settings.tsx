import { useEffect, useState } from 'react'
import type { PlanningSettingsView, PlanningTimeoutValues } from '../../service/planning-settings.ts'
import { ApiError, type ApiClient } from '../api/client.ts'
import { postWithOperationReceipt } from '../api/commands.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import { PanelCommandButton } from './shell.tsx'
import { PLANNING_TIMEOUT_STYLES } from './planning-timeout-styles.ts'

const PATH = '/v1/settings/planning-timeouts'
const groups = [
  { title: '非流式阶段', fields: [
    ['task_seconds', '任务规划', '每次调用主脑的时限，也适用于任务内自动生成流程。'],
    ['workflow_seconds', '独立流程生成', '从流程页单独生成草稿时，每次调用主脑的时限。'],
  ] },
  { title: '流式阶段', fields: [
    ['idle_seconds', '无新输出等待', '从阶段开始计时，收到新的推理或正文后重新计时。'],
    ['stage_seconds', '单阶段总时长', '从调用主脑起计时，持续输出也不会延长此上限。'],
  ] },
  { title: '请求上限', fields: [
    ['request_seconds', '整次规划总时长', '从宿主开始处理请求起计时，涵盖选择流程、自动生成流程和规划。'],
  ] },
] as const
const fields = groups.flatMap((group) => [...group.fields])
const branchNames = { streaming: '流式', fixed: '非流式', unavailable: '未装配' } as const
type Field = keyof PlanningTimeoutValues
type Draft = Record<Field, string>
type Command = { operation_id: string; expected_revision: number; values: PlanningTimeoutValues | null }
const toDraft = (values: PlanningTimeoutValues): Draft => Object.fromEntries(fields.map(([key]) => [key, String(values[key])])) as Draft

export function PlanningTimeoutSettings({ client, reloadVersion = 0, onSnapshot }: {
  client: ApiClient; reloadVersion?: number; onSnapshot?: (seq: number) => void
}) {
  const [saved, setSaved] = useState<PlanningSettingsView>()
  const [draft, setDraft] = useState<Draft>()
  const [reload, setReload] = useState(0)
  const [loaded, setLoaded] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Command>()
  const [notice, setNotice] = useState<{ message: string; error?: boolean; field?: Field }>()
  const version = reloadVersion + ':' + reload
  useEffect(() => {
    let active = true
    void client.get<PlanningSettingsView>(PATH).then(({ data, as_of_seq }) => {
      if (!active) return
      setSaved(data); setDraft(toDraft(data.values)); setLoaded(version)
      onSnapshot?.(as_of_seq)
    }).catch(() => { if (active) setNotice({ message: '暂时无法读取规划时限。', error: true }) })
    return () => { active = false }
  }, [client, onSnapshot, version])

  async function save(reset: boolean) {
    if (!saved || !draft || busy || (!pending && loaded !== version)) return
    let values: PlanningTimeoutValues | null = null
    if (!pending && !reset) {
      values = Object.fromEntries(fields.map(([key]) => [key, Number(draft[key])])) as PlanningTimeoutValues
      const invalid = fields.find(([key]) => !Number.isInteger(values![key]) || values![key] < 1 || values![key] > saved.limits[key])
      if (invalid || values.idle_seconds > values.stage_seconds || values.stage_seconds > values.request_seconds
        || values.task_seconds > values.request_seconds || values.workflow_seconds > values.request_seconds) {
        setNotice({ error: true, field: invalid?.[0], message: invalid ? `${invalid[1]}请输入 1–${saved.limits[invalid[0]]} 的整数秒。`
          : '无新输出等待不能长于流式单阶段总时长。任何单阶段时限都不能长于整次规划总时长。' })
        return
      }
    }
    const command = pending ?? { operation_id: newOperationId(), expected_revision: saved.revision, values }
    setBusy(true); setNotice(undefined)
    try {
      await postWithOperationReceipt(client, PATH, 'planning_timeouts.save', command)
      setPending(undefined)
      setNotice({ message: command.values ? '已保存。仅从新发起的规划请求开始生效。' : '已恢复默认。仅从新发起的规划请求开始生效。' })
      setReload((value) => value + 1)
    } catch (error) {
      setPending(error instanceof ApiError && error.code === 'OPERATION_OUTCOME_UNKNOWN' ? command : undefined)
      setNotice({ error: true, message: error instanceof Error ? error.message : '保存结果暂不可确认。' })
    } finally { setBusy(false) }
  }

  return <section className="ops-surface planning-timeouts" aria-labelledby="planning-timeouts-title">
    <style>{PLANNING_TIMEOUT_STYLES}</style>
    <header className="ops-surface-head"><h2 id="planning-timeouts-title">规划时限</h2></header>
    <form className="planning-timeouts-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(false) }}>
      <p className="planning-timeouts-intro">仅对当前会话中新发起的任务规划和流程草稿生成生效。已开始的规划、任务执行、返工与记忆整理沿用各自的时限。</p>
      {saved && draft && <>
        <div className="planning-timeouts-context">
          <dl aria-label="当前宿主规划方式">
            <div><dt>任务规划</dt><dd>{branchNames[saved.branches.task]}</dd></div>
            <div><dt>自动生成流程</dt><dd>{branchNames[saved.branches.automatic_workflow]}</dd></div>
            <div><dt>独立流程生成</dt><dd>{branchNames[saved.branches.standalone_workflow]}</dd></div>
          </dl>
          {saved.legacy_timeout_ms !== null && !saved.overridden && <p>未保存自定义时限时，任务内的各阶段沿用宿主设定的 {saved.legacy_timeout_ms / 1000} 秒。独立流程生成使用下列默认值。</p>}
        </div>
        {groups.map(({ title, fields: groupFields }) => <fieldset key={title} className="planning-timeouts-group">
          <legend>{title}</legend>
          {groupFields.map(([key, label, description]) => <div key={key} className="planning-timeouts-row">
            <label htmlFor={`planning-${key}`}>{label}</label>
            <div className="planning-timeouts-value">
              <input id={`planning-${key}`} className="ops-field" type="number" min={1} max={saved.limits[key]} step={1}
                aria-describedby={`budget-${key} budget-limits-${key}`}
                aria-invalid={notice?.field === key || undefined}
                disabled={busy || Boolean(pending) || loaded !== version} value={draft[key]}
                onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
              <span aria-hidden="true">秒</span>
            </div>
            <div className="planning-timeouts-help">
              <p id={`budget-${key}`}>{description}</p>
              <p id={`budget-limits-${key}`}>范围 1–{saved.limits[key]} 秒 · 默认 {saved.defaults[key]} 秒</p>
            </div>
          </div>)}
        </fieldset>)}
      </>}
      <div className="planning-timeouts-footer">
        <div className="ops-actions">
          {saved && draft && <>
            <PanelCommandButton className="ops-button ops-button--primary" type="submit"
              disabled={busy || (!pending && loaded !== version)}>{pending ? '查询或重试' : '保存规划时限'}</PanelCommandButton>
            <PanelCommandButton className="ops-button" type="button"
              disabled={busy || Boolean(pending) || loaded !== version || !saved.overridden}
              onClick={() => { void save(true) }}>恢复默认</PanelCommandButton>
          </>}
          <button className="ops-button ops-button--link" type="button" disabled={busy || Boolean(pending)}
            onClick={() => { setNotice(undefined); setReload((value) => value + 1) }}>重新读取规划时限</button>
        </div>
        {busy && <p className="planning-timeouts-status" role="status">正在确认操作结果…</p>}
        {!busy && !notice && loaded !== version && <p className="planning-timeouts-status" role="status">正在读取规划时限…</p>}
        {notice && <p className="planning-timeouts-status" role={notice.error ? 'alert' : 'status'}>{notice.message}</p>}
      </div>
    </form>
  </section>
}
