# S2 门（G2）第三轮独立审计报告

- 审计对象：D:\aboutAI\dsh-orchestra，HEAD = db9b6dde4d37a368682d98c6616cbb802c46675b，工作树干净
- 审计日期：2026-11-13
- 审计人：独立审计员（第三轮，不采信 docs/audits/S2-round2-response.md 的自证结论；自证只当线索，每条都在源码与运行结果里复验）
- 纪律：本轮只写本文件；未改 src/、tests/、scripts/、docs/gates/、docs/superpowers/；未 commit / push；探针与临时 clone 都在系统临时目录

---

## 1. 结论

**G2 建议不通过**（按「审计没通过就不能往后走」，S3 九节点与状态机现在不能开）。

- 致命项 **3** 条（R3-01 / R3-02 / R3-03），重大项 **9** 条（R3-04…R3-12）。
- 11 项必过：8 项 pass、2 项 fail（G2-05、G-07）、2 项存疑（G2-02、G-03）。
- 门记录本身的哈希链是自洽的、可独立重算；门检查脚本也拦得住大部分篡改。但**门记录声称的口径与代码实际行为不符**：本轮新增的「多工具证据」「verify 计时」「HTTP 报告入口」三处改动各自带来一条可把节点错误收成 done 的路径，其中两条直接击穿规格 4.4 / 4.7 的硬契约。

| 编号 | 必过项 | 结论 | 依据 |
| --- | --- | --- | --- |
| G2-01 | 单节点 queued 到终态一条路径（走生产装配） | pass（附注） | 路径真实存在且可复现：ev-g2-01 从 POST /v1/workflows/load 跑到 report_applied；但该路径的**终态判定**可被绕过（R3-01、R3-03） |
| G2-02 | 重复上报只落一次 | **存疑** | 状态副作用只落一次（registry applied→replayed、report_applied 仅 1 条）；但 report_replayed 事件可被无限追加（R3-04） |
| G2-03 | 租约过期迟到上报被拒 | pass | assertLeaseValid 抛 LEASE_EXPIRED，事务回滚、registry 不留记录（apply-report.ts:183） |
| G2-04 | 取消后不产生新 attempt | pass | queued / leased 取消 → superseded，不产生新 attempt（cancel.ts:40-53） |
| G2-05 | 终态必带证据 | **fail** | 无 evidence 字段被拒（ev-g2-05）；但**弱证据 / 空证据经生产 HTTP 报告入口可直达终态 done**（R3-03） |
| G2-06 | 无裸 blocked（没裁决卡不许卡住） | pass | 裸 blocked_post → decision_required 拒收、节点状态不动；带 reason 才收（ev-g2-06 复现一致） |
| G2-07 | S2 加载 parallel 被拒 | pass | assertDefinitionAllowed 阶段闸拒 parallel / subworkflow（ev-g2-07 复现一致） |
| G-03 | 同一 report_id 上报两次只落一次 | **存疑** | 同 G2-02（R3-04） |
| G-04 | 租约到期后原执行器迟到上报被拒 | pass | 与 G2-03 同源，注入证据可重跑出同字节 |
| G-05 | 工具执行中取消只立一次围栏 | pass | 围栏只立一次，armed 后取消不改状态，sweep 到点 fence_revoked 无 STALE_GENERATION |
| G-07 | 墙钟跳变不误判截止 | **fail** | **本批新增的 verify 截止用纯墙钟判定**：墙钟前跳 10 分钟即误判 verify 超时并把节点误转 blocked_post（R3-02） |

---

## 2. 致命项

### R3-01 工具失败（exitCode≠0）仍可把节点收成 done —— 违反 S2 计划「口径补充」第 4 节与规格 4.7

- **审计主张**：S2 计划「口径补充（第二轮审计后）」第 4 节（docs/superpowers/plans/2026-11-12-dsh-orchestra-s2-agent-loop.md:2892）明写：「任一工具 exitCode ≠ 0 即中断后续工具，**节点不得落 done**，转 blocked_post 并记一条 verify_human」；规格 4.7（设计稿 v1.3 行 391）同口径「证据不足时转 verify_human，不许『没证据也算过』」。当前实现只做了「中断后续工具」，没做「不得落 done」。
- **复验结果：不成立（缺陷存在）**。
  - 现象：模板 pass_conditions=[]（或与 exitCode 无关的条件）时，工具返回 exitCode=1，runNode 不抛错，final_status='done'，node_runs.status='done'，report_registry 记 applied，事件序列 [lease_acquired, status_changed, tool_started, status_changed, status_changed, report_applied] —— 账本上是一次**成功的**终态。
  - 两个工具 [ro.a, ro.b]、exitCodes=[1,0]：第二个工具确实没跑（break 生效），但 final_status 仍是 done。
  - 根因一：src/executor/run-node.ts:109 只 break，不判失败；是否落 done 完全交给模板条件。
  - 根因二：src/core/policy.ts:81-105 evaluatePassConditions([]) 返回 {pass:true}（空条件即通过）。
  - 根因三：src/service/workflows.ts:43-48 policyFor 只回 passConditions，模板不写 exitCode 条件就没有任何兜底。
  - **为什么现有证据与测试没兜住**：G2.md:45 自己的「本批定值」把「run_tool 为强、tool_result 为弱」定成规格 4.7 口径，但所有模板（含 ev-g2-01 的定义）都手写了 pass_conditions=[{path:'evidence.exitCode',op:'eq',value:0}]，把这条硬要求**外包给了模板作者**；tests/runtime.spec.ts:64 那条「exitCode 不是 0 就不许 done」也是靠同一条模板条件成立，不是靠系统保证。全仓没有任何用例覆盖「失败工具 + 空/无关 pass_conditions」。
  - 附带：evidence_trace 只存在于内存里的 report 对象（run-node.ts:78、102-108、134），落库只存 evidence_digest（apply-report.ts:240-245），**账本里查不到失败工具的痕迹**。
- **证据位置**：src/executor/run-node.ts:109、src/core/policy.ts:81-105、src/service/workflows.ts:43-48、src/service/commands/apply-report.ts:190-200、docs/superpowers/plans/2026-11-12-dsh-orchestra-s2-agent-loop.md:2892、规格 v1.3 行 391。
- **复现命令**：

```
cd C:\Users\ASUS\AppData\Local\Temp\g2probe
node probe.ts            # P1A: pass_conditions=[] + 工具 exitCode=1 → final_status=done
```

  手工等价：加载 pass_conditions: [] 的定义 → 建 run → dispatch → 让工具返回非 0 退出码 → 看 node_runs.status。
- **整改口径**：失败工具必须由**系统**判失败（runNode 扫 trace 里有 exitCode≠0 就 markBlocked('tool_execution_failed')，落 blocked_post + verify_human），不能靠模板条件；并把 trace 落进账本事件。

### R3-02 verify 截止用纯墙钟判定 —— 违反规格 4.4（行 171）与门 G-07 口径（行 1066），且会丢弃真实结果

- **审计主张**：规格 4.4 行 171：「所有截止时间成对存：展示用的墙钟字段加 boot_id 与 monotonic_ns。**截止判定只读 boot_id + monotonic_ns；墙钟只用于展示**……时钟不确定或漂移超过 2 秒，置 timer_uncertain 转 blocked，**不自动判超时**」；门 G-07 口径（规格行 1066）就是「墙钟前后跳十分钟并覆盖重启｜截止按 boot_id + monotonic_ns，不因墙钟跳变误判」。本批新增的 verify 截止违反这条。
- **复验结果：不成立（缺陷存在）**。
  - 现象：节点在 verifying、verify_deadline_at='2026-11-13T03:02:00.000Z'（预算 120s）。sweep(now=03:00:10) → 仍 verifying；sweep(now=03:10:01)（墙钟前跳 10 分钟，实际只过了 10 秒预算）→ 节点被转 status='blocked_post'，事件 [status_changed, verify_human(reason='verify_timeout')]。
  - **二次伤害**：随后执行器提交合法的 done 上报 → {accepted:false, reason:'status_mismatch', registry_state:'rejected'}，**真实执行结果被丢弃**，节点永久卡在 blocked_post。
  - 根因：src/service/sweep.ts:37-58 用 Date.parse(row.verify_deadline_at) > Date.parse(params.now) 纯墙钟比较；src/service/commands/node-state.ts:57-61 只写墙钟字段。
  - **schema 层根因**：src/infra/sqlite/migrations/002_s2_agent_loop.sql:35 只有 verify_deadline_at、:37 只有 verify_remaining_ns，**没有 verify_deadline_boot_id / verify_deadline_monotonic_ns 对**（对比 :27、:29 的 deadline_boot_id / deadline_monotonic_ns），所以规格行 171 的「成对存」在本批做不到。verify_remaining_ns 是死列（src 无写入）；规格行 330 / 338 / 342 要求的「按 remaining 重挂」「暂停并冻结 remaining」「跨 boot 换算」全部没有实现。
  - **门自己的 G-07 被这批改动破坏**：ev-g2-g07 只测 src/core/clock.ts 的 MonotonicClock（动作截止），没有覆盖本批新增的 verify 钟；而门必过项 G-07 写的是「墙钟跳变不误判截止」，不限动作截止。
- **证据位置**：src/service/sweep.ts:37-58、src/service/commands/node-state.ts:57-61、src/infra/sqlite/migrations/002_s2_agent_loop.sql:35,37、规格 v1.3 行 168-171、330、333、338、342、1066；门记录 docs/gates/G2.md:31。
- **复现命令**：

```
cd C:\Users\ASUS\AppData\Local\Temp\g2probe
node probe.ts            # P4: verifying + 墙钟前跳 → 被误转 blocked_post，后续 done 上报 status_mismatch
```

- **整改口径**：verify 截止必须按 boot_id + monotonic_ns 判定并成对存（迁移加两列）；墙钟跳变/不确定 → timer_uncertain 转 blocked，不自动判超时；跨 boot 按 remaining 重挂。**在此之前，门必过项 G-07 应当判 fail，不能靠 ev-g2-g07 过关。**

### R3-03 生产 HTTP 报告入口可接受弱证据 / 空证据，节点直达终态 done —— 证据强度校验是死代码

- **审计主张**：门记录自己的「本批定值」（G2.md:45）写着「证据强弱来源标记：run_tool 为强、tool_result 为弱｜规格 4.7」；规格 17.1 列有 VERIFICATION_TOO_WEAK（行 1309）与 EVIDENCE_SOURCE_UNAVAILABLE（行 1321）。既然弱证据被定义为弱，它就不该直接判终态通过；规格 4.7 行 391 要求证据不足转 verify_human。
- **复验结果：不成立（缺陷存在）**。
  - 现象（真实 startServer + fetch 打生产路由）：POST /v1/node-runs/report 上报 {status:'done', evidence:{source:'tool_result', exitCode:0, stdoutHash:'deadbeef'}} → **HTTP 200 {accepted:true, next_status:'done', registry_state:'applied'}**，节点 status='done'，事件 [lease_acquired, status_changed(verifying→done), report_applied{evidence_digest:'3fd86e78…'}]。
  - 更宽：evidence:{}（连 source 都不填）→ 同样 accepted:true → done。
  - 无 evidence 字段才被拒（reason='evidence_missing'，节点留在 verifying），与 ev-g2-05 一致 —— **也就是说 G2-05 只证了「没有 evidence 字段」这一半，没有证「弱证据/假证据被拒」**。
  - 根因一：src/core/policy.ts:18-45 evaluateEvidence 只在 requiredHashes.length>0 时才查证据强度；而 src/service/workflows.ts:43-48 policyFor **永远只回 passConditions**，requiredHashes 恒为空 → 「有 evidence 字段即过证据门」。requiredHashes 在全仓只有单测直接传参用过（tests/apply-report.spec.ts:96），生产路径是死分支。
  - 根因二：src/service/server.ts:193-202 的报告路由把客户端 report 原样透传给 applyReport，不校验 evidence.source、不校验证据与本次 attempt 的工具执行是否对得上。
  - 根因三：账本 report_applied 只存 evidence_digest（apply-report.ts:240-245），**没有工具执行痕迹**（谁执行、执行了什么、退出码多少），所以伪造出来的 done 在账本里与真实 done 不可区分 —— 这让 G2-01（唯一一条真实跑通 done 的证据）失去可证伪性。
- **证据位置**：src/core/policy.ts:18-45、src/service/workflows.ts:43-48、src/service/server.ts:193-202、src/service/commands/apply-report.ts:190-200,240-245、G2.md:45、规格 v1.3 行 391、1309、1321。
- **复现命令**：

```
cd C:\Users\ASUS\AppData\Local\Temp\g2probe
node probe3.ts           # P6: source=tool_result + stdoutHash=deadbeef → accepted/done
                           # P9: evidence={} → accepted/done
```

- **整改口径**：报告入口必须判证据来源与强度（弱来源 → verification_too_weak / 转 verify_human，不许直落 done）；或把报告入口降级为**内部执行器专用**（由服务端从执行器结果生成 report，不接受客户端自造 evidence），并在门记录里写明信任边界。

---

## 3. 重大项

### R3-04 report_replayed 事件无上限（N-06 只修一半）

- **现象**：同一 report_id 连投 4 次 → report_replayed 追加 **4 条**（report_rejected 只有 1 条），registry state 在 rejected ↔ replayed 之间来回翻，report_seq 始终为 1。
- **根因**：去重只写在 state==='replayed' 分支（apply-report.ts:112-126）；rejected → replay_after_reject → 又被拒 的循环每次都追加一条事件（:144-149）。
- **规格冲突**：规格 4.2（行 302-305）registry 状态枚举 rejected / replayed / applied / stale 与事件语义是「rejected→replayed→applied 各一次」。
- **证据位置**：src/service/commands/apply-report.ts:47-78、112-149；规格 v1.3 行 302-305。
- **复现命令**：cd C:\Users\ASUS\AppData\Local\Temp\g2probe && node probe.ts（P5 段）。

### R3-05 门记录 producer 与规格 11.3 冲突，且门检查只对 G1 强制 human

- **现象**：G2.md 的 GateArtifact 里 producer='agent:七七'；规格 11.3 行 981 明写「G1 到 G5 的主 artifact producer=human（这几道门由人按同一张卷子手工跑）」，行 1192 同口径。
- **复验**：scripts/gate-check.ts:294 只对 G1 强制 producer==='human'，G2 不拦；实测把 producer 改成 agent:张三 并重签 → **门检查通过**（artifact_hash=6c746091f63c…）。
- **证据位置**：docs/gates/G2.md GateArtifact 块、scripts/gate-check.ts:294、规格 v1.3 行 981、1192。
- **复现命令**：临时 clone 里改 artifact producer → node scripts/sign-gate.ts → node scripts/gate-check.ts docs/gates/G2.md。

### R3-06 门检查不校验正文「证据文件与哈希」表，也不校验正文「例外」表

- **现象**：把 G2.md 正文哈希表的 sha256 全列改成 000… → **门检查仍 PASS**；把正文例外表 LEASE_EXPIRED 的 HTTP 从 409 改成 200、或清空说明列 → **仍 PASS**。被校验的只有 evidence-index 的 JSON 块与 artifact 的 exceptions。
- **后果**：人读的那张表可以与被签的那份 artifact 各说一套；门记录正文正是评审人看的东西。
- **证据位置**：scripts/gate-check.ts:186-217（只核对正文表第 1/2/3/4 列与 artifact 交叉，未核对第 5 列哈希、未核对例外表）、docs/gates/G2.md:54-66、76-82。
- **复现命令**：临时 clone 里改 G2.md 正文哈希列 / 例外表 → node scripts/gate-check.ts docs/gates/G2.md。

### R3-07 门检查不拦工作树里的脏文件（含门记录正文与证据）

- **现象**：工作树里改 docs/gates/G2.md 正文（不提交）→ 门检查 **PASS**（DIRTY_IGNORES 含 docs/gates、docs/audits、handoff.md）。
- **说明**：证据字节是安全的（只认 HEAD），但**门记录正文不是**：评审人打开工作树看到的正文，可能根本不是被签的那一版。
- **证据位置**：scripts/gate-check.ts:102-111、scripts/gate-check.ts:257-316（assertClean 排除项）。
- **复现命令**：临时 clone 里改 G2.md 正文不 commit → node scripts/gate-check.ts docs/gates/G2.md。

### R3-08 重签即可改 producer / 换绑证据与必过项 —— 门记录无防重签机制

- **现象**：把 G2-01 的证据从 ev-g2-01 改绑成 ev-g2-02（artifact 与正文表一起改）后重签 → **PASS**（artifact_hash=6816ef194727…）。门检查只验「证据集合与 item 对应」的自洽，不验「这份证据真的支撑这条必过项」。
- **根因**：scripts/gate-check.ts:257-316 只有 artifact_hash 自锚点，没有签名密钥、没有前序 artifact 哈希链、没有证据↔断言的语义校验。
- **证据位置**：scripts/sign-gate.ts:35-59、scripts/gate-check.ts:294-316。
- **复现命令**：临时 clone 改 artifact + 正文表 → node scripts/sign-gate.ts → node scripts/gate-check.ts docs/gates/G2.md。

### R3-09 候选清单不含「本批新增后又删除」的文件

- **现象**：在批内删掉 src/executor/run-node.ts（该文件正是本批新增）→ candidateEntries 51 条路径且**不含**它（base..HEAD 无差异），重签后仍 PASS。
- **说明**：这不是绕过（删除的文件不在最终产物里），但「候选 = 本批全部改动」的口径有洞：新增又删除的文件相当于从未出现过，改动范围哈希算不出它。
- **证据位置**：scripts/gate-check.ts:94-99、122-132。
- **复现命令**：临时 clone 删该文件 → 重签 → 看候选路径数（51 vs 基线 52）。

### R3-10 计划口径写 cancelResult 非法值 400，实现是 422

- **现象**：POST /v1/node-runs/cancel 传 cancelResult='bogus' → **422 PAYLOAD_SCHEMA_INVALID**；计划「口径补充」第 2 节（plans/2026-11-12-dsh-orchestra-s2-agent-loop.md:2881）写的是「非法值 400」。
- **判读**：规格 §17.1 里 PAYLOAD_SCHEMA_INVALID 属 422 一族，实现取 422 与规格不冲突；但与计划文字不符，属于计划没更新。
- **证据位置**：src/service/server.ts:220-224、计划 :2881。

### R3-11 门证据与断言覆盖不全（本轮新改动没被证据覆盖）

- G-07 的证据 ev-g2-g07 只覆盖动作截止（MonotonicClock），不覆盖本批新增的 verify 截止 → 必过项 G-07 实际 fail（R3-02）。
- G2-05 的证据 ev-g2-05 只覆盖「无 evidence 字段被拒」，不覆盖弱证据 / 空证据 → 必过项 G2-05 实际 fail（R3-03）。
- 不变量 **I4「每个终态有对应证据，证据不足不入完成账」** 引用的 ev-g2-07 是「parallel 被拒」证据，与该不变量无关（G2.md:98）。
- ev-g2-02 / ev-g2-03 / ev-g2-04 三份是**指向单测的说明**（没有账本片段、没有可重跑注入产物），与另外 8 份「可重跑出同字节」的证据不是一个量级；门检查只验哈希不管内容，这类证据的约束力全靠人工评审。
- **证据位置**：docs/gates/G2.md:28-31、95-99、docs/gates/evidence/G2/ev-g2-02.md 等三份。

### R3-12 例外表登记的 BRIDGE_ACK_LAG(409) 在 S2 生产路径不可复现

- **现象**：BRIDGE_ACK_LAG 的唯一抛出点是 src/executor/bridge.ts:95，而 bridge.ts **没有被 runNode / dispatcher / 任何生产装配引用**（全仓 grep 只有 bridge.ts 自身、config.ts 的阶段闸、state-machine.ts 的状态名）。即 F-06（桥 spill 未接生产路径）在本轮仍未闭合，例外表里这条码在 S2 不可达。
- **对照**：DECISION_REQUIRED 有真实抛出点（node-state.ts:43），LEASE_EXPIRED 有（lease.ts:118）。
- **证据位置**：src/executor/bridge.ts:93-97、src/service/commands/node-state.ts:43、src/service/commands/lease.ts:118、docs/gates/G2.md:80-82。

---

## 4. 旧七条 F-01…F-07 与新十一条 N-01…N-11 复验矩阵

| 编号 | 状态 | 一句话依据 |
| --- | --- | --- |
| F-01 生产装配缺失 | **已修** | src/service/runs.ts createRun、src/service/dispatcher.ts dispatchRun、POST /v1/runs、POST /v1/runs/dispatch 均存在，ev-g2-01 从 HTTP 入口一路跑到 report_applied 并可重跑出同字节；但路径通 ≠ 判定对（R3-01、R3-03） |
| F-02 门哈希失真 | **已修** | candidate / change_scope / evidence_index / invariants / artifact_hash 五个哈希用自写 JCS+sha256 独立重算，全部与记录一致；11 份证据 HEAD 字节（LF 归一）sha256 全部一致 |
| F-03 注入证据两段相同 | **已修** | 8 个注入用例在临时目录重跑，产出字节与仓库证据逐份 SHA256 相同 |
| F-04 重放不验链 | **部分修** | 同节点重放验链与队头校验生效；跨节点已由 N-05 修；但事件仍可无限追加（R3-04） |
| F-05 围栏期间仍收 done | **已修** | fence armed 时 applyReport 走 fence_armed 拒收、applyCancel 不改状态 |
| F-06 桥二次 spill 丢事件 | **未修** | src/executor/bridge.ts 至今没有接进 runNode / dispatcher；G2.md:15 自己承认留 S3（R3-12） |
| F-07 终态可被取消改写 | **已修** | 终态取消只回 already_stopped/terminal_no_out_edge 不写库 |
| N-01 裸写 blocked_post 绕 I5 | **已修** | 无凭据 → reason='decision_required' 拒收且节点状态不动；带 reason 才收并记 verify_human |
| N-02 判定失败永久 verifying | **已修（但钟错）** | 进 verifying 写 verify_deadline_at、sweep 到点转 blocked_post + verify_human；但判定是纯墙钟（R3-02） |
| N-03 多工具只留最后一份证据 | **部分修** | 每工具一条 trace 进 report.output.evidence_trace；但 trace 不落库，且失败工具仍可能落 done（R3-01） |
| N-04 围栏取消改状态 / sweep 永久 STALE_GENERATION | **已修** | armed 时三类 cancel 都不改状态；revokeFence CAS 失败返回 false 不抛，实测无 STALE_GENERATION |
| N-05 跨节点 report_id 重放 | **已修** | existing.node_run_id 不符抛 SCHEMA_VERSION_UNSUPPORTED |
| N-06 report_replayed 事件无上限 | **部分修** | 只在 state='replayed' 分支去重；rejected↔replayed 循环仍每次追加（R3-04） |
| N-07 report.attempt 不符 | **已修** | attempt_mismatch 拒收，registry 用 report.attempt |
| N-08 queued/leased 取消与非法 cancelResult | **已修** | queued/leased → superseded 不抛错；非法 cancelResult → 422（计划写 400，R3-10） |
| N-09 门检查拦不住 | **部分修** | 已能拦：证据字节、evidence-index 哈希、正文表第 2 列、approver 形式、artifact_hash 锚点、候选清单（含删除文件）、HEAD 缺证据；仍拦不住：正文哈希表、正文例外表、工作树脏文件、重签后改 producer 与换绑证据（R3-05…R3-09） |
| N-10 门证据与断言路径不符 | **部分修** | 8 份证据已改真实生产入口且可重跑同字节；但 G-07 / G2-05 未覆盖本批新面，不变量 I4 引用了无关证据，3 份仍是「指向用例的说明」（R3-11） |
| N-11 例外表漏两个码 | **已修（形式）** | 例外表已含 BRIDGE_ACK_LAG(409) / DECISION_REQUIRED(422)；但两者都没进规格 §17.1，且 BRIDGE_ACK_LAG 在生产路径不可复现（R3-12） |

---

## 5. 规格一致性核对

| 口径 | 规格 v1.3 | 当前实现 / 门记录 | 判定 |
| --- | --- | --- | --- |
| 截止时间成对存、截止判定只读 boot_id + monotonic_ns | 行 171、330、338、342、1066 | verify 截止纯墙钟；migration 无 verify_deadline_boot_id / monotonic 对 | **不一致（致命 R3-02）** |
| verifying 独立 verify_timeout 120s，到点 blocked_post + verify_human | 行 333 | 已实现，但判定口径违反行 171 | **部分不一致（致命 R3-02）** |
| 证据强弱：run_tool 强、tool_result 弱；证据不足转 verify_human | 行 391；G2.md:45 定值 | 强度判定为死代码，弱/空证据可直落 done | **不一致（致命 R3-03）** |
| 多工具：任一 exitCode≠0 不得落 done | 计划口径补充 §4（plans:2892） | 只 break 不判失败 | **不一致（致命 R3-01）** |
| registry 状态与事件各一次 | 行 302-305 | report_replayed 可无限追加 | 不一致（重大 R3-04） |
| G1–G5 producer=human | 行 981、1192 | G2.md producer=agent:七七，门检查只对 G1 强制 | 不一致（重大 R3-05） |
| 服务侧路由落点 | 规格 §6.1 是 workflow.create/open_draft/update/publish（行 528-538） | 四条新路由规格无落点；计划 :2884 自认「不实现也不声称实现 §6.1」 | 计划内自洽，规格待补（见 §7） |
| 提案码入规格 §17.1 | 行 1288-1327 无 LEASE_EXPIRED / BRIDGE_ACK_LAG / DECISION_REQUIRED | 只在门记录例外表 + 计划口径补充里登记 | 未闭合（见 §7） |
| exceptions 只作风险说明，不改结论 | 行 985 | 例外表内容不被门检查校验（R3-06） | 形式满足、实质不闭合 |

**实现者自证里说大了的地方**（docs/audits/S2-round2-response.md 只当线索，以下均由我复验）：

1. 「多工具证据按工具留痕」——只做了一半：trace 在 report 里不落库，且「任一工具失败不得落 done」这条硬要求根本没实现（R3-01）。
2. 「重复上报事件只留一条」——只覆盖 state='replayed' 一条分支，重放循环仍每次追加（R3-04）。
3. G2.md:11「终态必须有强证据」——与 G2.md:45 自己定的「tool_result 为弱」矛盾，且代码允许弱证据直达终态（R3-03）。
4. G2.md:70 复现命令里写门检查含「工作树干净」「正文表与 artifact 同源」——前者因 DIRTY_IGNORES 含 docs/gates 不成立（R3-07），后者只对正文表第 2 列成立、哈希表与例外表不成立（R3-06）。
5. G2.md:13 说第一轮七条致命「逐条改完」，G2.md:15 又说 F-06 与 §七.5 未闭合 —— **正文自相矛盾**（桥 spill 至今未接生产路径）。
6. 「门候选含删除且只认 HEAD 字节」——这两条属实（已复验），但同段的「工作树干净」不属实。

---

## 6. 门记录自身有效性

**能自洽的部分（我独立重算，未引用仓库实现）**：

- candidate_hash 087dbfef10d59678…、change_scope_hash ebbc062d6add95e1…、evidence_index_hash 4d323b02204dd791…、invariants_hash c87dc8f47a6cf4ba…、artifact_hash 锚点 6161feae63767f11… —— 五个全部与记录一致。
- 11 份证据文件按 HEAD 字节、LF 归一后 sha256，与正文表和 evidence-index 全部一致。
- node scripts/gate-check.ts docs/gates/G2.md 与 G1.md 均通过。

**篡改试探（在临时 clone 里做，仓库本体未动）**：

| 试探 | 结果 |
| --- | --- |
| 证据文件加一行 | **拦下**（点名 ev-g2-01 与实际 sha256 不符） |
| evidence-index 里 sha256 改全 0 | **拦下** |
| HEAD 里删掉证据文件 | **拦下**（证据文件不在 HEAD 里） |
| 正文表第 2 列内容改一个字 | **拦下** |
| artifact approver 改成 agent:七七 | **拦下**（approver 必须 human:<名字>） |
| 删本批文件（src/executor/run-node.ts）后重签 | **拦下**（candidate_hash 与候选不符）；重签后 PASS，说明删除文件确实进候选清单 |
| 正文「证据文件与哈希」表 sha256 列改全 0 | **放过**（R3-06） |
| 正文「例外」表 HTTP 改 200 / 说明清空 | **放过**（R3-06） |
| 工作树改门记录正文 / 证据不提交 | **放过**（R3-07；证据字节仍以 HEAD 为准） |
| 改 artifact producer 后重签 | **放过**（R3-05、R3-08） |
| 把 G2-01 的证据换绑 ev-g2-02 后重签 | **放过**（R3-08） |
| 批内新增又删除的文件 | **不进入候选**（R3-09） |

**结论**：门记录**自洽、可独立重算**；门检查能拦「字节级篡改与清单错位」，但**没有防重签机制**（无签名、无前序 artifact 链、无「证据↔断言」语义校验），正文与 artifact 可以各说一套。因此门记录自身有效性 = 「自洽但可自签」；人审仍是唯一防线。这一点不影响本次结论（结论由代码缺陷决定，不由门记录缺陷决定）。

---

## 7. 未闭合项清单（真实状态）

1. **F-06 桥 spill 未接生产路径**：**仍未闭合**。src/executor/bridge.ts 未被 runNode / dispatcher / 生产装配引用；例外表里的 BRIDGE_ACK_LAG 因此不可复现（R3-12）。G2.md:15 声明留 S3。
2. **§七.5 applyReport 的 policy 参数**：**信任面已闭合、签名未收口**。判定条件现在由服务端 catalog.policyFor 算（runtime.ts:35-54），请求体带不了；但 applyReport(tx, secret, params, policy) 签名仍收 policy 参数（apply-report.ts:81），单测可直接传任意 policy（tests/apply-report.spec.ts:96），生产上只有一个调用方 → 内部 API 残留，建议本轮一并收成「policy 由函数内部按 run 取」或至少加断言。
3. **四条新路由的规格落点**：**规格里没有**。计划口径补充 §2 自己声明「这组路由是 S2 服务装配的入口，不实现也不声称实现规格 §6.1 的 workflow 命令语义」（plans:2884）。建议在规格里补一节「S2 服务侧 HTTP 入口」，否则 S3 的语义会分叉。
4. **DECISION_REQUIRED / BRIDGE_ACK_LAG 进规格 §17.1**：**未进**。规格 §17.1（行 1288-1327）无这三个码；DECISION_REQUIRED 有计划依据（plans:2860-2867），BRIDGE_ACK_LAG 有代码抛出点（bridge.ts:95）但无生产调用点。门记录把它们标成「S2 提案码」并带 details.proposed=true 属于规格允许的临时做法，但规格行 985 说 exceptions 只作风险说明、不改结论 —— 当前实现符合这一条。
5. **本轮新增未闭合（本审计新发现）**：R3-01 工具失败落 done、R3-02 verify 纯墙钟、R3-03 弱/空证据直落 done、R3-04 重放事件无上限、R3-05…R3-09 门检查面、R3-11 证据覆盖不全、R3-12 例外码不可复现。
6. **迁移死列**：verify_remaining_ns（002:37）等列在 src 里无任何写入，规格行 330/338/342 的 remaining 重挂语义未实现 —— 与 R3-02 同源。

---

## 8. 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| cmd.exe /c "C:\Users\ASUS\AppData\Roaming\npm\pnpm.cmd" check | **exit 0**。tsc --noEmit 通过；vitest **31 个文件 / 254 条用例全过**（9.72s）；tsdown 构建成功（lib/index.js 71.66 kB、lib/index.d.ts 8.92 kB、lib/client.js） |
| node --no-warnings scripts/gate-check.ts docs/gates/G1.md | exit 0，artifact_hash=8a69f454fc5d…（13 项必过、13 份证据复核） |
| node --no-warnings scripts/gate-check.ts docs/gates/G2.md | exit 0，artifact_hash=6161feae6376…（11 项必过、11 份证据复核），与 G2.md 记录一致 |
| node --no-warnings scripts/fault-inject.ts --case {ev-g2-01,ev-g2-05,ev-g2-06,ev-g2-07,G-03,G-04,G-05,G-07}（cwd 改到临时目录，证据写临时目录，**未覆盖仓库证据**） | 8 例全部 exit 0；与仓库 docs/gates/evidence/G2/*.md 逐份 SHA256 **完全相同**（ev-g2-01 3F1E9A5B…、ev-g2-05 74C0A947…、ev-g2-06 CEF5CF3D…、ev-g2-07 607471FF…、G-03 514F9754…、G-04 FB68366D…、G-05 E288BBEC…、G-07 8898DB13…）；git status --porcelain 仍为空，HEAD 仍是 db9b6dd |
| 独立重算脚本 C:\Users\ASUS\AppData\Local\Temp\g2probe\recompute.ts（自写 JCS + sha256） | candidate / change_scope / evidence_index / invariants / artifact 五个哈希与记录**全部一致**；11 份证据 HEAD 字节 sha256 全部一致 |
| 探针 C:\Users\ASUS\AppData\Local\Temp\g2probe\probe.ts（P1–P5）、probe3.ts（P6/P8/P9，打真实 startServer + fetch） | 复现 R3-01 / R3-02 / R3-04、R3-03、N-04/N-08 等全部结论 |
| 篡改试探（临时 clone C:\Users\ASUS\AppData\Local\Temp\g2clone） | 见 §6 表；仓库本体未提交任何改动 |
| git status --porcelain（收尾） | 空（本报告为唯一新增文件；src/ tests/ scripts/ docs/gates/ docs/superpowers/ 未动） |

**未跑或跑不了的**：verify 跨 boot 那一半需要重启机器，未实测，R3-02 的跨 boot 部分只能靠规格条文判定；scripts/fault-inject.ts --case G-01/G-02/G-08/G-09/G-14/G-15 属 G1 范围，本轮未重跑。

---

## 9. 放行建议（供主控排期用）

G2 现在不能过。按依赖关系，建议按这个顺序修，每修一条都要补一条可复现证据：

1. **R3-01**（致命，代码局部）：runNode 扫 trace，命中 exitCode≠0 就 markBlocked('tool_execution_failed')；同时把 evidence_trace 落进账本事件。
2. **R3-03**（致命，代码局部）：报告入口判证据来源与强度，弱来源不许直落 done；或把入口收成服务端自产 report。
3. **R3-02**（致命，牵 schema）：verify 截止改 boot_id + monotonic_ns 成对存，墙钟只展示；不确定转 timer_uncertain。
4. **R3-04 / R3-05…R3-09 / R3-11 / R3-12**：门检查与门记录口径加固 + 证据补齐（正文哈希表与例外表交叉核对、脏文件拦截、producer 口径、证据↔断言对应）。
5. **F-06 桥 spill 与 §七.5 policy 签名**：本轮可留 S3，但要在门记录里写清「不可达码不进例外表」或明确标注为 S3 预留。

（本报告只覆盖 G2 现状；开 S3 的条件是本报告三条致命清零 + 门记录重签。）
