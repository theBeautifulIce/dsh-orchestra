import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import {
  MODEL_COMPLEXITIES, MODEL_NOTE_MAX_LENGTH, MODEL_REF_RE, selectExecutionModel, validModelEffort,
  type ModelCatalogProfile, type ModelCatalogSnapshot, type ModelComplexity, type ModelProfile,
} from '../executor/model-routing.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand, UUID_V7_RE } from './commands/idempotency.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'

const modelRef = z.string().regex(MODEL_REF_RE)
const binding = modelRef.nullable()
export const legacyModelMappingSchema = z.strictObject({ routine: binding, standard: binding, complex: binding })
const extendedModelMappingSchema = z.strictObject({ advanced: binding, expert: binding })
const mappingSchema = legacyModelMappingSchema.extend(extendedModelMappingSchema.partial().shape)
type ModelMapping = Record<ModelComplexity, string | null>
const noteSchema = z.strictObject({ ref: modelRef, note: z.string().trim().max(MODEL_NOTE_MAX_LENGTH) })
const notesSchema = z.array(noteSchema)
const capacitySchema = z.enum(MODEL_COMPLEXITIES)
const capacitiesSchema = z.array(z.strictObject({ ref: modelRef, capacity: capacitySchema.nullable() }))
const effortSchema = z.string().refine(validModelEffort).nullable()
const effortsSchema = z.partialRecord(capacitySchema, effortSchema)
const modelEffortsSchema = z.array(z.strictObject({ ref: modelRef, effort: effortSchema }))
const plannerModelSchema = z.strictObject({ ref: modelRef, effort: effortSchema }).nullable()
const preferencesSchema = z.strictObject({
  model_capacities: capacitiesSchema.default([]),
  reasoning_efforts: effortsSchema.default({}),
  model_reasoning_defaults: modelEffortsSchema.default([]),
  planner_model: plannerModelSchema.default(null),
})
const MODEL_NOTES_MAX_BYTES = 8 * 1024
export const modelRoutingSettingsSchema = z.strictObject({
  operation_id: z.string().regex(UUID_V7_RE),
  expected_revision: z.number().int().nonnegative(),
  mapping: mappingSchema,
  model_notes: notesSchema.optional(),
  model_capacities: capacitiesSchema.optional(),
  reasoning_efforts: effortsSchema.optional(),
  model_reasoning_defaults: modelEffortsSchema.optional(),
  planner_model: plannerModelSchema.optional(),
})

type Row = { revision: number; mapping_json: string; extended_mapping_json: string; model_notes_json: string;
  preferences_json: string; updated_by: string; updated_at: string }
const EMPTY_MAPPING: ModelMapping = { routine: null, standard: null, advanced: null, complex: null, expert: null }

export function readModelRoutingSettings(tx: ReadTx) {
  const row = tx.get<Row>('SELECT revision, mapping_json, extended_mapping_json, model_notes_json, preferences_json, updated_by, updated_at FROM model_routing_settings WHERE id = 1')
  if (!row) return { revision: 0, mapping: { ...EMPTY_MAPPING }, model_notes: [] as z.output<typeof notesSchema>,
    ...preferencesSchema.parse({}), updated_by: null, updated_at: null }
  const legacy = legacyModelMappingSchema.parse(JSON.parse(row.mapping_json))
  const extended = extendedModelMappingSchema.parse(JSON.parse(row.extended_mapping_json))
  return {
    revision: row.revision, mapping: { ...legacy, ...extended },
    model_notes: notesSchema.parse(JSON.parse(row.model_notes_json)),
    ...preferencesSchema.parse(JSON.parse(row.preferences_json)),
    updated_by: row.updated_by, updated_at: row.updated_at,
  }
}

export function effectiveModelCatalog(profiles: readonly ModelCatalogProfile[],
  settings: Pick<ReturnType<typeof readModelRoutingSettings>, 'model_capacities'>) {
  const overrides = new Map(settings.model_capacities.map(({ ref, capacity }) => [ref, capacity]))
  return profiles.map((profile) => {
    const capacity = overrides.get(profile.ref)
    return capacity == null ? profile : { ...profile, capacity }
  })
}

export function approvedModelProfiles(profiles: readonly ModelCatalogProfile[]): ModelProfile[] {
  return profiles.flatMap((profile) => profile.capacity === null ? [] : [{ ...profile, capacity: profile.capacity }])
}

export function createModelRoutingSettingsHost(db: Db, source: readonly ModelCatalogProfile[] | (() => ModelCatalogSnapshot),
  refresh?: () => Promise<void>, plannerModelConfigurable = false) {
  const snapshot = (): ModelCatalogSnapshot => typeof source === 'function' ? source() : { profiles: source }
  function get() {
    return withReadTx(db, ({ tx, as_of_seq }) => {
      const settings = readModelRoutingSettings(tx)
      const { profiles, unavailable_providers, session_execution_model_ref } = snapshot()
      const refs = new Set(profiles.map(({ ref }) => ref))
      const baseCapacities = new Map(profiles.map(({ ref, capacity }) => [ref, capacity]))
      return { item: { ...settings, planner_model_configurable: plannerModelConfigurable, model_notes: settings.model_notes.filter(({ ref }) => refs.has(ref)),
        model_capacities: settings.model_capacities.filter(({ ref }) => refs.has(ref)),
        model_reasoning_defaults: settings.model_reasoning_defaults.filter(({ ref }) => refs.has(ref)),
        profiles: effectiveModelCatalog(profiles, settings).map((profile) =>
          ({ ...profile, host_capacity: baseCapacities.get(profile.ref) ?? null })),
        ...(session_execution_model_ref ? { session_execution_model_ref } : {}),
        ...(unavailable_providers ? { unavailable_providers } : {}) }, as_of_seq }
    })
  }
  return {
    get,
    refresh,
    planningProfiles() {
      return withReadTx(db, ({ tx }) => {
        const settings = readModelRoutingSettings(tx)
        const approved = new Map(effectiveModelCatalog(snapshot().profiles, settings).map((profile) => [profile.ref, profile]))
        return settings.model_notes.flatMap(({ ref, note }) => {
          const profile = approved.get(ref)
          return profile?.capacity && note ? [{ ref, capacity: profile.capacity, user_note: note }] : []
        })
      })
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
        const { profiles } = snapshot()
        const available = new Set(profiles.map(({ ref }) => ref))
        const byRef = new Map(profiles.map((profile) => [profile.ref, profile]))
        const supportsEffort = (ref: string, effort: string) => byRef.get(ref)?.reasoning?.efforts.some(({ id }) => id === effort)
        if (input.planner_model !== undefined && !plannerModelConfigurable) {
          throw new OrchError('FORBIDDEN', '此宿主统一管理主脑模型配置。')
        }
        const plannerModel = input.planner_model === undefined ? current.planner_model : input.planner_model
        if (input.planner_model) {
          const { ref, effort } = input.planner_model
          if (!available.has(ref)) throw new OrchError('FORBIDDEN', '主脑模型已不在当前目录。请重新选择，或改为跟随当前会话。')
          if (effort !== null && !supportsEffort(ref, effort)) {
            throw new OrchError('FORBIDDEN', '主脑模型未提供所选思考强度，请重新选择。')
          }
        }
        const capacities = new Map(current.model_capacities.map(({ ref, capacity }) => [ref, capacity]))
        const changedCapacities = new Set<string>()
        for (const { ref, capacity } of input.model_capacities ?? []) {
          if (!available.has(ref)) throw new OrchError('FORBIDDEN', '仅可为 DSH 目录中的模型设置最大能力')
          if (changedCapacities.has(ref)) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '同一模型只能设置一条最大能力')
          changedCapacities.add(ref)
          if (capacity === null) capacities.delete(ref)
          else capacities.set(ref, capacity)
        }
        const model_capacities = [...capacities].map(([ref, capacity]) => ({ ref, capacity }))
        const catalog = approvedModelProfiles(effectiveModelCatalog(profiles, { model_capacities }))
        const reasoning_efforts = { ...current.reasoning_efforts }
        for (const complexity of MODEL_COMPLEXITIES) {
          const ref = mapping[complexity]
          const mappingChanged = ref !== current.mapping[complexity]
          const effort = input.reasoning_efforts?.[complexity]
          if (ref !== null && (mappingChanged || typeof effort === 'string')) {
            selectExecutionModel(catalog, { complexity, preferredModel: ref, reason: '用户指定' })
          }
          if (typeof effort === 'string' && (!ref || !supportsEffort(ref, effort))) {
            throw new OrchError('FORBIDDEN', '此 DSH 模型未提供所选思考深度，请重新读取目录或改用默认')
          }
          if (mappingChanged || effort === null) delete reasoning_efforts[complexity]
          if (typeof effort === 'string') reasoning_efforts[complexity] = effort
        }
        const defaultEfforts = new Map(current.model_reasoning_defaults.map(({ ref, effort }) => [ref, effort]))
        const changedDefaultEfforts = new Set<string>()
        for (const { ref, effort } of input.model_reasoning_defaults ?? []) {
          if (!available.has(ref)) throw new OrchError('FORBIDDEN', '仅可为 DSH 目录中的模型设置思考深度')
          if (changedDefaultEfforts.has(ref)) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '同一模型只能设置一条默认思考深度')
          changedDefaultEfforts.add(ref)
          if (effort === null) defaultEfforts.delete(ref)
          else {
            if (!supportsEffort(ref, effort)) throw new OrchError('FORBIDDEN', '此 DSH 模型未提供所选思考深度，请重新读取目录或改用宿主默认')
            defaultEfforts.set(ref, effort)
          }
        }
        const model_reasoning_defaults = [...defaultEfforts].map(([ref, effort]) => ({ ref, effort }))
        const notes = new Map(current.model_notes.map(({ ref, note }) => [ref, note]))
        const changedRefs = new Set<string>()
        for (const { ref, note } of input.model_notes ?? []) {
          if (!available.has(ref)) throw new OrchError('FORBIDDEN', '仅可为 DSH 目录中的模型设置用途说明')
          if (changedRefs.has(ref)) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '同一模型在请求中只能设置一条用途说明')
          changedRefs.add(ref)
          if (note) notes.set(ref, note)
          else notes.delete(ref)
        }
        const modelNotesJson = JSON.stringify([...notes].map(([ref, note]) => ({ ref, note })))
        const preferencesJson = JSON.stringify({ model_capacities, reasoning_efforts,
          ...(plannerModel ? { planner_model: plannerModel } : {}),
          ...(model_reasoning_defaults.length ? { model_reasoning_defaults } : {}) })
        if (Buffer.byteLength(modelNotesJson, 'utf8') > MODEL_NOTES_MAX_BYTES) {
          throw new OrchError('RANGE_TOO_LARGE', '模型用途说明超出总容量，请缩短或清除部分说明')
        }
        if (Buffer.byteLength(preferencesJson, 'utf8') > MODEL_NOTES_MAX_BYTES) {
          throw new OrchError('RANGE_TOO_LARGE', '模型能力与思考设置超出总容量')
        }
        const revision = current.revision + 1
        tx.run('INSERT INTO model_routing_settings (id,revision,mapping_json,extended_mapping_json,model_notes_json,preferences_json,updated_by,updated_at) VALUES (1,?,?,?,?,?,?,?) '
          + 'ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,mapping_json=excluded.mapping_json,'
          + 'extended_mapping_json=excluded.extended_mapping_json,model_notes_json=excluded.model_notes_json,'
          + 'preferences_json=excluded.preferences_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
        [revision, JSON.stringify(legacy), JSON.stringify({ advanced: mapping.advanced, expert: mapping.expert }), modelNotesJson, preferencesJson, actor, now])
        appendEvent(tx, { type: 'model_routing.updated', payload: { revision, actor, mapping, model_note_refs: [...changedRefs],
          model_capacity_refs: [...changedCapacities], reasoning_efforts, model_reasoning_default_refs: [...changedDefaultEfforts],
          ...(input.planner_model !== undefined ? { planner_model: plannerModel } : {}) } })
        return { revision }
      }).result)
    },
  }
}

export type ModelRoutingSettingsHost = ReturnType<typeof createModelRoutingSettingsHost>
export type ModelRoutingSettingsView = ReturnType<ModelRoutingSettingsHost['get']>['item']
