import { randomUUID, timingSafeEqual } from 'node:crypto'
import { canonicalJson, hmacSha256Hex, sha256Hex } from '../../core/canonical.ts'
import { OrchError } from '../../core/errors.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { appendEvent } from '../../infra/db/ledger.ts'
import type { ResolveDecisionRequest } from '../commands/decisions.ts'
import { assertOperationId, runIdempotentCommand } from '../commands/idempotency.ts'
import { DECISION_CHOICE_COLUMNS, isEffectDecision, panelDecisionOptions, panelDecisionRestriction, type DecisionChoiceContext } from './choices.ts'

const KIND = 'decision.resolve'
const CHALLENGE_TTL_MS = 120_000

export type DecisionCommandRequest = ResolveDecisionRequest & {
  operationId?: string
  confirmChallenge?: string
  bindActor?: boolean
}

export type DecisionCommandResult = { decisionId: string; revision: number; replayed?: boolean }

type Binding = { operation_id: string; decision_id: string; revision: number; request_hash: string; actor: string }
type Challenge = Binding & { expires_at: number; nonce: string }

class DecisionConfirmationError extends OrchError {
  override get httpStatus(): number { return 409 }
}

function sign(secret: string, encoded: string): string {
  return hmacSha256Hex(secret, `orchestra:decision-confirmation:v1:${encoded}`)
}

function issue(secret: string, binding: Binding, now: number): never {
  const expiresAt = now + CHALLENGE_TTL_MS
  const claim: Challenge = { ...binding, expires_at: expiresAt, nonce: randomUUID() }
  const encoded = Buffer.from(canonicalJson(claim)).toString('base64url')
  throw new DecisionConfirmationError('CONFIRMATION_REQUIRED', '请确认这次裁决', {
    confirm_challenge: `${encoded}.${sign(secret, encoded)}`, expires_at: new Date(expiresAt).toISOString(),
  })
}

function verify(secret: string, token: string, expected: Binding, currentRevision: number | undefined, now: number): void {
  const mismatch = () => new DecisionConfirmationError('CONFIRMATION_MISMATCH', '裁决确认与当前请求不匹配')
  const parts = /^([\w-]+)\.([a-f0-9]{64})$/.exec(token)
  if (!parts || !timingSafeEqual(Buffer.from(parts[2]!, 'hex'), Buffer.from(sign(secret, parts[1]!), 'hex'))) throw mismatch()
  const claim = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Challenge
  if (claim.expires_at <= now) throw new DecisionConfirmationError('CONFIRMATION_EXPIRED', '裁决确认已过期，请重新选择')
  if (claim.revision !== expected.revision || (currentRevision !== undefined && currentRevision !== expected.revision)) {
    throw new OrchError('DECISION_REVISION_CONFLICT', '裁决修订已改变，请重新选择')
  }
  if (claim.operation_id !== expected.operation_id || claim.decision_id !== expected.decision_id
    || claim.request_hash !== expected.request_hash || claim.actor !== expected.actor) throw mismatch()
}

/** Production decision entry. Only synchronous ledger commands belong in apply. */
export function runDecisionCommand(
  tx: Tx,
  secret: string,
  input: DecisionCommandRequest,
  legacyRequestHash: string,
  memoryEnabled: boolean,
  apply: (confirmed: boolean, requireEffectSettlement: boolean) => DecisionCommandResult,
): DecisionCommandResult {
  const { decisionId, revision, resolution, payload, contentHash, evidenceProducers, confirm, actor } = input
  const requestHash = sha256Hex(canonicalJson({
    command: KIND, target: { decision_id: decisionId }, expected: { revision },
    payload: { resolution, payload, contentHash, evidenceProducers, confirm },
    ...(input.bindActor ? { actor: { kind: actor?.kind, id: actor?.id } } : {}),
  }))
  const read = () => tx.get<DecisionChoiceContext & { revision: number; confirm_required: number }>(
    'SELECT d.revision, d.confirm_required, d.kind, d.status, d.approver, d.expires_at, '
    + DECISION_CHOICE_COLUMNS + ' FROM decisions d WHERE d.decision_id = ?', [decisionId],
  )
  const now = Date.parse(input.now)
  const validate = (current: ReturnType<typeof read>) => {
    if (!current || current.revision !== revision || current.status === 'resolved') {
      throw new OrchError('DECISION_REVISION_CONFLICT', '裁决修订已改变，请重新选择')
    }
    if (resolution === 'approved' && isEffectDecision(current) && !panelDecisionRestriction(current, now)) return true
    const options = panelDecisionOptions(current, now, memoryEnabled)
    if (!options.choices.includes(resolution)) {
      throw new OrchError('RESOLUTION_NOT_AVAILABLE', options.unavailableReason ?? '此裁决不允许该处理方式')
    }
    return false
  }
  if (!input.operationId && !input.confirmChallenge) {
    const current = read()
    const requireEffectSettlement = validate(current)
    if (current?.confirm_required !== 1) return apply(false, requireEffectSettlement)
  }
  const operationId = assertOperationId(input.operationId)
  const binding: Binding = {
    operation_id: operationId, decision_id: decisionId, revision, request_hash: requestHash,
    actor: canonicalJson({ kind: actor?.kind, id: actor?.id }),
  }
  let confirmed = false
  let requireEffectSettlement = false
  const outcome = runIdempotentCommand(tx, {
    kind: KIND, operationId, requestHash, legacyRequestHash: input.bindActor ? undefined : legacyRequestHash, now: input.now,
    beforeApply: () => {
      const current = read()
      if (input.confirmChallenge) {
        verify(secret, input.confirmChallenge, binding, current?.revision, now)
        confirmed = true
      }
      requireEffectSettlement = validate(current)
      if (!confirmed && current?.confirm_required === 1) {
        // Run the same policy and CAS validations within a discarded savepoint.
        // No decision, effect, ledger event or command receipt survives preflight.
        tx.exec('SAVEPOINT decision_confirmation')
        try { apply(true, requireEffectSettlement) } finally {
          tx.exec('ROLLBACK TO decision_confirmation')
          tx.exec('RELEASE decision_confirmation')
        }
        issue(secret, binding, now)
      }
    },
  }, () => {
    const result = apply(confirmed, requireEffectSettlement)
    const scope = tx.get<{ run_id: string; node_run_id: string | null }>('SELECT run_id, node_run_id FROM decisions WHERE decision_id = ?', [decisionId])!
    const evidence = tx.all<{ evidence_id: string }>(
      'SELECT evidence_id FROM memory_write_recoveries WHERE (decision_id = ? OR abandon_ack_id = ?) AND evidence_id IS NOT NULL'
      + ' UNION SELECT evidence_id FROM unverified_resolutions WHERE decision_id = ? AND evidence_id IS NOT NULL'
      + (resolution === 'uphold_report' ? " UNION SELECT json_extract(payload, '$.execution_id') AS evidence_id"
        + " FROM node_run_events WHERE node_run_id = ? AND type = 'report_applied' AND json_valid(payload)"
        + " AND json_extract(payload, '$.decision_id') = ? AND json_type(payload, '$.execution_id') = 'text'" : '')
      + ' ORDER BY evidence_id',
      [decisionId, decisionId, decisionId, ...(resolution === 'uphold_report' ? [scope.node_run_id, decisionId] : [])],
    )
    appendEvent(tx, { type: 'decision.command_audited', runId: scope.run_id, nodeRunId: scope.node_run_id,
      decisionId, payload: { operation_id: operationId, actor_id: actor?.id ?? null, actor_kind: actor?.kind ?? null,
        resolution, result: 'applied', occurred_at: input.now, evidence_ids: evidence.map(row => row.evidence_id) } })
    return result
  })
  // Successful execution consumes this challenge by committing its operation receipt.
  // All later submissions hit that same receipt before evaluating the challenge.
  return { ...outcome.result, replayed: outcome.replayed }
}
