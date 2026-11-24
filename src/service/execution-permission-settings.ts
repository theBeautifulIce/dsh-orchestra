import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { DEFAULT_EXECUTION_PERMISSION_MODE, EXECUTION_PERMISSION_MODES, type ExecutionPermissionView } from '../core/execution-permissions.ts'
import { OrchError } from '../core/errors.ts'
import { openDb, withTx } from '../infra/sqlite/driver.ts'

export type { ExecutionPermissionView } from '../core/execution-permissions.ts'
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const viewSchema = z.strictObject({ mode: z.enum(EXECUTION_PERMISSION_MODES), revision })
export const executionPermissionUpdate = z.strictObject({ mode: z.enum(EXECUTION_PERMISSION_MODES), expected_revision: revision })
const defaults: ExecutionPermissionView = { mode: DEFAULT_EXECUTION_PERMISSION_MODE, revision: 0 }
const key = 'execution_permissions.v1'

/** A local operator preference shared by sessions; changes affect future attempts. */
export function createExecutionPermissionSettings(profileDir: string) {
  if (!isAbsolute(profileDir)) throw new Error('DSH profile directory must be absolute')
  const file = join(profileDir, 'orchestra', 'execution-settings.sqlite')
  const decode = (row: { value: string } | undefined): ExecutionPermissionView =>
    row ? viewSchema.parse(JSON.parse(row.value)) : { ...defaults }
  function read(): ExecutionPermissionView {
    try {
      if (!statSync(profileDir).isDirectory()) throw new Error('DSH profile is not a directory')
      try { statSync(file) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaults }
        throw error
      }
      const db = openDb(file, { readonly: true, busyTimeoutMs: 100 })
      try { return decode(db.raw.prepare('SELECT value FROM service_meta WHERE key = ?').get(key) as { value: string } | undefined) }
      finally { db.raw.close() }
    } catch { throw new OrchError('SERVICE_UNAVAILABLE', '无法读取执行权限设置') }
  }
  return {
    read,
    save(value: z.infer<typeof executionPermissionUpdate>): ExecutionPermissionView {
      const input = executionPermissionUpdate.parse(value)
      try {
        if (!statSync(profileDir).isDirectory()) throw new Error('DSH profile is not a directory')
        const db = openDb(file, { busyTimeoutMs: 100 })
        try {
          return withTx(db, (tx) => {
            const current = decode(tx.get<{ value: string }>('SELECT value FROM service_meta WHERE key = ?', [key]))
            if (input.expected_revision !== current.revision) throw new OrchError('STALE_GENERATION', '执行权限设置已更新，请重新读取')
            const saved = viewSchema.parse({ mode: input.mode, revision: current.revision + 1 })
            tx.run('INSERT INTO service_meta (key, value, updated_at) VALUES (?, ?, ?) '
              + 'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
            [key, JSON.stringify(saved), new Date().toISOString()])
            return saved
          })
        } finally { db.raw.close() }
      } catch (error) {
        if (error instanceof OrchError && error.code === 'STALE_GENERATION') throw error
        throw new OrchError('SERVICE_UNAVAILABLE', '无法确认执行权限设置是否已保存')
      }
    },
  }
}
