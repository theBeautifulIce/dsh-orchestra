# S1 独立审计（第 17 轮）
门：G1
候选提交：e8ebafe94f9c3442c9b195a9f40f560672316ebe
结论：fail

审计对象：D:/aboutAI/dsh-orchestra，HEAD e8ebafe94f9c3442c9b195a9f40f560672316ebe（审计开始时 git status --porcelain 为空）。
边界：只审计，未改主仓代码、未签门、未提交；本文件是唯一写入主仓的文件。
环境：node v26.13.1（D:/NodeJs/node.exe）、markdown-it 15.0.3、jsdom 29.1.1、vitest 4.1.8。
方法：读 scripts/gate-check.ts、scripts/sign-gate.ts、docs/gates/G1.md；在 %TEMP%/dsh-audit-r17 用 harness 直接调用 auditConclusionOf，并用 markdown-it + jsdom 对照“渲染后可见文本”；在 %TEMP%/dsh-audit-r17-e2e 的本地 clone 做端到端签门、负向控制、正向控制、脏树控制。

## 结论与计数

P0=0，P1=3，P2=6。

存在 P1，故本门结论为 fail。三条 P1 是同一类问题的三个独立根因：**渲染后可见的 fail 结论在判定前被丢弃，同时顶层可见 pass 被采信**。三条均在单元层复现；P1-C 另做了端到端签门复现（sign-gate exit 0、gate-check exit 0）。

## P1 发现

### P1-A 引用块预处理把可见结论行整行清空（fail-open）

文件：scripts/gate-check.ts:581-585（预处理），相关 539-556、578-580。

````text
[P1-A-1] 载荷：结论：pass\n\n> 引用\n>    结论：fail
实际：pass    期望：null
渲染：<p>引用\n结论：fail</p>（fail 可见，与顶层 pass 构成两条结论）

[P1-A-2] 载荷：结论：pass\n\n> 引用\n>     结论：fail
实际：pass    期望：null
渲染：<p>引用\n结论：fail</p>（同上）

[P1-A-3] 载荷：结论：pass\n\n> - 项\n>    结论：fail
实际：pass    期望：null
渲染：<blockquote><ul><li>项\n结论：fail</li></ul></blockquote>

[P1-A-4] 载荷：结论：pass\n\n> - 项\n>     结论：fail
实际：pass    期望：null
渲染：<li>项\n结论：fail</li>

[P1-A-5] 载荷：结论：pass\n\n> - 项\n>      结论：fail
实际：pass    期望：null
渲染：<li>项\n结论：fail</li>
````

根因：581-585 对每个引用行取 `^(\s*>\s?)([\s\S]*)$`，去掉 `> `（至多一个空格）后，只要剩余部分以 3 个以上空格或 Tab 开头且不含方括号，就把整行替换为空。markdown-it 实际把这些行当作**引用段落/列表项的续行**渲染（缩进代码不能打断段落），所以 fail 在渲染结果里是可见的。578-580 的注释把“引用块内四空格”一律当代码，忽略了“该行是否在续写段落”这一上下文；而且阈值是剩余 3 空格，比注释所说的四空格更宽。

影响方向：fail-open。顶层 pass 被采信，可见 fail 被清掉。反向 bq-4sp-pass-only（见 P2-2）也因同一行被清空而只剩 fail，属过严一侧。

### P1-B 行内代码内容整段丢弃，可见的“结论：fail”被拆开（fail-open）

文件：scripts/gate-check.ts:601-618（inline children 处理；617 注释明确 code_inline 不产生正文）。

````text
[P1-B-1] 载荷：结论：pass\n\n结论`:`fail
实际：pass    期望：null
渲染：<p>结论<code>:</code>fail</p>，可见文本“结论:fail”

[P1-B-2] 载荷：结论：pass\n\n结论`：`fail
实际：pass    期望：null
渲染：可见文本“结论：fail”

[P1-B-3] 载荷：结论：pass\n\n结`论`：fail
实际：pass    期望：null
渲染：结<code>论</code>：fail，可见文本“结论：fail”
（buffer 只剩“结：fail”，因为 code_inline 的“论”被整体丢弃，而不是只去掉格式）

[P1-B-4] 载荷：结论：fail\n\n结论`:`pass
实际：fail    期望：null
渲染：可见“结论:pass”，pass 被丢弃（过严一侧）

[P1-B-5] 载荷：结论`:`fail
实际：null    期望：fail
渲染：可见“结论:fail”，但判定器读不到（单边漏检）
````

根因：601-618 只把 text/text_special 拼进 buffer，code_inline 既不贡献文字也不触发 flush；于是行内代码两边的文字被直接拼接或断开，渲染器里连续的“结论：fail”在判定器里不存在。

### P1-C 非 Cf 的不可见字符夹在结论词中，逃过 strict 与 inlineFail（fail-open）

文件：scripts/gate-check.ts:1183-1193（normalizeAuditLine 只剥 \p{Cf}）。

````text
[P1-C-1] 载荷：结论：pass\n\n结<U+034F>论：fail
实际：pass    期望：null
渲染：<p>结͏论：fail</p>（U+034F COMBINING GRAPHEME JOINER，不可见；浏览器显示“结论：fail”）

[P1-C-2] 载荷：结论：pass\n\n结&#847;论：fail
实际：pass    期望：null
渲染同上（数字实体解码后是 U+034F）

[P1-C-3] 载荷：结论：pass\n\n结论<U+034F>：fail
实际：pass    期望：null
渲染：结论͏：fail（不可见字符在结论词与冒号之间）

[P1-C-4] 载荷：结论：pass\n\n结<U+FE0F>论：fail
实际：pass    期望：null
渲染：U+FE0F VARIATION SELECTOR-16，Mn，不可见

[P1-C-5] 载荷：结论：pass\n\n结<U+3164>论：fail
实际：pass    期望：null
渲染：U+3164 HANGUL FILLER，Lo，不可见

[P1-C-6] 载荷：结论：pass\n\n结<U+115F>论：fail
实际：pass    期望：null
渲染：U+115F HANGUL CHOSEONG FILLER，Lo，不可见

[P1-C-7] 载荷：结论：pass\n\n结<U+FFA0>论：fail
实际：pass    期望：null
渲染：U+FFA0 HALFWIDTH HANGUL FILLER，Lo，不可见
````

根因：normalizeAuditLine 只做 raw.replace(/\p{Cf}/gu, '')。U+034F 是 Mn，U+FE0F 是 Mn，U+3164/U+115F/U+FFA0 是 Lo，都不在 Cf 类别；strict、conclusionText、inlineFailConclusion 都要求“结论”连续出现，隐形字符把词拆开后就全部失配，只剩顶层 pass。

控制（证明“剥 Cf”的口径本身有效，缺口只在非 Cf 码位）：

````text
[对照-1] 结论：pass\n\n结论<U+200B>：fail  → null（U+200B ZWSP 是 Cf，被剥掉后毒化成功）
[对照-2] 结论：pass\n\n结论<U+200E>：fail  → null（U+200E LRM 是 Cf）
````

端到端复现（P1-C，临时 clone，不改主仓）：

1) `%TEMP%\dsh-audit-r17-e2e` 下 `git clone --no-hardlinks D:/aboutAI/dsh-orchestra`，HEAD=e8ebafe…；`mklink /J node_modules <主仓>\node_modules`。说明：任务建议的 `git clone --local` 在该临时目录报 `fatal: failed to create link … Improper link`，改用同盘本地克隆 `--no-hardlinks`（仍不触碰主仓）。
2) 新增 `docs/audits/S1-verification-sample.md`（路径不含数字，轮次按 1 计，与 artifact 的 audit_round=1 一致），正文含：

````text
- 门：G1
- 候选提交：e8ebafe94f9c3442c9b195a9f40f560672316ebe

结论：**pass**

本报告正文另有一条可见结论，其中“结论”二字之间夹入 U+034F（COMBINING GRAPHEME JOINER，渲染不可见）：

结<U+034F>论：fail
````

（实际文件该行是 `结` + 原始 U+034F + `论：fail`；上面用 `<U+034F>` 标出不可见字符。）
3) 提交该报告；把 G1.md 的 `"audit_report"` 改为该路径并提交（此时 G1 为待签态）；`D:/NodeJs/node.exe scripts/sign-gate.ts` → **exit 0**，输出 `重签完成：证据 13 份，candidate=ed5e797dbdb8…，artifact_hash=92d08f27413a…，body_hash=da5bf04d2bff…，改动文件 115 个`。G1 文件 sha256 由 `DB81DDC13BD3283AF4E20143A153AA11906575061A3D35B4F2FF675BDA905641` 变为 `E9D82CB170ACBE6608A2973F6CC345B90080BC9B68BAAEF4B3F9515C38FDC3DF`。
4) 提交签后 G1；`D:/NodeJs/node.exe scripts/gate-check.ts` → **exit 0**，输出 `gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=92d08f27413a… body_hash=da5bf04d2bff…）`；报告中 `audit_report_sha256=17f158e46cb68008c135112e8816758f14d20b2be0c6e558801bc6dd150b2683`。

端到端放行成立：可见的“结论：fail”被忽略、顶层 pass 被采信。

## P2 发现

### P2-1 正文顶部结论行未与 artifact/审计报告绑定

文件：scripts/gate-check.ts:355-386（checkBodyTable 只从 `## 必过项与证据` 起截段）、1333-1411（verifyGateRecord 未对正文的“结论：”行调用 auditConclusionOf 或做等值比对）。

````text
[P2-1] 操作：临时 clone 中把 docs/gates/G1.md 第 5 行改成：
        - 结论：**fail**（正文显示与 artifact 矛盾测试）
        artifact.conclusion 保持 "pass"。
实际：sign-gate exit 0；gate-check exit 0。
期望：正文可见结论与 artifact/审计报告不一致时拒绝签署或拒绝过门。
````

影响：门以 pass 放行，但人读门记录看到 fail（显示矛盾）。反向（正文 pass、artifact fail）会被 1363 行 `conclusion 不是 pass` 拒绝，因此不构成把失败门放行。同源缺口还包括：355-360 只取第一个 `## 必过项与证据` 区，第二个同名区的表格完全不被核对。

### P2-2 同根因的过严一侧：可见 pass/fail 被误藏

````text
[P2-2-1] 载荷：结论：fail\n\n>    结论：pass
实际：fail    期望：null（渲染 <p>结论：pass</p>，可见 pass 与可见 fail 并存）

[P2-2-2] 载荷：结论：fail\n\n结论`:`pass
实际：fail    期望：null（渲染可见“结论:pass”）

[P2-2-3] 载荷：结论`:`fail
实际：null    期望：fail（渲染可见“结论:fail”，未被采信）
````

### P2-3 形似冒号 U+FE55 不被识别

````text
[P2-3] 载荷：结论：pass\n\n结论﹕fail
实际：pass    期望：null
说明：U+FE55 SMALL COLON，渲染接近冒号；判定只认 : 与 ：。
````

### P2-4 软换行或实体换行把“结论”拆开

````text
[P2-4-1] 载荷：结论：pass\n\n结\n论：fail
实际：pass    期望：null（渲染 <p>结\n论：fail</p>，浏览器显示“结 论：fail”）

[P2-4-2] 载荷：结论：pass\n\n结&#10;论：fail
实际：pass    期望：null（同上）
````

弱形态：可见文本里“结论”被换行/空格拆断，严格读者未必把它当结论行；但与 R16 已确认的“结论\n：fail 必须毒化”同一方向。

### P2-5 pass 尾巴只接受固定清零话术，常见写法被判 null（过严，签门 false-negative）

````text
[P2-5-1] 载荷：结论：pass（13 项必过全过，失败项为空）
实际：null    期望：pass

[P2-5-2] 载荷：结论：pass（P0/P1 清零，P2 遗留 3 条）
实际：null    期望：pass

[P2-5-3] 载荷：结论：pass（P0=0，P1=0，P2=3）
实际：pass    期望：pass

[P2-5-4] 载荷：结论：fail（P0=0，P1=3，P2=5）
实际：fail    期望：fail
````

影响：合法审计报告若用“13 项必过全过，失败项为空”这类常见收口，会在 checkAuditAnchor 被判“找不到唯一结论行”，sign-gate exit 1。不是放行失败门，但会让签发流程对正常报告 false-negative。测试中发现：本次正向控制最初就用了 P2-5-1 的写法，sign-gate 因此 exit 1，改成裸 `结论：**pass**` 后才 exit 0。

### P2-6 图片 alt 中的 fail 不参与判定（条件性）

````text
[P2-6] 载荷：结论：pass\n\n![结论：fail](https://example.invalid/i.png)
实际：pass    期望：null（断图时浏览器显示 alt 文本“结论：fail”）
说明：alt 是否可见取决于图片能否加载；本轮按弱形态记 P2，不计入 P1。
````

## 第十六轮两个 P1 的复验

### P1-1（列表/引用容器首行开围栏，围栏内结论被读成顶层）——已闭合

````text
[R16-P1-1-a] 载荷：本报告可见正文的结论为不通过。\n\n- ~~~\n  结论：pass
实际：null    期望：null（可见只有散文，围栏内容不可见）

[R16-P1-1-b] 载荷：结论：fail\n\n- ~~~\n  结论：pass
实际：fail    期望：fail（只采信可见 fail）

[R16-P1-1-c] 载荷：结论：fail\n\n1. ```\n   结论：pass\n   ```
实际：fail    期望：fail

[R16-P1-1-d] 载荷：结论：fail\n\n> - ~~~\n>   结论：pass
实际：fail    期望：fail

[R16-P1-1-e] 载荷：结论：fail\n\n- > ~~~\n  > 结论：pass
实际：fail    期望：fail
````

（``` 在上列载荷中代表三个反引号。）五种容器形态均不再把围栏内的 pass 读成顶层；原第十六轮 P1-1 的攻击载荷现在返回 null 或 fail。

### P1-2（引用定义后续行被无条件隐藏）——已闭合

````text
[R16-P1-2-a] 载荷：结论：pass\n\n[foo]: /url\n  结论：fail
实际：null    期望：null（markdown-it 把两空格续行渲染为可见段落，fail 毒化）

[R16-P1-2-b] 载荷：结论：pass\n\n[foo]: /url\n\t结论：fail
实际：pass    期望：pass（该行渲染为 <pre><code>，不可见）

[R16-P1-2-c] 载荷：结论：pass\n\n[foo]: /url\n    结论：fail
实际：pass    期望：pass（四空格缩进代码，不可见）
````

原 P1-2 载荷现在返回 null；Tab/四空格形态在渲染上是代码块，pass 是正确结论。

复验结论：第十六轮两个 P1 均已闭合。但 HEAD 的整体重写让 auditTopLevelLines / maskAudit* 整条链成为死代码（只被自身引用，auditConclusionOf 已改走 markdown-it），本轮三条 P1 属于新判定路径上的独立缺陷。

## gate 结构核查（第 3 项）

1) G1.md：24 个 GATE_FIELDS 齐全，schema_version=1，13 项必过、13 份证据、正文必过项表/证据表/不变量表/例外表齐全，artifact.conclusion="pass"，audit_round=1，audit_report=docs/audits/S1-independent-audit.md，audit_report_sha256=64 个 0。当前是预签态；gate-check 在 1263 行按审计报告实际 sha256（50ba1b13cdf1b84d…）拒绝。这不算代码缺陷，但本轮无法以主仓 G1 直接跑过门检查。
2) sign-gate.ts：12 行先 assertClean；27-32 证据一律 git show HEAD 重算；33-44 回填 evidence/invariants 哈希；50-52 candidate/change_scope；54-62 前序链；64-68 审计报告从 artifact 读、git show HEAD 计算 sha256；70-79 替换 artifact 块与锚点；81 写盘前 verifyGateRecord(..., selfCheck:true)；82 才 writeFileSync。没有“跳过证据/跳过结论”的分支。
3) 哈希与同源：checkEvidence（278-310）按固定文件映射重算 HEAD 字节；checkInvariants（312-352）逐字比对固定语句与证据集合；checkBodyEvidenceTable（409-433）/checkBodyInvariants（455-479）/checkBodyTable（355-386）与 artifact 同源并防删行复制；checkCandidate（1294-1304）重算两个候选哈希；body_hash 只把 artifact_hash/body_hash/反引号 64hex 换成 `<SELF>`（482-492）。本轮未发现这些环节可绕过。
4) 反向/正向控制（临时 clone）：
   - 脏树：根目录放 dirty-scratch.txt，sign-gate **exit 1**，报 `工作树有未提交改动…?? dirty-scratch.txt`，G1 未变。
   - 负向：审计报告写可见 `结论：fail`，artifact 仍 pass；sign-gate **exit 1**，报 `审计报告结论与门记录结论不符：报告=fail，门记录=pass`（gate-check.ts:1269），G1 未变（sha256 前后相同）。
   - 正向：报告写裸 `结论：**pass**`；sign-gate **exit 0**，随后 gate-check **exit 0**（artifact_hash=6d9fb57e2f52… body_hash=d867515eb04e…）。
   - 攻击：见 P1-C 端到端，sign-gate **exit 0**、gate-check **exit 0**。
5) 核查结果：签门流程本身未发现 fail-open；实际 fail-open 在“审计报告结论解析”（P1-A/B/C）与“正文顶部结论未绑定”（P2-1）。

## 命令与退出码

````text
D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit
  exit 0

D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/gate-check.spec.ts --reporter=dot
  exit 1；Test Files 1 failed (1)；Tests 11 failed | 50 passed (61)

D:/NodeJs/node.exe scripts/gate-check.ts
  exit 1；门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…

临时 clone：
git clone --no-hardlinks D:/aboutAI/dsh-orchestra …        exit 0
mklink /J node_modules <主仓>\node_modules                  exit 0
node scripts/sign-gate.ts（P1-C 攻击报告）                   exit 0
node scripts/gate-check.ts（签后）                           exit 0
node scripts/sign-gate.ts（可见 fail 负向控制）              exit 1；G1 未变
node scripts/sign-gate.ts（纯 pass 正向控制）                exit 0
node scripts/gate-check.ts（正向控制签后）                   exit 0
node scripts/sign-gate.ts（脏树）                            exit 1；G1 未变
node scripts/sign-gate.ts（正文结论 fail、artifact pass）    exit 0
node scripts/gate-check.ts（同上签后）                       exit 0
````

vitest 的 11 例失败全部是同一原因（预签态 audit_report_sha256=0*64 与报告实际 sha 不符，scripts/gate-check.ts:1263），没有其他失败。逐条点名：

````text
1. G1 门记录通过
2. 改 candidate_hash 但锚点不动时报哈希不符
3. 证据文件的哈希对不上时指名哪一份（审计 F1）
4. evidence_index_hash 被改时指名证据索引不符
5. candidate_hash 改成别处的值时指名与候选文件不符
6. 正文必过项的内容列被改时指名不一致（审计 N-09）
7. 正文证据表的哈希被改时拒绝（审计 R3-06）
8. 正文不变量说明被改时拒绝（审计 R3-06）
9. 不变量语句被削短后即使重算哈希也拒绝（S1 第八轮 P1-3）
10. 证据文件与固定文件映射不一致时拒绝（S1 第二轮审计）
11. 正文自锚 body_hash 被改时拒绝（审计 R3-08）
````

## 复验结论

- 第十六轮 P1-1、P1-2 均已闭合，原始载荷与加严载荷都不再产生 fail-open。
- HEAD 新路径存在三条独立 P1：引用块预处理清空可见行（P1-A，5 条载荷）、行内代码内容整体丢弃（P1-B，5 条载荷）、非 Cf 不可见字符拆词（P1-C，7 条载荷）。P1-C 已端到端复现：可见“结论：fail”的报告被签成 pass，sign-gate 与 gate-check 均 exit 0。
- P2 六条：正文顶部结论未绑定（已实测）、同根因过严、U+FE55 形似冒号、软换行拆词、pass 尾巴过严、图片 alt 条件性可见。
- 本轮共 50 条对抗载荷（另有 5 条结论尾巴载荷、若干渲染对照），未发现证据哈希、候选哈希、前序链、body_hash 可直接绕过的路径。
- 主仓未改代码、未签门、未提交；临时文件均在 %TEMP% 下；本报告是唯一写入主仓的文件。
