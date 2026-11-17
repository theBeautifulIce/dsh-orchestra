// src/service/commands/memory.ts —— 记忆支线入口：幂等发起与草稿期条目落库
//
// 规格 9.4：发起只建 run，不写记忆；记忆 run、节点、批次与 (source_run_id, request_key) 映射
// 必须在同一笔事务里提交（不许先建 run 再单独补幂等表）。
// 规格 9.5：提议校验通过后同事务写 memory_items；同目标同内容的重复提议记为跳过，
// 同目标不同内容报 MEMORY_BATCH_CONFLICT。
// 真正写记忆的唯一入口是 memory.apply_governed（受控写入不在本包内）。
import { OrchError } from '../../core/errors.ts'
import { uuidv7 } from '../../core/ids.ts'
import { withTx, type Db, type Tx } from '../../infra/sqlite/driver.ts'
import { appendEvent } from '../../infra/db/ledger.ts'
import {
  assertProposal,
  assertProposalSize,
  canonicalItem,
  contentHash,
  proposalHash,
  resolveTargetConflicts,
  type MemoryItemInput,
} from '../../core/memory-canonical.ts'
import { memoryGraphNodeSpecs } from '../../core/memory-graph-schema.ts'
import { assertOperationId, requestHashOf, runIdempotentCommand } from './idempotency.ts'
import { insertRunInTx } from '../runs.ts'
import { createMemoryRunNodeRuns } from './memory-run.ts'
import { resolveTaskSessionToolPolicy } from '../../executor/session.ts'

/** 记忆 run 固定用的工作流标识（规格 9.3 固定图；图运行时在 S5-F） */
export const MEMORY_WORKFLOW_ID = 'sys.memory_write'
export const MEMORY_WORKFLOW_VERSION = '1'

/** 发起命令在幂等表里的 kind */
export const MEMORY_START_RUN_KIND = 'memory.start_run'

/** 批次终态：不在这个列表里的批次都算「还在进行」 */
export const MEMORY_TERMINAL_BATCH_STATUSES = [
  'applied', 'empty', 'blocked', 'declined', 'expired', 'failed', 'indeterminate',
] as const

const TERMINAL_STATUS_SQL = MEMORY_TERMINAL_BATCH_STATUSES.map((status) => "'" + status + "'").join(', ')

/**
 * 固定图节点的运行面规格：node_id 取固定图 node_id，node_type 取节点 kind（规格 §9.3 的六种）。
 * 唯一声明源是 src/core/memory-graph-schema.ts；顺序用显式拓扑序（memoryGraphOrder），
 * 不用边表首次出现序。记忆节点不走普通 agent 执行器，也不进通用 workflow 节点类型表。
 */
export const MEMORY_GRAPH_NODE_SPECS: ReadonlyArray<{ node_id: string; node_type: string }> = memoryGraphNodeSpecs()

export type StartMemoryRunParams = {
  source_run_id: string
  reason: string
  request_key: string
  retry?: boolean
  /** 幂等键（UUIDv7）：回执走既有幂等表 */
  operation_id: string
  /** 任务会话模板给发起方的 allow：出现直接写工具就拒 */
  caller_allow?: readonly string[]
  now: string
}

export type MemoryRunStartResult = {
  memory_run_id: string
  attempt: number
  batch_id: string
  source_run_id: string
  task_id: string
  replayed: boolean
}

/** 发起请求的哈希口径：只含请求本身，不含调用方的工具上下文 */
type MemoryStartRequestPayload = {
  source_run_id: string
  reason: string
  request_key: string
  retry: boolean
}

/** 发起成功后的结果（replayed 不在这里，由幂等表与映射命中决定） */
type MemoryStartOutcome = Omit<MemoryRunStartResult, 'replayed'>

type SourceRunRow = {
  run_id: string
  task_id: string
  status: string
  root_run_id: string | null
  subworkflow_depth: number
}

type BatchRow = {
  batch_id: string
  memory_run_id: string
  attempt: number
  task_id: string
  status: string
}

const REQUEST_KEY_PATTERN = /^[a-z0-9_-]{1,64}$/

function assertRequestKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
    throw new OrchError('MEMORY_PROPOSAL_INVALID', 'request_key 长度不对', {
      request_key: typeof value === 'string' ? value : null,
    })
  }
  if (!REQUEST_KEY_PATTERN.test(value)) {
    throw new OrchError('MEMORY_PROPOSAL_INVALID', 'request_key 只能是小写字母、数字、下划线和短横线', {
      request_key: value,
    })
  }
  return value
}

function assertReason(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500) {
    throw new OrchError('MEMORY_PROPOSAL_INVALID', 'reason 长度必须为 1 到 500 字', {
      reason: typeof value === 'string' ? value : null,
    })
  }
  return value
}

function payloadOf(params: StartMemoryRunParams): MemoryStartRequestPayload {
  return {
    source_run_id: params.source_run_id,
    reason: params.reason,
    request_key: params.request_key,
    retry: params.retry === true,
  }
}

/**
 * 发起记忆整理（规格 9.4）：
 * ① 同 (source_run_id, request_key) 命中映射就返回同一个 memory_run_id 与 attempt，replayed=true；
 * ② 同源已有未终结记忆批次且换了 key 就报 MEMORY_RUN_ACTIVE（409）；
 * ③ 没有活跃批次才分配 attempt、建记忆 run、建固定图节点、建批次并插映射——四样同一笔事务提交；
 *    上一次批次已经收口时，没有 retry 就把上次的批次原样还回去（不再新建），retry=true 才进下一次 attempt。
 * 只有源运行 succeeded 能发起。
 */
export function startMemoryRun(db: Db, params: StartMemoryRunParams): MemoryRunStartResult {
  const requestKey = assertRequestKey(params.request_key)
  assertReason(params.reason)
  const operationId = assertOperationId(params.operation_id)
  // 发起方是任务会话：它的工具清单走任务会话策略解析（写工具闸 + storages deny）
  if (params.caller_allow) resolveTaskSessionToolPolicy({ allow: [...params.caller_allow] })
  const requestHash = requestHashOf(MEMORY_START_RUN_KIND, payloadOf(params))
  // repeated：这次没有新建记忆 run，只是把上一次的结果原样还回去
  let repeated = false
  return withTx(db, (tx) => {
    const outcome = runIdempotentCommand(tx, {
      kind: MEMORY_START_RUN_KIND, operationId, requestHash, now: params.now,
    }, () => applyMemoryStart(tx, params, requestKey, () => { repeated = true }))
    return { ...outcome.result, replayed: outcome.replayed || repeated }
  })
}

function applyMemoryStart(tx: Tx, params: StartMemoryRunParams, requestKey: string, onRepeat: () => void): MemoryStartOutcome {
  const source = tx.get<SourceRunRow>(
    'SELECT run_id, task_id, status, root_run_id, subworkflow_depth FROM runs WHERE run_id = ?',
    [params.source_run_id],
  )
  if (!source) {
    throw new OrchError('NOT_FOUND', '没找到源运行', { source_run_id: params.source_run_id })
  }
  if (source.status !== 'succeeded') {
    throw new OrchError('MEMORY_SOURCE_RUN_NOT_SETTLED', '源运行还没成功收口，不能整理记忆', {
      source_run_id: params.source_run_id,
      status: source.status,
    })
  }
  // ① 映射命中：同 key 重发（含工具超时后的重试）返回同一个记忆 run
  const mapped = tx.get<{ memory_run_id: string }>(
    'SELECT memory_run_id FROM memory_run_requests WHERE source_run_id = ? AND request_key = ?',
    [params.source_run_id, requestKey],
  )
  if (mapped) {
    const batch = tx.get<BatchRow>(
      'SELECT batch_id, memory_run_id, attempt, task_id, status FROM memory_batches WHERE memory_run_id = ?',
      [mapped.memory_run_id],
    )
    if (!batch) {
      throw new OrchError('MEMORY_BATCH_NOT_FOUND', '记忆批次丢了，映射指不到批次', {
        source_run_id: params.source_run_id,
        request_key: requestKey,
        memory_run_id: mapped.memory_run_id,
      })
    }
    onRepeat()
    return {
      memory_run_id: batch.memory_run_id,
      attempt: batch.attempt,
      batch_id: batch.batch_id,
      source_run_id: params.source_run_id,
      task_id: batch.task_id,
    }
  }
  // ② 同源已有未终结的记忆批次且换了 key：回滚并报 MEMORY_RUN_ACTIVE
  const active = tx.get<BatchRow>(
    'SELECT batch_id, memory_run_id, attempt, task_id, status FROM memory_batches '
    + 'WHERE source_run_id = ? AND status NOT IN (' + TERMINAL_STATUS_SQL + ') ORDER BY attempt DESC LIMIT 1',
    [params.source_run_id],
  )
  if (active) {
    throw new OrchError('MEMORY_RUN_ACTIVE', '这个任务已经有一条记忆整理在进行', {
      source_run_id: params.source_run_id,
      memory_run_id: active.memory_run_id,
      attempt: active.attempt,
      status: active.status,
    })
  }
  // ③ 最近一次批次已经收口：没有 retry 就不重开这次整理，把上次的批次原样还回去；
  //    retry=true 才进下一次 attempt。
  const last = tx.get<BatchRow>(
    'SELECT batch_id, memory_run_id, attempt, task_id, status FROM memory_batches '
    + 'WHERE source_run_id = ? ORDER BY attempt DESC LIMIT 1',
    [params.source_run_id],
  )
  if (last && params.retry !== true) {
    onRepeat()
    return {
      memory_run_id: last.memory_run_id,
      attempt: last.attempt,
      batch_id: last.batch_id,
      source_run_id: params.source_run_id,
      task_id: last.task_id,
    }
  }
  const attempt = (last?.attempt ?? 0) + 1
  const memoryRunId = 'memrun_' + uuidv7().replace(/-/g, '')
  const batchId = 'membatch_' + uuidv7().replace(/-/g, '')
  insertRunInTx(tx, {
    run_id: memoryRunId,
    task_id: source.task_id,
    workflow_id: MEMORY_WORKFLOW_ID,
    workflow_version: MEMORY_WORKFLOW_VERSION,
    workflow_definition_hash: null,
    status: 'running',
    root_run_id: source.root_run_id ?? source.run_id,
    subworkflow_depth: source.subworkflow_depth,
    started_at: params.now,
    created_at: params.now,
    updated_at: params.now,
  })
  // 固定图的节点行跟记忆 run 同一笔事务落库（不另开事务）
  const nodes = createMemoryRunNodeRuns(tx, memoryRunId, params.now)
  const prepareNodeRunId = nodes.find((node) => node.node_id === 'mem_prepare')?.node_run_id ?? null
  tx.run(
    'INSERT INTO memory_batches (batch_id, task_id, source_run_id, memory_run_id, prepare_node_run_id, attempt, status, created_at, updated_at) '
    + "VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
    [batchId, source.task_id, params.source_run_id, memoryRunId, prepareNodeRunId, attempt, params.now, params.now],
  )
  const mappedRow = tx.run(
    'INSERT INTO memory_run_requests (source_run_id, request_key, memory_run_id, created_at) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT (source_run_id, request_key) DO NOTHING',
    [params.source_run_id, requestKey, memoryRunId, params.now],
  )
  if (mappedRow.changes === 0) {
    const other = tx.get<{ memory_run_id: string }>(
      'SELECT memory_run_id FROM memory_run_requests WHERE source_run_id = ? AND request_key = ?',
      [params.source_run_id, requestKey],
    )
    throw new OrchError('MEMORY_RUN_ACTIVE', '这个发起 key 已经被别的记忆整理占用了', {
      source_run_id: params.source_run_id,
      request_key: requestKey,
      memory_run_id: other?.memory_run_id ?? null,
    })
  }
  appendEvent(tx, {
    type: 'memory.run.created',
    runId: memoryRunId,
    payload: {
      memory_run_id: memoryRunId,
      batch_id: batchId,
      source_run_id: params.source_run_id,
      task_id: source.task_id,
      request_key: requestKey,
      attempt,
      reason: params.reason,
    },
  })
  return {
    memory_run_id: memoryRunId,
    attempt,
    batch_id: batchId,
    source_run_id: params.source_run_id,
    task_id: source.task_id,
  }
}

export type SaveMemoryProposalParams = {
  batch_id: string
  items: readonly MemoryItemInput[]
  now: string
}

export type SaveMemoryProposalResult = {
  batch_id: string
  proposal_hash: string
  saved: number
  skipped: number
}

/**
 * 草稿期条目落库（规格 9.5）：先校验再落库，同目标同内容的重复提议记为 skipped，
 * 同目标不同内容报 MEMORY_BATCH_CONFLICT（不写任何条目）。
 * 这一步只写提议，不写记忆；写记忆走 memory.apply_governed。
 */
export function saveMemoryProposal(tx: Tx, params: SaveMemoryProposalParams): SaveMemoryProposalResult {
  const batch = tx.get<{ batch_id: string; status: string }>(
    'SELECT batch_id, status FROM memory_batches WHERE batch_id = ?',
    [params.batch_id],
  )
  if (!batch) {
    throw new OrchError('MEMORY_BATCH_NOT_FOUND', '找不到这条记忆批次', { batch_id: params.batch_id })
  }
  if (batch.status !== 'draft') {
    throw new OrchError('MEMORY_APPLY_BINDING_INVALID', '这条记忆批次已经不是草稿，不能再改提议', {
      batch_id: params.batch_id,
      status: batch.status,
    })
  }
  assertProposalSize(params.items)
  assertProposal(params.items)
  const resolved = resolveTargetConflicts(params.items)
  for (const item of resolved.items) insertMemoryItem(tx, params.batch_id, item, 'proposed')
  for (const item of resolved.skippedDuplicates) insertMemoryItem(tx, params.batch_id, item, 'skipped')
  const hash = proposalHash(params.items)
  tx.run(
    'UPDATE memory_batches SET proposal_hash = ?, skipped_count = ?, updated_at = ? WHERE batch_id = ?',
    [hash, resolved.skippedDuplicates.length, params.now, params.batch_id],
  )
  return {
    batch_id: params.batch_id,
    proposal_hash: hash,
    saved: resolved.items.length,
    skipped: resolved.skippedDuplicates.length,
  }
}

function insertMemoryItem(tx: Tx, batchId: string, item: MemoryItemInput, status: 'proposed' | 'skipped'): void {
  const canonical = canonicalItem(item)
  const tags = Array.isArray(canonical.tags) ? canonical.tags.map((tag) => String(tag)) : []
  const questions = Array.isArray(canonical.questions) ? canonical.questions.map((question) => String(question)) : []
  tx.run(
    'INSERT INTO memory_items (item_id, batch_id, client_key, action, target_id, layer, title, content, tags_json, questions_json, key, importance, ttl_days, quote, reason, content_hash, status) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      'memitem_' + uuidv7().replace(/-/g, ''),
      batchId,
      item.client_key,
      item.action,
      item.target_id,
      item.layer,
      item.title,
      item.content,
      JSON.stringify(tags),
      JSON.stringify(questions),
      item.key,
      item.importance,
      item.ttl_days,
      item.quote,
      item.reason,
      contentHash(item),
      status,
    ],
  )
}
