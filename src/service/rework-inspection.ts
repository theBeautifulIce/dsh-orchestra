import { z } from 'zod'
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { uuidv7 } from '../core/ids.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand } from './commands/idempotency.ts'
import { requireReviewOperator } from './delivery-review.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'
import type { ReworkHost, ReworkRequest } from './rework-coordinator.ts'
import { callBoundedPlanner, type ReworkPlanner } from './rework-planning.ts'

const key = z.string().min(1).max(128)
export const reworkInspectionInput = z.strictObject({
  operation_id: z.uuidv7(), run_id: key, target_node_run_id: key,
  source_artifact_id: key, source_artifact_hash: z.string().regex(/^[a-f0-9]{64}$/),
  expected_revision: z.number().int().nonnegative(), criteria: z.string().trim().min(1).max(2500),
})
const reason = z.string().trim().min(1).max(2500)
const inspectionOutput = z.discriminatedUnion('verdict', [
  z.strictObject({ verdict: z.literal('pass'), reason }),
  z.strictObject({ verdict: z.literal('changes'), reason, expected_result: reason,
    preserve_requirements: z.array(z.string().trim().min(1).max(1000)).max(20),
    suggested_scope: z.enum(['targeted_revision', 'rerun_node', 'replan_subgraph']).default('targeted_revision'),
  }),
])
export type InspectionInput = z.infer<typeof reworkInspectionInput>
export type ReworkInspection = {
  inspection_id: string; run_id: string; node_run_id: string; artifact_id: string; artifact_hash: string
  reviewer_actor: string; criteria: string; verdict: 'pass' | 'request_changes'; summary: string
  request_id: string | null; snapshot_hash: string; created_at: string
}
export type InspectionResult = ReworkInspection & { request: ReworkRequest | null }

function snapshot(tx: ReadTx, secret: string, body: InspectionInput, actor: string, now: string) {
  const owner = requireReviewOperator(tx, secret, actor, body.run_id)
  const run = tx.get<{run_id: string; revision: number; workflow_definition_hash: string | null; workflow_id: string | null; workflow_version: string | null}>(
    `SELECT r.run_id,r.revision,r.workflow_definition_hash,r.workflow_id,r.workflow_version FROM runs r JOIN tasks t ON t.task_id=r.task_id
      WHERE r.run_id=? AND r.status='running' AND r.cancel_requested_at IS NULL
      AND (t.current_run_id IS NULL OR t.current_run_id=?)`, [body.run_id,owner.rootRunId])
  if (!tx.get("SELECT 1 FROM runs WHERE run_id=? AND status='running' AND cancel_requested_at IS NULL",[owner.rootRunId])) throw new OrchError('STALE_GENERATION','当前根运行已暂停、终止或正在取消')
  const node = tx.get<{node_run_id: string;node_id: string;attempt: number;revision: number}>(
    `SELECT node_run_id,node_id,attempt,revision FROM node_runs WHERE node_run_id=? AND run_id=?
      AND node_type='agent' AND status='done' AND replacement_node_run_id IS NULL AND revision=?`,
    [body.target_node_run_id,body.run_id,body.expected_revision])
  if (!run || !node) throw new OrchError('STALE_GENERATION', '只能检查活动运行中当前已完成的 Agent 成果')
  const artifact = tx.get<{bytes: Uint8Array;file_name: string;sha256: string}>(
    `SELECT c.bytes,c.file_name,a.sha256 FROM artifacts a JOIN artifact_contents c USING(artifact_id)
      WHERE a.artifact_id=? AND a.run_id=? AND c.node_run_id=? AND a.sha256=? AND (a.retain_until IS NULL OR a.retain_until>?)`,
    [body.source_artifact_id,body.run_id,node.node_run_id,body.source_artifact_hash,now])
  if (!artifact || sha256Hex(Buffer.from(artifact.bytes)) !== body.source_artifact_hash) throw new OrchError('CONFIRMATION_MISMATCH', '检查成果的主体、版本或实际内容哈希不符')
  if (artifact.bytes.byteLength > 65_536) throw new OrchError('RANGE_TOO_LARGE', '主脑检查只接收不超过 64 KiB 的完整 UTF-8 文本成果')
  let text: string
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(artifact.bytes) }
  catch { throw new OrchError('PAYLOAD_SCHEMA_INVALID', '主脑检查需要有效的 UTF-8 文本成果') }
  if (text.includes('\0')) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '主脑检查不接受二进制成果')
  const nodes = tx.all<{node_run_id: string;revision: number;status: string}>(
    'SELECT node_run_id,revision,status FROM node_runs WHERE run_id=? AND replacement_node_run_id IS NULL ORDER BY node_run_id', [body.run_id])
  return { purpose: 'inspect', run, node, nodes, artifact_id: body.source_artifact_id, artifact_hash: body.source_artifact_hash,
    file_name: artifact.file_name, criteria: body.criteria, text }
}

export function createReworkInspectionHost(db: Db, secret: string, rework: ReworkHost, planner?: ReworkPlanner) {
  const inFlight = new Set<string>()
  return {
    enabled: Boolean(planner),
    list(runId: string, actor: string) {
      return withReadTx(db, ({tx,as_of_seq}) => {
        requireReviewOperator(tx,secret,actor,runId)
        return {items:tx.all<ReworkInspection>('SELECT * FROM rework_inspections WHERE run_id=? ORDER BY created_at DESC,inspection_id DESC LIMIT 100',[runId]),as_of_seq}
      })
    },
    async inspect(input: InspectionInput, actor: string, now: string): Promise<InspectionResult> {
      const body = reworkInspectionInput.parse(input)
      const receipt = {kind:'rework.inspection',operationId:body.operation_id,requestHash:requestHashOf('rework.inspection',{body,actor}),now}
      if (db.raw.prepare('SELECT 1 FROM inbox WHERE operation_id=?').get(body.operation_id)) {
        return withTx(db,tx=>runIdempotentCommand(tx,receipt,(): InspectionResult=>{throw new OrchError('STALE_GENERATION','主脑检查回执状态已变化')}).result)
      }
      if (!planner) throw new OrchError('SERVICE_UNAVAILABLE','该宿主未配置主脑成果检查，可继续人工审核')
      const state = withReadTx(db,({tx})=>snapshot(tx,secret,body,actor,now))
      const target = body.run_id+'/'+body.target_node_run_id+'/'+body.source_artifact_hash
      if (inFlight.has(target)||inFlight.size>=2) throw new OrchError('COMMAND_BUSY','主脑正在检查成果，请稍后查看结果')
      inFlight.add(target)
      try {
        const parsed = inspectionOutput.safeParse(await callBoundedPlanner(planner,state))
        if (!parsed.success) throw new OrchError('PAYLOAD_SCHEMA_INVALID','主脑检查意见不符合检查契约')
        const opinion = parsed.data
        return withTx(db,tx=>runIdempotentCommand(tx,receipt,()=>{
          const completedAt = new Date().toISOString()
          const current = snapshot(tx,secret,body,actor,completedAt)
          if (canonicalJson(state)!==canonicalJson(current)) throw new OrchError('STALE_GENERATION','主脑检查期间成果或执行快照发生变化，请重新检查')
          const request = opinion.verdict==='changes' ? rework.requestFromPlannerInTx(tx,{
            operation_id:body.operation_id,run_id:body.run_id,target_node_run_id:body.target_node_run_id,
            source_artifact_id:body.source_artifact_id,source_artifact_hash:body.source_artifact_hash,expected_revision:body.expected_revision,
            reason:opinion.reason,expected_result:opinion.expected_result,preserve_requirements:opinion.preserve_requirements,
            suggested_scope:opinion.suggested_scope,evidence_ids:[],
          },actor,completedAt) : null
          const result: InspectionResult = {inspection_id:'inspection_'+uuidv7(),run_id:body.run_id,node_run_id:body.target_node_run_id,
            artifact_id:body.source_artifact_id,artifact_hash:body.source_artifact_hash,reviewer_actor:'planner:'+actor,
            criteria:body.criteria,verdict:opinion.verdict==='pass'?'pass':'request_changes',summary:opinion.reason,
            request_id:request?.request_id??null,snapshot_hash:sha256Hex(canonicalJson(state)),created_at:completedAt,request}
          tx.run('INSERT INTO rework_inspections VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[
            result.inspection_id,result.run_id,result.node_run_id,result.artifact_id,result.artifact_hash,result.reviewer_actor,
            result.criteria,result.verdict,result.summary,result.request_id,result.snapshot_hash,result.created_at,
          ])
          appendEvent(tx,{type:'rework.inspected',runId:body.run_id,nodeRunId:body.target_node_run_id,payload:{inspection_id:result.inspection_id,
            verdict:result.verdict,request_id:result.request_id,artifact_id:result.artifact_id,artifact_hash:result.artifact_hash,actor:result.reviewer_actor}})
          return result
        }).result)
      } finally {inFlight.delete(target)}
    },
  }
}
