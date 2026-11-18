import { ApiError, type ApiClient } from './client.ts'
import { newOperationId } from './workflow-commands.ts'
import type { OperationRow } from './types.ts'

export type RecoveryChoice = 'confirm_applied' | 'confirm_not_applied' | 'abandon' | 'acknowledge_abandon'
export type MemoryRecoveryView = {
  batch_id: string
  decision_id: string
  revision: number
  stopped_at: string
  evidence_id: string
  written_count: number
  missing_count: number
  allowed_resolutions: RecoveryChoice[]
}

export function createMemoryRecoveryApi(client: ApiClient) {
  return {
    async inspect(batchId: string) {
      return (await client.post<MemoryRecoveryView>('/v1/memory/recovery/inspect', { batch_id: batchId })).data
    },
    async resolve(proof: MemoryRecoveryView, resolution: RecoveryChoice) {
      const { batch_id, decision_id, revision, stopped_at, evidence_id } = proof
      const operationId = newOperationId()
      try {
        await client.post('/v1/memory/recovery/resolve', {
          batch_id, decision_id, revision, stopped_at, evidence_id, resolution, operation_id: operationId,
        })
      } catch (error) {
        if (!(error instanceof ApiError) || !['OPERATION_TIMEOUT', 'OPERATION_OUTCOME_UNKNOWN', 'SERVICE_UNAVAILABLE'].includes(error.code)) throw error
        try {
          const receipt = await client.get<OperationRow>('/v1/operations/get', { operation_id: operationId })
          if (receipt.data.status === 'applied') return
        } catch { /* Do not infer an outcome from a missing receipt. */ }
        throw new ApiError('OPERATION_OUTCOME_UNKNOWN', '恢复结果暂不可确认，请刷新查看', true, { operation_id: operationId })
      }
    },
  }
}

export type MemoryRecoveryApi = ReturnType<typeof createMemoryRecoveryApi>
