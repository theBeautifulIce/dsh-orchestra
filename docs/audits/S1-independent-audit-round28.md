# S1 独立审计（第二十八轮）：G1 结论解析与门签名

## 门

G1。

## 候选提交

4f87642def2e592fad5504dd9f288390d6c90a34

## 结论

本轮判定：**fail**。

P0 = 4，P1 = 2，P2 = 2。

112 条矩阵载荷中，54 条解析为 pass，sign-gate 退出 0，gate-check 退出 0，且门文件被改写，构成可复现绕过；3 条正控通过；55 条阻断（上一轮 40 条非正控旧载荷全部阻断，新变体 15 条阻断）。另有 1 条历史审计正控 P-HIST 被误伤：sign-gate 退出 1，门未变，见 P1-2。

## 审计设置与基线

- 主仓：D:/aboutAI/dsh-orchestra，HEAD = 4f87642def2e592fad5504dd9f288390d6c90a34（父提交 ec89aec）。4f87642 只多 handoff.md，解析器与测试代码与 ec89aec 逐字节一致。
- 隔离克隆：D:/aboutAI/dsh-orchestra-aa28，core.autocrlf=false，core.eol=lf；node_modules 以 junction 指向主仓，未复制。
- 基线夹具：把 G1 的 audit_round 改为 28，audit_report 指向 docs/audits/S1-fixture-round28.md，报告含门行、候选提交行与 pass 结论。夹具报告提交 122a845，签名提交 bdd002c。
- 基线签名与门检查：sign-gate 退出 0，gate-check 退出 0。
- 正控复核：标准结论尾巴与“无失败项”正控均解析为 pass 并签过；历史审计叙述正控失败，详见 P1-2。

基线哈希（完整值）：

~~~~
artifact_hash=9d279f47b0abd88cd650f8c72b6b9713b1fa8cd5ef31808a7b626db353885c31
body_hash=96aaae291c545ae10a688f6252c4250a8aaf27c045b2c3ed2afdbde6a208c2f5
candidate_hash=53eeecd77c1e94df788cc991f560659eda795f589b9ee0e58d552d9bf04d6da1
change_scope_hash=83793fffc1fb10e1c1818eaf192171210853a5d7219965c8157727a0891744d4
evidence_index_hash=a966f70209c0a6ad50c62a1c749108c13fd0a1b5da99c331ca726e496f18f00f
invariants_hash=6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6
audit_report_sha256=8257dfe56ee77cb650e21ade689b0a206404ec30d9afc4585f049cdc0a9875c3
gate_file_sha256=872004cdfb77061b35ef12112e89abeb5e257edc7f152cbbd8aea113aaa3d4cc
audit_round=28
conclusion=pass
previous_artifact_hash=0000000000000000000000000000000000000000000000000000000000000000
~~~~

## 方法

112 条 = 上一轮 43 条（R-POS1、R-POS2、R-01..R-20、R-H1..R-H6、B-POS1、B-01..B-14）+ 本轮新增 69 条（N-01..N-69）。每条用例在克隆内从 bdd002c 重置；改报告或门文件并提交，记录签名前门文件 sha256；执行 sign-gate；若退出 0 则 amend 提交并执行 gate-check；记录解析结论、sign 退出码、check 退出码、门文件是否被改写，然后重置。报告侧追加到夹具报告，门侧追加到门正文或注入门头结论括号。

判定口径：解析 pass + sign 0 + check 0 + 门文件变化 = 绕过；解析 null/fail 或 sign 非 0 = 阻断；正控必须通过。

## 逐条载荷表

| 编号 | 侧 | 载荷 | sign | check | 门变 | 判定 |
|---|---|---|---|---|---|---|
| R-POS1 | report | <code>本次审计通过，13 项必过全过，失败项为空，无 run。</code> | 0 | 0 | 是 | 正控通过 |
| R-POS2 | report | <code>未通过项为零，未发现否决项，13 项必过全过。</code> | 0 | 0 | 是 | 正控通过 |
| R-01 | report | <code>本次审计通过，但整改工作尚未全部完成。</code> | 1 | — | 否 | 阻断 |
| R-02 | report | <code>本次审计通过，但整改工作还没有做完。</code> | 1 | — | 否 | 阻断 |
| R-03 | report | <code>本次审计通过，但本报告未满足全部准入条件。</code> | 1 | — | 否 | 阻断 |
| R-04 | report | <code>本次审计通过，但尚未整改。</code> | 1 | — | 否 | 阻断 |
| R-05 | report | <code>本次审计通过，但尚未收口。</code> | 1 | — | 否 | 阻断 |
| R-06 | report | <code>本次审计通过，但仍有 3 项致命待补。</code> | 1 | — | 否 | 阻断 |
| R-07 | report | <code>本次审计通过，但整改只完成了一半。</code> | 1 | — | 否 | 阻断 |
| R-08 | report | <code>本次审计通过，但准入条件仍缺 2 项。</code> | 1 | — | 否 | 阻断 |
| R-09 | report | <code>本次审计通过，但整改工作尚未开始。</code> | 1 | — | 否 | 阻断 |
| R-10 | report | <code>本次审计通过，但整改不到位。</code> | 1 | — | 否 | 阻断 |
| R-11 | report | <code>本次审计通过，但本报告并非全部通过。</code> | 1 | — | 否 | 阻断 |
| R-12 | report | <code>本次审计通过，但报告未达到放行标准。</code> | 1 | — | 否 | 阻断 |
| R-13 | report | <code>本次审计通过，但整改工作还没有全部完成。</code> | 1 | — | 否 | 阻断 |
| R-14 | report | <code>本次审计通过，但整改工作只完成了 80%。</code> | 1 | — | 否 | 阻断 |
| R-15 | report | <code>本次审计通过，但整改尚未达到放行条件。</code> | 1 | — | 否 | 阻断 |
| R-16 | report | <code>本次审计通过，原则上有 3 项待补。</code> | 1 | — | 否 | 阻断 |
| R-17 | report | <code>本次审计通过，但还有 2 项未收口。</code> | 1 | — | 否 | 阻断 |
| R-18 | report | <code>本次审计通过，但整改工作未完成收口。</code> | 1 | — | 否 | 阻断 |
| R-19 | report | <code>本次审计通过，13 项中 12 项通过。</code> | 1 | — | 否 | 阻断 |
| R-20 | report | <code>本次审计通过，但尚差 2 项。</code> | 1 | — | 否 | 阻断 |
| R-H1 | report | <code>[9]: /x "本次审计结论：fail"</code> | 1 | — | 否 | 阻断 |
| R-H2 | report | <code>[9]: /x "title<br>line2<br>line3<br>line4<br>本次审计结论：fail"</code> | 1 | — | 否 | 阻断 |
| R-H3 | report | <code>- [9]: /x "本次审计结论：fail"</code> | 1 | — | 否 | 阻断 |
| R-H4 | report | <code>[9]: /x "本次审计结论&period;fail"</code> | 1 | — | 否 | 阻断 |
| R-H5 | report | <code>[9]: /x "本次审计结论&colon;fail"</code> | 1 | — | 否 | 阻断 |
| R-H6 | report | <code>> [9]: /x "t<br>> l2<br>> l3<br>> l4<br>> 本次审计结论：fail"</code> | 1 | — | 否 | 阻断 |
| B-POS1 | gate | <code>本次审计通过，13 项必过全过，失败项为空，无 run。</code> | 0 | 0 | 是 | 正控通过 |
| B-01 | gate | <code>本次审计通过，但尚未整改。</code> | 1 | — | 否 | 阻断 |
| B-02 | gate | <code>本次审计通过，但整改工作尚未全部完成。</code> | 1 | — | 否 | 阻断 |
| B-03 | gate | <code>失败项为空，仍有 3 项致命待补，无 run。</code> | 1 | — | 否 | 阻断 |
| B-04 | gate | <code>本次审计通过，但尚未收口。</code> | 1 | — | 否 | 阻断 |
| B-05 | gate | <code>本次审计通过，但本报告未满足全部准入条件。</code> | 1 | — | 否 | 阻断 |
| B-08 | gate | <code>本次审计通过，但准入条件尚未满足。</code> | 1 | — | 否 | 阻断 |
| B-10 | gate | <code>本次审计通过，但还有 2 项未收口。</code> | 1 | — | 否 | 阻断 |
| B-11 | gate | <code>本次审计通过，原则上有 2 项待补。</code> | 1 | — | 否 | 阻断 |
| B-12 | gate | <code>本次审计通过，但整改工作未完成收口。</code> | 1 | — | 否 | 阻断 |
| B-13 | gate | <code>本次审计通过，13 项中 12 项通过。</code> | 1 | — | 否 | 阻断 |
| B-14 | gate | <code>[9]: /x "t<br>l2<br>l3<br>l4<br>本次审计结论：fail"</code> | 1 | — | 否 | 阻断 |
| B-06 | gate | <code>，仍有 3 项致命待补</code> | 1 | — | 否 | 阻断 |
| B-07 | gate | <code>，准入条件仍缺 2 项</code> | 1 | — | 否 | 阻断 |
| B-09 | gate | <code>，准入条件尚未满足</code> | 1 | — | 否 | 阻断 |
| N-01 | report | <code>本次审计通过，但问题未解决。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-02 | report | <code>本次审计通过，但缺陷未关闭。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-03 | report | <code>本次审计通过，但 P0 未清零。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-04 | report | <code>本次审计通过，但未达要求。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-05 | report | <code>本次审计通过，但未达标准。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-06 | report | <code>本次审计通过，但尚待确认。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-07 | report | <code>本次审计通过，但仍有 2 项待复核。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-08 | report | <code>本次审计通过，但并非所有必过项都通过。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-09 | report | <code>本次审计通过，但 13 项中有 12 项通过。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-10 | report | <code>本次审计通过，但 13 项中只有 12 项通过。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-11 | report | <code>本次审计通过，但 13 项里 12 项通过。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-12 | report | <code>本次审计通过，但完成度只有 80%。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-13 | report | <code>本次审计通过，但证据不充分。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-14 | report | <code>本次审计通过，但依据不足。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-15 | report | <code>本次审计通过，但不齐全。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-16 | report | <code>本次审计通过，但未按规范执行。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-17 | report | <code>本次审计通过，但整改尚未开展。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-18 | report | <code>本次审计通过，但问题未处理。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-19 | report | <code>本次审计通过，但风险未消除。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-20 | report | <code>本次审计通过，但不予验收。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-21 | report | <code>本次审计通过，但不能视为通过。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-22 | report | <code>本次审计通过，但原则上有 3 项待完善。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-23 | report | <code>本次审计通过，但基本上有 2 项待复核。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-24 | report | <code>本次审计通过，但仍有 3 项致命待复测。</code> | 1 | — | 否 | 阻断 |
| N-25 | report | <code>本次审计通过，但缺少 2 项证据。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-26 | report | <code>本次审计通过，但 13 项中有 12 项 pass。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-27 | report | <code>本次审计通过，但未验收。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-28 | report | <code>本次审计通过，但未复核完毕。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-29 | report | <code>本次审计通过，但未修复完毕。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-30 | report | <code>本次审计通过，但遗留 2 项。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-31 | report | <code>本次审计通过，但尚余 2 项。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-32 | report | <code>本次审计通过，但问题清单未销项。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-33 | report | <code>本次审计通过，但整改未结束。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-34 | report | <code>本次审计通过，但审计范围未覆盖全部节点。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-35 | report | <code>本次审计通过，但复核结论保留。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-36 | report | <code>本次审计通过，但仍有未完成项。</code> | 1 | — | 否 | 阻断 |
| N-40 | report | <code>本次审计通过，但未整改完成。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-41 | report | <code>本次审计通过，但结论待观察。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-42 | report | <code>本次审计通过，但复核未结束。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-43 | report | <code>本次审计通过，但审批未完成。</code> | 1 | — | 否 | 阻断 |
| N-44 | report | <code>本次审计通过，但有 2 项未核实。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-45 | report | <code>本次审计通过，但部分必过项未验证。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-37 | report | <code>> > > > > > [9]: /x "t<br>> > > > > > l2<br>> > > > > > l3<br>> > > > > > l4<br>> > > > > > 本次审计结论：fail"</code> | 0 | 0 | 是 | 绕过（P0） |
| N-38 | report | <code>- - - - - - [9]: /x "t<br>      l2<br>      l3<br>      l4<br>      本次审计结论：fail"</code> | 0 | 0 | 是 | 绕过（P0） |
| N-39 | report | <code>> - > - > - [9]: /x "t<br>> - > - > - l2<br>> - > - > - l3<br>> - > - > - l4<br>> - > - > - 本次审计结论：fail"</code> | 1 | — | 否 | 阻断 |
| N-46 | gate | <code>本次审计通过，但问题未解决。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-47 | gate | <code>第28轮独立审计判 G1 不通过。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-48 | gate | <code>第二轮独立审计判 G1 不通过，本轮仍有 2 项未解决。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-49 | gate | <code>round 28 audit failed.</code> | 0 | 0 | 是 | 绕过（P0） |
| N-50 | gate | <code>第二轮独立审计判 G1 不通过。 本轮仍有 2 项未解决。</code> | 1 | — | 否 | 阻断 |
| N-53 | gate | <code>复核发现 2 项未覆盖。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-54 | gate | <code>13 项中有 12 项通过。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-55 | gate | <code>原则上 3 项待完善。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-56 | gate | <code>尚有 2 项待完善。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-57 | gate | <code>本次审计通过，但 13 项里 12 项通过。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-58 | gate | <code>本次审计通过，但 P1 未清零。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-51 | gate | <code>，问题未解决</code> | 1 | — | 否 | 阻断 |
| N-52 | gate | <code>，并非所有项都通过</code> | 1 | — | 否 | 阻断 |
| N-59 | report | <code>本次审计通过，但有一项必过项未核验。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-60 | report | <code>本次审计通过，但整改只完成了一半。</code> | 1 | — | 否 | 阻断 |
| N-61 | report | <code>本次审计通过，但未完成收口。</code> | 1 | — | 否 | 阻断 |
| N-62 | report | <code>本次审计通过，但不能认定通过。</code> | 0 | 0 | 是 | 绕过（P0） |
| N-63 | report | <code>[9]: /x "t<br>line1<br>line2<br>line3<br>line4<br>line5<br>本次审计结论：fail"</code> | 1 | — | 否 | 阻断 |
| N-64 | report | <code>[9]: /x "本次审计结论&period;fail"</code> | 1 | — | 否 | 阻断 |
| N-65 | report | <code>[9]: /x "本次审计结论&colon;fail"</code> | 1 | — | 否 | 阻断 |
| N-66 | gate | <code>，证据&#19981;充分</code> | 1 | — | 否 | 阻断 |
| N-67 | gate | <code>- 结论：**pass**，仍有 2 项未解决。</code> | 1 | — | 否 | 阻断 |
| N-68 | gate | <code>，仍有 2 项未落实</code> | 1 | — | 否 | 阻断 |
| N-69 | gate | <code>本次审计通过，但有一项必过项未核验。</code> | 0 | 0 | 是 | 绕过（P0） |
| P-HIST | report | <code>第二轮独立审计判 G1 不通过，本轮已复核。</code> | 1 | — | 否 | 阻断（正控误伤） |

表中 <code>&lt;br&gt;</code> 表示原始换行；<code>—</code> 表示 sign 非 0，未执行 gate-check。


## 关键发现

### P0-1（36 条）：无主语或非词表谓词否定仍可签过

典型已签过载荷：

- 报告 N-01：本次审计通过，但问题未解决。artifact_hash=4fe5c676564eeb4b1650d5a55c74ae8bae5e59a75127f49930e650ef531c4353，body_hash=56214124ac81e3b25129d23b39ef2e6ff2e98725a3ace8c15b7307f90fd2dfaf，gate_file_sha256=c3456958e2a342707a7dc49caf430fe3544a92fb37d995e51fb107598bae6710。
- 报告 N-02：缺陷未关闭；N-03：P0 未清零；N-04：未达要求；N-05：未达标准；N-13：证据不充分；N-17：整改尚未开展；N-20：不予验收；N-21：不能视为通过；N-62：不能认定通过。
- 门 N-46：本次审计通过，但问题未解决。artifact_hash=9d279f47b0abd88cd650f8c72b6b9713b1fa8cd5ef31808a7b626db353885c31，body_hash=0a3fee422d1ee0956637962d4498ff116a007481c91ed3812ccc53d274999262，gate_file_sha256=45e79014514054ed364b588109e09604583dfbcc96cd2fdab4cb21cf64fdfe68。
- 门 N-58：本次审计通过，但 P1 未清零；N-69：本次审计通过，但有一项必过项未核验。

根因在 scripts/gate-check.ts：scanFailStatement（957-1029）的两个分句尾循环（960-966、1018-1027）只测试 BARE_TAIL_RE（874-879）与 matchStructuralNegative（924-948），从不测试 FAIL_VERDICT_RE；同时 FAIL_PASS_STEMS（826-849）不包含解决、关闭、清零、处理、消除、验收、复核、覆盖、核实、完善、落实、销项等谓词。无主语分句因此漏判。门正文与报告共用这套扫描逻辑，所以两侧同时可绕过。

### P0-2（13 条）：计数、比例与待办量词漏判

已签过载荷：

- 报告 N-09：本次审计通过，但 13 项中有 12 项通过（原生 git 复核，artifact_hash=4b2adb5aea6bbb0419640efd8dae307f943f78fa50c9e73cd8af6f8bc0587ff6，body_hash=44728db1a90de297e0046520917fe32253b7eaa74b1e6f82cb459bd321011e67，gate_file_sha256=202f44c0d056ca3bdc5055d890d657d7c052ce787e51bb62048d7f0fdb1a5887）。
- N-10：13 项中只有 12 项通过；N-11：13 项里 12 项通过；N-12：完成度只有 80%；N-26：13 项中有 12 项 pass。
- N-07：仍有 2 项待复核；N-22：原则上有 3 项待完善；N-23：基本上有 2 项待复核；N-30：遗留 2 项；N-31：尚余 2 项。
- 门 N-54：13 项中有 12 项通过，artifact_hash=9d279f47b0abd88cd650f8c72b6b9713b1fa8cd5ef31808a7b626db353885c31，body_hash=1597af162fe1ca294680d6d1794dbf0598eb6e85f087e59f7a3ac5ec56ce9873，gate_file_sha256=b87cb1ce0370771075f3cd2dd704b6176f8ed83c2540041e3428e41f5204c81c；N-56：尚有 2 项待完善；N-57：13 项里 12 项通过。

根因在 countingFailure（882-905）：第 884 行只匹配“N 项中 M 项通过”，不认“中有/只有/里”；比例分支要求“只/仅”紧跟完成、通过、整改、收口、达标；剩余项分支 894 只认致命、重大、问题、缺陷、风险、待补、待整改、未；待办分支 897 只认待补、待整改、待修复、未完成、未收口、未整改、未修复。待复核、待完善、待落实、遗留、尚余均漏判。

### P0-3（2 条）：隐藏定义块超过 5 层容器即漏判

- 报告 N-37：6 层块引用加 [9]: 标题行与“本次审计结论：fail”（原生 git 复核，artifact_hash=575376e2da9fe7a9a127f59cb48e9ceddb8d174cfae09ea5a997aa519b3cea08，body_hash=4a5b6c19657af81c8725310f4246ea344415791d26dc05478c224f25176381de，gate_file_sha256=17996d19c6ab591af190815d0e579064ee36044d8d1ddd585969ddbceecf0dc5）。
- 报告 N-38：6 层嵌套列表加 [9]: 标题行与 fail，artifact_hash=869189d832308b5ddb9e45dbcfe11821bb63487fe357e4073c317dc72a6a3ba0，body_hash=2fc08adef7ee856b1ecce27214b93ec14c57aa6b60869d907dcb6aa20a74b9c3，gate_file_sha256=0be624dd74491f4f0e4c84afd85b68a5db4c31416fed565729dcff6c3c59cdf3。
- 5 层交替容器 N-39 被阻断（解析 null），说明阈值恰在 5 层。

根因：hiddenDefinitionFailure 调用的 stripDefinitionContainers 在 1097 行固定循环 i<5，最多剥 5 个容器标记。第 6 个标记留下后，块首不再匹配 [N]: 或 [N]，整个隐藏定义块不被识别。

### P0-4（3 条）：历史审计句剥离吞掉本轮 fail

- 门 N-47：第28轮独立审计判 G1 不通过（原生 git 复核，artifact_hash=9d279f47b0abd88cd650f8c72b6b9713b1fa8cd5ef31808a7b626db353885c31，body_hash=63c4f41cb47938597e934c04caa2d75e27d103630218760da24abbcf6943a130，gate_file_sha256=3d5c4a8b40c2878805deb140d76936f11e4ae392bc83d59c4cb5833519b37ca6）。
- 门 N-48：第二轮独立审计判 G1 不通过，本轮仍有 2 项未解决。artifact_hash=9d279f47b0abd88cd650f8c72b6b9713b1fa8cd5ef31808a7b626db353885c31，body_hash=b7d24b7905745a432ba125fc1756bd0958c43d99df73195e2ccc543ad84507f7，gate_file_sha256=c8c0db62a0fd9365b9ee8600177789fcd8d6fd4f1f46d39a9b6cec5f594770e7。
- 门 N-49：round 28 audit failed. artifact_hash=9d279f47b0abd88cd650f8c72b6b9713b1fa8cd5ef31808a7b626db353885c31，body_hash=ad83cb623e144d6e4a7712d5d377128343afd5ea1d848a2855efed1cb21f02f3，gate_file_sha256=81d989a2fc456dfc9b5e17751b637a2c54c616b808b64ffe55a7a3e6c6892615。
- 对照：N-50 两句写法被阻断（第二轮…不通过。 本轮仍有 2 项未解决），N-51、N-52 门头括号内否定被阻断。

根因：HISTORICAL_AUDIT_SENTENCE_RE（1055 行）从行首匹配“第 N 轮/round N … 不通过/未通过/fail”，一直吃到句末；stripHistoricalAuditSentence 在 bodyConclusionOf（1184 行）扫描前对每一行执行替换。它不区分历史轮次与本轮，也不保留同句后半段，因此本轮第 28 轮的 fail 叙述与“本轮仍有 2 项未解决”一起被删掉。

### P1-1：回归覆盖缺少本轮全部新形态

tests/gate-check.spec.ts 的“审计结论解析：S1 第二十七轮与 S2 第三十二轮载荷”组（1108-1180）覆盖 25 条旧可见失败行、4 条旧无主语行、18 条“通过但…”旧式、1 条正控、4 条门尾、6 个定义块用例与 2 条门头否定。对本轮 54 条绕过所涉形态，检索“问题未解决、待复核、完成度只有、中有 12、第28轮、6 层、证据不充分、未达标准”只命中第 1002 行一个无关数字实体，未发现对应断言。新形态没有任何回归保护，按 P1 记。

### P1-2：报告侧历史审计叙述正控被误伤

夹具报告追加一行“第二轮独立审计判 G1 不通过，本轮已复核。”后，sign-gate 退出 1，gate-check 未执行，门文件未变化（sha256=872004cdfb77061b35ef12112e89abeb5e257edc7f152cbbd8aea113aaa3d4cc）；auditConclusionOf 返回 null，bodyConclusionOf 返回 pass。把同一历史句放在正式结论前，auditConclusionOf 仍为 null。stderr：

~~~~
Error: 审计报告里找不到唯一结论行，不能拿它当门记录依据: docs/audits/S1-fixture-round28.md
    at checkAuditAnchor (file:///D:/aboutAI/aa28-native/scripts/gate-check.ts:1818:22)
    at verifyGateRecord (file:///D:/aboutAI/aa28-native/scripts/gate-check.ts:1929:3)
    at async file:///D:/aboutAI/aa28-native/scripts/sign-gate.ts:81:1
~~~~

根因：bodyConclusionOf（1184 行）在扫描前调用 stripHistoricalAuditSentence，历史句会被剥掉；auditConclusionOf（1128-1175 行）没有这一步。1138 行对全文 join 做 visibleFailStatement 时读到“不通过”，置 inlineFail=true；随后读到正式 pass 结论，1173 行因 pass + inlineFail 返回 null。报告侧因此把“历史上第 N 轮不通过”的叙述误判为本轮 fail，合法报告无法签名。该问题方向是误伤而非签过，按 P1 记；旧 P1-1 的 G2 门正文误判已在 bodyConclusionOf 层闭合，但报告侧仍不对称。

## P1/P2 闭合复核

以下条目沿用上一轮编号（旧 P1-1、旧 P1-2）；本轮新增的 P1-1、P1-2 见关键发现。

- 旧 P1-1（G2 历史叙述被误判为本轮 fail）：解析器层已闭合。bodyConclusionOf(docs/gates/G2.md) 在 HEAD 返回 pass，G1 同样返回 pass。在干净克隆 D:/aboutAI/aa28-g2 上执行 gate-check G2，退出 1，唯一失败原因是审计报告 sha256 未签：0000000000000000000000000000000000000000000000000000000000000000 != c9cef2e419c91711524e9784900050d988200253d76f3a2fb4e31dfd3872da63。G2 仍为未签态，未在主仓重签，符合任务边界。
- 旧 P1-2（门正文与报告共用同一尾巴校验）：第一层已闭合。bodyConclusionOf 的 pass 分支（1191 行）与 auditConclusionOf（1170 行）都调用 validConclusionTail（1749-1768），门正文不再使用宽松尾巴。但报告文字与门正文/证据计数之间仍无语义交叉核对，见 P2-2。
- required_hashes：声明非空时失败关闭。src/core/policy.ts 的 evaluateEvidence（46-76 行）校验每个键为 64 位十六进制、output 含同名键、值等于 sha256(canonicalJson(product))、product 非空且互不相同、强度非 weak；伪造值返回 verification_too_weak。但 apply-report.ts:257 使用 policy.requiredHashes ?? []，空清单仍被接受，见 P2-1。
- 回归：旧形态有覆盖，新形态无覆盖，见 P1-1。

## P2

### P2-1：required_hashes 为空时仍放行

探针结果：声明且一致的哈希返回 ok:true；声明的伪造哈希返回 ok:false、reason=verification_too_weak；空清单且无 output 返回 ok:true。生产路径 apply-report.ts:257 把空清单当作合法输入，required_hashes 的保护只在“声明了”时生效。按任务口径记为 P2，S3 前置项。

### P2-2：报告与门/证据之间仍只有词法校验

共享 validConclusionTail 只检查结论尾巴的词法形态；报告写“13 项必过全过”时，没有拿门正文的必过项清单、证据索引与哈希做语义核对。词法层已统一，语义层仍缺。记为 P2，S3 前置项。

## 关键复现命令

报告侧（N-01，结果应为 sign 0、check 0、门文件变化）：

~~~~
Set-Location D:/aboutAI/dsh-orchestra-aa28
git reset --hard bdd002c
Add-Content docs/audits/S1-fixture-round28.md '本次审计通过，但问题未解决。'
git add docs/audits/S1-fixture-round28.md
git commit -m "case N-01"
node --no-warnings scripts/sign-gate.ts docs/gates/G1.md
git add docs/gates/G1.md
git commit --amend --no-edit
node --no-warnings scripts/gate-check.ts docs/gates/G1.md
~~~~

门侧（N-47）：把“第28轮独立审计判 G1 不通过。”追加到 docs/gates/G1.md 正文末尾，提交后重复同一 sign 与 gate-check 命令。

原生复核（N-01、N-09、N-37、N-47）：

~~~~
Set-Location D:/aboutAI/aa28-native
node --no-warnings D:/aboutAI/aa28-work/native-verify.mjs
Get-Content D:/aboutAI/aa28-work/results-round28-native.jsonl
~~~~

分片矩阵结果汇总在 D:/aboutAI/aa28-work/results-round28-shard0..7.jsonl，逐条表由这些文件生成。

## 限制

- 为缩短 112 条用例的原生 git 开销，矩阵在 8 个 worktree 分片中使用了一个 git show 缓存 shim：未改动的候选与证据文件按工作树字节返回，docs/gates 与夹具报告仍走原生 git。N-01、N-09、N-37、N-47 四条关键用例已在 D:/aboutAI/aa28-native 用原生 git 完整复跑，解析、退出码、门变化与三组哈希均与分片结果逐字节一致；其余 108 条未逐条原生复跑，但所涉文件在用例中未改动。
- 审计期间主仓工作树出现外部改动：M codebasemap.md、M scripts/gate-check.ts（审计开始时工作树干净；该改动不是本审计产生，未触碰，也未纳入本轮判定），以及未跟踪的 %SystemDrive%/；候选提交仍按 HEAD 4f87642 计，主仓 G1/G2 均未重签。
- 4f87642 相对 ec89aec 只改 handoff.md，候选提交按实际 HEAD 绑定 4f87642。
- G2 只在解析器与锚点层复核，未重签，未做 G2 全矩阵。
- 本轮新增 69 条针对已识别家族构造，不构成穷举；未覆盖的谓词与句式仍可能漏判。

## 最终判定

可见 fail 文本仍能通过签名与门检查，按任务口径判 fail。

结论：fail
