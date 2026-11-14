# S1 独立审计报告 · G1 第 58 轮

门：G1
候选提交：837b0c6bcf9382f54b0d9abce07cabeadf430cd0
审计日期：2026-11-14
审计方式：独立审计；未签门、未改生产代码
审计树：`C:\Users\ASUS\AppData\Local\Temp\orch-audit-r58`（detached 于候选提交，审计后已移除）

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 58,
  "candidate_commit": "837b0c6bcf9382f54b0d9abce07cabeadf430cd0",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 4,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": ["G1-01", "G1-02", "G1-03", "G1-04", "G1-05", "G1-06", "G1-07", "G-01", "G-02", "G-08", "G-09", "G-14", "G-15"],
  "failed_items": [],
  "notes": "本轮生产代码只改 subworkflow 取消路径；13 项必过项按 HEAD 证据与测试逐项复算通过。P2-1 为 G1 记录未重签导致的锚点与哈希过期（签署前预期）；P2-2/P2-3 为 round56 结转；P2-4 为本轮新增取消路径的裁决收口口径问题，不影响 G1。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 4；必过项 13/13 通过，failed_items 为空。P2 只记录、不阻断本轮重签。

## 2. 候选与审前状态

- 候选 `837b0c6bcf9382f54b0d9abce07cabeadf430cd0` 与任务给定一致；审计时 `main` 指向它，主工作树 `git status` 干净，已推 `origin/main`。
- 上一提交为 `df2fc08`（round57 已对 `df2fc08` 出具 pass 报告）。本轮相对上一提交改动 7 个文件、+778/-9：
  - `docs/audits/S1-independent-audit-round57.md`、`S2-round57.md`、`S3-round9.md` 新增；
  - `docs/gates/G3.md` 与 `docs/gates/evidence/G3/full-suite.md` 小改；
  - 生产代码只有 `src/service/commands/subworkflow.ts`（+42）；
  - `tests/integration/subworkflow.spec.ts`（+27）。
- 迁移、状态机、调度装配、账本与认证代码均不在本轮 diff 内。
- 干净树内 `pnpm install --frozen-lockfile` exit 0（239 个包）。

## 3. 实测命令与退出码

| 命令 | 退出码 | 结果摘要 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc --noEmit`，无输出 |
| `pnpm test` | 0 | 61 个测试文件；856 passed / 1 skipped（857）；耗时 9.75s |
| `pnpm build` | 0 | tsdown 成功；`lib/index.js` 251.67 kB，`lib/client.js` 0.29 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 25 份证据，每份重跑两遍均与 HEAD 字节一致 |
| `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` | 1 | 唯一报错：审计报告 sha256 `355a1a582b5584c0… != e3eee74611c3a681…`，即门记录未重签（见 P2-1） |

测试日志、构建日志、证据复现日志与哈希复算日志保存在 `%TEMP%\orch-audit-r58-*.log`。

## 4. 13 项必过项逐项复核

| 必过项 | 要求 | 结果 | 复算依据 |
| --- | --- | --- | --- |
| G1-01 | 迁移空库可重复 | 通过 | `tests/integration/migrate.spec.ts`：空库一次跑全量并建齐核心 15 表；第二次返回空；已跑迁移 checksum 被改后拒载；中途中断可重入只补缺项 |
| G1-02 | 迁移中途杀可重入 | 通过 | `docs/gates/evidence/G1/G-14.md` + `tests/integration/g1.spec.ts`：第一步提交后、第二步前杀进程；重跑只补 [902]；`schema_migrations=[1..23,901,902]`；表数 23→25 |
| G1-03 | 进程杀不丢已提交事件 | 通过 | `docs/gates/evidence/G1/G-02.md` + `g1.spec.ts`：COMMIT 后、投递前杀进程；恢复后 2 条已提交事件；`fromSeq=1` 重放拿到 1 条 |
| G1-04 | 备份独立目录行数与哈希一致 | 通过 | `tests/integration/backup.spec.ts`：备份目录含 `orchestra.db` + `manifest.json`；逐表行数与线上一致；`db_sha256` 与文件一致 |
| G1-05 | 损坏备份可检出 | 通过 | `docs/gates/evidence/G1/G-15.md`：截断到一半可检出；恢复请求被挡下；线上库大小与 sha 不变 |
| G1-06 | 认证拒匿名写 | 通过 | `tests/contract/auth.spec.ts:97-113`：匿名写返回 401 UNAUTHORIZED；自报 actor 无效；actor 由密钥派生 |
| G1-07 | 阶段开关拒未知值 | 通过 | `tests/unit/config.spec.ts:41-44`：`phase=S7` 返回 SCHEMA_VERSION_UNSUPPORTED；未知键与越界值均挡下 |
| G-01 | 事务 COMMIT 前杀进程 | 通过 | `docs/gates/evidence/G1/G-01.md`：COMMIT 前杀进程；events 条数 1（期望 1）；未提交事务不留半条记录 |
| G-02 | COMMIT 后未投递被杀 | 通过 | `docs/gates/evidence/G1/G-02.md`：恢复后 2 条已提交事件；重放 `fromSeq=1` 拿到 1 条 |
| G-08 | 长事务读不拖死、写报 busy、队列溢出 503 | 通过 | `docs/gates/evidence/G1/G-08.md`：busyTimeout 30ms、queueMax 2、httpQueueMax 1；第二写者 busy；队列溢出 SERVICE_UNAVAILABLE；HTTP 503 |
| G-09 | 订阅者离线重放 | 通过 | `docs/gates/evidence/G1/G-09.md`：订阅者离线 `fromSeq=1`；补 3 条；重放 seq 2、3、4 连续无断号 |
| G-14 | 迁移一半杀后重跑 | 通过 | `docs/gates/evidence/G1/G-14.md` + `g1.spec.ts`：重跑只补 [902]；`schema_migrations` 等于动态迁移版本表 + 901 + 902；表数 23→25 |
| G-15 | 备份截断能检出、恢复被挡、线上库不变 | 通过 | `docs/gates/evidence/G1/G-15.md`：截断可检出；恢复请求被挡下；线上库不变 |

复核口径：证据文件按 HEAD 字节与记录值逐份比对，12/13 与记录一致（ev-g14 的偏差属门记录未重签，见 P2-1）；`g1.spec.ts` 的 6 条故障注入用例在 `pnpm test` 中全过，`check-evidence-repro` 又把 25 份证据各重跑两遍并做字节比对。

## 5. 审查重点一：调度闸的三问

1. `/v1/runs/dispatch` 与 `/v1/node-runs/run` 是否共用同一个 `executeScheduled`：是。`src/index.ts:111-112` 只构造一个 `executeScheduled = runThroughScheduler(opts.scheduler, () => executeNode(p), { label: p.nodeId })`，在 `:211` 作为 `commands.dispatch` 的 `executeNode` 注入，在 `:224` 由单节点 `runNode` 直接调用；`src/service/dispatcher.ts` 不再持有 scheduler。
2. 未显式传 Scheduler 时是否有共享回退调度器：是。`src/service/execution-scheduler.ts` 在模块级创建 `fallbackScheduler = createExecutionScheduler()`，`runThroughScheduler(scheduler, fn, opts)` 取 `(scheduler ?? fallbackScheduler).run(...)`；缺省上限为并发 3、人工名额 1、排队 1000。
3. 是否用真实最大并发数断言：是。`tests/contract/execution-concurrency.spec.ts:30-129` 用真实 HTTP 同时提交 6 个节点（3 个走 dispatch、3 个走直跑），并发设为 2，断言 6 个请求全 200、全部 done、`started===6`、`maxActive===2`、`scheduler.inFlight===0`、`scheduler.waiting===0`；`tests/unit/execution-scheduler.spec.ts` 另用缺省调度器跑“上限+3”个任务，断言 `maxActive===DEFAULT_EXECUTION_CONCURRENCY`（3），并有“dispatcher 只调注入函数、无二次排队”的断言。

结论：三问都为“是”，本轮候选无回归。

## 6. 审查重点二：账本、迁移与状态迁移

- 本轮 diff 未触及 `src/core/state-machine.ts`、`src/infra/sqlite/migrations/*`、`src/service/commands/cancel.ts`、`src/service/commands/nodes.ts`。
- 迁移共 23 个文件（001…023）；`005_append_only_events.sql` 与 `007_node_run_events_append_only.sql` 用 BEFORE UPDATE/DELETE 触发器守住 events 与 node_run_events 只追加，`012`/`013` 守链头递增与 REPLACE 路径；`src` 内没有对 events / node_run_events 的 UPDATE 或 DELETE 语句。
- 状态机：`TRANSITIONS` 62 条，`MIGRATION_CASE_IDS` 65 个（含 M-01…M-65），`CREATION_RULES` 为 M-01/M-58，挂起闸门为 M-56；`migration-cases.spec.ts` 断言整表指纹 `3090dc470b16d12c04fbcb31064d0a107382ccd07ce6d94984a74a9fc5c360a6`、62 条规则、from 和 126、to 和 75、requires 13 条、65 个 id 全覆盖；`transition-rules.spec.ts` 断言 62 状态规则 + 2 建行 + 1 挂起闸门 = 65。
- 节点状态迁移统一走 `applyTransition`（取消路径经 `applyCancel` 也落到它）；唯一例外是租约获取的 `queued→leased→dispatched`，它是规格 4.3 的独立 CAS（`src/service/commands/lease.ts:59-95`），不在迁移表内，本轮未改。
- 本轮新增的取消代码对节点状态使用 `applyTransition`（blocked_pre→failed）与 `applyCancel`（queued/leased→superseded）；对 decisions 行的收口是直接 UPDATE（见 P2-4）。

## 7. 审查重点三：837b0c6 的 subworkflow 取消修复是否破坏 G1 语义

- 修复内容（`src/service/commands/subworkflow.ts:477-534`）：run 级取消时，`blocked_pre` 节点若挂着 decision，先把 decision 置为 `resolved` + `expired_final`，再用 `applyTransition` 把节点 blocked_pre→failed 并清空 `resume_state`/`blocked_decision_id`/`wait_started_at`，写 `cancel_blocked_pre` 事件；不可逆节点只在 `dispatched/started/waiting/verifying` 才跳过，`queued/leased` 的不可逆节点改走 `applyCancel` 的作废分支（M-62 queued/leased→superseded）。
- 语义核对：M-39（queued/leased/dispatched→blocked_pre）、M-40（blocked_pre→queued）、M-41（blocked_pre→failed）未改；`blocked_pre→failed` 走 M-41 合法；decision 的 `resolved` + `expired_final` 与 `src/service/commands/decisions.ts:271` 的超时过期路径同口径；M-62 与 queued/leased 作废路径未改。修复只收窄“取消后节点永久卡在 queued/blocked_pre”的缺口，不触碰认证、迁移、备份、账本链与调度装配。
- 测试：`tests/integration/subworkflow.spec.ts:249-275` 新增两条用例（blocked_pre 取消后 decision=resolved/expired_final、节点 failed、run=cancelled；queued 不可逆节点取消后 superseded、run cancelled），全过；`pnpm test` 由 round57 的 854 passed 增至 856 passed，增量与新增用例数一致。
- 结论：本轮修复没有破坏 G1 语义，也没有引入 P0/P1；round57 的 P2-1（run 级取消跳 queued 不可逆节点导致卡死）在本候选已闭合。

## 8. 审查重点四：门记录、证据与哈希复算

`gate-check` exit 1 停在审计锚点，按 `verifyGateRecord` 的顺序，后面的 artifact/证据/不变量/候选/body 自锚不会被执行，因此另做独立复算：

| 哈希 | 门记录值 | 独立复算值 | 结论 |
| --- | --- | --- | --- |
| candidate_hash | `85dccd92100aab9352184508fb2882f533ce93ea066c0e91c9ffbadbbd305f97` | `2260e832f2cbb520f1a679b6b68bc1c1972dd3b26a8cba879e28bb0de8e2c7d6` | 过期（候选范围已推进到 225 个文件） |
| change_scope_hash | `0079ed78768fabd7beed450d5a51089508b3118501cdd8d4526005e894d35802` | `50df1f462a4c845f973d87a361ec830dace12698d8107970d6f9f76cc9fc43ba` | 过期 |
| evidence_index_hash | `3ac6049c847e4b02d9b4cfbb9ae0c47ce102985290e2c6d1b21a00642870933b` | `e6d07c3b84b86590c847f2a0a416f78f97b6a5a5621e95e7bc97b40125c7da22` | 过期（ev-g14 记录哈希与 HEAD 不符） |
| invariants_hash | `6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6` | `6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6` | 一致 |
| artifact_hash | `1c0903777d79bf86ed0ebc6ff54349965dbd4778e429b155b494fba2b7875b97` | `6b059c8ab09be42d881ff1380d42d094d72e1a5d63d75a7ca22c9bf2fa0962ea` | 过期 |
| body_hash | `e3b7a0ddcb1ca23d2d0da7d8b42c8d02dbe2a24a6a0c61aca7d32e4b214ba22f` | `de722fe99c7d360882a173a725fb2107954850814ac9b92d130fcb9c09dd9acd` | 过期 |

- 审计报告锚点：记录 `audit_report_sha256=355a1a582b5584c0c4e0d96be69a651b013021b837b396079642d4c4782996f9`，`docs/audits/S1-independent-audit-round51.md` 在 HEAD 的实际 sha256 为 `e3eee74611c3a6818824ba7d4ac59c2a9047d95ab17346700ad55896e3f7306a`。记录值仍是 round50 的哈希。
- 证据索引 13 条全部在 HEAD 存在；12 条按 LF 归一与记录一致；唯一偏差是 ev-g14：记录 `ec2b935dddae3395997de961e9fee3cec2d77826e67914ac3cb37ea2aafd9052`，HEAD 实际 `c1da546054be4fd95ecbb399ee4604b6706647e5a093a3fb1b8e551eb37ed739`。
- 候选范围 `623939d4..837b0c6` 共 225 个改动文件；`837b0c6..HEAD` 在门 excludes 范围内无改动。
- 原因：G1 记录自 round51 起未重签。`0a576ea` 把 artifact 的 `audit_round` 从 50 改为 51、`audit_report` 指向 round51 报告，却保留 round50 的 `audit_report_sha256`；`166ca70` 又改了 G1 正文的“候选：”一行。因此审计锚点、artifact_hash、body_hash、evidence_index_hash、candidate_hash、change_scope_hash 当前都无法复算通过；`invariants_hash` 仍自洽。重签时 `scripts/sign-gate.ts` 会按 HEAD 字节重算并回写全部哈希，属签署前预期，记 P2-1，不判 fail。
- G2 记录同样仍锚 round51（`artifact_hash=c5b4564a…`、`body_hash=daec42cc…`）；G3 记录六个哈希全 0（未签）。二者属各自门未重签，不在 G1 13 项裁决范围内。

## 9. 问题清单

| 级别 | 编号 | 主题 | 是否阻断重签 |
| --- | --- | --- | --- |
| P0 | — | 无 | — |
| P1 | — | 无 | — |
| P2 | P2-1 | G1 门记录未重签，锚点与五个哈希过期 | 否（重签即清） |
| P2 | P2-2 | M-64 的 controlCompletion 前置可被无 requires 的 M-48 绕过 | 否（round56 结转） |
| P2 | P2-3 | gate-check 旧词法兜底对表格历史轮次不豁免 | 否（round56 结转，fail-closed） |
| P2 | P2-4 | 取消 blocked_pre 时 decisions 行直接 UPDATE，未走统一收口 | 否（G1 语义不受影响） |

### P2-1 G1 门记录未重签

- 位置：`docs/gates/G1.md` artifact 与正文。
- 事实：`audit_round=51` 指向 round51 报告但 `audit_report_sha256` 仍是 round50 的 `355a1a58…`；HEAD 实际 round51 报告哈希为 `e3eee746…`；artifact 在 `0a576ea` 被手改后未重签，正文在 `166ca70` 被改后未重算 body_hash；ev-g14 在迁移 023 落地后重新生成，证据索引仍记旧哈希。
- 影响：`node scripts/gate-check.ts docs/gates/G1.md` exit 1，报审计报告 sha 不符；其余哈希当前也不能复算通过。
- 处置：重签时按固定顺序提交本轮审计报告 → 运行 `sign-gate.ts` 重算证据索引与全部哈希 → `gate-check.ts` 两门 exit 0。属签署前预期，记 P2，不阻断。

### P2-2 M-64 前置可被 M-48 绕过

- 位置：`src/service/commands/nodes.ts:80-156`。
- 事实：`applyTransition` 只在 `candidates.every(rule => rule.requires !== undefined)` 时校验 requires；`waiting→failed` 同时命中 M-64（requires `controlCompletion===true`）与 M-48（NON_TERMINAL→failed，无 requires），`every` 为假，于是跳过 requires 校验。
- 复现：round56 探针输出 `threw=false, node=failed`；本轮 diff 未触及 `nodes.ts`，问题仍在。
- 影响：G1 13 项不覆盖该路径；属状态机守卫的纵深防御缺口，记 P2 结转。

### P2-3 gate-check 旧词法兜底不豁免表格历史轮次

- 位置：`scripts/gate-check.ts:1628-1681`（`auditConclusionOf`）与 `:1715-1734`（`historicalTableRows`）。
- 事实：无结构化裁决块的旧报告走词法兜底时，`auditConclusionOf` 对表格单元格逐个调用 `cellFailStatement`，没有套用 `historicalTableRows` 的轮次豁免；含“历史第 N 轮否决”表格行的旧报告会解析不出唯一结论而返回 null。
- 影响：fail-closed，不会放过坏报告，但会误伤合规的历史记录；带结构化裁决块的新报告（含本轮）走 `proseVerdictClashes`，表格历史行有豁免，不受影响。记 P2 结转。

### P2-4 取消 blocked_pre 时 decisions 行直接 UPDATE

- 位置：`src/service/commands/subworkflow.ts:492-497`。
- 事实：对 `blocked_decision_id` 直接 `UPDATE decisions SET status='resolved', closed_reason='expired_final', revision=revision+1, decided_at=?`，未带 revision CAS、未检查 `changes===1`，也未写 `decision.resolved` 运行事件；统一收口路径 `src/service/commands/decisions.ts:177-209` 会做 CAS 并追加该事件。另外 `blocked_pre→failed` 复用 M-41（approval-rejected）语义，取消与审批拒绝在迁移表里同规。
- 影响：G1 语义与哈希链不受影响；属裁决收口的可观测性与并发防护口径不一致，记 P2。建议后续把这段并回统一收口（或至少补 `changes===1` 校验与 `decision.resolved` 事件）。

## 10. failed_items

```json
[]
```

## 11. 审计边界与后续

- 本轮只做审计：未签 G1/G2/G3，未改生产代码与门记录；审计报告写入主工作树，尚未提交。
- 重签前需要先把本报告提交，再按既定顺序运行 `sign-gate.ts` 与 `gate-check.ts`；P2-1 的哈希偏差会在重签时被全部重算。
- 临时 worktree `%TEMP%\orch-audit-r58` 已在审计完成后移除，主工作树未被改动。
