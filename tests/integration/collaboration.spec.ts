import { expect, it } from 'vitest'
import { sha256Hex } from '../../src/core/canonical.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { createCollaborationHost, type CollaborationBinding } from '../../src/service/collaboration.ts'
import { callDshCollaboration } from '../../src/service/dsh-collaboration.ts'
import { startServer } from '../../src/service/server.ts'
import { freshLedger, TEST_SECRET } from '../fixtures/ledger.ts'

const NOW = '2026-11-18T01:00:00.000Z'
const ACCEPTED = '2026-11-18T01:00:01.000Z'
const CHECKED = '2026-11-18T01:00:02.000Z'
const EXPIRED = '2026-11-18T01:02:00.000Z'
const actor = 'human:lead'
const source = { node_run_id: 'source', attempt: 1, action_generation: 1 }
const target = { node_run_id: 'target', attempt: 1, action_generation: 2 }
const outsider = { node_run_id: 'outsider', attempt: 1, action_generation: 1 }
const replacementNode = { node_run_id: 'replacement', attempt: 3, action_generation: 4 }

function seedMembers(db: Db, nodes = [source, target, outsider]) {
  withTx(db, (tx) => {
    for (const node of nodes) {
      const task = 'task-' + node.node_run_id
      const run = 'run-' + node.node_run_id
      tx.run("INSERT INTO tasks (task_id,title,status,created_at,updated_at) VALUES (?,?,'running',?,?)", [task, task, NOW, NOW])
      tx.run("INSERT INTO runs (run_id,task_id,status,created_at,updated_at) VALUES (?,?,'running',?,?)", [run, task, NOW, NOW])
      tx.run(`INSERT INTO node_runs (node_run_id,run_id,node_id,node_type,seq,status,attempt,action_generation,created_at,updated_at)
        VALUES (?,?,?,'agent',1,'started',?,?,?,?)`, [node.node_run_id, run, node.node_run_id, node.attempt, node.action_generation, NOW, NOW])
    }
  })
}

function toolReceipt(db: Db, node: CollaborationBinding, number: number, finishedAt: string) {
  const executionId = 'tex_' + node.node_run_id + '_' + String(number)
  const contentHash = String(number).repeat(64)
  withTx(db, (tx) => {
    tx.run(`INSERT INTO tool_executions
      (execution_id,node_run_id,attempt,tool_seq,tool,exit_code,stdout_hash,stderr_hash,command_hash,started_at,finished_at)
      VALUES (?,?,?,?,'read-report',0,?,NULL,?,?,?)`, [executionId, node.node_run_id, node.attempt, number, contentHash, contentHash, finishedAt, finishedAt])
    appendNodeRunEvent(tx, TEST_SECRET, node.node_run_id, 'tool_finished', {
      execution_id: executionId, attempt: node.attempt, tool: 'read-report', exit_code: 0,
      stdout_hash: contentHash, stderr_hash: null, command_hash: contentHash, finished_at: finishedAt,
    })
  })
  return executionId
}

it('按运行内步骤顺序显示冻结版本标题并保留历史缺名节点', () => {
  const { db } = freshLedger()
  try {
    withTx(db, (tx) => {
      for (const [version, title] of [['1', '汇总分析'], ['2', '已改名的汇总步骤']]) {
        tx.run('INSERT INTO workflow_versions (workflow_id,version,content_hash,definition_json,created_at,doc_json) VALUES (?,?,?,\'{}\',?,?)',
          ['monthly', version, `hash-${version}`, NOW, JSON.stringify({ nodes: [{ node_id: 'analyse', title }] })])
      }
      tx.run("INSERT INTO tasks (task_id,title,status,created_at,updated_at) VALUES ('t1','月报','running',?,?)", [NOW, NOW])
      tx.run(`INSERT INTO runs (run_id,task_id,workflow_id,workflow_version,workflow_definition_hash,status,created_at,updated_at)
        VALUES ('run','t1','monthly','1','hash-1','running',?,?)`, [NOW, NOW])
      tx.run(`INSERT INTO node_runs (node_run_id,run_id,node_id,node_type,seq,status,attempt,action_generation,created_at,updated_at)
        VALUES ('z-first','run','analyse','agent',1,'started',1,1,?,?), ('a-legacy','run','old','agent',2,'started',1,1,?,?)`,
        [NOW, NOW, NOW, NOW])
    })
    const host = createCollaborationHost(db, TEST_SECRET)
    const scope = host.createScope({ operation_id: uuidv7(), title: '月报复核', node_run_ids: ['a-legacy', 'z-first'], ttl_minutes: 60 }, actor, NOW)
    expect(host.getScope(scope.scope_id, actor, NOW).item.members).toEqual([
      { node_run_id: 'z-first', node_id: 'analyse', task_id: 't1', run_id: 'run', title: '汇总分析' },
      { node_run_id: 'a-legacy', node_id: 'old', task_id: 't1', run_id: 'run' },
    ])
  } finally { db.raw.close() }
})

it('跨任务发现经过主脑授权、接收、独立核验和采纳，且不改接收方任务', () => {
  const { db } = freshLedger()
  let reopened: Db | undefined
  try {
    seedMembers(db)
    const host = createCollaborationHost(db, TEST_SECRET)
    const scopeInput = { operation_id: uuidv7(), title: '交付报告独立核验', node_run_ids: [source.node_run_id, target.node_run_id], ttl_minutes: 60 }
    const scope = host.createScope(scopeInput, actor, NOW)
    expect(host.createScope(scopeInput, actor, NOW)).toEqual(scope)
    expect(host.listMemberships(source, NOW).items).toEqual([{
      scope_id: scope.scope_id, title: scope.title, expires_at: scope.expires_at,
      members: [
        { node_run_id: 'source', node_id: 'source', task_id: 'task-source', run_id: 'run-source' },
        { node_run_id: 'target', node_id: 'target', task_id: 'task-target', run_id: 'run-target' },
      ],
    }])
    expect(host.listMemberships(outsider, NOW).items).toEqual([])
    expect(() => host.listMemberships({ ...source, action_generation: 0 }, NOW)).toThrow(/当前执行主体/)
    const sourceProof = toolReceipt(db, source, 1, NOW)
    const targetEarlier = toolReceipt(db, target, 1, ACCEPTED)
    const findingInput = { scope_id: scope.scope_id, title: '报告汇总项缺少附件', summary: '报表第七项显示有交付物，但留存索引没有这条记录。', evidence_id: sourceProof }
    expect(() => host.reportFinding(outsider, findingInput, NOW)).toThrow(/未加入/)
    expect(() => host.reportFinding({ ...source, action_generation: 0 }, findingInput, NOW)).toThrow(/当前执行主体/)
    const finding = host.reportFinding(source, findingInput, NOW)
    expect(host.reportFinding(source, findingInput, NOW)).toEqual(finding)
    expect(() => host.getScope(scope.scope_id, 'human:other')).toThrow(/不存在/)
    const propose = { finding_id: finding.finding_id, target_node_run_id: target.node_run_id, question: '请从留存索引独立核对第七项。', ttl_minutes: 10 }
    expect(() => host.requestVerification(source, { ...propose, target_node_run_id: outsider.node_run_id }, NOW)).toThrow(/未加入/)
    expect(() => host.requestVerification(source, { ...propose, target_node_run_id: source.node_run_id }, NOW)).toThrow(/独立接收方/)
    const pending = host.requestVerification(source, propose, NOW)
    expect(host.requestVerification(source, propose, NOW)).toEqual(pending)
    expect(host.listOutgoing(source).items).toMatchObject([{ finding: { finding_id: finding.finding_id }, requests: [{ status: 'proposed' }] }])
    expect(host.listOutgoing(target).items).toEqual([])
    expect(host.listOutgoing(outsider).items).toEqual([])
    expect(host.listInbox(target, NOW).items).toEqual([])
    const requestId = pending.request_id
    const authorize = { operation_id: uuidv7(), request_id: requestId, expected_revision: 1, action: 'authorize' as const, note: '授权交叉核验附件索引。' }
    expect(() => host.review(authorize, 'human:other', NOW)).toThrow(/不存在/)
    expect(host.review(authorize, actor, NOW)).toMatchObject({ status: 'authorized', revision: 2 })
    expect(host.listInbox(target, NOW).items).toMatchObject([{ request: { status: 'authorized' }, finding: { finding_id: finding.finding_id } }])
    expect(host.listInbox(outsider, NOW).items).toEqual([])
    const receipt = { operation_id: uuidv7(), request_id: requestId, expected_revision: 2, action: 'delivered' as const }
    expect(() => host.handle(source, receipt, NOW)).toThrow(/接收方/)
    expect(() => host.handle(target, { ...receipt, action: 'accept' }, NOW)).toThrow(/业务处理步骤/)
    const delivered = host.handle(target, receipt, NOW)
    expect(delivered).toMatchObject({ status: 'delivered', revision: 3, target_attempt: 1, target_generation: 2 })
    expect(host.handle(target, receipt, NOW)).toEqual(delivered)
    expect(host.handle(target, { ...receipt, operation_id: uuidv7() }, NOW)).toEqual(delivered)
    expect(host.handle(target, { ...receipt, operation_id: uuidv7(), expected_revision: 3, action: 'accept' }, ACCEPTED)).toMatchObject({ status: 'accepted', revision: 4 })
    const complete = { ...receipt, operation_id: uuidv7(), expected_revision: 4, action: 'complete' as const,
      result: '独立读取索引并确认第七项缺少留存附件。', verdict: 'confirmed' as const }
    expect(() => host.handle(target, { ...complete, evidence_id: sourceProof }, CHECKED)).toThrow(/独立执行/)
    expect(() => host.handle(target, { ...complete, evidence_id: targetEarlier }, CHECKED)).toThrow(/独立执行/)
    const targetProof = toolReceipt(db, target, 2, CHECKED)
    expect(host.handle(target, { ...complete, evidence_id: targetProof }, CHECKED)).toMatchObject({
      status: 'completed', verdict: 'confirmed', revision: 5, evidence_id: targetProof, adoption: null,
    })

    // A separate SQLite connection sees the persisted workflow of approvals and evidence.
    reopened = openDb(db.file)
    const afterRestart = createCollaborationHost(reopened, TEST_SECRET)
    expect(afterRestart.review({ ...authorize, operation_id: uuidv7(), expected_revision: 5, action: 'adopt', note: '已采纳作为交付缺口。' }, actor, CHECKED))
      .toMatchObject({ status: 'completed', adoption: 'adopted', revision: 6 })
    expect(() => afterRestart.reassignVerification({ operation_id: uuidv7(), request_id: requestId, expected_revision: 6,
      target_node_run_id: outsider.node_run_id, note: '试图改派已完成核验' }, actor, CHECKED)).toThrow(/未结核验/)
    expect(afterRestart.getScope(scope.scope_id, actor).item).toMatchObject({
      members: [{ task_id: 'task-source' }, { task_id: 'task-target' }],
      findings: [{ evidence_id: sourceProof }], requests: [{ evidence_id: targetProof, adoption: 'adopted' }],
    })
    expect(afterRestart.listOutgoing(source).items[0]?.requests[0]).toMatchObject({ evidence_id: targetProof, adoption: 'adopted' })
    expect(db.raw.prepare("SELECT type FROM events WHERE type LIKE 'collaboration.%' ORDER BY seq").all().map((row) => row.type))
      .toEqual(['collaboration.scope_created', 'collaboration.finding_reported', 'collaboration.proposed', 'collaboration.authorized',
        'collaboration.delivered', 'collaboration.accepted', 'collaboration.completed', 'collaboration.adopted'])
    expect(db.raw.prepare("SELECT status, revision FROM node_runs WHERE node_run_id = 'target'").get()).toMatchObject({ status: 'started', revision: 0 })
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 3 })
  } finally {
    reopened?.raw.close()
    db.raw.close()
  }
})

it('主理人改派失效的签收，撤回与新投递在重启后仍可追溯并隔离旧接收方', async () => {
  const { db } = freshLedger()
  let reopened: Db | undefined
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  const now = new Date().toISOString()
  const owner = 'service:' + sha256Hex(TEST_SECRET).slice(0, 8)
  try {
    seedMembers(db, [source, target, outsider, replacementNode])
    const host = createCollaborationHost(db, TEST_SECRET)
    const scope = host.createScope({ operation_id: uuidv7(), title: '含候补的核验范围',
      node_run_ids: [source.node_run_id, target.node_run_id, replacementNode.node_run_id], ttl_minutes: 60 }, owner, now)
    const sourceProof = toolReceipt(db, source, 1, now)
    const finding = host.reportFinding(source, { scope_id: scope.scope_id, title: '附件', summary: '索引缺少附件', evidence_id: sourceProof }, now)
    const propose = { finding_id: finding.finding_id, target_node_run_id: target.node_run_id, question: '独立核对留存索引', ttl_minutes: 10 }
    const original = host.requestVerification(source, propose, now)
    const authorize = { operation_id: uuidv7(), request_id: original.request_id, expected_revision: 1, action: 'authorize' as const, note: '授权核验' }
    host.review(authorize, owner, now)
    host.handle(target, { operation_id: uuidv7(), request_id: original.request_id, expected_revision: 2, action: 'delivered' }, now)
    const accept = { operation_id: uuidv7(), request_id: original.request_id, expected_revision: 3, action: 'accept' as const }
    host.handle(target, accept, now)
    const oldProof = toolReceipt(db, target, 1, now)
    const earlyProof = toolReceipt(db, replacementNode, 1, now)
    const reassign = { operation_id: uuidv7(), request_id: original.request_id, expected_revision: 4,
      target_node_run_id: replacementNode.node_run_id, note: '前一执行节点失效' }
    expect(() => host.reassignVerification(reassign, owner, now)).toThrow(/无法继续/)
    withTx(db, (tx) => tx.run("UPDATE node_runs SET status = 'failed' WHERE node_run_id = ?", [target.node_run_id]))
    expect(host.getScope(scope.scope_id, owner, now).item.requests[0]).toMatchObject({ reassignment_candidates: [replacementNode.node_run_id] })
    expect(() => host.reassignVerification(reassign, actor, now)).toThrow(/不存在/)
    expect(() => host.reassignVerification({ ...reassign, expected_revision: 3 }, owner, now)).toThrow(/新状态/)
    expect(() => host.reassignVerification({ ...reassign, target_node_run_id: outsider.node_run_id }, owner, now)).toThrow(/未加入/)
    expect(() => host.reassignVerification({ ...reassign, target_node_run_id: source.node_run_id }, owner, now)).toThrow(/独立接收方/)
    expect(() => host.reassignVerification(reassign, owner, original.expires_at)).toThrow(/超过时限/)
    expect(host.listInbox(replacementNode, now).items).toEqual([])

    server = await startServer({ secret: TEST_SECRET, phase: 'S5', epoch: db.epoch, asOfSeq: () => 0,
      listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'unused' }), now: () => now, collaboration: host })
    const url = server.endpoint + '/v1/collaboration/reassign'
    const post = () => fetch(url, { method: 'POST', headers: { 'x-orchestra-secret': TEST_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify(reassign) })
    const responses = await Promise.all([post(), post()])
    expect(responses.map(({ status }) => status)).toEqual([200, 200])
    const [result, replay] = await Promise.all(responses.map(async (response) => (await response.json() as {
      data: ReturnType<typeof host.reassignVerification>
    }).data))
    expect(result).toEqual(replay)
    const { withdrawn, replacement } = result!
    expect(withdrawn).toMatchObject({ request_id: original.request_id, status: 'withdrawn', withdrawn_from_status: 'accepted',
      accepted_at: now, delivered_at: now, target_attempt: target.attempt, target_generation: target.action_generation,
      replacement_request_id: replacement.request_id, authorization_note: authorize.note, revision: 5 })
    expect(replacement).toMatchObject({ status: 'authorized', revision: 1, scope_id: scope.scope_id, finding_id: finding.finding_id,
      replaces_request_id: original.request_id, target_attempt: replacementNode.attempt, target_generation: replacementNode.action_generation,
      question: original.question, expires_at: original.expires_at, authorization_note: reassign.note })
    expect(() => host.reassignVerification({ ...reassign, operation_id: uuidv7() }, owner, now)).toThrow(/新状态/)
    expect(() => host.reassignVerification({ ...reassign, note: '已变更' }, owner, now)).toThrow(/不同的请求/)

    // Even if the old executor comes back, withdrawn deliveries and cached accept receipts are fenced.
    withTx(db, (tx) => tx.run("UPDATE node_runs SET status = 'started' WHERE node_run_id = ?", [target.node_run_id]))
    expect(host.listInbox(target, now).items).toEqual([])
    expect(() => host.handle(target, accept, now)).toThrow(/已撤回/)
    expect(() => host.handle(target, { ...accept, operation_id: uuidv7(), expected_revision: 1, request_id: replacement.request_id,
      action: 'delivered' }, now)).toThrow(/接收方/)
    expect(host.requestVerification(source, propose, now)).toEqual(withdrawn)

    reopened = openDb(db.file)
    const restarted = createCollaborationHost(reopened, TEST_SECRET)
    expect(restarted.reassignVerification(reassign, owner, now)).toEqual(result)
    const tool = (message: unknown) => callDshCollaboration(restarted, replacementNode, message)
    expect(tool({ action: 'inbox' })).toMatchObject({ items: [{ request: { request_id: replacement.request_id, status: 'authorized' } }] })
    expect(tool({ request_id: replacement.request_id, expected_revision: 1, action: 'delivered' })).toMatchObject({ status: 'delivered' })
    expect(tool({ request_id: replacement.request_id, expected_revision: 2, action: 'accept' })).toMatchObject({ status: 'accepted' })
    const complete = { request_id: replacement.request_id, expected_revision: 3, action: 'complete', result: '重新核对留存索引', verdict: 'confirmed' }
    for (const proof of [oldProof, sourceProof, earlyProof]) {
      expect(() => tool({ ...complete, evidence_id: proof })).toThrow(/独立执行/)
    }
    const newProof = toolReceipt(reopened, replacementNode, 2, new Date().toISOString())
    expect(tool({ ...complete, evidence_id: newProof })).toMatchObject({ status: 'completed', evidence_id: newProof })
    expect(restarted.sweep(original.expires_at)).toBe(0)
    expect(restarted.listOutgoing(source).items[0]?.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'withdrawn' }), expect.objectContaining({ status: 'completed', evidence_id: newProof }),
    ]))
    expect(reopened.raw.prepare("SELECT type FROM events WHERE type IN ('collaboration.withdrawn','collaboration.reassigned') ORDER BY seq").all().map((row) => row.type))
      .toEqual(['collaboration.withdrawn', 'collaboration.reassigned'])
  } finally {
    await server?.close()
    reopened?.raw.close()
    db.raw.close()
  }
})

it('已授权未接受的请求按时限持久过期，过期后不可送达', () => {
  const { db } = freshLedger()
  try {
    seedMembers(db)
    const host = createCollaborationHost(db, TEST_SECRET)
    const scope = host.createScope({ operation_id: uuidv7(), title: '核验范围', node_run_ids: ['source', 'target'], ttl_minutes: 1 }, actor, NOW)
    const finding = host.reportFinding(source, { scope_id: scope.scope_id, title: '附件', summary: '索引缺少附件。', evidence_id: toolReceipt(db, source, 1, NOW) }, NOW)
    const request = host.requestVerification(source, { finding_id: finding.finding_id, target_node_run_id: 'target', question: '请复查', ttl_minutes: 1440 }, NOW)
    host.review({ operation_id: uuidv7(), request_id: request.request_id, expected_revision: 1, action: 'authorize', note: '可以核验。' }, actor, NOW)
    expect(host.listInbox(target, EXPIRED).items).toEqual([])
    expect(host.listMemberships(target, EXPIRED).items).toEqual([])
    expect(() => host.handle(target, { operation_id: uuidv7(), request_id: request.request_id, expected_revision: 2, action: 'delivered' }, EXPIRED))
      .toThrow(/超过时限/)
    expect(host.sweep(EXPIRED)).toBe(1)
    expect(host.sweep(EXPIRED)).toBe(0)
    expect(host.getScope(scope.scope_id, actor).item.requests[0]).toMatchObject({ status: 'expired', revision: 3 })
  } finally {
    db.raw.close()
  }
})

it('未接受的投递可由同一节点新代次重新确认，接受后换代必须重新裁决', () => {
  const { db } = freshLedger()
  try {
    seedMembers(db)
    const host = createCollaborationHost(db, TEST_SECRET)
    const scope = host.createScope({ operation_id: uuidv7(), title: '核验范围', node_run_ids: ['source', 'target'], ttl_minutes: 1 }, actor, NOW)
    const evidence_id = toolReceipt(db, source, 1, NOW)
    const finding = host.reportFinding(source, { scope_id: scope.scope_id, title: '附件', summary: '索引缺少附件。', evidence_id }, NOW)
    const request = host.requestVerification(source, { finding_id: finding.finding_id, target_node_run_id: 'target', question: '请复查', ttl_minutes: 1 }, NOW)
    host.review({ operation_id: uuidv7(), request_id: request.request_id, expected_revision: 1, action: 'authorize', note: '可以核验。' }, actor, NOW)
    const update = { request_id: request.request_id, expected_revision: 2 }
    const receipt = { ...update, operation_id: uuidv7(), action: 'delivered' as const }
    host.handle(target, receipt, NOW)

    const reactivated = { ...target, action_generation: target.action_generation + 1 }
    withTx(db, (tx) => { tx.run('UPDATE node_runs SET action_generation = ? WHERE node_run_id = ?', [reactivated.action_generation, target.node_run_id]) })
    expect(() => host.listInbox(target, NOW)).toThrow(/当前执行主体/)
    expect(host.listInbox(reactivated, NOW).items).toMatchObject([{ request: { status: 'delivered', revision: 3 } }])
    expect(() => host.handle(reactivated, { ...update, operation_id: uuidv7(), expected_revision: 3, action: 'accept' }, NOW)).toThrow(/接收方/)
    expect(host.handle(reactivated, { ...receipt, operation_id: uuidv7(), expected_revision: 3 }, NOW))
      .toMatchObject({ status: 'delivered', target_generation: reactivated.action_generation, revision: 4 })
    expect(host.handle(reactivated, { ...update, operation_id: uuidv7(), expected_revision: 4, action: 'accept' }, ACCEPTED))
      .toMatchObject({ status: 'accepted', revision: 5 })

    const afterAcceptance = { ...reactivated, action_generation: reactivated.action_generation + 1 }
    withTx(db, (tx) => { tx.run('UPDATE node_runs SET action_generation = ? WHERE node_run_id = ?', [afterAcceptance.action_generation, target.node_run_id]) })
    expect(host.listInbox(afterAcceptance, CHECKED).items).toEqual([])
    expect(() => host.handle(afterAcceptance, { ...receipt, operation_id: uuidv7(), expected_revision: 5 }, CHECKED)).toThrow(/接收方/)
    expect(db.raw.prepare("SELECT count(*) AS n FROM events WHERE type = 'collaboration.redelivered'").get()).toMatchObject({ n: 1 })
    expect(host.sweep(EXPIRED)).toBe(1)
    expect(host.getScope(scope.scope_id, actor).item.requests[0]).toMatchObject({ status: 'expired', accepted_at: ACCEPTED, revision: 6 })
  } finally {
    db.raw.close()
  }
})
