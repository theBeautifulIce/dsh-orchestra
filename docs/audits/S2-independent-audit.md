# S2 独立审计报告：单节点闭环

- 审计对象：`D:\aboutAI\dsh-orchestra`，HEAD `225a4f9`，工作树审计结束时干净
- 审计范围：规格 v1.3、S2 计划 14 个 Task、指定源码/测试/脚本、G1/G2 门记录与 G2 证据
- 审计方式：四条必做命令实跑；12 个仓库外对抗探测（`output/audit-probe.ts`、`output/probe-extra.ts`）；门哈希复算（`output/candidate-check.ts`）；逐 Task 对照
- 判定口径：声称验了但实际未验到 = fail；测试通过但性质未覆盖 = fail；门记录证据与断言口径不符 = fail

## 结论

**G2 建议不通过。**

一句话理由：当前 HEAD 连门检查自身都过不了（G1/G2 的 `candidate_hash` 均失效），11 项必过里至少 5 项声称的性质没有被真正验证，另有多条会破坏账本/围栏/终态不变量的实现缺陷（断链非队头重放被接受、围栏期间 `done` 仍可落账、二次 spill 丢事件、终态被取消改回 `timing_out`）。

## 命令实测

| 命令 | exit code | 关键输出 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `$ tsc --noEmit`，无报错 |
| `pnpm test` | 1 | `Test Files 1 failed \| 26 passed (27)`；`Tests 1 failed \| 210 passed (211)`；失败 `tests/gate-check.spec.ts:30`：`Error: candidate_hash 与候选文件不符：87d4af93d0a247dc… != a38eceda43c978dd…`（`scripts/gate-check.ts:124`） |
| `node scripts/gate-check.ts docs/gates/G2.md` | 1 | `门检查失败：candidate_hash 与候选文件不符：e2f62087c2f933ea… != a002e3cd4ca3af29…` |
| `node scripts/gate-check.ts docs/gates/G1.md` | 1 | `门检查失败：candidate_hash 与候选文件不符：87d4af93d0a247dc… != a38eceda43c978dd…` |

补充实测：`pnpm tsx --version` → exit 1，`Command "tsx" not found`。计划 Task 14 写明的 `pnpm tsx scripts/fault-inject.ts` / `pnpm tsx scripts/gate-check.ts` 验收命令本身跑不起来；用 Node 26 直接跑 `node scripts/fault-inject.ts` 可以。

候选哈希复算（`output/candidate-check.ts`）：

- G2 记录 `candidate=e2f62087…f49592`、`scope=19552f4b…a27ba`。HEAD~1（38 文件）两者都 `match=true`；HEAD（39 文件）`candidate=a002e3cd…07ba0`、`scope=21c02ccc…b37f`，均为 false。多出的文件是 `handoff.md`。
- G1 记录 `candidate=87d4af93…b2ad5b`、`scope=c8260083…4ad38`。HEAD~1（74 文件）都 `match=true`；HEAD（74 文件）`candidate=a38eceda…fe60a`，`scope` 仍 match，但 `handoff.md` 内容变了。
- 根因：门签名提交 `d844a0e` 之后，`225a4f9` 又改了 `handoff.md`；`gate-check.ts:65-69` 的候选范围只排除 `docs/gates`、`docs/audits`，`handoff.md` 属于候选，四个哈希中的 `candidate_hash` 随之失效。G1/G2 同时变红。

## 11 项必过逐条判定

| 项 id | 声称验的性质 | 实际验到的 | 判定 | 依据 |
| --- | --- | --- | --- | --- |
| G2-01 | 单节点从 queued 到终态走通一条路径 | 只在 SQLite 里直接调 `acquireLease` + 三次 `applyReport`，把状态从 dispatched 推到 started/verifying/done；没有 executor、没有桥、没有 `runTool`、没有 agent 会话 | **fail** | `tests/integration/g2.spec.ts:49-64`；`src/index.ts:1-2` 只有两行导出；`src/service/server.ts:66-101` 只有 S1 四条路由 |
| G2-02 | 同一 report 重复上报只落一次 | 同一 `report_id` 连报两次，第二次 `accepted=false/replayed`，`report_applied` 只有 1 条 | **pass** | `g2.spec.ts:66-76`；P2 复测 `report_applied=1` |
| G2-03 | 租约过期后的迟到上报被拒 | 抛出 `LEASE_EXPIRED`，节点仍 `dispatched`；测试未断言 registry/事件回滚，P4 单独确认事务回滚 | **pass（附条件）** | `g2.spec.ts:78-91`；P4；`lease.ts:110-119` |
| G2-04 | 取消后不产生新 attempt | 断言 `attempt` 仍为 1、没有 `attempt>1` 的行；但全仓没有任何创建新 attempt 的代码路径，这个断言恒真 | **fail** | `g2.spec.ts:93-103`；`grep` 未发现插入新 `node_runs` attempt 的生产代码 |
| G2-05 | 终态必带证据 | 测试从 `dispatched` 直接报 `status=done` 且无证据，实际被 `illegal_transition` 挡下，根本没有走到证据评估 | **fail** | `g2.spec.ts:105-115`；P11a 输出 `reason=illegal_transition`；P11b 从 `verifying` 报 done 才得到 `evidence_missing` |
| G2-06 | 没有裸 `blocked` | 空库里数 `status='blocked'` 为 0，并检查所有 `nrun_%` 行状态在枚举内；没有任何会写 `blocked` 的路径，属于空验 | **fail** | `g2.spec.ts:117-123` |
| G2-07 | S2 加载含 `parallel` 的定义时被拒 | 直接调用 `assertDefinitionAllowed`，传入最小对象，得到 `FORBIDDEN`；没有经过真实的 workflow 加载入口 | **存疑** | `g2.spec.ts:125-131`；`workflow-def.ts:26-54` 是函数级校验 |
| G-03 | G-03 重复上报只落一次 | 测试性质同 G2-02；证据文件“注入前/恢复后”两段完全相同，只有一条 `task.created`，看不出注入发生过 | **fail（证据口径不符）** | `g2.spec.ts:133-141`；`docs/gates/evidence/G2/G-03.md:7-15`；`fault-inject.ts:296-317` |
| G-04 | G-04 租约到期后迟到上报被拒 | 测试性质同 G2-03；证据两段相同，只有 seed 事件 | **fail（证据口径不符）** | `g2.spec.ts:143-156`；`G-04.md:7-15`；`fault-inject.ts:319-341` |
| G-05 | G-05 工具执行中取消只立一次围栏 | 没有工具执行，节点停在 `dispatched`；只调了一次 `applyCancel`；P12 用第二次取消（新 revision）得到 `fence_armed=2`，该性质实际不成立 | **fail** | `g2.spec.ts:158-168`；P12；`G-05.md:7-15`；`fault-inject.ts:343-359` |
| G-07 | G-07 墙钟跳十分钟不误判截止 | 只调 `MonotonicClock.sample/decide`，断言 `uncertain/clock_drift`；没有设置节点 deadline，也没有验证“截止误判”；证据里节点行 `deadline_boot_id/deadline_monotonic_ns` 均为 null | **fail** | `g2.spec.ts:170-179`；`G-07.md:7-15`；`fault-inject.ts:361-390` |

统计：pass 2 项（G2-02、G2-03），fail 8 项，存疑 1 项（G2-07）。按“声称验了但实际未验到 = fail”的口径，G2 的结论不能成立。

## 对抗性探测记录

脚本：`output/audit-probe.ts`（P1–P10）、`output/probe-extra.ts`（P11–P12）；都在仓库外或者临时库上跑，未写入仓库测试。

| 编号 | 怎么打 | 期望 | 实际 | 判定 |
| --- | --- | --- | --- | --- |
| P1 | 复制 G2 证据到临时根，原样与篡改后各调一次 `verifyGateRecord` | 原样通过证据校验；篡改后被点名拒绝 | 原样只报 git diff 失败（临时根不是仓库，证据段已过）；篡改后报 `证据文件 sha256 不符: ev-g2-01（记录 8734224458947910… 实际 d9998cd40fb32e8b…）` | 证据哈希校验有效 |
| P2 | 同一 report 报两次；制造两条 rejected 后篡改 `node_run_events` seq2 的 hash，再回放非队头 p2_c | 第二次只落一次；断链/非队头重放被拒 | 第二次 `already_applied`、`report_applied=1`；`verifyChain` 报 `{seq:2, reason:"hash 对不上，内容被改过"}`；但 p2_c 回放 `accepted=true`、`next_status=verifying`、registry `applied` | **致命**：不验链、不验队头 |
| P3 | `applyCancel(interrupted)` 立围栏后，以 `expectedStatus=timing_out` 上报 `done` | 围栏期间上报进 rejected 排队 | `accepted=true`、节点 `done`、fence 仍 `armed` | **致命**：围栏挡不住收口 |
| P4 | 把 `lease_expires_at` 拨到过去后上报 | 抛 `LEASE_EXPIRED`，节点与 registry 均不变 | `code=LEASE_EXPIRED`；节点仍 `dispatched`；registry=0；`report_rejected=0` | 通过（原子回滚） |
| P5 | `BridgeEventBuffer` 高水位 350，连续 push seq 1..12，再 `takeFrom(1)` | 只溢写到磁盘，事件仍可取全 | `takeFrom(1).seq=[11,12]`，缺失 1..10；`toolStartAnchor=null` | **致命**：二次 spill 覆盖旧文件，证据丢失 |
| P6 | 节点走到 `done` 后按当前 revision 取消 | 终态没有出边，取消被拒 | `interrupted` 成功，`status=timing_out`、fence `armed`；`already_stopped` 返回 `next_status=stopping` 但节点仍 `done` | **致命**：终态被改回 |
| P7 | 跨 boot 停机 20 秒；再模拟墙钟回拨 600 秒 | 停机时间不计预算，回拨不放大剩余 | 正常剩余 40000ms；回拨后 660000ms（预算只有 60000ms） | **重大**：跨 boot 回拨放大预算 |
| P8 | 扫 `src` 的错误码使用面，与 `ERROR_STATUS` / `PROPOSED_ERROR_CODES` 比对 | 使用的码都在 §17.1 表里 | 未登记（不含提案）为空；被使用的提案码是 `LEASE_EXPIRED`、`BRIDGE_ACK_LAG`，均带 `details.proposed=true`，§17.1 表里没有 | 提案机制成立；但门记录 `exceptions: []` 与补记不一致 |
| P9 | 先到 `verifying`，建 `BEFORE INSERT ... WHEN type='report_applied' RAISE(ABORT)` 触发器，再报 `done` | 第六步失败时整笔回滚，不留半条状态 | `err=audit abort`；节点仍 `verifying/rev=3`；registry 只有两条旧 `applied`；applied 事件前/后 2/2 | 通过（原子性） |
| P10 | 解析 G2 正文可读表与 artifact 的 `must_pass_items` | 两处编号一致 | 正文 `G2-01..G2-09/g2-10/g2-11`；artifact `G2-01..G2-07/G-03/G-04/G-05/G-07`；`一致=false` | **重大**：gate-check 只读 artifact，发现不了 |
| P11a | 从 `dispatched` 直接报 `done` 且无证据 | 被证据门拒绝 | `reason=illegal_transition` | G2-05 实际验的是状态机，不是证据门 |
| P11b | 先到 `verifying`，再报 `done` 且无证据 | 被证据门拒绝 | `reason=evidence_missing` | 证明 G2-05 的测试口径错位 |
| P12 | `interrupted` 取消后，用新 revision 再取消一次 | 只立一次围栏 | 第二次仍成功，`fence_armed=2`，节点 `timing_out` | **重大**：G-05 的断言不成立 |

## 硬伤清单

### 致命

**F-01 S2 命令与执行器没有接入任何生产路径。**
- 现象：`applyReport`、`applyCancel`、`acquireLease`、`BridgeClient`、`BridgeEventBuffer`、`runTool` 在 `src` 内只有定义，没有生产调用方；`src/index.ts:1-2` 只有 `name/version` 两个导出；`src/service/server.ts:66-101` 只有 S1 的 health/tasks/events/ledger 四条路由。
- 证据：`grep` 结果只命中定义处（`apply-report.ts:72`、`cancel.ts:28`、`lease.ts:43`、`bridge.ts:48/142/223`、`tools.ts:151`）；测试只直接 import 这些函数，没有 bridge→runTool→applyReport 的串联用例。
- 为什么算问题：G2 声称“单节点闭环”，实际只有一组库函数和 DB 状态迁移用例；没有真实 executor 会话、没有桥事件流入、没有工具产出证据，闭环在仓库里不存在。
- 修法：把 lease→executor→bridge→runTool→applyReport 接进服务装配；至少加一条用真实 SQLite + executor 的端到端用例，再谈 G2。

**F-02 当前 HEAD 的 G1/G2 门记录均不可验证。**
- 现象：四条命令里 `pnpm test`、G2 门检查、G1 门检查全部 exit 1，失败点都是 `candidate_hash`。
- 证据：复算显示 G2/G1 在 HEAD~1 都 `match=true`，在 HEAD 都 `match=false`；G2 多出 `handoff.md`，G1 的 `handoff.md` 内容变了。根因是 `d844a0e` 签门后 `225a4f9` 又改 `handoff.md`，而候选范围包含它。
- 为什么算问题：门记录的核心价值是“当前提交可复算”；签名后改候选文件，哈希即失效，门结论不能成立。
- 修法：门签名后冻结候选（或把 `handoff.md` 排除出候选）；补一条 CI 在 HEAD 上跑 `gate-check`，红即阻断合并。

**F-03 G2 的四份注入证据证明不了注入，且不可复现。**
- 现象：`G-03/G-04/G-05/G-07` 的“注入前账本片段”和“恢复后账本片段”完全相同，且都只有 `1 task.created evt_…`；G-05 根本没有工具执行；G-07 的节点 `deadline_boot_id/deadline_monotonic_ns` 为 null。
- 证据：`fault-inject.ts:46-54` 的 `dumpEvents` 只查 `events` 表，`injectQueued/applyReport` 写的是 `node_runs/node_run_events`；`G-03.md:7-15`、`G-04.md:7-15`、`G-05.md:7-15`、`G-07.md:7-15`。
- 为什么算问题：门证据要求“参数 + 注入前后账本 + 对账查询”，现在前后两段与注入无关；另外证据里带随机 `evt_` 和临时目录，重跑一次字节就变，原哈希不可再生。
- 修法：证据改为 dump `node_runs/node_run_events/report_registry` 的前后值；固定或脱敏随机 id；证据生成后用同一输入重跑并比对哈希。审计中一次误从仓库根跑 G-03 曾覆盖 `G-03.md`，已用 `git checkout` 恢复到 HEAD 原字节，最终 `git status` 干净。

**F-04 已 rejected 报告的重放既不验哈希链，也不验队头。**
- 现象：`apply-report.ts:103-117` 对已 rejected 的 report 只做 `SELECT COUNT(*) FROM node_run_events`，只要大于 0 就把 registry 改成 `replayed` 并继续收口；没有调用 `verifyChain`，也没有调用 `pickReplayHead`。
- 证据：P2 把 seq2 的 hash 改坏后回放非队头 p2_c，`accepted=true`、`next_status=verifying`、registry `applied`；`verifyChain` 同时报 seq2 断链。
- 为什么算问题：规格 §4.2:304 要求“只有当前 attempt 队头可重放，重放前先验哈希链”；现在断链账本仍能继续写，账本完整性被绕过。
- 修法：重放前调用 `verifyChain`，并要求 `report_seq == min(rejected.report_seq where attempt=current)`；不满足就拒绝/保持 rejected，补断链与非队头用例。

**F-05 围栏 armed 期间 `done` 仍可落账。**
- 现象：`applyReport` 全函数没有 `fence_state` 检查；`timing_out` 在状态机里有到 `done/failed` 的边（`state-machine.ts:44`）。
- 证据：P3 在 `fence_state=armed`、`status=timing_out` 时上报 `done`，返回 `accepted=true`，节点变 `done`，fence 仍 armed。
- 为什么算问题：规格 §4.5:358 要求围栏期间上报进 registry 排队，撤销后只重放队头；现在取消确认后仍可能被“完成”收口，取消语义失效。
- 修法：`applyReport` 入口检查 `fence_state='armed'` 时只落 rejected 排队；只有 `revokeFence` 后才允许重放。补围栏期间 done/failed 用例。

**F-06 桥缓冲二次 spill 会丢早期事件。**
- 现象：`spill()` 用“agentId-首seq.jsonl”新建文件并只保留最新 `spillFile`；`takeFrom()` 只读最新文件加内存；`toolStartAnchor()` 只扫内存。
- 证据：P5 高水位 350、push seq 1..12 后，`takeFrom(1)` 只有 `[11,12]`，缺失 1..10；`toolStartAnchor=null`。
- 为什么算问题：规格 §7.3:594 允许 spill 但不许丢证据；现在第二次 spill 后早期事件取不回，`tool.start` 锚点也丢，证据链和动作计时都失效。
- 修法：保留 spill 文件列表/索引，`takeFrom` 合并全部 spill 文件；锚点落盘或在 spill 时保留；补二次 spill 与断号重取用例。

**F-07 终态 `done` 可被取消改回 `timing_out`。**
- 现象：`applyCancel` 的 CAS 只有 `node_run_id + attempt + revision`，没有 `status` 条件；`done` 节点用当前 revision 调 `interrupted` 会成功改成 `timing_out`。
- 证据：P6；`cancel.ts:31-35`；状态机 `done: []`（`state-machine.ts:51`）。
- 为什么算问题：终态没有出边是 G2 不变量 I1 的基础；现在取消能把终态复活，后续还可能再次收口。
- 修法：取消与围栏撤销的 CAS 加 `status IN ('dispatched','started','waiting','verifying','stopping','timing_out')` 之类的前置条件；终态直接判 `already_stopped` 且不改状态。补终态取消用例。

### 重大

**M-01 G2-05 用状态机拒因冒充证据门。** 证据见 P11a/P11b：从 dispatched 报 done 得到 `illegal_transition`，只有从 verifying 报 done 才得到 `evidence_missing`。修法：把用例起点改到 `verifying`，并断言 `reason` 含证据不足语义。

**M-02 G2-04/G2-06 是空验。** 全仓没有创建新 attempt 的路径，也没有写 `blocked` 的路径，两个断言在空库上恒真。修法：构造真实的重新派发/新 attempt 与 blocked_pre/blocked_post 路径，或者把这两项降级为“无路径”说明，不要记 pass。

**M-03 G-05 没有“工具执行中”，也没有“只立一次”。** 测试节点停在 `dispatched`，只调一次 `applyCancel`；P12 第二次取消得到 `fence_armed=2`。修法：节点走到 `started` 且有 `tool.start`，并发/重复取消只允许一次 `fence_armed`。

**M-04 节点 passCondition 能覆盖模板的 mandatory baseline。** `policy.ts:68-79` 在同 path+op 时直接 `same.value = cond.value`；`tests/policy.spec.ts:45-55` 还把“节点值=1”写成期望。规格 §4.7:390 要求模板条件是基线，节点只能 and 追加。修法：同 path+op 时保留模板值，节点条件改为追加更严格的条件；改测试。

**M-05 策略由调用方传入，不从 workflow_version 载入。** `apply-report.ts:72-77` 的 `policy` 是参数；规格 §4.2:293 要求服务按 `node_run_id` 找到 run 的 `workflow_version`，载入不可变模板的 `verification_policy/evidence_source`，调用方不得自带策略。现在任何调用方都能传弱策略。修法：在服务层载入策略，`ApplyReportParams` 去掉 `policy`。

**M-06 动作代不一致返回 `rejected/generation_mismatch`，不是 `STALE_GENERATION`。** `apply-report.ts:134-136`；规格 §4.3:309 要求 `STALE_GENERATION`；`tests/apply-report.spec.ts:74-77` 按实现写死 `generation_mismatch`。修法：按规格抛错/回码，测试改期望。

**M-07 跨 boot 墙钟回拨会放大剩余预算。** `clock.ts:75-80` 的 `downtimeMs` 在 `currentBoot.startedAtMs < prev.lastEventWallMs` 时为负，`remaining` 反而大于预算；P7 回拨 600 秒后剩余 660000ms（预算 60000ms）。修法：`downtimeMs = max(0, ...)`，并对 `remaining` 取 min(预算, 计算值)。

**M-08 命令哈希核对函数没有调用点。** `tools.ts:192-199` 定义了 `assertCommandHash`，全仓只此一处；规格 §7.2:589 要求落库前核对命令哈希。修法：证据落库/上报前调用，补命令被替换的负向用例。

**M-09 `EVIDENCE_SOURCE_UNAVAILABLE` 在 runTool 调用期才抛。** `tools.ts:164-168`；规格 §4.7:385 要求加载期就报。修法：executor/工作流加载时检查宿主只读挂载，失败即拒绝加载。

**M-10 sweep 只扫租约过期，没有围栏宽限/startup_unknown/verify 扫描。** `sweep.ts:12-16` 只调 `sweepExpiredLeases`；计划 Task 12:2132/2232 明确要求“每分钟扫租约过期与围栏宽限”，Task 11 的 `revokeFence` 也没有生产调用方。修法：补围栏宽限扫描并在到点后调用 `revokeFence` + 重放队头；补 startup_unknown/verify 扫描。

**M-11 G2 正文表编号与 artifact 不一致，`exceptions` 也没有登记提案码。** `G2.md:17-27` 是 `G2-01..G2-09/g2-10/g2-11`，artifact `G2.md:99-176` 是 `G2-01..G2-07/G-03/G-04/G-05/G-07`；`G2.md:181` 的 `exceptions: []` 与 `:198` 补记里的两个提案码不一致；`gate-check.ts` 只读 artifact，不解析正文表。修法：正文表由 artifact 生成，或在 gate-check 里加正文/artifact 交叉校验；提案码登记进 exceptions 或规格表。

**M-12 G1 的门证据是“测试 gate-check 自身”的文件。** `docs/gates/G1.md:43/69/259` 把 `tests/gate-check.spec.ts` 作为 `ev-gatecheck`，而该用例正是断言 G1 门记录通过；门记录用自己的通过测试证明自己通过。修法：门证据改由独立脚本/CI 产出，测试只验证规则，不在门记录里自证。

### 轻微

- **m-01** `already_stopped` 返回 `next_status='stopping'`，但节点状态没改（`cancel.ts:56-65`）；规格 §4.5:352 要求按已停事实判定。测试只断言 `status != timing_out`，放过了 `next_status`。修法：返回真实状态，测试断言 `next_status`。
- **m-02** G2-01..07 的证据文件只有“用例/结果/复现/断言口径”四行，没有命令原始输出或数据库前后值；门证据强度不足。修法：附 JSON reporter 片段或 SQL 查询结果。
- **m-03** `revokeFence` 只检查 `fence_state==='armed'`，不检查 `fence_grace_until` 是否到点（`cancel.ts:89-99`）；任何调用方都能提前撤销。修法：到点才允许撤销，或由调用方传入并校验 now。
- **m-04** 重复 rejected 上报每次都会追加 `report_rejected` 事件（`apply-report.ts:110-119`），没有按 `report_id` 去重；账本会膨胀。修法：同 report 的重复拒绝只更新 registry，不再追加同因事件。

## 规格偏差清单

| # | 规格 | 实现 | 偏差 |
| --- | --- | --- | --- |
| 1 | §4.2:293 策略由服务按 `workflow_version` 载入，调用方不得自带 | `apply-report.ts:72-77` 把 `policy` 作为参数 | 调用方可传弱策略，模板基线失效 |
| 2 | §4.2:304 只有当前 attempt 队头可重放，重放前验哈希链 | `apply-report.ts:103-117` 只查 `COUNT(*)>0` | 断链、非队头都能继续落账（P2） |
| 3 | §4.3:309 动作代不一致返回 `STALE_GENERATION` | `apply-report.ts:134-136` 返回 `rejected/generation_mismatch` | 错误码语义不符 |
| 4 | §4.5:358 围栏期间上报排队，撤销后只重放队头 | `applyReport` 没有 fence 检查 | 围栏期间 done 直接 applied（P3） |
| 5 | §4.7:390 模板 `passCondition` 是 mandatory baseline，节点只能 and 追加 | `policy.ts:68-79` 同 path+op 覆盖模板值 | 节点能放宽/篡改判定 |
| 6 | §4.7:385 宿主无只读挂载在加载期报 `EVIDENCE_SOURCE_UNAVAILABLE` | `tools.ts:164-168` 在 `runTool` 调用期抛 | 加载成功、执行时才失败 |
| 7 | §7.2:589 落库前核对命令哈希 | `tools.ts:192-199` 的 `assertCommandHash` 无调用点 | 命令被替换时证据仍可能入库 |
| 8 | §4.5:352 `already_stopped` 按已停事实判定 | `cancel.ts:56-65` 返回 `stopping` 但状态不改 | 返回值与事实不一致 |
| 9 | §3.5/§4.9 终态没有出边，迁移带 CAS | `cancel.ts:31-35` 的 CAS 没有 status 条件 | `done` 能被改回 `timing_out`（P6） |
| 10 | §4.4:342 跨 boot 停机时间不计入预算 | `clock.ts:75-80` 对负 downtime 没有夹取 | 墙钟回拨放大预算（P7） |
| 11 | §4.9:426-429 维护扫描覆盖租约、围栏宽限等 | `sweep.ts:12-16` 只扫租约过期 | 围栏宽限/startup_unknown/verify 无扫描 |
| 12 | §7.3:594 缓冲上限 8MiB、高水位 4MiB，spill 不丢证据 | `bridge.ts:167` 只看 highWater，`limitBytes` 未使用；`takeFrom` 只读最后 spill | 二次 spill 丢事件（P5） |

## 测试自证清单

1. `tests/policy.spec.ts:45-55`：断言“同路径同运算符取节点值”，这正是 `policy.ts:71-74` 的实现行为，却与规格 §4.7:390 的 mandatory baseline 相反；测试把偏差固化成期望。
2. `tests/apply-report.spec.ts:74-77`：断言 `generation_mismatch`，直接照 `apply-report.ts:134-136` 的实现写，规格要求的是 `STALE_GENERATION`。
3. `tests/integration/g2.spec.ts:105-115`：只断言 `accepted=false`，实际拒因是 `illegal_transition`（P11a），并没有验到“终态必带证据”；这是“断言过宽导致错误路径也能绿”。
4. `tests/integration/g2.spec.ts:93-103` 与 `:117-123`：在没有任何“新 attempt”/“blocked”生产路径的库上做否定断言，属于空验。
5. `tests/cancel.spec.ts:102-125`：直接对 `pickReplayHead/markOlderAttemptsStale` 建 registry 行做 SQL 断言，没有和 `applyReport` 串联；证明不了“围栏期间排队、撤销后只重放队头”。
6. `tests/bridge-buffer.spec.ts:43-58`：只触发一次 spill，刚好绕开 `spillFile` 被第二次覆盖的缺陷；`:71-76` 的 `refillPage` 只收集结果，没有 push 回缓冲，绕开序号倒退路径。
7. `tests/integration/g2.spec.ts:36-46` 的 `goodReport/PASS` 与实现共用同一形状和同一 `evidence.exitCode` 判定，测试数据是按实现构造的 happy path；没有覆盖 `report_seq` 乱序、旧 attempt、fence 等。
8. G1 门记录把 `tests/gate-check.spec.ts` 当作 `ev-gatecheck`（`G1.md:43/69/259`），而该测试正是断言 G1 门记录通过；门证据与门校验形成自指闭环。

## 跳过的 Task 清单

没有整个 Task 被跳过（计划 14 个 Task 都有对应文件/提交）。但以下 Task 的验收没有做到：

- **Task 7（agent 节点执行器）**：`src/executor/session.ts` 单测存在，但 `createExecutorAgent` 没有接进桥或服务；G2-01 没有真实 executor。
- **Task 11（取消与围栏）**：`pickReplayHead/revokeFence` 只有定义，`applyReport` 没有调用；围栏期间上报被 applied（P3），二次取消能再立围栏（P12）。
- **Task 12（截止时间与扫描）**：`sweep` 只扫租约过期（`sweep.ts:12-16`），没有围栏宽限；跨 boot 回拨放大预算（P7）。
- **Task 14（G2 用例与门记录）**：`pnpm tsx` 命令不存在；`pnpm test` 红；G2 门检查红；证据前后片段相同；正文表编号与 artifact 不一致。
- **Task 10（证据门与判定）**：实现与测试都按“节点覆盖模板值”写，和规格 §4.7:390 冲突；这是计划本身写错，不只是实现偏差。

## 附：审计脚本与产物

- `output/audit-probe.ts`：P1–P10，覆盖证据篡改、重放、围栏、租约、spill、终态取消、时钟回拨、错误码、第六步失败、编号不一致。
- `output/probe-extra.ts`：P11a/P11b（G2-05 拒因）、P12（二次取消）。
- `output/candidate-check.ts`：G1/G2 在 HEAD 与 HEAD~1 的候选哈希复算。
- `output/probe-cwd/`：在仓库外重跑的四份注入证据；只写 `output/`，未进仓库。
