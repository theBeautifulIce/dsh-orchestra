# G3 第三次独立审计报告（第 2 轮 P0/P1 复核）

- 门：G3
- 候选提交：68fa92bf9bd6257eedfba6494b654b7de08639e7
- 审计对象：候选 68fa92b；HEAD eb19872（仅证据提交）；工作树另含未提交的 G1/G2/G3 轮次提升
- 审计时间：2026-11-14
- 审计方式：只读；唯一写入本报告；未签门、未 commit、未改源码

## 一、命令与退出码

| 命令 | 次数 | 实测结果 | 说明 |
| --- | --- | --- | --- |
| `pnpm typecheck` | 2 | 两次 exit 0 | `tsc --noEmit` 全过 |
| `pnpm test` | 1 | exit 1；60 files，2 failed \| 829 passed \| 1 skipped（832），16.28s | 两条失败均在 `tests/gate/gate-check.spec.ts`；原因是工作树 `docs/gates/G1.md` 已改成 `audit_round: 51` 并指向不存在的 `docs/audits/S1-independent-audit-round51.md`。候选 68fa92b 的 G1 指向 `round50`，该文件在 HEAD 中存在；按 `scripts/gate-check.ts:2512-2516` 的检查顺序，候选树不会命中这两条失败 |
| `pnpm build` | 2 | 第一次 exit 1；第二次 exit 0 | 第一次 `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR ... 拒绝访问 (os error 5)`；pnpm 重装依赖后成功。产物 ESM `lib/index.js` 201.79 kB / gzip 49.07 kB，`lib/index.d.ts` 16.23 kB，CJS client 0.29 kB |
| `pnpm gate` | 2 | 两次 exit 1 | `工作树有未提交改动，门记录不能对着脏树签：M docs/gates/G1.md`；G3 内容检查未执行，属签前预期失败 |

环境：node v26.13.1，pnpm 12.3.4，HEAD `eb19872e4fe1e9267b906fa35c897b9b24b395e0`。

## 二、结论

**fail**。第 2 轮三项 P0 均已修复并有可执行证据；第 2 轮 P1 中，M-16、requires 运行期校验/M-29、cancel 走 applyTransition、startup 锚点、桥回剩余量、decision 后 run 收口、confirm-start 动作时限、wait 超时扫描均已闭合。仍未闭合的是三处：

1. `G3-04` 的审批往返只到命令层，`resolveDecision` 不恢复 `blocked_pre/blocked_post` 节点，`resumeFromBlockedPre` 在 `src/` 内没有调用者；HTTP 审批后节点仍停在 `blocked_pre`。
2. `G3-07/08/09` 的 wait/subworkflow/compensation 命令在 `src/` 内没有生产调用者，`dispatcher` 只对 `queued` 节点调用 `runNode`，`server` 也没有对应路由；子流程等待未落 `wait_deadline_at`、未建 wait 注册。门第 15 行的“service 命令与 sweep 调度承载”声明在运行期不成立。
3. `G3-11` 只实现了链断、wait 超时、租约、桥、verify、startup_unknown 六类扫描；S3 计划 Task 13 要求的 executor lost、action deadline、receipt expiry 扫描不在 `src/service/sweep.ts`，门文本把 G3-11 收窄成三条行为，覆盖不到自身 S3 验收。

20 项必过中 15 项通过、5 项失败。G3 产物的候选/变更范围/证据索引/不变量/审计报告哈希仍为全 0，正文却已写“pass/批准人”，属预签态缺陷，按 P2 记录，不据此判 P0/P1。

## 三、20 项逐项结论

| 必过项 | 结论 | 依据 |
| --- | --- | --- |
| G3-01 M-01..M-62 迁移 | pass | `tests/integration/migration-cases.spec.ts` 全过；59 条规则 / 123 个 from / 72 个 to / 10 条 requires |
| G3-02 CAS 与迟到 attempt | pass | `tests/integration/node-runs.spec.ts`；`applyTransition` 的 CAS 条件含 `attempt/revision/action_generation/rearm_generation` |
| G3-03 半状态时钟与桥断冻结 | pass | `tests/integration/half-state.spec.ts`；`src/core/clock.ts:73-80` 三锚点缺一即 null |
| G3-04 blocked_pre 审批往返 | **fail** | `approval.spec.ts` 只手工串联 `resolveDecision` + `resumeFromBlockedPre`；生产入口没有这条链 |
| G3-05 policy 九操作/分支 | pass | `tests/integration/policy-branch.spec.ts` |
| G3-06 parallel all/any/quorum | pass | `tests/integration/parallel.spec.ts`；不可逆子节点闸在 |
| G3-07 wait inbox-first/match | **fail** | `wait.spec.ts` 只测命令；`enterWaiting` 无生产调用者，无 HTTP 路由 |
| G3-08 subworkflow pin/depth/cycle/cancel | **fail** | `subworkflow.spec.ts` 只测命令；`startSubworkflowNode` 未落 `wait_deadline_at`/注册，无生产调用者 |
| G3-09 compensation 幂等/失败收口 | **fail** | `compensation.spec.ts` 只测命令；`startCompensation` 无生产调用者 |
| G3-10 report conflict/uphold | pass | `apply-report.spec.ts`；M-59 只允许 `done/failed` |
| G3-11 恢复扫描可重入 | **fail** | `sweep.spec.ts` 只覆盖链、wait、租约、桥、verify、startup；缺 executor lost/action/receipt |
| G-01 提交后被杀 | pass | `docs/gates/evidence/G1/G-01.md` + 对应集成用例 |
| G-02 提交后未送达重放 | pass | `docs/gates/evidence/G1/G-02.md` + 重放用例 |
| G-04 租约过期迟到报告拒绝 | pass | `docs/gates/evidence/G2/G-04.md` + 用例 |
| G-06 工具结果丢失同 callId 重发 | pass | `g3-faults.spec.ts:45-52` 结构化断言一次 `tool_started`/一次 `tool_finished`、`status=completed`；outbox/exitCode 仅摘要，列 P2 |
| G-12 同 revision 双击只赢一笔 | pass | `g3-faults.spec.ts:54-60` 断言一行 resolved/revision=2、仅一条 `decision.resolved` |
| G-16 父取消传播/跳过不可逆 | pass | `g3-faults.spec.ts:62-73` 断言 a→timing_out、b 保持 started；子 run r2 行未结构化断言，列 P2 |
| G3-12 start-run pin/autonomy/operation_id | pass | `tests/integration/start-run.spec.ts` |
| G3-13 批准人三层 | pass | `tests/integration/approver.spec.ts`；`src/service/decision/approver.ts:36-54` |
| G3-14 全量测试与构建 | pass（候选树） | 构建 exit 0、产物数字与 `full-suite.md` 一致；typecheck exit 0。当前工作树 `pnpm test` 的 2 条失败由未提交 G1 round51 引起，候选 68fa92b 的 G1 指向已存在的 round50 |

## 四、20 份证据重算

`docs/gates/G3.md:117-140` 的 20 条 `sha256` 全部是 64 个 0。下表按 LF 归一重算（只读）。重算值均与文件真实内容一致，但与门记录无法比对，因为门记录未签。

| 必过项 | 证据文件 | 门记录 | 重算 sha256（LF 归一） |
| --- | --- | --- | --- |
| G3-01 | `tests/integration/migration-cases.spec.ts` | 0 | `599f3b2c6cc5337eb80eede4daada99b8ca619bc3e9fd6b3121347b84d1dfaa8` |
| G3-02 | `tests/integration/node-runs.spec.ts` | 0 | `b04ee3222d50e21ebe0eecb27cbab10bee61848e4663565d9cb3c58b8e948d0c` |
| G3-03 | `tests/integration/half-state.spec.ts` | 0 | `121c7dcaa81710614b2c4b649d0e68048498e14975899554efb0703e0c5407c2` |
| G3-04 | `tests/integration/approval.spec.ts` | 0 | `a4802c43e0076a6132a1527db61d5cf6e77fac3764f392de85a2e5775da437eb` |
| G3-05 | `tests/integration/policy-branch.spec.ts` | 0 | `561af25c1dccbc69b4cf2bf4b317eff0416a98524a3739387e8642b827e46d39` |
| G3-06 | `tests/integration/parallel.spec.ts` | 0 | `15b643eb77a31fcee39188d3915c3693a5cbc22bb3563bd3d70a5ce00a8c962c` |
| G3-07 | `tests/integration/wait.spec.ts` | 0 | `440be71a6ddce79e021522271a8edc22df8ccb89b6b8b08fce032740fd08df42` |
| G3-08 | `tests/integration/subworkflow.spec.ts` | 0 | `11a55979701b59adfa04ea276bbc5c0ff86157a5497f3a87308946b08b94bb78` |
| G3-09 | `tests/integration/compensation.spec.ts` | 0 | `d339babcc2590236c95b07fbb97bd5dd155d60500883a38debac28324a9a6301` |
| G3-10 | `tests/integration/apply-report.spec.ts` | 0 | `2157e4b83386f565d8237f0a11a82981e0e5513bd7674a3a6b221319f77e1ae4` |
| G3-11 | `tests/integration/sweep.spec.ts` | 0 | `4453498cb52e18a8d3dc459c8a2cb5e66da5bb102bc438ea4c3569cef12f6fe5` |
| G-01 | `docs/gates/evidence/G1/G-01.md` | 0 | `f2626b30f9eb472f1268b71047893be8f1d42a933438e43cd30af35d3318a129` |
| G-02 | `docs/gates/evidence/G1/G-02.md` | 0 | `5fedb2e7539b1d410b7ff3c964ea36d77764fd037c4f4e40badbd67b7038b196` |
| G-04 | `docs/gates/evidence/G2/G-04.md` | 0 | `a30155a2446531f5c5cd2677946805ca9a78f407cfc4626147f20fcd446eb961` |
| G-06 | `docs/gates/evidence/G3/G-06.md` | 0 | `5dffd8708e431f74743cfbcdabe8d4894e773ecb13e1309f53c7da4a6bd74405` |
| G-12 | `docs/gates/evidence/G3/G-12.md` | 0 | `213aeccc768ef3a84106a1a025a27f02aac5f67f950de8bff415ae164e8605c9` |
| G-16 | `docs/gates/evidence/G3/G-16.md` | 0 | `b4de438708209be886dee53d2075ddcf7a026d5dfd489abb34741df584fe003a` |
| G3-12 | `tests/integration/start-run.spec.ts` | 0 | `5544cff86e0295d5e6dcb363e44173da9060815508e9e3945fa8a1a23d0f26b2` |
| G3-13 | `tests/integration/approver.spec.ts` | 0 | `7b28fdd9f9cae706cf9761e07e1fcc74922f222a5440dd54d85f43dd9bdf3403` |
| G3-14 | `docs/gates/evidence/G3/full-suite.md` | 0 | `0816cecfa9be772c6114f261cc28a21a3df4fefddc4ac3969863a0a293b8cec9` |

判定：20/20 文件存在且可重算；20/20 门记录为 0，不能视为已签证据。列 P2-1。

## 五、G3 门自锚复核

| 字段 | G3.md 值 | 复核 | 判定 |
| --- | --- | --- | --- |
| `previous_artifact_hash` | `c5b4564a40669b44179dd10e01059f6ec92b5816cf2cf15e86046055501f4d5a` | 等于 `docs/gates/G2.md:532` 的 `artifact_hash` | 一致 |
| `candidate_hash` | 64 个 0 | 候选 68fa92b 存在 | 预签，未重算 |
| `change_scope_hash` | 64 个 0 | 候选 diff c296d72..68fa92b | 预签，未重算 |
| `evidence_index_hash` | 64 个 0 | 20 条证据索引 | 预签，未重算 |
| `invariants_hash` | 64 个 0 | 正文 I1..I8 | 预签，未重算 |
| `audit_report` | `docs/audits/S3-independent-audit-round3.md` | 本报告落盘后存在 | 签前存在 |
| `audit_report_sha256` | 64 个 0 | 本报告 | 预签，未重算 |
| `artifact_hash` | 0 | — | 预签 |
| `body_hash` | 0 | — | 预签 |
| 正文结论 | pass；批准人 human:啸春；批准时间 2026-11-14T12:00:00.000Z | 与全 0 产物同时存在；无“待签”标记 | 预签态，P2-1 |

`pnpm gate` 因工作树脏停在第 0 步，以上零值没有被内容检查拦截；签前必须由 `sign-gate.ts` 重算。审计只指出“当前产物不能自证”，不把预签态升级为 P0/P1。

## 六、第 2 轮 P0 复核

### P0-1 批准人不可伪造：已修复

- HTTP 入口 `src/service/server.ts:113-122` 从 `x-orchestra-actor` 以外的认证材料派生 `actor = service:<sha256(secret).slice(0,8)>`；`:216` 固定传 `{ kind: 'human', id: actor }`，`body.actor` 不进入 `resolveDecision`。
- `tests/contract/auth.spec.ts:104-111` 覆盖“请求体 actor 不生效”。
- `src/service/commands/decisions.ts:157-160` 无 actor 直接 `FORBIDDEN`；`:189-198` 每次收口追加 `decision.resolved`；`:200` closing 决议同事务 `closeRun`。
- `tests/integration/g3-faults.spec.ts:54-60` 断言仅一条 `decision.resolved`。

结论：P0-1 关闭。遗留的 HTTP actor kind 固定为 human 另列 P2-9，不影响本项。

### P0-2 closeRun 不得把 stop_evidence 当已核实副作用：已修复

`src/service/commands/run-close.ts:46-55`：

```ts
const unverified = node.side_effect_policy !== 'pure' && node.side_effect_verified_none !== 1
```

优先级 `failed > orphaned > hasUnverified → succeeded_with_unverified > succeeded`，不再有 `stop_evidence` 捷径。`tests/integration/run-close.spec.ts:45-48` 覆盖 `done + irreversible + verified_none=0 + stop_evidence` → `succeeded_with_unverified`。

结论：P0-2 关闭。

### P0-3 普通报告不得自报 orphaned/indeterminate：已修复

- `src/core/state-machine.ts:239-245` 的 `canReportTransition` 拒绝目标 `orphaned`、`indeterminate_side_effect`、`abandoned_unverified`、`failed_with_unverified`、`superseded`，且只允许 `requires === undefined` 的规则。
- `src/service/commands/apply-report.ts:423` 在进入 done/failed/timeout 分支前调用该检查。
- `uphold_report` 走 M-59，仅 `done/failed`。

结论：P0-3 关闭。没有找到针对 orphaned/indeterminate 的反例测试，列 P2-2。

## 七、第 2 轮 P1 复核

### P1-1 G3-04：审批往返没有生产接线（未修复）

- `src/service/commands/decisions.ts:144-201` 的 `resolveDecision` 只更新 decision 行、追加事件、必要时 `closeRun`，不恢复节点。
- `src/service/commands/nodes.ts:304-379` 的 `resumeFromBlockedPre` 逻辑完整：检查 `blocked_pre`、租约为空、decision 绑定、过期、内容哈希、resolved reason，approved→queued、rejected→failed，且走 `applyTransition`。
- 但全 `src/` 没有调用者；`tests/integration/approval.spec.ts:79,104,125,143,161,166` 是测试手工串联。
- HTTP 只有 `/v1/decisions/resolve`（`src/service/server.ts:209-222`），它只调 `resolveDecision`。审批后节点停在 `blocked_pre`，没有后续驱动。

对应第 2 轮 P1-10，未修复。G3-04 判 fail。

### P1-2 G3-07/08/09：命令层实现完整，生产入口缺失（未修复）

- `src/service/commands/wait.ts:195 enterWaiting`、`src/service/commands/subworkflow.ts:290 startSubworkflowNode`、`:337 finishSubworkflowChild`、`:396 propagateRunCancellation`、`src/service/commands/compensation.ts:70 startCompensation` 在 `src/` 内均无调用者；调用只出现在测试与 `scripts/fault-inject.ts:528`。
- `src/service/dispatcher.ts:46,88` 只选 `status='queued'` 的节点并统一 `runNode`，没有 `node_type` 分支；`src/service/server.ts` 没有 wait/subworkflow/compensation/run-cancel 路由。
- `src/service/commands/subworkflow.ts:311-319` 的 `startSubworkflowNode` 只写 `wait_started_at`、清租约/执行器，没有 `wait_deadline_at`，也没有插入 wait 注册行；`sweepWaitTimeouts` 无法给子流程等待计时。
- 门第 15 行把边界写成“run-node 只执行单节点，wait/子流程/补偿由 service 命令与 sweep 调度承载”。用例与门声明在“只到命令层”这一点上一致，但生产没有 service 调度入口，sweep 也不调用这些命令；声明把“未接线”转成了“非缺口”，与 S3 “跑真实的多节点流程”的验收不一致。

对应第 2 轮 P1-7，未修复。G3-07/08/09 判 fail。

### P1-3 G3-11：恢复扫描面不足（部分修复）

`src/service/sweep.ts:60-258` 现有：链断检查、`sweepWaitTimeouts`（line 68）、租约过期、围栏撤销/重放、verify 超时/不确定、`startup_unknown` 到期、桥断暂停/桥回恢复。

`docs/superpowers/plans/2026-11-12-dsh-orchestra-s3-nodes-state.md:774` 的 Task 13 还要求：executor lost、action deadline、receipt expiry。`src/service/sweep.ts` 中这三类扫描均不存在（grep 无对应状态迁移）。门把 G3-11 收窄成“断链跳过、桥断挂起、启动未知到点转未知态”，所以门文本自身能过，但覆盖不到 S3 计划。

对应第 2 轮 P1-6 的剩余部分（wait 超时已补），未完全修复。G3-11 判 fail。

### 第 2 轮其余 P1 的关闭情况

| 第 2 轮项 | 复核 |
| --- | --- |
| P1-1 M-16 多出 verifying→timeout | 已修：`src/core/state-machine.ts:154` 只允许 `verifying → done/failed` |
| P1-2 requires 未运行期校验、M-29 死规则 | 已修：`src/service/commands/nodes.ts:94-111` 对候选规则逐条要求 context 满足 `requires`；M-29 要求 `cancelResult==='already_stopped'` |
| P1-3 cancel 裸 UPDATE 绕过 applyTransition | 已修：`src/service/commands/cancel.ts:84-113,115-157,180-214` 均走 `applyTransition`；仅围栏已 armed 的 CAS 在状态不变时保留裸更新并返回 `fence_pending` |
| P1-4 startup_unknown 缺锚点回退墙钟 | 已修：`src/service/sweep.ts` 与 `confirm-start.ts` 均用 `deadlineFromSample`/`deadlineFromRow`；缺锚点不再猜墙钟。无锚点旧行直接转未知态另列 P2-7 |
| P1-5 桥回 remaining=null 当 0、非 null 也 bumpRearm | 已修：`src/service/sweep.ts:212-234` 用 `verify_remaining_ns ?? 120_000`，且设计稿 `docs/orchestra-design-draft.md:144,146` 要求每次 remaining 重挂都 Gr+1，原审计“非 null 不 bump”的判断有误，本次撤回 |
| P1-6 sweep 缺 action/executor/receipt、wait 超时不扫 | 部分修：wait 超时已扫（line 68）；action/executor/receipt 仍缺，见 P1-3 |
| P1-8 confirm-start 无动作时限 | 部分修：`src/service/commands/confirm-start.ts:42-71` 已落 `action_deadline_ms` 与时钟锚点；`action_start_source`/`executor.state` 分支仍缺，列 P2-8 |
| P1-9 decision 后 run 不收口 | 已修：`src/service/commands/decisions.ts:200` |
| P1-11 G3 门不可验证/报告不存在 | 预签态：报告由本次落盘；哈希仍全 0，列 P2-1 |
| P1-12 迁移测试自指指纹 | 部分修：`tests/integration/migration-cases.spec.ts:36-48` 仍是 TRANSITIONS 自身 JSON，且只记 `hasRequires` 布尔；行为反例从 line 66 起，缓解后列 P2-6 |

## 八、G3-07/08/09 边界与故障证据

### 8.1 边界声明与用例

- 门第 15 行：run-node 只执行单节点；wait/子流程/补偿由 service 命令与 sweep 调度；G3-07/08/09 用例按这个边界写。
- 用例：`wait.spec.ts`、`subworkflow.spec.ts`、`compensation.spec.ts` 均直接调用命令函数，没有经过 dispatcher、server 或 sweep。
- 生产：dispatcher 无 node_type 分支；server 无对应路由；sweep 只扫 wait 超时，不启动子流程、不跑补偿。
- 结论：门与用例的“命令层”边界一致，但与生产可运行不一致；这正是 P1-2。

### 8.2 G-06

- `G-06.md` 表：collect 前 dispatched/无 outbox 行/tool_started 0；第一次后 dispatched/completed/1；第二次后 dispatched/completed 同 result_json/1。
- `g3-faults.spec.ts:45-52` 结构化断言：before 不含 `call_g06`；after 恰好一条 `tool_started`、一条 `tool_finished`、`status=completed`、含 `call_g06`。
- `outbox=completed`、`exitCode=0/0` 只来自 `reconcile` 摘要字符串（该行另含 `宿主实际执行次数=1`），没有直接查 `bridge_tool_outbox` 或退出码字段。核心“只执行一次”成立，表的两列未被结构化锁住，列 P2-3。

### 8.3 G-12

- `G-12.md` 表：open 后 pending/revision=1；第一次 approve 后 resolved/revision=2/closed_reason=approved；第二次同 revision 行不前进、仍一条 resolved。
- `g3-faults.spec.ts:54-60` 断言：before 无 `dec_g12`；after 仅一条 `decision.resolved`；行 `{status:'resolved', revision:2, closed_reason:'approved'}`；第二次返回 `DECISION_REVISION_CONFLICT`。
- 表与断言一致；“opened 1 条”未被单独计数，属轻微，不列项。

### 8.4 G-16

- `G-16.md` 表：传播前 a/b 都 started、子 run r2 running；传播后 a timing_out/cancel_result=interrupted，b 保持 started 进 skippedIrreversible，r2 cancel_result=interrupted 待不可逆节点收口。
- `g3-faults.spec.ts:62-73` 断言：before 两节点 started；afterA `{status:'timing_out', cancel_result:'interrupted'}`；afterB `status='started'`；reconcile 含 `skippedIrreversible`。
- 子 run r2 的 `cancel_result=interrupted` 与 `"cancelledNodes"` 只来自摘要字符串，未查 `runs` 行，列 P2-3。

### 8.5 full-suite

- `full-suite.md`：typecheck 0；60 files，831 passed | 1 skipped；build ESM 201.79 kB/gzip 49.07/d.ts 16.23。
- 实测：typecheck 0；build 数字一致；test 829 passed | 2 failed | 1 skipped。差的 2 条是工作树 G1 round51 的环境性失败，候选树 G1 round50 存在，按 `gate-check.ts` 顺序不会触发。G3-14 按候选树判 pass，但报告保留实测 exit 1。

## 九、P0 / P1 / P2

### P0（0）

无。第 2 轮 P0-1/2/3 均已关闭。

### P1（3）

| 编号 | 结论 | 影响必过项 |
| --- | --- | --- |
| P1-1 | 审批收口不恢复 blocked_pre/blocked_post，`resumeFromBlockedPre` 无生产调用者 | G3-04 |
| P1-2 | wait/subworkflow/compensation 命令无生产入口；子流程等待无 deadline/注册 | G3-07、G3-08、G3-09 |
| P1-3 | sweep 缺 executor lost/action deadline/receipt expiry 扫描 | G3-11 |

### P2（9）

| 编号 | 说明 |
| --- | --- |
| P2-1 | G3 产物预签：候选/变更范围/证据索引/不变量/审计报告 sha256、artifact_hash、body_hash 全 0，正文却已写 pass/批准人；20 条证据 sha 也全 0 |
| P2-2 | P0-3 只有代码检查，没有 orphaned/indeterminate 报告的反例测试 |
| P2-3 | G-06 的 outbox/exitCode、G-16 的子 run r2 cancel_result 只由 reconcile 摘要字符串承载，未结构化查表 |
| P2-4 | M-39 的 `from` 含 `dispatched`（`src/core/state-machine.ts:177`），设计稿 `docs/orchestra-design-draft.md:369` 与 `enterBlockedPre` 只允许 queued/leased |
| P2-5 | `applyTransition` 对 `from===to` 跳过 transition 表校验（`src/service/commands/nodes.ts:85-86`） |
| P2-6 | 迁移指纹由 TRANSITIONS 自身生成，且只记 `hasRequires` 布尔，不锁 requires 表达式（`migration-cases.spec.ts:36-48`） |
| P2-7 | `startup_unknown` 有 `deadline_at` 但缺 boot/mono 锚点的旧行，未比较 deadline 就直接转 `indeterminate_side_effect`（`src/service/sweep.ts:120-136`）；`sweep.spec.ts:274-288` 把这固化为预期 |
| P2-8 | confirm-start 已落动作时限，但未写 `action_start_source`，也没有 `executor.state` 分支 |
| P2-9 | HTTP decision 路由把 actor kind 固定为 human（`src/service/server.ts:216`），agent 批准层只能走内部命令 |

## 十、裁决

<!-- audit-verdict:begin -->
```json
{"schema":"audit-verdict/1","gate":"G3","audit_round":3,"candidate_commit":"68fa92bf9bd6257eedfba6494b654b7de08639e7","conclusion":"fail","p0":0,"p1":3,"p2":9,"must_pass_total":20,"must_pass_passed":15,"must_pass_ids":["G3-01","G3-02","G3-03","G3-04","G3-05","G3-06","G3-07","G3-08","G3-09","G3-10","G3-11","G-01","G-02","G-04","G-06","G-12","G-16","G3-12","G3-13","G3-14"],"failed_items":["G3-04","G3-07","G3-08","G3-09","G3-11"],"notes":"P0-1/2/3 已修；G3-04 审批恢复未接线、G3-07/08/09 命令无生产入口、G3-11 缺 executor/action/receipt 扫描，判 fail。20 项过 15。G3 产物仍全 0 哈希且正文已写 pass，属预签态 P2。pnpm typecheck 两跑 0；build 第二次 0；test 60 files 2 failed/829 passed/1 skipped（失败由工作树 G1 round51 指向缺失报告引起，候选 68fa92b G1 指向存在的 round50）；gate 两跑均因脏树 exit 1。"}
```
<!-- audit-verdict:end -->
