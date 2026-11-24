import type { TaskNextAction, TaskSummary } from '../../service/queries/tasks.ts'
import type { RunSummary } from '../../service/queries/runs.ts'
import type { NodeRunView } from '../../service/queries/nodes.ts'
import type { DecisionView } from '../../service/queries/decisions.ts'
import type { UnverifiedEffectView } from '../../service/queries/effects.ts'
import type { WorkflowListItem, WorkflowVersionView, WorkflowView } from '../../service/queries/workflows.ts'
import type { EvidenceView } from '../../service/queries/evidence.ts'
import type { ArtifactContentMode, ArtifactContentView, ArtifactView, RunArtifact } from '../../service/queries/artifacts.ts'
import type { AttestationView } from '../../service/queries/attestations.ts'
import type { LedgerVerify } from '../../service/queries/verify_ledger.ts'
import type { OperationRow } from '../../service/queries/get_operation.ts'

export type {
  TaskSummary, TaskNextAction, RunSummary, NodeRunView, DecisionView, UnverifiedEffectView,
  WorkflowListItem, WorkflowVersionView, WorkflowView, EvidenceView, ArtifactView, AttestationView,
  LedgerVerify, RunArtifact, ArtifactContentMode, ArtifactContentView,
  OperationRow,
}

/** 记忆批次状态：规格 §9.10 的枚举，面板只按这十二个状态说话。 */
export type MemoryBatchStatus =
  | 'draft'
  | 'evaluating'
  | 'awaiting_human'
  | 'approved'
  | 'applying'
  | 'applied'
  | 'empty'
  | 'blocked'
  | 'declined'
  | 'expired'
  | 'failed'
  | 'indeterminate'

/** 记忆条目状态：规格 §9.10。 */
export type MemoryItemStatus = 'proposed' | 'approved' | 'skipped' | 'applied' | 'failed'

/** 一条记忆条目。默认视图只显示标题、层与一句话摘要；全文与来源点开才看。 */
export type MemoryItemView = {
  client_key: string
  layer: string
  title: string
  digest: string
  content: string | null
  source: string | null
  status: MemoryItemStatus
  verdict: string | null
  judge_reason: string | null
}

/** 一次记忆整理批次。面板只读这个投影，不自己推算写入结果。 */
export type MemoryBatchView = {
  batch_id: string
  task_id: string
  status: MemoryBatchStatus
  attempt: number
  outcome: string | null
  total_count: number
  pending_count: number
  applied_count: number
  skipped_count: number
  items: MemoryItemView[]
  evaluation_id: string | null
  proposal_hash: string | null
  decision_id: string | null
  decision_revision: number | null
  allowed_resolutions: string[] | null
  recovery_available?: boolean
  error_message: string | null
  created_at: string
  updated_at: string
}

/** 审批卡上的一条建议。 */
export type MemoryApprovalCardItem = {
  layer: string
  title: string
  digest: string
  judge_reason: string | null
}

/** 审批卡上的一个按钮；resolution 由服务端给出，前端不自己拼。 */
export type MemoryApprovalCardButton = {
  label: string
  resolution: string
}

/** 服务端 buildApprovalCard 落到决定 payload 里的审批卡（规格 §9.6）。 */
export type MemoryApprovalCard = {
  kind: 'audit_result'
  title: string
  summary_line: string
  items: MemoryApprovalCardItem[]
  buttons: MemoryApprovalCardButton[]
  allowed_resolutions: string[]
  resolve_payload: Record<string, unknown>
  expand_label: string
  batch_id: string | null
  evaluation_id: string | null
  proposal_hash: string | null
}

export type EventView = {
  seq: number
  event_id: string
  type: string
  occurred_at: string
  boot_id: string | null
  monotonic_ns: number | null
  run_id: string | null
  node_run_id: string | null
  decision_id: string | null
  payload_redacted: string | null
  payload_ref: string | null
}
