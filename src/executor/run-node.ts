// src/executor/run-node.ts —— 单节点执行主链（规格 5.2 行 442-449）
// 生产路径的顺序固定：租约 → 建执行器 → 上报 started → 只读工具出强证据 → 核命令哈希 → 进 verifying → 上报 done。
import { OrchError } from '../core/errors.ts'
import type { Report } from '../core/report.ts'
import type { Db } from '../infra/sqlite/driver.ts'
import { withTx } from '../infra/sqlite/driver.ts'
import { transitionNode, DEFAULT_VERIFY_TIMEOUT_MS } from '../service/commands/node-state.ts'
import { appendNodeRunEvent } from '../infra/db/ledger.ts'
import { loadNodeRun } from '../service/commands/lease.ts'
import { acquireNodeRun, submitReport, type RuntimeDeps } from '../service/commands/runtime.ts'
import { checkToolPolicy, createExecutorAgent, type HostAgentFactory, type ToolPolicy } from './session.ts'
import { assertCommandHash, commandHashOf, resolveInside, type ReadOnlyToolRunner, type StrongEvidence, type ToolRegistry } from './tools.ts'
import { canTransition } from '../core/state-machine.ts'

export type RunNodeParams = {
  nodeRunId: string
  nodeId: string
  attempt: number
  input: unknown
  outputSchema: unknown
  toolPolicy: ToolPolicy
  // 这一轮要跑的只读命令；每条都要落强证据
  tools: { command: string; args: string[]; cwd: string; timeoutMs: number }[]
  now: string
  ownerEpoch: number
  leaseTtlMs: number
  // verifying 阶段的判定时限；不传就用 120 秒（规格 4.4 行 333）
  verifyTimeoutMs?: number
}

export type RunNodeResult = {
  node_run_id: string
  final_status: string
  evidence: StrongEvidence | null
  agent_id: string
}

export type RunNodeDeps = {
  runtime: RuntimeDeps
  db: Db
  secret: string
  registry: ToolRegistry
  agents: HostAgentFactory
  runner: ReadOnlyToolRunner
}

export async function runNode(deps: RunNodeDeps, p: RunNodeParams): Promise<RunNodeResult> {
  // 前向路径只接只读工具；有副作用的动作走补偿或不可逆流程（规格 4.7 行 396）
  const derived = checkToolPolicy(deps.registry, p.toolPolicy)
  if (derived !== 'pure') {
    throw new OrchError('FORBIDDEN', '前向路径只接只读工具', { derived })
  }
  const lease = acquireNodeRun(deps.runtime, {
    nodeRunId: p.nodeRunId,
    ownerEpoch: p.ownerEpoch,
    leaseTtlMs: p.leaseTtlMs,
    now: p.now,
  })
  const agent = await createExecutorAgent(deps.agents, deps.registry, {
    nodeRunId: p.nodeRunId,
    attempt: p.attempt,
    input: p.input,
    outputSchema: p.outputSchema,
    toolPolicy: p.toolPolicy,
  })
  const generation = lease.action_generation
  // started 是状态迁移不是完成上报：没过证据门的上报不该用来推进状态
  withTx(deps.db, (tx) => {
    const row = loadNodeRun(tx, p.nodeRunId)
    transitionNode(tx, deps.secret, {
      nodeRunId: p.nodeRunId, from: 'dispatched', to: 'started',
      attempt: row.attempt, revision: row.revision, now: p.now, reason: 'executor_started',
    })
  })

  let evidence: StrongEvidence | null = null
  // 每个工具都留一条轨迹：第一份失败证据不能被后面的成功覆盖（审计 P0-3）
  const trace: { tool: string; exitCode: number; stdoutHash: string; stderrHash: string; commandHash: string }[] = []
  try {
    for (const tool of p.tools) {
      // 工具起飞前先把时刻和事件写下去：取消要能证明「工具在飞」（证据 G-05）
      withTx(deps.db, (tx) => {
        tx.run('UPDATE node_runs SET tool_start_at = ?, updated_at = ? WHERE node_run_id = ?', [p.now, p.now, p.nodeRunId])
        appendNodeRunEvent(tx, deps.secret, p.nodeRunId, 'tool_started', {
          tool: tool.command,
          attempt: p.attempt,
        })
      })
      const out = await deps.runner.runTool({
        command: tool.command,
        args: tool.args,
        cwd: tool.cwd,
        timeoutMs: tool.timeoutMs,
        workspaceRoot: deps.runner.root,
      })
      // 落库前必须核对命令哈希，核不上就不许当证据（规格 7.2 行 588）
      const descriptor = deps.registry.require(tool.command)
      const args = tool.args.length > 0 ? tool.args : descriptor.command.args
      // 期望哈希用执行器实际解析过的绝对 cwd，和 runner 落证据时同一口径
      assertCommandHash(out.evidence, commandHashOf(descriptor.command.bin, args, resolveInside(deps.runner.root, tool.cwd)))
      evidence = out.evidence
      trace.push({
        tool: tool.command,
        exitCode: out.evidence.exitCode,
        stdoutHash: out.evidence.stdoutHash,
        stderrHash: out.evidence.stderrHash,
        commandHash: out.evidence.commandHash,
      })
      if (out.evidence.exitCode !== 0) break
    }
  } catch (err) {
    // 执行器抛错也要把节点落到可被人看见的位置，不许留在 verifying 死等
    markBlocked(deps, p, 'tool_execution_failed')
    throw err
  }

  withTx(deps.db, (tx) => {
    const row = loadNodeRun(tx, p.nodeRunId)
    transitionNode(tx, deps.secret, {
      nodeRunId: p.nodeRunId,
      from: 'started',
      to: 'verifying',
      attempt: row.attempt,
      revision: row.revision,
      now: p.now,
      reason: 'work_submitted',
      verifyTimeoutMs: p.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    })
  })

  const applied = submitReport(deps.runtime, {
    nodeRunId: p.nodeRunId,
    attempt: p.attempt,
    report: reportOf(p, 'done', evidence, { evidence_trace: trace }),
    expectedStatus: 'verifying',
    generation,
    now: p.now,
  })
  if (!applied.accepted) {
    // 收口被拒：转 blocked_post 并留 verify_human，等人补证据或判失败，不许留 verifying 死等
    markBlocked(deps, p, applied.reason ?? 'verdict_unmet')
    throw new OrchError('VERDICT_POLICY_UNMET', '节点没过判定条件，收口被拒', {
      nodeRunId: p.nodeRunId,
      reason: applied.reason,
      registry_state: applied.registry_state,
    })
  }
  return { node_run_id: p.nodeRunId, final_status: applied.next_status ?? 'unknown', evidence, agent_id: agent.agentId }
}

// 失败或证据不足：从当前非终态落到 blocked_post，并留一条 verify_human 说明为什么卡住
function markBlocked(deps: RunNodeDeps, p: RunNodeParams, reason: string): void {
  try {
    withTx(deps.db, (tx) => {
      const row = loadNodeRun(tx, p.nodeRunId)
      if (!canTransition(row.status, 'blocked_post')) return
      transitionNode(tx, deps.secret, {
        nodeRunId: p.nodeRunId,
        from: row.status,
        to: 'blocked_post',
        attempt: row.attempt,
        revision: row.revision,
        now: p.now,
        reason: 'executor_blocked',
        verifyHuman: { reason, missing: [] },
      })
    })
  } catch {
    // 已经被取消或别的流程改过状态：保留原错抛出，不把第二层错误盖上去
  }
}

function reportOf(p: RunNodeParams, status: 'started' | 'done', evidence?: StrongEvidence | null, output?: unknown): Report {
  return {
    // 同一次执行里 started/done 两份报告 id 固定可推，重放时也对得上
    report_id: 'rep_' + p.nodeRunId + '_' + String(p.attempt) + '_' + status,
    node_run_id: p.nodeRunId,
    attempt: p.attempt,
    status,
    ...(evidence ? { evidence: { ...evidence } } : {}),
    ...(output !== undefined ? { output } : {}),
  }
}
