# S2 第二十八轮审计整改对照

- 审计报告：docs/audits/S2-independent-audit-round28.md（结论 fail，P0=2 / P1=0 / P2=2）
- 审计候选：d1dfe12
- 整改状态：P0-1、P0-2、P2-1、P2-2 已改并补回归
- 本表不构成放行依据：G1/G2 仍未重签，S1 第二十三轮未回，S3 未开

## P0-1 正式结论行写 pass 时，正文同义否定仍被放行

根因（A1）：scripts/gate-check.ts 的裁决词表缺少「未过 / 否 / 未通过收口 / 不获认同 / unapproved」等收口语；NFKC 不折叠无点 ı，`faıl` 匹配不到 fail；宾语族缺少「本次审计 / 本报告」。

改法：
- scripts/gate-check.ts:687-700 FAIL_VERDICTS 补 `未通过收口/未通過收口/未过/未過/否/unapproved/disapproved/unaccepted/nonapproved`，并扩 `部分通过/有条件通过/附条件通过/未受理/不予受理/未接收/不接受/不予接受/未接受/待整改/需整改/仍需整改/尚未整改/有待整改/待修复/需修复/暂缓/搁置/待定/悬置/否定/负面/negative/unfavorable/unfavourable/declined/vetoed/turned down/unacceptable/noncompliant`。
- scripts/gate-check.ts:725 HOMOGLYPHS 补 `ı`→`i`；:787 FAIL_PASS_STEMS 补 `认同/認同/赞同/贊同/首肯/受理/接收/接受`。
- FAIL_OBJECTS 补「本次审计 / 本报告」族，HISTORICAL_NEG_RE 同步收这些否定，历史句仍不误杀。

回归：tests/gate-check.spec.ts:376-393 逐条跑审计给出的 6 条变体，并追加同义族、安全句「本次审计结论为未过项为零，全部通过。」与历史句「历史记录：上一轮审计结论为未过，本轮已整改。」。

## P0-2 门记录正文插入同义否定后仍能重签

改法（A2）：bodyConclusionOf 走同一套 foldForVerdict + visibleFailStatement；裁决词、同形字、宾语与收口语补进后，「本次审计结论为未过。」在门正文返回 fail，不再与 artifact.conclusion=pass 并存。

回归：同一用例的门正文断言。

## P2-1 timeout 只绑定成功工具行也能收口

根因：src/service/commands/apply-report.ts:233 的 timeout 分支没有要求失败行，工具表里存在一条成功行时就 accepted=true。

改法：失败与超时统一 `requireFailure: true`；timeout 也必须至少有一条 failed 工具行。

回归：tests/apply-report.spec.ts:511「timeout 只有成功行 → tool_execution_failed」；:522 覆盖同 attempt 另有失败行时也不能拿成功行收口。

## P2-2 required_hashes 重复键名被静默去重

根因：src/service/workflows.ts:97 用 `Array.from(new Set(...))` 合并必留哈希键，重复键会让其中一条要求消失。

改法：src/core/workflow-def.ts:42-60 新增 assertNoDuplicateRequiredHashes，在 assertDefinitionAllowed 里对模板层与每个节点层分别查重；重复抛 `WORKFLOW_VALIDATION_FAILED`「必留哈希键名重复，要求会被静默折叠」。

回归：tests/workflows.spec.ts:57 同一层重复键在加载期被拒；:13 的正常重复加载不受影响。

## 本轮验证

- `D:\NodeJs\node.exe node_modules/typescript/bin/tsc --noEmit`：exit 0。
- 定向 `tests/gate-check.spec.ts tests/apply-report.spec.ts tests/workflows.spec.ts`：133 例，122 passed / 11 failed；11 红全为 G1 预签态。
- 全量 `vitest run`：32 文件 / 367 例，356 passed / 11 failed；11 红同一预签态。

## 未收口

- S1 第二十三轮报告未回；回来后一并整改并提交。
- 提交后重派两份独立审计；两份 pass 后才重签 G1/G2。
- S3 九节点与状态机继续冻结。
