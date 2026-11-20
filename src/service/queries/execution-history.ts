import { OrchError } from '../../core/errors.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { withReadTx } from './read-tx.ts'

type Detail = { label: string; value: string }
type Row = { id: number; type: string; created_at: string; payload: string; run_id: string; node_id: string; node_run_id: string }
const TITLES: Record<string, string> = {
  status_changed: '节点状态变更', verify_human: '请求人工核验', lease_granted: '分配执行租约',
  lease_lost: '执行租约失效', deadline_rearmed: '更新执行时限', tool_started: '工具调用开始',
  tool_finished: '工具调用结束', report_applied: '执行报告已入账', report_rejected: '执行报告被拒绝',
  report_replayed: '记录执行报告重放',
  'report.stale': '忽略过期报告', 'report.contradicted': '检测到报告冲突',
  'bridge.step': '智能体执行步骤', 'bridge.turn': '智能体提交报告', 'bridge.tool.call': '智能体请求调用工具',
  'bridge.tool.start': '宿主开始调用工具', 'bridge.tool.result': '宿主返回工具结果',
  'executor.model_selected': '选择执行模型', 'executor.model_confirmed': '宿主确认模型',
  'executor.model_used': '记录实际执行模型', 'executor.model_rejected': '模型选择未获确认',
}

const attention = `(e.type IN ('verify_human','lease_lost','report_rejected','report.contradicted','executor.model_rejected')
  OR CASE WHEN e.type IN ('status_changed','tool_finished') AND LENGTH(e.payload) <= 512000 AND json_valid(e.payload) THEN
    (e.type = 'status_changed' AND json_extract(e.payload, '$.to') IN
      ('blocked_pre','blocked_post','indeterminate_side_effect','startup_unknown','paused_bridge_missing','failed','timeout','orphaned','failed_with_unverified','abandoned_unverified'))
    OR (e.type = 'tool_finished' AND json_type(e.payload, '$.exit_code') = 'integer' AND json_extract(e.payload, '$.exit_code') <> 0)
  ELSE 0 END)`
const filters: Readonly<Record<string, string>> = {
  all: '1',
  attention,
  tool: "(e.type IN ('tool_started','tool_finished') OR e.type GLOB 'bridge.tool.*')",
  report: "(e.type IN ('report_applied','report_rejected','report_replayed','bridge.turn') OR e.type GLOB 'report.*')",
  model: "e.type GLOB 'executor.model_*'",
}
const FIELDS: Readonly<Record<string, string>> = {
  from: '原状态', to: '新状态', status: '状态', next_status: '报告状态', reason: '原因',
  registry_state: '记录状态', attempt: '尝试次数', action_generation: '派发代次', revision: '修订',
  model_ref: '模型配置', complexity: '复杂度', tool: '工具', tool_seq: '调用序号', exit_code: '退出码',
  execution_id: '系统证据 ID', report_id: '报告 ID', callId: '调用 ID', executorAgentId: '执行会话',
  started_at: '开始时间', finished_at: '完成时间', timeoutMs: '超时毫秒数',
  workflow_id: 'Workflow ID', workflow_version: 'Workflow 版本', decision_id: '审批 ID',
  resolution: '处理结论', trigger_kind: '触发方式', scheduled_for: '计划时间',
  due_at: '计划触发时间', summary: '摘要', evidence_digest: '证据摘要', command_hash: '调用摘要',
  trigger_id: '触发器 ID', event_type: '事件类型', artifact_id: '产物 ID', file_name: '文件名称',
  evidence_id: '证据 ID', error_code: '错误代码', node_count: '节点数量',
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parse(raw: string | null) {
  if (!raw || raw.length > 512_000) return {}
  try { return object(JSON.parse(raw)) } catch { return {} }
}

function add(details: Detail[], label: string, value: unknown) {
  if (typeof value === 'string' && value.trim()) details.push({ label, value: value.slice(0, 1800) })
  else if (typeof value === 'number' && Number.isFinite(value)) details.push({ label, value: String(value) })
}

export function describeEvent(type: string, payload: string | null): Detail[] {
  const event = parse(payload)
  const bridge = type.startsWith('bridge.')
  const body = bridge ? object(event.payload) : event
  const report = object(body.report)
  const fields: Record<string, unknown> = bridge ? { attempt: event.attempt, executorAgentId: event.executorAgentId,
    tool: body.tool, timeoutMs: body.timeoutMs, callId: body.callId, status: report.status } : body
  const details: Detail[] = []
  for (const [key, label] of Object.entries(FIELDS)) add(details, label, fields[key])
  if (type === 'report_replayed') add(details, '报告序号', body.report_seq)
  if ((type === 'bridge.tool.start' || type === 'bridge.tool.result') && body.tool === 'orchestra_assist') {
    add(details, '复核批次', body.summary)
  }
  if (type === 'executor.model_used') {
    const usage = object(body.usage)
    add(details, '提供方', usage.provider)
    add(details, '实际模型', usage.model)
  }
  if (type === 'bridge.turn' && body.kind === 'report') {
    const output = object(report.output)
    add(details, '报告摘要', output.summary ?? output.result_summary)
    add(details, '错误代码', report.error_code)
  }
  return details
}

export function listExecutionHistory(db: Db, opts: {
  taskId?: string; runId?: string; nodeId?: string; before?: number; limit?: number; filter?: string
}) {
  const scopes = [opts.taskId, opts.runId, opts.nodeId].filter(Boolean)
  const limit = opts.limit ?? 35
  const before = opts.before ?? Number.MAX_SAFE_INTEGER
  if (scopes.length !== 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '执行日志必须指定一个有效的任务、运行或节点范围')
  }
  const filter = opts.filter
  if (filter !== undefined && !Object.hasOwn(filters, filter)) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '执行日志筛选无效')
  const scope = opts.nodeId ? 'e.node_run_id' : opts.runId ? 'n.run_id' : 'r.task_id'
  return withReadTx(db, ({ tx, as_of_seq }) => {
    const rows = tx.all<Row & { attention?: number }>(`SELECT e.id,e.type,e.created_at,CASE WHEN LENGTH(e.payload) <= 512000 THEN e.payload ELSE '{}' END AS payload,
      n.run_id,n.node_id,n.node_run_id${filter !== undefined ? `, CASE WHEN ${attention} THEN 1 ELSE 0 END AS attention` : ''}
      FROM node_run_events e JOIN node_runs n ON n.node_run_id=e.node_run_id
      JOIN runs r ON r.run_id=n.run_id WHERE ${scope} = ? AND e.id < ?
      ${filter === undefined ? '' : `AND ${filters[filter]}`} ORDER BY e.id DESC LIMIT ?`, [scopes[0], before, limit + 1])
    const items = rows.slice(0, limit).map(({ payload, attention: flagged, ...row }) => ({
      ...row, title: Object.hasOwn(TITLES, row.type) ? TITLES[row.type]! : row.type, details: describeEvent(row.type, payload),
      ...(flagged === undefined ? {} : { attention: flagged === 1 }),
    }))
    return { items, next_before: rows.length > limit ? items.at(-1)!.id : null, as_of_seq }
  })
}

export type ExecutionEntry = ReturnType<typeof listExecutionHistory>['items'][number]
