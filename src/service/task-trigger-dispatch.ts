import { MANUAL_REWORK_ELIGIBLE, recordManualDispatchBlock } from './rework-dispatch-specs.ts'
import { OrchError } from '../core/errors.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { failQueuedNode, type NodeSpec } from './dispatcher.ts'
import { closeRun } from './commands/run-close.ts'
import { markTriggerDispatched, markTriggerResolveFailed } from './task-triggers.ts'

export type TriggerRunReady = {
  run_id: string
  task_id: string
  workflow_id: string
  workflow_version: string
}

/** Trusted host resolves the pinned run's per-node specs. A run may be observed again until it drains. */
export type ResolveTriggerNodeSpecs = (run: TriggerRunReady, signal: AbortSignal) =>
  Record<string, NodeSpec> | undefined | Promise<Record<string, NodeSpec> | undefined>

export type TriggerDispatchOptions = {
  /** 解析节点规格的时限；测试注入更短的时限，不必真的等 */
  resolveTimeoutMs?: number
  /** 就绪态落库用的时钟；测试可注入固定时钟 */
  now?: () => string
  /** 节点链签名密钥：写节点事件、收口运行都要用 */
  secret?: string
  resolveManual?: ResolveTriggerNodeSpecs
}

const PARALLEL_RUNS = 4
const RESOLVE_TIMEOUT_MS = 5000

/** 解析失败原因：超时与宿主错误码各有各的形状，就绪态里要能分辨 */
function resolveFailureReason(error: unknown): string {
  if (error instanceof OrchError) return error.code
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'resolver_timeout'
  return 'resolver_failed'
}

/** 运行期权限被撤：这类阻断必须变成用户看得见的状态，不能只留一行日志 */
const PERMISSION_DENIED_CODES = new Set(['TOOL_NOT_ALLOWED', 'TOOL_NOT_REGISTERED', 'RUN_TOOL_NOT_READ_ONLY'])

function isPermissionDenied(error: unknown): error is OrchError {
  return error instanceof OrchError && PERMISSION_DENIED_CODES.has(error.code)
}

export function createTriggerDispatchPump(
  db: Db,
  resolve: ResolveTriggerNodeSpecs | undefined,
  dispatch: (run: TriggerRunReady, specs: Record<string, NodeSpec>) => Promise<unknown>,
  onError: (error: unknown) => void,
  resolvePlan?: ResolveTriggerNodeSpecs,
  options?: TriggerDispatchOptions,
) {
  const active = new Map<string, Promise<void>>()
  const shutdown = new AbortController()
  const timeoutMs = options?.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS
  const clock = options?.now ?? (() => new Date().toISOString())
  const secret = options?.secret
  let cursor = ''

  /**
   * 权限阻断的可见化：还排队的节点收成 failed（并写节点事件），运行随之收成失败，
   * 任务因此进入待处理车道，而不是静悄悄地停在 queued。
   */
  function blockRunOnPermissionDenied(run: TriggerRunReady, error: OrchError) {
    if (!secret) return
    try {
      const queued = db.raw.prepare(
        "SELECT node_run_id, attempt FROM node_runs WHERE run_id = ? AND status = 'queued'",
      ).all(run.run_id) as Array<{ node_run_id: string; attempt: number }>
      for (const row of queued) {
        const settlement = failQueuedNode({ db, secret }, { runId: run.run_id, nodes: {}, now: clock() }, row, error.message, error.code)
        if (settlement.kind === 'storage_error') onError(settlement.error)
      }
      withTx(db, (tx) => { closeRun(tx, secret, run.run_id, clock()) })
    } catch (blockError) {
      onError(blockError)
    }
  }

  function ready(after: string): (TriggerRunReady & { source: 'trigger' | 'plan' | 'manual' })[] {
    return db.raw.prepare(`
      WITH candidates AS (
        SELECT r.run_id, 'trigger' AS source FROM task_trigger_occurrences o JOIN runs r ON r.root_run_id = o.run_id
        WHERE o.status = 'started' AND ?
        UNION ALL
        SELECT o.run_id, 'plan' AS source FROM task_plans p JOIN start_run_operations o ON o.operation_id = p.launch_operation_id
        WHERE ?
        UNION ALL
        SELECT r.run_id, 'manual' AS source FROM runs r
        WHERE ? AND EXISTS(SELECT 1 FROM rework_dispatch_specs s WHERE s.run_id=r.run_id)
          AND ${MANUAL_REWORK_ELIGIBLE}
      )
      SELECT r.run_id, r.task_id, r.workflow_id, CAST(r.workflow_version AS TEXT) AS workflow_version, c.source
      FROM candidates c JOIN runs r ON r.run_id = c.run_id
      WHERE r.status = 'running' AND r.run_id > ?
        AND r.cancel_requested_at IS NULL AND r.workflow_id IS NOT NULL AND r.workflow_version IS NOT NULL
        AND EXISTS (SELECT 1 FROM node_runs n WHERE n.run_id = r.run_id AND n.status = 'queued')
      ORDER BY r.run_id LIMIT 8
    `).all(resolve ? 1 : 0, resolvePlan ? 1 : 0, options?.resolveManual ? 1 : 0, after) as (TriggerRunReady & { source: 'trigger' | 'plan' | 'manual' })[]
  }

  async function resolveBounded(run: TriggerRunReady, resolveSpecs: ResolveTriggerNodeSpecs) {
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs)])
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
        const resolver = source === 'manual' ? options?.resolveManual : source === 'plan' ? resolvePlan : resolve
        if (!resolver) continue
        const markDispatched = () => { try { markTriggerDispatched(db, run.run_id, clock()) } catch (error) { onError(error) } }
        const markFailed = (reason: string, failure?: unknown) => { try {
          if(source==='manual') withTx(db,tx=>recordManualDispatchBlock(tx,run.run_id,reason,failure,clock()))
          else markTriggerResolveFailed(db, run.run_id, reason, clock())
        } catch (error) { onError(error) } }
        const work = resolveBounded(run, resolver).then(async (specs) => {
          if (shutdown.signal.aborted) return
          // Recheck before either dispatch or diagnostics: a pause/cancel is not a resolver failure.
          if (!db.raw.prepare("SELECT 1 FROM runs WHERE run_id = ? AND status = 'running' AND cancel_requested_at IS NULL").get(run.run_id)) return
          // 解析不出规格不是"没事发生"：原因要落到就绪态里，不能被静默吞掉
          if (!specs || Object.keys(specs).length === 0) { markFailed('resolver_returned_no_specs'); return }
          await dispatch(run, specs)
          markDispatched()
        }).catch((error: unknown) => {
          if (shutdown.signal.aborted) return
          markFailed(resolveFailureReason(error),error)
          onError(error)
          // 权限阻断要落成用户可见状态：节点收失败、运行收失败，任务进待处理车道
          if (source !== 'manual' && isPermissionDenied(error)) blockRunOnPermissionDenied(run, error)
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
