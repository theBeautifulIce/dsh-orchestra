import { expect, it } from 'vitest'
import { assessPerfReport, PERF_BUDGETS, PERF_ROUNDS, type PerfReport, type PerfRoute,
  type PerfStatement } from '../../scripts/perf-budget-evidence.ts'

function evidence(): PerfReport {
  const statement = (sql: string, detail: string): PerfStatement => ({
    sql, method: 'all', bindings: [], calls: 1, plan: [{ id: 1, parent: 0, detail }],
  })
  const route = (key: PerfRoute, statements: PerfStatement[]) => {
    const { route: path, size } = PERF_BUDGETS[key]
    return {
      path, size, as_of_seq: 1000, samples_ms: Array<number>(PERF_ROUNDS).fill(1), statements,
      http: { path, size, as_of_seq: 1000, status: 200 as const, elapsed_ms: 2, bytes: 10 },
    }
  }
  const taskSql = 'WITH task_page AS MATERIALIZED (SELECT task_id FROM task_attention_order WHERE archived = ?'
  const statusPlan = 'SEARCH task_attention_order USING INDEX task_attention_order_status (archived=? AND status=?)'
  return {
    schema_version: 1, completed: true,
    candidate: { commit: 'a'.repeat(40), clean_start: true, clean_end: true, end_commit: 'a'.repeat(40) },
    environment: { node: 'v24', sqlite: '3.54', pnpm: '12', disk: 'SSD', cpu: '32', config_sha256: 'a'.repeat(64),
      start_at: '2026-11-20T00:00:00Z', end_at: '2026-11-20T00:05:00Z',
      busy_fraction: 0.15, calibration_before_ms: 1, calibration_after_ms: 1 },
    seeds: { q27_tasks: 10000, q27_runs: 10000, q27_nodes: 20000, q27_decisions: 500, q27_start_receipts: 10000, q27_plans: 476,
      q26_nodes: 1000, q26_events: 1000, q26_decisions: 50, q26_executions: 100, q26_attestations: 20,
      q26_start_receipts: 10001, q26_deliverables: 51 },
    write_cost: { q27_seed_before_ms: 100, q27_seed_after_ms: 200, q27_backfill_ms: 100, q27_backfill_rows: 10000 },
    warmups: 5,
    base_tables: ['task_attention_order', 'tasks', 'runs', 'node_runs', 'events', 'start_run_operations', 'task_plans',
      'run_acceptance_results', 'rework_plan_edges'],
    checks: { filtered_task_paging: true, task_cursor_scope: true, event_cursor_paging: true, event_cursor_exclusive: true, disjoint_node_run: true },
    cases: {
      list_tasks: route('list_tasks', [statement(taskSql + ' LIMIT ?) SELECT * FROM task_page',
        'SEARCH task_attention_order USING INDEX task_attention_order_default (archived=?)')]),
      get_run: route('get_run', [
        statement('SELECT status, COUNT(*) FROM node_runs WHERE run_id = ? GROUP BY status ORDER BY status', 'SEARCH node_runs USING INDEX idx_node_runs_run (run_id=?)'),
        statement('SELECT node_run_id FROM node_runs WHERE run_id = ? ORDER BY updated_at DESC LIMIT 10', 'SEARCH node_runs USING INDEX idx_node_runs_run (run_id=?)'),
        statement('SELECT p.plan_id, p.content_hash FROM task_plans p JOIN start_run_operations o ON o.operation_id = p.launch_operation_id WHERE o.run_id = ? ORDER BY p.created_at, p.plan_id LIMIT 1',
          'SEARCH o USING INDEX start_run_operations_run (run_id=?)'),
        statement('SELECT result_id FROM run_acceptance_results WHERE run_id = ? AND plan_id = ? AND content_hash = ? ORDER BY deliverable_key LIMIT 51',
          'SEARCH run_acceptance_results USING INDEX sqlite_autoindex_run_acceptance_results_2 (run_id=? AND plan_id=? AND content_hash=?)'),
      ]),
      list_nodes: route('list_nodes', [statement('SELECT n.* FROM node_runs n WHERE n.run_id = ? ORDER BY n.seq, n.attempt, n.node_run_id LIMIT ?',
        'SEARCH n USING INDEX idx_node_runs_run (run_id=?)')]),
      list_events: route('list_events', [statement('SELECT seq FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
        'SEARCH events USING INTEGER PRIMARY KEY (rowid>?)')]),
    },
    filtered_task_statements: [
      statement(taskSql + ' AND status = ? LIMIT ?) SELECT * FROM task_page', statusPlan),
      statement(taskSql + ' AND status = ? AND (sort_weight,sort_at,task_id) < (?,?,?) LIMIT ?) SELECT * FROM task_page', statusPlan),
    ],
  }
}

it('按四路原始 nearest-rank 样本独立判定，阈值相等仍失败', () => {
  const report = evidence()
  expect(assessPerfReport(report).pass).toBe(true)
  report.cases.list_events.samples_ms.splice(-2, 2, 50, 1000)
  expect(assessPerfReport(report)).toMatchObject({ pass: false, errors: ['list_events: p95 50.000 ms >= 50 ms'],
    statistics: { list_events: { p50: 1, p95: 50, max: 1000, first_ms: 1 } } })
})

it.each([
  ['空轮', (report) => { report.cases.list_tasks.samples_ms.length = 0 }],
  ['非有限轮', (report) => { report.cases.list_nodes.samples_ms[0] = Infinity }],
  ['错路由', (report) => { report.cases.list_events.http.path = '/v1/activity' }],
  ['错规模', (report) => { report.cases.list_nodes.size = 199 }],
  ['历史 SQL', (report) => { report.cases.list_tasks.statements[0]!.sql = 'SELECT * FROM tasks LIMIT 50' }],
  ['基表扫描', (report) => { report.cases.list_nodes.statements[0]!.plan[0]!.detail = 'SCAN n USING INDEX idx_node_runs_run' }],
  ['状态筛选退化', (report) => { report.filtered_task_statements[0]!.plan[0]!.detail = 'SEARCH task_attention_order USING INDEX task_attention_order_default (archived=?)' }],
  ['水位不符', (report) => { report.cases.get_run.http.as_of_seq = 999 }],
  ['脏候选', (report) => { report.candidate.clean_end = false }],
  ['负载污染', (report) => { report.environment.busy_fraction = 0.8 }],
] satisfies Array<[string, (report: PerfReport) => void]>)('严格判定拒绝%s', (_label, mutate) => {
  const report = evidence()
  mutate(report)
  expect(assessPerfReport(report).pass).toBe(false)
})

it('严格判定拒绝跳过和缺少一路', () => {
  const report = evidence()
  expect(assessPerfReport({ ...report, completed: false }).pass).toBe(false)
  const { list_events: _events, ...partialCases } = report.cases
  expect(assessPerfReport({ ...report, cases: partialCases }).pass).toBe(false)
})

it('只接受已用 run_id 索引限定范围的回执排序和返工边排序', () => {
  const report = evidence()
  const orderBy = { id: 2, parent: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' }
  const boundPlan = report.cases.get_run.statements[2]!.plan
  boundPlan.push(orderBy)
  const edges = {
    sql: 'SELECT e.from_node_id,e.to_node_id FROM rework_plan_edges e JOIN rework_local_plans p ON p.plan_hash=e.plan_hash '
      + 'WHERE e.run_id=? AND p.approved_by IS NOT NULL ORDER BY e.from_node_id,e.to_node_id',
    calls: 1, method: 'all' as const, bindings: ['run-1'],
    plan: [{ id: 1, parent: 0, detail: 'SEARCH e USING INDEX rework_plan_edges_run (run_id=?)' }, orderBy],
  }
  report.cases.list_nodes.statements.push(edges)
  expect(assessPerfReport(report).pass).toBe(true)
  boundPlan[0]!.detail = 'SCAN o USING INDEX start_run_operations_run'
  edges.plan[0]!.detail = 'SEARCH e USING INDEX rework_plan_edges_unscoped (to_node_id=?)'
  expect(assessPerfReport(report).errors).toEqual(expect.arrayContaining([
    'get_run: base scan SCAN o USING INDEX start_run_operations_run',
    'get_run: unclassified temporary sort USE TEMP B-TREE FOR ORDER BY',
    'list_nodes: unclassified temporary sort USE TEMP B-TREE FOR ORDER BY',
  ]))
})

it('只接受从当前页任务开始并按父运行索引查找的待办，拒绝历史全表扫描', () => {
  const report = evidence()
  const actions: PerfStatement = {
    sql: 'SELECT t.task_id,q.run_id,q.request_id FROM (WITH RECURSIVE roots(task_id,run_id) AS ('
      + 'SELECT task_id,current_run_id FROM tasks WHERE task_id IN (?) AND current_run_id IS NOT NULL '
      + 'UNION SELECT roots.task_id,c.run_id FROM roots CROSS JOIN runs c ON c.parent_run_id=roots.run_id AND c.task_id=roots.task_id'
      + ') SELECT task_id,run_id FROM roots) t CROSS JOIN rework_requests q ON q.run_id=t.run_id ORDER BY q.created_at,q.request_id',
    bindings: ['task-on-page'], calls: 1, method: 'all',
    plan: [
      { id: 1, parent: 0, detail: 'CO-ROUTINE roots' },
      { id: 2, parent: 1, detail: 'SETUP' },
      { id: 3, parent: 2, detail: 'SEARCH tasks USING INDEX sqlite_autoindex_tasks_1 (task_id=?)' },
      { id: 4, parent: 1, detail: 'RECURSIVE STEP' },
      { id: 5, parent: 4, detail: 'SCAN roots' },
      { id: 6, parent: 4, detail: 'SEARCH c USING INDEX idx_runs_parent (parent_run_id=?)' },
      { id: 7, parent: 0, detail: 'SCAN roots' },
      { id: 8, parent: 0, detail: 'SEARCH q USING INDEX rework_run_status (run_id=?)' },
      { id: 9, parent: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' },
    ],
  }
  report.base_tables.push('rework_requests')
  report.cases.list_tasks.statements.push(actions)
  expect(assessPerfReport(report).errors).toEqual([])
  actions.plan[7]!.detail = 'SCAN q USING INDEX rework_run_status'
  expect(assessPerfReport(report).errors).toContain('list_tasks: base scan SCAN q USING INDEX rework_run_status')
  actions.plan[7]!.detail = 'SEARCH q USING INDEX other_status (status=?)'
  expect(assessPerfReport(report).errors).toContain('list_tasks: task actions are not indexed by the displayed run trees')
  actions.plan[5]!.detail = 'SEARCH c USING INDEX idx_runs_task (task_id=?)'
  expect(assessPerfReport(report).errors).toContain('list_tasks: unclassified scan SCAN roots')
})
