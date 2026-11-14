// Task 15：起运行固定版本、自治档位、升级规则与 operation_id 幂等。
import { describe, expect, it } from 'vitest'
import { catalogFor, freshLedger } from '../fixtures/ledger.ts'
import { escalationRequiresConfirm, decisionConfirmRequired, setTaskAutonomy, startRun, validateEscalations } from '../../src/service/commands/start-run.ts'
import { escalateDecisions, openDecision } from '../../src/service/commands/decisions.ts'
import { inTx } from '../../src/infra/db/tx.ts'

const NOW = '2026-11-13T03:00:00.000Z'

describe('start_run', () => {
  it('默认 autonomous，档位写进任务并回读一致', () => {
    const { db } = freshLedger()
    const out = startRun(db, catalogFor(['n1']), {
      workflowVersion: '1', taskTitle: '默认档', operationId: 'op_1', now: NOW,
    })
    expect(out).toMatchObject({ autonomy: 'autonomous', replayed: false })
    const task = db.raw.prepare('SELECT autonomy, escalations_json FROM tasks WHERE task_id = ?').get(out.task_id)
    expect(task).toEqual({ autonomy: 'autonomous', escalations_json: '[]' })
    const event = db.raw.prepare("SELECT payload_redacted FROM events WHERE type = 'task.created' ORDER BY seq DESC LIMIT 1").get() as { payload_redacted: string }
    expect(JSON.parse(event.payload_redacted)).toMatchObject({ autonomy: 'autonomous', escalations: [] })
  })

  it('缺 workflow_version 直接拒，且不建任务', () => {
    const { db } = freshLedger()
    expect(() => startRun(db, catalogFor(['n1']), {
      workflowVersion: '', taskTitle: '缺版本', operationId: 'op_missing', now: NOW,
    })).toThrowError(/workflow_version/)
    const tasks = db.raw.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }
    expect(tasks.n).toBe(0)
  })

  it('越界自治档位被拒', () => {
    const { db } = freshLedger()
    expect(() => startRun(db, catalogFor(['n1']), {
      workflowVersion: '1', taskTitle: '越界', autonomy: 'god' as never, operationId: 'op_bad', now: NOW,
    })).toThrowError(/autonomous/)
  })

  it('同 operation_id 重放返回同一 task/run，不建第二条', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(['n1'])
    const first = startRun(db, catalog, { workflowVersion: '1', taskTitle: '幂等', operationId: 'op_same', now: NOW })
    const second = startRun(db, catalog, { workflowVersion: '1', taskTitle: '幂等', operationId: 'op_same', now: NOW })
    expect(second).toMatchObject({ task_id: first.task_id, run_id: first.run_id, replayed: true })
    const tasks = db.raw.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }
    expect(tasks.n).toBe(1)
  })

  it('不同 operation_id 建第二条任务，不合并', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(['n1'])
    const first = startRun(db, catalog, { workflowVersion: '1', taskTitle: 'A', operationId: 'op_a', now: NOW })
    const second = startRun(db, catalog, { workflowVersion: '1', taskTitle: 'B', operationId: 'op_b', now: NOW })
    expect(second.task_id).not.toBe(first.task_id)
  })

  it('升级规则命中节点类型、动作类别与版本发布，未命中不打扰', () => {
    const rules = validateEscalations([
      { kind: 'node_type', value: 'agent' },
      { kind: 'action_category', value: 'irreversible' },
      { kind: 'workflow_version_publish', value: 'wf-a' },
    ])
    expect(escalationRequiresConfirm(rules, { nodeType: 'agent' })).toBe(true)
    expect(escalationRequiresConfirm(rules, { actionCategory: 'irreversible' })).toBe(true)
    expect(escalationRequiresConfirm(rules, { workflowId: 'wf-a' })).toBe(true)
    expect(escalationRequiresConfirm(rules, { nodeType: 'subworkflow' })).toBe(false)
    expect(() => validateEscalations([{ kind: 'unknown', value: 'x' }])).toThrowError(/escalation kind/)
  })

  it('改档走 revision CAS 并留一条审计事件', () => {
    const { db } = freshLedger()
    const created = startRun(db, catalogFor(['n1']), {
      workflowVersion: '1', taskTitle: '改档', operationId: 'op_switch', now: NOW,
    })
    const out = setTaskAutonomy(db, {
      taskId: created.task_id, autonomy: 'supervised', expectedRevision: 0, now: NOW,
    })
    expect(out).toEqual({ from: 'autonomous', to: 'supervised', revision: 1 })
    const task = db.raw.prepare('SELECT autonomy, revision FROM tasks WHERE task_id = ?').get(created.task_id)
    expect(task).toEqual({ autonomy: 'supervised', revision: 1 })
    const event = db.raw.prepare("SELECT payload_redacted FROM events WHERE type = 'task.autonomy_changed'").get() as { payload_redacted: string }
    expect(JSON.parse(event.payload_redacted)).toMatchObject({ from: 'autonomous', to: 'supervised' })
  })

  it('改档时旧 revision 冲突，不覆盖别人刚写的档位', () => {
    const { db } = freshLedger()
    const created = startRun(db, catalogFor(['n1']), {
      workflowVersion: '1', taskTitle: '抢档', operationId: 'op_race', now: NOW,
    })
    setTaskAutonomy(db, { taskId: created.task_id, autonomy: 'assisted', expectedRevision: 0, now: NOW })
    expect(() => setTaskAutonomy(db, {
      taskId: created.task_id, autonomy: 'supervised', expectedRevision: 0, now: NOW,
    })).toThrowError(/CAS 未命中/)
    expect(db.raw.prepare('SELECT autonomy FROM tasks WHERE task_id = ?').get(created.task_id)).toEqual({ autonomy: 'assisted' })
  })

  it('assisted 超时按默认动作收口，supervised 只升级不自动收口', () => {
    const { db } = freshLedger()
    const old = '2026-11-12T00:00:00.000Z'
    const now = '2026-11-13T03:00:00.000Z'
    const assisted = startRun(db, catalogFor(['n1']), {
      workflowVersion: '1', taskTitle: 'assisted', autonomy: 'assisted', operationId: 'op_as', now,
    })
    const supervised = startRun(db, catalogFor(['n1']), {
      workflowVersion: '1', taskTitle: 'supervised', autonomy: 'supervised', operationId: 'op_sv', now,
    })
    inTx(db, (tx) => {
      openDecision(tx, { decisionId: 'dec_as', runId: assisted.run_id, nodeRunId: null, kind: 'audit_result', createdAt: old })
      openDecision(tx, { decisionId: 'dec_sv', runId: supervised.run_id, nodeRunId: null, kind: 'audit_result', createdAt: old })
    })
    const out = inTx(db, (tx) => escalateDecisions(tx, { now }))
    expect(out).toEqual({ blocked: 1, expired: 1 })
    const as = db.raw.prepare('SELECT status, closed_reason FROM decisions WHERE decision_id = ?').get('dec_as')
    expect(as).toEqual({ status: 'resolved', closed_reason: 'expired_final' })
    const sv = db.raw.prepare('SELECT status, closed_reason FROM decisions WHERE decision_id = ?').get('dec_sv')
    expect(sv).toEqual({ status: 'blocked_for_human', closed_reason: null })
  })

  it('escalations 命中发布版本时 decision confirm_required=1', () => {
    const { db } = freshLedger()
    const created = startRun(db, catalogFor(['n1']), {
      workflowVersion: '1', taskTitle: '发布要问', operationId: 'op_esc', now: NOW,
      escalations: [{ kind: 'workflow_version_publish', value: 'wf-a' }],
    })
    const hit = inTx(db, (tx) => decisionConfirmRequired(tx, created.run_id, { workflowId: 'wf-a' }))
    expect(hit).toBe(true)
    inTx(db, (tx) => openDecision(tx, {
      decisionId: 'dec_esc', runId: created.run_id, nodeRunId: null, kind: 'audit_result',
      confirmRequired: hit, createdAt: NOW,
    }))
    const row = db.raw.prepare('SELECT confirm_required FROM decisions WHERE decision_id = ?').get('dec_esc')
    expect(row).toEqual({ confirm_required: 1 })
  })
})
