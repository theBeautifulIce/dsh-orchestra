import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand, UUID_V7_RE } from './commands/idempotency.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'

const KEY = 'orchestra.planning_timeouts.v1'
const KIND = 'planning_timeouts.save'
const seconds = (max: number) => z.number().int().min(1).max(max)
const valuesSchema = z.strictObject({
  task_seconds: seconds(600), workflow_seconds: seconds(600), idle_seconds: seconds(300),
  stage_seconds: seconds(600), request_seconds: seconds(900),
}).refine((budget) => budget.idle_seconds <= budget.stage_seconds && budget.stage_seconds <= budget.request_seconds
  && budget.task_seconds <= budget.request_seconds && budget.workflow_seconds <= budget.request_seconds,
  '无输出等待不能超过单阶段上限，所有阶段上限都不能超过整次请求上限')

export type PlanningTimeoutValues = z.infer<typeof valuesSchema>
export const planningTimeoutDefaults = Object.freeze({
  task_seconds: 30, workflow_seconds: 45, idle_seconds: 30, stage_seconds: 120, request_seconds: 180,
} satisfies PlanningTimeoutValues)
const limits = { task_seconds: 600, workflow_seconds: 600, idle_seconds: 300, stage_seconds: 600, request_seconds: 900 } as const
const persisted = z.strictObject({ revision: z.number().int().nonnegative(), values: valuesSchema.nullable() })
export const planningSettingsSchema = z.strictObject({
  operation_id: z.string().regex(UUID_V7_RE), expected_revision: z.number().int().nonnegative(), values: valuesSchema.nullable(),
})
type Branch = 'streaming' | 'fixed' | 'unavailable'
export type PlanningBranches = { task: Branch; automatic_workflow: Branch; standalone_workflow: Branch }
export type PlanningTimeoutSnapshot = { task: number; workflow: number; idle: number; stage: number; taskStage: number; request: number }

function read(tx: ReadTx) {
  const row = tx.get<{ value: string }>('SELECT value FROM service_meta WHERE key = ?', [KEY])
  if (!row) return { revision: 0, values: null }
  return persisted.parse(JSON.parse(row.value))
}

export function createPlanningSettingsHost(db: Db, branches: PlanningBranches, legacyTimeoutMs?: number) {
  const defaults = { ...planningTimeoutDefaults }
  const legacyTotal = Math.max(180_000, branches.task === 'streaming' || branches.automatic_workflow === 'streaming' ? 0 : 3 * (legacyTimeoutMs ?? 0))

  function snapshot(): PlanningTimeoutSnapshot {
    return withReadTx(db, ({ tx }) => {
      const { values } = read(tx)
      return {
        task: values ? values.task_seconds * 1000 : legacyTimeoutMs ?? defaults.task_seconds * 1000,
        workflow: (values ?? defaults).workflow_seconds * 1000,
        idle: (values ?? defaults).idle_seconds * 1000,
        stage: (values ?? defaults).stage_seconds * 1000,
        taskStage: values ? values.stage_seconds * 1000 : legacyTimeoutMs ?? defaults.stage_seconds * 1000,
        request: values ? values.request_seconds * 1000 : legacyTotal,
      }
    })
  }
  return {
    snapshot,
    get() {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        const { revision, values } = read(tx)
        return { item: { revision, values: values ?? defaults, defaults, limits, overridden: values !== null, branches,
          legacy_timeout_ms: legacyTimeoutMs ?? null }, as_of_seq }
      })
    },
    save(request: z.input<typeof planningSettingsSchema>, actor: string, now: string) {
      const input = planningSettingsSchema.parse(request)
      return withTx(db, (tx) => runIdempotentCommand(tx, {
        kind: KIND, operationId: input.operation_id, requestHash: requestHashOf(KIND, { actor, ...input }), now,
      }, () => {
        const { revision } = read(tx)
        if (revision !== input.expected_revision) throw new OrchError('STALE_GENERATION', '规划时限已更新，请重新读取')
        const next = { revision: revision + 1, values: input.values }
        tx.run('INSERT INTO service_meta (key, value, updated_at) VALUES (?, ?, ?) '
          + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [KEY, JSON.stringify(next), now])
        appendEvent(tx, { type: 'planning_timeouts.updated', payload: { revision: next.revision, actor, values: next.values } })
        return { revision: next.revision }
      }).result)
    },
  }
}

export type PlanningSettingsHost = ReturnType<typeof createPlanningSettingsHost>
export type PlanningSettingsView = ReturnType<PlanningSettingsHost['get']>['item']

/** Apply a captured request budget to any frontend, including a non-HTTP chat caller. */
export async function withPlanningBudget<T>(maximumMs: number, caller: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  caller?.throwIfAborted()
  const deadline = new AbortController()
  const signal = caller ? AbortSignal.any([caller, deadline.signal]) : deadline.signal
  const timeout = setTimeout(() => deadline.abort(new OrchError('OPERATION_TIMEOUT', '主脑未能在本次请求时限内完成规划',
    { boundary: 'request' })), maximumMs)
  timeout.unref()
  let onAbort = () => {}
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const result = await Promise.race([run(signal), stopped])
    signal.throwIfAborted()
    return result
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
  }
}
