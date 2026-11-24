/** Command names use DSH's public command grammar. The slash is presentation. */
export const DEFAULT_TASK_COMMAND = 'orchestra'
export const TASK_COMMAND_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/u

export function normalizeTaskCommandName(value: string): string | undefined {
  const name = value.trim().replace(/^\//u, '').toLowerCase()
  return TASK_COMMAND_NAME_RE.test(name) ? name : undefined
}

export type TaskCommandConflict = { kind: 'host_command' | 'skill' | 'client_command'; name: string; label: string }
export type TaskCommandCheck = { name: string; available: boolean; conflicts: TaskCommandConflict[] }
export type TaskCommandView = { name: string; revision: number; check: TaskCommandCheck }
