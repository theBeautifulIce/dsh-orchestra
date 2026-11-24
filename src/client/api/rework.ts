import { ApiError, type ApiClient } from './client.ts'
import { newOperationId } from './workflow-commands.ts'
import type { OperationRow } from './types.ts'
import type { ReworkRequest, ReworkAttempt, ReworkReview as ReviewRecord } from '../../service/rework-coordinator.ts'
import type { ReworkFileManifest } from '../../service/rework-manifest.ts'
import type { InspectionInput, InspectionResult, ReworkInspection } from '../../service/rework-inspection.ts'
export type ReworkItem = ReworkRequest & { source_artifact_count?: number }
export type ReworkDetail = {
  request: ReworkRequest
  attempts: ReworkAttempt[]
  reviews: ReviewRecord[]
  impacts?: Array<{ node_id: string; node_run_id: string; replacement_node_run_id: string | null; reason: string; released_at: string | null }>
  dispatch_blocks?: Array<{ node_id: string; node_run_id: string; reason: string; message: string; resolved_at: string | null }>
}

export type RunTopology = {
  edges: Array<{ from: string; to: string }>
  steps: Array<{ node_id: string; before_node_id: string; instruction: string }>
  requests: Array<{ request_id: string; target_node_id: string; status: string; round_no: number }>
  held_node_ids: string[]
}

export type ReworkScope = 'targeted_revision' | 'rerun_node' | 'replan_subgraph'
export type ReworkPlan = { plan_hash: string; proposal: { reason: string; changes: Array<{ node_id: string; instruction: string }>; preserved_node_ids: string[]; additional_edges?: Array<{from:string;to:string}>; insert_steps?: Array<{node_id:string;before_node_id:string;instruction:string}> }; revision: number }
export type ReviewHold = { run_id: string; node_id: string; node_run_id: string; status: 'held' | 'accepted' | 'withdrawn';
  artifact_id: string | null; sha256: string | null
  /** 读到的留验身份：提交时原样带回，服务端据此拒绝旧页签的结论（D04）。 */
  hold_id: string | null
  revision: number
  reviewed_files?: Array<{ artifact_id: string; sha256: string; file_name: string | null }>
  pending?: string[] }
export type ReworkRequestInput = { run_id: string; target_node_run_id: string; source_artifact_id: string; source_artifact_hash: string; reason: string; expected_result: string; preserve_requirements: string[]; suggested_scope: ReworkScope; evidence_ids: string[]; expected_revision: number; file_manifest?: ReworkFileManifest }
export type ReworkReviewInput = { request_id: string; expected_revision: number; action: 'authorize' | 'set_manifest' | 'reject' | 'reject_final' | 'accept' | 'request_changes' | 'escalate'; note: string; artifact_id?: string; artifact_hash?: string; file_manifest?: ReworkFileManifest }

/** Ambiguous writes recover the original receipt; they never resend the command. */
export function createReworkApi(client: ApiClient) {
  async function command<T>(path: string, body: object): Promise<T> {
    const operation_id = newOperationId()
    try { return (await client.post<T>(path, { ...body, operation_id })).data } catch (error) {
      if (!(error instanceof ApiError) || !['OPERATION_TIMEOUT', 'OPERATION_OUTCOME_UNKNOWN', 'SERVICE_UNAVAILABLE'].includes(error.code)) throw error
      try {
        const { data } = await client.get<OperationRow>('/v1/operations/get', { operation_id })
        if (data.status === 'applied' && data.receipt_json) {
          const receipt = JSON.parse(data.receipt_json) as { result?: T }
          return (receipt.result ?? receipt) as T
        }
      } catch { /* Preserve the original operation ID for manual recovery. */ }
      throw new ApiError('OPERATION_OUTCOME_UNKNOWN', '提交结果待确认，请查回执后再操作', true, { operation_id })
    }
  }
  return {
    request: (input: ReworkRequestInput) => command<ReworkItem>('/v1/rework/request', input),
    inspect: (input: Omit<InspectionInput, 'operation_id'>) => command<InspectionResult>('/v1/rework/inspect', input),
    listInspections: (run_id: string) => client.get<{items: ReworkInspection[]}>('/v1/rework/inspections', {run_id}),
    review: (input: ReworkReviewInput) => command<ReworkItem>('/v1/rework/review', input),
    plan: (input: { request_id: string; expected_revision: number }) => command('/v1/rework/plan', input),
    getPlan: (request_id: string) => client.get<{ plan: ReworkPlan | null }>('/v1/rework/plan', { request_id }),
    approvePlan: (input: { request_id: string; expected_revision: number; plan_hash: string }) => command('/v1/rework/plan/approve', input),
    listHolds: (run_id: string) => client.get<{ items: ReviewHold[] }>('/v1/rework/holds', { run_id }),
    hold: (input: { run_id: string; node_run_id: string; action: 'hold' | 'accept' | 'withdraw'; artifact_id?: string; sha256?: string
      hold_id?: string; expected_revision?: number }) => command('/v1/rework/hold', input),
    getOperation: (operation_id: string) => client.get<OperationRow>('/v1/operations/get', { operation_id }),
  }
}
export type ReworkApi = ReturnType<typeof createReworkApi>
