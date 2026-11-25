import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { ApiClient } from '../api/client.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import { PanelCommandButton, usePanelCommandsEnabled } from './shell.tsx'
import { COLOR, FONT_PX } from './tokens.ts'

type Note = {
  note_id: string
  author: string
  source: 'node' | 'human'
  attempt: number | null
  body: string
  created_at: string
}

type RunNotesProps = { client: ApiClient; runId: string; reloadVersion: number }

export function RunNotes(props: RunNotesProps) {
  const [scope, setScope] = useState({ client: props.client, runId: props.runId, epoch: 0 })
  if (scope.client !== props.client || scope.runId !== props.runId) {
    setScope({ client: props.client, runId: props.runId, epoch: scope.epoch + 1 })
    return null
  }
  return <RunNotesBody key={scope.epoch} {...props} />
}

function RunNotesBody({ client, runId, reloadVersion }: RunNotesProps) {
  const [items, setItems] = useState<Note[]>()
  const [body, setBody] = useState('')
  const [revision, setRevision] = useState(0)
  const [loadError, setLoadError] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const writable = usePanelCommandsEnabled()
  const submitting = useRef(false)
  const inputId = useId()
  const helpId = inputId + '-help'
  const countId = inputId + '-count'
  const pending = useRef<{ text: string; id: string }>()
  const digits = [...body].length
  useEffect(() => {
    let active = true
    setLoadError(false)
    void client.get<{ items: Note[] }>('/v1/run-notes', { run_id: runId })
      .then(({ data }) => { if (active) setItems(data.items) })
      .catch(() => { if (active) setLoadError(true) })
    return () => { active = false }
  }, [client, runId, reloadVersion, revision])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = body.trim()
    if (!writable || submitting.current || !text || digits > 500) return
    submitting.current = true
    const id = pending.current?.text === text ? pending.current.id : newOperationId()
    pending.current = { text, id }
    setSaving(true)
    setSaved(false)
    setSaveError('')
    try {
      await client.post('/v1/run-notes', { run_id: runId, body: text, operation_id: id })
      pending.current = undefined
      setBody('')
      setSaved(true)
      setRevision((value) => value + 1)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '暂未确认便条是否已添加。')
    } finally { submitting.current = false; setSaving(false) }
  }

  return <section className="task-drawer-card ops-run-notes" aria-label="本次运行便条">
    <style>{RUN_NOTES_CSS}</style>
    <header className="ops-run-notes-head">
      <h3>本次运行便条</h3>
      <p id={helpId}>便条供本次运行中的协作参考，不是审批、执行指令或验收证据。</p>
    </header>
    {loadError && <div className="ops-run-notes-state">
      <p role="alert">暂时无法读取本次运行便条。{items?.length ? '以下是上次读取的内容。' : ''}</p>
      <button type="button" className="ops-button" onClick={() => setRevision((value) => value + 1)}>重试读取</button>
    </div>}
    {items?.length ? <ul className="ops-run-notes-list">
      {items.map((note) => <li key={note.note_id}>
        <p className="ops-run-note-meta"><strong>{note.source === 'human' ? '操作人' : '步骤 ' + note.author}</strong>
          {note.attempt !== null && <span>第 {note.attempt} 次尝试</span>}
          <time dateTime={note.created_at}>{new Date(note.created_at).toLocaleString()}</time></p>
        <p className="ops-run-note-text">{note.body}</p>
      </li>)}
    </ul> : !loadError && (items ? <p className="ops-run-notes-empty">本次运行暂无共同可见的便条。可以添加需要协作者参考的信息。</p>
      : <p role="status" className="ops-run-notes-empty">正在读取运行便条…</p>)}
    <form className="ops-run-notes-form" onSubmit={(event) => { void submit(event) }}>
      <label htmlFor={inputId}>添加运行便条</label>
      <textarea id={inputId} className="ops-field" value={body} maxLength={1000} rows={4} disabled={saving || !writable}
        placeholder="例如：资料位置、已核对的事实、需要留意的事项"
        aria-describedby={helpId + ' ' + countId} aria-invalid={digits > 500 || undefined}
        onChange={(event) => { setBody(event.target.value); setSaved(false) }} />
      <div className="ops-run-notes-actions">
        <span id={countId} className="ops-run-notes-count" data-invalid={digits > 500}>{digits} / 500 字</span>
        <PanelCommandButton className="ops-button--primary" type="submit" disabled={saving || !body.trim() || digits > 500}>
          {saving ? '正在添加…' : '添加便条'}
        </PanelCommandButton>
      </div>
      {digits > 500 && <p role="alert">便条最多 500 字，请缩短后再添加。</p>}
      {saveError && <p role="alert" className="ops-run-notes-error">{saveError}。原内容已保留；相同内容重试将沿用原操作编号。</p>}
      {saved && <p role="status" className="ops-run-notes-success">便条已添加。</p>}
    </form>
  </section>
}

// Scoped to this card. Use the same A-workbench design tokens and shared controls.
export const RUN_NOTES_CSS = `
.ops-run-notes { display: grid; gap: 16px; min-width: 0; overflow-wrap: anywhere; }
.ops-run-notes h3, .ops-run-notes p { margin: 0; }
.ops-run-notes-head { display: grid; gap: 7px; }
.ops-run-notes-head h3 { font-size: ${FONT_PX.section}px; }
.ops-run-notes-head p, .ops-run-notes-count, .ops-run-note-meta { color: ${COLOR.inkMuted}; font-size: ${FONT_PX.helper}px; line-height: 1.6; }
.ops-run-notes-empty { border: 1px solid ${COLOR.line}; border-radius: 8px; padding: 12px; background: ${COLOR.sidebar}; color: ${COLOR.inkMuted}; font-size: ${FONT_PX.menu}px; line-height: 1.7; }
.ops-run-notes-list { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; min-width: 0; }
.ops-run-notes-list li { min-width: 0; padding: 12px; border: 1px solid ${COLOR.line}; border-radius: 8px; display: grid; gap: 6px; }
.ops-run-note-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.ops-run-note-meta strong { color: ${COLOR.ink}; font-weight: 600; }
.ops-run-note-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.ops-run-notes-form { display: grid; gap: 9px; min-width: 0; padding-top: 14px; border-top: 1px solid ${COLOR.line}; }
.ops-run-notes-form label { font-weight: 650; }
.ops-run-notes .ops-run-notes-form textarea.ops-field { width: 100%; min-width: 0; min-height: 108px; max-width: 100%; resize: vertical; line-height: 1.6; }
.ops-run-notes-actions, .ops-run-notes-state { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; min-width: 0; }
.ops-run-notes-actions button { margin-left: auto; max-width: 100%; white-space: normal; }
.ops-panel-viewport .ops-run-notes-actions .ops-button--primary:disabled { color: ${COLOR.inkMuted}; background: ${COLOR.sidebar}; border-color: ${COLOR.line}; }
.ops-run-notes textarea:focus-visible { outline: 2px solid ${COLOR.link}; outline-offset: 2px; }
.ops-run-notes-count { font-variant-numeric: tabular-nums; }
.ops-run-notes-count[data-invalid=true], .ops-run-notes-error { color: ${COLOR.danger}; }
.ops-run-notes-success { color: ${COLOR.success}; font-size: ${FONT_PX.menu}px; }
`
