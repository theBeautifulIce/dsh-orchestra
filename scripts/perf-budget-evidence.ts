import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { sha256Hex } from '../src/core/canonical.ts'

export const PERF_WARMUP = 5
export const PERF_ROUNDS = 30
export const PERF_BUDGETS = {
  list_tasks: { route: '/v1/tasks', size: 50, ms: 100 },
  get_run: { route: '/v1/runs/get', size: 1000, ms: 150 },
  list_nodes: { route: '/v1/node-runs', size: 200, ms: 80 },
  list_events: { route: '/v1/events', size: 200, ms: 50 },
} as const
export type PerfRoute = keyof typeof PERF_BUDGETS

const eqp = z.object({ id: z.number().int(), parent: z.number().int(), detail: z.string().min(1) })
const statement = z.object({
  sql: z.string().min(1), method: z.enum(['all', 'get']), bindings: z.array(z.union([z.string(), z.number(), z.null()])),
  calls: z.number().int().positive(), plan: z.array(eqp),
}).refine(({ sql, plan }) => plan.length > 0 || sql === 'PRAGMA query_only', 'Missing EXPLAIN rows')
const capture = z.array(statement).min(1)
const perfCase = z.object({
  path: z.string(), size: z.number().int(), as_of_seq: z.number().int().positive(),
  samples_ms: z.array(z.number().nonnegative()).length(PERF_ROUNDS), statements: capture,
  http: z.object({ path: z.string(), status: z.literal(200), size: z.number().int(), as_of_seq: z.number().int().positive(),
    elapsed_ms: z.number().nonnegative(), bytes: z.number().int().positive() }),
})
export const perfReportSchema = z.object({
  schema_version: z.literal(1),
  completed: z.literal(true),
  candidate: z.object({ commit: z.string().regex(/^[a-f0-9]{40,64}$/), clean_start: z.boolean(), clean_end: z.boolean(),
    end_commit: z.string().regex(/^[a-f0-9]{40,64}$/) }),
  environment: z.object({ node: z.string(), sqlite: z.string(), pnpm: z.string(), disk: z.string(), cpu: z.string(),
    config_sha256: z.string().regex(/^[a-f0-9]{64}$/), start_at: z.iso.datetime(), end_at: z.iso.datetime(),
    busy_fraction: z.number().min(0).max(1), calibration_before_ms: z.number().positive(), calibration_after_ms: z.number().positive() }),
  seeds: z.object({ q27_tasks: z.literal(10000), q27_runs: z.literal(10000), q27_nodes: z.literal(20000),
    q27_decisions: z.literal(500), q27_start_receipts: z.literal(10000), q27_plans: z.literal(476),
    q26_nodes: z.literal(1000), q26_events: z.literal(1000),
    q26_decisions: z.literal(50), q26_executions: z.literal(100), q26_attestations: z.literal(20),
    q26_start_receipts: z.literal(10001), q26_deliverables: z.literal(51) }),
  write_cost: z.object({ q27_seed_before_ms: z.number().positive(), q27_seed_after_ms: z.number().positive(),
    q27_backfill_ms: z.number().positive(), q27_backfill_rows: z.literal(10000) }),
  warmups: z.literal(PERF_WARMUP),
  cases: z.object({ list_tasks: perfCase, get_run: perfCase, list_nodes: perfCase, list_events: perfCase }),
  checks: z.object({ filtered_task_paging: z.literal(true), task_cursor_scope: z.literal(true),
    event_cursor_paging: z.literal(true), event_cursor_exclusive: z.literal(true), disjoint_node_run: z.literal(true) }),
  filtered_task_statements: capture,
  base_tables: z.array(z.string()).min(1),
})
export type PerfReport = z.infer<typeof perfReportSchema>
export type PerfStatement = z.infer<typeof statement>

export function perfStats(samples: number[]) {
  const ordered = [...samples].sort((a, b) => a - b)
  return { p50: ordered[Math.ceil(0.5 * ordered.length) - 1]!, p95: ordered[Math.ceil(0.95 * ordered.length) - 1]!,
    max: ordered.at(-1)!, first_ms: samples[0]! }
}

function baseNames(sql: string, tables: string[]) {
  const aliases = new Set(tables)
  const keywords = /^(WHERE|LEFT|INNER|CROSS|RIGHT|FULL|OUTER|JOIN|ON|GROUP|ORDER|LIMIT|UNION|HAVING|EXCEPT|INTERSECT|INDEXED|NOT)$/i
  for (const [, table, alias] of sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi)) {
    if (table && tables.includes(table.toLowerCase()) && alias && !keywords.test(alias)) aliases.add(alias.toLowerCase())
  }
  return aliases
}

function validatePlans(route: string, statements: PerfStatement[], tables: string[], diagnostics: string[]): string[] {
  const errors: string[] = []
  for (const stmt of statements) {
    const aliases = baseNames(stmt.sql, tables)
    const materialize = stmt.plan.find(({ detail }) => detail === 'MATERIALIZE task_page')
    const boundedTaskPage = materialize && stmt.sql.includes('task_page AS MATERIALIZED') && /LIMIT \?\)/i.test(stmt.sql)
    for (const row of stmt.plan) {
      const scan = /^SCAN (?:TABLE )?(\w+)/.exec(row.detail)?.[1]?.toLowerCase()
      if (scan) {
        if (aliases.has(scan)) errors.push(`${route}: base scan ${row.detail}`)
        else if (boundedTaskPage && (scan === 'p' || scan === 'task_page')) diagnostics.push(`${route}: ${row.detail} bounded by task page LIMIT`)
        else if (scan === 'sqlite_master' && stmt.sql === "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'service_meta'") {
          diagnostics.push(`${route}: ${row.detail} inspects schema metadata for the read connection`)
        } else errors.push(`${route}: unclassified scan ${row.detail}`)
      }
      if (!row.detail.includes('TEMP B-TREE')) continue
      if (boundedTaskPage && row.parent === materialize.id) {
        errors.push(`${route}: task candidate sort is not index ordered (${row.detail})`)
      } else if (boundedTaskPage && row.parent === 0 && row.detail.includes('ORDER BY')) {
        diagnostics.push(`${route}: ${row.detail} sorts the hydrated task page only`)
      } else if (boundedTaskPage && row.detail.includes('group_concat(DISTINCT)')
        && stmt.plan.some((step) => step.parent === row.parent && /^SEARCH n USING INDEX .+ \(run_id=\?\)/.test(step.detail))) {
        diagnostics.push(`${route}: ${row.detail} deduplicates side-effect policy values for one indexed current run per task`)
      } else if (route === 'get_run' && /WHERE o\.run_id = \? ORDER BY p\.created_at, p\.plan_id LIMIT 1/.test(stmt.sql)
        && row.detail === 'USE TEMP B-TREE FOR ORDER BY' && stmt.plan.some((step) => step.parent === row.parent
          && /^SEARCH o USING (?:COVERING )?INDEX \S+ \(run_id=\?\)$/.test(step.detail))) {
        diagnostics.push(`${route}: ${row.detail} orders confirmed plans for one indexed run receipt range`)
      } else if (route === 'list_nodes' && /FROM rework_plan_edges e\b/.test(stmt.sql)
        && /WHERE e\.run_id\s*=\s*\? AND p\.approved_by IS NOT NULL ORDER BY e\.from_node_id,e\.to_node_id/.test(stmt.sql)
        && row.detail === 'USE TEMP B-TREE FOR ORDER BY' && stmt.plan.some((step) => step.parent === row.parent
          && /^SEARCH e USING (?:COVERING )?INDEX \S+ \(run_id=\?\)$/.test(step.detail))) {
        diagnostics.push(`${route}: ${row.detail} orders approved dependency edges for one indexed run`)
      } else if ((route === 'get_run' || route === 'list_nodes') && /\bWHERE (?:n\.)?run_id = \?(?:\s|$|\))/.test(stmt.sql)) {
        diagnostics.push(`${route}: ${row.detail} operates inside the indexed 1,000-node run or a related run/node lookup`)
      } else if (route === 'list_nodes' && /\bWHERE node_run_id = \?/.test(stmt.sql)) {
        diagnostics.push(`${route}: ${row.detail} sorts facts for one indexed node`)
      } else {
        errors.push(`${route}: unclassified temporary sort ${row.detail}`)
      }
    }
  }
  return errors
}

export function assessPerfReport(input: unknown) {
  const parsed = perfReportSchema.safeParse(input)
  if (!parsed.success) return { pass: false, errors: parsed.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message), statistics: {}, plan_diagnostics: [] }
  const report = parsed.data
  const errors: string[] = []
  const diagnostics: string[] = []
  const statistics: Partial<Record<PerfRoute, ReturnType<typeof perfStats>>> = {}
  if (report.candidate.commit !== report.candidate.end_commit || !report.candidate.clean_start || !report.candidate.clean_end) {
    errors.push('not a clean, unchanged candidate')
  }
  const calibration = report.environment.calibration_after_ms / report.environment.calibration_before_ms
  if (report.environment.busy_fraction > 0.5 || Math.max(calibration, 1 / calibration) > 1.5
    || report.environment.end_at <= report.environment.start_at) errors.push('environment window is not valid')
  const markers: Record<PerfRoute, RegExp[]> = {
    list_tasks: [/task_page AS MATERIALIZED/, /FROM task_attention_order WHERE archived = \?/],
    get_run: [/GROUP BY status ORDER BY status/, /FROM node_runs\s+WHERE run_id = \? ORDER BY updated_at DESC/,
      /JOIN start_run_operations o ON o\.operation_id = p\.launch_operation_id/, /FROM run_acceptance_results WHERE run_id = \? AND plan_id = \? AND content_hash = \?/],
    list_nodes: [/WHERE n\.run_id = \? ORDER BY n\.seq, n\.attempt, n\.node_run_id LIMIT \?/],
    list_events: [/FROM events WHERE seq > \? ORDER BY seq ASC LIMIT \?/],
  }
  for (const route of Object.keys(PERF_BUDGETS) as PerfRoute[]) {
    const expected = PERF_BUDGETS[route]
    const measured = report.cases[route]
    if (measured.path !== expected.route || measured.http.path !== expected.route
      || measured.size !== expected.size || measured.http.size !== expected.size) errors.push(`${route}: wrong route or result size`)
    if (measured.as_of_seq !== measured.http.as_of_seq) errors.push(`${route}: snapshot waterline mismatch`)
    if (!markers[route].every((pattern) => measured.statements.some(({ sql }) => pattern.test(sql)))) errors.push(`${route}: missing production SQL`)
    const stats = perfStats(measured.samples_ms)
    statistics[route] = stats
    if (stats.p95 >= expected.ms) errors.push(`${route}: p95 ${stats.p95.toFixed(3)} ms >= ${expected.ms} ms`)
    errors.push(...validatePlans(route, measured.statements, report.base_tables, diagnostics))
  }
  if (!report.cases.list_tasks.statements.some(({ plan }) => plan.some(({ detail }) =>
    /^SEARCH task_attention_order USING (?:COVERING )?INDEX task_attention_order_\w+ \(archived=\?\)/i.test(detail)))) {
    errors.push('list_tasks: first page is not index ordered')
  }
  const filteredPlans = report.filtered_task_statements.filter(({ sql }) => sql.includes('status = ?'))
  if (filteredPlans.length < 2 || filteredPlans.some(({ plan }) => !plan.some(({ detail }) =>
    /^SEARCH task_attention_order USING (?:COVERING )?INDEX task_attention_order_\w+ \(.*\bstatus=\?/i.test(detail)))) {
    errors.push('list_tasks: status filter is not index constrained')
  }
  errors.push(...validatePlans('list_tasks_filtered', report.filtered_task_statements, report.base_tables, diagnostics))
  return { pass: errors.length === 0, errors: [...new Set(errors)], statistics, plan_diagnostics: [...new Set(diagnostics)] }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const file = process.argv[2]
    if (!file || process.argv.length !== 3) throw new Error('Usage: node scripts/perf-budget-evidence.ts <perf-report.json>')
    const bytes = readFileSync(file)
    if (readFileSync(file + '.sha256', 'utf8').trim() !== sha256Hex(bytes)) throw new Error('performance report checksum mismatch')
    const result = assessPerfReport(JSON.parse(bytes.toString('utf8')))
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (!result.pass) process.exitCode = 1
  } catch (error) {
    process.stderr.write(String(error) + '\n')
    process.exitCode = 1
  }
}
