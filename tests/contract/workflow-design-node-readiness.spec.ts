import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra } from '../../src/index.ts'
import { uuidv7 } from '../../src/core/ids.ts'

it('S6 通用流程拒绝发布缺少固定汇合策略的并行组', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-design-node-readiness-'))
  const secret = 'fixture-workflow-design-node-readiness'
  const service = await serveOrchestra({
    dbFile: join(dir, 'orchestra.db'), phase: 'S6', secret,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
  })
  try {
    const post = (path: string, body: unknown) => fetch(service.endpoint + path, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-orchestra-secret': secret },
    })
    const workflow_id = 'acceptance_invalid_parallel'
    const name = '独立节点发布能力核对'
    const definition = {
      name,
      nodes: [
        { node_id: 'start', type: 'trigger', title: '开始', position: { x: 0, y: 0 } },
        { node_id: 'candidate', type: 'parallel', title: '待核对', position: { x: 100, y: 0 } },
        { node_id: 'end', type: 'agent', title: '执行', position: { x: 200, y: 0 } },
      ],
      edges: [
        { from: 'start', to: 'candidate' },
        { from: 'candidate', to: 'end' },
      ],
    }
    expect((await post('/v1/workflows', { operation_id: uuidv7(), workflow_id, name, definition })).status).toBe(200)

    const rehearsal = await post('/v1/workflows/test', { workflow_id, revision: 1 })
    expect(rehearsal.status).toBe(200)
    const issues = [expect.objectContaining({ path: '/nodes/1/config', code: 'WORKFLOW_NODE_CONFIG_INVALID' })]
    expect(await rehearsal.json()).toMatchObject({ data: { revision: 1, passed: false, issues: { errors: issues }, order: [] } })

    const published = await post('/v1/workflows/publish', {
      operation_id: uuidv7(), workflow_id, revision: 1, base_version: 0, publish_note: '逐类验收',
    })
    expect(published.status).toBe(422)
    expect(await published.json()).toMatchObject({ error: { code: 'WORKFLOW_VALIDATION_FAILED', details: { errors: issues } } })
    expect(service.orchestra.db.raw.prepare('SELECT COUNT(*) AS count FROM workflow_versions WHERE workflow_id=?')
      .get(workflow_id)).toMatchObject({ count: 0 })
  } finally {
    await service.close()
    await rm(dir, { recursive: true, force: true })
  }
})
