# S2 第二十七轮审计整改对照

- 审计报告：docs/audits/S2-independent-audit-round27.md（结论 fail，P0=2 / P1=0 / P2=3）
- 审计候选：e7a3fa4
- 整改状态：P0-1、P0-2 已改并补回归；P2-1、P2-2 是预签态现象，P2-3 由下一轮固定在整改提交上复审
- 本表不构成放行依据：G1/G2 仍未重签，S1 第二十三轮未回，S3 未开

## P0-1 中文宾语否决句漏检

根因：scripts/gate-check.ts:792-798 的 FAIL_OBJECTS 只覆盖验收、审批、评审等，没有「本报告 / 本次审计」这类宾语；scripts/gate-check.ts:858-868 的裁决词命中后直接看尾字符，后面的宾语名词把一句否定当成叙述放行。

改法：
- FAIL_OBJECTS 补 `本次独立审计/本次审计/本轮审计/本审计/审计组/审计小组/本报告/该报告/此报告/报告本身/报告` 与繁體对应词。
- 裁决词命中后先用 matchStructuralObject 吃掉可选宾语，再判定句末；「拒收本报告。」不再停在「本」上。
- 结构化否定分支原本就消费宾语，权限不变。

回归：tests/gate-check.spec.ts:395-415「S2 第二十七轮 P0-1/P0-2」逐条断言「本次审计结论为拒收本报告。」「本报告未通过本次审计。」在审计报告与门记录正文里都不能保留 pass。

同族加固：主语表补 `审计组/审计小组/报告/approval/gate/report`，谓词表补 `failing/acceptable`，连接词表补 `verdict`；结构化否定的填充词改为每层先试谓词，避免 `not acceptable` 里的 `a` 被当作填充词吃掉。追加 9 条载荷（`审计组未予认可。`、`报告未通过审核。`、`The review found the gate failing.`、`This report is not acceptable.`、`Approval was refused.`、`Audit verdict: rejected.` 等）一并进回归。

## P0-2 英文否决句与英文结论行漏检

根因：FAIL_VERDICTS 只有 reject/denied/refused 等原形，没有第三人称 rejects/denies/refuses/declines/vetoes；正式结论行只认中文结论词，`CONCLUSION: FAIL` 直接当普通正文。

改法：
- scripts/gate-check.ts:666 补 rejects/denies/refuses/declines/vetoes。
- scripts/gate-check.ts:930、:938、:959、:977 让 auditConclusionOf 与 bodyConclusionOf 接受 `Conclusion/Verdict/Outcome`（含 `Audit Conclusion` 前缀与大小写）。
- 英文结论词只在紧跟 pass/fail 时按正式结论行处理；正文里的 `Conclusion: the design is sound` 仍按普通叙述跳过，避免误杀。

回归：同一用例覆盖 `This audit rejects the report.`、`This audit denies the report.`、`The review declines the report.`、`CONCLUSION: FAIL`、`Verdict: pass`、`Outcome: PASS` 与安全句。

## P2-1 G2 预签态

不在本批改代码：G2 仍声明 audit_round=4 与全 0 哈希，预签态下 gate-check exit 1 是既定流程。双审计 pass 后统一重签。

## P2-2 G1 预签态 11 例失败

同上。11 红全部是 tests/gate-check.spec.ts 的 G1 audit_report_sha256=0*64 与 50ba1b13… 不一致。

## P2-3 审计期间 HEAD 推进

本轮整改提交后，S1 第二十四轮与 S2 第二十九轮都固定在新提交上重审，报告必须写明候选提交，不再拿旧候选判新树。

## 本轮验证

- `D:\NodeJs\node.exe node_modules/typescript/bin/tsc --noEmit`：exit 0。
- `tests/gate-check.spec.ts`：81 例，70 passed / 11 failed；11 红全为 G1 预签态，无新增回归。
- 全量 `vitest run`：32 文件 / 367 例，356 passed / 11 failed；11 红同一预签态。

## 未收口

- S1 第二十三轮报告未回；回来后一并整改并提交。
- 提交后重派两份独立审计；两份 pass 后才重签 G1/G2。
- S3 九节点与状态机继续冻结。
