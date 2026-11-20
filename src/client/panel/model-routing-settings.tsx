import { useEffect, useState, type Ref } from 'react'
import type { ApiClient } from '../api/client.ts'
import { postWithOperationReceipt } from '../api/commands.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import { MODEL_COMPLEXITIES, MODEL_LEVELS, MODEL_NOTE_MAX_LENGTH, type ModelCatalogProfile, type ModelComplexity } from '../../executor/model-routing.ts'
import type { ModelRoutingSettingsView } from '../../service/model-routing-settings.ts'
import { PanelCommandButton } from './shell.tsx'

const PATH = '/v1/settings/model-routing'
type ModelEdit = { note?: string; capacity?: ModelComplexity | null; effort?: string | null }
type TierDraft = { ref: string | null; effort: string | null }
type PlannerModel = NonNullable<ModelRoutingSettingsView['planner_model']>
type Draft<T> = { base: T; value: T }
type ModelDraft = { [K in keyof ModelEdit]: Draft<Exclude<ModelEdit[K], undefined>> }

function draftValue<T>(draft: Draft<T> | undefined, value: T, latest: T, equals = Object.is): Draft<T> | undefined {
  if (equals(value, latest)) return undefined
  return { base: draft ? draft.base : latest, value }
}
function conflicting<T>(draft: Draft<T> | undefined, latest: T, equals = Object.is) {
  return !!draft && !equals(draft.base, latest) && !equals(draft.value, latest)
}
function sameRoute(left: TierDraft | null, right: TierDraft | null) {
  return left?.ref === right?.ref && left?.effort === right?.effort
}
const sameNote = (left: string, right: string) => left.trim() === right.trim()

function providerId(profile: ModelCatalogProfile) {
  if (profile.provider) return profile.provider
  const slash = profile.ref.indexOf('/')
  return slash > 0 ? profile.ref.slice(0, slash) : ''
}
function providerLabel(profile: ModelCatalogProfile) {
  const id = providerId(profile)
  return profile.provider_name && profile.provider_name !== id ? `${profile.provider_name} (${id})` : id || '当前宿主'
}
function modelName({ ref, model, name }: ModelCatalogProfile) {
  const id = model ?? ref.slice(ref.indexOf('/') + 1)
  return name && name !== id ? `${name} (${id})` : id
}
function modelLabel(profile: ModelCatalogProfile) {
  return providerId(profile) ? `${providerLabel(profile)} / ${modelName(profile)}` : modelName(profile)
}
function presetOnly(profile?: ModelCatalogProfile) {
  const reasoning = profile?.reasoning
  if (reasoning?.efforts.length === 1 && reasoning.efforts[0]?.id === reasoning.defaultEffort) return reasoning.efforts[0]
}

function ModelPicker({ scope, profiles, refValue, locked, onPick }: {
  scope: 'profile' | 'planner'; profiles: readonly ModelCatalogProfile[]; refValue: string; locked: boolean; onPick(ref: string): void
}) {
  const selected = profiles.find(({ ref }) => ref === refValue)
  const provider = selected ? providerId(selected) : undefined
  const providers = new Map(profiles.map((profile) => [providerId(profile), providerLabel(profile)]))
  const choices = profiles.filter((profile) => providerId(profile) === provider)
  const unavailable = '::unavailable::'
  const label = scope === 'planner' ? '主脑' : '子智能体'
  return <div style={editorSelectors}>
    <label style={fieldList}>供应商
      <select id={`model-${scope}-provider`} aria-label={`${label}供应商`} className="ops-field" value={provider ?? unavailable} disabled={locked}
        onChange={(event) => {
          const profile = profiles.find((item) => providerId(item) === event.target.value)
          if (profile) onPick(profile.ref)
        }}>
        {provider === undefined && <option value={unavailable} disabled>{refValue ? '已保存供应商不可用' : '请选择供应商'}</option>}
        {[...providers].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </label>
    <label style={fieldList}>模型
      <select id={`model-${scope}-model`} aria-label={`${label}模型`} className="ops-field" value={refValue} disabled={locked || !choices.length}
        onChange={(event) => onPick(event.target.value)}>
        {!selected && <option value={refValue}>{refValue ? `已不可用 · ${refValue}` : '请选择模型'}</option>}
        {choices.map((profile) => <option key={profile.ref} value={profile.ref}>{modelName(profile)}</option>)}
      </select>
    </label>
  </div>
}

export function ModelRoutingSettings({ client, reloadVersion = 0, onSnapshot, plannerHeadingRef, submodelHeadingRef }: {
  client: ApiClient; reloadVersion?: number; onSnapshot?: (seq: number) => void
  plannerHeadingRef?: Ref<HTMLHeadingElement>
  submodelHeadingRef?: Ref<HTMLHeadingElement>
}) {
  const [saved, setSaved] = useState<ModelRoutingSettingsView>()
  const [modelDrafts, setModelDrafts] = useState(new Map<string, ModelDraft>())
  const [tierDrafts, setTierDrafts] = useState<Partial<Record<ModelComplexity, Draft<TierDraft>>>>({})
  const [editorRef, setEditorRef] = useState<string>()
  const [plannerDraft, setPlannerDraft] = useState<Draft<PlannerModel | null>>()
  const [reload, setReload] = useState(0)
  const [loadedVersion, setLoadedVersion] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const version = reloadVersion + ':' + reload
  const profiles = saved?.profiles ?? []
  const editor = profiles.find(({ ref }) => ref === editorRef) ?? profiles[0]
  const plannerConfigurable = saved?.planner_model_configurable === true
  const persistedPlanner = saved?.planner_model ?? null
  const planner = plannerDraft === undefined ? persistedPlanner : plannerDraft.value
  const plannerChanged = plannerConfigurable && !sameRoute(planner, persistedPlanner)
  const plannerProfile = profiles.find(({ ref }) => ref === planner?.ref)
  const plannerReasoning = plannerProfile?.reasoning
  const plannerPreset = presetOnly(plannerProfile)
  const plannerNativeDefault = plannerReasoning?.efforts.find(({ id }) => id === plannerReasoning.defaultEffort)
  const invalidPlannerEffort = !!planner?.effort && !plannerReasoning?.efforts.some(({ id }) => id === planner.effort)
  const invalidPlannerDraft = plannerChanged && planner !== null && (!plannerProfile || invalidPlannerEffort)
  const available = new Map(profiles.map((profile) => [profile.ref, profile]))
  const savedNotes = new Map(saved?.model_notes?.map(({ ref, note }) => [ref, note]))
  const savedCapacities = new Map(saved?.model_capacities?.map(({ ref, capacity }) => [ref, capacity]))
  const savedDefaults = new Map(saved?.model_reasoning_defaults?.map(({ ref, effort }) => [ref, effort]))
  function capacityOf(ref: string) {
    const capacity = modelDrafts.get(ref)?.capacity?.value
    return capacity === undefined ? savedCapacities.get(ref) ?? null : capacity
  }
  function effortOf(ref: string) {
    const effort = modelDrafts.get(ref)?.effort?.value
    return effort === undefined ? savedDefaults.get(ref) ?? null : effort
  }
  const noteOf = (ref: string) => modelDrafts.get(ref)?.note?.value ?? savedNotes.get(ref) ?? ''
  const changedModels = [...modelDrafts].filter(([ref]) => available.has(ref))
  const changedNotes = changedModels.flatMap(([ref, entry]) => {
    const note = entry.note?.value.trim()
    return note === undefined || note === (savedNotes.get(ref) ?? '') ? [] : [{ ref, note }]
  })
  const changedCapacities = changedModels.flatMap(([ref, entry]) => {
    const capacity = entry.capacity?.value
    return capacity === undefined || capacity === (savedCapacities.get(ref) ?? null) ? [] : [{ ref, capacity }]
  })
  const changedDefaults = changedModels.flatMap(([ref, entry]) => {
    const effort = entry.effort?.value
    return effort === undefined || effort === (savedDefaults.get(ref) ?? null) ? [] : [{ ref, effort }]
  })
  function savedTier(level: ModelComplexity): TierDraft {
    return { ref: saved?.mapping[level] ?? null, effort: saved?.reasoning_efforts?.[level] ?? null }
  }
  const mapping = Object.fromEntries(MODEL_COMPLEXITIES.map((level) => [level,
    (tierDrafts[level]?.value ?? savedTier(level)).ref])) as ModelRoutingSettingsView['mapping']
  const changedEfforts = MODEL_COMPLEXITIES.flatMap((level) => {
    const edit = tierDrafts[level]?.value
    return !edit || sameRoute(edit, savedTier(level)) ? [] : [[level, edit.effort] as const]
  })
  const liveCatalog = saved?.unavailable_providers !== undefined
  const capacityFor = (profile: ModelCatalogProfile) => capacityOf(profile.ref)
    ?? (profile.host_capacity === undefined ? profile.capacity : profile.host_capacity)
  const dirty = plannerChanged || changedEfforts.length + changedNotes.length + changedCapacities.length + changedDefaults.length > 0
  const unavailableDrafts = modelDrafts.size - changedModels.length
  const locked = busy || loadedVersion !== version
  const updateModel = (ref: string, update: (draft: ModelDraft) => ModelDraft) => setModelDrafts((current) => {
    const next = new Map(current)
    const model = update(current.get(ref) ?? {})
    if (model.note || model.capacity || model.effort) next.set(ref, model)
    else next.delete(ref)
    return next
  })
  function editModel(ref: string, edit: ModelEdit) {
    updateModel(ref, (model) => ({
      note: edit.note === undefined ? model.note : draftValue(model.note, edit.note, savedNotes.get(ref) ?? ''),
      capacity: edit.capacity === undefined ? model.capacity : draftValue(model.capacity, edit.capacity, savedCapacities.get(ref) ?? null),
      effort: edit.effort === undefined ? model.effort : draftValue(model.effort, edit.effort, savedDefaults.get(ref) ?? null),
    }))
  }
  const editTier = (level: ModelComplexity, edit: TierDraft) => setTierDrafts((current) => {
    return { ...current, [level]: draftValue(current[level], edit, savedTier(level), sameRoute) }
  })
  const editPlanner = (edit: PlannerModel | null) =>
    setPlannerDraft((current) => draftValue(current, edit, persistedPlanner, sameRoute))

  const conflicts: { key: string; label: string; latest: string; mine: string; resolve(keep: boolean): void }[] = []
  const describeRoute = (choice: TierDraft | null, fallback: string) => {
    if (!choice?.ref) return fallback
    const profile = available.get(choice.ref)
    const effort = profile?.reasoning?.efforts.find(({ id }) => id === choice.effort)?.name ?? choice.effort
    return `${profile ? modelLabel(profile) : choice.ref} · ${effort ?? '默认思考深度'}`
  }
  if (plannerConfigurable && plannerDraft && conflicting(plannerDraft, persistedPlanner, sameRoute)) {
    conflicts.push({ key: 'planner', label: '主脑模型',
      latest: describeRoute(persistedPlanner, '跟随当前会话'), mine: describeRoute(plannerDraft.value, '跟随当前会话'), resolve: (keep) =>
      setPlannerDraft(keep ? { base: persistedPlanner, value: plannerDraft.value } : undefined) })
  }
  for (const level of MODEL_COMPLEXITIES) {
    const latest = savedTier(level)
    const edit = tierDrafts[level]
    if (edit && conflicting(edit, latest, sameRoute)) {
      // A tier's effort belongs to its model, so the selection is one atomic field.
      conflicts.push({ key: level, label: MODEL_LEVELS[level].label + '档分配',
        latest: describeRoute(latest, '自动选择'), mine: describeRoute(edit.value, '自动选择'), resolve: (keep) =>
        setTierDrafts((current) => ({ ...current, [level]: keep ? { base: latest, value: edit.value } : undefined })) })
    }
  }
  for (const [ref, draft] of changedModels) {
    const profile = available.get(ref)!
    const label = modelLabel(profile)
    function addField<K extends keyof ModelDraft, T>(key: K, title: string, edit: Draft<T> | undefined, latest: T,
      format: (value: T) => string, equals = Object.is) {
      if (!edit || !conflicting(edit, latest, equals)) return
      conflicts.push({ key: `${ref}:${key}`, label: `${label} · ${title}`,
        latest: format(latest), mine: format(edit.value),
        resolve: (keep) => updateModel(ref, (model) => ({ ...model, [key]: keep ? { base: latest, value: edit.value } : undefined })) })
    }
    addField('note', '用途说明', draft.note, savedNotes.get(ref) ?? '', (value) => value.trim() || '空白', sameNote)
    addField('capacity', '最大能力', draft.capacity, savedCapacities.get(ref) ?? null, (value) => value ? MODEL_LEVELS[value].label : '宿主默认')
    addField('effort', '默认思考深度', draft.effort, savedDefaults.get(ref) ?? null, (value) =>
      profile.reasoning?.efforts.find(({ id }) => id === value)?.name ?? value ?? '宿主默认')
  }
  const editorEffort = editor ? effortOf(editor.ref) : null
  const editorReasoning = editor?.reasoning
  const editorPreset = presetOnly(editor)
  const editorHostCapacity = editor?.host_capacity === undefined ? editor?.capacity : editor.host_capacity
  const nativeDefault = editorReasoning?.efforts.find(({ id }) => id === editorReasoning.defaultEffort)
  const invalidEditorEffort = !!editorEffort && !editorReasoning?.efforts.some(({ id }) => id === editorEffort)
  useEffect(() => {
    let active = true
    void client.get<ModelRoutingSettingsView>(PATH).then(({ data, as_of_seq }) => {
      if (active) {
        setSaved(data)
        const modelRefs = new Set(data.profiles.map(({ ref }) => ref))
        const notes = new Map(data.model_notes?.map(({ ref, note }) => [ref, note]))
        const capacities = new Map(data.model_capacities?.map(({ ref, capacity }) => [ref, capacity]))
        const defaults = new Map(data.model_reasoning_defaults?.map(({ ref, effort }) => [ref, effort]))
        setModelDrafts((current) => {
          const next = new Map(current)
          for (const [ref, model] of current) {
            if (!modelRefs.has(ref)) continue
            const note = model.note && !sameNote(model.note.value, notes.get(ref) ?? '') ? model.note : undefined
            const capacity = model.capacity?.value === (capacities.get(ref) ?? null) ? undefined : model.capacity
            const effort = model.effort?.value === (defaults.get(ref) ?? null) ? undefined : model.effort
            if (note || capacity || effort) next.set(ref, { note, capacity, effort })
            else next.delete(ref)
          }
          return next
        })
        setTierDrafts((current) => {
          const next = { ...current }
          for (const level of MODEL_COMPLEXITIES) {
            if (sameRoute(current[level]?.value ?? null, { ref: data.mapping[level], effort: data.reasoning_efforts?.[level] ?? null })) delete next[level]
          }
          return next
        })
        if (data.planner_model_configurable === true) {
          setPlannerDraft((current) => current && sameRoute(current.value, data.planner_model ?? null) ? undefined : current)
        }
        setLoadedVersion(version)
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
    if (!saved || !dirty || locked || invalidPlannerDraft || conflicts.length) return
    setBusy(true); setMessage(''); setError(false)
    try {
      await postWithOperationReceipt(client, PATH, 'model_routing.save', {
        expected_revision: saved.revision, mapping, operation_id: newOperationId(),
        ...(changedNotes.length > 0 ? { model_notes: changedNotes } : {}),
        ...(changedCapacities.length > 0 ? { model_capacities: changedCapacities } : {}),
        ...(changedDefaults.length > 0 ? { model_reasoning_defaults: changedDefaults } : {}),
        ...(plannerChanged ? { planner_model: planner } : {}),
        ...(changedEfforts.length > 0 && (changedEfforts.some(([, effort]) => effort !== null) || liveCatalog || !!saved.reasoning_efforts)
          ? { reasoning_efforts: Object.fromEntries(changedEfforts) } : {}),
      })
      setTierDrafts({})
      if (plannerChanged) setPlannerDraft(undefined)
      setModelDrafts((current) => new Map([...current].filter(([ref]) => !available.has(ref))))
      setMessage('已保存，下一次派发采用新配置。用途说明供后续任务规划参考。')
      setReload((value) => value + 1)
    } catch (failure) {
      setError(true)
      setMessage(failure instanceof Error ? failure.message : '保存结果暂不可确认。')
    } finally { setBusy(false) }
  }

  return <section aria-labelledby="model-routing-title" className="ops-surface">
    <header className="ops-surface-head"><h2 id="model-routing-title">模型设置</h2></header>
    <div className="ops-inset ops-stack">
    {saved ? <form onSubmit={(event) => { event.preventDefault(); void save() }} style={form}>
      {liveCatalog && saved.profiles.length === 0 && <p role="status">DSH 当前没有提供可用模型。请在 DSH 模型设置中检查供应商连接，再重新读取。</p>}
      {!!saved.unavailable_providers?.length && <p role="status">部分供应商的目录读取失败（{saved.unavailable_providers.join('、')}）。请检查 DSH 中的连接后重新读取。</p>}
      {conflicts.length > 0 && <section aria-labelledby="model-conflicts-title" className="ops-inset" style={fieldList}>
        <h3 id="model-conflicts-title">模型设置有冲突</h3>
        <p role="alert">其他操作已修改以下设置。请逐项选择采用最新设置，或确认保存时覆盖为你的修改。</p>
        <ul style={fieldList}>{conflicts.map(({ key, label, latest, mine, resolve }) => <li key={key}>
          <strong>{label}</strong>
          <dl className="ops-meta" style={{ overflowWrap: 'anywhere' }}><dt>最新设置</dt><dd>{latest}</dd><dt>我的修改</dt><dd>{mine}</dd></dl>
          <div style={conflictActions}>
            <button type="button" className="ops-button" disabled={locked} onClick={() => resolve(false)}>采用最新设置</button>
            <button type="button" className="ops-button" disabled={locked} onClick={() => resolve(true)}>保留我的修改</button>
          </div>
        </li>)}</ul>
      </section>}
      {plannerConfigurable && <section aria-labelledby="planner-routing-title" className="ops-inset" style={fieldList}>
        <h3 id="planner-routing-title" ref={plannerHeadingRef} className="ops-settings-anchor" tabIndex={-1}>主脑模型</h3>
        <p className="ops-meta">用于生成任务计划、流程草稿和返工建议。</p>
        <label style={field}>模型来源
          <select id="model-planner-mode" className="ops-field" value={planner ? 'fixed' : 'session'} disabled={locked}
            onChange={(event) => editPlanner(event.target.value === 'fixed' ? persistedPlanner ?? { ref: profiles[0]?.ref ?? '', effort: null } : null)}>
            <option value="session">跟随当前会话（默认）</option>
            <option value="fixed">指定主脑模型</option>
          </select>
        </label>
        {planner && <>
          <ModelPicker scope="planner" profiles={profiles} refValue={planner.ref} locked={locked}
            onPick={(ref) => editPlanner({ ref, effort: null })} />
          {!plannerProfile && <p className="ops-meta">当前目录没有已选主脑模型。请重新选择，或恢复跟随当前会话。</p>}
          {plannerProfile && (!!planner.effort || !plannerPreset && !!plannerReasoning?.efforts.length ? <div style={field}>
            <label htmlFor="model-planner-effort">思考深度</label>
            <select id="model-planner-effort" className="ops-field" value={planner.effort ?? ''} disabled={locked}
              onChange={(event) => editPlanner({ ref: planner.ref, effort: event.target.value || null })}>
              <option value="">宿主默认{plannerNativeDefault ? `（${plannerNativeDefault.name}）` : ''}</option>
              {invalidPlannerEffort && <option value={planner.effort!}>已不可用 · {planner.effort}</option>}
              {plannerReasoning?.efforts.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            </select>
            {invalidPlannerEffort && <p className="ops-meta" style={fieldHint}>请改选宿主默认或当前支持的思考档。</p>}
          </div> : <p className="ops-meta">{plannerPreset
            ? `该模型只提供 ${plannerPreset.name}，使用宿主默认。` : '该模型未提供可调思考档，使用宿主默认。'}</p>)}
        </>}
      </section>}
      <h3 id="submodel-routing-title" ref={submodelHeadingRef} className="ops-settings-anchor" tabIndex={-1}>子智能体模型分配</h3>
      {unavailableDrafts > 0 && <p role="status">有 {unavailableDrafts} 个模型的草稿已保留，模型重新出现在目录后可继续编辑。</p>}
      {editor && <fieldset className="ops-inset" style={fieldList}>
        <legend>编辑子智能体模型</legend>
        <ModelPicker scope="profile" profiles={profiles} refValue={editor.ref} locked={locked} onPick={setEditorRef} />
        <label style={field}>最大能力
          <select id="model-profile-capacity" className="ops-field" aria-label={`${modelLabel(editor)} 最大能力`}
            disabled={locked} value={capacityOf(editor.ref) ?? ''} onChange={(event) => editModel(editor.ref,
              { capacity: event.target.value ? event.target.value as ModelComplexity : null })}>
            <option value="">{editorHostCapacity ? `宿主默认（${MODEL_LEVELS[editorHostCapacity].label}）` : '未评估'}</option>
            {MODEL_COMPLEXITIES.map((level) => <option key={level} value={level}>{MODEL_LEVELS[level].label}</option>)}
          </select>
        </label>
        <label style={field}>用途说明
          <input className="ops-field" aria-label={`${modelLabel(editor)} 用途说明`} aria-describedby="model-note-help"
            disabled={locked} maxLength={MODEL_NOTE_MAX_LENGTH} value={noteOf(editor.ref)}
            onChange={(event) => editModel(editor.ref, { note: event.target.value })} />
        </label>
        <p id="model-note-help" className="ops-meta">用途可留空，每条最多 {MODEL_NOTE_MAX_LENGTH} 字，供主脑选择模型时参考。</p>
        {(!!editorEffort || !editorPreset && !!editorReasoning?.efforts.length) ? <div style={field}>
            <label htmlFor="model-profile-effort">默认思考深度</label>
            <select id="model-profile-effort" className="ops-field" disabled={locked} value={editorEffort ?? ''}
              onChange={(event) => editModel(editor.ref, { effort: event.target.value || null })}>
              <option value="">宿主默认{nativeDefault ? `（${nativeDefault.name}）` : ''}</option>
              {invalidEditorEffort && <option value={editorEffort}>已不可用 · {editorEffort}</option>}
              {editorReasoning?.efforts.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            </select>
            {invalidEditorEffort && <span className="ops-meta" style={fieldHint}>请改选宿主默认或模型当前支持的思考档。</span>}
          </div> : <p className="ops-meta">{editorPreset
            ? `该模型只提供 ${editorPreset.name}，使用宿主默认。` : '该模型未提供可调思考档，使用宿主默认。'}</p>}
      </fieldset>}
      <p className="ops-meta">自动分配采用合格的主脑候选，其次选满足要求的最低档。常规至进阶在无合格候选时可沿用当前 DSH 会话已授权且未评估的模型。分配时优先使用当前复杂度的思考档，其次使用模型配置，最后沿用宿主默认。</p>
      {MODEL_COMPLEXITIES.map((level, index) => {
        const { label, description } = MODEL_LEVELS[level]
        const eligible = profiles.filter((item) => {
          const capacity = capacityFor(item)
          return capacity !== null && MODEL_COMPLEXITIES.indexOf(capacity) >= index
        })
        const session = profiles.find(({ ref }) => ref === saved?.session_execution_model_ref)
        const usesSession = eligible.length === 0 && session && capacityFor(session) === null && index <= MODEL_COMPLEXITIES.indexOf('advanced')
        const current = mapping[level]
        const selected = eligible.find(({ ref }) => current === ref)
        const reasoning = selected?.reasoning
        const preset = presetOnly(selected)
        const effort = (tierDrafts[level]?.value ?? savedTier(level)).effort ?? ''
        const modelDefault = selected ? effortOf(selected.ref) : null
        const defaultId = modelDefault ?? reasoning?.defaultEffort
        const defaultLabel = reasoning?.efforts.find(({ id }) => id === defaultId)?.name
          ?? (modelDefault ? `${modelDefault} 已不可用` : undefined)
        const effortUnavailable = !!effort && !reasoning?.efforts.some(({ id }) => id === effort)
        return <div key={level} style={field}>
          <label htmlFor={`model-route-${level}`}>{label}</label>
          <select id={`model-route-${level}`} className="ops-field" aria-describedby={`model-capacity-${level}`}
            disabled={locked} value={current ?? ''} onChange={(event) =>
              editTier(level, { ref: event.target.value || null, effort: null })}>
            <option value="">自动选择{usesSession ? '（沿用当前会话模型）' : eligible.length === 0 ? '（暂无候选）' : ''}</option>
            {current && !selected && <option value={current}>已不可用 · {current}</option>}
            {eligible.map((item) => <option key={item.ref} value={item.ref}>{modelLabel(item)}</option>)}
          </select>
          <span id={`model-capacity-${level}`} className="ops-meta" style={fieldHint}>{description}
            {usesSession && `。当前会话模型为 ${modelLabel(session)}，能力未评估。`}
            {eligible.length === 0 && !usesSession && '。可调整模型的最大能力，或在 DSH 中配置更多模型后重新读取。'}
            {current && !selected && '。已保存的模型已移除或能力不足，请改选模型或自动选择。'}
          </span>
          {selected && (!!effort || !preset && !!reasoning?.efforts.length) ? <>
            <label htmlFor={`model-effort-${level}`} className="ops-meta">思考深度</label>
            <select id={`model-effort-${level}`} aria-label={`${label}思考深度`} className="ops-field" value={effort}
              disabled={locked} onChange={(event) =>
                editTier(level, { ref: current, effort: event.target.value || null })}>
              <option value="">模型默认{defaultLabel ? `（${defaultLabel}）` : ''}</option>
              {effortUnavailable && <option value={effort}>已不可用 · {effort}</option>}
              {reasoning?.efforts.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            </select>
            {effortUnavailable && <span className="ops-meta" style={fieldHint}>该模型已移除所保存的思考档，请改选模型默认或当前支持的档位。</span>}
          </> : liveCatalog && selected && <span className="ops-meta" style={fieldHint}>{preset
            ? `该模型只提供 ${preset.name}，使用模型默认。` : '该模型未提供可调思考档，使用模型默认。'}</span>}
        </div>
      })}
      <div style={{ display: 'flex', gap: 8 }}>
        <PanelCommandButton type="submit" className="ops-button ops-button--primary"
          disabled={locked || !dirty || invalidPlannerDraft || conflicts.length > 0}>保存模型分配</PanelCommandButton>
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
const fieldList = { display: 'grid', minWidth: 0, gap: 6 }
const editorSelectors = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }
const conflictActions = { display: 'flex', flexWrap: 'wrap' as const, gap: 8 }
