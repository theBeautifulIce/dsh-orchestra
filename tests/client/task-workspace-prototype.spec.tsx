// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { TaskDetailScreen } from '../../src/client/panel/task-detail-screen.tsx'
import { TaskFlowView } from '../../src/client/panel/task-flow-view.tsx'
import { TaskRunSteps } from '../../src/client/panel/task-run-steps.tsx'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { readCanvasDoc } from '../../src/client/panel/workflow-canvas-nodes.tsx'
import type { OperatorStopReceipt } from '../../src/service/operator-run-stop.ts'
import { createFakeService, deferred, nodeRunView, renderPanel, runSummary, taskSummary, type FakeQuery, type FakeReply } from './harness.ts'

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
  it('已提交文件与仍缺少的计划产物同时显示，且能直接进入结果', async () => {
    const pending = runSummary({ run_id: 'r2', status: 'running', counts: [{ status: 'verifying', count: 1 }] })
    const artifactHash = 'a'.repeat(64)
    const { api } = apiFrom(({ path }) => {
      if (path === '/v1/tasks/get') return { ok: true, data: task }
      if (path === '/v1/runs') return { ok: true, data: { items: [pending] } }
      if (path === '/v1/runs/get') return { ok: true, data: pending }
      if (path === '/v1/node-runs') return { ok: true, data: { items: [
        nodeRunView({ run_id: 'r2', node_id: 'summarize', node_run_id: 'raw-step-id', title: '汇总分析',
          status: 'verifying', status_label: 'verifying', hang_reason: 'evidence_missing' }),
        nodeRunView({ run_id: 'r2', node_id: 'source', node_run_id: 'source-attempt', title: '收集情况', status: 'done' }),
      ] } }
      if (path === '/v1/artifacts') return { ok: true, data: { items: [{
        artifact_id: 'raw-artifact-id', run_id: 'r2', file_name: 'collection-review.md', source_node_run_id: 'source-attempt',
        sha256: artifactHash, retain_until: null, created_at: now,
      }], has_more: false } }
      if (path === '/v1/task-plans/by-task') return { ok: true, data: { launch: { task_id: task.task_id, run_id: 'r2' }, proposal: {
        deliverables: [
          { node_id: 'summarize', acceptance: { kind: 'artifact', file_name: 'summary.md', minimum_bytes: 100 } },
          { node_id: 'summarize', acceptance: { kind: 'artifact', file_name: 'collection-review.md', minimum_bytes: 90 } },
        ],
      } } }
      return missing
    })
    const view = await renderPanel(<TaskDetailScreen api={api} taskId={task.task_id} initialRunId="r2" onBack={() => {}} />)
    try {
      await view.flush()
      expect(view.text()).toContain('系统正在核验这一步的执行结果')
      expect(view.text()).toContain('已登记的文件：collection-review.md')
      expect(view.text()).toContain('计划要求「summary.md」由「汇总分析」提交。尚未登记该文件。')
      expect(view.text()).toContain('计划要求「collection-review.md」由「汇总分析」提交。已登记同名文件，提交步骤仍待确认。')
      expect(view.findAll('details:not([open])').some((element) => element.textContent?.includes('至少 100 字节'))).toBe(true)
      expect(view.text()).not.toContain('evidence_missing')
      expect(view.text()).not.toContain('raw-step-id')
      await view.click(view.findAll('button').find((button) => button.textContent === '查看已登记产物')!)
      await view.flush()
      expect(view.text()).toContain('交付产物')
      expect(view.findAll('summary').some((element) => element.textContent === 'collection-review.md')).toBe(true)
      expect(view.text()).toContain('提交步骤 · 收集情况')
      expect(view.findAll('details:not([open]) code').some((element) => element.textContent === artifactHash)).toBe(true)
    } finally { view.unmount() }
  })

  it('旧记录没有本次运行绑定的计划时，保留已登记文件且不判断缺交', async () => {
    const pending = runSummary({ run_id: 'r2', status: 'running', counts: [{ status: 'verifying', count: 1 }] })
    const { api } = apiFrom(({ path }) => {
      if (path === '/v1/tasks/get') return { ok: true, data: task }
      if (path === '/v1/runs') return { ok: true, data: { items: [pending] } }
      if (path === '/v1/runs/get') return { ok: true, data: pending }
      if (path === '/v1/node-runs') return { ok: true, data: { items: [] } }
      if (path === '/v1/artifacts') return { ok: true, data: { items: [{ run_id: 'r2', file_name: 'existing.md' }], has_more: false } }
      if (path === '/v1/task-plans/by-task') return { ok: true, data: { launch: { task_id: task.task_id, run_id: 'r1' }, proposal: {
        deliverables: [{ acceptance: { kind: 'artifact', file_name: 'older.md', minimum_bytes: 100 } }],
      } } }
      return missing
    })
    const view = await renderPanel(<TaskDetailScreen api={api} taskId={task.task_id} initialRunId="r2" onBack={() => {}} />)
    try {
      await view.flush()
      expect(view.text()).toContain('已登记的文件：existing.md')
      expect(view.text()).not.toContain('older.md')
      expect(view.text()).not.toContain('尚未登记该文件')
    } finally { view.unmount() }
  })

  it('运行结果用验收名称展示原件，不把内部文件名当成果标题', async () => {
    const accepted = '用户体验检查报告'
    const internalName = '会话正文-3.md'
    const { api } = apiFrom(({ path }) => {
      if (path === '/v1/tasks/get') return { ok: true, data: task }
      if (path === '/v1/runs') return { ok: true, data: { items: [recent] } }
      if (path === '/v1/runs/get') return { ok: true, data: recent }
      if (path === '/v1/node-runs') return { ok: true, data: { items: [] } }
      if (path === '/v1/artifacts') return { ok: true, data: { items: [{
        artifact_id: 'accepted-result', run_id: 'r2', file_name: internalName, title: accepted,
        sha256: 'b'.repeat(64), retain_until: null, created_at: now, expired: false,
      }], has_more: false } }
      return missing
    })
    const view = await renderPanel(<TaskDetailScreen api={api} taskId={task.task_id} initialRunId="r2" onBack={() => {}} />)
    try {
      await view.click(view.findAll('button').find(button => button.textContent === '结果')!)
      await view.flush()
      expect(view.findAll('summary').some(summary => summary.textContent === accepted)).toBe(true)
      expect(view.findAll('summary').some(summary => summary.textContent === internalName)).toBe(false)
      expect(view.text()).toContain('交付产物')
    } finally { view.unmount() }
  })

  it('停止按钮必须经过二步确认，双击只发一次，并保留未知结果提示', async () => {
    const active = runSummary({ run_id: 'r2', status: 'running', display_status: 'running', operator_stop_state: 'available' })
    let stopState: 'available' | 'requested' = 'available'
    const { api } = apiFrom(({ path, params }) => {
      if (path === '/v1/tasks/get') return { ok: true, data: task }
      if (path === '/v1/runs') return { ok: true, data: { items: [{ ...active, operator_stop_state: stopState }] } }
      if (path === '/v1/runs/get') return { ok: true, data: { ...active, operator_stop_state: stopState } }
      if (path === '/v1/node-runs') return { ok: true, data: { items: [] } }
      return missing
    })
    const pending = deferred<OperatorStopReceipt>()
    const stopRun = vi.fn(() => pending.promise)
    const view = await renderPanel(<PanelShell activeRoute="tasks" onNavigate={() => {}} serviceConnected>
      <TaskDetailScreen api={api} taskId={task.task_id} initialRunId="r2" onBack={() => {}} stopRun={stopRun} />
    </PanelShell>)
    try {
      await view.flush()
      const begin = view.findAll('button').find(button => button.textContent === '停止这次运行')!
      expect(begin).toBeDefined()
      expect(stopRun).not.toHaveBeenCalled()
      await view.click(begin)
      expect(view.text()).toContain('确认停止')
      expect(view.text()).toContain('正在执行的外部操作可能仍需核验')
      expect(stopRun).not.toHaveBeenCalled()

      const confirm = view.findAll('button').find(button => button.textContent === '确认停止')!
      await view.click(confirm)
      expect(stopRun).toHaveBeenCalledTimes(1)
      expect(stopRun).toHaveBeenCalledWith('t1', 'r2')
      await view.click(confirm)
      expect(stopRun).toHaveBeenCalledTimes(1)

      pending.resolve({ state: 'stop_requested', run_id: 'r2', status: 'running', terminal: false,
        skipped_irreversible: 1, pending_decisions: 0 })
      await view.flush()
      expect(view.text()).toContain('已收到停止请求，正在等待执行器确认')
      expect(view.text()).toContain('仍有 1 个不可逆步骤需核实')
      stopState = 'requested'
      await view.flush()
      expect(view.text()).not.toContain('确认停止')
    } finally { view.unmount() }
  })

  it('切换运行后不会沿用旧运行的确认状态，且已结束运行不提供停止按钮', async () => {
    const latestRun = runSummary({ run_id: 'r2', status: 'running', display_status: 'running', operator_stop_state: 'available' })
    const earlierRun = runSummary({ run_id: 'r1', status: 'running', display_status: 'running', operator_stop_state: 'available' })
    let selected = latestRun
    const { api } = apiFrom(({ path, params }) => {
      if (path === '/v1/tasks/get') return { ok: true, data: task }
      if (path === '/v1/runs') return { ok: true, data: { items: [latestRun, earlierRun] } }
      if (path === '/v1/runs/get') return { ok: true, data: params.get('run_id') === selected.run_id ? { ...selected } : { ...earlierRun } }
      if (path === '/v1/node-runs') return { ok: true, data: { items: [] } }
      return missing
    })
    const stopRun = vi.fn(async (_taskId: string, runId: string): Promise<OperatorStopReceipt> => ({
      state: 'stop_requested', run_id: runId, status: 'running', terminal: false,
      skipped_irreversible: 0, pending_decisions: 0,
    }))
    const view = await renderPanel(<PanelShell activeRoute="tasks" onNavigate={() => {}} serviceConnected>
      <TaskDetailScreen api={api} taskId={task.task_id} onBack={() => {}} stopRun={stopRun} />
    </PanelShell>)
    try {
      await view.flush()
      await view.click(view.findAll('button').find(button => button.textContent === '停止这次运行')!)
      expect(view.text()).toContain('确认停止')
      await view.click(view.findAll('button').find(button => button.textContent?.startsWith('运行'))!)
      await view.flush()
      const runRow = view.findAll('.task-run-history button').find(button => button.textContent?.includes('r1'))
        ?? view.findAll('.task-run-history button')[1]
      expect(runRow).toBeDefined()
      await view.click(runRow!)
      await view.flush()
      expect(view.text()).toContain('这次运行')
      expect(view.text()).not.toContain('确认停止')
      await view.click(view.findAll('button').find(button => button.textContent === '停止这次运行')!)
      expect(view.text()).toContain('确认停止')
      await view.click(view.findAll('button').find(button => button.textContent === '确认停止')!)
      await view.flush()
      expect(stopRun).toHaveBeenCalledTimes(1)
      expect(stopRun).toHaveBeenCalledWith('t1', 'r1')

      selected = runSummary({ run_id: 'r1', status: 'cancelled', display_status: '已取消', operator_stop_state: 'closed' })
      await view.rerender(<PanelShell activeRoute="tasks" onNavigate={() => {}} serviceConnected>
        <TaskDetailScreen api={api} taskId={task.task_id} initialRunId="r1" onBack={() => {}} stopRun={stopRun} reloadVersion={1} />
      </PanelShell>)
      await view.flush()
      expect(view.text()).not.toContain('停止这次运行')
      expect(view.text()).not.toContain('确认停止')
      expect(stopRun).toHaveBeenCalledTimes(1)
    } finally { view.unmount() }
  })

  it('单步只有一处摘要，主动展开后加载该次尝试的日志与证据', async () => {
    const node = nodeRunView({ node_id: 'review', node_run_id: 'review-2', title: '核对记忆', attempt: 2 })
    const opened: string[] = []
    const view = await renderPanel(<TaskRunSteps nodes={[node]} renderEvidence={(step) => {
      opened.push(step.node_run_id)
      return <p>日志夹具</p>
    }} />)
    try {
      expect(view.findAll('button.task-flow-step')).toHaveLength(0)
      expect(view.findAll('.task-step-head h4').map((title) => title.textContent)).toEqual(['核对记忆'])
      expect(view.text()).not.toContain('日志夹具')
      expect(opened).toEqual([])
      await view.click(view.findAll('.task-step-more summary')[0]!)
      await view.flush()
      expect(view.text()).toContain('日志夹具')
      expect(opened).toEqual(['review-2'])
    } finally { view.unmount() }
  })

  it('多步优先检查异常，保持选择顺序与等待依赖，历史尝试不增加步骤', async () => {
    const doc = readCanvasDoc({ name: '并行核验', nodes: [
      { node_id: 'write', title: '编写报告', type: 'agent' }, { node_id: 'check', title: '独立核对', type: 'agent' },
      { node_id: 'join', title: '汇总', type: 'agent' },
    ], edges: [{ from: 'write', to: 'join' }, { from: 'check', to: 'join' }] })
    const view = await renderPanel(<TaskRunSteps doc={doc} nodes={[
      nodeRunView({ node_run_id: 'write', node_id: 'write', title: '编写报告', status: 'started', status_label: '执行中' }),
      nodeRunView({ node_run_id: 'check-1', node_id: 'check', title: '旧核对名', status: 'superseded' }),
      nodeRunView({ node_run_id: 'check-2', node_id: 'check', title: '独立核对', attempt: 2, status: 'failed', status_label: '核对未通过', hang_reason: '证据不全' }),
      nodeRunView({ node_run_id: 'join', node_id: 'join', title: '汇总', execution_state: 'waiting_dependencies', depends_on: ['write', 'check'], waiting_on: ['write', 'check'] }),
    ]} />)
    try {
      const picker = view.findAll('button.task-flow-step')
      expect(picker.map((button) => button.querySelector('strong')?.textContent)).toEqual(['编写报告', '独立核对', '汇总'])
      expect(picker[1]?.getAttribute('aria-pressed')).toBe('true')
      expect(view.text()).toContain('1 步需关注')
      expect(view.text()).toContain('同层最多 2 步')
      const detail = view.container.querySelector('.task-step-inspector')!
      expect(detail.textContent).toContain('证据不全')
      expect(detail.textContent).toContain('第 2 次尝试')
      await view.click(picker[2]!)
      expect(detail.textContent).toContain('等待：编写报告、独立核对')
      expect(detail.textContent?.match(/编写报告、独立核对/gu)).toHaveLength(1)
    } finally { view.unmount() }
  })

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
