/** These choices add Orchestra policy. Host guards and task constraints still apply. */
export const EXECUTION_PERMISSION_MODES = ['full', 'inherit', 'brain', 'user'] as const
export type ExecutionPermissionMode = (typeof EXECUTION_PERMISSION_MODES)[number]
export type ExecutionPermissionView = { mode: ExecutionPermissionMode; revision: number }
export const DEFAULT_EXECUTION_PERMISSION_MODE: ExecutionPermissionMode = 'full'
