# S3 独立审计报告 · G3 第 17 轮

门：G3
候选提交：d248f3bc71ebede5c61c9be5b2a708c3909251ea
审计日期：2026-11-15
审计方式：独立审计；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 17,
  "candidate_commit": "d248f3bc71ebede5c61c9be5b2a708c3909251ea",
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
  "notes": "上一轮 P1 的四个残留全部闭合：坏链隔离、跨 boot 墙钟安全、围栏预算不放大、startup_unknown 换算；探针 8/8、5/5、9/9、5/5。M-64、run 终态、G-16 无回归。"
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
| `pnpm test` | 0 | 64 files；913 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 291.43 kB，gzip 70.30 kB |
| `check-evidence-repro` | 0 | 28 份；注入摘要一致 |

## 3. 四个边界的独立探针

| 探针 | 断言 | 结果 |
| --- | --- | --- |
| 坏链 + 旧 boot fence/action | 8/8：坏节点状态/锚点/事件/链头全不动，好链照常换算 | pass |
| 跨 boot 墙钟前跳 10 分钟 | 5/5：wait 不误超时、timer_uncertain 记账、确认后才推进 | pass |
| 围栏 boot_a→b→c 两次重启 | 9/9：第二次剩 15s 不放大、过期不复活、armed_at 推进 | pass |
| startup_unknown 旧 boot | 5/5：换算后到点转 indeterminate_side_effect | pass |

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
| P2-1 | `docs/gates/G3.md` | 门记录仍绑 4ade819，属批次预期 |
| P2-2 | `src/service/clock-recovery.ts` | 墙钟回拨把预算放大（`deadlineAt - armedAt` 未夹紧）；不会造成假超时 |
| P2-3 | `src/service/sweep.ts` | `timer_uncertain` 已落账但未反馈给 author/run 面板 |

## 6. 结论

四个边界真闭合，20 项全过，3 条 P2 不影响重签。
