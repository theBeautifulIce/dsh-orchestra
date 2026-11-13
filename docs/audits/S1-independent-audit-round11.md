# S1/G1 第十一轮独立审计报告

门：G1
候选提交：959846215b85f3e2b56d4d5a69c271b8520f49fa
结论：fail

## 审计环境与范围

- 审计时间：2026-11-13，Windows，Node v26.13.1。
- 审计对象：G1 门机制与候选 9598462 的代码，不把预签态当缺陷。
- 主仓库 HEAD 为 53fd94ddaedfb05f905ca6a49a75fe8f4b7bc508，比候选多一个 handoff.md 提交；git diff --stat 959846215b85f3e2b56d4d5a69c271b8520f49fa..HEAD 只有 handoff.md 的 21 行新增。候选提交仍是审计对象。
- 实测在临时 clone D:/aboutAI/_audit_s1_round11/clone 中进行，签前设置 core.autocrlf=false。主仓库只新增本报告，没有修改源码、门记录，也没有提交。
- 复核源码：scripts/sign-gate.ts、scripts/gate-check.ts、tests/gate-check.spec.ts。攻击与阳性对照都走真实 sign-gate 与 gate-check，不调用内部函数代替端到端。

## 计数

| 级别 | 数量 | 摘要 |
| --- | --- | --- |
| P0 | 0 | 无 |
| P1 | 1 | 链接引用定义续行可把 pass 结论藏进渲染不可见区，门仍按 pass 签过 |
| P2 | 1 | 证据文件改动后重签仍可通过；继承 S2 第十三轮 P2-10 |

## P1-1 链接引用定义续行隐藏结论（阻断）

位置：scripts/gate-check.ts:699-704（maskAuditLinkDestinations）、scripts/gate-check.ts:811-823（stripHiddenAuditBlocks）、scripts/gate-check.ts:533-553（auditConclusionOf）、scripts/gate-check.ts:571-608（auditTopLevelLines）、scripts/gate-check.ts:903-907（结论锚点校验）。

机制：maskAuditLinkDestinations 只抹掉同一行内的链接引用定义，正则形如行首方括号标签、冒号、其后整行。CommonMark 允许链接目标写在定义的下一行，渲染器会把第一行的定义头与第二行的「结论：pass」合成一个完整的链接引用定义，两行都不显示。第一行被掩码成空白，第二行原样留在顶层行集合里，auditConclusionOf 把第二行读成唯一结论 pass。stripHiddenAuditBlocks 末尾只拒绝尖括号开头的原始 HTML，本形态不含尖括号，所以哨兵不触发。门因此把一份正文可见内容写着 fail 的报告当成 pass 签过。

复现步骤（临时 clone，基准 9598462）：

1. 新建 docs/audits/S1-g1-round11-attack-13-linkrefdef.md。第 3 行为门绑定行，第 4 行为候选绑定行；正文可见句为「检查项：fail。证据文件哈希与门记录不一致，按规范应判不通过。」；附注区第 12 行为 [x]:，第 13 行为「结论：pass」，末行为「以上引用定义仅用于排版示例。」。
2. 提交该报告。
3. 在 docs/gates/G1.md 的 artifact 里设 audit_round=11、audit_report=docs/audits/S1-g1-round11-attack-13-linkrefdef.md，提交。
4. 执行 node --experimental-strip-types --no-warnings scripts/sign-gate.ts docs/gates/G1.md。
5. 提交重签后的门记录，再执行 node --experimental-strip-types --no-warnings scripts/gate-check.ts docs/gates/G1.md。

实际输出：

- 第 4 步退出码 0：重签完成：证据 13 份，candidate=b1711c6451c8…，artifact_hash=825e642de83d…，body_hash=539a043ff425…，改动文件 90 个。
- 重签后门记录提交为 4dcf22f338e9f03f50d5f2bac8635478b6883ed1。
- 第 5 步退出码 0：gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=825e642de83d… body_hash=539a043ff425…）。
- 门记录 sha256：重签前 3baa56f9803c6008526a50a8669a1ca5f0158cf921c289e1a8248d99ee961f70，重签后 3c1bfeb4ed61979ce414e311825ddebc33e48cc425eb5dcd9469e51f8458d7b7。
- 攻击报告 sha256（LF 归一）：3782f72e1f8c0224d7eb8c169c22ef29010b6034d58e45626c21dd27fade19ab。

解析器直测：对该报告调用 auditConclusionOf 与 auditBindingOf，输出 {"conclusion":"pass","binding":{"gate":"G1","commit":"959846215b85f3e2b56d4d5a69c271b8520f49fa"}}。绑定合法，结论被读成 pass。

渲染器对照：markdown-it 4.0.0（commonmark）与 python-markdown 3.10.2 对四种续行变体的 hidden 都是 True；实际被利用的是「目标在下一行」这一种。把结论放在下一行带引号 title 或括号 title 时渲染器同样隐藏，但解析器返回 null，门会拒绝，所以不计为可利用绕过。

期望：sign-gate 退出码 1，提示审计报告里找不到唯一结论行，且 G1 字节不变；gate-check 退出码 1。实际是两者都退出 0 并完成签门，属 fail-open。

影响：上一轮修的原始 HTML 拒绝只覆盖尖括号形态；链接引用定义是纯 Markdown，仍能制造「渲染不可见、解析可见」的结论。这与 S1 第十轮 P1-1 同类，且直接击穿「报告可见内容必须与结论一致」的门禁目的。

## P2-1 证据文件改动后重签仍可通过（S2 第十三轮 P2-10 仍成立）

位置：scripts/gate-check.ts:103（G1 excludes 含 docs/gates）、scripts/gate-check.ts:264-275（candidateEntries 只算候选范围）、scripts/gate-check.ts:926-931（审计报告只检查候选提交之后排除目录以外的改动）、scripts/sign-gate.ts:27-32（重签按 HEAD 重算证据哈希）。

复现：从阳性对照签好的状态 fcfd26febea3ecc49179d485e765a3609e638d76 出发，在 docs/gates/evidence/G1/G-01.md 末尾追加一行「补充复核：本轮实测通过。」并提交；再执行 sign-gate 与 gate-check。

实际输出：

- sign-gate 退出码 0：重签完成：证据 13 份，candidate=b1711c6451c8…，artifact_hash=38adac543719…，body_hash=391c71831a65…，改动文件 90 个。
- 重签后门记录提交为 a2058df3e07c5eb83ded98a15d2bb55acd41bf92，门记录 sha256 为 c76c961da6f7a4ef9d05c29500972e2c49fb0dfaf5ee2cbe44bd01f322a4f6ec。
- gate-check 退出码 0：gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=38adac543719… body_hash=391c71831a65…）。

原因：docs/gates 同时被排除在候选范围和审计报告候选提交后的 diff 检查之外；证据又在 docs/gates/evidence 下，所以证据文件改了、重签一次，门检查仍通过，不需要新的独立审计报告。

期望：审计报告签好之后，证据文件再有改动应当要么被 sign-gate 拒绝，要么要求新的审计报告；不能靠重签把改动吸收掉。判 P2：需要仓库写权限与重签能力，不是外部直接绕过，但破坏了证据固定性。

## 复核：报告绑定、候选 diff、不变量固定口径

- 绑定门名：把报告的门绑定行改成 G2 后 sign-gate 退出码 1，报错 Error: 审计报告绑定的门与门记录不符：报告=G2，记录=G1（scripts/gate-check.ts:917）。改回 G1 后可签。
- 候选唯一：报告里写两条候选提交行时 sign-gate 退出码 1，报错 Error: 审计报告缺少唯一的「门：G1」与「候选提交：40 位 commit」绑定行: docs/audits/S1-g1-round11-attack-15-double-candidate.md（scripts/gate-check.ts:914）。
- 候选提交..HEAD diff：从签好的阳性对照状态往 src/core/canonical.ts 追加一行 // audit candidate diff probe 并提交，gate-check 退出码 1，报错 门检查失败：审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：src/core/canonical.ts。随后重置回签好的提交。S1 第十轮 P1-2 仍成立。
- 不变量固定口径：把 G1 的 I1 语句削成「单写者与 epoch 栅栏」并重算 invariants_hash 后签，sign-gate 退出码 1，报错 Error: 不变量 I1 的语句与固定口径不一致（改写或削短都要重新审计）（scripts/gate-check.ts:327）。S1 第十轮 P1-3 仍成立。
- 证据被改：见 P2-1，仍可通过重签绕过。

## 攻击矩阵：12 种隐藏块与原始 HTML 形态

方法：每份攻击报告都含可见 fail 正文与隐藏 pass 结论，路径为 docs/audits/S1-g1-round11-attack-01…12。每轮先提交报告并让 G1 指向它，再跑 sign-gate；sign-gate 拒绝后，为让 gate-check 越过报告哈希锚点、真正走到结论检查，驱动程序把 audit_report_sha256 改成该报告实际 sha256 并提交，然后跑 gate-check。这个补哈希动作不签门，只用于定位拒绝点。

12 份报告在 sign-gate 阶段全部退出码 1，G1 字节全部不变（表中 sha256 为签前与签后同一个值）。gate-check 也全部退出码 1。

统一错误 E-CONCL：Error: 审计报告里找不到唯一结论行，不能拿它当门记录依据: 报告路径。gate-check 对应错误为 门检查失败：审计报告里找不到唯一结论行，不能拿它当门记录依据: 报告路径。01 的完整原文是 Error: 审计报告里找不到唯一结论行，不能拿它当门记录依据: docs/audits/S1-g1-round11-attack-01-inline-code.md。

| 编号 | 形态 | 报告路径 | sign | gate | G1 sha256（前后相同） |
| --- | --- | --- | --- | --- | --- |
| 01 | 行内代码中的 details 闭标签字面量，外层 details 开标签 | docs/audits/S1-g1-round11-attack-01-inline-code.md | 1 | 1 | c7b67391b94f851b6658642c1d4bb74122857bd8895ff28dfe1388555bfaeaff |
| 02 | 链接目标中的 details 闭标签字面量 | docs/audits/S1-g1-round11-attack-02-link-destination.md | 1 | 1 | 5a54e29649d4b080c2b328e983cec4dccbf498154e1279c4542bbbc00b1fdebf |
| 03 | Tab 缩进的 details 闭标签 | docs/audits/S1-g1-round11-attack-03-tab-indent.md | 1 | 1 | c4221698f3bd2edc571f0cee368fe2c2e434cd83f7796e8f73ee58c8494f9a1b |
| 04 | 大写 DETAILS 闭标签 | docs/audits/S1-g1-round11-attack-04-uppercase-close.md | 1 | 1 | 7ff51970b7a243b8a314817d7f03355e95d8046893cd1fc440830f7d0674e90d |
| 05 | CRLF 换行 | docs/audits/S1-g1-round11-attack-05-crlf.md | 1 | 1 | cb9cca1b7bc09fd3c578f1efa4c57ce3ebe11893e01a0b59122ea2e3ca157512 |
| 06 | 处理指令内含 pass | docs/audits/S1-g1-round11-attack-06-processing-instruction.md | 1 | 1 | 27dfda7b1f9280e7c42dcfc4bd205b20d1dd9e224bbb8fcbda6095f5e8a27647 |
| 07 | DOCTYPE 声明内部子集内含 pass | docs/audits/S1-g1-round11-attack-07-doctype.md | 1 | 1 | bd9a0624a83b7e7626b648ec77705d6bcabdd668fed2c83125bc4582d7e5eaf2 |
| 08 | CDATA 段内含 pass | docs/audits/S1-g1-round11-attack-08-cdata.md | 1 | 1 | 4caf4a00223b8eec3c8ab95125e539c7da9beb5c4c7fb1651ac85093e41d4cfe |
| 09 | details 开标签带 open 属性 | docs/audits/S1-g1-round11-attack-09-details-open.md | 1 | 1 | b887e5ee80f19c5512a7072efc891f626263b92d6190e31645c00247cef4eeb1 |
| 10 | summary 标签 | docs/audits/S1-g1-round11-attack-10-summary.md | 1 | 1 | 853913c1eea2f64c25ddeabde9d3e87d735fc433380f44bda30eaa301cd4cee3 |
| 11 | div 标签带 hidden 属性 | docs/audits/S1-g1-round11-attack-11-div-hidden.md | 1 | 1 | a97c39c920f32d6281e48c0c809d95b6fe2b0dad265153320e1bc7955ee53f9d |
| 12 | div 标签带内联 display:none | docs/audits/S1-g1-round11-attack-12-div-display-none.md | 1 | 1 | cbb6eb920efc7733cca0862be309d8a7e616866c687ed99df256b45541faa105 |

矩阵内每种形态的实际错误都是 E-CONCL，只有报告路径不同；退出码与 G1 不变性见表。12 组完整的 sign 与 gate 原始输出保存在 D:/aboutAI/_audit_s1_round11/results.json（临时工作区，不在主仓库）。

## 阳性对照

报告 docs/audits/S1-independent-audit-round11-control.md 为纯 Markdown，只有可见正文与唯一顶层结论行，门与候选各一行，没有原始 HTML。报告 sha256 为 8c92b8130dfdc8e3190cc2a8d982a728505f038dab641f6e871964161a82f674，签前提交 c460220e9ce44650c0a6d0eaaf5f55e6985818e4。

- sign-gate 退出码 0：重签完成：证据 13 份，candidate=b1711c6451c8…，artifact_hash=2dc5d922655a…，body_hash=e91bee0cea82…，改动文件 90 个。
- 重签后门记录提交 fcfd26febea3ecc49179d485e765a3609e638d76，门记录 sha256 由 058182a6b3b7ae346d39c303673c562170d95dd004dccbb08a6c75ba166e3a4a 变为 c09b0490e3d777fd56b31b7d142d4ab6dba06d580dfa5f8bc078d5bb549b5eef。
- gate-check 退出码 0：gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=2dc5d922655a… body_hash=e91bee0cea82…）。
- 完整 artifact_hash：2dc5d922655abca4531a21b46d54e1416cb609694c2361646c98a57cc130a5f1。
- 完整 body_hash：e91bee0cea82e77e9395d38140535de26d411eaf4c615752bb3ae21ba279650f。

阳性对照证明正常路径仍可签、可过，问题不是环境整体失效。

## 单元测试

- 主仓库预签态运行 node node_modules/vitest/vitest.mjs run tests/gate-check.spec.ts：退出码 1，11 failed | 34 passed（45 项）。11 项失败都停在 scripts/gate-check.ts:903 的 audit_report_sha256 校验，报审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…。这是 G1 尚未重签的预签态，按任务约定不计 P0/P1。
- 在临时 clone 的阳性对照签后状态 fcfd26f 运行同一测试：退出码 0，45 passed（45 项），16.61s。说明测试红是预签态造成，签后全绿。
- tests/gate-check.spec.ts:347-356 覆盖原始 HTML 拒绝，:358-363 覆盖处理指令、DOCTYPE、CDATA，:371-379 覆盖门与候选绑定，:149-167 覆盖不变量固定口径。没有链接引用定义续行的用例，P1-1 因此没被单测挡住。

## 前几轮问题复核

- S1 第十轮 P1-1（行内代码、链接、缩进代码里的字面 details 闭标签）与 P1-2（处理指令、DOCTYPE、CDATA 里的 pass）：本矩阵 01-08 全部退出码 1，G1 字节不变，修复在测试形态上成立。
- S2 第十三轮 P1-1（details open、summary、div hidden、内联 display:none 的可见性绕过）：本矩阵 09-12 全部退出码 1，G1 字节不变，修复在测试形态上成立。
- 但原始 HTML 一律拒绝只覆盖尖括号形态；链接引用定义是纯 Markdown 隐藏，P1-1 说明 fail-closed 仍未闭合。
- S2 第十三轮 P2-10（证据改写后重签）仍成立，见 P2-1。

## 总体判定与整改方向

本轮 P0=0、P1=1、P2=1，总体判定为 fail，阻断项是 P1-1。普通 Markdown 报告的签门与门检查仍工作，阳性对照通过；不能因为阳性对照通过就放行 P1。

整改方向：

- 在 stripHiddenAuditBlocks 里把链接引用定义当成跨行结构处理：识别定义头后，把目标行与可选 title 行一并掩码；或者更严格地，只允许受控的结论区，遇到无法确定可见性的构造直接返回空。
- 给 tests/gate-check.spec.ts 增加链接引用定义续行的用例：定义头下一行是结论时，auditConclusionOf 必须返回 null；再将此用例纳入真实 sign-gate 攻击回归。
- 证据文件位于 docs/gates，被排除在候选范围与审计 diff 之外；可考虑把证据文件的哈希锚直接写进审计报告并绑定报告 sha256，或把证据文件移出 docs/gates 的排除范围，避免改证据后重签即可过。
