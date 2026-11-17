# dsh-orchestra S5 面板与记忆 实施计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 把引擎账本变成人看得懂的界面，并让记忆写入走一条可审、可对账、不可越权的通道——读模型与十八个查询、SSE 事件流、六屏面板、面板控制面六命令、记忆三端口与固定图、记忆四表与审批写入、记忆面板，最后交出 G5 门记录。本批不碰发布、不碰三圈。

**Architecture:** 面板是只读客户端，账本是唯一事实源：面板只经 src/client/api 的读模型客户端与 SSE 取数，六条命令走控制面信封，由 src/service/commands 落到账本，命令结果按 operation_id 查回执，不做乐观更新。读模型层把账本表投影成规格 8.2 的七种视图（TaskSummary / RunSummary / WorkflowView / NodeRunView / DecisionView / EventView / UnverifiedEffectView），展示状态由服务端给全，声明只做展示不改原文；未观测到的东西有自己的名字，不许折叠进「正常」档。记忆是一条独立于任务运行的支线：memory_start_run 以 (source_run_id, request_key) 幂等开批，固定图 mem_trigger→mem_prepare→mem_check→mem_route→mem_confirm→mem_apply→mem_report 把「提议—评估—审批—写入—回执」串成一条链，唯一写入口是 memory.apply_governed，批准快照一旦落定就只读。

**Tech Stack:** TypeScript 6.0.3（ESM / NodeNext）· Node `^22.19.0 || >=24.0.0` · pnpm 12.3.4 · vitest 4.1.8 · tsdown 0.22.14 · zod 4.4.3 · react 18.3.1 · react-dom 18.3.1 · jsdom 29.1.1 · node:sqlite（内置 DatabaseSync）· DSH bundle 插件

**实施进度（2026-11-17，工作区快照；不代表任务验收或阶段关闭）：** 17 项中，Task 1–2 的查询基元和任务/运行读模型已有实现；Task 3–8 部分实现，仍有明确查询、控制面、宿主连接、六屏整合和视觉走查缺口。Task 9 已接入「等你决定」和「待核实」两屏的真实只读列表、分页、刷新、加载/错误/空状态及 SSE 快照联动；策略字段与待核实详情尚未进入查询模型，相关命令和页面测试未完成，故 Task 9 仍为部分实现。Task 10–17 尚未开始，G5 尚未交付。针对最新审计的 P2-1 至 P2-4 已完成代码修正，测试保护仍待补齐。本轮执行 `pnpm typecheck` 与差异检查，不运行测试套件。

---

## 0. 前置、边界与口径

前置：总纲 `docs/superpowers/plans/2026-11-12-dsh-orchestra-overview.md` 的 Task 0 到 Task 4（S1 账本地基、S2 执行桥、S3 节点与裁决、S4 流程发布）已过门并各自留下 `docs/gates/G<n>.md`；S1 已交出单写者连接、迁移框架、事件哈希链、epoch 栅栏与统一信封。本批所有路径从总纲 §3 的目录布局派生。

**本批能做什么**：读模型与规格 8.3 的十八个查询、SSE 事件流与失效信号、面板六屏、面板控制面六命令、记忆三端口与固定图、记忆四表、提议校验与 canonical 哈希、评估与审批、写入与部分写入对账、记忆面板、视觉硬门槛与字号/对比度审计、G5 门记录与三条必过注入（G-06 / G-11 / G-12）。

**本批不能做什么**（规格 11.1 行 938 的 S5 阶段能力表禁止项：R2 受控圈）。落到实现上就是这几条：

- 不启用 release 能力。wf_release_v1 只在 S6 启用（规格 11.4 行 988），S5 的阶段闸必须能把它拒掉——这正是 G5 必过项之一。
- 不做三圈试用与晋级。R0 / R1 / R2 的准入与留痕属 S6（规格 11.6 行 1006-1012）。
- 不做 G-01 到 G-16 的全量故障注入、24 小时浸泡、发布包与安装说明。这三样是 S6 的活。
- 不越阶段写门记录。G5 记录里不许出现 release、R1/R2 或 S6 的结论。

**对应门 G5 必过项**（规格 11.2 行 951，原文引用）：

> G5 必过：Q-01 到 Q-36 与 Q-43 到 Q-63（含 43b / 43c / 44b / 44c / 47b / 52b）、两个视口无横向溢出、正文不小于 13px、辅助不小于 12px、菜单与顶导不小于 12.5px、浅色对比度正文 4.5:1、大字与 UI 3:1、记忆部分写入可对账、S5 启动 wf_release_v1 被拒、G-06 / G-11 / G-12。

每条注入用例都要留三样东西（规格 12.3 行 1077 原文口径）：注入脚本与参数、前后账本片段、恢复后对账查询。没有对账查询的注入不算通过。

**未决参数**（总纲 §7 口径：每一项在对应批次定值并写进门记录；定值前实现按规格默认值与安全侧行为运行，不许用「还没定」作为放行理由）：

| 未决项 | 总纲 §7 序号 | 本批口径 |
| --- | --- | --- |
| 写队列上限与溢出策略 | 第 1 项 | 沿用 S1 定值：上限 1000 条，超限返回 `SERVICE_UNAVAILABLE`（503）并记 warning，读路径不受影响。S5 不改这个值；若 S6 复查要改，先改 G1 门记录再改代码。 |
| 事件与证据的保留期 | 第 2 项 | 本批只做读侧展示口径（artifact 过保留期显示「已过保留期」，不删账本事实），具体天数在 S6 Task 9 定值并写进 G6 门记录。 |
| 记忆裁判的模型与提示词版本 | 第 3 项 | 本批把裁判调用收在 `src/core/memory-eval.ts` 的唯一出口，模型与提示词版本写进 `memory_evaluations` 的模型信息列；本批不锁具体模型。 |
| 记忆三端口的入参出参字段名 | 总纲 §7 未列 | 规格只点名了 `memory.apply_governed` 只收 `decision_id`（规格 9.7 行 737）与 `memory.inspect_batch` 的返回形状（设计稿 Q-54）。本批只实现规格点名的字段，其余集中在 `src/core/memory-eval.ts` 一处并标注未决，不在别处另造协议。 |
| 值班人与升级联系人名单 | 第 4 项 | 属 S6 Task 13，本批不预置。 |
| R1/R2 工作区白名单 | 第 5 项 | 属 S6 Task 14，本批不预置。 |
| 24h 浸泡采样频率与判定脚本 | 第 6 项 | 属 S6 Task 7，本批不预置。 |

**口径说明（三处合并定案）**：

- 目录合并沿用 S1 的定案：驱动与 SQL 迁移放 `src/infra/sqlite/`（`driver.ts`、`migrations/NNN-name.sql`），连接、事务与迁移执行器放 `src/infra/db/`（`open.ts`、`tx.ts`、`migrate.ts`）。两套目录不并存，本批不再重复这个决定。
- 记忆批次的 status 取值取设计稿 §5.4 的枚举（draft/evaluating/awaiting_human/approved/applying/applied/empty/blocked/declined/expired/failed/indeterminate），它与规格 9.9 行 762 的面板文案表一一对应。规格 §9 没有逐字列这组值——记为口径差异，报给主人，不在代码里另造一套。
- 读模型只做展示，不改原文。节点半态不许折成 run 的三态，status 原文永远并列在 display_status 旁边；证据没有就不许显绿（规格 8.6 行 666、设计稿 §4.4）。

---

### Task 1：查询基元——游标、分页、读事务与 as_of_seq

**目标：** 给十八个查询铺一层共用的底座：不透明游标、limit 上限、读事务内一致的 `as_of_seq`、查询超时与只读连接（规格 8.3 行 635-640）。

**Files:**
- Create: `src/service/queries/cursor.ts` —— 游标编解码、过期与过滤不匹配判定。
- Create: `src/service/queries/read-tx.ts` —— 读事务、`as_of_seq` 取值、查询超时与只读连接。
- Create: `tests/queries-cursor.spec.ts` —— 游标与读事务的用例。

**步骤：**

1. 定游标载荷的六个字段与签发时间的位置。载荷字段严格按规格 8.3：`v`、`kind`、`filter_hash`、`last_key`、`last_id`、`as_of_seq`。签发时间不进载荷，单独跟载荷一起签名保存，这样过期判定不必改规格里的字段表。

```ts
// src/service/queries/cursor.ts
import { createHmac, timingSafeEqual } from 'node:crypto'
import { OrchError } from '../../core/errors.ts'
import { sha256Hex } from '../../core/canonical.ts'

export type CursorPayload = {
  v: 1
  kind: string
  filter_hash: string
  last_key: string
  last_id: string
  as_of_seq: number
}

export type CursorToken = { payload: CursorPayload; issued_at: number }

const TTL_MS = 10 * 60 * 1000

function sign(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

export function encodeCursor(secret: string, token: CursorToken): string {
  const body = Buffer.from(JSON.stringify(token), 'utf8')
  return `${body.toString('base64url')}.${sign(secret, body.toString('utf8')).toString('base64url')}`
}

export function decodeCursor(
  secret: string,
  raw: string,
  expect: { kind: string; filter_hash: string },
  now: number,
): CursorPayload {
  const [body, mac] = raw.split('.')
  if (!body || !mac) throw new OrchError('CURSOR_FILTER_MISMATCH', '游标格式不对')
  const expected = sign(secret, body)
  const got = Buffer.from(mac, 'base64url')
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new OrchError('CURSOR_FILTER_MISMATCH', '游标签名对不上')
  }
  const token = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorToken
  if (now - token.issued_at > TTL_MS) throw new OrchError('CURSOR_EXPIRED', '游标过期了，请重新翻页')
  if (token.payload.kind !== expect.kind) throw new OrchError('CURSOR_FILTER_MISMATCH', '游标种类对不上')
  if (token.payload.filter_hash !== expect.filter_hash) throw new OrchError('CURSOR_FILTER_MISMATCH', '筛选条件变了')
  return token.payload
}
```

2. 定 limit 上限与过滤指纹的算法规。规格 8.3 行 637：tasks/workflows/runs/decisions 上限 100，nodes/events 上限 200；超过报 `RANGE_TOO_LARGE`。过滤指纹只吃「影响结果集」的参数，`as_of_seq` 不参与（设计稿 Q-28）。

```ts
// src/service/queries/cursor.ts 续
export const LIMIT_CAP = {
  tasks: 100, workflows: 100, runs: 100, decisions: 100, nodes: 200, events: 200,
} as const

export type LimitKind = keyof typeof LIMIT_CAP

export function clampLimit(kind: LimitKind, limit: number | undefined): number {
  const cap = LIMIT_CAP[kind]
  const value = limit ?? cap
  if (value > cap) throw new OrchError('RANGE_TOO_LARGE', `一次最多取 ${cap} 条`, { cap })
  if (value < 1) throw new OrchError('RANGE_TOO_LARGE', 'limit 至少是 1')
  return value
}

export function filterHash(filter: Record<string, unknown>): string {
  const entries = Object.entries(filter)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return sha256Hex(JSON.stringify(entries))
}
```

3. 写读事务。读连接开 `PRAGMA query_only=ON`，单次查询超时 5 秒按 `QUERY_TIMEOUT` 报；`as_of_seq` 取本次事务看到的最大 `events.seq`，保证一页之内是同一快照（规格 8.3 行 639）。

```ts
// src/service/queries/read-tx.ts
import type { Db, Tx } from '../../infra/sqlite/driver.ts'
import { OrchError } from '../../core/errors.ts'

export type ReadCtx = { tx: Tx; as_of_seq: number }

export function withReadTx<T>(db: Db, fn: (ctx: ReadCtx) => T, timeoutMs = 5000): T {
  db.raw.exec('PRAGMA query_only=ON')
  db.raw.exec('BEGIN')
  try {
    const row = db.raw.prepare('SELECT MAX(seq) AS s FROM events').get() as { s: number | null }
    const out = fn({ tx: db.raw as unknown as Tx, as_of_seq: row.s ?? 0 })
    db.raw.exec('COMMIT')
    return out
  } catch (err) {
    db.raw.exec('ROLLBACK')
    if (err instanceof OrchError) throw err
    throw new OrchError('QUERY_TIMEOUT', '查询没在时限内回来', { cause: String(err) })
  }
}
```

**测试：**

- Create: `tests/queries-cursor.spec.ts`
  - 同一过滤条件下编码再解码，六个字段逐字相等；改动 `last_key` 后签名校验失败。
  - 改过滤条件复用旧游标 → `CURSOR_FILTER_MISMATCH`；改 `as_of_seq` 不影响校验（规格 8.3 / Q-28）。
  - 签发后第 10 分钟再解 → `CURSOR_EXPIRED`。
  - `clampLimit('tasks', 101)` → `RANGE_TOO_LARGE`；`clampLimit('nodes', 200)` → 200。
  - `withReadTx` 回调里读到的 `as_of_seq` 等于该事务看到的最大 `events.seq`；回调抛错时事务回滚且连接可继续用。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/queries-cursor.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/service/queries/cursor.ts src/service/queries/read-tx.ts tests/queries-cursor.spec.ts
git commit -m "feat(service): 建读模型查询基元与不透明游标"
```

---

### Task 2：任务与运行读视图

**目标：** 交出 `list_tasks`、`get_task`、`list_runs`、`get_run` 四个查询与 TaskSummary / RunSummary 两种视图，排序、聚合计数与展示状态全部由服务端给全（规格 8.2 行 623-631、8.3 行 635-640）。

**审计修正：** 任务摘要现将已存在 `unverified_resolutions` 的节点排除；attention 过滤、关键词/状态过滤、排序、键集游标和 `limit + 1` 均在 SQLite 查询中完成，不再把全量摘要拉到 JavaScript 后分页。

**Files:**
- Create: `src/service/queries/tasks.ts` —— 任务列表与任务详情。
- Create: `src/service/queries/runs.ts` —— 运行列表与运行详情。
- Create: `src/service/queries/attention.ts` —— attention 排序权重与三数聚合。
- Create: `tests/queries-tasks.spec.ts` —— 任务与运行读视图的用例。

**步骤：**

1. 定 attention 的取值与权重。规格 8.2 行 631：decision > unverified > failed > orphaned > running > none。任务行只按这六个过滤桶分。

```ts
// src/service/queries/attention.ts
export const ATTENTION_ORDER = ['decision', 'unverified', 'failed', 'orphaned', 'running', 'none'] as const
export type Attention = (typeof ATTENTION_ORDER)[number]

export function attentionWeight(a: Attention): number {
  return ATTENTION_ORDER.indexOf(a)
}
```

2. 定三数聚合口径（规格 8.2 行 623 的 `oldest_open_decision_age_seconds`、`max_side_effect_level`、`max_heartbeat_age_ms`）。这三数由服务聚合，前端不算；能力等级按 pure < compensable < irreversible 排序（设计稿 Q-09）。

```ts
// src/service/queries/attention.ts 续
export const SIDE_EFFECT_LEVEL = ['pure', 'compensable', 'irreversible'] as const
export type SideEffectLevel = (typeof SIDE_EFFECT_LEVEL)[number]

export function sideEffectWeight(level: string): number {
  const i = SIDE_EFFECT_LEVEL.indexOf(level as SideEffectLevel)
  return i < 0 ? 0 : i
}

export type TaskAggregates = {
  open_decision_count: number
  oldest_open_decision_age_seconds: number | null
  unverified_count: number
  max_side_effect_level: SideEffectLevel | null
  max_heartbeat_age_ms: number | null
}
```

3. 写 `list_tasks`。排序固定为 attention 降序、同档内 `updated_at` 降序（规格 8.5 行 652）；六类过滤对应 SQL 里的六个条件分支；分页用 `last_key` + `last_id` 复合游标。

```ts
// src/service/queries/tasks.ts
import type { ReadCtx } from './read-tx.ts'
import { clampLimit, encodeCursor, filterHash, type LimitKind } from './cursor.ts'
import { attentionWeight, type Attention } from './attention.ts'
import { OrchError } from '../../core/errors.ts'

export type ListTasksParams = {
  status?: string
  attention?: Attention
  query?: string
  sort?: string
  limit?: number
  cursor?: string
}

export type TaskSummary = {
  task_id: string
  title: string
  workflow_id: string | null
  workflow_version: number | null
  status: string
  display_status: string
  current_run_id: string | null
  session_id: string | null
  run_count: number
  open_decision_count: number
  unverified_count: number
  current_run_done: number | null
  total: number | null
  oldest_open_decision_age_seconds: number | null
  max_side_effect_level: string | null
  max_heartbeat_age_ms: number | null
  attention: Attention
  attention_reason: string | null
  updated_at: string
}

export function listTasks(ctx: ReadCtx, params: ListTasksParams, secret: string): {
  items: TaskSummary[]
  next_cursor: string | null
  total: number | null
} {
  const limit = clampLimit('tasks' satisfies LimitKind, params.limit)
  const hash = filterHash({ status: params.status, attention: params.attention, query: params.query, sort: params.sort })
  const rows = ctx.tx.all('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?', [limit + 1])
  const items = (rows as Array<Record<string, unknown>>).map((row) => toTaskSummary(ctx, row))
  const sorted = items.sort((a, b) => {
    const w = attentionWeight(b.attention) - attentionWeight(a.attention)
    if (w !== 0) return w
    return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0
  })
  const page = sorted.slice(0, limit)
  const last = page[page.length - 1]
  const next_cursor = last
    ? encodeCursor(secret, {
        payload: {
          v: 1, kind: 'tasks', filter_hash: hash,
          last_key: last.updated_at, last_id: last.task_id, as_of_seq: ctx.as_of_seq,
        },
        issued_at: Date.now(),
      })
    : null
  return { items: page, next_cursor, total: null }
}
```

4. 写 `get_run`。run 主体、counts、top-N 节点必须来自同一读事务，`as_of_seq` 等于该事务看到的最大 `events.seq`（Q-03）；终态不折（Q-04、Q-05、Q-06）。

```ts
// src/service/queries/runs.ts
export function getRun(ctx: ReadCtx, runId: string): RunSummary {
  const run = ctx.tx.get('SELECT * FROM runs WHERE run_id = ?', [runId]) as Record<string, unknown> | undefined
  if (!run) throw new OrchError('NOT_FOUND', '没找到这次运行')
  const counts = ctx.tx.all(
    'SELECT status, COUNT(*) AS n FROM node_runs WHERE run_id = ? GROUP BY status',
    [runId],
  ) as Array<{ status: string; n: number }>
  const lastEventSeq = ctx.tx.get(
    'SELECT MAX(seq) AS s FROM events WHERE run_id = ?',
    [runId],
  ) as { s: number | null }
  return {
    run_id: runId,
    task_id: String(run.task_id ?? ''),
    workflow_id: (run.workflow_id as string | null) ?? null,
    workflow_version: (run.workflow_version as number | null) ?? null,
    status: String(run.status ?? ''),
    display_status: displayStatusForRun(String(run.status ?? ''), ctx),
    reasons: [],
    settling: false,
    counts,
    total: counts.reduce((acc, c) => acc + c.n, 0),
    revision: Number(run.revision ?? 0),
    last_event_seq: lastEventSeq.s ?? 0,
  }
}
```

**测试：**

- Create: `tests/queries-tasks.spec.ts`
  - `list_tasks` 按 attention 排序：decision 档排在 unverified 之前，none 垫底；同档内按 `updated_at` 降序（Q-01）。
  - orphaned 的任务进「没人接手」桶（Q-01）。
  - 任务行的三数由服务聚合：`oldest_open_decision_age_seconds` 取未决 decision 的最大 age，`max_side_effect_level` 取 pure<compensable<irreversible 的最大，`max_heartbeat_age_ms` 取子节点最大心跳年龄（Q-09）。
  - `get_run` 的 run/counts/top-N 来自同一读事务，`as_of_seq` 等于该事务看到的最大 `events.seq`（Q-03）。
  - run 已 `succeeded` 时 `display_status` 仍是 `succeeded`；`succeeded_with_unverified` 与 `failed_with_unverified` 不折成 succeeded/failed（Q-04、Q-05、Q-06）。
  - 分页：第二页出现新任务时按 `task_id` 去重，重复项以后页为准（Q-02）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/queries-tasks.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/service/queries/tasks.ts src/service/queries/runs.ts src/service/queries/attention.ts tests/queries-tasks.spec.ts
git commit -m "feat(service): 交出任务与运行读视图及服务端聚合"
```

<!--PART-B-->
### Task 3：节点、裁决、未验证副作用与证据读视图

**目标：** 交出 `list_nodes`、`get_node`、`list_decisions`、`get_decision`、`list_unverified_side_effects`、`get_evidence`、`get_attestation`、`get_artifact`、`verify_ledger` 九个查询与 NodeRunView / DecisionView / UnverifiedEffectView 三种视图（规格 8.2 行 627-631、8.3 行 635-640）。

**实施前置补正：** 本任务原示例引用了 `unverified_resolutions`、`attestations` 两张当前 schema 缺失的表，以及 `node_runs.action`、`stopped_at`、`evidence`、`last_known_phase` 等不存在列。迁移 `029_effect_resolution_records.sql` 现在定义两类只追加记录：人证绑定 run/node/attempt，固定为 `human_attested` 且不作为证据；副作用结算以 `node_run_id` 唯一，`verified_none` 必须与节点的 `side_effect_verified_none + stop_evidence` 一致，其他结算绑定 evidence 或 decision。迁移含作用域守卫与禁止修改/删除触发器，记忆迁移仍为 030。**已完成：** 人证在确认启动事务中落表，并由独立 attestation 查询读取；节点、裁决、证据、产物及未验证副作用基础读模型已实现。`get_evidence` 以宿主签发的 `execution_id` 寻址，只返回哈希、工具结果和时间；会核验对应 `tool_finished` 事件、事件链及两处记录一致，不返回 stdout/stderr，也不接纳人证为系统证据。节点视图仅列出同 attempt 的工具 `execution_ids` / 数量，不再由记录存在推断 strong；只有 `get_evidence` 完成 tool_finished 与事件链交叉验证后才返回系统证据。`declared_effect` / `verified_effect` 因缺少事实字段继续标为 `projection_missing`。裁决读模型对当前 schema 没有持久化的优先级、允许选项、目标摘要、证据要求显式返回 `null` 并标记 `projection_missing`。**仍待补齐：** 当前没有一个通用的副作用核验/结算命令；现有 `resolveDecision` 的多种 decision 与 resolution 不能不经策略判定就等同为结算。因此 `unverified_resolutions` 暂无写入者，`list_unverified_side_effects` 只按该表过滤已结算行，读模型不推测结算状态。后续需先在 §9 规格中明确各 decision kind 的允许 resolution、证据引用和幂等规则，再把相应落表放进同一裁决事务。缺失的动作描述、停止时刻、证据详情和执行阶段列不得用空值或布尔推断伪造；节点状态、产物和账本查询可独立推进。

**Files:**
- Create: `src/service/queries/nodes.ts` —— 节点列表与详情，节点显示映射与证据四列。
- Create: `src/service/queries/decisions.ts` —— 待决事项列表与详情；现阶段回传真实持久化字段，并把未定义的 allowed_resolutions 与 priority 标成 projection_missing。
- Create: `src/service/queries/effects.ts` —— 未验证副作用列表与 resolved 判定。
- Create: `src/service/queries/evidence.ts` —— 系统证据按 execution_id 查询；人工签字仍由独立 attestation 读口读取。
- Create: `src/service/queries/artifacts.ts` —— `get_artifact` 读取产物元数据，保留期外只回「已过保留期」。
- Create: `src/service/queries/verify_ledger.ts` —— `verify_ledger` 校验事件哈希链，复用 `src/core/hash-chain.ts`。
- Create: `tests/queries-nodes.spec.ts` —— 节点、裁决、副作用、证据、产物与账本校验的用例。

**步骤：**

1. 定节点的显示映射。三条硬约束：节点半态不许折（设计稿 §4.4）；没有证据不许显绿（设计稿 §4.4）；未知不补零（拿不到计数显示「—」，拿不到状态显示 status 原文加 `projection_missing`）。

```ts
// src/service/queries/nodes.ts
export const NODE_TERMINAL = [
  'done', 'failed', 'timeout', 'abandoned_unverified', 'failed_with_unverified', 'orphaned', 'superseded',
] as const

export const NODE_LABEL: Record<string, string> = {
  queued: '排队中还没派给执行者',
  leased: '已分到执行位，等执行者接手',
  dispatched: '已派出，等执行者启动',
  started: '已开跑，等回写',
  verifying: '等验证',
  waiting: '等外部条件',
  timing_out: '已请求停止，正在确认停没停',
  stopping: '已请求停止，动作可能还在跑',
  startup_unknown: '启动情况不明——可能没开跑，也可能已开跑',
  indeterminate_side_effect: '动作已停，副作用是否发生不明',
  blocked_pre: '执行前被挡住，等人处理',
  blocked_post: '执行完了，结果等人定',
  paused_bridge_missing: '桥断了，先暂停跟踪',
  done: '已完成',
  failed: '没做成',
  timeout: '超时收口',
  abandoned_unverified: '已放弃跟踪，副作用未核实',
  failed_with_unverified: '没做成，且有副作用未核实',
  orphaned: '没有新 attempt 接手',
  superseded: '已被新 attempt 取代',
}

export function nodeDisplayStatus(status: string, settling: boolean): string {
  if ((NODE_TERMINAL as readonly string[]).includes(status)) return status
  if (settling) return 'settling'
  if (status === 'waiting' || status === 'blocked_pre' || status === 'blocked_post') return 'blocked'
  return 'running'
}
```

2. 定证据四列与人工签字的单独出口。规格 8.6 与设计稿 Q-33：人证不出现在证据强弱列，`get_evidence` 不返回人证，人证只走 `get_attestation` 并固定标「人证，不是系统证据」。

```ts
// src/service/queries/nodes.ts 续
export type EvidenceColumns = {
  declared_effect: string
  verified_effect: string | null
  evidence_strength: 'strong' | 'weak' | null
  evidence_state: 'none' | 'not_required'
  attestation_id: string | null
}

export function evidenceColumns(row: Record<string, unknown>): EvidenceColumns {
  const strength =
    row.evidence_strength === 'strong' || row.evidence_strength === 'weak' ? row.evidence_strength : null
  const state = row.evidence_state === 'not_required' ? 'not_required' : 'none'
  return {
    declared_effect: String(row.declared_effect ?? 'pure'),
    verified_effect: (row.verified_effect as string | null) ?? null,
    evidence_strength: strength,
    evidence_state: state,
    attestation_id: (row.attestation_id as string | null) ?? null,
  }
}
```

3. 定「已停」与「已结算」的区分。规格 8.2 行 629 的 UnverifiedEffectView 字段与设计稿 §4.4：`stopped_at` 只说明停过，只有 `side_effect_verified_none=true` 且带 `stop_evidence` 才算已确认未发生；resolved 的判定只认 `unverified_resolutions` 表（设计稿 §4.5.5），读模型不另存一份判定。

```ts
// src/service/queries/effects.ts
export function isResolvedNone(row: Record<string, unknown>): boolean {
  return row.side_effect_verified_none === true && Boolean(row.stop_evidence)
}

export function listUnverifiedEffects(ctx: ReadCtx, params: { limit?: number; cursor?: string }) {
  const limit = clampLimit('decisions', params.limit)
  const rows = ctx.tx.all(
    `SELECT n.* FROM node_runs n
     LEFT JOIN unverified_resolutions r ON r.node_run_id = n.node_run_id
     WHERE n.side_effect_verified_none IS NOT TRUE
       AND (r.node_run_id IS NULL OR r.resolved_at IS NULL)
     ORDER BY n.started_at DESC LIMIT ?`,
    [limit + 1],
  )
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    run_id: String(r.run_id ?? ''),
    node_run_id: String(r.node_run_id ?? ''),
    action: String(r.action ?? ''),
    side_effect_policy: String(r.side_effect_policy ?? 'pure'),
    stopped_at: (r.stopped_at as string | null) ?? null,
    side_effect_verified_none: r.side_effect_verified_none === true,
    stop_evidence: (r.stop_evidence as string | null) ?? null,
    evidence: (r.evidence as string | null) ?? null,
    last_known_phase: (r.last_known_phase as string | null) ?? null,
    resolved: false,
    resolved_at: null,
    resolution_basis: null,
    age_seconds: ageSeconds(r.started_at),
  }))
}
```

4. 定裁决视图。`allowed_resolutions` 必须与当前 kind 一致（Q-11）；`priority` 与 `priority_reason` 由服务给，前端不自己排（Q-10、Q-09）。

```ts
// src/service/queries/decisions.ts
export type DecisionView = {
  decision_id: string
  run_id: string
  node_run_id: string | null
  kind: string
  status: string
  priority: string
  priority_reason: string
  age_seconds: number
  expires_at: string | null
  expiry_effect: string | null
  expiry_effect_reason: string | null
  allowed_resolutions: string[]
  required_evidence: string[]
  current_revision: number
  target_summary: string
  confirm_required: boolean
}

export function getDecision(ctx: ReadCtx, decisionId: string): DecisionView {
  const row = ctx.tx.get('SELECT * FROM decisions WHERE decision_id = ?', [decisionId]) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new OrchError('NOT_FOUND', '没找到这条裁决')
  return {
    decision_id: decisionId,
    run_id: String(row.run_id ?? ''),
    node_run_id: (row.node_run_id as string | null) ?? null,
    kind: String(row.kind ?? ''),
    status: String(row.status ?? ''),
    priority: String(row.priority ?? 'normal'),
    priority_reason: String(row.priority_reason ?? ''),
    age_seconds: ageSeconds(row.created_at),
    expires_at: (row.expires_at as string | null) ?? null,
    expiry_effect: (row.expiry_effect as string | null) ?? null,
    expiry_effect_reason: (row.expiry_effect_reason as string | null) ?? null,
    allowed_resolutions: (row.allowed_resolutions as string[] | null) ?? [],
    required_evidence: (row.required_evidence as string[] | null) ?? [],
    current_revision: Number(row.revision ?? 0),
    target_summary: String(row.target_summary ?? ''),
    confirm_required: row.confirm_required === true,
  }
}
```

5. 定 `get_artifact` 与 `verify_ledger`。产物只按登记的 artifact id 取，传伪造 id 或路径穿越一律 `NOT_FOUND`，错误文案不回显路径（Q-24）；保留期外的产物不删事实，只回「已过保留期」并禁下载（规格 12.5 行 1093）。账本校验按 node_run 逐条重算 HMAC 链，命中第一条断链即停（Q-25）。

```ts
// src/service/queries/artifacts.ts
import { OrchError } from '../../core/errors.ts'

export type ArtifactView = {
  artifact_id: string
  run_id: string
  sha256: string
  evidence_index: unknown
  retain_until: string | null
  expired: boolean
}

export function getArtifact(ctx: ReadCtx, artifactId: string, now: number): ArtifactView {
  const row = ctx.tx.get('SELECT * FROM artifacts WHERE artifact_id = ?', [artifactId]) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new OrchError('NOT_FOUND', '没找到这份产物')
  const retainUntil = (row.retain_until as string | null) ?? null
  const expired = retainUntil !== null && Date.parse(retainUntil) < now
  return {
    artifact_id: artifactId,
    run_id: String(row.run_id ?? ''),
    sha256: String(row.sha256 ?? ''),
    evidence_index: row.evidence_index ?? null,
    retain_until: retainUntil,
    expired,
  }
}
```

```ts
// src/service/queries/ledger.ts
import { verifyChain, type ChainRow } from '../../core/hash-chain.ts'

export type LedgerCheck = {
  valid: boolean
  first_bad_event_seq: number | null
  broken_node_run_id: string | null
  reason: string | null
}

export function verifyLedger(ctx: ReadCtx, secret: string): LedgerCheck {
  const chains = ctx.tx.all(
    'SELECT DISTINCT node_run_id FROM node_run_events ORDER BY node_run_id',
  ) as Array<{ node_run_id: string }>
  for (const { node_run_id } of chains) {
    const rows = ctx.tx.all(
      'SELECT node_run_id, seq, type, prev_hash, hash, payload FROM node_run_events WHERE node_run_id = ? ORDER BY seq ASC',
      [node_run_id],
    ) as unknown as ChainRow[]
    const broken = verifyChain(secret, rows)
    if (broken) {
      return {
        valid: false,
        first_bad_event_seq: broken.seq,
        broken_node_run_id: broken.node_run_id,
        reason: broken.reason,
      }
    }
  }
  return { valid: true, first_bad_event_seq: null, broken_node_run_id: null, reason: null }
}
```

**测试：**

- Create: `tests/queries-nodes.spec.ts`
  - 节点状态逐个断言显示文案，20 种状态不折叠不合并；`startup_unknown` 不等于「等待中」，`stopping` 不等于「已停止」，`indeterminate_side_effect` 不等于「失败」（Q-31）。
  - 节点详情里 `status` 原文与 `display_status` 并列出现；`reasons[]` 露在页面上而不是只挂在提示里。
  - `declared_effect` 与 `verified_effect` 不一致时高亮并链到对应裁决（Q-08）。
  - `done` 节点 `evidence_state=none` 时证据栏显示「—」与原因，不显示绿色「已验证」；策略不要求证据时显示 `not_required`（Q-30）。
  - 人证不出现在 `get_evidence` 里，`get_attestation` 固定返回「人证，不是系统证据」（Q-33）。
  - `stopped_at` 非空但 `side_effect_verified_none` 不为 true 时，仍在「待核实」页且显示「未验证」（Q-29）。
  - `get_decision` 的 `allowed_resolutions` 与 kind 一致（Q-11）。
  - `get_artifact` 传伪造 id 或 `../` 路径穿越返回 `NOT_FOUND`，错误文案不含文件系统路径（Q-24）。
  - 产物过了 `retain_until` 仍能读到记录，但标「已过保留期」且不给下载句柄（规格 12.5 行 1093）。
  - 篡改第 100 条 `node_run_events` 的 summary 后 `verify_ledger` 返回 `valid=false` 且 `first_bad_event_seq=100`（Q-25）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/queries-nodes.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/service/queries/nodes.ts src/service/queries/decisions.ts src/service/queries/effects.ts src/service/queries/evidence.ts src/service/queries/artifacts.ts src/service/queries/ledger.ts tests/queries-nodes.spec.ts
git commit -m "feat(service): 交出节点裁决与未验证副作用读视图"
```

---

### Task 4：工作流读视图与控制面六命令

**目标：** 交出 `list_workflows`、`get_workflow`、`get_workflow_version` 三个工作流查询，并把控制面限定为规格 8.4 行 644-648 的六条命令，带信封、幂等、确认预检与 revision CAS（规格 3.7 行 201-220）。

**当前进度：** 工作流列表、详情、版本只读查询已实现并接入 HTTP，查询从单个只读快照返回 `as_of_seq`；沿用当前数据库实际的 ISO 时间文本，旧版本缺少 `doc_json` 时明确标 `projection_missing`。S4 已有四条带 `operation_id` 的工作流写命令，但 S5 的统一六命令信封与 decision acknowledge 仍待完成；命令回执查询已提供，歧义网络结果会查回执且不自动重提。

**Files:**
- Create: `src/service/queries/workflows.ts` —— `list_workflows`、`get_workflow`、`get_workflow_version` 三个查询与 WorkflowView。
- Create: `src/service/commands/envelope.ts` —— 命令信封与 `request_hash` 计算。
- Create: `src/service/commands/receipt.ts` —— 回执、幂等判定顺序与 `get_operation`。
- Create: `src/service/commands/decision.ts` —— `decision.acknowledge`、`decision.resolve`。
- Create: `src/service/commands/workflow.ts` —— `workflow.create`、`workflow.open_draft`、`workflow.update`、`workflow.publish`。
- Create: `src/service/commands/router.ts` —— 六命令白名单与 actor 派生。
- Create: `tests/commands-panel.spec.ts` —— 控制面命令的用例。

**步骤：**

1. 定三个工作流查询。`list_workflows` 给名称、当前版本、草稿状态、节点数与最近发布；`get_workflow` 给当前版与草稿的完整定义；`get_workflow_version` 按版本号只读已发布版本。已发布版本不可改，工作流不存在报 `WORKFLOW_NOT_FOUND`，版本不存在报 `WORKFLOW_VERSION_NOT_FOUND`（规格 8.3 行 635、3.8 行 222-252）。表结构沿用 S4 的 `workflows` / `workflow_versions` / `workflow_drafts` 三张表；节点数从定义 JSON 的 nodes 数组数出，校验结果取 `src/core/workflow-def.ts`，读模型只展示不改原文。

```ts
// src/service/queries/workflows.ts
import { OrchError } from '../../core/errors.ts'

export type WorkflowSummary = {
  workflow_id: string
  name: string
  current_version: number | null
  has_draft: boolean
  node_count: number
  published_at: number | null
  updated_at: number
}

export type WorkflowView = {
  draft: {
    revision: number
    based_on_version: number | null
    definition: unknown
    definition_hash: string
  } | null
  current: {
    version: number
    definition: unknown
    definition_hash: string
    publish_note: string
    published_at: number
  } | null
  validation: { errors: string[]; warnings: string[] }
  versions: Array<{ version: number; published_at: number; publish_note: string }>
}

function nodeCountOf(json: string | null): number {
  if (!json) return 0
  const def = JSON.parse(json) as { nodes?: unknown[] }
  return Array.isArray(def.nodes) ? def.nodes.length : 0
}

export function listWorkflows(ctx: ReadCtx, limit: number): WorkflowSummary[] {
  const rows = ctx.tx.all(
    `SELECT w.workflow_id, w.name, w.current_version, w.updated_at,
            d.definition_json AS draft_json,
            v.definition_json AS current_json,
            v.published_at AS current_published_at
       FROM workflows w
       LEFT JOIN workflow_drafts d ON d.workflow_id = w.workflow_id
       LEFT JOIN workflow_versions v
              ON v.workflow_id = w.workflow_id AND v.version = w.current_version
      ORDER BY w.updated_at DESC LIMIT ?`,
    [limit + 1],
  )
  return (rows as Array<Record<string, unknown>>).map((r) => {
    const draftJson = (r.draft_json as string | null) ?? null
    const currentJson = (r.current_json as string | null) ?? null
    return {
      workflow_id: String(r.workflow_id ?? ''),
      name: String(r.name ?? ''),
      current_version: r.current_version === null ? null : Number(r.current_version),
      has_draft: draftJson !== null,
      node_count: nodeCountOf(draftJson ?? currentJson),
      published_at: r.current_published_at === null ? null : Number(r.current_published_at),
      updated_at: Number(r.updated_at ?? 0),
    }
  })
}

export function getWorkflowVersion(ctx: ReadCtx, workflowId: string, version: number) {
  const row = ctx.tx.get(
    'SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?',
    [workflowId, version],
  ) as Record<string, unknown> | undefined
  if (!row) throw new OrchError('WORKFLOW_VERSION_NOT_FOUND', '没找到这个版本')
  return {
    version: Number(row.version),
    definition: JSON.parse(String(row.definition_json)),
    definition_hash: String(row.definition_hash ?? ''),
    publish_note: String(row.publish_note ?? ''),
    published_at: Number(row.published_at ?? 0),
  }
}
```

2. 定命令信封与 `request_hash`。原像只含 command / target / expected / payload，**不含** operation_id、confirm_challenge、client（规格 3.7 行 216）。

```ts
// src/service/commands/envelope.ts
import { canonicalJson, sha256Hex } from '../../core/canonical.ts'

export type CommandEnvelope = {
  operation_id: string
  command: string
  target: { kind: string; id: string }
  expected: Record<string, unknown>
  payload: Record<string, unknown>
  client: { kind: string; version: string }
  confirm_challenge?: string
}

export function requestHash(env: CommandEnvelope): string {
  return sha256Hex(canonicalJson({
    command: env.command,
    target: env.target,
    expected: env.expected,
    payload: env.payload,
  }))
}
```

3. 定幂等判定顺序（规格 3.7 行 217）。先看回执是否过期；未过期且已终结则重放回执并置 `replayed=true`；同 id 不同哈希报 `OPERATION_ID_CONFLICT`；未终结且同哈希报 `COMMAND_BUSY`。

```ts
// src/service/commands/receipt.ts
import { OrchError } from '../../core/errors.ts'

export type ReceiptRow = {
  operation_id: string
  request_hash: string
  status: 'in_flight' | 'applied' | 'rejected'
  receipt_json: string | null
  receipt_expired_at: string | null
  completed_at: string | null
  created_at: string
}

export function replayOrConflict(existing: ReceiptRow | undefined, hash: string): ReceiptRow | undefined {
  if (!existing) return undefined
  if (existing.receipt_expired_at) {
    throw new OrchError('OPERATION_EXPIRED', '这条回执已经过期了')
  }
  if (existing.request_hash !== hash) {
    throw new OrchError('OPERATION_ID_CONFLICT', '同一个操作号对应了不同的请求')
  }
  if (existing.status === 'in_flight') {
    throw new OrchError('COMMAND_BUSY', '上一条还没处理完')
  }
  return existing
}
```

4. 定控制面白名单与 actor 派生。面板只开六条命令，其余一律拒；actor 由认证主体派生，不由 payload 自报（规格 12.5 行 1091）。

```ts
// src/service/commands/router.ts
import { OrchError } from '../../core/errors.ts'

export const ALLOWED_COMMANDS = [
  'decision.acknowledge',
  'decision.resolve',
  'workflow.create',
  'workflow.open_draft',
  'workflow.update',
  'workflow.publish',
] as const
export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number]

export function assertAllowed(command: string): asserts command is AllowedCommand {
  if (!(ALLOWED_COMMANDS as readonly string[]).includes(command)) {
    throw new OrchError('FORBIDDEN', '这条命令面板没有开放')
  }
}

export function actorOf(principal: { subject: string; scopes: string[] }): string {
  if (!principal.subject) throw new OrchError('UNAUTHORIZED', '写操作必须有主体')
  return principal.subject
}
```

5. 定决策命令。高风险 `decision.resolve` 第一次不带 challenge 时只做预检：返回 `CONFIRMATION_REQUIRED` 并绑定 challenge，**不落 command 行、不占 operation_id**、状态不变（规格 3.7 行 217、Q-15）。challenge 由服务端按 decision 与内容哈希派生，不落库、不接受自报。

```ts
// src/service/commands/decision.ts
import { createHmac } from 'node:crypto'
import { OrchError } from '../../core/errors.ts'

export function deriveChallenge(secret: string, decisionId: string, hash: string): string {
  return createHmac('sha256', secret).update(`${decisionId}:${hash}`).digest('base64url')
}

export function assertChallenge(secret: string, decisionId: string, hash: string, given?: string): void {
  if (!given) throw new OrchError('CONFIRMATION_REQUIRED', '这一步需要先确认')
  if (given !== deriveChallenge(secret, decisionId, hash)) {
    throw new OrchError('CONFIRMATION_MISMATCH', '确认凭据对不上')
  }
}
```

6. 写 `workflow.*` 四条命令的约束。draft 与已发布版本分离：已发布版本不可改（`WORKFLOW_VERSION_IMMUTABLE`），草稿存在时再建草稿报 `WORKFLOW_DRAFT_EXISTS`，版本冲突报 `WORKFLOW_VERSION_CONFLICT`；发布前跑定义校验，校验不过报 `WORKFLOW_VALIDATION_FAILED`。

7. 写 `get_operation`。回执窗口 7 天从 `completed_at` 起算，在途行没有 `completed_at` 从 `created_at` 起算 10 分钟；过期后 `get_operation` 与同 operation_id 复放都返回 `OPERATION_EXPIRED`（规格 3.7 行 218-220、Q-35）。

**测试：**

- Create: `tests/commands-panel.spec.ts`
  - 白名单外命令返回 `FORBIDDEN`；匿名写返回 `UNAUTHORIZED`；actor 取认证主体，子智能体自报 actor 被忽略（Q-34）。
  - 同 operation_id 同哈希重发返回 `replayed=true` 且只落一条 `command.applied`；同 id 不同哈希返回 `OPERATION_ID_CONFLICT`（Q-13、Q-14）。
  - 高风险 resolve 第一次不带 challenge 返回 `CONFIRMATION_REQUIRED` 与绑定 challenge，状态不变、command 行不落；预检后正式执行前换请求返回 `CONFIRMATION_MISMATCH`；challenge 过期返回 `CONFIRMATION_EXPIRED`（Q-15）。
  - `decision.resolve` 带过期 revision 返回 `DECISION_REVISION_CONFLICT` 且 `details.current_revision` 正确（Q-12）。
  - `workflow.publish` 在 executor allow 含 memory_write / memory_update 时返回 `MEMORY_WRITE_TOOL_FORBIDDEN` 且不生成版本；换成 memory.search 后可发布（Q-44）。
  - `list_workflows` 给名称、当前版本、草稿状态与节点数；`get_workflow` 给当前版与草稿；`get_workflow_version` 按版本号只读已发布版本。
  - 工作流不存在返回 `WORKFLOW_NOT_FOUND`，版本不存在返回 `WORKFLOW_VERSION_NOT_FOUND`；已发布版本再改被拒（规格 3.8 行 222-252）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/commands-panel.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/service/queries/workflows.ts src/service/commands/envelope.ts src/service/commands/receipt.ts src/service/commands/decision.ts src/service/commands/workflow.ts src/service/commands/router.ts tests/commands-panel.spec.ts
git commit -m "feat(service): 限定控制面六命令并接上信封与回执"
```

---

### Task 5：事件查询与 SSE 事件流

**目标：** 交出 `list_events` 与 SSE 通道：事件只当失效信号，断号整页重取，重复事件按 event_id 去重（规格 8.3 行 635、8.4 行 647；设计稿 §4.7）。

**当前进度：** 服务端 SSE 已支持 Last-Event-ID、按 seq 连续续传、15 秒心跳、断号/积压时发 `resync_required` 后关闭；客户端控制器支持 event_id 去重、合并刷新和轮询降级；PanelApp 可注入 EventStream 工厂，在任务列表/详情首个快照后续传，并在事件失效时重取当前读模型。宿主认证/代理接线及其余视图联动仍待完成。

**Files:**
- Create: `src/service/queries/events.ts` —— 事件列表与按 seq 续读。
- Create: `src/service/events/stream.ts` —— 服务端 SSE 通道与心跳。
- Create: `src/client/api/sse.ts` —— 客户端订阅、断号处理与降级轮询。
- Create: `tests/events-stream.spec.ts` —— SSE 与事件查询的用例。

**步骤：**

1. 写事件查询。`EventView` 字段按规格 8.2 行 628，事件序号即 `seq`，续传从 `after_seq` 之后开始；事件 payload 默认脱敏，只给 `payload_redacted` 与 `payload_ref`。

```ts
// src/service/queries/events.ts
export type EventView = {
  seq: number
  event_id: string
  type: string
  occurred_at: string
  boot_id: string
  monotonic_ns: number
  run_id: string | null
  node_run_id: string | null
  decision_id: string | null
  payload_redacted: string | null
  payload_ref: string | null
}

export function listEvents(ctx: ReadCtx, params: { run_id?: string; after_seq?: number; limit?: number }) {
  const limit = clampLimit('events', params.limit)
  const rows = params.after_seq
    ? ctx.tx.all(
        'SELECT * FROM events WHERE seq > ? AND (? IS NULL OR run_id = ?) ORDER BY seq ASC LIMIT ?',
        [params.after_seq, params.run_id ?? null, params.run_id ?? null, limit],
      )
    : ctx.tx.all('SELECT * FROM events ORDER BY seq DESC LIMIT ?', [limit])
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    seq: Number(r.seq),
    event_id: String(r.event_id),
    type: String(r.type),
    occurred_at: String(r.occurred_at),
    boot_id: String(r.boot_id),
    monotonic_ns: Number(r.monotonic_ns),
    run_id: (r.run_id as string | null) ?? null,
    node_run_id: (r.node_run_id as string | null) ?? null,
    decision_id: (r.decision_id as string | null) ?? null,
    payload_redacted: (r.payload_redacted as string | null) ?? null,
    payload_ref: (r.payload_ref as string | null) ?? null,
  }))
}
```

2. 写服务端 SSE。事件 id 就是 seq，支持 `Last-Event-ID`；心跳 15 秒一次；慢客户端超缓冲上限就发 `resync_required`（设计稿 §4.7）。SSE 由插件代理，面板不持原始 token。

```ts
// src/service/events/stream.ts
export const HEARTBEAT_MS = 15_000
export const LAST_EVENT_ID_HEADER = 'last-event-id'

export function nextSeq(afterSeq: number, eventSeq: number): number | null {
  // 只接受 seq == last + 1，断号由客户端整页重取
  return eventSeq === afterSeq + 1 ? eventSeq : null
}
```

3. 写客户端订阅。断号立即整页重取，重复事件按 `event_id` 去重，高频事件 100 毫秒合并一次刷新；SSE 不可用降级 5 秒轮询并标「降级轮询」，不许标「实时」。

```ts
// src/client/api/sse.ts
export type StreamStatus = 'live' | 'stale' | 'polling'

export class EventStream {
  private seen = new Set<string>()

  constructor(
    private readonly read: (afterSeq: number) => Promise<Array<{ seq: number; event_id: string; type: string }>>,
    private readonly onInvalidate: (type: string) => void,
    private readonly onStatus: (status: StreamStatus) => void,
  ) {}

  apply(events: Array<{ seq: number; event_id: string; type: string }>, lastSeq: number): number {
    let next = lastSeq
    for (const e of events) {
      if (this.seen.has(e.event_id)) continue
      if (e.seq !== next + 1) {
        this.onInvalidate('resync_required')
        return next
      }
      this.seen.add(e.event_id)
      next = e.seq
      this.onInvalidate(e.type)
    }
    return next
  }

  markStale(): void {
    this.onStatus('stale')
  }
}
```

**测试：**

- Create: `tests/events-stream.spec.ts`
  - SSE 从 `as_of_seq` 续传；断号时客户端立即整页重取（Q-17）。
  - 同一事件重复投递按 `event_id` 去重，只触发一次失效（Q-18）。
  - 服务停止后保留最后快照并标 `stale`，命令按钮禁用（Q-20）。
  - `protocolVersion` 不匹配全屏阻断（Q-21）。
  - `list_events` 200 条 p95 不大于 50 毫秒（规格 8.3 行 640）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/events-stream.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/service/queries/events.ts src/service/events/stream.ts src/client/api/sse.ts tests/events-stream.spec.ts
git commit -m "feat(service): 接上事件查询与 SSE 失效信号通道"
```

---

### Task 6：客户端 API 层

**目标：** 把读模型客户端、命令提交与回执查询收成一层，让面板只经这一层取数与发命令，不直接碰账本、不直接连 SQLite（规格 8.4 行 646；Q-22）。

**当前进度：** 已有信封解包、协议版本检查、通用 get/post、超时转 operation receipt 查询、视图类型入口及任务/运行/节点/决定/证据/事件/工作流/回执只读资源 API，以及复用注入 fetch 的事件流控制器；宿主认证/代理注入、SSE 状态到具体视图的刷新回调、写命令清单接线仍待完成。

**Files:**
- Create: `src/client/api/client.ts` —— 读模型客户端：查询调用与信封解包。
- Create: `src/client/api/commands.ts` —— 命令提交、`operation_id` 回执查询与重试纪律。
- Create: `src/client/api/types.ts` —— 七种读视图的前端类型。
- Create: `tests/client-api.spec.ts` —— 客户端层的用例。

**步骤：**

1. 定信封解包。成功取 `data`，失败抛带 `code` 的错误；查询结果里 `as_of_seq` 一并带出，供 SSE 订阅起点使用。

```ts
// src/client/api/client.ts
export type Envelope<T> = {
  ok: boolean
  schema_version: 1
  as_of_seq: number
  generated_at?: string
  data?: T
  error?: { code: string; message: string; retryable: boolean; details?: unknown }
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export async function unwrap<T>(res: Response): Promise<{ data: T; as_of_seq: number }> {
  const body = (await res.json()) as Envelope<T>
  if (!body.ok) {
    throw new ApiError(
      body.error?.code ?? 'SERVICE_UNAVAILABLE',
      body.error?.message ?? '服务没回应',
      body.error?.retryable ?? true,
      body.error?.details,
    )
  }
  return { data: body.data as T, as_of_seq: body.as_of_seq }
}
```

2. 定命令提交纪律。面板不做乐观更新：提交后按 `operation_id` 查回执；超时先查回执、不重复提交（同 id 不同请求会被拒，重发同哈希才是重放）。

```ts
// src/client/api/commands.ts
export type SubmitResult = { replayed: boolean; receipt: unknown }

export async function submitThenReceipt(
  post: (operationId: string) => Promise<Response>,
  getOperation: (operationId: string) => Promise<Response>,
  operationId: string,
): Promise<SubmitResult> {
  try {
    const body = await unwrap(await post(operationId))
    return { replayed: false, receipt: body.data }
  } catch (err) {
    if (err instanceof ApiError && err.code === 'OPERATION_TIMEOUT') {
      const body = await unwrap(await getOperation(operationId))
      return { replayed: true, receipt: body.data }
    }
    throw err
  }
}
```

3. 写类型镜像。七个视图的前端类型与服务端一一对应，服务端给了什么前端就显示什么；前端不改状态，也不自己排优先级。

**测试：**

- Create: `tests/client-api.spec.ts`
  - 成功信封取 `data` 与 `as_of_seq`；失败信封抛 `ApiError` 且带 `code`。
  - 命令超时后按 `operation_id` 查回执，不重复提交（Q-16）。
  - 面板代码里没有对 `node:sqlite` 的静态引用（Q-22）。
  - 任务标题含 `<img onerror=...>` 时按纯文本渲染，不产生元素节点（Q-23）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/client-api.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/client/api/client.ts src/client/api/commands.ts src/client/api/types.ts tests/client-api.spec.ts
git commit -m "feat(client): 建面板 API 层与回执查询纪律"
```

---

### Task 7：面板骨架与视觉硬门槛

**目标：** 立起面板外壳与设计令牌，把规格 8.6 行 661-667 的视觉硬门槛变成可测的断言：字号下限、对比度下限、浅色主题、无黑底、无菜单彩色左条（规格 13.3 行 1118-1120）。

**当前进度：** 已实现颜色/字号令牌、对比度计算与受检色对、中文文案表，以及可复用的导航/服务状态外壳并从 client 入口导出，PanelApp 已把任务列表与详情装配进共享外壳；PanelCommandButton 会在服务断开或快照陈旧时禁用。仍待接入 DSH 实际宿主挂载与认证，确保后续写命令使用该控件，并完成两个视口的渲染级视觉走查。

**Files:**
- Create: `src/client/panel/tokens.ts` —— 颜色与字号令牌，以及各项下限常量。
- Create: `src/client/panel/contrast.ts` —— 对比度计算，供审计与运行时自检共用。
- Create: `src/client/panel/copy.ts` —— 全站说人话的文案表（状态、按钮、空态、错误态）。
- Create: `src/client/panel/shell.tsx` —— 面板外壳：顶导、侧栏、路由与断线/协议不匹配的整屏态。
- Create: `src/client/index.tsx` —— 客户端入口，挂载外壳。
- Create: `tests/panel-visual.spec.ts` —— 字号、对比度、两视口无横向溢出的审计用例。

**步骤：**

1. 定令牌与下限。规格 8.6：正文不小于 13px、辅助不小于 12px、菜单与顶导不小于 12.5px；浅色主题不用黑色底，菜单不许有彩色左条（原型打磨记录的口径是纯白画布 + 墨黑强调色 + 功能色只用于状态文字）。

```ts
// src/client/panel/tokens.ts
export const COLOR = {
  canvas: '#ffffff',
  surface: '#ffffff',
  line: '#e6e7ea',
  ink: '#111316',
  inkMuted: '#5a616b',
  success: '#1c7c54',
  warning: '#8a5c17',
  danger: '#a83239',
  link: '#1f5fbf',
} as const

export const FONT_PX = {
  body: 14,
  helper: 12,
  menu: 12.5,
  title: 15,
} as const

export const FONT_FLOOR_PX = {
  body: 13,
  helper: 12,
  menu: 12.5,
} as const
```

2. 定对比度计算与受检色对。正文与辅助文字对画布要达到 4.5:1，大字与 UI 元件达到 3:1。

```ts
// src/client/panel/contrast.ts
export function relativeLuminance(hex: string): number {
  const c = hex.replace('#', '')
  const chan = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
  const lin = chan.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

export const TEXT_PAIRS: Array<{ fg: string; bg: string; floor: number; label: string }> = [
  { fg: COLOR.ink, bg: COLOR.canvas, floor: 4.5, label: '正文' },
  { fg: COLOR.inkMuted, bg: COLOR.canvas, floor: 4.5, label: '辅助文字' },
  { fg: COLOR.success, bg: COLOR.canvas, floor: 4.5, label: '成功状态文字' },
  { fg: COLOR.warning, bg: COLOR.canvas, floor: 4.5, label: '警告状态文字' },
  { fg: COLOR.danger, bg: COLOR.canvas, floor: 4.5, label: '危险状态文字' },
  { fg: COLOR.link, bg: COLOR.canvas, floor: 3, label: '链接' },
]
```

3. 定文案表。文案只说人话：「等你决定」「待核实」「这一步」「这次运行」，不用「裁决」「副作用」「算子」；空态、错误态、加载态、断线态都要有文案，断线时显示最后快照并标「服务未连接」，不显示假数据。

```ts
// src/client/panel/copy.ts
export const COPY = {
  emptyTasks: '还没有任务，新建一个就能开始',
  emptyDecisions: '当前没有等你决定的事项',
  emptyEffects: '没有待核实的操作',
  serviceDown: '服务未连接',
  staleNotice: '显示的是最后一次拿到的数据',
  protocolMismatch: '服务与面板版本不一致，请重启 DSH',
  queryFailed: '查询没成功',
  commandUnknown: '结果未知',
  retry: '重试',
  refresh: '刷新后重试',
} as const
```

4. 定外壳的三个整屏态：协议版本不匹配整屏阻断（不半兼容）；服务未连接保留最后快照、禁用命令按钮；未知新状态显示原文并提示「面板版本过旧」。

5. 定两视口约束。1600×1000 与 1366×900 下不许出现横向溢出，长标题截断并带完整提示（用 `title` 属性承载全文）。

**测试：**

- Create: `tests/panel-visual.spec.ts`
  - 计算后的正文不小于 13px、辅助不小于 12px、菜单与顶导不小于 12.5px；断言的是渲染后的计算字号，不是令牌常量本身（规格 13.3 行 1119）。
  - `TEXT_PAIRS` 每对都达到各自下限：正文 4.5:1，链接 3:1（规格 13.3 行 1120）。
  - 浅色主题：画布与表面色不是黑色，亮度高于 0.8；菜单项没有彩色左边条（规格 8.6 行 661）。
  - 在 1600×1000 与 1366×900 两个视口下，`document.documentElement.scrollWidth <= clientWidth`；长标题截断且 `title` 属性含全文。
  - 默认视图渲染结果里不出现 session_id / agent_id / node_run_id / event_id / batch_id 这些字面量（规格 13.3 行 1122）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/panel-visual.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/client/panel/tokens.ts src/client/panel/contrast.ts src/client/panel/copy.ts src/client/panel/shell.tsx src/client/index.tsx tests/panel-visual.spec.ts
git commit -m "feat(client): 立面板外壳与视觉硬门槛令牌"
```

---

### Task 8：六屏之一二——任务列表与任务详情

**目标：** 交出任务列表与任务详情两屏，行内元素与风险栏按规格 8.5 行 652-653 的清单逐条落实（规格 13.3 行 1121 的逐屏走查）。

**当前进度：** 任务列表已接真实只读 API，支持搜索、游标分页、刷新、加载/空/错误态、状态与待处理事项展示；详情页可查看任务摘要、最近运行、节点状态与运行记录。两页已由 PanelApp 串接；其他逐屏规格、后续运行选择和视口走查未完成。

**Files:**
- Create: `src/client/panel/task-list.tsx` —— 任务列表屏。
- Create: `src/client/panel/task-detail.tsx` —— 任务详情屏与右侧风险栏。
- Create: `src/client/panel/components.tsx` —— 共用小组件：状态徽标、抽屉、风险条目。
- Create: `tests/panel-task.spec.ts` —— 任务列表与任务详情的用例。

**步骤：**

1. 定任务行的六项元素（规格 8.5 行 652）：标题、流程与版本、到哪一步、等你决定几条、几笔改动没核实、更新时间。三数取服务端的 `open_decision_count`、`unverified_count`、`oldest_open_decision_age_seconds`，前端不自己算。

```tsx
// src/client/panel/task-list.tsx
import type { TaskSummary } from '../api/types.ts'

export type TaskRowProps = { task: TaskSummary }

export function TaskRow({ task }: TaskRowProps) {
  return (
    <li className="task-row">
      <span className="task-row__title" title={task.title}>{task.title}</span>
      <span className="task-row__flow">
        {task.workflow_id ?? '没走流程'} · v{task.workflow_version ?? '—'}
      </span>
      <span className="task-row__step">{task.display_status}</span>
      <span className="task-row__decision">
        {task.open_decision_count} 条等你决定
        {task.oldest_open_decision_age_seconds !== null
          ? ` · 最长等待 ${task.oldest_open_decision_age_seconds} 秒`
          : ''}
      </span>
      <span className="task-row__unverified">{task.unverified_count} 笔改动没核实</span>
      <span className="task-row__updated">{task.updated_at}</span>
    </li>
  )
}
```

2. 定过滤条。六类过滤：等你决定、待核实、已失败、没人接手、运行中、全部（规格 8.5 行 652）。过滤参数走服务端，客户端不本地筛。

```ts
// src/client/panel/task-list.tsx 续
export const TASK_FILTERS = [
  { key: 'decision', label: '等你决定' },
  { key: 'unverified', label: '待核实' },
  { key: 'failed', label: '已失败' },
  { key: 'orphaned', label: '没人接手' },
  { key: 'running', label: '运行中' },
  { key: 'none', label: '全部' },
] as const
```

3. 定任务详情屏。顶部标题、流程版本、会话跳转、run 选择；run 头大状态、原因、进度、开始结束；节点按 seq 与 attempt 排列；右侧风险栏挂未决裁决、未验证副作用、孤儿、桥断（规格 8.5 行 653）。点开抽屉不跳走。

```tsx
// src/client/panel/task-detail.tsx
export function TaskDetailHeader(props: { task: TaskSummary; runs: RunSummary[] }) {
  const run = props.runs[0]
  return (
    <header className="detail__header">
      <h2 className="detail__title" title={props.task.title}>{props.task.title}</h2>
      <span className="detail__flow">
        {props.task.workflow_id ?? '没走流程'} · v{props.task.workflow_version ?? '—'}
      </span>
      {run ? <span className="detail__run">{run.display_status}</span> : null}
      {run && run.reasons.length > 0 ? (
        <ul className="detail__reasons">
          {run.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      ) : null}
    </header>
  )
}
```

4. 定节点序列的排布与证据栏。节点按 seq 与 attempt 排列，status 原文与 display_status 并列，证据四列按规格 8.6 的口径渲染（没有证据显示「—」，策略不要求证据显示「not_required」，人证单独一行标「人证，不是系统证据」）。

**测试：**

- Create: `tests/panel-task.spec.ts`
  - 任务行显示标题、流程与版本、到哪一步、等你决定几条、几笔改动没核实、更新时间六项，且不显示 session_id（规格 13.3 行 1122）。
  - 排序按服务端 attention 顺序渲染，前端不再本地重排。
  - 详情页风险栏同时出现未决裁决、未验证副作用、孤儿、桥断四类条目；抽屉打开后当前页不跳转。
  - 节点列表按 seq 与 attempt 排列；`status` 原文可见；未验证副作用与失败同屏可见，不只显示绿色成功（规格 8.6 行 667）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/panel-task.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/client/panel/task-list.tsx src/client/panel/task-detail.tsx src/client/panel/components.tsx tests/panel-task.spec.ts
git commit -m "feat(client): 交出任务列表与任务详情两屏"
```

---

### Task 9：六屏之三四——待你决定与待核实

**当前实现状态（2026-11-17）：** 首版只读页已接入 PanelApp，并通过 `listDecisions` / `listUnverifiedEffects` 读取真实数据，支持分页、手动刷新、加载/错误/空状态和 SSE 快照联动。由于当前读模型没有决策优先级/处理选项/证据要求/过期后果，也没有待核实项的动作摘要/停止时刻/最后阶段/已验证证据，页面明确标注不可用，不提供确认或解决按钮。Task 9 尚未完成；测试、命令回执闭环和完整字段投影仍是未完成项。

**目标：** 交出「待你决定」与「待核实」两屏。待你决定是主入口，待核实是独立一级页（规格 8.5 行 654-655）。

**Files:**
- Create: `src/client/panel/decision-inbox.tsx` —— 待你决定屏与批量 acknowledge。
- Create: `src/client/panel/unverified-effects.tsx` —— 待核实一级页。
- Create: `tests/panel-decision.spec.ts` —— 两屏的用例。

**步骤：**

1. 定待你决定的排序与卡片要素。规格 8.5 行 654：按 priority 与 age 降序；卡上要写清为什么卡、你能选什么、需要什么证据、过期会怎样；本版批量只允许 acknowledge，resolve 一次一条；没有「忽略」这个选项。

```tsx
// src/client/panel/decision-inbox.tsx
import type { DecisionView } from '../api/types.ts'

export function DecisionCard({ decision }: { decision: DecisionView }) {
  return (
    <article className="decision">
      <h3 className="decision__title">{decision.target_summary}</h3>
      <p className="decision__why">为什么卡在这里：{decision.priority_reason}</p>
      <p className="decision__options">你能选：{decision.allowed_resolutions.join(' / ')}</p>
      <p className="decision__evidence">需要什么证据：{decision.required_evidence.join('、') || '不需要额外证据'}</p>
      <p className="decision__expiry">
        {decision.expires_at
          ? `过期会怎样：${decision.expiry_effect_reason ?? decision.expiry_effect ?? '按现状收口'}`
          : '过期会怎样：不会自动过期'}
      </p>
    </article>
  )
}
```

2. 定批量动作的边界。本版只允许批量 acknowledge；resolve 必须一次一条。批量按钮在有不可批量项时禁用并说明原因。

3. 定待核实页。规格 8.5 行 655：独立一级页；每行列运行、节点、动作摘要、副作用等级、stopped_at、最后已知阶段、验证状态、证据、年龄、是否已解决、解决依据；顶部固定一句「签字只表示人接下了后果，不表示副作用已消失」。

```tsx
// src/client/panel/unverified-effects.tsx
export const VERIFY_BANNER = '签字只表示人接下了后果，不表示副作用已消失'

export function EffectRow({ effect }: { effect: UnverifiedEffectView }) {
  return (
    <li className="effect">
      <span className="effect__action">{effect.action}</span>
      <span className="effect__level">{effect.side_effect_policy}</span>
      <span className="effect__stopped">{effect.stopped_at ?? '还没停'}</span>
      <span className="effect__phase">{effect.last_known_phase ?? '—'}</span>
      <span className="effect__state">
        {effect.side_effect_verified_none ? '已确认未发生' : '未验证'}
      </span>
      <span className="effect__evidence">{effect.evidence ?? '—'}</span>
      <span className="effect__age">{effect.age_seconds} 秒</span>
      <span className="effect__resolved">{effect.resolved ? '已解决' : '未解决'}</span>
      <span className="effect__basis">{effect.resolution_basis ?? '—'}</span>
    </li>
  )
}
```

4. 定签字的语义边界。签字只把人接下后果这件事记下来，不改 `side_effect_verified_none`；resolved 的判定只认 `unverified_resolutions` 表，前端不自己算。

**测试：**

- Create: `tests/panel-decision.spec.ts`
  - 待你决定按服务端 priority 与 age 降序；卡上四问都能答出：为什么卡、谁能解、可选什么、需要什么证据、过期会怎样（规格 13.3 行 1123）。
  - 批量按钮只对 acknowledge 可用；resolve 一次一条；界面上没有「忽略」。
  - 待核实是独立一级页，顶部固定句一字不差；`stopped_at` 非空但未确认未发生的一行仍显示「未验证」（Q-29）。
  - 默认视图不出现 node_run_id / batch_id；开发者视图才出现。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/panel-decision.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/client/panel/decision-inbox.tsx src/client/panel/unverified-effects.tsx tests/panel-decision.spec.ts
git commit -m "feat(client): 交出待你决定与待核实两屏"
```

---

### Task 10：六屏之五六——流程列表与流程画布

**目标：** 交出流程列表与流程画布两屏，画布只允许改草稿、发布走控制面命令（规格 8.5 行 656-657）。

**Files:**
- Create: `src/client/panel/workflow-list.tsx` —— 流程列表屏。
- Create: `src/client/panel/workflow-canvas.tsx` —— 流程画布屏与检查面板。
- Create: `tests/panel-workflow.spec.ts` —— 两屏的用例。

**步骤：**

1. 定流程列表行要素（规格 8.5 行 656）：名称、当前版本、草稿状态、节点数、在跑任务、最近发布；可新建、打开草稿、发布。

```tsx
// src/client/panel/workflow-list.tsx
import type { WorkflowView } from '../api/types.ts'

export function WorkflowRow({ wf }: { wf: WorkflowView }) {
  const nodeCount = wf.current?.definition?.nodes?.length ?? 0
  return (
    <li className="workflow-row">
      <span className="workflow-row__name">{wf.draft.definition.title ?? wf.current?.definition.title}</span>
      <span className="workflow-row__version">当前 v{wf.current?.version ?? '—'}</span>
      <span className="workflow-row__draft">{wf.draft.revision > 0 ? '有草稿' : '没有草稿'}</span>
      <span className="workflow-row__nodes">{nodeCount} 个步骤</span>
      <span className="workflow-row__publish">{wf.current?.published_at ?? '还没发布'}</span>
    </li>
  )
}
```

2. 定画布的编辑边界。只有草稿可拖动连线增删，已发布只读；从节点条拖九种节点，右侧圆点拉边，双击空白加一步，整理按拓扑重排（规格 8.5 行 657）。

3. 定检查面板与发布门。检查面板按节点与连线分组显示；有错时发布按钮不可点。发布确认写四件事：目标版本、改动、是否新增不可逆节点、只影响之后新建的 run。

```tsx
// src/client/panel/workflow-canvas.tsx
export type ValidationGroup = { kind: 'node' | 'edge'; items: Array<{ id: string; message: string }> }

export function PublishConfirm(props: {
  targetVersion: number
  changes: string[]
  addsIrreversible: boolean
  affectsOnlyNewRuns: boolean
}) {
  return (
    <div className="publish-confirm">
      <p>发布到 v{props.targetVersion}</p>
      <ul>{props.changes.map((c) => <li key={c}>{c}</li>)}</ul>
      <p>{props.addsIrreversible ? '这次新增了不可逆节点' : '这次没有新增不可逆节点'}</p>
      <p>{props.affectsOnlyNewRuns ? '只影响之后新建的 run' : '会影响在途的 run'}</p>
    </div>
  )
}
```

4. 定画布与智能体的同一份定义。抽屉展示同一份 WorkflowDefinition JSON，旁注「画布和智能体改的是同一份定义，保存都走 workflow.update」（规格 8.5 行 657）；保存与智能体改动共用一条 `workflow.update` 命令与同一个 revision。

**测试：**

- Create: `tests/panel-workflow.spec.ts`
  - 流程列表显示名称、当前版本、草稿状态、节点数、在跑任务、最近发布。
  - 已发布版本在画布上只读：拖动与连线入口禁用。
  - 检查面板按节点与连线分组；有错时发布按钮禁用且给出错误条目。
  - 发布确认四件事齐全：目标版本、改动、是否新增不可逆节点、只影响之后新建的 run。
  - 抽屉里的 JSON 与 `get_workflow` 返回的 definition 一致；旁注句一字不差。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/panel-workflow.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/client/panel/workflow-list.tsx src/client/panel/workflow-canvas.tsx tests/panel-workflow.spec.ts
git commit -m "feat(client): 交出流程列表与流程画布两屏"
```

---

### Task 11：记忆三端口、固定图与四张表

**目标：** 把记忆支线的地基铺好：三个内部端口、只给编排服务的固定图、四张记忆表，以及发布期与加载期的写工具禁令（规格 9.1 行 671-678、9.2 行 682-688、9.3 行 693-703、3.9 行 256-260）。

**Files:**
- Create: `src/infra/sqlite/migrations/030_memory.sql` —— 记忆四张表、索引与批准后只读触发器。
- Create: `src/core/memory-graph.ts` —— 固定图定义、三端口引用前缀与写工具禁令判定。
- Modify: `src/executor/tools.ts` —— 注册 `memory_bridge:` 前缀的三个端口。
- Create: `tests/memory-schema.spec.ts` —— 表结构、约束与触发器的用例。

**步骤：**

1. 建四张表。字段严格按规格 3.9 行 257-260，唯一键照原样：`memory_batches` 唯一键 (source_run_id, attempt)，`memory_items` 唯一键 (batch_id, client_key)，`memory_evaluations` 唯一键 (batch_id, eval_attempt)，`memory_run_requests` 联合主键 (source_run_id, request_key) 且 memory_run_id 唯一。

```sql
-- src/infra/sqlite/migrations/030_memory.sql
CREATE TABLE memory_batches (
  batch_id TEXT PRIMARY KEY,
  source_run_id TEXT NOT NULL,
  memory_run_id TEXT NOT NULL,
  prepare_node_run_id TEXT,
  confirm_node_run_id TEXT,
  apply_node_run_id TEXT,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  proposal_hash TEXT,
  approved_proposal_hash TEXT,
  approved_item_hashes_json TEXT,
  policy_json TEXT,
  evaluation_id TEXT,
  decision_id TEXT,
  applied_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  UNIQUE (source_run_id, attempt)
);

CREATE TABLE memory_items (
  item_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  client_key TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  layer TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  questions_json TEXT NOT NULL DEFAULT '[]',
  key TEXT,
  importance INTEGER,
  ttl_days INTEGER,
  quote TEXT,
  reason TEXT,
  content_hash TEXT NOT NULL,
  approved_content_hash TEXT,
  status TEXT NOT NULL,
  verdict TEXT,
  confidence REAL,
  judge_reason TEXT,
  applied_item_id TEXT,
  UNIQUE (batch_id, client_key)
);

CREATE TABLE memory_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  eval_attempt INTEGER NOT NULL,
  request_hash TEXT NOT NULL,
  model_info TEXT NOT NULL,
  response_json TEXT,
  recommendation TEXT,
  duration_ms INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (batch_id, eval_attempt)
);

CREATE TABLE memory_run_requests (
  source_run_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  memory_run_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_run_id, request_key)
);
```

2. 建批准后只读的触发器（规格 9.8 行 756、Q-52b）。批准后 `memory_items` 禁 INSERT / DELETE，除 status 与 applied_item_id 外只读；绕过触发器改集合则由写入前的快照比对兜住，报 `MEMORY_APPLY_BINDING_INVALID`。

```sql
-- src/infra/sqlite/migrations/030_memory.sql 续
CREATE TRIGGER memory_items_no_insert
BEFORE INSERT ON memory_items
WHEN EXISTS (SELECT 1 FROM memory_batches WHERE batch_id = NEW.batch_id AND status = 'approved')
BEGIN
  SELECT RAISE(ABORT, 'MEMORY_APPLY_BINDING_INVALID');
END;

CREATE TRIGGER memory_items_no_delete
BEFORE DELETE ON memory_items
WHEN EXISTS (SELECT 1 FROM memory_batches WHERE batch_id = OLD.batch_id AND status = 'approved')
BEGIN
  SELECT RAISE(ABORT, 'MEMORY_APPLY_BINDING_INVALID');
END;

CREATE TRIGGER memory_items_no_update
BEFORE UPDATE OF client_key, action, target_id, layer, title, content, tags_json,
  questions_json, key, importance, ttl_days, quote, reason, content_hash ON memory_items
WHEN EXISTS (SELECT 1 FROM memory_batches WHERE batch_id = OLD.batch_id AND status = 'approved')
BEGIN
  SELECT RAISE(ABORT, 'MEMORY_APPLY_BINDING_INVALID');
END;
```

3. 定固定图。规格 9.3 行 693-703：`mem_trigger→mem_prepare→mem_check→mem_route`，ready 走 `mem_confirm→mem_apply→mem_report`，empty 走 `mem_report_empty`，blocked 走 `mem_report_blocked`；三个终态叶子各唯一入边、不合并。

```ts
// src/core/memory-graph.ts
export const MEMORY_BRIDGE_ID = 'memory-audit-v1'
export const MEMORY_TOOL_PREFIX = 'memory_bridge:'

export const MEMORY_GRAPH: Array<[string, string]> = [
  ['mem_trigger', 'mem_prepare'],
  ['mem_prepare', 'mem_check'],
  ['mem_check', 'mem_route'],
  ['mem_route', 'mem_confirm'],
  ['mem_confirm', 'mem_apply'],
  ['mem_apply', 'mem_report'],
  ['mem_route', 'mem_report_empty'],
  ['mem_route', 'mem_report_blocked'],
]

export const MEMORY_TOOLS = {
  evaluate: 'memory_bridge:memory.evaluate',
  applyGoverned: 'memory_bridge:memory.apply_governed',
  inspectBatch: 'memory_bridge:memory.inspect_batch',
} as const

export const MEMORY_WRITE_TOOLS = ['memory_write', 'memory_update'] as const
```

4. 定写工具禁令的三个面（规格 9.1 行 677、Q-44b）。executor 的 allow、agent 节点的 toolPolicy.allow、任务会话模板的 allow，任何一面出现 `memory_write` 或 `memory_update` 都要拒。

```ts
// src/core/memory-graph.ts 续
export function assertNoMemoryWriteTool(allow: readonly string[]): void {
  for (const name of allow) {
    const bare = name.startsWith(MEMORY_TOOL_PREFIX) ? name.slice(MEMORY_TOOL_PREFIX.length) : name
    if ((MEMORY_WRITE_TOOLS as readonly string[]).includes(bare)) {
      throw new OrchError('MEMORY_WRITE_TOOL_FORBIDDEN', '记忆只能从受控通道写入，不许直接调写工具')
    }
  }
}
```

5. 注册三个端口（规格 9.2 行 683-689）。只给编排服务，不注册为 executor 工具；toolRef 前缀 `memory_bridge:` 走独立注册表；capability 分 read_only 与 mutating，apply_governed 是 mutating 且 irreversible。

```ts
// src/executor/tools.ts 续
export type MemoryPort = {
  name: string
  capability: 'read_only' | 'mutating'
  irreversible?: boolean
  invoke: (args: Record<string, unknown>) => Promise<unknown>
}

export function registerMemoryPorts(registry: ToolRegistry, ports: MemoryPort[]): void {
  for (const port of ports) {
    registry.register({
      ref: `${MEMORY_TOOL_PREFIX}${port.name}`,
      capability: port.capability,
      irreversible: port.irreversible === true,
      invoke: port.invoke,
    })
  }
}
```

**测试：**

- Create: `tests/memory-schema.spec.ts`
  - 四张表存在，列名与规格 3.9 一致；唯一键 (source_run_id, attempt)、(batch_id, client_key)、(batch_id, eval_attempt)、(source_run_id, request_key) 都能挡住重复插入。
  - 批次 approved 之后对 `memory_items` 的 INSERT / DELETE / 非白名单字段 UPDATE 都被触发器拒绝，报 `MEMORY_APPLY_BINDING_INVALID`；只改 status 与 applied_item_id 允许（Q-52b）。
  - `memory_run_requests` 同键重复插入报主键冲突；memory_run_id 重复也报冲突。
  - 固定图的三条分支各自唯一入边：`mem_report`、`mem_report_empty`、`mem_report_blocked` 互不相连。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/memory-schema.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/infra/sqlite/migrations/030_memory.sql src/core/memory-graph.ts src/executor/tools.ts tests/memory-schema.spec.ts
git commit -m "feat(memory): 建记忆四表与三端口固定图"
```

---

### Task 12：记忆发起、幂等与 canonical 哈希

**目标：** 交出 `memory_start_run` 的幂等发起、提议条目的边界校验、canonical 原像与两个哈希（规格 9.4 行 704-711、9.5 行 712-724、9.8 行 751-757）。

**Files:**
- Create: `src/core/memory-canonical.ts` —— canonical_item、canonical_proposal 与两个哈希。
- Create: `src/service/commands/memory.ts` —— `memory_start_run` 与批次落库。
- Create: `tests/memory-start.spec.ts` —— 发起幂等、边界校验与哈希的用例。

**步骤：**

1. 定 canonical 原像。规格 9.8 行 753-755：canonical_item 只取十三个字段，tags 升序去重，questions 保序；content_hash = SHA256(JCS(canonical_item))，不含自身与 status；proposal_hash 按 client_key 升序，status 不入原像。

```ts
// src/core/memory-canonical.ts
import { canonicalJson, sha256Hex } from './canonical.ts'

export type MemoryItemInput = {
  client_key: string
  action: string
  target_id: string
  layer: string
  title: string
  content: string
  tags: string[]
  questions: string[]
  key: string | null
  importance: number | null
  ttl_days: number | null
  quote: string | null
  reason: string | null
}

export function canonicalItem(item: MemoryItemInput): Record<string, unknown> {
  return {
    client_key: item.client_key,
    action: item.action,
    target_id: item.target_id,
    layer: item.layer,
    title: item.title,
    content: item.content,
    tags: [...new Set(item.tags)].sort(),
    questions: [...item.questions],
    key: item.key,
    importance: item.importance,
    ttl_days: item.ttl_days,
    quote: item.quote,
    reason: item.reason,
  }
}

export function canonicalProposal(items: MemoryItemInput[]): MemoryItemInput[] {
  return [...items].sort((a, b) =>
    a.client_key < b.client_key ? -1 : a.client_key > b.client_key ? 1 : 0,
  )
}

export function contentHash(item: MemoryItemInput): string {
  return sha256Hex(canonicalJson(canonicalItem(item)))
}

export function proposalHash(items: MemoryItemInput[]): string {
  return sha256Hex(canonicalJson(canonicalProposal(items)))
}
```

2. 定边界校验。规格 9.5 行 714-715：items 不超过 20 条、单条 content 不超过 64KiB、整批不超过 256KiB、title 1–120 字、quote 1–1000 字、reason 1–500 字、questions 不超过 4 条、tags 不超过 12 个。超尺寸报 `MEMORY_BATCH_TOO_LARGE`（413），超内容规范报 `MEMORY_PROPOSAL_INVALID`（422）。

```ts
// src/core/memory-canonical.ts 续
export const MEMORY_LIMITS = {
  items: 20,
  itemBytes: 64 * 1024,
  batchBytes: 256 * 1024,
  titleMin: 1,
  titleMax: 120,
  quoteMin: 1,
  quoteMax: 1000,
  reasonMin: 1,
  reasonMax: 500,
  questions: 4,
  tags: 12,
} as const

export function assertProposalSize(items: MemoryItemInput[]): void {
  if (items.length > MEMORY_LIMITS.items) {
    throw new OrchError('MEMORY_BATCH_TOO_LARGE', `一次最多整理 ${MEMORY_LIMITS.items} 条`)
  }
  let total = 0
  for (const item of items) {
    const bytes = Buffer.byteLength(item.content, 'utf8')
    if (bytes > MEMORY_LIMITS.itemBytes) {
      throw new OrchError('MEMORY_BATCH_TOO_LARGE', '有一条内容太长')
    }
    total += bytes
  }
  if (total > MEMORY_LIMITS.batchBytes) {
    throw new OrchError('MEMORY_BATCH_TOO_LARGE', '这一批内容加起来太长')
  }
}
```

3. 定同目标冲突的处置（规格 9.5 行 717、设计稿 Q-46）。同批两条同 target_id 但内容不同报 `MEMORY_BATCH_CONFLICT`（422），不调评估、不生成审批卡；同 target 同内容合并为一条 skipped_duplicate，不报错。

4. 定 `memory_start_run` 的幂等（规格 9.4 行 706-710）。同 (source_run_id, request_key) 返回同一个 memory_run_id 与 attempt 且 `replayed=true`；同源已有未终结的记忆运行且换 key 报 `MEMORY_RUN_ACTIVE`（409）并返回既有 run_id；源运行未 succeeded 报 `MEMORY_SOURCE_RUN_NOT_SETTLED`（409）；只有 `retry=true` 才把 attempt 加一。映射与建批在同一事务里落。

```ts
// src/service/commands/memory.ts
export function startMemoryRun(
  db: Db,
  args: { source_run_id: string; reason: string; request_key: string; retry?: boolean },
): { memory_run_id: string; attempt: number; replayed: boolean } {
  if (args.request_key.length < 1 || args.request_key.length > 64) {
    throw new OrchError('MEMORY_PROPOSAL_INVALID', 'request_key 长度不对')
  }
  return withTx(db, (tx) => {
    const source = tx.get('SELECT status FROM runs WHERE run_id = ?', [args.source_run_id]) as
      | { status: string }
      | undefined
    if (!source) throw new OrchError('NOT_FOUND', '没找到源运行')
    if (source.status !== 'succeeded') {
      throw new OrchError('MEMORY_SOURCE_RUN_NOT_SETTLED', '源运行还没成功收口，不能整理记忆')
    }
    const mapped = tx.get(
      'SELECT memory_run_id FROM memory_run_requests WHERE source_run_id = ? AND request_key = ?',
      [args.source_run_id, args.request_key],
    ) as { memory_run_id: string } | undefined
    if (mapped) {
      const batch = tx.get('SELECT attempt FROM memory_batches WHERE memory_run_id = ?', [
        mapped.memory_run_id,
      ]) as { attempt: number } | undefined
      return { memory_run_id: mapped.memory_run_id, attempt: batch?.attempt ?? 1, replayed: true }
    }
    const active = tx.get(
      `SELECT memory_run_id FROM memory_batches
       WHERE source_run_id = ? AND status NOT IN ('applied','empty','blocked','declined','expired','failed','indeterminate')`,
      [args.source_run_id],
    ) as { memory_run_id: string } | undefined
    if (active) {
      throw new OrchError('MEMORY_RUN_ACTIVE', '这个任务已经有一条记忆整理在进行', {
        memory_run_id: active.memory_run_id,
      })
    }
    const attempt = args.retry
      ? nextAttempt(tx, args.source_run_id)
      : 1
    const memoryRunId = newId('memrun')
    tx.run(
      `INSERT INTO memory_batches
       (batch_id, source_run_id, memory_run_id, attempt, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
      [newId('batch'), args.source_run_id, memoryRunId, attempt, nowIso(), nowIso()],
    )
    tx.run(
      'INSERT INTO memory_run_requests (source_run_id, request_key, memory_run_id, created_at) VALUES (?, ?, ?, ?)',
      [args.source_run_id, args.request_key, memoryRunId, nowIso()],
    )
    return { memory_run_id: memoryRunId, attempt, replayed: false }
  })
}
```

**测试：**

- Create: `tests/memory-start.spec.ts`
  - 源运行未 succeeded → `MEMORY_SOURCE_RUN_NOT_SETTLED`（409）；成功后可发起（Q-43）。
  - 同 (source_run_id, request_key) 重发返回同一个 memory_run_id 与 attempt，`replayed=true`；同源已有未终结记忆运行换 key → `MEMORY_RUN_ACTIVE`（409）且返回既有 run_id（Q-43）。
  - 并发同 key 请求只有一个事务插进 `memory_run_requests`，另一个主键冲突后读回同一 memory_run_id；重启后同 key 再发仍 `replayed=true`（Q-43c）。
  - 工具超时后同 request_key 重试返回第一次已建的 run；两次重试之间不得出现两条未终结记忆运行，`memory_run_requests` 只有一行（Q-43b）。
  - 21 条、单条超 64KiB、整批超 256KiB → `MEMORY_BATCH_TOO_LARGE`；title/quote/reason 越界、questions 超 4 条、tags 超 12 个 → `MEMORY_PROPOSAL_INVALID`（Q-45）。
  - 同批两条同 target_id 内容不同 → `MEMORY_BATCH_CONFLICT`（422），不调评估、不生成审批卡；同 target 同内容合并为一条 skipped_duplicate（Q-46）。
  - canonical：tags 顺序不同但集合相同 → content_hash 相同；questions 换序 → 不同；proposal_hash 与条目顺序无关、与 client_key 升序有关（规格 9.8）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/memory-start.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/core/memory-canonical.ts src/service/commands/memory.ts tests/memory-start.spec.ts
git commit -m "feat(memory): 实现发起幂等与 canonical 哈希"
```

---

### Task 13：评估端口与审批卡

**目标：** 交出 `memory.evaluate` 的评估口径与审批卡生成、批准与驳回的落库语义（规格 9.5 行 712-724、9.6 行 725-734）。

**Files:**
- Create: `src/core/memory-eval.ts` —— 评估端口的唯一出口、裁判结果解析与 recommendation 推导。
- Modify: `src/service/commands/memory.ts` —— 评估调用、审批卡生成、批准与驳回。
- Create: `tests/memory-eval.spec.ts` —— 评估与审批的用例。

**步骤：**

1. 定评估端口的出口（规格 9.2 行 681-691、9.5 行 712-724）。评估只做四件事：按 prepare_node_run_id 找批次、确定性查重与冲突、调裁判、返回逐条建议；不写记忆、不写 audit store。端口不可用、超时、开关关闭分别报 `MEMORY_EVAL_UNAVAILABLE`（503）、`MEMORY_EVAL_TIMEOUT`（504）、`MEMORY_EVAL_DISABLED`（503），批次与运行都 failed，不写任何记忆。

```ts
// src/core/memory-eval.ts
export type EvalVerdict = 'approve' | 'reject' | 'merge' | 'needs_user'
export type EvalItem = { client_key: string; verdict: EvalVerdict; reason: string; confidence: number }
export type EvalResult = {
  recommendation: 'ready' | 'empty' | 'blocked'
  items: EvalItem[]
  truncated: boolean
  model: string
  prompt_version: string
}

export const JUDGE_CONTENT_LIMIT = 4000

export function summarize(items: EvalItem[]): EvalResult['recommendation'] {
  if (items.some((i) => i.verdict === 'needs_user')) return 'blocked'
  if (items.some((i) => i.verdict === 'approve' || i.verdict === 'merge')) return 'ready'
  return 'empty'
}

export function assertEvalShape(items: EvalItem[], truncated: boolean): void {
  if (truncated && !items.some((i) => i.verdict === 'needs_user')) {
    throw new OrchError('MEMORY_EVAL_INVALID_OUTPUT', '裁判输出被截断了，结论不可用')
  }
}
```

2. 定解析失败的处置。裁判返回非 JSON、缺 items、verdict=maybe 都报 `MEMORY_EVAL_INVALID_OUTPUT`（502）；批次 failed、run failed、不生成审批卡、不写入，剩余 proposed 全部 skipped；重跑产生新的 evaluation attempt，旧评估保留（唯一键 (batch_id, eval_attempt)）。

3. 定审批卡。只有 `recommendation=ready` 才生成审批卡，挂 `mem_confirm`，kind 为 `audit_result`；`allowed_resolutions` 为空，resolve 的 payload 是空对象，只产生 approved 或 rejected 两种结果（规格 9.6 行 725-733）。

```ts
// src/service/commands/memory.ts 续
export type ApprovalCard = {
  title: string
  summary_line: string
  items: Array<{ layer: string; title: string; digest: string; judge_reason: string }>
  buttons: Array<{ label: string; resolution: string }>
}

export function buildApprovalCard(
  prepared: MemoryItemInput[],
  items: EvalItem[],
): ApprovalCard {
  const written = items.filter((i) => i.verdict === 'approve' || i.verdict === 'merge')
  const skipped = items.filter((i) => i.verdict === 'reject')
  return {
    title: '这几条要写进记忆，你看看',
    summary_line: `这次整理出 ${prepared.length} 条 / 建议写入 ${written.length} 条 / 不写 ${skipped.length} 条`,
    items: written.map((i) => {
      const src = prepared.find((p) => p.client_key === i.client_key)
      return {
        layer: src?.layer ?? '',
        title: src?.title ?? '',
        digest: (src?.content ?? '').slice(0, 80),
        judge_reason: i.reason,
      }
    }),
    buttons: [
      { label: '按这个方案写入', resolution: 'approved' },
      { label: '这次不写', resolution: 'rejected' },
    ],
  }
}
```

4. 定批准与驳回的落库。批准 = 按方案写、reject 条跳过：同事务写 `approved_proposal_hash`、`approved_item_hashes_json`，并逐条写 `approved_content_hash`，之后只读。驳回 = 一条不写、批次 declined、`mem_confirm` 按 approval 默认动作 failed、运行 failed、任务运行不受影响。过期 = 24 小时未确认则批次 expired，不自动放行。

5. 定评估唯一键与重跑。`memory_evaluations` 唯一键 (batch_id, eval_attempt)；失败后重跑 attempt 加一，旧评估行保留。

**测试：**

- Create: `tests/memory-eval.spec.ts`
  - 裁判返回非 JSON / 缺 items / verdict=maybe → `MEMORY_EVAL_INVALID_OUTPUT`（502），批次 failed、run failed、无审批卡、无写入，剩余 proposed 全部 skipped；重跑产生新 attempt，旧评估保留（Q-47）。
  - `truncated=true` 且 verdict=approve → `MEMORY_EVAL_INVALID_OUTPUT`，不进 ready；只有 needs_user 允许 truncated（批次 blocked、无写入）（Q-47b）。
  - 任一条 needs_user → recommendation=blocked，不生成审批卡，走 `mem_report_blocked` 收口，批次 outcome=blocked（Q-48）。
  - 2 approve 1 reject → recommendation=ready，审批卡首行是「这次整理出 3 条 / 建议写入 2 条 / 不写 1 条」，两个按钮文案一字不差（Q-49）。
  - 批准后只写 2 条，第 3 条 status=skipped，批次 outcome=written、applied_count=2、skipped_count=1；全程只一张审批卡（Q-49）。
  - 驳回 → decision=rejected、批次 declined、run failed、未调 `memory.apply_governed`、记忆条目数不变、任务 run 仍 succeeded（Q-50）。
  - 超 24 小时未确认 → decision=expired、批次 expired、无写入、不自动批准（Q-51）。
  - 评估端口超时 / 不可用 / 开关关闭分别 `MEMORY_EVAL_TIMEOUT` / `MEMORY_EVAL_UNAVAILABLE` / `MEMORY_EVAL_DISABLED`，批次 failed、run failed、无审批卡无写入（Q-60）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/memory-eval.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/core/memory-eval.ts src/service/commands/memory.ts tests/memory-eval.spec.ts
git commit -m "feat(memory): 实现评估口径与审批卡落库"
```

---

### Task 14：记忆写入与部分写入对账

**目标：** 交出 `memory.apply_governed` 的三道核对、判定顺序、原子写入与幂等，以及 tool.result 丢失后的对账三走向（规格 9.7 行 735-750、Q-52 / Q-52b / Q-54 / Q-57 / Q-58 / Q-59 / Q-62）。

**Files:**
- Modify: `src/service/commands/memory.ts` —— apply、confirm_applied、confirm_not_applied。
- Create: `src/service/queries/memory.ts` —— `memory.inspect_batch` 读侧与记忆面板的取数。
- Create: `tests/memory-apply.spec.ts` —— 写入、绑定、幂等与对账的用例。

**步骤：**

1. 定三道核对与判定顺序（规格 9.7 行 737-742）。顺序不能颠倒：批次不存在 → `MEMORY_BATCH_NOT_FOUND`（404）；批次非 approved 或 decision 非 approved / 已过期 → `MEMORY_BATCH_NOT_APPROVED`（409）；归属不符或快照不符 → `MEMORY_APPLY_BINDING_INVALID`（403）；同键同批已存在且哈希不同 → `MEMORY_APPLY_CONFLICT`（409）；其余写失败 → `MEMORY_APPLY_FAILED`（500）。

```ts
// src/service/commands/memory.ts 续
export function verifyApplyBinding(args: {
  batch: BatchRow
  decision: DecisionRow
  items: ItemRow[]
  memoryRunId: string
  sourceRunId: string
}): void {
  const { batch, decision, items } = args
  if (batch.status !== 'approved') {
    throw new OrchError('MEMORY_BATCH_NOT_APPROVED', '这批记忆还没批准')
  }
  if (decision.status !== 'approved' || decision.kind !== 'audit_result' || isExpired(decision)) {
    throw new OrchError('MEMORY_BATCH_NOT_APPROVED', '这条批准已经不算数了')
  }
  if (batch.memory_run_id !== args.memoryRunId || batch.source_run_id !== args.sourceRunId) {
    throw new OrchError('MEMORY_APPLY_BINDING_INVALID', '这条批准不是这批记忆的')
  }
  const current = proposalHash(items.map(toItemInput))
  if (!batch.approved_proposal_hash || current !== batch.approved_proposal_hash || current !== batch.proposal_hash) {
    throw new OrchError('MEMORY_APPLY_BINDING_INVALID', '批次内容跟批准时对不上')
  }
  const approved = JSON.parse(batch.approved_item_hashes_json ?? '[]') as Array<[string, string]>
  if (!samePairs(approved, items.map((i) => [i.client_key, i.content_hash]))) {
    throw new OrchError('MEMORY_APPLY_BINDING_INVALID', '批准后的条目集合变了')
  }
  for (const item of items) {
    if (item.approved_content_hash && item.content_hash !== item.approved_content_hash) {
      throw new OrchError('MEMORY_APPLY_BINDING_INVALID', '有条目的正文跟批准时不一样')
    }
  }
}
```

2. 定幂等与冲突。幂等键是 (batch_id, client_key)：同哈希重放返回 `already_applied=true`、`applied_count=0`、条目总数不变、不产生新的 `memory.applied` 事件只记一条 replay；不同哈希报 `MEMORY_APPLY_CONFLICT`（409），整笔拒绝不覆盖（规格 9.7、Q-53、Q-59）。

3. 定写入的原子性。整批先校验全部，再一次性持久化；任一条写失败则整批不落，批次 failed、approved 条目全标 failed、节点 failed、不生成未验证副作用，同批次不自动重试，要再写就新建批次 attempt+1，旧批次保留 failed（规格 9.7、Q-61）。

4. 定 tool.result 丢失的三走向（规格 9.7、Q-54）。批次保持 applying、outcome 为空、节点 indeterminate，先对账：
   - inspect 显示条目都在 → `confirm_applied` 收 done、批次 applying→applied、不重复写；
   - 显示 0 条 → `confirm_not_applied`，旧 apply 节点 superseded、新 attempt 重跑，批次全程保持 applying，成功后 applied；
   - 显示部分（1 条）→ 批次 applying→indeterminate、outcome=indeterminate，已写 applied、未写 approved，节点留 indeterminate 并开 verify_human，运行 paused，`allowed_resolutions` 只给 abandon；签字后节点 abandoned_unverified、运行仍 paused 并生成 abandon_ack，签字后运行落 succeeded_with_unverified，批次保持 indeterminate，不补写、不回滚、不重试。

`confirm_applied` 与 `confirm_not_applied` 必须带 stopped_at 与 evidence_id，缺任一项报 `VERIFICATION_TOO_WEAK`，节点与批次都不动。

```ts
// src/service/commands/memory.ts 续
export function assertVerificationProof(args: {
  stopped_at?: string | null
  evidence_id?: string | null
}): void {
  if (!args.stopped_at || !args.evidence_id) {
    throw new OrchError('VERIFICATION_TOO_WEAK', '对账要同时给出停止时间和证据编号')
  }
}
```

5. 定 inspect 的返回形状。返回 batch_id、逐条 status、written_count、missing_count、partial、evidence_id，并把 evidence_id 记进事件账本（Q-54）。

6. 定 v1 的边界：不删除记忆、不做跨运行补偿（规格 9.7 行 749）。

**测试：**

- Create: `tests/memory-apply.spec.ts`
  - 用另一批次的 decision_id 调 apply → `MEMORY_APPLY_BINDING_INVALID`（403），整笔拒绝一条不写，错误文案不含哈希与内部 id；源运行 A 的批次不能用源运行 B 的 decision_id（Q-52、Q-55）。
  - 改某条 content 后调 apply → `MEMORY_APPLY_BINDING_INVALID`；同时改 content 与 content_hash 并重算 proposal_hash 仍被拒（Q-52）。
  - 批准后直接 UPDATE 正文 / 哈希 / 集合被数据库约束拒绝（触发器），只改 status 不改正文时 proposal_hash 不变，tags 仅换顺序按规范化等价不算改值（Q-52、Q-52b）。
  - 同批连续两次 apply：第一次写 2 条，第二次 already_applied=true、applied_count=0、条目总数仍 2、不产生新的 memory.applied 事件只记一条 replay（Q-53）。
  - 批次不存在或不属于该记忆 run → `MEMORY_BATCH_NOT_FOUND`（404），不读批次内容不写（Q-57）。
  - 批次还在 awaiting_human 或 decision 已 rejected / expired 时调 apply → `MEMORY_BATCH_NOT_APPROVED`（409），优先于 binding invalid 与 conflict（Q-58）。
  - 同 (batch_id, client_key) 已存在且 content_hash 不同 → `MEMORY_APPLY_CONFLICT`（409），整笔拒绝不覆盖（Q-59）。
  - 错误码优先级：批次未 approved 与归属不符同时成立 → NOT_APPROVED；快照不符与同键哈希不同同时成立 → BINDING_INVALID；只有前四类不命中才看 conflict（Q-62）。
  - apply 的 tool.result 丢失 → 节点 indeterminate_side_effect、批次保持 applying、outcome 空；inspect 返回 batch_id / 逐条 status / written_count / missing_count / partial / evidence_id；confirm_applied 缺 stopped_at 或 evidence_id → `VERIFICATION_TOO_WEAK` 且节点与批次不动；显示 2 条都在 → confirm_applied 收 done、批次 applying→applied 不重复写；显示 0 条 → confirm_not_applied 后旧 apply 节点 superseded、新 attempt 重跑；显示 1 条 → 批次 indeterminate、已写 applied、未写 approved、节点 indeterminate 并开 verify_human、run paused、allowed_resolutions 只给 abandon，签字后节点 abandoned_unverified、run 仍 paused 等 abandon_ack，签字后 run succeeded_with_unverified，批次保持 indeterminate 不补写不回滚（Q-54）。
  - 写入后条目能追回 source_run_id / memory_run_id / batch_id / decision_id / client_key（Q-56）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/memory-apply.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/service/commands/memory.ts src/service/queries/memory.ts tests/memory-apply.spec.ts
git commit -m "feat(memory): 实现受控写入与部分写入对账"
```

---

### Task 15：记忆面板与审批卡

**目标：** 把记忆做成面板里的一等公民：审批卡进「待你决定」，另有一块记忆区只答四问（规格 9.9 行 758-762；设计稿 §5.9）。

**Files:**
- Create: `src/client/panel/memory-panel.tsx` —— 记忆区与十二句状态文案。
- Modify: `src/client/panel/decision-inbox.tsx` —— 接入审批卡。
- Create: `tests/panel-memory.spec.ts` —— 记忆面板与审批卡的用例。

**步骤：**

1. 定状态文案表。十二句一字不改（规格 9.9 行 762）：正在整理 / 管家在看有没有重复 / 有 N 条等你确认 / 开始写入 / 正在写入 / 写了 N 条 / 这次没有需要写的 / 有 1 条拿不准，这次没写 / 你选择先不写 / 超过 24 小时没确认，这次没写 / 没写成：裁判没给出结果 / 写到一半，等你确认。

```ts
// src/client/panel/memory-panel.tsx
import type { MemoryBatchView } from '../api/types.ts'

export type MemoryCopy = { text: string; tone: 'neutral' | 'wait' | 'good' | 'warn' }

export function memoryCopy(batch: MemoryBatchView): MemoryCopy {
  switch (batch.status) {
    case 'draft': return { text: '正在整理', tone: 'neutral' }
    case 'evaluating': return { text: '管家在看有没有重复', tone: 'neutral' }
    case 'awaiting_human': return { text: `有 ${batch.pending_count} 条等你确认`, tone: 'wait' }
    case 'approved': return { text: '开始写入', tone: 'neutral' }
    case 'applying': return { text: '正在写入', tone: 'neutral' }
    case 'applied': return { text: `写了 ${batch.applied_count} 条`, tone: 'good' }
    case 'empty': return { text: '这次没有需要写的', tone: 'neutral' }
    case 'blocked': return { text: '有 1 条拿不准，这次没写', tone: 'warn' }
    case 'declined': return { text: '你选择先不写', tone: 'warn' }
    case 'expired': return { text: '超过 24 小时没确认，这次没写', tone: 'warn' }
    case 'failed': return { text: '没写成：裁判没给出结果', tone: 'warn' }
    case 'indeterminate': return { text: '写到一半，等你确认', tone: 'warn' }
    default: return { text: batch.status, tone: 'neutral' }
  }
}
```

2. 定审批卡在「待你决定」里的位置。审批卡是普通裁决卡的一种，kind 为 `audit_result`；标题「这几条要写进记忆，你看看」，首行「这次整理出 N 条 / 建议写入 M 条 / 不写 K 条」，每条一行写层、标题、摘要、裁判理由，按钮「按这个方案写入」「这次不写」，可展开「为什么记这条」。不另开入口（设计稿 §5.9）。

3. 定默认视图的隐藏项。记忆面板不展示 session_id / node_run_id / batch_id / evaluation_id / proposal_hash / token / SQL / 插件路径；开发者视图单独一栏、默认折叠，才显示 batch_id / evaluation_id / proposal_hash / decision_id。

4. 定 indeterminate 的显示。批次 indeterminate 时显示「写到一半，等你确认」，已写入条目可见、未写入条目不可见，唯一可选动作是「放弃这次写入」。

**测试：**

- Create: `tests/panel-memory.spec.ts`
  - 十二句状态文案与规格逐字相等；批次 indeterminate 时显示「写到一半，等你确认」且唯一可选动作是放弃（Q-63）。
  - 审批卡标题与首行格式正确，两个按钮文案一字不差；卡片里没有 batch_id / node_run_id（Q-49、Q-63）。
  - 开发者视图默认折叠，展开后才出现 batch_id / evaluation_id / proposal_hash / decision_id。
  - 默认视图全文不出现 token、SQL 语句、插件路径字样。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/panel-memory.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/client/panel/memory-panel.tsx src/client/panel/decision-inbox.tsx tests/panel-memory.spec.ts
git commit -m "feat(client): 交出记忆面板与审批卡"
```

---

### Task 16：阶段闸、G5 门记录与三条必过注入

**目标：** 让 S5 启动时拒掉 wf_release_v1，把 G5 的必过项逐条跑成证据，并交出 `docs/gates/G5.md` 与 GateArtifact（规格 11.2 行 951、11.3 行 957-986、13.5 行 1139-1143）。

**Files:**
- Create: `src/core/gate-artifact.ts` —— GateArtifact 构造、结论推导与四个哈希原像。
- Modify: `src/app/capabilities.ts` —— 阶段能力闸：S5 拒 release 能力。
- Modify: `scripts/gate-check.ts` —— G5 必过项的检查入口。
- Create: `tests/gate-g5.spec.ts` —— 阶段闸与门记录的用例。
- Create: `docs/gates/G5.md` —— G5 门记录正文与 artifact_hash 锚点。

**步骤：**

1. 定阶段闸。规格 2.4 行 120-123：阶段开关只许 S1 到 S6，未知值拒绝启动，只能逐级抬；加载期与启动期按 `min_phase` 拒越阶段能力。S5 启动 wf_release_v1 必须被拒。

```ts
// src/app/capabilities.ts 续
export function assertPhaseAllows(phase: string, capability: string): void {
  const allowed = PHASE_CAPABILITIES[phase as Phase] ?? []
  if (!allowed.includes(capability)) {
    throw new OrchError('FORBIDDEN', `${phase} 阶段不开 ${capability}`, { phase, capability })
  }
}
```

2. 定 GateArtifact 的构造与结论。规格 11.3 行 957-986：字段固定；`conclusion=pass` 当且仅当 must_pass_items 全 pass、failed_items 为空、run_terminal=succeeded（无 run 的门为 not_applicable 且 gate_run_id=null）；artifact 内部不放 record_hash / artifact_hash 自指字段。

```ts
// src/core/gate-artifact.ts
export type MustPassItem = { id: string; result: 'pass' | 'fail'; evidence_ids: string[] }

export type GateArtifact = {
  gate: string
  schema_version: 1
  gate_run_id: string | null
  candidate_hash: string
  change_scope_hash: string
  evidence_index_hash: string
  invariants_hash: string
  must_pass_items: MustPassItem[]
  failed_items: string[]
  conclusion: 'pass' | 'fail'
  run_terminal: string
  exceptions: GateException[]
  rollback: { target: string; action: string; duration_s: number; verification: string }
  approver: string
  approved_at: string
  producer: string
}

export function buildGateArtifact(input: Omit<GateArtifact, 'conclusion' | 'failed_items'>): GateArtifact {
  const failed = input.must_pass_items.filter((i) => i.result !== 'pass').map((i) => i.id)
  const ok = failed.length === 0 && input.run_terminal !== 'failed'
  return { ...input, failed_items: failed, conclusion: ok ? 'pass' : 'fail' }
}
```

3. 定四个哈希的原像（规格 15.2 行 1196-1212）。全部先 canonical_json 再 SHA256。G5 的 `candidate_hash` 用同一结构，phase 取 `"S5"`。

```ts
// src/core/gate-artifact.ts 续
export function candidateHashOf(gitSha: string, phase: string): string {
  return sha256Hex(canonicalJson({ git_sha: gitSha, schema_version: 1, phase }))
}

export function changeScopeHashOf(capabilityIds: string[], touchedPaths: string[]): string {
  return sha256Hex(canonicalJson({
    capability_ids: [...new Set(capabilityIds)].sort(),
    touched_paths: [...new Set(touchedPaths)].sort(),
  }))
}
```

4. 跑必过项。Q-01 到 Q-36 与 Q-43 到 Q-63（含 43b / 43c / 44b / 44c / 47b / 52b）逐条跑并留下证据编号；两条视口检查、正文与辅助字号、菜单与顶导字号、浅色对比度、记忆部分写入可对账、S5 启动 wf_release_v1 被拒，逐条留证据。**G5 的清单里必须显式列出 Q-52b**，只列 Q-52 不列 Q-52b 则 G5 不算完整（规格 15.5 行 1224-1227）。

5. 跑三条必过注入：G-06（tool.result 丢失）、G-11（记忆批次写一半杀）、G-12（审批双击与同决定重复提交）。每条注入留下注入脚本与参数、前后账本片段、恢复后对账查询三样东西；没有对账查询的注入不算通过（规格 12.3 行 1077）。

6. 写门记录。正文先写结论，结论后放固定锚点：

```markdown
# G5 门记录

结论：pass

artifact_hash=SHA256(canonical_json(artifact))
```

补记只追加在锚点后，不移动锚点，也不算进哈希（规格 11.3 行 984、15.7 行 1234-1236）。G5 是无 run 的门：`gate_run_id=null`、`run_terminal=not_applicable`、`producer=human`。

**测试：**

- Create: `tests/gate-g5.spec.ts`
  - 阶段闸：S5 加载 release 能力被拒（FORBIDDEN），S6 允许；未知 phase 拒绝启动。
  - GateArtifact：must_pass_items 有 fail 或 failed_items 非空 → conclusion=fail；无 run 的门 gate_run_id=null 且 run_terminal=not_applicable 才可能 pass。
  - 门记录文件存在，锚点行在结论之后，且 `artifact_hash=` 的取值等于对 artifact 本体算出的 SHA256(canonical_json(artifact))。
  - G5 清单里出现 Q-52b 字样。

**验收：**

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm gate --gate G5
```

期望：全绿；`pnpm gate --gate G5` 输出 G5 必过项逐条结论，任一条失败则门记录结论为 fail。

**提交：**

```powershell
git add src/core/gate-artifact.ts src/app/capabilities.ts scripts/gate-check.ts tests/gate-g5.spec.ts docs/gates/G5.md
git commit -m "feat(gate): 交出阶段闸与 G5 门记录"
```

---

### Task 17：自治档位与审计留痕的显示

目标：把任务档位、escalations 名单、decision 的 approver 与「已由审计通过」的留痕接进读视图与两屏（规格 §18.3、§18.4、§8.5）。

**Files:**

- `src/service/read/task-view.ts` — TaskView 增档位字段（修改）
- `src/service/read/decision-view.ts` — DecisionView 增批准人与收口人（修改）
- `src/client/panel/task-detail.tsx` — 任务详情显示档位与例外名单（修改）
- `src/client/panel/decision-inbox.tsx` — 待你决定只列人来批的，审计收口进折叠区（修改）

步骤：

1. TaskView 增 autonomy 与 escalations，人话渲染成「自己跑」「有事问你」「逐条等你」，名单渲染成「这些要问你：发布流程版本、改记忆」。档位只在任务详情出现，不占列表主行。

2. DecisionView 增 approver 与 resolved_by，人话渲染「等审计」「等你」「谁在谁批」；已收口的写清是谁收的、依据哪条证据。

3. 待你决定只列 approver=human，以及 approver=either 且尚未被审计收口的；approver=agent:<role> 的一律不进主列。

4. 被审计收口的进「已由审计通过」折叠区：可回看结论与证据引用，不给批准按钮，不提供代批入口（规格 §18.4）。

5. 数字等于列表长度：卡片上「等你决定 N 条」必须等于点进去的列表条数，由服务端同一快照算；前端不许自己数、不许补齐。

测试：

- `tests/unit/decision-view.spec.ts`：approver=agent 的 decision 不出现在待你决定主列；折叠区带审计结论与证据引用；列表数字与列表长度相等；同一快照内两处数字一致。

验收：

```powershell
pnpm typecheck
pnpm test -- decision-view
pnpm build
```

期望：三绿；待你决定的条数与卡片数字逐次相等；审计收口的条目在主列与折叠区之间没有重复也没有遗漏。

提交：`feat(panel): 显示自治档位与审计留痕`

---

## 风险与回退

**风险与对冲**

1. 展示层自己发明映射，观测缺口被静默粉饰成确定性。风险：面板把 `startup_unknown` 显示成「等待中」，人据此去批确认未启动并重跑不可逆动作。对冲：显示口径由服务端给全，节点 status 原文永远并列在 display_status 旁边；面板不持有映射表，不做本地状态改写。
2. 证据缺失却显绿。风险：done 节点没有验证证据，界面显示绿色「已验证」。对冲：证据四列由服务端算好，强度为「—」而不是 none，没有证据不许显绿（规格 8.6 行 667）。
3. 面板把命令当重试。风险：超时后重复提交造成二次写入。对冲：面板不做乐观更新，提交后按 operation_id 查回执；超时先查回执、不重复提交。
4. 批准快照与实际条目脱钩。风险：批准后有人改了正文，apply 仍按旧快照写。对冲：批准同事务写 approved_proposal_hash / approved_item_hashes_json / approved_content_hash；apply 三道核对逐项重算；数据库触发器再挡一层，绕过触发器仍有比对兜底。
5. 记忆写入一半。风险：批次停在 applying，界面显示「正在写入」，实际部分条目已落。对冲：tool.result 丢失即节点 indeterminate，先对账；confirm_applied / confirm_not_applied 必须带 stopped_at 与 evidence_id；部分写入转 indeterminate 并只给 abandon，不补写不回滚。
6. 阶段越权。风险：S5 提前启用 release 能力。对冲：阶段闸在加载期与启动期按 min_phase 拒越阶段能力，S5 启动 wf_release_v1 必须被拒，这一条本身是 G5 必过项。

**回退**

- 阶段回滚按规格 11.5 行 1001 的 S5 档：关面板与记忆路由，引擎账本继续跑。已经写到一半的记忆先对账再处置，不补写、不回滚（规格 9.7 行 749）。
- 数据回退：`030_memory.sql` 是扩展型迁移，只加表与触发器。回退时关闭记忆路由即可，不删表、不改已落批次的状态。
- 面板回退：面板是纯客户端，关掉面板路由不影响账本与执行；读模型投影出的缓存可整段丢弃重建，账本事实不动。
- 门回退：G5 结论为 fail 时，不许进 S6；已写的 G5 记录按规格 15.7 只在锚点后追加补记，不改结论、不移动锚点。

---

## 完成定义

S5 完成的判定，同时满足以下每一条：

1. 规格 8.3 的十八个查询全部可用，同一页内是同一快照，`as_of_seq` 与该事务看到的最大 `events.seq` 一致；游标不透明、10 分钟过期、过滤变更报 `CURSOR_FILTER_MISMATCH`。
2. 七种读视图的字段与规格 8.2 一致；attention 排序、priority、三数聚合、证据四列、未验证副作用判定全部由服务端给全。
3. 控制面只开六条命令；幂等顺序、确认预检、revision CAS、actor 派生按规格 3.7 与 8.4 落地。
4. SSE 只作失效信号：断号整页重取、重复事件按 event_id 去重、断线保留最后快照并标 stale。
5. 六屏齐活，逐屏能回答规格 13.3 行 1121 的走查项；默认视图不出现 session_id / agent_id / node_run_id / event_id / batch_id。
6. 视觉硬门槛在两个视口下成立：正文不小于 13px、辅助不小于 12px、菜单与顶导不小于 12.5px、正文对比度 4.5:1、大字与 UI 3:1、浅色主题无黑底无菜单彩色左条、无横向溢出。
7. 记忆三端口、固定图、四张表就位；`memory_start_run` 幂等；canonical 与两个哈希符合规格 9.8；评估四件事与失败口径齐全；审批卡文案与落库语义齐全；apply 三道核对、幂等、原子与部分写入对账齐全。
8. 批准后 `memory_items` 的四种篡改（INSERT / DELETE / 非 content 字段 UPDATE / 换序）都被拒，报 `MEMORY_APPLY_BINDING_INVALID`（Q-52b）。
9. 三条必过注入 G-06 / G-11 / G-12 跑完并各留三样东西（注入脚本与参数、前后账本片段、恢复后对账查询）。
10. S5 启动 wf_release_v1 被拒；R2 受控圈、发布、三圈、G-01 到 G-16 全量与 24 小时浸泡均未开工。
11. `pnpm check` 通过（typecheck + test + build），`pnpm gate --gate G5` 全绿。
12. 任务档位与审计留痕可见：任务详情显示自治档位与例外名单，待你决定只列人来批的，审计收口的在折叠区可回看不可代批，卡片数字等于列表长度（规格 §18.3、§18.4）。
13. `docs/gates/G5.md` 存在，结论之后有固定锚点 `artifact_hash=SHA256(canonical_json(artifact))`，且 artifact 的 must_pass_items 逐项有证据、failed_items 为空、producer=human、gate_run_id=null、run_terminal=not_applicable。
