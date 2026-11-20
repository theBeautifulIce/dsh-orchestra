import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { canonicalJson } from '../src/core/canonical.ts'
import { sha256File } from '../src/infra/backup.ts'
import {
  evidenceFile, executeFaultQuery, insideDirectory, REQUIRED_FAULT_QUERIES,
  type FaultMetric, type FaultQuery, type FaultQueryResult,
} from './fault-reconcile.ts'

export const FAULT_REPORT_VERSION = 1
const ROOT = realpathSync(join(import.meta.dirname, '..'))
const STAGES = ['before', 'breakpoint', 'after'] as const
type Stage = typeof STAGES[number]

type FaultCheck = { actual: unknown; expected: unknown }
export type FaultObservation = {
  params?: Record<string, unknown>
  sampleIds: Record<string, string | number>
  boundary: { reached: boolean; [name: string]: unknown }
  snapshots: Partial<Record<Stage, Record<string, unknown>>>
  queries: Partial<Record<FaultMetric, FaultQuery>>
  extraQueries?: Record<string, FaultQuery>
  checks?: Record<string, FaultCheck>
  artifacts: readonly string[]
  extra?: Record<string, unknown>
}

export type FaultCase = (context: {
  directory: string
  candidateSha?: string
  candidateDirty?: boolean
}) => Promise<FaultObservation> | FaultObservation

export function reconcileFaultObservation(directory: string, observation?: FaultObservation) {
  const failures: string[] = []
  const entries: [FaultMetric, FaultQueryResult | null][] = []
  const extraQueries: Record<string, FaultQueryResult> = Object.create(null)
  const checks: Record<string, FaultCheck & { passed: boolean }> = Object.create(null)
  const artifacts: Record<string, { sha256: string; bytes: number }> = Object.create(null)

  if (!observation || Object.keys(observation.sampleIds).length === 0) failures.push('Missing sample IDs')
  if (observation?.boundary.reached !== true) failures.push('Fault boundary was not reached')
  for (const stage of STAGES) {
    const snapshot = observation?.snapshots[stage]
    if (!snapshot || Object.keys(snapshot).length === 0) failures.push('Missing ' + stage + ' snapshot')
  }
  for (const name of new Set(observation?.artifacts)) {
    try {
      const file = evidenceFile(directory, name)
      const bytes = statSync(file).size
      if (bytes === 0) throw new Error('Empty evidence file')
      artifacts[name] = { sha256: sha256File(file), bytes }
    } catch (error) {
      failures.push(name + ': ' + messageOf(error))
    }
  }
  if (Object.keys(artifacts).length === 0) failures.push('Missing retained evidence files')

  function runQuery(name: string, query: FaultQuery | undefined): FaultQueryResult | undefined {
    if (!query) {
      failures.push('Missing required query ' + name)
      return
    }
    if (!artifacts[query.database]) {
      const error = 'Missing checkpoint artifact ' + query.database
      failures.push(name + ': ' + error)
      return { ...query, rows: null, actualCount: null, passed: false, error }
    }
    const result = executeFaultQuery(directory, query)
    if (!result.passed) {
      failures.push(name + ': ' + (result.error ?? 'expected ' + query.expectedCount + ', observed ' + result.actualCount))
    }
    return result
  }

  for (const metric of REQUIRED_FAULT_QUERIES) entries.push([metric, runQuery(metric, observation?.queries[metric]) ?? null])
  const reconcile = Object.fromEntries(entries) as Record<FaultMetric, FaultQueryResult | null>
  for (const [name, query] of Object.entries(observation?.extraQueries ?? {})) {
    const result = runQuery(name, query)
    if (result) extraQueries[name] = result
  }
  for (const [name, check] of Object.entries(observation?.checks ?? {})) {
    try {
      const passed = check.actual !== undefined && check.expected !== undefined
        && canonicalJson(check.actual) === canonicalJson(check.expected)
      checks[name] = { ...check, passed }
      if (!passed) failures.push(name + ': observed value differed from the expected value')
    } catch (error) {
      failures.push(name + ': ' + messageOf(error))
      checks[name] = { actual: null, expected: null, passed: false }
    }
  }

  return { reconcile, extraQueries, checks, artifacts, failures, passed: failures.length === 0 }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function actualOutputPath(path: string): string {
  const volume = parse(path).root
  let actual = realpathSync(volume)
  let missing = false
  for (const component of relative(volume, path).split(sep).filter(Boolean)) {
    const next = join(actual, component)
    if (!missing) {
      let entry
      try {
        entry = lstatSync(next)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        missing = true
      }
      if (entry) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new Error('Output ancestors must be real directories: ' + next)
        }
        actual = realpathSync(next)
        continue
      }
    }
    actual = next
  }
  return actual
}

function outputPath(out: string, name: string): string {
  const root = actualOutputPath(resolve(out))
  const protectedPath = realpathSync(join(ROOT, 'docs', 'gates'))
  if (insideDirectory(root, protectedPath) || insideDirectory(protectedPath, root)) {
    throw new Error('S6 output overlaps historical gate evidence: ' + root)
  }
  if (root.split(sep).some((part, index, parts) =>
    /^G6$/i.test(part) && /^\.?G-\d{2}(?:$|[.-])/i.test(parts[index + 1] ?? ''))) {
    throw new Error('S6 output overlaps another fault case: ' + root)
  }
  return actualOutputPath(join(root, 'G6', name))
}

export async function writeFaultReport(name: string, out: string, argv: readonly string[], scenario: FaultCase) {
  if (!/^G-(?:0[1-9]|1[0-6])$/.test(name) || !out.trim() || out.startsWith('--')) {
    throw new Error('Invalid S6 case or output directory')
  }
  const destination = outputPath(out, name)
  if (existsSync(destination)) throw new Error('S6 evidence already exists: ' + destination)
  const gate = dirname(destination)
  const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const candidateDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'],
    { cwd: ROOT, encoding: 'utf8' }).trim().length > 0
  mkdirSync(gate, { recursive: true })
  const reservation = join(gate, '.' + name + '.lock')
  mkdirSync(reservation)
  try {
    if (existsSync(destination)) throw new Error('S6 evidence already exists: ' + destination)
    const directory = mkdtempSync(join(gate, '.' + name + '.pending-'))
    const startedAt = new Date().toISOString()
    let observation: FaultObservation | undefined
    let scenarioError: string | undefined
    try {
      observation = await scenario({ directory, candidateSha, candidateDirty })
    } catch (error) {
      scenarioError = messageOf(error)
    }
    const result = reconcileFaultObservation(directory, observation)
    const params: Record<string, unknown> = { ...observation?.params, out: resolve(out) }
    const report = {
      schemaVersion: FAULT_REPORT_VERSION,
      scriptVersion: FAULT_REPORT_VERSION,
      case: name,
      candidateSha,
      candidateDirty,
      argv,
      environment: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch, release: release() },
      startedAt,
      finishedAt: new Date().toISOString(),
      params,
      sampleIds: observation?.sampleIds ?? {},
      boundary: observation?.boundary ?? { reached: false },
      snapshots: observation?.snapshots ?? {},
      reconcile: result.reconcile,
      extra: {
        ...observation?.extra,
        queries: result.extraQueries,
        checks: result.checks,
      },
      artifacts: result.artifacts,
      failures: scenarioError ? [scenarioError, ...result.failures] : result.failures,
      passed: scenarioError === undefined && result.passed,
    }
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    renameSync(directory, destination)
    return report
  } finally {
    rmdirSync(reservation)
  }
}
