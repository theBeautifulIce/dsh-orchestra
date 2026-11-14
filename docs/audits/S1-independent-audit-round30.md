# S1 独立审计 第 30 轮（G1 门）

门：G1
候选提交：51cf4d3f89a774d3d2ddfc77fc333fffc33da1c3

- 审计对象：D:\aboutAI\dsh-orchestra，S1 账本地基门 G1（SQLite 单写者 + CAS + Ga/Gr 双代次 + append-only ledger + evidence gate）。
- 候选说明：任务书写的候选 51cf4d3531f0a74c9d8b1a31f4f0c5be8d2e0a71 与 `git rev-parse HEAD` 读到的 51cf4d3f89a774d3d2ddfc77fc333fffc33da1c3 不一致；按任务口径以真实 HEAD 为准，绑定行、裁决与全文均用真实 HEAD。
- 只读边界：本轮没有改源码、证据、门记录，没有 git add / git commit 主仓任何文件。全部攻击在 `%TEMP%\audit30-clone` 的独立克隆里做。
- 预签态：主仓 G1.md 的 audit_report_sha256 是 0*64 占位，`node scripts/gate-check.ts docs/gates/G1.md` 停在「审计报告 sha256 与记录不符：0000000000000000… != 50ba1b13cdf1b84d…」，属任务书说明的设计状态；克隆里按「提交报告 → 改门记录轮次与报告路径 → sign-gate → 提交 → gate-check」走完，基线 exit 0。

## 实测数字

| 项目 | 结果 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | exit 0，无输出 |
| `node node_modules/vitest/vitest.mjs run`（全量） | 36 个文件，518 passed / 1 skipped（519），exit 0；skip 为预签态下 `tests/gate/gate-check.spec.ts` 的 it.skipIf |
| 定向回归（g1 + apply-report + routes + audit-verdict） | 4 个文件，99 passed，exit 0 |
| G1 六条注入 `tests/integration/g1.spec.ts` | 6 passed，exit 0（G-01/G-02/G-08/G-09/G-14/G-15） |
| 13 份 G1 证据按 HEAD 字节、LF 归一重算 | 13/13 与证据索引一致（见下表） |
| 克隆基线整门 | sign-gate exit 0；gate-check exit 0：「gate G1 通过（13 项必过、13 份证据哈希复核）」；candidate=6b711202392e…，artifact_hash=193c484d239b…，body_hash=fb2ec500e4af… |

## 必过项核对（13/13）

| 编号 | 内容 | 判定 | 实测依据 |
| --- | --- | --- | --- |
| G1-01 | 迁移空库可重复 | pass | ev-migrate，migrate.spec 全绿 |
| G1-02 | 迁移中途杀可重入 | pass | ev-g14，g1.spec G-14 通过 |
| G1-03 | 进程杀不丢已提交事件 | pass | ev-g02，g1.spec G-02 通过 |
| G1-04 | 备份独立目录行数与哈希一致 | pass | ev-backup，backup.spec 全绿 |
| G1-05 | 损坏备份可检出 | pass | ev-g15，g1.spec G-15 通过 |
| G1-06 | 认证拒匿名写 | pass | ev-auth，auth.spec 全绿 |
| G1-07 | 阶段开关拒未知值 | pass | ev-phase，config.spec 全绿 |
| G-01 | 事务 COMMIT 前杀进程 | pass | ev-g01，g1.spec 通过 |
| G-02 | COMMIT 后未投递被杀 | pass | ev-g02，g1.spec 通过 |
| G-08 | 长事务期间读不被拖死、写报 busy、队列溢出报 503 | pass | ev-g08，g1.spec 通过 |
| G-09 | 订阅者离线重放 | pass | ev-g09，g1.spec 通过 |
| G-14 | 迁移一半杀后重跑 | pass | ev-g14，g1.spec 通过 |
| G-15 | 备份截断能检出、恢复被拒、线上库不变 | pass | ev-g15，g1.spec 通过 |

## 证据复核（HEAD 原像，CRLF→LF 后 sha256）

| 证据 | 文件 | sha256 |
| --- | --- | --- |
| ev-auth | `tests/contract/auth.spec.ts` | `d8593aff1f15ecd5755a922ae4a8c6374aa2a6272ec54d5143ad63563ff8130f` |
| ev-backup | `tests/integration/backup.spec.ts` | `3c1b2f975dc4807ff5cff2ec5d0d0cca4ba05a5d547007d86bfcaeb1b2207a8f` |
| ev-chain | `tests/integration/hash-chain.spec.ts` | `cf2d60dd505da107a9c643522b8c1e3781a6919d9c0bc08ac2fc4f3e64b48628` |
| ev-epoch | `tests/integration/db-open.spec.ts` | `19be1852c1fbf69f4499c347851ed9c6fc7738ccca56ef741e5b0a7fe1d8d6aa` |
| ev-g01 | `docs/gates/evidence/G1/G-01.md` | `f2626b30f9eb472f1268b71047893be8f1d42a933438e43cd30af35d3318a129` |
| ev-g02 | `docs/gates/evidence/G1/G-02.md` | `5fedb2e7539b1d410b7ff3c964ea36d77764fd037c4f4e40badbd67b7038b196` |
| ev-g08 | `docs/gates/evidence/G1/G-08.md` | `2f2a73ddbf25fb59ea9b650635499856e66c94dcde81fca1a12ea3d424176c87` |
| ev-g09 | `docs/gates/evidence/G1/G-09.md` | `e944a2b6bd299faed3f9ce98c72647ceb8580eaae412a997d7be6cdcc5376625` |
| ev-g14 | `docs/gates/evidence/G1/G-14.md` | `7869d3d1c5b84ad267a9ca304c6420abdfd3597deb3c9f2119129331f56f0bc2` |
| ev-g15 | `docs/gates/evidence/G1/G-15.md` | `334f26fb748d4013bdb0243f4a0e9d4ddd1e573fc4071114d9dffc0bb7dc03a3` |
| ev-gatecheck | `tests/gate/gate-check.spec.ts` | `8f525ce218816eb2a335a01680f8695b3b243110e8ff71bf6ffafaf592163df2` |
| ev-migrate | `tests/integration/migrate.spec.ts` | `1fda9f8fb0294c082f92d46920409cdbe277473dd67b55d0226fa7c542cea362` |
| ev-phase | `tests/unit/config.spec.ts` | `1702657cdb40d65c3a91cf9eac4fe196a9eb2ecea8e54293e44db4f37c9a39aa` |

主仓 G1.md 表内仍是更早候选的旧值（13f123… / 8b8d… / e15b… 等），属预签态遗留；克隆里 sign-gate 会按 HEAD 全量回写，回写后与上表逐项一致。

证据可重生成性：在克隆里对 `scripts/fault-inject.ts --case G-01/G-02/G-08/G-09/G-14/G-15` 逐条重跑，G-01/G-02/G-08/G-09 重生成后与 HEAD 内容一致（仅 CRLF 归一差异）；G-14、G-15 重生成后内容变化（见 P2-3）。

## 本轮修复验证

1. S2 第三十四轮 P1-1（report_id 带引号判重失效）：已修。`countReportEvent` 用 `json_extract(payload, '$.report_id')` 结构化比对，`reportIdentifier` 只放行 `[A-Za-z0-9._:-]`。定向用例 9 条全过：引号/反斜杠 report_id 在 HTTP 入口 400 并点名 `report.report_id`；引号 id 重复上报只落 1 条 applied + 1 条 report_replayed；重复被拒只落 1 条 report_rejected。残余观察：同一 report_id 换不同 reason 仍可再追加一条 report_rejected（reason 是有限枚举，不构成无限膨胀，未单列 P2）。
2. S2 第三十四轮 P2-1（正文结论与结构化裁决一致）：只修住单行正式结论。单行「结论：fail」+ 裁决 pass 已被拦住（A9）；但正文写两行正式结论（A10），或写一句「本次审计未通过。」（A11），`auditConclusionOf` 返回 null，checkAuditAnchor 的一致性比对被整体跳过，门照样签过（P2-1）。
3. S1 第二十九轮三条 P2：多裁决块已拦（A7，报「裁决块必须正好一个」）；规格外 id 已拦（A16，报 G1-99）；正文结论参与一致性的入口已接上，但只在结论可解析时生效（同上 A10/A11）。
4. 新缺口：must_pass_ids 重复项 + total/passed 同步改成 14 时，verdictProblems 只查 total==ids.length，不查 total 等于门规格项数、也不查 id 去重；13 项全列再重复一个 G1-01，门签过（P2-2）。

## 攻击面结果

| 攻击 | 处置 | 证据（错误信息） |
| --- | --- | --- |
| A1 改证据、不重签 | 拦截 | 候选提交之后，候选文件又被改过：docs/gates/evidence/G1/G-01.md |
| A2 改证据后重签 | 拦截 | 候选提交之后，候选文件又被改过：docs/gates/evidence/G1/G-01.md |
| A3 门正文结论 pass→fail | 拦截 | 门记录正文结论与 GateArtifact 不符：正文=**fail**，artifact=pass |
| A4 删一行必过项 | 拦截 | 正文必过项表有 12 行，artifact 有 13 项 |
| A5 必过项结果改 fail | 拦截 | 门记录正文结论与 GateArtifact 不符 |
| A6 报告换绑旧候选 59fe18d | 拦截 | 候选提交之后，候选文件又被改过：docs/gates/evidence/G2/ev-g2-11.md |
| A7 追加第二个裁决块 | 拦截 | 裁决块必须正好一个（2 个开始、2 个结束标记） |
| A8 裁决 conclusion 写非法值 | 拦截 | conclusion 只能是 pass 或 fail |
| A9 正文单行结论 fail + 裁决 pass | 拦截 | 审计报告正文结论与结构化裁决不符：正文=**fail**，裁决=pass |
| A10 两行正式结论（fail + pass）+ 裁决 pass | 放行 | sign-gate exit 0，gate-check exit 0（artifact_hash=c5d63eef5795…） |
| A11 正文「本次审计未通过。」+ 裁决 pass | 放行 | sign-gate exit 0，gate-check exit 0（artifact_hash=2d3806595e65…） |
| A15 13 项再重复 G1-01、total/passed=14 | 放行 | sign-gate exit 0，gate-check exit 0（artifact_hash=e81d9d89b676…） |
| A16 must_pass_ids 混入 G1-99 | 拦截 | must_pass_ids 里有门规格之外的项：G1-99 |
| A17 报告文件名轮次 99 对 audit_round 30 | 拦截 | audit_round 与审计报告的轮次不一致: 30 != 99 |
| A18 换绑 ev-g01 到 G-02.md | 拦截 | 正文证据表里 ev-g01 的文件与 artifact 不一致 |
| A14a 门记录正文脏改、不重签 | 拦截 | 工作树有未提交改动，门记录不能对着脏树签 |
| A14b 候选文件改动后不重签 | 拦截 | 候选提交之后，候选文件又被改过：src/core/audit-verdict.ts |
| report_id 引号/反斜杠走 HTTP | 拦截 | 400 PAYLOAD_SCHEMA_INVALID，path=report.report_id |
| 同 report_id 同因重投（含引号 id） | 拦截 | applied=1/replayed=1；rejected=1，事件不膨胀 |
| 门记录与 HEAD 漂移（磁盘/提交两侧） | 拦截 | 脏树检查与候选改动检查分别命中 |

## 发现

- P2-1：正文结论与结构化裁决的一致性仍可绕过。`auditConclusionOf` 只允许一行正式结论，遇到第二行结论或任一可见否决句就返回 null；`checkAuditAnchor` 在 prose 为 null 时跳过比对，于是「正文说未通过、裁决说 pass」的报告能签过（A10、A11）。
- P2-2：`verdictProblems` 没有把 `must_pass_total` 钉到门规格项数，也没有查 `must_pass_ids` 去重；13 项全列后再重复一个 id、total/passed=14 能签过（A15）。
- P2-3：G-14、G-15 两份证据与 HEAD 不可重生成。G-14 记录「表数 14→16、schema_migrations=[1,2,3,4,5,901,902]」，在 HEAD 重跑得到 15→17、[1,2,3,4,5,6,7,901,902]；G-15 记录的备份路径未归一成 `<tmp>`，线上库 sha 从 ca48b472d6da 变为 538e922ada53。两条注入的核心断言仍然成立，但证据文件没有随候选更新，重生成会改动字节。

## 结论

结论：pass（0 P0 / 0 P1 / 3 P2；必过 13/13，失败项为空）

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 30,
  "candidate_commit": "51cf4d3f89a774d3d2ddfc77fc333fffc33da1c3",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 3,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": ["G1-01", "G1-02", "G1-03", "G1-04", "G1-05", "G1-06", "G1-07", "G-01", "G-02", "G-08", "G-09", "G-14", "G-15"],
  "failed_items": [],
  "notes": "13/13 必过；report_id 判重已修；正文与裁决一致性、必过清单去重仍有 P2 绕过；G-14/G-15 证据重生成漂移"
}
```
<!-- audit-verdict:end -->
