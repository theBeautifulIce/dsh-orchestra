import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { uuidv7 } from '../../src/core/ids.ts'
import { MODEL_NOTE_MAX_LENGTH, selectExecutionModel, type ModelCatalogProfile, type ModelProfile } from '../../src/executor/model-routing.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { openDb, withTx } from '../../src/infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand } from '../../src/service/commands/idempotency.ts'
import { createModelRoutingSettingsHost } from '../../src/service/model-routing-settings.ts'
import { freshLedger } from '../fixtures/ledger.ts'
import { startServer } from '../../src/service/server.ts'
import { WriteQueue } from '../../src/service/write-queue.ts'
import { previousCompatibility } from '../../scripts/upgrade-host.ts'

it('模型保存等目录时，另一 HTTP 写仍可以通过全局写队列', async () => {
  const { db } = freshLedger()
  const fetching = Promise.withResolvers<void>()
  const complete = Promise.withResolvers<void>()
  const queue = new WriteQueue()
  const secret = 'model-catalog-write-gate-fixture'
  const settings = createModelRoutingSettingsHost(db, [{ ref: 'p/m', capacity: 'standard' }], async () => {
    fetching.resolve()
    await complete.promise
  })
  const api = await startServer({ secret, phase: 'S6', epoch: db.epoch, asOfSeq: () => 0,
    modelSettings: settings, queue, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 1, event_id: 'other-receipt' }) })
  const post = (path: string, body: unknown) => new Promise<{ status: number; payload: unknown }>((resolve) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: 'POST', url: path, headers: { 'x-orchestra-secret': secret, 'content-type': 'application/json' },
    })
    let status = 0
    // Invoke the mounted HTTP listener directly so this test also runs in sandboxes without loopback TCP.
    api.server.emit('request', req, {
      writeHead: (value: number) => { status = value },
      end: (text: string) => resolve({ status, payload: JSON.parse(text) }),
    })
  })
  const saving = post('/v1/settings/model-routing', { operation_id: uuidv7(), expected_revision: 0,
    mapping: { routine: 'p/m', standard: null, complex: null } })
  try {
    await Promise.race([fetching.promise, saving.then(() => { throw new Error('save returned before refreshing the catalog') })])
    expect(queue.size).toBe(0)
    const unrelated = await post('/v1/ledger/events', {})
    expect(unrelated).toMatchObject({ status: 200, payload: { data: { event_id: 'other-receipt' } } })
    complete.resolve()
    expect((await saving).status).toBe(200)
    expect(settings.get().item.revision).toBe(1)
  } finally {
    complete.resolve()
    await saving.catch(() => {})
    await api.close()
    db.raw.close()
  }
})

it('保留已移除模型的配置与回执，只允许为当前供应商和模型保存真实思考档', () => {
  const { db } = freshLedger()
  try {
    const plain = { ref: 'a/same', provider: 'a', model: 'same', capacity: 'standard' } satisfies ModelCatalogProfile
    const reasoner = { ref: 'b/same', provider: 'b', model: 'same', capacity: null,
      reasoning: { efforts: [{ id: 'adapter-specific', name: 'Extended' }], defaultEffort: 'adapter-specific' } } satisfies ModelCatalogProfile
    let profiles: ModelCatalogProfile[] = [plain]
    const host = createModelRoutingSettingsHost(db, () => ({ profiles, unavailable_providers: [] }))
    const now = '2026-11-20T02:00:00.000Z'
    const mapping = { routine: null, standard: null, advanced: null, complex: null, expert: 'a/same' }
    const rating = [{ ref: 'a/same', capacity: 'expert' as const }]
    const initial = { operation_id: uuidv7(), expected_revision: 0, mapping, model_capacities: rating }
    expect(() => host.save({ ...initial, reasoning_efforts: { expert: 'adapter-specific' } }, 'operator', now))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => host.save({ ...initial, model_reasoning_defaults: [{ ref: plain.ref, effort: 'adapter-specific' }] }, 'operator', now))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(host.save(initial, 'operator', now)).toEqual({ revision: 1 })
    expect(host.get().item.profiles).toMatchObject([{ ref: 'a/same', host_capacity: 'standard', capacity: 'expert' }])
    profiles = [reasoner]
    expect(host.get().item).toMatchObject({ mapping, profiles: [{ ref: 'b/same', capacity: null }] })
    expect(host.save(initial, 'operator', now)).toEqual({ revision: 1 })
    const changed = { operation_id: uuidv7(), expected_revision: 1, mapping: { ...mapping, expert: 'b/same' },
      model_capacities: [{ ref: 'b/same', capacity: 'expert' as const }],
      model_notes: [{ ref: 'b/same', note: '复核多项证据' }], reasoning_efforts: { expert: 'adapter-specific' },
      model_reasoning_defaults: [{ ref: 'b/same', effort: 'adapter-specific' }] }
    expect(host.save(changed, 'operator', now)).toEqual({ revision: 2 })
    expect(host.save(changed, 'operator', now)).toEqual({ revision: 2 })
    expect(host.get().item.reasoning_efforts).toEqual({ expert: 'adapter-specific' })
    expect(createModelRoutingSettingsHost(db, () => ({ profiles })).get().item.model_reasoning_defaults).toEqual(changed.model_reasoning_defaults)
    expect(host.planningProfiles()).toEqual([{ ref: 'b/same', capacity: 'expert', user_note: '复核多项证据' }])
    profiles = [plain, { ...reasoner, reasoning: undefined }]
    expect(host.get().item).toMatchObject({ profiles: [{ ref: 'a/same', capacity: 'expert' }, { ref: 'b/same', capacity: 'expert' }],
      reasoning_efforts: { expert: 'adapter-specific' } })
    expect(host.save({ operation_id: uuidv7(), expected_revision: 2, mapping: changed.mapping,
      reasoning_efforts: { expert: null }, model_reasoning_defaults: [{ ref: 'b/same', effort: null }] }, 'operator', now)).toEqual({ revision: 3 })
    expect(host.get().item.reasoning_efforts).toEqual({})
    expect(host.get().item.model_reasoning_defaults).toEqual([])
  } finally { db.raw.close() }
})

it('主脑默认跟随会话，指定后独立保存，并能在供应商移除后恢复跟随', () => {
  const { db } = freshLedger()
  try {
    const a = { ref: 'account-a/shared', capacity: null } satisfies ModelCatalogProfile
    const b = { ref: 'account-b/shared', capacity: null, reasoning: { efforts: [{ id: 'high', name: 'High' }] } } satisfies ModelCatalogProfile
    let profiles: ModelCatalogProfile[] = [a, b]
    const openSettings = () => createModelRoutingSettingsHost(db, () => ({ profiles }), undefined, true)
    const host = openSettings()
    const mapping = { routine: null, standard: null, complex: null }
    const save = (expected_revision: number) => ({ operation_id: uuidv7(), expected_revision, mapping })
    const now = new Date().toISOString()
    expect(host.get().item.planner_model).toBeNull()
    expect(() => host.save({ ...save(0), planner_model: { ref: a.ref, effort: 'high' } }, 'owner', now))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    const selection = { ref: b.ref, effort: 'high' }
    const choice = { ...save(0), planner_model: selection }
    const managed = createModelRoutingSettingsHost(db, () => ({ profiles }))
    expect(managed.get().item.planner_model_configurable).toBe(false)
    expect(() => managed.save(choice, 'owner', now)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(host.save(choice, 'owner', now)).toEqual({ revision: 1 })
    profiles = [a]
    expect(host.save(choice, 'owner', now)).toEqual({ revision: 1 })
    expect(openSettings().get().item.planner_model).toEqual(selection)
    expect(() => host.save({ ...save(1), planner_model: selection }, 'owner', now))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(host.save({ ...save(1), model_notes: [{ ref: a.ref, note: '整理' }] }, 'owner', now)).toEqual({ revision: 2 })
    expect(openSettings().get().item.planner_model).toEqual(selection)
    expect(() => host.save({ ...save(1), planner_model: null }, 'owner', now)).toThrow(expect.objectContaining({ code: 'STALE_GENERATION' }))
    expect(host.save({ ...save(2), planner_model: null }, 'owner', now)).toEqual({ revision: 3 })
    expect(openSettings().get().item.planner_model).toBeNull()
    const stored = db.raw.prepare('SELECT preferences_json FROM model_routing_settings').get() as { preferences_json: string }
    expect(JSON.parse(stored.preferences_json)).not.toHaveProperty('planner_model')
  } finally { db.raw.close() }
})

it('模型分配只能使用获准且达到对应复杂度的模型，保留修订与重放回执', () => {
  const { db } = freshLedger()
  const profiles = [
    { ref: 'approved/fast', capacity: 'routine' as const, provider: 'local', model: 'fast' },
    { ref: 'approved/reasoner', capacity: 'complex' as const, provider: 'local', model: 'reasoner' },
  ]
  const host = createModelRoutingSettingsHost(db, profiles)
  const now = new Date().toISOString()
  const candidate = { operation_id: uuidv7(), expected_revision: 0,
    mapping: { routine: null, standard: null, complex: 'approved/fast' } }
  expect(() => host.save(candidate, 'operator', now)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(host.get().item.revision).toBe(0)
  const input = { ...candidate, mapping: { routine: 'approved/fast', standard: null, complex: 'approved/reasoner' } }
  expect(host.save(input, 'operator', now)).toEqual({ revision: 1 })
  expect(host.save(input, 'operator', now)).toEqual({ revision: 1 })
  expect(() => host.save({ ...input, operation_id: uuidv7() }, 'operator', now)).toThrow(expect.objectContaining({ code: 'STALE_GENERATION' }))
  expect(createModelRoutingSettingsHost(db, profiles).get().item).toMatchObject({
    revision: 1, mapping: input.mapping, updated_by: 'operator', profiles,
  })
})

it('存在模型默认思考档时，旧版回退预检拒绝丢失设置，清空后仍兼容旧数据', () => {
  const db = openDb(':memory:')
  try {
    applySteps(db, loadSteps(defaultMigrationsDir()))
    const profile = { ref: 'fixture/same', capacity: 'standard' as const, reasoning: { efforts: [{ id: 'high', name: 'High' }] } }
    const host = createModelRoutingSettingsHost(db, [profile])
    const payload = { operation_id: uuidv7(), expected_revision: 0, mapping: { routine: null, standard: null, complex: null },
      model_reasoning_defaults: [{ ref: profile.ref, effort: 'high' }] }
    host.save(payload, 'operator', new Date().toISOString())
    expect(() => previousCompatibility(db, [profile])).toThrow(/"candidate_routing":1/)
    host.save({ ...payload, operation_id: uuidv7(), expected_revision: 1,
      model_reasoning_defaults: [{ ref: profile.ref, effort: null }] }, 'operator', new Date().toISOString())
    expect(previousCompatibility(db, [profile])).toMatchObject({ candidate_routing: 0 })
    const stored = db.raw.prepare('SELECT preferences_json FROM model_routing_settings WHERE id=1').get() as { preferences_json: string }
    expect(JSON.parse(stored.preferences_json)).not.toHaveProperty('model_reasoning_defaults')
  } finally { db.raw.close() }
})

it('迁移旧映射，重放既有操作，并按修订保存或清空已批准模型的用途说明', () => {
  const db = openDb(':memory:')
  try {
    const steps = loadSteps(defaultMigrationsDir())
    applySteps(db, steps.filter(({ version }) => version < 58))
    const profiles = [
      { ref: 'fast', capacity: 'routine' }, { ref: 'middle', capacity: 'standard' },
      { ref: 'analyst', capacity: 'advanced' }, { ref: 'deep', capacity: 'complex' },
      { ref: 'expert', capacity: 'expert' },
    ] satisfies ModelProfile[]
    const operator = 'operator'
    const now = '2026-11-20T02:00:00.000Z'
    const legacyMapping = { routine: 'fast', standard: null, complex: 'deep' }
    const legacy = { operation_id: uuidv7(), expected_revision: 0, mapping: legacyMapping }
    withTx(db, (tx) => runIdempotentCommand(tx, {
      kind: 'model_routing.save', operationId: legacy.operation_id, now,
      requestHash: requestHashOf('model_routing.save', { actor: operator, ...legacy }),
    }, () => {
      tx.run('INSERT INTO model_routing_settings (id,revision,mapping_json,updated_by,updated_at) VALUES (1,1,?,?,?)',
        [JSON.stringify(legacyMapping), operator, now])
      return { revision: 1 }
    }))
    applySteps(db, steps)
    const host = createModelRoutingSettingsHost(db, profiles)
    expect(host.get().item).toMatchObject({ revision: 1, model_notes: [], model_reasoning_defaults: [],
      mapping: { ...legacyMapping, advanced: null, expert: null } })
    expect(host.save(legacy, operator, now)).toEqual({ revision: 1 })
    for (const { capacity, ref } of profiles) {
      expect(selectExecutionModel(profiles, { complexity: capacity, reason: '按步骤最低能力派发' }).model_ref).toBe(ref)
    }
    const change = { operation_id: uuidv7(), expected_revision: 1, mapping: { ...legacyMapping, advanced: 'analyst', expert: 'expert' },
      model_notes: [{ ref: 'analyst', note: '  擅长交叉核对资料  ' }] }
    expect(() => host.save({ ...change, mapping: { ...change.mapping, expert: 'deep' } }, operator, now))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => host.save({ ...change, model_notes: [{ ref: 'analyst', note: '长'.repeat(MODEL_NOTE_MAX_LENGTH + 1) }] }, operator, now))
      .toThrow()
    expect(() => host.save({ ...change, model_notes: [{ ref: 'unapproved', note: '专家' }] }, operator, now))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(host.save(change, operator, now)).toEqual({ revision: 2 })
    expect(host.save(change, operator, now)).toEqual({ revision: 2 })
    expect(() => host.save({ ...change, model_notes: [{ ref: 'analyst', note: '不同内容' }] }, operator, now))
      .toThrow(expect.objectContaining({ code: 'OPERATION_ID_CONFLICT' }))
    expect(() => host.save({ ...change, operation_id: uuidv7() }, operator, now))
      .toThrow(expect.objectContaining({ code: 'STALE_GENERATION' }))

    const reopened = createModelRoutingSettingsHost(db, profiles)
    expect(reopened.get().item).toMatchObject({ revision: 2, mapping: change.mapping, model_notes: [{ ref: 'analyst', note: '擅长交叉核对资料' }] })
    expect(reopened.planningProfiles()).toEqual([{ ref: 'analyst', capacity: 'advanced', user_note: '擅长交叉核对资料' }])
    expect(createModelRoutingSettingsHost(db, profiles.filter(({ ref }) => ref !== 'analyst')).planningProfiles()).toEqual([])
    expect(reopened.save({ ...legacy, operation_id: uuidv7(), expected_revision: 2 }, operator, now)).toEqual({ revision: 3 })
    expect(reopened.get().item).toMatchObject({ mapping: change.mapping, model_notes: [{ ref: 'analyst', note: '擅长交叉核对资料' }] })
    expect(reopened.save({ ...change, operation_id: uuidv7(), expected_revision: 3, model_notes: [{ ref: 'analyst', note: '   ' }] }, operator, now))
      .toEqual({ revision: 4 })
    expect(reopened.get().item.model_notes).toEqual([])
    expect(reopened.planningProfiles()).toEqual([])
  } finally {
    db.raw.close()
  }
})

it('迁移 S6 开发态五档后保留说明和旧操作回执，旧写入只覆盖三个旧键', () => {
  const db = openDb(':memory:')
  try {
    const steps = loadSteps(defaultMigrationsDir())
    applySteps(db, steps.filter(({ version }) => version < 60))
    const request = { operation_id: uuidv7(), expected_revision: 0,
      mapping: { routine: 'fast', standard: null, advanced: 'analyst', complex: null, expert: 'expert' },
      model_notes: [{ ref: 'analyst', note: '多源核验' }] }
    const now = '2026-11-20T02:00:00.000Z'
    withTx(db, (tx) => runIdempotentCommand(tx, {
      kind: 'model_routing.save', operationId: request.operation_id, now,
      requestHash: requestHashOf('model_routing.save', { actor: 'operator', ...request }),
    }, () => {
      tx.run('INSERT INTO model_routing_settings VALUES (1,1,?,?,?,?)', [
        JSON.stringify(request.mapping), 'operator', now, JSON.stringify(request.model_notes),
      ])
      return { revision: 1 }
    }))
    applySteps(db, steps)
    const host = createModelRoutingSettingsHost(db, [
      { ref: 'fast', capacity: 'routine' }, { ref: 'analyst', capacity: 'advanced' }, { ref: 'expert', capacity: 'expert' },
    ])
    expect(host.get().item).toMatchObject({ revision: 1, mapping: request.mapping, model_notes: request.model_notes })
    expect(host.save(request, 'operator', now)).toEqual({ revision: 1 })
    const oldRow = db.raw.prepare('SELECT mapping_json FROM model_routing_settings WHERE id=1').get() as { mapping_json: string }
    expect(JSON.parse(oldRow.mapping_json)).toEqual({ routine: 'fast', standard: null, complex: null })
    db.raw.prepare('UPDATE model_routing_settings SET revision=2,mapping_json=? WHERE id=1')
      .run(JSON.stringify({ routine: null, standard: null, complex: null }))
    expect(host.get().item).toMatchObject({ revision: 2, mapping: { ...request.mapping, routine: null }, model_notes: request.model_notes })
  } finally { db.raw.close() }
})
