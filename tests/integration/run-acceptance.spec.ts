// tests/integration/run-acceptance.spec.ts —— 交付验收阶段（审计 P1-05）
//
// 口径：run 终态与交付验收是两件事。
// - 验收结论落在 run_acceptance_results，每条交付物一行；
// - 验收不达标时 run 仍然是 succeeded，任务展示状态改成「交付验收失败」/「交付待核验」；
// - 没有已确认计划的任务（通用 Workflow Run）判 not_applicable，不写任何验收行。
import { describe, expect, it } from 'vitest'
import type { WorkflowDefinition } from '../../src/core/workflow-def.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applyRunAcceptance, evaluateRunAcceptance } from '../../src/service/commands/run-acceptance.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'
import { getTaskSummary } from '../../src/service/queries/tasks.ts'
import { getRun, listRuns } from '../../src/service/queries/runs.ts'
import { registerRunArtifact } from '../../src/service/artifact-store.ts'
import { textTarget } from '../../src/service/text-result.ts'
import { readChatArtifactContent, readChatTextPreviews } from '../../src/service/chat-text-previews.ts'
import { createRun } from '../../src/service/runs.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import { freshLedger, TEST_SECRET } from '../fixtures/ledger.ts'

const SECRET = TEST_SECRET
const NOW = '2026-11-19T02:00:00.000Z'
const LATER = '2026-11-19T03:00:00.000Z'

type Deliverable = {
  title: string
  node_id: string
  goal_ids: string[]
  acceptance: Record<string, unknown>
}

type AcceptanceRow = {
  deliverable_key: string
  kind: string
  outcome: string
  reason: string | null
  evidence_json: string
}

type TaskRow = { status: string; display_status: string | null }

function definition(workflowId: string): WorkflowDefinition {
  return {
    workflow_id: workflowId,
    workflow_version: '1',
    pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
    nodes: [{ node_id: 'n1', type: 'agent' }],
  }
}

function catalogFor(db: Db, workflowId: string): WorkflowCatalog {
  const catalog = new WorkflowCatalog('S2', db)
  catalog.load(definition(workflowId))
  return catalog
}

function artifactDeliverable(title: string, fileName: string, minimumBytes: number, nodeId = 'n1'): Deliverable {
  return {
    title,
    node_id: nodeId,
    goal_ids: ['g1'],
    acceptance: { kind: 'artifact', file_name: fileName, minimum_bytes: minimumBytes },
  }
}

function toolDeliverable(title: string, tool: string, nodeId = 'n1'): Deliverable {
  return {
    title,
    node_id: nodeId,
    goal_ids: ['g1'],
    acceptance: { kind: 'tool_evidence', tool, exit_code: 0 },
  }
}

function seedPlan(db: Db, opts: { planId: string; taskId: string; runId: string; deliverables: Deliverable[] }): void {
  const operationId = 'op-' + opts.planId
  const proposal = {
    title: '验收计划',
    workflow_id: 'wf-acceptance',
    workflow_version: '1',
    steps: [],
    deliverables: opts.deliverables,
    risks: [],
  }
  withTx(db, (tx) => {
    tx.run(
      'INSERT INTO start_run_operations (operation_id, task_id, run_id, created_at) VALUES (?, ?, ?, ?)',
      [operationId, opts.taskId, opts.runId, NOW],
    )
    tx.run(
      'INSERT INTO task_plans (plan_id, created_by, input_json, proposal_json, quality_json, workflow_hash, '
      + 'content_hash, launch_operation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        opts.planId,
        'tester',
        JSON.stringify({ brief: '交付一份报告' }),
        JSON.stringify(proposal),
        JSON.stringify({ score: 1 }),
        'workflow-hash',
        'a'.repeat(64),
        operationId,
        NOW,
      ],
    )
  })
}

function seedArtifact(db: Db, opts: {
  artifactId: string
  runId: string
  fileName: string
  nodeRunId: string | null
  bytes: number
  retainUntil?: string | null
}): void {
  withTx(db, (tx) => {
    tx.run(
      'INSERT INTO artifacts (artifact_id, run_id, uri, sha256, evidence_index, retain_until, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        opts.artifactId,
        opts.runId,
        'file://' + opts.fileName,
        'sha-' + opts.artifactId,
        0,
        opts.retainUntil ?? null,
        NOW,
      ],
    )
    tx.run(
      'INSERT INTO artifact_contents (artifact_id, file_name, node_run_id, bytes) VALUES (?, ?, ?, ?)',
      [opts.artifactId, opts.fileName, opts.nodeRunId, Buffer.alloc(opts.bytes, 1)],
    )
  })
}

function seedToolExecution(db: Db, opts: {
  nodeRunId: string
  tool: string
  exitCode: number
  attempt?: number
  toolSeq?: number
}): void {
  withTx(db, (tx) => {
    tx.run(
      'INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, exit_code, started_at, finished_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        opts.nodeRunId,
        opts.attempt ?? 1,
        opts.toolSeq ?? 0,
        opts.tool,
        opts.exitCode,
        NOW,
        NOW,
      ],
    )
  })
}

function nodeRunId(db: Db, runId: string, nodeId: string): string {
  const row = db.raw
    .prepare('SELECT node_run_id FROM node_runs WHERE run_id = ? AND node_id = ?')
    .get(runId, nodeId) as { node_run_id: string }
  return row.node_run_id
}

function acceptanceRows(db: Db, runId: string): AcceptanceRow[] {
  return db.raw
    .prepare('SELECT deliverable_key, kind, outcome, reason, evidence_json FROM run_acceptance_results '
      + 'WHERE run_id = ? ORDER BY deliverable_key')
    .all(runId) as AcceptanceRow[]
}

function taskRow(db: Db, taskId: string): TaskRow {
  return db.raw
    .prepare('SELECT status, display_status FROM tasks WHERE task_id = ?')
    .get(taskId) as TaskRow
}

function finishRun(db: Db, runId: string, nodeStatus: string): string | null {
  return withTx(db, (tx) => {
    tx.run("UPDATE node_runs SET status = ?, side_effect_policy = 'pure' WHERE run_id = ?", [nodeStatus, runId])
    return closeRun(tx, SECRET, runId, NOW)
  })
}

// 执行事实快照：重验前后必须逐字段不变
function executionFacts(db: Db, runId: string): string {
  const artifacts = db.raw
    .prepare('SELECT artifact_id, run_id, uri, sha256, evidence_index, retain_until, created_at FROM artifacts '
      + 'WHERE run_id = ? ORDER BY artifact_id')
    .all(runId)
  const contents = db.raw
    .prepare('SELECT artifact_id, file_name, node_run_id, length(bytes) AS bytes FROM artifact_contents ORDER BY artifact_id')
    .all()
  const nodes = db.raw
    .prepare('SELECT node_run_id, run_id, node_id, seq, status, attempt FROM node_runs WHERE run_id = ? ORDER BY node_run_id')
    .all(runId)
  const runs = db.raw
    .prepare('SELECT run_id, task_id, status, revision, started_at, ended_at FROM runs WHERE run_id = ?')
    .all(runId)
  return JSON.stringify({ artifacts, contents, nodes, runs })
}

describe('交付验收阶段', () => {
  it('运行详情只展示绑定本次计划的验收事实，区分文件规则和工具退出码', () => {
    const { db } = freshLedger()
    try {
      const catalog = catalogFor(db, 'wf-acceptance')
      const created = createRun(db, catalog, { taskTitle: '核对交付', workflowId: 'wf-acceptance', workflowVersion: '1', now: NOW })
      const runId = created.run_id
      expect(getRun(db, runId).delivery_checks).toEqual({ items: [], has_more: false })
      seedPlan(db, { planId: 'visible-plan', taskId: created.task_id, runId,
        deliverables: [artifactDeliverable('汇总内容', '合成账目.md', 10), toolDeliverable('工具核对', 'verify.ledger')] })
      const node = nodeRunId(db, runId, 'n1')
      seedArtifact(db, { artifactId: 'whole-file', runId, fileName: '合成账目.md', nodeRunId: node, bytes: 20 })
      seedToolExecution(db, { nodeRunId: node, tool: 'verify.ledger', exitCode: 7 })
      expect(finishRun(db, runId, 'done')).toBe('succeeded')
      withTx(db, (tx) => tx.run('UPDATE run_acceptance_results SET content_hash = ? WHERE run_id = ? AND kind = ?',
        ['b'.repeat(64), runId, 'artifact']))
      expect(getRun(db, runId).delivery_checks?.items).toMatchObject([{ kind: 'tool_evidence', outcome: 'failed',
        reason: 'tool_exit_code_mismatch', tool: 'verify.ledger', expected_exit_code: 0, exit_codes: [7] }])
      withTx(db, (tx) => tx.run('UPDATE run_acceptance_results SET content_hash = ? WHERE run_id = ? AND kind = ?',
        ['a'.repeat(64), runId, 'artifact']))
      const checks = getRun(db, runId).delivery_checks!
      expect(checks.items).toContainEqual(expect.objectContaining({ kind: 'artifact', outcome: 'passed',
        file_name: '合成账目.md', minimum_bytes: 10, bytes: 20 }))
      expect(checks.items.every((item) => !('evidence_json' in item) && !('sha256' in item))).toBe(true)
      expect(listRuns(db).items[0]?.delivery_checks).toBeUndefined()
    } finally { db.raw.close() }
  })

  it('AC2 字节不足：验收 failed，run 终态仍是 succeeded，任务显示「交付验收失败」', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-bytes')
    const created = createRun(db, catalog, {
      taskTitle: '字节不足任务', workflowId: 'wf-bytes', workflowVersion: '1', now: NOW,
    })
    seedPlan(db, {
      planId: 'plan-bytes',
      taskId: created.task_id,
      runId: created.run_id,
      deliverables: [artifactDeliverable('报告', 'report.pdf', 100)],
    })
    seedArtifact(db, {
      artifactId: 'art-bytes',
      runId: created.run_id,
      fileName: 'report.pdf',
      nodeRunId: nodeRunId(db, created.run_id, 'n1'),
      bytes: 10,
    })

    expect(finishRun(db, created.run_id, 'done')).toBe('succeeded')

    const rows = acceptanceRows(db, created.run_id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('failed')
    expect(rows[0]?.reason).toBe('artifact_below_minimum_bytes')
    const task = taskRow(db, created.task_id)
    expect(task.status).toBe('succeeded')
    expect(task.display_status).toBe('交付验收失败')
    const view = getTaskSummary(db, created.task_id, Date.parse(NOW))
    expect(view.delivery_acceptance).toBe('failed')
    expect(view.goal_met).toBe(false)
    expect(view.attention).toBe('failed')
    expect(view.lane).toBe('attention')
  })

  it('AC1 缺文件：验收 unverifiable，run 终态仍是 succeeded，任务显示「交付待核验」', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-missing')
    const created = createRun(db, catalog, {
      taskTitle: '缺文件任务', workflowId: 'wf-missing', workflowVersion: '1', now: NOW,
    })
    seedPlan(db, {
      planId: 'plan-missing',
      taskId: created.task_id,
      runId: created.run_id,
      deliverables: [artifactDeliverable('报告', 'missing.pdf', 10)],
    })

    expect(finishRun(db, created.run_id, 'done')).toBe('succeeded')

    const rows = acceptanceRows(db, created.run_id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('unverifiable')
    expect(rows[0]?.reason).toBe('artifact_not_registered')
    const task = taskRow(db, created.task_id)
    expect(task.status).toBe('succeeded')
    expect(task.display_status).toBe('交付待核验')
    const view = getTaskSummary(db, created.task_id, Date.parse(NOW))
    expect(view.delivery_acceptance).toBe('unverifiable')
    expect(view.goal_met).toBe(false)
    expect(view.attention).toBe('unverified')
    expect(view.lane).toBe('attention')
  })

  it('AC3 来源节点不符：产物归属到别的节点，验收 failed', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-node')
    const created = createRun(db, catalog, {
      taskTitle: '节点不符任务', workflowId: 'wf-node', workflowVersion: '1', now: NOW,
    })
    seedPlan(db, {
      planId: 'plan-node',
      taskId: created.task_id,
      runId: created.run_id,
      deliverables: [artifactDeliverable('报告', 'report.pdf', 10, 'n2')],
    })
    seedArtifact(db, {
      artifactId: 'art-node',
      runId: created.run_id,
      fileName: 'report.pdf',
      nodeRunId: nodeRunId(db, created.run_id, 'n1'),
      bytes: 50,
    })

    expect(finishRun(db, created.run_id, 'done')).toBe('succeeded')

    const rows = acceptanceRows(db, created.run_id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('failed')
    expect(rows[0]?.reason).toBe('artifact_source_node_mismatch')
    expect(taskRow(db, created.task_id).display_status).toBe('交付验收失败')
  })

  it('AC4 工具证据：退出码非 0 判 failed，退出码 0 且节点正确判 passed', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-tool')
    const created = createRun(db, catalog, {
      taskTitle: '工具证据任务', workflowId: 'wf-tool', workflowVersion: '1', now: NOW,
    })
    seedPlan(db, {
      planId: 'plan-tool',
      taskId: created.task_id,
      runId: created.run_id,
      deliverables: [toolDeliverable('构建', 'build'), toolDeliverable('测试', 'test')],
    })
    const nodeRun = nodeRunId(db, created.run_id, 'n1')
    seedToolExecution(db, { nodeRunId: nodeRun, tool: 'build', exitCode: 2, toolSeq: 0 })
    seedToolExecution(db, { nodeRunId: nodeRun, tool: 'test', exitCode: 0, toolSeq: 1 })

    expect(finishRun(db, created.run_id, 'done')).toBe('succeeded')

    const rows = acceptanceRows(db, created.run_id)
    expect(rows).toHaveLength(2)
    const build = rows.find((row) => row.deliverable_key === 'n1|构建')
    const test = rows.find((row) => row.deliverable_key === 'n1|测试')
    expect(build?.outcome).toBe('failed')
    expect(build?.reason).toBe('tool_exit_code_mismatch')
    expect(test?.outcome).toBe('passed')
    expect(test?.reason).toBeNull()
    expect(taskRow(db, created.task_id).display_status).toBe('交付验收失败')
  })

  it('T3 多交付物混合：1 条 passed + 1 条 failed + 1 条 unverifiable，汇总取 failed，逐条结论各自留存', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-mixed')
    const created = createRun(db, catalog, {
      taskTitle: '混合交付任务', workflowId: 'wf-mixed', workflowVersion: '1', now: NOW,
    })
    seedPlan(db, {
      planId: 'plan-mixed',
      taskId: created.task_id,
      runId: created.run_id,
      deliverables: [
        artifactDeliverable('齐全报告', 'good.pdf', 100),
        artifactDeliverable('不足报告', 'small.pdf', 100),
        toolDeliverable('工具留痕', 'build'),
      ],
    })
    seedArtifact(db, {
      artifactId: 'art-good',
      runId: created.run_id,
      fileName: 'good.pdf',
      nodeRunId: nodeRunId(db, created.run_id, 'n1'),
      bytes: 200,
    })
    seedArtifact(db, {
      artifactId: 'art-small',
      runId: created.run_id,
      fileName: 'small.pdf',
      nodeRunId: nodeRunId(db, created.run_id, 'n1'),
      bytes: 10,
    })

    expect(finishRun(db, created.run_id, 'done')).toBe('succeeded')

    const rows = acceptanceRows(db, created.run_id)
    expect(rows).toHaveLength(3)
    const byKey = new Map<string, AcceptanceRow>()
    for (const row of rows) byKey.set(row.deliverable_key, row)
    expect(byKey.get('n1|齐全报告')?.outcome).toBe('passed')
    expect(byKey.get('n1|不足报告')?.outcome).toBe('failed')
    expect(byKey.get('n1|工具留痕')?.outcome).toBe('unverifiable')
    const task = taskRow(db, created.task_id)
    expect(task.status).toBe('succeeded')
    expect(task.display_status).toBe('交付验收失败')
    const view = getTaskSummary(db, created.task_id, Date.parse(NOW))
    expect(view.delivery_acceptance).toBe('failed')
    expect(view.goal_met).toBe(false)
    expect(view.attention).toBe('failed')
    expect(view.lane).toBe('attention')
  })

  it('AC5 全部通过：汇总 passed，每条交付物一行，任务展示状态不被覆盖', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-pass')
    const created = createRun(db, catalog, {
      taskTitle: '全部通过任务', workflowId: 'wf-pass', workflowVersion: '1', now: NOW,
    })
    seedPlan(db, {
      planId: 'plan-pass',
      taskId: created.task_id,
      runId: created.run_id,
      deliverables: [artifactDeliverable('报告', 'report.pdf', 10), toolDeliverable('构建', 'build')],
    })
    seedArtifact(db, {
      artifactId: 'art-pass',
      runId: created.run_id,
      fileName: 'report.pdf',
      nodeRunId: nodeRunId(db, created.run_id, 'n1'),
      bytes: 50,
    })
    seedToolExecution(db, { nodeRunId: nodeRunId(db, created.run_id, 'n1'), tool: 'build', exitCode: 0 })

    expect(finishRun(db, created.run_id, 'done')).toBe('succeeded')

    const rows = acceptanceRows(db, created.run_id)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.outcome).sort()).toEqual(['passed', 'passed'])
    const task = taskRow(db, created.task_id)
    expect(task.status).toBe('succeeded')
    expect(task.display_status).toBeNull()
    const view = getTaskSummary(db, created.task_id, Date.parse(NOW))
    expect(view.delivery_acceptance).toBe('passed')
    expect(view.goal_met).toBe(true)
    expect(view.attention).toBe('none')
    expect(view.lane).toBe('finished')
  })

  it.each(['failed', 'cancelled'] as const)('执行 %s 即使文件结构验收通过也不能声称目标完成', status => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-incomplete')
    const created = createRun(db, catalog, {
      taskTitle: '未完成任务', workflowId: 'wf-incomplete', workflowVersion: '1', now: NOW,
    })
    seedPlan(db, { planId: 'plan-incomplete', taskId: created.task_id, runId: created.run_id,
      deliverables: [artifactDeliverable('已有报告', 'report.pdf', 10)] })
    seedArtifact(db, { artifactId: 'art-incomplete', runId: created.run_id, fileName: 'report.pdf',
      nodeRunId: nodeRunId(db, created.run_id, 'n1'), bytes: 50 })
    if (status === 'cancelled') withTx(db, tx => tx.run('UPDATE runs SET cancel_requested_at=? WHERE run_id=?', [NOW, created.run_id]))
    expect(finishRun(db, created.run_id, status === 'failed' ? 'failed' : 'done')).toBe(status)
    const view = getTaskSummary(db, created.task_id, Date.parse(NOW))
    expect(view.delivery_acceptance).toBe('passed')
    expect(view.goal_met).toBe(false)
  })

  it('AC6 幂等重放：重复验收行数不变、结论稳定', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-replay')
    const created = createRun(db, catalog, {
      taskTitle: '重放任务', workflowId: 'wf-replay', workflowVersion: '1', now: NOW,
    })
    seedPlan(db, {
      planId: 'plan-replay',
      taskId: created.task_id,
      runId: created.run_id,
      deliverables: [artifactDeliverable('报告', 'report.pdf', 10)],
    })
    seedArtifact(db, {
      artifactId: 'art-replay',
      runId: created.run_id,
      fileName: 'report.pdf',
      nodeRunId: nodeRunId(db, created.run_id, 'n1'),
      bytes: 50,
    })
    expect(finishRun(db, created.run_id, 'done')).toBe('succeeded')
    const first = acceptanceRows(db, created.run_id)
    expect(first).toHaveLength(1)
    expect(first[0]?.outcome).toBe('passed')

    const replay = withTx(db, (tx) => applyRunAcceptance(tx, created.run_id, LATER))
    expect(replay.outcome).toBe('passed')
    const second = acceptanceRows(db, created.run_id)
    expect(second).toHaveLength(1)
    expect(second[0]?.outcome).toBe('passed')
    expect(second[0]?.deliverable_key).toBe(first[0]?.deliverable_key)
  })

  it('AC7 无计划的通用 Workflow Run：not_applicable，不写验收行，任务状态不受影响', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-plain')
    const created = createRun(db, catalog, {
      taskTitle: '通用运行任务', workflowId: 'wf-plain', workflowVersion: '1', now: NOW,
    })

    expect(finishRun(db, created.run_id, 'done')).toBe('succeeded')

    const report = withTx(db, (tx) => evaluateRunAcceptance(tx, created.run_id, NOW))
    expect(report.outcome).toBe('not_applicable')
    expect(report.plan_id).toBeNull()
    expect(acceptanceRows(db, created.run_id)).toHaveLength(0)
    const task = taskRow(db, created.task_id)
    expect(task.status).toBe('succeeded')
    expect(task.display_status).toBeNull()
    const view = getTaskSummary(db, created.task_id, Date.parse(NOW))
    expect(view.delivery_acceptance).toBe('not_applicable')
  })

  it('T5 执行失败：验收阶段不覆盖 run 与节点的失败终态', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-exec-fail')
    const created = createRun(db, catalog, {
      taskTitle: '执行失败任务', workflowId: 'wf-exec-fail', workflowVersion: '1', now: NOW,
    })
    seedPlan(db, {
      planId: 'plan-exec-fail',
      taskId: created.task_id,
      runId: created.run_id,
      deliverables: [artifactDeliverable('报告', 'report.pdf', 10)],
    })

    expect(finishRun(db, created.run_id, 'failed')).toBe('failed')

    const run = db.raw.prepare('SELECT status FROM runs WHERE run_id = ?').get(created.run_id) as { status: string }
    expect(run.status).toBe('failed')
    const node = db.raw.prepare('SELECT status FROM node_runs WHERE run_id = ?').get(created.run_id) as { status: string }
    expect(node.status).toBe('failed')
    const rows = acceptanceRows(db, created.run_id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('unverifiable')
    const task = taskRow(db, created.task_id)
    expect(task.status).toBe('failed')
    // 执行已经失败时展示状态以执行失败为准，不被验收结论覆盖
    expect(task.display_status).toBeNull()
    const view = getTaskSummary(db, created.task_id, Date.parse(NOW))
    expect(view.attention).toBe('failed')
    expect(view.goal_met).toBe(false)
  })

  it('T6 补证重验：结论更新、同 key 不重复行、保留评测历史，执行事实逐字段未变', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-resign')
    const created = createRun(db, catalog, {
      taskTitle: '补证重验任务', workflowId: 'wf-resign', workflowVersion: '1', now: NOW,
    })
    seedPlan(db, {
      planId: 'plan-resign',
      taskId: created.task_id,
      runId: created.run_id,
      deliverables: [artifactDeliverable('报告', 'report.pdf', 100)],
    })
    expect(finishRun(db, created.run_id, 'done')).toBe('succeeded')
    const before = acceptanceRows(db, created.run_id)
    expect(before).toHaveLength(1)
    expect(before[0]?.outcome).toBe('unverifiable')

    // 补登记证据后重验
    seedArtifact(db, {
      artifactId: 'art-resign',
      runId: created.run_id,
      fileName: 'report.pdf',
      nodeRunId: nodeRunId(db, created.run_id, 'n1'),
      bytes: 200,
    })
    const factsBefore = executionFacts(db, created.run_id)
    const after = withTx(db, (tx) => applyRunAcceptance(tx, created.run_id, LATER))
    expect(after.outcome).toBe('passed')

    const rows = acceptanceRows(db, created.run_id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('passed')
    expect(rows[0]?.deliverable_key).toBe(before[0]?.deliverable_key)
    const history = JSON.parse(rows[0]?.evidence_json ?? '{}') as { history?: unknown[] }
    expect(Array.isArray(history.history)).toBe(true)
    expect(history.history).toHaveLength(2)
    expect(executionFacts(db, created.run_id)).toBe(factsBefore)
  })

  it('保留期过期：产物证据过期判 unverifiable', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-retain')
    const created = createRun(db, catalog, {
      taskTitle: '保留期任务', workflowId: 'wf-retain', workflowVersion: '1', now: NOW,
    })
    seedPlan(db, {
      planId: 'plan-retain',
      taskId: created.task_id,
      runId: created.run_id,
      deliverables: [artifactDeliverable('报告', 'report.pdf', 10)],
    })
    seedArtifact(db, {
      artifactId: 'art-retain',
      runId: created.run_id,
      fileName: 'report.pdf',
      nodeRunId: nodeRunId(db, created.run_id, 'n1'),
      bytes: 50,
      retainUntil: '2026-11-01T00:00:00.000Z',
    })

    expect(finishRun(db, created.run_id, 'done')).toBe('succeeded')

    const rows = acceptanceRows(db, created.run_id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('unverifiable')
    expect(rows[0]?.reason).toBe('artifact_retain_until_expired')
  })
})

describe('P05 会话文字结果的验收', () => {
  it('已提交正文也必须由当前步骤完成，阻塞说明不能变成已交付正文', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-chat-blocked')
    const created = createRun(db, catalog, { taskTitle: '检索新闻', workflowId: 'wf-chat-blocked', workflowVersion: '1', now: NOW })
    seedPlan(db, { planId: 'plan-chat-blocked', taskId: created.task_id, runId: created.run_id,
      deliverables: [{ title: '检索结论', node_id: 'n1', goal_ids: ['g1'], acceptance: { kind: 'chat/text_result' } }] })
    const nodeId = nodeRunId(db, created.run_id, 'n1')
    const node = db.raw.prepare('SELECT attempt,action_generation FROM node_runs WHERE node_run_id=?').get(nodeId)!
    const target = textTarget('plan-chat-blocked', 'a'.repeat(64), 0,
      { node_run_id: nodeId, attempt: Number(node.attempt), action_generation: Number(node.action_generation) })
    registerRunArtifact(db, { ...target, runId: created.run_id, nodeRunId: nodeId,
      bytes: Buffer.from('已查指定来源，符合条件的条目为 0。') }, NOW)
    const evaluate = () => withTx(db, tx => evaluateRunAcceptance(tx, created.run_id, NOW))
    withTx(db, tx => tx.run("UPDATE node_runs SET status='blocked_post' WHERE node_run_id=?", [nodeId]))
    expect(evaluate().results[0]).toMatchObject({ outcome: 'unverifiable', reason: 'chat_text_producer_not_completed',
      evidence: { producer_status: 'blocked_post' } })
    withTx(db, tx => tx.run("UPDATE node_runs SET status='done' WHERE node_run_id=?", [nodeId]))
    expect(evaluate().results[0]).toMatchObject({ outcome: 'passed' })
  })

  it('早期正文不能耗尽最后一项的预览预算，完整64KiB以内正文可按已验收版本读取', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-chat-full')
    const created = createRun(db, catalog, { taskTitle: '会话全文交付', workflowId: 'wf-chat-full', workflowVersion: '1', now: NOW })
    const bodies = ['前期整理。'.repeat(1200), '复核记录。'.repeat(1200), '最终结论。'.repeat(3000)]
    seedPlan(db, { planId: 'plan-chat-full', taskId: created.task_id, runId: created.run_id,
      deliverables: bodies.map((_, index) => ({ title: '正文' + index, node_id: 'n1', goal_ids: ['g1'], acceptance: { kind: 'chat/text_result' } })) })
    const nodeId = nodeRunId(db, created.run_id, 'n1')
    const node = db.raw.prepare('SELECT attempt,action_generation FROM node_runs WHERE node_run_id=?').get(nodeId)!
    for (const [index, text] of bodies.entries()) {
      const target = textTarget('plan-chat-full', 'a'.repeat(64), index,
        { node_run_id: nodeId, attempt: Number(node.attempt), action_generation: Number(node.action_generation) })
      registerRunArtifact(db, { ...target, runId: created.run_id, nodeRunId: nodeId, bytes: Buffer.from(text) }, NOW)
    }
    expect(finishRun(db, created.run_id, 'done')).toBe('succeeded')
    const checks = getRun(db, created.run_id, { includeAcceptanceArtifactIds: true }).delivery_checks!.items
    const previews = readChatTextPreviews(db, created.run_id, checks, Date.parse(NOW))
    expect(previews).toHaveLength(3)
    expect(previews.every(preview => preview.text.length > 0 && preview.truncated && preview.artifact_id && preview.sha256)).toBe(true)
    expect(previews.map(preview => Array.from(preview.text).length).reduce((sum, chars) => sum + chars, 0)).toBe(2400)
    expect(previews[2]!.text).toContain('最终结论。')
    const final = previews[2]!
    const content = readChatArtifactContent(db, created.run_id, final.artifact_id, checks, Date.parse(NOW))
    expect(content).toMatchObject({ kind: 'preview', text: bodies[2], truncated: false, sha256: final.sha256 })
    // Generic file previews retain their smaller cap; only the exact accepted text version expands.
    expect(readChatArtifactContent(db, created.run_id, final.artifact_id, [], Date.parse(NOW)))
      .toMatchObject({ kind: 'preview', truncated: true })
  })

  it('旧版同名 chat-result.md 不能证明已提交正文', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-chat-text')
    const created = createRun(db, catalog, {
      taskTitle: '会话交付', workflowId: 'wf-chat-text', workflowVersion: '1', now: NOW,
    })
    seedPlan(db, {
      planId: 'plan-chat-text',
      taskId: created.task_id,
      runId: created.run_id,
      deliverables: [{ title: '会话结论', node_id: 'n1', goal_ids: ['g1'], acceptance: { kind: 'chat/text_result' } }],
    })
    expect(finishRun(db, created.run_id, 'done')).toBe('succeeded')
    // 还没有导出文件：不能假装通过。
    const before = acceptanceRows(db, created.run_id)
    expect(before).toHaveLength(1)
    expect(before[0]?.outcome).toBe('unverifiable')
    expect(before[0]?.reason).toBe('chat_text_result_not_exported')
    // 普通同名登记仍然缺少已批准交付项的来源。
    seedArtifact(db, {
      artifactId: 'art-chat-text',
      runId: created.run_id,
      fileName: 'chat-result.md',
      nodeRunId: nodeRunId(db, created.run_id, 'n1'),
      bytes: 42,
    })
    withTx(db, (tx) => applyRunAcceptance(tx, created.run_id, LATER))
    const after = acceptanceRows(db, created.run_id)
    expect(after).toHaveLength(1)
    expect(after[0]?.outcome).toBe('unverifiable')
  })
})
