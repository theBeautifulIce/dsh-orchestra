import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { ArtifactContentMode, ArtifactContentView, RunArtifact } from '../api/types.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { MarkdownReading } from './markdown-reading.tsx'

type ReadableArtifact = Omit<RunArtifact, 'created_at'>

type Preview = Extract<ArtifactContentView, { kind: 'preview' }>
type Download = Extract<ArtifactContentView, { kind: 'download' }>

function saveArtifact(artifact: Download): void {
  const binary = atob(artifact.base64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (bytes.byteLength !== artifact.size_bytes) throw new Error('下载内容大小与登记不一致')
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url
  link.download = artifact.file_name
  link.hidden = true
  document.body.append(link)
  try { link.click() } finally {
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

export function artifactContentKey(artifact: ReadableArtifact): string {
  return JSON.stringify([artifact.run_id, artifact.artifact_id, artifact.sha256, artifact.file_name, artifact.retain_until])
}

export function matchesArtifactContent(content: ArtifactContentView, artifact: ReadableArtifact): boolean {
  return content.sha256 === artifact.sha256 && content.file_name === artifact.file_name
}

type ArtifactContentProps = { api: ResourcesApi; artifact: ReadableArtifact
  /** 取得并核验了哪一版：审核入口据此决定能不能提交结论（D08）。 */
  onAcquired?: (acquired: { key: string; mode: ArtifactContentMode }) => void
  autoPreview?: boolean }

export function useArtifactRetention(artifact?: ReadableArtifact): 'available' | 'expired' | 'invalid' {
  const [, refresh] = useState(0)
  const deadline = artifact?.retain_until == null ? Infinity : Date.parse(artifact.retain_until)
  const markedExpired = artifact?.expired === true
  useEffect(() => {
    if (markedExpired || !Number.isFinite(deadline) || deadline <= Date.now()) return
    let timer: number | undefined
    const check = () => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) refresh(tick => tick + 1)
      else timer = window.setTimeout(check, Math.min(remaining, 2_147_483_647))
    }
    check()
    return () => window.clearTimeout(timer)
  }, [markedExpired, deadline])
  if (markedExpired || deadline <= Date.now()) return 'expired'
  return Number.isNaN(deadline) ? 'invalid' : 'available'
}

export function ArtifactContent({ api, artifact, onAcquired, autoPreview }: ArtifactContentProps) {
  const retention = useArtifactRetention(artifact)
  if (retention === 'expired') return <p style={noteStyle}>已超过保留期限。仍可查看登记记录。</p>
  if (retention === 'invalid') return <p style={noteStyle}>产物保留期限未通过校验。仍可查看登记记录。</p>
  if (!artifact.file_name) return <p style={noteStyle}>这份产物仅有登记记录，内容尚未入库。</p>
  return <ArtifactContentReader key={artifactContentKey(artifact)} api={api} artifact={artifact} onAcquired={onAcquired} autoPreview={autoPreview} />
}

/** 只有登记过的 Markdown 才给阅读视图：其它文本仍按原文呈现（D11）。 */
function isMarkdown(artifact: ReadableArtifact): boolean {
  return /\.(?:md|markdown)$/iu.test(artifact.file_name ?? '')
}

function ArtifactContentReader({ api, artifact, onAcquired, autoPreview }: ArtifactContentProps) {
  const [pending, setPending] = useState<ArtifactContentMode | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [notice, setNotice] = useState('')
  const active = useRef(false)
  useLayoutEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  async function load(mode: ArtifactContentMode) {
    setNotice('')
    setPending(mode)
    try {
      const { data } = await api.getArtifactContent(artifact.run_id, artifact.artifact_id, mode)
      if (!active.current) return
      if (artifact.retain_until !== null && Date.parse(artifact.retain_until) <= Date.now()) return
      if (data.kind !== mode || !matchesArtifactContent(data, artifact)) {
        throw new Error('返回的内容与登记记录不一致，请刷新')
      }
      if (data.kind === 'preview') setPreview(data)
      else saveArtifact(data)
      // 只有真正取得并核对过这一版（且预览未被截断、下载成功）才算取得版本（D08）。
      if (data.kind === 'download' || !data.truncated) {
        onAcquired?.({ key: artifactContentKey(artifact), mode: data.kind })
      }
    } catch (error) {
      if (active.current) setNotice(error instanceof Error ? error.message : '未能读取产物。')
    } finally {
      if (active.current) setPending(null)
    }
  }

  useEffect(() => { if (autoPreview) void load('preview') }, [autoPreview])

  return <section aria-label={artifact.file_name + '的内容'} style={{ marginTop: 10 }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" style={buttonStyle} disabled={pending !== null} aria-expanded={preview !== null}
        onClick={() => preview ? setPreview(null) : void load('preview')}>{preview ? '收起预览' : '预览内容'}</button>
      <button type="button" style={buttonStyle} disabled={pending !== null} onClick={() => { void load('download') }}>下载产物</button>
    </div>
    {pending && <p role="status" style={noteStyle}>正在读取并核验产物…</p>}
    {notice && <p role="alert" style={noteStyle}>{notice}</p>}
    {preview && <>
      {preview.truncated && <p style={noteStyle}>预览仅显示前 32 KiB，可下载完整产物。</p>}
      {isMarkdown(artifact) && !preview.truncated
        ? <MarkdownReading text={preview.text} />
        : <pre style={previewStyle}>{preview.text}</pre>}
    </>}
  </section>
}

const buttonStyle = {
  minHeight: 36, padding: '0 12px', border: `1px solid ${COLOR.line}`, borderRadius: 7,
  background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer',
}
const noteStyle = { color: COLOR.inkMuted, fontSize: FONT_PX.helper, margin: '6px 0' }
const previewStyle = {
  maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const,
  padding: 10, border: `1px solid ${COLOR.line}`, borderRadius: 6, color: COLOR.ink, fontSize: FONT_PX.body,
}
