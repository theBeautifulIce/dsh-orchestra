// src/executor/tools.ts —— 工具注册表与 capability 推导（规格 4.7 行 371-399）
import { relative, resolve, sep } from 'node:path'
import { sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { MEMORY_PORT_CAPABILITIES, MEMORY_TOOL_PREFIX } from '../core/memory-graph.ts'

export type ToolCapability = 'read_only' | 'mutating' | 'compensating'
export type SideEffectPolicy = 'pure' | 'compensable' | 'irreversible'

export type EffectVerdict = 'applied' | 'not_applied'
export type EffectVerificationTarget = {
  workflow_definition_hash: string
  node_id: string
  node_run_id: string
  run_id: string
  attempt: number
}
export type EffectVerifier = {
  id: string
  workflowDefinitionHash: string
  nodeId: string
  cwd?: string
  /** Interpret the actual read-only tool output for this specific action instance. */
  verify: (target: Readonly<EffectVerificationTarget>, output: { stdout: string; stderr: string }) =>
    { verdict: EffectVerdict; reference: string } | null
}

export type ToolDescriptor = {
  name: string
  capability: ToolCapability
  // 固定命令：只读执行时用它，argv 不经 shell（规格 7.2 行 588）
  command: { bin: string; args: string[] }
  // 补偿描述符：mutating 工具要声明 compensable 就必须给，而且要可执行
  compensation?: { tool: string; args: string[]; verify: { command: string; args: string[] } }
  effectVerifier?: EffectVerifier
}

export type MemoryPort = {
  name: string
  capability: 'read_only' | 'mutating'
  irreversible?: boolean
  invoke: (args: Record<string, unknown>) => Promise<unknown>
}

/** 端口固定能力表：数值只声明在 src/core/memory-graph.ts，这里只引用。 */

/** Internal-only registry: memory bridge ports never enter the executor shell-tool registry. */
export class MemoryBridgeRegistry {
  private readonly ports = new Map<string, MemoryPort>()

  register(port: MemoryPort): void {
    const ref = `${MEMORY_TOOL_PREFIX}${port.name}`
    const expected = MEMORY_PORT_CAPABILITIES[ref]
    if (!expected) throw new OrchError('TOOL_NOT_REGISTERED', '记忆端口不在固定注册表里', { tool: ref })
    if (port.capability !== expected.capability || (port.irreversible === true) !== expected.irreversible) {
      throw new OrchError('SIDE_EFFECT_UNDECLARED', '记忆端口能力声明与固定策略不一致', {
        tool: ref,
        expected_capability: expected.capability,
        expected_irreversible: expected.irreversible,
      })
    }
    this.ports.set(ref, port)
  }

  lookup(ref: string): MemoryPort | undefined {
    if (!ref.startsWith(MEMORY_TOOL_PREFIX)) return undefined
    return this.ports.get(ref)
  }

  require(ref: string): MemoryPort {
    const found = this.lookup(ref)
    if (!found) throw new OrchError('TOOL_NOT_REGISTERED', '记忆端口没注册', { tool: ref })
    return found
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>()

  register(descriptor: ToolDescriptor): void {
    if (descriptor.name.startsWith(MEMORY_TOOL_PREFIX)) {
      throw new OrchError('FORBIDDEN', '记忆桥端口只能进入专用注册表', { tool: descriptor.name })
    }
    if (descriptor.effectVerifier && descriptor.capability !== 'read_only') {
      throw new OrchError('SIDE_EFFECT_UNDECLARED', '副作用核实器必须是只读工具', { tool: descriptor.name })
    }
    this.tools.set(descriptor.name, descriptor)
  }

  lookup(name: string): ToolDescriptor | undefined {
    return this.tools.get(name)
  }

  // 查不到一律 TOOL_NOT_REGISTERED（规格 4.7 行 399）
  require(name: string): ToolDescriptor {
    const found = this.tools.get(name)
    if (!found) throw new OrchError('TOOL_NOT_REGISTERED', '工具没注册', { tool: name })
    return found
  }

  list(): ToolDescriptor[] {
    return Array.from(this.tools.values())
  }
}

// 执行前的授权核对：真正要跑的工具必须已注册、落在 allow 集合里、且不在 deny 集合里
// deny 永远优先（规格 5.2 行 444-445；第四轮审计 M2：策略与执行集此前没有交集）
export function assertToolsAuthorized(
  registry: ToolRegistry,
  policy: { allow?: string[]; deny?: string[] },
  tools: { command: string }[],
): void {
  const allow = new Set(policy.allow ?? [])
  const deny = new Set(policy.deny ?? [])
  for (const tool of tools) {
    if (deny.has(tool.command)) {
      throw new OrchError('FORBIDDEN', '工具在禁用清单里，不许执行', { tool: tool.command })
    }
    registry.require(tool.command)
    if (!allow.has(tool.command)) {
      throw new OrchError('FORBIDDEN', '工具不在授权清单里，不许执行', {
        tool: tool.command,
        allow: Array.from(allow),
      })
    }
  }
}

// 补偿描述符可执行 = 有补偿工具名、有参数、有验证命令
export function hasExecutableCompensation(tool: ToolDescriptor): boolean {
  if (!tool.compensation) return false
  if (tool.compensation.tool.length === 0) return false
  if (tool.compensation.verify.command.length === 0) return false
  return true
}

// 前向 effective capability 三条（规格 4.7 行 393-395）：
// 只含 read_only → pure；含 mutating 且有可执行补偿描述符 → compensable；
// 含 mutating 且无可执行补偿描述符 → irreversible
export function deriveEffectiveCapability(tools: ToolDescriptor[]): SideEffectPolicy {
  for (const tool of tools) {
    if (tool.capability === 'compensating') {
      // 补偿工具不许出现在前向路径（规格 4.7 行 376）
      throw new OrchError('COMPENSATION_TOOL_IN_FORWARD_PATH', '补偿工具不能出现在前向路径里', { tool: tool.name })
    }
  }
  if (tools.length === 0) return 'pure'
  if (tools.every((t) => t.capability === 'read_only')) return 'pure'
  const mutating = tools.filter((t) => t.capability === 'mutating')
  if (mutating.length === 0) return 'pure'
  const allCompensable = mutating.every((t) => hasExecutableCompensation(t))
  return allCompensable ? 'compensable' : 'irreversible'
}

// 作者声明只许往更严的一侧写（规格 4.7 行 396-399）
// 声明 pure 而推导更宽 → 拒；声明 compensable 而补偿描述符不可执行 → 拒；
// 声明 compensable 而推导 pure → 拒（声明比推导宽）；声明 irreversible 而推导更宽 → 接受，按 irreversible 算
export function resolveDeclaredPolicy(declared: SideEffectPolicy, derived: SideEffectPolicy, mutatingTools: ToolDescriptor[]): SideEffectPolicy {
  if (declared === 'pure' && derived !== 'pure') {
    throw new OrchError('SIDE_EFFECT_UNDECLARED', '声明 pure 但推导不是 pure', { declared, derived })
  }
  if (declared === 'compensable') {
    const unexecutable = mutatingTools.filter((t) => !hasExecutableCompensation(t)).map((t) => t.name)
    if (unexecutable.length > 0) {
      throw new OrchError('COMPENSATION_UNEXECUTABLE', '声明 compensable 但补偿描述符不可执行', { declared, derived, tools: unexecutable })
    }
    if (derived === 'pure') {
      throw new OrchError('SIDE_EFFECT_UNDECLARED', '声明 compensable 但推导是 pure，声明比推导宽', { declared, derived })
    }
  }
  // 声明 irreversible 而推导更宽：接受并按 irreversible 算（规格 4.7 行 399）
  return declared === 'irreversible' ? 'irreversible' : derived
}

// —— 只读执行器与强证据（规格 7.2 行 588、4.7 行 380-384）——

export type ToolExecutionBoundary = 'windows_appcontainer_bfs' | 'dsh_workspace_rpc'

// Execution confinement belongs to the trusted host. Existing host receipts may omit the boundary.
export type HostRunner = {
  readonlyAvailable(bin?: string): boolean
  run(input: { bin: string; args: string[]; cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<{
    exitCode: number
    stdout: string
    stderr: string
    boundary?: ToolExecutionBoundary
  }>
}

// cwd 必须在工作区内，越界即拒（规格 7.2 行 588）
export function resolveInside(root: string, target: string): string {
  const rootAbs = resolve(root)
  const targetAbs = resolve(rootAbs, target)
  if (targetAbs !== rootAbs && !targetAbs.startsWith(rootAbs + sep)) {
    throw new OrchError('FORBIDDEN', 'cwd 越出工作区', { root: rootAbs, target: targetAbs })
  }
  return targetAbs
}

export type StrongEvidence = {
  // 来源标记：run_tool 是强证据，模型侧 tool_result 是弱证据（规格 4.7 行 380-383）
  source: 'run_tool'
  boundary?: ToolExecutionBoundary
  exitCode: number
  stdoutHash: string
  stderrHash: string
  hashes: Record<string, string>
  producedAt: string
  // 命令名与命令哈希：收口时和 tool_executions 的 tool/command_hash 对齐
  tool: string
  commandHash: string
}

export type RunToolParams = {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
  workspaceRoot: string
  signal?: AbortSignal
}

export type RunToolResult = {
  evidence: StrongEvidence
  stdout: string
  stderr: string
}

// 命令哈希：把命令与参数固定成一段可核对的串。
// 给了工作区根时 cwd 归一成相对路径：同一命令在不同临时工作区重跑哈希不变（审计 N1）
export function commandHashOf(command: string, args: string[], cwd: string, root?: string): string {
  const where = root === undefined ? cwd : relative(resolve(root), resolve(cwd))
  return sha256Hex(JSON.stringify({ command, args, cwd: where }))
}

export class ReadOnlyToolRunner {
  private readonly registry: ToolRegistry
  private readonly host: HostRunner
  private readonly workspaceRoot: string

  constructor(registry: ToolRegistry, host: HostRunner, workspaceRoot: string) {
    this.registry = registry
    this.host = host
    this.workspaceRoot = workspaceRoot
  }

  // 执行器只在自己挂载的根里跑，调用方要核命令哈希时得拿到同一个根
  get root(): string { return this.workspaceRoot }
  readonlyAvailable(command?: string): boolean {
    if (command === undefined) return this.host.readonlyAvailable()
    const descriptor = this.registry.lookup(command)
    return descriptor?.capability === 'read_only' && this.host.readonlyAvailable(descriptor.command.bin)
  }

  async runTool(params: RunToolParams): Promise<RunToolResult> {
    // 命令必须命中注册表，且 capability 必须是 read_only
    const descriptor = this.registry.lookup(params.command)
    if (!descriptor) {
      throw new OrchError('RUN_TOOL_NOT_READ_ONLY', '命令没注册，不许按只读执行', { command: params.command })
    }
    if (descriptor.capability !== 'read_only') {
      throw new OrchError('RUN_TOOL_NOT_READ_ONLY', '命令不是只读命令', {
        command: params.command,
        capability: descriptor.capability,
      })
    }
    // 宿主没有只读挂载就报，不降级（规格 4.7 行 381）
    if (!this.host.readonlyAvailable(descriptor.command.bin)) {
      throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '宿主没有只读挂载，强证据不可得', {
        command: params.command,
      })
    }
    const cwd = resolveInside(this.workspaceRoot, params.cwd)
    // argv 不经 shell：参数只认注册表里的固定数组，请求里的 args 不许覆盖（第五轮审计 P1-2）
    const args = descriptor.command.args
    params.signal?.throwIfAborted()
    const res = await this.host.run({
      bin: descriptor.command.bin,
      args,
      cwd,
      timeoutMs: params.timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
    })
    const evidence: StrongEvidence = {
      source: 'run_tool',
      ...(res.boundary ? { boundary: res.boundary } : {}),
      exitCode: res.exitCode,
      stdoutHash: sha256Hex(res.stdout),
      stderrHash: sha256Hex(res.stderr),
      hashes: { stdout: sha256Hex(res.stdout), stderr: sha256Hex(res.stderr) },
      producedAt: new Date().toISOString(),
      tool: params.command,
      commandHash: commandHashOf(descriptor.command.bin, args, cwd, this.workspaceRoot),
    }
    return { evidence, stdout: res.stdout, stderr: res.stderr }
  }
}

// 落库前核对命令哈希：对不上就当证据不足（规格 7.2 行 588、4.7 行 379）
export function assertCommandHash(evidence: StrongEvidence, expected: string): void {
  if (evidence.commandHash !== expected) {
    throw new OrchError('VERIFICATION_TOO_WEAK', '命令哈希对不上，证据不作数', {
      got: evidence.commandHash,
      expect: expected,
    })
  }
}
