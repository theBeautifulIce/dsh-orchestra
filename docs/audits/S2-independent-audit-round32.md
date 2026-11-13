# S2 独立审计 · 第 32 轮（G2）

- 门：G2
- 候选提交：98032b0753b4debcfaae073cad5eac638c0d8aac
- 结论：fail
- P0：2 · P1：1 · P2：1
- 审计日期：2026-11-14
- 审计方式：只读独立审计；攻击全部发生在临时克隆内，主仓只新增本报告

## 一、审计设置与基线

审计开始前主仓工作树 clean，HEAD=98032b0753b4debcfaae073cad5eac638c0d8aac。攻击在独立临时克隆 D:/aboutAI/dsh-orchestra-audit32 中进行（同一提交；node_modules 以 junction 借用主仓依赖，脚本字节与提交一致）。主仓源码、门记录、证据未改动，未提交主仓，未开 S3。

基线夹具：克隆内写两份合法审计报告 docs/audits/S1-independent-audit-round32.md 与 docs/audits/S2-independent-audit-round32.md（含唯一的 门：G1/G2、候选提交：98032b0…、结论：pass），并把 G2 门正文中三处历史否定叙述改为中性表述；两个 GateArtifact 的 audit_round=32、audit_report 指向对应夹具。克隆内提交：d09753c（夹具）、8697668（重签 G1）、2652913（重签 G2，基线）。

- G1：sign-gate exit 0（13 份证据），artifact=624e88f9ce22943b203bf3acc94c088948f037f3adf72559b50345a06eb38dde，body=c80773ef1004a877977241906fce291ceb377204be3bbcd31047b1fb024b52a0；gate-check exit 0（13 项必过、13 份证据哈希复核）。
- G2：sign-gate exit 0（19 份证据），artifact=cc481af20a35de9fc333d9c8f2c36b99258ee952c847cb12ff939cf7ec5d9586，body=fdb927397c4b75070ae157d987d5a462df909c594598f58d90496e448f116967；gate-check exit 0（19 项必过、19 份证据哈希复核）。

每个载荷的流程：reset --hard 2652913 → 注入 → commit → node scripts/sign-gate.ts docs/gates/G2.md → 记录退出码与 docs/gates/G2.md 是否变化 → sign 成功则提交门文件后跑 node scripts/gate-check.ts docs/gates/G2.md。下表 artifact/body 为前 16 位，完整 64 位见附录。

## 二、载荷与实跑结果

### 报告侧（docs/audits/S2-independent-audit-round32.md 追加或替换结论行）

| 编号 | 位置 | 载荷（⏎ 为换行） | sign | 门变化 | gate-check | artifact / body | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | 报告 | 整改工作尚未全部完成。 | 0 | 是 | 0 | 06bbca85b08ee876… / 152744a91e70a459… | 绕过（签过） |
| R2 | 报告 | 本次审计未通过验收检查。 | 0 | 是 | 0 | 15f9f03e4a210592… / 876b90b2cec52ac7… | 绕过（签过） |
| R3 | 报告 | 本轮审计存在未完成项。 | 0 | 是 | 0 | af82c92878aeb6d2… / 3f44291b769fc10c… | 绕过（签过） |
| R4 | 报告 | [本次审计结论：fail⏎]: /url（引用定义标签跨行） | 0 | 是 | 0 | 2351cf6153f1c0c9… / 85243120f7fd5cec… | 绕过（签过） |
| R5 | 报告 | [1]: /url⏎"a⏎b⏎c⏎d⏎本次审计结论：fail"（否决在第 5 行标题内） | 0 | 是 | 0 | d16cc6204c157f50… / ee3bf87b713caaf7… | 绕过（签过） |
| R6 | 报告 | > [本次审计结论：fail⏎> ]: /url（块引用跨行标签） | 0 | 是 | 0 | 757f9cb1e44e20fb… / 8a93cce8cc52e8e2… | 绕过（签过） |
| R7 | 报告 | [本次审计结论：&#102;ail⏎]: /url（跨行标签 + 实体） | 0 | 是 | 0 | a2f2f01cf3e92466… / befad748d559b796… | 绕过（签过） |
| R8 | 报告 | [1]: /url "本次审计结论：fail"（单行定义，对照） | 1 | 否 | 1 | — / — | 挡住 |
| R9 | 报告 | 整改工作未完全完成。（对照） | 1 | 否 | 1 | — / — | 挡住 |
| R10 | 报告 | 本轮 19 项均通过，无失败项。（正控） | 0 | 是 | 0 | fc75ed2308f3a12a… / fcc1d3e293462810… | 正控签过 |
| R11 | 报告 | 本次审计结论：通过，但准入条件尚未满足。（对照） | 1 | 否 | 1 | — / — | 挡住 |
| R12 | 报告 | 本次审计未通过最终验收。（对照） | 1 | 否 | 1 | — / — | 挡住 |
| R13 | 报告 | 本次审计未获得全部通过。 | 0 | 是 | 0 | 3d487fc675fcb7bc… / 1c34804861b1be33… | 绕过（签过） |
| R14 | 报告 | 本次审计没有取得全部认可。 | 0 | 是 | 0 | c76063be1068f32e… / 46a556ba7cfcd0b8… | 绕过（签过） |
| R15 | 报告 | 结论：pass，整改尚未全部完成（替换结论行） | 1 | 否 | 未运行 | — / — | 挡住 |

### 门正文侧（docs/gates/G2.md）

| 编号 | 位置 | 载荷（⏎ 为换行） | sign | 门变化 | gate-check | artifact / body | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | 门正文 | - 结论：**pass**（整改尚未全部完成） | 0 | 是 | 0 | cc481af20a35de9f… / ea1e4a2288ada67b… | 绕过（签过） |
| B2 | 门正文 | - 结论：**pass**，整改尚未全部完成 | 0 | 是 | 0 | cc481af20a35de9f… / cab2248c862206d5… | 绕过（签过） |
| B3 | 门正文 | 追加 [本次审计结论：fail⏎]: /url | 0 | 是 | 0 | cc481af20a35de9f… / 8c9159da35b3505f… | 绕过（签过） |
| B4 | 门正文 | 追加 本次审计结论：fail（对照） | 1 | 否 | 1 | — / — | 挡住 |
| B5 | 门正文 | - 结论：**pass**（准入条件尚未满足）（对照） | 1 | 否 | 1 | — / — | 挡住 |

说明：拒签行的 gate-check exit 1 是拒签后对攻击态的独立复核（HEAD 报告已变、门未重签），不是签过后的检查；R15 在 sign 阶段即被拒，故未跑 gate-check。B1–B3 的 artifact 不变（只改门正文），body 哈希各自变化。

汇总：签过（绕过）12 个——R1–R7、R13、R14、B1、B2、B3；挡住 7 个——R8、R9、R11、R12、R15、B4、B5；正控签过 R10，基线双门 exit 0。

## 三、关键发现

### P0-1 可见句的量词/副词与名词宾语洗白（R1、R2、R3、R13、R14 实跑签过）

载荷本身完整可见、无任何隐藏语法，门仍签 pass 且 gate-check exit 0，属于直接假通过。三处解析缺口叠加：

- scripts/gate-check.ts:813-823 的 FAIL_FILLERS 只收 完全/完全地/彻底/徹底/根本/真正/作为，未收 全部/逐一/逐项/地。matchStructuralNegative（scripts/gate-check.ts:885-908）要求否定词后 ≤6 个 filler 接谓语，于是「尚未全部完成」「未取得全部通过」「没有取得全部认可」在 全部/取得 处断链；clause-tail（scripts/gate-check.ts:969-977）只在结构否定恰好吃到分句末尾时触发，也不补位。
- scripts/gate-check.ts:933-935 与 956-968 要求裁决词后下一个字符为空、| 或 [需应已的了]；「未通过验收检查」「存在未完成项」的裁决词后是名词，边界不成立，FAIL_VERDICTS 不命中。
- 静态同族探针（parser 级，未走完整签名）同样 pass/pass：本次审计未取得全部通过、本次审计未通过全部验收、整改工作未逐项收口、本次审计尚未全部满足准入条件、整改工作未彻底地完成、本次审计未全部取得认可。可见缺口不止 5 条实跑载荷，量词与谓词后名词是成族问题。

### P0-2 跨行引用定义窗口洗白（R4、R5、R6、R7、B3 实跑签过）

- hiddenDefinitionFailure（scripts/gate-check.ts:1035-1050）只识别单行标签，起点正则 scripts/gate-check.ts:1038 为 ^[ \t]*(?:>[ \t]*)*\[[^\]]+\]:，且只向后扫 3 行（remaining=3，scripts/gate-check.ts:1039-1045）。
- markdown-it（html:true）把跨行标签的链接引用定义、以及定义后跨多行的引号标题都渲染成不可见节点；renderedAuditLines 只看到干净的 结论：pass，hiddenDefinitionFailure 又看不到第 4 行以后或跨行标签里的否决，于是否决被另一段干净 pass 完整洗掉。
- 实跑覆盖：R4 标签跨两行；R5 否决藏在定义后标题的第 5 行（超出 3 行窗口）；R6 块引用内跨行标签；R7 跨行标签内 HTML 实体 &#102;ail。四条都签 pass、gate-check exit 0。B3 把同样的跨行定义追加进 G2 门正文，门正文里因此实际写入了一句「本次审计结论：fail」，仍被签 pass。
- 对照：R8 单行定义 [1]: /url "本次审计结论：fail"、B4 正文可见 fail 均被拒，说明缺口边界正是「跨行/超出 3 行窗口」，而非实体或块引用本身。

### P1-1 门正文与报告结论只校验裁决值，不校验尾巴语义（B1、B2 签过；R15 被拒）

- verifyGateRecord（scripts/gate-check.ts:1835-1839）只要求 bodyConclusionOf(text) 与 artifact.conclusion 的裁决值相等。
- bodyConclusionOf（scripts/gate-check.ts:1103-1128）不调用 validConclusionTail；auditConclusionOf（scripts/gate-check.ts:1052-1099，第 1094 行）会调用。B1「- 结论：**pass**（整改尚未全部完成）」、B2「- 结论：**pass**，整改尚未全部完成」因此都能重签成功且 gate-check exit 0。
- 同一尾巴放在报告侧被 R15 实测拒绝：结论：pass，整改尚未全部完成 → sign-gate exit 1，报错「审计报告里找不到唯一结论行，不能拿它当门记录依据」（scripts/gate-check.ts:1738）。
- 影响：签过后的门正文可以公开写着「整改尚未全部完成」却仍以 pass 入档，而报告侧不允许同样写法，正文与报告并非同源校验；这是记录可信度问题，未直接产生 artifact=pass 的假通过，故列 P1。

### P2-1 回归用例只覆盖上一轮原句（tests/gate-check.spec.ts）

候选提交新增用例覆盖了 未完全完成、还没有完成、单行引用定义、单行块引用/实体、post-pass 准入条件尚未满足，但未覆盖：量词 filler（全部/逐一/逐项/地）、跨行标签、定义后第 4 行起的否决、裁决词后名词宾语、门正文结论行尾巴。上述缺口因此在本轮全部复现。

## 四、额外检查

- 门正文与报告是否同源校验：裁决值同源（artifact.conclusion 必须同时等于报告结论与正文结论），但正文缺少 validConclusionTail，尾巴语义不同源，见 P1-1。
- 引用定义里藏的否决能否被另一段干净 pass 洗掉：能，见 P0-2；R4–R7、B3 已实跑。
- required_hashes 生产路径是否仍失败关闭：是，未发现缺口。src/core/policy.ts:26-77 的 evaluateEvidence 在证据缺失时 ok:false（第 32-34 行），对非 64 位十六进制、输出侧无同名绑定、重复产物摘要判 verification_too_weak（第 46-71 行），弱来源拒绝（第 72-75 行）；src/service/commands/apply-report.ts:257-260 对 !ok 直接 rejectReport，policyForReport（第 91-114 行）把 workflow_definition_hash 钉到定义（第 103-112 行）；src/service/workflows.ts:92-102 合并定义与节点 required_hashes。tests/apply-report.spec.ts:357-439 有伪造/非 sha/命令哈希/缺键/重复/null 产物负例与阳性对照（第 381-391 行）。
- 正控是否误伤：基线 G1/G2 双门 exit 0；R10「本轮 19 项均通过，无失败项。」签过且 gate-check exit 0；R8、R9、R11、R12、R15、B4、B5 均被拒。正控未被误伤，缺口集中在同族新变体。

## 五、复现与边界

复现命令（克隆内）：git reset --hard 2652913；注入载荷并 commit；D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G2.md；成功则 commit 后 D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md。逐载荷原始记录在 D:/aboutAI/audit32-results.json。

边界：本轮只对 G2 做完整签名攻击；G1 与 G2 共用 auditConclusionOf/bodyConclusionOf/hiddenDefinitionFailure，故同一缺口对 G1 同样成立，但未逐条重跑 G1。gate-check 的 G1/G2 证据哈希、必过项清单、candidate hash 未被绕过。

## 附录：完整哈希

```
baseline G1 artifact=624e88f9ce22943b203bf3acc94c088948f037f3adf72559b50345a06eb38dde body=c80773ef1004a877977241906fce291ceb377204be3bbcd31047b1fb024b52a0
baseline G2 artifact=cc481af20a35de9fc333d9c8f2c36b99258ee952c847cb12ff939cf7ec5d9586 body=fdb927397c4b75070ae157d987d5a462df909c594598f58d90496e448f116967
R1  artifact=06bbca85b08ee876d4e24f1f2412a9dfdd3d58fa155c097880952dd8bd10aa93  body=152744a91e70a45929ee40cae51a82a4e2104d407d4813dc6ef7f6f8d054f9ff
R2  artifact=15f9f03e4a210592e05b3ff28ec8ea0ef96eb7b9113d3be51b0e756343fd37f9  body=876b90b2cec52ac7771c36f9326758b0a826cfb18f30baafb85ae3cbd8c90ff0
R3  artifact=af82c92878aeb6d225cb49c163cfbee47ecd3cee0e82da605ba1ae85f51a4ee0  body=3f44291b769fc10c5e9db7ae222c9794b0ea6a84aa4f3a48c402ab3b8ebaefa0
R4  artifact=2351cf6153f1c0c923acd37097255c3525ad6a81672516d44252e50c88942b74  body=85243120f7fd5ceccbe7fca95267f58486358cc662d80f825e12056247d3e751
R5  artifact=d16cc6204c157f50616fcdf9a7647ca0121ac249d6f008d644a9dd9a2c6822f7  body=ee3bf87b713caaf79df77cc5af24890ffa54b1c5b6df45c889568503b9d72e52
R6  artifact=757f9cb1e44e20fb5a548e838b3efdc5667a82fee812ca880f370ffd8a999346  body=8a93cce8cc52e8e26b289727ca596e004eaa0d699abee81888b2f50fc74f0256
R7  artifact=a2f2f01cf3e924664ec210544c509162075b3a68b7b55f63e083498ad640826b  body=befad748d559b796e9fbec19c3a752512c729c68e6cf716a30183915ab3e0165
R10 artifact=fc75ed2308f3a12a8c0f7cfabf71da7d2c72b7303cd2e57bc9427b1cbec4ee78  body=fcc1d3e293462810e1f77e49c86b87ca4d3f6851a5b31892f4a31bae1f1000fd
R13 artifact=3d487fc675fcb7bc903148fc448b2cf01206b17a885170ab13265cddee4a172e  body=1c34804861b1be33b7f870ae25ce910fa2cd9a510236973925a61e131ca39a5f
R14 artifact=c76063be1068f32edccf95311480dae10ff44f0d38331870d0c922344b68612c  body=46a556ba7cfcd0b83138e30435ec1efeed6eb4b608a623bd5ef316f8373e6306
B1  artifact=cc481af20a35de9fc333d9c8f2c36b99258ee952c847cb12ff939cf7ec5d9586  body=ea1e4a2288ada67b28ca82dfed949ca629b1c0cecce0cbc19087ad0d3e45cc5e
B2  artifact=cc481af20a35de9fc333d9c8f2c36b99258ee952c847cb12ff939cf7ec5d9586  body=cab2248c862206d50c96922b4d7f83c12d4b02f851fc951fd9300de5721d438d
B3  artifact=cc481af20a35de9fc333d9c8f2c36b99258ee952c847cb12ff939cf7ec5d9586  body=8c9159da35b3505fd97f99efb09dba75e28dc458de0b0b38473ef7b82f030c95
```

## 结论

结论：fail
