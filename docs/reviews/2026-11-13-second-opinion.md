我重新检查了你更新后的 GitHub `main` 分支。这次的变化比较明显，而且不是简单补几个 Bug：你已经开始把此前的架构建议真正落实到生产装配、运行时和数据层了。

我重点对比了上次的基线 `b42a479` 和最新 HEAD `f01581c`，中间增加了 **74 个提交**，检查了新增代码、迁移文件、测试和最近两轮独立审计报告。

我的结论是：

# **这轮更新有实质性进步**

架构完整性

明显改善

安全边界

关键问题已有修复

单节点生产路径

基本打通，仍需加固

Agent 桥接

仍未真正闭环

发布验收

尚未重新过门

我认为，现在已经从单纯的架构骨架进入实际运行机制建设阶段。

不过，我发现还有几个值得认真处理的问题。其中两个涉及系统设计本身，而不只是代码质量。

# **一、这轮有哪些改进真正做对了？**

先说值得肯定的地方。

## **1. 工具授权绕过：已经有了正确的修复**

文件：

[src/executor/tools.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/executor/tools.ts?utm_source=chatgpt.com)

你新增了：

```
assertToolsAuthorized(
  registry,
  policy,
  p.tools
)
```

并且在 `runNode()` 中：

- 从工作流定义加载工具授权。
- 执行前逐一验证实际工具。
- allow 必须包含实际执行的工具。
- deny 优先级高于 allow。
- 未注册的工具直接拒绝。

这是正确的修复方式。

尤其是你没有简单地在 HTTP 层限制请求，而是把授权检查放到了执行边界。

这样，即使有人绕开面板，直接调用服务端接口，也不能随便增加工具。

这项基本认可

## **2. 单写者与 Epoch：架构终于接上了**

文件：

- [src/index.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/index.ts?utm_source=chatgpt.com)
- [src/infra/db/open.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/infra/db/open.ts?utm_source=chatgpt.com)
- [src/infra/lock.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/infra/lock.ts?utm_source=chatgpt.com)

现在的启动顺序变为：

```
acquireDbLock
      ↓
bumpEpoch
      ↓
openServiceDb
      ↓
createOrchestra
      ↓
hydrate
      ↓
startServer
```

这个变化非常重要。

之前的设计是有文件锁和 Epoch 的概念，但生产装配没有使用。

现在 `createOrchestra()` 还增加了内部锁凭证限制，外部不能随意绕过 `openServiceOrchestra()` 创建服务实例。

我认可这个方向。

不过，建议继续保留真正的双进程故障注入：旧进程暂停、新进程取得所有权、旧进程恢复并尝试提交事务，必须得到 `STALE_GENERATION`。

## **3. 工作流定义持久化：跨重启能力有了进展**

文件：

[src/service/workflows.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/service/workflows.ts?utm_source=chatgpt.com)

你新增了：

- `workflow_versions` 表。
- `definitionHashOf()`。
- `hydrate()`。
- `WORKFLOW_VERSION_IMMUTABLE`。
- Run 与工作流定义哈希绑定。

这修复了之前最明显的内存 Map 丢失问题。

尤其是服务重启后恢复定义的设计是必要的。

但这里还存在一个我后面会详细说明的隐患：**数据库里不允许修改，不代表内存中的定义也真的不可修改。**

## **4. 租约和时钟管理有了真正的生命周期**

文件：

- [src/executor/run-node.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/executor/run-node.ts?utm_source=chatgpt.com)
- [src/core/clock.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/core/clock.ts?utm_source=chatgpt.com)
- [src/service/sweep.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/service/sweep.ts?utm_source=chatgpt.com)

这次增加的内容包括：

- 执行期间自动续租。
- 续租失败记录 `lease_lost`。
- 使用单调时钟计算动作耗时。
- verifying 阶段独立维护截止时间。
- 墙钟漂移时进入不确定状态。
- 服务启动后定期执行 Sweep。

特别是你把时钟不确定和任务真正超时区分开了。

这符合你的系统原则：

**没有观测到，不等于没有发生。**

## **5. 证据门比以前更扎实**

文件：

[src/service/commands/apply-report.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/service/commands/apply-report.ts?utm_source=chatgpt.com)

这是另一个很有价值的变化。

现在不只是检查：

```
evidence.source === 'run_tool'
```

还增加了：

- `tool_executions` 记录。
- `tool_finished` 事件。
- commandHash 对账。
- stdoutHash / stderrHash 对账。
- 工具失败阻止 done。
- `required_hashes` 核验。

这样，客户端单纯伪造一份 `run_tool` JSON，已经不足以通过生产收口路径。

这是从相信 Agent 自述，向服务端核实执行事实迈进了一步。

# **二、目前我发现的 6 个需要处理的问题**

以下按照我建议的修复优先级排列。

## **P0：审计门仍然没有形成干净的放行状态**

需要优先处理

这是目前最重要的发布问题。

我检查了：

- [S1 第二十八轮审计](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/docs/audits/S1-independent-audit-round28.md?utm_source=chatgpt.com)
- [S2 第三十三轮审计](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/docs/audits/S2-independent-audit-round33.md?utm_source=chatgpt.com)
- [S1 第二十八轮整改记录](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/docs/audits/S1-round28-response.md?utm_source=chatgpt.com)
- [S2 第三十三轮整改记录](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/docs/audits/S2-round33-response.md?utm_source=chatgpt.com)

此前两轮审计分别发现：

| 审计        | 原始结果 | 问题             |
| ----------- | -------- | ---------------- |
| S1 Round 28 | fail     | 4 类 P0、2 类 P1 |
| S2 Round 33 | fail     | 5 类 P0          |

这次你已经针对它们做了整改，包括：

- 否定谓词与计数识别。
- 部分通过和待办识别。
- 六层嵌套 Markdown 隐藏定义。
- 历史审计结论与当前轮结论区分。
- 新增正式回归用例。

这些修改方向正确。

但是，目前还不能把 G1/G2 视为最新 HEAD 已通过。

根据最新 `handoff.md` 的验证记录：

**最新记录的测试情况**

# **424 / 438**

全量测试通过数量

通过 424

失败 14

记录中说明，14 条失败均与 G1 预签态的 `audit_report_sha256` 不匹配有关，并非本轮新增解析器回归。

此外，当前 G1/G2 文件中的 pass 和批准记录仍然是以前签署的记录，handoff 明确表示尚未在最新整改候选上重签。

### **具体修复指导**

建议按这个顺序进行：

1. 在最新 HEAD `f01581c` 上重新派发 S1 和 S2 独立审计。
2. 审计者使用独立临时克隆，不允许修改主仓。
3. 两份审计均通过后，重新生成证据和 GateArtifact。
4. 重新签署 G1、G2。
5. 运行完整测试、两个门检查及构建。
6. 所有结果绑定同一个最终 commit SHA。

这里还有一个更深层的问题：

**不要继续依靠不断扩展正则表达式来决定审计是否通过。**

从 Round 28、Round 33 的问题可以看出，你的 `gate-check.ts` 已经承受了大量自然语言攻击变体。

目前依靠词表、分句、历史句剥离等办法，仍然会遇到新的表达方式。

我建议未来改为：

```
{
  "gate": "G2",
  "audit_round": 34,
  "candidate_sha": "具体提交 SHA",
  "conclusion": "fail",
  "p0": 2,
  "p1": 0,
  "p2": 3,
  "must_pass_total": 19,
  "must_pass": 18,
  "failed_items": ["G2-07"],
  "audit_report_sha256": "..."
}
```

这应该是机器判定的权威输入。

规则直接变成：

```
conclusion 必须为 pass
P0 必须为 0
P1 必须为 0
must_pass 必须全部通过
candidate_sha 必须与当前候选匹配
所有证据必须通过哈希核验
```

自然语言报告负责解释，结构化结果负责放行。

你现在的词法解析器仍然可以作为第二道防线，而不应该继续承担唯一的裁决职责。

## **P1：Agent Bridge 仍然没有真正接入生产执行路径**

架构核心问题

这是我最希望你继续关注的地方。

参考：

- [src/executor/run-node.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/executor/run-node.ts?utm_source=chatgpt.com)
- [src/executor/bridge.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/executor/bridge.ts?utm_source=chatgpt.com)
- [src/service/dispatcher.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/service/dispatcher.ts?utm_source=chatgpt.com)

虽然你已经有：

```
HTTP
  ↓
createRun
  ↓
dispatchRun
  ↓
runNode
  ↓
applyReport
```

但是，我再次检查了 `runNode()`。

目前核心执行依然是：

```
const agent = await createExecutorAgent(...)

for (const tool of p.tools) {
  const out = await deps.runner.runTool(...)
}
```

这里没有真正调用：

- `BridgeClient.spawn()`
- `BridgeClient.subscribe()`
- `BridgeClient.send()`
- `BridgeClient.state()`
- `BridgeClient.fetchPage()`
- `BridgeClient.dispose()`

换句话说，你现在已经有一个真实的单节点服务执行路径，但它仍然是由外部 Tool Runner 直接执行命令，而不是由 Agent 通过 Bridge 驱动工具和任务。

你新增的 `tests/production-path.spec.ts` 是有价值的，但其中的 Agent 和 HostRunner 仍然是 Mock。

所以还不能把它理解成真正的 DSH Agent 全生命周期测试。

### **建议如何修复**

我建议把执行器改造成三个明确的模块：

```
AgentLifecycle
    ↓
BridgeEventConsumer
    ↓
EvidenceCollector
```

职责如下：

| 模块                | 职责                                 |
| ------------------- | ------------------------------------ |
| AgentLifecycle      | 创建、订阅、发送指令、取消、等待停止 |
| BridgeEventConsumer | 消费事件、维护 seq、断号重取、恢复   |
| EvidenceCollector   | 将可信工具回执写入工具执行表和账本   |

真正的执行路径应该是：

```
获取租约
   ↓
spawn Agent
   ↓
subscribe
   ↓
send 指令
   ↓
接收 Agent 事件
   ↓
tool.start
   ↓
宿主执行工具
   ↓
tool.result
   ↓
持久化执行痕迹
   ↓
校验证据
   ↓
ApplyReport
   ↓
dispose
```

这里最重要的两个要求：

**第一，桥事件确认必须晚于账本持久化。**

不能先 ACK，再写入数据库，否则服务在两个步骤之间崩溃就可能丢事件。

**第二，dispose 必须晚于所有事件确认。**

继续保留你已经实现的：

```
serviceAckSeq >= bridgeLastSeq
```

但必须让它成为真正的生产生命周期约束。

建议这项列为 S3 的正式准入条件，不要只作为未来优化。

## **P1：WorkflowCatalog 的不可变性还不彻底**

文件：

[src/service/workflows.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/service/workflows.ts?utm_source=chatgpt.com)

我发现一个比较隐蔽的问题。

你现在的 `load()` 大致是：

```
const hash = definitionHashOf(def)

this.remember(key, def)

if (this.db && !persisted) {
  withTx(this.db, (tx) => {
    tx.run('INSERT INTO workflow_versions ...')
  })
}
```

存在两个问题。

**问题 A：内存引用仍然可以被外部修改。**

你直接把调用方传来的 `def` 存到 Map 里。

例如：

```
const definition = {
  workflow_version: '1',
  nodes: [
    {
      node_id: 'check',
      type: 'agent',
      tools: { allow: ['ro.echo'] }
    }
  ]
}

catalog.load(definition)

// 加载完成后修改原始对象
definition.nodes[0].tools.allow.push('ro.rm')
```

因为 Map 保存的是同一个对象引用，内部工作流定义也可能被改变。

数据库里的 JSON 和 hash 仍然保持原样，但内存中的授权已经变了。

这直接破坏了不可变定义的设计目标。

**问题 B：先写内存，再写数据库。**

如果数据库事务失败，`remember()` 已经执行，加载操作对外虽然报错，内存中却留下了未经成功持久化的定义。

### **修复指导**

建议修改为：

```
const json = canonicalJson(def)
const snapshot = JSON.parse(json) as WorkflowDefinition

assertDefinitionAllowed(snapshot, this.phase)

const hash = definitionHashOf(snapshot)

// 先完成持久化事务
if (this.db && !persisted) {
  withTx(this.db, (tx) => {
    tx.run(
      'INSERT INTO workflow_versions ...',
      [...]
    )
  })
}

// 事务成功后才更新内存
this.remember(key, deepFreeze(snapshot))
```

另外，`get()` 最好返回只读副本，而不是直接暴露内部对象。

**建议增加三个测试：**

- 修改原始输入对象，已加载定义不能变化。
- 修改 `get()` 返回对象，内部定义不能变化。
- 人为让数据库 INSERT 失败，Catalog 内存中不能留下该版本。

还有一个设计层面的问题：

当前 `workflow_versions` 使用：

```
version TEXT PRIMARY KEY
```

而 `WorkflowDefinition` 也只有 `workflow_version`，没有 `workflow_id`。

如果将来允许多个独立工作流分别使用版本 `1`，就会发生全局版本号冲突。

我建议 S4 的持久化模型使用：

```
PRIMARY KEY (workflow_id, version)
```

Run 同时绑定这两个字段和 Definition Hash。

## **P1：同一个工具不能在一次节点执行中重复执行**

文件：

[src/infra/sqlite/migrations/003_s2_round3.sql](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/infra/sqlite/migrations/003_s2_round3.sql?utm_source=chatgpt.com)

这是我这次发现的一个具体实现缺陷。

当前表结构：

```
PRIMARY KEY (node_run_id, attempt, tool)
```

意味着同一个 node_run、同一次 attempt 中，同名工具只能插入一次。

但 `runNode()` 允许：

```
tools: [
  { command: 'ro.echo', ... },
  { command: 'ro.echo', ... }
]
```

第一次执行成功后，第二次执行会触发主键冲突。

然后异常会进入工具执行失败处理。

这意味着正常的重复工具调用可能让节点被错误阻塞。

### **修复指导**

建议新增 `execution_id` 或 `tool_seq`，让每次工具执行都有自己的唯一身份。

例如：

```
PRIMARY KEY (
  node_run_id,
  attempt,
  tool_seq
)
```

同时：

```
execution_id TEXT NOT NULL UNIQUE
```

并让 `tool_started`、`tool_finished`、证据回执统一绑定这个 execution_id。

需要新增迁移，不能直接修改已有的 003。

修复成本不高，但建议进入下一次数据库迁移

## **P1：HTTP 入参校验和执行并发控制还不够严格**

文件：

- [src/service/server.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/service/server.ts?utm_source=chatgpt.com)
- [src/service/write-queue.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/service/write-queue.ts?utm_source=chatgpt.com)
- [orchestra.config.json](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/orchestra.config.json?utm_source=chatgpt.com)

你已经有 Zod 依赖，但是 HTTP 路由仍然大量使用：

```
requireFields(...)
Number(body.leaseTtlMs)
String(body.nodeRunId)
```

这只是字段存在性检查，不是完整的数据结构校验。

例如客户端可以提交：

```
{
  "nodeRunId": "n1",
  "leaseTtlMs": -1000,
  "leaseRenewIntervalMs": 0
}
```

或者提交非法类型、超大时间值、畸形 tools 对象。

尤其是 `leaseRenewIntervalMs`，如果变成 0，定时器可能以接近 1ms 的频率执行续租，造成严重的数据库写入压力。

### **修复指导**

给每条命令定义独立的 Zod Schema。

例如：

```
const leaseSchema = z.object({
  nodeRunId: z.string().min(1),
  ownerEpoch: z.number().int().nonnegative(),
  leaseTtlMs: z.number().int().min(1000).max(120000),
  leaseRenewIntervalMs: z.number().int().min(100).max(40000)
}).superRefine((v, ctx) => {
  if (v.leaseRenewIntervalMs >= v.leaseTtlMs / 2) {
    ctx.addIssue({
      code: 'custom',
      path: ['leaseRenewIntervalMs'],
      message: '续租间隔过长'
    })
  }
})
```

还要考虑另外一个问题：

当前 `WriteQueue.run()` 是增加 pending 计数后直接执行函数，并不是 FIFO 串行队列。

而 `/v1/runs/dispatch` 会在 `queue.run()` 内执行整个异步工作流。

这意味着多个请求可以同时启动很长时间的任务。

你的配置中有：

```
"execution": {
  "concurrency": 3
}
```

但我没有看到这个配置真正限制 Dispatcher 的执行并发。

建议：

- WriteQueue 只管理短时间的数据库写操作和背压。
- 单独增加 ExecutionScheduler。
- Scheduler 真正执行并发限制。
- 配置中的 concurrency、human_slots 接入实际调度。
- Agent 执行不能占用一个所谓的全局写队列位置直到任务结束。

## **P1：node_run_events 没有数据库级别的只追加保护**

文件：

- [src/infra/sqlite/migrations/005_append_only_events.sql](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/infra/sqlite/migrations/005_append_only_events.sql?utm_source=chatgpt.com)
- [src/infra/db/ledger.ts](https://github.com/theBeautifulIce/dsh-orchestra/blob/main/src/infra/db/ledger.ts?utm_source=chatgpt.com)

我注意到 005 迁移只保护了：

```
events
```

没有保护：

```
node_run_events
```

而后者恰恰是你最重要的 HMAC 哈希链。

另外，当前 `verifyLedger()` 是通过：

```
SELECT DISTINCT node_run_id
FROM node_run_events
```

找到所有已有链，再逐条校验。

如果某个节点的事件链被整个删除，它就不会出现在这个查询结果里。

因此，现有校验不能证明每个 node_run 的事件链都完整存在。

### **修复指导**

下一次迁移建议：

```
CREATE TRIGGER trg_node_run_events_no_update
BEFORE UPDATE ON node_run_events
BEGIN
  SELECT RAISE(ABORT, 'node_run_events 只追加');
END;

CREATE TRIGGER trg_node_run_events_no_delete
BEFORE DELETE ON node_run_events
BEGIN
  SELECT RAISE(ABORT, 'node_run_events 只追加');
END;
```

然后进一步加强完整性校验：

- 遍历所有 node_runs，而不只是已有事件的节点。
- 记录每个节点最后一条事件的 seq 和 hash。
- 校验事件数量和最后一个链头是否一致。
- 增加尾部删除、全链删除、截断、篡改测试。

这可以避免普通程序故障或误操作造成账本不完整。

# **三、目前整体架构，我建议形成这样的结构**

你现在已经有了不错的内核，我不建议大规模重构。

但接下来应该把模块间的边界进一步固定下来。

**Core Brain / Workflow Engine**

全局决策、工作流规则、依赖和调度策略

**Scheduler**

DAG、并发、依赖

**Decision Engine**

审批、裁决、策略

**Execution Runtime**

Lease Manager / State Machine / Cancellation / Recovery

**Agent Bridge**

Agent 生命周期与事件流

**Tool Runtime**

授权、工具执行、沙箱

**Evidence Store**

客观执行证据

**SQLite Ledger**

唯一权威事实

面板、外部插件和观察者都从账本及其派生投影读取状态。

特别注意：Evidence Store 和 Ledger 不应该混为一体。

原始产物、工具执行回执可以独立保存，Ledger 负责持久化其身份、哈希、状态迁移和引用关系。

这样未来才有能力处理大型文件和长期执行任务。

# **四、我建议你的修复路线**

现在最重要的不是继续增加节点类型，而是让已有功能经得住反例。

**第一批：S2 收口前必须完成**

阻断放行

- 最新 HEAD 上重新进行 S1、S2 独立审计
- 修复并验证 14 条 G1 预签态失败
- 结构化审计结果替代单纯自然语言裁决
- 工具执行重复调用的唯一性问题
- WorkflowCatalog 深拷贝与不可变快照
- HTTP 输入 Schema 和时间参数边界

**第二批：S3 核心执行能力**

架构重点

- Bridge 真正接入 runNode
- 事件 ACK、断号重取与恢复
- Agent 启动失败与取消全生命周期
- Scheduler 并发限制
- DAG 依赖调度
- Run 级状态聚合

**第三批：S4–S6 完善**

后续演进

- workflow_id + version 复合身份
- Decision / Inbox
- Compensation
- node_run_events 完整性保护
- 多节点压力测试
- 长时间服务恢复测试
- UI 和跨插件控制入口

# **五、我还建议增加一组特别重要的故障注入测试**

我觉得你的项目应该把故障恢复测试提高到与状态机单元测试同等重要的地位。

下面这些场景比普通的成功路径测试更有价值。

| 故障场景                             | 必须验证的结果             |
| ------------------------------------ | -------------------------- |
| Agent 创建后服务崩溃                 | 重启后能够判定真实执行状态 |
| 工具执行中取消                       | 不能提前宣布任务已经停止   |
| tool.start 已收到但 tool.result 丢失 | 通过序号补取完整事件       |
| 工具执行两次且其中一次失败           | 不允许只保留成功记录       |
| 两个相同工具在一个节点中执行         | 不发生主键冲突             |
| 心跳时数据库不可用                   | 租约丢失必须被正确记录     |
| WorkflowCatalog 写库失败             | 内存不得留下半成功定义     |
| 事件链尾部被删除                     | 完整性校验必须发现         |
| 两个进程争夺同一个数据库             | 只能存在一个有效写者       |
| 多个 Run 同时提交                    | 不破坏状态唯一性和账本顺序 |

# **六、最终评价**

我认为，这轮更新最有价值的变化是三个：

1. 你开始把安全约束从文档搬进真正的执行边界。
2. 你开始把持久化、恢复和租约机制纳入完整运行生命周期。
3. 你开始使用真实服务入口组织端到端测试，而不是只测试孤立函数。

但我也想提醒你：

**现在最容易出现的风险，是继续通过不断增加代码和审计轮次来获得安全感，却没有形成稳定、结构化的验收机制。**

你已经在 Round 28、Round 33 看到了这个问题：自然语言审计解析器不断被新的表达方式挑战。

我建议将「机器可验证的审计结果」作为一个独立架构改进，不要再把它当成一个普通的正则修复任务。

另外，Agent Bridge 是你整套系统与普通工作流工具最大的区别之一。它真正完成之前，不建议将当前单节点执行路径宣传为完整的跨 Agent 编排闭环。

**我的建议：先冻结 S3 功能扩展，修复上面列出的 S2 收口问题，重新通过独立审计和双门验收，再正式进入多节点状态机。**

这会比现在继续扩展功能更稳，也能避免后续 S3、S4 建立在尚未完全可靠的底座上。