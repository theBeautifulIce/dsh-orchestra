import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { caseG13S6, readG13Archive } from '../../scripts/fault-upgrade.ts'
import { reconcileFaultObservation } from '../../scripts/fault-report.ts'

it('rejects rehearsal evidence outside the isolated tmp tree', () => {
  expect(() => readG13Archive('package.json')).toThrow(/real workspace tmp/)
})

const archive = process.env.ORCHESTRA_G13_ARCHIVED_PLAN
const requested = archive !== undefined && existsSync(archive)
it.skipIf(!requested)('recomputes the pinned two-package archive and refuses unsafe rollback through the live driver', async () => {
  const directory = mkdtempSync(join(resolve('tmp'), 'g13-test-'))
  try {
    const observation = await caseG13S6({ directory })
    const report = reconcileFaultObservation(directory, observation)
    expect(report.failures).toEqual([])
    expect(report.passed).toBe(true)
    const sidecar = readG13Archive(archive!).modelSettingsSidecar
    expect(observation.params?.rollback_window_blocker).toBe(sidecar ? 'candidate_plans' : 'candidate_routing')
    if (sidecar) {
      expect(report.extraQueries.old_readable_model_settings?.actualCount).toBe(1)
      expect(report.extraQueries.candidate_plan_preserved?.actualCount).toBe(1)
    } else {
      expect(report.extraQueries.candidate_only_data_preserved?.actualCount).toBe(1)
    }
    expect(report.extraQueries.rejected_intake_has_no_run?.actualCount).toBe(0)
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 90_000)
