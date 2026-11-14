# S1 独立审计 · G1 · 第 50 轮

- 门：G1
- 候选提交：bad33264d5799fffd0baad6ef424d18392aa1301
- 候选标题：docs: record round50 candidate hardening
- 审计轮次：50
- 审计时间：2026-11-14
- 审计方式：独立 clone `D:\aboutAI\dsh-orchestra\tmp\audit-s1-r50`，只读审计；不改主仓、不签门、不提交主仓
- 候选范围：`623939d4c0a7123835b525287035588ee291ccbe..bad3326`，candidate_hash 覆盖 180 个文件（排除 docs/gates、docs/audits、docs/reviews、handoff.md）
- 本轮改动：c5e0014 新增迁移 013、链头替换守卫回归测试、R4 工作流身份校验与执行期定义哈希复核；bad3326 只改 codebasemap.md 与 handoff.md 文档

## 一、命令与退出码

| 命令 | 次数 | 期望 | 实际 | 退出码 |
| --- | --- | --- | --- | --- |
| `git status --porcelain` | 1 | 空 | 空 | 0 |
| `git rev-parse HEAD` | 1 | bad3326 | bad33264d5799fffd0baad6ef424d18392aa1301 | 0 |
| `pnpm install --frozen-lockfile` | 1 | 成功 | 7.4s 完成 | 0 |
| `pnpm test` | 3 | 42 files / 624 passed \| 1 skipped | 每次 42 files / 624 passed \| 1 skipped（625） | 0 / 0 / 0 |
| 桥闭环 6 文件命令 | 2 | 6 files / 70 passed | 每次 6 files / 71 passed | 0 / 0 |
| `pnpm typecheck` | 1 | 无错 | 无错 | 0 |
| `pnpm build` | 1 | 成功 | 成功（ESM lib/index.js 154.88 kB） | 0 |
| `node --no-warnings scripts/check-evidence-repro.ts` | 1 | 25 份、每份两遍与 HEAD 一致 | 证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致 | 0 |
| `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` | 1 | 预签态 exit 1 | 审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：codebasemap.md | 1（预期） |
| `pnpm vitest run tests/integration/g1.spec.ts` | 1 | 6 tests | 1 file / 6 passed | 0 |

桥闭环命令：`pnpm vitest run tests/integration/agent-lifecycle.spec.ts tests/integration/bridge-ledger.spec.ts tests/unit/bridge-buffer.spec.ts tests/integration/runtime.spec.ts tests/e2e/production-path.spec.ts tests/contract/execution-concurrency.spec.ts`。实际 71 比简报的 70 多 1 条，多出的是本轮 `tests/integration/runtime.spec.ts` 新增的「run 绑定的定义哈希被换掉」用例，文件数仍为 6，属预期。

本机 `cmd /c pnpm` 找不到 pnpm，审计时用 `C:\Users\ASUS\AppData\Roaming\npm\pnpm.cmd` 直接调用；node v26.13.1。

## 二、结论

结论：pass（13 项必过项全部通过，P0 为 0、P1 为 0，P2 两项已列明）。`gate-check` 对 HEAD exit 1 属预签态，原因与处置见第五节与 P2-1；该状态只涉及门记录待重签，不改变候选代码与证据的判定。测试里的 PRE_SIGNED 分支同样只跳过「门记录通过」用例，候选代码仍由全量与桥闭环用例覆盖。

## 三、13 项逐项结论

| 编号 | 要求 | 落点与观察 | 证据 | 结论 |
| --- | --- | --- | --- | --- |
| G1-01 | 迁移空库可重复 | 迁移 001..013 空库全量应用与重复应用均通过；独立探针 schema_migrations=[1..13] | ev-migrate | pass |
| G1-02 | 迁移中途杀可重入 | 注入 901 中途杀，重跑只补 902；schema_migrations=[1..13,901,902] | ev-g14 | pass |
| G1-03 | 进程杀不丢已提交事件 | G-02 注入：COMMIT 后未投递被杀，重启重放 | ev-g02 | pass |
| G1-04 | 备份独立目录行数与哈希一致 | 备份目录行数、内容哈希与线上库对账一致 | ev-backup | pass |
| G1-05 | 损坏备份可检出 | 截断备份的完整性校验拒绝恢复 | ev-g15 | pass |
| G1-06 | 认证拒匿名写 | 匿名写请求 401，鉴权后才落账 | ev-auth | pass |
| G1-07 | 阶段开关拒未知值 | 未知阶段值拒绝启动 | ev-phase | pass |
| G-01 | 事务 COMMIT 前杀进程 | 半条事务不落库，CAS 失败无副作用 | ev-g01 | pass |
| G-02 | COMMIT 后未投递被杀 | 已提交事件在重启后仍可投递 | ev-g02 | pass |
| G-08 | 长事务期间读不被拖死、写报 busy、队列溢出报 503 | 读不阻塞、写 BUSY、队列满 503 | ev-g08 | pass |
| G-09 | 订阅者离线重放 | 离线期间事件在重连后按序重放 | ev-g09 | pass |
| G-14 | 迁移一半杀后重跑 | 本轮迁移 013 已含在 [1..13]，第一步未重复执行，表数 18→20 | ev-g14 | pass |
| G-15 | 备份截断能检出、恢复被拒、线上库不变 | 截断检出、恢复拒绝、线上库哈希未变 | ev-g15 | pass |

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
| ev-g14 | `docs/gates/evidence/G1/G-14.md` | `ec2b935dddae3395997de961e9fee3cec2d77826e67914ac3cb37ea2aafd9052` | 同左 | 一致 |
| ev-g15 | `docs/gates/evidence/G1/G-15.md` | `1699f60368dd5b07e0771f20e3d689b38f7af11afb9dfe9587529248098b24a0` | 同左 | 一致 |
| ev-gatecheck | `tests/gate/gate-check.spec.ts` | `ed7e65aeeec5cc158b79c95e98cc14963fe2913fbc72f464a9080704890bb5c3` | 同左 | 一致 |
| ev-migrate | `tests/integration/migrate.spec.ts` | `376dc6d6e087619429b78b91678e88bc686cee95f0593805ca01d8dcba4df0aa` | 同左 | 一致 |
| ev-phase | `tests/unit/config.spec.ts` | `1702657cdb40d65c3a91cf9eac4fe196a9eb2ecea8e54293e44db4f37c9a39aa` | 同左 | 一致 |

## 五、G1.md 自锚复核

| 字段 | HEAD 重算 | G1.md 记录 | 判定 |
| --- | --- | --- | --- |
| candidate_hash | `85dccd92100aab9352184508fb2882f533ce93ea066c0e91c9ffbadbbd305f97`（180 文件） | `70af7dd41096a47746201869c808716dd7ef2499aa5eca4776b7f8e598f70f22` | 预签态，待 sign-gate 重算（P2-1） |
| change_scope_hash | `0079ed78768fabd7beed450d5a51089508b3118501cdd8d4526005e894d35802` | `61d43ab2ddf33a5e2382302eb81ea73b03ba2eaea991a60b5450cadb59cec836` | 预签态（P2-1） |
| evidence_index_hash | `3ac6049c847e4b02d9b4cfbb9ae0c47ce102985290e2c6d1b21a00642870933b` | 同左 | 一致 |
| invariants_hash | `6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6` | 同左 | 一致 |
| artifact_hash | `a9a20c88cb2c10f5f4ae775b9945a9968ff5a0535263d815b1ffb3d679ba48c9` | 同左 | 一致 |
| body_hash | `6a3cd0fdcb7d43ab3daf637a5dc82e045a779d950d2dfe15d1426fe7e0daf9e6` | 同左 | 一致 |
| audit_report_sha256（round49） | `e3efae6e8e8c8fdff3642de09a260d3a826cac51c827b84c455778589a50e7c0` | 同左 | 一致 |

`gate-check` 的 exit 1 首因是第 49 轮报告绑定的候选之后 codebasemap.md 又被改过（审计锚点检查），candidate_hash 不一致尚未轮到；两者都属于预签态，不是候选代码缺陷。

## 六、迁移链

- 001..013 编号连续；`src/infra/db/migrate.ts` 的 loadSteps 校验编号连续，每一步 checksum 为整文件 sha256。
- `src/infra/sqlite/driver.ts:97-117` 每步一个 `withTx`，schema_migrations 插入与迁移语句同事务；已记录步骤只校验 checksum 后 continue，不会重跑。故 007 的 `INSERT OR REPLACE INTO node_run_chain_heads` 回填只可能发生在 013 尚未存在的旧库上，013 生效后不会被重放。
- `011_workflow_version_identity.sql` 用 (workflow_id,version) 复合主键重建表，`INSERT … SELECT 'default', version, …`，旧行统一归 default，version 列保持 TEXT 亲和，不会把 '1' 变数字。
- `013_node_run_chain_head_replace_guard.sql` 只加一个 BEFORE INSERT 触发器，不新增表；G-14 的 schema_migrations=[1..13,901,902] 与表数 18→20 对得上。

## 七、守卫攻击矩阵（独立探针，直接改库）

| 场景 | 结果 |
| --- | --- |
| 正常首条 / 第二条 / 第三条 append | seq=1 / 2 / 3 全部成功 |
| `INSERT OR REPLACE INTO node_run_chain_heads` 重置链头 | 013 拒：链头只能由追加创建，不能重复插入或替换；head 仍 {last_seq:2,event_count:2} |
| `INSERT … ON CONFLICT DO UPDATE` | 同拒 |
| 普通重复 INSERT | 同拒 |
| 链头 DELETE | 012 拒：链头只由追加维护，不许删除 |
| 链头 UPDATE 退号 2→1、跳号 2→4 | 拒：链头序号必须逐条递增 |
| 链头 UPDATE 改 hash | 拒：链头更新缺少对应事件 |
| 无链头插 seq=2 | 拒：新链必须从 seq=1 的零哈希开始 |
| 无链头 seq=1 错 prev | 同拒 |
| 有链头插 seq=3 错 prev | 拒：node_run_events 必须接在链头之后 |
| seq=0 | 同拒 |
| 同事务 append 第三条后抛错回滚 | events 仍 2 条、max seq=2，head 仍 2/2；随后正常第三条 seq=3 成功 |

结论：013 堵住 REPLACE 重置链头的路径（REPLACE 不走 BEFORE DELETE），同时不误伤正常首条追加（仅当同 node_run 已有链头才拒）。

## 八、R4 加固与事务原子性

- 工作流身份：长度上限 128/64，正则 `/^[A-Za-z0-9][A-Za-z0-9._:-]*$/`；`' wf-a'`、`'wf-a '`、`'wf\na'`、`''`、`':wf'`、`'1\n'` 全部以 WORKFLOW_VALIDATION_FAILED(422) 拒绝，表 0 行。
- `hydrate()` 行键与快照交叉校验：行 workflow_id/version 与 definition_json 内的身份不一致即抛 WORKFLOW_VERSION_IMMUTABLE(409)，篡改库不放行。
- `runNode` 在 acquireNodeRun/spawn/工具授权之前调用 policyForNodeRun，取 `r.workflow_definition_hash` 与当前 catalog 定义哈希比对，不等即拒；测试断言 rejects 且 spawned=false。
- 011 旧库升级回归：单键旧行升级为 default 行，hydrate 后定义哈希不变。
- 事务原子性：迁移每步一事务；append 的事件 INSERT 与链头 INSERT/UPDATE 同事务，回滚不留半条链。
- 边角（P2-2）：旧 definition_json 若自带非 default 的 workflow_id（旧 schema 为 looseObject 会原样保留），011 升级后行键归 default、快照仍为 wf-a，hydrate 以「行键与快照身份不一致」拒绝启动。属 fail-closed，探针已复现。

## 九、P0 / P1 / P2

- P0：0
- P1：0
- P2-1（预签态，不阻断）：G1.md artifact 仍是 audit_round=49、audit_report 指第 49 轮报告，candidate_hash=70af7dd（上一候选 ce8c2e6 的值）、change_scope_hash=61d43ab；HEAD 重算为 85dccd92、0079ed78。证据索引、不变量、artifact 自锚与 body_hash 已按 HEAD 重算一致。正式签署时由 sign-gate 重算 candidate_hash/change_scope_hash 并绑定本轮报告。
- P2-2（升级边角，不阻断）：011 把旧行统一标 default；旧 definition_json 内嵌 workflow_id 时升级后启动被拒（fail-closed）。建议在迁移文档写明旧库需先清理内嵌 id，或在 hydrate 报错里补一句升级指引。

## 十、裁决

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 50,
  "candidate_commit": "bad33264d5799fffd0baad6ef424d18392aa1301",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 2,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": ["G1-01", "G1-02", "G1-03", "G1-04", "G1-05", "G1-06", "G1-07", "G-01", "G-02", "G-08", "G-09", "G-14", "G-15"],
  "failed_items": [],
  "notes": "预签态：candidate_hash/change_scope_hash 待 sign-gate 按 HEAD 重算；P2-2 为 011 升级 fail-closed 边角"
}
```
<!-- audit-verdict:end -->
