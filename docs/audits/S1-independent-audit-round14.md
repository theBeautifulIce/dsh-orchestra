# S1 G1 第十四轮独立审计报告

门：G1

候选提交：e63c36fa58ffba6cec28395f33d84aa4610d6f73

结论：fail

## 摘要

本轮判 fail：P0 计 0 项，P1 计 3 项，P2 计 1 项。三条 P1 都能让攻击报告在渲染器里不显示 pass 字样，却让 sign-gate 以 exit 0 签出 pass 门记录，签后 gate-check 再以 exit 0 通过。攻击报告的可见正文只写「本报告可见正文的结论为不通过。」；渲染后的可见文本里没有 pass 字样，pass 落在链接 title、图片 alt 或引用定义 title 等不参与正文渲染的位置。

## 审计对象与方法

- 主仓工作目录 D:/aboutAI/dsh-orchestra，HEAD 为 e63c36fa58ffba6cec28395f33d84aa4610d6f73，工作树干净。
- 只审计提交内容；攻击在系统临时目录的独立 clone 里做，基线同为 e63c36f，没有改主仓源码、门记录或证据。
- 渲染对照使用 markdown-it-py 4.0.0 的 CommonMark 解析器，核对可见文本与 HTML 属性。
- 端到端流程：攻击报告放 docs/audits；把 docs/gates/G1.md 的 audit_round 置 12、audit_report 指向攻击报告；提交后运行 sign-gate；成功时再提交签后记录并运行 gate-check。

## P1 失败项

### P1-1 段落空行判定用 trim，Unicode 空白制造假空行

- 位置：scripts/gate-check.ts:706 用 line.trim().length 判断空行；scripts/gate-check.ts:712 用段内是否出现 ASCII 左方括号决定整段隐藏。
- 机制：JavaScript 的 trim 会去掉 U+00A0、U+2003、U+3000、U+000C、U+000B、U+FEFF 等字符，而 CommonMark 的空行只由空格和 Tab 构成。攻击者在行内链接 title 内放一行仅含上述字符的假空行，门在假空行处切断段落；假空行之后写 pass 结论行，该行就被门当成可见顶层行。渲染器却把 title 继续到下一行，pass 只进入 title 属性，页面不可见。
- 实测：auditConclusionOf 返回 pass；sign-gate exit 0；签后 gate-check exit 0。markdown-it-py 渲染后的可见文本不含 pass 字样，只含「本报告可见正文的结论为不通过。」和链接文本。
- 复现：按「复现步骤」建 clone，在链接 title 内放 U+00A0 假空行与 pass 结论行；G1.md 按第 4 步设置并提交，再签。观察 sign-gate exit 0、gate-check exit 0。

### P1-2 行内代码掩码跨空行配对，吞掉真实链接的左方括号

- 位置：scripts/gate-check.ts:660 的 maskInlineAuditCode；配对循环 674 到 686；替换在 692；段落掩码在 712。
- 机制：maskInlineAuditCode 在整个报告文本里配对同宽反引号，不检查空行或段落。攻击在前一段放一个孤立反引号，空行后放一个真实行内链接，并在链接 title 内放另一个同宽反引号。门把两反引号之间整段抹掉，连同真实链接起始处的左方括号一起消失；随后 712 的段落判定看不到左方括号，不再隐藏该段。渲染器里两个反引号属于不同段落，不构成 code span，链接照常解析，pass 留在 title。
- 实测：auditConclusionOf 返回 pass；sign-gate exit 0；gate-check exit 0。渲染可见文本不含 pass 字样。

### P1-3 poison 追加行被后续 HTML 掩码吞掉

- 位置：scripts/gate-check.ts:740 追加 poison 行；stripHiddenAuditBlocks 的掩码顺序在 scripts/gate-check.ts:849 到 858，其中链接掩码在 854，HTML 注释在 855，处理指令在 856，doctype 在 858。
- 机制：被隐藏段含结论行时，740 在文末追加一行无取值结论，让整份报告不可判定。攻击用 P1-1 的假空行藏 pass，另起可见段写 fail 结论并带链接触发 poison，再在文末放未闭合 HTML 注释、未闭合处理指令或未闭合 doctype。744、766、809 三处的未闭合分支都把从该处到文件尾的文本全部抹掉，包括 740 刚追加的 poison 行；auditConclusionOf 只读到另一段的 pass。
- 实测：未闭合注释、未闭合处理指令、未闭合 doctype 三种形态都返回 pass；sign-gate exit 0；gate-check exit 0；签后 artifact_hash 分别为 d396a8bc8a7d、b42814d6da6b、以及 d6 形态同类的未闭合分支。渲染可见文本含「结论：不通过」字样但不含 pass 字样。
- 根因独立：只要 poison 行生成在任何会吞到文件尾的掩码之前，后置掩码就能把它抹掉；这与隐藏通道本身如何构造无关。

## P2 过严边界

### P2-1 合法 CDATA 段藏 pass 且段外可见 fail 时整份报告不可判定

- 位置：scripts/gate-check.ts:712、727、728、730。
- 机制：CDATA 行含左方括号，712 先把它整段隐藏；728 的 hasConclusionText 在原始行里看到「结论 冒号 pass」字样，而 727 的 cleanPass 要求行首就是干净 pass，CDATA 前缀使匹配失败，730 置 poison；文末追加行让 auditConclusionOf 返回 null，而不是读出段外可见的 fail。
- 实测：auditConclusionOf 对「可见 fail 段加合法 CDATA 段藏 pass」返回 null。该方向是 fail-closed 误杀，不是 fail-open，计 P2；但它与父代理要求的「CDATA 段藏 pass 且段外 fail 仍读 fail」不一致。
- 影响：写报告的人若用 CDATA 隐藏内容并在另一段写 fail，门会拒绝整份报告，只能改写或移除 CDATA。

## 已确认堵住的攻击面与阳性对照

- 跨行引用标签、行内链接跨行 title、图片跨行 alt、图片跨行 title、全引用、方括号内换行、引用块内定义、列表内定义：sign-gate 全部 exit 1，报错指 scripts/gate-check.ts:945「找不到唯一结论行」，G1.md 字节未变。
- 五类毒化用例（成对 fail 与 pass、带尾巴 pass、前缀挡住、注释前缀、emoji 前缀）：sign-gate exit 1，G1.md 字节未变。
- 不依赖左方括号的通道：原始 HTML（含 display:none 样式）整份拒绝并返回 null；未闭合或闭合的注释、处理指令、doctype、围栏代码、缩进代码、行内代码在只有 pass 时返回 null，在段外另有可见 fail 时读出 fail。CDATA 例外见 P2-1。
- 阳性对照：链接单独成段、结论单独成段的报告 sign-gate exit 0，签后 gate-check exit 0，artifact_hash 为 f1f9de8a1b14。
- 同段链接与结论并存：exit 1，fail-closed 的已知取舍，不构成绕过。

## 测试与差异

- 类型检查：D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit，exit 0（clone 基线 e63c36f）。
- 全量用例：D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run，exit 1；Test Files 1 failed 与 31 passed（32），Tests 11 failed 与 302 passed（313）。
- 11 条失败全部在 tests/gate-check.spec.ts 的「门记录校验」块，根因同一条：docs/gates/G1.md 仍是预签态，audit_report_sha256 为 64 个 0，而 docs/audits/S1-independent-audit.md 实际 sha256 为 50ba1b13cdf1b84d；checkAuditAnchor 在到达各用例预期的错误前先抛「审计报告 sha256 与记录不符」。G1.md 的 audit_round、audit_report、audit_report_sha256 三个字段与 14383fa 完全一致，checkAuditAnchor 在 14383fa 也已存在，因此这是预签态失败，不是本轮引入的回归。
- 新增的审计结论用例单独运行时 20 passed 与 30 skipped，exit 0；302 条通过用例覆盖了本轮新增的跨行、图片、全引用与毒化断言。
- 差异：14383fa 到 e63c36f 只改 scripts/gate-check.ts（加 38 行、减 30 行）与 tests/gate-check.spec.ts（加 19 行、减 0 行），另加两份历史审计报告；测试文件没有删除断言，证据映射、必过项清单、候选范围都没有放宽。

## 复现步骤

1. 在系统临时目录克隆：git clone --no-hardlinks D:/aboutAI/dsh-orchestra C:/Users/ASUS/AppData/Local/Temp/dsh-audit-r14-e2e2
2. 切到候选：git -C C:/Users/ASUS/AppData/Local/Temp/dsh-audit-r14-e2e2 checkout e63c36fa58ffba6cec28395f33d84aa4610d6f73
3. 在 clone 的 docs/audits 写入攻击报告，文件名含 round12；报告里的门、候选提交、可见正文照写；按 P1-1、P1-2 或 P1-3 构造隐藏 pass（P1-3 还需另起一段写可见 fail 并在文末放未闭合 HTML 结构）。
4. 把 docs/gates/G1.md 的 audit_round 改为 12，audit_report 改为攻击报告路径，提交。
5. 运行 D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G1.md；P1-1、P1-2、P1-3 观察 exit 0。
6. 提交签后门记录，运行 D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md，观察 exit 0。

## 结论依据

以渲染器的可见文本为准，三类 P1 攻击都没有向读者显示 pass 字样，门却把它们签成 pass；这属于 fail-open，故本轮判 fail。修复方向由实现方决定，本轮只提交证据与复现路径。