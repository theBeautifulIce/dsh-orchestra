import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { caseG04S6 } from '../../scripts/fault-executor.ts'
import { writeFaultReport } from '../../scripts/fault-report.ts'

const temporaryRoots: string[] = []

function temporaryRoot() {
  const directory = mkdtempSync(join(tmpdir(), 's6-g04-passive-'))
  temporaryRoots.push(directory)
  return directory
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('G-04 offline ledger review', () => {
  it('publishes a failed report when the capture input is unset', async () => {
    vi.stubEnv('S6_G04_EVIDENCE_DIR', undefined)
    vi.stubEnv('S6_G04_PROVENANCE_SHA256', undefined)
    const out = temporaryRoot()
    const report = await writeFaultReport('G-04', out, [], caseG04S6)
    expect(report).toMatchObject({
      passed: false, boundary: { reached: false }, artifacts: {},
      failures: expect.arrayContaining([
        'G-04 evidence rejected: offline evidence directory and pinned provenance SHA-256 are required',
      ]),
    })
    expect(JSON.parse(readFileSync(join(out, 'G6', 'G-04', 'report.json'), 'utf8'))).toEqual(report)
  })

  it('refuses a legacy report without original capture provenance', async () => {
    const source = temporaryRoot()
    const legacy = new URL('../../docs/gates/evidence/G2/G-04.md', import.meta.url)
    copyFileSync(legacy, join(source, 'G-04.md'))
    vi.stubEnv('S6_G04_EVIDENCE_DIR', source)
    vi.stubEnv('S6_G04_PROVENANCE_SHA256', '0'.repeat(64))
    const report = await writeFaultReport('G-04', temporaryRoot(), [], caseG04S6)
    expect(report).toMatchObject({ passed: false, boundary: { reached: false }, artifacts: {} })
    expect(report.failures[0]).toContain('provenance.json')
    expect(readFileSync(join(source, 'G-04.md'))).toEqual(readFileSync(legacy))
  })

  it('refuses an original provenance file that differs from the handoff digest', async () => {
    const source = temporaryRoot()
    const legacy = new URL('../../docs/gates/evidence/G2/G-04.md', import.meta.url)
    copyFileSync(legacy, join(source, 'provenance.json'))
    vi.stubEnv('S6_G04_EVIDENCE_DIR', source)
    vi.stubEnv('S6_G04_PROVENANCE_SHA256', '0'.repeat(64))
    const report = await writeFaultReport('G-04', temporaryRoot(), [], caseG04S6)
    expect(report).toMatchObject({ passed: false, boundary: { reached: false }, artifacts: {} })
    expect(report.failures[0]).toBe('G-04 evidence rejected: original hash mismatch for provenance.json')
    expect(readFileSync(join(source, 'provenance.json'))).toEqual(readFileSync(legacy))
  })
})
