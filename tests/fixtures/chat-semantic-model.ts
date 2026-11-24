// A deterministic provider stub for broad native-chat lifecycle tests.
// Semantic accuracy is assessed by separately labeled model replay, not by this stub.
import type { SemanticInput } from '../../src/service/semantic-admission.ts'
import { classifyChatTask, shouldDeferTask } from './legacy-chat-classifier.ts'

export function chatSemanticFixture(input: SemanticInput): unknown {
  const text = input.current.text
  if (text.includes('主脑专属便条')) return { kind: 'brain_notes' }
  if (text.includes('便条') || text.includes('运行注记')) return { kind: 'notes' }
  if (input.draft && ['算了', '取消', '放弃'].includes(text)) {
    return { kind: 'discarded', quote: text, draft_revision: input.draft.revision }
  }
  const task = { kind: 'task', relation: 'new', timing: 'immediate', quote: text, constraints: [], missing: [] }
  if (input.draft && /^用 office-sample\.csv/u.test(text)) {
    return { ...task, relation: 'continue', continuation: 'supply', draft_revision: input.draft.revision,
      answer: { slot: 'materials', value: 'office-sample.csv', quote: text } }
  }
  if (input.explicit) return { ...task, timing: shouldDeferTask(text) ? 'held' : 'immediate' }
  const classification = classifyChatTask(text)
  if (classification === 'conversation') return { kind: 'conversation' }
  if (classification === 'clarify') return { ...task, missing: ['materials'] }
  return input.draft ? { ...task, independent: { action_quote: text.slice(0, 1), subject_quote: text.slice(1) } } : task
}
