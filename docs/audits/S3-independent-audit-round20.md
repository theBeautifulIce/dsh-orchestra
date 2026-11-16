# S3 独立审计报告 · G3 第 20 轮

门：G3
候选提交：fd2173bb719068e94c3713e5b08703ea932dd08d
审计日期：2026-11-16
审计方式：独立只读审计；未签门、未改生产代码/测试/证据/门记录；临时探针只放 `tmp/`，交付前删除

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 20,
  "candidate_commit": "fd2173bb719068e94c3713e5b08703ea932dd08d",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 4,
  "must_pass_total": 20,
  "must_pass_passed": 20,
  "must_pass_ids": [
    "G3-01",
    "G3-02",
    "G3-03",
    "G3-04",
    "G3-05",
    "G3-06",
    "G3-07",
    "G3-08",
    "G3-09",
    "G3-10",
    "G3-11",
    "G-01",
    "G-02",
    "G-04",
    "G-06",
    "G-12",
    "G-16",
    "G3-12",
    "G3-13",
    "G3-14"
  ],
  "failed_items": [],
  "notes": "r19 的 P1-1（断链隔离只落维护扫描）已由 applyTransition / transitionNode / closeRun 三处链闸堵住，两条原探针与两个正例实测符合预期；P2-3 的两个边界已修并复现。新闸门的代价集中在事件投递侧：断链 wait 会让同 run 的其它命中 wait 一起回滚（P2-3），断链检出仍只看链体（P2-1），围栏列残留仍在（P2-2）。20 项必过项全过，无阻断项。"
}
```
<!-- audit-verdict:end -->

## 1. 本轮审计基准

| 项 | 值 |
| --- | --- |
| 主线与本地 HEAD | 审计开始时 HEAD = `fd2173b`；复核期间团队在本地新增 `28717b6`（只新增 `docs/audits/S2-independent-audit-round69.md`，`src/` 与 `tests/` 逐字节未动）。本报告只绑定 `fd2173b` |
| 本轮候选 | `fd2173bb719068e94c3713e5b08703ea932dd08d` |
| 上一轮报告 | `docs/audits/S3-independent-audit-round19.md`（r19，候选 `dcee53d`） |
| diff 范围 | `dcee53d..fd2173b`，40 个文件、+823/−146，含 `0fda6ab`（链闸）、`140dd18`（台账）、`fd2173b`（P2 收尾）三个提交 |
| 生产代码改动 | `src/infra/db/ledger.ts`（新增 `assertChainIntact`）、`src/service/commands/{nodes,node-state,run-close,recovery,wait,cancel,decisions,compensation,confirm-start,subworkflow,lease,apply-report}.ts`、`src/service/{sweep,clock-recovery,dispatcher}.ts`、`src/index.ts`、迁移 `026` |
| 本轮新增用例 | `tests/integration/chain-guard-entries.spec.ts`（4 例）；`recovery-uncertain.spec.ts` 增 1 例与 2 处断言；其余为签名透传 |
| 必读文档 | `审计要求.md`、`scripts/gate-check.ts` 的 `GATE_SPECS.G3`、`src/core/state-machine.ts`、`GLOSSARY.md`、`docs/requirements.md`、`docs/design-notes.md` |
| 未能确认的范围 | 无（仓库、测试、构建与证据复现环境均可用） |
| 工作区观测 | 审计全程工作树干净；未使用 `git add/commit/checkout/stash` |

上一轮问题状态（逐条核对，不默认已修）：

| 编号 | 状态 | 依据 |
| --- | --- | --- |
| P1-1 断链隔离只落维护扫描 | 已修复并验证 | `assertChainIntact` 装在 `applyTransition`（`nodes.ts:128`，上报主干与全部状态推进）与 `transitionNode`（`node-state.ts:40`，执行器/上报的第二条入口）；`closeRun`（`run-close.ts:55-57`）在全部早退之后逐节点验链。r19 两条探针原样重跑见 §4 |
| P2-1 整链缺失检不出 | 仍在 | `assertChainIntact` 与 `sweep` 的断链集都只看链体，链被整条删除或尾截断时链体自洽（§5 探针 4/5） |
| P2-2 围栏状态残留 | 仍在 | `resolveRecoveryUncertain` 清锚点但不动 `fence_state`（§5 探针 7） |
| P2-3 清除路径两个边界 | 已修复并验证 | ①action 通道状态白名单补 `timeout`/`abandoned_unverified`（`clock-recovery.ts:96`），`recovery-uncertain.spec.ts` 新增终态行用例；②确认时同事务 `cancelWait`（`recovery.ts:51`），用例断言登记转 `cancelled` |

## 2. 本轮修改质量

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| `assertChainIntact`（`ledger.ts:98-108`） | 符合预期，无需修改 | 空链 `verifyChain([])` 返回 null，新建节点首次迁移不被误伤；抛出 `FORBIDDEN` 带 `reason`/`seq`/`detail`，宿主与用例都能按码判定 |
| 三处闸门的位置 | 符合预期 | `transitionNode` 走独立 CAS、不与 `applyTransition` 共用实现，两处都必须装；`closeRun` 的整链校验放在终态、未终态节点、活跃 decision 三个早退之后，只在真要收口时才付开销 |
| `secret` 透传到 `applyTransition`/`transitionNode`/`closeRun` | 符合预期 | 全部调用点已改（`src/index.ts`、`dispatcher.ts`、`sweep.ts`、`decisions.ts`、`compensation.ts`、`subworkflow.ts`、`wait.ts`、`cancel.ts`、`recovery.ts`、`apply-report.ts`、`scripts/fault-inject.ts`），旧签名零残留，typecheck 通过 |
| `closeRun` 的失败面 | 符合预期 | 链断时返回 null、不写 `run.terminal`、不抛异常；同 run 的健康节点仍可被租约与 `transitionNode` 推进（§4 正例） |
| `resolveRecoveryUncertain` 同事务 `cancelWait` | 符合预期 | 位置在 revision 校验之后、清锚点之前；没有活跃登记时返回 false，无副作用。探针确认后同 run 的事件投递恢复正常 |
| action 通道状态白名单 | 符合预期 | fence 通道有 `fence_state='armed'`、wait 通道有 `status='waiting'`、startup 通道有 `status='startup_unknown'` 三个隐式约束，只有 action 通道需要显式排除；补完与 `TERMINAL_STATUSES` 对齐 |
| 桥恢复写检查点（`sweep.ts:256-272`） | 符合预期 | `startup_unknown` 与 `verifying` 恢复时把新预算同笔落成检查点，连续两次重启也能续算；`sweep.spec.ts` 断言同步更新 |
| 迁移 `026` 识别口径 | 符合预期（取舍见 P3-3） | 不再以「缺单调锚点」识别（生产旧写入路径四列同写），改按数值量级三档分类，逐行写 `recovery_unit_fixes` 便于人工核 |
| 测试改动 | 符合预期 | 新增四例覆盖上报、执行器迁移、run 收口、等待唤醒四条外部入口；`recovery-uncertain` 补登记状态与终态行两处；其余只做签名透传，断言未放松 |

## 3. 必过项与不变量的针对性核对

| 不变量 | 核对方式 | 结论 |
| --- | --- | --- |
| §4.1 状态机闭合 | 迁移表本轮未改；`g3-faults`、`state-machine`、`transition-rules`、`control-transition-guard` 全绿 | 符合 |
| §4.2 代次不混 | 链闸不改 `action_generation`/`rearm_generation` 判定；`transition-guard`、`lease` 用例全绿 | 符合 |
| §4.3 时钟与检查点 | `refreshCheckpointsInTx` 仍按锚点补检查点；桥恢复由清空改为写检查点；不确定态清除路径对非终态行成立 | 符合 |
| §4.5 终态枚举 | `TERMINAL_STATUSES` 未改；`indeterminate_side_effect` 仍是非终态、不进 `closeRun` 终态集合 | 符合 |
| §4.6 断链隔离 | 断链节点在两个迁移入口与 run 收口三处都被挡下且不被收口；同 run 健康节点照常推进；同 run 的其它命中 wait 会被整笔回滚（见 P2-3） | 前两条符合，第三条见 P2-3 |
| §4.8 对外副作用边界 | `PATCH_COLUMNS` 与 `/v1/recovery/resolve` 请求体本轮未变，列名未透出 | 符合 |

## 4. r19 探针原样重跑与正例（本人实跑）

| 探针 | 实测输出 | 判定 |
| --- | --- | --- |
| 探针 1：断链 `verifying` + 新报告（r19 原文形态） | 扫描先检出 `chain_broken = nr_x`；`applyReport` → `FORBIDDEN {"reason":"chain_broken","seq":1,"detail":"hash 对不上，内容被改过"}`；节点停在 `verifying`、`revision` 与链头 `last_seq/last_hash` 均不变 | 符合预期 |
| 探针 2：断链 `waiting` + 命中事件（r19 原文形态） | `wakeOnEvent` → `FORBIDDEN chain_broken`；节点 `waiting`、run `running`、`wait_event_inbox` 0 行、无 `run.terminal` | 符合预期 |
| 正例 A：同 run 健康节点照常推进 | 同 run 另有一个断链兄弟节点时，健康节点 `acquireLease` 与 `transitionNode(dispatched→started)` 均正常返回，终态 `started` | 符合预期 |
| 正例 B：`closeRun` 只拦坏账本 | 节点全终态且链完整 → `succeeded` 并写 `run.terminal`；同 run 有断链节点 → 返回 null、run 保持 `running`、`run.terminal` 0 条 | 符合预期 |
| 探针 6：断链节点的取消与恢复确认 | `applyCancel(already_stopped)` 走的是不经过迁移表的 CAS 分支，返回正常（保留停止动作）；随后 `resolveRecoveryUncertain` 返回 `FORBIDDEN chain_broken` | 见 P2-4 |

## 5. 新闸门的失败面（本人实跑）

| 探针 | 实测输出 | 判定 |
| --- | --- | --- |
| 探针 3：同 run 两条 `wait`，一条断链一条健康，同一事件命中 | `wakeOnEvent` → `FORBIDDEN chain_broken`；健康 wait 仍 `waiting`、两条登记都还是 `active`、`wait_event_inbox` 0 行（整笔回滚） | 见 P2-3 |
| 探针 8：断链节点不是 `wait` 时 | 同 run 的健康 wait 正常唤醒到 `done`，事件落 inbox，`wakeOnEvent` 正常返回 | 符合预期（闸门按节点判定，不误伤无关节点） |
| 探针 4：整条链被删（链头仍在） | `applyReport` 未被链闸挡下，返回 `evidence_unverifiable`，并按链头 `last_seq=2` 追加 `seq=3`，`prev_hash` 指向账本里已不存在的行 | 见 P2-1 |
| 探针 5：尾截断（链头仍记更多） | 同上：上报未被链闸挡下，链头从 2 推进到 3 | 见 P2-1 |
| 探针 7：`timing_out_grace` 确认后 | 节点到 `indeterminate_side_effect`、`recovery_uncertain` 与宽限锚点已清空，但 `fence_state` 仍为 `armed`、`fence_grace_until` 为空 | 见 P2-2 |

## 6. 可延期问题

| 编号 | 等级 | 位置 | 说明 |
| --- | --- | --- | --- |
| P2-1 | P2 | `src/infra/db/ledger.ts:98`、`src/service/sweep.ts:88-90`、`src/service/commands/run-close.ts:56` | 断链判定只比对链体本身：链被整条删除或只删掉尾部时，链体仍自洽，`assertChainIntact`、扫描断链集与 `closeRun` 都放过（探针 4/5）。触发需要账本层改动，且新追加的事件会让链头与链体错位、下一轮 `verifyLedger` 能指出缺口，故记 P2；建议三处都改用「链体 + 链头」一并核对（`verifyLedger` 的缺口口径已现成） |
| P2-2 | P2 | `src/service/commands/recovery.ts:54-63` | `timing_out_grace` 通道确认后只清四列锚点，`fence_state` 仍 `armed`（探针 7）。该组合下 `fence_grace_until` 为空，扫描与撤销围栏都取不到它，节点按 M-50 走裁决链收口，不构成节点级卡死；可达性低（围栏与检查点同笔写），记 P2。建议确认时把 `fence_state` 一并置空或 `revoked` |
| P2-3 | P2 | `src/service/commands/wait.ts:125-171`、`:289-301` | 链闸装在 `applyTransition` 内，`scanRun` 逐条唤醒时若某条登记属于断链节点，异常会把整笔事件投递回滚：同 run 其它命中的 wait 也不推进、事件不落 inbox（探针 3）。断链节点本身不是命中 wait 时不触发（探针 8）。租约、报告、维护扫描都是按节点隔离的，唯独这条入口按 run 回滚，与 §4.6「不得阻塞同 run 的其它节点」有出入；触发前提是账本已被改动且断链节点自身是活跃 wait，run 本来也收不了口，调用方拿到 403 可在核账后重投，故记 P2。建议在 `scanRegistration` 内按登记跳过断链节点（与 `sweep` 的 `skipNodeRunIds` 同口径），而不是让异常冒到整笔事务 |
| P2-4 | P2 | `src/service/commands/recovery.ts:64-75` | 节点同时带 `recovery_uncertain` 与断链时，唯一清除入口 `resolveRecoveryUncertain` 被链闸挡下（探针 6），标记无法清除。该节点本来只能人工核账、无法被推进或收口，标记只在查询里长期可见，不构成新的节点级卡死（与 r19 P2-3 ①的判定口径一致），记 P2；处置顺序写进值班手册即可：先核账修链，再确认不确定态 |

| 编号 | 等级 | 位置 | 说明 |
| --- | --- | --- | --- |
| P3-1 | P3 | `src/infra/db/ledger.ts:98`、`src/service/commands/run-close.ts:55` | 每次迁移读整条链、`closeRun` 逐节点读整链，单节点代价随链长线性增长；未证明成为瓶颈，先记录 |
| P3-2 | P3 | `审计要求.md:127` | 台账行写「939 passed」，`docs/gates/evidence/G3/full-suite.md` 与实测均为 940，属文档口径差异，不影响门禁 |
| P3-3 | P3 | `src/infra/sqlite/migrations/026_recovery_units.sql:25-31` | 小于 `1e6` 的区间一律按毫秒换算；真实纳秒预算若不足 1ms（本就要到期）会被放大成秒级，方向是延后到期而非提前。一次性迁移、逐行记账可核，记 P3 |

## 7. 测试与质量证据（本人实际执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `npx vitest run` | 0 | 70 files；940 passed / 1 skipped |
| `pnpm build` | 0 | ESM `lib/index.js` 300.94 kB（gzip 72.62 kB）、`index.d.ts` 24.43 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 28 份，重跑两遍与 HEAD 字节一致（含 G3 注入摘要） |
| `npx vitest run tests/integration/g3-faults.spec.ts tests/integration/state-machine.spec.ts tests/integration/sweep.spec.ts tests/integration/chain-guard-entries.spec.ts tests/integration/chain-guard-execution.spec.ts` | 0 | 5 files；42 passed |
| 自写探针（`tmp/r20-probe`，10 例，交付前删除） | 0 | 见 §4、§5 的实测输出 |

## 8. 二十项必过项

| 必过项 | 证据 | 判定 |
| --- | --- | --- |
| G3-01 / G3-02 | ev-g3-01 / ev-g3-02；`g3-faults`、`state-machine`、`transition-rules` 实跑 | pass |
| G3-03 / G3-04 / G3-05 | ev-g3-03 / ev-g3-04 / ev-g3-05；`clock-recovery`、`approval`、`policy-branch` 实跑 | pass |
| G3-06 / G3-07 / G3-08 / G3-09 | ev-g3-06 / ev-g3-07 / ev-g3-08 / ev-g3-09；`parallel`、`wait`、`subworkflow`、`compensation` 实跑 | pass |
| G3-10 / G3-11 | ev-g3-10 / ev-g3-11；`apply-report`、`sweep` 实跑；断链隔离本轮由三处链闸加强 | pass |
| G-01 / G-02 / G-04 / G-06 / G-12 / G-16 | 六条注入证据；`g3-faults` 实跑 | pass |
| G3-12 / G3-13 / G3-14 | ev-g3-12 / ev-g3-13 / ev-g3-14；起运行、批准人三档、全量 70 files 与 build 全绿 | pass |

## 9. 阶段性结论

结论：pass

依据：r19 的 P1-1 已在两个迁移入口与 run 收口三处闭环，两条原探针与两个正例实测符合预期；P2-3 的两个边界已修并有回归；20 项必过项全过，类型检查、全量用例、构建与证据复现全部实跑通过；通用退出条件九条逐项成立。本轮新增的 4 条 P2 都属于账本被改动或极端时钟组合下的健壮性改进，有明确影响说明与处理建议，不构成阻断。**可靠性收敛阶段通过，可以进入下一阶段开发。** 建议结束本轮全面收敛审计，按 G1→G2→G3 重签门记录后转入 S4 流程定义与版本的功能开发；§6 的 P2/P3 攒入下一批随功能开发处理，不必为它们再开专门轮次。
