# dsh-orchestra 代码图谱索引（codebasemap）

> 本文件是「代码在哪、图谱叫什么、怎么更新、要看哪块用哪个工具」的唯一入口。
> 硬约束（来自 dshQQ）：**每个被维护项目的 handoff.md / codebasemap.md 写在该项目自己的仓库根目录** —— 本文件即本项目的根目录版本。

---

## 一、图谱清单

图谱由 **codebase-memory-mcp** 建立，落盘位置 `C:\Users\ASUS\.cache\codebase-memory-mcp\<项目名>.db`。
要随仓库共享时，用 `index_repository(..., persistence=true)` 额外产出 `.codebase-memory/graph.db.zst`。

| 图谱名 | 对应目录 | 规模 | 语言 | 建图模式 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `pi-harnessmm` | `references/pi-harnessmm/` | 124 节点 / 294 边 | TypeScript (8 文件) | moderate | 最小 harness 范式参考 |
| `dsh-superagent-prototype` | `references/dsh-superagent-prototype/` | 2,012 节点 / 8,492 边 | TypeScript 108 + YAML 1 + CSS 1 | moderate | 官方研究原型参考 |
| `DS-Bot` | `references/DS-Bot/` | 10,539 节点 / 33,229 边 | JS 224 / YAML 14 / CSS 6 / Bash 5 / TS 2 / Py 2 / HTML 2 | moderate | 成品 bot 实现参考 |
| `dsh-orchestra-docs` | `docs/` | 97 节点 / 96 边 | Markdown | moderate | **本项目设计文档图谱** |

> 注：`dsh-orchestra` 整仓图谱在 2026-11-11 建过一次（12,674 节点 / 42,766 边），但因为它把三份参考项目重复计了一遍、没有信息增量，已删除；本项目自身只对 `docs/` 建图谱，参考项目各自独立建。

### 更新命令

```
# 参考项目（路径相对 D:\aboutAI\dsh-orchestra）
index_repository(repo_path="D:\aboutAI\dsh-orchestra\references\pi-harnessmm",           mode="moderate", name="pi-harnessmm")
index_repository(repo_path="D:\aboutAI\dsh-orchestra\references\dsh-superagent-prototype", mode="moderate", name="dsh-superagent-prototype")
index_repository(repo_path="D:\aboutAI\dsh-orchestra\references\DS-Bot",                  mode="moderate", name="DS-Bot")

# 本项目文档
index_repository(repo_path="D:\aboutAI\dsh-orchestra\docs", mode="moderate", name="dsh-orchestra-docs")
```

`mode` 选 `full` 时会额外建相似度/语义边（节点数与边数更大、查询更全，但耗时更久）。共享给团队时加 `persistence=true`。

### 查询工具速查

| 想知道 | 用哪个 |
| --- | --- |
| 整体结构、包分布、热点函数、跨包边界、聚类 | `get_architecture(project, aspects=["overview","entry_points","clusters"])` |
| 某个函数在哪、被谁调、复杂度与热点信号 | `search_graph(project, query="关键词")` |
| 读某个函数的源码 | `get_code_snippet(project, qualified_name="...")`（先 `search_graph` 拿准确 qualified_name） |
| 沿调用链追 | `trace_path(project, function_name="...", direction="both", mode="calls")` |
| 值怎么流 | `trace_path(..., mode="data_flow")` |
| 直接 grep 后按结构重要性排序 | `search_code(project, pattern="关键词", mode="compact")` |
| 自定义 Cypher 聚合 | `query_graph(project, query="MATCH ... RETURN ...")` |
| 跨仓库 HTTP/Channel 调用 | `trace_path(..., mode="cross_service")` |

> 常用 Cypher 片段（找热路径）：
> ```cypher
> MATCH (f:Function) WHERE f.transitive_loop_depth >= 3 OR f.linear_scan_in_loop >= 1
> RETURN f.qualified_name, f.transitive_loop_depth, f.linear_scan_in_loop
> ORDER BY f.transitive_loop_depth DESC
> ```

---

## 二、参考项目定位表

### 2.1 pi-harnessmm —— 最小 harness 四件套

**目录**（`references/pi-harnessmm/`，0.3MB，sha 8d0a9da，https://github.com/jlon/pi-harnessmm.git）

```
extensions/harnessmm.ts (17KB)   ← 扩展入口
src/admission.ts (8.5KB)         ← 准入
src/bank.ts (14.6KB)             ← 收据
src/controller.ts (13.2KB)       ← 控制器
src/guard.ts (6.4KB)             ← 守卫
src/pi-messages.ts (4.5KB)       ← 消息投影
src/policy.ts (14.6KB)           ← 策略
src/terminal.ts (5.4KB)          ← 进程与终端
tests/{admission,bank,guard,policy-parity,projection,terminal}.test.ts
scripts/parity-check.mjs (4.5KB)
tests/fixtures/upstream-contracts.json (18.7KB)
```

**包 / 依赖边界**：`harnessmm` / `terminal` / `controller` / `policy` / `pi-messages` / `bank` / `admission` / `guard`

| 我要看 | 去这个符号 |
| --- | --- |
| 扩展怎么注册、消息怎么投影 | `pi-harnessmm.extensions.harnessmm.harnessmm` / `.record` / `.selectLabel` |
| 准入判定与状态压缩 | `pi-harnessmm.src.admission.admit` / `deterministicAdmission` / `compactState` / `actionType` |
| 收据解析与幂等 | `pi-harnessmm.src.bank.parseBank` / `publicReceipt` / `schemaMatches` / `nativeCallId` |
| 收据守卫 | `pi-harnessmm.src.guard.receiptGuard` / `localGuard` / `guardReceipt` |
| 消息压缩与投影绑定 | `pi-harnessmm.src.pi-messages.compactMessages` / `toAuthoringMessage` / `projectionBinding` / `slowTokensOf` |
| 策略加载与校验 | `pi-harnessmm.src.policy.hash` / `byteUpper` / `object` / `validateCotJev` / `loadPolicy` |
| 进程树终止 | `pi-harnessmm.src.terminal.runTerminal` / `killTree` / `runRoot` / `collect` / `onAbort` |

**热点**：`hash` fan_in 7、`record` fan_in 5、`object` fan_in 5、`byteUpper` fan_in 3、`localGuard` fan_in 3。
**边界**：`bank→policy` 6、`controller→harnessmm` 5、`harnessmm→pi-messages` 5、`harnessmm→terminal` 4、`admission→guard` 3。
**聚类**：0 = 准入+策略（`decide`/`hash`/`admit`/`compactState`/`localGuard`）、2 = 控制器+投影（`execute`/`SubstitutionController`）、8 = 策略加载（`projectionBinding`/`validateCotJev`/`planInstruction`/`loadPolicy`）、11 = 终端（`runTerminal`/`killTree`/`runRoot`/`collect`/`onAbort`）、1 = 收据（`parseBank`/`object`/`terminalArguments`/`schemaMatches`/`publicReceipt`）、4 = 记录（`record`/`ownSlowCall`/`noteBank`）。

**对本项目的用处**（详见 `docs/design-notes.md` §4.3）：四件套最小闭环 → 最小实现骨架；`hash` 热点 → 幂等键统一算式（`compensation_id` / `report_id`）不许各处各算。

---

### 2.2 dsh-superagent-prototype —— 官方研究原型

**目录**（`references/dsh-superagent-prototype/`，3.3MB，sha 8c32a9d，https://github.com/deepseek-ai/dsh-superagent-prototype.git）

```
src/app/     38 个 ts 文件   ← 卡片、上下文、投递、执行环境、store、prompt、outbox、notices
src/client/  26 个 ts 文件   ← React UI
src/core/    15 个 ts 文件   ← 模型、id、part
src/executor/ 2 个 ts 文件
src/sources/ 16 个 ts 文件   ← 外部来源（飞书等）
src/infra/    5 个 ts 文件
```

**包规模**：`app` 460 / `client` 277 / `sources` 170 / `core` 146 / `executor` 70 / `infra` 49 / `policy` 18。
**Route**：`/open-apis/bot/v3/info`。

| 我要看 | 去这个符号 |
| --- | --- |
| 卡片渲染（ticket/decision/thread） | `dsh-superagent-prototype.src.app.cards.ticketCard` / `decisionCard` / `threadCard` / `preview` / `ticketDetails` |
| 上下文与交接策略 | `src.app.context.handoffPolicy` / `autoMergeThreshold` / `transcriptEntry` |
| 投递与消息 id | `src.app.delivery.messageId` |
| 执行环境 | `src.app.execution-environment.executionRoot` / `ticketEnvironment` / `environmentOf` / `declaredVariables` |
| 大块文件（值得读原文） | `src/app/migration.ts` 46.8KB、`src/app/sessions.ts` 24.5KB、`src/app/resources.ts` 22.3KB、`src/app/prompts.ts` 19.7KB、`src/app/runtime.ts` 17.6KB、`src/app/settings.ts` 17.9KB、`src/app/http.ts` 16.4KB、`src/app/effects.ts` 10.2KB、`src/app/notices.ts` 9.2KB |

**热点**：`usePanel` fan_in 64、`core.ids.key` fan_in 36、`client.controls.Icon` fan_in 35、`core.part.EnginePart.now` fan_in 32、`core.model.liveTicket` fan_in 31、`core.model.threadKey` fan_in 21。
**边界**：`app→core` 55、`sources→infra` 29、`client→app` 21、`app→executor` 20、`executor→core` 17、`app→sources` 16、`app→policy` 12。
**聚类（挑几个有代表性的）**：39 = client UI（`usePanel`/`Icon`/`TicketPage`/`Hint`/`Button`）、10 = core 模型（`key`/`now`/`liveTicket`/`UserError`/`threadKey`）、31 = 迁移（`migrateTo11`/`migrateSourceRecords`）、3 = 概览快照（`threadSummary`/`preview`/`overview`/`snapshot`/`ticketDetail`）、0 = 执行器调度（`workerSessionId`/`runningAssignment`/`deliverQueued`/`launch`）、**82 = 通知队列**（`readStream`/`sameName`/`pollNotifications`/`readNotified`/`gate`）、81 = 设置与 prompt 版本（`save`/`policyVersion`/`promptsView`）、29 = 外部来源消费（`scan`/`pollThread`/`feishuTrigger`/`consume`）。

**对本项目的用处**（`design-notes.md` §4.1）：ticket 一等公民 → decision 卡；`execution-environment` 分层 → executor 会话与 owner_epoch；`handoffPolicy` → §17 事件来源分离；cluster 82 通知队列 → outbox + cursor/ack。

---

### 2.3 DS-Bot —— 多端 IM bot 成品

**目录**（`references/DS-Bot/`，35.6MB，sha 8e0013e0，https://github.com/Fei2411/DS-Bot.git）

```
app/          ← 应用层（engine/index.js、src/bot-browser.mjs、src/browser-sources.mjs、src/app-patch.mjs…）
ds-bot/       ← 核心（client.js 1.7MB、office.js 318KB、web-search.js 42KB、index.js）
               src/{client,host,office,shared}/  dev/{desktop-linux,harness,learning-eval}/  test/
browser-plugins/  docker/  mobile/  scripts/  docs/  .agents/
AGENTS.md  README.md  README.zh.md  SECURITY_MODEL.md  CHANGELOG.md(85KB)
```

**包规模**：`src` 4,987 / `client` 1,676 / `office` 290 / `dev` 222 / `test` 156 / `ui` 84 / `web-search` 65 / `bench` 55。
**Route 33 个**，含 `/messages/send`、`/channels/:chat.key/messages`、`/gateway/bot`、`/open-apis/im/v1/messages`、`/open-apis/bot/v3/info`、`/users/@me`、`/interactions/:data.id/:data.token/callback`。

| 我要看 | 去这个符号 |
| --- | --- |
| 应用引擎入口 | `DS-Bot.app.engine.apply` |
| 浏览器来源与 cookie | `app.src.browser-sources.chromiumProfiles` / `cloneCookieStore` / `harvestCookies` / `locksProfile` / `importFromBrowser` / `browserProcesses` |
| 导航白名单 | `app.src.bot-browser.allowedNavigation` / `requestAllowed` / `partitionOf` / `isAppHost` |
| 客户端 API 层 | `ds-bot.client.resolve` / `set` / `push` / `getSnapshot` / `get` / `after` |
| 国际化 | `ds-bot.src.client.i18n.t` / `ds-bot.client.t` |
| 记忆层 | `ds-bot/src/client/` 下的 memory 相关模块（cluster 264：`memoryRestore`/`memoryLayer`/`reviewBatch`） |
| 组队协作 | `ds-bot/test/group-work.test.js` (99KB) |

**热点**：`ds-bot.client.t` fan_in 344、`ds-bot.src.client.i18n.t` fan_in 333、`ds-bot.src.client.api.call` fan_in 146、`ds-bot.client.resolve` fan_in 127、`ds-bot.client.set` fan_in 114、`getSnapshot` fan_in 66。
**边界**：`src→client` 105、`ui→src` 31、`dev→src` 26、`client→src` 25、`bench→src` 13、`src→test` 13。
**聚类**：264 = 记忆（cohesion 0.97）、241 = IM 插件（0.94）、350 = app UI（0.99）、204 = elementsOf/applyOp（0.98）、7 = 客户端核心（668 节点）、16 = 客户端状态（660）、17 = 事件（626）、174 = browser-plugins（227）、161 = app IPC（225）、178 = 同步/记忆（195）、19 = browser-plugins UI（140）。

**对本项目的用处**（`design-notes.md` §4.2）：cluster 264 记忆分层 → 第五段「记忆插件对接 memory-audit-v1」的直接对标；`ds-bot/test/` 100+ 文件、`memory.test.js` 160KB → 状态机必须逐行生成用例；`allowedNavigation`/`locksProfile` → §1.1 只读身份与 allowlist 的思路。

---

## 三、本项目文档图谱（dsh-orchestra-docs）

| 文件 | 行数/大小 | 内容 |
| --- | --- | --- |
| `docs/orchestra-design-draft.md` | 670 行 / 215KB | **规则条文唯一权威**：第一段（桥/生命周期/控制面）、第二段（17 条硬规则）、第三段（九节点图 §3.0–§3.5）、历史修订清单 §3.4–§3.4j |
| `docs/orchestra-audit-ledger.md` | 84 行 / 18KB | 逐轮审计台账：§一 逐轮记录（1–20 轮）、§二 几件能算出来的事、§三 收敛判据、§四 统计口径、§五 当前进度与续跑指引 |
| `docs/requirements.md` | 约 330 行 / 19KB | 原始需求（R1–R23 主人原话表）、需求分解 F1–F13 / N1–N7、拍板口径 §3.1–§3.7、验收标准 |
| `docs/design-notes.md` | 约 300 行 / 28KB | 设计思路：16 条决策（问题→决策→理由→被否方案→代价）、五个坑族、参考项目学了什么、风险清单 |
| `docs/audits/` | 每轮一份报告 + 一份整改对照表 | 独立审计报告（S1 / S2 第一至第四轮，最新 `S2-independent-audit-round4.md`）与整改对照表（`S2-round2-response.md`、`S2-round3-response.md`、`S2-round4-response.md`）：放行依据是审计报告本身，对照表只是实现者自证 |

**查法**：
- 「某条规则写在哪一行」 → 直接读设计稿（`orchestra-design-draft.md`），行号见下方 §四。
- 「为什么这么设计」 → `design-notes.md` §2 对应小节。
- 「主人定了什么」 → `requirements.md` §3 拍板口径。
- 「上一轮审到哪、下一轮改什么」 → `orchestra-audit-ledger.md` §五。

### S2 源码与门证据落点（2026-11-14 第二批意见第一批收口后）

| 文件 | 作用 |
| --- | --- |
| `src/core/clock.ts` | 墙钟、预算、跨 boot 的时钟口径（unknown 判定、verify 超时） |
| `src/core/workflow-def.ts` | 流程定义与代次校验（workflow_version、代次单调） |
| `src/service/commands/apply-report.ts` | 报告落账唯一入口（幂等、重放、attempt 校验、decision_required 拒收；判定条件自己按 run 的 `workflow_version` 取，调用方不能带 policy） |
| `src/service/commands/node-state.ts` | 节点状态写入（verify_deadline_at 起钟、verify_remaining_ns 落列） |
| `src/service/commands/runtime.ts` | 运行时装配（只把 catalog 交给 applyReport，命令层不自取 policy） |
| `src/service/runs.ts` | 生产装配：createRun 建 task/run/node_runs |
| `src/service/dispatcher.ts` | 生产装配：dispatchRun 拾 queued 节点走 runNode |
| `src/executor/tools.ts` | 工具注册表与授权（`assertToolsAuthorized`：deny 优先、必须注册、必须落在 allow 集） |
| `src/core/audit-verdict.ts` | 结构化审计裁决（`AUDIT_VERDICT_SCHEMA` / `parseAuditVerdict` / `validateAuditVerdict` / `verdictProblems`）：门放行的权威输入，词法解析降为第二道防线 |
| `src/core/freeze.ts` | `deepFreeze`：目录里的工作流定义冻结，外部拿到过引用也改不动 |
| `src/service/schemas.ts` | Zod 入参 Schema 与 `LIMITS`（租约 TTL 与续租间隔、工具超时、节点数、attempt 范围、长度上限） |
| `src/service/execution-scheduler.ts` | 执行调度器：并发上限与人工名额，接 `orchestra.config.json` 的 `concurrency` / `human_slots` |
| `src/service/write-queue.ts` | 短写 FIFO 队列（tail 链）：只管数据库短写，长执行不占名额 |
| `src/service/commands/apply-report.ts` | 报告落账唯一入口（幂等、重放、attempt 校验、decision_required 拒收；按 execution_id 核对工具痕迹） |
| `src/executor/bridge.ts` | 桥 RPC 客户端、`BridgeEventSource.listen` 事件流、三游标 `BridgeEventBuffer`、断号重取 |
| `src/executor/bridge-ledger.ts` | 桥事件落账唯一入口：事务内校验跳号、receipt 幂等/冲突、推进 `bridge_stream_cursors` |
| `src/infra/sqlite/migrations/006_tool_executions_tool_seq.sql` | 工具执行唯一性：`tool_executions` 主键 `node_run_id+attempt+tool_seq`，`execution_id NOT NULL UNIQUE` |
| `src/infra/sqlite/migrations/008_bridge_event_receipts.sql` | 桥事件收据与按 `(node_run_id, attempt, executor_agent_id)` 隔离的持久确认游标 |
| `src/infra/sqlite/migrations/007_node_run_events_append_only.sql` | `node_run_events` 只追加触发器（UPDATE / DELETE 被数据库挡下） |
| `src/index.ts` | 装配入口（`openServiceOrchestra`：acquireDbLock → bumpEpoch → openServiceDb → createOrchestra） |
| `src/service/sweep.ts` | 围栏与过期扫描（逐行事务，回收 verifying 超时） |
| `src/infra/sqlite/migrations/003_s2_round3.sql` | 第三轮新增迁移（账本列与索引） |
| `scripts/fault-inject.ts` | 故障注入取证（1377 行；InjectionCase `ev-g2-01`…`ev-g2-15`，写 `docs/gates/evidence/`，输出时间戳归一） |
| `scripts/gate-check.ts` | 门检查校验链（2062 行：必过项 / 证据 / 不变量 / 正文表 / 候选 / 哈希 / 结论解析、计数语义与隐藏定义防护） |
| `scripts/sign-gate.ts` | 门记录重签（83 行：回填证据 sha256 与各类哈希，自检后写回） |
| `docs/gates/G1.md`、`docs/gates/G2.md` | 两道门记录（必过项表、证据表、不变量表、artifact） |
| `docs/gates/evidence/G1/`（13 份）、`docs/gates/evidence/G2/`（19 份） | 门证据原文，哈希逐份复核 |
| `tests/unit|contract|integration|e2e|gate/` | 测试分层（2026-11-14 起，原 `tests/*.spec.ts` 26 个迁入）；口径见 `tests/README.md` 与 `docs/agents/testing-conventions.md` |
| `docs/reviews/2026-11-13-second-opinion.md` + `...-response.md` | 2026-11-13 外部架构评审原文与逐条处置对照表 |
| `scripts/check-test-layout.mjs` | 测试目录布局检查 |

---

## 四、关键行号索引（设计稿 670 行）

> ⚠️ 行号对应 2026-11-11 16:42 版（SHA256 前缀 DFCEA51FF9D53AC4）。**改稿后行号会漂**，用本表定位后请以内容为准。

| 行号 | 位置 |
| --- | --- |
| L1 | 文档标题 |
| L5 | 第一段：骨架与落点 |
| L25 | §1.1 桥（执行类 RPC 表、runTool 只读身份） |
| L63 | §1.2 生命周期（三种退出、drain / host_gone） |
| L84 | §1.3 控制面（endpoint / secret / 交接顺序） |
| L97 | 第二段：把「硬」落成规则（1–17 条） |
| L99 | node_run 字段全集 |
| L111 | 未知态只留一个钟 `unknown_watchdog` |
| L113 | 桥断不重置启动计时 |
| L115–124 | **桥断时钟矩阵（唯一权威）** |
| L130 | `applyReport(node_run_id, attempt, report, expected_status, generation, policy)` |
| L175 | 超时路径（cancel_result 四取值） |
| L180–201 | 重试、副作用、indeterminate / abandoned_unverified 分流、sweep 恢复表 |
| L209 | §8 迁移表表头 |
| L213 | `leased → dispatched`（**Ga 自增点唯一**） |
| L215–225 | 启动层三分支、startup_unknown 各出口 |
| L226 | `started → verifying`（起 verify_timeout 钟） |
| L227–228 | `verifying → done/failed`、`verifying → blocked_post` |
| L243–244 | `verifying → failed / failed_with_unverified` 两互斥落点 |
| L263 | **node_run 终态集合（唯一权威）** |
| L265–273 | 离开 verifying 的行显式清钟 |
| L277–278 | 补偿失败 / 无可执行补偿 → failed_with_unverified |
| L282–284 | **run 级结果判定三条（顺序不可调）** |
| L290 | `derive_run_state` 派生规则 + 性能口径 |
| L292 | run 终态枚举 |
| L301 | 终态 CAS 第六条（**`succeeded` 只认 side_effect_verified_none**） |
| L303 | 终态 CAS 第七条（成功支 / 失败支分叉） |
| L307–318 | decision 迁移表 |
| L320 | decision 终态集合 |
| L322–329 | decision kind 八种 / resolution 分类 |
| L333–350 | 裁决出口副作用表、continue_wait 口径 |
| L352 | §9 声明式判定 |
| L356–377 | §11 身份与账本（capability 推导、证据强弱、passCondition） |
| L371–376 | verification_policy 与证据族字段 |
| L383 | §14 存储实况与索引清单（**report_id UNIQUE 尚缺**） |
| L387 | §15.1 与原生 workflowEngine 的边界 |
| L420 | 第三段：九节点图（v18 标题行） |
| L422 | §3.0 两类契约 |
| L434 | §3.1 能力矩阵 |
| L452 | §3.2 九种推进 |
| L496 | §3.3 升级链路 |
| L504–650 | §3.4 历史清单 b–j（j 为当前 `[CURRENT]`） |
| L632 | §3.4j `[CURRENT]` 第二十轮修订清单（12 条） |
| L650 | §3.5 本段最容易被低估的一处 |

---

## 五、参考项目怎么用（不要照抄代码）

三个参考项目是**读架构**用的，不是抄代码用的：

| 参考 | 读它是为了 | 不要做什么 |
| --- | --- | --- |
| dsh-superagent-prototype | 看清「ticket / decision / handoff / 通知队列」怎么在一个可运行原型里落地 | 不要把原型的宽松口径带过来（它没有持久账本、没有证据门） |
| DS-Bot | 看产品级记忆层、工具测试规模、浏览器来源边界的成品实现 | 不要照抄它的 JS 实现与部署形态（我们是 DSH 插件） |
| pi-harnessmm | 看最小 harness 闭环该有哪几个模块 | 不要照抄它「单进程无账本」的简化前提 |

**共同底线**：主人的标准是「严格严谨」（R6），参考项目是**下限参照**不是上限。
