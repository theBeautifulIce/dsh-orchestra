import { expect, it } from 'vitest'
import { createClientCommandReservations, type DshCommandUi } from '../../src/client/dsh-command-reservations.ts'

it('checks public client names, holds the saved name, swaps revisions and disposes every registration', () => {
  const registered = new Map<string, Parameters<DshCommandUi['register']>[0]>()
  const commands: DshCommandUi = { register(row) {
    if (registered.has(row.name)) throw new Error('duplicate contribution')
    registered.set(row.name, row)
    return () => { registered.delete(row.name) }
  } }
  const removeOther = commands.register({ name: 'model', available: () => true, ui: { kind: 'action', run() { throw new Error('must not execute') } } })
  const manager = createClientCommandReservations(commands)
  expect(manager.check('model').available).toBe(false)
  expect(manager.check('go').available).toBe(true)
  expect(registered.has('go')).toBe(false)
  manager.activate('orchestra', 0)
  expect(registered.get('orchestra')?.available({ sessionId: 'one' })).toBe(false)
  const pending = manager.hold('go')
  expect(registered.has('orchestra')).toBe(true)
  pending.commit(1)
  expect(registered.has('orchestra')).toBe(false)
  expect(manager.activate('orchestra', 0).available).toBe(false)
  expect(registered.has('go')).toBe(true)
  expect(() => commands.register({ name: 'go', available: () => true, ui: { kind: 'action', run() {} } })).toThrow('duplicate')
  const canceled = manager.hold('later')
  canceled.release()
  expect(registered.has('later')).toBe(false)
  manager.dispose(); pending.release(); pending.release()
  expect([...registered.keys()]).toEqual(['model'])
  removeOther()
})
