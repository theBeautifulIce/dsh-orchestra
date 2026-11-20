import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra } from '../../src/index.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { freshLedger } from '../fixtures/ledger.ts'
import { bindTrialHost, type TrialOptions, type TrialScope } from '../../src/service/trial-circles.ts'

const approvedHash = 'f'.repeat(64)
function trialFor(dir: string, stage: 'R1' | 'R2'): TrialOptions {
  const { db } = freshLedger(dir)
  let time = Date.now()
  const synthetic: TrialOptions = {
    candidate: 'c'.repeat(40), workspace: { kind: 'synthetic', id: 'test', root: dir },
    now: () => new Date(time).toISOString(), authenticateOperator: () => null,
    authorize: (_proof, change) => ({ actor: 'fixture:operator', expiresAt: new Date(time + 1000).toISOString(),
      observationFrom: change.since, observationTo: new Date(time).toISOString(), evidenceId: 'fixture:window', gateG6: true }),
  }
  const repo: TrialOptions = { ...synthetic, workspace: { kind: 'repository', id: 'project', root: dir } }
  const scope: TrialScope = { workspaces: [repo.workspace], flows: [{ id: 'wf', hash: approvedHash }], tools: ['check'] }
  try {
    const host = bindTrialHost(db, synthetic)
    time += 3 * 86_400_000
    host.advance('test', 'R1', scope, 1)
    if (stage === 'R1') return repo
    time += 7 * 86_400_000
    bindTrialHost(db, repo).advance('test', 'R2', { ...scope, workspaces: [...scope.workspaces,{ id: 'extra', kind: 'sandbox' }] }, 2)
    return { ...repo, workspace: { kind: 'sandbox', id: 'extra', root: dir } }
  } finally { db.raw.close() }
}

it.each(['S5','R1','R2'] as const)('%s 记忆提议、审批与实际插件写入经由真实 HTTP', async (stage) => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-confirm-memory-'))
  const secret = 'decision-confirm-memory-test'
  let writerCalls = 0
  const service = await serveOrchestra({
    dbFile: join(dir, 'orchestra.db'), secret, phase: stage === 'S5' ? 'S5' : 'S6',
    ...(stage === 'S5' ? {} : { trial: trialFor(dir,stage), resolveHttpHuman: (req: import('node:http').IncomingMessage) => req.headers.authorization === 'Bearer operator-fixture' ? { id: 'fixture:operator' } : null }),
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
    memory: {
      prepareItems: async () => ({ items: [{ client_key: 'one', action: 'create', target_id: null, layer: 'L4',
        title: '记忆项', content: '记忆内容', tags: [], questions: [], key: null, importance: 5, ttl_days: null, quote: '引文', reason: '原因' }] }),
      judge: async () => JSON.stringify({ items: [{ client_key: 'one', verdict: 'approve', confidence: 0.9, reason: '应写入' }],
        summary: '建议写入', duration_ms: 1, model: { provider: 'fixture', name: 'fixture', prompt_version: '1' } }),
      plugin: {
        protocol: 1,
        fenceAndInspect: async () => { throw new Error('此用例不需要恢复检查') },
        async writeMemory(input) {
          writerCalls += 1
          return input.items.map((item) => ({ client_key: item.client_key, content_hash: item.content_hash, applied_item_id: 'written-one' }))
        },
      },
    },
  })
  try {
    const { db } = service.orchestra
    const now = new Date().toISOString()
    withTx(db, (tx) => {
      tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('source-task','源任务','running',1,?,?)", [now, now])
      tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, workflow_definition_hash, status, revision, created_at, updated_at) VALUES ('source-run','source-task','wf',1,?,'succeeded',1,?,?)", [approvedHash,now,now])
    })
    const jsonHeaders = { 'content-type': 'application/json', 'x-orchestra-secret': secret, authorization: 'Bearer operator-fixture' }
    const post = (path: string, body: object) => fetch(service.endpoint + path, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify(body),
    })
    const started = await post('/v1/memory/runs/start', { source_run_id: 'source-run', request_key: 'confirm-1', reason: '记忆审批', operation_id: uuidv7() })
    expect(started.status).toBe(200)
    const { data } = await started.json() as { data: { batch_id: string } }
    const batch = () => db.raw.prepare('SELECT decision_id, status, approved_proposal_hash, proposal_hash FROM memory_batches WHERE batch_id = ?').get(data.batch_id)
    await expect.poll(() => batch()?.status).toBe('awaiting_human')
    const decisionId = String(batch()?.decision_id)
    withTx(db, (tx) => { tx.run('UPDATE decisions SET confirm_required=1 WHERE decision_id=?', [decisionId]) })
    const getDecision = () => fetch(service.endpoint + '/v1/decisions/get?decision_id=' + encodeURIComponent(decisionId), { headers: jsonHeaders })
    const view = await (await getDecision()).json()
    expect(view).toMatchObject({ data: { kind: 'audit_result', confirm_required: true, allowed_resolutions: stage === 'S5' ? ['approved','rejected'] : ['rejected'] } })
    const request = { operation_id: uuidv7(), decisionId, revision: 1, resolution: 'approved', contentHash: String(batch()?.proposal_hash) }
    const submit = (body: object) => post('/v1/decisions/resolve', body)
    const preflight = await submit(request)
    if (stage !== 'S5') {
      expect(preflight.status).toBe(403)
      expect(batch()).toMatchObject({ status: 'awaiting_human', approved_proposal_hash: null })
      expect(writerCalls).toBe(0)
      expect(await (await fetch(service.endpoint + '/health')).json()).toMatchObject({ data: { memory_enabled: true, memory_proposal_only: true } })
      return
    }
    expect(preflight.status).toBe(409)
    const challenge = await preflight.json() as { error: { code: string; details: { confirm_challenge: string } } }
    expect(challenge.error.code).toBe('CONFIRMATION_REQUIRED')
    expect(batch()).toMatchObject({ status: 'awaiting_human', approved_proposal_hash: null })
    expect(db.raw.prepare('SELECT 1 FROM inbox WHERE operation_id=?').get(request.operation_id)).toBeUndefined()
    expect(writerCalls).toBe(0)

    const applied = await submit({ ...request, confirm_challenge: challenge.error.details.confirm_challenge })
    expect(applied.status).toBe(200)
    expect(await applied.json()).toMatchObject({ data: { decisionId, revision: 2, replayed: false } })
    await expect.poll(() => batch()?.status).toBe('applied')
    expect(batch()?.approved_proposal_hash).toBe(request.contentHash)
    expect(await (await submit(request)).json()).toMatchObject({ data: { decisionId, revision: 2, replayed: true } })
    expect(writerCalls).toBe(1)
    expect(await (await getDecision()).json()).toMatchObject({ data: { allowed_resolutions: [], status: 'resolved' } })
  } finally {
    await service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
