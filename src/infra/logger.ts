// 结构化 JSON 行日志；默认脱敏（不打印 token、密钥、完整 payload、executor 全量 transcript，规格 12.5 行 1094）
const SECRET_KEYS = new Set(['secret', 'token', 'authorization', 'payload', 'transcript'])

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[深度截断]'
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? '[已脱敏]' : redact(v, depth + 1)
    }
    return out
  }
  return value
}

export type Logger = {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

export function createLogger(stream: { write(line: string): void }): Logger {
  const line = (level: string, msg: string, fields?: Record<string, unknown>): void => {
    const body = fields ? (redact(fields) as Record<string, unknown>) : {}
    stream.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...body }) + '\n')
  }
  return {
    info: (m, f) => line('info', m, f),
    warn: (m, f) => line('warn', m, f),
    error: (m, f) => line('error', m, f),
  }
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} }
