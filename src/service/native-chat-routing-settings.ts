import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import { openDb, withTx } from '../infra/sqlite/driver.ts'
import { DRAFT_KEY_PREFIX } from './semantic-draft-checkpoints.ts'

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const viewSchema = z.strictObject({ enabled: z.boolean(), revision })
export const nativeChatRoutingUpdate = z.strictObject({ enabled: z.boolean(), expected_revision: revision })
const defaults = { enabled: true, revision: 0 }
const key = 'native_chat_auto_route'

export type NativeChatRoutingView = z.infer<typeof viewSchema>

export function createNativeChatRoutingSettings(profileDir: string) {
  if (!isAbsolute(profileDir)) throw new Error('DSH profile directory must be absolute')
  const file = join(profileDir, 'orchestra', 'chat-settings.sqlite')

  function decode(row: { value: string } | undefined) {
    return row ? viewSchema.parse(JSON.parse(row.value)) : { ...defaults }
  }

  function read(): NativeChatRoutingView {
    try {
      if (!statSync(profileDir).isDirectory()) throw new Error('DSH profile is not a directory')
      try { statSync(file) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaults }
        throw error
      }
      const db = openDb(file, { readonly: true, busyTimeoutMs: 100 })
      try {
        return decode(db.raw.prepare('SELECT value FROM service_meta WHERE key = ?').get(key) as { value: string } | undefined)
      } finally { db.raw.close() }
    } catch {
      throw new OrchError('SERVICE_UNAVAILABLE', '无法读取自动接管设置')
    }
  }

  return {
    read,
    save(input: z.infer<typeof nativeChatRoutingUpdate>): NativeChatRoutingView {
      try {
        if (!statSync(profileDir).isDirectory()) throw new Error('DSH profile is not a directory')
        const db = openDb(file, { busyTimeoutMs: 100 })
        try {
          return withTx(db, (tx) => {
            const current = decode(tx.get<{ value: string }>('SELECT value FROM service_meta WHERE key = ?', [key]))
            if (input.expected_revision !== current.revision) {
              throw new OrchError('STALE_GENERATION', '自动接管设置已更新，请重新读取')
            }
            if (current.enabled === input.enabled) return current
            const saved = viewSchema.parse({ enabled: input.enabled, revision: current.revision + 1 })
            if (!input.enabled) tx.run('DELETE FROM service_meta WHERE key GLOB ?', [DRAFT_KEY_PREFIX + '*'])
            tx.run('INSERT INTO service_meta (key, value, updated_at) VALUES (?, ?, ?) '
              + 'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
            [key, JSON.stringify(saved), new Date().toISOString()])
            return saved
          })
        } finally { db.raw.close() }
      } catch (error) {
        if (error instanceof OrchError && error.code === 'STALE_GENERATION') throw error
        throw new OrchError('SERVICE_UNAVAILABLE', '无法确认自动接管设置是否已保存')
      }
    },
  }
}
