export type TaskTriggerView = {
  trigger_id: string
  task_id: string
  title: string
  workflow_id: string
  workflow_version: string
  kind: 'scheduled' | 'event'
  enabled: boolean
  revision: number
  daily_time: string | null
  time_zone: string | null
  event_type: string | null
  next_fire_at: string | null
  last_fired_at: string | null
  created_at: string
  updated_at: string
}

export type TaskTriggerCreate = {
  operation_id: string
  title: string
  workflow_id: string
  workflow_version: string
  autonomy?: 'autonomous' | 'assisted' | 'supervised'
} & (
  | { kind: 'scheduled'; daily_time: string; time_zone: string }
  | { kind: 'event'; event_type: string }
)

export type TaskTriggerOccurrence = {
  trigger_id: string
  task_id: string
  due_at: string
  run_id: string | null
  status: 'started' | 'skipped'
  reason: 'task_archived' | 'previous_run_active' | 'unresolved_effects' | 'workflow_inactive' | null
}
