import { describe, expect, it } from 'vitest'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import {
  assertNoOpenChildRuns, assertSubworkflowGraph, createSubworkflowRun, finishSubworkflowChild,
  propagateRunCancellation, startSubworkflowNode, SUBWORKFLOW_MAX_DEPTH,
  type SubworkflowEdge,
} from '../../src/service/commands/subworkflow.ts'
import { assertRunCanTerminal } from '../../src/service/commands/parallel.ts'

const NOW = '2026-11-14T12:00:00.000Z'
const SECRET = 'subworkflow-secret'

function memoryDb(): Db {
  const db = openDb(':memory:')
  applySteps(db, loadSteps(defaultMigrationsDir()))
  withTx(db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1', '子流程', 'running', 1, ?, ?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, status, revision, root_run_id, subworkflow_depth, created_at, updated_at) VALUES ('r1', 't1', 'running', 1, 'r1', 0, ?, ?)", [NOW, NOW])
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, status, revision, created_at, updated_at) "
      + "VALUES ('nr-parent', 'r1', 'sub', 1, 'subworkflow', 'started', 1, ?, ?)", [NOW, NOW],
    )
  })
  return db
}

function catalog(): WorkflowCatalog {
  const c = new WorkflowCatalog('S3')
  c.load({ workflow_id: 'root', workflow_version: '1', nodes: [{ node_id: 'sub', type: 'subworkflow' }] })
  c.load({ workflow_id: 'child', workflow_version: '1', nodes: [{ node_id: 'a', type: 'agent' }] })
  c.load({ workflow_id: 'child', workflow_version: '2', nodes: [{ node_id: 'b', type: 'agent' }] })
  c.load({ workflow_id: 'grand', workflow_version: '1', nodes: [{ node_id: 'g', type: 'subworkflow' }] })
  c.load({ workflow_id: 'great', workflow_version: '1', nodes: [{ node_id: 'x', type: 'agent' }] })
  return c
}

function edge(workflowId: string, version: number, children: { workflowId: string; pinnedVersion: number }[], sideEffectPolicy?: 'pure' | 'compensable' | 'irreversible'): [string, SubworkflowEdge] {
  return [workflowId + '@' + version, { workflowId, version, children, sideEffectPolicy }]
}

describe('子流程图校验', () => {
  it('环按递归栈判：a→b→a 报 SUBWORKFLOW_CYCLE 并带 pin 版本', () => {
    const edges = new Map([
      edge('a', 1, [{ workflowId: 'b', pinnedVersion: 1 }]),
      edge('b', 1, [{ workflowId: 'a', pinnedVersion: 1 }]),
    ])
    expect(() => assertSubworkflowGraph({ workflowId: 'a', pinnedVersion: 1 }, edges))
      .toThrowError(/子流程引用成环/)
  })

  it('深度 2 通过，深度 3 被拒', () => {
    const two = new Map([
      edge('a', 1, [{ workflowId: 'b', pinnedVersion: 1 }]),
      edge('b', 1, []),
    ])
    expect(assertSubworkflowGraph({ workflowId: 'a', pinnedVersion: 1 }, two)).toBe('pure')
    const three = new Map([
      edge('a', 1, [{ workflowId: 'b', pinnedVersion: 1 }]),
      edge('b', 1, [{ workflowId: 'c', pinnedVersion: 1 }]),
      edge('c', 1, [{ workflowId: 'd', pinnedVersion: 1 }]),
      edge('d', 1, []),
    ])
    expect(() => assertSubworkflowGraph({ workflowId: 'a', pinnedVersion: 1 }, three, SUBWORKFLOW_MAX_DEPTH))
      .toThrowError(/深度超过/)
  })

  it('菱形共享同一个子流程是 DAG，不按全局 visited 误报成环', () => {
    const edges = new Map([
      edge('a', 1, [{ workflowId: 'b', pinnedVersion: 1 }, { workflowId: 'c', pinnedVersion: 1 }]),
      edge('b', 1, [{ workflowId: 'd', pinnedVersion: 1 }]),
      edge('c', 1, [{ workflowId: 'd', pinnedVersion: 1 }]),
      edge('d', 1, []),
    ])
    expect(() => assertSubworkflowGraph({ workflowId: 'a', pinnedVersion: 1 }, edges)).not.toThrow()
  })

  it('子图副作用策略取最大值，irreversible 浮到根', () => {
    const edges = new Map([
      edge('a', 1, [{ workflowId: 'b', pinnedVersion: 1 }, { workflowId: 'c', pinnedVersion: 1 }], 'pure'),
      edge('b', 1, [], 'compensable'),
      edge('c', 1, [], 'irreversible'),
    ])
    expect(assertSubworkflowGraph({ workflowId: 'a', pinnedVersion: 1 }, edges)).toBe('irreversible')
  })

  it('pin 版本必须是正整数，不能跟最新', () => {
    expect(() => assertSubworkflowGraph({ workflowId: 'a', pinnedVersion: 0 }, new Map()))
      .toThrowError(/pin 一个正整数版本/)
  })
})

describe('子运行 pin、深度与唤醒', () => {
  it('按 pin 建子运行，重复调用返回同一个子运行，换版本按冲突拒', () => {
    const db = memoryDb()
    const c = catalog()
    let childId = ''
    withTx(db, (tx) => {
      const got = createSubworkflowRun(tx, c, {
        parentRunId: 'r1', parentNodeRunId: 'nr-parent', workflowId: 'child', workflowVersion: 2, now: NOW,
      })
      childId = got.run_id
      expect(got.created).toBe(true)
      expect(got.workflow_version).toBe('2')
      expect(got.depth).toBe(1)
      const again = createSubworkflowRun(tx, c, {
        parentRunId: 'r1', parentNodeRunId: 'nr-parent', workflowId: 'child', workflowVersion: 2, now: NOW,
      })
      expect(again.run_id).toBe(childId)
      expect(again.created).toBe(false)
      expect(() => createSubworkflowRun(tx, c, {
        parentRunId: 'r1', parentNodeRunId: 'nr-parent', workflowId: 'child', workflowVersion: 1, now: NOW,
      })).toThrowError(/已经起了别的 pin 版本/)
    })
    const row = db.raw.prepare('SELECT * FROM runs WHERE run_id = ?').get(childId) as any
    expect(row.workflow_id).toBe('child')
    expect(row.workflow_version).toBe(2)
    expect(row.parent_run_id).toBe('r1')
    expect(row.parent_node_run_id).toBe('nr-parent')
    expect(row.root_run_id).toBe('r1')
    expect(row.subworkflow_depth).toBe(1)
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM node_runs WHERE run_id = ?').get(childId)).toEqual({ n: 1 })
  })

  it('深度超过 2 在库层也被拒，不靠调用方自觉', () => {
    const db = memoryDb()
    const c = catalog()
    withTx(db, (tx) => {
      const child = createSubworkflowRun(tx, c, {
        parentRunId: 'r1', parentNodeRunId: 'nr-parent', workflowId: 'child', workflowVersion: 1, now: NOW,
      })
      const grandNode = tx.get<{ node_run_id: string }>(
        "SELECT node_run_id FROM node_runs WHERE run_id = ? AND node_type = 'agent'", [child.run_id],
      )!
      tx.run("UPDATE node_runs SET node_type = 'subworkflow', status = 'started' WHERE node_run_id = ?", [grandNode.node_run_id])
      const grand = createSubworkflowRun(tx, c, {
        parentRunId: child.run_id, parentNodeRunId: grandNode.node_run_id, workflowId: 'grand', workflowVersion: 1, now: NOW,
      })
      expect(grand.depth).toBe(2)
      const greatNode = tx.get<{ node_run_id: string }>(
        "SELECT node_run_id FROM node_runs WHERE run_id = ? AND node_type = 'subworkflow'", [grand.run_id],
      )!
      tx.run("UPDATE node_runs SET status = 'started' WHERE node_run_id = ?", [greatNode.node_run_id])
      expect(() => createSubworkflowRun(tx, c, {
        parentRunId: grand.run_id, parentNodeRunId: greatNode.node_run_id, workflowId: 'great', workflowVersion: 1, now: NOW,
      })).toThrowError(/深度超过/)
    })
  })

  it('引用的 pin 版本不存在时按 WORKFLOW_SUBWORKFLOW_VERSION_MISSING 拒，不退回最新', () => {
    const db = memoryDb()
    const c = catalog()
    withTx(db, (tx) => {
      expect(() => createSubworkflowRun(tx, c, {
        parentRunId: 'r1', parentNodeRunId: 'nr-parent', workflowId: 'child', workflowVersion: 99, now: NOW,
      })).toThrowError(/版本不存在或未发布/)
    })
  })

  it('父节点不在 started 时不许直接起子运行', () => {
    const db = memoryDb()
    const c = catalog()
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status = 'queued' WHERE node_run_id = 'nr-parent'")
      expect(() => createSubworkflowRun(tx, c, {
        parentRunId: 'r1', parentNodeRunId: 'nr-parent', workflowId: 'child', workflowVersion: 1, now: NOW,
      })).toThrowError(/只有 started/)
    })
  })

  it('运行前按祖先链判环：父 run 已是 child@1，再挂 child@1 直接拒', () => {
    const db = memoryDb()
    const c = catalog()
    withTx(db, (tx) => {
      tx.run("UPDATE runs SET workflow_id = 'child', workflow_version = 1 WHERE run_id = 'r1'")
      expect(() => createSubworkflowRun(tx, c, {
        parentRunId: 'r1', parentNodeRunId: 'nr-parent', workflowId: 'child', workflowVersion: 1, now: NOW,
      })).toThrowError(/子流程引用成环/)
    })
  })

  it('started 父节点进 waiting，子运行终态后才能唤醒回 dispatched', () => {
    const db = memoryDb()
    const c = catalog()
    withTx(db, (tx) => {
      const child = startSubworkflowNode(tx, SECRET, c, {
        nodeRunId: 'nr-parent', attempt: 1, workflowId: 'child', workflowVersion: 1, now: NOW,
      })
      expect(tx.get<{ status: string }>('SELECT status FROM node_runs WHERE node_run_id = ?', ['nr-parent'])!.status).toBe('waiting')
      expect(() => finishSubworkflowChild(tx, SECRET, { childRunId: child.run_id, now: NOW }))
        .toThrowError(/还没收口/)
      tx.run("UPDATE runs SET status = 'done' WHERE run_id = ?", [child.run_id])
      const woke = finishSubworkflowChild(tx, SECRET, { childRunId: child.run_id, now: NOW })
      expect(woke).toEqual({ parentNodeRunId: 'nr-parent', status: 'dispatched' })
      expect(finishSubworkflowChild(tx, SECRET, { childRunId: child.run_id, now: NOW }).status).toBe('dispatched')
    })
  })
})

describe('父取消传播与终态闸', () => {
  it('取消落到子 run 和可取消节点，不可逆节点跳过；父 run 在子 run 收口前不能进终态', () => {
    const db = memoryDb()
    const c = catalog()
    let childId = ''
    withTx(db, (tx) => {
      const child = startSubworkflowNode(tx, SECRET, c, {
        nodeRunId: 'nr-parent', attempt: 1, workflowId: 'child', workflowVersion: 1, now: NOW,
      })
      childId = child.run_id
      tx.run("UPDATE node_runs SET status = 'started', side_effect_policy = 'compensable' WHERE run_id = ?", [childId])
      tx.run("UPDATE node_runs SET side_effect_policy = 'irreversible' WHERE run_id = ? AND node_id = 'a'", [childId])
      const out = propagateRunCancellation(tx, SECRET, {
        runId: 'r1', cancelResult: 'interrupted', now: NOW, graceMs: 5000,
      })
      expect(out.cancelledRuns).toEqual([childId])
      expect(out.cancelledNodes).toEqual([])
      expect(out.skippedIrreversible.length).toBe(1)
      expect(tx.get<{ status: string }>('SELECT status FROM node_runs WHERE run_id = ?', [childId])!.status).toBe('started')
      expect(() => assertNoOpenChildRuns(tx, 'r1')).toThrowError(/未收口的子运行/)
      expect(() => assertRunCanTerminal(tx, 'r1')).toThrowError(/未收口的子运行/)
      tx.run("UPDATE runs SET status = 'done' WHERE run_id = ?", [childId])
      expect(() => assertNoOpenChildRuns(tx, 'r1')).not.toThrow()
      expect(() => assertRunCanTerminal(tx, 'r1')).not.toThrow()
      expect(tx.get<{ cancel_result: string }>('SELECT cancel_result FROM runs WHERE run_id = ?', [childId])!.cancel_result).toBe('interrupted')
    })
  })
})
