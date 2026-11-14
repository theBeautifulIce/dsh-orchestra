# S1 独立审计报告 · 第 54 轮（G1）

门：G1
候选提交：c431cc8af1570b240f423e1d0376354142609890
审计轮次：54
审计时间：2026-11-14 22:14–22:35（Asia/Shanghai）
审计方式：独立只读审计；未修改源码、未提交、未签门
候选范围：623939d..c431cc8 的代码、测试、脚本与证据；排除 `docs/gates/G1.md`、`docs/gates/G2.md`、`docs/audits`、`docs/reviews`、`handoff.md`；证据文件计入候选
环境：Windows / node v26.13.1 / pnpm 12.3.4

## 一、结论

结论：pass

13 项必过项逐项实跑通过（13/13），P0=0、P1=0、P2=5，failed_items 为空。审计开始时 `git status --porcelain` 为空，HEAD 与 origin/main 均为 c431cc8。`gate-check` 退出 1 是签署前审计锚点滞后（P2-3），发生在证据与候选检查之前，不影响必过项判定；证据哈希、候选哈希与正文表由独立重算脚本复核。

## 二、实测命令

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc --noEmit` 无输出 |
| `pnpm test` | 0 | 61 个测试文件，844 passed / 1 skipped（845） |
| `pnpm build` | 0 | tsdown 0.22.14；ESM `lib/index.js` 245.47 kB（gzip 59.25 kB），`lib/index.d.ts` 18.04 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 25 份证据每份重跑两遍，均与 HEAD 字节一致 |
| `pnpm vitest run`（18 个证据/守卫文件） | 0 | 18 个文件，412 passed / 1 skipped（413） |
| `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` | 1 | 签署前审计锚点滞后（P2-3） |

gate-check 原文：

```text
门检查失败（docs/gates/G1.md）：审计报告 sha256 与记录不符（报告改过就重新审计再签）：355a1a582b5584c0… != e3eee74611c3a681…
```

18 个定向文件的关键计数：g1.spec 6/6（G-01、G-02、G-08、G-09、G-14、G-15 六个注入均通过）、gate-check 184 passed / 1 skipped、migration-cases 66、transition-rules 8、subworkflow 12、wait 8、sweep 19、routes 25、apply-report 61、audit-verdict 20、execution-concurrency 1、migrate 9、backup 6、auth 12、config 11、db-open 9、hash-chain 8、lease 7、report-transition 2。

## 三、必过项逐项结论

| 必过项 | 复核内容 | 结果 | 依据 |
| --- | --- | --- | --- |
| G1-01 | 空库迁移可重复，账本无重复记账 | pass | ev-migrate；migrate.spec 9/9 |
| G1-02 | 迁移中途杀进程后可重入 | pass | ev-g14；g1.spec G-14 重跑只补 [902] |
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

`src/index.ts:98-112` 只定义一次 `executeNode`，并用 `const executeScheduled = (p) => runThroughScheduler(opts.scheduler, () => executeNode(p), { label: p.nodeId })` 包住同一个调度闸；`src/index.ts:206` 的 dispatch 命令把 `executeNode: executeScheduled` 传给 `dispatchRun`，`src/index.ts:219` 的 run-node 命令直接调 `executeScheduled`。`src/service/dispatcher.ts:1-3,46` 明确 scheduler 不得由 dispatcher 持有，dispatch 只会调用已过闸的 `deps.executeNode`。`tests/contract/execution-concurrency.spec.ts` 用并发上限 2 的真实 scheduler，同时从 `/v1/runs/dispatch` 发 3 个节点、从 `/v1/node-runs/run` 发 3 个节点，断言 `started=6`、`maxActive=2`、`scheduler.inFlight=0`、`scheduler.waiting=0`，实测 1/1 通过。两个入口共用同一闸，没有各占一个名额。

### 4.2 gate-check 散文与表格裁决

`src/core/audit-verdict.ts` 的 `verdictProblems` 校验 gate/round/commit、结论、P0/P1、必过项总数与通过数、ids 覆盖与重复、failed_items；`scripts/gate-check.ts` 的 `proseVerdictClashes` 同时扫散文结论行、点名必过项的散文句、表格结论列、显式结论标记格与原始 Markdown 溢出列。历史表格行只在有轮次列、轮次严格早于当前轮、且无「本轮/当前轮」标记时豁免。`tests/gate/gate-check.spec.ts` 184 passed / 1 skipped，覆盖 A4/A5/A8/A9 系列表格攻击与历史轮次豁免；`tests/unit/audit-verdict.spec.ts` 20/20 覆盖重复、未知、缺失与多块裁决。用本报告文本做独立复核时，结论唯一、结构化裁决可解析。

### 4.3 证据逐份 sha256 重算与固定清单常量比对

`scripts/gate-check.ts` 的 `checkEvidence` 从 HEAD 读证据，按行尾 LF 归一化后逐份重算 sha256，并对照固定 `evidenceFiles` 清单检查 id/路径、重复与缺失；`checkBodyTable`、`checkBodyEvidenceTable`、`checkBodyInvariants` 把必过项内容、行序、结果列、证据列与不变量陈述钉成常量；`checkEvidenceMap` 钉每项证据映射。独立重算 13 份证据：12 份与 G1.md 记录一致，ev-g14 记录仍是旧值（P2-3）；正文证据表 13 行与 artifact 证据索引逐项一致。

### 4.4 四个哈希可重算

按 HEAD 字节与 `canonicalJson` 重算：`candidate_hash=2bf1aa1ea76d9853e42d2c1f40aaac07e1a20cff5c6a3fa190f763094dfd01c1`、`change_scope_hash=50df1f462a4c845f973d87a361ec830dace12698d8107970d6f9f76cc9fc43ba`、`evidence_index_hash=e6d07c3b84b86590c847f2a0a416f78f97b6a5a5621e95e7bc97b40125c7da22`、`invariants_hash=6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6`、`artifact_hash=6b059c8ab09be42d881ff1380d42d094d72e1a5d63d75a7ca22c9bf2fa0962ea`、`body_hash=de722fe99c7d360882a173a725fb2107954850814ac9b92d130fcb9c09dd9acd`。其中只有 `invariants_hash` 与 G1.md 记录一致，其余是第 51 轮重签后的旧锚点（P2-3），签署时由 `sign-gate.ts` 统一重算。

### 4.5 候选范围排除口径

G1.md 第 4 行的排除声明与 `scripts/gate-check.ts` 的 `GATE_SPECS.G1.excludes` 完全一致：只排 `docs/gates/G1.md`、`docs/gates/G2.md`、`docs/audits`、`docs/reviews`、`handoff.md`；证据文件计入。独立重算 `candidateEntries(GATE_SPECS.G1)` 得到 225 个路径（196 个净差异路径 + 29 个区间内历史增删路径的哨兵条目），`docs/audits` 零命中。候选仍包含 `docs/gates/G3.md` 与 G2/G3 共 24 份证据，跨门耦合见 P2-4。

### 4.6 M-63 对迁移表、规则计数与报告转换的影响

`src/core/state-machine.ts:162` 新增 `{ id: 'M-63', from: ['waiting'], to: ['queued'], trigger: 'wait-rearmed' }`，`MIGRATION_CASE_IDS` 同步加入 M-63，总数 63。`tests/integration/transition-rules.spec.ts:35-36` 断言 63 个 id、60 条迁移规则 + 2 条建行 + 1 条挂起闸门；`tests/integration/migration-cases.spec.ts:44-47` 断言规范化哈希 `48fecb63f273bec2463724a1c27bdfb06e6509f0cf89c6fa1d405423e0094d4d`、from 合计 124、to 合计 73，均通过。唤醒路径：wait.ts 事件命中后 `waiting→queued` 并清租约、bump rearm_generation；subworkflow.ts 子运行终态后 `waiting→queued`、清 wait_started_at 与租约、重复调用幂等；sweep.ts 认 `queued`；routes 断言唤醒后节点为 queued。`canReportTransition` 未改，report-transition 2/2、apply-report 61/61 通过。M-63 未破坏迁移表、规则计数与报告转换；口径未同步见 P2-5。

## 五、证据哈希复核

按 HEAD 字节、LF 归一化重算，前 12 位如下：

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

## 六、P0 / P1

P0=0，P1=0。本轮没有需要给出文件行号与复现命令的 P0/P1 项。

## 七、P2

| 编号 | 级别 | 位置 | 说明 | 复现 |
| --- | --- | --- | --- | --- |
| P2-1 | P2 | `scripts/fault-inject.ts:243,289` | G-08 的 busy 判据取 `busy.length > 0`，任意写异常都会置真；本意是 SQLITE_BUSY。g1.spec 也只断言「第二个写者报 busy：true」。建议断言错误码或消息含 busy/SQLITE_BUSY。 | `node --experimental-strip-types --no-warnings scripts/fault-inject.ts --case G-08 --out <临时目录>` |
| P2-2 | P2 | `tests/integration/evidence-repro.spec.ts:11-14` | vitest 复现用例只覆盖 G1/G-01 与 G2/ev-g2-11 两条，脚本覆盖 25 条；用例注释仍写「全量 35 份」，与脚本实际 25 份不符。建议全量接入 CI/nightly 并修正注释。 | 读用例 CASES；跑 `node --no-warnings scripts/check-evidence-repro.ts` |
| P2-3 | P2 | `docs/gates/G1.md` 证据表与 artifact 块 | 候选/证据/报告锚点仍是第 51 轮重签值：candidate_hash 记录 85dccd92… / 重算 2bf1aa1e…；change_scope_hash 0079ed78… / 50df1f46…；evidence_index_hash 3ac6049c… / e6d07c3b…；artifact_hash 1c090377… / 6b059c8a…；body_hash e3b7a0dd… / de722fe9…；audit_report_sha256 355a1a58… / 实际 e3eee746…；ev-g14 ec2b935d… / c1da5460…。G1.md:49 仍写「本机 pnpm 不可用」，实测 pnpm 12.3.4 可直接跑。签署时统一重算即可。 | `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` |
| P2-4 | P2 | G1 候选范围 | 候选 225 个路径中包含 `docs/gates/G3.md` 与 G2/G3 共 24 份证据；其他门记录/证据的改动会改变 G1 的 candidate_hash。建议签署窗口内冻结，或把其他门的记录与证据排除出 G1 候选。 | 调 `candidateEntries` 后过滤 `docs/gates` |
| P2-5 | P2 | `docs/orchestra-design-draft.md:272,351`、`src/service/commands/subworkflow.ts:335` | M-63 已落地，但设计稿迁移表仍写 `waiting → dispatched`（M-21），未列 M-63；subworkflow 唤醒的文档注释仍写「只允许 waiting→dispatched」。另外 wait.ts 唤醒 bump rearm_generation，subworkflow.ts 唤醒不 bump，两条唤醒路径的 Gr 语义没有测试钉住。建议同步设计稿与注释，并补一条 M-63 的 Gr 断言。 | 读设计稿 §8 与上述源码注释；跑 wait/subworkflow 用例 |

## 八、审计期间工作树变更（不属于候选）

审计开始时 `git status --porcelain` 为空；全部实测命令在 22:19 前完成。此后有并行进程在 22:21:38–22:22:11 改动了 6 个文件：`src/core/state-machine.ts`、`src/service/commands/subworkflow.ts`、`src/service/commands/wait.ts`、`src/service/sweep.ts`、`tests/integration/subworkflow.spec.ts`、`tests/integration/wait.spec.ts`（把 M-63 从 `waiting→queued` 改成 `waiting→done`）。这些改动不在候选 c431cc8 内，也没有参与本报告的任何实测；本报告只对 c431cc8 的 HEAD 内容负责。签署前若保留这些改动，`assertClean` 会拒绝签署；若要作为新候选提交，需要另开一轮独立审计。

## 九、裁决

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 54,
  "candidate_commit": "c431cc8af1570b240f423e1d0376354142609890",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 5,
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
  "notes": "证据复现 25/25 与 HEAD 字节一致；候选 225 个路径，G1/G2 门记录自身排除、证据计入；typecheck/test/build 退出码均为 0；P2 为弱 busy 断言、复现覆盖不足、签署前锚点滞后、跨门证据耦合与 M-63 口径未同步。"
}
```
<!-- audit-verdict:end -->
