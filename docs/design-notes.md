# dsh-orchestra 编排插件 · 设计思路说明

> 本文件回答「为什么这样设计」，记录**被否掉的方案**和**反复踩的坑**。
> 规则条文在 `orchestra-design-draft.md`；需求与拍板口径在 `requirements.md`；逐轮审计记录在 `orchestra-audit-ledger.md`。
> 写给两类读者：① 三个月后忘了细节的人（看 §2 决策表）；② 接手实现的人（看 §3 坑族与 §5 风险清单）。

---

## 一、总体思路

### 1.1 三层分离

整个插件按三层切，互不越界：

| 层 | 职责 | 落点 |
| --- | --- | --- |
| **事实层** | 记录「发生了什么」：节点状态、决策、事件、证据 | SQLite 账本（`node_run` / `decisions` / `node_run_events` / `report_registry` / `artifacts`） |
| **判定层** | 规则化地决定「下一步去哪」：状态机 + 声明式判定 + 证据门 | §8 迁移表 + §9 判定算子 + §11 证据门 |
| **驱动层** | 推动事情发生：调度、计时器、事件订阅、桥交互 | 服务进程 + 执行桥 |

**为什么这样切**：审计二十轮挖到的错，90% 是「这三层互相越界」造成的——
· 事实层塞派生结论（`last_rejected_report_id` 标量）→ 事实被可 UPDATE 的表绕过 → 改成把状态迁移写进 append-only 链，registry 只做投影。
· 判定层散落在几十个调用点（每个迁移行自己写 schema 校验 / 证据门）→ 迟早有一行漏 → 收成 `applyReport` 单入口。
· 驱动层直接改状态（`run.resumed` 时手工清 `paused_reasons`）→ 出现「标志说 running、实际还有未结算」的窗口 → 改成事务内 `derive_run_state` 重算。

### 1.2 账本是唯一权威

执行态（executor 的 state / whenIdle）用来判断「现在动作还在不在跑」，
但**账**只在账本里。理由：桥缓冲是传输层，会丢、会 spill、会重排；账本只认 append-only 的事实。

### 1.3 一切收口到「单写者 + CAS」

多进程多写是这类系统最常见的病源。做法：
- **进程级**：OS 文件锁 + `service_meta.instance_epoch` 严格递增 fence。
- **行级**：每次迁移是 `UPDATE ... WHERE status=? AND action_generation=? AND report_id=?` 一笔事务。
- **代次**：Ga 挡旧动作的回写，Gr 挡旧计时器。两者分开，是因为它们要挡的东西不同（见 §2.3）。

---

## 二、关键决策与被否方案

> 每条格式：**问题 → 决策 → 理由 → 被否方案 → 留下的代价**。

### 2.1 为什么不用 DSH 原生的 workflowEngine

**问题**：DSH 已有 `ctx.workflowEngine`，能跑多智能体编排脚本，为什么不直接用？

**决策**：本插件**不复用它的 run 控制**，只做两件事——① 面板订阅 `workflow/*` 事件作旁路视图；② 将来若复用，只复用它的 `agent()` 派生子智能体路径（即本插件的 executor 子会话）。

**理由**：两者不是同一种东西。
- 原生 workflowEngine 的 run 是**宿主持有的一次性活对象**（有 cancel / dispose），`workflow/*` 事件明确是 observe-only，**不给运行控制**。
- 它没有持久账本、没有断点续跑、没有人工审批节点、没有等外部事件节点。
- 编排脚本是「一次性的多智能体编排」；本插件要的是「可追溯、可恢复、可裁决的**长任务**」。

**被否方案**：
- ❌ 把编排脚本嵌进节点内部当子流程 —— 这是**第二套状态机**，两本账会漂（第十一轮否掉的「双账本」坑）。
- ❌ 给原生 workflowEngine 打补丁加持久化 —— 改的是别人的核心路径，升级即冲突；且它的 run 生命周期模型（一次性活对象）与我们要的「进程重启后账还在」在架构上冲突。

**留下的代价**：自己造了一套 run / node_run / decision 体系，工作量比「写个脚本」大一个量级。但换来的是：宿主崩了任务还在、重启能续、能等人裁决。

### 2.2 为什么 node_run 是「事实行」，不是「结论行」

**决策**：node_run 只存事实字段（`stopped_at` / `side_effect_verified_none` / `stop_evidence` / `attempt` / 各时钟戳 / `resume_state` / `replacement_node_run_id`…），**不存派生结论**（`is_running` / `has_unverified` / `is_settled` 一律不落行）。

**理由**：派生结论一旦落行就必然漂——写它的那条路径忘了更新，或两条路径各写一次，账上就出现自相矛盾的两行。派生只能在事务里现算。

**被否方案**：❌ 落一个 `pending_effects` 计数列做性能优化 —— 结论会与事实不一致。**改为**：维护**增量计数与部分索引**（按 `run_id + status` 的计数、`pending_irreversible_children` 的增量集合），只更新变化的投影字段。终态 CAS 走轻量摘要（计数 + EXISTS 判定），不触发全量重算。

**留下的代价**：查询要读投影列，写路径要保证「事务内 derive」。性能靠增量索引兜住，但索引维护本身是复杂度。

### 2.3 为什么代次要分两种（Ga / Gr），不能合成一个

**决策**：`action_generation`（Ga）跟动作走，自增点唯一（`leased → dispatched` 派发那笔 CAS）；`rearm_generation`（Gr）跟续期走。回写类迁移带 Ga，其余（定时器 / 裁决 / 恢复 / 引擎判定）带 Gr。

**理由**（这是 §3.4f 第 1 条挖出来的同族第 N 次）：
- 如果合成一个，续期时会把**续期前发出的那条合法迟到回写**判成 STALE_GENERATION 丢掉 → 账上停在 stopping，现实里动作其实已经做完了。
- 如果改成「服务读当前代次」，旧回写每次都匹配 → 栅栏等于没有。

**为什么不能反过来「都带当前代次」**：代次的意义是「让旧的写不进来」。动作代的旧写（上一代动作发的 report）和计时代的旧写（上一轮武装的定时器）是两种不同的旧，堵法必须分开。

**被否方案**：❌ 单代次 —— 上面两种失败模式必中其一。❌ 用时间戳代替代次 —— 并发下时间戳不构成线性化点。

**留下的代价**：每条迁移行都要显式写代次（不许「同上」带过），迁移表因此变长。审计专门为此开了一条规则：**一条迁移一行代次，逐行现想就会漏**。

### 2.4 为什么回写必须走单入口 `applyReport`

**决策**：所有执行器回写（`started → done`、`verifying → done`、`startup_unknown → done`、`stopping → done/failed`）一律调 `applyReport(node_run_id, attempt, report, expected_status, generation, policy)`，内部六步顺序固定：幂等查重 → schema 校验 → 状态代次 CAS → 证据门 → 判定 → 同笔 BEGIN IMMEDIATE 落库。**拒绝也落 `report_registry`（state=rejected）**。

**理由**：分散写「校验 / 判定 / 证据门」时，**迟早有一行漏掉证据门**——尤其人工裁决那条路最容易漏（审计 #9：`stopping → done`（人 confirm_applied）、`indeterminate_side_effect → done`、`blocked_post → done/failed` 三条都没走同一道门）。

**被否方案**：
- ❌ 每行自己写证据门 —— 就是漏的那条路。
- ❌ 用 DB 触发器做 —— 触发器里没法做证据引用校验与 policy 合成判定。

**留下的代价**：`applyReport` 成了关键路径上的单点，必须无 bug 且性能可控。第二十轮又发现它还缺 `attempt`、policy 还由调用方传入 —— 说明这个入口需要持续加固。

### 2.5 为什么证据强弱由「来源」定，不由作者自称

**决策**：`evidence_source ∈ {runTool, tool_result}`；`runTool` 是强证据（宿主只读身份 + 只读挂载，有 OS 级隔离），`tool_result` 是弱证据（只有 allowlist / argv / toolPolicy 约束，进程理论上仍可能写盘）。**irreversible 节点必须有强证据**，宿主无只读挂载 → 加载期 `EVIDENCE_SOURCE_UNAVAILABLE`，**不降级**。

**理由**：如果强弱由作者填，那「弱证据」就是「作者想选弱证据」——闸门和被闸的东西都在作者手里，等于没有闸门。来源是客观事实，引擎能自己判定。

**被否方案**：❌ 加一档 `evidence_trust: high` 让作者声明 —— 同上。❌ 一律要求强证据 —— pure 节点的成本不可接受（要开只读挂载跑命令）。

**留下的代价**：Windows 上只读挂载要靠受限服务账号或 AppContainer，很多环境给不了 → 那些环境直接**禁用 runTool**，而不是降级成弱证据（这是主人能接受的取舍，但要写清楚）。

### 2.6 为什么 capability 要「前向推导」且只许往严写

**决策**：节点前向工具集只含 read_only → `pure`；含 mutating 且有**可执行**补偿描述符 → `compensable`；含 mutating 且无可执行补偿 → `irreversible`。**作者声明只许往更严的一侧写**；往宽写 → 加载期 `SIDE_EFFECT_UNDECLARED`。

**理由**：副作用等级必须由**节点实际能碰到什么**决定，不是由作者说它是什么。这条闸门要盖住全部执行面——tool 节点、agent 的 toolPolicy、任务会话模板的 allow、trigger 适配器、以及 subworkflow 的递归校验——否则任何一处都能绕过。

**被否方案 / 走过的弯路**：
- ❌ 早期版本「含 mutating 即提升为 irreversible，声明 pure / compensable 一律拒」——把带补偿描述符的节点也堵死，补偿机制形同虚设（第二十轮 #10 认定为致命自相矛盾）。
- ❌ 让 `compensating` 工具出现在前向路径 → 它会被当成 mutating，导致补偿动作本身被算进节点副作用等级。

**留下的代价**：规则必须同时区分「补偿工具只许出现在补偿描述符里」（`COMPENSATION_TOOL_IN_FORWARD_PATH`）与「前向 capability 不计补偿工具」两条，读者容易混。

### 2.7 为什么「停止」不等于「结算」

**决策**（第二十轮 #2，认定致命）：
- `succeeded` **只认** `side_effect_verified_none = true` 且带 `stop_evidence`（强证据）这一条。
- `stopped_at` 只证明「动作停了」，**不证明「副作用没发生」**；`stopped_at` 单独存在时**只能支撑 `succeeded_with_unverified`**。
- 人签字、decision 的措辞、人的口述、「executor 后来 idle 了」、动作已停 —— **都不算核实**。

**理由**：把两件事合成一件，会在现实仍可能落刀时把账做平。写操作「成功退出」不代表它写对了东西；同理「动作停了」不代表它没改世界。

**被否方案**：❌ `stopped_at OR side_effect_verified_none` 判据（一度这么写）——这就是「把两件事当一件」的经典错误。❌ 签字即视为核实 —— 签字只是人接下后果，不是验证。

**留下的代价**：多出 `succeeded_with_unverified` / `failed_with_unverified` 两个终态，面板与 API 都必须显式显示，不能折进 succeeded / failed。

### 2.8 为什么 run 落终态前要跑「结果判定三条」

**决策**（第二十轮 #3）：run 落终态前按序取第一条命中：
1. 有失败类子节点（failed / timeout / failed_with_unverified）→ run 只能落 `failed` 或 `failed_with_unverified`；
2. 有未被替换的 `orphaned` 子节点 → run 只能落 `orphaned` 或留在 paused；
3. 全部子节点 done（或已核实无副作用的放弃）→ 才允许 `succeeded`。

**理由**：失败 / timeout / orphaned **都是节点终态**，照样满足「无非终态 node_run」，run 却会因此落 succeeded —— 账假收口。**节点终态 ≠ run 可以成功**。

**被否方案**：❌ 只查「没有非终态 node_run」——审计把这句标为「最容易被低估的风险」。

**留下的代价**：三条判定要在同一笔事务里跑，且顺序不可调；run 迁移表与判定要同事务写回。

### 2.9 为什么半态必须有自己的钟，且离开必须清钟

**决策**：
- 启动层只一个 `startup_timeout`（默认 60 秒）；未知态只一个 `unknown_watchdog`（默认 120 秒）；`verifying` 有自己的 `verify_timeout`（默认 120 秒）；`timing_out` 有 30 秒宽限。
- 桥断时钟矩阵（唯一权威）：startup_timeout 继续走、unknown_watchdog 暂停并累计、action_deadline 继续走、verify_timeout 暂停并累计、timing_out 宽限暂停不累计、桥断预算继续走并累计。**每次桥断事件各自计、各自清零，不跨事件累加**。
- 离开半态的每条出口都显式清钟（`startup_unknown_deadline_at IS NULL`、`verify_started_at IS NULL AND verify_deadline_at IS NULL`）。

**理由**：
- 一个半态没有自己的钟 → 节点能永远挂在 verifying 拖住 run。
- 一个半态有两个钟 → 同一时刻两个预算各算各的，到底生成哪条 decision 没法定。
- 离开半态不清钟 → 节点靠一个没人看的过期时钟被再次推走。
- 桥恢复重置启动计时 → 桥一抖就给「可能根本没开跑」的节点续命，等于让它永远停在等待里。

**被否方案**：❌ 桥断累计不清零（一度如此）→ 多次短桥断会累计成永久超预算。❌ 恢复时统一 `now + 120s` → 恢复了还想再等一轮，又是一种续命。

**留下的代价**：每个钟都要写清「起钟 / 到点 / 离开清钟 / 桥断行为」四要素，桥断时钟矩阵成了必须逐行核的表。

### 2.10 为什么 `continue_wait` 不是「结论」

**决策**（第二十轮 #5）：`continue_wait` **不是** approved 行的 resolution，而是对 `pending` / `acknowledged` 行**追加一条 revision**、行状态保持不变；不经过 approved，因此不触发「结论落地即 closed」。

**理由**：早期版本两套口径并存——一边允许 `approved → pending（reopened）`，一边要求「结论落地即 closed」。前者让「已批准」的语义复活成「还在等」，后者又会把刚点「继续等」的行立刻关掉。两套只留一套。

**被否方案**：❌ `approved → pending（reopened）` —— 与 closed 规则互斥。

**留下的代价**：§3.4 清单里那条旧规则（`decision 迁移表补 approved → pending（reopened）`）还在历史清单中未标废弃，需要在 §3.4k 收口时统一口径。

### 2.11 为什么桥是「业务通道」，不是「保活通道」

**决策**：桥断有两种含义，要分开处理——
- 业务通道断 = **客户端走了**（executor 那边没人了）；
- 保活通道断 = **宿主没了**（整个 DSH 进程走了）。

**理由**：这两件事的处置完全不同。把它们混成一种「桥断」，就会出现「宿主被强杀后服务占着锁不让下次启动」这类死锁（第一段 §1.2 挖出来的生命周期三件事混成一件）。

**留下的代价**：要两条通道、两种退出语义（drain / host_gone）、`ORCHESTRA_ALREADY_RUNNING` 三条保证（退出前释放锁、OS 强杀自动释放、先读 `service.state` pid 再决定接管）。

### 2.12 为什么 confirm_not_started 之后不能 reattach 旧 executor

**决策**：裁决为「确认没开跑」→ **dispose 旧 executor**，重试走**新 attempt + 新 executor**。「后来确认已开跑再 reattach」**不再是退路**。

**理由**：dispose 之后已无可 reattach 的对象。这条是显式的取舍：选了「没开跑」这条路，就把 reattach 这条路关掉。

**代价**：如果人判断错了（其实开跑了却裁了没开跑），只能靠 `report_contradicted` 那条道——旧 attempt 的迟到 report 到达时节点挂起等人定夺，新 attempt 不许先跑。这条通道必须实打实存在（第二十轮 #8 要求给它挂起态、resolution 与过期规则）。

### 2.13 为什么 run 用三组派生标志，不用单个 enum

**决策**：`running`（有活动节点）、`paused_reasons`（集合）、`settling`（还有未结算的 irreversible 子节点）。对外投影是 `display_status` + `reasons[]`。

**理由**：一个 parallel run 既可能有未结算的 irreversible 子节点（settling）又有等裁决的 decision（paused）——单 enum 表达不了。派生优先级写死：**终态 > blocked > settling > running**；blocked 优先于 settling，但 settling 标记仍保留（不能因为在等裁决就让人看不见还有未结算的不可逆动作）。

**被否方案**：❌ 单 enum —— 表达不了并行场景。❌ 手工置位 reason —— 一定会漂。

**留下的代价**：`derive_run_state` 必须在每次涉及 run 的迁移里同事务调用，性能靠增量计数兜住（见 §2.2）。

### 2.14 为什么 decision 唯一键要用 partial unique index

**决策**：写死两条 DDL——
```sql
CREATE UNIQUE INDEX decisions_run_kind_uq  ON decisions(run_id, kind)      WHERE node_run_id IS NULL;
CREATE UNIQUE INDEX decisions_node_kind_uq ON decisions(node_run_id, kind) WHERE node_run_id IS NOT NULL;
```

**理由**：SQLite 普通 UNIQUE 允许多个 NULL 并存（两行 NULL 不算重复）→ run 级唯一键形同虚设。run 级与 node 级各管各的，NULL 与非 NULL 互不干扰。

**附带的 DDL 缺口（第二十轮 #12 未修）**：`report_registry` 的 `report_id` 唯一键目前只在正文里写了「锁死」，§14 存储索引里没有对应的 `UNIQUE` / `CREATE UNIQUE INDEX` → 数据库层并不拒重复 report。

### 2.15 为什么账本只做「非对抗性校验」

**决策**：哈希链写进 append-only 的 `node_run_events`（`prev_hash` 链 + HMAC 签名）。措辞明确**降级**：不声称防篡改——同用户同权限可读密钥。真正的边界是不给任务会话与 executor 读写 storages 目录的工具（deny 规则），降低绕过概率而非杜绝。

**理由**：早期稿子声称「账本防篡改」，被审计驳回——因为 HMAC 密钥在同一用户权限下可读。**降级措辞比夸大能力安全**：调用方会按实际强度设计防线。

**留下的代价**：面板要同时显示「声明状态」与「已验证证据」，让人能看出哪些只是自报。

### 2.16 为什么上下文预算要写进设计

**决策**：任务会话只存目标、计划、产物引用；节点在 executor 子会话跑；回传有界 payload（默认 64KB，超限截断并记录）；每条 node_run 记 token 与压缩次数；超预算滚动摘要。raw payload 不进带工具权限的 agent。

**理由**：编排插件自己就是「上下文占用」的大户 —— 记忆索引块每轮注入 3,836 字符就能反复打断前缀缓存（见另一条记忆 `mem_wbumcae_e934e528` 记录的 800 次请求账本）。**自己设计的系统不能犯自己已经诊断过的病**。

---

## 三、审计二十轮挖出的「坑族」

> 这一节是本文件最有价值的部分。二十轮审计不是白做的：错反复以不同面目出现。认得脸，才不会再上钩。

### 3.1 第一坑族：把两件事当成一件

| 两件事 | 被当成 | 后果 |
| --- | --- | --- |
| 「我宣告它超时了」 vs 「它真的停了」 | 一件 | 不可中断的动作被自己的围栏判死；动作还在跑，节点却收不到任何回写，一路拖到 indeterminate |
| 插件卸载 / 宿主退出 / 服务存活 | 一件 | 重载插件顺手停了服务；宿主被强杀后服务占着锁不让下次启动 |
| 「动作还在跑」 vs 「动作已经停了」 | 一件 | 把前者塞进后者专用格（blocked_post / indeterminate），账上先收口，现实里那把刀还在落 |
| 「没观测到」 vs 「没发生」 | 一件 | 引擎自动重试一个可能已经开跑的不可逆动作 —— 账上干净，副作用再来一次 |
| 「签了字」 vs 「副作用已结算」 | 一件 | 一笔没验证的副作用从清单里消失 |

**规律**：超时、生命周期、状态归属、观测、签字 —— 每一次都要问「这里其实是几件事？」。

### 3.2 第二坑族：同一份清单抄多处

- node_run 终态集合散在 §2 / §7 / §8 / §14 → 改一处忘一处就漂 → **终态集合只写一份，其它章节只引用**。
- `cancel_result` 四取值只在 §1.1 写着，§3 与 §8 各说各的 → **全文统一口径**。
- 迁移类型 → 代次矩阵不写死，就逐行现想 → 漏一条就有一行不带代次 → **矩阵写死 + 逐行归族**。

**规律**：清单不是「写一次就完」，是「必须只有一个出处」。

### 3.3 第三坑族：散落的入口与跳过的门

- 回写散在几十行 → 迟早有一行漏证据门 → **单入口 `applyReport`**。
- 人工裁决那条路最容易漏证据门（审计 #9 一次点出三条）→ **裁决也必须走同一道 `evaluateEvidence`**。
- policy 由调用方传入 → 调用方传宽松 policy → **policy 由服务端按 `node_run_id + workflow_version` 从不可变模板加载**（第二十轮 #9 要求，尚未修完）。

### 3.4 第四坑族：半态没有自己的东西

- 半态没有钟 → 永远挂着拖住 run。
- 半态有两个钟 → 同一刻不知生成哪条 decision。
- 半态迁出不清钟 → 靠没人看的过期时钟被再次推走。
- 桥断期间钟不暂停也不续 → 桥一抖就续命，或恢复即误判过期 → **桥断时钟矩阵**。

### 3.5 第五坑族：终态的语义混淆

- `orphaned` 起初不在终态集合 → run 永远收不了尾 → 补进终态集合。
- 补进终态集合后，「终态」与「可以修正」混了：`abandoned_unverified` 有出边、`orphaned` 有自环挂账 → **终态 ≠ 不可再挂账**（挂账走 `replacement_node_run_id`，旧行不迁出）。
- 失败 / timeout / orphaned 都是终态 → run 的「无非终态 node_run」形同虚设 → **run 级结果判定三条**。

### 3.6 收敛判据（审计不是数条目的）

台账 §三 定死三条（防止「审得越多越不算数」）：
1. 致命项归零；
2. 每一处「口径」在全文只有一处出处（可 grep 验证）；
3. 每条迁移行都能生成一个用例（`(from, to, condition, CAS)`）。

**教训**：审到第 20 轮时致命项数量没降，说明改法没落到「口径唯一」这一层，只是加了新规则。

---

## 四、三个参考项目各学了什么

> 三份都在 `references/` 下，已用 codebase-memory 建图谱，定位表见根目录 `codebasemap.md`。

### 4.1 dsh-superagent-prototype（DeepSeek 官方研究原型）

**学到的**：
- **ticket 是一等公民**：所有待办都有独立卡（`ticketCard` / `decisionCard` / `threadCard`）——对应本插件的 decision 行与「面板显示待裁决数」。
- **决策与环境分离**：`src/app/execution-environment.ts` 的 `executionRoot` / `ticketEnvironment` / `environmentOf` 把「谁来跑、在哪跑」独立成层——对应本插件的 executor 会话 + `owner_epoch`。
- **交接策略显式**：`src/app/context.ts` 的 `handoffPolicy` 把「上下文交给谁」写成策略——对应本插件的 §17「任务会话与引擎事件来源分离」。
- **通知队列独立成簇**（cluster 82：`readStream` / `pollNotifications` / `readNotified` / `gate`）——对应本插件的 outbox + cursor/ack。

**没照抄的**：原型是「研究原型」，没有持久账本、没有断点续跑、没有证据门；本插件的严格标准是主人 R6 定的，不能降级。

### 4.2 DS-Bot（多端 IM bot 成品）

**学到的**：
- **记忆层是产品级模块**（cluster 264：`memoryRestore` / `memoryLayer` / `reviewBatch`）——本插件第五段「记忆插件对接」可以直接对标它的分层与复核批处理思路。
- **工具单元测试规模**：`ds-bot/test/` 100+ 文件、`memory.test.js` 160KB、`group-work.test.js` 99KB——提醒：**状态机项目必须逐行生成用例**，这正是我们验收标准 5.1 第 2 条。
- **浏览器来源与 cookie 收割的边界**（`allowedNavigation` / `requestAllowed` / `locksProfile`）——对应本插件 §1.1 的「只读身份 + 注册表 allowlist + 不过 shell」思路。
- **分组协作**（group-work）——对应 parallel / wait 节点的现实语义。

**没照抄的**：DS-Bot 的实现语言（JavaScript）与部署形态（独立 app + docker）与 DSH 插件不同；只取架构思路，不取代码。

### 4.3 pi-harnessmm（重点：提升效率与降低 token 消耗）

**主借鉴点**：
- **用便宜的快速选择器替代一次昂贵的慢推理**：慢 CoT 在 `<CHISEL_PLAN>` 里预先写好「参数已确定」的后续动作库，fast selector 只在公共 receipt 上选一个已声明候选；选不出就回慢推理。省的是「再一次慢调用」的 token，不是省掉推理本身。
- **快路径必须真的更省才走**：`admit` 用 `fastUpper = byteUpper(SELECTOR_SYSTEM) + byteUpper(compactState) + 1 + 128` 估快路径开销，`fastUpper * 4 > prior.median_tokens` 就拒绝（`fast_cost_above_quarter_of_slow`）——快路径成本超过慢调用中位数的四分之一，就不值得替换。对应本插件的 token 记账与预算门槛。
- **压缩的是上下文，不是动作语义**：`compactMessages` 在慢上下文里剥掉 `<CHISEL_PLAN>`，原件按 toolCall id 存起来；`projectionBinding` 用 hash 校验剥离前后 toolCall 不变。对应本插件「raw payload 不进带工具权限的 agent」「压缩后动作语义必须保持」。
- **选择器只看最小状态**：`compactState` 只给任务 id、receipt hash、候选动作、guard 结果、schema，不喂完整历史；`slowTokensOf` 用上一笔慢调用的 `usage.totalTokens` 作节省基线。对应本插件的有界 payload 与上下文预算。

**次要参考**：四件套分层（harness + 消息投影 + 准入 + 收据）、`actionType` 的动作分类、`hash` 热点、`policy` 的 load/validate 分离、`terminal` 的进程树终止——这些是实现骨架与边界，不是主借鉴点。

**没照抄的**：它是单进程 harness，没有持久账本与多写者问题；它的 `fastUpper` 是 UTF-8 字节上界，不是实测 token，不能直接当本插件的预算判据。

---

## 五、风险清单（接手实现时先看这个）

| 风险 | 表现 | 缓解 |
| --- | --- | --- |
| 迁移表闭合性 | 某个状态没有出边，节点永远挂着 | 每条迁移行生成用例；状态机是「验收用例」本身 |
| 幂等键不统一 | 同一补偿被执行两次 | `compensation_id` 统一算式；同键不重复执行 |
| 证据门被绕过 | 人工裁决落 succeeded 但没有强证据 | 裁决也走 `evaluateEvidence`（**第二十轮 #9 尚未修完**） |
| `report_id` 无 DB 级唯一约束 | 重复 report 被收两遍 | §14 补 `CREATE UNIQUE INDEX`（**第二十轮 #12 尚未修完**） |
| capability 规则自相矛盾 | 带补偿描述符的节点加载不进 | 删掉「mutating 只能 irreversible」；写死前向三值（**第二十轮 #10 尚未修完**） |
| `report_contradicted` 无挂起态 | 迟到 report 撞裁决 → 旧 attempt 的 report 释放掉新 attempt | 给它挂起态 + resolution + 「过期不释放」规则（**第二十轮 #8 尚未修完**） |
| `already_stopped` 无目标行 | 取消时发现已停 → 无处可去 | 补目标行；dispose 前置改为「该 attempt 已收口」（**第二十轮 #11 尚未修完**） |
| `derive_run_state` 全表扫 | 并行扇出时平方级变慢 | 增量计数 + 部分索引；N=100/1000 规模测试 |
| 桥断累计不清零 | 多次短桥断 → 永久超预算 | 每次桥断事件各自计、各自清零 |
| 证据强度退化 | 宿主无只读挂载 → 悄悄用弱证据 | 加载期拒（`EVIDENCE_SOURCE_UNAVAILABLE`），不降级 |

---

## 六、下一步（第四段已过，第五段初稿已写）

1. **第四段已收口**：v33（1528 行）在第三十四轮拿到 pass（0 致命 / 0 重大 / 4 条非阻断措辞），第四段闸门已开。
2. **第五段：记忆插件对接 memory-audit-v1**：v34 初稿已写（5.1–5.14，Q-43–Q-56），先单独送审；没 pass 前不写第六段。
3. **第六段：分阶段落地与验收**：第五段 pass 后再写。
4. 六段全过后写 `docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md`、自审、提交 git、交主人审阅，再转 writing-plans。
