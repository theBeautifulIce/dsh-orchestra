import { createHmac, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { sha256Hex } from '../core/canonical.ts'
import { ERROR_STATUS, failEnvelope, okEnvelope, OrchError } from '../core/errors.ts'
import { MEMORY_TOOL_PREFIX } from '../core/memory-graph.ts'
import { artifactReceiptLocation, type ArtifactReceiptLocation } from '../core/receipt-location.ts'
import { MODEL_COMPLEXITIES, MODEL_REF_RE, validModelEffort, type ModelReasoning } from '../executor/model-routing.ts'
import { ReadOnlyToolRunner, ToolRegistry, type ToolDescriptor } from '../executor/tools.ts'
import { createDshSemanticInterpreter } from '../executor/dsh-task-requirements.ts'
import { createWindowsReadOnlyHost } from '../executor/windows-readonly-host.ts'
import type { serveDshOrchestra } from '../index.ts'
import { installNativeChat } from './chat-native.ts'
import { createSemanticDraftCheckpoints } from './semantic-draft-checkpoints.ts'
import { artifactBrowserPath, artifactDownloadPath, createArtifactBrowserReader } from './artifact-browser.ts'
import { acceptedArtifactTitle, getArtifactContent } from './queries/artifacts.ts'
import { getRun } from './queries/runs.ts'
import { RUN_TERMINAL } from './commands/run-close.ts'
import { createNativeChatRoutingSettings, nativeChatRoutingUpdate } from './native-chat-routing-settings.ts'
import { checkNativeTaskCommand, createNativeCommandSettings, nativeCommandCheck, nativeCommandUpdate } from './native-command-settings.ts'
import { DEFAULT_TASK_COMMAND } from '../core/task-command.ts'
import { createExecutionPermissionSettings, executionPermissionUpdate } from './execution-permission-settings.ts'
import type { ExecutionPermissionMode } from '../core/execution-permissions.ts'
import { PROJECT_CONTEXT_FILE, type ProjectContextSource } from './project-shared-context.ts'
import { requestControlPipe } from './windows-control-pipe.ts'

const localOptions = z.strictObject({
  enabled: z.union([z.boolean(), z.literal('desktop')]).default(false),
  modelCapacity: z.enum(MODEL_COMPLEXITIES).optional(),
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
export type TrustedLocalReadOnlyCommands = (scope: Readonly<{ workspaceId: string; workspaceRoot: string; sessionId: string }>) =>
  Promise<{ commands: readonly ToolDescriptor[]; populate(view: string): Promise<void> } | undefined>
type Model = { provider: string; model: string }
type NativeModelCatalog = {
  groups: readonly { id: string; name?: string; models: readonly { id: string; name?: string; reasoning?: ModelReasoning }[] }[]
  failures?: readonly { id: string; name?: string }[]
}
type Credential = { kind: 'grant'; payload: unknown } | { kind: 'api-key'; key?: string }
type Profile = { name?: string; installAnchor?: string; dir?: string }

type LocalHost = Context & {
  connection: {
    fetch: { register(route: { path: string; methods: ['GET', 'POST']; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => Promise<void> }
  }
  credentials: { modifyRecord(key: string, update: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> }
  workspaceRegistry: { get(id: string): Workspace | undefined; list(): readonly Workspace[]; archivedSessionIds: readonly string[] }
  sessionController: {
    resolveAgent(id: string): Promise<{ agent: Agent } | { error: unknown }>
    modelCatalog(): Promise<NativeModelCatalog>
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
const chatRoutingPath = '/v1/settings/chat-routing'
const taskCommandPath = '/v1/settings/task-command'
const taskCommandCheckPath = '/v1/settings/task-command/check'
const executionPermissionsPath = '/v1/settings/execution-permissions'
const responseHeaders = ['content-type', 'content-disposition', 'cache-control', 'x-content-type-options']
const catalog = {
  GET: new Set([
    '/v1/run-notes', '/v1/run-coordination',
    chatRoutingPath,
    taskCommandPath,
    executionPermissionsPath,
    '/v1/settings/execution-capacity', '/v1/settings/workflow-concurrency',
    '/health', '/v1/activity', '/v1/artifacts', '/v1/artifacts/content', '/v1/artifacts/get', '/v1/attestations/get',
    '/v1/collaboration/scopes', '/v1/collaboration/scopes/get', '/v1/decisions', '/v1/decisions/get', '/v1/effects/review',
    '/v1/effects/unverified', '/v1/events', '/v1/events/stream', '/v1/evidence/get', '/v1/execution-history', '/v1/ledger/verify',
    '/v1/memory/batches', '/v1/model-escalation', '/v1/node-runs', '/v1/node-runs/get', '/v1/operations/get', '/v1/rework', '/v1/rework/get',
    '/v1/rework/holds', '/v1/rework/inspections', '/v1/rework/plan', '/v1/rework/topology', '/v1/runs', '/v1/runs/get', '/v1/settings/model-routing', '/v1/settings/planning-timeouts',
    '/v1/task-plans/by-task', '/v1/task-plans/progress', '/v1/task-plans/drafts', '/v1/task-plans/capability', '/v1/task-plans/get', '/v1/task-triggers', '/v1/tasks', '/v1/tasks/get',
    '/v1/workflows', '/v1/workflows/generate/capability', '/v1/workflows/get', '/v1/workflows/versions/get', '/v1/workspace/overview',
  ]),
  POST: new Set([
    artifactBrowserPath,
    artifactDownloadPath,
    '/v1/run-notes', '/v1/run-coordination', '/v1/runs/stop',
    chatRoutingPath,
    taskCommandPath, taskCommandCheckPath,
    executionPermissionsPath,
    '/v1/settings/execution-capacity', '/v1/settings/workflow-concurrency',
    '/v1/collaboration/reassign', '/v1/collaboration/review', '/v1/collaboration/scopes', '/v1/decisions/acknowledge',
    '/v1/decisions/resolve', '/v1/effects/resolve', '/v1/model-escalation', '/v1/rework/hold', '/v1/rework/inspect',
    '/v1/rework/plan', '/v1/rework/plan/approve', '/v1/rework/request', '/v1/rework/review', '/v1/runs/start',
    '/v1/settings/model-routing', '/v1/settings/planning-timeouts', '/v1/task-plans', '/v1/task-plans/confirm', '/v1/task-plans/discard', '/v1/task-plans/materials', '/v1/task-plans/materials/revoke', '/v1/tasks/archive', '/v1/workflows',
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

function localListener(host: Context): boolean {
  const address = host.get('webServer')?.host
  return address === undefined || /^(?:localhost|127\.0\.0\.1|::1|\[::1\])$/iu.test(address)
}

function compatibleDesktop(profile: Profile | undefined): boolean {
  if (profile?.name !== 'desktop' || !profile.installAnchor) return false
  try {
    const pkg = createRequire(profile.installAnchor)('@deepseek-ai/dsh-api-session-controller/package.json') as { version?: string }
    const match = /^0\.2\.2(?:-rc\.(\d+))?$/u.exec(pkg.version ?? '')
    // rc.5 records non-owner principals on native prompt admission and
    // distinguishes an empty retry from original operator input.
    return Boolean(match && (match[1] === undefined || Number(match[1]) >= 5))
  } catch { return false }
}

export function installConfiguredLocalDshHost(ctx: Context, options: LocalOptions, serve: Serve): void {
  if (options.enabled === false) return
  const desktop = compatibleDesktop(ctx.get('profileContext') as Profile | undefined)
  if (options.enabled === 'desktop' && !desktop) return
  installLocalDshHost(ctx, options, serve, desktop)
}

function selectedWorkspace(host: LocalHost, workspaceId: string, sessionId: string) {
  const workspace = host.workspaceRegistry.get(workspaceId)
  return workspace?.sessionIds.includes(sessionId) && !host.workspaceRegistry.archivedSessionIds.includes(sessionId) ? workspace : undefined
}

function localDataDirectory(options: LocalOptions) {
  return options.dataDirectory ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'orchestra', 'personal')
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
  identity: string, human: string, serve: Serve, executionPermissionMode: () => ExecutionPermissionMode) {
  const resolved = await host.sessionController.resolveAgent(sessionId)
  if (!('agent' in resolved) || resolved.agent.session.header.origin === 'subagent'
    || !selectedWorkspace(host, workspace.id, sessionId)) throw new Error('Workspace session could not be activated')
  const defaultModel = host.get('agentDefaultModel') as { currentSelection(): Model | undefined } | undefined
  const currentModel = (agent: Agent | undefined) => agent?.model.current() ?? defaultModel?.currentSelection()
  function modelRef(provider: string, model: string) {
    const readable = `${provider}/${model}`
    return !provider.includes('/') && MODEL_REF_RE.test(readable) ? readable
      : `dsh:${sha256Hex(JSON.stringify([provider, model])).slice(0, 24)}`
  }
  const modelsFor = (catalog: NativeModelCatalog, preferred: Model | undefined) => catalog.groups.flatMap((group) => group.models.map((model) => {
    const efforts = model.reasoning?.efforts.filter(({ id }) => validModelEffort(id)) ?? []
    const defaultEffort = model.reasoning?.defaultEffort
    return { provider: group.id, provider_name: group.name, model: model.id, name: model.name,
      ref: modelRef(group.id, model.id),
      capacity: group.id === preferred?.provider && model.id === preferred.model ? options.modelCapacity ?? null : null,
      ...(efforts.length ? { reasoning: { efforts, ...(efforts.some(({ id }) => id === defaultEffort) ? { defaultEffort } : {}) } } : {}) }
  }))
  const parent = () => selectedWorkspace(host, workspace.id, sessionId) ? host.agents.get(resolved.agent.session.id) : undefined
  const sessionModelRef = (selection: Model | undefined) => selection && modelRef(selection.provider, selection.model)
  const directory = localDataDirectory(options)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const dbFile = join(directory, `${identity}.sqlite`)
  const secret = await ledgerSecret(host, identity, dbFile)
  const proof = randomBytes(32).toString('hex')
  const registry = new ToolRegistry()
  const sampleFile = options.sampleFile && relative(workspace.path, dirname(options.sampleFile)) === '' ? basename(options.sampleFile) : undefined
  const approvedFallback = sampleFile === 'README.md' || sampleFile === 'AGENTS.md' ? sampleFile : undefined
  const projectScope = { sessionId, workspaceRoot: workspace.path }
  const projectAuthorized = () => {
    const liveWorkspace = selectedWorkspace(host, workspace.id, sessionId)
    if (!liveWorkspace || liveWorkspace.path !== workspace.path) return false
    const cwd = parent()?.session.header.cwd
    return Boolean(cwd && relative(workspace.path, cwd) === '')
  }
  const provider = host.get('orchestraReadonlyCommands') as TrustedLocalReadOnlyCommands | undefined
  const configured = process.platform === 'win32' && provider && projectAuthorized()
    ? await Promise.resolve().then(() => provider({ workspaceId: workspace.id, workspaceRoot: workspace.path, sessionId })).catch(() => undefined)
    : undefined
  const commands = configured?.commands ?? []
  const validCommands = commands.length > 0
    && new Set(commands.map((tool) => tool.name)).size === commands.length
    && commands.every((tool) => tool.capability === 'read_only' && isAbsolute(tool.command.bin)
      && tool.command.bin.toLowerCase().endsWith('.exe') && !tool.name.startsWith(MEMORY_TOOL_PREFIX)
      && tool.name !== 'workspace_read_sample' && tool.name !== 'workspace_list')
  const commandHost = configured && validCommands
    ? await createWindowsReadOnlyHost(workspace.path, (view) => configured.populate(view)).catch(() => undefined)
    : undefined
  const commandRegistry = new Set<string>()
  for (const command of commandHost ? commands : []) {
    registry.register({ ...command, command: { ...command.command, args: [...command.command.args] } })
    commandRegistry.add(command.command.bin)
  }
  const projectContext: ProjectContextSource = {
    workspaceRoot: workspace.path, isAuthorized: projectAuthorized, approvedFallback,
    async read(path, signal) {
      const files = host.get('workspaceFiles') as LocalHost['workspaceFiles'] | undefined
      if (!files || !projectAuthorized() || (path !== PROJECT_CONTEXT_FILE && path !== approvedFallback)) {
        throw new OrchError('FORBIDDEN', '共享项目文字未获当前工作区授权')
      }
      return files.read(projectScope, path, { offset: 1, limit: 120 }, signal)
    },
    ...(options.allowWorkspaceListing ? {
      async list(signal: AbortSignal) {
        if (!projectAuthorized()) throw new OrchError('FORBIDDEN', '共享项目目录未获当前工作区授权')
        return host.workspaceFiles.list(projectScope, '.', signal)
      },
    } : {}),
  }
  if (options.allowWorkspaceListing) registry.register({
    name: 'workspace_list', capability: 'read_only', command: { bin: 'dsh:workspace.list', args: ['.'] },
  })
  if (sampleFile) registry.register({
    name: 'workspace_read_sample', capability: 'read_only', command: { bin: 'dsh:workspace.read', args: [sampleFile] },
  })
  const runner = new ReadOnlyToolRunner(registry, {
    readonlyAvailable: (bin) => projectAuthorized() && (
      (bin === 'dsh:workspace.read' && Boolean(sampleFile))
      || (bin === 'dsh:workspace.list' && options.allowWorkspaceListing)
      || (bin === undefined && (options.allowWorkspaceListing || Boolean(sampleFile) || Boolean(commandHost?.readonlyAvailable())))
      || (bin !== undefined && commandRegistry.has(bin) && Boolean(commandHost?.readonlyAvailable(bin)))),
    async run({ bin, args, cwd, timeoutMs, signal: cancel }) {
      if (!projectAuthorized()) throw new OrchError('FORBIDDEN', '工具不属于获准工作区')
      if (commandHost && commandRegistry.has(bin)) return commandHost.run({ bin, args, cwd, timeoutMs, signal: cancel })
      if (args.length !== 1 || relative(workspace.path, cwd) !== '') {
        throw new OrchError('FORBIDDEN', '工具不属于获准工作区')
      }
      const scope = { sessionId, workspaceRoot: workspace.path }
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = cancel ? AbortSignal.any([cancel, timeout]) : timeout
      if (bin === 'dsh:workspace.read' && sampleFile && args[0] === sampleFile) {
        const sample = await host.workspaceFiles.read(scope, sampleFile, { offset: 1, limit: 200 }, signal)
        if (!sample.eof || Buffer.byteLength(sample.text, 'utf8') > 16 * 1024) {
          throw new OrchError('RANGE_TOO_LARGE', '验收样本应不超过 200 行和 16 KiB')
        }
        return { exitCode: 0, stdout: sample.text, stderr: '', boundary: 'dsh_workspace_rpc' }
      }
      if (bin === 'dsh:workspace.list' && options.allowWorkspaceListing && args[0] === '.') {
        const listing = await host.workspaceFiles.list(scope, '.', signal)
        const visible = listing.entries.filter((item) => !item.name.startsWith('.'))
        return { exitCode: 0, stdout: JSON.stringify({ entries: visible.slice(0, 200), truncated: listing.truncated || visible.length > 200 }), stderr: '',
          boundary: 'dsh_workspace_rpc' }
      }
      throw new OrchError('FORBIDDEN', '工具不属于获准工作区')
    },
  }, workspace.path)
  let service: LocalService | undefined
  service = await serve({
    dbFile, secret, phase: 'S6', tools: { registry, runner }, preferNamedPipe: true, taskTriggersWritable: false,
    projectContext,
    resolveHttpHuman: (req) => req.headers['x-orchestra-local-proof'] === proof ? { id: human } : null,
    dsh: { context: host, parentForNode: () => projectAuthorized() ? parent() : undefined, models: [], executionPermissionMode,
      sessionExecutionModelRef: () => {
        const agent = parent()
        const selection = agent && projectAuthorized() ? currentModel(agent) : undefined
        return sessionModelRef(selection)
      },
      loadModelCatalog: async () => {
        const catalog = await host.sessionController.modelCatalog()
        const selection = currentModel(parent())
        return { profiles: modelsFor(catalog, selection), session_execution_model_ref: sessionModelRef(selection),
          unavailable_providers: catalog.failures?.map(({ id, name }) => name || id) ?? [] }
      },
      recommend: () => ({ complexity: 'routine', reason: '使用此宿主已批准的 DSH 默认执行模型。' }) },
    dshPlanner: { parent, model: currentModel, useModelRoutingSettings: true, executionPermissionMode },
    asOfSeq: () => Number(service?.orchestra.db.raw.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events').get()?.n ?? 0),
    listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => { throw new OrchError('FORBIDDEN', '个人面板不提供原始账本写入') },
  }).catch(async (error) => {
    await commandHost?.close()
    throw error
  })
  if (commandHost) {
    const close = service.close
    service.close = async () => {
      try { await close() } finally { await commandHost.close() }
    }
  }
  return { service, secret, proof }
}

export function installLocalDshHost(ctx: Context, options: LocalOptions, serve: Serve, nativeChat = true): void {
  const dependencies = ['agents', 'llm', 'tools', 'connection', 'credentials', 'workspaceRegistry', 'sessionController']
  if (options.allowWorkspaceListing || options.sampleFile) dependencies.push('workspaceFiles')
  ctx.inject(dependencies, (ready) => {
    const host = ready as LocalHost
    const human = `local-dsh:${userInfo().username}`
    // 同时打开的编排服务上限。超过上限只在没有可回收会话时拒绝，并说明占用了多少。
    const MAX_SERVICES = 8
    type Lease = {
      startup: ReturnType<typeof openLocalService>
      sessionId: string
      inflight: number
      lastUsed: number
      released: boolean
      closed: boolean
      service?: LocalService
    }
    const services = new Map<string, Lease>()
    const stop = new AbortController()
    let chatRouting: ReturnType<typeof createNativeChatRoutingSettings> | undefined
    const profileDir = (ctx.get('profileContext') as Profile | undefined)?.dir
    const commandSettings = nativeChat && profileDir && isAbsolute(profileDir) ? createNativeCommandSettings(profileDir) : undefined
    const checkCommand = (agent: Agent, name: string, signal: AbortSignal) => checkNativeTaskCommand(name, agent, agent.session.header.cwd, signal, {
      commands: host.get('commands'), skills: host.get('skills'),
    })
    const executionPermissions = profileDir && isAbsolute(profileDir) ? createExecutionPermissionSettings(profileDir) : undefined
    const executionPermissionMode = (): ExecutionPermissionMode => {
      if (!executionPermissions) throw new OrchError('SERVICE_UNAVAILABLE', '此宿主没有可用的执行权限设置')
      return executionPermissions.read().mode
    }
    const identityFor = (workspace: Workspace, sessionId: string) => sha256Hex(JSON.stringify([workspace.id, workspace.path, sessionId, human]))
    const bindingFor = (agent: Agent) => {
      const { id, header } = agent.session
      if (stop.signal.aborted || !localListener(host)
        || header.origin === 'subagent' || header.parentSession || host.agents.get(id) !== agent
        || host.workspaceRegistry.archivedSessionIds.includes(id)) return
      const owners = host.workspaceRegistry.list().filter((workspace) => workspace.sessionIds.includes(id))
      const workspace = owners[0]
      if (owners.length !== 1 || !workspace || !header.cwd || relative(workspace.path, header.cwd) !== '') return
      return { identity: identityFor(workspace, id), workspaceId: workspace.id, sessionId: id }
    }
    // 未终态的运行仍需要这个服务继续收发；有它们时不回收。
    const liveRuns = (service: LocalService) => {
      const row = service.orchestra.db.raw.prepare(
        `SELECT COUNT(*) AS n FROM runs WHERE status NOT IN (${RUN_TERMINAL.map((status) => `'${status}'`).join(',')})`).get() as { n?: number } | undefined
      return Number(row?.n ?? 0)
    }
    const closeLease = async (identity: string, lease: Lease) => {
      if (lease.closed) return
      lease.closed = true
      services.delete(identity)
      try { (await lease.startup).service.close() } catch { /* 启动失败或已关闭 */ }
    }
    const maybeRelease = async (identity: string, lease: Lease) => {
      if (!lease.released || lease.inflight > 0 || lease.closed) return
      const settled = lease.service
      if (!settled) return
      try { if (liveRuns(settled) > 0) return } catch { return }
      await closeLease(identity, lease)
    }
    const serviceFor = (workspace: Workspace, sessionId: string) => {
      if (stop.signal.aborted) throw new OrchError('SERVICE_UNAVAILABLE', '编排服务正在停止')
      const identity = identityFor(workspace, sessionId)
      const existing = services.get(identity)
      if (existing) {
        existing.lastUsed = Date.now()
        return existing
      }
      if (services.size >= MAX_SERVICES) {
        // 只回收已关闭会话且没有在途请求与运行的闲置服务；仍在使用中的不抢占。
        const idle = [...services.entries()].filter(([, lease]) => lease.released && lease.inflight === 0 && !lease.closed
          && lease.service && liveRuns(lease.service) === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
        if (idle) void closeLease(idle[0], idle[1])
        else throw new OrchError('SERVICE_UNAVAILABLE', `同时打开的编排会话已达上限 ${MAX_SERVICES} 个，且没有可回收的闲置会话`, {
          capacity: MAX_SERVICES, reason: 'session_capacity',
        })
      }
      const startup = openLocalService(host, options, workspace, sessionId, identity, human, serve, executionPermissionMode)
      const lease: Lease = { startup, sessionId, inflight: 0, lastUsed: Date.now(), released: false, closed: false }
      services.set(identity, lease)
      void startup.then(({ service }) => { lease.service = service },
        () => { if (services.get(identity) === lease) services.delete(identity) })
      return lease
    }
    const readChatArtifact = async (location: ArtifactReceiptLocation, identity: string) => {
      const authorized = () => {
        const workspace = selectedWorkspace(host, location.workspaceId, location.sessionId)
        const agent = host.agents.get(location.sessionId as Agent['session']['id'])
        const binding = agent && bindingFor(agent)
        if (!workspace || identityFor(workspace, location.sessionId) !== identity || binding?.identity !== identity
          || binding.workspaceId !== location.workspaceId || binding.sessionId !== location.sessionId)
          throw new OrchError('FORBIDDEN', '原会话或工作区授权已改变。请回到原会话重新打开成果。')
        return workspace
      }
      const workspace = authorized()
      const lease = serviceFor(workspace, location.sessionId)
      lease.inflight += 1
      try {
        const { service } = await lease.startup
        authorized()
        const run = getRun(service.orchestra.db, location.runId, { includeAcceptanceArtifactIds: true })
        if (run.task_id !== location.taskId) throw new OrchError('FORBIDDEN', '成果不属于此任务。请从原会话打开。')
        const item = getArtifactContent(service.orchestra.db, location.runId, location.artifactId, 'download', Date.now()).item
        if (item.kind !== 'download' || item.sha256 !== location.sha256)
          throw new OrchError('CONFIRMATION_MISMATCH', '成果版本已改变。请从原会话重新核对成果。')
        const title = acceptedArtifactTitle(run.delivery_checks?.items ?? [], location.artifactId, item.sha256)
        return { fileName: item.file_name, title, bytes: Buffer.from(item.base64, 'base64'), sha256: item.sha256 }
      } finally {
        lease.inflight -= 1
        lease.lastUsed = Date.now()
        void maybeRelease(identity, lease)
      }
    }
    const artifactBrowser = createArtifactBrowserReader({ read: readChatArtifact })
    const releaseSession = (sessionId: string) => {
      for (const [identity, lease] of [...services]) {
        if (lease.sessionId !== sessionId) continue
        lease.released = true
        void maybeRelease(identity, lease)
      }
    }
    host.on('agent/disposed', ({ agent }) => { releaseSession(agent.session.id) })
    host.on('agent/created', ({ agent }) => {
      // 同一会话重新打开时沿用原账本；此前回收过的服务按需重建。
      for (const lease of services.values()) if (lease.sessionId === agent.session.id) lease.released = false
      return undefined
    })
    host.effect(() => async () => {
      stop.abort()
      await artifactBrowser.close()
      await Promise.allSettled([...services.entries()].map(async ([identity, lease]) => {
        lease.closed = true
        services.delete(identity)
        await (await lease.startup).service.close()
      }))
    }, 'Orchestra personal services')
    if (nativeChat) host.inject(['systemPrompt', 'sessions', 'webServer'], (chatCtx) => {
      const settings = profileDir && isAbsolute(profileDir) ? createNativeChatRoutingSettings(profileDir) : undefined
      const complete = createDshSemanticInterpreter(host.llm)
      installNativeChat(chatCtx, {
        operator: human,
        signal: stop.signal,
        ...(profileDir && isAbsolute(profileDir) && { draftCheckpoints: createSemanticDraftCheckpoints(profileDir,
          identity => ledgerSecret(host, identity, join(localDataDirectory(options), identity + '.sqlite'))) }),
        async interpret(input, agent, signal, assertCurrent) {
          if (!complete) throw new OrchError('SERVICE_UNAVAILABLE', '当前模型服务没有可用的任务理解接口，请检查服务后重试', { reason: 'semantic_unavailable' })
          const fallback = host.get('agentDefaultModel') as { currentSelection(): Model | undefined } | undefined
          const selection = agent.model.current() ?? fallback?.currentSelection()
          return complete(selection, input, signal, assertCurrent)
        },
        autoRouteEnabled() {
          if (!settings) throw new OrchError('SERVICE_UNAVAILABLE', '无法读取此 Desktop 用户的自动接管设置')
          return settings.read().enabled
        },
        commandName() { return commandSettings?.read().name ?? DEFAULT_TASK_COMMAND },
        async assertCommandAvailable(_binding, agent, name, signal) {
          if (!commandSettings) return
          const check = await checkCommand(agent, name, AbortSignal.any([signal, AbortSignal.timeout(5_000)]))
          if (commandSettings.read().name !== name) throw new OrchError('STALE_GENERATION', '任务命令已变更，请使用设置中的当前命令重试')
          if (!check.available) throw new OrchError('COMMAND_BUSY', `/${name} 与已有命令或技能冲突，请在 Orchestra 设置中更换任务命令`)
        },
        bindingFor,
        hasService(binding) {
          return services.has(binding.identity) || existsSync(join(localDataDirectory(options), `${binding.identity}.sqlite`))
        },
        async serviceFor(binding) {
          const workspace = selectedWorkspace(host, binding.workspaceId, binding.sessionId)
          if (!workspace || identityFor(workspace, binding.sessionId) !== binding.identity) {
            throw new OrchError('FORBIDDEN', '工作区会话授权已失效')
          }
          return (await serviceFor(workspace, binding.sessionId).startup).service
        },
        async acquireService(binding) {
          const workspace = selectedWorkspace(host, binding.workspaceId, binding.sessionId)
          if (!workspace || identityFor(workspace, binding.sessionId) !== binding.identity) {
            throw new OrchError('FORBIDDEN', '工作区会话授权已失效')
          }
          const lease = serviceFor(workspace, binding.sessionId)
          lease.inflight += 1
          let released = false
          const release = () => {
            if (released) return
            released = true
            lease.inflight -= 1
            lease.lastUsed = Date.now()
            void maybeRelease(binding.identity, lease)
          }
          try {
            const { service } = await lease.startup
            stop.signal.throwIfAborted()
            return { service, release }
          } catch (error) { release(); throw error }
        },
      })
      chatCtx.effect(() => {
        chatRouting = settings
        return () => { if (chatRouting === settings) chatRouting = undefined }
      }, 'Orchestra native chat preferences')
    })
    host.connection.fetch.register({ path: routePath, methods: ['GET', 'POST'], requestBody: 'buffered', async fetch(request) {
      if (stop.signal.aborted || request.signal.aborted) return failure(503, 'SERVICE_UNAVAILABLE', '编排请求已取消')
      if (!localAuthority(request) || !localListener(host)) {
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
      if (target.pathname === artifactBrowserPath || target.pathname === artifactDownloadPath) {
        let input: unknown
        try { input = await request.json() } catch { return failure(400, 'PAYLOAD_SCHEMA_INVALID', '成果定位格式无效') }
        const location = artifactReceiptLocation.safeParse(input)
        if (!location.success) return failure(400, 'PAYLOAD_SCHEMA_INVALID', '成果定位格式无效')
        if (location.data.workspaceId !== workspaceId || location.data.sessionId !== sessionId)
          return failure(403, 'FORBIDDEN', '请从成果所属的原会话打开。')
        const resolved = await host.sessionController.resolveAgent(sessionId).catch(() => undefined)
        if (stop.signal.aborted || request.signal.aborted) return failure(503, 'SERVICE_UNAVAILABLE', '成果打开请求已取消')
        const binding = resolved && 'agent' in resolved && resolved.agent ? bindingFor(resolved.agent) : undefined
        if (binding?.workspaceId !== workspaceId || binding.sessionId !== sessionId
          || binding.identity !== identityFor(workspace, sessionId))
          return failure(403, 'FORBIDDEN', '成果需要此工作区的本机用户会话授权。')
        try {
          const content = target.pathname === artifactDownloadPath ? await readChatArtifact(location.data, binding.identity) : undefined
          const result = content ? { kind: 'download', file_name: content.fileName, sha256: content.sha256,
            size_bytes: content.bytes.byteLength, base64: Buffer.from(content.bytes).toString('base64') }
            : await artifactBrowser.open(location.data, binding.identity)
          if (stop.signal.aborted || request.signal.aborted) return failure(503, 'SERVICE_UNAVAILABLE', '成果打开请求已取消')
          return Response.json(okEnvelope(0, result), { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          if (error instanceof OrchError) return failure(error.httpStatus, error.code, error.message)
          return failure(503, 'SERVICE_UNAVAILABLE', '暂时无法打开成果。请稍后在原会话重试。')
        }
      }
      if (target.pathname === executionPermissionsPath) {
        const settings = executionPermissions
        if (!settings) return failure(404, 'NOT_FOUND', '此宿主未提供执行权限设置')
        let input: unknown
        if (request.method === 'POST') {
          try { input = await request.json() } catch {
            return failure(400, 'PAYLOAD_SCHEMA_INVALID', '执行权限设置格式无效')
          }
        }
        const resolved = await host.sessionController.resolveAgent(sessionId).catch(() => undefined)
        if (stop.signal.aborted || request.signal.aborted) return failure(503, 'SERVICE_UNAVAILABLE', '执行权限设置请求已取消')
        const binding = resolved && 'agent' in resolved && resolved.agent ? bindingFor(resolved.agent) : undefined
        if (binding?.workspaceId !== workspaceId || binding.sessionId !== sessionId
          || binding.identity !== identityFor(workspace, sessionId)) {
          return failure(403, 'FORBIDDEN', '执行权限设置需要此工作区的本机用户会话')
        }
        try {
          const update = request.method === 'POST' ? executionPermissionUpdate.safeParse(input) : undefined
          if (update && !update.success) return failure(400, 'PAYLOAD_SCHEMA_INVALID', '执行权限设置格式无效')
          const view = update ? settings.save(update.data) : settings.read()
          return Response.json(okEnvelope(0, view), { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          if (error instanceof OrchError && error.code === 'STALE_GENERATION') return failure(409, error.code, error.message)
          return failure(503, 'SERVICE_UNAVAILABLE', '暂时无法确认执行权限设置')
        }
      }
      if (target.pathname === taskCommandPath || target.pathname === taskCommandCheckPath) {
        if (!commandSettings || !chatRouting) return failure(404, 'NOT_FOUND', '此宿主未启用任务命令设置')
        try {
          const input: unknown = request.method === 'POST' ? await request.json() : undefined
          const parsed = request.method === 'POST'
            ? (target.pathname === taskCommandCheckPath ? nativeCommandCheck : nativeCommandUpdate).safeParse(input) : undefined
          if (parsed && !parsed.success) return failure(400, 'PAYLOAD_SCHEMA_INVALID', '命令需为 1–32 位小写字母、数字、连字符或下划线，并以字母开头')
          const resolved = await host.sessionController.resolveAgent(sessionId)
          if (!('agent' in resolved) || !resolved.agent) return failure(403, 'FORBIDDEN', '任务命令设置需要此工作区的本机用户会话')
          const agent = resolved.agent
          const assertCurrent = () => {
            stop.signal.throwIfAborted(); request.signal.throwIfAborted()
            const binding = bindingFor(agent)
            if (!chatRouting || binding?.workspaceId !== workspaceId || binding.sessionId !== sessionId
              || binding.identity !== identityFor(workspace, sessionId)) throw new OrchError('FORBIDDEN', '工作区会话授权已失效')
          }
          assertCurrent()
          const before = commandSettings.read()
          const name = parsed?.success ? parsed.data.name : before.name
          const check = await checkCommand(agent, name, AbortSignal.any([stop.signal, request.signal, AbortSignal.timeout(5_000)]))
          assertCurrent()
          if (target.pathname === taskCommandCheckPath) return Response.json(okEnvelope(0, check), { headers: { 'cache-control': 'no-store' } })
          if (parsed?.success && !check.available) return failure(409, 'COMMAND_BUSY', `/${name} 已被命令或技能占用，请更换名称`)
          const view = parsed?.success ? commandSettings.save(nativeCommandUpdate.parse(parsed.data)) : commandSettings.read()
          if (view.name !== name) return failure(409, 'STALE_GENERATION', '任务命令已更新，请重新读取')
          return Response.json(okEnvelope(0, { ...view, check }), { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          if (error instanceof OrchError) return failure(ERROR_STATUS[error.code as keyof typeof ERROR_STATUS] ?? 503, error.code, error.message)
          if (error instanceof SyntaxError) return failure(400, 'PAYLOAD_SCHEMA_INVALID', '任务命令设置格式无效')
          return failure(503, 'SERVICE_UNAVAILABLE', '暂时无法检查或保存任务命令，请重新读取')
        }
      }
      if (target.pathname === chatRoutingPath) {
        const settings = chatRouting
        if (!settings) return failure(404, 'NOT_FOUND', '此宿主未启用原生聊天接管设置')
        let input: unknown
        if (request.method === 'POST') {
          try { input = await request.json() } catch {
            return failure(400, 'PAYLOAD_SCHEMA_INVALID', '自动接管设置格式无效')
          }
        }
        const resolved = await host.sessionController.resolveAgent(sessionId).catch(() => undefined)
        if (stop.signal.aborted || request.signal.aborted || chatRouting !== settings) {
          return failure(503, 'SERVICE_UNAVAILABLE', '自动接管设置请求已取消')
        }
        const binding = resolved && 'agent' in resolved && resolved.agent ? bindingFor(resolved.agent) : undefined
        if (binding?.workspaceId !== workspaceId || binding.sessionId !== sessionId
          || binding.identity !== identityFor(workspace, sessionId)) {
          return failure(403, 'FORBIDDEN', '自动接管设置需要此工作区的本机用户会话')
        }
        try {
          const update = request.method === 'POST' ? nativeChatRoutingUpdate.safeParse(input) : undefined
          if (update && !update.success) return failure(400, 'PAYLOAD_SCHEMA_INVALID', '自动接管设置格式无效')
          const view = update ? settings.save(update.data) : settings.read()
          return Response.json(okEnvelope(0, view), { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          if (error instanceof OrchError && error.code === 'STALE_GENERATION') return failure(409, error.code, error.message)
          return failure(503, 'SERVICE_UNAVAILABLE', '暂时无法确认自动接管设置')
        }
      }
      if (request.method === 'POST' && target.pathname === '/v1/runs/start') {
        return failure(403, 'FORBIDDEN', '个人宿主请使用「用自然语言规划任务」，注明要使用的已发布流程及交付物，核对计划后再启动。')
      }
      const identity = identityFor(workspace, sessionId)
      let lease: Lease | undefined
      try {
        lease = serviceFor(workspace, sessionId)
        // 在途请求计入租约，回收判定不会打断正在执行的命令。
        lease.inflight += 1
        const { service, secret, proof } = await lease.startup
        const signal = AbortSignal.any([request.signal, stop.signal])
        signal.throwIfAborted()
        if (!selectedWorkspace(host, workspaceId, sessionId)) return failure(403, 'FORBIDDEN', '工作区会话授权已失效')
        const headers = new Headers({ 'x-orchestra-secret': secret, 'x-orchestra-local-proof': proof })
        const contentType = request.headers.get('content-type')
        if (contentType) headers.set('content-type', contentType)
        const endpoint = new URL(target.pathname + target.search, service.endpoint)
        const stream = target.pathname === '/v1/events/stream'
        const lastEventId = stream ? request.headers.get('last-event-id') : null
        if (lastEventId !== null) headers.set('last-event-id', lastEventId)
        const pipe = stream ? undefined : service.controlPipe
        const body = pipe && request.method === 'POST' && request.body
          ? new Uint8Array(await request.clone().arrayBuffer()) : undefined
        const response = (pipe ? await requestControlPipe(pipe, endpoint, { method: request.method, headers, signal, body }) : undefined)
          ?? await fetch(endpoint, {
          method: request.method, headers, signal, redirect: 'error',
          ...(request.method === 'POST' && request.body ? { body: request.body, duplex: 'half' } : {}),
        })
        const forwarded = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        for (const name of responseHeaders) {
          const value = response.headers.get(name)
          if (value) forwarded.set(name, value)
        }
        if (request.method === 'GET' && target.pathname === '/health' && response.ok && (chatRouting || executionPermissions)) {
          const health = await response.json() as { ok?: boolean; data?: Record<string, unknown> }
          if (health.ok && health.data) {
            if (chatRouting) health.data.native_chat_routing_enabled = true
            if (chatRouting && commandSettings) health.data.native_command_settings_enabled = true
            if (executionPermissions) health.data.native_execution_permissions_enabled = true
          }
          return Response.json(health, { status: response.status, headers: forwarded })
        }
        return new Response(response.body, { status: response.status, headers: forwarded })
      } catch (error) {
        // 容量与授权原因原样透出，不再统一提示用户去检查会话或默认模型。
        if (error instanceof OrchError) {
          return failure(ERROR_STATUS[error.code as keyof typeof ERROR_STATUS] ?? 503, error.code, error.message)
        }
        return failure(503, 'SERVICE_UNAVAILABLE', '编排服务未就绪。请确认 DSH 会话和默认模型可用')
      } finally {
        if (lease) {
          lease.inflight -= 1
          lease.lastUsed = Date.now()
          void maybeRelease(identity, lease)
        }
      }
    } })
  })
}
