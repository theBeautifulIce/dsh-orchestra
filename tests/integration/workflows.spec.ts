import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb, type Db } from '../../src/infra/sqlite/driver.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import type { WorkflowDefinition } from '../../src/core/workflow-def.ts'
import { freshLedger } from '../fixtures/ledger.ts'

const def: WorkflowDefinition = {
  workflow_version: '1',
  pass_conditions: [{ path: 'evidence.exitCode', op: 'eq' as const, value: 0 }],
  nodes: [{ node_id: 'check', type: 'agent' as const, tools: { allow: ['ro.echo'], deny: ['ro.rm'] } }],
}

// 最小账本：只建 workflow_versions 一张表。
// 本用例只关心「落库失败时目录不留残影」，不牵扯别的表；迁移目录正被并行改动，
// 借整库夹具会被无关的迁移连号校验绊倒，所以这里自己起一张最小表。
function miniLedger(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-wf-'))
  const db = openDb(join(dir, 'orchestra.db'))
  db.raw.exec('CREATE TABLE workflow_versions (version TEXT PRIMARY KEY, content_hash TEXT NOT NULL, definition_json TEXT NOT NULL, created_at TEXT NOT NULL)')
  return db
}

describe('工作流版本不可变（第五轮审计 P1-1）', () => {
  it('同版本同内容重复加载照常返回摘要', () => {
    const catalog = new WorkflowCatalog('S2')
    catalog.load(def)
    const again = catalog.load(JSON.parse(JSON.stringify(def)))
    expect(again.workflow_version).toBe('1')
    expect(again.nodes[0]!.node_id).toBe('check')
  })

  it('同版本改判定条件即拒：不许改写已建 run 的判定', () => {
    const catalog = new WorkflowCatalog('S2')
    catalog.load(def)
    expect(() => catalog.load({ ...def, pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 99 }] }))
      .toThrowError(/同一工作流版本不许改写定义/)
    expect(catalog.policyFor('1', 'check').passConditions).toEqual(def.pass_conditions)
  })

  it('同版本改节点工具授权即拒', () => {
    const catalog = new WorkflowCatalog('S2')
    catalog.load(def)
    expect(() => catalog.load({ ...def, nodes: [{ ...def.nodes[0]!, tools: { allow: ['ro.echo', 'ro.rm'], deny: [] } }] }))
      .toThrowError(/同一工作流版本不许改写定义/)
    expect(catalog.toolPolicyFor('1', 'check')).toEqual({ allow: ['ro.echo'], deny: ['ro.rm'] })
  })

  it('工具授权只从节点定义取，返回的是副本', () => {
    const catalog = new WorkflowCatalog('S2')
    catalog.load(def)
    const policy = catalog.toolPolicyFor('1', 'check')
    policy.allow.push('ro.rm')
    expect(catalog.toolPolicyFor('1', 'check').allow).toEqual(['ro.echo'])
  })

  it('跨重启：定义落库后，新目录能装回旧定义，同版本改写被拒', () => {
    const { db } = freshLedger()
    const first = new WorkflowCatalog('S2', db)
    first.load(def)
    const second = new WorkflowCatalog('S2', db)
    expect(second.hydrate()).toBe(1)
    expect(second.get('1').workflow_version).toBe('1')
    expect(() => second.load({ ...def, nodes: [{ node_id: 'check', type: 'agent' as const }] }))
      .toThrowError(/同一工作流版本不许改写定义/)
    expect(second.definitionHash('1')).toBe(first.definitionHash('1'))
  })

  it('同一层重复必留哈希键名在加载期就拒（S2 第二十八轮 P2-2）', () => {
    const catalog = new WorkflowCatalog('S2')
    expect(() => catalog.load({ ...def, required_hashes: ['artifact', 'artifact'] }))
      .toThrowError(/必留哈希键名重复/)
    expect(() => catalog.load({ ...def, nodes: [{ ...def.nodes[0]!, required_hashes: ['artifact', 'artifact'] }] }))
      .toThrowError(/必留哈希键名重复/)
  })

  it('节点不在版本里 → SCHEMA_VERSION_UNSUPPORTED', () => {
    const catalog = new WorkflowCatalog('S2')
    catalog.load(def)
    expect(() => catalog.toolPolicyFor('1', 'nope')).toThrowError(/节点不在这个工作流版本里/)
  })
})

describe('目录里的定义不可变（第二次意见 P1）', () => {
  it('载入后改调用方的原始对象，目录里的定义不变', () => {
    const source: WorkflowDefinition = {
      workflow_version: '1',
      nodes: [{ node_id: 'check', type: 'agent' as const, tools: { allow: ['ro.echo'], deny: ['ro.rm'] } }],
    }
    const catalog = new WorkflowCatalog('S2')
    catalog.load(source)
    // 加载完再改调用方手里的原对象：目录里的授权不能跟着变（问题 A）
    source.nodes[0]!.tools!.allow!.push('ro.rm')
    source.nodes[0]!.tools!.deny!.push('ro.write')
    source.nodes[0]!.node_id = 'other'
    expect(catalog.toolPolicyFor('1', 'check')).toEqual({ allow: ['ro.echo'], deny: ['ro.rm'] })
    expect(catalog.get('1').nodes[0]!.node_id).toBe('check')
    expect(catalog.get('1').nodes[0]!.tools!.allow).toEqual(['ro.echo'])
  })

  it('改 get() 返回对象的嵌套字段，目录内部不变', () => {
    const catalog = new WorkflowCatalog('S2')
    catalog.load(def)
    const got = catalog.get('1')
    // 交出去的是能改的副本：改它不炸，也不许动到目录里的本体
    got.nodes[0]!.tools!.allow!.push('ro.rm')
    got.nodes.push({ node_id: 'other', type: 'agent' })
    expect(catalog.get('1').nodes).toHaveLength(1)
    expect(catalog.toolPolicyFor('1', 'check')).toEqual({ allow: ['ro.echo'], deny: ['ro.rm'] })
  })

  it('落库失败时目录不留这一份定义（内存无残影）', () => {
    const db = miniLedger()
    // 注入落库失败：INSERT 一进来就被触发器打断，SELECT 仍走得通
    db.raw.exec("CREATE TRIGGER block_workflow_versions_insert BEFORE INSERT ON workflow_versions BEGIN SELECT RAISE(ABORT, '注入的落库失败'); END")
    const catalog = new WorkflowCatalog('S2', db)
    expect(() => catalog.load(def)).toThrowError(/落库失败/)
    expect(() => catalog.get('1')).toThrowError(/工作流版本没加载过/)
    // 失败的事务不留痕：库里也没有这一行
    const row = db.raw.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get() as { n: number }
    expect(Number(row.n)).toBe(0)
  })

  it('版本号别名（01 与 1）在冻结对象下照旧工作', () => {
    const catalog = new WorkflowCatalog('S2')
    catalog.load({ ...def, workflow_version: '01' })
    expect(catalog.get('1').workflow_version).toBe('01')
    expect(catalog.get('01').workflow_version).toBe('01')
    // 别名撞上另一份定义要拒：账本里 01 与 1 是同一个版本号
    expect(() => catalog.load({ ...def, workflow_version: '1', pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 9 }] }))
      .toThrowError(/同一工作流版本不许改写定义/)
  })
})
