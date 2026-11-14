# S1 独立审计报告 · 第 48 轮

门：G1

候选提交：41a450f2fc6345345f7654ebe20daeebe58b37de

- 审计角色：S1 独立审计员（只读）
- 主仓：`D:\aboutAI\dsh-orchestra`（只读，未改动、未提交、未签门、未推送）
- 隔离 clone：`D:\aboutAI\dsh-orchestra\tmp\audit-s1-r48`（detached HEAD 在候选提交，`git status --porcelain` 为空）
- 候选提交：`41a450f2fc6345345f7654ebe20daeebe58b37de`（父 `7776df831104f605250972fb6911ef52ee3820af`；与 `origin/main` 同点）
- 候选标题：`feat(r4): scope workflow versions by workflow id`
- 候选规模：22 个文件，+314 / −80
- 审计日期：2026-11-14

## 一、审计范围与本轮变化

本轮重点是新提交的 R4 复合身份：`workflow_versions` 从 `version` 单键改为 `(workflow_id, version)` 复合键；`runs` / `tasks` 记录 `workflow_id`；`run-node` 与 `apply-report` 按 run 绑定的复合身份取工具策略与收口判定。审计同时复核 G1 既有 13 项是否有回归。

候选把 `src/service/workflows.ts` 扩展了 160 行：单参 `resolve` 只在版本号全局唯一时命中，两参按 `(workflow_id, version)` 精确取；`definitionHashOf` 对 `default`/缺省 `workflow_id` 先剥离字段再哈希，非 default 的 id 参与哈希。`src/executor/run-node.ts` 与 `src/service/commands/apply-report.ts` 都改为从 `runs` 行读取 `workflow_id, workflow_version, workflow_definition_hash`，不再接受调用方临时指定判定条件。`src/infra/sqlite/migrations/011_workflow_version_identity.sql` 重建 `workflow_versions`，把旧行归入 `default`。

## 二、命令与退出码

以下均在 clone 内实跑，日志保存在 clone 内 `tmp/audit-logs-r48/`。

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 依赖与 lockfile 一致，耗时约 2.4s |
| `pnpm typecheck` | 0 | `tsc --noEmit`，无输出 |
| `pnpm test`（第 1 次） | 0 | Test Files 42 passed (42)；Tests 612 passed \| 1 skipped (613) |
| `pnpm test`（第 2 次） | 0 | Test Files 42 passed (42)；Tests 612 passed \| 1 skipped (613) |
| `pnpm test`（第 3 次） | 0 | Test Files 42 passed (42)；Tests 612 passed \| 1 skipped (613) |
| `pnpm build` | 0 | tsdown 两个入口构建完成：`lib/index.js` 152.60 kB、`lib/index.d.ts` 14.30 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 「证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致」 |
| `pnpm vitest run tests/gate/gate-check.spec.ts` | 0 | Tests 183 passed \| 1 skipped (184) |
| `node --no-warnings scripts/gate-check.ts`（G1，预签态） | 1 | 见第七节；失败点是审计报告锚点陈旧，不是代码或证据校验 |
| 定向探针（临时文件，跑完已删） | 0 | 第一批 5 tests passed；第二批（旧库内嵌 id 边界）2 tests passed |

三次全量计数一致：每次 `612 passed | 1 skipped (613)`，42 个测试文件全过。任何一次都没有非 0 退出。

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
| ev-g14 | `docs/gates/evidence/G1/G-14.md` | `d655af7e2b77f3736aee6422e2e3e133d4f936a6572a82c98a40a4877740de39` | 一致 |
| ev-g15 | `docs/gates/evidence/G1/G-15.md` | `1699f60368dd5b07e0771f20e3d689b38f7af11afb9dfe9587529248098b24a0` | 一致 |
| ev-gatecheck | `tests/gate/gate-check.spec.ts` | `ed7e65aeeec5cc158b79c95e98cc14963fe2913fbc72f464a9080704890bb5c3` | 一致 |
| ev-migrate | `tests/integration/migrate.spec.ts` | `376dc6d6e087619429b78b91678e88bc686cee95f0593805ca01d8dcba4df0aa` | 一致 |
| ev-phase | `tests/unit/config.spec.ts` | `1702657cdb40d65c3a91cf9eac4fe196a9eb2ecea8e54293e44db4f37c9a39aa` | 一致 |

`ev-g14` 的哈希由第 47 轮的 `f88f67c3…` 更新为 `d655af7e…`，对应 011 加入后 `schema_migrations` 变为 `[1,2,3,4,5,6,7,8,9,10,11,901,902]`、表数 18→20；证据内容与 `check-evidence-repro` 重跑结果一致。`G1.md` 中该证据索引位于 artifact 之后的“补记”，不在 `GateArtifact` 内，所以 artifact 自锚不受影响；clone 内重算 `artifact_hash=SHA256(canonicalJson(GateArtifact))` 仍为 `a9c19a59e88807f402f7f3c185744a7bbb02f0b4c4ab1b3118029f3b76606b6b`，与文件记录一致。

## 四、13 项必过项逐项结论

| 必过项 | 结论 | 实现与证据要点 |
| --- | --- | --- |
| G1-01 | 通过 | 空库应用全部迁移、迁移记账与目录一致；再跑返回空；checksum 改动被挡；步骤中途退出可重入。`tests/integration/migrate.spec.ts`（9 tests）三次全量均过，`ev-migrate` 哈希一致；本轮另用临时探针验证旧库 1..10 → 011 的升级。 |
| G1-02 | 通过 | 迁移中途杀进程后重跑只补缺步，第一步不重复。`docs/gates/evidence/G1/G-14.md` 已按 11 步迁移重生成，`check-evidence-repro` 25/25 复现成立，`ev-g14` 哈希一致。 |
| G1-03 | 通过 | 进程被杀后已提交事件仍在，未提交事件不出现。`ev-g02` 哈希一致，25/25 复现成立。 |
| G1-04 | 通过 | 备份进独立目录，行数与哈希和源库一致。`tests/integration/backup.spec.ts`（6 tests）三次全量均过，`ev-backup` 哈希一致。 |
| G1-05 | 通过 | 损坏备份能检出，恢复被挡。`ev-g15` 哈希一致，25/25 复现成立。 |
| G1-06 | 通过 | 未认证写请求被认证闸挡下。`tests/contract/auth.spec.ts`（12 tests）三次全量均过，`ev-auth` 哈希一致。 |
| G1-07 | 通过 | 阶段开关只接受已知值。`tests/unit/config.spec.ts`（11 tests）三次全量均过，`ev-phase` 哈希一致。 |
| G-01 | 通过 | COMMIT 前杀进程，事务不生效。`ev-g01` 哈希一致，25/25 复现成立。 |
| G-02 | 通过 | COMMIT 后、投递前被杀，重启能补投且不重复。`ev-g02` 哈希一致，25/25 复现成立。 |
| G-08 | 通过 | 长事务期间读不被拖死，写等锁，写队列溢出报 503。`ev-g08` 哈希一致，25/25 复现成立。 |
| G-09 | 通过 | 订阅者离线后从游标重放。`ev-g09` 哈希一致，25/25 复现成立。 |
| G-14 | 通过 | 迁移一半杀后重跑，已提交步骤不重做。`G-14.md` 更新后 `ev-g14` 哈希一致，25/25 复现成立；临时探针另验证 011 升级后重复迁移返回空。 |
| G-15 | 通过 | 备份截断能检出，恢复被挡，线上库不变。`ev-g15` 哈希一致，25/25 复现成立。 |

## 五、R4 重点逐条核查

### 1. 011 迁移：旧数据归 default、可重读、重复与空库安全

`src/infra/sqlite/migrations/011_workflow_version_identity.sql:1-21` 新建 `workflow_versions_v11(workflow_id TEXT NOT NULL, version TEXT NOT NULL, content_hash, definition_json, created_at, PRIMARY KEY(workflow_id, version))`，用 `INSERT ... SELECT 'default', version, ...` 把旧行整体归入 default，再 DROP 旧表、RENAME、建 `version` 索引。旧表存在的数据列被原样复制，`content_hash` 未重算。

迁移框架按文件名排序、按独立 `;` 行拆语句（`src/infra/db/migrate.ts`），每一步在 `withTx` 中执行并写 `schema_migrations`（`src/infra/sqlite/driver.ts:97-117`）；中间失败整步回滚，不会留下半张表或半条记账。

临时探针实跑（已删）：

- 旧库先 apply 1..10，插一行 `version='7'`、`content_hash=definitionHashOf(legacyDef)`；再 apply 全量只返回 `[11]`；该行变为 `workflow_id='default'`、`version='7'`，`content_hash` 未变。
- 再次 apply 返回 `[]`；`new WorkflowCatalog('S2', db).hydrate()=1`；`definitionHash('default','7')` 与升级前哈希相同；`get('default','7')` 读回原节点。
- 空库全量迁移后 `workflow_versions` 0 行，`hydrate()=0`。
- 全仓只有 `src/service/workflows.ts` 读写 `workflow_versions`（hydrate、按复合键查、INSERT），没有第二套按 `version` 单键读取的旧路径。

### 2. default/缺省哈希保持旧值，非 default 参与哈希

`src/service/workflows.ts:226-233` 的 `definitionHashOf` 先浅拷贝，`workflow_id` 为 `undefined` 或 `'default'` 时 `delete`，其余 `String` 化后再 `canonicalJson` 哈希。HEAD~1 的旧公式是直接 `sha256Hex(canonicalJson(def))`；旧定义没有 `workflow_id` 字段时，删除是空操作，哈希字节不变，因此旧库旧证据不会漂移。

探针确认：`definitionHash('default','7')` 等于升级前的单参哈希；`definitionHashOf({...legacyDef, workflow_id:'default'})` 与不带 id 的定义同哈希；`wf-a`、`wf-b` 两份定义哈希彼此不同。两个不同 workflow 使用同一版本号时，哈希不会因为共享版本号而相同。

边界见 P2-2：旧库若曾把 `workflow_id` 写进 `definition_json`（旧加载 schema 是 `looseObject`，未知字段会保留），旧哈希包含该字段，新代码对 default 会剥离，升级时会抛不可改写错误。该前提不属于旧文档化载荷，仓库内无这种数据，按 P2 记录。

### 3. 同版本跨 workflow 的定义、策略、事件与判定隔离

`src/service/workflows.ts:111-181`：两参按 `(workflow_id, version)` 精确取；单参扫全部目录，唯一命中才返回，0 命中抛 NOT_FOUND，多命中抛 `WORKFLOW_VERSION_CONFLICT`（文案「这个版本号同时存在于多个工作流，必须带 workflow_id」）。`policyFor`/`toolPolicyFor` 的三参重载按 `workflowId + version + nodeId` 取，策略只来自已加载定义。

临时探针走真实 HTTP：加载 wf-a v1（条件 `exitCode eq 0`，允许 `ro.echo`）、wf-b v1（条件 `eq 5`，允许 `ro.fail`）、wf-c v1（条件 `eq 5`，允许 `ro.echo`）。

- 三份 `definitionHash` 两两不同。
- `toolPolicyFor` 分别返回 `['ro.echo']`、`['ro.fail']`、`['ro.echo']`；`policyFor` 的条件值分别为 0、5。
- 省略 workflowId 的 `createRun {workflowVersion:'1'}` 被 `WORKFLOW_VERSION_CONFLICT` 挡下，没有静默选一个。
- 各建 run 后，`runs.workflow_id` 分别为 `wf-a`、`wf-c`，`workflow_definition_hash` 与各自目录哈希相等且互异；`tasks.workflow_id='wf-a'`；`run.created` 事件的 `payload_redacted` 内 `workflow_id='wf-a'`。
- 工具授权不串：wf-a 的 run 请求 `ro.fail` 得到 `FORBIDDEN`；wf-b 的 run 请求 `ro.echo`（fake agent 固定请求该工具）也得到 `FORBIDDEN`，说明策略取自该 run 绑定的 workflow，而不是默认或最近加载的定义。
- 收口判定不串：wf-a 的 run 在 `exitCode=0` 下 `done`、`report_registry=applied`；wf-c 的 run 同样退出码 0、但自身条件是 `eq 5`，被判 `failed`、`report_registry=rejected`。

### 4. createRun 的 workflowId 从 API 一路到 runs/tasks/事件

`src/service/schemas.ts:163` 接收可选 `workflowId`；`src/service/server.ts:156-171` 路由把 `body.workflowId` 透传；`src/index.ts:117-124` 装配时继续透传；`src/service/runs.ts:37` 只在 `workflowId === undefined` 时走单参兼容解析，否则按两参精确取。

`src/service/runs.ts:43,52,58,64-69,84-92`：从定义取 `workflowIdOf(def)`、`String(def.workflow_version)`、`definitionHashOf(def)`；`tasks` 与 `runs` 的 INSERT 都写 `workflow_id, workflow_version`（`runs` 另写 `workflow_definition_hash`）；`task.created` 与 `run.created` 的 payload 都带 `workflow_id, workflow_version`（run 事件另带定义哈希）；返回体带 `workflow_id, workflow_version`。探针已逐项核对 `runs`、`tasks`、`run.created` 与返回体。

### 5. run-node 与 apply-report 只信 runs 里的复合身份

`src/executor/run-node.ts:143-158` 用 `node_run_id` JOIN `runs`，只取 `n.node_id, r.workflow_id, r.workflow_version`；节点号与账本不符抛 `STALE_GENERATION`，版本为空抛 `VERDICT_UNSUPPORTED`，随后 `toolPolicyFor(row.workflow_id ?? 'default', row.workflow_version, row.node_id)`。策略不接受 dispatch 请求体携带的 workflow 参数。

`src/service/commands/apply-report.ts:98-122` 从 `runs` 读 `workflow_id, workflow_version, workflow_definition_hash`；缺版本或哈希直接 `VERDICT_UNSUPPORTED`；再用 `catalog.definitionHash(run.workflow_id ?? 'default', run.workflow_version)` 与 run 绑定哈希比对，不符抛 `WORKFLOW_VERSION_IMMUTABLE`（「判定条件不许中途换」）；最后按 run 的复合身份取 `policyFor`。判定条件不来自报告请求体或函数参数。

探针 5 专门验证「晚到同名版本」：先 load default v1 并建 run，再 load wf-x v1；此时单参 `createRun` 抛冲突，但已建 default run 仍能正常 dispatch、收口 `done`，其绑定哈希仍等于 default v1 定义哈希。说明收口只认 runs 里的复合身份，不会被后加载的同版本目录或单参解析带偏。

### 6. 旧行 `workflow_id` 为 NULL 时归 default 的一致性

全仓读取 `runs.workflow_id` 的只有两条：`run-node.ts:156` 与 `apply-report.ts:112,121`，两处都用 `?? 'default'`；没有第三种读取路径。探针 4 先按 default 建 run，再把 `runs.workflow_id` 置 NULL，dispatch 与收口均按 default 完成（`done`、`report_registry=applied`）。升级路径上，011 已把旧 `workflow_versions` 行写为 default；旧 `runs` 行保持 NULL，读取时归位，二者一致。

### 7. 单参歧义与兼容

`resolve(version)` 的兼容只在版本号全局唯一时成立；default 与另一个 workflow 同版本时，单参请求被拒并提示必须带 `workflow_id`。生产收口路径（run-node/apply-report）从不调用单参解析，因此不会在收口时重新猜身份。探针 3 与探针 5 分别覆盖「建 run 时歧义」与「建 run 后目录新增同版本」两种情况。

## 六、P0 / P1 / P2

P0：无。

P1：无。

P2 共 6 条，均不影响本轮 13 项必过项，也不改变 R4 的隔离结论。

### P2-1 hydrate 未交叉校验行键与定义快照

- 位置：`src/service/workflows.ts:44-55`（hydrate 读行并 `remember(row.workflow_id, row.version, snapshot)`）、`src/service/workflows.ts:226-233`（哈希只覆盖 `definition_json`）。
- 证据：`content_hash` 是对 `definition_json` 重算的，不覆盖 `workflow_versions` 的行键。hydrate 直接信任 `row.workflow_id` / `row.version`，没有断言 `workflowIdOf(snapshot) === row.workflow_id` 且 `String(snapshot.workflow_version) === row.version`。若行键被改或旧数据行键与定义不一致，目录会出现键与定义不一致的条目；`createRun` 按定义里的 version 绑定 run，`apply-report` 再按 run 身份查目录会得到 NOT_FOUND。后果是 fail-closed，但错误被推后到收口阶段，定位成本高。
- 建议：hydrate 里补两条断言，不符抛 `WORKFLOW_VERSION_IMMUTABLE`；或把行键作为唯一事实、拒绝快照内版本不一致的行。

### P2-2 旧库 definition_json 内嵌 workflow_id 的兼容边界

- 位置：`src/infra/sqlite/migrations/011_workflow_version_identity.sql:7-8`（原样复制 `definition_json`）、`src/service/workflows.ts:226-233`。
- 证据：HEAD~1 的加载 schema 是 `z.looseObject`，未知字段会进定义；旧哈希公式包含整个定义（含未知的 `workflow_id`）。011 不重写 JSON。新代码对 default 先删字段再哈希。临时探针实测两种旧行：`workflow_id:'default'` 的行升级后 hydrate 抛 `WORKFLOW_VERSION_IMMUTABLE`（启动被挡）；`workflow_id:'wf-a'` 的行能 hydrate，但目录键是 `('default','9')`，`get('wf-a','9')` 返回 NOT_FOUND，按内嵌 id 建的 run 在收口时对不上。仓库内没有这种旧数据，旧文档化载荷也不含该字段，因此不计 P1；但升级兼容性应显式处理。
- 建议：迁移或 hydrate 时把快照内的 `workflow_id` 归一为行键（strip 或断言相等），并补一条带未知字段旧行的升级测试。

### P2-3 workflow_id / version 未限制控制字符与首尾空白

- 位置：`src/service/schemas.ts:141,163`（只做 `min(1).max(len)`）、`src/service/workflows.ts:23-25`（内部键用 `'\u0000'` 拼接）。
- 证据：含 NUL 的 id/version 可以构造出与另一对逻辑值相同的内部键；由于非 default id 参与哈希，撞键通常先被 `WORKFLOW_VERSION_IMMUTABLE` 挡下，不会错误放行，但错误语义会误导，且 DB 复合键与内存键的口径不一致。
- 建议：复用 `node_id` 的 identifier 正则（或至少拒绝控制字符并 trim），保证内存键与 DB 键同构。

### P2-4 011 数据升级缺正式回归测试

- 位置：`tests/integration/migrate.spec.ts`（现有 9 tests）。
- 证据：覆盖了空库、重复跑、checksum 改动、步骤中途失败可重入，但没有「旧 004 表带数据 → 011 → hydrate 读回 default 且哈希不变」的用例。本轮用临时探针覆盖了该路径（5 tests 全过），探针已按只读要求删除；缺一条可长期防回归的正式测试。
- 建议：把探针 1/2 的核心断言落到 `tests/integration/migrate.spec.ts` 或新的 identity 测试文件。

### P2-5 契约测试仍手写 `workflow_id='wf'`

- 位置：`tests/contract/execution-concurrency.spec.ts:62-64`、`tests/contract/routes.spec.ts:35-36`；覆盖点在 `tests/fixtures/ledger.ts:36`。
- 证据：测试先插入 `workflow_id='wf'` 的 run，再调用 `bindRunVersion`，后者用 `workflowIdOf(def)`（`default`）UPDATE 覆盖。当前顺序下不影响结果；但「wf」并不是任何已加载的 workflow，若未来在覆盖前新增读取，会得到 NOT_FOUND。
- 建议：初始 INSERT 直接写 `default`，或让 `bindRunVersion` 成为唯一的身份写入点并删除手写列。

### P2-6 run-node 未复核 run 绑定哈希

- 位置：`src/executor/run-node.ts:143-158`；对照 `src/service/commands/apply-report.ts:106-118`。
- 证据：run-node 只用 run 的 `workflow_id/version` 取策略，没有把 `runs.workflow_definition_hash` 与当前目录重算值比对；apply-report 有这道比对。正常路径由 load 的不可变约束与 hydrate 校验保证；只有手工把 `definition_json` 与 `content_hash` 一起改写的库才会出现「先按新策略执行、收口再挡下」的窗口。
- 建议：把同一哈希比对前移到 `policyForNodeRun`，不符直接 `WORKFLOW_VERSION_IMMUTABLE`，做 defense-in-depth。

## 七、预签态记录（预期内，不计候选缺陷）

clone 内在候选 HEAD 运行 `node --no-warnings scripts/gate-check.ts`（默认 G1），退出码 1，原文：

```text
门检查失败：审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：codebasemap.md
```

这是 `checkAuditAnchor` 的陈旧锚点：HEAD 的 G1 artifact 仍 `audit_round=47`、`audit_report=docs/audits/S1-independent-audit-round47.md`、`candidate_hash=5c1f4c72…`；第 47 轮报告绑定 `c17a0c76ed342364daf8972684e283290a3fbd00`，而 `c17a0c7..HEAD` 改了 `codebasemap.md`，所以锚点检查先失败。clone 内独立重算 13 份证据哈希全部一致、artifact_hash 自锚一致，说明失败点在审计报告的候选提交锚定，不在 R4 代码或证据复现。本轮按要求未改 `docs/gates`、未签门；重签由人按流程在第 48 轮审计后执行。

## 八、失败清单

P0 = 0，P1 = 0，P2 = 6；13 项必过项全部通过。

## 九、结构化裁决

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 48,
  "candidate_commit": "41a450f2fc6345345f7654ebe20daeebe58b37de",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 6,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": ["G1-01", "G1-02", "G1-03", "G1-04", "G1-05", "G1-06", "G1-07", "G-01", "G-02", "G-08", "G-09", "G-14", "G-15"],
  "failed_items": [],
  "notes": "R4 复合身份经真实 HTTP 探针验证：011 旧数据归 default 且哈希不变，同版本跨 workflow 的定义/策略/事件/收口严格隔离，单参歧义被拒，NULL 行归 default 一致；全量三次 612 passed | 1 skipped，25/25 证据复现成立，13/13 证据哈希一致。仅 6 条 P2，无 P0/P1。"
}
```
<!-- audit-verdict:end -->

## 十、剩余风险

- 上述 6 条 P2 中，P2-1 与 P2-2 都围绕「行键 / 快照 / 哈希三者谁算权威」。当前实现选择让哈希只覆盖 JSON、读取信任行键；正常 API 路径下三者由 load 同步写入，不会分叉。若后续加数据修复脚本或手工改库，需要先补交叉校验。
- 011 的升级路径本轮由临时探针覆盖，正式测试缺失（P2-4）；建议在重签前补上，避免后续迁移调整时回归。
- `docs/gates/G1.md` 仍锚第 47 轮，候选须在第 48 轮报告落库后按流程重签；本轮未修改门记录、未签门。
