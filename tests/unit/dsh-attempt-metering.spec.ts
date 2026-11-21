import { expect, it } from 'vitest'
import { readDshAttemptMetering } from '../../src/executor/dsh-attempt-metering.ts'
import { readModelUse } from '../../src/executor/model-routing.ts'
import { describeEvent } from '../../src/service/queries/execution-history.ts'

const sample = (inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number) => ({
  inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
})
const usage = (value: ReturnType<typeof sample>) => ({ type: 'chunk', chunk: { type: 'usage', usage: value } })

it('uses the last usage sample for a settlement and closes only a matching retry slot', () => {
  const events = [
    { seq: 1, type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [usage(sample(4, 4, 4, 4)), usage(sample(5, 6, 7, 8))] } },
    { seq: 2, type: 'llm/retry-started', data: { turn: 1, step: 1 } },
    { seq: 3, type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [usage(sample(5, 6, 7, 8))] } },
    { seq: 4, type: 'assistant/message', data: { turn: 1, step: 1, usage: sample(11, 13, 17, 19), stream: [usage(sample(90, 90, 90, 90))] } },
    { seq: 5, type: 'tool/call', data: { turn: 1, step: 1 } },
    { seq: 6, type: 'tool/result', data: { turn: 1, step: 1 } },
    { seq: 7, type: 'assistant/message', data: { turn: 1, step: 2, usage: sample(23, 29, 31, 37) } },
  ]
  expect(readDshAttemptMetering(events, true)).toEqual({
    tokens: { uncached_input_tokens: 39, output_tokens: 48, cache_read_tokens: 55, cache_write_tokens: 64 },
    context_compactions: { summaries: 0, tool_result_prunes: 0 },
  })
})

it('does not turn absent, invalid or overflowing counters into zeros or partial totals', () => {
  const first = { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1,
    usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cacheWriteTokens: -1 } } }
  const second = { seq: 2, type: 'assistant/message', data: { turn: 1, step: 2, usage: sample(1, 0, 4, 2) } }
  expect(readDshAttemptMetering([first, second], false)).toEqual({
    tokens: { uncached_input_tokens: null, output_tokens: 0, cache_read_tokens: null, cache_write_tokens: null },
    context_compactions: null,
  })
  expect(readDshAttemptMetering([second, { seq: 3, type: 'assistant/attempt', data: { turn: 1, step: 3, stream: [] } }], false)
    .tokens.output_tokens).toBeNull()
})

it('counts only the matching replacement pairs and ignores other compaction lifecycle records', () => {
  const shadowedRange = { start: 12, end: 4 }
  const surfaceOp = { op: 'replace', startSeq: 12, endSeq: 4 }
  const events = [
    { seq: 20, type: 'compaction/start', data: { compactionId: 'one' } },
    { seq: 21, type: 'compaction/summary', data: { compactionId: 'one', shadowedRange, usage: sample(9, 8, 7, 6) } },
    { seq: 22, type: 'user/message', data: {}, surfaceOp },
    { seq: 23, type: 'compaction/end', data: { compactionId: 'one' } },
    { seq: 24, type: 'compaction/prune', data: { shadowedRange } },
    { seq: 25, type: 'tool/result', data: {}, surfaceOp },
    { seq: 26, type: 'compaction/start', data: { compactionId: 'failed' } },
    { seq: 27, type: 'compaction/end', data: { compactionId: 'failed', error: 'fixture' } },
  ]
  expect(readDshAttemptMetering(events, false)).toEqual({
    tokens: { uncached_input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null },
    context_compactions: { summaries: 1, tool_result_prunes: 1 },
  })
  expect(readDshAttemptMetering(events.slice(0, 5), true).context_compactions).toBeNull()
})

it('preserves old model receipts and accepts only whitelisted numeric metering fields', () => {
  const legacy = { provider: 'fixture', model: 'meter', observed_request_headers: 2 }
  expect(readModelUse(legacy)).toEqual(legacy)
  expect(readModelUse({ ...legacy, metering: {
    tokens: { uncached_input_tokens: 1, output_tokens: 0, cache_read_tokens: '4', cache_write_tokens: -1, raw: 'drop' },
    context_compactions: { summaries: 0, tool_result_prunes: 2, raw: 'drop' },
  } })).toEqual({ ...legacy, metering: {
    tokens: { uncached_input_tokens: 1, output_tokens: 0, cache_read_tokens: null, cache_write_tokens: null },
    context_compactions: { summaries: 0, tool_result_prunes: 2 },
  } })
})

it('shows historical attempts from host metering and ignores model-supplied report counters', () => {
  const host = describeEvent('executor.model_used', JSON.stringify({ attempt: 2, usage: {
    provider: 'fixture', model: 'meter', observed_request_headers: 1,
    metering: { tokens: { output_tokens: 0 }, context_compactions: { summaries: 1, tool_result_prunes: 0 } },
  } }))
  expect(host).toEqual(expect.arrayContaining([
    { label: '尝试次数', value: '2' }, { label: '输入（未缓存）Token', value: '不可用' },
    { label: '输出 Token', value: '0' }, { label: '上下文摘要次数', value: '1' },
  ]))
  expect(describeEvent('bridge.turn', JSON.stringify({ attempt: 3, payload: {
    kind: 'report', report: { status: 'done', output: {}, model_use: { metering: { tokens: { output_tokens: 999 } } } },
  } }))).not.toEqual(expect.arrayContaining([{ label: '输出 Token', value: '999' }]))
})
