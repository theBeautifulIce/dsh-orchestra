import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256Hex, canonicalJson } from '../src/core/canonical.ts'
import { openDb, type Db } from '../src/infra/sqlite/driver.ts'
import { UNVERIFIED_EFFECT } from '../src/infra/db/unverified-effects.ts'
import { legacyModelMappingSchema } from '../src/service/model-routing-settings.ts'
import { inspectPackage } from './package-acceptance.ts'

type Module = typeof import('../src/index.ts')
type Service = Awaited<ReturnType<Module['serveOrchestra']>>
type PackagePin = { archive: string; sha256: string }
export const waitWorkflow = 'upgrade_rehearsal_wait'
const ready = 'fixture.upgrade.ready'

export async function loadUpgradeBuild(pin: PackagePin, stage: string, previous: boolean) {
  const inspected = inspectPackage(pin.archive, { expectedSha256: pin.sha256, previous })
  const marker = join(stage, 'artifact.sha256')
  const entry = join(stage, 'package/lib/index.js')
  if (!existsSync(marker)) {
    mkdirSync(stage, { recursive: true })
    execFileSync('tar', ['-xf', inspected.archive, '-C', stage])
    writeFileSync(marker, inspected.sha256, { flag: 'wx' })
  }
  if (readFileSync(marker, 'utf8') !== inspected.sha256) throw new Error('Staged package checksum mismatch')
  for (const file of ['package.json', 'lib/index.js', ...inspected.migrations.map(({ name }) => name.slice('package/'.length))]) {
    const expected = execFileSync('tar', ['-xOf', inspected.archive, 'package/' + file], { maxBuffer: 10 * 1024 * 1024 })
    if (sha256Hex(readFileSync(join(stage, 'package', file))) !== sha256Hex(expected)) throw new Error('Staged package file changed: ' + file)
  }
  if (sha256Hex(readFileSync(inspected.archive)) !== pin.sha256) throw new Error('Package archive changed during staging')
  return { module: await import(pathToFileURL(entry).href) as Module, inspected }
}

export async function bootBuild(module: Module, dbFile: string, secret: string, phase: 'S5' | 'S6', configPath?: string) {
  let service: Service | undefined
  service = await module.serveOrchestra({
    dbFile, secret, phase, configPath,
    asOfSeq: () => service ? head(service.orchestra.db) : 0,
    listEvents: () => { throw new Error('Fallback events route') },
    listTasks: () => { throw new Error('Fallback task listing') },
    appendLedgerEvent: () => { throw new Error('Unauthorised raw event ingress') },
  })
  return service
}

export function head(db: Db) {
  return (db.raw.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq
}

export async function request<T>(service: Service, secret: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(service.endpoint + path, {
    headers: { 'x-orchestra-secret': secret, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  })
  const envelope = await response.json() as { ok: boolean; data: T; error?: { code: string; message: string } }
  if (!response.ok || !envelope.ok) {
    throw Object.assign(new Error(path + ': ' + (envelope.error?.message ?? response.status)), { code: envelope.error?.code })
  }
  return envelope.data
}

export async function verifyRuntime(service: Service, secret: string, phase: 'S5' | 'S6') {
  const health = await request<{ phase: string; epoch: number }>(service, secret, '/health')
  const ledger = await request<{ valid: boolean; chains: number; entries: number }>(service, secret, '/v1/ledger/verify')
  if (health.phase !== phase || !ledger.valid) throw new Error('Unexpected phase or broken ledger at ' + phase)
  return { health, ledger, state: snapshot(service.orchestra.db) }
}

export function snapshot(database: Db | string, at?: number) {
  const owned = typeof database === 'string'
  const db = owned ? openDb(database, { readonly: true }) : database
  try {
    db.raw.exec('BEGIN DEFERRED')
    const integrity = db.raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    if (integrity.integrity_check !== 'ok') throw new Error('SQLite integrity check failed')
    const seq = at ?? head(db)
    const events = db.raw.prepare('SELECT seq,event_id,type,payload_redacted FROM events WHERE seq <= ? ORDER BY seq').all(seq)
    const workflows = db.raw.prepare('SELECT workflow_id,version,content_hash FROM workflow_versions ORDER BY workflow_id,version').all()
    const artifacts = db.raw.prepare('SELECT a.artifact_id,a.sha256,c.bytes FROM artifact_contents c JOIN artifacts a USING (artifact_id) ORDER BY a.artifact_id').all()
    const hashes = artifacts.map(({ artifact_id, sha256, bytes }) => {
      if (!(bytes instanceof Uint8Array) || sha256Hex(Buffer.from(bytes)) !== sha256) throw new Error('Managed artifact content mismatch')
      return { artifact_id, sha256 }
    })
    const migrations = db.raw.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all()
    const result = { seq, event_sha256: sha256Hex(canonicalJson(events)), events: events.length,
      workflow_sha256: sha256Hex(canonicalJson(workflows)), workflows: workflows.length,
      artifact_sha256: sha256Hex(canonicalJson(hashes)), artifacts: hashes.length, migrations }
    db.raw.exec('COMMIT')
    return result
  } catch (error) {
    try { db.raw.exec('ROLLBACK') } catch { /* Keep the original verification failure. */ }
    throw error
  } finally { if (owned) db.raw.close() }
}

export function verifyPrefix(db: Db, before: ReturnType<typeof snapshot>) {
  const ending = snapshot(db, before.seq)
  if (head(db) < before.seq || ending.event_sha256 !== before.event_sha256 || ending.workflow_sha256 !== before.workflow_sha256
    || ending.artifact_sha256 !== before.artifact_sha256) throw new Error('Historical events, fixed version or managed artifacts differ')
}

export function upgradeBlockers(db: Db, waitingRun?: string) {
  const count = (sql: string, ...bindings: (string | null)[]) =>
    (db.raw.prepare(sql).get(...bindings) as { n: number }).n
  const state = {
    leases: count('SELECT COUNT(*) AS n FROM leases l JOIN node_runs n ON n.node_run_id=l.node_run_id AND n.lease_id=l.lease_id WHERE l.expires_at > ?',
      new Date().toISOString()),
    unverified: count('SELECT COUNT(*) AS n FROM node_runs n WHERE ' + UNVERIFIED_EFFECT),
    rework: count("SELECT COUNT(*) AS n FROM rework_requests WHERE status NOT IN ('closed','declined','cancelled')"),
    pending: count("SELECT COUNT(*) AS n FROM node_runs WHERE status IN ('queued','leased','dispatched','started','verifying','waiting','stopping','startup_unknown','timing_out','indeterminate_side_effect','paused_bridge_missing','blocked_pre','blocked_post') AND NOT (run_id IS ? AND status='waiting' AND node_type='wait' AND side_effect_policy='pure')", waitingRun ?? null),
    command_queue: count("SELECT COUNT(*) AS n FROM inbox WHERE status IN ('pending','running','in_progress','in_flight')"),
    memory_writes: count("SELECT COUNT(*) AS n FROM memory_batches WHERE status IN ('applying','indeterminate')"),
  }
  if (Object.values(state).some((n) => n > 0)) throw new Error('Unsafe upgrade boundary: ' + JSON.stringify(state))
  return state
}

export function previousCompatibility(db: Db) {
  // A downgraded service reads even historical plans with a strict schema.
  // Projecting away these fields would alter both the signed plan hash and execution model.
  const advancedPlans = db.raw.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE
      WHEN r.status NOT IN ('succeeded','succeeded_with_unverified','failed','failed_with_unverified','orphaned','cancelled') THEN 1 ELSE 0 END), 0) AS in_flight
    FROM task_plans p LEFT JOIN start_run_operations o ON o.operation_id = p.launch_operation_id LEFT JOIN runs r ON r.run_id = o.run_id
    WHERE EXISTS (SELECT 1 FROM json_each(p.proposal_json, '$.steps') s WHERE
      json_extract(s.value, '$.complexity') IN ('advanced','expert') OR json_type(s.value, '$.preferred_model_ref') IS NOT NULL)`).get() as { n: number; in_flight: number }
  const routing = db.raw.prepare('SELECT mapping_json FROM model_routing_settings WHERE id = 1').get() as { mapping_json: string } | undefined
  const unreadableRouting = routing && !legacyModelMappingSchema.safeParse(JSON.parse(routing.mapping_json)).success ? 1 : 0
  const release = db.raw.prepare("SELECT COUNT(*) AS n FROM workflow_versions WHERE workflow_id='wf_release_v1'").get() as { n: number }
  const blockers = { candidate_plans: advancedPlans.n, in_flight_model_plans: advancedPlans.in_flight,
    candidate_routing: unreadableRouting, release_versions: release.n }
  if (Object.values(blockers).some((n) => n > 0)) {
    const detail = advancedPlans.n > 0 ? '。已有计划使用进阶、专家档或明确的首选模型，请保留原计划与批准记录，并用当前构建继续处理。' : ''
    throw new Error('Previous build cannot interpret candidate data: ' + JSON.stringify(blockers) + detail)
  }
  return blockers
}

export function operationId(identity: string, action: string) {
  const hex = sha256Hex(identity + '\n' + action)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export async function ensureRehearsalWorkflow(service: Service, secret: string, identity: string) {
  const db = service.orchestra.db
  if (db.raw.prepare('SELECT 1 FROM workflow_versions WHERE workflow_id=? AND version=?').get(waitWorkflow, '1')) return
  const definition = { name: '升级演练等待节点', nodes: [
    { node_id: 'start', type: 'trigger', title: '启动', position: { x: 0, y: 0 } },
    { node_id: 'wait_ready', type: 'wait', title: '合成等待', position: { x: 100, y: 0 },
      config: { wait_kind: 'event', match: { type: ready }, max_wait_ms: 20 * 60_000 } },
  ], edges: [{ from: 'start', to: 'wait_ready' }] }
  const draft = await request<{ revision: number }>(service, secret, '/v1/workflows', {
    workflow_id: waitWorkflow, name: definition.name, definition, operation_id: operationId(identity, 'workflow-create'),
  })
  const tested = await request<{ passed: boolean }>(service, secret, '/v1/workflows/test', {
    workflow_id: waitWorkflow, revision: draft.revision,
  })
  if (!tested.passed) throw new Error('Upgrade rehearsal workflow did not pass server validation')
  await request(service, secret, '/v1/workflows/publish', {
    workflow_id: waitWorkflow, revision: draft.revision, base_version: 0,
    publish_note: '隔离升级演练', operation_id: operationId(identity, 'workflow-publish'),
  })
}

export async function startRun(service: Service, secret: string, identity: string, key: string) {
  const requestBody = { workflowId: waitWorkflow, workflowVersion: '1', taskTitle: 'Upgrade rehearsal ' + key, operationId: operationId(identity, key) }
  const started = await request<{ run_id: string; workflow_version: string; replayed: boolean }>(service, secret, '/v1/runs/start', requestBody)
  if (started.workflow_version !== '1') throw new Error('Pinned version was not preserved')
  const nodes = await request<{ items: { status: string; node_type: string; node_run_id: string }[] }>(service, secret, '/v1/node-runs?run_id=' + started.run_id)
  if (nodes.items.length !== 1 || nodes.items[0]?.node_type !== 'wait') throw new Error('Expected exactly one trusted wait node')
  if (nodes.items[0].status === 'queued') await request(service, secret, '/v1/runs/dispatch', {
    runId: started.run_id, nodes: { wait_ready: { tools: [] } },
  })
  return started.run_id
}

export async function completeRun(service: Service, secret: string, runId: string) {
  const body = { runId, eventType: ready, idempotencyKey: 'upgrade-wake:' + runId, payload: {} }
  const verify = async () => {
    const run = await request<{ status: string; workflow_version: number }>(service, secret, '/v1/runs/get?run_id=' + runId)
    if (run.status !== 'succeeded' || run.workflow_version !== 1) throw new Error('Rehearsal wait run did not settle at its fixed version: ' + JSON.stringify(run))
  }
  await request(service, secret, '/v1/wait/events', body)
  await verify()
  const seq = head(service.orchestra.db)
  await request(service, secret, '/v1/wait/events', body)
  if (head(service.orchestra.db) !== seq) throw new Error('Resuming the same workflow added duplicate wake events')
  return seq
}
