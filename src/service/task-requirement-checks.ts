import { contractAgentRoster, type ConstraintBinding, type RequirementsContract } from '../core/task-requirements.ts'
import { taskAccess } from '../core/task-access.ts'

export type RequirementNode = {
  id: string
  type: string
  dependsOn: string[]
  conditionalFanout?: boolean
  approvalPrompt?: string
  sideEffectPolicy?: string
  declaredTools: string[]
}

type ContractPlan = {
  steps: Array<{ node_id: string; tools: string[] }>
  deliverables: Array<{ acceptance: { kind: string } }>
  constraint_bindings?: ConstraintBinding[]
}

/** Ordinary predecessors are an AND gate. Conditional or parallel paths require additional proof. */
function approvalPrecedes(nodes: Map<string, RequirementNode>, approvalId: string, protectedId: string): boolean {
  if (nodes.get(approvalId)?.type !== 'approval' || !['agent', 'tool'].includes(nodes.get(protectedId)?.type ?? '')) return false
  const visited = new Set<string>()
  const pending = [...(nodes.get(protectedId)?.dependsOn ?? [])]
  while (pending.length > 0) {
    const id = pending.pop()!
    if (visited.has(id)) continue
    const node = nodes.get(id)
    if (!node || !['agent', 'approval', 'wait', 'policy', 'tool'].includes(node.type)) return false
    visited.add(id)
    pending.push(...node.dependsOn)
  }
  return visited.has(approvalId)
}

type RosterNode = Pick<RequirementNode, 'id' | 'type' | 'dependsOn' | 'conditionalFanout'>

// Branches execute one alternative. A role after a merge counts when every
// alternative reaches that same role. Roles on ordinary parallel paths coexist.
function guaranteedAgents(workflow: readonly RosterNode[]) {
  const agents = workflow.filter(node => node.type === 'agent')
  if (!workflow.some(node => node.type === 'branch' || node.conditionalFanout)) return agents
  const successors = new Map<string, RosterNode[]>()
  for (const node of workflow) for (const parent of node.dependsOn) {
    const children = successors.get(parent) ?? []
    children.push(node)
    successors.set(parent, children)
  }
  const memo = new Map<string, Set<string>>()
  function guaranteedFrom(node: RosterNode): Set<string> {
    const cached = memo.get(node.id)
    if (cached) return cached
    const roles = new Set<string>(node.type === 'agent' ? [node.id] : [])
    memo.set(node.id, roles)
    const children = (successors.get(node.id) ?? []).map(guaranteedFrom)
    if (node.type === 'branch' || node.conditionalFanout) {
      for (const id of children[0] ?? []) if (children.every(child => child.has(id))) roles.add(id)
    } else {
      for (const child of children) for (const id of child) roles.add(id)
    }
    return roles
  }
  const required = new Set<string>()
  for (const root of workflow.filter(node => !node.dependsOn.length))
    for (const id of guaranteedFrom(root)) required.add(id)
  return agents.filter(node => required.has(node.id))
}
// Maximum number of mutually independent agent roles in the workflow DAG.
// By Dilworth's theorem this is the number of roles minus a maximum matching
// between roles and their transitive predecessors. Common preparation and later
// aggregation can therefore coexist with the requested parallel group.
export function concurrentAgentCapacity(workflow: readonly RosterNode[], agents = guaranteedAgents(workflow)) {
  const nodes = new Map(workflow.map(node => [node.id, node]))
  const participating = new Set(agents.map(node => node.id))
  const predecessors = new Map<string, string[]>()
  for (const role of agents) {
    const visited = new Set<string>()
    const pending = [...role.dependsOn]
    const upstream: string[] = []
    while (pending.length) {
      const id = pending.pop()!
      if (visited.has(id)) continue
      visited.add(id)
      const node = nodes.get(id)
      if (participating.has(id)) upstream.push(id)
      if (node) pending.push(...node.dependsOn)
    }
    predecessors.set(role.id, upstream)
  }
  const paired = new Map<string, string>()
  function match(role: string, seen: Set<string>): boolean {
    for (const earlier of predecessors.get(role) ?? []) {
      if (seen.has(earlier)) continue
      seen.add(earlier)
      const previous = paired.get(earlier)
      if (previous === undefined || match(previous, seen)) { paired.set(earlier, role); return true }
    }
    return false
  }
  for (const role of predecessors.keys()) match(role, new Set())
  return predecessors.size - paired.size
}

export function fixedRosterIssue(contract: RequirementsContract, workflow: readonly RosterNode[]): string | undefined {
  return rosterWorkflowIssue(contractAgentRoster(contract.sources), workflow)
}

export function rosterWorkflowIssue(roster: ReturnType<typeof contractAgentRoster>, workflow: readonly RosterNode[]): string | undefined {
  if (!roster) return
  if (roster.conflicting) return '同一任务指定了不同的参与人数，请确认后再开始。'
  if (roster.closed && workflow.some(node => node.type === 'subworkflow')) return '任务限定了参与代理，当前不能核实子流程的参与者。'
  const count = workflow.filter(node => node.type === 'agent').length
  const agents = guaranteedAgents(workflow)
  if (roster.count && (agents.length < roster.count || roster.closed && count !== roster.count))
    return `任务要求由${roster.closed ? '指定的' : '至少'} ${roster.count} 个代理执行，请核对计划人数。`
  if (roster.parallelCount > 1 && concurrentAgentCapacity(workflow, agents) < roster.parallelCount)
    return `任务要求 ${roster.parallelCount} 个代理并行执行，当前流程让代理互相等待。`
}

export function requirementIssues(contract: RequirementsContract, proposal: ContractPlan, workflow: readonly RequirementNode[]): string[] {
  const issues: string[] = []
  const nodes = new Map(workflow.map(node => [node.id, node]))
  const constraints = new Map(contract.constraints.map(constraint => [constraint.id, constraint]))
  const bindings = new Map<string, ConstraintBinding>()
  for (const binding of proposal.constraint_bindings ?? []) {
    const constraint = constraints.get(binding.constraint_id)
    if (bindings.has(binding.constraint_id) || constraint?.kind !== 'approval_before' || constraint.scope !== 'steps') {
      issues.push('审批绑定引用了重复或不存在的步骤审批约束。')
    }
    bindings.set(binding.constraint_id, binding)
  }
  const access = taskAccess(contract)
  const rosterIssue = fixedRosterIssue(contract, workflow)
  if (rosterIssue) issues.push(rosterIssue)
  if (access.restricted && (proposal.steps.some(step => step.tools.length > 0)
    || workflow.some(node => node.declaredTools.length > 0 || node.type === 'tool' || node.type === 'subworkflow'))) {
    issues.push('任务禁止网络访问或工作区读取。固定命令、工具节点及子流程尚无可信的访问能力证明；请使用受控文本代理和已授权的内部材料。')
  }
  for (const constraint of contract.constraints) {
    if ((constraint.kind === 'chat_only' || constraint.kind === 'no_workspace_files')
      && proposal.deliverables.some(item => item.acceptance.kind === 'artifact')) {
      issues.push(`约束 ${constraint.id} 要求在聊天中交付或禁止创建文件，计划仍安排了文件交付。`)
    }
    if (constraint.kind === 'chat_only' && !proposal.deliverables.some(item => item.acceptance.kind === 'chat/text_result')) {
      issues.push(`约束 ${constraint.id} 要求聊天正文，计划缺少可验收的会话文字交付。`)
    }
    if (constraint.kind === 'approval_before') {
      if (constraint.reviewer.kind === 'named') {
        issues.push(`约束 ${constraint.id} 指定由「${constraint.reviewer.name}」复核，当前流程没有可核验的审批人身份绑定。`)
        continue
      }
      if (constraint.scope === 'task') continue
      const binding = bindings.get(constraint.id)
      if (!binding || new Set(binding.protected_node_ids).size !== binding.protected_node_ids.length) {
        issues.push(`约束 ${constraint.id} 缺少唯一、准确的受控步骤和审批绑定。`)
        continue
      }
      const gate = nodes.get(binding.approval_node_id)
      if (constraint.gate_name && gate?.type === 'approval' && gate.approvalPrompt !== constraint.gate_name) {
        issues.push(`约束 ${constraint.id} 需要名为「${constraint.gate_name}」的审批卡，请核对绑定的审批步骤。`)
      }
      // The model's description cannot establish which execution performs an action.
      // Until the catalog binds action capabilities, a scoped gate must cover every executable node.
      const executions = workflow.filter(node => ['agent', 'tool', 'subworkflow'].includes(node.type))
      if (executions.some(node => !binding.protected_node_ids.includes(node.id))) {
        issues.push(`约束 ${constraint.id} 尚无可信的动作与步骤映射，审批必须覆盖全部执行步骤。请核对审批范围。`)
      }
      for (const id of binding.protected_node_ids) {
        if (!approvalPrecedes(nodes, binding.approval_node_id, id)) {
          issues.push(`约束 ${constraint.id} 无法证明步骤 ${id} 执行前必须通过审批 ${binding.approval_node_id}。请调整依赖或使用可核验的普通前置步骤。`)
        }
      }
      continue
    }
    const needsReadOnly = ['read_only', 'preserve_input', 'no_workspace_files', 'no_external_send', 'no_network', 'no_workspace_read'].includes(constraint.kind)
    if (needsReadOnly && workflow.some(node => node.type === 'subworkflow'
      || (node.sideEffectPolicy !== undefined && node.sideEffectPolicy !== 'pure'))) {
      issues.push(`约束 ${constraint.id} 需要受控的只读执行，当前流程包含尚不能证明符合该约束的子流程或副作用步骤。`)
    }
    // This restricts task tools and delivery destinations. The configured model request remains the host's existing transport.
    if (constraint.kind === 'no_external_send' && (proposal.steps.some(step => step.tools.length > 0)
      || workflow.some(node => node.declaredTools.length > 0 || node.type === 'tool'))) {
      issues.push(`约束 ${constraint.id} 禁止向外发送，现有工具能力记录无法证明外发范围。请使用无工具的文本步骤或补齐明确的工具能力。`)
    }
  }
  return issues
}

/** If host popups are disabled, an explicit fail-closed workflow gate can be
 * the first human decision instead of demanding the same approval twice.
 * The caller must supply the catalog's corroborated agent effects, not the
 * publisher's unverified pure declaration, and must still check plan quality.
 * Other control nodes, fixed tools, materials, and whole-task approval are
 * deliberately not eligible for this narrow path. */
export function canStartAtRequiredGate(contract: RequirementsContract | undefined,
  proposal: ContractPlan, workflow: readonly RequirementNode[]): boolean {
  if (!contract || contract.start_policy !== 'immediate') return false
  const approvals = contract.constraints.filter(item => item.kind === 'approval_before')
  if (!approvals.length || approvals.some(item => item.scope !== 'steps' || item.reviewer.kind !== 'operator')) return false
  const agents = workflow.filter(node => node.type === 'agent')
  const gates = workflow.filter(node => node.type === 'approval')
  if (!agents.length || !gates.length || workflow.some(node => !['agent', 'approval'].includes(node.type)
    || node.declaredTools.length > 0) || agents.some(node => node.sideEffectPolicy !== 'pure')
    || proposal.steps.some(step => step.tools.length > 0)) return false
  const requiredGates = new Set((proposal.constraint_bindings ?? []).map(binding => binding.approval_node_id))
  if (gates.some(gate => !requiredGates.has(gate.id))) return false
  return requirementIssues(contract, proposal, workflow).length === 0
}
