# S2 独立审计报告 · G2 第 59 轮

门：G2
候选提交：082d9adba149dc983b51bcee0cab6be655fdf099
审计日期：2026-11-15
审计方式：独立审计；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 59,
  "candidate_commit": "082d9adba149dc983b51bcee0cab6be655fdf099",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 4,
  "must_pass_total": 20,
  "must_pass_passed": 20,
  "must_pass_ids": ["G2-01", "G2-02", "G2-03", "G2-04", "G2-05", "G2-06", "G2-07", "G-03", "G-04", "G-05", "G-07", "G2-08", "G2-09", "G2-10", "G2-11", "G2-12", "G2-13", "G2-14", "G2-15", "G2-16"],
  "failed_items": [],
  "notes": "单节点闭环在本轮 dispatcher/run-close/bridge 改动后仍成立。桥处理游标改为逐条推进并支持已落账未处理事件回查重放，B01–B10 与 4 次桥闭环复跑一致。4 条 P2 不阻断重签。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 4；必过项 20/20 通过，failed_items 为空。

## 2. 候选与审前状态

- 候选 `082d9adba149dc983b51bcee0cab6be655fdf099`，工作树干净，`origin/main` 同步。
- 本轮改动里与 G2 直接相关的是：`DispatchDeps` 拆出可选执行器、控制节点失败收口 `failControlDispatch`、`control` 分支 `failQueuedNode`、`parallel/decision` 明确拒绝、`run.terminal` 增加 `outcome`、`cancelRun` 返回 `terminalStatus/outcome`、桥 `markHandled` 逐条推进与回查重放。
- 单节点 queued→终态路径、证据门、租约与围栏、写者锁均未改动语义。

## 3. 实测命令与退出码

| 命令 | 退出码 | 结果摘要 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 63 个测试文件；898 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 284.16 kB，gzip 68.68 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 28 份，每份两遍一致 |

## 4. 20 项必过项逐项复核

| 必过项 | 要求 | 结果 | 复算依据 |
| --- | --- | --- | --- |
| G2-01 | 单节点一条路径 | pass | `tests/e2e/production-path.spec.ts` |
| G2-02 | 重复上报只落一次 | pass | `apply-report.spec.ts` 幂等组 |
| G2-03 | 租约过期迟到上报被拒 | pass | `lease.spec.ts`、G-04 证据 |
| G2-04 | 取消后不产生新 attempt | pass | `cancel.spec.ts`、G-05 证据 |
| G2-05 | 终态必带证据 | pass | `apply-report.spec.ts` 证据门 |
| G2-06 | 无裸 blocked | pass | `transition-guard.spec.ts` |
| G2-07 | S2 加载 parallel 被拒 | pass | `workflow-def.spec.ts` 阶段拒 |
| G-03 | 同 report_id 两次只落一次 | pass | `docs/gates/evidence/G2/G-03.md` |
| G-04 | 租约到期迟到上报被拒 | pass | `G-04.md` |
| G-05 | 取消只立一次围栏 | pass | `G-05.md`，重生成后一致 |
| G-07 | 墙钟跳变不误判截止 | pass | `G-07.md` |
| G2-08 | 工具失败不落完成 | pass | `apply-report.spec.ts` |
| G2-09 | 判定只认 boot 与单调钟 | pass | `clock.spec.ts`、`sweep.spec.ts` |
| G2-10 | 报告入口证据门 | pass | `apply-report.spec.ts` 伪造/弱证据 |
| G2-11 | 重投不刷膨胀 | pass | `apply-report.spec.ts` 计数断言 |
| G2-12 | 工具授权只认定义 | pass | `run-tool.spec.ts` |
| G2-13 | 单写者与 epoch | pass | `db-open.spec.ts` |
| G2-14 | 心跳续租 | pass | `lease.spec.ts` 长动作 |
| G2-15 | 版本跨重启不可改写 | pass | `workflow-identity.spec.ts` |
| G2-16 | 桥闭环 B01–B10 | pass | `agent-lifecycle.spec.ts`、`bridge-ledger.spec.ts` |

## 5. 不阻断问题（P2）

| 编号 | 位置 | 说明 | 影响 |
| --- | --- | --- | --- |
| P2-1 | `docs/gates/evidence/G2/ev-g2-16.md` | 辅助计数仍写桥闭环 70、全量 624 | 与当前 76/898 不一致，重签后建议重生成 |
| P2-2 | `src/service/sweep.ts:275-277` | 无时钟注入时回退墙钟比较 | 生产装配恒注入时钟，属兜底路径 |
| P2-3 | `src/service/dispatcher.ts:126-140` | 直接调用 dispatchRun 且未注入执行器时，agent 节点返回失败但保持 queued | 生产入口已在派发前拒绝，不会走到这里 |
| P2-4 | `scripts/gate-check.ts:109` | G1/G2 候选范围未排除 G3 门记录 | 由签署顺序规避，治理项 |

## 6. 结论

单节点闭环与桥生产闭环在本轮改动后仍然成立，20 项必过项全过，P0/P1 为空。
