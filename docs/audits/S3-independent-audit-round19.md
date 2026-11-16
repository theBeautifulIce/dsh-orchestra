# S3 独立审计报告 · G3 第 19 轮（不通过记录）

门：G3
候选提交：dcee53d3c3c25dda230cf8dc3bf800d223ff1b58
审计日期：2026-11-16
审计方式：独立审计；未签门、未改生产代码；临时探针只放 `tmp/`，交付前已删除

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 19,
  "candidate_commit": "dcee53d3c3c25dda230cf8dc3bf800d223ff1b58",
  "conclusion": "fail",
  "p0": 0,
  "p1": 1,
  "p2": 3,
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
  "failed_items": [
    "P1-1 断链隔离只落在维护扫描：报告上报与等待唤醒两条入口仍能把断链节点推进到终态，等待唤醒还能把含断链节点的 run 收口"
  ],
  "notes": "r67 的 P1-1a/P1-1b 与台账 P1-2026-11-16-01 已修复并实测；本轮新证据显示执行侧/事件侧断链隔离仍不闭环（扫描内已闭环）。不确定态的清除路径对非终态行成立，终态行与等待登记两处不完整，记为 P2-3。必过项 20/20 不受影响。"
}
```
<!-- audit-verdict:end -->

## 1. 本轮审计基准

| 项 | 值 |
| --- | --- |
| 主线与本地 HEAD | 审计开始时 HEAD = `dcee53d`（与候选同一提交，生产代码逐字节一致）；复核期间 HEAD 前进到 `7a1e48b`（只改 `AGENTS.md` 4 行，`src/`、`tests/` 未变）。本报告只绑定 `dcee53d`，按 §6 不能用于在 `7a1e48b` 上签门 |
| 本轮候选 | `dcee53d3c3c25dda230cf8dc3bf800d223ff1b58` |
| 上一轮报告 | `docs/audits/S3-independent-audit-round18.md`（r18，候选 `5098847a60b`） |
| diff 范围 | `5098847..dcee53d`，36 个文件、+1735/−229 |
| 生产代码改动 | `clock-recovery.ts`、`sweep.ts`、`dispatcher.ts`、`commands/{lease,cancel,confirm-start,decisions,wait,nodes,node-state,recovery}.ts`、`queries/recovery.ts`、`server.ts`、`schemas.ts`、`index.ts`、迁移 `025`/`026` |
| 本轮新增用例 | `chain-guard-execution`、`recovery-uncertain`、`recovery-action-checkpoint`、`recovery-unit-migration`、`dispatch-retry` |
| 未能确认的范围 | 无（仓库、测试与构建环境均可用） |
| 工作区观测 | 审计结束时工作区存在他人未提交的整改（`src/service/commands/*.ts`、`run-close.ts`、`tests/*` 等），既不属于候选、也不参与本轮判定；本轮全部结论只针对 `dcee53d` 的已提交代码 |

上一轮问题状态（逐条核对，不默认已修）：

| 编号 | 状态 | 依据 |
| --- | --- | --- |
| S2 r67 P1-1a 断链子 run 仍推父节点 | 已修复并验证 | `sweep.ts:372-376` 三处 `skipNodes`/`taintedRuns` 闸；`clock-recovery.spec.ts` 断链用例通过 |
| S2 r67 P1-1b wait 超时收口无断链闸 | 已修复并验证 | `wait.ts:349-350` 加 `skipRunIds`；`sweep.ts:112` 传 `taintedRuns` |
| P1-2026-11-16-01 动作检查点不落库 | 已修复并验证 | 见 §2.2 与 §5 探针 |
| 评审 P2-3 派发错误码 | 已修复并验证 | `dispatcher.ts:35-39` 白名单；`tests/unit/dispatch-retry.spec.ts` |
| 评审 P2-4 不确定态只能手工改库 | 已修复并验证 | `GET /v1/recovery/uncertain`、`POST /v1/recovery/resolve` + 3 例用例 |

## 2. 本轮修改质量

### 2.1 恢复扫描的跳过集（Q1：扫描内闭环）

`sweep.ts:94-112` 现在先算 `broken ∪ recovery_uncertain = skipNodes`，再算 `taintedRuns`，然后统一传给全部推进点：围栏撤销（:123）、verifying（:140）、startup_unknown（:166）、桥断（:208）、桥恢复（:238）、动作时限（:302）、执行器失联（:337）、子流程回收（:373-376）、决策超时（:389）、wait 超时（:112）、run 收口（:393）。逐条对照后没有发现仍用旧 `broken` 集合或漏传的推进点，`sweepInboxReceipts` 只动 inbox、不碰节点，不需要跳过集。这一层与 r18 相比是扩大而非收窄。

### 2.2 检查点与跨 boot 时钟（Q3：判定不依赖墙钟）

- 判定侧 `MonotonicClock.decide`（`clock.ts:52-62`）只比 boot_id、漂移与单调纳秒，墙钟仅用于展示；`refreshCheckpointsInTx` 与 `reanchorInTx` 的顺序（先按当前 boot 递减、再换算旧 boot 锚点）正确，两个分支不会互相覆盖。
- `refreshCheckpointsInTx` 去掉 `AND {column} IS NOT NULL`（`clock-recovery.ts:170`）后，按 `deadline_*_monotonic_ns` 补齐检查点，语义是"锚点减当前单调钟"，不是猜剩余量；对 `rearmDeadline` 清空检查点的行，下一轮扫描会按新锚点补回真实剩余，没有引入虚假可信值。
- `confirm-start.ts:69` 与 `cancel.ts:192` 把检查点与锚点同笔写；`extendDeadlineMs` 为 0 时检查点为 0，重启后立即生成 `action_overrun` 卡，与重启前"截止时间就是现在"的判定一致，不是新的误判。
- 迁移 `026` 只重写 `startup_unknown_remaining_ns`（预算列）并建 `recovery_unit_fixes` 审计表，不触碰 `status`、`revision`、`attempt` 与任何终态集合，状态机语义不变；识别口径限定"缺单调锚点 + 毫秒量级"，带锚点的行与已是纳秒的行都不动（`recovery-unit-migration.spec.ts` 3 例覆盖）。

### 2.3 不确定态的写入与清除（Q2：可清除，清完不会被标回）

写入点只有 `clock-recovery.ts:71-82`（检查点缺失），清除路径只有 `POST /v1/recovery/resolve` → `recovery.ts:35-80`：先验 `recovery_uncertain` 非空与 `revision`，再按通道把 `deadline/boot/monotonic/checkpoint` 四列与标记一起清空，最后走 M-50 落 `indeterminate_side_effect`，之后由 M-51/M-52/M-53 收口（`state-machine.ts:198-200`）。清空后同一通道的锚点已不存在，下一轮 `reanchorInTx` 不会再命中（探针与 `recovery-uncertain.spec.ts:88-92` 一致），`indeterminate_side_effect` 也不在 `closeRun` 的终态集合里（`run-close.ts:41`），因此只能靠裁决链收口，不是"永久钉死"。

这个结论只对**非终态行**成立，两处边界不成立，合并记为 P2-3：①`clock-recovery.ts:95-98` 的状态白名单漏了 `timeout` 与 `abandoned_unverified`，这两类终态行一旦被打标，`resolve` 会因 M-50 只接受非终态而回 `STALE_GENERATION`，标记没有任何清除路径；②确认时不清 `wait_registrations`，残留的 `active` 登记会让该 run 之后每一次 `wakeOnEvent` 因 `waiting→done` 迁移失败而整笔回滚（inbox 0 行）。

### 2.4 对外副作用边界

`PATCH_COLUMNS` 新增的 `action/wait/fence_remaining_ns`、`recovery_uncertain`、`recovery_uncertain_at` 只在 `applyTransition` 内部使用（`nodes.ts:16-31`、`:194`），路由层没有把列名透出成自由字段；`/v1/recovery/resolve` 的请求体只收 `nodeRunId`/`revision`/`resolution` 三键（`schemas.ts:330-334`）。

## 3. 必须阻断的问题（P1）

### P1-1 断链隔离只落在维护扫描，报告与等待唤醒两条入口仍能推进断链节点

| 项 | 内容 |
| --- | --- |
| 位置 | `src/service/commands/apply-report.ts:289`（`applyReport` 主干，链校验只在 replay 分支 `:338`）；`src/service/commands/wait.ts:289-300`（`wakeOnEvent` → `scanRun` 推进 + `:299` 无条件 `closeRun`） |
| 现状 | 断链判定只在 `sweep.ts:88-90` 与 `lease.ts:64-69`（派发入口）做；上报主干与事件唤醒两条路径没有任何链校验，`applyTransition`/`transitionNode`/`closeRun` 也没有统一闸门。注意 `transitionNode`（`node-state.ts:38`）是**独立于 `applyTransition` 的第二条迁移入口**，被 `apply-report.ts:524`、`run-node.ts:222/237/259/320/485`、`sweep.ts:537` 直接调用，只给 `applyTransition` 加闸不会覆盖上报主干 |
| 触发条件 | 节点哈希链已断（`sweep` 在同一次扫描里已把它列进 `chain_broken`）；此时执行器在既有租约下提交一条新报告，或 wait 节点收到命中事件 |
| 实际影响 | 违反本项目不变量 §4.6「断链节点不得被推进、不得被收口」：报告路径把断链节点推进到 `done` 并继续往坏账本追加事件；等待唤醒路径把断链节点推进到 `done`，并在同一事务里把含断链节点的 run 收口成终态。r67 P1-1b 只给 `timeoutWaiting` 加了闸，`wakeOnEvent` 这一侧的 `closeRun` 仍未加，属同一条缺陷的旁路 |
| 严重性依据 | 核心不变量失效 + 与上一轮刚判过的 P1-1b 同类；候选提交说明自称"关闭执行侧旁路"，实测未闭环，属"旧修复部分修复" |
| 修复建议 | 两条迁移入口都要加闸，不能只加一条：`applyTransition`（`nodes.ts`）与 `transitionNode`（`node-state.ts:38`，被上报主干 `apply-report.ts:524` 与执行器 `run-node.ts` 直接调用）各自在入口按 `nodeRunId` 验链，链断直接 `FORBIDDEN/chain_broken`；`wakeOnEvent`/`scanRun` 与 `enterWaiting` 的 `closeRun` 传 `skipRunIds`（与 `timeoutWaiting` 一致），`recordWaitEvent` 也可提前拒绝。保留 `sweep` 现有跳过集不变。若只在 `applyTransition` 加闸，本项 P1 仍然成立 |
| 验证方案 | 新增四例：①断链 `verifying` + 新报告 → 拒绝、节点与链头不变（走 `transitionNode`）；②断链 `waiting` + 命中事件 → 不唤醒、run 不收口；③同 run 健康节点照常推进（闸门只拦断链那一条）；④至少一条经 `runNode`（内部 `runNodeActions` → `transitionNode`，`run-node.ts:113/178`）的执行器路径同样被拒（不必新造入口，走公开的 `runNode` 即可）。现有 `chain-guard-execution.spec.ts` 的派发用例保持通过 |

证据（`tmp/` 临时探针，跑完已删）：

```text
探针1 断链(扫描检出=true) 后报告: {"accepted":true,"next_status":"done","registry_state":"applied"}
  节点={"status":"done","action_generation":1} 事后仍断链=true
探针2 断链 wait 唤醒: {"eventSeq":1,"woken":1} 节点=done run=succeeded_with_unverified
```

## 4. 可延期问题（P2 / P3）

| 编号 | 等级 | 位置 | 说明 |
| --- | --- | --- | --- |
| P2-1 | P2 | `sweep.ts:88-90` | 断链检出只看"已有链"：整条链缺失或被删的节点进不了 `broken` 集，也不会被隔离；`verify_ledger` 已把"节点动过却没链"算成缺口，可作为补检口径（探针：该节点 `chain_broken=[]`，校验器报 gap） |
| P2-2 | P2 | `recovery.ts:49-60` | 确认时只清 `recovery_uncertain` 对应通道的锚点，不清 `fence_state`；若通道是 `timing_out_grace`，会留下"围栏仍 armed、宽限为空"的行，之后报告入口的围栏闸会持续拒绝，只能走 M-52/M-53 收口。可达性低（围栏与检查点同笔写） |
| P2-3 | P2 | `clock-recovery.ts:95-98`、`recovery.ts:49-72` | 不确定态的清除路径不完整，两个子情形：①状态白名单漏 `timeout`/`abandoned_unverified`，这两类终态行被打标后 `resolve` 恒回 `STALE_GENERATION`，标记无法清除、查询里永久挂着（§5 探针 5）；②确认只清锚点不清 `wait_registrations`，残留 `active` 登记使该 run 之后每次 `wakeOnEvent` 整笔回滚、inbox 落 0 行（§5 探针 6）。节点已终态/已按 M-50 落定，不构成节点级卡死，故按 P2；与 s2 r68 的 P2-1/P2-2 同源，不重复开记录 |
| P3-1 | P3 | `clock-recovery.ts:173-176` | `clock.bootId` 以字符串拼接进 SQL；bootId 由内部生成、当前不可注入，仍建议改参数化，避免将来换成外部时钟时留口子 |
| P3-2 | P3 | `clock-recovery.ts:159-177` | 每轮扫描对每一行有当前 boot 锚点的节点做一次同值 UPDATE（默认 2 秒一轮），节点多时有写放大；未证明成为瓶颈，先记录 |

## 5. 测试与质量证据（本人实际执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `npx vitest run` | 0 | 69 files；935 passed / 1 skipped |
| `pnpm build` | 0 | ESM `lib/index.js` 299.67 kB（gzip 72.32 kB）、`index.d.ts` 24.43 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 28 份，重跑两遍与 HEAD 字节一致 |
| `npx vitest run tests/integration/g3-faults.spec.ts tests/integration/state-machine.spec.ts tests/integration/sweep.spec.ts tests/integration/decision-sweep.spec.ts` | 0 | 4 files；46 passed |

修复确认探针（临时脚本，非正式用例）：

| 探针 | 结果 |
| --- | --- |
| 墙钟前跳 1 小时 + 检查点 30s 重启 | 重锚到 `07:00:30`、剩余 30s、无 `action_overrun`，不放大预算 |
| `extendDeadlineMs=0` 取消后重启 | 检查点 0 → 生成 `action_overrun` 卡、不落 `recovery_uncertain`，与重启前判定一致 |
| 同一 boot 两轮扫描的检查点 | 30s→20s→10s 单调递减，不滑动 |
| 检查点缺失的等待节点 → 确认 → 再扫描 | 标记与锚点被清空，第二轮不再标回 |
| 断链 + 新报告 / 断链 wait + 事件 | 两条入口都推进成功（P1-1 的证据） |
| 探针 5：`timeout` 行带旧 boot 锚点 + 空检查点 | `sweep` 打标 `recovery_uncertain=action_deadline`；`resolve` 回 `STALE_GENERATION`；再扫仍是 `timeout` + 标记、`listRecoveryUncertain` 计数 1（`abandoned_unverified` 同）；`orphaned` 本就在排除列表里、不打标 |
| 探针 6：等待节点被打标 → `resolve` → 同 run 再发事件 | `resolve`=OK、节点 `indeterminate_side_effect`，`wait_registrations` 仍 `active`；`wakeOnEvent` 抛 `STALE_GENERATION`、`wait_event_inbox` 0 行（整笔回滚） |

## 6. 阶段性结论

结论：fail

依据：r67 的两条 P1 与台账 P1-2026-11-16-01 确已修复并实测，20 项必过项全过、构建与证据复现全绿；但不变量 §4.6 的断链隔离仍缺执行侧与事件侧两条入口，属本轮改动声明覆盖范围之内的部分修复，通用退出条件"无未解决 P1"未满足。

## 7. 下一步开发建议

1. 先补 P1-1：`applyTransition`（`nodes.ts`）与 `transitionNode`（`node-state.ts:38`）两条入口各自加链闸（只加前者，上报主干仍通），并把 `wakeOnEvent`/`enterWaiting` 的 `closeRun` 接入 `skipRunIds`，配四例正反向用例；这是本轮唯一阻断项，改完再送 r20。
2. P2-1 用 `verify_ledger` 已有口径补齐"整链缺失"的检出，与 P1-1 同一批做，避免两套断链定义。
3. 通过后按 S1 r68 / S2 r68 / S3 r20 复核再依 G1→G2→G3 重签（注意 `7a1e48b` 之后候选范围已变，r19 这份报告不能复用）；面板展示 `recovery_uncertain` 仍留在 S5。
