import { z } from 'zod'
import { materialGrant, readMaterial } from './plan-materials.ts'
import { sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'
import { registerRunArtifactInTx, isArtifactFileName } from './artifact-store.ts'
import { assertReworkPublication, materializeReworkPreserved } from './rework-manifest.ts'
import { nativeTextBytes, nativeTextLimits } from './native-text-capability.ts'
import { reworkRequestSchema, reworkReviewSchema, type ReworkBinding, type ReworkHost } from './rework-coordinator.ts'
import { runIdempotentCommand, requestHashOf } from './commands/idempotency.ts'
import { assertReworkRunActive } from './rework-runtime.ts'
import { recordArtifactPublication } from './artifact-completion.ts'

import { approvedArtifactRequirements, readApprovedTaskPlanForRun } from './task-planning.ts'
import { withReadTx } from './queries/read-tx.ts'
import { textTarget, TEXT_PUBLICATION } from './text-result.ts'

const key = z.string().min(1).max(256)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const fileName = key.refine(isArtifactFileName)
const publish = z.strictObject({ operation_id: z.uuidv7(), file_name: fileName,
  text: z.string().min(1).max(65536) })
const publishText = z.strictObject({ operation_id: z.uuidv7(), deliverable_index: z.number().int().min(0).max(19),
  file_name: z.string().optional(),
  text: z.string().min(1).max(65536).refine((text) => Boolean(text.trim()) && !text.includes('\0') && Buffer.from(text, 'utf8').toString('utf8') === text, '请提交完整的 UTF-8 会话正文') })
const read = z.strictObject({ artifact_id: key, artifact_hash: hash, offset: z.number().int().nonnegative().default(0) })

/** A fixed, approved delivery list can narrow a child's next model request. A rework plan may authorize extra files. */
export function readPublicationTargets(db: Db, binding: ReworkBinding) {
  return withReadTx(db, ({ tx }) => {
    const node = tx.get<{ run_id: string; node_id: string }>(
      `SELECT n.run_id,n.node_id FROM node_runs n WHERE n.node_run_id=? AND n.attempt=? AND n.action_generation=?
        AND n.status IN ('started','verifying') AND n.replacement_node_run_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM rework_attempts a WHERE a.new_node_run_id=n.node_run_id)
        AND NOT EXISTS (SELECT 1 FROM rework_impacts i WHERE i.node_run_id=n.node_run_id OR i.replacement_node_run_id=n.node_run_id)
        AND NOT EXISTS (SELECT 1 FROM rework_extra_steps s WHERE s.node_run_id=n.node_run_id)`,
      [binding.node_run_id, binding.attempt, binding.action_generation],
    )
    const approved = node && approvedArtifactRequirements(tx, node.run_id, node.node_id)
    if (!approved) return null
    return {
      texts: approved.rules.flatMap(rule => rule.textIndex === undefined ? []
        : [{ index: rule.textIndex, title: rule.textTitle ?? rule.file_name, fileName: rule.file_name }]),
      files: approved.rules.filter(rule => rule.textIndex === undefined).map(rule => rule.file_name),
    }
  })
}

function bindPublication(tx: Tx, binding: ReworkBinding, runId: string, nodeId: string,
  action: 'publish' | 'publish_text_result', body: unknown) {
  if (action === 'publish') {
    const data = publish.parse(body)
    const artifactId = 'out_' + sha256Hex(JSON.stringify([binding.node_run_id, data.file_name]))
    return { data, target: { artifactId, fileName: data.file_name } }
  }
  const { file_name: suppliedName, ...data } = publishText.parse(body)
  const plan = readApprovedTaskPlanForRun(tx, runId)
  const item = plan?.proposal.deliverables[data.deliverable_index]
  if (!plan || item?.acceptance.kind !== 'chat/text_result' || item.node_id !== nodeId) {
    throw new OrchError('FORBIDDEN', '当前步骤没有这项已批准的会话交付')
  }
  const target = textTarget(plan.plan_id, plan.content_hash, data.deliverable_index, binding)
  // An optional name confirms the approved slot. Its presence must not change the receipt on replay.
  if (suppliedName !== undefined && suppliedName !== item.title && suppliedName !== target.fileName) {
    throw new OrchError('CONFIRMATION_MISMATCH', '正文名称与该交付项编号不一致，请核对本步骤的交付清单')
  }
  return { data, target }
}

/** The host owns the session binding. No run, producer, evidence or filename comes from an agent-supplied path. */
export function callDshRework(db: Db, host: ReworkHost, binding: ReworkBinding, input: unknown, now = new Date().toISOString(), secret?: string) {
  const { action, ...body } = z.looseObject({ action: z.string() }).parse(input)
  const node = db.raw.prepare(`SELECT run_id FROM node_runs WHERE node_run_id=? AND attempt=? AND action_generation=?
    AND status IN ('started','verifying') AND replacement_node_run_id IS NULL`).get(binding.node_run_id, binding.attempt, binding.action_generation)
  if (!node) throw new OrchError('STALE_GENERATION', '该返工工具会话已过期')
  const runId = String(node.run_id)
  if (action === 'read_material') return withTx(db,tx => {
    assertReworkRunActive(tx,runId)
    const input=z.strictObject({ material_id:z.uuidv7(), digest:hash, offset:z.number().int().nonnegative().default(0) }).parse(body)
    const current=tx.get<{node_id:string;lease_expires_at:string|null}>(`SELECT node_id,lease_expires_at FROM node_runs
      WHERE node_run_id=? AND attempt=? AND action_generation=? AND status IN ('started','verifying')
        AND replacement_node_run_id IS NULL`,[binding.node_run_id,binding.attempt,binding.action_generation])
    if (!current?.lease_expires_at || Date.parse(current.lease_expires_at)<=Date.parse(now))
      throw new OrchError('STALE_GENERATION','材料读取租约已过期')
    const plan=readApprovedTaskPlanForRun(tx,runId)
    const material=plan?.brief.materials?.find(item=>item.id===input.material_id && item.digest===input.digest
      && item.nodes.includes(current.node_id))
    const owner=plan && tx.get<{created_by:string}>('SELECT created_by FROM task_plans WHERE plan_id=?',[plan.plan_id])
    if (!material || !owner) throw new OrchError('FORBIDDEN','本步骤没有该材料的授权')
    const text=readMaterial(tx,materialGrant(owner.created_by,material.draft),runId,current.node_id,material,Date.parse(now))
    if (input.offset>text.length) throw new OrchError('PAYLOAD_SCHEMA_INVALID','读取位置超过材料长度')
    const end=Math.min(text.length,input.offset+8192)
    return { name:material.name,digest:material.digest,text:text.slice(input.offset,end),next_offset:end<text.length?end:null }
  })
  if (action === 'inbox') return host.list(binding, runId)
  if (action === 'get') return host.get(z.strictObject({ request_id: key }).parse(body).request_id, binding)
  if (action === 'request') return host.request(reworkRequestSchema.parse(body), binding, now)
  if (action === 'accept' || action === 'request_changes' || action === 'escalate') {
    return host.review(reworkReviewSchema.parse({ ...body, action }), binding, now)
  }
  return withTx(db, (tx) => {
    assertReworkRunActive(tx, runId)
    if (action === 'publish' || action === 'publish_text_result') {
      const producer = tx.get<{ run_id: string; node_id: string; lease_id: string | null; lease_expires_at: string | null }>(
        `SELECT run_id,node_id,lease_id,lease_expires_at FROM node_runs WHERE node_run_id=? AND attempt=? AND action_generation=?
          AND status IN ('started','verifying') AND replacement_node_run_id IS NULL`,
        [binding.node_run_id, binding.attempt, binding.action_generation],
      )
      if (!producer || producer.run_id !== runId) throw new OrchError('STALE_GENERATION', '成果提交对应的执行尝试已失效')
      const { data, target } = bindPublication(tx, binding, runId, producer.node_id, action, body)
      const receipt = runIdempotentCommand(tx, { kind: 'rework.artifact', operationId: data.operation_id,
        requestHash: requestHashOf('rework.artifact', { binding, ...data }), now }, () => {
        const bytes = 'deliverable_index' in data ? Buffer.from(data.text) : nativeTextBytes(data.file_name, data.text)
        if (bytes.length > 65536) throw new OrchError('RANGE_TOO_LARGE', '每份文本成果最多 64 KiB')
        if ('deliverable_index' in data && (!producer.lease_id || !producer.lease_expires_at
          || !(Date.parse(producer.lease_expires_at) > Date.parse(now)))) {
          throw new OrchError('STALE_GENERATION', '正文提交租约已失效')
        }
        assertReworkPublication(tx, binding.node_run_id, target.fileName)
        materializeReworkPreserved(tx, {...binding,...producer}, now, (name, receipt) => {
          if (secret && producer.lease_id && producer.lease_expires_at && Date.parse(producer.lease_expires_at)>Date.parse(now)) {
            recordArtifactPublication(tx, secret, binding, producer, name, receipt)
          }
        })
        const count = tx.get<{ n: number }>(`SELECT COUNT(DISTINCT c.file_name) AS n
          FROM artifact_contents c JOIN artifacts a USING(artifact_id) WHERE c.node_run_id=?
          AND (CASE WHEN json_valid(a.evidence_index) THEN json_extract(a.evidence_index,'$.kind')=? ELSE 0 END IS 1)=?`,
          [binding.node_run_id,TEXT_PUBLICATION,'deliverable_index' in data ? 1 : 0])
        const firstPublication = !tx.get('SELECT 1 FROM artifacts WHERE artifact_id=?', [target.artifactId])
        if (firstPublication && (count?.n ?? 0) >= nativeTextLimits.files) throw new OrchError('RANGE_TOO_LARGE',
          'deliverable_index' in data ? '每次执行最多提交八段会话正文' : '每次执行最多提交八份文本文件')
        const artifact = registerRunArtifactInTx(tx, { ...target,
          runId, nodeRunId: binding.node_run_id, bytes }, now)
        if (secret && firstPublication && producer.lease_id && producer.lease_expires_at && Date.parse(producer.lease_expires_at) > Date.parse(now)) {
          recordArtifactPublication(tx, secret, binding, producer, target.fileName, artifact)
        }
        return artifact
      }).result
      return { ...receipt, publication_status: 'registered',
        ...('deliverable_index' in data ? { deliverable_index: data.deliverable_index } : { file_name: data.file_name }),
        next_action: '本项原件已保存，无需重发或回读。继续本步骤的剩余工作，完成后只交简短完成报告。若原件确需修订，在报告中说明具体问题，走正式返工。' }
    }
    if (action !== 'read') throw new OrchError('PAYLOAD_SCHEMA_INVALID', '未知成果操作')
    const data = read.parse(body)
    const row = tx.get<{ bytes: Uint8Array; file_name: string }>(`SELECT c.bytes,c.file_name FROM artifacts a JOIN artifact_contents c USING(artifact_id)
      WHERE a.run_id=? AND a.artifact_id=? AND a.sha256=? AND (a.retain_until IS NULL OR a.retain_until>?)
      AND (EXISTS (SELECT 1 FROM artifact_consumptions i WHERE i.consumer_node_run_id=? AND i.artifact_id=a.artifact_id AND i.artifact_hash=a.sha256)
        OR EXISTS (SELECT 1 FROM rework_requests r WHERE r.new_node_run_id=? AND r.source_artifact_id=a.artifact_id
          AND r.source_artifact_hash=a.sha256 AND r.status='scheduled'
          OR r.new_node_run_id=? AND r.status='scheduled' AND EXISTS (
            SELECT 1 FROM json_each(r.file_manifest_json,'$.originals') m
            WHERE json_extract(m.value,'$.artifact_id')=a.artifact_id AND json_extract(m.value,'$.sha256')=a.sha256
              AND json_extract(m.value,'$.action')<>'remove')))`,
    [runId, data.artifact_id, data.artifact_hash, now, binding.node_run_id, binding.node_run_id, binding.node_run_id])
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
