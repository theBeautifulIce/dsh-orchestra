import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createSemanticSession, interpretSemanticAdmission, semanticCorrectionHint, semanticResponseNeedsCorrection, SEMANTIC_INSTRUCTIONS,
  type SemanticInput, type SemanticOutcome } from '../../src/service/semantic-admission.ts'
import { createDshJsonCompletion } from '../../src/executor/dsh-json.ts'
import { createDshSemanticInterpreter } from '../../src/executor/dsh-task-requirements.ts'
import { fixedRosterIssue, requirementIssues } from '../../src/service/task-requirement-checks.ts'
import { createSemanticDraftCheckpoints } from '../../src/service/semantic-draft-checkpoints.ts'
import { requirementsContractSchema, storedRequirementsContractSchema, type RequirementsContract } from '../../src/core/task-requirements.ts'

function input(text: string, message_id = 'u1'): SemanticInput { return { current: { message_id, text }, explicit: false } }
function task(current: SemanticInput, changes: object = {}) {
  return { kind: 'task', relation: 'new', timing: 'immediate', quote: current.current.text, constraints: [], missing: [], ...changes }
}
function draftOf(result: SemanticOutcome) {
  if (!result.draft) throw Error('Expected pending draft')
  return result.draft
}

it('validates semantic source, restriction scope and explicit version before planning', () => {
  const current = input('请出一份周报，别改原件，用流程月报第 2 版')
  const raw = task(current, { constraints: [{ id: 'model-id', kind: 'preserve_input', source_message_id: 'u1', quote: '别改原件', target: '原件' }],
    workflow: { name: '月报', version: '2', quote: '流程月报第 2 版', source_message_id: 'u1' } })
  const out = interpretSemanticAdmission(current, raw)
  expect(out).toMatchObject({ kind: 'ready', request: { workflow: { name: '月报', version: '2' }, requirements_contract: {
    sources: [{ message_id: 'u1', text: current.current.text }], constraints: [{ id: 'c1', target: '原件' }], start_policy: 'immediate',
  } } })
  expect(interpretSemanticAdmission(current, { ...raw, workflow: { name: '月报', version: '3', quote: '流程月报第 2 版', source_message_id: 'u1' } })).toMatchObject({ kind: 'clarify' })
  expect(interpretSemanticAdmission(current, task(current, { constraints: [{ id: 'a', kind: 'read_only', source_message_id: 'notice', quote: '别改原件' }] }))).toMatchObject({ kind: 'clarify' })
  expect(interpretSemanticAdmission(current, task(current, { constraints: [{ id: 'a', kind: 'preserve_input', source_message_id: 'u1', quote: '别改原件', target: 'other.csv' }] }))).toMatchObject({ kind: 'clarify' })
})

it('T09 corrects a bad roster enum once, keeps the exact two-agent boundary, and does not turn unobserved facts into a data gap', async () => {
  const text = `执行 T09 两代理协作测试。安排两个同时运行的独立代理：A 计算 25×16，B 计算 48×12。A 向 B 发出一次请求；该请求仍 pending 时，B 向 A 发出一次反向请求。真实拒绝后不绕过、不重试，B 可回复原请求。未观察到指定条件应如实记录，不得当作数据缺口授权。不得额外启动代理。`
  const original: SemanticInput = { current: { message_id: 't09', text }, explicit: true }
  const systems: string[] = []
  const wireIds: string[] = []
  let calls = 0
  const llm = { async prepareCall(config: unknown) {
    return { config, async *stream({ messages, system }: { messages: Array<{ content: Array<{ text: string }> }>; system: string }) {
      calls++
      systems.push(system)
      const wire = JSON.parse(messages[0]!.content[0]!.text) as SemanticInput
      wireIds.push(wire.current.message_id)
      const response = calls === 1 ? task(wire, { constraints: [{ id: 'roster', kind: 'no_extra_agent',
        source_message_id: wire.current.message_id, quote: '不得额外启动代理' }] })
        : task(wire, { constraints: [{ id: 'roster', kind: 'no_extra_agents',
          source_message_id: wire.current.message_id, quote: '不得额外启动代理' }] })
      yield { type: 'block-end', block: { type: 'text', text: JSON.stringify(response) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  } } as unknown as NonNullable<Parameters<typeof createDshJsonCompletion>[0]>
  const interpret = createDshSemanticInterpreter(llm)!
  const raw = await interpret({ provider: 'fixture', model: 'selected' }, original, new AbortController().signal, () => {})
  const result = interpretSemanticAdmission(original, raw)
  expect(wireIds).toEqual(['m1', 'm1'])
  expect(calls).toBe(2)
  expect(systems[1]).toContain('constraints.0.kind')
  expect(result).toMatchObject({ kind: 'ready', request: { requirements_contract: {
    constraints: [{ kind: 'no_extra_agents', source_message_id: 't09', quote: '不得额外启动代理' }],
  } } })
  if (result.kind !== 'ready') throw new Error('Expected a corrected roster task')
  expect(result.request.requirements_contract.constraints.some(item => item.kind === 'report_data_gap')).toBe(false)

  const three = [{ id: 'a', type: 'agent', dependsOn: [] }, { id: 'b', type: 'agent', dependsOn: [] },
    { id: 'c', type: 'agent', dependsOn: [] }]
  expect(fixedRosterIssue(result.request.requirements_contract, three)).toContain('2 个代理')
  expect(fixedRosterIssue(result.request.requirements_contract, [{ id: 'a', type: 'agent', dependsOn: [] },
    { id: 'b', type: 'agent', dependsOn: ['a'] }])).toContain('并行执行')
  expect(fixedRosterIssue(result.request.requirements_contract, [{ id: 'a', type: 'agent', dependsOn: [] },
    { id: 'b', type: 'agent', dependsOn: [] }, { id: 'nested', type: 'subworkflow', dependsOn: [] }])).toContain('子流程')
  const twoIndependent = [{ id: 'a', type: 'agent', dependsOn: [] }, { id: 'b', type: 'agent', dependsOn: [] }]
  expect(fixedRosterIssue(result.request.requirements_contract, twoIndependent)).toBeUndefined()
  expect(requirementIssues(result.request.requirements_contract,
    { steps: [{ node_id: 'a', tools: [] }, { node_id: 'b', tools: [] }], deliverables: [
      { acceptance: { kind: 'chat/text_result' } }, { acceptance: { kind: 'chat/text_result' } },
    ] }, twoIndependent.map(node => ({ ...node, declaredTools: [] })))).toEqual([])

  const missingInput = input('请核对，但尚未提供必须使用的材料', 'missing-materials')
  const held = interpretSemanticAdmission(missingInput, { kind: 'clarify', missing: ['materials'] })
  expect(held).toMatchObject({ kind: 'clarify' })
  expect(held).not.toHaveProperty('request.requirements_contract')
})

it('combines roster facts across a held message and its continuation before accepting the workflow', () => {
  const first = input('安排两个同时运行的代理，各自核对一项计算。先别启动。', 'roster-first')
  const held = draftOf(interpretSemanticAdmission(first, task(first, { timing: 'held' })))
  const next = { ...input('现在开始，不额外启动代理。', 'roster-second'), draft: held }
  const outcome = interpretSemanticAdmission(next, task(next, { relation: 'continue', draft_revision: held.revision,
    continuation: 'resume', constraints: [{ id: 'roster', kind: 'no_extra_agents', source_message_id: 'roster-second',
      quote: '不额外启动代理' }] }))
  expect(outcome).toMatchObject({ kind: 'ready', request: { requirements_contract: {
    sources: [{ message_id: 'roster-first' }, { message_id: 'roster-second' }],
    constraints: [{ kind: 'no_extra_agents', source_message_id: 'roster-second' }],
  } } })
  if (outcome.kind !== 'ready') throw new Error('Expected the resumed roster request to be ready')
  const contract = outcome.request.requirements_contract
  expect(requirementsContractSchema.safeParse(contract).success).toBe(true)
  expect(fixedRosterIssue(contract, [{ id: 'a', type: 'agent', dependsOn: [] }, { id: 'b', type: 'agent', dependsOn: [] },
    { id: 'c', type: 'agent', dependsOn: [] }])).toContain('2 个代理')
  expect(fixedRosterIssue(contract, [{ id: 'a', type: 'agent', dependsOn: [] }, { id: 'b', type: 'agent', dependsOn: ['a'] }]))
    .toContain('并行执行')
  expect(fixedRosterIssue(contract, [{ id: 'a', type: 'agent', dependsOn: [] }, { id: 'b', type: 'agent', dependsOn: [] }])).toBeUndefined()

  // An assigned count is a minimum even when the user never says “no extra agents”.
  const minimumOnly: RequirementsContract = { version: 1, start_policy: 'immediate',
    sources: [{ message_id: 'minimum', text: '安排两个同时运行的代理，各自核对一项计算。' }], constraints: [] }
  expect(fixedRosterIssue(minimumOnly, [{ id: 'a', type: 'agent', dependsOn: [] }])).toContain('至少 2 个代理')
  expect(fixedRosterIssue(minimumOnly, [{ id: 'a', type: 'agent', dependsOn: [] }, { id: 'b', type: 'agent', dependsOn: ['a'] }]))
    .toContain('并行执行')
  expect(fixedRosterIssue(minimumOnly, [{ id: 'a', type: 'agent', dependsOn: [] }, { id: 'b', type: 'agent', dependsOn: [] },
    { id: 'summary', type: 'agent', dependsOn: ['a', 'b'] }])).toBeUndefined()
  expect(fixedRosterIssue(minimumOnly, [{ id: 'prepare', type: 'tool', dependsOn: [] },
    { id: 'a', type: 'agent', dependsOn: ['prepare'] }, { id: 'b', type: 'agent', dependsOn: ['prepare'] }])).toBeUndefined()
  expect(fixedRosterIssue(minimumOnly, [{ id: 'choose', type: 'branch', dependsOn: [] },
    { id: 'A', type: 'agent', dependsOn: ['choose'] }, { id: 'B', type: 'agent', dependsOn: ['choose'] }]))
    .toContain('至少 2 个代理')
  expect(fixedRosterIssue(minimumOnly, [{ id: 'A', type: 'agent', dependsOn: [] },
    { id: 'B', type: 'agent', dependsOn: [] }, { id: 'merge', type: 'agent', dependsOn: ['A', 'B'] }])).toBeUndefined()
  expect(fixedRosterIssue(minimumOnly, [{ id: 'A', type: 'agent', dependsOn: [] }, { id: 'B', type: 'agent', dependsOn: [] },
    { id: 'merge', type: 'tool', dependsOn: ['A', 'B'] }, { id: 'choose', type: 'branch', dependsOn: ['merge'] },
    { id: 'left', type: 'policy', dependsOn: ['choose'] }, { id: 'right', type: 'policy', dependsOn: ['choose'] }])).toBeUndefined()

  const conflicting = { ...input('现在开始，安排三个代理，不额外启动代理。', 'roster-conflict'), draft: held }
  expect(interpretSemanticAdmission(conflicting, task(conflicting, { relation: 'continue', draft_revision: held.revision,
    continuation: 'resume', constraints: [{ id: 'roster', kind: 'no_extra_agents', source_message_id: 'roster-conflict',
      quote: '不额外启动代理' }] }))).toMatchObject({ kind: 'clarify' })
})

it.each([
  ['中文协作未回复', '如果协作请求未完成，请如实说明有没有收到回复。', '如果协作请求未完成，请如实说明有没有收到回复。'],
  ['英文协作未回复', 'If an unavailable peer does not reply, report whether a reply was received.',
    'If an unavailable peer does not reply, report whether a reply was received.'],
  ['裁剪后的协作未回复', '商品 B 单价缺失。如果协作请求未完成，请如实说明有没有收到回复。',
    '协作请求未完成，请如实说明有没有收到回复'],
  ['审批未完成', '如果审批未完成，请如实说明审批状态。', '如果审批未完成，请如实说明审批状态。'],
] as const)('does not grant a data-gap permission for %s', (_name, text, quote) => {
  const source = input(text, 'collaboration-gap')
  const forged = task(source, { constraints: [{ id: 'gap', kind: 'report_data_gap', source_message_id: 'collaboration-gap', quote }] })
  const contract = { version: 1 as const, start_policy: 'immediate' as const,
    sources: [{ message_id: 'collaboration-gap', text }],
    constraints: [{ id: 'gap', kind: 'report_data_gap' as const, source_message_id: 'collaboration-gap', quote }] }
  expect(requirementsContractSchema.safeParse(contract).success).toBe(false)
  const outcome = interpretSemanticAdmission(source, forged)
  expect(outcome).toMatchObject({ kind: 'ready', request: { goal: text } })
  if (outcome.kind !== 'ready') throw new Error('A collaboration result should remain ordinary executable task text')
  expect(outcome.request.requirements_contract.constraints.some(item => item.kind === 'report_data_gap')).toBe(false)
})

it('keeps a genuine missing-material grant when an unrelated approval status is also reported', () => {
  const text = '如果审批未完成，请如实说明审批状态。商品 B 单价缺失。金额核算发现必要数据缺失时，应如实报告未完成金额和下一步。'
  const source = input(text, 'mixed-approval-and-material')
  const quote = '金额核算发现必要数据缺失时，应如实报告未完成金额和下一步'
  const outcome = interpretSemanticAdmission(source, task(source, { constraints: [{ id: 'gap', kind: 'report_data_gap',
    source_message_id: 'mixed-approval-and-material', quote }] }))
  expect(outcome).toMatchObject({ kind: 'ready', request: { requirements_contract: {
    constraints: [{ kind: 'report_data_gap', quote }],
  } } })
})

it.each([
  ['安排两个并行代理，不额外启动代理。不联网。', '不联网', true],
  ['A 不得重新派发代理，不联网。', '不联网', false],
  ['A 不得重新派发代理，不联网。', '不得重新派发代理，不联网', false],
  ['不联网，不额外启动代理。', '不联网，不额外启动代理', true],
] as const)('asks for correction when the proposed roster citation would absorb a network limit: %s', (text, quote, closed) => {
  const source = input(text)
  const mistaken = { id: 'roster', kind: 'no_extra_agents', source_message_id: 'u1', quote }
  expect(interpretSemanticAdmission(source, task(source, { constraints: [mistaken] }))).toMatchObject({ kind: 'clarify', invalidReply: true })
  const corrected = interpretSemanticAdmission(source, task(source, { constraints: [
    { id: 'net', kind: 'no_network', source_message_id: 'u1', quote: '不联网' },
  ] }))
  expect(corrected.kind).toBe('ready')
  if (corrected.kind !== 'ready') throw new Error('Expected the correctly cited policy to be admitted')
  expect(corrected.request.requirements_contract.constraints.map(item => item.kind)).toEqual(closed ? ['no_network', 'no_extra_agents'] : ['no_network'])
})

it('keeps historic plans with broader citations readable and requires a single roster clause on new admissions', () => {
  const text = '不联网，不额外启动代理。'
  const historical = { version: 1, start_policy: 'immediate', sources: [{ message_id: 'u', text }], constraints: [
    { id: 'roster', kind: 'no_extra_agents', source_message_id: 'u', quote: text },
  ] }
  expect(storedRequirementsContractSchema.safeParse(historical).success).toBe(true)
  expect(requirementsContractSchema.safeParse(historical).success).toBe(false)
})

it('T10 keeps collaboration receipts in the task text when the model mislabels them as a data gap, without a correction call', async () => {
  const text = `执行任务「T06-协作失联与去重测试」。

安排两个独立并行的只读代理：

代理 A 负责计算 12、24、36、48 的合计与平均值。

代理 B 负责计算 15、25、35、45 的合计与平均值。

在双方同时可用时，A 通过真实协作信箱向 B 发出一个参考性核对请求，期限设置为30秒。若对方仍然可用，立即使用完全相同的参数重发一次，检验重复请求是否去重。

B 本次故意不回应这项非必要协作请求，但正常完成自身计算并退出。

A 不得等待 B 的回应，不得循环查询或重新派发代理，继续完成自己的计算。

所有操作必须实际通过插件执行，不要模拟工具回执。结果和发生的协作异常返回本会话。不联网，不读写工作区文件。`
  const current: SemanticInput = { current: { message_id: 't10-new', text }, explicit: true }
  let calls = 0
  const llm = { async prepareCall(config: unknown) {
    return { config, async *stream({ messages }: { messages: Array<{ content: Array<{ text: string }> }> }) {
      calls++
      const wire = JSON.parse(messages[0]!.content[0]!.text) as SemanticInput
      expect(wire.current).toEqual({ message_id: 'm1', text: current.current.text })
      const proposal = task(wire, { constraints: [
        { id: 'network', kind: 'no_network', source_message_id: wire.current.message_id, quote: '不联网' },
        { id: 'workspace', kind: 'no_workspace_read', source_message_id: wire.current.message_id, quote: '不读写工作区文件' },
        { id: 'files', kind: 'no_workspace_files', source_message_id: wire.current.message_id, quote: '不读写工作区文件' },
        { id: 'readonly', kind: 'read_only', source_message_id: wire.current.message_id, quote: '只读代理' },
        { id: 'no-retry', kind: 'no_extra_agents', source_message_id: wire.current.message_id, quote: '不得循环查询或重新派发代理' },
        { id: 'gap', kind: 'report_data_gap', source_message_id: wire.current.message_id, quote: '结果和发生的协作异常返回本会话' },
      ] })
      yield { type: 'block-end', block: { type: 'text', text: JSON.stringify(proposal) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  } } as unknown as NonNullable<Parameters<typeof createDshJsonCompletion>[0]>
  const interpreter = createDshSemanticInterpreter(llm)!
  const interpret = (semantic: SemanticInput, signal: AbortSignal, assertCurrent: () => void) =>
    interpreter({ provider: 'fixture', model: 'gpt-6-luna', reasoningEffort: 'high' }, semantic, signal, assertCurrent)
  const session = createSemanticSession()
  const result = await session.admit({ identity: 'T10/fresh', requestId: 't10-new', hash: 't10-new', input: current,
    signal: new AbortController().signal, assertCurrent() {} }, interpret)

  expect(calls).toBe(1)
  expect(result).toMatchObject({ kind: 'ready', request: { goal: text, requirements_contract: { sources: [current.current],
    constraints: [
      { kind: 'no_network', source_message_id: 't10-new', quote: '不联网' },
      { kind: 'no_workspace_read', source_message_id: 't10-new', quote: '不读写工作区文件' },
      { kind: 'no_workspace_files', source_message_id: 't10-new', quote: '不读写工作区文件' },
      { kind: 'read_only', source_message_id: 't10-new', quote: '只读代理' },
    ],
  } } })
  if (result.kind !== 'ready') throw new Error('Expected the T10 task to remain ready')
  expect(result.request.requirements_contract.constraints.some(item => item.kind === 'report_data_gap')).toBe(false)
  expect(result.request.goal).toContain('结果和发生的协作异常返回本会话')
  expect(result.request.goal).toContain('所有操作必须实际通过插件执行')
  expect(result.request.goal).toContain('不得循环查询或重新派发代理')
})

it('keeps real roster limits and rejects unsupported or uncited scopes when handling a retry instruction', () => {
  const rule = 'Do not redispatch the agent'
  const global = 'No additional agents'
  const text = `Assign two parallel agents. ${rule}. ${global}.`
  const source = input(text, 'roles')
  const request = (source: SemanticInput, quote: string, id = 'roles') => task(source, { constraints: [
    { id: 'roster', kind: 'no_extra_agents', source_message_id: id, quote },
  ] })
  expect(interpretSemanticAdmission(source, request(source, rule))).toMatchObject({ kind: 'ready', request: {
    goal: text, requirements_contract: { constraints: [{ kind: 'no_extra_agents', quote: global }] },
  } })
  const scoped = input(`Assign two parallel agents. ${rule}.`, 'roles')
  expect(interpretSemanticAdmission(scoped, request(scoped, rule))).toMatchObject({ kind: 'ready', request: {
    goal: scoped.current.text, requirements_contract: { constraints: [] },
  } })
  expect(interpretSemanticAdmission(scoped, request(scoped, rule, 'unrelated'))).toMatchObject({ kind: 'clarify' })
  const unknown = input('请按原有人员安排核对。', 'roles')
  expect(semanticCorrectionHint(request(unknown, '按原有人员安排'), unknown)).toContain('整项任务禁止新增代理')
  expect(interpretSemanticAdmission(unknown, request(unknown, '按原有人员安排'))).toMatchObject({ kind: 'clarify' })
})

it('T10 retains a real held restriction on resume and rejects forged or negated gap reports', () => {
  const first = input('先不要执行 T10 协作测试。不联网，不读写工作区文件。')
  const held = draftOf(interpretSemanticAdmission(first, task(first, { timing: 'held', constraints: [
    { id: 'net', kind: 'no_network', source_message_id: 'u1', quote: '不联网' },
    { id: 'workspace', kind: 'no_workspace_files', source_message_id: 'u1', quote: '不读写工作区文件' },
  ] })))
  const continuationText = '现在继续。结果和发生的协作异常返回本会话。'
  const next = { ...input(continuationText, 'u2'), draft: held }
  const resumed = interpretSemanticAdmission(next, task(next, { relation: 'continue', draft_revision: held.revision,
    continuation: 'resume', constraints: [{ id: 'misread', kind: 'report_data_gap', source_message_id: 'u2',
      quote: '结果和发生的协作异常返回本会话' }] }))
  expect(resumed).toMatchObject({ kind: 'ready', request: { goal: first.current.text + '\n' + continuationText,
    requirements_contract: { constraints: [
      { kind: 'no_network', source_message_id: 'u1', quote: '不联网' },
      { kind: 'no_workspace_files', source_message_id: 'u1', quote: '不读写工作区文件' },
    ] },
  } })
  if (resumed.kind !== 'ready') throw new Error('Expected the continued T10 task to be ready')
  expect(resumed.request.requirements_contract.constraints.some(item => item.kind === 'report_data_gap')).toBe(false)

  const trueGap = input('若缺少材料，请报告缺失项，并完成其余能做的部分。', 'gap')
  const validGap = interpretSemanticAdmission(trueGap, task(trueGap, { constraints: [{ id: 'gap', kind: 'report_data_gap',
    source_message_id: 'gap', quote: '若缺少材料，请报告缺失项' }] }))
  expect(validGap).toMatchObject({ kind: 'ready', request: { requirements_contract: { constraints: [{ kind: 'report_data_gap' }] } } })

  const invalid = [
    { text: trueGap.current.text, source: 'other', quote: '若缺少材料，请报告缺失项' },
    { text: trueGap.current.text, source: 'gap', quote: '请报告全部虚构的缺失数据' },
    { text: '不要报告缺失材料，直接完成已有部分。', source: 'negated', quote: '报告缺失材料' },
  ]
  for (const [index, item] of invalid.entries()) {
    const source = input(item.text, item.source === 'negated' ? 'negated' : 'gap')
    const outcome = interpretSemanticAdmission(source, task(source, { constraints: [{ id: `bad-${index}`, kind: 'report_data_gap',
      source_message_id: item.source, quote: item.quote }] }))
    expect(outcome.kind, `invalid report_data_gap case ${index}`).toBe('clarify')
  }

  const ordinaryPermission = input('所有操作必须实际通过插件执行，不要模拟工具回执。', 'permission')
  const falseApproval = interpretSemanticAdmission(ordinaryPermission, task(ordinaryPermission, { constraints: [{ id: 'approval',
    kind: 'approval_before', scope: 'steps', action: '计算', reviewer: { kind: 'operator' }, source_message_id: 'permission',
    quote: '所有操作必须实际通过插件执行' }] }))
  expect(falseApproval).toMatchObject({ kind: 'clarify', invalidReply: true })
})

it('retains held timing, preserves previous constraints and pin, and allows a clear ordinary continuation without exposing draft IDs', () => {
  const first = input('先不要执行月报，别改原件，用流程月报第 2 版')
  const held = draftOf(interpretSemanticAdmission(first, task(first, { timing: 'held', constraints: [
    { id: 'a', kind: 'preserve_input', source_message_id: 'u1', quote: '别改原件', target: '原件' }],
    workflow: { name: '月报', version: '2', quote: '流程月报第 2 版', source_message_id: 'u1' } })))
  const next = { ...input('现在继续月报', 'u2'), draft: held }
  const result = interpretSemanticAdmission(next, task(next, { relation: 'continue', draft_revision: held.revision, continuation: 'resume' }))
  expect(result).toMatchObject({ kind: 'ready', request: { workflow: { version: '2' }, requirements_contract: { constraints: [
    { kind: 'preserve_input', source_message_id: 'u1', target: '原件' }], timing: { source_message_id: 'u2' } } } })
  expect(interpretSemanticAdmission(next, task(next, { relation: 'continue', draft_revision: held.revision + 1, continuation: 'resume' }))).toMatchObject({ kind: 'clarify' })
})

it('carries only the actual missing material answer forward, and cannot turn a supplement to a held task into a start', () => {
  const first = input('请整理月报')
  const initial = draftOf(interpretSemanticAdmission(first, task(first, { missing: ['materials'] })))
  const next = { ...input('使用账本.csv', 'u2'), draft: initial }
  const raw = task(next, { relation: 'continue', draft_revision: initial.revision, continuation: 'supply', answer: { slot: 'materials', value: '账本.csv', quote: '使用账本.csv' } })
  expect(interpretSemanticAdmission(next, raw)).toMatchObject({ kind: 'ready', request: { goal: '请整理月报\n使用账本.csv',
    requirements_contract: { timing: { source_message_id: 'u1' } } } })
  expect(interpretSemanticAdmission({ ...next, draft: { ...initial, timing: 'held' } }, raw)).toMatchObject({ kind: 'held' })
  expect(interpretSemanticAdmission(next, { ...raw, answer: { slot: 'result', value: '账本.csv', quote: '使用账本.csv' } })).toMatchObject({ kind: 'clarify' })
})

it.each(['known', 'unresolved', 'forged'] as const)('T02 corrects a false boundary, keeps unanswered result held, and preserves %s restrictions on resume', async scope => {
  const session = createSemanticSession()
  const first = '我需要完成任务「T02-项目进度分析」，先不要执行，等我补充数据和要求'
  const material = '开发任务共 20 项，已完成 12 项，进行中 5 项，未开始 3 项'
  const second = `补充数据：${material}。不联网，不读写工作区文件。仍然先不要执行。${scope === 'unresolved' ? '禁止任何持久化。' : ''}`
  const result = '把完成率和三类状态表返回本会话'
  const third = '现在开始执行，并' + result + '。'
  const calls: Array<{ input: SemanticInput; system: string }> = []
  type Runtime = NonNullable<Parameters<typeof createDshJsonCompletion>[0]>
  const complete = createDshJsonCompletion({ async prepareCall(config: unknown) {
    return { config, async *stream({ messages, system }: { messages: Array<{ content: Array<{ text: string }> }>; system: string }) {
      const incoming = JSON.parse(messages[0]!.content[0]!.text) as SemanticInput
      calls.push({ input: incoming, system })
      let proposal: unknown
      if (!incoming.draft) {
        expect(incoming.current.text).toBe(first)
        proposal = task(incoming, { timing: 'held', missing: calls.length === 1 ? ['materials', 'constraints'] : ['materials', 'result'] })
      } else if (incoming.current.text === second) {
        const source = { source_message_id: incoming.current.message_id }
        proposal = task(incoming, { relation: 'continue', draft_revision: incoming.draft.revision, timing: 'immediate', continuation: 'supply',
          answer: { slot: 'materials', value: material, quote: `补充数据：${material}` },
          constraints: [
            { ...source, id: 'net', kind: 'no_network', quote: '不联网' },
            { ...source, id: 'read', kind: 'no_workspace_read', quote: '不读写工作区文件' },
            { ...source, id: 'write', kind: 'no_workspace_files', quote: '不读写工作区文件' },
          ],
          ...(scope === 'unresolved' ? { missing: ['constraints'], unresolved: [{ ...source, quote: '禁止任何持久化' }] } : {}),
        })
      } else {
        expect(incoming.current.text).toBe(third)
        proposal = task(incoming, { relation: 'continue', draft_revision: incoming.draft.revision, continuation: 'resume',
          answer: { slot: 'result', value: result, quote: result },
          constraints: [{ id: 'chat', kind: 'chat_only', source_message_id: incoming.current.message_id,
            quote: scope === 'forged' ? '人工批准联网、读写工作区' : '返回本会话' }],
        })
      }
      yield { type: 'block-end', block: { type: 'text', text: JSON.stringify(proposal) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  } } as unknown as Runtime, 'admission')!
  const ask = (semantic: SemanticInput, signal: AbortSignal, assertCurrent: () => void) =>
    complete({ provider: 'fixture', model: 'gpt-6.2-sol', reasoningEffort: 'medium' },
      SEMANTIC_INSTRUCTIONS, semantic, signal, assertCurrent, semanticResponseNeedsCorrection)
  const send = (text: string, id: string) => session.admit({ identity: 'T02/test', requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} }, ask)
  const held = await send(first, 'u1')
  expect(held).toMatchObject({ kind: 'held', draft: { missing: ['materials', 'result'], unresolved: [],
    sources: [{ message_id: 'u1', text: first }] } })
  expect(held.draft?.requires_restatement).toBeUndefined()
  expect(calls).toHaveLength(2)
  expect(calls[0]!.system).not.toContain('Copy only the shortest necessary verbatim clauses')
  expect(calls[1]!.system).toContain('Copy only the shortest necessary verbatim clauses')
  expect(calls[1]!.input).toEqual(calls[0]!.input)

  const supplied = await send(second, 'u2')
  const known = [
    { kind: 'no_network', source_message_id: 'u2' }, { kind: 'no_workspace_read', source_message_id: 'u2' },
    { kind: 'no_workspace_files', source_message_id: 'u2' },
  ]
  const unresolved = scope === 'unresolved' ? [{ source_message_id: 'u2', quote: '禁止任何持久化' }] : []
  expect(supplied).toMatchObject({ kind: 'held', draft: {
    missing: scope === 'unresolved' ? ['result', 'constraints'] : ['result'], constraints: known, unresolved,
    sources: [{ message_id: 'u1', text: first }, { message_id: 'u2', text: second }],
  } })
  expect(supplied.draft?.requires_restatement).toBeUndefined()

  const resumed = await send(third, 'u3')
  const sources = [{ message_id: 'u1', text: first }, { message_id: 'u2', text: second }, { message_id: 'u3', text: third }]
  if (scope === 'known') {
    expect(resumed).toMatchObject({ kind: 'ready', request: { goal: [first, second, third].join('\n'),
      requirements_contract: { start_policy: 'immediate', sources, constraints: [...known, { kind: 'chat_only', source_message_id: 'u3' }] },
    } })
  } else if (scope === 'unresolved') {
    expect(resumed).toMatchObject({ kind: 'clarify', message: expect.stringContaining('禁止任何持久化'),
      draft: { missing: ['constraints'], unresolved, sources } })
  } else {
    expect(resumed).toMatchObject({ kind: 'clarify', draft: { requires_restatement: true, sources, constraints: known } })
  }
  expect(calls).toHaveLength(4)
  expect(calls[3]!.input.draft?.missing).toEqual(scope === 'unresolved' ? ['result', 'constraints'] : ['result'])
})

it('treats unrelated self-contained work separately while a previous task remains held', () => {
  const a = input('先不要执行月报')
  const old = draftOf(interpretSemanticAdmission(a, task(a, { timing: 'held' })))
  const b = { ...input('请编写旅行预算', 'u2'), draft: old }
  expect(interpretSemanticAdmission(b, task(b, { independent: { action_quote: '编写', subject_quote: '旅行预算' } }))).toMatchObject({
    kind: 'ready', request: { goal: '请编写旅行预算' }, draft: { id: old.id },
  })
  expect(interpretSemanticAdmission(b, task(b))).toMatchObject({ kind: 'clarify', message: expect.stringContaining('另开') })
})

it('requires the existing narrow user request to expose private notes and distinguishes plan-only from held', () => {
  const read = input('你好')
  expect(interpretSemanticAdmission(read, { kind: 'brain_notes', quote: '你好' })).toMatchObject({ kind: 'conversation' })
  const plan = input('先出计划，等我确认后再执行')
  expect(interpretSemanticAdmission(plan, task(plan, { timing: 'plan_only' }))).toMatchObject({ kind: 'ready', request: { requirements_contract: { start_policy: 'plan_only' } } })
  expect(interpretSemanticAdmission(plan, task(plan, { timing: 'held' }))).toMatchObject({ kind: 'held' })
})

it('isolates workspace drafts, ignores bare acknowledgment and discards stale asynchronous results', async () => {
  const session = createSemanticSession()
  const ask = vi.fn(async (i: SemanticInput) => task(i, { timing: 'held' }))
  let current = true
  const request = (text: string, id: string, identity = 'workspace/session') => ({ identity, requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() { if (!current) throw Error('stale') } })
  await session.admit(request('先别执行月报', 'a'), ask)
  expect(await session.admit(request('收到', 'b'), ask)).toMatchObject({ kind: 'conversation' })
  expect(ask).toHaveBeenCalledTimes(1)
  await session.admit(request('出个周报', 'c', 'other/session'), ask)
  expect(ask.mock.calls.at(-1)?.[0].draft).toBeUndefined()
  const delayed = Promise.withResolvers<unknown>()
  const pending = session.admit(request('出日报', 'd'), async () => delayed.promise)
  current = false
  delayed.resolve(task(input('出日报', 'd')))
  await expect(pending).rejects.toThrow('stale')
})

it('keeps held A and its restrictions when unrelated B also needs a pending draft', () => {
  const first = input('暂缓月报，保留 ledger.csv')
  const a = draftOf(interpretSemanticAdmission(first, task(first, { timing: 'held', constraints: [
    { id: 'a', kind: 'preserve_input', source_message_id: 'u1', quote: '保留 ledger.csv', target: 'ledger.csv' }],
    workflow: { name: '月报', quote: '暂缓月报', source_message_id: 'u1' } })))
  const second = { ...input('先别编写旅行预算', 'u2'), draft: a }
  const result = interpretSemanticAdmission(second, task(second, { timing: 'held', independent: { action_quote: '编写', subject_quote: '旅行预算' } }))
  expect(result).toMatchObject({ kind: 'clarify', draft: { id: a.id, constraints: [{ target: 'ledger.csv' }], workflow: { name: '月报' } } })
  const third = { ...input('现在继续月报', 'u3'), draft: result.draft! }
  expect(interpretSemanticAdmission(third, task(third, { relation: 'continue', draft_revision: a.revision, continuation: 'resume' }))).toMatchObject({
    kind: 'ready', request: { workflow: { name: '月报' }, requirements_contract: { constraints: [{ target: 'ledger.csv' }] } },
  })
})

it('does not silently drop an unresolved original boundary on a later model response', () => {
  const first = input('整理报告，禁止任何持久化')
  const a = draftOf(interpretSemanticAdmission(first, task(first, { missing: ['constraints'], unresolved: [
    { source_message_id: 'u1', quote: '禁止任何持久化' } ] })))
  const second = { ...input('继续', 'u2'), draft: a }
  const result = interpretSemanticAdmission(second, task(second, { relation: 'continue', draft_revision: a.revision, continuation: 'resume' }))
  expect(result).toMatchObject({ kind: 'clarify', draft: { missing: ['constraints'], unresolved: [{ quote: '禁止任何持久化' }] } })
})

it('does not replay a ready start after a failed plan and a newer held restriction', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'orchestra-semantic-replay-'))
  const checkpoints = createSemanticDraftCheckpoints(profile, async identity => 'signed-test-key:' + identity)
  const session = createSemanticSession(checkpoints)
  const origin = { messageKey: 'a'.repeat(64), requestKey: 'b'.repeat(64), inputHash: 'c'.repeat(64) }
  const makeRequest = (text: string, id: string, launch = false) => ({
    identity: 'workspace/session', requestId: id, hash: id,
    input: { current: { message_id: id, text }, explicit: true },
    ...(launch ? { launchOrigin: origin } : {}), signal: new AbortController().signal, assertCurrent() {},
  })
  const original = '整理月报，不得联网，先别执行'
  try {
    const first = makeRequest(original, 'held')
    await session.admit(first, async input => task(input, { timing: 'held', constraints: [
      { id: 'net', kind: 'no_network', source_message_id: input.current.message_id, quote: '不得联网' },
    ] }))

    const resumeText = '现在继续月报'
    const resume = makeRequest(resumeText, 'resume', true)
    const started = await session.admit(resume, async input => task(input, { relation: 'continue', timing: 'immediate',
      draft_revision: input.draft!.revision, continuation: 'resume', constraints: input.draft!.constraints }))
    expect(started).toMatchObject({ kind: 'ready', request: { requirements_contract: { start_policy: 'immediate' } } })
    const createdPlans: unknown[] = []
    await expect((async () => {
      createdPlans.push(started.kind === 'ready' ? started.request : undefined)
      throw new Error('synthetic planner failure before plan creation')
    })()).rejects.toThrow('synthetic planner failure')
    expect(createdPlans).toHaveLength(1)
    // This is the same unstarted request retention hook used after planner failure.
    session.retainUnstarted('resume', 'resume')

    const addedText = '增加只读限制，还是先等我确认'
    const added = await session.admit(makeRequest(addedText, 'restriction'), async input => task(input, {
      relation: 'continue', timing: 'held', draft_revision: input.draft!.revision, continuation: 'supply',
      constraints: [...input.draft!.constraints, { id: 'read', kind: 'read_only',
        source_message_id: input.current.message_id, quote: '只读限制' }],
    }))
    expect(added).toMatchObject({ kind: 'held', draft: { timing: 'held', sources: [
      { message_id: 'held', text: original }, { message_id: 'resume', text: resumeText },
      { message_id: 'restriction', text: addedText },
    ], constraints: [{ kind: 'no_network' }, { kind: 'read_only' }] } })

    const replay = await session.admit(resume, async () => {
      throw new Error('same original resume was reinterpreted as a new start')
    })
    expect(replay.kind).not.toBe('ready')
    expect(replay).toMatchObject({ kind: 'held', draft: { timing: 'held',
      sources: [{ message_id: 'held', text: original }, { message_id: 'resume', text: resumeText },
        { message_id: 'restriction', text: addedText }],
      constraints: [{ kind: 'no_network' }, { kind: 'read_only' }] } })
  } finally {
    session.reset()
    await rm(profile, { recursive: true, force: true })
  }
})


it('keeps an unresolved persistence boundary when a model relabels the same old quote after only 继续', () => {
  const first = input('整理报告，禁止任何持久化')
  const original = draftOf(interpretSemanticAdmission(first, task(first, { missing: ['constraints'], unresolved: [
    { source_message_id: 'u1', quote: '禁止任何持久化' } ] })))
  const next = { ...input('继续', 'u2'), draft: original }
  const reinterpreted = task(next, { relation: 'continue', draft_revision: original.revision,
    continuation: 'resume', constraints: [{ id: 'relabel', kind: 'no_workspace_files',
      source_message_id: 'u1', quote: '禁止任何持久化' }], missing: [], unresolved: [] })
  const result = interpretSemanticAdmission(next, reinterpreted)
  expect(result).toMatchObject({ kind: 'clarify', message: expect.stringContaining('先说明放弃该草稿'),
    draft: { unresolved: [{ source_message_id: 'u1', quote: '禁止任何持久化' }], missing: ['constraints'] } })
})

it('retains the current restriction on a generic clarification of a held draft across three human turns', () => {
  const first = input('生成月报，先别执行')
  const a = draftOf(interpretSemanticAdmission(first, task(first, { timing: 'held' })))
  const second = { ...input('不准任何持久化', 'u2'), draft: a }
  const b = draftOf(interpretSemanticAdmission(second, { kind: 'clarify', missing: ['constraints'] }))
  expect(b.sources.map(source => source.message_id)).toEqual(['u1', 'u2'])
  expect(b.revision).toBe(a.revision + 1)
  expect(b.timing).toBe('held')
  const third = { ...input('继续', 'u3'), draft: b }
  expect(interpretSemanticAdmission(third, task(third, { relation: 'continue', draft_revision: b.revision,
    continuation: 'resume', constraints: [] }))).toMatchObject({ kind: 'clarify', draft: {
      sources: [{ message_id: 'u1' }, { message_id: 'u2' }, { message_id: 'u3' }],
      unresolved: [{ source_message_id: 'u2', quote: '不准任何持久化' }],
    } })
})

it.each([
  { kind: 'unsupported-response' },
  { kind: 'task', relation: 'continue', timing: 'immediate', quote: '模型编造的引用', draft_revision: 1,
    continuation: 'resume', constraints: [] },
])('keeps an invalid interpretation from consuming and losing a new human restriction', raw => {
  const first = input('生成月报，先别执行')
  const a = draftOf(interpretSemanticAdmission(first, task(first, { timing: 'held' })))
  const second = { ...input('不准任何持久化', 'u2'), draft: a }
  const b = draftOf(interpretSemanticAdmission(second, raw))
  expect(b.sources.at(-1)).toEqual(second.current)
  expect(b.requires_restatement).toBe(true)
  const third = { ...input('继续', 'u3'), draft: b }
  expect(interpretSemanticAdmission(third, task(third, { relation: 'continue', draft_revision: b.revision,
    continuation: 'resume', constraints: [] }))).toMatchObject({ kind: 'clarify' })
})

it('preserves a new human restriction when its model call fails while an earlier task is held', async () => {
  const session = createSemanticSession()
  const request = (text: string, id: string) => ({ identity: 'one', requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} })
  await session.admit(request('生成月报，先别执行', 'u1'), async i => task(i, { timing: 'held' }))
  await expect(session.admit(request('不准任何持久化', 'u2'), async () => { throw Error('provider offline') })).rejects.toThrow('provider offline')
  const next = await session.admit(request('继续', 'u3'), async i => task(i, { relation: 'continue', draft_revision: i.draft!.revision,
    continuation: 'resume', constraints: [] }))
  expect(next).toMatchObject({ kind: 'clarify', draft: { requires_restatement: true,
    unresolved: expect.arrayContaining([{ source_message_id: 'u2', quote: '不准任何持久化' }]) } })
})

it('ignores a late provider failure after the session has moved to another workspace draft', async () => {
  const session = createSemanticSession()
  const request = (text: string, id: string, identity: string) => ({ identity, requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} })
  await session.admit(request('暂缓月报', 'a1', 'workspace-a'), async i => task(i, { timing: 'held' }))
  const provider = Promise.withResolvers<unknown>()
  const late = session.admit(request('不准持久化', 'a2', 'workspace-a'), async () => provider.promise).catch(error => error)
  await session.admit(request('暂缓旅行预算', 'b1', 'workspace-b'), async i => task(i, { timing: 'held' }))
  provider.reject(Error('late failure'))
  await late
  const resumed = await session.admit(request('继续旅行预算', 'b2', 'workspace-b'), async i => {
    expect(i.draft?.sources.map(source => source.message_id)).toEqual(['b1'])
    expect(i.draft?.requires_restatement).toBeUndefined()
    return task(i, { relation: 'continue', draft_revision: i.draft!.revision, continuation: 'resume' })
  })
  expect(resumed.kind).toBe('ready')
})

it.each([false, true])('keeps a complete unstarted request so a short supplement preserves its goal, timing and restrictions (answer=%s)', async hasAnswer => {
  const session = createSemanticSession()
  const request = (text: string, id: string) => ({ identity: 'workspace/session', requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} })
  const original = '请查找今天 AIHOT 和 B站的 AI 热点，15条内，输出到聊天里'
  expect(await session.admit(request(original, 'u1'), async i => task(i, { constraints: [
    { id: 'c', kind: 'chat_only', source_message_id: 'u1', quote: '输出到聊天里' },
  ] }))).toMatchObject({ kind: 'ready' })
  session.retainUnstarted('u1', 'u1')
  const supplement = '合计，重复信息合并，时间最近24小时'
  const out = await session.admit(request(supplement, 'u2'), async i => {
    expect(i.draft?.sources).toEqual([{ message_id: 'u1', text: original }])
    return task(i, { relation: 'continue', draft_revision: i.draft!.revision, continuation: 'supply',
      ...(hasAnswer ? { answer: { slot: 'result', quote: supplement, value: '重复信息合并' } } : {}) })
  })
  expect(out).toMatchObject({ kind: 'ready', request: { goal: original + '\n' + supplement,
    requirements_contract: { start_policy: 'immediate', timing: { source_message_id: 'u1' },
      constraints: [{ kind: 'chat_only', source_message_id: 'u1' }] } } })
})

it('retains plan-only timing on added details and requires a new explicit resume to execute', async () => {
  const first = input('先给我整理方案，暂不执行')
  const held = draftOf(interpretSemanticAdmission(first, task(first, { timing: 'held' })))
  const next = { ...input('输出五条建议', 'u2'), draft: held }
  const raw = task(next, { relation: 'continue', draft_revision: held.revision, continuation: 'supply' })
  expect(interpretSemanticAdmission(next, raw)).toMatchObject({ kind: 'held' })
  const plan = { ...held, timing: 'plan_only' as const }
  expect(interpretSemanticAdmission({ ...next, draft: plan }, raw)).toMatchObject({ kind: 'ready',
    request: { requirements_contract: { start_policy: 'plan_only', timing: { source_message_id: 'u1' } } } })
})

it('cannot restore an older failed request over a newer draft or another workspace', async () => {
  const session = createSemanticSession()
  const request = (text: string, id: string, identity = 'one') => ({ identity, requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} })
  await session.admit(request('整理月报', 'u1'), async i => task(i))
  session.retainUnstarted('u1', 'wrong-hash')
  await session.admit(request('先别执行旅行计划', 'u2'), async i => {
    expect(i.draft).toBeUndefined()
    return task(i, { timing: 'held' })
  })
  session.retainUnstarted('u1', 'u1')
  await session.admit(request('继续旅行计划', 'u3'), async i => {
    expect(i.draft?.sources.map(source => source.message_id)).toEqual(['u2'])
    return task(i, { relation: 'continue', draft_revision: i.draft!.revision, continuation: 'resume' })
  })
  await session.admit(request('你好', 'u4', 'two'), async () => ({ kind: 'conversation' }))
  session.retainUnstarted('u3', 'u3')
  await session.admit(request('整理日报', 'u5', 'two'), async i => {
    expect(i.draft).toBeUndefined()
    return task(i)
  })
})

it('does not retain a successfully admitted request unless the caller reports it unstarted', async () => {
  const session = createSemanticSession()
  const request = (text: string, id: string) => ({ identity: 'one', requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} })
  await session.admit(request('生成周报', 'u1'), async i => task(i))
  await session.admit(request('生成日报', 'u2'), async i => {
    expect(i.draft).toBeUndefined()
    return task(i)
  })
})

it('held drafts expire after thirty minutes and explicit session clearing removes the old source', async () => {
  vi.useFakeTimers()
  const session = createSemanticSession()
  const request = (text: string, id: string) => ({ identity: 'workspace/session', requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} })
  try {
    await session.admit(request('先别执行月报，禁止联网', 'u1'), async i => task(i, { timing: 'held' }))
    const beforeExpiry = await session.admit(request('继续月报', 'u2'), async i => {
      expect(i.draft?.sources).toEqual([{ message_id: 'u1', text: '先别执行月报，禁止联网' }])
      return task(i, { relation: 'continue', draft_revision: i.draft!.revision, continuation: 'resume' })
    })
    expect(beforeExpiry.kind).toBe('ready')

    await session.admit(request('先别执行周报，禁止联网', 'u3'), async i => task(i, { timing: 'held' }))
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1)
    await session.admit(request('继续周报', 'u4'), async i => {
      expect(i.draft).toBeUndefined()
      return task(i, { relation: 'continue', draft_revision: 1, continuation: 'resume' })
    })

    await session.admit(request('先别执行日报，禁止联网', 'u5'), async i => task(i, { timing: 'held' }))
    session.clear()
    await session.admit(request('继续日报', 'u6'), async i => {
      expect(i.draft).toBeUndefined()
      return task(i, { relation: 'continue', draft_revision: 1, continuation: 'resume' })
    })
  } finally { vi.useRealTimers() }
})

it.each(['held', 'plan_only', 'unclear'] as const)('an explicit %s supplement overrides an unstarted immediate request', async timing => {
  const session = createSemanticSession()
  const request = (text: string, id: string) => ({ identity: 'one', requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} })
  await session.admit(request('查找今天 AI 热点，直接执行', 'u1'), async current => task(current))
  session.retainUnstarted('u1', 'u1')
  const outcome = await session.admit(request('先不要执行，只补充来源为AIHOT', 'u2'), async current => task(current, {
    relation: 'continue', draft_revision: current.draft!.revision, continuation: 'supply', timing,
  }))
  if (timing === 'plan_only') {
    expect(outcome).toMatchObject({ kind: 'ready', request: { requirements_contract: {
      start_policy: 'plan_only', timing: { source_message_id: 'u2' },
    } } })
  } else expect(outcome).toMatchObject({ kind: timing === 'held' ? 'held' : 'clarify',
    draft: { timing, timing_source: { source_message_id: 'u2' } } })
})
