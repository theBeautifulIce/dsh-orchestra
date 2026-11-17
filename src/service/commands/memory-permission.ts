// src/service/commands/memory-permission.ts —— 记忆写权限闸：三个面的 allow 都不许出现直接写工具
//
// 规格 9.1 的硬边界：记忆只能从受控通道写入，唯一写入口是 memory.apply_governed。
// executor、agent 节点、任务会话模板任何一面出现 memory_write / memory_update 都必须被拒
// （MEMORY_WRITE_TOOL_FORBIDDEN），不依赖 TOOL_NOT_ALLOWED 兜底。
import { OrchError } from '../../core/errors.ts'
import { MEMORY_TOOLS, assertNoMemoryWriteTool } from '../../core/memory-graph.ts'

/** 会被检查的三个面 */
export type MemoryToolSurface = 'workflow' | 'executor' | 'task_session'

/** 唯一受控写入口（写操作只从这里走） */
export const MEMORY_GOVERNED_WRITE_TOOL = MEMORY_TOOLS.applyGoverned

/** 任务会话模板里允许出现的记忆工具：只有发起，没有写 */
export const TASK_SESSION_MEMORY_TOOLS: readonly string[] = ['memory_start_run']

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

/** 任务会话模板的 allow 闸：模板里出现直接写工具就拒 */
export function assertTaskSessionToolsAllowed(allow: readonly string[]): void {
  assertNoMemoryWriteToolOnSurface(allow, 'task_session')
}
