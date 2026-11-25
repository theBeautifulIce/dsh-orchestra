import { z } from 'zod'
import { OrchError } from './errors.ts'

const sentence = z.string().trim().min(1).max(600)
const optionalNote = z.string().trim().max(600).nullish().transform(value => value || undefined)

/** Execution facts, not a prose classifier. Empty search results may still be completed. */
export const executionCompletionSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('completed'), reason: optionalNote, next_action: optionalNote,
    missing: z.array(sentence).max(0).optional() }),
  z.strictObject({ outcome: z.enum(['blocked', 'failed']), reason: sentence, next_action: sentence,
    missing: z.array(sentence).max(12).default([]) }),
])

export type ExecutionCompletion = z.infer<typeof executionCompletionSchema>

export function readExecutionCompletion(report: unknown): ExecutionCompletion | undefined {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return
  const output = (report as { output?: unknown }).output
  if (!output || typeof output !== 'object' || Array.isArray(output) || !Object.hasOwn(output, 'completion')) return
  const completion = executionCompletionSchema.safeParse((output as { completion: unknown }).completion)
  if (!completion.success) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '执行报告的完成度字段不符合要求', { reason: 'execution_report_invalid' })
  return completion.data
}

/** The native DSH adapter opts into this contract; older bridge reports remain readable. */
export function validateDshCompletionReport(report: unknown): void {
  const completion = readExecutionCompletion(report)
  if (!completion) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '执行报告缺少结构化完成度，不能确认任务完成', { reason: 'execution_report_invalid' })
  const status = (report as { status?: unknown }).status
  if (status !== (completion.outcome === 'completed' ? 'done' : 'failed')) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '执行报告的状态与完成度不一致')
  }
}

export function completionBlockReason(completion: Exclude<ExecutionCompletion, { outcome: 'completed' }>): string {
  return `${completion.reason}；下一步：${completion.next_action}`
}
