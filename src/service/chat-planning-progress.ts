import type { Tx } from '../infra/sqlite/driver.ts'
import { OrchError } from '../core/errors.ts'
export type Phase = 'planning' | 'approval' | 'started' | 'failed' | 'declined' | 'cancelled' | 'blocked'
export type ProgressKey = { request: string; actor: string; scope: string; hash: string }

export function beginPlanningProgress(tx: Tx, k: ProgressKey, now: number) {
  tx.run(`INSERT INTO chat_planning_progress
    (request_key,actor,scope,input_hash,stage,updated_ms) VALUES (?,?,?,?,'planning',?)
    ON CONFLICT(request_key) DO NOTHING`, [k.request,k.actor,k.scope,k.hash,now])
  const own = tx.get('SELECT 1 FROM chat_planning_progress WHERE request_key=? AND actor=? AND scope=? AND input_hash=?',
    [k.request,k.actor,k.scope,k.hash])
  if (!own) throw new OrchError('CONFIRMATION_MISMATCH','这条消息已有不同的规划记录')
}

export function advancePlanning(tx: Tx, k: ProgressKey, stage: Phase, runId: string | null, now: number) {
  if ((stage === 'started') !== (runId !== null)) throw new Error('启动状态需要实际运行回执')
  return tx.run(`UPDATE chat_planning_progress SET stage=?,run_id=?,updated_ms=?
    WHERE request_key=? AND actor=? AND scope=? AND input_hash=? AND stage<>'started'
    AND ((?<>'started' AND stage IN ('planning','approval') AND (?<>'planning' OR stage='planning'))
      OR (?='started' AND EXISTS (
        SELECT 1 FROM chat_task_receipts c JOIN task_plans p USING(plan_id)
        JOIN start_run_operations o ON o.operation_id=p.launch_operation_id
        WHERE c.request_key=chat_planning_progress.request_key AND c.input_hash=chat_planning_progress.input_hash
          AND p.created_by=chat_planning_progress.actor AND o.run_id=?)))`,
    [stage,runId,now,k.request,k.actor,k.scope,k.hash,stage,stage,stage,runId]).changes
}

export function listPlanning(tx: Tx, actor: string, scope: string, since: number) {
  return tx.all(`SELECT stage,run_id,updated_ms FROM chat_planning_progress
    WHERE actor=? AND scope=? AND updated_ms>=? ORDER BY updated_ms DESC,request_key DESC LIMIT 20`,
    [actor,scope,since])
}

export type PlanningProgress = { request_key: string; stage: Phase; run_id: string | null;
  plan_id: string | null; title: string; updated_ms: number }
export function readPlanningProgress(tx: Pick<Tx, 'all'>, actor: string, since: number): PlanningProgress[] {
  return tx.all<PlanningProgress>(`SELECT c.request_key,CASE WHEN o.run_id IS NOT NULL THEN 'started' ELSE c.stage END AS stage,
      COALESCE(o.run_id,c.run_id) AS run_id,c.plan_id,c.title,c.updated_ms
    FROM chat_planning_progress c LEFT JOIN task_plans p ON p.plan_id=c.plan_id
    LEFT JOIN start_run_operations o ON o.operation_id=p.launch_operation_id
    WHERE c.actor=? AND c.updated_ms>=?
    ORDER BY CASE WHEN o.run_id IS NULL AND c.stage IN ('planning','approval','blocked') THEN 0 ELSE 1 END,
      c.updated_ms DESC,c.request_key DESC LIMIT 20`, [actor,since])
}
export function bindPlanningProgress(tx: Tx, request: string, planId: string, title: string, now: number) {
  tx.run(`UPDATE chat_planning_progress SET plan_id=?,title=?,stage='approval',updated_ms=?
    WHERE request_key=? AND stage='planning'`, [planId,title.slice(0,200),now,request])
}
