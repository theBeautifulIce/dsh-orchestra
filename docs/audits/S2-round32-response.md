# S2 第三十二轮审计对照表

审计报告：docs/audits/S2-independent-audit-round32.md（结论 fail，P0=2 / P1=1 / P2=1，候选 98032b0）
本对照表对应整改候选。

## P0-1 量词、副词与名词宾语洗白

整改：

- FAIL_FILLERS 补 全部/全都/均/都/逐一/逐项/逐項/取得/地，结构化否定不再在“尚未全部完成”“未取得全部通过”处断链。
- FAIL_PASS_STEMS 补 收口/到位/开始/開始/做完/闭环/閉環/整改；FAIL_OBJECTS 补 收口/检查/檢查/全部准入条件/全部準入條件。
- 分句尾新增无主语否定表与计数语义：待补、未整改、未收口、部分通过、N 项中 M 项通过、只完成 80%、尚差 N 项、原则上/基本上有 N 项待补（scripts/gate-check.ts:874-906、:957）。
- visibleFailStatement 先判计数与未完成事实，再走结构否定（scripts/gate-check.ts:1077-1082）。

覆盖：R1 整改工作尚未全部完成、R2 本次审计未通过验收检查、R3 本轮审计存在未完成项、R13 未获得全部通过、R14 没有取得全部认可，全部 auditConclusionOf = null；同族探针（未通过全部验收、未逐项收口、未彻底地完成）一并进用例。

## P0-2 跨行引用定义窗口

整改：hiddenDefinitionFailure 不再只认单行标签与三行窗口（scripts/gate-check.ts:1107-1121）：

- 起始行支持块引用与列表标记嵌套，标签跨两行也按定义块处理。
- 定义块一直扫到空行，定义后标题的第 5 行、第 N 行都在范围内。
- 目的地按 URI/域名规则剥离，标题逐行检查；实体先 unescapeAll 解码。
- 定义块里同时出现判定词与 pass/fail 时直接拒绝，不依赖冒号。

覆盖：R4 跨行标签、R5 第五行标题、R6 块引用跨行标签、R7 跨行标签内 &#102;ail、B3 门正文同类定义，全部 null/fail；R8 单行定义、B4 可见 fail 仍挡住。

## P1-1 门正文尾巴语义

整改：bodyConclusionOf 的 pass 分支改走 validConclusionTail（scripts/gate-check.ts:1175-1191），与报告侧同一个校验器。B1“结论：**pass**（整改尚未全部完成）”、B2“结论：**pass**，整改尚未全部完成”现在都返回 fail；门头括号 B-06/B-07 的否定也挡住。

## P2-1 回归覆盖

本轮新增 62 例，覆盖量词 filler、跨行标签、定义后第 4 行起的否决、裁决词后名词宾语、门正文结论行尾巴。上一轮遗漏的同族变体已进 tests/gate-check.spec.ts 的“S1 第二十七轮与 S2 第三十二轮载荷”组。

## 验证

- tsc --noEmit → exit 0。
- tests/gate-check.spec.ts → 149 例，138 passed / 11 failed；11 红全部是 G1 预签态（audit_report_sha256=0*64 != 50ba1b13cdf1b84d…），不是解析器回归。
- 直接探针：bodyConclusionOf(docs/gates/G2.md) = pass，历史叙述不再误判本轮结论；G2 尚未重签，双门待两份独立审计 pass 后统一重签。
