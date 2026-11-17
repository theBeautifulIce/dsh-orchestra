# S1 独立审计报告 · G1 第 69 轮

门：G1
候选提交：4e751de6cf8fb681e7b7c4f40061400cabab0408
审计日期：2026-11-17
审计方式：独立只读审计；未签门、未改任何生产代码/测试/证据/门记录

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 69,
  "candidate_commit": "4e751de6cf8fb681e7b7c4f40061400cabab0408",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 5,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": [
    "G1-01",
    "G1-02",
    "G1-03",
    "G1-04",
    "G1-05",
    "G1-06",
    "G1-07",
    "G-01",
    "G-02",
    "G-08",
    "G-09",
    "G-14",
    "G-15"
  ],
  "failed_items": [],
  "notes": "G1 地基 13 项全过，无 P0/P1。本批（fd2173b..4e751de）集中在 S4 工作流定义/发布/task_local 与 dispatcher 依赖调度，G1 共享路径（migrations、driver、errors、config、建 run 入口）逐条对账未见回归；G-14 证据随 027/028 重新生成，check-evidence-repro 29/29 字节复现。P2 共 5 条：P2-1 为本轮新增——pnpm typecheck 退出码 2（tests/gate/gate-check.spec.ts:1737-1759 的 G4 注册块缺非空守卫，0519401 引入，一行可修，vitest 与 tsdown build 均为绿）；P2-2 至 P2-5 承接 r68 四条遗留（026 就地改写、026 量级口径、断链闸门覆盖面与人工出口、派发结果不落库），本轮相关代码均未改动，原样承接。"
}
```
<!-- audit-verdict:end -->

## 1. 审计基准

- 审计开始时主线 HEAD、候选提交、报告绑定提交三者同为 `4e751de6cf8fb681e7b7c4f40061400cabab0408`，工作树干净；本轮只读，没有改动任何候选文件。
- 上一轮基线为 `fd2173bb719068e94c3713e5b08703ea932dd08d`（S1 r68 结论为通过）。本轮 diff 范围 `fd2173b..4e751de` 共 39 个文件（+4257/−97），其余为 docs/audits、docs/gates、handoff 等收口文档。
- 生产代码变化集中在 S4：新增迁移 027/028、`src/core/workflow-def.ts`、`workflow-doc.ts`、`src/service/commands/workflows.ts` 与 `idempotency.ts`、`src/service/workflows.ts` 的目录与发布链路、`server.ts`/`schemas.ts` 新路由与 UUIDv7 幂等、`runs.ts` 建 run 入口的依赖闭包与预留任务、`dispatcher.ts` 依赖放行。G1 共享路径里的 `driver.ts`、`errors.ts`、`config.ts` 与迁移 001–026 均不在变更清单内。
- 必过项全集取自 `scripts/gate-check.ts` 的 `GATE_SPECS.G1.items`（13 项），与裁决块 `must_pass_ids` 逐一相等、无重复、无规格外项。
- 未做全局重审：只沿本轮改动直接影响的调用路径展开，并对 G1 的 13 项逐项对账；上一轮 4 条 P2 逐条复核。

## 2. 实测（本人亲自执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 2 | `tsc --noEmit` 报 12 条 TS 诊断（`tests/gate/gate-check.spec.ts` 的 TS18048×11、TS2532×1），定位与定级见 P2-1 |
| `npx vitest run` | 0 | 78 个文件全过；1022 passed / 1 skipped（共 1023）；耗时 24.04s |
| `pnpm build` | 0 | tsdown：ESM `lib/index.js` 344.38 kB（gzip 82.64 kB）、`lib/index.d.ts` 26.10 kB；CJS `lib/client.js` 0.29 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 29 份证据每份重跑两遍与 HEAD 字节一致（含 G3/G4 注入摘要） |

## 3. 上一轮 4 条 P2 逐条复核

| 编号 | 上轮问题 | 本轮判定 | 依据 |
| --- | --- | --- | --- |
| r68 P2-1 | 迁移 026 就地改写，应用过旧 026 的库升级会被迁移校验和挡在启动 | 未改，仍成立 | `migrations/026_recovery_units.sql` 不在 `fd2173b..4e751de` 变更清单内，口径与边界同 r68 记录 |
| r68 P2-2 | 026 量级口径把真纳秒小值放大、模糊带保留毫秒值 | 未改，仍成立 | 同上，026 未动 |
| r68 P2-3 | 断链闸门只装状态推进入口，只记事件的 append 不验链；断链节点人工出口是账本核对 | 未改，仍成立 | `cancel.ts`、`recovery.ts` 不在变更清单内；`subworkflow.ts` 仅增 3 行 `assertWorkflowUsable` 归属闸，不触及 append 路径 |
| r68 P2-4 | 断链 queued 节点的派发结果不落库，库里仍留 queued，缺只读清单 | 未改，仍成立 | `dispatcher.ts:245-252` 的 catch 仍只收结果不落库（行号较 r68 的 196-204 因依赖闸新增而位移）；新增 `failQueuedNode` 只覆盖配置类确定性错误 |

## 4. 本轮改动逐项审查（G1 视角）

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| `migrations/027_workflow_tables.sql`、`028_workflow_draft_lifecycle.sql` | 正确 | 只加表/加列/加索引/加触发器，不动既有列与数据；`workflow_versions` 的 update 与 replace 两条触发器与 011 主键口径一致，生产写路径（`workflows.ts:148-158` 目录落库、`commands/workflows.ts:390` 发布插入）都不做 UPDATE/REPLACE，重复登记在 `persisted` 分支早退 |
| 建 run 入口 `runs.ts`（`createRun` 与 `reserveTask`） | 正确 | 依赖闭包校验只在 `nodeIds` 给定时生效；预留任务绑定走 `status='reserved' AND current_run_id IS NULL` 的 CAS，一个预留只消费一次；`assertWorkflowUsable` 与 task_local 根入口闸对没有 `workflows` 行的旧工作流是空操作，S1–S3 旧调用路径不变 |
| `dispatcher.ts` 依赖放行（`readinessOf`） | 不触及 G1 共享路径 | 只对带 `edges` 的定义生效，取不到目录或定义时回退全量派发；缺前置时经 `failQueuedNode`（走 `applyTransition` 的 M-48）收口并留事件。成功子集与失败侧传播的细节见 §7 第 3 条 |
| `server.ts:212` 认证顺序 | 正确 | `authenticate` 仍在全部路由前调用，新 S4 写路由的 actor 取自认证主体并走写队列；G1-06 的认证口径不变 |
| `scripts/gate-check.ts` | 正确 | G1 的 items/content/invariants/evidenceMap 全集不变；excludes 补 `docs/gates/G4.md`，与 G4 注册配套；`DEFAULT_GATE_PATHS` 覆盖四道门 |
| `docs/gates/evidence/G1/G-14.md` 重新生成 | 正确 | 表数 26→28、`schema_migrations` 补 27/28，随 027/028 而变；`check-evidence-repro` 29/29 复现成立。门记录里的 ev-g14 哈希待重签时更新，属预签态 |

## 5. 13 项必过项

| 必过项 | 要求 | 结果与证据 |
| --- | --- | --- |
| G1-01 | 迁移空库可重复 | 满足；`migrate.spec.ts` 随全量通过，001–028 全链记账后重跑不再执行 |
| G1-02 | 迁移中途杀可重入 | 满足；`driver.ts:104-115` 每步一个事务，G-14 证据重生成后 29/29 复现一致 |
| G1-03 | 进程杀不丢已提交事件 | 满足；`g1.spec.ts` 的 G-02 用例与证据 `ev-g02` 同时成立 |
| G1-04 | 备份独立目录行数与哈希一致 | 满足；`backup.spec.ts` 随全量通过，本轮未触及备份路径 |
| G1-05 | 损坏备份可检出 | 满足；`backup.spec.ts` 覆盖清单/文件/表摘要三类不一致 |
| G1-06 | 认证拒匿名写 | 满足；`auth.spec.ts` 随全量通过；`server.ts:212` 认证顺序不变，新路由同口径 |
| G1-07 | 阶段开关拒未知值 | 满足；`config.spec.ts` 随全量通过，`config.ts` 未改动 |
| G-01 | 事务 COMMIT 前杀进程 | 满足；`g1.spec.ts` G-01 用例与证据 `ev-g01` 一致 |
| G-02 | COMMIT 后未投递被杀 | 满足；`g1.spec.ts` G-02 用例与证据 `ev-g02` 一致 |
| G-08 | 长事务期间读不被拖死、写报 busy、队列溢出报 503 | 满足；`g1.spec.ts` G-08 用例随全量通过，写队列语义未变 |
| G-09 | 订阅者离线重放 | 满足；证据 `ev-g09` 复现一致 |
| G-14 | 迁移一半杀后重跑 | 满足；`fault-inject.ts` 的 G-14 用例重新生成（26→28 表），`check-evidence-repro` 29/29 一致 |
| G-15 | 备份截断可检出、恢复被拒、线上库不变 | 满足；证据 `ev-g15` 与 `backup.spec.ts` 一致 |

## 6. 不阻断问题（P2）

| 编号 | 位置 | 说明 | 影响与延期理由 |
| --- | --- | --- | --- |
| P2-1 | `tests/gate/gate-check.spec.ts:1737-1759`（0519401 引入） | G4 注册用例直接取 `GATE_SPECS.G4.*` 与 `GATE_SPECS[gate].*`，在 `tsconfig.json:8` 的 `noUncheckedIndexedAccess` 下是 `GateSpec 或 undefined`，`pnpm typecheck` 报 TS18048×11、TS2532×1，退出码 2 | 运行期零影响（vitest 1022 例通过、tsdown 构建通过），代价是三步自检第一步挂住、ev-gatecheck 不再被类型系统校验。按 §5 影响五类不构成业务行为错误，定 P2；修复是一行（非空断言或先判空），建议下一批先修再跑 `pnpm check` |
| P2-2 | `src/infra/sqlite/migrations/026_recovery_units.sql`（承接 r68 P2-1） | 026 在引入后的下一批被就地改写，应用过旧 026 的库升级会被迁移校验和挡在启动（`SCHEMA_VERSION_UNSUPPORTED`） | 仓库内无持久库，三门基线不含 026，沿用 r68 的延期理由；若确认曾有库应用过旧 026，应升 P1 并把数据修正排到新编号（027/028 已占用） |
| P2-3 | `migrations/026_recovery_units.sql:22-28,50-54`（承接 r68 P2-2） | `<1e6` 档不区分旧毫秒与真纳秒小值，一律乘 1e6；模糊带对 `watchdogMs` 大于约 16.7 分钟的旧毫秒行保留原值 | 真纳秒小值只能来自未签中间提交的 `refreshCheckpointsInTx`，已签基线写不出该形状；沿用 r68 延期理由，建议在 029 里按到期或不确定处理 |
| P2-4 | `src/service/commands/cancel.ts:166,207,216,228`、`subworkflow.ts:781`、`recovery.ts:64`（承接 r68 P2-3） | 断链闸门只装状态推进与收口入口，只记事件的 append 不验链；断链节点的人工出口是账本核对而非 `resolve` | 断链只能由外部篡改造出，系统侧置不确定的路径已跳过断链节点；沿用 r68 延期理由，建议闸门下沉到 `appendNodeRunEvent` 或文档写明口径 |
| P2-5 | `src/service/dispatcher.ts:245-252`（承接 r68 P2-4） | 断链 queued 节点的 `acquireLease` 抛 FORBIDDEN，catch 收成结果而不落库，库里仍是 queued；仍没有只读断链清单 | 断链需要人工处理，分叉不造成数据损坏；沿用 r68 延期理由，建议补只读清单或并入 `/v1/verify` |

## 7. 一般建议（不计数）

- `applyTransition` / `transitionNode` / `closeRun` 的整链校验累计是 O(n²)，长链节点与高频扫描下会放大开销；建议加链头缓存（承接 r68）。
- `tests/integration/recovery-unit-migration.spec.ts:2` 的注释仍写旧口径，属注释漂移（承接 r68）。
- `dispatcher.ts:105` 的 `SUCCESS_STATUS` 混合了节点态与 run 级态（`succeeded`、`succeeded_with_unverified` 不属于 `node_runs.status` 枚举），生效成员只有 `done`；且前置落在失败侧终态时依赖节点保持排队，等待 run 收口处置。属 S2/S4 调度语义，建议在对应轮次对齐 `state-machine.ts` 的终态定义并补失败传播口径。

## 8. 测试与质量证据

- 已实测：§2 的四条命令；G1 相关用例（`config.spec.ts`、`migrate.spec.ts`、`db-open.spec.ts`、`backup.spec.ts`、`g1.spec.ts`、`auth.spec.ts`、`hash-chain.spec.ts`）随 78 文件全量通过。
- 定级说明：P2-1 的影响面是验证工具链（类型检查步骤）而非运行期业务路径，vitest 与构建两步均为绿；按 §5 影响五类定 P2，已在 §6 记录并给出修复与验证方案。
- 未实测：多实例并发与长时间浸泡；也没有持久库可复核 P2-2 的升级影响面。

## 9. 阶段结论

结论：通过。

G1 的 13 项必过全过，证据复现 29/29 与 HEAD 字节一致；本批 S4 与调度改动没有触及 G1 共享路径，上一轮 4 条 P2 原样承接，本轮新增 P2-1（`pnpm typecheck` 退出码 2）一条，P0/P1 均为 0。建议：下一批先修 P2-1 再跑 `pnpm check` 与重签门记录，然后结束本轮 G1 收敛审计，转入下一阶段开发。

## 10. 落盘自检

`parseAuditVerdict`、`verdictProblems`、`auditBindingOf`、`proseVerdictClashes`、`auditConclusionOf` 均按 `src/core/audit-verdict.ts` 与 `scripts/gate-check.ts` 的实际导出签名实跑（探针 `tmp/s1r69-selfcheck.mjs`，交付前已删），输出如下（parse 的 `notes` 字段与裁决块一致，此处略去重复文本）：

```text
> node --experimental-strip-types --no-warnings tmp/s1r69-selfcheck.mjs
parse {"verdict":{"schema":"audit-verdict/1","gate":"G1","audit_round":69,"candidate_commit":"4e751de6cf8fb681e7b7c4f40061400cabab0408","conclusion":"pass","p0":0,"p1":0,"p2":5,"must_pass_total":13,"must_pass_passed":13,"must_pass_ids":["G1-01","G1-02","G1-03","G1-04","G1-05","G1-06","G1-07","G-01","G-02","G-08","G-09","G-14","G-15"],"failed_items":[],"notes":"（略）"}}
verdictProblems 0 []
binding {"gate":"G1","commit":"4e751de6cf8fb681e7b7c4f40061400cabab0408"}
proseVerdictClashes 0 []
auditConclusionOf pass
```
