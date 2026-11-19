// S4 工作流命令的 HTTP 入口：四个写命令强制 operation_id（规格 3.7）
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openServiceOrchestra } from '../../src/index.ts'
import { startServer } from '../../src/service/server.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import type { Db } from '../../src/infra/sqlite/driver.ts'
import { getWorkflowSnapshot } from '../../src/service/queries/workflows.ts'

const SECRET = 'wf-routes-secret'
const NOW = '2026-11-16T17:00:00.000Z'
const closers: (() => Promise<void>)[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) { try { await close() } catch { /* 已关 */ } }
  for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄晚释放 */ } }
})

async function boot(phase: 'S2' | 'S4' | 'S5' = 'S4', workflowGenerator?: () => Promise<unknown>, onDb?: (db: Db) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-wf-routes-'))
  dirs.push(dir)
  const service = await openServiceOrchestra({ dbFile: join(dir, 'orchestra.db'), secret: SECRET, phase })
  onDb?.(service.orchestra.db)
  const svc = await startServer({
    secret: SECRET, phase, epoch: service.orchestra.db.epoch,
    asOfSeq: () => 0,
    listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'e' }),
    now: () => NOW,
    commands: service.orchestra.commands,
    workflowGenerator,
  })
  closers.push(async () => { await svc.close(); await service.release() })
  return svc.endpoint
}

const post = (url: string, body: unknown) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-orchestra-secret': SECRET },
  body: JSON.stringify(body),
})

const doc = {
  name: '发布流程',
  nodes: [
    { node_id: 't', type: 'trigger', title: '入口', position: { x: 0, y: 0 }, config: {} },
    { node_id: 'a', type: 'agent', title: '执行', position: { x: 100, y: 0 }, config: {} },
  ],
  edges: [{ from: 't', to: 'a' }],
}

describe('工作流命令 HTTP 入口', () => {
  it('S5 生成草稿后须测试同一修订，修改后旧回执不能放行发布', async () => {
    let db!: Db
    const base = await boot('S5', async () => doc, (opened) => { db = opened })
    const generated = await (await post(base + '/v1/workflows/generate', { goal: '发布报告前执行系统核验' })).json() as any
    expect(generated.data.definition).toMatchObject(doc)
    const workflow_id = 'workflow-test-gate'
    const created = await post(base + '/v1/workflows', {
      workflow_id, name: doc.name, definition: generated.data.definition, operation_id: uuidv7(),
    })
    expect(created.status).toBe(200)
    const submit = (revision: number, base_version = 0) => post(base + '/v1/workflows/publish', {
      workflow_id, revision, base_version, publish_note: '发布说明', operation_id: uuidv7(),
    })
    expect((await submit(1)).status).toBe(428)
    const test = async (revision: number) => (await (await post(base + '/v1/workflows/test', { workflow_id, revision })).json() as any).data
    expect(await test(1)).toMatchObject({ revision: 1, passed: true, order: [{ node_id: 't' }, { node_id: 'a' }] })
    const changed = await post(base + '/v1/workflows/update', {
      workflow_id, revision: 1, operation_id: uuidv7(),
      definition: { ...doc, nodes: doc.nodes.map((node) => node.node_id === 'a' ? { ...node, title: '执行核验' } : node) },
    })
    expect(changed.status).toBe(200)
    expect((await submit(2)).status).toBe(428)
    expect(await test(2)).toMatchObject({ revision: 2, passed: true })
    expect((await submit(2)).status).toBe(200)
    expect(getWorkflowSnapshot(db, workflow_id).item.recent_tests).toMatchObject([
      { revision: 2, passed: true },
      { revision: 1, passed: true },
    ])

    const started = await post(base + '/v1/runs/start', {
      operationId: uuidv7(), taskTitle: '待审批任务', workflowId: workflow_id, workflowVersion: '1',
    })
    const run = await started.json() as { data: { run_id: string } }
    expect(started.status).toBe(200)
    db.raw.prepare(`INSERT INTO decisions (decision_id,run_id,kind,status,revision,payload_json,created_at,priority)
      VALUES ('approval-critical',?,'pre_execution','pending',1,'{}',?,'critical')`).run(run.data.run_id, NOW)
    const opened = await post(base + '/v1/workflows/open-draft', { workflow_id, base_version: 1, operation_id: uuidv7() })
    expect(opened.status).toBe(200)
    expect(await test(3)).toMatchObject({ revision: 3, passed: true })
    const blocked = await submit(3, 1)
    expect(blocked.status).toBe(428)
    expect(await blocked.json()).toMatchObject({ error: { details: { critical_approval_count: 1 } } })
    db.raw.prepare("UPDATE decisions SET status='resolved' WHERE decision_id='approval-critical'").run()
    expect((await submit(3, 1)).status).toBe(200)

    const disable = { workflow_id, expected_status: 'active', status: 'disabled', operation_id: uuidv7() }
    const changeStatus = (body: unknown) => post(base + '/v1/workflows/status', body)
    expect(await (await changeStatus(disable)).json()).toMatchObject({ data: { status: 'disabled', replayed: false } })
    expect(await (await changeStatus(disable)).json()).toMatchObject({ data: { status: 'disabled', replayed: true } })
    expect((await changeStatus({ ...disable, operation_id: uuidv7() })).status).toBe(409)
    const startNew = () => post(base + '/v1/runs/start', {
      operationId: uuidv7(), taskTitle: '新任务', workflowId: workflow_id, workflowVersion: '2',
    })
    expect((await startNew()).status).toBe(403)
    expect(db.raw.prepare('SELECT status FROM runs WHERE run_id=?').get(run.data.run_id)).toMatchObject({ status: 'running' })
    expect(getWorkflowSnapshot(db, workflow_id).item.workflow.status).toBe('disabled')
    expect((await changeStatus({ ...disable, expected_status: 'disabled', status: 'active', operation_id: uuidv7() })).status).toBe(200)
    expect((await startNew()).status).toBe(200)
  })
  it('缺 operation_id 直接 400：写命令一律要走幂等协议', async () => {
    const base = await boot()
    const res = await post(base + '/v1/workflows', {
      workflow_id: 'wf1', name: '发布流程', definition: doc, now: NOW,
    })
    expect(res.status).toBe(400)
  })

  it('create → publish → 重放：版本只出一个，回执标记 replayed', async () => {
    const base = await boot()
    const created = await post(base + '/v1/workflows', {
      operation_id: '422ec715-445d-7537-8b4c-56c2a732005f', workflow_id: 'wf1', name: '发布流程', definition: doc,
    })
    expect(created.status).toBe(200)
    const createdBody = await created.json() as any
    expect(createdBody.data).toMatchObject({ workflow_id: 'wf1', revision: 1, replayed: false })

    const published = await post(base + '/v1/workflows/publish', {
      operation_id: 'eb1db924-210b-7303-8894-dfc43fc7e922', workflow_id: 'wf1', revision: 1, base_version: 0, publish_note: '首次发布',
    })
    expect(published.status).toBe(200)
    const publishedBody = await published.json() as any
    expect(publishedBody.data).toMatchObject({ version: '1', replayed: false })

    const replay = await post(base + '/v1/workflows/publish', {
      operation_id: 'eb1db924-210b-7303-8894-dfc43fc7e922', workflow_id: 'wf1', revision: 1, base_version: 0, publish_note: '首次发布',
    })
    expect(replay.status).toBe(200)
    const replayBody = await replay.json() as any
    expect(replayBody.data).toMatchObject({ version: '1', replayed: true })

    const list = await fetch(base + '/v1/workflows', { headers: { 'x-orchestra-secret': SECRET } })
    const listBody = await list.json() as any
    expect(listBody.data.items).toHaveLength(1)
    expect(listBody.data.items[0]).toMatchObject({ workflow_id: 'wf1', current_version: '1' })
  })

  it('publish_note 必填；S2 阶段发布被拒（workflow_publish 从 S4 起）', async () => {
    const base = await boot('S2')
    await post(base + '/v1/workflows', {
      operation_id: '3fa50663-2dc0-7a50-804e-99b6b859e300', workflow_id: 'wf3', name: '发布流程', definition: doc,
    })
    const noNote = await post(base + '/v1/workflows/publish', {
      operation_id: '71e71ea3-12df-775e-8a77-1e0bff94e141', workflow_id: 'wf3', revision: 1, base_version: 0,
    })
    expect(noNote.status).toBe(400)
    const gated = await post(base + '/v1/workflows/publish', {
      operation_id: 'af1e9539-db57-7ad9-86a2-72376e6d37bd', workflow_id: 'wf3', revision: 1, base_version: 0, publish_note: '首次发布',
    })
    expect(gated.status).toBe(403)
    const body = await gated.json() as any
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('HTTP 建 task_local 必失败：owner 不接受自报；UUIDv4 一律 400', async () => {
    const base = await boot()
    // 合法 UUIDv7 + 缺 owner：到 createWorkflow 才被拒，证明的是 owner 约束而不是 id 格式
    const noOwner = await post(base + '/v1/workflows', {
      operation_id: '3f2c9a7e-5b41-7c8d-9e0f-1a2b3c4d5e6f', workflow_id: 'wf_scope', name: '发布流程',
      definition: doc, scope: 'task_local',
    })
    expect(noOwner.status).toBe(422)
    // 即使在 body 里塞 owner_task_id 也不会被采信（schema 已删除该字段）
    const selfClaimed = await post(base + '/v1/workflows', {
      operation_id: '4a3d8b6f-6c52-7d9e-8f1a-2b3c4d5e6f70', workflow_id: 'wf_scope2', name: '发布流程',
      definition: doc, scope: 'task_local', owner_task_id: 'task_1',
    })
    expect(selfClaimed.status).toBe(422)
    const v4 = await post(base + '/v1/workflows', {
      operation_id: '018f0c1a-2b3c-4d4e-8f5a-6b7c8d9e0f11', workflow_id: 'wf_v4', name: '发布流程', definition: doc,
    })
    expect(v4.status).toBe(400)
  })

  it('HTTP 链路：预留 task → 发布 → /v1/runs/start 绑定预留任务', async () => {
    const base = await boot()
    const reservedRes = await post(base + '/v1/tasks/reserve', {
      operation_id: '5b4e9c7d-7d63-7eaf-9a2b-3c4d5e6f7081', title: '预留任务',
    })
    expect(reservedRes.status).toBe(200)
    const reserved = (await reservedRes.json() as any).data as { task_id: string }

    await post(base + '/v1/workflows', {
      operation_id: '5b4e9c7d-7d63-7eaf-9a2b-3c4d5e6f7082', workflow_id: 'wf_bind', name: '发布流程', definition: doc,
    })
    const published = await post(base + '/v1/workflows/publish', {
      operation_id: '5b4e9c7d-7d63-7eaf-9a2b-3c4d5e6f7083', workflow_id: 'wf_bind', revision: 1, base_version: 0, publish_note: '首次发布',
    })
    expect(published.status).toBe(200)

    const started = await post(base + '/v1/runs/start', {
      operationId: '5b4e9c7d-7d63-7eaf-9a2b-3c4d5e6f7084', task_id: reserved.task_id,
      taskTitle: '绑定预留', workflowId: 'wf_bind', workflowVersion: '1',
    })
    const body = await started.json() as any
    expect(started.status, JSON.stringify(body)).toBe(200)
    expect(body.data.task_id).toBe(reserved.task_id)
  })

  it('发布层不通过：422 + 未注册节点清单', async () => {
    const base = await boot()
    await post(base + '/v1/workflows', {
      operation_id: 'fbfd1831-cb33-738b-870a-08cb30c62889', workflow_id: 'wf2', name: '带分支',
      definition: {
        name: '带分支',
        nodes: [
          { node_id: 't', type: 'trigger', title: '入口', position: { x: 0, y: 0 }, config: {} },
          { node_id: 'b', type: 'branch', title: '分支', position: { x: 1, y: 0 }, config: {} },
        ],
        edges: [{ from: 't', to: 'b' }],
      },
    })
    const res = await post(base + '/v1/workflows/publish', {
      operation_id: '34f4ad55-e36d-7bb8-89f6-f59331c7a196', workflow_id: 'wf2', revision: 1, base_version: 0, publish_note: '首次发布',
    })
    expect(res.status).toBe(422)
    const body = await res.json() as any
    expect(body.error.code).toBe('WORKFLOW_VALIDATION_FAILED')
    expect(body.error.details.errors.some((e: { code: string }) => e.code === 'NODE_NOT_SUPPORTED')).toBe(true)
  })
})
