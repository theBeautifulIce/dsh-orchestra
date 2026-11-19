import { useEffect, useState } from 'react'
import type { ApiClient } from '../api/client.ts'
import { postWithOperationReceipt } from '../api/commands.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import type { ModelRoutingSettingsView } from '../../service/model-routing-settings.ts'
import { PanelCommandButton } from './shell.tsx'

const PATH = '/v1/settings/model-routing'
const LEVELS = [['routine', '常规'], ['standard', '中等'], ['complex', '复杂']] as const

export function ModelRoutingSettings({ client }: { client: ApiClient }) {
  const [saved, setSaved] = useState<ModelRoutingSettingsView>()
  const [draft, setDraft] = useState<ModelRoutingSettingsView['mapping']>()
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    void client.get<ModelRoutingSettingsView>(PATH).then(({ data }) => {
      if (active) { setSaved(data); setDraft(data.mapping) }
    }).catch(() => { if (active) { setError(true); setMessage('模型配置暂时无法读取。') } })
    return () => { active = false }
  }, [client, reload])

  async function save() {
    if (!saved || !draft || busy) return
    setBusy(true); setMessage(''); setError(false)
    try {
      await postWithOperationReceipt(client, PATH, 'model_routing.save', {
        expected_revision: saved.revision, mapping: draft, operation_id: newOperationId(),
      })
      setMessage('已保存，下一次派发采用新配置。')
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
      {LEVELS.map(([level, label], index) => {
        const profiles = saved.profiles.filter((item) => LEVELS.findIndex(([candidate]) => candidate === item.capacity) >= index)
        const current = draft[level]
        return <label key={level} style={field}>{label}
          <select className="ops-field" disabled={busy} value={current ?? ''} onChange={(event) => setDraft({ ...draft, [level]: event.target.value || null })}>
            <option value="">自动选择</option>
            {current && !profiles.some((item) => item.ref === current) && <option value={current}>已不可用 · {current}</option>}
            {profiles.map((item) => <option key={item.ref} value={item.ref}>
              {item.provider && item.model ? `${item.provider} / ${item.model}` : item.ref}
            </option>)}
          </select>
        </label>
      })}
      <div style={{ display: 'flex', gap: 8 }}>
        <PanelCommandButton type="submit" className="ops-button ops-button--primary" disabled={busy || LEVELS.every(([level]) => saved.mapping[level] === draft[level])}>保存模型分配</PanelCommandButton>
        <button type="button" className="ops-button" disabled={busy} onClick={() => { setError(false); setMessage(''); setReload((value) => value + 1) }}>重新读取</button>
      </div>
    </form> : !error && <p role="status">正在读取宿主模型…</p>}
    {message && <p role={error ? 'alert' : 'status'}>{message}</p>}
    </div>
  </section>
}

const form = { display: 'grid', gap: 7 }
const field = { display: 'grid', gridTemplateColumns: '85px minmax(0, 1fr)', alignItems: 'center', gap: 8 }
