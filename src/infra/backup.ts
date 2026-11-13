// 备份、校验与恢复：备份到独立目录并附 manifest；恢复只写新文件，不碰线上库（规格 12.3 G-15）
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { OrchError } from '../core/errors.ts'
import { openDb } from './sqlite/driver.ts'

export type BackupManifest = {
  created_at: string
  db_file: string
  db_sha256: string
  tables: { name: string; rows: number; sha256: string }[]
}

const TABLES = ['service_meta', 'tasks', 'runs', 'node_runs', 'events', 'node_run_events',
  'inbox', 'leases', 'artifacts', 'report_registry']

export function sha256File(file: string): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  return hash.digest('hex')
}

function tableDigest(db: { raw: { prepare: (sql: string) => { all: () => unknown[] } } }, name: string): { rows: number; sha256: string } {
  const rows = db.raw.prepare('SELECT * FROM ' + name).all() as unknown[]
  const hash = createHash('sha256')
  for (const row of rows) hash.update(JSON.stringify(row) + '\n')
  return { rows: rows.length, sha256: hash.digest('hex') }
}

export function backup(dbFile: string, destDir: string): BackupManifest {
  mkdirSync(destDir, { recursive: true })
  // 先把 WAL 落盘再复制，避免 copy 到半截事务
  const live = openDb(dbFile)
  try {
    live.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    live.raw.close()
  }
  const copy = join(destDir, 'orchestra.db')
  copyFileSync(dbFile, copy)
  const db = openDb(copy, { readonly: true })
  try {
    const tables = TABLES.map((name) => ({ name, ...tableDigest(db, name) }))
    const manifest: BackupManifest = { created_at: new Date().toISOString(), db_file: 'orchestra.db', db_sha256: sha256File(copy), tables }
    writeFileSync(join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    return manifest
  } finally {
    db.raw.close()
  }
}

export function verifyBackup(dir: string): BackupManifest {
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as BackupManifest
  } catch {
    throw new OrchError('SERVICE_UNAVAILABLE', '备份缺清单或清单坏了', { dir, table: '(manifest)' })
  }
  const copy = join(dir, manifest.db_file)
  let digest: string
  try {
    digest = sha256File(copy)
  } catch {
    throw new OrchError('SERVICE_UNAVAILABLE', '备份库文件不见了', { dir, table: '(db_file)' })
  }
  if (digest !== manifest.db_sha256) {
    throw new OrchError('SERVICE_UNAVAILABLE', '备份文件被改过或截断', { dir, table: '(db_file)' })
  }
  const db = openDb(copy, { readonly: true })
  try {
    for (const t of manifest.tables) {
      const got = tableDigest(db, t.name)
      if (got.rows !== t.rows || got.sha256 !== t.sha256) {
        throw new OrchError('SERVICE_UNAVAILABLE', '备份内容与清单不一致', { dir, table: t.name })
      }
    }
    return manifest
  } finally {
    db.raw.close()
  }
}

export function restore(dir: string, targetFile: string): void {
  verifyBackup(dir)
  mkdirSync(dirname(targetFile), { recursive: true })
  copyFileSync(join(dir, 'orchestra.db'), targetFile)
}

export function listBackups(root: string): string[] {
  try {
    return readdirSync(root).filter((n) => n.startsWith('backup-')).sort()
  } catch {
    return []
  }
}
