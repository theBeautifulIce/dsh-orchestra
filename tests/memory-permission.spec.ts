// S5-E：直接记忆写工具的权限负例——workflow / executor / task_session 三条路径
// 规格 9.1：唯一写入口是 memory.apply_governed；三个面的 allow 出现 memory_write / memory_update 都拒。
import { describe, expect, it } from 'vitest'
import { OrchError } from '../src/core/errors.ts'
import { ToolRegistry } from '../src/executor/tools.ts'
import { TASK_SESSION_TOOL_POLICY, resolveTaskSessionToolPolicy, resolveToolSet } from '../src/executor/session.ts'
import { WorkflowCatalog } from '../src/service/workflows.ts'
import { createWorkflow, publishDraft } from '../src/service/commands/workflows.ts'
import { assertTaskSessionToolsAllowed } from '../src/service/commands/memory-permission.ts'
import { withTx } from '../src/infra/sqlite/driver.ts'
import { freshLedger } from './fixtures/ledger.ts'

const NOW = '2026-11-18T05:00:00.000Z'
const RUNTIME = new Set(['agent', 'parallel', 'subworkflow', 'decision', 'wait'])
const ctx = { registeredNodeTypes: RUNTIME, publishedVersions: () => true }

function errOf(fn: () => unknown): OrchError {
  try {
    fn()
  } catch (err) {
    if (err instanceof OrchError) return err
    throw err
  }
  throw new Error('本应抛错却通过了')
}

function registry(...names: string[]): ToolRegistry {
  const reg = new ToolRegistry()
  for (const name of names) {
    reg.register({ name, capability: 'mutating', command: { bin: name, args: [] } })
  }
  return reg
}

describe('直接记忆写工具的权限闸', () => {
  it('workflow 面：agent 节点的 allow 出现 memory_write → 发布期拒，且不生成版本', () => {
    const { db } = freshLedger()
    const doc = {
      name: '带写工具的流程',
      nodes: [
        { node_id: 't', type: 'trigger', title: 't', position: { x: 0, y: 0 }, config: {} },
        { node_id: 'a', type: 'agent', title: 'a', position: { x: 0, y: 0 }, config: { tools: { allow: ['memory_write'] } } },
      ],
      edges: [{ from: 't', to: 'a' }],
    }
    withTx(db, (tx) => createWorkflow(tx, {
      workflowId: 'wf1', name: '带写工具的流程', definition: doc, actor: 'human:me', now: NOW,
    }))
    const err = errOf(() => withTx(db, (tx) => publishDraft(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx)))
    expect(err.code).toBe('MEMORY_WRITE_TOOL_FORBIDDEN')
    const versions = db.raw.prepare('SELECT COUNT(*) AS n FROM workflow_versions WHERE workflow_id = ?')
      .get('wf1') as { n: number }
    expect(Number(versions.n)).toBe(0)
    db.raw.close()
  })

  it('executor 面：allow 出现 memory_update → 拿不到这个工具', () => {
    const reg = registry('memory_update', 'memory.search')
    const err = errOf(() => resolveToolSet(reg, { allow: ['memory_update'] }))
    expect(err.code).toBe('MEMORY_WRITE_TOOL_FORBIDDEN')
    expect(err.details.tool).toBe('memory_update')
  })

  it('executor 面：工作流定义加载期的 allow 出现 memory_write → 拒', () => {
    const catalog = new WorkflowCatalog('S2')
    const err = errOf(() => catalog.load({
      workflow_version: '1',
      pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
      nodes: [{ node_id: 'a', type: 'agent', tools: { allow: ['memory_write'] } }],
    }))
    expect(err.code).toBe('MEMORY_WRITE_TOOL_FORBIDDEN')
  })

  it('task_session 面：模板 allow 出现 memory_update → 拒；模板本身不发任何工具', () => {
    const err = errOf(() => assertTaskSessionToolsAllowed(['memory_update']))
    expect(err.code).toBe('MEMORY_WRITE_TOOL_FORBIDDEN')
    expect(err.details.surface).toBe('task_session')
    expect(TASK_SESSION_TOOL_POLICY.allow).toEqual([])
  })

  it('task_session 面：策略解析/下发入口出现写工具 → 拒', () => {
    const err = errOf(() => resolveTaskSessionToolPolicy({ allow: ['memory_write'] }))
    expect(err.code).toBe('MEMORY_WRITE_TOOL_FORBIDDEN')
    expect(err.details.surface).toBe('task_session')
    const err2 = errOf(() => resolveTaskSessionToolPolicy({ allow: ['memory_update'] }))
    expect(err2.code).toBe('MEMORY_WRITE_TOOL_FORBIDDEN')
    expect(err2.details.surface).toBe('task_session')
  })

  it('task_session 面：默认策略仍然不发工具，storages 读写一律 deny', () => {
    const resolved = resolveTaskSessionToolPolicy()
    expect(resolved.allow).toEqual([])
    expect(TASK_SESSION_TOOL_POLICY.allow).toEqual([])
    expect(TASK_SESSION_TOOL_POLICY.deny).toEqual([])
    expect(resolved.deny).toEqual(['storages:read', 'storages:write'])
    const custom = resolveTaskSessionToolPolicy({ allow: ['memory_start_run'], deny: ['memory.get'] })
    expect(custom.allow).toEqual(['memory_start_run'])
    expect(custom.deny).toEqual(['memory.get', 'storages:read', 'storages:write'])
  })

  it('三面都不含写工具时放行', () => {
    const reg = registry('memory.search', 'memory.get')
    const chosen = resolveToolSet(reg, { allow: ['memory.search'] })
    expect(chosen.map((tool) => tool.name)).toEqual(['memory.search'])
    expect(() => assertTaskSessionToolsAllowed(['memory_start_run'])).not.toThrow()
  })
})
