# S1 第二十八轮审计对照表

审计报告：docs/audits/S1-independent-audit-round28.md（结论 fail，P0=4 / P1=2 / P2=2，候选 4f87642）
本对照表对应整改候选。审计对象只审 G1，本轮不重签任何门。

## P0-1（36 条）无主语或非词表谓词否定

整改：

- FAIL_PASS_STEMS 补 解决/解決、关闭/關閉、清零、处理/處理、消除、结束/結束、验收/驗收、复核/覆核、覆盖/覆蓋、核实/核實、完善、落实/落實、销项/銷項 等可被否定的完成度谓词（scripts/gate-check.ts:835-868）。
- scanFailStatement 的两个分句尾循环都改为直接测试 FAIL_VERDICT_RE，不再只测 BARE_TAIL 与结构否定（scripts/gate-check.ts:1028-1108）。
- 句尾裁决词保留“算/视为/视作/认定/记作/属于/归为”归类规则跳过，避免把 G1.md:205 的“都算没过”误判为本轮否决。

覆盖：N-01 问题未解决、N-02 缺陷未关闭、N-03 P0 未清零、N-04 未达要求、N-05 未达标准、N-13 证据不充分、N-17 整改尚未开展、N-20 不予验收、N-21 不能视为通过、N-62 不能认定通过，以及门侧 N-46/N-58/N-69 同族载荷，全部返回 null/fail。

## P0-2（13 条）计数、比例与待办量词

整改（scripts/gate-check.ts:917-1010）：

- “N 项中 M 项通过”支持 中有/只有/仅有/其中/还有/里/当中 等连接词，并支持 均/都/全部/全/已/为 修饰。
- 新增 N/M 比例（18/19 项）、分项通过（18 项通过、1 项未过）、未通过 N 项、完成一半/半数、百分之八十、通过率不足 100%。
- 剩余量与待办量词补 待复核、待完善、待落实、遗留、尚余、待办、待改进 等；P2/P3 遗留仍按既有正控豁免，但“P2 待办”不豁免。

覆盖：N-07、N-09、N-10、N-11、N-12、N-22、N-23、N-26、N-30、N-31 与门侧 N-54/N-56/N-57，全部返回 null/fail。

## P0-3（2 条）六层容器隐藏定义

整改：stripDefinitionContainers 去掉固定 5 层上限，改为循环剥离到不再变化；长度有限，必然收敛（scripts/gate-check.ts:1176-1184）。六层引用、六层列表与六层引用续行都进入 hiddenDefinitionFailure。

覆盖：N-37、N-38 与五层对照 N-39，全部返回 null。

## P0-4（3 条）历史审计句吞掉本轮 fail

整改：HISTORICAL_AUDIT_SENTENCE_RE 只在同一句带“这版/本轮已/已整改/已修复/已收口/逐条整改/按…整改”等明确整改说明时才整句剥离，且只剥离历史段本身，句后本轮否定保留（scripts/gate-check.ts:1136-1139）。

覆盖：N-47 第28轮独立审计判 G1 不通过、N-48 同句后接“本轮仍有 2 项未解决”、N-49 round 28 audit failed，全部返回 null/fail；N-50/N-51/N-52 对照仍被阻断。

## P1-1 回归覆盖

新增正式用例“S1 第二十八轮：54 条可见否定绕过必须全部拦下…”，拆成 43 条报告侧、11 条门侧，并保留 3 条清零正控、1 条门正控、P-HIST 历史正控（tests/gate-check.spec.ts:1181 起）。临时探针 70 条全过，已并入正式套件。

## P1-2 报告侧历史叙述误伤

整改：auditConclusionOf 与 bodyConclusionOf 都先对渲染行执行 stripHistoricalAuditSentence，报告侧不再把“第二轮独立审计判 G1 不通过，本轮已复核”当成本轮 fail（scripts/gate-check.ts:1210-1260、1263-1293）。

## P2

- P2-1 required_hashes 为空仍放行：本轮未改，保留为 S3 前置项；生产路径的声明非空校验已在 tests/apply-report.spec.ts 闭合。
- P2-2 报告与门/证据仍只有词法校验：本轮未改，保留为 S3 前置项。

## 验证

- tsc --noEmit → exit 0。
- tests/gate-check.spec.ts → 151 例，137 passed / 14 failed；14 红全部是 G1 预签态（audit_report_sha256=0*64 != 50ba1b13cdf1b84d…），不是解析器回归。
- 全量 vitest → 33 文件 / 438 例，424 passed / 14 failed，红点同上。
- 直接探针：54 条 S1 第二十八轮绕过全部 auditConclusionOf=null；3 条清零正控与 P-HIST 保持 pass。
