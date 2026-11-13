import { describe, expect, it } from 'vitest'
import { closeSync, openSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OrchError } from '../src/core/errors.ts'
import { PHASE_CAPABILITIES, loadConfig, parseConfig, phaseIndex, requireCapability, requirePhase } from '../src/core/config.ts'

const SAMPLE = {
  phase: 'S1',
  service: { db_path: 'storages/dsh-orchestra/orchestra.db', busy_timeout_ms: 5000 },
  execution: { concurrency: 3, human_slots: 1, startup_timeout_ms: 60000, unknown_watchdog_ms: 120000, verify_timeout_ms: 120000 },
  bridge: { buffer_high_water_bytes: 4194304, buffer_limit_bytes: 8388608 },
  retention: { receipt_days: 7, in_flight_timeout_minutes: 10 },
  memory: { bridge_id: 'memory-audit-v1', eval_timeout_ms: 120000, judge_content_limit: 4000, approval_ttl_hours: 24 },
}

const clone = () => JSON.parse(JSON.stringify(SAMPLE))

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(OrchError)
    expect((err as OrchError).code).toBe(code)
    return err as OrchError
  }
  throw new Error('本应抛错却通过了')
}

describe('配置 schema', () => {
  it('仓库里的 orchestra.config.json 能加载，phase 为 S1', () => {
    const cfg = loadConfig(join(process.cwd(), 'orchestra.config.json'))
    expect(cfg.phase).toBe('S1')
    expect(phaseIndex(cfg.phase)).toBe(0)
  })

  it('规格样例形状能解析', () => {
    expect(parseConfig(clone()).bridge.buffer_limit_bytes).toBe(8388608)
  })

  it('未知 phase（S7）→ SCHEMA_VERSION_UNSUPPORTED', () => {
    const bad = { ...clone(), phase: 'S7' }
    expectCode(() => parseConfig(bad), 'SCHEMA_VERSION_UNSUPPORTED')
  })

  it('未知顶层键 → 抛错且 details.issues 带该键', () => {
    const bad = { ...clone(), extra: 1 }
    const err = expectCode(() => parseConfig(bad), 'SCHEMA_VERSION_UNSUPPORTED')
    expect(JSON.stringify(err.details.issues)).toContain('extra')
  })

  it('未知嵌套键 → 抛错且 details.issues 带嵌套路径', () => {
    const bad = clone()
    bad.service.surprise = 1
    const err = expectCode(() => parseConfig(bad), 'SCHEMA_VERSION_UNSUPPORTED')
    expect(JSON.stringify(err.details.issues)).toContain('service')
  })

  it('越界值 busy_timeout_ms 0 与 5000.5 → 抛错', () => {
    const zero = clone(); zero.service.busy_timeout_ms = 0
    expectCode(() => parseConfig(zero), 'SCHEMA_VERSION_UNSUPPORTED')
    const frac = clone(); frac.service.busy_timeout_ms = 5000.5
    expectCode(() => parseConfig(frac), 'SCHEMA_VERSION_UNSUPPORTED')
  })

  it('跨字段 buffer_high_water_bytes >= buffer_limit_bytes → 抛错', () => {
    const bad = clone(); bad.bridge.buffer_high_water_bytes = bad.bridge.buffer_limit_bytes
    const err = expectCode(() => parseConfig(bad), 'SCHEMA_VERSION_UNSUPPORTED')
    expect(JSON.stringify(err.details.issues)).toContain('buffer_high_water_bytes')
  })

  it('文件不是合法 JSON → SCHEMA_VERSION_UNSUPPORTED 并带 path', () => {
    const file = join(tmpdir(), 'orchestra-config-bad-' + process.pid + '.json')
    writeFileSync(file, '{ not json')
    try {
      const err = expectCode(() => loadConfig(file), 'SCHEMA_VERSION_UNSUPPORTED')
      expect(err.details.path).toBe(file)
    } finally {
      unlinkSync(file)
    }
  })
})

describe('阶段闸', () => {
  it('requirePhase 越阶段抛 FORBIDDEN，回退不抛', () => {
    expectCode(() => requirePhase('S1', 'S2'), 'FORBIDDEN')
    expect(() => requirePhase('S2', 'S1')).not.toThrow()
    expect(() => requirePhase('S3', 'S3')).not.toThrow()
  })

  it('requireCapability：S1 不给发布流程，S1 给账本', () => {
    expectCode(() => requireCapability('S1', 'workflow_publish'), 'FORBIDDEN')
    expect(() => requireCapability('S1', 'ledger')).not.toThrow()
    expect(() => requireCapability('S4', 'workflow_publish')).not.toThrow()
  })

  it('能力表逐阶段只增不减', () => {
    const phases = Object.keys(PHASE_CAPABILITIES) as (keyof typeof PHASE_CAPABILITIES)[]
    for (let i = 1; i < phases.length; i += 1) {
      const prev = PHASE_CAPABILITIES[phases[i - 1]!].slice()
      const cur = PHASE_CAPABILITIES[phases[i]!]
      for (const cap of prev) expect(cur, phases[i] + ' 少了 ' + cap).toContain(cap)
    }
    expect(PHASE_CAPABILITIES.S1).not.toContain('panel')
    expect(PHASE_CAPABILITIES.S1).not.toContain('release')
  })
})
