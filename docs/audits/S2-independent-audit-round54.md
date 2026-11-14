# S2 独立审计 · G2 · 第 54 轮

- 门：G2
- 候选提交：c431cc8af1570b240f423e1d0376354142609890
- 审计时间：2026-11-14
- 审计范围：候选 `4f3ada7..c431cc8`；排除 `docs/gates/G1.md`、`docs/gates/G2.md` 门记录自身与 `docs/audits`、`docs/reviews`、`handoff.md`，证据文件仍计入候选。
- 审计方式：只读。审计开始时 `git status --porcelain` 为空，HEAD 与 `origin/main` 均为 `c431cc8`。审计中途同目录出现其他 agent 的跟踪文件改动与未跟踪审计报告，非本报告产物；为把结论钉在候选上，全部测量改在 `git worktree add --detach tmp/r54-wt c431cc8` 的干净树复跑（worktree `git status --porcelain` 为空，`wait.ts` 仍为 `to: 'queued'`）。未改源码、未提交、未签门；本报告是唯一新增的跟踪文件。

## 一、命令与结果

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `pnpm typecheck`（`tsc --noEmit`） | 0 | 无输出；干净 worktree 复跑同样 0 |
| 2 | `pnpm test`（`vitest run`） | 0 | 61 files，**844 passed / 1 skipped**，845 total，10.64s（主树首跑 9.74s，计数相同） |
| 3 | `pnpm build`（`tsdown`） | 0 | `lib/index.js` 245.47 kB（gzip 59.25）、`lib/index.d.ts` 18.04 kB、`lib/client.js` 0.29 kB |
| 4 | `node --no-warnings scripts/check-evidence-repro.ts` | 0 | “证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致” |
| 5 | `pnpm vitest run tests/integration/g2.spec.ts tests/integration/runtime.spec.ts tests/contract/routes.spec.ts tests/e2e/production-path.spec.ts tests/integration/sweep.spec.ts tests/integration/apply-report.spec.ts` | 0 | 6 files，**149 passed**（g2 14、runtime 25、routes 25、production-path 5、sweep 19、apply-report 61） |
| 6 | `pnpm vitest run tests/integration/agent-lifecycle.spec.ts tests/integration/bridge-ledger.spec.ts tests/unit/bridge-buffer.spec.ts tests/integration/runtime.spec.ts tests/e2e/production-path.spec.ts tests/contract/execution-concurrency.spec.ts` | 0 | 6 files，**73 passed**（agent-lifecycle 13、bridge-ledger 10、bridge-buffer 19、runtime 25、production-path 5、execution-concurrency 1） |
| 7 | `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` | 1 | 首错：“审计报告 sha256 与记录不符（报告改过就重新审计再签）：`b386173930739945…` != `3e0753072f37a86e…`”。属签前态，真实原因见第六节 |
| 8 | 端到端探针（干净 worktree，独立配置，见第四节） | 1 / 0 | 探针一 6/7 passed（失败项是 P1-2 断言）；探针二 6/6 passed |

计数口径：全量 844 passed / 1 skipped；必过集合 149 passed；桥闭环集合 73 passed。证据复现 25/25，两遍互比与 `git show HEAD` 均字节一致。

## 二、结论

**结论：fail。P0=0，P1=2，P2=6。**

M-63 把“唤醒”这一步修对了：等待事件命中后节点确为 `queued`，`lease_id` / `lease_expires_at` / `executor_*` / `wait_deadline_at` 全空，`rearm_generation=2`，dispatcher 能再次取到；子流程父节点在 `waiting` 时调用 `finishSubworkflowChild` 也返回 `queued`、租约为空。上一轮 P1“置 dispatched 后无人消费”的状态点已不再复现。

但端到端仍不闭合，两条 P1 都落在本候选新增链路上：

1. 子流程生产终态不是 `done`。真实子 run 收口为 `succeeded` 或 `succeeded_with_unverified`，而 `sweep` 的终态枚举只认 `done` 等旧值，父节点永远等不到唤醒——子流程成功路径不可用。
2. M-63 只改“唤醒后的状态”，没有定义“再次派发同一控制 spec”的收口。等待节点再次派发同一 wait spec 会 `RESOLUTION_NOT_AVAILABLE` 并把节点留在 `dispatched` 加租约，过期后转 `stopping`；子流程节点再次派发同一 subworkflow spec 会重新进入 `waiting`，形成 `queued ↔ waiting` 循环。

因此不能按“P1 已修复”签门。20 项必过行为本身全部复跑通过，P1 与第 53 轮同类口径单列，不改判必过项。

## 三、逐项结论

历史轮次行（第 50/51/53 轮及更早）未计入本轮；散文、表格单元与带结论标记的格均按当前 `audit_round` 扫描。本轮 G2 记录的候选范围是 `4f3ada7..HEAD`，HEAD 为 `c431cc8`。

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
| G-05 | 工具执行中取消只立一次围栏 | pass | 一致（门记录 sha 待重签） | `G-05.md` 复现通过；仍只有 1 条 `fence_armed`，第二次 `fence_already_armed`，围栏期间上报被拒，宽限到点 `fence_revoked` |
| G-07 | 墙钟跳变不误判截止 | pass | 一致 | `G-07.md`、`ev-g2-09` 复现通过 |
| G2-08 | 工具失败不许落完成（系统判失败并挂凭据） | pass | 一致 | `ev-g2-08` 复现通过；失败终态走 `requireFailure:true` |
| G2-09 | 判定时限只认 boot_id 与单调纳秒 | pass | 一致 | `ev-g2-09` 复现通过 |
| G2-10 | 报告入口系统级证据门（弱证据与伪造痕迹一律拒） | pass | 一致 | `ev-g2-10` 复现通过；`evidence_missing` / `verification_too_weak` / `evidence_unverifiable` 三拒路径均在 |
| G2-11 | 反复重投同一 report_id 不许把账本刷膨胀 | pass | 一致 | `ev-g2-11` 复现通过；`report_seq` 去重 |
| G2-12 | 工具授权只认 workflow 定义，请求体策略不参与 | pass | 一致 | `ev-g2-12` 复现通过；越权/未注册在租约前拒 |
| G2-13 | 单写者锁与 epoch 围栏：第二写者拿不到锁，旧 epoch 写不进 | pass | 一致 | `ev-g2-13` 复现通过；CAS 带 `action_generation` / `rearm_generation` |
| G2-14 | 长动作靠心跳续租，扫描不误判过期 | pass | 一致（门记录 sha 待重签） | `ev-g2-14.md` 复现通过；2.5 秒扫描 `lease_expired=0`，节点 `done`。门记录表记的 `61e9c435…` 不是 HEAD 内容，见 P2-3 |
| G2-15 | 同一工作流的同一版本跨重启不可改写，在飞 run 的判定条件不跟着变 | pass | 一致 | `ev-g2-15` 复现通过；版本不符抛 `WORKFLOW_VERSION_IMMUTABLE` |
| G2-16 | Agent Bridge 生产闭环：B01–B10 可复现，工具证据只来自宿主执行 | pass | 手写汇总（不在复现脚本内） | 桥 6 文件 **73 passed**；B06 独立子进程 SIGKILL → `EVIDENCE_SOURCE_UNAVAILABLE`；工具强证据只认 `ReadOnlyToolRunner.runTool()`，`reportFromAgent` 用宿主 trace 覆盖上报 trace。证据文本写 70 passed，计数待更新（P2-4） |

行为 20/20 通过；`must_pass_passed` 记 20，`failed_items` 留空。P1 不在任一必过项的行为上，按第 51/53 轮同类口径单列，不把必过项改判 fail。

## 四、P0 / P1

### P1-1 子流程成功收口不唤醒父节点：sweep 只认 `done`，生产终态是 `succeeded` / `succeeded_with_unverified`

**位置**

- `src/service/sweep.ts:321-335`：`finishedChildren` 查询条件是 `n.status='waiting' AND r.status IN ('done','failed','timeout','abandoned_unverified','failed_with_unverified','orphaned','superseded','cancelled')`。
- `src/service/commands/run-close.ts:23-63`：真实 run 的终态只写 `succeeded`、`succeeded_with_unverified`、`failed`、`failed_with_unverified`、`orphaned`。`unverified` 由 `side_effect_policy !== 'pure' && side_effect_verified_none !== 1` 决定；`side_effect_verified_none` 在 `src` 内从未置 1，默认策略是 `compensable`（迁移 017），所以普通成功子 run 落 `succeeded_with_unverified`，纯节点落 `succeeded`，两者都不在 sweep 的枚举里。
- `tests/integration/sweep.spec.ts:358-365` 直接种入 `status='done'` 的子 run，这不是生产 `run-close` 会写出的状态，测试因此掩盖了断链。

**复现（干净 worktree，独立探针，真实收口函数，不手写 `done`）**

1. 子工作流节点为纯节点，真实收口后子 run 为 `succeeded`；调用 `sweep` → `finished=[]`，父节点仍 `waiting`、`lease_id=null`。
2. 子工作流节点为默认 `compensable`，真实收口后子 run 为 `succeeded_with_unverified`；`sweep` → `finished=[]`，父节点仍 `waiting`。
3. 对照：子 run 落 `failed` 时 `sweep` 返回 `["nr1"]`，父节点转 `queued`、租约为空；手写 `done` 时同样返回 `["nr1"]` 并可被 dispatcher 以普通 spec 跑到 `done`。说明 M-63 本身生效，断的是“成功终态进不了 sweep”。

**期望 / 实际**

- 期望：子流程成功收口（含 `succeeded` / `succeeded_with_unverified`）后，父节点进入 `queued`，或直接按子 run 结果推进父节点/整个 run。
- 实际：只有失败或人工 `done` 能唤醒父节点；成功子流程的父节点永久 `waiting`。等待超时后才会转 `timeout`，子流程结果无人消费。

**影响**

本候选新增的子流程入口在成功路径端到端不可用，且现有测试用非生产状态 `done` 掩盖了它。不是证据复现问题，不能靠重生成证据消除。

### P1-2 M-63 未定义“再次派发同一控制 spec”的收口：等待节点报错后悬空，子流程节点 `queued ↔ waiting` 循环

**位置**

- `src/service/dispatcher.ts:124-203`：`dispatchControlNode` 先把节点 `queued → leased → dispatched → started`，再在事务内调 `enterWaiting` / `startSubworkflowNode`；异常被 catch 成 `failed` outcome，节点可能留在 `dispatched`/`started` 并持有租约。
- `src/service/commands/wait.ts:211-227`：`enterWaiting` 找到已有登记，只有 `state==='active'` 且幂等键相同才重扫；否则抛 `RESOLUTION_NOT_AVAILABLE '这个等待登记已经收口，不能复用'`。M-63 唤醒后登记保留为 `state='woken'`，因此再次派发同一 wait spec 必然走异常分支。
- `src/service/commands/subworkflow.ts:290-326`：`startSubworkflowNode` 只要求节点 `started`，随后直接 `started → waiting` 并调用 `createSubworkflowRun`；已有子 run 时 `createSubworkflowRun` 返回 `created:false`，但当前节点仍被无条件置回 `waiting`。没有“子 run 已成功收口、父节点应完成”的分支。

**复现（干净 worktree，端到端 HTTP/dispatch 路径）**

- 等待：事件唤醒后节点 `queued`、租约空；用普通工具 spec 再派发 → `done`。用**同一 wait 控制 spec** 再派发 → 返回 `failed`，`error_code=RESOLUTION_NOT_AVAILABLE`，原因“这个等待登记已经收口，不能复用”；节点行变为 `dispatched`，`lease_id=lease_01a1da70-a643-7b12-9626-51bbfdab3468`，`lease_expires_at` 为派发时刻 +1 分钟。再跑 `sweep` → `lease_expired=["nr1"]`，节点转 `stopping`、租约清空。节点永远到不了终态。
- 子流程：子 run 收口 + `sweep` 后父节点 `queued`、租约空；用**同一 subworkflow 控制 spec** 再派发 → 父节点回到 `waiting`（`waitingEvents=2`）；再收口、再 `sweep`、再派发 → 仍 `waiting`（`waitingEvents=3`），`childRuns=1`。重复尝试只增加等待事件次数，不推进。

**期望 / 实际**

- 期望：唤醒后的控制节点被再次派发时，要么由登记/子 run 结果直接收口到终态，要么以稳定幂等结果返回，不允许把节点留在“已派发 + 租约”或重新挂回等待。
- 实际：等待节点报 `RESOLUTION_NOT_AVAILABLE` 并悬空到租约过期转 `stopping`；子流程节点在 `queued` 与 `waiting` 之间循环。调用方最自然的动作——“唤醒后原样重试 dispatch”——正好触发这两条。

**影响**

M-63 修复了第 53 轮 P1 的第一个状态点，但新增入口的幂等/重试语义仍不可用。对调用方而言，`wait.woken` / `subworkflow.finished` 返回 200 只表示账本写了事件，不代表节点能收口。

## 五、P2（单列，不阻断本轮必过项）

1. **运行级取消不取消目标 run 自身的 `queued` / `leased` 节点。** `src/service/commands/subworkflow.ts:415` 的自有节点查询只取 `dispatched`、`started`、`waiting`、`verifying`；`applyCancel` 本身支持 `queued`/`leased → superseded`（`src/service/commands/cancel.ts:54-74`，M-62）。实测：run 下有 `queued` 节点，`POST /v1/runs/cancel {cancelResult:'interrupted'}` 返回 `cancelledNodes=[]`，节点仍 `queued`；随后 `dispatch` 仍会选中并执行它。第 53 轮 P2“目标 run 自身节点不取消”已在 `dispatched/started/waiting/verifying` 上修复且不重复取消子节点（实测 `cancelledNodes=["nr1", childNode]`，各一次），但 `queued`/`leased` 仍漏。
2. **M-63 让报告也能把 `waiting` 写回 `queued`。** `src/core/state-machine.ts:242` 的 `canReportTransition` 接受所有无 `requires` 的迁移；M-63（`:162`）没有 `requires`，实测 `canReportTransition('waiting','queued')=true`。等待节点租约为空，`assertLeaseValid` 在 `lease_expires_at` 为空时直接返回（`src/service/commands/lease.ts:127-129`），所以带正确 `expectedStatus='waiting'`、attempt、generation 的执行器报告可以把等待节点改成 `queued`，绕过事件唤醒与游标。M-21 早已允许 `waiting→dispatched`，这不是新类别，但 M-63 又扩了一个可写目标；`src/core/report.ts:15` 的报告状态是自由字符串，没有终态白名单。建议把控制态（`queued`/`waiting`/`leased` 等）从报告可写目标中排除。
3. **G2 门记录仍是签前态，审计锚点、候选哈希与两份证据 sha 均过期。** `docs/gates/G2.md` 记 `audit_report_sha256=b386173930739945…`，HEAD 上 `docs/audits/S2-independent-audit-round51.md` 的 LF sha 是 `3e0753072f37a86ead6fc37feb7e6424c4e2fd5646281a9bdc297d7c375d2010`，且该报告结论是 fail；`audit_round=51`、`candidate_hash=8fa91fbb…` 仍锚在更早候选。证据表 `ev-g2-14` 记 `61e9c435…`，HEAD 实际 `6d69d74d7cd3ecc0c9a8949b062fa5f4022c013c56a0216b1a8253fed1c067a8`；`G-05` 记 `d400f29d…`，HEAD 实际 `85b2ed07102834e1bebfc4bce9abd548dafaf2a825b5fa6b3abc5a908ee07437`。`gate-check` 首错即审计报告 sha，随后还会在候选范围/哈希处失败。重签前必须刷 `audit_round`、`audit_report`、`audit_report_sha256`、`candidate_hash`、`change_scope_hash`、`evidence_index_hash`、两份证据表与索引 sha、`body_hash`、`artifact_hash`。
4. **`ev-g2-16` 桥闭环计数仍是旧数。** `docs/gates/evidence/G2/ev-g2-16.md:51` 写 `6 files passed, 70 tests passed`；本轮实测 73 passed（agent-lifecycle 13、bridge-ledger 10、bridge-buffer 19、runtime 25、production-path 5、execution-concurrency 1）。行为通过，计数文本待更新。
5. **设计文档与代码注释漂移。** `docs/orchestra-design-draft.md:272` 仍写 `waiting → dispatched`（事件命中且抢到 slot），`:327` 的迁移清单仍是 `M-01…M-61`，没有 M-62/M-63；`src/service/commands/subworkflow.ts:335` 注释仍写“只允许 waiting→dispatched”，实际已是 `waiting→queued`。M-63 目前只存在于代码、测试与证据里，设计口径未同步。
6. **等待事件幂等键全局唯一，跨 run 相同键会静默丢事件（第 53 轮遗留）。** `src/infra/sqlite/migrations/018_wait_registrations.sql:11` 对 `wait_event_inbox.idempotency_key` 建了全局 `UNIQUE`，`:24` 对登记表同样全局唯一；`wakeOnEvent` 冲突时 `DO NOTHING` 后回读已有 `inbox_seq`，但扫描只取当前 `runId`，第二个 run 用同一键投递时拿到第一个 run 的序号，自己的等待不会被唤醒。调用方用全局 UUID 时不触发，语义上应把键唯一性限定到 run。

## 六、门检查失败的真实原因与重签清单

`gate-check` 在当前 HEAD 的首错是审计锚点，不是代码失败：

- `docs/gates/G2.md` 记录 `audit_report_sha256=b386173930739945…`，但 `docs/audits/S2-independent-audit-round51.md` 在 HEAD 的 LF sha 是 `3e0753072f37a86ead6fc37feb7e6424c4e2fd5646281a9bdc297d7c375d2010`，且该报告结论是 fail。`b386…` 是第 50 轮报告哈希；第 51 轮换路径时没有换哈希。
- 其后还会失败：候选范围已从第 50 轮锚点前进到 `c431cc8`，`candidate_hash` / `change_scope_hash` 必变；`ev-g2-14`、`G-05` 两份证据在候选内重生成过，表与索引 sha 未刷新；`evidence_index_hash`、`body_hash`、`artifact_hash` 需随正文与证据表一起重算。
- 本报告判 fail，暂不具备重签条件；先修 P1-1（把 `succeeded` / `succeeded_with_unverified` 纳入子流程收口或直接按子 run 结果推进父节点）、P1-2（定义唤醒后再派发的幂等收口），再按门记录流程更新上述锚点与两份证据哈希，才可进入下一轮签门。

## 七、failed_items 与裁决

`failed_items` 为空：20 项必过行为全过；两条 P1 落在新增等待/子流程接线的端到端语义，不落在任何单项必过行为上。

<!-- audit-verdict:begin -->
```json
{"schema":"audit-verdict/1","gate":"G2","audit_round":54,"candidate_commit":"c431cc8af1570b240f423e1d0376354142609890","conclusion":"fail","p0":0,"p1":2,"p2":6,"must_pass_total":20,"must_pass_passed":20,"must_pass_ids":["G2-01","G2-02","G2-03","G2-04","G2-05","G2-06","G2-07","G-03","G-04","G-05","G-07","G2-08","G2-09","G2-10","G2-11","G2-12","G2-13","G2-14","G2-15","G2-16"],"failed_items":[],"notes":"20/20 必过行为复跑通过；证据 25/25 字节复现；全量 844 passed / 1 skipped、必过 149 passed、桥 73 passed、typecheck/build exit 0、check-evidence exit 0；gate-check exit 1（审计报告 sha 与记录不符 b386… != 3e075307…）。P1-1：真实子 run 收口为 succeeded/succeeded_with_unverified，sweep 只认 done（sweep.ts:321-335、run-close.ts:23-63），成功子流程的父节点永不唤醒；测试种 done 掩盖（sweep.spec.ts:358-365）。P1-2：唤醒后再次派发同一控制 spec，wait 报 RESOLUTION_NOT_AVAILABLE 留 dispatched+租约（wait.ts:211-227），subworkflow 回到 waiting 形成 queued↔waiting 循环（subworkflow.ts:290-326）。P2：run 级取消漏 queued/leased 自身节点；M-63 放开报告 waiting→queued；G2 审计锚点/候选哈希/ev-g2-14 与 G-05 sha 过期；ev-g2-16 写 70 实测 73；设计文档无 M-62/M-63 且注释漂移；wait_event_inbox 幂等键全局唯一。"}
```
<!-- audit-verdict:end -->
