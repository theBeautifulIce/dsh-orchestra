import { z } from 'zod'
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import type { Tx } from '../infra/sqlite/driver.ts'
import type { ReadTx } from './queries/read-tx.ts'
import { isArtifactFileName, registerRunArtifactInTx } from './artifact-store.ts'
import { readApprovedTaskPlanForRun } from './task-planning.ts'
import { nativeTextFormat, nativeTextLimits } from './native-text-capability.ts'
import { textTarget, textResultFileName, TEXT_PUBLICATION } from './text-result.ts'

const file = z.strictObject({ artifact_id: z.string().min(1).max(256), sha256: z.string().regex(/^[a-f0-9]{64}$/u), file_name: z.string().refine(isArtifactFileName) })
export const reworkFileManifestSchema = z.strictObject({
  originals: z.array(file.extend({ action: z.enum(['revise', 'keep', 'remove']) })).min(1).max(100),
  attachments: z.array(z.string().refine(isArtifactFileName)).max(8).default([]),
})
export type ReworkFile = z.infer<typeof file>
export type ReworkFileManifest = z.infer<typeof reworkFileManifestSchema>
export function readFileManifest(raw: string | null | undefined): ReworkFileManifest | null {
  if (raw == null) return null
  try { return reworkFileManifestSchema.parse(JSON.parse(raw)) }
  catch { throw new OrchError('CONFIRMATION_MISMATCH', '返工文件清单无法核对') }
}
export function readReworkFiles(raw: string | null | undefined): ReworkFile[] {
  if (raw == null) return []
  try { return z.array(file).parse(JSON.parse(raw)) }
  catch { throw new OrchError('CONFIRMATION_MISMATCH', '返工成果清单无法核对') }
}

export function latestReworkFiles(tx: ReadTx, runId: string, nodeRunId: string): ReworkFile[] {
  return tx.all<ReworkFile>(`SELECT artifact_id,sha256,file_name FROM (
    SELECT a.artifact_id,a.sha256,c.file_name,
      row_number() OVER (PARTITION BY c.file_name ORDER BY a.created_at DESC,a.artifact_id DESC) AS version_rank
    FROM artifacts a JOIN artifact_contents c USING(artifact_id) WHERE a.run_id=? AND c.node_run_id=?
  ) WHERE version_rank=1 ORDER BY file_name`, [runId,nodeRunId])
}
function bytesFor(tx: ReadTx, runId: string, entry: ReworkFile, now: string) {
  const found = tx.get<{ bytes: Uint8Array; evidence_index: string | null; retain_until: string | null }>(
    `SELECT c.bytes,a.evidence_index,a.retain_until FROM artifacts a JOIN artifact_contents c USING(artifact_id)
     WHERE a.run_id=? AND a.artifact_id=? AND a.sha256=? AND c.file_name=?
       AND (a.retain_until IS NULL OR julianday(a.retain_until)>julianday(?))`,
    [runId,entry.artifact_id,entry.sha256,entry.file_name,now])
  if (!found || sha256Hex(Buffer.from(found.bytes))!==entry.sha256) throw new OrchError('CONFIRMATION_MISMATCH', '返工原件已过期或内容发生变化')
  return found
}

export function validateFileManifest(tx: ReadTx, runId: string, nodeRunId: string,
  sourceId: string, input: ReworkFileManifest, now: string): ReworkFileManifest {
  const manifest=reworkFileManifestSchema.parse(input)
  const current=latestReworkFiles(tx,runId,nodeRunId)
  const same=(a: ReworkFile,b: ReworkFile)=>a.artifact_id===b.artifact_id && a.sha256===b.sha256 && a.file_name===b.file_name
  if (new Set(manifest.originals.map(x=>x.file_name)).size!==manifest.originals.length
    || current.length!==manifest.originals.length || current.some(x=>!manifest.originals.some(y=>same(x,y)))) {
    throw new OrchError('CONFIRMATION_MISMATCH','清单须逐份覆盖当前原件版本，请刷新后核对')
  }
  if (!manifest.originals.some(x=>x.artifact_id===sourceId && x.action==='revise')) throw new OrchError('PAYLOAD_SCHEMA_INVALID','反馈指向的原件必须列为修改')
  const names=manifest.originals.filter(x=>x.action!=='remove').map(x=>x.file_name).concat(manifest.attachments)
  if (new Set(names).size!==names.length || manifest.attachments.some(name=>manifest.originals.some(x=>x.file_name===name))) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID','附件名称不能与原件或其他附件重复')
  }
  const plan=readApprovedTaskPlanForRun(tx,runId)
  const node=tx.get<{node_id:string}>('SELECT node_id FROM node_runs WHERE node_run_id=?',[nodeRunId])!
  const textNames=plan?.proposal.deliverables.flatMap((d,index)=>d.node_id===node.node_id && d.acceptance.kind==='chat/text_result' ? [textResultFileName(index)] : []) ?? []
  if (names.filter(name=>!textNames.includes(name)).length>nativeTextLimits.files
    || names.filter(name=>textNames.includes(name)).length>nativeTextLimits.files
    || [...manifest.originals.filter(x=>x.action==='revise').map(x=>x.file_name),...manifest.attachments].some(name=>!nativeTextFormat(name))) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID','返工交付超出当前文本生产能力')
  }
  const required=plan?.proposal.deliverables.flatMap((d,index)=>d.node_id!==node.node_id ? []
    : d.acceptance.kind==='artifact' ? [d.acceptance.file_name]
    : d.acceptance.kind==='chat/text_result' ? [textResultFileName(index)] : []) ?? []
  if (manifest.originals.some(x=>x.action==='remove' && required.includes(x.file_name))) {
    throw new OrchError('FORBIDDEN','已确认计划的必交件仍须交付，请选择修改或保留')
  }
  for (const original of manifest.originals) if (original.action!=='remove') bytesFor(tx,runId,original,now)
  return manifest
}

export function assertReworkPublication(tx: ReadTx, nodeRunId: string, fileName: string): void {
  const row=tx.get<{file_manifest_json:string|null}>(`SELECT a.file_manifest_json FROM rework_attempts a JOIN rework_requests r USING(request_id)
    WHERE a.new_node_run_id=? AND a.round_no=r.round_no AND r.status='scheduled'`,[nodeRunId])
  const manifest=readFileManifest(row?.file_manifest_json)
  if (manifest && !manifest.originals.some(x=>x.action==='revise' && x.file_name===fileName) && !manifest.attachments.includes(fileName)) {
    throw new OrchError('FORBIDDEN','这份文件未在本轮返工中批准提交')
  }
}

export function materializeReworkPreserved(tx: Tx,
  node: {node_run_id:string;run_id:string;node_id:string;attempt:number;action_generation:number}, now: string,
  onCopied?: (name:string, artifact:{artifact_id:string;sha256:string;size_bytes:number})=>void) {
  const row=tx.get<{request_id:string;round_no:number;file_manifest_json:string|null}>(`SELECT a.request_id,a.round_no,a.file_manifest_json
    FROM rework_attempts a JOIN rework_requests r USING(request_id) WHERE a.new_node_run_id=?
    AND a.round_no=r.round_no AND r.status='scheduled'`,[node.node_run_id])
  const manifest=readFileManifest(row?.file_manifest_json)
  if (!manifest || !row) return
  for (const entry of manifest.originals.filter(x=>x.action==='keep')) {
    const source=bytesFor(tx,node.run_id,entry,now)
    let target:{artifactId:string;fileName:string;evidenceIndex:unknown}={
      artifactId:'kept_'+sha256Hex(canonicalJson([row.request_id,row.round_no,node.node_run_id,entry.artifact_id,entry.sha256])),
      fileName:entry.file_name,evidenceIndex:{kind:'rework.preserved.v1',request_id:row.request_id,round_no:row.round_no,source_artifact_id:entry.artifact_id,source_sha256:entry.sha256},
    }
    type SourceIndex={kind?:string;item_index?:number}
    let index:SourceIndex|null=null
    try { index=source.evidence_index ? JSON.parse(source.evidence_index) as SourceIndex : null }
    catch {throw new OrchError('CONFIRMATION_MISMATCH','原件证据索引无法核对')}
    if (index?.kind===TEXT_PUBLICATION && Number.isInteger(index.item_index)) {
      const plan=readApprovedTaskPlanForRun(tx,node.run_id)
      if (!plan || plan.proposal.deliverables[index.item_index!]?.node_id!==node.node_id) throw new OrchError('CONFIRMATION_MISMATCH','原正文不属于本次计划')
      target=textTarget(plan.plan_id,plan.content_hash,index.item_index!,node)
    }
    const exists=tx.get('SELECT 1 FROM artifacts WHERE artifact_id=?',[target.artifactId])
    const receipt=registerRunArtifactInTx(tx,{...target,runId:node.run_id,nodeRunId:node.node_run_id,bytes:source.bytes,
      ...(source.retain_until?{retainUntil:source.retain_until}:{})},now)
    if (!exists) onCopied?.(entry.file_name,receipt)
  }
}

export function resolveReworkResults(tx: ReadTx, runId: string, nodeRunId: string, manifest: ReworkFileManifest | null, now: string): ReworkFile[] {
  const rows=latestReworkFiles(tx,runId,nodeRunId)
  if (!manifest) {
    if (rows.length!==1) throw new OrchError('CONFIRMATION_MISMATCH','旧返工授权只核对一份修订文件')
  } else {
    const names=manifest.originals.filter(x=>x.action!=='remove').map(x=>x.file_name).concat(manifest.attachments)
    if (rows.length!==names.length || names.some(name=>!rows.some(x=>x.file_name===name))) throw new OrchError('CONFIRMATION_MISMATCH','本轮成果未按批准清单交齐，或包含未批准文件')
    for (const original of manifest.originals.filter(x=>x.action==='keep')) {
      if (rows.find(x=>x.file_name===original.file_name)?.sha256!==original.sha256) throw new OrchError('CONFIRMATION_MISMATCH','应保留的原件内容发生变化')
    }
  }
  for (const row of rows) bytesFor(tx,runId,row,now)
  return rows
}
