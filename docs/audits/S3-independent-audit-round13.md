# S3 独立审计报告 · G3 第 13 轮

门：G3
候选提交：079b611f8bc07d6d3b3a04e79a79f28f245f4d52
审计日期：2026-11-15
审计方式：独立终审；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 13,
  "candidate_commit": "079b611f8bc07d6d3b3a04e79a79f28f245f4d52",
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
  "notes": "三处改动均以真实探针验证：接管返回 skipped、坏库返回 DISPATCH_SETTLE_FAILED、缺时钟的取消明确报错且状态不变。M-64 显式规则、run 终态口径与 G-16 父取消传播无回归。4 条 P2 为门记录绑定、文档口径与两项待办。"
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
| `pnpm test` | 0 | 63 files；906 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 286.05 kB，gzip 69.15 kB |
| `check-evidence-repro` | 0 | 28 份；注入摘要一致 |

## 3. 本批三处改动的探针

| 改动 | 实测 | 结果 |
| --- | --- | --- |
| 接管时派发结果 | 过期选行后走真 dispatch：`skipped` + `current_status=waiting`，库仍 waiting、事件 0 条 | pass |
| 写库失败 | 触发器拒写：`failed` + `DISPATCH_SETTLE_FAILED`，节点仍 queued、无假事件 | pass |
| 缺时钟取消 | 抛 `SERVICE_UNAVAILABLE`，状态与 revision 不变；带时钟落 timing_out/armed，锚点可判 | pass |

## 4. 20 项必过项

| 必过项 | 要求 | 结果 |
| --- | --- | --- |
| G3-01 / G3-02 | 迁移用例全覆盖、全部 CAS | pass |
| G3-03 / G3-04 | 半态时钟、审批往返 | pass |
| G3-05 / G3-06 | policy 与 branch、并行汇聚 | pass |
| G3-07 / G3-08 / G3-09 | wait 先落 inbox、子流程边界、补偿幂等 | pass |
| G3-10 / G3-11 | 报告冲突与 uphold、扫描可重入 | pass |
| G-01 / G-02 / G-04 / G-06 / G-12 / G-16 | 故障注入六例 | pass |
| G3-12 / G3-13 / G3-14 | 起运行、批准人三档、全量绿 | pass |

## 5. 不阻断问题（P2）

| 编号 | 位置 | 说明 |
| --- | --- | --- |
| P2-1 | `docs/gates/G3.md` | 门记录仍绑 a8691ff，属批次预期 |
| P2-2 | `handoff.md` | 旧小节计数与 HEAD 不一致 |
| P2-3 | `scripts/fault-inject.ts:1221` | HTTP 体里的 clock 是死参数 |
| P2-4 | `src/service/commands/cancel.ts` | 撤围栏/重挂仍墙钟兜底 |

## 6. 结论

三处改动成立且可复现，20 项全过，4 条 P2 不影响重签。
