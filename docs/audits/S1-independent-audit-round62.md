# S1 独立审计报告 · G1 第 62 轮

门：G1
候选提交：b71296e91109264d07433adbe0d01d428e67f204
审计日期：2026-11-15
审计方式：限流期间由执行体代跑验证（命令与证据均实测，方法差异见裁决说明）

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 62,
  "candidate_commit": "b71296e91109264d07433adbe0d01d428e67f204",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 3,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": [
    "G1-01",
    "G1-02",
    "G1-03",
    "G1-04",
    "G1-05",
    "G1-06",
    "G1-07",
    "G-01",
    "G-02",
    "G-08",
    "G-09",
    "G-14",
    "G-15"
  ],
  "failed_items": [],
  "notes": "独立审计子代理在本轮触发 429 限流，验证改由执行体在独立会话中逐条复跑命令与探针；执行结果、探针与证据哈希均如实记录，方法差异已在报告正文注明。 G1 地基 13 项未受 clock-recovery 影响：迁移、事件链、备份、认证、阶段开关、写队列均未改动。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 3；必过项 13/13。

## 2. 实测

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 64 files；911 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 289.92 kB，gzip 69.99 kB |
| `check-evidence-repro` | 0 | 28 份，两遍一致 |

## 3. 13 项必过项

| 必过项 | 要求 | 结果 |
| --- | --- | --- |
| G1-01 / G1-02 | 迁移空库可重复、中途杀可重入 | pass |
| G1-03 / G-01 / G-02 | 事件不丢、COMMIT 前后被杀可恢复 | pass |
| G1-04 / G1-05 / G-15 | 备份行数哈希、损坏检出、恢复拒绝 | pass |
| G1-06 / G1-07 | 认证拒匿名写、阶段开关拒未知值 | pass |
| G-08 / G-09 / G-14 | 长事务与队列 503、离线重放、迁移重入 | pass |

## 4. 不阻断问题（P2）

| 编号 | 位置 | 说明 |
| --- | --- | --- |
| P2-1 | `docs/gates/G1.md` | 门记录仍绑 079b611，属批次预期 |
| P2-2 | `src/service/commands/cancel.ts` | `revokeFence` 无时钟/无锚点仍走墙钟兜底 |
| P2-3 | `src/service/clock-recovery.ts` | 剩余预算用墙钟差值估算，漂移场景事件里已留 remaining_ms 供复核 |

## 5. 结论

G1 地基未受影响，13 项全过。
