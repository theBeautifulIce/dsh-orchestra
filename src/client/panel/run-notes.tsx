import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ApiClient } from '../api/client.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import { PanelCommandButton } from './shell.tsx'

type Note = {
  note_id: string
  author: string
  source: 'node' | 'human'
  attempt: number | null
  body: string
  created_at: string
}

export function RunNotes({ client, runId, reloadVersion }: { client: ApiClient; runId: string; reloadVersion: number }) {
  const [items, setItems] = useState<Note[]>()
  const [body, setBody] = useState('')
  const [revision, setRevision] = useState(0)
  const [loadError, setLoadError] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
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
    if (saving || !text || digits > 500) return
    const id = pending.current?.text === text ? pending.current.id : newOperationId()
    pending.current = { text, id }
    setSaving(true)
    setSaveError('')
    try {
      await client.post('/v1/run-notes', { run_id: runId, body: text, operation_id: id })
      pending.current = undefined
      setBody('')
      setRevision((value) => value + 1)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '暂未确认便条是否已添加。')
    } finally { setSaving(false) }
  }

  return <section className="task-drawer-card" aria-label="本次运行便条">
    <h3>本次运行便条</h3>
    <p>所附内容仅在本次运行内共享，供参考。验收仍需独立证据。</p>
    {loadError ? <p role="alert">暂时无法读取本次运行便条。
      <button type="button" className="task-quiet-button" onClick={() => setRevision((value) => value + 1)}>重试读取</button>
    </p> : items ? items.length ? <ul>
      {items.map((note) => <li key={note.note_id}>
        <p>{note.source === 'human' ? '操作人' : '步骤'} {note.author}{note.attempt !== null && ` · 第 ${note.attempt} 次尝试`}
          {' · '}<time dateTime={note.created_at}>{new Date(note.created_at).toLocaleString()}</time></p>
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{note.body}</p>
      </li>)}
    </ul> : <p>本次运行暂无共同可见的便条。</p> : <p role="status">正在读取运行便条…</p>}
    <form onSubmit={(event) => { void submit(event) }}>
      <label>本运行可见的便条<textarea value={body} maxLength={1000} rows={3} disabled={saving}
        onChange={(event) => setBody(event.target.value)} /></label>
      <span aria-live="polite">{digits} / 500 字</span>
      <PanelCommandButton type="submit" disabled={saving || !body.trim() || digits > 500}>添加便条</PanelCommandButton>
      {saveError && <p role="alert">{saveError}</p>}
    </form>
  </section>
}
