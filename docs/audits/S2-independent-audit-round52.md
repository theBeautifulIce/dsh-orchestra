# S2 独立审计 · G2 · 第 52 轮

- 门：G2
- 候选提交：4e431c64ee4f382238901a2a04956ae8a8d70e0d
- 审计时间：2026-11-14
- 审计范围：候选范围 `4f3ada7..4e431c6`，排除 `docs/gates/G1.md`、`docs/gates/G2.md` 门记录自身与 `docs/audits`、`docs/reviews`、`handoff.md`；证据文件仍计入候选。本轮从 `10fb8fa` 开始，候选在审计中途前进到 `4e431c6`（仅 `G2/G-05.md`、`G2/ev-g2-14.md` 两份证据 +2/−2），报告以 `4e431c6` 为准。
- 审计方式：只读。未改源码、未签门、未 commit；唯一写入为本报告。干净复核先在 detached worktree `s2r52-wt`（HEAD=10fb8fa）进行，候选前进后全部命令在主仓干净树复跑，worktree 已删除。

## 一、命令与结果

| # | 命令 | 工作目录 | 退出码 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | `node --no-warnings scripts/check-evidence-repro.ts` | 主仓（10fb8fa，干净） | 1 | “证据复现不成立（2/27 份）”：`G2/G-05.md`、`G2/ev-g2-14.md` 重跑与 HEAD 字节不一致；分母写错，实际是 2/25 |
| 2 | 同上 | 主仓（4e431c6，干净） | 0 | “证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致” |
| 3 | 对第 1 项点名的 5 份（含上轮已修的 `G1/G-14`、`ev-g2-01`、`ev-g2-10`）逐份重跑两遍并对 `git show HEAD` 比字节 | 主仓 + OS 临时目录 | — | 5/5 两遍互比相同、与 HEAD 逐字节相同：`G-14` `c1da5460...`、`ev-g2-01` `cee94009...`、`ev-g2-10` `bd360512...`、`ev-g2-14` `db3af591...`、`G-05` `904f8d7a...` |
| 4 | `pnpm typecheck`（`tsc --noEmit`） | 主仓（4e431c6） | 0 | 无输出 |
| 5 | `pnpm test`（`vitest run`） | 主仓（4e431c6） | 0 | 61 files，838 passed / 1 skipped，839 total |
| 6 | 必过 6 文件：`g2.spec.ts`、`runtime.spec.ts`、`contract/routes.spec.ts`、`e2e/production-path.spec.ts`、`sweep.spec.ts`、`apply-report.spec.ts` | 主仓（4e431c6） | 0 | 6 files，**144 passed**（g2 14、runtime 23、routes 23、production-path 5、sweep 18、apply-report 61） |
| 7 | 桥闭环 6 文件：`agent-lifecycle.spec.ts`、`bridge-ledger.spec.ts`、`unit/bridge-buffer.spec.ts`、`runtime.spec.ts`、`e2e/production-path.spec.ts`、`contract/execution-concurrency.spec.ts` | 主仓（4e431c6） | 0 | 6 files，**71 passed**（agent-lifecycle 13、bridge-ledger 10、bridge-buffer 19、runtime 23、production-path 5、execution-concurrency 1） |
| 8 | `pnpm build`（`tsdown`） | 主仓（4e431c6） | 0 | ESM `lib/index.js` 235.96 kB（gzip 57.01）、`lib/index.d.ts` 17.57 kB、CJS `lib/client.js` 0.29 kB |
| 9 | `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` | 主仓（4e431c6） | 1 | “审计报告 sha256 与记录不符（报告改过就重新审计再签）：b386173930739945… != 3e0753072f37a86e…”；属签前预签态，见第五节 |
| 10 | `git show --stat 4e431c6` | 主仓 | 0 | 仅 `docs/gates/evidence/G2/G-05.md`、`docs/gates/evidence/G2/ev-g2-14.md`，2 files changed，2 insertions(+)，2 deletions(−) |

计数口径：候选代码全量 838 passed / 1 skipped；必过集合 144 passed；桥闭环集合 71 passed。第 1 项是 `10fb8fa` 的历史态，第 2–8 项是 `4e431c6` 的最终态。

## 二、结论

**结论：pass。P0=0，P1=0，P2=3。**

20 项必过的行为全部复跑通过，证据复现契约在本轮候选上闭合：`check-evidence-repro.ts` exit 0，25/25 字节一致，上轮 P1 点名的五份（`G1/G-14`、`G2/G-05`、`ev-g2-01`、`ev-g2-10`、`ev-g2-14`）现在全部能由当前生成器重跑出与 HEAD 相同的字节。桥闭环、必过路径、工具强证据三条口径均成立。

剩余三条 P2 都不阻断门：`ev-g2-16` 的计数仍是旧数、生产 run 终态仍有覆盖缺口、复现守卫失败时的分母文案仍写错。三条都不落在必过项行为上，按前几轮同类口径不判 fail。

## 三、逐项结论

| 必过项 | 要求 | 行为结论 | 证据复现 | 本轮依据 |
| --- | --- | --- | --- | --- |
| G2-01 | 单节点 queued 到终态一条路径（走生产装配） | pass | 一致 | `ev-g2-01` 从 HTTP `load → runs → dispatch` 真跑，节点到 `done`、`evidence_source=run_tool`、`report_registry=applied`；字节复现通过 |
| G2-02 | 重复上报只落一次 | pass | 一致 | `ev-g2-02` 复现通过；`g2.spec.ts` / `apply-report.spec.ts` 通过 |
| G2-03 | 租约过期迟到上报被拒 | pass | 一致 | `ev-g2-03` 复现通过；租约用例通过 |
| G2-04 | 取消后不产生新 attempt | pass | 一致 | `ev-g2-04` 复现通过；`g2.spec.ts` / `sweep.spec.ts` 通过 |
| G2-05 | 终态必带证据 | pass | 一致 | `ev-g2-05`、`ev-g2-10` 均复现通过；系统级证据门与痕迹绑定在 `src/service/commands/apply-report.ts:541/608` |
| G2-06 | 无裸 blocked（没裁决卡不许卡住） | pass | 一致 | `ev-g2-06` 复现通过；`DECISION_REQUIRED` 拒无凭据 blocked |
| G2-07 | S2 加载 parallel 被拒 | pass | 一致 | `ev-g2-07` 复现通过；`production-path.spec.ts` 通过 |
| G-03 | 同一 report_id 上报两次只落一次 | pass | 一致 | `G-03.md` 复现通过；`report_registry` 去重 |
| G-04 | 租约到期后原执行器迟到上报被拒 | pass | 一致 | `G-04.md` 复现通过 |
| G-05 | 工具执行中取消只立一次围栏 | pass | 一致（本轮已重生成） | `G-05.md` 复现通过；仍只有 1 条 `fence_armed`、第二次 `fence_already_armed`、围栏期间上报被拒、宽限到点 `fence_revoked` |
| G-07 | 墙钟跳变不误判截止 | pass | 一致 | `G-07.md`、`ev-g2-09` 复现通过 |
| G2-08 | 工具失败不许落完成（系统判失败并挂凭据） | pass | 一致 | `ev-g2-08` 复现通过；失败终态走 `requireFailure:true` |
| G2-09 | 判定时限只认 boot_id 与单调纳秒 | pass | 一致 | `ev-g2-09` 复现通过 |
| G2-10 | 报告入口系统级证据门（弱证据与伪造痕迹一律拒） | pass | 一致 | `ev-g2-10` 复现通过；三拒路径 `evidence_missing` / `verification_too_weak` / `evidence_unverifiable` 均在 |
| G2-11 | 反复重投同一 report_id 不许把账本刷膨胀 | pass | 一致 | `ev-g2-11` 复现通过；`report_seq` 去重 |
| G2-12 | 工具授权只认 workflow 定义，请求体策略不参与 | pass | 一致 | `ev-g2-12` 复现通过；越权/未注册在租约前拒 |
| G2-13 | 单写者锁与 epoch 围栏：第二写者拿不到锁，旧 epoch 写不进 | pass | 一致 | `ev-g2-13` 复现通过；CAS 带 `action_generation` / `rearm_generation` |
| G2-14 | 长动作靠心跳续租，扫描不误判过期 | pass | 一致（本轮已重生成） | `ev-g2-14.md` 复现通过；2.5 秒扫描 `lease_expired=0`，节点 `done` |
| G2-15 | 同一工作流的同一版本跨重启不可改写，在飞 run 的判定条件不跟着变 | pass | 一致 | `ev-g2-15` 复现通过；版本不符抛 `WORKFLOW_VERSION_IMMUTABLE` |
| G2-16 | Agent Bridge 生产闭环：B01–B10 可复现，工具证据只来自宿主执行 | pass | 手写汇总（不在复现脚本内） | 桥 6 文件 71 passed；B06 独立子进程 SIGKILL → `EVIDENCE_SOURCE_UNAVAILABLE`；证据源只认 `run_tool` |

行为 20/20 通过；证据复现 20/20 一致（G2-16 为手写汇总，由桥用例覆盖）。`must_pass_passed` 记 20，`failed_items` 为空。

## 四、证据哈希重算

从 `git show HEAD:<path>` 取字节，按 LF 归一后算 sha256，20 份里 16 份与 `docs/gates/G2.md` 的证据表一致，4 份不一致。不一致的 4 份恰好是 `494d6e4` / `4e431c6` 重生成过、而 `G2.md` 尚未重签的条目；这 4 份已由第 2 项命令重跑出同字节，属**签前表未刷新**，不是证据漂移。

| 证据 | 文件 | sha256（LF 归一） | 与记录 |
| --- | --- | --- | --- |
| ev-g2-01 | `docs/gates/evidence/G2/ev-g2-01.md` | `cee94009ae4c1f1e14c4da72becdd39f3b90e5cacbfae96829ea7382731de5e1` | 不一致（旧表 `71825a7d…`） |
| ev-g2-02 | `docs/gates/evidence/G2/ev-g2-02.md` | `346af5813c653ba967af948a74aba27201b9ac906f13e54f4e588f8b18ea70e1` | OK |
| ev-g2-03 | `docs/gates/evidence/G2/ev-g2-03.md` | `5929f803fadbbeabe0a9f9b5b0b65d2d52b429017eaceab56388f165d83d29be` | OK |
| ev-g2-04 | `docs/gates/evidence/G2/ev-g2-04.md` | `65946e22958ef8764415d2af693245f8dc8da33e585ba4cee094e36f56ac71a6` | OK |
| ev-g2-05 | `docs/gates/evidence/G2/ev-g2-05.md` | `6f3b44cf5589ddc059b77f3640e5a23f93eef8351d9c5fba9dd6510abc26e2ba` | OK |
| ev-g2-06 | `docs/gates/evidence/G2/ev-g2-06.md` | `cef5cf3de601985af216cb935334414d56ff9f3f296871f709332f9e16b1f91c` | OK |
| ev-g2-07 | `docs/gates/evidence/G2/ev-g2-07.md` | `64fa6c33ed9f4b33f5f8cc2306a8ad618d99d06ce1698e7aa1c8b537beeae05d` | OK |
| ev-g2-08 | `docs/gates/evidence/G2/ev-g2-08.md` | `86e30ab3215755f2a791614dce667b295a41c0afebce0a7f286920e23e0d9225` | OK |
| ev-g2-09 | `docs/gates/evidence/G2/ev-g2-09.md` | `f43b50982b67843db87e1cae9b36b0048eca372d9734904d3e1090fc97b8d8b2` | OK |
| ev-g2-10 | `docs/gates/evidence/G2/ev-g2-10.md` | `bd360512537f0259770e625f95c6a5ff336bb93a53b1b7cffa1f7b1fa4d85310` | 不一致（旧表 `3f3ba099…`） |
| ev-g2-11 | `docs/gates/evidence/G2/ev-g2-11.md` | `fb72ef55124d1b210ff4bf73ad1122cf067ecb93f96265e1fdfbdd050fc815dd` | OK |
| ev-g2-12 | `docs/gates/evidence/G2/ev-g2-12.md` | `5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe` | OK |
| ev-g2-13 | `docs/gates/evidence/G2/ev-g2-13.md` | `a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc` | OK |
| ev-g2-14 | `docs/gates/evidence/G2/ev-g2-14.md` | `db3af591ced3d337cd0530225f20ad764e3885a971c7c9c5406b1da3788f5319` | 不一致（旧表 `61e9c435…`） |
| ev-g2-15 | `docs/gates/evidence/G2/ev-g2-15.md` | `8c21ebd8e00ea8563f910fd2f3b3beb96b678812260620c9d0f05480e1f7ca6d` | OK |
| ev-g2-16 | `docs/gates/evidence/G2/ev-g2-16.md` | `8caea691cb48306c222f05fef387f96a5a5abf984cf05bb926eb420328575a76` | OK |
| ev-g2-g03 | `docs/gates/evidence/G2/G-03.md` | `514f9754fda67b8e1522d086fc6079301e00bd0185f9cca6dddec502c412ab70` | OK |
| ev-g2-g04 | `docs/gates/evidence/G2/G-04.md` | `a30155a2446531f5c5cd2677946805ca9a78f407cfc4626147f20fcd446eb961` | OK |
| ev-g2-g05 | `docs/gates/evidence/G2/G-05.md` | `904f8d7a7c792fe5f80f9bc36222606baf5752bba64a6857d580f94be2ecc3bf` | 不一致（旧表 `d400f29d…`） |
| ev-g2-g07 | `docs/gates/evidence/G2/G-07.md` | `de51ca56aba24af02f7c1ef2c0bfba5248da11b5aaa7ba163aafacf9d8e0746a` | OK |

“哈希与表不一致”在重签时由 `scripts/sign-gate.ts` 统一重算，不是候选缺陷；但**重签前不能把旧表当证据**。G1 的 `G-14` 也已复现通过（`c1da546054be4fd95ecbb399ee4604b6706647e5a093a3fb1b8e551eb37ed739`），不在 G2 证据表内。

## 五、门自锚复核

对 HEAD 里的 `docs/gates/G2.md` 运行 `gate-check.ts`，在第一道锚点即被拒：

```
门检查失败（docs/gates/G2.md）：审计报告 sha256 与记录不符（报告改过就重新审计再签）：b386173930739945… != 3e0753072f37a86e…
```

原因是记录仍是**签前态**：`audit_round=51`、`audit_report` 指向 `S2-independent-audit-round51.md`（该报告结论为 fail）、`candidate_hash=8fa91fbb…` 仍锚在第 50 轮候选、证据表 4 行未刷新。按前几轮口径，这是“本轮报告落地后重签”的预期中间态，不作为门的失败。

重签时需要一并更新：`candidate_hash` / `change_scope_hash`（新候选 `4e431c6`）、`evidence_index_hash`（4 份新哈希）、`artifact_hash`、`body_hash`、`audit_round=52`、`audit_report` 与本报告 sha256，然后再跑 `sign-gate.ts`。本轮未签门、未改 `G2.md`。

## 六、专题复核

### 6.1 单 agent 生产闭环

`tests/e2e/production-path.spec.ts` 走真实 `openServiceOrchestra` + `startServer`，用 HTTP 完成 `POST /v1/workflows/load → POST /v1/runs → POST /v1/runs/dispatch`，节点由真实 dispatcher 拾起、真实 `runNode` 执行、真实 `applyReport` 六步收口，账本与 `report_registry` 都是生产表。5 个用例覆盖：全链路 done、定义未加载 404、授权只认定义（越权/未注册在租约前拒、节点保持 queued）、省略 agents 走 `bridge.spawn` 兜底、节点缺工具配置 skipped 不动状态。

替身只在宿主边界：e2e 的 `HostRunner` 直接返回 `exitCode 0 / stdout "ok\n"`，agent 用 `tests/fixtures/agent-bridge.ts` 的 fake client。命令层、状态机、证据门、工具执行器 `ReadOnlyToolRunner` 都是生产代码；`src` 内检索 `fake|fixtures` 无命中。真实宿主执行由 `ev-g2-16` 的 B06 独立子进程覆盖。

### 6.2 工具执行唯一身份（execution_id / tool_seq）

- `src/infra/sqlite/migrations/006_tool_executions_tool_seq.sql`：主键 `(node_run_id, attempt, tool_seq)`，`execution_id TEXT NOT NULL UNIQUE`。
- `src/executor/evidence-collector.ts:162` 取 `nextToolSeq()`，`:163` 生 `executionId`，`:169-178` 写 `tool_started`（带两者），`:180` 调 `runner.runTool(...)`，`:194-203` 生成 trace，`:208-235` 在同一事务写 `tool_executions`、`tool_finished` 与 outbox，三者共用同一个 `execution_id`。
- `src/service/commands/apply-report.ts:608` 的 `traceBindingGate` 按同 attempt 的工具执行行核对：`:662` 要求 `toolSeq` 命中，`:663` 逐字段核哈希，`:690` 要求 `tool_finished` 事件带同一个 `execution_id`。伪造 trace 在 `ev-g2-10` 被 `evidence_unverifiable` 拒。

### 6.3 强证据与产物哈希

`systemEvidenceGate`（`src/service/commands/apply-report.ts:541`）只认 `source='run_tool'` 且 `exitCode` 为数字：`:543` 空证据 `evidence_missing`，`:545` 弱来源 `verification_too_weak`；done 还必须过 `traceBindingGate`（`:608-690`），失败/超时走 `allowFailed:true, requireFailure:true`。`src/executor/tools.ts:134` 把证据源固定为 `run_tool`，`:193-196` 无只读挂载即 `EVIDENCE_SOURCE_UNAVAILABLE`，`:200-206` 的 argv 只取注册表、不接受请求里的 args。`src/executor/evidence-collector.ts:104` 对 outbox 里“开始了但没完成”的调用直接报 `EVIDENCE_SOURCE_UNAVAILABLE`，不盲目重跑。

### 6.4 scope / 租约 / 迟到回写

节点写入统一走 `src/service/commands/nodes.ts` 的 `applyTransition`：单条 CAS，`WHERE` 带 `status IN`、`attempt`、`revision`、`action_generation`、`rearm_generation`，`hang_reason IS NULL`（仅 `allowHung` 可绕），`changes!==1` 抛 `STALE_GENERATION`。租约 30 秒、心跳 10 秒；过期后的迟到上报在 `ev-g2-03` / `G-04` 被拒，重复 `report_id` 只落一次（`ev-g2-02` / `G-03`），重投不刷膨胀（`ev-g2-11`）。

### 6.5 报告六步

`apply-report` 的顺序是：查 `report_registry` 去重 → schema 校验 → status/attempt/generation CAS + 租约 → done 强证据门 → 判定条件（`passConditions` / `requiredHashes`）→ `transitionNode`。`policyForReport` 从 run 行取 `workflow_id` / `workflow_version` / `definition_hash`，与目录当前定义比对，版本被改写抛 `WORKFLOW_VERSION_IMMUTABLE`（`ev-g2-15`）。

### 6.6 终态、收口与取消

`src/service/commands/run-close.ts:47-55` 的 `closeRun`：非终态、空节点、活跃 decision、`assertRunCanTerminal` 失败都返回 null；终态优先级 `failed_with_unverified/failed > orphaned（无 replacement）> 未验证副作用 > succeeded`，写 `run.terminal` 事件。取消统一走 `src/service/commands/cancel.ts` 的 `applyCancel`：终态 → `already_stopped` 不写状态；queued/leased → `superseded`；interrupted → `timing_out` 并立 fence（已有 armed 则 `fence_already_armed`）；围栏期间迟到上报被拒，工具落地后收口 `STALE_GENERATION`；宽限到点 `revokeFence` 只撤一次（`G-05` 复现通过）。

### 6.7 桥生命周期与 G2-16

- 先落账再 ACK：`src/executor/bridge-ledger.ts:98-132` 在同一个 `withTx` 里追加 `node_run_events`、插入 `bridge_event_receipts`、推进 `bridge_stream_cursors.last_persisted_ack_seq`，提交返回后才算本地确认；`src/executor/bridge-consumer.ts:81-90` 的顺序是 `ingest` → `onEvent` → `markHandled` → `buffer.ack`，任一步失败都不推进处理位。
- 三游标：`src/executor/bridge.ts:202-204` 的 `lastReceivedSeqValue` / `lastContiguousSeqValue` / `lastPersistedAckSeqValue`；`:291-300` 对已确认序号做同 payload 幂等、不同 payload 抛 `BRIDGE_SEQ_CONFLICT`；`:318-340` 的 `ack(seq, persistedAckSeq)` 要求 `persistedAckSeq >= seq`、`seq` 不超过连续位、且逐条推进。
- 重启恢复：`src/executor/agent-lifecycle.ts:87-88` 用 `ledger.handled()` 作为起点并注入 `lookupPersisted`；`bridge-ledger.ts:72-81` 只按本 attempt/agent 的 receipt 回查，旧 attempt 不串读。
- 收口：`src/executor/agent-lifecycle.ts:232-277` 先 abort 监听、再 cancel、再有界等 running、再 `whenIdle`+`state`，最后 `dispose`；`bridge.ts:125-134` 在 `serviceAckSeq < bridgeLastSeq` 时抛 `BRIDGE_ACK_LAG`，不许提前释放宿主。
- B01–B10 由 6 个文件覆盖（agent-lifecycle 13、bridge-ledger 10、bridge-buffer 19、runtime 23、production-path 5、execution-concurrency 1，共 71 passed）；B06 用独立子进程写 outbox 后 SIGKILL，恢复得到 `EVIDENCE_SOURCE_UNAVAILABLE` 且 marker 仍只一次。

### 6.8 G-03 / G-04 / G-05 / G-07 可重跑性

四份全部字节复现通过。`G-05` 与 `ev-g2-14` 是本轮 `4e431c6` 按当前生成器重生成的，变化仅 sweep 对账 JSON 增加四个字段：`executor_orphaned`、`action_overrun`、`operations_timed_out`、`receipts_expired`；行为断言未变：`G-05` 仍只有一条 `fence_armed`、第二次 `fence_already_armed`、围栏期间上报被拒、宽限到点 `fence_revoked`；`ev-g2-14` 仍显示 2.5 秒扫描 `lease_expired=0`、节点 `done`。`G-03`、`G-07` 未改动，复现通过。

### 6.9 生产路径是否绕过测试假件

没有。`src` 内无 `fake` / `fixtures` 引用；e2e 用的是真实 HTTP 入口、真实 SQLite 账本、真实命令层与证据门。宿主执行器在 e2e 是替身，但这是宿主边界，不是 S2 的判定逻辑；真实宿主由 B06 的独立子进程验证。前提是报告里不把 e2e 的 run 终态当作“真实宿主已验证”——见 P2-2。

## 七、攻击矩阵

| 攻击 | 结果 | 证据 |
| --- | --- | --- |
| 伪造 `source=run_tool` 证据 | 拒，`evidence_unverifiable` | ev-g2-10 |
| 弱来源（`tool_result`）冒充强证据 | 拒，`verification_too_weak` | ev-g2-10 |
| 空证据落 done | 拒，`evidence_missing` | ev-g2-10 |
| 租约过期后原执行器迟到上报 | 拒 | ev-g2-03 / G-04 |
| 同一 `report_id` 重投 | 只落一次，不刷账本 | ev-g2-02 / G-03 / ev-g2-11 |
| 工具执行中取消 | 只立一次围栏，迟到写回 `STALE_GENERATION` | G-05 |
| 墙钟跳变 / 跨 boot 判超时 | 不误判 | G-07 / ev-g2-09 |
| 同版本改写工作流定义 | 拒，`WORKFLOW_VERSION_IMMUTABLE` | ev-g2-15 |
| 第二写者 / 旧 epoch 写入 | 拿不到锁 / 写不进 | ev-g2-13 |
| 桥进程 SIGKILL 后重连 | 不盲目重跑，`EVIDENCE_SOURCE_UNAVAILABLE` | B06 |
| 请求体自带工具策略越权 | 不参与判定，租约前拒 | ev-g2-12 |
| 同一桥序号不同 payload | `BRIDGE_SEQ_CONFLICT`，不覆盖旧事件 | B05 |
| dispose 时确认位落后 | `BRIDGE_ACK_LAG`，不释放宿主 | B08 |

## 八、加固建议

1. **重签 G2**：按 `4e431c6` 重算 `candidate_hash` / `change_scope_hash`，按第四节 4 份新哈希更新证据表与 `evidence_index_hash`，把 `audit_round` 改为 52、`audit_report` 指向本报告并写入本报告 sha256，重算 `artifact_hash` / `body_hash`，再跑 `sign-gate.ts` 与 `gate-check.ts`。顺序不能反：`sign-gate.ts` 要求工作树干净，证据哈希只认 HEAD 字节。
2. **修 `check-evidence-repro.ts` 的分母**：现在是 `checked + problems.length`（`scripts/check-evidence-repro.ts:56`），失败时会把 2/25 报成 2/27；应改成固定的 25 或 `checked`。
3. **对齐 G2-16 计数**：`docs/gates/evidence/G2/ev-g2-16.md:51` 的“70 tests passed”改为 71，`:54` 的“42 files, 624 passed”改为当前 61 files / 838 passed；`docs/gates/G2.md:98` 的“70 项”同步改 71。
4. **补一个 run 终态断言**：`tests/e2e/production-path.spec.ts:77-94` 现在只断言节点 done，不断言 run 终态；迁移 017 把 `side_effect_policy` 默认设为 `compensable`，`src` 内没有代码写 `side_effect_verified_none`，生产 run 实际恒为 `succeeded_with_unverified`。要么把工作流定义的策略接进建节点 INSERT，要么在门记录里写清“生产 run 一律未验证副作用”，并给 e2e 加断言。
5. **让证据表自动跟随**：重签脚本已经会重算 20 行哈希，建议在门记录里保留“表哈希由 sign-gate 生成”的说明，避免下一次代码前进后再次出现“证据字节已对、表还是旧值”的中间态。

## 九、P0 / P1 / P2

**P0：无。**

**P1：无。** 上轮 P1（证据复现契约）已闭合：`check-evidence-repro.ts` exit 0，25/25 与 HEAD 字节一致；五份点名证据逐份复跑两遍都相同且等于 HEAD。

**P2-1（G2-16 计数过期）** `docs/gates/evidence/G2/ev-g2-16.md:51` 与 `docs/gates/G2.md:98` 写“70”，实测 71；同段“42 files 624 passed”也早于当前 61 files / 838 passed。行为通过，数字失修。

**P2-2（生产 run 终态覆盖缺口）** 迁移 017 的 `side_effect_policy` 默认 `compensable`，`src` 内无写入点，`side_effect_verified_none` 也无人写；`src/service/commands/run-close.ts:47-55` 的 `unverified` 恒真，生产 run 只会收口为 `succeeded_with_unverified`。`run-close.spec.ts` 显式设 `pure` 才测到 `succeeded`，`tests/e2e/production-path.spec.ts:77-94` 不断言 run 终态。行为不违反 G2 必过项（G2-01 是节点级），但终态语义与覆盖需要补。

**P2-3（复现守卫分母文案错）** `scripts/check-evidence-repro.ts:56` 用 `checked + problems.length` 当分母，失败时把 2/25 报成 2/27。只影响报错可读性。

## 十、裁决

<!-- audit-verdict:begin -->
```json
{"schema":"audit-verdict/1","gate":"G2","audit_round":52,"candidate_commit":"4e431c64ee4f382238901a2a04956ae8a8d70e0d","conclusion":"pass","p0":0,"p1":0,"p2":3,"must_pass_total":20,"must_pass_passed":20,"must_pass_ids":["G2-01","G2-02","G2-03","G2-04","G2-05","G2-06","G2-07","G-03","G-04","G-05","G-07","G2-08","G2-09","G2-10","G2-11","G2-12","G2-13","G2-14","G2-15","G2-16"],"failed_items":[],"notes":"25/25 证据字节复现通过；必过 144 passed、桥 71 passed、全量 838 passed | 1 skipped、typecheck/build exit 0。P2：G2-16 写 70 实测 71 且全量数仍 42/624；生产 run 恒为 succeeded_with_unverified 且 e2e 未断言；复现守卫分母失败时报 2/27。G2.md 为签前态，重签时更新 4 份证据哈希与审计锚点。"}
```
<!-- audit-verdict:end -->
