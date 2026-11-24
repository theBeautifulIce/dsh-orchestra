import { expect, it } from 'vitest'
import { classifyChatTask, shouldDeferTask } from '../../src/service/chat-task-intent.ts'

it.each([
  'Please summarize the report, do not send emails.',
  "Please review the report, don't publish it.",
  'Please review the report, do not execute shell commands.',
  'Please review the report, do not run scripts.',
  '请汇总这段文字并写摘要：他说“不要执行任何任务”。',
  'Please summarize this report: "do not start any task".',
])('keeps the task with an operation restriction or quoted source: %s', text => {
  expect(shouldDeferTask(text)).toBe(false)
  expect(classifyChatTask(text)).toBe('task')
})

it.each([
  'Please summarize the report, do not start until I confirm.',
  "Please summarize the report, don't execute the task yet.",
  'Please summarize the report, wait for my approval.',
  'Please summarize the report, do not create a new task.',
  '请整理报告，但等我确认后再开始。',
  '请整理报告。先不要执行任何任务。',
])('keeps an explicitly deferred task in conversation: %s', text => {
  expect(shouldDeferTask(text)).toBe(true)
  expect(classifyChatTask(text)).toBe('conversation')
})
