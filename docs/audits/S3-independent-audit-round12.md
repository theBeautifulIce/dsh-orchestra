# S3 独立审计报告 · G3 第 12 轮

门：G3
候选提交：a8691ff8150203eefe57bd66c45c827ca72a2615
审计日期：2026-11-15
审计方式：独立复审；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 12,
  "candidate_commit": "a8691ff8150203eefe57bd66c45c827ca72a2615",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 4,
  "must_pass_total": 20,
  "must_pass_passed": 20,
  "must_pass_ids": ["G3-01", "G3-02", "G3-03", "G3-04", "G3-05", "G3-06", "G3-07", "G3-08", "G3-09", "G3-10", "G3-11", "G-01", "G-02", "G-04", "G-06", "G-12", "G-16", "G3-12", "G3-13", "G3-14"],
  "failed_items": [],
  "notes": "r11 的 4 条 P2 已在本批收口：同状态显式规则、派发失败副作用事实、无执行器直调、扫描时钟。20 项必过项与五处改动均实测通过；剩余 4 条 P2 为证据计数、常量重复、取消 rearm 口径与回归缺口。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 4；必过项 20/20。

## 2. 候选与实测

- 候选 `a8691ff8150203eefe57bd66c45c827ca72a2615`，工作树干净。
- 本批只动守卫与收口口径，未改状态机规则集、迁移或控制节点边界。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 63 files；901 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 284.70 kB，gzip 68.77 kB |
| `check-evidence-repro` | 0 | 28 份；G3 注入摘要一致 |

## 3. 五处改动实测

| 改动 | 实测 | 结果 |
| --- | --- | --- |
| 同状态显式规则校验 | `stopping→stopping + M-48` 被拒；无 ruleId 的挂起补丁仍允许 | pass |
| 派发失败副作用事实 | 被拒节点 `pure` + `verified_none=1`，run 收口 `failed` | pass |
| 无执行器直调 | `dispatchRun` 无 executor 时 agent 节点落 failed 并留事件 | pass |
| 扫描时钟 fail-closed | 无锚点/无时钟不判超时；锚点驱动用例仍按时到点 | pass |
| 取消契约 | 未终态 `terminalStatus=null`；终态返回 cancelled | pass |

## 4. 20 项必过项

| 必过项 | 要求 | 结果 | 复算依据 |
| --- | --- | --- | --- |
| G3-01 | 迁移用例全覆盖 | pass | `migration-cases.spec.ts`、`transition-rules.spec.ts` |
| G3-02 | 所有迁移走 CAS | pass | `node-runs.spec.ts` |
| G3-03 | 半态时钟与桥断 | pass | `half-state.spec.ts` |
| G3-04 | 审批往返 | pass | `approval.spec.ts` |
| G3-05 | policy 与 branch | pass | `policy-branch.spec.ts` |
| G3-06 | 并行汇聚与不可逆闸 | pass | `parallel.spec.ts` |
| G3-07 | wait 先落 inbox | pass | `wait.spec.ts` |
| G3-08 | 子流程 pin/环/取消 | pass | `subworkflow.spec.ts` |
| G3-09 | 补偿幂等 | pass | `compensation.spec.ts` |
| G3-10 | 报告冲突与 uphold | pass | `apply-report.spec.ts` |
| G3-11 | 恢复扫描可重入 | pass | `sweep.spec.ts` |
| G-01 | COMMIT 前杀进程 | pass | `G1/G-01.md` |
| G-02 | COMMIT 后未投递被杀 | pass | `G1/G-02.md` |
| G-04 | 租约到期迟到拒 | pass | `G2/G-04.md` |
| G-06 | 同 callId 只重发结果 | pass | `G3/G-06.md` 摘要 |
| G-12 | 审批双击只赢一笔 | pass | `G3/G-12.md` 摘要 |
| G-16 | 父取消向子 run 传播 | pass | `G3/G-16.md` 摘要 |
| G3-12 | 起运行固定版本 | pass | `start-run.spec.ts`、`decision-sweep.spec.ts` |
| G3-13 | 批准人三档 | pass | `approver.spec.ts` |
| G3-14 | 全量测试与构建 | pass | 63 files / 901 passed；284.70 kB |

## 5. 不阻断问题（P2）

| 编号 | 位置 | 说明 |
| --- | --- | --- |
| P2-1 | `docs/gates/evidence/G2/ev-g2-16.md:54` | 计数写 898，实测 901 |
| P2-2 | `src/index.ts:73`、`run-close.ts:8` | 终态词表重复 |
| P2-3 | `src/service/commands/cancel.ts` | rearm 仍用墙钟兜底 |
| P2-4 | `tests/integration/sweep.spec.ts` | 未覆盖「无锚点且带时钟」的组合 |

## 6. 结论

r11 的 4 条 P2 已收口，20 项必过项全过，P0/P1 为空；剩余 4 条不影响重签。
