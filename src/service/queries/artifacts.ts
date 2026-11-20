import { OrchError } from '../../core/errors.ts'
import { sha256Hex } from '../../core/canonical.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { ARTIFACT_MAX_BYTES } from '../artifact-store.ts'
import { withReadTx } from './read-tx.ts'

export type ArtifactView = {
  artifact_id: string
  run_id: string
  sha256: string
  evidence_index: unknown
  retain_until: string | null
  expired: boolean
  file_name?: string
  size_bytes?: number
  source_node_run_id?: string | null
}

export type RunArtifact = Omit<ArtifactView, 'evidence_index'> & { created_at: string }

type ArtifactRow = Pick<RunArtifact, 'artifact_id' | 'run_id' | 'sha256' | 'retain_until'> & {
  file_name: string | null; node_run_id: string | null; size_bytes: number | null
}

function artifactMetadata(row: ArtifactRow, now: number) {
  const retainedUntil = row.retain_until === null ? NaN : Date.parse(row.retain_until)
  return {
    artifact_id: row.artifact_id, run_id: row.run_id, sha256: row.sha256, retain_until: row.retain_until,
    expired: Number.isFinite(retainedUntil) && retainedUntil <= now,
    ...(row.file_name !== null && row.size_bytes !== null
      && { file_name: row.file_name, size_bytes: row.size_bytes, source_node_run_id: row.node_run_id }),
  }
}

const METADATA_COLUMNS = 'a.artifact_id, a.run_id, a.sha256, a.retain_until, c.file_name, c.node_run_id, length(c.bytes) AS size_bytes'
const ARTIFACTS_JOIN = ' FROM artifacts a LEFT JOIN artifact_contents c USING (artifact_id)'

export function listRunArtifacts(db: Db, runId: string, now = Date.now()) {
  return withReadTx(db, (ctx) => {
    if (!ctx.tx.get('SELECT 1 FROM runs WHERE run_id = ?', [runId])) throw new OrchError('NOT_FOUND', '没找到这次运行')
    const rows = ctx.tx.all<ArtifactRow & { created_at: string }>(
      'SELECT ' + METADATA_COLUMNS + ', a.created_at' + ARTIFACTS_JOIN
      + ' WHERE a.run_id = ? ORDER BY a.created_at DESC, a.artifact_id DESC LIMIT 51', [runId],
    )
    return {
      items: rows.slice(0, 50).map((row): RunArtifact => ({ ...artifactMetadata(row, now), created_at: row.created_at })),
      has_more: rows.length > 50, as_of_seq: ctx.as_of_seq,
    }
  })
}

export function findRunArtifactIdsByName(db: Db, runId: string, fileName: string, now: number): string[] {
  return withReadTx(db, ({ tx }) => tx.all<{ artifact_id: string }>(
    `SELECT a.artifact_id FROM artifacts a JOIN artifact_contents c USING (artifact_id)
      WHERE a.run_id = ? AND c.file_name = ?
        AND (a.retain_until IS NULL OR julianday(a.retain_until) > julianday(?))
      LIMIT 2`, [runId, fileName, new Date(now).toISOString()],
  ).map(({ artifact_id }) => artifact_id))
}

function parseEvidenceIndex(raw: unknown): unknown {
  if (typeof raw !== 'string') return null
  try { return JSON.parse(raw) as unknown } catch { return null }
}

export function getArtifactSnapshot(db: Db, artifactId: string, now = Date.now()): { item: ArtifactView; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const row = ctx.tx.get<ArtifactRow & { evidence_index: string | null }>(
      'SELECT ' + METADATA_COLUMNS + ', a.evidence_index' + ARTIFACTS_JOIN + ' WHERE a.artifact_id = ?',
      [artifactId],
    )
    if (!row) throw new OrchError('NOT_FOUND', '没找到这份产物')
    return {
      item: {
        ...artifactMetadata(row, now),
        evidence_index: parseEvidenceIndex(row.evidence_index),
      },
      as_of_seq: ctx.as_of_seq,
    }
  })
}

export function getArtifact(db: Db, artifactId: string, now = Date.now()): ArtifactView {
  return getArtifactSnapshot(db, artifactId, now).item
}

const PREVIEW_MAX_BYTES = 32 * 1024
const TEXT_EXTENSION = /\.(?:md|markdown|txt|json|jsonl|csv|tsv|log|ya?ml|xml|ini|html?|svg)$/i

type ArtifactContentMetadata = { file_name: string; size_bytes: number; sha256: string }
export type ArtifactContentMode = 'preview' | 'download'
export type ArtifactContentView = ArtifactContentMetadata & (
  | { kind: 'preview'; text: string; truncated: boolean }
  | { kind: 'download'; base64: string }
)

export function getArtifactContent(
  db: Db, runId: string, artifactId: string, mode: ArtifactContentMode, now: number,
): { item: ArtifactContentView; as_of_seq: number } {
  return withReadTx(db, ({ tx, as_of_seq }) => {
    const row = tx.get<ArtifactRow>('SELECT ' + METADATA_COLUMNS + ARTIFACTS_JOIN
      + ' WHERE a.run_id = ? AND a.artifact_id = ?', [runId, artifactId])
    if (!row) throw new OrchError('NOT_FOUND', '没找到这次运行的产物')
    if (row.retain_until !== null) {
      const retainedUntil = Date.parse(row.retain_until)
      if (!Number.isFinite(retainedUntil)) throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '产物保留期限未通过校验')
      if (retainedUntil <= now) throw new OrchError('OPERATION_EXPIRED', '已超过产物保留期限')
    }
    if (row.file_name === null || row.size_bytes === null) {
      throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '这份产物仅有登记记录，内容尚未入库')
    }
    if (row.size_bytes > ARTIFACT_MAX_BYTES) throw new OrchError('RANGE_TOO_LARGE', '产物内容超过读取上限')
    const stored = tx.get<{ bytes: Uint8Array }>('SELECT bytes FROM artifact_contents WHERE artifact_id = ?', [artifactId])
    if (!stored || !(stored.bytes instanceof Uint8Array)) throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '未读取到产物字节')
    const bytes = Buffer.from(stored.bytes)
    if (sha256Hex(bytes) !== row.sha256) throw new OrchError('CONFIRMATION_MISMATCH', '产物内容与登记的哈希不匹配')
    const meta = { file_name: row.file_name, size_bytes: row.size_bytes, sha256: row.sha256 }
    if (mode === 'download') return { item: { ...meta, kind: 'download', base64: bytes.toString('base64') }, as_of_seq }
    if (!TEXT_EXTENSION.test(row.file_name)) {
      throw new OrchError('RESOLUTION_NOT_AVAILABLE', '此格式支持下载。预览支持 UTF-8 文本。')
    }
    const truncated = bytes.byteLength > PREVIEW_MAX_BYTES
    let decoded: string
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, PREVIEW_MAX_BYTES), { stream: truncated })
    } catch {
      throw new OrchError('RESOLUTION_NOT_AVAILABLE', '此产物无法按 UTF-8 文本预览')
    }
    if (decoded.includes('\0')) throw new OrchError('RESOLUTION_NOT_AVAILABLE', '此产物无法按文本预览')
    return { item: { ...meta, kind: 'preview', text: decoded, truncated }, as_of_seq }
  })
}
