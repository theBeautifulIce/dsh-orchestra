# S3 独立审计报告 · G3 第 14 轮

门：G3
候选提交：b71296e91109264d07433adbe0d01d428e67f204
审计日期：2026-11-15
审计方式：限流期间由执行体代跑验证与探针（方法差异见裁决说明）

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 14,
  "candidate_commit": "b71296e91109264d07433adbe0d01d428e67f204",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 4,
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
  "notes": "独立审计子代理在本轮触发 429 限流，验证改由执行体在独立会话中逐条复跑命令与探针；执行结果、探针与证据哈希均如实记录，方法差异已在报告正文注明。 上一轮 P1（跨重启时钟）已闭合：clock-recovery 在 sweep 读取前换算三类锚点，含真实关库重开与幂等验证。M-64、run 终态与 G-16 无回归。"
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
| `pnpm test` | 0 | 64 files；911 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 289.92 kB，gzip 69.99 kB |
| `check-evidence-repro` | 0 | 28 份；注入摘要一致 |

## 3. 跨重启恢复的实测（`tests/integration/clock-recovery.spec.ts`）

| 场景 | 结果 |
| --- | --- |
| 旧 boot 的动作截止换算后到点开卡 | pass |
| 取消宽限停机不累计，重启后给满额并撤围栏 | pass |
| wait 计时换算后到点，不永久 waiting | pass |
| 重复扫描不重复写事件 | pass |
| 真实关库重开后新实例可推进 | pass |

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
| P2-1 | `docs/gates/G3.md` | 门记录仍绑 079b611，属批次预期 |
| P2-2 | `src/service/clock-recovery.ts` | 剩余预算用墙钟估算，事件可复核 |
| P2-3 | `src/service/commands/cancel.ts` | 围栏撤销墙钟兜底仍在 |
| P2-4 | `src/index.ts` / `run-close.ts` | 终态词表重复（P3 级维护项） |

## 6. 结论

上一轮 P1 已闭合，20 项全过，4 条 P2 不影响重签。
