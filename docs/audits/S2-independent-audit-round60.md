# S2 独立审计报告 · G2 第 60 轮

门：G2
候选提交：a8691ff8150203eefe57bd66c45c827ca72a2615
审计日期：2026-11-15
审计方式：独立复审；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 60,
  "candidate_commit": "a8691ff8150203eefe57bd66c45c827ca72a2615",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 6,
  "must_pass_total": 20,
  "must_pass_passed": 20,
  "must_pass_ids": ["G2-01", "G2-02", "G2-03", "G2-04", "G2-05", "G2-06", "G2-07", "G-03", "G-04", "G-05", "G-07", "G2-08", "G2-09", "G2-10", "G2-11", "G2-12", "G2-13", "G2-14", "G2-15", "G2-16"],
  "failed_items": [],
  "notes": "r59 的 4 条 P2 已在本批全部收口：桥证据计数、扫描时钟、无执行器直调、门范围。单节点闭环、证据门、租约围栏与桥 B01–B10 复验通过；新增 6 条 P2 属回归覆盖与口径统一，不阻断重签。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 6；必过项 20/20。

## 2. 候选与实测

- 候选 `a8691ff8150203eefe57bd66c45c827ca72a2615`，工作树干净。
- 本批改动集中在 `dispatcher`（无执行器收口、副作用事实）、`nodes`（同状态显式规则）、`sweep`（时钟 fail-closed）、`server/index`（取消契约）、`ev-g2-16` 计数。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 63 files；901 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 284.70 kB，gzip 68.77 kB |
| `check-evidence-repro` | 0 | 28 份，两遍一致 |

桥闭环定向：`agent-lifecycle` + `bridge-ledger` + `bridge-buffer` + `runtime` + `production-path` + `execution-concurrency` → 6 files / 76 tests 通过。

## 3. 20 项必过项

| 必过项 | 要求 | 结果 | 复算依据 |
| --- | --- | --- | --- |
| G2-01 | 单节点一条路径 | pass | `production-path.spec.ts` |
| G2-02 | 重复上报只落一次 | pass | `apply-report.spec.ts` |
| G2-03 | 租约过期迟到上报被拒 | pass | `g2.spec.ts`、G-04 |
| G2-04 | 取消不产生新 attempt | pass | `cancel.spec.ts`、G-05 |
| G2-05 | 终态必带证据 | pass | `apply-report.spec.ts` |
| G2-06 | 无裸 blocked | pass | `g2.spec.ts` |
| G2-07 | S2 加载 parallel 被拒 | pass | `workflow-def.spec.ts` |
| G-03 | 同 report_id 只落一次 | pass | `G2/G-03.md` |
| G-04 | 迟到上报被拒 | pass | `G2/G-04.md` |
| G-05 | 取消只立一次围栏 | pass | `G2/G-05.md` |
| G-07 | 墙钟跳变不误判 | pass | `G2/G-07.md` |
| G2-08 | 工具失败不落完成 | pass | `apply-report.spec.ts` |
| G2-09 | 只认 boot 与单调钟 | pass | `clock.spec.ts`、`sweep.spec.ts` |
| G2-10 | 报告入口证据门 | pass | `apply-report.spec.ts` |
| G2-11 | 重投不刷膨胀 | pass | `apply-report.spec.ts` |
| G2-12 | 授权只认定义 | pass | `run-tool.spec.ts` |
| G2-13 | 单写者与 epoch | pass | `db-open.spec.ts` |
| G2-14 | 心跳续租 | pass | `lease.spec.ts` |
| G2-15 | 版本不可改写 | pass | `workflow-identity.spec.ts` |
| G2-16 | 桥闭环 B01–B10 | pass | `agent-lifecycle.spec.ts`、`bridge-ledger.spec.ts` |

## 4. 不阻断问题（P2）

| 编号 | 位置 | 说明 |
| --- | --- | --- |
| P2-1 | `docs/gates/evidence/G2/ev-g2-16.md:54` | 计数写 898，实测 901 |
| P2-2 | `src/index.ts:73`、`run-close.ts:8` | 终态词表重复定义 |
| P2-3 | `src/service/commands/cancel.ts` | rearm 仍用墙钟兜底 |
| P2-4 | `tests/integration/control-dispatch.spec.ts` | 无 `pure/verified_none=1` 的直接回归 |
| P2-5 | `src/service/dispatcher.ts:147` | 无执行器分支未区分并发接管 |
| P2-6 | `handoff.md`、`G3/full-suite.md` | 计数仍写 898 / 284.16 kB |

## 5. 结论

20 项闭环在 P2 批次后仍成立；r59 的四条 P2 已收口，新增 6 条不影响重签。
