import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { canonicalJson, sha256Hex } from '../src/core/canonical.ts'
import { backup, restore, sha256File, verifyBackup } from '../src/infra/backup.ts'
import { acquireDbLock } from '../src/infra/lock.ts'
import { openDb } from '../src/infra/sqlite/driver.ts'
import { inspectPackage } from './package-acceptance.ts'
import { bootBuild, completeRun, ensureRehearsalWorkflow, head, loadPreviousHost, loadUpgradeBuild, operationId,
  previousCompatibility, readPreviousModelCatalog, request, snapshot, startRun, upgradeBlockers, verifyPrefix, verifyRuntime, waitWorkflow } from './upgrade-host.ts'

export const PREVIOUS_SIGNED_BUILD = '2f07617a2cfe1b5b8a069c0b1b3d73aad24549ce'
export const UPGRADE_STEPS = ['backup', 'verify-copy', 'quiesce', 'healthcheck', 'synthetic-run', 'observe', 'rollback-table'] as const
type Step = (typeof UPGRADE_STEPS)[number]
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const commit = z.string().regex(/^[a-f0-9]{40}$/)
const pkg = z.strictObject({ archive: z.string(), sha256: hash, source_commit: commit })
export const upgradePlanSchema = z.strictObject({
  schema_version: z.literal(1),
  rehearsal_id: z.string().regex(/^[\w-]{8,96}$/),
  mode: z.enum(['development', 'candidate']),
  previous: pkg,
  previous_host: z.strictObject({ module_sha256: hash, source_commit: commit, archive_sha256: hash }).optional(),
  candidate: pkg,
  live_db: z.string(),
  state_dir: z.string(),
  config_path: z.string(),
  config_sha256: hash,
  compatible_floor: z.literal(57),
  observation_ms: z.number().int().min(100).max(86_400_000),
  approval: z.strictObject({ actor: z.string().min(1).max(128), approved_at: z.iso.datetime(), operation_id: z.uuidv7(), proof_sha256: hash }),
})
export type UpgradePlan = z.infer<typeof upgradePlanSchema>
const receiptData = z.strictObject({
  schema_version: z.literal(1),
  step: z.enum(UPGRADE_STEPS),
  plan_sha256: hash,
  rehearsal_id: z.string(),
  previous_sha256: hash.nullable(),
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime(),
  seq: z.number().int().nonnegative(),
  facts: z.record(z.string(), z.unknown()),
})
const receiptSchema = receiptData.extend({ sha256: hash })
type Receipt = z.infer<typeof receiptSchema>

function isolatedPath(path: string, boundary: string) {
  const absolute = resolve(path)
  const offset = relative(boundary, absolute)
  if (!offset || offset.startsWith('..') || isAbsolute(offset)) throw new Error('Path is outside the rehearsal boundary: ' + path)
  for (let at = absolute; at !== boundary; at = dirname(at)) {
    if (lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('No linked rehearsal paths: ' + path)
  }
  return absolute
}

export function validateUpgradePlan(input: unknown, workspace = process.cwd()) {
  const plan = upgradePlanSchema.parse(input)
  const tmp = resolve(workspace, 'tmp')
  if (lstatSync(tmp, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Rehearsal tmp must be a real directory')
  const state = isolatedPath(plan.state_dir, tmp)
  const live = isolatedPath(plan.live_db, state)
  const config = isolatedPath(plan.config_path, tmp)
  const previousArchive = isolatedPath(plan.previous.archive, tmp)
  const candidateArchive = isolatedPath(plan.candidate.archive, tmp)
  if (plan.previous.source_commit !== PREVIOUS_SIGNED_BUILD || plan.previous.sha256 === plan.candidate.sha256) {
    throw new Error('Previous must be the signed G5 build and the candidate must be distinct')
  }
  if (plan.previous_host && (plan.previous_host.source_commit !== plan.previous.source_commit
    || plan.previous_host.archive_sha256 !== plan.previous.sha256)) {
    throw new Error('Previous host registration does not match the previous build')
  }
  if (plan.mode === 'candidate' && (plan.observation_ms < 600_000 || plan.candidate.source_commit === PREVIOUS_SIGNED_BUILD)) {
    throw new Error('Candidate rehearsal needs a distinct frozen commit and at least ten minutes')
  }
  if (plan.mode === 'candidate') {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim()
    if (git('rev-parse', 'HEAD') !== plan.candidate.source_commit || git('status', '--porcelain', '--untracked-files=normal')) {
      throw new Error('Candidate rehearsal requires the exact clean Git candidate')
    }
  }
  if (Number(Date.parse(plan.approval.approved_at)) > Date.now() || Date.now() - Date.parse(plan.approval.approved_at) > 86_400_000) {
    throw new Error('Rehearsal approval has expired or is not yet effective')
  }
  if (sha256File(config) !== plan.config_sha256) throw new Error('Rehearsal configuration checksum mismatch')
  return { ...plan, state_dir: state, live_db: live, config_path: config,
    previous: { ...plan.previous, archive: previousArchive }, candidate: { ...plan.candidate, archive: candidateArchive } }
}

function persist(file: string, content: unknown) {
  const staging = file + '.' + randomUUID() + '.pending'
  try {
    writeFileSync(staging, JSON.stringify(content, null, 2) + '\n', { flag: 'wx' })
    if (existsSync(file)) throw new Error('Rehearsal output already exists: ' + file)
    renameSync(staging, file)
  } finally { rmSync(staging, { force: true }) }
}

function receiptPath(root: string, index: number) {
  return join(root, `${index + 1}-${UPGRADE_STEPS[index]}.json`)
}

export function readUpgradeReceipts(root: string, identity: string, planSha: string) {
  const ordered: Receipt[] = []
  for (const [index, step] of UPGRADE_STEPS.entries()) {
    const path = receiptPath(root, index)
    if (!existsSync(path)) continue
    const { sha256, ...data } = receiptSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    const prior = ordered.at(-1)
    if (ordered.length !== index || data.step !== step || data.rehearsal_id !== identity || data.plan_sha256 !== planSha
      || data.previous_sha256 !== (prior?.sha256 ?? null) || sha256 !== sha256Hex(canonicalJson(data))
      || data.seq < (prior?.seq ?? 0) || data.finished_at < data.started_at
      || (prior && data.started_at < prior.finished_at)) throw new Error('Broken, out-of-order or mismatched rehearsal receipt')
    ordered.push({ ...data, sha256 })
  }
  return ordered
}

export async function rehearseUpgrade(input: unknown, command: 'run' | Step, secret: string, proof: string,
  workspace = process.cwd(), previousHostPath = process.env.ORCHESTRA_REHEARSAL_PREVIOUS_HOST) {
  const plan = validateUpgradePlan(input, workspace)
  if (secret.length < 16 || !proof || sha256Hex(proof) !== plan.approval.proof_sha256) throw new Error('Rehearsal requires operator proof and a private ledger secret')
  const planSha = sha256Hex(canonicalJson(plan))
  const id = plan.rehearsal_id
  const root = plan.state_dir
  mkdirSync(root, { recursive: true })
  const release = await acquireDbLock(join(root, 'upgrade'))
  try {
    const ownerMarker = join(root, 'owner.json')
    if (!existsSync(ownerMarker)) {
      if (existsSync(plan.live_db)) throw new Error('Will not operate on an existing unclaimed ledger')
      persist(ownerMarker, { rehearsal_id: id, plan_sha256: planSha })
    }
    const owner = JSON.parse(readFileSync(ownerMarker, 'utf8')) as { rehearsal_id: string; plan_sha256: string }
    if (owner.rehearsal_id !== id || owner.plan_sha256 !== planSha) throw new Error('Rehearsal target is already claimed')
    const receipts = readUpgradeReceipts(root, id, planSha)
    if (command !== 'run') {
      const requested = UPGRADE_STEPS.indexOf(command)
      if (requested > receipts.length) throw new Error('Upgrade steps must execute in order')
      if (requested < receipts.length) return receipts[requested]!
    }
    const previous = await loadUpgradeBuild(plan.previous, join(root, 'build-s5'), true)
    const candidate = await loadUpgradeBuild(plan.candidate, join(root, 'build-s6'), false)
    if (previous.inspected.migrations.length !== plan.compatible_floor
      || candidate.inspected.migrations.length <= plan.compatible_floor) throw new Error('Build migration windows do not match the plan')

    const boot = async (version: 'S5' | 'S6', target = plan.live_db) => {
      const module = (version === 'S5' ? previous : candidate).module
      const executor = version === 'S5' && plan.previous_host
        ? await loadPreviousHost(plan.previous_host, plan.previous, module, previousHostPath)
        : undefined
      mkdirSync(dirname(target), { recursive: true })
      return bootBuild(module, target, secret, version, plan.config_path, executor)
    }
    const using = async <T>(version: 'S5' | 'S6', fn: (service: Awaited<ReturnType<typeof boot>>) => Promise<T>, target?: string) => {
      const service = await boot(version, target)
      try { return await fn(service) } finally { await service.close() }
    }
    const intakeFor = (service: Awaited<ReturnType<typeof boot>>) => candidate.module.createIntakeControl(service.orchestra.db, {
      authenticate: (value) => sha256Hex(value) === plan.approval.proof_sha256 ? plan.approval.actor : null,
    })
    const takeSnapshot = () => snapshot(plan.live_db)
    const fork = join(root, 'compatibility', 'orchestra.db')
    const previousCatalog = async (service: Awaited<ReturnType<typeof boot>>) => {
      const profiles = await readPreviousModelCatalog(service, secret)
      if (plan.previous_host && !profiles) throw new Error('Registered previous host did not expose its approved model catalog')
      return profiles
    }
    const backupDir = join(root, 'backup')
    const fenceFile = join(root, 'external-fence.json')
    const transition = async (step: Step): Promise<Record<string, unknown>> => {
      if (step === 'backup') {
        if (!existsSync(join(backupDir, 'manifest.json'))) {
          await using('S5', async (service) => {
            await ensureRehearsalWorkflow(service, secret, id)
            const baselineRun = await startRun(service, secret, id, 'before-upgrade')
            await completeRun(service, secret, baselineRun)
            previous.module.registerRunArtifact(service.orchestra.db, { artifactId: 'baseline-' + id, runId: baselineRun,
              fileName: 'upgrade-proof.txt', bytes: Buffer.from('Managed rollback proof ' + id) })
            await verifyRuntime(service, secret, 'S5')
            backup(plan.live_db, backupDir)
          })
        }
        const manifest = verifyBackup(backupDir)
        const safety = snapshot(join(backupDir, 'orchestra.db'))
        if (safety.migrations.length !== plan.compatible_floor || safety.artifacts < 1 || safety.seq !== takeSnapshot().seq) {
          throw new Error('Pre-upgrade backup did not capture the old live watermark and artifacts')
        }
        return { manifest, snapshot: safety }
      }
      if (step === 'verify-copy') {
        if (!existsSync(fork)) restore(backupDir, fork)
        const before = snapshot(join(backupDir, 'orchestra.db'))
        const previousProfiles = await using('S5', previousCatalog, fork)
        const newer = await using('S6', async (service) => {
          verifyPrefix(service.orchestra.db, before)
          return { ...await verifyRuntime(service, secret, 'S6'), compatibility: previousCompatibility(service.orchestra.db, previousProfiles) }
        }, fork)
        const older = await using('S5', async (service) => {
          verifyPrefix(service.orchestra.db, before)
          previousCompatibility(service.orchestra.db, await previousCatalog(service))
          return verifyRuntime(service, secret, 'S5')
        }, fork)
        if (newer.state.migrations.length !== candidate.inspected.migrations.length
          || older.state.migrations.length !== newer.state.migrations.length) throw new Error('Both real builds did not read the upgraded migration window')
        if (takeSnapshot().event_sha256 !== before.event_sha256) throw new Error('Live ledger changed during the isolated compatibility probe')
        return { newer, older, live_untouched: true, previous_model_catalog: previousProfiles ?? null,
          model_probe_scope: previousProfiles ? 'approved catalog read from old host' : 'wait-only rehearsal, no old model route' }
      }
      if (step === 'quiesce') {
        if (!existsSync(fenceFile)) persist(fenceFile, { rehearsal_id: id, plan_sha256: planSha, pause_seq: takeSnapshot().seq })
        return using('S5', async (service) => ({
          ...await verifyRuntime(service, secret, 'S5'), external_fence: 'private rehearsal endpoints',
          blockers: upgradeBlockers(service.orchestra.db),
        }))
      }
      if (step === 'healthcheck') {
        const before = snapshot(join(backupDir, 'orchestra.db'))
        return using('S6', async (service) => {
          verifyPrefix(service.orchestra.db, before)
          const intake = intakeFor(service)
          if (!intake.get().paused) intake.pause(proof, 'T14 verification while external intake is fenced')
          try {
            await request(service, secret, '/v1/runs/start', { workflowId: waitWorkflow, workflowVersion: '1',
              taskTitle: 'Paused probe', operationId: operationId(id, 'paused-probe') })
            throw new Error('Root run admitted while paused')
          } catch (error) {
            if ((error as { code?: string }).code !== 'SERVICE_UNAVAILABLE') throw error
          }
          return { ...await verifyRuntime(service, secret, 'S6'), intake: intake.get() }
        })
      }
      if (step === 'synthetic-run') {
        return using('S6', async (service) => {
          const intake = intakeFor(service)
          if (intake.get().paused) intake.resume(proof, 'Private synthetic admission')
          try {
            const runId = await startRun(service, secret, id, 'synthetic')
            return { run_id: runId, wake_seq: await completeRun(service, secret, runId), ...await verifyRuntime(service, secret, 'S6') }
          } finally {
            if (!intake.get().paused) intake.pause(proof, 'Synthetic admission complete')
          }
        })
      }
      if (step === 'observe') {
        return using('S6', async (service) => {
          const intake = intakeFor(service)
          if (intake.get().paused) intake.resume(proof, 'Controlled load observation')
          const observeFile = join(root, 'observations.ndjson')
          const record = (row: object) => appendFileSync(observeFile, JSON.stringify(row) + '\n')
          try {
            const interrupted = new Set<string>()
            if (existsSync(observeFile)) for (const line of readFileSync(observeFile, 'utf8').trim().split(/\r?\n/)) {
              const row = JSON.parse(line) as { action?: string; stage?: string }
              if (!row.action) continue
              if (row.stage === 'pending') interrupted.add(row.action)
              else interrupted.delete(row.action)
            }
            for (const action of interrupted) {
              const runId = await startRun(service, secret, id, action)
              record({ action, stage: 'recovered', run_id: runId, seq: await completeRun(service, secret, runId) })
            }
            const window = randomUUID()
            const begin = performance.now()
            let count = 0
            let seq = head(service.orchestra.db)
            do {
              const action = 'load-' + window + '-' + count
              record({ window, action, stage: 'pending' })
              const runId = await startRun(service, secret, id, action)
              const next = await completeRun(service, secret, runId)
              if (next <= seq) throw new Error('Observation did not make durable progress')
              seq = next
              count++
              record({ window, action, stage: 'completed', run_id: runId, seq, elapsed_ms: performance.now() - begin, index: count })
              await delay(Math.min(Math.max(10, plan.observation_ms / 20), 30_000))
            } while (performance.now() - begin < plan.observation_ms || count < 2)
            const pending = await startRun(service, secret, id, 'rollback-inflight')
            return { window, loaded_runs: count, observation_ms: performance.now() - begin, rollback_pending_run: pending,
              ...await verifyRuntime(service, secret, 'S6') }
          } catch (error) {
            if (!intake.get().paused) intake.pause(proof, 'Interrupted upgrade observation')
            throw error
          }
        })
      }
      const waitingRun = z.string().parse(receipts[5]?.facts.rollback_pending_run)
      const faultFile = join(root, 'rollback-fault.json')
      const pendingVersion = { run_id: waitingRun, workflow_version: 1 }
      if (!existsSync(faultFile)) {
        const previousProfiles = await using('S5', previousCatalog, fork)
        const fault = await using('S6', async (service) => {
          previousCompatibility(service.orchestra.db, previousProfiles)
          const pending = await request<{ status: string; workflow_version: number }>(service, secret, '/v1/runs/get?run_id=' + waitingRun)
          if (pending.status !== 'running' || pending.workflow_version !== 1) throw new Error('Rollback load seam was not in flight')
          const intake = intakeFor(service)
          if (!intake.get().paused) intake.pause(proof, 'T14 rollback boundary')
          const compatibility = previousCompatibility(service.orchestra.db, previousProfiles)
          const blockers = upgradeBlockers(service.orchestra.db, waitingRun)
          return { before: snapshot(service.orchestra.db), endpoint: service.endpoint, compatibility, blockers, pending: pendingVersion }
        })
        let refused = false
        try { await fetch(fault.endpoint + '/health', { signal: AbortSignal.timeout(3000) }) } catch { refused = true }
        if (!refused) throw new Error('Candidate endpoint survived the controlled rollback outage')
        persist(faultFile, { ...fault, fault: 'candidate_listener_unavailable', authorization: plan.approval.actor })
      }
      const fault = JSON.parse(readFileSync(faultFile, 'utf8')) as { before: ReturnType<typeof snapshot>; fault: string; authorization: string }
      // A retry after the recorded outage must recheck before even advancing the old writer's epoch.
      const fencedProfiles = await using('S5', previousCatalog, fork)
      const reader = openDb(plan.live_db, { readonly: true })
      try {
        previousCompatibility(reader, fencedProfiles)
        upgradeBlockers(reader, waitingRun)
        verifyPrefix(reader, fault.before)
      } finally { reader.raw.close() }
      return using('S5', async (service) => {
        verifyPrefix(service.orchestra.db, fault.before)
        const restartedProfiles = await previousCatalog(service)
        previousCompatibility(service.orchestra.db, restartedProfiles)
        const before = fault.before.seq
        const after = await completeRun(service, secret, waitingRun)
        if (after <= before) throw new Error('Rollback did not continue the original live ledger')
        return { decision: 'switch_runtime_only', approval_actor: fault.authorization, fault: fault.fault,
          restored_run: pendingVersion, before_seq: before, after_seq: after, previous_model_catalog: restartedProfiles ?? null,
          ...await verifyRuntime(service, secret, 'S5') }
      })
    }

    const start = receipts.length
    const end = command === 'run' ? UPGRADE_STEPS.length : start + 1
    for (let index = start; index < end; index++) {
      const step = UPGRADE_STEPS[index]!
      const started = new Date().toISOString()
      try {
        const facts = await transition(step)
        const data = receiptData.parse({ schema_version: 1, step, plan_sha256: planSha, rehearsal_id: id,
          previous_sha256: receipts.at(-1)?.sha256 ?? null, started_at: started, finished_at: new Date().toISOString(),
          seq: takeSnapshot().seq, facts })
        const receipt = { ...data, sha256: sha256Hex(canonicalJson(data)) }
        persist(receiptPath(root, index), receipt)
        receipts.push(receipt)
      } catch (error) {
        appendFileSync(join(root, 'failures.ndjson'), JSON.stringify({ step, plan_sha256: planSha,
          started_at: started, failed_at: new Date().toISOString(), reason: String(error) }) + '\n')
        if (step === 'rollback-table') {
          appendFileSync(join(root, 'rollback-blockers.ndjson'), JSON.stringify({ plan_sha256: planSha,
            decision: 'preserve_live_and_review_forward_fix', reason: String(error) }) + '\n')
        }
        throw error
      }
    }
    return command === 'run' ? receipts : receipts.at(-1)!
  } finally { await release() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [kind, ...args] = process.argv.slice(2)
    if (kind === '--help') {
      console.log('Usage: node scripts/upgrade.ts <dry-run|run|step NAME> --plan <plan.json>')
      console.log('For a registered previous_host, set ORCHESTRA_REHEARSAL_PREVIOUS_HOST to the pinned local executor module.')
    } else {
      const step = kind === 'step' ? z.enum(UPGRADE_STEPS).parse(args.shift()) : z.enum(['dry-run', 'run']).parse(kind)
      if (args.length !== 2 || args[0] !== '--plan' || !args[1]) throw new Error('Specify --plan <plan.json>')
      const input = JSON.parse(readFileSync(args[1], 'utf8')) as unknown
      const plan = validateUpgradePlan(input)
      const result = step === 'dry-run' ? { action: 'dry-run', mode: plan.mode, rehearsal_id: plan.rehearsal_id,
        previous: inspectPackage(plan.previous.archive, { previous: true, expectedSha256: plan.previous.sha256 }),
        candidate: inspectPackage(plan.candidate.archive, { expectedSha256: plan.candidate.sha256 }) }
        : await rehearseUpgrade(input, step, process.env.ORCHESTRA_REHEARSAL_SECRET ?? '', process.env.ORCHESTRA_REHEARSAL_PROOF ?? '')
      console.log(JSON.stringify(result, null, 2))
    }
  } catch (error) {
    process.stderr.write(String(error) + '\n')
    process.exitCode = 1
  }
}
