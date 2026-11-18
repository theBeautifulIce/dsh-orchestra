// S5-Fb：记忆固定图的专用运行骨架测试（src/service/commands/memory-run.ts）。
// 钉住：固定图 9 行的建行顺序（显式拓扑序）与 node_type（= kind）、幂等回放不重复建行、
// 事务中途失败不留半成品、推进原语的三个分支路由与 fail closed 行为、
// 记忆节点不进通用 workflow 节点类型表、memory_bridge: 前缀不进普通工具注册表。
import { describe, expect, it } from 'vitest'
import { OrchError } from '../../src/core/errors.ts'
import { MEMORY_TOOLS } from '../../src/core/memory-graph.ts'
import { findMemoryNode, memoryGraphOrder } from '../../src/core/memory-graph-schema.ts'
import { isKnownNodeType } from '../../src/core/workflow-def.ts'
import { ToolRegistry } from '../../src/executor/tools.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { MEMORY_WORKFLOW_ID, startMemoryRun } from '../../src/service/commands/memory.ts'
import {
  MEMORY_ROUTE_NAMES,
  advanceMemoryRun,
  assertMemoryRunStart,
  createMemoryRunNodeRuns,
  memoryRunStartNode,
} from '../../src/service/commands/memory-run.ts'
import { countOf, freshLedger } from '../fixtures/ledger.ts'

const NOW = '2026-11-18T07:00:00.000Z'
const OP_A = '0192c3a4-5b6d-7e8f-9a0b-1c2d3e4f5071'
const OP_B = '0192c3a4-5b6d-7e8f-9a0b-1c2d3e4f5072'

function errOf(fn: () => unknown): OrchError {
  try {
    fn()
  } catch (err) {
    if (err instanceof OrchError) return err
    throw err
  }
  throw new Error('本应抛错却通过了')
}

function seedSourceRun(db: Db, runId = 'run_src_1', status = 'succeeded'): void {
  withTx(db, (tx) => {
    tx.run(
      "INSERT OR IGNORE INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('tsk_mem_1', '记忆任务', 'running', 0, ?, ?)",
      [NOW, NOW],
    )
    tx.run(
      'INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, started_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 0, ?, ?, ?)',
      [runId, 'tsk_mem_1', 'wf_main', status, NOW, NOW, NOW],
    )
  })
}

function nodeRowsOf(db: Db, runId: string): Array<{ node_id: string; seq: number; node_type: string }> {
  return db.raw.prepare('SELECT node_id, seq, node_type FROM node_runs WHERE run_id = ? ORDER BY seq')
    .all(runId) as Array<{ node_id: string; seq: number; node_type: string }>
}

describe('记忆固定图的专用运行骨架', () => {
  it('发起记忆运行 → 同一笔事务建出 9 行：node_id 按显式拓扑序，node_type 取节点 kind', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    const started = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A, now: NOW,
    })
    const runRow = db.raw.prepare('SELECT workflow_id, workflow_definition_hash FROM runs WHERE run_id = ?')
      .get(started.memory_run_id) as { workflow_id: string; workflow_definition_hash: string | null }
    expect(runRow.workflow_id).toBe(MEMORY_WORKFLOW_ID)
    // 没有绑定通用定义哈希：记忆 run 不会被通用 dispatcher 当成普通工作流派发
    expect(runRow.workflow_definition_hash).toBeNull()

    const rows = nodeRowsOf(db, started.memory_run_id)
    expect(rows.length).toBe(9)
    expect(rows.map((row) => row.node_id)).toEqual([...memoryGraphOrder()])
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(rows.map((row) => row.node_type)).toEqual(
      [...memoryGraphOrder()].map((node_id) => findMemoryNode(node_id)?.kind),
    )
    // node_type 只有固定图的六种 kind
    expect([...new Set(rows.map((row) => row.node_type))].sort()).toEqual(
      ['agent', 'approval', 'branch', 'report', 'tool', 'trigger'],
    )
    db.raw.close()
  })

  it('幂等回放 → 不重复建行', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    const first = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A, now: NOW,
    })
    const replay = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_B, now: NOW,
    })
    expect(replay.replayed).toBe(true)
    expect(replay.memory_run_id).toBe(first.memory_run_id)
    expect(countOf(db, 'node_runs')).toBe(9)
    expect(nodeRowsOf(db, first.memory_run_id).length).toBe(9)
    db.raw.close()
  })

  it('事务中途失败 → 不留半成品（run、节点行、批次、映射一起回滚）', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    db.raw.exec(
      "CREATE TRIGGER inject_mid_tx_failure BEFORE INSERT ON memory_run_requests "
      + "BEGIN SELECT RAISE(ABORT, 'INJECTED_MID_TX_FAILURE'); END",
    )
    expect(() => startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A, now: NOW,
    })).toThrow()
    expect(countOf(db, 'node_runs')).toBe(0)
    expect(countOf(db, 'memory_batches')).toBe(0)
    expect(countOf(db, 'memory_run_requests')).toBe(0)
    const memoryRuns = db.raw.prepare('SELECT COUNT(*) AS n FROM runs WHERE workflow_id = ?').get(MEMORY_WORKFLOW_ID) as { n: number }
    expect(Number(memoryRuns.n)).toBe(0)
    db.raw.close()
  })

  it('同一个记忆运行重复建行 → 拒（不再插第二批节点行）', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    const started = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A, now: NOW,
    })
    const err = errOf(() => withTx(db, (tx) => {
      createMemoryRunNodeRuns(tx, started.memory_run_id, NOW)
    }))
    expect(err.code).toBe('MEMORY_RUN_ACTIVE')
    expect(countOf(db, 'node_runs')).toBe(9)
    db.raw.close()
  })

  it('推进原语：ready → mem_confirm，empty → mem_report_empty，blocked → mem_report_blocked', () => {
    expect(MEMORY_ROUTE_NAMES).toEqual(['ready', 'empty', 'blocked'])
    expect(advanceMemoryRun('mem_route', 'ready')).toEqual({ from: 'mem_route', to: 'mem_confirm', route: 'ready' })
    expect(advanceMemoryRun('mem_route', 'empty')).toEqual({ from: 'mem_route', to: 'mem_report_empty', route: 'empty' })
    expect(advanceMemoryRun('mem_route', 'blocked')).toEqual({ from: 'mem_route', to: 'mem_report_blocked', route: 'blocked' })
    // 非分支节点按固定图的线性后继推进
    expect(advanceMemoryRun('mem_trigger')).toEqual({ from: 'mem_trigger', to: 'mem_prepare', route: null })
    expect(advanceMemoryRun('mem_apply')).toEqual({ from: 'mem_apply', to: 'mem_report', route: null })
  })

  it('推进原语 fail closed：非法路由 / 未知节点 / 非分支带路由 / 没有后继', () => {
    expect(errOf(() => advanceMemoryRun('mem_route')).code).toBe('WORKFLOW_BRANCH_ROUTE_INVALID')
    expect(errOf(() => advanceMemoryRun('mem_route', 'nope')).code).toBe('WORKFLOW_BRANCH_ROUTE_INVALID')
    expect(errOf(() => advanceMemoryRun('mem_prepare', 'ready')).code).toBe('WORKFLOW_BRANCH_ROUTE_INVALID')
    expect(errOf(() => advanceMemoryRun('mem_unknown')).code).toBe('WORKFLOW_NODE_ID_INVALID')
    expect(errOf(() => advanceMemoryRun('mem_report')).code).toBe('WORKFLOW_NODE_FANOUT_INVALID')
  })

  it('起推只认 trigger：非触发节点起推 → WORKFLOW_NODE_CONFIG_INVALID', () => {
    expect(memoryRunStartNode()).toBe('mem_trigger')
    expect(assertMemoryRunStart('mem_trigger')).toBe('mem_trigger')
    expect(errOf(() => assertMemoryRunStart('mem_prepare')).code).toBe('WORKFLOW_NODE_CONFIG_INVALID')
    expect(errOf(() => assertMemoryRunStart('mem_unknown')).code).toBe('WORKFLOW_NODE_ID_INVALID')
  })

  it('记忆运行只走专用路径：记忆节点不进通用 workflow 类型表，memory_bridge: 不进普通工具注册表', () => {
    for (const node_id of memoryGraphOrder()) {
      expect(isKnownNodeType(node_id)).toBe(false)
    }
    for (const kind of ['trigger', 'tool', 'branch', 'approval', 'report']) {
      expect(isKnownNodeType(kind)).toBe(false)
    }
    const registry = new ToolRegistry()
    expect(registry.list().length).toBe(0)
    expect(registry.lookup(MEMORY_TOOLS.evaluate)).toBeUndefined()
    expect(registry.lookup(MEMORY_TOOLS.applyGoverned)).toBeUndefined()
    expect(registry.lookup(MEMORY_TOOLS.inspectBatch)).toBeUndefined()
  })
})
