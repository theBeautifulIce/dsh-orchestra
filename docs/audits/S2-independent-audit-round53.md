# S2 独立审计 · G2 · 第 53 轮

- 门：G2
- 候选提交：0dbb95024ce2df4476e0cb230209b4cb6497e5f2
- 审计时间：2026-11-14
- 审计范围：候选 `4f3ada7..0dbb950`；排除 `docs/gates/G1.md`、`docs/gates/G2.md` 门记录自身与 `docs/audits`、`docs/reviews`、`handoff.md`，证据文件仍计入候选。
- 审计方式：只读。未改源码、未提交、未签门；唯一写入为本报告。审计开始时 `git status --porcelain` 为空；审计中途同目录出现另外两份未跟踪审计报告（`docs/audits/S1-independent-audit-round53.md`、`docs/audits/S3-independent-audit-round5.md`），非本报告产物，跟踪文件始终无改动（`git diff --stat` 为空）。

## 一、命令与结果

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `pnpm typecheck`（`tsc --noEmit`） | 0 | 无输出 |
| 2 | `pnpm test`（`vitest run`） | 0 | 61 files，**843 passed / 1 skipped**，844 total，14.84s |
| 3 | `pnpm build`（`tsdown`） | 0 | `lib/index.js` 245.34 kB（gzip 59.26）、`lib/index.d.ts` 18.04 kB、`lib/client.js` 0.29 kB |
| 4 | `node --no-warnings scripts/check-evidence-repro.ts` | 0 | “证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致” |
| 5 | `pnpm vitest run tests/integration/g2.spec.ts tests/integration/runtime.spec.ts tests/contract/routes.spec.ts tests/e2e/production-path.spec.ts tests/integration/sweep.spec.ts tests/integration/apply-report.spec.ts` | 0 | 6 files，**149 passed**（g2 14、runtime 25、routes 25、production-path 5、sweep 19、apply-report 61） |
| 6 | `pnpm vitest run tests/integration/agent-lifecycle.spec.ts tests/integration/bridge-ledger.spec.ts tests/unit/bridge-buffer.spec.ts tests/integration/runtime.spec.ts tests/e2e/production-path.spec.ts tests/contract/execution-concurrency.spec.ts` | 0 | 6 files，**73 passed**（agent-lifecycle 13、bridge-ledger 10、bridge-buffer 19、runtime 25、production-path 5、execution-concurrency 1） |
| 7 | `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` | 1 | 首错：“审计报告 sha256 与记录不符（报告改过就重新审计再签）：`b386173930739945…` != `3e0753072f37a86e…`”。属签前态，真实原因见第六节 |

计数口径：全量 843 passed / 1 skipped；必过集合 149 passed；桥闭环集合 73 passed。证据复现 25/25，两遍互比与 `git show HEAD` 均字节一致。

## 二、结论

**结论：fail。P0=0，P1=1，P2=4。**

20 项必过的行为在本候选上全部复跑通过，桥闭环、工具强证据、三游标与调度双入口也没有发现回归。判 fail 的 P1 落在本候选新增的两条生产接线：等待事件路由唤醒节点后、子流程终态扫描推进父节点后，都把节点置成 `dispatched` 并清掉租约，但生产路径没有任何入口再执行或收口这个节点；节点停在“已派发但无执行器”的状态，十分钟后还会被桥失联信号判成 `orphaned`。这不是证据或计数问题，是唤醒/收口链路端到端不可用。

## 三、逐项结论

历史轮次行（第 50/51 轮）未计入本轮；散文与表格单元均已按当前 `audit_round` 扫描。

| 必过项 | 要求 | 行为结论 | 证据复现 | 本轮依据 |
| --- | --- | --- | --- | --- |
| G2-01 | 单节点 queued 到终态一条路径（走生产装配） | pass | 一致 | `ev-g2-01` 从 HTTP `load → runs → dispatch` 真跑，节点到 `done`、`evidence_source=run_tool`、`report_registry=applied`；字节复现通过 |
| G2-02 | 重复上报只落一次 | pass | 一致 | `ev-g2-02` 复现通过；`g2.spec.ts` / `apply-report.spec.ts` 通过 |
| G2-03 | 租约过期迟到上报被拒 | pass | 一致 | `ev-g2-03` 复现通过；租约用例通过 |
| G2-04 | 取消后不产生新 attempt | pass | 一致 | `ev-g2-04` 复现通过；节点级取消 attempt 不变、新 attempt 上报被 `attempt_mismatch` 拒 |
| G2-05 | 终态必带证据 | pass | 一致 | `ev-g2-05`、`ev-g2-10` 复现通过；系统级证据门在 `src/service/commands/apply-report.ts:539`、痕迹绑定在 `:608-692` |
| G2-06 | 无裸 blocked（没裁决卡不许卡住） | pass | 一致 | `ev-g2-06` 复现通过；`DECISION_REQUIRED` 拒无凭据 blocked |
| G2-07 | S2 加载 parallel 被拒 | pass | 一致 | `ev-g2-07` 复现通过；`production-path.spec.ts` 通过 |
| G-03 | 同一 report_id 上报两次只落一次 | pass | 一致 | `G-03.md` 复现通过；`report_registry` 去重 |
| G-04 | 租约到期后原执行器迟到上报被拒 | pass | 一致 | `G-04.md` 复现通过 |
| G-05 | 工具执行中取消只立一次围栏 | pass | 一致（本轮已重生成） | `G-05.md` 复现通过；仍只有 1 条 `fence_armed`，第二次 `fence_already_armed`，围栏期间上报被拒，宽限到点 `fence_revoked` |
| G-07 | 墙钟跳变不误判截止 | pass | 一致 | `G-07.md`、`ev-g2-09` 复现通过 |
| G2-08 | 工具失败不许落完成（系统判失败并挂凭据） | pass | 一致 | `ev-g2-08` 复现通过；失败终态走 `requireFailure:true` |
| G2-09 | 判定时限只认 boot_id 与单调纳秒 | pass | 一致 | `ev-g2-09` 复现通过 |
| G2-10 | 报告入口系统级证据门（弱证据与伪造痕迹一律拒） | pass | 一致 | `ev-g2-10` 复现通过；`evidence_missing` / `verification_too_weak` / `evidence_unverifiable` 三拒路径均在 |
| G2-11 | 反复重投同一 report_id 不许把账本刷膨胀 | pass | 一致 | `ev-g2-11` 复现通过；`report_seq` 去重 |
| G2-12 | 工具授权只认 workflow 定义，请求体策略不参与 | pass | 一致 | `ev-g2-12` 复现通过；越权/未注册在租约前拒 |
| G2-13 | 单写者锁与 epoch 围栏：第二写者拿不到锁，旧 epoch 写不进 | pass | 一致 | `ev-g2-13` 复现通过；CAS 带 `action_generation` / `rearm_generation` |
| G2-14 | 长动作靠心跳续租，扫描不误判过期 | pass | 一致（本轮已重生成） | `ev-g2-14.md` 复现通过；2.5 秒扫描 `lease_expired=0`，节点 `done` |
| G2-15 | 同一工作流的同一版本跨重启不可改写，在飞 run 的判定条件不跟着变 | pass | 一致 | `ev-g2-15` 复现通过；版本不符抛 `WORKFLOW_VERSION_IMMUTABLE` |
| G2-16 | Agent Bridge 生产闭环：B01–B10 可复现，工具证据只来自宿主执行 | pass | 手写汇总（不在复现脚本内） | 桥 6 文件 73 passed；B06 独立子进程 SIGKILL → `EVIDENCE_SOURCE_UNAVAILABLE`；工具强证据只认 `ReadOnlyToolRunner.runTool()`，`reportFromAgent` 用宿主 trace 覆盖上报 trace |

行为 20/20 通过；`must_pass_passed` 记 20，`failed_items` 留空。P1 不在任一必过项的行为上，按第 51 轮同类口径单列，不把必过项改判 fail。

## 四、P0 / P1

### P1-1 等待唤醒与子流程收口把节点置 `dispatched`，生产路径没有消费者，节点永久悬空

**位置**

- `src/service/commands/wait.ts:135-149`：`scanRegistration` 把等待节点 `waiting → dispatched`，同时清空 `lease_id`、`lease_expires_at`、`executor_session_id`、`executor_agent_id`。
- `src/service/commands/subworkflow.ts:362-368`：`finishSubworkflowChild` 把父节点 `waiting → dispatched`，只清 `wait_started_at`，不建租约、不建执行器。
- `src/service/dispatcher.ts:57-59`：`dispatchRun` 只取 `status = 'queued'`，`dispatched` 不在派发集合。
- `src/service/commands/lease.ts:62-67`：`acquireLease` 要求节点必须是 `queued`，`dispatched` 拿不到租约；`/v1/node-runs/run` 也无法接管。
- `src/service/commands/lease.ts:140-142`：过期租约扫描只处理 `lease_expires_at IS NOT NULL` 的行；唤醒时该字段已被清空，扫描不会接管。
- `src/service/commands/runtime.ts:89-95`：桥失联信号把无 `bridge_stream_cursors` 行、`started_at` 超过 10 分钟的 `dispatched/started` 节点置 `orphaned`；wait/subworkflow 是控制节点，本来就没有桥游标。

**复现**

1. `pnpm vitest run tests/contract/routes.spec.ts -t "等待事件走生产路由"`
   - 通过，但测试只断言到 `nrun_wait.status = 'dispatched'`（`tests/contract/routes.spec.ts:359-367`）；随后再调 `/v1/runs/dispatch`，`dispatchRun` 的 `queued` 查询为空，节点不会被执行。
2. `pnpm vitest run tests/integration/sweep.spec.ts -t "子运行已收口但父节点仍 waiting"`
   - 通过，但测试只断言到父节点 `dispatched`（`tests/integration/sweep.spec.ts:353-367`）；之后没有入口把该节点推向执行或终态。
3. 静态复现：`rg -n "status = 'queued'" src/service/dispatcher.ts` 与 `rg -n "from: \\['waiting'\\]" src/service/commands/wait.ts src/service/commands/subworkflow.ts` 对照即可看到“置 dispatched”与“只取 queued”之间没有桥。

**期望 / 实际**

- 期望：等待条件命中或子 run 收口后，父节点进入可执行状态（由调度器接走）或直接完成并推进 run；run 不会停在一个没有执行器的节点上。
- 实际：`HTTP 200` 只代表账本写了 `wait.woken` / `subworkflow.finished`；节点 `dispatched`、`lease_id=NULL`，`/v1/runs/dispatch` 返回空 outcome，`/v1/node-runs/run` 会因 `STALE_GENERATION`（不在 queued）失败。控制节点没有桥游标，`started_at` 超过 10 分钟后被 `bridgeSignals.lost` 判成 `orphaned`，子流程结果与等待事件都不会被消费。

**影响**

本候选新增的 `POST /v1/wait/events` 与子流程终态扫描在单测断言的第一个状态点上通过，但端到端链路断开；这不是证据复现问题，不能靠重生成证据消除。G2-16 的桥 B01–B10 不经过这条控制节点路径，因此桥闭环本身仍判 pass。

## 五、P2（单列，不阻断本轮必过项）

1. **运行级取消不取消目标 run 自身的节点，也不 abort 在飞执行。** `src/service/commands/subworkflow.ts:405-445` 只遍历 `parent_run_id = 目标 run` 的子 run；目标 run 的 `node_runs` 不在循环内。实测：`r1` 有 `started` 的 `nrun_1`，`POST /v1/runs/cancel {runId:'r1',cancelResult:'interrupted',graceMs:0}` 返回 200，`data.cancelledRuns=[]`、`data.cancelledNodes=[]`，`nrun_1` 仍是 `started`、`cancel_requested_at=null`，`r1` 只是被打了 `cancel_result=interrupted`。`src/service/schemas.ts:348` 的注释把节点级取消留给 `/v1/node-runs/cancel`，口径上可解释；但调用方若按“运行级取消”理解，会漏掉目标 run 自身所有节点。
2. **`ev-g2-16` 计数仍是旧数。** `docs/gates/evidence/G2/ev-g2-16.md:51` 写 `6 files passed, 70 tests passed`；本轮实测 73 passed（agent-lifecycle 13、bridge-ledger 10、bridge-buffer 19、runtime 25、production-path 5、execution-concurrency 1）。
3. **门记录仍是签前态，证据表两份 sha 已过期。** `docs/gates/G2.md:88` 的 `ev-g2-14` 记 `61e9c435…`，HEAD 实际 LF sha `6d69d74d7cd3ecc0c9a8949b062fa5f4022c013c56a0216b1a8253fed1c067a8`；`:93` 的 `G-05` 记 `d400f29d…`，HEAD 实际 `85b2ed07102834e1bebfc4bce9abd548dafaf2a825b5fa6b3abc5a908ee07437`；证据索引 JSON 的 `:400`、`:425` 同值。`candidate_hash=8fa91fbb…` 仍锚在第 50 轮候选，`audit_round=51`、`audit_report` 指向第 51 轮 fail 报告、`audit_report_sha256=b386…` 实为第 50 轮报告哈希。重签前必须一并刷新。
4. **等待事件幂等键全局唯一，跨 run 相同键会静默丢事件。** `src/infra/sqlite/migrations/018_wait_registrations.sql:24` 对 `wait_event_inbox.idempotency_key` 建了全局 `UNIQUE`；`src/service/commands/wait.ts:99-111` 冲突时 `DO NOTHING` 并回读已有 `inbox_seq`，但 `wakeOnEvent` 只扫当前 `runId`（`:285-287`），于是第二个 run 用同一个键投递时拿到的是第一个 run 的序号，自己的等待不会被唤醒。调用方使用全局 UUID 时不触发；语义上应把键唯一性限定到 run。

## 六、门检查失败的真实原因与重签清单

`gate-check` 在当前 HEAD 的首错是审计锚点，不是代码失败：

- `docs/gates/G2.md` 记录 `audit_report_sha256=b386173930739945…`，但 `docs/gates/S2-independent-audit-round51.md` 在 HEAD 的 LF sha 是 `3e0753072f37a86ead6fc37feb7e6424c4e2fd5646281a9bdc297d7c375d2010`，且该报告结论是 fail。第 50 轮报告才是 `b386…`；第 51 轮换路径时没有换哈希。
- 其后还会失败：候选范围已从第 50 轮的锚点前进到 `0dbb950`，`candidate_hash` / `change_scope_hash` 必变；`ev-g2-14`、`G-05` 两份证据在 `0dbb950` 里重生成过，表与索引里的 sha 未刷新；`evidence_index_hash`、`body_hash`、`artifact_hash` 需随正文与证据表一起重算。

本报告判 fail，暂不具备重签条件；先修 P1-1（把唤醒/收口后的节点交给可执行入口或直接收口），再按门记录流程更新上述锚点与两份证据哈希，才可进入下一轮签门。

## 七、failed_items 与裁决

`failed_items` 为空：20 项必过行为全过，P1 落在新增等待/子流程接线的端到端语义，不落在任何单项必过行为上。

<!-- audit-verdict:begin -->
```json
{"schema":"audit-verdict/1","gate":"G2","audit_round":53,"candidate_commit":"0dbb95024ce2df4476e0cb230209b4cb6497e5f2","conclusion":"fail","p0":0,"p1":1,"p2":4,"must_pass_total":20,"must_pass_passed":20,"must_pass_ids":["G2-01","G2-02","G2-03","G2-04","G2-05","G2-06","G2-07","G-03","G-04","G-05","G-07","G2-08","G2-09","G2-10","G2-11","G2-12","G2-13","G2-14","G2-15","G2-16"],"failed_items":[],"notes":"20/20 必过行为复跑通过；证据 25/25 字节复现；全量 843 passed / 1 skipped、必过 149 passed、桥 73 passed、typecheck/build exit 0。P1：等待唤醒（wait.ts:135-149）与子流程收口（subworkflow.ts:362-368）把节点置 dispatched 且清租约，但 dispatchRun 只取 queued（dispatcher.ts:57-59），acquire 也拒非 queued（lease.ts:62-67），节点悬空并在 10 分钟后被 bridge lost 判 orphaned。P2：run 级取消不取消目标 run 自身节点且不 abort；ev-g2-16 写 70 实测 73；G2.md 审计锚点/候选哈希/两份证据 sha 仍为签前态；wait_event_inbox 幂等键全局唯一。"}
```
<!-- audit-verdict:end -->
