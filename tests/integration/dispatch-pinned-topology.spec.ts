import { expect, it } from 'vitest'
import { assertNodeRunReadyInTx } from '../../src/service/commands/runtime.ts'
import { definitionHashOf, WorkflowCatalog } from '../../src/service/workflows.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { TEST_CLOCK } from '../fixtures/clock.ts'
import { bindRunVersion, freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'

it('keeps mutable catalog copies isolated from immutable dispatch data and its hash', () => {
  const catalog = new WorkflowCatalog('S2')
  catalog.load({ workflow_version: '1', nodes: [{ node_id: 'node', type: 'agent', tools: { allow: ['ro.echo'] } }] })
  const fixed = catalog.getImmutable('default', '1')
  const originalHash = catalog.definitionHash('default', '1')
  expect(catalog.getImmutable('default', '1')).toBe(fixed)
  expect(catalog.getImmutableNode('default', '1', 'node')).toBe(fixed.nodes[0])
  expect(Object.isFrozen(fixed.nodes[0]?.tools?.allow)).toBe(true)
  const editable = catalog.get('default', '1')
  editable.nodes[0]!.tools!.allow!.push('ro.other')
  expect(definitionHashOf(editable)).not.toBe(originalHash)
  expect(definitionHashOf(fixed)).toBe(originalHash)
  expect(catalog.toolPolicyFor('default', '1', 'node').allow).toEqual(['ro.echo'])
})

it('rechecks the persisted binding, cancellation, and predecessor state after a topology cache hit', () => {
  const { db } = freshLedger()
  try {
    seed(db)
    const catalog = new WorkflowCatalog('S2', db)
    const now = '2026-11-13T03:00:00.000Z'
    catalog.load({ workflow_version: '1', nodes: [{ node_id: 'n1', type: 'agent' }, { node_id: 'next', type: 'agent' }],
      edges: [{ from: 'n1', to: 'next' }] })
    bindRunVersion(db, catalog)
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status='done' WHERE node_run_id='nr1'")
      tx.run("INSERT INTO node_runs (node_run_id,run_id,node_id,seq,node_type,status,created_at,updated_at) VALUES ('next-attempt','r1','next',2,'agent','queued',?,?)", [now, now])
    })
    const deps = { db, catalog, clock: TEST_CLOCK, phase: 'S2' as const, secret: TEST_SECRET }
    const check = () => withTx(db, (tx) => assertNodeRunReadyInTx(tx, deps, 'next-attempt'))
    expect(check).not.toThrow()
    db.raw.prepare("UPDATE node_runs SET status='failed' WHERE node_run_id='nr1'").run()
    expect(check).toThrow(expect.objectContaining({ code: 'RESOLUTION_NOT_AVAILABLE' }))
    db.raw.prepare("UPDATE node_runs SET status='done' WHERE node_run_id='nr1'").run()
    db.raw.prepare("UPDATE runs SET cancel_requested_at=? WHERE run_id='r1'").run(now)
    expect(check).toThrow(expect.objectContaining({ code: 'STALE_GENERATION' }))
    db.raw.prepare("UPDATE runs SET cancel_requested_at=NULL WHERE run_id='r1'").run()
    expect(check).not.toThrow()

    db.raw.exec('DROP TRIGGER workflow_versions_no_update')
    const version = db.raw.prepare('SELECT content_hash,definition_json FROM workflow_versions').get() as {
      content_hash: string; definition_json: string
    }
    const tampered = { ...JSON.parse(version.definition_json), edges: [] }
    db.raw.prepare('UPDATE workflow_versions SET definition_json=?').run(JSON.stringify(tampered))
    expect(check).toThrow(expect.objectContaining({ code: 'WORKFLOW_VERSION_IMMUTABLE' }))
    db.raw.prepare('UPDATE workflow_versions SET definition_json=?,content_hash=?').run(version.definition_json, '0'.repeat(64))
    expect(check).toThrow(expect.objectContaining({ code: 'WORKFLOW_VERSION_IMMUTABLE' }))
    db.raw.prepare('UPDATE workflow_versions SET content_hash=?').run(version.content_hash)
    expect(check).not.toThrow()
    db.raw.exec('DROP TRIGGER workflow_versions_no_delete')
    db.raw.prepare('DELETE FROM workflow_versions').run()
    expect(check).toThrow(expect.objectContaining({ code: 'WORKFLOW_VERSION_IMMUTABLE' }))
  } finally {
    db.raw.close()
  }
})
