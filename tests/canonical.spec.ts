import { describe, expect, it } from 'vitest'
import { canonicalJson, hmacSha256Hex, sha256Hex } from '../src/core/canonical.ts'

describe('canonical_json', () => {
  it('键顺序不同但内容相同 → 结果逐字相等', () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } }
    const b = { c: { x: 2, y: 1 }, a: 2, b: 1 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(canonicalJson(a)).toBe('{"a":2,"b":1,"c":{"x":2,"y":1}}')
  })

  it('按码点升序：ASCII 与中文混排', () => {
    expect(canonicalJson({ 流程: 1, ab: 2, A: 3 })).toBe('{"A":3,"ab":2,"流程":1}')
  })

  it('嵌套对象与数组里的对象同样排序', () => {
    expect(canonicalJson([{ b: 1, a: 2 }, { d: 3, c: 4 }])).toBe('[{"a":2,"b":1},{"c":4,"d":3}]')
  })

  it('对象里的 undefined 字段被丢掉，null 保留', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
  })

  it('数组里的 undefined 直接抛错（JCS 不允许 undefined 占位）', () => {
    expect(() => canonicalJson([undefined, 1])).toThrow(TypeError)
  })

  it('NaN 与 Infinity 抛错', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError)
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError)
  })

  it('顶层标量走 JSON 口径', () => {
    expect(canonicalJson('说"引号"')).toBe('"说\\"引号\\""')
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(1.5)).toBe('1.5')
  })
})

describe('哈希原语', () => {
  it('sha256Hex("abc") 等于已知值', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('HMAC-SHA256 通过 RFC 4231 用例 1', () => {
    expect(hmacSha256Hex(Buffer.alloc(20, 0x0b), 'Hi There')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    )
  })
})
