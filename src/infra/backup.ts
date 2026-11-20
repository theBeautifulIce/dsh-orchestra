// 备份、校验与恢复：备份到独立目录并附 manifest；恢复只写新文件，不碰线上库（规格 12.3 G-15）
import { createHash } from 'node:crypto'
import { closeSync, constants, copyFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync,
  readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const fd = openSync(file, 'r')
  try {
    let length: number
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length))
  } finally { closeSync(fd) }
  return hash.digest('hex')
}

function checkPath(path: string) {
  for (let at = resolve(path); ; at = dirname(at)) {
    if (lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw new OrchError('FORBIDDEN', '备份与恢复需要真实文件路径')
    if (at === dirname(at)) break
  }
}

function requireFresh(file: string) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (lstatSync(file + suffix, { throwIfNoEntry: false })) throw new OrchError('FORBIDDEN', '输出位置已被使用，请选择独立新目标')
  }
}

function tableDigest(db: { raw: { prepare: (sql: string) => { all: () => unknown[] } } }, name: string): { rows: number; sha256: string } {
  const rows = db.raw.prepare('SELECT * FROM ' + name).all() as unknown[]
  const hash = createHash('sha256')
  for (const row of rows) hash.update(JSON.stringify(row) + '\n')
  return { rows: rows.length, sha256: hash.digest('hex') }
}

export function backup(dbFile: string, destDir: string): BackupManifest {
  checkPath(dbFile)
  checkPath(destDir)
  mkdirSync(destDir, { recursive: true })
  const copy = join(destDir, 'orchestra.db')
  requireFresh(copy)
  requireFresh(join(destDir, 'manifest.json'))
  const staging = mkdtempSync(join(destDir, '.backup-'))
  const snapshot = join(staging, 'orchestra.db')
  try {
    // VACUUM INTO reads one committed SQLite snapshot, including committed WAL pages.
    const live = openDb(dbFile, { readonly: true })
    try { live.raw.prepare('VACUUM INTO ?').run(snapshot) } finally { live.raw.close() }
    const db = openDb(snapshot, { readonly: true })
    let tables
    try { tables = TABLES.map((name) => ({ name, ...tableDigest(db, name) })) } finally { db.raw.close() }
    const manifest: BackupManifest = { created_at: new Date().toISOString(), db_file: 'orchestra.db', db_sha256: sha256File(snapshot), tables }
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    linkSync(snapshot, copy)
    linkSync(join(staging, 'manifest.json'), join(destDir, 'manifest.json'))
    return manifest
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

export function verifyBackup(dir: string): BackupManifest {
  checkPath(join(dir, 'manifest.json'))
  checkPath(join(dir, 'orchestra.db'))
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as BackupManifest
    if (manifest.db_file !== 'orchestra.db' || !/^[a-f0-9]{64}$/.test(manifest.db_sha256)
      || !Array.isArray(manifest.tables) || manifest.tables.length !== TABLES.length
      || !TABLES.every((name) => manifest.tables.some((table) => table.name === name))) throw new Error('Invalid manifest')
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
  const manifest = verifyBackup(dir)
  checkPath(targetFile)
  requireFresh(targetFile)
  if (resolve(dirname(targetFile)) === resolve(dir)) throw new OrchError('FORBIDDEN', '恢复需要独立目录')
  mkdirSync(dirname(targetFile), { recursive: true })
  const staging = mkdtempSync(join(dirname(targetFile), '.restore-'))
  try {
    const copy = join(staging, 'orchestra.db')
    copyFileSync(join(dir, 'orchestra.db'), copy, constants.COPYFILE_EXCL)
    if (sha256File(copy) !== manifest.db_sha256) throw new OrchError('SERVICE_UNAVAILABLE', '恢复副本与已校验的清单不一致')
    linkSync(copy, targetFile)
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

export function listBackups(root: string): string[] {
  try {
    return readdirSync(root).filter((n) => n.startsWith('backup-')).sort()
  } catch {
    return []
  }
}
