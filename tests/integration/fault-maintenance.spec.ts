import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { runFaultCase } from '../../scripts/fault-inject.ts'
import { executeFaultQuery } from '../../scripts/fault-reconcile.ts'

it.each(['G-14','G-15','G-16'])('%s retains and independently replays migration, backup or cancellation receipts', async (id) => {
  const out = mkdtempSync(join(tmpdir(), 's6-maintenance-'))
  try {
    const report = await runFaultCase(id, { out, argv: ['--s6','--case',id] })
    expect(report.failures).toEqual([])
    expect(report.passed).toBe(true)
    const directory = join(out, 'G6', id)
    for (const query of Object.values(report.reconcile)) {
      expect(query).toBeTruthy()
      expect(executeFaultQuery(directory, query!)).toEqual(query)
    }
    if (id === 'G-16') {
      expect(report.extra.checks.clean_parent_outcome).toMatchObject({ actual: ['succeeded', []], passed: true })
      expect(report.extra.checks.unverified_parent_outcome?.actual).toEqual(['succeeded_with_unverified', [expect.any(String)]])
      expect(report.extra.checks.failed_child_outcome?.actual).toEqual(['failed_with_unverified', [expect.any(String)]])
    }
  } finally { rmSync(out, { recursive: true, force: true }) }
}, 30_000)
