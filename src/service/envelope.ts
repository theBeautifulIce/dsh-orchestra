// 命令信封与 request_hash（规格 3.7 行 205-216）：actor 由认证主体派生，不由 payload 自报
import { z } from 'zod'
import { canonicalJson, sha256Hex } from '../core/canonical.ts'

export const commandEnvelopeSchema = z.object({
  operation_id: z.string().uuid(),
  command: z.string().min(1),
  target: z.record(z.string(), z.unknown()).default({}),
  expected: z.record(z.string(), z.unknown()).default({}),
  payload: z.record(z.string(), z.unknown()).default({}),
  client: z.object({ kind: z.string().min(1), version: z.string().min(1) }).strict(),
}).strict()

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>

// request_hash 不含 operation_id、confirm_challenge、client（规格 3.7 行 216）
export function requestHash(env: CommandEnvelope): string {
  return sha256Hex(canonicalJson({
    command: env.command,
    target: env.target,
    expected: env.expected,
    payload: env.payload,
  }))
}
