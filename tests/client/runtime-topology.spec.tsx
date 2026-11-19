// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { createReworkApi } from '../../src/client/api/rework.ts'
import { TaskFlowView } from '../../src/client/panel/task-flow-view.tsx'
import { TaskDetailScreen } from '../../src/client/panel/task-detail-screen.tsx'
import { WorkflowCanvasView } from '../../src/client/panel/workflow-canvas-view.tsx'
import { currentAttempts, runtimeCanvasDoc, type RunTopology } from '../../src/client/panel/runtime-topology.ts'
import { createFakeService, nodeRunView, renderPanel, runSummary, taskSummary } from './harness.ts'

const definition = { name: '真实性能报告', nodes: [
  { node_id: 't', type: 'trigger', title: '开始', position: { x: 0, y: 0 } },
  { node_id: 'a', type: 'agent', title: '采集数据', position: { x: 240, y: 0 } },
  { node_id: 'c', type: 'agent', title: '报告作者', position: { x: 480, y: 0 } },
], edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'c' }] }
const topology: RunTopology = {
  edges: [{ from: 'a', to: 'rw_prepare' }, { from: 'rw_prepare', to: 'c' }],
  steps: [{ node_id: 'rw_prepare', before_node_id: 'c', instruction: '先补齐真实测试数据对照表' }],
  requests: [{ request_id: 'rw1', target_node_id: 'a', status: 'awaiting_review', round_no: 2 }], held_node_ids: ['c'],
}
const nodes = [
  nodeRunView({ node_run_id: 'a2', node_id: 'a', title: '采集数据', attempt: 2, status: 'done', status_label: '最新修订成果已交付' }),
  nodeRunView({ node_run_id: 'c1', node_id: 'c', title: '报告作者', status: 'queued', status_label: '等待修订验收' }),
  nodeRunView({ node_run_id: 'a1', node_id: 'a', title: '采集数据', attempt: 1, status: 'done', status_label: '旧成果已交付', replacement_node_run_id: 'a2' }),
  nodeRunView({ node_run_id: 's1', node_id: 'rw_prepare', title: 'rw_prepare', status: 'started', status_label: '新增步骤正在执行' }),
]
function transport(failTopology = false) {
  const service = createFakeService(({ path }) => {
    if (path === '/v1/rework/topology') return failTopology ? { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'offline', retryable: true } } : { ok: true, data: topology }
    const data = path === '/v1/tasks/get' ? taskSummary()
      : path === '/v1/runs' ? { items: [runSummary()] }
      : path === '/v1/runs/get' ? runSummary()
      : path === '/v1/node-runs' ? { items: nodes }
      : path === '/v1/workflows/versions/get' ? { definition }
      : { items: [], next_cursor: null, has_more: false }
    return { ok: true, data }
  })
  const client = createApiClient('http://panel.test', service.fetcher)
  return { api: createResourcesApi(client), commands: createReworkApi(client), service }
}

describe('运行级局部拓扑', () => {
  it('merges approved steps/edges without changing the pinned definition; selects the same current attempt independent of row order', async () => {
    const original = JSON.stringify(definition)
    const doc = runtimeCanvasDoc(definition, topology)!
    expect(doc.nodes.map(n => n.node_id)).toContain('rw_prepare')
    expect(doc.edges).toHaveLength(4)
    expect(JSON.stringify(definition)).toBe(original)
    expect(currentAttempts(nodes).get('a')?.node_run_id).toBe('a2')
    expect(currentAttempts([...nodes].reverse()).get('a')?.node_run_id).toBe('a2')
    const view = await renderPanel(<WorkflowCanvasView definition={definition} readOnly={false} runtimeTopology={topology} />)
    expect(view.findAll('[data-node-id="rw_prepare"]')).toHaveLength(0)
    expect(view.findAll('[data-runtime-edge]')).toHaveLength(0)
    view.unmount()
  })
  it('draws real additions on the task flow canvas with current attempts, source role, feedback and affected node markings', async () => {
    const { api, service } = transport()
    const view = await renderPanel(<TaskFlowView api={api} tasks={[taskSummary()]} reloadVersion={0} reworkEnabled onOpenTask={() => {}} />)
    await view.flush()
    expect(service.calls.find(c => c.path === '/v1/rework/topology')?.params.get('run_id')).toBe('r1')
    expect(view.findAll('[data-canvas-id="task-run-flow"] [data-node-id="rw_prepare"][data-runtime-added="true"]')).toHaveLength(1)
    expect(view.findAll('[data-edge-from="a"][data-edge-to="rw_prepare"][data-runtime-edge="true"]')).toHaveLength(1)
    expect(view.findAll('[data-edge-from="rw_prepare"][data-edge-to="c"]')).toHaveLength(1)
    expect(view.findAll('[data-node-id="a"]')[0]?.getAttribute('data-runtime-attempt')).toBe('2')
    expect(view.findAll('[data-node-id="a"]')[0]?.textContent).toContain('成果反馈 · 第 2 轮')
    expect(view.findAll('[data-node-id="c"][data-runtime-held="true"]')).toHaveLength(1)
    expect(view.findAll('[data-node-id="rw_prepare"]')[0]?.textContent).toContain('来源角色：报告作者')
    expect(view.text()).not.toContain('旧成果已交付')
    expect(view.findAll('.task-flow-step').map(e => e.textContent)).toEqual([
      expect.stringContaining('采集数据'), expect.stringContaining('rw_prepare'), expect.stringContaining('报告作者'),
    ])
    await view.click(view.findAll('[data-node-id="rw_prepare"] button')[0]!)
    expect(view.findAll('aside[aria-label="节点详情"]')[0]?.textContent).toContain('先补齐真实测试数据对照表')
    view.unmount()
  })
  it('uses the runtime overlay in task detail orchestration while preserving the fixed workflow version', async () => {
    const { api, commands, service } = transport()
    const view = await renderPanel(<TaskDetailScreen api={api} taskId="t1" rework={commands} onBack={() => {}} />)
    await view.flush()
    await view.click(view.findAll('button').find(b => b.textContent === '编排')!)
    await view.flush()
    expect(service.calls.some(c => c.path === '/v1/rework/topology' && c.params.get('run_id') === 'r1')).toBe(true)
    expect(view.findAll('[data-canvas-id="task-drawer-flow"] [data-node-id="rw_prepare"]')).toHaveLength(1)
    expect(view.findAll('[data-canvas-id="task-drawer-flow"] [data-edge-from="rw_prepare"][data-edge-to="c"]')).toHaveLength(1)
    expect(service.calls.find(c => c.path === '/v1/workflows/versions/get')?.params.get('version')).toBe('1')
    view.unmount()
  })
  it('reports unavailable runtime topology instead of showing the base graph as a complete runtime graph', async () => {
    const { api } = transport(true)
    const view = await renderPanel(<TaskFlowView api={api} tasks={[taskSummary()]} reloadVersion={0} reworkEnabled onOpenTask={() => {}} />)
    await view.flush()
    expect(view.text()).toContain('运行拓扑读取失败')
    expect(view.findAll('[data-canvas-id="task-run-flow"]')).toHaveLength(0)
    view.unmount()
  })
})
