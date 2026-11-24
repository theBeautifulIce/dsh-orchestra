import { TASK_COMMAND_NAME_RE, type TaskCommandCheck, type TaskCommandView } from '../../core/task-command.ts'
import { ApiError, type ApiClient } from './client.ts'

const path = '/v1/settings/task-command'
export function validateTaskCommandCheck(data: TaskCommandCheck): TaskCommandCheck {
  if (!data || typeof data.name !== 'string' || !TASK_COMMAND_NAME_RE.test(data.name)
    || typeof data.available !== 'boolean' || !Array.isArray(data.conflicts)
    || data.available !== (data.conflicts.length === 0)
    || data.conflicts.some(row => !row || row.name !== data.name || typeof row.label !== 'string'
      || !['host_command', 'skill', 'client_command'].includes(row.kind))) {
    throw new ApiError('PROTOCOL_VERSION_MISMATCH', '无法确认任务命令检查结果', false)
  }
  return data
}
export function validateTaskCommandView(data: TaskCommandView): TaskCommandView {
  if (!data || !Number.isSafeInteger(data.revision) || data.revision < 0
    || validateTaskCommandCheck(data.check).name !== data.name) throw new ApiError('PROTOCOL_VERSION_MISMATCH', '无法确认任务命令设置', false)
  return data
}
export function createTaskCommandApi(client: ApiClient) {
  return {
    async read(signal?: AbortSignal) {
      const reply = await client.get<TaskCommandView>(path)
      signal?.throwIfAborted()
      return validateTaskCommandView(reply.data)
    },
    async check(name: string, signal?: AbortSignal) {
      const check = validateTaskCommandCheck((await client.post<TaskCommandCheck>(path + '/check', { name }, signal)).data)
      if (check.name !== name) throw new ApiError('PROTOCOL_VERSION_MISMATCH', '任务命令检查结果已失效', false)
      return check
    },
    async save(name: string, revision: number, signal?: AbortSignal) {
      const saved = validateTaskCommandView((await client.post<TaskCommandView>(path, { name, expected_revision: revision }, signal)).data)
      if (saved.name !== name || !saved.check.available || (saved.revision !== revision + 1 && saved.revision !== revision)) {
        throw new ApiError('OPERATION_OUTCOME_UNKNOWN', '无法确认任务命令是否已保存，请重新读取', true)
      }
      return saved
    },
  }
}
