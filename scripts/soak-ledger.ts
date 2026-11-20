import type { Db } from '../src/infra/sqlite/driver.ts'
import { withReadTx } from '../src/service/queries/read-tx.ts'
import type { LedgerHealth } from './soak-judge.ts'

export function ledgerHealth(db: Db): LedgerHealth {
  return withReadTx(db, ({ tx, as_of_seq }) => {
    const count = (query: string, params: unknown[] = []) => tx.get<{ n: number }>(query, params)!.n
    return {
      head: as_of_seq, epoch: Number(tx.get<{ value: string }>("SELECT value FROM service_meta WHERE key='instance_epoch'")?.value),
      tasks: count('SELECT COUNT(*) AS n FROM tasks'),
      runs: count('SELECT COUNT(*) AS n FROM runs'),
      nodes: count('SELECT COUNT(*) AS n FROM node_runs'),
      successes: count("SELECT COUNT(*) AS n FROM runs WHERE status='succeeded'"),
      orphanRuns: count("SELECT COUNT(*) AS n FROM runs r LEFT JOIN tasks t ON t.task_id=r.task_id"
        + " LEFT JOIN runs parent ON parent.run_id=r.parent_run_id LEFT JOIN node_runs pn ON pn.node_run_id=r.parent_node_run_id"
        + " WHERE t.task_id IS NULL OR (r.parent_run_id IS NOT NULL AND (parent.run_id IS NULL OR pn.run_id IS NOT r.parent_run_id))"
        + " OR r.status='orphaned' OR NOT EXISTS (SELECT 1 FROM node_runs n WHERE n.run_id=r.run_id)"),
      orphanNodes: count("SELECT COUNT(*) AS n FROM node_runs n LEFT JOIN runs r ON r.run_id=n.run_id"
        + " WHERE r.run_id IS NULL OR (n.status='orphaned' AND n.replacement_node_run_id IS NULL)"),
      unclosed: count("SELECT (SELECT COUNT(*) FROM runs r WHERE r.status='succeeded' AND NOT EXISTS"
        + " (SELECT 1 FROM events e WHERE e.run_id=r.run_id AND e.type='run.terminal'))"
        + " + (SELECT COUNT(*) FROM node_runs n WHERE n.status='done' AND NOT EXISTS"
        + " (SELECT 1 FROM node_run_events e WHERE e.node_run_id=n.node_run_id AND e.type='report_applied'))"
        + " + (SELECT COUNT(*) FROM events e LEFT JOIN runs r ON e.run_id=r.run_id WHERE e.run_id IS NOT NULL AND r.run_id IS NULL)"
        + " + (SELECT COUNT(*) FROM events e LEFT JOIN node_runs n ON e.node_run_id=n.node_run_id"
        + " WHERE e.node_run_id IS NOT NULL AND (n.node_run_id IS NULL OR (e.run_id IS NOT NULL AND e.run_id<>n.run_id)))"
        + " + (SELECT COUNT(*) FROM tasks t LEFT JOIN runs r ON t.current_run_id=r.run_id"
        + " WHERE t.current_run_id IS NOT NULL AND (r.run_id IS NULL OR r.task_id<>t.task_id)) AS n"),
      inFlight: count("SELECT (SELECT COUNT(*) FROM runs WHERE status NOT IN"
        + " ('succeeded','failed','succeeded_with_unverified','failed_with_unverified','orphaned','cancelled'))"
        + " + (SELECT COUNT(*) FROM node_runs WHERE status NOT IN"
        + " ('done','failed','timeout','abandoned_unverified','failed_with_unverified','orphaned','superseded')) AS n"),
      foreignKeys: count('SELECT COUNT(*) AS n FROM pragma_foreign_key_check'),
      probes: count("SELECT COUNT(*) AS n FROM events WHERE type='s6.soak_probe'"),
      toolExecutions: count('SELECT COUNT(*) AS n FROM tool_executions'),
    }
  })
}
