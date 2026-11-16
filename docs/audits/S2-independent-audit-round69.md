# S2 独立审计报告 · G2 第 69 轮

门：G2
候选提交：fd2173bb719068e94c3713e5b08703ea932dd08d
审计日期：2026-11-16
审计方式：独立只读审计；未签门、未改生产代码/测试/证据/门记录

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
  "notes": "r68 的 P1-1（上报/唤醒两条入口推进断链节点）已由三处链闸堵住并复现验证；P2-2 已修，P2-1 的终态行分支已修，只留挂起行/遗留标记一条 P2。20 项必过项证据全部复现。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：**pass**

P0 = 0，P1 = 0，P2 = 1；必过项 20/20。

## 2. 审计基准

| 项 | 值 |
| --- | --- |
| 主线 HEAD / 本轮候选 | `fd2173bb719068e94c3713e5b08703ea932dd08d`（工作树干净，候选即 HEAD） |
| 审计范围 | `git diff dcee53d..fd2173b`（上一轮候选到本轮候选，40 个文件，823 插入 / 146 删除），含 `0fda6ab`（链闸）、`140dd18`（文档）、`fd2173b`（P2 收尾）三个提交 |
| 生产代码改动 | `src/infra/db/ledger.ts`（新增 `assertChainIntact`）、`src/service/commands/{nodes,node-state,run-close,recovery,wait,cancel,decisions,compensation,confirm-start,subworkflow,lease,apply-report}.ts`（链闸与签名透传）、`src/service/{sweep,clock-recovery,dispatcher}.ts`、`src/index.ts`、`src/infra/sqlite/migrations/026_recovery_units.sql`（识别口径重写） |
| 测试改动 | 新增 `tests/integration/chain-guard-entries.spec.ts`（4 例）；`recovery-uncertain.spec.ts` 加 2 处断言 / 1 例；其余为签名透传与断言更新 |
| 上一轮 | `docs/audits/S2-independent-audit-round68.md`（候选 `dcee53d`，fail，P1×1 / P2×2） |
| 必读文档 | `审计要求.md`（§2/§4/§5/§6/附录 A）、`scripts/gate-check.ts` 的 `GATE_SPECS.G2`、`GLOSSARY.md`、`docs/requirements.md`、`docs/design-notes.md`、`handoff.md` §0.1 |
| 未能确认的范围 | 无 |

## 3. 上一轮问题复核（逐条，不默认已修复）

| 编号 | 复核位置（本人读到） | 结论 | 验证方式 |
| --- | --- | --- | --- |
| P1-1：上报与唤醒两条入口推进断链节点 | `src/infra/db/ledger.ts:98` 新增 `assertChainIntact`（`FORBIDDEN` + `details.reason='chain_broken'`，带 `seq`/`detail`）；`src/service/commands/node-state.ts:40`（`transitionNode`，上报主干）与 `src/service/commands/nodes.ts:128`（`applyTransition`）各装一处；`src/service/commands/run-close.ts:56` 在全部早退之后逐节点 `chainBreakOf` → `return null` | 已修复并验证 | 我自己的探针在候选上复跑：断链 `verifying` + `applyReport` → `FORBIDDEN`，节点停在 `verifying`；断链 `waiting` + `wakeOnEvent` → `FORBIDDEN`，节点停在 `waiting`、run 停在 `running`、`run.terminal` 0 条、inbox 0 行。另 `tests/integration/chain-guard-entries.spec.ts` 四例（上报 / `transitionNode` / `closeRun` / 唤醒）实跑通过 |
| P2-1：不确定标记落在终态行后清不掉 | `src/service/clock-recovery.ts:96` 的 action 通道状态白名单补入 `timeout`、`abandoned_unverified`；`tests/integration/recovery-uncertain.spec.ts` 新增「终态行不会被打成不确定」一例 | 部分修复：终态行分支已闭环，挂起行与遗留标记仍在（见第 5 节 P2-1） | 探针：`abandoned_unverified` 行（旧 boot 锚点 + 空检查点）扫一轮后 `recovery_uncertain` 为空；同一轮的 `stopping` + `hang_reason='action_overrun'` 行仍被打标，确认接口回 `STALE_GENERATION` |
| P2-2：确认接口留下 active 等待登记 | `src/service/commands/recovery.ts:50` 在清锚点前调用 `cancelWait`；用例断言登记转 `cancelled` | 已修复并验证 | 探针：确认后登记 `state='cancelled'`，随后同 run 的匹配事件 `wakeOnEvent` 正常返回，`wait_event_inbox` 落 1 行（不再整笔回滚）；用例实跑通过 |
| P3-1：终态词表多处手写 | 未动（`state-machine.ts:18`、`run-close.ts:41`、`clock-recovery.ts:96`） | 仍为 P3，不阻断 | 代码阅读 |

## 4. 本批修改质量（逐项）

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| `assertChainIntact`（`ledger.ts:98`） | 符合预期，无需修改 | 统一抛 `FORBIDDEN` 并带 `reason: chain_broken`、`seq`、`detail`，宿主与测试都能按码判定；空链 `verifyChain([])` 返回 null，新建节点首次迁移不被误伤 |
| 三处链闸（`nodes.ts:128`、`node-state.ts:40`、`run-close.ts:56`） | 符合预期 | 两条迁移入口各自验链（`transitionNode` 走自己的 CAS，不与 `applyTransition` 共用实现，必须两处都装）；`closeRun` 的整链校验放在所有早退之后，只在真要收口时才付开销 |
| `closeRun` 签名增加 `secret` | 符合预期 | 全部调用点（`index.ts:174/212/275`、`wait.ts:284/299/350`、`dispatcher.ts:117`、`decisions.ts:220/360`、`compensation.ts:174`、`sweep.ts:380/394`、`subworkflow.ts`）都已透传，typecheck 与全量用例通过 |
| `resolveRecoveryUncertain` 调 `cancelWait` | 符合预期 | 位置在 revision 校验之后、清锚点之前；无登记时 `cancelWait` 返回 false，无副作用 |
| `clock-recovery` 状态白名单补 `timeout`/`abandoned_unverified` | 符合预期 | 三个通道本来就有隐式状态约束（fence 只认 `armed`、wait 只认 `waiting`、startup 只认 `startup_unknown`），只有 action 通道需要显式排除；补完与终态集合对齐 |
| `sweep` 的桥恢复写检查点而非清空 | 符合预期 | `startup_unknown` / `verifying` 恢复时把新预算同笔写成检查点，避免连续两次重启后丢失可信剩余（S1 r67 P2-2） |
| 迁移 026 识别口径重写 | 符合预期（取舍见 P3-1） | 不再以「缺单调锚点」识别（生产旧路径四列同写），改按数值量级分三档，`unclassified_kept` 逐行记账；用例覆盖旧毫秒、正确纳秒、模糊带、0、超大值五种形态 |
| 测试改动 | 符合预期 | 新增四例覆盖三条外部入口；`recovery-uncertain` 补登记状态与终态行两处；其余为签名透传，断言未放松 |

## 5. 可延期问题

| 编号 | 位置 | 说明 | 影响与证据 |
| --- | --- | --- | --- |
| P2-1 | `src/service/clock-recovery.ts:95-98`；`src/service/commands/recovery.ts:61-73`；`src/service/sweep.ts:99-104`、`:392-395` | 挂起行（`hang_reason` 非空）仍在 reanchor 的取值范围内，被标不确定后确认接口因 `hang_reason IS NULL` 闸回 `STALE_GENERATION`，标记留在行上；升级前已存在的终态行标记也没有清理路径 | 触发条件限于遗留/外部写入的行（当前所有写锚点的路径都同笔写检查点，`hang_reason` 只在有检查点之后才落），探针复现：`stopping` + `hang_reason='action_overrun'` + 旧 boot 锚点 + 空检查点 → 打标，确认失败。节点本身还挂在裁决卡上，业务结果可由裁决链收口，标记只影响 run 的自动收口，故记 P2；建议 reanchor 四个 SELECT 加 `hang_reason IS NULL`，并给升级前的存量标记留一条只清标记不迁移的出口 |
| P3-1 | `src/infra/sqlite/migrations/026_recovery_units.sql` | 数值落在 `[1e6, 1e9)` 的行按「模糊带」保留原值，其中若含旧毫秒大预算（如 30 分钟 = 1.8e6），会被当成 1.8ms 提前到期 | 已在迁移注释与用例中写明，且逐行写 `recovery_unit_fixes`（`reason='unclassified_kept'`）可人工核；失败方向是转人工（`indeterminate_side_effect`），不是静默成功。建议升级后按该表抽查一次 |

## 6. 必过项核对（20 项）

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

## 7. 实测命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `npx vitest run` | 70 files，940 passed / 1 skipped（10.79s） |
| `pnpm build` | 完成；ESM `lib/index.js` 300.94 kB / gzip 72.62 kB，`lib/index.d.ts` 24.43 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 28 份证据各重跑两遍，与 HEAD 字节一致 |
| `npx vitest run`（8 个重点文件：chain-guard-entries、chain-guard-execution、clock-recovery、recovery-uncertain、recovery-action-checkpoint、recovery-unit-migration、sweep、run-close） | 8 files，59 passed |
| 自写探针（候选工作树上跑，已删除） | 上报侧与唤醒侧均 `FORBIDDEN`；终态行不再打标；等待登记确认后转 `cancelled` 且事件正常入 inbox |
| `node --no-warnings scripts/gate-check.ts` | 三门记录按预期待重签（`AGENTS.md` 与链闸修复在三份报告绑定的候选之后改动过） |

证据文件与实测逐字一致：`ev-g2-16.md` 记的 70 files / 940 passed / 1 skipped、`full-suite.md` 记的 300.94 kB / gzip 72.62 kB / d.ts 24.43 kB。

## 8. 退出条件与阶段性结论

| 退出条件 | 状态 |
| --- | --- |
| 无未解决 P0 | 满足 |
| 无未解决且阻碍下一阶段的 P1 | 满足（r68 的 P1-1 三条入口全部堵住并有四例回归） |
| 本轮修改已完成针对性审查 | 满足（第 3、4 节逐项） |
| 关键业务路径有测试与验证证据 | 满足（70 files / 940 例 + 28 份证据复现 + 探针） |
| 核心数据、状态转换、外部副作用符合不变量 | 满足（断链隔离、CAS、检查点、终态枚举） |
| 重要异常路径有失败处理与恢复策略 | 满足（不确定态可查可确认，等待登记同笔收掉） |
| 未解决 P2/P3 已记录并有影响说明 | 满足（第 5 节） |
| 无未解释的测试/构建/兼容问题 | 满足 |
| 已形成可复现、可追溯的版本基准 | 满足（候选即 HEAD，工作树干净） |

可靠性收敛阶段通过，可以进入下一阶段开发。建议结束本轮全面收敛审计，按 G1→G2→G3 重签门记录后转入 S4 流程定义与版本的功能开发；第 5 节两条 P2/P3 攒入下一批处理即可，不必为它们再开一轮专门审计。
