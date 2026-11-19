# G5 门证据：G5-FONT-MENU — 左侧菜单与顶部导航不小于 12.5px

- 编号：G5-FONT-MENU
- 判定语：左侧菜单与顶部导航不小于 12.5px
- 证明用例：tests/client/panel-visual.spec.tsx::门槛② 实测字号
- 复现命令：pnpm vitest run "tests/client/panel-visual.spec.tsx" -t "门槛② 实测字号"
- 结果：通过（退出码 0）
- 生成：scripts/gen-g5-evidence.ts（就绪矩阵 docs/reviews/S5-g5-item-map.md）

## 输出摘录

```text

 RUN  v4.1.8 D:/aboutAI/dsh-orchestra


 Test Files  1 passed (1)
      Tests  1 passed | 8 skipped (9)
   Start at  19:42:16
   Duration  2.35s (transform 491ms, setup 0ms, import 1.10s, tests 122ms, environment 907ms)
```
