// Real Node process fixture: the first boot intentionally leaves SQLite open until killed.
import { sha256Hex } from '../../src/core/canonical.ts'
import { appendEvent, chainBreakOf, readChain } from '../../src/infra/db/ledger.ts'
import { openDb, withTx } from '../../src/infra/sqlite/driver.ts'
import { createReworkHost } from '../../src/service/rework-coordinator.ts'
import { assertReworkExecutionAllowed } from '../../src/service/rework-runtime.ts'

const secret = 'rework-process-restart-secret'
const [file, configuration, mode] = process.argv.slice(2)
if (!file || !configuration || !mode) throw new Error('Missing restart fixture parameters')
const config = JSON.parse(configuration) as { requestOperation: string; approvalOperation: string }
const now = mode === 'first' ? '2026-11-19T01:00:00.000Z' : '2026-11-19T01:00:01.000Z'
const db = openDb(file)
const epoch = db.epoch + 1
withTx(db, tx => {
  tx.run("INSERT INTO service_meta(key,value,updated_at) VALUES('instance_epoch',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", [String(epoch), now])
  appendEvent(tx, { type: 'test.process_boot', runId: 'run', payload: { epoch, pid: process.pid } })
})
db.epoch = epoch
const host = createReworkHost(db, secret)
const actor = 'service:' + sha256Hex(secret).slice(0, 8)
const request = host.request({ operation_id: config.requestOperation, run_id: 'run', target_node_run_id: 'a1',
  source_artifact_id: 'v1', source_artifact_hash: sha256Hex('original data'), expected_revision: 1,
  reason: 'Missing timestamp', expected_result: 'Every sample includes timestamp', suggested_scope: 'rerun_node',
}, actor, now)
const approval = host.review({ operation_id: config.approvalOperation, request_id: request.request_id,
  expected_revision: 1, action: 'authorize', note: 'Owner approves a bounded pure revision',
}, actor, now)
host.recover(now)
const summary = withTx(db, tx => {
  const nodes = tx.all<{node_run_id: string;node_id: string;attempt: number;status: string;replacement_node_run_id: string | null}>(
    'SELECT node_run_id,node_id,attempt,status,replacement_node_run_id FROM node_runs ORDER BY seq,attempt')
  const blocked = ['b1','c1'].map(nodeId => {
    try { assertReworkExecutionAllowed(tx,nodeId);return false }
    catch { return true }
  })
  return { pid: process.pid, epoch, request, approval, nodes, blocked,
    receipt: tx.get<{receipt_json:string}>('SELECT receipt_json FROM inbox WHERE operation_id=?',[config.approvalOperation])!.receipt_json,
    impacts: tx.all('SELECT node_run_id,released_at FROM rework_impacts ORDER BY node_run_id'),
    consumptions: tx.all('SELECT consumer_node_run_id,upstream_node_run_id,artifact_id,artifact_hash FROM artifact_consumptions ORDER BY consumer_node_run_id'),
    attempts: tx.all('SELECT request_id,round_no,new_node_run_id FROM rework_attempts'),
    chainErrors: nodes.map(n=>chainBreakOf(secret,readChain(tx,n.node_run_id))),
    authorizedEvents: tx.get<{n:number}>("SELECT COUNT(*) AS n FROM events WHERE type='rework.authorize'")!.n,
    commandEvents: tx.get<{n:number}>("SELECT COUNT(*) AS n FROM events WHERE type='command.applied'")!.n,
  }
})
if (mode === 'first') {
  process.on('message', () => {})
  process.send?.(summary)
} else {
  db.raw.close()
  process.send?.(summary, undefined, undefined, () => process.disconnect())
}
