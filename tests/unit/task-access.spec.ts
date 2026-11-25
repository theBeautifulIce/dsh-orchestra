import { expect, it } from 'vitest'
import { taskAccessCases, accessContract } from '../fixtures/task-access-cases.ts'
import { interpretSemanticAdmission, type SemanticInput } from '../../src/service/semantic-admission.ts'
import { requirementsContractSchema, mergeRequirementsContracts, type TaskRequirement } from '../../src/core/task-requirements.ts'
import { nativeToolConstraint } from '../../src/executor/dsh-execution-capabilities.ts'

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
