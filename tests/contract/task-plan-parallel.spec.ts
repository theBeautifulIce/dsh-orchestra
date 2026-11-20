import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra } from '../../src/index.ts'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { createTaskCommands } from '../../src/client/api/task-commands.ts'
import { BridgeClient, type SpawnParams } from '../../src/executor/bridge.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { sha256Hex } from '../../src/core/canonical.ts'
import { raiseReportContradiction } from '../../src/service/commands/apply-report.ts'
import { loadNodeRun } from '../../src/service/commands/lease.ts'
import { acquireNodeRun, submitReport } from '../../src/service/commands/runtime.ts'
import { failQueuedNode } from '../../src/service/dispatcher.ts'
import { callDshRework } from '../../src/service/dsh-rework.ts'
import { registerRunArtifact } from '../../src/service/artifact-store.ts'
import { verifyArtifactCompletion } from '../../src/service/artifact-completion.ts'
import { readOutstandingFiles } from '../../src/service/chat-expected-files.ts'
import { fakeAgentBridge } from '../fixtures/agent-bridge.ts'

const roles = ['目录', '链接', '术语', '日期', '引用', '数字', '格式', '附件', '重复项', '缺失项']
const allBranchIds = roles.map((_, i) => 'review_' + (i + 1))
const allNames = roles.map((role) => role + '核对')
const descriptor = { name: 'ro.check', capability: 'read_only' as const, command: { bin: 'check', args: [] } }
const goal = '分别核对十类交付内容，然后汇总审核结论'

it.each(['完成', '纯成果', '合流有工具权限但仅验收成果', '成果门槛', '取消', '重启与重试', '分支失败', '部分汇合'] as const)('具名分支共享一个运行与并发上限：%s', async (scenario) => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-parallel-plan-'))
  const secret = 'parallel-plan-contract-secret'
  const registry = new ToolRegistry()
  const partialJoin = scenario === '部分汇合'
  const branchIds = partialJoin ? allBranchIds.slice(0, 4) : allBranchIds
  const names = partialJoin ? allNames.slice(0, 4) : allNames
  const joinSources = partialJoin ? branchIds.slice(0, 2) : branchIds
  const joinAllowsTool = scenario === '合流有工具权限但仅验收成果'
  const outputOnly = partialJoin || scenario === '纯成果' || joinAllowsTool || scenario === '成果门槛' || scenario === '重启与重试'
  const blockedOutputs = scenario === '成果门槛'
  const toolsFor = (nodeId: string) => !outputOnly || (blockedOutputs && nodeId === branchIds[4]) ? [descriptor.name] : []
  if (!outputOnly || blockedOutputs || joinAllowsTool) registry.register(descriptor)
  const agents = new Map<string, ReturnType<typeof fakeAgentBridge>>()
  const spawned: SpawnParams[] = []
  const joinTexts: string[] = []
  const releaseInitialBranches = Promise.withResolvers<void>()
  const releaseIndependentBranches = Promise.withResolvers<void>()
  const releaseJoin = Promise.withResolvers<void>()
  const stepOf = (entry: SpawnParams) => (entry.input as { step: string }).step
  const bridge = new BridgeClient({
    async request<T>(method: string, params: unknown): Promise<T> {
      if (method === 'executor.spawn') {
        const input = params as SpawnParams
        const agentId = 'agent_' + input.nodeRunId
        spawned.push(input)
        if (scenario === '重启与重试' && stepOf(input) === names.at(-1) && input.attempt === 1) {
          throw new Error('宿主在确认分支启动前失联')
        }
        agents.set(agentId, fakeAgentBridge({ agentId, steps: outputOnly ? [] : [{ tool: descriptor.name }],
          report: { status: 'done', output: { summary: '自报已完成' } }, at: new Date().toISOString() }))
        return agents.get(agentId)!.request<T>(method, params)
      }
      const { executorAgentId } = params as { executorAgentId: string }
      const agent = agents.get(executorAgentId)!
      if (method === 'executor.send' && (scenario === '完成' || outputOnly)) {
        const input = spawned.find((entry) => 'agent_' + entry.nodeRunId === executorAgentId)!
        const db = service.orchestra.db
        const node = withTx(db, (tx) => loadNodeRun(tx, input.nodeRunId))
        const binding = { node_run_id: input.nodeRunId, attempt: input.attempt, action_generation: node.action_generation }
        const role = stepOf(input)
        const publish = (name: string, body: string, owner = binding) => callDshRework(db, service.rework!, owner, {
          action: 'publish', operation_id: uuidv7(), file_name: name + '.txt', text: body,
        }, undefined, secret) as { artifact_id: string }
        if (role === '汇总审核') {
          const refs = db.raw.prepare('SELECT artifact_id,artifact_hash FROM artifact_consumptions WHERE consumer_node_run_id=?').all(input.nodeRunId)
          for (const ref of refs) {
            const result = callDshRework(db, service.rework!, binding, { action: 'read', ...ref }) as { text: string }
            joinTexts.push(result.text)
          }
          if (outputOnly) {
            publish(role, joinTexts.join('\n'))
          }
        } else if (!blockedOutputs) {
          publish(role, role + '完成')
          if (scenario === '纯成果' && role === names[0]) {
            withTx(db, (tx) => {
              const verifying = { ...node, status: 'verifying' }
              expect(verifyArtifactCompletion(tx, secret, verifying, new Date().toISOString())).not.toBeNull()
              expect(verifyArtifactCompletion(tx, secret, { ...verifying, attempt: verifying.attempt + 1 }, new Date().toISOString())).toBeNull()
            })
            const reportId = 'external-done-' + node.node_run_id
            expect(submitReport(service.orchestra.runtime, { nodeRunId: node.node_run_id, attempt: node.attempt,
              expectedStatus: 'started', generation: node.action_generation, now: new Date().toISOString(),
              report: { report_id: reportId, node_run_id: node.node_run_id, attempt: node.attempt, status: 'done' },
            })).toMatchObject({ accepted: false, reason: 'evidence_missing' })
          }
        } else if (role !== names[6]) {
          const index = names.indexOf(role)
          if (index === 3) {
            const fileName = role + '.txt'
            const text = role + '完成'
            const artifactId = 'out_' + sha256Hex(JSON.stringify([node.node_run_id, fileName]))
            registerRunArtifact(db, { artifactId, runId: node.run_id, nodeRunId: node.node_run_id, fileName, bytes: Buffer.from(text) })
            publish(role, text)
          } else if (index === 2) {
            const old = node.action_generation - 1
            db.raw.prepare('UPDATE node_runs SET action_generation=? WHERE node_run_id=?').run(old, node.node_run_id)
            try { publish(role, role + '完成', { ...binding, action_generation: old }) }
            finally { db.raw.prepare('UPDATE node_runs SET action_generation=? WHERE node_run_id=?').run(node.action_generation, node.node_run_id) }
          } else {
            const { artifact_id } = publish(index === 1 ? names[2]! : role, role + '完成')
            if (index === 0) {
              db.raw.prepare('UPDATE artifacts SET retain_until=? WHERE artifact_id=?').run('2000-01-01T00:00:00.000Z', artifact_id)
            }
            if (index === 5) {
              db.raw.prepare('UPDATE artifact_contents SET bytes=zeroblob(length(bytes)) WHERE artifact_id=?').run(artifact_id)
            }
          }
        }
      }
      return agent.request<T>(method, params)
    },
    async *listen(params, signal) {
      if (scenario === '取消') {
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return
      }
      if (partialJoin) {
        const input = spawned.find((entry) => 'agent_' + entry.nodeRunId === params.executorAgentId)!
        const step = stepOf(input)
        if (step === '汇总审核') await releaseJoin.promise
        else if (names.slice(2).includes(step)) await releaseIndependentBranches.promise
        else await releaseInitialBranches.promise
      } else if (outputOnly) await releaseInitialBranches.promise
      for await (const event of agents.get(params.executorAgentId)!.listen(params, signal)) {
        yield { ...event, attempt: params.attempt }
      }
    },
  })
  const boot = () => serveOrchestra({
    dbFile: join(dir, 'orchestra.db'), secret, phase: 'S6',
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'e' }),
    executor: { registry, bridge, runner: new ReadOnlyToolRunner(registry, {
      readonlyAvailable: () => true,
      run: async () => {
        await releaseInitialBranches.promise
        return { exitCode: 0, stdout: '核对完成', stderr: '' }
      },
    }, dir) },
    workflowGenerator: async (input) => {
      expect(input.goal).toBe(goal)
      const node = (node_id: string, title: string, x: number, y: number) => ({
        node_id, title, type: 'agent', position: { x, y },
        config: { tools: { allow: joinAllowsTool && node_id === 'join_review' ? [descriptor.name] : toolsFor(node_id) } },
      })
      return { name: '交付审核', nodes: [
        { node_id: 'start', title: '开始', type: 'trigger', position: { x: 0, y: 0 } },
        ...branchIds.map((id, i) => node(id, names[i]!, 200, 100 * i - 100)),
        node('join_review', '汇总审核', 600, 450),
      ], edges: [
        ...branchIds.map((id) => ({ from: 'start', to: id })),
        ...joinSources.map((id) => ({ from: id, to: 'join_review' })),
      ] }
    },
    planning: { propose: async ({ workflows }) => {
      const [workflow] = workflows
      expect(workflow?.nodes.map((node) => node.dependsOn)).toEqual([...branchIds.map(() => []), joinSources])
      if (joinAllowsTool) expect(workflow?.nodes.at(-1)?.toolAllow).toEqual([descriptor.name])
      return {
        title: '交付审核', workflow_id: workflow!.workflowId, workflow_version: workflow!.version,
        steps: workflow!.nodes.map((node) => ({
          node_id: node.id, description: node.title, goal_ids: ['goal'], depends_on: node.dependsOn,
          tools: toolsFor(node.id), complexity: 'routine', model_reason: '按检查项核对',
        })),
        deliverables: outputOnly ? [...workflow!.nodes.map((node) => ({
          title: node.title, node_id: node.id, goal_ids: ['goal'],
          acceptance: { kind: 'artifact', file_name: node.title + '.txt', minimum_bytes: 8 },
        })), ...(blockedOutputs ? [{ title: '真实工具证据', node_id: branchIds[4], goal_ids: ['goal'],
          acceptance: { kind: 'tool_evidence', tool: descriptor.name, exit_code: 0 } }] : [])] : [{ title: '审核结果', node_id: 'join_review', goal_ids: ['goal'],
          acceptance: { kind: 'tool_evidence', tool: descriptor.name, exit_code: 0 } }],
        risks: [],
      }
    } },
  })
  let service = await boot()
  function connect() {
    const api = createApiClient(service.endpoint, (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('x-orchestra-secret', secret)
      return fetch(input, { ...init, headers })
    })
    return { api, reads: createResourcesApi(api) }
  }
  try {
    const connection = connect()
    const api = connection.api
    let reads = connection.reads
    const plans = createTaskCommands(api)
    const plan = await plans.proposeTaskPlan(goal, [])
    expect(plan.quality.ready).toBe(true)
    const { run_id } = await plans.confirmTaskPlan(plan.plan_id, plan.content_hash)
    const nodes = async () => (await reads.listNodes(run_id)).data.items
    await expect.poll(async () => (await nodes()).filter((node) => node.execution_state === 'started').length,
      { timeout: 6_000 }).toBe(3)
    const inProgress = await nodes()
    expect(inProgress).toHaveLength(branchIds.length + 1)
    if (scenario === '完成') {
      expect((await reads.listNodes(run_id, 10)).data).toMatchObject({ has_more: true })
      expect((await reads.listNodes(run_id, 11)).data).toMatchObject({ has_more: false })
    }
    expect(inProgress.filter((node) => node.execution_state === 'waiting_capacity')).toHaveLength(branchIds.length - 3)
    const joinNode = inProgress.find((node) => node.node_id === 'join_review')!
    expect(joinNode).toMatchObject({
      title: '汇总审核', status: 'queued', execution_state: 'waiting_dependencies', depends_on: joinSources, waiting_on: joinSources,
    })
    expect(inProgress.filter((node) => node.node_id !== 'join_review').map((node) => node.title)).toEqual(names)
    expect(spawned).toHaveLength(3)
    expect(() => acquireNodeRun(service.orchestra.runtime, {
      nodeRunId: joinNode.node_run_id, ownerEpoch: service.orchestra.db.epoch,
      leaseTtlMs: 60_000, now: new Date().toISOString(),
    })).toThrow(expect.objectContaining({ code: 'RESOLUTION_NOT_AVAILABLE' }))

    if (partialJoin) {
      releaseInitialBranches.resolve()
      // 无关分支继续占两个名额。仅完成两条必要上游，汇总必须拿到剩下的名额。
      await expect.poll(async () => (await nodes()).map((node) => [node.node_id, node.status]), { timeout: 6_000 })
        .toEqual([[branchIds[0], 'done'], [branchIds[1], 'done'], [branchIds[2], 'started'], [branchIds[3], 'started'], ['join_review', 'started']])
      expect(spawned.map(stepOf).filter((name) => name === '汇总审核')).toHaveLength(1)
      expect(joinTexts.toSorted()).toEqual(names.slice(0, 2).map((name) => name + '完成').toSorted())
      releaseJoin.resolve()
      await expect.poll(async () => (await nodes()).find((node) => node.node_id === 'join_review')?.status).toBe('done')
      expect((await reads.getRun(run_id)).data.status).toBe('running')
      releaseIndependentBranches.resolve()
      await expect.poll(async () => (await reads.getRun(run_id)).data.status).toBe('succeeded')
      expect(spawned.map(stepOf).toSorted()).toEqual([...names, '汇总审核'].toSorted())
      return
    }

    if (scenario === '取消') {
      const result = await api.post<{ terminalStatus: string | null }>('/v1/runs/cancel', {
        runId: run_id, cancelResult: 'interrupted', graceMs: 5_000,
      })
      expect(result.data.terminalStatus).toBeNull()
      await expect.poll(() => [...agents.values()].every((agent) => agent.cancelled)).toBe(true)
      releaseInitialBranches.resolve()
      await expect.poll(() => [...agents.values()].every((agent) => agent.disposed)).toBe(true)
      await expect.poll(async () => (await reads.getRun(run_id)).data.status, { timeout: 8_000 }).toBe('cancelled')
      expect(spawned).toHaveLength(3)
      const cancelled = (await nodes()).filter((node) => node.status === 'superseded')
      expect(cancelled).toHaveLength(8)
      expect(cancelled.every((node) => node.execution_state === 'cancelled' && node.status_label === '已取消')).toBe(true)
      expect((await nodes()).filter((node) => node.status === 'timeout')).toHaveLength(3)
      return
    }
    if (scenario === '分支失败') {
      const branch = inProgress.find((node) => node.node_id === branchIds.at(-1))!
      expect(branch.execution_state).toBe('waiting_capacity')
      expect(failQueuedNode({ db: service.orchestra.db, secret }, { runId: run_id, nodes: {}, now: new Date().toISOString() },
        branch, '分支执行配置失效', 'RUN_TOOL_NOT_READ_ONLY')).toEqual({ kind: 'applied' })
      releaseInitialBranches.resolve()
      await expect.poll(async () => (await reads.getRun(run_id)).data.status, { timeout: 8_000 }).toBe('failed')
      expect((await nodes()).filter((node) => node.status === 'done')).toHaveLength(9)
      expect((await nodes()).find((node) => node.node_id === 'join_review')?.status).toBe('failed')
      expect(spawned.map(stepOf).toSorted()).toEqual(names.slice(0, -1).toSorted())
      return
    }

    releaseInitialBranches.resolve()
    if (blockedOutputs) {
      const blockedIds = branchIds.slice(0, 7)
      await expect.poll(async () => {
        const current = await nodes()
        return {
          blocked: current.filter((node) => node.status === 'blocked_post').map((node) => node.node_id),
          done: current.filter((node) => node.status === 'done').length,
        }
      }, { timeout: 8_000 }).toEqual({ blocked: blockedIds, done: 3 })
      const current = await nodes()
      expect(current.find((node) => node.node_id === 'join_review')).toMatchObject({
        status: 'queued', execution_state: 'waiting_dependencies', waiting_on: blockedIds,
      })
      const sql = service.orchestra.db.raw
      expect(sql.prepare(`SELECT COUNT(*) AS n FROM node_run_events WHERE type='report_rejected'
        AND json_extract(payload,'$.reason')='evidence_missing'`).get()).toEqual({ n: blockedIds.length })
      const missing = readOutstandingFiles(service.orchestra.db, run_id)
      const forBranch = (i: number) => missing.find((record) =>
        current.find((node) => node.node_id === branchIds[i])?.node_run_id === record.node_run_id)?.file_names
      expect(forBranch(1)).toEqual([names[1] + '.txt'])
      expect(forBranch(2)).toEqual([names[2] + '.txt'])
      // Expired or corrupt submissions still exist. Do not describe those files as never submitted.
      expect(forBranch(0)).toBeUndefined()
      expect(forBranch(5)).toBeUndefined()
      expect(readOutstandingFiles(service.orchestra.db, 'another-run')).toEqual([])
      expect(spawned.map(stepOf).toSorted()).toEqual(names.toSorted())
      return
    }
    if (scenario === '重启与重试') {
      await expect.poll(async () => (await nodes()).filter((node) => node.status === 'done').length,
        { timeout: 8_000 }).toBe(9)
      const uncertain = (await nodes()).find((node) => node.node_id === branchIds.at(-1))!
      expect(uncertain).toMatchObject({ status: 'startup_unknown', execution_state: 'startup_unknown', attempt: 1 })
      expect((await nodes()).find((node) => node.node_id === 'join_review')?.waiting_on).toEqual([uncertain.node_id])
      await service.close()
      service = await boot()
      reads = connect().reads
      expect((await nodes()).find((node) => node.node_id === 'join_review')?.execution_state).toBe('waiting_dependencies')

      const now = new Date().toISOString()
      const reportId = 'uncertain-branch-report'
      const { decisionId } = withTx(service.orchestra.db, (tx) => raiseReportContradiction(tx, secret, {
        nodeRunId: uncertain.node_run_id, runId: run_id, attempt: 1, reportId, now,
      }))
      const decision = service.orchestra.db.raw.prepare('SELECT revision FROM decisions WHERE decision_id=?').get(decisionId) as { revision: number }
      const result = submitReport(service.orchestra.runtime, {
        nodeRunId: uncertain.node_run_id, attempt: 1, expectedStatus: 'startup_unknown', generation: 1, now,
        report: { report_id: reportId, node_run_id: uncertain.node_run_id, attempt: 1, status: 'done' },
        decision: { decisionId, revision: decision.revision, resolution: 'uphold_decision' },
      })
      expect(result.next_status).toBe('superseded')
      await expect.poll(async () => (await nodes()).find((node) => node.node_id === 'join_review')?.status,
        { timeout: 10_000 }).toBe('done')
      expect((await nodes()).filter((node) => node.node_id === uncertain.node_id)).toMatchObject([
        { attempt: 1, status: 'superseded', execution_state: 'superseded', status_label: '已由新尝试接替' }, { attempt: 2, status: 'done' },
      ])
      expect(spawned.map(stepOf).filter((step) => step === names.at(-1))).toHaveLength(2)
      expect(joinTexts.toSorted()).toEqual(names.map((name) => name + '完成').toSorted())
      await expect.poll(async () => (await reads.getRun(run_id)).data.status).toBe('succeeded')
    } else {
      await expect.poll(async () => (await reads.getRun(run_id)).data.status, { timeout: 10_000 }).toBe('succeeded')
      expect((await nodes()).every((node) => node.status === 'done' && node.attempt === 1)).toBe(true)
      expect(joinTexts.toSorted()).toEqual(names.map((name) => name + '完成').toSorted())
      if (outputOnly) {
        const sql = service.orchestra.db.raw
        expect(sql.prepare('SELECT COUNT(*) AS n FROM tool_executions').get()).toEqual({ n: 0 })
        expect(sql.prepare(`SELECT COUNT(*) AS n FROM node_run_events WHERE type='report_applied'
          AND json_extract(payload,'$.artifact_proof.source')='artifact.published_for_attempt'`).get()).toEqual({ n: 11 })
        expect(sql.prepare("SELECT COUNT(*) AS n FROM run_acceptance_results WHERE outcome='passed'").get()).toEqual({ n: 11 })
      }
    }
    const seenInputs = spawned.map(stepOf)
    const expectedInputs = [...names, '汇总审核', ...(scenario === '重启与重试' ? [names.at(-1)!] : [])]
    expect(seenInputs.toSorted()).toEqual(expectedInputs.toSorted())
    expect(seenInputs.at(-1)).toBe('汇总审核')
    expect(service.orchestra.db.raw.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 })
    expect(service.orchestra.db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 })
  } finally {
    releaseInitialBranches.resolve()
    releaseIndependentBranches.resolve()
    releaseJoin.resolve()
    await service.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 20_000)
