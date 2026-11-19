// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createApiClient, type ApiEnvelope } from '../../src/client/api/client.ts'
import type { MemoryRecoveryView } from '../../src/client/api/memory-recovery.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { PanelApp } from '../../src/client/panel/app.tsx'
import { renderPanel, type PanelView } from './harness.ts'

type RecoveryContext = {
  endpoint: string
  secret: string
  runId: string
  batchId: string
  nodeRunId: string
}

type RecoveryProof = MemoryRecoveryView & { node_run_id: string; attempt: number }
type RecoveryResult = { batch_id: string; status: string; replacement_node_run_id: string | null; abandon_ack_id: string | null }
type RecoveryExchange = {
  path: string
  body: Record<string, unknown>
  httpStatus: number
  reply: ApiEnvelope<RecoveryProof | RecoveryResult>
}

function availableButton(view: PanelView, text: string) {
  const buttons = Array.from(view.container.querySelectorAll('button')).filter(button => button.textContent?.trim() === text)
  expect(buttons).toHaveLength(1)
  expect(buttons[0]?.disabled).toBe(false)
  expect(view.byRole('alert')).toHaveLength(0)
  return buttons[0]!
}

async function waitForPanel<T>(view: PanelView, check: () => T): Promise<T> {
  return vi.waitFor(async () => {
    await view.flush()
    return check()
  }, { timeout: 5000 })
}

function proofSummary(proof: RecoveryProof) {
  const { batch_id, node_run_id, attempt, decision_id, revision, evidence_id, stopped_at, allowed_resolutions, written_count, missing_count } = proof
  return { batch_id, node_run_id, attempt, decision_id, revision, evidence_id, stopped_at, allowed_resolutions, written_count, missing_count }
}

// The real-plugin probe supplies a running HTTP service and the IDs of its isolated partial-write case.
const context = process.env.G5_MEMORY_PANEL_CONTEXT
it.skipIf(!context)('Q-63 drives the real memory recovery panel for the same partial-write attempt', async () => {
  const { endpoint, secret, runId, batchId, nodeRunId } = JSON.parse(context!) as RecoveryContext
  expect(['127.0.0.1', '[::1]', 'localhost']).toContain(new URL(endpoint).hostname)
  expect([secret, runId, batchId, nodeRunId].every(Boolean)).toBe(true)

  const exchanges: RecoveryExchange[] = []
  const client = createApiClient(endpoint, async (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('x-orchestra-secret', secret)
    const response = await fetch(input, { ...init, headers })
    const { pathname: path } = new URL(String(input))
    if (init?.method === 'POST' && path.startsWith('/v1/memory/recovery/')) {
      exchanges.push({ path, body: JSON.parse(String(init.body)), httpStatus: response.status, reply: await response.clone().json() })
    }
    return response
  })
  const api = createResourcesApi(client)
  const batches = (await api.listMemoryBatches({})).data.items
  expect(batches.filter(batch => batch.recovery_available).map(batch => batch.batch_id)).toEqual([batchId])
  expect(batches.find(batch => batch.batch_id === batchId)).toMatchObject({ status: 'indeterminate', applied_count: 1, total_count: 2 })
  const { data: before } = await api.getNode(nodeRunId)
  expect(before).toMatchObject({ run_id: runId, node_run_id: nodeRunId, node_id: 'mem_apply', status: 'indeterminate_side_effect' })

  const view = await renderPanel(<PanelApp client={client} serviceConnected memoryEnabled initialRoute="memory" />)
  try {
    const inspectLabel = '核对记忆写入'
    const abandonLabel = '放弃这次写入'
    const acknowledgeLabel = '签认并结束'
    const recoveryCopy = '已写入 1 条，未写入 1 条。'
    const waitingCopy = await waitForPanel(view, () => {
      const text = view.container.querySelector('[aria-labelledby="memory-q3-title"]')?.textContent
      expect(text).toContain('写到一半，等你确认')
      availableButton(view, inspectLabel)
      return text
    })
    await view.click(availableButton(view, inspectLabel))
    const abandon = await waitForPanel(view, () => {
      expect(view.text()).toContain(recoveryCopy)
      return availableButton(view, abandonLabel)
    })
    expect(view.findAll('button').map(button => button.textContent?.trim())).not.toContain(acknowledgeLabel)
    await view.click(abandon)
    const abandonedNotice = await waitForPanel(view, () => {
      availableButton(view, inspectLabel)
      const text = view.byRole('status').map(element => element.textContent).find(text => text?.includes('已放弃本次写入，请签认。'))
      expect(text).toBe('已放弃本次写入，请签认。')
      return text
    })
    expect(await api.getRun(runId)).toMatchObject({ data: { run_id: runId, status: 'paused' } })
    await view.click(availableButton(view, inspectLabel))
    await view.click(await waitForPanel(view, () => availableButton(view, acknowledgeLabel)))
    const finalNotice = await waitForPanel(view, () => {
      const text = view.byRole('status').map(element => element.textContent).find(text => text?.includes('已记录恢复决定。'))
      expect(text).toBe('已记录恢复决定。')
      return text
    })

    expect(exchanges.map(exchange => exchange.path)).toEqual([
      '/v1/memory/recovery/inspect', '/v1/memory/recovery/resolve',
      '/v1/memory/recovery/inspect', '/v1/memory/recovery/resolve',
    ])
    for (const exchange of exchanges) expect(exchange).toMatchObject({ body: { batch_id: batchId }, httpStatus: 200, reply: { ok: true } })
    const [firstRead, abandonment, renewedRead, signature] = exchanges
    const first = firstRead!.reply.data as RecoveryProof
    const renewed = renewedRead!.reply.data as RecoveryProof
    const proofIdentity = { batch_id: batchId, node_run_id: nodeRunId, attempt: before.attempt, written_count: 1, missing_count: 1 }
    expect(first).toMatchObject({ ...proofIdentity, allowed_resolutions: ['abandon'] })
    expect(renewed).toMatchObject({
      ...proofIdentity, evidence_id: first.evidence_id, stopped_at: first.stopped_at, allowed_resolutions: ['acknowledge_abandon'],
    })
    expect(first.decision_id).not.toBe(renewed.decision_id)
    expect(abandonment!.reply.data).toMatchObject({
      batch_id: batchId, status: 'abandoned', abandon_ack_id: renewed.decision_id, replacement_node_run_id: null,
    })
    expect(signature!.reply.data).toMatchObject({ batch_id: batchId, status: 'acknowledged', replacement_node_run_id: null })
    for (const [command, signedProof, resolution] of [[abandonment!, first, 'abandon'], [signature!, renewed, 'acknowledge_abandon']] as const) {
      expect(command.body).toMatchObject({
        batch_id: signedProof.batch_id, decision_id: signedProof.decision_id, revision: signedProof.revision,
        stopped_at: signedProof.stopped_at, evidence_id: signedProof.evidence_id,
        resolution, operation_id: expect.any(String),
      })
    }
    expect(abandonment!.body.operation_id).not.toBe(signature!.body.operation_id)

    const { data: run } = await api.getRun(runId)
    expect(run).toMatchObject({ run_id: runId, status: 'succeeded_with_unverified' })
    const { data: nodes } = await api.listNodes(runId)
    expect(nodes.items.filter(node => node.node_id === 'mem_apply')).toEqual([
      expect.objectContaining({ node_run_id: nodeRunId, run_id: runId, attempt: before.attempt, status: 'abandoned_unverified' }),
    ])
    process.stdout.write('G5_MEMORY_PANEL_RESULT ' + JSON.stringify({
      run_id: runId, batch_id: batchId, node_run_id: nodeRunId, attempt: before.attempt,
      waitingCopy, recoveryCopy, abandonedNotice, finalNotice, run_status: run.status,
      inspections: [proofSummary(first), proofSummary(renewed)],
      commands: [abandonment!, signature!].map(({ path, body, httpStatus, reply }) => ({ path, body, httpStatus, as_of_seq: reply.as_of_seq })),
    }) + '\n')
  } finally { view.unmount() }
}, 30000)
