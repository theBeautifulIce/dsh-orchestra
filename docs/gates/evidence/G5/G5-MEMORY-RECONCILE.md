# G5 门证据：G5-MEMORY-RECONCILE — 记忆批次部分写入能对账：已写入与未写入逐条可查

- 编号：G5-MEMORY-RECONCILE
- 判定语：记忆批次部分写入能对账：已写入与未写入逐条可查
- 证明用例：pnpm vitest run tests/integration/memory-g11.spec.ts
- 复现命令：pnpm vitest run tests/integration/memory-g11.spec.ts
- 结果：通过（退出码 0）
- 生成：scripts/gen-g5-evidence.ts（就绪矩阵 docs/reviews/S5-g5-item-map.md）

## 输出摘录

```text

 RUN  v4.1.8 D:/aboutAI/dsh-orchestra


 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  19:42:21
   Duration  4.69s (transform 1.01s, setup 0ms, import 2.53s, tests 1.98s, environment 0ms)
--- stderr ---
(node:50456) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
```
