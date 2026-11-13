门：G1
候选提交：ca2b196e351552b8a055450fb81ed6653aff2197

# S1 第二十二轮独立审计报告

审计对象固定为候选 ca2b196e351552b8a055450fb81ed6653aff2197。主工作树在审计期间被并发提交推进到 e7a3fa4（S2 第二十六轮），该提交超出本报告范围；本报告的行号、命令、计数与结论均以候选提交的干净 clone 为准。clone 根：D:/aboutAI/_g1audit-r22/clone；环境：D:/NodeJs/node.exe v26.13.1；gate-check 与 sign-gate 均用 node --no-warnings 直跑 .ts。

结论：fail

## 一、复跑基线

| 检查 | 命令 | 退出码 | 计数 / 结果 |
|---|---|---|---|
| gate-check G1（候选 clone） | `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` | 1 | 审计报告 sha256 绑定有偏差（原文见代码块） |
| tsc --noEmit（候选 clone） | `node node_modules/typescript/bin/tsc --noEmit` | 0 | 0 条诊断 |
| vitest（候选 clone，预签） | `node node_modules/vitest/vitest.mjs run` | 1 | 348 通过 / 359；11 例在 tests/gate-check.spec.ts |
| vitest（clone 标签 signed-safe，d4d576a） | 同上 | 0 | 359 通过 / 359；32 文件全过 |
| tsc（signed-safe） | 同上 | 0 | 0 条诊断 |

gate-check 的原始输出：

```text
门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…
```

预签 vitest 的尾部计数：

```text
 Test Files  1 failed | 31 passed (32)
      Tests  11 failed | 348 passed (359)
```

signed-safe 的尾部计数：

```text
 Test Files  32 passed (32)
      Tests  359 passed (359)
```

11 例预签噪声全部落在 tests/gate-check.spec.ts，首条错误均为同一审计报告 sha256 绑定。把同一个候选在 clone 内用 sign-gate 正常签出后（标签 signed-safe，commit d4d576a），同一条 vitest 命令 359/359 通过；因此这 11 例属于预签态噪声（P2-2）。

## 二、第二十一轮 P0/P1/P2 对照

| 第二十一轮条目 | 复核载荷 | 结果 |
|---|---|---|
| P0-1 否定词带宾语 / 繁體 | p0-1a、p0-1b、p0-1c | sign=1，G1 字节保持 |
| P0-2 缩写 doesnt / wont / hasnt | p0-2a、p0-2b、p0-2c | sign=1，G1 字节保持 |
| P0-3 not approved / not passing | p0-3a、p0-3b | sign=1，G1 字节保持 |
| P0-4 批准类与裁决类中文形态 | p0-4a、p0-4b、p0-4c、p0-4d | sign=1，G1 字节保持 |
| P0-5 同形字 | p0-5a、p0-5b | sign=1，G1 字节保持 |
| P0-6 连接词上限 | p0-6a、p0-6b | sign=1，G1 字节保持 |
| P1 历史叙述被误杀 | safe-history-1..4 | sign=0，gate-check=0；已闭合 |
| P2-1 预签基线 | probe-core-candidate | 复现，保留 P2-1 |
| P2-2 11 例预签噪声 | 全量 vitest | 复现，保留 P2-2 |

第二十一轮的 16 个 P0 载荷在候选解析器上全部返回 null，sign-gate 全部退出 1 且 G1 字节保持；4 条历史安全句在 sign-gate 与 gate-check 上均退出 0。P0-1..P0-6 与 P1 的原始形态已经闭合，但 P1 的修复引入了本轮 P0-1 与 P0-2。

## 三、攻击矩阵

共 49 例：36 + 6 + 4 + 3。每例在 clone 内 git reset --hard ca2b196，改 G1 的 audit_round=22、audit_report=docs/audits/S1-independent-audit-round22.md，可注入正文，写报告，commit，跑 sign-gate，记录 G1 前后 sha256；sign-gate 退出码 0 时再 commit 并跑 gate-check。

复现命令：

```powershell
cd D:\aboutAI\_g1audit-r22
D:\NodeJs\node.exe --no-warnings run-e2e-r22.mjs cases-r22.json results-r22.json
D:\NodeJs\node.exe --no-warnings run-e2e-r22.mjs cases-supp.json results-supp.json
D:\NodeJs\node.exe --no-warnings run-e2e-r22.mjs cases-supp2.json results-supp2.json
D:\NodeJs\node.exe --no-warnings run-e2e-r22.mjs cases-supp3.json results-supp3.json
```

结果分类：B 类 19 例（sign=0、G1 改写、gate-check=0）；R 类 19 例（sign=1、G1 字节保持）；S 类 11 例（sign=0、gate-check=0）。每例的 sign、unchanged、gatecheck、signOut、gcOut 保存在 results-r22.json、results-supp.json、results-supp2.json、results-supp3.json。

### P0-1 历史整改剥离跨度覆盖本轮陈述

文件：scripts/gate-check.ts:852-864、:874（候选 ca2b196）。

机制：HISTORICAL_REMEDIATION_RES 从 上一轮/前一轮/roundN 起，到首个 本轮已整改/本轮已修复/… 止，中间用惰性跨度匹配，并以本轮标记、句末或结论词作为边界。visibleFailStatement 先对这一整行做 strip，再交给 fold；auditConclusionOf 在 :874 把全部可见行用竖线拼起来做一次全文扫描。只要当前否定或当前结论落在历史锚与整改词之间，它就会连同历史段一起被删除；逐行循环只认以 结论/判定 开头的正式结论行，于是报告回到绑定行的 pass。

源码片段（候选提交）：

```ts
850 // 历史叙述不是本轮意见：只剔除“上一轮/前一轮/roundN … 本轮已整改”这一小段，
851 // 同一行里剩余的否定句仍照常扫描（S1 第二十一轮 P1）。
852 const HISTORICAL_REMEDIATION_RES = [
853   /(?:历史记录\s*[：:]?\s*)?(?:上一轮|前一轮|round\s*\d{1,3})\s*(?:审计|審計|检查|复核|评审)?[^。\n]{0,120}?(?:本轮已整改|本轮已修复|本轮已收口|本轮已处理|本轮修复|已整改|已修复|已收口)/gi,
854   /(?:the\s+)?previous\s+audit[^.\n]{0,120}?(?:this\s+round\s+is\s+(?:clean|fixed)|remediated)/gi,
855 ]
856 function stripHistoricalRemediation(text: string): string {
857   let out = text
858   for (const re of HISTORICAL_REMEDIATION_RES) out = out.replace(re, '')
859   return out
860 }
862 function visibleFailStatement(line: string, scan: FailScan = {}): boolean {
863   return scanFailStatement(foldForVerdict(stripHistoricalRemediation(line)), scan)
864 }
874   if (visibleFailStatement(visible.join('|'))) inlineFail = true
```

B 类载荷（注入审计报告正文）：

```text
history-swallow-current
上一轮审计未通过，本轮审计未通过验收，本轮已整改。

history-swallow-crossline
上一轮审计未通过，
本轮审计未通过验收，
本轮已整改。

history-swallow-english
The previous audit failed to pass, the current audit did not approve, this round is fixed.

history-swallow-unremediated
上一轮审计未通过，本轮未整改，本轮已整改。

history-swallow-blankline
上一轮审计未通过，本轮审计未通过验收

本轮已整改。

history-swallow-verdict
上一轮审计未通过，结论：fail，本轮已整改。

history-swallow-verdict-multiline
上一轮审计未通过，结论：
fail，本轮已整改。
```

上述 7 例的 sign-gate 与 gate-check 结果：

```text
history-swallow-current             sign=0  same=false  gc=0  artifact=644de43c11f0
history-swallow-crossline           sign=0  same=false  gc=0  artifact=f96c6c812443
history-swallow-english             sign=0  same=false  gc=0  artifact=75f34d90eafb
history-swallow-unremediated        sign=0  same=false  gc=0  artifact=3115ad1e3b91
history-swallow-blankline           sign=0  same=false  gc=0  artifact=e57b2596d34a
history-swallow-verdict             sign=0  same=false  gc=0  artifact=3251595369a1
history-swallow-verdict-multiline   sign=0  same=false  gc=0  artifact=c3badc521970
```

代表输出：

```text
重签完成：证据 13 份，candidate=3fe3ea771180…，artifact_hash=644de43c11f0…，body_hash=916d735bfe97…，改动文件 115 个
gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=644de43c11f0… body_hash=916d735bfe97…）
```

解析器级复核（直接 import 候选 scripts/gate-check.ts，报告文本为绑定行加载荷）：

```powershell
D:\NodeJs\node.exe --no-warnings D:\aboutAI\_g1audit-r22\probe-candidate-parser.mjs
```

```text
history-swallow-current pass
history-swallow-crossline pass
history-swallow-english pass
history-swallow-unremediated pass
history-swallow-verdict pass
history-swallow-verdict-multiline pass
control-round21 null
```

由此，历史叙述剥离覆盖本轮陈述，且能把一条显式的反向结论行一并剥掉；P0-1 成立。

### P0-2 同一剥离跨度覆盖门正文结论

文件：scripts/gate-check.ts:921-923；剥离函数同上。

bodyConclusionOf 也对 visible.join('|') 做 strip，然后只对以 结论/判定 开头的行补扫。注入到 G1 正文、位于 必过项 表之前的段落，如果写成历史锚加当前结论加整改词，就会被整段删除；官方 pass 结论行保留，found.length 恰为 1，函数返回 pass。sign-gate 在写盘前调用 verifyGateRecord(selfCheck:true)，因此这种门正文也能通过签名。

B 类载荷（注入 G1.md 正文，非审计报告）：

```text
gatebody-history-swallow
上一轮审计未通过，本轮审计未通过验收，本轮已整改。

gatebody-swallow-verdict
上一轮审计未通过，结论：fail，本轮已整改。
```

结果：

```text
gatebody-history-swallow   sign=0  same=false  gc=0  artifact=db45a990edf1  body=631d13f815a6
gatebody-swallow-verdict   sign=0  same=false  gc=0  artifact=db45a990edf1  body=06f1564500e1
gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=db45a990edf1… body_hash=06f1564500e1…）
```

bodyConclusionOf 对注入门正文返回 pass；P0-2 成立。

### P0-3 英文进行时与名词化批准否定

文件：scripts/gate-check.ts:759-765、:826-834。

FAIL_PASS_STEMS 的词表边界只到 approve / approved / approval / passing / passed。进行时词形在否定词之后匹配到 approve 前缀，但后继字符是 i，尾部守卫（空、竖线或 需应已的了）会挡下这一匹配；FAIL_VERDICTS 的词表边界同样只到更短的形态。名词化形态的 approval 位于否定词之前，否定词之后的谓词位为空，结构否定因此匹配不到。

B 类载荷（注入审计报告正文）：

```text
gap-not-approving
This audit is not approving.

gap-isnt-approving
This audit isn't approving.

gap-approval-not-granted
The audit approval was not granted.
```

结果：

```text
gap-not-approving             sign=0  same=false  gc=0  artifact=a5a0f3f692ae
gap-isnt-approving            sign=0  same=false  gc=0  artifact=500bbcb7564c
gap-approval-not-granted      sign=0  same=false  gc=0  artifact=579c4d7d2dd5
```

对照用例（见上方 R 类代码块）在候选解析器上返回 null，sign=1；缺口集中在这两个词形，英文否定族的其他形态仍能被覆盖。P0-3 成立。

### P0-4 中文批准类结构否定

文件：scripts/gate-check.ts:748-768、:652-676。

第一组形态里，填充词表先消费 获，剩下单字落在谓词表之外；第二组形态的 准予 落在填充词表之外，谓词位于第二位；第三组形态的 被 落在填充词表之外，谓词同样位于第二位。FAIL_VERDICTS 的词条边界只覆盖到更短的形态。它们都能作为报告正文的一句话与绑定行的 pass 共存。

B 类载荷（注入审计报告正文）：

```text
gap-wei-huo-pi
本报告未获批。

gap-mei-huo-pi
本报告没获批。

gap-wei-zhunyu
本报告未准予通过。

gap-wei-bei-pizhun
本报告未被批准。
```

结果：

```text
gap-wei-huo-pi        sign=0  same=false  gc=0  artifact=78caacb9d924
gap-mei-huo-pi        sign=0  same=false  gc=0  artifact=06031f34094a
gap-wei-zhunyu        sign=0  same=false  gc=0  artifact=01293c46b4f0
gap-wei-bei-pizhun    sign=0  same=false  gc=0  artifact=a6b100c01efd
```

P0-4 成立。

### P1 整改完成度陈述的判定缺口

文件：scripts/gate-check.ts:652-676、:759-765。

两个完成度短语落在通过类谓词表之外，FAIL_VERDICTS 的词条边界同样只覆盖到更短的形态；假整改声明中，历史剥离只删到第一个整改词，剩余完成度短语的可识别谓词位为空，因此同样放行。它们属于完成度陈述，却与 本轮已整改 的事实陈述冲突。

B 类载荷（注入审计报告正文）：

```text
gap-benlun-weizhenggai
本轮未整改。

gap-weiwancheng-zhenggai
本报告未完成整改。

gap-false-remediation-claim
上一轮审计未通过，本轮已整改，但实际上本轮未整改。
```

结果：

```text
gap-benlun-weizhenggai        sign=0  same=false  gc=0  artifact=c36a9bd668d3
gap-weiwancheng-zhenggai      sign=0  same=false  gc=0  artifact=082da3c0eca5
gap-false-remediation-claim   sign=0  same=false  gc=0  artifact=58864654d415
```

P1 成立。

### R 类对照（19 例）

16 个第二十一轮 P0 载荷加 history-after-only、gap-does-not-approve、history-remote-negative-crosspara，共 19 例。它们的 sign=1、unchanged=true，停止位置 scripts/gate-check.ts:1535（错误原文见下方代码块）；G1 字节保持。

```text
p0-1a-zh-acceptance
本报告未通过验收。

p0-1b-zh-tw-acceptance
本報告未通過驗收。

p0-1c-zh-review
本报告未通过评审。

p0-2a-doesnt
The audit doesn't pass.

p0-2b-wont
The audit won't pass.

p0-2c-hasnt
The audit hasn't passed.

p0-3a-not-approved
The audit was not approved.

p0-3b-not-passing
The audit is not passing.

p0-4a-not-ratified
本报告未获批准。

p0-4b-rejected
本报告被驳回。

p0-4c-vetoed
本报告被否决。

p0-4d-no-pass
本报告没有获得通过。

p0-5a-homoglyph-fail
本报告 fаil。

p0-5b-homoglyph-through
本报告未通о过。

p0-6a-connectors-8
审计 经过 报告 结果 经过 复核 结论 还是 未通过。

p0-6b-connectors-12
审计 经过 报告 结果 经过 复核 结论 还是 经过 报告 结果 还是 未通过。

history-after-only
上一轮审计未通过，本轮已整改。本报告不通过。

gap-does-not-approve
This audit does not approve the candidate.

history-remote-negative-crosspara
上一轮审计未通过，本轮已整改。

本报告不通过。
```

```text
p0-1a-zh-acceptance   sign=1  same=true
p0-6b-connectors-12   sign=1  same=true
history-remote-negative-crosspara  sign=1  same=true  error=gate-check.ts:1535
```

```text
file:///D:/aboutAI/_g1audit-r22/clone/scripts/gate-check.ts:1535
```

history-remote-negative-crosspara 的跨段远端否定进入 R 类；原因是结论歧义（auditConclusionOf 返回 null），该路径以 fail-closed 方式处理；归入边界观察，不计 P0/P1。

### S 类对照（11 例）

```text
safe-history-1
上一轮审计未通过，本轮已整改。

safe-history-2
历史记录：上一轮审计未通过，本轮已整改。

safe-history-3
The previous audit failed to pass, this round is fixed.

safe-history-4
前一轮审计未通过，本轮已修复。

safe-history-round20
round20 审计结论为 fail，本轮已整改。

safe-history-english-didnot
The previous audit did not pass; this round is clean.

safe-zero-failitems
未通过项为零。

safe-zero-p01
P0/P1 已清零。

safe-zero-exact
本轮检查未通过项为零，所有必过项均已通过。

safe-history-and-zero-crosspara
历史记录：上一轮审计未通过，本轮已整改。

本轮检查未通过项为零，所有必过项均已通过。

gatebody-history-safe
历史记录：上一轮审计未通过，本轮已整改。
```

```text
safe-history-1                  sign=0  gc=0  artifact=a086c93d0df0
safe-history-2                  sign=0  gc=0  artifact=1292f2bc869a
safe-history-3                  sign=0  gc=0  artifact=d2f2ba3118e4
safe-history-4                  sign=0  gc=0  artifact=6aff2308a225
safe-history-round20            sign=0  gc=0  artifact=1c870b3451fe
safe-history-english-didnot     sign=0  gc=0  artifact=93b07c773235
safe-zero-failitems             sign=0  gc=0  artifact=1da34bff328e
safe-zero-p01                   sign=0  gc=0  artifact=ab20dde3653f
safe-zero-exact                 sign=0  gc=0  artifact=bd367345d24d
safe-history-and-zero-crosspara sign=0  gc=0  artifact=46a8c44f3f4c
gatebody-history-safe           sign=0  gc=0  artifact=db45a990edf1  body=460c19a56bc0
```

11 例全部完成签名并通过 gate-check；历史安全句的误杀问题已经修复，但同一修复的跨度边界引入了 P0-1 与 P0-2。

## 四、门记录与证据复核

### 4.1 已复核项

- 13 项必过：G1-01..G1-07、G-01、G-02、G-08、G-09、G-14、G-15；GATE_SPECS.G1.items 与正文表逐项一致（probe-core-candidate 的 body items match spec true）。
- 13 份证据：ev-auth、ev-backup、ev-chain、ev-epoch、ev-g01、ev-g02、ev-g08、ev-g09、ev-g14、ev-g15、ev-gatecheck、ev-migrate、ev-phase；正文证据表 13 行，checkBodyEvidenceTable OK；evidence_index_hash fad4d531d22e 与重算一致。
13 份证据按 HEAD 字节（CRLF 归一为 LF）逐份重算，记录前缀 / 实算前缀：

```text
ev-auth        13f123174b / 13f123174b  OK
ev-backup      8b8d541302 / 8b8d541302  OK
ev-chain       e15bb381cd / e15bb381cd  OK
ev-epoch       78263f1ca7 / 61623a675f  STALE
ev-g01         f2626b30f9 / f2626b30f9  OK
ev-g02         5fedb2e753 / 5fedb2e753  OK
ev-g08         a50e5a17ea / 2f2a73ddbf  STALE
ev-g09         e944a2b6bd / e944a2b6bd  OK
ev-g14         3b2e37d9a0 / 7869d3d1c5  STALE
ev-g15         db16d844f9 / 334f26fb74  STALE
ev-gatecheck   c61262506e / 13b75d8afc  STALE
ev-migrate     b3ad3fbde1 / 80ca96027b  STALE
ev-phase       d2175cc5f4 / d2175cc5f4  OK
```

四个锚点的记录前缀 / 实算前缀：

```text
artifact_hash      1ce80f6080fb / f54dcae873f3
body_hash          446357f9e00e / 111ce311f354
candidate_hash     bbd322cf9d4e / 3fe3ea771180
change_scope_hash  ea15eaba761c / 83793fffc1fb
```

- 不变量表：checkBodyInvariants OK；invariants_hash 6f75465bfb0e 与重算一致。
- 候选范围：candidateEntries 返回 115 个文件、115 个路径；scopeBase=623939d4c0a7123835b525287035588ee291ccbe；excludes 覆盖 docs/gates/G1.md、G2.md、docs/audits、docs/reviews、handoff.md。
- 预签锚点：artifact_hash 1ce80f6080fb 与实算 f54dcae873f3 有偏差；body_hash 446357f9e00e 与实算 111ce311f354 有偏差；candidate_hash bbd322cf9d4e 与实算 3fe3ea771180 有偏差；change_scope_hash ea15eaba761c 与实算 83793fffc1fb 有偏差。这些是签名前的待重算值（P2-1）。
- audit 字段：audit_round=1；audit_report=docs/audits/S1-independent-audit.md；audit_report_sha256 为 64 个 0。旧报告在 HEAD 的实际 LF sha256=50ba1b13cdf1b84d，auditBindingOf=null，auditConclusionOf=null；第二十一轮报告 sha256=4f963941c23c507c，绑定 G1/6cb95b3840e8a8ff605d23f49f73c5c39b6b066，结论字段为反向值。
- 签名机制自证：在 clone 内对同一个候选签出后（signed-safe，d4d576a），13/13 证据、candidate/scope/artifact/body、audit_report_sha256=7095abd0925c0bc6、唯一绑定、verifyGateRecord、正文两表全部 OK；gate-check 退出 0。
- 证据文档 G-01、G-02、G-08、G-09、G-14、G-15 的关键断言与 tests/integration/g1.spec.ts:10-45 六条注入用例一致；signed-safe 上这六条全过。

### 4.2 P2-1 预签基线

文件：docs/gates/G1.md:75-195（artifact 与证据索引块）、docs/gates/G1.md:11-25（必过项表）。

G1 当前处于预签状态：13 份证据中 7 份与 HEAD 字节一致，6 份为陈旧值；candidate/scope/artifact/body 四个哈希与实算值有偏差；audit_round=1，audit_report 指向旧报告，audit_report_sha256 全 0。verifyGateRecord 的首条错误是审计报告 sha256 绑定：

```text
审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…
```

bodyConclusionOf(G1)=pass；正文证据表与不变量表均 OK。预签状态只作用于签名与锚点，解析器对门正文的结论保持 pass。保留 P2-1。

### 4.3 P2-2 预签噪声

主仓与候选 clone 的预签 vitest 都是 348/359，11 例全在 tests/gate-check.spec.ts；signed-safe 上 359/359。11 条用例：

```text
G1 门记录通过
改 candidate_hash 但锚点不动时报哈希不符
证据文件的哈希对不上时指名哪一份（审计 F1）
evidence_index_hash 被改时指名证据索引不符
candidate_hash 改成别处的值时指名与候选文件不符
正文必过项的内容列被改时指名不一致（审计 N-09）
正文证据表的哈希被改时拒绝（审计 R3-06）
正文不变量说明被改时拒绝（审计 R3-06）
不变量语句被削短后即使重算哈希也拒绝（S1 第八轮 P1-3）
证据文件与固定文件映射不一致时拒绝（S1 第二轮审计）
正文自锚 body_hash 被改时拒绝（审计 R3-08）
```

11 条的首个错误均为同一审计报告 sha256 绑定，属于同一个预签态根因。保留 P2-2。

## 五、边界与残余风险

- 本报告固定审计 ca2b196；主工作树后来推进到 e7a3fa4，该提交含 gate-check.ts 的额外改动，超出本报告范围。主工作树在审计期间另有 S1/S2 修复改动处于工作区，同样超出本报告范围。复现必须使用 clone 的 ca2b196 检出。
- 本报告只新增 docs/audits/S1-independent-audit-round22.md；源码、门记录、证据保持原样；主仓 G1 保持预签。
- history-remote-negative-crosspara 以结论歧义返回 null 的方式 fail-closed，该路径可用；错误定位在 gate-check.ts:1535，归入边界观察，不计 P0/P1。
- signed-safe 的 d4d576a 属于 clone 内的机制自证；主仓 G1 保持预签。

## 六、报告自检

```text
auditConclusionOf = fail
auditBindingOf = {"gate":"G1","commit":"ca2b196e351552b8a055450fb81ed6653aff2197"}
```

自检命令：在 clone 内 import 候选 scripts/gate-check.ts，读取本报告全文，分别调用 auditConclusionOf 与 auditBindingOf；两者各返回唯一值。