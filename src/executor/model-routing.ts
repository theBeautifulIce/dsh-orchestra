import { OrchError } from '../core/errors.ts'

export const MODEL_COMPLEXITIES = ['routine', 'standard', 'complex'] as const
export type ModelComplexity = (typeof MODEL_COMPLEXITIES)[number]

export type ModelProfile = { ref: string; capacity: ModelComplexity }
export type ModelRecommendation = { complexity: ModelComplexity; reason: string; preferredModel?: string }
export type ModelUse = { provider: string; model: string; observed_request_headers: number }
export type ModelAssignment = { model_ref: string; complexity: ModelComplexity; reason: string; usage?: ModelUse; settings_revision?: number }

export function readModelUse(value: unknown): ModelUse | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const use = value as Partial<ModelUse>
  if (typeof use.provider !== 'string' || !use.provider || use.provider.length > 128
    || typeof use.model !== 'string' || !use.model || use.model.length > 256
    || !Number.isSafeInteger(use.observed_request_headers) || use.observed_request_headers! < 1) return undefined
  return { provider: use.provider, model: use.model, observed_request_headers: use.observed_request_headers! }
}
export type ModelRoutingContext = {
  taskId: string; runId: string; nodeRunId: string; nodeId: string; attempt: number; actionGeneration: number
  workflowId: string | null; workflowVersion: string | null
}
export type ModelRouting = {
  /** Models already approved for this execution host, in preference order within a capacity. */
  profiles: readonly ModelProfile[]
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
  const eligible = profiles.filter((profile) => /^[\w./:@+-]{1,128}$/.test(profile.ref)
    && MODEL_COMPLEXITIES.indexOf(profile.capacity) >= minimum)
  const profile = recommendation.preferredModel === undefined
    ? eligible.sort((left, right) => MODEL_COMPLEXITIES.indexOf(left.capacity) - MODEL_COMPLEXITIES.indexOf(right.capacity))[0]
    : eligible.find((item) => item.ref === recommendation.preferredModel)
  if (!profile) throw new OrchError('FORBIDDEN', '没有获准且满足该节点复杂度的执行模型')
  return { model_ref: profile.ref, complexity: recommendation.complexity, reason }
}
