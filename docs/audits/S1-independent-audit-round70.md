# S1 独立审计报告 · G1 第 70 轮

门：G1
候选提交：4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f
审计日期：2026-11-17
审计方式：独立只读审计；未签门、未改任何生产代码/测试/证据/门记录

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 70,
  "candidate_commit": "4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f",
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
  "notes": "本批（4e751de..4ecff7a）为修复批次：P2-1（pnpm typecheck 退出码 2）已修并实测 exit 0，G4 注册块改用非空断言适配 noUncheckedIndexedAccess。G1 共享路径（migrations、driver、errors、config、auth）零改动，13 项必过沿用 r69 结论全过。dispatcher.ts 的 failedPreds 结算与 effectiveStatus 有效行判定属 S4 调度语义，不触及 G1 面。P2 承接 4 条（r69 P2-2 至 P2-5）：026 就地改写、026 量级口径、断链闸门覆盖面、派发结果不落库，本批均未改动。证据复现 29/29 字节一致。"
}
```
<!-- audit-verdict:end -->

## 1. 审计基准

- 审计开始时主线 HEAD、候选提交、报告绑定提交三者同为 `4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f`，工作树干净；本轮只读，没有改动任何候选文件。
- 上一轮基线为 `4e751de6cf8fb681e7b7c4f40061400cabab0408`（S1 r69 结论为通过）。本轮 diff 范围 `4e751de..4ecff7a` 共 10 个文件（+755/−28），其中生产代码 1 个（`src/service/dispatcher.ts`）、测试 2 个（`tests/gate/gate-check.spec.ts`、`tests/integration/workflow-g4.spec.ts`），其余 7 个为 docs/audits、docs/gates、docs/superpowers/plans 收口文档。
- G1 共享路径逐一对账：`src/infra/sqlite/migrations/`、`src/infra/sqlite/driver.ts`、`src/core/errors.ts`、配置与认证模块均不在变更清单内。
- 必过项全集取自 `scripts/gate-check.ts` 的 `GATE_SPECS.G1.items`（13 项），与裁决块 `must_pass_ids` 逐一相等、无重复、无规格外项。
- 上一轮 P2 清单 5 条：P2-1 已修复并验证（实测 typecheck exit 0）；P2-2 至 P2-5 原样承接（相关文件零改动）。

## 2. 实测（本人亲自执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc --noEmit` 零诊断（P2-1 修复确认） |
| `npx vitest run` | 0 | 78 个文件全过；1023 passed / 1 skipped（共 1024）；耗时 17.78s |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 29 份证据每份重跑两遍与 HEAD 字节一致 |

## 3. 上一轮 P2 逐条复核

| 编号 | 上轮问题 | 本轮判定 | 依据 |
| --- | --- | --- | --- |
| r69 P2-1 | `tests/gate/gate-check.spec.ts:1737-1759` 的 G4 注册块在 `noUncheckedIndexedAccess` 下报 TS18048×11、TS2532×1，typecheck 退出码 2 | 已修复并验证 | 本批将 `GATE_SPECS.G4.*` 改为先取 `GATE_SPECS.G4!` 再引用、`GATE_SPECS[gate].gateFile` 加非空断言；`pnpm typecheck` exit 0 |
| r69 P2-2 | 迁移 026 就地改写，应用过旧 026 的库升级会被迁移校验和挡在启动 | 未改，仍成立 | `migrations/026_recovery_units.sql` 不在 `4e751de..4ecff7a` 变更清单内 |
| r69 P2-3 | 026 量级口径把真纳秒小值放大、模糊带保留毫秒值 | 未改，仍成立 | 同上，026 未动 |
| r69 P2-4 | 断链闸门只装状态推进入口，只记事件的 append 不验链；断链节点人工出口是账本核对 | 未改，仍成立 | `cancel.ts`、`recovery.ts` 不在变更清单内 |
| r69 P2-5 | 断链 queued 节点的派发结果不落库，库里仍留 queued，缺只读清单 | 未改，仍成立 | `dispatcher.ts` 的 `dispatchOne` catch 块（现 274-282 行）仍只收结果不落库；本批新增的 `failedPreds` 结算走 `failQueuedNode`（M-48）落库，但 catch 路径不变 |

## 4. 本轮改动逐项审查（G1 视角）

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| `tests/gate/gate-check.spec.ts` | 正确 | G4 注册块改用非空断言（`GATE_SPECS.G4!`、`GATE_SPECS[gate]!`），适配 `tsconfig.json:8` 的 `noUncheckedIndexedAccess`；断言逻辑不变，typecheck 修复 |
| `src/service/dispatcher.ts` | 不触及 G1 共享路径 | 三处改动均属 S4 调度语义：`readinessOf` 新增 `failedPreds` 分支（前置停在 `BLOCKED_TERMINAL` 非成功终态时后置被结算而非永等）、`effectiveStatus` 按 `ORDER BY attempt DESC, seq DESC` 取有效行（M-60 换行后只看首行会误判）、`dispatchRun` 将结算结果并入 outcomes 返回。收口走 `failQueuedNode`（`applyTransition` M-48 + `appendNodeRunEvent`），状态机闭合不变 |
| `tests/integration/workflow-g4.spec.ts` | 正确 | 新增回归用例覆盖两场景：前置 failed → 后置结算 failed 且 run 收口、前置换行 done → 后置照常放行；断言 `dispatch.failed` 事件与 `RESOLUTION_NOT_AVAILABLE` 错误码 |
| `docs/gates/G4.md`、`docs/gates/evidence/G4/full-suite.md` | 正确 | G4-06 证据补 `ev-g4-14`；full-suite.md 数字随新用例更新（1022→1023），与实测一致；均在 excludes 清单内，属候选外 |
| `docs/superpowers/plans/2026-11-17-product-roadmap.md` | 不影响 G1 | S5 规划范围文案调整（协作消息系统不属于 S5），纯文档 |

## 5. 13 项必过项

| 必过项 | 要求 | 结果与证据 |
| --- | --- | --- |
| G1-01 | 迁移空库可重复 | 满足；`migrate.spec.ts` 随全量通过，本批未触及迁移 |
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
| G-15 | 备份截断可检出、恢复被拒、线上库不变 | 满足；证据 `ev-g15` 与 `backup.spec.ts` 一致 |

## 6. 不阻断问题（P2）

| 编号 | 位置 | 说明 | 影响与延期理由 |
| --- | --- | --- | --- |
| P2-1 | `src/infra/sqlite/migrations/026_recovery_units.sql`（承接 r69 P2-2） | 026 在引入后的下一批被就地改写，应用过旧 026 的库升级会被迁移校验和挡在启动 | 仓库内无持久库，三门基线不含 026；沿用 r69 延期理由 |
| P2-2 | `migrations/026_recovery_units.sql:22-28,50-54`（承接 r69 P2-3） | `<1e6` 档不区分旧毫秒与真纳秒小值，一律乘 1e6 | 真纳秒小值只能来自未签中间提交，已签基线写不出该形状；沿用延期理由 |
| P2-3 | `src/service/commands/cancel.ts`、`recovery.ts`（承接 r69 P2-4） | 断链闸门只装状态推进与收口入口，只记事件的 append 不验链 | 断链只能由外部篡改造出；沿用延期理由 |
| P2-4 | `src/service/dispatcher.ts:274-282`（承接 r69 P2-5） | `dispatchOne` catch 块收结果不落库，断链 queued 节点库里仍留 queued | 断链需人工处理，分叉不造成数据损坏；沿用延期理由 |

## 7. 一般建议（不计数）

- `SUCCESS_STATUS` 混合了节点态与 run 级态（`succeeded`、`succeeded_with_unverified` 不属于 `node_runs.status` 枚举），生效成员只有 `done`；本批 `BLOCKED_TERMINAL` 已补失败侧传播口径，建议后续对齐 `state-machine.ts` 终态定义（承接 r69 §7）。
- `applyTransition` / `transitionNode` / `closeRun` 的整链校验 O(n²) 开销建议加链头缓存（承接 r69）。

## 8. 测试与质量证据

- 已实测：§2 三条命令；G1 相关用例（`config.spec.ts`、`migrate.spec.ts`、`db-open.spec.ts`、`backup.spec.ts`、`g1.spec.ts`、`auth.spec.ts`、`hash-chain.spec.ts`）随 78 文件全量通过。
- 新增回归用例 `workflow-g4.spec.ts` 的两场景（前置失败结算、换行放行）均通过。
- 未实测：多实例并发与长时间浸泡；也没有持久库可复核 P2-1 的升级影响面。

## 9. 阶段结论

结论：通过。

G1 的 13 项必过全过，证据复现 29/29 与 HEAD 字节一致；P2-1（typecheck）已修并实测通过，本批改动集中在 S4 调度语义与 G4 测试/证据，G1 共享路径零改动，承接 4 条 P2 不阻断。建议：结束本轮 G1 收敛审计，转入下一阶段开发。

## 10. 落盘自检

`parseAuditVerdict`、`verdictProblems`、`auditBindingOf`、`proseVerdictClashes`、`auditConclusionOf` 均按 `src/core/audit-verdict.ts` 与 `scripts/gate-check.ts` 的实际导出签名实跑（探针 `tmp/s1r70-selfcheck.mjs`，交付前已删），输出如下（parse 的 `notes` 字段与裁决块一致，此处略去重复文本）：

```text
> node --experimental-strip-types --no-warnings tmp/s1r70-selfcheck.mjs
parse {"verdict":{"schema":"audit-verdict/1","gate":"G1","audit_round":70,"candidate_commit":"4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f","conclusion":"pass","p0":0,"p1":0,"p2":4,"must_pass_total":13,"must_pass_passed":13,"must_pass_ids":["G1-01","G1-02","G1-03","G1-04","G1-05","G1-06","G1-07","G-01","G-02","G-08","G-09","G-14","G-15"],"failed_items":[],"notes":"（略）"}}
verdictProblems 0 []
binding {"gate":"G1","commit":"4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f"}
proseVerdictClashes 0 []
auditConclusionOf pass
```
