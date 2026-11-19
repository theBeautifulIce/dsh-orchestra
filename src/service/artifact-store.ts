import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'

export const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024
const EVIDENCE_INDEX_MAX_BYTES = 16 * 1024
const UNSAFE_FILE_NAME = /[\u0000-\u001f\u007f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/u
const RESERVED_FILE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function isArtifactFileName(fileName: unknown): fileName is string {
  return typeof fileName === 'string' && fileName.length > 0 && fileName.trim() === fileName && fileName.length <= 240
    && !fileName.endsWith('.') && !UNSAFE_FILE_NAME.test(fileName) && !RESERVED_FILE_NAME.test(fileName)
}

export type RegisterRunArtifact = {
  artifactId: string
  runId: string
  fileName: string
  bytes: Uint8Array
  nodeRunId?: string
  evidenceIndex?: unknown
  retainUntil?: string
}

function checkIdentifier(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '产物或运行编号无效')
  }
}

/** Only trusted producers can register bytes. Metadata and content commit together. */
export function registerRunArtifact(db: Db, input: RegisterRunArtifact, now = new Date().toISOString()) {
  checkIdentifier(input.artifactId)
  checkIdentifier(input.runId)
  if (input.nodeRunId !== undefined) checkIdentifier(input.nodeRunId)
  const fileName = input.fileName
  if (!isArtifactFileName(fileName)) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '产物文件名必须为普通文件名')
  }
  if (!(input.bytes instanceof Uint8Array)) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '产物必须提供字节内容')
  if (input.bytes.byteLength > ARTIFACT_MAX_BYTES) throw new OrchError('RANGE_TOO_LARGE', '每份产物最多 8 MiB')
  if (!Number.isFinite(Date.parse(now))) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '产物登记时间无效')
  const retainUntil = input.retainUntil === undefined ? null : Date.parse(input.retainUntil)
  if (retainUntil !== null && !Number.isFinite(retainUntil)) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '产物保留期限无效')
  const retainAt = retainUntil === null ? null : new Date(retainUntil).toISOString()
  let evidenceIndex: string | null = null
  if (input.evidenceIndex !== undefined && input.evidenceIndex !== null) {
    try { evidenceIndex = canonicalJson(input.evidenceIndex) } catch {
      throw new OrchError('PAYLOAD_SCHEMA_INVALID', '产物证据索引必须可序列化')
    }
    if (Buffer.byteLength(evidenceIndex, 'utf8') > EVIDENCE_INDEX_MAX_BYTES) {
      throw new OrchError('RANGE_TOO_LARGE', '产物证据索引超过 16 KiB')
    }
  }
  const bytes = Buffer.from(input.bytes)
  const sha256 = sha256Hex(bytes)
  const nodeRunId = input.nodeRunId ?? null
  return withTx(db, (tx) => {
    if (!tx.get('SELECT 1 FROM runs WHERE run_id = ?', [input.runId])) {
      throw new OrchError('NOT_FOUND', '没找到产物所属的运行')
    }
    if (nodeRunId !== null && !tx.get('SELECT 1 FROM node_runs WHERE run_id = ? AND node_run_id = ?', [input.runId, nodeRunId])) {
      throw new OrchError('NOT_FOUND', '没找到产物所属的运行节点')
    }
    const existing = tx.get<{
      run_id: string; sha256: string; evidence_index: string | null; retain_until: string | null
      file_name: string | null; node_run_id: string | null
    }>('SELECT a.run_id, a.sha256, a.evidence_index, a.retain_until, c.file_name, c.node_run_id'
      + ' FROM artifacts a LEFT JOIN artifact_contents c USING (artifact_id) WHERE a.artifact_id = ?', [input.artifactId])
    if (existing && (
      existing.run_id !== input.runId || existing.sha256 !== sha256 || existing.evidence_index !== evidenceIndex
      || existing.retain_until !== retainAt || (existing.file_name !== null && (existing.file_name !== fileName || existing.node_run_id !== nodeRunId))
    )) {
      throw new OrchError('OPERATION_ID_CONFLICT', '该产物编号已绑定其他内容或来源')
    }
    if (!existing) {
      tx.run('INSERT INTO artifacts (artifact_id, run_id, uri, sha256, evidence_index, retain_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [input.artifactId, input.runId, 'orch:sha256:' + sha256, sha256, evidenceIndex, retainAt, new Date(now).toISOString()])
    }
    if (!existing?.file_name) {
      tx.run('INSERT INTO artifact_contents (artifact_id, file_name, node_run_id, bytes) VALUES (?, ?, ?, ?)',
        [input.artifactId, fileName, nodeRunId, bytes])
      appendEvent(tx, {
        type: 'artifact.registered', runId: input.runId, nodeRunId,
        payload: { artifact_id: input.artifactId, sha256, size_bytes: bytes.byteLength },
      })
    }
    return { artifact_id: input.artifactId, run_id: input.runId, sha256, size_bytes: bytes.byteLength }
  })
}
