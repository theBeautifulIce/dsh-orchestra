import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import { MODEL_COMPLEXITIES, selectExecutionModel, type ModelProfile } from '../executor/model-routing.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand, UUID_V7_RE } from './commands/idempotency.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'

const modelRef = z.string().regex(/^[\w./:@+-]{1,128}$/).nullable()
const mappingSchema = z.strictObject({ routine: modelRef, standard: modelRef, complex: modelRef })
type ModelMapping = z.infer<typeof mappingSchema>
export const modelRoutingSettingsSchema = z.strictObject({
  operation_id: z.string().regex(UUID_V7_RE),
  expected_revision: z.number().int().nonnegative(),
  mapping: mappingSchema,
})

type Row = { revision: number; mapping_json: string; updated_by: string; updated_at: string }
type CatalogProfile = ModelProfile & { provider?: string; model?: string }
const EMPTY_MAPPING: ModelMapping = { routine: null, standard: null, complex: null }

export function readModelRoutingSettings(tx: ReadTx) {
  const row = tx.get<Row>('SELECT revision, mapping_json, updated_by, updated_at FROM model_routing_settings WHERE id = 1')
  return row ? {
    revision: row.revision, mapping: mappingSchema.parse(JSON.parse(row.mapping_json)),
    updated_by: row.updated_by, updated_at: row.updated_at,
  } : { revision: 0, mapping: { ...EMPTY_MAPPING }, updated_by: null, updated_at: null }
}

export function createModelRoutingSettingsHost(db: Db, profiles: readonly CatalogProfile[]) {
  const catalog = profiles.map(({ provider, model, ref, capacity }) => ({ ref, capacity, provider, model }))
  function get() {
    return withReadTx(db, ({ tx, as_of_seq }) => ({
      item: { ...readModelRoutingSettings(tx), profiles: catalog }, as_of_seq,
    }))
  }
  return {
    get,
    save(input: z.infer<typeof modelRoutingSettingsSchema>, actor: string, now: string) {
      return withTx(db, (tx) => runIdempotentCommand(tx, {
        kind: 'model_routing.save', operationId: input.operation_id,
        requestHash: requestHashOf('model_routing.save', { actor, ...input }), now,
      }, () => {
        const current = readModelRoutingSettings(tx)
        if (input.expected_revision !== current.revision) throw new OrchError('STALE_GENERATION', '模型配置已更新，请重新读取')
        for (const complexity of MODEL_COMPLEXITIES) {
          const ref = input.mapping[complexity]
          if (ref !== null) selectExecutionModel(catalog, { complexity, preferredModel: ref, reason: '用户指定' })
        }
        const revision = current.revision + 1
        tx.run('INSERT INTO model_routing_settings (id,revision,mapping_json,updated_by,updated_at) VALUES (1,?,?,?,?) '
          + 'ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,mapping_json=excluded.mapping_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
        [revision, JSON.stringify(input.mapping), actor, now])
        appendEvent(tx, { type: 'model_routing.updated', payload: { revision, actor, mapping: input.mapping } })
        return { revision }
      }).result)
    },
  }
}

export type ModelRoutingSettingsHost = ReturnType<typeof createModelRoutingSettingsHost>
export type ModelRoutingSettingsView = ReturnType<ModelRoutingSettingsHost['get']>['item']
