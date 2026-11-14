# S1 第三十轮审计对照表

- 审计报告：docs/audits/S1-independent-audit-round30.md（候选 51cf4d3f89a774d3d2ddfc77fc333fffc33da1c3）
- 本轮结论：pass（P0=0 / P1=0 / P2=3，13 项必过 13/13，失败项为空）
- 审计在克隆里走通 sign-gate exit 0 与 gate-check exit 0（artifact_hash=098cae9dd2ff…），tsc exit 0，全量 36 文件 518 passed / 1 skipped。

## P2-1 裁决与正文一致性仍可绕过（与 S2 第三十五轮 P2-1 同一处）

审计确认上一轮已把单行正式结论修住，但 A10（正文写两行结论）与 A11（正文把必过项写成「未通过」）仍能签过。

处置：新增 `proseVerdictClashes(text, verdict, requiredItems)`，把三类背离一律拒绝：结论行不唯一、结论行与裁决相反、必过项被写成未通过。`checkAuditAnchor` 用它替换掉「`prose` 为 null 就跳过」的旧写法。没有要求「pass 时正文必须解析出 pass」，因为真 pass 报告（S1 第二十九轮报告表格里提到「结论：fail」）会被误伤；定向三类背离对全部历史报告回归零误伤。

## P2-2 必过项清单可与门规格脱钩

现象：`verdictProblems` 只看 `must_pass_total` 与 `must_pass_ids.length` 是否相等，不查该值是否等于门规格项数，也不查 id 是否重复。重复列同一个 id 把 `total` 抬到 14 就能签过。

处置：两条都加在 `src/core/audit-verdict.ts` 的 `verdictProblems`：

- 重复 id：`v.must_pass_ids.filter((id, i) => v.must_pass_ids.indexOf(id) !== i)` 非空即报「must_pass_ids 里有重复项」。
- 总数对规格：`v.must_pass_total !== ctx.requiredItems.length` 报「must_pass_total（X）与门规格的必过项数（Y）不符」。

回归用例在 `tests/unit/audit-verdict.spec.ts`。

## P2-3 G-14 / G-15 证据不可重生成

- G-14：断言写死「15 张表」，而迁移已加到 006 / 007（表数 16→17…）。处置：迁移集合与表数断言改成跟着实际迁移表算，重跑后证据稳定。
- G-15：备份路径落的是绝对临时目录、库文件 sha 每次不同。处置：`writeEvidence` 的路径归一变通用（临时目录前缀 → `<tmp>/<basename>`，db 与 backup 都覆盖）；`normalizeEvidence` 把「线上库 sha <hex>」归一成「线上库 sha <db_sha>」，保留结论句「线上库未变：true」。归一后连跑两遍字节一致。

## 顺带收掉 S2 第三十五轮的 P1-1（同一处夹具）

`scripts/fault-inject.ts` 八处 `leaseTtlMs: 600000` 改成 120000，与 `src/service/schemas.ts` 的上限对齐；G1 六份证据（G-01 / G-02 / G-08 / G-09 / G-14 / G-15）已重生成并同步到门记录表。

## 新增守卫

- `scripts/check-evidence-repro.ts`：25 个案例各跑两遍，比对两遍之间与 HEAD 的字节，不一致逐条点名 exit 1。
- `tests/integration/evidence-repro.spec.ts`：G-01 与 ev-g2-11 进全量套件，守住「重跑出同样的字节」。

## 验证

- `node node_modules/typescript/bin/tsc --noEmit` → exit 0。
- 全量 vitest 与门记录自校验结果见提交说明；预签态下 gate-check 停在 audit_report_sha256 占位值上，符合口径。

## 待办

- 新候选 → 重派 S1 第三十一轮与 S2 第三十六轮；两份 pass 后按固定顺序重签 G1、G2，双门 exit 0 + 全量绿才开 S3。
