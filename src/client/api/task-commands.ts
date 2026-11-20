import { ApiError, type ApiClient } from './client.ts'
import { postWithOperationReceipt } from './commands.ts'
import { newOperationId } from './workflow-commands.ts'
import type { TaskPlanView } from '../../service/task-planning.ts'

export function createTaskCommands(client: ApiClient) {
  return {
    async proposeTaskPlan(goal: string, requirements: string[], signal?: AbortSignal) {
      return (await client.post<TaskPlanView>('/v1/task-plans', { goal, requirements }, signal)).data
    },
    async confirmTaskPlan(planId: string, contentHash: string) {
      try {
        return (await client.post<NonNullable<TaskPlanView['launch']>>('/v1/task-plans/confirm', {
          plan_id: planId, content_hash: contentHash, confirmed: true,
        })).data
      } catch (error) {
        if (!(error instanceof ApiError) || !['OPERATION_TIMEOUT', 'OPERATION_OUTCOME_UNKNOWN', 'SERVICE_UNAVAILABLE'].includes(error.code)) throw error
        try {
          const { data } = await client.get<TaskPlanView>('/v1/task-plans/get', { plan_id: planId })
          if (data.content_hash === contentHash && data.launch) return data.launch
        } catch { /* same plan ID remains safe to retry */ }
        throw new ApiError('OPERATION_OUTCOME_UNKNOWN', '这份计划的启动回执暂未确认，可用同一计划重试', true)
      }
    },
    startMemory(runId: string, reason: string, operationId: string) {
      return postWithOperationReceipt(client, '/v1/memory/runs/start', 'memory.start_run', {
        source_run_id: runId, reason, request_key: operationId, operation_id: operationId,
      })
    },
    async setArchived(taskId: string, archived: boolean, expectedArchivedAt: string | null) {
      await postWithOperationReceipt(client, '/v1/tasks/archive', archived ? 'task.archive' : 'task.restore', {
        task_id: taskId, archived, expected_archived_at: expectedArchivedAt, operation_id: newOperationId(),
      })
    },
    async start(input: { operationId: string; title: string; workflowId: string; version: string; autonomy: string }) {
      try {
        return (await client.post<{ task_id: string; run_id?: string }>('/v1/runs/start', {
          taskTitle: input.title, workflowId: input.workflowId, workflowVersion: input.version, autonomy: input.autonomy,
          triggerKind: 'manual', operationId: input.operationId,
        })).data
      } catch (error) {
        if (error instanceof ApiError && ['OPERATION_TIMEOUT', 'OPERATION_OUTCOME_UNKNOWN', 'SERVICE_UNAVAILABLE'].includes(error.code)) {
          throw new ApiError('OPERATION_OUTCOME_UNKNOWN', '建任务结果暂不可确认。使用「查询或重试」保留原请求编号。', true, { operation_id: input.operationId })
        }
        throw error
      }
    },
  }
}

export type TaskCommands = ReturnType<typeof createTaskCommands>
