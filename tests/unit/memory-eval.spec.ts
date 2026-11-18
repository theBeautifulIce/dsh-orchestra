// S5-F：memory.evaluate 评估端口的纯逻辑层（规格 9.5 行 712-724、9.6 行 725-734、9.11 行 778-838）
// 计划 Task 13 行 2008-2015 中属于纯逻辑的部分：解析失败、截断处置、判定规则、审批卡文案。
import { describe, expect, it } from 'vitest'
import { OrchError } from '../../src/core/errors.ts'
import {
  EVAL_RESPONSE_MAX_BYTES,
  JUDGE_CONTENT_LIMIT,
  assertEvalShape,
  buildApprovalCard,
  buildEvaluateRequest,
  parseJudgeResponse,
  summarize,
  type EvalItem,
} from '../../src/core/memory-eval.ts'
import type { MemoryItemInput } from '../../src/core/memory-canonical.ts'

function errOf(fn: () => unknown): OrchError {
  try {
    fn()
  } catch (err) {
    if (err instanceof OrchError) return err
    throw err
  }
  throw new Error('本应抛错却通过了')
}

/** 规格 9.11 行 821-837 的裁判响应体 */
function judgeResponse(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    batch_id: '01JBATCH000000000000000000000',
    recommendation: 'ready',
    items: [
      {
        client_key: 'audit-fail-closed',
        verdict: 'approve',
        confidence: 0.86,
        reason: '和已有条目主题一致，但结论更新，建议写入',
        conflict_with: null,
      },
    ],
    summary: '3 条建议写入，1 条和已有记忆重复',
    model: { provider: 'spawn', name: 'default', prompt_version: 'memory-audit-v1' },
    duration_ms: 4210,
    ...over,
  })
}

function evalItem(clientKey: string, verdict: EvalItem['verdict'], over: Partial<EvalItem> = {}): EvalItem {
  return { client_key: clientKey, verdict, reason: '理由', confidence: 0.9, conflict_with: null, ...over }
}

function prepared(clientKey: string, over: Partial<MemoryItemInput> = {}): MemoryItemInput {
  return {
    client_key: clientKey,
    action: 'create',
    target_id: null,
    layer: 'L4',
    title: `标题 ${clientKey}`,
    content: `内容 ${clientKey}`,
    tags: [],
    questions: [],
    key: null,
    importance: 5,
    ttl_days: null,
    quote: '引文',
    reason: '原因',
    ...over,
  }
}

describe('裁判响应解析（规格 9.5 行 721-722；计划 Task 13 行 1962）', () => {
  it('裁判返回非 JSON → MEMORY_EVAL_INVALID_OUTPUT', () => {
    const err = errOf(() => parseJudgeResponse('这不是 JSON'))
    expect(err.code).toBe('MEMORY_EVAL_INVALID_OUTPUT')
    expect(err.httpStatus).toBe(502)
  })

  it('裁判响应缺 items → MEMORY_EVAL_INVALID_OUTPUT', () => {
    const err = errOf(() => parseJudgeResponse(JSON.stringify({ ok: true, batch_id: 'b', recommendation: 'ready' })))
    expect(err.code).toBe('MEMORY_EVAL_INVALID_OUTPUT')
  })

  it('verdict=maybe → MEMORY_EVAL_INVALID_OUTPUT', () => {
    const err = errOf(() => parseJudgeResponse(judgeResponse({
      items: [{ client_key: 'a', verdict: 'maybe', confidence: 0.5, reason: '不知道' }],
    })))
    expect(err.code).toBe('MEMORY_EVAL_INVALID_OUTPUT')
  })

  it('confidence 不是数字 → MEMORY_EVAL_INVALID_OUTPUT', () => {
    const err = errOf(() => parseJudgeResponse(judgeResponse({
      items: [{ client_key: 'a', verdict: 'approve', confidence: 'high', reason: '很好' }],
    })))
    expect(err.code).toBe('MEMORY_EVAL_INVALID_OUTPUT')
  })

  it('响应超过 64 KiB → MEMORY_EVAL_INVALID_OUTPUT', () => {
    const raw = JSON.stringify({ ok: true, batch_id: 'b', items: [], pad: 'x'.repeat(EVAL_RESPONSE_MAX_BYTES) })
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(EVAL_RESPONSE_MAX_BYTES)
    const err = errOf(() => parseJudgeResponse(raw))
    expect(err.code).toBe('MEMORY_EVAL_INVALID_OUTPUT')
  })

  it('合法响应解析出逐条建议与模型信息', () => {
    const result = parseJudgeResponse(judgeResponse())
    expect(result.recommendation).toBe('ready')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.verdict).toBe('approve')
    expect(result.items[0]?.confidence).toBe(0.86)
    expect(result.model).toEqual({ provider: 'spawn', name: 'default', prompt_version: 'memory-audit-v1' })
    expect(result.summary).toBe('3 条建议写入，1 条和已有记忆重复')
    expect(result.duration_ms).toBe(4210)
    expect(result.truncated).toBe(false)
  })
})

describe('截断处置（规格 9.5 行 718、720；计划 Task 13 行 2009）', () => {
  it('truncated=true 且 verdict=approve → MEMORY_EVAL_INVALID_OUTPUT（不进 ready）', () => {
    const err = errOf(() => parseJudgeResponse(judgeResponse({ truncated: true })))
    expect(err.code).toBe('MEMORY_EVAL_INVALID_OUTPUT')
    const shapeErr = errOf(() => assertEvalShape([evalItem('a', 'approve')], true))
    expect(shapeErr.code).toBe('MEMORY_EVAL_INVALID_OUTPUT')
  })

  it('truncated=true 且含 needs_user → 允许且 recommendation=blocked', () => {
    const raw = judgeResponse({
      truncated: true,
      recommendation: 'blocked',
      items: [{ client_key: 'a', verdict: 'needs_user', confidence: 0.4, reason: '拿不准', conflict_with: null }],
    })
    const result = parseJudgeResponse(raw)
    expect(result.recommendation).toBe('blocked')
    expect(result.truncated).toBe(true)
    expect(() => assertEvalShape(result.items, true)).not.toThrow()
  })
})

describe('判定规则（规格 9.5 行 719；计划 Task 13 行 2010-2011）', () => {
  it('任一 needs_user → blocked', () => {
    expect(summarize([evalItem('a', 'approve'), evalItem('b', 'needs_user')])).toBe('blocked')
  })

  it('2 approve 1 reject → ready', () => {
    expect(summarize([evalItem('a', 'approve'), evalItem('b', 'approve'), evalItem('c', 'reject')])).toBe('ready')
  })

  it('空 items → empty', () => {
    expect(summarize([])).toBe('empty')
    expect(summarize([evalItem('a', 'reject')])).toBe('empty')
  })
})

describe('审批卡（规格 9.6 行 727-730；计划 Task 13 行 2011）', () => {
  it('首行与两个按钮文案逐字', () => {
    const card = buildApprovalCard(
      [prepared('a'), prepared('b'), prepared('c')],
      [evalItem('a', 'approve', { reason: '值得记' }), evalItem('b', 'merge'), evalItem('c', 'reject')],
    )
    expect(card.title).toBe('这几条要写进记忆，你看看')
    expect(card.summary_line).toBe('这次整理出 3 条 / 建议写入 2 条 / 不写 1 条')
    expect(card.buttons.map((button) => button.label)).toEqual(['按这个方案写入', '这次不写'])
    expect(card.buttons.map((button) => button.resolution)).toEqual(['approved', 'rejected'])
    expect(card.kind).toBe('audit_result')
    expect(card.allowed_resolutions).toEqual([])
    expect(card.resolve_payload).toEqual({})
    expect(card.items).toHaveLength(2)
    expect(card.items[0]).toEqual({ layer: 'L4', title: '标题 a', digest: '内容 a', judge_reason: '值得记' })
  })
})

describe('请求体组装（规格 9.11 行 782-817；规格 9.5 行 718）', () => {
  it('按 §9.11 逐字组装字段，正文超 4000 字只给前 4000 字并标 truncated', () => {
    const { request, truncated, truncated_client_keys } = buildEvaluateRequest({
      batch_id: '01JBATCH000000000000000000000',
      prepare_node_run_id: 'nr_prepare_1',
      source: {
        run_id: 'run_1',
        task_title: '任务标题',
        goal: '目标',
        result_summary: '摘要',
        evidence_refs: ['artifact:a', 'decision:b'],
      },
      items: [prepared('a', { content: 'x'.repeat(5000) })],
    })
    expect(Object.keys(request)).toEqual(['batch_id', 'prepare_node_run_id', 'source', 'policy', 'items'])
    expect(request.batch_id).toBe('01JBATCH000000000000000000000')
    expect(request.prepare_node_run_id).toBe('nr_prepare_1')
    expect(request.source).toEqual({
      run_id: 'run_1',
      task_title: '任务标题',
      goal: '目标',
      result_summary: '摘要',
      evidence_refs: ['artifact:a', 'decision:b'],
    })
    expect(request.policy.allowed_layers).toEqual(['L2', 'L4', 'L5', 'L6'])
    expect(request.policy.max_items).toBe(20)
    expect(request.policy.max_content_bytes).toBe(65536)
    expect(request.policy.allow_update).toBe(true)
    expect(request.policy.require_quote).toBe(true)
    expect(request.policy.judge_content_limit).toBe(JUDGE_CONTENT_LIMIT)
    const first = request.items[0]
    expect(first?.client_key).toBe('a')
    expect(first?.content).toHaveLength(JUDGE_CONTENT_LIMIT)
    expect(first?.content_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(first?.similar).toEqual([])
    expect(truncated).toBe(true)
    expect(truncated_client_keys).toEqual(['a'])
  })
})
