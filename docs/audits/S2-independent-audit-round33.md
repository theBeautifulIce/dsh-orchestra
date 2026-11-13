# S2 独立审计 · 第 33 轮（G2）

- 门：G2
- 候选提交：4f87642def2e592fad5504dd9f288390d6c90a34
- 结论：fail
- 缺陷计数：P0 5 · P1 0 · P2 2

## 一、审计设置与基线

审计时间：2026-11-14 06:09 起（Asia/Shanghai）。审计对象为 `D:/aboutAI/dsh-orchestra` 的 HEAD `4f87642def2e592fad5504dd9f288390d6c90a34`（提交标题 Record S1 round27 and S2 round32 remediation，父提交 `ec89aec`）。主仓工作树在审计时已有他人改动（`M codebasemap.md`、`?? %SystemDrive%/`），本审计未触碰；主仓只新增本报告文件，未改源码、门记录、证据，未开 S3，未在主仓重签 G1/G2。

主仓 G1/G2 当前均为未签态：G1 `audit_round=1`、`audit_report=docs/audits/S1-independent-audit.md`、`audit_report_sha256=0000…0000`、`artifact_hash=1ce80f6080fb2271ae7ba958c61127962951cb49262b75e5b1d8e7d161b82084`、`body_hash=446357f9e00e384a35d7a4b77be48f0720cceebb61a4b5e1c4a9e8e27f17450c`；G2 `audit_round=4`、`audit_report=docs/audits/S2-independent-audit-round4.md`、`audit_report_sha256=0000…0000`、`artifact_hash=b5615b8b5725c5b2df88b9231b13885635940ef7db9f7fe802bc162c651c7a0a`、`body_hash=ef21bb456813786ab878abae2824a873f6e7d470e257d2bcadfb9eb73282dfd3`。

隔离方式：从主仓克隆出 `D:/aboutAI/dsh-orchestra-audit33`（`git clone -c core.autocrlf=false`），再以它克隆出三片 `-a33b` / `-a33c` / `-a33d`；各克隆的 `node_modules` 用 junction 指向主仓，未复制依赖。工具链：`D:/NodeJs/node.exe` `v26.13.1`（原生 TypeScript stripping），PowerShell 7；按要求未使用 pnpm。

夹具：在克隆内写两份最小 pass 报告（G1 `docs/audits/S1-independent-audit-round28.md`、G2 `docs/audits/S2-independent-audit-round33.md`），每份含唯一“门：G1/G2”“候选提交：4f87642def2e592fad5504dd9f288390d6c90a34”“结论：pass（13/19 项必过全过，失败项为空，无 run）”；GateArtifact 的 `audit_round` 分别改为 28 与 33，`audit_report` 指向上述报告。夹具提交 `54717db`，G1 重签提交 `314d78ce751985523f770766c10421a1b0f5b4b6`，G2 重签提交 `41ac7a1ca46f272a5f4c3f036ea063cc44c4bc5c`（即本轮攻击基线）。

基线复核（2026-11-14 本轮重新执行，克隆 `dsh-orchestra-audit33-base`，checkout `41ac7a1`，工作树干净）：

```
HEAD=41ac7a1ca46f272a5f4c3f036ea063cc44c4bc5c
STATUS=
重签完成：证据 19 份，candidate=6acb905057db…，artifact_hash=2f7417f8723a…，body_hash=86b5b9dc69c2…，改动文件 88 个
SIGN_EXIT=0
gate G2 通过（19 项必过、19 份证据哈希复核，artifact_hash=2f7417f8723a… body_hash=86b5b9dc69c2…）
CHECK_EXIT=0
STATUS2=
```

基线完整哈希：

| 字段 | G1 | G2 |
| --- | --- | --- |
| audit_round | 28 | 33 |
| audit_report | docs/audits/S1-independent-audit-round28.md | docs/audits/S2-independent-audit-round33.md |
| audit_report_sha256 | 0d7a784913948a4deb3ed86c161c42986af3d07f54f1f572110991469b280fd2 | 11a343f9a6d9974043dff36d50c0a6ce0052ef75ae382bb8c9b921ea36c649a3 |
| artifact_hash | ebe36520316e3952df551571e7826a709ef49a3a06edd9575d56dc8ba689159b | 2f7417f8723a56363358f1b60ae052cee2e843c22f1fe8f396cae36ba5c4b4d8 |
| body_hash | a3e07fdb9aff76af7f43ec3dfa068979af8d213a948dc88b672c25cf23d4f7d1 | 86b5b9dc69c2f781befa507083e4529c3d18dde55888d2738995d0cdb7dad2cf |
| candidate_hash | 53eeecd77c1e94df788cc991f560659eda795f589b9ee0e58d552d9bf04d6da1 | 6acb905057db9d293beff3116a2846525261da08b7c85be16e113cd3907b03b0 |
| change_scope_hash | 83793fffc1fb10e1c1818eaf192171210853a5d7219965c8157727a0891744d4 | b4811c33ac596c2580c7268812fa1e79fbe12ad2f9257bacdd8fb88fd5648778 |
| evidence_index_hash | a966f70209c0a6ad50c62a1c749108c13fd0a1b5da99c331ca726e496f18f00f | 1a221b945449b1e68b7811ba110ac022f25c9004438204dcdeae0f02a3068898 |
| invariants_hash | 6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6 | 925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304 |
| previous_artifact_hash | 0000000000000000000000000000000000000000000000000000000000000000 | ebe36520316e3952df551571e7826a709ef49a3a06edd9575d56dc8ba689159b |
| 门文件 sha256（LF 归一） | 6b11c596d191f51e5d8f7c350acc19552e38145f1542981a76a12b75b3fb1ed3 | 0cc4514d8fc48ed168e2da4fbcfeafa74ee3464034c0a8f27c361fd5d776b060 |

上一轮报告里的 20 条载荷在本基线全部复跑：每条都从 `41ac7a1` 重置、注入、提交、运行 `sign-gate.ts`、记录门文件哈希是否变化、再提交门、运行 `gate-check.ts`。结果见第二节：19 条 `sign=1`、门文件未变；R10 正控 `sign=0`、门变、`check=0`。

攻击方法：每条新变体先重置到基线，改 G2 的 `audit_round=33` / `audit_report=docs/audits/S2-independent-audit-round33.md`，把载荷注入报告或门正文，提交攻击提交，运行 `sign-gate.ts docs/gates/G2.md`，记录 sign 退出码、artifact/body 哈希、门文件是否变化；若 `sign=0`，提交门文件后运行 `gate-check.ts docs/gates/G2.md` 并记录退出码。解析值另用 `auditConclusionOf` / `bodyConclusionOf` 对同一文件上下文实算。

## 二、上一轮 20 条载荷复跑

| 编号 | 侧 | 载荷 | sign | check | 门变 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | report | 整改工作尚未全部完成。 | 1 | — | 否 | 挡住 |
| R2 | report | 本次审计未通过验收检查。 | 1 | — | 否 | 挡住 |
| R3 | report | 本轮审计存在未完成项。 | 1 | — | 否 | 挡住 |
| R4 | report | [本次审计结论：fail<br>]: /url | 1 | — | 否 | 挡住 |
| R5 | report | [1]: /url<br>"a<br>b<br>c<br>d<br>本次审计结论：fail" | 1 | — | 否 | 挡住 |
| R6 | report | > [本次审计结论：fail<br>> ]: /url | 1 | — | 否 | 挡住 |
| R7 | report | [本次审计结论：&#102;ail<br>]: /url | 1 | — | 否 | 挡住 |
| R8 | report | [1]: /url "本次审计结论：fail" | 1 | — | 否 | 挡住 |
| R9 | report | 整改工作未完全完成。 | 1 | — | 否 | 挡住 |
| R10 | report | 本轮 19 项均通过，无失败项。 | 0 | 0 | 是 | 正控：签过 |
| R11 | report | 本次审计结论：通过，但准入条件尚未满足。 | 1 | — | 否 | 挡住 |
| R12 | report | 本次审计未通过最终验收。 | 1 | — | 否 | 挡住 |
| R13 | report | 本次审计未获得全部通过。 | 1 | — | 否 | 挡住 |
| R14 | report | 本次审计没有取得全部认可。 | 1 | — | 否 | 挡住 |
| R15 | report | pass，整改尚未全部完成 | 1 | — | 否 | 挡住 |
| B1 | gate | - 结论：**pass**（整改尚未全部完成） | 1 | — | 否 | 挡住 |
| B2 | gate | - 结论：**pass**，整改尚未全部完成 | 1 | — | 否 | 挡住 |
| B3 | gate | [本次审计结论：fail<br>]: /url | 1 | — | 否 | 挡住 |
| B4 | gate | 本次审计结论：fail | 1 | — | 否 | 挡住 |
| B5 | gate | - 结论：**pass**（准入条件尚未满足） | 1 | — | 否 | 挡住 |

## 三、本轮 52 条新变体

本轮共构造 52 条：42 条可见/隐藏 fail 载荷（编号 r33-01…r33-42、x01…x10 中除对照外）与 10 条对照。结果为 42 条绕过、9 条被挡、1 条合法正控签过（详见逐条表）。

| 编号 | 侧 | 载荷 | sign | check | 门变 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| r33-01 | report | 本次审计未能顺利通过。 | 0 | 0 | 是 | 绕过（P0-1） |
| r33-02 | report | 本次审计未正式收口。 | 0 | 0 | 是 | 绕过（P0-1） |
| r33-03 | report | 本次审计未获全面通过。 | 0 | 0 | 是 | 绕过（P0-1） |
| r33-04 | report | 本次审计未获整体通过。 | 0 | 0 | 是 | 绕过（P0-1） |
| r33-05 | report | 本次审计未通过本次验收。 | 0 | 0 | 是 | 绕过（P0-1） |
| r33-06 | report | 本次审计未通过当次复核检查。 | 0 | 0 | 是 | 绕过（P0-1） |
| r33-07 | report | 本次审计 19 项中 18 项均通过。 | 0 | 0 | 是 | 绕过（P0-2） |
| r33-08 | report | 本次审计 19 项中 18 项全部通过。 | 0 | 0 | 是 | 绕过（P0-2） |
| r33-09 | report | 本次审计通过 18/19 项。 | 0 | 0 | 是 | 绕过（P0-2） |
| r33-10 | report | 本次审计通过 18 项，1 项未过。 | 0 | 0 | 是 | 绕过（P0-2） |
| r33-11 | report | 原则上有 3 项待办。 | 0 | 0 | 是 | 绕过（P0-3） |
| r33-12 | report | 尚有 3 项 P2 待办。 | 0 | 0 | 是 | 绕过（P0-3） |
| r33-13 | report | 本次审计完成一半。 | 0 | 0 | 是 | 绕过（P0-2） |
| r33-14 | report | 本次审计只完成了百分之八十。 | 0 | 0 | 是 | 绕过（P0-2） |
| r33-15 | report | 本次审计未一次性通过。 | 0 | 0 | 是 | 绕过（P0-1） |
| r33-16 | report | 本次审计未通过1项。 | 0 | 0 | 是 | 绕过（P0-2） |
| r33-17 | report | 本次审计未能一次性通过验收检查。 | 0 | 0 | 是 | 绕过（P0-1） |
| r33-18 | report | 本次审计没有获得全面认可。 | 0 | 0 | 是 | 绕过（P0-1） |
| r33-19 | report | 本次审计只完成 18/19 项必过。 | 0 | 0 | 是 | 绕过（P0-2） |
| r33-20 | report | 本次审计 18 项通过、1 项未过。 | 0 | 0 | 是 | 绕过（P0-2） |
| r33-21 | report | 本次审计完成度不足。 | 1 | — | 否 | 挡住（对照） |
| r33-22 | report | 本次审计未通过验收检查。 | 1 | — | 否 | 挡住（对照） |
| r33-23 | report | 未通过。 | 1 | — | 否 | 挡住（对照） |
| r33-24 | gate | 第33轮独立审计判 G2 不通过。 | 0 | 0 | 是 | 绕过（P0-4） |
| r33-25 | gate | ## 第33轮独立审计结论：G2 不通过。 | 0 | 0 | 是 | 绕过（P0-4） |
| r33-26 | gate | > 第33轮独立审计判 G2 不通过。 | 0 | 0 | 是 | 绕过（P0-4） |
| r33-27 | gate | 第33轮独立审计判 G2 未顺利通过。 | 0 | 0 | 是 | 绕过（P0-4） |
| r33-28 | gate | 第33轮独立审计判 G2 未通过本次验收。 | 0 | 0 | 是 | 绕过（P0-4） |
| r33-29 | gate | 第33轮审计：本次审计未顺利通过。 | 0 | 0 | 是 | 绕过（P0-4） |
| r33-30 | gate | 第33轮独立审计判 G2 部分通过。 | 0 | 0 | 是 | 绕过（P0-4） |
| r33-31 | gate | 第33轮独立审计判 G2 未过。 | 0 | 0 | 是 | 绕过（P0-4） |
| r33-32 | gate | 第33轮独立审计判 G2 暂缓。 | 0 | 0 | 是 | 绕过（P0-4） |
| r33-33 | gate | # G2 门记录：单 agent 节点闭环（S2）（19 项中 18 项均通过） | 0 | 0 | 是 | 绕过（P0-2） |
| r33-34 | gate | 结论：**pass**（19 项必过全过，失败项为空，无 run，P2 遗留 2 条） | 0 | 0 | 是 | 正控：签过（合法 P2 遗留） |
| r33-35 | gate | 结论：**pass**（19 项必过全过，失败项为空，无 run，18/19 项通过） | 1 | — | 否 | 挡住（对照） |
| r33-36 | gate | 结论：**pass**（19 项必过全过，失败项为空，无 run，未顺利通过） | 1 | — | 否 | 挡住（对照） |
| r33-37 | report | > > > > > > [1]: /url "本次审计结论：fail"<br> | 0 | 0 | 是 | 绕过（P0-5） |
| r33-38 | report | - - - - - - [1]: /url "本次审计结论：fail"<br> | 0 | 0 | 是 | 绕过（P0-5） |
| r33-39 | report | > > > > > > [1]: /url<br>> > > > > > "本次审计结论：fail"<br> | 0 | 0 | 是 | 绕过（P0-5） |
| r33-40 | report | [1]: /url "l1<br>l2<br>l3<br>l4<br>l5<br>l6<br>本次审计结论：fail"<br> | 1 | — | 否 | 挡住（对照） |
| r33-41 | report | > > > > > [1]: /url "本次审计结论：fail"<br> | 1 | — | 否 | 挡住（对照） |
| r33-42 | report | 本次审计通过率 94.7%。 | 0 | 0 | 是 | 绕过（P0-2） |
| x01 | report | 本次审计未&#39034;利通过验收。 | 0 | 0 | 是 | 绕过（P0-1） |
| x02 | report | 本次审计&#26410;顺利通过验收。 | 0 | 0 | 是 | 绕过（P0-1） |
| x03 | report | 本次审计19项中18项均通过。 | 0 | 0 | 是 | 绕过（P0-2） |
| x04 | report | 本次审计 19 项必过中 18 项通过。 | 0 | 0 | 是 | 绕过（P0-2） |
| x05 | gate | ## 第33轮审计结论（19 项中 18 项均通过） | 0 | 0 | 是 | 绕过（P0-2） |
| x06 | gate | - 结论：**pass**（18 项通过，1 项未过） | 1 | — | 否 | 挡住（对照） |
| x07 | gate | > > > > > > [1]: /x 本次审计结论：fail | 1 | — | 否 | 挡住（对照） |
| x08 | gate | ## 第33轮审计（原则上 3 项待办） | 0 | 0 | 是 | 绕过（P0-3） |
| x09 | gate | 本轮审计未顺利通过。 | 0 | 0 | 是 | 绕过（P0-4） |
| x10 | report | 本次审计通过率 94.7%。 | 0 | 0 | 是 | 绕过（P0-2） |

## 四、关键发现

前置校正（本轮实算，避免沿用错误假设）：

- 门标题会被 `bodyConclusionOf` 扫描：标题写“19 项中 18 项通过”“未通过”会 fail；只有“均通过/待办/通过率/未顺利”因词表缺口 pass。故不存在“标题完全不参与校验”的独立 P0。
- HTML 命名实体在 `renderedAuditLines` 里已由 markdown-it 解码：纯实体否定“未&#36890;过验收”“&#26410;通过验收”均返回 null；x01/x02 能签过只因“顺利”不在词表。故不存在“实体编码绕过”的独立 P0。
- 下列行号以候选提交 `4f87642` 的 `scripts/gate-check.ts` 为准（已导出 `D:/aboutAI/audit33-tools/gate-check-audited.ts`）。主仓同文件现已被他人改动，行号不可直接复用。

### P0-1 报告侧否定谓词族仍可签过（11 条）

涉及 r33-01…06、15、17、18、x01、x02。代表性结果：`本次审计未能顺利通过。`（artifact `99801f50d58bca71060800753b26e9b8078aa200b482deac5a97398e0f0cb28d`、body `4c955d31911b84f24ce5d3302e467ad15c14ebae50e3b64efa001e6da24ddb9d`）、`本次审计未获全面通过。`、`本次审计未通过本次验收。` 均为 `auditConclusionOf=pass`、`sign=0`、`gate-check=0`、门文件变化。

机制：`FAIL_FILLERS`（audited 813-825）没有收录 顺利、正式、全面、整体、一次性 等副词/量词；`FAIL_OBJECTS`（audited 850-861）没有收录 本次验收、当次复核检查、G2 这类限定宾语。`scanFailStatement`（audited 957-1029）要求否定词后按固定表吃到谓词与宾语，任何未收录的修饰语或限定宾语都会让整句落空，随后被当作普通结论尾巴放行。x01/x02 的实体前缀在 markdown 渲染时已还原为“未顺利通过”，仍因同一个“顺利”缺口签过。

影响：报告正文明文写“未通过”，仍可被当成 pass 签进 G2；签后 `gate-check` 复核 exit 0。

### P0-2 报告侧计数、比例、完成度与部分通过仍可签过（15 条）

涉及 r33-07…10、13、14、16、19、20、33、42、x03、x04、x05、x10。代表性结果：`本次审计 19 项中 18 项均通过。`（artifact `4934c7d7514ca30ad0140353e6b41b679a3ca3cb3afbab731b61edcc9ce434ed`、body `dc3c3bf7a48cd2099512729f040076526bbd220112809dc88e4b83c39c85d598`）、`本次审计通过率 94.7%。`、`本次审计完成一半。`、`本次审计只完成了百分之八十。`、门标题 `# G2 门记录…（19 项中 18 项均通过）` 均签过且 check 0。

机制：`countingFailure`（audited 882-905）只匹配紧邻的“N 项中 M 项通过”及其少数变体，未覆盖 均/全部/为/已/里、`18/19`、`通过率`、`完成一半`、`百分之八十`、`未通过 1 项`。标题行确实进入了全文扫描，但同样被这个词表缺口放过。

影响：19 项里 18 项通过这种直接违反“必过全过”的事实，可以随 pass 一起签过；门标题写 18/19 也一样。

### P0-3 无主语待办/待改进仍可签过（3 条）

涉及 r33-11、12、x08：`原则上有 3 项待办。`（artifact `ced61831d143e8f5ec880da032be72e2cc966ee429c7965fb01d864d42834e07`、body `9064582ac2a902c91a759c34f5379c2585b10aad93d3a0924e97a3d162c7d41e`）、`尚有 3 项 P2 待办。`、门标题 `## 第33轮审计（原则上 3 项待办）`。三条都解析为 pass、签过、check 0。

机制：`BARE_TAIL_VERDICTS`（audited 874-878）只收了“待补”等少数裸尾词，没有 待办、待改进；无主语计数分支（audited 897）也只认“待补/待整改/待修复/未完成/未收口”等固定形态。标题行虽被扫描，仍同样漏判。

影响：报告可以一边写 pass，一边列出尚未完成的待办，仍签得过去。

### P0-4 门正文“当前轮历史”伪装与弱判词可签过（10 条）

涉及 r33-24…32、x09。代表性结果：`第33轮独立审计判 G2 不通过。`（artifact `2f7417f8723a56363358f1b60ae052cee2e843c22f1fe8f396cae36ba5c4b4d8`、body `aa1a3ed903f98235eb3fb49e4a5ae0e9b780eddc717a08bd9018564fc2a7cc6e`）、`## 第33轮独立审计结论：G2 不通过。`、`> 第33轮独立审计判 G2 不通过。`、`第33轮独立审计判 G2 未通过本次验收。`、`第33轮审计：本次审计未顺利通过。`、`第33轮独立审计判 G2 部分通过。`、`第33轮独立审计判 G2 暂缓。` 均为 `bodyConclusionOf=pass`、`sign=0`、`gate-check=0`。

机制分两层：`HISTORICAL_AUDIT_SENTENCE_RE` / `stripHistoricalAuditSentence`（audited 1055-1058）把行首/列表项/引用开头的“第 N 轮…不通过/未通过/fail…。”整句当历史剥掉，既没有轮次上限，也不区分“当前轮”；r33-24/25/26/28 属于这一层。r33-27/29/30/31/32 与 x09 则因 未顺利/部分通过/未过/暂缓 不在 `FAIL_FILLERS`/`FAIL_VERDICTS` 的可命中位置而漏判（`本轮审计未顺利通过。` 连历史前缀都没有，仍 pass）。

影响：门正文明文写“G2 不通过”，门仍以 pass 签过并复检通过；这是比报告侧更直接的记录失真。

### P0-5 六层嵌套引用定义隐藏 fail 仍可签过（3 条）

涉及 r33-37（六层 `>` 引用定义）、r33-38（六层 `-` 列表容器）、r33-39（六层引用 + 续行）。三条都 `auditConclusionOf=pass`、`sign=0`、`gate-check=0`、门变；代表 r33-37 的 artifact `eae38bc2cafc048bc517a54f2333ac9914fa9e6853fa3ccb9edfeb2589aab670`、body `458b6ac4247d566c6b85a3d2a853666927e773ab307ae724467dca357a09cc25`。

机制：`hiddenDefinitionFailure`（audited 1107-1126）先由 `stripDefinitionContainers`（audited 1095-1103）逐层剥容器，但循环固定 5 次；第 6 层容器仍留在文本里，markdown-it 仍把它解析成引用定义，定义内容不进入渲染文本。定义里写 `本次审计结论：fail`，解析器因看不到该行而返回 pass。五层对照 r33-41 被正确挡住（parse=null），七行跨行定义 r33-40 也被挡住（parse=null），边界正好落在第 6 层。

影响：原始字节含 fail、渲染后不可见，且 `sign=0` / `gate-check=0` 全过；这与上一轮 P0-2 同族，只是层数加深一层。门侧同样形态 x07 被挡住（body=fail），说明缺口在报告侧定义扫描。

## 五、上一轮 P1/P2 闭合核对

- **P1-1 门正文与报告共用尾巴校验：已闭合。** `bodyConclusionOf`（scripts/gate-check.ts:1191）与 `auditConclusionOf`（scripts/gate-check.ts:1170）都调用 `validConclusionTail`；实测 h06（报告尾“整改尚未全部完成”）`audit=null`、h07（门尾同文）`body=fail`，两边都拒。
- **G2 历史叙述误判：部分闭合。** 现有“第二轮/第五轮/第三轮”历史段落在基线门里可正确剥掉，基线 `bodyConclusionOf=pass`；但“第 33 轮”带空格形式仍误判（P2-2），当前轮无空格形式被当历史剥掉（P0-4）。
- **required_hashes 生产路径：已闭合。** `D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/apply-report.spec.ts -t required_hashes` → 6 passed / exit 0；生产路径 `evaluateEvidence` 对伪造、弱证据、共用产物仍返回 `ok:false`，`applyReport` 在 `src/service/commands/apply-report.ts:257-260` 拒收（策略在 `src/core/policy.ts:46-76`）。
- **回归覆盖：未闭合。** 见 P2-1，62 例仍是枚举式，未覆盖本轮新增的漏判形态。

## 六、限制

1. 本报告只审 G2；G1 侧由另一名审计代理负责，本文不引用 G1 的载荷结论。
2. 夹具报告是最小 pass 报告，真实审计报告更长；但结论解析走的是同一 `auditConclusionOf` / `bodyConclusionOf` 代码路径，注入位置与真实报告一致。
3. 攻击载荷是合成文本，不含生产数据；所有签名实验只在隔离克隆内进行，主仓 G1/G2 未重签。
4. 主机同时运行多路 G1 审计，sign 单条约 1–4 分钟，时间不作为性能结论；判定只取退出码、哈希与门文件变化。
5. 未覆盖：`required_hashes` 之外的证据哈希路径、G1 门、S3 状态机、门正文其它非结论段落的全量扫描。
6. 主仓工作树在审计开始时已有 `M codebasemap.md` 与 `?? %SystemDrive%/`；写报告时又见 `M scripts/gate-check.ts`、`M tests/gate-check.spec.ts`、`?? docs/audits/S1-independent-audit-round28.md`，均为他人改动，本审计未触碰。本报告是本次唯一新增文件。

## 七、最终判定

本轮 52 条新变体中确认 42 条 fail 载荷完成“解析 pass → sign 0 → gate-check 0 → 门文件变化”的完整绕过；另有 9 条对照被正确挡住、1 条合法正控签过。上一轮 20 条载荷中 19 条已被挡住，R10 正控正常；上一轮 P1-1 与 required_hashes 已闭合，但历史叙述与回归覆盖仍未完全闭合，且新出现当前轮伪装、计数/待办词表缺口、六层定义三类新绕过。按任务判据，只要可见 fail 文本仍能签过即判 fail 并给 P0；本轮共有 5 类 P0，故最终判定为 fail。

结论：fail
