# S2 独立审计 · G2 · 第 55 轮

- 门：G2
- 候选提交：e0f96507add0021aa8c18a36d87c933f3c0f30cb
- 审计时间：2026-11-14
- 审计范围：候选 `4f3ada7..e0f9650` 的代码、测试与脚本（`candidate_hash` / `change_scope_hash` 覆盖这一段，排除 `docs/gates/G1.md`、`docs/gates/G2.md` 门记录自身与 `docs/audits`、`docs/reviews`、`handoff.md`；证据文件仍计入候选）。
- 审计方式：只读。审计开始时 `git status --porcelain` 为空、HEAD 为 `e0f9650`；审计中途（22:37–22:42）同目录出现其他 agent 的跟踪文件改动与未跟踪审计报告，非本报告产物。为把结论钉在候选上，全部测量与探针改在 `git worktree add --detach tmp/r55-wt e0f9650` 的干净树复跑（worktree `git status --porcelain` 为空），没有改源码、没有提交、没有签门；本报告是本轮唯一新增的报告文件。工作树被改动的事实本身记入本报告，worktree 在审计结束后删除。审计结束时主仓库 HEAD 已被其他 agent 推进到 `af3970b`（该提交同时包含本报告）；`e0f9650` 之后候选文件已被再次改动，这份报告不能再直接用于在 HEAD 签 G2（`gate-check` 会报“候选提交之后，候选文件又被改过”），要签需对 `af3970b` 重新审计。

## 一、命令与结果

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `pnpm typecheck`（`tsc --noEmit`） | 0 | 无输出 |
| 2 | `pnpm test`（`vitest run`） | 0 | 61 files，**844 passed / 1 skipped**，845 total，9.41s |
| 3 | `pnpm build`（`tsdown`） | 0 | `lib/index.js` 245.86 kB（gzip 59.37）、`lib/index.d.ts` 18.04 kB（gzip 4.39）、`lib/client.js` 0.29 kB |
| 4 | `node --no-warnings scripts/check-evidence-repro.ts` | 0 | “证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致” |
| 5 | `pnpm exec vitest run` 必过六文件（g2、runtime、routes、production-path、sweep、apply-report） | 0 | 6 files，**149 passed** |
| 6 | `pnpm exec vitest run` 桥闭环六文件（agent-lifecycle、bridge-ledger、bridge-buffer、runtime、production-path、execution-concurrency） | 0 | 6 files，**73 passed** |
| 7 | `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` | 1 | 首错：“审计报告 sha256 与记录不符（报告改过就重新审计再签）：`b386173930739945…` != `3e0753072f37a86e…`”。真实原因见第六节 |
| 8 | 端到端探针（干净 worktree，独立配置，见第四、五节） | 1 / 0 | 探针 55 两条断言失败（P2 租约残留、P1 取消后不可逆派发）；探针 55b 失败子 run 与取消后派发两段均复现 |

计数口径：全量 844 passed / 1 skipped；必过集合 149 passed；桥闭环集合 73 passed；证据复现 25/25，两遍互比与 `git show HEAD` 均字节一致。

## 二、结论

**结论：fail。P0=0，P1=2，P2=6。**

上一轮（第 54 轮）两条 P1 在 `e0f9650` 上均已闭合：

1. 子 run 真实收口为 `succeeded` / `succeeded_with_unverified` 后，`sweep` 能识别并收口父节点。三处终态枚举一致：`src/service/sweep.ts:331-336` 的 SQL 十项、`src/service/commands/subworkflow.ts:329-334` 的 `RUN_TERMINAL` 十项相同，`finishSubworkflowChild` 复用 `isRunTerminal`（`subworkflow.ts:357-381`）。探针用真实 `dispatch → closeRun` 造出两种终态，`sweep` 都返回父节点，未手种 `done`。
2. 同一 wait/subworkflow 控制 spec 在唤醒/收口后再次 dispatch 不再循环或悬空。wait 登记为 `woken` 后再次派发返回 `outcomes=[]`，节点保持 `done`、`wait.woken` 仍 1 条；subworkflow 再次派发同样 `outcomes=[]`，不回到 `waiting`，`subworkflow.finished` 仍 1 条；两条路径的租约与等待截止均为空。正常等待事件路径（事件落库→扫描→done）未被破坏。

但同一控制面上出现两条新的 P1：

1. `finishSubworkflowChild` 把**任意**子 run 终态都收成父节点 `done`。子 run 失败（`failed_with_unverified`）时，父节点照常 `done`，父 run 随后收口为 `succeeded_with_unverified`，账本里没有失败事件，失败只剩 `subworkflow.finished` 的 `child_status` 字段。
2. run 级取消跳过不可逆 `queued` 节点后，该节点仍留在 `queued`；下一次普通 `dispatch` 会把它执行掉并产生新副作用，run 最终仍收口为 `succeeded_with_unverified`，同时 `cancel_result=interrupted`。取消没有在 dispatcher 上设闸。

因此不能按“上一轮 P1 已修复”签门。20 项必过行为本身全部复跑通过，P1 与第 51/53/54 轮同类口径单列，不改判必过项。

## 三、逐项结论

历史轮次行（第 50/51/53/54 轮及更早）未计入本轮；散文、表格单元与带结论标记的格均按当前 `audit_round` 扫描。本轮 G2 门记录仍停在 `audit_round=51`，`proseVerdictClashes(G2 正文, 'pass', spec.items, {auditRound:51})` 返回 `[]`：正文结论与必过项表一致，历史行没有误判。门记录的轮次与候选锚点过期问题单列 P2-2。

| 必过项 | 要求 | 行为结论 | 证据复现 | 本轮依据 |
| --- | --- | --- | --- | --- |
| G2-01 | 单节点 queued 到终态一条路径（走生产装配） | pass | 一致（证据文件 sha 待刷新） | `ev-g2-01` 从 HTTP `load → runs → dispatch` 真跑，节点 `done`、`evidence_source=run_tool`、run 实际落 `succeeded_with_unverified`；字节复现通过；门记录表里的 `ev-g2-01` sha 仍是旧值，见 P2-2 |
| G2-02 | 重复上报只落一次 | pass | 一致 | `ev-g2-02` 复现通过；`g2.spec.ts` / `apply-report.spec.ts` 通过 |
| G2-03 | 租约过期迟到上报被拒 | pass | 一致 | `ev-g2-03` 复现通过；租约用例通过 |
| G2-04 | 取消后不产生新 attempt | pass | 一致 | `ev-g2-04` 复现通过；节点级取消 attempt 不变、新 attempt 上报被 `attempt_mismatch` 拒。run 级取消的派发闸缺失单列 P1-2 |
| G2-05 | 终态必带证据 | pass | 一致（证据文件 sha 待刷新） | `ev-g2-05`、`ev-g2-10` 复现通过；系统级证据门在 `src/service/commands/apply-report.ts:543-546`、痕迹绑定在 `:615-625`；`ev-g2-10` sha 旧值见 P2-2 |
| G2-06 | 无裸 blocked（没裁决卡不许卡住） | pass | 一致 | `ev-g2-06` 复现通过；`DECISION_REQUIRED` 拒无凭据 blocked |
| G2-07 | S2 加载 parallel 被拒 | pass | 一致 | `ev-g2-07` 复现通过；`production-path.spec.ts` 通过 |
| G-03 | 同一 report_id 上报两次只落一次 | pass | 一致 | `ev-g2-g03` 复现通过；`report_registry` 去重 |
| G-04 | 租约到期后原执行器迟到上报被拒 | pass | 一致 | `ev-g2-g04` 复现通过 |
| G-05 | 工具执行中取消只立一次围栏 | pass | 一致（门记录 sha 待刷新） | `ev-g2-g05` 复现通过；仍只有 1 条 `fence_armed`，第二次 `fence_already_armed`，宽限到点 `fence_revoked`；门记录表里的 sha 仍是旧值，见 P2-2 |
| G-07 | 墙钟跳变不误判截止 | pass | 一致 | `ev-g2-g07`、`ev-g2-09` 复现通过 |
| G2-08 | 工具失败不许落完成（系统判失败并挂凭据） | pass | 一致 | `ev-g2-08` 复现通过；失败终态走 `requireFailure:true` |
| G2-09 | 判定时限只认 boot_id 与单调纳秒 | pass | 一致 | `ev-g2-09` 复现通过 |
| G2-10 | 报告入口系统级证据门（弱证据与伪造痕迹一律拒） | pass | 一致（证据文件 sha 待刷新） | `ev-g2-10` 复现通过；`evidence_missing` / `verification_too_weak` / `evidence_unverifiable` 三拒路径均在；sha 旧值见 P2-2 |
| G2-11 | 反复重投同一 report_id 不许把账本刷膨胀 | pass | 一致 | `ev-g2-11` 复现通过；`report_seq` 去重 |
| G2-12 | 工具授权只认 workflow 定义，请求体策略不参与 | pass | 一致 | `ev-g2-12` 复现通过；越权/未注册在租约前拒 |
| G2-13 | 单写者锁与 epoch 围栏：第二写者拿不到锁，旧 epoch 写不进 | pass | 一致 | `ev-g2-13` 复现通过；CAS 带 `action_generation` / `rearm_generation` |
| G2-14 | 长动作靠心跳续租，扫描不误判过期 | pass | 一致（门记录 sha 待刷新） | `ev-g2-14` 复现通过；2.5 秒扫描 `lease_expired=0`，节点 `done`；sha 旧值见 P2-2 |
| G2-15 | 同一工作流的同一版本跨重启不可改写，在飞 run 的判定条件不跟着变 | pass | 一致 | `ev-g2-15` 复现通过（含跨进程重启场景）；版本不符抛 `WORKFLOW_VERSION_IMMUTABLE` |
| G2-16 | Agent Bridge 生产闭环：B01–B10 可复现，工具证据只来自宿主执行 | pass | 手写汇总（不在复现脚本内） | 桥 6 文件 **73 passed**；B06 独立子进程 SIGKILL → `EVIDENCE_SOURCE_UNAVAILABLE`；B07 真实子进程 SIGKILL 后 exitCode/signalCode 非空才 dispose；B05 抛 `BRIDGE_SEQ_CONFLICT`；B10 从处理位重放；工具强证据只认 `ReadOnlyToolRunner.runTool()`。证据文本写 70 passed / 624 passed，计数待更新（P2-3） |

本轮另核（不单独计项）：

- 三游标在 `src/executor/bridge.ts:202-204`（`lastReceivedSeqValue` / `lastContiguousSeqValue` / `lastPersistedAckSeqValue`），`ack(seq)` 只允许 `seq === lastPersistedAckSeq + 1` 且已落账（`bridge.ts:318-340`）；`src/executor/bridge-ledger.ts:100-130` 在同一事务内写 receipt 与 `last_persisted_ack_seq`，同 seq 同 payload 幂等、不同 payload 抛 `BRIDGE_SEQ_CONFLICT`，不连续序号拒收。本地 ACK 以事务提交成功为准。
- 账本事件链（`prev_hash` / `hash`）与 `report_seq` 去重由必过集合与全量用例覆盖；证据复现 25/25。

行为 20/20 通过；`must_pass_passed` 记 20，`failed_items` 留空。P1 不在任一必过项的行为上。

## 四、P0 / P1

### P1-1 子流程任意终态都收成父节点 `done`：失败子 run 被记成父 run 成功

**位置**

- `src/service/commands/subworkflow.ts:357-381`：`finishSubworkflowChild` 只要 `isRunTerminal(child.status)` 就 `applyTransition({ from: ['waiting'], to: 'done' })`；`subworkflow.ts:372` 的注释写明“子运行终态即完成”，事件 `subworkflow.finished` 只带 `child_run_id` / `child_status`（`subworkflow.ts:376-379`），没有失败/取消分支，也没有 `subworkflow.failed` 事件。
- `src/service/sweep.ts:337`：`if (out.status === 'done') subworkflowFinished.push(...)` 把上面这个 `done` 当成功收口继续推进；`subworkflow.ts:329-334` 的 `RUN_TERMINAL` 十项包含 `failed` / `failed_with_unverified` / `orphaned` / `superseded` / `cancelled`，但这条映射把它们全部折叠成同一结果。
- `src/service/commands/run-close.ts:47`：父 run 的收口只看节点状态与副作用策略；父节点 `done`、策略默认 `compensable`，父 run 落 `succeeded_with_unverified`。

**复现（干净 worktree，真实收口函数）**

1. 父节点 `swf`（`node_type=subworkflow`）派发后 `waiting`，创建子 run。
2. 子 run 的节点真实置 `failed` 后调用生产 `closeRun`，子 run 落 `failed_with_unverified`。
3. `sweep` 返回 `subworkflow_finished=['swf']`；父节点 `swf` 变 `done`，`lease_id` / `lease_expires_at` 均为 `null`。
4. 事件只有 `lease_acquired`、`status_changed(control_started)`、`subworkflow.waiting`、`subworkflow.finished`（`child_status='failed_with_unverified'`）；`subworkflow.failed` 计数 0。
5. 再 `dispatch` 空节点列表，父 run 收口 `succeeded_with_unverified`。

对照上一轮：`c431cc8` 上失败子 run 会让父节点回 `queued`；`e0f9650` 改成 `done` 后，失败被吞掉，方向从“不推进”变成“误报成功”。

**期望 / 实际**

- 期望：子 run 失败/取消/超时，父节点至少不能以“成功完成”收口；应把子 run 终态映射到父节点的失败/未验证语义，或把失败写进父 run 的裁决依据。
- 实际：任意终态 → 父节点 `done` → 父 run `succeeded(_with_unverified)`。调用方从 run 状态上无法区分“子流程成功”和“子流程失败”。

**影响**

子流程入口在失败路径上给出假成功。S2 阶段不开放 `subworkflow` 节点（`docs/orchestra-design-draft.md:2127`、`src/core/config.ts` 的 S2 能力表），所以不落在 G2 必过项上；但这条链路是 `e0f9650` 本次修复的核心对象，按第 54 轮同类口径列 P1。

### P1-2 run 级取消后，不可逆 `queued` 节点仍可被派发并产生新副作用

**位置**

- `src/service/commands/subworkflow.ts:421-424`：`propagateRunCancellation` 对 `queued` / `leased` / `dispatched` / `started` / `waiting` / `verifying` 六种状态发取消；`side_effect_policy === 'irreversible'` 进 `skippedIrreversible` 后 `continue`，节点保持在 `queued`。
- `src/service/dispatcher.ts:58`：`dispatchRun` 只按 `status = 'queued'` 取节点，不检查 `runs.cancel_requested_at` / `runs.cancel_result`。
- `src/service/commands/subworkflow.ts:412`：`propagateRunCancellation` 只写 `runs.cancel_requested_at` / `cancel_result`，不改 run 状态；取消后 run 仍是 `running`。

**复现（干净 worktree，绑定工作流定义，真实 HTTP 入口）**

1. 加载含两个 agent 节点（`c0`、`iq`）的工作流，创建 run，两节点 `queued`；把 `iq` 的策略改为 `irreversible`。
2. `POST /v1/runs/cancel {cancelResult:'interrupted', graceMs:0}` → 200；`cancelledNodes=[c0]`、`skippedIrreversible=[iq]`；`c0` → `superseded`，`iq` 仍 `queued`；run 仍 `status=running`、`cancel_result=interrupted`。
3. 随后 `POST /v1/runs/dispatch` 带 `iq` 的 `ro.echo` 工具 spec → `iq` 执行完成，`status=done`、`evidence_source=run_tool`、`revision=4`。
4. 再 `dispatch` 空列表 → run 收口 `succeeded_with_unverified`，同时 `cancel_result=interrupted`。

**期望 / 实际**

- 期望：run 级取消后，未派发的不可逆节点不能被普通 dispatch 自动执行；要么停在需要人工裁决的状态，要么由取消路径显式收口，至少不能让“取消”与“新副作用”同时成立。
- 实际：不可逆节点只被跳过，没有标记为待裁决；dispatcher 不认 run 取消位，下一次派发照常执行，run 还按成功收口。

**影响**

调用方发出取消后仍会看到新的工具副作用与成功终态，取消语义在“不可逆 + 未派发”组合上失效。这是第 54 轮 P2-1（run 级取消漏 `queued` / `leased`）修复后的残留分支。

## 五、P2（单列，不阻断本轮必过项）

1. **`leased` → `superseded` 不清租约，残留租约永不回收。** `src/service/commands/cancel.ts:58-73` 的取消前分支只 patch `cancel_requested_at` / `cancel_result`；`src/service/commands/lease.ts:141` 的过期扫描只取 `status IN ('dispatched','started')`。实测：`nc_l` 取消后 `status=superseded`，`lease_id='lease_l'`、`lease_expires_at='2026-11-14T23:00:00.000Z'` 仍在。节点不会再被派发，但租约字段与“终态无租约”的账本口径不一致，也永远不会被扫描清掉。

2. **G2 门记录仍是签前态，审计锚点、候选哈希、正文自锚与四份证据 sha 全部过期；G1 的自锚同样失配。** `docs/gates/G2.md` 记 `audit_round=51`、`audit_report=S2-independent-audit-round51.md`、`audit_report_sha256=b386173930739945…`，候选树上该报告的 LF sha 是 `3e0753072f37a86ead6fc37feb7e6424c4e2fd5646281a9bdc297d7c375d2010`，且报告结论是 fail。按候选 `e0f9650` 重算：`candidate_hash` 记录 `8fa91fbb…`、实际 `a31eb4c6b58df25dd678311bb40272f2ef38dbdbfb979797edd511fe47710270`（202 文件）；`change_scope_hash` 记录 `a66761ea…`、实际 `c24ebe4e4520d6dacb791d9499c2f48b22a52ea5a8f7192109f3bddadcddf973`（202 路径）；`body_hash` 锚 `daec42cc…`、实际 `0179a365b2fe4d45b5b97213075159873190edb6503ad003e80f8608748568b0`；`artifact_hash` 锚 `c5b4564a…`、实际 `09be93b27e5f6e3103e3756b6c7a67f66ce4800d0216aa54f7d572d643cbf07d`；`evidence_index_hash` 记录 `45cb5d6d…` 与表内 20 条自洽，但 4 份证据文件内容已变：`ev-g2-01` `71825a7d…`→`cee94009…`、`ev-g2-10` `3f3ba099…`→`bd360512…`、`ev-g2-14` `61e9c435…`→`6d69d74d…`、`ev-g2-g05` `d400f29d…`→`85b2ed07…`；`invariants_hash` 记录 `6a7adcb0…` 与实际一致（12 条）。成因可追到提交 `0a576ea` 手工把 G1/G2 的 `audit_round` 50→51、报告路径指向 round51，但没有重跑 `sign-gate`，锚点停在 round50；`166ca70` 只改正文说明。G1 同样失配：正文锚 `1c090377…`，artifact 实算 `6b059c8ab09be42d881ff1380d42d094d72e1a5d63d75a7ca22c9bf2fa0962ea`，`gate-check G1` 首错为审计报告 sha `355a1a58…` != `e3eee746…`。G2 的 `previous_artifact_hash` 目前正好等于 G1 正文锚，所以前序链检查会过；G1 重签后必须同步更新。

3. **`ev-g2-16` 桥闭环计数仍是旧数。** `docs/gates/evidence/G2/ev-g2-16.md:51` 写 `6 files passed, 70 tests passed`，本轮实测 73 passed（agent-lifecycle 13、bridge-ledger 10、bridge-buffer 19、runtime 25、production-path 5、execution-concurrency 1）；`:54` 写 `42 files passed, 624 passed | 1 skipped`，本轮全量是 61 files、844 passed | 1 skipped。行为通过，计数文本待更新。

4. **设计文档与代码注释漂移。** `docs/orchestra-design-draft.md:272` 仍写 `waiting → dispatched`（事件命中且抢到 slot），`:327` 的迁移清单仍是 `M-01…M-61`，没有 M-62/M-63；`src/service/commands/subworkflow.ts:339` 注释仍写“只允许 waiting→dispatched；重复调用在看到 dispatched 时幂等返回”，实际已是 `waiting→done` 且早退条件是 `done`。M-63 只存在于代码、测试与证据里。

5. **等待事件幂等键全局唯一，跨 run 相同键会静默丢事件（第 53 轮遗留）。** `src/infra/sqlite/migrations/018_wait_registrations.sql:11` 对 `wait_event_inbox.idempotency_key` 建了全局 `UNIQUE`，`:24` 对 `wait_registrations.idempotency_key` 同样全局唯一；`wakeOnEvent` 冲突时 `DO NOTHING` 后回读已有 `inbox_seq`，扫描只取当前 `runId`，第二个 run 用同一键投递会拿到第一个 run 的序号，自己的等待不会被唤醒。调用方用全局 UUID 时不触发，语义上应把键唯一性限定到 run。

6. **生产路径上 `succeeded` 不可达，成功 run 一律落 `succeeded_with_unverified`。** `src/service/commands/run-close.ts:47` 的 `unverified` 要求节点 `side_effect_policy === 'pure'` 或 `side_effect_verified_none === 1`，但 `src` 内没有任何代码写这两个值（迁移 017 默认 `compensable`，迁移 002 默认 `side_effect_verified_none=0`；全仓只有 `run-close.spec.ts` 手工改库来触发 `succeeded`）。实测 `ev-g2-01` 与 wait/subworkflow 探针的 run 都落 `succeeded_with_unverified`，只有探针手工把子节点改成 `pure` 后才得到 `succeeded`。G2 的 `run_terminal` 是 `not_applicable`，不阻断必过项，但“已核实无副作用”与“未核实”两档在账本上实际只有一档。

## 六、门检查失败的真实原因与重签清单

`gate-check` 在当前 HEAD 的首错是审计锚点，不是代码失败：

- `docs/gates/G2.md` 记录 `audit_report_sha256=b386173930739945…`，但 `docs/audits/S2-independent-audit-round51.md` 在 HEAD 的 LF sha 是 `3e0753072f37a86ead6fc37feb7e6424c4e2fd5646281a9bdc297d7c375d2010`，且该报告结论是 fail；`b386…` 是第 50 轮报告哈希，第 51 轮换路径时没有换哈希。
- 其后还会失败：`audit_round` 仍 51、候选哈希仍锚在更早候选，`candidate_hash` / `change_scope_hash` 必变；`ev-g2-01`、`ev-g2-10`、`ev-g2-14`、`G-05` 四份证据在候选内重生成过，表与索引 sha 未刷新；`evidence_index_hash`、`body_hash`、`artifact_hash` 需随正文与证据表一起重算。
- 前序门 G1 自身也坏在锚点与审计报告 sha 上；重签顺序应先把 G1 签好并提交，再按 G1 正文新的 `artifact_hash` 更新 G2 的 `previous_artifact_hash`。
- 本报告判 fail，暂不具备重签条件；先修 P1-1（子 run 终态到父节点的映射）、P1-2（dispatcher 尊重 run 取消位，不可逆未派发节点停在待裁决而不是可被普通派发），再按门记录流程更新上述锚点与四份证据哈希，才可进入下一轮签门。

## 七、failed_items 与裁决

`failed_items` 为空：20 项必过行为全过；两条 P1 落在新增等待/子流程控制面的端到端语义，不落在任何单项必过行为上。

<!-- audit-verdict:begin -->
```json
{"schema":"audit-verdict/1","gate":"G2","audit_round":55,"candidate_commit":"e0f96507add0021aa8c18a36d87c933f3c0f30cb","conclusion":"fail","p0":0,"p1":2,"p2":6,"must_pass_total":20,"must_pass_passed":20,"must_pass_ids":["G2-01","G2-02","G2-03","G2-04","G2-05","G2-06","G2-07","G-03","G-04","G-05","G-07","G2-08","G2-09","G2-10","G2-11","G2-12","G2-13","G2-14","G2-15","G2-16"],"failed_items":[],"notes":"第54轮两条P1已闭合（sweep/RUN_TERMINAL/finish 三处终态枚举一致，真实 succeeded/succeeded_with_unverified 子 run 都能收口父节点；同一 wait/subworkflow spec 再派发返回 outcomes=[]、不循环、不悬空）。新 P1-1：finishSubworkflowChild 把 failed/orphaned 等任意终态收成父节点 done，父 run 记 succeeded_with_unverified，失败只剩 subworkflow.finished.child_status。新 P1-2：run 级取消跳过不可逆 queued 节点后，dispatcher 不查 cancel_requested_at，下一次 dispatch 仍执行该节点并收口成功。P2：leased→superseded 不清租约；G2 门记录签前态（audit_round=51、报告 sha b386…!=3e075307…、candidate 8fa91fbb…!=a31eb4c6…、change_scope、body、artifact、ev-g2-01/10/14/g05 四份证据 sha 全过期，G1 自锚失配）；ev-g2-16 写 70/624 实测 73/844；设计稿与注释漂移；wait_event_inbox 幂等键全局唯一；生产路径 succeeded 不可达。实测：typecheck/build exit 0，全量 844 passed/1 skipped，必过 149，桥 73，证据 25/25 复现，gate-check exit 1。"}
```
<!-- audit-verdict:end -->
