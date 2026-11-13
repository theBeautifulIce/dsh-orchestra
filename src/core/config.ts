// 唯一配置源：orchestra.config.json 的 schema、加载与阶段闸（规格 17.2 行 1385）
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { OrchError } from './errors.ts'

export const PHASES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const
export type Phase = (typeof PHASES)[number]

export function phaseIndex(phase: Phase): number {
  return PHASES.indexOf(phase)
}

// 规格 11.1 行 934-939 的阶段能力表；S1 只放行账本、迁移、备份、只读查询。
export const PHASE_CAPABILITIES: Record<Phase, readonly string[]> = {
  S1: ['ledger', 'migration', 'backup', 'readonly_query'],
  S2: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node'],
  S3: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node', 'all_nodes', 'decision', 'approval', 'parallel', 'wait', 'subworkflow', 'compensation'],
  S4: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node', 'all_nodes', 'decision', 'approval', 'parallel', 'wait', 'subworkflow', 'compensation', 'workflow_publish'],
  S5: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node', 'all_nodes', 'decision', 'approval', 'parallel', 'wait', 'subworkflow', 'compensation', 'workflow_publish', 'panel', 'memory'],
  S6: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node', 'all_nodes', 'decision', 'approval', 'parallel', 'wait', 'subworkflow', 'compensation', 'workflow_publish', 'panel', 'memory', 'release'],
}

const positiveInt = (min: number) => z.number().int().min(min)

export const configSchema = z.object({
  phase: z.enum(PHASES),
  service: z.object({
    db_path: z.string().min(1),
    busy_timeout_ms: positiveInt(100),
  }).strict(),
  execution: z.object({
    concurrency: positiveInt(1),
    human_slots: positiveInt(1),
    startup_timeout_ms: positiveInt(0),
    unknown_watchdog_ms: positiveInt(0),
    verify_timeout_ms: positiveInt(0),
    // S2 追加：租约时长、心跳间隔、动作超时、取消宽限
    lease_ttl_ms: positiveInt(1000),
    lease_renew_interval_ms: positiveInt(500),
    action_timeout_ms: positiveInt(1000),
    cancel_grace_ms: positiveInt(1000),
  }).strict(),
  bridge: z.object({
    buffer_high_water_bytes: positiveInt(1024),
    buffer_limit_bytes: positiveInt(1024),
    spill_dir: z.string().min(1),
  }).strict(),
  retention: z.object({
    receipt_days: positiveInt(1),
    in_flight_timeout_minutes: positiveInt(1),
  }).strict(),
  memory: z.object({
    bridge_id: z.string().min(1),
    eval_timeout_ms: positiveInt(0),
    judge_content_limit: positiveInt(1),
    approval_ttl_hours: positiveInt(1),
  }).strict(),
}).strict().superRefine((cfg, ctx) => {
  if (cfg.bridge.buffer_high_water_bytes >= cfg.bridge.buffer_limit_bytes) {
    ctx.addIssue({ code: 'custom', path: ['bridge', 'buffer_high_water_bytes'], message: '必须小于 buffer_limit_bytes' })
  }
  if (cfg.execution.lease_renew_interval_ms >= cfg.execution.lease_ttl_ms) {
    ctx.addIssue({ code: 'custom', path: ['execution', 'lease_renew_interval_ms'], message: '心跳间隔必须小于租约时长' })
  }
})

export type OrchestraConfig = z.infer<typeof configSchema>

/** 规格 17.1 没有「配置非法」专用码，S1 定案统一用 SCHEMA_VERSION_UNSUPPORTED 并在 details 里带字段（计划 §0）。 */
export function parseConfig(raw: unknown, source = '<memory>'): OrchestraConfig {
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '配置不合法，拒绝启动', {
      source,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    })
  }
  return parsed.data
}

export function loadConfig(path: string): OrchestraConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '配置文件读不出来或不是合法 JSON', { path, cause: String(err) })
  }
  return parseConfig(raw, path)
}

// 加载期与启动期都按 min_phase 拒越阶段能力（规格 2.4 行 122）。
export function requirePhase(current: Phase, needed: Phase): void {
  if (phaseIndex(current) < phaseIndex(needed)) {
    throw new OrchError('FORBIDDEN', '当前阶段不提供这个能力', { current, needed })
  }
}

export function requireCapability(current: Phase, capability: string): void {
  if (!PHASE_CAPABILITIES[current].includes(capability)) {
    throw new OrchError('FORBIDDEN', '当前阶段不提供这个能力', { current, capability })
  }
}
