import type { Db } from '../infra/sqlite/driver.ts'
import type { NodeSpec } from './dispatcher.ts'

export type TriggerRunReady = {
  run_id: string
  task_id: string
  workflow_id: string
  workflow_version: string
}

/** Trusted host resolves the pinned run's per-node specs. A run may be observed again until it drains. */
export type ResolveTriggerNodeSpecs = (run: TriggerRunReady, signal: AbortSignal) =>
  Record<string, NodeSpec> | undefined | Promise<Record<string, NodeSpec> | undefined>

const PARALLEL_RUNS = 4
const RESOLVE_TIMEOUT_MS = 5000

export function createTriggerDispatchPump(
  db: Db,
  resolve: ResolveTriggerNodeSpecs | undefined,
  dispatch: (run: TriggerRunReady, specs: Record<string, NodeSpec>) => Promise<unknown>,
  onError: (error: unknown) => void,
  resolvePlan?: ResolveTriggerNodeSpecs,
) {
  const active = new Map<string, Promise<void>>()
  const shutdown = new AbortController()
  let cursor = ''

  function ready(after: string): (TriggerRunReady & { source: 'trigger' | 'plan' })[] {
    return db.raw.prepare(`
      WITH candidates AS (
        SELECT r.run_id, 'trigger' AS source FROM task_trigger_occurrences o JOIN runs r ON r.root_run_id = o.run_id
        WHERE o.status = 'started' AND ?
        UNION ALL
        SELECT o.run_id, 'plan' AS source FROM task_plans p JOIN start_run_operations o ON o.operation_id = p.launch_operation_id
        WHERE ?
      )
      SELECT r.run_id, r.task_id, r.workflow_id, CAST(r.workflow_version AS TEXT) AS workflow_version, c.source
      FROM candidates c JOIN runs r ON r.run_id = c.run_id
      WHERE r.status = 'running' AND r.run_id > ?
        AND r.cancel_requested_at IS NULL AND r.workflow_id IS NOT NULL AND r.workflow_version IS NOT NULL
        AND EXISTS (SELECT 1 FROM node_runs n WHERE n.run_id = r.run_id AND n.status = 'queued')
      ORDER BY r.run_id LIMIT 8
    `).all(resolve ? 1 : 0, resolvePlan ? 1 : 0, after) as (TriggerRunReady & { source: 'trigger' | 'plan' })[]
  }

  async function resolveBounded(run: TriggerRunReady, resolveSpecs: ResolveTriggerNodeSpecs) {
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(RESOLVE_TIMEOUT_MS)])
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        Promise.resolve().then(() => resolveSpecs(run, signal)),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason)
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  return {
    tick() {
      if (shutdown.signal.aborted || active.size >= PARALLEL_RUNS) return
      let candidates = ready(cursor)
      if (candidates.length === 0 && cursor) {
        cursor = ''
        candidates = ready(cursor)
      }
      for (const { source, ...run } of candidates) {
        if (active.size >= PARALLEL_RUNS) break
        cursor = run.run_id
        if (active.has(run.run_id)) continue
        const resolver = source === 'plan' ? resolvePlan : resolve
        if (!resolver) continue
        const work = resolveBounded(run, resolver).then(async (specs) => {
          if (shutdown.signal.aborted || !specs || Object.keys(specs).length === 0) return
          // Recheck after async host resolution because a separate command could have paused or cancelled the run.
          if (!db.raw.prepare("SELECT 1 FROM runs WHERE run_id = ? AND status = 'running' AND cancel_requested_at IS NULL").get(run.run_id)) return
          await dispatch(run, specs)
        }).catch((error: unknown) => {
          if (!shutdown.signal.aborted) onError(error)
        }).finally(() => { active.delete(run.run_id) })
        active.set(run.run_id, work)
      }
    },
    async close() {
      shutdown.abort()
      await Promise.allSettled(active.values())
    },
  }
}
