// operation_id 是协议硬约束：UUIDv7，不是示例口径（规格 3.7）
import { describe, expect, it } from 'vitest'
import { assertOperationId, UUID_V7_RE } from '../../src/service/commands/idempotency.ts'
import { OrchError } from '../../src/core/errors.ts'

const V7 = '018f0c1a-2b3c-7d4e-8f5a-6b7c8d9e0f11'
const V4 = '018f0c1a-2b3c-4d4e-8f5a-6b7c8d9e0f11'
const WRONG_VARIANT = '018f0c1a-2b3c-7d4e-0f5a-6b7c8d9e0f11'

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    if (err instanceof OrchError) return err.code
    throw err
  }
  throw new Error('本应抛错却通过了')
}

describe('assertOperationId（UUIDv7 硬约束）', () => {
  it('合法 UUIDv7 通过', () => {
    expect(assertOperationId(V7)).toBe(V7)
    expect(UUID_V7_RE.test(V7)).toBe(true)
  })

  it('UUIDv4 / 裸字符串 / 版本位错 / variant 错都拒', () => {
    expect(codeOf(() => assertOperationId(V4))).toBe('PAYLOAD_SCHEMA_INVALID')
    expect(codeOf(() => assertOperationId('op-1'))).toBe('PAYLOAD_SCHEMA_INVALID')
    expect(codeOf(() => assertOperationId('018F0C1A-2B3C-7D4E-8F5A-6B7C8D9E0F11'))).toBe('PAYLOAD_SCHEMA_INVALID') // 大写
    expect(codeOf(() => assertOperationId(WRONG_VARIANT))).toBe('PAYLOAD_SCHEMA_INVALID')
  })
})
