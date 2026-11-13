# S2 第三十三轮审计对照表

审计报告：docs/audits/S2-independent-audit-round33.md（结论 fail，P0=5 / P1=0 / P2=2，候选 4f87642）
本对照表对应整改候选。审计对象只审 G2，本轮不重签任何门。

## P0-1（11 条）否定谓词族缺副词与限定宾语

整改：

- FAIL_FILLERS 补 顺利/順利、正式、全面、整体/整體、一次性、本次、当次/當次（scripts/gate-check.ts:815-833）。
- FAIL_OBJECTS 补 本次验收/本次驗收、当次复核检查/當次複核檢查、本次复核/本次覆核、本次检查/本次檢查（scripts/gate-check.ts:870-898）。
- FAIL_PASS_STEMS 已有 认可/認可、通过/通過、收口 等谓词，组合后覆盖“未获全面通过”“没有获得全面认可”“未正式收口”。

覆盖：r33-01 未能顺利通过、02 未正式收口、03 未获全面通过、04 未获整体通过、05 未通过本次验收、06 未通过当次复核检查、15 未一次性通过、17 未能一次性通过验收检查、18 没有获得全面认可、x01 未&#39034;利通过验收、x02 未&#26410;顺利通过验收，全部 auditConclusionOf=null。

## P0-2（15 条）计数、比例、完成度与部分通过

整改（scripts/gate-check.ts:917-1010）：

- “N 项中 M 项通过”支持 项 后可选 必过/必過/通过项/通過項，支持 中/里/裡/当中/當中，M 后支持 均/都/全部/全/已/为/為。
- 新增 N/M 比例、分项通过/未通过、未通过 N 项、完成一半/半数、百分之八十、通过率不足 100%。
- N/M 比例保留正控例外：13/19 项必过全过、19/19 项必过全过不判失败。

覆盖：r33-07、08、09、10、13、14、16、19、20、33、42 与 x03、x04、x05、x10，全部 auditConclusionOf=null 或 bodyConclusionOf=fail；合法正控 r33-34（19 项必过全过，失败项为空，无 run，P2 遗留 2 条）保持 pass。

## P0-3（3 条）无主语待办/待改进

整改：BARE_TAIL_VERDICTS 与 countingFailure 的待办分支都补 待办/待辦、待改进/待改進（scripts/gate-check.ts:900-915、917-1010）。P2/P3 豁免只给“遗留/遺留”，不给“待办”。

覆盖：r33-11 原则上有 3 项待办、r33-12 尚有 3 项 P2 待办、x08 门标题（原则上 3 项待办），全部 auditConclusionOf=null 或 bodyConclusionOf=fail。

## P0-4（10 条）门正文当前轮历史伪装与弱判词

整改：

- HISTORICAL_AUDIT_SENTENCE_RE 只在同一句带明确整改说明时剥离，不再把无整改说明的“第 N 轮……不通过”当历史（scripts/gate-check.ts:1136-1139）。
- FAIL_FILLERS 的 顺利/正式/本次/当次、FAIL_VERDICTS 的 部分通过/暂缓 等组合，覆盖门正文弱判词。
- 门正文继续与报告共用同一套 visibleFailStatement / countingFailure / 结构否定扫描。

覆盖：r33-24、25、26、27、28、29、30、31、32 与 x09，全部 bodyConclusionOf=fail；历史正控“第二轮独立审计判 G1 不通过，本轮已复核”保持 pass。

## P0-5（3 条）六层嵌套引用定义

整改：stripDefinitionContainers 去掉固定 5 层上限，循环剥离到不再变化（scripts/gate-check.ts:1176-1184）。六层引用、六层列表与六层引用续行的定义内容都进入 hiddenDefinitionFailure。

覆盖：r33-37、38、39 全部 auditConclusionOf=null；五层对照 r33-41 与七行跨行定义 r33-40 仍被阻断。

## P2

- P2-1 回归覆盖：已新增正式用例“S2 第三十三轮：42 条绕过全部拦下，历史叙述与合法 P2 遗留不误伤”，52 条载荷（42 绕过 + 9 对照 + 1 正控）全部固化到 tests/gate-check.spec.ts。
- P2-2 “第 33 轮”带空格的历史叙述仍会误判：本轮未改。解析器没有当前门 audit_round 上下文，放开空格会同时放宽当前轮伪装；留到 S3 把门轮次传入解析器后按轮次判定。

## 验证

- tsc --noEmit → exit 0。
- tests/gate-check.spec.ts → 151 例，137 passed / 14 failed；14 红全部是 G1 预签态（audit_report_sha256=0*64 != 50ba1b13cdf1b84d…），不是解析器回归。
- 全量 vitest → 33 文件 / 438 例，424 passed / 14 failed，红点同上。
- 直接探针：52 条 r33 载荷（42 绕过 + 9 对照 + 1 正控）全部符合预期；上一轮 20 条复跑仍全部挡住。
