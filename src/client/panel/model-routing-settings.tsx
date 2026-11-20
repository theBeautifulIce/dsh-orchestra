import { useEffect, useState } from 'react'
import type { ApiClient } from '../api/client.ts'
import { postWithOperationReceipt } from '../api/commands.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import { MODEL_COMPLEXITIES, MODEL_LEVELS, MODEL_NOTE_MAX_LENGTH } from '../../executor/model-routing.ts'
import type { ModelRoutingSettingsView } from '../../service/model-routing-settings.ts'
import { PanelCommandButton } from './shell.tsx'

const PATH = '/v1/settings/model-routing'
export function ModelRoutingSettings({ client, reloadVersion = 0, onSnapshot }: {
  client: ApiClient; reloadVersion?: number; onSnapshot?: (seq: number) => void
}) {
  const [saved, setSaved] = useState<ModelRoutingSettingsView>()
  const [draft, setDraft] = useState<ModelRoutingSettingsView['mapping']>()
  const [notes, setNotes] = useState(new Map<string, string>())
  const [reload, setReload] = useState(0)
  const [loadedVersion, setLoadedVersion] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const version = reloadVersion + ':' + reload
  const savedNotes = new Map(saved?.model_notes?.map(({ ref, note }) => [ref, note]))
  const changedNotes = [...notes].flatMap(([ref, value]) => {
    const note = value.trim()
    return note === (savedNotes.get(ref) ?? '') ? [] : [{ ref, note }]
  })
  const dirty = MODEL_COMPLEXITIES.some((level) => saved?.mapping[level] !== draft?.[level]) || changedNotes.length > 0
  useEffect(() => {
    let active = true
    void client.get<ModelRoutingSettingsView>(PATH).then(({ data, as_of_seq }) => {
      if (active) {
        setSaved(data); setDraft(data.mapping); setLoadedVersion(version)
        setNotes(new Map(data.model_notes?.map(({ ref, note }) => [ref, note])))
        onSnapshot?.(as_of_seq)
      }
    }).catch(() => { if (active) { setError(true); setMessage('模型配置暂时无法读取。') } })
    return () => { active = false }
  }, [client, onSnapshot, version])

  async function save() {
    if (!saved || !draft || !dirty || busy || loadedVersion !== version) return
    setBusy(true); setMessage(''); setError(false)
    try {
      await postWithOperationReceipt(client, PATH, 'model_routing.save', {
        expected_revision: saved.revision, mapping: draft, operation_id: newOperationId(),
        ...(changedNotes.length > 0 ? { model_notes: changedNotes } : {}),
      })
      setMessage('已保存，下一次派发采用新配置。用途说明供后续任务规划参考。')
      setReload((value) => value + 1)
    } catch (failure) {
      setError(true)
      setMessage(failure instanceof Error ? failure.message : '保存结果暂不可确认。')
    } finally { setBusy(false) }
  }

  return <section aria-labelledby="model-routing-title" className="ops-surface">
    <header className="ops-surface-head"><h2 id="model-routing-title">子智能体模型分配</h2></header>
    <div className="ops-inset ops-stack">
    <p className="ops-meta">自动模式采用合格的主脑候选，其次选满足要求的最低档。</p>
    {saved && draft ? <form onSubmit={(event) => { event.preventDefault(); void save() }} style={form}>
      {MODEL_COMPLEXITIES.map((level, index) => {
        const { label, description } = MODEL_LEVELS[level]
        const profiles = saved.profiles.filter((item) => MODEL_COMPLEXITIES.indexOf(item.capacity) >= index)
        const current = draft[level]
        return <label key={level} style={field}>{label}
          <select className="ops-field" aria-describedby={`model-capacity-${level}`} disabled={busy} value={current ?? ''} onChange={(event) => setDraft({ ...draft, [level]: event.target.value || null })}>
            <option value="">自动选择</option>
            {current && !profiles.some((item) => item.ref === current) && <option value={current}>已不可用 · {current}</option>}
            {profiles.map((item) => <option key={item.ref} value={item.ref}>
              {item.provider && item.model ? `${item.provider} / ${item.model}` : item.ref}
            </option>)}
          </select>
          <span id={`model-capacity-${level}`} className="ops-meta" style={{ gridColumn: 2 }}>{description}</span>
        </label>
      })}
      {saved.profiles.length > 0 && <fieldset className="ops-inset">
        <legend>模型用途说明</legend>
        <p id="model-note-help" className="ops-meta">可留空，每条最多 {MODEL_NOTE_MAX_LENGTH} 字。主脑可根据说明推荐符合该步骤要求的模型。</p>
        {saved.profiles.map(({ ref, provider, model, capacity }) => <label key={ref} style={noteField}>
          <span>{provider && model ? `${provider} / ${model}` : ref} · {MODEL_LEVELS[capacity].label}</span>
          <input className="ops-field" aria-describedby="model-note-help" disabled={busy}
            maxLength={MODEL_NOTE_MAX_LENGTH} value={notes.get(ref) ?? ''}
            onChange={(event) => setNotes(new Map(notes).set(ref, event.target.value))} />
        </label>)}
      </fieldset>}
      <div style={{ display: 'flex', gap: 8 }}>
        <PanelCommandButton type="submit" className="ops-button ops-button--primary" disabled={busy || loadedVersion !== version || !dirty}>保存模型分配</PanelCommandButton>
        <button type="button" className="ops-button" disabled={busy} onClick={() => { setError(false); setMessage(''); setReload((value) => value + 1) }}>重新读取</button>
      </div>
    </form> : !error && <p role="status">正在读取宿主模型…</p>}
    {message && <p role={error ? 'alert' : 'status'}>{message}</p>}
    </div>
  </section>
}

const form = { display: 'grid', gap: 7 }
const field = { display: 'grid', gridTemplateColumns: '85px minmax(0, 1fr)', alignItems: 'center', gap: 8 }
const noteField = { display: 'grid', gap: 4, marginBottom: 8 }
