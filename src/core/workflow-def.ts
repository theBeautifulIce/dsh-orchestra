// src/core/workflow-def.ts —— 定义校验与阶段兼容（规格 2.4 行 122、11.1 行 930-937）
import { OrchError } from './errors.ts'
import { PHASE_CAPABILITIES, type Phase } from './config.ts'
import type { PassCondition } from './policy.ts'

export type NodeType = 'agent' | 'parallel' | 'subworkflow' | 'decision' | 'wait'

export type WorkflowNodeDef = {
  node_id: string
  type: NodeType
  tools?: { allow?: string[]; deny?: string[] }
  // 节点自带的通过条件；和模板条件取 AND（规格 6.1 行 837）
  pass_conditions?: PassCondition[]
  // 节点要求的必留哈希；和模板要求取并集（规格 4.7 行 380）
  required_hashes?: string[]
}

export type WorkflowDefinition = {
  workflow_version: string
  // 模板级通过条件，作为基线（规格 6.1 行 838）
  pass_conditions?: PassCondition[]
  // 模板级必留哈希；不可逆节点的通过凭据（规格 4.7 行 380）
  required_hashes?: string[]
  nodes: WorkflowNodeDef[]
}

// 节点类型对应的能力名
export const NODE_CAPABILITY: Record<NodeType, string> = {
  agent: 'agent_node',
  parallel: 'parallel',
  subworkflow: 'subworkflow',
  decision: 'decision',
  wait: 'wait',
}

export function isKnownNodeType(type: string): type is NodeType {
  return Object.prototype.hasOwnProperty.call(NODE_CAPABILITY, type)
}

// 加载期按 min_phase 拒越阶段能力：S2 加载 parallel 节点必须被拒（规格 2.4 行 122）
export function assertDefinitionAllowed(def: WorkflowDefinition, phase: Phase): void {
  for (const node of def.nodes) {
    if (!isKnownNodeType(node.type)) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '未知节点类型', { node_id: node.node_id, type: node.type })
    }
    const capability = NODE_CAPABILITY[node.type]
    if (!PHASE_CAPABILITIES[phase].includes(capability)) {
      throw new OrchError('FORBIDDEN', '当前阶段不提供这个能力', {
        phase,
        needed: capability,
        node_id: node.node_id,
        allowed: PHASE_CAPABILITIES[phase].slice(),
      })
    }
  }
}

// 命令越过阶段的闸：能力不在当前阶段的清单里就拒（规格 2.4 行 122）
export function assertCommandAllowed(command: string, phase: Phase, needed: string): void {
  const caps = PHASE_CAPABILITIES[phase]
  if (!caps.includes(needed)) {
    throw new OrchError('FORBIDDEN', '当前阶段不许做这件事', {
      command,
      phase,
      needed,
      allowed: caps.slice(),
    })
  }
}
