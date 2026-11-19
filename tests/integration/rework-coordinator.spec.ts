import { expect, it } from 'vitest'
import { sha256Hex } from '../../src/core/canonical.ts'
import { SystemClock } from '../../src/core/clock.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { createReworkHost, type ReworkRequest } from '../../src/service/rework-coordinator.ts'
import { createCollaborationHost } from '../../src/service/collaboration.ts'
import { freshLedger, TEST_SECRET } from '../fixtures/ledger.ts'

const NOW = '2026-11-19T01:00:00.000Z'
const LATER = '2026-11-19T01:00:01.000Z'
const OWNER = 'service:' + sha256Hex(TEST_SECRET).slice(0, 8)
const reviewer = { node_run_id: 'b1', attempt: 1, action_generation: 1 }

function setup(options: { unsafe?: boolean; startedReviewer?: boolean } = {}) {
  const { db } = freshLedger()
  withTx(db, (tx) => {
    tx.run("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('task','Report','running',?,?)", [NOW, NOW])
    tx.run("INSERT INTO runs(run_id,task_id,status,workflow_id,workflow_version,created_at,updated_at) VALUES('run','task','running','wf','1',?,?)", [NOW, NOW])
    tx.run('INSERT INTO workflow_versions(workflow_id,version,content_hash,definition_json,created_at) VALUES(?,?,?,?,?)', ['wf', '1', 'hash', JSON.stringify({ nodes: [{ node_id: 'A', type: 'agent' }, { node_id: 'B', type: 'agent' }, { node_id: 'C', type: 'agent' }], edges: [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }] }), NOW])
    for (const [node, logical, seq, status] of [['a1', 'A', 1, 'done'], ['b1', 'B', 2, options.startedReviewer ? 'started' : 'queued'], ['c1', 'C', 3, 'queued'], ['x1', 'X', 4, 'started']] as const) {
      tx.run('INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,revision,action_generation,side_effect_policy,created_at,updated_at) VALUES(?,?,?,?,\'agent\',?,1,1,?,?,?)', [node, 'run', logical, seq, status, node === 'a1' && options.unsafe ? 'irreversible' : 'pure', NOW, NOW])
      appendNodeRunEvent(tx, TEST_SECRET, node, 'seed', {})
    }
  })
  putArtifact(db, 'a1', 'v1', 'old report')
  return { db, host: createReworkHost(db, TEST_SECRET) }
}

function putArtifact(db: Db, node: string, artifact: string, text: string) {
  const bytes = Buffer.from(text)
  withTx(db, (tx) => {
    tx.run('INSERT INTO artifacts(artifact_id,run_id,uri,sha256,created_at) VALUES(?,\'run\',?,?,?)', [artifact, 'artifact://' + artifact, sha256Hex(bytes), NOW])
    tx.run('INSERT INTO artifact_contents VALUES(?,?,?,?)', [artifact, artifact + '.txt', node, bytes])
  })
  return sha256Hex(bytes)
}

function input(scope: 'targeted_revision' | 'rerun_node' = 'targeted_revision') {
  return { operation_id: uuidv7(), run_id: 'run', target_node_run_id: 'a1', source_artifact_id: 'v1', source_artifact_hash: sha256Hex('old report'), expected_revision: 1, reason: 'Add timestamp', expected_result: 'Timestamp for each row', suggested_scope: scope }
}

function complete(db: Db, row: ReworkRequest, version = 'v2') {
  withTx(db, (tx) => tx.run("UPDATE node_runs SET status='done',revision=revision+1 WHERE node_run_id=?", [row.new_node_run_id]))
  return putArtifact(db, row.new_node_run_id!, version, 'revised ' + version)
}

function evidence(db: Db, nodeId: string, evidenceId: string, when = NOW) {
  const proofHash = sha256Hex('checked report')
  withTx(db, (tx) => {
    const node = tx.get<{ attempt: number }>('SELECT attempt FROM node_runs WHERE node_run_id=?', [nodeId])!
    tx.run('INSERT INTO tool_executions(execution_id,node_run_id,attempt,tool_seq,tool,exit_code,stdout_hash,command_hash,started_at,finished_at) VALUES(?,?,?,1,\'read-report\',0,?,?,?,?)', [evidenceId, nodeId, node.attempt, proofHash, proofHash, when, when])
    appendNodeRunEvent(tx, TEST_SECRET, nodeId, 'tool_finished', { execution_id: evidenceId, attempt: node.attempt, tool: 'read-report', exit_code: 0, stdout_hash: proofHash, stderr_hash: null, command_hash: proofHash, finished_at: when })
  })
}

it('human targeted revision preserves v1 and old terminal attempt, binds exact acceptance and replays receipts', () => {
  const { db, host } = setup()
  try {
    const body = input()
    const request = host.request(body, OWNER, NOW)
    expect(request).toMatchObject({ status: 'scheduled', round_no: 1, budget_remaining: 2 })
    expect(host.request(body, OWNER, NOW)).toEqual(request)
    expect(() => host.request(body, 'human:intruder', NOW)).toThrow(/operation_id/)
    expect(db.raw.prepare("SELECT status,attempt FROM node_runs WHERE node_run_id='a1'").get()).toMatchObject({ status: 'done', attempt: 1 })
    expect(db.raw.prepare('SELECT attempt,origin_node_run_id FROM node_runs WHERE node_run_id=?').get(request.new_node_run_id!)).toMatchObject({ attempt: 2, origin_node_run_id: 'a1' })
    const newHash = complete(db, request)
    host.recover(LATER)
    const pending = host.get(request.request_id, OWNER).item.request
    expect(pending.status).toBe('awaiting_review')
    const accept = { operation_id: uuidv7(), request_id: pending.request_id, expected_revision: pending.revision, action: 'accept' as const, note: 'Verified timestamp', artifact_id: 'v2', artifact_hash: newHash }
    expect(() => host.review({ ...accept, artifact_id: 'v1' }, OWNER, LATER)).toThrow(/精确成果版本/)
    expect(host.review(accept, OWNER, LATER).status).toBe('closed')
    expect(host.review(accept, OWNER, LATER).status).toBe('closed')
    expect(host.get(pending.request_id, OWNER).item.reviews).toHaveLength(1)
    expect(db.raw.prepare("SELECT bytes FROM artifact_contents WHERE artifact_id='v1'").get()).toEqual({ bytes: new Uint8Array(Buffer.from('old report')) })
    expect(host.list('human:intruder').items).toEqual([])
  } finally { db.raw.close() }
})

it('rerun authorization is owner-bound CAS and rejects stale target revisions or hashes', () => {
  const { db, host } = setup()
  try {
    expect(() => host.request({ ...input(), source_artifact_hash: '0'.repeat(64) }, OWNER, NOW)).toThrow(/哈希/)
    expect(() => host.request({ ...input(), expected_revision: 0 }, OWNER, NOW)).toThrow(/当前已完成/)
    const request = host.request(input('rerun_node'), OWNER, NOW)
    expect(request.status).toBe('proposed')
    const command = { operation_id: uuidv7(), request_id: request.request_id, expected_revision: request.revision, action: 'authorize' as const, note: 'Rerun approved' }
    expect(() => host.review(command, 'human:intruder', NOW)).toThrow(/负责人/)
    expect(host.review(command, OWNER, NOW).status).toBe('scheduled')
    expect(() => host.review({ ...command, operation_id: uuidv7() }, OWNER, NOW)).toThrow(/版本/)
    expect(() => host.request(input(), OWNER, NOW)).toThrow(/当前已完成/)
  } finally { db.raw.close() }
})

it('agent feedback requires same-run dependency, bound generation and strong evidence; fresh reviewer accepts v2', () => {
  const { db, host } = setup({ startedReviewer: true })
  try {
    evidence(db, reviewer.node_run_id, 'proof')
    expect(() => host.request({ ...input(), evidence_ids: ['proof'] }, { ...reviewer, action_generation: 0 }, NOW)).toThrow(/当前执行主体/)
    expect(() => host.request(input(), reviewer, NOW)).toThrow(/可信执行证据/)
    evidence(db, 'x1', 'outsider-proof')
    expect(() => host.request({ ...input(), evidence_ids: ['outsider-proof'] }, { ...reviewer, node_run_id: 'x1' }, NOW)).toThrow(/上游成果/)
    const request = host.request({ ...input(), evidence_ids: ['proof'] }, reviewer, NOW)
    expect(request.status).toBe('scheduled')
    expect(db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id='b1'").get()).toMatchObject({ status: 'superseded' })
    const resultHash = complete(db, request)
    host.recover(LATER)
    const pending = host.get(request.request_id, OWNER).item.request
    const fresh = db.raw.prepare("SELECT node_run_id,attempt,action_generation FROM node_runs WHERE node_id='B' AND replacement_node_run_id IS NULL").get() as typeof reviewer
    expect(fresh.attempt).toBe(2)
    withTx(db, tx => tx.run("UPDATE node_runs SET status='started' WHERE node_run_id=?", [fresh.node_run_id]))
    evidence(db, fresh.node_run_id, 'review-proof', LATER)
    expect(host.review({ operation_id: uuidv7(), request_id: request.request_id, expected_revision: pending.revision, action: 'accept', note: 'Read v2 and checked timestamp', artifact_id: 'v2', artifact_hash: resultHash, evidence_ids: ['review-proof'] }, fresh, LATER).status).toBe('closed')
  } finally { db.raw.close() }
})

it('unsafe effects fail closed, request duplicates cannot create extra attempts, and recovery survives restart', () => {
  const { db, host } = setup({ unsafe: true })
  let reopened: Db | undefined
  try {
    const request = host.request(input(), OWNER, NOW)
    expect(request.status).toBe('needs_human_approval')
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rework_attempts').get()).toMatchObject({ n: 0 })
    expect(() => host.request(input(), OWNER, NOW)).toThrow(/已有/)
    expect(() => host.review({ operation_id: uuidv7(), request_id: request.request_id, expected_revision: request.revision, action: 'authorize', note: 'Retry' }, OWNER, NOW)).toThrow(/pure/)
    reopened = openDb(db.file)
    const resumed = createReworkHost(reopened, TEST_SECRET)
    expect(resumed.get(request.request_id, OWNER).item.request.status).toBe('needs_human_approval')
    resumed.recover('2026-11-21T01:00:00.000Z')
    expect(resumed.get(request.request_id, OWNER).item.request.status).toBe('escalated')
    resumed.recover('2026-11-21T01:00:00.000Z')
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM node_runs').get()).toMatchObject({ n: 4 })
  } finally { reopened?.raw.close(); db.raw.close() }
})

it('repeated changes retain attempts, stop at round budget, and never release unresolved inputs', () => {
  const { db, host } = setup()
  try {
    let request = host.request(input(), OWNER, NOW)
    for (let round = 1; round <= 3; round++) {
      const artifactId = 'v' + (round + 1)
      const artifactHash = complete(db, request, artifactId)
      host.recover(LATER)
      request = host.get(request.request_id, OWNER).item.request
      request = host.review({ operation_id: uuidv7(), request_id: request.request_id, expected_revision: request.revision, action: 'request_changes', note: 'Still needs correction ' + round, artifact_id: artifactId, artifact_hash: artifactHash }, OWNER, LATER)
      if (round < 3) request = host.review({ operation_id: uuidv7(), request_id: request.request_id, expected_revision: request.revision, action: 'authorize', note: 'Authorize next round' }, OWNER, LATER)
    }
    expect(request).toMatchObject({ status: 'escalated', budget_remaining: 0 })
    expect(host.get(request.request_id, OWNER).item.attempts).toHaveLength(3)
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rework_impacts WHERE released_at IS NULL').get()).toMatchObject({ n: 2 })
  } finally { db.raw.close() }
})

it('run cancellation blocks late authorization and recovery cancels unresolved feedback', () => {
  const { db, host } = setup()
  try {
    const request = host.request(input('rerun_node'), OWNER, NOW)
    withTx(db, tx => tx.run("UPDATE runs SET cancel_requested_at=? WHERE run_id='run'", [LATER]))
    expect(() => host.review({ operation_id: uuidv7(), request_id: request.request_id, expected_revision: request.revision, action: 'authorize', note: 'Too late' }, OWNER, LATER)).toThrow(/活动运行/)
    host.recover(LATER)
    expect(host.get(request.request_id, OWNER).item.request.status).toBe('cancelled')
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rework_attempts').get()).toMatchObject({ n: 0 })
  } finally { db.raw.close() }
})

it('verified findings are supplementary evidence and require confirmed adopted same-run provenance', () => {
  const { db, host } = setup({startedReviewer:true})
  try {
    evidence(db,'b1','finding-proof')
    const verifier = {node_run_id:'x1',attempt:1,action_generation:1}
    const collaboration=createCollaborationHost(db,TEST_SECRET)
    const scope=collaboration.createScope({operation_id:uuidv7(),title:'Verify missing timestamp',node_run_ids:['b1','x1'],ttl_minutes:60},OWNER,NOW)
    const finding=collaboration.reportFinding(reviewer,{scope_id:scope.scope_id,title:'Missing timestamp',summary:'The timestamp field is absent',evidence_id:'finding-proof'},NOW)
    const request=collaboration.requestVerification(reviewer,{finding_id:finding.finding_id,target_node_run_id:'x1',question:'Independently inspect field',ttl_minutes:30},NOW)
    const body={...input(),evidence_ids:['finding-proof'],verification_request_id:request.request_id}
    expect(()=>host.request(body,reviewer,NOW)).toThrow(/已确认并采纳/)
    collaboration.review({operation_id:uuidv7(),request_id:request.request_id,expected_revision:1,action:'authorize',note:'Independent check'},OWNER,NOW)
    collaboration.handle(verifier,{operation_id:uuidv7(),request_id:request.request_id,expected_revision:2,action:'delivered'},NOW)
    collaboration.handle(verifier,{operation_id:uuidv7(),request_id:request.request_id,expected_revision:3,action:'accept'},NOW)
    evidence(db,'x1','independent-proof',LATER)
    collaboration.handle(verifier,{operation_id:uuidv7(),request_id:request.request_id,expected_revision:4,action:'complete',result:'Timestamp absent',verdict:'confirmed',evidence_id:'independent-proof'},LATER)
    expect(()=>host.request(body,reviewer,LATER)).toThrow(/已确认并采纳/)
    collaboration.review({operation_id:uuidv7(),request_id:request.request_id,expected_revision:5,action:'adopt',note:'Adopt finding'},OWNER,LATER)
    expect(host.request(body,reviewer,LATER)).toMatchObject({status:'scheduled',verification_request_id:request.request_id})
  } finally {db.raw.close()}
})

it('multiple prior outputs require an explicit preservation plan, and candidate feedback cannot overlap an open review', () => {
  const {db,host}=setup()
  try {
    putArtifact(db,'a1','appendix','unchanged appendix')
    const pending=host.request(input(),OWNER,NOW)
    expect(pending.status).toBe('needs_human_approval')
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rework_attempts').get()).toMatchObject({n:0})
    host.review({operation_id:uuidv7(),request_id:pending.request_id,expected_revision:pending.revision,action:'reject',note:'Use full rerun with preservation instructions'},OWNER,NOW)
    const rerun=host.request(input('rerun_node'),OWNER,NOW)
    const scheduled=host.review({operation_id:uuidv7(),request_id:rerun.request_id,expected_revision:rerun.revision,action:'authorize',note:'Full node rerun explicitly approved'},OWNER,NOW)
    const artifactHash=complete(db,scheduled)
    host.recover(LATER)
    const node=db.raw.prepare('SELECT revision FROM node_runs WHERE node_run_id=?').get(scheduled.new_node_run_id!) as {revision:number}
    expect(()=>host.request({...input(),target_node_run_id:scheduled.new_node_run_id!,source_artifact_id:'v2',source_artifact_hash:artifactHash,expected_revision:node.revision},OWNER,LATER)).toThrow(/未完成返工/)
  } finally {db.raw.close()}
})

it('corrupt revised bytes escalate recoverably instead of accepting hashes or wedging recovery', () => {
  const {db,host}=setup()
  try {
    const request=host.request(input(),OWNER,NOW)
    complete(db,request)
    withTx(db,tx=>tx.run("UPDATE artifact_contents SET bytes=? WHERE artifact_id='v2'",[Buffer.from('tampered')]))
    expect(()=>host.recover(LATER)).not.toThrow()
    expect(host.get(request.request_id,OWNER).item.request.status).toBe('escalated')
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM rework_reviews WHERE action='accept'").get()).toMatchObject({n:0})
    expect(db.raw.prepare("SELECT type FROM events WHERE type='rework.recovery_blocked'").get()).toBeTruthy()
  } finally {db.raw.close()}
})

it('planner findings retain distinct trusted provenance and receipts with owner authorization', () => {
  const {db,host}=setup()
  try {
    const body=input('rerun_node')
    expect(()=>host.requestFromPlanner(body,'human:intruder',NOW)).toThrow(/负责人/)
    const request=host.requestFromPlanner(body,OWNER,NOW)
    expect(request).toMatchObject({status:'proposed',requester_actor:'planner:'+OWNER,requester_node_run_id:null})
    expect(host.requestFromPlanner(body,OWNER,NOW)).toEqual(request)
    expect(()=>host.request(body,OWNER,NOW)).toThrow(/operation_id/)
    expect(db.raw.prepare('SELECT kind FROM inbox WHERE operation_id=?').get(body.operation_id)).toMatchObject({kind:'rework.planner_request'})
  } finally {db.raw.close()}
})

it('expired unstarted feedback can be declined, while executed escalation requires explicit owner run termination', () => {
  const {db,host}=setup()
  try {
    const pending=host.request(input('rerun_node'),OWNER,NOW)
    const expired='2026-11-21T01:00:00.000Z'
    host.recover(expired)
    const escalated=host.get(pending.request_id,OWNER).item.request
    expect(escalated.status).toBe('escalated')
    expect(host.review({operation_id:uuidv7(),request_id:pending.request_id,expected_revision:escalated.revision,action:'reject',note:'No revision will be performed'},OWNER,expired).status).toBe('declined')
    const scheduled=host.request(input(),OWNER,NOW)
    host.recover(expired)
    const executed=host.get(scheduled.request_id,OWNER).item.request
    expect(()=>host.review({operation_id:uuidv7(),request_id:executed.request_id,expected_revision:executed.revision,action:'reject',note:'Cannot drop active protection'},OWNER,expired)).toThrow()
    const command={operation_id:uuidv7(),request_id:executed.request_id,expected_revision:executed.revision,action:'reject_final' as const,note:'Terminate this run and preserve uncertain effects'}
    expect(()=>host.review(command,'human:other',expired)).toThrow(/负责人/)
    const controlled=createReworkHost(db,TEST_SECRET,{clock:new SystemClock('rework-cancel-test')})
    expect(controlled.review(command,OWNER,expired).status).toBe('cancelled')
    expect(controlled.review(command,OWNER,expired).status).toBe('cancelled')
    expect(db.raw.prepare("SELECT cancel_requested_at,cancel_result FROM runs WHERE run_id='run'").get()).toMatchObject({cancel_requested_at:expired,cancel_result:'unknown'})
    expect(db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id='x1'").get()).toMatchObject({status:'stopping'})
    expect(db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id=?').get(scheduled.new_node_run_id!)).toMatchObject({status:'superseded'})
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE type='rework.run_termination_requested'").get()).toMatchObject({n:1})
  } finally {db.raw.close()}
})
