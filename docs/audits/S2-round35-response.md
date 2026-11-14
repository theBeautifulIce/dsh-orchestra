# S2 第三十五轮审计对照表

- 审计报告：docs/audits/S2-independent-audit-round35.md（候选 51cf4d3f89a774d3d2ddfc77fc333fffc33da1c3）
- 本轮结论：fail（P0=0 / P1=1 / P2=1，19 项必过行为全部成立，failed_items 为空）
- 说明：审计任务书里写的 51cf4d3531f0a74c9d8b1a31f4f0c5be8d2e0a71 在仓库里不存在，审计按真实 HEAD 绑定，已在报告里写明。这里记一条教训：派单前先 `git rev-parse HEAD` 取真值，不手抄哈希。

## P1-1 证据复现契约不成立（本轮唯一阻断项）

现象：在 51cf4d3f89a774d3d2ddfc77fc333fffc33da1c3 的干净克隆里逐案例重跑 `scripts/fault-inject.ts`，19 份 G2 证据只有 6 份字节一致（ev-g2-07 / ev-g2-11 / ev-g2-12 / ev-g2-13 / ev-g2-14、G-03），12 份不一致，ev-g2-09 直接 exit 1（`STALE_GENERATION`，details `{"what":"transitionNode","changes":0}`，scripts/fault-inject.ts:878）。而门记录正文（第 11 行、第 92 行）承诺「重跑字节不变」。

根因：`scripts/fault-inject.ts` 有八处 `leaseTtlMs: 600000`（:477、:712、:753、:865、:950、:1012、:1099、:1312）。`src/service/schemas.ts` 的租约上限在 59fe18d 收紧成 120000，HTTP 直接回 400「拿租约校验没过：leaseTtlMs 大于上限 120000」，节点停在 queued，后续上报全部 status_mismatch。证据是旧夹具生成的，重跑立刻露馅。

处置四件：

1. 八处夹具 `600000` → `120000`，与 `DEFAULT_LEASE_TTL_MS` 和入参上限对齐，不再各写一套。
2. 重生成 25 份证据（G1 六份 + G2 十九份），连跑两轮逐字节比对，确定性成立。与 HEAD 相比有 10 份变化：G1 的 G-14、G-15；G2 的 G-04、G-05、G-07、ev-g2-01、ev-g2-03、ev-g2-05、ev-g2-08、ev-g2-10。其余 15 份沿用旧字节。
3. 归一化补齐两处环境噪声：`writeEvidence` 的路径归一变通用（以临时目录为前缀的绝对路径一律写 `<tmp>/<basename>`，db 与 backup 两个键都覆盖）；`normalizeEvidence` 把 `线上库 sha <hex>` 归一成 `线上库 sha <db_sha>`——sqlite 页布局带随机盐，同一场景重跑文件 sha 不会相同，它能证明的只是「前后一致」，所以留结论句「线上库未变：true」，不留具体值。
4. 新增复现守卫：`scripts/check-evidence-repro.ts` 把 25 个案例各跑两遍，既比两遍之间、也比 `git show HEAD:<file>`，不一致逐条点名 exit 1；`tests/integration/evidence-repro.spec.ts` 取 G-01 与 ev-g2-11 两条快的进全量套件，守住底线。

## P2-1 一致性检查可绕过

现象：`checkAuditAnchor` 里写的是 `const prose = auditConclusionOf(text); if (prose && prose !== parsed.verdict.conclusion) throw`。`auditConclusionOf` 不可判定时返回 null，整段检查静默跳过。实测两种绕过都成立：A7 正文两行结论（结论 pass / 结论 fail）配裁决 pass；A8 正文写「G2-11 未通过」配裁决 pass。

处置：新增导出函数 `proseVerdictClashes(text, verdict, requiredItems)`，三类背离一律点名拒绝：

- 正文出现两条以上结论行（`正文出现 N 条结论行（…），结论必须唯一`）；
- 只有一条且与裁决相反（`正文结论行是 X，裁决是 Y`）；
- 正文把必过项写成未通过（`正文把必过项 … 写成未通过`）。

没有简单要求「裁决 pass 时正文必须解析出 pass」——实测真 pass 报告 docs/audits/S1-independent-audit-round29.md 因表格里提到「结论：fail」也会返回 null，严格相等会误伤真实报告。改成定向三类背离后，全部历史报告回归：只有 fail 报告与攻击载荷命中，r29 零命中。

## 顺带收掉 S1 第三十轮的两条 P2（同一处判定代码）

- P2-2：`verdictProblems` 增加「`must_pass_total` 必须等于门规格项数」与「`must_pass_ids` 不许重复」，重复列同一 id 把总数抬高的签法从此签不过。
- P2-3：G-14 的迁移集合与表数断言改成跟着实际迁移表走；G-15 的备份路径与库 sha 归一（见上），两份证据重生成后可复现。

## 验证

- `node node_modules/typescript/bin/tsc --noEmit` → exit 0。
- `node node_modules/vitest/vitest.mjs run` → 见下节提交前实测（含新增 evidence-repro 用例）。
- `node --no-warnings scripts/check-evidence-repro.ts` → 25 份证据逐案例两遍 + 对 HEAD，全部一致。
- 门记录：G1.md 与 G2.md 正文证据表与 artifact 证据 sha256 已同步到新字节（G1 改 6 处、G2 改 18 处），并各补一段本轮整改叙述、复现命令加上复现守卫。

## 待办

- 新候选提交后用真值重派 S1 第三十一轮与 S2 第三十六轮独立审计；两份都 pass 才按「先 G1 后 G2」重签，双门 gate-check exit 0 + 全量绿才开 S3。
