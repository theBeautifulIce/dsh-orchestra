# S1 第二十三轮审计对照表

审计报告：docs/audits/S1-independent-audit-round23.md（结论 fail，P0=2 / P1=3 / P2=2，候选 d1dfe12）
本对照表对应整改候选。

## P0-1 历史通过锚吞掉当前轮否定（7 例）

整改前：上一轮审计已通过，本报告未通过验收，本轮已整改。等七例 sign-gate 与 gate-check 都是 exit 0。

根因：stripHistoricalRemediation 在历史整改段里找第一个否定词，从否定词之后保留文字。历史锚本身是通过态时，段内第一个否定其实属于当前轮，被误当历史否定截掉。

整改：scripts/gate-check.ts 增加 HISTORICAL_POSITIVE_RE。若历史段中否定词之前已经出现通过/通過/passing/passed/approved，整段保留给统一扫描器，不再截断。历史锚为否定态的合法句子（历史记录：上一轮审计未通过，本轮已整改。）仍只截掉历史否定本身。

覆盖：n01、n02、n03、n04、n21、n18、n22。

## P0-2 裁决词宾语缺口（4 例）

整改：FAIL_OBJECTS 补 复核/复查/复审/审查/核查/确认/最终验收/专家评审/专家复核及繁體。未通过复核、未通过最终验收、本次审计未通过专家评审、本报告未通過复核都按同一句否定处理。

覆盖：n05、n06、n07、n19、m01。

## P1-1 副词前缀（5 例）

整改：FAIL_NEGATIONS 补 尚未/还没/還沒/暂未/暫未/仍未/从未/從未/并未/並未；结构否定可直接从这些词起算。覆盖：n08、n09、n10、n11、m16。

## P1-2 完成度陈述（5 例）

整改：FAIL_CONNECTORS 补 整改/整改工作/修复/修复工作/收口/remediation；FAIL_PASS_STEMS 补 完成/complete/completed/completion。本报告整改尚未完成、本轮整改仍未完成、This audit remediation is not complete 都能走到否定谓词。覆盖：n12、n13、n20、n24、m14。

## P1-3 英文 not yet（2 例）

整改：FAIL_FILLERS 补 yet/been；has not yet passed、has not yet been approved 能在否定词与谓词之间吃掉 yet/been。覆盖：n14、n15。

## P2

- P2-1 繁體宾语：随 P0-2 宾语表一并补齐。
- P2-2 同形字 ß：HOMOGLYPHS 增 'ß' → 'ss'，paß 折叠为 pass。

## 验证

- 二十条绕过载荷全部进入 tests/gate-check.spec.ts 新用例，断言 auditConclusionOf 为 null、bodyConclusionOf 为 fail。
- 合法历史句与清零句仍为 pass：历史记录：上一轮审计未通过，本轮已整改。／上一轮审计未通过，本轮已整改。／round20 审计结论为 fail，本轮已整改。／本次审计结论为未过项为零，全部通过。／未通过项为 0，结论：pass。
- tsc --noEmit exit 0；tests/gate-check.spec.ts 82 例 71 passed / 11 failed，11 红全部是 G1 预签态，不是解析器回归；G1.md 与 G2.md 的 bodyConclusionOf 均为 pass。

审计 pass 前不签门、不开 S3。
