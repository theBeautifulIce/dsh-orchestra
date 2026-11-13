# S1/G1 第六轮独立审计报告

审计对象为 D:/aboutAI/dsh-orchestra，HEAD 0919589（fix(gate): treat blocking caveats after pass as no conclusion），审计开始时工作树干净。范围是 S1/G1 的 13 项必过项、13 份证据与门记录本身；方法是逐项对照源码与 HEAD 字节、直接调用解析函数构造输入、在 %TEMP% 下克隆仓库做端到端签门、运行 tsc --noEmit 与 vitest，不采信文档自述。主仓库只读，唯一写出的文件是本报告；临时克隆在 <tmp> 下，未改动主仓库、docs/gates 或门记录，未提交、未推送。

结论：fail

## 一、分级

| 级别 | 数量 | 条目 |
| --- | --- | --- |
| P0 致命 | 0 | 无 |
| P1 重大 | 1 | P1-1 |
| P2 不阻断 | 6 | P2-1 至 P2-6 |

按约定 P0 或 P1 任一存在即 fail；本轮 P1=1，故本轮不能作为重签依据。

## 二、G1 门记录现状（第 3 项）

### 2.1 清单、映射与正文覆盖

- 规格：scripts/gate-check.ts:43-96 的 GATE_SPECS.G1 声明 13 项，顺序为 G1-01..G1-07、G-01、G-02、G-08、G-09、G-14、G-15；docs/gates/G1.md:11-25 的必过项表 13 行与之一致，编号、内容、证据 id 逐项对上。
- 证据映射：GATE_SPECS.G1 内的 evidenceMap 与 docs/gates/G1.md:33-45 的 13 行证据表一致；evidenceFiles 的 13 个固定文件与 docs/gates/G1.md:208 起的证据索引块一致，没有多出、缺少或换路径。
- 正文覆盖：checkBodyEvidenceTable 接受 docs/gates/G1.md:11-25 的 13 行证据表；checkBodyInvariants 接受 docs/gates/G1.md:63-71 的 4 行不变量表。结构核对脚本输出 items=13、evidenceMap=13、evidenceFiles=13、index=13、bodyRows=13、bodyInvRows=4。
- invariants_hash：记录 6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6（docs/gates/G1.md:83）与按 HEAD 重算一致。

### 2.2 证据哈希

按 HEAD 字节、CRLF 归一为 LF 后重算 13 份，9 份一致，4 份不一致：

| 证据 | 文件 | 记录 sha256 | HEAD 实算 sha256 |
| --- | --- | --- | --- |
| ev-g14 | docs/gates/evidence/G1/G-14.md | 3b2e37d9a0f6c6e49054dc4a27966e914755a56e6e8b9491d51ca3d213545169 | 44351757aa246ed7565ee17dae5ac172cf6a949be1d5d6f160945f4b53d83978 |
| ev-g15 | docs/gates/evidence/G1/G-15.md | db16d844f912cac0bedd81139a8238919b0d3f120469a6bdcfbcf7c73397cb0e | 334f26fb748d4013bdb0243f4a0e9d4ddd1e573fc4071114d9dffc0bb7dc03a3 |
| ev-gatecheck | tests/gate-check.spec.ts | c61262506e81f9bfb89f00afc55662a18a722ed1ed447f9dd8220f88ab8f93b2 | a42d8ab0b0dc7b593afacfd46b22c3594a06047ca1b732de4e2b19675b75d787 |
| ev-migrate | tests/migrate.spec.ts | b3ad3fbde1ef16392af16b68cbab36d440ffd23b9a6e19a74fd6132da61d6ff1 | 6ec799698b7057df449cf24dfaeec4e3d86cb414da4d315bf86305d0fa1d26cf |

evidence_index_hash 记录 fad4d531d22eef2968c6b7d5dce997f46162fa9fda12a98b1abf1aa6640a8d07（docs/gates/G1.md:82），与记录里的索引块自洽；按实际 13 份证据重算为 b58ffffcc698de40aecad843e20d9a7d8c9436edc3e045aa53bb084e7bf36ee8。索引与证据一起过期，重签会一起刷新。

这些是未重签留下的陈旧值，不是工作树被改动：审计开始时 git status 为空，4 份文件在记录签成之后各自有提交，G1.md 没有跟着重算。

### 2.3 哈希与审计锚

- candidate：记录 bbd322cf9d4ef5fb44a836ac8fd6edeb56b7c95ad34d1f80f29fe349fc4cc69e（docs/gates/G1.md:80），按 scopeBase 623939d 到 HEAD 的 89 个文件重算为 c181eb2691fbdf1d4bf892074edf504af589c91a241f8b48d419f02360fa65f5。
- change_scope：记录 ea15eaba761c24c70ff1b724251b125c65fc9ba17f15f4bdb1dfc35ff646f4fb（docs/gates/G1.md:81），重算为 248737b6264e7b36ea9a9788235a16986c76225242b3b497540b78ad5f7fc65b。
- artifact_hash：记录 1ce80f6080fb2271ae7ba958c61127962951cb49262b75e5b1d8e7d161b82084（docs/gates/G1.md:197），重算为 f54dcae873f34a988ca7d6fbf5bd0b29ce68558acfd4007f0b477e49b65cc4ec。
- body_hash：记录 446357f9e00e384a35d7a4b77be48f0720cceebb61a4b5e1c4a9e8e27f17450c（docs/gates/G1.md:198），重算为 aea5ac30bdb768e4762b29cb36170004360cbfa24faa4da2ae433536c161a2b2。
- 审计锚：audit_round=1、audit_report=docs/audits/S1-independent-audit.md、audit_report_sha256 为 64 个 0（docs/gates/G1.md:191-193）。该报告按 HEAD 实算 sha256 为 50ba1b13cdf1b84d5a948b2bc6deb25c7ec9963b4435154a5487683329390003，解析结论为 null。当前 G1 是未重签状态。
- docs/gates/G1.md:4 的“候选：10abcaa2dfc8b81a4a2d11f499839c7896042d06”是旧提交（13:04）的值，不是 HEAD 0919589；scripts/sign-gate.ts:70-82 只重写 artifact、artifact_hash、body_hash，不会改这一行。重签时需人工改成 0919589，否则门记录正文与 artifact 的候选不一致。

### 2.4 待签与真缺陷分开

| 观察 | 归类 | 说明 |
| --- | --- | --- |
| 4 份证据哈希过期 | 待签 | sign-gate 按 HEAD 重算并重写 |
| evidence_index_hash 过期 | 待签 | 随证据索引重算 |
| candidate/change_scope/artifact_hash/body_hash 过期 | 待签 | 随重签重算 |
| audit_round=1、report 指向 round1、sha 全 0 | 待签 | 重签时必须换成新的 pass 报告；只补 sha 会在 scripts/gate-check.ts:566-570 因结论 null 失败 |
| docs/gates/G1.md:4 散文候选 10abcaa2 | 待签 | sign-gate 不更新，需人工改 0919589 |
| G-08 取证缺 503/warning | 真缺陷 P2-4 | 证据与门项断言脱节 |
| 审计报告未绑门名/候选 | 真缺陷 P2-5 | 旧 pass 报告可复用到新 HEAD |
| 同一行 pass 后 caveat 黑名单不全 | 真缺陷 P1-1 | 可端到端签成 pass |

待签项由重签消除；真缺陷需改代码或证据后重新审计，不能用重签掩盖。

## 三、P1（1 项）

### P1-1 同一行 pass 后的 caveat 仍靠黑名单，项目自己的严重度词“重大”和同义词“阻断/未收口”可绕过

位置：scripts/gate-check.ts:503 允许 pass 后接任意破折号文本；:529 的阻塞词表只有 未闭合、仍未、仍有、尚有、尚存、没闭合、阻塞；:530 处理致命；:531-535 只剥离 P0/P1 的零值写法。黑名单没有“重大”“阻断”“未收口”“未解决”，也没有把“任何未知的严重度断言”一律当歧义。

复现（直接调用 auditConclusionOf，脚本在 <tmp>/conclusion-matrix.mjs 与 <tmp>/extra-cases.mjs）：

| 输入（单行） | 期望 | 实测 | 结果 |
| --- | --- | --- | --- |
| 结论：pass — 但仍有 1 个 P0 未闭合 | null | null | 一致 |
| 结论：pass（但仍有 1 个 P0 未闭合） | null | null | 一致 |
| 结论：pass（P0=0，P1=0） | pass | pass | 一致 |
| 结论：pass — P2 遗留 3 条 | pass | pass | 一致 |
| 结论：pass — 未闭合 | null | null | 一致 |
| 结论：pass — 仍未 | null | null | 一致 |
| 结论：pass — 仍有 | null | null | 一致 |
| 结论：pass — 尚有 | null | null | 一致 |
| 结论：pass — 尚存 | null | null | 一致 |
| 结论：pass — 没闭合 | null | null | 一致 |
| 结论：pass — 阻塞 | null | null | 一致 |
| 结论：pass — 致命 | null | null | 一致 |
| 结论：pass — P0 | null | null | 一致 |
| 结论：pass — P1 | null | null | 一致 |

第五轮点名的 9 个词全部 fail-closed，四个必测样例全部符合；这一部分确实修好了。

仍可签成 pass 的同类输入：

| 输入（单行） | 期望 | 实测 | 结果 |
| --- | --- | --- | --- |
| 结论：pass — 重大 3 | null | pass | 绕过 |
| 结论：pass（重大遗留 1 项） | null | pass | 绕过 |
| 结论：pass（阻断 1 项） | null | pass | 绕过 |
| 结论：pass（未收口） | null | pass | 绕过 |
| 结论：pass（未解决 1 项） | null | pass | 绕过 |

“重大”在本项目的分级里就是 P1（P0 致命、P1 重大、P2 不阻断），“重大 3”是三个重大项；“阻断 1 项”与“未收口”更直接。解析器把它们读成 pass，说明修复仍停在词表枚举，没有建立“pass 后出现未知严重度断言即歧义”的性质。

端到端（<tmp>/repo-attack-a，主仓库未参与）：

- 攻击 C：round9 报告写 结论：pass（未收口），sign-gate exit 0，artifact_hash=373560a6bd64…，body_hash=9548500fb8db…。
- 攻击 D：round9 报告写 结论：pass — 重大 3，sign-gate exit 0，artifact_hash=929d83bfd289…，body_hash=216d5a087da9…；提交 914d4f3（报告）与 da282ff（签门）后，gate-check exit 0，输出“gate G1 通过…artifact_hash=929d83bfd289… body_hash=216d5a087da9…”。

两条都走完了签门与门检查的完整链路，不是只测函数。

定级理由：canonical 结论行自相矛盾，签门退出 0，门检查退出 0，与第五轮 P1 属同一类（同一行 pass 后的阻塞 caveat 未 fail-closed）。第五轮的字面词表已闭合，但性质未闭合，故记 P1，本轮 fail。

改法：把 pass 后的 tail 从黑名单改成白名单或语法，只允许空、句末标点、P2 遗留说明、明确的零值说明；出现数字大于 0 的严重度词（重大、致命、P0、P1、阻断、未收口、未解决、阻塞、未闭合等）或任何未知断言时返回 null。再加属性型回归：对严重度词表做笛卡尔积生成输入，断言 pass 加非零严重度一律 null。

## 四、P2（6 项）

### P2-1 行首列表项、引用块与下一行的阻塞语句不参与判定

位置：scripts/gate-check.ts:501 只剥标题与行首加粗，不剥列表符与引用符；:507-515 的候选只在行首匹配；:490-541 只看结论行。

| 输入（两行，\n 表示换行） | 实测 |
| --- | --- |
| 结论：pass\n- 结论：fail，仍有 1 个 P0 未闭合 | pass |
| 结论：pass\n> 结论：fail，仍有 1 个 P0 未闭合 | pass |
| 结论：pass\n但仍有 1 个 P0 未闭合 | pass |

影响：报告作者可以在正文另起一行、列表或引用里写阻塞结论，机器仍读 pass；人读到的文本与门读到的不一致。第五轮 P2-1 仍在，且新增了“下一行 caveat”这一变体。

改法：匹配前剥离开头的列表符、引用符、序号与加粗；或规定结论只能出现在唯一 canonical 行，并在门规范里写明其他位置的结论不计。

### P2-2 同义结论仍未纳入候选

位置：scripts/gate-check.ts:504 的主正则只认 结论、判定（可带“审计”前缀），:507-510 的候选也只认这两种；没有 最终判定、最终结论、审计意见、结果。

| 输入（两行） | 实测 |
| --- | --- |
| 结论：pass\n最终判定：fail | pass |
| 结论：pass\n结果：fail | pass |
| 结论：pass\n最终结论：fail | pass |
| 结论：pass\n审计意见：不通过 | pass |

第五轮 P2-2 仍在。改法：把这些同义词加入候选；候选出现但解析不出唯一结论时按歧义 null。

### P2-3 围栏代码块里的 fail 被跳过，但门规范没写明

位置：scripts/gate-check.ts:492-500；tests/gate-check.spec.ts:279-283 把它固化为期望。

| 输入 | 实测 |
| --- | --- |
| 结论：pass\n\u0060\u0060\u0060md\n结论：fail\n\u0060\u0060\u0060 | pass |

这是有意的设计（围栏里的结论是示例），不是解析错误；但 docs/gates/G1.md 与 docs/gates 下的门规范没有一句话说明“围栏内容不参与判定”（对 围栏、示例 的检索没有命中相关说明）。第五轮 P2-3 作为文档缺口仍在。

改法：在门规范或审计模板里写明围栏只作示例；或只跳过标记为 example 的围栏。

### P2-4 G-08 取证文件缺 503 与 warning，与门项断言脱节

docs/gates/G1.md:22 的 G-08 要求“队列溢出报 503”；docs/gates/G1.md:202 的补记写“满了返 SERVICE_UNAVAILABLE(503) 并记 warning”。但 ev-g08 指向的 docs/gates/evidence/G1/G-08.md:20 只写“队列溢出码：SERVICE_UNAVAILABLE”，没有 HTTP 503，也没有 warning。门检查只验证据文件哈希，不验正文语义，所以这条缺口不会在门检查里报出来。第五轮 P2-4 仍在。

改法：在 G-08 证据里补一条 503 响应与 warning 日志的记录（带实现或测试行号），或把 docs/gates/G1.md:22 的表述改成与实现一致并重签。

### P2-5 审计报告未绑定门名与候选 HEAD，旧 pass 报告可复用

位置：scripts/gate-check.ts:545-571 只校验报告路径、在 HEAD、轮次、字节哈希与唯一结论，不校验报告属于哪道门、也不校验报告审计的候选是否等于当前 HEAD 的 candidate。

端到端（<tmp>/repo-attack-b）：基线签好后，改 src/core/canonical.ts 并提交，candidate 从 c181eb2691fb… 变为 81d05ef21a75…，沿用旧的 round3 pass 报告，sign-gate exit 0，artifact_hash=54b7900d6d30…，body_hash=9ca0f6ebd161…；提交后 gate-check exit 0。第五轮 P2-5 仍在。

影响：旧 pass 报告可以为与它无关的新代码变更背书，门记录看起来完整，实际没有覆盖新候选。改法：artifact 增加 audit_gate 与 audit_candidate_hash；sign-gate 从报告头或正文读取候选并与 HEAD 候选比对；或在报告模板固定写 candidate=<hash>，由 gate-check 校验。

### P2-6 正常清零写法被误杀

位置：scripts/gate-check.ts:529-535。

| 输入（单行） | 实测 | 性质 |
| --- | --- | --- |
| 结论：pass（致命=0） | null | 误杀 |
| 结论：pass（P0/P1 均为 0） | null | 误杀 |
| 结论：pass（P0 已全部闭合） | null | 误杀 |
| 结论：pass（P2 遗留 3 条，不阻塞签门） | null | 误杀 |

tests/gate-check.spec.ts:242 明确期望“结论：**pass**（0 致命）”为 pass，所以“0 致命”被接受、“致命=0”反而不被接受，清零写法不一致；“不阻塞签门”里的“阻塞”也被当成阻塞线索。第五轮 P2-6 仍在。

这些是 fail-closed，不构成绕过；但正常结论被误杀，报告作者只能改写措辞，容易诱发为了过门而改结论。改法：先归一化清零表达（X=0、0 X、0 个 X、X 均为 0、无 X），再判 P0/P1；“已全部闭合”视为清零；“不阻塞”不应命中阻塞。

## 五、端到端签门试验（第 4 项）

临时目录 <tmp> 下建了三个 clone：repo-baseline、repo-attack-a、repo-attack-b；主仓库未参与，临时目录不写进主仓库。

| 试验 | 操作 | 结果 |
| --- | --- | --- |
| 基线 | 把 G1 的 audit_round 改成 3、audit_report 指向 docs/audits/S1-independent-audit-round3.md，提交后签门 | sign-gate exit 0，candidate=c181eb2691fb…，artifact_hash=8f4e7f7d4198…，body_hash=9c391974cdc1…，13 份证据、89 个文件；提交后 gate-check exit 0 |
| 攻击 A | round9 报告写 结论：pass — 但仍有 1 个 P0 未闭合 | sign-gate exit 1，报“审计报告里找不到唯一结论行，不能拿它当门记录依据: docs/audits/S1-independent-audit-round9.md”；G1.md 签前签后字节相同 |
| 攻击 B | 基线后改 src/core/canonical.ts 并提交，沿用旧 round3 pass 报告 | sign-gate exit 0，artifact_hash=54b7900d6d30…，body_hash=9ca0f6ebd161…；提交后 gate-check exit 0 |
| 攻击 C | round9 报告写 结论：pass（未收口） | sign-gate exit 0，artifact_hash=373560a6bd64…，body_hash=9548500fb8db… |
| 攻击 D | round9 报告写 结论：pass — 重大 3 | sign-gate exit 0，artifact_hash=929d83bfd289…，body_hash=216d5a087da9…；提交 914d4f3 与 da282ff 后 gate-check exit 0 |

攻击 A 被拒，说明第五轮点名的 P0 同行 caveat 已修复。攻击 B 是 P2-5，攻击 C 与攻击 D 是 P1-1：三者都走完了写盘与读回，不是只在函数层面成立。

## 六、类型检查与测试（第 5 项）

- tsc --noEmit：exit 0。
- 全量 vitest：10 failed | 285 passed（295），32 个测试文件里 1 个失败文件（tests/gate-check.spec.ts）、31 个通过文件。10 个失败全部在 tests/gate-check.spec.ts，首个断言均为“审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…”，即 G1 的 audit_report_sha256 占位 0。除此之外没有失败文件，与任务给出的预期一致。
- 定向 vitest run tests/gate-check.spec.ts -t "阻塞项 caveat"：1 passed | 34 skipped，说明第五轮新增的 caveat 用例本身通过。
- 10 红是 G1 未重签的早退，不是本轮 P1 的测试失败；重签后应复核这 10 个用例转绿。

## 七、审计边界

- 主仓库只读：未改业务代码、docs/gates、门记录，未签门、未提交、未推送。唯一写出的文件是本报告。
- 审计期间主仓库出现并行 S2 审计的未跟踪报告 docs/audits/S2-independent-audit-round10.md，不属于本报告；scripts/sign-gate.ts:12 的 assertClean 要求工作树干净，重签前需要先处理它。
- 临时克隆与试验脚本都在 <tmp> 下，主仓库工作树只多了本报告与上述并行报告。

## 八、执行过的验证命令与输出摘要

| 命令 | 输出摘要 |
| --- | --- |
| git rev-parse HEAD；git status --porcelain | HEAD=0919589b0336aaf462edd72bf641cb5feef9520b；审计开始时 status 为空 |
| node scripts/gate-check.ts docs/gates/G1.md | 门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…；exit 1 |
| 结构核对脚本（导出 GATE_SPECS、checkBodyEvidenceTable、checkBodyInvariants） | items=13、evidenceMap=13、evidenceFiles=13、index=13、bodyRows=13、bodyInvRows=4；invariants_hash 一致；13 份证据 9 份一致、4 份不一致 |
| <tmp>/conclusion-matrix.mjs；<tmp>/extra-cases.mjs | 必测 4 例符合；9 个指定词全部 null；重大/阻断/未收口/未解决 均 pass；同义结论、列表、引用、下一行 caveat、围栏 fail 均未拦截 |
| tsc --noEmit | exit 0 |
| vitest run | 10 failed | 285 passed（295）；1 failed | 31 passed（32）个测试文件；失败全在 tests/gate-check.spec.ts，首因 audit_report_sha256 占位 0 |
| vitest run tests/gate-check.spec.ts -t "阻塞项 caveat" | 1 passed | 34 skipped |
| <tmp>/repo-baseline：sign-gate；提交后 gate-check | sign-gate exit 0，candidate=c181eb2691fb…，artifact_hash=8f4e7f7d4198…，body_hash=9c391974cdc1…；gate-check exit 0，13 项必过、13 份证据 |
| <tmp>/repo-attack-a：结论：pass — 但仍有 1 个 P0 未闭合 | sign-gate exit 1，报“审计报告里找不到唯一结论行…”；G1.md 字节未变 |
| <tmp>/repo-attack-b：改 src/core/canonical.ts 后沿用旧 pass 报告 | sign-gate exit 0，candidate=81d05ef21a75…，artifact_hash=54b7900d6d30…，body_hash=9ca0f6ebd161…；gate-check exit 0 |
| <tmp>/repo-attack-a：结论：pass（未收口） | sign-gate exit 0，artifact_hash=373560a6bd64…，body_hash=9548500fb8db… |
| <tmp>/repo-attack-a：结论：pass — 重大 3 | sign-gate exit 0，artifact_hash=929d83bfd289…，body_hash=216d5a087da9…；提交 914d4f3、da282ff 后 gate-check exit 0 |
