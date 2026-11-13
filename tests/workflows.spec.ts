import { describe, expect, it } from 'vitest'
import { WorkflowCatalog } from '../src/service/workflows.ts'
import type { WorkflowDefinition } from '../src/core/workflow-def.ts'

const def: WorkflowDefinition = {
  workflow_version: '1',
  pass_conditions: [{ path: 'evidence.exitCode', op: 'eq' as const, value: 0 }],
  nodes: [{ node_id: 'check', type: 'agent' as const, tools: { allow: ['ro.echo'], deny: ['ro.rm'] } }],
}

describe('工作流版本不可变（第五轮审计 P1-1）', () => {
  it('同版本同内容重复加载照常返回摘要', () => {
    const catalog = new WorkflowCatalog('S2')
    catalog.load(def)
    const again = catalog.load(JSON.parse(JSON.stringify(def)))
    expect(again.workflow_version).toBe('1')
    expect(again.nodes[0]!.node_id).toBe('check')
  })

  it('同版本改判定条件即拒：不许改写已建 run 的判定', () => {
    const catalog = new WorkflowCatalog('S2')
    catalog.load(def)
    expect(() => catalog.load({ ...def, pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 99 }] }))
      .toThrowError(/同一工作流版本不许改写定义/)
    expect(catalog.policyFor('1', 'check').passConditions).toEqual(def.pass_conditions)
  })

  it('同版本改节点工具授权即拒', () => {
    const catalog = new WorkflowCatalog('S2')
    catalog.load(def)
    expect(() => catalog.load({ ...def, nodes: [{ ...def.nodes[0]!, tools: { allow: ['ro.echo', 'ro.rm'], deny: [] } }] }))
      .toThrowError(/同一工作流版本不许改写定义/)
    expect(catalog.toolPolicyFor('1', 'check')).toEqual({ allow: ['ro.echo'], deny: ['ro.rm'] })
  })

  it('工具授权只从节点定义取，返回的是副本', () => {
    const catalog = new WorkflowCatalog('S2')
    catalog.load(def)
    const policy = catalog.toolPolicyFor('1', 'check')
    policy.allow.push('ro.rm')
    expect(catalog.toolPolicyFor('1', 'check').allow).toEqual(['ro.echo'])
  })

  it('节点不在版本里 → SCHEMA_VERSION_UNSUPPORTED', () => {
    const catalog = new WorkflowCatalog('S2')
    catalog.load(def)
    expect(() => catalog.toolPolicyFor('1', 'nope')).toThrowError(/节点不在这个工作流版本里/)
  })
})
