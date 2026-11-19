import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { uuidv7 } from '../../src/core/ids.ts'
import { serveOrchestra } from '../../src/index.ts'
import { openDecision } from '../../src/service/commands/decisions.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { seed } from '../fixtures/ledger.ts'

it('Q-11 生产面板可读取记忆列表和人工复核选项，确认与处理均能查回执', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-s5-routes-'))
  const secret = 's5-routes-secret'
  const service = await serveOrchestra({
    dbFile: join(dir, 'db.sqlite'), secret, phase: 'S5',
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'e' }),
  })
  try {
    seed(service.orchestra.db)
    withTx(service.orchestra.db, (tx) => openDecision(tx, {
      decisionId: 'dec1', runId: 'r1', nodeRunId: 'nr1', kind: 'audit_result', approver: 'human', confirmRequired: true,
    }))
    const headers = { 'x-orchestra-secret': secret, 'content-type': 'application/json' }
    const list = await fetch(service.endpoint + '/v1/memory/batches', { headers })
    expect(await list.json()).toMatchObject({ ok: true, data: { items: [], next_cursor: null } })
    const get = await fetch(service.endpoint + '/v1/decisions/get?decision_id=dec1', { headers })
    expect(await get.json()).toMatchObject({ data: { kind: 'audit_result', allowed_resolutions: ['approved', 'rejected'] } })
    for (const [command, revision] of [['acknowledge', 1], ['resolve', 2]] as const) {
      const operationId = uuidv7()
      const send = (challenge?: string) => fetch(service.endpoint + '/v1/decisions/' + command, {
        method: 'POST', headers,
        body: JSON.stringify({ decisionId: 'dec1', revision, operation_id: operationId,
          ...(command === 'resolve' && { resolution: 'approved', ...(challenge && { confirm_challenge: challenge }) }) }),
      })
      let challenge: string | undefined
      if (command === 'resolve') {
        const preflight = await send()
        expect(preflight.status).toBe(409)
        const envelope = await preflight.json() as { error: { code: string; details: { confirm_challenge: string } } }
        expect(envelope.error.code).toBe('CONFIRMATION_REQUIRED')
        challenge = envelope.error.details.confirm_challenge
      }
      const response = await send(challenge)
      expect(await response.json()).toMatchObject({ ok: true, data: { decisionId: 'dec1', revision: revision + 1 } })
      const receipt = await fetch(service.endpoint + '/v1/operations/get?operation_id=' + operationId, { headers })
      const envelope = await receipt.json() as { data: { status: string; receipt_json: string } }
      expect(envelope.data.status).toBe('applied')
      expect(JSON.parse(envelope.data.receipt_json)).toMatchObject({ result: { decisionId: 'dec1', revision: revision + 1 } })
      const replay = await send()
      expect(replay.status).toBe(200)
      if (command === 'resolve') expect(await replay.json()).toMatchObject({ data: { replayed: true } })
    }
    expect(service.orchestra.db.raw.prepare("SELECT status, revision FROM decisions WHERE decision_id = 'dec1'").get())
      .toMatchObject({ status: 'resolved', revision: 3 })
  } finally {
    await service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
