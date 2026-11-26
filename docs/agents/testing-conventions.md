# 测试约定

这份文档写给在这份仓库里改代码的人：测试放哪、怎么命名、断言到什么程度算数、跑起来是什么样。
先说人的道理，再讲工程做法——测试不是为了好看，是为了下一次有人动这块代码时，能立刻知道有没有动坏。

## 一句话原则

**测试断言的是「事实」，不是「当时的巧合」。**

迁移条数、哈希值、表结构这类会随代码演进变化的东西，测试里要现算现比，不要抄一份写死。
写死的地方一改就红，红了就会有人为了让测试变绿去改代码，最后改的往往是实现。

## 目录分层

| 目录 | 放什么 | 不放什么 |
| --- | --- | --- |
| `tests/unit/` | 纯函数与单模块语义，不碰数据库 | 需要开库、用时钟推进的用例 |
| `tests/contract/` | HTTP 路由契约、鉴权、写队列背压 | 业务流程编排 |
| `tests/integration/` | 迁移、账本、租约、状态机、证据门、目录不可变性 | 端到端长链路 |
| `tests/e2e/` | 生产路径：加载 → 派发 → 执行 → 收口 | 只测一个函数的分支 |
| `tests/gate/` | 门检查解析器（`scripts/gate-check.ts`）的裁决语义 | 业务逻辑 |
| `tests/fixtures/` | 固定样本（工作流定义、报告文本等） | 断言 |
| `tests/client/` | 面板渲染层：React 组件渲染、假服务契约、视觉硬门槛 | 数据库与账本断言 |

一条用例只落一处。就近放：改了 `src/service/workflows.ts` 的用例放 `tests/integration/workflows.spec.ts`，
改了 `src/core/hash-chain.ts` 的放 `tests/unit/` 或 `tests/integration/hash-chain.spec.ts`。

S5 起面板（`src/client/`）有独立的渲染测试层，单独放在 `tests/client/`：这类用例只渲染组件、只打假服务，不开数据库也不起 HTTP 服务，
塞进 `unit/`（那一类的语义是单模块纯函数）或 `integration/`（那一类的语义是迁移、账本、状态机、证据门）都会把两边的口径弄脏，所以单列一类。
该目录里可以放一个 `harness.ts`（渲染与假服务的共用脚手架）；它不是用例，文件名不要以 `.spec.ts` 结尾。

## 命名

- 文件：`<被测物>.spec.ts`，全小写连字符。
- 用例名：中文短句，写「场景 → 期望结果」，例如
  `它('同名工具跑两次：两次都留痕、tool_seq 为 1 与 2')`。
- 同一个模块里，用例名不要重复同一句话的不同说法；不同分支要能一眼看出差别。

## 断言口径

1. **动态取期望值**：迁移条数从 `loadSteps(defaultMigrationsDir())` 取；哈希从实际文件算；表清单从 `sqlite_master` 取。
2. **破坏性用例自带隔离**：要改库、要造脏数据、要 DROP 触发器的用例，先用临时库，并在用例内显式恢复（迁移 007 的只追加触发器要先 `DROP TRIGGER` 才能造篡改数据）。
3. **不写「看起来像」的断言**：只断言真正要守住的性质，别顺手加一串快照式断言——它们会在正常重构时集体变红，噪音会淹没真信号。
4. **错误要断言到具体那一条**：`expect(...).toThrow(/具体文案/)`，不要只断言「抛错了」。

## 门记录处于「预签态」时的写法

门记录（G1/G2）只在「最终候选提交上的那一轮独立审计」通过后签。审计之前，门记录必然处于预签态：
审计报告还没产出，`audit_report_sha256` 还是占位值，于是任何校验都先撞到审计锚点检查。

这时：

- 预签态下改动的下游校验（证据哈希、候选哈希、正文表）验不到具体是哪一处错；
- 所以测试写成：先断言「必须被拒」，错误确实落在锚点检查上就只保证被拒；
- 门重签之后，同一批用例会自动恢复成「指名是哪一道检查拦下」。

代码里已经有现成写法：`tests/gate/gate-check.spec.ts` 里的 `PRE_SIGNED` 与 `expectRejected()`。

## 故障注入

`scripts/fault-inject.ts` 放确定性故障场景（G-01…G-15、ev-g2-01…ev-g2-15），
由 `tests/integration/g1.spec.ts` 等用例调用。改故障场景要同时改门证据，否则门检查会因证据哈希不符而拒。

## 怎么跑

仓库在 Windows 上，pnpm 要走 cmd：

```powershell
cmd.exe /c "cd /d D:\aboutAI\dsh-orchestra && C:\Users\ASUS\AppData\Roaming\npm\pnpm.cmd check"
```

`pnpm check` = typecheck（`tsc --noEmit`）→ vitest 全量 → tsdown 构建。三步都要过。

单文件：

```powershell
cmd.exe /c "cd /d D:\aboutAI\dsh-orchestra && C:\Users\ASUS\AppData\Roaming\npm\pnpm.cmd vitest run tests/gate/gate-check.spec.ts --reporter=dot"
```

vitest 4.1.8 没有 `--reporter=basic`，用 `dot`。

## DSH 会话用例

固定操作、测试内审批和结果核对交给 GPT‑6 Luna 高思考子代理执行。用来源会话的原题派单，在同一会话核对返回的结果。遇到需要观察并发窗口的用例，应记录实际发生的分支。

后续会话用例使用已在官方 DSH Desktop 0.2.2-rc.5 验证的 DSH DevKit v0.1.1。用隔离宿主正常提供的连接文件设置 `DSH_DEV_URL_FILE`，先执行 `doctor` 并确认 Orchestra 已加载。绑定现有工作区时，v0.1.1 的 `create` 命令强制携带 `cwd`，而宿主要求在路径与工作区标识中选一个。使用同一工具包的客户端只传 `workspaceId`，核对新会话确实登记在目标工作区。

```python
from uuid import uuid4
from dsh_dev import Client, read_url

session_id = "session-" + str(uuid4())
receipt = Client(read_url()).call("create", {
    "sessionId": session_id, "workspaceId": workspace_id, "agentPreset": "standard",
})
assert receipt["sessionId"] == session_id
```

其余步骤使用工具自带的 `send`、`wait`、`inspect` 和 `export`。提交返回的请求编号用来定位本轮回复。Orchestra 后台任务可能晚于来源模型回合结束，等对应运行终态和来源回执均出现后再导出。成果链接、内置浏览器和工作台样式继续由子代理在同一来源会话中点击核对。[本轮实测记录](../audits/S6-coordination-overhead-independent-audit-round3.md)

## 提交前自检

- [ ] `pnpm check` 三步全过（typecheck / vitest / build）。
- [ ] 新增断言没有写死迁移条数、哈希、表结构。
- [ ] 改过的门证据已经重算哈希并重新注入。
- [ ] 候选文件在提交后不再改动——审计报告要绑定同一个 commit SHA，改了就得重跑审计。
