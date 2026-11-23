// 迁移执行器：枚举 migrations/NNN-name.sql、校验、按序执行、记账（总纲 4.1.1）
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from '../../core/canonical.ts'
import { OrchError } from '../../core/errors.ts'
import { execSchema, type Db } from '../sqlite/driver.ts'

export type SchemaStep = { version: number; name: string; checksum: string; legacyChecksums?: string[]; statements: string[] }

// 已发行到 beta.1 的迁移止于 68。这些版本的库可能由 LF 或 CRLF 检出的包建立，
// 所以只对 68 及之前保留“同文本不同行尾”的历史摘要；新的迁移只认规范化摘要。
export const EOL_COMPAT_THROUGH = 68

/** 迁移校验以行尾归一后的文本为准：检出与打包不再改变摘要。 */
export function canonicalSqlText(body: string): string {
  return body.replace(/\r\n/g, '\n')
}

export function checksumSqlText(body: string): string {
  return sha256Hex(canonicalSqlText(body))
}

/** 历史库可能记过的原始文本摘要，仅包含同一段 SQL 的 LF/CRLF 变体。 */
export function legacySqlChecksums(body: string): string[] {
  const text = canonicalSqlText(body)
  const canonical = sha256Hex(text)
  const variants = new Set([sha256Hex(body), sha256Hex(text.replace(/\n/g, '\r\n'))])
  variants.delete(canonical)
  return [...variants]
}

// 源码里是 src/infra/sqlite/migrations，打包后被并进 lib/index.js，所以从模块位置往上找几种可能
export function defaultMigrationsDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    join(here, 'infra/sqlite/migrations'),
    join(here, '../sqlite/migrations'),
    join(here, 'sqlite/migrations'),
    join(here, '../infra/sqlite/migrations'),
  ]
  for (const dir of candidates) if (existsSync(dir)) return dir
  return candidates[0]!
}

export function loadSteps(dir: string): SchemaStep[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const steps: SchemaStep[] = files.map((file) => {
    const m = /^(\d{3})_(.+)\.sql$/.exec(file)
    if (!m) throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '迁移文件名不合规', { file })
    const body = readFileSync(join(dir, file), 'utf8')
    const statements = canonicalSqlText(body).split(/^;\s*$/m).map((s) => s.trim()).filter(Boolean)
    const version = Number(m[1])
    return { version, name: m[2] ?? file, checksum: checksumSqlText(body),
      legacyChecksums: version <= EOL_COMPAT_THROUGH ? legacySqlChecksums(body) : [], statements }
  })
  const seen = new Set<number>()
  for (const step of steps) {
    if (seen.has(step.version)) throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '迁移编号重复', { version: step.version })
    seen.add(step.version)
  }
  const versions = [...seen].sort((a, b) => a - b)
  for (let i = 0; i < versions.length; i += 1) {
    const got = versions[i]!
    if (got !== i + 1) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '迁移编号不连续，中间缺号', { expected: i + 1, got })
    }
  }
  return steps
}

export function applySteps(db: Db, steps: SchemaStep[]): number[] {
  return execSchema(db, steps)
}
