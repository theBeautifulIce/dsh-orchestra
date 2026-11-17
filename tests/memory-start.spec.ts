// S5-E：记忆发起（memory_start_run）的幂等、活跃冲突与事务原子性
// 规格 9.4：同 key 重发返回同一个记忆 run 与 attempt；同源换 key 撞活跃批次报 MEMORY_RUN_ACTIVE；
// 源运行没成功收口就拒；run、节点、批次与映射在同一笔事务里提交。
import { describe, expect, it } from 'vitest'
import { OrchError } from '../src/core/errors.ts'
import { findMemoryNode, memoryGraphOrder } from '../src/core/memory-graph-schema.ts'
import { openDb, withTx, type Db } from '../src/infra/sqlite/driver.ts'
import { MEMORY_WORKFLOW_ID, saveMemoryProposal, startMemoryRun } from '../src/service/commands/memory.ts'
import type { MemoryItemInput } from '../src/core/memory-canonical.ts'
import { countOf, freshLedger } from './fixtures/ledger.ts'

const NOW = '2026-11-18T03:00:00.000Z'
const OP_A = '0192c3a4-5b6d-7e8f-9a0b-1c2d3e4f5061'
const OP_B = '0192c3a4-5b6d-7e8f-9a0b-1c2d3e4f5062'
const OP_C = '0192c3a4-5b6d-7e8f-9a0b-1c2d3e4f5063'
const OP_D = '0192c3a4-5b6d-7e8f-9a0b-1c2d3e4f5064'

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

function memoryRunCount(db: Db): number {
  const row = db.raw.prepare('SELECT COUNT(*) AS n FROM runs WHERE workflow_id = ?').get(MEMORY_WORKFLOW_ID) as { n: number }
  return Number(row.n)
}

function item(clientKey: string, over: Partial<MemoryItemInput> = {}): MemoryItemInput {
  return {
    client_key: clientKey,
    action: 'update',
    target_id: 'target_1',
    layer: 'L4',
    title: '标题',
    content: '内容',
    tags: [],
    questions: [],
    key: null,
    importance: 5,
    ttl_days: null,
    quote: '引文',
    reason: '原因',
    ...over,
  }
}

describe('memory_start_run 发起与幂等', () => {
  it('源运行还没成功收口就发起记忆整理 → 拒，且不留批次与映射', () => {
    const { db } = freshLedger()
    seedSourceRun(db, 'run_src_1', 'running')
    const err = errOf(() => startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '收口后整理', request_key: 'req_1', operation_id: OP_A, now: NOW,
    }))
    expect(err.code).toBe('MEMORY_SOURCE_RUN_NOT_SETTLED')
    expect(countOf(db, 'memory_batches')).toBe(0)
    expect(countOf(db, 'memory_run_requests')).toBe(0)
    expect(memoryRunCount(db)).toBe(0)
    db.raw.close()
  })

  it('同一个 request_key 重发 → 返回同一个记忆 run 与 attempt，映射只留一行', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    const first = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A, now: NOW,
    })
    const second = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_B, now: NOW,
    })
    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.memory_run_id).toBe(first.memory_run_id)
    expect(second.attempt).toBe(first.attempt)
    expect(second.batch_id).toBe(first.batch_id)
    expect(countOf(db, 'memory_batches')).toBe(1)
    expect(countOf(db, 'memory_run_requests')).toBe(1)
    expect(memoryRunCount(db)).toBe(1)
    db.raw.close()
  })

  it('同一个 operation_id 重发 → 回放同一张回执', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    const first = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A, now: NOW,
    })
    const replayed = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A, now: NOW,
    })
    expect(replayed.replayed).toBe(true)
    expect(replayed.memory_run_id).toBe(first.memory_run_id)
    expect(replayed.attempt).toBe(first.attempt)
    expect(countOf(db, 'memory_batches')).toBe(1)
    db.raw.close()
  })

  it('记忆 run、固定图节点、批次与映射在同一笔事务里落库', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    const started = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A, now: NOW,
    })
    const runRow = db.raw.prepare('SELECT task_id, workflow_id, status FROM runs WHERE run_id = ?')
      .get(started.memory_run_id) as { task_id: string; workflow_id: string; status: string }
    expect(runRow.task_id).toBe('tsk_mem_1')
    expect(runRow.workflow_id).toBe(MEMORY_WORKFLOW_ID)
    expect(runRow.status).toBe('running')
    const nodeRows = db.raw.prepare('SELECT node_id, seq, node_type FROM node_runs WHERE run_id = ? ORDER BY seq')
      .all(started.memory_run_id) as Array<{ node_id: string; seq: number; node_type: string }>
    expect(nodeRows.length).toBe(9)
    expect(nodeRows[0]?.node_id).toBe('mem_trigger')
    // 节点顺序 = 固定图的显式拓扑序；node_type = 节点 kind（不再是旧的 memory_* 中间态命名）
    expect(nodeRows.map((row) => row.node_id)).toEqual([...memoryGraphOrder()])
    expect(nodeRows.map((row) => row.node_type)).toEqual(
      [...memoryGraphOrder()].map((node_id) => findMemoryNode(node_id)?.kind),
    )
    const batchRow = db.raw.prepare('SELECT source_run_id, memory_run_id, attempt, status, task_id FROM memory_batches WHERE batch_id = ?')
      .get(started.batch_id) as { source_run_id: string; memory_run_id: string; attempt: number; status: string; task_id: string }
    expect(batchRow.source_run_id).toBe('run_src_1')
    expect(batchRow.memory_run_id).toBe(started.memory_run_id)
    expect(batchRow.attempt).toBe(1)
    expect(batchRow.status).toBe('draft')
    expect(batchRow.task_id).toBe('tsk_mem_1')
    const mapping = db.raw.prepare('SELECT memory_run_id FROM memory_run_requests WHERE source_run_id = ? AND request_key = ?')
      .get('run_src_1', 'req_1') as { memory_run_id: string }
    expect(mapping.memory_run_id).toBe(started.memory_run_id)
    db.raw.close()
  })

  it('同源换 key 且有未终结记忆批次 → MEMORY_RUN_ACTIVE，不建第二条', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    const first = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A, now: NOW,
    })
    const err = errOf(() => startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '再整理一次', request_key: 'req_2', operation_id: OP_B, now: NOW,
    }))
    expect(err.code).toBe('MEMORY_RUN_ACTIVE')
    expect(err.details.memory_run_id).toBe(first.memory_run_id)
    expect(countOf(db, 'memory_batches')).toBe(1)
    expect(countOf(db, 'memory_run_requests')).toBe(1)
    expect(memoryRunCount(db)).toBe(1)
    db.raw.close()
  })

  it('事务中途失败不留半成品：run、批次、映射都不留残行', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    db.raw.exec(
      "CREATE TRIGGER inject_mid_tx_failure BEFORE INSERT ON memory_run_requests "
      + "BEGIN SELECT RAISE(ABORT, 'INJECTED_MID_TX_FAILURE'); END",
    )
    expect(() => startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A, now: NOW,
    })).toThrow()
    expect(countOf(db, 'memory_batches')).toBe(0)
    expect(countOf(db, 'memory_run_requests')).toBe(0)
    expect(countOf(db, 'node_runs')).toBe(0)
    expect(memoryRunCount(db)).toBe(0)
    db.raw.close()
  })

  it('批次终结后不重试就返回最近一次，retry=true 才加一次 attempt', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    const first = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A, now: NOW,
    })
    withTx(db, (tx) => {
      tx.run("UPDATE memory_batches SET status = 'empty', outcome = 'nothing_to_write', updated_at = ? WHERE batch_id = ?", [NOW, first.batch_id])
    })
    const again = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_2', operation_id: OP_B, now: NOW,
    })
    expect(again.attempt).toBe(1)
    expect(again.memory_run_id).toBe(first.memory_run_id)
    const retried = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '再试一次', request_key: 'req_3', retry: true, operation_id: OP_C, now: NOW,
    })
    expect(retried.attempt).toBe(2)
    expect(retried.memory_run_id).not.toBe(first.memory_run_id)
    expect(countOf(db, 'memory_batches')).toBe(2)
    db.raw.close()
  })

  it('重启后同 request_key 仍然命中同一个记忆 run', () => {
    const { db, file } = freshLedger()
    seedSourceRun(db)
    const first = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A, now: NOW,
    })
    db.raw.close()
    const reopened = openDb(file)
    const again = startMemoryRun(reopened, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_B, now: NOW,
    })
    expect(again.replayed).toBe(true)
    expect(again.memory_run_id).toBe(first.memory_run_id)
    expect(again.attempt).toBe(first.attempt)
    reopened.raw.close()
  })

  it('校验通过后同目标重复保存 → 记为 skipped，不重复落条目', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    const started = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A, now: NOW,
    })
    const saved = withTx(db, (tx) => saveMemoryProposal(tx, {
      batch_id: started.batch_id,
      items: [item('item_1'), item('item_2')],
      now: NOW,
    }))
    expect(saved.saved).toBe(1)
    expect(saved.skipped).toBe(1)
    const rows = db.raw.prepare('SELECT client_key, status FROM memory_items WHERE batch_id = ? ORDER BY client_key')
      .all(started.batch_id) as Array<{ client_key: string; status: string }>
    expect(rows.map((row) => row.status)).toEqual(['proposed', 'skipped'])
    db.raw.close()
  })

  it('同批同目标内容不同 → MEMORY_BATCH_CONFLICT，且不落任何条目', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    const started = startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A, now: NOW,
    })
    const err = errOf(() => withTx(db, (tx) => saveMemoryProposal(tx, {
      batch_id: started.batch_id,
      items: [item('item_1'), item('item_2', { content: '另一份内容' })],
      now: NOW,
    })))
    expect(err.code).toBe('MEMORY_BATCH_CONFLICT')
    expect(countOf(db, 'memory_items')).toBe(0)
    db.raw.close()
  })

  it('发起方带着写工具来发起 → 拒，且不留任何行', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    const err = errOf(() => startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: OP_A,
      caller_allow: ['memory_write'], now: NOW,
    }))
    expect(err.code).toBe('MEMORY_WRITE_TOOL_FORBIDDEN')
    expect(countOf(db, 'memory_batches')).toBe(0)
    expect(countOf(db, 'memory_run_requests')).toBe(0)
    expect(memoryRunCount(db)).toBe(0)
    db.raw.close()
  })

  it('request_key 长度或字符不合法 → MEMORY_PROPOSAL_INVALID', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    expect(errOf(() => startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'a'.repeat(65), operation_id: OP_A, now: NOW,
    })).code).toBe('MEMORY_PROPOSAL_INVALID')
    expect(errOf(() => startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'Req_1', operation_id: OP_B, now: NOW,
    })).code).toBe('MEMORY_PROPOSAL_INVALID')
    expect(countOf(db, 'memory_batches')).toBe(0)
    db.raw.close()
  })

  it('operation_id 不是 UUIDv7 → PAYLOAD_SCHEMA_INVALID', () => {
    const { db } = freshLedger()
    seedSourceRun(db)
    expect(errOf(() => startMemoryRun(db, {
      source_run_id: 'run_src_1', reason: '整理记忆', request_key: 'req_1', operation_id: 'op_1', now: NOW,
    })).code).toBe('PAYLOAD_SCHEMA_INVALID')
    expect(countOf(db, 'memory_batches')).toBe(0)
    db.raw.close()
  })
})
