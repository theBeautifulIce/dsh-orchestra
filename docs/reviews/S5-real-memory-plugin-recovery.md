# S5 真实记忆插件恢复验证

2026-11-18，以编排仓库 `588458e` 为开发基线。实测使用 `dsh-memory-plugin 0.4.29` 的 [受控写入提交](https://github.com/theBeautifulIce/dsh-Immunity-memory/commit/5d6f0089a0a26f04a6e17457d97b269772326fdc) 和该提交打包的 Windows Go 侧车。侧车 SHA-256 为 `fc01971a0363c68edeb4a6d254b9cfccbc7e1b88c3a17e92dfe7de525565e55f`。

## 宿主装配

1. DSH 在 Cordis 加载记忆插件。带迁移 v5 的 Go 侧车探活后，插件提供私有 `orchestraMemoryWriter` 协议 1。使用 Node SQLite、JSON 或旧 Go 侧车时，该服务不可用。
2. 编排宿主调用 `serveOrchestra`，在原有参数中加入 `memory: { context: ctx, prepareItems, judge }`。`ctx.get('orchestraMemoryWriter')` 需要能取得插件服务。`prepareItems` 整理源运行，`judge` 返回评估结果。这两个回调由宿主提供。恢复始终从原插件 Go 库读取，在同一库上重启插件后可以继续核对。
3. DSH 客户端从 `dsh-orchestra/client` 取得 `createPanelHost`，沿用编排服务的受认证 fetch。打开「记忆」，待核对批次显示「核对记忆写入」。界面按写入数、证据和当前决定修订号展示可选操作。弃写后再次核对可进入签认。

宿主用 `POST /v1/memory/runs/start` 发起，现有决定收口入口提交记忆批准快照。恢复使用 `/v1/memory/recovery/inspect` 和 `/v1/memory/recovery/resolve`。核对会封锁旧 attempt，所以使用写请求。恢复命令携带证据编号、停止时刻和决定修订号。结果未知时客户端只查同一 `operation_id` 的回执。

## 复现

在编排仓库根目录执行。将参数改为与上述提交相符的实际插件包目录。插件通过常规 Windows 启动路径把 Go 侧车暂存到各自独立的数据目录。

```powershell
node --no-warnings scripts/verify-memory-plugin-recovery.ts 'D:/aboutAI/记忆插件设计/packages/memory-plugin'
node --no-warnings scripts/fault-inject.ts --case G-11 --out tmp/g11-production-regression
```

真实插件测试启动 `apply()`、Go 侧车与 `serveOrchestra()`，使用面板客户端的 HTTP 调用和一个确定性测试裁判。故障装置在插件调用边界丢失回执。部分写入通过向真实插件提交已批准条目的一部分构造。每个分支都在核对前重新加载插件及侧车，并在收口后读取实际 Go SQLite 条目、来源和回执表。

| 分支 | 对账时已写／未写 | 可选操作 | 收口后的实际条目 | 记忆运行结果 |
| --- | --- | --- | --- | --- |
| 全写入后回执丢失 | 2／0 | 确认已写入 | 2，原写入保留 | `succeeded` |
| Go 事务因第二条校验失败而回滚 | 0／2 | 确认未写入 | 2，一次新 attempt 写入 | `succeeded` |
| 一条实际提交后回执丢失 | 1／1 | 放弃，再签认 | 1，已写条目保留 | `succeeded_with_unverified` |

所有分支均验证旧 attempt 拒绝迟到写入。G-11 的 `SIGKILL` 注入另用独立 SQLite 写入夹具，复跑产物与 [原始证据](../gates/evidence/G5/G-11.md) 的 SHA-256 一致。

插件仓库的 `go test ./...` 和 13 个 Node 测试文件通过。编排仓库的 `pnpm check`、面板回归及测试布局检查通过。本机正在运行的 DSH 桌面配置与记忆库未参与验证。G5 仍待冻结候选和独立审计。
