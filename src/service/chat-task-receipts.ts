import { OrchError } from '../core/errors.ts'
import { withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'

export type ChatTaskOrigin = {
  messageKey: string
  requestKey: string
  inputHash: string
  signal: AbortSignal
  assertCurrent(): void
}

export function bindChatPlan(tx: Tx, origin: ChatTaskOrigin | undefined, planId: string): void {
  if (!origin) return
  origin.assertCurrent()
  tx.run('INSERT INTO chat_task_receipts (message_key, request_key, input_hash, plan_id) VALUES (?, ?, ?, ?)',
    [origin.messageKey, origin.requestKey, origin.inputHash, planId])
}

export function findChatPlan(db: Db, origin: ChatTaskOrigin): string | undefined {
  const receipts = db.raw.prepare('SELECT plan_id, input_hash FROM chat_task_receipts WHERE message_key = ? OR request_key = ?')
    .all(origin.messageKey, origin.requestKey)
  const receipt = receipts[0]
  if (!receipt) return
  if (receipts.length > 1 || receipt.input_hash !== origin.inputHash) {
    throw new OrchError('OPERATION_ID_CONFLICT', '这条会话消息已绑定了不同的任务内容')
  }
  return String(receipt.plan_id)
}

export function chatRun(db: Db, actor: string, runId?: string): string | undefined {
  return db.raw.prepare(
    'SELECT o.run_id FROM chat_task_receipts c JOIN task_plans p USING (plan_id)'
    + ' JOIN start_run_operations o ON p.launch_operation_id = o.operation_id'
    + ' WHERE p.created_by = ?' + (runId ? ' AND o.run_id = ?' : ' ORDER BY o.rowid DESC') + ' LIMIT 1',
  ).get(...(runId ? [actor, runId] : [actor]))?.run_id as string | undefined
}

export function chatRunByTitle(db: Db, actor: string, title: string): string | undefined {
  const rows = db.raw.prepare(
    'SELECT DISTINCT o.run_id FROM chat_task_receipts c JOIN task_plans p USING (plan_id)'
    + ' JOIN start_run_operations o ON p.launch_operation_id = o.operation_id'
    + ' JOIN tasks t ON t.task_id = o.task_id WHERE p.created_by = ? AND t.title = ? LIMIT 2',
  ).all(actor, title)
  if (rows.length > 1) throw new OrchError('RESOLUTION_NOT_AVAILABLE', '请在面板选择具体的同名任务')
  return rows[0]?.run_id as string | undefined
}

/** Older transcripts may have been compacted. Only use an acknowledged terminal receipt. */
export function latestDeliveredChatRun(db: Db, actor: string, identity: string): string | undefined {
  const eligible = 'SELECT DISTINCT o.run_id FROM chat_task_receipts c JOIN task_plans p USING (plan_id)'
    + " JOIN start_run_operations o ON p.launch_operation_id=o.operation_id WHERE p.created_by=? AND c.reported_key LIKE 'delivered:terminal:%'"
    + " AND EXISTS(SELECT 1 FROM run_acceptance_results r WHERE r.run_id=o.run_id AND r.outcome='passed' AND r.kind IN ('artifact','chat/text_result'))"
  const last = db.raw.prepare("SELECT json_extract(value,'$.runId') AS run_id FROM service_meta WHERE key=? AND json_valid(value)")
    .get('chat_last_original/' + identity)?.run_id
  if (typeof last === 'string') return db.raw.prepare(eligible + ' AND o.run_id=?').get(actor, last)?.run_id as string | undefined
  // Historical receipts have no delivery sequence. Ambiguity needs a title instead of guessing by start time.
  const rows = db.raw.prepare(eligible + ' LIMIT 2').all(actor)
  if (rows.length === 1) return String(rows[0]!.run_id)
}

export type ChatRunReceipt = { run_id: string; reported_key: string | null; cursor: number }

export function pendingChatReports(db: Db, actor: string, after: number, limit: number): ChatRunReceipt[] {
  return db.raw.prepare(
    'SELECT o.run_id, c.reported_key, o.rowid AS cursor FROM chat_task_receipts c JOIN task_plans p USING (plan_id)'
    + ' JOIN start_run_operations o ON p.launch_operation_id = o.operation_id'
    + " WHERE p.created_by = ? AND o.rowid > ? AND COALESCE(c.reported_key, '') NOT LIKE 'delivered:terminal:%'"
    + ' ORDER BY o.rowid LIMIT ?',
  ).all(actor, after, limit) as ChatRunReceipt[]
}

export function reportChatRun(db: Db, runId: string, reportKey: string, delivered?: { identity: string; seq: number }): void {
  withTx(db, (tx) => {
    tx.run('UPDATE chat_task_receipts SET reported_key = ? WHERE plan_id IN ('
      + 'SELECT p.plan_id FROM task_plans p JOIN start_run_operations o ON p.launch_operation_id = o.operation_id WHERE o.run_id = ?)',
    [reportKey, runId])
    if (delivered && reportKey.startsWith('delivered:terminal:') && Number.isSafeInteger(delivered.seq) && delivered.seq >= 0) {
      tx.run(`INSERT INTO service_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,updated_at=excluded.updated_at WHERE
        CASE WHEN json_valid(service_meta.value) THEN coalesce(json_extract(service_meta.value,'$.seq'),-1) ELSE -1 END < ?`,
      ['chat_last_original/' + delivered.identity, JSON.stringify({ runId, seq: delivered.seq }), new Date().toISOString(), delivered.seq])
    }
  })
}
