# S2 第二轮独立审计报告：单节点闭环

- 审计对象：`D:\aboutAI\dsh-orchestra`，HEAD `b42a479c17b176fbe170e3e050589159c4d25e74`（含 `ac13080` / `234e934` / `b42a479`），审计期间工作树干净。
- 审计范围：规格 `docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md`、S2 计划 `docs/superpowers/plans/2026-11-12-dsh-orchestra-s2-agent-loop.md`、门记录 `docs/gates/G2.md`、11 份证据、`src/` 与 `tests/` 的 S2 相关实现。
- 审计方法：只读检查 + 独立探针。探针脚本全部放在系统临时目录，不写入仓库；仓库内只写本报告。
- 判定口径：声称验了但实际未验到 = fail；测试通过但性质未覆盖 = fail；门证据与断言口径不符 = fail；只有独立复现才写 pass。

## 一、结论

**G2 不通过。**

门检查本身能通过：`pnpm gate` 与 `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` 都退出 0，四份哈希可重算，正文表交叉校验能发现篡改。但这只证明“门记录自洽”，不证明 S2 行为成立。以下四条是阻断性缺陷：

1. **F-01 未修**：S2 命令与执行器仍没有生产路径。`src/index.ts` 不导出 `runNode`，`src/service/server.ts` 的四条路由只排队命令，不创建 run/node，也不触发执行器。`G2.md:11` 与 `ev-g2-01` 声称的 “createOrchestra → 命令路由 → runNode” 不成立。
2. **I5 可绕过且会卡死**：`applyReport` 直接写 `node_runs.status='blocked_post'`，不经过 `transitionNode` 的 `decision_id` 检查；独立复现得到 `accepted=true`、`decisionEvents=0`。`runNode` 判定失败时抛 `VERDICT_POLICY_UNMET`，节点留在 `verifying`，不写 `verify_human`、不挂裁决卡、`verify_deadline_at=null`，`sweep` 也不扫它。
3. **多工具节点会隐藏失败证据**：`runNode` 每轮覆盖 `evidence`，只保留最后一个工具。独立复现中第一个工具 `exitCode=3`、第二个 `exitCode=0`，最终仍 `done`，证据里只剩第二个工具的 `exitCode=0`。
4. **围栏 + 迟到 `unknown` 会把 sweep 卡死**：`interrupted` 先立围栏，随后 `applyCancel` 的 `cancelResult='unknown'` 把状态改成 `stopping` 但不清围栏；`sweep` 到点执行 `revokeFence` 时 CAS 条件仍要求 `status='timing_out'`，0 行更新抛 `STALE_GENERATION`，整笔 sweep 回滚，节点永久停在 `stopping/armed`。

旧七条的处置：F-02、F-03、F-06、F-07 已修；F-04、F-05 只修了同节点/正常围栏路径；F-01 未修。

11 项必过：6 项行为可过（其中 G2-05、G2-07 的门证据与声明路径不符），4 项 fail，1 项未验证。G2 不能 pass。

## 二、命令实测

| 命令 | 结果 |
| --- | --- |
| `git status --porcelain` | 空（审计开始时） |
| `pnpm check` | 29 spec / 227 用例全绿，exit 0 |
| `pnpm gate` | exit 0；G1 13 项 / 13 证据；`artifact_hash=b490e301078a...` |
| `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` | exit 0；G2 11 项 / 11 证据；`artifact_hash=75c41b95f0a86243aba2f95b75fdc08d531dc500afdc208b5ba3c1daa18dc4ce` |
| `node --no-warnings scripts/fault-inject.ts --case G-03`（写临时目录，非仓库） | 两次运行同为 `599384fd4e30...`，1126 字节，与已提交 G-03 证据一致 |

`pnpm check` 全绿不改变结论。现有测试是实现者自证，且多处测试名与断言路径不一致（见第五节、第八节）。

## 三、旧七条逐条

### F-01 生产路径：未修（致命）

**门声称**：`G2.md:11` 写“单节点走 createOrchestra → 命令路由 → runNode”；`ev-g2-01` 写“runtime 用例走生产装配”。

**实际**：

- `src/index.ts:33-51` 的 `createOrchestra` 建库、迁移、catalog、RuntimeDeps、NodeCommands；`54-77` 的 `serveOrchestra` 还需要调用方注入 `asOfSeq/listTasks/listEvents/appendLedgerEvent`。
- `src/index.ts:79` 只导出 `renewNodeLease`、`sweepNow`、`submitReport`，**不导出 `runNode`**。
- `runNode` 只在 `src/executor/run-node.ts:43` 定义；`rg -n "runNode\(" src tests` 的调用者只有 `tests/runtime.spec.ts:45`。
- `src/service/server.ts:123-157` 只有四条路由：`POST /v1/workflows/load`、`POST /v1/node-runs/lease`、`POST /v1/node-runs/report`、`POST /v1/node-runs/cancel`，全部只是 `queue.run`；没有创建 run/node 的路由，没有 `runNode` 调用，没有 `sweep` 定时器，也没有 `transitionNode` 路由。
- `src/service/workflows.ts:19-30` 的 `load` 只做 `assertDefinitionAllowed` 和内存 Map，不建 run/node。
- `tests/runtime.spec.ts:19-21` 手工 INSERT tasks/runs/node_runs，`45` 直接调 `runNode`；`tests/integration/g2.spec.ts:50-64` 直接调 `applyReport` 三次。两者都没经过 HTTP 命令路由，也没证明 run/node 会被生产路径创建。

**影响**：通过 HTTP 无法把工作流跑到节点执行；G2-01 的生产路径声明是假的。该条足以单独阻断 G2。

**修复**：在 `serveOrchestra` 之外补一个真正的装配入口：load 后创建 run/node，dispatcher 拾取并调用 `runNode`，定时调用 `sweep`；或者把 `runNode` 接入路由/队列并把这条链路写进证据。门证据必须从 HTTP 入口开始，而不是从手工 INSERT 开始。

### F-02 候选范围与 handoff：已修

- `scripts/gate-check.ts:66-70` 的候选范围改用 `git diff --name-only --diff-filter=ACMR base..HEAD`，并排除 `docs/gates`、`docs/audits`、`handoff.md`。
- 实测候选 45 个文件，`HAS_HANDOFF=False`、`HAS_AUDIT=False`、`HAS_GATES=False`，门检查通过。
- 正文表篡改探针：原样 `verifyGateRecord` 返回 `{gate:'G2', artifactHash:'75c41b95...', items:11, evidence:11}`；把 G2-01 改成 G2-99，报“正文必过项第 1 行是 G2-99，artifact 是 G2-01”；把 G2-01 的证据改成 ev-g2-02，报“正文表里 G2-01 的证据与 artifact 不一致：ev-g2-02 != ev-g2-01”。正文表交叉校验有效。
- 残余问题见 N-09：`--diff-filter=ACMR` 不含 `D`，删除文件不进候选哈希；证据从工作树读；`sign-gate.ts` 可重算并重签。

### F-03 注入证据可复现：已修

- `scripts/fault-inject.ts:32-49` 的 `normalizeEvidence` 把临时路径归一为 `<tmp>/orchestra.db`，事件 id 归一为 `evt_1...`；`66-82` 的 `dumpState` 查 `events`、`node_runs`、`node_run_events`、`report_registry`，不再只 dump 前后相同的 events。
- 用 `runCase` + `writeEvidence` 写临时目录，四份 G2 证据各连跑两次，全部字节相同且与已提交文件一致：

| 证据 | 两次哈希 | 与已提交一致 |
| --- | --- | --- |
| G-03 | `599384fd4e30f5c3f7614ce3ae7b36075013d42665b9c382e22c4e2660f8edc0` | 是 |
| G-04 | `5aacb613e3f7f79f354a97f6a1351bba092db56c220d87312c8e3626f045c536` | 是 |
| G-05 | `12d882703d0b82e4d523b1592fe1f0bbd2141acb0b8553258d1d1710754911ec` | 是 |
| G-07 | `72d0d8f51e13dffb96f303588d14d349ee7ebb1671f7a70b7465d9c97886a610` | 是 |

### F-04 重放验链/验队头：部分修

- `src/service/commands/apply-report.ts:113` 校验 `existing.attempt !== params.attempt` → `replay_stale_attempt`；`:116` 校验 `chainBreakOf(readChain(params.nodeRunId))` → `replay_chain_broken`；`:121-127` 查当前 attempt 最小 `report_seq` 的 rejected 行，不是队头 → `replay_not_head`。
- 独立复现：attempt 冲突被拒；篡改 events 首条 payload 被拒为 `replay_chain_broken`；rejected seq1/seq2 重放 seq2 被拒为 `replay_not_head`，两者仍 rejected；重放 seq1 成功，`accepted=true`、`next_status=started`、registry applied、seq2 仍 rejected。
- 但跨节点重放仍可绕过（N-05）：`existing.node_run_id` 没校验，队头查询按 `params.nodeRunId`。因此 F-04 只能算部分修。

### F-05 围栏期间 done 落账：部分修

- `src/service/commands/apply-report.ts:149-152` 在 `fence_state='armed'` 时 `rejectReport('fence_armed')`；`src/service/commands/sweep.ts:20-27` 在宽限到点后 `revokeFence` 并把队头放进 `replay_heads`。
- 独立复现正常路径：dispatched → cancel interrupted → `timing_out`/armed/grace `03:00:30`；围栏内 `applyReport` 返回 `accepted=false, reason='fence_armed'`，registry rejected seq1；`sweep(now=03:00:30)` 返回 `fence_revoked=['nr_f']`、`replay_heads=[rep_f seq1]`，行 `stopping/revoked/rev4`；第二次 sweep 幂等空。
- 但 `cancelResult='unknown'` 会清状态、不清围栏，导致 N-04 死锁。因此 F-05 只能算部分修。

### F-06 桥二次 spill 丢早期事件：已修（单元层）

- `src/service/bridge.ts:180-241` 的 `BridgeEventBuffer` 用 `spillFiles` 命名 `<agentId>-<firstSeq>-<lastSeq>.jsonl`，`takeFrom` 去重并升序，`toolStartAnchor` 逆扫。
- 独立复现：limit=300、highWater=200、agentId=a1、push 1..30，`spillCount=10`，文件名全匹配 `a1-\d+-\d+\.jsonl` 且唯一；`takeFrom(1)` 返回 1..30 升序，`takeFrom(5)` 返回 5..30；30 条中 28 条落盘、2 条在内存；`toolStartAnchor` 返回 seq25 的 `2026-11-13T03:01:25.000Z`。
- 局限：只做了单元级复现，`bridge.ts` 没有接到 `runNode`/服务生产路径；不能据此认定生产中的 spill 行为已覆盖。

### F-07 终态取消改状态：已修（列明行为）

- `src/service/commands/cancel.ts:31` 的 `CANCELABLE` 不含终态；`:36-38` 对终态直接返回 `already_stopped` / `terminal_no_out_edge`，不写库；`:41-43` armed 时返回 `fence_already_armed`；`:103-116` 的 `revokeFence` 需 armed 且宽限到点，CAS 后写 `stopping/revoked`。
- 独立复现：终态 done + interrupted → `already_stopped` / `terminal_no_out_edge`，status 不变、`fence_armed=0`；dispatched 连续两次 interrupted，第二次 `fence_already_armed`，`fence_armed` 仅 1；宽限未到 `revokeFence=false`，到点 `true` 且 `stopping/revoked`。
- 新问题：`queued + interrupted` 抛 `STALE_GENERATION`（CANCELABLE 不含 queued，无兜底）；非法 `cancelResult` 落到 unknown 分支。见 N-08。

## 四、11 项必过逐项

| 项 | 门声明 | 独立复现 | 判定 |
| --- | --- | --- | --- |
| G2-01 | 生产路径 queued→done、终态证据 | 生产路径不存在；runtime 测试手工 INSERT 后直调 `runNode` | **fail** |
| G2-02 | 同一个 report_id 重复上报只落一次 | 首次 accepted、重复 accepted=false；`report_applied=1`；但 `report_replayed` 每次重发都追加 | **pass（核心）**，见 N-06 |
| G2-03 | 租约过期后的迟到上报被拒 | 过期后 `applyReport` 返回 `LEASE_EXPIRED`，节点仍 dispatched，registry 无记录 | **pass** |
| G2-04 | 取消后不产生新 attempt | 终态取消 attempt 不变；但全仓没有创建新 attempt 的代码路径，断言恒真 | **fail（空验）** |
| G2-05 | 终态必带证据 | 从 verifying 报 done 且 `evidence=[]` → `evidence_missing`；门证据用 dispatched→done，先得到 `illegal_transition`，没走到证据门 | **pass（行为）/ 门证据不成立** |
| G2-06 | 无裸 blocked，卡住必须挂裁决卡 | `applyReport` 可直接写 `blocked_post`，`decisionEvents=0`；`transitionNode` 只查 `decisionId` 非空字符串，不查卡是否存在 | **fail** |
| G2-07 | S2 加载 parallel 被拒 | `catalog.load` 对 parallel 抛 `FORBIDDEN`；HTTP 路由已接 `catalog.load`，但门证据仍是直接调 `assertDefinitionAllowed` | **pass（catalog）/ HTTP 证据未独立跑** |
| G-03 | 同一个 report_id 两次只落一次 | 两次运行字节一致；registry applied 一次，事件 `report_applied=1` | **pass** |
| G-04 | 租约到期后原执行器迟到上报被拒 | `LEASE_EXPIRED`，节点不被改写，registry 无记录 | **pass** |
| G-05 | 工具执行中取消只立一次围栏 | 重复 interrupted 只立 1 次围栏；但没有工具执行，门证据也只 cancel 一次 | **未验证（部分）** |
| G-07 | 墙钟跳变不误判截止 | clock 组件对 drift/backward/reboot 都返回 `uncertain`；但节点 deadline 列全 null，sweep 不扫 deadline | **fail（只测组件）** |

统计：pass 6（其中 G2-05、G2-07 带证据瑕疵）、fail 4、未验证 1。G2 要求 11 项全过，因此不能 pass。

## 五、I1–I5

| 不变量 | 判定 | 依据 |
| --- | --- | --- |
| I1 终态无出边 | **pass** | 终态 cancel 直接返回不写库；`applyReport` 的 `canTransition` 无终态出边；CAS 不会把终态改回去 |
| I2 账本只追加 | **pass** | `events`/`node_run_events` 只有 append；重复上报仍追加 `report_replayed`；没有 update/delete 账本路径 |
| I3 CAS 失败可回滚 | **pass** | `runCas` 失败抛 `STALE_GENERATION`，事务回滚；探针中 sweep 失败后行未被部分改写 |
| I4 终态有对应证据 | **fail** | 多工具节点只留最后一个工具的 evidence；第一个工具 `exitCode=3` 被隐藏，最终仍 done |
| I5 卡住必须挂裁决卡 | **fail** | `applyReport` 绕过 `decision_id` 写 `blocked_post`；`runNode` 判定失败留在 verifying，无 `verify_human`、无裁决卡、无 deadline |

I1–I3 是真实的，但不能抵消 I4/I5 的阻断。

## 六、新发现缺陷

### N-01 致命：applyReport 绕过 I5，裸写 blocked_post

**复现**：

1. 节点 `started`，先 `applyReport(started)` 成功。
2. 再 `applyReport({status:'blocked_post', expectedStatus:'started', evidence:[强证据], policy:{passConditions:[]}})`。
3. 结果 `accepted=true`、`next_status='blocked_post'`、节点 `blocked_post`、registry applied、`report_applied` 一条；`decisionEvents=0`。

**根因**：`src/service/commands/apply-report.ts:180-185` 直接 `runCas UPDATE node_runs SET status=...`，没有经过 `src/service/state-machine.ts:32-34` 的 `decision_id` 检查。`state-machine.ts:41/43` 又允许 `started/verifying → blocked_post`。

**影响**：任何能提交 report 的调用方都能把节点卡住而不挂裁决卡，直接违反 I5，也让 G2-06 的“无裸 blocked”失效。

**修复**：`applyReport` 遇到 `blocked_post` 必须走 `transitionNode` 的同一检查；在 S2 没有 decision 表的前提下，不允许 `applyReport` 直接写 `blocked_post`，应改为 `verify_human` + 裁决卡/外部 decision 句柄；没有句柄就拒绝。

### N-02 致命：runNode 判定失败后永久 verifying

**复现**：单工具 `exitCode=3`，`runNode` 抛 `VERDICT_POLICY_UNMET`；节点 `verifying`、`verify_deadline_at=null`、`lease_expires_at=03:10`；`sweep(now=04:00)` 返回空；节点仍 `verifying`，无 `verify_human`/decision 事件。

**根因**：`src/executor/run-node.ts:110-117` 在 `submitReport` 不 accepted 时只抛错，不迁 `blocked_post`、不发 `verify_human`、不挂 `decision_id`、不释放租约；`src/service/commands/sweep.ts` 只扫租约和围栏，不扫 `verifying` 超时。

**影响**：判定失败不是“卡住可裁决”，而是“无人知道的卡死”；违反计划 `docs/superpowers/plans/2026-11-12-dsh-orchestra-s2-agent-loop.md:38` 的“证据不足转 verify_human 落 blocked_post + verify_human 事件”，也违反 I5。

**修复**：在 `runNode` 的 `!accepted` 分支设置 `verify_deadline_at`、追加 `verify_human`、挂 decision 句柄并迁 `blocked_post`；`sweep` 增加 verifying 超时扫描；无法挂卡就保持可重试并明确报 `DECISION_REQUIRED`。

### N-03 致命：多工具节点只保留最后一个工具的 evidence

**复现**：节点配两个工具，第一个 `exitCode=3`，第二个 `exitCode=0`；`runNode` 返回 `final_status='done'`、节点 `done`，证据只有第二个工具的 `exitCode=0`；事件为 `lease_acquired/status_changed×2/report_applied`。

**根因**：`src/executor/run-node.ts:73-87` 每个工具执行后覆盖 `evidence`，`:86` 只保留最后一次；判定只针对最后一份 evidence。

**影响**：失败动作被隐藏，终态证据不可信，I4 失效；这类节点会被记成成功。

**修复**：按工具/attempt 累积 evidence（每个工具一条，含 exitCode、命令哈希、输出摘要）；判定必须看全部工具；任一工具失败则不得 done，转 verify_human/blocked_post。

### N-04 致命：围栏 + 迟到 unknown 导致 sweep 永久失败

**复现**：

1. dispatched 节点 `cancel(interrupted)` → `timing_out`、fence armed、grace `03:00:30`。
2. 再 `cancel(cancelResult='unknown')` → status `stopping`，fence 仍 armed。
3. `sweep(now=03:00:30)` 执行 `revokeFence`，CAS `WHERE status='timing_out'` 0 行，`runCas` 抛 `STALE_GENERATION details={what:'revokeFence',changes:0}`；整笔 sweep 回滚，行仍 `stopping/armed`。

**根因**：`src/service/commands/cancel.ts:58-68/82-89` 改 status 为 `stopping` 时不清 fence；`src/service/commands/sweep.ts:20-27` 把 `revokeFence` 和租约扫描放在同一事务，单行失败整批回滚；`cancel.ts:108-113` 的 CAS 又要求 `status='timing_out'`。

**影响**：一个迟到的 unknown 取消就能让 sweep 永久抛错，其他节点的围栏也撤不掉，账本无法收口。

**修复**：状态离开 `timing_out` 时同步清 fence，或让 `revokeFence` 只按 `fence_state='armed'` + `fence_deadline` CAS，不再要求 status；sweep 改为逐行事务/收集错误，单行失败不拖垮整批。

### N-05 重大：跨节点 report_id 重放

**复现**：

1. A、B 两个节点都 `dispatched`。
2. 报告 X 在 A 以 `expectedStatus='queued'` 被拒（registry X 属 `nrun_a`，seq1 rejected）。
3. 报告 Y 在 B 同样被拒（seq1 rejected）。
4. 再把 X 以 `node_run_id=B`、`expectedStatus='dispatched'`、`generation=1`、强证据重放 → `accepted=true`、B `started`；registry X 仍 `{report_id:X,node_run_id:'nrun_a',attempt:1,report_seq:1,state:'applied'}`，B 的事件追加 `report_replayed/report_applied`，B 自己的队头 Y 仍 rejected。

**根因**：`src/service/commands/apply-report.ts:89` 只按 `report_id` 查 existing；`:113-128` 的 attempt/chain/head 校验都按 `params.nodeRunId`，不校验 `existing.node_run_id`；`:140` 只校验 `report.node_run_id === params.nodeRunId`，没校验 registry 的 node_run_id。

**影响**：一个节点的报告可以改写另一个节点的状态，破坏节点隔离和队头语义；配合可预测的 report_id 可跨节点伪造进度。

**修复**：`existing && existing.node_run_id !== params.nodeRunId` 直接拒绝（如 `replay_wrong_node`）；队头查询与链校验都用 `existing.node_run_id` 或先确认一致；registry 主键/唯一约束补 `node_run_id` 维度。

### N-06 重大：重复 replayed 事件无上限

**复现**：同一已 applied 报告重发 5 次，每次 `accepted=false, reason='already_replayed'`；`node_run_events` 中 `report_applied=1`、`report_replayed=5`。

**根因**：`src/service/commands/apply-report.ts:94-110` 对 applied/replayed 的重复请求都 append `report_replayed`，没有去重或上限。

**影响**：账本可被无限放大，审计和重放成本无界；I2 的“只追加”被满足，但“只落一次”的语义没有覆盖事件层。

**修复**：对同一 `report_id + reason` 只追加第一条 `report_replayed`，或增加每报告事件上限；把重复计数放到 projection/指标，不写账本。

### N-07 重大：report.attempt 被忽略

**复现**：`report.attempt=999`、`params.attempt=1`、节点 attempt=1 → `accepted=true`，registry attempt=1。

**根因**：`src/service/commands/apply-report.ts:137-142` 只校验 `report.report_id` 和 `report.node_run_id`；`:190-191` 的 INSERT 用 `params.attempt`，不用 `report.attempt`。

**影响**：报告信封里的 attempt 与实际落账 attempt 可以不一致，跨 attempt 重放/伪造更难发现。

**修复**：`report.attempt === params.attempt` 必须成立，否则拒绝；registry/INSERT 统一使用 `report.attempt`。

### N-08 重大：queued 取消抛错；非法 cancelResult 被当 unknown

**复现**：

- `queued + cancel(interrupted)` → 抛 `STALE_GENERATION details={what:'cancel-interrupted',changes:0}`；`CANCELABLE` 不含 queued，也没有兜底分支。
- `cancelResult='garbage'` → `cancel.ts` 只 if 三个合法值，其余落入 unknown 分支 → status `stopping`；`server.ts:41-47` 的 `requireFields` 只查字段存在，不校验枚举。

**根因**：`src/service/commands/cancel.ts:31` 的 `CANCELABLE` 缺少 `queued`；`:82-89` 的 else 把非法值当 unknown；`src/service/server.ts:41-47` 不做枚举校验。

**影响**：queued 节点无法正常取消；非法输入被静默接受，状态机进入非预期路径。

**修复**：`CANCELABLE` 明确包含 `queued` 或对 queued 返回明确的不可取消错误；在 HTTP 边界校验 `cancelResult ∈ {interrupted,not_interruptible,unknown,already_stopped,...}`，非法值 400。

### N-09 重大：门候选范围忽略删除，证据/签名可被重做

- `scripts/gate-check.ts:66-70` 用 `--diff-filter=ACMR`，**不含 D**；删除文件不进 `candidate_hash`/`change_scope_hash`。
- `checkCandidate` 用 `git show HEAD:<path>` 算候选，不检查工作树是否脏；`checkEvidence` 从工作树读证据；`sign-gate.ts` 可重算并重签；`verifyGateRecord` 不校验 exceptions/approver/rollback，`checkBodyTable` 不比对第 2 列内容。
- 影响：删掉实现/测试文件、改工作树证据、重签 artifact 都能让门继续通过；门的“通过”不等于冻结的候选被验证。
- 修复：diff 加 `D`；证据从 `HEAD` 读；门检查要求干净树；`sign-gate` 只在人工确认后运行；校验 exceptions/approver/rollback 与正文第 2 列。

### N-10 重大：门证据与断言路径不符

- `G2.md:11` 与 `ev-g2-01`：声称生产路径，实际手工 INSERT + 直调 `runNode`（见 F-01）。
- `ev-g2-05`：声称 dispatched→done 因无证据被拒，实际先被 `canTransition` 拒成 `illegal_transition`，没走到证据门。
- `ev-g2-06`：只证明直接 `transitionNode` 需要 decisionId，不证明 `applyReport` 不能裸写 blocked_post。
- `ev-g2-07`：声称 HTTP 加载回 403，测试直接调 `assertDefinitionAllowed`。
- `G-05`：只 cancel 一次，没有工具执行；`G-07`：只测 clock_drift，节点 deadline 全 null。
- 影响：11 项里多项“证据”只证明了相邻行为，不能支撑门声明。
- 修复：每条证据从真实入口重写；G2-05 用 verifying 报 done；G2-06 用 `applyReport` 尝试 blocked_post；G2-07 起 HTTP 服务跑 load；G-05 驱动工具执行中取消；G-07 设置节点 deadline 后跳时钟。

### N-11 重大：G2 例外表与规格/计划不一致

- `docs/gates/G2.md:76-79` 例外表只有 `LEASE_EXPIRED(409)`、`DECISION_REQUIRED(422)`，漏 `BRIDGE_ACK_LAG(409)`。
- `DECISION_REQUIRED` 在规格 17.1 与 S2 计划中都没有定义；计划 `:136-138` 的 `PROPOSED_ERROR_CODES` 只有 `LEASE_EXPIRED:409`、`BRIDGE_ACK_LAG:409`。门把 `DECISION_REQUIRED` 当“S2 提案码”没有依据。
- 计划 `:38` 明确 S2 没有 decision 表，证据不足转 `verify_human` 落 `blocked_post` + `verify_human` 事件；代码没有这条路径（N-02）。
- 影响：门记录自造错误码，规格一致性不可核。
- 修复：要么在规格/计划补 `DECISION_REQUIRED` 与裁决卡语义，要么从 G2 删除；补 `BRIDGE_ACK_LAG` 到例外表；按计划 `:38` 实现 verify_human。

## 七、规格一致性

1. **四条路由没有规格/计划依据**。在规格与 S2 计划中执行 `rg -n '/v1/|node-runs|workflows/load'` 无输出；`§6.1` 定义的是 `workflow.create/open_draft/update/publish`，`§4.2` 定义的是 `applyReport` 函数签名，都没有定义 `/v1/workflows/load` 或 `/v1/node-runs/lease|report|cancel` 的 HTTP 路径、请求字段和错误码。实现可以自成一体，但门不能声称它“符合规格”。
2. **`DECISION_REQUIRED` 无规格/计划依据**。规格 17.1 和计划 `:136-138` 只有 `LEASE_EXPIRED`、`BRIDGE_ACK_LAG`；G2 例外表却把它列为 S2 提案码，且不在计划错误码表里。
3. **计划 `:38` 的 verify_human 未实现**。计划要求“证据不足转 verify_human 落 blocked_post + verify_human 事件”；`runNode` 判定失败留在 `verifying`，不写 `verify_human`，不挂 decision。
4. **`report.attempt` 与规格信封不一致**。规格 `§4.2` 的 report 含 attempt；代码只用 `params.attempt`，忽略 `report.attempt`（N-07）。
5. **`applyReport` 的 policy 参数**。规格把 policy 归 service 加载；代码 `applyReport` 仍接受 policy 参数。生产 `submitReport` 走 runtime，但模块导出的 `applyReport` 保留了弱策略入口；这是内部 API 偏差，风险低于 N-01，但应在 S3 前收口。

## 八、门记录自身有效性

**有效的部分**：

- `pnpm gate` / `gate-check G2` 退出 0；11 项/11 证据；四份哈希可从候选、证据、原像块重算。
- `G2.md` 正文表与 artifact 的 id 顺序、result、evidence 能交叉校验；篡改 G2-01 的 id 或 evidence 都会报错。
- G-03/04/05/07 四份注入证据各跑两次字节一致，且与已提交文件一致；F-03 的“不可复现”已修。

**无效的部分**：

- 门记录 `G2.md:11` 的生产路径声明不实（F-01）。
- 例外表漏 `BRIDGE_ACK_LAG`，多出无依据的 `DECISION_REQUIRED`（N-11）。
- 证据 ev-g2-05/06/07 的断言路径与门声明不符（N-10）。
- 候选范围忽略删除、证据从工作树读、签名可重做、正文第 2 列与 exceptions 不校验（N-09）。
- 因此门检查通过只说明“文档自洽”，不能说明 G2 行为成立。**G2 不能 pass。**

## 九、修复优先级

**P0（阻断 G2）**：

1. F-01 生产装配：load 建 run/node，dispatcher 调 `runNode`，定时 `sweep`，从 HTTP 入口写 E2E 证据。
2. I5：`applyReport` 不得裸写 `blocked_post`；判定失败写 `verify_human` + 裁决卡；`sweep` 扫 verifying 超时。
3. 多工具 evidence 累积；任一工具失败不得 done。
4. `cancelResult='unknown'` 清 fence 或让 `revokeFence` 不依赖 `timing_out`；sweep 逐行事务。

**P1（重大）**：

5. 跨节点重放校验 `existing.node_run_id`；队头按 registry 节点查。
6. `report.attempt` 与 `params.attempt` 必须一致。
7. queued 取消与非法 `cancelResult` 的边界处理。
8. 门候选含删除、证据从 HEAD 读、干净树检查、exceptions/approver/rollback 校验。

**P2（记录/一致性）**：

9. 重复 `report_replayed` 去重或限额。
10. G2 例外表补 `BRIDGE_ACK_LAG`；`DECISION_REQUIRED` 要么补规格，要么删除。
11. 重写 ev-g2-01/05/06/07 与 G-05/07 的证据路径。

## 十、复现输出摘要

- 跨节点重放：`accepted=true`、B `started`、registry X `node_run_id='nrun_a'`、B 的 `report_replayed/report_applied` 已追加。
- I5 绕过：`accepted=true`、`next_status='blocked_post'`、`decisionEvents=0`。
- 重复 replayed：5 次重发后 `report_applied=1`、`report_replayed=5`。
- 多工具证据：`final_status='done'`、evidence 只有第二个 `exitCode=0`。
- 判定失败卡死：`VERDICT_POLICY_UNMET`、节点 `verifying`、`verify_deadline_at=null`、`sweep(04:00)` 空。
- 围栏死锁：`STALE_GENERATION`、`{what:'revokeFence',changes:0}`、行 `stopping/armed`。
- 终态取消：`already_stopped/terminal_no_out_edge`、status 不变、`fence_armed=0`。
- queued 取消：`STALE_GENERATION`、`{what:'cancel-interrupted',changes:0}`。
- report.attempt：`report.attempt=999`、`params.attempt=1` → `accepted=true`、registry attempt=1。

## 十一、审计边界

- 本报告只写 `docs/audits/S2-independent-audit-round2.md`；未改 src/tests/gates/docs 其他文件，未 commit/push。
- 探针脚本在系统临时目录，未入库；报告中的输出是审计时实际运行结果。
- 未独立跑 HTTP 403（G2-07）、未驱动真实工具执行（G-05）；这两项在表中标为“未验证/证据未独立跑”，没有写成 pass。
- `pnpm check` 的 227 个用例是实现者测试，只作参考；不作为本轮结论的依据。
