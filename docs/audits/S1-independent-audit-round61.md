# S1 独立审计报告 · G1 第 61 轮

门：G1
候选提交：079b611f8bc07d6d3b3a04e79a79f28f245f4d52
审计日期：2026-11-15
审计方式：独立终审；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 61,
  "candidate_commit": "079b611f8bc07d6d3b3a04e79a79f28f245f4d52",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 6,
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
  "notes": "相对已签 a8691ff，本批只改派发收口的三态返回、取消宽限/延期的时钟要求、注入脚本与证据计数。G1 地基 13 项复验通过；6 条 P2 均为口径与待办记录，不阻断重签。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 6；必过项 13/13。

## 2. 实测

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 63 files；906 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 286.05 kB，gzip 69.15 kB |
| `check-evidence-repro` | 0 | 28 份，两遍一致 |

## 3. 13 项必过项

| 必过项 | 要求 | 结果 |
| --- | --- | --- |
| G1-01 / G1-02 | 迁移空库可重复、中途杀可重入 | pass |
| G1-03 / G-01 / G-02 | 事件不丢、COMMIT 前后被杀可恢复 | pass |
| G1-04 / G1-05 / G-15 | 备份行数哈希一致、损坏可检出、恢复被拒 | pass |
| G1-06 | 认证拒匿名写 | pass |
| G1-07 | 阶段开关拒未知值 | pass |
| G-08 / G-09 | 长事务读写与队列 503、离线重放 | pass |
| G-14 | 迁移一半杀后重跑 | pass |

## 4. 不阻断问题（P2）

| 编号 | 位置 | 说明 |
| --- | --- | --- |
| P2-1 | `docs/gates/G1.md` | 门记录仍绑 a8691ff，属批次进行中的预期状态 |
| P2-2 | `scripts/fault-inject.ts:1221` | 节点取消的 HTTP 体仍带 clock，路由不读，属死参数 |
| P2-3 | `src/service/dispatcher.ts:251` | `DISPATCH_SETTLE_FAILED` 未登记进规格或提案码表 |
| P2-4 | `src/service/commands/cancel.ts` | 撤围栏/重挂仍保留墙钟兜底 |
| P2-5 | `src/service/dispatcher.ts:245` | `storage_error` 后节点仍在 queued，本批只把失败显式化 |
| P2-6 | `handoff.md` | 计数与 HEAD 在小节间不一致，已在本批末尾统一 |

## 5. 结论

G1 地基未受本批影响，13 项全过，6 条 P2 不影响重签。
