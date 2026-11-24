import { EXECUTION_PERMISSION_MODES, type ExecutionPermissionMode, type ExecutionPermissionView } from '../../core/execution-permissions.ts'
import { ApiError, type ApiClient } from './client.ts'

const path = '/v1/settings/execution-permissions'
function validated(data: ExecutionPermissionView): ExecutionPermissionView {
  if (!EXECUTION_PERMISSION_MODES.includes(data?.mode) || !Number.isSafeInteger(data.revision) || data.revision < 0) {
    throw new ApiError('PROTOCOL_VERSION_MISMATCH', '无法确认执行权限设置', false)
  }
  return data
}
export function createExecutionPermissionsApi(client: ApiClient) {
  return {
    async read() { return validated((await client.get<ExecutionPermissionView>(path)).data) },
    async save(mode: ExecutionPermissionMode, revision: number) {
      const saved = validated((await client.post<ExecutionPermissionView>(path, { mode, expected_revision: revision })).data)
      if (saved.mode !== mode || saved.revision !== revision + 1) throw new ApiError('OPERATION_OUTCOME_UNKNOWN', '无法确认执行权限设置是否已保存', true)
      return saved
    },
  }
}
