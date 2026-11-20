import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import { isReleaseWorkflow } from '../core/wf-release-v1.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand, UUID_V7_RE } from './commands/idempotency.ts'
import type { ExecutionScheduler, ExecutionWorkflowScope } from './execution-scheduler.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'

const prefix = 'orchestra.workflow-concurrency.v1:'
const kind = 'workflow_concurrency.save'
const limit = z.number().int().min(1).max(32).nullable()
const valuesSchema = z.strictObject({ run_limit: limit.optional(), node_limit: limit.optional(),
  helper_limit: z.number().int().min(0).max(8).optional() })
const recordSchema = z.strictObject({ revision: z.number().int().nonnegative(), values: valuesSchema })
const targetId = z.string().min(1).max(256)
const targetSchema = z.strictObject({ workflow_id: targetId.optional(), node_id: targetId.optional() })
export const workflowConcurrencySchema = targetSchema.extend({ operation_id: z.string().regex(UUID_V7_RE),
  expected_revision: z.number().int().nonnegative(), values: valuesSchema.nullable() })
type Target = z.infer<typeof targetSchema>
type Overrides = z.infer<typeof valuesSchema>
const defaults = { run_limit: null as number | null, node_limit: null as number | null, helper_limit: 0 }
const keyFor = (workflow?: string, node?: string) => prefix + JSON.stringify([workflow ?? null, node ?? null])

function checkTarget(tx: ReadTx, target: Target) {
  const { workflow_id: workflow, node_id: node } = target
  if (!workflow && !node) return
  if (!workflow || isReleaseWorkflow(workflow)) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '请选择已发布的普通工作流')
  const version = tx.get<{definition_json: string}>('SELECT v.definition_json FROM workflows w JOIN workflow_versions v '
    + 'ON v.workflow_id=w.workflow_id AND v.version=w.current_version WHERE w.workflow_id=?', [workflow])
  if (!version) throw new OrchError('WORKFLOW_NOT_FOUND', '找不到该流程的已发布版本')
  if (node && !(JSON.parse(version.definition_json) as {nodes: {node_id: string; type: string}[]}).nodes
    .some((n) => n.node_id === node && n.type === 'agent')) throw new OrchError('NOT_FOUND', '请选择当前发布版本的智能体步骤')
}

export function createWorkflowConcurrencyHost(db: Db, scheduler: ExecutionScheduler, helperAvailable: boolean) {
  const settings = new Map<string, z.infer<typeof recordSchema>>()
  const existing = withReadTx(db, ({ tx }) => tx.all<{key: string; value: string}>(
    'SELECT key,value FROM service_meta WHERE key GLOB ?', [prefix + '*']))
  for (const row of existing) settings.set(row.key, recordSchema.parse(JSON.parse(row.value)))
  function resolve(workflow?: string, node?: string) {
    const session = { ...defaults, ...settings.get(keyFor())?.values }
    const flow = workflow ? { ...session, ...settings.get(keyFor(workflow))?.values } : session
    return workflow && node ? { ...flow, ...settings.get(keyFor(workflow, node))?.values } : flow
  }
  function gate(scope: ExecutionWorkflowScope) {
    const limits = resolve(scope.workflowId, scope.nodeId)
    return { runLimit: limits.run_limit, nodeLimit: limits.node_limit }
  }
  scheduler.configureWorkflowLimits?.(gate)
  return {
    helperLimit: (scope: ExecutionWorkflowScope) => helperAvailable ? resolve(scope.workflowId, scope.nodeId).helper_limit : 0,
    get(target: Target) {
      return withReadTx(db, ({tx, as_of_seq}) => {
        checkTarget(tx, target)
        const saved = settings.get(keyFor(target.workflow_id, target.node_id))
        return { as_of_seq, item: { revision: saved?.revision ?? 0, overrides: saved?.values ?? {},
          inherited: target.node_id ? resolve(target.workflow_id) : target.workflow_id ? resolve() : defaults,
          values: resolve(target.workflow_id, target.node_id), helper_available: helperAvailable } }
      })
    },
    save(input: z.infer<typeof workflowConcurrencySchema>, actor: string, now: string) {
      const cmd = workflowConcurrencySchema.parse(input)
      const values: Overrides = cmd.values ?? {}
      if (cmd.node_id && values.run_limit !== undefined) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '整次运行的名额请在流程设置中调整')
      if (!helperAvailable && values.helper_limit) throw new OrchError('FORBIDDEN', '当前宿主未提供节点助手')
      const key = keyFor(cmd.workflow_id, cmd.node_id)
      const { result, replayed } = withTx(db, (tx) => runIdempotentCommand(tx, { kind, operationId: cmd.operation_id,
        requestHash: requestHashOf(kind, { actor, ...cmd }), now }, () => {
        checkTarget(tx, cmd)
        const row = tx.get<{value:string}>('SELECT value FROM service_meta WHERE key=?', [key])
        const revision = row ? recordSchema.parse(JSON.parse(row.value)).revision : 0
        if (revision !== cmd.expected_revision) throw new OrchError('STALE_GENERATION', '此范围的设置已更新，请重新读取')
        const next = { revision: revision + 1, values }
        tx.run('INSERT INTO service_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE '
          + 'SET value=excluded.value,updated_at=excluded.updated_at', [key, JSON.stringify(next), now])
        appendEvent(tx, { type: 'workflow_concurrency.updated', payload: { actor, workflow_id: cmd.workflow_id ?? null,
          node_id: cmd.node_id ?? null, ...next } })
        return { revision: next.revision }
      }))
      if (!replayed) {
        settings.set(key, { revision: result.revision, values })
        scheduler.configureWorkflowLimits?.(gate)
      }
      return result
    },
  }
}
export type WorkflowConcurrencyHost = ReturnType<typeof createWorkflowConcurrencyHost>
export type WorkflowConcurrencyView = ReturnType<WorkflowConcurrencyHost['get']>['item']
