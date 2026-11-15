# S2 独立审计报告 · G2 第 64 轮

门：G2
候选提交：4ade819b49db726d0a99f5087ffdae04bd95888e
审计日期：2026-11-15
审计方式：独立审计；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 64,
  "candidate_commit": "4ade819b49db726d0a99f5087ffdae04bd95888e",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
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
  "failed_items": [],
  "notes": "单节点闭环、证据门、租约围栏与桥 B01–B10 未受影响；fail-closed 的时钟判定与 clock-recovery 换算协作正常，G-05 注入改用同一只钟后仍可复现。"
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
| `check-evidence-repro` | 0 | 28 份，两遍一致 |

桥闭环定向 6 files / 76 tests 通过。

## 3. 20 项必过项

| 必过项 | 要求 | 结果 |
| --- | --- | --- |
| G2-01 / G2-02 / G2-11 | 单节点闭环、重复上报、重投不膨胀 | pass |
| G2-03 / G2-04 / G-04 / G-05 | 迟到上报、取消不产新 attempt、围栏一次 | pass |
| G2-05 / G2-08 / G2-10 | 终态证据、失败不落完成、证据门 | pass |
| G2-06 / G2-07 / G-03 / G-07 | 无裸 blocked、版本拒载、幂等、墙钟跳变 | pass |
| G2-09 / G2-12 / G2-13 / G2-14 / G2-15 | 时限判定、授权、写者锁、心跳、版本锁定 | pass |
| G2-16 | 桥生产闭环 B01–B10 | pass |

## 4. 不阻断问题（P2）

| 编号 | 位置 | 说明 |
| --- | --- | --- |
| P2-1 | `src/service/clock-recovery.ts` | 剩余预算估算靠墙钟差值 |
| P2-2 | `src/service/dispatcher.ts` | `storage_error` 的 `persisted_status` 在读库失败时为 unknown，重试契约仍需宿主处理 |
| P2-3 | `tests/integration/clock-recovery.spec.ts` | 负向路径缺事件计数断言 |

## 5. 结论

20 项闭环未受影响，3 条 P2 不阻断重签。
