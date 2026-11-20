import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import {
  MODEL_COMPLEXITIES, MODEL_NOTE_MAX_LENGTH, MODEL_REF_RE, selectExecutionModel, type ModelComplexity, type ModelProfile,
} from '../executor/model-routing.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand, UUID_V7_RE } from './commands/idempotency.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'

const modelRef = z.string().regex(MODEL_REF_RE)
const binding = modelRef.nullable()
const mappingSchema = z.strictObject({
  routine: binding, standard: binding, advanced: binding.optional(), complex: binding, expert: binding.optional(),
})
type ModelMapping = Record<ModelComplexity, string | null>
const noteSchema = z.strictObject({ ref: modelRef, note: z.string().trim().max(MODEL_NOTE_MAX_LENGTH) })
const notesSchema = z.array(noteSchema)
const MODEL_NOTES_MAX_BYTES = 8 * 1024
export const modelRoutingSettingsSchema = z.strictObject({
  operation_id: z.string().regex(UUID_V7_RE),
  expected_revision: z.number().int().nonnegative(),
  mapping: mappingSchema,
  model_notes: notesSchema.optional(),
})

type Row = { revision: number; mapping_json: string; model_notes_json: string; updated_by: string; updated_at: string }
type CatalogProfile = ModelProfile & { provider?: string; model?: string }
const EMPTY_MAPPING: ModelMapping = { routine: null, standard: null, advanced: null, complex: null, expert: null }

export function readModelRoutingSettings(tx: ReadTx) {
  const row = tx.get<Row>('SELECT revision, mapping_json, model_notes_json, updated_by, updated_at FROM model_routing_settings WHERE id = 1')
  if (!row) return { revision: 0, mapping: { ...EMPTY_MAPPING }, model_notes: [], updated_by: null, updated_at: null }
  const { advanced, expert, ...legacy } = mappingSchema.parse(JSON.parse(row.mapping_json))
  return {
    revision: row.revision, mapping: { ...legacy, advanced: advanced ?? null, expert: expert ?? null },
    model_notes: notesSchema.parse(JSON.parse(row.model_notes_json)),
    updated_by: row.updated_by, updated_at: row.updated_at,
  }
}

export function createModelRoutingSettingsHost(db: Db, profiles: readonly CatalogProfile[]) {
  const catalog = profiles.map(({ provider, model, ref, capacity }) => ({ ref, capacity, provider, model }))
  const approved = new Map(catalog.map((profile) => [profile.ref, profile]))
  function get() {
    return withReadTx(db, ({ tx, as_of_seq }) => {
      const settings = readModelRoutingSettings(tx)
      return { item: { ...settings, model_notes: settings.model_notes.filter(({ ref }) => approved.has(ref)), profiles: catalog }, as_of_seq }
    })
  }
  return {
    get,
    planningProfiles() {
      return withReadTx(db, ({ tx }) => readModelRoutingSettings(tx).model_notes.flatMap(({ ref, note }) => {
        const profile = approved.get(ref)
        return profile && note ? [{ ref, capacity: profile.capacity, user_note: note }] : []
      }))
    },
    save(request: z.input<typeof modelRoutingSettingsSchema>, actor: string, now: string) {
      const input = modelRoutingSettingsSchema.parse(request)
      return withTx(db, (tx) => runIdempotentCommand(tx, {
        kind: 'model_routing.save', operationId: input.operation_id,
        requestHash: requestHashOf('model_routing.save', { actor, ...input }), now,
      }, () => {
        const current = readModelRoutingSettings(tx)
        if (input.expected_revision !== current.revision) throw new OrchError('STALE_GENERATION', '模型配置已更新，请重新读取')
        const { advanced, expert, ...legacy } = input.mapping
        const mapping = { ...legacy, advanced: advanced === undefined ? current.mapping.advanced : advanced,
          expert: expert === undefined ? current.mapping.expert : expert }
        for (const complexity of MODEL_COMPLEXITIES) {
          const ref = mapping[complexity]
          if (ref !== null) selectExecutionModel(catalog, { complexity, preferredModel: ref, reason: '用户指定' })
        }
        const notes = new Map(current.model_notes.filter(({ ref }) => approved.has(ref)).map(({ ref, note }) => [ref, note]))
        const changedRefs = new Set<string>()
        for (const { ref, note } of input.model_notes ?? []) {
          if (!approved.has(ref)) throw new OrchError('FORBIDDEN', '仅可为已批准的模型设置用途说明')
          if (changedRefs.has(ref)) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '同一模型在请求中只能设置一条用途说明')
          changedRefs.add(ref)
          if (note) notes.set(ref, note)
          else notes.delete(ref)
        }
        const modelNotesJson = JSON.stringify([...notes].map(([ref, note]) => ({ ref, note })))
        if (Buffer.byteLength(modelNotesJson, 'utf8') > MODEL_NOTES_MAX_BYTES) {
          throw new OrchError('RANGE_TOO_LARGE', '模型用途说明超出总容量，请缩短或清除部分说明')
        }
        const revision = current.revision + 1
        tx.run('INSERT INTO model_routing_settings (id,revision,mapping_json,model_notes_json,updated_by,updated_at) VALUES (1,?,?,?,?,?) '
          + 'ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,mapping_json=excluded.mapping_json,'
          + 'model_notes_json=excluded.model_notes_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
        [revision, JSON.stringify(mapping), modelNotesJson, actor, now])
        appendEvent(tx, { type: 'model_routing.updated', payload: { revision, actor, mapping, model_note_refs: [...changedRefs] } })
        return { revision }
      }).result)
    },
  }
}

export type ModelRoutingSettingsHost = ReturnType<typeof createModelRoutingSettingsHost>
export type ModelRoutingSettingsView = ReturnType<ModelRoutingSettingsHost['get']>['item']
