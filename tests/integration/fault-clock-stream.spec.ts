import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { caseG07S6, caseG08S6 } from '../../scripts/fault-clock-stream.ts'
import { streamResumeCase } from '../../scripts/fault-sse-resume.ts'
import { reconcileFaultObservation, type FaultCase } from '../../scripts/fault-report.ts'

async function runCase(scenario: FaultCase) {
  const directory = mkdtempSync(join(tmpdir(), 'orchestra-s6-t04-'))
  try {
    const observation = await scenario({ directory })
    return { observation, result: reconcileFaultObservation(directory, observation) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

it('G-07 scans real wait deadlines through two wall shifts, two reopens and a missing checkpoint', async () => {
  const { observation, result } = await runCase(caseG07S6)
  expect(result.failures).toEqual([])
  expect(observation.boundary.reached).toBe(true)
  expect(result.extraQueries.boundary_terminal?.actualCount).toBe(4)
  expect(result.extraQueries.restored_terminal?.actualCount).toBe(3)
  expect(result.extraQueries.legacy_uncertain?.actualCount).toBe(1)
  expect(result.extraQueries.trusted_reanchors?.actualCount).toBe(2)
}, 15_000)

it('G-08 applies real default queue and SQLite backpressure while all four HTTP reads stay available', async () => {
  const { observation, result } = await runCase(caseG08S6)
  expect(result.failures).toEqual([])
  expect(observation.snapshots.breakpoint?.pending).toBe(1000)
  expect(result.extraQueries.scheduled_rows_at_lock?.actualCount).toBe(0)
  expect(result.extraQueries.scheduled_rows_after?.actualCount).toBe(1001)
}, 60_000)

it('G-09 quickly reproduces SSE disconnect, duplicate, gap, paged recovery and second resume', async () => {
  const { observation, result } = await runCase(streamResumeCase(false))
  expect(result.failures).toEqual(['real_ten_minute_disconnect: observed value differed from the expected value'])
  expect(observation.boundary.reached).toBe(true)
  expect(result.checks.consumed_once_in_order?.actual).toEqual({ missing: 0, duplicate: 0, outOfOrder: 0 })
  expect(result.extraQueries.offline_receipts?.actualCount).toBe(425)
  expect(result.extraQueries.replay_page_3?.actualCount).toBe(25)
}, 30_000)
