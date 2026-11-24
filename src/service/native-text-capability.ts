import { OrchError } from '../core/errors.ts'
import { isArtifactFileName } from './artifact-store.ts'

/**
 * 原生文本生产器的唯一能力声明：规划、确认启动、原生发布共用同一份。
 * 新增格式只改这里，避免三个入口各列一张黑名单而后走偏（D01）。
 */
export const nativeTextLimits = { files: 8, bytes: 64 * 1024 } as const
const supported = new Set(['md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'jsonl', 'log'])

export function nativeTextFormats(): string[] {
  return [...supported].map((ext) => '.' + ext)
}

export function nativeTextFormat(name: string): string | null {
  const split = name.lastIndexOf('.')
  const ext = split < 1 ? '' : name.slice(split + 1).toLowerCase()
  return isArtifactFileName(name) && supported.has(ext) ? ext : null
}

/** 正向能力判定：只有这里声明过的格式才由文本生产器写出，其余明确拒绝。 */
export function nativeTextBytes(name: string, text: string): Buffer {
  const format = nativeTextFormat(name)
  if (!format) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '此生产器支持的文本格式：' + [...supported].join('、'))
  }
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length === 0 || bytes.length > nativeTextLimits.bytes) {
    throw new OrchError('RANGE_TOO_LARGE', '文本成果应为 1–65536 个 UTF-8 字节')
  }
  try {
    if (format === 'json') JSON.parse(text)
    if (format === 'jsonl') {
      const lines = text.split(/\r?\n/u)
      if (!lines.at(-1)) lines.pop()
      for (const line of lines) JSON.parse(line)
    }
  } catch {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '内容不符合约定的 JSON 格式')
  }
  return bytes
}
