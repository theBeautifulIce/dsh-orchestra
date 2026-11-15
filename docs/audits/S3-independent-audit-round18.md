# S3 独立审计报告 · G3 第 18 轮

门：G3
候选提交：5098847a60bc4f487fe1a12bcb839e98c647781d
审计日期：2026-11-15
审计方式：独立审计；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 18,
  "candidate_commit": "5098847a60bc4f487fe1a12bcb839e98c647781d",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 2,
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
  "notes": "S2 r65 的 P1 与两条 P2 全部修正：单位统一为 ns、回拨/滑动夹紧生效、断链覆盖 verifying 与 bridgeRestored。探针 15/15。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 2；必过项 20/20。

## 2. 实测

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 64 files；915 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 291.85 kB，gzip 70.39 kB |
| `check-evidence-repro` | 0 | 28 份；注入摘要一致 |

## 3. 修复确认探针

| 探针 | 结果 |
| --- | --- |
| 租约路径 startup_unknown 跨 boot 重锚后 120s 量级，不假到期 | pass |
| 墙钟回拨 1 小时：围栏预算夹在 30s 内 | pass |
| startup_unknown 连续两次重启：预算递减不滑动 | pass |
| 断链节点 verifying / bridgeRestored 恢复动作被跳过 | pass |

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
| P2-1 | `src/service/clock-recovery.ts:153` | 重锚保留原始冻结量不递减落库，墙钟回拨时 `min(frozen, wall)` 把剩余拉回满额（有界不超原预算，只延长不假超时） |
| P2-2 | `docs/gates/G3.md` | 门记录审计起始绑 d248f3b，属批次预期 |

## 6. 结论

P1 与两条 P2 全部修正，20 项全过，2 条 P2 不影响重签。
