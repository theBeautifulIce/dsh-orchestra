import { createHmac, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { sha256Hex } from '../core/canonical.ts'
import { failEnvelope, OrchError } from '../core/errors.ts'
import { MODEL_COMPLEXITIES, MODEL_REF_RE } from '../executor/model-routing.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../executor/tools.ts'
import type { serveDshOrchestra } from '../index.ts'

const localOptions = z.strictObject({
  enabled: z.boolean().default(false),
  modelCapacity: z.enum(MODEL_COMPLEXITIES).default('standard'),
  dataDirectory: z.string().refine(isAbsolute, '必须为绝对路径').optional(),
  allowWorkspaceListing: z.boolean().default(false),
  sampleFile: z.string().refine((value) => isAbsolute(value)
    && /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,110}\.(?:txt|md|csv|json)$/iu.test(basename(value)),
    '只允许工作区根目录中指定的非隐藏文本文件绝对路径').optional(),
})

export const localDshHostConfig = z.strictObject({ local: localOptions.prefault({}) }).prefault({})

type LocalOptions = z.output<typeof localOptions>
type Serve = typeof serveDshOrchestra
type LocalService = Awaited<ReturnType<Serve>>
type Agent = AgentHandle['agent']
type Workspace = { id: string; path: string; sessionIds: readonly string[] }
type Model = { provider: string; model: string }
type Credential = { kind: 'grant'; payload: unknown } | { kind: 'api-key'; key?: string }

type LocalHost = Context & {
  connection: {
    fetch: { register(route: { path: string; methods: ['GET', 'POST']; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => Promise<void> }
  }
  credentials: { modifyRecord(key: string, update: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> }
  workspaceRegistry: { get(id: string): Workspace | undefined; archivedSessionIds: readonly string[] }
  sessionController: {
    resolveAgent(id: string): Promise<{ agent: Agent } | { error: unknown }>
    modelCatalog(): Promise<{ default: Model; groups: readonly { id: string; models: readonly { id: string }[] }[] }>
  }
  workspaceFiles: {
    list(scope: { sessionId: string; workspaceRoot: string }, path: string, signal: AbortSignal): Promise<{
      entries: readonly { name: string; type: string; size?: number }[]; truncated: boolean
    }>
    read(scope: { sessionId: string; workspaceRoot: string }, path: string, range: { offset: number; limit: number },
      signal: AbortSignal): Promise<{ text: string; eof: boolean }>
  }
}

const routePath = '/api/orchestra.request'
const responseHeaders = ['content-type', 'content-disposition', 'cache-control', 'x-content-type-options']
const catalog = {
  GET: new Set([
    '/health', '/v1/activity', '/v1/artifacts', '/v1/artifacts/content', '/v1/artifacts/get', '/v1/attestations/get',
    '/v1/collaboration/scopes', '/v1/collaboration/scopes/get', '/v1/decisions', '/v1/decisions/get', '/v1/effects/review',
    '/v1/effects/unverified', '/v1/events', '/v1/events/stream', '/v1/evidence/get', '/v1/execution-history', '/v1/ledger/verify',
    '/v1/model-escalation', '/v1/node-runs', '/v1/node-runs/get', '/v1/operations/get', '/v1/rework', '/v1/rework/get',
    '/v1/rework/holds', '/v1/rework/inspections', '/v1/rework/plan', '/v1/rework/topology', '/v1/runs', '/v1/runs/get', '/v1/settings/model-routing',
    '/v1/task-plans/by-task', '/v1/task-plans/capability', '/v1/task-plans/get', '/v1/task-triggers', '/v1/tasks', '/v1/tasks/get',
    '/v1/workflows', '/v1/workflows/generate/capability', '/v1/workflows/get', '/v1/workflows/versions/get', '/v1/workspace/overview',
  ]),
  POST: new Set([
    '/v1/collaboration/reassign', '/v1/collaboration/review', '/v1/collaboration/scopes', '/v1/decisions/acknowledge',
    '/v1/decisions/resolve', '/v1/effects/resolve', '/v1/model-escalation', '/v1/rework/hold', '/v1/rework/inspect',
    '/v1/rework/plan', '/v1/rework/plan/approve', '/v1/rework/request', '/v1/rework/review', '/v1/runs/start',
    '/v1/settings/model-routing', '/v1/task-plans', '/v1/task-plans/confirm', '/v1/tasks/archive', '/v1/workflows',
    '/v1/workflows/generate', '/v1/workflows/open-draft', '/v1/workflows/publish', '/v1/workflows/status', '/v1/workflows/test',
    '/v1/workflows/update',
  ]),
}

function failure(status: number, code: ConstructorParameters<typeof OrchError>[0], message: string) {
  return Response.json(failEnvelope(0, new OrchError(code, message)), { status, headers: { 'cache-control': 'no-store' } })
}

function validTarget(raw: string | null, method: string): URL | undefined {
  if (!raw || raw.length > 8192 || !/^\/(?:health|v1\/[a-z0-9/-]+)(?:\?|$)/u.test(raw) || /[\\#\u0000-\u001f]/u.test(raw)) return
  const target = new URL(raw, 'http://dsh.internal')
  const allowed = method === 'GET' ? catalog.GET : method === 'POST' ? catalog.POST : undefined
  return allowed?.has(target.pathname) ? target : undefined
}

function localAuthority(request: Request): boolean {
  const authority = request.headers.get('host')
  if (!authority || request.headers.get('sec-fetch-site') === 'cross-site') return false
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/iu.test(authority)
}

function selectedWorkspace(host: LocalHost, workspaceId: string, sessionId: string) {
  const workspace = host.workspaceRegistry.get(workspaceId)
  return workspace?.sessionIds.includes(sessionId) && !host.workspaceRegistry.archivedSessionIds.includes(sessionId) ? workspace : undefined
}

async function ledgerSecret(host: LocalHost, identity: string, dbFile: string) {
  const record = await host.credentials.modifyRecord('dsh-orchestra/local-ledger', async (current) => {
    if (current || existsSync(dbFile)) return undefined
    return { kind: 'grant', payload: randomBytes(32).toString('hex') }
  })
  if (record?.kind !== 'grant' || typeof record.payload !== 'string' || !/^[a-f0-9]{64}$/u.test(record.payload)) {
    throw new Error('Orchestra ledger credential has an invalid format')
  }
  return createHmac('sha256', record.payload).update(identity).digest('hex')
}

async function openLocalService(host: LocalHost, options: LocalOptions, workspace: Workspace, sessionId: string,
  identity: string, human: string, serve: Serve) {
  const resolved = await host.sessionController.resolveAgent(sessionId)
  if (!('agent' in resolved) || resolved.agent.session.header.origin === 'subagent'
    || !selectedWorkspace(host, workspace.id, sessionId)) throw new Error('Workspace session could not be activated')
  const models = await host.sessionController.modelCatalog()
  const route = resolved.agent.model.current() ?? models.default
  if (!route || !models.groups.some((group) => group.id === route.provider && group.models.some((model) => model.id === route.model))) {
    throw new Error('The selected DSH model is not routable')
  }
  const { provider, model: modelId } = route
  const readableRef = `${provider}/${modelId}`
  const ref = MODEL_REF_RE.test(readableRef) ? readableRef : `dsh:${sha256Hex(JSON.stringify([provider, modelId])).slice(0, 24)}`
  const model = { provider, model: modelId, capacity: options.modelCapacity, ref }
  const parent = () => selectedWorkspace(host, workspace.id, sessionId) ? host.agents.get(resolved.agent.session.id) : undefined
  const directory = options.dataDirectory ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'orchestra', 'personal')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const dbFile = join(directory, `${identity}.sqlite`)
  const secret = await ledgerSecret(host, identity, dbFile)
  const proof = randomBytes(32).toString('hex')
  const registry = new ToolRegistry()
  const sampleFile = options.sampleFile && relative(workspace.path, dirname(options.sampleFile)) === '' ? basename(options.sampleFile) : undefined
  if (options.allowWorkspaceListing) registry.register({
    name: 'workspace_list', capability: 'read_only', command: { bin: 'dsh:workspace.list', args: ['.'] },
  })
  if (sampleFile) registry.register({
    name: 'workspace_read_sample', capability: 'read_only', command: { bin: 'dsh:workspace.read', args: [sampleFile] },
  })
  const runner = new ReadOnlyToolRunner(registry, {
    readonlyAvailable: () => Boolean(parent()) && (options.allowWorkspaceListing || Boolean(sampleFile)),
    async run({ bin, args, cwd, timeoutMs }) {
      if (args.length !== 1 || cwd !== workspace.path || !parent()) {
        throw new OrchError('FORBIDDEN', '工具不属于获准工作区')
      }
      const scope = { sessionId, workspaceRoot: workspace.path }
      const signal = AbortSignal.timeout(timeoutMs)
      if (bin === 'dsh:workspace.read' && sampleFile && args[0] === sampleFile) {
        const sample = await host.workspaceFiles.read(scope, sampleFile, { offset: 1, limit: 200 }, signal)
        if (!sample.eof || Buffer.byteLength(sample.text, 'utf8') > 16 * 1024) {
          throw new OrchError('RANGE_TOO_LARGE', '验收样本应不超过 200 行和 16 KiB')
        }
        return { exitCode: 0, stdout: sample.text, stderr: '' }
      }
      if (bin === 'dsh:workspace.list' && options.allowWorkspaceListing && args[0] === '.') {
        const listing = await host.workspaceFiles.list(scope, '.', signal)
        const visible = listing.entries.filter((item) => !item.name.startsWith('.'))
        return { exitCode: 0, stdout: JSON.stringify({ entries: visible.slice(0, 200), truncated: listing.truncated || visible.length > 200 }), stderr: '' }
      }
      throw new OrchError('FORBIDDEN', '工具不属于获准工作区')
    },
  }, workspace.path)
  let service: LocalService | undefined
  service = await serve({
    dbFile, secret, phase: 'S6', tools: { registry, runner },
    resolveHttpHuman: (req) => req.headers['x-orchestra-local-proof'] === proof ? { id: human } : null,
    dsh: { context: host, parentForNode: parent, models: [model],
      recommend: () => ({ complexity: 'routine', reason: '使用此宿主已批准的 DSH 默认执行模型。' }) },
    dshPlanner: { parent, model },
    asOfSeq: () => Number(service?.orchestra.db.raw.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events').get()?.n ?? 0),
    listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => { throw new OrchError('FORBIDDEN', '个人面板不提供原始账本写入') },
  })
  return { service, secret, proof }
}

export function installLocalDshHost(ctx: Context, options: LocalOptions, serve: Serve): void {
  const dependencies = ['agents', 'llm', 'tools', 'connection', 'credentials', 'workspaceRegistry', 'sessionController']
  if (options.allowWorkspaceListing || options.sampleFile) dependencies.push('workspaceFiles')
  ctx.inject(dependencies, (ready) => {
    const host = ready as LocalHost
    const human = `local-dsh:${userInfo().username}`
    const services = new Map<string, ReturnType<typeof openLocalService>>()
    const stop = new AbortController()
    host.effect(() => async () => {
      stop.abort()
      await Promise.allSettled([...services.values()].map(async (startup) => (await startup).service.close()))
    }, 'Orchestra personal services')
    host.connection.fetch.register({ path: routePath, methods: ['GET', 'POST'], requestBody: 'buffered', async fetch(request) {
      if (stop.signal.aborted || request.signal.aborted) return failure(503, 'SERVICE_UNAVAILABLE', '编排请求已取消')
      if (!localAuthority(request) || host.get('webServer')?.host === '0.0.0.0') {
        return failure(403, 'FORBIDDEN', '此面板仅供本机 DSH 操作人使用')
      }
      if (request.method === 'POST' && (request.headers.get('x-orchestra-request') !== '1'
        || request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')) {
        return failure(403, 'FORBIDDEN', '此操作需要已认证的编排面板请求')
      }
      const query = new URL(request.url).searchParams
      const target = validTarget(query.get('path'), request.method)
      if (!target) return failure(404, 'NOT_FOUND', '该接口不属于个人面板')
      const workspaceId = query.get('workspaceId') ?? ''
      const sessionId = query.get('sessionId') ?? ''
      const workspace = selectedWorkspace(host, workspaceId, sessionId)
      if (!workspace) return failure(403, 'FORBIDDEN', '请选择该工作区中未归档的 DSH 会话')
      if (request.method === 'POST' && target.pathname === '/v1/runs/start') {
        return failure(403, 'FORBIDDEN', '个人宿主请使用「用自然语言规划任务」，注明要使用的已发布流程及交付物，核对计划后再启动。')
      }
      const identity = sha256Hex(JSON.stringify([workspace.id, workspace.path, sessionId, human]))
      let startup = services.get(identity)
      if (!startup) {
        if (services.size >= 8) return failure(503, 'SERVICE_UNAVAILABLE', '已打开过多编排会话')
        startup = openLocalService(host, options, workspace, sessionId, identity, human, serve)
        services.set(identity, startup)
        void startup.catch(() => { if (services.get(identity) === startup) services.delete(identity) })
      }
      try {
        const { service, secret, proof } = await startup
        const signal = AbortSignal.any([request.signal, stop.signal])
        signal.throwIfAborted()
        if (!selectedWorkspace(host, workspaceId, sessionId)) return failure(403, 'FORBIDDEN', '工作区会话授权已失效')
        const headers = new Headers({ 'x-orchestra-secret': secret, 'x-orchestra-local-proof': proof })
        const contentType = request.headers.get('content-type')
        if (contentType) headers.set('content-type', contentType)
        const response = await fetch(new URL(target.pathname + target.search, service.endpoint), {
          method: request.method, headers, signal, redirect: 'error',
          ...(request.method === 'POST' && request.body ? { body: request.body, duplex: 'half' } : {}),
        })
        const forwarded = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        for (const name of responseHeaders) {
          const value = response.headers.get(name)
          if (value) forwarded.set(name, value)
        }
        return new Response(response.body, { status: response.status, headers: forwarded })
      } catch {
        return failure(503, 'SERVICE_UNAVAILABLE', '编排服务未就绪。请确认 DSH 会话和默认模型可用')
      }
    } })
  })
}
