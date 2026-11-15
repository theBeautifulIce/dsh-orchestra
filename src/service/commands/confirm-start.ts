// 启动未知的人工确认：M-08 / M-09 / M-61。
// hasToolCall 只认账本里的 tool_started，不接受调用方自报。
import { withTx, type Db } from '../../infra/sqlite/driver.ts'
import { OrchError } from '../../core/errors.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'
import { applyTransition } from './nodes.ts'
import { deadlineFromSample, type ClockProvider } from '../../core/clock.ts'

export type ConfirmStartParams = {
  nodeRunId: string
  attempt: number
  now: string
  /** 人工确认“确实启动了”，没有工具调用时走 M-09，否则走 M-61 */
  attested?: boolean
  /** 确认人；写进事件，不能只留一个匿名动作 */
  actor?: string
  /** 人工确认后转入 stopping 的动作时限，必须落单调锚点 */
  clock?: ClockProvider
  actionDeadlineMs?: number
}

export function confirmStartup(
  db: Db,
  secret: string,
  p: ConfirmStartParams,
): { trigger: 'confirm-started' | 'confirm-started-attested' | 'confirm-started-with-tool' } {
  return withTx(db, (tx) => {
    const row = tx.get<{ status: string; attempt: number; revision: number; rearm_generation: number }>(
      'SELECT status, attempt, revision, rearm_generation FROM node_runs WHERE node_run_id = ?',
      [p.nodeRunId],
    )
    if (!row || row.status !== 'startup_unknown' || row.attempt !== p.attempt) {
      throw new OrchError('RESOLUTION_NOT_AVAILABLE', '只有当前 attempt 的 startup_unknown 节点能确认启动', {
        nodeRunId: p.nodeRunId,
        status: row?.status,
      })
    }
    const hasTool = Boolean(tx.get(
      "SELECT 1 AS hit FROM node_run_events WHERE node_run_id = ? AND type = 'tool_started' LIMIT 1",
      [p.nodeRunId],
    ))
    const trigger = hasTool ? 'confirm-started-with-tool' : p.attested ? 'confirm-started-attested' : 'confirm-started'
    // 三条出口共用同一对状态：必须显式点名走哪条，不能让无守卫的 M-08 替带条件的 M-61 放行
    const ruleId = hasTool ? 'M-61' : p.attested ? 'M-09' : 'M-08'
    const actionDeadlineMs = p.actionDeadlineMs ?? 30_000
    const deadline = p.clock ? deadlineFromSample(p.clock, actionDeadlineMs) : null
    applyTransition(tx, {
      nodeRunId: p.nodeRunId,
      from: ['startup_unknown'],
      to: 'stopping',
      ruleId,
      attempt: p.attempt,
      now: p.now,
      bumpRearm: true,
      rearmGeneration: row.rearm_generation,
      context: { hasToolCall: hasTool, cancelResult: null, hangReason: null, sideEffectVerifiedNone: false },
      patch: {
        startup_unknown_deadline_at: null,
        startup_unknown_boot_id: null,
        startup_unknown_monotonic_ns: null,
        startup_unknown_remaining_ns: null,
        ...(deadline
          ? {
              deadline_at: new Date(deadline.wallClockMs).toISOString(),
              deadline_boot_id: deadline.bootId,
              deadline_monotonic_ns: deadline.monotonicNs,
            }
          : {}),
      },
    })
    appendNodeRunEvent(tx, secret, p.nodeRunId, 'startup.confirmed', {
      trigger,
      actor: p.actor ?? null,
      action_deadline_ms: actionDeadlineMs,
    })
    return { trigger }
  })
}
