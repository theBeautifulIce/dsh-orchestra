export const TASK_ORIGINS = ['manual', 'scheduled', 'event', 'continuous'] as const
export type TaskOrigin = (typeof TASK_ORIGINS)[number]

export const TASK_LANES = [
  { id: 'upcoming', label: '待执行' }, { id: 'running', label: '执行中' },
  { id: 'attention', label: '待处理' }, { id: 'finished', label: '已结束' },
] as const
export type TaskLane = (typeof TASK_LANES)[number]['id']
