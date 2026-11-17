import type { ApiClient, ApiResult } from './client.ts'
import type {
  ArtifactView, AttestationView, DecisionView, EventView, EvidenceView, LedgerVerify, NodeRunView, OperationRow,
  RunSummary, TaskSummary, UnverifiedEffectView, WorkflowListItem, WorkflowVersionView, WorkflowView,
} from './types.ts'

export type Page<T> = { items: T[]; next_cursor: string | null }
export type ListTasksParams = { limit?: number; cursor?: string; status?: string; query?: string; attention?: string }
export type ListDecisionsParams = { run_id?: string; status?: string; limit?: number; cursor?: string }
export type ListWorkflowsParams = { limit?: number; cursor?: string; status?: string; query?: string; owner_task_id?: string }
export type ListEventsParams = { from_seq?: number; limit?: number; cursor?: string }

const compact = (params: Record<string, string | number | undefined>) => params

/** Typed read-only API surface used by the panel; transport and envelope handling stay in ApiClient. */
export function createResourcesApi(client: ApiClient) {
  return {
    listTasks: (params: ListTasksParams = {}): Promise<ApiResult<Page<TaskSummary>>> =>
      client.get('/v1/tasks', compact(params)),
    getTask: (task_id: string): Promise<ApiResult<TaskSummary>> =>
      client.get('/v1/tasks/get', { task_id }),
    listRuns: (params: { task_id?: string; limit?: number } = {}): Promise<ApiResult<{ items: RunSummary[] }>> =>
      client.get('/v1/runs', compact(params)),
    getRun: (run_id: string): Promise<ApiResult<RunSummary>> =>
      client.get('/v1/runs/get', { run_id }),
    listNodes: (run_id: string, limit?: number): Promise<ApiResult<{ items: NodeRunView[] }>> =>
      client.get('/v1/node-runs', { run_id, limit }),
    getNode: (node_run_id: string): Promise<ApiResult<NodeRunView>> =>
      client.get('/v1/node-runs/get', { node_run_id }),
    listDecisions: (params: ListDecisionsParams = {}): Promise<ApiResult<Page<DecisionView>>> =>
      client.get('/v1/decisions', compact(params)),
    getDecision: (decision_id: string): Promise<ApiResult<DecisionView>> =>
      client.get('/v1/decisions/get', { decision_id }),
    listUnverifiedEffects: (params: { run_id?: string; limit?: number; cursor?: string } = {}): Promise<ApiResult<Page<UnverifiedEffectView>>> =>
      client.get('/v1/effects/unverified', compact(params)),
    getEvidence: (evidence_id: string): Promise<ApiResult<EvidenceView>> =>
      client.get('/v1/evidence/get', { evidence_id }),
    getArtifact: (artifact_id: string): Promise<ApiResult<ArtifactView>> =>
      client.get('/v1/artifacts/get', { artifact_id }),
    getAttestation: (attestation_id: string): Promise<ApiResult<AttestationView>> =>
      client.get('/v1/attestations/get', { attestation_id }),
    verifyLedger: (): Promise<ApiResult<LedgerVerify>> => client.get('/v1/ledger/verify'),
    listEvents: (params: ListEventsParams = {}): Promise<ApiResult<Page<EventView>>> =>
      client.get('/v1/events', compact(params)),
    listWorkflows: (params: ListWorkflowsParams = {}): Promise<ApiResult<Page<WorkflowListItem>>> =>
      client.get('/v1/workflows', compact(params)),
    getWorkflow: (workflow_id: string): Promise<ApiResult<WorkflowView>> =>
      client.get('/v1/workflows/get', { workflow_id }),
    getWorkflowVersion: (workflow_id: string, version: number): Promise<ApiResult<WorkflowVersionView>> =>
      client.get('/v1/workflows/versions/get', { workflow_id, version }),
    getOperation: (operation_id: string): Promise<ApiResult<OperationRow>> =>
      client.get('/v1/operations/get', { operation_id }),
  }
}

export type ResourcesApi = ReturnType<typeof createResourcesApi>
