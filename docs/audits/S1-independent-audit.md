# S1 独立审计报告

- 审计对象：`D:\aboutAI\dsh-orchestra` S1（账本与状态机地基）
- 候选提交：`61b43db311b540532ac6b09c1943fc2551a3d07e`
- 审计时间：2026-11-13
- 审计方式：全部结论来自实际执行命令或实际读文件；临时库与临时脚本放在系统临时目录，已删除。

## 一、命令实测结果

```
pnpm check  → exit 0
  typecheck：0 错
  vitest：Test Files 12 passed (12) / Tests 93 passed (93)，780ms
  build：lib/index.js 0.10 kB、lib/index.d.ts 0.10 kB、lib/client.js 0.29 kB
         迁移 SQL 已复制到 lib/infra/sqlite/migrations/001_init.sql

pnpm gate   → exit 0
  gate G1 通过（13 项必过，artifact_hash=0dd41ff1713a…）
```

两条命令在攻破测试恢复原文件之后重跑，均通过，`git status` 干净（审计报告本身除外）。

## 二、13 项逐项判定

| 编号 | 判定 | 证据 | 备注 |
| --- | --- | --- | --- |
| G1-01 迁移空库可重复 | pass | `tests/migrate.spec.ts`（sha256 e6705dd9…） | 6 条用例；数据层实测 first=1、second=0、schema_migrations=1 |
| G1-02 迁移中途杀可重入 | pass | `docs/gates/evidence/G1/G-14.md`、`scripts/fault-inject.ts:198-225` | 真子进程杀，重跑只补 902，schema_migrations=[1,901,902] |
| G1-03 进程杀不丢已提交事件 | pass | `docs/gates/evidence/G1/G-02.md:21`、`src/infra/db/ledger.ts:17-27` | COMMIT 后 SIGKILL，重放拿到 evt_committed |
| G1-04 备份行数与哈希一致 | pass | `tests/backup.spec.ts`（8b8d5413…）、`src/infra/backup.ts` | manifest 含 db_sha256 与十表 rows/sha256 |
| G1-05 损坏备份可检出 | pass | `docs/gates/evidence/G1/G-15.md`、`src/infra/backup.ts`（verifyBackup） | 数据层实测改 1 字节 → SERVICE_UNAVAILABLE，details.table="(db_file)" |
| G1-06 认证拒匿名写 | pass | `tests/auth.spec.ts`（43131a1c…）、`src/service/server.ts:20-30` | 12 条；数据层实测缺/错 secret 均 401 UNAUTHORIZED |
| G1-07 阶段开关拒未知值 | pass | `tests/config.spec.ts`（68e7e58d…）、`src/core/config.ts` | 数据层实测 phase=S7 → SCHEMA_VERSION_UNSUPPORTED |
| G-01 COMMIT 前杀进程 | pass | `docs/gates/evidence/G1/G-01.md:20`、`fault-inject.ts:83-105` | 未提交事务不留半条记录：true |
| G-02 COMMIT 后未投递被杀 | pass | `G-02.md:21`、`fault-inject.ts:107-130` | 重放 1 条，总条数 2 |
| G-08 长事务与队列溢出 | **fail** | `src/service/server.ts:84-88`、`src/service/write-queue.ts`、`fault-inject.ts:152` | WriteQueue 在 `src/` 内零引用，服务写路径直接调 appendLedgerEvent；1000 上限与 503 在真实写路径不可达；无 warning 日志（见问题 M2） |
| G-09 订阅者离线重放 | pass | `G-09.md:23`、`fault-inject.ts:175-196` | 重放 seq=2,3,4，连续无断号 |
| G-14 迁移一半杀后重跑 | pass | `G-14.md:20`、`fault-inject.ts:198-225` | 重跑只补 [902]，第一步不重复 |
| G-15 备份截断后恢复被拒 | **存疑** | `G-15.md:20`、`tests/integration/g1.spec.ts:39-43` | 证据显示线上库 sha 89a2318c…→97aec5de…、size 4096→126976，与用例标题「线上库不变」相悖；用例只断言「截断」「线上库」两个词，未断言恢复被拒、未断言线上库不变 |

12 个证据文件当前 sha256 与 G1.md 表中的前 16 位全部一致（G-01 bba2aa52…、G-02 9d36316a…、G-08 5fede6cd…、G-09 91eb112f…、G-14 8a74422c…、G-15 634d73e0…；tests auth 43131a1c…、backup 8b8d5413…、hash-chain e15bb381…、db-open 78263f1c…、migrate e6705dd9…、config 68e7e58d…），但这是人工核对的结果，门检查命令不验证（见 F1）。

## 三、问题清单

### 致命

**F1　门检查完全不校验证据文件，证据可被静默改写而门仍通过。**
- 复现：在 `docs/gates/evidence/G1/G-15.md` 末尾追加一行 → `pnpm gate` 仍 exit 0，输出「gate G1 通过（13 项必过，artifact_hash=0dd41ff1713a…）」。
- 位置：`scripts/gate-check.ts:16-54` 只做 JSON 块/字段/结论/锚点校验，没有任何 `readFileSync` 证据文件、没有 sha256 比对。
- 规格：§15.1 行 1192「没有证据索引与必过项清单，不算门记录」；§15.2 行 1204-1206 要求 evidence_index_hash 的原像逐项含 `{evidence_id, sha256, strength, source}`。
- 现状：G1.md 的「证据文件与哈希」表是人读的，且只有 16 位前缀；artifact 里 `evidence_index_hash`（G1.md:74）在仓库中找不到任何原像（全仓 grep 只命中规格样例与计划伪码）。因此这个值既不可复算，也不与那张表建立机器关系。
- 影响：门记录的「13 项必过」只是人工声明，任何人改完证据内容都无需重签即可保持通过；这正是审计要防的事。

### 重大

**M2　G-08 的写队列没有接入服务写路径，必过项实质上未落地。**
- `src/service/server.ts:84-88`：POST `/v1/ledger/events` 直接 `deps.appendLedgerEvent(body, actor)`。
- `src/` 内 `WriteQueue` 只有定义处 `src/service/write-queue.ts:4`，没有任何 import；唯一实际使用是 `scripts/fault-inject.ts:152` 的 `new WriteQueue(2)`，属模块级自测。
- 规格 §12.3 行 1067：G-08 要求「写路径有上限与溢出策略；读不被拖死；超限有明确错误」；§17.2 行 1386：上限 1000、满返回 503 并记 warning。
- 另外 `src/service/write-queue.ts:16-19` 抛错前没有 logger 调用，「记 warning」未实现。
- 影响：真实服务在并发写时没有 1000 上限、没有 503、没有 warning；G-08 的 503 证据来自直接构造的队列对象，不代表服务行为。

**M3　GateArtifact 里三个哈希字段没有原像，无法独立复算。**
- `docs/gates/G1.md:73-75`：`change_scope_hash`、`evidence_index_hash`、`invariants_hash` 三个 64 位 hex 值；`gate-check.ts` 只检查字段存在，从不重算。
- 全仓 grep 不到 `capability_ids`/`touched_paths` 清单、`evidence_index` 数组、`invariants` 数组（只有规格 §15.2 的样例和 S6 计划里的伪码）。`G1.md:63` 写「原像见 invariants_hash」是循环引用——哈希值本身不含原像。
- 后果：审计员只能信这三个值，无法发现它们是否与真实改动范围/证据/不变量核对一致。

**M4　门检查不固定必过项清单，删项后重签锚点仍通过。**
- 探针（纯内存，不改磁盘）：读 G1.md，把 `must_pass_items` 截成 1 项，按 `sha256Hex(canonicalJson(artifact))` 重算锚点，`verifyGateRecord` 返回 pass，`items=1`。
- 位置：`scripts/gate-check.ts:29-37` 只要求数组非空、每项 pass、有 evidence_ids，不与 §11.2 行 943 的 13 项清单比对。
- 后果：13 项必过可以被无声删减，只要重算锚点。

**M5　G-15 的必过证据与断言不符，恢复被拒没有被测试强制。**
- `docs/gates/evidence/G1/G-15.md:20`：线上库 `{"size":4096,"sha":"89a2318c…"}→{"size":126976,"sha":"97aec5de…"}`；原因是 `backup()` 里的 `wal_checkpoint(TRUNCATE)` 改了线上库文件字节。
- 用例标题是「线上库不变」（`tests/integration/g1.spec.ts:39`），但断言只有 `toContain('截断')` 与 `toContain('线上库')`（:41-42）。若 restore 不再拒绝、或线上账本被污染，只要输出里仍出现这两个词，测试照样绿。
- 规格 §12.3 行 1074 要求 G-15「独立目录校验能检出；不污染线上账本」。

### 轻微

**m1　handoff 的 spec 文件数多算 1。** `handoff.md:265` 写「tests/（13 个 spec，93 条用例）」，实际 12 个 spec 文件（`tests/*.spec.ts` 11 个 + `tests/integration/g1.spec.ts`），93 条用例数正确；vitest 输出也是 12 个文件。

**m2　G-01 证据内嵌已失效的临时绝对路径。** `docs/gates/evidence/G1/G-01.md:3` 的 `"db":"C:\\Users\\ASUS\\AppData\\Local\\Temp\\orchestra-g1-sbeMAp\\orchestra.db"` 是生成机临时目录，现已不存在，证据无法按原参数复现。

**m3　/events 的 limit 上限两层不一致。** `src/service/server.ts:80` 截到 500，查询层 `src/service/queries/list_events.ts:5` 上限 200（规格 §8.3 行 637 是 200）；请求 `limit=201..500` 会走 RANGE_TOO_LARGE 报错，而不是按规格截到 200。

**m4　游标未接到 HTTP，且过期判断可被未来时间绕过。** `src/service/server.ts:12` 的 `listTasks` 只接 `limit`，服务不接收 cursor；`src/service/queries/cursor.ts:37` 只判断 `now - issued_at > TTL`，伪造 `issued_at` 为未来值时永不过期（游标本身也未签名）。S1 必过项不含游标，故不阻断门，但「只读查询、游标」的交付只到模块级。

**m5　证据表有两条悬空项。** G1.md 证据表列了 12 条，其中 `ev-chain`、`ev-epoch` 没有被任何必过项的 evidence_ids 引用。

### 措辞

**w1　偏离计数口径不一致。** `G1.md:191` 写「计划外偏离六处」，`handoff.md:271` 写「七处」；后者把「证据文件改覆盖写」算作第七处，前者把它单列在 `G1.md:192`。两处都对，但并读会打架。

**w2　「原像见 invariants_hash」措辞误导。** `G1.md:63` 应写成「不变量清单见 …」；哈希值里没有原像。

## 四、反作弊与攻破测试

### 反作弊扫描
- `tests/` 下没有 `.skip`、`.todo`、`.only`。
- 5 处 `catch` 全是「本应抛错却通过了」的辅助函数（`tests/backup.spec.ts:36-44`、`tests/config.spec.ts:19-27`、`tests/db-open.spec.ts:21-29`、`tests/migrate.spec.ts:27-35`、`tests/queries.spec.ts:39-42`），非空 catch 抛错，未吞错。
- `toBeTruthy` 两处是存在性断言（`tests/queries.spec.ts:65`、`tests/db-open.spec.ts:73`），可接受。
- 断言强度总体扎实；弱点集中在 G-08（未断言读路径 readOk）与 G-15（只断言两个词）。
- `scripts/fault-inject.ts` 不是写死 pass：真子进程、READY 后 SIGKILL、15s 超时、真 sqlite 操作（:47-81），G-01/G-02/G-08/G-09/G-14/G-15 各自算真实对账值；但 G-15 的结论只由字符串拼接输出，测试不强制（见 M5）。

### 攻破测试（每次都恢复并复核）
1. 把 G1.md 中 G-08 的 `result` 由 pass 改 fail → `pnpm gate` exit 1：「门检查失败：必过项没过: G-08」。
2. 把 GateArtifact 的 `candidate_hash` 改成 64 个 a、锚点不动 → exit 1：「artifact_hash 与正文不符：0dd41ff1… != c5655f52…」。
3. 只在 `docs/gates/evidence/G1/G-15.md` 末尾追加一行、门记录不动 → exit 0，门仍通过（F1）。
4. 纯内存删到 1 项必过项并重算锚点 → `verifyGateRecord` 返回 pass，`items=1`（M4）。
5. 恢复：因 `core.autocrlf=true`，`git checkout` 会把 LF 改成 CRLF；改用 `git cat-file blob HEAD:<path>` 写回原始字节。恢复后 G-15.md = 717 字节 sha256 `634d73e031dde92b5a4db227ef8c8e5c6b850d7e5c0b42d7b4a330e2941f4909`（与 G1 表一致），`pnpm gate` 回到 exit 0，`git status` 干净。

## 五、数据层实测（Node 26，临时库，脚本已删）

| # | 项目 | 结果 | 实测输出 |
| --- | --- | --- | --- |
| 1 | 迁移可重复执行 | pass | steps=1，first=1，second=0，schema_migrations=1 |
| 2 | 事件哈希链被篡改后 verifyLedger 检出 | pass | before `{ok:true,chains:1,entries:3,break:null}`；改第 2 条 payload 后 `{ok:false,chains:1,entries:3,break:{node_run_id:"n1",seq:2,reason:"hash 对不上，内容被改过"}}` |
| 3 | 备份改一字节 verifyBackup 报错 | pass | 抛 SERVICE_UNAVAILABLE，details.table="(db_file)" |
| 4 | 缺/错 secret 写接口 401 | pass | 缺 `[401,UNAUTHORIZED]`；错 `[401,UNAUTHORIZED]`；对 `[200,true,"service:266739a2"]` |
| 5 | 阶段未知值被拒 | pass | phase=S7 抛 SCHEMA_VERSION_UNSUPPORTED；原配置 phase=S1 |

## 六、规格一致性差异

- §17.1 错误码表（行 1288-1372）85 条 vs `src/core/errors.ts` 85 条：条数一致，missing=[]、extra=[]、statusDiff=[]，逐条码名与 HTTP 状态完全一致。
- §11.2 行 943 的 13 项必过文字与 G1.md 表格逐项对应，无缺项。
- 除 §17.1 外的其他不一致：
  1. §15.2 行 1204-1206 的 evidence_index 原像不存在（M3/F1）；
  2. §8.3 行 637 的 events limit 200 与 server.ts:80 的 500 不一致（m3）；
  3. §8.3 行 638 的 cursor 只到模块级、HTTP 不可达，且未来 issued_at 绕过过期（m4）；
  4. §17.2 行 1386 的写队列上限/503/warning 未接入真实写路径（M2）；
  5. §12.3 行 1067 G-08「写路径有上限与溢出策略」在服务层不成立（M2）。

## 七、handoff 偏离核对

| 偏离声明（handoff.md:271） | 实际核对 | 判定 |
| --- | --- | --- |
| 提交顺序 Task 2→1→3 | git 历史 07dc600（errors, Task2）→595300f（config, Task1）→b30e772（canonical, Task3），与计划行 177/37/297 对应 | 属实 |
| driver 补 service_meta/schema_migrations BOOTSTRAP | `src/infra/sqlite/driver.ts` 的 BOOTSTRAP 建这两张表 | 属实 |
| uuidv7 用 16 字节 | `src/core/ids.ts` randomBytes(16)，版本位 7、variant 10 | 属实 |
| cursor 加 issued_at | `src/service/queries/cursor.ts:12,15,37` | 属实 |
| 新增 write-queue | `src/service/write-queue.ts:4-26`，默认 max=1000，满抛 SERVICE_UNAVAILABLE | 模块属实，但未接入服务（M2） |
| tsdown 用 glob 复制迁移 SQL | `tsdown.config.ts:27`；build 后 `lib/infra/sqlite/migrations/001_init.sql` 存在 | 属实 |
| 证据文件改覆盖写、测试不写证据 | `scripts/fault-inject.ts:25-32` 覆盖写 docs | 属实 |
| （同段）tests/ 13 个 spec | 实际 12 个（11 个顶层 + integration/1），93 条用例对 | 文件数多算 1（m1） |

## 八、结论

**G1 建议：不通过。**

理由按分量排序：
1. 门检查不验证证据文件（F1），且必过项清单不被固定（M4）、三个哈希无原像（M3）。这使「13 项必过、证据齐全」成为人工声明而非可复核事实；改证据、删项都能保持通过。
2. G-08 的写队列没有接入服务写路径（M2），§12.3 行 1067 与 §17.2 行 1386 的要求在真实服务上不成立，13 项必过里这一项应判 fail。
3. G-15 的证据与用例标题自相矛盾，恢复被拒没有被测试强制（M5），该必过项只能判存疑。

修复建议（按顺序）：
1. `scripts/gate-check.ts` 增加：按 evidence 表/evidence_index 逐文件重算 sha256 并与记录比对；把必过项 id 集合与 §11.2 的 G1 清单比对；至少校验 evidence_index_hash 的原像（或在 artifact 中放 evidence_index 数组再算哈希）。
2. 给 change_scope / invariants 建立真实原像文件并纳入重算，或按规格允许的方式明确置空并说明。
3. 把 `WriteQueue` 接进 POST `/v1/ledger/events`，满 1000 返回 SERVICE_UNAVAILABLE(503) 并写 warning 日志；补一条服务级用例。
4. 强化 `tests/integration/g1.spec.ts`：G-15 断言 restore 抛错且线上库事件数与逻辑哈希不变（比较备份前后 events 内容，而非 DB 文件字节）；G-08 断言 readOk=true。
5. 重生成 G-15 证据（或改标题口径为「线上账本逻辑不变」），修正 handoff 的 spec 文件数。
6. 修完重签 `artifact_hash`，再走一轮独立审计。

---

审计过程未修改任何业务代码、依赖或提交；唯一新增文件是本报告。
