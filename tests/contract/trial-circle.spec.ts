import { rmSync } from 'node:fs'
import { it, expect } from 'vitest'
import { freshLedger, catalogFor } from '../fixtures/ledger.ts'
import { makeTx, openDb } from '../../src/infra/sqlite/driver.ts'
import { createRun } from '../../src/service/runs.ts'
import { bindTrialHost, requireTrialTool, requireTrialMemoryApply, type TrialOptions, type TrialScope } from '../../src/service/trial-circles.ts'

it('admits only the authorized workspace and fixed flow through real run creation, rechecks after restart and latches a retreat', () => {
  const fixture = freshLedger()
  let db = fixture.db
  const day = 86_400_000
  const begin = Date.now()
  let clock = begin
  let hasGate = false
  const now = () => new Date(clock).toISOString()
  const catalog = catalogFor(['read'])
  const scope: TrialScope = { workspaces: [{ id: 'repo-x', kind: 'repository' }],
    flows: [{ id: 'default', hash: catalog.definitionHash('default', 1) }], tools: ['check'] }
  const options: TrialOptions = {
    candidate: '6'.repeat(40), workspace: { kind: 'synthetic', id: 'test', root: fixture.dir }, now,
    authenticateOperator: (token) => token === 'operator' ? 'fixture:oncall' : null,
    authorize: (token, transition) => token !== 'approved' ? null : { actor: 'fixture:operator', expiresAt: new Date(clock + 1000).toISOString(),
      observationFrom: transition.since, observationTo: now(), evidenceId: 'fixture:observation', gateG6: hasGate },
  }
  const start = (selected = catalog) => createRun(db, selected, { taskTitle: '受控检查', now: now(), workflowVersion: '1' })
  try {
    const synthetic = bindTrialHost(db, options, fixture.dir)
    expect(start().run_id).toBeTruthy()
    expect(() => synthetic.advance('approved', 'R2', scope, 1)).toThrow()
    clock += 3 * day
    expect(() => synthetic.advance('approved', 'R1', scope, 1)).toThrow()
    hasGate = true
    expect(() => synthetic.advance('unknown', 'R1', scope, 1)).toThrow()
    expect(() => synthetic.advance('approved', 'R1', { ...scope, tools: [] }, 1)).toThrow()
    expect(synthetic.advance('approved', 'R1', scope, 1).circle).toBe('R1')
    expect(() => start()).toThrow()
    db.raw.close()
    db = openDb(fixture.file)
    expect(() => start()).toThrow()
    const repo = bindTrialHost(db, { ...options, workspace: { id: 'repo-x', kind: 'repository', root: fixture.dir } }, fixture.dir)
    expect(start().run_id).toBeTruthy()
    expect(() => start(catalogFor(['changed']))).toThrow()
    expect(() => requireTrialMemoryApply(makeTx(db.raw))).toThrow()
    expect(() => requireTrialTool(makeTx(db.raw), 'check', '.', 'read_only')).not.toThrow()
    expect(() => requireTrialTool(makeTx(db.raw), 'check', '.', 'mutating')).toThrow()
    expect(() => requireTrialTool(makeTx(db.raw), 'other', '.', 'read_only')).toThrow()
    const expanded: TrialScope = { ...scope, workspaces: [...scope.workspaces, { id: 'second', kind: 'sandbox' }] }
    expect(() => repo.advance('approved', 'R2', expanded, 2)).toThrow()
    clock += 7 * day
    expect(repo.advance('approved', 'R2', expanded, 2).circle).toBe('R2')
    expect(repo.stop('operator', '值班记录').halted).toBe(true)
    expect(() => start()).toThrow()
    expect(() => repo.restartSynthetic('operator', '核实恢复', 4)).toThrow()
    db.raw.close()
    db = openDb(fixture.file)
    const restarted = bindTrialHost(db, options)
    expect(() => start()).toThrow()
    expect(() => restarted.restartSynthetic('other', '核实恢复', 4)).toThrow()
    expect(restarted.restartSynthetic('operator', '核实恢复', 4).circle).toBe('R0')
    expect(start().run_id).toBeTruthy()
  } finally { db.raw.close(); rmSync(fixture.dir, { recursive: true, force: true }) }
})
