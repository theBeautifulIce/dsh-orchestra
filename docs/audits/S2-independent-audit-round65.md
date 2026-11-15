# S2 独立审计报告 · G2 第 65 轮

门：G2
候选提交：d248f3bc71ebede5c61c9be5b2a708c3909251ea
审计日期：2026-11-15
审计方式：独立审计；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 65,
  "candidate_commit": "d248f3bc71ebede5c61c9be5b2a708c3909251ea",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 4,
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
  "notes": "单节点闭环、证据门、租约围栏与桥 B01–B10 未受影响；64 条业务回归 + 76 条桥闭环 + 28 份证据注入构成实现级闭环证据。跨重启四个边界均有回归钉住。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 4；必过项 20/20。

## 2. 实测

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 64 files；913 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 291.43 kB，gzip 70.30 kB |
| `check-evidence-repro` | 0 | 28 份，两遍一致 |

桥闭环定向 6 files / 76 tests 通过（B01–B10 全覆盖）。

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
| P2-1 | `docs/gates/G2.md` | 门记录仍绑 4ade819，属批次预期 |
| P2-2 | `src/service/sweep.ts` | 断链节点只跳过不计数；坏账本堆积与 ev-g2-12 中断边界需运维可见 |
| P2-3 | `src/service/clock-recovery.ts` | 墙钟回拨会放大预算（缺 `deadlineAt - armedAt` 上界），不会造成假超时 |
| P2-4 | `src/service/clock-recovery.ts` | `CLOCK_RECOVERY_CONFIRM_MS` 写死 30s；test-only 时钟必填残留 1 处 |

## 5. 结论

20 项闭环未受影响，4 条 P2 不阻断重签。
