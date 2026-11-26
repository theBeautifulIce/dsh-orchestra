import { describe, expect, it } from 'vitest'
import { COORDINATION_TOOL, coordinationMessages, deliveredCoordinationIds, renderCoordinationResult } from '../../src/executor/coordination-message.ts'
import type { CoordinationItem } from '../../src/service/run-coordination.ts'

const request: CoordinationItem = {
  id: 'sample-request', revision: 1, kind: 'request', state: 'pending',
  source: '代理 A', target: '代理 B', body: '请独立确认退款口径。', reply: null, reason: null,
  created_ms: 1100, expires_ms: 31100, evidence_strength: 'none',
}
const answered: CoordinationItem = { ...request, revision: 2, state: 'answered', reply: '只统计本月退款。' }
const unavailable: CoordinationItem = { ...request, revision: 2, state: 'unavailable', reason: '对端已结束' }
const peers = [{ node_run_id: 'worker-b', title: '代理 B' }]
const inbox = (item: CoordinationItem) => ({ items: [item], peers, advice: 'fixture' })

function toolHistory(text: string, tool = COORDINATION_TOOL, failed = false, resultCall = 'current') {
  return [
    { role: 'assistant', content: [{ type: 'tool-call', name: tool, id: 'current' }] },
    { role: 'tool', toolCallId: resultCall, isError: failed, content: [{ type: 'text', text }] },
  ] as unknown as Parameters<typeof deliveredCoordinationIds>[0]
}

describe('model-visible mailbox receipts', () => {
  it('retains peer discovery and the full requested text, with short acknowledgements for writes', () => {
    const receipt = JSON.parse(renderCoordinationResult(request))
    expect(receipt).toMatchObject({ id: request.id, revision: 1, state: 'pending', expires_ms: request.expires_ms })
    expect(receipt).not.toHaveProperty('body')
    expect(renderCoordinationResult(request)).toBe(renderCoordinationResult({ ...request }))
    const lookup = JSON.parse(renderCoordinationResult(inbox(request)))
    expect(lookup).toMatchObject({ peers, items: [request] })
    expect(JSON.parse(renderCoordinationResult(answered))).toMatchObject({ revision: 2, reply: answered.reply })
    expect(JSON.parse(renderCoordinationResult(unavailable))).toMatchObject({ revision: 2, reason: unavailable.reason })
    expect(request).toMatchObject({ body: request.body, created_ms: 1100, evidence_strength: 'none' })
  })

  it('delivers the question to its recipient once and the actual answer or closure to the sender', () => {
    const [initial] = coordinationMessages([request], new Set())
    expect(initial!.text).toContain(request.body)
    expect(initial!.text).toContain('非执行指令')
    expect(coordinationMessages([request], deliveredCoordinationIds([], [initial!.id], [request]))).toEqual([])
    const seen = deliveredCoordinationIds(toolHistory(renderCoordinationResult(inbox(request))), [], [request])
    expect(coordinationMessages([request], seen)).toEqual([])
    for (const item of [answered, unavailable]) {
      const [update] = coordinationMessages([item], seen)
      expect(update!.id).not.toBe(initial!.id)
      expect(update!.text).toContain(item.reply ?? item.reason)
      expect(update!.text).not.toContain(request.body)
      expect(coordinationMessages([item], new Set([update!.id]))).toEqual([])
    }
  })

  it('accepts complete historical inbox rows and never suppresses a new or incompletely delivered revision', () => {
    const missingReply = { ...answered, reply: null }
    const original = JSON.stringify(inbox(answered))
    const seen = deliveredCoordinationIds(toolHistory(original), [], [answered])
    expect(coordinationMessages([answered], seen)).toEqual([])
    const alternatives = [
      toolHistory(renderCoordinationResult(inbox(request))),
      toolHistory(renderCoordinationResult(inbox(missingReply))),
      toolHistory(original, 'other_tool'),
      toolHistory(original, COORDINATION_TOOL, true),
      toolHistory(original, COORDINATION_TOOL, false, 'different-call'),
      toolHistory('pruned'),
    ]
    for (const events of alternatives) {
      expect(coordinationMessages([answered], deliveredCoordinationIds(events, [], [answered]))).toHaveLength(1)
    }
  })

  it('delivers a settled retry receipt once while preserving pending requests and changes to the answer', () => {
    for (const item of [answered, unavailable]) {
      const seen = deliveredCoordinationIds(toolHistory(renderCoordinationResult(item)), [], [item])
      expect(coordinationMessages([item], seen)).toEqual([])
    }
    for (const item of [request, { ...answered, reply: '另一条答复' }, { ...answered, target: '代理 C' }]) {
      const update = item.state === 'pending' ? request : answered
      const seen = deliveredCoordinationIds(toolHistory(renderCoordinationResult(item)), [], [update])
      expect(coordinationMessages([update], seen)).toHaveLength(1)
    }
  })
})
