import type { NativeChatRoutingView } from '../../service/native-chat-routing-settings.ts'
import { ApiError, type ApiClient } from './client.ts'

const path = '/v1/settings/chat-routing'

function validated(data: NativeChatRoutingView): NativeChatRoutingView {
  if (typeof data?.enabled !== 'boolean' || !Number.isSafeInteger(data.revision) || data.revision < 0) {
    throw new ApiError('PROTOCOL_VERSION_MISMATCH', '无法确认自动接管设置', false)
  }
  return data
}

export function createChatRoutingApi(client: ApiClient) {
  return {
    async read() { return validated((await client.get<NativeChatRoutingView>(path)).data) },
    async save(enabled: boolean, revision: number) {
      const saved = validated((await client.post<NativeChatRoutingView>(path, { enabled, expected_revision: revision })).data)
      if (saved.enabled !== enabled || saved.revision !== revision + 1) {
        throw new ApiError('OPERATION_OUTCOME_UNKNOWN', '无法确认自动接管设置是否已保存', true)
      }
      return saved
    },
  }
}
