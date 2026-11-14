# S2 门 G2 第 36 轮独立审计报告

门：G2
候选提交：0e2274fff1a62ea0457cbeb804e2e887142af88e
审计轮次：36
审计者：agent-6（独立审计，未参与本轮实现）
审计时间：2026-11-14（Asia/Shanghai）

结论：pass

P0 = 0，P1 = 0，P2 = 3（三条都不阻断签署）；必过项 19 / 19 实测通过，失败项为空。

## 一、审计范围与工作树断言

- 仓库 `D:\aboutAI\dsh-orchestra`，真实 HEAD `0e2274fff1a62ea0457cbeb804e2e887142af88e`（"Fix evidence reproducibility and prose-verdict clashes"），前两提交 51cf4d3、59fe18d。node 用 `D:/NodeJs/node.exe`，pnpm 不可用。
- 审计开始时 `git status --porcelain` 输出为空。结束时受跟踪文件仍无改动；未跟踪项只有并行 S1 审计交来的 `docs/audits/S1-independent-audit-round31.md`（非本轮产物）与本报告，符合“只写这一个文件”的约定。
- 门记录 `docs/gates/G2.md`；规格 `scripts/gate-check.ts` 的 `GATE_SPECS.G2`：items 19 条、scopeBase=`4f3ada7`、requireVerdict=true、excludes 为 docs/audits、docs/gates/G1.md、docs/gates/G2.md、docs/reviews、handoff.md；证据目录 `docs/gates/evidence/G2/` 实有 19 份（G-03 / G-04 / G-05 / G-07 与 ev-g2-01…ev-g2-15）。
- 破坏性验证全部在克隆 `%TEMP%\g2-audit-clone`（`git clone --no-hardlinks`，node_modules 以 junction 指向主仓）与 `%TEMP%\attacks` 下进行；主仓只新增本报告。

## 二、必须实测的命令（主仓）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | 0 | 无类型错误 |
| `node node_modules/vitest/vitest.mjs run` | 0 | Test Files 37 passed (37)；Tests 524 passed \| 1 skipped (525)；Duration 9.28s |
| `node --experimental-strip-types --no-warnings scripts/check-evidence-repro.ts` | 0 | 证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致 |
| 克隆内 `node --no-warnings scripts/sign-gate.ts docs/gates/G2.md` | 0 | 重签完成：证据 19 份，artifact_hash 与 body_hash 均重算后通过 selfCheck |
| 克隆内 `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` | 0 | gate G2 通过（19 项必过、19 份证据哈希复核） |

补充说明：跳过的一条是 `tests/gate/gate-check.spec.ts:55` 的 `it.skipIf(PRE_SIGNED)('G1 门记录通过')`；当前 G1/G2 都处于待重签的预签态，跳过它是设计行为，同一 describe 里“门记录没签时必须被拒绝”那条照常执行并通过。

## 三、独立复现：不看脚本自述，自己跑生成器比对 HEAD

- 自写 `%TEMP%\audit-repro.mjs`：对 G2 的 19 个案例逐个调用 `scripts/fault-inject.ts --case <name> --out <tmpA|tmpB>`，同一案例连跑两遍（A、B 两个临时目录），再与 `git show HEAD:docs/gates/evidence/G2/<case>.md` 的字节比对。结果 **19 / 19 满足 A == B == HEAD**，总耗时约 17.1s（ev-g2-14 单例约 6.6s，其余约 0.5–0.7s）。
- 同一脚本对 G1 的 6 个案例（G-01 / G-02 / G-08 / G-09 / G-14 / G-15）做同样比对：**6 / 6 满足 A == B == HEAD**。合计 25 份全部字节可复现，门记录“重跑字节不变”的承诺成立，且这是我自己跑生成器得出的结论，不是复读脚本输出。
- 在主仓用 `--out` 临时目录单跑 ev-g2-01：exit 0，生成字节与 HEAD 一致，跑完 `git status --porcelain` 仍为空（生成器不写仓库）。
- 交叉验证：把克隆里 `docs/gates/evidence/G2/ev-g2-13.md` 追加一行后 commit，`check-evidence-repro.ts` exit 1，输出“证据复现不成立（1/26 份）……重跑与 HEAD 字节不一致，证据已漂移，重生成并重签”；同态下 sign-gate exit 1、gate-check exit 1（报“审计报告的候选提交之后，候选文件又被改过，不能复用这份报告”）。守卫与门禁双层都能抓漂移，且重签吞不掉证据改动。

## 四、本轮整改逐条核对

### 4.1 P1-1（S2 第三十五轮）：租约 TTL 冲突与证据不可复现

- 源码：`scripts/fault-inject.ts` 已无 `leaseTtlMs: 600000`。现存租约值：injectQueued 30000（:390）、G-05 120000（:490）、ev-g2-02/05/06/09/10/11/13/15 均 120000（:725 / :766 / :878 / :963 / :1025 / :1112 / :1325）、ev-g2-03 故意过期 1000（:1066）、ev-g2-14 心跳 2000 + 续租 500（:1289），全部不超过 `src/service/schemas.ts:8,18` 的 `leaseTtlMsMax: 120000`。600000 只剩 G-07 的 jump_ms（:574）与 ev-g2-09 的墙钟跳变（:905、:931），与租约无关。
- 归一：`writeEvidence`（:83-104）四区块共用 shared 映射；`normalizeEvidence`（:48-81）归一 ISO 时间→`<ts>`、`线上库 sha <hex>`→`线上库 sha <db_sha>`、evt_/lease_/tsk|run|nrun|dec_ 按首次出现编号、临时路径 scrubPath→`<tmp>/文件名`；normalizeRevision 仅 ev-g2-14 使用。
- 结论：这一条整改真实成立（源码 + 25 份字节复现双证）。附带发现见 P2-3（复现测试注释写“全量 35 份”，实测集合为 25 份）。

### 4.2 P2-1（S2 第三十五轮 P2-1 / S1 第三十轮 P2-1）：正文与裁决一致性

- `scripts/gate-check.ts:2096-2166` 的 `checkAuditAnchor` 已不再用“auditConclusionOf 返回 null 就跳过”的老写法：有裁决块时先 `verdictProblems`，再 `proseVerdictClashes(text, conclusion, spec.items)`（:2137-2140）；无块且 requireVerdict 时直接拒。
- `proseVerdictClashes`（:1445-1471）覆盖三类背离中的前两类与散文形态的第三类：结论行多于一条、唯一结论行与裁决相反、散文把某个必过项写成未通过——攻击 A1/A2/A3 全部被拒（见第五节）。
- 但第三类在**表格单元格**里仍可绕过（A4/A5 放行），根因见 P2-1：`proseVerdictClashes` 只把 `prose` 传给后续扫描，`rendered.cells` 被丢弃。这是本轮唯一的实质发现，按同类历史定级记 P2、不阻断。

### 4.3 S1 第三十轮 P2-2：必过项清单灌水

- `src/core/audit-verdict.ts:150-185` 的 `verdictProblems` 现在同时检查：total == ids.length、ids 无重复、total == ctx.requiredItems.length（门规格项数）、ids 全部落在规格内、规格项无遗漏。攻击 A6（重复 + 漏项）、A7（total=20 而 ids 19）、A8（混入规格外 id）全部被拒，错误文案见第五节。

### 4.4 S1 第三十轮 P2-3：G-14 / G-15 断言与归一

- G-14（`scripts/fault-inject.ts:315-342`）先 applySteps(901)，再 applySteps([901,902])，断言 applied 数量、schema_migrations 记录与表数，并断言第一步不会重复执行；G-15（:344-382）关连接后取线上库 sha、做 backup、截断一半、verifyBackup 必须检出损坏、restore 必须被拒、线上库 sha 不变（`线上库 sha <hex>` 已归一为 `<db_sha>`）。两份证据均在上文 25 份字节复现之列，断言逻辑与迁移表实际步骤一致。

## 五、独立攻击矩阵（克隆内逐条 `git reset --hard` 后重放）

| 编号 | 攻击输入 | 期望 | 实测 |
| --- | --- | --- | --- |
| A1 | 正文两行结论（pass 与相反结论）配 pass 裁决 | 拒 | sign exit 1：“正文出现 2 条结论行（pass、fail），结论必须唯一” |
| A2 | 正文唯一结论行写成相反结论 | 拒 | sign exit 1：“正文结论行是 fail，裁决是 pass” |
| A3 | 散文行把某个必过项写成未通过 | 拒 | sign exit 1：“正文把必过项 G2-05 写成未通过，裁决却是 pass” |
| A4 | 表格单元格把某个必过项写成未通过 | 拒 | **放行：sign exit 0、gate-check exit 0**（P2-1） |
| A5 | 表格结论列写相反结论 | 拒 | **放行：sign exit 0、gate-check exit 0**（P2-1） |
| A6 | ids 19 条但一项重复、另一项缺失 | 拒 | sign exit 1：“must_pass_ids 里有重复项：G2-11；审计没覆盖这些必过项：G2-15” |
| A7 | total=20、passed=20、ids 19 条 | 拒 | sign exit 1：“must_pass_total（20）与 must_pass_ids 的条数（19）不符；……与门规格的必过项数（19）不符” |
| A8 | ids 19 条再塞一条规格外项、total=20 | 拒 | sign exit 1：“must_pass_total（20）与门规格的必过项数（19）不符；……有门规格之外的项：G2-99” |
| A9 | 报告里放两个裁决块 | 拒 | sign exit 1：“裁决块必须正好一个（找到 2 个开始标记、2 个结束标记）” |
| A10 | must_pass_passed=18 | 拒 | sign exit 1：“必过项没过完：18/19” |
| A11 | 两行门名绑定 | 拒 | sign exit 1：“缺少唯一的「门：G1」与「候选提交：<40 位 commit>」绑定行”（错误文案写死 G1，实际门为 G2，属文案问题） |
| A12 | 证据文件改一字节后重签 | 拒 | `check-evidence-repro.ts` exit 1 报漂移；gate-check exit 1 报“候选提交之后候选文件又被改过” |

补充：A4/A5 在签名阶段与门检查阶段都 exit 0，说明旁路贯穿整个签名链路，不是只在 gate-check 单点；根因定位为 `proseVerdictClashes` 在 :1451 只解构出 `prose`。

## 六、历史报告回归（正常 pass 报告不被误伤）

用当前源码对 `docs/audits/` 中带裁决块的历史报告逐一跑 `parseAuditVerdict` + `proseVerdictClashes(报告自己的结论, 对应门的 items)`：

| 报告 | 裁决 | 告警数 | 结论 |
| --- | --- | --- | --- |
| S1-independent-audit-round29.md | pass | 0 | 不误伤 |
| S1-independent-audit-round30.md | pass | 0 | 不误伤 |
| S1-independent-audit-round31.md（并行 S1 本轮报告） | pass | 0 | 不误伤 |
| S2-independent-audit-round34.md | 相反结论 | 2 | 函数未按 verdict 分支，见 P2-2；因该报告结论本身被 `verdictProblems` 先拒，不影响门禁 |
| S2-independent-audit-round35.md | 相反结论 | 3 | 同上 |
| 本报告 | pass | 0 | 克隆重签后 gate-check exit 0 复核 |

另外，单元级阳性对照：纯 pass 报告 0 告警；散文写“某项未通过”1 条；两行结论 1 条；结论行相反 1 条；表格形态 0 条（即 P2-1）。`tests/gate/gate-check.spec.ts:1390-1411` 的三条用例（两行结论、必过项写成未通过、只讲历史轮次不误伤）与实测一致。

## 七、发现（按级别，均不阻断）

### P2-1 表格单元旁路：正文与裁决一致性只扫散文，漏掉表格

- 现象：把“某个必过项未通过”或相反结论写进 Markdown 表格单元格，裁决块保持 pass，sign-gate 与 gate-check 都 exit 0。
- 根因：`scripts/gate-check.ts:1450-1451`，`const visible = rendered.lines.map(stripHistoricalAuditSentence)` 之后 `const { prose } = splitProseAndCells(visible, rendered.cells)`，后续结论行统计（:1456-1462）与必过项扫描（:1463-1469）都只遍历 `prose`。同文件 `auditConclusionOf`（:1404 附近）与 `bodyConclusionOf`（:1475）对 `tableCells` 调 `cellFailStatement`，表格否定在别处是拦得住的，唯独新函数漏了。
- 影响：不伪造证据、不改候选文件，也不改变四哈希与 19 份证据复算结果；只是让“正文自述”这类防御性检查出现一个可绕过的入口。由于放行依据是报告 sha 钉住的结构化裁决块，实质结论不会被悄悄改写，故不阻断本轮签署。
- 建议：`proseVerdictClashes` 除 prose 外对 `rendered.cells` 调 `cellFailStatement`，命中即报；并在 `verdict === 'fail'` 时跳过必过项扫描（见 P2-2）。建议随下一轮补齐并加两条回归用例（A4/A5 形态）。

### P2-2 告警未按 verdict 分支，相反结论报告被自相矛盾地告警

- 现象：对结论为相反值的报告，函数仍输出“正文把某个必过项写成未通过，裁决却是 fail”（round34 两条、round35 三条），语义自相矛盾。
- 根因：:1463-1469 的必过项扫描没有 `if (verdict === 'pass')` 前置。
- 影响：零门禁影响（相反结论在 `verdictProblems` 的 `:159` 就被拒，轮不到这段）；只影响报错可读性。
- 建议：与 P2-1 一并修，顺手加断言。

### P2-3 复现测试注释与实测集合不一致

- `tests/integration/evidence-repro.spec.ts:8` 注释写“全量 35 份走 scripts/check-evidence-repro.ts”，而 `scripts/check-evidence-repro.ts:12-15` 的 CASES 实为 G1 6 份 + G2 19 份 = 25 份；该 spec 本身只守 G-01 与 ev-g2-11 两例。
- 影响：仅注释漂移，不影响执行结果与门禁；但会让后来者误判覆盖面，建议改为 25 份或改为引用 CASES 长度。

## 八、签署建议

- 本轮 19 条必过项全部实测通过，证据 19 份逐份重算哈希与 HEAD 一致，独立复现 25 / 25 字节不漂移，tsc 与全量测试全绿；P0/P1 为零，P2 三条都不阻断。
- 建议按既定顺序重签：先 G1 后 G2；把本报告提交后，G2.md 的 audit_round 置 36、audit_report 指向 `docs/audits/S2-independent-audit-round36.md`，再跑 sign-gate 与 gate-check。克隆内已用本报告原文完整走通：sign exit 0、gate-check exit 0（19 项必过、19 份证据复核）。
- 遗留：P2-1 的表格旁路建议在下一轮修复；修好后重跑 A4/A5 两条攻击，确认转为拒绝。

## 附录 A：必过项 19 条实测覆盖

| 必过项 | 断言要点 | 本轮实测 |
| --- | --- | --- |
| G2-01 | 单节点 queued 到终态一条路径 | 通过 |
| G2-02 | 重复上报只落一次 | 通过 |
| G2-03 | 租约过期迟到上报被拒 | 通过 |
| G2-04 | 取消后不产生新 attempt | 通过 |
| G2-05 | 终态必带证据（ev-g2-05 / ev-g2-10） | 通过 |
| G2-06 | 无裸 blocked | 通过 |
| G2-07 | S2 加载 parallel 被拒 | 通过 |
| G-03 | 同一 report_id 两次只落一次 | 通过 |
| G-04 | 租约到期原执行器迟到上报被拒 | 通过 |
| G-05 | 工具执行中取消只立一次围栏 | 通过 |
| G-07 | 墙钟跳变不误判截止（ev-g2-09 / ev-g2-g07） | 通过 |
| G2-08 | 工具失败不许落完成 | 通过 |
| G2-09 | 判定时限只认 boot_id 与单调纳秒 | 通过 |
| G2-10 | 报告入口系统级证据门 | 通过 |
| G2-11 | 反复重投同一 report_id 不许把账本刷膨胀 | 通过 |
| G2-12 | 工具授权只认 workflow 定义 | 通过 |
| G2-13 | 单写者锁与 epoch 围栏 | 通过 |
| G2-14 | 长动作心跳续租 | 通过 |
| G2-15 | 同一工作流版本跨重启不可改写 | 通过 |

逐条依据：19 份证据文件本身在 25 份字节复现之列；证据内容抽样已读（ev-g2-05 三报 started/verifying/done 与 evidence_missing、ev-g2-09 四类超时/不确定/verify_human、ev-g2-10 伪造强证据 evidence_unverifiable 与弱来源 verification_too_weak、ev-g2-14 2.5s 扫描 lease_expired=0、G-05 两次取消只 fence_armed 一次且围栏期间上报被拒、G-07 墙钟跳变场景），与门记录断言一一对应。

## 附录 B：证据清单（19 份）

G-03.md、G-04.md、G-05.md、G-07.md、ev-g2-01.md … ev-g2-15.md。门记录证据表 19 行与 `evidence-index` 块一致，gate-check 逐份按 HEAD 字节（LF 归一）重算 sha256 全部命中。

<!-- VERDICT-BEGIN -->
{
  "gate": "G2",
  "audit_round": 36,
  "candidate_hash": "0e2274fff1a62ea0457cbeb804e2e887142af88e",
  "conclusion": "pass",
  "must_pass_total": 19,
  "must_pass_ids": ["G2-01","G2-02","G2-03","G2-04","G2-05","G2-06","G2-07","G-03","G-04","G-05","G-07","G2-08","G2-09","G2-10","G2-11","G2-12","G2-13","G2-14","G2-15"],
  "failed_items": [],
  "p0": 0,
  "p1": 0,
  "p2": 3,
  "audit_report_sha256": ""
}
<!-- VERDICT-END -->

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 36,
  "candidate_commit": "0e2274fff1a62ea0457cbeb804e2e887142af88e",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 3,
  "must_pass_total": 19,
  "must_pass_passed": 19,
  "must_pass_ids": ["G2-01","G2-02","G2-03","G2-04","G2-05","G2-06","G2-07","G-03","G-04","G-05","G-07","G2-08","G2-09","G2-10","G2-11","G2-12","G2-13","G2-14","G2-15"],
  "failed_items": [],
  "notes": "P2 三条均不阻断：表格单元一致性旁路、fail 分支告警措辞、复现注释份数漂移。"
}
```
<!-- audit-verdict:end -->
