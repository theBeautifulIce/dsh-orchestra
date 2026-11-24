// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import type { WorkflowView } from '../../src/client/api/types.ts'
import { PanelApp } from '../../src/client/panel/app.tsx'
import { TaskListScreen } from '../../src/client/panel/tasks-screen.tsx'
import { readStepWindow } from '../../src/client/panel/task-step-overview.tsx'
import { createFakeService, nodeRunView, renderPanel, runSummary, taskSummary, workflowItem } from './harness.ts'

it('T05 继续读取后仍保留尚在后页的受阻项，并在读完时去重', async () => {
  const step=(index:number)=>nodeRunView({node_run_id:'node-'+index,node_id:'step-'+index,status:'queued'})
  const attention=nodeRunView({node_run_id:'blocked-last',node_id:'blocked-last',status:'blocked_post'})
  const service=createFakeService(({params})=>({ok:true,data:params.get('only')==='attention'
    ? {items:[attention]}
    : params.get('cursor')==='page3'?{items:[attention],next_cursor:null}
    : params.get('cursor')==='page2'?{items:Array.from({length:200},(_,i)=>step(i+200)),next_cursor:'page3'}
    : {items:Array.from({length:200},(_,i)=>step(i)),next_cursor:'page2'}}))
  const api=createResourcesApi(createApiClient('http://panel.test',service.fetcher))
  for(const pages of [1,2,3]) {
    const window=await readStepWindow(api,'r1',pages,()=>true)
    expect(window?.nodes.filter(node=>node.node_run_id==='blocked-last')).toHaveLength(1)
    expect(window?.partial).toBe(pages<3)
  }
  expect(service.calls.filter(call=>call.params.get('only')==='attention')).toHaveLength(2)
})

it('T01 卡片主动作把子运行和文件版本带进结果页，并预选实际审核表单', async () => {
  const sha='a'.repeat(64)
  const action={kind:'review' as const,label:'打开「本次报告.md」验收',run_id:'child',node_run_id:'child-report',artifact_id:'version-new',sha256:sha,file_name:'本次报告.md'}
  const task=taskSummary({title:'人读交付',lane:'attention',next_action:action,delivery_review_count:1})
  const artifact={artifact_id:'version-new',run_id:'child',source_node_run_id:'child-report',sha256:sha,file_name:'本次报告.md',retain_until:null,created_at:task.updated_at}
  const service=createFakeService(({path,params})=> {
    if(path==='/v1/tasks')return {ok:true,data:{items:[task],next_cursor:null}}
    if(path==='/v1/tasks/get')return {ok:true,data:task}
    if(path==='/v1/runs')return {ok:true,data:{items:[runSummary()]}}
    if(path==='/v1/runs/get')return {ok:true,data:runSummary({run_id:params.get('run_id')!})}
    if(path==='/v1/node-runs')return {ok:true,data:{items:[nodeRunView({run_id:'child',node_run_id:'child-report',node_id:'report',node_type:'agent',status:'done'})],has_more:false}}
    if(path==='/v1/artifacts')return {ok:true,data:{items:[{...artifact,artifact_id:'version-old',sha256:'b'.repeat(64)},artifact],has_more:false}}
    if(path==='/v1/artifacts/content')return {ok:true,data:{kind:'preview',file_name:artifact.file_name,sha256:sha,text:'本次交付正文',truncated:false}}
    if(path==='/v1/rework')return {ok:true,data:{items:[]}}
    if(path==='/v1/rework/holds')return {ok:true,data:{items:[{run_id:'child',node_id:'report',node_run_id:'child-report',status:'held',hold_id:'hold-1',revision:1}]}}
    return {ok:false,error:{code:'NOT_FOUND',message:'fixture',retryable:false}}
  })
  const view=await renderPanel(<PanelApp client={createApiClient('http://panel.test',service.fetcher)} serviceConnected reworkEnabled scopeLabel="当前会话" />)
  try {
    await view.flush()
    expect(view.text()).toContain('当前会话中的任务')
    await view.click(view.findAll('button').find(button=>button.textContent===action.label)!)
    await view.flush()
    const inspector=view.container.querySelector('#task-inspector')!
    expect(inspector.querySelector('[aria-pressed="true"]')?.textContent).toBe('结果')
    const selected=Array.from(inspector.querySelectorAll('select')).map(select=>select.value)
    expect(selected).toContain('child-report')
    expect(selected).toContain('version-new')
    expect(inspector.textContent).toContain('本次交付正文')
    expect(service.calls.some(call=>call.path==='/v1/runs/get' && call.params.get('run_id')==='child')).toBe(true)
    expect(inspector.querySelector('details[open]')?.textContent).toContain('审核成果或提出修改')
  } finally {view.unmount()}
})

it('T14/T15 待处理列先出现，范围来自入口声明，独立连接不冒称当前会话', async () => {
  const service=createFakeService(()=>({ok:true,data:{items:[taskSummary({lane:'attention'})]}}))
  const api=createResourcesApi(createApiClient('http://panel.test',service.fetcher))
  const view=await renderPanel(<TaskListScreen api={api} onSelectTask={()=>{}} />)
  try {
    await view.flush()
    expect(view.text()).toContain('当前连接中的任务')
    expect(view.text()).not.toContain('当前会话')
    expect(view.findAll('[data-task-column]')[0]?.getAttribute('data-task-column')).toBe('attention')
    await view.click(view.findAll('button').find(button=>button.textContent==='列表')!)
    expect(view.findAll('tbody td[data-label]').map(cell=>cell.getAttribute('data-label'))).toEqual(['任务','下一步','状态','当前情况','运行次数','更新时间'])
  } finally {view.unmount()}
})

it.each([false, true])('流程页打开 B 运行只使用本次目标（此前打开 A 验收：%s）', async (previousReview) => {
  const sha = 'a'.repeat(64)
  const action = { kind: 'review' as const, label: '打开「A 报告.md」验收', run_id: 'run-a', node_run_id: 'node-a',
    artifact_id: 'artifact-a', sha256: sha, file_name: 'A 报告.md' }
  const taskA = taskSummary({ task_id: 'task-a', current_run_id: 'run-a', title: '任务 A', lane: 'attention', next_action: action, delivery_review_count: 1 })
  const taskB = taskSummary({ task_id: 'task-b', current_run_id: 'run-b', title: '任务 B' })
  const runA = runSummary({ run_id: 'run-a', task_id: 'task-a', task_title: '任务 A' })
  const runB = runSummary({ run_id: 'run-b', task_id: 'task-b', task_title: '任务 B' })
  const fileA = { artifact_id: 'artifact-a', run_id: 'run-a', source_node_run_id: 'node-a', sha256: sha,
    file_name: 'A 报告.md', retain_until: null, created_at: taskA.updated_at }
  const workflow = workflowItem({ name: '核对流程', current_version: 1, has_draft: false, node_count: 1 })
  const workflowView: WorkflowView = { workflow, draft: null,
    current: { workflow_id: workflow.workflow_id, version: 1, based_on_version: null,
      definition: { name: '核对流程', nodes: [{ node_id: 'start', type: 'trigger', title: '开始' }], edges: [] },
      definition_hash: 'hash', publish_note: '', published_at: taskA.updated_at, published_by: 'human:alice', projection_missing: [] },
    validation: { errors: [], warnings: [] }, versions: [] }
  const service = createFakeService(({ path, params }) => {
    if (path === '/v1/tasks') return { ok: true, data: { items: [taskA, taskB], next_cursor: null } }
    if (path === '/v1/tasks/get') return { ok: true, data: params.get('task_id') === 'task-a' ? taskA : taskB }
    if (path === '/v1/runs') return { ok: true, data: { items: params.get('task_id') === 'task-a' ? [runA] : [runB], next_cursor: null } }
    if (path === '/v1/runs/get') return { ok: true, data: params.get('run_id') === 'run-a' ? runA : runB }
    if (path === '/v1/node-runs') return { ok: true, data: { items: params.get('run_id') === 'run-a'
      ? [nodeRunView({ run_id: 'run-a', node_run_id: 'node-a', node_id: 'report', node_type: 'agent', status: 'done' })] : [], has_more: false } }
    if (path === '/v1/artifacts') return { ok: true, data: { items: params.get('run_id') === 'run-a' ? [fileA] : [], next_cursor: null } }
    if (path === '/v1/artifacts/content') return { ok: true, data: { kind: 'preview', file_name: fileA.file_name, sha256: sha, text: 'A 的精确交付正文', truncated: false } }
    if (path === '/v1/rework') return { ok: true, data: { items: [] } }
    if (path === '/v1/rework/holds') return { ok: true, data: { items: params.get('run_id') === 'run-a'
      ? [{ run_id: 'run-a', node_id: 'report', node_run_id: 'node-a', status: 'held', hold_id: 'hold-a', revision: 1 }] : [] } }
    if (path === '/v1/workflows') return { ok: true, data: { items: [workflow], next_cursor: null } }
    if (path === '/v1/workflows/get') return { ok: true, data: workflowView }
    return { ok: false, error: { code: 'NOT_FOUND', message: 'fixture', retryable: false } }
  })
  const view = await renderPanel(<PanelApp client={createApiClient('http://panel.test', service.fetcher)} serviceConnected reworkEnabled />)
  const clickText = async (label: string) => {
    const target = view.findAll('button').find(button => button.textContent === label)
    expect(target, '缺少实际按钮：' + label).toBeDefined()
    await view.click(target!)
    await view.flush()
  }
  try {
    await view.flush()
    if (previousReview) {
      await clickText(action.label)
      const inspector = view.container.querySelector('#task-inspector')!
      expect(inspector.querySelector('[aria-pressed="true"]')?.textContent).toBe('结果')
      expect(inspector.textContent).toContain('A 的精确交付正文')
      expect(Array.from(inspector.querySelectorAll('select')).map(select => select.value)).toContain('artifact-a')
      await clickText('关闭')
    }
    await clickText('Workflow 管理')
    await clickText('查看流程')
    await clickText('运行记录')
    const requestsBefore = service.calls.length
    await clickText('任务 B')
    const selectedRuns = service.calls.slice(requestsBefore)
      .filter(call => call.path === '/v1/runs/get').map(call => call.params.get('run_id'))
    const inspector = view.container.querySelector('#task-inspector')!
    expect(inspector.querySelector('#task-detail-title')?.textContent).toBe('任务 B')
    expect(selectedRuns, '实际请求运行应是用户刚点选的 B').toEqual(['run-b'])
    expect(inspector.querySelector('[aria-pressed="true"]')?.textContent).toBe('步骤')
    expect(inspector.querySelector('[role="alert"]')).toBeNull()
  } finally { view.unmount() }
})
