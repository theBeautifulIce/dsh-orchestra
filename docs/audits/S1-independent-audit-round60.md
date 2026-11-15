# S1 独立审计报告 · G1 第 60 轮

门：G1
候选提交：a8691ff8150203eefe57bd66c45c827ca72a2615
审计日期：2026-11-15
审计方式：独立复审；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 60,
  "candidate_commit": "a8691ff8150203eefe57bd66c45c827ca72a2615",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 6,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": ["G1-01", "G1-02", "G1-03", "G1-04", "G1-05", "G1-06", "G1-07", "G-01", "G-02", "G-08", "G-09", "G-14", "G-15"],
  "failed_items": [],
  "notes": "r59 之后的 P2 批次只动了迁移守卫、派发失败收口与维护扫描时钟判定；G1 地基 13 项复验通过，28 份证据两遍一致。6 条 P2 均为证据计数、重复常量与回归缺口，不阻断重签。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 6；必过项 13/13。

## 2. 候选与实测

- 候选 `a8691ff8150203eefe57bd66c45c827ca72a2615`；工作树干净。
- 相对 r59 的 `082d9ad`，本批改动：`applyTransition` 同状态显式规则校验、派发失败标记 `pure/verified_none=1`、`dispatchRun` 无执行器收口、`sweep` 动作时限 fail-closed、`cancelRun` 的 `terminalStatus` 未终态返回 null、`ev-g2-16` 计数、新增 4 条回归。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 63 files；901 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 284.70 kB，gzip 68.77 kB |
| `check-evidence-repro` | 0 | 28 份，两遍一致 |

## 3. 13 项必过项

| 必过项 | 要求 | 结果 | 复算依据 |
| --- | --- | --- | --- |
| G1-01 | 迁移空库可重复 | pass | `migrate.spec.ts`；迁移 024 幂等 |
| G1-02 | 迁移中途杀可重入 | pass | G-14 证据两遍一致 |
| G1-03 | 进程杀不丢已提交事件 | pass | `hash-chain.spec.ts`、G-02 |
| G1-04 | 备份行数与哈希一致 | pass | `backup.spec.ts` |
| G1-05 | 损坏备份可检出 | pass | G-15、backup 用例 |
| G1-06 | 认证拒匿名写 | pass | `auth.spec.ts` |
| G1-07 | 阶段开关拒未知值 | pass | `config.spec.ts` |
| G-01 | COMMIT 前杀进程 | pass | `G1/G-01.md` |
| G-02 | COMMIT 后未投递被杀 | pass | `G1/G-02.md` |
| G-08 | 长事务读写与队列溢出 | pass | `G-08.md`、`write-queue.spec.ts` |
| G-09 | 订阅者离线重放 | pass | `G-09.md` |
| G-14 | 迁移一半杀后重跑 | pass | `G-14.md` |
| G-15 | 备份截断与恢复拒绝 | pass | `G-15.md` |

## 4. 不阻断问题（P2）

| 编号 | 位置 | 说明 |
| --- | --- | --- |
| P2-1 | `docs/gates/evidence/G2/ev-g2-16.md:54` | 全量计数写 898，实测 901；与本批提交说明不一致 |
| P2-2 | `src/index.ts:73`、`src/service/commands/run-close.ts:8` | 终态词表两处字面量，改一处易漂移 |
| P2-3 | `src/service/commands/cancel.ts` | 取消 rearm 仍用墙钟兜底，与扫描的 fail-closed 口径不齐 |
| P2-4 | `tests/integration/control-dispatch.spec.ts` | `failControlDispatch` 的 `pure/verified_none=1` 无直接回归 |
| P2-5 | `src/service/dispatcher.ts:147` | 无执行器分支未按「并发接管」改写 reason |
| P2-6 | `docs/gates/G1.md`、`G3/full-suite.md`、`handoff.md` | 计数仍写 898 / 284.16 kB，与 901 / 284.70 kB 不一致 |

## 5. 结论

G1 地基在本批改动后仍成立，13 项全过；6 条 P2 不影响重签。
