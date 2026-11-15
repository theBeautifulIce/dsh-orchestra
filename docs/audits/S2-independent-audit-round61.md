# S2 独立审计报告 · G2 第 61 轮

门：G2
候选提交：079b611f8bc07d6d3b3a04e79a79f28f245f4d52
审计日期：2026-11-15
审计方式：独立终审；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 61,
  "candidate_commit": "079b611f8bc07d6d3b3a04e79a79f28f245f4d52",
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
  "notes": "单节点闭环、证据门、租约围栏与桥 B01–B10 在本批改动后仍成立；桥闭环 76 tests、全量 906 passed 与证据文件一致。3 条 P2 为证据哈希重算、注入脚本死参数与新增错误码未登记。"
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
| `pnpm test` | 0 | 63 files；906 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 286.05 kB，gzip 69.15 kB |
| `check-evidence-repro` | 0 | 28 份，两遍一致 |

桥闭环定向：6 files / 76 tests 通过，与 `ev-g2-16` 记录一致。

## 3. 20 项必过项

| 必过项 | 要求 | 结果 |
| --- | --- | --- |
| G2-01 / G2-02 / G2-11 | 单节点闭环、重复上报、重投不膨胀 | pass |
| G2-03 / G-04 / G2-09 | 迟到上报与时限判定 | pass |
| G2-04 / G-05 | 取消不产生新 attempt、只立一次围栏 | pass |
| G2-05 / G2-08 / G2-10 | 终态证据、失败不落完成、报告入口证据门 | pass |
| G2-06 / G2-07 / G-03 / G-07 | 无裸 blocked、版本拒载、report_id 幂等、墙钟跳变 | pass |
| G2-12 / G2-13 / G2-14 / G2-15 | 授权、写者锁、心跳续租、版本不可改写 | pass |
| G2-16 | 桥生产闭环 B01–B10 | pass |

## 4. 不阻断问题（P2）

| 编号 | 位置 | 说明 |
| --- | --- | --- |
| P2-1 | `docs/gates/G2.md` | 重签前需按 HEAD 重算 ev-g2-16 的证据哈希（签署脚本会自动重写） |
| P2-2 | `scripts/fault-inject.ts:1221` | HTTP 体里的 clock 是死参数，口径不一致 |
| P2-3 | `src/service/dispatcher.ts:251` | 新增错误码未登记 |

## 5. 结论

20 项闭环未被本批改动影响；3 条 P2 不阻断重签。
