# G5 门证据：G5-CONTRAST-LIGHT — 浅色主题正文对比度 4.5:1，大字与 UI 3:1

- 编号：G5-CONTRAST-LIGHT
- 判定语：浅色主题正文对比度 4.5:1，大字与 UI 3:1
- 证明用例：tests/client/panel-visual.spec.tsx::门槛③ 对比度
- 复现命令：pnpm vitest run "tests/client/panel-visual.spec.tsx" -t "门槛③ 对比度"
- 结果：通过（退出码 0）
- 生成：scripts/gen-g5-evidence.ts（就绪矩阵 docs/reviews/S5-g5-item-map.md）

## 输出摘录

```text

 RUN  v4.1.8 D:/aboutAI/dsh-orchestra


 Test Files  1 passed (1)
      Tests  1 passed | 8 skipped (9)
   Start at  19:42:19
   Duration  2.21s (transform 496ms, setup 0ms, import 1.13s, tests 4ms, environment 881ms)
```
