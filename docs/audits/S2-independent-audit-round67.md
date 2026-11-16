# S2 独立审计报告 · G2 第 67 轮（不通过记录）

门：G2
候选提交：93e1d88d6b5c448ebfda0dd90c4427d307a6928d
审计日期：2026-11-16
审计方式：独立审计；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 67,
  "candidate_commit": "93e1d88d6b5c448ebfda0dd90c4427d307a6928d",
  "conclusion": "fail",
  "p0": 0,
  "p1": 2,
  "p2": 3,
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
    "P1-1a 断链子 run 的状态仍可推进父节点与父 run",
    "P1-1b wait 超时路径的 run 收口没有断链闸"
  ],
  "notes": "本轮判不通过：20 项必过项与 76 条桥闭环均未受影响，但断链隔离仍有两条旁路未覆盖；已在 d85b09d 修复并由 r68 复核。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：**fail**

P0 = 0，P1 = 2，P2 = 3；必过项 20/20（闭环未受影响，但旁路隔离有缺口）。

## 2. 两条 P1

| 编号 | 位置 | 说明 |
| --- | --- | --- |
| P1-1a | `src/service/sweep.ts` `finishedChildren` | 只检查了父节点链与父 run 污染，**没查子 run 自身的链**：子 run 含断链节点时，父节点仍被推进、父 run 仍被收口，断链事实被洗掉 |
| P1-1b | `src/service/commands/wait.ts` `timeoutWaiting` | wait 超时后的 `closeRun` 没有断链闸：断链节点 wait 超时时 run 仍被收成 `failed_with_unverified` 并写 `run.terminal` |

## 3. 三条 P2

| 编号 | 位置 | 说明 |
| --- | --- | --- |
| P2-1 | `src/service/dispatcher.ts` | `err instanceof OrchError` 分支未过白名单；白名单漏 5 条提案码 |
| P2-2 | `docs/gates/G2.md` | 证据哈希与门记录不符（915→919 改字节，重签时重算） |
| P2-3 | `src/service/clock-recovery.ts` | action 通道 SELECT 无 status 约束；`action_overrun` 走 `broken.has` 而非统一跳过集 |

## 4. 整改（下一候选 d85b09d）

- `finishedChildren` 增加子 run 自身污染判定（`taintedRuns`），父节点不推进、父 run 不收口。
- `timeoutWaiting` / `sweepWaitTimeouts` 接入 `skipRunIds`，断链 run 不再被 `closeRun`。
- `action_overrun` / `bridgePaused` / `executorOrphaned` 三处统一改用跳过集（断链 + 不确定）。
- 派发错误码白名单补齐 `PROPOSED_ERROR_CODES`，OrchError 分支同样过白名单。
- 新增两条回归：断链子 run 不推父节点；wait 超时 + 断链节点不收口 run。

## 5. 结论

本轮不放行；整改后由 S2 r68 复核。
