// 迁移执行器：枚举 migrations/NNN-name.sql、校验、按序执行、记账（总纲 4.1.1）
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from '../../core/canonical.ts'
import { OrchError } from '../../core/errors.ts'
import { execSchema, type Db } from '../sqlite/driver.ts'

export type SchemaStep = { version: number; name: string; checksum: string; statements: string[] }

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
    const statements = body.split(/^;\s*$/m).map((s) => s.trim()).filter(Boolean)
    return { version: Number(m[1]), name: m[2] ?? file, checksum: sha256Hex(body), statements }
  })
  const seen = new Set<number>()
  for (const step of steps) {
    if (seen.has(step.version)) throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '迁移编号重复', { version: step.version })
    seen.add(step.version)
  }
  return steps
}

export function applySteps(db: Db, steps: SchemaStep[]): number[] {
  return execSchema(db, steps)
}
