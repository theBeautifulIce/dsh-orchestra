// id 生成：UUIDv7（毫秒时间前缀 + 随机），实体 id 带可读前缀
import { randomBytes } from 'node:crypto'

export function uuidv7(): string {
  const bytes = randomBytes(16)
  const ms = BigInt(Date.now())
  bytes[0] = Number((ms >> 40n) & 0xffn)
  bytes[1] = Number((ms >> 32n) & 0xffn)
  bytes[2] = Number((ms >> 24n) & 0xffn)
  bytes[3] = Number((ms >> 16n) & 0xffn)
  bytes[4] = Number((ms >> 8n) & 0xffn)
  bytes[5] = Number(ms & 0xffn)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
}

const short = (): string => uuidv7().replace(/-/g, '')
export const eventId = (): string => 'evt_' + short()
export const nodeRunId = (): string => 'nrun_' + short()
export const decisionId = (): string => 'dec_' + short()
export const attestationId = (): string => 'att_' + short()
export const runId = (): string => 'run_' + short()
export const taskId = (): string => 'tsk_' + short()
// 工具执行身份：同一次节点执行里每跑一遍工具都有自己的 id，收口时按它回查痕迹行
export const toolExecutionId = (): string => 'tex_' + short()
