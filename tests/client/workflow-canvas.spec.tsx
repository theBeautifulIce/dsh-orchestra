// @vitest-environment jsdom
// S5-D 流程画布：拖动 / 连线 / 增删 / 整理，发布只读，画布与 JSON 抽屉同一份定义
import { act, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { renderPanel, type PanelView } from './harness.ts'
import type { ResourcesApi } from '../../src/client/api/resources.ts'
import type { WorkflowView } from '../../src/client/api/types.ts'
import type { WorkflowCommandsApi } from '../../src/client/api/workflow-commands.ts'
import { WorkflowCanvas } from '../../src/client/panel/workflow-canvas.tsx'
import { WorkflowCanvasView } from '../../src/client/panel/workflow-canvas-view.tsx'
import { WorkflowEditor } from '../../src/client/panel/workflow-editor.tsx'

const NOW = '2026-11-17T10:00:00.000Z'

const NODE_TYPES = [
  'trigger', 'agent', 'tool', 'policy', 'branch', 'approval', 'parallel', 'wait', 'subworkflow',
]

const DOC = {
  name: '流程一',
  nodes: [
    { node_id: 't', type: 'trigger', title: '开始', position: { x: 0, y: 0 } },
    { node_id: 'a', type: 'agent', title: '第二步', position: { x: 0, y: 100 } },
  ],
  edges: [{ from: 't', to: 'a' }],
}

type CanvasNode = { node_id: string; type: string; title: string; position: { x: number; y: number } }
type CanvasEdge = { from: string; to: string; route?: { priority?: number; default?: boolean } }

function q(view: PanelView, selector: string): HTMLElement {
  const element = view.container.querySelector<HTMLElement>(selector)
  if (!element) throw new Error('找不到元素：' + selector)
  return element
}

function qAll(view: PanelView, selector: string): HTMLElement[] {
  return Array.from(view.container.querySelectorAll<HTMLElement>(selector))
}

/** 原生鼠标事件：没有 testing-library，事件在 act 里构造。 */
async function mouse(target: EventTarget, type: string, init: MouseEventInit = {}): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }))
  })
}

async function typeText(element: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function CanvasHarness(props: {
  initial: unknown
  readOnly?: boolean
  onChange?: (definition: Record<string, unknown>) => void
}) {
  const [definition, setDefinition] = useState(props.initial)
  return <WorkflowCanvasView
    definition={definition}
    readOnly={props.readOnly ?? false}
    onChange={(next) => {
      setDefinition(next)
      props.onChange?.(next)
    }}
    canvasId="test-canvas"
  />
}

function lastChange(changes: Array<Record<string, unknown>>): Record<string, unknown> {
  const last = changes[changes.length - 1]
  if (!last) throw new Error('画布没有回报改动')
  return last
}

function nodesOf(definition: Record<string, unknown>): CanvasNode[] {
  return definition.nodes as CanvasNode[]
}

function edgesOf(definition: Record<string, unknown>): CanvasEdge[] {
  return definition.edges as CanvasEdge[]
}

function viewFixture(over: Partial<WorkflowView> = {}): WorkflowView {
  return {
    workflow: {
      workflow_id: 'wf1',
      name: '流程一',
      status: 'active',
      scope: 'reusable',
      owner_task_id: null,
      current_version: 1,
      has_draft: true,
      draft_revision: 2,
      node_count: 2,
      active_task_count: 0,
      published_at: NOW,
      updated_at: NOW,
      projection_missing: [],
    },
    draft: {
      revision: 2,
      based_on_version: 1,
      definition: DOC,
      definition_hash: 'hash-draft',
      updated_at: NOW,
      updated_by: 'human:me',
    },
    current: {
      workflow_id: 'wf1',
      version: 1,
      based_on_version: null,
      definition: DOC,
      definition_hash: 'hash-v1',
      publish_note: '第一版',
      published_at: NOW,
      published_by: 'human:me',
      projection_missing: [],
    },
    validation: { errors: [], warnings: [] },
    versions: [{ version: 1, published_at: NOW, publish_note: '第一版' }],
    ...over,
  }
}

const unused = async (): Promise<never> => {
  throw new Error('这个命令不该被调用')
}

function fakeCommands(over: Partial<WorkflowCommandsApi> = {}): WorkflowCommandsApi {
  return {
    createWorkflow: unused,
    openWorkflowDraft: unused,
    updateWorkflowDraft: unused,
    publishWorkflow: unused,
    getOperation: unused,
    ...over,
  }
}

describe('流程画布', () => {
  it('草稿：拖动节点把新位置写回定义', async () => {
    const changes: Array<Record<string, unknown>> = []
    const view = await renderPanel(<CanvasHarness initial={DOC} onChange={(d) => changes.push(d)} />)

    await mouse(q(view, '[data-node-id="a"]'), 'mousedown', { clientX: 10, clientY: 10 })
    await mouse(document, 'mousemove', { clientX: 70, clientY: 60 })
    await mouse(document, 'mouseup', { clientX: 70, clientY: 60 })

    expect(changes.length).toBeGreaterThan(0)
    const moved = nodesOf(lastChange(changes)).find((node) => node.node_id === 'a')
    expect(moved?.position).toEqual({ x: 60, y: 150 })
    expect(q(view, '[data-node-id="a"]').getAttribute('data-node-x')).toBe('60')
    expect(q(view, '[data-node-id="a"]').getAttribute('data-node-y')).toBe('150')
  })

  it('已发布只读：拖动、连线、增删入口全部禁用', async () => {
    const changes: Array<Record<string, unknown>> = []
    const view = await renderPanel(
      <CanvasHarness initial={DOC} readOnly onChange={(d) => changes.push(d)} />,
    )

    const palette = q(view, '[data-node-palette="agent"]') as HTMLButtonElement
    const handle = q(view, '[data-node-handle="t"]') as HTMLButtonElement
    const remove = q(view, '[data-node-delete="t"]') as HTMLButtonElement
    const arrange = q(view, '[data-canvas-action="arrange"]') as HTMLButtonElement
    for (const entry of [palette, handle, remove, arrange]) {
      expect(entry.disabled).toBe(true)
      expect(entry.getAttribute('aria-disabled')).toBe('true')
    }
    expect(q(view, '[data-node-id="a"]').getAttribute('aria-disabled')).toBe('true')

    await mouse(q(view, '[data-node-id="a"]'), 'mousedown', { clientX: 10, clientY: 10 })
    await mouse(document, 'mousemove', { clientX: 70, clientY: 60 })
    await mouse(document, 'mouseup', { clientX: 70, clientY: 60 })

    expect(changes).toHaveLength(0)
    expect(q(view, '[data-node-id="a"]').getAttribute('data-node-x')).toBe('0')
  })

  it('节点条：九种节点都能拖到画布上，node_id 合规且唯一', async () => {
    const changes: Array<Record<string, unknown>> = []
    const view = await renderPanel(<CanvasHarness initial={DOC} onChange={(d) => changes.push(d)} />)

    expect(qAll(view, '[data-node-palette]')).toHaveLength(9)

    for (const [index, type] of NODE_TYPES.entries()) {
      await mouse(q(view, `[data-node-palette="${type}"]`), 'mousedown', { clientX: 5, clientY: 5 })
      await mouse(q(view, '[data-canvas-surface="true"]'), 'mouseup', {
        clientX: 300 + index * 20,
        clientY: 420,
      })
    }

    const nodes = nodesOf(lastChange(changes))
    expect(nodes).toHaveLength(11)
    const ids = nodes.map((node) => node.node_id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]{0,63}$/)
    for (const node of nodes) {
      expect(node.position.x).toBeGreaterThanOrEqual(0)
      expect(node.position.x).toBeLessThanOrEqual(20000)
      expect(node.position.y).toBeGreaterThanOrEqual(0)
      expect(node.position.y).toBeLessThanOrEqual(20000)
    }
    for (const type of NODE_TYPES) {
      const before = DOC.nodes.filter((node) => node.type === type).length
      const after = nodes.filter((node) => node.type === type).length
      expect(after).toBe(before + 1)
    }
  })

  it('右侧圆点拉边：成功连线，非 branch 节点第二条出边被拒', async () => {
    const doc = {
      name: '流程一',
      nodes: [
        { node_id: 't', type: 'trigger', title: '开始', position: { x: 0, y: 0 } },
        { node_id: 'a', type: 'agent', title: '第二步', position: { x: 0, y: 100 } },
        { node_id: 'b', type: 'agent', title: '第三步', position: { x: 0, y: 200 } },
        { node_id: 'br', type: 'branch', title: '分支', position: { x: 0, y: 300 } },
      ],
      edges: [{ from: 't', to: 'a' }],
    }
    const changes: Array<Record<string, unknown>> = []
    const view = await renderPanel(<CanvasHarness initial={doc} onChange={(d) => changes.push(d)} />)

    // 起点已经有出边（trigger 只允许一条），再拉一条要被拒。
    await mouse(q(view, '[data-node-handle="t"]'), 'mousedown', { clientX: 0, clientY: 0 })
    await mouse(q(view, '[data-node-id="b"]'), 'mouseup', { clientX: 0, clientY: 0 })
    expect(q(view, '[data-canvas-alert="true"]').textContent).toContain('最多只能有一条出边')

    // branch 允许多条出边。
    await mouse(q(view, '[data-node-handle="br"]'), 'mousedown', { clientX: 0, clientY: 0 })
    await mouse(q(view, '[data-node-id="a"]'), 'mouseup', { clientX: 0, clientY: 0 })
    await mouse(q(view, '[data-node-handle="br"]'), 'mousedown', { clientX: 0, clientY: 0 })
    await mouse(q(view, '[data-node-id="b"]'), 'mouseup', { clientX: 0, clientY: 0 })

    const edges = edgesOf(lastChange(changes))
    expect(edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(['t->a', 'br->a', 'br->b'])
    expect(edges.filter((edge) => edge.from === 'br').map((edge) => edge.route?.priority)).toEqual([0, 1])
  })

  it('双击空白加一步', async () => {
    const changes: Array<Record<string, unknown>> = []
    const view = await renderPanel(<CanvasHarness initial={DOC} onChange={(d) => changes.push(d)} />)

    await mouse(q(view, '[data-canvas-surface="true"]'), 'dblclick', { clientX: 500, clientY: 300 })

    const nodes = nodesOf(lastChange(changes))
    expect(nodes).toHaveLength(3)
    const added = nodes[nodes.length - 1]
    expect(added?.type).toBe('agent')
    expect(added?.position).toEqual({ x: 500, y: 300 })
    expect(q(view, '[data-canvas-surface="true"]').querySelectorAll('[data-node-id]')).toHaveLength(3)
  })

  it('删除节点连带删除它的边', async () => {
    const changes: Array<Record<string, unknown>> = []
    const view = await renderPanel(<CanvasHarness initial={DOC} onChange={(d) => changes.push(d)} />)

    await view.click(q(view, '[data-node-delete="a"]'))

    const definition = lastChange(changes)
    expect(nodesOf(definition).map((node) => node.node_id)).toEqual(['t'])
    expect(edgesOf(definition)).toHaveLength(0)
    expect(qAll(view, '[data-node-id]')).toHaveLength(1)
    expect(qAll(view, '[data-edge-row]')).toHaveLength(0)
  })

  it('整理：按拓扑序重排位置', async () => {
    const scrambled = {
      name: '流程一',
      nodes: [
        { node_id: 'c', type: 'agent', title: '第三步', position: { x: 900, y: 900 } },
        { node_id: 'b', type: 'agent', title: '第二步', position: { x: 5, y: 5 } },
        { node_id: 'a', type: 'agent', title: '第一步', position: { x: 500, y: 500 } },
      ],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    }
    const changes: Array<Record<string, unknown>> = []
    const view = await renderPanel(<CanvasHarness initial={scrambled} onChange={(d) => changes.push(d)} />)

    await view.click(q(view, '[data-canvas-action="arrange"]'))

    const nodes = nodesOf(lastChange(changes))
    const byId = new Map(nodes.map((node) => [node.node_id, node.position]))
    expect(byId.get('a')).toEqual({ x: 40, y: 40 })
    expect(byId.get('b')).toEqual({ x: 280, y: 40 })
    expect(byId.get('c')).toEqual({ x: 520, y: 40 })
  })

  it('整理：图里有环时拒绝并给出提示，不静默乱排', async () => {
    const cyclic = {
      name: '流程一',
      nodes: [
        { node_id: 'a', type: 'agent', title: '第一步', position: { x: 10, y: 20 } },
        { node_id: 'b', type: 'agent', title: '第二步', position: { x: 30, y: 40 } },
      ],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    }
    const changes: Array<Record<string, unknown>> = []
    const view = await renderPanel(<CanvasHarness initial={cyclic} onChange={(d) => changes.push(d)} />)

    await view.click(q(view, '[data-canvas-action="arrange"]'))

    expect(q(view, '[data-canvas-alert="true"]').textContent).toContain('环')
    expect(changes).toHaveLength(0)
    expect(q(view, '[data-node-id="a"]').getAttribute('data-node-x')).toBe('10')
    expect(q(view, '[data-node-id="b"]').getAttribute('data-node-y')).toBe('40')
  })

  it('画布改动后 JSON 抽屉同步；抽屉改 JSON 后画布同步', async () => {
    const view = await renderPanel(
      <WorkflowEditor commands={fakeCommands()} workflow={viewFixture()} onRefresh={() => {}} />,
    )

    const drawer = q(view, '[data-definition-drawer="true"]')
    const editor = drawer.querySelector('textarea') as HTMLTextAreaElement
    expect(editor.value).toContain('流程一')

    await mouse(q(view, '[data-canvas-id="draft-canvas"] [data-node-id="t"]'), 'mousedown', {
      clientX: 10,
      clientY: 10,
    })
    await mouse(document, 'mousemove', { clientX: 40, clientY: 70 })
    await mouse(document, 'mouseup', { clientX: 40, clientY: 70 })

    expect(editor.value).toContain('"x": 30')
    expect(editor.value).toContain('"y": 60')

    await mouse(q(view, '[data-canvas-id="draft-canvas"] [data-node-palette="tool"]'), 'mousedown', {
      clientX: 1,
      clientY: 1,
    })
    await mouse(q(view, '[data-canvas-id="draft-canvas"] [data-canvas-surface="true"]'), 'mouseup', {
      clientX: 220,
      clientY: 330,
    })

    expect(editor.value).toContain('tool_1')

    await typeText(editor, JSON.stringify({
      name: '流程一',
      nodes: [
        { node_id: 't', type: 'trigger', title: '开始', position: { x: 0, y: 0 } },
        { node_id: 'extra', type: 'agent', title: '抽屉里加的', position: { x: 11, y: 22 } },
      ],
      edges: [{ from: 't', to: 'extra' }],
    }, null, 2))

    expect(q(view, '[data-canvas-id="draft-canvas"] [data-node-id="extra"]').getAttribute('data-node-x'))
      .toBe('11')
    expect(qAll(view, '[data-canvas-id="draft-canvas"] [data-node-id]')).toHaveLength(2)
  })

  it('已发布只读视图保留：没有命令客户端时画布只读', async () => {
    const api = {
      getWorkflow: async () => ({ data: viewFixture(), as_of_seq: 7 }),
    } as unknown as ResourcesApi
    const view = await renderPanel(
      <WorkflowCanvas api={api} workflowId="wf1" onBack={() => {}} />,
    )

    expect(view.text()).toContain('此屏只读')
    const palette = q(view, '[data-canvas-id="readonly-canvas"] [data-node-palette="agent"]') as HTMLButtonElement
    expect(palette.disabled).toBe(true)
    expect(palette.getAttribute('aria-disabled')).toBe('true')
    expect(q(view, '[data-canvas-id="readonly-canvas"] [data-node-id="a"]')).toBeTruthy()
  })
})
