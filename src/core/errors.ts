// 规格 17.1 错误码总表（85 条，一字不改落成常量；改规格时同步改这里与 tests/errors.spec.ts）
export const ERROR_STATUS = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  PROTOCOL_VERSION_MISMATCH: 409,
  SCHEMA_VERSION_UNSUPPORTED: 422,
  NOT_FOUND: 404,
  CURSOR_EXPIRED: 410,
  CURSOR_FILTER_MISMATCH: 409,
  RANGE_TOO_LARGE: 413,
  QUERY_TIMEOUT: 504,
  SERVICE_UNAVAILABLE: 503,
  OPERATION_ID_CONFLICT: 409,
  OPERATION_EXPIRED: 410,
  OPERATION_TIMEOUT: 504,
  COMMAND_BUSY: 409,
  CONFIRMATION_REQUIRED: 428,
  CONFIRMATION_MISMATCH: 409,
  CONFIRMATION_EXPIRED: 410,
  DECISION_REVISION_CONFLICT: 409,
  RESOLUTION_NOT_AVAILABLE: 422,
  VERIFICATION_TOO_WEAK: 422,
  VERDICT_UNSUPPORTED: 422,
  VERDICT_POLICY_UNMET: 422,
  STALE_GENERATION: 409,
  STALE_HANG: 409,
  BRIDGE_NOT_SUBSCRIBED: 409,
  TOOL_NOT_REGISTERED: 422,
  RUN_TOOL_NOT_READ_ONLY: 403,
  SIDE_EFFECT_UNDECLARED: 422,
  COMPENSATION_UNEXECUTABLE: 422,
  COMPENSATION_TOOL_NOT_COMPENSATING: 422,
  COMPENSATION_TOOL_IN_FORWARD_PATH: 422,
  EVIDENCE_SOURCE_UNAVAILABLE: 422,
  VERIFIER_TOOL_POLICY_MUTATING: 422,
  WORKFLOW_NOT_FOUND: 404,
  WORKFLOW_VERSION_NOT_FOUND: 404,
  WORKFLOW_REVISION_CONFLICT: 409,
  WORKFLOW_VERSION_CONFLICT: 409,
  WORKFLOW_VERSION_IMMUTABLE: 409,
  WORKFLOW_DRAFT_NOT_OPEN: 409,
  WORKFLOW_DRAFT_EXISTS: 409,
  WORKFLOW_NOT_PUBLISHED: 409,
  WORKFLOW_VALIDATION_FAILED: 422,
  WORKFLOW_TITLE_INVALID: 422,
  WORKFLOW_NAME_INVALID: 422,
  WORKFLOW_DEFINITION_TOO_LARGE: 413,
  WORKFLOW_EDGE_SELF_LOOP: 422,
  WORKFLOW_EDGE_DUPLICATE: 422,
  WORKFLOW_DEFINITION_INVALID: 422,
  WORKFLOW_NODE_ID_INVALID: 422,
  WORKFLOW_NODE_ID_DUPLICATE: 422,
  WORKFLOW_EDGE_ENDPOINT_MISSING: 422,
  WORKFLOW_LAYOUT_INVALID: 422,
  WORKFLOW_NO_TRIGGER: 422,
  WORKFLOW_MULTIPLE_TRIGGERS: 422,
  WORKFLOW_TRIGGER_HAS_INBOUND: 422,
  WORKFLOW_TRIGGER_FANOUT: 422,
  WORKFLOW_NODE_FANOUT_INVALID: 422,
  WORKFLOW_NODE_UNREACHABLE: 422,
  WORKFLOW_GRAPH_CYCLE: 422,
  WORKFLOW_BRANCH_ROUTE_INVALID: 422,
  WORKFLOW_BRANCH_PRIORITY_DUPLICATE: 422,
  WORKFLOW_BRANCH_DEFAULT_DUPLICATE: 422,
  NODE_NOT_SUPPORTED: 422,
  WORKFLOW_NODE_CONFIG_INVALID: 422,
  TOOL_NOT_ALLOWED: 422,
  PAYLOAD_SCHEMA_INVALID: 422,
  WORKFLOW_SUBWORKFLOW_VERSION_MISSING: 422,
  SUBWORKFLOW_DEPTH_EXCEEDED: 422,
  BRANCH_AMBIGUOUS: 422,
  SUBWORKFLOW_CYCLE: 422,
  MEMORY_BATCH_TOO_LARGE: 413,
  MEMORY_PROPOSAL_INVALID: 422,
  MEMORY_BATCH_CONFLICT: 422,
  MEMORY_BATCH_NOT_FOUND: 404,
  MEMORY_EVAL_INVALID_OUTPUT: 502,
  MEMORY_EVAL_TIMEOUT: 504,
  MEMORY_EVAL_UNAVAILABLE: 503,
  MEMORY_EVAL_DISABLED: 503,
  MEMORY_BATCH_NOT_APPROVED: 409,
  MEMORY_APPLY_BINDING_INVALID: 403,
  MEMORY_APPLY_CONFLICT: 409,
  MEMORY_APPLY_FAILED: 500,
  MEMORY_RUN_ACTIVE: 409,
  MEMORY_SOURCE_RUN_NOT_SETTLED: 409,
  MEMORY_WRITE_TOOL_FORBIDDEN: 422,
} as const

export type OrchErrorCode = keyof typeof ERROR_STATUS

/** S2 提案码：尚未进规格 17.1，统一从 proposedError 出，details 带 proposed=true。 */
export const PROPOSED_ERROR_CODES = {
  LEASE_EXPIRED: 409,
  BRIDGE_ACK_LAG: 409,
} as const

export type ProposedErrorCode = keyof typeof PROPOSED_ERROR_CODES

export type AnyOrchErrorCode = OrchErrorCode | ProposedErrorCode

const RETRYABLE: ReadonlySet<OrchErrorCode> = new Set([
  'QUERY_TIMEOUT', 'SERVICE_UNAVAILABLE', 'OPERATION_TIMEOUT', 'COMMAND_BUSY',
])

export class OrchError extends Error {
  readonly code: AnyOrchErrorCode
  readonly retryable: boolean
  readonly details: Record<string, unknown>

  constructor(code: AnyOrchErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'OrchError'
    this.code = code
    this.retryable = RETRYABLE.has(code as OrchErrorCode)
    this.details = details
  }

  get httpStatus(): number {
    const known = ERROR_STATUS as Record<string, number>
    if (this.code in known) return known[this.code]!
    const proposed = PROPOSED_ERROR_CODES as Record<string, number>
    return proposed[this.code] ?? 500
  }
}

/** 提案码统一从这里出，details 里一定带 proposed = true。 */
export function proposedError(code: ProposedErrorCode, message: string, details: Record<string, unknown> = {}): OrchError {
  return new OrchError(code, message, { ...details, proposed: true })
}

/** 非 OrchError 的异常统一折成 SERVICE_UNAVAILABLE，只留 message，不外泄堆栈。 */
export function toOrchError(err: unknown): OrchError {
  if (err instanceof OrchError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new OrchError('SERVICE_UNAVAILABLE', '服务内部错误', { message })
}

export type ReadEnvelope = {
  ok: true
  schema_version: 1
  as_of_seq: number
  generated_at: string
  data: unknown
}

export type FailEnvelope = {
  ok: false
  schema_version: 1
  as_of_seq: number
  error: { code: AnyOrchErrorCode; message: string; retryable: boolean; details: Record<string, unknown> }
}

export function okEnvelope(asOfSeq: number, data: unknown, now = new Date()): ReadEnvelope {
  return { ok: true, schema_version: 1, as_of_seq: asOfSeq, generated_at: now.toISOString(), data }
}

export function failEnvelope(asOfSeq: number, err: OrchError): FailEnvelope {
  return {
    ok: false,
    schema_version: 1,
    as_of_seq: asOfSeq,
    error: { code: err.code, message: err.message, retryable: err.retryable, details: err.details },
  }
}
