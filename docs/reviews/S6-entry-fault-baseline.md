# S6 Task 1 入场基线与首项修复

检查时工作区为 `codex/s5-g5-acceptance`，HEAD 为 `f3cd07a007cc07420c1878be844a3868a5ff1588`，Node 为 `v26.13.1`。脚本输出、独立临时账本和日志均定向到 `tmp/s6-entry/`。`G-10` 中的工作流版本发布仅发生在它自建的合成账本中。

签署前的基线提交与五门签署提交 8abbf0f 之间仅有正式门记录变更。以下结果可作为 S6 工作的起点。

## 修复前的 Task 1 入口

| 计划项 | 实际状态 |
| --- | --- |
| 报告形状 | `scripts/fault-inject.ts:46` 的 `InjectionResult` 含 `case`、`params`、`before`、`after`、`reconcile`。`writeEvidence` 在第 93 行输出 Markdown。本轮复核了 15 个文件的参数、前后账本、对账四个区块。`reconcile` 是结果字符串，G-11 的字符串内容为 JSON。统一的可执行查询、结构化计数、`extra` 和 `passed` 仍待接入。 |
| 案例登记和调用 | `scripts/fault-inject.ts:1561` 的 `runCase(name)` 使用 `switch` 登记 15 个 G 案例，另有旧 G2 证据入口。调用 API 尚无 `runFaultCase(id, params)` 或统一阈值判定。G-13 未登记。G-99 直接调用会返回 `undefined`，CLI 随后在 `writeEvidence` 读 `params` 时抛 `TypeError`。 |
| 固定对账 SQL | 现有用例按各自 SQL、读路径或事件结果拼接输出。统一计算 `half_rows`、`orphan_runs`、`missing_events` 的固定 SQL 和分案例 `extra` 尚待实现。 |
| 备份、副本校验和只读回放 | `src/infra/backup.ts:31` 已有 `backup`、`verifyBackup`、`restore`，校验用只读连接，`restore` 先校验再复制。恢复目的由调用者传入，本轮测试用独立目录并以只读连接查询恢复副本。源库字节数和 SHA-256 不变由既有备份用例核对。 |
| 短演练与长浸泡 | CLI `--case` 执行单个场景，现有场景各自定义窗口。Task 1 的统一时长策略和独立 24 小时浸泡入口尚待落实。 |
| 框架验收 | `tests/integration/fault-harness.spec.ts` 缺失。类型检查退出 `0`。既有备份与 G-11 测试退出 `0`，2 个文件、7 项通过。 |

## 逐项实跑

对已登记项分别执行 `node --no-warnings scripts/fault-inject.ts --case <ID> --out tmp/s6-entry/evidence`，`TEMP` 和 `TMP` 指定为 `tmp/s6-entry/scratch` 的绝对路径。每条以独立的进程和临时账本运行。原始 stdout JSON 和 stderr 日志保存在签署工作树的 tmp/s6-entry/。G-08 可用结果单独保存在 `G-08.loopback.json`。退出码表示进程执行结果。

| 项 | 退出码 | 本次对账观察 |
| --- | --- | --- |
| G-01 | 0 | COMMIT 前杀子进程，事件与杀前相同，均为 1 条。 |
| G-02 | 0 | COMMIT 后杀子进程，从 `fromSeq=1` 重放到 `evt_committed`，总计 2 条。 |
| G-03 | 0 | 第二次同 ID 上报为 `replayed`，`report_applied` 和登记行各 1 条。 |
| G-04 | 0 | 迟到上报返回 `LEASE_EXPIRED`，节点仍为 `dispatched`，attempt 和 action generation 均为 1。 |
| G-05 | 0 | 工具在途两次取消只立 1 次围栏，旧代次收口被拒，宽限扫描后节点为 `stopping`。 |
| G-06 | 0 | 模拟丢失工具应答后重提同一 callId，工具执行 1 次，两次拿到退出码 0，outbox 为 `completed`。S6 计划的不可确定副作用对账另需验证。 |
| G-07 | 0 | 墙钟前后各跳十分钟和跨 boot 均判不确定，节点仍为 `dispatched`。 |
| G-08 | 0（回环重跑） | 长写事务中读得 1 条、第二写者报 busy，HTTP 超限返回 `503 SERVICE_UNAVAILABLE`。脚本直接队列上限 2，HTTP 队列上限 1。默认沙箱连接 `127.0.0.1` 遇 `EACCES`，首次退出 1，放行本机回环后重跑退出 0。S6 的 1000/1001 与读 p95 仍待验证。 |
| G-09 | 0 | 从游标重放得到 `2,3,4`，序号连续。现有执行为三个事件的短场景。 |
| G-10 | 0 | 合成账本内发 v2 后，已有 run 绑定 v1，新 run 绑定 v2。 |
| G-11 | 0 | 实际中断写进程，inspect 检出全写、事务回滚、部分写入三种情况下分别写入 2、0、1 项，三种均记录证据。报告中的部分写入 `source_run` 为 `succeeded`，S6 计划的签字后 `succeeded_with_unverified` 需要独立验收。 |
| G-12 | 0 | 第二次同 revision 审批被拒为 `DECISION_REVISION_CONFLICT`，决策 revision 最终为 2。S6 计划的 operation_id 重放回执未由本场景覆盖。 |
| G-13 | 1 | 在途 run 的构建升级/回滚注入未登记，CLI 读取空结果报 `TypeError`，无证据产物。 |
| G-14 | 0 | 迁移中断后重跑只补第 902 步，第 901 步未重复执行。 |
| G-15 | 0 | 截断副本被检出，恢复被拒，合成源库字节数与 SHA-256 未变。 |
| G-16 | 0 | 父取消向子 run 传播，父处于 `cancelling`，可补偿子节点进入 `timing_out`，不可逆节点保持 `started`。子 run 收敛后父 run 仅一次终态仍待验证。 |

其他命令及结果：

- `node --no-warnings scripts/fault-inject.ts --case G-99 --out tmp/s6-entry/evidence` 退出 `1`，`G-99.stderr.log` 记录 `TypeError`。
- `node node_modules/typescript/bin/tsc --noEmit` 退出 `0`。
- `node node_modules/vitest/vitest.mjs run --no-cache --configLoader runner tests/integration/backup.spec.ts tests/integration/memory-g11.spec.ts` 退出 `0`，7 项通过。

## S6 首项修复

在独立的 `codex/s6-hardening` 分支，未登记编号由 `runCase` 明确拒绝，CLI 缺少编号时也给出明确原因，两种情况都在创建证据目录之前退出。已登记的编号仍由原场景处理。以 G-13 手工复验，退出 1，报错包含实际编号，临时证据根目录未被创建。

在该分支运行 `node node_modules/vitest/vitest.mjs run tests/integration/fault-harness.spec.ts`，5 项通过，覆盖直接调用、CLI 失败路径与默认和具名成功案例。`node node_modules/typescript/bin/tsc --noEmit` 退出 0。再次执行 `node --no-warnings scripts/check-evidence-repro.ts`，29 份既有证据各重放两次，与 HEAD 字节一致。

最终复验在允许本机回环的环境同时执行 `fault-harness.spec.ts`、`g1.spec.ts`、`g3-faults.spec.ts`，3 个文件的 21 项全部通过，其中包含 G-08 的 HTTP 503 路径。

下一项按 Task 1 补齐统一可执行对账查询和结构化判定。Task 6 实现 G-13 的在途升级与回滚注入后，再给该编号增加成功路径验收。G6 的测量窗口、24 小时浸泡和发布门按[S6 实施计划](../superpowers/plans/2026-11-12-dsh-orchestra-s6-hardening-release.md)分别验收。
