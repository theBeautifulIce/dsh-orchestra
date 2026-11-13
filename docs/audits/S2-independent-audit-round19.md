# S2 G2 第十九轮独立审计报告

门：G2

候选提交：c6ffc208a76fee26f8e8006ef1272219e46ba16a

结论：fail

## 范围与基线

候选提交完整哈希为 c6ffc208a76fee26f8e8006ef1272219e46ba16a。G2.md 的 blob 为 5d4c9c1ae3c6fd667951ae0cebc2acc9d99d06a8，与 e63c36f 相同；19 项必过、19 份证据、11 条不变量齐全。19 份证据文件与 evidence-index 自 e63c36f 未改，git diff 为空。在干净候选上写纯 pass 报告做阳性对照，sign-gate 退出 0，gate-check 退出 0，并输出 19 项必过、19 份证据复核。

tsc --noEmit 退出 0。全量 vitest 为 321 例，310 通过、11 失败；11 项均失败于预签态 G1.md 的 report sha256 全零与 50ba1b13cdf1b84d 不符，baseline 14383fa 同样有这 11 项，非本轮回归；新增用例通过。

## 第十八轮 P0 已修复

第十八轮的列表项链接 title 与引用块链接 title 两个载体，在 c6ffc208 上均返回 null；把报告写入门记录后运行 sign-gate，退出 1，报错为审计报告里找不到唯一结论行（scripts/gate-check.ts:1080），不再把 title 里的 pass 行漏成顶层。纯 pass 阳性对照仍为 sign-gate 0、gate-check 0 且 19/19。

## P0：三空格缩进的定义样式可见 fail 被当作引用定义丢掉

P0 计数 1 项，三个载体：正文段落后、列表项内、引用块内。

攻击报告的结构：顶层先写一个正式的 pass 结论行；另起一段写“正文”；紧跟一行三空格缩进的方括号标签、冒号、URL 与 title，title 里写结论词、全角冒号、fail，再闭合引号。列表项载体把“正文”换成列表项，引用块载体在行首加引用前缀。

用 markdown-it-py 的 CommonMark 渲染后，这一行与“正文”同属一个可见段落，fail 是可见正文，不在 title、alt 或引用定义里；但 gate 仍只返回 pass。sign-gate 退出 0；gate-check 退出 0 并输出 19/19。三个载体在 c6ffc208 上均实测通过。

根因链：

- scripts/gate-check.ts:677-698 的 maskIndentedAuditCode 只掩掉四空格或 Tab 开头的行；三空格行保留下来，进入链接掩码。
- scripts/gate-check.ts:809-826 的 visibleTextOfLinkParagraph 用 scripts/gate-check.ts:813 的规则把任意前导空白加方括号标签加冒号的行当成引用定义，整行删除；scripts/gate-check.ts:817 还会删掉定义后的缩进续行。CommonMark 只把段落开头的这类行当定义，段落中间的三空格行是可见文字，但这里没有段落位置判断。
- scripts/gate-check.ts:828-867 的 maskAuditLinkDestinations 在该段出现方括号时整段隐藏；scripts/gate-check.ts:840 只看方括号是否存在，不区分可见正文与真正的定义。visibleTextOfLinkParagraph 已经把可见 fail 删掉，逐行毒化检查看不到它，于是该段被静默清空。
- scripts/gate-check.ts:975-996 的 stripHiddenAuditBlocks 在 links、inline、indented 都未置 poison 时只留下顶层的 pass 行，auditConclusionOf 返回 pass。

复现：在候选的干净克隆中写入上述报告到 docs/audits/S2-independent-audit-round19.md，把 G2.md 的 audit_report 指向该文件、audit_round 改为 19，运行 node scripts/sign-gate.ts docs/gates/G2.md，再运行 node scripts/gate-check.ts docs/gates/G2.md。实测两次退出码均为 0，gate-check 输出 19/19。该复现只在审计克隆内做，不改主仓门记录与源码。

## P1 与 P2

P1 计数 0 项。

P2 计数 1 项：列表项四空格续行在 CommonMark 里是可见文字。把 pass 行放在续行时，gate 会读到这个可见 pass；这不是隐藏段绕过，正文叙述与正式结论行不一致属于审计报告内容问题，gate 只校验正式结论行。建议后续要求结论行位于顶层段落，或增加正文与正式结论的一致性检查。

## 已复测的攻击面

- 第十八轮块链接 title 与引用块链接 title：均返回 null，sign-gate 退出 1。
- U+00A0 与 U+2028 伪空行：返回 null。
- CDATA 内 pass、外部 fail：返回 fail；CDATA 内 pass、外部 pass：返回 pass。
- 未闭合注释、处理指令、doctype：返回 null。
- 反引号围栏的 info string 带反引号：返回 null。
- HTML 实体编码的 fail：返回 null。
- 强调标记与链接文字构造的 fail：返回 null。
- 真正的缩进代码块内 pass、外部 fail：返回 fail。
- 列表项四空格续行内 fail、另一段 pass：返回 null。
- 纯 pass 与独立链接：返回 pass；阳性对照签名与门检查均退出 0。

## 变更面

相对 e63c36f，候选只改 scripts/gate-check.ts 与 tests/gate-check.spec.ts；docs/gates 与 docs/evidence 无改动，未见校验放宽。

综上，第十八轮的 title 漏判已经修复，但本轮仍存在一条把可见 fail 当引用定义删除、只留 pass 过门的 P0 路径，故本轮结论为 fail。
