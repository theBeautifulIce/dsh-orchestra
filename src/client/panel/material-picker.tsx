import { useEffect, useRef, useState } from 'react'

type Material = { name: string; body: string }
type Props = {
  recipients: string[]
  onGrant: (items: Material[]) => Promise<void>
}
async function userText(file: File): Promise<Material> {
  if (file.size > 65536) throw new Error('单个文件最多 64 KiB')
  const body = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
  return { name: file.name, body }
}

export function MaterialPicker({ recipients, onGrant }: Props) {
  const [files, setFiles] = useState<File[]>([])
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const lock = useRef(false)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const count = files.length + Number(Boolean(paste.trim()))
  async function submit() {
    if (lock.current || !count || count > 8 || !recipients.length) return
    lock.current = true
    setBusy(true)
    setStatus('')
    try {
      if (new TextEncoder().encode(paste).length > 65536) throw new Error('粘贴文本最多 64 KiB')
      const items = await Promise.all(files.map(userText))
      if (!active.current) return
      if (paste.trim()) items.push({ name: '补充材料.txt', body: paste })
      await onGrant(items)
      if (!active.current) return
      setFiles([])
      setPaste('')
      if (input.current) input.current.value = ''
      setStatus('本次材料已授权')
    } catch (error) {
      if (active.current) setStatus(error instanceof Error ? error.message : '授权未完成，请重试')
    } finally {
      lock.current = false
      if (active.current) setBusy(false)
    }
  }
  return <fieldset disabled={busy}><legend>本次任务材料</legend>
    <label>选择文本文件<input ref={input} type="file" multiple accept=".txt,.md,.csv"
      onChange={e => { setStatus(''); setFiles(Array.from(e.target.files ?? [])) }} /></label>
    <ul>{files.map((f, i) => <li key={i}>{f.name}（{f.size} 字节）</li>)}</ul>
    <label>或粘贴文本<textarea value={paste} onChange={e => { setStatus(''); setPaste(e.target.value) }} /></label>
    <p>材料授权有效期为 30 分钟。可读取材料的步骤：{recipients.join('、') || '待确认'}</p>
    {count > 8 && <p>最多选择 8 份材料</p>}
    <button type="button" disabled={count === 0 || count > 8 || !recipients.length} onClick={submit}>
      {busy ? '正在授权…' : '仅这次使用'}
    </button><p role="status">{status}</p>
  </fieldset>
}
