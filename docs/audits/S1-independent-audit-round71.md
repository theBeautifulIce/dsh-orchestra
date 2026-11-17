# S1 独立审计报告 · G1 第 71 轮

门：G1
候选提交：32517a5287df6221d3f9024efa4adc074efea8d3
审计日期：2026-11-17
审计方式：独立只读审计；未签门、未改任何生产代码/测试/证据/门记录

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 71,
  "candidate_commit": "32517a5287df6221d3f9024efa4adc074efea8d3",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 4,
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
  "notes": "本批（4ecff7a..32517a5）是 S3 r22 P2-7 的定点修复批次：BLOCKED_TERMINAL 由硬编码 8 成员改从 state-machine TERMINAL_STATUSES 减 SUCCESS_STATUS 派生 6 成员，剔除误列的非终态 indeterminate_side_effect（M-51/M-59 裁决可达 done）与状态机外幽灵成员 cancelled（node_runs.status 无此值），修掉裁决窗口内对后置的过界结算；workflow-g4.spec.ts 补场景三回归并按 P3-2 收紧场景二断言。G1 共享路径（migrations、driver、errors、config、auth）与 G1 证据文件零改动，13 项必过沿用 r70 结论全过。P2 承接 4 条（r70 P2-1 至 P2-4：026 就地改写、026 量级口径、断链闸门覆盖面、派发结果不落库），相关文件本批均未改动。证据复现 29/29 字节一致。"
}
```
<!-- audit-verdict:end -->

## 1. 审计基准

- 审计开始时主线 HEAD、候选提交、报告绑定提交三者同为 `32517a5287df6221d3f9024efa4adc074efea8d3`，工作树干净；本轮只读，没有改动任何候选文件。
- 上一轮基线为 `4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f`（S1 r70 结论为通过）。本轮 diff 范围 `4ecff7a..32517a5` 共 8 个文件（+634/−13）：生产代码 1 个（`src/service/dispatcher.ts`，常量定义区 8 行）、测试 1 个（`tests/integration/workflow-g4.spec.ts`），其余 6 个为 `docs/audits/` 与 `docs/gates/G4.md` 收口文档，全在 `GATE_SPECS.G1.excludes` 排除清单内。
- G1 共享路径逐一对账：`src/infra/sqlite/migrations/`、`src/infra/sqlite/driver.ts`、`src/core/errors.ts`、`src/core/state-machine.ts`、配置与认证模块均不在变更清单内。
- G1 证据文件（`GATE_SPECS.G1.evidenceFiles`）逐一对账零改动；本批测试改动 `tests/integration/workflow-g4.spec.ts` 不在 G1 证据清单内。
- 必过项全集取自 `scripts/gate-check.ts` 的 `GATE_SPECS.G1.items`（13 项），与裁决块 `must_pass_ids` 逐一相等、无重复、无规格外项。
- 上一轮 P2 清单 4 条（r70 P2-1 至 P2-4）原样承接，相关文件本批零改动。

## 2. 实测（本人亲自执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc --noEmit` 零诊断 |
| `npx vitest run` | 0 | 78 个文件全过；1023 passed / 1 skipped（共 1024）；耗时 12.90s |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 29 份证据每份重跑两遍与 HEAD 字节一致（含 G3/G4 注入摘要） |

## 3. delta 隔离性（G1 面逐一对账）

- `git diff 4ecff7a..HEAD --stat` 的 8 个文件分三类：①生产代码 `src/service/dispatcher.ts`（仅常量定义区）；②测试 `tests/integration/workflow-g4.spec.ts`；③候选外文档 6 个（`docs/audits/S1-independent-audit-round70.md`、`docs/audits/S2-independent-audit-round71.md`、`docs/audits/S3-independent-audit-round22.md`、`docs/audits/S4-independent-audit-round1.md`、`docs/audits/S4-independent-audit-round2.md`、`docs/gates/G4.md`）。
- migrations、driver、errors、config、auth 五个 G1 面路径组合 `git diff --stat` 为空，逐字未动；`src/core/state-machine.ts` 本批也零改动（dispatcher 只是新增一行只读 import `TERMINAL_STATUSES`）。
- `src/service/dispatcher.ts` 的 diff 只有常量定义与类型标注（`SUCCESS_STATUS`/`BLOCKED_TERMINAL` 改 `ReadonlySet<string>` 并派生），`readinessOf` 主体、`failQueuedNode` 收口、`dispatchOne` catch 块、`closeRun` 调用全部未动。
- 由上可见：本批 delta 与 G1 面完全隔离，13 项必过的被测对象与证据零变化。

## 4. 本轮改动逐项审查（G1 视角）

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| `src/service/dispatcher.ts` | 不触及 G1 共享路径 | `BLOCKED_TERMINAL` 从硬编码 8 成员改为 `TERMINAL_STATUSES.filter(status => !SUCCESS_STATUS.has(status))` 派生 6 成员（failed、timeout、abandoned_unverified、failed_with_unverified、orphaned、superseded）：剔除误列的非终态 `indeterminate_side_effect`（M-51/M-59 裁决可达 done，前置不确定时后置必须继续等）与状态机外的幽灵成员 `cancelled`（`node_runs.status` 枚举无此值），修掉 S3 r22 P2-7 记录的裁决窗口过界结算。收口仍走 `failQueuedNode`（M-48 + `appendNodeRunEvent`），`dispatchOne` catch 块与 `closeRun` 调用逐字未动，状态机闭合不变 |
| `tests/integration/workflow-g4.spec.ts` | 正确 | 场景三（S3 r22 P2-7 回归）：前置停在 `indeterminate_side_effect` 时后置断言留 `queued`、run 断言留 `running`，M-60 换行 done 后后置放行；场景二断言按 S3 r22 P3-2 收紧：b 不仅要离开 `queued`，末条事件还不得带 `RESOLUTION_NOT_AVAILABLE`，区分「放行执行」与「前置结算」两条路径 |
| `docs/audits/` 六件、`docs/gates/G4.md` | 候选外 | 全部在 `excludes` 清单内：S1 r70 / S2 r71 / S3 r22 / S4 r1、r2 报告与 G4 门记录收口（`ev-g4-14` 增补与结论措辞中性化属 G4 面），不影响 G1 候选哈希 |

## 5. 13 项必过项

| 必过项 | 要求 | 结果与证据 |
| --- | --- | --- |
| G1-01 | 迁移空库可重复 | 满足；`migrate.spec.ts` 随全量通过，迁移文件本批零改动 |
| G1-02 | 迁移中途杀可重入 | 满足；`driver.ts` 未改动，证据复现 29/29 一致 |
| G1-03 | 进程杀不丢已提交事件 | 满足；`g1.spec.ts` G-02 用例与证据 `ev-g02` 一致 |
| G1-04 | 备份独立目录行数与哈希一致 | 满足；`backup.spec.ts` 随全量通过，本批未触及备份路径 |
| G1-05 | 损坏备份可检出 | 满足；`backup.spec.ts` 覆盖三类不一致 |
| G1-06 | 认证拒匿名写 | 满足；`auth.spec.ts` 随全量通过，认证模块未改动 |
| G1-07 | 阶段开关拒未知值 | 满足；`config.spec.ts` 随全量通过，`config.ts` 未改动 |
| G-01 | 事务 COMMIT 前杀进程 | 满足；`g1.spec.ts` G-01 用例与证据 `ev-g01` 一致 |
| G-02 | COMMIT 后未投递被杀 | 满足；`g1.spec.ts` G-02 用例与证据 `ev-g02` 一致 |
| G-08 | 长事务期间读不被拖死、写报 busy、队列溢出报 503 | 满足；`g1.spec.ts` G-08 用例随全量通过 |
| G-09 | 订阅者离线重放 | 满足；证据 `ev-g09` 复现一致 |
| G-14 | 迁移一半杀后重跑 | 满足；证据 `ev-g14` 与 `check-evidence-repro` 29/29 一致 |
| G-15 | 备份截断能检出、恢复被拒、线上库不变 | 满足；证据 `ev-g15` 与 `backup.spec.ts` 一致 |

## 6. 不阻断问题（P2）

| 编号 | 位置 | 说明 | 影响与延期理由 |
| --- | --- | --- | --- |
| P2-1 | `src/infra/sqlite/migrations/026_recovery_units.sql`（承接 r70 P2-1） | 026 在引入后的下一批被就地改写，应用过旧 026 的库升级会被迁移校验和挡在启动 | 仓库内无持久库，三门基线不含 026；本批迁移目录零改动，沿用 r70 延期理由 |
| P2-2 | `migrations/026_recovery_units.sql:22-28,50-54`（承接 r70 P2-2） | `<1e6` 档不区分旧毫秒与真纳秒小值，一律乘 1e6 | 真纳秒小值只能来自未签中间提交，已签基线写不出该形状；沿用延期理由 |
| P2-3 | `src/service/commands/cancel.ts`、`recovery.ts`（承接 r70 P2-3） | 断链闸门只装状态推进与收口入口，只记事件的 append 不验链 | 断链只能由外部篡改造出，`cancel.ts`/`recovery.ts` 本批零改动；沿用延期理由 |
| P2-4 | `src/service/dispatcher.ts:276-284`（承接 r70 P2-4） | `dispatchOne` catch 块收结果不落库，断链 queued 节点库里仍留 queued | 本批 dispatcher 改动只动常量定义区，catch 路径逐字未动（行号随 +2 偏移由 274-282 移至 276-284）；断链需人工处理，分叉不造成数据损坏；沿用延期理由 |

## 7. 一般建议（不计数）

- `SUCCESS_STATUS` 仍混合节点态与 run 级态（`succeeded`、`succeeded_with_unverified` 不属于 `node_runs.status` 枚举），生效成员只有 `done`；本批 `BLOCKED_TERMINAL` 已对齐 `state-machine.ts` 终态表，建议后续把 `SUCCESS_STATUS` 也改为从状态机派生（承接 r70 §7）。
- `applyTransition` / `transitionNode` / `closeRun` 的整链校验 O(n²) 开销建议加链头缓存（承接 r70）。
- 场景三收尾断言只判 `not.toBe('queued')`，没有沿用场景二的 `RESOLUTION_NOT_AVAILABLE` 排除检查；建议对齐两条场景的收口断言，防止后续回归把「前置结算」误当「放行执行」。

## 8. 测试与质量证据

- 已实测：§2 三条命令；G1 相关用例（`config.spec.ts`、`migrate.spec.ts`、`db-open.spec.ts`、`backup.spec.ts`、`g1.spec.ts`、`auth.spec.ts`、`hash-chain.spec.ts`）随 78 文件全量通过。
- 本批新增回归场景（`workflow-g4.spec.ts` 场景三不确定前置等待与裁决放行、场景二结算排除断言）随全量通过。
- 未实测：多实例并发与长时间浸泡；也没有持久库可复核 P2-1 的升级影响面。

## 9. 阶段结论

结论：通过。

G1 的 13 项必过全过，证据复现 29/29 与 HEAD 字节一致；本批是 S3 r22 P2-7 的定点修复与对应回归测试，G1 共享路径与 G1 证据零改动，承接 4 条 P2 不阻断。建议：结束本轮 G1 收敛审计，转入下一阶段开发。

## 10. 落盘自检

`parseAuditVerdict`、`verdictProblems`、`auditBindingOf`、`proseVerdictClashes`、`auditConclusionOf` 均按 `src/core/audit-verdict.ts` 与 `scripts/gate-check.ts` 的实际导出签名实跑（探针 `tmp/s1r71-selfcheck.mjs`，交付前已删），输出如下（parse 的 `notes` 字段与裁决块一致，此处略去重复文本）：

```text
> node --experimental-strip-types --no-warnings tmp/s1r71-selfcheck.mjs
parse {"verdict":{"schema":"audit-verdict/1","gate":"G1","audit_round":71,"candidate_commit":"32517a5287df6221d3f9024efa4adc074efea8d3","conclusion":"pass","p0":0,"p1":0,"p2":4,"must_pass_total":13,"must_pass_passed":13,"must_pass_ids":["G1-01","G1-02","G1-03","G1-04","G1-05","G1-06","G1-07","G-01","G-02","G-08","G-09","G-14","G-15"],"failed_items":[],"notes":"（略）"}}
verdictProblems 0 []
binding {"gate":"G1","commit":"32517a5287df6221d3f9024efa4adc074efea8d3"}
proseVerdictClashes 0 []
auditConclusionOf pass
```
