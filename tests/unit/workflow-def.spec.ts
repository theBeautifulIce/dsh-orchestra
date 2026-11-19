import { describe, expect, it } from 'vitest'
import { PHASE_CAPABILITIES } from '../../src/core/config.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import { assertCommandAllowed, assertDefinitionAllowed, type WorkflowDefinition } from '../../src/core/workflow-def.ts'

const def = (type: string): WorkflowDefinition => ({
  workflow_version: 'wf1',
  nodes: [{ node_id: 'n1', type: type as any }],
})

it('requires both a signed pure declaration and a read-only host registry to authorize pure rework', () => {
  const catalog = new WorkflowCatalog('S5', undefined, tool => tool === 'inspect')
  const agent = { node_id: 'analyze', type: 'agent' as const, tools: { allow: ['inspect'] } }
  expect(catalog.initialAgentEffect(agent)).toBe('compensable')
  expect(catalog.initialAgentEffect({ ...agent, side_effect_policy: 'pure' })).toBe('pure')
  expect(catalog.initialAgentEffect({ ...agent, side_effect_policy: 'pure', tools: { allow: ['upload'] } })).toBe('compensable')
  expect(new WorkflowCatalog('S5').initialAgentEffect({ ...agent, side_effect_policy: 'pure' })).toBe('compensable')
  expect(catalog.initialAgentEffect({ ...agent, side_effect_policy: 'irreversible' })).toBe('irreversible')
})

describe('加载期阶段拒', () => {
  it('S2 下单个 agent 节点通过', () => {
    expect(() => assertDefinitionAllowed(def('agent'), 'S2')).not.toThrow()
  })

  it('S2 下 parallel 节点抛 FORBIDDEN，details 点明 needed 与 phase', () => {
    try {
      assertDefinitionAllowed(def('parallel'), 'S2')
      throw new Error('不该通过')
    } catch (e: any) {
      expect(e.code).toBe('FORBIDDEN')
      expect(e.details.needed).toBe('parallel')
      expect(e.details.phase).toBe('S2')
    }
  })

  it('S2 下 subworkflow 节点抛 FORBIDDEN', () => {
    expect(() => assertDefinitionAllowed(def('subworkflow'), 'S2')).toThrowError(/当前阶段不提供这个能力/)
  })

  it('未知节点类型抛 SCHEMA_VERSION_UNSUPPORTED', () => {
    try {
      assertDefinitionAllowed(def('mystery'), 'S2')
      throw new Error('不该通过')
    } catch (e: any) {
      expect(e.code).toBe('SCHEMA_VERSION_UNSUPPORTED')
    }
  })

  it('同一个 parallel 定义在 S3 下通过', () => {
    expect(() => assertDefinitionAllowed(def('parallel'), 'S3')).not.toThrow()
  })
})

describe('命令阶段闸', () => {
  it('S2 + parallel → FORBIDDEN；S2 + agent_node → 通过', () => {
    expect(() => assertCommandAllowed('publish', 'S2', 'parallel')).toThrowError(/当前阶段不许做这件事/)
    expect(() => assertCommandAllowed('dispatch', 'S2', 'agent_node')).not.toThrow()
  })

  it('S2 能力表含 agent_node，不含 parallel / subworkflow / workflow_publish', () => {
    expect(PHASE_CAPABILITIES.S2).toContain('agent_node')
    expect(PHASE_CAPABILITIES.S2).not.toContain('parallel')
    expect(PHASE_CAPABILITIES.S2).not.toContain('subworkflow')
    expect(PHASE_CAPABILITIES.S2).not.toContain('workflow_publish')
  })
})
