import type { TaskTriggerCreate, TaskTriggerOccurrence, TaskTriggerView } from '../../core/task-trigger.ts'
import type { ApiClient } from './client.ts'
import { postWithOperationReceipt } from './commands.ts'
import { newOperationId } from './workflow-commands.ts'

export function createTaskTriggerCommands(client: ApiClient) {
  return {
    create: (body: TaskTriggerCreate) => postWithOperationReceipt(client, '/v1/task-triggers', 'task.trigger_create', body),
    setEnabled: (item: TaskTriggerView, enabled: boolean, operationId = newOperationId()) =>
      postWithOperationReceipt(client, '/v1/task-triggers/enabled', 'task.trigger_set_enabled', {
        trigger_id: item.trigger_id, operation_id: operationId, expected_revision: item.revision, enabled,
      }),
    emit: async (eventType: string, eventId: string) => (await client.post<{ items: TaskTriggerOccurrence[]; replayed: boolean }>(
      '/v1/task-triggers/event', { event_type: eventType, event_id: eventId },
    )).data,
  }
}
