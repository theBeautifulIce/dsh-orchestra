// src/executor/run-node.ts —— 单节点执行主链（规格 5.2 行 442-449）
// 生产路径的顺序固定：租约 → 建执行器 → 上报 started → 只读工具出强证据 → 核命令哈希 → 进 verifying → 上报 done。
import { OrchError } from '../core/errors.ts'
import { toolExecutionId } from '../core/ids.ts'
import type { Report } from '../core/report.ts'
import type { Db } from '../infra/sqlite/driver.ts'
import { withTx } from '../infra/sqlite/driver.ts'
import { transitionNode, DEFAULT_VERIFY_TIMEOUT_MS } from '../service/commands/node-state.ts'
import { appendNodeRunEvent } from '../infra/db/ledger.ts'
import { loadNodeRun } from '../service/commands/lease.ts'
import { acquireNodeRun, renewNodeLease, submitReport, type RuntimeDeps } from '../service/commands/runtime.ts'
import { checkToolPolicy, createExecutorAgent, type HostAgentFactory, type ToolPolicy } from './session.ts'
import { assertCommandHash, assertToolsAuthorized, commandHashOf, resolveInside, type ReadOnlyToolRunner, type StrongEvidence, type ToolRegistry } from './tools.ts'
import { canTransition } from '../core/state-machine.ts'
import type { ClockProvider } from '../core/clock.ts'

export type RunNodeParams = {
  nodeRunId: string
  nodeId: string
  attempt: number
  input: unknown
  outputSchema: unknown
  // 这一轮要跑的只读命令；每条都要落强证据
  tools: { command: string; args: string[]; cwd: string; timeoutMs: number }[]
  now: string
  ownerEpoch: number
  leaseTtlMs: number
  // 执行期心跳间隔；不传就用 10 秒（规格 4.3 行 309-310；门记录 G2.md 的本批定值）
  leaseRenewIntervalMs?: number
  // verifying 阶段的判定时限；不传就用 120 秒（规格 4.4 行 333）
  verifyTimeoutMs?: number
  // 动作总时限；不传就用 120 秒（规格 execution.action_timeout_ms；第五轮审计 P2-1）
  actionTimeoutMs?: number
}

// 租约 30 秒、心跳 10 秒：与门记录 G2.md 的本批定值一致（第四轮审计 M4）
export const DEFAULT_LEASE_TTL_MS = 30_000
export const DEFAULT_LEASE_RENEW_INTERVAL_MS = 10_000
export const DEFAULT_ACTION_TIMEOUT_MS = 120_000

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
  // 工具策略只从服务端加载过的定义取：请求体给什么不算数（第五轮审计 P1-2）
  const policy = policyForNodeRun(deps, p)
  // 前向路径只接只读工具；有副作用的动作走补偿或不可逆流程（规格 4.7 行 396）
  const derived = checkToolPolicy(deps.registry, policy)
  if (derived !== 'pure') {
    throw new OrchError('FORBIDDEN', '前向路径只接只读工具', { derived })
  }
  // 授权边界：真正要跑的工具必须落在定义给的授权集合里，deny 永远优先（规格 5.2 行 444-445；第四轮审计 M2）
  assertToolsAuthorized(deps.registry, policy, p.tools)
  const leaseTtlMs = p.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  const lease = acquireNodeRun(deps.runtime, {
    nodeRunId: p.nodeRunId,
    ownerEpoch: p.ownerEpoch,
    leaseTtlMs,
    now: p.now,
  })
  // 执行期心跳：动作比租约长时把租约往后推，合法动作不许被扫描判成租约过期（规格 4.3 行 309-310；第四轮审计 M4）
  const nowAt = startElapsedClock(deps, p.now)
  // 续租失败不再空吞：留一条 lease_lost 事件，动作结束前按租约丢失收口（第五轮审计 P2-1）
  const leaseState: { lost: string | null } = { lost: null }
  const renewTimer = setInterval(() => {
    try {
      renewNodeLease(deps.runtime, { nodeRunId: p.nodeRunId, leaseTtlMs, now: nowAt() })
    } catch (err) {
      const code = err instanceof OrchError ? err.code : 'SERVICE_UNAVAILABLE'
      leaseState.lost = code
      try {
        withTx(deps.db, (tx) => {
          appendNodeRunEvent(tx, deps.secret, p.nodeRunId, 'lease_lost', { attempt: p.attempt, reason: code })
        })
      } catch {
        // 账本也写不进去时保留 lost 标记，收口会拦住 done
      }
    }
  }, p.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS)
  renewTimer.unref?.()
  try {
    return await runNodeActions(deps, p, lease, nowAt, policy, leaseState)
  } finally {
    clearInterval(renewTimer)
  }
}

// 从 node_run 反查 run 绑定的工作流版本，再取该节点定义里的工具清单
function policyForNodeRun(deps: RunNodeDeps, p: RunNodeParams): ToolPolicy {
  const row = deps.db.raw.prepare(
    'SELECT n.node_id AS node_id, r.workflow_version AS workflow_version FROM node_runs n JOIN runs r ON r.run_id = n.run_id WHERE n.node_run_id = ?',
  ).get(p.nodeRunId) as { node_id: string; workflow_version?: number | null } | undefined
  if (!row) throw new OrchError('NOT_FOUND', 'node_run 不存在', { nodeRunId: p.nodeRunId })
  // 节点身份以账本为准：调用方传别的 nodeId 不许借到另一份工具授权
  if (row.node_id !== p.nodeId) {
    throw new OrchError('STALE_GENERATION', 'node_id 与账本不一致，不许借别的节点授权', { nodeRunId: p.nodeRunId, ledgerNodeId: row.node_id, requestedNodeId: p.nodeId })
  }
  if (row.workflow_version === null || row.workflow_version === undefined) {
    throw new OrchError('VERDICT_UNSUPPORTED', '这个 run 没有绑定工作流版本', { nodeRunId: p.nodeRunId })
  }
  const def = deps.runtime.catalog.toolPolicyFor(row.workflow_version, row.node_id)
  return { allow: def.allow, deny: def.deny, declaredPolicy: 'pure' }
}

// 动作主体：建执行器、跑工具、收口。拆成独立函数，心跳定时器才能在所有出口都被清掉
async function runNodeActions(
  deps: RunNodeDeps,
  p: RunNodeParams,
  lease: { action_generation: number },
  nowAt: () => string,
  policy: ToolPolicy,
  leaseState: { lost: string | null },
): Promise<RunNodeResult> {
  const agent = await createExecutorAgent(deps.agents, deps.registry, {
    nodeRunId: p.nodeRunId,
    attempt: p.attempt,
    input: p.input,
    outputSchema: p.outputSchema,
    toolPolicy: policy,
  })
  const generation = lease.action_generation
  // started 是状态迁移不是完成上报：没过证据门的上报不该用来推进状态
  withTx(deps.db, (tx) => {
    const row = loadNodeRun(tx, p.nodeRunId)
    transitionNode(tx, deps.secret, {
      nodeRunId: p.nodeRunId, from: 'dispatched', to: 'started',
      attempt: row.attempt, revision: row.revision, now: nowAt(), reason: 'executor_started',
    })
  })

  let evidence: StrongEvidence | null = null
  const actionTimeoutMs = p.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS
  const actionStartNs = deps.runtime.clock?.sample().monotonicNs ?? null
  const actionStartMs = Date.now()
  const elapsedMs = (): number => actionStartNs === null
    ? Date.now() - actionStartMs
    : (deps.runtime.clock!.sample().monotonicNs - actionStartNs) / 1e6
  // 每个工具都留一条轨迹：第一份失败证据不能被后面的成功覆盖（审计 P0-3）
  // 轨迹同时带上这次执行的唯一身份：同名工具在同一次 attempt 里跑两次也不许混成一条（评审《第二次意见.md》P1）
  const trace: { tool: string; toolSeq: number; executionId: string; exitCode: number; stdoutHash: string; stderrHash: string; commandHash: string }[] = []
  // tool_seq 从 1 起按调用次序排；同一 attempt 已有痕迹时从最大序号续，重入也不撞主键
  let toolSeq = nextToolSeq(deps, p)
  try {
    for (const tool of p.tools) {
      // 动作总时限真的参与执行：剩余额度用光就停，并按动作超时收口（第五轮审计 P2-1）
      const remaining = actionTimeoutMs - elapsedMs()
      if (remaining <= 0) {
        markBlocked(deps, p, 'action_timeout', nowAt())
        throw new OrchError('OPERATION_TIMEOUT', '动作超过总时限，节点停在这里', { nodeRunId: p.nodeRunId, actionTimeoutMs })
      }
      // 身份在工具起飞前就定下来：tool_started、tool_finished 与证据回执都绑同一个 execution_id
      const seq = toolSeq
      const executionId = toolExecutionId()
      toolSeq += 1
      // 工具起飞前先把时刻和事件写下去：取消要能证明「工具在飞」（证据 G-05）
      withTx(deps.db, (tx) => {
        tx.run('UPDATE node_runs SET tool_start_at = ?, updated_at = ? WHERE node_run_id = ?', [nowAt(), nowAt(), p.nodeRunId])
        appendNodeRunEvent(tx, deps.secret, p.nodeRunId, 'tool_started', {
          tool: tool.command,
          attempt: p.attempt,
          tool_seq: seq,
          execution_id: executionId,
        })
      })
      const out = await deps.runner.runTool({
        command: tool.command,
        args: tool.args,
        cwd: tool.cwd,
        // 单条工具也不许超过动作总时限的剩余额度
        timeoutMs: Math.min(tool.timeoutMs, Math.ceil(remaining)),
        workspaceRoot: deps.runner.root,
      })
      // 落库前必须核对命令哈希，核不上就不许当证据（规格 7.2 行 588）
      const descriptor = deps.registry.require(tool.command)
      // 期望哈希必须与 runner 实际执行的 argv 同源：请求里的 args 不覆盖注册表参数，也不能拿来算哈希
      const args = descriptor.command.args
      // 期望哈希用执行器实际解析过的绝对 cwd，和 runner 落证据时同一口径
      assertCommandHash(out.evidence, commandHashOf(descriptor.command.bin, args, resolveInside(deps.runner.root, tool.cwd), deps.runner.root))
      evidence = out.evidence
      trace.push({
        tool: tool.command,
        toolSeq: seq,
        executionId,
        exitCode: out.evidence.exitCode,
        stdoutHash: out.evidence.stdoutHash,
        stderrHash: out.evidence.stderrHash,
        commandHash: out.evidence.commandHash,
      })
      // 工具执行痕迹落库：收口时拿它核对「这条 done 报告的证据是不是真跑出来的」（审计 R3-03）
      // 痕迹行带上 tool_seq 与 execution_id：同名工具在同一次 attempt 里跑几次都不会撞主键
      withTx(deps.db, (tx) => {
        tx.run(
          'INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, execution_id, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            p.nodeRunId,
            p.attempt,
            seq,
            tool.command,
            executionId,
            out.evidence.exitCode,
            out.evidence.stdoutHash ?? null,
            out.evidence.stderrHash ?? null,
            out.evidence.commandHash ?? null,
            nowAt(),
            nowAt(),
          ],
        )
        appendNodeRunEvent(tx, deps.secret, p.nodeRunId, 'tool_finished', {
          tool: tool.command,
          attempt: p.attempt,
          tool_seq: seq,
          execution_id: executionId,
          exit_code: out.evidence.exitCode,
          stdout_hash: out.evidence.stdoutHash ?? null,
          stderr_hash: out.evidence.stderrHash ?? null,
          command_hash: out.evidence.commandHash ?? null,
        })
      })
      if (out.evidence.exitCode !== 0) break
    }
  } catch (err) {
    // 执行器抛错也要把节点落到可被人看见的位置，不许留在 verifying 死等
    markBlocked(deps, p, 'tool_execution_failed', nowAt())
    throw err
  }

  // 续租失败过：动作已经失去合法租约，不许再进 verifying 收口（第五轮审计 P2-1）
  if (leaseState.lost) {
    markBlocked(deps, p, 'lease_lost', nowAt())
    throw new OrchError('LEASE_EXPIRED', '执行期续租失败，节点按租约丢失收口', { nodeRunId: p.nodeRunId, reason: leaseState.lost })
  }

  // 系统级判失败：任一工具 exitCode≠0 就中断后续工具，节点不许落 done（审计 R3-01）
  const failedTool = trace.find((t) => t.exitCode !== 0)
  if (failedTool) {
    // 工具失败就不许收口：节点落 blocked_post，异常抛出去让调用方看见（审计 R3-01）
    markBlocked(deps, p, 'tool_execution_failed', nowAt())
    throw new OrchError('VERDICT_POLICY_UNMET', '节点没过判定条件：工具 exitCode 不是 0，收口被拒', {
      nodeRunId: p.nodeRunId,
      tool: failedTool.tool,
      exit_code: failedTool.exitCode,
    })
  }

  withTx(deps.db, (tx) => {
    const row = loadNodeRun(tx, p.nodeRunId)
    transitionNode(tx, deps.secret, {
      nodeRunId: p.nodeRunId,
      from: 'started',
      to: 'verifying',
      attempt: row.attempt,
      revision: row.revision,
      now: nowAt(),
      reason: 'work_submitted',
      verifyTimeoutMs: p.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      // 判定锚点：墙钟只作展示，判定只读 boot_id 与单调纳秒（规格 3.4 行 171）
      verifyAnchor: deps.runtime.clock ? anchorOf(deps.runtime.clock, nowAt()) : undefined,
    })
  })

  const applied = submitReport(deps.runtime, {
    nodeRunId: p.nodeRunId,
    attempt: p.attempt,
    report: reportOf(p, 'done', evidence, { evidence_trace: trace }),
    expectedStatus: 'verifying',
    generation,
    now: nowAt(),
  })
  if (!applied.accepted) {
    // 收口被拒：转 blocked_post 并留 verify_human，等人补证据或判失败，不许留 verifying 死等
    markBlocked(deps, p, applied.reason ?? 'verdict_unmet', nowAt())
    throw new OrchError('VERDICT_POLICY_UNMET', '节点没过判定条件，收口被拒', {
      nodeRunId: p.nodeRunId,
      reason: applied.reason,
      registry_state: applied.registry_state,
    })
  }
  return { node_run_id: p.nodeRunId, final_status: applied.next_status ?? 'unknown', evidence, agent_id: agent.agentId }
}

// 同一 attempt 里下一个工具序号：正常路径从 1 起；这一 attempt 已经有痕迹时从最大序号续，
// 同一节点重入执行也不会撞 (node_run_id, attempt, tool_seq) 主键
function nextToolSeq(deps: RunNodeDeps, p: RunNodeParams): number {
  const row = deps.db.raw.prepare(
    'SELECT MAX(tool_seq) AS max_seq FROM tool_executions WHERE node_run_id = ? AND attempt = ?',
  ).get(p.nodeRunId, p.attempt) as { max_seq: number | null } | undefined
  return (row?.max_seq ?? 0) + 1
}

// 执行期时刻：以调用方给的时刻为基准，按单调钟往前推；墙钟跳变不该影响租约与时长判断（规格 3.4 行 171）
function startElapsedClock(deps: RunNodeDeps, base: string): () => string {
  const clock = deps.runtime.clock
  const baseMs = Date.parse(base)
  if (!clock || !Number.isFinite(baseMs)) return () => base
  const startNs = clock.sample().monotonicNs
  return () => {
    // 整秒推进：毫秒级抖动会让门证据每次重跑都变字节，证据就不可复算（同 N1 的教训）
    const elapsedSec = Math.max(0, Math.floor((clock.sample().monotonicNs - startNs) / 1e9))
    // 基时刻的毫秒位保持原样，只按整秒往前推，账本时刻不重新对齐墙钟零点
    return new Date(baseMs + elapsedSec * 1000).toISOString()
  }
}

// 判定锚点：取一次时钟采样，墙钟给展示用，单调纳秒给判定用（规格 3.4 行 171）
function anchorOf(clock: ClockProvider, now: string): { bootId: string; monotonicNs: number; wallClockMs: number } {
  const sample = clock.sample()
  return { bootId: sample.bootId, monotonicNs: sample.monotonicNs, wallClockMs: Date.parse(now) }
}

// 失败或证据不足：从当前非终态落到 blocked_post，并留一条 verify_human 说明为什么卡住
function markBlocked(deps: RunNodeDeps, p: RunNodeParams, reason: string, now: string): void {
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
        now,
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
