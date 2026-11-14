import { describe, expect, it } from 'vitest'
import { name, version } from '../../src/index.ts'

describe('smoke', () => {
  it('exposes plugin identity', () => {
    expect(name).toBe('dsh-orchestra')
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
