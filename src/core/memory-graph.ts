import { OrchError } from './errors.ts'

export const MEMORY_BRIDGE_ID = 'memory-audit-v1'
export const MEMORY_TOOL_PREFIX = 'memory_bridge:'

export const MEMORY_GRAPH = [
  ['mem_trigger', 'mem_prepare'],
  ['mem_prepare', 'mem_check'],
  ['mem_check', 'mem_route'],
  ['mem_route', 'mem_confirm'],
  ['mem_confirm', 'mem_apply'],
  ['mem_apply', 'mem_report'],
  ['mem_route', 'mem_report_empty'],
  ['mem_route', 'mem_report_blocked'],
] as const

export const MEMORY_TOOLS = {
  evaluate: `${MEMORY_TOOL_PREFIX}memory.evaluate`,
  applyGoverned: `${MEMORY_TOOL_PREFIX}memory.apply_governed`,
  inspectBatch: `${MEMORY_TOOL_PREFIX}memory.inspect_batch`,
} as const

export const MEMORY_WRITE_TOOLS = ['memory_write', 'memory_update'] as const

/** 端口能力：read_only 端口不改状态，mutating 端口会改状态（不可逆标记单列）。 */
export type MemoryPortCapability = 'read_only' | 'mutating'

/**
 * 端口固定能力表的唯一声明处（规格 §9.2 端口能力表）。
 * executor（src/executor/tools.ts）与固定图声明源（src/core/memory-graph-schema.ts）
 * 都引用这一份，避免两份副本漂移。
 */
export const MEMORY_PORT_CAPABILITIES: Readonly<Record<string, { capability: MemoryPortCapability; irreversible: boolean }>> = {
  [MEMORY_TOOLS.evaluate]: { capability: 'read_only', irreversible: false },
  [MEMORY_TOOLS.applyGoverned]: { capability: 'mutating', irreversible: true },
  [MEMORY_TOOLS.inspectBatch]: { capability: 'read_only', irreversible: false },
}

/** Reject direct memory mutation in any allow-list; governed writes use the private bridge. */
export function assertNoMemoryWriteTool(allow: readonly string[]): void {
  for (const ref of allow) {
    const name = ref.startsWith(MEMORY_TOOL_PREFIX) ? ref.slice(MEMORY_TOOL_PREFIX.length) : ref
    if ((MEMORY_WRITE_TOOLS as readonly string[]).includes(name)) {
      throw new OrchError('MEMORY_WRITE_TOOL_FORBIDDEN', '记忆只能从受控通道写入，不许直接调写工具', { tool: ref })
    }
  }
}

/** 会被检查的三个面（规格 9.1 的硬边界） */
export type MemoryToolSurface = 'workflow' | 'executor' | 'task_session'

/**
 * 三个面共用的写工具禁令闸：命中就抛 MEMORY_WRITE_TOOL_FORBIDDEN，
 * details 里带上是哪个面拦的，方便定位是哪条 allow 漏了写工具。
 */
export function assertNoMemoryWriteToolOnSurface(allow: readonly string[], surface: MemoryToolSurface): void {
  try {
    assertNoMemoryWriteTool(allow)
  } catch (err) {
    if (err instanceof OrchError && err.code === 'MEMORY_WRITE_TOOL_FORBIDDEN') {
      throw new OrchError('MEMORY_WRITE_TOOL_FORBIDDEN', err.message, { ...err.details, surface })
    }
    throw err
  }
}

/** 任务会话面的 allow 闸：任务会话里出现直接写工具就拒 */
export function assertTaskSessionToolsAllowed(allow: readonly string[]): void {
  assertNoMemoryWriteToolOnSurface(allow, 'task_session')
}
