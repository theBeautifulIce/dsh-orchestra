// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { TaskDetailScreen } from '../../src/client/panel/task-detail-screen.tsx'
import { TaskFlowView } from '../../src/client/panel/task-flow-view.tsx'
import { createFakeService, nodeRunView, renderPanel, runSummary, taskSummary, type FakeQuery, type FakeReply } from './harness.ts'

const now = '2026-11-18T01:00:00.000Z'
const task = taskSummary({ title: '每日 09:00 项目记忆巡检', trigger_kind: 'scheduled', run_count: 3, workflow_version: 3, current_run_id: 'r2' })
const recent = runSummary({
  run_id: 'r2', workflow_version: 2, status: 'succeeded', display_status: 'succeeded',
  started_at: now, ended_at: '2026-11-18T01:00:42.000Z', scheduled_for: now, trigger_kind: 'scheduled',
})
const older = runSummary({
  run_id: 'r1', status: 'failed', display_status: 'failed', started_at: '2026-11-17T01:00:00.000Z',
  ended_at: '2026-11-17T01:00:18.000Z', trigger_kind: 'scheduled',
})

function apiFrom(handler: (query: FakeQuery) => FakeReply) {
  const service = createFakeService(handler)
  return { service, api: createResourcesApi(createApiClient('http://panel.test', service.fetcher)) }
}

const missing = { ok: false, error: { code: 'NOT_FOUND', message: 'missing', retryable: false } } as const

describe('任务工作台与排期详情', () => {
  it('流程使用运行固定版本，选中步骤展示上游和模型使用证据', async () => {
    const { api, service } = apiFrom(({ path }) => {
      if (path === '/v1/runs/get') return { ok: true, data: recent }
      if (path === '/v1/node-runs') return { ok: true, data: { items: [
        nodeRunView({ run_id: 'r2', node_id: 'read', title: '读取候选', status: 'done', status_label: '已完成' }),
        nodeRunView({ node_run_id: 'n2old', run_id: 'r2', node_id: 'review', title: '核对记忆', status: 'failed', status_label: '过期尝试已失败' }),
        nodeRunView({ node_run_id: 'n2', run_id: 'r2', node_id: 'review', title: '核对记忆', attempt: 2, status: 'started', status_label: '正在核对',
          model_assignment: { state: 'confirmed', model_ref: 'routing/complex', reason: '需要比对两个来源', complexity: 'complex',
            usage: { provider: 'provider', model: 'model-x', observed_request_headers: 1 } } }),
      ] } }
      if (path === '/v1/workflows/versions/get') return { ok: true, data: {
        definition: { name: '项目记忆巡检', nodes: [
          { node_id: 'read', title: '读取候选', type: 'agent' }, { node_id: 'review', title: '核对记忆', type: 'agent' },
        ], edges: [{ from: 'read', to: 'review' }] },
      } }
      return missing
    })
    const visible: string[] = []
    const view = await renderPanel(<TaskFlowView api={api} tasks={[task]} reloadVersion={0}
      onOpenTask={(_, __, runId) => { if (runId) visible.push(runId) }} />)
    await view.flush()
    expect(service.calls.find((call) => call.path === '/v1/workflows/versions/get')?.params.get('version')).toBe('2')
    expect(view.findAll('.task-flow-step')).toHaveLength(2)
    expect(view.text()).not.toContain('过期尝试已失败')
    const stepPanel = () => view.container.querySelector('.task-step-inspector')?.textContent ?? ''
    expect(stepPanel()).toContain('读取候选')
    expect(stepPanel()).toContain('实际执行模型')
    expect(stepPanel()).toContain('provider / model-x')
    await view.click(view.findAll('.task-step-inspector button').find((item) => item.textContent === '查看这次运行')!)
    expect(visible).toEqual(['r2'])
    await view.click(view.findAll('.task-flow-step')[0]!)
    expect(stepPanel()).not.toContain('实际执行模型')
    view.unmount()
  })

  it('任务概览显示已登记排期，从分页历史进入指定运行，事件按任务读取', async () => {
    const { api, service } = apiFrom(({ path, params }) => {
      if (path === '/v1/tasks/get') return { ok: true, data: task }
      if (path === '/v1/task-triggers') return { ok: true, data: { items: [{
        task_id: task.task_id, trigger_id: 'tgt1', kind: 'scheduled', enabled: true, revision: 1,
        daily_time: '09:00', time_zone: 'Asia/Shanghai', next_fire_at: '2026-11-19T01:00:00.000Z', last_fired_at: now,
      }] } }
      if (path === '/v1/runs') return { ok: true, data: params.get('cursor') === 'older'
        ? { items: [older], next_cursor: null } : { items: [recent], next_cursor: 'older' } }
      if (path === '/v1/node-runs') return { ok: true, data: { items: [
        nodeRunView({ run_id: 'r1', title: '上次未通过的步骤', status: 'failed', status_label: '没做成' }),
      ] } }
      if (path === '/v1/activity') return { ok: true, data: {
        items: [{ seq: 3, type: 'task.trigger_fired', occurred_at: now, run_id: 'r2' }], next_before_seq: null,
      } }
      return missing
    })
    const view = await renderPanel(<TaskDetailScreen api={api} taskId={task.task_id} onBack={() => {}} />)
    const button = (name: string) => view.findAll('button').find((item) => item.textContent?.startsWith(name))!
    await view.flush()
    expect(view.text()).toContain('排期与历史运行')
    expect(view.text()).toContain('每天 09:00')
    expect(view.text()).toContain('2026/11/19 09:00')
    expect(view.text()).toContain('42 秒')
    await view.click(button('运行'))
    await view.click(button('加载更早的运行'))
    await view.flush()
    await view.click(view.findAll('.task-run-history button')[1]!)
    await view.flush()
    expect(view.text()).toContain('上次未通过的步骤')
    expect(service.calls.filter((call) => call.path === '/v1/node-runs').map((call) => call.params.get('run_id'))).toEqual(['r1'])
    await view.click(button('返回任务'))
    await view.click(button('事件'))
    await view.flush()
    expect(service.calls.find((call) => call.path === '/v1/activity')?.params.get('task_id')).toBe(task.task_id)
    expect(view.text()).toContain('触发任务运行')
    view.unmount()
  })
})
