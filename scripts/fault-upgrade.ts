import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { canonicalJson, sha256Hex } from '../src/core/canonical.ts'
import { uuidv7 } from '../src/core/ids.ts'
import { sha256File, verifyBackup } from '../src/infra/backup.ts'
import { openDb } from '../src/infra/sqlite/driver.ts'
import { BridgeClient } from '../src/executor/bridge.ts'
import type { ModelProfile } from '../src/executor/model-routing.ts'
import type { TaskPlanView } from '../src/service/task-planning.ts'
import { businessQuery, checkpoint, faultRows, missingPrefix } from './fault-business-support.ts'
import { insideDirectory, ORPHAN_REFERENCES_SQL } from './fault-reconcile.ts'
import type { FaultCase } from './fault-report.ts'
import { inspectPackage } from './package-acceptance.ts'
import { PREVIOUS_SIGNED_BUILD, readUpgradeReceipts, rehearseUpgrade, upgradePlanSchema, UPGRADE_STEPS,
  type UpgradePlan } from './upgrade.ts'
import { bootBuild, completeRun, head, loadUpgradeBuild, operationId, previousCompatibility, readPreviousModelCatalog, request, snapshot, startRun,
  verifyPrefix, verifyRuntime, waitWorkflow } from './upgrade-host.ts'

const WORKSPACE = realpathSync(join(import.meta.dirname, '..'))
const DEVELOPMENT_PLAN = 'tmp/s6-evidence/T14/rehearsal-dev-model-compat-060/plan.json'
const HISTORICAL_DEVELOPMENT_PLAN = 'tmp/s6-evidence/T14/rehearsal-dev-20261120-03/plan.json'
const FIXTURE_SECRET = 'g13-local-synthetic-ledger-secret'
const FIXTURE_PROOF = 'g13-development-operator-proof'
const LEGACY_MODEL = 'synthetic:standard-model'
const ADVANCED_MODEL = 'synthetic:expert-model'
const PLAN_WORKFLOW = 'g13_compatibility_agent'
const SETTINGS_PATH = '/v1/settings/model-routing'
const EVENTS = 'SELECT * FROM events WHERE seq<=? ORDER BY seq'
const MIGRATIONS = 'SELECT version,name,checksum,applied_at FROM schema_migrations ORDER BY version'
const PINNED_RUN = `SELECT r.run_id,r.status,r.workflow_id,r.workflow_version,r.workflow_definition_hash,
    v.content_hash,n.node_run_id,n.status AS node_status
  FROM runs r JOIN workflow_versions v ON v.workflow_id=r.workflow_id AND v.version=r.workflow_version
    AND v.content_hash=r.workflow_definition_hash JOIN node_runs n ON n.run_id=r.run_id
  WHERE r.run_id=? AND r.workflow_version=1 AND n.node_id='wait_ready'`

function safeInput(path: string) {
  const tmp = resolve(WORKSPACE, 'tmp')
  const target = resolve(WORKSPACE, path)
  if (!insideDirectory(tmp, target) || target === tmp || !existsSync(target) || realpathSync(target) !== target
    || lstatSync(target).isSymbolicLink()) throw new Error('G-13 evidence must be in the real workspace tmp tree: ' + target)
  return target
}

type Head = ReturnType<typeof snapshot>
type Health = { phase: string; epoch: number }
type Cut = { before: Head; endpoint: string; compatibility: Record<string, number>; blockers: Record<string, number>;
  pending: { run_id: string; workflow_version: number }; fault: string; authorization: string }
type ArchivedObservation = { window?: string; stage: string; run_id?: string; seq?: number; action: string }

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(safeInput(file), 'utf8')) as unknown
}

function stageCopy(input: string, directory: string, name: string) {
  const db = openDb(safeInput(input), { readonly: true })
  try { checkpoint(db, directory, name) } finally { db.raw.close() }
}

function rows(file: string, sql: string, ...bindings: (string | number | null)[]) {
  const db = openDb(file, { readonly: true })
  try { return faultRows(db, sql, ...bindings) } finally { db.raw.close() }
}

function checkPrefix(file: string, before: Head) {
  const db = openDb(file, { readonly: true })
  try { verifyPrefix(db, before) } finally { db.raw.close() }
}

export function readG13Archive(planFile: string) {
  const plan = upgradePlanSchema.parse(readJson(planFile))
  assert.equal(plan.previous.source_commit, PREVIOUS_SIGNED_BUILD)
  assert.notEqual(plan.previous.sha256, plan.candidate.sha256)
  assert.equal(sha256File(safeInput(plan.config_path)), plan.config_sha256)
  const state = safeInput(plan.state_dir)
  const live = safeInput(plan.live_db)
  assert.ok(insideDirectory(state, live))
  const planSha = sha256Hex(canonicalJson(plan))
  const receipts = readUpgradeReceipts(state, plan.rehearsal_id, planSha)
  assert.deepEqual(receipts.map(row => row.step), [...UPGRADE_STEPS])
  const firstAt = Date.parse(receipts[0]!.started_at)
  assert.ok(firstAt >= Date.parse(plan.approval.approved_at)
    && firstAt - Date.parse(plan.approval.approved_at) <= 86_400_000)
  const archives = {
    previous: inspectPackage(safeInput(plan.previous.archive), { expectedSha256: plan.previous.sha256, previous: true }),
    candidate: inspectPackage(safeInput(plan.candidate.archive), { expectedSha256: plan.candidate.sha256 }),
  }
  assert.equal(archives.previous.migrations.length, plan.compatible_floor)
  assert.ok(archives.candidate.migrations.length > plan.compatible_floor)
  const taken = verifyBackup(safeInput(join(state, 'backup')))
  assert.equal(canonicalJson(taken), canonicalJson(receipts[0]!.facts.manifest))
  const [backup, copy, quiesce, health, synthetic, observe, rollback] = receipts
  const cutPath = join(state, 'rollback-fault.json')
  const cut = readJson(cutPath) as Cut
  assert.equal(cut.authorization, plan.approval.actor)
  assert.equal(cut.fault, 'candidate_listener_unavailable')
  assert.equal(new URL(cut.endpoint).hostname, '127.0.0.1')
  const fencePath = join(state, 'external-fence.json')
  const fence = readJson(fencePath) as { rehearsal_id: string; plan_sha256: string; pause_seq: number }
  assert.deepEqual(fence, { rehearsal_id: plan.rehearsal_id, plan_sha256: planSha, pause_seq: quiesce!.seq })
  const copied = copy!.facts as { newer: { health: Health; state: Head }; older: { health: Health; state: Head }; live_untouched: boolean }
  assert.equal(copied.live_untouched, true)
  assert.equal(copied.newer.health.phase, 'S6')
  assert.equal(copied.older.health.phase, 'S5')
  const migrationCount = archives.candidate.migrations.length
  const modelSettingsSidecar = archives.candidate.migrations.some(({ name, version }) =>
    version === 60 && name.endsWith('/060_model_routing_mapping_compat.sql'))
  assert.equal(copied.newer.state.migrations.length, migrationCount)
  assert.equal(canonicalJson(copied.newer.state.migrations), canonicalJson(copied.older.state.migrations))
  const runId = cut.pending.run_id
  assert.equal(observe!.facts.rollback_pending_run, runId)
  assert.equal(cut.pending.workflow_version, 1)
  assert.equal((rollback!.facts.restored_run as Cut['pending']).run_id, runId)
  assert.equal(rollback!.facts.decision, 'switch_runtime_only')
  assert.equal(rollback!.facts.before_seq, cut.before.seq)
  assert.equal(rollback!.facts.after_seq, rollback!.seq)
  assert.ok(rollback!.seq > cut.before.seq && cut.before.seq >= observe!.seq && observe!.seq > backup!.seq)
  for (const gate of [quiesce!.facts.blockers, cut.blockers, cut.compatibility]) {
    const values = Object.values(gate as Record<string, number>)
    assert.ok(values.length && values.every(value => value === 0))
  }
  const observationsPath = safeInput(join(state, 'observations.ndjson'))
  const observations = readFileSync(observationsPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line) as ArchivedObservation)
  const completed = observations.filter(row => row.window === observe!.facts.window && row.stage === 'completed')
  assert.equal(completed.length, observe!.facts.loaded_runs)
  assert.ok(completed.length >= 2)
  const ids = completed.map(row => row.run_id!)
  assert.ok(ids.every(id => typeof id === 'string' && id !== runId) && new Set(ids).size === ids.length)
  assert.ok(Number(observe!.facts.observation_ms) >= plan.observation_ms)
  assert.equal((health!.facts.intake as { paused: boolean }).paused, true)
  const runtime = [quiesce, health, synthetic, observe, rollback].map(row => row!.facts.health as Health)
  assert.deepEqual(runtime.map(row => row.phase), ['S5', 'S6', 'S6', 'S6', 'S5'])
  for (const [i, row] of runtime.entries()) if (i > 0) assert.ok(row.epoch > runtime[i - 1]!.epoch)
  assert.equal((rollback!.facts.ledger as { valid: boolean }).valid, true)
  const current = snapshot(live)
  assert.equal(canonicalJson(current), canonicalJson(rollback!.facts.state))
  checkPrefix(live, cut.before)
  return { plan, state, live, planSha, receipts, taken, archives, cut, runId, ids, fencePath, cutPath,
    runtime, observationsPath, migrationCount, modelSettingsSidecar, syntheticRun: String(synthetic!.facts.run_id) }
}

async function expectFailure(action: () => Promise<unknown>, expected: string | RegExp) {
  try { await action() } catch (error) {
    if (!(error instanceof Error)) throw error
    const code = 'code' in error ? error.code : null
    if (typeof expected === 'string') assert.equal(code, expected, error.message)
    else assert.match(error.message, expected)
    return { code, name: error.name, message: error.message }
  }
  throw new Error('Expected refusal: ' + String(expected))
}

function planProposal() {
  return {
    title: 'G-13 synthetic compatibility review', workflow_id: PLAN_WORKFLOW, workflow_version: '1',
    steps: [{ node_id: 'review', description: 'Review the synthetic fixture', goal_ids: ['goal'],
      depends_on: [], tools: [], complexity: 'expert', model_reason: 'Independent deep review',
      preferred_model_ref: ADVANCED_MODEL }],
    deliverables: [{ title: 'Review result', node_id: 'review', goal_ids: ['goal'],
      acceptance: { kind: 'artifact', file_name: 'review.md', minimum_bytes: 10 } }],
    risks: [],
  }
}

type UpgradeModule = Awaited<ReturnType<typeof loadUpgradeBuild>>['module']

async function bootModelProbe(module: UpgradeModule, dbFile: string, phase: 'S5' | 'S6', configPath: string, root: string) {
  const registry = new module.ToolRegistry()
  const profiles: ModelProfile[] = [{ ref: LEGACY_MODEL, capacity: 'standard' }]
  if (phase === 'S6') profiles.push({ ref: ADVANCED_MODEL, capacity: 'expert' })
  let service: Awaited<ReturnType<UpgradeModule['serveOrchestra']>> | undefined
  service = await module.serveOrchestra({
    dbFile, secret: FIXTURE_SECRET, phase, configPath,
    asOfSeq: () => service ? head(service.orchestra.db) : 0,
    listTasks: () => { throw new Error('Unexpected legacy task listing') },
    listEvents: () => { throw new Error('Unexpected legacy event listing') },
    appendLedgerEvent: () => { throw new Error('Unexpected legacy event ingress') },
    planning: { async propose() { return planProposal() } },
    executor: {
      registry,
      bridge: new BridgeClient({
        async request() { throw new Error('The unconfirmed planning probe must never execute') },
        async *listen() {},
      }),
      modelRouting: {
        profiles,
        recommend() { throw new Error('The unconfirmed planning probe must never dispatch') },
      },
      runner: new module.ReadOnlyToolRunner(registry, {
        readonlyAvailable: () => false,
        async run() { throw new Error('The unconfirmed planning probe must never call a tool') },
      }, root),
    },
  })
  return service
}

async function proposeIncompatiblePlan(service: Awaited<ReturnType<typeof bootModelProbe>>, actor: string) {
  const { commands } = service.orchestra
  const name = 'G-13 compatibility fixture review'
  const definition = {
    name,
    nodes: [
      { node_id: 'start', type: 'trigger' as const, title: 'Start', position: { x: 0, y: 0 } },
      { node_id: 'review', type: 'agent' as const, title: 'Review', position: { x: 100, y: 0 } },
    ],
    edges: [{ from: 'start', to: 'review' }],
  }
  const common = { workflowId: PLAN_WORKFLOW, actor, now: new Date().toISOString() }
  commands.createWorkflow({ ...common, name, definition, operationId: uuidv7() })
  assert.equal(commands.testWorkflowDraft({ ...common, revision: 1 }).passed, true)
  commands.publishWorkflow({ ...common, revision: 1, baseVersion: 0, note: 'G-13 model planning fixture', operationId: uuidv7() })
  const plan = await request<TaskPlanView>(service, FIXTURE_SECRET, '/v1/task-plans',
    { goal: 'Review the synthetic compatibility fixture', requirements: [] })
  assert.equal(plan.quality.ready, true, JSON.stringify(plan.quality))
  assert.equal(plan.launch, null)
  assert.equal(plan.proposal.steps[0]?.preferred_model_ref, ADVANCED_MODEL)
  assert.equal(plan.proposal.steps[0]?.complexity, 'expert')
  assert.ok(plan.content_hash)
  return plan
}

async function negativeDrill(archived: ReturnType<typeof readG13Archive>, directory: string) {
  const root = join(directory, 'negative-state')
  const provider = join(directory, 'previous-rehearsal-host.mjs')
  writeFileSync(provider, `
export function createPreviousRehearsalExecutor({ module, sourceCommit, archiveSha256 }) {
  if (sourceCommit !== ${JSON.stringify(archived.plan.previous.source_commit)} || archiveSha256 !== ${JSON.stringify(archived.plan.previous.sha256)}) {
    throw new Error('Unexpected previous rehearsal package')
  }
  const registry = new module.ToolRegistry()
  const deny = () => { throw new Error('G-13 wait fixture unexpectedly dispatched external work') }
  return {
    registry,
    bridge: { spawn: deny },
    runner: new module.ReadOnlyToolRunner(registry, { readonlyAvailable: () => false, run: deny }, ${JSON.stringify(directory)}),
    modelRouting: { profiles: [{ ref: ${JSON.stringify(LEGACY_MODEL)}, capacity: 'standard' }], recommend: deny },
  }
}
`, { flag: 'wx' })
  const plan: UpgradePlan = { ...archived.plan, rehearsal_id: 'g13-isolated-' + uuidv7(), mode: 'development',
    state_dir: root, live_db: join(root, 'live', 'orchestra.db'), observation_ms: 100,
    previous_host: { source_commit: archived.plan.previous.source_commit, archive_sha256: archived.plan.previous.sha256,
      module_sha256: sha256File(provider) },
    approval: { actor: 'synthetic:g13-operator', approved_at: new Date().toISOString(),
      operation_id: uuidv7(), proof_sha256: sha256Hex(FIXTURE_PROOF) } }
  writeFileSync(join(directory, 'negative-plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' })
  const step = (name: typeof UPGRADE_STEPS[number]) => rehearseUpgrade(plan, name, FIXTURE_SECRET, FIXTURE_PROOF, WORKSPACE, provider)
  const id = plan.rehearsal_id
  const dbFile = plan.live_db
  await step('backup')
  await step('verify-copy')
  const A = await loadUpgradeBuild(plan.previous, join(root, 'build-s5'), true)
  const B = await loadUpgradeBuild(plan.candidate, join(root, 'build-s6'), false)
  const boot = (phase: 'S5' | 'S6') => bootBuild(phase === 'S5' ? A.module : B.module, dbFile, FIXTURE_SECRET, phase, plan.config_path)
  const runState = (service: Awaited<ReturnType<typeof boot>>, runId: string) =>
    request<{ status: string; workflow_version: number }>(service, FIXTURE_SECRET, '/v1/runs/get?run_id=' + runId)

  const previous = await boot('S5')
  let upgradeRun: string
  let oldHealth
  let locked
  let unconfiguredCatalog: readonly ModelProfile[] | undefined
  try {
    upgradeRun = await startRun(previous, FIXTURE_SECRET, id, 'upgrade-blocker')
    assert.equal((await runState(previous, upgradeRun)).status, 'running')
    oldHealth = await verifyRuntime(previous, FIXTURE_SECRET, 'S5')
    unconfiguredCatalog = await readPreviousModelCatalog(previous, FIXTURE_SECRET)
    assert.equal(unconfiguredCatalog, undefined)
    locked = await expectFailure(async () => { const unexpected = await boot('S6'); await unexpected.close() }, 'ELOCKED')
    checkpoint(previous.orchestra.db, directory, 'upgrade-waiting.db')
  } finally { await previous.close() }
  const beforeUpgrade = snapshot(dbFile)
  const quiesceBlocked = await expectFailure(() => step('quiesce'), /Unsafe upgrade boundary:.*"pending":1/)
  const upgradeSkipped = await expectFailure(() => step('healthcheck'), /steps must execute in order/)
  assert.equal(snapshot(dbFile).event_sha256, beforeUpgrade.event_sha256)
  const oldAdmission = await expectFailure(() => request(previous, FIXTURE_SECRET, '/v1/runs/start', {
    workflowId: waitWorkflow, workflowVersion: '1', taskTitle: 'G-13 fenced external entry',
    operationId: operationId(id, 'quiesce-external-intake-probe'),
  }), /fetch failed/)
  const drainingPrevious = await boot('S5')
  try {
    const awaited = await runState(drainingPrevious, upgradeRun)
    assert.equal(awaited.status, 'running')
    assert.equal(awaited.workflow_version, 1)
    await completeRun(drainingPrevious, FIXTURE_SECRET, upgradeRun)
    checkpoint(drainingPrevious.orchestra.db, directory, 'upgrade-drained.db')
  } finally { await drainingPrevious.close() }
  await step('quiesce')
  await step('healthcheck')
  await step('synthetic-run')
  await step('observe')

  const candidate = await boot('S6')
  let rollbackBlocker: string
  let preBlock
  try {
    rollbackBlocker = await startRun(candidate, FIXTURE_SECRET, id, 'rollback-extra-blocker')
    preBlock = await verifyRuntime(candidate, FIXTURE_SECRET, 'S6')
  } finally { await candidate.close() }
  const rollbackBlocked = await expectFailure(() => step('rollback-table'), /Unsafe upgrade boundary:.*"pending":1/)
  const blocked = await bootModelProbe(B.module, dbFile, 'S6', plan.config_path, root)
  const deniedOperation = operationId(id, 'blocked-intake')
  let intakeDenied
  let settings
  let candidateSettingsReadback
  let modelSettingsReadByPrevious
  let planReadByPrevious
  let incompatiblePlan: TaskPlanView | undefined
  let beforeWindow
  try {
    intakeDenied = await expectFailure(() => request(blocked, FIXTURE_SECRET, '/v1/runs/start', {
      workflowId: waitWorkflow, workflowVersion: '1', taskTitle: 'G-13 forbidden during drain', operationId: deniedOperation,
    }), 'SERVICE_UNAVAILABLE')
    checkpoint(blocked.orchestra.db, directory, 'rollback-waiting.db')
    await completeRun(blocked, FIXTURE_SECRET, rollbackBlocker)
    const legacyMapping = { routine: null, standard: LEGACY_MODEL, complex: null }
    const candidateMapping = { ...legacyMapping, advanced: ADVANCED_MODEL,
      ...(archived.modelSettingsSidecar ? { expert: ADVANCED_MODEL } : {}) }
    const modelNotes = [{ ref: ADVANCED_MODEL, note: 'G-13 synthetic model use metadata' }]
    settings = await request<{ revision: number }>(blocked, FIXTURE_SECRET, SETTINGS_PATH, {
      operation_id: operationId(id, 'candidate-model-settings'), expected_revision: 0,
      mapping: candidateMapping,
      model_notes: modelNotes,
    })
    assert.equal(settings.revision, 1)
    if (archived.modelSettingsSidecar) {
      candidateSettingsReadback = await request<{ revision: number; mapping: typeof candidateMapping; model_notes: typeof modelNotes;
        profiles: ModelProfile[] }>(blocked, FIXTURE_SECRET, SETTINGS_PATH)
      assert.deepEqual(candidateSettingsReadback.mapping, candidateMapping)
      assert.deepEqual(candidateSettingsReadback.model_notes, modelNotes)
      assert.equal(candidateSettingsReadback.revision, settings.revision)
      assert.deepEqual(candidateSettingsReadback.profiles.map(({ ref, capacity }) => ({ ref, capacity })),
        [{ ref: LEGACY_MODEL, capacity: 'standard' }, { ref: ADVANCED_MODEL, capacity: 'expert' }])
      const withoutCatalog = await expectFailure(async () => previousCompatibility(blocked.orchestra.db, unconfiguredCatalog),
        /"candidate_model_bindings":1.*previous_catalog_unverified/)
      const before = snapshot(blocked.orchestra.db)
      const copied = 'settings-compatible.db'
      const target = join(root, copied)
      checkpoint(blocked.orchestra.db, root, copied)
      const previousModelProbe = await bootModelProbe(A.module, target, 'S5', plan.config_path, root)
      try {
        verifyPrefix(previousModelProbe.orchestra.db, before)
        const readback = await request<{ revision: number; mapping: typeof legacyMapping }>(previousModelProbe, FIXTURE_SECRET, SETTINGS_PATH)
        assert.deepEqual({ revision: readback.revision, mapping: readback.mapping }, { revision: 1, mapping: legacyMapping })
        const catalog = await readPreviousModelCatalog(previousModelProbe, FIXTURE_SECRET)
        assert.deepEqual(catalog, [{ ref: LEGACY_MODEL, capacity: 'standard' }])
        const allowed = previousCompatibility(blocked.orchestra.db, catalog)
        assert.deepEqual(allowed, { candidate_plans: 0, in_flight_model_plans: 0, candidate_routing: 0,
          candidate_model_bindings: 0, release_versions: 0 })
        const runtime = await verifyRuntime(previousModelProbe, FIXTURE_SECRET, 'S5')
        modelSettingsReadByPrevious = { withoutCatalog, allowed, catalog, readback, runtime }
        checkpoint(previousModelProbe.orchestra.db, directory, 'settings-read-by-s5.db')
      } finally { await previousModelProbe.close() }
      incompatiblePlan = await proposeIncompatiblePlan(blocked, plan.approval.actor)
      const planCopy = 'candidate-plan.db'
      checkpoint(blocked.orchestra.db, root, planCopy)
      const previousPlanProbe = await bootModelProbe(A.module, join(root, planCopy), 'S5', plan.config_path, root)
      try {
        const response = await fetch(previousPlanProbe.endpoint + '/v1/task-plans/get?plan_id=' + incompatiblePlan.plan_id, {
          headers: { 'x-orchestra-secret': FIXTURE_SECRET }, signal: AbortSignal.timeout(6_000),
        })
        const envelope = await response.json() as { error?: { code: string; details?: { message?: string } } }
        assert.equal(response.status, 503)
        assert.equal(envelope.error?.code, 'SERVICE_UNAVAILABLE')
        assert.match(envelope.error.details?.message ?? '', /preferred_model_ref/)
        planReadByPrevious = { status: response.status, envelope }
      } finally { await previousPlanProbe.close() }
    }
    beforeWindow = snapshot(blocked.orchestra.db)
    checkpoint(blocked.orchestra.db, directory, 'outside-window-before.db')
  } finally { await blocked.close() }
  const windowBlocker = archived.modelSettingsSidecar ? 'candidate_plans' : 'candidate_routing'
  const windowBlocked = await expectFailure(() => step('rollback-table'),
    new RegExp('Previous build cannot interpret candidate data:.*"' + windowBlocker + '":1'))
  const serializedCounts = /Previous build cannot interpret candidate data: (\{[^{}]*\})/.exec(windowBlocked.message)?.[1]
  assert.ok(serializedCounts)
  const incompatibleCounts = JSON.parse(serializedCounts) as Record<string, number>
  assert.deepEqual(incompatibleCounts, { candidate_plans: archived.modelSettingsSidecar ? 1 : 0,
    in_flight_model_plans: 0, candidate_routing: archived.modelSettingsSidecar ? 0 : 1, candidate_model_bindings: 0, release_versions: 0 })
  const afterWindow = snapshot(dbFile)
  assert.equal(canonicalJson(afterWindow), canonicalJson(beforeWindow))
  stageCopy(dbFile, directory, 'outside-window-after.db')
  assert.equal(existsSync(join(root, '7-rollback-table.json')), false)
  assert.equal(existsSync(join(root, 'rollback-fault.json')), false)
  const blockerPath = join(root, 'rollback-blockers.ndjson')
  const rollbackRecords = readFileSync(blockerPath, 'utf8').trim().split(/\r?\n/)
    .map(line => JSON.parse(line) as { decision: string; reason: string })
  assert.deepEqual(rollbackRecords.map(record => record.decision), ['preserve_live_and_review_forward_fix', 'preserve_live_and_review_forward_fix'])
  copyFileSync(blockerPath, join(directory, 'rollback-blockers.ndjson'))
  copyFileSync(join(root, 'failures.ndjson'), join(directory, 'upgrade-failures.ndjson'))
  copyFileSync(join(root, 'external-fence.json'), join(directory, 'negative-external-fence.json'))
  return { upgradeRun, oldHealth, locked, beforeUpgrade, quiesceBlocked, upgradeSkipped, oldAdmission,
    rollbackBlocker, preBlock, rollbackBlocked, deniedOperation, intakeDenied, settings, beforeWindow, afterWindow,
    windowBlocked, rollbackRecords, windowBlocker, incompatibleCounts, incompatiblePlan, candidateSettingsReadback,
    modelSettingsReadByPrevious, planReadByPrevious }
}

export const caseG13S6: FaultCase = async ({ directory }) => {
  const planFile = process.env.ORCHESTRA_G13_ARCHIVED_PLAN ?? (existsSync(join(WORKSPACE, DEVELOPMENT_PLAN))
    ? DEVELOPMENT_PLAN : HISTORICAL_DEVELOPMENT_PLAN)
  const archived = readG13Archive(planFile)
  const { plan, state, live, receipts, archives, cut, runId, ids, migrationCount, syntheticRun } = archived
  const git = (...args: string[]) => execFileSync('git', args, { cwd: WORKSPACE, encoding: 'utf8' }).trim()
  const official = plan.mode === 'candidate'
  if (official) {
    assert.equal(git('rev-parse', 'HEAD'), plan.candidate.source_commit)
    assert.equal(git('status', '--porcelain', '--untracked-files=normal'), '')
    assert.ok(plan.observation_ms >= 600_000)
  }
  const beforeFile = join(directory, 'before.db')
  const afterFile = join(directory, 'after.db')
  copyFileSync(safeInput(join(state, 'backup', 'orchestra.db')), beforeFile)
  stageCopy(join(state, 'compatibility', 'orchestra.db'), directory, 'compatibility.db')
  stageCopy(live, directory, 'after.db')
  checkPrefix(afterFile, cut.before)
  assert.equal(sha256File(beforeFile), archived.taken.db_sha256)
  const prefix = rows(beforeFile, EVENTS, receipts[0]!.seq)
  const breakpointPrefix = rows(afterFile, EVENTS, cut.before.seq)
  assert.deepEqual(breakpointPrefix.slice(0, prefix.length), prefix)
  const pinnedRollback = rows(afterFile, PINNED_RUN, runId)
  assert.equal(pinnedRollback[0]?.status, 'succeeded')
  assert.equal(pinnedRollback[0]?.node_status, 'done')
  for (const [file, source] of [
    ['previous.tgz', archives.previous.archive], ['candidate.tgz', archives.candidate.archive],
    ['T14-plan.json', safeInput(planFile)], ['T14-rollback-fault.json', archived.cutPath],
    ['T14-external-fence.json', archived.fencePath], ['T14-observations.ndjson', archived.observationsPath],
    ['T14-backup-manifest.json', safeInput(join(state, 'backup', 'manifest.json'))],
  ] as const) copyFileSync(source, join(directory, file))
  const receiptFiles = receipts.map((row, i) => {
    const file = (i + 1) + '-' + row.step + '.json'
    copyFileSync(safeInput(join(state, file)), join(directory, file))
    return file
  })
  const negative = await negativeDrill(archived, directory)
  const pending = 'SELECT run_id,node_run_id,status,revision FROM node_runs WHERE run_id=? AND status=?'
  const terminal = "SELECT * FROM events WHERE run_id=? AND type='run.terminal' AND json_extract(payload_redacted,'$.status')='succeeded' ORDER BY seq"
  const baselineMigrations = rows(beforeFile, MIGRATIONS)
  assert.equal(baselineMigrations.length, plan.compatible_floor)
  const finalMigrations = rows(afterFile, MIGRATIONS)
  assert.deepEqual(finalMigrations.slice(0, baselineMigrations.length), baselineMigrations)
  assert.equal(finalMigrations.length, migrationCount)
  const runFacts = { plan_sha256: archived.planSha, compatibility_epochs: archived.runtime, rollback_cut: cut,
    pending_run: pinnedRollback, actual_negative: negative,
    historical_controls: ['tests/integration/recovery-unit-migration.spec.ts', 'tests/integration/clock-recovery.spec.ts'],
    scope: { deployment: 'two independently pinned local archives served on private loopback',
      old_intake: 'T14 external routing fence; old build has no S6 intake switch',
      cut_retention: 'T14 rollback fault original receipt and conserved SQLite event prefix; live SQLite breakpoints retained for new probes',
      operator: 'synthetic authorization for supplemental local negative drill' } }
  writeFileSync(join(directory, 'checks.json'), JSON.stringify(runFacts, null, 2) + '\n')
  return {
    params: { evidence_mode: plan.mode, official_eligible: official, previous_package_sha256: plan.previous.sha256,
      candidate_package_sha256: plan.candidate.sha256, compatible_floor: plan.compatible_floor, observation_ms: plan.observation_ms,
      model_settings_060: archived.modelSettingsSidecar, rollback_window_blocker: negative.windowBlocker },
    sampleIds: { rehearsal_id: plan.rehearsal_id, rolled_back_run: runId, synthetic_run: syntheticRun,
      blocked_upgrade_run: negative.upgradeRun, blocked_rollback_run: negative.rollbackBlocker },
    boundary: { reached: true, t14_rollback_cut: cut.fault, t14_cut_seq: cut.before.seq, fresh_upgrade_wait: true,
      fresh_rollback_wait: true, fresh_rollback_outside_window: true },
    snapshots: { before: { t14_backup: receipts[0]!.facts.snapshot, migrations: baselineMigrations },
      breakpoint: { archive: cut, upgrade: negative.beforeUpgrade, rollback: negative.preBlock, outside_window: negative.beforeWindow },
      after: { t14_recovered: receipts[6]!.facts.state, pinnedRollback, outside_window: negative.afterWindow } },
    queries: {
      half_rows: businessQuery('after.db', `SELECT r.* FROM runs r LEFT JOIN workflow_versions v
        ON r.workflow_id=v.workflow_id AND r.workflow_version=v.version AND r.workflow_definition_hash=v.content_hash
        WHERE r.run_id IN (SELECT value FROM json_each(?)) AND v.workflow_id IS NULL`, 0, JSON.stringify([runId, syntheticRun, ...ids])),
      orphan_runs: businessQuery('after.db', ORPHAN_REFERENCES_SQL, 0),
      missing_events: missingPrefix('after.db', breakpointPrefix),
    },
    extraQueries: {
      t14_backup_migrations: businessQuery('before.db', MIGRATIONS, plan.compatible_floor),
      t14_copy_migrations: businessQuery('compatibility.db', MIGRATIONS, migrationCount),
      t14_compatibility_migrations_after_rollback: businessQuery('after.db', MIGRATIONS, migrationCount),
      t14_rollback_pinned: businessQuery('after.db', PINNED_RUN, 1, runId),
      t14_rollback_terminal: businessQuery('after.db', terminal, 1, runId),
      t14_synthetic_terminal: businessQuery('after.db', terminal, 1, syntheticRun),
      t14_progress: businessQuery('after.db', "SELECT * FROM events WHERE seq>? AND run_id=? ORDER BY seq", 2, cut.before.seq, runId),
      t14_loaded_terminal: businessQuery('after.db',
        "SELECT * FROM events WHERE run_id IN (SELECT value FROM json_each(?)) AND type='run.terminal' AND json_extract(payload_redacted,'$.status')='succeeded' ORDER BY seq",
        ids.length, JSON.stringify(ids)),
      blocked_upgrade_wait: businessQuery('upgrade-waiting.db', pending, 1, negative.upgradeRun, 'waiting'),
      eventual_upgrade_drain: businessQuery('upgrade-drained.db', pending, 1, negative.upgradeRun, 'done'),
      blocked_rollback_wait: businessQuery('rollback-waiting.db', pending, 1, negative.rollbackBlocker, 'waiting'),
      rejected_intake_has_no_run: businessQuery('rollback-waiting.db', 'SELECT * FROM start_run_operations WHERE operation_id=?', 0, negative.deniedOperation),
      ...(negative.incompatiblePlan
        ? {
          old_readable_model_settings: businessQuery('settings-read-by-s5.db',
            `SELECT * FROM model_routing_settings WHERE id=1 AND revision=1 AND json_extract(mapping_json,'$.standard')=?
              AND json_type(mapping_json,'$.advanced') IS NULL AND json_type(mapping_json,'$.expert') IS NULL
              AND json_extract(extended_mapping_json,'$.advanced')=? AND json_extract(extended_mapping_json,'$.expert')=?
              AND json_array_length(model_notes_json)=1 AND json_extract(model_notes_json,'$[0].ref')=?`,
            1, LEGACY_MODEL, ADVANCED_MODEL, ADVANCED_MODEL, ADVANCED_MODEL),
          candidate_plan_preserved: businessQuery('outside-window-after.db', `SELECT p.* FROM task_plans p
            LEFT JOIN start_run_operations o ON o.operation_id=p.launch_operation_id
            WHERE p.plan_id=? AND p.content_hash=? AND o.operation_id IS NULL
              AND json_extract(p.proposal_json,'$.steps[0].complexity')='expert'
              AND json_extract(p.proposal_json,'$.steps[0].preferred_model_ref')=?`,
            1, negative.incompatiblePlan.plan_id, negative.incompatiblePlan.content_hash, ADVANCED_MODEL),
        }
        : {
          candidate_only_data_preserved: businessQuery('outside-window-after.db',
            `SELECT * FROM model_routing_settings WHERE id=1 AND json_extract(mapping_json,'$.advanced')=?
              AND json_array_length(model_notes_json)=1`, 1, ADVANCED_MODEL),
        }),
      outside_window_migrations_preserved: businessQuery('outside-window-after.db', MIGRATIONS, migrationCount),
    },
    checks: {
      positive_runtime_epochs: { actual: archived.runtime.map(value => value.phase), expected: ['S5', 'S6', 'S6', 'S6', 'S5'] },
      outside_window_ledger_unchanged: { actual: negative.afterWindow, expected: negative.beforeWindow },
    },
    artifacts: ['before.db', 'compatibility.db', 'after.db', 'upgrade-waiting.db', 'upgrade-drained.db', 'rollback-waiting.db',
      'outside-window-before.db', 'outside-window-after.db', 'previous.tgz', 'candidate.tgz', 'T14-plan.json', 'T14-rollback-fault.json',
      'T14-external-fence.json', 'T14-observations.ndjson', 'T14-backup-manifest.json', ...receiptFiles,
      'rollback-blockers.ndjson', 'upgrade-failures.ndjson', 'negative-external-fence.json', 'negative-plan.json',
      'previous-rehearsal-host.mjs', 'checks.json',
      ...(negative.modelSettingsReadByPrevious ? ['settings-read-by-s5.db'] : [])],
    extra: runFacts,
  }
}
