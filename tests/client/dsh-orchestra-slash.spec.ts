import { expect, it, vi } from 'vitest'
import { registerNativeOrchestraSlash, type NativeOrchestraSlashContext } from '../../src/client/dsh-orchestra-slash.ts'

it('只在可用本机根会话提供选单，选中只插入原生草稿，空命令显示用法', async () => {
  let source: Parameters<NativeOrchestraSlashContext['inputTriggers']['registerSource']>[0] | undefined
  const remove = vi.fn()
  let active = true
  let name = 'orchestra'
  let revision = 0
  let conflict = false
  let archivedSessionIds: readonly string[] = ['archived']
  const fetcher = vi.fn(async () => Response.json({ ok: active, data: { name, revision, check: { name, available: !conflict, conflicts: conflict ? [{ kind: 'host_command', name, label: '冲突' }] : [] } } }, { status: active ? 200 : 404 }))
  const dispose = registerNativeOrchestraSlash({
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} },
      subagentAddress: (id) => id === 'child' ? { childSessionId: id } : undefined },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'work', sessionIds: ['human', 'child', 'archived'] }], archivedSessionIds }),
      subscribe: () => () => {} } },
    inputTriggers: { registerSource(value) { source = value; return remove } },
  }, fetcher)
  const session = { sessionId: 'human' }
  const signal = new AbortController().signal
  const query = { query: 'orche', position: 'leading', signal }
  try {
    expect(source).toMatchObject({ name: 'dsh-orchestra', trigger: '/' })
    expect(await source!.candidates({ sessionId: 'child' }, query)).toEqual([])
    expect(await source!.candidates({ sessionId: 'archived' }, query)).toEqual([])
    expect(await source!.candidates({ sessionId: 'missing' }, query)).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
    const [candidate] = await source!.candidates(session, query)
    expect(candidate).toMatchObject({ name: 'orchestra', hint: '任务内容' })
    expect(fetcher).toHaveBeenCalledWith('/api/orchestra.request?workspaceId=work&sessionId=human&path=%2Fv1%2Fsettings%2Ftask-command',
      expect.objectContaining({ credentials: 'same-origin', redirect: 'error' }))
    expect(source!.onPick({ session, position: 'leading', candidate: candidate! })).toEqual({ text: '/orchestra ' })
    expect(await source!.matchEnter(session, '/orchestra 整理月报', signal)).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect((await source!.matchEnter(session, '/orchestra', signal))?.claim.submit()).toEqual({ kind: 'success', text: '用法：/orchestra 任务内容' })
    name = 'go'; revision = 1
    expect(await source!.candidates(session, query)).toEqual([])
    expect(await source!.candidates(session, { ...query, query: 'g' })).toMatchObject([{ name: 'go' }])
    expect(await source!.matchEnter(session, '/orchestra', signal)).toBeUndefined()
    expect((await source!.matchEnter(session, '/go', signal))?.claim.submit()).toEqual({ kind: 'success', text: '用法：/go 任务内容' })
    conflict = true
    expect(await source!.candidates(session, { ...query, query: 'g' })).toEqual([])
    await expect(source!.matchEnter(session, '/go 整理周报', signal)).rejects.toThrow('冲突')
    active = false
    expect(await source!.candidates(session, query)).toEqual([])
    archivedSessionIds = ['human']
    expect(source!.onPick({ session, position: 'leading', candidate: candidate! })).toBeUndefined()
  } finally { dispose() }
  expect(remove).toHaveBeenCalledOnce()
})
