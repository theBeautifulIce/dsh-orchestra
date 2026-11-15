# S3 独立审计报告 · G3 第 15 轮

门：G3
候选提交：b71296e91109264d07433adbe0d01d428e67f204
审计日期：2026-11-15
审计方式：独立审计；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 15,
  "candidate_commit": "b71296e91109264d07433adbe0d01d428e67f204",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 6,
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
  "notes": "本轮是真独立三人复核（限流恢复后补做），替代上一轮限流期间的代跑记录；命令、探针与证据哈希均由审计员自行执行。 跨重启时钟 P1 确认闭合：四个独立探针（含真实关库重开）全部通过；M-64、run 终态、G-16 无回归。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 6；必过项 20/20。

## 2. 实测

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 64 files；911 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 289.92 kB，gzip 69.99 kB |
| `check-evidence-repro` | 0 | 28 份；注入摘要一致 |

## 3. 跨重启恢复的独立探针

| 探针 | 结果 |
| --- | --- |
| 旧 boot 的 fence + action deadline，关库重开后 sweep 推进 | pass，4 个 `deadline.reanchored` 事件 |
| 连续两轮 sweep 不重复写事件 | pass |
| 无 clock 时不换算、fail-closed | pass |
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
| P2-1 | `tests/integration/clock-recovery.spec.ts` | 负向用例只看结果，未断言「无事件」 |
| P2-2 | `src/service/commands/cancel.ts` | 内部 API 的 clock 仍可省，缺时钟靠运行期报错 |
| P2-3 | `src/service/clock-recovery.ts` | 早已过期的锚点也写换算事件，噪声偏多 |
| P2-4 | `src/core/errors.ts` | `DISPATCH_SETTLE_FAILED` 是提案码，未进规格 17.1 |
| P2-5 | `src/index.ts` / `run-close.ts` | 终态词表重复（P3 级） |
| P2-6 | `src/index.ts` | 未装配 runtime 的路径仍可绕过时钟注入 |

## 6. 结论

跨重启时钟 P1 真闭合，20 项全过，6 条 P2 不影响重签。
