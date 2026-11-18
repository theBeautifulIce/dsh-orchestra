// 记忆批次只读投影（S5-I）：面板 GET /v1/memory/batches 的服务端读模型。
// 口径逐字对齐 src/client/api/types.ts:52-71（MemoryBatchView / MemoryItemView）。
// 只读：不写任何表、不改迁移、不碰审批命令层；四个计数一律从 items 真数出来。
import { OrchError } from '../../core/errors.ts';
import type { Db } from '../../infra/sqlite/driver.ts';
import { decodeCursor, encodeCursor, makeCursor } from './cursor.ts';
import { withReadTx } from './read-tx.ts';

const MEMORY_BATCHES_LIMIT_MAX = 100;
const CURSOR_KIND = 'memory_batches';
/** 摘要长度口径：正文前 80 字（与审批卡 buildApprovalCard 的 digest 一致）。 */
const DIGEST_MAX = 80;

/** 批次状态：规格 §9.10 的十二个值，与客户端 MemoryBatchStatus 逐字一致。 */
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
  | 'indeterminate';

/** 条目状态：规格 §9.10 的五个值，与客户端 MemoryItemStatus 逐字一致。 */
export type MemoryItemStatus = 'proposed' | 'approved' | 'skipped' | 'applied' | 'failed';

const BATCH_STATUSES: ReadonlySet<string> = new Set<MemoryBatchStatus>([
  'draft', 'evaluating', 'awaiting_human', 'approved', 'applying', 'applied',
  'empty', 'blocked', 'declined', 'expired', 'failed', 'indeterminate',
]);

const ITEM_STATUSES: ReadonlySet<string> = new Set<MemoryItemStatus>([
  'proposed', 'approved', 'skipped', 'applied', 'failed',
]);

/** 一条记忆条目（面板只读）。字段与 src/client/api/types.ts:39-49 一一对应。 */
export type MemoryItemView = {
  client_key: string;
  layer: string;
  title: string;
  digest: string;
  content: string | null;
  source: string | null;
  status: MemoryItemStatus;
  verdict: string | null;
  judge_reason: string | null;
};

/** 一次记忆整理批次（面板只读）。字段与 src/client/api/types.ts:52-71 一一对应。 */
export type MemoryBatchView = {
  batch_id: string;
  task_id: string;
  status: MemoryBatchStatus;
  attempt: number;
  outcome: string | null;
  total_count: number;
  pending_count: number;
  applied_count: number;
  skipped_count: number;
  items: MemoryItemView[];
  evaluation_id: string | null;
  proposal_hash: string | null;
  decision_id: string | null;
  decision_revision: number | null;
  allowed_resolutions: string[] | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type ListMemoryBatchesParams = {
  task_id?: string;
  limit?: number;
  cursor?: string;
  now?: number;
};

export type MemoryBatchPage = {
  items: MemoryBatchView[];
  next_cursor: string | null;
  as_of_seq: number;
};

type BatchRow = Record<string, unknown> & {
  batch_id: string;
  task_id: string;
  status: string;
  attempt: number;
  outcome: string | null;
  proposal_hash: string | null;
  evaluation_id: string | null;
  decision_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type ItemRow = Record<string, unknown> & {
  batch_id: string;
  client_key: string;
  layer: string;
  title: string;
  content: string;
  status: string;
  verdict: string | null;
  judge_reason: string | null;
};

type DecisionRow = Record<string, unknown> & {
  decision_id: string;
  revision: number;
  payload_json: string;
};

function toBatchStatus(raw: unknown): MemoryBatchStatus {
  const value = String(raw ?? '');
  if (!BATCH_STATUSES.has(value)) {
    throw new OrchError('SERVICE_UNAVAILABLE', '记忆批次状态不在规格枚举内', { status: value });
  }
  return value as MemoryBatchStatus;
}

function toItemStatus(raw: unknown): MemoryItemStatus {
  const value = String(raw ?? '');
  if (!ITEM_STATUSES.has(value)) {
    throw new OrchError('SERVICE_UNAVAILABLE', '记忆条目状态不在规格枚举内', { status: value });
  }
  return value as MemoryItemStatus;
}

function text(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null;
}

/** 摘要：正文前 80 字（没有来源列时也不许编）。 */
function digestOf(content: string): string {
  return content.slice(0, DIGEST_MAX);
}

/**
 * 从裁决卡的 payload_json 里读 allowed_resolutions。
 * 读不到（没有这张卡 / JSON 解不开 / 键不存在 / 不是字符串数组）一律给空数组，不许编。
 */
function allowedResolutionsFromPayload(payloadJson: unknown): string[] {
  if (typeof payloadJson !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const value = (parsed as Record<string, unknown>).allowed_resolutions;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * allowed_resolutions 口径（规格 §9.6 / §9.7）：
 * - awaiting_human：从关联裁决的 payload_json.allowed_resolutions 读，读不到给空数组；
 * - indeterminate：只给 ['abandon']（部分写入后的唯一出路）；
 * - 其余状态：null（不是这个状态就没有这组可选动作）。
 */
function allowedResolutionsOf(status: MemoryBatchStatus, decision: DecisionRow | undefined): string[] | null {
  if (status === 'awaiting_human') {
    return decision ? allowedResolutionsFromPayload(decision.payload_json) : [];
  }
  if (status === 'indeterminate') return ['abandon'];
  return null;
}

function toItemView(row: ItemRow): MemoryItemView {
  return {
    client_key: String(row.client_key ?? ''),
    layer: String(row.layer ?? ''),
    title: String(row.title ?? ''),
    digest: digestOf(String(row.content ?? '')),
    content: typeof row.content === 'string' ? row.content : null,
    // memory_items 没有 source 列：服务端没提供就是 null，面板写「服务端未提供」。
    source: null,
    status: toItemStatus(row.status),
    verdict: text(row.verdict),
    judge_reason: text(row.judge_reason),
  };
}

/**
 * 四个计数一律从 items 真数出来，不读 memory_batches 上的冗余列：
 * - total_count   = 条目总数
 * - pending_count = 还没定下来的条目（proposed 或 approved）
 * - applied_count = 写进去的条目（applied）
 * - skipped_count = 不写的条目（skipped）
 */
function toBatchView(row: BatchRow, items: MemoryItemView[], decision: DecisionRow | undefined): MemoryBatchView {
  const status = toBatchStatus(row.status);
  return {
    batch_id: String(row.batch_id ?? ''),
    task_id: String(row.task_id ?? ''),
    status,
    attempt: Number(row.attempt ?? 0),
    outcome: text(row.outcome),
    total_count: items.length,
    pending_count: items.filter((item) => item.status === 'proposed' || item.status === 'approved').length,
    applied_count: items.filter((item) => item.status === 'applied').length,
    skipped_count: items.filter((item) => item.status === 'skipped').length,
    items,
    evaluation_id: text(row.evaluation_id),
    proposal_hash: text(row.proposal_hash),
    decision_id: text(row.decision_id),
    decision_revision: decision ? Number(decision.revision ?? 0) : null,
    allowed_resolutions: allowedResolutionsOf(status, decision),
    error_message: text(row.error_message),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

/**
 * 列出记忆批次（只读）。
 * 排序：created_at DESC, batch_id DESC（与 memory_batches_task_created_idx 一致）；
 * 分页：键集游标 + limit 上限 100；只读事务里一次读出 as_of_seq。
 */
export function listMemoryBatches(db: Db, params: ListMemoryBatchesParams = {}): MemoryBatchPage {
  const limit = params.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit });
  if (limit > MEMORY_BATCHES_LIMIT_MAX) throw new OrchError('RANGE_TOO_LARGE', '一次最多要 ' + String(MEMORY_BATCHES_LIMIT_MAX) + ' 条', { limit });
  const filter = { task_id: params.task_id ?? null };

  return withReadTx(db, (ctx) => {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.task_id) {
      where.push('task_id = ?');
      values.push(filter.task_id);
    }
    if (params.cursor) {
      const cursor = decodeCursor(params.cursor, CURSOR_KIND, filter, params.now);
      where.push('(created_at < ? OR (created_at = ? AND batch_id < ?))');
      values.push(cursor.last_key, cursor.last_key, cursor.last_id);
    }
    const rows = ctx.tx.all<BatchRow>(
      'SELECT batch_id, task_id, status, attempt, outcome, proposal_hash, evaluation_id, decision_id, '
      + 'error_message, created_at, updated_at FROM memory_batches'
      + (where.length ? ' WHERE ' + where.join(' AND ') : '')
      + ' ORDER BY created_at DESC, batch_id DESC LIMIT ?',
      [...values, limit + 1],
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const batchIds = page.map((row) => String(row.batch_id ?? ''));
    const itemRows = batchIds.length
      ? ctx.tx.all<ItemRow>(
        'SELECT batch_id, client_key, layer, title, content, status, verdict, judge_reason FROM memory_items '
        + 'WHERE batch_id IN (' + batchIds.map(() => '?').join(',') + ') ORDER BY batch_id, client_key',
        batchIds,
      )
      : [];

    const decisionIds = [...new Set(page.map((row) => text(row.decision_id)).filter((id): id is string => id !== null))];
    const decisionRows = decisionIds.length
      ? ctx.tx.all<DecisionRow>(
        'SELECT decision_id, revision, payload_json FROM decisions WHERE decision_id IN ('
        + decisionIds.map(() => '?').join(',') + ')',
        decisionIds,
      )
      : [];

    const itemsByBatch = new Map<string, MemoryItemView[]>();
    for (const row of itemRows) {
      const batchId = String(row.batch_id ?? '');
      const bucket = itemsByBatch.get(batchId);
      if (bucket) bucket.push(toItemView(row));
      else itemsByBatch.set(batchId, [toItemView(row)]);
    }
    const decisionById = new Map<string, DecisionRow>();
    for (const row of decisionRows) decisionById.set(String(row.decision_id ?? ''), row);

    const items = page.map((row) => {
      const batchId = String(row.batch_id ?? '');
      const decisionId = text(row.decision_id);
      const decision = decisionId ? decisionById.get(decisionId) : undefined;
      return toBatchView(row, itemsByBatch.get(batchId) ?? [], decision);
    });

    const last = page[page.length - 1];
    const next_cursor = hasMore && last
      ? encodeCursor(makeCursor(CURSOR_KIND, filter, String(last.created_at ?? ''), String(last.batch_id ?? ''), ctx.as_of_seq, params.now))
      : null;
    return { items, next_cursor, as_of_seq: ctx.as_of_seq };
  });
}
