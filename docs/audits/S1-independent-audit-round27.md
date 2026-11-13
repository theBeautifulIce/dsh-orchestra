# S1 / G1 独立审计（第二十七轮）

门：G1
候选提交：98032b0753b4debcfaae073cad5eac638c0d8aac

- 裁定：**fail**
- P0：3；P1：2；P2：2
- 候选提交标题：Close S1 round25-26 and S2 round31 conclusion gaps
- 审计范围：审计报告结论行、门记录正文结论行、引用定义、证据门 required_hashes 生产路径
- 只读声明：主仓源码、门记录、证据未改；只在临时克隆 D:/aboutAI/dsh-orchestra-aa27 内攻击；主仓只新增本报告

## 一、结论

本轮修复没有挡住同族缺口，候选提交判 fail。三个 P0 都能在克隆夹具里走完 sign-gate 与 gate-check 且两门 exit 0：句尾裸裁决词、门正文结论行尾巴、引用定义超过三行的隐藏否决。另有两个 P1：G2 门在 98032b0 上被历史叙述误判为 fail，无法重签；门正文与报告结论没有同源语义校验。required_hashes 生产路径仍失败关闭，未发现回归；只有空列表与实体白名单两个 P2。

## 二、夹具与基线

- 在 D:/aboutAI/dsh-orchestra-aa27 克隆 98032b0；core.autocrlf=false、core.eol=lf；node_modules 用 junction 指向主仓，未改主仓。
- G1 夹具报告 docs/audits/S1-independent-audit-round27.md，正文为门行、候选提交行、结论：pass；GateArtifact 的 audit_round 改为 27、audit_report 指向该夹具；sign-gate 重签后 gate-check exit 0。
- 克隆内 G1 基线：artifact_hash=5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208；body_hash=3440e9550852be74a625d40b951c19e7277fe9397feb80e991a839148c0782d7；candidate_hash=0fd82447cb086f9d0138c67d728d69759c963d33fceb73fb826160ddb41a4632。
- G2 夹具报告 docs/audits/S2-independent-audit-round32.md 同样准备好，但 sign-gate G2 在 98032b0 上 exit 1（见 P1-1），门文件未变，故 G2 没有可签基线。
- 主仓 HEAD 的 G1 与 G2 都处于未签/不可签状态：G1 的 audit_report_sha256 为 0，gate-check 在报告哈希处失败关闭；G2 在正文结论处失败。这不是克隆夹具造成的，单列在 P1-1 与基线说明里。
- 攻击矩阵 43 条：每条 reset 到 tag baseline（commit 7687610），在报告追加载荷、在门正文追加补记、或替换门头括号；提交后跑 sign-gate，签过则 amend 再跑 gate-check；记录退出码、门文件是否变化、artifact 与 body。正控 3 条（R-POS1、R-POS2、B-POS1）均签过且 exit 0，未被误伤。

## 三、P0

### P0-1 句尾裸裁决词仍签过（报告与门正文同族）

根因在 scripts/gate-check.ts:969-977：分句尾部循环只调用 matchStructuralNegative，从不调用 FAIL_VERDICT_RE；FAIL_VERDICT_RE 只在 954-968 的行首位置使用。于是没有主语、谓词又不在 stem 表里的尾巴直接漏掉。FAIL_VERDICTS 本身已收进 尚未整改、待整改、待补、未完成、未收口、部分通过（scripts/gate-check.ts:700-712），但 clause-tail 不用它。FAIL_PASS_STEMS（824-845）没有 开始、收口、到位、做完、闭环、整改；FAIL_FILLERS（813-823）没有 全部、均、都，所以 未完全完成 被挡而 尚未全部完成 仍然签过。

以下载荷都签过（sign-gate 0、gate-check 0、门文件变化；完整哈希见第六节）：

    R-01  本次审计通过，但整改工作尚未全部完成。
    R-02  本次审计通过，但整改工作还没有做完。
    R-03  本次审计通过，但本报告未满足全部准入条件。
    R-04  本次审计通过，但尚未整改。
    R-05  本次审计通过，但尚未收口。
    R-06  本次审计通过，但仍有 3 项致命待补。
    R-07  本次审计通过，但整改只完成了一半。
    R-08  本次审计通过，但准入条件仍缺 2 项。
    R-09  本次审计通过，但整改工作尚未开始。
    R-10  本次审计通过，但整改不到位。
    R-11  本次审计通过，但本报告并非全部通过。
    R-13  本次审计通过，但整改工作还没有全部完成。
    R-14  本次审计通过，但整改工作只完成了 80%。
    R-16  本次审计通过，原则上有 3 项待补。
    R-17  本次审计通过，但还有 2 项未收口。
    R-18  本次审计通过，但整改工作未完成收口。
    R-19  本次审计通过，13 项中 12 项通过。
    R-20  本次审计通过，但尚差 2 项。

门正文同族：B-01 尚未整改、B-02 尚未全部完成、B-03 仍有 3 项致命待补、B-04 尚未收口、B-05 未满足全部准入条件、B-12 未完成收口、B-13 13 项中 12 项通过，全部 sign 0、check 0、门变。B-11 原则上有 2 项待补也签过。B-06/B-07 是门头括号，归 P0-2。

挡住对照：R-12 报告未达到放行标准（sign 1）、R-15 整改尚未达到放行条件（sign 1）。这两条能走 尚未/未 + 达到 + 放行 的结构化否定；裸裁决词与计数尾巴走不到。

补充机制：并非全部通过 的否定前缀 并非 已在 FAIL_NEGATIONS（810），但 全部 不是 filler，谓词 通过 接不上，所以照样漏。整改不到位 的 到位、尚未开始 的 开始、未完成收口 的 收口 都不在 stem 表。13 项中 12 项通过、只完成 80%、尚差 2 项 没有任何 fail token，当前解析器没有计数/比例语义。

建议：clause-tail 同时试 FAIL_VERDICT_RE；补 全部、均、都 等 filler；补 开始、收口、到位、做完、闭环、整改 等 stem；对 N 项中 M 项、只完成百分比、尚差 N 项 增加计数规则；每条加回归用例。

### P0-2 门正文结论行尾巴不校验（可见 caveat 直接签过）

根因在 scripts/gate-check.ts:1103-1129：bodyConclusionOf 在 1109 收集正式结论行，1113 只查同一行里的固定 fail 词，没有调用 validConclusionTail；报告侧的 auditConclusionOf 在 1094 调用了该函数。门正文的结论行因此比报告弱一层。

实跑 B-06 把门头括号改为 13 项必过全过，失败项为空，无 run，仍有 3 项致命待补：bodyConclusionOf=pass，sign-gate 0，gate-check 0，门文件变化。B-07 改为 13 项必过全过，失败项为空，无 run，准入条件仍缺 2 项：同样签过。B-03 在门正文追加 失败项为空，仍有 3 项致命待补，无 run 也签过。

解析级对照（门正文单行与报告单行）：

    门正文：结论：**pass**（既未整改也未收口）    body=pass，报告 audit=null
    门正文：结论：**pass**（从原则上讲）          body=pass，报告 audit=null
    报告：  结论：**pass**                        后接 本次审计通过，但既未整改也未收口  audit=pass

门正文对 既未整改也未收口、从原则上讲 这类可见 caveat 全部放行；报告侧因为 validConclusionTail 会拒。B-08 准入条件尚未满足、B-09 同类门头被挡住（sign 1），说明只有带结构化否定的尾巴被挡，裸 caveat 与固定 fail 词表外的写法没挡。

建议：bodyConclusionOf 的 pass 分支走同一个 validConclusionTail；fail 词表补 未整改、未收口、待补、部分通过；门头括号与报告结论尾巴用同一校验函数；加 B-06/B-07 回归。

### P0-3 引用定义隐藏否决：三行窗口、嵌套、块引用、实体

根因在 scripts/gate-check.ts:1035-1050：startsDefinition 只认行首可选空白或 > 后的方括号定义；remaining 固定为 3，只扫起始行加后续 3 个非空行；空白行 reset；嵌套列表的 - [9]: 不匹配；块引用第 5 行不看；decodeHtmlEntitiesForInspection（1150-1161）只解数字实体和 amp、lt、gt、quot、apos、nbsp、colon、newline、tab。

实跑：R-H2 五段定义第 5 行放一句正式否决（原文见第七节 H2），可见正文是干净 pass，auditConclusionOf=pass，sign 0、check 0、门变。R-H3 写成列表嵌套写法（原文见第七节 H3），不被认为定义，sign 0、check 0。R-H6 五段块引用，第 5 行不看，sign 0、check 0。R-H4 用 &period; 实体，不解码，sign 0、check 0。B-14 在门正文放同样的五段定义，body=pass，sign 0、check 0。对照：R-H1 单行定义被挡（sign 1），R-H5 用 &colon; 也被挡（sign 1）。

回答引用定义里藏的否决能否被另一段干净 pass 洗掉：可以。否决落在第 5 行、嵌套列表、或块引用第 4 行之后时，干净 pass 直接赢；只有三行窗口内的才会被判歧义挡住。这是本轮声称已修的跨行定义/块引用/实体类，实际只修到三行与少数实体。

建议：按 Markdown 引用定义语法取整个定义块到空行，不设固定行数；允许列表与块引用嵌套；解码完整 HTML5 命名实体；定义块里出现正式判定词加 pass/fail 一律 fail 或 ambiguous。

## 四、P1

### P1-1 G2 门在 98032b0 上无法重签、无法通过（假阳性）

主仓 HEAD 实跑：

    node --no-warnings scripts/gate-check.ts docs/gates/G2.md
    门检查失败：门记录正文结论与 GateArtifact 不符：正文=fail，artifact=pass
    exit 1

克隆内 sign-gate G2 同样 exit 1，门文件未变，因此本轮无法建立 G2 基线。触发点是 docs/gates/G2.md:15/17/19/21 的历史叙述：第二轮独立审计判 G2 不通过、第五轮判 G2 不通过、第三轮仍判 G2 不通过、第六轮仍判 G2 不通过。HISTORICAL_REMEDIATION_RES（scripts/gate-check.ts:983-999）只剔除 上一轮/前一轮/roundN 加 本轮已整改/已整改/已修复/已收口 的小段；这些行写的是 逐条整改，不是 已整改，所以整行仍被当成本轮否定。

影响：G2 无法签、无法 gate-check，S2 收口被门自身假阳性卡住。这是可用性缺陷，不是绕过；正控在 G2 上被误伤。

### P1-2 门正文与报告结论没有同源语义校验

verifyGateRecord（scripts/gate-check.ts:1835-1849）只把 bodyConclusionOf(text) 与 artifact.conclusion 比；checkAuditAnchor（1716-1754）只把报告 sha256 与 auditConclusionOf(report) 与 artifact.conclusion 比。两条链各自成立即可，没有一处比较门正文的必过项、证据、例外叙述与报告正文是否同源。

结果：门正文可以写 失败项为空，仍有 3 项致命待补（B-03 已签过），报告可以是干净 pass；两者都等于 artifact=pass，门检查放行。报告字节被 sha256 钉住，但钉的是字节，不是语义。

建议：至少要求门正文结论尾巴与报告结论尾巴走同一校验器；进一步对必过项清单、证据表、例外段做结构化对照；加 body 与 report 都 pass 但互相矛盾的负向用例。

## 五、P2

### P2-1 required_hashes 空列表与未声明（生产路径仍失败关闭，但缺模式约束）

src/core/policy.ts:46-76：requiredHashes 非空时逐键校验 64 位 hex、output 同名字段、值等于 sha256(canonical_json(product))、产物摘要互不相同、strength 非 weak；任一失败 verification_too_weak。src/service/commands/apply-report.ts:257 传 policy.requiredHashes ?? []；空列表跳过产物绑定。apply-report.ts:318-326 的 systemEvidenceGate 仍要求 run_tool、strong、exit 0；traceBindingGate 345+ 绑 tool、exit、stdout、stderr、command hash。src/executor/run-node.ts:61-62 前向路径只接 derived 等于 pure，当前没有不可逆动作。

核查结果：已声明的 required_hashes 仍失败关闭，未发现回归；空列表是定义方选择，当前没有不可逆节点可利用。风险在将来：没有 schema 强制不可逆节点必须声明 required_hashes；tests/apply-report.spec.ts:357-429 覆盖弱证据、伪造、缺键、共用产物、null，但没有覆盖不可逆节点不声明。建议在节点 schema 里对 irreversible 强制 required_hashes 非空，并加负向用例。

### P2-2 HTML 实体解码白名单不完整

decodeHtmlEntitiesForInspection（scripts/gate-check.ts:1150-1161）只解数字实体和 amp、lt、gt、quot、apos、nbsp、colon、newline、tab。R-H4 的 本次审计结论&period;fail 未被解码，sign 0、check 0；但 &period; 解码为点号而不是冒号，严格说不是正式结论行，故列 P2 而非 P0。R-H5 的 &colon; 被正确挡住，说明冒号路径有效；缺的是完整命名实体表与 定义块里出现判定词就拒绝 的兜底。建议用完整 HTML5 命名实体表解码，并在定义块内出现 结论、判定、conclusion、verdict 加 fail/pass 时直接拒绝，不依赖冒号形态。

## 六、逐条实跑结果

| ID | 侧 | 类别 | 载荷 | 解析 | sign | check | 门变 | artifact_hash | body_hash | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R-POS1 | 报告 | control | 本次审计通过，13 项必过全过，失败项为空，无 run。 | pass（解析） | 0 | 0 | 是 | cea11d670c920d85f2cab8fde90ad0223f11f670411433094137e8c557c5329c | f5fe0288a5c3988797d71bd36c03509719f0ca2da1d6b27d92485b1f9ab2fa52 | 签过 |
| R-POS2 | 报告 | control | 未通过项为零，未发现否决项，13 项必过全过。 | pass（解析） | 0 | 0 | 是 | a512590d69c586b7c5fef560f83d9fb51a3759d213937895e6e55d79f9c132cb | c731a45e569c0e11cb9fec4cc36a4233c4992b84bd7d608241888ca4505b0713 | 签过 |
| R-01 | 报告 | degree | 本次审计通过，但整改工作尚未全部完成。 | pass（解析） | 0 | 0 | 是 | d31a81fb3392e21225c9fc4476c8970e2c7933af7807b2500fc6916d2ae71317 | 163e8b153857c1876809c9a43063f878767773d435c8e2f5264137bf3b481cd3 | 签过 |
| R-02 | 报告 | degree | 本次审计通过，但整改工作还没有做完。 | pass（解析） | 0 | 0 | 是 | f98783a593f64feddcf1dffbad4fa772b00c845bc5a42b74acf544e6d80f8363 | 61876aaad801ade5794638ad7d7cf9897cb1a8c22a31c03e108082ed4142e5c6 | 签过 |
| R-03 | 报告 | post-pass | 本次审计通过，但本报告未满足全部准入条件。 | pass（解析） | 0 | 0 | 是 | 3093666d08b71f16879b2e16fceb12be06e3f3df51bcff26a5a3bdd1d04f925f | 7b8475492a8543e7bef6dea9830798669356053433cd91ede92782ebb05ba5cb | 签过 |
| R-04 | 报告 | post-pass | 本次审计通过，但尚未整改。 | pass（解析） | 0 | 0 | 是 | 20ca84fa19d32e0707b441caab82a04c1866264069bfac2475ad9d59534e73c8 | cd9dff0eb0f4d44d465a12d015e8a85940dac461528a8edf7f54d440ed931bd8 | 签过 |
| R-05 | 报告 | post-pass | 本次审计通过，但尚未收口。 | pass（解析） | 0 | 0 | 是 | 21ed9c182ef449f862d63be56c4270ed977b59b1ba856e7abbab24c69718d434 | fae83563c3fb43e4c9f9cffd5b2b789f1672e0315ca13076ff343f47bc4f9083 | 签过 |
| R-06 | 报告 | post-pass | 本次审计通过，但仍有 3 项致命待补。 | pass（解析） | 0 | 0 | 是 | e68e9f841336e7e182d6a9770fcf24879ad15ab7876491100d4712ffa6281634 | b503299ff94cf82f14f86572589256c6b9bebb8c479ea3f5f378330b73c5710d | 签过 |
| R-07 | 报告 | degree | 本次审计通过，但整改只完成了一半。 | pass（解析） | 0 | 0 | 是 | 8b5572c319050d7f2536bbf5ccfd064abfcf76a6a48dc37e36deeec70b3fe9d2 | 544535730f71ff226ae452adc51016637c25285e19b096e24ede4bf0e4c5583d | 签过 |
| R-08 | 报告 | post-pass | 本次审计通过，但准入条件仍缺 2 项。 | pass（解析） | 0 | 0 | 是 | 87fa5b5512f261061ba12745d8a01ca3af01f581c21afd5c1adf70e127e3d036 | 594c8797bf0263cb55916c3822765706cd40d68a194b79d6043bd3d8defd3682 | 签过 |
| R-09 | 报告 | post-pass | 本次审计通过，但整改工作尚未开始。 | pass（解析） | 0 | 0 | 是 | cade23980c9c78e627b472a10b19d44b32a0b3961a641f009663c4e52796e656 | 2dd1d4fe9ade7fc1360a5473f06c8aa4ebe6c048e8b4ca19bd3b962450efa83b | 签过 |
| R-10 | 报告 | post-pass | 本次审计通过，但整改不到位。 | pass（解析） | 0 | 0 | 是 | 205879cc63d596886d0a29f630a6642b08001d751c49e58c8a52185e59dfe79c | f38a62614ee96eef677632886381b456b5f6687973c1eb58d43ddebcc89d2845 | 签过 |
| R-11 | 报告 | negation | 本次审计通过，但本报告并非全部通过。 | pass（解析） | 0 | 0 | 是 | 388a35911ba7b1bb386cccf9c2f12cd7fefea41db1bc4bd656334a9e744bb519 | fe22d3cba19b282729c83d4449ec6bb70b6f8f797c28c7ed7cbd58c4fdba9aab | 签过 |
| R-12 | 报告 | blocked-control | 本次审计通过，但报告未达到放行标准。 | null（歧义） | 1 | — | 否 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | 3440e9550852be74a625d40b951c19e7277fe9397feb80e991a839148c0782d7 | 挡住 |
| R-13 | 报告 | new-degree | 本次审计通过，但整改工作还没有全部完成。 | pass（解析） | 0 | 0 | 是 | 1315cd099a03f2ec296781e5eb53fc223ababdc8f297a5639dc441940230e896 | 299ed93992f5a50c1de95c1154c2f576c408d1859d7e044a37957dfdadc43399 | 签过 |
| R-14 | 报告 | new-degree | 本次审计通过，但整改工作只完成了 80%。 | pass（解析） | 0 | 0 | 是 | 310262813131bb296ddc1204e658edcf8e23b1c73554bb22e1944936efcca18d | f35faf8e749299ce449505d9d618e386322b1d2a823c6560859f22f625acc195 | 签过 |
| R-15 | 报告 | new-post-pass | 本次审计通过，但整改尚未达到放行条件。 | null（歧义） | 1 | — | 否 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | 3440e9550852be74a625d40b951c19e7277fe9397feb80e991a839148c0782d7 | 挡住 |
| R-16 | 报告 | new-modality-tail | 本次审计通过，原则上有 3 项待补。 | pass（解析） | 0 | 0 | 是 | eac5c744975829f7563873114e435ae4dfc62e0a3fd8c775c04b5572db6aa15b | 815dfdea30faed082a5e302c73c8ef88a2bfe612b79801d0b6e8edcbf2925b08 | 签过 |
| R-17 | 报告 | new-tail | 本次审计通过，但还有 2 项未收口。 | pass（解析） | 0 | 0 | 是 | b26ae6f3e7ea59737fbded36a0ce2f981371d6af1db7e96e9ff83fc89b6895d8 | a1d350f076949ca9a6b40c218217e259515b8b6ec7b648eeb9bbe03e4daa7e4e | 签过 |
| R-18 | 报告 | new-negation | 本次审计通过，但整改工作未完成收口。 | pass（解析） | 0 | 0 | 是 | 11311adce33442a52516b3133757a25d169f957763c1ac4f8c70d975b4290801 | 6aa3f3c3f8ae4a5df7d21cf627d6c9eb2f05530042b340b7222bbd7c16573e30 | 签过 |
| R-19 | 报告 | partial-pass | 本次审计通过，13 项中 12 项通过。 | pass（解析） | 0 | 0 | 是 | 666185f47c41dd28dbb93eb47190ddf7c33f4e95067a4cf181ffe15cb2542e5c | 9a7324542013a9ff3a60a918d5471d1bf3f695a5de5cb1abebb9373f60c427b2 | 签过 |
| R-20 | 报告 | new-tail | 本次审计通过，但尚差 2 项。 | pass（解析） | 0 | 0 | 是 | 093c3dc220f1f6408a097ae1b63870c8e6dc81c7708c3b95133444522b033baa | 2ed5cae295708f84ebfaa9bcf3137109d6c1c1295ff71bae9edb854e334e5455 | 签过 |
| R-H1 | 报告 | blocked-control | H1（单行定义，见第七节） | null（歧义） | 1 | — | 否 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | 3440e9550852be74a625d40b951c19e7277fe9397feb80e991a839148c0782d7 | 挡住 |
| R-H2 | 报告 | hidden-def | H2（五段定义，见第七节） | pass（解析） | 0 | 0 | 是 | ccaaec2ee02370e368333fc25cfba62f9bd7eb25ae08aeab6b309bd03e2d33bb | 590cfc333fceb14df59b59c05703aab177f37be88b504f7eeb487926619b5b56 | 签过 |
| R-H3 | 报告 | hidden-def | H3（列表嵌套定义，见第七节） | pass（解析） | 0 | 0 | 是 | d590d1a6c6c836733ae240730e553e3cce8ad5af1f6f7d596c577f7833ed82aa | a38acd28df55f21f01c3706002afbe4d63bfe1ef645973c7639cdac23dc75b39 | 签过 |
| R-H4 | 报告 | hidden-def | H4（&period; 实体，见第七节） | pass（解析） | 0 | 0 | 是 | e9f8b04e8a3838778e2b3b7c5b1e31164725ba17c8113a401ce80455fbca574e | eebb224a5b3259ac24a51b642da00e52a8cc0215f55ad7cb0f1347188c6351de | 签过 |
| R-H5 | 报告 | blocked-control | H5（&colon; 实体，见第七节） | null（歧义） | 1 | — | 否 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | 3440e9550852be74a625d40b951c19e7277fe9397feb80e991a839148c0782d7 | 挡住 |
| R-H6 | 报告 | hidden-def | H6（五段块引用，见第七节） | pass（解析） | 0 | 0 | 是 | 3489006f89f8cb811e8d510c8fc0089c5c21fa35a00677789b884ca576b1c2ba | 1d2ad2bfe263bf5acf6cd65c12baa312e74d2933f1fd46f34313946bc70fd2e2 | 签过 |
| B-POS1 | 门正文 | control | 本次审计通过，13 项必过全过，失败项为空，无 run。 | pass（解析） | 0 | 0 | 是 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | eb7d906f735f25387fdc93eecd56b5632bdaa49fc75e2b96b8f112ae1025fb00 | 签过 |
| B-01 | 门正文 | post-pass | 本次审计通过，但尚未整改。 | pass（解析） | 0 | 0 | 是 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | 4db3dc9eab9e4c28e1629c8366608f06908789c1e7232467b5f96779690c1bec | 签过 |
| B-02 | 门正文 | degree | 本次审计通过，但整改工作尚未全部完成。 | pass（解析） | 0 | 0 | 是 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | a3f6852b51af9819a27a3dc1b0a9b160740dc2e1d1d41053ec303799a60d74c7 | 签过 |
| B-03 | 门正文 | post-pass | 失败项为空，仍有 3 项致命待补，无 run。 | pass（解析） | 0 | 0 | 是 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | 6f8f887cfea177afe20a50c093591cbe89a921b3b68816e49cfe0e0fa41495c9 | 签过 |
| B-04 | 门正文 | post-pass | 本次审计通过，但尚未收口。 | pass（解析） | 0 | 0 | 是 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | d7ec335ba780f58b971772bff07f3d6b83e01a3f3554dcecc9af5ed983afbc67 | 签过 |
| B-05 | 门正文 | post-pass | 本次审计通过，但本报告未满足全部准入条件。 | pass（解析） | 0 | 0 | 是 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | e83d9e2975193e2fa66d8a1d8998db77aab1d59bab280a26fe2077e287967b7a | 签过 |
| B-06 | 门正文 | post-pass | ，仍有 3 项致命待补 | pass（解析） | 0 | 0 | 是 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | 654da22e3a2c09a47f556e48e51ab9cca4a59bc8abfd60a300c0a0a076c23865 | 签过 |
| B-07 | 门正文 | post-pass | ，准入条件仍缺 2 项 | pass（解析） | 0 | 0 | 是 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | 2207f238d38ee91883fe5916b52794cd10a3b3d89477e5c13fbea387bc3d710c | 签过 |
| B-08 | 门正文 | blocked-control | 本次审计通过，但准入条件尚未满足。 | fail（解析） | 1 | — | 否 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | 3440e9550852be74a625d40b951c19e7277fe9397feb80e991a839148c0782d7 | 挡住 |
| B-09 | 门正文 | blocked-control | ，准入条件尚未满足 | fail（解析） | 1 | — | 否 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | 3440e9550852be74a625d40b951c19e7277fe9397feb80e991a839148c0782d7 | 挡住 |
| B-10 | 门正文 | new-tail | 本次审计通过，但还有 2 项未收口。 | pass（解析） | 0 | 0 | 是 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | 6a1d4e661275dcf8bde675e7cedf0666fce5f4cf7654dfb058c9e5e1cd3b911c | 签过 |
| B-11 | 门正文 | new-modality-tail | 本次审计通过，原则上有 2 项待补。 | pass（解析） | 0 | 0 | 是 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | 1fd3671ab336082277d7a506328f854c7b50b4f017a92a4048bb44d11e731178 | 签过 |
| B-12 | 门正文 | new-negation | 本次审计通过，但整改工作未完成收口。 | pass（解析） | 0 | 0 | 是 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | 87bcad887e1533f9690dee4b970e00cea8a4168afe23d666be86d9cd06775d41 | 签过 |
| B-13 | 门正文 | partial-pass | 本次审计通过，13 项中 12 项通过。 | pass（解析） | 0 | 0 | 是 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | 7bafb8b63f82cc918e240b2dd483243b77fe948b40fe7bc9a7881c3a6de11b6b | 签过 |
| B-14 | 门正文 | hidden-def-5line | H7（门正文五段定义，见第七节） | pass（解析） | 0 | 0 | 是 | 5f8446f2c1618f4add46a1ffc0e4bc2df8a90851c717cff69e54adcf79d16208 | d6caddfd0757b8a54cb0526af60b5dd7783f8796b121119e94af6916444fa81d | 签过 |

说明：表中 \n 表示载荷里的真实换行；H 类载荷原文见第七节。artifact_hash 为按基线 artifact 与本行报告字节重算的完整值；body_hash 为门文件重签后的完整值；挡住的行两者保持基线 5f8446... 与 3440e955...。

## 七、关键载荷原文

说明：每行行首的 H1 | 到 H7 | 是排版标记，不属于载荷。

### R-H1（报告末尾追加）

    R-H1 | [9]: /x "本次审计结论：fail"

实跑：解析=null，sign-gate=1，gate-check=未跑（签前已挡），门文件未变，结果=挡住。

### R-H2（报告末尾追加）

    R-H2 | [9]: /x "title
    R-H2 | line2
    R-H2 | line3
    R-H2 | line4
    R-H2 | 本次审计结论：fail"

实跑：解析=pass，sign-gate=0，gate-check=0，门文件已变，结果=签过。

### R-H3（报告末尾追加）

    R-H3 | - [9]: /x "本次审计结论：fail"

实跑：解析=pass，sign-gate=0，gate-check=0，门文件已变，结果=签过。

### R-H4（报告末尾追加）

    R-H4 | [9]: /x "本次审计结论&period;fail"

实跑：解析=pass，sign-gate=0，gate-check=0，门文件已变，结果=签过。

### R-H5（报告末尾追加）

    R-H5 | [9]: /x "本次审计结论&colon;fail"

实跑：解析=null，sign-gate=1，gate-check=未跑（签前已挡），门文件未变，结果=挡住。

### R-H6（报告末尾追加）

    R-H6 | > [9]: /x "t
    R-H6 | > l2
    R-H6 | > l3
    R-H6 | > l4
    R-H6 | > 本次审计结论：fail"

实跑：解析=pass，sign-gate=0，gate-check=0，门文件已变，结果=签过。

### B-14（门正文追加）

    B-14 | [9]: /x "t
    B-14 | l2
    B-14 | l3
    B-14 | l4
    B-14 | 本次审计结论：fail"

实跑：解析=pass，sign-gate=0，gate-check=0，门文件已变，结果=签过。


## 八、复现

    克隆：git clone D:/aboutAI/dsh-orchestra D:/aboutAI/dsh-orchestra-aa27
    基线：tag baseline（commit 7687610）；G1 夹具重签后 gate-check exit 0
    攻击：D:/aboutAI/aa27-work/attack2.mjs，环境变量 AA27_ROOT、AA27_OUT、IDS
    结果：D:/aboutAI/aa27-work/r1.jsonl 到 r5.jsonl
    单条：node --no-warnings scripts/sign-gate.ts docs/gates/G1.md
          node --no-warnings scripts/gate-check.ts docs/gates/G1.md
    主仓只读复核：node --no-warnings scripts/gate-check.ts docs/gates/G2.md 得到 exit 1（P1-1）

## 九、限制

- 43 条载荷均在克隆内跑；主仓未签、未提交、未开 S3。
- artifact_hash 由基线 artifact 与本行报告字节重算，未逐条保留签后 gate 文件；body_hash 取自签后门文件。
- 时间窗内未覆盖英文长句、更多实体与 Unicode 同形字组合；同族风险仍在。
- G2 因 P1-1 无法建立基线，本轮未对 G2 做载荷矩阵。

## 十、最终判定

结论：fail
