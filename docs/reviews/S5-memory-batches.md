# S5-I · 记忆批次只读投影（`GET /v1/memory/batches` 的服务端读模型）

> 目的：给 Lead 一张「客户端字段 → 服务端来源 → 真实样例值」的对照表，说明 `src/service/queries/memory-batches.ts` 产出的 `listMemoryBatches(db, {task_id?, limit?, cursor?, now?})` 怎么满足 `src/client/api/types.ts:52-71` 的 `MemoryBatchView` 契约，以及哪些字段服务端**给不出**（给 null 是口径，不是漏做）。
>
> 本模块**只读**：不写任何表、不改迁移、不碰 `src/service/commands/memory-approval.ts`、不改 `src/service/server.ts`（路由由 Lead 单独接线）。全部读取走 `src/service/queries/read-tx.ts` 的 `withReadTx`（只读连接 + `PRAGMA query_only=ON`），游标走 `src/service/queries/cursor.ts` 的 `encodeCursor / decodeCursor / makeCursor`。

## 1. 导出签名

```ts
// src/service/queries/memory-batches.ts
export type MemoryBatchStatus =
  | 'draft' | 'evaluating' | 'awaiting_human' | 'approved' | 'applying' | 'applied'
  | 'empty' | 'blocked' | 'declined' | 'expired' | 'failed' | 'indeterminate'

export type MemoryItemStatus = 'proposed' | 'approved' | 'skipped' | 'applied' | 'failed'

export type MemoryItemView = {
  client_key: string; layer: string; title: string; digest: string
  content: string | null; source: string | null
  status: MemoryItemStatus; verdict: string | null; judge_reason: string | null
}

export type MemoryBatchView = {
  batch_id: string; task_id: string; status: MemoryBatchStatus; attempt: number
  outcome: string | null
  total_count: number; pending_count: number; applied_count: number; skipped_count: number
  items: MemoryItemView[]
  evaluation_id: string | null; proposal_hash: string | null
  decision_id: string | null; decision_revision: number | null
  allowed_resolutions: string[] | null; error_message: string | null
  created_at: string; updated_at: string
}

export type ListMemoryBatchesParams = { task_id?: string; limit?: number; cursor?: string; now?: number }
export type MemoryBatchPage = { items: MemoryBatchView[]; next_cursor: string | null; as_of_seq: number }

export function listMemoryBatches(db: Db, params?: ListMemoryBatchesParams): MemoryBatchPage
```

行为口径：

| 项 | 口径 |
| --- | --- |
| `limit` | 默认 50，上限 100；超限 `OrchError('RANGE_TOO_LARGE')`；非正整数 `OrchError('PAYLOAD_SCHEMA_INVALID')` |
| 排序 | `created_at DESC, batch_id DESC`（与索引 `memory_batches_task_created_idx` 同序） |
| 分页 | 键集游标 `(created_at < ? OR (created_at = ? AND batch_id < ?))`；游标 kind = `'memory_batches'`，filter = `{ task_id }`；换 `task_id` 用旧游标 → `CURSOR_FILTER_MISMATCH` |
| 一致性 | 一次 `withReadTx` 内读批次 / 条目 / 裁决，同一 `as_of_seq` |

## 2. 字段对照表（客户端 `MemoryBatchView` → 服务端来源）

| 客户端字段（types.ts:52-71） | 服务端来源 | 口径 |
| --- | --- | --- |
| `batch_id` | `memory_batches.batch_id` | 主键，原样 |
| `task_id` | `memory_batches.task_id` | 原样；`?task_id=` 时按它过滤 |
| `status` | `memory_batches.status` | 规格 §9.10 的 12 值；不在枚举内直接抛 `SERVICE_UNAVAILABLE`，不静默改写 |
| `attempt` | `memory_batches.attempt` | 原样（≥1） |
| `outcome` | `memory_batches.outcome` | 原样；非终态为 null |
| `total_count` | **从 items 真数** | `items.length` |
| `pending_count` | **从 items 真数** | `status ∈ {proposed, approved}` 的条目数（还没定下来的） |
| `applied_count` | **从 items 真数** | `status = 'applied'` 的条目数 |
| `skipped_count` | **从 items 真数** | `status = 'skipped'` 的条目数 |
| `items[]` | `memory_items`（按 `batch_id` 批量取，`ORDER BY batch_id, client_key`） | 见下表 §3 |
| `evaluation_id` | `memory_batches.evaluation_id` | 原样 |
| `proposal_hash` | `memory_batches.proposal_hash` | 原样 |
| `decision_id` | `memory_batches.decision_id` | 原样 |
| `decision_revision` | 关联 `decisions.revision` | 按 `decision_id` 关联查；查不到给 null |
| `allowed_resolutions` | 见 §4 | `awaiting_human` → 裁决 payload；`indeterminate` → `['abandon']`；其余 null |
| `error_message` | `memory_batches.error_message` | 原样 |
| `created_at` | `memory_batches.created_at` | 原样 |
| `updated_at` | `memory_batches.updated_at` | 原样 |

**四个计数不读 `memory_batches` 上的冗余列。** `memory_batches` 确实有 `applied_count` / `skipped_count` 两列，但那是写侧的快照；投影一律从 `items` 真数，用例「indeterminate 只给 abandon；别的状态一律 null；计数照样从 items 数」里直接断言了批次表上那两列仍是 0 而投影给出 1 —— 证明计数确实来自 items。

## 3. 条目字段对照表（客户端 `MemoryItemView` → 服务端来源）

| 客户端字段（types.ts:39-49） | 服务端来源 | 口径 |
| --- | --- | --- |
| `client_key` | `memory_items.client_key` | 原样（批次内唯一） |
| `layer` | `memory_items.layer` | 原样（`L2/L4/L5/L6`） |
| `title` | `memory_items.title` | 原样 |
| `digest` | `memory_items.content` 前 80 字 | 与审批卡 `buildApprovalCard` 的 digest 同口径（`src/core/memory-eval.ts:326`）；content 为 null 时给空串 |
| `content` | `memory_items.content` | 原样（列 NOT NULL，实际不会是 null） |
| `source` | **表里没有这一列** | 恒给 `null`；面板 `src/client/panel/memory-panel.tsx:145-146` 有「服务端未提供」兜底 |
| `status` | `memory_items.status` | 规格 §9.10 的 5 值；不在枚举内抛 `SERVICE_UNAVAILABLE` |
| `verdict` | `memory_items.verdict` | 原样（`approve/reject/merge/needs_user`） |
| `judge_reason` | `memory_items.judge_reason` | 原样 |

## 4. `allowed_resolutions` 口径

| 批次状态 | 值 | 依据 |
| --- | --- | --- |
| `awaiting_human` | 关联 `decisions.payload_json.allowed_resolutions`；**读不到给空数组 `[]`** | 规格 §9.6：审批只产生 approved/rejected，卡片自带 `allowed_resolutions`（当前恒为 `[]`，见 `src/core/memory-eval.ts:334`）。投影按「有就给、没有就空数组」处理，绝不编造动作名 |
| `indeterminate` | `['abandon']` | 规格 §9.7：写入第 3 条部分写入后，批次 `indeterminate`，唯一出路是 abandon |
| 其余状态 | `null` | 不是这两种状态就没有「可选动作集合」这回事 |

面板 `src/client/panel/memory-panel.tsx:103` 就是靠 `allowed_resolutions` 里有没有 `'abandon'` 决定是否显示放弃按钮，所以这一列必须与规格 §9.7 对齐。

## 5. 真实样例

以下 JSON 是用仓库里的迁移与真实库跑出来的投影输出（`freshLedger` 同款临时库，种子：1 个 task、2 个 run、1 个批次、2 个条目、1 条 evaluation）：

```json
{
  "items": [
    {
      "batch_id": "membatch_1",
      "task_id": "tsk_1",
      "status": "draft",
      "attempt": 1,
      "outcome": null,
      "total_count": 2,
      "pending_count": 1,
      "applied_count": 0,
      "skipped_count": 1,
      "items": [
        {
          "client_key": "mem_key_1",
          "layer": "L4",
          "title": "用户偏好",
          "digest": "用户希望回复保持简洁，不要长篇大论。",
          "content": "用户希望回复保持简洁，不要长篇大论。",
          "source": null,
          "status": "proposed",
          "verdict": null,
          "judge_reason": null
        },
        {
          "client_key": "mem_key_2",
          "layer": "L2",
          "title": "一次性口令",
          "digest": "今天的临时验证码是 123456。",
          "content": "今天的临时验证码是 123456。",
          "source": null,
          "status": "skipped",
          "verdict": "reject",
          "judge_reason": "一次性内容，不值得记"
        }
      ],
      "evaluation_id": "eval_1",
      "proposal_hash": "ph_1",
      "decision_id": null,
      "decision_revision": null,
      "allowed_resolutions": null,
      "error_message": null,
      "created_at": "2026-11-18T05:00:00.000Z",
      "updated_at": "2026-11-18T05:00:00.000Z"
    }
  ],
  "next_cursor": null,
  "as_of_seq": 0
}
```

## 6. 已知口径缺口（不是本模块能补的）

| 缺口 | 现状 | 影响的客户端字段 |
| --- | --- | --- |
| `memory_items` 没有 `source` 列 | 投影恒给 `null` | `MemoryItemView.source`（面板已按「服务端未提供」兜底） |
| 审批卡 `allowed_resolutions` 恒为 `[]`（规格 §9.6） | `awaiting_human` 的批次实际拿到的是 `[]`，面板不会显示放弃按钮 | `MemoryBatchView.allowed_resolutions` |
| `memory_batches.applied_count / skipped_count` 是写侧快照 | 投影不读它（从 items 真数） | — |

## 7. 证明用例

文件：`tests/integration/memory-batches.spec.ts`（8 个用例，全绿）。

| 用例名 | 证明什么 |
| --- | --- |
| 字段逐字对齐客户端契约，四个计数从 items 真数出来 | `Object.keys(batch)` 与客户端 18 个字段逐字相同；整对象 `toEqual`；digest 截断到 80 字；四个计数来自 items |
| awaiting_human：allowed_resolutions 从裁决 payload 读；没绑裁决给空数组 | 有裁决 → payload 里的数组；没绑 → `[]`；`decision_revision` 取裁决的 revision |
| indeterminate 只给 abandon；别的状态一律 null；计数照样从 items 数 | `indeterminate → ['abandon']`、`applied → null`、`declined → null`；批次表冗余列仍为 0 而投影计数为 1 |
| task_id 过滤：只回这个任务的批次 | 过滤生效，无过滤时两个任务都回 |
| 游标分页：limit 生效，next_cursor 续页不重不漏 | 三条批次按 `created_at DESC` 分两页取完，不重不漏；末页 `next_cursor = null` |
| 换了 task_id 再用旧游标报 CURSOR_FILTER_MISMATCH | 游标与过滤条件绑定 |
| limit 越界报 RANGE_TOO_LARGE，非正整数报 PAYLOAD_SCHEMA_INVALID | 参数校验 |
| 只读：投影前后 memory_batches / memory_items / decisions 行数不变 | 只读（连 `events` 一起核） |

命令：

```
npx vitest run tests/integration/memory-batches.spec.ts --reporter=verbose
npm run typecheck
```
