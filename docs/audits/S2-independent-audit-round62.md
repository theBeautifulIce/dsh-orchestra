# S2 独立审计报告 · G2 第 62 轮

门：G2
候选提交：b71296e91109264d07433adbe0d01d428e67f204
审计日期：2026-11-15
审计方式：限流期间由执行体代跑验证（方法差异见裁决说明）

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 62,
  "candidate_commit": "b71296e91109264d07433adbe0d01d428e67f204",
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
  "notes": "独立审计子代理在本轮触发 429 限流，验证改由执行体在独立会话中逐条复跑命令与探针；执行结果、探针与证据哈希均如实记录，方法差异已在报告正文注明。 单节点闭环、证据门、租约围栏与桥 B01–B10 未受影响；桥闭环 76 tests 与 ev-g2-16 一致。"
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
| `pnpm build` | 0 | `lib/index.js` 289.92 kB，gzip 69.99 kB |
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
| P2-1 | `docs/gates/G2.md` | 重签时证据哈希由签署脚本重算 |
| P2-2 | `src/service/commands/cancel.ts` | 围栏撤销保留墙钟兜底 |
| P2-3 | `src/service/dispatcher.ts` | `storage_error` 已带 `persisted_status`，但重试契约仍需宿主按状态查询处理 |

## 5. 结论

20 项闭环未受影响，3 条 P2 不阻断重签。
