import { rmSync } from 'node:fs'
import { expect, it } from 'vitest'
import { uuidv7 } from '../../src/core/ids.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { startRun } from '../../src/service/commands/start-run.ts'
import { createRunNotes, type RunNoteBinding } from '../../src/service/run-notes.ts'
import { serveOrchestra } from '../../src/index.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import { countOf, freshLedger } from '../fixtures/ledger.ts'

const secret = 'run-notes-contract'
const author = 'human:private-onboarding-identity'
const intruder = 'human:unrelated'
const now = '2026-11-21T00:00:00.000Z'
const workflowId = 'notes_fixture'

function fixtureRun(db: Db) {
  const operationId = uuidv7()
  const catalog = new WorkflowCatalog('S6', db)
  catalog.load({ workflow_id: workflowId, workflow_version: '1',
    nodes: ['source', 'direct', 'sibling', 'indirect'].map(node_id => ({ node_id, type: 'agent', side_effect_policy: 'pure' })),
    edges: [{ from: 'source', to: 'direct' }, { from: 'direct', to: 'indirect' }],
  })
  const run = startRun(db, catalog, { workflowId, workflowVersion: '1', taskTitle: 'Note scope', startedBy: author, operationId, now })
  function bind(node: string, expiry = '2026-11-21T01:00:00.000Z'): RunNoteBinding {
    const row = db.raw.prepare('SELECT node_run_id,attempt,action_generation FROM node_runs WHERE run_id=? AND node_id=?')
      .get(run.run_id, node)!
    const executor_session_id = 'native:' + row.node_run_id
    db.raw.prepare("UPDATE node_runs SET status='started',executor_session_id=?,lease_expires_at=? WHERE node_run_id=?")
      .run(executor_session_id, expiry, String(row.node_run_id))
    return { node_run_id: String(row.node_run_id), attempt: Number(row.attempt),
      action_generation: Number(row.action_generation), executor_session_id }
  }
  function attachChatReceipt() {
    const plan = 'fixture:' + operationId
    db.raw.prepare("INSERT INTO task_plans(plan_id,created_by,input_json,proposal_json,quality_json,workflow_hash,content_hash,launch_operation_id,created_at) VALUES (?,?,'{}','{}','{}',NULL,?,?,?)")
      .run(plan, author, 'fixture', operationId, now)
    db.raw.prepare('INSERT INTO chat_task_receipts(message_key,request_key,input_hash,plan_id) VALUES (?,?,?,?)')
      .run('message:' + plan, 'request:' + plan, 'fixture', plan)
  }
  return { run: run.run_id, bind, attachChatReceipt }
}

it('requires a signed current writer and rechecks private notes after model I/O', async () => {
  const { db, dir } = freshLedger()
  try {
    const first = fixtureRun(db)
    const unrelated = fixtureRun(db)
    const source = first.bind('source', new Date(Date.now() + 60_000).toISOString())
    const notes = createRunNotes(db, secret)
    let captureCalls = 0
    let reviewCalls = 0
    const canary = 'wf23-private-contract-fixture'
    const capture = async () => { captureCalls++; return canary }
    const review = async (body: readonly string[]) => { reviewCalls++; expect(body).toEqual([canary]); return 'follow_up' }
    const current = () => {}
    await expect(notes.captureBrain(source, 'unsigned', current, capture)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(captureCalls).toBe(0)
    withTx(db, (tx) => appendNodeRunEvent(tx, secret, source.node_run_id, 'executor.model_confirmed', {
      state: 'confirmed', attempt: source.attempt, action_generation: source.action_generation,
    }))
    await expect(notes.captureBrain({ ...source, executor_session_id: 'sibling' }, 'invalid', current, capture))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    const before = countOf(db, 'events')
    db.raw.exec("CREATE TEMP TRIGGER note_failure BEFORE INSERT ON run_note_bodies BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END")
    await expect(notes.captureBrain(source, 'rollback', current, capture)).rejects.toThrow('fixture rollback')
    db.raw.exec('DROP TRIGGER note_failure')
    expect(countOf(db, 'events')).toBe(before)
    await expect(notes.captureBrain(source, 'oversize', current, async () => '😀'.repeat(501))).rejects.toMatchObject({ code: 'PAYLOAD_SCHEMA_INVALID' })
    await expect(notes.captureBrain(source, 'empty', current, async () => null)).resolves.toEqual({ captured: false })
    for (let i = 0; i < 5; i++) await notes.captureBrain(source, 'older-' + i, current, async () => 'older ' + i)
    const result = await notes.captureBrain(source, 'approved', current, capture)
    expect(result).toMatchObject({ captured: true, note_id: expect.any(String) })
    const captured = captureCalls
    await expect(notes.captureBrain(source, 'approved', current, capture)).resolves.toEqual(result)
    expect(captureCalls).toBe(captured)
    expect(countOf(db, 'run_note_bodies')).toBe(5)
    expect(notes.listHuman(first.run, author).items).toEqual([])
    await expect(notes.reviewBrain(first.run, author, current, review)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    first.attachChatReceipt()
    unrelated.attachChatReceipt()
    await expect(notes.reviewBrain(first.run, intruder, current, review)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(notes.reviewBrain(unrelated.run, author, current, review)).resolves.toEqual({ classification: 'insufficient', evidence_strength: 'none' })
    expect(reviewCalls).toBe(0)
    db.raw.prepare('UPDATE run_note_bodies SET body=? WHERE body<>?').run('forged raw value', canary)
    const expected = { classification: 'follow_up', evidence_strength: 'none' }
    await expect(notes.reviewBrain(first.run, author, current, review)).resolves.toEqual(expected)
    await expect(notes.reviewBrain(first.run, author, current, async () => canary)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    let live = true
    const assertCurrent = () => { if (!live) throw new Error('view is stale') }
    await expect(notes.captureBrain(source, 'stale-view', assertCurrent, async () => { live = false; return canary })).rejects.toThrow('view is stale')
    expect(countOf(db, 'run_note_bodies')).toBe(5)
    await expect(notes.reviewBrain(first.run, author, current, async () => {
      db.raw.prepare('UPDATE node_runs SET action_generation=action_generation+1 WHERE node_run_id=?').run(source.node_run_id)
      return 'follow_up'
    })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await expect(notes.captureBrain(source, 'stale-attempt', current, capture)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(notes.reviewBrain(first.run, author, current, review)).resolves.toEqual({ classification: 'insufficient', evidence_strength: 'none' })
    expect(reviewCalls).toBe(1)
  } finally { db.raw.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('keeps private notes out of ordinary reads while enforcing run, attempt, topology and creator receipt', () => {
  const { db, dir } = freshLedger()
  try {
    const first = fixtureRun(db)
    const other = fixtureRun(db)
    const a = first.bind('source')
    const b = first.bind('direct')
    const sibling = first.bind('sibling')
    const indirect = first.bind('indirect')
    const crossRun = other.bind('direct')
    const notes = createRunNotes(db, secret)
    const proofCounts = () => ['artifacts', 'tool_executions', 'node_run_events'].map(t => countOf(db, t))
    const beforeProof = proofCounts()
    const statuses = () => db.raw.prepare('SELECT node_run_id,status,revision FROM node_runs ORDER BY node_run_id').all()
    const beforeStatuses = statuses()
    notes.callNode(a, { action: 'add', scope: 'run', body: 'public-reference' }, 'run', now)
    notes.callNode(a, { action: 'add', scope: 'downstream', body: 'private-direct-reference' }, 'downstream', now)
    expect(() => notes.callNode(a, { action: 'add', scope: 'brain', body: 'private-brain-reference' }, 'brain', now))
      .toThrow(expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }))
    db.raw.prepare("UPDATE node_runs SET status='done' WHERE node_run_id=?").run(a.node_run_id)
    const beforeReads = statuses()
    const human = notes.addHuman({ run_id: first.run, body: 'human-reference', operation_id: uuidv7() }, author)
    expect(notes.listHuman(first.run, author).items).toMatchObject([{ note_id: human.note_id,
      source: 'human', scope: 'run', author, evidence_strength: 'none' }, { body: 'public-reference' }])
    expect(() => notes.listHuman(first.run, intruder)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    const bodies = (binding: RunNoteBinding) => {
      const out = notes.callNode(binding, { action: 'list' }, 'unused', now)
      expect(out).toHaveProperty('items')
      return 'items' in out ? out.items.map(({ body }) => body) : []
    }
    expect(bodies(b)).toEqual(['human-reference', 'private-direct-reference', 'public-reference'])
    expect(bodies(sibling)).toEqual(['human-reference', 'public-reference'])
    expect(bodies(indirect)).toEqual(['human-reference', 'public-reference'])
    expect(bodies(crossRun)).toEqual([])
    expect(() => notes.listChatShared(first.run, author)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    first.attachChatReceipt()
    expect(notes.listChatShared(first.run, author).items.map(({ body }) => body))
      .toEqual(['human-reference', 'public-reference'])
    expect(() => notes.listChatShared(first.run, intruder)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => notes.listChatShared(other.run, author)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    const publicEvents = JSON.stringify(db.raw.prepare("SELECT * FROM events WHERE type LIKE 'run.note_%'").all())
    for (const value of [author, 'private-direct-reference', 'private-brain-reference', 'human-reference', 'public-reference']) {
      expect(publicEvents).not.toContain(value)
    }
    expect(proofCounts()).toEqual(beforeProof)
    expect(statuses()).toEqual(beforeReads)
    expect(() => notes.callNode({ ...b, executor_session_id: 'forged' }, { action: 'list' }, 'unused', now))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => notes.callNode(b, { action: 'list' }, 'unused', '2026-11-21T01:00:00.000Z'))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    db.raw.prepare("UPDATE node_runs SET status='superseded',action_generation=action_generation+1 WHERE node_run_id=?").run(a.node_run_id)
    expect(() => notes.callNode(a, { action: 'add', scope: 'run', body: 'forged' }, 'old', now))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(bodies(b)).toEqual(['human-reference', 'public-reference'])
  } finally { db.raw.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('atomically bounds concurrent writes, evicts oldest private bodies and survives a reopen', async () => {
  const { db, dir, file } = freshLedger()
  db.raw.close()
  const start = () => serveOrchestra({
    dbFile: file, phase: 'S6', secret,
    asOfSeq: () => 0, listEvents: () => [], listTasks: () => [],
    appendLedgerEvent: () => { throw new Error('generic append should be rejected') },
    resolveHttpHuman: (req) => {
      if (req.headers.authorization === 'Bearer fixture-owner') return { id: author }
      if (req.headers.authorization === 'Bearer fixture-other') return { id: intruder }
      return null
    },
  })
  let service: Awaited<ReturnType<typeof start>> | undefined
  try {
    service = await start()
    const ledger = service.orchestra.db
    const fixture = fixtureRun(ledger)
    const source = fixture.bind('source')
    const notes = service.runNotes!
    function nodeAdd(body: string, op: string) {
      return notes.callNode(source, { action: 'add', scope: 'run', body }, op, now)
    }
    const first = nodeAdd('😀'.repeat(500), 'first')
    if (!('note_id' in first)) throw new Error('missing create receipt')
    expect(nodeAdd('😀'.repeat(500), 'first')).toEqual(first)
    expect(() => nodeAdd('long' + '😀'.repeat(500), 'overflow')).toThrow(expect.objectContaining({ code: 'PAYLOAD_SCHEMA_INVALID' }))
    expect(() => nodeAdd('different', 'first')).toThrow(expect.objectContaining({ code: 'OPERATION_ID_CONFLICT' }))
    for (let i = 0; i < 5; i++) nodeAdd('node ' + i, 'cursor-' + i)
    expect(notes.listHuman(fixture.run, author).items.map(({ body }) => body)).toEqual(['node 4', 'node 3', 'node 2', 'node 1', 'node 0'])

    const endpoint = service.endpoint
    const url = endpoint + '/v1/run-notes'
    const headers = { 'x-orchestra-secret': secret, authorization: 'Bearer fixture-owner', 'content-type': 'application/json' }
    const post = (input: unknown) => fetch(url, { method: 'POST', headers, body: JSON.stringify(input) })
    const repeated = { run_id: fixture.run, operation_id: uuidv7(), body: 'concurrent replay' }
    const replay = await Promise.all(Array.from({ length: 8 }, async () => {
      const res = await post(repeated)
      expect(res.status).toBe(200)
      return (await res.json()).data
    }))
    expect(new Set(replay.map(({ note_id }) => note_id)).size).toBe(1)
    for (let offset = 0; offset < 205; offset += 20) {
      await Promise.all(Array.from({ length: Math.min(20, 205 - offset) }, async (_, i) => {
        const res = await post({ run_id: fixture.run, operation_id: uuidv7(), body: 'writing concurrently ' + (offset + i) })
        expect(res.status).toBe(200)
        await res.json()
      }))
    }
    const eventResponse = await fetch(endpoint + '/v1/events?limit=200', { headers: { 'x-orchestra-secret': secret } })
    expect(eventResponse.status).toBe(200)
    const publicEvents = (await eventResponse.json()).data.items.filter(({type}: {type: string}) => type === 'run.note_created')
    expect(publicEvents.length).toBeGreaterThan(0)
    const publicJson = JSON.stringify(publicEvents)
    for (const text of [author, 'concurrent replay', 'writing concurrently ', 'node 0']) expect(publicJson).not.toContain(text)
    const publicNote = JSON.parse(publicEvents[0].payload_redacted)
    expect(publicNote).toMatchObject({ body_digest: expect.stringMatching(/^[a-f\d]{64}$/), evidence_strength: 'none' })
    expect(publicNote).not.toHaveProperty('body')
    expect(publicNote).not.toHaveProperty('author')
    const list = () => fetch(url + '?run_id=' + fixture.run, { headers })
    const snapshot = (await (await list()).json()).data.items
    expect(snapshot).toHaveLength(200)
    expect(snapshot.every(({ body }: { body: string }) => body.startsWith('writing concurrently '))).toBe(true)
    expect(countOf(ledger, 'run_note_bodies')).toBe(200)
    expect(ledger.raw.prepare("SELECT json_extract(payload_redacted,'$.reason') reason,count(*) AS n FROM events WHERE type='run.note_evicted' GROUP BY reason ORDER BY reason").all())
      .toEqual([{ reason: 'node_quota', n: 1 }, { reason: 'run_quota', n: 11 }])
    expect((await fetch(url + '?run_id=' + fixture.run, { headers: { ...headers, authorization: 'Bearer fixture-other' } })).status).toBe(403)
    expect((await fetch(endpoint + '/v1/ledger/events', { method: 'POST', headers,
      body: JSON.stringify({ type: 'run.note_evicted', idempotencyKey: 'run-note-evict:' + first.note_id }) })).status).toBe(403)
    await service.close()
    service = undefined
    const reopened = openDb(file)
    try { expect(createRunNotes(reopened, secret).listHuman(fixture.run, author).items).toEqual(snapshot) }
    finally { reopened.raw.close() }
  } finally { await service?.close(); rmSync(dir, { recursive: true, force: true }) }
}, 30_000)
