# S3 独立审计报告 · G3 第 16 轮

门：G3
候选提交：4ade819b49db726d0a99f5087ffdae04bd95888e
审计日期：2026-11-15
审计方式：独立审计；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 16,
  "candidate_commit": "4ade819b49db726d0a99f5087ffdae04bd95888e",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
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
  "failed_items": [],
  "notes": "上一轮 P2-2 已闭合：revokeFence 与 wait 超时缺钟/无锚点一律不自动推进，同 boot 未到点也不动，跨 boot 仍由 clock-recovery 换算；M-64、run 终态、G-16 无回归。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 3；必过项 20/20。

## 2. 实测

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 64 files；911 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 289.25 kB，gzip 69.85 kB |
| `check-evidence-repro` | 0 | 28 份；注入摘要一致 |

## 3. fail-closed 语义的独立探针

| 探针 | 结果 |
| --- | --- |
| 无 clock 的 sweep 不撤围栏、无事件 | pass |
| 墙钟跳 1 小时但单调钟未到点 → 不撤围栏 | pass |
| 跨 boot 锚点换算后按策略推进（宽限给满额） | pass |
| M-64 / run 终态 / G-16 无回归 | pass |

## 4. 20 项必过项

| 必过项 | 要求 | 结果 |
| --- | --- | --- |
| G3-01 / G3-02 | 迁移用例全覆盖、全部 CAS | pass |
| G3-03 / G3-04 / G3-05 | 半态时钟、审批、policy 与 branch | pass |
| G3-06 / G3-07 / G3-08 / G3-09 | 并行汇聚、wait inbox、子流程、补偿 | pass |
| G3-10 / G3-11 | 报告冲突、扫描可重入 | pass |
| G-01 / G-02 / G-04 / G-06 / G-12 / G-16 | 故障注入六例 | pass |
| G3-12 / G3-13 / G3-14 | 起运行、批准人三档、全量绿 | pass |

## 5. 不阻断问题（P2）

| 编号 | 位置 | 说明 |
| --- | --- | --- |
| P2-1 | `src/service/clock-recovery.ts` | 剩余预算估算靠墙钟差值 |
| P2-2 | `tests/integration/clock-recovery.spec.ts` | 负向路径缺事件计数断言 |
| P2-3 | `src/service/dispatcher.ts` | `storage_error` 的 `persisted_status` 读库失败时为 unknown |

## 6. 结论

fail-closed 语义成立，20 项全过，3 条 P2 不影响重签。
