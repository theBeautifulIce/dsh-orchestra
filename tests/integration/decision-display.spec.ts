import { expect, it } from 'vitest'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { openDecision } from '../../src/service/commands/decisions.ts'
import { getDecisionSnapshot, listDecisions } from '../../src/service/queries/decisions.ts'
import { describeDecision } from '../../src/core/decision-display.ts'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'

const NOW = '2026-11-25T00:00:00.000Z'

it('审批说明使用绑定的任务、步骤和本次观察事实，不借用新尝试的超时记录', () => {
  const { db } = freshLedger()
  try {
    seed(db)
    withTx(db, tx => {
      tx.run('INSERT INTO workflow_versions (workflow_id,version,content_hash,definition_json,doc_json,created_at) VALUES (?,?,?,?,?,?)',
        ['display-workflow', '1', 'bound-hash', '{}', JSON.stringify({ nodes: [{ node_id: 'n1', title: '读取输入记录' }] }), NOW])
      tx.run("UPDATE runs SET workflow_id='display-workflow',workflow_version='1',workflow_definition_hash='bound-hash' WHERE run_id='r1'")
      tx.run("UPDATE node_runs SET attempt=2,action_generation=4,status='startup_unknown' WHERE node_run_id='nr1'")
      openDecision(tx, { decisionId: 'display-decision', runId: 'r1', nodeRunId: 'nr1', kind: 'startup_unknown', createdAt: NOW,
        payload: { ordinary_recovery: { node_run_id: 'nr1', attempt: 2, action_generation: 4, rearm_generation: 0 },
          target_summary: '这次执行的启动状态有待确认。' } })
      appendNodeRunEvent(tx, TEST_SECRET, 'nr1', 'executor.observation_only', { attempt: 2, action_generation: 4,
        reason: 'action_timeout', timeout_ms: 120_000, observed_running: true, has_tool_call: true })
      appendNodeRunEvent(tx, TEST_SECRET, 'nr1', 'executor.observation_only', { attempt: 3, action_generation: 5,
        reason: 'lease_lost', timeout_ms: 999_000, observed_running: false, has_tool_call: false })
    })
    const card = getDecisionSnapshot(db, 'display-decision').item
    expect(card).toMatchObject({ task_title: '样本任务', step_title: '读取输入记录', attempt: 2,
      execution_observation: { reason: 'action_timeout', timeout_ms: 120_000, observed_running: true, has_tool_call: true } })
    expect(describeDecision(card).title).toBe('执行超时，等待处理')
    expect(describeDecision(card).reason).toContain('记录显示本次执行已开始')
    expect(listDecisions(db).items[0]).toMatchObject({ step_title: card.step_title, execution_observation: card.execution_observation })
    // A different workflow hash cannot lend a display label to this bound run.
    withTx(db, tx => tx.run("UPDATE runs SET workflow_definition_hash='other-hash' WHERE run_id='r1'"))
    expect(getDecisionSnapshot(db, 'display-decision').item.step_title).toBe('第 1 步（名称未记录）')
    withTx(db, tx => tx.run("UPDATE decisions SET payload_json='{}' WHERE decision_id='display-decision'"))
    expect(getDecisionSnapshot(db, 'display-decision').item.execution_observation).toBeUndefined()
  } finally { db.raw.close() }
})

it('旧观察记录没有原因或启动事实时保留未知，授权失效也不误报超时', () => {
  const { db } = freshLedger()
  try {
    seed(db)
    withTx(db, tx => {
      tx.run("UPDATE node_runs SET attempt=1,action_generation=0,status='startup_unknown' WHERE node_run_id='nr1'")
      openDecision(tx, { decisionId: 'legacy-decision', runId: 'r1', nodeRunId: 'nr1', kind: 'startup_unknown', createdAt: NOW,
        payload: { ordinary_recovery: { node_run_id: 'nr1', attempt: 1, action_generation: 0, rearm_generation: 0 } } })
      appendNodeRunEvent(tx, TEST_SECRET, 'nr1', 'executor.observation_only', { attempt: 1, action_generation: 0 })
    })
    const card = getDecisionSnapshot(db, 'legacy-decision').item
    expect(card.execution_observation).toEqual({ reason: null, timeout_ms: null, observed_running: false, has_tool_call: false })
    expect(describeDecision(card).summary).toContain('还不能确认这一步是否已启动')
    expect(describeDecision(card).reason).not.toContain('记录显示本次执行已开始')
    const lost = describeDecision({ ...card, kind: 'action_overrun', execution_observation: {
      reason: 'lease_lost', timeout_ms: 120_000, observed_running: true, has_tool_call: true,
    } })
    expect(lost.title).toBe('执行授权失效，等待处理')
    expect(lost.summary).not.toContain('执行时限')
  } finally { db.raw.close() }
})
