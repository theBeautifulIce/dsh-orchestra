// src/executor/session.ts —— agent 节点执行器（规格 5.2 行 442-449、4.1 行 272）
import { OrchError } from '../core/errors.ts'
import { assertNoMemoryWriteTool, assertTaskSessionToolsAllowed } from '../core/memory-graph.ts'
import { deriveEffectiveCapability, resolveDeclaredPolicy, type ToolDescriptor, type ToolRegistry } from './tools.ts'

export type ToolPolicy = {
  // allow / deny 都是白名单式的显式清单；没声明的按不给算（规格 5.2 行 444）
  allow?: string[]
  deny?: string[]
  // 声明的副作用面；只许往更严一侧写（规格 4.7 行 396-399）
  declaredPolicy?: 'pure' | 'compensable' | 'irreversible'
}

export type OutputTriplet = {
  payload: unknown
  payloadBytes: number
  payloadTruncated: boolean
  droppedFields: string[]
  summary: string
  artifactRef: { kind: 'artifact_ref' | 'decision_ref' | 'none'; uri?: string; sha256?: string; decisionId?: string }
}

// 未声明默认不给：allow 没提到的工具一律不给（规格 5.2 行 444）
export function resolveToolSet(registry: ToolRegistry, policy: ToolPolicy): ToolDescriptor[] {
  const allow = policy.allow ?? []
  assertNoMemoryWriteTool(allow)
  const deny = new Set(policy.deny ?? [])
  const chosen: ToolDescriptor[] = []
  for (const name of allow) {
    if (deny.has(name)) continue
    // allow 里出现没注册的工具，加载期就要拒（规格 4.7 行 399）
    chosen.push(registry.require(name))
  }
  return chosen
}

// 前向能力推导加声明校验；声明 pure 而推导更宽直接拒（规格 5.2 行 444-445、4.7 行 395-398）
export function checkToolPolicy(registry: ToolRegistry, policy: ToolPolicy): 'pure' | 'compensable' | 'irreversible' {
  const chosen = resolveToolSet(registry, policy)
  const derived = deriveEffectiveCapability(chosen)
  const mutating = chosen.filter((t) => t.capability === 'mutating')
  if (!policy.declaredPolicy) return derived
  return resolveDeclaredPolicy(policy.declaredPolicy, derived, mutating)
}

export const PAYLOAD_LIMIT_BYTES = 64 * 1024
export const SUMMARY_LIMIT_CHARS = 800

export function buildOutputTriplet(raw: {
  payload: unknown
  summary: string
  artifactRef: OutputTriplet['artifactRef']
}): OutputTriplet {
  const droppedFields: string[] = []
  let payload = raw.payload
  let payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  let payloadTruncated = false
  // 超限截断并记，不许静默丢字段（规格 4.1 行 272）
  if (payloadBytes > PAYLOAD_LIMIT_BYTES) {
    const record = payload as Record<string, unknown>
    if (record && typeof record === 'object') {
      const kept: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(record)) {
        const candidate = { ...kept, [key]: value }
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > PAYLOAD_LIMIT_BYTES) {
          droppedFields.push(key)
          continue
        }
        kept[key] = value
      }
      payload = kept
    } else {
      payload = null
      droppedFields.push('payload')
    }
    payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
    payloadTruncated = true
  }
  // 摘要不超过 800 字（规格 5.2 行 447）
  const summary = raw.summary.length > SUMMARY_LIMIT_CHARS ? raw.summary.slice(0, SUMMARY_LIMIT_CHARS) : raw.summary
  return { payload, payloadBytes, payloadTruncated, droppedFields, summary, artifactRef: raw.artifactRef }
}

export type ExecutorAgent = {
  agentId: string
  sessionId: string
  tools: ToolDescriptor[]
}

export type HostAgentFactory = {
  create(input: {
    nodeRunId: string
    attempt: number
    input: unknown
    outputSchema: unknown
    toolPolicy: unknown
    // 不继承主会话历史，只拿节点输入与策略（规格 5.2 行 444-445）
    inheritHistory: false
  }): Promise<{ agentId: string; sessionId: string }>
}

// 指令文本里写明：完成由服务端收口，执行器不许自报完成（规格 5.2 行 448）
export function buildInstruction(input: { nodeId: string; outputSchema: unknown }): string {
  return [
    '你在执行编排里的一个节点，节点编号：' + input.nodeId + '。',
    '只按给的输入与工具策略做事，不要碰主会话的历史。',
    '做完把结果按 outputSchema 交上来；不要自己宣告节点完成，完成由服务端收口。',
  ].join('\n')
}

// 任务会话默认不给工具，storages 读写 deny（规格 5.2 行 445-446）
export const TASK_SESSION_TOOL_POLICY: ToolPolicy = { allow: [], deny: [], declaredPolicy: 'pure' }
export const TASK_SESSION_STORAGE_DENY = ['storages:read', 'storages:write']

/**
 * 任务会话工具策略的解析/下发入口（规格 5.2 行 445-446、9.1 硬边界）：
 * 下发前先过 task_session 面的写工具闸（allow 出现 memory_write / memory_update 直接拒），
 * 再把 storages 读写并进 deny——任务会话默认不给工具，storages 读写一律 deny。
 * 默认策略仍是 TASK_SESSION_TOOL_POLICY（allow=[]）。
 */
export function resolveTaskSessionToolPolicy(policy: ToolPolicy = TASK_SESSION_TOOL_POLICY): ToolPolicy {
  const allow = policy.allow ?? []
  assertTaskSessionToolsAllowed(allow)
  const deny = Array.from(new Set([...(policy.deny ?? []), ...TASK_SESSION_STORAGE_DENY]))
  return { ...policy, allow, deny }
}

export async function createExecutorAgent(
  host: HostAgentFactory,
  registry: ToolRegistry,
  params: { nodeRunId: string; attempt: number; input: unknown; outputSchema: unknown; toolPolicy: ToolPolicy },
): Promise<ExecutorAgent> {
  checkToolPolicy(registry, params.toolPolicy)
  const tools = resolveToolSet(registry, params.toolPolicy)
  const res = await host.create({
    nodeRunId: params.nodeRunId,
    attempt: params.attempt,
    input: params.input,
    outputSchema: params.outputSchema,
    toolPolicy: { allow: tools.map((t) => t.name), deny: params.toolPolicy.deny ?? [] },
    inheritHistory: false,
  })
  return { agentId: res.agentId, sessionId: res.sessionId, tools }
}
