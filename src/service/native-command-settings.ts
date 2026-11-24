import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { DEFAULT_TASK_COMMAND, TASK_COMMAND_NAME_RE, type TaskCommandCheck } from '../core/task-command.ts'
import { OrchError } from '../core/errors.ts'
import { openDb, withTx } from '../infra/sqlite/driver.ts'

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const name = z.string().regex(TASK_COMMAND_NAME_RE)
const viewSchema = z.strictObject({ name, revision })
export const nativeCommandCheck = z.strictObject({ name })
export const nativeCommandUpdate = z.strictObject({ name, expected_revision: revision })
const defaults = { name: DEFAULT_TASK_COMMAND, revision: 0 }
const key = 'native_task_command'

export function createNativeCommandSettings(profileDir: string) {
  if (!isAbsolute(profileDir)) throw new Error('DSH profile directory must be absolute')
  const file = join(profileDir, 'orchestra', 'chat-settings.sqlite')
  const decode = (row: { value: string } | undefined) => row ? viewSchema.parse(JSON.parse(row.value)) : { ...defaults }
  return {
    read() {
      try {
        if (!statSync(profileDir).isDirectory()) throw new Error('DSH profile is not a directory')
        try { statSync(file) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaults }
          throw error
        }
        const db = openDb(file, { readonly: true, busyTimeoutMs: 100 })
        try { return decode(db.raw.prepare('SELECT value FROM service_meta WHERE key = ?').get(key) as { value: string } | undefined) }
        finally { db.raw.close() }
      } catch { throw new OrchError('SERVICE_UNAVAILABLE', '无法读取任务命令设置') }
    },
    save(input: z.infer<typeof nativeCommandUpdate>) {
      // Keep canonical validation at the persistence boundary as well as HTTP.
      const update = nativeCommandUpdate.safeParse(input)
      if (!update.success) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '任务命令格式无效')
      try {
        if (!statSync(profileDir).isDirectory()) throw new Error('DSH profile is not a directory')
        const db = openDb(file, { busyTimeoutMs: 100 })
        try {
          return withTx(db, tx => {
            const current = decode(tx.get<{ value: string }>('SELECT value FROM service_meta WHERE key = ?', [key]))
            if (update.data.expected_revision !== current.revision) throw new OrchError('STALE_GENERATION', '任务命令已更新，请重新读取')
            if (current.name === update.data.name) return current
            const saved = viewSchema.parse({ name: update.data.name, revision: current.revision + 1 })
            tx.run('INSERT INTO service_meta (key, value, updated_at) VALUES (?, ?, ?) '
              + 'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
            [key, JSON.stringify(saved), new Date().toISOString()])
            return saved
          })
        } finally { db.raw.close() }
      } catch (error) {
        if (error instanceof OrchError && error.code === 'STALE_GENERATION') throw error
        throw new OrchError('SERVICE_UNAVAILABLE', '无法确认任务命令是否已保存')
      }
    },
  }
}

/** Public DSH catalogs only: no private client registry or command execution. */
export async function checkNativeTaskCommand<Agent>(name: string, agent: Agent, cwd: string | undefined, signal: AbortSignal, catalogs: {
  commands?: { list(agent: Agent): readonly { name: string; description?: string }[] }
  skills?: { list(options: { scope: Agent; cwd?: string; signal: AbortSignal }): Promise<readonly { name: string; description?: string; invocation?: { userInvocable?: boolean } }[]> }
}): Promise<TaskCommandCheck> {
  if (!TASK_COMMAND_NAME_RE.test(name)) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '任务命令格式无效')
  if (!catalogs.commands || !catalogs.skills) throw new OrchError('SERVICE_UNAVAILABLE', '宿主命令目录暂不可用，无法检查冲突')
  signal.throwIfAborted()
  const skills = await catalogs.skills.list({ scope: agent, cwd, signal })
  signal.throwIfAborted()
  // Read commands after the asynchronous skill scan so late registration is included.
  const conflicts: TaskCommandCheck['conflicts'] = [
    ...catalogs.commands.list(agent).filter(row => row.name === name).map(row => ({ kind: 'host_command' as const, name, label: row.description || '宿主命令' })),
    ...skills.filter(row => row.name === name && row.invocation?.userInvocable === true).map(row => ({ kind: 'skill' as const, name, label: row.description || '用户技能' })),
  ]
  return { name, available: conflicts.length === 0, conflicts }
}
