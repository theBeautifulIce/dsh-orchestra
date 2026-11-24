import type { ApiClient, ApiResult } from './client.ts'
import type { TaskLane, TaskOrigin } from '../../core/task-workspace.ts'
import type { TaskPlanView } from '../../service/task-planning.ts'
import type { TaskTriggerView } from '../../core/task-trigger.ts'
import type { ExecutionEntry } from '../../service/queries/execution-history.ts'
import type {
  ArtifactContentMode, ArtifactContentView, ArtifactView, AttestationView, DecisionView, EventView, EvidenceView, LedgerVerify, MemoryBatchView, NodeRunView,
  OperationRow, RunArtifact, RunSummary, TaskSummary, UnverifiedEffectView, WorkflowListItem, WorkflowVersionView, WorkflowView,
} from './types.ts'

export type Page<T> = { items: T[]; next_cursor: string | null }
export type ListTasksParams = {
  limit?: number; cursor?: string; status?: string; query?: string; attention?: string; lane?: TaskLane
  trigger_kind?: TaskOrigin | 'unknown'; archived?: '1'; updated_from?: string; updated_before?: string
}
export type ListDecisionsParams = { run_id?: string; status?: string; inbox?: 'human'; limit?: number; cursor?: string }
export type ListWorkflowsParams = { limit?: number; cursor?: string; status?: string; scope?: string; query?: string; published?: 1; owner_task_id?: string }
export type ListEventsParams = { from_seq?: number; limit?: number; cursor?: string }
export type ListMemoryBatchesParams = { task_id?: string; limit?: number; cursor?: string }
export type ActivityItem = Pick<EventView, 'seq' | 'event_id' | 'type' | 'occurred_at' | 'run_id' | 'node_run_id' | 'decision_id'> & {
  details?: ExecutionEntry['details']; attention?: boolean
}
export type EffectReview = {
  node_run_id: string; run_id: string; revision: number
  evidence: Array<{ evidence_id: string; tool: string; exit_code: number; finished_at: string; verdict: 'applied' | 'not_applied' }>
}

const compact = (params: Record<string, string | number | undefined>) => params

/** Typed read-only API surface used by the panel; transport and envelope handling stay in ApiClient. */
export function createResourcesApi(client: ApiClient) {
  return {
    getReworkTopology: (run_id: string) => client.get<import('./rework.ts').RunTopology>('/v1/rework/topology', { run_id }),
    listRework: (run_id?: string) => client.get<{ items: import('./rework.ts').ReworkItem[] }>('/v1/rework', { run_id }),
    getRework: (request_id: string) => client.get<{ item: import('./rework.ts').ReworkDetail }>('/v1/rework/get', { request_id }),
    getWorkspaceOverview: () => client.get<import('../../service/queries/tasks.ts').WorkspaceOverview>('/v1/workspace/overview'),
    listTasks: (params: ListTasksParams = {}): Promise<ApiResult<Page<TaskSummary>>> =>
      client.get('/v1/tasks', compact(params)),
    getTask: (task_id: string): Promise<ApiResult<TaskSummary>> =>
      client.get('/v1/tasks/get', { task_id }),
    getPlanningProgress: () => client.get<{items:import('../../service/chat-planning-progress.ts').PlanningProgress[]}>('/v1/task-plans/progress'),
    revokePlanMaterial: (plan_id:string,content_hash:string,material_id:string) =>
      client.post<{revoked:boolean}>('/v1/task-plans/materials/revoke',{plan_id,content_hash,material_id}),
    getTaskPlanCapability: (): Promise<ApiResult<{ enabled: boolean }>> => client.get('/v1/task-plans/capability'),
    getTaskPlan: (plan_id: string): Promise<ApiResult<TaskPlanView>> => client.get('/v1/task-plans/get', { plan_id }),
    getTaskPlanForTask: (task_id: string): Promise<ApiResult<TaskPlanView | null>> => client.get('/v1/task-plans/by-task', { task_id }),
    listPlanDrafts: (task_id?: string, cursor?: string): Promise<ApiResult<{ items: TaskPlanView[]; next_cursor?: string | null }>> =>
      client.get('/v1/task-plans/drafts', compact({ task_id, cursor })),
    listTaskTriggers: (params: { task_id?: string } = {}): Promise<ApiResult<{ items: TaskTriggerView[] }>> =>
      client.get('/v1/task-triggers', compact(params)),
    listRuns: (params: { task_id?: string; workflow_id?: string; limit?: number; cursor?: string } = {}): Promise<ApiResult<{ items: RunSummary[]; next_cursor?: string | null }>> =>
      client.get('/v1/runs', compact(params)),
    getRun: (run_id: string): Promise<ApiResult<RunSummary>> =>
      client.get('/v1/runs/get', { run_id }),
    listNodes: (run_id: string, limit?: number, cursor?: string, only?: 'attention'):
    Promise<ApiResult<{ items: NodeRunView[]; has_more?: boolean; next_cursor?: string | null }>> =>
      client.get('/v1/node-runs', { run_id, limit, cursor, only }),
    getNode: (node_run_id: string): Promise<ApiResult<NodeRunView>> =>
      client.get('/v1/node-runs/get', { node_run_id }),
    listDecisions: (params: ListDecisionsParams = {}): Promise<ApiResult<Page<DecisionView>>> =>
      client.get('/v1/decisions', compact(params)),
    // 记忆批次只读：面板不写记忆，也不发任何写命令。
    listMemoryBatches: (params: ListMemoryBatchesParams = {}): Promise<ApiResult<Page<MemoryBatchView>>> =>
      client.get('/v1/memory/batches', compact(params)),
    getDecision: (decision_id: string): Promise<ApiResult<DecisionView>> =>
      client.get('/v1/decisions/get', { decision_id }),
    listUnverifiedEffects: (params: { run_id?: string; limit?: number; cursor?: string } = {}): Promise<ApiResult<Page<UnverifiedEffectView>>> =>
      client.get('/v1/effects/unverified', compact(params)),
    getEffectReview: (node_run_id: string): Promise<ApiResult<EffectReview>> => client.get('/v1/effects/review', { node_run_id }),
    getEvidence: (evidence_id: string): Promise<ApiResult<EvidenceView>> =>
      client.get('/v1/evidence/get', { evidence_id }),
    getArtifact: (artifact_id: string): Promise<ApiResult<ArtifactView>> =>
      client.get('/v1/artifacts/get', { artifact_id }),
    getArtifactContent: (run_id: string, artifact_id: string, mode: ArtifactContentMode): Promise<ApiResult<ArtifactContentView>> =>
      client.get('/v1/artifacts/content', { run_id, artifact_id, mode }),
    listRunArtifacts: (run_id: string, options: { cursor?: string; file_name?: string } = {}):
    Promise<ApiResult<{ items: RunArtifact[]; has_more: boolean; next_cursor: string | null }>> =>
      client.get('/v1/artifacts', { run_id, cursor: options.cursor, file_name: options.file_name }),
    getAttestation: (attestation_id: string): Promise<ApiResult<AttestationView>> =>
      client.get('/v1/attestations/get', { attestation_id }),
    verifyLedger: (): Promise<ApiResult<LedgerVerify>> => client.get('/v1/ledger/verify'),
    listEvents: (params: ListEventsParams = {}): Promise<ApiResult<Page<EventView>>> =>
      client.get('/v1/events', compact(params)),
    listActivity: (params: { run_id?: string; task_id?: string; before_seq?: number; limit?: number; filter?: 'all' | 'attention' } = {}): Promise<ApiResult<{ items: ActivityItem[]; next_before_seq: number | null }>> =>
      client.get('/v1/activity', compact(params)),
    listExecutionHistory: (params: { run_id?: string; task_id?: string; node_run_id?: string; before?: number; limit?: number;
      filter?: 'all' | 'attention' | 'tool' | 'report' | 'model' }): Promise<ApiResult<{ items: ExecutionEntry[]; next_before: number | null }>> =>
      client.get('/v1/execution-history', compact(params)),
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
