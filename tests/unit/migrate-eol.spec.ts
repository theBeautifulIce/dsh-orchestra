// H01：同一份迁移 SQL 在不同检出行尾下必须能互开同一账本
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../../src/core/canonical.ts'
import { OrchError } from '../../src/core/errors.ts'
import { applySteps, checksumSqlText, defaultMigrationsDir, EOL_COMPAT_THROUGH, loadSteps } from '../../src/infra/db/migrate.ts'
import { openDb } from '../../src/infra/sqlite/driver.ts'

const SQL = 'CREATE TABLE sample (id TEXT PRIMARY KEY);\n\n;\n\nCREATE INDEX sample_id ON sample (id);\n'

function dirWith(version: number, body: string, name = 'sample'): string {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-migrate-'))
  writeFileSync(join(dir, `${String(version).padStart(3, '0')}_${name}.sql`), body)
  return dir
}

function stored(db: ReturnType<typeof openDb>, version: number): string {
  return String(db.raw.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(version)?.checksum)
}

function forget(db: ReturnType<typeof openDb>, version: number, checksum: string): void {
  db.raw.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(checksum, version)
}

describe('迁移摘要与行尾', () => {
  it('行尾不同不影响规范化摘要，但原始摘要不同', () => {
    const lf = SQL
    const crlf = SQL.replace(/\n/g, '\r\n')
    expect(checksumSqlText(lf)).toBe(checksumSqlText(crlf))
    expect(sha256Hex(lf)).not.toBe(sha256Hex(crlf))
  })

  it('LF 建的账本可以用 CRLF 包打开，CRLF 建的账本也能用 LF 包打开', () => {
    for (const [built, reopened] of [[SQL, SQL.replace(/\n/g, '\r\n')], [SQL.replace(/\n/g, '\r\n'), SQL]] as const) {
      const db = openDb(join(mkdtempSync(join(tmpdir(), 'orchestra-db-')), 'orchestra.db'))
      expect(applySteps(db, loadSteps(dirWith(1, built)))).toEqual([1])
      const steps = loadSteps(dirWith(1, reopened))
      expect(() => applySteps(db, steps)).not.toThrow()
      expect(applySteps(db, steps)).toEqual([])
      db.raw.close()
    }
  })

  it('已发行版本接受同一段 SQL 的 LF/CRLF 历史摘要', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'orchestra-db-')), 'orchestra.db'))
    applySteps(db, loadSteps(dirWith(1, SQL)))
    expect(1).toBeLessThanOrEqual(EOL_COMPAT_THROUGH)
    const legacy = [
      sha256Hex(SQL.replace(/\n/g, '\r\n')),
      sha256Hex(SQL),
      sha256Hex(SQL.replace(/\n/g, '\r\n').replace(/\r\n/g, '\n')),
    ]
    for (const digest of legacy) {
      forget(db, 1, digest)
      expect(() => applySteps(db, loadSteps(dirWith(1, SQL)))).not.toThrow()
    }
    db.raw.close()
  })

  it('SQL 真被改动时仍然拒绝，不靠行尾放行', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'orchestra-db-')), 'orchestra.db'))
    applySteps(db, loadSteps(dirWith(1, SQL)))
    const edited = loadSteps(dirWith(1, SQL.replace('CREATE INDEX sample_id', 'CREATE INDEX sample_other')))
    expect(() => applySteps(db, edited)).toThrow(OrchError)
    expect(() => applySteps(db, edited)).toThrow(/已执行的迁移被改了/u)
    db.raw.close()
  })

  it('仓库里的迁移文件都是 LF，新版本不再登记历史摘要', () => {
    const dir = defaultMigrationsDir()
    const files = readdirSync(dir).filter((file) => file.endsWith('.sql'))
    expect(files.length).toBeGreaterThanOrEqual(EOL_COMPAT_THROUGH)
    for (const file of files) expect(readFileSync(join(dir, file), 'utf8'), file).not.toContain('\r')
    const steps = loadSteps(dir)
    for (const step of steps) {
      if (step.version > EOL_COMPAT_THROUGH) expect(step.legacyChecksums).toEqual([])
      else expect(step.legacyChecksums?.length ?? 0).toBeGreaterThan(0)
    }
  })
})
