import { OrchError } from '../core/errors.ts'
import type { Db } from '../infra/sqlite/driver.ts'
import type { SemanticWorkflow } from './semantic-admission.ts'

/** A referenced version is resolved directly against the published directory. */
export function resolveSemanticWorkflow(db: Db, pin: SemanticWorkflow | undefined): { workflow_id: string; workflow_version: string } | undefined {
  if (!pin) return undefined
  const rows = db.raw.prepare(`SELECT workflow_id,current_version FROM workflows
    WHERE status='active' AND scope='reusable' AND (name=? OR workflow_id=?) LIMIT 2`).all(pin.name, pin.name) as Array<{
    workflow_id: string; current_version: number | null }>
  if (rows.length === 0) throw new OrchError('WORKFLOW_NOT_PUBLISHED', '未找到指定的已发布流程，请核对流程名称')
  if (rows.length > 1) throw new OrchError('RESOLUTION_NOT_AVAILABLE', '有多个同名流程，请在插件面板选择具体流程')
  const row = rows[0]!
  const version = pin.version ?? (row.current_version === null ? undefined : String(row.current_version))
  const published = version && db.raw.prepare(`SELECT version FROM workflow_versions
    WHERE workflow_id=? AND version=? AND published_by IS NOT NULL`).get(row.workflow_id, version)
  if (!published || !version) throw new OrchError('WORKFLOW_NOT_PUBLISHED', '指定的流程版本尚未发布，请核对版本')
  return { workflow_id: row.workflow_id, workflow_version: version }
}
