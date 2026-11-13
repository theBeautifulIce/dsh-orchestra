门：G1
候选提交：d1dfe12faa17cdab7cd36f427d0e1331e2a12bf3

# S1 第二十三轮独立审计报告

审计对象固定为候选 d1dfe12faa17cdab7cd36f427d0e1331e2a12bf3（审计开始时的工作树 HEAD）。审计期间主工作树被并发提交推进（截至报告写入时为 a0b5597，含 S2 第二十七至二十九轮整改与 handoff 记录），这些提交超出本报告范围；本报告所有行号、命令、计数与数据均以候选提交的干净 clone 为准。clone 根：D:/aboutAI/_g1audit-r23/clone；环境：D:/NodeJs/node.exe v26.13.1；gate-check 与 sign-gate 均用 node --no-warnings 直跑 .ts。审计过程只读：未改动主仓源码、门记录、证据与测试，攻击复现全部在临时 clone 内完成。

结论：fail

## 一、复跑基线

| 检查 | 命令 | 退出码 | 计数 / 结果 |
| --- | --- | --- | --- |
| gate-check G1 | node --no-warnings scripts/gate-check.ts docs/gates/G1.md | 1 | 预签态：记录的报告 sha256 为 64 个 0，实际为 50ba1b13 开头 |
| tsc --noEmit | node node_modules/typescript/bin/tsc --noEmit | 0 | 0 诊断 |
| 全量 vitest | node node_modules/vitest/vitest.mjs run | 1 | 32 文件 / 363 例：352 通过，11 红 |

11 个红例全部落在 tests/gate-check.spec.ts，首因均为 G1 预签态的报告 sha256 绑定，与上一轮 response 记录的基线一致。gate-check 的实际输出：

```text
门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…
```

## 二、上一轮修复回归

| 套件 | 条数 | sign exit | gate-check | 结果 |
| --- | --- | --- | --- | --- |
| B 类（r22 报告级载荷） | 19 | 全部 1 | 未执行 | 19/19 拦截，G1 sha256 前后一致 |
| R 类（r22 已识别的真实绕过） | 19 | 全部 1 | 未执行 | 19/19 拦截，G1 sha256 前后一致 |
| S 类（历史安全句与清零句） | 11 | 全部 0 | 全部 0 | 11/11 放行，正常改签 |

B 类与 R 类的 38 条载荷全部由 sign-gate 挡在写盘之前，G1 字节前后完全一致；S 类 11 条安全句全部通过，未出现把安全句误判为负面结论的收紧回归。逐例完整 sha256 见附录 A。

## 三、新增攻击矩阵

新增 38 例（n 系列 23 例、m 系列 15 例），全部在 clone 内真实执行 sign-gate；sign exit 0 的再提交并执行 gate-check。结果：sign 放行 28 例且 gate-check 全部 exit 0，其中 25 例属于结论解析绕过，3 例属于设计内不可见载体；其余 10 例 sign exit 1。

### 3.1 P0-1 历史豁免吞掉当前轮陈述（7 例）

历史锚点本身是“已通过/结论为通过”时，stripHistoricalRemediation 仍把匹配段里第一个否定词当作历史否定截掉，当前轮的负面陈述随之消失。

```text
n01（报告）：上一轮审计已通过，本报告未通过验收，本轮已整改。
n02（报告）：上一轮审计结论为通过，本次审计未通过复核，本轮已修复。
n03（报告）：上一轮审计已通过，本报告被驳回，本轮已整改。
n04（报告）：上一轮审计已通过，结论：fail，本轮已整改。
n21（报告）：The previous audit was recorded as passing; this audit does not pass; this round is fixed.
n18（门正文）：上一轮审计已通过，本报告未通过验收，本轮已整改。
n22（门正文）：上一轮审计已通过，结论：fail，本轮已整改。
```

| 编号 | 载体 | sign exit | gate-check | G1 sha256 前 12 位 | 后 12 位 |
| --- | --- | --- | --- | --- | --- |
| n01 | 审计报告 | 0 | 0 | b6ecf5b736e9 | 14263fd3d49c |
| n02 | 审计报告 | 0 | 0 | 4b81a5832659 | 6e16ec41d7d6 |
| n03 | 审计报告 | 0 | 0 | 55ef9a7d2f24 | 5f68333ef183 |
| n04 | 审计报告 | 0 | 0 | 59787e5d2f7b | 7819dc3bd820 |
| n21 | 审计报告 | 0 | 0 | 851a85b795be | 3abbd38f5790 |
| n18 | G1 正文 | 0 | 0 | 12f9d0716a95 | 2267b8b611a5 |
| n22 | G1 正文 | 0 | 0 | 47d5f499409c | b9074d616687 |

七例均 sign exit 0、gate-check exit 0，G1 的 artifact、evidence-index、invariants 与两个 body 锚点都被改写。根因：scripts/gate-check.ts:865 的 HISTORICAL_REMEDIATION_RES 先匹配“上一轮…本轮已整改”，:872 的 HISTORICAL_NEG_RE 再在匹配段内找第一个否定词，:879-890 只保留该否定词之后的文字。历史锚为通过时段内本无历史否定，当前轮的否定因此被当成历史否定截掉。n18、n22 走 G1 正文，bodyConclusionOf 返回 pass。

### 3.2 P0-2 裁决词尾部守卫与宾语缺口（4 例）

“未通过”后面跟复核、最终验收、专家评审等自然宾语时，尾部守卫把紧邻汉字当作叙述继续而放行。

```text
n05（报告）：本报告未通过复核。
n06（报告）：本报告未通过最终验收。
n07（报告）：本次审计未通过专家评审。
n19（门正文）：本报告未通过复核。
```

| 编号 | 载体 | sign exit | gate-check | G1 sha256 前 12 位 | 后 12 位 |
| --- | --- | --- | --- | --- | --- |
| n05 | 审计报告 | 0 | 0 | 3e4caf51cda7 | b07437cc459a |
| n06 | 审计报告 | 0 | 0 | 261224a91ced | dc8d651758ec |
| n07 | 审计报告 | 0 | 0 | 83918b903f4e | d4be3a75051e |
| n19 | G1 正文 | 0 | 0 | 592d73355b7e | 168f3efca43d |

四例均 sign exit 0、gate-check exit 0。根因：scripts/gate-check.ts:838-846 的尾部守卫只接受 ''、'|' 或不含“需应已的了”的下一字符；中文没有词间空格，“未通过复核”的下一字符是“复”，不在 FAIL_OBJECTS(:778) 的宾语表里，连接词推进也走不到。n19 是同一缺口在 G1 正文上的复现。

### 3.3 P1-1 副词前缀挡住否定词（5 例）

“尚未/还没/暂未”把否定词推到扫描起点之后，连接词表里没有这几个副词，扫描在主语后停住。

```text
n08（报告）：本报告尚未通过。
n09（报告）：本报告还没通过。
n10（报告）：本报告暂未通过。
n11（报告）：本报告尚未获批。
m16（门正文）：本报告尚未通过。
```

| 编号 | 载体 | sign exit | gate-check | G1 sha256 前 12 位 | 后 12 位 |
| --- | --- | --- | --- | --- | --- |
| n08 | 审计报告 | 0 | 0 | f433a3120c13 | 0ba2e243d927 |
| n09 | 审计报告 | 0 | 0 | 73ffbfc1b947 | 66e09d3ea183 |
| n10 | 审计报告 | 0 | 0 | c4fb4e5c7ebd | def8dfdf1940 |
| n11 | 审计报告 | 0 | 0 | a843368a63df | ceafd01237f1 |
| m16 | G1 正文 | 0 | 0 | 753a039cda86 | 44dba01db4db |

五例均 sign exit 0、gate-check exit 0。根因：scripts/gate-check.ts:689 的 FAIL_CONNECTORS 不含“尚/还/暂”，结构否定要求否定词出现在当前扫描起点，故“本报告尚未通过”在“本报告”之后停住；m16 是同一缺口在 G1 正文上的复现。

### 3.4 P1-2 完成度陈述（5 例）

“整改尚未完成/仍未完成”与英文 remediation is not complete 都表示本轮未收口，但“整改”不在连接词表，complete 也不在谓词表。

```text
n12（报告）：本报告整改尚未完成。
n13（报告）：本轮整改仍未完成。
n20（门正文）：本轮整改仍未完成。
n24（报告）：This audit remediation is not complete.
m14（报告）：The audit remediation is not complete.
```

| 编号 | 载体 | sign exit | gate-check | G1 sha256 前 12 位 | 后 12 位 |
| --- | --- | --- | --- | --- | --- |
| n12 | 审计报告 | 0 | 0 | 9d40fd29f824 | ea6b14ef11fa |
| n13 | 审计报告 | 0 | 0 | f304e668d1e5 | 484a3e6d541a |
| n20 | G1 正文 | 0 | 0 | 19a22482a6d4 | 23181ceb66eb |
| n24 | 审计报告 | 0 | 0 | 61453c9333ef | ef396ee41f2d |
| m14 | 审计报告 | 0 | 0 | db42036033d6 | 589604e45ec5 |

五例均 sign exit 0、gate-check exit 0。根因：scripts/gate-check.ts:689 的连接词表不含“整改”，:770 的 FAIL_PASS_STEMS 不含“完成/complete”，结构否定无法越过这些词。n20 是同一缺口在 G1 正文上的复现。

### 3.5 P1-3 英文 not yet（2 例）

```text
n14（报告）：This audit has not yet passed.
n15（报告）：This audit has not yet been approved.
```

| 编号 | 载体 | sign exit | gate-check | G1 sha256 前 12 位 | 后 12 位 |
| --- | --- | --- | --- | --- | --- |
| n14 | 审计报告 | 0 | 0 | 1476d489fcdc | d0ebf44eaa9c |
| n15 | 审计报告 | 0 | 0 | 93434c52ba15 | 94ec09d24730 |

两例均 sign exit 0、gate-check exit 0。根因：scripts/gate-check.ts:766 的 FAIL_FILLERS 不含 yet，“has not yet passed”在 not 之后无法到达 passed。

### 3.6 P2-1 混合字形宾语缺口（1 例）

```text
m01（报告）：本报告未通過复核。
```

| 编号 | 载体 | sign exit | gate-check | G1 sha256 前 12 位 | 后 12 位 |
| --- | --- | --- | --- | --- | --- |
| m01 | 审计报告 | 0 | 0 | b90b61e4e8bc | 964c13f60c43 |

sign exit 0、gate-check exit 0。根因：繁體谓词“未通過”命中 FAIL_VERDICTS，但仍受 3.2 的尾部守卫限制；宾语“复核”不在 FAIL_OBJECTS(:778)，与 P0-2 同族，只是需要繁體谓词配合。

### 3.7 P2-2 同形字缺口（1 例）

```text
m02（报告）：This audit does not paß.
```

| 编号 | 载体 | sign exit | gate-check | G1 sha256 前 12 位 | 后 12 位 |
| --- | --- | --- | --- | --- | --- |
| m02 | 审计报告 | 0 | 0 | d5afb590e4c3 | 55cc43a64f9a |

sign exit 0、gate-check exit 0。根因：scripts/gate-check.ts:710 的 HOMOGLYPHS 未收录 ß，“paß”折叠后仍不是 pass，谓词表匹配不到。

### 3.8 被拦截的 10 例

```text
n16（报告）：`本报告未通过`
n17（报告）：[本报告未通过](https://example.invalid/x)
m03（报告）：本报告未​通过。
m04（报告）：本 报 告 未 通 过。
m07（报告）：![本报告未通过。](x.png)
m08（报告）：> 本报告未通过。
m10（报告）：审计 经过 报告 结果 经过 复核 结论 经过 评审 结果 经过 审核 结论 经过 复核 报告 结果 经过 审计 还是 未通过。
m11（报告）：上一轮审计已通过，本轮已整改。 / 结论：fail
m12（报告）：<details><summary>x</summary> / 本报告未通过。 / </details>
m13（报告）：[x]: https://example.invalid / 本报告未通过。
```

| 编号 | 载体 | sign exit | gate-check | G1 sha256 前 12 位 | 后 12 位 |
| --- | --- | --- | --- | --- | --- |
| n16 | 审计报告 | 1 | - | c7699bf7bf14 | c7699bf7bf14 |
| n17 | 审计报告 | 1 | - | b5f0a6c371b6 | b5f0a6c371b6 |
| m03 | 审计报告 | 1 | - | 8020189995a3 | 8020189995a3 |
| m04 | 审计报告 | 1 | - | d2ddb93eefed | d2ddb93eefed |
| m07 | 审计报告 | 1 | - | 6b05ab59bb90 | 6b05ab59bb90 |
| m08 | 审计报告 | 1 | - | de9acddf8c3c | de9acddf8c3c |
| m10 | 审计报告 | 1 | - | 4a2d27d28d82 | 4a2d27d28d82 |
| m11 | 审计报告 | 1 | - | c772fedbb5bf | c772fedbb5bf |
| m12 | 审计报告 | 1 | - | 8e0f7c10ff99 | 8e0f7c10ff99 |
| m13 | 审计报告 | 1 | - | 71f3bbee5f62 | 71f3bbee5f62 |

十例 sign exit 1，G1 sha256 前后一致，gate-check 未执行。行内代码、链接文字、零宽字符、空格拆字、图片 alt、引用块、长连接词链、拆行结论、details 块与引用定义都被挡下，说明 r22 之后这些载体没有回归。

### 3.9 设计内不可见载体（3 例，不计入 P0/P1/P2）

```text
m05（报告）：``` / 本报告未通过。 / ```
m06（报告）：<!-- 本报告未通过。 -->
m09（报告）：    本报告未通过。
```

| 编号 | 载体 | sign exit | gate-check | G1 sha256 前 12 位 | 后 12 位 |
| --- | --- | --- | --- | --- | --- |
| m05 | 审计报告 | 0 | 0 | 2c9d440ec193 | e57dbb433b01 |
| m06 | 审计报告 | 0 | 0 | 436f4625e958 | c26f187e4700 |
| m09 | 审计报告 | 0 | 0 | da35aee09947 | 6060b54e9d71 |

三例 sign exit 0、gate-check exit 0，但载荷位于围栏代码块、HTML 纯注释与四空格缩进代码内。renderedAuditLines 的既定契约就是跳过这些不可见载体，结论行本身干净，故不按绕过计。本报告的 fail 判定不依赖这三例。

## 四、分级与判定

| 级别 | 编号 | 问题 | 例数 |
| --- | --- | --- | --- |
| P0 | P0-1 | 历史豁免吞掉当前轮陈述（报告 5 例、门正文 2 例） | 7 |
| P0 | P0-2 | 裁决词尾部守卫与宾语缺口（报告 3 例、门正文 1 例） | 4 |
| P1 | P1-1 | 副词前缀挡住否定词（报告 4 例、门正文 1 例） | 5 |
| P1 | P1-2 | 完成度陈述越过连接词与谓词表（报告 4 例、门正文 1 例） | 5 |
| P1 | P1-3 | 英文 not yet 越过填充词表 | 2 |
| P2 | P2-1 | 混合字形宾语缺口 | 1 |
| P2 | P2-2 | ß 同形字缺口 | 1 |

合计 25 例真实绕过，另有 3 例设计内载体不计。计数：P0=2、P1=3、P2=2；新增攻击 38 例中 sign 放行 28 例、拦截 10 例。

按判定口径，候选提交下存在多例可让 sign-gate exit 0 并改写 G1、且 gate-check exit 0 的绕过，故本轮判定为 fail。

## 五、复现命令

```text
cd D:/aboutAI/_g1audit-r23/clone
git reset --hard d1dfe12faa17cdab7cd36f427d0e1331e2a12bf3
git clean -fdq -e node_modules
# 写 docs/audits/S1-attack-roundN.md（载荷见第三节），把 G1 的 audit_round / audit_report 指向它
# gatebody 例再把载荷插到 G1 正文的“## 证据索引（gates 用）”之前
git add -A
git -c user.name=audit-r23 -c user.email=audit-r23@example.invalid commit -q -m "attack <id>"
node --no-warnings scripts/sign-gate.ts docs/gates/G1.md; $LASTEXITCODE
git add -A
git -c user.name=audit-r23 -c user.email=audit-r23@example.invalid commit -q -m "signed <id>"
node --no-warnings scripts/gate-check.ts docs/gates/G1.md; $LASTEXITCODE
```

逐例证据：D:/aboutAI/_g1audit-r23/evidence/ 下按编号命名的目录，含 report.md、meta.json（signExit/gateExit/shaBefore/shaAfter）、G1.signed.md 与 gate-check.out.txt，覆盖 30 例；87 例的 sha256 记录见附录 A（30 例为 64 位完整值，其余为前 12 位）。

## 附录 A：逐例 sha256 记录

字段顺序：编号 载体 sign_exit gate_exit sha256_before sha256_after。gate_exit 的 - 表示 gate-check 未执行。证据目录覆盖的 30 例为 64 位完整值，其余为前 12 位；前后值相同即表示 G1 字节未变。

```text
b01 report 1 - 40831f66bc73828549138ab309f1056cba501eaca66596289baad07160237fb0 40831f66bc73828549138ab309f1056cba501eaca66596289baad07160237fb0
b02 report 1 - 644d2490310d 644d2490310d
b03 report 1 - f49ce34587dc f49ce34587dc
b04 report 1 - 74df84153e59 74df84153e59
b05 report 1 - e367c2863175 e367c2863175
b06 report 1 - 8d9a4cff7917 8d9a4cff7917
b07 report 1 - a418a7431ab2 a418a7431ab2
b08 gatebody 1 - 3985383fd737c242cbad15e1b454d3a5d3c8281a7f6a5cbbc7a5433b6acc6184 3985383fd737c242cbad15e1b454d3a5d3c8281a7f6a5cbbc7a5433b6acc6184
b09 gatebody 1 - 42ef536353b1 42ef536353b1
b10 report 1 - 87c4736ced76 87c4736ced76
b11 report 1 - 4cbb7087cb2a 4cbb7087cb2a
b12 report 1 - c792fd8a3a57 c792fd8a3a57
b13 report 1 - fa1190e3209e fa1190e3209e
b14 report 1 - a5ffa189965d a5ffa189965d
b15 report 1 - 13a4f785588b 13a4f785588b
b16 report 1 - b4683303639f b4683303639f
b17 report 1 - 8ac7231f6049 8ac7231f6049
b18 report 1 - f80c4c676235 f80c4c676235
b19 report 1 - feb0bbcb2482 feb0bbcb2482
r01 report 1 - 5ad5996d8c660787a699838c45b08df0e7f9d35a34c9ba2ca6dc6df99ce90b2b 5ad5996d8c660787a699838c45b08df0e7f9d35a34c9ba2ca6dc6df99ce90b2b
r02 report 1 - c4913bc947fa c4913bc947fa
r03 report 1 - 9911c9577aca 9911c9577aca
r04 report 1 - 9ec31ecc778a 9ec31ecc778a
r05 report 1 - f5bc8dea9901 f5bc8dea9901
r06 report 1 - 3823ee4c1873 3823ee4c1873
r07 report 1 - 7d50837012f4 7d50837012f4
r08 report 1 - 427f27fcf394 427f27fcf394
r09 report 1 - 1f516cdcac3f 1f516cdcac3f
r10 report 1 - 8bf502484dc4 8bf502484dc4
r11 report 1 - ad3787f89399 ad3787f89399
r12 report 1 - d5423de7b464 d5423de7b464
r13 report 1 - 340025bebe95 340025bebe95
r14 report 1 - 8d26f82ee0e6 8d26f82ee0e6
r15 report 1 - d73d8e0e5382 d73d8e0e5382
r16 report 1 - d3ddfd02db32 d3ddfd02db32
r17 report 1 - f3113a4c69c4 f3113a4c69c4
r18 report 1 - 5dd4d0d72d7c 5dd4d0d72d7c
r19 report 1 - fcb434040122 fcb434040122
s01 report 0 0 42a5b90218aac07eb75f0f77da3d61dc2048718aa0827d5c0cf64fff72079a84 f38ccaf01f5e33aa3811e590afdae7df3984aa95d62072fd6a8994066b5c743b
s02 report 0 0 7fdc7e0a9052 d9d50c4cccba
s03 report 0 0 08482d290e5e 77078030cc91
s04 report 0 0 8e1d7ba02c2e 0bc223686b79
s05 report 0 0 f2e6b73978ac d5cc7c451679
s06 report 0 0 46037e8581a8 8bda784542d4
s07 report 0 0 38c73d69d39c face6f3fe5b2
s08 report 0 0 fb1cd2adc686 c310ea049d57
s09 report 0 0 ddd10e1b0e0b 43be3591619a
s10 report 0 0 d88ef41a1013 b25160e216f2
s11 gatebody 0 0 3063cc0e3f95 9bde43bced4e
n01 report 0 0 b6ecf5b736e98872d961ce347bbd36b7139e0066ef2558e4da5d2e7b5e799959 14263fd3d49c37f44bdba133782bd2da305a3860d2fdfe92b8c44eacfa2e6dac
n02 report 0 0 4b81a5832659 6e16ec41d7d6
n03 report 0 0 55ef9a7d2f24 5f68333ef183
n04 report 0 0 59787e5d2f7b75888a3850aafe9800ff7a715829034815be3651568f69b457bd 7819dc3bd820ead1f962531499b92ab76e572be7721ed88b46b2f3d4e9c64387
n05 report 0 0 3e4caf51cda73bf3777b843efe899c87df386a5c20c07d8ccd0b2fb51bd1d2d0 b07437cc459aed3272e5479d48c27c05dba0b832a7e5f96acbf04ddbe7ca1c62
n06 report 0 0 261224a91ced4a52a8f940190bb589e2f71624a8df3471ae2862651067010b0a dc8d651758ecb1634a77048486983d96baa11b1e11ba6e179d8f52572ea9d7a4
n07 report 0 0 83918b903f4e d4be3a75051e
n08 report 0 0 f433a3120c1316f525d9d2ecc76096aa0c16a73e38216daa8be36db3c85421ef 0ba2e243d927e4284a1cf0e8dff73314a503a3db54d98eedd02442d15c40b780
n09 report 0 0 73ffbfc1b947 66e09d3ea183
n10 report 0 0 c4fb4e5c7ebd def8dfdf1940
n11 report 0 0 a843368a63df ceafd01237f1
n12 report 0 0 9d40fd29f8248399995cb54cb78f5690b261dc6100ac2771bc28306890e0735a ea6b14ef11faff9835a0b2413dc5967a0a7b79b563bce5acad6c7356b72a71e5
n13 report 0 0 f304e668d1e5198458ed4c9c3967b55d82a8010026ec60435ea8d368e0c2aae9 484a3e6d541ac9f57016f90908a7c493a60d8ab2bb0af325c4de2be49ce27e22
n14 report 0 0 1476d489fcdcf05069dc3c2e8c4cb81b0a9987d6b7d82a199f0b2323e8a63241 d0ebf44eaa9c34f5df4c64409f4deea1d1cb0c8a5b6fc40049cd0ece4063e256
n15 report 0 0 93434c52ba15 94ec09d24730
n16 report 1 - c7699bf7bf14 c7699bf7bf14
n17 report 1 - b5f0a6c371b6 b5f0a6c371b6
n18 gatebody 0 0 12f9d0716a95ef2629033d6125e476953696503aa7027bc142f267dc300d1552 2267b8b611a5efa93fe578f517c87fca99cd1607fe79cf9e1c5962873894152d
n19 gatebody 0 0 592d73355b7e928193db528bcd5890b52c7b1d2688728921a41c7696e659065a 168f3efca43df0851e671e6fcf87a014ce348a75c7ef79f056644c946eb2475a
n20 gatebody 0 0 19a22482a6d4 23181ceb66eb
n21 report 0 0 851a85b795be 3abbd38f5790
n22 gatebody 0 0 47d5f499409cd8c6c2607d6cecba708abe6826291a846f4ae6eadf16f03f0821 b9074d6166879cd5a013cbe8fad7f6989a92e1fcb0543bbc02c3003fa8600867
n24 report 0 0 61453c9333ef ef396ee41f2d
m01 report 0 0 b90b61e4e8bc65a64d20b94058bcff6090b9b98c64f077b6bc4f2eb57dded5f6 964c13f60c4301af89da6cf98e4a19485fc263f9c842469a07555c55bde5b781
m02 report 0 0 d5afb590e4c3c0611f088fbcedcb1f61475b3991739dd176198d508554de8799 55cc43a64f9af0800661215575460e4e5e87dac305d873434ad215636b53c2d8
m03 report 1 - 8020189995a375fbbf41fbaced611dd306c39e5d02aad4a7ee8d2571bbd06a47 8020189995a375fbbf41fbaced611dd306c39e5d02aad4a7ee8d2571bbd06a47
m04 report 1 - d2ddb93eefed6aee9117a141d51f5dd8c231da177dca5e6e421d60b2459113f9 d2ddb93eefed6aee9117a141d51f5dd8c231da177dca5e6e421d60b2459113f9
m05 report 0 0 2c9d440ec1933a2037158145d05425876574b399373279100cde2e985c8d7924 e57dbb433b01697b7af74d27d9815cca4f905c3738701b1d0237508bc631b2ae
m06 report 0 0 436f4625e9583f0766933cc9285aa8af591f9f4691e9e8b3a71a10cf7a481194 c26f187e470015833e6fa83c8f6d4309f155ba60531aafebd1b70e7e884c4a7b
m07 report 1 - 6b05ab59bb900b8f453f2e46bcf6f29aa59c888e6b9fb61889a6576103f655fa 6b05ab59bb900b8f453f2e46bcf6f29aa59c888e6b9fb61889a6576103f655fa
m08 report 1 - de9acddf8c3c5ce4326ef9a7125ccc42cf865b8c3f1d197a5122e5762fa3e14e de9acddf8c3c5ce4326ef9a7125ccc42cf865b8c3f1d197a5122e5762fa3e14e
m09 report 0 0 da35aee0994736c8d6c17258e8f1ebd7f27be0795a41c8f438993fe6a7d649a1 6060b54e9d7176a6aa922182545a603eed53ba6d791f3152fcb10cb8915b1468
m10 report 1 - 4a2d27d28d8267fa5ae86de49c950f683a0d29e7a6cba9917e5e101fbc646e2b 4a2d27d28d8267fa5ae86de49c950f683a0d29e7a6cba9917e5e101fbc646e2b
m11 report 1 - c772fedbb5bf02a10a9f76b4cc12876cceaaaf5f8ceecb530f68de7d18fecb31 c772fedbb5bf02a10a9f76b4cc12876cceaaaf5f8ceecb530f68de7d18fecb31
m12 report 1 - 8e0f7c10ff99717c77b1a159d493659eb807b3a8627c9d220084955a23480331 8e0f7c10ff99717c77b1a159d493659eb807b3a8627c9d220084955a23480331
m13 report 1 - 71f3bbee5f620711def72659ee06c51eac650fb7f1ab7610f76f133916f8c9db 71f3bbee5f620711def72659ee06c51eac650fb7f1ab7610f76f133916f8c9db
m14 report 0 0 db42036033d6a373cec89923d67f675b99a3670fbfd840c2e82656879344a6d4 589604e45ec5466d5b457a0e41fd38afea1f74fc1ede998ee3abe8bb929a44a7
m16 gatebody 0 0 753a039cda86763241924729ccb07d0ac215926065a901c4235b42ae8f53c283 44dba01db4db9f4ae890ae5d3b14cd1327074c6021aa11017191d60c13d17613
```
