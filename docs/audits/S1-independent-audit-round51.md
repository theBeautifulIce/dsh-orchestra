# S1 独立审计 · G1 · 第 51 轮

- 门：G1
- 候选提交：68fa92bf9bd6257eedfba6494b654b7de08639e7
- 候选标题：fix(service): sweep wait timeouts in maintenance
- 审计轮次：51
- 审计时间：2026-11-14
- 审计方式：独立 clone `D:\aboutAI\dsh-orchestra\tmp\audit-g1-r51`（detach 到候选提交），只读审计；不改主仓源码、不签门、不提交主仓
- 候选范围：`623939d4c0a7123835b525287035588ee291ccbe..68fa92b`。按 `scripts/gate-check.ts` 的 G1 spec 重算，candidate_hash 覆盖 224 个文件，其中 31 个在 `docs/gates/`；G1.md 第 4 行却声明「排除 docs/gates」。若按声明整体排除 docs/gates，则为 193 个文件 / `82d4c7e5…`。两种口径都记在第五、九节。
- 环境：node v26.13.1；pnpm 用 `C:\Users\ASUS\AppData\Roaming\npm\pnpm.cmd` 直接调用；clone 内 `pnpm install --frozen-lockfile` 成功。

## 一、命令与退出码

| 命令 | 次数 | 观察 | 退出码 |
| --- | --- | --- | --- |
| `git rev-parse HEAD`（主仓） | 1 | `eb19872e4fe1e9267b906fa35c897b9b24b395e0` | 0 |
| `git status --porcelain`（主仓） | 1 | `M docs/gates/G1.md`、`M docs/gates/G2.md`、`M docs/gates/G3.md`，另有 4 个未跟踪 S3 报告 | 0 |
| `git rev-parse HEAD`（clone） | 1 | `68fa92bf9bd6257eedfba6494b654b7de08639e7` | 0 |
| `pnpm install --frozen-lockfile` | 1 | 成功 | 0 |
| `pnpm typecheck` | 1 | `tsc --noEmit` 无错 | 0 |
| `pnpm test` | 1 | 60 files，831 passed \| 1 skipped（832），19.10s | 0 |
| `pnpm build` | 1 | tsdown；ESM `lib/index.js` 201.79 kB、gzip 49.07 kB、`lib/index.d.ts` 16.23 kB | 0 |
| `pnpm exec vitest run tests/integration/g1.spec.ts` | 1 | 6 tests / 6 passed | 0 |
| `node --no-warnings scripts/fault-inject.ts --case G-01 … G-15`（六案，`--out` 到 tmp） | 6 | G-01/G-02/G-08/G-09/G-15 与 HEAD 字节一致；G-14 不一致 | 0 / 0 |
| `node --experimental-strip-types --no-warnings scripts/check-evidence-repro.ts` | 1 | 证据复现不成立（5/30 份） | 1 |
| `node --no-warnings scripts/gate-check.ts docs/gates/G1.md`（clone） | 1 | 「审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：codebasemap.md」 | 1（预签态） |
| 候选重算（G1 spec / 声明口径） | 2 | 224 文件 `5f4e84e6…` / 193 文件 `82d4c7e5…` | 0 |
| 13 份证据 LF 归一 sha256 重算 | 13 | 13/13 与 G1.md 记录一致 | 0 |

## 二、结论

结论：fail。P0 为 0，P1 为 2，P2 为 3。候选代码的全量测试、类型检查与构建都通过，账本只追加、哈希链、链头单写者、事务原子性与备份恢复的断言也是真断言；但 G-14 证据在候选提交上已漂移，且候选范围的实现口径与门记录声明不一致，这两项足以挡住本轮签署。

## 三、13 项逐项结论

| 编号 | 要求 | 落点与观察 | 证据 | 结论 |
| --- | --- | --- | --- | --- |
| G1-01 | 迁移空库可重复 | 001..023 空库全量应用；再跑返回空数组，schema_migrations 不重复（`tests/integration/migrate.spec.ts:38-57`） | ev-migrate | pass |
| G1-02 | 迁移中途杀可重入 | 行为复跑成立：注入 901 半截提交后重跑只补 902，第一步不重复；但门证据 ev-g14 是旧基线，见 G-14 | ev-g14 | fail（证据） |
| G1-03 | 进程杀不丢已提交事件 | G-02：COMMIT 后未投递被杀，恢复后 `2 inject.g02 evt_committed`，重放 fromSeq=1 拿到 1 条 | ev-g02 | pass |
| G1-04 | 备份独立目录行数与哈希一致 | 备份目录逐表行数与内容哈希和线上库对账一致（`tests/integration/backup.spec.ts:47-60`） | ev-backup | pass |
| G1-05 | 损坏备份可检出 | G-15：截断备份被识别，恢复被拒，线上库 sha 与事件数不变 | ev-g15 | pass |
| G1-06 | 认证拒匿名写 | `POST /v1/ledger/events` 匿名 401；错密钥 401；对密钥 200（`tests/contract/auth.spec.ts:61-101`） | ev-auth | pass |
| G1-07 | 阶段开关拒未知值 | 未知 phase `S7`、未知键、越界值均抛 SCHEMA_VERSION_UNSUPPORTED（`tests/unit/config.spec.ts:41-79`） | ev-phase | pass |
| G-01 | 事务 COMMIT 前杀进程 | 注入前/恢复后均 `1 task.created evt_1`；对账 `events 条数=1（期望 1）；未提交事务不留半条记录：true` | ev-g01 | pass |
| G-02 | COMMIT 后未投递被杀 | 恢复后账本 2 条；`重放 fromSeq=1 拿到 1 条：2 evt_committed；总条数 2` | ev-g02 | pass |
| G-08 | 长事务期间读不被拖死、写报 busy、队列溢出报 503 | 读返回 1；队列溢出 SERVICE_UNAVAILABLE；HTTP 第二笔 503；warning 原文一致。busy 断言偏弱，见 P2-1 | ev-g08 | pass（P2） |
| G-09 | 订阅者离线重放 | 离线追加 seq 2/3/4；`重放拿到 seq=2,3,4；连续无断号：true` | ev-g09 | pass |
| G-14 | 迁移一半杀后重跑 | 候选上重跑：`beforeTables=23`、`schema_migrations=[1..23,901,902]`、表数 23→25；HEAD 证据写的是 18、`[1..13]`、18→20 | ev-g14 | fail |
| G-15 | 备份截断能检出、恢复被拒、线上库不变 | 截断检出；`恢复被拒：true；线上库未变：true；线上事件数 1` | ev-g15 | pass |

G1-02 与 G-14 共用 `ev-g14`。行为本身在候选上复跑成立，但门证据记录的是 S3 迁移 014..023 落库前的旧基线，所以这两项作为「门证据成立」判 fail；P1-1 说明处置。

## 四、13 份证据重算（LF 归一 sha256）

| 证据 | 文件 | 重算 | G1.md 记录 | 判定 |
| --- | --- | --- | --- | --- |
| ev-auth | `tests/contract/auth.spec.ts` | `d8593aff1f15ecd5755a922ae4a8c6374aa2a6272ec54d5143ad63563ff8130f` | 同左 | 一致 |
| ev-backup | `tests/integration/backup.spec.ts` | `3c1b2f975dc4807ff5cff2ec5d0d0cca4ba05a5d547007d86bfcaeb1b2207a8f` | 同左 | 一致 |
| ev-chain | `tests/integration/hash-chain.spec.ts` | `cf2d60dd505da107a9c643522b8c1e3781a6919d9c0bc08ac2fc4f3e64b48628` | 同左 | 一致 |
| ev-epoch | `tests/integration/db-open.spec.ts` | `19be1852c1fbf69f4499c347851ed9c6fc7738ccca56ef741e5b0a7fe1d8d6aa` | 同左 | 一致 |
| ev-g01 | `docs/gates/evidence/G1/G-01.md` | `f2626b30f9eb472f1268b71047893be8f1d42a933438e43cd30af35d3318a129` | 同左 | 一致 |
| ev-g02 | `docs/gates/evidence/G1/G-02.md` | `5fedb2e7539b1d410b7ff3c964ea36d77764fd037c4f4e40badbd67b7038b196` | 同左 | 一致 |
| ev-g08 | `docs/gates/evidence/G1/G-08.md` | `2f2a73ddbf25fb59ea9b650635499856e66c94dcde81fca1a12ea3d424176c87` | 同左 | 一致 |
| ev-g09 | `docs/gates/evidence/G1/G-09.md` | `e944a2b6bd299faed3f9ce98c72647ceb8580eaae412a997d7be6cdcc5376625` | 同左 | 一致 |
| ev-g14 | `docs/gates/evidence/G1/G-14.md` | `ec2b935dddae3395997de961e9fee3cec2d77826e67914ac3cb37ea2aafd9052` | 同左 | 字节一致，内容已漂移（P1-1） |
| ev-g15 | `docs/gates/evidence/G1/G-15.md` | `1699f60368dd5b07e0771f20e3d689b38f7af11afb9dfe9587529248098b24a0` | 同左 | 一致 |
| ev-gatecheck | `tests/gate/gate-check.spec.ts` | `ed7e65aeeec5cc158b79c95e98cc14963fe2913fbc72f464a9080704890bb5c3` | 同左 | 一致 |
| ev-migrate | `tests/integration/migrate.spec.ts` | `376dc6d6e087619429b78b91678e88bc686cee95f0593805ca01d8dcba4df0aa` | 同左 | 一致 |
| ev-phase | `tests/unit/config.spec.ts` | `1702657cdb40d65c3a91cf9eac4fe196a9eb2ecea8e54293e44db4f37c9a39aa` | 同左 | 一致 |

哈希一致只证明「门记录与磁盘字节绑定」，不证明「证据内容对候选成立」。G-14 正是后者的反例：哈希对得上，数字对不上。

## 五、G1.md 自锚与候选复核

| 字段 | 候选重算 | G1.md 记录 | 判定 |
| --- | --- | --- | --- |
| candidate_hash（G1 spec） | `5f4e84e60d3b5bfebdf670e883b0196279818bee07cd0f67cbc1ca524f4b072b`（224 文件） | `85dccd92100aab9352184508fb2882f533ce93ea066c0e91c9ffbadbbd305f97`（180 文件，round50/bad3326 的值） | 不符（P1-2、P2-3） |
| change_scope_hash（G1 spec） | `54de2de1b45526d189b8cec5df0a95ea7dcb872cb4e9d9bed2db830a78f3e776` | `0079ed78768fabd7beed450d5a51089508b3118501cdd8d4526005e894d35802` | 不符（P2-3） |
| candidate_hash（声明排除 docs/gates） | `82d4c7e5c3dc2c68eaca788c2c89501695f40d821de033c209fbc793ac916153`（193 文件） | — | 门记录第 4 行的口径 |
| evidence_index_hash | `3ac6049c847e4b02d9b4cfbb9ae0c47ce102985290e2c6d1b21a00642870933b` | 同左 | 一致 |
| invariants_hash | `6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6` | 同左 | 一致 |
| artifact_hash（按工作树 artifact JSON 重算） | `6b059c8ab09be42d881ff1380d42d094d72e1a5d63d75a7ca22c9bf2fa0962ea` | `1c0903777d79bf86ed0ebc6ff54349965dbd4778e429b155b494fba2b7875b97` | 预签态（P2-3） |
| audit_report_sha256 | 工作树指向第 51 轮报告，但记录仍是 `355a1a58…`（第 50 轮报告） | `355a1a582b5584c0c4e0d96be69a651b013021b837b396079642d4c4782996f9` | 预签态（P2-3） |

候选锚点检查：clone 在 68fa92b 上跑 `gate-check`，先报第 50 轮报告绑定的旧候选之后 `codebasemap.md` 又被改过。若第 51 轮报告绑定 68fa92b，而 HEAD 是 eb19872，则 `git diff --name-only 68fa92b..HEAD` 只有 `docs/gates/evidence/G3/full-suite.md`；该路径不在 G1 spec 的 excludes 里（spec 只排 `docs/gates/G1.md`、`docs/gates/G2.md`、`docs/audits`、`docs/reviews`、`handoff.md`），`checkAuditAnchor` 会报同一类错误，`sign-gate` 的 selfCheck 也过不去。这是 P1-2 的可执行证据。

`docs/gates/G1.md` 第 4 行写的是「排除 docs/gates 与 docs/audits」，第 9 行又写 G-14/G-15 由 `check-evidence-repro.ts` 逐案例守着；前者与代码不符，后者与测试覆盖不符（见 P2-2）。

## 六、迁移链

- `src/infra/sqlite/migrations/` 现有 001..023 共 23 个文件，编号连续；`loadSteps` 校验编号连续、文件名合规，checksum 为整文件 sha256。
- `applySteps` 每步一个 `withTx`，迁移语句与 `schema_migrations` 记账同事务；已记录的步骤只校验 checksum 后跳过，不重跑（`tests/integration/migrate.spec.ts:68-80` 断言失败后 `[1]`、修复后 `[1,2]`、`b` 表只在修复后出现）。
- S3 新增 014..023 后，候选库的表数为 23；G-14 注入 901 半截提交、再应用 [901,902] 后表数 23→25。HEAD 的 G-14 证据仍写 18→20，说明它生成于 S3 迁移落库之前，之后没有重生成。
- 结论：迁移机制本身通过；G-14 证据需要重生成，重生成后 `ev-g14` 的哈希、G1.md 证据表与 artifact 都要重签。

## 七、守卫攻击矩阵（独立探针与测试断言）

| 场景 | 观察 |
| --- | --- |
| `UPDATE node_run_events` | 触发器抛「只追加」（`tests/integration/ledger-integrity.spec.ts:51-55`） |
| `DELETE node_run_events` | 触发器抛「只追加」（同文件 57-61） |
| 正常 append 第三条 | seq=3，`verifyLedger().ok=true`（同文件 63-69） |
| `DELETE node_run_chain_heads` | 触发器抛「只由追加维护」（同文件 71-75） |
| `INSERT OR REPLACE node_run_chain_heads` 重置链头 | 013 触发器抛「不能重复插入或替换」，head 仍 `{last_seq:2,event_count:2}`（同文件 77-88） |
| 链头 UPDATE 跳号 2→4 | 抛「链头序号必须逐条递增」（同文件 90-95） |
| 链头 UPDATE 到无事件位置 | 抛「链头更新缺少对应事件」（同文件 97-102） |
| 直接 INSERT 跳号事件 seq=5 | 抛「必须接在链头之后」（同文件 104-110） |
| 链头缺失但账本已有事件 | `appendNodeRunEvent` 抛「链头缺失但账本里已有事件」，`verifyLedger` 为 false（同文件 112-120） |
| 改 payload / 删中间事件 / 换 secret | 哈希链分别报 seq=2 hash 对不上、prev_hash 不接上一条、hash 对不上（`tests/integration/hash-chain.spec.ts:49-101`） |
| epoch 栅栏 | 旧进程写报 `STALE_GENERATION`；新进程正常写（`tests/integration/db-open.spec.ts:65-77`） |
| 写者锁 | 第二把 `acquireDbLock` 报 `ELOCKED`；释放后可再拿（同文件 80-88） |
| `withTx` 内抛错 | 整笔回滚，行数为 0（同文件 92-101） |
| `runCas` 行数不符 | 抛 `STALE_GENERATION`，原值不变（同文件 103-117） |
| 两连接抢写 | 只有一个进得去，另一个按 busy_timeout 报错，表里仍只有 1 行（同文件 119-134） |
| 备份截断 / 清单改行 / 恢复 | 截断报 db_file 损坏；改 rows 报对应表；恢复到新文件后线上库字节与哈希不变（`tests/integration/backup.spec.ts:47-109`） |

这些用例是直接改库或抢连接的真断言，不是「跑过就算」。全量 831 passed 覆盖了它们；本轮的判断分歧只在证据记录是否对候选成立，不在这些守卫代码。

## 八、证据复现与「测试通过」的边界

- 六份 G1 注入证据逐案重跑两遍：G-01、G-02、G-08、G-09、G-15 与 HEAD 字节一致；G-14 不一致。
- G-14 候选重跑：`beforeTables=23`、`schema_migrations=[1,2,…,23,901,902]`、表数 23→25；HEAD 记录：`beforeTables=18`、`[1..13,901,902]`、18→20。
- `scripts/check-evidence-repro.ts` 全量跑出 5/30 漂移：`docs/gates/evidence/G1/G-14.md`、`G2/G-05.md`、`G2/ev-g2-01.md`、`G2/ev-g2-10.md`、`G2/ev-g2-14.md`。本轮只对 G1 负责，但 5/30 说明漂移不是孤例。
- 为什么 `pnpm test` 没拦住：`tests/integration/evidence-repro.spec.ts` 的 CASES 只有 `G1/G-01` 与 `G2/ev-g2-11`；`check-evidence-repro.ts` 需要手工运行，不在 `package.json` 的 `test`/`check` 里。`tests/integration/g1.spec.ts` 的 G-14 用 `loadSteps(defaultMigrationsDir())` 动态拼期望值，迁移集合增长不会失败，也不比对证据文件字节。
- G-08 的 busy 断言用 `busy.length > 0`（`scripts/fault-inject.ts:289`），任何异常都会被记成「报 busy」。本次实测确为 SQLITE_BUSY，但证据本身没有断言错误码，属于弱断言。

## 九、P0 / P1 / P2

- P0：0
- P1-1（阻断，G1-02 / G-14）：G-14 证据在候选提交上不可复现。候选已是 23 个迁移、23 张表，证据仍写 18 / `[1..13]` / 18→20；`gate-check` 只比对已存字节，签下去就会把旧基线当成候选事实。处置：用候选代码重跑 `fault-inject.ts --case G-14`，更新 `docs/gates/evidence/G1/G-14.md`，再跑 `check-evidence-repro.ts`，最后重签 `ev-g14`、证据表与 artifact。G1-02 与 G-14 共用这份证据，故两项都列 failed_items；G1-02 的行为本身已由本轮复跑确认。
- P1-2（阻断，门级绑定）：G1.md 第 4 行声明候选排除 `docs/gates`，`GATE_SPECS.G1.excludes` 却只排 `docs/gates/G1.md`、`docs/gates/G2.md`，候选实际覆盖 31 个 docs/gates 文件（68fa92b 上 224 文件 / `5f4e84e6…`，声明口径应为 193 文件 / `82d4c7e5…`）。候选之后唯一的新提交 eb19872 只改 `docs/gates/evidence/G3/full-suite.md`，于是 `checkAuditAnchor` 与 `sign-gate` 的 selfCheck 都会把它当成「候选文件又被改过」。处置二选一：把 `docs/gates` 加进 G1 spec 的 excludes（改脚本，形成新候选），或把报告改绑 eb19872 并让门记录第 4 行的声明与代码一致；拿本报告直接签 68fa92b 过不了审计锚点。该问题不落在 13 个必过项上，故 failed_items 只列证据项。
- P2-1（不阻断）：G-08 的 busy 只判「有异常」，建议改成断言 `SQLITE_BUSY` / `database is locked` 或错误码，避免其它写失败被误记为 busy。
- P2-2（不阻断）：证据复现守卫覆盖不足。`check-evidence-repro.ts` 覆盖 25 个案例，但 `evidence-repro.spec.ts` 只跑 2 个；脚本未接入 `pnpm test`/`pnpm check`。建议把 25 个案例接进 CI，或在 `g1.spec.ts` 里直接比对 G-14 证据字节。
- P2-3（预签态，不阻断）：主仓 `docs/gates/G1.md` 已把 `audit_round` 改成 51、`audit_report` 指向本轮，但 `candidate_hash` 仍是 85dccd（round50/bad3326）、`artifact_hash` 仍是 1c090（按当前 JSON 重算为 6b059c）、`audit_report_sha256` 仍指第 50 轮报告；工作树还有 G1/G2/G3 三处未提交改动。正式签署前要先把报告与门记录提交到 HEAD，再由 `sign-gate` 重算；`assertClean` 不会放过脏的 docs/gates。

## 十、裁决

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 51,
  "candidate_commit": "68fa92bf9bd6257eedfba6494b654b7de08639e7",
  "conclusion": "fail",
  "p0": 0,
  "p1": 2,
  "p2": 3,
  "must_pass_total": 13,
  "must_pass_passed": 11,
  "must_pass_ids": ["G1-01", "G1-02", "G1-03", "G1-04", "G1-05", "G1-06", "G1-07", "G-01", "G-02", "G-08", "G-09", "G-14", "G-15"],
  "failed_items": ["G1-02", "G-14"],
  "notes": "P1-1：G-14 证据仍是 18 表/[1..13]/18→20 旧基线，候选实为 23 表/[1..23]/23→25，且 check-evidence-repro 报 5/30 漂移；G1-02 与 G-14 共用 ev-g14。P1-2：G1.md 声明排除 docs/gates，G1 spec 实际未排除，68fa92b 候选 224 文件含 31 个 docs/gates，且候选后 eb19872 只改 docs/gates/evidence/G3/full-suite.md，审计锚点与 sign-gate selfCheck 都过不去。P2-1 busy 弱断言；P2-2 复现守卫只覆盖 2/25 且未接入 test；P2-3 预签态哈希未重算。"
}
```
<!-- audit-verdict:end -->
