# S1 第二十五轮审计对照表

审计报告：docs/audits/S1-independent-audit-round25.md（结论 fail，P0=3 / P1=2 / P2=2，候选 998c89b）
本对照表对应整改候选。

## P0-3：十条可见否定仍被签成 pass

报告载荷 R01–R07、N04、B01、B03 在 998 上 sign-gate 与 gate-check 都是 exit 0。整改前的结构假设太窄：主语后只允许固定连接词，否定后只允许固定填充词，裁决只覆盖有限谓词。

整改：

- FAIL_CONNECTORS 补 验收/驗收、复核/復核、评审/評審、审核/審核（对象名词作句中桥梁）、被（被动标记）、目前/當前/当前、暂时/暫時、尚、尚且、完成度、完成率、进度/進度、in（英文状态介词）。
- FAIL_VERDICTS 补 不足/不够/不夠/未完成/未收口。
- FAIL_OBJECTS 补 放行条件/放行條件，避免“不具备放行条件”停在“放行”后漏掉“条件”。
- 十类载荷现在 auditConclusionOf 全为 null、bodyConclusionOf 全为 fail；同族安全正句（验收通过、目前通过验收、完成度 100%、in a passing state）仍为 pass。

## P0-1 / P0-2 / P1-1 / P1-2：预签态与旧审计报告

这四条不是解析器缺陷，而是候选还没有对着本轮 pass 报告重签的预期状态：

- G1 audit_round=1、G2 audit_round=4，audit_report_sha256 均为 64 个 0；998 上重签必然失败。
- G1 指向的 round1 报告写 G-08 fail、建议不通过；G2 指向的 round4 报告写结论 fail。旧报告本来就不能支持 pass。

处置：所有独立审计都 pass 后，按既有顺序把 G1/G2 的 audit_round 与 audit_report 指向新的 pass 报告、清零审计 sha、提交、再 sign-gate；重签后 gate-check 会同时校验新报告结论、六类哈希与逐份证据。审计 pass 前不签门。

## P2-1：不可见文本的契约

按 markdown 可见性语义，HTML 注释与围栏代码不构成审计证据。已在 tests/gate-check.spec.ts 的 S1 第二十五轮用例里固化：注释里的“本报告不能放行”与围栏里的“结论：fail”不改变可见 pass 结论。H02/H03 这类可见 HTML 与参考式链接已 fail-closed。

## P2-2：删除/重命名候选分支

本轮候选没有删除或重命名，candidateEntries 的 DELETED / ADDED_THEN_DELETED 分支仍只有代码审查。接受为覆盖缺口，待出现真实删除或重命名候选时补行为证据。

## 验证

- node node_modules/typescript/bin/tsc --noEmit → exit 0。
- tests/gate-check.spec.ts → 85 例，74 passed / 11 failed；11 红全部是 G1 预签态，不是解析器回归。
- 全量 vitest → 32 文件 / 371 例，360 passed / 11 failed；红点同上。
- S1 第二十五轮新用例单独运行 1 passed / 84 skipped。

## 提交与复审

本对照表、第二十五轮报告、scripts/gate-check.ts 与 tests/gate-check.spec.ts 一起提交；提交后在新候选上重派 S1 与 S2 独立审计。审计 pass 前不签门、不开 S3。
