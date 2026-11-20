import { sha256Hex } from '../core/canonical.ts'
import { ERROR_STATUS, PROPOSED_ERROR_CODES } from '../core/errors.ts'

// Default logs emit fixed messages and selected metadata. Exceptions, request bodies and arbitrary
// free text belong to neither the message nor the fields of this sink.
const MESSAGES = new Set([
  '模型诊断失败', '运行自动派发失败', '任务触发器推进失败', '任务触发器读扫描失败', '维护扫描失败',
  '记忆运行推进失败', '读不到执行配置，按默认并发装配',
  '执行队列满了，拒掉这一件', '执行任务入队', '调度器关闭，取消排队任务', '执行任务开跑',
  '请求失败', '写队列满了，拒掉这一笔写', '裁决命令审计',
])
const COUNTERS = ['waiting', 'maxWaiting', 'inFlight', 'pending', 'max'] as const

export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const key of COUNTERS) {
    const value = fields[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) safe[key] = value
  }
  if (typeof fields.code === 'string' && (fields.code === 'INTERNAL_ERROR'
    || Object.hasOwn(ERROR_STATUS, fields.code) || Object.hasOwn(PROPOSED_ERROR_CODES, fields.code))) {
    safe.code = fields.code
  }
  if (typeof fields.label === 'string' && fields.label) safe.label_sha256 = sha256Hex(fields.label)
  if (fields.outcome === 'replayed' || fields.outcome === 'rejected') safe.outcome = fields.outcome
  if (typeof fields.operationId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(fields.operationId)) {
    safe.operation_id = fields.operationId
  }
  if (typeof fields.decisionId === 'string' && fields.decisionId) safe.decision_id_sha256 = sha256Hex(fields.decisionId)
  if (typeof fields.actorId === 'string' && fields.actorId) safe.actor_id_sha256 = sha256Hex(fields.actorId)
  return safe
}

export type Logger = {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

export function createLogger(stream: { write(line: string): void }): Logger {
  const line = (level: string, msg: string, fields?: Record<string, unknown>): void => {
    const message = MESSAGES.has(msg) ? msg : '服务日志'
    const body = fields ? redact(fields) : {}
    stream.write(JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...body }) + '\n')
  }
  return {
    info: (m, f) => line('info', m, f),
    warn: (m, f) => line('warn', m, f),
    error: (m, f) => line('error', m, f),
  }
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} }
