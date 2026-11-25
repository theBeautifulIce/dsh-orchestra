// src/service/sweep.ts —— 维护扫描（规格 4.9 行 426-429）
import type { Db, Tx } from '../infra/sqlite/driver.ts'
import { inTx } from '../infra/db/tx.ts'
import { reanchorInTx, refreshCheckpointsInTx, type ReanchorReport } from './clock-recovery.ts'
import { loadNodeRun, sweepExpiredLeases } from './commands/lease.ts'
import { pauseMemoryWrite } from './commands/memory-recovery.ts'
import { pickReplayHead, revokeFence, type FenceRow } from './commands/cancel.ts'
import { transitionNode } from './commands/node-state.ts'
import { applyTransition } from './commands/nodes.ts'
import { applyReport } from './commands/apply-report.ts'
import { sweepWaitTimeouts } from './commands/wait.ts'
import { finishSubworkflowChild } from './commands/subworkflow.ts'
import { closeRun } from './commands/run-close.ts'
import { activeDecision, openDecision, sweepDecisions } from './commands/decisions.ts'
import { openOrdinaryRecoveryDecision, ordinaryRecoveryTarget, reconcileCancelledAgent, retireOrdinaryStartupDecision, type OrdinaryRecoveryCard } from './decision/ordinary-recovery.ts'
import { IN_FLIGHT_COMMAND_STATUSES } from './commands/idempotency.ts'
import { receiptRetention } from './receipt-retention.ts'
import type { WorkflowCatalog } from './workflows.ts'
import type { Report } from '../core/report.ts'
import { chainIsIntact, readChain, appendNodeRunEvent, type ChainPosition } from '../infra/db/ledger.ts'
import { canTransition, isTerminal, type NodeStatus } from '../core/state-machine.ts'
import { uuidv7 } from '../core/ids.ts'
import type { ClockProvider, Deadline } from '../core/clock.ts'
import { deadlineFromAnchors, deadlineFromSample } from '../core/clock.ts'

export type SweepParams = {
  now: string
  clock: ClockProvider
  ordinaryRecovery?: boolean
  // 运行时观察到的桥断节点：只有拿到显式信号才挂起，不猜
  bridgeMissing?: readonly string[]
  // 桥恢复信号：按 resume_state 逐态重入，重挂剩余预算，不把未知态续成满额
  bridgeRestored?: readonly string[]
  // 运行时确认执行器已失联的节点：只按显式信号置 orphaned 候选，不猜
  executorLost?: readonly string[]
  // 围栏撤销后重放队头需要按 run 绑定的工作流取判定策略
  catalog?: WorkflowCatalog
}

export type SweepResult = {
  lease_expired: string[]
  fence_revoked: string[]
  // 判定时限到点、超时转阻塞的节点（规格 4.4 行 333）
  verify_timed_out: string[]
  // 时钟不确定（漂移超差、跨 boot、没有判定锚点）转阻塞的节点：宁可等人来看，也不自动判超时（规格 3.4 行 171）
  verify_uncertain: string[]
  // 围栏撤销后该重放的队头；S3 接上决定重放后由决策循环消费
  replay_heads: { node_run_id: string; report_id: string; report_seq: number }[]
  // 哈希链断裂的节点：整轮扫描跳过，绝不写坏账本
  chain_broken: string[]
  // startup_unknown 钟到点后转 indeterminate_side_effect
  startup_unknown_expired: string[]
  // 显式桥断信号置 paused_bridge_missing
  bridge_paused: string[]
  // 显式桥恢复信号按 resume_state 重入
  bridge_restored: string[]
  // wait 到点由同一轮维护扫描收口，不再依赖调用方另起一轮
  wait_timed_out: number
  // 显式执行器失联信号置 orphaned
  executor_orphaned: string[]
  // 动作时限到点生成 action_overrun 裁决卡（不改状态）
  action_overrun: string[]
  // 在途命令超时收成 rejected；回执过期清掉 receipt_json
  operations_timed_out: number
  receipts_expired: number
  // 子 run 已收口但父节点还挂在 waiting/timing_out/stopping：由维护扫描推进父节点
  subworkflow_finished: string[]
  // 决策卡超时：满 2 小时升级，升级后再等 24 小时；到期连带放掉 blocked_pre 节点
  decisions_blocked: number
  decisions_expired: number
  decisions_released_nodes: string[]
  // 换算不出来的截止锚点：保留原数据、已落 timer_uncertain，宿主可查
  deadline_uncertain: string[]
  // 本轮扫描把“所有节点已终态”的运行推进到 run 终态
  runs_closed: string[]
  scanned_at: string
}

type VerifyRow = {
  node_run_id: string
  attempt: number
  revision: number
  verify_deadline_at: string | null
  verify_deadline_boot_id: string | null
  verify_deadline_monotonic_ns: number | null
}

type SweepChain = { node_run_id: string } & (ChainPosition | { [K in keyof ChainPosition]: null })

// 扫描必须可重入：重复跑不会产生第二份副作用
export function sweep(db: Db, secret: string, params: SweepParams): SweepResult {
  return inTx(db, (tx) => {
    // 恢复前先验链：断链节点整轮跳过，恢复动作不许把坏账本再往前推
    const broken = new Set<string>()
    const chains = tx.all<SweepChain>('SELECT n.node_run_id, h.last_seq, h.last_hash, h.event_count FROM node_runs n '
      + 'LEFT JOIN node_run_chain_heads h ON h.node_run_id = n.node_run_id')
    // A persisted child proves its parent reached the control step and had a chain.
    const parentsWithChildren = new Set(tx.all<{ node_run_id: string }>(
      'SELECT n.node_run_id FROM runs r JOIN node_runs n ON n.node_run_id = r.parent_node_run_id AND n.run_id = r.parent_run_id '
      + 'WHERE r.parent_node_run_id IS NOT NULL',
    ).map((row) => row.node_run_id))
    for (const row of chains) {
      const head = row.last_seq === null ? undefined : row
      if (!chainIsIntact(secret, readChain(tx, row.node_run_id), head, parentsWithChildren.has(row.node_run_id))) {
        broken.add(row.node_run_id)
      }
    }
    // 先把上个 boot 写下的锚点换算到当前时钟：不换算的话 decide() 只会返回 uncertain，
    // fence / wait / 动作截止会永久停住（规格 4.4 行 342）。
    // 已标不确定的节点不再自动推进：等宿主或人工确认（评审 P1-2）
    const uncertainNodes = new Set<string>(
      tx.all<{ node_run_id: string }>("SELECT node_run_id FROM node_runs WHERE recovery_uncertain IS NOT NULL").map((r) => r.node_run_id),
    )
    const skipNodes = new Set<string>([...broken, ...uncertainNodes])
    // 含断链/不确定节点的 run：不按其中节点的状态收口（评审 P1-1）
    const taintedRuns = new Set<string>(
      tx.all<{ run_id: string }>(
        `SELECT DISTINCT run_id FROM node_runs WHERE node_run_id IN (${[...skipNodes].map(() => '?').join(',') || "''"})`,
        [...skipNodes],
      ).map((r) => r.run_id),
    )
    const reanchor: ReanchorReport = { reanchored: [], expired: [], uncertain: [] }
    if (params.clock) {
      // 服务存活时先把剩余预算按单调钟递减落库：重启后靠它续算，墙钟不参与判定
      refreshCheckpointsInTx(tx, params.clock)
      reanchorInTx(tx, secret, params.clock, params.now, reanchor, skipNodes)
    }
    // wait 到点与租约、围栏同轮处理：同一个扫描入口，不靠外部再记得调一次
    const waitTimedOut = sweepWaitTimeouts(tx, secret, params.now, params.clock, skipNodes, taintedRuns)
    const governedClaims = tx.all<{ batch_id: string; node_run_id: string; lease_expires_at: string | null; status: string }>(
      "SELECT b.batch_id, n.node_run_id, n.lease_expires_at, b.status FROM memory_batches b " +
      "JOIN node_runs n ON n.node_run_id = b.apply_node_run_id JOIN runs r ON r.run_id = n.run_id " +
      "WHERE b.status IN ('applying','applied') AND n.status = 'started' AND r.status IN ('running','settling','paused')",
    )
    const expiredMemory: string[] = []
    for (const claim of governedClaims) {
      if (skipNodes.has(claim.node_run_id)) continue
      skipNodes.add(claim.node_run_id)
      if (claim.status === 'applying' && claim.lease_expires_at && claim.lease_expires_at <= params.now) {
        pauseMemoryWrite(tx, secret, loadNodeRun(tx, claim.node_run_id), claim.batch_id, params.now)
        expiredMemory.push(claim.node_run_id)
      }
    }
    const leaseExpired = [...expiredMemory, ...sweepExpiredLeases(tx, secret, {
      now: params.now, leaseTtlMs: 0, skipNodeRunIds: skipNodes, clock: params.clock,
    })]
    // 围栏宽限到点：撤围栏回 stopping，并把当前 attempt 的队头挑出来（规格 4.5 行 346）
    const fences = tx.all<FenceRow>(
      'SELECT node_run_id, attempt, revision, status, rearm_generation, fence_state, fence_grace_until, fence_grace_boot_id, fence_grace_monotonic_ns FROM node_runs WHERE fence_state = ? AND fence_grace_until IS NOT NULL',
      ['armed'],
    )
    const revoked: string[] = []
    const heads: SweepResult['replay_heads'] = []
    for (const row of fences) {
      // 断链节点整轮跳过：恢复动作不许把坏账本再往前推（S2/S3 r64 P1-1）
      if (skipNodes.has(row.node_run_id)) continue
      if (!revokeFence(tx, secret, { row, now: params.now, clock: params.clock })) continue
      revoked.push(row.node_run_id)
      const head = pickReplayHead(tx, row.node_run_id, row.attempt)
      if (head) {
        heads.push({ node_run_id: row.node_run_id, report_id: head.report_id, report_seq: head.report_seq })
        if (params.catalog) replayQueued(tx, secret, row.node_run_id, head.report_id, row.attempt, params.now, params.catalog)
      }
    }
    // 判定时限：只读 boot_id 与单调纳秒，墙钟只用于展示（规格 3.4 行 171、12.3 行 1066）
    const timedOut: string[] = []
    const uncertain: string[] = []
    const verifying = tx.all<VerifyRow>(
      'SELECT node_run_id, attempt, revision, verify_deadline_at, verify_deadline_boot_id, verify_deadline_monotonic_ns FROM node_runs WHERE status = ? AND verify_deadline_at IS NOT NULL',
      ['verifying'],
    )
    for (const row of verifying) {
      if (skipNodes.has(row.node_run_id)) continue
      const deadline = verifyDeadline(row)
      // 没有判定锚点就没有判定依据：按不确定处理，不拿墙钟硬比（规格 3.4 行 171）
      if (!deadline || !params.clock) {
        if (blockVerifying(tx, secret, row, params.now, 'timer_uncertain', ['verify_deadline_anchor_missing'])) {
          uncertain.push(row.node_run_id)
        }
        continue
      }
      const decision = params.clock.decide(deadline)
      if (decision.kind === 'pending') continue
      if (decision.kind === 'expired') {
        if (blockVerifying(tx, secret, row, params.now, 'verify_timeout', [])) timedOut.push(row.node_run_id)
        continue
      }
      if (blockVerifying(tx, secret, row, params.now, 'timer_uncertain', [decision.reason])) {
        uncertain.push(row.node_run_id)
      }
    }
    // startup_unknown 按钟：到点转 indeterminate_side_effect，保留 uncertainty，不直接判终态
    const unknownExpired: string[] = []
    const unknownRows = tx.all<{ node_run_id: string; run_id: string; attempt: number; status: string; hang_reason: string | null; startup_unknown_deadline_at: string | null; startup_unknown_boot_id: string | null; startup_unknown_monotonic_ns: number | null; startup_unknown_remaining_ns: number | null }>(
      'SELECT node_run_id, run_id, attempt, status, hang_reason, startup_unknown_deadline_at, startup_unknown_boot_id, startup_unknown_monotonic_ns, startup_unknown_remaining_ns FROM node_runs WHERE status = ?',
      ['startup_unknown'],
    )
    for (const row of unknownRows) {
      if (skipNodes.has(row.node_run_id) || row.hang_reason !== null) continue
      if (!row.startup_unknown_deadline_at) continue
      const anchored = deadlineFromAnchors({
        deadlineAt: row.startup_unknown_deadline_at,
        bootId: row.startup_unknown_boot_id,
        monotonicNs: row.startup_unknown_monotonic_ns,
      })
      // 有锚点只看单调钟；缺锚点的旧行不能拿墙钟硬判超时，直接按“不确定”收口。
      if (anchored && params.clock) {
        const decision = params.clock.decide(anchored)
        if (decision.kind === 'pending') {
          if (params.ordinaryRecovery && Number.isSafeInteger(row.startup_unknown_remaining_ns) && row.startup_unknown_remaining_ns! > 0) {
            openOrdinaryRecoveryDecision(tx, secret, row.node_run_id, 'startup_unknown', params.now)
          }
          continue
        }
        if (decision.kind === 'uncertain') continue
      }
      try {
        applyTransition(tx, secret, {
          nodeRunId: row.node_run_id,
          from: ['startup_unknown'],
          to: 'indeterminate_side_effect',
          attempt: row.attempt,
          now: params.now,
          bumpRearm: true,
          patch: {
            startup_unknown_deadline_at: null,
            startup_unknown_remaining_ns: null,
            startup_unknown_boot_id: null,
            startup_unknown_monotonic_ns: null,
          },
        })
        appendNodeRunEvent(tx, secret, row.node_run_id, 'recovery.startup_unknown_expired', {
          from: 'startup_unknown',
          to: 'indeterminate_side_effect',
          deadline_at: row.startup_unknown_deadline_at,
        })
        unknownExpired.push(row.node_run_id)
        if (params.ordinaryRecovery) retireOrdinaryStartupDecision(tx, secret, row.node_run_id, params.now, 'expired_final')
      } catch {
        // 并发流程已经改过这一行：跳过
      }
    }

    // 显式桥断信号：只挂起，不猜副作用；resume_state 留给桥恢复时按原状态继续
    const bridgePaused: string[] = []
    for (const nodeRunId of new Set(params.bridgeMissing ?? [])) {
      if (skipNodes.has(nodeRunId)) continue
      const row = tx.get<{ attempt: number; status: string; hang_reason: string | null }>(
        'SELECT attempt, status, hang_reason FROM node_runs WHERE node_run_id = ?',
        [nodeRunId],
      )
      if (!row || recoverySkip(row)) continue
      try {
        applyTransition(tx, secret, {
          nodeRunId,
          from: [row.status as NodeStatus],
          to: 'paused_bridge_missing',
          attempt: row.attempt,
          now: params.now,
          bumpRearm: true,
          patch: { resume_state: row.status },
        })
        appendNodeRunEvent(tx, secret, nodeRunId, 'recovery.bridge_missing', {
          from: row.status,
          to: 'paused_bridge_missing',
          resume_state: row.status,
        })
        if (params.ordinaryRecovery && row.status === 'startup_unknown') {
          retireOrdinaryStartupDecision(tx, secret, nodeRunId, params.now, 'cancelled')
        }
        bridgePaused.push(nodeRunId)
      } catch {
        // 并发流程已经改过这一行：跳过
      }
    }

    // 显式桥恢复信号：按 resume_state 回到六态之一；startup_unknown/verifying 按剩余预算重挂，不续满额
    const bridgeRestored: string[] = []
    for (const nodeRunId of new Set(params.bridgeRestored ?? [])) {
      if (skipNodes.has(nodeRunId)) continue
      const row = tx.get<{
        attempt: number; status: string; resume_state: string | null; rearm_generation: number
        startup_unknown_remaining_ns: number | null; verify_remaining_ns: number | null
      }>(
        'SELECT attempt, status, resume_state, rearm_generation, startup_unknown_remaining_ns, verify_remaining_ns FROM node_runs WHERE node_run_id = ?',
        [nodeRunId],
      )
      if (!row || row.status !== 'paused_bridge_missing' || !row.resume_state) continue
      const target = row.resume_state as NodeStatus
      if (!canTransition('paused_bridge_missing', target)) continue
      const patch: Record<string, string | number | null> = { resume_state: null }
      if (target === 'startup_unknown') {
        // remaining_ns 是纳秒（node-state 写入）：换算成毫秒再重挂
        const remaining = (row.startup_unknown_remaining_ns ?? 120_000 * 1e6) / 1e6
        const d = params.clock
          ? deadlineFromSample(params.clock, remaining)
          : { bootId: null, monotonicNs: null, wallClockMs: Date.parse(params.now) + remaining }
        patch.startup_unknown_deadline_at = new Date(d.wallClockMs).toISOString()
        patch.startup_unknown_boot_id = d.bootId
        patch.startup_unknown_monotonic_ns = d.monotonicNs
        // 立刻把新预算写成检查点：只清空的话，紧接着再重启一次就没有可信剩余了（S1 r67 P2-2）
        patch.startup_unknown_remaining_ns = Math.round(remaining * 1e6)
      }
      if (target === 'verifying') {
        // 断线期间没记下剩余量，恢复时不能按 0 立即到期，给完整一轮判定窗口。
        // remaining_ns 是纳秒：换算成毫秒再重挂
        const remaining = (row.verify_remaining_ns ?? 120_000 * 1e6) / 1e6
        const d = params.clock
          ? deadlineFromSample(params.clock, remaining)
          : { bootId: null, monotonicNs: null, wallClockMs: Date.parse(params.now) + remaining }
        patch.verify_started_at = params.now
        patch.verify_deadline_at = new Date(d.wallClockMs).toISOString()
        patch.verify_deadline_boot_id = d.bootId
        patch.verify_deadline_monotonic_ns = d.monotonicNs
        patch.verify_remaining_ns = Math.round(remaining * 1e6)
      }
      try {
        applyTransition(tx, secret, {
          nodeRunId,
          from: ['paused_bridge_missing'],
          to: target,
          attempt: row.attempt,
          now: params.now,
          bumpRearm: true,
          rearmGeneration: row.rearm_generation,
          patch,
        })
        appendNodeRunEvent(tx, secret, nodeRunId, 'recovery.bridge_restored', {
          resume_state: target,
          rearm_generation: row.rearm_generation + 1,
        })
        bridgeRestored.push(nodeRunId)
      } catch {
        // 并发已改这一行：跳过
      }
    }

    if (params.ordinaryRecovery) {
      const cancelled = tx.all<{ node_run_id: string }>(`SELECT n.node_run_id FROM node_runs n JOIN runs r USING(run_id)
        WHERE n.status IN ('blocked_post','stopping') AND n.node_type='agent' AND r.status IN ('running','paused')
          AND r.cancel_requested_at IS NOT NULL AND n.blocked_decision_id IS NULL AND n.replacement_node_run_id IS NULL
          AND (n.hang_reason IS NULL OR n.hang_reason='action_overrun')`)
      for (const { node_run_id } of cancelled) {
        if (!skipNodes.has(node_run_id)) reconcileCancelledAgent(tx, secret, node_run_id, params.now, params.clock)
      }
    }
    // A confirmed cancellation above takes precedence over the observation timer.
    // An expired timer alone opens a decision and leaves the underlying outcome unknown.
    const actionOverrun: string[] = []
    const actionRows = tx.all<ActionDeadlineRow>(
      'SELECT node_run_id, run_id, attempt, revision, status, deadline_at, deadline_boot_id, deadline_monotonic_ns FROM node_runs WHERE status = ? AND deadline_at IS NOT NULL AND hang_reason IS NULL',
      ['stopping'],
    )
    for (const row of actionRows) {
      if (skipNodes.has(row.node_run_id)) continue
      const anchored = deadlineFromAnchors({
        deadlineAt: row.deadline_at,
        bootId: row.deadline_boot_id,
        monotonicNs: row.deadline_monotonic_ns,
      })
      // 没有单调钟就判「不确定」，不回退墙钟：墙钟跳变会把长动作误判成超时（S2 第 59 轮 P2-2）。
      const expired = anchored !== null && params.clock !== undefined
        && params.clock.decide(anchored).kind === 'expired'
      if (!expired) continue
      const existing = activeDecision(tx, row.run_id, 'action_overrun', row.node_run_id)
      if (existing) {
        const card = params.ordinaryRecovery && tx.get<OrdinaryRecoveryCard>(
          'SELECT decision_id,run_id,node_run_id,kind,payload_json FROM decisions WHERE decision_id=?', [existing.decision_id])
        if (!card || !ordinaryRecoveryTarget(tx, card)) continue
      }
      const decisionId = existing?.decision_id ?? 'dec_' + uuidv7()
      if (!existing && !(params.ordinaryRecovery && openOrdinaryRecoveryDecision(tx, secret, row.node_run_id, 'action_overrun', params.now, decisionId))) openDecision(tx, {
        decisionId,
        runId: row.run_id,
        nodeRunId: row.node_run_id,
        kind: 'action_overrun',
        payload: { deadline_at: row.deadline_at, status: row.status, attempt: row.attempt },
        createdAt: params.now,
      })
      // 只挂卡、不改状态：裁决后再由迁移表走 M-32/M-35/M-36 等出口
      tx.run(
        'UPDATE node_runs SET hang_reason = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND status = ? AND revision = ? AND hang_reason IS NULL',
        ['action_overrun', params.now, row.node_run_id, row.status, row.revision],
      )
      appendNodeRunEvent(tx, secret, row.node_run_id, 'recovery.action_overrun', {
        decision_id: decisionId,
        deadline_at: row.deadline_at,
      })
      actionOverrun.push(row.node_run_id)
    }

    // 显式执行器失联信号：置 orphaned 候选，不替人判断副作用是否存在
    const executorOrphaned: string[] = []
    for (const nodeRunId of new Set(params.executorLost ?? [])) {
      if (skipNodes.has(nodeRunId)) continue
      const row = tx.get<{ attempt: number; status: string; hang_reason: string | null }>(
        'SELECT attempt, status, hang_reason FROM node_runs WHERE node_run_id = ?',
        [nodeRunId],
      )
      if (!row || !EXECUTOR_BOUND.includes(row.status)) continue
      try {
        applyTransition(tx, secret, {
          nodeRunId,
          from: [row.status as NodeStatus],
          to: 'orphaned',
          attempt: row.attempt,
          now: params.now,
          bumpRearm: true,
          allowHung: true,
          patch: { lease_id: null, lease_expires_at: null, hang_reason: null },
        })
        appendNodeRunEvent(tx, secret, nodeRunId, 'recovery.executor_lost', {
          from: row.status,
          to: 'orphaned',
        })
        executorOrphaned.push(nodeRunId)
      } catch {
        // 并发已改这一行：跳过
      }
    }

    const subworkflowFinished: string[] = []
    const finishedChildren = tx.all<{ run_id: string; parent_run_id: string | null; parent_node_run_id: string }>(
      'SELECT r.run_id, r.parent_run_id, r.parent_node_run_id FROM runs r JOIN node_runs n ON n.node_run_id = r.parent_node_run_id '
      // 父节点已取消/超时的也要看：子 run 后收口时要把未核实事实回填，不能让父 run 冒充干净成功
      + "WHERE r.parent_node_run_id IS NOT NULL AND n.status IN ('waiting', 'timing_out', 'stopping', 'superseded', 'timeout', 'failed', 'failed_with_unverified') AND r.status IN "
      + "('succeeded', 'succeeded_with_unverified', 'done', 'failed', 'failed_with_unverified', 'timeout', 'abandoned_unverified', 'orphaned', 'superseded', 'cancelled')",
    )
    for (const child of finishedChildren) {
      // 父节点链已断：不推进父节点、不追加父节点事件
      if (skipNodes.has(child.parent_node_run_id)) continue
      // 子 run 自己含断链节点：不拿它的状态推父节点，也不收口父 run
      if (taintedRuns.has(child.run_id)) continue
      if (taintedRuns.has(child.parent_run_id ?? '')) continue
      try {
        const out = finishSubworkflowChild(tx, secret, { childRunId: child.run_id, now: params.now })
        if (out.status !== 'waiting') subworkflowFinished.push(out.parentNodeRunId)
        if (child.parent_run_id) closeRun(tx, secret, child.parent_run_id, params.now)
      } catch {
        // 并发已推进这个父节点：跳过，不把整轮扫描拖垮
      }
    }

    const receipts = sweepInboxReceipts(tx, params.now)
    if (params.ordinaryRecovery) {
      for (const row of tx.all<{ node_run_id: string }>("SELECT node_run_id FROM node_runs WHERE status='indeterminate_side_effect' AND node_type='agent' AND hang_reason IS NULL")) {
        if (!skipNodes.has(row.node_run_id)) openOrdinaryRecoveryDecision(tx, secret, row.node_run_id, 'verify_human', params.now)
      }
    }
    // 决策超时：2h 升级、24h 按默认动作过期。必须进维护扫描，
    // 否则服务每两秒扫一次租约/Wait，却永远不处理挂在人身上的卡（审计 P1-3）。
    const decisions = sweepDecisions(tx, secret, { now: params.now, skipNodeRunIds: skipNodes, skipRunIds: taintedRuns })
    // 控制节点链路不依赖宿主再发一次空 dispatch：每轮扫描对“节点全终态”的 run 统一收口。
    const runsClosed: string[] = []
    for (const row of tx.all<{ run_id: string }>("SELECT run_id FROM runs WHERE status = 'running' ORDER BY run_id")) {
      if (taintedRuns.has(row.run_id)) continue
      if (closeRun(tx, secret, row.run_id, params.now)) runsClosed.push(row.run_id)
    }

    return {
      deadline_uncertain: reanchor.uncertain,
      lease_expired: leaseExpired,
      fence_revoked: revoked,
      verify_timed_out: timedOut,
      verify_uncertain: uncertain,
      replay_heads: heads,
      chain_broken: [...broken],
      startup_unknown_expired: unknownExpired,
      bridge_paused: bridgePaused,
      bridge_restored: bridgeRestored,
      wait_timed_out: waitTimedOut,
      executor_orphaned: executorOrphaned,
      action_overrun: actionOverrun,
      operations_timed_out: receipts.timedOut,
      receipts_expired: receipts.expired,
      subworkflow_finished: subworkflowFinished,
      decisions_blocked: decisions.blocked,
      decisions_expired: decisions.expired,
      decisions_released_nodes: decisions.releasedNodes,
      runs_closed: runsClosed,
      scanned_at: params.now,
    }
  })
}

// 围栏撤销后重放队头：报告原文在 report_rejected 事件里，registry 只用来排队。
// 只重放当前 attempt 的队头；失败就留在队列，等下一轮扫描或人工处理。
function replayQueued(
  tx: Tx,
  secret: string,
  nodeRunId: string,
  reportId: string,
  attempt: number,
  now: string,
  catalog: WorkflowCatalog,
): void {
  try {
    const events = tx.all<{ payload: string }>(
      "SELECT payload FROM node_run_events WHERE node_run_id = ? AND type = 'report_rejected' ORDER BY seq DESC",
      [nodeRunId],
    )
    let report: Report | undefined
    for (const ev of events) {
      try {
        const body = JSON.parse(ev.payload) as { report_id?: string; report?: Report }
        if (body.report_id === reportId && body.report) {
          report = body.report
          break
        }
      } catch {
        // 坏事件跳过，不能让一整轮扫描被一条脏 payload 拖死
      }
    }
    if (!report) return
    const row = tx.get<{ status: string; action_generation: number; attempt: number }>(
      'SELECT status, action_generation, attempt FROM node_runs WHERE node_run_id = ?',
      [nodeRunId],
    )
    if (!row || row.attempt !== attempt || row.status !== 'stopping') return
    applyReport(tx, secret, {
      nodeRunId,
      attempt,
      report,
      expectedStatus: 'stopping',
      generation: row.action_generation,
      now,
    }, catalog)
  } catch {
    // 重放被拒：registry 仍是 rejected，下一轮还可以再试；不把围栏撤销回滚
  }
}


type ActionDeadlineRow = {
  node_run_id: string
  run_id: string
  attempt: number
  revision: number
  status: string
  deadline_at: string
  deadline_boot_id: string | null
  deadline_monotonic_ns: number | null
}

// 只有执行器手上的状态才可能因失联变 orphaned；人工卡与终态不在此列
const EXECUTOR_BOUND: readonly string[] = [
  'dispatched',
  'started',
  'waiting',
  'verifying',
  'stopping',
  'timing_out',
  'startup_unknown',
]

// 命令回执：在途超时收 rejected；完成后满 7 天清 receipt_json，查询侧据此返回 OPERATION_EXPIRED
function sweepInboxReceipts(tx: Tx, now: string): { timedOut: number; expired: number } {
  const nowMs = Date.parse(now)
  const { inFlightMs, receiptMs } = receiptRetention(tx.raw)
  const inFlightBefore = new Date(nowMs - inFlightMs).toISOString()
  const receiptBefore = new Date(nowMs - receiptMs).toISOString()
  const timedOut = tx.run(
    "UPDATE inbox SET status = 'rejected', receipt_json = ?, completed_at = ?, receipt_expired_at = ? " +
      `WHERE completed_at IS NULL AND created_at <= ? AND status IN (${IN_FLIGHT_COMMAND_STATUSES.map(() => '?').join(',')})`,
    [JSON.stringify({ error: { code: 'OPERATION_TIMEOUT', message: '命令在途超时，未执行' } }), now, new Date(nowMs + receiptMs).toISOString(), inFlightBefore,
      ...IN_FLIGHT_COMMAND_STATUSES],
  ).changes
  const expired = tx.run(
    'UPDATE inbox SET receipt_json = NULL, receipt_expired_at = ? WHERE completed_at IS NOT NULL AND receipt_json IS NOT NULL'
      + ' AND (completed_at <= ? OR receipt_expired_at <= ?)',
    [now, receiptBefore, now],
  ).changes
  return { timedOut, expired }
}

function recoverySkip(row: { status: string; hang_reason: string | null }): boolean {
  if (isTerminal(row.status)) return true
  if (row.hang_reason !== null) return true
  return row.status === 'indeterminate_side_effect'
    || row.status === 'stopping'
    || row.status === 'timing_out'
    || row.status === 'paused_bridge_missing'
    || row.status === 'startup_unknown'
}

// 节点行上的判定锚点 → 判定用的 Deadline；墙钟只是展示用（规格 3.4 行 171）
function verifyDeadline(row: VerifyRow): Deadline | null {
  if (!row.verify_deadline_boot_id || row.verify_deadline_monotonic_ns === null || !row.verify_deadline_at) return null
  return {
    bootId: row.verify_deadline_boot_id,
    monotonicNs: Number(row.verify_deadline_monotonic_ns),
    wallClockMs: Date.parse(row.verify_deadline_at),
  }
}

// 转阻塞并留一条 verify_human：超时就写 verify_timeout，不确定就写 timer_uncertain
function blockVerifying(tx: Tx, secret: string, row: VerifyRow, now: string, reason: string, missing: string[]): boolean {
  try {
    transitionNode(tx, secret, {
      nodeRunId: row.node_run_id,
      from: 'verifying',
      to: 'blocked_post',
      attempt: row.attempt,
      revision: row.revision,
      now,
      reason,
      verifyHuman: { reason, missing },
    })
    return true
  } catch {
    // 别的流程刚改过这一行：跳过这一行，不让单行失败拖垮整批扫描（审计 N-04）
    return false
  }
}
