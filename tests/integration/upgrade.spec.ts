import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from '../../src/core/canonical.ts'
import { readUpgradeReceipts, rehearseUpgrade, PREVIOUS_SIGNED_BUILD, UPGRADE_STEPS, validateUpgradePlan, type UpgradePlan } from '../../scripts/upgrade.ts'
import { sha256File } from '../../src/infra/backup.ts'
import { openDb, withTx } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { previousCompatibility, snapshot, upgradeBlockers, verifyPrefix } from '../../scripts/upgrade-host.ts'

function fixture() {
  mkdirSync(resolve('tmp'), { recursive: true })
  const dir = mkdtempSync(resolve('tmp', 'upgrade-contract-'))
  const state = join(dir, 'state')
  const config = join(dir, 'config.json')
  writeFileSync(config, '{}')
  const plan: UpgradePlan = {
    schema_version: 1, rehearsal_id: 'contract-t14', mode: 'development', config_path: config, config_sha256: sha256File(config),
    state_dir: state, live_db: join(state, 'orchestra.db'), compatible_floor: 57, observation_ms: 100,
    previous: { archive: join(dir, 's5.tgz'), sha256: 'a'.repeat(64), source_commit: PREVIOUS_SIGNED_BUILD },
    candidate: { archive: join(dir, 's6.tgz'), sha256: 'b'.repeat(64), source_commit: 'c'.repeat(40) },
    approval: { actor: 'fixture:operator', approved_at: new Date().toISOString(),
      operation_id: '01954f79-552b-73d1-87d8-4e01f1f75043', proof_sha256: sha256Hex('contract-proof') },
  }
  return { dir, plan, close: () => rmSync(dir, { recursive: true, force: true }) }
}

it('检查候选窗口、旧签名、配置、路径和授权失效，拒绝影响非隔离账本', () => {
  const item = fixture()
  try {
    const { plan } = item
    expect(validateUpgradePlan(plan)).toEqual(plan)
    expect(() => validateUpgradePlan({ ...plan, mode: 'candidate' })).toThrow(/ten minutes/)
    expect(() => validateUpgradePlan({ ...plan, previous: { ...plan.previous, source_commit: plan.candidate.source_commit } })).toThrow(/signed G5/)
    expect(() => validateUpgradePlan({ ...plan, previous_host: { source_commit: plan.previous.source_commit,
      archive_sha256: plan.candidate.sha256, module_sha256: plan.config_sha256 } })).toThrow(/registration does not match/)
    expect(() => validateUpgradePlan({ ...plan, live_db: join(resolve('tmp'), 'external.db') })).toThrow(/boundary/)
    expect(() => validateUpgradePlan({ ...plan, approval: { ...plan.approval,
      approved_at: '2026-01-01T00:00:00.000Z' } })).toThrow(/expired/)
    writeFileSync(plan.config_path, '{"policy":"changed"}')
    expect(() => validateUpgradePlan(plan)).toThrow(/checksum/)
  } finally { item.close() }
})

it('拒绝跳步、错演练、被篡改的回执及回退水位', async () => {
  const item = fixture()
  const { plan } = item
  try {
    await expect(rehearseUpgrade(plan, 'rollback-table', 't14-long-enough-secret', 'wrong')).rejects.toThrow(/operator proof/)
    expect(existsSync(plan.state_dir)).toBe(false)
    await expect(rehearseUpgrade(plan, 'rollback-table', 't14-long-enough-secret', 'contract-proof')).rejects.toThrow(/in order/)
    const planSha = sha256Hex(canonicalJson(plan))
    const at = new Date().toISOString()
    const data = { schema_version: 1, step: 'backup', plan_sha256: planSha, rehearsal_id: plan.rehearsal_id,
      previous_sha256: null, started_at: at, finished_at: at, seq: 10, facts: { example: true } }
    const first = { ...data, sha256: sha256Hex(canonicalJson(data)) }
    const firstFile = join(plan.state_dir, '1-backup.json')
    writeFileSync(firstFile, JSON.stringify(first))
    expect(readUpgradeReceipts(plan.state_dir, plan.rehearsal_id, planSha)).toEqual([first])
    expect(await rehearseUpgrade(plan, 'backup', 't14-long-enough-secret', 'contract-proof')).toEqual(first)
    expect(() => readUpgradeReceipts(plan.state_dir, 'another-identity', planSha)).toThrow(/mismatched/)
    const step2 = { ...data, step: 'verify-copy', previous_sha256: first.sha256, seq: 9 }
    writeFileSync(join(plan.state_dir, '2-verify-copy.json'), JSON.stringify({ ...step2, sha256: sha256Hex(canonicalJson(step2)) }))
    expect(() => readUpgradeReceipts(plan.state_dir, plan.rehearsal_id, planSha)).toThrow(/out-of-order/)
    writeFileSync(firstFile, readFileSync(firstFile, 'utf8').replace('"seq":10', '"seq":11'))
    expect(() => readUpgradeReceipts(plan.state_dir, plan.rehearsal_id, planSha)).toThrow(/mismatched/)
    expect(UPGRADE_STEPS[6]).toBe('rollback-table')
  } finally { item.close() }
})

it('旧构建兼容窗口拒绝五档配置、在途动作和账本原像漂移', () => {
  const db = openDb(':memory:')
  try {
    applySteps(db, loadSteps(defaultMigrationsDir()))
    expect(previousCompatibility(db)).toMatchObject({ candidate_plans: 0, candidate_routing: 0, release_versions: 0 })
    expect(upgradeBlockers(db).pending).toBe(0)
    const before = snapshot(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO model_routing_settings(id,revision,mapping_json,updated_by,updated_at) VALUES(1,1,'{\"routine\":null,\"standard\":null,\"complex\":null,\"expert\":null}','tester','2026-11-20T00:00:00Z')")
      tx.run("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running','2026-11-20','2026-11-20')")
      tx.run("INSERT INTO runs(run_id,task_id,status,created_at,updated_at) VALUES('r','t','running','2026-11-20','2026-11-20')")
      tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,created_at,updated_at) VALUES('n','r','n',1,'agent','queued','2026-11-20','2026-11-20')")
      tx.run("INSERT INTO workflow_versions(workflow_id,version,content_hash,definition_json,created_at) VALUES('wf','1','sha','{}','2026-11-20')")
    })
    expect(() => previousCompatibility(db)).toThrow(/candidate_routing/)
    expect(() => upgradeBlockers(db)).toThrow(/pending/)
    expect(() => verifyPrefix(db, before)).toThrow(/fixed version/)
  } finally { db.raw.close() }
})

it('同一模型编号在旧宿主档位不足时不能回退', () => {
  const db = openDb(':memory:')
  try {
    applySteps(db, loadSteps(defaultMigrationsDir()))
    withTx(db, (tx) => tx.run('INSERT INTO model_routing_settings(id,revision,mapping_json,updated_by,updated_at) VALUES(1,1,?,?,?)',
      [JSON.stringify({ routine: null, standard: null, complex: 'shared' }), 'tester', '2026-11-20T00:00:00Z']))
    expect(() => previousCompatibility(db, [{ ref: 'shared', capacity: 'standard' }]))
      .toThrow(/previous_catalog_missing_or_insufficient/)
    expect(() => previousCompatibility(db)).toThrow(/previous_catalog_unverified/)
    expect(previousCompatibility(db, [{ ref: 'shared', capacity: 'complex' }])).toMatchObject({ candidate_model_bindings: 0 })
  } finally { db.raw.close() }
})
