// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { TaskEventTimeline } from '../../src/client/panel/task-event-timeline.tsx'
import { deferred, renderPanel } from './harness.ts'

const now = '2026-11-19T07:28:19.000Z'
const activity = (seq: number, type = 'task.created') => ({ seq, event_id: 'event-'+seq, type, occurred_at: now,
  run_id: 'run-a', node_run_id: null, decision_id: null, details: [{ label: '摘要', value: '技术备注 '+seq }] })
const issue = { id: 9, type: 'tool_finished', title: '工具调用结束', created_at: now, run_id: 'run-a', node_id: 'check',
  node_run_id: 'nr-a', attention: true, details: [{ label: '退出码', value: '8' }] }

it('一次显示一页；用账本游标返回更早记录，返回页首维持原快照，刷新再取得新数据', async () => {
  let latest = 10
  const calls: URL[] = []
  const older = deferred<Response>()
  const api = createResourcesApi(createApiClient('http://panel.test', async (input) => {
    const url = new URL(String(input))
    calls.push(url)
    const cursor = url.searchParams.get('before_seq')
    if (cursor === '6') return older.promise
    const data = url.pathname === '/v1/execution-history'
      ? { items: [issue], next_before: null }
      : { items: Array.from({ length: 5 }, (_, index) => activity(latest - index)), next_before_seq: latest - 4 }
    return Response.json({ ok: true, schema_version: 1, as_of_seq: 10, data })
  }))
  const view = await renderPanel(<TaskEventTimeline scope={{ taskId: 'task-a' }} api={api} reloadVersion={0} />)
  const click = async (label: string) => view.click(view.findAll('button').find((button) => button.textContent === label)!)
  const rows = () => view.findAll('ol > li')
  try {
    await view.flush()
    expect(rows()).toHaveLength(5)
    expect(view.findAll('details[open]')).toHaveLength(0)
    expect(view.text()).toContain('最近记录的执行异常')
    expect(view.text()).toContain('工具调用结束（退出码 8）')
    for (const call of calls) expect(call.searchParams.get('task_id')).toBe('task-a')
    expect(calls.find((url) => url.pathname === '/v1/activity')?.searchParams.get('limit')).toBe('5')

    await click('较早一页')
    latest = 11
    await view.rerender(<TaskEventTimeline scope={{ taskId: 'task-a' }} api={api} reloadVersion={1} />)
    expect(view.text()).toContain('第 2 页 · 正在读取')
    expect(calls).toHaveLength(3)
    older.resolve(Response.json({ ok: true, schema_version: 1, as_of_seq: 11,
      data: { items: [5, 4].map((seq) => activity(seq)), next_before_seq: null } }))
    await view.flush()
    expect(rows()).toHaveLength(2)
    expect(view.text()).toContain('技术备注 5')
    expect(view.text()).not.toContain('技术备注 6')
    expect(calls.at(-1)?.searchParams.get('before_seq')).toBe('6')
    expect(document.activeElement?.getAttribute('role')).toBe('status')
    const opened = view.findAll('details')[0] as HTMLDetailsElement
    await act(async () => { opened.open = true; opened.dispatchEvent(new Event('toggle')) })
    latest = 12
    await view.rerender(<TaskEventTimeline scope={{ taskId: 'task-a' }} api={api} reloadVersion={2} />)
    expect(view.text()).toContain('第 2 页 · 2 条')
    expect(view.findAll('details[open]')).toEqual([opened])
    expect(calls).toHaveLength(3)
    await click('较新一页')
    await view.flush()
    expect(rows()).toHaveLength(5)
    expect(view.text()).not.toContain('技术备注 11')
    expect(calls.filter((url) => url.pathname === '/v1/activity')).toHaveLength(2)
    await click('刷新到最新')
    await view.flush()
    expect(view.text()).toContain('技术备注 12')
    expect(view.findAll('details[open]')).toHaveLength(0)
    await click('查看执行异常')
    await view.flush()
    expect(rows()).toHaveLength(1)
    expect(calls.at(-1)?.searchParams.get('filter')).toBe('attention')
    expect(view.text()).toContain('需留意')
    expect(view.findAll('time')[0]?.getAttribute('datetime')).toBe(now)
  } finally { view.unmount() }
})

it('首次浏览头页会自动读取新事件并保留已有记录的展开状态', async () => {
  let sequences = [10, 9]
  const api = createResourcesApi(createApiClient('http://panel.test', async (input) =>
    Response.json({ ok: true, schema_version: 1, as_of_seq: sequences[0], data: new URL(String(input)).pathname === '/v1/activity'
      ? { items: sequences.map((seq) => activity(seq)), next_before_seq: null } : { items: [], next_before: null } })))
  const view = await renderPanel(<TaskEventTimeline scope={{ taskId: 'task-a' }} api={api} reloadVersion={0} />)
  try {
    await view.flush()
    const opened = view.findAll('details')[0] as HTMLDetailsElement
    await act(async () => { opened.open = true; opened.dispatchEvent(new Event('toggle')) })
    sequences = [11, 10, 9]
    await view.rerender(<TaskEventTimeline scope={{ taskId: 'task-a' }} api={api} reloadVersion={1} />)
    await view.flush()
    expect(view.text()).toContain('技术备注 11')
    expect(view.findAll('details[open]')).toHaveLength(1)
    expect(view.findAll('details[open]')[0]?.textContent).toContain('技术备注 10')
  } finally { view.unmount() }
})

it('执行筛选由服务端应用；范围切换后忽略旧响应并从新范围的首游标读起', async () => {
  const old = deferred<Response>()
  const calls: URL[] = []
  const api = createResourcesApi(createApiClient('http://panel.test', async (input) => {
    const url = new URL(String(input))
    calls.push(url)
    const response = (data: object) => Response.json({ ok: true, schema_version: 1, as_of_seq: 5, data })
    return url.pathname === '/v1/execution-history'
      ? (url.searchParams.get('filter') === 'tool' ? old.promise : response({ items: [], next_before: null }))
      : response({ items: [activity(1, url.searchParams.get('run_id') === 'run-b' ? 'task.restored' : 'task.created')], next_before_seq: null })
  }))
  const view = await renderPanel(<TaskEventTimeline scope={{ runId: 'run-a' }} api={api} reloadVersion={0} />)
  try {
    await view.flush()
    await view.click(view.findAll('button').find((item) => item.textContent === '执行明细')!)
    await view.flush()
    const select = view.findAll('select')[0] as HTMLSelectElement
    await act(async () => { select.value = 'tool'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(calls.at(-1)?.searchParams.get('filter')).toBe('tool')
    await view.rerender(<TaskEventTimeline scope={{ runId: 'run-b' }} api={api} reloadVersion={1} />)
    old.resolve(Response.json({ ok: true, schema_version: 1, as_of_seq: 5, data: { items: [issue], next_before: 9 } }))
    await view.flush()
    expect(view.text()).toContain('取回任务')
    expect(view.text()).not.toContain('退出码 8')
    const target = calls.find((url) => url.pathname === '/v1/activity' && url.searchParams.get('run_id') === 'run-b')!
    expect(target.searchParams.has('before_seq')).toBe(false)
  } finally { view.unmount() }
})

it('旧宿主未确认筛选时不会把普通事件报为异常', async () => {
  const normal = { ...issue, attention: undefined }
  const api = createResourcesApi(createApiClient('http://panel.test', async (input) =>
    Response.json({ ok: true, schema_version: 1, as_of_seq: 5, data: new URL(String(input)).pathname === '/v1/activity'
      ? { items: [activity(1)], next_before_seq: null } : { items: [normal], next_before: null } })))
  const view = await renderPanel(<TaskEventTimeline scope={{ runId: 'run-a' }} api={api} reloadVersion={0} />)
  try {
    await view.flush()
    expect(view.text()).not.toContain('最近记录的执行异常')
    await view.click(view.findAll('button').find((button) => button.textContent === '执行明细')!)
    await view.flush()
    const select = view.findAll('select')[0] as HTMLSelectElement
    await act(async () => { select.value = 'attention'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await view.flush()
    expect(view.findAll('ol > li')).toHaveLength(0)
    expect(view.text()).toContain('事件读取失败')
  } finally { view.unmount() }
})
