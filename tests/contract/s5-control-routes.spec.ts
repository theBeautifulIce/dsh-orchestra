import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { uuidv7 } from '../../src/core/ids.ts'
import { serveOrchestra } from '../../src/index.ts'
import { openDecision } from '../../src/service/commands/decisions.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { seed } from '../fixtures/ledger.ts'

it('生产面板可读取记忆列表，决定确认与处理均能查回执', async () => {
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
      decisionId: 'dec1', runId: 'r1', nodeRunId: 'nr1', kind: 'audit_result', approver: 'human',
    }))
    const headers = { 'x-orchestra-secret': secret, 'content-type': 'application/json' }
    const list = await fetch(service.endpoint + '/v1/memory/batches', { headers })
    expect(await list.json()).toMatchObject({ ok: true, data: { items: [], next_cursor: null } })
    for (const [command, revision] of [['acknowledge', 1], ['resolve', 2]] as const) {
      const operationId = uuidv7()
      const send = () => fetch(service.endpoint + '/v1/decisions/' + command, {
        method: 'POST', headers,
        body: JSON.stringify({ decisionId: 'dec1', revision, operation_id: operationId, ...(command === 'resolve' && { resolution: 'approved' }) }),
      })
      const response = await send()
      expect(await response.json()).toMatchObject({ ok: true, data: { decisionId: 'dec1', revision: revision + 1 } })
      const receipt = await fetch(service.endpoint + '/v1/operations/get?operation_id=' + operationId, { headers })
      const envelope = await receipt.json() as { data: { receipt_json: string } }
      expect(JSON.parse(envelope.data.receipt_json)).toMatchObject({ result: { decisionId: 'dec1', revision: revision + 1 } })
      expect((await send()).status).toBe(200)
    }
    expect(service.orchestra.db.raw.prepare("SELECT status, revision FROM decisions WHERE decision_id = 'dec1'").get())
      .toMatchObject({ status: 'resolved', revision: 3 })
  } finally {
    await service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
