// src/executor/tools.ts —— 工具注册表与 capability 推导（规格 4.7 行 371-399）
import { OrchError } from '../core/errors.ts'

export type ToolCapability = 'read_only' | 'mutating' | 'compensating'
export type SideEffectPolicy = 'pure' | 'compensable' | 'irreversible'

export type ToolDescriptor = {
  name: string
  capability: ToolCapability
  // 固定命令：只读执行时用它，argv 不经 shell（规格 7.2 行 588）
  command: { bin: string; args: string[] }
  // 补偿描述符：mutating 工具要声明 compensable 就必须给，而且要可执行
  compensation?: { tool: string; args: string[]; verify: { command: string; args: string[] } }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>()

  register(descriptor: ToolDescriptor): void {
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
