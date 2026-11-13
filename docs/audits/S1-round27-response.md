# S1 第二十七轮审计对照表

审计报告：docs/audits/S1-independent-audit-round27.md（结论 fail，P0=3 / P1=2 / P2=2，候选 98032b0）
本对照表对应整改候选。

## P0-1 句尾裸裁决词与未完成事实

整改落在 scripts/gate-check.ts：

- 分句尾扫描补上裸裁决词表：待补、待整改、未整改、未收口、未完成、部分通过、不予采信等，不再只认“否定词 + 谓词”的结构（scripts/gate-check.ts:874-879、:957）。
- FAIL_FILLERS 补 全部/全都/均/都/逐一/逐项/逐項/取得/地；FAIL_PASS_STEMS 补 收口/到位/开始/開始/做完/闭环/閉環/整改；FAIL_OBJECTS 补 收口/检查/檢查/全部准入条件/全部準入條件。
- countingFailure 新增计数语义：N 项中 M 项通过、只完成 80%/一半、尚差 N 项、仍有 N 项 + 致命/待补、原则上/基本上/大致上有 N 项待补（scripts/gate-check.ts:882-906）。
- visibleFailStatement 先判计数与未完成事实，再走结构否定扫描（scripts/gate-check.ts:1077-1082）。

覆盖：审计报告 R-01 至 R-20 的原文逐条进了回归（“本次审计通过，但……”十八条），另有二十六条无前缀变体；全部 auditConclusionOf = null。R-12、R-15 两条原本就被挡住的对照仍为 null。

## P0-2 门正文结论行尾巴

整改：bodyConclusionOf 的 pass 分支改走与报告侧同一个 validConclusionTail（scripts/gate-check.ts:1175-1191、:1745-1788）。门头括号内再写“仍有 3 项致命待补”“准入条件仍缺 2 项”，或结论行后用逗号挂“整改尚未全部完成”，现在都返回 fail。

覆盖：S1 第二十七轮 B-06/B-07 的门头括号原文、S2 第三十二轮 B1/B2 的两种尾巴形态，全部进正式用例。

## P0-3 引用定义隐藏否决

整改：hiddenDefinitionFailure 重写（scripts/gate-check.ts:1107-1121）：

- 按 Markdown 引用定义语法取整个定义块到空行为止，不再设三行窗口。
- 起始行允许五层块引用与列表标记嵌套，跨行标签 [本次审计结论：fail⏎]: /url 也按定义处理。
- 定义头按 URI/域名规则剥掉目的地，标题与后续行逐行检查。
- HTML 实体改用 markdown-it 的 unescapeAll 解全部命名实体与数字实体（scripts/gate-check.ts:1226-1233）。
- 定义块里同时出现判定词与 pass/fail 时直接拒绝，不依赖冒号形态，覆盖 &period; 这类以句点分隔的写法。

覆盖：S1 第二十七轮 R-H2（五段定义）、R-H3（列表嵌套）、R-H6（块引用五段）、R-H4（&period; 实体）、B-14（门正文五段）全部返回 null/fail；R-H1、R-H5 原来能挡的仍挡住。

## P1-1 G2 历史叙述误判

整改：新增 HISTORICAL_AUDIT_SENTENCE_RE 与 stripHistoricalAuditSentence，只剥“第 N 轮 / round N … 不通过 / fail”这类历史审计叙述，不碰本轮结论（scripts/gate-check.ts:1055-1063）。bodyConclusionOf 在扫描前对可见行统一剥离（scripts/gate-check.ts:1180）。

直接探针：bodyConclusionOf(docs/gates/G2.md) = pass。G2 不再因第二轮、第三轮、第五轮、第六轮的历史“不通过”被判 fail；G2 仍未重签，gate-check 仍在脏树检查处失败关闭，这是签前状态，不是本轮结论。

## P1-2 门正文与报告同源

本轮做到审计建议的第一层：门正文结论行与报告结论行共用 validConclusionTail，尾巴语义不再一边严一边松。必过项、证据表、例外段的结构化同源对照属于更大的改动，列入 S3 前置项，审计 pass 前不扩面。

## P2

- P2-1 required_hashes：生产路径仍失败关闭，未发现回归。节点 schema 对 irreversible 强制 required_hashes 非空列入 S3 前置项，本轮不改协议。
- P2-2 实体解码：已改用 unescapeAll 覆盖完整命名实体，并在定义块内加判定词兜底。

## 验证

- tsc --noEmit → exit 0。
- tests/gate-check.spec.ts → 149 例，138 passed / 11 failed；11 红全部是 G1 预签态（audit_report_sha256=0*64 != 50ba1b13cdf1b84d…），本轮没有新增回归。
- 本轮新增 62 例：S1 第二十七轮与 S2 第三十二轮载荷组（含 18 条“通过但未完成”原文、门头括号 2 例、&period; 定义 1 例）。
