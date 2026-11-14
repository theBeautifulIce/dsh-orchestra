# G3 全量门运行记录

- 候选：`be76f23`（S3 Task 1–15 + 审计整改：唯一迁移表、时钟锚点、生产入口、运行收口、队头重放、批准人不可伪造、迁移前提、恢复窗口）。
- 命令：`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm gate`。
- 结果：typecheck exit 0；全量 60 files，**829 passed | 1 skipped**；build ESM `lib/index.js` 199.39 kB、gzip 48.47 kB、`lib/index.d.ts` 16.21 kB。
- 覆盖：M-01…M-61、六条 G3 注入、状态机/审批/并行/wait/子流程/补偿/报告冲突/恢复扫描/起运行与批准人/确认启动/运行终态。

## 运行顺序

1. `pnpm typecheck` → 0。
2. `pnpm test` → 60 files，829 passed | 1 skipped。
3. `pnpm build` → Build complete。
4. `pnpm gate` → 在 G3 门记录哈希与审计报告收口后执行。
