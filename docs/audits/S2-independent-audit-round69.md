# S2 独立审计报告 · G2 第 69 轮

门：G2
候选提交：fd2173bb719068e94c3713e5b08703ea932dd08d

审计日期：2026-11-16
审计方式：独立只读审计；未签门、未改生产代码/测试/证据/门记录；临时探针只放 `tmp/r69/`

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 69,
  "candidate_commit": "fd2173bb719068e94c3713e5b08703ea932dd08d",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 1,
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
  "failed_items": [],
  "notes": "r68 的 P1-1（上报/唤醒/执行器迁移三条入口推进断链节点、断链 run 被收口）已由 applyTransition / transitionNode / closeRun 三处链闸堵住，并用本人探针在四条路径上复跑确认；P2-2 已修；P2-1 的终态行分支已收口，带 hang_reason 的存量行仍会打标且确认接口回 STALE_GENERATION，作为 P2 记录。20 项必过项证据全部复现。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：**pass**

P0 = 0，P1 = 0，P2 = 1；必过项 20/20。

## 2. 审计基准

| 项 | 值 |
| --- | --- |
| 主线 HEAD | 审计开始时 HEAD 即候选；审计期间只前进 `docs/audits` 报告提交（不含候选代码），候选范围不变 |
| 本轮候选 / 本报告绑定提交 | `fd2173bb719068e94c3713e5b08703ea932dd08d`（工作树中只有本报告一处改动） |
| 审计范围 | `git diff dcee53d..fd2173b`：40 个文件，823 插入 / 146 删除；含 `0fda6ab`（链闸）、`140dd18`（文档）、`fd2173b`（P2 收尾） |
| 生产代码改动 | `src/infra/db/ledger.ts`（新增 `assertChainIntact`）、`src/service/commands/{nodes,node-state,run-close,recovery,wait,cancel,decisions,compensation,confirm-start,subworkflow,lease,apply-report}.ts`（链闸与 `secret` 透传）、`src/service/{sweep,clock-recovery,dispatcher}.ts`、`src/index.ts`、`src/infra/sqlite/migrations/026_recovery_units.sql`（识别口径改写） |
| 测试改动 | 新增 `tests/integration/chain-guard-entries.spec.ts`（4 例）；`recovery-uncertain.spec.ts` 新增终态行 1 例与登记状态断言；其余文件为 `secret` 透传与台账数值更新，断言未放宽 |
| 上一轮 | `docs/audits/S2-independent-audit-round68.md`（候选 `dcee53d`，P1×1 / P2×2） |
| 必读文档 | `审计要求.md`（§2/§4/§5/§6/附录 A）、`scripts/gate-check.ts` 的 `GATE_SPECS.G2`、`GLOSSARY.md`、`docs/requirements.md`、`docs/design-notes.md`、`handoff.md`（线索） |
| 未能确认的范围 | 无 |

## 3. 上一轮问题复核（逐条，不默认已修复）

| 编号 | 复核位置（本人读到） | 结论 | 验证方式 |
| --- | --- | --- | --- |
| P1-1：上报与唤醒两条入口推进断链节点，唤醒侧还把 run 收成 succeeded | `src/infra/db/ledger.ts:98` 新增 `assertChainIntact`（`FORBIDDEN` + `details.reason='chain_broken'`，带 `seq`/`detail`）；`src/service/commands/node-state.ts:40`（`transitionNode`，上报主干）与 `src/service/commands/nodes.ts:128`（`applyTransition`，唤醒/取消/决策/补偿/派发共用）各装一处；`src/service/commands/run-close.ts:55-57` 在全部早退之后逐节点 `chainBreakOf`，命中即 `return null` | 已修复并验证 | 本人探针（`tmp/r69/probe.probe.spec.ts`）在候选上 7 例全过：断链 `verifying` + `applyReport` → `FORBIDDEN`，节点停在 `verifying`、链头不变、run 停在 `running`、`run.terminal` 0 条；断链 `waiting` + `wakeOnEvent` → `FORBIDDEN`，节点停在 `waiting`、登记仍 `active`、inbox 0 行（整笔回滚）、`run.terminal` 0 条；断链 `dispatched` + `transitionNode` → `FORBIDDEN`，状态保持；节点全终态但链断 + `closeRun` → `null`，run 停在 `running`、`run.terminal` 0 条 |
| P2-1：不确定标记落在终态行后清不掉 | `src/service/clock-recovery.ts:96` 的 action 通道排除集补入 `timeout`、`abandoned_unverified`；`tests/integration/recovery-uncertain.spec.ts` 新增终态行用例 | 部分收口：终态行分支已闭环；带 `hang_reason` 的行仍会打标且确认接口回 `STALE_GENERATION`，见第 6 节 P2-1 | 探针 5：7 个终态各一行（旧 boot 锚点 + 空检查点）扫一轮后 `recovery_uncertain` 全为空，同轮非终态对照行被正常打标；探针 7：`stopping` + `hang_reason='action_overrun'` 同形态行被打标，`resolveRecoveryUncertain` 回 `STALE_GENERATION`、标记留在行上 |
| P2-2：确认接口留下 active 等待登记，后续事件整笔回滚 | `src/service/commands/recovery.ts:50-51` 在 revision 校验之后、清锚点之前调用 `cancelWait`，与状态迁移同一笔事务 | 已修复并验证 | 探针 6：确认后登记 `state='cancelled'`、节点 `indeterminate_side_effect`；随后同 run 匹配事件 `wakeOnEvent` 正常返回 `woken=0`，inbox 落 1 行（不再整笔回滚）；用例实跑通过 |
| P3-1：终态词表多处手写 | `state-machine.ts:18`、`run-close.ts:41`、`clock-recovery.ts:96` 仍各自维护 | 仍为 P3，不阻断 | 代码阅读 |

## 4. 本批修改质量（逐项）

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| `assertChainIntact`（`ledger.ts:98-108`） | 符合预期，无需修改 | 统一抛 `FORBIDDEN` 并带机器可判的 `reason`/`seq`/`detail`；空链 `verifyChain([])` 返回 null，新建节点首次迁移不被误伤；`appendNodeRunEvent` 的链头缺口保护未被绕过 |
| 三处链闸（`nodes.ts:128`、`node-state.ts:40`、`run-close.ts:55`） | 符合预期 | `transitionNode` 自走 CAS，不与 `applyTransition` 共用实现，两处分别装闸是必要的；`closeRun` 的整链校验放在运行终态、未终态节点、活跃 decision、`assertRunCanTerminal` 全部早退之后，只有真要收口时才付整链开销，不给每轮扫描加固定成本 |
| `closeRun` 签名增加 `secret` | 符合预期 | 全部 12 个调用点（`index.ts:174/212/275`、`wait.ts:284/299/350`、`dispatcher.ts:117`、`decisions.ts:220/360`、`compensation.ts:174`、`sweep.ts:381/395`）都透传各自服务实例的同一份 `secret`，typecheck 通过，不存在「验链用错密钥导致正常迁移全被拒」的调用面 |
| `resolveDecision` / `applyTransition` / `transitionNode` 签名增加 `secret` | 符合预期 | 签名变更由 typecheck 强制覆盖全部调用点；测试里的 `SECRET` 常量与建库密钥一致，全量用例通过 |
| `resolveRecoveryUncertain` 调 `cancelWait` | 符合预期 | 位置在 CAS 前置校验之后；无登记时 `cancelWait` 返回 false、无额外副作用；确认失败时整笔回滚，不会留下「登记已撤销、状态没迁」的半截 |
| `clock-recovery` action 通道排除集 | 符合预期（终态分支） | 补完 `timeout`/`abandoned_unverified` 后与 `TERMINAL_STATUSES` 对齐（多出的 run 级词不产生副作用）；fence 通道没有状态过滤，见第 6 节 P2-1 的第二段 |
| `sweep` 桥恢复写检查点而非清空 | 符合预期 | `startup_unknown` / `verifying` 恢复时把重挂预算同笔写成检查点，连续两次重启不再丢失可信剩余；数值是 ns→ms→ns 的往返，误差小于 1ms |
| 迁移 026 识别口径重写 | 符合预期（取舍见第 6 节 P3-1） | 不再依赖「缺单调锚点」，改按量级分三档并逐行写 `recovery_unit_fixes`；本批次内 026 与检查点代码同批引入，生产库在 v25 不会出现纳秒量级的既存检查点，误换算面为开发库 |
| 测试改动 | 符合预期 | 新增 4 例覆盖三条外部入口；`recovery-uncertain` 补登记状态与终态行；其余为签名与数值更新，未见断言强度下降 |

## 5. 必须阻断的问题

本轮未发现新的 P0/P1 阻断问题；r68 的 P1-1 已闭环（第 3 节）。

## 6. 可延期问题

| 编号 | 位置 | 说明 | 影响与建议 |
| --- | --- | --- | --- |
| P2-1 | `src/service/clock-recovery.ts:95-98`、`:110-122`；`src/service/commands/recovery.ts:52-75`；`src/service/commands/nodes.ts:210` | 带 `hang_reason` 的行仍在 action 通道的取值范围内，被打标后唯一的清除入口 `resolveRecoveryUncertain` 走 `applyTransition`（无 `allowHung`），CAS 因 `hang_reason IS NULL` 闸门不命中，回 `STALE_GENERATION`，标记留在行上；fence 通道没有状态过滤，`timing_out→timeout` 这类出口不清 `fence_state`，终态行也可能进入换算（当前写路径同笔写检查点，实际只会走到重锚不会打标）；升级前已存在的终态标记同样没有清理出口 | 触发面限于升级前的存量行（当前所有写 action 锚点的路径都同笔写检查点，`hang_reason` 只在有检查点之后才落）与保留 `fence_state='armed'` 的终态行；节点本身压在裁决链上，业务处置仍走既有裁决，故记 P2。建议：reanchor 四个 SELECT 增加 `hang_reason IS NULL` 与终态排除（fence/action 两条补齐），并为存量标记提供一条「只清标记、不做状态迁移」的运维出口 |
| P3-1 | `src/infra/sqlite/migrations/026_recovery_units.sql` | 数值落在 `[1e6, 1e9)` 的行按模糊带保留原值；若其中含旧毫秒大预算（如 30 分钟 = 1.8e6），会被当成 1.8ms 提前到期 | 迁移注释与用例已写明，逐行写 `recovery_unit_fixes`（`reason='unclassified_kept'`）可人工核；失败方向是转人工（`indeterminate_side_effect`），不是静默成功。建议升级后按该表抽查一次 |
| P3-2 | `审计要求.md:127`；`state-machine.ts:18-26`、`run-close.ts:41`、`clock-recovery.ts:96` | 问题台账把全量写成 70 files / 939 passed，实测为 940（门证据 `ev-g2-16.md` 与 `full-suite.md` 记的是 940）；终态词表仍三处各自维护 | 差 1 例属文档记录误差，不影响门证据与裁决；词表统一为可读性改进，按既有 P3 清单安排 |

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
| `npx vitest run` | 70 files，940 passed / 1 skipped（11.76s） |
| `pnpm build` | 完成；ESM `lib/index.js` 300.94 kB / gzip 72.62 kB，`lib/index.d.ts` 24.43 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 28 份证据各重跑两遍，与 HEAD 字节一致 |
| `npx vitest run tests/integration/{chain-guard-entries,chain-guard-execution,recovery-uncertain,recovery-action-checkpoint,apply-report,run-close}.spec.ts` | 6 files，82 passed |
| `npx vitest run tests/integration/{cancel,control-dispatch,clock-recovery,sweep,subworkflow,g2}.spec.ts` | 6 files，109 passed（正常取消/派发/桥恢复/收口回归面） |
| 本人探针 `npx vitest run --root tmp/r69` | 7 例全过：上报侧、唤醒侧、执行器迁移、run 收口各 1；终态行不打标 1；等待登记确认 1；挂起行打标后确认回 `STALE_GENERATION` 1 |
| `node --no-warnings scripts/gate-check.ts` | 三门记录按预期待重签（报「候选提交之后，候选文件又被改过：AGENTS.md」）；本报告落盘并提交后按 G1→G2→G3 重签即可 |

证据文件与实测一致：`ev-g2-16.md` 记的 70 files / 940 passed / 1 skipped、`full-suite.md` 记的 300.94 kB / gzip 72.62 kB / d.ts 24.43 kB，与本人实跑逐字相同。

## 9. 退出条件与阶段性判定

| 退出条件 | 状态 |
| --- | --- |
| 无未解决 P0 | 满足 |
| 无未解决且阻碍下一阶段的 P1 | 满足（r68 的 P1-1 四条路径均有闸门与探针/用例双重覆盖） |
| 本轮修改已完成针对性审查 | 满足（第 3、4 节逐项） |
| 关键业务路径有测试与验证证据 | 满足（70 files / 940 例 + 28 份证据复现 + 7 条独立探针 + 109 例正常路径回归） |
| 核心数据、状态转换、外部副作用符合不变量 | 满足（断链隔离、CAS、检查点、终态枚举） |
| 重要异常路径有失败处理与恢复策略 | 满足（不确定态可查可确认；等待登记同笔撤销） |
| 未解决的 P2/P3 已记录并有影响说明 | 满足（第 6 节一条 P2、两条 P3） |
| 无未解释的测试、构建或兼容问题 | 满足 |
| 已形成可复现、可追溯的版本基准 | 满足（候选即 HEAD） |

可靠性收敛阶段通过，可以进入下一阶段开发。

## 10. 下一步建议

1. 在本报告提交后按 G1→G2→G3 重签三门记录，结束本轮全面收敛审计，转入 S4 流程定义与版本的功能开发；
2. 下一批顺手处理第 6 节 P2-1（reanchor 增加 `hang_reason IS NULL` 与终态排除，补一条存量标记的清理出口），不单独开专项轮次；
3. 升级部署时按 `recovery_unit_fixes` 抽查一次 `unclassified_kept` 行，确认没有大预算旧毫秒行被低估。
