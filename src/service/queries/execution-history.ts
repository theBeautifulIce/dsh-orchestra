import { OrchError } from '../../core/errors.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { withReadTx } from './read-tx.ts'

type Detail = { label: string; value: string }
type Row = { id: number; type: string; created_at: string; payload: string; run_id: string; node_id: string; node_run_id: string }
const TITLES: Record<string, string> = {
  status_changed: '节点状态变更', verify_human: '请求人工核验', lease_granted: '分配执行租约',
  lease_lost: '执行租约失效', deadline_rearmed: '更新执行时限', tool_started: '工具调用开始',
  tool_finished: '工具调用结束', report_applied: '执行报告已入账', report_rejected: '执行报告被拒绝',
  'report.stale': '忽略过期报告', 'report.contradicted': '检测到报告冲突',
  'bridge.step': '智能体执行步骤', 'bridge.turn': '智能体提交报告', 'bridge.tool.call': '智能体请求调用工具',
  'bridge.tool.start': '宿主开始调用工具', 'bridge.tool.result': '宿主返回工具结果',
  'executor.model_selected': '选择执行模型', 'executor.model_confirmed': '宿主确认模型',
  'executor.model_used': '记录实际执行模型', 'executor.model_rejected': '模型选择未获确认',
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

export function listExecutionHistory(db: Db, opts: { taskId?: string; runId?: string; nodeId?: string; before?: number; limit?: number }) {
  const scopes = [opts.taskId, opts.runId, opts.nodeId].filter(Boolean)
  const limit = opts.limit ?? 35
  const before = opts.before ?? Number.MAX_SAFE_INTEGER
  if (scopes.length !== 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '执行日志必须指定一个有效的任务、运行或节点范围')
  }
  const scope = opts.nodeId ? 'e.node_run_id' : opts.runId ? 'n.run_id' : 'r.task_id'
  return withReadTx(db, ({ tx, as_of_seq }) => {
    const rows = tx.all<Row>(`SELECT e.id,e.type,e.created_at,CASE WHEN LENGTH(e.payload) <= 512000 THEN e.payload ELSE '{}' END AS payload,
      n.run_id,n.node_id,n.node_run_id FROM node_run_events e JOIN node_runs n ON n.node_run_id=e.node_run_id
      JOIN runs r ON r.run_id=n.run_id WHERE ${scope} = ? AND e.id < ? ORDER BY e.id DESC LIMIT ?`, [scopes[0], before, limit + 1])
    const items = rows.slice(0, limit).map(({ payload, ...row }) => ({
      ...row, title: TITLES[row.type] ?? row.type, details: describeEvent(row.type, payload),
    }))
    return { items, next_before: rows.length > limit ? items.at(-1)!.id : null, as_of_seq }
  })
}

export type ExecutionEntry = ReturnType<typeof listExecutionHistory>['items'][number]
