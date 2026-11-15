# S1 独立审计报告 · G1 第 59 轮

门：G1
候选提交：dfc9a6349603d46c6e7fd189baaecd43e08d6222
审计日期：2026-11-15
审计方式：独立审计；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 59,
  "candidate_commit": "dfc9a6349603d46c6e7fd189baaecd43e08d6222",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 6,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": ["G1-01", "G1-02", "G1-03", "G1-04", "G1-05", "G1-06", "G1-07", "G-01", "G-02", "G-08", "G-09", "G-14", "G-15"],
  "failed_items": [],
  "notes": "本轮候选在 837b0c6 之后追加了控制节点签名边界、子流程副作用传播、决策超时扫描与三处调度边界补丁。G1 地基（迁移、账本、备份、认证、阶段开关、写队列）改动仅限迁移 024 重建 wait_event_inbox 与事件 payload 增字段；13 项必过项逐项复算通过。6 条 P2 只记录，不阻断本轮重签。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 6；必过项 13/13 通过，failed_items 为空。

## 2. 候选与审前状态

- 候选 `dfc9a6349603d46c6e7fd189baaecd43e08d6222`，`main` 与 `origin/main` 一致，工作树干净。
- 相对上一轮通过审计的 `837b0c6`，生产改动集中在 `src/service/`（dispatcher、subworkflow、decisions、sweep、nodes、apply-report、cancel、run-close、wait、workflows、schemas）、`src/executor/`（bridge-ledger、bridge-consumer）、`src/core/workflow-def.ts`、`src/index.ts`，新增迁移 `024_wait_inbox_scope.sql`。
- 迁移 024 用重建表方式把 `wait_event_inbox` 的幂等键改成 `(run_id, idempotency_key)`；`inbox_seq` 原样搬运，AUTOINCREMENT 与索引重建在同一事务内。空库与半程中断两条路径均复跑通过。

## 3. 实测命令与退出码

| 命令 | 退出码 | 结果摘要 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc --noEmit`，无输出 |
| `pnpm test` | 0 | 63 个测试文件；898 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 284.16 kB，gzip 68.68 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 28 份证据；G1/G2 逐字节、G3 注入摘要一致 |

## 4. 13 项必过项逐项复核

| 必过项 | 要求 | 结果 | 复算依据 |
| --- | --- | --- | --- |
| G1-01 | 迁移空库可重复 | pass | `tests/integration/migrate.spec.ts` 全绿；迁移 024 重跑幂等 |
| G1-02 | 迁移中途杀可重入 | pass | G-14 证据重生成后两遍字节一致 |
| G1-03 | 进程杀不丢已提交事件 | pass | `hash-chain.spec.ts` 与 G-02 注入 |
| G1-04 | 备份独立目录行数与哈希一致 | pass | `tests/integration/backup.spec.ts` |
| G1-05 | 损坏备份可检出 | pass | G-15 证据与 backup 用例 |
| G1-06 | 认证拒匿名写 | pass | `tests/contract/auth.spec.ts` |
| G1-07 | 阶段开关拒未知值 | pass | `tests/unit/config.spec.ts` |
| G-01 | 事务 COMMIT 前杀进程 | pass | `docs/gates/evidence/G1/G-01.md` |
| G-02 | COMMIT 后未投递被杀 | pass | 同证据文件，重放一条、总数 +1 |
| G-08 | 长事务读写与队列溢出 | pass | `G-08.md`；`write-queue.spec.ts` |
| G-09 | 订阅者离线重放 | pass | `G-09.md` |
| G-14 | 迁移一半杀后重跑 | pass | `G-14.md`；迁移集合含 024 |
| G-15 | 备份截断检出与恢复拒绝 | pass | `G-15.md` |

## 5. 不阻断问题（P2）

| 编号 | 位置 | 说明 | 影响 |
| --- | --- | --- | --- |
| P2-1 | `scripts/gate-check.ts:109` | G1 候选范围只排除 G1/G2 门记录，G3 门记录仍在范围内 | 重签 G3 会让 G1/G2 的候选哈希变化；本轮已按 G1→G2→G3 顺序签署规避 |
| P2-2 | `src/infra/sqlite/migrations/018_wait_registrations.sql:24` | `wait_registrations.idempotency_key` 仍是全表唯一 | 派发器按 `run:node:attempt` 派生键，跨 run 不会撞；外部直接调用仍可能撞键 |
| P2-3 | `tests/integration/control-dispatch.spec.ts` | 控制节点失败收口只断言状态与事件，未断言 run 终态口径 | 覆盖度不足，不影响本轮结论 |
| P2-4 | `src/service/server.ts:99-110` | 注释写「未收口时为 null」，实际恒返回字符串 | 类型契约注释与实现不符 |
| P2-5 | `src/service/commands/nodes.ts:139-152` | `actual === to` 时整段显式规则校验被跳过 | 只影响同状态写，属守卫宽松 |
| P2-6 | `docs/gates/evidence/G2/ev-g2-16.md` | 历史计数仍写 70/624 | 与当前 76/898 不一致，S2 已记录 |

## 6. 结论

G1 地基在本轮改动后仍然成立，13 项必过项全过，P0/P1 为空。6 条 P2 不影响重签。
