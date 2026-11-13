# S2/G2 第十五轮独立审计报告

审计对象：0297b77「Mask multiline link definitions and bind evidence into candidate scope」；审计日期：2026-11-13；审计者：独立审计代理。

门：G2

候选提交：0788dfb23f9abc6310b1419009fb820899ce193b

## 范围与方法

主仓库当前 HEAD 为 0788dfb（仅追加 handoff.md，该路径在 excludes 内，候选集合与 0297b77 相同）。源码与测试只读核对，未改动主仓库源码、门记录或提交；本报告是主仓库唯一新增文件。

实验在临时 clone 中进行：目录 D:/aboutAI/_audit_s2_round15/clone，base 为 0788dfb，clone 内 core.autocrlf=false 保证 LF。每个案例先 reset 到 base，写审计报告、改写 G2 的 audit_round 与 audit_report、提交，再执行：

- `node --no-warnings scripts/sign-gate.ts docs/gates/G2.md`
- sign-gate 退出码为 0 时，提交签后门记录并执行 `node --no-warnings scripts/gate-check.ts docs/gates/G2.md`

逐案例结果日志：D:/aboutAI/_audit_s2_round15/attack-log.jsonl；固定口径攻击输出：D:/aboutAI/_audit_s2_round15/invariant-fixed.json。

渲染核验：markdown-it-py 4.3.0，MarkdownIt("commonmark")；探针 D:/aboutAI/_audit_s2_round15/probe_render2.py，输出 D:/aboutAI/_audit_s2_round15/render-probe.json。解析器核验直接 import 主仓库 scripts/gate-check.ts 的 auditConclusionOf 与 auditBindingOf。

环境：Windows；node v26.13.1（原生 TypeScript 剥离）；git 可用。G2 当前是预签态（audit_report_sha256 为 64 个 0），按任务约定不据此判缺陷。

## 阳性对照

报告 docs/audits/S2-g2-round15-control.md 为纯 Markdown，含唯一结论行 pass、门名行 G2、候选行 base；改写 G2 的 audit_round=15 与 audit_report 后提交。

- sign-gate 退出码 0，输出：`重签完成：证据 19 份，candidate=d32f00597aff…，artifact_hash=7cbe86cb956c…，body_hash=44a9572ab7bc…，改动文件 86 个`
- G2 文件 sha256：`826a125417905bc7a6eb8872611a23b2bcb912230467cffb5c5e7daa9b5a3932` 变为 `8755cd8710e8bbe529ce189089a190cecbe55a49cc5cfd609dc3cc672d48c7fe`
- 提交签后门记录后 gate-check 退出码 0，输出：`gate G2 通过（19 项必过、19 份证据哈希复核，artifact_hash=7cbe86cb956c… body_hash=44a9572ab7bc…）`

阳性对照符合预期。

## 修复点 1：链接引用定义的续行掩码

### 任务指定形态

报告 docs/audits/S2-g2-round15-link-a-target-nextline.md 的 payload 如下，另有可见正文「本报告结论为不通过。」：

| 行 | 内容 |
| --- | --- |
| 定义行 | `[x]:` |
| 下一行 | `结论：pass` |

- sign-gate 退出码 1，stderr 首行：`Error: 审计报告里找不到唯一结论行，不能拿它当门记录依据: docs/audits/S2-g2-round15-link-a-target-nextline.md`
- G2 sha256 前后均为 `ae4b4d035c024b0b788161fd10db50e17caecf12ac8cd9d986417ce2f344da8e`，字节不变。
- 与期望一致，该形态已修复。

### 仍可绕过的两类形态

四份攻击报告都含顶层可见正文「本报告结论为不通过。」，随后是链接引用定义与隐藏的 pass 结论行。CommonMark 渲染后，可见文本只有「本报告结论为不通过」，不含 pass 结论行；同一正文交给 auditConclusionOf，返回 pass。

| 案例 | 定义行 | 下一行 | 报告文件 |
| --- | --- | --- | --- |
| B 标签内转义右方括号 | `[a\]]:` | `结论：pass` | docs/audits/S2-g2-round15-link-b-escaped-label.md |
| F 引用块里的定义 | `> [x]:` | `> 结论：pass` | docs/audits/S2-g2-round15-link-f-quote-block.md |
| G 引用块加转义标签 | `> [a\]]:` | `> 结论：pass` | docs/audits/S2-g2-round15-link-g-quote-block-escaped.md |
| H 标签里两个转义右方括号 | `[a\]b\]]:` | `结论：pass` | docs/audits/S2-g2-round15-link-h-two-escapes.md |

渲染探针结果：四例的可见文本均为「正文 本报告结论为不通过」，pass 结论行均不可见；解析器结果：四例 auditConclusionOf 均返回 pass。

端到端实测：

| 案例 | sign-gate 退出码 | artifact_hash | gate-check 退出码 | G2 sha256 前 |
| --- | --- | --- | --- | --- |
| B | 0 | `56a2c1be43ea…` | 0 | `c902d5f43fa2c85189c573f8a8658495ebf7d0d0f8b095c9475f671029f0f555` |
| F | 0 | `58d222f30724…` | 0 | `3c149323a3b4d268d559c3f3689d2107644e5cd6760e7df4a70bbf0c69a2bde5` |
| G | 0 | `e778efdf7aae…` | 0 | `e39070af04b7dbb7c121d4e4b67155916c77f51438f999d2216ec7f7df22b074` |
| H | 0 | `2e95ae1824f0…` | 0 | `69ba372a97587ae7f2e287343c1e46272a67749e0c704dca72def6531cd47fa4` |

| 案例 | 签后 G2 sha256 | gate-check 输出 |
| --- | --- | --- |
| B | `418200f153ec3a771a6a4e289084fe489b807dabc91c87c399fb9b5ab0d531b9` | `gate G2 通过（19 项必过、19 份证据哈希复核，artifact_hash=56a2c1be43ea… body_hash=19261cd7b43a…）` |
| F | `565a151f8b7ea4afd62fd96ca0edd9e78a386d8e649a5e13e0e53ce28c7d9926` | `gate G2 通过（19 项必过、19 份证据哈希复核，artifact_hash=58d222f30724… body_hash=74ba6451731e…）` |
| G | `e0236d1f0de9d39bb02c94d41396555788a2aff6fb9adc1be3e0cd610d377571` | `gate G2 通过（19 项必过、19 份证据哈希复核，artifact_hash=e778efdf7aae… body_hash=7e0e581e694b…）` |
| H | `959a59fae3934cde37b7123c54c1f74b3ac6235fa49db90858f2a2fb8840b2fa` | `gate G2 通过（19 项必过、19 份证据哈希复核，artifact_hash=2e95ae1824f0… body_hash=13d5fa40ea86…）` |

期望：sign-gate 退出码 1，错误为「审计报告里找不到唯一结论行」，G2 字节不变，与案例 A 相同。实际：sign-gate 与 gate-check 都退出 0，报告被当成 pass 签入门记录。

### 根因

- P1-1 根因：scripts/gate-check.ts:705 的引用定义正则为 `^( {0,3}\[[^\]\n]+\]):(.*)$`。标签字符类排除右方括号，也没有处理反斜杠转义，因此 `[a\]]:` 与 `[a\]b\]]:` 不匹配，续行掩码不触发。scripts/gate-check.ts:701 的同行链接目标替换也没有命中（没有右圆括号），于是下一行 pass 结论仍留在顶层。
- P1-2 根因：scripts/gate-check.ts:705 要求定义行以 0 至 3 个空格加左方括号开头，引用块前缀 `> ` 使 `> [x]:` 不匹配；scripts/gate-check.ts:852 的 normalizeAuditLine 会剥掉 `> `，把 `> 结论：pass` 还原成顶层结论行。

## 修复点 2：证据文件进入候选范围

在阳性对照签门并提交之后，向 docs/gates/evidence/G2/ev-g2-01.md 追加一行「审计复核实测追加行 round15」，提交 aa243ee2a0b5809f9c619c99ec5b2e45508e5e09，再次 sign-gate。

- sign-gate 退出码 1，stderr 首行：`Error: 审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：docs/gates/evidence/G2/ev-g2-01.md`
- G2 sha256 前后均为 `8755cd8710e8bbe529ce189089a190cecbe55a49cc5cfd609dc3cc672d48c7fe`，字节不变。
- 期望一致，该修复生效。

源码依据：GATE_SPECS.G2.excludes（scripts/gate-check.ts:186）只列 docs/gates/G1.md、docs/gates/G2.md、docs/audits、docs/reviews、handoff.md，docs/gates/evidence 下的文件在候选集合内；checkAuditAnchor（scripts/gate-check.ts:950 至 955）以 excludes 过滤候选提交之后的 diff，并在错误里报首个文件名。

## 原始 HTML 与可见性复测

上一轮 12 份原始 HTML 与可见性语料改写门名为 G2、候选为 base 后逐份实测。12 例 sign-gate 退出码全为 1，错误均为「审计报告里找不到唯一结论行，不能拿它当门记录依据: docs/audits/S2-g2-round15-html-NN.md」，每例 G2 sha256 前后相同。

| 编号 | 攻击点 | sign-gate | G2 sha256（前=后） |
| --- | --- | --- | --- |
| 01 | 行内代码里的字面闭合 details 标签加外层 details | 1 | `ac4401504cad8d0aa72cd7118446cf7a27086bc57902522b9ade3de1f847fa07` |
| 02 | 链接目标里的 details 闭合标签 | 1 | `ba39d4e7a50b8b8ea10597b0f9ed3998b519a92b6c96f94ecd31adcd604a46a8` |
| 03 | Tab 缩进代码里的 details 闭合标签 | 1 | `1ce21fd1208b7dcb58e21818914c5444b59ce913896fb79c074ded1f82075bed` |
| 04 | 大写 DETAILS 闭合标签 | 1 | `67caa02909b0e8cf1926ee10738c3748a738d95e744dbf1a7d5d95d2d1a76565` |
| 05 | CRLF 行尾的隐藏块 | 1 | `316adf3ec1c5af26ec3c17e64c7e7d560a0463cddaaac7cb8ebcf514871f0203` |
| 06 | 处理指令里的 pass 结论 | 1 | `f1afe63de64edbccec4140871b09be3d3b9f4fa3e1816e30f5cb4624bb95ca86` |
| 07 | DOCTYPE 内部子集里的 pass 结论 | 1 | `b0612f416a0b7e44e5a1c478821d52a9b329bf99a3f7b72f2bc000015d50dc9c` |
| 08 | CDATA 区块里的 pass 结论 | 1 | `3304856d9126d1ee715e6b36eece7b07b1595c4a867486b87cac7c9956537a66` |
| 09 | details open 可见性 | 1 | `9ed53e9e28a3e2a0a924254eb9ff650e26b49de470a915d5d9ece59bf838fe93` |
| 10 | summary 可见性 | 1 | `e6df404d964f96cb35f4796c5e3607212a4d495f20bb80f3096622a1ae1682a1` |
| 11 | div hidden 可见性 | 1 | `1e150427ad081c92c1cd128edf60448261212a07a7df040f2ffd954ba727d91b` |
| 12 | div display:none 可见性 | 1 | `95c8f7306c2b6d6c340fcb48c1f13ed623fae6f9b9d471c8b02e93ad6826b683` |

原始 HTML 一律拒绝的 fail-closed 行为仍有效。

## 绑定与固定口径复核

| 案例 | 改动 | sign-gate | 实际错误 | G2 sha256（前=后） |
| --- | --- | --- | --- | --- |
| 门名绑定 | 报告写门名 G1，门记录为 G2 | 1 | 审计报告绑定的门与门记录不符：报告=G1，记录=G2 | `fecd34267f3d9ccb587b3cf1dbcd48d6757ef924038fc04c4426966adb45cd66` |
| 候选行重复 | 报告写两条候选行 | 1 | 审计报告缺少唯一的绑定行（错误里给出 40 位 commit 占位） | `48ebb053483f198b1832f68af0e780a4fe57553650336488952a4e70e84804d4` |
| 候选文件事后修改 | 报告提交后修改 src/core/canonical.ts 并提交 652acb4f… | 1 | 审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：src/core/canonical.ts | `de0ea5894adf0bf22a4fe0712bab0ddec505760c440dc9c213ae2a3ce802c156` |
| 固定口径一致改写 | 同时改写 artifact 的 invariants 块与正文不变量表 I1，两处都削短为「一个 node_run 最多一个终态」 | 1 | 不变量 I1 的语句与固定口径不一致（改写或削短都要重新审计） | `da65aff7736badf4be56152e6ab4ede079b7c09ffc015c93212b8ccaf6e157fd` |

固定口径案例中，G2 里的原语句出现 2 次（正文表与 artifact），两处被同步替换，正文表一致性检查因此放行，随后被 scripts/gate-check.ts:326 至 328 的固定口径比对拒绝。门名、候选绑定与候选文件事后修改均按预期拒绝。

## 问题清单

P0：0 条。

P1：2 条。

### P1-1 标签内转义右方括号的链接定义仍能隐藏 pass 结论

- 位置：scripts/gate-check.ts:705
- 复现：clone 内写报告 docs/audits/S2-g2-round15-link-b-escaped-label.md，可见正文为「本报告结论为不通过。」，定义行 `[a\]]:`，下一行 `结论：pass`；改写 G2 的 audit_round=15 与 audit_report，提交后执行 `node --no-warnings scripts/sign-gate.ts docs/gates/G2.md`。
- 实际：sign-gate 退出码 0，artifact_hash=56a2c1be43ea…；提交签后门记录后 gate-check 退出码 0。G2 sha256 从 `c902d5f43fa2c85189c573f8a8658495ebf7d0d0f8b095c9475f671029f0f555` 变为 `418200f153ec3a771a6a4e289084fe489b807dabc91c87c399fb9b5ab0d531b9`。
- 期望：sign-gate 退出码 1，错误为「审计报告里找不到唯一结论行」，G2 字节不变。
- 证据：attack-log.jsonl 中 name 为 S2-g2-round15-link-b-escaped-label.md 的一行；渲染探针显示 pass 结论不可见；auditConclusionOf 返回 pass。

### P1-2 引用块里的链接定义仍能隐藏 pass 结论

- 位置：scripts/gate-check.ts:705、scripts/gate-check.ts:852
- 复现：clone 内写报告 docs/audits/S2-g2-round15-link-f-quote-block.md，可见正文同上，定义行 `> [x]:`，下一行 `> 结论：pass`；改写 G2 后执行同一 sign-gate 命令。变体 G 把定义行换成 `> [a\]]:`，变体 H 把定义行换成 `[a\]b\]]:`。
- 实际：三例 sign-gate 与 gate-check 均退出 0；artifact_hash 分别为 58d222f30724…、e778efdf7aae…、2e95ae1824f0…；G2 sha256 分别为 `3c149323a3b4d268d559c3f3689d2107644e5cd6760e7df4a70bbf0c69a2bde5` 变为 `565a151f8b7ea4afd62fd96ca0edd9e78a386d8e649a5e13e0e53ce28c7d9926`、`e39070af04b7dbb7c121d4e4b67155916c77f51438f999d2216ec7f7df22b074` 变为 `e0236d1f0de9d39bb02c94d41396555788a2aff6fb9adc1be3e0cd610d377571`、`69ba372a97587ae7f2e287343c1e46272a67749e0c704dca72def6531cd47fa4` 变为 `959a59fae3934cde37b7123c54c1f74b3ac6235fa49db90858f2a2fb8840b2fa`。
- 期望：同 P1-1，sign-gate 退出码 1、错误为「审计报告里找不到唯一结论行」、G2 字节不变。
- 证据：attack-log.jsonl 中三个对应 name；渲染探针显示 pass 结论不可见；auditConclusionOf 均返回 pass。

P2：1 条。

### P2-1 回归测试未覆盖转义标签与引用块前缀

- 位置：tests/gate-check.spec.ts:371 至 376
- 现状：该用例只有四条断言，覆盖普通标签 `[x]:` 的目标换行、尖括号目标、同行目标与同行目标加缩进 title；没有标签内转义右方括号，也没有引用块前缀。
- 期望：补上 `[a\]]:`、`[a\]b\]]:`、`> [x]:`、`> [a\]]:` 四类断言，并至少对一种形态做 sign-gate 端到端拒绝测试。
- 证据：tests/gate-check.spec.ts:372 至 375 的断言文本；本轮 B、F、G、H 四例实测漏过。

## 改进方向

- 引用定义识别不要停留在行首正则。可以先把引用块前缀归一后再匹配，或直接按 CommonMark 的链接引用定义语法处理标签中的反斜杠转义（至少接受 `\]`）。
- 对“定义行加续行”做 fail-closed：一旦某行看起来像引用定义头（含引用块前缀、标签内含转义右方括号），就把其后的目标行与 title 行一并掩码，而不是只匹配标准形态。
- 把这四类形态补进 tests/gate-check.spec.ts，并加一条 sign-gate 端到端用例，避免只测解析函数。
- 证据候选范围与固定口径两块本轮实测通过，可保持现状。

## 最终判断

结论：fail
