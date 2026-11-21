import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra } from '../../src/index.ts'
import type { Resolution } from '../../src/service/commands/decisions.ts'
import { openDecision } from '../../src/service/commands/decisions.ts'
import type { DecisionKind } from '../../src/core/state-machine.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'

type Case = {
  kind: DecisionKind
  initial?: string
  visible: readonly Resolution[]
  requested: string
  error?: string
  next?: string
}

// Only decisions with an applicable source state and a documented requested resolution belong here.
const cases: readonly Case[] = [
  { kind: 'pre_execution', initial: 'blocked_pre', visible: ['approved', 'rejected'], requested: 'approved', next: 'queued' },
  { kind: 'pre_execution', initial: 'blocked_pre', visible: ['approved', 'rejected'], requested: 'rejected', next: 'failed' },
  { kind: 'audit_result', visible: ['approved', 'rejected'], requested: 'approved' },
  { kind: 'audit_result', visible: ['approved', 'rejected'], requested: 'rejected' },
  { kind: 'verify_human', initial: 'indeterminate_side_effect', visible: [], requested: 'approved', error: 'RESOLUTION_NOT_AVAILABLE' },
  { kind: 'action_overrun', initial: 'stopping', visible: [], requested: 'approved', error: 'RESOLUTION_NOT_AVAILABLE' },
  { kind: 'action_overrun', initial: 'stopping', visible: [], requested: 'continue_wait', error: 'RESOLUTION_NOT_AVAILABLE' },
  { kind: 'abandon_ack', visible: [], requested: 'approved', error: 'RESOLUTION_NOT_AVAILABLE' },
  { kind: 'rule_ambiguous', visible: [], requested: 'approved', error: 'RESOLUTION_NOT_AVAILABLE' },
  { kind: 'startup_unknown', initial: 'startup_unknown', visible: [], requested: 'confirm_started', error: 'RESOLUTION_NOT_AVAILABLE' },
  { kind: 'startup_unknown', initial: 'startup_unknown', visible: [], requested: 'confirm_not_started', error: 'RESOLUTION_NOT_AVAILABLE' },
  { kind: 'startup_unknown', initial: 'startup_unknown', visible: [], requested: 'confirm_started_attested', error: 'RESOLUTION_NOT_AVAILABLE' },
  { kind: 'startup_unknown', initial: 'startup_unknown', visible: [], requested: 'continue_tracking', error: 'RESOLUTION_NOT_AVAILABLE' },
  { kind: 'startup_unknown', initial: 'startup_unknown', visible: [], requested: 'abandon', error: 'RESOLUTION_NOT_AVAILABLE' },
  { kind: 'report_contradicted', initial: 'startup_unknown', visible: [], requested: 'uphold_report', error: 'RESOLUTION_NOT_AVAILABLE' },
  { kind: 'report_contradicted', initial: 'startup_unknown', visible: [], requested: 'uphold_decision', error: 'RESOLUTION_NOT_AVAILABLE' },
  { kind: 'report_contradicted', initial: 'startup_unknown', visible: [], requested: 'expired', error: 'RESOLUTION_NOT_AVAILABLE' },
]

it('F8 projects per-kind choices and binds actual HTTP decisions to a host-authenticated human', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-f8-exits-'))
  const secret = 'f8-fixture-service-key'
  const opts = {
    dbFile: join(dir, 'ledger.db'), phase: 'S6' as const, secret,
    resolveHttpHuman: (req: import('node:http').IncomingMessage) => {
      if (req.headers.authorization === 'Bearer f8-operator') return { id: 'fixture:operator' }
      if (req.headers.authorization === 'Bearer f8-second') return { id: 'fixture:second' }
      return null
    },
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
  }
  const now = new Date().toISOString()
  let service = await serveOrchestra(opts)
  try {
    const call = (path: string, body?: object, auth: string | null = 'f8-operator') => fetch(service.endpoint + path, {
      headers: { 'content-type': 'application/json', 'x-orchestra-secret': secret, ...(auth ? { authorization: 'Bearer ' + auth } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    })
    const submit = (command: object, auth?: string | null) => call('/v1/decisions/resolve', command, auth)
    const fixtures = cases.map((entry, i) => ({ ...entry, decisionId: 'd' + i, runId: 'run' + i, nodeId: entry.initial ? 'node' + i : null }))
    withTx(service.orchestra.db, (tx) => {
      for (const item of fixtures) {
        const taskId = 't-' + item.runId
        tx.run("INSERT INTO tasks (task_id,title,status,created_at,updated_at) VALUES (?,'F8','running',?,?)", [taskId, now, now])
        tx.run("INSERT INTO runs (run_id,task_id,status,created_at,updated_at) VALUES (?,?,'running',?,?)", [item.runId, taskId, now, now])
        if (item.nodeId) {
          tx.run("INSERT INTO node_runs (node_run_id,run_id,node_id,seq,node_type,status,blocked_decision_id,resume_state,"
            + " side_effect_policy,created_at,updated_at) VALUES (?,?,'fixture',1,'agent',?,?,?,?,?,?)",
          [item.nodeId, item.runId, item.initial, item.initial === 'blocked_pre' ? item.decisionId : null,
            item.initial === 'blocked_pre' ? 'queued' : null, item.kind === 'verify_human' || item.kind === 'action_overrun' ? 'irreversible' : 'pure', now, now])
        }
        openDecision(tx, { decisionId: item.decisionId, runId: item.runId, nodeRunId: item.nodeId, kind: item.kind, approver: 'human',
          createdAt: now, payload: item.kind === 'report_contradicted' ? { report_id: 'legacy-id-without-binding' } : undefined })
      }
    })
    const card = (decisionId: string) => service.orchestra.db.raw.prepare(
      'SELECT status,revision,closed_reason,resolved_by FROM decisions WHERE decision_id=?').get(decisionId)
    const node = (nodeId: string | null) => service.orchestra.db.raw.prepare('SELECT * FROM node_runs WHERE node_run_id=?').get(nodeId)
    let replayCommand: object | undefined
    for (const item of fixtures) {
      const view = await (await call('/v1/decisions/get?decision_id=' + item.decisionId)).json()
      expect(view, item.kind).toMatchObject({ data: { allowed_resolutions: item.visible, current_revision: 1 } })
      const command = { decisionId: item.decisionId, revision: 1, resolution: item.requested, operation_id: uuidv7(),
        actor: { kind: 'human', id: 'spoofed:operator' } }
      const before = node(item.nodeId)
      if (item.error) {
        expect(await (await submit(command)).json(), item.requested).toMatchObject({ error: { code: item.error } })
        expect(card(item.decisionId)).toEqual({ status: 'pending', revision: 1, closed_reason: null, resolved_by: null })
        expect(node(item.nodeId)).toEqual(before)
        expect(service.orchestra.db.raw.prepare('SELECT 1 FROM inbox WHERE operation_id=?').get(command.operation_id)).toBeUndefined()
        continue
      }
      expect((await submit(command, null)).status).toBe(403)
      const responses = await Promise.all([submit(command), submit(command)])
      const receipts = await Promise.all(responses.map(response => response.json()))
      expect(receipts.map(reply => reply.data.replayed).sort()).toEqual([false, true])
      expect(card(item.decisionId)).toEqual({ status: 'resolved', revision: 2, closed_reason: item.requested, resolved_by: 'fixture:operator' })
      if (item.next) expect(node(item.nodeId)).toMatchObject({ status: item.next })
      expect(await (await submit({ ...command, operation_id: uuidv7() })).json())
        .toMatchObject({ error: { code: 'DECISION_REVISION_CONFLICT' } })
      expect(await (await submit(command, 'f8-second')).json()).toMatchObject({ error: { code: 'OPERATION_ID_CONFLICT' } })
      replayCommand ??= command
    }
    await service.close()
    service = await serveOrchestra(opts)
    expect(await (await submit(replayCommand!)).json()).toMatchObject({ data: { revision: 2, replayed: true } })
  } finally {
    await service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
