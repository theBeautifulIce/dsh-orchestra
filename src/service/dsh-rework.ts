import { z } from 'zod'
import { sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { registerRunArtifactInTx, isArtifactFileName } from './artifact-store.ts'
import { reworkRequestSchema, reworkReviewSchema, type ReworkBinding, type ReworkHost } from './rework-coordinator.ts'
import { runIdempotentCommand, requestHashOf } from './commands/idempotency.ts'
import { assertReworkRunActive } from './rework-runtime.ts'
import { recordArtifactPublication } from './artifact-completion.ts'

const key = z.string().min(1).max(256)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const publish = z.strictObject({ operation_id: z.uuidv7(), file_name: key.refine(isArtifactFileName),
  text: z.string().min(1).max(65536) })
const read = z.strictObject({ artifact_id: key, artifact_hash: hash, offset: z.number().int().nonnegative().default(0) })

/** The host owns the session binding. No run, producer, evidence or filename comes from an agent-supplied path. */
export function callDshRework(db: Db, host: ReworkHost, binding: ReworkBinding, input: unknown, now = new Date().toISOString(), secret?: string) {
  const { action, ...body } = z.looseObject({ action: z.string() }).parse(input)
  const node = db.raw.prepare(`SELECT run_id FROM node_runs WHERE node_run_id=? AND attempt=? AND action_generation=?
    AND status IN ('started','verifying') AND replacement_node_run_id IS NULL`).get(binding.node_run_id, binding.attempt, binding.action_generation)
  if (!node) throw new OrchError('STALE_GENERATION', '该返工工具会话已过期')
  const runId = String(node.run_id)
  if (action === 'inbox') return host.list(binding, runId)
  if (action === 'get') return host.get(z.strictObject({ request_id: key }).parse(body).request_id, binding)
  if (action === 'request') return host.request(reworkRequestSchema.parse(body), binding, now)
  if (action === 'accept' || action === 'request_changes' || action === 'escalate') {
    return host.review(reworkReviewSchema.parse({ ...body, action }), binding, now)
  }
  return withTx(db, (tx) => {
    assertReworkRunActive(tx, runId)
    if (action === 'publish') {
      const data = publish.parse(body)
      return runIdempotentCommand(tx, { kind: 'rework.artifact', operationId: data.operation_id,
        requestHash: requestHashOf('rework.artifact', { binding, ...data }), now }, () => {
        const producer = tx.get<{ run_id: string; node_id: string; lease_id: string | null; lease_expires_at: string | null }>(
          `SELECT run_id,node_id,lease_id,lease_expires_at FROM node_runs WHERE node_run_id=? AND attempt=? AND action_generation=?
            AND status IN ('started','verifying') AND replacement_node_run_id IS NULL`,
          [binding.node_run_id, binding.attempt, binding.action_generation],
        )
        if (!producer || producer.run_id !== runId) throw new OrchError('STALE_GENERATION', '成果提交对应的执行尝试已失效')
        if (Buffer.byteLength(data.text) > 65536) throw new OrchError('RANGE_TOO_LARGE', '每份文本成果最多 64 KiB')
        const count = tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact_contents WHERE node_run_id=?', [binding.node_run_id])
        if ((count?.n ?? 0) >= 8) throw new OrchError('RANGE_TOO_LARGE', '每次执行最多提交八份文本成果')
        const artifactId = 'out_' + sha256Hex(JSON.stringify([binding.node_run_id, data.file_name]))
        const firstPublication = !tx.get('SELECT 1 FROM artifacts WHERE artifact_id=?', [artifactId])
        const artifact = registerRunArtifactInTx(tx, { artifactId,
          runId, nodeRunId: binding.node_run_id, bytes: Buffer.from(data.text), fileName: data.file_name }, now)
        if (secret && firstPublication && producer.lease_id && producer.lease_expires_at && Date.parse(producer.lease_expires_at) > Date.parse(now)) {
          recordArtifactPublication(tx, secret, binding, producer, data.file_name, artifact)
        }
        return artifact
      }).result
    }
    if (action !== 'read') throw new OrchError('PAYLOAD_SCHEMA_INVALID', '未知成果操作')
    const data = read.parse(body)
    const row = tx.get<{ bytes: Uint8Array; file_name: string }>(`SELECT c.bytes,c.file_name FROM artifacts a JOIN artifact_contents c USING(artifact_id)
      WHERE a.run_id=? AND a.artifact_id=? AND a.sha256=? AND (a.retain_until IS NULL OR a.retain_until>?)
      AND (EXISTS (SELECT 1 FROM artifact_consumptions i WHERE i.consumer_node_run_id=? AND i.artifact_id=a.artifact_id AND i.artifact_hash=a.sha256)
        OR EXISTS (SELECT 1 FROM rework_requests r WHERE r.new_node_run_id=? AND r.source_artifact_id=a.artifact_id
          AND r.source_artifact_hash=a.sha256 AND r.status='scheduled'))`,
    [runId, data.artifact_id, data.artifact_hash, now, binding.node_run_id, binding.node_run_id])
    if (!row) throw new OrchError('FORBIDDEN', '成果不在本次执行的输入范围内')
    const bytes = Buffer.from(row.bytes)
    if (sha256Hex(bytes) !== data.artifact_hash) throw new OrchError('CONFIRMATION_MISMATCH', '成果内容校验失败')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new OrchError('RESOLUTION_NOT_AVAILABLE', '智能体文本读取支持 UTF-8 成果') }
    if (data.offset > text.length) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '读取位置超过成果长度')
    const end = Math.min(text.length, data.offset + 8192)
    return { file_name: row.file_name, artifact_hash: data.artifact_hash, text: text.slice(data.offset, end),
      next_offset: end < text.length ? end : null }
  })
}
