// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { ApiError, createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { createTaskCommands } from '../../src/client/api/task-commands.ts'
import { TaskDetailScreen } from '../../src/client/panel/task-detail-screen.tsx'
import { TaskRunSteps } from '../../src/client/panel/task-run-steps.tsx'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { createFakeService, nodeRunView, renderPanel, runSummary, taskSummary } from './harness.ts'

it('shows the model selection reason, complexity and setting revision on demand', async () => {
  const node = nodeRunView({ title: '复核金额', model_assignment: {
    state: 'confirmed', model_ref: 'catalog/reasoner', complexity: 'complex', reason: '需要独立重算', settings_revision: 7,
    usage: { provider: 'catalog', model: 'reasoner', observed_request_headers: 1 },
  } })
  const view = await renderPanel(<TaskRunSteps nodes={[node]} />)
  try {
    expect(view.text()).toContain('实际执行模型 · catalog / reasoner')
    expect(view.text()).not.toContain('需要独立重算')
    await view.click(view.findAll('.task-step-more summary')[0]!)
    await view.flush()
    expect(view.text()).toContain('模型诊断')
    expect(view.text()).toContain('复杂 · 需要独立重算')
    expect(view.text()).toContain('按用户配置 · 修订 7')
  } finally { view.unmount() }
})

it('keeps the memory operation and source run when retrying an unknown result, then opens batches', async () => {
  const task = taskSummary({ current_run_id: 'current' })
  const run = runSummary({ run_id: 'current', task_id: task.task_id, status: 'succeeded', display_status: 'succeeded' })
  const service = createFakeService(({ path }) => {
    if (path === '/v1/tasks/get') return { ok: true, data: task }
    if (path === '/v1/runs/get') return { ok: true, data: run }
    return { ok: true, data: { items: [] } }
  })
  const client = createApiClient('http://panel.test', service.fetcher)
  const startMemory = vi.fn().mockRejectedValueOnce(new ApiError('OPERATION_OUTCOME_UNKNOWN', '结果未知', true)).mockResolvedValueOnce({})
  const openMemory = vi.fn()
  const view = await renderPanel(<PanelShell activeRoute="tasks" serviceConnected onNavigate={() => {}}>
    <TaskDetailScreen api={createResourcesApi(client)} taskId={task.task_id} initialRunId={run.run_id}
      taskCommands={{ ...createTaskCommands(client), startMemory }} onBack={() => {}} onOpenMemory={openMemory} />
  </PanelShell>)
  const button = (label: string) => view.findAll('button').find((element) => element.textContent === label)!
  try {
    await view.flush()
    await view.click(button('结果'))
    await view.click(view.findAll('summary').find((element) => element.textContent === '整理为记忆')!)
    const reason = view.container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(reason, '  保留净额核对依据  ')
      reason.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await view.click(button('发起整理'))
    expect(view.text()).toContain('结果暂不可确认')
    expect(reason.disabled).toBe(true)
    expect(startMemory.mock.calls[0]).toEqual(['current', '保留净额核对依据', expect.any(String)])
    await view.click(button('查询或重试'))
    expect(startMemory.mock.calls).toEqual([startMemory.mock.calls[0], startMemory.mock.calls[0]])
    expect(view.text()).toContain('已取得整理回执')
    await view.click(button('查看记忆批次'))
    expect(openMemory).toHaveBeenCalledOnce()
  } finally { view.unmount() }
})
