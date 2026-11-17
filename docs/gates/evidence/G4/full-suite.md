# G4 全量门运行记录

- 候选：以门记录 `candidate_hash` 为准；代码基线为 `9fbecdd`（S1–S3 收口后的 handoff 提交）之后的 S4 全部工作：定义文档与两层校验、迁移 027/028（工作流身份/草稿生命周期/版本不可变/REPLACE 保护）、四条写命令与发布事务、UUIDv7 operation_id 幂等、task_local 预留任务归属闭环、执行拓扑进定义、HTTP 六入口、G-10 注入与真并发发布用例。
- 命令：`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm check-evidence-repro`。
- 结果：typecheck exit 0；全量 78 files，**1023 passed | 1 skipped**；build ESM `lib/index.js` 345.32 kB、gzip 82.85 kB、`lib/index.d.ts` 26.10 kB；证据复现 29/29（含 G3/G4 注入摘要）。
- 覆盖：Q-37…Q-42、发布事务与回执同笔、并发发布（双 worker 并发提交，一个成功一个业务冲突；不含锁等待验证）、在途 run 固定旧版本、非法图与空名称拒、回滚发布不影响已固定 run、G-10（真实 startRun 路径）、task_local 预留→建→发→派发子 run 闭环、HTTP 六入口与 UUIDv7 幂等。

## 运行顺序

1. `pnpm typecheck` → 0。
2. `pnpm test` → 78 files，1023 passed | 1 skipped。
3. `pnpm build` → Build complete。
4. `node --no-warnings scripts/check-evidence-repro.ts` → 29 份两遍字节一致。
5. `pnpm gate` → 在 G4 门记录哈希与 S4 审计报告收口后执行。
