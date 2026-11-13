# S2 / G2 第十轮独立审计（HEAD 0919589）

审计对象为 D:/aboutAI/dsh-orchestra，HEAD 0919589b0336aaf462edd72bf641cb5feef9520b，审计开始时 git status --porcelain 为空。本轮只读源码、HEAD 字节与命令输出，未改业务代码、未改 docs/gates、未签门、未提交、未 push；唯一写出的文件是本报告。证据哈希按 UTF-8 文本的 LF 归一重算，临时重跑均在 %TEMP% 下进行，不改主仓库。

结论：pass

计数：P0=0，P1=0，P2=10。

## 一、审计范围与方法

本轮覆盖 S2/G2 的 19 个必过项、19 份证据、I1..I11 不变量，以及证据签发、单写者锁与 epoch、CAS、工作流版本、工具授权、租约心跳、审计结论解析等核心不变量。判断以源码、HEAD 字节和实际命令输出为准，不采信文档自述。

环境：D:/NodeJs/node.exe v26.13.1，typescript 6.0.3，vitest 4.1.8。主仓库只跑 tsc --noEmit、vitest run、scripts/gate-check.ts；fault-inject 只在 %TEMP% 的仓库副本中跑。

## 二、G2 门记录逐项核对

### 2.1 19 个必过项

G2 规格定义在 scripts/gate-check.ts:97-166。artifact.must_pass_items 在 docs/gates/G2.md:140-275，正文表在 docs/gates/G2.md:27-45。逐项结果如下，全部 result=pass，且 artifact 的 id 顺序、evidence_ids 与固定映射、正文内容列均一致；JCS 规范化比较的 ITEM_ISSUES 为空。

| 编号 | 结果 | 证据 | 核对 |
| --- | --- | --- | --- |
| G2-01 | pass | ev-g2-01 | 单节点 queued 到终态走生产装配 |
| G2-02 | pass | ev-g2-02 | 重复上报只落一次 |
| G2-03 | pass | ev-g2-03 | 租约过期迟到上报被拒 |
| G2-04 | pass | ev-g2-04 | 取消后不产生新 attempt |
| G2-05 | pass | ev-g2-05,ev-g2-10 | 终态必带证据 |
| G2-06 | pass | ev-g2-06 | 无裸 blocked |
| G2-07 | pass | ev-g2-07 | S2 加载 parallel 被拒 |
| G-03 | pass | ev-g2-g03 | 同一 report_id 两次只落一次 |
| G-04 | pass | ev-g2-g04 | 租约到期后迟到上报被拒 |
| G-05 | pass | ev-g2-g05 | 工具执行中取消只立一次围栏 |
| G-07 | pass | ev-g2-09,ev-g2-g07 | 墙钟跳变不误判截止 |
| G2-08 | pass | ev-g2-08 | 工具失败不许落完成 |
| G2-09 | pass | ev-g2-09 | 判定时限只认 boot_id 与单调纳秒 |
| G2-10 | pass | ev-g2-10 | 系统级证据门拒弱证据与伪造痕迹 |
| G2-11 | pass | ev-g2-11 | 同一 report_id 重投不刷膨胀 |
| G2-12 | pass | ev-g2-12 | 工具授权只认 workflow 定义 |
| G2-13 | pass | ev-g2-13 | 单写者锁与 epoch 围栏 |
| G2-14 | pass | ev-g2-14 | 长动作心跳续租，扫描不误判过期 |
| G2-15 | pass | ev-g2-15 | 同版本跨重启不可改写 |

19 项数量、顺序、内容列与证据集合的核对代码在 scripts/gate-check.ts:623-649、639、672；本轮独立脚本输出的 BLOCK_COUNTS 为 mustRows=19、evRows=19、invRows=11、ev=19、inv=11、items=19，ITEMS_ORDER_OK=true，ITEM_ISSUES=[]。

### 2.2 19 份证据

固定映射在 scripts/gate-check.ts:97-166 的 evidenceMap，正文表在 docs/gates/G2.md:68-88，JSON 索引在 docs/gates/G2.md:316-414。19 个 id 全部唯一，文件与映射一一对应。按 git show HEAD 取字节、LF 归一重算的 sha256 如下，19 份全部与 evidence-index 和正文表一致。

| 证据 id | 文件 | sha256 |
| --- | --- | --- |
| ev-g2-01 | docs/gates/evidence/G2/ev-g2-01.md | f10efac98f2d0d91bfc83d0e1bacb3c2a5111c11bc7223de6464a057a744d88b |
| ev-g2-02 | docs/gates/evidence/G2/ev-g2-02.md | 346af5813c653ba967af948a74aba27201b9ac906f13e54f4e588f8b18ea70e1 |
| ev-g2-03 | docs/gates/evidence/G2/ev-g2-03.md | 784e44b65d6642404d0f7664bda64e48337292101a102f1403aef4caee4a6db5 |
| ev-g2-04 | docs/gates/evidence/G2/ev-g2-04.md | 65946e22958ef8764415d2af693245f8dc8da33e585ba4cee094e36f56ac71a6 |
| ev-g2-05 | docs/gates/evidence/G2/ev-g2-05.md | 74c0a94705a24494d435c995317d6a29f40e089a992e9c75afa5e0735b35adb1 |
| ev-g2-06 | docs/gates/evidence/G2/ev-g2-06.md | cef5cf3de601985af216cb935334414d56ff9f3f296871f709332f9e16b1f91c |
| ev-g2-07 | docs/gates/evidence/G2/ev-g2-07.md | 607471ff9e475eaa30e3a83376b4c93aed12b6e209b7bd2601678737cf934a34 |
| ev-g2-08 | docs/gates/evidence/G2/ev-g2-08.md | 54e4b0e8415abd5bc65ce885c407245d91ec099390e64a2b3188c89cb1144cbf |
| ev-g2-09 | docs/gates/evidence/G2/ev-g2-09.md | f43b50982b67843db87e1cae9b36b0048eca372d9734904d3e1090fc97b8d8b2 |
| ev-g2-10 | docs/gates/evidence/G2/ev-g2-10.md | 76b458edf0f4f24a4408be4bf429b4a9025399aa002c52b6c50676a5f4f45e8b |
| ev-g2-11 | docs/gates/evidence/G2/ev-g2-11.md | 05c1c8ea1ab5796a24adc50931a3a1b3d6d085af56975b47f6c9a113f7f233c7 |
| ev-g2-12 | docs/gates/evidence/G2/ev-g2-12.md | 5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe |
| ev-g2-13 | docs/gates/evidence/G2/ev-g2-13.md | a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc |
| ev-g2-14 | docs/gates/evidence/G2/ev-g2-14.md | 865fd0b7bca1193256dedee74f30a18c8903f5e0fa4c2d119cad6e41b50ada02 |
| ev-g2-15 | docs/gates/evidence/G2/ev-g2-15.md | db1c814f8935e1779440aec12c5a229a6ec8636a0e6ccc7f86d2ac834e037038 |
| ev-g2-g03 | docs/gates/evidence/G2/G-03.md | 514f9754fda67b8e1522d086fc6079301e00bd0185f9cca6dddec502c412ab70 |
| ev-g2-g04 | docs/gates/evidence/G2/G-04.md | fb68366d1292bb80e9ae59febf7fd5ad1e28e580ecfc2883e99b18edb2e6eca9 |
| ev-g2-g05 | docs/gates/evidence/G2/G-05.md | 2f7da35abe9c1484143b85a0226da8a0ebd095994c8e2aa492dd88f726b51904 |
| ev-g2-g07 | docs/gates/evidence/G2/G-07.md | 8898db1323c191c8ca0acd51d2dde5458355b7b25f3b0c96f868ec38d8ef730e |

### 2.3 四个聚合哈希与自锚

当前 HEAD 的实算值与门记录锚点如下。差异均属 HEAD 变更后的待签状态，不是本轮 P0/P1；重签时由 scripts/sign-gate.ts:27-79 重算。

| 项 | HEAD 实算 | 门记录当前值 | 结论 |
| --- | --- | --- | --- |
| evidence_index_hash | 106e1c362e7d4312e647580a99b3cfc01eb604546af9fd42167af4bbce6b8fd0 | bcaaaa3e85d1dea69d323c9a03040f0bc7586445d5d833169b3768ac487b6347 | 待重签 |
| invariants_hash | 925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304 | 77708d4b54f29a676481b6c2755a241171c2cfab1231ef6e621f184fc68cedd5 | 待重签 |
| artifact_hash | ea3dff4caa8de38d5336388e32eb4af4867998308a28a6b010d180d8d85c291a | b5615b8b5725c5b2df88b9231b13885635940ef7db9f7fe802bc162c651c7a0a | 待重签 |
| body_hash | 8a446dab790678971a9b88141fc1fd030b538df33fad5a4f8b56421c32530dbe | ef21bb456813786ab878abae2824a873f6e7d470e257d2bcadfb9eb73282dfd3 | 待重签 |
| candidate_hash | bc36e6f92e26e61505a9ab94db9e6c099fe4e1646eb80be7799317e4208e487b | f11d0fb8751ce561df6d24379ad083f12c4bc60c866f87ec7f523858e32c0af8 | 待重签 |
| change_scope_hash | fc570cab664365d4347ac5e009be3cb3a10f11f87567c71640d5ec881788f63c | 33a82c417c33b950fe40f332f398018a29eebf5f2ed1242bb3772064f9626927 | 待重签 |

candidate 文件数 57。审计锚当前仍是 audit_round=4、audit_report=docs/audits/S2-independent-audit-round4.md、audit_report_sha256 为 64 个 0（docs/gates/G2.md:310-312）。按任务约定这是待签，不计缺陷；但重签前必须由人先把 audit_round 改为 10、audit_report 改为 docs/audits/S2-independent-audit-round10.md，再跑 sign-gate，sign-gate 不会自动改这三项。

### 2.4 I1..I11 不变量

不变量正文表在 docs/gates/G2.md:115-127，JSON 块在 docs/gates/G2.md:416-504。逐项比较 id、statement、evidence_ids 的排序结果，INVARIANT_ISSUES 为空；invariants_hash 实算 925a7768...，与当前记录 77708d4b... 的差异同属待重签。

## 三、核心不变量复核

### 3.1 证据由服务端签发

done 报告在 applyReport 内先过 systemEvidenceGate：要求 evidence.source 为 run_tool、exitCode 是 number 且为 0（src/service/commands/apply-report.ts:303-311）。随后 traceBindingGate 按 node_run_id 与 attempt 回查 tool_executions，要求 exit_code 与 stdout_hash 对得上（src/service/commands/apply-report.ts:314-323）。强证据本身由 ReadOnlyToolRunner.runTool 生成，来源固定为 run_tool，stdout/stderr 哈希和 commandHash 都在服务端计算（src/executor/tools.ts:179-216）。证据强弱与必留哈希在 src/core/policy.ts:18-45。该不变量成立；工具身份的收窄见 P2-12。

### 3.2 单写者锁与 epoch 栅栏

锁用 proper-lockfile 锁在 dbFile + .lock（src/infra/lock.ts:4-6）。写事务先 BEGIN IMMEDIATE，再读 service_meta.instance_epoch，与连接 epoch 不等就抛 STALE_GENERATION（src/infra/sqlite/driver.ts:75-92）。启动顺序是锁、bumpEpoch、openServiceDb、createOrchestra（src/index.ts:110-134），createOrchestra 要求锁凭证。ev-g2-13 重跑显示：epoch=1，第二写者 ELOCKED，bump 后 epoch=2，旧连接 STALE_GENERATION。该不变量成立。

### 3.3 CAS

租约状态迁移的 CAS 条件含 status、attempt、revision（src/service/commands/lease.ts:61-72）；节点状态迁移的 CAS 条件含 node_run_id、status、attempt、revision，受影响行数必须恰为 1（src/service/commands/node-state.ts:91-96）；applyReport 校验报告 attempt 与请求 attempt、行 attempt、fence、expectedStatus、action_generation，并校验租约（src/service/commands/apply-report.ts:197-225）。该不变量成立。

### 3.4 工作流版本不可改写与跨重启 hydrate

hydrate 时按 definitionHashOf 校验 content_hash，不等就抛 WORKFLOW_VERSION_IMMUTABLE（src/service/workflows.ts:29-41）；load 对持久化与内存定义都拒绝同版本不同哈希（src/service/workflows.ts:43-70）；applyReport 在 done 前按 runs.workflow_definition_hash 比对当前定义（src/service/commands/apply-report.ts:91-114）。ev-g2-15 两次重跑均为 2434 字节、sha256 db1c814f...，内容显示重启后定义表仍只有旧定义，同版本改写 HTTP=409 WORKFLOW_VERSION_IMMUTABLE，在飞节点仍 verifying，弱证据收口 rejected/verification_too_weak。该不变量成立。测试层的同库 hydrate 局限见 P2-3。

### 3.5 工具授权 deny 优先、参数来自定义

assertToolsAuthorized 先查 deny，再 registry.require，再查 allow（src/executor/tools.ts:43-62）；runNode 在执行前按账本 node_id 与 workflow 版本取策略（src/executor/run-node.ts:56-65、100-109）；runTool 忽略请求 args，使用注册表 descriptor.command.args（src/executor/tools.ts:197-214）；resolveToolSet 对 deny 跳过（src/executor/session.ts:23-33）。ev-g2-12 的三个策略用例分别得到 FORBIDDEN、FORBIDDEN、TOOL_NOT_REGISTERED。该不变量成立。

### 3.6 租约心跳、lease_lost 与 action_timeout

runNode 在 acquire 后用 setInterval 续租，续租失败写 lease_lost 事件并把 lost 置为错误码（src/executor/run-node.ts:66-98）；动作总时限先 markBlocked('action_timeout') 再抛 OPERATION_TIMEOUT（src/executor/run-node.ts:143-159）；lost 或失败工具会转 blocked（src/executor/run-node.ts:223-239）；租约有效性用 expires_at 与 now 比较（src/service/commands/lease.ts:115-124）。ev-g2-14 重跑显示 3 秒动作、2 秒租约、500 毫秒续租下 2.5 秒扫描无 lease_expired，节点 done revision=9；同时暴露 done 后 lease_expires_at 仍在，见 P2-10。执行期测试缺口见 P2-2。

### 3.7 审计报告结论解析

auditConclusionOf 在 scripts/gate-check.ts:490-541，checkAuditAnchor 在 scripts/gate-check.ts:545-570。它只认行首结论，拒绝同行相反 token，拒绝 pass 后若干阻塞词，并跳过简单围栏。该机制阻止了“fail 报告签 pass”的旧 P0，但仍存在误杀与漏杀，见 P2-7、P2-9。当前 round9 报告 sha 为 3580fcdc...，解析为 pass；round4 报告 sha 为 c9cef2e4...，因正文另有结论候选，解析为 null。

## 四、关键证据重跑

### 4.1 ev-g2-15 两次重跑

在 %TEMP%/audit10-ev15-run1-89e5525b 与 %TEMP%/audit10-ev15-run2-37283b75 两个独立副本中执行 D:/NodeJs/node.exe scripts/fault-inject.ts --case ev-g2-15，两次均 exit 0，生成的 ev-g2-15.md 均为 2434 字节，sha256 均为 db1c814f8935e1779440aec12c5a229a6ec8636a0e6ccc7f86d2ac834e037038，字节一致，且与 HEAD 的 evidence-index 值一致。证据内临时库写作 <tmp>/orchestra.db，事件 id 归一为 evt_1、tsk_1、run_1、nrun_1，未出现随机临时路径。对账输出：首次加载 HTTP=200，验收到 verifying HTTP=200，绑定哈希 206681cf...，重启后定义表仍为该哈希，同版本改写 HTTP=409 WORKFLOW_VERSION_IMMUTABLE，节点 verifying/attempt=1/revision=3，弱证据 done accepted=false reason=verification_too_weak registry_state=rejected。

### 4.2 ev-g2-12/13/14 抽查

在 %TEMP%/audit10-ev-g2-12-222a0a0c、audit10-ev-g2-13-11053bda、audit10-ev-g2-14-defe8888 三个独立副本中分别执行同一注入脚本，均 exit 0，字节与 HEAD 一致：ev-g2-12 2811 字节 sha 5c2d543f...；ev-g2-13 567 字节 sha a5260693...；ev-g2-14 2260 字节 sha 865fd0b7...。ev-g2-12 覆盖 allow ro.echo、deny ro.echo、allow ro.fail 三例，返回 FORBIDDEN、FORBIDDEN、TOOL_NOT_REGISTERED；ev-g2-13 覆盖 epoch 与锁；ev-g2-14 覆盖心跳续租。

19 份证据的逐份哈希见 2.2 节，全部可复现。

## 五、类型检查与全量测试

D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit：TSC_EXIT=0，无输出。

D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run：VITEST_EXIT=1，Test Files 1 failed | 31 passed (32)，Tests 10 failed | 285 passed (295)，Duration 6.63s。10 个失败全在 tests/gate-check.spec.ts：G1 门记录通过、candidate_hash 锚不动、证据文件哈希指名、evidence_index_hash 被改、candidate_hash 别处值、正文必过项内容列、正文证据表哈希、正文不变量说明、证据文件固定映射、正文自锚 body_hash。首因是 G1 的 audit_report_sha256 仍为 64 个 0，scripts/gate-check.ts:563 报错：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…。其余失败都被这个早退遮蔽，未发现 tests/gate-check.spec.ts 之外的失败。

scripts/gate-check.ts docs/gates/G1.md：exit 1，同一 sha256 报错。scripts/gate-check.ts docs/gates/G2.md：exit 1，报错 0000… != c9cef2e419c91711…，原因是 G2 审计锚仍指向 round4 报告且 sha 为 0。两者都是重签前预期状态，不作为 G2 的 P0/P1。

## 六、P2 清单

P2 共 10 条，均不阻断 pass。编号沿用第九轮，P2-6 与 P2-8 已在 HEAD 修复，不再列。

### P2-1 动作超时配置未进生产装配

位置：src/index.ts:87-98 只把 leaseTtlMs 与 leaseRenewIntervalMs 传进 runNode，没有 execution.action_timeout_ms 的配置接线；G2.md:17 已写“配置接线留 S3”，但 G2.md:55 的本批定值表仍把 execution.action_timeout_ms 写成 120000，像已生效。实际只有 DEFAULT_ACTION_TIMEOUT_MS 默认值生效。影响：文档与装配不一致，S3 接线前不能把该配置当可调项。整改方向：让文档明确“默认值生效、配置项未接”，或在本轮把配置接进 index.ts。

### P2-2 lease_lost 与 action_timeout 缺执行期测试

位置：src/executor/run-node.ts:66-98、143-159 有实现，但 tests 只有错误码列表和间接用例（tests/errors.spec.ts:41、tests/runtime.spec.ts:86/144/200、tests/integration/g2.spec.ts:86/192、tests/sweep.spec.ts:133），没有一条让心跳续租真实失败并断言 lease_lost 收口，也没有一条让动作总时限真实耗尽并断言 action_timeout。影响：实现存在但回归网未覆盖，后续改动可能静默破坏。整改方向：各补一条执行期用例，走 runNode 而不是只测状态机。

### P2-3 跨重启测试仍是同库 hydrate

位置：tests/workflows.spec.ts:45-55 用同一个 freshLedger 的 db 新建第二个 WorkflowCatalog，再 hydrate；这不是关闭连接、重开库文件的真实重启。ev-g2-15 已用 HTTP 入口与真实重启覆盖该行为。影响：单测名不副实，不能替代跨进程证据。整改方向：单测至少关闭并重开库文件，或把用例改名以反映同库 hydrate。

### P2-4 前序链只比字符串

位置：scripts/gate-check.ts:472-486 的 checkPreviousChain 只从 G1 HEAD 文本正则取 artifact_hash，与 G2 previous_artifact_hash 比较，不重算 G1 artifact，也不校验 G1 证据与审计锚。当前 G1 HEAD artifact_hash=1ce80f60...，G2 previous_artifact_hash 也是 1ce80f60...，字符串层面闭合；但 G1 自身尚不可通过。影响：G2 可以在 G1 未修复时完成重签，链的语义强度不足；G1 重签后 G2 还需再签一次。整改方向：让 checkPreviousChain 复用 verifyGateRecord 对 G1 做完整校验，或至少重算 G1 artifact_hash。

### P2-5 工作流别名冲突后内存残留

位置：src/service/workflows.ts:104-115 的 remember 先把 key 写进 this.defs，再检查数字别名冲突；冲突时抛 WORKFLOW_VERSION_IMMUTABLE，但已写入的 key 不回滚。影响：一次失败 load 会在 catalog 内存里留下半份定义，后续同实例查询可能看到失败前不应存在的版本。整改方向：先检查别名冲突，再统一写入；或用临时 map 成功后再合并。

### P2-7 围栏配对只按行首翻转

位置：scripts/gate-check.ts:496-499 对任何行首三反引号或三波浪号直接翻转 inFence，不记录开围栏的字符与长度，也不要求闭合标记匹配。构造 4 反引号开、3 反引号闭的输入时，解析器会提前认为围栏结束，把围栏内的示例结论当成真实结论。影响：格式不规范的报告可能被误读，方向可能是 false pass 或 false null。整改方向：记录开围栏的字符与长度，只接受同字符、长度不短于开围栏的闭合行。

### P2-9 审计结论解析仍有误杀与漏杀

位置：scripts/gate-check.ts:490-541。实测输入与结果如下，均直接调用 HEAD 的 auditConclusionOf。

误杀类：

- 合法结论后出现一行行首“建议：”说明，整份报告返回 null：suggest-line-after-pass、suggest-colon-after-pass。
- 合法结论带括号清零说明“P0 与 P1 均为 0”或“P0/P1 均无”返回 null：pass-zero-phrase1、pass-zero-phrase2。
- 合法结论用逗号接“无 P0/P1，P2 九条已列”返回 null：pass-cleared-ok；原因是 scripts/gate-check.ts:503 的 tail 只允许标点、括号和破折号解释，不允许逗号后接说明。
- 结论行带“对照 round8 的 fail 项已关闭”这类反义说明返回 null：antonym-explanation、antonym-dash。

漏杀类：

- 单独一行“建议：通过”被读成 pass：suggest-pass-alone；scripts/gate-check.ts:512 仍把建议行当结论候选。
- “结论：pass — 但还有 3 个重大问题”被读成 pass：pass-residual-major；“结论：pass（遗留 2 个重大缺陷）”也被读成 pass：pass-residual-major2。caveat 过滤只覆盖未闭合、仍未、仍有、尚有、尚存、没闭合、阻塞、致命与未清零 P0/P1（scripts/gate-check.ts:529-535），没有覆盖“重大问题/重大缺陷”。

影响：既有合法报告被拒签，也有带重大 caveat 的 pass 行被放行；因为显式 fail 结论仍解析为 fail，且门记录 conclusion 还需为 pass，本轮不把它升为 P1。整改方向：只接受“结论：pass/fail”这一种结论行，去掉“建议”作为结论；caveat 检测按整行语义覆盖 P0/P1、致命、重大、阻塞、未闭合、遗留等词，同时保留明确的零值短语；补对应回归用例。

### P2-10 done 后不释放租约

位置：src/service/commands/lease.ts:101-112 定义了 releaseLease，注释写“执行器正常收口时把租约交回去”，但 src/executor/run-node.ts:56-98 与 241-274 的正常收口路径没有调用它；全 src 搜索 releaseLease 只有定义处。ev-g2-14 的 done 节点 lease_expires_at 仍为 2026-11-13T03:00:04.000Z。影响：租约元数据与 leases 行在 done 后滞留，账本可读性变差；sweepExpiredLeases 只扫 dispatched/started，不会因此误判过期，所以不阻断。整改方向：在 submitReport accepted 后释放租约，或在证据中明确租约保留到终态后由清扫处理。

### P2-11 acquireLease 不校验调用方 attempt

位置：src/service/commands/lease.ts:48-83 的 AcquireLeaseParams 没有 attempt，CAS 用的是 row.attempt；src/executor/run-node.ts:56-72 在 acquire 前不校验 p.attempt；直到 src/service/commands/apply-report.ts:200-204 的 submitReport 才按 attempt 拒绝。影响：带错误 attempt 的 /v1/node-runs/run 请求可以先拿到当前 queued 节点的租约、跑只读工具，最后才在收口处被拒并把节点落 blocked_post；正确 attempt 的派发会被这次抢占挡住。整改方向：acquireLease 入参带 attempt，CAS 条件加 attempt = ?，runNode 在 acquire 前先核对。

### P2-12 traceBindingGate 只按 exit_code 与 stdout_hash 匹配

位置：src/service/commands/apply-report.ts:314-323 从 tool_executions 取所有同 node_run_id 与 attempt 的行，只要有一行 exit_code 与 stdout_hash 对上就通过，不校验工具名或 commandHash；空 stdoutHash 会与 null 行匹配。影响：证据绑定证明“这个 attempt 真跑过某个同样输出且成功的工具”，但不证明“报告里的工具就是被授权的那个”。因为 tool_executions 仍由服务端 runTool 写入，本轮不升为 P1。整改方向：把 tool 名与 command_hash 一并纳入匹配，或要求报告证据与具体 tool_execution 行一一对应。

## 七、G1 状态与重签顺序

G1 当前也是待签状态：docs/gates/G1.md:191-193 的 audit_round=1、audit_report=docs/audits/S1-independent-audit.md、audit_report_sha256 为 64 个 0；:197-198 的 artifact_hash 与 body_hash 是旧锚。第九轮报告记录 G1 还有 4 份正文证据哈希旧值，且当前 G1 审计报告没有唯一结论。按 S1 自身口径，G1 需要先补审计报告与门记录，再重签。

顺序上应先 G1、后 G2：G2 的 previous_artifact_hash 必须等于 G1 重签后的 artifact_hash。当前 G2 的 previous_artifact_hash 是 1ce80f60...，与 G1 HEAD 的旧 anchor 字符串相等；一旦 G1 重签，G2 必须跟着重签，否则 checkPreviousChain 会拒。这个顺序约束本身成立，但 checkPreviousChain 只验字符串、不验 G1 内容，见 P2-4。

## 八、结论

本轮未发现 P0 或 P1。19 项必过项、19 份证据、I1..I11、锁与 epoch、CAS、工作流版本、工具授权、租约心跳、审计锚机制均有源码与实测支撑。10 条 P2 已逐条列出，建议在 S3 开工前处理 P2-1、P2-4、P2-5、P2-7、P2-9，其余可排入后续迭代。本报告只写审计结论，不签门、不提交。

## 九、执行过的验证命令与真实输出摘要

1. git rev-parse HEAD；git status --porcelain；git log --oneline -8。输出 HEAD=0919589b0336aaf462edd72bf641cb5feef9520b，工作树无改动，HEAD 提交为 fix(gate): treat blocking caveats after pass as no conclusion。
2. D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit。TSC_EXIT=0，无输出。
3. D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run。VITEST_EXIT=1；Test Files 1 failed | 31 passed (32)；Tests 10 failed | 285 passed (295)；10 个失败全在 tests/gate-check.spec.ts，首因 G1 audit_report_sha256 占位 0。
4. D:/NodeJs/node.exe scripts/gate-check.ts docs/gates/G1.md。exit 1；审计报告 sha256 与记录不符（0000000000000000… != 50ba1b13cdf1b84d…）。
5. D:/NodeJs/node.exe scripts/gate-check.ts docs/gates/G2.md。exit 1；审计报告 sha256 与记录不符（0000… != c9cef2e419c91711…），因为锚仍指向 round4 报告。
6. 在 %TEMP% 副本执行 scripts/fault-inject.ts --case ev-g2-15 两次。两次 exit 0；2434 字节；sha256 db1c814f8935e1779440aec12c5a229a6ec8636a0e6ccc7f86d2ac834e037038；字节一致。
7. 在 %TEMP% 副本执行 scripts/fault-inject.ts --case ev-g2-12、ev-g2-13、ev-g2-14 各一次。均 exit 0；哈希分别为 5c2d543f...、a5260693...、865fd0b7...，与 HEAD 一致。
8. 独立 Node 脚本按 git show HEAD 取 19 份证据字节、LF 归一、JCS 规范化。BLOCK_COUNTS mustRows=19 evRows=19 invRows=11 ev=19 inv=11 items=19；ITEMS_ORDER_OK=true；ITEM_ISSUES=[]；EVIDENCE_COUNT=19；EVIDENCE_ISSUES=[]；INVARIANT_ISSUES=[]。
9. 直接调用 HEAD 的 auditConclusionOf 构造 22 组输入。结果见 P2-9；合法 pass 与显式 fail 可控，建议行与重大 caveat 存在误判。
10. 在 %TEMP%/audit10-resign-046be0c5 的临时 clone 中做签门可行性试验：把本报告的试验前版本提交进 clone，将 docs/gates/G2.md 的 audit_round 改为 10、audit_report 改为本报告、approved_at 改为 2026-11-13T12:59:00.000Z 并提交，再运行 scripts/sign-gate.ts docs/gates/G2.md。SIGN_EXIT=0，输出“重签完成：证据 19 份，candidate=bc36e6f92e26…，artifact_hash=ead36f6ff1ec…，body_hash=1df83b9349ea…，改动文件 57 个”；提交后运行 scripts/gate-check.ts docs/gates/G2.md，GATE_EXIT=0，输出“gate G2 通过（19 项必过、19 份证据哈希复核）”。clone 内 G1 仍 exit 1，说明 G1 修复前 G2 的签门机制仍可走通，但语义顺序仍应先 G1 后 G2。主仓库未签门、未提交。
