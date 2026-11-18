import { contentHash, type MemoryItemInput } from '../core/memory-canonical.ts'
import { OrchError } from '../core/errors.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import type { Actor } from './decision/approver.ts'
import { requestHashOf, runIdempotentCommand } from './commands/idempotency.ts'
import { startMemoryRun, type StartMemoryRunParams } from './commands/memory.ts'
import { expireMemoryApproval, resolveMemoryApproval } from './commands/memory-approval.ts'
import type { GovernedWriteInput, InspectMemoryWrite } from './commands/memory-ports.ts'
import type { MemoryRecoveryRequest } from './commands/memory-recovery.ts'
import { createMemoryRuntime, type MemoryRuntimeOptions } from './commands/memory-runtime.ts'
import type { NodeCommands } from './server.ts'

type PluginEntry = { client_key: string; content_hash: string; applied_item_id: string }
export type MemoryPluginWriter = {
  protocol: 1
  writeMemory(input: Omit<GovernedWriteInput, 'items'> & { items: (MemoryItemInput & { content_hash: string })[] }): Promise<PluginEntry[]>
  fenceAndInspect: InspectMemoryWrite
}

export type MemoryHostOptions = Pick<MemoryRuntimeOptions, 'prepareItems' | 'judge' | 'resolveSource' | 'judgeTimeoutMs'> & (
  { context: { get(name: 'orchestraMemoryWriter'): unknown }; plugin?: never }
  | { plugin: MemoryPluginWriter; context?: never }
)

export function createMemoryHost(db: Db, secret: string, options: MemoryHostOptions, logError: (error: unknown) => void) {
  const { context, plugin: injected, ...runtimeOptions } = options
  function getWriter(): MemoryPluginWriter {
    const plugin = (context ? context.get('orchestraMemoryWriter') : injected) as Partial<MemoryPluginWriter> | undefined
    if (plugin?.protocol !== 1 || typeof plugin.writeMemory !== 'function' || typeof plugin.fenceAndInspect !== 'function') {
      throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '记忆插件未提供受控写入恢复协议')
    }
    return plugin as MemoryPluginWriter
  }
  getWriter()
  const runtime = createMemoryRuntime({
    ...runtimeOptions, db, secret, ownerEpoch: db.epoch,
    writer: {
      async writeMemory({ items, ...scope }) {
        const approved = items.map((item) => ({ ...item, content_hash: contentHash(item) }))
        const expected = new Map(approved.map((item) => [item.client_key, item.content_hash]))
        const entries = await getWriter().writeMemory({ ...scope, items: approved })
        if (!Array.isArray(entries) || entries.some((entry) => expected.get(entry.client_key) !== entry.content_hash)) {
          throw new OrchError('MEMORY_APPLY_CONFLICT', '插件回执与已批准条目的哈希不符')
        }
        return {
          applied_count: entries.length,
          skipped_count: 0,
          applied_item_ids: entries.map((entry) => entry.applied_item_id),
          applied: entries.map((entry) => ({ client_key: entry.client_key, item_id: entry.applied_item_id })),
        }
      },
      fenceAndInspect: (scope) => getWriter().fenceAndInspect(scope),
    },
  })
  const active = new Map<string, Promise<unknown>>()
  let closing = false
  function advance(runId: string) {
    if (closing || active.has(runId)) return
    const current = Promise.resolve().then(() => runtime.advance({ memory_run_id: runId }))
      .catch(logError).finally(() => { active.delete(runId) })
    active.set(runId, current)
  }

  return {
    start(input: StartMemoryRunParams) {
      const out = startMemoryRun(db, input)
      advance(out.memory_run_id)
      return out
    },
    inspect: async (batchId: string) => {
      const row = db.raw.prepare(
        "SELECT n.status FROM memory_batches b JOIN node_runs n ON n.node_run_id = b.apply_node_run_id WHERE b.batch_id = ?",
      ).get(batchId)
      if (!row || !['indeterminate_side_effect', 'abandoned_unverified'].includes(String(row.status))) {
        throw new OrchError('RESOLUTION_NOT_AVAILABLE', '记忆写入尚未进入待恢复状态')
      }
      return runtime.inspectBatch(batchId)
    },
    resolve(actor: Actor, request: MemoryRecoveryRequest) {
      const out = runtime.resolveRecovery(actor, request)
      if (out.status === 'confirmed_applied' || out.status === 'confirmed_not_applied') {
        const row = db.raw.prepare('SELECT memory_run_id FROM memory_batches WHERE batch_id = ?').get(out.batch_id)
        if (row) advance(String(row.memory_run_id))
      }
      return out
    },
    resolveApproval(input: Parameters<NodeCommands['resolveDecision']>[0]) {
      const row = db.raw.prepare('SELECT batch_id, memory_run_id FROM memory_batches WHERE decision_id = ?').get(input.decisionId)
      if (!row) return undefined
      if (!input.actor || !input.operationId || (input.resolution !== 'approved' && input.resolution !== 'rejected')) {
        throw new OrchError('RESOLUTION_NOT_AVAILABLE', '记忆写入批准只接受批准或驳回，并须提供回执编号')
      }
      const actor = input.actor
      const resolution = input.resolution
      const kind = 'decision.resolve'
      const out = withTx(db, (tx) => runIdempotentCommand(tx, {
        kind, operationId: input.operationId!, now: input.now, requestHash: requestHashOf(kind, { ...input, now: undefined }),
      }, () => {
        resolveMemoryApproval(tx, secret, {
          batch_id: String(row.batch_id), decision_id: input.decisionId, revision: input.revision,
          now: input.now, actor, resolution, confirm: input.confirm, contentHash: input.contentHash,
        })
        return { decisionId: input.decisionId, revision: input.revision + 1 }
      }).result)
      advance(String(row.memory_run_id))
      return out
    },
    resume(now = new Date().toISOString()) {
      const expired = db.raw.prepare(
        "SELECT b.batch_id, b.decision_id FROM memory_batches b JOIN decisions d ON d.decision_id = b.decision_id" +
        " JOIN runs r ON r.run_id = b.memory_run_id WHERE b.status = 'awaiting_human' AND r.status = 'running'" +
        ' AND d.expires_at <= ?',
      ).all(now)
      for (const row of expired) {
        withTx(db, (tx) => expireMemoryApproval(tx, secret, {
          batch_id: String(row.batch_id), decision_id: String(row.decision_id), now,
        }))
      }
      const rows = db.raw.prepare(
        "SELECT b.memory_run_id FROM memory_batches b JOIN runs r ON r.run_id = b.memory_run_id" +
        " WHERE r.status = 'running' AND r.cancel_requested_at IS NULL AND (" +
        " b.status IN ('draft','approved','applied','declined','expired')" +
        " OR (b.status = 'applying' AND b.apply_node_run_id IS NULL))",
      ).all()
      for (const row of rows) advance(String(row.memory_run_id))
    },
    async close() {
      closing = true
      await Promise.allSettled(active.values())
    },
  }
}

export type MemoryHost = ReturnType<typeof createMemoryHost>
