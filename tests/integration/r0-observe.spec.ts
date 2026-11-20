import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { verifyR0Observation } from '../../scripts/r0-observe.ts'

const command = (args: string[]) => execFileSync(process.execPath, ['--no-warnings', 'scripts/r0-observe.ts', ...args], { encoding: 'utf8' })
const status = (directory: string) => JSON.parse(command(['status', directory])) as { status: string; pid?: number; error?: string }
async function waitStatus(directory: string, expected: string) {
  for (let attempts = 0; attempts < 80; attempts++) {
    const result = status(directory)
    if (result.status === expected) return result
    if (['failed', 'interrupted', 'complete'].includes(result.status)) throw new Error(JSON.stringify(result))
    await sleep(100)
  }
  throw new Error('R0 status timeout: ' + directory + ' → ' + expected)
}

it('短窗走真实 R0 入口并能复算，篡改原件使核验失败', async () => {
  mkdirSync(resolve('tmp'), { recursive: true })
  const parent = mkdtempSync(resolve('tmp', 'r0-short-'))
  const directory = join(parent, 'worker')
  try {
    const launch = JSON.parse(command(['short', directory, '1500', '2']))
    expect(launch.pid).toBeGreaterThan(0)
    expect((await waitStatus(directory, 'observing')).pid).toBe(launch.pid)
    await waitStatus(directory, 'complete')
    const result = verifyR0Observation(directory)
    expect(result).toMatchObject({ pid: launch.pid, circle: 'R0', conclusion: 'development_short_observation',
      sampled_runs: 2, human_assessment_required: true })
    expect(result.wall_ms).toBeGreaterThanOrEqual(3000)
    expect(result.final_head).toBeGreaterThan(result.initial_head)
    expect(() => verifyR0Observation(directory, { candidate: result.candidate, archiveSha256: 'a'.repeat(64) })).toThrow(/frozen candidate/)
    appendFileSync(join(directory, 'samples.ndjson'), '{}\n')
    expect(() => verifyR0Observation(directory)).toThrow(/original changed/)
  } finally { rmSync(parent, { recursive: true, force: true }) }
}, 20_000)

it.each(['interrupted', 'failed'])('短窗停止为 %s，禁止补写连续观察', async (outcome) => {
  mkdirSync(resolve('tmp'), { recursive: true })
  const parent = mkdtempSync(resolve('tmp', 'r0-negative-'))
  const directory = join(parent, 'worker')
  try {
    command(['short', directory, '3000', '2'])
    await waitStatus(directory, 'observing')
    if (outcome === 'interrupted') command(['cancel', directory])
    else {
      const fixture = join(directory, 'workspace', 'sample.txt')
      chmodSync(fixture, 0o600)
      writeFileSync(fixture, 'deliberately damaged synthetic fixture\n')
    }
    const finished = await waitStatus(directory, outcome)
    expect(finished.error).toMatch(outcome === 'interrupted' ? /interrupted/ : /Synthetic node did not settle|R0 sample/)
    expect(() => verifyR0Observation(directory)).toThrow()
    expect(() => command(['short', directory, '3000', '2'])).toThrow(/already exists/)
  } finally { rmSync(parent, { recursive: true, force: true }) }
}, 20_000)
