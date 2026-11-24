import { shouldDeferTask } from './chat-task-intent.ts'
import { z } from 'zod'
const clauseEvidence = z.strictObject({
  target: z.enum(['task','material','tool','conversation']),
  act: z.enum(['perform','restrict','defer','ask','unclear']),
  quote: z.string().min(1).max(2000),
})
const routingEvidence = z.strictObject({clauses:z.array(clauseEvidence).min(1).max(16)})

// 仅用于候选或歧义的自动接管；普通问答仍直接交回。输出不能授予工具权限。
export function decideAutoRoute(text: string, raw: unknown): 'task'|'clarify'|'conversation' {
  const result = routingEvidence.safeParse(raw)
  if (!result.success || result.data.clauses.some(c => !text.includes(c.quote))) return 'clarify'
  const clauses = result.data.clauses
  if (shouldDeferTask(text) || clauses.some(c => c.target === 'task' && c.act === 'defer')) return 'conversation'
  if (clauses.some(c => c.act === 'unclear')) return 'clarify'
  if (clauses.some(c => c.target === 'task' && c.act === 'perform')) return 'task'
  return 'conversation'
}