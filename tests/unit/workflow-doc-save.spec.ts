// 保存层：结构性问题阻断，图语义问题只作提示（S4 计划 Task 2）
import { describe, expect, it } from 'vitest'
import { validateSaveLayer } from '../../src/core/workflow-doc.ts'
import { OrchError } from '../../src/core/errors.ts'

const node = (id: string, type = 'agent', title = id, extra: Record<string, unknown> = {}) => ({
  node_id: id, type, title, position: { x: 100, y: 100 }, config: {}, ...extra,
})

const doc = (over: Record<string, unknown> = {}) => ({
  name: '发布流水线',
  nodes: [node('start', 'trigger'), node('build')],
  edges: [{ from: 'start', to: 'build' }],
  ...over,
})

const codes = (result: { report: { errors: { code: string }[] } }): string[] => result.report.errors.map((i) => i.code)

describe('保存层结构校验', () => {
  it('正常定义：无阻断项，且图语义没有提示', () => {
    const out = validateSaveLayer(doc())
    expect(out.report.errors).toEqual([])
    expect(out.hints).toEqual([])
    expect(out.saved?.name).toBe('发布流水线')
  })

  it('标题与流程名超长各自报对应码', () => {
    expect(codes(validateSaveLayer(doc({ nodes: [node('start', 'trigger', 'x'.repeat(81)), node('build')] })))).toContain('WORKFLOW_TITLE_INVALID')
    expect(codes(validateSaveLayer(doc({ name: 'y'.repeat(81) })))).toContain('WORKFLOW_NAME_INVALID')
  })

  it('请求体 name 与定义 name 不一致：按名字非法拒', () => {
    expect(codes(validateSaveLayer(doc(), { expectedName: '别的名字' }))).toContain('WORKFLOW_NAME_INVALID')
  })

  it('node_id 格式与重复各自报对应码', () => {
    const bad = doc({ nodes: [node('start', 'trigger'), node('Build'), node('build')] })
    expect(codes(validateSaveLayer(bad))).toContain('WORKFLOW_NODE_ID_INVALID')
    const dup = doc({ nodes: [node('start', 'trigger'), node('build'), node('build')] })
    expect(codes(validateSaveLayer(dup))).toContain('WORKFLOW_NODE_ID_DUPLICATE')
  })

  it('自环、重复边、端点缺失各自报对应码', () => {
    const selfLoop = doc({ edges: [{ from: 'start', to: 'start' }] })
    expect(codes(validateSaveLayer(selfLoop))).toContain('WORKFLOW_EDGE_SELF_LOOP')
    const dup = doc({ edges: [{ from: 'start', to: 'build' }, { from: 'start', to: 'build' }] })
    expect(codes(validateSaveLayer(dup))).toContain('WORKFLOW_EDGE_DUPLICATE')
    const missing = doc({ edges: [{ from: 'start', to: 'ghost' }] })
    expect(codes(validateSaveLayer(missing))).toContain('WORKFLOW_EDGE_ENDPOINT_MISSING')
  })

  it('position 越界与定义结构坏掉：报 WORKFLOW_DEFINITION_INVALID，且不返回 saved', () => {
    const out = validateSaveLayer(doc({ nodes: [node('start', 'trigger', 'start', { position: { x: -1, y: 0 } })] }))
    expect(codes(out)).toContain('WORKFLOW_DEFINITION_INVALID')
    expect(out.saved).toBeNull()
  })

  it('缺 trigger、有环、branch 缺 route：保存不阻断，只进 hints', () => {
    const noTrigger = validateSaveLayer(doc({ nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }] }))
    expect(noTrigger.report.errors).toEqual([])
    expect(noTrigger.hints.map((h) => h.code)).toContain('WORKFLOW_NO_TRIGGER')

    const cycle = validateSaveLayer(doc({ nodes: [node('start', 'trigger'), node('a'), node('b')], edges: [
      { from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' },
    ] }))
    expect(cycle.report.errors).toEqual([])
    expect(cycle.hints.map((h) => h.code)).toContain('WORKFLOW_GRAPH_CYCLE')

    const branch = validateSaveLayer(doc({ nodes: [node('start', 'trigger'), node('fork', 'branch'), node('x'), node('y')], edges: [
      { from: 'start', to: 'fork' }, { from: 'fork', to: 'x' }, { from: 'fork', to: 'y' },
    ] }))
    expect(branch.report.errors).toEqual([])
    expect(branch.hints.map((h) => h.code)).toContain('WORKFLOW_BRANCH_ROUTE_INVALID')
  })

  it('超过 1 MiB 直接抛 413，不进 issue 列表', () => {
    const huge = doc({ nodes: [node('start', 'trigger'), { ...node('build'), config: { blob: 'x'.repeat(1024 * 1024) } }] })
    try {
      validateSaveLayer(huge)
      throw new Error('本应抛错')
    } catch (err) {
      expect(err).toBeInstanceOf(OrchError)
      expect((err as OrchError).code).toBe('WORKFLOW_DEFINITION_TOO_LARGE')
    }
  })

  it('issue 最多 100 条，total 记真实条数', () => {
    const nodes = Array.from({ length: 130 }, (_, i) => node('n' + String(i), 'agent', 'x'.repeat(90)))
    const out = validateSaveLayer(doc({ nodes }))
    expect(out.report.errors.length).toBe(100)
    expect(out.report.truncated).toBe(true)
    expect(out.report.total).toBeGreaterThan(100)
  })
})
