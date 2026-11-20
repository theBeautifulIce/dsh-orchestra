import { describe, expect, it } from 'vitest'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { WorkflowCatalog, definitionHashOf } from '../../src/service/workflows.ts'
import {
  assertNoOpenChildRuns, assertSubworkflowGraph, collectSubworkflowEdges, createSubworkflowRun, finishSubworkflowChild,
  propagateRunCancellation, startSubworkflowNode, SUBWORKFLOW_MAX_DEPTH,
  type SubworkflowEdge,
} from '../../src/service/commands/subworkflow.ts'
import { assertRunCanTerminal } from '../../src/service/commands/parallel.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'
import { sweepNow } from '../../src/service/commands/runtime.ts'
import { verifyLedger } from '../../src/service/queries/verify_ledger.ts'
import { applyCancel } from '../../src/service/commands/cancel.ts'
import { resolveEffect } from '../../src/service/commands/effects.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { appendNodeRunEvent, readChain, readChainHead } from '../../src/infra/db/ledger.ts'
import { TEST_CLOCK } from '../fixtures/clock.ts'

const NOW = '2026-11-14T12:00:00.000Z'
const SECRET = 'subworkflow-secret'

const MISSING_DEF = {
  workflow_id: 'missing',
  workflow_version: '1',
  nodes: [{ node_id: 'sub', type: 'subworkflow' as const, subworkflow: { workflow_id: 'ghost', pinned_version: 1 } }],
}

const ROOT_DEF = {
  workflow_id: 'root',
  workflow_version: '1',
  nodes: [
    { node_id: 'sub', type: 'subworkflow' as const, subworkflow: { workflow_id: 'child', pinned_version: 2 } },
  ],
}

function memoryDb(parentWorkflow: { workflow_id: string; workflow_version: string; hash?: string; depth?: number } = ROOT_DEF): Db {
  // 定义哈希是控制节点的必需身份：没绑哈希的 run 一律拒，测试也不再留空
  const parentHash = parentWorkflow.hash ?? definitionHashOf(parentWorkflow as never)
  const db = openDb(':memory:')
  applySteps(db, loadSteps(defaultMigrationsDir()))
  withTx(db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1', '子流程', 'running', 1, ?, ?)", [NOW, NOW])
    tx.run(
      "INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, workflow_definition_hash, status, revision, root_run_id, subworkflow_depth, created_at, updated_at) "
      + 'VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
      ['r1', 't1', parentWorkflow.workflow_id, parentWorkflow.workflow_version, parentHash, 'running', 'r1', parentWorkflow.depth ?? 0, NOW, NOW],
    )
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, status, revision, created_at, updated_at) "
      + "VALUES ('nr-parent', 'r1', 'sub', 1, 'subworkflow', 'started', 1, ?, ?)", [NOW, NOW],
    )
  })
  return db
}

function catalog(): WorkflowCatalog {
  const c = new WorkflowCatalog('S3')
  c.load(ROOT_DEF)
  c.load({ workflow_id: 'child', workflow_version: '1', nodes: [{ node_id: 'a', type: 'agent' }] })
  c.load({ workflow_id: 'child', workflow_version: '2', nodes: [{ node_id: 'b', type: 'agent' }] })
  c.load(MISSING_DEF)
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

  it('边表从已加载定义里读，不来自请求：缺失的 pin 版本直接拒', () => {
    const c = catalog()
    const edges = collectSubworkflowEdges(c, { workflowId: 'child', pinnedVersion: 2 })
    expect(edges.get('child@2')?.children).toEqual([])
    expect(() => collectSubworkflowEdges(c, { workflowId: 'ghost', pinnedVersion: 1 }))
      .toThrowError(/版本不存在或未发布/)
  })
})

describe('子运行 pin、深度与唤醒', () => {
  it('按定义 pin 建子运行，重复调用返回同一个子运行，换版本按冲突拒', () => {
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
      // 请求体想换到 child@1：定义里 pin 的是 2，这里必须拒
      expect(() => createSubworkflowRun(tx, c, {
        parentRunId: 'r1', parentNodeRunId: 'nr-parent', workflowId: 'child', workflowVersion: 1, now: NOW,
      })).toThrowError(/请求体不能替换目标/)
    })
    const row = db.raw.prepare('SELECT * FROM runs WHERE run_id = ?').get(childId) as any
    expect(row.workflow_id).toBe('child')
    expect(row.workflow_version).toBe(2)
    expect(row.parent_run_id).toBe('r1')
    expect(row.parent_node_run_id).toBe('nr-parent')
    expect(row.root_run_id).toBe('r1')
    expect(row.subworkflow_depth).toBe(1)
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM node_runs WHERE run_id = ?').get(childId)).toEqual({ n: 1 })
    // 子节点的副作用等级显式落库，不依赖 DDL 默认值
    expect(db.raw.prepare('SELECT side_effect_policy FROM node_runs WHERE run_id = ?').get(childId)).toEqual({ side_effect_policy: 'compensable' })
  })

  it('定义里 pin 的子流程版本没发布：按 WORKFLOW_SUBWORKFLOW_VERSION_MISSING 拒，不退回最新', () => {
    const db = memoryDb({ ...MISSING_DEF, hash: definitionHashOf(MISSING_DEF) })
    const c = catalog()
    withTx(db, (tx) => {
      expect(() => createSubworkflowRun(tx, c, {
        parentRunId: 'r1', parentNodeRunId: 'nr-parent', workflowId: 'ghost', workflowVersion: 1, now: NOW,
      })).toThrowError(/版本不存在或未发布/)
    })
  })

  it('父 run 已经到深度上限：再起子流程直接拒', () => {
    const db = memoryDb(ROOT_DEF)
    const c = catalog()
    withTx(db, (tx) => {
      tx.run("UPDATE runs SET subworkflow_depth = 2 WHERE run_id = 'r1'")
      expect(() => createSubworkflowRun(tx, c, {
        parentRunId: 'r1', parentNodeRunId: 'nr-parent', workflowId: 'child', workflowVersion: 2, now: NOW,
      })).toThrowError(/深度超过/)
    })
  })

  it('父节点不在 started 时不许直接起子运行', () => {
    const db = memoryDb()
    const c = catalog()
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status = 'queued' WHERE node_run_id = 'nr-parent'")
      expect(() => createSubworkflowRun(tx, c, {
        parentRunId: 'r1', parentNodeRunId: 'nr-parent', workflowId: 'child', workflowVersion: 2, now: NOW,
      })).toThrowError(/只有 started/)
    })
  })

  it('自引用的定义在发布期就被拒：环不留到派发', () => {
    const c = catalog()
    expect(() => c.load({
      workflow_id: 'loop',
      workflow_version: '1',
      nodes: [{ node_id: 'sub', type: 'subworkflow', subworkflow: { workflow_id: 'loop', pinned_version: 1 } }],
    })).toThrowError(/子流程引用成环/)
  })

  it('started 父节点进 waiting，子运行终态后才能唤醒为 done', () => {
    const db = memoryDb()
    const c = catalog()
    withTx(db, (tx) => {
      const child = startSubworkflowNode(tx, SECRET, c, {
        nodeRunId: 'nr-parent', attempt: 1, workflowId: 'child', workflowVersion: 2, now: NOW,
      })
      expect(tx.get<{ status: string }>('SELECT status FROM node_runs WHERE node_run_id = ?', ['nr-parent'])!.status).toBe('waiting')
      expect(() => finishSubworkflowChild(tx, SECRET, { childRunId: child.run_id, now: NOW }))
        .toThrowError(/还没收口/)
      tx.run("UPDATE runs SET status = 'done' WHERE run_id = ?", [child.run_id])
      const woke = finishSubworkflowChild(tx, SECRET, { childRunId: child.run_id, now: NOW })
      expect(woke).toEqual({ parentNodeRunId: 'nr-parent', status: 'done' })
      expect(tx.get<{ status: string; lease_id: string | null }>(
        'SELECT status, lease_id FROM node_runs WHERE node_run_id = ?', ['nr-parent'],
      )).toEqual({ status: 'done', lease_id: null })
      expect(finishSubworkflowChild(tx, SECRET, { childRunId: child.run_id, now: NOW }).status).toBe('done')
    })
  })

  it('失败子运行收口父节点为 failed，父 run 不冒充成功', () => {
    const db = memoryDb()
    const c = catalog()
    withTx(db, (tx) => {
      const child = startSubworkflowNode(tx, SECRET, c, {
        nodeRunId: 'nr-parent', attempt: 1, workflowId: 'child', workflowVersion: 2, now: NOW,
      })
      tx.run("UPDATE runs SET status = 'failed_with_unverified' WHERE run_id = ?", [child.run_id])
      const out = finishSubworkflowChild(tx, SECRET, { childRunId: child.run_id, now: NOW })
      expect(out.status).toBe('failed')
      // 子流程带未核实事实：父 run 不能收成普通 failed
      expect(closeRun(tx, SECRET, 'r1', NOW)).toBe('failed_with_unverified')
    })
  })

  it('子运行自己取消、父未取消时父节点落 failed，不能把父 run 收成 succeeded', () => {
    const db = memoryDb()
    const c = catalog()
    withTx(db, (tx) => {
      const child = startSubworkflowNode(tx, SECRET, c, {
        nodeRunId: 'nr-parent', attempt: 1, workflowId: 'child', workflowVersion: 2, now: NOW,
      })
      tx.run("UPDATE runs SET status = 'cancelled' WHERE run_id = ?", [child.run_id])
      const out = finishSubworkflowChild(tx, SECRET, { childRunId: child.run_id, now: NOW })
      expect(out.status).toBe('failed')
      expect(closeRun(tx, SECRET, 'r1', NOW)).toBe('failed_with_unverified')
    })
  })

  it('取消的子运行收口父节点为 superseded，父 run 落 cancelled', () => {
    const db = memoryDb()
    const c = catalog()
    withTx(db, (tx) => {
      const child = startSubworkflowNode(tx, SECRET, c, {
        nodeRunId: 'nr-parent', attempt: 1, workflowId: 'child', workflowVersion: 2, now: NOW,
      })
      tx.run("UPDATE runs SET status = 'cancelled', cancel_requested_at = ? WHERE run_id = ?", [NOW, child.run_id])
      tx.run("UPDATE runs SET cancel_requested_at = ?, cancel_result = 'interrupted' WHERE run_id = 'r1'", [NOW])
      const out = finishSubworkflowChild(tx, SECRET, { childRunId: child.run_id, now: NOW })
      expect(out.status).toBe('superseded')
      expect(closeRun(tx, SECRET, 'r1', NOW)).toBe('cancelled')
    })
  })
})

describe('子流程副作用向父流程传播', () => {
  function seedChild(db: Db, c: WorkflowCatalog, patch: { runStatus: string; nodeStatus: string; policy: string; verifiedNone: number }) {
    return withTx(db, (tx) => {
      const child = startSubworkflowNode(tx, SECRET, c, {
        nodeRunId: 'nr-parent', attempt: 1, workflowId: 'child', workflowVersion: 2, now: NOW,
      })
      tx.run('UPDATE runs SET status = ? WHERE run_id = ?', [patch.runStatus, child.run_id])
      tx.run('UPDATE node_runs SET status = ?, side_effect_policy = ?, side_effect_verified_none = ? WHERE run_id = ?', [
        patch.nodeStatus, patch.policy, patch.verifiedNone, child.run_id,
      ])
      return child.run_id
    })
  }

  it('子流程全部 pure 且成功：父 run 是普通 succeeded', () => {
    const db = memoryDb()
    const c = catalog()
    const childId = seedChild(db, c, { runStatus: 'succeeded', nodeStatus: 'done', policy: 'pure', verifiedNone: 1 })
    withTx(db, (tx) => {
      expect(finishSubworkflowChild(tx, SECRET, { childRunId: childId, now: NOW }).status).toBe('done')
      const parent = tx.get<{ side_effect_policy: string; side_effect_verified_none: number }>(
        'SELECT side_effect_policy, side_effect_verified_none FROM node_runs WHERE node_run_id = ?', ['nr-parent'],
      )!
      expect(parent).toEqual({ side_effect_policy: 'pure', side_effect_verified_none: 1 })
      expect(closeRun(tx, SECRET, 'r1', NOW)).toBe('succeeded')
    })
  })

  it('子流程有未核实副作用：父 run 不得成为普通 succeeded', () => {
    const db = memoryDb()
    const c = catalog()
    const childId = seedChild(db, c, { runStatus: 'succeeded_with_unverified', nodeStatus: 'done', policy: 'compensable', verifiedNone: 0 })
    withTx(db, (tx) => {
      expect(finishSubworkflowChild(tx, SECRET, { childRunId: childId, now: NOW }).status).toBe('done')
      const parent = tx.get<{ side_effect_policy: string; side_effect_verified_none: number }>(
        'SELECT side_effect_policy, side_effect_verified_none FROM node_runs WHERE node_run_id = ?', ['nr-parent'],
      )!
      expect(parent.side_effect_policy).toBe('compensable')
      expect(parent.side_effect_verified_none).toBe(0)
      expect(closeRun(tx, SECRET, 'r1', NOW)).toBe('succeeded_with_unverified')
    })
  })

  it('子流程结算后父运行不继承未核实标记，子运行历史终态保留', () => {
    const db = memoryDb()
    const childId = seedChild(db, catalog(), {
      runStatus: 'succeeded_with_unverified', nodeStatus: 'abandoned_unverified', policy: 'irreversible', verifiedNone: 0,
    })
    withTx(db, (tx) => {
      const child = tx.get<{ node_run_id: string; attempt: number; revision: number }>(
        'SELECT node_run_id, attempt, revision FROM node_runs WHERE run_id = ?', [childId],
      )!
      resolveEffect(tx, SECRET, {
        basis: 'verified_none', nodeRunId: child.node_run_id, runId: childId,
        stopEvidence: `no_tool_started:${child.node_run_id}:${child.attempt}`,
        expected: { revision: child.revision }, now: NOW, operationId: uuidv7(),
        actor: { kind: 'human', id: 'auditor' },
      })
      expect(finishSubworkflowChild(tx, SECRET, { childRunId: childId, now: NOW }).status).toBe('done')
      expect(closeRun(tx, SECRET, 'r1', NOW)).toBe('succeeded')
      expect(tx.get('SELECT status FROM runs WHERE run_id = ?', [childId])).toMatchObject({ status: 'succeeded_with_unverified' })
    })
  })

  it('子流程含 irreversible 且未核实：父节点保留不可逆等级，父 run 落未核实', () => {
    const db = memoryDb()
    const c = catalog()
    const childId = seedChild(db, c, { runStatus: 'succeeded_with_unverified', nodeStatus: 'done', policy: 'irreversible', verifiedNone: 0 })
    withTx(db, (tx) => {
      expect(finishSubworkflowChild(tx, SECRET, { childRunId: childId, now: NOW }).status).toBe('done')
      const parent = tx.get<{ side_effect_policy: string }>(
        'SELECT side_effect_policy FROM node_runs WHERE node_run_id = ?', ['nr-parent'],
      )!
      expect(parent.side_effect_policy).toBe('irreversible')
      expect(closeRun(tx, SECRET, 'r1', NOW)).toBe('succeeded_with_unverified')
    })
  })

  it('子流程失败：父节点按真实结果落 failed，不被吞成成功', () => {
    const db = memoryDb()
    const c = catalog()
    const childId = seedChild(db, c, { runStatus: 'failed', nodeStatus: 'failed', policy: 'compensable', verifiedNone: 0 })
    withTx(db, (tx) => {
      expect(finishSubworkflowChild(tx, SECRET, { childRunId: childId, now: NOW }).status).toBe('failed')
      expect(closeRun(tx, SECRET, 'r1', NOW)).toBe('failed_with_unverified')
    })
  })
})

describe('节点级取消后子运行的未核实事实', () => {
  it('父节点已被取消、子 run 后收口为未核实：父 run 不得变成普通 succeeded', () => {
    const db = memoryDb()
    const c = catalog()
    withTx(db, (tx) => {
      const child = startSubworkflowNode(tx, SECRET, c, {
        nodeRunId: 'nr-parent', attempt: 1, workflowId: 'child', workflowVersion: 2, now: NOW,
      })
      // 节点级取消：父节点直接 superseded（控制节点没有执行实例）
      const parent = tx.get<{ attempt: number; revision: number }>('SELECT attempt, revision FROM node_runs WHERE node_run_id = ?', ['nr-parent'])!
      applyCancel(tx, SECRET, { clock: TEST_CLOCK,
        nodeRunId: 'nr-parent', attempt: parent.attempt, revision: parent.revision,
        cancelResult: 'interrupted', now: NOW, graceMs: 1000,
      })
      expect(tx.get<{ status: string }>('SELECT status FROM node_runs WHERE node_run_id = ?', ['nr-parent'])!.status).toBe('superseded')

      // 子 run 之后才收口，且带未核实副作用
      tx.run("UPDATE runs SET status = 'succeeded_with_unverified' WHERE run_id = ?", [child.run_id])
      tx.run("UPDATE node_runs SET status = 'done', side_effect_policy = 'irreversible', side_effect_verified_none = 0 WHERE run_id = ?", [child.run_id])
      const out = finishSubworkflowChild(tx, SECRET, { childRunId: child.run_id, now: NOW })
      expect(out.status).toBe('superseded')
      const parentRow = tx.get<{ side_effect_policy: string; side_effect_verified_none: number }>(
        'SELECT side_effect_policy, side_effect_verified_none FROM node_runs WHERE node_run_id = ?', ['nr-parent'],
      )!
      expect(parentRow).toEqual({ side_effect_policy: 'irreversible', side_effect_verified_none: 0 })
      // 父 run 没有取消请求：终态必须继承子运行的未核实，而不是普通 succeeded
      expect(closeRun(tx, SECRET, 'r1', NOW)).toBe('succeeded_with_unverified')
    })
  })
})

describe('已取消父节点的子运行收口', () => {
  it.each([
    ['healthy', 'pure'], ['missing head', 'pure'], ['invalid hash', 'pure'],
    ['healthy', 'irreversible'], ['missing head', 'irreversible'], ['invalid hash', 'irreversible'],
    ['uncertain sibling', 'pure'],
  ] as const)('seals the child exactly once with parent state=%s and child policy=%s', (integrity, childPolicy) => {
    const db = memoryDb()
    const parentId = 'nr-parent'
    try {
      const childId = withTx(db, tx => {
        const child = startSubworkflowNode(tx, SECRET, catalog(), {
          nodeRunId: parentId, attempt: 1, workflowId: 'child', workflowVersion: 2, now: NOW,
        })
        const parent = tx.get<{ attempt: number; revision: number }>(
          'SELECT attempt, revision FROM node_runs WHERE node_run_id=?', [parentId])!
        applyCancel(tx, SECRET, { clock: TEST_CLOCK, nodeRunId: parentId, attempt: parent.attempt,
          revision: parent.revision, cancelResult: 'interrupted', now: NOW, graceMs: 1000 })
        const childNode = tx.get<{ node_run_id: string }>('SELECT node_run_id FROM node_runs WHERE run_id=?', [child.run_id])!
        tx.run("UPDATE node_runs SET status='done', side_effect_policy=?, side_effect_verified_none=? WHERE node_run_id=?",
          [childPolicy, childPolicy === 'pure' ? 1 : 0, childNode.node_run_id])
        appendNodeRunEvent(tx, SECRET, childNode.node_run_id, 'fixture.child_stopped', {})
        tx.run("UPDATE runs SET cancel_requested_at=?,cancel_result='interrupted' WHERE run_id=?", [NOW, child.run_id])
        if (integrity === 'missing head') {
          // Restrict the incomplete projection fixture to this disposable memory database.
          tx.exec('DROP TRIGGER trg_node_run_chain_heads_no_delete')
          tx.run('DELETE FROM node_run_chain_heads WHERE node_run_id=?', [parentId])
        } else if (integrity === 'invalid hash') {
          appendNodeRunEvent(tx, 'different fixture signer', parentId, 'fixture.untrusted_event', {})
        } else if (integrity === 'uncertain sibling') {
          tx.run("INSERT INTO node_runs (node_run_id,run_id,node_id,seq,node_type,status,revision,recovery_uncertain,created_at,updated_at)"
            + " VALUES ('nr-sibling','r1','sibling',2,'agent','queued',1,'fixture reason',?,?)", [NOW, NOW])
        }
        return child.run_id
      })
      const parentNode = () => db.raw.prepare('SELECT * FROM node_runs WHERE node_run_id=?').get(parentId)!
      const parentRun = () => db.raw.prepare("SELECT * FROM runs WHERE run_id='r1'").get()!
      const parentChains = () => withTx(db, tx => ({ rows: readChain(tx, parentId), head: readChainHead(tx, parentId) }))
      const before = parentNode()
      expect(before).toMatchObject({ status: 'superseded', side_effect_policy: 'compensable' })
      const beforeRun = parentRun()
      const beforeChain = parentChains()
      expect(withTx(db, tx => closeRun(tx, SECRET, childId, NOW))).toBe('cancelled')
      expect(withTx(db, tx => closeRun(tx, SECRET, childId, NOW))).toBeNull()
      expect(db.raw.prepare('SELECT status FROM runs WHERE run_id=?').get(childId)).toMatchObject({ status: 'cancelled' })
      const receipts = db.raw.prepare("SELECT json_extract(payload_redacted,'$.outcome') AS outcome FROM events WHERE run_id=? AND type='run.terminal'").all(childId)
      expect(receipts).toEqual([{ outcome: childPolicy === 'pure' ? 'succeeded' : 'succeeded_with_unverified' }])
      if (integrity === 'healthy') {
        expect(parentNode()).toMatchObject({ status: 'superseded', side_effect_policy: childPolicy, revision: Number(before.revision) + 1 })
        expect(parentChains().rows.at(-1)?.type).toBe(childPolicy === 'pure' ? 'subworkflow.pure_child_confirmed' : 'subworkflow.unverified_inherited')
      } else {
        expect(() => withTx(db, tx => finishSubworkflowChild(tx, SECRET, { childRunId: childId, now: NOW })))
          .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
        expect(withTx(db, tx => closeRun(tx, SECRET, 'r1', NOW))).toBeNull()
        expect(parentNode()).toEqual(before)
        expect(parentRun()).toEqual(beforeRun)
        expect(parentChains()).toEqual(beforeChain)
        expect(db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id='r1' AND type='run.terminal'").get()).toEqual({ n: 0 })
      }
    } finally { db.raw.close() }
  })

  it.each([
    ['missing head', '链头记录缺失'],
    ['wrong count', '链的条数与链头记录对不上'],
    ['wrong sequence', '链尾序号与链头记录对不上'],
    ['wrong hash', '链尾哈希与链头记录对不上'],
    ['head without events', '整条链在账本里没了'],
    ['head and events missing', '节点已经动过却没有链'],
  ] as const)('reports a parent with %s while maintenance closes its healthy child', (integrity, ledgerReason) => {
    const db = memoryDb()
    const parentId = 'nr-parent'
    try {
      const workflows = catalog()
      const childId = withTx(db, (tx) => {
        const child = startSubworkflowNode(tx, SECRET, workflows, {
          nodeRunId: parentId, attempt: 1, workflowId: 'child', workflowVersion: 2, now: NOW,
        })
        const parent = tx.get<{ attempt: number; revision: number }>(
          'SELECT attempt, revision FROM node_runs WHERE node_run_id = ?', [parentId])!
        applyCancel(tx, SECRET, {
          clock: TEST_CLOCK, nodeRunId: parentId, attempt: parent.attempt, revision: parent.revision,
          cancelResult: 'interrupted', now: NOW, graceMs: 1000,
        })
        const childNode = tx.get<{ node_run_id: string }>('SELECT node_run_id FROM node_runs WHERE run_id = ?', [child.run_id])!
        tx.run("UPDATE node_runs SET status = 'done', side_effect_policy = 'pure', side_effect_verified_none = 1 WHERE node_run_id = ?",
          [childNode.node_run_id])
        appendNodeRunEvent(tx, SECRET, childNode.node_run_id, 'fixture.child_stopped', {})
        tx.run("UPDATE runs SET cancel_requested_at = ?, cancel_result = 'interrupted' WHERE run_id = ?", [NOW, child.run_id])
        tx.run(`INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at)
          VALUES ('r-empty', 't1', 'running', 1, ?, ?)`, [NOW, NOW])
        tx.run(`INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, status, revision, created_at, updated_at)
          VALUES ('nr-empty', 'r-empty', 'empty', 1, 'agent', 'queued', 1, ?, ?)`, [NOW, NOW])

        // Only this disposable ledger simulates a structurally damaged projection or log.
        if (integrity === 'missing head' || integrity === 'head and events missing') {
          tx.exec('DROP TRIGGER trg_node_run_chain_heads_no_delete')
          tx.run('DELETE FROM node_run_chain_heads WHERE node_run_id = ?', [parentId])
        } else if (integrity !== 'head without events') {
          tx.exec('DROP TRIGGER trg_node_run_chain_heads_update_guard')
          const change = { 'wrong count': 'event_count = event_count + 1', 'wrong sequence': 'last_seq = last_seq + 1',
            'wrong hash': "last_hash = 'damaged fixture'" }[integrity]
          tx.run(`UPDATE node_run_chain_heads SET ${change} WHERE node_run_id = ?`, [parentId])
        }
        if (integrity === 'head without events' || integrity === 'head and events missing') {
          tx.exec('DROP TRIGGER trg_node_run_events_no_delete')
          tx.run('DELETE FROM node_run_events WHERE node_run_id = ?', [parentId])
        }
        return child.run_id
      })
      const parentState = () => withTx(db, (tx) => ({
        node: tx.get('SELECT * FROM node_runs WHERE node_run_id = ?', [parentId]),
        run: tx.get("SELECT * FROM runs WHERE run_id = 'r1'"),
        chain: readChain(tx, parentId),
        head: readChainHead(tx, parentId),
      }))
      const before = parentState()
      expect(verifyLedger(db, SECRET).gaps).toEqual([
        expect.objectContaining({ node_run_id: parentId, reason: expect.stringContaining(ledgerReason) }),
      ])
      const deps = { db, secret: SECRET, phase: 'S3' as const, catalog: workflows, clock: TEST_CLOCK }
      expect(sweepNow(deps, NOW)).toMatchObject({ chain_broken: [parentId], runs_closed: [childId], subworkflow_finished: [] })
      expect(sweepNow(deps, NOW)).toMatchObject({ chain_broken: [parentId], runs_closed: [], subworkflow_finished: [] })
      expect(parentState()).toEqual(before)
      expect(db.raw.prepare('SELECT status FROM runs WHERE run_id = ?').get(childId)).toEqual({ status: 'cancelled' })
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'run.terminal'").get(childId)).toEqual({ n: 1 })
    } finally { db.raw.close() }
  })
})

describe('父取消传播与终态闸', () => {
  it('取消压在审批卡上的节点：裁决卡按 cancelled 收口并留事件，节点 failed 且清租约', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status = 'blocked_pre', blocked_decision_id = 'd1', lease_id = 'lease_x', lease_expires_at = ?, executor_session_id = 's1', executor_agent_id = 'a1' WHERE node_run_id = 'nr-parent'", [NOW])
      tx.run("INSERT INTO decisions (decision_id, run_id, node_run_id, kind, status, revision, payload_json, created_at) VALUES ('d1', 'r1', 'nr-parent', 'pre_execution', 'pending', 1, '{}', ?)", [NOW])
      const out = propagateRunCancellation(tx, SECRET, { runId: 'r1', cancelResult: 'interrupted', now: NOW, graceMs: 5000 , clock: TEST_CLOCK})
      expect(out.cancelledNodes).toContain('nr-parent')
      expect(out.runStatus).toBe('cancelled')
      expect(tx.get<{ status: string }>('SELECT status FROM node_runs WHERE node_run_id = ?', ['nr-parent'])!.status).toBe('failed')
      const node = tx.get<{ lease_id: string | null; executor_session_id: string | null; blocked_decision_id: string | null }>(
        'SELECT lease_id, executor_session_id, blocked_decision_id FROM node_runs WHERE node_run_id = ?', ['nr-parent'],
      )!
      expect(node).toEqual({ lease_id: null, executor_session_id: null, blocked_decision_id: null })
      expect(tx.get<{ status: string; closed_reason: string; resolved_by: string | null }>(
        'SELECT status, closed_reason, resolved_by FROM decisions WHERE decision_id = ?', ['d1'],
      )).toEqual({ status: 'resolved', closed_reason: 'cancelled', resolved_by: 'system:cancel' })
      expect(closeRun(tx, SECRET, 'r1', NOW)).toBe('cancelled')
    })
  })

  it('blocked_post 压在人工核验上：不替人清证据门，run 进 cancellation_pending', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status = 'blocked_post' WHERE node_run_id = 'nr-parent'")
      tx.run("INSERT INTO decisions (decision_id, run_id, node_run_id, kind, status, revision, payload_json, created_at) VALUES ('d2', 'r1', 'nr-parent', 'verify_human', 'pending', 1, '{}', ?)", [NOW])
      const out = propagateRunCancellation(tx, SECRET, { runId: 'r1', cancelResult: 'interrupted', now: NOW, graceMs: 5000 , clock: TEST_CLOCK})
      expect(out.pendingHumanDecisions).toEqual(['d2'])
      expect(out.runStatus).toBe('cancellation_pending')
      expect(out.cancelledNodes).toEqual([])
      expect(tx.get<{ status: string }>('SELECT status FROM node_runs WHERE node_run_id = ?', ['nr-parent'])!.status).toBe('blocked_post')
      expect(tx.get<{ status: string }>('SELECT status FROM decisions WHERE decision_id = ?', ['d2'])!.status).toBe('pending')
      expect(closeRun(tx, SECRET, 'r1', NOW)).toBeNull()
    })
  })

  it('已终态 run 再取消：不写取消列，返回 already_stopped', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      tx.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE run_id = 'r1'", [NOW])
      const out = propagateRunCancellation(tx, SECRET, { runId: 'r1', cancelResult: 'interrupted', now: NOW, graceMs: 5000 , clock: TEST_CLOCK})
      expect(out.runStatus).toBe('already_stopped')
      expect(out.cancelledNodes).toEqual([])
      const row = tx.get<{ status: string; cancel_requested_at: string | null }>(
        'SELECT status, cancel_requested_at FROM runs WHERE run_id = ?', ['r1'],
      )!
      expect(row).toEqual({ status: 'succeeded', cancel_requested_at: null })
    })
  })

  it('run 级取消把 queued 的不可逆节点作废，run 才能落 cancelled', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status = 'done' WHERE node_run_id = 'nr-parent'")
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, side_effect_policy, created_at, updated_at) VALUES ('nr-irr', 'r1', 'irr', 2, 'agent', 1, 'queued', 1, 'irreversible', ?, ?)", [NOW, NOW])
      const out = propagateRunCancellation(tx, SECRET, { runId: 'r1', cancelResult: 'interrupted', now: NOW, graceMs: 5000 , clock: TEST_CLOCK})
      expect(out.cancelledNodes).toContain('nr-irr')
      expect(out.skippedIrreversible).not.toContain('nr-irr')
      expect(tx.get<{ status: string }>('SELECT status FROM node_runs WHERE node_run_id = ?', ['nr-irr'])!.status).toBe('superseded')
      expect(closeRun(tx, SECRET, 'r1', NOW)).toBe('cancelled')
    })
  })

  it('取消落到子 run 和可取消节点，不可逆节点跳过；父 run 在子 run 收口前不能进终态', () => {
    const db = memoryDb()
    const c = catalog()
    let childId = ''
    withTx(db, (tx) => {
      const child = startSubworkflowNode(tx, SECRET, c, {
        nodeRunId: 'nr-parent', attempt: 1, workflowId: 'child', workflowVersion: 2, now: NOW,
      })
      childId = child.run_id
      tx.run("UPDATE node_runs SET status = 'started', side_effect_policy = 'compensable' WHERE run_id = ?", [childId])
      tx.run("UPDATE node_runs SET side_effect_policy = 'irreversible' WHERE run_id = ? AND node_id = 'b'", [childId])
      const out = propagateRunCancellation(tx, SECRET, {
        runId: 'r1', cancelResult: 'interrupted', now: NOW, graceMs: 5000,
        clock: TEST_CLOCK,
      })
      expect(out.cancelledRuns).toEqual([childId])
      expect(out.cancelledNodes).toEqual(['nr-parent'])
      expect(out.skippedIrreversible.length).toBe(1)
      expect(out.runStatus).toBe('cancelling')
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
