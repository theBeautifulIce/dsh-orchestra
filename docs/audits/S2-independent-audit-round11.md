# S2 独立审计（第十一轮）

- 审计对象：D:/aboutAI/dsh-orchestra，分支 main，HEAD 153353a0c21ec6c64844e1d16365fdb39aa35653
- 审计时间：2026-11-13（Asia/Shanghai）
- 审计范围：S2/G2 门记录 docs/gates/G2.md、scripts/gate-check.ts、scripts/sign-gate.ts、设计规格 `11.3、G2 相关源码与测试、19 份证据、S2 第十轮点名的 P2
- 审计方式：只读；需要攻击验证的步骤在 %TEMP% 的临时 clone 或临时目录完成，结束后清理；未签门、未提交、未 push
- 工作区：审计开始与结束时 git status --porcelain 均为空；主仓库只新增本报告

## 一、结论摘要

本轮最终判断为不通过。门记录本身仍是待签状态，待签事实与门缺陷分开如下。

- P0：0
- P1：1，P1-1 围栏关闭误判，含嵌套 info string 的报告可把真实 fail 解析成 pass，并已在临时 clone 端到端签过门
- P2：10，P2-1 至 P2-10，见第五节

待签事实不计入门缺陷：G2 当前 artifact、body、evidence_index、invariants、candidate、change_scope、audit_report_sha256 八个值与 HEAD 实算全部不符；audit_round=4 指向的 round4 报告解析为 null，因此当前记录即使只补 sha 也不能签成 pass。G1 也未签，全量 vitest 的 10 红由 G1 的 audit_report_sha256=0 引起，这些都不作为 S2 判 fail 的依据。本轮 fail 只由 P1-1 支撑。

## 二、审计对象与工作区状态

命令与输出：

```text
> git rev-parse HEAD
153353a0c21ec6c64844e1d16365fdb39aa35653
> git status --porcelain
（空）
> git rev-parse --abbrev-ref HEAD
main
```

最近提交：153353a fix(gate): close pass caveats and document conclusion contract；0919589 fix(gate): treat blocking caveats after pass as no conclusion；f7ebe69 Harden gate conclusion parsing and body table coverage；f572984 docs(audit): 归档 S1 第三轮与 S2 第七轮独立审计报告；d3ab0a4；c4f7b35 S2 第六轮整改；f68e836 fix(s2): close round5 audit P0/P1 findings and add G2-12..14 evidence；644af53 docs: 记录重签后的门哈希与提交链。HEAD 与任务要求一致。

读过的对象：docs/gates/G2.md（507 行）、scripts/gate-check.ts、scripts/sign-gate.ts、docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md `11.3（:955-987）、src/service/commands/apply-report.ts、src/service/commands/lease.ts、src/executor/run-node.ts、src/service/workflows.ts、src/service/server.ts、src/core/report.ts、src/index.ts、tests/gate-check.spec.ts、tests/apply-report.spec.ts、tests/workflows.spec.ts、tests/lease.spec.ts、tests/runtime.spec.ts、scripts/fault-inject.ts。

## 三、逐项核对

### 3.1 门记录字段与治理

| 项 | 记录值 | 核对 | 结果 |
| --- | --- | --- | --- |
| gate | G2 | 与 gate-check GATE_SPECS.G2 一致 | 通过 |
| schema_version | 1 | 正整数 | 通过 |
| gate_run_id | null | 允许 null | 通过 |
| conclusion | pass | 字段值合法；权威性受 P1-1 影响 | 记录自洽，机制有缺陷 |
| run_terminal | not_applicable | 允许值 | 通过 |
| failed_items | [] | 空数组 | 通过 |
| producer | human | 治理规则 | 通过 |
| approver | human:啸春 | human: 前缀 | 通过 |
| approved_at | 2026-11-13T05:54:00.000Z | ISO 时间 | 通过 |
| exceptions | 3 条 | type/status/note/rollback 合法 | 通过 |

### 3.2 19 项必过清单

正文表 docs/gates/G2.md:27-45、artifact 的 items、GATE_SPECS.G2.items 三处顺序与内容逐字一致；每项 status=pass、evidence 非空，evidenceMap 与固定映射一致。

| 编号 | 内容 | 证据 | 结果 |
| --- | --- | --- | --- |
| G2-01 | 单节点 queued 到终态一条路径（走生产装配） | ev-g2-01 | 通过 |
| G2-02 | 重复上报只落一次 | ev-g2-02 | 通过 |
| G2-03 | 租约过期迟到上报被拒 | ev-g2-03 | 通过 |
| G2-04 | 取消后不产生新 attempt | ev-g2-04 | 通过 |
| G2-05 | 终态必带证据 | ev-g2-05, ev-g2-10 | 通过 |
| G2-06 | 无裸 blocked（没裁决卡不许卡住） | ev-g2-06 | 通过 |
| G2-07 | S2 加载 parallel 被拒 | ev-g2-07 | 通过 |
| G-03 | 同一 report_id 上报两次只落一次 | ev-g2-g03 | 通过 |
| G-04 | 租约到期后原执行器迟到上报被拒 | ev-g2-g04 | 通过 |
| G-05 | 工具执行中取消只立一次围栏 | ev-g2-g05 | 通过 |
| G-07 | 墙钟跳变不误判截止 | ev-g2-g07, ev-g2-09 | 通过 |
| G2-08 | 工具失败不许落完成（系统判失败并挂凭据） | ev-g2-08 | 通过 |
| G2-09 | 判定时限只认 boot_id 与单调纳秒（墙钟跳变不误判） | ev-g2-09 | 通过 |
| G2-10 | 报告入口系统级证据门（弱证据与伪造痕迹一律拒） | ev-g2-10 | 通过 |
| G2-11 | 反复重投同一 report_id 不许把账本刷膨胀 | ev-g2-11 | 通过 |
| G2-12 | 工具授权只认 workflow 定义，请求体策略不参与 | ev-g2-12 | 通过 |
| G2-13 | 单写者锁与 epoch 围栏：第二写者拿不到锁，旧 epoch 写不进 | ev-g2-13 | 通过 |
| G2-14 | 长动作靠心跳续租，扫描不误判过期 | ev-g2-14 | 通过 |
| G2-15 | 同一工作流版本跨重启不可改写，在飞 run 的判定条件不跟着变 | ev-g2-15 | 通过 |

### 3.3 19 份证据

以下文件均在 docs/gates/evidence/G2/ 下；sha256 由 git show HEAD 的字节按 LF 归一后重算。19 份全部与 artifact 的 evidence-index 和正文证据表一致，TOTAL=19，BAD=0。

| 证据 | 文件 | sha256 | 结果 |
| --- | --- | --- | --- |
| ev-g2-01 | ev-g2-01.md | f10efac98f2d0d91bfc83d0e1bacb3c2a5111c11bc7223de6464a057a744d88b | 匹配 |
| ev-g2-02 | ev-g2-02.md | 346af5813c653ba967af948a74aba27201b9ac906f13e54f4e588f8b18ea70e1 | 匹配 |
| ev-g2-03 | ev-g2-03.md | 784e44b65d6642404d0f7664bda64e48337292101a102f1403aef4caee4a6db5 | 匹配 |
| ev-g2-04 | ev-g2-04.md | 65946e22958ef8764415d2af693245f8dc8da33e585ba4cee094e36f56ac71a6 | 匹配 |
| ev-g2-05 | ev-g2-05.md | 74c0a94705a24494d435c995317d6a29f40e089a992e9c75afa5e0735b35adb1 | 匹配 |
| ev-g2-06 | ev-g2-06.md | cef5cf3de601985af216cb935334414d56ff9f3f296871f709332f9e16b1f91c | 匹配 |
| ev-g2-07 | ev-g2-07.md | 607471ff9e475eaa30e3a83376b4c93aed12b6e209b7bd2601678737cf934a34 | 匹配 |
| ev-g2-08 | ev-g2-08.md | 54e4b0e8415abd5bc65ce885c407245d91ec099390e64a2b3188c89cb1144cbf | 匹配 |
| ev-g2-09 | ev-g2-09.md | f43b50982b67843db87e1cae9b36b0048eca372d9734904d3e1090fc97b8d8b2 | 匹配 |
| ev-g2-10 | ev-g2-10.md | 76b458edf0f4f24a4408be4bf429b4a9025399aa002c52b6c50676a5f4f45e8b | 匹配 |
| ev-g2-11 | ev-g2-11.md | 05c1c8ea1ab5796a24adc50931a3a1b3d6d085af56975b47f6c9a113f7f233c7 | 匹配 |
| ev-g2-12 | ev-g2-12.md | 5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe | 匹配 |
| ev-g2-13 | ev-g2-13.md | a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc | 匹配 |
| ev-g2-14 | ev-g2-14.md | 865fd0b7bca1193256dedee74f30a18c8903f5e0fa4c2d119cad6e41b50ada02 | 匹配 |
| ev-g2-15 | ev-g2-15.md | db1c814f8935e1779440aec12c5a229a6ec8636a0e6ccc7f86d2ac834e037038 | 匹配 |
| ev-g2-g03 | ev-g2-g03.md | 514f9754fda67b8e1522d086fc6079301e00bd0185f9cca6dddec502c412ab70 | 匹配 |
| ev-g2-g04 | ev-g2-g04.md | fb68366d1292bb80e9ae59febf7fd5ad1e28e580ecfc2883e99b18edb2e6eca9 | 匹配 |
| ev-g2-g05 | ev-g2-g05.md | 2f7da35abe9c1484143b85a0226da8a0ebd095994c8e2aa492dd88f726b51904 | 匹配 |
| ev-g2-g07 | ev-g2-g07.md | 8898db1323c191c8ca0acd51d2dde5458355b7b25f3b0c96f868ec38d8ef730e | 匹配 |

### 3.4 11 项不变量

正文 docs/gates/G2.md:115-127 与 artifact 的 invariants JSON 11 项 id、内容、证据映射一致；invariants_hash 因正文/证据变更与记录不符（见 3.7）。

| 编号 | 内容 | 证据 | 结果 |
| --- | --- | --- | --- |
| I1 | 一个 node_run 最多一个终态 | ev-g2-02, ev-g2-03 | 通过 |
| I2 | 账本只追加 | ev-g2-11 | 通过 |
| I3 | 所有迁移带 CAS | ev-g2-04, ev-g2-13 | 通过 |
| I4 | 每个终态有对应证据 | ev-g2-05, ev-g2-10 | 通过 |
| I5 | 卡住必须挂裁决卡 | ev-g2-06 | 通过 |
| I6 | 判定时限只认 boot_id 与单调纳秒 | ev-g2-09, ev-g2-g07 | 通过 |
| I7 | 同一 report_id 同类事件只留一条 | ev-g2-02, ev-g2-11, ev-g2-g03 | 通过 |
| I8 | 工具授权只认 workflow 定义 | ev-g2-12 | 通过 |
| I9 | 单写者锁与 epoch 围栏 | ev-g2-13 | 通过 |
| I10 | 长动作靠心跳续租 | ev-g2-14 | 通过 |
| I11 | 工作流定义跨重启落库 | ev-g2-15 | 通过 |

### 3.5 例外表

正文 docs/gates/G2.md:100-104 与 artifact 的 exceptions 3 条完全一致。

| 码 | 类型 | HTTP | 说明 | 结果 |
| --- | --- | --- | --- | --- |
| LEASE_EXPIRED | proposed | 409 | S2 提案码，待规格 17.1 收录；出码时 details.proposed=true | 一致 |
| BRIDGE_ACK_LAG | proposed | 409 | S2 提案码，待规格 17.1 收录；dispose 前确认位落后时出，出码带 details.proposed=true；S2 生产路径未接桥调用，本轮不可复现，留 S3（F-06） | 一致 |
| DECISION_REQUIRED | proposed | 422 | S2 提案码，待规格 17.1 收录；阻塞没挂凭据时出，依据见 S2 计划「口径补充（第二轮审计后）」第 1 节 | 一致 |

### 3.6 审计锚与 previous 链

- audit_round=4；audit_report=docs/audits/S2-independent-audit-round4.md；audit_report_sha256=64 个 0。
- round4 报告在 HEAD 存在，LF 归一实算 c9cef2e419c91711524e9784900050d988200253d76f3a2fb4e31dfd3872da63，与记录的 0 不符。
- 用 HEAD 的 auditConclusionOf 解析 round4 报告，结果为 null（不是 pass，也不是 fail）；因此即使把 sha 补上，checkAuditAnchor 仍会拒绝当前记录。
- previous_artifact_hash=1ce80f6080fb2271ae7ba958c61127962951cb49262b75e5b1d8e7d161b82084，与 G1 HEAD 文本里的 artifact_hash 字符串相等；但 G1 自身 audit_report_sha256=0，G1 artifact 实算 f54dcae873f34a988ca7d6fbf5bd0b29ce68558acfd4007f0b477e49b65cc4ec，与锚不同。
- checkPreviousChain（scripts/gate-check.ts:472-486）只比较 G1 文本中的 artifact_hash 字符串，不 verifyGateRecord(G1)；临时 clone 已实测 G1_EXIT=1 时 G2_EXIT=0。见 P2-4。

### 3.7 聚合哈希

用独立 Node 脚本导入 src/core/canonical.ts 的 canonicalJson 与 sha256Hex，读 git show HEAD 的字节，证据按 LF 归一；candidate 取 4f3ada7..HEAD，排除 docs/gates、docs/audits、docs/reviews、handoff.md，共 58 个文件。

| 哈希 | 记录值 | HEAD 实算 | 结果 |
| --- | --- | --- | --- |
| candidate_hash | f11d0fb8751ce561df6d24379ad083f12c4bc60c866f87ec7f523858e32c0af8 | ae615d84011056f2c53464b2c117b3f9f9035c7f61d16136860f6acd4fea16ab | 不符 |
| change_scope_hash | 33a82c417c33b950fe40f332f398018a29eebf5f2ed1242bb3772064f9626927 | ad5ab7dc937e1aa71016c6d5a65fc1cbaba3f20ff82e306c7fde388d2bc4609f | 不符 |
| evidence_index_hash | bcaaaa3e85d1dea69d323c9a03040f0bc7586445d5d833169b3768ac487b6347 | 106e1c362e7d4312e647580a99b3cfc01eb604546af9fd42167af4bbce6b8fd0 | 不符 |
| invariants_hash | 77708d4b54f29a676481b6c2755a241171c2cfab1231ef6e621f184fc68cedd5 | 925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304 | 不符 |
| artifact_hash | b5615b8b5725c5b2df88b9231b13885635940ef7db9f7fe802bc162c651c7a0a | ea3dff4caa8de38d5336388e32eb4af4867998308a28a6b010d180d8d85c291a | 不符 |
| body_hash | ef21bb456813786ab878abae2824a873f6e7d470e257d2bcadfb9eb73282dfd3 | 8a446dab790678971a9b88141fc1fd030b538df33fad5a4f8b56421c32530dbe | 不符 |
| audit_report_sha256 | 0000000000000000000000000000000000000000000000000000000000000000 | c9cef2e419c91711524e9784900050d988200253d76f3a2fb4e31dfd3872da63 | 不符 |

### 3.8 正文与 JSON 一致性

- 正文必过项表 19 行与 GATE_SPECS.G2.items 逐字一致，包括内容列固定文本和证据列映射。
- 正文证据表 19 行与 artifact 的 evidence-index 一致，无重复 id、无未引用证据、无固定映射缺失。
- 正文例外表 3 条与 artifact.exceptions 一致。
- 正文不变量表 I1..I11 与 artifact.invariants 一致。
- 正文 git 历史锚、artifact_hash、body_hash 三个锚都在；但 body_hash 与 artifact_hash 均因 f7ebe69 改正文、f68e836/c4f7b35 加证据而未重签，与 HEAD 实算不符。

### 3.9 待签事实（与门缺陷分开）

以下为待签事实，不是 P1-1：

- G2.md 在 f7ebe69 只改了一句正文（把“动作总时限读 execution.action_timeout_ms”改为“默认 120 秒，配置接线留 S3”），未重签；f68e836 加 G2-12..14、c4f7b35 加 G2-15，也未重签。因此 artifact/body/evidence_index/invariants/candidate/change_scope 六个值与 HEAD 实算不符。
- audit_report_sha256 记录为 64 个 0；round4 报告真实 sha c9cef2e4…；audit_round=4 指向 round4，而 round4 报告当前解析为 null。
- 当前 gate-check G2 exit 1：门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != c9cef2e419c91711…。
- 当前 gate-check G1 exit 1：… 0000000000000000… != 50ba1b13cdf1b84d…。
- sign-gate 只把报告 HEAD 字节的 sha 写回 artifact（scripts/sign-gate.ts:64-68），不改 audit_round 与 audit_report 指向；所以直接跑 sign-gate 仍会被 checkAuditAnchor 的结论检查拒绝。要签本轮，必须人工先把 audit_round 改为 11、audit_report 改为 docs/audits/S2-independent-audit-round11.md，再签；并且应先签 G1，再签 G2，否则 G1 重签会改 artifact_hash，断掉 G2 的 previous 链。
- 当前记录处于未签状态，不能作为“已通过的 G2”使用；这是待签事实，不是 P1-1 之外的机制缺陷。

## 四、证据复跑

在 %TEMP% 的独立 cwd 下调用主仓库的 scripts/fault-inject.ts，证据写入临时 cwd，不碰主仓库。命令：

```powershell
$base = Join-Path $env:TEMP 'g2-r11-repro'
foreach ($case in 'ev-g2-12','ev-g2-13','ev-g2-14','ev-g2-15') {
  $cwd = Join-Path $base $case
  New-Item -ItemType Directory -Force -Path $cwd | Out-Null
  Push-Location $cwd
  & 'D:/NodeJs/node.exe' --no-warnings 'D:/aboutAI/dsh-orchestra/scripts/fault-inject.ts' --case $case
  Pop-Location
  $p = Join-Path $cwd "docs/gates/evidence/G2/$case.md"
  $bytes = (Get-Item $p).Length
  $hash = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()
  "$case $bytes $hash"
}
```

真实输出：

| 证据 | 字节 | sha256 | 期望 | 结果 |
| --- | --- | --- | --- | --- |
| ev-g2-12 | 2811 | 5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe | 5c2d543f… | 一致 |
| ev-g2-13 | 567 | a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc | a5260693… | 一致 |
| ev-g2-14 | 2260 | 865fd0b7bca1193256dedee74f30a18c8903f5e0fa4c2d119cad6e41b50ada02 | 865fd0b7… | 一致 |
| ev-g2-15 | 2434 | db1c814f8935e1779440aec12c5a229a6ec8636a0e6ccc7f86d2ac834e037038 | db1c814f… | 一致 |

四例均 exit 0。证据内容复核：

- ev-g2-12：三定义 allow ro.echo / deny ro.echo / allow ro.ghost，请求体带更宽 toolPolicy；派发结果 HTTP 200/200/200，错误码 FORBIDDEN/FORBIDDEN/TOOL_NOT_REGISTERED；lease_acquired 条数=0；节点均 queued。
- ev-g2-13：首个写者 epoch=1；第二把锁 ELOCKED；外部 bump epoch 到 2；旧连接写 STALE_GENERATION；释放后账本为空。
- ev-g2-14：3 秒动作、2 秒租约、500ms 续租；2.5 秒扫描 lease_expired=0，节点 started；最终节点 done、revision=9；lease_expires_at 仍 2026-11-13T03:00:04.000Z。
- ev-g2-15：同库重启，首次加载 HTTP=200、verifying HTTP=200；绑定 hash 206681cf51becb770748c437ebd0e9133ed831e691f76684c70567a5b4545256；重启后定义表仍该 hash；同版本改写 HTTP=409 WORKFLOW_VERSION_IMMUTABLE；节点 verifying、attempt=1、revision=3；弱证据 done accepted=false、reason=verification_too_weak、registry_state=rejected。

## 五、P0、P1、P2 清单

### P0（0）

未发现可复现的 P0。

### P1-1 围栏关闭误判可把 fail 报告签成 pass

- 位置：scripts/gate-check.ts:498-503。
- 根因：行首匹配 3 个以上反引号或波浪线后，只要围栏活动、字符相同、marker 长度不小于开启长度就关闭；没有要求关闭 marker 后只能有空白。CommonMark 规定关闭围栏不得带 info string，代码块内的 3 反引号加 js 是块内文本，但当前实现把它当关闭围栏。
- 最小输入（JSON 数组，按换行连接）：["```md","```js","结论：pass","```","结论：fail"]。前四行是一个代码块，第五行是真实结论。

- 语义：第 1 行开反引号围栏；第 2 行是块内文本；第 3 行是块内示例；第 4 行关闭；第 5 行是真实结论 fail。当前 auditConclusionOf 返回 pass：第 2 行提前关闭，第 3 行 pass 被当成真实结论，第 4 行又开新围栏把第 5 行藏掉。
- 端到端复现（临时 clone %TEMP%/g2-r11-clone，HEAD 153353a；主仓库未动）：
  1. 只把 docs/gates/G2.md 的 audit_round 改为 11、audit_report 改为 docs/audits/S2-independent-audit-round11.md；
  2. 新建该报告，内容就是上面五行，真实结论是 fail；
  3. commit 06a7e4a；
  4. D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G2.md => exit 0，输出 重签完成：证据 19 份，candidate=ae615d840110…，artifact_hash=3169931a1c26…，body_hash=8dca1d7eea58…，改动文件 58 个；
  5. commit 8e78e74；
  6. D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md => gate G2 通过（19 项必过、19 份证据哈希复核，artifact_hash=3169931a1c26… body_hash=8dca1d7eea58…），G2_EXIT=0；
  7. 同一 clone 的 G1：gate G1 => G1_EXIT=1（0000… != 50ba1b13cdf1b84d…）。
- 定性：P1，门完整性假通过。当前真实 G2 尚未签，所以不是 P0；但下一轮若按当前机制签，报告作者只要在正文放一个带 info string 的示例块，就能让真实 fail 被读成 pass。
- 修法：活动围栏关闭只接受 marker 后仅空白（或直接按 CommonMark 的关闭围栏规则实现）；补 3 反引号内含 js/ts 的回归用例。
- 相关边界：blockquote 内的围栏不被识别，输入 > 三反引号 md、> 结论：pass、> 三反引号、结论：fail 返回 null，偏保守；4 空格缩进代码块在带真实 fail 时返回 fail，不构成 false pass。

### P2-1 action_timeout 配置未接生产

- src/index.ts:87-98 的 runNode 装配只传 nodeRunId、nodeId、attempt、input、outputSchema、tools、now、ownerEpoch、leaseTtlMs、leaseRenewIntervalMs，没有 actionTimeoutMs。
- src/executor/run-node.ts:144 仍用 p.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS（120000）。
- docs/gates/G2.md:17 已注明“配置接线留 S3”，但 :55 定值表仍写 execution.action_timeout_ms=120000，读者会以为配置已生效。
- 复现：读上述行；grep actionTimeoutMs 只见 run-node 的参数类型与默认值，生产装配无传入。

### P2-2 lease_lost 与 action_timeout 缺执行期回归

- 实现存在：src/executor/run-node.ts:77-91 续租失败记 lease_lost；:154-159、:223-227 动作总时限收口。
- 测试只有 tests/apply-report.spec.ts:90 的 LEASE_EXPIRED（上报时租约已过期）、tests/lease.spec.ts:61、tests/integration/g2.spec.ts:97/203；没有 executor 续租失败 lease_lost 和动作总时限 action_timeout 的端到端用例。
- 复现：在 tests 中 grep lease_lost、action_timeout，执行期用例为空。

### P2-3 跨重启测试仍是同库 hydrate

- tests/workflows.spec.ts:45-55 用同一个 freshLedger() 的 db 新建第二个 WorkflowCatalog 再 hydrate；没有关闭并重开数据库，也没有新进程。
- 因此 ev-g2-15 的“跨重启”证据只在同库同连接上验证，不能排除进程级缓存/句柄问题。

### P2-4 前序链只比字符串

- scripts/gate-check.ts:472-486 的 checkPreviousChain 只从 G1 的 HEAD 文本正则取 artifact_hash，与 G2.previous_artifact_hash 比较字符串；不调用 verifyGateRecord(G1)，不校验 G1 的 artifact、证据、审计锚。
- 临时 clone 已实测 G1_EXIT=1 时 G2_EXIT=0，说明 G2 可在 G1 未签时通过。

### P2-5 remember 别名先写后查

- src/service/workflows.ts:104-115：先 this.defs.set(key, def)，再检查数字别名是否撞上另一份定义；冲突时抛 WORKFLOW_VERSION_IMMUTABLE，但 key 已经留在内存，后续 get 可能读到这份未通过校验的定义。
- 复现：构造 key='01' 与已存在的 '1' 不同定义，调用 remember，捕获异常后再按 '01' 取定义。

### P2-6 结论解析仍有误杀

- 以下输入在 HEAD 上返回 null（偏保守，不会 false pass，但会让合法报告无法签）：

| 输入（行首内容） | 返回 |
| --- | --- |
| 结论：pass，无 P0/P1，P2 九条已列 | null |
| 结论：pass，P0=0 / P1=0 | null |
| 结论：pass — 重大 0 | null |
| 结论：pass（P2 遗留 10 条，已列） | null |
| pass 之后引用上一轮的 > 结论：fail | null |
| 结论：fail — 但整体通过 | null |

- round10 的漏杀已闭合：单独的建议行不再被当结论，带重大 caveat 的 pass 返回 null；本轮唯一 false pass 是 P1-1 的围栏嵌套。
- 复现：用临时脚本 import scripts/gate-check.ts 的 auditConclusionOf，逐个输入上述字符串。

### P2-7 done 后不释放租约

- src/service/commands/lease.ts:101-112 定义了 releaseLease，但 src 全仓只有定义处和 what 字符串出现，src/executor/run-node.ts 正常收口没有调用。
- ev-g2-14 最终节点 done、revision=9，但 lease_expires_at 仍 2026-11-13T03:00:04.000Z，说明租约靠 TTL 自然过期，不是 done 时释放。
- 复现：grep releaseLease；读 ev-g2-14 的最终节点行。

### P2-8 acquireLease 不校验调用方 attempt

- src/service/commands/lease.ts:34-83 的 AcquireLeaseParams 没有 attempt，CAS 用账本行的 attempt；src/executor/run-node.ts:56-72 acquire 前不校验 p.attempt。
- 错误 attempt 可以先拿到租约，直到 src/service/commands/apply-report.ts:200-204 收口时才以 attempt_mismatch 拒绝，并把节点落到 blocked_post。
- 复现：用错误 attempt 调用 runNode/acquire，观察租约已建立、收口才拒。

### P2-9 traceBindingGate 不校 tool 与 commandHash

- src/service/commands/apply-report.ts:314-323：SELECT exit_code, stdout_hash FROM tool_executions WHERE node_run_id = ? AND attempt = ?，然后按 exit_code+stdout_hash some 匹配。
- 不取也不比 tool、command_hash；空 stdoutHash 可与 null 行匹配。因此证据只能证明“这个 node_run/attempt 有一条退出码与 stdout 哈希相同的工具痕迹”，不能证明报告里的工具就是被授权执行的那个工具。
- tool_executions 写入在 src/executor/run-node.ts:191-205，行里本来有 tool、command_hash，但门没有用。

### P2-10 证据仍由客户端提交，服务端只做事后模糊对账

- src/service/server.ts:205-213 的 /v1/node-runs/report 把客户端 report 原样交给 commands.report，只有 x-orchestra-secret 认证，没有“执行器专用”标记或一次性凭证。
- src/service/commands/apply-report.ts:228-250 直接信任 report.evidence；:303-311 的 systemEvidenceGate 只检查 ev.source === 'run_tool' 与 exitCode，source 是客户端字符串。
- src/core/report.ts:2-10 的 ReportEvidence 只有 source、exitCode、stdoutHash、stderrHash、commandHash 等客户端字段，没有签名、nonce、tool_execution_id。
- 当前形态是“客户端自报 evidence + 服务端按 exit_code/stdout_hash 事后模糊对账”；因为仍要求账本存在成功工具行，未升级为 P1，但“证据由服务端签发、Agent 只能引用”的实现缺口成立，与 P2-9 一起修。

## 六、测试与类型检查

类型检查：

```text
> D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit
exit 0，无输出
```

全量测试：

```text
> D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run --reporter=dot
Test Files  1 failed | 31 passed (32)
     Tests  10 failed | 288 passed (298)
  Duration  4.82s
exit 1
```

10 红全部在 tests/gate-check.spec.ts，首因是 G1 门记录 audit_report_sha256=0：

```text
门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：
0000000000000000… != 50ba1b13cdf1b84d…
```

红项：G1 门记录通过；改 candidate_hash 锚点不动；证据文件哈希；evidence_index_hash；candidate_hash 别处值；正文必过项内容列；正文证据表哈希；正文不变量说明；证据文件固定映射；body_hash 自锚。其余 9 红都是首因导致期望的 artifact/证据/正文表/body 错误没有机会出现。

tests/gate-check.spec.ts 单独跑：10 failed | 28 passed (38)；7 条结论解析用例全绿，但没有“关闭围栏带 info string”的用例，所以 P1-1 未被现有测试覆盖。

G1 未签与这 10 红是待签事实，不作为 S2 判 fail 的依据；本轮 fail 依据是 P1-1。

## 七、G2 额外检查

- 证据签发：没有服务端签发的证据对象；没有签名、nonce、tool_execution_id；evidence 的 source 是客户端字段。Agent 仍可直接构造 report；server 只凭共享 secret 认证。
- applyReport：仍然信任客户端 report。applyReport 在判定前直接使用 report.evidence；systemEvidenceGate 只检查客户端自报的 source 与 exitCode；真正的服务端绑定只有 traceBindingGate，而它只按 exit_code/stdout_hash 模糊匹配。
- tool_executions 与证据门：账本行由服务端 runNode 写入，包含 tool、command_hash，但证据门不读这两列；与 P2-9 一致，账本与证据门只对上了退出码和 stdout 哈希，没有对上工具身份。
- 本项结论：P2-10 与 P2-9 是同一信任边界的两面；修复方向是让服务端在工具执行时签发不可伪造的证据引用，applyReport 只接受引用并按 tool_execution_id 取回内容，同时校验 tool 与 command_hash。

## 八、通过条件与整改

- 先修 P1-1：围栏关闭必须要求 marker 后仅空白；补 3 反引号内含 js/ts 的用例，并补“真实 fail 在块外、块内示例 pass”的端到端 gate-check 用例。
- 再修 P2：P2-1 接 actionTimeoutMs；P2-2 补 lease_lost/action_timeout 执行期用例；P2-3 改成真正关闭并重开数据库；P2-4 previous 链调用 verifyGateRecord(G1)；P2-5 先查后写或回滚；P2-6 放宽合法清零说明；P2-7 done 时 releaseLease；P2-8 acquire 带 attempt 并校验；P2-9 绑定 tool/commandHash；P2-10 服务端签发证据引用。
- 修完后按当前 HEAD 重新出 round12 报告，人工把 G2 的 audit_round 改为 12、audit_report 指向 round12；先签 G1，再签 G2；签后重跑 gate-check G2 与全量 vitest。
- 当前记录不可直接签：audit_round=4 指向 round4，round4 解析 null；sign-gate 不改轮次与报告指向，直接签仍会被 checkAuditAnchor 拒绝。

## 九、最终审计意见

本轮为只读审计，未签门、未提交、未 push。G2 的 19 项必过、19 份证据、11 项不变量在内容与哈希层面均与 HEAD 一致；P1-1 是门机制缺陷，能造成假通过，故本轮不通过。待签事实已与门缺陷分开记录，修复并按 round12 重签后可再审。

结论：fail
