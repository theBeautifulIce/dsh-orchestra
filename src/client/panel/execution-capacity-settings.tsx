import { useEffect, useState } from 'react'
import type { ExecutionCapacitySettingsView, ExecutionCapacityValues } from '../../service/execution-capacity-settings.ts'
import { ApiError, type ApiClient } from '../api/client.ts'
import { postWithOperationReceipt } from '../api/commands.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import { PanelCommandButton } from './shell.tsx'
import { COLOR, FONT_PX } from './tokens.ts'

const path = '/v1/settings/execution-capacity'
const fields = [
  { key: 'concurrency', label: '同时执行名额', unit: '个', scale: 1, help: '最多同时执行多少个工作流节点。提高后会立即从等待队列补位。' },
  { key: 'max_waiting', label: '可排队上限', unit: '个', scale: 1, help: '最多有多少个节点可以等待执行。队列满时，无法直接开跑的新节点会被拒绝。' },
  { key: 'action_timeout_ms', label: '单步执行时限', unit: '秒', scale: 1000, help: '节点执行阶段可用的时间。排队、规划、启动与核验分别计时。' },
] as const
type Field = keyof ExecutionCapacityValues
type Draft = Record<Field, string>
type Command = { operation_id: string; expected_revision: number; values: ExecutionCapacityValues | null }

function toDraft(values: ExecutionCapacityValues): Draft {
  return {
    concurrency: String(values.concurrency),
    max_waiting: String(values.max_waiting),
    action_timeout_ms: String(values.action_timeout_ms / 1000),
  }
}

const styles = `
.execution-capacity-form { display: grid; gap: 12px; padding: 14px 16px; }
.execution-capacity-form p { margin: 0; }
.execution-capacity-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center;
  gap: 4px 12px; padding-top: 10px; border-top: 1px solid ${COLOR.line};
}
.execution-capacity-row label { font-weight: 650; }
.execution-capacity-row input { inline-size: 10ch; }
.execution-capacity-help { grid-column: 1 / -1; color: ${COLOR.inkMuted}; font-size: ${FONT_PX.menu}px; }
.execution-capacity-help p + p { margin-top: 2px; font-size: ${FONT_PX.helper}px; }
.execution-capacity-form [role=alert] { color: ${COLOR.danger}; }
`

export function ExecutionCapacitySettings({ client, reloadVersion = 0, onSnapshot }: {
  client: ApiClient; reloadVersion?: number; onSnapshot?: (seq: number) => void
}) {
  const [saved, setSaved] = useState<ExecutionCapacitySettingsView>()
  const [draft, setDraft] = useState<Draft>()
  const [reload, setReload] = useState(0)
  const [loaded, setLoaded] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Command>()
  const [notice, setNotice] = useState<{ message: string; error?: boolean; field?: Field }>()
  const version = reloadVersion + ':' + reload
  const ready = saved && draft && loaded === version
  useEffect(() => {
    let active = true
    void client.get<ExecutionCapacitySettingsView>(path).then(({ data, as_of_seq }) => {
      if (!active) return
      setSaved(data)
      setDraft(toDraft(data.values))
      setLoaded(version)
      onSnapshot?.(as_of_seq)
    }).catch(() => { if (active) setNotice({ message: '暂时无法读取执行与排队设置。', error: true }) })
    return () => { active = false }
  }, [client, onSnapshot, version])

  async function save(reset: boolean) {
    if (!saved || !draft || busy || (!pending && !ready)) return
    let values: ExecutionCapacityValues | null = null
    if (!pending && !reset) {
      values = { concurrency: 0, max_waiting: 0, action_timeout_ms: 0 }
      for (const { key, label, scale, unit } of fields) {
        const format = scale === 1 ? /^\d+$/u : /^\d+(?:\.\d{1,3})?$/u
        const quantity = Number(draft[key])
        if (!format.test(draft[key]) || quantity < 1 || (quantity > saved.limits[key] / scale && quantity !== saved.defaults[key] / scale)) {
          const precision = scale === 1 ? '整数' : '最多三位小数'
          setNotice({ error: true, field: key, message: `${label}请输入 1–${saved.limits[key] / scale} ${unit}（${precision}）。` })
          return
        }
        values[key] = Math.round(quantity * scale)
      }
    }
    const command = pending ?? { operation_id: newOperationId(), expected_revision: saved.revision, values }
    setBusy(true)
    setNotice(undefined)
    try {
      await postWithOperationReceipt(client, path, 'execution_capacity.save', command)
      setPending(undefined)
      setNotice({ message: command.values ? '已保存并生效。' : '已恢复宿主默认值并生效。' })
      setReload((value) => value + 1)
    } catch (error) {
      setPending(error instanceof ApiError && error.code === 'OPERATION_OUTCOME_UNKNOWN' ? command : undefined)
      setNotice({ error: true, message: error instanceof Error ? error.message : '保存结果暂不可确认。' })
    } finally { setBusy(false) }
  }

  return <section className="ops-surface" aria-labelledby="execution-capacity-title">
    <style>{styles}</style>
    <header className="ops-surface-head">
      <h2 id="execution-capacity-title" tabIndex={-1} className="ops-settings-anchor">执行与排队</h2>
    </header>
    <form className="execution-capacity-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(false) }}>
      <p>设置应用于当前会话。调低容量会保留已运行和已排队的节点。新时限从节点实际开始执行时采用。</p>
      {saved && draft && fields.map(({ key, label, unit, scale, help }) => <div className="execution-capacity-row" key={key}>
        <label htmlFor={`execution-capacity-${key}`}>{label}</label>
        <input id={`execution-capacity-${key}`} className="ops-field" type="number" min={1}
          max={Math.max(saved.limits[key], saved.defaults[key]) / scale} step={1 / scale} value={draft[key]}
          aria-describedby={`execution-capacity-help-${key}`} aria-invalid={notice?.field === key || undefined}
          disabled={busy || Boolean(pending) || !ready}
          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
        <div className="execution-capacity-help" id={`execution-capacity-help-${key}`}>
          <p>{help}</p>
          <p>范围 1–{saved.limits[key] / scale} {unit} · 宿主默认 {saved.defaults[key] / scale} {unit}</p>
        </div>
      </div>)}
      <div className="ops-actions">
        {saved && draft && <>
          <PanelCommandButton className="ops-button ops-button--primary" type="submit"
            disabled={busy || (!pending && !ready)}>{pending ? '查询或重试' : '保存执行设置'}</PanelCommandButton>
          <PanelCommandButton className="ops-button" type="button"
            disabled={busy || Boolean(pending) || !ready || !saved.overridden}
            onClick={() => { void save(true) }}>恢复宿主默认</PanelCommandButton>
        </>}
        <button className="ops-button ops-button--link" type="button" disabled={busy || Boolean(pending)}
          onClick={() => { setNotice(undefined); setReload((value) => value + 1) }}>重新读取执行设置</button>
      </div>
      {busy && <p role="status">正在确认操作结果…</p>}
      {!busy && !notice && loaded !== version && <p role="status">正在读取执行与排队设置…</p>}
      {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.message}</p>}
    </form>
  </section>
}
