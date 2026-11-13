// src/service/workflows.ts —— 工作流定义目录（规格 2.4 行 122、6.1 行 837-844）
import { OrchError } from '../core/errors.ts'
import type { Phase } from '../core/config.ts'
import { mergePassConditions, type PassCondition } from '../core/policy.ts'
import { assertDefinitionAllowed, type WorkflowDefinition } from '../core/workflow-def.ts'

export type LoadWorkflowResult = {
  workflow_version: string
  nodes: { node_id: string; type: string; pass_conditions: PassCondition[] }[]
}

// 定义只许从入口加载：加载期就按阶段拒越界能力，别等到派发才发现
export class WorkflowCatalog {
  private readonly defs = new Map<string, WorkflowDefinition>()
  private readonly phase: Phase

  constructor(phase: Phase) { this.phase = phase }

  load(def: WorkflowDefinition): LoadWorkflowResult {
    assertDefinitionAllowed(def, this.phase)
    this.defs.set(String(def.workflow_version), def)
    return {
      workflow_version: String(def.workflow_version),
      nodes: def.nodes.map((n) => ({
        node_id: n.node_id,
        type: n.type,
        pass_conditions: mergePassConditions(def.pass_conditions ?? [], n.pass_conditions ?? []),
      })),
    }
  }

  get(version: string | number): WorkflowDefinition {
    const def = this.defs.get(String(version))
    if (!def) throw new OrchError('NOT_FOUND', '工作流版本没加载过', { workflow_version: String(version) })
    return def
  }

  // 节点收口用的判定条件：模板条件为基线，节点条件按 AND 追加（规格 6.1 行 837）
  policyFor(version: string | number, nodeId: string): { passConditions: PassCondition[] } {
    const def = this.get(version)
    const node = def.nodes.find((n) => n.node_id === nodeId)
    if (!node) throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '节点不在这个工作流版本里', { workflow_version: String(version), nodeId })
    return { passConditions: mergePassConditions(def.pass_conditions ?? [], node.pass_conditions ?? []) }
  }
}
