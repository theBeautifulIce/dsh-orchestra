import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { openDb } from '../../src/infra/sqlite/driver.ts'
import { createNativeChatRoutingSettings } from '../../src/service/native-chat-routing-settings.ts'
import { createSemanticDraftCheckpoints, DRAFT_KEY_PREFIX } from '../../src/service/semantic-draft-checkpoints.ts'
import { createSemanticSession, type SemanticInput, type SemanticLaunchOrigin } from '../../src/service/semantic-admission.ts'

const source = '请整理月报，禁止联网，先别执行'
function request(text: string, id: string, identity = 'workspace/session', launchOrigin?: SemanticLaunchOrigin): {
  identity: string; requestId: string; hash: string; input: Omit<SemanticInput, 'draft'>; launchOrigin?: SemanticLaunchOrigin;
  signal: AbortSignal; assertCurrent(): void
} {
  return { identity, requestId: id, hash: id, input: { current: { message_id: id, text }, explicit: true },
    ...(launchOrigin && { launchOrigin }),
    signal: new AbortController().signal, assertCurrent() {} }
}
function held(input: SemanticInput) {
  return { kind: 'task', relation: input.draft ? 'continue' : 'new', timing: 'held', quote: input.current.text,
    constraints: input.draft?.constraints ?? [{ id: 'offline', kind: 'no_network', source_message_id: input.current.message_id, quote: '禁止联网' }],
    missing: [], ...(input.draft && { draft_revision: input.draft.revision, continuation: 'supply' }) }
}

async function profileFixture() {
  const profile = await mkdtemp(join(tmpdir(), 'orchestra-held-checkpoint-'))
  const settings = createNativeChatRoutingSettings(profile)
  settings.save({ enabled: true, expected_revision: 0 })
  const checkpoints = createSemanticDraftCheckpoints(profile, async identity => 'synthetic-key:' + identity)
  return { profile, settings, checkpoints }
}

it('rehydrates a signed held draft in a fresh session, requires explicit resume, then removes the checkpoint', async () => {
  const fixture = await profileFixture()
  try {
    const firstSession = createSemanticSession(fixture.checkpoints)
    const admitted = await firstSession.admit(request(source, 'first'), async input => held(input))
    expect(admitted).toMatchObject({ kind: 'held', draft: { timing: 'held', constraints: [{ kind: 'no_network' }] } })
    firstSession.reset()

    const afterRestart = createSemanticSession(fixture.checkpoints)
    const resumed = await afterRestart.admit(request('继续月报', 'resume'), async input => {
      expect(input.draft).toMatchObject({ timing: 'held', sources: [{ message_id: 'first', text: source }],
        constraints: [{ kind: 'no_network', quote: '禁止联网' }] })
      return { kind: 'task', relation: 'continue', timing: 'immediate', quote: '继续月报', constraints: [], missing: [],
        draft_revision: input.draft!.revision, continuation: 'resume' }
    })
    expect(resumed.kind).toBe('ready')
    afterRestart.reset()

    const fresh = createSemanticSession(fixture.checkpoints)
    const newTask = await fresh.admit(request('整理新周报', 'new'), async input => {
      expect(input.draft).toBeUndefined()
      return { kind: 'task', relation: 'new', timing: 'immediate', quote: input.current.text, constraints: [], missing: [] }
    })
    expect(newTask.kind).toBe('ready')
  } finally { await rm(fixture.profile, { recursive: true, force: true }) }
})

it('keeps the held request recoverable when resume planning fails, the agent exits, and a new session resumes it', async () => {
  const fixture = await profileFixture()
  const origin = { messageKey: 'a'.repeat(64), requestKey: 'b'.repeat(64), inputHash: 'c'.repeat(64) }
  try {
    const firstSession = createSemanticSession(fixture.checkpoints)
    await firstSession.admit(request(source, 'held'), async input => held(input))
    firstSession.reset()

    const resumedSession = createSemanticSession(fixture.checkpoints)
    const resumed = await resumedSession.admit(request('现在开始执行月报', 'resume', 'workspace/session', origin), async input => {
      expect(input.draft).toMatchObject({ timing: 'held', sources: [{ message_id: 'held', text: source }],
        constraints: [{ kind: 'no_network', quote: '禁止联网' }] })
      return { kind: 'task', relation: 'continue', timing: 'immediate', quote: input.current.text,
        constraints: input.draft!.constraints, missing: [], draft_revision: input.draft!.revision, continuation: 'resume' }
    })
    expect(resumed.kind).toBe('ready')
    // The host failed before accepting a run; production calls this when it retains the unstarted request.
    resumedSession.retainUnstarted('resume', 'resume')
    resumedSession.reset() // The agent exits before another human turn.

    const restarted = createSemanticSession(fixture.checkpoints)
    const afterExit = await restarted.admit({ ...request('请继续刚才的月报', 'after-exit'), hasPlan: async () => false }, async input => {
      expect(input.draft).toMatchObject({ timing: 'held', sources: [
        { message_id: 'held', text: source }, { message_id: 'resume', text: '现在开始执行月报' },
      ], constraints: [{ kind: 'no_network', quote: '禁止联网' }] })
      return { kind: 'task', relation: 'continue', timing: 'immediate', quote: input.current.text,
        constraints: input.draft!.constraints, missing: [], draft_revision: input.draft!.revision, continuation: 'resume' }
    })
    expect(afterExit).toMatchObject({ kind: 'ready', launchOrigin: origin })
  } finally { await rm(fixture.profile, { recursive: true, force: true }) }
})

it('does not cross scopes, expires old held drafts, and deletes checkpoints when automatic routing is disabled', async () => {
  vi.useFakeTimers()
  const fixture = await profileFixture()
  try {
    const one = createSemanticSession(fixture.checkpoints)
    await one.admit(request(source, 'one', 'workspace-one/session'), async input => held(input))

    const otherScope = createSemanticSession(fixture.checkpoints)
    await otherScope.admit(request('继续月报', 'other', 'workspace-two/session'), async input => {
      expect(input.draft).toBeUndefined()
      return { kind: 'conversation' }
    })
    otherScope.reset()

    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1)
    const expired = createSemanticSession(fixture.checkpoints)
    await expired.admit(request('继续月报', 'expired'), async input => {
      expect(input.draft).toBeUndefined()
      return { kind: 'conversation' }
    })

    const renewed = createSemanticSession(fixture.checkpoints)
    await renewed.admit(request('先别执行周报，禁止联网', 'renewed'), async input => held(input))
    await renewed.clear()
    const discarded = createSemanticSession(fixture.checkpoints)
    await discarded.admit(request('继续周报', 'discarded'), async input => {
      expect(input.draft).toBeUndefined()
      return { kind: 'conversation' }
    })

    const beforeDisable = createSemanticSession(fixture.checkpoints)
    await beforeDisable.admit(request('先别执行日报，禁止联网', 'before-disable'), async input => held(input))
    fixture.settings.save({ enabled: false, expected_revision: 0 })
    const disabled = createSemanticSession(fixture.checkpoints)
    await disabled.admit(request('继续周报', 'disabled'), async input => {
      expect(input.draft).toBeUndefined()
      return { kind: 'conversation' }
    })
  } finally { vi.useRealTimers(); await rm(fixture.profile, { recursive: true, force: true }) }
})

it('rejects a modified checkpoint signature without disclosing its synthetic key', async () => {
  const fixture = await profileFixture()
  const secret = 'synthetic-key:workspace/session'
  const file = join(fixture.profile, 'orchestra', 'chat-settings.sqlite')
  try {
    const session = createSemanticSession(fixture.checkpoints)
    await session.admit(request(source, 'tamper'), async input => held(input))
    session.reset()

    const db = openDb(file)
    try {
      withTx(db, tx => {
        const key = DRAFT_KEY_PREFIX + 'workspace/session'
        const row = tx.get<{ value: string }>('SELECT value FROM service_meta WHERE key=?', [key])!
        const payload = JSON.parse(row.value) as { draft: unknown; mac: string }
        payload.mac = '0'.repeat(payload.mac.length)
        tx.run('UPDATE service_meta SET value=? WHERE key=?', [JSON.stringify(payload), key])
      })
    } finally { db.raw.close() }

    const restarted = createSemanticSession(fixture.checkpoints)
    const error = await restarted.admit(request('继续月报', 'tamper-resume'), async () => ({ kind: 'conversation' }))
      .then(() => undefined, failure => failure as Error & { code?: string })
    expect(error).toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
    expect(error?.message).not.toContain(secret)
  } finally { await rm(fixture.profile, { recursive: true, force: true }) }
})
