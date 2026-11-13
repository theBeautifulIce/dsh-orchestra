import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry, type ToolDescriptor } from '../src/executor/tools.ts'
import {
  TASK_SESSION_STORAGE_DENY, TASK_SESSION_TOOL_POLICY, PAYLOAD_LIMIT_BYTES,
  buildInstruction, buildOutputTriplet, checkToolPolicy, createExecutorAgent, resolveToolSet,
  type HostAgentFactory,
} from '../src/executor/session.ts'

const ro = (name: string): ToolDescriptor => ({ name, capability: 'read_only', command: { bin: name, args: [] } })
const mut = (name: string): ToolDescriptor => ({
  name, capability: 'mutating', command: { bin: name, args: [] },
  compensation: { tool: 'undo', args: [], verify: { command: 'check', args: [] } },
})
const comp = (name: string): ToolDescriptor => ({ name, capability: 'compensating', command: { bin: name, args: [] } })

function registry(...tools: ToolDescriptor[]) {
  const reg = new ToolRegistry()
  tools.forEach((t) => reg.register(t))
  return reg
}

describe('agent 节点执行器', () => {
  it('resolveToolSet：allow 减 deny；未注册拒；allow 缺省为空', () => {
    const reg = registry(ro('a'), ro('b'))
    expect(resolveToolSet(reg, { allow: ['a', 'b'], deny: ['b'] }).map((t) => t.name)).toEqual(['a'])
    expect(() => resolveToolSet(reg, { allow: ['zzz'] })).toThrowError(/工具没注册/)
    expect(resolveToolSet(reg, {})).toEqual([])
  })

  it('checkToolPolicy：mutating 声明 pure 拒；compensating 拒；未声明按推导', () => {
    const reg = registry(ro('a'), mut('m'), comp('c'))
    expect(() => checkToolPolicy(reg, { allow: ['m'], declaredPolicy: 'pure' })).toThrowError(/声明 pure 但推导不是 pure/)
    expect(() => checkToolPolicy(reg, { allow: ['c'] })).toThrowError(/补偿工具不能出现在前向路径里/)
    expect(checkToolPolicy(reg, { allow: ['a'] })).toBe('pure')
    expect(checkToolPolicy(reg, { allow: ['m'] })).toBe('compensable')
    expect(checkToolPolicy(reg, { allow: ['a'], declaredPolicy: 'irreversible' })).toBe('irreversible')
  })

  it('buildOutputTriplet：超 64KiB 截断并记 droppedFields，字节数不超限', () => {
    const big = { small: 'x', huge: 'y'.repeat(70000) }
    const out = buildOutputTriplet({ payload: big, summary: 's', artifactRef: { kind: 'none' } })
    expect(out.payloadTruncated).toBe(true)
    expect(out.droppedFields).toContain('huge')
    expect(out.payloadBytes).toBeLessThanOrEqual(PAYLOAD_LIMIT_BYTES)
    expect(out.payload).toEqual({ small: 'x' })
  })

  it('未超限不截断、droppedFields 为空', () => {
    const out = buildOutputTriplet({ payload: { a: 1 }, summary: 'ok', artifactRef: { kind: 'none' } })
    expect(out.payloadTruncated).toBe(false)
    expect(out.droppedFields).toEqual([])
    expect(out.payloadBytes).toBe(Buffer.byteLength(JSON.stringify({ a: 1 }), 'utf8'))
  })

  it('摘要 900 字截到 800', () => {
    const out = buildOutputTriplet({ payload: null, summary: 'z'.repeat(900), artifactRef: { kind: 'none' } })
    expect(out.summary.length).toBe(800)
  })

  it('buildInstruction 里含「不要自己宣告节点完成」', () => {
    expect(buildInstruction({ nodeId: 'n1', outputSchema: {} })).toContain('不要自己宣告节点完成')
  })

  it('任务会话默认策略：allow 空、storages 读写都 deny', () => {
    expect(TASK_SESSION_TOOL_POLICY.allow).toEqual([])
    expect(TASK_SESSION_STORAGE_DENY).toContain('storages:read')
    expect(TASK_SESSION_STORAGE_DENY).toContain('storages:write')
  })

  it('createExecutorAgent 传给宿主 inheritHistory=false 且工具按裁剪后清单', async () => {
    const reg = registry(ro('a'), ro('b'))
    const create = vi.fn(async () => ({ agentId: 'ag_1', sessionId: 'ses_1' }))
    const host: HostAgentFactory = { create: create as any }
    const agent = await createExecutorAgent(host, reg, {
      nodeRunId: 'nr1', attempt: 1, input: { x: 1 }, outputSchema: {}, toolPolicy: { allow: ['a', 'b'], deny: ['b'] },
    })
    expect(agent.tools.map((t) => t.name)).toEqual(['a'])
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ inheritHistory: false, toolPolicy: { allow: ['a'], deny: ['b'] } }))
  })
})
