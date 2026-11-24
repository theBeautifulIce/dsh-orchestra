import { expect, it } from 'vitest'
import { openDb } from '../../src/infra/sqlite/driver.ts'
import { resolveSemanticWorkflow } from '../../src/service/semantic-workflow.ts'

it('looks up the exact historical published version and refuses a missing or ambiguous reference', () => {
  const db = openDb(':memory:')
  db.raw.exec(`CREATE TABLE workflows(workflow_id TEXT,name TEXT,current_version INTEGER,status TEXT,scope TEXT);
    CREATE TABLE workflow_versions(workflow_id TEXT,version TEXT,published_by TEXT);
    INSERT INTO workflows VALUES('w1','Daily Review',3,'active','reusable');
    INSERT INTO workflow_versions VALUES('w1','2','alice'),('w1','3','alice');`)
  const reference = { name: 'Daily Review', quote: '用 Daily Review 第 2 版', source_message_id: 'u1' }
  try {
    expect(resolveSemanticWorkflow(db, { ...reference, version: '2' })).toEqual({ workflow_id: 'w1', workflow_version: '2' })
    expect(resolveSemanticWorkflow(db, reference)).toEqual({ workflow_id: 'w1', workflow_version: '3' })
    expect(() => resolveSemanticWorkflow(db, { ...reference, version: '4' })).toThrow('尚未发布')
    expect(() => resolveSemanticWorkflow(db, { ...reference, name: 'absent' })).toThrow('未找到')
    db.raw.exec("INSERT INTO workflows VALUES('w2','Daily Review',1,'active','reusable')")
    expect(() => resolveSemanticWorkflow(db, reference)).toThrow('同名')
  } finally { db.raw.close() }
})
