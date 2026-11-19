export const TASK_ORIGINS = ['manual', 'scheduled', 'event', 'continuous'] as const
export type TaskOrigin = (typeof TASK_ORIGINS)[number]

export const TASK_LANES = [
  { id: 'upcoming', label: '接下来' }, { id: 'running', label: '正在做' },
  { id: 'attention', label: '需要你' }, { id: 'finished', label: '最近完成' },
] as const
export type TaskLane = (typeof TASK_LANES)[number]['id']
