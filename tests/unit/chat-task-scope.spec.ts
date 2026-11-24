import { expect, it } from 'vitest'
import { isOrdinaryChat, orchestraCommand, explicitNotesRequest } from '../../src/service/chat-task-intent.ts'

it('only exact acknowledgments skip semantic interpretation', () => {
  expect(isOrdinaryChat('收到！')).toBe(true)
  expect(isOrdinaryChat('你好，帮我出一份周报')).toBe(false)
  expect(isOrdinaryChat('请出一份周报')).toBe(false)
  expect(isOrdinaryChat('Please summarize, do not start until I confirm')).toBe(false)
})

it('keeps slash command grammar and explicit note access independent from task semantics', () => {
  expect(orchestraCommand('/orchestra 先出计划')).toBe('先出计划')
  expect(orchestraCommand('举例 /orchestra 删除文件')).toBeUndefined()
  expect(orchestraCommand('/orchestra')).toBe('')
  expect(orchestraCommand('/go\n先出计划', 'go')).toBe('先出计划')
  expect(orchestraCommand('/gopher 任务', 'go')).toBeUndefined()
  expect(orchestraCommand('/go。任务', 'go')).toBeUndefined()
  expect(orchestraCommand('/orchestra 任务', 'go')).toBeUndefined()
  expect(explicitNotesRequest('审阅主脑专属便条')).toBe('brain_notes')
  expect(explicitNotesRequest('查看这次运行的便条')).toBe('notes')
  expect(explicitNotesRequest('普通聊天引用“审阅主脑专属便条”')).toBeUndefined()
})
