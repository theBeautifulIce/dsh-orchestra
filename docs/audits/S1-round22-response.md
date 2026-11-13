# S1 第二十二轮审计整改对照

- 审计报告：docs/audits/S1-independent-audit-round22.md（结论 fail，P0=4 / P1=1 / P2=2）
- 审计候选：ca2b196e351552b8a055450fb81ed6653aff2197（报告 LF sha256=3bf8f7f1e643e778da6d64228085aadcd13a7ec0b5b44a67bff0a640bcda282b）
- 整改状态：P0-1、P0-2、P0-3、P0-4、P1 已改并补回归；P2-1、P2-2 属于重签前状态，按流程留到双门重签时收口
- 本表不构成放行依据：G1/G2 仍未重签，S2 第二十七轮未回，S3 未开；本报告固定审计 ca2b196，不覆盖 e7a3fa4 与工作区修复

## P0-1 历史整改剥离跨度覆盖本轮陈述（报告正文 7 例）

根因：scripts/gate-check.ts（候选）的 stripHistoricalRemediation 从“上一轮/前一轮/roundN”起，到首个“本轮已整改/已修复/…”止整段删除；当前否定或当前结论落在跨度内时被一并抹掉。

改法：
- scripts/gate-check.ts:865-890 重写 stripHistoricalRemediation：HISTORICAL_REMEDIATION_RES 只负责定位历史段，HISTORICAL_NEG_RE 只截掉历史否定本身（failed to pass / did not pass / 未获批准 / 未能通过 / 未获通过 / 没有通过 / 未获批 / 未达标 / 被否决 / 被驳回 / 未通过 / 不通过 / 没通过 / fail），返回 `match.slice(negative.index + negative[0].length)`，历史否定之后的全部文字保留给统一扫描器。
- 识别不到历史否定时不整段删除，避免豁免范围失控。
- 结果：历史段后的“本轮审计未通过验收”“结论：fail”都会进入 visibleFailStatement。

回归：tests/gate-check.spec.ts:346-369 逐条使用报告给出的 7 条报告正文载荷，全部 `not.toBe('pass')`；其中含换行与“结论：fail”两种形态。

## P0-2 同一剥离跨度覆盖门正文（2 例）

改法：
- scripts/gate-check.ts:940-958 bodyConclusionOf 保留全文扫描（排除裸结论主语，避免“门记录拿结论为 fail”这类历史叙述误杀），再对任意含正式 `结论：` / `結論：` / `判定：` 的行补一次 visibleFailStatement；历史前缀被截掉后行内的“结论：fail”因此能被捕获。
- 门正文写入“上一轮审计未通过，结论：fail，本轮已整改。”时返回 fail，不再与 artifact.conclusion=pass 并存。

回归：tests/gate-check.spec.ts:371-373 两条门正文载荷断言 bodyConclusionOf='fail'。

## P0-3 英文进行时与名词化批准否定（3 例）

根因：FAIL_PASS_STEMS 只到 approve/approved/approval/passing/passed，进行时 approving 的后继字符 i 被尾部守卫挡下；approval 位于否定词之前时谓词位为空。

改法：
- scripts/gate-check.ts:654-687 FAIL_VERDICTS 补 `approval was not granted`、`approval is not granted`、`approval has not been granted`、`approval not granted`、`approval not given`、`not approving`、`isnt approving`、`not granted`、`not given`。
- scripts/gate-check.ts:689-699 FAIL_CONNECTORS 补 `approval`；FAIL_FILLERS 补 `准予`/`被`，FAIL_PASS_STEMS 补 `approving`/`granted`/`granting`/`采纳`/`採納`，FAIL_OBJECTS 补 `通过`/`通過`。

回归：tests/gate-check.spec.ts:357-359 三条英文载荷全部拒绝。

## P0-4 中文批准类结构否定（4 例）

改法：
- scripts/gate-check.ts:654-687 FAIL_VERDICTS 补 `未获批`、`没获批`、`未被批准`、`未准予通过`、`不准予通过`、`未获批通过`；同时把 `准予`、`被` 放进 FAIL_FILLERS，覆盖“未准予通过”“未被批准”这类谓词在第二位的形态。
- 结果：4 条载荷全部返回 null，不再与绑定行的 pass 共存。

回归：tests/gate-check.spec.ts:361 四条中文载荷全部拒绝。

## P1 整改完成度陈述的判定缺口（3 例）

改法：
- scripts/gate-check.ts:637-652 FAIL_SUBJECTS 补裸主语 `本轮`/`本輪`，让“本轮未整改”这类没有“审计”二字的完成度否定有可挂的主语。
- scripts/gate-check.ts:654-687 FAIL_VERDICTS 补 `未完成整改`、`整改未完成`、`未完成修复`、`未整改`、`未修复`、`未收口`。
- 假整改声明在第 1 条截断规则下只保留“实际上本轮未整改”，由上述主语与谓词命中。

回归：tests/gate-check.spec.ts:363-364 三条完成度载荷全部拒绝。

## 安全句与边界

- 历史豁免仍保护真正的历史叙述：`历史记录：上一轮审计未通过，本轮已整改。` 与 `round20 审计结论为 fail，本轮已整改。` 在 tests/gate-check.spec.ts:368-369 仍为 pass。
- 报告里 `未通过项为零`、`P0/P1 已清零` 等清零写法未改词表，tests/gate-check.spec.ts 既有安全句用例全过。
- history-remote-negative-crosspara 仍以结论歧义返回 null 的方式 fail-closed，不改。

## P2-1 预签基线

已知悉：docs/gates/G1.md:75-195 的 artifact/证据索引块与 :11-25 的必过项表仍为预签值；13 份证据中 6 份陈旧，四个锚点与实算有偏差，audit_report_sha256=0*64。按流程在 S1/S2 两份 pass 后用 sign-gate 重签时统一重算，不在本批改代码。

## P2-2 预签噪声

已知悉：11 条用例的首错均为同一 audit_report_sha256 绑定（0000… 对 50ba1b13cdf1b84d…），signed-safe 上 359/359。属于重签前状态，重签后应全绿。

## 本轮验证

- `D:\NodeJs\node.exe node_modules/vitest/vitest.mjs run tests/gate-check.spec.ts -t "S1 第二十二轮 19 条绕过"`：1 passed / 78 skipped。
- tests/gate-check.spec.ts 全量：79 例，68 passed / 11 failed；11 红全部是 G1 预签态，安全句与旧解析器用例无回归。
- `D:\NodeJs\node.exe node_modules/typescript/bin/tsc --noEmit`：exit 0。
- 全量 vitest：32 文件 / 363 例，352 passed / 11 failed；11 红同一预签态。

## 未收口

- S2 第二十七轮报告未回；回来后与新发现一并整改。
- 提交后重派 S1 第二十三轮 / S2 第二十八轮；两份 pass 后重签 G1/G2，双门 exit 0、全量全绿，再开 S3。
- G1/G2 当前不是可放行状态，S3 九节点与状态机继续冻结。
