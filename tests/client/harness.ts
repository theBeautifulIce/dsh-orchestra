// 面板测试的最小夹具：没有 testing-library，只用 react-dom/client + react 的 act。
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
import type { FetchLike } from '../../src/client/api/client.ts'
import type { Page } from '../../src/client/api/resources.ts'
import type { DecisionView, NodeRunView, RunSummary, TaskSummary, UnverifiedEffectView, WorkflowListItem } from '../../src/client/api/types.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export type FakeQuery = { path: string; params: URLSearchParams }

export type FakeReply =
  | { ok: true; data: unknown; asOfSeq?: number }
  | { ok: false; error: { code: string; message: string; retryable: boolean; details?: unknown } }

export type FakeService = {
  fetcher: FetchLike
  calls: FakeQuery[]
  lastCall: () => FakeQuery | undefined
}

/** 假服务：按路径返回信封，handler 抛错就当网络断了。 */
export function createFakeService(handler: (query: FakeQuery) => FakeReply | Promise<FakeReply>): FakeService {
  const calls: FakeQuery[] = []
  const fetcher: FetchLike = async (input) => {
    const url = new URL(String(input))
    const query: FakeQuery = { path: url.pathname, params: url.searchParams }
    calls.push(query)
    const reply = await handler(query)
    const body = reply.ok
      ? { ok: true, schema_version: 1, as_of_seq: reply.asOfSeq ?? 1, data: reply.data }
      : { ok: false, schema_version: 1, as_of_seq: 1, error: reply.error }
    return { ok: reply.ok, status: reply.ok ? 200 : 503, json: async () => body } as unknown as Response
  }
  return { fetcher, calls, lastCall: () => calls[calls.length - 1] }
}

export function page<T>(items: T[], nextCursor: string | null = null): Page<T> {
  return { items, next_cursor: nextCursor }
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

export type PanelView = {
  container: HTMLElement
  text: () => string
  findAll: (selector: string) => Element[]
  byRole: (role: string) => Element[]
  flush: () => Promise<void>
  rerender: (node: ReactNode) => Promise<void>
  click: (element: Element) => Promise<void>
  unmount: () => void
}

/** 把一段界面挂到 jsdom 上，返回按文本/角色取值的句柄。 */
export async function renderPanel(node: ReactNode): Promise<PanelView> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(node) })
  return {
    container,
    text: () => container.textContent ?? '',
    findAll: (selector) => Array.from(container.querySelectorAll(selector)),
    byRole: (role) => Array.from(container.querySelectorAll('[' + 'role="' + role + '"]')),
    flush: async () => {
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
    },
    rerender: async (next) => { await act(async () => { root.render(next) }) },
    click: async (element) => { await act(async () => { (element as HTMLElement).click() }) },
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

export function taskSummary(over: Partial<TaskSummary> = {}): TaskSummary {
  return {
    task_id: 't1',
    title: '任务一',
    workflow_id: 'wf1',
    workflow_version: 1,
    status: 'running',
    display_status: 'running',
    current_run_id: 'r1',
    session_id: null,
    run_count: 1,
    open_decision_count: 0,
    oldest_open_decision_age_seconds: null,
    unverified_count: 0,
    max_side_effect_level: 'compensable',
    max_heartbeat_age_ms: 1200,
    attention: 'running',
    attention_reason: '任务仍在执行',
    updated_at: '2026-11-17T10:00:00.000Z',
    archived_at: null,
    trigger_kind: null,
    autonomy: 'autonomous',
    current_run_status: 'running',
    ...over,
  }
}

export function runSummary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: 'r1',
    task_id: 't1',
    workflow_id: 'wf1',
    workflow_version: 1,
    status: 'running',
    display_status: 'running',
    settling: false,
    revision: 1,
    counts: [],
    total: 0,
    top_nodes: [],
    last_event_seq: 1,
    as_of_seq: 1,
    created_at: '2026-11-17T10:00:00.000Z',
    updated_at: '2026-11-17T10:00:00.000Z',
    ...over,
  }
}

export function nodeRunView(over: Partial<NodeRunView> = {}): NodeRunView {
  return {
    node_run_id: 'nr1',
    run_id: 'r1',
    node_id: 'n1',
    node_type: 'tool',
    attempt: 1,
    status: 'started',
    display_status: 'running',
    status_label: '已开跑，等回写',
    revision: 1,
    side_effect_policy: 'compensable',
    side_effect_verified_none: false,
    declared_effect: null,
    verified_effect: null,
    evidence_strength: null,
    evidence_state: 'none',
    evidence_state_reason: '没有工具执行记录。',
    execution_ids: [],
    execution_count: 0,
    projection_missing: [],
    attestation_id: null,
    action_start_source: null,
    stop_evidence: null,
    hang_reason: null,
    recovery_uncertain: null,
    replacement_node_run_id: null,
    heartbeat_at: null,
    started_at: '2026-11-17T10:00:00.000Z',
    created_at: '2026-11-17T10:00:00.000Z',
    updated_at: '2026-11-17T10:00:00.000Z',
    active_decision_ids: [],
    ...over,
  }
}

export function decisionView(over: Partial<DecisionView> = {}): DecisionView {
  return {
    decision_id: 'd1',
    run_id: 'r1',
    node_run_id: 'nr1',
    kind: 'pre_execution',
    status: 'pending',
    current_revision: 1,
    closed_reason: null,
    payload: null,
    content_hash: 'content-hash-1',
    expires_at: null,
    confirm_required: false,
    created_at: '2026-11-17T10:00:00.000Z',
    decided_at: null,
    priority: 'normal',
    priority_reason: '动手前要先确认',
    allowed_resolutions: ['continue', 'abort'],
    required_evidence: ['命令清单'],
    target_summary: '确认这一步要不要执行',
    projection_missing: [],
    ...over,
  }
}

export function effectView(over: Partial<UnverifiedEffectView> = {}): UnverifiedEffectView {
  return {
    run_id: 'r1',
    node_run_id: 'nr1',
    node_id: 'n1',
    status: 'completed',
    side_effect_policy: 'compensable',
    side_effect_verified_none: false,
    stop_evidence: null,
    started_at: '2026-11-17T09:00:00.000Z',
    created_at: '2026-11-17T09:00:00.000Z',
    age_seconds: 120,
    resolved: false,
    resolved_at: null,
    resolution_basis: null,
    ...over,
  }
}

export function workflowItem(over: Partial<WorkflowListItem> = {}): WorkflowListItem {
  return {
    workflow_id: 'wf1',
    name: '流程一',
    status: 'active',
    scope: 'reusable',
    owner_task_id: null,
    current_version: 3,
    has_draft: false,
    draft_revision: null,
    node_count: 4,
    active_task_count: 2,
    published_at: '2026-11-17T09:00:00.000Z',
    updated_at: '2026-11-17T10:00:00.000Z',
    projection_missing: [],
    ...over,
  }
}
