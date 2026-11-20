import { rmSync } from 'node:fs'
import { expect, it } from 'vitest'
import { uuidv7 } from '../../src/core/ids.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { createExecutionScheduler } from '../../src/service/execution-scheduler.ts'
import { createWorkflowConcurrencyHost, type WorkflowConcurrencyHost } from '../../src/service/workflow-concurrency-settings.ts'
import { freshLedger } from '../fixtures/ledger.ts'

it('inherits three limits independently, validates published targets and rehydrates the exact scope', async () => {
  const { db, dir } = freshLedger()
  const scheduler = createExecutionScheduler({ concurrency: 6 })
  const now = new Date().toISOString()
  const host = createWorkflowConcurrencyHost(db, scheduler, true)
  const save = (cmd: Omit<Parameters<WorkflowConcurrencyHost['save']>[0], 'operation_id'>) =>
    host.save({ ...cmd, operation_id: uuidv7() }, 'local-tester', now)
  const scope = { runId: 'r1', workflowId: 'office', nodeId: 'review' }
  try {
    withTx(db, (tx) => {
      tx.run("INSERT INTO workflows(workflow_id,name,current_version,created_by,updated_by,created_at,updated_at) VALUES('office','收款复核','1','t','t',?,?)", [now, now])
      tx.run("INSERT INTO workflow_versions(workflow_id,version,content_hash,definition_json,created_at) VALUES('office','1','hash',?,?)",
        [JSON.stringify({ nodes: [{ node_id: 'review', type: 'agent' }, { node_id: 'hold', type: 'wait' }] }), now])
    })
    save({ expected_revision: 0, values: { run_limit: 3, node_limit: 2, helper_limit: 1 } })
    save({ workflow_id: 'office', expected_revision: 0, values: { run_limit: 2, helper_limit: 2 } })
    const target = { workflow_id: 'office', node_id: 'review' }
    const cmd = { ...target, operation_id: uuidv7(), expected_revision: 0, values: { node_limit: 1, helper_limit: 0 } }
    host.save(cmd, 'local-tester', now)
    expect(host.get(target).item).toMatchObject({ revision: 1, values: { run_limit: 2, node_limit: 1, helper_limit: 0 },
      inherited: { run_limit: 2, node_limit: 2, helper_limit: 2 } })
    const second = createWorkflowConcurrencyHost(db, scheduler, true)
    expect(second.helperLimit(scope)).toBe(0)
    expect(second.helperLimit({ ...scope, nodeId: 'other' })).toBe(2)
    expect(second.helperLimit({ ...scope, workflowId: 'other' })).toBe(1)
    expect(() => save({ ...target, expected_revision: 0, values: null })).toThrow()
    expect(() => save({ ...target, expected_revision: 1, values: { run_limit: 1 } })).toThrow()
    expect(() => save({ ...target, node_id: 'hold', expected_revision: 0, values: { helper_limit: 1 } })).toThrow()
    expect(() => save({ workflow_id: 'wf_release_v1', expected_revision: 0, values: { node_limit: 1 } })).toThrow()
    save({ ...target, expected_revision: 1, values: {} })
    host.save(cmd, 'local-tester', now)
    expect(host.helperLimit(scope)).toBe(2)
    const disabled = createWorkflowConcurrencyHost(db, scheduler, false)
    expect(disabled.helperLimit(scope)).toBe(0)
    expect(() => disabled.save({ ...cmd, expected_revision: 2, values: { helper_limit: 1 } }, 'local-tester', now)).toThrow()
  } finally { await scheduler.close(); db.raw.close(); rmSync(dir, { recursive: true, force: true }) }
})
