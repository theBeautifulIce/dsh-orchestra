import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openServiceOrchestra } from '../../src/index.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { sha256Hex } from '../../src/core/canonical.ts'
import { RELEASE_CHECK_WORKFLOW_ID, RELEASE_GROUPS, RELEASE_WORKFLOW_ID, judgeReleaseEvidence, releaseHash, type ReleaseGroup } from '../../src/core/wf-release-v1.ts'
import { BridgeClient } from '../../src/executor/bridge.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { prepareReleasePair, readReleaseRunSnapshot } from '../../src/service/release-gate.ts'
import { releaseDefinitionHash } from '../../src/service/release-workflow.ts'
import { fakeAgentBridge, type FakeAgentBridge } from '../fixtures/agent-bridge.ts'
import { releaseEvidenceFixture } from '../fixtures/release-evidence.ts'

it.each([false, true])('executes the six fixed groups through the registered production tool and fails closed on changed bytes=%s', async (mutated) => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-release-fixture-'))
  const evidence = releaseEvidenceFixture()
  const registry = new ToolRegistry()
  registry.register({ name: RELEASE_CHECK_WORKFLOW_ID, capability: 'read_only', command: { bin: 'fixture-gate-read', args: ['fixture'] } })
  const agents = new Map<string, FakeAgentBridge>()
  const spawned = new Set<string>()
  const bridge = new BridgeClient({
    request: <T>(method: string, params: unknown) => agents.get((params as { executorAgentId: string }).executorAgentId)!.request<T>(method, params),
    listen: (params, signal) => agents.get(params.executorAgentId)!.listen(params, signal),
  })
  const startToken = Symbol()
  const approvalToken = Symbol()
  const date = () => new Date().toISOString()
  const directory = Object.fromEntries(Object.keys(RELEASE_GROUPS).map((group) => {
    const cwd = join(dir, group)
    mkdirSync(cwd)
    return [group, cwd]
  })) as Record<ReleaseGroup, string>
  const service = await openServiceOrchestra({ dbFile: join(dir, 'test.db'), phase: 'S6', secret: 'fixture-only-secret',
    executor: { bridge, registry, runner: new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true,
      run: async ({ bin, args }) => {
        expect([bin, ...args]).toEqual(['fixture-gate-read', 'fixture'])
        return { exitCode: 0, stdout: 'fixture evidence successfully checked', stderr: '' }
      },
    }, dir), agents: { async create({ nodeRunId, toolPolicy }) {
      const agentId = uuidv7()
      spawned.add(nodeRunId)
      agents.set(agentId, fakeAgentBridge({ agentId, steps: [{ tool: RELEASE_CHECK_WORKFLOW_ID,
        cwd: (toolPolicy as { releaseCheckCwd?: string }).releaseCheckCwd }] }))
      return { agentId, sessionId: agentId }
    } } },
    release: {
      checkDirectories: directory,
      authorizeStart: (credential) => credential === startToken ? 'human:fixture-release-owner' : undefined,
      frozenEvidence: () => ({ manifest: evidence.manifest, reader: evidence.reader() }),
      verifyGroup: ({ execution, candidate_hash }) => execution.stdout_hash === sha256Hex('fixture evidence successfully checked')
        && candidate_hash === releaseHash(evidence.manifest.candidate),
      verifyApproval: (credential) => credential === approvalToken
        ? { principal: 'human:fixture-approver', approval_id: 'first', confirmation_id: 'second',
          confirmed_at: date(), expires_at: new Date(Date.now() + 60_000).toISOString() }
        : undefined,
    },
  })
  try {
    const { release, db, commands } = service.orchestra
    const host = release!
    const startBody = { operation_id: uuidv7() }
    expect(() => host.start(startBody, { actor: 'human:forged' }, date())).toThrow(/未认证/)
    expect(() => commands.startRun!({ workflowId: RELEASE_WORKFLOW_ID, workflowVersion: '1', taskTitle: 'bad', now: date(), operationId: uuidv7() })).toThrow(/专用受信/)
    const launched = host.start(startBody, startToken, date())
    expect(host.start(startBody, startToken, date())).toEqual(launched)
    const runId = launched.run_id
    const judged = judgeReleaseEvidence(evidence.manifest, evidence.reader())
    expect(() => readReleaseRunSnapshot(db, 'fixture-only-secret', runId, releaseDefinitionHash, judged)).toThrow(/真实终态/)
    await expect(commands.dispatch!({ runId, nodes: {}, now: date() })).rejects.toThrow(/专用受信/)
    if (mutated) evidence.entries.set('test-evidence/G-05.json', Buffer.from('changed bytes'))
    expect(await host.advance(runId, date())).toMatchObject({ status: mutated ? 'failed' : 'awaiting_approval' })
    expect(spawned.size).toBe(6)
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM tool_executions').get()?.n).toBe(6)
    expect(() => host.approve(runId, { actor: 'human:forged' }, uuidv7(), date())).toThrow(/实名二次确认/)
    if (mutated) {
      expect(() => host.approve(runId, approvalToken, uuidv7(), date())).toThrow()
      expect(db.raw.prepare('SELECT status FROM runs WHERE run_id=?').get(runId)?.status).toBe('failed')
      return
    }
    const confirmed = new Date(Date.now() + 1000).toISOString()
    expect(host.approve(runId, approvalToken, uuidv7(), confirmed)).toEqual({ status: 'succeeded', run_id: runId })
    expect(readReleaseRunSnapshot(db, 'fixture-only-secret', runId, releaseDefinitionHash, judged).run_terminal).toBe('succeeded')
    const options = { db, secret: 'fixture-only-secret', runId, expectedDefinitionHash: releaseDefinitionHash,
      input: { manifest: evidence.manifest, publication: evidence.reader(), independent: evidence.reader() } }
    expect(() => prepareReleasePair({ ...options, authority: { readReceipt: () => undefined, isSignedS5Build: () => false } })).toThrow(/独立判卷回执/)
    const prepared = prepareReleasePair({ ...options, authority: { isSignedS5Build: () => false, readReceipt: () => ({
      producer: 'human', principal: 'human:fixture-independent', receipt_id: 'independent-fixture',
      manifest_hash: judged.manifest_hash, judgement_hash: releaseHash(judged), recorded_at: date(),
    }) } })
    expect(prepared.comparison.passed).toBe(true)
    expect(prepared.independent).toMatchObject({ gate_run_id: null, run_terminal: 'not_applicable' })
    expect(prepared.publication).toMatchObject({ gate_run_id: runId, run_terminal: 'succeeded' })
  } finally {
    await service.release()
    rmSync(dir, { recursive: true, force: true })
  }
})
