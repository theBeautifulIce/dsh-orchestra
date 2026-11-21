import { expect } from 'vitest'
import { uuidv7 } from '../../src/core/ids.ts'
import type { WorkflowDoc } from '../../src/core/workflow-doc.ts'

type Request = (path: string, body?: object) => Promise<any>
export const recoveryWorkflowId = 'wf-recovery-guard'

export function recoveryWorkflowDoc(nodeId: string, permission?: boolean): WorkflowDoc {
  return {
    name: '恢复重试流程',
    nodes: [
      { node_id: 'trigger', type: 'trigger', title: '入口', position: { x: 0, y: 0 } },
      { node_id: nodeId, type: 'agent', title: '执行', position: { x: 160, y: 0 },
        ...(permission === undefined ? {} : { config: { recovery_retry_idempotent: permission } }) },
    ],
    edges: [{ from: 'trigger', to: nodeId }],
  }
}

export async function publishRecoveryWorkflow(request: Request, definition: WorkflowDoc, baseVersion = 0): Promise<string> {
  const workflow_id = recoveryWorkflowId
  let revision = 1
  if (baseVersion === 0) {
    expect(await request('/v1/workflows', { workflow_id, name: definition.name, definition, operation_id: uuidv7() })).toMatchObject({ ok: true })
  } else {
    const opened = await request('/v1/workflows/open-draft', { workflow_id, base_version: baseVersion, operation_id: uuidv7() })
    expect(opened).toMatchObject({ ok: true })
    const updated = await request('/v1/workflows/update', {
      workflow_id, revision: opened.data.revision, definition, operation_id: uuidv7(),
    })
    expect(updated).toMatchObject({ ok: true })
    revision = updated.data.revision
  }
  expect(await request('/v1/workflows/test', { workflow_id, revision })).toMatchObject({ data: { passed: true } })
  const published = await request('/v1/workflows/publish', {
    workflow_id, revision, base_version: baseVersion, publish_note: '发布恢复重试策略', operation_id: uuidv7(),
  })
  expect(published).toMatchObject({ ok: true, data: { version: String(baseVersion + 1), definition_hash: expect.any(String) } })
  return published.data.definition_hash
}
