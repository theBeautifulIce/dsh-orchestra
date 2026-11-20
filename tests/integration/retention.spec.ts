import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sha256Hex } from '../../src/core/canonical.ts'
import { ScriptedClock } from '../../src/core/clock.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { openServiceOrchestra, registerRunArtifact } from '../../src/index.ts'
import { createLogger } from '../../src/infra/logger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { getArtifactContent, listRunArtifacts } from '../../src/service/queries/artifacts.ts'
import { getOperationSnapshot } from '../../src/service/queries/get_operation.ts'
import { sweep } from '../../src/service/sweep.ts'
import { seed, TEST_SECRET } from '../fixtures/ledger.ts'

const DAY = 86_400_000
const MINUTE = 60_000
const START = Date.parse('2026-11-18T01:00:00.000Z')
const time = (ms: number) => new Date(ms).toISOString()

it.each([[7, 10], [2, 3]])('uses %i receipt days and %i in-flight minutes in production read, replay and sweep', async (days, minutes) => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-retention-'))
  const configPath = join(dir, 'config.json')
  const config = JSON.parse(readFileSync(new URL('../../orchestra.config.json', import.meta.url), 'utf8'))
  writeFileSync(configPath, JSON.stringify({ ...config, retention: { receipt_days: days, in_flight_timeout_minutes: minutes } }))
  const service = await openServiceOrchestra({ dbFile: join(dir, 'ledger.db'), secret: TEST_SECRET, phase: 'S6', configPath })
  try {
    const db = service.orchestra.db
    seed(db)
    const archived = { task_id: 't1', archived: true, expected_archived_at: null, operation_id: uuidv7() }
    const archive = (when: number) => service.orchestra.commands.setTaskArchive!(archived, 'human:owner', time(when))
    expect(archive(START)).toMatchObject({ archived_at: time(START) })
    const baseline = () => db.raw.prepare('SELECT MAX(seq) AS seq, COUNT(*) AS count FROM events').get()
    const initial = baseline()
    const receiptBoundary = START + days * DAY
    expect(archive(receiptBoundary - 1)).toMatchObject({ archived_at: time(START) })
    expect(getOperationSnapshot(db, archived.operation_id, receiptBoundary - 1).item).toMatchObject({ status: 'applied' })
    expect(() => archive(receiptBoundary)).toThrow(expect.objectContaining({ code: 'OPERATION_EXPIRED' }))
    expect(() => getOperationSnapshot(db, archived.operation_id, receiptBoundary)).toThrow(expect.objectContaining({ code: 'OPERATION_EXPIRED' }))
    expect(baseline()).toEqual(initial)

    const pending = uuidv7()
    withTx(db, tx => tx.run("INSERT INTO inbox (kind, operation_id, request_hash, status, created_at) VALUES ('task.archive', ?, 'h', 'running', ?)",
      [pending, time(START)]))
    const flightBoundary = START + minutes * MINUTE
    const clock = new ScriptedClock('retention-fixture', { wallClockMs: START, monotonicNs: 0 })
    const scan = (at: number) => sweep(db, TEST_SECRET, { now: time(at), clock })
    expect(getOperationSnapshot(db, pending, flightBoundary - 1).item).toMatchObject({ status: 'running' })
    expect(scan(flightBoundary - 1).operations_timed_out).toBe(0)
    expect(scan(flightBoundary).operations_timed_out).toBe(1)
    expect(getOperationSnapshot(db, pending, flightBoundary).item).toMatchObject({
      status: 'rejected', receipt_json: expect.stringContaining('OPERATION_TIMEOUT'),
    })
    expect(scan(receiptBoundary - 1).receipts_expired).toBe(0)
    expect(scan(receiptBoundary).receipts_expired).toBe(1)
    expect(scan(receiptBoundary).receipts_expired).toBe(0)
    expect(db.raw.prepare('SELECT status, receipt_json FROM inbox WHERE operation_id=?').get(archived.operation_id))
      .toMatchObject({ status: 'applied', receipt_json: null })
    expect(db.raw.prepare("SELECT archived_at FROM tasks WHERE task_id='t1'").get()).toMatchObject({ archived_at: time(START) })
    expect(baseline()).toEqual(initial)
  } finally { await service.release(); rmSync(dir, { recursive: true, force: true }) }
})

it('expires access at the exact artifact deadline while preserving rows, bytes and immutable ledger references', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-artifact-deadline-'))
  const service = await openServiceOrchestra({ dbFile: join(dir, 'ledger.db'), secret: TEST_SECRET, phase: 'S6' })
  try {
    const db = service.orchestra.db
    seed(db)
    const bytes = Buffer.from('independently retained synthetic bytes')
    const deadline = START + MINUTE
    const source = registerRunArtifact(db, { artifactId: 'source.txt', runId: 'r1', nodeRunId: 'nr1',
      fileName: 'source.txt', bytes, retainUntil: time(deadline) })
    const proof = () => db.raw.prepare('SELECT (SELECT COUNT(*) FROM artifacts) AS artifacts,'
      + ' (SELECT COUNT(*) FROM artifact_contents) AS contents, (SELECT COUNT(*) FROM events) AS events,'
      + ' (SELECT COUNT(*) FROM node_run_events) AS chained').get()
    const initial = proof()
    expect(getArtifactContent(db, 'r1', source.artifact_id, 'preview', deadline - 1).item)
      .toMatchObject({ text: bytes.toString(), sha256: sha256Hex(bytes) })
    for (const now of [deadline, deadline + 1]) {
      expect(listRunArtifacts(db, 'r1', now).items).toEqual([expect.objectContaining({ expired: true,
        artifact_id: source.artifact_id, sha256: sha256Hex(bytes), source_node_run_id: 'nr1' })])
      expect(() => getArtifactContent(db, 'r1', source.artifact_id, 'download', now)).toThrow(expect.objectContaining({ code: 'OPERATION_EXPIRED' }))
    }
    const clock = new ScriptedClock('retained', { wallClockMs: deadline, monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: time(deadline + 9 * DAY), clock })
    expect(proof()).toEqual(initial)
    const original = db.raw.prepare('SELECT bytes FROM artifact_contents WHERE artifact_id = ?').get(source.artifact_id)?.bytes
    expect(Buffer.from(original as Uint8Array)).toEqual(bytes)
    withTx(db, tx => tx.run("UPDATE artifacts SET retain_until='invalid historical timestamp' WHERE artifact_id=?", [source.artifact_id]))
    expect(() => getArtifactContent(db, 'r1', source.artifact_id, 'preview', deadline - 1))
      .toThrow(expect.objectContaining({ code: 'EVIDENCE_SOURCE_UNAVAILABLE' }))
  } finally { await service.release(); rmSync(dir, { recursive: true, force: true }) }
})

it('projects fixed logger messages, counters and codes while suppressing original error and nested field content', () => {
  const lines: string[] = []
  const logger = createLogger({ write: line => lines.push(line) })
  const hidden = {
    Access_Token: 'sensitive-token-fixture', apiKey: 'sensitive-key-fixture',
    details: { Raw_Payload: 'sensitive-payload-fixture', ExecutorTranscript: 'sensitive-transcript-fixture' },
    err: new Error('sensitive-exception-fixture'), path: 'sensitive-path-fixture',
    label: 'sensitive-label-fixture', msg: 'sensitive-override-fixture',
  }
  logger.warn('写队列满了，拒掉这一笔写', { ...hidden, max: 1000, pending: 1000 })
  logger.error('arbitrary exception sensitive-text-fixture', { ...hidden, code: 'INTERNAL_ERROR' })
  const [warn, error] = lines.map(line => JSON.parse(line))
  expect(warn).toMatchObject({ level: 'warn', msg: '写队列满了，拒掉这一笔写', max: 1000, pending: 1000, label_sha256: sha256Hex(hidden.label) })
  expect(error).toMatchObject({ level: 'error', msg: '服务日志', code: 'INTERNAL_ERROR' })
  expect(lines.join('')).not.toContain('sensitive-')
})
