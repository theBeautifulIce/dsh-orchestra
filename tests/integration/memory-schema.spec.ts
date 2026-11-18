// S5-E：记忆迁移 030/032 的数据约束测试
// 钉住：四张表的唯一键、批准后条目冻结、request_key/client_key 字符合法性、
// 同一源运行只允许一条未终结批次、批次只能挂在成功收口的源运行上。
import { describe, expect, it } from 'vitest'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { MEMORY_GRAPH } from '../../src/core/memory-graph.ts'
import { freshLedger } from '../fixtures/ledger.ts'

const NOW = '2026-11-18T06:00:00.000Z'

function seed(db: Db): void {
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('tsk_s', 'schema', 'running', 0, ?, ?)",
      [NOW, NOW],
    )
    tx.run(
      "INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, started_at, created_at, updated_at) VALUES ('run_src', 'tsk_s', 'wf_main', 1, 'succeeded', 0, ?, ?, ?)",
      [NOW, NOW, NOW],
    )
    tx.run(
      "INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, started_at, created_at, updated_at) VALUES ('run_open', 'tsk_s', 'wf_main', 1, 'running', 0, ?, ?, ?)",
      [NOW, NOW, NOW],
    )
    tx.run(
      "INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, started_at, created_at, updated_at) VALUES ('run_mem', 'tsk_s', 'sys.memory_write', 1, 'running', 0, ?, ?, ?)",
      [NOW, NOW, NOW],
    )
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nrun_mem_1', 'run_mem', 'mem_prepare', 1, 'agent', 1, 'queued', 0, ?, ?)",
      [NOW, NOW],
    )
  })
}

type BatchOver = {
  batch_id?: string
  source_run_id?: string
  memory_run_id?: string
  attempt?: number
  status?: string
  outcome?: string | null
}

function insertBatch(db: Db, over: BatchOver = {}): void {
  withTx(db, (tx) => {
    tx.run(
      'INSERT INTO memory_batches (batch_id, task_id, source_run_id, memory_run_id, attempt, status, outcome, created_at, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        over.batch_id ?? 'batch_1',
        'tsk_s',
        over.source_run_id ?? 'run_src',
        over.memory_run_id ?? 'run_mem',
        over.attempt ?? 1,
        over.status ?? 'draft',
        over.outcome ?? null,
        NOW,
        NOW,
      ],
    )
  })
}

function insertItem(db: Db, over: { item_id?: string; batch_id?: string; client_key?: string; content?: string } = {}): void {
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO memory_items (item_id, batch_id, client_key, action, target_id, layer, title, content, tags_json, questions_json, content_hash, status) "
      + "VALUES (?, ?, ?, 'update', 'target_1', 'L4', '标题', ?, '[]', '[]', 'hash_1', 'proposed')",
      [
        over.item_id ?? 'memitem_1',
        over.batch_id ?? 'batch_1',
        over.client_key ?? 'item_1',
        over.content ?? '内容',
      ],
    )
  })
}

describe('记忆迁移 030/032 的数据约束', () => {
  it('四张记忆表都在', () => {
    const { db } = freshLedger()
    const tables = db.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_%' ORDER BY name",
    ).all() as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toEqual([
      'memory_batches', 'memory_evaluations', 'memory_items', 'memory_run_requests',
    ])
    db.raw.close()
  })

  it('同一 (source_run_id, attempt) 不能插第二条批次', () => {
    const { db } = freshLedger()
    seed(db)
    insertBatch(db)
    expect(() => insertBatch(db, { batch_id: 'batch_2', memory_run_id: 'run_mem', status: 'empty', outcome: 'nothing_to_write' }))
      .toThrow(/UNIQUE constraint failed: memory_batches.source_run_id, memory_batches.attempt/)
    db.raw.close()
  })

  it('同一源运行不能同时有两条未终结批次', () => {
    const { db } = freshLedger()
    seed(db)
    insertBatch(db)
    expect(() => insertBatch(db, { batch_id: 'batch_2', attempt: 2 }))
      .toThrow(/UNIQUE constraint failed: memory_batches.source_run_id/)
    db.raw.close()
  })

  it('批次只能挂在成功收口的源运行上', () => {
    const { db } = freshLedger()
    seed(db)
    expect(() => insertBatch(db, { source_run_id: 'run_open' }))
      .toThrow(/MEMORY_SOURCE_RUN_NOT_SETTLED/)
    db.raw.close()
  })

  it('同一 (batch_id, client_key) 不能插第二条条目', () => {
    const { db } = freshLedger()
    seed(db)
    insertBatch(db)
    insertItem(db)
    expect(() => insertItem(db, { item_id: 'memitem_2' }))
      .toThrow(/UNIQUE constraint failed: memory_items.batch_id, memory_items.client_key/)
    db.raw.close()
  })

  it('批次批准后条目不许新增、删除或改内容，只许改 status 与 applied_item_id', () => {
    const { db } = freshLedger()
    seed(db)
    insertBatch(db)
    insertItem(db)
    withTx(db, (tx) => {
      tx.run("UPDATE memory_batches SET status = 'awaiting_human', updated_at = ? WHERE batch_id = 'batch_1'", [NOW])
      tx.run(
        "UPDATE memory_batches SET status = 'approved', approved_proposal_hash = 'h1', approved_item_hashes_json = '[]', updated_at = ? WHERE batch_id = 'batch_1'",
        [NOW],
      )
    })
    expect(() => insertItem(db, { item_id: 'memitem_2', client_key: 'item_2' }))
      .toThrow(/MEMORY_APPLY_BINDING_INVALID/)
    expect(() => withTx(db, (tx) => tx.run("DELETE FROM memory_items WHERE client_key = 'item_1'")))
      .toThrow(/MEMORY_APPLY_BINDING_INVALID/)
    expect(() => withTx(db, (tx) => tx.run("UPDATE memory_items SET content = '改写' WHERE client_key = 'item_1'")))
      .toThrow(/MEMORY_APPLY_BINDING_INVALID/)
    expect(() => withTx(db, (tx) => tx.run("UPDATE memory_items SET status = 'applied' WHERE client_key = 'item_1'")))
      .not.toThrow()
    expect(() => withTx(db, (tx) => tx.run("UPDATE memory_items SET applied_item_id = 'memitem_x' WHERE client_key = 'item_1'")))
      .not.toThrow()
    db.raw.close()
  })

  it('memory_run_requests 同键重复插报主键冲突，同 memory_run_id 换键也报冲突', () => {
    const { db } = freshLedger()
    seed(db)
    insertBatch(db)
    withTx(db, (tx) => {
      tx.run(
        'INSERT INTO memory_run_requests (source_run_id, request_key, memory_run_id, created_at) VALUES (?, ?, ?, ?)',
        ['run_src', 'req_1', 'run_mem', NOW],
      )
    })
    expect(() => withTx(db, (tx) => {
      tx.run(
        'INSERT INTO memory_run_requests (source_run_id, request_key, memory_run_id, created_at) VALUES (?, ?, ?, ?)',
        ['run_src', 'req_1', 'run_open', NOW],
      )
    })).toThrow(/UNIQUE constraint failed: memory_run_requests.source_run_id, memory_run_requests.request_key/)
    expect(() => withTx(db, (tx) => {
      tx.run(
        'INSERT INTO memory_run_requests (source_run_id, request_key, memory_run_id, created_at) VALUES (?, ?, ?, ?)',
        ['run_src', 'req_2', 'run_mem', NOW],
      )
    })).toThrow(/UNIQUE constraint failed: memory_run_requests.memory_run_id/)
    db.raw.close()
  })

  it('request_key 与 client_key 只允许小写字母、数字、下划线和短横线', () => {
    const { db } = freshLedger()
    seed(db)
    insertBatch(db)
    expect(() => withTx(db, (tx) => {
      tx.run(
        'INSERT INTO memory_run_requests (source_run_id, request_key, memory_run_id, created_at) VALUES (?, ?, ?, ?)',
        ['run_src', 'Req_1', 'run_mem', NOW],
      )
    })).toThrow(/CHECK constraint failed: length\(request_key\)/)
    expect(() => withTx(db, (tx) => {
      tx.run(
        'INSERT INTO memory_run_requests (source_run_id, request_key, memory_run_id, created_at) VALUES (?, ?, ?, ?)',
        ['run_src', 'a'.repeat(65), 'run_mem', NOW],
      )
    })).toThrow(/CHECK constraint failed: length\(request_key\)/)
    expect(() => insertItem(db, { item_id: 'memitem_2', client_key: 'Item_1' }))
      .toThrow(/CHECK constraint failed: length\(client_key\)/)
    db.raw.close()
  })

  it('固定图的三条报告分支互不相连，各有唯一入边', () => {
    const reports = ['mem_report', 'mem_report_empty', 'mem_report_blocked']
    const edges = MEMORY_GRAPH.map((edge) => [...edge] as [string, string])
    for (const report of reports) {
      const incoming = edges.filter(([, to]) => to === report)
      expect(incoming.length).toBe(1)
      const outgoing = edges.filter(([from]) => from === report)
      expect(outgoing.length).toBe(0)
      for (const other of reports) {
        if (other === report) continue
        expect(edges.some(([from, to]) => from === report && to === other)).toBe(false)
        expect(edges.some(([from, to]) => from === other && to === report)).toBe(false)
      }
    }
  })
})
