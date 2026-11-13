// src/core/report.ts —— 上报信封（规格 4.2 行 286-305）
export type ReportEvidence = {
  // 来源决定强弱：run_tool 是强证据，tool_result 是弱证据（规格 4.7 行 380-383）
  source: 'run_tool' | 'tool_result'
  exitCode?: number
  stdoutHash?: string
  stderrHash?: string
  hashes?: Record<string, string>
  producedAt?: string
  // 执行器落库时同时写入的命令名与命令哈希；收口时拿它们和 tool_executions 行对齐
  tool?: string
  commandHash?: string
}

export type Report = {
  report_id: string
  node_run_id: string
  attempt: number
  status: string
  evidence?: ReportEvidence
  output?: unknown
  error_code?: string
}

export type ApplyResult = {
  accepted: boolean
  reason?: string
  next_status?: string
  registry_state: 'rejected' | 'replayed' | 'applied' | 'stale'
}

// registry 的 state 只许这四个（规格 4.2 行 300）
export const REPORT_REGISTRY_STATES = ['rejected', 'replayed', 'applied', 'stale'] as const
export type ReportRegistryState = (typeof REPORT_REGISTRY_STATES)[number]

export function isReportRegistryState(value: string): value is ReportRegistryState {
  return (REPORT_REGISTRY_STATES as readonly string[]).includes(value)
}
