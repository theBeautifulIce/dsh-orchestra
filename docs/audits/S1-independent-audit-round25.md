# S1 独立审计报告（round25）

门：G1
候选提交：998c89bba27aaf299e9ea6eff941048103803a96

- 审计对象：D:/aboutAI/dsh-orchestra，提交 998c89bba27aaf299e9ea6eff941048103803a96（2026-11-14 04:17:27 +0800）
- 审计范围：G1（S1 账本地基）；为核对门链与解析器，同时复核 G2
- 审计方式：只读；候选克隆到 D:/aboutAI/_audit-r25/candidate-998-v2；未修改主仓源码、门记录与证据
- 审计日期：2026-11-14
- 结论行见下一行

结论：fail

P0 3 条 / P1 2 条 / P2 2 条。G1 不能放行；G2 复核同样不通过（G2 只作补充证据，不改变 G1 结论）。

## 一、候选基线与边界

候选 998c89b 相对上一提交 a725238 只改 4 个文件：docs/audits/S1-independent-audit-round24.md、docs/audits/S1-round24-response.md、scripts/gate-check.ts、tests/gate-check.spec.ts。两道门的记录文件都不在这 4 个文件里，998c89b 没有重签 G1/G2。

- G1 记录仍是预签态：audit_round=1，audit_report=docs/audits/S1-independent-audit.md，audit_report_sha256 为 64 个 0。
- G2 记录仍是预签态：audit_round=4，audit_report=docs/audits/S2-independent-audit-round4.md，audit_report_sha256 为 64 个 0。
- 主仓在审计期间出现未提交的 scripts/gate-check.ts 改动（注释指向 S2 第三十轮，mtime 2026-11-14 04:46:59），不是本代理写入；本报告所有 sign-gate/gate-check 都在 998 的临时克隆里执行，避免主仓工作树污染。
- 克隆为 candidate-998-v2，HEAD 为 998c89b，工作树干净；node_modules 以 junction 指向主仓 node_modules；运行 Node 为 D:/NodeJs/node.exe v26.13.1。

## 二、重签与门检查（候选自身）

在干净克隆 candidate-998-v2 执行，门文件字节前后不变：

~~~powershell
D:/NodeJs/node.exe scripts/sign-gate.ts docs/gates/G1.md
# exit 1
# 审计报告里找不到唯一结论行，不能拿它当门记录依据:
# docs/audits/S1-independent-audit.md

D:/NodeJs/node.exe scripts/gate-check.ts docs/gates/G1.md
# exit 1
# 门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：
# 0000000000000000... != 50ba1b13cdf1b84d...
~~~

G1 门文件 sign 前 sha256 为 4fcb6d2fc9bc1ece9732c53a94359954a14ce5489b738122e8b88dc94d393340，sign 后同值。G2 同样：

~~~powershell
D:/NodeJs/node.exe scripts/sign-gate.ts docs/gates/G2.md
# exit 1，报同一句；报告 docs/audits/S2-independent-audit-round4.md
D:/NodeJs/node.exe scripts/gate-check.ts docs/gates/G2.md
# exit 1，0000000000000000... != c9cef2e419c91711...
~~~

G2 门文件 sign 前后 sha256 为 5d3e1a2c0a6289eb5ffc035505b9cef0746839ec94bfc5158a14734c9282b6c7。

判断：候选自身不能完成重签；sign-gate 在 verifyGateRecord 阶段就退出，未写文件；gate-check 在审计报告锚点先失败。这不是“签完再验”的顺序问题，而是 998 上根本没有与候选审计报告匹配的签名。

## 三、六类哈希独立复算

复算脚本 D:/aboutAI/_audit-r25/repro-hashes.mjs 只用 fs、crypto、child_process，自行实现 JCS canonicalJson，不复用 gate-check 的校验函数；body_hash 另与 gate-check 导出的 bodyHash 交叉验证，结果一致。

G1（候选覆盖 623939d..998c89b，115 个路径）：

| 类别 | 记录值 | 独立复算 | 结果 |
| --- | --- | --- | --- |
| artifact | 1ce80f6080fb2271ae7ba958c61127962951cb49262b75e5b1d8e7d161b82084 | f54dcae873f34a988ca7d6fbf5bd0b29ce68558acfd4007f0b477e49b65cc4ec | 不符 |
| body | 446357f9e00e384a35d7a4b77be48f0720cceebb61a4b5e1c4a9e8e27f17450c | 111ce311f354ff5822db0ff282adb2bfdf0f9efdd93be876f69ef866e6144118 | 不符 |
| evidence_index | fad4d531d22eef2968c6b7d5dce997f46162fa9fda12a98b1abf1aa6640a8d07 | fad4d531d22eef2968c6b7d5dce997f46162fa9fda12a98b1abf1aa6640a8d07 | 一致 |
| invariants | 6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6 | 6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6 | 一致 |
| candidate | bbd322cf9d4ef5fb44a836ac8fd6edeb56b7c95ad34d1f80f29fe349fc4cc69e | 97374355923c87bcaef107c10ddafc829f625c04c1b91c460d9d7c62a9a744d6 | 不符 |
| change_scope | ea15eaba761c24c70ff1b724251b125c65fc9ba17f15f4bdb1dfc35ff646f4fb | 83793fffc1fb10e1c1818eaf192171210853a5d7219965c8157727a0891744d4 | 不符 |

G2（候选覆盖 4f3ada7..998c89b，88 个路径）：

| 类别 | 记录值 | 独立复算 | 结果 |
| --- | --- | --- | --- |
| artifact | b5615b8b5725c5b2df88b9231b13885635940ef7db9f7fe802bc162c651c7a0a | ea3dff4caa8de38d5336388e32eb4af4867998308a28a6b010d180d8d85c291a | 不符 |
| body | ef21bb456813786ab878abae2824a873f6e7d470e257d2bcadfb9eb73282dfd3 | 558c01b7728d8ccee58ea3eae749879d0eff5989a5b7df1d1d6fc67da2d59b5f | 不符 |
| evidence_index | bcaaaa3e85d1dea69d323c9a03040f0bc7586445d5d833169b3768ac487b6347 | 1a221b945449b1e68b7811ba110ac022f25c9004438204dcdeae0f02a3068898 | 不符 |
| invariants | 77708d4b54f29a676481b6c2755a241171c2cfab1231ef6e621f184fc68cedd5 | 925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304 | 不符 |
| candidate | f11d0fb8751ce561df6d24379ad083f12c4bc60c866f87ec7f523858e32c0af8 | cdea71d354349e541ea1494869efd89b8d9c465d933632ce898b5d8c352fd459 | 不符 |
| change_scope | 33a82c417c33b950fe40f332f398018a29eebf5f2ed1242bb3772064f9626927 | b4811c33ac596c2580c7268812fa1e79fbe12ad2f9257bacdd8fb88fd5648778 | 不符 |

审计报告锚点也独立重算：

| 门 | 记录 audit_report_sha256 | HEAD 报告按 LF 归一的 sha256 | 结果 |
| --- | --- | --- | --- |
| G1 | 0000000000000000000000000000000000000000000000000000000000000000 | 50ba1b13cdf1b84d5a948b2bc6deb25c7ec9963b4435154a5487683329390003 | 不符 |
| G2 | 0000000000000000000000000000000000000000000000000000000000000000 | c9cef2e419c91711524e9784900050d988200253d76f3a2fb4e31dfd3872da63 | 不符 |

G1 的 evidence_index 与 invariants 两类原像能对上，但这只说明记录内部自洽；证据文件本身已有 6/13 与 HEAD 不一致，见第四节。G2 则是六类全部漂移，且 19 份证据文件逐份与 HEAD 一致，索引原像仍对不上，说明记录不是当前 HEAD 的签名。

## 四、证据逐份核对

### 4.1 G1 的 13 份证据

按 HEAD 字节、CRLF 归一到 LF 后计算 sha256，再与 G1.md 证据表及 artifact 的 evidence-index 比对。

| 证据 | 文件 | 记录 sha256 | HEAD 重算 | 结果 |
| --- | --- | --- | --- | --- |
| ev-auth | tests/auth.spec.ts | 13f123174be3f02ade0070a764720ed5c892d8b72f58836403c05da5671863c8 | 同记录 | 一致 |
| ev-backup | tests/backup.spec.ts | 8b8d5413025230565c5137854cdeaf517e3c87e542ee55f33df727f795b4b954 | 同记录 | 一致 |
| ev-chain | tests/hash-chain.spec.ts | e15bb381cd74e028a53a7ea8ced03180c248751b8ff06e8b995c2b7ed785d90f | 同记录 | 一致 |
| ev-epoch | tests/db-open.spec.ts | 78263f1ca785f67e78adb70f874657c8bd5d137b99d486827c02e913ba3b91ed | 61623a675fa33ce39dc91ee3b54bac5eee04c6c639e4185d7613dedc6ce9c044 | 不符 |
| ev-g01 | docs/gates/evidence/G1/G-01.md | f2626b30f9eb472f1268b71047893be8f1d42a933438e43cd30af35d3318a129 | 同记录 | 一致 |
| ev-g02 | docs/gates/evidence/G1/G-02.md | 5fedb2e7539b1d410b7ff3c964ea36d77764fd037c4f4e40badbd67b7038b196 | 同记录 | 一致 |
| ev-g08 | docs/gates/evidence/G1/G-08.md | a50e5a17eafda7c0c782e3dc56d0c1e70d6b879cf566b5500b0a84dd260ef44a | 2f2a73ddbf25fb59ea9b650635499856e66c94dcde81fca1a12ea3d424176c87 | 不符 |
| ev-g09 | docs/gates/evidence/G1/G-09.md | e944a2b6bd299faed3f9ce98c72647ceb8580eaae412a997d7be6cdcc5376625 | 同记录 | 一致 |
| ev-g14 | docs/gates/evidence/G1/G-14.md | 3b2e37d9a0f6c6e49054dc4a27966e914755a56e6e8b9491d51ca3d213545169 | 7869d3d1c5b84ad267a9ca304c6420abdfd3597deb3c9f2119129331f56f0bc2 | 不符 |
| ev-g15 | docs/gates/evidence/G1/G-15.md | db16d844f912cac0bedd81139a8238919b0d3f120469a6bdcfbcf7c73397cb0e | 334f26fb748d4013bdb0243f4a0e9d4ddd1e573fc4071114d9dffc0bb7dc03a3 | 不符 |
| ev-gatecheck | tests/gate-check.spec.ts | c61262506e81f9bfb89f00afc55662a18a722ed1ed447f9dd8220f88ab8f93b2 | 8e0f23372035fb6d78b948f4744f81b694dffa9921e5a3555c1df019c7f01d93 | 不符 |
| ev-migrate | tests/migrate.spec.ts | b3ad3fbde1ef16392af16b68cbab36d440ffd23b9a6e19a74fd6132da61d6ff1 | 80ca96027bde4b8ac65f66c7e9c2528bb8481cde00d07df70745ae6eabe80ab0 | 不符 |
| ev-phase | tests/config.spec.ts | d2175cc5f420b046aa3640af7795055e5a0f4fd05b6e304d0c963fd5ba1d025a | 同记录 | 一致 |

统计：7/13 一致，6/13 不符。6 份不符的路径正好是 998c89b 改到的测试与证据文件，说明 G1 是在更早的树上签的，之后文件变了，门没有重签。

### 4.2 G2 的 19 份证据

| 证据 | 文件 | 记录 sha256 | HEAD 重算 | 结果 |
| --- | --- | --- | --- | --- |
| ev-g2-01 | docs/gates/evidence/G2/ev-g2-01.md | f10efac98f2d0d91bfc83d0e1bacb3c2a5111c11bc7223de6464a057a744d88b | 同记录 | 一致 |
| ev-g2-02 | docs/gates/evidence/G2/ev-g2-02.md | 346af5813c653ba967af948a74aba27201b9ac906f13e54f4e588f8b18ea70e1 | 同记录 | 一致 |
| ev-g2-03 | docs/gates/evidence/G2/ev-g2-03.md | 784e44b65d6642404d0f7664bda64e48337292101a102f1403aef4caee4a6db5 | 同记录 | 一致 |
| ev-g2-04 | docs/gates/evidence/G2/ev-g2-04.md | 65946e22958ef8764415d2af693245f8dc8da33e585ba4cee094e36f56ac71a6 | 同记录 | 一致 |
| ev-g2-05 | docs/gates/evidence/G2/ev-g2-05.md | 74c0a94705a24494d435c995317d6a29f40e089a992e9c75afa5e0735b35adb1 | 同记录 | 一致 |
| ev-g2-06 | docs/gates/evidence/G2/ev-g2-06.md | cef5cf3de601985af216cb935334414d56ff9f3f296871f709332f9e16b1f91c | 同记录 | 一致 |
| ev-g2-07 | docs/gates/evidence/G2/ev-g2-07.md | 607471ff9e475eaa30e3a83376b4c93aed12b6e209b7bd2601678737cf934a34 | 同记录 | 一致 |
| ev-g2-08 | docs/gates/evidence/G2/ev-g2-08.md | 54e4b0e8415abd5bc65ce885c407245d91ec099390e64a2b3188c89cb1144cbf | 同记录 | 一致 |
| ev-g2-09 | docs/gates/evidence/G2/ev-g2-09.md | f43b50982b67843db87e1cae9b36b0048eca372d9734904d3e1090fc97b8d8b2 | 同记录 | 一致 |
| ev-g2-10 | docs/gates/evidence/G2/ev-g2-10.md | 76b458edf0f4f24a4408be4bf429b4a9025399aa002c52b6c50676a5f4f45e8b | 同记录 | 一致 |
| ev-g2-11 | docs/gates/evidence/G2/ev-g2-11.md | 05c1c8ea1ab5796a24adc50931a3a1b3d6d085af56975b47f6c9a113f7f233c7 | 同记录 | 一致 |
| ev-g2-12 | docs/gates/evidence/G2/ev-g2-12.md | 5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe | 同记录 | 一致 |
| ev-g2-13 | docs/gates/evidence/G2/ev-g2-13.md | a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc | 同记录 | 一致 |
| ev-g2-14 | docs/gates/evidence/G2/ev-g2-14.md | 12e34ba8fd59c17322b364a122a5f265af87d353e10a13b6b4328049ceb6b39f | 同记录 | 一致 |
| ev-g2-15 | docs/gates/evidence/G2/ev-g2-15.md | 7648abe92c2026e4c5739c5f5714f448a2ce8864fc07a129f607675af415643f | 同记录 | 一致 |
| ev-g2-g03 | docs/gates/evidence/G2/G-03.md | 514f9754fda67b8e1522d086fc6079301e00bd0185f9cca6dddec502c412ab70 | 同记录 | 一致 |
| ev-g2-g04 | docs/gates/evidence/G2/G-04.md | fb68366d1292bb80e9ae59febf7fd5ad1e28e580ecfc2883e99b18edb2e6eca9 | 同记录 | 一致 |
| ev-g2-g05 | docs/gates/evidence/G2/G-05.md | 2f7da35abe9c1484143b85a0226da8a0ebd095994c8e2aa492dd88f726b51904 | 同记录 | 一致 |
| ev-g2-g07 | docs/gates/evidence/G2/G-07.md | 8898db1323c191c8ca0acd51d2dde5458355b7b25f3b0c96f868ec38d8ef730e | 同记录 | 一致 |

19/19 逐份 sha256 与 HEAD 一致；但 evidence_index 原像哈希不可重算（记录 bcaaaa3e...，计算 1a221b94...），invariants 原像也不可重算（记录 77708d4b...，计算 925a7768...）。这不是文件字节漂移，而是 artifact 中的索引/不变量记录与当前正文块不是同一份原像。

## 五、必过项、正文表与例外表

| 门 | 必过项 | 正文必过项表 | 例外表 | bodyConclusionOf | artifact 结论 | 审计报告自身判定 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | 13 项：G1-01、G1-02、G1-03、G1-04、G1-05、G1-06、G1-07、G-01、G-02、G-08、G-09、G-14、G-15 | 13 行，id/内容/结果/证据集合与 GATE_SPECS 及 artifact 全一致 | 0 条 | pass（正文） | pass，failed_items=[] | 无正式结论行；G-08 判定 fail；末尾写 G1 建议：不通过 |
| G2 | 19 项：G2-01、G2-02、G2-03、G2-04、G2-05、G2-06、G2-07、G-03、G-04、G-05、G-07、G2-08、G2-09、G2-10、G2-11、G2-12、G2-13、G2-14、G2-15 | 19 行，id/内容/结果/证据集合与 GATE_SPECS 及 artifact 全一致 | 3 条：LEASE_EXPIRED 409、BRIDGE_ACK_LAG 409、DECISION_REQUIRED 422 | pass（正文） | pass，failed_items=[] | 第 3 行与第 11 行均写结论 fail |

G1 的正文证据表 13 行、不变量表 4 条（I1、I10、I2、I3），与 artifact 双向覆盖；G2 的正文证据表 19 行、不变量表 11 条，与 artifact 双向覆盖。治理字段 producer=human、approver=human:啸春、approved_at 可解析，也都能过。

关键矛盾不在表格格式，而在语义：G1 artifact 把 G-08 记为 pass，但它自己指向的审计报告第 36 行写 G-08 判定 fail；报告第 148 行还写 G1 建议：不通过。G2 artifact 写 conclusion=pass，它指向的报告第 3 行与第 11 行都写结论 fail。门记录的 pass 不是审计报告支持出来的。

## 六、审计报告结论与候选绑定

### 6.1 G1

- docs/audits/S1-independent-audit.md 共 166 行。
- 第 4 行是列表项形式的候选提交行，候选提交为 61b43db311b540532ac6b09c1943fc2551a3d07e，哈希外还包了反引号；auditBindingOf 要求整行精确匹配，返回 null。
- 第 36 行 G-08 判定 fail（写队列未接真实写路径）。
- 第 148 行写 G1 建议：不通过。
- 全文没有可用的正式结论行；auditConclusionOf 返回 null。
- artifact 的 must_pass_items 中 G-08=pass（docs/gates/G1.md:149-154），conclusion=pass，audit_report 指向这份报告，audit_report_sha256 却是 64 个 0。

### 6.2 G2

- docs/audits/S2-independent-audit-round4.md 第 3 行写结论 fail（致命 0 / 重大 5 / 不阻断 5），第 11 行再次写结论 fail，第 134 行还有一条结论：五条遗留都可以移交 S3。
- 没有门：G2 行，也没有裸的候选提交：40hex 行；auditBindingOf 返回 null。
- auditConclusionOf 返回 null；G2 artifact 却写 conclusion=pass、audit_round=4、audit_report_sha256=0。

auditBindingOf（scripts/gate-check.ts:1074-1087）的硬要求是整行精确匹配门：G[1-5] 与候选提交：40 位十六进制；列表符与反引号都不接受。G1 的候选绑定因此是 null，不只是“格式不好看”。审计报告与门名、候选、结论三件事没有一件被机器绑定住。

~~~powershell
D:/NodeJs/node.exe --no-warnings --input-type=module -e "import {readFileSync} from 'node:fs'; import {auditConclusionOf,auditBindingOf} from './scripts/gate-check.ts'; for (const f of ['docs/audits/S1-independent-audit.md','docs/audits/S2-independent-audit-round4.md']) { const t=readFileSync(f,'utf8'); console.log(f, 'conclusion=', auditConclusionOf(t), 'binding=', auditBindingOf(t)); }"
# 期望两道门都是 conclusion=null binding=null
~~~

## 七、解析器绕过载荷

### 7.1 方法

在一次性夹具克隆 D:/aboutAI/_audit-r25/repo 上做端到端验证：基线为 998，加一份只有“门：G1 / 候选提交：998... / 结论：pass”的夹具报告，把 G1 的 audit_round 改为 25、audit_report 指向夹具报告；先 sign-gate G1（exit 0）并把签好的门 commit --amend 进同一提交，得到可复现基线。每个载荷从该基线重置；报告载荷追加到夹具报告，门正文载荷写进 G1.md 的补记段；随后重跑 sign-gate G1，比较门文件 sha256 是否变化；sign 成功则把签好的门 commit --amend 进同一提交，再跑 gate-check G1。夹具只动 docs，候选绑定不变。

### 7.2 载荷

~~~text
R01 本报告验收未通过。
R02 本报告被退回。
R03 上一轮审计未通过，本轮已整改。本报告验收未通过。
R04 本报告目前未通过。
R05 本报告整改完成度不足。
R06 本报告未获准入。
R07 The gate is in a blocked state.
N04 本报告尚不具备放行条件。
N01 本报告不能放行。
B01 本门记录验收未通过。
B03 本门记录未获准入。
H01 <!-- 本报告不能放行 -->
H02 <span>本报告不能放行</span>
H03 参考式可见否定：
[本报告不能放行][x]
[x]: https://example.invalid/x
~~~

H04 是围栏里再放围栏，单独列出：

~~~~text
~~~text
结论：fail
~~~
~~~~

### 7.3 结果

sign-gate 与 gate-check 的退出码、门字节变化如下。“门字节”指 G1.md 的 sha256 是否因这次 sign 改变。

| 编号 | 位置 | sign-gate | 门字节 | gate-check | 判定 |
| --- | --- | --- | --- | --- | --- |
| 基线 | 夹具 pass 报告 | 0 | 变 | 0 | 正常基线 |
| R01 | 报告，结论 pass 后追加 | 0 | 变 | 0 | 漏扫，签成 pass |
| R02 | 报告，结论 pass 后追加 | 0 | 变 | 0 | 漏扫，签成 pass |
| R03 | 报告，历史整改 + 验收否定 | 0 | 变 | 0 | 漏扫，签成 pass |
| R04 | 报告，副词前缀 | 0 | 变 | 0 | 漏扫，签成 pass |
| R05 | 报告，完成度否定 | 0 | 变 | 0 | 漏扫，签成 pass |
| R06 | 报告，准入否定 | 0 | 变 | 0 | 漏扫，签成 pass |
| R07 | 报告，英文 blocked 状态 | 0 | 变 | 0 | 漏扫，签成 pass |
| N04 | 报告，就绪/放行条件否定 | 0 | 变 | 0 | 漏扫，签成 pass |
| B01 | G1 正文补记，验收否定 | 0 | 变 | 0 | 漏扫，签成 pass |
| B03 | G1 正文补记，准入否定 | 0 | 变 | 0 | 漏扫，签成 pass |
| H01 | HTML 注释 | 0 | 变 | 0 | 不可见文本，按 markdown 语义忽略 |
| H02 | 原始 HTML span | 1 | 不变 | 1 | fail-closed，正确挡住 |
| H03 | 参考式链接定义，label 可见否定 | 1 | 不变 | 1 | fail-closed，正确挡住 |
| H04 | 围栏代码块内结论 fail | 0 | 变 | 0 | 不可见文本，按 markdown 语义忽略 |
| N01 | 报告，不能放行 | 1 | 不变 | 1 | fail-closed，正确挡住（对照） |

说明：H02/H03/N01 的 gate-check=1 首先撞到审计报告 sha 不符，因为 sign-gate 没有写门；但解析器侧 auditConclusionOf 已返回 null，这组载荷不能签成 pass，按 fail-closed 记正确。

### 7.4 根因

- 扫描从 FAIL_SUBJECTS 命中点开始，只允许吃 FAIL_CONNECTORS；验收、准入、目前、当前、暂时、尚、在、于、被、完成度等中间词不在连接词表，主语后的第一个词就卡住。R01、R04、R05 属这一类。
- 结构否定只覆盖“否定词 + 填充词 + 通过/批准/成功等谓词 + 对象”；未获准入的准入不是谓词，被退回的被动式也没有裁决分支。R02、R06 属这一类。
- 完成度表达（完成度不足、只完成一半、尚未收口、还没有完成）不在完成度谓词结构里。R05 属这一类。
- 英文只有否定词驱动的路径；The gate is in a blocked state 没有否定词，is 之后又先遇到 in，扫描器没有跳过状态介词。R07 属这一类。
- 历史整改豁免只剥开“上一轮/前一轮 + 本轮已整改”的一段；剥完剩下的可见否定仍要能被扫描器吃掉，R03 剩下的验收未通过没有被吃掉，所以整句放行。
- 门正文与报告走的是两套入口（bodyConclusionOf 与 auditConclusionOf），但共享同一组扫描器；B01/B03 说明门正文入口同样漏。

这不是单个词表缺项，而是“可见否定必须从固定主语、固定连接词、固定谓词一路命中”的结构性假设。只要真实句子多一个副词、一个被动式、一个状态介词或一个完成度名词，就会漏。

## 八、候选增删文件覆盖

- G1：scopeBase=623939d4c0a7123835b525287035588ee291ccbe，excludes=docs/gates/G1.md、docs/gates/G2.md、docs/audits、docs/reviews、handoff.md；diff 共 115 个路径：106 新增、9 修改、0 删除、0 重命名。独立计算 candidate=97374355923c87bcaef107c10ddafc829f625c04c1b91c460d9d7c62a9a744d6；夹具 sign-gate 输出的 candidate 前缀也是 97374355923c，枚举方法一致。
- G2：scopeBase=4f3ada7，excludes 同上；diff 共 88 个路径：62 新增、26 修改、0 删除、0 重命名。独立计算 candidate=cdea71d354349e541ea1494869efd89b8d9c465d933632ce898b5d8c352fd459；夹具 sign-gate 输出前缀 cdea71d35434。
- 两段都没有删除或重命名，因此 candidateEntries 的 DELETED 与 ADDED_THEN_DELETED 还原分支本轮没有被候选实际覆盖；这是覆盖缺口，记 P2，不影响本轮 G1 的 P0 判定。

## 九、P0/P1/P2

### P0-1 G1/G2 记录是预签态，候选无法重签，门检查直接失败

事实：G1 audit_round=1、audit_report 指向 round1 报告、audit_report_sha256=0；G2 audit_round=4、audit_report_sha256=0。在 998 的干净克隆里重签 G1/G2 均 exit 1，门字节不变；gate-check 两道门均 exit 1。

影响：候选没有可验证的门签名；所有后续门检查与候选绑定都无从谈起。这不是“证据过期”这种可补测问题，而是门记录没有对着这个候选生成。

复现：

~~~powershell
git clone D:/aboutAI/dsh-orchestra D:/aboutAI/_audit-r25/candidate-998-v2
cd D:/aboutAI/_audit-r25/candidate-998-v2
git checkout 998c89bba27aaf299e9ea6eff941048103803a96
cmd /c mklink /J node_modules D:\aboutAI\dsh-orchestra\node_modules
D:/NodeJs/node.exe scripts/sign-gate.ts docs/gates/G1.md
# 期望 exit 1，报“审计报告里找不到唯一结论行”
D:/NodeJs/node.exe scripts/gate-check.ts docs/gates/G1.md
# 期望 exit 1，报“审计报告 sha256 与记录不符”
D:/NodeJs/node.exe scripts/sign-gate.ts docs/gates/G2.md
D:/NodeJs/node.exe scripts/gate-check.ts docs/gates/G2.md
~~~

### P0-2 审计报告结论与门记录相反，绑定行为 null

事实：G1 报告第 4 行用列表项加反引号写候选 61b43db，auditBindingOf 返回 null；第 36 行 G-08 判定 fail；第 148 行写 G1 建议：不通过；全文没有正式结论行，auditConclusionOf 返回 null。G1 artifact 却把 G-08 记 pass、conclusion 记 pass。G2 报告第 3 行与第 11 行都写结论 fail，G2 artifact 却记 conclusion=pass；G2 报告也没有可解析的绑定行。

影响：即使不看哈希，门记录的 pass 也与它引用的审计报告相反。G1 的 G-08 是必过项，报告自己说 fail，门记录说 pass，这属于结论绑定失效；G2 更直接，报告写 fail，门写 pass。

复现：

~~~powershell
D:/NodeJs/node.exe --no-warnings --input-type=module -e "import {readFileSync} from 'node:fs'; import {auditConclusionOf,auditBindingOf} from './scripts/gate-check.ts'; for (const f of ['docs/audits/S1-independent-audit.md','docs/audits/S2-independent-audit-round4.md']) { const t=readFileSync(f,'utf8'); console.log(f, 'conclusion=', auditConclusionOf(t), 'binding=', auditBindingOf(t)); }"
# 期望两道门都是 conclusion=null binding=null
~~~

~~~powershell
git show 998c89b:docs/audits/S1-independent-audit.md | Select-String -Pattern '候选提交|G-08|建议'
git show 998c89b:docs/audits/S2-independent-audit-round4.md | Select-String -Pattern '结论'
~~~

### P0-3 可见否定可绕过解析器，sign-gate 与 gate-check 一起放行

事实：R01–R07、N04、B01、B03 共 10 条可见否定载荷，在夹具上 sign-gate exit 0、门字节变化、gate-check exit 0。它们覆盖验收否定、被动退回、历史整改豁免、副词前缀、完成度否定、准入否定、英文 blocked 状态、就绪/放行条件否定，以及门正文里的同类句子。对照 N01（本报告不能放行）被正确挡住，说明不是所有否定都漏，而是上述结构漏。

影响：一份先写结论 pass、再在正文里写“验收未通过”或“未获准入”的报告，能被签成 pass；门正文补记里的同类句子也能被签成 pass。这是 G1 门禁的核心可信度问题。

复现：按 7.1 建夹具基线，然后执行：

~~~bash
set -e
ROOT=/d/aboutAI/_audit-r25/repro-round25
rm -rf "$ROOT"
git clone /d/aboutAI/dsh-orchestra "$ROOT"
cd "$ROOT"
git checkout 998c89bba27aaf299e9ea6eff941048103803a96
# Windows Git Bash 下建 junction；已有 node_modules 可跳过
cmd //c "mklink /J node_modules D:\aboutAI\dsh-orchestra\node_modules"
cat > docs/audits/S1-fixture-round25.md <<'EOF'
门：G1
候选提交：998c89bba27aaf299e9ea6eff941048103803a96
结论：pass
EOF
cat > /tmp/fix-g1.mjs <<'EOF'
import fs from 'node:fs';
let t=fs.readFileSync('docs/gates/G1.md','utf8');
t=t.replace('"audit_round": 1','"audit_round": 25');
t=t.replace('"audit_report": "docs/audits/S1-independent-audit.md"','"audit_report": "docs/audits/S1-fixture-round25.md"');
fs.writeFileSync('docs/gates/G1.md',t);
EOF
node /tmp/fix-g1.mjs
git add docs/audits/S1-fixture-round25.md docs/gates/G1.md
git -c user.name=audit -c user.email=audit@local commit -m fixture
node scripts/sign-gate.ts docs/gates/G1.md
git add docs/gates/G1.md
git -c user.name=audit -c user.email=audit@local commit --amend --no-edit
printf '\n本报告验收未通过。\n' >> docs/audits/S1-fixture-round25.md
git add docs/audits/S1-fixture-round25.md
git -c user.name=audit -c user.email=audit@local commit -m payload
node scripts/sign-gate.ts docs/gates/G1.md
# 期望 exit 0：载荷漏扫
git add docs/gates/G1.md
git -c user.name=audit -c user.email=audit@local commit --amend --no-edit
node scripts/gate-check.ts docs/gates/G1.md
# 期望 exit 0
~~~

### P1-1 G1 六类哈希四类漂移，6/13 证据与 HEAD 不符

事实：G1 的 artifact、body、candidate、change_scope 四类哈希与记录不符；evidence_index、invariants 两类能重算。13 份证据中 6 份与 HEAD 不一致（ev-epoch、ev-g08、ev-g14、ev-g15、ev-gatecheck、ev-migrate）。candidate 实际 115 个路径（106 新增 + 9 修改），记录 bbd322... 不是当前候选。

影响：即使审计报告锚点修好，checkEvidence 也会逐份点名这 6 份；checkAuditAnchor 的 candidate_hash 与 change_scope_hash 也会失败。门记录不是 998 的签名。

复现：D:/NodeJs/node.exe D:/aboutAI/_audit-r25/repro-hashes.mjs，或按第三节表格逐项重算。

### P1-2 G2 六类哈希全部漂移，报告 fail 而门写 pass

事实：G2 的 artifact、body、evidence_index、invariants、candidate、change_scope 六类全部与记录不符；19 份证据文件逐份与 HEAD 一致，但 evidence_index 与 invariants 原像仍不可重算。G2 报告第 3/11 行写结论 fail，artifact conclusion=pass，audit_report_sha256=0。

影响：G2 与 G1 同源，说明这不是单道门的偶发问题；门链的上一环也不能作为可信前置。

复现：D:/NodeJs/node.exe D:/aboutAI/_audit-r25/repro-hashes.mjs，或按第三节 G2 表逐项重算。

### P2-1 围栏与 HTML 注释里的结论不参与可见性检查

事实：H01 的 HTML 注释、H04 的围栏内结论 fail，sign-gate exit 0、门字节变化、gate-check exit 0。H02 原始 HTML span 与 H03 参考式链接的可见否定则被 fail-closed 挡住。

影响：按 markdown 可见性语义，这不是错误放行；但门记录没有把“不可见结论不构成审计证据”写成契约或测试。若未来有人把结论藏进围栏/注释，机器仍会签 pass。记 P2，不阻断本轮定性。

复现：按 7.1 的夹具，分别追加 H01、H04 后重签；H01/H04 均为 sign 0、gate-check 0。

### P2-2 删除/重命名的候选还原分支未被候选覆盖

事实：G1 115 个路径、G2 88 个路径，删除与重命名均为 0；candidateEntries 的 DELETED 与 ADDED_THEN_DELETED 分支本轮没有被实际触发。

影响：这两条分支仍只有代码审查，没有本轮候选的行为证据。属于覆盖缺口，不影响本轮 G1 的 P0 判定。

复现：复核 git diff --name-status 623939d..998c89b 与 git diff --name-status 4f3ada7..998c89b，过滤 D/R 为 0。

## 十、结论

G1 的 P0 是硬阻断：G1 记录是预签态，候选无法重签；G1 引用的审计报告自己写 G-08 fail 与建议不通过；解析器又能把可见否定签成 pass。P1 的哈希漂移与证据过期进一步说明记录不是 998 的签名。P2 只是不可见文本与删除分支的覆盖缺口，不改变定性。

本轮判定为 fail。G1 不能放行。
