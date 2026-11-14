# S1 独立审计报告 · 第 55 轮（G1）

门：G1
候选提交：e0f96507add0021aa8c18a36d87c933f3c0f30cb
审计轮次：55
审计时间：2026-11-14 22:28–22:36（Asia/Shanghai）
审计方式：独立只读审计；未修改 src、tests、docs/gates 与已有 docs/audits 文件，未提交、未签门
候选范围：623939d..e0f9650 的代码、测试、脚本与证据；排除 `docs/gates/G1.md`、`docs/gates/G2.md`、`docs/audits`、`docs/reviews`、`handoff.md`；证据文件计入候选
环境：Windows / node v26.13.1 / pnpm 12.3.4

审计摘要：结论 fail；P0=0、P1=2、P2=7；failed_items 为空（13 项必过项全部通过）；候选 e0f96507…；审计开始时 `git status --porcelain` 为空，审计期间只新增本报告与 gitignore 的 tmp 探针。

## 一、结论

结论：fail

13 项必过项逐项实跑通过（13/13），P0=0、P1=2、P2=7，failed_items 为空。门级裁决为 fail，原因是 e0f9650 的 M-63 把 wait/subworkflow 唤醒从 `waiting→queued` 改成 `waiting→done` 后：控制节点完成时没有任何入口收口 run，run 会长期停在 `running`；等到后续某个入口收口时，控制节点又被判成未验证副作用，终态落 `succeeded_with_unverified`（P1-1、P1-2，探针已复现）。门记录与证据锚点仍是第 51 轮值，且 ev-g14 在 G1 签署后被重生成，`gate-check` 退出 1（P2-3）。审计开始时 `git status --porcelain` 为空，HEAD 为 e0f9650；工作树未被并行改动，未另建 worktree。

## 二、实测命令

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc --noEmit` 无输出 |
| `pnpm test` | 0 | 61 个测试文件，844 passed / 1 skipped（845），9.36s |
| `pnpm build` | 0 | tsdown 0.22.14；ESM `lib/index.js` 245.86 kB（gzip 59.37 kB），`lib/index.d.ts` 18.04 kB（gzip 4.39 kB），CJS `lib/client.js` 0.29 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 25 份证据每份重跑两遍，均与 HEAD 字节一致 |
| `pnpm vitest run tests/contract/execution-concurrency.spec.ts tests/integration/wait.spec.ts tests/integration/subworkflow.spec.ts tests/contract/routes.spec.ts` | 0 | 4 个文件，46 passed（其中 execution-concurrency 1/1） |
| `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` | 1 | 审计报告 sha256 与记录不符（P2-3） |
| `node --experimental-strip-types --no-warnings tmp/r55_probe.ts` | 0 | M-63 收口与终态探针，输出见 4.3 |

gate-check 原文：

```text
门检查失败（docs/gates/G1.md）：审计报告 sha256 与记录不符（报告改过就重新审计再签）：355a1a582b5584c0… != e3eee74611c3a681…
```

## 三、必过项逐项结论

| 必过项 | 复核内容 | 结果 | 依据 |
| --- | --- | --- | --- |
| G1-01 | 空库迁移可重复，账本无重复记账 | pass | ev-migrate；migrate.spec 9/9 |
| G1-02 | 迁移中途杀进程后可重入 | pass | ev-g14；g1.spec G-14 重跑只补 [902]（证据文件已重生成，记录哈希滞后见 P2-3） |
| G1-03 | 进程被杀不丢已提交事件 | pass | ev-g02；g1.spec G-02 重放拿到 seq=2 |
| G1-04 | 备份独立目录行数与哈希一致 | pass | ev-backup；backup.spec 6/6 |
| G1-05 | 损坏备份可检出 | pass | ev-g15；g1.spec G-15 截断检出 |
| G1-06 | 认证前置，匿名写返回 401 | pass | ev-auth；auth.spec 12/12 |
| G1-07 | 阶段开关未知值返回 SCHEMA_VERSION_UNSUPPORTED | pass | ev-phase；config.spec 11/11 |
| G-01 | COMMIT 前杀进程不留半条记录 | pass | ev-g01；g1.spec 未提交事务计数 0 |
| G-02 | COMMIT 后未投递被杀可重放 | pass | ev-g02；g1.spec 总条数 2 |
| G-08 | 长事务读不阻塞、第二写者 busy、队列溢出 503 | pass | ev-g08；g1.spec 对账行通过；assertion 偏弱见 P2-1 |
| G-09 | 订阅者离线重放无断号 | pass | ev-g09；g1.spec 连续无断号 |
| G-14 | 迁移一半杀后重跑只补一步 | pass | ev-g14；g1.spec schema_migrations 1..23,901,902、表数 23→25 |
| G-15 | 截断备份可检出、恢复请求被拦下、线上库不变 | pass | ev-g15；g1.spec 线上库未变 |

## 四、关键不变量复核

### 4.1 统一 Scheduler 双入口并发

`src/index.ts:98-112` 只定义一次 `executeNode`，并用 `const executeScheduled = (p) => runThroughScheduler(opts.scheduler, () => executeNode(p), { label: p.nodeId })` 包住同一个调度闸；`src/index.ts:206` 的 dispatch 命令把 `executeNode: executeScheduled` 传给 `dispatchRun`，`src/index.ts:219` 的 run-node 命令直接调 `executeScheduled`。`src/service/dispatcher.ts:56-72` 只查 `status='queued'` 的节点，dispatcher 不持有 scheduler，`dispatchOne` 只调用已过闸的 `deps.executeNode ?? runNode`，没有二次提交。`tests/contract/execution-concurrency.spec.ts:30-129` 用并发上限 2 的真实 scheduler，同时从 `/v1/runs/dispatch` 发 3 个节点、从 `/v1/node-runs/run` 发 3 个节点，断言 `started=6`、`maxActive=2`、`inFlight=0`、`waiting=0`，本轮 1/1 通过。两个入口共用同一闸，没有各占一个名额。

但“未显式传 Scheduler 时并发仍不超上限”只在 `serveOrchestra` 成立：`src/index.ts:290` 写 `opts.scheduler ?? schedulerFromConfig(...)`；直接调用 `openServiceOrchestra` 且不传 scheduler 时，`runThroughScheduler` 在 `src/service/execution-scheduler.ts:238` 对 undefined 直接 `await fn()`，闸门失效。探针 `tmp/r55_sched.ts` 并发提交 6 个任务得到 `maxActive=6`（默认并发上限是 3），见 P2-6。

### 4.2 M-63 对状态机与迁移表约束的影响

`src/core/state-machine.ts:163` 为 `{ id: 'M-63', from: ['waiting'], to: ['done'], trigger: 'wait-completed', requires: (c) => c.controlCompletion === true }`；`TransitionContext` 第 121 行有 `controlCompletion?: boolean`。独立计数：TRANSITIONS 60 条、from 合计 124、to 合计 73、requires 11 条，`MIGRATION_CASE_IDS` 含 M-01…M-63。`tests/integration/transition-rules.spec.ts` 与 `tests/integration/migration-cases.spec.ts` 在 844 passed 的全量里通过，`canReportTransition` 仍只认无 requires 的边，报告路径无法走 M-63。状态机与迁移表约束本身未被破坏；设计稿没有这一行，见 4.4 与 P2-5。

### 4.3 M-63 收口与终态分类（P1）

唤醒路径完成后没有任何入口调用 `closeRun`：

- `src/service/commands/wait.ts:135-150` 命中事件后先置 `wait_registrations` 为 woken，再 `applyTransition` `waiting→done`，只写 `wait.woken` 节点事件与 run 事件；
- `src/service/commands/subworkflow.ts:366-375` 子运行终态后同样 `waiting→done`，只写 `subworkflow.finished`；
- `src/service/sweep.ts:334-341` 调 `finishSubworkflowChild`，不调 `closeRun`；
- `src/service/server.ts:358-368` 的 `POST /v1/wait/events` 只 `queue.run(() => commands.wakeOnEvent(...))`。

全仓 `closeRun` 调用点只有 5 处：`src/index.ts:167`（decision 拒绝/过期）、`src/index.ts:234`（run-node 收口）、`src/service/dispatcher.ts:70`（dispatch 批次末尾）、`src/service/commands/decisions.ts:219`、定义 `src/service/commands/run-close.ts:23`。`serveOrchestra` 的 2 秒 sweep 也不收口 run。

探针 `tmp/r55_probe.ts`（`:memory:` 库，node 26.13.1）输出：

```text
WAIT_PROBE {"node":{"status":"done","side_effect_policy":"compensable","side_effect_verified_none":0},"runAfterWake":"running","evTypes":["wait.entered","wait.woken"]}
WAIT_CLOSE {"terminal":"succeeded_with_unverified","runAfterClose":"succeeded_with_unverified"}
SUB_FINISH {"parentNodeRunId":"np","status":"done"}
SUB_AFTER {"pnode":{"status":"done","side_effect_policy":"compensable","side_effect_verified_none":0},"runAfterChild":"running","sweptKeys":["lease_expired","fence_revoked","verify_timed_out","verify_uncertain","replay_heads","chain_broken","startup_unknown_expired","bridge_paused","bridge_restored","wait_timed_out","executor_orphaned","action_overrun","operations_timed_out","receipts_expired","subworkflow_finished","scanned_at"],"runAfterSweep":"running"}
SUB_CLOSE {"terminal":"succeeded_with_unverified","runAfterClose2":"succeeded_with_unverified"}
```

即：等待命中或子流程收口后节点是 done，但 run 仍是 running；sweep 执行后仍是 running；后续收口把控制节点计入 `unverified`，终态只能是 `succeeded_with_unverified`。分类根因在 `src/service/commands/run-close.ts:47`：`unverified = node.side_effect_policy !== 'pure' && node.side_effect_verified_none !== 1`；控制节点行由 `src/service/runs.ts:91-93`、`src/service/commands/nodes.ts:187`、`src/service/commands/subworkflow.ts:253` 插入时不指定 policy，DB 默认 `'compensable'`，`side_effect_verified_none` 默认 0（`src/infra/sqlite/migrations/017_parallel_groups.sql:4-5`）。`wait.ts:142` 传的 `context.sideEffectVerifiedNone: true` 只参与 requires 判定，`src/service/commands/nodes.ts` 的 PATCH_COLUMNS 不含该列，值没有落库。

### 4.4 与设计规格的冲突面

`docs/orchestra-design-draft.md:351` 的迁移表只写 M-21 `waiting → dispatched`（事件命中且抢到 slot），全 docs 搜 `M-63` 零命中；代码把唤醒改成 `waiting → done`，设计稿没有对应行。`src/service/commands/subworkflow.ts:339` 的注释仍写“只允许 waiting→dispatched；重复调用在看到 dispatched 时幂等返回”，与实现（done）相反。状态机实现与设计规格的迁移表不一致，见 P2-5。

### 4.5 哈希与证据逐份复核

按 HEAD 字节与 `canonicalJson` 独立重算：

| 哈希 | G1.md 记录 | 重算值 | 判定 |
| --- | --- | --- | --- |
| candidate_hash | 85dccd92100a… | 4cea0c81c35b4f8577ac0fb739b556f3120808c375c0cb57477d8b79d2caa056 | 滞后（P2-3） |
| change_scope_hash | 0079ed78768f… | 50df1f462a4c845f973d87a361ec830dace12698d8107970d6f9f76cc9fc43ba | 滞后（P2-3） |
| evidence_index_hash | 3ac6049c847e… | 3ac6049c847e4b02d9b4cfbb9ae0c47ce102985290e2c6d1b21a00642870933b | 一致 |
| invariants_hash | 6f75465bfb0e… | 6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6 | 一致 |
| artifact_hash | 1c0903777d79… | 6b059c8ab09be42d881ff1380d42d094d72e1a5d63d75a7ca22c9bf2fa0962ea | 滞后（P2-3） |
| body_hash | e3b7a0ddcb1c… | de722fe99c7d360882a173a725fb2107954850814ac9b92d130fcb9c09dd9acd | 滞后（P2-3） |
| audit_report_sha256 | 355a1a582b55… | e3eee74611c3a6818824ba7d4ac59c2a9047d95ab17346700ad55896e3f7306a | 滞后（P2-3） |

13 份证据逐份重算（LF 归一化），12 份一致，仅 ev-g14 不一致；其余失败来自记录锚点：

| 证据 | HEAD 前 12 位 | G1.md 记录前 12 位 | 比对 |
| --- | --- | --- | --- |
| ev-auth | d8593aff1f15 | d8593aff1f15 | 一致 |
| ev-backup | 3c1b2f975dc4 | 3c1b2f975dc4 | 一致 |
| ev-chain | cf2d60dd505d | cf2d60dd505d | 一致 |
| ev-epoch | 19be1852c1fb | 19be1852c1fb | 一致 |
| ev-g01 | f2626b30f9eb | f2626b30f9eb | 一致 |
| ev-g02 | 5fedb2e7539b | 5fedb2e7539b | 一致 |
| ev-g08 | 2f2a73ddbf25 | 2f2a73ddbf25 | 一致 |
| ev-g09 | e944a2b6bd29 | e944a2b6bd29 | 一致 |
| ev-g14 | c1da546054be | ec2b935dddae | 记录滞后（P2-3） |
| ev-g15 | 1699f60368dd | 1699f60368dd | 一致 |
| ev-gatecheck | ed7e65aeeec5 | ed7e65aeeec5 | 一致 |
| ev-migrate | 376dc6d6e087 | 376dc6d6e087 | 一致 |
| ev-phase | 1702657cdb40 | 1702657cdb40 | 一致 |

候选 225 个路径；`docs/gates` 下共 31 条：`docs/gates/G3.md`、G1 证据 6 份、G2 证据 20 份（G-03/04/05/07 + ev-g2-01..16）、G3 证据 4 份（G-06/G-12/G-16/full-suite）。G1 正文、表格与 artifact 三者一致：13 项全 pass、failed_items 为空、结论 pass；必过项 ID 与 `GATE_SPECS.G1.items` 的 13 项完全一致；证据表 13 行与 evidence-index 逐项同哈希同路径；不变量 4 条与固定常量一致。历史轮次行没有出现，不存在把历史失败行误判成本轮失败的情况。

### 4.6 测试覆盖缺口

`tests/contract/routes.spec.ts:364-367` 只断言 `woken=1`、节点 `status='done'`、`wait_deadline_at=null`，不断言 run 终态；`tests/integration/wait.spec.ts:60-66` 只断言节点 done 与 `rearm_generation=1`；`tests/integration/subworkflow.spec.ts` 只断言 waiting→done 与幂等；`tests/contract/execution-concurrency.spec.ts` 显式传 scheduler。四个文件合跑 46 passed，仍没有一条断言钉住“控制节点完成后 run 收口为 succeeded”或“终态分类正确”，见 P2-7。

## 五、P0 / P1

P0=0。

### P1-1 控制节点完成后没有入口收口 run，run 会停在 running

位置：`src/service/commands/wait.ts:135-150`、`src/service/commands/subworkflow.ts:366-375`、`src/service/sweep.ts:334-341`、`src/service/server.ts:358-368`。全仓只有 5 个 `closeRun` 调用点，唤醒路径一个都不在。

复现：

```text
node --experimental-strip-types --no-warnings tmp/r55_probe.ts
```

看 `WAIT_PROBE.runAfterWake=running` 与 `SUB_AFTER.runAfterChild=running`、`runAfterSweep=running`。等待型 run 在事件命中后再没有任何动作，`GET /v1/runs/:id` 会一直是 running；子流程型 run 即使 sweep 跑过也不会收口。

影响：run 无法正常终结，依赖 run 终态的清理、告警、复盘与父流程推进都会卡住。

### P1-2 控制节点被计入未验证副作用，终态只能落 succeeded_with_unverified

位置：`src/service/commands/run-close.ts:47`、`src/service/runs.ts:91-93`、`src/infra/sqlite/migrations/017_parallel_groups.sql:4-5`；`wait.ts:142` 与 `subworkflow.ts:373` 传的 `sideEffectVerifiedNone=true` 没有落库（`src/service/commands/nodes.ts` 的 PATCH_COLUMNS 不含该列）。

复现：同上探针的 `WAIT_CLOSE.terminal` 与 `SUB_CLOSE.terminal`，均为 `succeeded_with_unverified`。

影响：含 wait/subworkflow 节点的 run 即使收口也永远到不了 `succeeded`，把“控制节点无副作用”误报成“副作用未核实”，会污染恢复与人工复核队列。

## 六、P2

| 编号 | 级别 | 位置 | 说明 | 复现 / 状态 |
| --- | --- | --- | --- | --- |
| P2-1 | P2 | `scripts/fault-inject.ts:289` | G-08 的 busy 判据仍是 `String(busy.length > 0)`，任意写异常都会置真；`docs/gates/evidence/G1/G-08.md:20` 只写“第二个写者报 busy：true”，`tests/integration/g1.spec.ts:25` 只断言该字符串。HTTP 段对账串有 `HTTP=503` 但没有独立码值断言。建议断言错误码或消息含 busy/SQLITE_BUSY。 | 上轮 P2-1，仍存在 |
| P2-2 | P2 | `tests/integration/evidence-repro.spec.ts:8-13` | vitest 复现用例仍只覆盖 `['G1','G-01']` 与 `['G2','ev-g2-11']` 两条，脚本覆盖 25 条；第 8 行注释仍写“全量 35 份”。建议全量接入 CI/nightly 并修正注释。 | 上轮 P2-2，仍存在 |
| P2-3 | P2 | `docs/gates/G1.md` 证据表与 artifact 块 | 候选/正文/artifact/报告锚点仍是第 51 轮值（4.5 表）；ev-g14 在 `494d6e4` 被重生成，记录仍是旧哈希；`G1.md:49` 仍写“本机 pnpm 不可用”，实测 pnpm 12.3.4 可用。签署前需统一重算并更新 audit_round/audit_report。 | 上轮 P2-3，仍存在；`gate-check` 退出 1 |
| P2-4 | P2 | G1 候选范围 | 候选 225 个路径中含 `docs/gates/G3.md` 与 G2/G3 共 24 份证据，其他门的记录/证据改动会改变 G1 的 candidate_hash。建议签署窗口内冻结，或把其他门的记录与证据排除出 G1 候选。 | 上轮 P2-4，仍存在 |
| P2-5 | P2 | `docs/orchestra-design-draft.md:351`、`src/service/commands/subworkflow.ts:339` | 代码已有 M-63 `waiting→done`，设计稿迁移表仍只有 M-21 `waiting→dispatched`，注释仍写“只允许 waiting→dispatched”。建议同步设计稿与注释，并补 M-63 的 Gr/收口语义断言。 | 上轮 P2-5，仍存在且与实际实现差距扩大 |
| P2-6 | P2 | `src/index.ts:111-112,290`、`src/service/execution-scheduler.ts:238` | 只有 `serveOrchestra` 会补默认 scheduler；直接调 `openServiceOrchestra` 不传 scheduler 时 `runThroughScheduler` 直接执行，双入口并发上限失效。测试都走 `openServiceOrchestra` 且并发用例显式传 scheduler，未覆盖这条路径。建议在 `createOrchestra`/`openServiceOrchestra` 也补默认 scheduler，或把 scheduler 设为必填。 | 新增；`node --experimental-strip-types --no-warnings tmp/r55_sched.ts` 输出 `maxActive=6`（默认上限 3） |
| P2-7 | P2 | `tests/contract/routes.spec.ts:364-367`、`tests/integration/wait.spec.ts:60-66`、`tests/integration/subworkflow.spec.ts` | 唤醒用例只断言节点 done 与字段清理，没有断言 run 终态与终态分类；execution-concurrency 用例显式传 scheduler，没有覆盖未显式传 Scheduler 的装配。建议补“wait/subworkflow 完成后 run=succeeded”与“无 scheduler 装配仍受限”的回归。 | 新增；`pnpm vitest run` 上述 4 文件 46 passed 但 P1-1/P1-2 仍可复现 |

## 七、审计期间工作树变更（不属于候选）

审计开始时 `git status --porcelain` 为空，HEAD 为 e0f96507add0021aa8c18a36d87c933f3c0f30cb，未发现并行改动，未另建 worktree。审计期间未修改 src、tests、docs/gates 与已有 docs/audits 文件；只新增本报告 `docs/audits/S1-independent-audit-round55.md`（`docs/audits` 在 G1 excludes 内），以及 `tmp/r55_probe.ts`、`tmp/r55_hashes.ts`、`tmp/r55_sched.ts` 探针（`tmp/` 在 `.gitignore` 内，不进入候选）。报告写入前工作树是干净的；写入后 `git status --porcelain` 只应出现本报告这一条未跟踪文件。

## 八、裁决

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 55,
  "candidate_commit": "e0f96507add0021aa8c18a36d87c933f3c0f30cb",
  "conclusion": "fail",
  "p0": 0,
  "p1": 2,
  "p2": 7,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": [
    "G1-01",
    "G1-02",
    "G1-03",
    "G1-04",
    "G1-05",
    "G1-06",
    "G1-07",
    "G-01",
    "G-02",
    "G-08",
    "G-09",
    "G-14",
    "G-15"
  ],
  "failed_items": [],
  "notes": "13 项必过项全过；门级 fail 因 M-63 控制节点完成后无 closeRun（run 停在 running）且终态被判 succeeded_with_unverified。证据复现 25/25 与 HEAD 字节一致；候选 225 路径；G1 记录锚点与 ev-g14 仍是旧值，gate-check 退出 1；另有 G-08 弱断言、复现覆盖不足、跨门证据耦合、设计稿未同步与无 scheduler 装配缺口。"
}
```
<!-- audit-verdict:end -->
