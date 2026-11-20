import { useEffect, useState } from 'react'
import type { ApiClient } from '../api/client.ts'
import { postWithOperationReceipt } from '../api/commands.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import { MODEL_COMPLEXITIES, MODEL_LEVELS, MODEL_NOTE_MAX_LENGTH, type ModelCatalogProfile, type ModelComplexity } from '../../executor/model-routing.ts'
import type { ModelRoutingSettingsView } from '../../service/model-routing-settings.ts'
import { PanelCommandButton } from './shell.tsx'

const PATH = '/v1/settings/model-routing'
function modelLabel({ ref, provider, model, name, provider_name }: ModelCatalogProfile) {
  if (!provider || !model) return ref
  const providerLabel = provider_name && provider_name !== provider ? `${provider_name} (${provider})` : provider
  return `${providerLabel} / ${name && name !== model ? `${name} (${model})` : model}`
}

export function ModelRoutingSettings({ client, reloadVersion = 0, onSnapshot }: {
  client: ApiClient; reloadVersion?: number; onSnapshot?: (seq: number) => void
}) {
  const [saved, setSaved] = useState<ModelRoutingSettingsView>()
  const [draft, setDraft] = useState<ModelRoutingSettingsView['mapping']>()
  const [notes, setNotes] = useState(new Map<string, string>())
  const [capacities, setCapacities] = useState(new Map<string, ModelComplexity>())
  const [efforts, setEfforts] = useState<Partial<Record<ModelComplexity, string>>>({})
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
  const savedCapacities = new Map(saved?.model_capacities?.map(({ ref, capacity }) => [ref, capacity]))
  const changedCapacities = (saved?.profiles ?? []).flatMap(({ ref }) => {
    const capacity = capacities.get(ref) ?? null
    return capacity === (savedCapacities.get(ref) ?? null) ? [] : [{ ref, capacity }]
  })
  const changedEfforts = MODEL_COMPLEXITIES.flatMap((level) => {
    const effort = efforts[level] ?? null
    return effort === (saved?.reasoning_efforts?.[level] ?? null) && saved?.mapping[level] === draft?.[level] ? [] : [[level, effort] as const]
  })
  const liveCatalog = saved?.unavailable_providers !== undefined
  const capacityFor = (profile: ModelCatalogProfile) => liveCatalog
    ? capacities.get(profile.ref) ?? profile.host_capacity ?? null : profile.capacity
  const dirty = changedEfforts.length + changedNotes.length + changedCapacities.length > 0
  useEffect(() => {
    let active = true
    void client.get<ModelRoutingSettingsView>(PATH).then(({ data, as_of_seq }) => {
      if (active) {
        setSaved(data); setDraft(data.mapping); setLoadedVersion(version)
        setNotes(new Map(data.model_notes?.map(({ ref, note }) => [ref, note])))
        setCapacities(new Map(data.model_capacities?.flatMap(({ ref, capacity }) => capacity ? [[ref, capacity] as const] : [])))
        setEfforts(Object.fromEntries(Object.entries(data.reasoning_efforts ?? {}).filter(([, value]) => value != null)))
        onSnapshot?.(as_of_seq)
      }
    }).catch((failure: unknown) => {
      if (active) {
        setError(true)
        setMessage(failure instanceof Error ? failure.message : '模型配置暂时无法读取。请重新读取。')
      }
    })
    return () => { active = false }
  }, [client, onSnapshot, version])

  async function save() {
    if (!saved || !draft || !dirty || busy || loadedVersion !== version) return
    setBusy(true); setMessage(''); setError(false)
    try {
      await postWithOperationReceipt(client, PATH, 'model_routing.save', {
        expected_revision: saved.revision, mapping: draft, operation_id: newOperationId(),
        ...(changedNotes.length > 0 ? { model_notes: changedNotes } : {}),
        ...(changedCapacities.length > 0 ? { model_capacities: changedCapacities } : {}),
        ...(changedEfforts.some(([, effort]) => effort !== null) || liveCatalog && changedEfforts.length > 0
          ? { reasoning_efforts: Object.fromEntries(changedEfforts) } : {}),
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
    <p className="ops-meta">自动模式采用合格的主脑候选，其次选满足要求的最低档。思考深度由所选模型提供，最大能力由你评估。</p>
    {saved && draft ? <form onSubmit={(event) => { event.preventDefault(); void save() }} style={form}>
      {liveCatalog && saved.profiles.length === 0 && <p role="status">DSH 当前没有提供可用模型。请在 DSH 模型设置中检查供应商连接，再重新读取。</p>}
      {!!saved.unavailable_providers?.length && <p role="status">部分供应商的目录读取失败（{saved.unavailable_providers.join('、')}）。请检查 DSH 中的连接后重新读取。</p>}
      {MODEL_COMPLEXITIES.map((level, index) => {
        const { label, description } = MODEL_LEVELS[level]
        const profiles = saved.profiles.filter((item) => {
          const capacity = capacityFor(item)
          return capacity !== null && MODEL_COMPLEXITIES.indexOf(capacity) >= index
        })
        const current = draft[level]
        const selected = profiles.find(({ ref }) => current === ref)
        const reasoning = selected?.reasoning
        const effort = efforts[level] ?? ''
        const declaredDefault = reasoning?.efforts.find(({ id }) => id === reasoning.defaultEffort)
        const effortUnavailable = !!effort && !reasoning?.efforts.some(({ id }) => id === effort)
        return <div key={level} style={field}>
          <label htmlFor={`model-route-${level}`}>{label}</label>
          <select id={`model-route-${level}`} className="ops-field" aria-describedby={`model-capacity-${level}`}
            disabled={busy || loadedVersion !== version} value={current ?? ''} onChange={(event) => {
              setDraft({ ...draft, [level]: event.target.value || null })
              setEfforts({ ...efforts, [level]: undefined })
            }}>
            <option value="">自动选择{profiles.length === 0 ? '（暂无候选）' : ''}</option>
            {current && !profiles.some((item) => item.ref === current) && <option value={current}>已不可用 · {current}</option>}
            {profiles.map((item) => <option key={item.ref} value={item.ref}>{modelLabel(item)}</option>)}
          </select>
          <span id={`model-capacity-${level}`} className="ops-meta" style={fieldHint}>{description}
            {profiles.length === 0 && '。可在下方评估已配置模型的最大能力，或在 DSH 中配置更多模型后重新读取。'}
            {current && !selected && '。已保存的模型已移除或能力不足，请改选模型或自动选择。'}
          </span>
          {selected && (reasoning?.efforts.length || effortUnavailable) ? <>
            <label htmlFor={`model-effort-${level}`} className="ops-meta">思考深度</label>
            <select id={`model-effort-${level}`} aria-label={`${label}思考深度`} className="ops-field" value={effort}
              disabled={busy || loadedVersion !== version} onChange={(event) => setEfforts({ ...efforts, [level]: event.target.value || undefined })}>
              <option value="">模型默认{declaredDefault ? `（${declaredDefault.name}）` : ''}</option>
              {effortUnavailable && <option value={effort}>已不可用 · {effort}</option>}
              {reasoning?.efforts.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            </select>
            {effortUnavailable && <span className="ops-meta" style={fieldHint}>该模型已移除所保存的思考档，请改选模型默认或当前支持的档位。</span>}
          </> : liveCatalog && selected && <span className="ops-meta" style={fieldHint}>该模型未提供可调思考档，使用模型默认。</span>}
        </div>
      })}
      {saved.profiles.length > 0 && <fieldset className="ops-inset">
        <legend>{liveCatalog ? '已配置模型的能力和用途' : '模型用途说明'}</legend>
        <p id="model-note-help" className="ops-meta">{liveCatalog && '最高可以胜任哪一档，由你根据实际表现填写。'}
          用途说明可留空，每条最多 {MODEL_NOTE_MAX_LENGTH} 字。主脑可根据说明推荐符合该步骤要求的模型。</p>
        {saved.profiles.map((profile) => {
          const { ref, host_capacity } = profile
          const capacity = capacityFor(profile)
          return <div key={ref} style={noteField}>
            <strong>{modelLabel(profile)} · {capacity ? MODEL_LEVELS[capacity].label : '未评估'}</strong>
            {liveCatalog && <label style={field}>最大能力
              <select className="ops-field" aria-label={`${modelLabel(profile)} 最大能力`} disabled={busy || loadedVersion !== version}
                value={capacities.get(ref) ?? ''} onChange={(event) => {
                  const next = new Map(capacities)
                  const value = event.target.value as ModelComplexity | ''
                  if (value) next.set(ref, value)
                  else next.delete(ref)
                  setCapacities(next)
                }}>
                <option value="">{host_capacity ? `宿主默认（${MODEL_LEVELS[host_capacity].label}）` : '未评估'}</option>
                {MODEL_COMPLEXITIES.map((level) => <option key={level} value={level}>{MODEL_LEVELS[level].label}</option>)}
              </select>
            </label>}
            {liveCatalog && !profile.reasoning?.efforts.length && <span className="ops-meta">该模型未提供可调思考档。</span>}
            <label style={liveCatalog ? field : undefined}>{liveCatalog && '用途说明'}
              <input className="ops-field" aria-label={`${modelLabel(profile)} 用途说明`} aria-describedby="model-note-help"
                disabled={busy || loadedVersion !== version} maxLength={MODEL_NOTE_MAX_LENGTH} value={notes.get(ref) ?? ''}
                onChange={(event) => setNotes(new Map(notes).set(ref, event.target.value))} />
            </label>
          </div>
        })}
      </fieldset>}
      <div style={{ display: 'flex', gap: 8 }}>
        <PanelCommandButton type="submit" className="ops-button ops-button--primary" disabled={busy || loadedVersion !== version || !dirty}>保存模型分配</PanelCommandButton>
        <button type="button" className="ops-button" disabled={busy} onClick={() => { setError(false); setMessage(''); setReload((value) => value + 1) }}>重新读取</button>
      </div>
    </form> : error ? <button type="button" className="ops-button" onClick={() => {
      setError(false); setMessage(''); setReload((value) => value + 1)
    }}>重新读取</button> : <p role="status">正在读取宿主模型…</p>}
    {message && <p role={error ? 'alert' : 'status'}>{message}</p>}
    </div>
  </section>
}

const form = { display: 'grid', gap: 7 }
const field = { display: 'grid', gridTemplateColumns: '85px minmax(0, 1fr)', alignItems: 'center', gap: 8 }
const fieldHint = { gridColumn: 2 }
const noteField = { display: 'grid', gap: 4, marginBottom: 8 }
