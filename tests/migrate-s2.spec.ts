import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OrchError, proposedError, PROPOSED_ERROR_CODES } from '../src/core/errors.ts'
import { openDb } from '../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../src/infra/db/migrate.ts'
import { parseConfig } from '../src/core/config.ts'

const dirs: string[] = []
function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-mig-s2-'))
  dirs.push(dir)
  return join(dir, 'orchestra.db')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const columns = (raw: { prepare: (sql: string) => { all: () => unknown[] } }, table: string): string[] =>
  (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)

const applied = (raw: { prepare: (sql: string) => { all: () => unknown[] } }): number[] =>
  (raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => r.version)

const config = (over: Record<string, unknown> = {}) => ({
  phase: 'S2',
  service: { db_path: 'x.db', busy_timeout_ms: 5000 },
  execution: {
    concurrency: 3, human_slots: 1, startup_timeout_ms: 60000, unknown_watchdog_ms: 120000,
    verify_timeout_ms: 120000, lease_ttl_ms: 30000, lease_renew_interval_ms: 10000,
    action_timeout_ms: 120000, cancel_grace_ms: 30000,
    ...(over.execution as Record<string, unknown> | undefined),
  },
  bridge: {
    buffer_high_water_bytes: 4194304, buffer_limit_bytes: 8388608,
    spill_dir: 'storages/dsh-orchestra/bridge-spill',
    ...(over.bridge as Record<string, unknown> | undefined),
  },
  retention: { receipt_days: 7, in_flight_timeout_minutes: 10 },
  memory: { bridge_id: 'local', eval_timeout_ms: 30000, judge_content_limit: 20000, approval_ttl_hours: 24 },
})

describe('S2 迁移与定值', () => {
  it('空库跑到 002：node_runs 补齐 S2 列，默认 0', () => {
    const db = openDb(dbFile())
    expect(applySteps(db, loadSteps(defaultMigrationsDir()))).toEqual([1, 2])
    const cols = columns(db.raw, 'node_runs')
    for (const need of ['action_generation', 'rearm_generation', 'fence_state', 'fence_grace_until', 'deadline_boot_id', 'deadline_monotonic_ns', 'tool_start_at', 'verify_remaining_ns', 'side_effect_verified_none', 'stop_evidence']) {
      expect(cols).toContain(need)
    }
    const row = db.raw.prepare("SELECT action_generation, rearm_generation, side_effect_verified_none FROM node_runs WHERE 1 = 0").all()
    expect(row).toEqual([])
    try {
      db.raw.prepare("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1','t','queued',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run()
      db.raw.prepare("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1','t1','queued',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run()
      db.raw.prepare("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, status, created_at, updated_at) VALUES ('n1','r1','start',1,'agent','queued','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run()
      const got = db.raw.prepare("SELECT action_generation, rearm_generation, side_effect_verified_none FROM node_runs WHERE node_run_id='n1'").get() as Record<string, number>
      expect(got.action_generation).toBe(0)
      expect(got.rearm_generation).toBe(0)
      expect(got.side_effect_verified_none).toBe(0)
    } finally {
      db.raw.close()
    }
  })

  it('report_registry 的 status 改名成 state，能写 applied，bogus 由应用层拒（迁移层不校验）', () => {
    const db = openDb(dbFile())
    applySteps(db, loadSteps(defaultMigrationsDir()))
    const cols = columns(db.raw, 'report_registry')
    expect(cols).not.toContain('status')
    expect(cols).toContain('state')
    expect(cols).toContain('attempt')
    expect(cols).toContain('report_seq')
    db.raw.prepare("INSERT INTO report_registry (report_id, node_run_id, state, revision, attempt, report_seq, created_at, updated_at) VALUES ('p1','n1','applied',0,1,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run()
    expect((db.raw.prepare("SELECT state FROM report_registry WHERE report_id='p1'").get() as { state: string }).state).toBe('applied')
    db.raw.close()
  })

  it('跑第二遍不报错，schema_migrations 仍是两行', () => {
    const db = openDb(dbFile())
    const steps = loadSteps(defaultMigrationsDir())
    applySteps(db, steps)
    expect(applySteps(db, loadSteps(defaultMigrationsDir()))).toEqual([])
    expect(applied(db.raw)).toEqual([1, 2])
    expect(steps.length).toBe(2)
    db.raw.close()
  })

  it('配置能读出四个 execution 新键与 bridge.spill_dir', () => {
    const cfg = parseConfig(config())
    expect(cfg.execution.lease_ttl_ms).toBe(30000)
    expect(cfg.execution.lease_renew_interval_ms).toBe(10000)
    expect(cfg.execution.action_timeout_ms).toBe(120000)
    expect(cfg.execution.cancel_grace_ms).toBe(30000)
    expect(cfg.bridge.spill_dir).toBe('storages/dsh-orchestra/bridge-spill')
  })

  it('心跳间隔不小于租约时长 → SCHEMA_VERSION_UNSUPPORTED，details 带路径', () => {
    let err: unknown
    try {
      parseConfig(config({ execution: { lease_renew_interval_ms: 30000 } }))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(OrchError)
    const code = (err as OrchError).code
    expect(code).toBe('SCHEMA_VERSION_UNSUPPORTED')
    const issues = (err as OrchError).details.issues as { path: string }[]
    expect(issues.map((i) => i.path)).toContain('execution.lease_renew_interval_ms')
  })

  it('提案码能装进 OrchError：409 且 details.proposed=true，不进 ERROR_STATUS', () => {
    const err = proposedError('LEASE_EXPIRED', '租约过期了', { node_run_id: 'n1' })
    expect(err.code).toBe('LEASE_EXPIRED')
    expect(err.httpStatus).toBe(409)
    expect(err.details.proposed).toBe(true)
    expect(PROPOSED_ERROR_CODES.LEASE_EXPIRED).toBe(409)
    expect(Object.keys(PROPOSED_ERROR_CODES)).not.toContain('UNAUTHORIZED')
  })
})
