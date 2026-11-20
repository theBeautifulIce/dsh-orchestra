import { z } from 'zod'
import { buildReleaseArtifact, releaseArtifactBody, releaseArtifactHashOf, type ReleaseGovernance } from '../core/gate-artifact.ts'
import { OrchError } from '../core/errors.ts'
import {
  judgeReleaseEvidence, RELEASE_CHECK_WORKFLOW_ID, RELEASE_COORDINATOR_ID, RELEASE_GROUPS, RELEASE_VERSION, RELEASE_WORKFLOW_ID,
  releaseHash, type ReleaseEvidenceReader, type ReleasePolicyResult,
} from '../core/wf-release-v1.ts'
import { chainBreakOf, readChain } from '../infra/db/ledger.ts'
import type { Db } from '../infra/sqlite/driver.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'

export const PRIOR_GATE_HASH = 'f57b6ac7f423ede6d9ab9f8e1eac5cef0c0d5ca117b85b3892d1dd8a9c66526a'
const hash = z.string().regex(/^[0-9a-f]{64}$/).refine((value) => !/^0+$/.test(value))
const key = z.string().trim().min(1).max(128)
const approval = z.strictObject({
  manifest_hash: hash, candidate_hash: hash, evidence_index_hash: hash, judgement_hash: hash,
  principal: z.string().regex(/^human:\S.*$/), approval_id: key, confirmation_id: key,
  confirmed_at: z.iso.datetime(), expires_at: z.iso.datetime(),
})
const policyReceipt = z.strictObject({ manifest_hash: hash, judgement_hash: hash, conclusion: z.enum(['pass','fail']) })
const branchReceipt = z.strictObject({ manifest_hash: hash, judgement_hash: hash, approval_id: key, branch: z.literal('eligible') })
const frozenReceipt = z.strictObject({ manifest_hash: hash, candidate_hash: hash, evidence_index_hash: hash,
  groups: z.array(z.string()), principal: z.string().regex(/^human:\S.*$/) })
const source = z.discriminatedUnion('producer', [
  z.strictObject({ producer: z.literal('human'), principal: z.string().regex(/^human:\S.*$/), receipt_id: key,
    manifest_hash: hash, judgement_hash: hash, recorded_at: z.iso.datetime() }),
  z.strictObject({ producer: z.literal('s5_build'), build_artifact_hash: hash, receipt_id: key,
    manifest_hash: hash, judgement_hash: hash, recorded_at: z.iso.datetime() }),
])
export type ReleaseRunApproval = z.infer<typeof approval>
export type IndependentReleaseSource = z.infer<typeof source>
export type ReleaseFrozenInput = { manifest: unknown; publication: ReleaseEvidenceReader; independent: ReleaseEvidenceReader }

function reject(message: string): never {
  throw new OrchError('CONFIRMATION_MISMATCH', message)
}

function checkedChain(tx: ReadTx, nodeRunId: string, secret: string) {
  const chain = readChain(tx, nodeRunId)
  const head = tx.get<{ last_seq: number; last_hash: string; event_count: number }>(
    'SELECT last_seq,last_hash,event_count FROM node_run_chain_heads WHERE node_run_id=?', [nodeRunId])
  const last = chain.at(-1)
  if (!last || !head || head.last_seq !== last.seq || head.last_hash !== last.hash || head.event_count !== chain.length
    || chainBreakOf(secret, chain)) return reject('发布节点账本链无法核对')
  return { chain, last }
}

function readPolicyEvent(tx: ReadTx, nodeRunId: string, secret: string) {
  const { chain, last } = checkedChain(tx, nodeRunId, secret)
  const matches = (type: string) => {
    const rows = chain.filter((row) => row.type === type)
    if (rows.length !== 1) return reject('发布运行的判卷、批准或分支回执缺失或重复')
    return rows[0]!
  }
  const judged = matches('release.policy')
  const approved = matches('release.approved')
  const branched = matches('release.branch')
  if (judged.seq >= approved.seq || approved.seq >= branched.seq) return reject('发布回执顺序错误')
  return {
    policy: policyReceipt.parse(JSON.parse(judged.payload)),
    approval: approval.parse(JSON.parse(approved.payload)),
    branch: branchReceipt.parse(JSON.parse(branched.payload)),
    ledger: { seq: last.seq, hash: last.hash },
  }
}

/** Read-only terminal sealing. The expected definition hash must come from the host's fixed registration. */
export function readReleaseRunSnapshot(db: Db, secret: string, runId: string, expectedDefinitionHash: string, result: ReleasePolicyResult) {
  return withReadTx(db, ({ tx, as_of_seq }) => {
    const run = tx.get<{ status: string; ended_at: string | null }>(
      "SELECT status,ended_at FROM runs WHERE run_id=? AND workflow_id=? AND CAST(workflow_version AS TEXT)=?"
      + " AND workflow_definition_hash=? AND parent_run_id IS NULL AND cancel_requested_at IS NULL",
    [runId, RELEASE_WORKFLOW_ID, RELEASE_VERSION, expectedDefinitionHash])
    if (!run || run.status !== 'succeeded' || !run.ended_at) return reject('指定门运行没有可放行的真实终态')
    const rows = tx.all<{ seq: number; event_id: string; payload_redacted: string }>(
      "SELECT seq,event_id,payload_redacted FROM events WHERE run_id=? AND type='run.terminal' ORDER BY seq LIMIT 2", [runId])
    const terminal = rows[0]
    if (rows.length !== 1 || !terminal || JSON.parse(terminal.payload_redacted).status !== run.status) {
      return reject('发布运行的终态事件与当前账本不符')
    }
    const node = tx.get<{ node_run_id: string }>(
      "SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id=? AND status='done' AND replacement_node_run_id IS NULL",
    [runId, RELEASE_COORDINATOR_ID])
    if (!node) return reject('发布运行缺少已完成的决策节点')
    const proof = readPolicyEvent(tx, node.node_run_id, secret)
    const judgementHash = releaseHash(result)
    if (result.conclusion !== 'pass' || proof.policy.conclusion !== 'pass' || proof.policy.manifest_hash !== result.manifest_hash
      || proof.approval.manifest_hash !== result.manifest_hash || proof.branch.manifest_hash !== result.manifest_hash
      || proof.policy.judgement_hash !== judgementHash || proof.approval.judgement_hash !== judgementHash || proof.branch.judgement_hash !== judgementHash
      || proof.approval.candidate_hash !== result.candidate_hash || proof.approval.evidence_index_hash !== result.evidence_index_hash
      || proof.approval.approval_id === proof.approval.confirmation_id || proof.branch.approval_id !== proof.approval.approval_id
      || Date.parse(proof.approval.confirmed_at) > Date.parse(run.ended_at)
      || Date.parse(proof.approval.expires_at) <= Date.parse(run.ended_at)) return reject('发布判卷或批准与冻结候选、证据或终态不符')
    const groups = tx.all<{ node_run_id: string; node_id: string; status: string }>(
      'SELECT node_run_id,node_id,status FROM node_runs WHERE run_id=? AND replacement_node_run_id IS NULL', [runId])
    const arranger = groups.find((node) => node.node_id === 'arrange' && node.status === 'done')
    if (!arranger) return reject('发布运行缺少冻结入口回执')
    const frozen = checkedChain(tx, arranger.node_run_id, secret).chain.filter((item) => item.type === 'release.frozen')
    if (frozen.length !== 1) return reject('候选冻结入口回执缺失或重复')
    const registration = frozenReceipt.parse(JSON.parse(frozen[0]!.payload))
    if (registration.manifest_hash !== result.manifest_hash || registration.candidate_hash !== result.candidate_hash
      || registration.evidence_index_hash !== result.evidence_index_hash
      || registration.groups.length !== Object.keys(RELEASE_GROUPS).length
      || !Object.keys(RELEASE_GROUPS).every((group) => registration.groups.includes(group))) return reject('候选冻结登记与发布判卷不符')
    for (const group of Object.keys(RELEASE_GROUPS)) {
      const node = groups.find((row) => row.node_id === group && row.status === 'done')
      if (!node) return reject('发布运行缺少已完成的检查组')
      const { chain } = checkedChain(tx, node.node_run_id, secret)
      const receipts = chain.filter((item) => item.type === 'release.group_verified')
      if (receipts.length !== 1) return reject('发布检查组的强证据回执缺失或重复')
      const receipt = JSON.parse(receipts[0]!.payload) as Record<string, string>
      if (receipt.group !== group || receipt.manifest_hash !== result.manifest_hash || receipt.candidate_hash !== result.candidate_hash
        || receipt.evidence_index_hash !== result.evidence_index_hash || !tx.get(
          "SELECT 1 FROM runs child JOIN node_runs check_node ON check_node.run_id=child.run_id"
          + " JOIN tool_executions e ON e.node_run_id=check_node.node_run_id AND e.attempt=check_node.attempt"
          + " WHERE child.run_id=? AND child.parent_run_id=? AND child.parent_node_run_id=? AND child.status='succeeded'"
          + " AND child.workflow_id=? AND check_node.node_id='check' AND check_node.status='done'"
          + ' AND e.execution_id=? AND e.exit_code=0 AND e.command_hash=? AND e.stdout_hash=? AND e.tool=?',
        [receipt.child_run_id, runId, node.node_run_id, RELEASE_CHECK_WORKFLOW_ID, receipt.execution_id, receipt.command_hash,
          receipt.stdout_hash, RELEASE_CHECK_WORKFLOW_ID])) return reject('发布检查组的工具回执与运行归属不符')
    }
    return { run_id: runId, run_terminal: run.status, ended_at: run.ended_at, terminal_seq: terminal.seq, terminal_event_id: terminal.event_id,
      as_of_seq, publication_owner: registration.principal, ...proof }
  })
}

const matchedFields = ['candidate_hash', 'evidence_index_hash', 'conclusion'] as const

export function compareReleaseArtifacts(
  publication: ReturnType<typeof releaseArtifactBody>, independent: ReturnType<typeof releaseArtifactBody>,
) {
  const mismatches = matchedFields.filter((field) => publication[field] !== independent[field])
  const passed = mismatches.length === 0 && publication.conclusion === 'pass' && independent.conclusion === 'pass'
  return { passed, mismatches, publication_conclusion: publication.conclusion, independent_conclusion: independent.conclusion }
}

export type IndependentReleaseAuthority = {
  /** Look up a separately performed, authenticated execution receipt in the controlled release workspace. */
  readReceipt(manifestHash: string): unknown
  /** Check that the attested build is the G5 signed installation artifact, if the independent executor used it. */
  isSignedS5Build(artifactHash: string): boolean
}

export function prepareReleasePair(options: {
  db: Db; secret: string; runId: string; expectedDefinitionHash: string; input: ReleaseFrozenInput; authority: IndependentReleaseAuthority
}) {
  const { db, secret, runId, expectedDefinitionHash, input, authority } = options
  if (input.publication === input.independent) return reject('独立和发布判卷必须分别从源材料核验')
  const publicationPolicy = judgeReleaseEvidence(input.manifest, input.publication)
  const run = readReleaseRunSnapshot(db, secret, runId, expectedDefinitionHash, publicationPolicy)
  const independentPolicy = judgeReleaseEvidence(input.manifest, input.independent)
  const receipt = source.safeParse(authority.readReceipt(independentPolicy.manifest_hash))
  if (!receipt.success || receipt.data.manifest_hash !== independentPolicy.manifest_hash
    || receipt.data.judgement_hash !== releaseHash(independentPolicy)
    || Date.parse(receipt.data.recorded_at) > Date.now()
    || (receipt.data.producer === 'human' && [run.publication_owner, run.approval.principal].includes(receipt.data.principal))
    || (receipt.data.producer === 's5_build' && !authority.isSignedS5Build(receipt.data.build_artifact_hash))) {
    return reject('缺少同一冻结材料的真实独立判卷回执')
  }
  const publication = releaseArtifactBody(publicationPolicy, { producer: RELEASE_WORKFLOW_ID, gate_run_id: run.run_id, run_terminal: run.run_terminal })
  const independent = releaseArtifactBody(independentPolicy, { producer: receipt.data.producer, gate_run_id: null, run_terminal: 'not_applicable' })
  return { publication, independent, run, independent_source: receipt.data, comparison: compareReleaseArtifacts(publication, independent) }
}

export function sealReleasePair(
  options: Parameters<typeof prepareReleasePair>[0],
  verifyGovernance: (prepared: ReturnType<typeof prepareReleasePair>) => { publication: ReleaseGovernance; independent: ReleaseGovernance },
) {
  const prepared = prepareReleasePair(options)
  if (!prepared.comparison.passed) return reject('独立判卷与发布判卷未同时通过')
  const governance = verifyGovernance(prepared)
  for (const record of [governance.publication, governance.independent]) {
    if (record.previous_artifact_hash !== PRIOR_GATE_HASH
      || Date.parse(record.approved_at) > Date.now()
      || Date.parse(record.approved_at) < Date.parse(prepared.run.ended_at)
      || Date.parse(record.approved_at) < Date.parse(prepared.independent_source.recorded_at)) {
      return reject('G6 批准时间或 G5 历史锚点与来源不符')
    }
  }
  const publication = buildReleaseArtifact(prepared.publication, governance.publication)
  const independent = buildReleaseArtifact(prepared.independent, governance.independent)
  return { publication, independent, comparison: { ...prepared.comparison,
    publication_hash: releaseArtifactHashOf(publication), independent_hash: releaseArtifactHashOf(independent),
  } }
}
