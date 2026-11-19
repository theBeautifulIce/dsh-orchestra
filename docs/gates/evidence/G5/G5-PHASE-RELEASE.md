# G5 门证据：G5-PHASE-RELEASE — S5 阶段能力表不含 release，S5 启动 wf_release_v1 被拒

- 编号：G5-PHASE-RELEASE
- 判定语：S5 阶段能力表不含 release，S5 启动 wf_release_v1 被拒
- 证明用例：pnpm vitest run tests/gate/gate-g5.spec.ts tests/contract/task-planning.spec.ts -t "S5 .*release"
- 复现命令：pnpm vitest run tests/gate/gate-g5.spec.ts tests/contract/task-planning.spec.ts -t "S5 .*release"
- 结果：通过（退出码 0）
- 生成：scripts/gen-g5-evidence.ts（就绪矩阵 docs/reviews/S5-g5-item-map.md）

## 输出摘录

```text

 RUN  v4.1.8 D:/aboutAI/dsh-orchestra


 Test Files  2 passed (2)
      Tests  3 passed | 33 skipped (36)
   Start at  19:42:27
   Duration  2.83s (transform 1.15s, setup 0ms, import 2.74s, tests 219ms, environment 0ms)
--- stderr ---
(node:63148) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
```
