import { describe, expect, it } from 'vitest'
import { ERROR_STATUS, OrchError, failEnvelope, okEnvelope, toOrchError } from '../src/core/errors.ts'

describe('规格 17.1 错误码表', () => {
  it('条目数与规格一致（85 条）', () => {
    expect(Object.keys(ERROR_STATUS).length).toBe(85)
  })

  it('抽样核对 HTTP 状态', () => {
    expect(ERROR_STATUS.UNAUTHORIZED).toBe(401)
    expect(ERROR_STATUS.FORBIDDEN).toBe(403)
    expect(ERROR_STATUS.NOT_FOUND).toBe(404)
    expect(ERROR_STATUS.CURSOR_EXPIRED).toBe(410)
    expect(ERROR_STATUS.CONFIRMATION_REQUIRED).toBe(428)
    expect(ERROR_STATUS.RANGE_TOO_LARGE).toBe(413)
    expect(ERROR_STATUS.WORKFLOW_DEFINITION_TOO_LARGE).toBe(413)
    expect(ERROR_STATUS.MEMORY_EVAL_INVALID_OUTPUT).toBe(502)
    expect(ERROR_STATUS.MEMORY_APPLY_FAILED).toBe(500)
    expect(ERROR_STATUS.SERVICE_UNAVAILABLE).toBe(503)
    expect(ERROR_STATUS.QUERY_TIMEOUT).toBe(504)
  })

  it('全表状态只取自规格允许的状态集', () => {
    const allowed = new Set([401, 403, 404, 409, 410, 413, 422, 428, 500, 502, 503, 504])
    for (const [code, status] of Object.entries(ERROR_STATUS)) {
      expect(allowed.has(status), code + ' 的状态 ' + status + ' 不在规格状态集里').toBe(true)
    }
  })

  it('三处易错码：MEMORY_BATCH_CONFLICT 是 422、SUBWORKFLOW_DEPTH_EXCEEDED 与 RESOLUTION_NOT_AVAILABLE 都在表里', () => {
    expect(ERROR_STATUS.MEMORY_BATCH_CONFLICT).toBe(422)
    expect(ERROR_STATUS.SUBWORKFLOW_DEPTH_EXCEEDED).toBe(422)
    expect(ERROR_STATUS.RESOLUTION_NOT_AVAILABLE).toBe(422)
  })
})

describe('OrchError', () => {
  it('只有四个可重试码 retryable 为 true', () => {
    for (const code of Object.keys(ERROR_STATUS) as (keyof typeof ERROR_STATUS)[]) {
      const err = new OrchError(code, 'x')
      const expected = ['QUERY_TIMEOUT', 'SERVICE_UNAVAILABLE', 'OPERATION_TIMEOUT', 'COMMAND_BUSY'].includes(code)
      expect(err.retryable, code).toBe(expected)
    }
  })

  it('httpStatus 取自码表', () => {
    expect(new OrchError('WORKFLOW_NOT_FOUND', 'x').httpStatus).toBe(404)
  })

  it('非 OrchError 折成 SERVICE_UNAVAILABLE 且只留 message', () => {
    const err = toOrchError(new Error('boom'))
    expect(err.code).toBe('SERVICE_UNAVAILABLE')
    expect(err.details).toEqual({ message: 'boom' })
    expect(Object.keys(err.details)).toEqual(['message'])
    const same = new OrchError('NOT_FOUND', 'x')
    expect(toOrchError(same)).toBe(same)
  })
})

describe('统一信封（规格 8.1）', () => {
  it('成功信封字段与规格一致', () => {
    const now = new Date('2026-11-13T04:00:00.000Z')
    expect(okEnvelope(7, { a: 1 }, now)).toEqual({
      ok: true,
      schema_version: 1,
      as_of_seq: 7,
      generated_at: '2026-11-13T04:00:00.000Z',
      data: { a: 1 },
    })
  })

  it('失败信封字段与规格一致', () => {
    const env = failEnvelope(3, new OrchError('COMMAND_BUSY', '在途', { operation_id: 'o1' }))
    expect(env).toEqual({
      ok: false,
      schema_version: 1,
      as_of_seq: 3,
      error: { code: 'COMMAND_BUSY', message: '在途', retryable: true, details: { operation_id: 'o1' } },
    })
  })
})
