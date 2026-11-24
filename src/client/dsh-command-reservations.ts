import { TASK_COMMAND_NAME_RE, type TaskCommandCheck } from '../core/task-command.ts'

export type DshCommandUi = {
  register(contribution: { name: string; available(session: { sessionId: string }): boolean; ui: { kind: 'action'; run(session: { sessionId: string }): void } }): () => void
}
export type ClientCommandReservations = ReturnType<typeof createClientCommandReservations>

/** Use commandUi's public duplicate-name guard. Hidden reservations never run. */
export function createClientCommandReservations(commands: DshCommandUi) {
  const held = new Map<string, { count: number; dispose(): void }>()
  let current: { name: string; release(): void } | undefined
  let revision = -1
  let closed = false
  function hold(name: string) {
    if (closed || !TASK_COMMAND_NAME_RE.test(name)) throw new Error('任务命令检查暂不可用')
    let item = held.get(name)
    if (!item) {
      try {
        const dispose = commands.register({ name, available: () => false, ui: { kind: 'action', run() {} } })
        item = { count: 0, dispose }
        held.set(name, item)
      } catch { throw new Error(`/${name} 已被客户端命令占用，或客户端命令目录暂不可用。`) }
    }
    item.count += 1
    let released = false
    let committed = false
    const release = () => {
      if (released) return
      released = true
      if (closed) return
      if (--item!.count === 0) { held.delete(name); item!.dispose() }
    }
    return { release, commit(nextRevision = revision) {
      if (closed || released || committed) return
      if (nextRevision < revision) { release(); return }
      committed = true; revision = nextRevision
      const previous = current; current = { name, release }; previous?.release()
    } }
  }
  function check(name: string): TaskCommandCheck {
    try { const reservation = hold(name); reservation.release(); return { name, available: true, conflicts: [] } }
    catch { return { name, available: false, conflicts: [{ kind: 'client_command', name, label: '客户端命令已占用，或命令目录暂不可用' }] } }
  }
  return {
    check, hold,
    activate(name: string, nextRevision = revision): TaskCommandCheck {
      if (nextRevision < revision) return { name, available: false, conflicts: [{ kind: 'client_command', name, label: '任务命令已更新，请重新读取' }] }
      if (current?.name === name && !closed) { revision = nextRevision; return { name, available: true, conflicts: [] } }
      try { hold(name).commit(nextRevision); return { name, available: true, conflicts: [] } }
      catch { current?.release(); current = undefined; return check(name) }
    },
    dispose() {
      closed = true; current = undefined
      for (const item of held.values()) item.dispose()
      held.clear()
    },
  }
}
