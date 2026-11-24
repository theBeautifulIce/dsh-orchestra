// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { ReceiptAction } from '../../src/client/receipt-action.tsx'
import { renderPanel } from './harness.ts'
import type { ReceiptLocation } from '../../src/core/receipt-location.ts'

const sessionId = 'source-session'
const workspaceId = 'workspace'
const sha = 'a'.repeat(64)
const location: ReceiptLocation = { kind: 'artifact', workspaceId, sessionId, taskId: 'task-42', runId: 'run-42',
  artifactId: 'report-version', sha256: sha }

function sources(selected: string, archived: string[] = []) {
  const byId: Record<string, { id: string; retainedBy: { mainView: number } }> = {}
  byId[sessionId] = { id: sessionId, retainedBy: { mainView: selected === sessionId ? 1 : 0 } }
  if (selected !== sessionId) byId[selected] = { id: selected, retainedBy: { mainView: 1 } }
  // 快照必须是同一个对象，否则 useSyncExternalStore 会反复重渲染。
  const sessionSnapshot = { byId }
  const workspaceSnapshot = { items: [{ workspaceId, sessionIds: [sessionId, selected] }], archivedSessionIds: archived }
  return {
    sessions: { list: { getSnapshot: () => sessionSnapshot, subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => workspaceSnapshot, subscribe: () => () => {} } },
  }
}

function stubFetch(override: { runId?: string; fileSha?: string; fileId?: string; truncated?: boolean } = {}) {
  return vi.fn(async (target: string) => {
    const url = new URL(String(target), 'dsh-app://app')
    const resource = new URL(url.searchParams.get('path')!, 'http://fixture.test')
    const path = resource.pathname
    const data = path === '/v1/runs/get' ? { run_id: override.runId ?? 'run-42', task_id: 'task-42', task_title: '月报', status: 'succeeded' }
      : path === '/v1/artifacts/get' ? { artifact_id: override.fileId ?? 'report-version', run_id: 'run-42', sha256: override.fileSha ?? sha,
        file_name: 'report.md', expired: false, retain_until: null }
        : resource.searchParams.get('mode') === 'download'
          ? { kind: 'download', file_name: 'report.md', sha256: sha, size_bytes: 3, base64: 'AAEC' }
          : { kind: 'preview', file_name: 'report.md', sha256: sha, text: '净额 109.50', truncated: override.truncated ?? false }
    return Response.json({ ok: true, schema_version: 1, as_of_seq: 1, data })
  })
}

it('只在原会话里打开回执指向的那一版', async () => {
  vi.stubGlobal('fetch', stubFetch())
  try {
    const view = await renderPanel(<ReceiptAction location={location} sources={sources(sessionId)} />)
    try {
      await view.click(view.findAll('button')[0]!)
      await view.flush()
      expect(view.text()).toContain('净额 109.50')
      expect(view.text()).toContain('report.md')
    } finally { view.unmount() }
  } finally { vi.unstubAllGlobals() }
})

it('切换会话后不展示旧回执，版本不符时明确拒绝', async () => {
  vi.stubGlobal('fetch', stubFetch({ fileSha: 'b'.repeat(64) }))
  try {
    const other = await renderPanel(<ReceiptAction location={location} sources={sources('another-session')} />)
    try { expect(other.findAll('button')).toHaveLength(0) } finally { other.unmount() }

    const archived = await renderPanel(<ReceiptAction location={location} sources={sources(sessionId, [sessionId])} />)
    try { expect(archived.findAll('button')).toHaveLength(0) } finally { archived.unmount() }

    const view = await renderPanel(<ReceiptAction location={location} sources={sources(sessionId)} />)
    try {
      await view.click(view.findAll('button')[0]!)
      await view.flush()
      expect(view.byRole('alert')[0]?.textContent).toContain('task-42')
      expect(view.text()).not.toContain('净额')
    } finally { view.unmount() }
  } finally { vi.unstubAllGlobals() }
})


it('T16 截断回执保留可执行下载入口，取得原回执指定的完整文件', async () => {
  const fetcher=stubFetch({truncated:true})
  vi.stubGlobal('fetch',fetcher)
  const createObjectURL=vi.fn((_blob:Blob)=>'blob:receipt')
  vi.stubGlobal('URL',class extends URL { static createObjectURL=createObjectURL; static revokeObjectURL=vi.fn() })
  const saved=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
  const view=await renderPanel(<ReceiptAction location={location} sources={sources(sessionId)} />)
  try {
    await view.click(view.findAll('button')[0]!)
    await view.flush()
    expect(view.text()).toContain('预览仅显示前')
    await view.click(view.findAll('button').find(button=>button.textContent==='下载产物')!)
    await view.flush()
    expect(saved).toHaveBeenCalledTimes(1)
    expect(createObjectURL.mock.calls[0]?.[0]).toMatchObject({size:3,type:'application/octet-stream'})
    expect(fetcher.mock.calls.some(([target])=> {
      const resource=new URL(new URL(target,'dsh-app://app').searchParams.get('path')!,'http://fixture.test')
      return resource.searchParams.get('artifact_id')==='report-version' && resource.searchParams.get('mode')==='download'
    })).toBe(true)
  } finally {view.unmount();vi.restoreAllMocks();vi.unstubAllGlobals()}
})

it('T16 相同内容散列但不同成果编号也拒绝，任务状态以中文显示', async () => {
  vi.stubGlobal('fetch',stubFetch({fileId:'another-artifact'}))
  const view=await renderPanel(<ReceiptAction location={location} sources={sources(sessionId)} />)
  try {
    await view.click(view.findAll('button')[0]!)
    await view.flush()
    expect(view.byRole('alert')).toHaveLength(1)
    expect(view.text()).not.toContain('净额')
    await view.rerender(<ReceiptAction location={{kind:'task',workspaceId,sessionId,taskId:'task-42',runId:'run-42'}} sources={sources(sessionId)} />)
    await view.click(view.findAll('button')[0]!)
    await view.flush()
    expect(view.text()).not.toContain('succeeded')
    expect(view.text()).toContain('已完成')
  } finally {view.unmount();vi.unstubAllGlobals()}
})
