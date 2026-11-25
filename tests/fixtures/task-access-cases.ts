import assert from 'node:assert/strict'
import { taskAccess, restrictedTaskToolReason } from '../../src/core/task-access.ts'
import { requirementIssues, canStartAtRequiredGate, type RequirementNode } from '../../src/service/task-requirement-checks.ts'
import type { RequirementsContract, TaskRequirement } from '../../src/core/task-requirements.ts'

const source = { message_id: 'owner-message', text: '请计算预算。批准前计算必须等待。不联网，不读写工作区文件。结果返回本会话。' }
const cite = (id: string, quote: string) => ({ id, quote, source_message_id: source.message_id })
const network: TaskRequirement = { ...cite('net','不联网'), kind: 'no_network' }
const noRead: TaskRequirement = { ...cite('read','不读写工作区文件'), kind: 'no_workspace_read' }
const noWrite: TaskRequirement = { ...cite('write','不读写工作区文件'), kind: 'no_workspace_files' }
const chat: TaskRequirement = { ...cite('chat','结果返回本会话'), kind: 'chat_only' }
const approval: TaskRequirement = { ...cite('gate','批准前计算必须等待'), kind: 'approval_before', scope: 'steps', action: '计算', reviewer: { kind: 'operator' } }
export const accessContract = (...constraints: TaskRequirement[]): RequirementsContract => ({ version: 1, start_policy: 'immediate', sources: [source], constraints })
const nodes: RequirementNode[] = [{ id: 'gate', type: 'approval', dependsOn: [], declaredTools: [] },
  { id: 'calc', type: 'agent', sideEffectPolicy: 'pure', dependsOn: ['gate'], declaredTools: [] }]
const plan = { steps: [{ node_id: 'gate', tools: [] }, { node_id: 'calc', tools: [] }],
  deliverables: [{ acceptance: { kind: 'chat/text_result' } }],
  constraint_bindings: [{ constraint_id: 'gate', approval_node_id: 'gate', protected_node_ids: ['calc'] }] }
const contract = accessContract(network, noRead, noWrite, chat, approval)
export const taskAccessCases: { name: string; run(): void }[] = [
  { name: 'legacy workspace-write constraint does not prohibit workspace reads', run() {
    assert.equal(taskAccess(accessContract(noWrite)).noWorkspaceWrite, true)
    assert.equal(taskAccess(accessContract(noWrite)).noWorkspaceRead, false)
    assert.equal(restrictedTaskToolReason(accessContract(noWrite)), undefined)
  } },
  { name: 'network and workspace read are independent and cumulative', run() {
    assert.equal(taskAccess(accessContract(network)).noWorkspaceRead, false)
    assert.equal(taskAccess(accessContract(noRead)).noNetwork, false)
    assert.match(restrictedTaskToolReason(accessContract(network, noRead), true) ?? '', /网络/u)
    assert.match(restrictedTaskToolReason(accessContract(noRead)) ?? '', /读取工作区/u)
    assert.equal(restrictedTaskToolReason(accessContract(noRead), true), undefined)
  } },
  { name: 'opaque code is unavailable for task access boundaries', run() {
    for (const kind of [network, noRead, noWrite]) assert.equal(taskAccess(accessContract(kind)).noOpaqueCode, true)
    assert.equal(taskAccess(accessContract(chat)).noOpaqueCode, false)
  } },
  { name: 'T03 text-only plan with explicit approval is valid', run() {
    assert.deepEqual(requirementIssues(contract,plan,nodes),[])
    assert.equal(canStartAtRequiredGate(contract,plan,nodes),true)
  } },
  { name: 'both explicit and declared fixed tools are rejected', run() {
    assert.ok(requirementIssues(contract,{...plan,steps:[{node_id:'calc',tools:['ro.command']}]},nodes).length)
    assert.ok(requirementIssues(contract,plan,nodes.map(n=>n.id==='calc'?{...n,declaredTools:['ro.command']}:n)).length)
  } },
  { name: 'subflows and tool nodes cannot bypass unproven access restrictions', run() {
    for (const type of ['tool','subworkflow']) assert.ok(requirementIssues(contract,plan,nodes.map(n=>n.id==='calc'?{...n,type}:n)).length)
  } },
  { name: 'workflow gate start never waives whole-task approval or plan-only', run() {
    assert.equal(canStartAtRequiredGate({...contract,start_policy:'plan_only'},plan,nodes),false)
    const whole: TaskRequirement = {...cite('whole','批准前计算必须等待'),kind:'approval_before',scope:'task',reviewer:{kind:'operator'}}
    assert.equal(canStartAtRequiredGate(accessContract(approval,whole),plan,nodes),false)
    assert.equal(canStartAtRequiredGate(accessContract(network),plan,nodes),false)
  } },
  { name: 'unbound gate, wrong dependency, or uncorroborated agent effect never auto-start', run() {
    assert.equal(canStartAtRequiredGate(contract,{...plan,constraint_bindings:[]},nodes),false)
    assert.equal(canStartAtRequiredGate(contract,plan,nodes.map(n=>n.id==='calc'?{...n,dependsOn:[]}:n)),false)
    for (const effect of ['compensable','irreversible',undefined]) assert.equal(canStartAtRequiredGate(contract,plan,nodes.map(n=>n.id==='calc'?{...n,sideEffectPolicy:effect}:n)),false)
    assert.equal(canStartAtRequiredGate(contract,plan,[...nodes,{id:'another',type:'approval',dependsOn:[],declaredTools:[]}]),false)
  } },
  { name: 'prohibited workspace delivery and extra control nodes fail the narrow gate route', run() {
    assert.equal(canStartAtRequiredGate(contract,{...plan,deliverables:[{acceptance:{kind:'artifact'}}]},nodes),false)
    assert.equal(canStartAtRequiredGate(contract,plan,[...nodes,{id:'wait',type:'wait',dependsOn:[],declaredTools:[]}]),false)
  } },
]
