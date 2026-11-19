import { expect, it } from 'vitest'
import { uuidv7 } from '../../src/core/ids.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { createCollaborationHost, type CollaborationBinding } from '../../src/service/collaboration.ts'
import { freshLedger, TEST_SECRET } from '../fixtures/ledger.ts'

const NOW = '2026-11-18T01:00:00.000Z'
const ACCEPTED = '2026-11-18T01:00:01.000Z'
const CHECKED = '2026-11-18T01:00:02.000Z'
const EXPIRED = '2026-11-18T01:02:00.000Z'
const actor = 'human:lead'
const source = { node_run_id: 'source', attempt: 1, action_generation: 1 }
const target = { node_run_id: 'target', attempt: 1, action_generation: 2 }
const outsider = { node_run_id: 'outsider', attempt: 1, action_generation: 1 }

function seedMembers(db: Db) {
  withTx(db, (tx) => {
    for (const node of [source, target, outsider]) {
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
