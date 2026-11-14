# 测试

这份仓库的测试都放在这里。分层放法、命名与断言口径见 `docs/agents/testing-conventions.md`。

## 目录

- `unit/` — 纯函数与单模块语义：哈希链、规范化、策略、配置、桥缓冲、审计裁决、执行调度器。
- `contract/` — HTTP 契约：路由入参、鉴权、写队列背压。
- `integration/` — 迁移、账本完整性、租约与时钟、状态机、扫尾、证据门、目录不可变性、生产上报。
- `e2e/` — 生产路径：加载工作流 → 派发 → 执行 → 收口。
- `gate/` — 门检查解析器：审计结论的判定语义、表格单元格语义、预签态行为。
- `fixtures/` — 固定样本。

## 常用命令

```powershell
# 全量：typecheck + vitest + 构建
cmd.exe /c "cd /d D:\aboutAI\dsh-orchestra && C:\Users\ASUS\AppData\Roaming\npm\pnpm.cmd check"

# 单文件
cmd.exe /c "cd /d D:\aboutAI\dsh-orchestra && C:\Users\ASUS\AppData\Roaming\npm\pnpm.cmd vitest run tests/integration/hash-chain.spec.ts --reporter=dot"

# 门检查
node scripts/gate-check.ts
```

## 门与审计的关系

门检查（`scripts/gate-check.ts`）在审计之前只能停在预签态，这是设计使然：
门记录要签在「最终候选提交上的那一轮独立审计」的报告上，报告没产出就签不了。
所以测试写「预签态必须被拒」，重签之后自动恢复指名。
