import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { caseG05S6, caseG06S6 } from '../../scripts/fault-cancel-receipts.ts'
import { reconcileFaultObservation } from '../../scripts/fault-report.ts'

it.each([
  ['G-05', caseG05S6, ['confirmed_fence_after_grace', 'refused_terminal_after_stop', 'unanswered_late_rejected']],
  ['G-06', caseG06S6, ['pure_completed_outbox', 'independent_host_commit', 'observed_uncertainty',
    'evidence_scope', 'rejected_no_resolutions', 'settled_run_event', 'settled_unverified']],
] as const)('%s reconciles cancellation and receipt recovery', async (_name, run, queries) => {
  const directory = mkdtempSync(join(tmpdir(), 'orch-s6-cancel-receipts-'))
  try {
    const observation = await run({ directory })
    const result = reconcileFaultObservation(directory, observation)
    expect(result.failures).toEqual([])
    expect(result.passed).toBe(true)
    for (const name of queries) expect(result.extraQueries[name]?.passed, name).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
