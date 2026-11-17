import type { TaskSummary } from '../../service/queries/tasks.ts'
import type { RunSummary } from '../../service/queries/runs.ts'
import type { NodeRunView } from '../../service/queries/nodes.ts'
import type { DecisionView } from '../../service/queries/decisions.ts'
import type { UnverifiedEffectView } from '../../service/queries/effects.ts'
import type { WorkflowListItem, WorkflowVersionView, WorkflowView } from '../../service/queries/workflows.ts'
import type { EvidenceView } from '../../service/queries/evidence.ts'
import type { ArtifactView } from '../../service/queries/artifacts.ts'
import type { AttestationView } from '../../service/queries/attestations.ts'
import type { LedgerVerify } from '../../service/queries/verify_ledger.ts'
import type { OperationRow } from '../../service/queries/get_operation.ts'

export type {
  TaskSummary, RunSummary, NodeRunView, DecisionView, UnverifiedEffectView,
  WorkflowListItem, WorkflowVersionView, WorkflowView, EvidenceView, ArtifactView, AttestationView,
  LedgerVerify,
  OperationRow,
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
