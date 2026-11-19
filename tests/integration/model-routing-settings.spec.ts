import { expect, it } from 'vitest'
import { uuidv7 } from '../../src/core/ids.ts'
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
