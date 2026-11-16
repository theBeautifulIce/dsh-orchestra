// S4 三张表与版本不可变触发器（计划 Task 4）
import { describe, expect, it } from 'vitest'
import { freshLedger } from '../fixtures/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'

const NOW = '2026-11-16T14:00:00.000Z'

describe('工作流身份 / 草稿 / 版本不可变', () => {
  it('workflows 与 workflow_drafts 能落库，drafts 按 workflow_id 唯一', () => {
    const { db } = freshLedger()
    withTx(db, (tx) => {
      tx.run('INSERT INTO workflows (workflow_id, name, status, current_version, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['wf1', '发布流水线', 'active', null, 'human:me', 'human:me', NOW, NOW])
      tx.run('INSERT INTO workflow_drafts (workflow_id, revision, doc_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
        ['wf1', 1, '{"name":"发布流水线"}', 'human:me', NOW])
      tx.run('UPDATE workflow_drafts SET revision = ?, doc_json = ?, updated_at = ? WHERE workflow_id = ?',
        [2, '{"name":"发布流水线","nodes":[]}', NOW, 'wf1'])
    })
    const draft = db.raw.prepare('SELECT revision, doc_json FROM workflow_drafts WHERE workflow_id = ?').get('wf1') as { revision: number; doc_json: string }
    expect(draft.revision).toBe(2)
    expect(draft.doc_json).toContain('"nodes"')
    db.raw.close()
  })

  it('已发布版本只插不改：UPDATE 被触发器拒绝', () => {
    const { db } = freshLedger()
    withTx(db, (tx) => {
      tx.run('INSERT INTO workflow_versions (workflow_id, version, content_hash, definition_json, created_at, doc_json, published_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['wf1', '1', 'h1', '{"nodes":[]}', NOW, '{"name":"v1"}', 'human:me'])
    })
    expect(() => withTx(db, (tx) => {
      tx.run('UPDATE workflow_versions SET content_hash = ? WHERE workflow_id = ? AND version = ?', ['h2', 'wf1', '1'])
    })).toThrowError(/不可修改/)
    const row = db.raw.prepare('SELECT content_hash FROM workflow_versions WHERE workflow_id = ? AND version = ?').get('wf1', '1') as { content_hash: string }
    expect(row.content_hash).toBe('h1')
    db.raw.close()
  })

  it('已发布版本不许删除', () => {
    const { db } = freshLedger()
    withTx(db, (tx) => {
      tx.run('INSERT INTO workflow_versions (workflow_id, version, content_hash, definition_json, created_at) VALUES (?, ?, ?, ?, ?)',
        ['wf1', '1', 'h1', '{"nodes":[]}', NOW])
    })
    expect(() => withTx(db, (tx) => {
      tx.run('DELETE FROM workflow_versions WHERE workflow_id = ? AND version = ?', ['wf1', '1'])
    })).toThrowError(/不可删除/)
    db.raw.close()
  })

  it('同一 workflow 的同一版本只能有一份：PK 冲突', () => {
    const { db } = freshLedger()
    const insert = () => withTx(db, (tx) => {
      tx.run('INSERT INTO workflow_versions (workflow_id, version, content_hash, definition_json, created_at) VALUES (?, ?, ?, ?, ?)',
        ['wf1', '1', 'h1', '{"nodes":[]}', NOW])
    })
    insert()
    expect(insert).toThrowError()
    // 不同 workflow 可以各自有版本 1
    expect(() => withTx(db, (tx) => {
      tx.run('INSERT INTO workflow_versions (workflow_id, version, content_hash, definition_json, created_at) VALUES (?, ?, ?, ?, ?)',
        ['wf2', '1', 'h1', '{"nodes":[]}', NOW])
    })).not.toThrow()
    db.raw.close()
  })
})
