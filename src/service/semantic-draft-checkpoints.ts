import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, hmacSha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { hasServiceMeta, openDb, withTx } from '../infra/sqlite/driver.ts'
import type { SemanticDraft, SemanticDraftCheckpoints } from './semantic-admission.ts'

// This profile-local store is independent of execution services and workspaces.
// Reading an ordinary chat must never create a task database or a writer.
export const DRAFT_KEY_PREFIX = 'native_held_draft/'
const lifetime = 30 * 60_000
type Entry = { value: string; updated_at: string }

export function createSemanticDraftCheckpoints(profileDir: string, keyFor: (identity: string) => Promise<string>): SemanticDraftCheckpoints {
  const file = join(profileDir, 'orchestra', 'chat-settings.sqlite')
  const key = (identity: string) => DRAFT_KEY_PREFIX + identity
  const seal = (secret: string, identity: string, draft: SemanticDraft) =>
    hmacSha256Hex(secret, 'orchestra.held-draft.v1\0' + canonicalJson([identity, draft]))
  function readEntry(identity: string): Entry | undefined {
    if (!existsSync(file)) return
    const db = openDb(file, { readonly: true, busyTimeoutMs: 250 })
    try {
      if (hasServiceMeta(db.raw)) return db.raw.prepare('SELECT value,updated_at FROM service_meta WHERE key=?')
        .get(key(identity)) as Entry | undefined
    } finally { db.raw.close() }
  }
  function decode(row: Entry | undefined, identity: string, secret: string): SemanticDraft | undefined {
    if (!row) return
    try {
      const { draft, mac } = JSON.parse(row.value) as { draft: SemanticDraft; mac: string }
      if (seal(secret, identity, draft) !== mac || draft.timing !== 'held') throw new Error()
      const now = Date.now()
      if (draft.expires_at > now && draft.expires_at <= now + lifetime) return draft
    } catch { throw new OrchError('CONFIRMATION_MISMATCH', '暂缓草稿未通过来源核对，请完整重述任务及限制。') }
  }
  return {
    async read(identity) {
      const row = readEntry(identity)
      if (!row) return
      const secret = await keyFor(identity)
      try { return decode(row, identity, secret) }
      catch (error) {
        // Reject this turn, then allow a fresh, complete request to start over.
        // A concurrent replacement must survive this cleanup.
        const db = openDb(file, { busyTimeoutMs: 250 })
        try { withTx(db, tx => tx.run('DELETE FROM service_meta WHERE key=? AND value=?', [key(identity), row.value])) }
        finally { db.raw.close() }
        throw error
      }
    },
    async write(identity, next, previous, assertCurrent) {
      if (!next && !previous) return
      const secret = await keyFor(identity)
      assertCurrent?.()
      const db = openDb(file, { busyTimeoutMs: 250 })
      try {
        withTx(db, tx => {
          assertCurrent?.()
          const stored = decode(tx.get<Entry>('SELECT value,updated_at FROM service_meta WHERE key=?', [key(identity)]), identity, secret)
          if (!stored && !next && !assertCurrent) return
          const expected = previous && previous.expires_at > Date.now() ? previous : undefined
          if (stored?.id !== expected?.id || stored?.revision !== expected?.revision)
            throw new OrchError('STALE_GENERATION', '暂缓草稿已经改变，请在原会话重新核对。')
          tx.run('DELETE FROM service_meta WHERE key GLOB ? AND updated_at<=?', [DRAFT_KEY_PREFIX + '*', new Date(Date.now() - lifetime).toISOString()])
          if (next) tx.run('INSERT INTO service_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
            [key(identity), JSON.stringify({ draft: next, mac: seal(secret, identity, next) }), new Date().toISOString()])
          else tx.run('DELETE FROM service_meta WHERE key=?', [key(identity)])
        })
      } finally { db.raw.close() }
    },
  }
}
