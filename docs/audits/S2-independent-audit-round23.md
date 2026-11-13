# dsh-orchestra G2 独立审计报告（round 23）

门：G2
候选提交：1e83391d2bd59656824fcdeb8e86c3ecb36ebe11

结论：fail

P0=4，P1=1，P2=0

## 范围与现场

- 主仓 D:/aboutAI/dsh-orchestra，HEAD 1e83391d2bd59656824fcdeb8e86c3ecb36ebe11；git status --porcelain 为空。
- 只读审计：未改主仓代码、docs/gates、已有报告，未提交、未签门；唯一写入的主仓文件是本报告。
- 临时 clone D:/aboutAI/_g2audit/clone；node_modules 用 junction 指向主仓；clone 内允许写、签门、提交审计报告。
- 主仓当前是预签态：audit_report_sha256=0000000000000000000000000000000000000000000000000000000000000000；gate-check 在审计报告 sha256 处 exit 1，按任务约定不计缺陷。
- 审计依据：AGENTS.md、S2/S3 计划、docs/gates/G2.md、scripts/gate-check.ts、scripts/sign-gate.ts、src/service/commands/apply-report.ts、src/executor/run-node.ts、src/executor/tools.ts、src/service/server.ts、src/service/sweep.ts、tests 与 19 份 G2 证据。

## 独立重算

候选范围 4f3ada7..HEAD，排除 docs/gates/G1.md、docs/gates/G2.md、docs/audits、docs/reviews、handoff.md；候选文件 88 个。哈希按 JCS canonicalJson 与 LF 归一独立计算。

| 项 | 门记录值 | 独立重算值 | 说明 |
| --- | --- | --- | --- |
| candidate_hash | f11d0fb8751ce561df6d24379ad083f12c4bc60c866f87ec7f523858e32c0af8 | c53815d1ce01f1cf654b867d86b1e041c1800ba78182726807abb12a05036206 | 预签态旧锚，重签后为独立值 |
| change_scope_hash | 33a82c417c33b950fe40f332f398018a29eebf5f2ed1242bb3772064f9626927 | b4811c33ac596c2580c7268812fa1e79fbe12ad2f9257bacdd8fb88fd5648778 | 同上 |
| evidence_index_hash | bcaaaa3e85d1dea69d323c9a03040f0bc7586445d5d833169b3768ac487b6347 | 106e1c362e7d4312e647580a99b3cfc01eb604546af9fd42167af4bbce6b8fd0 | 同上 |
| invariants_hash | 77708d4b54f29a676481b6c2755a241171c2cfab1231ef6e621f184fc68cedd5 | 925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304 | 旧锚恰为前 7 条不变量哈希；当前 11 条为独立值 |
| artifact_hash | b5615b8b5725c5b2df88b9231b13885635940ef7db9f7fe802bc162c651c7a0a | ea3dff4caa8de38d5336388e32eb4af4867998308a28a6b010d180d8d85c291a | 同上 |
| body_hash | ef21bb456813786ab878abae2824a873f6e7d470e257d2bcadfb9eb73282dfd3 | 8a446dab790678971a9b88141fc1fd030b538df33fad5a4f8b56421c32530dbe | 同上 |
| audit_report_sha256 | 0000000000000000000000000000000000000000000000000000000000000000 | c9cef2e419c91711524e9784900050d988200253d76f3a2fb4e31dfd3872da63 | 主仓预签态，gate-check 在此 exit 1，不计缺陷 |

19 份证据的 HEAD 字节按 CRLF→LF 归一后的 sha256 全部与正文证据表及 evidence-index 一致：

~~~text
ev-g2-01 f10efac98f2d0d91bfc83d0e1bacb3c2a5111c11bc7223de6464a057a744d88b
ev-g2-02 346af5813c653ba967af948a74aba27201b9ac906f13e54f4e588f8b18ea70e1
ev-g2-03 784e44b65d6642404d0f7664bda64e48337292101a102f1403aef4caee4a6db5
ev-g2-04 65946e22958ef8764415d2af693245f8dc8da33e585ba4cee094e36f56ac71a6
ev-g2-05 74c0a94705a24494d435c995317d6a29f40e089a992e9c75afa5e0735b35adb1
ev-g2-06 cef5cf3de601985af216cb935334414d56ff9f3f296871f709332f9e16b1f91c
ev-g2-07 607471ff9e475eaa30e3a83376b4c93aed12b6e209b7bd2601678737cf934a34
ev-g2-08 54e4b0e8415abd5bc65ce885c407245d91ec099390e64a2b3188c89cb1144cbf
ev-g2-09 f43b50982b67843db87e1cae9b36b0048eca372d9734904d3e1090fc97b8d8b2
ev-g2-10 76b458edf0f4f24a4408be4bf429b4a9025399aa002c52b6c50676a5f4f45e8b
ev-g2-11 05c1c8ea1ab5796a24adc50931a3a1b3d6d085af56975b47f6c9a113f7f233c7
ev-g2-12 5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe
ev-g2-13 a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc
ev-g2-14 865fd0b7bca1193256dedee74f30a18c8903f5e0fa4c2d119cad6e41b50ada02
ev-g2-15 db1c814f8935e1779440aec12c5a229a6ec8636a0e6ccc7f86d2ac834e037038
ev-g2-g03 514f9754fda67b8e1522d086fc6079301e00bd0185f9cca6dddec502c412ab70
ev-g2-g04 fb68366d1292bb80e9ae59febf7fd5ad1e28e580ecfc2883e99b18edb2e6eca9
ev-g2-g05 2f7da35abe9c1484143b85a0226da8a0ebd095994c8e2aa492dd88f726b51904
ev-g2-g07 8898db1323c191c8ca0acd51d2dde5458355b7b25f3b0c96f868ec38d8ef730e
~~~

G2-12/13/14/15 在 clone 内用 D:/NodeJs/node.exe --no-warnings scripts/fault-inject.ts --case ev-g2-12/13/14/15 复跑，四条均 exit 0；写出的证据 LF 归一 sha256 分别为 5c2d543f…、a5260693…、865fd0b7…、db1c814f…，与上表一致。

## 正文固定口径核对

- 19 项必过表：G2-01..07、G-03..05、G-07、G2-08..15；逐项 id、固定内容、result 字段、证据集合与 GATE_SPECS.G2 的固定映射一致，无缺项、无多项。
- 19 行证据表：ev-g2-01..15 与 ev-g2-g03/g04/g05/g07；id、file 路径、sha256 与 evidence-index 逐行一致，固定映射无缺项。
- 例外表 3 条：LEASE_EXPIRED 409 proposed、BRIDGE_ACK_LAG 409 proposed、DECISION_REQUIRED 422 proposed；code、type、status、note 字段齐全。
- 11 条不变量 I1..I11：statement 逐字一致；evidence_ids 排序后与固定口径逐条一致；id 集合无缺项、无多项；invariants_hash 独立重算为 925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304。

## 合法阳性对照

- clone：D:/aboutAI/_g2audit/clone；候选基准 1e83391d2bd59656824fcdeb8e86c3ecb36ebe11；clone 当前 HEAD 9a942e0591baf473a732b383b97581a6ab1ebbe3；git status --porcelain 为空。
- 干净报告写入 docs/audits/S2-independent-audit-round4.md：只有标题、门记录名、候选提交与单独一行判定；提交后签门。
- 命令与结果：
~~~text
D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G2.md
exit 0；重签完成：证据 19 份，candidate=c53815d1ce01…，artifact_hash=bdcaae6040ca…，body_hash=ec8cd15bd0c6…，改动文件 88 个
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md
exit 0；gate G2 通过（19 项必过、19 份证据哈希复核，artifact_hash=bdcaae6040ca… body_hash=ec8cd15bd0c6…）
~~~
- 签后锚点：artifact_hash=bdcaae6040ca5e6be73cb23a0cf519eb94bede41ea0b947229bc6b1242104640；body_hash=ec8cd15bd0c61266a517632d6bfd9339d8f9eaba0de81cbaf2bc535d29800c94。
- 闭合情况：当前 G2 正文、19 项固定映射、19 份证据、11 条不变量、治理字段与前序链在重签后能闭合；主仓未签，原因是预签态，不是内容不能签。以下问题均为重签后可复现的语义或解析缺陷。

## P0 发现

### P0-1 审计报告中的可见否定语句被读成肯定，sign-gate 仍 exit 0

位置：scripts/gate-check.ts:636-656（visibleFailStatement）、:658-707（auditConclusionOf）、:711-721（bodyConclusionOf）、:1427-1431（verifyGateRecord 接受正文判定）。

载荷：报告已有肯定判定行，正文末尾追加以下任一可见语句；clone 内逐例提交报告并重签。

~~~text
审计未通过
结论 - fail
结论—fail
The audit failed.
~~~

实测 exit code：sign-gate 0（4/4 均签成，signed=true）；auditConclusionOf 返回肯定值。正文注入侧，body-inject-assert.mjs 对其中 3 个正文追加返回 ACCEPT，脚本 exit 1（期望 exit 0）。

期望：auditConclusionOf 返回否定值或 null；sign-gate exit 1；verifyGateRecord 在正文判定与 artifact 不符时抛错。

影响：一份正文明确写“审计未通过”的报告可以被签成肯定门记录；门记录的完整性承诺失效。根因是 visibleFailStatement 的 FAIL_SUBJECT 只认“本报告/本次审计/…/本审计”，不认单独“审计未通过”；FAIL_VERDICT 只覆盖固定否定词表，compact 不删连接号；英文否定没有主语匹配。bodyConclusionOf 复用同一函数，所以正文注入同样漏。

### P0-2 同一 attempt 已有失败工具行，done 仍被接受

位置：src/service/commands/apply-report.ts:228（只有 status==='done' 才走证据门）、:247（traceBindingGate 调用）、:314-323（traceBindingGate 只比 exit_code 与 stdout_hash）。

载荷：

~~~text
tool_executions:
  (node_run_id=nr_ar, attempt=2, tool=ro.echo, exit_code=0, stdout_hash=h, command_hash=cmd1)
  (node_run_id=nr_ar, attempt=2, tool=ro.fail, exit_code=2, stdout_hash=h2, command_hash=cmd2)

report:
  status=done
  evidence={source:run_tool, exitCode:0, stdoutHash:h, hashes:{}}
~~~

实测 exit code：semantic-assert.mjs 1（脚本在漏洞复现时退出 1）；applyReport accepted=true，节点状态 done，report_applied=1。

期望：accepted=false，reason=工具失败原因 或 evidence_unverifiable；节点不得进入 done。

依据：docs/gates/G2.md:38（G2-08 工具失败不许落完成）、:445-446（I4 每个终态有对应证据，证据不足不入完成账）。

### P0-3 租约过期判定使用客户端 now，迟到上报可回拨

位置：src/service/commands/lease.ts:115-124（assertLeaseValid 用 Date.parse(row.lease_expires_at) <= Date.parse(now)）；src/service/server.ts:205-211（/v1/node-runs/report 把 body.now 原样 String 传入）；src/service/server.ts:197-201（renew 同样用 body.now）；src/service/commands/lease.ts:86-98（续期用 params.now）。

载荷：

~~~text
acquireLease: ttl=1000ms, now=2026-11-13T03:00:00.000Z
实际等待 1500ms
applyReport: now=2026-11-13T03:00:00.000Z（回拨到租约有效期内）
report: status=done, evidence={source:run_tool, exitCode:0, stdoutHash:h}
~~~

实测 exit code：semantic-assert.mjs 1（脚本在漏洞复现时退出 1）；applyReport accepted=true，节点状态 done，report_applied=1。

期望：accepted=false，抛 LEASE_EXPIRED；迟到上报不得推进节点。

依据：docs/gates/G2.md:29（G2-03 租约过期迟到上报被拒）。

### P0-4 证据强度只绑键名与部分字段，伪造 hashes 与 commandHash 可落 done

位置：src/core/policy.ts:33-38（requiredHashes 只用 Object.keys(ev.hashes) 比对键名，缺键才 verification_too_weak）；src/core/policy.ts:96-101（hashContains 只查键存在）；src/service/commands/apply-report.ts:317-322（traceBindingGate 只 SELECT exit_code,stdout_hash，只比 exit_code 与 stdout_hash）。

载荷：

~~~text
D: required_hashes=['artifact']，evidence.hashes={artifact:'not-a-real-hash'}
E: tool_executions.command_hash='cmd'，evidence.commandHash='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
~~~

实测 exit code：semantic-assert.mjs 1（脚本在漏洞复现时退出 1）；D、E 两个载荷均 accepted=true，节点状态 done，report_applied=1。

期望：requiredHashes 的哈希值要与可核验产物比对，commandHash 要与 trace 的 command_hash 绑定；伪造值应 accepted=false，reason=verification_too_weak 或 evidence_unverifiable。

依据：docs/gates/G2.md:40（G2-10 报告入口系统级证据门，弱证据与伪造痕迹一律拒）。

## P1 发现

### P1-1 失败/超时终态无证据也可收口

位置：src/service/commands/apply-report.ts:226-228（注释明确“失败、阻塞的回报不该被要求带通过证据”，证据门只在 done 内）；:303-309（systemEvidenceGate 也只在 done 内调用）。

载荷：

~~~text
A: status=failed，evidence 缺省
B: status=timeout，evidence 缺省
~~~

实测 exit code：semantic-assert.mjs 1（脚本在漏洞复现时退出 1）；A、B 均 accepted=true，节点状态分别为失败、超时，report_applied=1。

期望：终态必须有对应证据；缺证据应 accepted=false，reason=evidence_missing。

依据：docs/gates/G2.md:31（G2-05 终态必带证据）、:445-446（I4 每个终态有对应证据）。ev-g2-05 只覆盖 done 无证据被拒，未覆盖失败/超时。

## 审计判定解析攻击矩阵

clone 内逐例写报告、提交、重签；成功签的立即 git checkout -- docs/gates/G2.md 复位。下表为 auditConclusionOf 返回值与 sign-gate 端到端 exit code。

~~~text
类别             载荷                                                   auditConclusionOf  sign-gate exit  说明
中文否定句        审计未通过                                              pass               0              绕过：可见否定被签成肯定
中文否定句        本报告不通过                                            null               1
中文否定句        经审计，本报告结论为不通过                              null               1
中文否定句        审计结论：不通过                                        null               1
包裹型            【结论：fail】                                          null               1
包裹型            （审计结论：fail）                                      null               1
包裹型            「结论：fail」                                          null               1
包裹型            结论：**fail**                                          null               1
词内空白          结 论 ： fail                                           null               1
实体              &#32467;&#35770;&#65306;fail                             null               1
冒号变体          结论∶fail                                               null               1
冒号变体          结论ːfail                                               null               1
冒号变体          结论꞉fail                                               null               1
冒号变体          结论︓fail                                               null               1
冒号变体          结论﹕fail                                               null               1
引用块            > 结论：fail                                            null               1
引用块            >  结论：fail                                           null               1
引用块            >   结论：fail                                           null               1
引用块            >    结论：fail                                          null               1
引用块            >     结论：fail                                         pass               0              不可见：引用内缩进代码
行内代码拆词      结`论`：fail                                          null               1
setext            本报告不通过 + ===                                      null               1
表格              | 项 | 结论：fail | + 分隔行                              null               1
链接 title        [审计说明](https://example.com "结论：fail")              pass               0              不可见：title 不进渲染正文
链接定义          [x]: https://example.com "结论：fail"                    pass               0              不可见：定义不渲染
图片 alt          ![结论：fail](x.png)                                     null               1
原始 HTML         <b>结论：fail</b>                                         null               1
原始 HTML         <span title="结论：fail">x</span>                        null               1
原始 HTML         <!-- 结论：fail -->                                     pass               0              不可见：注释按设计隐藏
零宽              U+200B 插入到 结/论 之间                              null               1
连接号            结论 - fail                                             pass               0              绕过：compact 不删连接号
连接号            结论—fail                                               pass               0              绕过：compact 不删连接号
英文              The audit failed.                                       pass               0              绕过：无英文否定识别
~~~

边界说明：0-4 个空格引用块全部 null/exit 1；额外 5 空格是 CommonMark 引用内缩进代码，按“渲染后可见”口径不判否定，属于设计边界。链接 title、链接定义、HTML 注释、5 空格引用块中的文本在渲染后不可见，因此返回肯定值符合当前口径；若要求源码可见文本也不许出现否定语句，需要另立口径。上述不可见项不计缺陷。

## 门记录正文注入

clone 内读已签 G2.md，追加载荷后按 gate-check 的 bodyHash 重算并替换正文 body_hash，再调 verifyGateRecord(text,{root:clone,selfCheck:true})。

~~~text
baseline                                              ACCEPT
追加 审计未通过                                        ACCEPT  body_hash=7df21261aa00…
追加 结论 - fail                                       ACCEPT  body_hash=ef911486c710…
追加 The audit failed.                                 ACCEPT  body_hash=ca9b819de811…
追加 本报告结论为不通过                                REJECT  正文=fail，artifact=pass
追加 结论：fail                                        REJECT  正文=fail，artifact=pass
追加 结论：pass                                        REJECT  正文判定行缺失或不唯一
把正文结论行替换为 结论：                              REJECT  正文判定行缺失或不唯一
两条正式结论（pass + pass）                            REJECT  正文判定行缺失或不唯一
两条正式结论（pass + fail）                            REJECT  正文=fail，artifact=pass
正文追加 审计未通过但不重算 body_hash                  REJECT  body_hash 与正文不符
~~~

body-inject-assert.mjs 对前三项返回 ACCEPT，脚本 exit 1（期望 exit 0）。这说明正文 body_hash 自锚有效，但 bodyConclusionOf 与 auditConclusionOf 共用同一漏洞：重算 body_hash 后，可见否定语句仍被读成肯定，verifyGateRecord 接受。baseline 与两条正式判定行、空判定、正文自锚的对照均按预期拒绝。

## 语义闭环检查

| 检查点 | 结果 | 依据 |
| --- | --- | --- |
| applyReport 服务端再验证证据来源与强度 | 部分符合：只查 run_tool、exitCode、stdoutHash；不查 tool_finished、command_hash、tool 名、producedAt，不要求同 attempt 全部工具成功 | apply-report.ts:228、:303-309、:314-323；P0-2、P0-4 |
| requiredHashes 接入判定 | 部分符合：已由 WorkflowCatalog.policyFor 注入，但只查键名存在，不校验值 | policy.ts:33-38、:96-101；P0-4 |
| verify 截止用 boot_id 与单调钟 | 符合：verifyDeadline 只从 boot_id + monotonic_ns + wallClock 构造；sweep 的 pending/expired/uncertain 分支正确 | sweep.ts:47-71、:84-92；ev-g2-09、G-07 |
| uncertain 落 timer_uncertain | 符合：无锚点或无 clock、以及 clock 返回 uncertain 时都走 blockVerifying(..., 'timer_uncertain', ...) | sweep.ts:56-71；ev-g2-09 |
| 工具白名单与 deny 优先 | 符合：assertToolsAuthorized 先 deny、再 require、再 allow；策略只从 workflow 定义取 | 证据 ev-g2-12；run-node.ts 的 checkToolPolicy 路径 |
| 单写者锁与 epoch 围栏 | 符合：第二写者拿不到锁；旧 epoch 连接在事务入口被 STALE_GENERATION 拦截 | 证据 ev-g2-13；src/infra/sqlite/driver.ts 的每事务 epoch 比对 |
| 执行期租约续租 | 符合：runNode 内 setInterval 续租，失败置 lease_lost；3 秒动作、2 秒租约、500ms 续租下 2.5 秒扫描不判过期 | 证据 ev-g2-14 |
| 跨重启 WorkflowCatalog | 符合：workflow_versions hydrate、同版本不同内容抛 WORKFLOW_VERSION_IMMUTABLE，applyReport 比对 run 绑定 hash | 证据 ev-g2-15；src/service/workflows.ts |
| report_replayed 上限 | 符合：applied/replayed/rejected 三条重放路径都先查同 report_id 同类事件，存在则不再追加；ev-g2-11 四次重投只留 1 条 report_rejected + 1 条 report_replayed | apply-report.ts:138-187；ev-g2-11 |
| producer=human | 符合：checkGovernance 强制 producer==='human'，G2 artifact 为 human | gate-check.ts:1393；docs/gates/G2.md:308 |

## 复现命令与路径

主仓（只读检查；不签、不提交）：

~~~text
cd D:/aboutAI/dsh-orchestra
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md
exit 1：审计报告 sha256 与记录不符（记录 0*64，实际 c9cef2e4…），预签态预期
~~~

clone（允许写、签、提交）：

~~~text
cd D:/aboutAI/_g2audit/clone
D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G2.md
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md
~~~

攻击矩阵与正文注入：

~~~text
D:/NodeJs/node.exe --no-warnings D:/aboutAI/_g2audit/semantic-assert.mjs
exit 1：六项语义反例均 accepted=true
D:/NodeJs/node.exe --no-warnings D:/aboutAI/_g2audit/body-inject-assert.mjs
exit 1：三项正文注入返回 ACCEPT
~~~

主仓只写本报告，未 commit、未 sign。clone 内 docs/audits 的提交不进入候选范围（candidateEntries 排除 docs/audits），所以 candidate_hash 不因攻击提交改变。

## 最终计数

P0=4，P1=1，P2=0。

审计看法：候选 1e83391 的 G2 不能按当前正文的 19 项必过与 11 条不变量签为肯定；先修复 P0-1 至 P0-4 与 P1-1，再重签并复跑阳性对照。
