import { describe, expect, it } from 'vitest'
import {
  ToolRegistry, deriveEffectiveCapability, resolveDeclaredPolicy,
  type ToolDescriptor,
} from '../../src/executor/tools.ts'

const ro: ToolDescriptor = { name: 'fs.read', capability: 'read_only', command: { bin: 'cat', args: ['file'] } }
const ro2: ToolDescriptor = { name: 'git.status', capability: 'read_only', command: { bin: 'git', args: ['status'] } }
const mut: ToolDescriptor = {
  name: 'fs.write', capability: 'mutating', command: { bin: 'write', args: ['f'] },
  compensation: { tool: 'fs.restore', args: ['f'], verify: { command: 'cat', args: ['f'] } },
}
const mutNoComp: ToolDescriptor = { name: 'fs.delete', capability: 'mutating', command: { bin: 'rm', args: ['f'] } }
const comp: ToolDescriptor = { name: 'fs.restore', capability: 'compensating', command: { bin: 'restore', args: ['f'] } }

describe('工具注册表', () => {
  it('register 后 lookup 拿到同一份；未注册 lookup 返回 undefined；require 抛 TOOL_NOT_REGISTERED', () => {
    const reg = new ToolRegistry()
    reg.register(ro)
    expect(reg.lookup('fs.read')).toBe(ro)
    expect(reg.lookup('nope')).toBeUndefined()
    expect(() => reg.require('nope')).toThrowError(/工具没注册/)
    expect(reg.list()).toEqual([ro])
  })

  it('前向只含 read_only → pure；空 → pure', () => {
    expect(deriveEffectiveCapability([ro, ro2])).toBe('pure')
    expect(deriveEffectiveCapability([])).toBe('pure')
  })

  it('mutating 带可执行补偿 → compensable', () => {
    expect(deriveEffectiveCapability([ro, mut])).toBe('compensable')
  })

  it('mutating 无补偿 → irreversible', () => {
    expect(deriveEffectiveCapability([mutNoComp])).toBe('irreversible')
  })

  it('前向出现 compensating → COMPENSATION_TOOL_IN_FORWARD_PATH', () => {
    expect(() => deriveEffectiveCapability([ro, comp])).toThrowError(/补偿工具不能出现在前向路径里/)
  })

  it('声明 pure 而推导 compensable → SIDE_EFFECT_UNDECLARED', () => {
    expect(() => resolveDeclaredPolicy('pure', 'compensable', [mut])).toThrowError(/声明 pure 但推导不是 pure/)
  })

  it('声明 compensable 而补偿不可执行 → COMPENSATION_UNEXECUTABLE', () => {
    const broken: ToolDescriptor = { ...mut, compensation: { tool: 'fs.restore', args: [], verify: { command: '', args: [] } } }
    expect(() => resolveDeclaredPolicy('compensable', 'compensable', [broken])).toThrowError(/补偿描述符不可执行/)
  })

  it('声明 compensable 而推导 pure → SIDE_EFFECT_UNDECLARED', () => {
    expect(() => resolveDeclaredPolicy('compensable', 'pure', [])).toThrowError(/声明比推导宽/)
  })

  it('声明 irreversible 而推导 pure → 不抛，返回 irreversible', () => {
    expect(resolveDeclaredPolicy('irreversible', 'pure', [])).toBe('irreversible')
  })
})
