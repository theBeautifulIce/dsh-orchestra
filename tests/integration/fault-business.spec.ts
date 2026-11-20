import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { caseG10S6, caseG11S6, caseG12S6 } from '../../scripts/fault-business.ts'
import { reconcileFaultObservation } from '../../scripts/fault-report.ts'

it.each([
  ['G-10', caseG10S6, ['old_run_v1_dispatch', 'new_run_v2_dispatch', 'terminal_events']],
  ['G-11', caseG11S6, ['committed_breakpoint_writer_rows', 'rolled_back_breakpoint_writer_rows',
    'partial_breakpoint_writer_rows', 'partial_ack_decisions', 'partial_still_unverified', 'retry_generation']],
  ['G-12', caseG12S6, ['resolved_events', 'applied_receipts', 'rolled_back_receipts', 'preflight_receipts']],
] as const)('%s retains checkpoints that reconcile workflow and approval state', async (_name, fault, expectedQueries) => {
  const directory = mkdtempSync(join(tmpdir(), 'orch-s6-fault-business-'))
  try {
    const observation = await fault({ directory })
    const result = reconcileFaultObservation(directory, observation)
    expect(result.failures).toEqual([])
    expect(result.passed).toBe(true)
    for (const query of expectedQueries) expect(result.extraQueries[query]?.passed, query).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 45_000)
