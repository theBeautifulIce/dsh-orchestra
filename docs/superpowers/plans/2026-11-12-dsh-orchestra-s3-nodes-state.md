# S3 九节点与状态机实施计划（门 G3）

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

## Goal

把编排账本从 S2 的「单 agent 节点闭环」扩到规格 §5 的九种节点与 §4.4–§4.9 的全量状态机：每一条状态迁移都走 CAS，八种 decision 成为一等公民，审批、并行、等待、子流程、补偿各有确定语义，六个故障注入点可复现。本批只以门 G3 为出口，不碰工作流发布与面板读模型。

## Architecture

落在总纲 §3 的四层里：

- 引擎层（`src/core` + `src/service`）：`src/core/state-machine.ts` 放状态枚举、迁移表、guard 与半态时钟规则，纯函数、不引 IO（总纲 §3 领域逻辑约定）；`src/service/commands/` 下放带事务的写路径，`src/service/sweep.ts` 放恢复扫描。写路径一律经 `src/infra/sqlite/driver.ts` 的 `withTx`，每个迁移写成带 CAS 条件的单条 UPDATE（总纲 §4.4）。
- 存储层（`src/infra`）：本批只加迁移脚本 `src/infra/sqlite/migrations/NNN-*.sql`（总纲 §4.1.1）。表与列全小写下划线；`node_run_events` 哈希链按总纲 §4.3 追加。
- 执行层（`src/executor`）：S2 已有桥，本批只消费它的 RPC（spawn/subscribe/send/cancel/state/whenIdle，规格 §7），不新增桥方法。
- 接入层：本批不接面板与记忆。规格 §11.1 阶段能力表第 843 行明写 S3 禁止「workflow 发布、面板接真实账本」，面板读模型属 S5（规格 §8）。

阶段闸门按规格 §2.4（第 118–123 行）：S3 加载期必须拒绝越阶段能力，`workflow.publish` 在 S3 启动要报错；`parallel`/`subworkflow` 从 S3 起才允许加载。

## Tech Stack

总纲 §4.1 的那套，不新增依赖：TypeScript 6.0.3（ESM、NodeNext，导入写 `.ts` 后缀）、Node `^22.19.0 || >=24.0.0`、pnpm 11.7.0、vitest 4.1.8、tsdown 0.22.14、zod 4.4.3、SQLite（`node:sqlite`）。脚本：`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm check`、`pnpm gate`。

## 本批能做什么

- 九种节点（trigger/agent/tool/policy/branch/approval/parallel/wait/subworkflow）的类型注册、配置校验与运行时行为（规格 §5）。
- 全量状态迁移与 CAS：非终态十三种、终态七种（规格 §3.5 第 175-186 行）。
- 八种 decision 的生成、去重、收口、续期与超时升级（规格 §3.6 第 188-198 行）。
- 半态五格与时钟规则：startup_timeout、unknown_watchdog、verify_timeout、桥断冻结与跨 boot 剩余量重挂（规格 §4.4 第 313-342 行）。
- 取消与超时围栏、报告冲突与 uphold 收口、恢复扫描（规格 §4.5/§4.6/§4.9）。
- 补偿执行与未验证副作用落账（规格 §4.7 第 369-399 行）。
- M-01 到 M-61 的迁移用例与六个故障注入（G-01/G-02/G-04/G-06/G-12/G-16）。

## 本批不能做什么

规格 §11.1 阶段能力表（第 843 行）原文：

> | S3 | 九节点、状态机、补偿 | workflow 发布、面板接真实账本 |

据此本批明确不做：

1. 不实现 workflow 四命令与发布事务，不建 `workflow_versions`/`workflow_drafts` 表（S4，门 G4）。
2. 不做面板读模型与任何读查询接口；面板不接真实账本（规格 §8 属 S5）。
3. 不做记忆写入链路（memory_* 四表与写入端口属 S5/S6）。
4. 不做 `wf_release_v1` 发布包、值班手册与升级回滚（S6，门 G6）。
5. 不做 R1/R2 受控圈。

## 门 G3 必过项

规格 §11.2 第 947 行原文：

> G3 必过：M-01 到 M-61 全过、非法迁移全拒、并发只有一个赢家、并行扇出与汇聚一致、子流程环与深度拒、补偿不重复、取消向子 run 传播、G-01 / G-02 / G-04 / G-06 / G-12 / G-16。

逐条落到本批任务：

| 必过项 | 覆盖任务 |
| --- | --- |
| M-01 到 M-61 全过 | Task 1–13 的用例集，Task 14 汇总 |
| 非法迁移全拒 | Task 1（guard）、Task 2（CAS 拒绝无副作用） |
| 并发只有一个赢家 | Task 2（CAS）、Task 14（G-12 双击） |
| 并行扇出与汇聚一致 | Task 8 |
| 子流程环与深度拒 | Task 10 |
| 补偿不重复 | Task 11 |
| 取消向子 run 传播 | Task 10（子 run 取消）、Task 14（G-16） |
| G-01 / G-02 / G-04 / G-06 / G-12 / G-16 | Task 14（scripts/fault-inject.ts） |

门记录按规格 §11.3（第 862–893 行）：G1 到 G5 的独立 artifact 都是无 run 门（`gate_run_id=null`、`run_terminal=not_applicable`、`producer=human`），正文结论后固定锚点 `artifact_hash=SHA256(canonical_json(artifact))`（总纲 §4.5）。

## 未决参数

规格没定、必须走总纲 §7 的项，本批只登记不发明：

1. 写队列上限与溢出策略（总纲 §7 第 1 项；G-08 要用，本批只在 G3 记录里标注沿用 S1 默认）。
2. 事件与证据保留期（总纲 §7 第 2 项；影响终态证据与 artifact 的「已过保留期」显示）。
3. 值班人与升级联系人（总纲 §7 第 4 项；G3 人工门的 `approver` 需要它）。
4. 记忆裁判模型与提示词版本（总纲 §7 第 3 项）、R1/R2 工作区白名单（第 5 项）、24h 浸泡采样频率与判定脚本（第 6 项）——本批不涉及，登记以示边界。

另有两条实现层未决，写在计划里提醒实现者对齐上游批次：

- `OrchError` 的构造签名以 S1 落地的 `src/core/errors.ts` 为准；本计划按 `new OrchError({ code, message, retryable, details })` 书写（总纲 §4.2 的字段口径）。
- 迁移脚本编号接续既有迁移（假定 S1/S2 用到 009，本批从 010 起；实际不同则顺延），路径按总纲 §4.1.1 放 `src/infra/sqlite/migrations/NNN-name.sql`。

## 任务

### Task 1：迁移表与 guard 规则

目标：把规格 §3.5、§4.4、§4.5 的状态集合与迁移条件收敛成一份纯函数规则表，非法迁移在领域层就被拒。

**Files:**

- `src/core/state-machine.ts` — 状态枚举、迁移规则表、guard 判定（新建）
- `tests/state-machine.spec.ts` — 迁移表逐行用例（新建）

步骤：

1. 新建 `src/core/state-machine.ts`，写状态与 decision 类型。终态七种与非终态十三种严格照规格 §3.5：

```ts
export type NodeRunStatus =
  | 'queued' | 'leased' | 'dispatched' | 'started' | 'waiting' | 'verifying'
  | 'timing_out' | 'stopping' | 'startup_unknown' | 'paused_bridge_missing'
  | 'blocked_pre' | 'blocked_post' | 'indeterminate_side_effect'
  | 'done' | 'failed' | 'timeout' | 'abandoned_unverified'
  | 'failed_with_unverified' | 'orphaned' | 'superseded';

export const TERMINAL_STATUSES: readonly NodeRunStatus[] = [
  'done', 'failed', 'timeout', 'abandoned_unverified',
  'failed_with_unverified', 'orphaned', 'superseded',
];

export type DecisionKind =
  | 'pre_execution' | 'action_overrun' | 'abandon_ack' | 'verify_human'
  | 'audit_result' | 'rule_ambiguous' | 'startup_unknown' | 'report_contradicted';

export type TransitionContext = {
  status: NodeRunStatus;
  attempt: number;
  actionGeneration: number;
  rearmGeneration: number;
  hasToolCall: boolean;
  cancelResult: 'interrupted' | 'not_interruptible' | 'already_stopped' | 'unknown' | null;
  hangReason: 'report_contradicted' | null;
};
```

2. 在同一文件写 guard：

```ts
export type TransitionRule = {
  from: readonly NodeRunStatus[];
  to: NodeRunStatus;
  requires?: (ctx: TransitionContext) => boolean;
};

export function allows(rule: TransitionRule, ctx: TransitionContext): boolean {
  if (!rule.from.includes(ctx.status)) return false;
  if (TERMINAL_STATUSES.includes(ctx.status)) return false;   // I1：终态不再接受普通出口
  if (ctx.hangReason !== null) return false;                  // §4.6：冲突挂起时普通出口一律拒
  return rule.requires?.(ctx) ?? true;
}
```

3. 把 M-01…M-61 的迁移条件写成 `TRANSITIONS: readonly TransitionRule[]`，每条规则的 `from` 与 `to` 必须与设计稿 L327 起的迁移表逐行对齐；guard 条件只允许用 `requires` 表达（如 `requires: (ctx) => ctx.cancelResult === 'interrupted'`）。

4. 新建 `tests/state-machine.spec.ts`：对 `TRANSITIONS` 里每条规则做正反两面断言——合法上下文 `allows` 为 true，缺前置条件的上下文为 false。

测试：

- `tests/state-machine.spec.ts`：断言每条迁移的正例通过；断言「已终态行再迁移」被拒；断言 `hangReason='report_contradicted'` 时所有普通出口被拒；断言 `requires` 缺条件时返回 false。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：typecheck 无错；vitest 全绿，state-machine.spec.ts 用例数等于 TRANSITIONS 条数加 4 条守卫用例。

提交：`feat(core): 建立 node_run 状态机迁移表与 guard 规则`

### Task 2：node_run 表结构与 CAS 迁移执行器

目标：把迁移表落成数据库里的单条 CAS UPDATE，受影响行数不为 1 一律回滚。

**Files:**

- `src/infra/sqlite/migrations/010-node-run-transitions.sql` — node_runs 补列与唯一索引（新建）
- `src/service/commands/nodes.ts` — CAS 迁移执行器（新建）
- `tests/node-runs.spec.ts` — CAS 命中与拒绝用例（新建）

步骤：

1. 新建迁移脚本 `src/infra/sqlite/migrations/010-node-run-transitions.sql`：补 `action_generation`、`rearm_generation`、`hang_reason`、`contradiction_decision_id`、`startup_unknown_remaining_ns`、`verify_remaining_ns` 列（规格 §3.4 第 159-173 行；schema_version=2，两个新列可空且不回填），并建唯一索引 `UNIQUE(run_id, node_id, attempt)` 与 `node_runs_origin_uq(origin_node_run_id)`（M-58 断言）。

2. 新建 `src/service/commands/nodes.ts`，写执行器。CAS 条件至少含 attempt，dispatch/started/收口类再带 action_generation（总纲 §4.4）：

```ts
import { OrchError } from '../../core/errors.ts';
import type { Tx } from '../../infra/sqlite/driver.ts';
import type { NodeRunStatus } from '../../core/state-machine.ts';

export type TransitionRequest = {
  nodeRunId: string;
  from: readonly NodeRunStatus[];
  to: NodeRunStatus;
  attempt: number;
  actionGeneration?: number;
  rearmGeneration?: number;
  patch?: Readonly<Record<string, string | number | null>>;
};

export function applyTransition(tx: Tx, req: TransitionRequest): void {
  const columns = Object.keys(req.patch ?? {});
  const setSql = ['status = ?', 'revision = revision + 1']
    .concat(columns.map((c) => c + ' = ?')).join(', ');
  const whereSql = ['node_run_id = ?', 'status IN (' + req.from.map(() => '?').join(', ') + ')',
    'attempt = ?', 'hang_reason IS NULL'];
  const binds: unknown[] = [req.nodeRunId].concat(req.from).concat([req.attempt]);
  if (req.actionGeneration !== undefined) { whereSql.push('action_generation = ?'); binds.push(req.actionGeneration); }
  const values: unknown[] = [req.to].concat(columns.map((c) => (req.patch as Record<string, unknown>)[c]));
  const res = tx.prepare('UPDATE node_runs SET ' + setSql + ' WHERE ' + whereSql.join(' AND '))
    .run(...values, ...binds);
  if (res.changes !== 1) {
    throw new OrchError({ code: 'STALE_GENERATION', message: 'node_run 迁移 CAS 未命中',
      retryable: true, details: { nodeRunId: req.nodeRunId, to: req.to } });
  }
}
```

3. 在 `applyTransition` 同文件加 `createNodeRun`：新建行时写 `origin_node_run_id`/`attempt=旧+1`，旧行回写 `replacement_node_run_id`（M-58）。

4. `tests/node-runs.spec.ts`：用 S1 的 `openDb`+`execSchema` 开临时库，断言 CAS 命中一次只影响一行；断言旧 attempt 的迟到写影响 0 行并抛 `STALE_GENERATION`，且事务内其他写被回滚。

测试：

- `tests/node-runs.spec.ts`：断言同 `(run_id,node_id,attempt)` 换 node_run_id 插入被唯一索引拒；断言 `hang_reason` 非空时迁移被拒；断言 `changes !== 1` 时抛 OrchError 且无副作用。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿；node-runs.spec.ts 覆盖 CAS 命中、迟到写被拒、唯一索引三条断言。

提交：`feat(service): 落地 node_run 的 CAS 迁移执行器`

### Task 3：八种 decision 的生成与唯一性

目标：把 decision 做成表里的一等行，同 `(node_run, kind)` 只留一行。

**Files:**

- `src/infra/sqlite/migrations/011-decisions.sql` — decisions 表与 partial unique index（新建）
- `src/service/commands/decisions.ts` — decision 生成与查重（新建）
- `tests/decisions.spec.ts` — 八种 kind 与唯一性用例（新建）

步骤：

1. 新建 `src/infra/sqlite/migrations/011-decisions.sql`：`decisions` 表含 `decision_id`、`run_id`、`node_run_id`、`kind`、`status`、`revision`、`closed_reason`、`payload_json`、`created_at`、`decided_at`；建两个 partial unique index（规格 §3.6：NULL 不参与普通 UNIQUE）：`(run_id, kind) WHERE node_run_id IS NULL` 与 `(node_run_id, kind) WHERE node_run_id IS NOT NULL`。

2. 新建 `src/service/commands/decisions.ts`，写生成入口：

```ts
import { OrchError } from '../../core/errors.ts';
import type { Tx } from '../../infra/sqlite/driver.ts';
import type { DecisionKind } from '../../core/state-machine.ts';

export type DecisionDraft = {
  decisionId: string;
  runId: string;
  nodeRunId: string | null;
  kind: DecisionKind;
  payload?: Record<string, unknown>;
};

export function openDecision(tx: Tx, draft: DecisionDraft): void {
  const dup = tx.prepare(
    'SELECT decision_id FROM decisions WHERE run_id = ? AND kind = ? ' +
    'AND ((node_run_id IS NULL AND ? IS NULL) OR node_run_id = ?) ' +
    "AND status IN ('pending', 'acknowledged', 'blocked_for_human') LIMIT 1",
  ).get(draft.runId, draft.kind, draft.nodeRunId, draft.nodeRunId);
  if (dup) {
    throw new OrchError({ code: 'RESOLUTION_NOT_AVAILABLE', message: '同一 kind 已有活跃 decision',
      retryable: false, details: { decisionId: dup.decision_id, kind: draft.kind } });
  }
  tx.prepare('INSERT INTO decisions (decision_id, run_id, node_run_id, kind, status, revision, payload_json, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(draft.decisionId, draft.runId, draft.nodeRunId,
    draft.kind, 'pending', JSON.stringify(draft.payload ?? {}), Date.now());
}
```

3. 在同文件实现八种 kind 的产生点函数：`pre_execution`（irreversible 前置审批）、`action_overrun`（动作超时未确认停止）、`abandon_ack`（放弃跟踪的确认）、`verify_human`（verify_timeout 到点）、`audit_result`（记忆审批）、`rule_ambiguous`（branch 全不命中）、`startup_unknown`（unknown_watchdog 到点）、`report_contradicted`（迟到报告与人裁决冲突）。产生点只写 decision 行与事件，节点迁移交给调用方。

4. `tests/decisions.spec.ts`：逐个 kind 建一行并断言 status='pending'、revision=1；断言重复同 kind 触发 `RESOLUTION_NOT_AVAILABLE`；断言 run 级 kind（`node_run_id` 为 NULL）与节点级 kind 各自由不同索引约束。

测试：

- `tests/decisions.spec.ts`：断言八种 kind 全部可建行；断言同 `(node_run_id, kind)` 第二次建行被拒且事务回滚；断言 `node_run_id` 为 NULL 的两条不同 kind 行不冲突。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿；decisions.spec.ts 覆盖八种 kind 与两条唯一性断言。

提交：`feat(service): 生成八种 decision 并约束唯一性`

### Task 4：decision 收口、续期与超时升级

目标：把「结论落地」「继续等」「到期升级」三条路径写成同事务的状态变更。

**Files:**

- `src/service/commands/decisions.ts` — 收口与升级逻辑（修改）
- `tests/decisions.spec.ts` — 收口、续期、升级用例（修改）

步骤：

1. 在 `src/service/commands/decisions.ts` 加 `resolveDecision`：只接受 approved/rejected/expired 三种结论，落地同事务把 status 置结论并写 `closed_reason='resolved'`（expired 写 `expired_final`）；CAS 带 revision：

```ts
export type Resolution =
  | 'approved' | 'rejected' | 'expired'
  | 'confirm_applied' | 'confirm_not_applied' | 'confirm_started' | 'confirm_not_started'
  | 'continue_tracking' | 'continue_wait' | 'abandon'
  | 'uphold_report' | 'uphold_decision';

export function resolveDecision(tx: Tx, args: {
  decisionId: string; revision: number; resolution: Resolution; payload?: Record<string, unknown>;
}): void {
  const closing = args.resolution === 'approved' || args.resolution === 'rejected' || args.resolution === 'expired';
  const status = closing ? args.resolution : 'pending';
  const closedReason = closing ? (args.resolution === 'expired' ? 'expired_final' : 'resolved') : null;
  const res = tx.prepare(
    'UPDATE decisions SET status = ?, closed_reason = ?, revision = revision + 1, decided_at = ? ' +
    "WHERE decision_id = ? AND revision = ? AND status IN ('pending', 'acknowledged', 'blocked_for_human')",
  ).run(status, closedReason, closing ? Date.now() : null, args.decisionId, args.revision);
  if (res.changes !== 1) {
    throw new OrchError({ code: 'DECISION_REVISION_CONFLICT', message: 'decision 已被收口',
      retryable: false, details: { decisionId: args.decisionId } });
  }
}
```

2. 加 `extendDecision`：`continue_wait`/`continue_tracking` 只在同一行追加一条 revision 并把 `revision` 加一，status 保持 pending/acknowledged（规格 §3.6）。

3. 加 `escalateDecisions`：满 2 小时未决升级 `blocked_for_human`，再满 24 小时 `expired`；`report_contradicted` 不参与升级（规格 §3.6 原文）。

4. `tests/decisions.spec.ts`：断言过期升级的两次状态变化与时间边界；断言 `report_contradicted` 24 小时后仍是 `blocked_for_human` 而非 expired；断言 `continue_wait` 后 status 不变、revision 加一。

测试：

- `tests/decisions.spec.ts`：断言 revision 不匹配时报 `DECISION_REVISION_CONFLICT` 且行未变；断言 `continue_wait` 后行仍是 pending；断言 2h/24h 升级顺序。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(service): 收口 decision 并处理超时升级`

### Task 5：半态与单调时钟截止判定

目标：所有截止判定只读 boot_id 与 monotonic_ns，墙钟跳变不误判超时。

**Files:**

- `src/core/state-machine.ts` — 半态枚举与剩余量计算（修改）
- `src/infra/service-state.ts` — boot_id 与 monotonic 基准（修改）
- `tests/clock.spec.ts` — 跨 boot 剩余量与冻结矩阵（新建）

步骤：

1. 在 `src/core/state-machine.ts` 加半态类型与剩余量计算，公式照规格 §4.4：

```ts
export type HalfState =
  | 'blocked_pre' | 'blocked_post' | 'stopping'
  | 'indeterminate_side_effect' | 'startup_unknown';

export type BootClock = { bootId: string; startedAtMs: number; startedMonotonicNs: number };

export function remainingNs(prev: {
  deadlineMonotonicNs: number; lastEventMonotonicNs: number; lastEventAtMs: number;
}, current: BootClock): number {
  return (prev.deadlineMonotonicNs - prev.lastEventMonotonicNs)
    - (current.startedAtMs - prev.lastEventAtMs);
}
```

2. 在 `src/infra/service-state.ts` 暴露当前 boot 的 `bootId`、`startedAtMs`、`startedMonotonicNs`，进程重启即换 bootId。

3. 在 `src/core/state-machine.ts` 写 `bridgeClockPolicy`：返回某只钟在桥断期间是「继续走」「暂停并冻结 remaining」还是「暂停不累计」（规格 §4.4 的桥断时钟矩阵）：startup_timeout 与 action_deadline 继续走，unknown_watchdog 与 verify_timeout 暂停并冻结 remaining，timing_out 的 30 秒宽限暂停不累计。

4. `tests/clock.spec.ts`：用固定输入断言跨 boot 剩余量公式；断言墙钟前后跳十分钟不改变剩余量；断言桥断时 unknown_watchdog 的 remaining 冻结、startup_timeout 的 remaining 继续递减。

测试：

- `tests/clock.spec.ts`：断言 `remainingNs` 在给定三组数值上等于手工计算结果；断言冻结策略四行矩阵；断言漂移超过 2 秒时置 `timer_uncertain` 并不判超时。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(core): 引入半态与单调时钟截止判定`

### Task 6：审批往返与不可逆动作前置审批

目标：把 approval 节点与 irreversible 前置审批做成 decision 驱动的两段迁移。

**Files:**

- `src/service/commands/nodes.ts` — blocked_pre 往返（修改）
- `src/service/commands/decisions.ts` — 审批结论回写（修改）
- `tests/approval.spec.ts` — 审批往返与租约释放（新建）

步骤：

1. 在 `src/service/commands/nodes.ts` 实现 `enterBlockedPre`：写 `resume_state='queued'`、清 `lease_id`、释放 slot，CAS 带 attempt 与 action_generation（M-39 断言）。

2. 实现 `resumeFromBlockedPre`：批准后回 queued，前置条件是 `lease_id IS NULL`，不复用旧租约（M-40 断言）；拒绝或超时默认动作走 failed（M-41）。

3. 在 `src/service/commands/decisions.ts` 接审批收口：批准 payload 默认空对象，只有异常出口才要求 resolution（规格 §5.6）；不可逆动作在派发前自动开 `pre_execution` decision。

4. `tests/approval.spec.ts`：断言进入 blocked_pre 后 `lease_id` 为 NULL、slot 已释放；断言批准后 attempt 不变、状态回 queued；断言拒绝落 failed 且 decision_id 落库。

测试：

- `tests/approval.spec.ts`：断言 `lease_id` 非空时不允许重新排队；断言同 operation_id 重放回执只落一次（G-12 前半）。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(service): 实现审批往返与不可逆前置审批`

### Task 7：policy 求值与 branch 路由

目标：policy 只做声明式判定，branch 只做路由与多命中报错。

**Files:**

- `src/core/policy.ts` — 声明式求值器（新建）
- `src/service/commands/nodes.ts` — branch 路由与 policy 收口（修改）
- `tests/policy.spec.ts` — 算子白名单与输出形状（新建）
- `tests/branch.spec.ts` — 多命中与全不命中（新建）

步骤：

1. 新建 `src/core/policy.ts`，只允许白名单算子与显式 and/or/not，不许 eval/脚本/读文件：

```ts
export type PolicyOperator =
  | 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'match';

export type PolicyCondition =
  | { all: readonly PolicyCondition[] }
  | { any: readonly PolicyCondition[] }
  | { not: PolicyCondition }
  | { path: string; op: PolicyOperator; value?: unknown };

export type PolicyOutcome = {
  schema_version: 1;
  matched: boolean;
  ruleId: string | null;
  decision: 'pass' | 'fail';
  must_pass_items: { id: string; result: boolean; evidence_ids: string[] }[];
  failed_items: string[];
  evidence_ids: string[];
  reason: string;
};
```

2. 实现 `evaluatePolicy(conditions, input)`：返回上面的固定形状；payload 超限截断并记录，不许静默丢字段（规格 §4.1）。

3. 在 `src/service/commands/nodes.ts` 接 policy 收口：每次求值追加 `policy.evaluated` 到 `node_run_events`，不镜像进 events；artifact 固定 none。

4. 在同文件实现 branch 路由：出边必须带 `route.priority`（0–999）或 `route.default=true`；运行期多命中抛 `BRANCH_AMBIGUOUS`；全不命中且无 default 时进 `blocked_post` 并生成 `rule_ambiguous` decision。

5. `tests/policy.spec.ts` 与 `tests/branch.spec.ts`：断言九种算子各自行为；断言非法算子被拒；断言多命中与全不命中两条路径。

测试：

- `tests/policy.spec.ts`：断言输出字段齐全且 `artifact` 固定 none；断言 `must_pass_items` 的 evidence_ids 与输入一致。
- `tests/branch.spec.ts`：断言多命中抛 `BRANCH_AMBIGUOUS` 且节点状态未变；断言无 default 全不命中生成 `rule_ambiguous` 并落 blocked_post。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(core): 实现 policy 声明式求值与 branch 路由`

### Task 8：并行扇出与汇聚

目标：parallel 节点按 all/any/quorum 汇聚，并把未收口的不可逆子节点留在派生集合里。

**Files:**

- `src/service/commands/parallel.ts` — 扇出、汇聚与派生集合（新建）
- `src/service/commands/nodes.ts` — 取消按副作用分级（修改）
- `tests/parallel.spec.ts` — 三种 join 模式与取消分级（新建）

步骤：

1. 新建 `src/service/commands/parallel.ts`，定义 join 模式与子节点集合：

```ts
export type JoinMode = 'all' | 'any' | 'quorum';

export type ParallelGroup = {
  nodeRunId: string;
  mode: JoinMode;
  quorum?: number;
  childNodeRunIds: string[];
  allowIrreversibleChildren: boolean;
};

export function isGroupSettled(group: ParallelGroup, children: {
  nodeRunId: string; status: string; sideEffectPolicy: 'pure' | 'compensable' | 'irreversible';
}[]): boolean {
  const own = children.filter((c) => group.childNodeRunIds.includes(c.nodeRunId));
  const ok = (c: { status: string }) => ['done', 'failed', 'timeout', 'abandoned_unverified',
    'failed_with_unverified', 'orphaned', 'superseded'].includes(c.status);
  if (group.mode === 'any') return own.some(ok);
  if (group.mode === 'quorum') {
    const need = group.quorum ?? Math.floor(own.length / 2) + 1;
    return own.filter((c) => c.status === 'done').length >= need;
  }
  return own.every(ok);
}
```

2. 实现 `pendingIrreversibleChildren` 派生：集合非空时运行不得 succeeded/failed，留 settling 并拦后继派发（规格 §5.7 与 §4.8）。

3. 实现取消分级：irreversible 子节点不许取消；其余按子节点副作用等级决定是否发 cancel。

4. `tests/parallel.spec.ts`：断言三种 join 模式的收敛条件；断言有不可逆子节点在跑时父运行停在 settling；断言取消不触及不可逆子节点。

测试：

- `tests/parallel.spec.ts`：断言 any 模式首个 done 即收敛；断言 quorum 计数只认 done；断言 pending 集合非空时运行状态不是终态。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(service): 实现并行扇出与汇聚`

### Task 9：等待节点与事件唤醒

目标：wait 节点先落 inbox 再匹配，唤醒幂等，重复唤醒只落一条。

**Files:**

- `src/infra/sqlite/migrations/012-wait-registrations.sql` — wait_registrations 表（新建）
- `src/service/commands/nodes.ts` — wait 注册与唤醒（修改）
- `tests/wait.spec.ts` — 事件早到与重复唤醒（新建）

步骤：

1. 新建迁移 `src/infra/sqlite/migrations/012-wait-registrations.sql`：`wait_registrations` 表含 `node_run_id`、`run_id`、`wait_kind`、`cursor_seq`、`idempotency_key`、`state`、`created_at`；对 `idempotency_key` 建唯一索引。

2. 在 `src/service/commands/nodes.ts` 实现 `enterWaiting`：进入 waiting 释放 executor 租约；wait_registrations 与状态迁移在同一事务里写入。

3. 实现 `wakeOnEvent`：先按 cursor 重放并回扫，再匹配新事件；事件先到（进入 inbox 时节点还没注册）不丢，靠 cursor 回放补齐。

4. 实现唤醒幂等：同 `idempotency_key` 第二次唤醒只落一条 registration，节点重新排队（waiting→dispatched）时不得复用旧 lease（M-21）。

5. `tests/wait.spec.ts`：断言事件先到后注册仍能唤醒；断言重复唤醒只落一条；断言 event_timeout 与 wake_dispatch_starvation 分别记账。

测试：

- `tests/wait.spec.ts`：断言 waiting→dispatched 后 `lease_id` 与旧值不同；断言 `max_wait` 到点落 timeout 并清等待钟。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(service): 实现等待节点与事件唤醒`

### Task 10：子流程 pin 版本、深度与环检测

目标：subworkflow 节点必须 pin 版本，深度超限与环都要在发布前/运行前被拒。

**Files:**

- `src/service/commands/subworkflow.ts` — pin 解析、深度与环检测（新建）
- `src/service/commands/nodes.ts` — 子 run 创建与取消传播（修改）
- `tests/subworkflow.spec.ts` — 环、深度、取消传播（新建）

步骤：

1. 新建 `src/service/commands/subworkflow.ts`，写子图遍历与判定：

```ts
import { OrchError } from '../../core/errors.ts';

export type SubworkflowRef = { workflowId: string; pinnedVersion: number };

export type SubworkflowEdge = {
  workflowId: string;
  version: number;
  children: SubworkflowRef[];
};

export function assertSubworkflowGraph(root: SubworkflowRef, edges: Map<string, SubworkflowEdge>): void {
  const visited = new Set<string>();
  const walk = (ref: SubworkflowRef, depth: number): void => {
    if (depth > 2) {
      throw new OrchError({ code: 'SUBWORKFLOW_DEPTH_EXCEEDED', message: '子流程深度超过 max_depth=2',
        retryable: false, details: { workflowId: ref.workflowId, depth } });
    }
    const key = ref.workflowId + '@' + ref.pinnedVersion;
    if (visited.has(key)) {
      throw new OrchError({ code: 'SUBWORKFLOW_CYCLE', message: '子流程引用成环',
        retryable: false, details: { workflowId: ref.workflowId, version: ref.pinnedVersion } });
    }
    visited.add(key);
    const edge = edges.get(key);
    for (const child of edge?.children ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
}
```

2. 实现子 run 创建：父运行记 pin 版本与 `resume_from`；子流程版本固定不跟随最新（规格 §5.9、§6.4）。

3. 实现取消传播：父 run 取消时向子 run 发 cancel；父 run 不先收口，子 run 收敛后再判（G-16）。

4. 实现子运行补偿逆序执行，失败落 `failed_with_unverified`。

5. `tests/subworkflow.spec.ts`：断言互相引用的两个已发布定义被环检测拒；断言深度 2 通过、深度 3 被拒；断言父取消传播到子 run 且父不先收口。

测试：

- `tests/subworkflow.spec.ts`：断言 `SUBWORKFLOW_CYCLE` 与深度超限各自的错误码与 details；断言子 run 的 workflow_version 固定为 pin 值。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(service): 实现子流程 pin 版本与环深度校验`

### Task 11：补偿执行与未验证副作用落账

目标：补偿按 `compensation_id` 幂等执行一次，失败落 `failed_with_unverified` 而不是 `failed`。

**Files:**

- `src/service/commands/compensation.ts` — 补偿执行与幂等（新建）
- `src/core/canonical.ts` — 补偿 id 计算（修改）
- `tests/compensation.spec.ts` — 幂等与落账（新建）

步骤：

1. 在 `src/core/canonical.ts` 加 `compensationId(nodeRunId, attempt, descriptorVersion)`：用 canonical_json + SHA256，组合相同必得同 id（规格 §4.7）。

2. 新建 `src/service/commands/compensation.ts`，写补偿执行：补偿工具只许出现在补偿描述符里；出现于前向路径在加载期拒 `COMPENSATION_TOOL_IN_FORWARD_PATH`。

```ts
import { OrchError } from '../../core/errors.ts';
import type { Tx } from '../../infra/sqlite/driver.ts';

export type CompensationDescriptor = {
  tool: string;
  args: readonly string[];
  verify: { command: string; args: readonly string[] };
  descriptorVersion: string;
};

export function startCompensation(tx: Tx, args: {
  nodeRunId: string; attempt: number; compensationId: string; descriptor: CompensationDescriptor;
}): boolean {
  const res = tx.prepare(
    'INSERT INTO compensations (compensation_id, node_run_id, attempt, tool, args_hash, state, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (compensation_id) DO NOTHING',
  ).run(args.compensationId, args.nodeRunId, args.attempt, args.descriptor.tool,
    args.compensationId.slice(0, 16), 'started', Date.now());
  return res.changes === 1;
}
```

3. 补偿事件固定三个：`compensation.started`、`compensation.applied`、`compensation.failed`；补偿证据按规格 §4.7 的固定字段集写入 artifacts。

4. 落账规则：补偿失败或 verify 不通过 → `failed_with_unverified`；无可执行补偿 → `compensation_id` 为 NULL，幂等键 `(node_run_id, attempt, no_executable_compensation)`；两种路径都不许落 `failed`（M-54/M-55）。

5. `tests/compensation.spec.ts`：断言同组合重放命中同一条证据、不重复执行；断言补偿失败落 `failed_with_unverified` 且 attempt 不变、Gr 不加一。

测试：

- `tests/compensation.spec.ts`：断言补偿描述符不可执行时报 `COMPENSATION_UNEXECUTABLE`；断言补偿工具出现在前向路径时报 `COMPENSATION_TOOL_IN_FORWARD_PATH`。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(service): 实现补偿执行与未验证副作用落账`

### Task 12：报告冲突与 uphold 收口

目标：迟到报告与人裁决冲突时节点挂起，只认 `uphold_report` 与 `uphold_decision` 两条收口路径。

**Files:**

- `src/core/report.ts` — applyReport 的 decision 参数与挂起分支（修改）
- `src/service/commands/decisions.ts` — 冲突 decision 与 uphold 收口（修改）
- `tests/report-conflict.spec.ts` — 冲突与两条收口（新建）

步骤：

1. 在 `src/core/report.ts` 扩展 `applyReport(node_run_id, attempt, report, expected_status, generation, decision?)`：第六参只在 confirm_applied、confirm_not_applied、uphold_report 三个出口上传，形状为 `{ decision_id, revision, resolution }`，同一事务 CAS decisions。

2. 冲突分支：迟到 report 与人的裁决冲突时生成 `report_contradicted` decision，节点留在 `startup_unknown` 或 `indeterminate_side_effect`，写 `hang_reason='report_contradicted'` 与 `contradiction_decision_id`；新 attempt 被挡。

3. 实现 `uphold_report`：以迟到 report 为准走同一套 schema/判定/证据门收口 done/failed，decision 行落 approved 并 closed(resolved)；证据门不过只能转 `uphold_decision`。

4. 实现 `uphold_decision`：维持原裁决 D1，迟到 report 永久标 stale；D2 与节点 CAS 同事务，D2 revision 过期时节点一个字节不动。

5. `tests/report-conflict.spec.ts`：断言普通出口在挂起状态下报 `STALE_HANG`；断言 uphold_report 成功清 hang_reason 与 `startup_unknown_deadline_at`；断言 uphold_decision 走 superseded 时新行 origin 指向旧行、attempt 加一。

测试：

- `tests/report-conflict.spec.ts`：断言 `report_contradicted` 永不过期为 expired；断言 decision revision 冲突时节点状态未变。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(service): 处理报告冲突与 uphold 收口`

### Task 13：可重入恢复扫描

目标：服务启动先拿锁再跑扫描，扫描可重入、可重复，不产生第二个终态。

**Files:**

- `src/service/sweep.ts` — 恢复扫描与优先级（新建或修改）
- `tests/sweep.spec.ts` — 优先级与可重入（新建）

步骤：

1. 在 `src/service/sweep.ts` 实现扫描顺序：恢复前先校验 `node_run_events` 哈希链；再按类别扫描——租约过期的 dispatched/started、executor 失联、桥断、未知态到期、动作到期、verify 到期、回执过期。

2. 写同节点多命中的优先级：终态已定→跳过；report_contradicted→保持挂起；indeterminate→保持；stopping→继续等；timing_out→继续等围栏；paused_bridge_missing→等桥恢复；startup_unknown→按钟；其余按租约。

3. 所有扫描动作走 Task 2 的 `applyTransition`（CAS），并在 `node_run_events` 写扫描原因与前后状态（规格 §4.9「恢复决策必须留痕」）。

4. `tests/sweep.spec.ts`：断言同一现场重复扫描得到同一结论且不新增同义 decision；断言 scanning 后不产生第二个终态；断言桥断行置 `paused_bridge_missing` 并记 `resume_state`。

测试：

- `tests/sweep.spec.ts`：断言幂等（两次扫描后 events 数量不变）；断言 `timing_out` 围栏不被重置。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(service): 实现可重入恢复扫描`

### Task 14：故障注入、M-01…M-61 汇总与 G3 门记录

目标：把六个注入点与 M-01…M-61 用例接成可复现脚本，并产出 G3 门记录与 GateArtifact。

**Files:**

- `scripts/fault-inject.ts` — 注入脚本与参数（修改或新建）
- `tests/integration/g3-faults.spec.ts` — 六个注入的自动化用例（新建）
- `tests/migration-cases.spec.ts` — M-01…M-61 汇总表用例（新建）
- `docs/gates/G3.md` — 门记录与 artifact_hash 锚点（新建）

步骤：

1. 在 `scripts/fault-inject.ts` 增加六个注入点，参数可复现：G-01（COMMIT 前杀进程）、G-02（COMMIT 后 outbox 未投递杀）、G-04（租约到期后迟到上报）、G-06（tool.result 丢失）、G-12（审批双击）、G-16（父取消子仍在跑）。每条留注入参数、前后账本片段与恢复后对账查询（规格 §12.3）。

2. 新建 `tests/integration/g3-faults.spec.ts`：六个注入各跑一遍并断言对账结果。

3. 新建 `tests/migration-cases.spec.ts`：把 M-01…M-61 逐行写成数据驱动用例（迁移、条件、必须落库的断言），非法迁移全拒。

4. 新建 `docs/gates/G3.md`：正文写必过项逐条证据、failed_items（空）、conclusion、approver、approved_at；结论后固定锚点：

```text
artifact_hash=SHA256(canonical_json(artifact))
```

artifact 按规格 §11.3 的固定字段集，G1–G5 属无 run 门：`gate_run_id=null`、`run_terminal='not_applicable'`、`producer='human'`；四个哈希原像按规格 §15.2。

5. 跑 `pnpm gate` 校验门记录与 artifact 一致。

测试：

- `tests/integration/g3-faults.spec.ts`：六个注入各一条断言。
- `tests/migration-cases.spec.ts`：M-01…M-61 全覆盖，非法迁移全拒。

验收：

```powershell
pnpm check
pnpm gate
```

期望：typecheck/test/build 全绿；`pnpm gate` 输出 G3 必过项全 pass、failed_items 为空，并校验 `docs/gates/G3.md` 的 `artifact_hash` 与 canonical_json(artifact) 相符。

提交：`test(gates): 补齐 G3 故障注入与门记录`

## 风险与回退

- 风险：M-01…M-61 有 61 条迁移，用例写漏一条就卡住 G3 的「M-01 到 M-61 全过」。缓解：Task 14 用数据驱动表把迁移行与用例行绑在一起，缺一条即编译失败。
- 风险：CAS 条件写松会让并发出现两个赢家。缓解：所有迁移统一走 Task 2 的执行器，条件至少含 attempt，dispatch 类再加 action_generation；Task 14 的 G-12 用例专门盯这个。
- 风险：跨 boot 剩余量算错会让墙钟跳变误判超时。缓解：截止判定只读 boot_id + monotonic_ns，测试用固定数值断言公式，不靠真实等待。
- 风险：决策升级与扫描同时改同一行。缓解：两类写都走 CAS，冲突一方整笔回滚，扫描可重入。
- 风险：规格 §3.6 的 partial unique index 与普通 UNIQUE 语义混用会漏掉 NULL 冲突。缓解：迁移脚本里为 run 级与节点级各建一个 partial unique index，测试断言两类行互不冲突。
- 回退：本批不改 S1/S2 的既有表结构语义，只加可空列与索引；出问题可把编排服务停在 S2 阶段继续跑单 agent 闭环（规格 §11.5 第 1001 行的阶段回滚口径：S3 停新 run、等在途收口）。已写下的迁移脚本不回收，只按 §4.1.1 的顺序执行规则跳过已执行版本。
- 一致性提醒（只报告不自行改）：总纲 §3 的目录树把驱动与迁移写在 `src/infra/db/`，而总纲 §4.1.1 要求唯一驱动文件在 `src/infra/sqlite/driver.ts`、迁移在 `src/infra/sqlite/migrations/`。本计划按 §4.1.1 书写，实施前请确认。

## 完成定义

- 规格 §11.1 第 936 行的 S3 能力全部落地：九节点、状态机、补偿。
- M-01 到 M-61 逐行用例全绿；非法迁移全拒；并发只有一个赢家；并行扇出与汇聚一致；子流程环与深度拒；补偿不重复；取消向子 run 传播。
- G-01/G-02/G-04/G-06/G-12/G-16 六个注入各跑一遍并留注入脚本、参数、前后账本片段与对账查询。
- `docs/gates/G3.md` 存在，含逐项证据、failed_items 为空、conclusion、approver、approved_at，结论后有 `artifact_hash=SHA256(canonical_json(artifact))` 锚点。
- `pnpm check` 与 `pnpm gate` 均通过。
- 本批没有引入 workflow 发布路径，没有让面板接真实账本，没有记忆写入代码。
