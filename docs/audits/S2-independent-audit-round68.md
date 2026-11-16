# S2 独立审计报告 · G2 第 68 轮（不通过记录）

门：G2
候选提交：dcee53d3c3c25dda230cf8dc3bf800d223ff1b58
审计日期：2026-11-16
审计方式：独立只读审计；未签门、未改生产代码/测试/证据/门记录

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 68,
  "candidate_commit": "dcee53d3c3c25dda230cf8dc3bf800d223ff1b58",
  "conclusion": "fail",
  "p0": 0,
  "p1": 1,
  "p2": 2,
  "must_pass_total": 20,
  "must_pass_passed": 20,
  "must_pass_ids": [
    "G2-01",
    "G2-02",
    "G2-03",
    "G2-04",
    "G2-05",
    "G2-06",
    "G2-07",
    "G-03",
    "G-04",
    "G-05",
    "G-07",
    "G2-08",
    "G2-09",
    "G2-10",
    "G2-11",
    "G2-12",
    "G2-13",
    "G2-14",
    "G2-15",
    "G2-16"
  ],
  "failed_items": [
    "P1-1 执行器上报与事件唤醒两条入口仍在推进断链节点，事件唤醒那条还把 run 收成 succeeded"
  ],
  "notes": "20 项功能必过项的证据全部复现；阻断的是断链隔离这条跨项不变量（§4.6）：r67 的 P1-1b 只修了 timeoutWaiting 一支，wakeOnEvent 与 applyReport 两条入口仍在推进断链节点。审计期间工作树出现未提交的同类修复，本报告只对候选 dcee53d 定级。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：**fail**

P0 = 0，P1 = 1，P2 = 2；必过项 20/20（20 项功能证据都复现，卡住的是断链隔离这条跨项不变量）。

## 2. 审计基准

| 项 | 值 |
| --- | --- |
| 主线 HEAD / 本轮候选 | `dcee53d3c3c25dda230cf8dc3bf800d223ff1b58`；审计开始时工作树干净 |
| 审计范围 | `git diff 93e1d88..dcee53d`，7 个提交：`d85b09d`、`ddcfec6`、`2bf9c07`、`27f1b7b`、`3001538`、`91a8aa7`、`dcee53d` |
| 改动文件 | 生产代码 13 个（`src/index.ts`、`src/service/{sweep,dispatcher,server,schemas,clock-recovery}.ts`、`src/service/commands/{wait,cancel,confirm-start,lease,node-state,recovery}.ts`、`src/service/queries/recovery.ts`、`src/infra/sqlite/migrations/026_recovery_units.sql`）、测试 6 个、证据/台账/文档若干 |
| 上一轮 | `docs/audits/S2-independent-audit-round67.md`（候选 `93e1d88`，P1×2 / P2×3） |
| 必读文档 | `审计要求.md`（§2/§4/§5/§6/附录 A）、`scripts/gate-check.ts` 的 `GATE_SPECS.G2`、`GLOSSARY.md`、`docs/requirements.md`、`docs/design-notes.md`、`handoff.md` §0.1 |
| 审计期间的环境变化 | 复核进行到一半时工作树出现 14 个未提交的生产代码修改（他人正在落的同类修复）；期间主线还前进了 `dcee53d` → `7a1e48b`（只改 `AGENTS.md`），本报告定稿后又落了 `0fda6ab`（链闸修复，属新候选）与 `140dd18`（文档）。为不把未提交改动算进候选，我取 `git archive dcee53d` 的原样副本到 `tmp/head-r68/` 重跑探针，本报告的定级以该副本为准，绑定仍为 `dcee53d` |

## 3. 上一轮问题复核（逐条，不默认已修复）

| 编号 | 复核位置（本人读到） | 结论 | 针对性用例 |
| --- | --- | --- | --- |
| P1-1a：断链子 run 仍可推父节点、收口父 run | `src/service/sweep.ts:99-104` 先算 `taintedRuns`；`:365-376` 的 `finishedChildren` 循环新增 `if (taintedRuns.has(child.run_id)) continue` | 已修复并验证 | `tests/integration/clock-recovery.spec.ts`「断链子 run + 已完成子流程」（实跑通过） |
| P1-1b：wait 超时收口没有断链闸 | 超时一支已修：`wait.ts:319` 增 `skipRunIds`，`:350` 改为 `if (!skipRunIds?.has(node.run_id)) closeRun(...)`，`sweep.ts:112` 传入 `taintedRuns`；但同一文件 `wait.ts:289-300` 的 `wakeOnEvent` 仍是 `scanRun` 后无条件 `closeRun`，`scanRegistration`（`:125-140`）也仍直接 `applyTransition` 推进节点 | **部分修复**：事件唤醒这一支保留原样，见第 5 节 P1-1 | 探针 H（HEAD 副本）：断链 `waiting` 节点被唤醒到 `done`，run 收成 `succeeded` 并写 1 条 `run.terminal` |
| P2-1：派发错误码白名单 | `src/service/dispatcher.ts:35-40` 合并 `ERROR_STATUS` 与 `PROPOSED_ERROR_CODES`，`OrchError` 分支同过白名单 | 已修复并验证 | `tests/unit/dispatch-retry.spec.ts`（3 例） |
| P2-2：证据哈希与门记录 | 证据文件已按新表数/体量改写，`check-evidence-repro` 28/28；`docs/gates/G2.md` 仍是 `audit_round: 66`，须在报告与候选冻结后重签 | 待重签（流程项） | `node --no-warnings scripts/check-evidence-repro.ts`；`node --no-warnings scripts/gate-check.ts` |
| P2-3：action 通道 status 约束 | 跳过集已统一（`sweep.ts:140/208/302/337/373` 全用 `skipNodes`）；`src/service/clock-recovery.ts:96` 的 action 通道仍用手写状态白名单，与 `src/core/state-machine.ts:18-26` 的终态集合不一致 | 部分修复（并入本轮 P2-1） | 探针 A/B/F（见第 5 节） |

## 4. 本批修改质量（逐项）

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| `acquireLease` 先验链（`commands/lease.ts:60-69`） | 符合预期，无需修改 | 断链节点在拿租约前以 `FORBIDDEN`+`reason: chain_broken` 拒绝，状态与租约均未变；空链 `readChain` 返回 `[]`、`verifyChain` 返回 null，正常派发不被误伤。用例 `tests/integration/chain-guard-execution.spec.ts` 两例实跑通过 |
| 迁移 026（`026_recovery_units.sql`） | 符合预期，无需修改 | 只把「`startup_unknown_remaining_ns` 非空、无单调锚点、值落在毫秒量级」的行乘 1e6，其余行记账保留；重复执行不再命中。用例 `tests/integration/recovery-unit-migration.spec.ts` 三例实跑通过 |
| `retryDirective()`（`dispatcher.ts:79-83`） | 符合预期，无需修改 | 非 `storage_error` → `never`；读到库内状态 → `after_reread`；状态未知 → `after_status_query`；三个分支都有单测 |
| `GET /v1/recovery/uncertain`、`POST /v1/recovery/resolve` | 主体符合预期 | 查询只读、按 `recovery_uncertain_at` 升序；确认走 M-50、带 `expectedRevision` CAS、同笔清标记与通道锚点；重复确认返回 `STALE_GENERATION`；鉴权由 `server.ts:200` 统一前置。收尾缺口见第 5 节 P2-1、P2-2 |
| 台账 P1-2026-11-16-01：锚点与检查点同笔写 | 已修复并验证 | `confirm-start.ts:67-69`、`cancel.ts:191-192`（无围栏）/`:162-163`（围栏）/`:301-305`（撤围栏重挂）都同笔写 `action_remaining_ns`；`clock-recovery.ts:159-177` 的刷新不再要求检查点已非空。用例 `tests/integration/recovery-action-checkpoint.spec.ts` 三例实跑通过 |
| `rearmDeadline` 增加 `remainingMs`（`node-state.ts:157-183`） | 符合预期 | 不带剩余量时把检查点清空，避免旧预算冒充新预算；当前生产代码无调用点（仅单测使用） |
| `sweep` 内 `taintedRuns` 提前计算 | 符合预期 | wait 超时、子流程、决策扫描、run 收口共用同一份污染集；`skipNodes` 为空时 `IN ('')` 仍是合法 SQL |
| `server.ts` / `schemas.ts` 新增路由与校验 | 符合预期 | `recoveryResolveSchema` 只收 `mark_indeterminate_side_effect` 一种语义，`revision` 必填；两条路由排在通用路由之前且需认证 |

## 5. 必须阻断的问题

### P1-1 执行器上报与事件唤醒两条入口仍在推进断链节点，事件唤醒那条还把 run 收成 succeeded

- **位置**
  - 上报侧：`src/service/commands/apply-report.ts:524` 的主干收口调用 `transitionNode`（`src/service/commands/node-state.ts:38-154`），该函数自带一条 CAS UPDATE，全程不做链校验；链校验只出现在 `apply-report.ts:338` 的 rejected 重放分支。
  - 唤醒侧：`src/service/commands/wait.ts:289-300` 的 `wakeOnEvent` → `scanRun` → `scanRegistration`（`:125-140`）先改登记再 `applyTransition` 推进 `waiting→done`，随后 `:299` 无条件 `closeRun`；`src/service/commands/nodes.ts:123` 的 `applyTransition` 与 `src/service/commands/run-close.ts:28` 的 `closeRun` 在候选里都没有链闸。
- **触发条件**：节点已进入执行期（如 `verifying` / `waiting`）后哈希链被改坏（触发器被卸、`node_run_events.hash` 与重算值不符），随后执行器照常上报，或同 run 收到匹配的等待事件。
- **实际影响**：坏账本上的节点被推进到终态并继续追加事件；唤醒侧更进一步把 run 收成 `succeeded` 并写 `run.terminal`，断链事实被 run 级终态掩盖。这与 `审计要求.md` §4 第 6 条「哈希链断裂的节点不得被推进、不得被收口」直接冲突，也和 r67 P1-1b 同一类。
- **复现证据**（`git archive HEAD` 原样副本，`tmp/head-r68/entry-chain.spec.ts` 两例，均实跑）：
  - 上报侧：断链的 `verifying` 节点调用 `applyReport` → 返回 `accepted:true`、`next_status:'done'`，节点状态变 `done`；
  - 唤醒侧：断链的 `waiting` 节点调用 `wakeOnEvent` → `{eventSeq:1, woken:1}`，节点 `done`，run `succeeded`，`run.terminal` 事件 1 条。
- **严重性依据**：账本是本项目唯一事实源；断链节点被推进等于继续在坏账本上记账，run 终态还会给出「成功」的业务结论，事后无法从 run 视图看出断链。r67 已把同一类问题定为 P1 并声明修复，本轮实测显示修复只覆盖了 `timeoutWaiting` 一支，属于「旧修复没解决问题」的情形。
- **修复建议**：把链闸下沉到两条唯一入口——`transitionNode`（`node-state.ts`）与 `applyTransition`（`nodes.ts`）各自先验链，`closeRun` 内部再验一次本 run 全部节点；这样所有调用点（上报、事件唤醒、取消、决策、补偿、子流程）自动覆盖。也可让 `applyReport` 主干改走 `applyTransition` 统一入口。
- **验证方案**：新增两条集成用例，按 `clock-recovery.spec.ts` 的 `breakChain` 手法造断链，分别断言 `applyReport` 与 `wakeOnEvent` 抛 `FORBIDDEN`/`reason: chain_broken`、节点状态保持、run 状态保持 `running` 且无 `run.terminal` 事件。
- **补充说明**：审计期间工作树出现未提交的同类修复（`applyTransition` 与 `closeRun` 已加闸，见 `nodes.ts:128`、`run-close.ts:56`）。我在该未提交状态下复跑同一探针：唤醒侧已被拦住，上报侧仍然通过（`transitionNode` 不在那次改动范围内）。该修复未进入候选，故不影响本轮定级；下一候选请把 `node-state.ts` 一并覆盖。

## 6. 可延期问题

| 编号 | 位置 | 说明 | 影响与证据 |
| --- | --- | --- | --- |
| P2-1 | `src/service/clock-recovery.ts:95-98`；`src/service/commands/recovery.ts:61-72`；`src/service/sweep.ts:99-104`、`:392-395` | action 通道状态白名单手写，`timeout` 与 `abandoned_unverified` 不在排除之列；确认接口只走 M-50（来源集合是非终态） | 升级前遗留行（带上一 boot 的 `deadline_*`、`action_remaining_ns` 为空、节点已终态）首次扫描即被打标，此后确认接口回 `STALE_GENERATION`；若打标那一轮 run 还收不了口（例如同 run 仍有在途节点），后续扫描会把该 run 排除在收口之外，run 停在 `running`（打标当轮就能收口的 run 不受影响，`taintedRuns` 在扫描开始时计算）。探针 A/B/F 复现，S3 r19 的独立复现同样确认节点级不卡死、run 级取决于该条件。当前生产写路径已同笔写检查点，触发面限于遗留/外部行 | 
| P2-2 | `src/service/commands/recovery.ts:49-72`；`src/service/commands/wait.ts:125-140` | 确认时只清通道锚点，未调 `cancelWait`；`scanRegistration` 先改登记再迁移，迁移抛错整笔回滚 | 等待通道确认后同 run 收到匹配事件，`POST /v1/wait/events` 整笔回滚（inbox 0 行），同 run 其它等待节点一并唤不醒。探针 D 复现；同一形态在「取消 waiting 的 agent 节点」路径上也存在（既有实现） |
| P3-1 | `state-machine.ts:18-26`、`run-close.ts:41`、`clock-recovery.ts:96` | 终态词表三处各自维护 | 可读性与一致性风险，已在 `handoff.md` 的 P3 清单内 |

## 7. 必过项核对（20 项）

| 必过项 | 证据 | 判定 |
| --- | --- | --- |
| G2-01 | ev-g2-01、全量用例复现 | 通过 |
| G2-02 | ev-g2-02、全量用例复现 | 通过 |
| G2-03 | ev-g2-03、全量用例复现 | 通过 |
| G2-04 | ev-g2-04、全量用例复现 | 通过 |
| G2-05 | ev-g2-05、ev-g2-10、全量用例复现 | 通过 |
| G2-06 | ev-g2-06、全量用例复现 | 通过 |
| G2-07 | ev-g2-07、全量用例复现 | 通过 |
| G-03 | ev-g2-g03、全量用例复现 | 通过 |
| G-04 | ev-g2-g04、全量用例复现 | 通过 |
| G-05 | ev-g2-g05、全量用例复现 | 通过 |
| G-07 | ev-g2-g07、ev-g2-09、全量用例复现 | 通过 |
| G2-08 | ev-g2-08、全量用例复现 | 通过 |
| G2-09 | ev-g2-09、全量用例复现 | 通过 |
| G2-10 | ev-g2-10、全量用例复现 | 通过 |
| G2-11 | ev-g2-11、全量用例复现 | 通过 |
| G2-12 | ev-g2-12、全量用例复现 | 通过 |
| G2-13 | ev-g2-13、全量用例复现 | 通过 |
| G2-14 | ev-g2-14、全量用例复现 | 通过 |
| G2-15 | ev-g2-15、全量用例复现 | 通过 |
| G2-16 | ev-g2-16、全量用例复现 | 通过 |

## 8. 实测命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `npx vitest run` | 69 files，935 passed / 1 skipped（11.39s） |
| `pnpm build` | 完成；ESM `lib/index.js` 299.67 kB / gzip 72.32 kB，`lib/index.d.ts` 24.43 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 28 份证据各重跑两遍，与 HEAD 字节一致 |
| `npx vitest run tests/integration/{clock-recovery,sweep,subworkflow,decision-sweep,recovery-uncertain,recovery-action-checkpoint,chain-guard-execution}.spec.ts` | 7 files，78 passed |
| `npx vitest run --root tmp/head-r68`（HEAD 原样副本上的入口探针） | 2 例：上报侧与唤醒侧都推进了断链节点 |
| `node --no-warnings scripts/gate-check.ts` | 三门记录按预期待重签（`codebasemap.md` 在三份报告绑定的候选之后改动过） |

证据文件与实测一致：`ev-g2-16.md` 记的 69 files / 935 passed / 1 skipped、`full-suite.md` 记的构件体量，都与本人实跑结果逐字相同。

临时探针只放在 `tmp/`（`vitest.probe.config.ts`、`tmp/head-r68/` 及若干 `*.probe.spec.ts`），报告落盘前已删除。

## 9. 阶段性结论与建议

本次未通过。20 项功能必过项与 76 条桥闭环的证据仍全部复现，本批对断链隔离的整改在 sweep 侧（P1-1a）与 wait 超时一侧（P1-1b 的一半）已经到位；阻断项只剩入口侧这一条同类旁路，且工作树里已在落同类修复。

建议：

1. 把工作树里的链闸修复补上 `node-state.ts` 的 `transitionNode`（或让 `applyReport` 主干改走 `applyTransition`），并补两条断链集成用例（上报侧、唤醒侧各一），作为新候选提交；
2. 新候选再做一轮 G2 复核（r69），重点只看这一条与第 6 节两条 P2 的收尾；
3. G2 门记录在候选冻结后按 G1→G2→G3 重签；P2-1、P2-2 与 P3-1 可攒入下一批，不单独阻断。
