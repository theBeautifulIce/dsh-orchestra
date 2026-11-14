# S3 独立审计报告（第 4 轮）

## 结论

**fail**。20 项必过项通过 17 项，失败 3 项：G3-07、G3-08、G3-11。failed_items = `["G3-07","G3-08","G3-11"]`。P0 = 0，P1 = 3，P2 = 11。

第 3 轮三项 P1 的修复情况并不一致：

- **P1-1（blocked_pre 恢复）已真修**：`resolveDecision` 现在返回被阻塞节点，生产装配层在同一事务里调用 `resumeFromBlockedPre`，批准回 `queued`，拒绝/超时回 `failed`。G3-04 通过。
- **P1-2（生产无调用者）只修了补偿**：`startCompensation` / `settleCompensation` 有 HTTP 路由和 `index.ts` 装配；wait 的唤醒路径、子流程的收口与父取消传播仍无生产入口。G3-09 通过，G3-07、G3-08 仍失败。
- **P1-3（sweep 三件事）只修了两件**：动作时限与 inbox 回执过期进入生产扫描；执行器失联与桥断/桥恢复仍只有参数和测试，没有生产信号喂入。G3-11 仍失败。

## 候选

- 候选 commit：`4e431c64ee4f382238901a2a04956ae8a8d70e0d`（`origin/main`，`main` 分支 HEAD）
- 审计开始与结束时 `git status --porcelain` 均为空；候选代码与 `10fb8fa887fa00e8a919f8e42099e6bd180908d8` 完全一致，`4e431c6` 只改了 `docs/gates/evidence/G2/G-05.md` 与 `docs/gates/evidence/G2/ev-g2-14.md` 各一行。
- 审计期间唯一写入：本报告。未提交、未签门、未改 `docs/gates/G3.md`。
- `10fb8fa` 上先跑过一轮 typecheck/test/build（结果见复现命令表），随后按 `4e431c6` 全部重跑；下表数字均为 `4e431c6` 实测。

## 方法

1. 读 `AGENTS.md`、`docs/gates/G3.md`、`docs/audits/S3-independent-audit-round3.md`、`handoff.md`，固定 20 个必过项编号与第 3 轮失败项。
2. 以 `68fa92b..4e431c6` 的 diff 定位本轮实际改动（21 个文件，+1218/−39），只对改动涉及的决策、调度、服务路由、sweep 做独立代码核验；未改动项沿用第 3 轮的代码结论，并用本轮全量测试复核。
3. 三项 P1 逐条追生产入口：从 HTTP 路由 → `src/index.ts` 装配 → service 命令 → 事务/状态迁移 → 事件，不以新增测试或文档作为修复证据；测试只用来确认行为边界。
4. 逐项判定 G3 必过项；P2 也给出文件与行号。历史审计中的失败项逐条重验，修好的不再计为本轮失败。
5. 实跑 `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm gate`，记录退出码、计数与产物大小。

### 第 3 轮 P1 复核

**P1-1 已修。** `src/service/commands/decisions.ts:212-219` 在关闭决策时查询 `node_runs WHERE blocked_decision_id = ? AND status = 'blocked_pre'`，把 `node_run_id/attempt` 作为 `blockedNode` 返回；`src/index.ts:142-167` 在同一 `inTx` 内先 `resolveDecision`，再按 `closedReason` 调 `resumeFromBlockedPre`，`contentHash` 也一并传入。`src/service/commands/nodes.ts:304-383` 校验租约已清、决策绑定、审批未过期、内容哈希一致；批准走 `blocked_pre→queued` 并清 `resume_state/blocked_decision_id`，拒绝/`expired_final` 走 `blocked_pre→failed`。恢复抛错会连同决策一起回滚，不存在“决策已关、节点仍挂起”的半态。`closeRun`（`src/service/commands/run-close.ts:23-64`）在节点非终态时拒绝收口，先 `closeRun` 再恢复的顺序也安全。

**P1-2 部分修。** 补偿：`src/service/server.ts:327-337`、`:338-349` 暴露 start/settle 路由，`src/index.ts:169-183` 用 `inTx` 装配，`src/service/commands/compensation.ts:70-107` 按 `compensation_id` 幂等，`:138-173` 失败落 `failed_with_unverified`。wait：`src/service/commands/wait.ts:195-276` 的 `enterWaiting` 可由 `dispatcher.ts:138-163` 进入，但唯一写 `wait_event_inbox` 并回扫的 `wakeOnEvent`（`wait.ts:279-288`）在 `src/` 内无调用者，服务端也没有 wait 事件入口。subworkflow：`startSubworkflowNode` 可由 `dispatcher.ts:168-187` 进入，但 `finishSubworkflowChild`（`subworkflow.ts:337`）与 `propagateRunCancellation`（`:396`）在 `src/` 内无调用者，`closeRun` 没有子 run 收口钩子，服务端没有 run 级取消路由。

**P1-3 部分修。** `src/service/sweep.ts:256-293` 动作时限、`:325` inbox 回执过期已进入扫描并可由 `src/index.ts:279` 的 2 秒定时器触达；`:295-323` 执行器失联也实现了 `applyTransition→orphaned`，但唯一生产调用 `runtime.ts:62-64` 只传 `{now,clock,catalog}`，`executorLost`、`bridgeMissing`、`bridgeRestored` 从未被生产层传入，`sweep` 也没有从 `index.ts` 导出。这三段只在测试里被驱动。

## 检查项

| 编号 | 必过项 | 结果 | 证据 |
|---|---|---|---|
| G3-01 | M-01..M-62 迁移用例每条覆盖，非法迁移全拒 | pass | `tests/integration/migration-cases.spec.ts`：59 条迁移规则（123 个 from、72 个 to、10 个 requires）逐条断言，非法组合拒绝 |
| G3-02 | 所有节点迁移走 CAS，迟到 attempt 不污染新行 | pass | `src/service/commands/nodes.ts:80-156` 统一 CAS（status/attempt/revision/action_generation/rearm_generation），`changes!==1` 抛 `STALE_GENERATION`；`tests/integration/node-runs.spec.ts` 覆盖迟到 attempt |
| G3-03 | 半态时钟与桥断冻结矩阵 | pass | `tests/integration/half-state.spec.ts` 5 例：跨 boot 剩余量不计停机、回拨夹零、桥断冻结 |
| G3-04 | blocked_pre 审批往返：旧租约清除、内容哈希绑定、拒绝/超时不回 queued | pass | `decisions.ts:212-219` + `index.ts:142-167` 同事务恢复；`nodes.ts:239-286` 清租约；`:304-383` 哈希与过期校验；`tests/integration/approval.spec.ts` 7 例 |
| G3-05 | policy 九算子与 branch 路由，多命中不猜、无命中有凭据落 blocked_post | pass | `tests/integration/policy-branch.spec.ts` 10 例；本轮未改动该路径，全量复跑通过 |
| G3-06 | 并行汇聚 all/any/quorum 与不可逆子节点闸 | pass | `tests/integration/parallel.spec.ts` 6 例；`src/service/commands/parallel.ts` 本轮未改动 |
| G3-07 | wait 先落 inbox 再匹配：早到回扫、唤醒幂等、超时与饥饿分记 | **fail** | 进入 `waiting` 可达（`dispatcher.ts:138-163`），但写入 inbox 并回扫的 `wakeOnEvent`/`recordWaitEvent`（`wait.ts:97`、`:279-288`）无生产调用者，服务端无 wait 事件路由；`wait.spec.ts` 直接调内部函数 |
| G3-08 | 子流程 pin 版本、深度与环检测、父取消向子 run 传播 | **fail** | `startSubworkflowNode` 可进入（`subworkflow.ts:290-326`，pin/深度/环检测齐备），但 `finishSubworkflowChild`（`:337`）与 `propagateRunCancellation`（`:396`）无生产调用者；`closeRun` 无子 run 收口钩子；服务端仅 `/v1/node-runs/cancel`，无 run 级取消 |
| G3-09 | 补偿按 compensation_id 幂等一次，失败落 failed_with_unverified | pass | `compensation.ts:70-107` 幂等插入、冲突描述符拒绝；`:138-173` CAS 收口与 `failed_with_unverified`；`server.ts:327-349` + `index.ts:169-183` 生产接线；`compensation.spec.ts` 9 例 |
| G3-10 | 报告冲突与 uphold 收口，挂起节点只认两条裁决出口 | pass | `tests/integration/apply-report.spec.ts` 61 例；本轮未改动该路径，全量复跑通过 |
| G3-11 | 恢复扫描可重入：断链跳过、桥断挂起、启动未知到点转未知态 | **fail** | 断链/动作时限/回执过期在扫描内（`sweep.ts:256-325`），但 `executorLost`、`bridgeMissing`、`bridgeRestored` 无生产信号；`runtime.ts:62-64` 只传 `{now,clock,catalog}`，`index.ts:353` 不导出 `sweep`。桥断挂起与执行器失联在生产不可达 |
| G-01 | COMMIT 前杀进程 | pass | `docs/gates/evidence/G1/G-01.md`；本轮全量含故障注入用例，未发现回归 |
| G-02 | COMMIT 后未投递被杀 | pass | `docs/gates/evidence/G1/G-02.md`；同上 |
| G-04 | 租约到期后原执行器迟到上报被拒 | pass | `docs/gates/evidence/G2/G-04.md`；`acquireLease`/CAS 路径本轮未改动 |
| G-06 | tool.result 丢失后同 callId 只重发结果不重跑工具 | pass | `docs/gates/evidence/G3/G-06.md`；`tests/integration/g3-faults.spec.ts:45-52` 断言 `tool_started`/`tool_finished` 各一条，但 outbox/exitCode 未直接断言（P2-3） |
| G-12 | 审批双击同 revision 只赢一笔 | pass | `docs/gates/evidence/G3/G-12.md`；决策 CAS 与全量用例通过 |
| G-16 | 父取消向子 run 传播且跳过不可逆节点 | pass | `docs/gates/evidence/G3/G-16.md`；命令级用例通过。生产入口缺口计入 G3-08，不重复判 G-16 失败 |
| G3-12 | 起运行固定版本、自治档位与 operation_id 幂等 | pass | `tests/unit/start-run.spec.ts` 10 例；`src/service/commands/start-run.ts` 本轮未改动 |
| G3-13 | 批准人三档：审计能力位、不得批准自己证据、human 档不被 Agent 代批 | pass | `tests/unit/approver.spec.ts` 5 例；`decisions.ts:62/172` 走 `defaultApprover`/`assertApprover` |
| G3-14 | S3 全量测试与构建全绿 | pass | 本轮实测：typecheck exit 0；test 61 文件 / 838 passed / 1 skipped / exit 0；build exit 0，ESM 235.96 kB（gzip 57.01 kB）、d.ts 17.57 kB；`git status` 复跑后仍为空 |

统计：pass 17，fail 3（G3-07、G3-08、G3-11）。

## P0 / P1 / P2

### P0

无。

### P1

**P1-1（G3-07）wait 的唤醒路径没有生产入口。**
`enterWaiting`（`src/service/commands/wait.ts:195-276`）现在能由 `dispatchControlNode`（`src/service/dispatcher.ts:138-163`）调用，节点会进入 `waiting` 并写 `wait_registrations`，早到事件也会在注册时回扫；但真正把外部事件写入 `wait_event_inbox` 并触发匹配的 `wakeOnEvent`（`wait.ts:279-288`）在 `src/` 内没有任何调用者。`grep -rn "wakeOnEvent\|recordWaitEvent" src/` 只命中 `wait.ts` 自身；`src/index.ts:353` 只导出 `renewNodeLease/runNode/sweepNow/submitReport`；服务端没有 wait 事件路由。结果是：wait 节点可以进入等待、可以被 sweep 超时，但生产环境里没有任何合法入口把“事件到了”告诉它。`tests/integration/wait.spec.ts` 直接调用 `wakeOnEvent`/`recordWaitEvent`，只证明库函数正确，不证明生产闭环。G3-07 要求的“先落 inbox 再匹配、早到回扫、唤醒幂等”在生产路径上不成立。

**P1-2（G3-08）子流程只能启动，不能收口，也不能随父取消传播。**
`startSubworkflowNode`（`src/service/commands/subworkflow.ts:290-326`）已可由 dispatcher 进入，pin 版本、深度 ≤2、祖先环检测、父 `started→waiting` 都在；但 `finishSubworkflowChild`（`:337-375`）在 `src/` 内无调用者，`closeRun`（`run-close.ts:23-64`）只调用 `assertRunCanTerminal` 阻止父先收口，没有“子 run 终态 → 推进父节点”的钩子；`propagateRunCancellation`（`:396-447`）同样无生产调用者，服务端只有 `/v1/node-runs/cancel`，没有 run 级取消路由。子 run 被创建后，父节点会永久停在 `waiting`；父 run 取消也不会下传。`tests/integration/subworkflow.spec.ts:191-213` 手调 `finishSubworkflowChild`/`propagateRunCancellation`，属于库级验证。另：`startSubworkflowNode` 没有写 `wait_deadline_at` 或 `wait_registrations`，父等待连超时都没有（P2-11）。G-16 的命令级行为通过，但生产入口缺口按 G3-08 计。

**P1-3（G3-11）执行器失联与桥断/桥恢复信号没有生产来源。**
`sweep` 已实现 `executorLost`（`src/service/sweep.ts:295-323`）与 `bridgeMissing`/`bridgeRestored`（`:169-254`），动作时限（`:256-293`）与回执过期（`:325`）也接入了 `sweepNow`；但 `src/service/commands/runtime.ts:62-64` 的 `sweepNow` 只传 `{now,clock,catalog}`，`executorLost`、`bridgeMissing`、`bridgeRestored` 三个参数在整个 `src/` 中没有被赋值，`sweep` 本身也未从 `src/index.ts` 导出（`:353` 只有 `sweepNow`）。`grep -rn "executorLost" src/` 只命中 `sweep.ts:27,297`。生产环境里执行器失联不会产生 `orphaned` 候选，桥断也不会把节点挂成 `paused_bridge_missing`；这两段只在 `tests/integration/sweep.spec.ts:304-351` 等用例里被驱动。G3-11 的“桥断挂起、启动未知到点转未知态”中，桥断与执行器失联两条在生产不成立。

字段与幂等单独核过：动作时限只写 `hang_reason/revision/updated_at`，不改 `status`，靠 `hang_reason IS NULL` 与 `activeDecision(action_overrun)` 双重幂等；执行器失联走 `applyTransition`，只改状态、租约与挂起字段，带 CAS 并 `bumpRearm`；inbox 回执超时只写 `status/receipt_json/completed_at/receipt_expired_at`，过期只清 `receipt_json` 并写 `receipt_expired_at`，两者都以 `completed_at`/`receipt_json` 条件收口，复跑不会重复计数。inbox 不是节点状态机，不经迁移表；节点侧的动作时限与执行器失联都应经 `applyTransition`，动作时限这段未走（P2-8）。

### P2

| 编号 | 问题 | 证据 |
|---|---|---|
| P2-1 | G3 门记录仍是预签状态：`candidate_hash` 等四个哈希、`artifact_hash`、`body_hash`、`audit_report_sha256` 全为 0；`audit_round` 仍写 3，`audit_report` 仍指向第 3 轮 fail 报告，但 `conclusion` 写 pass。门检查实跑也拒绝：`G3 record 0000… != computed 4876a98892db4661…`（第 3 轮报告 sha） | `docs/gates/G3.md:64-114`、`:71-74`、`:98`、`:111-113`；`pnpm gate` exit 1 |
| P2-2 | `full-suite.md` 自相矛盾：一处写 838 passed，另一处写 834 passed | `docs/gates/evidence/G3/full-suite.md:5` 与 `:12` |
| P2-3 | G-06 未直接断言 outbox/exitCode 与工具结果重发路径；G-16 的 `skippedIrreversible` 只由 reconcile 摘要字符串断言，未断子 run 行或事件 | `tests/integration/g3-faults.spec.ts:45-73`（G-16 断言在 `:72`） |
| P2-4 | 迁移用例的指纹由测试自己拼 JSON 再比对，`hasRequires` 是布尔而非逐条规则，指纹不能独立证明迁移表未被裁剪 | `tests/integration/migration-cases.spec.ts:36-49` |
| P2-5 | `startup_unknown` 行有 wall deadline 但缺 boot/mono 锚点时立即转 `indeterminate_side_effect`，不再等剩余量；迁移时若仍有在跑的旧行，会被提前判为不确定。代码注释表明这是有意的保守口径，但缺少“旧行迁移时如何补锚点”的说明 | `src/service/sweep.ts:129-142`；`tests/integration/sweep.spec.ts` 对应用例 |
| P2-6 | `confirm-start` 没有 `action_start_source` / `executor.state` 分支，起跑来源与执行器状态不可区分 | `src/service/commands/confirm-start.ts:42-71`；`grep -rn "action_start_source\|executor.state" src/` 无命中 |
| P2-7 | HTTP 决策入口把 actor 固定成 `{kind:'human', id:'service:'+sha256(secret)}`，Agent 无法以 Agent 档提交决策，三档批准人只在库层成立 | `src/service/server.ts:226` |
| P2-8 | 动作时限扫描绕过 `applyTransition`，直接 `UPDATE node_runs SET hang_reason=?, revision=revision+1, updated_at=?`，且不检查 `changes` 就 `appendNodeRunEvent`；与 S3 计划 Task 13 第 3 步“经 applyTransition”不符。当前在同一事务内无并发写者，风险低，但口径不一致 | `src/service/sweep.ts:283-292`；计划 `docs/superpowers/plans/2026-11-12-dsh-orchestra-s3-nodes-state.md:774` |
| P2-9 | `dispatch` 在 `opts.executor` 为空时直接抛 `EVIDENCE_SOURCE_UNAVAILABLE`，control-only 的 wait/subworkflow 也被挡住，纯编排服务无法调度控制节点 | `src/index.ts:184-196` |
| P2-10 | dispatcher 不校验 `node_run.node_type` 与 `control.kind` 是否匹配：任何 `queued` 行都能被 POST 的 control spec 当 wait/subworkflow 调度；真正的 wait 节点若未带 control spec，会落回 `runNode` 执行 | `src/service/dispatcher.ts:124-187`；`src/service/server.ts:247-262` |
| P2-11 | `startSubworkflowNode` 未写 `wait_deadline_at` / `wait_registrations`，父节点等待没有超时，也没有饥饿记录 | `src/service/commands/subworkflow.ts:311-319` |

第 3 轮报告里的两条 P2 本轮判为不成立，不计入：其 P2-4（M-39 的 `from` 含 `dispatched`）——`src/executor/run-node.ts:218-227` 在宿主明确拒绝、尚无副作用时确实从 `dispatched` 落 `blocked_pre`，这是有意的入口；其 P2-5（`from===to` 跳过迁移表）——同状态写只用于挂起/清挂起，不改变状态，迁移表本就没有自环，跳过校验不等于放行非法迁移。其 P2-2（orphaned/indeterminate 报告无负向测试）本轮也不再列：`tests/unit/report-transition.spec.ts:5-8` 已覆盖普通报告不能自报这两个状态。

## 复现命令

在 `D:\aboutAI\dsh-orchestra`、`HEAD=4e431c64ee4f382238901a2a04956ae8a8d70e0d`、工作树干净的条件下执行：

| 命令 | 退出码 | 实测结果 |
|---|---|---|
| `git rev-parse HEAD` | 0 | `4e431c64ee4f382238901a2a04956ae8a8d70e0d` |
| `git status --porcelain=v1` | 0 | 空（审计前后均为空） |
| `pnpm typecheck` | 0 | `tsc --noEmit` 通过 |
| `pnpm test` | 0 | Test Files 61 passed (61)；Tests 838 passed \| 1 skipped (839)；Duration 9.45s（tests 60.41s）；复跑后工作树仍干净 |
| `pnpm build` | 0 | ESM `lib/index.js` 235.96 kB（gzip 57.01 kB）、`lib/index.d.ts` 17.57 kB（gzip 4.30 kB）；CJS `lib/client.js` 0.29 kB（gzip 0.21 kB）；Build complete 930ms |
| `pnpm gate` | 1 | G1 报告 sha 不符（355a1a58… != e3eee746…）；G2 不符（b3861739… != 3e075307…）；G3 记录为 0，计算值 4876a98892db4661…（第 3 轮报告 sha） |

`10fb8fa` 上的首轮实测同样为 typecheck exit 0、test 838 passed/1 skipped、build exit 0，产物大小一致；`4e431c6` 只修了 G2 两份证据字节，复跑后测试不再弄脏工作树。

### 证据哈希核对

按 LF 归一后重算 20 份证据的 sha256；G3-11 与 G3-14 相对第 3 轮报告有更新，其余 18 份一致。完整值：

```
G3-01 599f3b2c6cc5337eb80eede4daada99b8ca619bc3e9fd6b3121347b84d1dfaa8  4605
G3-02 b04ee3222d50e21ebe0eecb27cbab10bee61848e4663565d9cb3c58b8e948d0c  5018
G3-03 121c7dcaa81710614b2c4b649d0e68048498e14975899554efb0703e0c5407c2  2508
G3-04 a4802c43e0076a6132a1527db61d5cf6e77fac3764f392de85a2e5775da437eb  8425
G3-05 561af25c1dccbc69b4cf2bf4b317eff0416a98524a3739387e8642b827e46d39  8616
G3-06 15b643eb77a31fcee39188d3915c3693a5cbc22bb3563bd3d70a5ce00a8c962c  6787
G3-07 440be71a6ddce79e021522271a8edc22df8ccb89b6b8b08fce032740fd08df42  9481
G3-08 11a55979701b59adfa04ea276bbc5c0ff86157a5497f3a87308946b08b94bb78  11280
G3-09 d339babcc2590236c95b07fbb97bd5dd155d60500883a38debac28324a9a6301  6960
G3-10 2157e4b83386f565d8237f0a11a82981e0e5513bd7674a3a6b221319f77e1ae4  37253
G3-11 34b9378bc53cfeb32d07d542de901a95d55aa8957ab5a71d55bb73c456218bd3  18174
G-01  f2626b30f9eb472f1268b71047893be8f1d42a933438e43cd30af35d3318a129  299
G-02  5fedb2e7539b1d410b7ff3c964ea36d77764fd037c4f4e40badbd67b7038b196  330
G-04  a30155a2446531f5c5cd2677946805ca9a78f407cfc4626147f20fcd446eb961  1525
G-06  5dffd8708e431f74743cfbcdabe8d4894e773ecb13e1309f53c7da4a6bd74405  897
G-12  213aeccc768ef3a84106a1a025a27f02aac5f67f950de8bff415ae164e8605c9  813
G-16  b4de438708209be886dee53d2075ddcf7a026d5dfd489abb34741df584fe003a  874
G3-12 5544cff86e0295d5e6dcb363e44173da9060815508e9e3945fa8a1a23d0f26b2  7526
G3-13 7b28fdd9f9cae706cf9761e07e1fcc74922f222a5440dd54d85f43dd9bdf3403  2268
G3-14 c563ef1c2e78ae5ad4af11078d738b2f81e9631aad96397816ee6f698089f63d  1131
```

## 收口意见

本轮不签门。要转 pass，至少需要：

1. 给 wait 事件一个生产入口（HTTP 路由或 dispatcher 消费），把 `wakeOnEvent` 接进去，并让事件先落 inbox 再匹配；
2. 把子 run 终态收口与父取消传播接进生产路径（例如 `closeRun` 钩子或 run 级取消路由），并给父等待补 `wait_deadline_at`/注册；
3. 由生产层向 `sweep` 喂执行器失联与桥断/桥恢复信号，或把该扫描拆成独立可注入入口；
4. 重签 G3 前更新审计报告指向本轮报告并让 `scripts/sign-gate.ts` 重算哈希，修正 `full-suite.md` 的 838/834 矛盾。
