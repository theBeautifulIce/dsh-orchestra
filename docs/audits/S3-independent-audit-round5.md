# S3 独立审计报告（第 5 轮）

## 结论

**pass**。G3 的 20 项必过项全部通过，`failed_items = []`；P0 = 0，P1 = 0，P2 = 13 项（10 项上轮遗留、3 项本轮新增；上轮 P2-2 已修，不计）。判定只依据候选 `0dbb950` 的代码与本次实跑；`docs/gates/G3.md` 门记录正文、历史审计结论均不作通过依据。

上一轮失败的 G3-07、G3-08、G3-11 三项，本轮都在生产路径上闭合：wait 事件有 HTTP 路由并经 `src/index.ts` 装配；子 run 终态由 2 秒维护扫描推进父节点，run 级取消有生产路由并向子 run 传播；sweep 的 `bridgeMissing/bridgeRestored/executorLost` 由 `bridge_stream_cursors` 账本派生。逐条核对见下文。

## 候选与工作树

- 候选：`0dbb95024ce2df4476e0cb230209b4cb6497e5f2`（`fix(service): wire wait events, run cancellation and bridge loss signals`）。
- 门记录声明的范围：`c296d72..HEAD`。
- 工作树：审计开始与全部跑测后 `git status --porcelain` 均为空；探针与日志只写在 `tmp/audit-s3r5/`（`.gitignore:8` 覆盖 `tmp/`），交付前删除。
- 候选改动 14 文件 +742/−9，核心为 `src/index.ts`、`src/service/{server,schemas,sweep}.ts`、`src/service/commands/runtime.ts`、三份测试与 V4 审计/证据文件。

## 方法

1. 候选固定后实跑 `pnpm typecheck`、`pnpm test`、`pnpm build`、`scripts/check-evidence-repro.ts`、`scripts/gate-check.ts`，并逐条重跑 G3 点名的 `scripts/fault-inject.ts` 用例。
2. 三项上轮 P1 逐段追「HTTP 路由 → `src/index.ts` 装配 → service 命令 → 事务/迁移/事件」；不以新增测试或文档当作修复证据，测试只用来确认边界。
3. 逐项判定必过项；P2 单列并标出上轮状态。
4. 历史审计行只在「有轮次列、轮次严格早于本轮」时豁免；本轮不引用其结论。

## 上轮三项 P1 复核

### G3-07 wait 生产入口：闭合

- 路由：`src/service/server.ts:358-369` 的 `POST /v1/wait/events`，`parseBody(waitEventSchema)` 后 `queue.run(() => deps.commands!.wakeOnEvent({runId,eventType,payload,idempotencyKey,now}))`；认证在前置的 `src/service/server.ts:184`。
- 装配：`src/index.ts:187-193` 用 `inTx(db, tx => wakeOnEvent(tx, opts.secret, {...}))` 接入 `orchestra.commands`。
- 语义：`src/service/commands/wait.ts:97-118` 先 `recordWaitEvent` 写 `wait_event_inbox`（同 `idempotency_key` `ON CONFLICT DO NOTHING`），`:279-288` 再回扫 `scanRun`；`enterWaiting`（`:195-276`）注册后立即从 `from_seq` 回扫，唤醒走 `waiting→dispatched` 并清租约、executor 与 `wait_deadline_at`（`:135-150`）。
- 实跑：`tests/contract/routes.spec.ts:345-368` 走真实 HTTP，断言 `woken=1`、节点 `dispatched`、`wait_deadline_at=null`；`tests/integration/wait.spec.ts` 8 tests passed。

### G3-08 子流程收口与 run 级取消：闭合

- 子 run 终态推进父节点：`src/service/sweep.ts:328-341` 查询 `runs JOIN node_runs`（父节点 `waiting`、子 run 终态集合 `done/failed/timeout/abandoned_unverified/failed_with_unverified/orphaned/superseded/cancelled`），逐条调用 `finishSubworkflowChild`；生产节拍在 `src/index.ts:295-302`，`setInterval(2000)` 调 `sweepNow(orchestra.runtime, now)`，失败只记日志。
- 收口语义：`src/service/commands/subworkflow.ts:337-375`，非终态抛 `RESOLUTION_NOT_AVAILABLE`，父节点已 `dispatched` 幂等返回，`waiting→dispatched` 并写 `subworkflow.finished`。
- run 级取消：`src/service/server.ts:370-381` 的 `POST /v1/runs/cancel`（`cancelRunSchema`），`src/index.ts:194-201` 装配 `propagateRunCancellation`；`src/service/commands/subworkflow.ts:396-447` 写 `runs.cancel_requested_at/cancel_result`，对子 run 的可取消节点调 `applyCancel`，`irreversible` 跳过并记 `skippedIrreversible`。
- 实跑：`tests/integration/sweep.spec.ts:364-366` 断言 `subworkflow_finished` 含 `nr_sw` 且 `subworkflow.finished` 事件一条；`tests/contract/routes.spec.ts:370-391` 断言 `cancelledRuns` 含 `r_child`、`cancelledNodes` 含 `nrun_child`、子 run `cancel_result=interrupted`。G-16 注入实跑同样得到 `cancelledRuns=["r2"]`、`cancelledNodes=["nr_g16a"]`、`skippedIrreversible=["nr_g16b"]`。

### G3-11 桥断/恢复/失联信号：闭合

- 派生：`src/service/commands/runtime.ts:63-109`，`BRIDGE_SILENCE_MS = 10 * 60_000`；`missing` 取 `node_runs JOIN bridge_stream_cursors`（attempt 相等、`MAX(c.updated_at) < cutoff`）、`restored` 取 `paused_bridge_missing` 且游标恢复、`lost` 取 `dispatched/started` 且无游标行；`sweepNow` 在同一 `withTx` 取信号后传入 `sweep`。
- 生产信号源：`src/executor/bridge-ledger.ts:126-130` 在 ingest 时 `INSERT bridge_stream_cursors ... ON CONFLICT DO UPDATE ... updated_at=excluded.updated_at`，`:65-68` 更新 `last_handled_seq/updated_at`；`BridgeLedger` 由 `src/executor/agent-lifecycle.ts:64` 构造，`src/executor/run-node.ts:264` 在生产桥执行路径建立 `AgentLifecycle`。
- 落状态：`src/service/sweep.ts:172-200` 挂起 `paused_bridge_missing`（`resume_state` 记原状态、写 `recovery.bridge_missing`）；`:202-257` 按 `resume_state` 恢复，`startup_unknown/verifying` 按剩余量重挂窗口；`:298-326` 失联置 `orphaned`（`EXECUTOR_BOUND` 限定，`:426-434`）。
- 实跑：`tests/integration/runtime.spec.ts:572-607` 走 `sweepNow`：静默游标 → `paused_bridge_missing`；游标推进 → `bridge_restored`；无游标在跑节点 → `executor_orphaned` 且 `orphaned`。`sweep.spec.ts` 19 tests passed。

## 逐项检查

| 编号 | 结果 | 代码锚点 | 本轮实跑证据 |
| --- | --- | --- | --- |
| G3-01 | pass | `src/core/state-machine.ts:139` 起 59 条 `TRANSITIONS` + 2 条 `CREATION_RULES` + 1 条 `HANG_GUARD`；`tests/integration/migration-cases.spec.ts:26-34` 断言 62 个 id 全覆盖 | migration-cases 65 passed |
| G3-02 | pass | `src/service/commands/nodes.ts:80` `applyTransition`，CAS 条件含 `revision`/`attempt`（`:127-133`） | node-runs 6 passed |
| G3-03 | pass | `src/core/clock.ts` 单调锚点 + `deadlineFromAnchors`；sweep 统一用 `clock.decide` | half-state 5 passed |
| G3-04 | pass | `src/service/commands/decisions.ts` 收口返回 `blockedNode`，`src/index.ts` 同事务 `resumeFromBlockedPre`；`nodes.ts:304-383` 校验租约、绑定、内容哈希 | approval 7 passed |
| G3-05 | pass | policy 九算子与 branch 路由，未命中落 `blocked_post` 并留凭据 | policy-branch 18 passed |
| G3-06 | pass | `src/service/commands/parallel.ts` all/any/quorum 与不可逆子节点闸 | parallel 6 passed |
| G3-07 | pass | `server.ts:358-369`、`index.ts:187-193`、`wait.ts:97-118/195-288` | wait 8 passed；`routes.spec.ts:345-368` |
| G3-08 | pass | `sweep.ts:328-341`、`subworkflow.ts:337-375/396-447`、`server.ts:370-381`、`index.ts:194-201/295-302` | subworkflow 12 passed；sweep 19 passed；`routes.spec.ts:370-391` |
| G3-09 | pass | `src/service/commands/compensation.ts` 按 `compensation_id` 幂等，失败落 `failed_with_unverified` | compensation 9 passed |
| G3-10 | pass | `src/service/commands/apply-report.ts` uphold 两条出口、`STALE_HANG` 兜底 | apply-report 61 passed |
| G3-11 | pass | `runtime.ts:63-109`、`sweep.ts:172-326`、`bridge-ledger.ts:65-68/126-130` | runtime.spec 走 `sweepNow`；sweep 19 passed |
| G-01 | pass | `scripts/fault-inject.ts` `caseG01` | exit 0；重生成与 HEAD `G1/G-01.md` 字节相等 |
| G-02 | pass | `scripts/fault-inject.ts` `caseG02` | exit 0；与 HEAD `G1/G-02.md` 字节相等 |
| G-04 | pass | `scripts/fault-inject.ts` `caseG04` | exit 0；与 HEAD `G2/G-04.md` 字节相等（1525 字节） |
| G-06 | pass | `caseG06`：同 `callId` 二次 `collect` 只重发已存结果 | exit 0；对账 `宿主实际执行次数=1；两次回传 exitCode=0/0；outbox=completed`；`tool_started`/`tool_finished` 各 1 |
| G-12 | pass | `caseG12`：同 revision 双击只赢一笔 | exit 0；第二笔拒码 `DECISION_REVISION_CONFLICT`；决策行 `revision=2`、`approved` |
| G-16 | pass | `caseG16`：父取消向子 run 传播、跳过不可逆 | exit 0；`cancelledRuns=["r2"]`、`cancelledNodes=["nr_g16a"]`、`skippedIrreversible=["nr_g16b"]`，子 run `interrupted` |
| G3-12 | pass | `src/service/commands/start-run.ts` 固定版本/档位/`operation_id` 幂等 | start-run 10 passed |
| G3-13 | pass | `src/service/decision/approver.ts:36-54`：human 档、agent 档 `orchestra.audit`、自证据拒绝 | approver 5 passed |
| G3-14 | pass | 全量质量门 | typecheck exit 0；61 files / 843 passed | 1 skipped；build exit 0 |

## P0 / P1

**P0 = 0，P1 = 0。** 本轮没有发现「必过项在生产路径不成立」或「跨模块致命缺陷」。三项上轮 P1 的核对口径与实测结果：

| 编号 | 检查点 | 命令 | 期望 | 实际 |
| --- | --- | --- | --- | --- |
| 上轮 P1-1 | wait 从外部触发 | `pnpm vitest run tests/contract/routes.spec.ts -t "等待事件走生产路由"` | 200，`woken=1`，节点 `dispatched` | 1 passed / 24 skipped，断言全过 |
| 上轮 P1-2 | 子 run 终态推进父节点 | `pnpm vitest run tests/integration/sweep.spec.ts` | `subworkflow_finished` 含父节点，事件一条 | 19 passed，断言全过 |
| 上轮 P1-2 | run 级取消传播 | `pnpm vitest run tests/contract/routes.spec.ts -t "运行级取消走生产路由"` | 子 run `cancel_result=interrupted`，子节点进 `cancelledNodes` | 1 passed / 24 skipped，断言全过 |
| 上轮 P1-3 | 桥信号来自生产账本 | `pnpm vitest run tests/integration/runtime.spec.ts` | 静默→`paused_bridge_missing`；恢复→`bridge_restored`；无游标→`orphaned` | 25 passed（含三例） |
| 上轮 P1-3 | 信号真有生产写入者 | `grep bridge_stream_cursors` + 读 `bridge-ledger.ts` | ingest 时写游标、`updated_at` 随事件推进 | 一致（`bridge-ledger.ts:126-130`） |

## P2

上轮 11 条：10 条仍在，`P2-2` 已修；本轮新增 3 条。

| 编号 | 状态 | 内容与位置 |
| --- | --- | --- |
| P2-1 | 仍在 | G3 门记录仍是预签：四个哈希、`artifact_hash`、`body_hash`、`audit_report_sha256` 全 0，`audit_round=3`，`audit_report` 指向 round3（`docs/gates/G3.md:66-114`、`:111-113`、`:155-156`）。`node --no-warnings scripts/gate-check.ts` exit 1：G3 记录 `0000…` != 计算 `4876a98892db4661…`；G1/G2 亦因审计报告 sha 与记录不一致而 exit 1（属门签写状态，不计为代码缺陷） |
| P2-2 | 已修 | `docs/gates/evidence/G3/full-suite.md:5` 与 `:12` 均为 61 files、843 passed | 1 skipped，与实跑一致 |
| P2-3 | 部分仍在 | G-06 的 outbox/`exitCode` 仍以 reconcile 摘要字符串断言；G-16 的 `skippedIrreversible` 也只断字符串（`tests/integration/g3-faults.spec.ts:10`、`:45-49`、`:72`），未断行级字段 |
| P2-4 | 仍在 | 迁移表指纹由测试自己 `JSON.stringify` 生成，`hasRequires` 退化为布尔，建行规则与挂起闸不入指纹（`tests/integration/migration-cases.spec.ts:36-49`）；裁剪 `requires` 实现不会改变指纹 |
| P2-5 | 仍在 | `startup_unknown` 有墙钟 deadline 但缺 boot/mono 锚点时立即转 `indeterminate_side_effect`；注释声明这是保守口径，但缺旧行迁移补锚点说明（`src/service/sweep.ts:127-169`） |
| P2-6 | 仍在 | `confirm-start` 无 `action_start_source`/`executor.state`，起跑来源与执行器状态不可区分（`src/service/commands/confirm-start.ts:22-73`；`grep -rn "action_start_source\|executor.state" src/` 无命中） |
| P2-7 | 仍在 | HTTP 决策入口 actor 由共享 secret 派生（`src/service/server.ts:131-141` 返回 `service:<sha8>`），却以 `{kind:'human'}` 记账（`:234`）；持 secret 的进程可走 human 档，三档批准人只在库层成立 |
| P2-8 | 仍在 | 动作时限直接 `UPDATE node_runs SET hang_reason=?, revision=revision+1`，未走 `applyTransition`，且不检查 `changes` 就追加事件（`src/service/sweep.ts:287-293`）；有 `status/revision/revision+1` CAS 条件，当前同事务内风险低 |
| P2-9 | 仍在 | `dispatch` 在 `!opts.executor` 时抛 `EVIDENCE_SOURCE_UNAVAILABLE`，control-only 的 wait/subworkflow 一并被挡（`src/index.ts:202-205`） |
| P2-10 | 仍在 | dispatcher 不校验 `node_runs.node_type` 与 `control.kind`：查询只取 `node_run_id,node_id,seq,attempt`，再仅凭请求里的 `spec.control` 走控制节点（`src/service/dispatcher.ts:57-59`、`:82-84`） |
| P2-11 | 仍在 | `startSubworkflowNode` 只写 `wait_started_at` 并清租约，不写 `wait_deadline_at`/`wait_registrations`，父等待没有超时与饥饿记录（`src/service/commands/subworkflow.ts:311-319`） |
| P2-12 | 新增 | `propagateRunCancellation` 只取消子 run 的节点，目标 run 自身节点不动；全仓只有它写 `runs.cancel_requested_at`（`subworkflow.ts:406`、`:415`），没有任何读它把 run 落 `cancelled` 的路径。对无子 run 的运行，`POST /v1/runs/cancel` 除写列外无效果（`src/service/commands/subworkflow.ts:405-445`） |
| P2-13 | 新增 | `lost` 只看 `started_at` 与有无游标，不看 `lease_expires_at`/心跳；`missing` 把 `waiting/verifying/stopping` 也按静默十分钟计（`src/service/commands/runtime.ts:76-95`）。默认动作时限 120s（`src/executor/run-node.ts:46`）时难触发，配置放大后，健康但长时间无桥事件的长跑节点可能被置 `orphaned`/`paused_bridge_missing`（终态需人工）。 |
| P2-14 | 新增 | G3 三份注入证据是叙述性摘要而非生成器字节产物：`check-evidence-repro.ts` 只覆盖 G1/G2 共 25 份；`fault-inject` 把 G-06/G-12/G-16 写到 `out/G1/`，字节 3139/1269/2687 与 `docs/gates/evidence/G3/{G-06,G-12,G-16}.md` 的 652/634/689 不等，复现指向 vitest。行为已由本轮实跑复核，证据本身不可字节复现 |

## 复现命令与实测

在 `D:\aboutAI\dsh-orchestra`、HEAD `0dbb950`、工作树干净下执行：

- `git rev-parse HEAD` → `0dbb95024ce2df4476e0cb230209b4cb6497e5f2`。
- `pnpm typecheck` → exit 0（`tsc --noEmit`）。
- `pnpm test` → exit 0：Test Files 61 passed (61)；Tests 843 passed | 1 skipped (844)；Duration 15.36s。
- `pnpm build` → exit 0：ESM `lib/index.js` 245.34 kB（gzip 59.26 kB）、`lib/index.d.ts` 18.04 kB（gzip 4.39 kB）；CJS `lib/client.js` 0.29 kB。
- `node --no-warnings scripts/check-evidence-repro.ts` → exit 0：25 份证据重跑两遍与 HEAD 字节一致。
- `node --no-warnings scripts/gate-check.ts` → exit 1（见 P2-1；G1/G2/G3 审计报告 sha 均未收口）。
- `node --experimental-strip-types --no-warnings scripts/fault-inject.ts --case <G-01|G-02|G-04|G-06|G-12|G-16> --out tmp/audit-s3r5/g3ev` → 6 例均 exit 0；G-01/G-02 与 HEAD `G1/*`、G-04 与 HEAD `G2/G-04.md` 字节相等；其余对账见逐项表。
- `pnpm vitest run tests/contract/routes.spec.ts -t "等待事件走生产路由"` / `-t "运行级取消走生产路由"` → 各 1 passed | 24 skipped。
- `pnpm vitest run <14 份证据测试文件>` → 14 files passed，241 tests passed（migration-cases 65、node-runs 6、half-state 5、approval 7、policy-branch 18、parallel 6、wait 8、subworkflow 12、compensation 9、apply-report 61、sweep 19、start-run 10、approver 5、g3-faults 10）。
- `pnpm vitest run tests/integration/runtime.spec.ts` → 25 passed（含桥断/恢复/失联三例）。
- 收尾 `git status --porcelain` → 空。

## 失败项与裁决

- `failed_items`: `[]`
- `P0`: `[]`；`P1`: `[]`
- `verdict`: **pass**

收口建议：下一轮清理 P2-1 的门签与 P2-3/P2-4/P2-14 的证据强度；P2-12 的 run 级取消语义、P2-13 的桥静默判据适合在 S3 收尾前补一条行为用例再定口径。本轮未签门、未改代码、未提交。
