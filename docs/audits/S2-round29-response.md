# S2 第二十九轮审计对照表

审计报告：docs/audits/S2-independent-audit-round29.md（结论 fail，P0=1 / P1=0 / P2=4）
审计对象：候选 b92e849；本对照表对应整改候选。

## P0：推荐/建议/采信否定族被当成通过

报告载荷七条，整改前在临时 clone 上 sign-gate 与 gate-check 都是 exit 0：

1. 本次审计不推荐通过本报告。
2. 不予采信本报告。
3. 不建议通过本报告。
4. 结论为：不予推荐。
5. This audit does not recommend the report.
6. 未予推荐本报告。
7. 把「本次审计不推荐通过本报告。」注入 G2 门正文。

根因有三处：裁决词表没有推荐/建议/采信/recommend 族；结构否定只吃一个宾语，「不推荐通过本报告」停在「推荐」；句首没有主语的否定（「不予采信本报告。」）没有入口。

整改：

- scripts/gate-check.ts 的 FAIL_PASS_STEMS 补 推荐/建議/建议/采信/採信/赞成/贊成/支持/背书/背書/recommend/endorse/support 各形态；FAIL_VERDICTS 补 不推荐/不予推荐/不建议/不予采信/不采信/未予推荐/未推荐/not recommend/does not recommend/recommend against；FAIL_SUBJECTS 补 recommendation(s)；FAIL_CONNECTORS 补 建议/建議/推荐/推薦。
- matchStructuralNegative 的谓词命中后连续吃最多三个宾语，覆盖「推荐 + 通过 + 本报告」。
- scanFailStatement 末尾增加句首裸否定扫描；auditConclusionOf 与 bodyConclusionOf 增加逐行 lineFailure(line)：先抓句首裸否定，行首是结论词时再按完整主语扫一遍。历史审计叙述（第五轮……不通过）仍不当作本轮否决。
- tests/gate-check.spec.ts 固化报告里的六条文本载荷，断言 auditConclusionOf 为 null、bodyConclusionOf 为 fail。

验证：tsc --noEmit exit 0；tests/gate-check.spec.ts 81 例 70 passed / 11 failed，11 红全部是 G1 预签态（audit_report_sha256 仍为 64 个 0），不是解析器回归；G1.md 与 G2.md 的 bodyConclusionOf 均为 pass。

## P2 处置

- P2-1（G2 在 b92e849 是预签态）：预期状态，本轮整改提交后重签时消除。
- P2-2（跨层同名 required_hashes 被并集折叠）：保留现有语义。required_hashes 是「这个作用域要求哪些产物」的集合，模板层与节点层要同一个键时指向同一个产物，并集后仍是同一条要求，不存在少核一条；同层重复已经在加载期拒绝。若后续要区分同名不同产物，应先给键加作用域，而不是在加载期拒绝合法定义。
- P2-3（缺推荐/采信回归）：已补。
- P2-4（审计窗口内 HEAD 推进）：本轮提交时把报告与整改放在同一个候选里，重派审计后不再推进 HEAD。

## 提交与复审

本对照表、第二轮二十九轮报告、解析器与测试一起提交；提交后重派 S2 第三十轮与被引用的 S1 审计。审计 pass 前不签门、不开 S3。
