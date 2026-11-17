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

/** Reject direct memory mutation in any allow-list; governed writes use the private bridge. */
export function assertNoMemoryWriteTool(allow: readonly string[]): void {
  for (const ref of allow) {
    const name = ref.startsWith(MEMORY_TOOL_PREFIX) ? ref.slice(MEMORY_TOOL_PREFIX.length) : ref
    if ((MEMORY_WRITE_TOOLS as readonly string[]).includes(name)) {
      throw new OrchError('MEMORY_WRITE_TOOL_FORBIDDEN', '记忆只能从受控通道写入，不许直接调写工具', { tool: ref })
    }
  }
}
