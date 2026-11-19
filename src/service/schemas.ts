// 每条命令一套 Zod Schema：入参的类型与边界在这里定死，路由层只搬字段
// （评审《第二次意见.md》行 567-621：以前只查字段在不在，再 String()/Number() 硬转，
//   字符串数字、NaN、Infinity 都能一路进服务层）
import { z } from 'zod'
import { UUID_V7_RE } from './commands/idempotency.ts'
import { OrchError } from '../core/errors.ts'
import { TASK_ORIGINS } from '../core/task-workspace.ts'

// 边界集中在这里，改一处就够。
// 区间按「不破坏现有行为」取：租约上界 120000ms 对着现有默认 30s 与动作超时 120s 留了余量。
export const LIMITS = {
  identifierMaxLength: 128,
  titleMaxLength: 200,
  statusMaxLength: 64,
  versionMaxLength: 64,
  pathMaxLength: 256,
  hashMaxLength: 128,
  timestampMaxLength: 64,
  leaseTtlMsMin: 1000,
  leaseTtlMsMax: 120000,
  leaseRenewIntervalMsMin: 100,
  leaseRenewIntervalMsMax: 40000,
  attemptMin: 1,
  attemptMax: 1000,
  toolCommandMaxLength: 256,
  toolArgsMaxCount: 64,
  toolArgMaxLength: 4096,
  toolCwdMaxLength: 1024,
  toolTimeoutMsMin: 1,
  toolTimeoutMsMax: 600000,
  toolsMaxCount: 64,
  nodeIdsMaxCount: 256,
  nodesMaxCount: 200,
  passConditionsMaxCount: 64,
  requiredHashesMaxCount: 64,
  graceMsMax: 600000,
  ledgerMaxKeys: 64,
  ledgerMaxKeyLength: 128,
  ledgerMaxStringLength: 8192,
  ledgerMaxArrayLength: 256,
  ledgerMaxDepth: 6,
} as const

// 取消结果只有这四种：与 src/service/commands/cancel.ts 的判定口径一致
export const CANCEL_RESULTS = ['interrupted', 'not_interruptible', 'already_stopped', 'unknown'] as const

// 入参不合法的回包：错误码沿用 PAYLOAD_SCHEMA_INVALID，信封沿用现有 failEnvelope；
// 状态码改 400 —— 请求体本身不合法与服务端结构错（422）不是一回事
export class RequestValidationError extends OrchError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PAYLOAD_SCHEMA_INVALID', message, details)
  }

  override get httpStatus(): number {
    return 400
  }
}

// 把 Zod 的 issue 翻成人话：哪一项非法、为什么非法都要说清楚，调用方才好改
function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type': return '类型不对，期望 ' + String(issue.expected)
    case 'too_small': return '小于下限 ' + String(issue.minimum)
    case 'too_big': return '大于上限 ' + String(issue.maximum)
    case 'invalid_value': return '取值不在允许的范围里'
    case 'invalid_format': return '格式不对'
    case 'unrecognized_keys': return '有不认识的字段'
    case 'invalid_union': return '类型组合不合法'
    case 'invalid_element': return '元素不合法'
    case 'invalid_key': return '键不合法'
    case 'not_multiple_of': return '不是 ' + String(issue.divisor) + ' 的倍数'
    default: return issue.message
  }
}

export type BodyIssue = { path: string; message: string }

// 统一入口：校验不过就抛 400 的 RequestValidationError，details 里带每一项的问题
export function parseBody<S extends z.ZodType>(schema: S, body: unknown, label: string): z.output<S> {
  const result = schema.safeParse(body)
  if (result.success) return result.data
  const issues: BodyIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map((part) => String(part)).join('.') : '(请求体)',
    message: describeIssue(issue),
  }))
  const summary = issues.map((issue) => issue.path + ' ' + issue.message).join('；')
  throw new RequestValidationError(label + '校验没过：' + summary, { issues })
}

// 标识类字段：非空且有长度上限，防止超长串进库进日志
const identifier = z.string().min(1).max(LIMITS.identifierMaxLength)
// 工作流命名空间与版本号会进复合主键与事件：首尾空白、控制字符与路径分隔符都不收，
// 否则 " a" 与 "a" 会在库里成为两个看起来一样的身份（第48轮 S1 P2）。
const workflowIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const workflowIdentifier = z.string().min(1).max(LIMITS.identifierMaxLength).regex(workflowIdentityPattern, '只能由字母、数字与 . _ : - 组成，且不能以符号开头')
const workflowVersionString = z.string().min(1).max(LIMITS.versionMaxLength).regex(workflowIdentityPattern, '版本号只能由字母、数字与 . _ : - 组成，且不能以符号开头')
// report_id 会进账本事件、还要按列判重：字符集限死，引号与反斜杠这类会破坏 JSON 文本比对的字符不许进（第三十四轮审计 P1-1）
const reportIdentifier = identifier.regex(
  /^[A-Za-z0-9._:-]+$/,
  '只能由字母、数字与 . _ : - 组成',
)

// 租约时长：整数 1000–120000ms（评审给的区间；现有默认 30s 在区间内）
const leaseTtlMs = z.number().int().min(LIMITS.leaseTtlMsMin).max(LIMITS.leaseTtlMsMax)

// 续租间隔：整数 100–40000ms；还要小于租约时长的一半，见 leasePairIssue
const leaseRenewIntervalMs = z.number().int().min(LIMITS.leaseRenewIntervalMsMin).max(LIMITS.leaseRenewIntervalMsMax)

// 与执行层兜底保持一致（src/executor/run-node.ts 的 DEFAULT_LEASE_TTL_MS = 30_000）：
// 请求只给续租间隔时，服务层与执行层得按同一个租约算，否则两边结论会打架
const DEFAULT_LEASE_TTL_MS = 30_000

// 续租间隔与租约时长成对校验：间隔太长会在租约快过期时才续，间隔太短会把库写爆
function leasePairIssue(value: { leaseTtlMs?: number; leaseRenewIntervalMs?: number }): string | null {
  if (value.leaseRenewIntervalMs === undefined) return null
  const ttl = value.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  if (value.leaseRenewIntervalMs >= ttl / 2) {
    return '续租间隔必须小于租约时长的一半（当前租约 ' + String(ttl) + 'ms）'
  }
  return null
}

// 一次只读工具调用：命令非空、参数是字符串数组、工作目录是字符串、超时有上下界
export const toolSchema = z.object({
  command: z.string().min(1).max(LIMITS.toolCommandMaxLength),
  args: z.array(z.string().max(LIMITS.toolArgMaxLength)).max(LIMITS.toolArgsMaxCount),
  cwd: z.string().min(1).max(LIMITS.toolCwdMaxLength),
  timeoutMs: z.number().int().min(LIMITS.toolTimeoutMsMin).max(LIMITS.toolTimeoutMsMax),
})

// 一个节点的执行规格：工具清单有上限，input/outputSchema 由执行器自己解释。
// 控制节点配置不在这里：wait/subworkflow 的执行参数只能来自已签名的工作流定义（审计 P1-1）。
const nodeSpecSchema = z.looseObject({
  tools: z.array(toolSchema).max(LIMITS.toolsMaxCount),
  input: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
})

// 通过条件：path 与 op 只做有界字符串，越界判定留给判定层（VERDICT_UNSUPPORTED）
const passConditionSchema = z.looseObject({
  path: z.string().min(1).max(LIMITS.pathMaxLength),
  op: z.string().min(1).max(LIMITS.statusMaxLength),
  value: z.unknown().optional(),
})

// 加载定义：定义哈希按整个 body 算，未知键必须原样保留，所以用 looseObject
export const workflowLoadSchema = z.looseObject({
  // 工作流命名空间；省略即 default，旧客户端不需要改
  workflow_id: workflowIdentifier.optional(),
  workflow_version: z.union([workflowVersionString, z.number().int().nonnegative()])
    .transform((value) => String(value)),
  nodes: z.array(z.looseObject({
    node_id: identifier,
    // 节点类型不在这里收成枚举：未知类型要落到目录层判 SCHEMA_VERSION_UNSUPPORTED（422）
    type: z.string().min(1).max(LIMITS.statusMaxLength).optional(),
    tools: z.looseObject({
      allow: z.array(z.string().max(LIMITS.toolCommandMaxLength)).max(LIMITS.toolsMaxCount).optional(),
      deny: z.array(z.string().max(LIMITS.toolCommandMaxLength)).max(LIMITS.toolsMaxCount).optional(),
    }).optional(),
    pass_conditions: z.array(passConditionSchema).max(LIMITS.passConditionsMaxCount).optional(),
    required_hashes: z.array(z.string().min(1).max(LIMITS.identifierMaxLength)).max(LIMITS.requiredHashesMaxCount).optional(),
    // 控制节点配置属于定义内容，随定义一起被哈希固定
    wait: z.looseObject({
      wait_kind: z.enum(['event', 'timer']),
      match: z.looseObject({
        type: z.string().min(1).max(LIMITS.statusMaxLength),
        path: z.string().max(LIMITS.pathMaxLength).optional(),
        equals: z.unknown().optional(),
      }),
      max_wait_ms: z.number().int().positive(),
      from_seq: z.number().int().nonnegative().optional(),
    }).optional(),
    subworkflow: z.looseObject({
      workflow_id: workflowIdentifier,
      pinned_version: z.number().int().positive(),
      resume_from: z.string().nullable().optional(),
    }).optional(),
  })).max(LIMITS.nodesMaxCount),
  pass_conditions: z.array(passConditionSchema).max(LIMITS.passConditionsMaxCount).optional(),
  required_hashes: z.array(z.string().min(1).max(LIMITS.identifierMaxLength)).max(LIMITS.requiredHashesMaxCount).optional(),
})

// 建 run：标题与版本号都要有，节点清单可选但有上限
export const createRunSchema = z.looseObject({
  taskTitle: z.string().min(1).max(LIMITS.titleMaxLength),
  // 两个工作流各有同版本号时必须带；省略按唯一版本或 default 解析
  workflowId: workflowIdentifier.optional(),
  workflowVersion: z.union([workflowVersionString, z.number().int().nonnegative()])
    .transform((value) => String(value)),
  nodeIds: z.array(identifier).max(LIMITS.nodeIdsMaxCount).optional(),
})

// 派发：run 标识、节点规格表、租约三元组
export const startRunSchema = z.looseObject({
  // 预留任务号：绑定 reserveTask 的可信 task_id
  task_id: z.string().min(1).max(128).optional(),
  taskTitle: z.string().min(1).max(LIMITS.titleMaxLength),
  workflowId: workflowIdentifier.optional(),
  workflowVersion: z.union([workflowVersionString, z.number().int().nonnegative()])
    .transform((value) => String(value)),
  nodeIds: z.array(identifier).max(LIMITS.nodeIdsMaxCount).optional(),
  autonomy: z.enum(['autonomous', 'assisted', 'supervised']).optional(),
  triggerKind: z.enum(TASK_ORIGINS).optional(),
  escalations: z.array(z.looseObject({
    kind: z.enum(['node_type', 'action_category', 'workflow_version_publish']),
    value: z.string().min(1).max(LIMITS.identifierMaxLength),
  })).max(64).optional(),
  operationId: identifier,
})

export const taskArchiveSchema = z.strictObject({
  task_id: identifier, archived: z.boolean(), expected_archived_at: z.iso.datetime().nullable(),
  operation_id: z.string().regex(UUID_V7_RE),
})

export const RESOLUTIONS = [
  'approved', 'rejected', 'expired', 'confirm_applied', 'confirm_not_applied',
  'confirm_started', 'confirm_not_started', 'continue_tracking', 'continue_wait',
  'abandon', 'uphold_report', 'uphold_decision',
] as const

export const resolveDecisionSchema = z.looseObject({
  operation_id: z.string().regex(UUID_V7_RE).optional(),
  confirm_challenge: z.string().min(1).max(4096).optional(),
  decisionId: identifier,
  revision: z.number().int().positive(),
  resolution: z.enum(RESOLUTIONS),
  payload: z.record(z.string(), z.unknown()).optional(),
  actor: z.looseObject({
    kind: z.enum(['human', 'agent']),
    id: identifier,
    capabilities: z.array(identifier).optional(),
  }).optional(),
  evidenceProducers: z.array(identifier).max(64).optional(),
  confirm: z.boolean().optional(),
  // 审批绑定的内容哈希：卡上有哈希时必须逐字匹配，否则不恢复节点
  contentHash: z.string().min(1).max(128).optional(),
})

export const acknowledgeDecisionSchema = z.strictObject({
  operation_id: z.string().regex(UUID_V7_RE),
  decisionId: identifier,
  revision: z.number().int().positive(),
})

export const memoryStartSchema = z.strictObject({
  source_run_id: identifier,
  request_key: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  reason: z.string().min(1).max(500),
  retry: z.boolean().optional(),
  operation_id: z.string().regex(UUID_V7_RE),
})

export const memoryInspectSchema = z.strictObject({ batch_id: identifier })

export const memoryRecoverySchema = memoryInspectSchema.extend({
  decision_id: identifier,
  revision: z.number().int().positive(),
  resolution: z.enum(['confirm_applied', 'confirm_not_applied', 'abandon', 'acknowledge_abandon']),
  stopped_at: z.string().min(1).max(64),
  evidence_id: identifier,
  operation_id: z.string().regex(UUID_V7_RE),
})

// 副作用结算写入口（附录 §12 A1）：服务命令的唯一受控入口，普通 Agent 无权调用。
export const effectResolveSchema = z.looseObject({
  basis: z.enum(['verified_none', 'evidence', 'decision']),
  node_run_id: identifier,
  run_id: identifier.optional(),
  evidence_id: identifier.optional(),
  decision_id: identifier.optional(),
  stop_evidence: z.string().min(1).max(256).optional(),
  evidence_source: z.enum(['run_tool', 'tool_result']).optional(),
  expected: z.looseObject({
    revision: z.number().int().nonnegative(),
    decision_revision: z.number().int().nonnegative().optional(),
  }),
  operation_id: z.string().regex(UUID_V7_RE, 'operation_id 必须是 UUIDv7'),
})

export const dispatchSchema = z.looseObject({
  runId: identifier,
  nodes: z.record(identifier, nodeSpecSchema),
  ownerEpoch: z.number().int().nonnegative().optional(),
  leaseTtlMs: leaseTtlMs.optional(),
  leaseRenewIntervalMs: leaseRenewIntervalMs.optional(),
}).superRefine((value, ctx) => {
  const message = leasePairIssue(value)
  if (message) ctx.addIssue({ code: 'custom', path: ['leaseRenewIntervalMs'], message })
  if (Object.keys(value.nodes).length > LIMITS.nodesMaxCount) {
    ctx.addIssue({ code: 'custom', path: ['nodes'], message: '节点数超过上限 ' + String(LIMITS.nodesMaxCount) })
  }
  // 控制节点类型必须在派发时由定义决定：请求体带 control 就是试图替换已签名目标，直接拒。
  for (const [nodeId, spec] of Object.entries(value.nodes)) {
    if ((spec as Record<string, unknown>).control !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['nodes', nodeId, 'control'],
        message: '控制节点配置只能写在已签名的工作流定义里（wait / subworkflow 字段），请求体不能指定',
      })
    }
  }
})

// 拿租约：租约时长与 owner 代次都要严格
export const leaseSchema = z.looseObject({
  nodeRunId: identifier,
  ownerEpoch: z.number().int().nonnegative(),
  leaseTtlMs: leaseTtlMs,
})

// 续租：只搬 nodeRunId 与租约时长
export const renewSchema = z.looseObject({
  nodeRunId: identifier,
  leaseTtlMs: leaseTtlMs,
})

// 上报：报告体自己也要有标识与状态，不能只查字段在不在
export const confirmStartSchema = z.looseObject({
  nodeRunId: identifier,
  attempt: z.number().int().min(LIMITS.attemptMin).max(LIMITS.attemptMax),
  attested: z.boolean().optional(),
})

export const reportSchema = z.looseObject({
  nodeRunId: identifier,
  attempt: z.number().int().min(LIMITS.attemptMin).max(LIMITS.attemptMax),
  report: z.looseObject({
    report_id: reportIdentifier,
    node_run_id: identifier,
    attempt: z.number().int().min(LIMITS.attemptMin).max(LIMITS.attemptMax),
    status: z.string().min(1).max(LIMITS.statusMaxLength),
    evidence: z.looseObject({
      source: z.string().min(1).max(LIMITS.statusMaxLength),
      exitCode: z.number().int().optional(),
      stdoutHash: z.string().max(LIMITS.hashMaxLength).optional(),
      stderrHash: z.string().max(LIMITS.hashMaxLength).optional(),
      hashes: z.record(z.string().max(LIMITS.hashMaxLength), z.string().max(LIMITS.hashMaxLength)).optional(),
      producedAt: z.string().max(LIMITS.timestampMaxLength).optional(),
      tool: z.string().max(LIMITS.toolCommandMaxLength).optional(),
      commandHash: z.string().max(LIMITS.hashMaxLength).optional(),
    }).optional(),
    output: z.unknown().optional(),
    error_code: z.string().min(1).max(LIMITS.statusMaxLength).optional(),
  }),
  expectedStatus: z.string().min(1).max(LIMITS.statusMaxLength),
  generation: z.number().int().nonnegative(),
  decision: z.looseObject({
    decisionId: identifier,
    revision: z.number().int().positive(),
    resolution: z.enum(['confirm_applied', 'confirm_not_applied', 'uphold_report', 'uphold_decision']),
  }).optional(),
})

// 生产执行入口：工具清单必须合法，租约三元组可选
export const runNodeSchema = z.looseObject({
  nodeRunId: identifier,
  nodeId: identifier,
  attempt: z.number().int().min(LIMITS.attemptMin).max(LIMITS.attemptMax),
  tools: z.array(toolSchema).max(LIMITS.toolsMaxCount),
  input: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  ownerEpoch: z.number().int().nonnegative().optional(),
  leaseTtlMs: leaseTtlMs.optional(),
  leaseRenewIntervalMs: leaseRenewIntervalMs.optional(),
}).superRefine((value, ctx) => {
  const message = leasePairIssue(value)
  if (message) ctx.addIssue({ code: 'custom', path: ['leaseRenewIntervalMs'], message })
})

// 取消：结果枚举、宽限与延期都有上下界
export const cancelSchema = z.looseObject({
  nodeRunId: identifier,
  attempt: z.number().int().min(LIMITS.attemptMin).max(LIMITS.attemptMax),
  revision: z.number().int().nonnegative(),
  cancelResult: z.enum(CANCEL_RESULTS),
  graceMs: z.number().int().min(0).max(LIMITS.graceMsMax),
  extendDeadlineMs: z.number().int().min(0).max(LIMITS.graceMsMax).optional(),
})

// 恢复不确定的确认：只有一种收口语义，revision 必须与读到的行一致（评审 P2-4）
export const recoveryResolveSchema = z.looseObject({
  nodeRunId: identifier,
  revision: z.number().int().nonnegative(),
  resolution: z.enum(['mark_indeterminate_side_effect']),
})

// 补偿：描述符必须能真正执行，参数只收字符串数组；收口状态只收三个终态
export const compensateStartSchema = z.looseObject({
  nodeRunId: identifier,
  attempt: z.number().int().min(LIMITS.attemptMin).max(LIMITS.attemptMax),
  descriptor: z.looseObject({
    tool: z.string().min(1).max(LIMITS.toolCommandMaxLength),
    args: z.array(z.string().max(LIMITS.hashMaxLength)).max(LIMITS.toolsMaxCount),
    verify: z.looseObject({
      command: z.string().min(1).max(LIMITS.toolCommandMaxLength),
      args: z.array(z.string().max(LIMITS.hashMaxLength)).max(LIMITS.toolsMaxCount),
    }),
    descriptorVersion: z.string().min(1).max(LIMITS.statusMaxLength),
  }),
})

export const compensateSettleSchema = z.looseObject({
  compensationId: identifier,
  state: z.enum(['applied', 'failed', 'unverified']),
  evidence: z.unknown().optional(),
  reason: z.string().max(LIMITS.statusMaxLength).optional(),
})

// 等待事件：先落 inbox，再由服务端回放匹配；事件体只做通用限长
export const waitEventSchema = z.looseObject({
  runId: identifier,
  eventType: z.string().min(1).max(LIMITS.statusMaxLength),
  payload: z.unknown().optional(),
  idempotencyKey: z.string().min(1).max(LIMITS.hashMaxLength).nullish(),
})

// 运行级取消：父运行取消必须向子 run 传播；节点级取消仍走 /v1/node-runs/cancel
export const cancelRunSchema = z.looseObject({
  runId: identifier,
  cancelResult: z.enum(CANCEL_RESULTS),
  graceMs: z.number().int().min(0).max(LIMITS.graceMsMax),
  extendDeadlineMs: z.number().int().min(0).max(LIMITS.graceMsMax).optional(),
})

type LedgerProblem = { path: (string | number)[]; message: string }

// 账本事件的体由宿主解释，字段随调用方变；这里只挡明显会打垮服务的负载：
// 字段太多、字段名太长、字符串太长、数组太长、嵌套太深
function collectLedgerProblems(value: unknown, path: (string | number)[], depth: number): LedgerProblem[] {
  const problems: LedgerProblem[] = []
  if (depth > LIMITS.ledgerMaxDepth) {
    problems.push({ path, message: '嵌套层数超过上限 ' + String(LIMITS.ledgerMaxDepth) })
    return problems
  }
  if (typeof value === 'string') {
    if (value.length > LIMITS.ledgerMaxStringLength) {
      problems.push({ path, message: '字符串长度超过上限 ' + String(LIMITS.ledgerMaxStringLength) })
    }
    return problems
  }
  if (Array.isArray(value)) {
    if (value.length > LIMITS.ledgerMaxArrayLength) {
      problems.push({ path, message: '数组长度超过上限 ' + String(LIMITS.ledgerMaxArrayLength) })
    }
    value.forEach((item, index) => { problems.push(...collectLedgerProblems(item, [...path, index], depth + 1)) })
    return problems
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length > LIMITS.ledgerMaxKeys) {
      problems.push({ path, message: '字段数超过上限 ' + String(LIMITS.ledgerMaxKeys) })
    }
    for (const key of keys) {
      if (key.length > LIMITS.ledgerMaxKeyLength) {
        problems.push({ path: [...path, key], message: '字段名长度超过上限 ' + String(LIMITS.ledgerMaxKeyLength) })
      }
      problems.push(...collectLedgerProblems(record[key], [...path, key], depth + 1))
    }
  }
  return problems
}

// 写账本事件：体必须是一个对象，字段与值都要有上限
export const ledgerEventSchema = z.looseObject({}).superRefine((value, ctx) => {
  for (const problem of collectLedgerProblems(value, [], 1).slice(0, 10)) {
    ctx.addIssue({ code: 'custom', path: problem.path, message: problem.message })
  }
})

// —— S4 工作流命令：四个写命令都强制 operation_id（规格 3.7），读命令不需要 ——
// 正则只在 idempotency.ts 定义一次：HTTP 与命令层共用同一套规则（审计 P3）
const operationId = z.string().regex(UUID_V7_RE, 'operation_id 必须是 UUIDv7')
const workflowName = z.string().min(1).max(80)

export const taskReserveSchema = z.object({
  operation_id: operationId,
  title: z.string().min(1).max(200),
})

export const workflowCreateCommandSchema = z.object({
  operation_id: operationId,
  workflow_id: identifier,
  name: workflowName,
  definition: z.unknown(),
  // owner_task_id 不接受客户端自报：task_local 的归属只能来自预留任务的可信上下文（审计 P1-2）
  scope: z.enum(['reusable', 'task_local']).optional(),
})

export const workflowOpenDraftCommandSchema = z.object({
  operation_id: operationId,
  workflow_id: identifier,
  base_version: z.number().int().nonnegative(),
})

export const workflowUpdateCommandSchema = z.object({
  operation_id: operationId,
  workflow_id: identifier,
  revision: z.number().int().positive(),
  definition: z.unknown(),
})

export const workflowPublishCommandSchema = z.object({
  operation_id: operationId,
  workflow_id: identifier,
  revision: z.number().int().positive(),
  base_version: z.number().int().nonnegative(),
  publish_note: z.string().min(1).max(500),
})
export const workflowTestSchema = z.strictObject({ workflow_id: identifier, revision: z.number().int().positive() })
export const workflowStatusSchema = z.strictObject({
  workflow_id: identifier, operation_id: operationId,
  status: z.enum(['active', 'disabled']), expected_status: z.enum(['active', 'disabled']),
})
export const workflowGenerateSchema = z.strictObject({ goal: z.string().trim().min(1).max(2000) })
