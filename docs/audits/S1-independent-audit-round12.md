# S1/G1 第十二轮独立审计报告

门：G1
候选提交：0788dfb23f9abc6310b1419009fb820899ce193b
结论：fail

## 审计环境与范围

- 审计对象：代码提交 0297b776220b491fab2fe4924975d718b945ce20（短号 0297b77，「Mask multiline link definitions and bind evidence into candidate scope」）。主仓库当前 HEAD 为 0788dfb23f9abc6310b1419009fb820899ce193b，比代码提交多一个只改 handoff.md 的文档提交，handoff.md 已在 G1 excludes 内。审计开始时主仓库工作树干净；审计期间另一路 S2 第十五轮整改在工作树留下未提交改动（scripts/gate-check.ts、tests/gate-check.spec.ts）与 S2 报告，不是本代理所为。本代理只新增本报告，结论按 HEAD 0788dfb 的代码判定。
- 环境：Windows；node 为 D:\NodeJs\node.exe，版本 v26.13.1；git 可用。实测在临时 clone C:/Users/ASUS/AppData/Local/Temp/s1-audit-r12 中进行，clone 自 0788dfb，签前设置 core.autocrlf=false；clone 用完已删除。
- 预签态：G1 门记录的 audit_report_sha256 仍为 64 个 0、尚未重签。按任务约定，预签态本身不计缺陷；下述 sign-gate 实测都在 clone 内以已签门记录为基准，不复用预签态。
- 复核文件：scripts/gate-check.ts、scripts/sign-gate.ts、tests/gate-check.spec.ts。攻击与阳性对照全部走真实 CLI，不用内部函数替代端到端；内部函数只用于核对结论解析结果。

## 计数

| 级别 | 数量 | 摘要 |
| --- | --- | --- |
| P0 | 0 | 无 |
| P1 | 1 | 链接引用定义的其余 CommonMark 续行形态仍可把隐藏 pass 结论送进解析，sign-gate 与 gate-check 都放行 |
| P2 | 0 | 无 |

判 fail 的依据：B1 报告可见正文明确写「不通过」，隐藏区写 pass 结论，sign-gate 退出码 0 完成签门，随后 gate-check 退出码 0 通过。门机制把渲染不可见的 pass 当成报告结论，这是阻断。

## P1-1 链接引用定义续行掩码不完整（阻断）

位置：scripts/gate-check.ts:699-728（maskAuditLinkDestinations，HEAD 0788dfb 版本；工作树里并发整改后行号有偏移）。缺口集中在 :709-725：rest 为空时只抹下一非空行，且只有再下一行以双引号、单引号或左括号开头才抹；rest 非空时只抹紧邻一行，且该行必须以引号或左括号开头。

机制：CommonMark 的 link reference definition 可以位于 blockquote 与 list item 内，目标可换行，title 可跨多行，整段不渲染。当前实现按行做局部掩码，覆盖不到多行 title 的第二行之后、引用块与列表项里的定义、以及转义方括号标签；这些被漏掉的行进入 auditTopLevelLines（scripts/gate-check.ts:571-608），normalizeAuditLine 之后成为顶层结论，auditConclusionOf（scripts/gate-check.ts:533-553）把它读成唯一结论。

### 六个变体与实测

每份报告开头都有可见句「本报告可见正文的结论为不通过。」，绑定两行齐全；隐藏区都含行首为「结论：pass」的行。表中 sign 为 sign-gate 退出码，门记录列为签门是否改写门记录字节。

| 编号 | 构造 | sign | 门记录 |
| --- | --- | --- | --- |
| B1 | 定义行带同行目标与未闭合引号 title，下一行行首是 pass 结论，再下一行收尾引号 | 0 | 被改写 |
| B2 | 定义行只有标签，目标在下一行，引号 title 从再下一行开始并跨行，pass 结论在 title 内 | 0 | 被改写 |
| B3 | 引用块内定义：首行是引用标记加标签与冒号，次行是引用标记加 pass 结论 | 0 | 被改写 |
| B4 | 列表项内定义：首行是列表标记加标签与冒号，次行缩进两格写 pass 结论 | 0 | 被改写 |
| B5 | 标签内用反斜杠转义右方括号，目标写在下一行，pass 结论再下一行 | 0 | 被改写 |
| B6 | 同行目标，下一行以左括号开始 title 且跨行，pass 结论在 title 内 | 0 | 被改写 |

B1 端到端实际输出：

- sign-gate 退出码 0：重签完成：证据 13 份，candidate=57c590555895…，artifact_hash=add910f26fdd…，body_hash=e9129e8d3897…，改动文件 115 个。
- 报告提交 7c98103，签后门记录提交 86d215e；G1 的 git blob 由 e61d9070dc1096b814bb3f4070cba6486a3980cb 变为 f6dff03b485098414193c3098e1eff2382898ebe，字节确实被改写。
- 提交签后门记录后，gate-check 退出码 0：gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=add910f26fdd… body_hash=e9129e8d3897…）。
- 攻击报告 B1 的 sha256：b64401699436468cc496cd520ecbaf0765f605b4ca4d32af64a2f2983772f75b。
- B2 到 B6 在同一驱动循环中全部退出码 0、门记录均被改写；逐条结果在 C:/Users/ASUS/AppData/Local/Temp/s1-case-results2.jsonl，每条都带 headMatchesCase=true，确认 sign-gate 读到的 HEAD 字节就是该用例。
- 渲染对照：markdown-it-py（commonmark 规则）对 B1 到 B6 的可见文本都只有「本报告可见正文的结论为不通过。」与绑定两行，看不到 pass；结果在 C:/Users/ASUS/AppData/Local/Temp/b-render.json。

期望：sign-gate 退出码 1，报错「审计报告里找不到唯一结论行，不能拿它当门记录依据」，G1 字节不变；gate-check 退出码 1。实际是 sign-gate 与 gate-check 都退出 0，属 fail-open。

### 复现命令

1. 在临时目录 clone 主仓库，签前执行 git config core.autocrlf false；把 docs/gates/G1.md 的 artifact 改成 audit_round=12、audit_report=docs/audits/S1-independent-audit-round12.md。
2. 新建该报告：头部两行分别写 G1 门绑定与候选 0788dfb 绑定（格式同本报告顶部），正文写可见句「本报告可见正文的结论为不通过。」，附注区按 B1 写三行：第一行是方括号标签、冒号、目标与未闭合双引号 title，第二行行首「结论：pass」，第三行是收尾双引号。提交。
3. 把 G1 门记录也提交，执行 D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G1.md。
4. 提交 sign-gate 改写后的门记录，执行 D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md。

B1 报告原文在 C:/Users/ASUS/AppData/Local/Temp/s1-audit-r12-cases/B1_multiline_title_inline_dest.md，B2 到 B6 在同目录；A1 到 A3、C1 到 C3、H01 到 H12、PASS_control 也在该目录。

### 并发整改只覆盖 B3 与 B5，不关闭本 P1

审计期间主仓库工作树出现另一路未提交的 S2 第十五轮掩码改动：去掉引用块前缀后再匹配、标签匹配时成对吃掉反斜杠转义。用该工作树版本的 auditConclusionOf 直测九份用例，A1 到 A3 返回 null，B3、B5 返回 null，但 B1、B2、B4、B6 仍返回 pass。多行 title 的后续行与列表项内定义没有被这次整改覆盖；即使这版改动提交，本 P1 仍然成立。直测输出存 C:/Users/ASUS/AppData/Local/Temp/s1-audit-r12-pending-parser.txt。

## 复核一：上一轮三类链接定义攻击已修住

A1 定义行只有标签、目标在下一行、pass 结论再下一行；A2 定义行只有标签、目标在下一行、引号 title 再下一行且 title 内写 pass；A3 定义行带同行目标、下一行引号 title 内写 pass。三份报告的可见句都是「不通过」。

实测三份全部 sign-gate 退出码 1、G1 字节不变，统一报错：

Error: 审计报告里找不到唯一结论行，不能拿它当门记录依据: docs/audits/S1-independent-audit-round12.md

A1 报告 sha256 为 81fcfd200bf609b8fb8967a2a7e2346bc125959e29fe9abff0959547ca6f3cdd。上一轮 P1 点名的三类形态已经落地；B1 到 B6 是掩码仍未覆盖的其余 CommonMark 续行形态，不是同一行道。

## 复核二：证据文件改动后重签已被拒绝

源码核对：GATE_SPECS.G1.excludes 在 scripts/gate-check.ts:103 只排除 docs/gates/G1.md、docs/gates/G2.md、docs/audits、docs/reviews、handoff.md；G2 在 :186 同口径。docs/gates/evidence 下已进入候选范围。checkAuditAnchor 在 scripts/gate-check.ts:950-954 对候选提交到 HEAD 的候选范围 diff 做拦截，命中时抛「审计报告的候选提交之后，候选文件又被改过，不能复用这份报告」。

实测：

- 先用 PASS_control（纯 Markdown、唯一顶层 pass 结论）签门，sign-gate 退出码 0：重签完成：证据 13 份，candidate=57c590555895…，artifact_hash=3fba9c92b5d9…，body_hash=ea893d7ee076…，改动文件 115 个。签后门记录提交 2acdf8c，G1 blob 为 565d0220c2b5c46539de686ce145079852997cf9。
- 在 docs/gates/evidence/G1/G-01.md 末尾追加一行 AUDIT-R12-EVIDENCE-TAMPER 并提交，提交 74883b3。
- 再次执行 sign-gate，退出码 1，实际错误：

Error: 审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：docs/gates/evidence/G1/G-01.md
    at checkAuditAnchor (scripts/gate-check.ts:954:11)
    at verifyGateRecord (scripts/gate-check.ts:1037:3)
    at scripts/sign-gate.ts:81:1

- 拒绝后 G1 的 git blob 仍是 565d0220c2b5c46539de686ce145079852997cf9，与签门后一致；工作树干净。
- 还原证据并提交（f97303d），gate-check 退出码 0：gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=3fba9c92b5d9… body_hash=ea893d7ee076…）。

期望与实测一致：exit 1、指名证据文件、门记录字节不变。S1 第十一轮 P2 与 S2 第十三轮 P2-10 的修复已落地。

## 复核三：阳性对照

PASS_control 报告 sha256 为 8c1e5a062f02c30d67a3f43349d00bdf2b088fd95c496bde6372bd9e12b00f0c，纯 Markdown，无原始 HTML，顶层只有一条 pass 结论，门与候选各一行。

- sign-gate 退出码 0，输出见上一节；artifact_hash 完整值 3fba9c92b5d9 开头，body_hash 完整值 ea893d7ee076 开头。
- 提交签后门记录 2acdf8c 后，gate-check 退出码 0，13 项必过、13 份证据。
- 还原证据后再次 gate-check 仍退出码 0，说明阳性对照没有被攻击残留污染。

## 复核四：此前 12 种原始 HTML 与可见性绕过

H01 到 H12 复跑上一轮矩阵：行内代码 details 闭标签、链接目标 details 闭标签、Tab 缩进、大写 DETAILS、CRLF、处理指令、DOCTYPE 内部子集、CDATA、details open、summary、div hidden、div display:none。

12 份全部 sign-gate 退出码 1、门记录字节不变，统一错误为：

Error: 审计报告里找不到唯一结论行，不能拿它当门记录依据: docs/audits/S1-independent-audit-round12.md

原始 HTML 的 fail-closed 哨兵未被本轮改动破坏；结果同样在 s1-case-results2.jsonl。

## 复核五：门名与候选绑定、不变量固定口径

- 门绑错：报告写 G2 绑定、门记录是 G1，sign-gate 退出码 1，错误「审计报告绑定的门与门记录不符：报告=G2，记录=G1」，门记录不变。
- 候选不存在：报告写 aaaa 开头的 40 位假提交，sign-gate 退出码 1，错误「审计报告的候选提交不是 HEAD 的祖先或不存在: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa」，门记录不变。
- 候选过旧：报告写 scopeBase 623939d，sign-gate 退出码 1，错误「审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：codebasemap.md」，门记录不变。这说明候选提交必须覆盖到当前 HEAD 的候选范围，旧候选不能复用。
- 不变量固定口径：把 G1 门记录里 I3 的语句两处都改成带「已篡改」后缀的版本并提交（3c37adf），sign-gate 退出码 1，错误「不变量 I3 的语句与固定口径不一致（改写或削短都要重新审计）」。sign-gate 没有写回：校验后 G1 的 git blob 为 c0d5711dacb45ee0e39a2a39e4b82fdde531bcc2，等于篡改提交里的 blob。还原后（3038110）G1 blob 回到 565d0220c2b5c46539de686ce145079852997cf9，gate-check 退出码 0。

以上四组说明门名绑定、候选祖先校验、候选范围 diff、不变量固定口径仍在生效。

## 证据与残留

- 逐用例退出码、错误原文、门记录是否改写、HEAD 是否等于用例字节：C:/Users/ASUS/AppData/Local/Temp/s1-case-results2.jsonl。
- B1 至 B6 的渲染可见文本：C:/Users/ASUS/AppData/Local/Temp/b-render.json。
- B1 签门与门检查原始输出：C:/Users/ASUS/AppData/Local/Temp/b1-sign-output.txt、b1-gatecheck-output.txt。
- 攻击报告与阳性对照原文：C:/Users/ASUS/AppData/Local/Temp/s1-audit-r12-cases。
- 临时 clone 已删除；本代理在主仓库只新增本报告，未改源码、门记录，也未提交。工作树里的 scripts/gate-check.ts 与 tests/gate-check.spec.ts 未提交改动来自并发整改，不是本代理所为。

## 结论依据

本轮要求修复的两点都实测落地：上一轮三类链接定义续行攻击已全部 exit 1，证据文件改动后重签已被拒绝并指名证据文件。但链接引用定义的掩码仍只覆盖窄形态：多行 title 的后续行、引用块与列表项内定义、转义标签都能把渲染不可见的 pass 结论送进解析，sign-gate 与 gate-check 双双放行（B1 端到端已复现）。按任务口径，有阻断就判 fail，因此本轮判 fail，计数为 P0=0、P1=1、P2=0。
