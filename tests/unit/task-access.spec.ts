import { expect, it } from 'vitest'
import { taskAccessCases, accessContract } from '../fixtures/task-access-cases.ts'
import { interpretSemanticAdmission, type SemanticInput } from '../../src/service/semantic-admission.ts'
import { requirementsContractSchema, mergeRequirementsContracts, type TaskRequirement } from '../../src/core/task-requirements.ts'
import { nativeToolConstraint } from '../../src/executor/dsh-execution-capabilities.ts'
import { dshPlanningInput } from '../../src/executor/planning-input.ts'
import { canStartAtRequiredGate, requirementIssues } from '../../src/service/task-requirement-checks.ts'

for (const item of taskAccessCases) it(item.name, item.run)

const input: SemanticInput = { current: { message_id: 'owner-message', text: '请创建并执行任务。批准前计算必须等待。不联网，不读写工作区文件。结果返回本会话。' }, explicit: true }
const c = (id: string, quote: string) => ({ id, quote, source_message_id: input.current.message_id })
const constraints: TaskRequirement[] = [
  {...c('a','不联网'),kind:'no_network'}, {...c('b','不读写工作区文件'),kind:'no_workspace_read'},
  {...c('c','不读写工作区文件'),kind:'no_workspace_files'}, {...c('d','结果返回本会话'),kind:'chat_only'},
  {...c('e','批准前计算必须等待'),kind:'approval_before',scope:'steps',action:'计算',reviewer:{kind:'operator'}},
]
const raw = {kind:'task',relation:'new',timing:'immediate',quote:'请创建并执行任务',constraints,missing:[]}

it('admits quoted offline/read/write/chat and step approval restrictions without treating the step gate as a task hold',()=>{
  const admitted=interpretSemanticAdmission(input,raw)
  expect(admitted.kind).toBe('ready')
  if(admitted.kind!=='ready') throw Error('Expected admission')
  expect(admitted.request.goal).toBe(input.current.text)
  expect(admitted.request.requirements_contract.constraints.map(item=>item.kind)).toEqual(constraints.map(item=>item.kind))
  expect(requirementsContractSchema.safeParse(admitted.request.requirements_contract).success).toBe(true)
})
it('retains an unsupported literal restriction and displays the cited text rather than inventing an approval conflict',()=>{
  const current={...input,current:{...input.current,text:input.current.text+'禁止任何持久化。'}}
  const denied=interpretSemanticAdmission(current,{...raw,missing:['constraints'],unresolved:[{source_message_id:input.current.message_id,quote:'禁止任何持久化'}]})
  expect(denied).toMatchObject({kind:'clarify',message:expect.stringContaining('禁止任何持久化')})
  expect(denied.draft?.unresolved).toEqual([{source_message_id:input.current.message_id,quote:'禁止任何持久化'}])
  expect(interpretSemanticAdmission(input,{...raw,constraints:[{...constraints[0],source_message_id:'fake'}]}).kind).toBe('clarify')
})
it('typed constraints survive ancestor merging; the external tools remain denied in pure or full permissions',()=>{
  const base=accessContract(...constraints.slice(0,2))
  const merged=mergeRequirementsContracts(base,accessContract(...constraints.slice(2,4)))
  expect(merged.constraints.map(item=>item.kind)).toEqual(['no_network','no_workspace_read','no_workspace_files','chat_only'])
  for(const effect of ['read','unknown','external_write','workspace_write'] as const) {
    expect(nativeToolConstraint('external-tool',effect,{sideEffectPolicy:'pure',requirementsContract:merged})).toContain('网络')
  }
  expect(nativeToolConstraint('read','read',{sideEffectPolicy:'pure',requirementsContract:accessContract(constraints[1]!)})).toContain('读取工作区')
  expect(nativeToolConstraint('read','read',{sideEffectPolicy:'pure',requirementsContract:accessContract(constraints[2]!)})).toBeUndefined()
})

const gateName = '批准预算分析'
const gateActionQuote = '只有我批准该步骤后，才能计算预算剩余金额及支出比例'
const namedGateInput: SemanticInput = { explicit: true, current: {
  message_id: 'budget-request',
  text: `创建并执行任务「T03-人工审批测试」。\n使用模拟数据：预算 10000 元，实际支出 7600 元。\n设置一个名为「${gateName}」的人工审批步骤。${gateActionQuote}，并将完整结果返回当前会话。`,
} }
const namedGateConstraint = { id: 'gate', source_message_id: namedGateInput.current.message_id, quote: gateActionQuote,
  kind: 'approval_before', scope: 'steps', action: '计算预算剩余金额及支出比例', reviewer: { kind: 'operator' } }
const namedGateReply = { kind: 'task', relation: 'new', timing: 'immediate', quote: '创建并执行任务「T03-人工审批测试」',
  constraints: [namedGateConstraint] }

it('保留同一来源中单独命名的 T03 审批卡，并拒绝计划指向不同名字的审批', () => {
  const admitted = interpretSemanticAdmission(namedGateInput, namedGateReply)
  expect(admitted.kind).toBe('ready')
  if (admitted.kind !== 'ready') throw new Error('T03 was not admitted')
  const contract = admitted.request.requirements_contract
  const gate = contract.constraints[0]!
  expect(gate).toMatchObject({ kind: 'approval_before', gate_name: gateName, quote: gateActionQuote })
  expect(gate.quote).not.toContain(gateName)
  const proposal = { steps: [{ node_id: 'calculate', tools: [] }],
    deliverables: [{ acceptance: { kind: 'chat/text_result' } }],
    constraint_bindings: [{ constraint_id: gate.id, approval_node_id: 'gate', protected_node_ids: ['calculate'] }],
  }
  const workflow = (approvalPrompt: string) => [
    { id: 'gate', approvalPrompt, type: 'approval', dependsOn: [], declaredTools: [] },
    { id: 'calculate', type: 'agent', sideEffectPolicy: 'pure', dependsOn: ['gate'], declaredTools: [] },
  ]
  expect(requirementIssues(contract, proposal, workflow('人工确认预算'))).toEqual([expect.stringContaining(gateName)])
  expect(canStartAtRequiredGate(contract, proposal, workflow('人工确认预算'))).toBe(false)
  expect(requirementIssues(contract, proposal, workflow(gateName))).toEqual([])
  expect(canStartAtRequiredGate(contract, proposal, workflow(gateName))).toBe(true)
})

it('拒绝模型编造审批名称或用来源中另一段普通文字替代明确命名', () => {
  for (const forged of ['人工确认预算', 'T03-人工审批测试']) {
    const admission = interpretSemanticAdmission(namedGateInput, { ...namedGateReply,
      constraints: [{ ...namedGateConstraint, gate_name: forged }] })
    expect(admission).toMatchObject({ kind: 'clarify', invalidReply: true,
      validationIssue: expect.stringContaining('不匹配') })
    expect(admission).not.toHaveProperty('draft')
    expect(admission).not.toHaveProperty('request')
  }
  // The invalid model reply does not create a launchable draft; resubmitting the authenticated
  // original source lets the interpreter retain only the approval name actually present there.
  expect(interpretSemanticAdmission(namedGateInput, { ...namedGateReply,
    constraints: [{ ...namedGateConstraint, gate_name: gateName }] })).toMatchObject({ kind: 'ready' })
})

it.each([
  '预算 10000 元，实际支出 7600 元。',
  '| 项目 | 金额 |\n| --- | ---: |\n| 预算 | 10000 |\n| 支出 | 7600 |',
  '预算：\n10000 元\n实际支出：\n7600 元',
])('审批前规划保留真实步骤和名称，暂不提供计算数字（%s）', material => {
  const namedTask = 'T03-预算审核 2026'
  const namedGate = '批准预算 2026 复核'
  const action = '计算 10000 元扣除 7600 元后的剩余金额和支出比例'
  const quote = `只有批准后，才能${action}`
  const goal = `创建任务「${namedTask}」，设置审批步骤「${namedGate}」，安排 2 个执行步骤。\n${material}\n${quote}。`
  const step: TaskRequirement = { id: 'gate', kind: 'approval_before', scope: 'steps', action, gate_name: namedGate,
    reviewer: { kind: 'operator' }, source_message_id: 'm', quote }
  const payload = { goal, requirements: [{ id: 'R1', text: '使用 10000 与 7600 的原值，保留 2 个执行步骤' }],
    requirements_contract: { version: 1, start_policy: 'immediate', sources: [{ message_id: 'm', text: goal }],
      timing: { source_message_id: 'm', quote: goal }, constraints: [step] },
  }
  const original = structuredClone(payload)
  const projected = dshPlanningInput(payload).payload
  const serialized = JSON.stringify(projected)
  expect(serialized).not.toMatch(/10000|7600/u)
  expect(serialized).toContain(`任务「${namedTask}」`)
  expect(serialized).toContain(`审批步骤「${namedGate}」`)
  expect(serialized).toContain('安排 2 个执行步骤')
  expect(projected).toMatchObject({ requirements: [{ id: 'R1', text: expect.stringContaining('保留 2 个执行步骤') }],
    requirements_contract: { constraints: [{ kind: 'approval_before', scope: 'steps', gate_name: namedGate,
      action: expect.stringMatching(/^计算 .*剩余金额和支出比例$/u), reviewer: { kind: 'operator' } }] },
  })
  expect(payload).toEqual(original)
})

it('普通任务的规划保留原始数字和来源', () => {
  const goal = '核对已列明的两个项目：预算 10000 元、实际支出 7600 元，不联网。'
  const contract = requirementsContractSchema.parse({ version: 1, start_policy: 'immediate',
    sources: [{ message_id: 'm', text: goal }], constraints: [
      { id: 'net', kind: 'no_network', source_message_id: 'm', quote: '不联网' },
    ],
  })
  const payload = { goal, requirements_contract: contract, requirements: [{ id: 'R1', text: '结果中列两笔原值 10000 与 7600' }] }
  expect(dshPlanningInput(payload)).toMatchObject({ offline: true, payload })
  expect(dshPlanningInput(payload).payload).toBe(payload)
})

it.each(['不联网', '商品 B 单价缺失', '不要报告缺失单价', 'Do not report missing prices'])(
  '不给普通事实、访问限制或明确禁止报告的原句赋予部分结果授权（%s）', quote => {
    const current: SemanticInput = { explicit: true, current: { message_id: 'stock', text: `核对库存。${quote}。` } }
    const gap = { id: 'gap', kind: 'report_data_gap', quote, source_message_id: current.current.message_id }
    const contract = { version: 1, start_policy: 'immediate', sources: [current.current], constraints: [gap] }
    expect(requirementsContractSchema.safeParse(contract).success).toBe(false)
    expect(interpretSemanticAdmission(current, { kind: 'task', relation: 'new', timing: 'immediate',
      quote: '核对库存', constraints: [gap] })).toMatchObject({ kind: 'clarify' })
  })

it.each([['不要报告未完成项', '报告未完成项'], ['Do not report missing prices', 'report missing prices']])(
  '不允许删掉同一句的否定词来伪造部分结果授权（%s）', (denied, clipped) => {
    const current: SemanticInput = { explicit: true, current: { message_id: 'stock', text: `核对库存。${denied}。` } }
    const gap = { id: 'gap', kind: 'report_data_gap', quote: clipped, source_message_id: current.current.message_id }
    expect(requirementsContractSchema.safeParse({ version: 1, start_policy: 'immediate',
      sources: [current.current], constraints: [gap] }).success).toBe(false)
    expect(interpretSemanticAdmission(current, { kind: 'task', relation: 'new', timing: 'immediate',
      quote: '核对库存', constraints: [gap] })).toMatchObject({ kind: 'clarify' })
  })
