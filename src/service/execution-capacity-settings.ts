import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand, UUID_V7_RE } from './commands/idempotency.ts'
import type { ConfigurableExecutionScheduler } from './execution-scheduler.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'

const key = 'orchestra.execution_capacity.v1'
const kind = 'execution_capacity.save'
const limits = { concurrency: 32, max_waiting: 10_000, action_timeout_ms: 3_600_000 } as const
const valuesSchema = z.strictObject({
  concurrency: z.number().int().min(1),
  max_waiting: z.number().int().min(1).max(limits.max_waiting),
  action_timeout_ms: z.number().int().min(1000),
})
const revisionSchema = z.number().int().nonnegative()
const persisted = z.strictObject({ revision: revisionSchema, values: valuesSchema.nullable() })

export const executionCapacitySettingsSchema = z.strictObject({
  operation_id: z.string().regex(UUID_V7_RE),
  expected_revision: revisionSchema,
  values: valuesSchema.nullable(),
})
export type ExecutionCapacityValues = z.infer<typeof valuesSchema>

function read(tx: ReadTx): z.infer<typeof persisted> {
  const row = tx.get<{ value: string }>('SELECT value FROM service_meta WHERE key = ?', [key])
  return row ? persisted.parse(JSON.parse(row.value)) : { revision: 0, values: null }
}

export function createExecutionCapacitySettingsHost(db: Db, scheduler: ConfigurableExecutionScheduler, actionTimeoutMs: number) {
  const { concurrency, maxWaiting } = scheduler.stats()
  const defaults = { concurrency, max_waiting: maxWaiting, action_timeout_ms: actionTimeoutMs }
  // Legacy host defaults may exceed the panel's selectable range. Such values
  // continue following the host so editing another field cannot pin a stale limit.
  function effective(values: ExecutionCapacityValues | null) {
    return values ? { ...values,
      concurrency: values.concurrency > limits.concurrency ? defaults.concurrency : values.concurrency,
      action_timeout_ms: values.action_timeout_ms > limits.action_timeout_ms ? defaults.action_timeout_ms : values.action_timeout_ms,
    } : defaults
  }
  let currentActionTimeoutMs = actionTimeoutMs
  function apply(values: ExecutionCapacityValues) {
    // Increase may start queued work immediately. New nodes must see the same revision.
    currentActionTimeoutMs = values.action_timeout_ms
    scheduler.setCapacity({ concurrency: values.concurrency, maxWaiting: values.max_waiting })
  }
  const initial = withReadTx(db, ({ tx }) => read(tx))
  if (initial.values) apply(effective(initial.values))

  return {
    actionTimeoutMs: () => currentActionTimeoutMs,
    get() {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        const { revision, values } = read(tx)
        return { item: { revision, values: effective(values), defaults, limits, overridden: values !== null }, as_of_seq }
      })
    },
    save(request: z.input<typeof executionCapacitySettingsSchema>, actor: string, now: string) {
      const input = executionCapacitySettingsSchema.parse(request)
      const { replayed, result } = withTx(db, (tx) => runIdempotentCommand(tx, {
        kind, operationId: input.operation_id, requestHash: requestHashOf(kind, { actor, ...input }), now,
      }, () => {
        const { revision } = read(tx)
        if (revision !== input.expected_revision) throw new OrchError('STALE_GENERATION', '执行与排队设置已更新，请重新读取')
        if (input.values) for (const field of ['concurrency', 'action_timeout_ms'] as const) {
          if (input.values[field] > limits[field] && input.values[field] !== defaults[field]) {
            throw new OrchError('PAYLOAD_SCHEMA_INVALID', '超出面板设置范围，仅可保留当前宿主默认值', { field })
          }
        }
        const next = { revision: revision + 1, values: input.values }
        tx.run('INSERT INTO service_meta (key, value, updated_at) VALUES (?, ?, ?) '
          + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [key, JSON.stringify(next), now])
        appendEvent(tx, { type: 'execution_capacity.updated', payload: { revision: next.revision, actor, values: next.values } })
        return { revision: next.revision }
      }))
      // 队列可以同步开始任务，因此只在 SQLite 提交后应用新的容量。
      if (!replayed) apply(effective(input.values))
      return result
    },
  }
}

export type ExecutionCapacitySettingsHost = ReturnType<typeof createExecutionCapacitySettingsHost>
export type ExecutionCapacitySettingsView = ReturnType<ExecutionCapacitySettingsHost['get']>['item']
