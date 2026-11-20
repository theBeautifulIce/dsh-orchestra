import { expect, it, vi } from 'vitest'
import { registerNativeOrchestraSlash, type NativeOrchestraSlashContext } from '../../src/client/dsh-orchestra-slash.ts'

it('只在可用本机根会话提供选单，选中只插入原生草稿，空命令显示用法', async () => {
  let source: Parameters<NativeOrchestraSlashContext['inputTriggers']['registerSource']>[0] | undefined
  const remove = vi.fn()
  let active = true
  let enabled = false
  let archivedSessionIds: readonly string[] = ['archived']
  const fetcher = vi.fn(async () => Response.json({ ok: active, data: { enabled, revision: 4 } }, { status: active ? 200 : 404 }))
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
    expect(fetcher).toHaveBeenCalledWith('/api/orchestra.request?workspaceId=work&sessionId=human&path=%2Fv1%2Fsettings%2Fchat-routing',
      expect.objectContaining({ credentials: 'same-origin', redirect: 'error' }))
    expect(source!.onPick({ session, position: 'leading', candidate: candidate! })).toEqual({ text: '/orchestra ' })
    expect(await source!.matchEnter(session, '/orchestra 整理月报', signal)).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((await source!.matchEnter(session, '/orchestra', signal))?.claim.submit()).toEqual({ kind: 'success', text: '用法：/orchestra 任务内容' })
    enabled = true
    expect(await source!.candidates(session, query)).toEqual([candidate])
    active = false
    expect(await source!.candidates(session, query)).toEqual([])
    archivedSessionIds = ['human']
    expect(source!.onPick({ session, position: 'leading', candidate: candidate! })).toBeUndefined()
  } finally { dispose() }
  expect(remove).toHaveBeenCalledOnce()
})
