# S2 执行器/服务与 G2 门第十二轮独立审计

- 审计对象：HEAD `e022af35d6186778fd0daff8a7438888c468e314`（短哈希 `e022af3`）
- 审计范围：S2 执行器与服务、G2 门记录、19 份证据、门脚本、相关测试
- 审计方式：只读源码与证据复核；攻击复现与模拟重签在仓库外临时 clone 中进行
- 审计时间：2026-11-13

结论：pass

## 总览

P0=0，P1=0，P2=9。G2 的 19 项必过、19 份证据、正文表、证据表与 HEAD 字节一致；ev-g2-12/13/14/15 复跑字节与 sha256 稳定；第十一轮 P1-1 的关闭围栏修复有效，构造的「三反引号 + js」报告被 gate-check 与 sign-gate 同时拒绝。当前 G2.md 仍是待签记录（audit_round=4、审计报告 sha 全零、六个自锚陈旧），直接跑 gate-check 会 exit 1；在干净 clone 中用本报告模拟重签后，sign-gate 与 gate-check 均 exit 0。该待签状态是签前事实，不计 P0/P1。

## P0

无。

## P1

无。

## P2

### P2-1 动作超时配置未接生产，门正文两处口径不一致

- 位置：`src/service/dispatcher.ts:43-54`、`src/index.ts:87-98`、`src/executor/run-node.ts:144`、`src/core/config.ts:40`、`docs/gates/G2.md:17`、`docs/gates/G2.md:55`
- 现象：`runNode` 支持 `actionTimeoutMs`，但生产装配（dispatcher 与 index）都不传，运行时永远落到 `DEFAULT_ACTION_TIMEOUT_MS=120000`（`src/executor/run-node.ts:36-38`）。`execution.action_timeout_ms` 只有配置校验，没有调用方。G2.md:17 已写明「配置接线留 S3（本轮只有默认值生效）」，G2.md:55 的定值表仍列 `execution.action_timeout_ms`=120000，两处口径不一致。
- 复现：把配置文件里的 `execution.action_timeout_ms` 改为 1000，派发一个 3 秒动作；动作仍按 120 秒额度执行，不会在 1 秒时 `markBlocked('action_timeout')`。在 `src/service/dispatcher.ts:43-54` 与 `src/index.ts:87-98` 检索 `actionTimeoutMs` 为 0 命中。
- 影响：运维改配置不会改变动作总时限，配置项产生虚假安全感；门正文的定值表与实现不一致。属 S3 接线债，不阻断本轮。

### P2-2 lease_lost 与 action_timeout 缺执行期回归

- 位置：`src/executor/run-node.ts:75-91`、`src/executor/run-node.ts:144-159`、`src/executor/run-node.ts:223-227`、`tests/`
- 现象：实现有续租失败写 `lease_lost`、动作额度耗尽 `markBlocked('action_timeout')` 并抛 `OPERATION_TIMEOUT`、租约丢失后拒收 done 的分支，但全仓测试没有真正让续租失败或让动作额度耗尽的用例。`lease_lost` 在 tests 下 0 命中；`action_timeout`/`OPERATION_TIMEOUT` 只出现在配置、迁移与错误映射用例。
- 复现：`rg -n "lease_lost|OPERATION_TIMEOUT|action_timeout" tests` 只得到配置/迁移/错误映射命中；没有 runNode 级别的失败注入。
- 影响：这两条是长动作与租约围栏的关键收口，回归缺失会让后续重构静默改坏而不被测试发现。

### P2-3 节点 done 后不释放租约

- 位置：`src/service/commands/lease.ts:102-112`、`src/service/commands/apply-report.ts:274-298`、`docs/gates/evidence/G2/ev-g2-14.md:37`
- 现象：`releaseLease` 已实现但 src 内没有调用方；done 收口没有调用 `releaseLease`，租约字段保留。ev-g2-14 复跑里节点已 done、revision=9，`lease_expires_at` 仍是 `2026-11-13T03:00:04.000Z`。
- 复现：重跑 `node --no-warnings scripts/fault-inject.ts --case ev-g2-14`，看「恢复后账本片段」与对账查询的 `lease_expires_at`；或完成一次正常 done 后查 `node_runs.lease_expires_at`。
- 影响：终态节点保留过期租约字段，账本可读性变差，外部巡检容易把终态节点误读成仍被占用；不影响状态机正确性。

### P2-4 acquireLease 不校验调用方 attempt

- 位置：`src/service/commands/lease.ts:48-83`、`src/executor/run-node.ts:101-115`
- 现象：`acquireLease` 参数只有 `nodeRunId`/`ownerEpoch`/`leaseTtlMs`/`now`，CAS 使用库里的 `row.attempt`，不接收也不比对调用方声明的 attempt。`runNode` 的 `p.attempt` 只在后续 started 迁移与 report 里使用。
- 复现：对一个当前 attempt=1 的 queued 节点，用同一个 `nodeRunId` 从旧调用方（自认为 attempt=0）发 lease 请求；租约仍会按库里的 attempt=1 领取。随后旧调用方的 started 迁移会因 attempt 不符被拒，但租约已经被领走。
- 影响：错代调用方可以短暂占住租约，增加无谓重试与诊断噪声；写权限仍由后续 CAS 与状态机拦住，未升级为 P1。

### P2-5 traceBindingGate 只绑 exitCode/stdoutHash，不绑 tool/commandHash

- 位置：`src/service/commands/apply-report.ts:303-311`、`src/service/commands/apply-report.ts:314-323`、`src/core/policy.ts` 的 `ALLOWED_EVIDENCE_FIELDS`
- 现象：done 收口时系统证据门只要求 `source==='run_tool'` 且 `exitCode===0`；traceBindingGate 只 SELECT `exit_code, stdout_hash`，再按这两值匹配。报告里的 tool 名与 `commandHash` 不参与绑定，`tool_executions` 里已有的 `tool`/`command_hash` 列也不读。
- 复现：在同一 `node_run_id`+`attempt` 下，直接写一条 `tool_executions`（exit_code=0、stdout_hash 与报告一致，但 tool/command_hash 指向另一个命令），再提交 done 报告；收口会通过。经 HTTP 报告入口无法插入这条行，故利用面要求账本写权限或执行器被替换。
- 影响：证据只能证明「这个 attempt 有一条成功 stdout 哈希相同的执行」，不能证明「它是被授权的那个工具与命令」；与 G2-10/G-12 声称的强绑定有差距。属 P2，因为正常生产路径由 runNode 写入且 commandHash 已在执行期校验。

### P2-6 checkPreviousChain 只比字符串，不重算前序门

- 位置：`scripts/gate-check.ts:472-486`
- 现象：前序门链校验从 HEAD 的 G1.md 里抓第一个 64 位 `artifact_hash` 字符串，与 G2 的 `previous_artifact_hash` 比对；不重算 G1 的 artifact，也不对 G1 跑 `verifyGateRecord`。
- 复现：在 clone 中改 G1.md 正文里的 `artifact_hash` 文本为另一个 64 位值，把 G2 的 `previous_artifact_hash` 同步改成该值，重签 G2；gate-check 仍会通过，因为两边字符串相等。
- 影响：前序门链是「文本相等」而非「内容哈希相等」，前序门被改后只要同步改链值就能接受；当前 G1 仍有人工评审与 G1 自身门检查兜底，属 P2。

### P2-7 WorkflowCatalog 先写内存后写库，别名冲突会留脏缓存

- 位置：`src/service/workflows.ts:104-115`、`src/service/workflows.ts:43-70`
- 现象：`remember` 先在 `this.defs.set(key, def)`，再对纯数字键做别名（`01`→`1`）；别名冲突抛 `WORKFLOW_VERSION_IMMUTABLE` 时，主键已留在内存。`load` 也是先 `remember`，再在 `src/service/workflows.ts:61-68` 做 DB INSERT。
- 复现：同一进程先 load 版本 `1`，再 load 内容不同的版本 `01`；第一次抛别名冲突，第二次重试 `01` 会命中 existing 分支直接返回，不再落库；重启后该版本消失。
- 影响：内存里可能短暂存在未被数据库确认的定义，跨重启不变量在别名冲突边界上不成立；正常版本号路径不受影响。

### P2-8 跨重启证据是同进程关开服务，不是独立 OS 进程重启

- 位置：`docs/gates/evidence/G2/ev-g2-15.md`、`src/index.ts:53-54`、`src/service/workflows.ts:29-41`
- 现象：ev-g2-15 在同一测试进程里连续 `openServiceOrchestra` 两次、第一次 close 后第二次对同一库 hydrate；没有 spawn 独立 node 进程，也没有真正的进程退出后重开。
- 复现：读 ev-g2-15 的步骤与 `tests/integration/g2.spec.ts` 对应用例；两次服务共享模块级状态与同一进程的 SQLite 连接生命周期。
- 影响：数据库落库与 hydrate 逻辑被覆盖，但进程级缓存、文件锁释放、崩溃恢复等真实重启面没有被覆盖；证据强度低于「跨重启」字面承诺。

### P2-9 审计结论解析把行首「结果：」也当结论，普通结果段会被判为多结论

- 位置：`scripts/gate-check.ts:514`、`scripts/gate-check.ts:518`
- 现象：strict 正则把 `结果` 与 `结论`/`判定` 并列；报告里若用「结果：sign-gate exit 0…」总结运行结果，解析器会把它当第二条结论（或在没有前一条结论时按尾巴不合规处理），`auditConclusionOf` 返回 null。
- 复现：本报告初稿在「模拟重签」段用「结果：sign-gate exit 0…」，`auditConclusionOf` 返回 null，sign-gate 报「审计报告里找不到唯一结论行」；把该行改为「重签运行：…」后返回 pass，重签通过。
- 影响：合法的审计报告可能因为常用词「结果：」被误判，签门被无谓阻塞；只会更严，不会放行错误结论，属 P2。

## 门记录与 HEAD 字节核查

### 结构

- G2.md 共 507 行（HEAD LF 字节 24292；工作树 CRLF 24799，LF 归一后相同）。
- 19 项必过项全部 `result=pass` 且有 evidence_ids，清单与 `scripts/gate-check.ts` 的 `GATE_SPECS.G2` 完全一致（`docs/gates/G2.md:27-45`）。
- 19 份证据与证据表一一对应（`docs/gates/G2.md:68-88`）；正文证据表 19 行与 evidence-index 块 19 条全部一致，无换绑、无缺行。
- 11 条不变量 I1–I11 与正文表、invariants 块一致。
- 19 份证据按 HEAD 字节 LF 归一重算 sha256，19/19 与记录一致，mismatch=[]。
- 候选清单 58 个文件；`candidate_hash` 与 `change_scope_hash` 均可重算，但记录值不符（见下表）。

### 八个记录哈希

| 锚 | 记录值 | HEAD 重算值 | 结果 |
| --- | --- | --- | --- |
| artifact_hash | `b5615b8b5725c5b2df88b9231b13885635940ef7db9f7fe802bc162c651c7a0a` | `ea3dff4caa8de38d5336388e32eb4af4867998308a28a6b010d180d8d85c291a` | 不符 |
| body_hash | `ef21bb456813786ab878abae2824a873f6e7d470e257d2bcadfb9eb73282dfd3` | `8a446dab790678971a9b88141fc1fd030b538df33fad5a4f8b56421c32530dbe` | 不符 |
| evidence_index_hash | `bcaaaa3e85d1dea69d323c9a03040f0bc7586445d5d833169b3768ac487b6347` | `106e1c362e7d4312e647580a99b3cfc01eb604546af9fd42167af4bbce6b8fd0` | 不符 |
| invariants_hash | `77708d4b54f29a676481b6c2755a241171c2cfab1231ef6e621f184fc68cedd5` | `925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304` | 不符 |
| candidate_hash | `f11d0fb8751ce561df6d24379ad083f12c4bc60c866f87ec7f523858e32c0af8` | `ac99a78a906c2a3af79f3890465b1814ba731b9f98d0cc6da164a44467c79ac1` | 不符 |
| change_scope_hash | `33a82c417c33b950fe40f332f398018a29eebf5f2ed1242bb3772064f9626927` | `ad5ab7dc937e1aa71016c6d5a65fc1cbaba3f20ff82e306c7fde388d2bc4609f` | 不符 |
| previous_artifact_hash | `1ce80f6080fb2271ae7ba958c61127962951cb49262b75e5b1d8e7d161b82084` | G1 HEAD 的 artifact_hash 同值 | 相符 |
| audit_report_sha256 | 64 个 0 | `c9cef2e419c91711524e9784900050d988200253d76f3a2fb4e31dfd3872da63`（round4 报告 LF 归一） | 不符 |

### 直接跑 gate-check 的结果

命令：`D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md`

退出码：1。首条输出：

```text
门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != c9cef2e419c91711…
```

按检查顺序，后续还会命中：

1. `docs/gates/G2.md:310-311` 把审计锚指向 `docs/audits/S2-independent-audit-round4.md`、`audit_round=4`，不是本轮；round4 报告在 HEAD 存在，LF sha 为 `c9cef2e4…`，但记录 sha 全零。
2. 即使补上 sha，round4 报告没有唯一 pass/fail 结论行：它在 `:85`、`:99`、`:112` 有三条「判定：…」行，在 `:134` 是「结论：五条遗留都可以移交 S3，…」，`auditConclusionOf` 返回 null，checkAuditAnchor 会抛「审计报告里找不到唯一结论行」。
3. 六个自锚（artifact/body/evidence-index/invariants/candidate/change-scope）与 HEAD 重算值全部不符，`verifyGateRecord` 即使允许脏树也会在这些检查上失败。

这些是「记录尚未按第十二轮重签」的待签事实：G2.md 最后修改提交 f7ebe69 与 c4f7b35 都没有重签，round4 报告本身也不是 pass/fail 格式。它们不构成 S2 机制的新 P0/P1，但意味着当前 HEAD 的 G2 门不能直接放行。

## 证据复跑

复跑方法：在 clone 内以 `cwd=clone` 运行主仓库脚本 `D:/NodeJs/node.exe --no-warnings D:/aboutAI/dsh-orchestra/scripts/fault-inject.ts --case ev-g2-NN`，脚本把证据写到 clone 的 `docs/gates/evidence/G2/`，再与主仓库 HEAD 文件逐字节比较。

| 证据 | 退出码 | 字节 | sha256 | 与 HEAD 原始字节 |
| --- | --- | --- | --- | --- |
| ev-g2-12 | 0 | 2811 | `5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe` | 相同 |
| ev-g2-13 | 0 | 567 | `a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc` | 相同 |
| ev-g2-14 | 0 | 2260 | `865fd0b7bca1193256dedee74f30a18c8903f5e0fa4c2d119cad6e41b50ada02` | 相同 |
| ev-g2-15 | 0 | 2434 | `db1c814f8935e1779440aec12c5a229a6ec8636a0e6ccc7f86d2ac834e037038` | 相同 |

四项耗时约 0.3 / 0.2 / 3.3 / 0.3 秒；复跑结果稳定，未出现时间戳、随机 id 或临时路径漂移。四项与 G2.md:81-84 的记录一致，也与本次 HEAD 文件逐字节相同。

## 第十一轮 P1-1 关闭围栏攻击复现

### 攻击输入

在 clone 中写 `docs/audits/S2-independent-audit-round12.md`，内容 7 行：

```js
const lines = [
  "# 第十二轮围栏攻击复现",
  "",
  "```md",
  "```js",
  "结论：pass",
  "```",
  "结论：fail",
  "",
];
```

（上面为展示用嵌套；实际文件是标题、空行、三反引号围栏与两条结论行，sha256=`da1db3261dad94294fcf43b67db752bc9932e1112b2be1a87c26fc5ba19024f8`。）

把 G2 artifact 的 `audit_round` 改为 12、`audit_report` 指向该文件、`audit_report_sha256` 改为上述 sha，`conclusion` 保持 pass，提交为攻击提交 `21a283f`。

### 解析器对照

- 修复前解析器（从 `git show e022af3^:scripts/gate-check.ts` 取，追加导出）：对同一文件返回 `OLD_PARSER=pass`。过程是第 2 行（三个反引号 + `js`）被当成关闭围栏，第 3 行 `结论：pass` 成为真实结论，第 4 行又开围栏把第 5 行 `结论：fail` 藏住。
- 当前解析器：返回 `NEW_PARSER=fail`。关闭围栏只认同字符、长度不小于开启、且 marker 后仅空白；带 `js` info string 的行被视为围栏内容。

### 门检查与签名

命令与结果：

```text
node --no-warnings scripts/gate-check.ts docs/gates/G2.md
exit 1
门检查失败：审计报告结论与门记录结论不符：报告=fail，门记录=pass

node --no-warnings scripts/sign-gate.ts docs/gates/G2.md
exit 1
同一错误，栈：checkAuditAnchor scripts/gate-check.ts:611 → verifyGateRecord scripts/gate-check.ts:694 → sign-gate.ts:81
```

签前与签后 G2.md 的 sha256 都是 `619e73ba92b6715ea1ebeeded8c60038caf29aacf32c25b8662bec0c93aa4aaa`，sign-gate 没有写盘；`git status` 干净。这表明第十一轮 P1-1 修复生效，sign-gate 与 gate-check 都不能把这份「真实 fail 被读成 pass」的报告放行。回归用例在 `tests/gate-check.spec.ts:305-307`。

## 模拟重签

在 clone 中 reset 到 `e022af3`，写入本报告，把 G2 artifact 的 `audit_round` 改为 12、`audit_report` 指向本报告、`audit_report_sha256` 改为本报告 LF sha，提交；随后跑 `sign-gate` 并提交签后的 G2.md，再跑 `gate-check`。

首次模拟时报告里有一行「结果：…」被解析器当成第二条结论，sign-gate 报「审计报告里找不到唯一结论行」；把该行改成「重签运行：…」后通过。最终重签运行：sign-gate exit 0，gate-check exit 0，签后工作树干净。该结果说明：当前 gate-check 的 exit 1 只来自待签记录，不是 S2 机制缺陷；用本报告重签后门可以闭合。

## 已核项与命令输出摘要

- `node node_modules/typescript/bin/tsc --noEmit`：exit 0，无输出。
- `node node_modules/vitest/vitest.mjs run`：Test Files 1 failed | 31 passed (32)；Tests 10 failed | 289 passed (299)；Duration 4.29s。10 条失败全在 `tests/gate-check.spec.ts`，原因是 G1.md 的 `audit_report_sha256` 仍为 64 个 0，典型报错「审计报告 sha256 与记录不符：0000000000000000… != 50ba1b13cdf1b84d…」。与第十一轮记录一致，属 G1 待签，不是 S2 机制回归。
- G1 直接 gate-check：exit 1，同一 sha 全零原因；G1_EXIT=1。
- G2 证据 19/19 哈希与正文表一致；19 项必过与固定清单一致；11 条不变量一致。
- ev-g2-12/13/14/15 复跑 exit 0、字节相同、sha256 相同。
- 围栏攻击：旧解析器 pass、新解析器 fail；gate-check 与 sign-gate 均 exit 1，G2 字节未变。
- 跨重启：ev-g2-15 在同进程内 close/open 两次，同库 hydrate，绑定 hash 为 `206681cf…`；改写同版本返回 409 `WORKFLOW_VERSION_IMMUTABLE`；在飞节点仍 verifying；弱证据 done 返回 `verification_too_weak`。
- 单写者：ev-g2-13 第二次 `openServiceOrchestra` 取锁返回 `ELOCKED`；bumpEpoch 后旧连接写返回 `STALE_GENERATION`。
- 工具白名单：ev-g2-12 三版定义下请求体自带 policy 均不生效，派发分别返回 `FORBIDDEN` / `TOOL_NOT_REGISTERED`，`lease_acquired` 为 0，节点保持 queued。
- 证据客户端自述面：HTTP `/v1/node-runs/report` 收报告，但 done 必须过 `evaluateEvidence`、`systemEvidenceGate`、`evaluatePassConditions`、`traceBindingGate`；请求体不能覆盖 policy。未发现仅凭请求体即可落 done 的路径。缺口是 P2-5 的 tool/commandHash 未绑定。
- applyReport 绕过面：`policyForReport` 从 `runs.workflow_version` 与 `workflow_definition_hash` 取策略，请求体与函数参数都带不进 policy；版本定义哈希不符抛 `WORKFLOW_VERSION_IMMUTABLE`；未发现请求级绕过。
- 租约丢失后继续写：runNode 在续租失败置 `leaseState.lost`、写 `lease_lost`，动作后与 done 前都检查；`applyReport` 收口前 `assertLeaseValid`。在飞工具可能仍向旧 attempt 写 `tool_executions`，但无法推进节点状态；未发现租约丢失后仍能落 done 的路径。
- 门记录换绑：`checkEvidenceMap` 固定 id→文件映射；正文证据表、evidence-index、inventories 与 artifact 交叉校验；审计报告限定 `docs/audits/` 且绑定 LF sha；未发现换绑路径。缺口是 P2-6 的前序门链只比字符串。

## 未核项

- 真实独立 OS 进程重启（spawn 新 node 进程后重开同一 SQLite 库）；本轮只覆盖同进程 close/open。
- SQLite 文件级篡改、备份恢复、磁盘损坏下的账本行为。
- 真实网络分区、时钟服务跳变、长时间（分钟级）动作在真实调度器下的表现。
- 多写者并发压力下的锁与 epoch 竞态；本轮依赖 ev-g2-13 的单次复现。
- G1 的独立门审计与重签；本轮只确认 G1 未签导致 10 条测试失败，未审 G1 内容。
- S3 的动作超时配置接线、租约释放时机与 tool/commandHash 绑定加固。
