import { expect, it } from 'vitest'
import { uuidv7 } from '../../src/core/ids.ts'
import { MODEL_NOTE_MAX_LENGTH, selectExecutionModel, type ModelProfile } from '../../src/executor/model-routing.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { openDb, withTx } from '../../src/infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand } from '../../src/service/commands/idempotency.ts'
import { createModelRoutingSettingsHost } from '../../src/service/model-routing-settings.ts'
import { freshLedger } from '../fixtures/ledger.ts'

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
    expect(host.get().item).toMatchObject({ revision: 1, model_notes: [], mapping: { ...legacyMapping, advanced: null, expert: null } })
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
