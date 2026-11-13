# 外部静态评审（2026-11-13）与逐条核实结论

- 来源：外部评审方按 GitHub 上 `theBeautifulIce/dsh-orchestra` 公开仓库的静态审阅（未在本地跑测试）。
- 评审看到的仓库状态：约 29 个 spec / 227 条用例、G1/G2 首轮重签后、只见到第一轮审计报告。
- 当前仓库状态（2026-11-13 16:40）：三轮独立审计已走完三轮整改，31 个 spec / 271 用例全绿，G1 artifact `7c371df81692…`、G2 artifact `884a606523f2…`（15 项必过、15 份证据），第四轮独立审计在跑。
- 本文只记「评审说了什么 + 我核实到哪 + 归到哪一批」，不代替审计报告。

## 一、六条主问题

| # | 评审的判断 | 我的核实 | 处置 |
| --- | --- | --- | --- |
| 1 | 执行器与 Agent 桥没闭环：`runNode` 建完 agent 就直接跑 `ReadOnlyToolRunner` 的命令，没真调 `BridgeClient` | **成立**。`git grep bridge` 显示 `src/executor/bridge.ts` 只被自身、阶段能力表与状态名引用；`src/executor/run-node.ts` 的执行链是「建 agent → 跑命令 → 校验命令哈希 → 进 verifying → 收口」，没有 spawn/subscribe/send/events 的桥生命周期 | 即已登记的 F-06，**S3**：桥接生产路径 + 事件消费、断号重取、服务端确认、dispose 的完整生命周期 |
| 2 | 工具白名单存在绕过：`runNode` 校验的是声明的 `toolPolicy`，实际执行的是 `p.tools`，二者没做交集；`tests/runtime.spec.ts` 里 allow 为空仍执行 `ro.echo` | **成立**。`src/executor/run-node.ts:50` 只调 `checkToolPolicy(registry, p.toolPolicy)`（校验策略里的工具存在、能力派生为 pure），随后 `for (const tool of p.tools)` 直接 `deps.runner.runTool`；`deps.registry.require(tool.command)` 只保证命令已注册，deny 未参与判定 | **新增 P0，S3 开场前修**：执行前逐条核对 command ∈ allow、deny 优先拒绝、参数按工具自身 schema 校验 |
| 3 | 强证据来源可伪造；`requiredHashes` 没接进判定流程 | **前半成立、后半已过时**。本轮已加系统级证据门 `systemEvidenceGate`（无证据 / 非 `run_tool` 弱来源 / exitCode≠0 一律拒）与痕迹绑定门 `traceBindingGate`（与服务端写的 `tool_executions` 行对不上 → `evidence_unverifiable`），报告只引用服务端落库的痕迹。`required_hashes` 已在本轮接进 `src/core/workflow-def.ts` → `src/service/workflows.ts` 的 `policyFor` → `applyReport` 的 `evaluateEvidence` | 评审提的更强形态（服务端签发 `evidence_id` + nonce 绑定 node_run/attempt/action_generation，Agent 只能引用证据）**留 S6 安全加固**；本轮已闭合的部分以 `ev-g2-10` 为证 |
| 4 | 单写者的进程级隔离没接进启动路径：`createOrchestra` 只 `openDb` + 跑迁移，没有取文件锁也没有递增 epoch | **成立**。`src/index.ts:42` 起的启动链确实没有 `acquireDbLock`（`src/infra/lock.ts`）与 `bumpEpoch` / `openServiceDb`（`src/infra/db/open.ts`）；两个进程可能拿到同一 epoch 并都通过事务检查 | **新增 P0，S3 开场前修**：启动链改成 取锁 → 递增 epoch → 打开服务库 → 迁移 → 恢复 → 起服务；并补双进程故障注入（老服务恢复后写不进） |
| 5 | 工作流定义没成为持久化一等对象：`WorkflowCatalog` 是内存 Map，只按 `workflow_version` 索引、允许覆盖、重启即失 | **成立**。`src/service/workflows.ts:14` 的 `defs` 是 `Map<string, WorkflowDefinition>`；两个流程都用版本 `1` 会互相覆盖，`load()` 允许覆盖已发布版本，重启后 `policyFor` 无定义可用 | **S4**：做 `workflow_versions` 表（主键 workflow_id + version、definition_hash、已发布不可覆盖、run 绑定版本与哈希、恢复时从库加载） |
| 6 | 租约 / 心跳 / 维护扫描没形成生命周期：无续租路由、执行期不续租、`runNode` 复用同一个 `p.now` | **部分成立，部分已过时**。已成立：`src/service/server.ts` 的路由里没有续租入口（只有 lease / report / run / cancel / ledger-events）；`runNode` 执行期不自动续租；全程复用 `p.now`；配置 `lease_ttl` 30 秒小于 `action_timeout` 120 秒，长动作有租约过期风险。**已过时**：维护扫描已在 `src/index.ts` 的 `serveOrchestra` 里 2 秒一轮自动跑（`setInterval` + `unref`） | **新增 P1**：续租路由 + 执行期按 `lease_renew_interval_ms` 自动续租 + 上报用当前实际时间 + 长动作/重启/迟到上报的集成用例 |

## 二、四条工程细节

| 方向 | 核实 | 处置 |
| --- | --- | --- |
| WriteQueue 只是 pending 计数，不是 FIFO 串行 | 成立：`src/service/write-queue.ts:6` 是 `private pending = 0`，满了就拒 | S6 硬化 |
| HTTP 入参只做 `requireFields` + 手工类型转换 | 成立：`src/service/server.ts` 各路由用 `requireFields(body, [...])` 再强转类型 | S6：逐接口补输入 schema |
| `resolveInside` 只查路径字符串，没查符号链接最终指向 | 成立：`src/executor/tools.ts:100` 只做 `resolve` + 前缀比较，没有 realpath | S6 安全：加 realpath 校验 |
| 配置装配未统一走配置加载与校验 | 成立：各装配点直接吃传入参数 | S6：统一启动配置入口 |
| 建议加 GitHub Actions CI（typecheck / test / build / G1 / G2） | 成立：仓库没有 `.github/workflows` | S6 或更早：把门检查变成合并硬门槛 |

## 三、评审的排序建议（我认可，落到批次上）

1. **S2 生产闭环加固**（最高优先）：桥 → Agent → Tool → Evidence → ApplyReport 真打通；修工具权限绕过；证据来源可信；接入 DB 锁与 epoch；接入自动续租与扫描；再做一次独立端到端审计。
2. **S3–S4 调度与定义持久化**：不可变流程定义、DAG 依赖与调度器、Decision / Approval / Inbox、Parallel / Subworkflow、补偿、run 级状态派生。
3. **S5–S6 产品化与可靠性**：面板接真实账本、人工裁决交互、跨插件控制接口、恢复与可观测性、长时故障注入与压测、安全审查与发布。

评审最后那条原则与本项目一直的口径一致：**不要让设计文档的完成度领先于代码的真实完成度** —— 每一个设计不变量都要指得到具体实现、反例测试与故障注入证据。
