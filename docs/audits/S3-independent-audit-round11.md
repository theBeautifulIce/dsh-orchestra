# S3 独立审计报告 · G3 第 11 轮

门：G3
候选提交：082d9adba149dc983b51bcee0cab6be655fdf099
审计日期：2026-11-15
审计方式：独立审计；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 11,
  "candidate_commit": "082d9adba149dc983b51bcee0cab6be655fdf099",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 4,
  "must_pass_total": 20,
  "must_pass_passed": 20,
  "must_pass_ids": ["G3-01", "G3-02", "G3-03", "G3-04", "G3-05", "G3-06", "G3-07", "G3-08", "G3-09", "G3-10", "G3-11", "G-01", "G-02", "G-04", "G-06", "G-12", "G-16", "G3-12", "G3-13", "G3-14"],
  "failed_items": [],
  "notes": "上轮三个 P1 已闭合：控制节点配置只认签名定义（含哈希空值 fail closed）、子流程未核实结果向父流程传播（含父节点已取消后回填）、决策超时进入维护扫描。显式 ruleId、桥游标逐条推进、wait inbox 按 run 作用域、取消 cancellation_pending 与 run.terminal.outcome 均实测成立。4 条 P2 不阻断重签。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 4；必过项 20/20 通过，failed_items 为空。

## 2. 候选与审前状态

- 候选 `082d9adba149dc983b51bcee0cab6be655fdf099`，工作树干净，`origin/main` 同步。
- 本轮新增迁移 `024_wait_inbox_scope.sql`；`run.terminal` 增加 `outcome`；`/v1/runs/cancel` 返回 `terminalStatus/outcome`。
- G3 的注入证据：G-06/G-12/G-16 由 `scripts/check-evidence-repro.ts` 以摘要方式复现，G-01/G-02/G-04 直接引用 G1/G2 的逐字节证据文件（脚本有静态一致性检查）。

## 3. 实测命令与退出码

| 命令 | 退出码 | 结果摘要 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 63 个测试文件；898 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 284.16 kB，gzip 68.68 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 28 份；G3 三份注入摘要一致 |

## 4. 20 项必过项逐项复核

| 必过项 | 要求 | 结果 | 复算依据 |
| --- | --- | --- | --- |
| G3-01 | 迁移用例全覆盖，非法迁移全拒 | pass | `migration-cases.spec.ts`、`transition-rules.spec.ts` |
| G3-02 | 所有迁移走 CAS | pass | `node-runs.spec.ts`、`applyTransition` |
| G3-03 | 半态时钟与桥断矩阵 | pass | `half-state.spec.ts` |
| G3-04 | 审批往返 | pass | `approval.spec.ts` |
| G3-05 | policy 与 branch | pass | `policy-branch.spec.ts` |
| G3-06 | 并行汇聚与不可逆闸 | pass | `parallel.spec.ts` |
| G3-07 | wait 先落 inbox | pass | `wait.spec.ts`（含 run 作用域幂等键） |
| G3-08 | 子流程 pin/深度/环/取消 | pass | `subworkflow.spec.ts`（含未核实传播） |
| G3-09 | 补偿幂等 | pass | `compensation.spec.ts` |
| G3-10 | 报告冲突与 uphold | pass | `apply-report.spec.ts` |
| G3-11 | 恢复扫描可重入 | pass | `sweep.spec.ts` |
| G-01 | COMMIT 前杀进程 | pass | `docs/gates/evidence/G1/G-01.md` |
| G-02 | COMMIT 后未投递被杀 | pass | `G1/G-02.md` |
| G-04 | 租约到期迟到上报拒 | pass | `G2/G-04.md` |
| G-06 | 同 callId 只重发结果 | pass | `docs/gates/evidence/G3/G-06.md` 摘要 |
| G-12 | 审批双击只赢一笔 | pass | `G3/G-12.md` 摘要 |
| G-16 | 父取消向子 run 传播 | pass | `G3/G-16.md` 摘要 |
| G3-12 | 起运行固定版本与自治档位 | pass | `start-run.spec.ts`、`decision-sweep.spec.ts` |
| G3-13 | 批准人三档 | pass | `approver.spec.ts` |
| G3-14 | 全量测试与构建 | pass | 63 files / 898 passed；build 284.16 kB |

## 5. 上轮 P1 复核

| 项 | 复核方式 | 结果 |
| --- | --- | --- |
| 控制节点配置绑定签名定义 | 请求体带 control、直接调 createSubworkflowRun 换目标、哈希为空、parallel 节点四条探针 | 通过，均被拒且状态落库 |
| 子流程未核实向父流程传播 | 四类子 run 终态 + 父节点先取消后子 run 收口 | 通过，父 run 不落普通 succeeded |
| 决策超时进维护扫描 | 2h/24h/blocked_post/supervised/人工竞争 | 通过，释放节点并收口 run |

## 6. 不阻断问题（P2）

| 编号 | 位置 | 说明 | 影响 |
| --- | --- | --- | --- |
| P2-1 | `src/service/dispatcher.ts:189-235` | 派发失败收口时把 `side_effect_policy` 留在 compensable，run 终态显示未核实 | 节点从未执行，事实是零副作用；属口径保守，不影响收口 |
| P2-2 | `src/service/commands/subworkflow.ts:239-255` | 父 run 缺定义哈希时起子流程被拒 | 老数据无哈希无法起子流程，需数据回填 |
| P2-3 | `src/service/sweep.ts:275-277` | 无时钟注入时回退墙钟 | 生产恒注入时钟 |
| P2-4 | `src/service/commands/nodes.ts:139-152` | 同状态写跳过显式规则校验 | 只影响挂起补丁写入 |

## 7. 结论

三个 P1 已闭合，20 项必过项全过，P0/P1 为空；4 条 P2 记录在案，不阻断重签。
