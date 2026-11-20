import type { Context } from '@deepseek-ai/cordis'
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { openServiceOrchestra, serveDshOrchestra } from '../../src/index.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { createExecutionScheduler } from '../../src/service/execution-scheduler.ts'
import { createProjectContextStore, PROJECT_CONTEXT_FILE, projectPromptContext } from '../../src/service/project-shared-context.ts'
import { getRun } from '../../src/service/queries/runs.ts'
import { createRunSharedContext, TASK_CONTEXT_BYTES } from '../../src/service/run-shared-context.ts'

function capture(context: string, key: string) {
  const line = context.split('\n').find((candidate) => candidate.startsWith(key))
  return JSON.parse(line!.slice(key.length))
}

it('只读一次共享项目资料，并在十个已派发的 DSH 子会话和汇总会话中保留任务与成果范围', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'orch-shared-execution-'))
  const workspaceRoot = join(temp, 'workspace')
  await mkdir(workspaceRoot)
  await mkdir(join(workspaceRoot, 'src'))
  await mkdir(join(workspaceRoot, 'private-vault'))
  await writeFile(join(workspaceRoot, '.env'), 'DO_NOT_SEND=this-is-secret')
  await writeFile(join(workspaceRoot, 'AGENTS.md'), 'UNAPPROVED_FILE_TEXT')
  const description = '项目约束：请在 src 中交付可审查结果。'
  await writeFile(join(workspaceRoot, PROJECT_CONTEXT_FILE), description)
  const releaseFirstRead = Promise.withResolvers<void>()
  const read = vi.fn(async (path: string) => {
    await releaseFirstRead.promise
    return { text: await readFile(join(workspaceRoot, path), 'utf8'), eof: true }
  })
  const list = vi.fn(async () => ({ entries: (await readdir(workspaceRoot, { withFileTypes: true }))
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })), truncated: false }))
  const children: Array<{ id: string; text?: string; parentSession: string; isSeeded: boolean }> = []
  const errors: string[] = []
  const checkTool = 'fixture.check'
  type Model = { provider: string; model: string }
  type Step = { agent: object; modelSelection: Model }
  type TestTool = { name: string; execute(input: object, execution: { agent: object; signal: AbortSignal; callId: string }): Promise<unknown> }
  const parent = { session: { id: 'parent', header: { cwd: workspaceRoot } }, ctx: { agents: {
    async create(options: { sessionId: string; agentOptions: Model; meta: { parentSession: string; isSeeded: boolean };
      setup(ctx: unknown, agent: unknown): void }) {
      const child = { id: options.sessionId, ...options.meta } as typeof children[number]
      children.push(child)
      let model = options.agentOptions
      let preStep: (step: Step, next: () => Promise<void>) => Promise<void>
      const tools = new Map<string, TestTool>()
      let idle = Promise.resolve()
      const events: unknown[] = []
      const agent = {
        status: 'idle', session: { id: child.id, snapshotEvents: () => events },
        model: { current: () => model, select: (selection: Model) => { model = selection } },
        followup(message: { content: Array<{ text: string }> }) {
          child.text = message.content[0]!.text
          agent.status = 'running'
          idle = preStep({ agent, modelSelection: model }, async () => {
            const task = capture(child.text!, '本次任务资料：')
            const execution = { agent, signal: new AbortController().signal, callId: child.id + '-check' }
            await tools.get('orchestra_read_tool')!.execute({ tool: checkTool, args: [] }, execution)
            for (const item of task.deliverables) {
              await tools.get('orchestra_rework')!.execute({ action: 'publish', file_name: item.acceptance.file_name,
                text: 'INTERNAL_ARTIFACT_BODY 只应通过已授权成果工具读取。' }, execution)
            }
            events.push({ type: 'request/header', data: { header: { config: model } } },
              { type: 'turn/end', data: { reason: { kind: 'completed' } } },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"status":"done","output":{"summary":"完成"}}' }] } } })
            agent.status = 'idle'
          }).catch((error: Error) => { errors.push(error.message); throw error })
        },
        whenIdle: () => idle,
        cancel() { agent.status = 'idle' },
      }
      options.setup({ tools: { restrict() {}, register(tool: TestTool) { tools.set(tool.name, tool) } },
        on(_event: string, handler: typeof preStep) { preStep = handler } }, agent)
      return { agent, async dispose() {} }
    },
  } } }
  const registry = new ToolRegistry()
  registry.register({ name: checkTool, capability: 'read_only', command: { bin: 'check', args: [] } })
  const runner = new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true,
    async run() { return { exitCode: 0, stdout: 'checked', stderr: '' } } }, workspaceRoot)
  const ids = Array.from({ length: 10 }, (_, i) => `branch_${i + 1}`)
  const goal = '收集十份检查结果并完成验收汇总'
  const requirements = Array.from({ length: 12 }, (_, index) => `${index + 1}项 ${'检查内容'.repeat(66)}`)
  const service = await serveDshOrchestra({
    dbFile: join(temp, 'orchestra.db'), secret: 'fixture-shared-execution', phase: 'S6', tools: { registry, runner },
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'test' }),
    projectContext: { workspaceRoot, isAuthorized: () => true, read, list },
    scheduler: createExecutionScheduler({ concurrency: 10 }),
    dsh: {
      context: { agents: { get: () => parent }, llm: { listModels: async () => [{ id: 'model' }] } } as unknown as Context,
      parentForNode: () => parent as unknown as NonNullable<ReturnType<Parameters<typeof serveDshOrchestra>[0]['dsh']['parentForNode']>>,
      models: [{ ref: 'test/model', provider: 'test', model: 'model', capacity: 'standard' }],
      recommend: () => ({ complexity: 'routine', reason: '测试共享执行' }),
    },
    planning: {
      workflowGenerator: async () => ({ name: '检查结果汇总',
        nodes: [{ node_id: 'start', title: '开始', type: 'trigger', position: { x: 0, y: 0 } },
          ...[...ids, 'summary'].map((node_id, i) => ({ node_id, title: '收集检查结果 ' + node_id, type: 'agent',
            config: { tools: { allow: [checkTool] } }, position: { x: i + 1, y: i + 1 } }))],
        edges: [...ids.map((to) => ({ from: 'start', to })), ...ids.map((from) => ({ from, to: 'summary' }))],
      }),
      propose: async ({ workflows, requirements: expected }) => {
        const [workflow] = workflows
        const goalIds = ['goal', ...expected.map(({ id }) => id)]
        return { title: '验收汇总', workflow_id: workflow!.workflowId, workflow_version: workflow!.version, risks: [],
          steps: workflow!.nodes.map((node) => ({ node_id: node.id, description: node.title, goal_ids: goalIds,
            depends_on: node.dependsOn, tools: [checkTool], complexity: 'routine', model_reason: '检查资料并登记结果' })),
          deliverables: workflow!.nodes.map((node) => ({ title: '检查成果 ' + node.id, node_id: node.id, goal_ids: goalIds,
            acceptance: { kind: 'artifact', file_name: `${node.id}.txt`, minimum_bytes: 1 } })),
        }
      },
    },
  })
  try {
    const launch = async () => {
      const now = new Date().toISOString()
      const { view: plan } = await service.planning!.propose({ goal, requirements }, 'owner', now)
      expect(plan.quality).toMatchObject({ ready: true })
      const result = service.planning!.confirm({ plan_id: plan.plan_id, content_hash: plan.content_hash, confirmed: true }, 'owner', now)
      return { runId: result.run_id, plan }
    }
    const first = await launch()
    await expect.poll(() => children.length, { timeout: 6_000 }).toBe(10)
    await expect.poll(() => read.mock.calls.length).toBe(1)
    expect(children.every((child) => child.text === undefined)).toBe(true)
    releaseFirstRead.resolve()
    await expect.poll(() => {
      const run = getRun(service.orchestra.db, first.runId)
      return { status: run.status, counts: run.counts, prompts: children.filter((child) => child.text).length, errors }
    }, { timeout: 8_000 }).toEqual({ status: 'succeeded', counts: [{ count: 11, status: 'done' }], prompts: 11, errors: [] })
    expect(children).toHaveLength(11)
    expect(read).toHaveBeenCalledExactlyOnceWith(PROJECT_CONTEXT_FILE, expect.any(AbortSignal))
    expect(list).toHaveBeenCalledTimes(1)
    expect(new Set(children.map(({ id }) => id)).size).toBe(11)
    const persisted = getRun(service.orchestra.db, first.runId).project_context
    expect(persisted).toMatchObject({ version: expect.stringMatching(/^[a-f0-9]{64}$/u), as_of_seq: expect.any(Number),
      sources: [{ path: PROJECT_CONTEXT_FILE, status: 'available', truncated: false }, { path: '.', status: 'available' }] })
    for (const child of children) {
      expect(child).toMatchObject({ parentSession: 'parent', isSeeded: false })
      expect(child.text).not.toMatch(/private-vault|UNAPPROVED_FILE_TEXT|DO_NOT_SEND|INTERNAL_ARTIFACT_BODY/u)
      const project = capture(child.text!, '共享项目资料：')
      expect(project).toMatchObject({ version: persisted!.version, constraints: description, root_directories: ['src'] })
      const task = capture(child.text!, '本次任务资料：')
      expect(task).toMatchObject({ run_id: first.runId, plan_id: first.plan.plan_id, goal, as_of_seq: expect.any(Number),
        deliverables: [{ acceptance: { kind: 'artifact' } }] })
      expect(Buffer.byteLength(JSON.stringify(task))).toBeLessThanOrEqual(TASK_CONTEXT_BYTES)
      if (task.deliverables[0].acceptance.file_name === 'summary.txt') {
        expect(task.upstream_artifacts).toHaveLength(10)
        expect(task.omitted.requirements).toBeGreaterThan(0)
      } else expect(task.upstream_artifacts).toHaveLength(0)
    }
    const second = await launch()
    await expect.poll(() => getRun(service.orchestra.db, second.runId).status, { timeout: 10_000 }).toBe('succeeded')
    expect(getRun(service.orchestra.db, second.runId).project_context?.version).toBe(persisted!.version)
    expect(children).toHaveLength(22)
    const firstReferences = capture(children[10]!.text!, '本次任务资料：').upstream_artifacts.map((ref: { artifact_id: string }) => ref.artifact_id)
    const secondReferences = capture(children[21]!.text!, '本次任务资料：').upstream_artifacts.map((ref: { artifact_id: string }) => ref.artifact_id)
    expect(secondReferences).toHaveLength(10)
    expect(secondReferences.every((id: string) => !firstReferences.includes(id))).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(1)
  } finally {
    releaseFirstRead.resolve()
    await service.close()
    await rm(temp, { recursive: true, force: true })
  }
}, 25_000)

it('跨重开恢复旧运行版本，按新内容刷新，且无资料时保留原执行路径', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'orch-shared-versions-'))
  const workspaceRoot = join(temp, 'workspace')
  await mkdir(workspaceRoot)
  const file = join(workspaceRoot, PROJECT_CONTEXT_FILE)
  const read = vi.fn(async (path: string) => ({ text: await readFile(join(workspaceRoot, path), 'utf8'), eof: true }))
  let authorized = true
  const source = { workspaceRoot, isAuthorized: () => authorized, read }
  const boot = () => openServiceOrchestra({ dbFile: join(temp, 'orchestra.db'), secret: 'fixture-shared-versions', phase: 'S6' })
  let handle = await boot()
  try {
    const db = handle.orchestra.db
    const now = new Date().toISOString()
    withTx(db, (tx) => {
      tx.run("INSERT INTO tasks (task_id,title,status,created_at,updated_at) VALUES ('t','task','running',?,?)", [now, now])
      for (const id of ['missing', 'fallback', 'excluded', 'old', 'new', 'reopen']) {
        tx.run("INSERT INTO runs (run_id,task_id,status,created_at,updated_at) VALUES (?,'t','running',?,?)", [id, now, now])
        tx.run("INSERT INTO node_runs (node_run_id,run_id,node_id,seq,node_type,status,created_at,updated_at) VALUES (?,?,'step',1,'agent','queued',?,?)",
          ['node_' + id, id, now, now])
      }
    })
    await writeFile(join(workspaceRoot, 'README.md'), 'must not be read unless authorized')
    expect(await createRunSharedContext(db, source)('node_missing', 'step', [])).toBeUndefined()
    expect(getRun(db, 'missing').project_context?.sources).toEqual([{ path: PROJECT_CONTEXT_FILE, status: 'missing' }])
    expect(read).not.toHaveBeenCalled()
    const fallback = createProjectContextStore(db, { ...source, approvedFallback: 'README.md' })
    expect(projectPromptContext(await fallback.forRun('fallback'))?.constraints).toBe('must not be read unless authorized')
    expect(read).toHaveBeenCalledExactlyOnceWith('README.md', expect.any(AbortSignal))
    read.mockClear()
    await link(join(workspaceRoot, 'README.md'), file)
    const excluded = projectPromptContext(await createProjectContextStore(db, source).forRun('excluded'))
    expect(excluded?.sources).toEqual([{ path: PROJECT_CONTEXT_FILE, status: 'excluded' }])
    expect(read).not.toHaveBeenCalled()
    await rm(file)
    const longtime = '工作区项目约束。'.repeat(900)
    await writeFile(file, longtime)
    const firstStore = createProjectContextStore(db, source)
    const initial = projectPromptContext(await firstStore.forRun('old'))
    expect(initial?.sources).toMatchObject([{ path: PROJECT_CONTEXT_FILE, status: 'available', truncated: true }])
    expect(Buffer.byteLength(initial!.constraints!)).toBeLessThanOrEqual(4096)
    expect(initial!.constraints).not.toContain('�')
    await handle.release()
    handle = await boot()
    const store = createProjectContextStore(handle.orchestra.db, source)
    expect(projectPromptContext(await store.forRun('reopen'))?.version).toBe(initial?.version)
    expect(read).toHaveBeenCalledTimes(1)
    await writeFile(file, longtime + '文件尾变化也产生新版本')
    const changed = projectPromptContext(await store.forRun('new'))
    expect(changed?.version).not.toBe(initial?.version)
    expect(changed?.constraints).toBe(initial?.constraints)
    expect(projectPromptContext(await store.forRun('old'))).toEqual(initial)
    authorized = false
    expect(await store.forRun('old')).toBeUndefined()
    expect(read).toHaveBeenCalledTimes(2)
  } finally {
    await handle.release()
    await rm(temp, { recursive: true, force: true })
  }
})
