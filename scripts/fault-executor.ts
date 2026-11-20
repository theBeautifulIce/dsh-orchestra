import { constants, copyFileSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { canonicalJson } from '../src/core/canonical.ts'
import { sha256File } from '../src/infra/backup.ts'
import {
  evidenceFile, executeFaultQuery, ORPHAN_REFERENCES_SQL,
  type FaultQuery, type SqlRow, type SqlValue,
} from './fault-reconcile.ts'
import type { FaultCase } from './fault-report.ts'

const checkpoints = ['before.db', 'breakpoint.db', 'after.db', 'replay.db'] as const
const receipts = [
  'expired-report.json', 'stale-report.json', 'expired-tool.json', 'stale-tool.json',
  'current-report.json', 'expired-replay.json', 'stale-replay.json',
] as const
const originals = [...checkpoints, ...receipts]
const provenanceFile = 'provenance.json'

const text = z.string().trim().min(1)
const instant = z.iso.datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)))
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const ordinal = z.number().int().positive()
const scope = z.object({ nodeRunId: text, attempt: ordinal, generation: ordinal })
const provenanceSchema = z.object({
  schemaVersion: z.literal(1),
  captureRef: text,
  program: z.literal('dsh-orchestra'),
  candidateSha: z.string().regex(/^[0-9a-f]{40}$/),
  candidateDirty: z.literal(false),
  runId: text,
  expiredNodeRunId: text,
  oldNodeRunId: text,
  newNodeRunId: text,
  files: z.record(z.enum(originals), z.object({ sourceRef: text, sha256: digest, capturedAt: instant })),
})
// Scope and time come from the original capture. Outcome codes belong to the
// captured response. The production ledger supplies the isolation decision.
const receipt = z.object({ runId: text, observedAt: instant, source: scope })
const reportReceipt = receipt.extend({
  reportId: text,
  target: scope,
  response: z.union([
    z.object({ code: z.enum(['LEASE_EXPIRED', 'STALE_GENERATION']), accepted: z.literal(false).optional() }),
    z.object({ accepted: z.literal(true), next_status: z.string().min(1) }),
  ]),
})
const toolReceipt = receipt.extend({
  executorAgentId: text,
  callId: text,
  executionId: text,
  hostFinishedAt: instant,
  response: z.object({ code: z.enum(['LEASE_EXPIRED', 'STALE_GENERATION']) }),
})
const replayReceipt = receipt.extend({
  executorAgentId: text,
  callId: text,
  response: z.object({ code: z.literal('EVIDENCE_SOURCE_UNAVAILABLE') }),
})

function requireEvidence(value: unknown, failure: string): asserts value {
  if (!value) throw new Error('G-04 evidence rejected: ' + failure)
}

function retain(source: string, directory: string, name: string, hash: string) {
  const file = evidenceFile(source, name)
  requireEvidence(lstatSync(file).size > 0, 'empty original ' + name)
  if (name.endsWith('.db')) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      requireEvidence(!lstatSync(file + suffix, { throwIfNoEntry: false }), 'checkpoint has sidecar ' + name + suffix)
    }
  }
  const target = join(directory, name)
  requireEvidence(sha256File(file) === hash, 'original hash mismatch for ' + name)
  copyFileSync(file, target, constants.COPYFILE_EXCL)
  requireEvidence(sha256File(target) === hash, 'copied original hash mismatch for ' + name)
}

function readJson(directory: string, name: string): unknown {
  return JSON.parse(readFileSync(evidenceFile(directory, name), 'utf8'))
}

function makeQuery(database: string, sql: string, bindings: SqlValue[], expectedCount: number): FaultQuery {
  return { database, sql, bindings, expectedCount }
}

function snapshot(directory: string, database: string, run: string, subjects: string[]) {
  const queries: Record<string, FaultQuery> = {}
  function read(name: string, sql: string, args: SqlValue[] = [run]) {
    const query = makeQuery(database, sql, args, 0)
    const result = executeFaultQuery(directory, query)
    requireEvidence(result.rows, name + ' in ' + database + ': ' + result.error)
    queries[name] = { ...query, expectedCount: result.rows.length }
    return result.rows
  }
  const nodes = read('nodes', `SELECT * FROM node_runs
    WHERE run_id = ? AND node_run_id IN (?, ?, ?) ORDER BY node_run_id`, [run, ...subjects])
  const runRow = read('run', 'SELECT * FROM runs WHERE run_id = ?')
  const outbox = read('outbox', `SELECT o.* FROM bridge_tool_outbox o JOIN node_runs n USING (node_run_id)
    WHERE n.run_id = ? ORDER BY o.node_run_id, o.attempt, o.executor_agent_id, o.call_id`)
  const executions = read('executions', `SELECT t.* FROM tool_executions t JOIN node_runs n USING (node_run_id)
    WHERE n.run_id = ? ORDER BY t.node_run_id, t.attempt, t.tool_seq`)
  const rows = {
    run: runRow,
    nodes,
    outbox,
    executions,
    global: read('global', `SELECT seq, event_id, type, node_run_id, payload_redacted, occurred_at,
      boot_id, CAST(monotonic_ns AS TEXT) AS monotonic_ns, run_id, decision_id, payload_ref, idempotency_key, created_at
      FROM events WHERE run_id = ? ORDER BY seq`),
    chain: read('chain', `SELECT e.* FROM node_run_events e JOIN node_runs n USING (node_run_id)
      WHERE n.run_id = ? ORDER BY e.id`),
    reports: read('reports', `SELECT r.* FROM report_registry r JOIN node_runs n USING (node_run_id)
      WHERE n.run_id = ? ORDER BY r.report_id`),
  }
  return { rows, queries }
}

function identify(rows: SqlRow[], id: string) {
  const row = rows.find((item) => item.node_run_id === id)
  requireEvidence(row, 'missing node ' + id)
  return row
}

function identity(row: SqlRow) {
  return scope.parse({ nodeRunId: row.node_run_id, attempt: row.attempt, generation: row.action_generation })
}

function equal(actual: unknown, expected: unknown) {
  return canonicalJson(actual) === canonicalJson(expected)
}

function time(value: string) {
  return Date.parse(value)
}

function activeLease(node: SqlRow, at: string) {
  return typeof node.lease_expires_at === 'string' && time(node.lease_expires_at) > time(at)
    && typeof node.lease_id === 'string' && node.lease_id !== '' && node.owner_epoch !== null
}

function isExpired(node: SqlRow, at: string) {
  return typeof node.lease_expires_at === 'string' && time(node.lease_expires_at) <= time(at)
}

function reportId(payload: unknown): unknown {
  return typeof payload === 'string' ? (JSON.parse(payload) as { report_id?: unknown } | null)?.report_id : undefined
}

export const caseG04S6: FaultCase = async ({ directory, candidateSha, candidateDirty }) => {
  // Pin the existing capture index from the evidence handoff, independently of the archive.
  const source = process.env.S6_G04_EVIDENCE_DIR
  const pinnedHash = process.env.S6_G04_PROVENANCE_SHA256
  requireEvidence(source && pinnedHash, 'offline evidence directory and pinned provenance SHA-256 are required')
  retain(source, directory, provenanceFile, digest.parse(pinnedHash))
  const manifest = provenanceSchema.parse(readJson(directory, provenanceFile))
  requireEvidence(candidateDirty === false && candidateSha === manifest.candidateSha,
    'original evidence must come from this clean candidate')
  for (const name of originals) retain(source, directory, name, manifest.files[name].sha256)

  const { runId, expiredNodeRunId, oldNodeRunId, newNodeRunId } = manifest
  const ids = [expiredNodeRunId, oldNodeRunId, newNodeRunId]
  requireEvidence(new Set(ids).size === ids.length, 'the three node runs must be distinct')
  const [before, middle, after, replay] = checkpoints.map((name) => snapshot(directory, name, runId, ids))
  requireEvidence(before && middle && after && replay, 'incomplete checkpoint set')

  const expiredBefore = identify(before.rows.nodes, expiredNodeRunId)
  const expiredMiddle = identify(middle.rows.nodes, expiredNodeRunId)
  const oldBefore = identify(before.rows.nodes, oldNodeRunId)
  const oldMiddle = identify(middle.rows.nodes, oldNodeRunId)
  const newMiddle = identify(middle.rows.nodes, newNodeRunId)
  const newAfter = identify(after.rows.nodes, newNodeRunId)
  const expiredScope = identity(expiredBefore)
  const priorScope = identity(oldBefore)
  const currentScope = identity(newMiddle)
  const expiredReport = reportReceipt.parse(readJson(directory, 'expired-report.json'))
  const staleReport = reportReceipt.parse(readJson(directory, 'stale-report.json'))
  const currentReport = reportReceipt.parse(readJson(directory, 'current-report.json'))
  const lateTools = [
    toolReceipt.parse(readJson(directory, 'expired-tool.json')),
    toolReceipt.parse(readJson(directory, 'stale-tool.json')),
  ] as const
  const replayTools = [
    replayReceipt.parse(readJson(directory, 'expired-replay.json')),
    replayReceipt.parse(readJson(directory, 'stale-replay.json')),
  ] as const

  const checkpointTimes = checkpoints.map((name) => time(manifest.files[name].capturedAt))
  const [startAt, middleAt, afterAt, replayAt] = checkpointTimes as [number, number, number, number]
  requireEvidence(startAt < middleAt && middleAt < afterAt && afterAt < replayAt, 'checkpoint times must be strictly ordered')
  for (const [name, original] of [
    ['expired-report.json', expiredReport], ['stale-report.json', staleReport], ['current-report.json', currentReport],
    ['expired-tool.json', lateTools[0]], ['stale-tool.json', lateTools[1]],
    ['expired-replay.json', replayTools[0]], ['stale-replay.json', replayTools[1]],
  ] as const) {
    const originalAt = time(original.observedAt)
    requireEvidence(original.runId === runId && originalAt <= time(manifest.files[name].capturedAt),
      'receipt run or capture time did not match ' + name)
  }

  const checks: NonNullable<Awaited<ReturnType<FaultCase>>['checks']> = {}
  function check(name: string, actual: unknown, expected: unknown = true) {
    checks[name] = { actual, expected }
  }
  check('real_run_in_all_checkpoints', [before, middle, after, replay].every((stage) => stage.rows.run.length === 1))
  check('leased_tools_in_flight', [expiredBefore, oldBefore].every((node) =>
    activeLease(node, manifest.files['before.db'].capturedAt) && ['started', 'verifying'].includes(String(node.status))))
  check('expired_without_replacement', isExpired(expiredMiddle, manifest.files['breakpoint.db'].capturedAt)
    && equal(identity(expiredMiddle), expiredScope) && expiredMiddle.replacement_node_run_id === null)
  check('expired_node_unchanged', identify(after.rows.nodes, expiredNodeRunId), expiredMiddle)
  check('handoff_same_logical_node', oldBefore.node_id !== expiredBefore.node_id && oldBefore.node_id === newMiddle.node_id
    && oldBefore.seq === newMiddle.seq && !before.rows.nodes.some((row) => row.node_run_id === newNodeRunId)
    && equal(identity(oldMiddle), priorScope) && oldBefore.replacement_node_run_id === null
    && oldMiddle.replacement_node_run_id === newNodeRunId && newMiddle.origin_node_run_id === oldNodeRunId
    && currentScope.attempt === priorScope.attempt + 1 && currentScope.generation > priorScope.generation
    && typeof newMiddle.created_at === 'string' && time(newMiddle.created_at) >= startAt
    && time(newMiddle.created_at) <= middleAt
    && activeLease(newMiddle, manifest.files['breakpoint.db'].capturedAt))
  check('old_node_after_handoff_unchanged', identify(after.rows.nodes, oldNodeRunId), oldMiddle)
  check('current_scope_after_report_unchanged',
    equal(identity(newAfter), currentScope) && newAfter.node_id === newMiddle.node_id
    && newAfter.origin_node_run_id === oldNodeRunId)
  check('expired_report_original', {
    source: expiredReport.source,
    target: expiredReport.target,
    code: 'code' in expiredReport.response ? expiredReport.response.code : null,
  }, { source: expiredScope, target: expiredScope, code: 'LEASE_EXPIRED' })
  check('stale_report_original', equal(staleReport.source, priorScope)
    && (equal(staleReport.target, priorScope)
      || equal(staleReport.target, { ...currentScope, generation: priorScope.generation }))
    && 'code' in staleReport.response && staleReport.response.code === 'STALE_GENERATION')
  const currentStatus = 'accepted' in currentReport.response && currentReport.response.accepted
    ? currentReport.response.next_status : null
  check('current_report_original', equal(currentReport.source, currentScope) && equal(currentReport.target, currentScope)
    && currentStatus !== null && newAfter.status === currentStatus && newAfter.revision === Number(newMiddle.revision) + 1
    && activeLease(newMiddle, currentReport.observedAt))
  check('reports_and_late_deliveries_between_checkpoints', [
    expiredReport, staleReport, currentReport, ...lateTools,
  ].every((item) => time(item.observedAt) >= middleAt && time(item.observedAt) <= afterAt))
  check('unique_receipt_ids', new Set([expiredReport.reportId, staleReport.reportId, currentReport.reportId]).size === 3
    && lateTools[0].callId !== lateTools[1].callId && lateTools[0].executionId !== lateTools[1].executionId)
  for (const [index, label] of ['expired', 'stale'].entries()) {
    const tool = lateTools[index]!
    const repeated = replayTools[index]!
    const subject = index === 0 ? expiredScope : priorScope
    check(label + '_tool_original', equal(tool.source, subject)
      && (index !== 0 || tool.response.code === 'LEASE_EXPIRED')
      && time(tool.hostFinishedAt) <= time(tool.observedAt))
    check(label + '_tool_replay_original', equal(repeated.source, tool.source)
      && repeated.callId === tool.callId && repeated.executorAgentId === tool.executorAgentId)
    check(label + '_tool_replay_time', time(repeated.observedAt) > afterAt && time(repeated.observedAt) <= replayAt)

    const pending = middle.rows.outbox.filter((row) => row.call_id === tool.callId)
    check(label + '_pending_boundary', pending.map((row) => ({
      node: row.node_run_id, attempt: row.attempt, executor: row.executor_agent_id, status: row.status,
      result: row.result_json, createdBeforeHostResult: typeof row.created_at === 'string' && time(row.created_at) <= time(tool.hostFinishedAt),
    })), [{ node: subject.nodeRunId, attempt: subject.attempt, executor: tool.executorAgentId, status: 'pending',
      result: null, createdBeforeHostResult: true }])
  }

  check('replay_preserves_scoped_ledger', replay.rows, after.rows)
  const rejectedIds = new Set([expiredReport.reportId, staleReport.reportId])
  const applied = after.rows.chain.filter((event) => event.type === 'report_applied')
  const boundaryIds = new Set(middle.rows.chain.map((event) => event.id))
  check('only_current_report_applied_after_boundary', applied
    .filter((event) => !boundaryIds.has(event.id))
    .map((event) => ({ node: event.node_run_id, reportId: reportId(event.payload) })),
  [{ node: newNodeRunId, reportId: currentReport.reportId }])
  check('rejected_reports_not_applied', applied.every((event) => !rejectedIds.has(String(reportId(event.payload)))))
  check('rejected_reports_have_no_global_apply', after.rows.global.every((event) => event.type !== 'report_applied'
    || !rejectedIds.has(String(reportId(event.payload_redacted)))))
  check('no_stale_or_expired_status_progression', after.rows.chain.every((event) => event.type !== 'status_changed'
    || boundaryIds.has(event.id) || (event.node_run_id !== expiredNodeRunId && event.node_run_id !== oldNodeRunId)))

  const extraQueries: Record<string, FaultQuery> = {}
  for (const [index, stage] of [before, middle, after, replay].entries()) {
    for (const [name, query] of Object.entries(stage.queries)) extraQueries[`${checkpoints[index]}:${name}`] = query
  }
  const afterQuery = (sql: string, args: SqlValue[], count = 0) => makeQuery('after.db', sql, args, count)
  for (const [index, tool] of lateTools.entries()) {
    const subject = index === 0 ? expiredScope : priorScope
    const prefix = index === 0 ? 'expired' : 'stale'
    const reason = tool.response.code
    const diagnosticQuery = `
      SELECT e.* FROM node_run_events e JOIN node_runs n USING (node_run_id)
      WHERE n.run_id = ? AND e.node_run_id = ? AND e.type = 'tool_result_late'
        AND json_extract(e.payload, '$.attempt') = ?
        AND json_extract(e.payload, '$.call_id') = ?
        AND json_extract(e.payload, '$.execution_id') = ?
        AND json_extract(e.payload, '$.reason') = ?
    `
    const diagnosticBindings = [runId, subject.nodeRunId, subject.attempt, tool.callId, tool.executionId, reason]
    extraQueries[prefix + '_production_late_diagnostic'] = afterQuery(diagnosticQuery, diagnosticBindings, 1)
    extraQueries[prefix + '_no_late_diagnostic_at_boundary'] = makeQuery('breakpoint.db', diagnosticQuery, diagnosticBindings, 0)
    extraQueries[prefix + '_host_execution_start'] = makeQuery('breakpoint.db', `
      SELECT e.* FROM node_run_events e JOIN node_runs n USING (node_run_id)
      WHERE n.run_id = ? AND e.node_run_id = ? AND e.type = 'tool_started'
        AND json_extract(e.payload, '$.attempt') = ?
        AND json_extract(e.payload, '$.call_id') = ?
        AND json_extract(e.payload, '$.execution_id') = ?
        AND julianday(json_extract(e.payload, '$.started_at')) <= julianday(?)
    `, [runId, subject.nodeRunId, subject.attempt, tool.callId, tool.executionId, tool.hostFinishedAt], 1)
    extraQueries[prefix + '_no_late_execution'] = afterQuery(
      'SELECT * FROM tool_executions WHERE execution_id = ?', [tool.executionId])
    extraQueries[prefix + '_no_late_completed_outbox'] = afterQuery(`
      SELECT o.* FROM bridge_tool_outbox o JOIN node_runs n USING (node_run_id)
      WHERE n.run_id = ? AND o.status = 'completed'
        AND (call_id = ? OR json_extract(result_json, '$.trace.executionId') = ?)
    `, [runId, tool.callId, tool.executionId])
    extraQueries[prefix + '_no_late_tool_finished_event'] = afterQuery(`
      SELECT e.* FROM node_run_events e JOIN node_runs n USING (node_run_id)
      WHERE n.run_id = ? AND e.type = 'tool_finished'
        AND (json_extract(e.payload, '$.call_id') = ? OR json_extract(e.payload, '$.execution_id') = ?)
    `, [runId, tool.callId, tool.executionId])
    extraQueries[prefix + '_old_scope_failed_outbox'] = afterQuery(`
      SELECT * FROM bridge_tool_outbox WHERE node_run_id = ? AND attempt = ?
        AND executor_agent_id = ? AND call_id = ? AND status = 'failed'
    `, [subject.nodeRunId, subject.attempt, tool.executorAgentId, tool.callId], 1)
  }
  extraQueries.current_report_event = afterQuery(`SELECT * FROM node_run_events
    WHERE node_run_id = ? AND type = 'report_applied' AND json_extract(payload, '$.report_id') = ?
      AND json_extract(payload, '$.next_status') = ?`,
  [newNodeRunId, currentReport.reportId, currentStatus], 1)
  extraQueries.current_report_registry = afterQuery(`SELECT * FROM report_registry
    WHERE report_id = ? AND node_run_id = ? AND attempt = ? AND state = 'applied'`,
  [currentReport.reportId, newNodeRunId, currentScope.attempt], 1)
  extraQueries.no_rejected_report_application = afterQuery(`SELECT * FROM report_registry
    WHERE report_id IN (?, ?) AND state IN ('applied', 'replayed')`,
  [expiredReport.reportId, staleReport.reportId])

  const missing = (previous: typeof before.rows): SqlValue[] => [
    JSON.stringify(previous.global), JSON.stringify(previous.chain),
  ]
  const missingSql = `
    SELECT 'global' AS ledger, p.key AS prior_index FROM json_each(?) p
      LEFT JOIN events e ON e.seq = json_extract(p.value, '$.seq') AND e.event_id = json_extract(p.value, '$.event_id')
      WHERE e.seq IS NULL
    UNION ALL
    SELECT 'node', p.key FROM json_each(?) p
      LEFT JOIN node_run_events e ON e.id = json_extract(p.value, '$.id') AND e.hash = json_extract(p.value, '$.hash')
      WHERE e.id IS NULL
  `
  extraQueries.before_events_retained_at_boundary = makeQuery('breakpoint.db', missingSql, missing(before.rows), 0)
  return {
    params: { captureRef: manifest.captureRef, program: manifest.program, provenanceSha256: pinnedHash },
    sampleIds: { runId, expiredNodeRunId, oldNodeRunId, newNodeRunId },
    boundary: { reached: true, kind: 'offline_checkpoint_and_original_receipt_review',
      before: manifest.files['before.db'].capturedAt, breakpoint: manifest.files['breakpoint.db'].capturedAt,
      after: manifest.files['after.db'].capturedAt, replay: manifest.files['replay.db'].capturedAt,
      expiredScope, priorScope, currentScope },
    snapshots: { before: before.rows, breakpoint: middle.rows, after: after.rows },
    artifacts: [provenanceFile, ...originals],
    queries: {
      orphan_runs: afterQuery(ORPHAN_REFERENCES_SQL, []),
      missing_events: afterQuery(missingSql, missing(middle.rows)),
      half_rows: afterQuery(`SELECT o.* FROM bridge_tool_outbox o JOIN node_runs n USING (node_run_id)
        WHERE n.run_id = ? AND o.status = 'completed' AND NOT EXISTS (
          SELECT 1 FROM tool_executions t WHERE t.node_run_id = o.node_run_id AND t.attempt = o.attempt
            AND t.execution_id = json_extract(o.result_json, '$.trace.executionId'))`, [runId]),
    },
    extraQueries,
    checks,
    extra: { sources: manifest.files, replay: replay.rows },
  }
}
