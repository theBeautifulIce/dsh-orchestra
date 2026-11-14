# Agent Bridge 生产生命周期设计（R5-A）

状态：提议稿，未提交、未实施。当前 main 仍为 `caae193`，G1/G2 绑第 44 轮；本文件不改变任何已签候选，签署仍以 `caae193` 为准。

## 1. 范围

本设计只处理 R5：让 Agent 通过 Bridge 真正驱动节点执行，服务端托管工具执行与强证据，事件可靠落账，取消与释放有闭环。

不在本设计内：

- R3：账本链头保护、工具真实 `started_at`/`finished_at`/`duration_ns`。
- R4：`workflow_id + version` 复合身份与 `WorkflowDefinitionSchema.parse` 统一加载。
- S3 九节点与状态机。

R3、R4 分别独立提交，不和 R5 混在一起。

## 2. 现状核对

| 位置 | 现状 | 影响 |
| --- | --- | --- |
| `src/executor/bridge.ts:7-9` | `BridgeTransport` 只有 `request<T>()` | 没有持续事件流，`subscribe()` 只拿订阅确认 |
| `src/executor/bridge.ts:66-70` | `subscribe()` 返回 `subscribed/fromSeq/lastSeq` | 不能作为 `runNode()` 可消费的事件源 |
| `src/executor/run-node.ts:127-133` | `createExecutorAgent()` 后只保留 agent | Agent 身份被记录，但没收到完整任务 |
| `src/executor/run-node.ts:157-185` | `for (const tool of p.tools) deps.runner.runTool()` | 工具由服务端预定义清单直接执行，不是 Agent 的 `tool.call` 驱动 |
| `src/executor/session.ts:101` | `buildInstruction()` 存在 | `run-node.ts` 没有调用，也没有经 Bridge 发指令 |
| `src/executor/bridge.ts:146,160-175` | 单个 `seqCursor` | 收到 5 时直接推进到 5；再补 3 会按序号倒退抛错 |
| `src/service/server.ts:234` | 取消接口把调用方 `cancelResult` 交给 `cancel()` | 账本可记 `interrupted`，但没有证明宿主 Agent 真停了 |
| `src/index.ts:138` / `src/service/execution-scheduler.ts:233` | `openServiceOrchestra()` 的 scheduler 可选；`runThroughScheduler(undefined)` 直接执行 | 自行装配 HTTP 的调用方仍可绕过并发上限 |
| `src/executor/run-node.ts:204-219` | `started_at` 与 `finished_at` 都在工具结束后取 `nowAt()` | 不能表示真实耗时 |
| `src/service/workflows.ts:20,32,53` / `004_workflow_versions.sql` | Map 与表都以 `version` 为 key | 不同 workflow 不能安全共用同一版本号 |

结论：BridgeClient 的七个 RPC 方法可以独立工作，但生产执行链仍是“创建 Agent，然后服务端自己跑工具”。不能把 BridgeClient 单测通过当作 R5 完成。

## 3. 设计原则

1. Agent 的自然语言输出永远不能直接改变账本状态；Agent 只能发工具调用、回合事件和结构化报告，最终状态仍走 `applyReport()`。
2. 强证据只能来自宿主 `ReadOnlyToolRunner.runTool()` 的实际执行结果、命令哈希和产物哈希；Agent 回的 `tool.result` 只是 Agent 侧信息。
3. 账本事务提交之前，绝不推进确认游标；先落账，再 ACK。
4. 所有事件按 `(node_run_id, attempt, executor_agent_id, seq)` 幂等；同 seq 不同 payload 是协议冲突，不是覆盖。
5. 断线、重启、旧 attempt 迟到事件都必须能被识别；旧 attempt 不能污染新 attempt。
6. `run-node.ts` 只保留租约、状态机与收口，不再直接承担 Agent 协议细节。

## 4. 组件切分

### 4.1 AgentLifecycle

新增 `src/executor/agent-lifecycle.ts`。

职责：

- `start()`：spawn，记录 `executor_agent_id`，建立事件流，发任务指令。
- `resume()`：按持久化 `bridge_ack_seq` 重新订阅并重放，不重复 spawn。
- `sendInstruction()`：只在订阅确认后发送。
- `cancel()`：向宿主发取消，返回四值枚举，不直接写账本。
- `awaitTermination()`：`whenIdle()` + `state()`，确认 Agent 已停。
- `dispose()`：确认 ACK 追平、在途工具已结算后才释放。

内部状态：`spawning -> active -> stopping -> stopped | failed`。每次迁移都带 `nodeRunId + attempt`，旧 attempt 的迁移拒绝。

### 4.2 BridgeConsumer

新增 `src/executor/bridge-consumer.ts`。

职责：

- 打开事件流，校验事件类型、seq、attempt、agent。
- 维护三个游标：`lastReceivedSeq`、`lastContiguousSeq`、`lastPersistedAckSeq`。
- 缺口时暂存后到事件，按 `lastContiguousSeq + 1` 连续消费；不把最大收到序号当确认游标。
- 每条事件交给 `EvidenceCollector`/账本消费者，事务成功后才 `ack(seq)`。
- 重连从 `lastPersistedAckSeq + 1` 开始，不从 0 开始。

### 4.3 EvidenceCollector

新增 `src/executor/evidence-collector.ts`。

职责：

- 校验 `tool.call` 的工具名、参数、cwd、超时。
- 重新走服务端 `ToolRegistry` 与工作流授权策略，不信任 Agent 或外部给的清单。
- 写 `tool_call_requested` 事件。
- 调 `ReadOnlyToolRunner.runTool()`，记录真实开始/结束与强证据。
- 把工具结果放进 outbox，按幂等键回传 Agent。

### 4.4 runNode

`RunNodeDeps` 增加：

```ts
export type RunNodeDeps = {
  runtime: RuntimeDeps
  db: Db
  secret: string
  registry: ToolRegistry
  bridge: AgentBridgeRuntime
  runner: ReadOnlyToolRunner
}
```

`runNodeActions()` 改为：

1. 取租约，进入 `started`。
2. `lifecycle.start()`。
3. 等待 `BridgeConsumer` 把最终结构化输出交给 `submitReport()`。
4. 失败/取消走既有 `markBlocked` 或 `applyCancel`，不直接改状态。
5. `finally` 中按释放条件 `dispose()`。

`agent` 不再只用于返回 `agent_id`；它必须是事件流的拥有者。

## 5. 事件传输与缓冲

### 5.1 传输接口

```ts
export type BridgeEventStream = {
  listen(
    params: { executorAgentId: string; attempt: number; fromSeq: number },
    signal?: AbortSignal,
  ): AsyncIterable<BridgeEvent>
}

export type BridgeTransport = {
  request<T>(method: string, params: unknown): Promise<T>
  listen(
    params: { executorAgentId: string; attempt: number; fromSeq: number },
    signal?: AbortSignal,
  ): AsyncIterable<BridgeEvent>
}
```

`spawn()` 已隐含首次订阅；`subscribe()` 只用于重启/断线重连，不机械重复。

### 5.2 三游标

- `lastReceivedSeq`：收到过的最大 seq，只用于观测。
- `lastContiguousSeq`：已经连续收到并处理的 seq。
- `lastPersistedAckSeq`：已经落账并确认的连续 seq。

三者不能合成一个 `seqCursor`。`BridgeEventBuffer` 构造时注入 `lastPersistedAckSeq`，不从 0 开始。

### 5.3 push 算法

```text
push(ev):
  校验类型/seq 正整数
  if ev.seq <= lastPersistedAckSeq:
      同 payload -> 幂等忽略
      不同 payload -> 协议冲突
  if pending 已有 ev.seq:
      同 payload -> 幂等忽略
      不同 payload -> 协议冲突
  pending.set(ev.seq, ev)
  lastReceivedSeq = max(lastReceivedSeq, ev.seq)
  while pending.has(lastContiguousSeq + 1):
      next = pending.take(lastContiguousSeq + 1)
      deliver(next)
      lastContiguousSeq = next.seq
  return gapFrom = pending 非空 ? lastContiguousSeq + 1 : null
```

`ack(seq)` 只允许 `seq === lastPersistedAckSeq + 1` 且已经落账；ACK 后推进到 `seq`。缺口期间不推进。

### 5.4 落盘

溢出仍按现有 `spill()` 落 JSONL，但 `takeFrom()` 必须同时覆盖 pending 与 spill，按 seq 去重排序。重连恢复时先读账本 `bridge_ack_seq`，再读 spill 补齐；不依赖内存游标。

## 6. 持久化

新增 `src/infra/sqlite/migrations/008_bridge_event_receipts.sql`：

```sql
ALTER TABLE node_runs ADD COLUMN bridge_ack_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE node_runs ADD COLUMN bridge_last_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE bridge_event_receipts (
  node_run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  executor_agent_id TEXT NOT NULL,
  bridge_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  ledger_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (node_run_id, attempt, executor_agent_id, bridge_seq)
);

CREATE TABLE bridge_tool_outbox (
  execution_id TEXT PRIMARY KEY,
  node_run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  tool_seq INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  acked_at TEXT
);
```

消费事务顺序：

1. 校验 schema/attempt/agent/seq。
2. 查 receipt：同 seq 同 payload 直接幂等返回；不同 payload 抛 `BRIDGE_SEQ_CONFLICT`。
3. 开事务：`appendNodeRunEvent()` -> 插 receipt -> 更新 `node_runs.bridge_ack_seq`。
4. 提交。
5. 提交成功后才 `buffer.ack(seq)`。

崩溃窗口：写账本成功、ACK 未返回时，重连按 `bridge_ack_seq` 重放；receipt 命中即幂等，不会重复写账本。

## 7. 工具调用闭环

```text
Agent tool.call
  -> 校验工具名/参数/cwd/超时
  -> 匹配 WorkflowDefinition 授权
  -> 写 tool_call_requested
  -> ReadOnlyToolRunner.runTool()
  -> 记录真实 started_at/finished_at/duration_ns 与强证据
  -> 写 tool_executions 与 tool_finished
  -> outbox 持久化
  -> 回传 Agent
  -> Agent 继续
  -> 最终结构化输出
  -> outputSchema 校验
  -> submitReport()
  -> applyReport()
```

边界：

- Agent 不能通过普通消息改 `node_runs.status`。
- Agent 不能自行声明成功。
- Agent 的 `tool.result` 不能冒充宿主强证据。
- 工具请求必须重新走服务端注册表和授权策略。

## 8. 取消与释放

取消意图与停止结果分开：

1. 收到取消意图，找到 `executor_agent_id`。
2. 调 `BridgeClient.cancel()`。
3. 按四值分支：
   - `interrupted`：立 `timing_out` 围栏，继续 `whenIdle()`。
   - `not_interruptible`：进入 `stopping`，继续观察。
   - `already_stopped`：记录已停止事实。
   - `unknown`：进入 `stopping`/`startup_unknown`，不推断副作用不存在。
4. `whenIdle()` 超时按未确认停止处理。
5. 释放条件：Agent 已确认停止 AND `bridge_last_seq` 已知 AND `bridge_ack_seq >= bridge_last_seq` AND 所有在途工具已结算或明确待核实。
6. 条件满足才 `dispose()`。

HTTP 取消接口不能再凭调用方提交的 `cancelResult` 认定停止；该字段最多作为兼容输入，服务端以 Bridge 观测结果为准。

## 9. 故障注入

新增 `tests/integration/agent-bridge-lifecycle.spec.ts`，至少覆盖：

| 编号 | 场景 | 必须满足 |
| --- | --- | --- |
| B01 | spawn 成功但订阅失败 | 不发任务，不留无法追踪的 Agent |
| B02 | send 成功后服务崩溃 | 重启按持久化 ACK 重放 |
| B03 | 事件 2 跳到 5 | 补齐 3、4 后按 2、3、4、5 消费 |
| B04 | 同一事件重复到达 | 不重复写账本 |
| B05 | 同 seq 不同 payload | 拒绝并留协议冲突证据 |
| B06 | 工具成功、回传前崩溃 | 安全恢复，不盲目重复执行 |
| B07 | 工具执行中取消 | 先验证实际停止，再处理围栏与后续状态 |
| B08 | dispose 时 ACK 落后 | 拒绝释放 Agent |
| B09 | 旧 attempt 事件迟到 | 不污染新 attempt |
| B10 | Agent 断线重连 | 不丢账本已确认游标之后的事件 |

B03、B06、B07 必须做成真实进程/事务级故障注入，不用只测内存函数。

## 10. 实施顺序

1. **R5-A（本文件）**：设计评审，不改 `run-node.ts`。
2. **R5-B**：迁移 008、三游标 Buffer、receipt 幂等、B03/B04/B05；只做事件接收、排序、持久化与恢复，不接 `runNode()`。
3. **R5-C**：AgentLifecycle + BridgeConsumer + EvidenceCollector 接入 `runNode()`，取消/释放闭环，B01/B02/B06/B07/B08/B09/B10。
4. **R5-D**：生产生命周期集成测试、崩溃恢复演练、真实 HTTP 双入口并发复核。
5. **R5-E**：第 45 轮独立审计，新增 Bridge 生产闭环必过项；两份 pass 后按 G1→G2 重签。

## 11. 已拍板的协议边界

1. 宿主事件流采用 `AsyncIterable`：`BridgeEventSource.listen(params, signal)`。`subscribe()` 只做订阅确认，`fetchPage()` 补洞，`AbortSignal` 结束监听。`subscribe` 与 `listen` 之间不得丢事件，宿主必须能从 `fromSeq` 重放；监听器要有界缓冲、断线重连、单消费者。
2. ACK 默认服务端本地持久确认：先校验、查 receipt、在同一 SQLite 事务追加 `node_run_events` + 写 receipt + 推进游标，提交成功后才算确认。`executor.ack` 只作为宿主可选显式确认，绝不允许先 ACK 宿主再写账本。
3. 三游标分别为 `lastReceivedSeq`（收到最大，不持久化）、`lastContiguousSeq`（连续收到最大，不持久化）、`lastPersistedAckSeq`（连续落账并提交最大，持久化）。重启只信 `lastPersistedAckSeq`。
4. 迁移 008 使用 `bridge_event_receipts` 与 `bridge_stream_cursors`，游标按 `(node_run_id, attempt, executor_agent_id)` 隔离，新 attempt 不继承旧游标；同 seq 同 payload_hash 幂等，同 seq 不同 hash 触发协议冲突。
5. 仍待定：outbox 重试上限、保留期与死信处理；工具结果回传失败时节点进入 `blocked_post` 还是可恢复 `stopping`。这两项在 R5-C 前定。

## 12. 验收口径

R5 完成的判据不是 BridgeClient 单测通过，而是：

- 一个节点从 spawn、事件落账、工具执行、结果回传、取消恢复到 dispose，在真实生产路径走通。
- 服务在工具执行成功、结果回传前被强杀，重启后能恢复且不重复执行。
- 事件缺口 2→5 能补齐并按序消费。
- 旧 attempt 事件不能污染新 attempt。
- Agent 的自然语言输出不能直接改账本状态。
