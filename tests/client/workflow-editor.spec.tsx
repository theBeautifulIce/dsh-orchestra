// @vitest-environment jsdom
// S5-D 面板：加载草稿 → 改 → 保存 → 回执；结构校验与计划质量意见分两块；冲突不丢用户草稿
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { renderPanel, type PanelView } from './harness.ts'
import { ApiError } from '../../src/client/api/client.ts'
import type { OperationRow, WorkflowView } from '../../src/client/api/types.ts'
import type { UpdateDraftInput, WorkflowCommandsApi } from '../../src/client/api/workflow-commands.ts'
import { WorkflowEditor } from '../../src/client/panel/workflow-editor.tsx'
import { PanelShell } from '../../src/client/panel/shell.tsx'

const NOW = '2026-11-17T10:00:00.000Z'

const DOC = {
  name: '流程一',
  nodes: [
    { node_id: 't', type: 'trigger', title: '开始', position: { x: 0, y: 0 } },
    { node_id: 'a', type: 'agent', title: '第二步', position: { x: 0, y: 100 } },
  ],
  edges: [{ from: 't', to: 'a' }],
}

const EDITED = JSON.stringify({
  name: '流程一',
  nodes: [
    { node_id: 't', type: 'trigger', title: '开始', position: { x: 0, y: 0 } },
    { node_id: 'a', type: 'agent', title: '改过的第二步', position: { x: 0, y: 100 } },
  ],
  edges: [{ from: 't', to: 'a' }],
}, null, 2)

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

function receiptRow(operationId: string, kind: string): OperationRow {
  return {
    operation_id: operationId,
    kind,
    status: 'applied',
    receipt_json: null,
    created_at: NOW,
    completed_at: NOW,
    receipt_expired_at: null,
  }
}

const unused = async (): Promise<never> => { throw new Error('这个命令不该被调用') }

function fakeCommands(over: Partial<WorkflowCommandsApi>): WorkflowCommandsApi {
  return {
    createWorkflow: unused,
    openWorkflowDraft: unused,
    updateWorkflowDraft: unused,
    publishWorkflow: unused,
    getOperation: unused,
    ...over,
  }
}

function editorOf(view: PanelView): HTMLTextAreaElement {
  // 不用纯 #id 选择器：同一文档里多个面板实例会带同一个 id，纯 id 选择器在 jsdom 下不可靠。
  const editors = Array.from(view.container.querySelectorAll('textarea'))
  const editor = editors.find((element) => element.id === 'workflow-definition-editor')
  if (!editor) throw new Error('找不到流程定义编辑区')
  return editor
}

/** 用原生 setter 改值再派发 input，React 的 onChange 才认。 */
async function typeText(element: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function clickButton(view: PanelView, label: string): Promise<void> {
  const button = view.findAll('button').find((element) => element.textContent?.trim() === label)
  if (!button) throw new Error('找不到按钮：' + label)
  await view.click(button)
  await view.flush()
}

describe('流程草稿编辑屏', () => {
  it('在智能体节点配置核实后重试，保留其他配置并用草稿保存', async () => {
    const calls: UpdateDraftInput[] = []
    const commands = fakeCommands({
      updateWorkflowDraft: async (input) => {
        calls.push(input)
        return {
          operation_id: 'retry-opt-in',
          kind: 'workflow.update',
          replayed: false,
          result: { revision: 3, changed: true, validation: { errors: [], truncated: false, total: 0 } },
          receipt: receiptRow('retry-opt-in', 'workflow.update'),
        }
      },
    })
    const workflow = viewFixture()
    const view = await renderPanel(<WorkflowEditor commands={commands} workflow={{
      ...workflow, draft: {
        ...workflow.draft!,
        definition: { ...DOC, nodes: [DOC.nodes[0], { ...DOC.nodes[1], config: { side_effect_policy: 'pure' } }] },
      },
    }} onRefresh={() => {}} />)
    const checkbox = () => view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(checkbox()).toBeNull()
    await clickButton(view, '第二步')
    expect(checkbox()?.checked).toBe(false)
    await view.click(checkbox()!)
    expect(checkbox()?.checked).toBe(true)
    expect(calls).toHaveLength(0)
    await view.click(checkbox()!)
    expect(JSON.parse(editorOf(view).value).nodes[1].config).toEqual({ side_effect_policy: 'pure' })
    await view.click(checkbox()!)
    await clickButton(view, '保存草稿')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.definition).toMatchObject({
      nodes: [DOC.nodes[0], { ...DOC.nodes[1], config: { side_effect_policy: 'pure', recovery_retry_idempotent: true } }],
      edges: DOC.edges,
    })
  })

  it('Q-20 过期快照保留草稿和本地编辑，恢复连接后才发送保存与测试', async () => {
    const writes: string[] = []
    const commands = fakeCommands({
      updateWorkflowDraft: async () => {
        writes.push('save')
        return { operation_id: 'save', kind: 'workflow.update', replayed: false,
          result: { revision: 2, changed: false, validation: { errors: [], total: 0, truncated: false } }, receipt: receiptRow('save', 'workflow.update') }
      },
      testWorkflow: async () => {
        writes.push('test')
        return { revision: 2, passed: true, tested_at: NOW, order: [], issues: { errors: [], total: 0, truncated: false } }
      },
    })
    const workflow = viewFixture()
    const render = (snapshotStale: boolean) => <PanelShell activeRoute="workflows" onNavigate={() => {}}
      serviceConnected snapshotStale={snapshotStale}><WorkflowEditor commands={commands} workflow={workflow} onRefresh={() => {}} /></PanelShell>
    const view = await renderPanel(render(false))
    await typeText(editorOf(view), EDITED)
    await view.rerender(render(true))
    const button = (label: string) => view.findAll('button').find((item) => item.textContent === label) as HTMLButtonElement
    expect(editorOf(view).value).toBe(EDITED)
    for (const label of ['保存草稿', '运行结构与模拟流转测试', '确认发布']) {
      expect(button(label).disabled).toBe(true)
      await view.click(button(label))
    }
    expect(writes).toEqual([])
    await view.rerender(render(false))
    await clickButton(view, '保存草稿')
    await clickButton(view, '运行结构与模拟流转测试')
    expect(writes).toEqual(['save', 'test'])
    expect(button('确认发布').disabled).toBe(false)
    view.unmount()
  })

  it('只把当前修订的结构与模拟流转测试用于发布闸', async () => {
    const commands = fakeCommands({
      testWorkflow: async (_workflowId, revision) => ({
        revision, passed: true, tested_at: NOW,
        issues: { errors: [], truncated: false, total: 0 },
        order: DOC.nodes.map(({ node_id, title, type }) => ({ node_id, title, type })),
      }),
    })
    const workflow = viewFixture()
    const view = await renderPanel(<WorkflowEditor commands={commands} workflow={workflow} onRefresh={() => {}} />)
    const publish = () => view.findAll('button').find((button) => button.textContent === '确认发布') as HTMLButtonElement

    expect(publish().disabled).toBe(true)
    expect(view.text()).toContain('当前草稿须通过结构与模拟流转测试后才能发布')
    await clickButton(view, '运行结构与模拟流转测试')
    expect(view.text()).toContain('结构与模拟流转测试通过 · 修订 2')
    expect(view.text()).toContain('实际工具调用、Agent 执行和交付验收需要在正式运行中验证')
    expect(publish().disabled).toBe(false)

    const next = viewFixture({ draft: { ...workflow.draft!, revision: 3 } })
    await view.rerender(<WorkflowEditor commands={commands} workflow={next} onRefresh={() => {}} />)
    expect(publish().disabled).toBe(true)
    expect(view.text()).not.toContain('结构与模拟流转测试通过 · 修订 2')
  })

  it('加载草稿 → 改定义 → 保存 → 显示保存回执', async () => {
    const calls: UpdateDraftInput[] = []
    let refreshes = 0
    const commands = fakeCommands({
      updateWorkflowDraft: async (input) => {
        calls.push(input)
        return {
          operation_id: 'op-save-1',
          kind: 'workflow.update',
          replayed: false,
          result: {
            revision: 3,
            changed: true,
            validation: {
              errors: [{ path: '/nodes/1', code: 'WORKFLOW_NO_OUT_EDGE', message: '这个节点没有出边' }],
              truncated: false,
              total: 1,
            },
          },
          receipt: receiptRow('op-save-1', 'workflow.update'),
        }
      },
    })
    const view = await renderPanel(
      <WorkflowEditor commands={commands} workflow={viewFixture()} onRefresh={() => { refreshes += 1 }} />,
    )
    expect(editorOf(view).value).toContain('流程一')

    await typeText(editorOf(view), EDITED)
    await clickButton(view, '保存草稿')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.workflow_id).toBe('wf1')
    expect(calls[0]?.revision).toBe(2)
    expect(JSON.stringify(calls[0]?.definition)).toContain('改过的第二步')
    expect(refreshes).toBe(1)
    // 回执块：operation_id、kind、回执状态
    expect(view.text()).toContain('保存回执')
    expect(view.text()).toContain('op-save-1')
    expect(view.text()).toContain('workflow.update')
    expect(view.text()).toContain('applied')
    expect(view.text()).toContain('新修订 3')
  })

  it('结构校验与计划质量意见分两块呈现，质量意见不阻断保存', async () => {
    const commands = fakeCommands({
      updateWorkflowDraft: async () => {
        throw new Error('这一条不用于本用例')
      },
    })
    const view = await renderPanel(
      <WorkflowEditor
        commands={commands}
        workflow={viewFixture({
          validation: {
            errors: [{ path: '/nodes/0', code: 'WORKFLOW_NODE_ID_INVALID', message: 'node_id 不合法' }],
            warnings: [{ path: '/nodes/1', code: 'WORKFLOW_NO_TRIGGER', message: '没有触发节点' }],
          },
        })}
        onRefresh={() => {}}
      />,
    )
    const structural = view.container.querySelector('[data-validation-group="结构校验"]')
    const quality = view.container.querySelector('[data-validation-group="计划质量意见"]')
    expect(structural).not.toBeNull()
    expect(quality).not.toBeNull()
    expect(structural?.textContent).toContain('WORKFLOW_NODE_ID_INVALID')
    expect(structural?.textContent).not.toContain('WORKFLOW_NO_TRIGGER')
    expect(quality?.textContent).toContain('WORKFLOW_NO_TRIGGER')
    expect(quality?.textContent).not.toContain('WORKFLOW_NODE_ID_INVALID')
    // 有结构错误时发布按钮不可点
    const publish = view.findAll('button').find((element) => element.textContent?.trim() === '确认发布')
    expect((publish as HTMLButtonElement | undefined)?.disabled).toBe(true)
    expect(view.text()).toContain('发布前须修复结构错误。')
  })

  it('保存被 CAS 拒绝时显示冲突文案，并且不丢用户草稿', async () => {
    const commands = fakeCommands({
      updateWorkflowDraft: async () => {
        throw new ApiError('WORKFLOW_REVISION_CONFLICT', '草稿 revision 已变', false, { expected: 2, current_revision: 3 })
      },
    })
    const view = await renderPanel(
      <WorkflowEditor commands={commands} workflow={viewFixture()} onRefresh={() => {}} />,
    )

    await typeText(editorOf(view), EDITED)
    await clickButton(view, '保存草稿')

    expect(view.byRole('alert').length).toBeGreaterThan(0)
    expect(view.text()).toContain('草稿已被别的修订改动')
    expect(view.text()).toContain('WORKFLOW_REVISION_CONFLICT')
    expect(view.text()).toContain('重新加载')
    // 草稿还在，没有被静默覆盖
    expect(editorOf(view).value).toContain('改过的第二步')
  })

  it('外部修订变了也不覆盖用户手里的草稿', async () => {
    const commands = fakeCommands({})
    const view = await renderPanel(
      <WorkflowEditor commands={commands} workflow={viewFixture()} onRefresh={() => {}} />,
    )
    await typeText(editorOf(view), '用户正在写的内容')
    const next = viewFixture()
    next.draft = { ...next.draft!, revision: 3 }
    await view.rerender(
      <WorkflowEditor commands={commands} workflow={next} onRefresh={() => {}} />,
    )
    expect(editorOf(view).value).toContain('用户正在写的内容')
    expect(view.text()).toContain('草稿已被别的修订改动')
  })
})
