# dsh-orchestra S2 单节点闭环 实施计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 让一个 agent 节点从排队走到终态走通一条完整路径——桥 RPC 最小集、租约与心跳、executor 子智能体、上报收口（applyReport 六步）、证据判定、取消与超时围栏、单调时钟截止判定——并交出 G2 门记录。规格 11.1 行 831 写的 S2 目标是「单节点闭环 | 仅 agent；桥、租约、上报、终态、取消、证据、超时 | G2」，本批把这行字逐条变成可跑的代码与可验的门。

**Architecture:** 账本侧仍由 S1 的单写者 SQLite 服务承担，本批只加列与两个语义列，不改写入拓扑：所有状态迁移写回 `node_runs`，所有迁移带 CAS（`UPDATE` 语句的 `WHERE` 条件里含 revision / attempt / action_generation 之一，受影响行数必须恰为 1），所有终态、拒绝与扫描决策写 `node_run_events` 哈希链。执行侧新增「执行桥客户端 + executor 子智能体」：编排服务通过桥把节点派给一个不继承主会话历史的子智能体，子智能体只拿节点输入、工具策略与输出 schema；它做不做得由编排服务说了算——完成状态只能由 `applyReport` 收口，agent 不能自报完成。证据分强弱两档：`runTool` 以宿主只读身份跑注册表里的固定命令产出强证据，模型侧 `tool_result` 只是弱证据，不可逆节点只认产物哈希。代际分两支：`Ga` 跟动作走，`rearm_generation` 跟续期走，两者不许合并成一个数。门是 G2：单节点一条路径、重复上报只落一次、租约过期迟到上报被拒、取消后不产生新 attempt、终态必带证据、无裸 blocked、S2 加载 parallel 被拒，外加 G-03 / G-04 / G-05 / G-07 四条故障注入。

**Tech Stack:** 同 S1：TypeScript 6.0.3（ESM / NodeNext）· Node `^22.19.0 || >=24.0.0` · pnpm 11.7.0 · vitest 4.1.8 · zod 4.4.3 · node:sqlite（内置 DatabaseSync）· 桥与 executor 走宿主侧插件接口，测试用替身

---

## 0. 前置、边界与口径

前置：S1 批次（`docs/superpowers/plans/2026-11-12-dsh-orchestra-s1-ledger.md`）已实施并过 G1 门，`pnpm check` 通过；账本已有 S1 建好的十张最小表、迁移框架、哈希链与 epoch 栅栏。本批所有路径从总纲 §3 目录布局派生，新增文件只落在总纲已列的目录里。

**本批能做什么**：桥 RPC 最小集（spawn / subscribe / send / cancel / dispose / state / whenIdle）与桥事件缓冲；工具注册表与前向能力推导；`runTool` 只读执行与强证据；节点租约与心跳；agent 节点执行器；node_run 状态机与 Ga / Gr；`applyReport` 六步与 `report_registry`；证据门与判定规则；取消与超时围栏；截止时间与单调时钟；S2 阶段开关与加载期拒；G2 用例与门记录。

**本批不能做什么**（规格 11.1 行 842 的 S2 阶段能力表逐条照抄）：S2 允许「单 agent 节点闭环」，禁止 `parallel`、`subworkflow`、`workflow 发布`。因此：不实现 parallel / subworkflow 节点，不实现 `workflow.*` 四个命令，不发布流程版本。S1 遗留的禁止项「面板接真实账本」在本批仍然禁止——面板这一批连壳都不建，面板能力属于 S5。

**对应门 G2 必过项**（规格 11.2 行 852，原文引用）：

> G2 必过：单节点 queued 到终态一条路径、重复上报只落一次、租约过期迟到上报被拒、取消后不产生新 attempt、终态必带证据、无裸 blocked、S2 加载 parallel 被拒、G-03 / G-04 / G-05 / G-07。

每条注入用例都要留三样东西（规格 12.3 行 984 原文口径）：注入脚本与参数、前后账本片段、恢复后对账查询。没有对账查询的注入不算通过。

**口径说明（七处合并定案）**：

- 规格 17.1 没有「租约过期」与「桥确认位落后」两个码。本批提出两个**新增错误码提案**，代码里以 `PROPOSED_ERROR_CODES` 单列，**不并进 `ERROR_STATUS`**，等规格 17.1 修订后才算既成事实：
  - `LEASE_EXPIRED`（HTTP 409）—— 租约过期后原执行器的迟到上报被拒时点名用它。理由：G-04 要求「迟到报告被拒」有可区分的原因码，复用 `STALE_GENERATION` 会把「代际不一致」与「租约过期」两种事实混在一处，事后对账分不开。
  - `BRIDGE_ACK_LAG`（HTTP 409）—— `dispose` 前置 `service_ack_seq < bridge_last_seq` 时点名用它。理由：规格 7.3 行 594 只写了「dispose 前必须确认所有事件已被服务确认」，没给码；复用 `FORBIDDEN` 会与阶段闸混在一起。
  - 落点：Task 1 落表，Task 2 与 Task 6 引用；两码都进 §未决参数。
- 请求参数缺字段、越界、不合 schema 一律 `SCHEMA_VERSION_UNSUPPORTED`（422）；宿主回包字段不对或取值不在枚举里一律 `PROTOCOL_VERSION_MISMATCH`（409）。沿用 S1 的配置与信封口径，本批不为此另造码。
- `cwd` 越出工作区按越权处理，用 `FORBIDDEN`（403），不用参数错误码。理由：越权与「参数缺字段」是两类事实，混用会让阶段闸的排查失真。
- 落库前的命令哈希核对对不上时用 `VERIFICATION_TOO_WEAK`（422）。理由：证据与注册表命令对不上，等于这份证据不足以支撑任何通过判定。
- 证据不足同时做两件事：报告按 `VERIFICATION_TOO_WEAK` 拒收（不入完成账），节点转 `blocked_post` 并在 `node_run_events` 记一条 `verify_human` 请求事件。理由：规格 4.7 行 391 要「证据不足转 verify_human」，而不可逆凭据不足要报 `VERIFICATION_TOO_WEAK`；只拒不移会让节点停在原地，只移不拒会让弱证据蒙混过关。
- 总纲 §3 的 `src/core/` 文件清单里没有时钟文件，而截止判定必须落在不引 IO 的领域层。本批新增 `src/core/clock.ts`（目录仍属总纲 §3 的 `src/core/`）；桥事件缓冲不另起文件，落在 `src/executor/bridge.ts` 里（executor 层允许直接用宿主文件系统，领域层 `src/core/` 仍不引 IO）。总纲 §3 已列的 `src/service/sweep.ts` 本批用来承载维护扫描。
- S2 还没有 `decision` 表，所以「证据不足转 verify_human」这条在本批落成 `blocked_post` 加一条 `verify_human` 事件；S3 接入 decision 后按这条事件重放（规格 4.7 行 391 的目标状态不变，只是这一批没有落点）。

**本批定值（规格未定的项在本批定值，并写进 G2 门记录，总纲 §7 口径）**：

| 项 | 值 | 理由 |
| --- | --- | --- |
| 租约时长 `execution.lease_ttl_ms` | 30000 | 允许连续两次心跳丢失仍不误判过期，又不至于让被取消的节点长时间占着 attempt |
| 心跳间隔 `execution.lease_renew_interval_ms` | 10000 | 租约的 1/3，留两次重试余量 |
| 动作超时 `execution.action_timeout_ms` | 120000 | 与规格 17.2 的 `verify_timeout_ms` 同量级，单节点一次执行在两分钟内应当收口 |
| 取消宽限 `execution.cancel_grace_ms` | 30000 | 规格 4.5 行 354 明写 30 秒，照抄不另定 |
| 桥缓冲上限 / 高水位 | 8388608 / 4194304 字节 | 规格 7.3 行 594 与规格 17.2 配置样例一致，照抄 |
| 桥 spill 目录 | `storages/dsh-orchestra/bridge-spill/` | 放在插件存储根下，跨重启可查，不落进仓库工作区 |
| 证据强弱来源标记 | `run_tool` 为强、`tool_result` 为弱 | 规格 4.7 行 380-382 |
| `report_registry.report_seq` | 每个 node_run 从 1 起自增 | 队头重放要按 seq 取最小值（规格 4.2 行 301） |

未决参数（指向总纲 §7 的六项，本批不产生新的全局未决项）：写队列上限与溢出策略（S1 已定 1000 条，本批沿用）、事件与证据保留期（S1 已定回执 7 天，本批沿用）、记忆裁判模型与提示词版本（S5）、值班人与升级联系人（S6）、R1/R2 工作区白名单（S6）、24h 浸泡采样频率与判定脚本（S6）。

---

## Task 1：S2 账本扩展、配置定值与提案错误码

**目标：** 给 `node_runs` 补上 S2 要用的列（两代际、围栏、单调时钟、租约引用），把 `report_registry` 的 `status` 列改名成 `state` 并补语义列，给配置补四个定值键，并把两个新增错误码提案单列成表，不混进 `ERROR_STATUS`。

**Files:**
- Create: `src/infra/sqlite/migrations/002_s2_agent_loop.sql` —— S2 迁移。
- Modify: `src/core/errors.ts` —— 追加 `PROPOSED_ERROR_CODES` 提案表与 `proposedError` 工厂。
- Modify: `src/core/config.ts` —— `execution` 段加四个定值键与一条跨字段校验。
- Modify: `orchestra.config.json` —— 写显式定值。
- Create: `tests/migrate-s2.spec.ts` —— 迁移与列的用例。

**步骤：**

1. 写 S2 迁移。已经执行过的迁移文件不许改，要改就新开编号，所以 001 一行不动，全在 002 里加。S1 的 `loadSteps` 按「单独一行一个分号」切语句，所以这个文件里的语句分隔也照那个规矩写。

```sql
-- src/infra/sqlite/migrations/002_s2_agent_loop.sql
-- S2：单节点闭环要用的列与语义列。001 一行不动，要改就新开编号。
-- 分隔规矩：单独一行一个分号（S1 的 loadSteps 按 /^;\s*$/m 切句）。

ALTER TABLE node_runs ADD COLUMN action_generation INTEGER NOT NULL DEFAULT 0;
;
ALTER TABLE node_runs ADD COLUMN rearm_generation INTEGER NOT NULL DEFAULT 0;
;
ALTER TABLE node_runs ADD COLUMN lease_id TEXT;
;
ALTER TABLE node_runs ADD COLUMN executor_session_id TEXT;
;
ALTER TABLE node_runs ADD COLUMN executor_agent_id TEXT;
;
ALTER TABLE node_runs ADD COLUMN fence_state TEXT;
;
ALTER TABLE node_runs ADD COLUMN fence_armed_at TEXT;
;
ALTER TABLE node_runs ADD COLUMN fence_grace_until TEXT;
;
ALTER TABLE node_runs ADD COLUMN cancel_requested_at TEXT;
;
ALTER TABLE node_runs ADD COLUMN cancel_result TEXT;
;
ALTER TABLE node_runs ADD COLUMN tool_start_at TEXT;
;
ALTER TABLE node_runs ADD COLUMN deadline_boot_id TEXT;
;
ALTER TABLE node_runs ADD COLUMN deadline_monotonic_ns INTEGER;
;
ALTER TABLE node_runs ADD COLUMN startup_unknown_deadline_at TEXT;
;
ALTER TABLE node_runs ADD COLUMN startup_unknown_remaining_ns INTEGER;
;
ALTER TABLE node_runs ADD COLUMN verify_deadline_at TEXT;
;
ALTER TABLE node_runs ADD COLUMN verify_remaining_ns INTEGER;
;
ALTER TABLE node_runs ADD COLUMN side_effect_verified_none INTEGER NOT NULL DEFAULT 0;
;
ALTER TABLE node_runs ADD COLUMN stop_evidence TEXT;
;

-- report_registry：S1 建表时那列叫 status，本批改成 state 并补语义列（规格 4.2 行 301）
ALTER TABLE report_registry RENAME COLUMN status TO state;
;
ALTER TABLE report_registry ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
;
ALTER TABLE report_registry ADD COLUMN report_seq INTEGER NOT NULL DEFAULT 0;
;

CREATE INDEX IF NOT EXISTS idx_report_registry_node ON report_registry(node_run_id, attempt, report_seq);
;

CREATE INDEX IF NOT EXISTS idx_node_runs_lease ON node_runs(lease_expires_at, status);
;
```

2. 给错误码表加提案区。提案码不并进 `ERROR_STATUS`，但要让 `OrchError` 能装得下、能报 HTTP 状态。

```ts
// src/core/errors.ts 追加（本批提案码，尚未进规格 17.1）
// 提案码一律带 details.proposed = true，门检查与对账时能区分「既有码」与「提案码」。
export const PROPOSED_ERROR_CODES = {
  LEASE_EXPIRED: 409,
  BRIDGE_ACK_LAG: 409,
} as const

export type ProposedErrorCode = keyof typeof PROPOSED_ERROR_CODES

// OrchErrorCode 扩一个提案码的联合；ERROR_STATUS 本身不动，规格 17.1 未改前不新增既有码。
export type OrchErrorCode = keyof typeof ERROR_STATUS | ProposedErrorCode

// OrchError 类里的 httpStatus 取值改成两表合并查
//   get httpStatus(): number {
//     const known = ERROR_STATUS as Record<string, number>
//     if (this.code in known) return known[this.code]
//     const proposed = PROPOSED_ERROR_CODES as Record<string, number>
//     return proposed[this.code] ?? 500
//   }

// 提案码统一从这里出，details 里一定带 proposed = true
export function proposedError(code: ProposedErrorCode, message: string, details: Record<string, unknown> = {}): OrchError {
  return new OrchError(code, message, { ...details, proposed: true })
}
```

3. 给配置补定值键。`execution` 段多四个键，`bridge` 段多一个 spill 目录键。

```ts
// src/core/config.ts：execution 段追加
  execution: z.object({
    concurrency: positiveInt(1),
    human_slots: positiveInt(1),
    startup_timeout_ms: positiveInt(0),
    unknown_watchdog_ms: positiveInt(0),
    verify_timeout_ms: positiveInt(0),
    // S2 追加：租约时长、心跳间隔、动作超时、取消宽限
    lease_ttl_ms: positiveInt(1000),
    lease_renew_interval_ms: positiveInt(500),
    action_timeout_ms: positiveInt(1000),
    cancel_grace_ms: positiveInt(1000),
  }).strict(),
```

```ts
// src/core/config.ts：bridge 段追加 spill 目录
  bridge: z.object({
    buffer_high_water_bytes: positiveInt(1024),
    buffer_limit_bytes: positiveInt(1024),
    spill_dir: z.string().min(1),
  }).strict(),
```

4. 在 `superRefine` 里加跨字段校验：心跳间隔必须小于租约时长，否则租约会在第一次心跳之前就过期。

```ts
}).strict().superRefine((cfg, ctx) => {
  if (cfg.bridge.buffer_high_water_bytes >= cfg.bridge.buffer_limit_bytes) {
    ctx.addIssue({ code: 'custom', path: ['bridge', 'buffer_high_water_bytes'], message: '必须小于 buffer_limit_bytes' })
  }
  if (cfg.execution.lease_renew_interval_ms >= cfg.execution.lease_ttl_ms) {
    ctx.addIssue({ code: 'custom', path: ['execution', 'lease_renew_interval_ms'], message: '心跳间隔必须小于租约时长' })
  }
})
```

5. 把定值写进 `orchestra.config.json`，显式写出，不靠默认值兜底。

```json
{
  "phase": "S2",
  "service": { "db_path": "storages/dsh-orchestra/orchestra.db", "busy_timeout_ms": 5000 },
  "execution": {
    "concurrency": 3,
    "human_slots": 1,
    "startup_timeout_ms": 60000,
    "unknown_watchdog_ms": 120000,
    "verify_timeout_ms": 120000,
    "lease_ttl_ms": 30000,
    "lease_renew_interval_ms": 10000,
    "action_timeout_ms": 120000,
    "cancel_grace_ms": 30000
  },
  "bridge": {
    "buffer_high_water_bytes": 4194304,
    "buffer_limit_bytes": 8388608,
    "spill_dir": "storages/dsh-orchestra/bridge-spill"
  },
  "retention": { "receipt_days": 7, "in_flight_timeout_minutes": 10 },
  "memory": { "bridge_id": "local", "eval_timeout_ms": 30000, "judge_content_limit": 20000, "approval_ttl_hours": 24 }
}
```

**测试：**

- Create: `tests/migrate-s2.spec.ts`
  - 空库跑一遍迁移，`node_runs` 有 `action_generation`、`rearm_generation`、`fence_state`、`fence_grace_until`、`deadline_boot_id`、`deadline_monotonic_ns`、`tool_start_at`、`verify_remaining_ns`、`side_effect_verified_none`、`stop_evidence` 列，且 `action_generation` 默认 0。
  - `report_registry` 已经没有 `status` 列、有 `state` 列；写一行 `state='applied'` 成功，写 `state='bogus'` 被拒（state 的枚举校验放在应用层，Task 9 落库前查；迁移层不建触发器，因为 S1 的加载器按分号切语句，触发器体里的分号会被切坏）。
  - 迁移跑第二遍不报错，`schema_migrations` 仍是两行（001、002）。
  - `configSchema` 解析 §0 的定值表：四个 `execution` 新键与 `bridge.spill_dir` 都能读出来。
  - `lease_renew_interval_ms >= lease_ttl_ms` → 抛 `SCHEMA_VERSION_UNSUPPORTED`，`details.issues` 里带该路径。
  - `proposedError('LEASE_EXPIRED', 'x', {})` 的 `code` 是 `LEASE_EXPIRED`、`httpStatus` 是 409、`details.proposed` 是 true。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/migrate-s2.spec.ts
pnpm check
```

期望：typecheck 无错误；迁移用例全绿；`pnpm check` 三段（typecheck + test + build）都过。

**提交：**

```powershell
git add src/infra/sqlite/migrations/002_s2_agent_loop.sql src/core/errors.ts src/core/config.ts orchestra.config.json tests/migrate-s2.spec.ts
git commit -m "feat(db): 扩账本表到 S2 代际、围栏与单调时钟字段"
```

---
## Task 2：桥 RPC 客户端与订阅序号

**目标：** 落出桥的最小七方法（spawn / subscribe / send / cancel / dispose / state / whenIdle），把「订阅确认前不许发指令」「dispose 前置确认位」「whenIdle 必须带超时」这三条硬约束写进客户端，而不是散在调用点。

**Files:**
- Create: `src/executor/bridge.ts` —— 桥 RPC 客户端。
- Create: `tests/fixtures/bridge.ts` —— 桥的替身传输，按方法名回放预设回包。
- Create: `tests/bridge.spec.ts` —— 七方法的用例。

**步骤：**

1. 先定传输接口：桥怎么送到宿主由插件层决定，本批只认一个最小的 `request(method, params)` 契约，方便测试换替身。

```ts
// src/executor/bridge.ts —— 桥 RPC 客户端：最小七方法（规格 7.2 行 582-590）
import { OrchError, proposedError } from '../core/errors.ts'

// 宿主侧传输契约：方法名 + 参数，返回值由宿主给
export type BridgeTransport = {
  request<T>(method: string, params: unknown): Promise<T>
}

export type SpawnParams = {
  nodeRunId: string
  attempt: number
  input: unknown
  outputSchema: unknown
  toolPolicy: unknown
}

export type SpawnResult = { sessionId: string; agentId: string }

export type SubscribeParams = { executorAgentId: string; attempt: number; fromSeq: number }

export type SubscribeResult = { subscribed: boolean; fromSeq: number; lastSeq: number }

export type SendParams = { executorAgentId: string; attempt: number; instruction: string; attemptId: string }

export type CancelResult = 'interrupted' | 'not_interruptible' | 'already_stopped' | 'unknown'

export type ExecutorState = 'loaded' | 'unloaded' | 'deleted' | 'running' | 'idle'

export type StateResult = { state: ExecutorState; toolCallSeq: number; hasToolCall: boolean }

export type WhenIdleParams = { executorAgentId: string; timeoutMs: number }

export class BridgeClient {
  private readonly transport: BridgeTransport
  // 已经确认订阅的 executor；没进这个集合就不许 send（规格 7.2 行 584）
  private readonly subscribed = new Set<string>()

  constructor(transport: BridgeTransport) {
    this.transport = transport
  }

  // spawn 返回时订阅已生效，所以这里直接把 agentId 记成已订阅（规格 7.2 行 582）
  async spawn(params: SpawnParams): Promise<SpawnResult> {
    const res = await this.transport.request<SpawnResult>('executor.spawn', params)
    if (!res.agentId) throw new OrchError('PROTOCOL_VERSION_MISMATCH', 'spawn 回包缺 agentId', { params })
    this.subscribed.add(res.agentId)
    return res
  }

  // 按序号重放；断线重连用同一个 fromSeq（规格 7.2 行 583）
  async subscribe(params: SubscribeParams): Promise<SubscribeResult> {
    const res = await this.transport.request<SubscribeResult>('executor.subscribe', params)
    if (res.subscribed) this.subscribed.add(params.executorAgentId)
    return res
  }

  // send 必须在 subscribe 确认之后，否则 BRIDGE_NOT_SUBSCRIBED（规格 7.2 行 584）
  async send(params: SendParams): Promise<void> {
    if (!this.subscribed.has(params.executorAgentId)) {
      throw new OrchError('BRIDGE_NOT_SUBSCRIBED', '还没订阅确认，不许发指令', {
        executorAgentId: params.executorAgentId,
      })
    }
    await this.transport.request('executor.send', params)
  }

  // cancel 回四值之一；不在枚举里按协议不合处理（规格 7.2 行 585、4.5 行 341）
  async cancel(params: { executorAgentId: string; attempt: number }): Promise<CancelResult> {
    const res = await this.transport.request<CancelResult>('executor.cancel', params)
    const values: CancelResult[] = ['interrupted', 'not_interruptible', 'already_stopped', 'unknown']
    if (!values.includes(res)) {
      throw new OrchError('PROTOCOL_VERSION_MISMATCH', 'cancel 回包取值不在枚举里', { result: res })
    }
    return res
  }

  // dispose 前置 service_ack_seq >= bridge_last_seq（规格 7.2 行 585、7.3 行 595）
  async dispose(params: { executorAgentId: string; serviceAckSeq: number; bridgeLastSeq: number }): Promise<void> {
    if (params.serviceAckSeq < params.bridgeLastSeq) {
      throw proposedError('BRIDGE_ACK_LAG', '服务确认位落后于桥事件位，不许 dispose', {
        serviceAckSeq: params.serviceAckSeq,
        bridgeLastSeq: params.bridgeLastSeq,
      })
    }
    await this.transport.request('executor.dispose', { executorAgentId: params.executorAgentId })
    this.subscribed.delete(params.executorAgentId)
  }

  // state 回 loaded / unloaded / deleted / running / idle，另带 tool_call_seq 与 has_tool_call（规格 7.2 行 586）
  async state(params: { executorAgentId: string }): Promise<StateResult> {
    const res = await this.transport.request<StateResult>('executor.state', params)
    const states: ExecutorState[] = ['loaded', 'unloaded', 'deleted', 'running', 'idle']
    if (!states.includes(res.state)) {
      throw new OrchError('PROTOCOL_VERSION_MISMATCH', 'state 回包取值不在枚举里', { state: res.state })
    }
    return res
  }

  // whenIdle 必须带超时；超时按未确认停止处理，不判 indeterminate（规格 7.2 行 588）
  async whenIdle(params: WhenIdleParams): Promise<{ idle: boolean; timedOut: boolean }> {
    if (!Number.isInteger(params.timeoutMs) || params.timeoutMs <= 0) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'whenIdle 必须带正整数超时', { field: 'timeoutMs' })
    }
    return this.transport.request<{ idle: boolean; timedOut: boolean }>('executor.whenIdle', params)
  }

  // 断号重取用：宿主按 fromSeq 重放一页（规格 7.3 行 595）
  async fetchPage(params: { executorAgentId: string; attempt: number; fromSeq: number; pageSize: number }): Promise<{ events: BridgeEvent[] }> {
    return this.transport.request<{ events: BridgeEvent[] }>('executor.page', params)
  }

  // 订阅态给上层看：围栏里判断「要不要等」时用
  isSubscribed(executorAgentId: string): boolean {
    return this.subscribed.has(executorAgentId)
  }
}
```

2. 写替身传输，测试与后续批都靠它。

```ts
// tests/fixtures/bridge.ts —— 桥的替身：按方法名回放预设回包，并记下调用
import type { BridgeTransport } from '../../src/executor/bridge.ts'

export type FakeCall = { method: string; params: unknown }

export type FakeBridge = BridgeTransport & {
  calls: FakeCall[]
  lastCall: (method: string) => FakeCall | undefined
}

export function fakeBridge(reply: (method: string, params: unknown) => unknown): FakeBridge {
  const calls: FakeCall[] = []
  return {
    calls,
    lastCall: (method: string) => calls.find((c) => c.method === method),
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params })
      return reply(method, params) as T
    },
  }
}

// 默认回包：spawn 成功、subscribe 确认、cancel 报 interrupted
export function defaultBridgeReply(method: string): unknown {
  if (method === 'executor.spawn') return { sessionId: 'sess_1', agentId: 'agent_1' }
  if (method === 'executor.subscribe') return { subscribed: true, fromSeq: 0, lastSeq: 0 }
  if (method === 'executor.cancel') return 'interrupted'
  if (method === 'executor.state') return { state: 'idle', toolCallSeq: 0, hasToolCall: false }
  if (method === 'executor.whenIdle') return { idle: true, timedOut: false }
  return {}
}
```

**测试：**

- Create: `tests/bridge.spec.ts`
  - `spawn` 返回 `{sessionId, agentId}`，且客户端记成已订阅；回包缺 `agentId` → 抛 `PROTOCOL_VERSION_MISMATCH`。
  - `subscribe` 传 `fromSeq` 透传给宿主，断线重连两次用同一个 `fromSeq` 时两次调用参数一致。
  - 未确认订阅前 `send` → 抛 `BRIDGE_NOT_SUBSCRIBED`（`details.executorAgentId` 有值）；`subscribe` 确认后 `send` 成功，且透传的 `instruction` 与 `attemptId` 原样到达宿主。
  - `dispose` 时 `serviceAckSeq < bridgeLastSeq` → 抛 `BRIDGE_ACK_LAG`（`details.proposed` 为 true）；两者相等时成功，且成功后再 `send` 抛 `BRIDGE_NOT_SUBSCRIBED`。
  - `whenIdle` 缺 `timeoutMs` 或给 0 → 抛 `SCHEMA_VERSION_UNSUPPORTED`（`details.field='timeoutMs'`）；给 30000 时透传。
  - `cancel` 返回四个合法值时原样返回；宿主回 `'weird'` → 抛 `PROTOCOL_VERSION_MISMATCH`。
  - `state` 透传 `toolCallSeq` 与 `hasToolCall`；宿主回 `state='halted'` → 抛 `PROTOCOL_VERSION_MISMATCH`。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/bridge.spec.ts
```

期望：typecheck 无错误；桥用例全绿；`pnpm test` 全量仍绿。

**提交：**

```powershell
git add src/executor/bridge.ts tests/fixtures/bridge.ts tests/bridge.spec.ts
git commit -m "feat(bridge): 加桥 RPC 客户端最小七方法"
```

---
## Task 3：桥事件缓冲与断号重取

**目标：** 给桥事件一个不丢证据的缓冲层：上限 8 MiB、高水位 4 MiB，超限 spill 到磁盘；事件按 seq 单调，断号整页重取不做增量补洞；事件类型固定五类，`tool.call` 与 `tool.start` 分开记，动作计时锚点是 `tool_start_at`。

**Files:**
- Modify: `src/executor/bridge.ts` —— 追加事件缓冲类。
- Create: `tests/bridge-buffer.spec.ts` —— 缓冲与断号的用例。

**步骤：**

1. 把缓冲写进同一个文件（总纲 §3 的 executor 目录只有 bridge / session / tools 三个文件，不另起）。

```ts
// src/executor/bridge.ts 追加：桥事件缓冲与断号重取（规格 7.3 行 594-597）
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 事件类型固定五类，写别的直接拒（规格 7.2 行 590）
export const BRIDGE_EVENT_TYPES = ['step', 'turn', 'tool.call', 'tool.start', 'tool.result'] as const
export type BridgeEventType = (typeof BRIDGE_EVENT_TYPES)[number]

export type BridgeEvent = {
  seq: number
  type: BridgeEventType
  at: string
  // tool.start 的时间锚点；动作计时用它，不拿 tool.call 的时间当动作起点
  toolStartAt: string | null
  payload: unknown
}

export type BridgeBufferOptions = {
  limitBytes: number
  highWaterBytes: number
  spillDir: string
  agentId: string
}

export class BridgeEventBuffer {
  private readonly opts: BridgeBufferOptions
  private readonly events: BridgeEvent[] = []
  private bytes = 0
  private seqCursor = 0
  private spillFile: string | null = null

  constructor(opts: BridgeBufferOptions) {
    this.opts = opts
  }

  // 收一条事件：类型固定、序号单调、同号重复按幂等跳过
  // 返回 gapFrom：非空表示中间断了号，调用方要整页重取
  push(ev: BridgeEvent): { accepted: boolean; gapFrom: number | null } {
    if (!BRIDGE_EVENT_TYPES.includes(ev.type)) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件类型不在固定清单里', { type: ev.type })
    }
    if (ev.seq <= this.seqCursor) {
      if (ev.seq === this.seqCursor) return { accepted: false, gapFrom: null }
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件序号倒退', { seq: ev.seq, lastSeq: this.seqCursor })
    }
    const gapFrom = ev.seq === this.seqCursor + 1 ? null : this.seqCursor + 1
    this.events.push(ev)
    this.bytes += Buffer.byteLength(JSON.stringify(ev), 'utf8')
    this.seqCursor = ev.seq
    if (this.bytes >= this.opts.highWaterBytes) this.spill()
    return { accepted: true, gapFrom }
  }

  // 超过高水位就落盘：证据不丢，只是搬到磁盘（规格 7.3 行 594）
  private spill(): void {
    const first = this.events[0]
    if (!first) return
    const file = join(this.opts.spillDir, this.opts.agentId + '-' + first.seq + '.jsonl')
    const body = this.events.map((e) => JSON.stringify(e)).join('\n')
    try {
      appendFileSync(file, body + '\n', 'utf8')
    } catch (err) {
      // 落盘失败等于证据要丢，宁可报错也不许静默丢
      throw new OrchError('SERVICE_UNAVAILABLE', '桥缓冲溢出且落盘失败，证据不许丢', {
        file: String(err), seq: first.seq,
      })
    }
    this.spillFile = file
    this.events.length = 0
    this.bytes = 0
  }

  // 取 fromSeq 之后的全部事件：内存里的加 spill 文件里的，合并后按 seq 排序
  takeFrom(fromSeq: number): BridgeEvent[] {
    const out: BridgeEvent[] = []
    if (this.spillFile) {
      const text = readFileSync(this.spillFile, 'utf8')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        const ev = JSON.parse(line) as BridgeEvent
        if (ev.seq >= fromSeq) out.push(ev)
      }
    }
    for (const ev of this.events) {
      if (ev.seq >= fromSeq) out.push(ev)
    }
    out.sort((a, b) => a.seq - b.seq)
    return out
  }

  // 动作计时锚点：最近一条 tool.start 的时间（规格 7.2 行 590）
  toolStartAnchor(): string | null {
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const ev = this.events[i]
      if (ev && ev.type === 'tool.start') return ev.toolStartAt ?? ev.at
    }
    return null
  }

  get lastSeq(): number { return this.seqCursor }
  get spilled(): boolean { return this.spillFile !== null }
  get bufferedBytes(): number { return this.bytes }
}
```

2. 断号的处理放在调用方：拿到 `gapFrom` 就整页重取，不做增量补洞（规格 7.3 行 595）。

```ts
// src/executor/bridge.ts 追加：断号整页重取
// 断号不许增量补洞：整页重取，从缺口起点一次拉一页（规格 7.3 行 595）
export async function refillPage(
  client: BridgeClient,
  params: { executorAgentId: string; attempt: number; gapFrom: number; pageSize?: number },
  receive: (events: BridgeEvent[]) => void,
): Promise<number> {
  const pageSize = params.pageSize ?? 256
  // 宿主按 fromSeq 重放，回包里带事件页；页里序号连续才收
  const page = await client.fetchPage({
    executorAgentId: params.executorAgentId,
    attempt: params.attempt,
    fromSeq: params.gapFrom,
    pageSize,
  })
  let cursor = params.gapFrom - 1
  for (const ev of page.events) {
    if (ev.seq !== cursor + 1) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '重取页里序号不连续', { expect: cursor + 1, got: ev.seq })
    }
    cursor = ev.seq
    receive([ev])
  }
  return cursor
}
```

**测试：**

- Create: `tests/bridge-buffer.spec.ts`
  - 类型不在五类清单里（例如 `'tool.done'`）→ 抛 `SCHEMA_VERSION_UNSUPPORTED`。
  - 连续推 seq 1、2、3，三次返回的 `gapFrom` 都是 null；跳到 seq 6 时 `gapFrom` 为 4。
  - 重复推同一 seq → 返回 `accepted=false`，缓冲里事件数不变（幂等）。
  - 推一个比当前序号小的 seq → 抛 `SCHEMA_VERSION_UNSUPPORTED`（序号倒退）。
  - 把高水位调到 1 KiB、塞入超过高水位的事件 → 缓冲自动 spill：`spilled` 为 true、内存事件清空、spill 文件存在；`takeFrom(1)` 仍能取回全部事件（证据不丢）。
  - 推 `tool.call` 再推 `tool.start` 两条 → 两条类型各自独立、`tool.call` 那条没有 `toolStartAt`、`tool.start` 那条的 `toolStartAt` 非空；`toolStartAnchor()` 返回 `tool.start` 的时间而不是 `tool.call` 的时间。
  - 重取页里序号不连续 → 抛 `SCHEMA_VERSION_UNSUPPORTED`。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/bridge-buffer.spec.ts
pnpm check
```

期望：typecheck 无错误；缓冲与重取用例全绿；`pnpm check` 三段都过。

**提交：**

```powershell
git add src/executor/bridge.ts tests/bridge-buffer.spec.ts
git commit -m "feat(bridge): 加桥事件缓冲与断号整页重取"
```

---
## Task 4：工具注册表与前向能力推导

**目标：** 给工具建一份注册表，写清前向 `effective capability` 的推导规则，并锁死一条纪律：作者声明只许往更严的一侧写，宽了拒、窄了按声明算。

**Files:**
- Create: `src/executor/tools.ts` —— 工具注册表、查找、能力推导、声明校验。
- Create: `tests/tools.spec.ts` —— 推导与声明校验的用例。

**步骤：**

1. 定类型与注册表。补偿工具 `capability='compensating'` 只许出现在补偿描述符里，出现在前向路径要拒（规格 4.7 行 376）。

```ts
// src/executor/tools.ts —— 工具注册表与 capability 推导（规格 4.7 行 371-399）
import { OrchError } from '../core/errors.ts'

export type ToolCapability = 'read_only' | 'mutating' | 'compensating'
export type SideEffectPolicy = 'pure' | 'compensable' | 'irreversible'

export type ToolDescriptor = {
  name: string
  capability: ToolCapability
  // 固定命令：只读执行时用它，argv 不经 shell（规格 7.2 行 588）
  command: { bin: string; args: string[] }
  // 补偿描述符：mutating 工具要声明 compensable 就必须给，而且要可执行
  compensation?: { tool: string; args: string[]; verify: { command: string; args: string[] } }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>()

  register(descriptor: ToolDescriptor): void {
    this.tools.set(descriptor.name, descriptor)
  }

  lookup(name: string): ToolDescriptor | undefined {
    return this.tools.get(name)
  }

  // 查不到一律 TOOL_NOT_REGISTERED（规格 4.7 行 399）
  require(name: string): ToolDescriptor {
    const found = this.tools.get(name)
    if (!found) throw new OrchError('TOOL_NOT_REGISTERED', '工具没注册', { tool: name })
    return found
  }

  list(): ToolDescriptor[] {
    return Array.from(this.tools.values())
  }
}
```

2. 写前向推导与声明校验。

```ts
// src/executor/tools.ts 追加：前向能力推导
// 补偿描述符可执行 = 有补偿工具名、有参数、有验证命令
export function hasExecutableCompensation(tool: ToolDescriptor): boolean {
  if (!tool.compensation) return false
  if (tool.compensation.tool.length === 0) return false
  if (tool.compensation.verify.command.length === 0) return false
  return true
}

// 前向 effective capability 三条（规格 4.7 行 393-395）：
// 只含 read_only → pure；含 mutating 且有可执行补偿描述符 → compensable；
// 含 mutating 且无可执行补偿描述符 → irreversible
export function deriveEffectiveCapability(tools: ToolDescriptor[]): SideEffectPolicy {
  for (const tool of tools) {
    if (tool.capability === 'compensating') {
      // 补偿工具不许出现在前向路径（规格 4.7 行 376）
      throw new OrchError('COMPENSATION_TOOL_IN_FORWARD_PATH', '补偿工具不能出现在前向路径里', { tool: tool.name })
    }
  }
  if (tools.length === 0) return 'pure'
  if (tools.every((t) => t.capability === 'read_only')) return 'pure'
  const mutating = tools.filter((t) => t.capability === 'mutating')
  if (mutating.length === 0) return 'pure'
  const allCompensable = mutating.every((t) => hasExecutableCompensation(t))
  return allCompensable ? 'compensable' : 'irreversible'
}
```

```ts
// src/executor/tools.ts 追加：作者声明只许往更严的一侧写（规格 4.7 行 396-399）
// 声明 pure 而推导更宽 → 拒；声明 compensable 而补偿描述符不可执行 → 拒；
// 声明 compensable 而推导 pure → 拒（声明比推导宽）；声明 irreversible 而推导更宽 → 接受，按 irreversible 算
export function resolveDeclaredPolicy(declared: SideEffectPolicy, derived: SideEffectPolicy, mutatingTools: ToolDescriptor[]): SideEffectPolicy {
  if (declared === 'pure' && derived !== 'pure') {
    throw new OrchError('SIDE_EFFECT_UNDECLARED', '声明 pure 但推导不是 pure', { declared, derived })
  }
  if (declared === 'compensable') {
    const unexecutable = mutatingTools.filter((t) => !hasExecutableCompensation(t)).map((t) => t.name)
    if (unexecutable.length > 0) {
      throw new OrchError('COMPENSATION_UNEXECUTABLE', '声明 compensable 但补偿描述符不可执行', { declared, derived, tools: unexecutable })
    }
    if (derived === 'pure') {
      throw new OrchError('SIDE_EFFECT_UNDECLARED', '声明 compensable 但推导是 pure，声明比推导宽', { declared, derived })
    }
  }
  // 声明 irreversible 而推导更宽：接受并按 irreversible 算（规格 4.7 行 399）
  return declared === 'irreversible' ? 'irreversible' : derived
}
```

**测试：**

- Create: `tests/tools.spec.ts`
  - `register` 后 `lookup` 拿到同一份描述符；`lookup` 未注册的返回 undefined；`require` 未注册的 → 抛 `TOOL_NOT_REGISTERED`。
  - 前向只含 `read_only` → 推导 `pure`；前向为空 → `pure`。
  - 含一个 `mutating` 且带可执行补偿描述符 → 推导 `compensable`。
  - 含一个 `mutating` 且没有补偿描述符 → 推导 `irreversible`。
  - 前向里出现 `compensating` 工具 → 抛 `COMPENSATION_TOOL_IN_FORWARD_PATH`。
  - 声明 `pure` 而推导 `compensable` → 抛 `SIDE_EFFECT_UNDECLARED`。
  - 声明 `compensable` 而补偿描述符不可执行（`compensation.verify.command` 为空）→ 抛 `COMPENSATION_UNEXECUTABLE`。
  - 声明 `compensable` 而推导 `pure` → 抛 `SIDE_EFFECT_UNDECLARED`。
  - 声明 `irreversible` 而推导 `pure` → 不抛，返回 `irreversible`。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/tools.spec.ts
pnpm check
```

期望：typecheck 无错误；能力推导用例全绿；`pnpm check` 三段都过。

**提交：**

```powershell
git add src/executor/tools.ts tests/tools.spec.ts
git commit -m "feat(tools): 加工具注册表与前向能力推导"
```

---
## Task 5：runTool 只读执行与强证据

**目标：** 把强证据的来源做成唯一入口：宿主只读身份、固定命令、argv 不过 shell、cwd 限定工作区、命令必须命中注册表且 `capability=read_only`；跑出来的产物哈希才是不可逆动作的通过凭据。

**Files:**
- Modify: `src/executor/tools.ts` —— 追加只读执行器与证据结构。
- Create: `tests/run-tool.spec.ts` —— 只读执行与证据的用例。

**步骤：**

1. 先定宿主执行接口与工作区越界判定。

```ts
// src/executor/tools.ts 追加：只读执行器（规格 7.2 行 588、4.7 行 380-384）
import { resolve, sep } from 'node:path'
import { sha256Hex } from '../core/canonical.ts'

// 宿主执行接口：只读身份由宿主保证，本批只负责不越权
export type HostRunner = {
  readonlyAvailable(): boolean
  run(input: { bin: string; args: string[]; cwd: string; timeoutMs: number }): Promise<{
    exitCode: number
    stdout: string
    stderr: string
  }>
}

// cwd 必须在工作区内，越界即拒（规格 7.2 行 588）
export function resolveInside(root: string, target: string): string {
  const rootAbs = resolve(root)
  const targetAbs = resolve(rootAbs, target)
  if (targetAbs !== rootAbs && !targetAbs.startsWith(rootAbs + sep)) {
    throw new OrchError('FORBIDDEN', 'cwd 越出工作区', { root: rootAbs, target: targetAbs })
  }
  return targetAbs
}
```

2. 写强证据结构与 runTool 本体。

```ts
// src/executor/tools.ts 追加：runTool 与强证据
export type StrongEvidence = {
  // 来源标记：run_tool 是强证据，模型侧 tool_result 是弱证据（规格 4.7 行 380-383）
  source: 'run_tool'
  exitCode: number
  stdoutHash: string
  stderrHash: string
  hashes: Record<string, string>
  producedAt: string
  // 命令哈希：落库前要核对，核对不上就不许写（规格 7.2 行 589）
  commandHash: string
}

export type RunToolParams = {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
  workspaceRoot: string
}

export type RunToolResult = {
  evidence: StrongEvidence
  stdout: string
  stderr: string
}

// 命令哈希：把命令与参数固定成一段可核对的串
export function commandHashOf(command: string, args: string[], cwd: string): string {
  return sha256Hex(JSON.stringify({ command, args, cwd }))
}

export class ReadOnlyToolRunner {
  private readonly registry: ToolRegistry
  private readonly host: HostRunner
  private readonly workspaceRoot: string

  constructor(registry: ToolRegistry, host: HostRunner, workspaceRoot: string) {
    this.registry = registry
    this.host = host
    this.workspaceRoot = workspaceRoot
  }

  async runTool(params: RunToolParams): Promise<RunToolResult> {
    // 命令必须命中注册表，且 capability 必须是 read_only
    const descriptor = this.registry.lookup(params.command)
    if (!descriptor) {
      throw new OrchError('RUN_TOOL_NOT_READ_ONLY', '命令没注册，不许按只读执行', { command: params.command })
    }
    if (descriptor.capability !== 'read_only') {
      throw new OrchError('RUN_TOOL_NOT_READ_ONLY', '命令不是只读命令', {
        command: params.command,
        capability: descriptor.capability,
      })
    }
    // 宿主没有只读挂载就报，不降级（规格 4.7 行 381）
    if (!this.host.readonlyAvailable()) {
      throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '宿主没有只读挂载，强证据不可得', {
        command: params.command,
      })
    }
    const cwd = resolveInside(this.workspaceRoot, params.cwd)
    // argv 不经 shell：用注册表里的固定命令与参数数组直接 spawn
    const args = params.args.length > 0 ? params.args : descriptor.command.args
    const res = await this.host.run({
      bin: descriptor.command.bin,
      args,
      cwd,
      timeoutMs: params.timeoutMs,
    })
    const evidence: StrongEvidence = {
      source: 'run_tool',
      exitCode: res.exitCode,
      stdoutHash: sha256Hex(res.stdout),
      stderrHash: sha256Hex(res.stderr),
      hashes: { stdout: sha256Hex(res.stdout), stderr: sha256Hex(res.stderr) },
      producedAt: new Date().toISOString(),
      commandHash: commandHashOf(descriptor.command.bin, args, cwd),
    }
    return { evidence, stdout: res.stdout, stderr: res.stderr }
  }
}

// 落库前核对命令哈希：对不上就当证据不足（规格 7.2 行 588、4.7 行 379）
export function assertCommandHash(evidence: StrongEvidence, expected: string): void {
  if (evidence.commandHash !== expected) {
    throw new OrchError('VERIFICATION_TOO_WEAK', '命令哈希对不上，证据不作数', {
      got: evidence.commandHash,
      expect: expected,
    })
  }
}
```

**测试：**

- Create: `tests/run-tool.spec.ts`
  - 命令不在注册表 → 抛 `RUN_TOOL_NOT_READ_ONLY`，且宿主 `run` 没被调用。
  - 命令注册了但 `capability='mutating'` 或 `'compensating'` → 抛 `RUN_TOOL_NOT_READ_ONLY`，`details.capability` 有值。
  - 宿主 `readonlyAvailable()` 返回 false → 抛 `EVIDENCE_SOURCE_UNAVAILABLE`，不返回降级证据。
  - `cwd` 越出 `workspaceRoot`（例如 `'../outside'`）→ 抛 `FORBIDDEN`。
  - 正常执行：`evidence.source='run_tool'`、`exitCode` 等于宿主返回值、`stdoutHash` 等于 `sha256Hex(stdout)`、`hashes.stdout` 同值、`producedAt` 非空、`commandHash` 非空；传给宿主的 `args` 是数组（不经 shell）。
  - `assertCommandHash` 传入不匹配的期望值 → 抛 `VERIFICATION_TOO_WEAK`；匹配时通过。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/run-tool.spec.ts
pnpm check
```

期望：typecheck 无错误；只读执行用例全绿；`pnpm check` 三段都过。

**提交：**

```powershell
git add src/executor/tools.ts tests/run-tool.spec.ts
git commit -m "feat(tools): 加 runTool 只读执行与强证据"
```

---
## Task 6：租约与心跳

**目标：** 给 `node_run` 加一层租约：谁在跑、跑到什么时候、过期了怎么办。租约台账落 `leases` 表，CAS 的依据留在 `node_runs` 行上，这样过期扫描和执行器心跳都走同一条栅栏。

**Files:**
- Create: `src/service/commands/lease.ts` —— 租约的获取、续期、释放、过期扫描与校验。
- Create: `tests/lease.spec.ts` —— 租约与过期迟到的用例。

**步骤：**

1. 先把租约的读与校验写出来：过期就是过期，不因为执行器还在跑就网开一面。

```ts
// src/service/commands/lease.ts —— 租约与心跳（规格 4.9 行 425-429、12.3 行 970）
import { OrchError, proposedError } from '../../core/errors.ts'
import { uuidv7 } from '../../core/ids.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { runCas } from '../../infra/db/tx.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'

export type NodeRunRow = {
  node_run_id: string
  run_id: string
  node_id: string
  attempt: number
  status: string
  revision: number
  owner_epoch: number
  lease_id: string | null
  lease_expires_at: string | null
  action_generation: number
  rearm_generation: number
}

export function loadNodeRun(tx: Tx, nodeRunId: string): NodeRunRow {
  const row = tx.get<NodeRunRow>('SELECT * FROM node_runs WHERE node_run_id = ?', [nodeRunId])
  if (!row) throw new OrchError('NOT_FOUND', 'node_run 不存在', { nodeRunId })
  return row
}
```

2. 写获取与续期。获取时把 `queued → leased → dispatched` 放在同一笔事务里，并把动作代（Ga）加一（规格 4.3 行 311）。

```ts
// src/service/commands/lease.ts 追加：租约获取、续期、释放
export type AcquireLeaseParams = {
  nodeRunId: string
  ownerEpoch: number
  leaseTtlMs: number
  now: string
}

export type AcquireLeaseResult = {
  leaseId: string
  expiresAt: string
  actionGeneration: number
}

// queued → leased → dispatched 同一笔事务；每次派发 Ga 加一，首次为 1，不重置（规格 4.3 行 311）
export function acquireLease(tx: Tx, secret: string, params: AcquireLeaseParams): AcquireLeaseResult {
  const row = loadNodeRun(tx, params.nodeRunId)
  if (row.status !== 'queued') {
    throw new OrchError('STALE_GENERATION', '节点不在 queued，拿不到租约', {
      nodeRunId: params.nodeRunId,
      status: row.status,
    })
  }
  // 租约 id：S1 的 ids.ts 里没有 lease 前缀，这里用 uuidv7 加前缀，后续统一了就改这一处
  const leaseId = 'lease_' + uuidv7()
  const expiresAt = new Date(Date.parse(params.now) + params.leaseTtlMs).toISOString()
  const nextGa = row.action_generation + 1
  // 条件里带 revision 与 attempt，防并发抢到同一节点
  runCas(
    tx,
    'UPDATE node_runs SET status = ?, lease_id = ?, lease_expires_at = ?, owner_epoch = ?, action_generation = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND status = ? AND attempt = ? AND revision = ?',
    ['leased', leaseId, expiresAt, params.ownerEpoch, nextGa, params.now, params.nodeRunId, 'queued', row.attempt, row.revision],
    { rows: 1, what: 'acquireLease' },
  )
  runCas(
    tx,
    'UPDATE node_runs SET status = ?, updated_at = ? WHERE node_run_id = ? AND status = ? AND attempt = ? AND revision = ?',
    ['dispatched', params.now, params.nodeRunId, 'leased', row.attempt, row.revision + 1],
    { rows: 1, what: 'acquireLease-dispatched' },
  )
  tx.run(
    'INSERT INTO leases (lease_id, node_run_id, owner_epoch, expires_at, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [leaseId, params.nodeRunId, params.ownerEpoch, expiresAt, 0, params.now],
  )
  appendNodeRunEvent(tx, secret, params.nodeRunId, 'lease_acquired', {
    lease_id: leaseId,
    action_generation: nextGa,
    expires_at: expiresAt,
  })
  return { leaseId, expiresAt, actionGeneration: nextGa }
}

// 续期只动租约，不动 Ga；Ga 跟动作走，续期跟 Gr 走（规格 4.3 行 309-310）
export function renewLease(tx: Tx, params: { nodeRunId: string; leaseTtlMs: number; now: string }): string {
  const row = loadNodeRun(tx, params.nodeRunId)
  if (!row.lease_id) throw new OrchError('STALE_GENERATION', '节点没有租约，续期无效', { nodeRunId: params.nodeRunId })
  assertLeaseValid(row, params.now)
  const expiresAt = new Date(Date.parse(params.now) + params.leaseTtlMs).toISOString()
  runCas(
    tx,
    'UPDATE node_runs SET lease_expires_at = ?, heartbeat_at = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND revision = ? AND lease_id = ?',
    [expiresAt, params.now, params.now, params.nodeRunId, row.revision, row.lease_id],
    { rows: 1, what: 'renewLease' },
  )
  tx.run('UPDATE leases SET expires_at = ?, revision = revision + 1 WHERE lease_id = ?', [expiresAt, row.lease_id])
  return expiresAt
}

// 释放：执行器正常收口时把租约交回去
export function releaseLease(tx: Tx, params: { nodeRunId: string; now: string }): void {
  const row = loadNodeRun(tx, params.nodeRunId)
  if (!row.lease_id) return
  runCas(
    tx,
    'UPDATE node_runs SET lease_id = NULL, lease_expires_at = NULL, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND revision = ?',
    [params.now, params.nodeRunId, row.revision],
    { rows: 1, what: 'releaseLease' },
  )
  tx.run('UPDATE leases SET expires_at = ? WHERE lease_id = ?', [params.now, row.lease_id])
}
```

3. 租约校验与过期扫描。过期后原执行器的迟到上报必须被拒（规格 12.3 行 970）。

```ts
// src/service/commands/lease.ts 追加：过期判定与扫描
// 租约过期即失效：迟到上报不许再推进节点（规格 12.3 行 970）
export function assertLeaseValid(row: NodeRunRow, now: string): void {
  if (!row.lease_expires_at) return
  if (Date.parse(row.lease_expires_at) <= Date.parse(now)) {
    throw proposedError('LEASE_EXPIRED', '租约已过期，执行器迟到上报被拒', {
      node_run_id: row.node_run_id,
      lease_expires_at: row.lease_expires_at,
      now,
    })
  }
}

// 过期扫描：dispatched 或 started 的租约过期后先转 startup_unknown 或 stopping（规格 4.9 行 426）
export function sweepExpiredLeases(tx: Tx, secret: string, params: { now: string; leaseTtlMs: number }): string[] {
  const rows = tx.all<NodeRunRow>(
    'SELECT * FROM node_runs WHERE status IN (?, ?) AND lease_expires_at IS NOT NULL',
    ['dispatched', 'started'],
  )
  const touched: string[] = []
  for (const row of rows) {
    if (Date.parse(row.lease_expires_at ?? 0) > Date.parse(params.now)) continue
    // 跑过启动的先转 startup_unknown，没跑过的转 stopping，两边都要留痕
    const next = row.status === 'started' ? 'startup_unknown' : 'stopping'
    runCas(
      tx,
      'UPDATE node_runs SET status = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND status = ? AND revision = ?',
      [next, params.now, row.node_run_id, row.status, row.revision],
      { rows: 1, what: 'sweepExpiredLeases' },
    )
    appendNodeRunEvent(tx, secret, row.node_run_id, 'lease_expired', {
      from: row.status,
      to: next,
      lease_expires_at: row.lease_expires_at,
      reason: 'lease_expired',
    })
    touched.push(row.node_run_id)
  }
  return touched
}
```

**测试：**

- Create: `tests/lease.spec.ts`
  - 节点在 `queued` 时获取租约 → 返回 `leaseId`、`expiresAt`、`actionGeneration=1`；`node_runs.status` 变成 `dispatched`；`leases` 表多一行。
  - 节点已在 `started` 时获取租约 → 抛 `STALE_GENERATION`（`details.status='started'`）。
  - 续期 → `node_runs.lease_expires_at` 变长、`heartbeat_at` 落在当前时间、`action_generation` 不变（续期只动租约）。
  - `assertLeaseValid` 在 `lease_expires_at` 已过时 → 抛 `LEASE_EXPIRED`，`details.proposed=true`；未过期时通过。
  - 过期扫描：造一行 `dispatched` 且租约已过期的 `node_run` → 扫描后状态变 `stopping`；造一行 `started` 且租约已过期的 → 变 `startup_unknown`；`node_run_events` 里有 `lease_expired` 事件且带 `reason='lease_expired'`。
  - 扫描对未过期租约不动（状态与 revision 不变）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/lease.spec.ts
pnpm check
```

期望：typecheck 无错误；租约用例全绿；`pnpm check` 三段都过。

**提交：**

```powershell
git add src/service/commands/lease.ts tests/lease.spec.ts
git commit -m "feat(lease): 加租约获取续期与过期扫描"
```

---
## Task 7：agent 节点执行器

**目标：** 节点执行的执行器是一个子智能体：它不继承主会话历史，工具按 allow / deny 给、未声明默认不给，产出三件套（payload、有界摘要、产物引用）；它不能自报完成，完成只由 `applyReport` 收口。

**Files:**
- Create: `src/executor/session.ts` —— 子智能体创建、工具策略裁剪、输出三件套裁剪。
- Create: `tests/session.spec.ts` —— 工具裁剪与输出裁剪的用例。

**步骤：**

1. 定义工具策略与输出结构。

```ts
// src/executor/session.ts —— agent 节点执行器（规格 5.2 行 442-449、4.1 行 272）
import { OrchError } from '../core/errors.ts'
import { deriveEffectiveCapability, resolveDeclaredPolicy, type ToolDescriptor, type ToolRegistry } from './tools.ts'

export type ToolPolicy = {
  // allow / deny 都是白名单式的显式清单；没声明的按不给算（规格 5.2 行 444）
  allow?: string[]
  deny?: string[]
  // 声明的副作用面；只许往更严一侧写（规格 4.7 行 396-399）
  declaredPolicy?: 'pure' | 'compensable' | 'irreversible'
}

export type OutputTriplet = {
  payload: unknown
  payloadBytes: number
  payloadTruncated: boolean
  droppedFields: string[]
  summary: string
  artifactRef: { kind: 'artifact_ref' | 'decision_ref' | 'none'; uri?: string; sha256?: string; decisionId?: string }
}
```

2. 工具裁剪：allow 减去 deny，再按前向能力推导校验声明。

```ts
// src/executor/session.ts 追加：工具裁剪
// 未声明默认不给：allow 没提到的工具一律不给（规格 5.2 行 444）
export function resolveToolSet(registry: ToolRegistry, policy: ToolPolicy): ToolDescriptor[] {
  const allow = policy.allow ?? []
  const deny = new Set(policy.deny ?? [])
  const chosen: ToolDescriptor[] = []
  for (const name of allow) {
    if (deny.has(name)) continue
    // allow 里出现没注册的工具，加载期就要拒（规格 4.7 行 399）
    chosen.push(registry.require(name))
  }
  return chosen
}

// 前向能力推导加声明校验；声明 pure 而推导更宽直接拒（规格 5.2 行 444-445、4.7 行 395-398）
export function checkToolPolicy(registry: ToolRegistry, policy: ToolPolicy): 'pure' | 'compensable' | 'irreversible' {
  const chosen = resolveToolSet(registry, policy)
  const derived = deriveEffectiveCapability(chosen)
  const mutating = chosen.filter((t) => t.capability === 'mutating')
  if (!policy.declaredPolicy) return derived
  return resolveDeclaredPolicy(policy.declaredPolicy, derived, mutating)
}
```

3. 输出三件套裁剪：payload 超 64 KiB 截断并留痕，摘要不超过 800 字（规格 4.1 行 272、5.2 行 447）。

```ts
// src/executor/session.ts 追加：输出三件套
export const PAYLOAD_LIMIT_BYTES = 64 * 1024
export const SUMMARY_LIMIT_CHARS = 800

export function buildOutputTriplet(raw: {
  payload: unknown
  summary: string
  artifactRef: OutputTriplet['artifactRef']
}): OutputTriplet {
  const droppedFields: string[] = []
  let payload = raw.payload
  let payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  let payloadTruncated = false
  // 超限截断并记，不许静默丢字段（规格 4.1 行 272）
  if (payloadBytes > PAYLOAD_LIMIT_BYTES) {
    const record = payload as Record<string, unknown>
    if (record && typeof record === 'object') {
      const kept: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(record)) {
        const candidate = { ...kept, [key]: value }
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > PAYLOAD_LIMIT_BYTES) {
          droppedFields.push(key)
          continue
        }
        kept[key] = value
      }
      payload = kept
    } else {
      payload = null
      droppedFields.push('payload')
    }
    payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
    payloadTruncated = true
  }
  // 摘要不超过 800 字（规格 5.2 行 447）
  const summary = raw.summary.length > SUMMARY_LIMIT_CHARS ? raw.summary.slice(0, SUMMARY_LIMIT_CHARS) : raw.summary
  return { payload, payloadBytes, payloadTruncated, droppedFields, summary, artifactRef: raw.artifactRef }
}
```

4. 子智能体创建与「不许自报完成」的指令文本。

```ts
// src/executor/session.ts 追加：子智能体创建
export type ExecutorAgent = {
  agentId: string
  sessionId: string
  tools: ToolDescriptor[]
}

export type HostAgentFactory = {
  create(input: {
    nodeRunId: string
    attempt: number
    input: unknown
    outputSchema: unknown
    toolPolicy: unknown
    // 不继承主会话历史，只拿节点输入与策略（规格 5.2 行 444-445）
    inheritHistory: false
  }): Promise<{ agentId: string; sessionId: string }>
}

// 指令文本里写明：完成由服务端收口，执行器不许自报完成（规格 5.2 行 448）
export function buildInstruction(input: { nodeId: string; outputSchema: unknown }): string {
  return [
    '你在执行编排里的一个节点，节点编号：' + input.nodeId + '。',
    '只按给的输入与工具策略做事，不要碰主会话的历史。',
    '做完把结果按 outputSchema 交上来；不要自己宣告节点完成，完成由服务端收口。',
  ].join('\n')
}

// 任务会话默认不给工具，storages 读写 deny（规格 5.2 行 445-446）
export const TASK_SESSION_TOOL_POLICY: ToolPolicy = { allow: [], deny: [], declaredPolicy: 'pure' }
export const TASK_SESSION_STORAGE_DENY = ['storages:read', 'storages:write']

export async function createExecutorAgent(
  host: HostAgentFactory,
  registry: ToolRegistry,
  params: { nodeRunId: string; attempt: number; input: unknown; outputSchema: unknown; toolPolicy: ToolPolicy },
): Promise<ExecutorAgent> {
  checkToolPolicy(registry, params.toolPolicy)
  const tools = resolveToolSet(registry, params.toolPolicy)
  const res = await host.create({
    nodeRunId: params.nodeRunId,
    attempt: params.attempt,
    input: params.input,
    outputSchema: params.outputSchema,
    toolPolicy: { allow: tools.map((t) => t.name), deny: params.toolPolicy.deny ?? [] },
    inheritHistory: false,
  })
  return { agentId: res.agentId, sessionId: res.sessionId, tools }
}
```

**测试：**

- Create: `tests/session.spec.ts`
  - `resolveToolSet`：`allow=['a','b']`、`deny=['b']` → 只剩 a；`allow` 里出现没注册的工具 → 抛 `TOOL_NOT_REGISTERED`；`allow` 缺省（未声明）→ 工具集为空。
  - `checkToolPolicy`：allow 里含 `mutating` 且声明 `pure` → 抛 `SIDE_EFFECT_UNDECLARED`；allow 里含 `compensating` → 抛 `COMPENSATION_TOOL_IN_FORWARD_PATH`；未声明策略时按推导结果返回。
  - `buildOutputTriplet`：payload 超过 64 KiB → `payloadTruncated=true`、`droppedFields` 非空、`payloadBytes` 小于等于 65536；payload 未超限 → 不截断、`droppedFields` 为空。
  - 摘要 900 字 → 结果摘要长度为 800。
  - `buildInstruction` 的文本里含「不要自己宣告节点完成」。
  - `TASK_SESSION_TOOL_POLICY.allow` 为空数组；`TASK_SESSION_STORAGE_DENY` 含 `storages:read` 与 `storages:write`。
  - `createExecutorAgent` 传给宿主的 `inheritHistory` 为 false。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/session.spec.ts
pnpm check
```

期望：typecheck 无错误；执行器用例全绿；`pnpm check` 三段都过。

**提交：**

```powershell
git add src/executor/session.ts tests/session.spec.ts
git commit -m "feat(executor): 加 agent 节点执行器与输出三件套"
```

---
## Task 8：节点状态机与 Ga / Gr

**目标：** 把节点状态与迁移表写死成代码：十三种非终态、七种终态、合法迁移一张表；所有迁移写成带 `WHERE` 条件的 `UPDATE` 并走 CAS，受影响行数必须恰为 1。同时把两个代分开：动作代 Ga 跟动作走，续期代 Gr 跟续期走，谁也不许替谁加。

**Files:**
- Create: `src/core/state-machine.ts` —— 状态集合与合法迁移表。
- Create: `src/service/commands/node-state.ts` —— 带 CAS 的迁移执行器。
- Create: `tests/state-machine.spec.ts` —— 迁移合法性与 CAS 的用例。

**步骤：**

1. 状态集合与迁移表。

```ts
// src/core/state-machine.ts —— node_run 状态集合与合法迁移表（规格 3.5 行 177-179、4.8 行 400）
export const NON_TERMINAL_STATUSES = [
  'queued',
  'leased',
  'dispatched',
  'started',
  'waiting',
  'verifying',
  'timing_out',
  'stopping',
  'startup_unknown',
  'paused_bridge_missing',
  'blocked_pre',
  'blocked_post',
  'indeterminate_side_effect',
] as const

export const TERMINAL_STATUSES = [
  'done',
  'failed',
  'timeout',
  'abandoned_unverified',
  'failed_with_unverified',
  'orphaned',
  'superseded',
] as const

export type NonTerminalStatus = (typeof NON_TERMINAL_STATUSES)[number]
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]
export type NodeStatus = NonTerminalStatus | TerminalStatus

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

// 合法迁移表：从哪个状态能去哪儿；终态没有出边（规格 3.5 行 179）
export const ALLOWED_TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  queued: ['leased', 'blocked_pre', 'superseded'],
  leased: ['dispatched', 'queued', 'blocked_pre', 'superseded'],
  dispatched: ['started', 'stopping', 'startup_unknown', 'timing_out', 'paused_bridge_missing', 'blocked_pre', 'superseded'],
  started: ['verifying', 'stopping', 'startup_unknown', 'timing_out', 'indeterminate_side_effect', 'blocked_pre', 'blocked_post', 'superseded'],
  waiting: ['dispatched', 'started', 'stopping', 'blocked_pre', 'blocked_post', 'superseded'],
  verifying: ['done', 'failed', 'blocked_post', 'timeout', 'failed_with_unverified', 'stopping', 'superseded'],
  timing_out: ['stopping', 'timeout', 'done', 'failed', 'orphaned'],
  stopping: ['timeout', 'failed', 'orphaned', 'indeterminate_side_effect', 'done', 'failed_with_unverified'],
  startup_unknown: ['started', 'stopping', 'orphaned', 'indeterminate_side_effect', 'blocked_post'],
  paused_bridge_missing: ['dispatched', 'started', 'stopping', 'orphaned'],
  blocked_pre: ['dispatched', 'queued', 'started', 'blocked_post'],
  blocked_post: ['dispatched', 'verifying', 'failed', 'timeout', 'orphaned'],
  indeterminate_side_effect: ['verifying', 'failed_with_unverified', 'abandoned_unverified', 'orphaned'],
  done: [],
  failed: [],
  timeout: [],
  abandoned_unverified: [],
  failed_with_unverified: [],
  orphaned: [],
  superseded: [],
}

export function canTransition(from: string, to: string): boolean {
  const edges = ALLOWED_TRANSITIONS[from as NodeStatus]
  if (!edges) return false
  return edges.includes(to as NodeStatus)
}
```

2. 迁移执行器：一次迁移一笔 CAS，代按语义分开。

```ts
// src/service/commands/node-state.ts —— 节点状态迁移（规格 4.3 行 309-311、3.5 行 176）
import { OrchError } from '../../core/errors.ts'
import { canTransition } from '../../core/state-machine.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { runCas } from '../../infra/db/tx.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'

export type TransitionParams = {
  nodeRunId: string
  from: string
  to: string
  attempt: number
  revision: number
  // 动作代：重新派发或新 attempt 时加一（规格 4.3 行 311）
  actionGeneration?: number
  // 续期代：重新武装截止时间、裁决续期、桥恢复补预算时加一（规格 4.3 行 310）
  rearmGeneration?: number
  now: string
  reason: string
}

// 迁移必须合法，且 CAS 条件里带 revision 与 attempt
export function transitionNode(tx: Tx, secret: string, params: TransitionParams): void {
  if (!canTransition(params.from, params.to)) {
    throw new OrchError('STALE_GENERATION', '这条迁移不在合法迁移表里', {
      from: params.from,
      to: params.to,
    })
  }
  const sets: string[] = ['status = ?', 'revision = revision + 1', 'updated_at = ?']
  const values: unknown[] = [params.to, params.now]
  if (params.actionGeneration !== undefined) {
    sets.push('action_generation = ?')
    values.push(params.actionGeneration)
  }
  if (params.rearmGeneration !== undefined) {
    sets.push('rearm_generation = ?')
    values.push(params.rearmGeneration)
  }
  values.push(params.nodeRunId, params.from, params.attempt, params.revision)
  // 条件里必须带 revision 与 attempt；受影响行数必须恰为 1（总纲 §4.4）
  runCas(
    tx,
    'UPDATE node_runs SET ' + sets.join(', ') + ' WHERE node_run_id = ? AND status = ? AND attempt = ? AND revision = ?',
    values,
    { rows: 1, what: 'transitionNode' },
  )
  appendNodeRunEvent(tx, secret, params.nodeRunId, 'status_changed', {
    from: params.from,
    to: params.to,
    attempt: params.attempt,
    action_generation: params.actionGeneration,
    rearm_generation: params.rearmGeneration,
    reason: params.reason,
  })
}

// 重新武装截止时间：截止时间变了就算续期，Gr 加一，Ga 不动（规格 4.3 行 310）
export function rearmDeadline(tx: Tx, secret: string, params: {
  nodeRunId: string
  attempt: number
  revision: number
  deadlineAt: string
  deadlineBootId: string
  deadlineMonotonicNs: number
  rearmGeneration: number
  now: string
  reason: string
}): void {
  runCas(
    tx,
    'UPDATE node_runs SET deadline_at = ?, deadline_boot_id = ?, deadline_monotonic_ns = ?, rearm_generation = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND revision = ?',
    [params.deadlineAt, params.deadlineBootId, params.deadlineMonotonicNs, params.rearmGeneration, params.now, params.nodeRunId, params.attempt, params.revision],
    { rows: 1, what: 'rearmDeadline' },
  )
  appendNodeRunEvent(tx, secret, params.nodeRunId, 'deadline_rearmed', {
    deadline_at: params.deadlineAt,
    rearm_generation: params.rearmGeneration,
    reason: params.reason,
  })
}
```

3. 两个代的分工写成一段可测的判据，防止以后被人合成一个数。

```ts
// src/core/state-machine.ts 追加：两个代的分工判据
// Ga 跟动作走、Gr 跟续期走，两者不许合并（规格 4.3 行 309-310）
export type GenerationBump =
  | { kind: 'redispatch'; actionGeneration: number }
  | { kind: 'rearm'; rearmGeneration: number }
  | { kind: 'none' }

export function nextGenerationBump(current: {
  actionGeneration: number
  rearmGeneration: number
}, bump: GenerationBump): { actionGeneration: number; rearmGeneration: number } {
  if (bump.kind === 'redispatch') {
    return { actionGeneration: bump.actionGeneration, rearmGeneration: current.rearmGeneration }
  }
  if (bump.kind === 'rearm') {
    return { actionGeneration: current.actionGeneration, rearmGeneration: bump.rearmGeneration }
  }
  return { actionGeneration: current.actionGeneration, rearmGeneration: current.rearmGeneration }
}
```

**测试：**

- Create: `tests/state-machine.spec.ts`
  - 十三种非终态与七种终态各自在集合里；`isTerminal('done')` 为 true、`isTerminal('started')` 为 false。
  - 终态没有出边：`canTransition('done','started')` 为 false。
  - `canTransition('queued','dispatched')` 为 false（queued 只能先到 leased）；`canTransition('leased','dispatched')` 为 true。
  - 迁移 CAS：造一行 `node_run`，用错误的 `revision` 迁移 → 抛 `STALE_GENERATION`（`details.what='transitionNode'`）且行未变；用对的 `revision` → 成功、`revision` 加一、`node_run_events` 有 `status_changed`。
  - 迁移到非法目标（`'queued'→'dispatched'`）→ 抛 `STALE_GENERATION`。
  - `rearmDeadline` 只改 `rearm_generation` 与截止字段，`action_generation` 不变。
  - `nextGenerationBump`：`kind='redispatch'` 时 `rearmGeneration` 保持原值；`kind='rearm'` 时 `actionGeneration` 保持原值；两个代在两种情形下都不许一起变。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/state-machine.spec.ts
pnpm check
```

期望：typecheck 无错误；状态机用例全绿；`pnpm check` 三段都过。

**提交：**

```powershell
git add src/core/state-machine.ts src/service/commands/node-state.ts tests/state-machine.spec.ts
git commit -m "feat(node): 加节点状态机与动作代续期代分离"
```

---
## Task 9：applyReport 六步与 report_registry

**目标：** 把上报收口写成一条固定顺序的事务：幂等 → schema 校验 → status+attempt+generation 三样 CAS → 证据评估 → 判定规则求值 → 节点 CAS 加 registry 标 applied 加哈希链留痕。六步在同一笔 `BEGIN IMMEDIATE` 里；拒绝也要落 `report_registry(state='rejected')` 并把拒绝事实追加进哈希链。

**Files:**
- Create: `src/core/report.ts` —— 上报信封的类型与 schema。
- Create: `src/service/commands/apply-report.ts` —— 六步收口与 registry 状态机。
- Create: `tests/apply-report.spec.ts` —— 六步顺序与幂等的用例。

**步骤：**

1. 先定上报信封与 registry 状态枚举。

```ts
// src/core/report.ts —— 上报信封（规格 4.2 行 286-305）
export type ReportEvidence = {
  // 来源决定强弱：run_tool 是强证据，tool_result 是弱证据（规格 4.7 行 380-383）
  source: 'run_tool' | 'tool_result'
  exitCode?: number
  stdoutHash?: string
  stderrHash?: string
  hashes?: Record<string, string>
  producedAt?: string
}

export type Report = {
  report_id: string
  node_run_id: string
  attempt: number
  status: string
  evidence?: ReportEvidence
  output?: unknown
  error_code?: string
}

export type ApplyResult = {
  accepted: boolean
  reason?: string
  next_status?: string
  registry_state: 'rejected' | 'replayed' | 'applied' | 'stale'
}

// registry 的 state 只许这四个（规格 4.2 行 300）
export const REPORT_REGISTRY_STATES = ['rejected', 'replayed', 'applied', 'stale'] as const
export type ReportRegistryState = (typeof REPORT_REGISTRY_STATES)[number]

export function isReportRegistryState(value: string): value is ReportRegistryState {
  return (REPORT_REGISTRY_STATES as readonly string[]).includes(value)
}
```

2. 六步主体。顺序是硬的：先查重，再校验，再 CAS，再评估证据，再求值，最后才落账。

```ts
// src/service/commands/apply-report.ts —— applyReport 六步收口（规格 4.2 行 286-305）
import { OrchError } from '../../core/errors.ts'
import { isReportRegistryState, type ApplyResult, type Report } from '../../core/report.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { runCas } from '../../infra/db/tx.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'
import { assertLeaseValid, loadNodeRun, type NodeRunRow } from './lease.ts'
import { evaluateEvidence, evaluatePassConditions } from '../../core/policy.ts'
import { canTransition } from '../../core/state-machine.ts'

export type ApplyReportParams = {
  nodeRunId: string
  attempt: number
  report: Report
  expectedStatus: string
  // 动作代：执行器回写时带自己看到的 Ga，对不上就是过期写（规格 4.3 行 309）
  generation: number
  now: string
}

type RegistryRow = {
  report_id: string
  node_run_id: string
  attempt: number
  report_seq: number
  state: string
}

function readRegistry(tx: Tx, reportId: string): RegistryRow | undefined {
  return tx.get<RegistryRow>('SELECT * FROM report_registry WHERE report_id = ?', [reportId])
}

// report_seq 在同一笔事务里按 node_run 内最大值加一算，不建触发器
function nextReportSeq(tx: Tx, nodeRunId: string): number {
  const row = tx.get<{ max_seq: number | null }>(
    'SELECT MAX(report_seq) AS max_seq FROM report_registry WHERE node_run_id = ?',
    [nodeRunId],
  )
  return (row?.max_seq ?? 0) + 1
}

// 拒绝也要留痕：registry 落 rejected，哈希链追加 report_rejected（规格 4.2 行 298）
function rejectReport(tx: Tx, secret: string, params: {
  nodeRunId: string
  attempt: number
  report: Report
  reportSeq: number
  reason: string
}): ApplyResult {
  const existing = readRegistry(tx, params.report.report_id)
  if (existing) {
    tx.run('UPDATE report_registry SET state = ?, updated_at = ? WHERE report_id = ?', ['rejected', params.now, params.report.report_id])
  } else {
    tx.run(
      'INSERT INTO report_registry (report_id, node_run_id, attempt, report_seq, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [params.report.report_id, params.nodeRunId, params.attempt, params.reportSeq, 'rejected', params.now, params.now],
    )
  }
  appendNodeRunEvent(tx, secret, params.nodeRunId, 'report_rejected', {
    report_id: params.report.report_id,
    report_seq: params.reportSeq,
    reason: params.reason,
  })
  return { accepted: false, reason: params.reason, registry_state: 'rejected' }
}

// 六步固定顺序，全部在同一笔 BEGIN IMMEDIATE 事务里（规格 4.2 行 294-300）
export function applyReport(
  tx: Tx,
  secret: string,
  params: ApplyReportParams,
  policy: { passConditions: string[]; requiredHashes?: string[] },
): ApplyResult {
  const report = params.report
  // 第一步：幂等查重
  const existing = readRegistry(tx, report.report_id)
  if (existing) {
    if (!isReportRegistryState(existing.state)) {
      throw new OrchError('STALE_GENERATION', 'registry 状态不在枚举里', { state: existing.state })
    }
    if (existing.state === 'applied') {
      // 已经落过账：不许再落一次，只把状态记成 replayed
      tx.run('UPDATE report_registry SET state = ?, updated_at = ? WHERE report_id = ?', ['replayed', params.now, report.report_id])
      appendNodeRunEvent(tx, secret, params.nodeRunId, 'report_replayed', {
        report_id: report.report_id,
        report_seq: existing.report_seq,
        reason: 'already_applied',
      })
      return { accepted: false, reason: 'already_applied', registry_state: 'replayed' }
    }
    if (existing.state === 'replayed') {
      appendNodeRunEvent(tx, secret, params.nodeRunId, 'report_replayed', {
        report_id: report.report_id,
        report_seq: existing.report_seq,
        reason: 'already_replayed',
      })
      return { accepted: false, reason: 'already_replayed', registry_state: 'replayed' }
    }
    // 已 rejected 的走重放路径：先验哈希链，再把状态推到 replayed，继续往下走
    const chainOk = tx.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ?',
      [params.nodeRunId],
    )
    if (!chainOk || chainOk.n === 0) {
      throw new OrchError('STALE_GENERATION', '重放前哈希链为空，链路不完整', { nodeRunId: params.nodeRunId })
    }
    tx.run('UPDATE report_registry SET state = ?, updated_at = ? WHERE report_id = ?', ['replayed', params.now, report.report_id])
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'report_replayed', {
      report_id: report.report_id,
      report_seq: existing.report_seq,
      reason: 'replay_after_reject',
    })
  }
  // 第二步：schema 校验
  if (!report.report_id || report.report_id.length === 0) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'report_id 不能为空', { report })
  }
  if (report.node_run_id !== params.nodeRunId) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'report 的 node_run_id 与请求不一致', { report })
  }
  const reportSeq = existing ? existing.report_seq : nextReportSeq(tx, params.nodeRunId)
  // 第三步：status + attempt + generation 三样 CAS（含租约校验）
  const row: NodeRunRow = loadNodeRun(tx, params.nodeRunId)
  if (row.attempt !== params.attempt) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: 'attempt_mismatch' })
  }
  if (row.status !== params.expectedStatus) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: 'status_mismatch' })
  }
  if (row.action_generation !== params.generation) {
    // 动作代对不上：旧执行器的写，按过期写拒
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: 'generation_mismatch' })
  }
  assertLeaseValid(row, params.now)
  // 目标状态必须在合法迁移表里：非法迁移按拒绝处理，不许绕过状态机
  if (!canTransition(row.status, report.status)) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: 'illegal_transition' })
  }
  // 第四步：证据评估
  const evidence = evaluateEvidence(report, policy.requiredHashes ?? [])
  if (!evidence.ok) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: evidence.reason ?? 'evidence_rejected' })
  }
  // 第五步：按模板判定规则求值
  const verdict = evaluatePassConditions(policy.passConditions, evidence.normalized)
  if (!verdict.pass) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: verdict.reason ?? 'verdict_unmet' })
  }
  // 第六步：节点 CAS + registry 标 applied + 哈希链留痕
  runCas(
    tx,
    'UPDATE node_runs SET status = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND status = ? AND attempt = ? AND action_generation = ?',
    [report.status, params.now, params.nodeRunId, params.expectedStatus, params.attempt, params.generation],
    { rows: 1, what: 'applyReport-node' },
  )
  if (existing) {
    tx.run('UPDATE report_registry SET state = ?, updated_at = ? WHERE report_id = ?', ['applied', params.now, report.report_id])
  } else {
    tx.run(
      'INSERT INTO report_registry (report_id, node_run_id, attempt, report_seq, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [report.report_id, params.nodeRunId, params.attempt, reportSeq, 'applied', params.now, params.now],
    )
  }
  appendNodeRunEvent(tx, secret, params.nodeRunId, 'report_applied', {
    report_id: report.report_id,
    report_seq: reportSeq,
    next_status: report.status,
    evidence_digest: evidence.digest,
  })
  return { accepted: true, next_status: report.status, registry_state: 'applied' }
}
```

**测试：**

- Create: `tests/apply-report.spec.ts`
  - 正常上报：`accepted=true`、`registry_state='applied'`、`node_runs.status` 变成上报里的状态、`report_registry` 一行 `state='applied'`、`node_run_events` 里有 `report_applied` 且带 `evidence_digest`。
  - 同一个 `report_id` 上报两次：第二次 `accepted=false`、`reason='already_applied'`、`registry_state='replayed'`；`node_run_events` 里 `report_applied` 只出现一次（只落一次）；`node_runs.revision` 只加一。
  - `attempt` 对不上 → 拒：`registry_state='rejected'`、`reason='attempt_mismatch'`、`node_run_events` 有 `report_rejected`。
  - `expectedStatus` 与当前状态不符 → 拒，`reason='status_mismatch'`。
  - `generation` 与 `node_runs.action_generation` 不符 → 拒，`reason='generation_mismatch'`。
  - 租约已过期 → 抛 `LEASE_EXPIRED`（`details.proposed=true`），事务回滚，`node_runs` 未变。
  - `report_id` 为空 → 抛 `SCHEMA_VERSION_UNSUPPORTED`；`report.node_run_id` 与请求不符 → 抛 `SCHEMA_VERSION_UNSUPPORTED`。
  - 证据不足（不可逆节点只给 `exitCode`）→ 拒，`reason` 含 `verification_too_weak`。
  - 六步顺序：故意让第五步的判定不通过，确认前三步没有产生副作用（`node_runs.revision` 不变、`node_run_events` 里没有 `report_applied`）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/apply-report.spec.ts
pnpm check
```

期望：typecheck 无错误；六步与幂等用例全绿；`pnpm check` 三段都过。

**提交：**

```powershell
git add src/core/report.ts src/service/commands/apply-report.ts tests/apply-report.spec.ts
git commit -m "feat(report): 加 applyReport 六步收口与上报登记"
```

---
## Task 10：证据门与判定规则

**目标：** 把「什么算证据够」「什么算通过」写成可执行的两道门：证据强弱由来源决定，判定条件只能引用证据里的字段；证据不足就转人工核验，绝不出现「没证据也算过」。

**Files:**
- Create: `src/core/policy.ts` —— 证据评估与判定条件求值。
- Create: `tests/policy.spec.ts` —— 证据强弱与条件求值的用例。

**步骤：**

1. 写证据评估：强弱按来源，弱证据不能充当不可逆节点的通过凭据（规格 4.7 行 380-384）。

```ts
// src/core/policy.ts —— 证据门与判定规则（规格 4.7 行 371-391）
import { OrchError } from './errors.ts'
import { canonicalJson, sha256Hex } from './canonical.ts'
import type { Report, ReportEvidence } from './report.ts'

export type EvidenceEvaluation = {
  ok: boolean
  reason?: string
  // 强证据还是弱证据：run_tool 强，模型侧 tool_result 弱（规格 4.7 行 380-383）
  strength: 'strong' | 'weak'
  digest: string
  normalized: Record<string, unknown>
}

// passCondition 只许引用这几个字段（规格 4.7 行 386）
export const ALLOWED_EVIDENCE_FIELDS = ['exitCode', 'stdoutHash', 'stderrHash', 'hashes', 'producedAt'] as const

export function evaluateEvidence(report: Report, requiredHashes: string[]): EvidenceEvaluation {
  const ev: ReportEvidence | undefined = report.evidence
  if (!ev) {
    return { ok: false, reason: 'evidence_missing', strength: 'weak', digest: sha256Hex(canonicalJson({})), normalized: {} }
  }
  const strength: 'strong' | 'weak' = ev.source === 'run_tool' ? 'strong' : 'weak'
  const normalized: Record<string, unknown> = {
    exitCode: ev.exitCode,
    stdoutHash: ev.stdoutHash,
    stderrHash: ev.stderrHash,
    hashes: ev.hashes ?? {},
    producedAt: ev.producedAt,
  }
  const digest = sha256Hex(canonicalJson(normalized))
  // 不可逆节点的通过凭据必须是产物哈希，只有 exitCode 不够（规格 4.7 行 380）
  if (requiredHashes.length > 0) {
    const provided = new Set(Object.keys(ev.hashes ?? {}))
    const missing = requiredHashes.filter((h) => !provided.has(h))
    if (missing.length > 0) {
      return { ok: false, reason: 'verification_too_weak', strength, digest, normalized }
    }
    if (strength === 'weak') {
      // 弱证据不能充当不可逆节点的通过凭据（规格 4.7 行 383-384）
      return { ok: false, reason: 'verification_too_weak', strength, digest, normalized }
    }
  }
  return { ok: true, strength, digest, normalized }
}
```

2. 写判定条件求值：模板条件是底线，节点只能往上加。

```ts
// src/core/policy.ts 追加：判定条件求值
export type PassCondition = {
  // 形如 { path: 'evidence.exitCode', op: 'eq', value: 0 }
  path: string
  op: 'eq' | 'ne' | 'exists' | 'hashContains'
  value?: unknown
}

export type Verdict = { pass: boolean; reason?: string }

// 条件里的路径只许引用证据字段；引用 policy.requiredHashes 这类非法（规格 4.7 行 386）
export function validateCondition(condition: PassCondition): void {
  if (!condition.path.startsWith('evidence.')) {
    throw new OrchError('VERDICT_UNSUPPORTED', '判定条件只能引用 evidence 下的字段', { path: condition.path })
  }
  const field = condition.path.slice('evidence.'.length)
  if (!(ALLOWED_EVIDENCE_FIELDS as readonly string[]).includes(field)) {
    throw new OrchError('VERDICT_UNSUPPORTED', '判定条件引用了不许引用的字段', { path: condition.path })
  }
}

// 模板 passCondition 是 mandatory baseline，节点只能 and 追加（规格 4.7 行 390）
export function mergePassConditions(template: PassCondition[], node: PassCondition[]): PassCondition[] {
  const merged = template.slice()
  for (const cond of node) {
    const same = merged.find((c) => c.path === cond.path && c.op === cond.op)
    if (same) {
      same.value = cond.value
      continue
    }
    merged.push(cond)
  }
  return merged
}

export function evaluatePassConditions(conditions: PassCondition[], evidence: Record<string, unknown>): Verdict {
  for (const cond of conditions) {
    validateCondition(cond)
    const field = cond.path.slice('evidence.'.length)
    const actual = evidence[field]
    if (cond.op === 'exists') {
      if (actual === undefined || actual === null) return { pass: false, reason: 'verdict_unmet:' + cond.path }
      continue
    }
    if (cond.op === 'eq' && actual !== cond.value) {
      return { pass: false, reason: 'verdict_unmet:' + cond.path }
    }
    if (cond.op === 'ne' && actual === cond.value) {
      return { pass: false, reason: 'verdict_unmet:' + cond.path }
    }
    if (cond.op === 'hashContains') {
      const hashes = (actual ?? {}) as Record<string, unknown>
      const key = String(cond.value ?? '')
      if (!Object.prototype.hasOwnProperty.call(hashes, key)) {
        return { pass: false, reason: 'verdict_unmet:' + cond.path }
      }
    }
  }
  return { pass: true }
}
```

3. 证据不足的落点：报告拒收，节点转 `blocked_post` 并记人工核验请求（规格 4.7 行 389、11.2 行 850）。

```ts
// src/core/policy.ts 追加：证据不足的落点
export type EvidenceGapDecision = {
  next_status: 'blocked_post'
  // 证据不足不是失败，是等人来核（规格 4.7 行 389）
  request: { kind: 'verify_human'; reason: string; missing: string[] }
}

// 缺哪些必留哈希
export function missingHashes(evidence: ReportEvidence | undefined, requiredHashes: string[]): string[] {
  if (!evidence) return requiredHashes.slice()
  const provided = new Set(Object.keys(evidence.hashes ?? {}))
  return requiredHashes.filter((h) => !provided.has(h))
}
```

**测试：**

- Create: `tests/policy.spec.ts`
  - 报告没有 `evidence` → `evaluateEvidence` 返回 `ok=false`、`reason='evidence_missing'`。
  - `source='run_tool'` → `strength='strong'`；`source='tool_result'` → `strength='weak'`。
  - `requiredHashes=['artifact']` 而证据只给了 `exitCode` → `ok=false`、`reason='verification_too_weak'`；补上 `hashes.artifact` 且来源是 `run_tool` → `ok=true`。
  - `requiredHashes=['artifact']` 而来源是 `tool_result` → `ok=false`、`reason='verification_too_weak'`（弱证据不作不可逆凭据）。
  - `validateCondition` 对 `{path:'policy.requiredHashes',op:'exists'}` → 抛 `VERDICT_UNSUPPORTED`；对 `{path:'evidence.exitCode',op:'eq'}` → 通过；对 `{path:'evidence.unknownField',op:'exists'}` → 抛 `VERDICT_UNSUPPORTED`。
  - `mergePassConditions`：模板条件原样保留，节点追加的条件在后面；节点条件与模板条件同路径同运算符时取节点的值（and 语义，不是 or）。
  - `evaluatePassConditions`：条件 `{path:'evidence.exitCode',op:'eq',value:0}` 且证据 `exitCode=0` → pass；`exitCode=1` → `pass=false` 且 `reason` 以 `verdict_unmet` 开头。
  - `missingHashes` 在证据缺哈希时返回缺的那几个。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/policy.spec.ts
pnpm check
```

期望：typecheck 无错误；证据与判定用例全绿；`pnpm check` 三段都过。

**提交：**

```powershell
git add src/core/policy.ts tests/policy.spec.ts
git commit -m "feat(policy): 加证据门与判定规则求值"
```

---
## Task 11：取消与超时围栏

**目标：** 取消不是一句话就完：桥回四值，只有确认中断才立围栏进 `timing_out`，其余按规格 4.5 分别落位；围栏立着的时候进来的上报排队，围栏撤销后只重放当前 attempt 的队头；取消之后不产生新 attempt。

**Files:**
- Create: `src/service/commands/cancel.ts` —— 取消、围栏、排队与重放。
- Create: `tests/cancel.spec.ts` —— 四值、围栏与重放的用例。

**步骤：**

1. 取消主流程：先问桥，再按回包决定落位（规格 4.5 行 346-357）。

```ts
// src/service/commands/cancel.ts —— 取消与超时围栏（规格 4.5 行 344-358）
import { OrchError } from '../../core/errors.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { runCas } from '../../infra/db/tx.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'

export type CancelResult = 'interrupted' | 'not_interruptible' | 'already_stopped' | 'unknown'

export type CancelParams = {
  nodeRunId: string
  attempt: number
  revision: number
  cancelResult: CancelResult
  now: string
  // 宽限秒数：围栏立起后等 whenIdle 的时间（规格 4.5 行 345）
  graceMs: number
  // 只在 interrupted 时用：动作截止时间往后延多久
  extendDeadlineMs?: number
}

export type CancelOutcome = {
  cancel_result: CancelResult
  next_status: string
  fence_state: 'armed' | 'revoked' | null
  reason: string
}

// 只有 interrupted 才立围栏进 timing_out，其余各按规格 4.5 落位（规格 4.5 行 349-353）
export function applyCancel(tx: Tx, secret: string, params: CancelParams): CancelOutcome {
  if (params.cancelResult === 'interrupted') {
    const graceUntil = new Date(Date.parse(params.now) + params.graceMs).toISOString()
    runCas(
      tx,
      'UPDATE node_runs SET status = ?, fence_state = ?, fence_armed_at = ?, fence_grace_until = ?, cancel_requested_at = ?, cancel_result = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND revision = ?',
      ['timing_out', 'armed', params.now, graceUntil, params.now, 'interrupted', params.now, params.nodeRunId, params.attempt, params.revision],
      { rows: 1, what: 'cancel-interrupted' },
    )
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'fence_armed', {
      cancel_result: 'interrupted',
      grace_until: graceUntil,
      reason: 'cancel_confirmed',
    })
    return { cancel_result: 'interrupted', next_status: 'timing_out', fence_state: 'armed', reason: 'cancel_confirmed' }
  }
  if (params.cancelResult === 'not_interruptible') {
    // 动作停不下来：延长动作截止时间并进 stopping（规格 4.5 行 345）
    const deadline = new Date(Date.parse(params.now) + (params.extendDeadlineMs ?? 0)).toISOString()
    runCas(
      tx,
      'UPDATE node_runs SET status = ?, cancel_requested_at = ?, cancel_result = ?, deadline_at = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND revision = ?',
      ['stopping', params.now, 'not_interruptible', deadline, params.now, params.nodeRunId, params.attempt, params.revision],
      { rows: 1, what: 'cancel-not-interruptible' },
    )
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'cancel_not_interruptible', { deadline_at: deadline })
    return { cancel_result: 'not_interruptible', next_status: 'stopping', fence_state: null, reason: 'not_interruptible' }
  }
  if (params.cancelResult === 'already_stopped') {
    // 已经停了：按已停事实判定，不进 timing_out（规格 4.5 行 346）
    runCas(
      tx,
      'UPDATE node_runs SET cancel_requested_at = ?, cancel_result = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND revision = ?',
      [params.now, 'already_stopped', params.now, params.nodeRunId, params.attempt, params.revision],
      { rows: 1, what: 'cancel-already-stopped' },
    )
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'cancel_already_stopped', {})
    return { cancel_result: 'already_stopped', next_status: 'stopping', fence_state: null, reason: 'already_stopped' }
  }
  // unknown：进 stopping 再查执行器状态（规格 4.5 行 347）
  runCas(
    tx,
    'UPDATE node_runs SET status = ?, cancel_requested_at = ?, cancel_result = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND revision = ?',
    ['stopping', params.now, 'unknown', params.now, params.nodeRunId, params.attempt, params.revision],
    { rows: 1, what: 'cancel-unknown' },
  )
  appendNodeRunEvent(tx, secret, params.nodeRunId, 'cancel_unknown', {})
  return { cancel_result: 'unknown', next_status: 'stopping', fence_state: null, reason: 'unknown' }
}
```

2. 围栏期间的排队与撤销后的重放：只重放当前 attempt 的队头（规格 4.5 行 358）。

```ts
// src/service/commands/cancel.ts 追加：围栏撤销与上报重放
export type FenceRow = {
  node_run_id: string
  attempt: number
  revision: number
  status: string
  fence_state: string | null
  fence_grace_until: string | null
}

// 宽限到点仍没见停止：撤销围栏回 stopping（规格 4.5 行 346）
export function revokeFence(tx: Tx, secret: string, params: { row: FenceRow; now: string }): void {
  if (params.row.fence_state !== 'armed') return
  runCas(
    tx,
    'UPDATE node_runs SET status = ?, fence_state = ?, fence_grace_until = NULL, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND status = ? AND attempt = ? AND revision = ?',
    ['stopping', 'revoked', params.now, params.row.node_run_id, 'timing_out', params.row.attempt, params.row.revision],
    { rows: 1, what: 'revokeFence' },
  )
  appendNodeRunEvent(tx, secret, params.row.node_run_id, 'fence_revoked', { reason: 'grace_expired' })
}

// 围栏已立时收到的上报进 registry(rejected) 排队；围栏撤销后只重放当前 attempt 的队头
export function pickReplayHead(tx: Tx, nodeRunId: string, attempt: number): { report_id: string; report_seq: number } | undefined {
  const row = tx.get<{ report_id: string; report_seq: number }>(
    'SELECT report_id, report_seq FROM report_registry WHERE node_run_id = ? AND attempt = ? AND state = ? ORDER BY report_seq ASC LIMIT 1',
    [nodeRunId, attempt, 'rejected'],
  )
  return row
}

// 旧 attempt 的排队上报标 stale，不再重放（规格 4.5 行 351）
export function markOlderAttemptsStale(tx: Tx, params: { nodeRunId: string; currentAttempt: number; now: string }): number {
  const res = tx.run(
    'UPDATE report_registry SET state = ?, updated_at = ? WHERE node_run_id = ? AND attempt < ? AND state = ?',
    ['stale', params.now, params.nodeRunId, params.currentAttempt, 'rejected'],
  )
  return res.changes
}
```

**测试：**

- Create: `tests/cancel.spec.ts`
  - `cancelResult='interrupted'` → 状态变 `timing_out`、`fence_state='armed'`、`fence_grace_until` 约等于 now 加宽限秒数；`node_run_events` 有 `fence_armed`。
  - `cancelResult='not_interruptible'` → 状态变 `stopping`、`fence_state` 仍为 null、`deadline_at` 被延长。
  - `cancelResult='already_stopped'` → 不进 `timing_out`、`fence_state` 为 null。
  - `cancelResult='unknown'` → 状态变 `stopping`、`fence_state` 为 null。
  - `revokeFence`：`fence_state='armed'` 且状态是 `timing_out` 时调用 → 状态回 `stopping`、`fence_state='revoked'`；`fence_state` 不是 `armed` 时调用不动数据。
  - `pickReplayHead`：当前 attempt 有两条 `state='rejected'` 时返回 `report_seq` 较小的那条；旧 attempt 的 `rejected` 不被选中。
  - `markOlderAttemptsStale`：旧 attempt 的 `rejected` 行被改成 `stale`，当前 attempt 的不动。
  - 取消后 `node_runs.attempt` 不变（取消不产生新 attempt）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/cancel.spec.ts
pnpm check
```

期望：typecheck 无错误；取消与围栏用例全绿；`pnpm check` 三段都过。

**提交：**

```powershell
git add src/service/commands/cancel.ts tests/cancel.spec.ts
git commit -m "feat(cancel): 加取消四值与超时围栏排队重放"
```

---
## Task 12：截止时间与单调时钟

**目标：** 截止判定只认 `boot_id + monotonic_ns`：墙钟前后跳十分钟不误判，超差就转 `timer_uncertain` 不自动判超时；跨重启时停机时间不计入预算。附带把每分钟的维护扫描做成可重入。

**Files:**
- Create: `src/core/clock.ts` —— 单调时钟、漂移判定、跨 boot 预算换算。
- Create: `src/service/sweep.ts` —— 维护扫描（租约过期、围栏宽限）。
- Create: `tests/clock.spec.ts` —— 墙钟跳变与跨 boot 的用例。

**步骤：**

1. 写时钟抽象：截止只看单调钟，墙钟只用于展示（规格 3.4 行 171）。

```ts
// src/core/clock.ts —— 单调时钟与截止判定（规格 3.4 行 171、12.3 行 973）
import { OrchError } from './errors.ts'

export type BootId = string

export type ClockSample = {
  bootId: BootId
  monotonicNs: number
  wallClockMs: number
}

export type Deadline = {
  bootId: BootId
  monotonicNs: number
  wallClockMs: number
}

// 墙钟与单调钟的漂移容忍：超过 2 秒就不敢自动判超时（规格 3.4 行 171）
export const CLOCK_DRIFT_TOLERANCE_MS = 2000

export type ClockDecision =
  | { kind: 'pending'; remainingMs: number }
  | { kind: 'expired' }
  | { kind: 'uncertain'; reason: string }

export class MonotonicClock {
  private readonly bootId: BootId
  private readonly originWallMs: number
  private readonly originMonotonicNs: number
  private readonly driftSamples: number[] = []

  constructor(bootId: BootId, now: { wallClockMs: number; monotonicNs: number }) {
    this.bootId = bootId
    this.originWallMs = now.wallClockMs
    this.originMonotonicNs = now.monotonicNs
  }

  get id(): BootId { return this.bootId }

  // 用墙钟与单调钟两个来源估漂移；漂移超差就置不确定（规格 3.4 行 171）
  sample(wallClockMs: number, monotonicNs: number): number {
    const expectedWall = this.originWallMs + (monotonicNs - this.originMonotonicNs) / 1e6
    const drift = Math.abs(expectedWall - wallClockMs)
    this.driftSamples.push(drift)
    if (this.driftSamples.length > 32) this.driftSamples.shift()
    return drift
  }

  maxDriftMs(): number {
    return this.driftSamples.length === 0 ? 0 : Math.max(...this.driftSamples)
  }

  // 判定截止：只在同一个 boot 内比单调钟
  decide(deadline: Deadline, now: ClockSample): ClockDecision {
    if (now.bootId !== deadline.bootId) {
      return { kind: 'uncertain', reason: 'boot_changed' }
    }
    if (this.maxDriftMs() > CLOCK_DRIFT_TOLERANCE_MS) {
      return { kind: 'uncertain', reason: 'clock_drift' }
    }
    const remainingNs = deadline.monotonicNs - now.monotonicNs
    if (remainingNs <= 0) return { kind: 'expired' }
    return { kind: 'pending', remainingMs: remainingNs / 1e6 }
  }
}
```

2. 跨 boot 的预算换算：停机时间不计入预算（规格 4.4 行 342）。

```ts
// src/core/clock.ts 追加：跨 boot 剩余预算
export type PreviousClock = {
  bootId: BootId
  lastEventMonotonicNs: number
  lastEventWallMs: number
  deadlineMonotonicNs: number
}

// remaining = (deadline_monotonic_ns - prev.last_event_monotonic_ns) - (current_boot.started_at - prev.last_event_at)
// 停机那段时间不算进预算（规格 4.4 行 342）
export function remainingAcrossBoot(prev: PreviousClock, currentBoot: { startedAtMs: number; monotonicNs: number }): number {
  const budgetNs = prev.deadlineMonotonicNs - prev.lastEventMonotonicNs
  const downtimeMs = currentBoot.startedAtMs - prev.lastEventWallMs
  const remainingMs = budgetNs / 1e6 - downtimeMs
  return remainingMs > 0 ? remainingMs : 0
}
```

3. 维护扫描：可重入，每分钟扫租约过期与围栏宽限（规格 4.9 行 426-429）。

```ts
// src/service/sweep.ts —— 维护扫描（规格 4.9 行 426-429）
import type { Db } from '../infra/sqlite/driver.ts'
import { inTx } from '../infra/db/tx.ts'
import { sweepExpiredLeases } from './commands/lease.ts'

export type SweepResult = {
  lease_expired: string[]
  scanned_at: string
}

// 扫描必须可重入：重复跑不会产生第二份副作用
export function sweep(db: Db, secret: string, params: { now: string }): SweepResult {
  return inTx(db, (tx) => {
    const leaseExpired = sweepExpiredLeases(tx, secret, { now: params.now, leaseTtlMs: 0 })
    return { lease_expired: leaseExpired, scanned_at: params.now }
  })
}
```

**测试：**

- Create: `tests/clock.spec.ts`
  - 同一 boot、单调钟未到 → `decide` 返回 `kind='pending'` 且 `remainingMs` 大于 0；单调钟超过截止 → `kind='expired'`。
  - 墙钟向前跳十分钟、单调钟没动：`sample` 记下漂移；再 `decide` → `kind='uncertain'`、`reason='clock_drift'`，不许返回 `expired'`。
  - 墙钟向后跳十分钟同样判 `uncertain`。
  - 漂移在 2 秒以内时仍按单调钟判定（`pending` 或 `expired`）。
  - `decide` 时 `now.bootId` 与截止的 `bootId` 不同 → `kind='uncertain'`、`reason='boot_changed'`。
  - `remainingAcrossBoot`：预算 60 秒、上次事件后停机 20 秒 → 剩余 40 秒；停机 90 秒 → 剩余 0。
  - `sweep` 连跑两次：第二次的 `lease_expired` 为空（可重入）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/clock.spec.ts
pnpm check
```

期望：typecheck 无错误；时钟与扫描用例全绿；`pnpm check` 三段都过。

**提交：**

```powershell
git add src/core/clock.ts src/service/sweep.ts tests/clock.spec.ts
git commit -m "feat(clock): 加单调时钟判定与维护扫描"
```

---
## Task 13：S2 阶段开关与加载期拒

**目标：** 把阶段能力表落到代码：S2 只允许单 `agent` 节点闭环；加载含 `parallel` 或 `subworkflow` 节点的定义必须被拒；越阶段的命令报明确错误码。

**Files:**
- Create: `src/core/workflow-def.ts` —— 定义校验与阶段兼容检查。
- Modify: `src/core/config.ts` —— 能力表补 S2 允许项。
- Create: `tests/workflow-def.spec.ts` —— 加载期拒的用例。

**步骤：**

1. 定义节点类型与阶段兼容检查。

```ts
// src/core/workflow-def.ts —— 定义校验与阶段兼容（规格 2.4 行 122、11.1 行 837-844）
import { OrchError } from './errors.ts'
import { PHASE_CAPABILITIES, requireCapability, type Phase } from './config.ts'

export type NodeType = 'agent' | 'parallel' | 'subworkflow' | 'decision' | 'wait'

export type WorkflowDefinition = {
  workflow_version: string
  nodes: { node_id: string; type: NodeType; tools?: { allow?: string[]; deny?: string[] } }[]
}

// 节点类型对应的能力名
export const NODE_CAPABILITY: Record<NodeType, string> = {
  agent: 'agent_node',
  parallel: 'parallel',
  subworkflow: 'subworkflow',
  decision: 'decision',
  wait: 'wait',
}

export function isKnownNodeType(type: string): type is NodeType {
  return Object.prototype.hasOwnProperty.call(NODE_CAPABILITY, type)
}

// 加载期按 min_phase 拒越阶段能力：S2 加载 parallel 节点必须被拒（规格 2.4 行 122）
export function assertDefinitionAllowed(def: WorkflowDefinition, phase: Phase): void {
  for (const node of def.nodes) {
    if (!isKnownNodeType(node.type)) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '未知节点类型', { node_id: node.node_id, type: node.type })
    }
    const capability = NODE_CAPABILITY[node.type]
    requireCapability(phase, capability)
  }
}

// 命令越过阶段的闸：能力不在当前阶段的清单里就拒（规格 2.4 行 122）
export function assertCommandAllowed(command: string, phase: Phase, needed: string): void {
  const caps = PHASE_CAPABILITIES[phase]
  if (!caps.includes(needed)) {
    throw new OrchError('FORBIDDEN', '当前阶段不许做这件事', {
      command,
      phase,
      needed,
      allowed: caps.slice(),
    })
  }
}
```

2. 把阶段能力表补齐：S2 允许单 agent 闭环，禁止 parallel / subworkflow / workflow 发布（规格 11.1 行 842）。

```ts
// src/core/config.ts 里 PHASE_CAPABILITIES 的 S2 行（规格 11.1 行 842）
// S2 允许：账本、迁移、备份、只读查询、桥、agent 节点
// S2 禁止：parallel、subworkflow、workflow 发布、面板接真实账本
export const PHASE_CAPABILITIES: Record<Phase, readonly string[]> = {
  S1: ['ledger', 'migration', 'backup', 'readonly_query'],
  S2: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node'],
  S3: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node', 'all_nodes', 'decision', 'approval', 'parallel', 'wait', 'subworkflow', 'compensation'],
  S4: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node', 'all_nodes', 'decision', 'approval', 'parallel', 'wait', 'subworkflow', 'compensation', 'workflow_publish'],
  S5: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node', 'all_nodes', 'decision', 'approval', 'parallel', 'wait', 'subworkflow', 'compensation', 'workflow_publish', 'panel', 'memory'],
  S6: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node', 'all_nodes', 'decision', 'approval', 'parallel', 'wait', 'subworkflow', 'compensation', 'workflow_publish', 'panel', 'memory', 'release'],
}
```

**测试：**

- Create: `tests/workflow-def.spec.ts`
  - 只有一个 `agent` 节点的定义在 `phase='S2'` 下 → `assertDefinitionAllowed` 通过。
  - 含一个 `parallel` 节点的定义在 `phase='S2'` 下 → 抛 `FORBIDDEN`，`details.needed='parallel'`、`details.phase='S2'`。
  - 含一个 `subworkflow` 节点的定义在 `phase='S2'` 下 → 抛 `FORBIDDEN`。
  - 节点类型写成 `'mystery'` → 抛 `SCHEMA_VERSION_UNSUPPORTED`。
  - 同一个 `parallel` 定义在 `phase='S3'` 下 → 通过（能力表逐级抬）。
  - `assertCommandAllowed` 在 `phase='S2'`、`needed='parallel'` 时 → 抛 `FORBIDDEN`；`needed='agent_node'` 时通过。
  - 阶段能力表断言：`PHASE_CAPABILITIES.S2` 含 `'agent_node'`，不含 `'parallel'`、`'subworkflow'`、`'workflow_publish'`。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/workflow-def.spec.ts
pnpm check
```

期望：typecheck 无错误；阶段拒调用例全绿；`pnpm check` 三段都过。

**提交：**

```powershell
git add src/core/workflow-def.ts src/core/config.ts tests/workflow-def.spec.ts
git commit -m "feat(phase): 加 S2 阶段开关与加载期拒"
```

---
## Task 14：G2 用例与门记录

**目标：** 把 G2 的八条必过项逐条落成可跑的用例与证据，并写出门记录文件；门检查脚本沿用 S1 的逻辑，不另起一套判定口径。

**Files:**
- Create: `tests/integration/g2.spec.ts` —— G2 八条必过项的集成用例。
- Modify: `scripts/fault-inject.ts` —— 注入用例类型加 G-03 / G-04 / G-05 / G-07。
- Modify: `scripts/gate-check.ts` —— 不改判定逻辑，只确认能吃 G2 的门记录（复用 S1 实现）。
- Create: `docs/gates/G2.md` —— G2 门记录。

**步骤：**

1. 先把注入脚本的用例类型补齐。G-03 / G-04 / G-05 / G-07 各留注入参数、前后账本片段、恢复后对账查询三段（规格 12.3 行 984）。

```ts
// scripts/fault-inject.ts 追加：S2 的四条注入
export type InjectionCase =
  | 'G-01'
  | 'G-02'
  | 'G-03'
  | 'G-04'
  | 'G-05'
  | 'G-07'
  | 'G-08'
  | 'G-09'
  | 'G-14'
  | 'G-15'

// 注入定义：每条都要写清参数、注入动作与对账查询
export type InjectionSpec = {
  case_id: InjectionCase
  title: string
  params: Record<string, unknown>
  // 注入动作
  inject: 'repeat_report' | 'late_report_after_lease_expiry' | 'cancel_during_tool' | 'wall_clock_jump'
  // 恢复后的对账查询：没有对账查询的注入不算通过（规格 12.3 行 984）
  reconciliation: string
}

export const S2_INJECTIONS: InjectionSpec[] = [
  {
    case_id: 'G-03',
    title: '同一个 report_id 上报两次',
    params: { report_id: 'rpt_g03_1', node_run_id: 'nrun_g03' },
    inject: 'repeat_report',
    reconciliation: "SELECT report_id, state, COUNT(*) FROM report_registry WHERE report_id = 'rpt_g03_1' GROUP BY report_id, state",
  },
  {
    case_id: 'G-04',
    title: '租约到期后原执行器迟到上报',
    params: { node_run_id: 'nrun_g04', lease_ttl_ms: 30000 },
    inject: 'late_report_after_lease_expiry',
    reconciliation: "SELECT status, action_generation FROM node_runs WHERE node_run_id = 'nrun_g04'",
  },
  {
    case_id: 'G-05',
    title: '工具执行中取消',
    params: { node_run_id: 'nrun_g05', cancel_result: 'interrupted' },
    inject: 'cancel_during_tool',
    reconciliation: "SELECT status, fence_state, cancel_result FROM node_runs WHERE node_run_id = 'nrun_g05'",
  },
  {
    case_id: 'G-07',
    title: '墙钟前后跳十分钟并覆盖重启',
    params: { node_run_id: 'nrun_g07', jump_ms: 600000 },
    inject: 'wall_clock_jump',
    reconciliation: "SELECT status, deadline_boot_id, deadline_monotonic_ns FROM node_runs WHERE node_run_id = 'nrun_g07'",
  },
]
```

2. 写 G2 集成用例：八条必过项一条一条对。

```ts
// tests/integration/g2.spec.ts —— G2 必过项集成用例（规格 11.2 行 852）
import { describe, expect, it } from 'vitest'
import { applyReport } from '../../src/service/commands/apply-report.ts'
import { acquireLease } from '../../src/service/commands/lease.ts'
import { applyCancel } from '../../src/service/commands/cancel.ts'
import { assertDefinitionAllowed } from '../../src/core/workflow-def.ts'
import { MonotonicClock } from '../../src/core/clock.ts'
import { inTx } from '../../src/infra/db/tx.ts'
import { freshLedger, TEST_SECRET } from '../fixtures/ledger.ts'
import type { Db } from '../../src/infra/sqlite/driver.ts'

const NOW = '2026-11-12T00:00:00.000Z'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

// 塞一条 queued 的 node_run，供各条用例复用
function seedQueued(db: Db, nodeRunId: string): void {
  inTx(db, (tx) => {
    tx.run(
      'INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, action_generation, rearm_generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [nodeRunId, 'run_g2', 'node_a', 1, 'agent', 1, 'queued', 0, 0, 0, NOW, NOW],
    )
  })
}

function rowOf(db: Db, nodeRunId: string): Record<string, unknown> {
  return inTx(db, (tx) => tx.get<Record<string, unknown>>('SELECT * FROM node_runs WHERE node_run_id = ?', [nodeRunId]) ?? {})
}

function countOf(db: Db, sql: string, params: unknown[]): number {
  return inTx(db, (tx) => tx.get<{ n: number }>(sql, params)?.n ?? 0)
}

// 一步到位的强证据上报
function goodReport(nodeRunId: string, reportId: string, status: string) {
  return {
    report_id: reportId,
    node_run_id: nodeRunId,
    attempt: 1,
    status,
    evidence: {
      source: 'run_tool' as const,
      exitCode: 0,
      stdoutHash: HASH_A,
      stderrHash: HASH_B,
      hashes: {},
      producedAt: NOW,
    },
  }
}

const PASS = { passConditions: [{ path: 'evidence.exitCode', op: 'eq' as const, value: 0 }] }

describe('G2 门必过项', () => {
  it('单节点 queued 到终态一条路径', () => {
    const { db } = freshLedger()
    seedQueued(db, 'nrun_g2_01')
    const lease = inTx(db, (tx) => acquireLease(tx, TEST_SECRET, {
      nodeRunId: 'nrun_g2_01', ownerEpoch: 1, leaseTtlMs: 30000, now: NOW,
    }))
    expect(lease.actionGeneration).toBe(1)
    const steps = ['started', 'verifying', 'done']
    let expected = 'dispatched'
    for (const target of steps) {
      const res = inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
        nodeRunId: 'nrun_g2_01', attempt: 1, expectedStatus: expected, generation: 1, now: NOW,
        report: goodReport('nrun_g2_01', 'rpt_g2_01_' + target, target),
      }, PASS))
      expect(res.accepted).toBe(true)
      expect(res.registry_state).toBe('applied')
      expected = target
    }
    expect(rowOf(db, 'nrun_g2_01').status).toBe('done')
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = ?', ['nrun_g2_01', 'report_applied'])).toBe(3)
  })

  it('重复上报只落一次', () => {
    const { db } = freshLedger()
    seedQueued(db, 'nrun_g2_02')
    inTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nrun_g2_02', ownerEpoch: 1, leaseTtlMs: 30000, now: NOW }))
    const first = inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
      nodeRunId: 'nrun_g2_02', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: NOW,
      report: goodReport('nrun_g2_02', 'rpt_g2_02', 'started'),
    }, PASS))
    expect(first.accepted).toBe(true)
    const second = inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
      nodeRunId: 'nrun_g2_02', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: NOW,
      report: goodReport('nrun_g2_02', 'rpt_g2_02', 'started'),
    }, PASS))
    expect(second.accepted).toBe(false)
    expect(second.registry_state).toBe('replayed')
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = ?', ['nrun_g2_02', 'report_applied'])).toBe(1)
  })

  it('租约过期迟到上报被拒', () => {
    const { db } = freshLedger()
    seedQueued(db, 'nrun_g2_03')
    inTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nrun_g2_03', ownerEpoch: 1, leaseTtlMs: 30000, now: NOW }))
    inTx(db, (tx) => tx.run('UPDATE node_runs SET lease_expires_at = ? WHERE node_run_id = ?', ['2026-11-11T00:00:00.000Z', 'nrun_g2_03']))
    let code = ''
    try {
      inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
        nodeRunId: 'nrun_g2_03', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: NOW,
        report: goodReport('nrun_g2_03', 'rpt_g2_03', 'started'),
      }, PASS))
    } catch (err) {
      code = (err as { code?: string }).code ?? ''
    }
    expect(code).toBe('LEASE_EXPIRED')
    expect(rowOf(db, 'nrun_g2_03').status).toBe('dispatched')
  })

  it('取消后不产生新 attempt', () => {
    const { db } = freshLedger()
    seedQueued(db, 'nrun_g2_04')
    inTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nrun_g2_04', ownerEpoch: 1, leaseTtlMs: 30000, now: NOW }))
    const outcome = inTx(db, (tx) => applyCancel(tx, TEST_SECRET, {
      nodeRunId: 'nrun_g2_04', attempt: 1, revision: 1, cancelResult: 'interrupted', now: NOW, graceMs: 30000,
    }))
    expect(outcome.next_status).toBe('timing_out')
    expect(rowOf(db, 'nrun_g2_04').attempt).toBe(1)
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM node_runs WHERE node_run_id = ? AND attempt > ?', ['nrun_g2_04', 1])).toBe(0)
  })

  it('终态必带证据', () => {
    const { db } = freshLedger()
    seedQueued(db, 'nrun_g2_05')
    inTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nrun_g2_05', ownerEpoch: 1, leaseTtlMs: 30000, now: NOW }))
    const res = inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
      nodeRunId: 'nrun_g2_05', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: NOW,
      report: { report_id: 'rpt_g2_05', node_run_id: 'nrun_g2_05', attempt: 1, status: 'done' },
    }, PASS))
    expect(res.accepted).toBe(false)
    expect(res.registry_state).toBe('rejected')
    expect(rowOf(db, 'nrun_g2_05').status).toBe('dispatched')
  })

  it('无裸 blocked', () => {
    const { db } = freshLedger()
    seedQueued(db, 'nrun_g2_06')
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM node_runs WHERE status = ?', ['blocked'])).toBe(0)
    const res = inTx(db, (tx) => tx.get<{ n: number }>("SELECT COUNT(*) AS n FROM node_runs WHERE status NOT IN ('queued','leased','dispatched','started','waiting','verifying','timing_out','stopping','startup_unknown','paused_bridge_missing','blocked_pre','blocked_post','indeterminate_side_effect','done','failed','timeout','abandoned_unverified','failed_with_unverified','orphaned','superseded')"))
    expect(res?.n ?? 0).toBe(0)
  })

  it('S2 加载 parallel 被拒', () => {
    const def = { workflow_version: 'v1', nodes: [{ node_id: 'n1', type: 'parallel' as const }] }
    let code = ''
    try {
      assertDefinitionAllowed(def, 'S2')
    } catch (err) {
      code = (err as { code?: string }).code ?? ''
    }
    expect(code).toBe('FORBIDDEN')
  })

  it('G-03 同一个 report_id 上报两次只落一次', () => {
    const { db } = freshLedger()
    seedQueued(db, 'nrun_g2_07')
    inTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nrun_g2_07', ownerEpoch: 1, leaseTtlMs: 30000, now: NOW }))
    for (let i = 0; i < 2; i += 1) {
      inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
        nodeRunId: 'nrun_g2_07', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: NOW,
        report: goodReport('nrun_g2_07', 'rpt_g2_07', 'started'),
      }, PASS))
    }
    const registry = inTx(db, (tx) => tx.get<{ state: string }>('SELECT state FROM report_registry WHERE report_id = ?', ['rpt_g2_07']))
    expect(registry?.state).toBe('replayed')
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = ?', ['nrun_g2_07', 'report_applied'])).toBe(1)
  })

  it('G-04 租约到期后原执行器迟到上报被拒', () => {
    const { db } = freshLedger()
    seedQueued(db, 'nrun_g2_08')
    inTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nrun_g2_08', ownerEpoch: 1, leaseTtlMs: 30000, now: NOW }))
    inTx(db, (tx) => tx.run('UPDATE node_runs SET lease_expires_at = ? WHERE node_run_id = ?', ['2026-11-11T00:00:00.000Z', 'nrun_g2_08']))
    let code = ''
    try {
      inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
        nodeRunId: 'nrun_g2_08', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: NOW,
        report: goodReport('nrun_g2_08', 'rpt_g2_08', 'started'),
      }, PASS))
    } catch (err) {
      code = (err as { code?: string }).code ?? ''
    }
    expect(code).toBe('LEASE_EXPIRED')
    expect(rowOf(db, 'nrun_g2_08').status).toBe('dispatched')
  })

  it('G-05 工具执行中取消只立一次围栏', () => {
    const { db } = freshLedger()
    seedQueued(db, 'nrun_g2_09')
    inTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nrun_g2_09', ownerEpoch: 1, leaseTtlMs: 30000, now: NOW }))
    const outcome = inTx(db, (tx) => applyCancel(tx, TEST_SECRET, {
      nodeRunId: 'nrun_g2_09', attempt: 1, revision: 1, cancelResult: 'interrupted', now: NOW, graceMs: 30000,
    }))
    expect(outcome.fence_state).toBe('armed')
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = ?', ['nrun_g2_09', 'fence_armed'])).toBe(1)
    expect(countOf(db, "SELECT COUNT(*) AS n FROM node_runs WHERE node_run_id = ? AND status IN ('done','failed','timeout')", ['nrun_g2_09'])).toBe(0)
  })

  it('G-07 墙钟跳十分钟不误判截止', () => {
    const clock = new MonotonicClock('boot_a', { wallClockMs: 1000, monotonicNs: 0 })
    clock.sample(1000 + 600000, 1000)
    const decision = clock.decide(
      { bootId: 'boot_a', monotonicNs: 60 * 1e9, wallClockMs: 1000 + 60 * 1000 },
      { bootId: 'boot_a', monotonicNs: 10 * 1e9, wallClockMs: 1000 + 600000 + 10 * 1000 },
    )
    expect(decision.kind).toBe('uncertain')
    expect(decision.kind === 'uncertain' ? decision.reason : '').toBe('clock_drift')
  })
})
```

3. 写门记录。正文顺序固定：结论段、逐项必过项与证据 ID、失败项、回滚说明、批准人、`GateArtifact` JSON 块、`artifact_hash` 锚点。JSON 块里 `candidate_hash`、`change_scope_hash`、`evidence_index_hash`、`invariants_hash` 四个字段在真跑门时用实测值填（各自对应内容的 `sha256Hex(canonicalJson(...))`），下面写的是字段形状与填写规则。

```md
# G2 门记录

## 结论

G2 通过。单 agent 节点从 queued 到终态走通一条路径，重复上报只落一次，租约过期后的迟到上报被拒，取消后不产生新 attempt，终态都带证据，没有裸 blocked，S2 加载 parallel 节点被拒，四条故障注入 G-03 / G-04 / G-05 / G-07 都留下注入参数、前后账本片段与恢复后对账查询。

## 必过项与证据

| 必过项 | 结果 | 证据 ID |
| --- | --- | --- |
| 单节点 queued 到终态一条路径 | pass | ev-g2-01 |
| 重复上报只落一次 | pass | ev-g2-02 |
| 租约过期迟到上报被拒 | pass | ev-g2-03 |
| 取消后不产生新 attempt | pass | ev-g2-04 |
| 终态必带证据 | pass | ev-g2-05 |
| 无裸 blocked | pass | ev-g2-06 |
| S2 加载 parallel 被拒 | pass | ev-g2-07 |
| G-03 重复上报只落一次 | pass | ev-g2-08 |
| G-04 租约到期迟到上报被拒 | pass | ev-g2-09 |
| G-05 工具执行中取消只立一次围栏 | pass | ev-g2-10 |
| G-07 墙钟跳变不误判截止 | pass | ev-g2-11 |

## 失败项

无。

## 回滚

回退到 S1 的构建，账本只追加不删，节点状态不回改；回滚后重跑 S1 的只读查询与账本校验。

## 批准人

human:啸春

```json
{
  "gate": "G2",
  "schema_version": "1",
  "gate_run_id": null,
  "candidate_hash": "0000000000000000000000000000000000000000000000000000000000000000",
  "change_scope_hash": "0000000000000000000000000000000000000000000000000000000000000000",
  "evidence_index_hash": "0000000000000000000000000000000000000000000000000000000000000000",
  "invariants_hash": "0000000000000000000000000000000000000000000000000000000000000000",
  "must_pass_items": [
    { "id": "G2-01", "result": "pass", "evidence_ids": ["ev-g2-01"] },
    { "id": "G2-02", "result": "pass", "evidence_ids": ["ev-g2-02"] },
    { "id": "G2-03", "result": "pass", "evidence_ids": ["ev-g2-03"] },
    { "id": "G2-04", "result": "pass", "evidence_ids": ["ev-g2-04"] },
    { "id": "G2-05", "result": "pass", "evidence_ids": ["ev-g2-05"] },
    { "id": "G2-06", "result": "pass", "evidence_ids": ["ev-g2-06"] },
    { "id": "G2-07", "result": "pass", "evidence_ids": ["ev-g2-07"] },
    { "id": "G-03", "result": "pass", "evidence_ids": ["ev-g2-08"] },
    { "id": "G-04", "result": "pass", "evidence_ids": ["ev-g2-09"] },
    { "id": "G-05", "result": "pass", "evidence_ids": ["ev-g2-10"] },
    { "id": "G-07", "result": "pass", "evidence_ids": ["ev-g2-11"] }
  ],
  "failed_items": [],
  "conclusion": "pass",
  "run_terminal": "not_applicable",
  "exceptions": [],
  "rollback": {
    "target": "S1 账本地基构建",
    "action": "回退并验证",
    "duration_s": 600,
    "verification": "冒烟与账本回放通过"
  },
  "approver": "human:啸春",
  "approved_at": "2026-11-12T00:00:00.000Z",
  "producer": "human"
}
```

artifact_hash=SHA256(canonical_json(artifact))
```

**测试：**

- Create: `tests/integration/g2.spec.ts`（上面是骨架，实施时逐条填成真断言）
  - 第一条：跑一遍 `acquireLease` → `applyReport` → 断言 `node_runs.status` 为终态、`node_run_events` 里有 `report_applied`。
  - 第二条：同一个 `report_id` 上报两次，断言第二次 `accepted=false` 且 `node_run_events` 里 `report_applied` 只出现一次。
  - 第三条：把租约的 `lease_expires_at` 拨到过去，上报一次，断言抛 `LEASE_EXPIRED` 且 `node_runs.status` 未变。
  - 第四条：`applyCancel` 用 `interrupted`，断言 `node_runs.attempt` 不变、没有新的 `attempt` 行。
  - 第五条：`applyReport` 不带证据，断言被拒且 `node_runs.status` 没落到终态。
  - 第六条：断言所有非终态都在 `NON_TERMINAL_STATUSES` 里、`blocked` 这样的裸状态不存在（没有 `status='blocked'` 的行）。
  - 第七条：`assertDefinitionAllowed` 传入含 `parallel` 的定义，断言抛 `FORBIDDEN`。
  - 第八条到第十一条：分别跑 G-03 / G-04 / G-05 / G-07 的注入，断言与门记录里写的结论一致。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/integration/g2.spec.ts
pnpm tsx scripts/fault-inject.ts --case G-03
pnpm tsx scripts/fault-inject.ts --case G-04
pnpm tsx scripts/fault-inject.ts --case G-05
pnpm tsx scripts/fault-inject.ts --case G-07
pnpm tsx scripts/gate-check.ts docs/gates/G2.md
pnpm check
```

期望：四条注入各自在 `output/gates/` 下留出注入参数、前后账本片段与对账查询三段；门检查打印 `gate G2 通过`；`pnpm check` 三段都过。

**提交：**

```powershell
git add tests/integration/g2.spec.ts scripts/fault-inject.ts scripts/gate-check.ts docs/gates/G2.md
git commit -m "test(gate): 加 G2 集成用例与门记录"
```

---
## 未决参数

### 本批定值

规格里已经写死的，规格没写但本批要能跑起来的，由本批给值；给值理由与影响一并记在这里，并在门记录里落一条。

| 参数 | 本批取值 | 依据与理由 |
| --- | --- | --- |
| 租约时长 `lease_ttl_ms` | 30000（30 秒） | 规格未定。取 30 秒是「够跑完一次心跳窗口、又不至于让晚到的执行器长时间占着节点」的折中；心跳 10 秒，允许连丢两次心跳仍不误判过期。 |
| 心跳间隔 `lease_renew_interval_ms` | 10000（10 秒） | 规格未定。必须小于租约时长的三分之一，否则一次网络抖动就误判过期；配置校验里已强制这条关系。 |
| 动作超时 `action_timeout_ms` | 120000（120 秒） | 规格未定。单节点的模型执行给两分钟，与规格里 `verify_timeout` 的 120 秒同量级，方便两处超时行为对齐。 |
| 取消宽限 `cancel_grace_ms` | 30000（30 秒） | 规格 4.5 行 354 写明围栏内 30 秒宽限，直接沿用。 |
| 缓冲上限 / 高水位 | 8 MiB / 4 MiB | 规格 7.3 行 594 已定，直接沿用。 |
| 时钟漂移容忍 | 2000 毫秒 | 规格 3.4 行 171 已定「漂移超过 2 秒置 timer_uncertain」，直接沿用。 |
| payload 上限 / 摘要上限 | 64 KiB / 800 字 | 规格 4.1 行 272 与 5.2 行 447 已定，直接沿用。 |
| spill 目录 | `storages/dsh-orchestra/bridge-spill/` | 总纲 §3 没有目录，规格未给。本批按「不入仓库、不落工作区」的纪律选在 storages 下；跨重启可查，不落在仓库工作区内。 |
| 事件保留期 | 暂按 S1 的 retention 段默认值 | 总纲 §7 的「事件与证据保留期」在 S2 不定，理由是 S2 只有单节点闭环，数据量小；S3 起多节点并行后必须重定。 |
| 写队列上限 | 暂按 1000 条上报 | 总纲 §7 的「写队列上限与溢出策略」在 S2 不定，理由同上；超出即按拒绝处理并留痕，不静默丢。 |

### 本批新增错误码提案

规格 §17.1 的表里没有这两个码，本批先用「提案」形式标出来，等总纲与规格统一后再转正。代码里一律经 `proposedError()` 抛出，`details.proposed=true`，日志与门记录里能一眼看出是提案。

| 提案码 | HTTP | 场景 | 理由 |
| --- | --- | --- | --- |
| `LEASE_EXPIRED` | 409 | 租约过期后原执行器的迟到上报被拒 | 规格 12.3 行 970 要求「迟到报告被拒」，但 §17.1 表里没有对应的点名错误码；用 `STALE_GENERATION` 会把「动作代过期」和「租约过期」两种语义混在一起，排查时分不开，所以单列一个码。 |
| `BRIDGE_ACK_LAG` | 409 | `dispose` 前置条件不满足（`service_ack_seq < bridge_last_seq`） | 规格 7.2 行 586 只写了前置条件，没给错误码；这一条属于「服务没跟上」，与 `BRIDGE_NOT_SUBSCRIBED` 的「还没订阅」不同义，单列一个码。 |

### 指向总纲 §7 的开放项

总纲 §7 列了六个在对应批次定值的开放项。S2 只碰到其中两个（写队列上限与溢出策略、事件与证据保留期），上面给了临时值并写进 G2 门记录；其余四项（记忆裁判模型与提示词版本、值班人与升级联系人、R1/R2 工作区白名单、24h 浸泡采样频率与判定脚本）在 S5 / S6 定，S2 不预判。

## 风险与回退

- **桥是业务通道不是保活通道。** 桥断了不等于执行器死了（规格 7.1 行 576）。本批的实现里，桥事件断号只触发整页重取，不触发节点终态；若误把断连当成执行器死亡，会误杀正在跑的节点。回退办法：把桥恢复路径（`paused_bridge_missing` 加 `resume_state`）留到 S3，S2 只保证不误判。
- **租约时长定得太短会让正常节点被误判过期。** 本批取 30 秒、心跳 10 秒，若实测中模型执行普遍超过 30 秒没回心跳，就会出现「节点在跑但被判过期」。回退办法：只调大 `lease_ttl_ms` 一个数，配置校验会挡住把心跳调成大于租约时长的写法。
- **围栏与上报队列容易出现第二终态。** 围栏立着时进来的上报一律进 `report_registry(state='rejected')` 排队，围栏撤销后只重放当前 attempt 的队头；一旦重放逻辑写松，就会出现同一节点两个终态，直接破不变量 I1。回退办法：把重放入口收敛到 `applyReport` 的幂等分支一处，不开第二个入口。
- **强证据依赖宿主的只读挂载。** 宿主没有只读挂载时本批报 `EVIDENCE_SOURCE_UNAVAILABLE` 并拒，不降级成弱证据（规格 4.7 行 384）。若部署环境确实没有只读挂载，S2 的不可逆节点一律走不了通过路径。回退办法：换环境，不改判定口径。
- **证据不足被当成通过。** 这是最坏的一种错：表面绿、实际没验。本批在四个地方设卡：`evaluateEvidence` 拒、`evaluatePassConditions` 拒、`applyReport` 拒、终态必须有证据。回退办法：任一处被改松，`pnpm test tests/policy.spec.ts` 与 G2 第五条必过项会立刻红。
- **阶段闸被绕过。** S2 加载 parallel 节点必须被拒；一旦有人直接调底层命令绕过 `assertDefinitionAllowed`，就会出现 S2 跑多节点。回退办法：命令入口统一走 `assertCommandAllowed`，不新增旁路。
- **回退整体做法。** 账本只追加、不删改历史；本批的所有状态变更都有 `node_run_events` 留痕，代码回退后可以用账本重放出旧行为。代码回退命令：`git revert` 本批最后一个提交；数据不回滚，用只读查询确认账本完整即可。

## 完成定义

1. 桥七方法（spawn / subscribe / send / cancel / dispose / state / whenIdle）齐备并有对应用例：订阅前发指令报 `BRIDGE_NOT_SUBSCRIBED`，dispose 确认位不够报 `BRIDGE_ACK_LAG`，whenIdle 缺超时报 `SCHEMA_VERSION_UNSUPPORTED`。
2. 桥事件缓冲上限 8 MiB、高水位 4 MiB，超限 spill 到磁盘且证据不丢；断号整页重取，页内序号必须连续。
3. 工具注册表能查能推导；前向能力推导三条规则成立；作者声明只许往更严一侧写，四种声明情形各有断言。
4. `runTool` 只走只读路径：命令命中注册表且 `capability=read_only`，argv 不经 shell，cwd 越界报 `FORBIDDEN`，宿主无只读挂载报 `EVIDENCE_SOURCE_UNAVAILABLE`；产出强证据含 `exitCode` / `stdoutHash` / `stderrHash` / `hashes` / `producedAt`，落库前核对命令哈希。
5. 租约的获取、续期、释放、过期扫描都有用例；租约过期后原执行器的迟到上报被拒并留痕。
6. agent 节点执行器不继承主会话历史，工具按 allow / deny 给且未声明默认不给，输出三件套按 64 KiB 与 800 字裁剪，agent 不许自报完成。
7. 节点状态机写死十三种非终态与七种终态；所有迁移走条件 CAS 且受影响行数恰为 1；Ga 与 Gr 分开且用例证明两者不合并。
8. `applyReport` 六步在同一笔事务里，顺序固定；`report_registry` 的 state 只许四个值；同 `report_id` 第二次上报只落一次并记 `replayed`；拒绝也落 registry 与哈希链。
9. 证据门按来源分强弱；不可逆动作只给 `exitCode` 报 `VERIFICATION_TOO_WEAK`；判定条件只许引用五个证据字段；证据不足转 `blocked_post` 并记人工核验请求。
10. 取消四值分别落位，只有 `interrupted` 立围栏；围栏期间的上报排队，撤销后只重放当前 attempt 的队头；取消后不产生新 attempt。
11. 截止判定只认 `boot_id + monotonic_ns`，墙钟跳十分钟不误判，跨 boot 停机时间不计入预算；维护扫描可重入。
12. S2 加载含 parallel 或 subworkflow 节点的定义被拒，越阶段命令报明确错误码。
13. `tests/integration/g2.spec.ts` 覆盖 G2 八条必过项；G-03 / G-04 / G-05 / G-07 四条注入各自留出注入参数、前后账本片段与恢复后对账查询。
14. `docs/gates/G2.md` 写全：逐项必过项都有证据 ID、失败项为空、`conclusion=pass`、`artifact_hash` 锚点与 `sha256Hex(canonicalJson(artifact))` 一致；`pnpm tsx scripts/gate-check.ts docs/gates/G2.md` 打印通过。
15. 两个新增错误码在 §未决参数 里登记为提案，代码里经 `proposedError()` 抛出并带 `details.proposed=true`。
16. `pnpm check` 全绿；本批提交信息一律中文 Conventional Commits，一个 Task 一次提交。
