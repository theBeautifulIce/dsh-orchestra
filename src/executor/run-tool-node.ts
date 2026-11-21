import { deadlineFromSample } from '../core/clock.ts'
import { sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { evaluatePassConditions } from '../core/policy.ts'
import { appendNodeRunEvent, assertChainIntact, chainIsIntact, readChain, readChainHead } from '../infra/db/ledger.ts'
import { withTx, makeTx, type Tx } from '../infra/sqlite/driver.ts'
import { assertLeaseValid, loadNodeRun, releaseLease, renewLease } from '../service/commands/lease.ts'
import { applyTransition } from '../service/commands/nodes.ts'
import { acquireNodeRunInTx, type RuntimeDeps } from '../service/commands/runtime.ts'
import { readStrongEvidence } from '../service/queries/evidence.ts'
import { resolvePinnedNodeId } from '../service/rework-extra-steps.ts'
import { requireTrialFlow, requireTrialTool } from '../service/trial-circles.ts'
import { definitionHashOf } from '../service/workflows.ts'
import { EvidenceCollector, parseStoredResult, type CollectedToolResult } from './evidence-collector.ts'
import { DEFAULT_LEASE_RENEW_INTERVAL_MS, type RunNodeDeps, type RunNodeParams, type RunNodeResult } from './run-node.ts'
import { resolveInside } from './tools.ts'

export async function runStandaloneToolNode(deps: RunNodeDeps, p: RunNodeParams): Promise<RunNodeResult> {
  const tx = makeTx(deps.db.raw)
  const node = loadNodeRun(tx, p.nodeRunId)
  const run = tx.get<{ workflow_id: string; workflow_version: string; workflow_definition_hash: string }>(
    'SELECT workflow_id,workflow_version,workflow_definition_hash FROM runs WHERE run_id=?', [node.run_id],
  )
  if (node.node_type !== 'tool' || node.node_id !== p.nodeId || node.attempt !== p.attempt || !run?.workflow_definition_hash) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '独立工具没有可验证的运行绑定')
  }
  if (p.ownerEpoch !== deps.db.epoch) throw new OrchError('STALE_GENERATION', '独立工具只能由当前账本写者执行')
  const def = deps.runtime.catalog.getImmutable(run.workflow_id, run.workflow_version)
  const roleId = resolvePinnedNodeId(tx, p.nodeRunId)
  const role = def.nodes.find(candidate => candidate.node_id === roleId && candidate.type === 'tool')
  if (!role?.tool || definitionHashOf(def) !== run.workflow_definition_hash) {
    throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '独立工具必须执行运行绑定版本中的命令')
  }
  const { command, cwd, timeout_ms } = role.tool
  const descriptor = deps.registry.lookup(command)
  if (descriptor?.capability !== 'read_only' || !deps.runner.readonlyAvailable(command)) {
    return result(p, 'waiting', null, 'tool_host_unavailable')
  }
  deps.cancelSignal?.throwIfAborted()
  const timeoutMs = Math.min(timeout_ms, p.actionTimeoutMs ?? timeout_ms)
  const elapsed = performance.now()
  const nowAt = () => new Date(Date.parse(p.now) + Math.max(0, Math.floor(performance.now() - elapsed))).toISOString()
  const lease = withTx(deps.db, (write) => {
    requireTrialFlow(write, run.workflow_id, run.workflow_definition_hash)
    requireTrialTool(write, command, resolveInside(deps.runner.root, cwd), descriptor.capability, p.nodeRunId)
    const granted = acquireNodeRunInTx(write, deps.runtime, p)
    applyTransition(write, deps.secret, { nodeRunId: p.nodeRunId, from: ['dispatched'], to: 'started', ruleId: 'M-04',
      attempt: p.attempt, now: p.now, patch: { side_effect_policy: 'pure', side_effect_verified_none: 1 } })
    return granted
  })
  let leaseLost = false
  const heartbeat = setInterval(() => {
    if (leaseLost) return
    try {
      withTx(deps.db, write => renewLease(write, { nodeRunId: p.nodeRunId, leaseTtlMs: p.leaseTtlMs, now: nowAt(),
        attempt: p.attempt, leaseId: lease.lease_id, ownerEpoch: p.ownerEpoch }))
    } catch {
      leaseLost = true
    }
  }, p.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS)
  heartbeat.unref?.()
  try {
    const collector = new EvidenceCollector({
      db: deps.db, secret: deps.secret, registry: deps.registry, runner: deps.runner,
      policy: { allow: [command], declaredPolicy: 'pure' }, allowedTools: [command],
      nodeRunId: p.nodeRunId, attempt: p.attempt, executorAgentId: 'standalone:' + p.nodeRunId,
      lease, nowAt, clock: deps.runtime.clock, standalone: { signal: deps.cancelSignal },
    })
    const output = await collector.collect({ callId: 'standalone', tool: command, args: descriptor.command.args, cwd, timeoutMs })
    if (leaseLost) throw new OrchError('LEASE_EXPIRED', '工具执行完成时租约已经丢失')
    const status = withTx(deps.db, (write) => finishTool(write, deps.runtime, p, lease, output, run, roleId, command, nowAt()))
    return result(p, status, output.evidence ?? null)
  } catch (error) {
    const finalStatus = withTx(deps.db, (write) => settleToolError(write, deps, p, lease, error, nowAt()))
    return result(p, finalStatus, null, error instanceof OrchError ? error.code : 'tool_result_unavailable')
  } finally {
    clearInterval(heartbeat)
  }
}

function result(p: RunNodeParams, final_status: string, evidence: RunNodeResult['evidence'], reason?: string): RunNodeResult {
  return { node_run_id: p.nodeRunId, final_status, evidence, agent_id: '', reason }
}

type Lease = { lease_id: string; action_generation: number }

function finishTool(tx: Tx, runtime: RuntimeDeps, p: Pick<RunNodeParams, 'nodeRunId' | 'attempt'>, lease: Lease, output: CollectedToolResult,
  run: { workflow_id: string; workflow_version: string }, roleId: string, command: string, now: string, recovered = false): 'done' | 'failed' {
  const current = loadNodeRun(tx, p.nodeRunId)
  if (current.attempt !== p.attempt || current.action_generation !== lease.action_generation || current.lease_id !== lease.lease_id || current.status !== 'started') {
    throw new OrchError('STALE_GENERATION', '工具结果已失去本次运行授权')
  }
  if (!recovered) assertLeaseValid(current, now)
  const trace = output.trace
  const evidence = output.evidence
  if (!trace || !evidence || evidence.source !== 'run_tool' || !Number.isInteger(evidence.exitCode)) {
    throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '独立工具没有退出码和宿主执行收据')
  }
  const { item: recorded } = readStrongEvidence(tx, runtime.secret, trace.executionId)
  if (recorded.node_run_id !== p.nodeRunId || recorded.attempt !== p.attempt || recorded.tool !== command
      || recorded.exit_code !== output.exitCode || recorded.exit_code !== evidence.exitCode
      || recorded.stdout_hash !== sha256Hex(output.stdout) || recorded.stderr_hash !== sha256Hex(output.stderr)
      || recorded.execution_boundary !== evidence.boundary
      || recorded.command_hash !== trace.commandHash
      || !chainIsIntact(runtime.secret, readChain(tx, p.nodeRunId), readChainHead(tx, p.nodeRunId), true)) {
    throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '独立工具的结果未绑定到有效执行收据')
  }
  const policy = runtime.catalog.policyFor(run.workflow_id, run.workflow_version, roleId)
  const verdict = evaluatePassConditions(policy.passConditions, { ...evidence, exitCode: recorded.exit_code,
    stdoutHash: recorded.stdout_hash, stderrHash: recorded.stderr_hash, producedAt: recorded.observed_at,
    hashes: { stdout: recorded.stdout_hash, stderr: recorded.stderr_hash },
  })
  const cancelled = tx.get('SELECT 1 FROM runs WHERE run_id=? AND cancel_requested_at IS NOT NULL', [current.run_id])
    || tx.get('SELECT 1 FROM node_runs WHERE node_run_id=? AND cancel_requested_at IS NOT NULL', [p.nodeRunId])
  const next = !cancelled && evidence.exitCode === 0 && verdict.pass ? 'done' : 'failed'
  applyTransition(tx, runtime.secret, { nodeRunId: p.nodeRunId, from: ['started'], to: 'verifying', ruleId: 'M-15', attempt: p.attempt, now })
  applyTransition(tx, runtime.secret, { nodeRunId: p.nodeRunId, from: ['verifying'], to: next, ruleId: 'M-16', attempt: p.attempt, now,
    patch: { side_effect_policy: 'pure', side_effect_verified_none: 1 } })
  releaseLease(tx, { nodeRunId: p.nodeRunId, now })
  appendNodeRunEvent(tx, runtime.secret, p.nodeRunId, 'tool.completed', {
    execution_id: recorded.evidence_id, tool: recorded.tool, status: next, exit_code: recorded.exit_code, command_hash: recorded.command_hash,
  })
  if (next === 'done') {
    const payload = { exit_code: recorded.exit_code, stdout_hash: recorded.stdout_hash, stderr_hash: recorded.stderr_hash,
      ...(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) <= 65_536 ? { stdout: output.stdout, stderr: output.stderr } : {}) }
    appendNodeRunEvent(tx, runtime.secret, p.nodeRunId, 'workflow.output', payload)
  }
  return next
}

/** A previous writer may have committed strong evidence immediately before stopping. Reuse only that receipt. */
export function recoverStandaloneToolResults(tx: Tx, runtime: RuntimeDeps, now: string): void {
  const recoverable = tx.all<{ node_run_id: string; attempt: number; lease_id: string; action_generation: number;
    workflow_id: string; workflow_version: string; workflow_definition_hash: string; result_json: string }>(`
    SELECT n.node_run_id,n.attempt,n.lease_id,n.action_generation,r.workflow_id,r.workflow_version,r.workflow_definition_hash,o.result_json
    FROM node_runs n JOIN runs r ON r.run_id=n.run_id JOIN bridge_tool_outbox o ON o.node_run_id=n.node_run_id AND o.attempt=n.attempt
      AND o.executor_agent_id='standalone:' || n.node_run_id AND o.call_id='standalone' AND o.status='completed'
    WHERE n.node_type='tool' AND n.status='started' AND n.owner_epoch<>? AND n.lease_id IS NOT NULL`, [runtime.db.epoch])
  for (const item of recoverable) {
    tx.exec('SAVEPOINT tool_recovery')
    try {
      const definition = runtime.catalog.getImmutable(item.workflow_id, item.workflow_version)
      const roleId = resolvePinnedNodeId(tx, item.node_run_id)
      const tool = definition.nodes.find(node => node.node_id === roleId && node.type === 'tool')?.tool
      if (!tool || definitionHashOf(definition) !== item.workflow_definition_hash) throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '运行绑定的工具定义不可用')
      const output = parseStoredResult(item.result_json, 'standalone')
      finishTool(tx, runtime, { nodeRunId: item.node_run_id, attempt: item.attempt }, item, output, item, roleId, tool.command, now, true)
    } catch {
      // Missing or invalid receipts are handled by the existing lease expiry and unknown-start path.
      tx.exec('ROLLBACK TO tool_recovery')
    } finally {
      tx.exec('RELEASE tool_recovery')
    }
  }
}

function settleToolError(tx: Tx, deps: RunNodeDeps, p: RunNodeParams, lease: Lease, error: unknown, now: string): string {
  const current = loadNodeRun(tx, p.nodeRunId)
  if (current.attempt !== p.attempt || current.action_generation !== lease.action_generation || current.lease_id !== lease.lease_id || current.status !== 'started') return current.status
  assertChainIntact(tx, deps.secret, p.nodeRunId)
  const started = tx.get("SELECT 1 FROM node_run_events WHERE node_run_id=? AND type='tool_started'", [p.nodeRunId])
  const watchdog = started ? deadlineFromSample(deps.runtime.clock, 120_000) : null
  const next = started ? 'startup_unknown' : 'failed'
  applyTransition(tx, deps.secret, { nodeRunId: p.nodeRunId, from: ['started'], to: next, ruleId: started ? 'M-05' : 'M-48', attempt: p.attempt, now,
    patch: watchdog ? { startup_unknown_deadline_at: new Date(watchdog.wallClockMs).toISOString(), startup_unknown_boot_id: watchdog.bootId,
      startup_unknown_monotonic_ns: watchdog.monotonicNs, startup_unknown_remaining_ns: 120_000_000_000 } : {} })
  releaseLease(tx, { nodeRunId: p.nodeRunId, now })
  appendNodeRunEvent(tx, deps.secret, p.nodeRunId, 'tool.unsettled', {
    status: next, phase: started ? 'started_without_result' : 'before_start', reason: error instanceof OrchError ? error.code : 'tool_result_unavailable',
  })
  return next
}
