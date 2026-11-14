# S2 第三十四轮审计对照表

- 审计报告：docs/audits/S2-independent-audit-round34.md（候选 59fe18d53c554c788cb04437bffbd5f2df76ad4e）
- 本轮结论：fail（P0=0 / P1=1 / P2=1，19 项必过 18/19，失败项 G2-11）

## P1-1 report_id 带引号时判重失效（G2-11 失败的直接原因）

现象：同一份被拒报告重投多次，账本里 report_replayed / report_rejected 一再追加，越刷越长。

根因：`hasNodeRunEvent` 用 `payload LIKE '%"report_id":"' + reportId + '"%'` 在 JSON 文本上比对；report_id 里带 `"` 或 `\` 时，落库的 payload 会把它转义成 `\"`，拼出来的模式永远配不上原文，判重形同没有。上报入参又没有字符集约束，这样的 id 能一路走到收口。

处置三件：

1. `src/service/commands/apply-report.ts`：新增 `countReportEvent(tx, nodeRunId, type, field, value)`，按列读结构化字段，不拼文本：
   `SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = ? AND CASE WHEN json_valid(payload) THEN json_extract(payload, ?) END = ?`；
   `hasNodeRunEvent` 改成 `countReportEvent(..., 'report_id', reportId) > 0`；rejectReport 的同因重复判定也改成 report_id 与 reason 两列同时命中才跳过追加。CASE 包住 `json_extract`，payload 万一不是合法 JSON 只会判不成，不会把查询打挂。
2. `src/service/schemas.ts`：新增 `reportIdentifier = identifier.regex(/^[A-Za-z0-9._:-]+$/, …)`，接到 `reportSchema` 的 `report_id` 上。引号、反斜杠、空格在入口就按 400 挡下，账本里从此只出现不会破坏比对的 id。
3. 证据与回归：`scripts/fault-inject.ts` 的 `caseEvG211` 增补「带引号的 report_id 连投两次」；同一份证据里可见普通 id 连投四次仍是 report_rejected=1 / report_replayed=1 / report_applied=0，带引号 id 两次都是 HTTP 400（PAYLOAD_SCHEMA_INVALID，点名 report.report_id），事件条数不再增长。`docs/gates/evidence/G2/ev-g2-11.md` 重新生成，两次重跑 sha256 一致（fb72ef55124d1b21…）。

## P2-1 裁决块与正文结论互相打脸时仍然放行

现象：报告正文写「结论：fail」、结构化裁决写 pass，sign-gate 与 gate-check 都放行。

处置：`scripts/gate-check.ts` 的 `checkAuditAnchor` 在核对完裁决问题后，再用词法解析器读正文结论；两处都在、且不一致就拒绝（`审计报告正文结论与结构化裁决不符：正文=… 裁决=…`）。正文没写结论时仍以裁决块为准，不凭空造结论。

## 顺带收掉 S1 第 29 轮的三条 P2（同一处代码，一并加固）

- 多个裁决块只取第一个：`parseAuditVerdict` 现在要求裁决标记正好一对，多块直接报错，不让「后追加一个 fail 块」或「留着一个旧 pass 块」靠位置决定谁算数。
- `must_pass_ids` 可混入规格外的 id：`verdictProblems` 不再只比条数，逐个 id 必须在门规格清单里，混进来的点名报出。
- 有裁决块时正文结论不参与判定：已由上面的 P2-1 处置覆盖（现在参与一致性核对）。

## 验证

- `node node_modules/typescript/bin/tsc --noEmit` → exit 0。
- `node node_modules/vitest/vitest.mjs run` → 36 文件 / 518 passed | 1 skipped（跳过者为预签态下的「G1 门记录通过」），exit 0。
- 新增回归：`tests/integration/apply-report.spec.ts` 两例（带引号 id 的 applied/rejected 各一）、`tests/contract/routes.spec.ts` 一例（三种非法 report_id 一律 400）、`tests/unit/audit-verdict.spec.ts` 四例（规格外 id、双块三种形态）。
- 预签态照旧：门记录未签时 gate-check 停在 audit_report_sha256 占位值上，符合口径。

## 待办

- 本轮改了候选范围内的文件（证据 ev-g2-11 与源码），需要新候选提交，并由新一轮独立审计在这份候选上重出一份 pass 报告；G1 同样要按新候选重审。
- 两份 pass 报告回来后再按「先 G1 后 G2」的顺序重签，双门 exit 0 与全量绿齐了才开 S3。
