import { OrchError } from '../core/errors.ts'

export const MODEL_COMPLEXITIES = ['routine', 'standard', 'advanced', 'complex', 'expert'] as const
export type ModelComplexity = (typeof MODEL_COMPLEXITIES)[number]

export const MODEL_LEVELS = {
  routine: { label: '常规', description: '规则明确的整理、提取或格式转换' },
  standard: { label: '中等', description: '根据少量资料做独立分析或核对' },
  advanced: { label: '进阶', description: '串联多项依赖或综合多份证据' },
  complex: { label: '复杂', description: '处理难以验证的证据、冲突判断或较高的失败代价' },
  expert: { label: '专家', description: '解决高度不确定的跨领域问题，或作出高代价的关键判断' },
} satisfies Record<ModelComplexity, { label: string; description: string }>
export const MODEL_REF_RE = /^[\w./:@+-]{1,128}$/
export const MODEL_NOTE_MAX_LENGTH = 160

export const MODEL_EFFORT_MAX_LENGTH = 128
export type ModelReasoning = {
  efforts: readonly { id: string; name: string; description?: string }[]
  defaultEffort?: string
}
export type ModelProfile = {
  ref: string; capacity: ModelComplexity; provider?: string; model?: string; reasoning?: ModelReasoning
}
export type ModelCatalogProfile = Omit<ModelProfile, 'capacity'> & {
  capacity: ModelComplexity | null; host_capacity?: ModelComplexity | null; name?: string; provider_name?: string
}
export type ModelCatalogSnapshot = {
  profiles: readonly ModelCatalogProfile[]
  unavailable_providers?: readonly string[]
  session_execution_model_ref?: string
}
export type ModelPlanningProfile = ModelProfile & { user_note: string }
export type ModelRecommendation = { complexity: ModelComplexity; reason: string; preferredModel?: string }
export type ModelTokenUsage = {
  uncached_input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
}
export type ModelAttemptMetering = {
  tokens: ModelTokenUsage
  context_compactions: { summaries: number; tool_result_prunes: number } | null
}
export type ModelUse = {
  provider: string; model: string; observed_request_headers: number; reasoning_effort?: string | null
  metering?: ModelAttemptMetering
}
export type ModelAssignment = {
  model_ref: string; complexity: ModelComplexity; reason: string; usage?: ModelUse; settings_revision?: number
  provider?: string; model?: string
  session_model_fallback?: true
  reasoning_effort?: string | null
}

export function validModelEffort(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MODEL_EFFORT_MAX_LENGTH && !/[\x00-\x1f\x7f]/u.test(value)
}

export function observedCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function readAttemptMetering(value: unknown): ModelAttemptMetering | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { tokens, context_compactions } = value as Partial<ModelAttemptMetering>
  const summaries = observedCount(context_compactions?.summaries)
  const prunes = observedCount(context_compactions?.tool_result_prunes)
  return { tokens: {
    uncached_input_tokens: observedCount(tokens?.uncached_input_tokens),
    output_tokens: observedCount(tokens?.output_tokens),
    cache_read_tokens: observedCount(tokens?.cache_read_tokens),
    cache_write_tokens: observedCount(tokens?.cache_write_tokens),
  }, context_compactions: summaries === null || prunes === null ? null : { summaries, tool_result_prunes: prunes } }
}

export function readModelUse(value: unknown): ModelUse | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const use = value as Partial<ModelUse>
  if (typeof use.provider !== 'string' || !use.provider || use.provider.length > 128
    || typeof use.model !== 'string' || !use.model || use.model.length > 256
    || !Number.isSafeInteger(use.observed_request_headers) || use.observed_request_headers! < 1) return undefined
  const metering = readAttemptMetering(use.metering)
  return { provider: use.provider, model: use.model, observed_request_headers: use.observed_request_headers!,
    ...(metering ? { metering } : {}),
    ...(use.reasoning_effort === null || validModelEffort(use.reasoning_effort) ? { reasoning_effort: use.reasoning_effort } : {}) }
}
export type ModelRoutingContext = {
  taskId: string; runId: string; nodeRunId: string; nodeId: string; attempt: number; actionGeneration: number
  workflowId: string | null; workflowVersion: string | null
}
export type ModelRouting = {
  /** Models already approved for this execution host, in preference order within a capacity. */
  profiles: readonly ModelProfile[]
  /** Personal DSH hosts expose unclassified entries as well as approved execution profiles. */
  catalog?: () => ModelCatalogSnapshot
  refresh?: (signal?: AbortSignal) => Promise<void>
  /** Read the approved task plan synchronously. Dispatch calls this inside a write transaction. */
  recommend(context: ModelRoutingContext): ModelRecommendation
}

/** Choose the requested compatible model or the lowest adequate approved capacity. */
export function selectExecutionModel(profiles: readonly ModelProfile[], recommendation: ModelRecommendation): ModelAssignment {
  const minimum = MODEL_COMPLEXITIES.indexOf(recommendation.complexity)
  const reason = typeof recommendation.reason === 'string' ? recommendation.reason.trim() : ''
  if (minimum < 0 || !reason || reason.length > 240) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '主脑的模型建议缺少合法复杂度或依据')
  }
  const eligible = profiles.filter((profile) => MODEL_REF_RE.test(profile.ref)
    && MODEL_COMPLEXITIES.indexOf(profile.capacity) >= minimum)
  const profile = recommendation.preferredModel === undefined
    ? eligible.sort((left, right) => MODEL_COMPLEXITIES.indexOf(left.capacity) - MODEL_COMPLEXITIES.indexOf(right.capacity))[0]
    : eligible.find((item) => item.ref === recommendation.preferredModel)
  if (!profile) throw new OrchError('FORBIDDEN', '没有获准且满足该节点复杂度的执行模型')
  return { model_ref: profile.ref, complexity: recommendation.complexity, reason }
}
