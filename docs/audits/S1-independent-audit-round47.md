# S1 独立审计报告 · 第 47 轮

门：G1

候选提交：c17a0c76ed342364daf8972684e283290a3fbd00

- 审计角色：S1 独立审计员（只读）
- 主仓：`D:\aboutAI\dsh-orchestra`
- 隔离 clone：`D:\aboutAI\dsh-orchestra\tmp\audit-s1-r47`（`git clone --no-hardlinks`，detached HEAD 在候选提交）
- 候选提交：`c17a0c76ed342364daf8972684e283290a3fbd00`（父 `9cefb87246071302caa8718cbf9adf00cc14d914`，即 `9cefb87`；`origin/main`）
- 审计日期：2026-11-14
- 只读声明：全部安装、测试、探针与报告只发生在 clone 内；主工作树未改；未运行 sign-gate；未改 `docs/gates`；未提交任何内容。

## 一、审计范围与本轮变化

第 46 轮 S1 在 `9cefb87` 判 G1 pass（13/13，P0/P1/P2 = 0）。本轮候选在其上只多一个提交 `c17a0c7`，`git diff --stat 9cefb87..c17a0c7` 为 4 个文件：

| 文件 | 变更 |
| --- | --- |
| `scripts/fault-inject.ts` | +8/−1，`HttpBootOpts` 增加 `now?: () => string`，`bootHttp` 条件透传给服务端 `ServerDeps.now`；`caseEvG203` 用可推进的服务端时钟把上报推到 T+5s |
| `docs/gates/G2.md` | G2 记录正文与证据描述同步 |
| `docs/gates/evidence/G2/ev-g2-03.md` | G2-03 证据改为服务端时钟 |
| `docs/gates/evidence/G2/ev-g2-16.md` | G2-16 证据同步 |

结论性事实：本轮没有改动 `src/`、G1 的 13 份证据文件、迁移脚本或 `docs/gates/G1.md`。因此 G1 的必过项实现面与第 46 轮相同，但本轮仍按要求重新实跑全部命令、逐份重算证据哈希、并单独核对新增时钟注入对 G1 判定的影响，不复读上轮结论。

## 二、命令与退出码

clone 内 HEAD 与候选一致，`git status --porcelain` 为空。以下均为 clone 内实跑结果。

| 步骤 | 命令 | 输出要点 | 退出码 |
| --- | --- | --- | --- |
| 1 | `git rev-parse HEAD` / `git status --porcelain` | HEAD = `c17a0c76ed342364daf8972684e283290a3fbd00`；工作树干净 | 0 |
| 2 | `pnpm install --frozen-lockfile` | `Done in 3.3s using pnpm v12.3.4` | 0 |
| 3 | `pnpm typecheck` | `tsc --noEmit` 无输出 | 0 |
| 4 | `pnpm test`（第 1 次） | Test Files 41 passed (41)；Tests 607 passed + 1 skipped (608)；15.42s | 0 |
| 5 | `pnpm test`（第 2 次） | Test Files 41 passed (41)；Tests 607 passed + 1 skipped (608)；14.55s | 0 |
| 6 | `pnpm test`（第 3 次） | Test Files 41 passed (41)；Tests 607 passed + 1 skipped (608)；13.76s | 0 |
| 7 | 桥闭环 6 文件（第 1 次） | Test Files 6 passed (6)；Tests 70 passed (70) | 0 |
| 8 | 桥闭环 6 文件（第 2 次） | Test Files 6 passed (6)；Tests 70 passed (70) | 0 |
| 9 | `pnpm build` | Build complete（≈944 ms）；ESM `lib/index.js` 149.00 kB、`lib/index.d.ts` 14.00 kB | 0 |
| 10 | `node --no-warnings scripts/check-evidence-repro.ts` | `证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致` | 0 |
| 11 | `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` | 预签态非 0（陈旧锚点，预期内，原文见第七节） | 1 |
| 12 | `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` | 预签态非 0（陈旧裁决，预期内，原文见第七节） | 1 |

桥闭环 6 文件命令原文（两次相同）：

```text
npx vitest run tests/integration/agent-lifecycle.spec.ts tests/integration/bridge-ledger.spec.ts tests/unit/bridge-buffer.spec.ts tests/integration/runtime.spec.ts tests/e2e/production-path.spec.ts tests/contract/execution-concurrency.spec.ts
```

三次全量测试的计数与要求一致（41 files / 607 passed + 1 skipped），未出现偶发差异。

## 三、证据哈希表（G1.md 引用的 13 份，LF 归一）

在 clone 内按 LF 归一后逐份重算 sha256，13 份全部与 `docs/gates/G1.md` 证据索引记录一致。

| 证据 id | 文件 | 复核 sha256（LF 归一） | 与记录 |
| --- | --- | --- | --- |
| ev-auth | `tests/contract/auth.spec.ts` | `d8593aff1f15ecd5755a922ae4a8c6374aa2a6272ec54d5143ad63563ff8130f` | 一致 |
| ev-backup | `tests/integration/backup.spec.ts` | `3c1b2f975dc4807ff5cff2ec5d0d0cca4ba05a5d547007d86bfcaeb1b2207a8f` | 一致 |
| ev-chain | `tests/integration/hash-chain.spec.ts` | `cf2d60dd505da107a9c643522b8c1e3781a6919d9c0bc08ac2fc4f3e64b48628` | 一致 |
| ev-epoch | `tests/integration/db-open.spec.ts` | `19be1852c1fbf69f4499c347851ed9c6fc7738ccca56ef741e5b0a7fe1d8d6aa` | 一致 |
| ev-g01 | `docs/gates/evidence/G1/G-01.md` | `f2626b30f9eb472f1268b71047893be8f1d42a933438e43cd30af35d3318a129` | 一致 |
| ev-g02 | `docs/gates/evidence/G1/G-02.md` | `5fedb2e7539b1d410b7ff3c964ea36d77764fd037c4f4e40badbd67b7038b196` | 一致 |
| ev-g08 | `docs/gates/evidence/G1/G-08.md` | `2f2a73ddbf25fb59ea9b650635499856e66c94dcde81fca1a12ea3d424176c87` | 一致 |
| ev-g09 | `docs/gates/evidence/G1/G-09.md` | `e944a2b6bd299faed3f9ce98c72647ceb8580eaae412a997d7be6cdcc5376625` | 一致 |
| ev-g14 | `docs/gates/evidence/G1/G-14.md` | `f88f67c35c0cd86674a71fc04b8d3f74fb1cc5711135755a430611eeecf13213` | 一致 |
| ev-g15 | `docs/gates/evidence/G1/G-15.md` | `1699f60368dd5b07e0771f20e3d689b38f7af11afb9dfe9587529248098b24a0` | 一致 |
| ev-gatecheck | `tests/gate/gate-check.spec.ts` | `ed7e65aeeec5cc158b79c95e98cc14963fe2913fbc72f464a9080704890bb5c3` | 一致 |
| ev-migrate | `tests/integration/migrate.spec.ts` | `376dc6d6e087619429b78b91678e88bc686cee95f0593805ca01d8dcba4df0aa` | 一致 |
| ev-phase | `tests/unit/config.spec.ts` | `1702657cdb40d65c3a91cf9eac4fe196a9eb2ecea8e54293e44db4f37c9a39aa` | 一致 |

对照：`scripts/check-evidence-repro.ts` 的 25/25 复现通过，说明证据生成脚本重跑两遍仍与 HEAD 字节一致，证据不是手写快照。

## 四、13 项必过项逐项结论

| 必过项 | 结论 | 实现与证据要点 |
| --- | --- | --- |
| G1-01 | 通过 | 空库应用迁移，版本列表与 15 张核心表齐备；再跑一次返回空；篡改 checksum 返回 `SCHEMA_VERSION_UNSUPPORTED`；迁移中途退出可重入；文件名/序号缺口/重复版本都有守卫；008 用复合主键；事件表 append-only 触发器生效。测试：`tests/integration/migrate.spec.ts`。 |
| G1-02 | 通过 | 注入用例在迁移中途杀进程后重跑，已提交步骤跳过、未提交步骤重做，不停在半途。测试：`tests/integration/g1.spec.ts` 调用 `scripts/fault-inject.ts` 的 `runCase`。 |
| G1-03 | 通过 | 事件在 COMMIT 后、投递前被杀：账本保留 1 条 `task.created evt_1`；投递后追加 `inject.g02 evt_committed`；从 `fromSeq=1` 重放可取到第 2 条，总数 2。证据：`ev-g02`。 |
| G1-04 | 通过 | 备份目录含 `orchestra.db` 与 `manifest.json`；清单覆盖 10 张 S1 核心表且行数与线上一致；`db_sha256` 与文件一致；恢复到新文件内容相等，线上库字节与哈希不变；缺清单报 `SERVICE_UNAVAILABLE` `(manifest)`。测试：`tests/integration/backup.spec.ts`。 |
| G1-05 | 通过 | 截断库文件报 `SERVICE_UNAVAILABLE` `(db_file)` 并给出文案“备份文件被改过或截断”；篡改清单行报出具体表名。测试：`tests/integration/backup.spec.ts`。 |
| G1-06 | 通过 | `/health` 免认证；`GET /v1/tasks` 缺钥或错钥返回 401 `UNAUTHORIZED`；匿名 `POST /v1/ledger/events` 返回 401；请求体里的 actor 被忽略，actor 由 `service:` + `sha256(secret).slice(0,8)` 派生。测试：`tests/contract/auth.spec.ts`。 |
| G1-07 | 通过 | 仓库配置加载为 phase S2；未知 phase `S7` 报 `SCHEMA_VERSION_UNSUPPORTED`；未知顶层/嵌套键被拒并带 `details.issues`；范围检查与 `requirePhase`/`requireCapability` 生效。测试：`tests/unit/config.spec.ts`。 |
| G-01 | 通过 | 事务 COMMIT 前杀进程：杀前杀后账本都只有 1 条 `task.created evt_1`，事件数 1 与期望一致，“未提交事务不留半条记录：true”。证据：`ev-g01`。 |
| G-02 | 通过 | COMMIT 后未投递即被杀：已提交事件在账本存活，重启后从游标重放可取到，无丢失。证据：`ev-g02`。 |
| G-08 | 通过 | 长事务期间读不排队：`busyTimeoutMs=30`、`queueMax=2`、`httpQueueMax=1`；只读到 1 条不被拖住；第二个写者拿到 busy；队列溢出返回 `SERVICE_UNAVAILABLE`；HTTP 队列满时第二个请求返回 503 `SERVICE_UNAVAILABLE`；日志含 `warn 写队列满了，拒掉这一笔写 {"pending":1,"max":1}`。证据：`ev-g08`。 |
| G-09 | 通过 | 订阅者离线：`offlineFromSeq=1` 后追加 3 条；重连从 `handled` 之后重放得到 seq 2/3/4 连续，无缺口。证据：`ev-g09`。 |
| G-14 | 通过 | 迁移一半杀后重跑只补 901/902 两步；`schema_migrations` 为 001–010 加 901/902；表数 18 → 20；第一步未重复执行。证据：`ev-g14`。 |
| G-15 | 通过 | 截断到一半的备份被检出；恢复请求被挡下；线上库字节与 sha 不变；损坏备份的 sha 与线上库 sha 不同；线上事件数保持 1。证据：`ev-g15`。 |

## 五、重点项复核（迁移闭合 / 010 只增列 / markHandled 边界）

迁移文件从 `src/infra/sqlite/migrations/001_init.sql` 到 `010_bridge_handled_seq.sql` 连续编号，无缺口、无重复：

```text
001_init.sql
002_s2_agent_loop.sql
003_s2_round3.sql
004_workflow_versions.sql
005_append_only_events.sql
006_tool_executions_tool_seq.sql
007_node_run_events_append_only.sql
008_bridge_event_receipts.sql
009_bridge_tool_outbox.sql
010_bridge_handled_seq.sql
```

`010_bridge_handled_seq.sql` 全文只有一条 DDL，属于纯增列：

```sql
ALTER TABLE bridge_stream_cursors ADD COLUMN last_handled_seq INTEGER NOT NULL DEFAULT 0;
```

`src/infra/db/migrate.ts` 的 `loadSteps` 强制 001..NNN 连续且版本不重复；`execSchema` 每一步在独立 `withTx` 事务里执行并记录 checksum，已应用步骤跳过，checksum 不符报 `SCHEMA_VERSION_UNSUPPORTED`，杀进程后可重入。这与 G1-01/G1-02/G-14 的证据一致。

`markHandled`（`src/executor/bridge-ledger.ts:53-70`）在同一事务里先读两个游标，再分三种情况处理：

```ts
const persisted = Number(row?.last_persisted_ack_seq ?? 0)
const handled = Number(row?.last_handled_seq ?? 0)
if (seq > persisted) {
  throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '处理位不能越过已落账位', { seq, persisted })
}
if (seq <= handled) return
tx.run(
  'UPDATE bridge_stream_cursors SET last_handled_seq = ?, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ?',
  [seq, new Date().toISOString(), this.key.nodeRunId, this.key.attempt, this.key.executorAgentId],
)
```

即：越过已落账位直接报错；不大于已处理位时幂等返回；只有落在 `(handled, persisted]` 区间才前进，且只能单调前推。`cursor()` 只读 `last_persisted_ack_seq`，`handled()` 只读 `last_handled_seq`；`ingest()` 的 receipt 与游标在同一事务里提交，`ON CONFLICT` 只推进已落账位，不会顺手推进处理位。

## 六、候选新增时钟注入对 G1 的影响

`scripts/fault-inject.ts` 只新增了一个可选的 `now` 注入，且是条件透传：

```ts
...(opts?.now ? { now: opts.now } : {}),
```

服务端 `src/service/server.ts:78` 的取值口径未变：`const serverNow = (deps: ServerDeps): string => deps.now ? deps.now() : new Date().toISOString()`；每个请求在 `src/service/server.ts:129` 只采样一次 `requestNow`，所有命令（lease/renew/report/cancel/createRun/dispatch）都用这个服务端时刻，请求体里的 `now` 不参与判定。G1 的注入用例 `bootHttp` 不传 `now`，走系统墙钟，行为与第 46 轮一致。

旁证：`check-evidence-repro.ts` 25/25 全绿，G1 的 13 份证据与测试文件逐份重算哈希均一致，说明新增注入没有改变任何 G1 证据字节；`pnpm test` 与桥闭环 6 文件两次全绿。因此这次改动属于服务端测试时钟能力，没有削弱 G1 的判定面。

## 七、预签态记录（预期内，不计候选缺陷）

两道门的预签态校验都返回 exit 1。原因是门记录仍指向第 44 轮报告与旧候选哈希，尚未按第 47 轮审计重签；这是流程上的陈旧记录，不是候选提交的缺陷。原文如下。

`node --no-warnings scripts/gate-check.ts docs/gates/G1.md`：

```text
门检查失败：审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：codebasemap.md
```

`node --no-warnings scripts/gate-check.ts docs/gates/G2.md`：

```text
门检查失败：审计报告的结构化裁决不通过：must_pass_total（19）与门规格的必过项数（20）不符；审计没覆盖这些必过项：G2-16
```

补充：在候选 HEAD 处重算 G1 候选清单为 176 个文件，`candidate_hash=5c1f4c7249df7593788f1cff44a45156b4d0fec927307c01e4a8f251196bee09`、`change_scope_hash=53be4012b4e85def398ec472007a2b6badfc45cdf82b1f8e628fae2aa0518bf6`；`docs/gates/G1.md` 当前记录为 `5276620ce4958529eb1efba431a8afc8f0acb7b3502231bad621ee4ecd884ab6` 与 `c7759fb5f37d81aa59309990707bfeb0f8ca26665b9cf37634302587b0fddae7`。差异来自候选范围内 `scripts/fault-inject.ts` 的本轮改动，与预签态一致，重签由人按流程完成。

## 八、失败清单

无。P0 = 0，P1 = 0，P2 = 0；13 项必过项全部通过。

## 九、结构化裁决

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 47,
  "candidate_commit": "c17a0c76ed342364daf8972684e283290a3fbd00",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 0,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": ["G1-01", "G1-02", "G1-03", "G1-04", "G1-05", "G1-06", "G1-07", "G-01", "G-02", "G-08", "G-09", "G-14", "G-15"],
  "failed_items": [],
  "notes": "候选只改 fault-inject 服务端时钟注入与 G2 证据；G1 源码与 13 份证据字节未变，25/25 复现成立，预签态为旧锚点属预期。"
}
```
<!-- audit-verdict:end -->
