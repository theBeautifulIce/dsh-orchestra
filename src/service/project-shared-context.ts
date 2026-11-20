import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { makeTx, withTx, type Db } from '../infra/sqlite/driver.ts'
import type { ReadTx } from './queries/read-tx.ts'

export const PROJECT_CONTEXT_FILE = 'ORCHESTRA.md'
const PROJECT_TEXT_BYTES = 4096
const PROJECT_READ_LIMIT = 256 * 1024
const ROOT_DIRECTORIES = new Set(['app', 'apps', 'bin', 'config', 'docs', 'frontend', 'infra', 'lib', 'packages',
  'public', 'scripts', 'server', 'src', 'test', 'tests', 'tools', 'web'])

type ProjectStatus = 'available' | 'missing' | 'unavailable' | 'excluded'
type SourceInfo = { path: string; status: ProjectStatus; sha256?: string; truncated?: boolean;
  sha256_scope?: 'read_text' | 'excerpt' | 'directory_index' }
type ProjectBrief = SourceInfo & { text?: string }
type ProjectSnapshot = {
  brief: ProjectBrief
  fallback?: ProjectBrief
  structure?: SourceInfo & { directories?: string[] }
}
export type ProjectContextMetadata = { version: string; as_of_seq: number; sources: SourceInfo[] }
type RunProject = { snapshot: ProjectSnapshot; version: string; as_of_seq: number }

export type ProjectContextSource = {
  workspaceRoot: string
  isAuthorized(): boolean
  approvedFallback?: 'README.md' | 'AGENTS.md'
  read(path: typeof PROJECT_CONTEXT_FILE | 'README.md' | 'AGENTS.md', signal: AbortSignal): Promise<{ text: string; eof: boolean }>
  list?(signal: AbortSignal): Promise<{ entries: readonly { name: string; type: string }[]; truncated: boolean }>
}

type Probe = { stamp: string; status: ProjectStatus; oversized?: boolean }

async function probe(path: string, file: boolean): Promise<Probe> {
  try {
    const stat = await lstat(path, { bigint: true })
    if (file ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory()) {
      return { status: 'excluded', stamp: 'excluded' }
    }
    const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
    if (file && stat.size > PROJECT_READ_LIMIT) return { status: 'excluded', stamp, oversized: true }
    return { status: 'available', stamp }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? { status: 'missing', stamp: 'missing' } : { status: 'unavailable', stamp: 'unavailable' }
  }
}

function truncateUtf8(value: string, budget: number): string {
  const bytes = Buffer.from(value)
  if (bytes.length <= budget) return value
  let end = budget
  while ((bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

function unavailableSnapshot(withStructure: boolean): ProjectSnapshot {
  return { brief: { path: PROJECT_CONTEXT_FILE, status: 'unavailable' },
    ...(withStructure ? { structure: { path: '.', status: 'unavailable' } } : {}) }
}

function metadataOf(project: RunProject): ProjectContextMetadata {
  const { brief, fallback, structure } = project.snapshot
  const { text: _text, ...briefInfo } = brief
  const sources: SourceInfo[] = [briefInfo]
  if (fallback) {
    const { text: _fallbackText, ...fallbackInfo } = fallback
    sources.push(fallbackInfo)
  }
  if (structure) {
    const { directories: _directories, ...structureInfo } = structure
    sources.push(structureInfo)
  }
  return { version: project.version, as_of_seq: project.as_of_seq, sources }
}

function boundProject(tx: ReadTx, runId: string): RunProject | undefined {
  const row = tx.get<{ version: string; as_of_seq: number; snapshot_json: string }>(`SELECT p.version,p.as_of_seq,v.snapshot_json
    FROM shared_run_projects p JOIN shared_project_versions v USING(version) WHERE p.run_id=?`, [runId])
  if (!row) return
  return { version: row.version, as_of_seq: row.as_of_seq, snapshot: JSON.parse(row.snapshot_json) as ProjectSnapshot }
}

export function readProjectContextMetadata(tx: ReadTx, runId: string): ProjectContextMetadata | undefined {
  const pinned = boundProject(tx, runId)
  return pinned && metadataOf(pinned)
}

export function projectPromptContext(project: RunProject | undefined) {
  if (!project) return
  const { brief, fallback, structure } = project.snapshot
  const text = brief.text ?? fallback?.text
  return { ...metadataOf(project), ...(text ? { constraints: text } : {}),
    ...(structure?.directories ? { root_directories: structure.directories } : {}) }
}

/** One reader per bound workspace session; the session's SQLite file also scopes all durable cache entries. */
export function createProjectContextStore(db: Db, source: ProjectContextSource) {
  const pinning = new Map<string, Promise<RunProject>>()
  let collecting: Promise<Omit<RunProject, 'as_of_seq'>> | undefined

  async function observe() {
    const root = await probe(source.workspaceRoot, false)
    const brief = root.status === 'available' ? await probe(join(source.workspaceRoot, PROJECT_CONTEXT_FILE), true) : root
    const fallback = source.approvedFallback && brief.status === 'missing' && root.status === 'available'
      ? await probe(join(source.workspaceRoot, source.approvedFallback), true) : undefined
    const layout = source.list ? root : undefined
    const versionBasis = [brief.stamp, fallback ? [source.approvedFallback, fallback.stamp] : null]
    return { brief, fallback, layout, versionBasis, fingerprint: sha256Hex(canonicalJson([1, versionBasis, layout?.stamp ?? null])) }
  }

  async function readBrief(path: Parameters<ProjectContextSource['read']>[0], info: Probe): Promise<ProjectBrief> {
    const brief: ProjectBrief = { path, status: info.status, ...(info.oversized ? { truncated: true } : {}) }
    if (info.status !== 'available') return brief
    try {
      const sample = await source.read(path, AbortSignal.timeout(2500))
      const text = truncateUtf8(sample.text, PROJECT_TEXT_BYTES)
      return { ...brief, text, sha256: sha256Hex(sample.eof ? sample.text : text),
        sha256_scope: sample.eof ? 'read_text' : 'excerpt', truncated: !sample.eof || text !== sample.text }
    } catch { return { ...brief, status: 'unavailable' } }
  }

  function save(snapshot: ProjectSnapshot, basis?: { versionBasis: unknown; fingerprint: string }) {
    const snapshotJson = canonicalJson(snapshot)
    const version = sha256Hex(canonicalJson([1, snapshot, basis?.versionBasis ?? null]))
    withTx(db, (tx) => {
      tx.run('INSERT OR IGNORE INTO shared_project_versions VALUES (?,?)', [version, snapshotJson])
      if (basis) tx.run('INSERT OR IGNORE INTO shared_project_observations VALUES (?,?)', [basis.fingerprint, version])
    })
    return { version, snapshot }
  }

  async function collect(): Promise<Omit<RunProject, 'as_of_seq'>> {
    const before = await observe()
    if (!source.isAuthorized()) return save(unavailableSnapshot(Boolean(source.list)))
    const observed = makeTx(db.raw).get<{ version: string; snapshot_json: string }>(`SELECT v.version,v.snapshot_json
      FROM shared_project_observations o JOIN shared_project_versions v USING(version) WHERE o.fingerprint=?`, [before.fingerprint])
    if (observed) return { version: observed.version, snapshot: JSON.parse(observed.snapshot_json) as ProjectSnapshot }

    const brief = await readBrief(PROJECT_CONTEXT_FILE, before.brief)
    const fallback = before.fallback && source.approvedFallback && source.isAuthorized()
      ? await readBrief(source.approvedFallback, before.fallback) : undefined
    let structure: ProjectSnapshot['structure'] = before.layout && { path: '.', status: before.layout.status }
    if (source.list && structure?.status === 'available' && source.isAuthorized()) {
      try {
        const listing = await source.list(AbortSignal.timeout(2500))
        const directories = [...new Set(listing.entries.filter(({ name, type }) => type === 'directory'
          && ROOT_DIRECTORIES.has(name)).map(({ name }) => name))].sort()
        structure = { ...structure, directories, sha256: sha256Hex(canonicalJson(directories)),
          sha256_scope: 'directory_index', truncated: listing.truncated }
      } catch { structure.status = 'unavailable' }
    }
    const after = await observe()
    if (!source.isAuthorized() || before.fingerprint !== after.fingerprint) return save(unavailableSnapshot(Boolean(source.list)))
    const stable = brief.status !== 'unavailable' && fallback?.status !== 'unavailable' && structure?.status !== 'unavailable'
    return save({ brief, ...(fallback ? { fallback } : {}), ...(structure ? { structure } : {}) }, stable ? before : undefined)
  }

  async function capture(runId: string) {
    if (!collecting) {
      collecting = collect().finally(() => { collecting = undefined })
    }
    const { version, snapshot } = await collecting
    return withTx(db, (tx) => {
      const pinned = boundProject(tx, runId)
      if (pinned) return pinned
      const as_of_seq = Number(tx.get<{ seq: number }>('SELECT COALESCE(MAX(seq),0) AS seq FROM events')!.seq)
      tx.run('INSERT INTO shared_run_projects VALUES (?,?,?)', [runId, version, as_of_seq])
      return { snapshot, version, as_of_seq }
    })
  }

  return {
    async forRun(runId: string) {
      if (!source.isAuthorized()) return
      const pinned = boundProject(makeTx(db.raw), runId)
      if (pinned) return pinned
      let pending = pinning.get(runId)
      if (!pending) {
        pending = capture(runId).finally(() => { pinning.delete(runId) })
        pinning.set(runId, pending)
      }
      const project = await pending
      if (source.isAuthorized()) return project
    },
  }
}
