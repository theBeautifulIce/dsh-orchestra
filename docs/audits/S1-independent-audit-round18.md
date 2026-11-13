# S1 第十八轮独立审计报告

门：G1

候选提交：e35eb6eebbd952faaafd934102bf9e151b287f50

结论：fail

计数：P0=1，P1=2，P2=4。

## 一、审计对象与基线

- 候选提交 e35eb6e 的改动范围：`scripts/gate-check.ts` +87/−14、`tests/gate-check.spec.ts` +72/−14，另加 `docs/audits/S1-independent-audit-round17.md` 与 `docs/audits/S2-independent-audit-round21.md` 两份历史报告；`git diff e35eb6e^ e35eb6e -- src` 输出为空，`src/` 零改动。
- 静态检查：`D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit`，exit 0。
- 全量测试：`D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run`，32 个文件、326 例、315 passed / 11 failed、exit 1；11 红全部是预签态 fixture 在 `audit_report_sha256=0*64` 处早退（如 `tests/gate-check.spec.ts:196`、`:217`），与给定基线一致。
- 主仓预签态：对两个门记录运行门检查，均在审计报告 sha 处 exit 1（首个 `0…0 != 50ba1b13…`，第二个 `0…0 != c9cef2e4…`），属预期。
- 工作树：审计开始时 `git status --porcelain` 仅本报告未跟踪；本轮只写本文件。
- 攻击与端到端均在 `%TEMP%` 下的 clone 完成，`node_modules` 用目录联接指向主仓，基线均为 e35eb6e：`C:/Users/ASUS/AppData/Local/Temp/dsh-audit-r18`（P1-1 端到端）、`C:/Users/ASUS/AppData/Local/Temp/dsh-audit-r18-p0`（P0 端到端）、`C:/Users/ASUS/AppData/Local/Temp/dsh-audit-r18-ctl`（控制组）、`C:/Users/ASUS/AppData/Local/Temp/dsh-audit-r18-h`（单元 harness；为调用内部函数临时加 export，只改 clone）。
- 预签态证据索引：13 份证据中 7 份与 HEAD 一致、6 份不一致（ev-epoch 7826… vs 6162…、ev-g08 a50e… vs 2f2a…、ev-g14 3b2e… vs 7869…、ev-g15 db16… vs 334f…、ev-gatecheck c612… vs 1f2e…、ev-migrate b3ad… vs 80ca…）。`scripts/sign-gate.ts:27-32` 按 HEAD 重算并回填；2.1 的签门 exit 0 证明刷新路径可用，属预签态状态，不计缺陷。

## 二、端到端复现

### 2.1 P0 端到端（clone dsh-audit-r18-p0）

恶意报告 `docs/audits/S1-independent-audit.md`：

~~~text
门：G1
候选提交：e35eb6eebbd952faaafd934102bf9e151b287f50
结论：pass

本报告不通过（P0 1 条）。
~~~

门记录顶部结论行后追加同一句 `本报告不通过（P0 1 条）。`；提交 `3bd4e86`（2 files changed，+6/−161）。

命令与结果：

~~~text
cd C:/Users/ASUS/AppData/Local/Temp/dsh-audit-r18-p0
D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G1.md
# 第一次 exit 1：工作树有未提交改动，门记录不能对着脏树签：?? setup.mjs
# 删除 setup.mjs 后重跑：
# 重签完成：证据 13 份，candidate=95e0805df1a1…，artifact_hash=ac6c615e2476…，body_hash=0f2ada455a42…，改动文件 115 个
# exit 0；提交 b64f3b4
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md
# gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=ac6c615e2476… body_hash=0f2ada455a42…）
# exit 0
~~~

签后可见文本：报告为 `结论：pass` 加 `本报告不通过（P0 1 条）。`；门记录正文为 `- 结论：**pass**（13 项必过全过，失败项为空，无 run）` 加 `本报告不通过（P0 1 条）。`。

### 2.2 P1-1 端到端（clone dsh-audit-r18）

历史：`78cdc32` 恶意报告、`3451e9f` 签门、`e7c2bf6` 门正文注入、`e16fda6` 重签。报告与门正文都含一条干净 `结论：pass` 行和一条包裹型可见否定行 `【结论：fail】`。

~~~text
cd C:/Users/ASUS/AppData/Local/Temp/dsh-audit-r18
D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G1.md
# 重签完成：证据 13 份，candidate=95e0805df1a1…，artifact_hash=6c87501e0450…，body_hash=09d355187370…，改动文件 115 个
# exit 0
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md
# gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=6c87501e0450… body_hash=09d355187370…）
# exit 0
~~~

签后报告可见 `结论：pass` 与 `【结论：fail】`，门记录正文同样可见这两句；门检查仍通过。

### 2.3 控制组（clone dsh-audit-r18-ctl，每次 reset 到 e35eb6e）

- 正向：报告只含绑定行与裸 `结论：pass`；提交 `089db57`；签门 exit 0（artifact_hash=e71962ea172b…，body_hash=6ecd283acf00…）；提交 `39807ff`；门检查 exit 0。合法阳性对照未被误杀。
- 负向：报告结论行改为否定；提交 `4fab06c`；签门 exit 1。
- 过严对照：报告结论行为带说明尾巴的肯定；提交 `0950201`；签门 exit 1。两条异常如下：

~~~text
负向 @ scripts/gate-check.ts:1325
审计报告结论与门记录结论不符：报告=fail，门记录=pass

过严 @ scripts/gate-check.ts:1323
审计报告里找不到唯一结论行，不能拿它当门记录依据: docs/audits/S1-independent-audit.md
~~~

## 三、P0（1 条）

### P0-1 可见中文否定句被解析成接受

- 位置：`scripts/gate-check.ts:630-650`（`FAIL_VERDICT` 尾部 lookahead 在 :631，`visibleFailStatement` 的 boundary 在 :634）、`:652-701`（`auditConclusionOf`，非 strict 分支 :664-667、第二结论计数 :686-687）、`:705-714`（`bodyConclusionOf`）。
- 机制：`FAIL_VERDICT` 后的 lookahead 只接受空白、句读、`】`、`）`、`*`、破折号、冒号、连字符或“需/应/已/了/的”，不接受左括号 `（`、`【` 或斜杠 `/`；`visibleFailStatement` 的 boundary 只认行首或标点，行首有“复核意见”“本人认为”等前缀时不会向后滑动；`inlineFailConclusion` 只认“结论：”形式，不认“结论为”“审计结果：”“最终判定为”。因此一条干净的 strict 行 `结论：pass` 之后追加 `本报告不通过（P0 1 条）。`，`auditConclusionOf` 仍返回 `pass`。
- 载荷（均追加在裸 `结论：pass` 行之后的独立段落）：

~~~text
本报告不通过（P0 1 条）。
本报告不通过(P0 1)
本报告不通过……
复核意见 本报告不通过
本人认为本报告不通过
结论为不通过（P0 1 条）
结论为 fail（P0 1 条）
审计结果：不通过（P0 1 条）
最终判定为不通过（P0 1 条）
本报告不通过【P0 1】
本报告不通过/不合格
~~~

- 实际：11 条全部返回 `pass`；代表句 `本报告不通过（P0 1 条）。` 的 `visibleFailStatement` 为 `false`；jsdom 可见文本为 `结论：pass 本报告不通过（P0 1 条）。`。端到端见 2.1：签门 exit 0、门检查 exit 0。
- 期望：返回 `null`，签门 exit 1，报告不能被当作通过依据。
- 端到端证据：`dsh-audit-r18-p0`，提交 `b64f3b4`，artifact_hash=ac6c615e2476…，body_hash=0f2ada455a42…。

## 四、P1（2 条）

### P1-1 包裹型与收尾标点型可见否定行

- 位置：`scripts/gate-check.ts:634`（boundary 无前缀通配）、`:659`（`inlineFailConclusion` 的尾部 lookahead 不含 `】」「”》……` 等收尾符）、`:686-687`（只把 strict/bare 行计为第二结论）、`:705-714`（`bodyConclusionOf` 只在行首匹配正式结论）。
- 机制：`【结论：fail】` 整行不以结论词开头，strict=false；boundary 在行首失败后不能滑动到 `结论`；`inlineFailConclusion` 虽能匹配 `结论：fail`，但 fail 后紧跟 `】` 不在尾部 lookahead 中，故 `inlineFail=false`。于是顶层只剩那条干净的 pass strict 行。`本报告不通过」` 同理：`visibleFailStatement` 能命中 `本报告不通过`，但尾部 `」` 不在 lookahead 中。单独一条 `结论：fail】` 会走 strict，尾部非法返回 `null`，所以攻击必须保留一条干净 pass 行、再加一条包裹型否定行。
- 载荷（均追加在裸 `结论：pass` 行之后）：

~~~text
【结论：fail】
「结论：fail」
“结论：fail”
《结论：fail》
（结论：fail）
［结论：fail］
<结论：fail>
**「结论：fail」**
本报告不通过」
本报告不通过……
本报告不通过》
本报告不通过>
本报告不通过』
本报告不通过〕
~~~

- 实际：以上全部返回 `pass`；`visibleFailStatement` 对 `【结论：fail】`、`「结论：fail」`、`本报告不通过」` 均为 `false`。`【 结论：fail 】`（fail 后有空格）返回 `null`，因为 `inlineFailConclusion` 的尾部空白成立。端到端见 2.2：签门 exit 0、门检查 exit 0，报告与门正文都可见 `【结论：fail】`。
- 期望：返回 `null`，签门 exit 1。
- 端到端证据：`dsh-audit-r18`，提交 `e16fda6`，artifact_hash=6c87501e0450…，body_hash=09d355187370…。

### P1-2 关键词内空白与实体空白拆词

- 位置：`scripts/gate-check.ts:553`（只按换行符拆行）、`:1232-1249`（`normalizeAuditLine` 只 trim，不折叠词内空白，也不把 CR/VT/FF 当行界）、`:659` 与 `:637`（结论词要求连续）。
- 机制：markdown-it 把空格、Tab、NBSP、全角空格、实体空格、U+2028/U+2029、CR/VT/FF 都保留在同一行文本里；`normalizeAuditLine` 剥掉 Cf/Mn/Me 后只做 trim，词内空白仍在；`inlineFailConclusion` 与 `visibleFailStatement` 都要求“结”与“论”连续，于是 `结 论：fail` 这类在浏览器里可读成否定的文本不触发任何否定检测。
- 载荷（均追加在裸 `结论：pass` 行之后）：

~~~text
结 论：fail
结  论：fail
结　论：fail（U+3000）
结	论：fail（Tab）
结&#9;论：fail
结&#160;论：fail
结&#8194;论：fail
结&#8239;论：fail
结&#13;论：fail
结&#11;论：fail
结&#12;论：fail
结（U+2028）论：fail
结（U+2029）论：fail
~~~

- 实际：以上全部返回 `pass`。`结&#10;论：fail` 与字面换行形态返回 `null`，因为它们在拆行阶段被拆成两行，相邻两行拼接能补回“结论”。`&#13;`、`&#11;`、`&#12;` 解码后不拆行，浏览器按换行/空白渲染。
- 期望：返回 `null`。该条为单元级确定性漏判，端到端路径与 P0-1/P1-1 相同（一条 strict pass 行加一条非 strict 否定行），故未单独再建 clone。

## 五、P2（4 条）

### P2-1 三行拆词

- 位置：`scripts/gate-check.ts:670-675`（只拼接相邻两行）。
- 载荷：`结`、换行、`论`、换行、`：fail`，追加在裸 `结论：pass` 行之后。
- 实际：返回 `pass`；四行拆词 `结`、`论`、`：`、`fail` 返回 `null`。
- 期望：返回 `null`。三行在渲染上是三个独立行，连续性弱于两行拆词，故定 P2。

### P2-2 图片 alt 的实体与引号变体

- 位置：`scripts/gate-check.ts:607-610`（只对 image 的原始 alt 文本调用 `visibleFailStatement`，且不把 alt 并入可见行）。
- 载荷：

~~~text
![结论：fail](x)
![结论&#58;fail](x)
![“结论：fail”](x)
![（结论：fail）](x)
~~~

- 实际：第一条返回 `null`（命中 ambiguous）；后三条返回 `pass`。alt 在部分渲染器/读屏器中可见，最终是否可见取决于呈现方式，故定 P2。
- 期望：后三条也应 `null`。

### P2-3 形似冒号

- 位置：`scripts/gate-check.ts:1240`（只把 U+FE13、U+FE55 归一成 ASCII 冒号）、`:659` 与 `:637`（冒号按 ASCII 字面匹配）。
- 载荷：`结论∶fail`（U+2236）、`结论ːfail`（U+02D0）、`结论꞉fail`（U+A789）、`结﹕论：fail`（U+FE55 词内）。
- 实际：以上四种返回 `pass`；`结论﹕fail`（U+FE55 直接作冒号）与 `结论：fail`（U+FE13）返回 `null`。
- 期望：返回 `null`。人工阅读时这些冒号与 ASCII 冒号几乎无差别，但归一表未覆盖，故定 P2。

### P2-4 合法 pass 尾巴被过严拒绝（第 17 轮 P2-5 未闭合）

- 位置：`scripts/gate-check.ts:1258-1277`（`validConclusionTail`）、`:1279-1297`（`onlyCleanCounts`）、`:1323`（拒绝点）。
- 载荷：`结论：pass（13 项必过全过，失败项为空）`、`结论：pass（P0/P1 清零，P2 遗留 3 条）`。
- 实际：返回 `null`；签门 exit 1，异常在 `scripts/gate-check.ts:1323`。`结论：pass（P0=0，P1=0，P2=3）` 与裸 `结论：pass` 返回 `pass`。
- 期望：带合法说明尾巴的 pass 结论应被接受。这是过严误杀，不是 fail-open，故定 P2。

## 六、其余攻击面实测

以下载荷均追加在裸 `结论：pass` 行之后，结果来自 `auditConclusionOf`；`null` 表示拒绝，`pass` 表示接受。

~~~text
面                         载荷                                             结果
引用块 0/1/2/3/4 空格      >结论：fail / > 结论：fail / ...                  null
引用块 5 空格              >     结论：fail                                pass（代码块，不可见，正确）
引用块 Tab                 >	结论：fail                                      null
嵌套引用 / 引用内标题      > > 结论：fail / > ## 结论：fail                  null
引用内列表 / 惰性续行      > - 结论：fail / 引用首行后直接结论：fail          null
引用内围栏 / 5 空格缩进    > 围栏代码块 / >     结论：fail                  pass（代码，不可见，正确）
行内代码拆词               结论`:`fail / 结`论`：fail / 结论`：`fail         null
单边反引号                 结论`：fail（缺右反引号）                         pass（可见字面反引号，非结论）
跨行内联代码               结论`（跨行）:`fail                                null
不可见字符 U+034F/FE0F    直接字符与 &#847; / &#65039; 实体                  null
不可见字符 U+3164/115F    直接字符与实体                                    null
不可见字符 FFA0/200B/200E  直接字符与实体                                    null
不可见字符 FEFF/2060/00AD  直接字符与实体                                    null
不可见字符 180E/2800/17B4  直接字符与实体                                    null
软换行                    结（LF）论：fail / 结&#10;论：fail                 null
形似冒号 FE13/FE55        结论（FE13）fail / 结论（FE55）fail               null
形似冒号残项              见 P2-3                                            pass（P2-3）
实体空白残项              见 P1-2                                            pass（P1-2）
图片 alt                   ![结论：fail](x) / 实体版 / 引号版                 裸 alt null；变体 pass（P2-2）
链接 title                 title 携带结论行                                  pass（title 不可见，正确）
引用定义（段首）           段首定义携带结论行                                pass（不可见，正确）
引用定义（列表/引用内）    列表或引用内定义携带结论行                        pass（不可见，正确）
引用定义（段落中间）       段落中间定义携带结论行                            null（方括号守卫，fail-closed）
多行 title                 title 跨行携带结论行                              pass（不可见，正确）
原始 HTML / details        <div>结论：fail</div> / <details>...               null（fail-closed）
CDATA / 注释 / PI          CDATA、注释、处理指令                             pass（不可见，正确）
表格                       | 结论：fail | / | 【结论：fail】 |                前 null；后 pass（P1-1）
setext 标题                结论：fail 下加 ===                               null
任务列表                   - [ ] 本报告不通过。                              null
poison 追加时机            围栏 artifact 后追加 / EOF 追加                   pass（与位置无关，P1-1）
~~~

## 七、第 17 轮 P1/P2 闭合复核

| 上轮项 | 本轮实测 | 状态 |
| --- | --- | --- |
| P1-A 引用块预处理清空可见行 | 0–4 空格、Tab、嵌套、引用内标题/列表、惰性续行均拒绝；5 空格、围栏、5 空格缩进代码接受（不可见） | 闭合 |
| P1-B 行内代码内容丢弃 | 结论加行内代码冒号、结加行内代码论、跨行内联均拒绝；单边反引号接受（可见字面反引号） | 闭合 |
| P1-C 不可见字符拆词 | U+034F、FE0F、3164、115F、FFA0、200B、200E、FEFF、2060、00AD、180E、2800、17B4、17B5 及对应实体均拒绝 | 闭合（但空白拆词另见 P1-2） |
| P2-1 正文顶部结论未绑定 | 顶部改否定→拒绝；第二条正式结论→拒绝；非行首包裹否定→正文仍接受 | 部分闭合（见 P1-1） |
| P2-2 同根因过严 | 裸结论行与带 P0/P1/P2 计数的尾巴接受；说明性尾巴仍拒绝 | 未完全闭合（见 P2-4） |
| P2-3 U+FE55 形似冒号 | FE13、FE55 直接作冒号均拒绝；U+2236、U+02D0、U+A789、FE55 词内仍接受 | 部分闭合（见 P2-3） |
| P2-4 软换行/实体换行拆词 | LF、&#10;、两行拼接均拒绝；CR、VT、FF、三行拆词仍接受 | 部分闭合（见 P1-2、P2-1） |
| P2-5 pass 尾巴只认固定清零话术 | 说明性尾巴仍拒绝，签门 exit 1 | 未闭合（见 P2-4） |
| P2-6 图片 alt 条件性 | 裸 alt 拒绝；实体、引号、括号变体仍接受 | 部分闭合（见 P2-2） |

## 八、门记录正文绑定实测

读主仓门记录，改后重算 `body_hash`，调 `verifyGateRecord(text,{allowDirty:true})`：

- A 顶部 `- 结论：**pass**` 改成否定，artifact 仍为肯定：`bodyConclusionOf` 返回 fail；`verifyGateRecord` 拒绝。
- B 追加第二条正式肯定结论：`bodyConclusionOf` 返回 `null`；`verifyGateRecord` 拒绝。
- E 追加 `> 结论：fail`（引用块）：归一后成为第二条结论，`bodyConclusionOf` 返回 `null`；拒绝。
- F 追加第二条正式否定结论：`bodyConclusionOf` 返回 `null`；拒绝。
- C 追加 `【结论：fail】`：`bodyConclusionOf` 仍返回 pass；正文检查放行，随后才在审计报告 sha 处拒绝。
- D 追加 `本报告不通过」`：同上，正文检查放行。
- G 追加三行拆词：同上，正文检查放行。

~~~text
A: 门记录正文结论与 GateArtifact 不符：正文=fail，artifact=pass
B/E/F: 门记录正文结论行缺失或不唯一
C/D/G: 审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…
~~~

A、B、E、F 满足“正文否定要拒绝、两条正式结论要拒绝”；C、D、G 说明正文绑定只覆盖行首正式结论行，非行首可见否定仍可夹带（与 P1-1 同根因）。

## 九、其他观察（不计 P0/P1/P2）

- 旧解析链 733–1230 行（`auditTopLevelLines`、`decodeHtmlEntitiesForInspection`、`stripHiddenAuditBlocks` 等）已不在活路径；活路径是 `:539`、`:652`、`:705`、`:718`、`:1301`。建议后续清理，属代码卫生。
- 预签态证据索引 6/13 与 HEAD 不一致；签门按 HEAD 重算（`:27-32`）并在 2.1/2.2 得到 exit 0，说明刷新路径有效，不计缺陷。
- 全量测试 11 红是预签态 fixture 在审计 sha 0*64 处早退，与本轮候选改动无关；不计缺陷。

## 十、判定

依据：`scripts/gate-check.ts` 的 `renderedAuditLines`（539-626）、`visibleFailStatement`（633-650）、`auditConclusionOf`（652-701）、`bodyConclusionOf`（705-714）、`auditBindingOf`（718-731）、`verifyGateRecord`（1389-1472）与 `scripts/sign-gate.ts` 的签前自检（81），加上第二、六、八节的实测与 exit code。

P0=1（可见中文否定句被接受，报告与门正文端到端均 exit 0）；P1=2（包裹/收尾标点的可见结论行；关键词内空白拆词）；P2=4（三行拆词、图片 alt 变体、形似冒号、pass 尾巴过严）。
