# S1 独立审计报告（第 29 轮）

门：G1
候选提交：59fe18d53c554c788cb04437bffbd5f2df76ad4e

## 一、审计范围与执行方式

- 审计对象是 `59fe18d53c554c788cb04437bffbd5f2df76ad4e`（HEAD）上的 S1 证据门实现与证据，未依赖门记录或 handoff 的自述结论。
- 全程只读：除本报告外未写任何已跟踪文件；攻击性验证在 `%TEMP%` 的独立克隆里完成，临时目录已删除，主仓工作树除本报告外无改动。
- 实际执行并记录结果：`node node_modules/typescript/bin/tsc --noEmit`（exit 0，1.4s，无输出）；`node node_modules/vitest/vitest.mjs run --reporter=dot`（exit 0，36 个文件 511 passed / 1 skipped，4.31s；1 skipped 为 `tests/gate/gate-check.spec.ts` 预签态 `it.skipIf(PRE_SIGNED)` 用例，符合口径）；主仓预签态 `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` 报「审计报告 sha256 与记录不符（0000… != 50ba1b13…）」，正是预签态先撞审计锚点的预期行为；克隆里补签后 `gate-check` exit 0。
- 13 份证据按 `scripts/gate-check.ts:303-304` 同款口径（从 HEAD 取字节、CRLF 归一为 LF 后 sha256）逐份重算，与克隆中重签后的记录表 13/13 一致。
- 预签态说明：主仓 G1.md 的 candidate_hash 与证据表仍是上一候选遗留（59fe18d 调整了证据路径但未重签），`sign-gate.ts` 会按 HEAD 全量回写候选哈希、证据表、evidence_index_hash、artifact_hash 与 body_hash。这一点按已知事实处理，不计缺陷。

## 二、必过项逐项核对

| 项号 | 验收要求 | 核对了什么 | 结论 |
| --- | --- | --- | --- |
| G1-01 | 迁移空库可重复 | `src/infra/sqlite/driver.ts:97` `execSchema` 每步独立事务、已执行步骤不重跑、checksum 不符报 `SCHEMA_VERSION_UNSUPPORTED`；`src/infra/db/migrate.ts:48` `applySteps`；`tests/integration/migrate.spec.ts` 断言空库首跑建齐核心表、第二次返回空数组 | pass |
| G1-02 | 迁移中途杀可重入 | `scripts/fault-inject.ts` G-14 子进程执行 901 后被杀，`tests/integration/g1.spec.ts` 断言重跑只返回 `[902]`、`schema_migrations` = 基础版本 + `[901,902]`；证据 `docs/gates/evidence/G1/G-14.md` 与之一致 | pass |
| G1-03 | 进程杀不丢已提交事件 | `src/infra/db/ledger.ts` `appendNodeRunEvent` 在同一事务里写事件与链头；fault-inject G-02 子进程 COMMIT 后被 SIGKILL，`listEvents(fromSeq=before)` 仍取回 `evt_committed`，证据 G-02.md 记录 before/after | pass |
| G1-04 | 备份独立目录行数与哈希一致 | `src/infra/backup.ts:31-51` 备份写到独立目录并附 `manifest.json`（`db_sha256` + 10 张表的行数与摘要）；`tests/integration/backup.spec.ts` 断言目录含 `orchestra.db`/`manifest.json`、行数与线上一致、`db_sha256` = 备份库 sha | pass |
| G1-05 | 损坏备份可检出 | `src/infra/backup.ts:53-82` `verifyBackup` 先核库文件 sha256 再逐表核行数与摘要；`tests/integration/backup.spec.ts` 断言截断库报 `SERVICE_UNAVAILABLE` 且 `details.table='(db_file)'`、改行数报 `table='tasks'`、缺清单报 `(manifest)` | pass |
| G1-06 | 认证拒匿名写 | `src/service/server.ts:82-92` 从 `x-orchestra-secret` 取认证主体，缺失/不符均 401 `UNAUTHORIZED`，actor 由密钥派生、忽略 body 自报；`tests/contract/auth.spec.ts` 断言匿名/错密钥 401、对密钥 200、匿名写账本 401 | pass |
| G1-07 | 阶段开关拒未知值 | `src/core/config.ts` Zod 严格 schema + superRefine（未知键、非法值、高水位/缓冲关系），未知 phase 报 `SCHEMA_VERSION_UNSUPPORTED` 并带 issues 路径；`requirePhase` 越阶段抛 `FORBIDDEN`；`tests/unit/config.spec.ts` 覆盖 S7、busy_timeout、buffer_high_water、能力表 | pass |
| G-01 | 事务 COMMIT 前杀进程 | `src/infra/sqlite/driver.ts` `withTx` 用 `BEGIN IMMEDIATE` + 异常 `ROLLBACK`；fault-inject G-01 子进程 BEGIN+INSERT 后 READY 即被 SIGKILL，读回 `events` 条数不变，证据 G-01.md 记 before=after=1 | pass |
| G-02 | COMMIT 后未投递被杀 | fault-inject G-02 子进程 COMMIT 后被杀，README/证据记录 `evt_committed` 与 `inject.g02` 可被重放取回；链头与事件同事务提交（`src/infra/db/ledger.ts`） | pass |
| G-08 | 长事务期间读不被拖死、写报 busy、队列溢出报 503 | `src/service/write-queue.ts:1-32` 队列上限 1000、溢出抛 `SERVICE_UNAVAILABLE`、不阻塞读；fault-inject G-08 记录长事务期间只读 count>0、第二连接 `BEGIN IMMEDIATE` 报 busy、HTTP 队列 1 第二笔 503 且 warning 原文「写队列满了，拒掉这一笔写」 | pass |
| G-09 | 订阅者离线重放 | `src/service/queries/list_events.ts:7` `listEvents(fromSeq,limit)`；fault-inject G-09 离线追加 3 条后从 cursor 重放，`seq` 连续无断号，证据 G-09.md 记 seq2-4 | pass |
| G-14 | 迁移一半杀后重跑 | `src/infra/db/migrate.ts:48` `applySteps` 每步独立事务；fault-inject G-14 记录 `schema_migrations` 恢复为 `[1..5,901,902]`、表数 14→16，重跑只补未完成的那一步 | pass |
| G-15 | 备份截断能检出、恢复被拒、线上库不变 | `src/infra/backup.ts:84-88` `restore` 先 `verifyBackup` 再复制到新文件；fault-inject G-15 记录截断后 verify/restore 均抛错、线上库 size 与 sha 不变（`ca48b472d6da`） | pass |

## 三、证据文件哈希复核

| 证据 | 文件 | 重算 sha256（LF 归一） |
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

补充：克隆中重签后的 artifact 为 conclusion=pass、audit_round=29、candidate_hash=`865066ba9e0217f8…`、change_scope_hash=`e513efa7e0f1416a…`、evidence_index_hash=`98325d4558df5a16…`、invariants_hash=`6f75465bfb0ecf3a…`、previous_artifact_hash 为 64 个 0；artifact_hash 与 body_hash 由脚本重算后回写，`gate-check` exit 0。

## 四、攻击性验证

克隆里以「改文件 → commit → 跑 sign-gate 重签 → gate-check」为主协议（能重签的攻击才有意义），辅以不重签的直接篡改。结果如下：

| 攻击 | 期望 | 实测 |
| --- | --- | --- |
| 改证据 G-01.md 追加字节，不重签 | 拦下 | 拦下：证据 sha256 不符 / 候选文件被改过 |
| 删必过项表一行，不重签 | 拦下 | 拦下：正文必过项 12 行 ≠ 记录 13 项 |
| 必过项内容列改一个字，不重签 | 拦下 | 拦下：正文内容与固定口径不一致 |
| 删证据表一行，不重签 | 拦下 | 拦下：正文证据表 12 行 ≠ 13 份 |
| artifact.candidate_hash 改全 0 | 拦下 | 拦下：artifact_hash 与正文不符 |
| 改 src/core/config.ts，不重签 | 拦下 | 拦下：候选文件被改过 |
| 删证据文件 G-15.md | 拦下 | 拦下：证据固定映射缺项 / 候选被改 |
| artifact.gate 改为 G2 | 拦下 | 拦下：必过项清单不符 |
| 门记录正文结论 pass→fail，不重签 | 拦下 | 拦下：正文结论与 artifact 不符（gate-check.ts:2203） |
| 报告正文「结论：fail」+ 裁决块 pass，重签 | 拦下 | **放行**：正文结论在裁决块存在时完全不参与判定（P2-1） |
| 裁决块 conclusion=fail，重签 | 拦下 | 拦下：结构化裁决不通过（gate-check.ts:2102） |
| 裁决块 candidate_commit 改旧提交，重签 | 拦下 | 拦下：候选提交不符 |
| 报告绑定行候选提交改旧提交，重签 | 拦下 | 拦下：候选提交不符 / 报告被改 |
| 报告提交后再改证据并重签 | 拦下 | 拦下：commit..HEAD 候选文件非空（gate-check.ts:2126） |
| 裁决块多塞 id G1-99、total/passed=14，重签 | 拦下 | **放行**：只校验门规格项被覆盖，不校验反向包含（P2-2） |
| 报告尾部再追加一个 fail 裁决块，重签 | 拦下 | **放行**：只取第一个裁决块（P2-3） |
| 正文必过项 G1-01 结果改 fail，重签 | 拦下 | 拦下：正文必过项结果非 pass |
| audit_report 指向不存在的 round99 | 拦下 | 拦下：审计报告不在 HEAD |
| 裁决块 candidate_commit 写 7 位短哈希 | 拦下 | 拦下：candidate_commit 必须是 40 位 |
| 报告绑定行与裁决块都改 G2，重签 | 拦下 | 拦下：绑定的门与记录不符 |

## 五、发现

P0 = 0，P1 = 0，P2 = 3。三条都不构成外部第三方绕过路径：需要审计者或签名者本人写入自相矛盾内容，而门记录的字节哈希、证据哈希与候选哈希仍然钉死；按 handoff 惯例记 S3 前置，不阻断本轮。

- **P2-1 报告正文结论与裁决块背离不报错**：`scripts/gate-check.ts:2091-2111` 在解析到合法裁决块后不再调用 `auditConclusionOf`，因此报告正文写「结论：fail」而裁决块写 pass 仍能签名并过门。建议裁决块存在时也要求正文结论为空或等于 `verdict.conclusion`，保持人读与机读一致。
- **P2-2 裁决块可混入门规格之外的必过项**：`src/core/audit-verdict.ts:141` 的 `verdictProblems` 只检查门规格项被覆盖，不检查 `must_pass_ids` 全部属于门规格，也不要求 `must_pass_total` 等于门规格项数；塞入 `G1-99` 并把 total/passed 写成 14 仍可通过。建议补双向集合相等与总数一致。
- **P2-3 多个裁决块时只取第一个**：`extractVerdictJson` 取第一个 begin/end 之间的首个 json 围栏，报告尾部再追加一个 conclusion=fail 的裁决块不影响签名与过门。建议拒绝第二个 begin 或要求恰好一个裁决块。

## 六、结论

结论：pass。13 项必过项逐项核对通过，13 份证据哈希按脚本口径复算一致；tsc 与全量用例通过（预签态 1 skipped 符合口径）；攻击性验证中改证据、改正文、删清单、换候选、伪造裁决等 17 类篡改被拦下，3 类签名者侧防御纵深缺口记为 P2 并移交 S3。

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 29,
  "candidate_commit": "59fe18d53c554c788cb04437bffbd5f2df76ad4e",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 3,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": ["G1-01", "G1-02", "G1-03", "G1-04", "G1-05", "G1-06", "G1-07", "G-01", "G-02", "G-08", "G-09", "G-14", "G-15"],
  "failed_items": [],
  "notes": "13 项必过全过、13 份证据复算一致；P2 三条为签名者侧防御纵深缺口，记 S3 前置，不阻断。"
}
```
<!-- audit-verdict:end -->
