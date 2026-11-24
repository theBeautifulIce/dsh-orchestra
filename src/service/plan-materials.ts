import type { Tx } from '../infra/sqlite/driver.ts'
import { sha256Hex } from '../core/canonical.ts'
import { uuidv7 } from '../core/ids.ts'
import { OrchError } from '../core/errors.ts'
type Grant = { actor: string; scope: string; draft: string }
type Pin = { id: string; digest: string }
type Material = { name: string; body: string }

// 调用者已获明确的按次同意。scope/actor 从服务认证上下文取；draft 是服务签发的草稿键。
export function saveMaterials(tx: Tx, g: Grant, items: Material[], now: number): Pin[] {
  if (!items.length || items.length > 8) throw new OrchError('PAYLOAD_SCHEMA_INVALID','每次可选 1–8 份文本')
  const pins = items.map(({ name, body }) => {
    if (!name || name.length > 120 || /[\/\\\x00-\x1f]/u.test(name) || !/\.(txt|md|csv)$/iu.test(name)
      || !body || body.includes('\0') || Buffer.byteLength(body, 'utf8') > 65536)
      throw new OrchError('PAYLOAD_SCHEMA_INVALID','仅支持 64 KiB 以内的 UTF-8 文本、Markdown 或 CSV')
    const digest = sha256Hex(body)
    tx.run(`INSERT INTO plan_materials(id,scope,actor,draft,name,digest,body,expires_ms)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(actor,scope,draft,name,digest) DO NOTHING`,
      [uuidv7(),g.scope,g.actor,g.draft,name,digest,body,now + 30*60_000])
    const pin = tx.get<Pin>(`SELECT id,digest FROM plan_materials WHERE scope=? AND actor=? AND draft=?
      AND name=? AND digest=? AND revoked=0 AND expires_ms>? AND run_id IS NULL`,
      [g.scope,g.actor,g.draft,name,digest,now])
    if (!pin) throw new OrchError('CONFIRMATION_MISMATCH','材料授权已失效，请重新选择并授权')
    return pin
  })
  const count = tx.get<{n:number}>(`SELECT count(*) n FROM plan_materials
    WHERE scope=? AND actor=? AND draft=? AND revoked=0 AND expires_ms>?`,
    [g.scope,g.actor,g.draft,now])?.n ?? 0
  if (count > 8) throw new OrchError('PAYLOAD_SCHEMA_INVALID','同一草稿最多授权 8 份有效材料')
  return pins
}

export function bindMaterials(tx: Tx, g: Grant, pins: Array<Pin & {nodes: string[]}>, runId: string, now: number) {
  for (const p of pins) {
    const prior = tx.get<{run_id:string|null}>(`SELECT run_id FROM plan_materials
      WHERE id=? AND digest=? AND actor=? AND scope=? AND draft=? AND revoked=0 AND expires_ms>?`,
      [p.id,p.digest,g.actor,g.scope,g.draft,now])
    if (prior?.run_id === runId) {
      const bound = tx.all<{node_id:string}>('SELECT node_id FROM plan_material_nodes WHERE material_id=? AND run_id=?',[p.id,runId])
      const nodes = new Set(p.nodes)
      if (!nodes.size || bound.length !== nodes.size || !bound.every(row => nodes.has(row.node_id)))
        throw new OrchError('CONFIRMATION_MISMATCH','已确认的可读步骤发生变化')
      continue
    }
    const result = tx.run(`UPDATE plan_materials SET run_id=? WHERE id=? AND digest=?
      AND actor=? AND scope=? AND draft=? AND revoked=0 AND expires_ms>? AND run_id IS NULL`,
      [runId,p.id,p.digest,g.actor,g.scope,g.draft,now])
    if (result.changes !== 1 || !p.nodes.length) throw new OrchError('CONFIRMATION_MISMATCH','材料或授权发生变化')
    // p.nodes 从已确认计划的固定步骤范围取得；调用方只在启动同一事务内调用。
    for (const nodeId of new Set(p.nodes)) tx.run(
      'INSERT OR IGNORE INTO plan_material_nodes(material_id,run_id,node_id) VALUES (?,?,?)',
      [p.id,runId,nodeId])
  }
}

export function readMaterial(tx: Tx, g: Grant, runId: string, nodeId: string, pin: Pin, now: number): string {
  const row = tx.get<{body: string}>(`SELECT body FROM plan_materials WHERE id=? AND digest=? AND actor=?
    AND scope=? AND draft=? AND run_id=? AND revoked=0 AND expires_ms>?
    AND EXISTS(SELECT 1 FROM plan_material_nodes n WHERE n.material_id=plan_materials.id
    AND n.run_id=plan_materials.run_id AND n.node_id=?)`,
    [pin.id,pin.digest,g.actor,g.scope,g.draft,runId,now,nodeId])
  if (!row) throw new OrchError('FORBIDDEN','本步骤没有有效的材料授权')
  return row.body
}

export function revokeMaterial(tx: Tx, g: Grant, id: string) {
  return tx.run(`UPDATE plan_materials SET revoked=1, body=''
    WHERE actor=? AND scope=? AND draft=? AND id=? AND revoked=0`,[g.actor,g.scope,g.draft,id]).changes
}
