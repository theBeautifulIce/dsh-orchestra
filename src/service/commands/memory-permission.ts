// src/service/commands/memory-permission.ts —— 记忆写权限闸：三个面的 allow 都不许出现直接写工具
//
// 规格 9.1 的硬边界：记忆只能从受控通道写入，唯一写入口是 memory.apply_governed。
// executor、agent 节点、任务会话模板任何一面出现 memory_write / memory_update 都必须被拒
// （MEMORY_WRITE_TOOL_FORBIDDEN），不依赖 TOOL_NOT_ALLOWED 兜底。
//
// 实现放在 src/core/memory-graph.ts：executor 面（src/executor/session.ts）不能反向依赖 service 层。
// 这里保留既有导出名，作为薄转发。
import { MEMORY_TOOLS } from '../../core/memory-graph.ts'

export type { MemoryToolSurface } from '../../core/memory-graph.ts'
export { assertNoMemoryWriteToolOnSurface, assertTaskSessionToolsAllowed } from '../../core/memory-graph.ts'

/** 唯一受控写入口（写操作只从这里走） */
export const MEMORY_GOVERNED_WRITE_TOOL = MEMORY_TOOLS.applyGoverned

/** 任务会话模板里允许出现的记忆工具：只有发起，没有写 */
export const TASK_SESSION_MEMORY_TOOLS: readonly string[] = ['memory_start_run']
