// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { DisplayPreferenceSettings } from '../../src/client/panel/display-preference-settings.tsx'
import { DISPLAY_PREFERENCES_KEY, resetDisplayPreferences } from '../../src/client/panel/display-preferences.ts'
import { TaskEventTimeline } from '../../src/client/panel/task-event-timeline.tsx'
import { TaskListScreen } from '../../src/client/panel/tasks-screen.tsx'
import { createFakeService, page, renderPanel, type PanelView } from './harness.ts'

const { jsdom } = globalThis as typeof globalThis & { jsdom: { window: Window } }
beforeEach(() => {
  // Node's global localStorage may shadow the browser storage installed by Vitest.
  vi.stubGlobal('localStorage', jsdom.window.localStorage)
})
afterEach(() => {
  vi.restoreAllMocks()
  resetDisplayPreferences()
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

const change = async (view: PanelView, position: number, value: string) => {
  const select = view.findAll('[aria-label="显示偏好"] select')[position] as HTMLSelectElement
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const click = (view: PanelView, label: string) =>
  view.click(view.findAll('button').find((button) => button.textContent === label)!)

it('持久化默认视图并在新页面采用它，保留已经打开的任务页的手选视图', async () => {
  const server = createFakeService(() => ({ ok: true, data: page([]) }))
  const api = createResourcesApi(createApiClient('http://panel.test', server.fetcher))
  const tasks = (key: string) => <TaskListScreen key={key} api={api} onSelectTask={() => {}} />
  const screen = (key: string) => <>{tasks(key)}<DisplayPreferenceSettings /></>
  const view = await renderPanel(screen('open'))
  const otherPanel = await renderPanel(<DisplayPreferenceSettings />)
  const selected = () => view.findAll('[aria-label="任务视图"] [aria-pressed=true]')[0]?.textContent
  try {
    expect(selected()).toBe('看板')
    await click(view, '流程')
    await change(view, 0, 'list')
    expect(selected()).toBe('流程')
    expect((otherPanel.findAll('select')[0] as HTMLSelectElement).value).toBe('list')

    await view.rerender(screen('reopened'))
    expect(selected()).toBe('列表')
    await click(view, '恢复显示默认值')
    expect(selected()).toBe('列表')
    await view.rerender(screen('reset'))
    expect(selected()).toBe('看板')
    expect(server.calls.every(({ path }) => path === '/v1/tasks')).toBe(true)
  } finally { view.unmount(); otherPanel.unmount() }
})

it('任务和运行事件的两种来源都采用下次打开时的页大小，已打开的分页保留原游标', async () => {
  const server = createFakeService(({ path, params }) => path === '/v1/activity'
    ? { ok: true, data: { items: [], next_before_seq: params.has('before_seq') ? null : 21 } }
    : { ok: true, data: { items: [], next_before: null } })
  const api = createResourcesApi(createApiClient('http://panel.test', server.fetcher))
  const screen = (scope: { taskId: string } | { runId: string }) =>
    <><TaskEventTimeline api={api} scope={scope} reloadVersion={0} /><DisplayPreferenceSettings /></>
  const settings = await renderPanel(<DisplayPreferenceSettings />)
  await change(settings, 1, '10')
  const view = await renderPanel(screen({ taskId: 'task-a' }))
  try {
    await view.flush()
    expect(view.text()).toContain('每页最多 10 条')
    await click(view, '较早一页')
    await view.flush()
    await change(view, 1, '20')
    expect(view.text()).toContain('第 2 页')
    expect(view.text()).toContain('每页最多 10 条')
    expect(server.calls.find(({ params }) => params.has('before_seq'))?.params.get('limit')).toBe('10')

    await view.rerender(screen({ runId: 'run-a' }))
    await view.flush()
    expect(view.text()).toContain('第 1 页')
    expect(view.text()).toContain('每页最多 20 条')
    expect(server.calls.find(({ path, params }) => path === '/v1/activity' && params.get('run_id') === 'run-a')?.params.get('limit')).toBe('20')
    await click(view, '执行明细')
    await view.flush()
    expect(server.lastCall()?.params.get('limit')).toBe('20')
    expect(server.lastCall()?.params.get('run_id')).toBe('run-a')
  } finally { view.unmount(); settings.unmount() }
})

it('兼容旧值并同步外部存储变化，恢复显示默认值仅修改自己的键', async () => {
  window.localStorage.setItem('another-setting', 'keep')
  window.localStorage.setItem(DISPLAY_PREFERENCES_KEY, JSON.stringify({ taskView: 'unknown', eventPageSize: '10' }))
  const view = await renderPanel(<DisplayPreferenceSettings />)
  const values = () => view.findAll('select').map((select) => (select as HTMLSelectElement).value)
  try {
    expect(values()).toEqual(['board', '10'])
    await act(async () => {
      window.localStorage.setItem(DISPLAY_PREFERENCES_KEY, JSON.stringify({ taskView: 'queue', eventPageSize: 20 }))
      window.dispatchEvent(new StorageEvent('storage', { key: DISPLAY_PREFERENCES_KEY, storageArea: window.localStorage }))
    })
    expect(values()).toEqual(['queue', '20'])
    await click(view, '恢复显示默认值')
    expect(values()).toEqual(['board', '5'])
    expect(window.localStorage.getItem('another-setting')).toBe('keep')
  } finally { view.unmount() }
})

it('浏览器拒绝写入时保留本页更改，并告知它们的作用域', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Unavailable') })
  const view = await renderPanel(<DisplayPreferenceSettings />)
  try {
    await change(view, 0, 'queue')
    expect(view.text()).toContain('本次更改仅保留在当前页面')
    expect((view.findAll('select')[0] as HTMLSelectElement).value).toBe('queue')
    await view.rerender(<DisplayPreferenceSettings key="re-opened" />)
    expect((view.findAll('select')[0] as HTMLSelectElement).value).toBe('queue')
  } finally { view.unmount() }
})
