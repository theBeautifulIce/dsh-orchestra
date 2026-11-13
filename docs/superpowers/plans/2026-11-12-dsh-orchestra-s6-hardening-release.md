# dsh-orchestra S6 硬化与发布 实施计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 把 S1 到 S5 攒下的编排内核推到可发布状态：十六条故障注入逐条可注入、可对账、可复盘，性能与事件滞后在测量窗口内全程达标，24 小时浸泡无泄漏无孤儿，安全边界与保留期落到可验收的形态，门流程 `wf_release_v1` 跑通，G6 的两份 artifact 三字段一致，升级七步与回滚演练通过，最后按 R0、R1、R2 三圈逐级放出去。这一批只写 G6 门记录与发布包。

**Architecture:** 硬化层放在编排服务这一侧，不改账本语义：故障注入走 `scripts/fault-inject.ts` 的统一入口，每条注入都产出注入脚本与参数、前后账本片段、恢复后对账查询三样东西，对账查询是"过没过"的唯一判据。性能与浸泡用同一套读路径测量，不另开旁路。门流程 `wf_release_v1` 是一条普通的工作流定义（trigger → agent → parallel 六组检查 → wait → policy → approval → 收口器 → branch），policy 节点确定性判定必过项与阈值、不读 agent 摘要，GateArtifact 由 run 外的收口器写。升级与回滚只动构建与路由，账本只追加不回退。

**Tech Stack:** TypeScript 6.0.3（ESM，NodeNext）· Node `^22.19.0 || >=24.0.0` · pnpm 12.3.4 · vitest 4.1.8 · tsdown 0.22.14 · zod 4.4.3 · React 18.3.1 · jsdom 29.1.1 · node:sqlite（内置，只经 `src/infra/sqlite/driver.ts`）· DSH bundle 插件。

---

## 0. 前置、边界与口径

**前置**

- S1 到 S5 各阶段门已过，`docs/gates/G5.md` 在位。
- 本批沿用 S1 已定的口径：写队列上限 1000、超限 `SERVICE_UNAVAILABLE`（503）；回执窗口 7 天、在途 10 分钟；SQL 迁移在 `src/infra/sqlite/migrations/`，连接与执行器在 `src/infra/db/`。
- 本批沿用 S5 已定的口径：面板显示口径由服务端给全；记忆批准后快照只读；`wf_release_v1` 只在 S6 启用。

**本批能做什么**

1. G-01 到 G-16 十六条故障注入逐条可注入、可对账，每条留三样东西（规格 12.3 行 1056-1078）。
2. 控制面读性能与事件滞后达标，写路径的队列上限与溢出策略定值（规格 12.4 行 1081-1085）。
3. 24 小时浸泡：连接无泄漏、无孤儿 run、无未收口事件、内存与磁盘无异常增长（规格 12.4 行 1084）。
4. 安全边界八项验收与保留期、脱敏、导出规则（规格 12.5 行 1089-1094、13.4 行 1129-1135）。
5. 门流程 `wf_release_v1`：六组检查扇出、确定性 policy 判定、人批、run 外收口器、branch 分流（规格 11.4 行 990-992）。
6. G6 的两份 GateArtifact 与三字段一致性核对（规格 11.3 行 957-986、15.3 行 1216-1216）。
7. 升级七步、阶段回滚表、回滚演练（规格 11.5 行 1001-1002）。
8. 值班手册与演练记录（规格 11.5 行 1001-1002、14.6 行 1181-1187）。
9. R0 合成圈、R1 只读圈、R2 受控圈的准入与升圈规则（规格 11.6 行 1006-1012）。
10. G6 门记录、发布包与安装说明（规格 14.6 行 1181-1187）。

**本批不能做什么**

规格 11.1 行 939 写明 S6 阶段禁止「越过 G6 直接进 R2」。据此本批的禁止项：

1. 不许在 G6 结论为 fail 或缺证据时把任何工作区放进 R2；升圈只升一级（规格 11.6 行 1012）。
2. 不许改写 G1 到 G5 的门记录，也不许用 S6 的 artifact 顶替它们的 artifact。
3. 不许把"告警"当验收通过，也不许把"事后恢复"当窗口达标（规格 15.4 行 1220-1222）。
4. 不许用"还没定"当放行理由：总纲 §7 的六项开放参数必须在本批定值并写进 G6 门记录（规格 16.3 行 1271-1280）。
5. 不许把回滚做成账本回退：账本只追加，回退的是构建与路由（规格 11.5 行 996）。
6. 不许在 G6 之前跑 R1 的真实写操作；R1 圈的记忆只到提议（规格 11.6 行 1008）。

**G6 必过项（规格 11.2 行 953，原样引用）**

> G6 必过：G-01 到 G-16 全过、控制面 p95 达 8.3、事件滞后 p95 不大于 2 秒且最大不大于 10 秒、24 小时浸泡无泄漏无孤儿、从上一版升级成功、双向兼容窗口内负载回滚成功、值班手册演练通过、两份 artifact 的 candidate_hash / evidence_index_hash / conclusion 一致。

**未决参数（总纲 §7，本批必须逐项定值并写进 G6 门记录）**

| 未决项 | 本批定值落点 | 定值前行为 |
| --- | --- | --- |
| 写队列上限与溢出策略 | 沿用 S1 的 1000 与 `SERVICE_UNAVAILABLE`（503），在 G6 门记录里写死并留证据 | 保持 S1 口径 |
| 事件与证据的保留期 | `src/core/config.ts` 的 `retention` 段新增两项，值写进 G6 门记录 | 按安全侧：先不删，过期只显示「已过保留期」 |
| 记忆裁判的模型与提示词版本 | `src/core/memory-eval.ts` 记录裁判标识与提示词版本，写进 G6 门记录 | 按 S5 已定的 4000 字截断口径 |
| 值班人与升级联系人名单 | `docs/runbook.md` 的值班表 | 手册先留空位，演练前填满，否则 G6 不放行 |
| R1 / R2 的具体工作区白名单 | `docs/trial-circles.md` | 只准备不启用 |
| 24 小时浸泡的采样频率与判定脚本 | `scripts/fault-inject.ts` 的 soak 子命令与判定脚本 | 只准备不启用 |

**口径说明**

1. 本批在总纲 §3 已列出的目录内新增文件：`src/core/wf-release-v1.ts`、`src/service/gate.ts`、`docs/runbook.md`、`docs/trial-circles.md`、`docs/gates/G6-independent.json`、`docs/gates/G6-release.json`。不新增目录。
2. `artifact_hash` 只指 GateArtifact 的锚点哈希 `SHA256(canonical_json(artifact))`；证据哈希、产物哈希一律叫 `sha256`，两者不混（规格 15.7 行 1234-1236）。
3. G6 两份 artifact 的"一致"只指 `candidate_hash`、`evidence_index_hash`、`conclusion` 三个字段；`approver`、`approved_at`、`run_terminal`、`gate_run_id`、`exceptions`、`rollback` 允许不同（规格 15.3 行 1216-1216）。

---

### Task 1：故障注入脚手架与对账查询入口

**目标：** 立起统一的注入与对账框架，让十六条注入都按同一口径产出证据（规格 12.3 行 1077）。

**Files:**
- Create: `scripts/fault-inject.ts` —— 注入器统一入口、案例登记表与对账查询。
- Create: `src/infra/backup.ts` —— 备份、副本校验与只读回放，供 G-13 到 G-15 用。
- Create: `tests/integration/fault-harness.spec.ts` —— 框架本身的用例。

**步骤：**

1. 定注入报告的形状。每条注入必须留下四样：注入脚本与参数、前后账本片段、恢复后对账查询、对账结果。缺对账查询的注入不算通过。

```ts
// scripts/fault-inject.ts
export type FaultReport = {
  case_id: string
  title: string
  inject_params: Record<string, unknown>
  before_ledger: string
  after_ledger: string
  reconcile_query: string
  reconcile: {
    half_rows: number
    orphan_runs: number
    missing_events: number
    extra: Record<string, unknown>
  }
  passed: boolean
}

export type FaultCase = {
  id: string
  title: string
  inject: (params: Record<string, unknown>) => Promise<void>
  reconcile: (db: Db) => FaultReport['reconcile']
  check: (r: FaultReport['reconcile']) => boolean
}
```

2. 定案例登记表与入口函数。案例按 G-01 到 G-16 登记，每条一个 id、注入函数、对账查询与判定函数；入口 `runFaultCase(id, params)` 返回上面的报告。

3. 定对账查询的统一形态。三个必备计数（半条记录、孤儿 run、缺失事件）由固定 SQL 片段算出，注入特有的检查放在 `extra` 里。

4. 定备份与副本校验。备份写到独立目录，恢复只在校验目录里做，线上账本不受影响（规格 11.5 行 997、12.3 G-15）。

```ts
// src/infra/backup.ts
export type BackupResult = { backup_path: string; sha256: string; bytes: number }

export function backupTo(file: string, backupDir: string): BackupResult {
  fs.mkdirSync(backupDir, { recursive: true })
  const target = path.join(backupDir, path.basename(file))
  fs.copyFileSync(file, target)
  const buf = fs.readFileSync(target)
  return { backup_path: target, sha256: sha256Hex(buf.toString('binary')), bytes: buf.length }
}
```

5. 定演练用时长的默认。注入用短窗口（秒级），24 小时浸泡单列，不混在同一次运行里。

**测试：**

- Create: `tests/integration/fault-harness.spec.ts`
  - `runFaultCase('G-99', {})` 抛未登记案例的错。
  - 报告四样东西齐全：`inject_params` 非空、`before_ledger` 与 `after_ledger` 非空、`reconcile_query` 是可执行的查询文本。
  - 备份写进独立目录，线上账本文件字节数与 sha256 不变。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/integration/fault-harness.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add scripts/fault-inject.ts src/infra/backup.ts tests/integration/fault-harness.spec.ts
git commit -m "feat(hardening): 立起故障注入脚手架与对账入口"
```

---

### Task 2：G-01 到 G-03 事务与事件类注入

**目标：** 覆盖事务边界与事件投递的三条注入（规格 12.3 行 1060-1062）。

**Files:**
- Modify: `scripts/fault-inject.ts` —— 登记 G-01、G-02、G-03。
- Create: `tests/integration/fault-tx-event.spec.ts` —— 三条注入的用例。

**步骤：**

1. G-01 事务 COMMIT 前杀进程。预期：重启后事务未提交，没有半条记录；有旧构建则回退，没有旧构建则停当前阶段修复。对账：半条记录数必须为 0，且节点状态与杀前一致。

2. G-02 COMMIT 后 outbox 未投递时杀进程。预期：重启后事件补投，业务状态与账本一致。对账：缺失事件数为 0。

3. G-03 同 report_id 上报两次。预期：第二次命中幂等只落一次，registry 标记为 replayed。对账：registry 里同 report_id 只有一条，replayed=true。

```ts
// scripts/fault-inject.ts 续
export const FAULT_CASES: FaultCase[] = [
  {
    id: 'G-01',
    title: '事务 COMMIT 前杀进程',
    inject: async (params) => { await killBeforeCommit(params.dbPath) },
    reconcile: (db) => countHalfRows(db),
    check: (r) => r.half_rows === 0,
  },
  {
    id: 'G-02',
    title: 'COMMIT 后 outbox 未投递时杀进程',
    inject: async (params) => { await killAfterCommitBeforeOutbox(params.dbPath) },
    reconcile: (db) => countMissingEvents(db),
    check: (r) => r.missing_events === 0,
  },
  {
    id: 'G-03',
    title: '同 report_id 上报两次',
    inject: async (params) => { await reportTwice(params.reportId) },
    reconcile: (db) => countReportRegistry(db),
    check: (r) => r.extra.replayed === true && r.extra.rows === 1,
  },
]
```

4. 三条注入各自要留：注入脚本与参数、前后账本片段、恢复后对账查询。

**测试：**

- Create: `tests/integration/fault-tx-event.spec.ts`
  - G-01：杀进程后重启，`reconcile.half_rows === 0`；被杀事务里的那行不存在。
  - G-02：重启后 outbox 补投，`reconcile.missing_events === 0`，业务状态与账本一致。
  - G-03：同 report_id 上报两次，registry 只有一行且 `replayed === true`。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/integration/fault-tx-event.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add scripts/fault-inject.ts tests/integration/fault-tx-event.spec.ts
git commit -m "test(hardening): 覆盖 G-01 到 G-03 事务与事件注入"
```

---

### Task 3：G-04 到 G-06 租约、取消与回传丢失

**目标：** 覆盖执行器交接与回传的三条注入（规格 12.3 行 1063-1065）。

**Files:**
- Modify: `scripts/fault-inject.ts` —— 登记 G-04、G-05、G-06。
- Create: `tests/integration/fault-executor.spec.ts` —— 三条注入的用例。

**步骤：**

1. G-04 租约到期后原执行器迟到上报。预期：迟到报告被拒，节点不被旧执行器推进，晚到的 tool.result 只进隔离区。对账：节点 status 与 attempt 未被迟到报告推进，隔离区里有这条记录。

2. G-05 工具执行中取消。预期：只有 confirmed interrupt 才立 `timing_out`，其余进 `stopping`，不产生第二终态。对账：节点只有一个终态。

3. G-06 tool.result 丢失。预期：节点进 `indeterminate_side_effect` 或保持 applying，先对账，不许当没发生。对账：节点非 done，且有对应的对账查询入口。

```ts
// scripts/fault-inject.ts 续
export function assertSingleTerminal(row: { status: string; terminal_count: number }): boolean {
  const terminal = ['done', 'failed', 'timeout', 'abandoned_unverified', 'failed_with_unverified', 'orphaned', 'superseded']
  return terminal.includes(row.status) ? row.terminal_count === 1 : row.terminal_count === 0
}
```

4. G-06 的节点状态与 S5 的 Task 14 的对账路径一致：节点 indeterminate、批次保持 applying，confirm_applied 与 confirm_not_applied 必须带 stopped_at 与 evidence_id。

**测试：**

- Create: `tests/integration/fault-executor.spec.ts`
  - G-04：迟到上报被拒，节点 status 不变，迟到结果落在隔离区且不推进节点。
  - G-05：只有 confirmed interrupt 立 `timing_out`，其余是 `stopping`；节点终态计数为 1。
  - G-06：节点非 done，`memory.inspect_batch` 与 runTool 的对账查询都能取到现场。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/integration/fault-executor.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add scripts/fault-inject.ts tests/integration/fault-executor.spec.ts
git commit -m "test(hardening): 覆盖 G-04 到 G-06 执行器交接注入"
```

---

### Task 4：G-07 到 G-09 时钟、并发与订阅

**目标：** 覆盖时钟跳变、写锁排队与订阅者重连（规格 12.3 行 1066-1068）。

**Files:**
- Modify: `scripts/fault-inject.ts` —— 登记 G-07、G-08、G-09。
- Create: `tests/integration/fault-clock-concurrency.spec.ts` —— 三条注入的用例。

**步骤：**

1. G-07 墙钟前后跳十分钟并覆盖重启。预期：截止按 `boot_id + monotonic_ns` 判定，不因墙钟跳变误判超时，不确定就转 `timer_uncertain`。对账：节点不出现被墙钟误判的终态。

2. G-08 写锁长事务队列 1000。预期：写路径有上限与溢出策略，读不被拖死，超限有明确错误（`SERVICE_UNAVAILABLE`，503）。对账：排队长度不超过上限，读延迟不被写锁拖垮。

3. G-09 订阅者离线十分钟重连。预期：按 `fromSeq` 重放，断号整页重取，不丢证据。对账：重连后事件条数与账本一致。

```ts
// scripts/fault-inject.ts 续
export function assertDeadlineByMonotonic(args: {
  boot_id: string
  deadline_boot_id: string
  monotonic_ns: number
  deadline_ns: number
}): 'within' | 'expired' | 'uncertain' {
  // 跨 boot 的截止无法用单调钟比较，不确定就转 timer_uncertain，不因墙钟跳变误判
  if (!args.boot_id || args.deadline_ns <= 0) return 'uncertain'
  if (args.boot_id !== args.deadline_boot_id) return 'uncertain'
  return args.monotonic_ns >= args.deadline_ns ? 'expired' : 'within'
}
```

4. G-08 的溢出策略与 S1 一致：队列上限 1000，超限返回 `SERVICE_UNAVAILABLE`（503），不排队等死。

**测试：**

- Create: `tests/integration/fault-clock-concurrency.spec.ts`
  - G-07：墙钟前后各跳十分钟，节点没有被误判超时；跨重启后按 `boot_id + monotonic_ns` 判定，不确定转 `timer_uncertain`。
  - G-08：写队列排到 1000 时第 1001 个请求拿到 `SERVICE_UNAVAILABLE`（503），读路径的 p95 不被拖垮。
  - G-09：订阅者离线十分钟后按 `fromSeq` 重连，事件条数与账本一致；中间断号时整页重取，证据不丢。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/integration/fault-clock-concurrency.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add scripts/fault-inject.ts tests/integration/fault-clock-concurrency.spec.ts
git commit -m "test(hardening): 覆盖 G-07 到 G-09 时钟并发订阅注入"
```

---

### Task 5：G-10 到 G-12 发布、记忆半写与审批双击

**目标：** 覆盖版本切换、记忆写入中断与重复提交三条注入（规格 12.3 行 1069-1071）。

**Files:**
- Modify: `scripts/fault-inject.ts` —— 登记 G-10、G-11、G-12。
- Create: `tests/integration/fault-version-memory.spec.ts` —— 三条注入的用例。

**步骤：**

1. G-10 在途 run 时发布新版本。预期：在途 run 仍按旧版本解释，新 run 用新版本。对账：老 run 的 `workflow_version` 不变，新 run 的版本等于新发布版本。

2. G-11 记忆批次写一半杀。预期：批次停在 applying；对账确认部分写入后才转 indeterminate；签字后 run 落 succeeded_with_unverified。这一条与 S5 Task 14 的三走向共用同一套代码：节点 indeterminate、批次保持 applying、confirm_applied 与 confirm_not_applied 必须带 stopped_at 与 evidence_id。

3. G-12 审批双击与同决定重复提交。预期：同 operation_id 重放回执，不同 operation_id 同 revision 只一个赢家。对账：命令行只有一条 applied，另一条是冲突回执。

```ts
// scripts/fault-inject.ts 续
export function assertSingleWinner(rows: Array<{ operation_id: string; status: string; revision: number }>): boolean {
  const applied = rows.filter((r) => r.status === 'applied')
  const conflicted = rows.filter((r) => r.status === 'rejected')
  return applied.length === 1 && conflicted.length === rows.length - 1
}
```

4. 三条注入的落点要跟 S5 的口径一致：版本解释看 run 上固化的 `workflow_version`，审批双击看命令回执，记忆半写看批次状态与节点状态。

**测试：**

- Create: `tests/integration/fault-version-memory.spec.ts`
  - G-10：在途 run 发布新版本后，老 run 的版本号不变，新建的 run 用新版本。
  - G-11：写一半杀进程，批次状态是 applying、outcome 为空、节点 indeterminate；inspect 确认部分写入后批次转 indeterminate，已写 applied、未写 approved；走 verify_human 的 abandon 并签字后 run 落 succeeded_with_unverified，批次保持 indeterminate。
  - G-12：同 operation_id 重发返回 replayed 回执且只有一条 applied；不同 operation_id 同 revision 只一个赢家，另一条拿冲突回执。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/integration/fault-version-memory.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add scripts/fault-inject.ts tests/integration/fault-version-memory.spec.ts
git commit -m "test(hardening): 覆盖 G-10 到 G-12 发布与记忆注入"
```

---

### Task 6：G-13 到 G-16 升级、迁移、备份与取消传播

**目标：** 覆盖发布期的四条注入（规格 12.3 行 1072-1075）。

**Files:**
- Modify: `scripts/fault-inject.ts` —— 登记 G-13、G-14、G-15、G-16。
- Create: `tests/integration/fault-release.spec.ts` —— 四条注入的用例。

**步骤：**

1. G-13 升级或回滚时仍有在途 run。预期：安全点等待与回滚表生效，在途 run 不被新构建改写。对账：回滚前后在途 run 的状态与账本片段一致，新构建没有改写老 run 的行。

2. G-14 迁移一半杀后重跑。预期：迁移可重入，已提交步骤不重复；没有旧构建时停 S1 修复。对账：重跑后迁移步骤的 applied 集合与杀前一致，没有重复应用的记录。

3. G-15 备份截断或篡改后恢复。预期：独立目录校验能检出，不污染线上账本。对账：校验失败时报错并指出校验项，线上账本 sha256 未变。

4. G-16 父 run 取消子 run 仍在跑。预期：取消向子 run 传播，父 run 不先收口，子 run 收敛后再判。对账：父 run 在子 run 终态前仍是暂停态，没有第二个终态。

```ts
// src/infra/backup.ts 续
export function verifyBackup(args: { backup_path: string; expect_sha256: string }): { ok: boolean; reason?: string } {
  const buf = fs.readFileSync(args.backup_path)
  const got = sha256Hex(buf.toString('binary'))
  if (got !== args.expect_sha256) {
    return { ok: false, reason: '备份内容与登记的 sha256 不符' }
  }
  return { ok: true }
}
```

5. 迁移可重入的做法与 S1 一致：迁移步骤逐条记录已应用状态，重跑时跳过已提交步骤。

**测试：**

- Create: `tests/integration/fault-release.spec.ts`
  - G-13：回滚前后在途 run 的行未被新构建改写；回滚表里该阶段的动作生效。
  - G-14：迁移半杀后重跑，已提交步骤不重复执行，账本里没有重复应用痕迹。
  - G-15：把备份截断或改一个字节，校验返回 `ok: false` 并给理由；线上账本 sha256 不变。
  - G-16：取消父 run 后子 run 收到取消，父 run 在子 run 收敛前不是终态；子 run 收敛后父 run 才收口，且只有一个终态。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/integration/fault-release.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add scripts/fault-inject.ts src/infra/backup.ts tests/integration/fault-release.spec.ts
git commit -m "test(hardening): 覆盖 G-13 到 G-16 升级迁移与取消注入"
```

---

### Task 7：控制面读性能基准

**目标：** 把规格 8.3 行 640 的四条性能线变成可重复跑的基准（Q-26 / Q-27）。

**Files:**
- Create: `tests/integration/perf.spec.ts` —— 四条读路径的 p95 基准。
- Modify: `src/service/queries/read-tx.ts` —— 基准需要的只读连接与索引提示。

**步骤：**

1. 定基准口径。预热 3 次取第 4 次；每个场景跑满 12 次取 p95；每条查询都要看 SQL 计划，不允许全表扫描（Q-26）。

2. 四条性能线（规格 8.3 行 640）：

| 场景 | 数据量 | 门槛 |
| --- | --- | --- |
| `list_tasks` | 一万条任务 | p95 < 100ms |
| `get_run` | 一千个节点 | p95 < 150ms |
| `list_nodes` | 两条百 | p95 < 80ms |
| `list_events` | 两条百 | p95 < 50ms |

3. 定读事务的隔离口径。读连接 `PRAGMA query_only=ON`，单页内强一致，跨页不承诺同一快照（规格 8.3 行 639）。

```ts
// tests/integration/perf.spec.ts
export function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
  return sorted[idx] ?? 0
}

export async function measure(fn: () => Promise<void>, times = 12): Promise<number> {
  for (let i = 0; i < 3; i++) await fn()      // 预热 3 次
  const samples: number[] = []
  for (let i = 0; i < times; i++) {
    const t0 = performance.now()
    await fn()
    samples.push(performance.now() - t0)
  }
  return p95(samples)
}
```

4. 定失败口径。任一条性能线不达标，基准直接失败，不允许用平均值或排除预热来凑。

**测试：**

- Create: `tests/integration/perf.spec.ts`
  - `list_tasks` 一万条任务 p95 < 100ms。
  - `get_run` 一千节点 p95 < 150ms。
  - `list_nodes` 两条百 p95 < 80ms。
  - `list_events` 两条百 p95 < 50ms。
  - 四条场景的 `EXPLAIN QUERY PLAN` 里不出现全表扫描。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/integration/perf.spec.ts
```

期望：全绿；若机器负载导致抖动，重跑三次取最好一次仍不达标时按未通过处理，不改门槛。

**提交：**

```powershell
git add tests/integration/perf.spec.ts src/service/queries/read-tx.ts
git commit -m "perf(service): 建立控制面读性能基准"
```

---

### Task 8：事件滞后、写路径与溢出策略

**目标：** 把事件滞后与写路径的约束变成常驻探针，并把开放参数定值（规格 12.4 行 1081-1085、15.4 行 1220-1222）。

**Files:**
- Modify: `src/service/server.ts` —— 滞后采样与窗口判定。
- Modify: `src/infra/lock.ts` —— 写队列上限与溢出。
- Modify: `src/core/config.ts` —— 队列上限与滞后阈值配置键。
- Create: `tests/integration/lag.spec.ts` —— 滞后与写路径的用例。

**步骤：**

1. 定写路径口径。单写者、短事务、`busy_timeout` 5000ms、写队列有上限与溢出策略（规格 12.4 行 1081-1082）。队列上限沿用 S1 的 1000，超限返回 `SERVICE_UNAVAILABLE`（503），读路径不被拖死。

2. 定滞后判定。事件滞后 p95 大于 2 秒或最大大于 10 秒持续十分钟必须告警；告警是运维动作，不等于验收通过也不等于失败。放行要求测量窗口全程 p95 不大于 2 秒且最大不大于 10 秒，窗口内任何一次超上限都不满足放行（规格 15.4 行 1220-1222）。

```ts
// src/service/server.ts 续
export type LagSample = { at: string; subscriber_lag_ms: number }

export function judgeLagWindow(samples: LagSample[]): { p95: number; max: number; ok: boolean } {
  const values = samples.map((s) => s.subscriber_lag_ms).sort((a, b) => a - b)
  const p95 = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] ?? 0
  const max = values[values.length - 1] ?? 0
  return { p95, max, ok: p95 <= 2_000 && max <= 10_000 }
}
```

3. 定单节点回传的载荷上限。单节点回传 payload 默认 64KiB，摘要不超过 800 字（规格 12.4 行 1085）。

4. 定配置键。新增的键一律 `.strict()`，未知键拒绝启动；本批新增的两个保留期键与滞后阈值键都写进 `orchestra.config.json` 样例。

**测试：**

- Create: `tests/integration/lag.spec.ts`
  - 窗口内全程 p95 不大于 2 秒且最大不大于 10 秒 → `ok: true`。
  - 窗口内出现一次 11 秒 → `ok: false`（不允许用平均或事后恢复替代）。
  - 写队列排到 1000 时第 1001 个请求拿到 `SERVICE_UNAVAILABLE`（503）。
  - 单节点回传 payload 超过 64KiB 被拒；摘要超过 800 字被截断或拒。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/integration/lag.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/service/server.ts src/infra/lock.ts src/core/config.ts tests/integration/lag.spec.ts
git commit -m "feat(service): 建立事件滞后探针与写路径溢出策略"
```

---

### Task 9：24 小时浸泡

**目标：** 跑满 24 小时，确认无连接泄漏、无孤儿 run、无未收口事件、无持续增长的内存或磁盘异常（规格 12.4 行 1084）。

**Files:**
- Create: `tests/integration/soak.spec.ts` —— 浸泡用例与判定脚本。
- Modify: `src/service/sweep.ts` —— 巡检快照：孤儿 run、未收口事件、连接数、资源占用。

**步骤：**

1. 定采样频率与判定脚本。采样频率与判定脚本是总纲 §7 的开放项，本批定值并写进 G6 门记录：每 60 秒采一次快照，每 30 分钟做一次趋势判定。采样频率写在 `scripts/fault-inject.ts` 的 soak 子命令参数里。

2. 定巡检快照的字段。

```ts
// src/service/sweep.ts 续
export type SoakSnapshot = {
  at: string
  open_connections: number
  orphan_runs: number
  unclosed_events: number
  rss_bytes: number
  db_bytes: number
  active_runs: number
}
```

3. 定判定口径。四条同时成立才算浸泡通过：连接数在窗口末尾回到基线（无泄漏）；孤儿 run 数为 0；未收口事件数为 0；内存与磁盘占用不呈持续增长趋势（取窗口前 10% 与后 10% 的均值比较）。

4. 定浸泡期间的负载。浸泡要带真实流量：合成任务、单节点 run、事件订阅、面板轮询都要跑，不许只在空载下跑。

5. 定失败处置。任一条不成立，浸泡判 fail，并把窗口末快照与趋势数据写进 G6 门记录作为证据。

**测试：**

- Create: `tests/integration/soak.spec.ts`
  - 短时冒烟版（默认 5 分钟）能跑通全流程并产出快照序列，用于日常回归；完整 24 小时由 `pnpm fault soak --hours 24` 触发，不进日常测试。
  - 判定函数在"连接数持续上升"的样本上返回 false，在平稳样本上返回 true。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/integration/soak.spec.ts
pnpm fault soak --hours 24
```

期望：短时冒烟全绿；24 小时跑完后判定为通过，产出窗口快照与趋势数据。

**提交：**

```powershell
git add tests/integration/soak.spec.ts src/service/sweep.ts scripts/fault-inject.ts
git commit -m "feat(hardening): 建立 24 小时浸泡与判定脚本"
```

---

### Task 10：安全边界验收

**目标：** 把规格 13.4 行 1127-1135 的八项边界逐条变成可执行的验收（规格 12.5 行 1087-1094）。

**Files:**
- Modify: `src/core/policy.ts` —— 加载期与调用期的工具策略校验。
- Modify: `src/executor/tools.ts` —— 注册表查不到拒、工具能力标注。
- Modify: `src/service/commands/router.ts` —— 匿名写拒绝、actor 由认证主体派生。
- Create: `tests/security.spec.ts` —— 安全边界的用例。

**步骤：**

1. 定加载期的两条拒。executor 的 allow 里含 mutating 工具却声明 `side_effect_policy: pure` → `SIDE_EFFECT_UNDECLARED`（422）；verifier 的 toolPolicy 含 mutating → `VERIFIER_TOOL_POLICY_MUTATING`（422）；注册表查不到的工具 → `TOOL_NOT_REGISTERED`（422）。

```ts
// src/core/policy.ts
export function assertExecutorToolPolicy(args: {
  declared_effect: 'pure' | 'compensable' | 'irreversible'
  allowed: string[]
  capabilityOf: (tool: string) => 'pure' | 'mutating' | 'unknown'
}): void {
  const mutating = args.allowed.filter((t) => args.capabilityOf(t) === 'mutating')
  if (mutating.length > 0 && args.declared_effect === 'pure') {
    throw new OrchError('SIDE_EFFECT_UNDECLARED', '声明纯只读却挂了会改东西的工具')
  }
}
```

2. 定调用期的两条拒。runTool 调用非只读命令 → `RUN_TOOL_NOT_READ_ONLY`（403）；任务会话读写 storages → `FORBIDDEN`（403）。任务会话默认不给工具、storages 读写默认 deny（规格 12.5 行 1089）。

3. 定认证与 actor。写操作必须有主体，actor 由认证主体派生，不由 payload 自报；匿名写拒绝 → `UNAUTHORIZED`（401）；越权命令 → `FORBIDDEN`（403）。子智能体持密钥也不能替别人解裁决（设计稿 Q-34）。

4. 定 trigger 的未注册 effect 原语。按 irreversible 处理并要求审批：先 `SIDE_EFFECT_UNDECLARED`（422），确认阶段给 `CONFIRMATION_REQUIRED`（428）。

5. 定记忆工具的发布期拒。allow 里出现 `memory_write` 或 `memory_update` → `MEMORY_WRITE_TOOL_FORBIDDEN`（422），不生成版本；换成 `memory.search` 可发布。这条在 S5 已落，本批只补回归断言。

**测试：**

- Create: `tests/security.spec.ts`
  - 匿名写 → `UNAUTHORIZED`（401）。
  - 越权命令 → `FORBIDDEN`（403）。
  - actor 取认证主体而非 payload 自报；同一请求换 payload 里的 actor 字段不改写审计里的 actor。
  - executor allow 含 mutating 且声明 pure → 加载期 `SIDE_EFFECT_UNDECLARED`（422）。
  - verifier toolPolicy 含 mutating → 加载期 `VERIFIER_TOOL_POLICY_MUTATING`（422）。
  - runTool 调非只读命令 → 调用期 `RUN_TOOL_NOT_READ_ONLY`（403）。
  - trigger 挂未注册 effect 原语 → 按 irreversible 要求审批。
  - 任务会话读写 storages → `FORBIDDEN`（403）。
  - allow 里出现 `memory_write` 或 `memory_update` → 发布期 `MEMORY_WRITE_TOOL_FORBIDDEN`（422）且不生成版本。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/security.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/core/policy.ts src/executor/tools.ts src/service/commands/router.ts tests/security.spec.ts
git commit -m "feat(security): 落地安全边界验收"
```

---

### Task 11：保留期、导出与脱敏

**目标：** 把保留期与脱敏规则定值并落地（规格 12.5 行 1089-1092）。

**Files:**
- Modify: `src/service/sweep.ts` —— 保留期扫描。
- Modify: `src/infra/logger.ts` —— 日志脱敏。
- Modify: `src/core/config.ts` —— 保留期配置键。
- Modify: `src/client/panel/task-detail.tsx` —— 过期 artifact 的显示。
- Create: `tests/retention.spec.ts` —— 保留期与脱敏的用例。

**步骤：**

1. 定保留期。事件与证据按配置保留，保留期是总纲 §7 的开放项，本批在 `orchestra.config.json` 的 `retention` 段定值并写进 G6 门记录。回执 7 天、in_flight 10 分钟沿用 S1 口径不变。

2. 定过期 artifact 的显示口径。artifact 过期后显示「已过保留期」，不删账本事实；面板禁用下载。

3. 定脱敏。导出与日志默认脱敏，不打印 token、密钥、完整 payload、executor 全量 transcript。

```ts
// src/infra/logger.ts
const SECRET_KEYS = ['token', 'secret', 'authorization', 'api_key', 'password']

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.includes(k.toLowerCase()) ? '[redacted]' : redact(v)
    }
    return out
  }
  return value
}
```

4. 定审计写入的内容。命令审计写 operation_id、actor、decision_id、resolution、结果、时间，不记证据原文只记 evidence_id（设计稿 §4.9）。

**测试：**

- Create: `tests/retention.spec.ts`
  - 超过保留期的事件与证据被标记过期，账本事实仍在（可查）。
  - 过期 artifact 在面板显示「已过保留期」且下载禁用。
  - 日志与导出里搜不到 token、密钥、完整 payload；executor 的 transcript 不进日志。
  - 命令审计里有 operation_id、actor、decision_id、resolution，没有证据原文。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/retention.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/service/sweep.ts src/infra/logger.ts src/core/config.ts src/client/panel/task-detail.tsx tests/retention.spec.ts
git commit -m "feat(service): 落地保留期与日志脱敏"
```

---

### Task 12：门流程 wf_release_v1

**目标：** 交出规格 11.4 行 988-992 的门流程，让 G6 的检查由流程本身跑出来。

**Files:**
- Create: `src/core/wf-release-v1.ts` —— 内置流程定义。
- Modify: `src/executor/bridge.ts` —— parallel 扇出与 wait 收口。
- Modify: `src/core/policy.ts` —— 门的确定性判定。
- Modify: `src/service/commands/workflow.ts` —— 发布 `wf_release_v1`。
- Create: `tests/integration/wf-release-v1.spec.ts` —— 门流程的用例。

**步骤：**

1. 定流程形状。trigger → agent → parallel 扇出六组 → wait → policy → approval → run 外收口器 → branch。六组检查命令是 `wf_gate_check_v1`，分组为迁移恢复、单节点、状态机并发、版本发布、面板记忆、性能安全（规格 11.4 行 991）。

2. 定各节点的职责边界。agent 只排检查组，不执行、不写账本、不批准；子流程 tool 跑命令与注入，agent 只读写摘要并产出 evidence；policy 确定性判必过项与阈值，不读 agent 摘要；approval 由人批，绑定候选哈希与证据集合，证据变则失效；branch 只读 policy decision 分流；部署脚本另判 conclusion、run_terminal、gate_run_id。

3. 定 wait 的超时口径。超时则 run 进 paused、节点记 blocked，并写清哪组没回来。

```ts
// src/core/wf-release-v1.ts
export const WF_RELEASE_V1_CHECK_GROUPS = [
  'migration_recovery',
  'single_node',
  'state_machine_concurrency',
  'version_publish',
  'panel_memory',
  'perf_security',
] as const

export type CheckGroup = (typeof WF_RELEASE_V1_CHECK_GROUPS)[number]
```

4. 定启用边界。`wf_release_v1` 只在 S6 启用；S5 启动它必须被拒（规格 2.4 行 121-122、S5 Task 16 已落）。

5. 定面板的门卡。面板只显示一张门卡：阶段与门、一句结论、谁在等、下一步一个动作；默认不显示 run_id、node_run_id、event_id。

**测试：**

- Create: `tests/integration/wf-release-v1.spec.ts`
  - 流程形状正确：trigger → agent → parallel → wait → policy → approval → branch，六组检查齐全。
  - agent 节点不执行命令、不写账本、不批准；只有 tool 子流程执行命令。
  - policy 的判定只吃 evidence 与阈值，不吃 agent 摘要；把 agent 摘要改掉，判定结果不变。
  - wait 超时：run 进 paused，节点记 blocked，报文写清缺哪组。
  - approval 绑定候选哈希与证据集合；证据变了审批失效。
  - S5 阶段发布或启动 `wf_release_v1` 被拒。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/integration/wf-release-v1.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/core/wf-release-v1.ts src/executor/bridge.ts src/core/policy.ts src/service/commands/workflow.ts tests/integration/wf-release-v1.spec.ts
git commit -m "feat(gate): 交出门流程 wf_release_v1"
```

---

### Task 13：GateArtifact 与 G6 双 artifact 一致

**目标：** 让 run 外的收口器写 GateArtifact，并核对两份 artifact 的三字段一致（规格 11.3 行 955-987、15.3 行 1214-1216）。

**Files:**
- Modify: `src/core/gate-artifact.ts` —— 补齐哈希原像与例外校验。
- Create: `src/service/gate.ts` —— run 外的门收口器。
- Create: `tests/integration/gate-artifact.spec.ts` —— artifact 构造与一致性核对的用例。

**步骤：**

1. 定两个哈希原像（规格 15.2 行 1194-1212）。

```ts
// src/core/gate-artifact.ts 续
export function evidenceIndexHashOf(items: EvidenceRef[]): string {
  return sha256Hex(canonicalJson({
    evidence_index: items.map((e) => ({ evidence_id: e.evidence_id, sha256: e.sha256, strength: e.strength, source: e.source })),
  }))
}

export function invariantsHashOf(items: Array<{ id: string; method: string; result: string }>): string {
  return sha256Hex(canonicalJson({ invariants: items }))
}
```

2. 定例外的有效性。exceptions 写在 artifact 内、随 artifact 被 artifact_hash 覆盖；缺 scope、expires_at、compensation、rollback_target、approver 任一项视为无效例外。无效例外不许把 fail 改成 pass（规格 15.6 行 1228-1230）。

```ts
// src/core/gate-artifact.ts 续
export function isValidException(e: GateException): boolean {
  return Boolean(e.scope && e.expires_at && e.compensation && e.rollback_target && e.approver)
}
```

3. 定收口器的位置与职责。GateArtifact 由 run 外的收口器写；run 内的节点（含 policy、branch、收口草稿）一律不读本 run 终态。有 run 的门收口器在 run 终态后写，`gate_run_id` 指向门 run，`run_terminal` 直抄 `runs.status`；无 run 的门 `gate_run_id=null`、`run_terminal=not_applicable`、`producer=human`。

4. 定双 artifact 的一致核对。

```ts
// src/service/gate.ts
export function compareGateArtifacts(a: GateArtifact, b: GateArtifact): { same: boolean; diff: string[] } {
  const fields = ['candidate_hash', 'evidence_index_hash', 'conclusion'] as const
  const diff = fields.filter((f) => a[f] !== b[f])
  return { same: diff.length === 0, diff: [...diff] }
}
```

5. 定不一致时的处置。以独立人工或 S5 构建那份为准（规格 15.3 行 1216）。

**测试：**

- Create: `tests/integration/gate-artifact.spec.ts`
  - 有 run 的门：`gate_run_id` 指向门 run，`run_terminal` 与 `runs.status` 一致。
  - 无 run 的门：`gate_run_id=null`、`run_terminal=not_applicable`、`producer=human`。
  - must_pass_items 有 fail 或 failed_items 非空 → conclusion=fail；例外不能把 fail 改成 pass。
  - 无效例外（缺五项之一）被识别，不进入通过路径。
  - 两个 artifact 的 candidate_hash、evidence_index_hash、conclusion 相同时 `same: true`；任一不同 `same: false` 且 diff 列出字段名；approver 与 approved_at 不同不影响一致判定。
  - artifact 内部没有 record_hash / artifact_hash 自指字段。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/integration/gate-artifact.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/core/gate-artifact.ts src/service/gate.ts tests/integration/gate-artifact.spec.ts
git commit -m "feat(gate): 交出门收口器与双 artifact 一致核对"
```

---

### Task 14：升级七步与回滚演练

**目标：** 把升级七步与阶段回滚表做成可执行的流程并在负载中演练（规格 11.5 行 994-1002）。

**Files:**
- Modify: `scripts/gate-check.ts` —— 升级与回滚的子命令。
- Modify: `src/infra/backup.ts` —— 副本迁移校验与只读回放。
- Create: `tests/integration/upgrade.spec.ts` —— 升级与回滚的用例。

**步骤：**

1. 定升级七步的顺序（规格 11.5 行 1002）：备份 → 副本迁移校验 → 停新 run 等到安全点 → 起新构建健康检查与只读回放 → 合成单节点 run → 恢复新 run 观察十分钟 → 不对按表回滚并记录现场。每步一个子命令，跑完一步记一步。

```powershell
pnpm gate --upgrade step backup
pnpm gate --upgrade step verify-copy
pnpm gate --upgrade step quiesce
pnpm gate --upgrade step healthcheck
pnpm gate --upgrade step synthetic-run
pnpm gate --upgrade step observe --minutes 10
pnpm gate --upgrade step rollback-table
```

2. 定迁移方式。破坏性迁移先扩展再收缩；回滚要在负载中演练，不许只在空载里跑。

3. 定回滚的对象与范围。回滚的是构建与路由，账本只追加不回退；回滚对象是上一过门构建。阶段回滚表按规格 11.5 行 1001：S1 停服务保留账本；S2 关桥、在途 agent 置 `paused_bridge_missing`；S3 停新 run 等在途收口；S4 撤问题版本不动已固定 run；S5 关面板与记忆路由、引擎账本继续；S6 按手册退上一过门构建，仅在双向兼容窗口内。

4. 定回滚触发的判定。触发条件：I1 到 I9 破坏、同类 P1 在 24 小时内两次或跨工作区、事件滞后超阈十分钟且扩容无效、迁移后状态无法用账本解释、安全边界突破。值班人可先停新 run、关路由；回退构建由阶段负责人十分钟内拍板（规格 11.5 行 999-1000）。

5. 定只读回放。线上按事件日志重放，RPO 为 0；备份只恢复到独立目录做校验，不直接覆盖线上。

**测试：**

- Create: `tests/integration/upgrade.spec.ts`
  - 七步按顺序执行，每步留下可查记录；跳过任何一步时脚本拒绝继续。
  - 从上一版构建升级成功，升级后账本行数只增不减。
  - 双向兼容窗口内带负载回滚成功：在途 run 不被新构建改写。
  - 回滚只动构建与路由：回滚前后账本的 `events.seq` 单调递增，没有回退。
  - 备份恢复只写到独立目录，线上账本文件 sha256 不变。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/integration/upgrade.spec.ts
pnpm gate --upgrade dry-run
```

期望：全绿；dry-run 输出七步的执行计划与回滚表。

**提交：**

```powershell
git add scripts/gate-check.ts src/infra/backup.ts tests/integration/upgrade.spec.ts
git commit -m "feat(release): 建立升级七步与回滚演练"
```

---

### Task 15：值班手册与演练

**目标：** 交出值班手册，把触发条件、阶段回滚表、升级七步与演练记录写成值班人照着就能做的文档（规格 11.5 行 994-1002、14.6 行 1181-1187）。

**Files:**
- Create: `docs/runbook.md` —— 值班手册正文。
- Create: `tests/runbook.spec.ts` —— 手册条目齐全性的检查。

**步骤：**

1. 定手册的骨架。章节固定为：适用范围与前置（当前构建、上一过门构建、账本位置）、值班表与升级联系人、告警与处置、升级七步、阶段回滚表、回滚触发条件与十分钟拍板规则、演练记录。

2. 定值班表。值班人与升级联系人名单是总纲 §7 的开放项，本批定值并写进 G6 门记录；名单没填满时 G6 不放行。

3. 定演练记录。每轮演练记日期、参与人、注入的故障、七步执行情况、回滚是否生效、遗留问题与处置。

4. 定手册与脚本的关系。手册里的每条命令都能在 `scripts/gate-check.ts` 找到对应子命令，不许写手册里跑不通的命令。

```markdown
# dsh-orchestra 值班手册

## 值班表

| 角色 | 姓名 | 联系方式 | 值班时段 |
| --- | --- | --- | --- |
| 当班 | 待填 | 待填 | 待填 |
| 升级联系人 | 待填 | 待填 | 待填 |

## 回滚触发条件

- I1 到 I9 任一不变量被破坏
- 同类 P1 在 24 小时内两次，或出现在不同工作区
- 事件滞后超阈持续十分钟且扩容无效
- 迁移后状态无法用账本解释
- 安全边界被突破

处置顺序：值班人先停新 run、关路由；回退构建由阶段负责人十分钟内拍板。

## 阶段回滚表

| 阶段 | 回滚动作 |
| --- | --- |
| S1 | 停服务，保留账本 |
| S2 | 关桥，在途 agent 置 paused_bridge_missing |
| S3 | 停新 run，等在途收口 |
| S4 | 撤问题版本，不动已固定的 run |
| S5 | 关面板与记忆路由，引擎账本继续 |
| S6 | 按手册退上一过门构建，仅在双向兼容窗口内 |
```

**测试：**

- Create: `tests/runbook.spec.ts`
  - 手册包含六个固定章节。
  - 回滚触发条件五条齐全；阶段回滚表六行齐全且与规格 11.5 行 1001 一致。
  - 手册里的每条 `pnpm gate --` 命令都能在 `scripts/gate-check.ts` 里找到对应子命令。
  - 值班表有姓名与联系方式占位；占位未填时演练检查判 fail。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/runbook.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add docs/runbook.md tests/runbook.spec.ts
git commit -m "docs(release): 交出值班手册与演练口径"
```

---

### Task 16：三圈 R0、R1、R2

**目标：** 把三圈的准入、运行范围与升圈规则写成可核对的文档（规格 11.6 行 1004-1012）。

**Files:**
- Create: `docs/trial-circles.md` —— 三圈正文。
- Create: `tests/trial-circle.spec.ts` —— 三圈条目的检查。

**步骤：**

1. 定三圈的准入条件（规格 11.6 行 1006-1010）。

R0 合成圈：开发与审计环境，假执行器与沙箱，全部注入，不上真实工作区。连续 3 天无 P1，G1 到 G5 对应项通过，回滚演练通过。

R1 只读圈：一个受信工作区与值班人，真实账本、只读工具、真实面板，记忆只到提议。连续 1 周无 P1，停点可读，提议无越权。

R2 受控圈：白名单工作区与流程，allowlist 写工具、人工批准、每日复盘。连续 2 周无 P1，事故 30 分钟内定位，手册演练通过。

2. 定升圈与退圈规则。升圈只升一级；出现 I1 到 I9 破坏或安全边界突破直接回 R0。

3. 定 R1 与 R2 的工作区白名单。白名单是总纲 §7 的开放项，本批定值并写进 G6 门记录；未填之前 R1 与 R2 都不启用。

4. 定 R2 的写工具边界。allowlist 写工具、人工批准、每日复盘三件都要落在记录里，不靠口头约定。

```markdown
# 三圈试用

| 圈 | 工作区范围 | 工具权限 | 记忆范围 | 准入条件 | 观察期 |
| --- | --- | --- | --- | --- | --- |
| R0 合成圈 | 无真实工作区，假执行器与沙箱 | 全部注入 | 不涉及 | 连续 3 天无 P1，G1 到 G5 对应项通过，回滚演练通过 | 3 天 |
| R1 只读圈 | 一个受信工作区（白名单待填） | 只读工具，真实面板 | 只到提议 | 连续 1 周无 P1，停点可读，提议无越权 | 1 周 |
| R2 受控圈 | 白名单工作区与流程（白名单待填） | allowlist 写工具、人工批准 | 可写 | 连续 2 周无 P1，事故 30 分钟内定位，手册演练通过 | 2 周 |

升圈只升一级。出现 I1 到 I9 破坏或安全边界突破，直接回 R0。
```

**测试：**

- Create: `tests/trial-circle.spec.ts`
  - 三圈的准入条件、观察期、回退规则在文档里逐字可查。
  - 升圈只升一级：R0 到 R1 到 R2 顺序在文档里写死；文档明确写了"越过 G6 直接进 R2"是不许的。
  - 白名单为空时 R1 与 R2 的启用检查判 fail。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/trial-circle.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add docs/trial-circles.md tests/trial-circle.spec.ts
git commit -m "docs(release): 交出三圈试用与升圈规则"
```

---

### Task 17：G6 门记录、发布包与安装说明

**目标：** 写 G6 门记录与两份 artifact，出发布包与安装说明（规格 13.5 行 1137-1143、14.6 行 1181-1187）。

**Files:**
- Create: `docs/gates/G6.md` —— G6 门记录正文。
- Create: `docs/gates/G6-independent.json` —— 独立人工 artifact（无 run）。
- Create: `docs/gates/G6-release.json` —— 发布大脑 artifact（有 run）。
- Modify: `README.md` —— 安装与使用说明。
- Modify: `package.json` —— 发布包清单。
- Create: `tests/gate-g6.spec.ts` —— 门记录的用例。

**步骤：**

1. 定两份 artifact 的分工。G1 到 G5 与 G6 独立 artifact 无 run；G6 发布大脑 artifact 有 run（规格 13.5 行 1139）。独立 artifact：`gate_run_id=null`、`run_terminal=not_applicable`、`producer=human`；发布 artifact：`gate_run_id` 指向门 run、`run_terminal` 直抄 `runs.status`、`producer=wf_release_v1`，并在门记录里登记。

2. 定门记录的内容。正文顺序：范围与候选构建（git_sha、phase=S6）、必过项逐条结果与证据编号、失败项、两份 artifact 的三字段一致性核对、六项未决参数的本批定值、回滚方案（回滚目标、动作、预计耗时与验证方式）、例外说明、结论。

3. 定锚点。结论之后是固定锚点，补记只追加在锚点后、不移动锚点、不算进哈希（规格 11.3 行 984、15.7 行 1234-1236）。

```markdown
# G6 门记录

候选构建：git_sha = <sha>，phase = S6

## 必过项

| 必过项 | 结果 | 证据编号 |
| --- | --- | --- |
| G-01 到 G-16 | pass | <evidence_ids> |
| 控制面读 p95 | pass | <evidence_ids> |
| 事件滞后窗口 | pass | <evidence_ids> |
| 24 小时浸泡 | pass | <evidence_ids> |
| 升级与回滚 | pass | <evidence_ids> |
| 值班手册演练 | pass | <evidence_ids> |
| 两份 artifact 三字段一致 | pass | <evidence_ids> |

## 未决参数定值

写队列上限与溢出策略、事件与证据保留期、记忆裁判模型与提示词版本、值班人与升级联系人、R1/R2 工作区白名单、24 小时浸泡采样频率与判定脚本——六项逐项写值。

结论：pass

artifact_hash=SHA256(canonical_json(artifact))
```

4. 定发布包。按总纲 §4.1 的 `files` 清单：`lib`、`cordis.patch.yml`、`orchestra.config.json`、`README.md`；安装说明写清 DSH 版本要求（`dsh >=0.2.2-0 <0.2.3-0`）、Node 版本（`^22.19.0 || >=24.0.0`）、安装步骤、配置文件位置与阶段切换方式。

5. 定门禁的硬约束。门记录缺失、批准人缺失、证据缺失任一不得进下一阶段（规格 13.5 行 1143）；没有门记录与批准人不得进下一阶段，例外不覆盖 I1 到 I9（规格 12.1 行 1037）。

**测试：**

- Create: `tests/gate-g6.spec.ts`
  - 两份 artifact 存在，`must_pass_items` 逐项有 `evidence_ids`，`failed_items` 为空。
  - 两份 artifact 的 `candidate_hash`、`evidence_index_hash`、`conclusion` 相同；`approver`、`approved_at`、`run_terminal`、`gate_run_id` 不同也不影响判定。
  - 独立 artifact 无 run（`gate_run_id=null`、`run_terminal=not_applicable`、`producer=human`）；发布 artifact 有 run 且 `run_terminal` 等于 `runs.status`。
  - 门记录正文结论之后有固定锚点行，锚点值等于对 artifact 本体算出的 SHA256(canonical_json(artifact))。
  - 六项未决参数在门记录里各有一行定值。
  - 缺门记录、缺批准人、缺证据三种情况下"进下一阶段"的检查判 fail。

**验收：**

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm gate --gate G6
```

期望：全绿；`pnpm gate --gate G6` 逐条输出必过项结论，任一条失败则门记录结论为 fail 且不得启用 R2。

**提交：**

```powershell
git add docs/gates/G6.md docs/gates/G6-independent.json docs/gates/G6-release.json README.md package.json tests/gate-g6.spec.ts
git commit -m "release: 交出 G6 门记录与发布包"
```

---

## 风险与回退

**风险与对冲**

1. 注入只有现象没有对账。风险：注入跑过就算过，出事时说不出账本哪一步变了。对冲：每条注入必须留下注入脚本与参数、前后账本片段、恢复后对账查询三样东西；缺对账查询的注入不算通过（规格 12.3 行 1077）。
2. 门结论靠人抄。风险：policy 节点读了 agent 摘要必过项，摘要被润色过，结论跟着偏。对冲：policy 确定性判必过项与阈值、不读 agent 摘要；approval 绑定候选哈希与证据集合，证据变则审批失效。
3. 告警当验收。风险：滞后超阈发过告警就算过。对冲：告警是运维动作，放行要求测量窗口全程 p95 不大于 2 秒且最大不大于 10 秒，窗口内任何一次超上限都不满足放行（规格 15.4 行 1218-1222）。
4. 升级把账本改坏。风险：新构建重写老 run 的行，历史解释不了。对冲：回滚只动构建与路由，账本只追加不回退；破坏性迁移先扩展再收缩；回滚在负载中演练。
5. 圈越级。风险：G6 没结论就放进真实工作区。对冲：升圈只升一级，出现 I1 到 I9 破坏或安全边界突破直接回 R0；G6 结论为 fail 时不许启用 R2。
6. 双份 artifact 漂。风险：人工那份与发布那份各写各的，事后对不上。对冲：一致性只比 candidate_hash、evidence_index_hash、conclusion 三个字段；不一致时以独立人工或 S5 构建那份为准（规格 15.3 行 1216）。
7. 开放参数拖成永久阻塞。风险："还没定"被当放行理由，门一直卡着。对冲：总纲 §7 的六项在本批逐项定值并写进 G6 门记录；定值前实现按规格默认值与安全侧行为运行。

**回退**

- 阶段回滚按规格 11.5 行 1001 的 S6 档：按手册退上一过门构建，且仅在双向兼容窗口内；账本不回退。
- 回滚触发后先止血：值班人停新 run、关路由；回退构建由阶段负责人十分钟内拍板。
- 升级中断：迁移可重入，已提交步骤不重复；没有旧构建时停 S1 修复（规格 12.3 G-01、G-14）。
- 记忆侧：出现 indeterminate 批次时先对账，不补写、不回滚、不重试；签字后 run 落 succeeded_with_unverified。
- 门记录侧：结论为 fail 时不进 R2；已写的 G6 记录按规格 15.7 只在锚点后追加补记，不改结论、不移动锚点。

---

## 完成定义

S6 完成的判定，同时满足以下每一条：

1. G-01 到 G-16 十六条注入全部跑过，每条留下注入脚本与参数、前后账本片段、恢复后对账查询三样东西；缺对账查询的不算数。
2. 控制面读四条性能线全部达标：`list_tasks` 一万条 p95 小于 100ms、`get_run` 一千节点 p95 小于 150ms、`list_nodes` 两条百 p95 小于 80ms、`list_events` 两条百 p95 小于 50ms；预热 3 次取第 4 次，SQL 计划不含全表扫描。
3. 事件滞后在测量窗口内全程 p95 不大于 2 秒且最大不大于 10 秒；窗口内任何一次超上限都不放行。
4. 24 小时浸泡跑满：无连接泄漏、无孤儿 run、无未收口事件、无持续增长的内存或磁盘异常，判定脚本与采样频率写进门记录。
5. 写路径单写者、短事务、busy_timeout 5000ms、队列上限 1000 与 `SERVICE_UNAVAILABLE`（503）溢出策略生效；单节点回传 payload 不超过 64KiB、摘要不超过 800 字。
6. 安全边界八项验收通过：匿名写拒绝、越权命令拒绝、actor 不可伪造、加载期两条 mutating 拒、runTool 非只读拒、trigger 未注册 effect 原语按 irreversible 要求审批、任务会话读写 storages 被拒、记忆直接写工具发布期拒。
7. 保留期与脱敏落地：artifact 过期显示「已过保留期」且不删账本事实，回执 7 天、在途 10 分钟，日志与导出里搜不到 token、密钥、完整 payload 与 executor 全量 transcript。
8. `wf_release_v1` 跑通：六组检查齐全、agent 不执行不写账本不批准、policy 确定性判定不读摘要、wait 超时记 blocked 并写清缺哪组、approval 绑定候选哈希与证据集合、branch 只读分流。
9. GateArtifact 规则成立：有 run 的门 `gate_run_id` 指向门 run、`run_terminal` 直抄 `runs.status`；无 run 的门 `gate_run_id=null`、`run_terminal=not_applicable`、`producer=human`；例外不能把 fail 改成 pass；artifact 内无自指哈希字段。
10. G6 两份 artifact 的 candidate_hash、evidence_index_hash、conclusion 三字段一致；门记录正文结论后有固定锚点 `artifact_hash=SHA256(canonical_json(artifact))`，补记只追加在锚点后。
11. 升级七步按序执行并留下记录；从上一版升级成功；双向兼容窗口内带负载回滚成功；回滚只动构建与路由，账本 `events.seq` 单调递增。
12. 值班手册六个章节齐全，回滚触发条件五条、阶段回滚表六行与规格一致；值班表与升级联系人名单已填；演练通过并留记录。
13. 三圈文档齐全：R0、R1、R2 的准入条件、观察期、白名单与回退规则逐条可查；升圈只升一级；白名单未填时 R1 与 R2 的启用检查判 fail。
14. 总纲 §7 的六项开放参数全部定值并写进 G6 门记录。
15. `pnpm check` 通过（typecheck + test + build），`pnpm gate --gate G6` 全绿。
16. 发布包与安装说明在位：`files` 清单为 `lib`、`cordis.patch.yml`、`orchestra.config.json`、`README.md`；README 写清 DSH 与 Node 版本要求、安装步骤与阶段切换方式。
