// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { taskCardStatus } from '../../src/client/panel/tasks-screen.tsx'
import type { TaskSummary } from '../../src/service/queries/tasks.ts'

function task(over: Partial<TaskSummary> = {}): TaskSummary {
  return {
    task_id: 't1',
    title: '任务一',
    workflow_id: 'wf1',
    workflow_version: 1,
    status: 'succeeded',
    display_status: 'succeeded',
    current_run_id: 'r1',
    session_id: null,
    run_count: 1,
    open_decision_count: 0,
    oldest_open_decision_age_seconds: null,
    unverified_count: 0,
    max_side_effect_level: null,
    max_heartbeat_age_ms: null,
    attention: 'none',
    attention_reason: null,
    updated_at: '2026-11-19T00:00:00.000Z',
    archived_at: null,
    trigger_kind: null,
    autonomy: 'autonomous',
    current_run_status: 'succeeded',
    ...over,
  }
}

describe('交付验收的界面文案', () => {
  it('验收失败时显示交付验收失败，不折叠成「已完成」', () => {
    const view = taskCardStatus(task({ delivery_acceptance: 'failed', display_status: '交付验收失败' }))
    expect(view.label).toContain('交付验收失败')
    expect(view.label).not.toBe('已完成')
  })

  it('证据不足时显示交付待核验', () => {
    const view = taskCardStatus(task({ delivery_acceptance: 'unverifiable', display_status: '交付待核验' }))
    expect(view.label).toContain('交付待核验')
  })

  it('验收通过或没有计划时沿用执行状态文案', () => {
    expect(taskCardStatus(task({ delivery_acceptance: 'passed' })).label).toBe('已完成')
    expect(taskCardStatus(task({ delivery_acceptance: 'not_applicable' })).label).toBe('已完成')
  })

  it('验收还没出结论时不改写执行中的文案', () => {
    const view = taskCardStatus(task({ delivery_acceptance: 'pending', status: 'running', display_status: 'running' }))
    expect(view.label).toBe('进行中')
  })
})
