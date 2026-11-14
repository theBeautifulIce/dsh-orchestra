# G3 全量门运行记录

- 候选：以门记录 `candidate_hash` 为准；代码基线 `494d6e4`（S3 Task 1–15 + 审计整改：唯一迁移表、时钟锚点、生产入口、运行收口、队头重放、批准人不可伪造、迁移前提、恢复窗口、取消全走迁移表、控制节点分派）。
- 命令：`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm gate`。
- 结果：typecheck exit 0；全量 61 files，**834 passed | 1 skipped**；build ESM `lib/index.js` 221.60 kB、gzip 53.72 kB、`lib/index.d.ts` 16.87 kB。
- 覆盖：M-01…M-62、六条 G3 注入、状态机/审批/并行/wait（含维护扫描收超时）/子流程/补偿/报告冲突/恢复扫描/起运行与批准人/确认启动/运行终态/控制节点生产分派。

## 运行顺序

1. `pnpm typecheck` → 0。
2. `pnpm test` → 61 files，834 passed | 1 skipped。
3. `pnpm build` → Build complete。
4. `pnpm gate` → 在 G3 门记录哈希与审计报告收口后执行。
