# S1 独立审计 · G1 · 第 49 轮

- 门：G1
- 候选提交：ce8c2e64360de9a3b057cced13432352971ec719
- 候选标题：feat(r3): enforce node run chain guards in sqlite
- 审计日期：2026-11-14
- 审计方式：只读。clone 位于 `D:\aboutAI\dsh-orchestra\tmp\audit-s1-r49`；主仓未动，未运行 `sign-gate.ts`，未提交。
- 候选说明：`git log -1` 与任务描述一致；`git status --porcelain` 初始为空。任务背景称候选在 `41a450f` 之上，实测父提交是 `9872cb5`（`41a450f` 在 5 个提交之前），候选内容仍为 R3 链头保护，按 HEAD 字节审计。

## 一、命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | Done in 3s |
| `pnpm typecheck` | 0 | `tsc --noEmit` 无输出 |
| `pnpm test` 第 1 次 | 0 | 42 files passed、619 passed、1 skipped（620） |
| `pnpm test` 第 2 次 | 0 | 42 files passed、619 passed、1 skipped（620） |
| `pnpm test` 第 3 次 | 0 | 42 files passed、619 passed、1 skipped（620） |
| `pnpm build` | 0 | ESM `lib/index.js` 152.57 kB、DTS 14.30 kB、CJS 0.29 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致 |
| 桥闭环 6 文件第 1 次 | 0 | 6 files passed、70 passed（70） |
| 桥闭环 6 文件第 2 次 | 0 | 6 files passed、70 passed（70） |
| `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` | 1 | 预期失败：G1.md 记录仍是第 48 轮、候选锚在旧提交，见 P2-1 |
| `node --experimental-strip-types tmp/probe1.ts` | 0 | 证据 13 份、迁移链、独立事务、G-14 复算 |
| `node --experimental-strip-types tmp/probe1b.ts` | 0 | 正文与 artifact 哈希、候选哈希复算 |
| `node --experimental-strip-types tmp/probe1c.ts` | 0 | 旧库升级、011→012、G-14 语义复算 |
| `node --experimental-strip-types tmp/probe2.ts` | 0 | 012 攻击矩阵、事务原子性、payload |
| `node --experimental-strip-types tmp/probe3.ts` | 0 | 两进程并发向同一链追加 30 条 |
| `node --experimental-strip-types tmp/probe4.ts` | 0 | undefined / null payload |

桥闭环命令的 6 个文件：`tests/integration/agent-lifecycle.spec.ts`、`tests/integration/bridge-ledger.spec.ts`、`tests/unit/bridge-buffer.spec.ts`、`tests/integration/runtime.spec.ts`、`tests/e2e/production-path.spec.ts`、`tests/contract/execution-concurrency.spec.ts`。

## 二、结论

结论：pass（13 项必过项全部通过，P0 为 0、P1 为 0，P2 两项已列明）。

## 三、13 项必过项逐项复核

| 必过项 | 要求 | 代码与测试落点 | 证据 | 结论 |
| --- | --- | --- | --- | --- |
| G1-01 | 迁移空库可重复 | `src/infra/db/migrate.ts` 按 `schema_migrations` 跳过已执行步；`tests/integration/migrate.spec.ts`；probe1 实测 fresh apply=[1..12]、reapply=[] | ev-migrate | 通过 |
| G1-02 | 迁移中途杀可重入 | `src/infra/sqlite/driver.ts` 的 `execSchema` 每步独立 `withTx`；probe1c 实测只补 [902] | ev-g14 | 通过 |
| G1-03 | 进程杀不丢已提交事件 | `src/infra/sqlite/driver.ts`（WAL、`synchronous=FULL`、`withTx` 提交）；G-02 故障注入在 COMMIT 后、投递前杀进程 | ev-g02 | 通过 |
| G1-04 | 备份独立目录行数与哈希一致 | `src/infra/backup.ts`；`tests/integration/backup.spec.ts`「备份目录里有库与清单，每张表行数哈希与线上一致」 | ev-backup | 通过 |
| G1-05 | 损坏备份可检出 | `src/infra/backup.ts` 的清单校验与 `verifyBackup`；`backup.spec.ts`「截断备份库」「改清单里某张表的 rows」 | ev-g15 | 通过 |
| G1-06 | 认证拒匿名写 | `src/service/server.ts` 认证中间件与主体派生；`tests/contract/auth.spec.ts`「POST /v1/ledger/events 匿名写 → 401」 | ev-auth | 通过 |
| G1-07 | 阶段开关拒未知值 | `src/core/config.ts`；`tests/unit/config.spec.ts`「未知 phase（S7）→ SCHEMA_VERSION_UNSUPPORTED」 | ev-phase | 通过 |
| G-01 | 事务 COMMIT 前杀进程 | `driver.ts` 的 `withTx` 异常回滚；`tests/integration/db-open.spec.ts`「withTx 内抛错时整笔回滚」；故障注入 killAt=COMMIT 之前 | ev-g01 | 通过 |
| G-02 | COMMIT 后未投递被杀 | `src/executor/bridge.ts` 与 `bridge-ledger.ts` 的 outbox 与回执恢复；`tests/integration/bridge-ledger.spec.ts`；故障注入 killAt=COMMIT 之后、投递之前 | ev-g02 | 通过 |
| G-08 | 长事务期间读不被拖死、写报 busy、队列溢出报 503 | `src/service/write-queue.ts` 队列满抛 `SERVICE_UNAVAILABLE`；`src/service/server.ts` 读路径与写队列分离；`tests/contract/execution-concurrency.spec.ts` | ev-g08 | 通过 |
| G-09 | 订阅者离线重放 | `src/service/queries/cursor.ts`、`list_events.ts`；证据实测离线后重放拿到 seq=2、3、4 且连续无断号 | ev-g09 | 通过 |
| G-14 | 迁移一半杀后重跑 | `migrate.ts` 每步独立事务；probe1c 实测 901 先提交、重跑只补 [902]，表数 18→20，与证据一致 | ev-g14 | 通过 |
| G-15 | 备份截断能检出、恢复被拒、线上库不变 | `src/infra/backup.ts` 恢复前校验；`backup.spec.ts`「恢复到新文件：内容一致，线上库字节与哈希不变」 | ev-g15 | 通过 |

逐项看：13 项都能在候选 HEAD 的代码与测试里找到对应断言，没有只靠历史结论转抄的项。G1-03 与 G-02 共用 ev-g02，但要求不同：前者看已提交事件不丢，后者看提交后未投递的重放，证据里两条账本对账分别成立。

## 四、13 份证据逐份重算

按 HEAD 字节、CRLF→LF 归一后重算 sha256，与 `docs/gates/G1.md` 正文证据表和 artifact 的 evidence-index 条目逐份比对：

| 证据 | 文件 | 重算 sha256 | 与 G1.md 正文表 | 与 artifact 索引 |
| --- | --- | --- | --- | --- |
| ev-auth | `tests/contract/auth.spec.ts` | d8593aff1f15ecd5755a922ae4a8c6374aa2a6272ec54d5143ad63563ff8130f | 一致 | 一致 |
| ev-backup | `tests/integration/backup.spec.ts` | 3c1b2f975dc4807ff5cff2ec5d0d0cca4ba05a5d547007d86bfcaeb1b2207a8f | 一致 | 一致 |
| ev-chain | `tests/integration/hash-chain.spec.ts` | cf2d60dd505da107a9c643522b8c1e3781a6919d9c0bc08ac2fc4f3e64b48628 | 一致 | 一致 |
| ev-epoch | `tests/integration/db-open.spec.ts` | 19be1852c1fbf69f4499c347851ed9c6fc7738ccca56ef741e5b0a7fe1d8d6aa | 一致 | 一致 |
| ev-g01 | `docs/gates/evidence/G1/G-01.md` | f2626b30f9eb472f1268b71047893be8f1d42a933438e43cd30af35d3318a129 | 一致 | 一致 |
| ev-g02 | `docs/gates/evidence/G1/G-02.md` | 5fedb2e7539b1d410b7ff3c964ea36d77764fd037c4f4e40badbd67b7038b196 | 一致 | 一致 |
| ev-g08 | `docs/gates/evidence/G1/G-08.md` | 2f2a73ddbf25fb59ea9b650635499856e66c94dcde81fca1a12ea3d424176c87 | 一致 | 一致 |
| ev-g09 | `docs/gates/evidence/G1/G-09.md` | e944a2b6bd299faed3f9ce98c72647ceb8580eaae412a997d7be6cdcc5376625 | 一致 | 一致 |
| ev-g14 | `docs/gates/evidence/G1/G-14.md` | afb074b7fe5a087fb62d9f720503a672e21c02e266fca458c6166eeebe8ae18c | 一致 | 一致 |
| ev-g15 | `docs/gates/evidence/G1/G-15.md` | 1699f60368dd5b07e0771f20e3d689b38f7af11afb9dfe9587529248098b24a0 | 一致 | 一致 |
| ev-gatecheck | `tests/gate/gate-check.spec.ts` | ed7e65aeeec5cc158b79c95e98cc14963fe2913fbc72f464a9080704890bb5c3 | 一致 | 一致 |
| ev-migrate | `tests/integration/migrate.spec.ts` | 376dc6d6e087619429b78b91678e88bc686cee95f0593805ca01d8dcba4df0aa | 一致 | 一致 |
| ev-phase | `tests/unit/config.spec.ts` | 1702657cdb40d65c3a91cf9eac4fe196a9eb2ecea8e54293e44db4f37c9a39aa | 一致 | 一致 |

13/13 与正文表一致；正文表的 id、文件路径、哈希逐行可对上。`check-evidence-repro.ts` 另把 25 份证据各重跑两遍，字节都与 HEAD 一致。

## 五、G1.md 自锚复核

| 项 | 重算或读取 | 记录值 | 判定 |
| --- | --- | --- | --- |
| candidate_hash | 70af7dd41096a47746201869c808716dd7ef2499aa5eca4776b7f8e598f70f22（HEAD、179 文件） | 014d1fca3a07e54e5f1e24647907ab2bed85ac2ccd0d51f2696d7f7f10a050a2 | 不一致 |
| change_scope_hash | 61d43ab2ddf33a5e2382302eb81ea73b03ba2eaea991a60b5450cadb59cec836 | c78155bd02a65987a2200f0faf56bf03e80671e01a2fad83a5acfe6866770dff | 不一致 |
| evidence_index_hash | 98395bc8bbd61b4b55835983c0da2d2fcf92832038fcafc05b0046294534a0ff | de737e221caff322706e510dc8b67fe34f471ec7cdf2fdf2203c2ff08ba8b905 | 不一致 |
| invariants_hash | 6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6 | 6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6 | 一致 |
| artifact_hash | 6a6c010ed83d67ccb0953632dec46c85c9542d16bcd25a995b89ab14708df9d0 | 6a6c010ed83d67ccb0953632dec46c85c9542d16bcd25a995b89ab14708df9d0 | 一致 |
| body_hash | 2dd809aa943c4c3f015df4e4cc259b6f0c466f63826e5d834f8bab7e4ccd20f7 | f2e028fbfb022c026a99b127dff1a31bc6264b6a31f9ba5da7979770152fc31e | 不一致 |

对照 `9872cb5` 的 G1.md：evidence_index_hash 重算等于 de737e22…、body_hash 重算等于 f2e028…，第 48 轮记录当时自洽。`git diff 9872cb5..ce8c2e6 -- docs/gates/G1.md` 只有两处变化：ev-g14 表行哈希 d655af7e…→afb074b7…，以及 artifact 的证据索引行同步同一值；artifact 的 evidence_index_hash、body_hash、candidate_hash、change_scope_hash 没有随之重算。故 `gate-check.ts docs/gates/G1.md` 对 HEAD exit 1，报「审计报告的候选提交之后，候选文件又被改过：codebasemap.md」。这是门记录未重签，不是代码缺陷，列入 P2-1，由本轮重签收口。

## 六、001–012 迁移链

- 版本清单 [1..12] 连续，无断号；名字依次为 init、s2_agent_loop、s2_round3、workflow_versions、append_only_events、tool_executions_tool_seq、node_run_events_append_only、bridge_event_receipts、bridge_tool_outbox、bridge_handled_seq、workflow_version_identity、node_run_chain_guard。
- 空库一次应用 applied=[1..12]，再跑 applied=[]，schema_migrations 为 1..12，表数 18。
- 每步独立事务：先应用 1..6，再跑一个含 `CREATE TABLE probe_tx` 与非法 SQL 的 999 步；抛 `near "THIS": syntax error` 后 probe_tx 不存在、schema_migrations 无 999、前 6 步完整；把 999 改成合法 SQL 重跑只补 [999]。
- 012 共 4 条语句，全部是 `CREATE TRIGGER IF NOT EXISTS`：事件 INSERT 守卫、链头 INSERT 守卫、链头 UPDATE 守卫、链头 DELETE 守卫。没有 CREATE TABLE、ALTER、INSERT OR REPLACE 或回填；应用 012 前后表清单不变（18 表），触发器 +4。
- 旧库升级：001–006 下手工写两条链式事件（chainHash 计算），应用 7..12 后链头回填 {last_seq:2、event_count:2、last_hash 等于尾事件哈希}，verifyLedger ok=true；直接插 seq=5 被拒，随后 appendNodeRunEvent 正常得到 seq=3，再验 ok=true。
- 011→012：只应用 [12]，事件与链头逐字节不变，verify ok=true，直接插 seq=9 被拒，链头仍 {last_seq:2、event_count:2}。
- G-14 语义复算：全量迁移后 beforeTables=18；先独立提交 901 的 half_a，再 applySteps([901,902]) 只补 [902]，schema_migrations=[1..12,901,902]，表数 18→20；注入前与恢复后的账本都是 `1 task.created evt_1`，与证据正文一致。

## 七、012 守卫攻击矩阵

探针在临时库上按真实 schema 执行，每条攻击都记录实际异常消息：

| 编号 | 攻击 | 预期 | 实测 |
| --- | --- | --- | --- |
| A1 | 正常追加首条 | 允许，seq=1、零哈希 | 通过，seq=1 |
| A2 | 正常追加第二条 | 允许，prev 接首条 | 通过，prev 相等、hash 重算相等 |
| A3 | 正常追加第三条 | 允许，链头 last_seq=3、event_count=3、last_hash=尾哈希 | 通过，三项全对，verifyLedger ok |
| A4 | 直接 INSERT 跳号 seq=5 | 拒 | 拒：node_run_events 必须接在链头之后 |
| A5 | 直接 INSERT 错误 prev_hash | 拒 | 拒：同上 |
| A6 | 无链头插 seq=2 | 拒 | 拒：新链必须从 seq=1 的零哈希开始 |
| A7 | 无链头 seq=1 但 prev 非零 | 拒 | 拒：同上 |
| A8 | 无链头插 seq=0 | 拒 | 拒：node_run_events 必须接在链头之后 |
| A9 | DELETE 链头 | 拒 | 拒：链头只由追加维护，不许删除 |
| A10 | UPDATE 链头 last_seq 跳到 4 | 拒 | 拒：链头序号必须逐条递增 |
| A11 | UPDATE 链头 last_seq 退回 1 | 拒 | 拒：同上 |
| A12 | UPDATE 链头只改 event_count+2 | 拒 | 拒：链头序号必须逐条递增（先命中序号分支） |
| A13 | 补一条合法 seq=3 事件后，UPDATE last_seq=3、event_count=4 | 拒 | 拒：链头条数必须逐条递增 |
| A14 | UPDATE last_seq=3 且 last_hash 改成无对应事件的值 | 拒 | 拒：链头更新缺少对应事件 |
| A15 | UPDATE 同时改 node_run_id 到别的链 | 拒 | 拒：链头更新缺少对应事件 |
| A16 | INSERT 新链头但没有 seq=1 首条事件 | 拒 | 拒：新链头缺少对应的首条事件 |
| A17 | INSERT 新链头 last_seq=2 | 拒 | 拒：新链头必须恰好对应首条事件 |
| A18 | INSERT OR REPLACE 覆盖已有链头 | 拒 | 拒：新链头必须恰好对应首条事件 |
| A19 | 事件 INSERT ... ON CONFLICT DO UPDATE | 拒 | 拒：必须接在链头之后 |
| A20 | 事件 INSERT OR REPLACE | 拒 | 拒：必须接在链头之后 |
| A21 | DELETE 事件行 | 拒 | 拒：node_run_events 只追加 |
| A22 | UPDATE 事件行 | 拒 | 拒：node_run_events 只追加 |
| A23 | 删链头后 appendNodeRunEvent | 拒，不得凭事件补写 | 拒，SCHEMA_VERSION_UNSUPPORTED；链头仍 0，事件仍 2，verify ok=false 且报「链头记录缺失」 |
| A24 | 删事件守卫触发器后插 seq=4 错链 | 允许（DDL 已移除守卫），但 verify 必须检出 | 结构放行；verify ok=false，报 prev 不接、条数不符、链尾序号不符、链尾哈希不符 |
| A25 | 伪造结构合法链（seq=1、零 prev、自填 hash 与链头） | 结构层允许，verify 必须检出 | 结构层接受；verify ok=false，报「hash 对不上，内容被改过」 |
| A26 | 空对象 payload / 256 KiB payload / 深嵌套 payload | 允许且链保持正确 | 三条 seq=1、2、3，链头 event_count=3，verify ok |
| A27 | undefined payload | 拒且整笔回滚 | 拒：NOT NULL constraint failed（调用方四处均传对象，不可达） |
| A28 | null payload | 序列化为 "null"，链正确 | 通过，verify ok |

攻击后复查：A4–A22 全部结束后链头仍是 {last_seq:2、event_count:2}，verify ok=true，说明被拒的语句没有留下半条记录。A23 在删守卫触发器的前提下模拟坏账，应用层没有顺手补写链头。

## 八、事务原子性与并发

- 同一事务内 append 后抛错：回滚，事件 0 条、链头 0 条。
- 新链首次 append 时链头 INSERT 失败：事件与链头都回滚为 0 条。
- 已有链头时 append 的链头 UPDATE 失败：新事件回滚（事件仍 1 条）、链头 last_seq 仍 1；移走故障触发器后追加得到 seq=2，verify ok=true。
- 两进程并发向同一链各追加 15 条（共 30 条）：全部成功，seq 为 1..30 连续、无重复，hash 无重复，链头 last_seq=30、event_count=30、last_hash 等于尾哈希，verifyLedger ok=true、gaps 为空。`BEGIN IMMEDIATE` 加 `busy_timeout=5000` 让两个写事务串行，读-算-写没有丢更新。

## 九、P0 / P1 / P2

P0：无。

P1：无。

P2-1 门记录未重签：`docs/gates/G1.md` 的 artifact 仍指向第 48 轮候选，evidence_index_hash、body_hash、candidate_hash、change_scope_hash 与 HEAD 字节不符（见第五节）。门检查对 HEAD exit 1 属预期；本轮重签时同步 artifact 与报告即可，代码与证据无问题。

P2-2 数据库守卫的残余边界：012 只校验结构（序号、prev、链头投影），无法校验 HMAC；能用 DDL 删除触发器的人可以插入结构合法但哈希伪造的事件。探针 A24、A25 证明这两种情况都会被 verifyLedger 检出（hash 对不上、prev 不接、条数与链尾不符），所以防线是「触发器拦直写 + verifyLedger 兜底 + 进程内唯一写入口」，不是单靠触发器。建议在 012 的注释或规格里点明这条边界，避免后来者把触发器当成密码学校验。

## 十、裁决

候选 `ce8c2e6` 的 R3 改动与任务描述一致：012 四个触发器覆盖事件 INSERT、链头 INSERT/UPDATE/DELETE；`appendNodeRunEvent` 先读链头再写、链头缺失但已有事件时拒绝补写、按有无链头分开 INSERT/UPDATE 规避 UPSERT 误触发；旧库回填与升级后守卫生效均已实测。13 项必过项 13/13 通过，全量测试三次一致，证据复现成立，P0/P1 为空。

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 49,
  "candidate_commit": "ce8c2e64360de9a3b057cced13432352971ec719",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 2,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": ["G1-01", "G1-02", "G1-03", "G1-04", "G1-05", "G1-06", "G1-07", "G-01", "G-02", "G-08", "G-09", "G-14", "G-15"],
  "failed_items": [],
  "notes": "R3 的 012 链头守卫与 appendNodeRunEvent 行为全部符合预期，13/13 通过；P2-1 是 G1.md artifact 未随 ce8c2e6 重算，须本轮重签同步；P2-2 是触发器不校验 HMAC、可被 DDL 移除的残余边界，由 verifyLedger 兜底并已用探针确认可检出。"
}
```
<!-- audit-verdict:end -->
