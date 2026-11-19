// src/executor/evidence-collector.ts —— Agent 的 tool.call 只提出请求，强证据由宿主执行产生。
// 工具调用的 outbox 先落 pending，再执行；崩溃后 pending 不许盲目重跑，completed 只重发结果。
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../infra/db/ledger.ts'
import type { ClockProvider } from '../core/clock.ts'
import {
  assertCommandHash, assertToolsAuthorized, commandHashOf, resolveInside,
  type EffectVerificationTarget, type EffectVerifier, type ReadOnlyToolRunner, type RunToolResult, type StrongEvidence, type ToolRegistry,
} from './tools.ts'
import type { ToolPolicy } from './session.ts'
import { toolExecutionId } from '../core/ids.ts'

export type ToolCallPayload = {
  callId: string
  tool: string
  args: string[]
  cwd: string
  timeoutMs: number
}

export type CollectedToolResult = {
  callId: string
  exitCode: number
  stdout: string
  stderr: string
  // outbox 里保存的宿主痕迹；重放已完成调用时用它恢复 trace/evidence，避免崩溃后收口缺证据。
  trace?: ToolTraceEntry
  evidence?: StrongEvidence
}

type OutboxRow = {
  status: 'pending' | 'completed' | 'failed'
  request_hash: string
  result_json: string | null
}

type VerificationTarget = EffectVerificationTarget & { action_generation: number }

function verifyEffectOutput(verifier: EffectVerifier, target: VerificationTarget, output: RunToolResult) {
  if (output.evidence.exitCode !== 0) return null
  const { action_generation: _generation, ...scope } = target
  try {
    const result = verifier.verify({ ...scope }, { stdout: output.stdout, stderr: output.stderr })
    if (!result || (result.verdict !== 'applied' && result.verdict !== 'not_applied')
      || typeof result.reference !== 'string' || !result.reference.trim()) return null
    return { ...scope, verifier_id: verifier.id, verdict: result.verdict, reference_hash: sha256Hex(result.reference) }
  } catch {
    // The tool still ran. A verifier that cannot interpret the output issues no business proof.
    return null
  }
}

export type EvidenceCollectorDeps = {
  db: Db
  secret: string
  registry: ToolRegistry
  runner: ReadOnlyToolRunner
  policy: ToolPolicy
  allowedTools: string[]
  nodeRunId: string
  attempt: number
  executorAgentId: string
  nowAt: () => string
  clock?: ClockProvider
}

// 一条工具调用的宿主执行痕迹：收口时按 execution_id 回查，Agent 自报的结果不参与。
export type ToolTraceEntry = {
  tool: string
  toolSeq: number
  executionId: string
  exitCode: number
  stdoutHash: string
  stderrHash: string
  commandHash: string
}

export class EvidenceCollector {
  private readonly trace: ToolTraceEntry[] = []
  private readonly deps: EvidenceCollectorDeps
  private lastEvidenceValue: StrongEvidence | null = null

  constructor(deps: EvidenceCollectorDeps) {
    this.deps = deps
  }

  get traceEntries(): ToolTraceEntry[] {
    return this.trace.map((entry) => ({ ...entry }))
  }

  get lastEvidence(): StrongEvidence | null {
    return this.lastEvidenceValue ? { ...this.lastEvidenceValue } : null
  }

  // 只接受结构化 tool.call；工具名、cwd、超时都必须重新过服务端策略，不信任 Agent 的清单。
  async collect(raw: unknown): Promise<CollectedToolResult> {
    const call = parseToolCall(raw)
    this.assertAuthorized(call)
    const requestHash = sha256Hex(canonicalJson({
      tool: call.tool, args: call.args, cwd: call.cwd, timeoutMs: call.timeoutMs,
    }))
    const existing = this.readOutbox(call.callId)
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '同一 callId 对应了不同的工具请求', {
          callId: call.callId, expected: existing.request_hash, got: requestHash,
        })
      }
      if (existing.status === 'completed' && existing.result_json) {
        const stored = parseStoredResult(existing.result_json, call.callId)
        if (stored.evidence) this.lastEvidenceValue = { ...stored.evidence }
        if (stored.trace && !this.trace.some((entry) => entry.executionId === stored.trace?.executionId)) {
          this.trace.push({ ...stored.trace })
        }
        return stored
      }
      // 崩溃时可能已经执行了一半：没有完成回执就不许再跑一遍。
      throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '这次工具调用停在不明确的状态，先人工核实，不盲目重跑', {
        callId: call.callId, status: existing.status,
      })
    }
    this.insertPending(call, requestHash)
    try {
      return await this.runAndRecord(call)
    } catch (err) {
      this.markFailed(call.callId, err)
      throw err
    }
  }

  private assertAuthorized(call: ToolCallPayload): void {
    if (!this.deps.allowedTools.includes(call.tool)) {
      throw new OrchError('FORBIDDEN', '工具不在本次节点请求的工具清单里', { tool: call.tool })
    }
    const descriptor = this.deps.registry.require(call.tool)
    if (descriptor.capability !== 'read_only') {
      throw new OrchError('FORBIDDEN', 'Agent 只能请求只读工具', { tool: call.tool, capability: descriptor.capability })
    }
    assertToolsAuthorized(this.deps.registry, this.deps.policy, [{ command: call.tool }])
  }

  private readOutbox(callId: string): OutboxRow | undefined {
    return this.deps.db.raw.prepare(
      'SELECT status, request_hash, result_json FROM bridge_tool_outbox WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ? AND call_id = ?',
    ).get(this.deps.nodeRunId, this.deps.attempt, this.deps.executorAgentId, callId) as OutboxRow | undefined
  }

  private insertPending(call: ToolCallPayload, requestHash: string): void {
    const now = this.deps.nowAt()
    withTx(this.deps.db, (tx) => {
      tx.run(
        'INSERT INTO bridge_tool_outbox (node_run_id, attempt, executor_agent_id, call_id, tool, request_hash, status, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
        [this.deps.nodeRunId, this.deps.attempt, this.deps.executorAgentId, call.callId, call.tool, requestHash, 'pending', now, now],
      )
    })
  }

  private markFailed(callId: string, err: unknown): void {
    const now = this.deps.nowAt()
    try {
      withTx(this.deps.db, (tx) => {
        tx.run(
          'UPDATE bridge_tool_outbox SET status = ?, result_json = ?, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ? AND call_id = ?',
          ['failed', JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), now, this.deps.nodeRunId, this.deps.attempt, this.deps.executorAgentId, callId],
        )
        appendNodeRunEvent(tx, this.deps.secret, this.deps.nodeRunId, 'tool_execution_failed', {
          attempt: this.deps.attempt, call_id: callId, reason: err instanceof Error ? err.message : String(err),
        })
      })
    } catch {
      // 失败证据已经由上层 blocked_post 兜底，这里不再盖第二层错误
    }
  }

  private async runAndRecord(call: ToolCallPayload): Promise<CollectedToolResult> {
    const seq = this.nextToolSeq()
    const executionId = toolExecutionId()
    // 工具起止用真实墙钟；没有注入时钟时才退回节点的量化时刻。
    const startSample = this.deps.clock?.sample()
    const startedAt = startSample ? new Date(startSample.wallClockMs).toISOString() : this.deps.nowAt()
    const descriptor = this.deps.registry.require(call.tool)
    const cwd = resolveInside(this.deps.runner.root, call.cwd)
    const verifier = descriptor.effectVerifier
    const target = verifier && this.loadVerificationTarget()
    withTx(this.deps.db, (tx) => {
      tx.run('UPDATE node_runs SET tool_start_at = ?, updated_at = ? WHERE node_run_id = ?', [startedAt, startedAt, this.deps.nodeRunId])
      appendNodeRunEvent(tx, this.deps.secret, this.deps.nodeRunId, 'tool_started', {
        tool: call.tool,
        attempt: this.deps.attempt,
        tool_seq: seq,
        execution_id: executionId,
        call_id: call.callId,
        started_at: startedAt,
      })
    })
    const out = await this.deps.runner.runTool({
      command: call.tool,
      args: call.args,
      cwd: call.cwd,
      timeoutMs: call.timeoutMs,
      workspaceRoot: this.deps.runner.root,
    })
    const endSample = this.deps.clock?.sample()
    const finishedAt = endSample ? new Date(endSample.wallClockMs).toISOString() : this.deps.nowAt()
    assertCommandHash(
      out.evidence,
      commandHashOf(descriptor.command.bin, descriptor.command.args, cwd, this.deps.runner.root),
    )
    const effectProof = verifier && target && target.workflow_definition_hash === verifier.workflowDefinitionHash
      && target.node_id === verifier.nodeId && cwd === resolveInside(this.deps.runner.root, verifier.cwd ?? '.')
      ? verifyEffectOutput(verifier, target, out) : null
    this.lastEvidenceValue = { ...out.evidence }
    const trace: ToolTraceEntry = {
      tool: call.tool,
      toolSeq: seq,
      executionId,
      exitCode: out.evidence.exitCode,
      stdoutHash: out.evidence.stdoutHash,
      stderrHash: out.evidence.stderrHash,
      commandHash: out.evidence.commandHash,
    }
    this.trace.push(trace)
    const result: CollectedToolResult = {
      callId: call.callId, exitCode: out.evidence.exitCode, stdout: out.stdout, stderr: out.stderr,
      trace, evidence: out.evidence,
    }
    withTx(this.deps.db, (tx) => {
      const activeProof = effectProof && tx.get(
        'SELECT 1 FROM node_runs WHERE node_run_id = ? AND attempt = ? AND action_generation = ?',
        [this.deps.nodeRunId, this.deps.attempt, target?.action_generation],
      ) ? { effect_proof: effectProof } : {}
      tx.run(
        'INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, execution_id, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          this.deps.nodeRunId, this.deps.attempt, seq, call.tool, executionId,
          out.evidence.exitCode, out.evidence.stdoutHash ?? null, out.evidence.stderrHash ?? null,
          out.evidence.commandHash ?? null, startedAt, finishedAt,
        ],
      )
      appendNodeRunEvent(tx, this.deps.secret, this.deps.nodeRunId, 'tool_finished', {
        tool: call.tool,
        attempt: this.deps.attempt,
        tool_seq: seq,
        execution_id: executionId,
        call_id: call.callId,
        exit_code: out.evidence.exitCode,
        stdout_hash: out.evidence.stdoutHash ?? null,
        stderr_hash: out.evidence.stderrHash ?? null,
        command_hash: out.evidence.commandHash ?? null,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ns: startSample && endSample ? Math.max(0, endSample.monotonicNs - startSample.monotonicNs) : null,
        ...activeProof,
      })
      tx.run(
        'UPDATE bridge_tool_outbox SET status = ?, result_json = ?, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ? AND call_id = ?',
        ['completed', JSON.stringify({ result, trace, evidence: out.evidence }), finishedAt, this.deps.nodeRunId, this.deps.attempt, this.deps.executorAgentId, call.callId],
      )
    })
    return result
  }

  private loadVerificationTarget(): VerificationTarget | undefined {
    return this.deps.db.raw.prepare(`SELECT r.workflow_definition_hash,n.node_id,n.node_run_id,n.run_id,n.attempt,n.action_generation
      FROM node_runs n JOIN runs r ON r.run_id = n.run_id WHERE n.node_run_id = ? AND n.attempt = ?
      AND n.side_effect_policy <> 'pure' AND r.workflow_definition_hash IS NOT NULL`)
      .get(this.deps.nodeRunId, this.deps.attempt) as VerificationTarget | undefined
  }

  private nextToolSeq(): number {
    const row = this.deps.db.raw.prepare(
      'SELECT MAX(tool_seq) AS max_seq FROM tool_executions WHERE node_run_id = ? AND attempt = ?',
    ).get(this.deps.nodeRunId, this.deps.attempt) as { max_seq: number | null } | undefined
    return (row?.max_seq ?? 0) + 1
  }
}

function parseToolCall(raw: unknown): ToolCallPayload {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'tool.call 载荷必须是对象', {})
  }
  const p = raw as Record<string, unknown>
  if (typeof p.callId !== 'string' || p.callId.length === 0 || p.callId.length > 200) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'tool.call 缺 callId', {})
  }
  if (typeof p.tool !== 'string' || p.tool.length === 0) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'tool.call 缺工具名', {})
  }
  if (!Array.isArray(p.args) || p.args.some((a) => typeof a !== 'string')) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'tool.call 的 args 必须是字符串数组', {})
  }
  const cwd = typeof p.cwd === 'string' && p.cwd.length > 0 ? p.cwd : '.'
  const timeoutMs = typeof p.timeoutMs === 'number' && Number.isInteger(p.timeoutMs) && p.timeoutMs > 0
    ? p.timeoutMs
    : 30_000
  return { callId: p.callId, tool: p.tool, args: p.args as string[], cwd, timeoutMs }
}

function parseStoredResult(raw: string, callId: string): CollectedToolResult {
  const envelope = JSON.parse(raw) as Record<string, unknown>
  // 兼容旧 outbox 的裸结果；新记录是 { result, trace, evidence }。
  const p = envelope.result && typeof envelope.result === 'object'
    ? envelope.result as Record<string, unknown>
    : envelope
  const trace = envelope.trace && typeof envelope.trace === 'object'
    ? envelope.trace as ToolTraceEntry
    : undefined
  const evidence = envelope.evidence && typeof envelope.evidence === 'object'
    ? envelope.evidence as StrongEvidence
    : undefined
  return {
    callId,
    exitCode: typeof p.exitCode === 'number' ? p.exitCode : -1,
    stdout: typeof p.stdout === 'string' ? p.stdout : '',
    stderr: typeof p.stderr === 'string' ? p.stderr : '',
    trace,
    evidence,
  }
}
