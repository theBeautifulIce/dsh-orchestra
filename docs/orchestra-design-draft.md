# dsh-orchestra 设计草案

状态：第一、二段第三轮通过；第三段 v23 已按第二十五轮审计通过（0 致命、0 重大、3 条非阻断措辞）；第三段三条措辞已在 v24 清理。本文件为 v27：第四段「面板与查询」已按第二十六轮（2 致命、9 重大、7 措辞）、第二十七轮（2 致命、4 重大、3 措辞）与第二十八轮（0 致命、1 重大；两阶段确认与 inbox 幂等未接上）修完，送第二十九轮；本版不新增状态、迁移、decision kind、终态或证据门，只补读模型字段、存储落点与命令确认绑定。

## 第一段 骨架与落点

一句话定位：dsh-orchestra 是流程的账房兼调度台，不是执行者，也不是真相的唯一来源。

**四层。**

一、引擎层（独立进程 orchestra-service）：确定性状态机，只做三件事——判定能不能推进、记下走到哪、指出卡在哪。不碰正文、不碰模型、不执行工具、不做外部验证。

**为什么是独立进程**：DSH 插件上下文是 cordis fiber，插件 ctx 上的服务、监听、定时器随卸载清理，没有「自己常驻」这回事。所以引擎跑成独立进程（单 profile 单实例），认 profile 目录、自持 DB 的 OS 级独占锁、自带 start / stop / health 与优雅退出。

二、存储层（服务进程独占）：自建 SQLite，主表 workflows / tasks / runs / node_runs，辅助表 decisions / events / artifacts / inbox / leases / report_registry（被挡回写的幂等账，report_id 唯一键）。定位：跨工作流查询与审计账本，不是执行态的权威；执行态以 DSH 的会话与 agent 存储为准，账本定期对账。库在 `<profileDir>\storages\dsh-orchestra\orchestra.db`，按 profile 隔离。

三、执行层（留在 DSH 宿主里）：一个任务一条具名会话（1:1，sessionId 落 tasks 表，面板可跳转），这条会话只承接目标、汇总事件、把结论报给人。节点作业不在这条会话里跑：引擎为每条 node_run 创建执行子智能体（executor），记 executor_session_id / executor_agent_id。

**任务会话默认不给工具。** 它是个协调位，不是干活的手：默认工具集为空（最多留只读查询与汇报通道），人想让它动手，要么在主聊天里说，要么新开一个 run 走正式节点。原因是它一旦带工具，人在会话里说「帮我改一下这个」它就会用工具去改——引擎状态没变，可文件和外部世界变了，账本记不住这笔。若某个工作流模板确实要任务会话带工具，就在节点模板里显式声明 allow / deny，并把**任务会话的工具调用记进 run 事件**（面板可见），让它在账上留痕。storages 目录的读写一律 deny，这一层是硬边界。**任务会话的 allow 同样受 capability 门禁**：allow 里出现 mutating 工具 → 该模板加载期 SIDE_EFFECT_UNDECLARED，任务会话只能带只读工具。

四、接入层：我的工具面、记忆插件的审计服务、侧栏面板，三路都只跟服务说话，谁都不直接写库。

主聊天不在这四层里。它是派活与汇报的一端，不是执行载体。

### 1.1 服务与宿主之间的桥

服务是独立进程，但**执行能力在 DSH 宿主里**。插件在加载时注册一组内部 RPC，服务只通过它们操作宿主，不直接持 ctx。

**执行类 RPC**

| RPC | 作用 | 关键约定 |
| --- | --- | --- |
| `executor.spawn({nodeRunId, attempt, input, outputSchema, toolPolicy})` | 建 executor，返回 sessionId / agentId | 返回时订阅已生效，且 executor 处于「待指令」态，不会自己开跑 |
| `executor.subscribe({executorAgentId, attempt, fromSeq})` | 订阅事件流，返回首个 seq | 桥端每 executor 有事件缓冲，支持按 fromSeq 重放 |
| `executor.send({executorAgentId, attempt, instruction, attemptId})` | 投递调度指令 | **必须在 subscribe 确认之后调用**，桥内串行化保证顺序 |
| `executor.cancel({executorAgentId, reason})` | 请求中止当前工作 | 只发中止信号，不销毁会话、不注销、不删 session；**返回 cancel_result**：interrupted（动作真停了）/ not_interruptible（动作还在跑）/ already_stopped / unknown（回执不明，保守按 not_interruptible 处理）。**cancel_result 决定下一步迁移**：interrupted 才允许立围栏进 timing_out；not_interruptible / unknown 一律不立围栏，改进 stopping（§3） |
| `executor.dispose({executorAgentId, reason})` | 销毁 executor（归档后） | **该 attempt 已收口或已确定不再使用时**才调用（节点进终态，或该 attempt 的重试/收口已落库；`confirm_not_started` 走新 attempt 时，旧 executor 的收口落库即可 dispose，不必等节点终态）；**前置条件 `service_ack_seq >= bridge_last_seq`**——不满足就先等 ack，或把未 ack 的事件先落库再归档；归档时强制清空该 executor 的桥缓冲 |
| `executor.state({executorAgentId})` | loaded / unloaded / deleted / running / idle，**外加两个事实**：`tool_call_seq`（本 attempt 已发出的工具调用序号）与 `has_tool_call`（是否已发出过任何 tool.call） | 删除与加载分离；**这两个事实用来回答「模型有没有发出过工具调用」**——没有它们，引擎分不清「动作没开跑」和「动作开跑了但我们没观测到」，启动层就只能靠猜（§3 启动层） |
| `executor.whenIdle({executorAgentId, timeoutMs})` | 等当前轮结束 | 与 cancel 配套使用，不销毁现场；**可能永久不返回**（不可中断动作）——所以它**必须**带超时用，超时按「未确认停止」处理（走 timing_out → stopping，不得判 indeterminate_side_effect，见 §3），不配正确性用 |
| `executor.events.subscribe` 事件类型 | `step`、`turn`、`tool.call`、`tool.start`、`tool.result` | `tool.start` 带 tool_start_at（工具真正开跑的时刻，跟模型发出调用的时刻不是一回事）；`tool.result` 含 command、exitCode、stdout/stderr 哈希、产物文件哈希 |

顺序保证：`spawn` 返回即订阅已生效（桥内部先建缓冲再返回），`send` 排在 `subscribe` 之后；桥断线重连时，插件用 `fromSeq` 重放，**桥断期间的事件不丢**（缓冲保留到 executor 归档）。

**桥是业务通道，不是保活通道。** 插件持有的这条 RPC 桥随插件卸载而断开——服务不能拿它判断宿主死活，否则「插件被卸载」和「宿主被强杀」会混成同一件事。宿主与服务之间的保活是**另一条通道**：由宿主启动服务时直接建立、由宿主侧持有，不经插件，插件卸载动不了它。**业务通道断 = 客户端走了；保活通道断 = 宿主没了。**

**桥缓冲是传输层，不是账本**：服务按 `fromSeq` 确认（ack）之后，桥就可以丢这段缓冲；executor 归档（dispose）时强制清空，且 dispose 的前置条件是 `service_ack_seq >= bridge_last_seq`——未 ack 的 `tool.result` 先落库再归档，不许先丢。旧 attempt 的证据不靠桥缓冲保管——它落在服务自己的 `node_run_events` / `artifacts` / `tool.result` 里，保留期「run 终态 + 180 天」，与通用 `events` 分开算（见 §16）。**桥缓冲有上限、有背压**：每个 executor 的缓冲设字节上限（默认 8MB）与高水位（默认 4MB）；到高水位桥端暂停读取（背压，让 executor 的输出管道憋住、等下游跟上），到上限允许落盘 spill（临时文件）但**不许丢证据**——服务恢复后按 seq 重放，spill 文件在归档前先落库。缓冲与 spill 的总量受同一上限约束；dispose 前必须先落库再清空。

三组用例：spawn 后立刻产生 step（不漏）；桥断 3 秒重连后事件按 seq 补齐；重试后旧 attempt 的迟到事件带旧 attempt 号，桥与服务都丢弃。

**验证类 RPC**：`executor.runTool({command, args, cwd, timeoutMs})` —— 让宿主用**只读身份**跑一条固定命令，把 command / exitCode / stdout 哈希 / stderr 哈希 / 文件哈希作为 evidence 直接回给服务，**不经 verifier 转述**。verifier 是模型，它可以解释但不能作证。这条通道产出的是**强证据**（宿主级只读隔离），跟模型侧 tool.result 那种弱证据不是一回事，§11 按强弱分级。

runTool 的边界写死（它是一个新的宿主执行面，必须比「只读身份」四个字更具体）：

- **命令来自注册表枚举**，不是自由文本；`command` 必须是注册表里的键，取不到直接拒。
- **args 是数组，逐项按 schema 校验**，不经 shell 解析——没有 `;`、没有管道、没有重定向、没有反引号。
- **cwd 限定在任务工作区**，越界即拒（canonical 路径比较）。
- **只读身份是具体机制**：受限令牌 + 工作区只读挂载（Windows 上用受限服务账号或 AppContainer；不支持只读挂载的环境则禁用 runTool，而不是降级成普通权限）。
- **与 tool_runner 共用同一套命令 allowlist 与 argv 约束**（§3.2 三）。
- **落库前再校验一次**：evidence 里的命令哈希必须与 policy 声明一致，否则判 UNSUPPORTED。

`requiredCommands` 里带 `;`、管道或重定向的写法，加载期即报错；运行期若 argv 里出现 shell 元字符，拒执行。

### 1.2 生命周期的三种退出

| 情形 | 服务 | executor | 不可逆节点 |
| --- | --- | --- | --- |
| 插件重载 / UI 重挂 | 留着，不动 | 留着，跑着的继续跑；桥断开后按 fromSeq 重连重放 | 不受影响 |
| 宿主退出 | 正常退出走 drain；强杀走 host_gone | 不硬杀；到强制收尾时未收口的标 indeterminate_side_effect | 标 indeterminate_side_effect，等下次启动人工裁决 |
| 服务崩溃 | 由服务自带的 supervisor 进程拉起（同 profile），拉起后立刻 sweep | 崩溃时已失联的按 sweep 判定 | 同样按 indeterminate_side_effect 处理 |

**三个生命周期必须分开：插件的加载周期、宿主的退出、服务自己的存活。** 混起来就会出现「插件卸载顺手把服务停了」——插件卸载只是客户端断连，服务照旧；宿主退出才是停服务的时候。

**插件卸载：只断连，不 drain。** 卸载钩子做三件事：关掉桥连接、撤掉面板订阅、把通知投递目标暂时挂起（服务继续跑，事件照常写账，插件回来后按 cursor 补齐）。**不做 drain、不杀 executor、不抢锁、不删 endpoint/secret。** 理由：服务归 profile 管，不归插件加载周期管；插件会被热重载、会被 UI 重挂，按插件卸载停服务，等于把「重载插件」变成「中断所有在跑的任务」。真要停服务，走 profile 关闭流程。

**宿主退出要有可观测信号，不能靠猜。** 两条通道并行：
- **通道一（正常退出）**：DSH 的 profile 关闭流程调 `service.requestDrain()`，服务按固定顺序 drain：拒新请求 → 等当前节点收口（限时）→ 撤 cron → 删除 endpoint/secret 与 service.state → 关 DB 释放锁 → 退出。
- **通道二（强杀 / 崩溃）**：服务与 DSH 之间保持一条 duplex pipe，**这条管道由宿主启动服务时直接建立、由宿主侧持有，不经插件**（插件的 RPC 桥是业务通道，插件卸载会断它，但那不是宿主死亡）。管道断开才判定宿主已死——业务通道断而保活通道在，服务照旧跑（插件只是走了）；保活通道断才是 host_gone。宿主已死时不再等未收口节点（executor 随宿主一起没了），直接把未收口的不可逆节点标 indeterminate_side_effect、run 进 paused、生成 decision，等下次启动人工裁决；然后释放锁并退出，不留孤儿进程占着 DB 锁。
- 兜底：Windows 上服务可挂进 DSH 进程的 Job Object（KILL_ON_JOB_CLOSE）做强制收尾；不依赖它也能靠管道断开收口。

**watchdog 不能住在插件里**——插件一卸载就没人拉起服务了。守护职责归**服务自带的 supervisor 进程**：服务启动时一并拉起（或由 profile 启动器拉起）supervisor，supervisor 只做一件事——服务异常退出时按退避策略把它拉起，拉起后立刻 sweep。插件只做观察者与客户端。

**不要让下一次启动撞 ORCHESTRA_ALREADY_RUNNING**。三条保证：①服务退出前一定释放 OS 锁（正常 drain 与 host_gone 都释放）；②进程被强杀时 OS 自动释放文件锁；③新服务启动先读 profile 目录 service.state 里的 pid——pid 还活着就连接它（不抢锁、不拉起第二个），pid 已死或文件陈旧才接管并清理残留。交接顺序与 §1.3 相同。

### 1.3 控制面：认证、发现与交接

- 服务启动时在 profile 目录写 `orchestra.endpoint`（命名管道优先，回退 127.0.0.1 随机端口）与 `orchestra.secret`（随机 token，文件 ACL 限当前用户可读）。
- 插件加载时读这两个文件，校验 token 后发 `hello{protocolVersion}`；版本不匹配 → 插件请求服务 graceful stop 并重启新版本，不做半兼容。
- 服务只接受当前用户 SID 的连接，拒绝其他本机进程；所有请求带 token 与 protocolVersion。
- **交接顺序固定**（补 blocker）：profile 级 `service.state` 文件记 pid / endpoint / secret / state（starting / ready / draining），用原子 rename 写入并配文件锁。

  - drain 顺序：**拒新请求 → 等当前节点 → 撤 cron → 删除 endpoint/secret 与 service.state → 关 DB 释放锁 → 退出**。
  - 新服务**先拿 DB 锁，再写 endpoint/secret/service.state**；拿不到锁就退避重试，不抢。
  - watchdog 把 `ORCHESTRA_ALREADY_RUNNING` 当「旧服务还在」，退避后重连，**不当作失败反复拉起**。

用例：drain 中 health 失败 → watchdog 退避不抢跑；旧服务释放锁后 1 秒新服务启动 → 交接顺序保证插件不会连到旧服务。

## 第二段 把「硬」落成规则

**1. 执行单元**：node_run 字段（**schema_version = 1**；表结构变更走 schema_version 加迁移脚本，不许直接改列）——run_id、node_id、seq（节点在 run 内的拓扑序号，来自工作流版本的 node 顺序；同一 node_id 的多个 attempt 共用同一个 seq；只用于稳定排序，不参与 CAS）、attempt、parent_node_run_id、executor_session_id、executor_agent_id、verifier_agent_id、verifier_session_id、owner_epoch、lease_id、queued_at、dispatched_at、claimed_started_at、started_at、tool_start_at、deadline_at、action_deadline_at、cancel_requested_at、cancel_result、wait_extensions、action_generation、rearm_generation、stopped_at（动作被独立确认停止的时刻；abandoned_unverified 侧靠它落「已确认停止」这个事实，见 §8 第六条）、last_heartbeat_at、resume_state、resume_at、startup_state、startup_unknown_deadline_at（**统一 unknown_watchdog 的到期时刻**，节点级默认 120 秒；startup_unknown 两支与桥断预算共用这一个钟，见本节第 2 条）、unknown_reason（这个钟是哪一支点亮的：startup_deadline / bridge_absence / none；同一 tick 只许一个原因占位，桥断优先）、startup_unknown_paused_at（节点被挂到 paused_bridge_missing 时记下的暂停时刻，用于恢复时还原原钟的到期点）、bridge_absence_accumulated（**本次桥断事件的累计秒数**：每次桥断事件开始时清零，桥断期间逐秒累计；桥恢复时清零，下一次桥断从头计——**不跨桥断事件累加**，免得几次短桥断把预算吃成永久超预算；清零语义唯一，见 §3 桥断时钟矩阵）、bridge_down_since（本次桥断的起始时刻，恢复时清空）、verify_timeout（verifying 态的验证时限，节点级可配，默认 120 秒）、verify_started_at、verify_deadline_at、indeterminate_side_effect、side_effect_verified_none（证据核实到副作用没生效，true / false）、stop_evidence（独立确认停止所依据的证据引用：evidence_id 或确认来源）、origin_node_run_id（本行由哪一行重投而来；与旧行的 replacement_node_run_id 成对，重投链靠这两个指针重建）、replacement_node_run_id（旧行被新 attempt 取代后接上的新 node_run 的 id；**重投一律新建行、旧行落 `superseded` 终态**——orphaned 重投与 confirm_not_started / confirm_not_applied 的重试都只在这条边上记指针，旧行只读、不迁出，见 §8 的 `superseded` 与 `（建）→ queued` 重试行）、compensation_id（该 node_run 上补偿动作的幂等键：hash(node_run_id + attempt + descriptor_version)）。**节点行只存事实，不存派生结论**——settling / pending / reasons[] / display_status 一律由 `derive_run_state` 现算（§8）。**node_run 的终态集合只在 §8 写一份，这里不另列清单**（§2 / §7 / §9 / §11 / §14 一律引用 §8）。

**2. 所有权、排队与计时**：三层分工写死。

- **OS 锁 = 进程级 owner**。
- **instance_epoch = 进程内 fence**：抬升全局 epoch 与抬升所有活跃行的 owner_epoch / lease_id 在同一笔写事务里完成；每一笔写都在 WHERE 带 instance_epoch（不满足即 STALE_EPOCH），所有写强制 `BEGIN IMMEDIATE`；**insert 也校验 epoch**（旧 epoch 不能插新行）。**epoch 的持久化来源**：服务自带的 `service_meta` 表存 `instance_epoch`，启动时读出旧值 +1 写回（跨重启严格递增，绝不复用）；交接时新服务先读旧值再 +1，所以旧进程即使还活着也写不进新账。insert 的校验写成确定性的：同一笔事务里 `SELECT value FROM service_meta WHERE key='instance_epoch'` 与调用方传入的 epoch 比对，不一致 → STALE_EPOCH。
- **行级 CAS = 线性化点**：node_run 用 `node_run_id + attempt + lease_id + 状态`；runs 与 decisions 各自带 revision。**跨行的并发（run 终态 vs decision 过期、run 终态 vs 子节点回写）必须有单一事务的线性化点**，不能各写各的：决策收口与 run 终态判定放在**同一笔事务**里——先 `UPDATE decisions SET ... WHERE decision_id = ? AND revision = ? AND status IN (...)`，受影响行数为 0 即冲突（重读后再判，不得覆盖他人结论）；再在同一事务里 `UPDATE runs SET ... WHERE run_id = ? AND revision = ?` 并检查派生条件（paused_reasons 空、settling=false、pending_irreversible_children 空，无非终态 node_run）。SQLite 单写者 + run 级 revision 递增 = 跨行线性化；用例必须写成同一事务内的两条写，而不是两次独立提交。

排队：超出并发上限（默认 3，另留一个人工位）的 node_run 进 queued，记 queued_at；FIFO + 每任务配额，溢出有背压。排队等待不走启动超时。

**启动层只有一个计时器**：`startup_timeout`（节点级可配，默认 60 秒），从 dispatched_at 起算。它到点只表示「等不到 tool.start 事件」，**不等于「动作没开跑」**（§3）。这一层不再另设 `never_started` 的第二套 60 秒——同一个 dispatched 节点只跑这一个计时器，谁先写、超时后进哪一格由 §3 的判定顺序唯一确定。

**未知态只留一个钟：`unknown_watchdog`。** 启动层「等不到 tool.start」与桥断累计**共用这一个 120 秒的看门狗预算**（节点级可配，落点是 `startup_unknown_deadline_at`），不再有第二个 120 秒预算——两个同刻的钟会让「到底该生成哪条 decision」没有唯一答案。**两者共用的是预算值与 decision 唯一键，不是同时各走一个钟**：桥可用期间只走 watchdog、`bridge_absence_accumulated` 恒为 0；桥断期间 watchdog 停走（清空 `startup_unknown_deadline_at`、记 `startup_unknown_paused_at`），只走 `bridge_absence_accumulated`——同一时刻只有一个时间基在走，所以不存在两个钟各触发一次。哪一支点的灯靠 `unknown_reason` 记（`startup_deadline` / `bridge_absence` / `none`）：**桥断优先，同一 tick 只生成一条 startup_unknown decision**，`unknown_reason` 一旦写入就不许被另一支覆盖。桥断单独记账用 `bridge_down_since`（本次桥断起点）与 `bridge_absence_accumulated`（**本次桥断事件的累计秒数**——**清零语义唯一，不许第二套**：每次桥断事件开始时清零，桥断期间逐秒累计，桥恢复时清零，**下一次桥断从头计，不跨桥断事件累加**；「恢复不清零、跨多次累加」那条旧写法作废，见 §3 桥断时钟矩阵）。

**桥断不重置启动计时**：paused_bridge_missing 恢复时**不许**把 `startup_timeout` 重新起算——桥一抖就给启动层续命，等于让一个可能根本没开跑的节点永远停在等待里。**本次桥断累计超预算**（`bridge_absence_accumulated` 超过 unknown_watchdog 的预算，默认 120 秒；**按单次桥断事件计，恢复即清零**，见 §3 桥断时钟矩阵）→ 节点不再等桥，**处置只有一条：留在 `paused_bridge_missing`，只生成一条 decision**——**桥断期间不许把任何节点迁进 `startup_unknown`**（事实查不到，迁进去立刻又撞上「桥断 → paused_bridge_missing」，只会来回打转）。**decision 的 kind 按桥断前的状态定**：dispatched / started / startup_unknown → `startup_unknown`（`unknown_reason = bridge_absence`）；stopping / verifying / timing_out → `action_overrun` / `verify_human` / `action_overrun`，并**保留原来的 action_deadline_at**，不许因为桥断就把动作时限清掉。**同一次桥断事件只生成一条**：`startup_unknown` 以 `decisions_node_kind_uq ON decisions(node_run_id, kind) WHERE node_run_id IS NOT NULL` 去重（`unknown_reason` 只是行上标记，不进唯一键），重复 tick 只递增 decision 行的 `revision`，不新增第二行；run 级 kind 沿用 `decisions_run_kind_uq`。桥恢复后按 `resume_state` 重入，`unknown_reason` 保留到下一次钟被重写。**恢复时的时钟纪律**：桥恢复**不许**重置 `startup_unknown_deadline_at`（不许用恢复给未知态续命），但若该字段为空（从未写过，或被某个出口清空后没补写），恢复时**补写**——按 `startup_unknown_paused_at + 120 秒` 还原原钟的到期点，连 `startup_unknown_paused_at` 也没有时（该节点从没有过 deadline）才补写 now + 120 秒，并在同一笔 CAS 里 `rearm_generation` Gr+1：**空钟不是无限钟**。**桥断期间每个钟各自怎么走、恢复后怎么处理，必须有一张表写死**（不许各处现想），见下面的桥断时钟矩阵。

**桥断时钟矩阵（桥断期间每个钟怎么走、恢复后怎么处理，唯一权威；§7 sweep 与 §8 迁移表一律引用本表）**：

| 钟 | 落点字段 | 桥断期间的行为 | 恢复后的处理 |
| --- | --- | --- | --- |
| 启动层 `startup_timeout`（默认 60 秒，从 dispatched_at 起算） | `dispatched_at` + 固定 60 秒 | **继续走**（不因桥断暂停，也不因桥断重置——桥抖不给启动层续命） | **立即判定**：已过期就按启动层到点判——**先查 `executor.state`**（桥已恢复，能查就按事实分派）；只有事实仍不明才进 `startup_unknown`，**不许凭「桥断过」直接迁入**，也不许重起计时 |
| `unknown_watchdog`（默认 120 秒，落点 `startup_unknown_deadline_at`） | `startup_unknown_deadline_at` | **暂停**：迁到 `paused_bridge_missing` 时时钟停走并清空该字段，记 `startup_unknown_paused_at = now`；**累计只记在 `bridge_absence_accumulated` 这一个地方**，本字段不再累加（钟暂停，桥预算接管） | **按暂停时长补时**：恢复时按 `startup_unknown_paused_at + 120 秒` 还原原钟到期点；连 `startup_unknown_paused_at` 也没有才补 now + 120 秒并 Gr+1（**空钟不是无限钟**） |
| 动作层 `action_deadline_at` | `action_deadline_at` | **继续走**（动作可能还在跑，时限不许因桥断被清掉或顺延） | **立即判定**：已到点就生成对应 decision（action_overrun / verify_human），不许靠桥恢复重新武装；未到点才重新武装，并在同一笔 CAS 里 Gr+1 |
| 验证窗 `verify_timeout`（默认 120 秒，落点 `verify_deadline_at`） | `verify_started_at` / `verify_deadline_at` | **暂停并累计**：验证窗口停走（桥断期间拿不到 verdict）；桥断时长计入本次桥断预算 | **按暂停时长补时**：恢复时 `verify_started_at = now`、`verify_deadline_at = now + verify_timeout + 本次桥断时长`（把停走的那段补回来）；补完后已过期就立即按 verify_timeout 到点判（`blocked_post` / `failed` / `failed_with_unverified`，见 §8） |
| `timing_out` 的 30 秒宽限（等 `whenIdle` 回执的窗口） | `timing_out` 态 + `cancel_requested_at` | **暂停不累计**：围栏已立、cancel 已发，宽限等的是 `whenIdle` 回执；桥断期间拿不到回执，宽限窗不算流逝 | **重置**：恢复后重连 → 补一次 cancel → 重新起 30 秒宽限与 `whenIdle` 超时；`whenIdle` 超时按「未确认停止」走 `stopping`（不判 indeterminate_side_effect），并重放被挡下的 report |
| 桥断预算（`bridge_absence_accumulated` 对 `unknown_watchdog` 的 120 秒预算） | `bridge_absence_accumulated` / `bridge_down_since` | **继续走并累计**（桥断期间只有它、启动层与动作层在走；watchdog 停走）：本次桥断秒数逐秒累加进 `bridge_absence_accumulated`（**清零语义唯一：每次桥断事件开始时清零、恢复时清零，不跨桥断事件累加**） | **立即判定**：本次累计超 120 秒 → **节点留在 `paused_bridge_missing`**，只生成一条 decision（kind 按桥断前状态：dispatched / started / startup_unknown → `startup_unknown` 且 `unknown_reason = bridge_absence`；stopping / verifying / timing_out → `action_overrun` / `verify_human` / `action_overrun`，保留 `action_deadline_at`），**不迁 `startup_unknown`**；同一次桥断只生成一条（见 §3 唯一键）。未超 → 正常按 `resume_state` 重入。**判定完清零**，下一次桥断从头计 |

**这张矩阵的用法**：桥断期间的每个判定都查这张表，不许各处现想；§7 的 sweep 表与 §8 迁移表里 `→ paused_bridge_missing` 与 `paused_bridge_missing → 各态` 两行的钟口径一律引用本表。**反复抖桥不会给节点无限续命**——`startup_timeout` 与 `action_deadline_at` 在桥断期间照走（矩阵里「继续走」那两行），到点即判；桥断预算只是「等桥等多久」的额度，不是「等多久都有人管」。

**3. 回写与超时的线性化**：report 的 CAS 除状态外还带 `AND now <= effective_deadline_at`（`effective_deadline_at` = 有 `action_deadline_at` 就用它，否则用 `deadline_at`）。**唯独节点停在 `stopping` 时这一条放宽**：此时节点仍由 executor 掌控，迟到完成是自然收口路径，CAS 只看 `status=stopping AND action_generation = Ga`，不再受 deadline 约束——否则过了上限的 report 一律落空，最核心的收口路径被自己的规则关掉（§3.4e 第 2 条）。**围栏已立（timing_out）时收到的 report 不丢**：服务把它登记进 **report_registry**（`report_registry(node_run_id, attempt, seq, report_id, state, rejected_at, replayed_at, applied_at)`，`report_id` 唯一键锁死，另有索引 `(node_run_id, attempt, state)`，`state ∈ {rejected, replayed, applied, stale}`）并写进 node_run_events——**被挡下的 report 一律排队，不许覆盖**（后到的 report 进队，不顶掉队头），等围栏被撤销（timing_out → stopping）时由服务**按队头重放一次**（同一 report_id 只许重放一次，重放后 state 记 replayed；一旦被接受即记 applied，永久不再重放）。**registry 的覆盖面不止围栏**：`startup_unknown` 与 `abandoned_unverified` 这两格也会收到迟到 report（人先裁决、节点已迁出，report 才到；或节点停在本格而 decision 已落地），同样入队记账（state=rejected）——**节点已迁出时只留账、不重放**（重放会写到不相干的 attempt 上），节点仍停在同一格且围栏已撤销时才按队头重放；落败的 report 一律入队，不许无处可去。**report_registry 是被挡回写的唯一来源**：node_run 上不再挂 `last_rejected_report_id` 标量——同一个事实记在两处，两处迟早各说各话（旧 attempt 的队头会把当前 attempt 挡住）；**重放只取当前 attempt 的队头**（seq 最小且 state=rejected），旧 attempt 的记录标 `stale`，不许它插队。**查重、应用与标 applied 在同一笔 `BEGIN IMMEDIATE` 里做完**：registry 的状态条件更新（rejected → replayed → applied）+ 节点 CAS + node_run_events 追加同事务提交；正常接受的 report 也写一条 `report_applied` 事件，**report_id 作幂等键覆盖这两条路径**——崩在事务中间时，同一 report 不会被收第二次。让那条被挡下的自然完成照样收口——否则围栏一立，动作后来真做完了，账上永远收不到；没有这张幂等账，重放一次会被当成新回写收第二遍（§3.4g 第 2 条）。**registry 只是投影**：它不是独立真相——rejected / replayed / applied 三类状态迁移各自追加进 node_run_events 的哈希链，重放前先验链（§11）。

**回写只有一个入口：`applyReport(node_run_id, attempt, report, expected_status, generation, decision?)`。** 第 6 个参数 `decision` **只在裁决驱动的收口上传**（`confirm_applied` / `confirm_not_applied` / `uphold_report`），形如 `{decision_id, revision, resolution}`；函数凭它区分「report 自然到达」与「人裁了 uphold_report 才接受」，并在同一笔事务里 CAS `decisions` 行。普通回写不传。§8 的五组回写边（started → done、stopping → done / failed、verifying → done / failed、startup_unknown → done / failed、indeterminate_side_effect → done / failed 的 uphold_report 支）**只调它**，不许各写一套校验——「同一 applyReport 验证路径」这句话必须落到一个函数签名上，否则超时表会被绕开。**`policy` 不在参数里**：函数内部按 `node_run_id → run.workflow_version → 不可变模板` 载入节点的 `verification_policy` 与 `evidence_source`，调用方没有传入口，也就没有绕法；人工裁决走同一个 `evaluateEvidence(policy, evidence)`。签名与内部顺序写死：
- `expected_status`：该边允许的来源状态白名单，不在名单里直接拒（STALE_STATUS）——每条边各传自己的白名单，调用方不许放宽。
- `attempt`：**本次回写属于哪一次尝试**——report 自带 attempt（回写工具每次回写都带上自己看到的 attempt，与 Ga 一样由服务在动作启动时写进 node_run）；服务比对当前 attempt，不一致 → STALE_ATTEMPT（旧一轮尝试发出的 report 不算数）。**attempt 与 Ga 成对使用**：attempt 挡「哪一次尝试」、Ga 挡「这一代动作」，两者都要进 CAS（回写三元组见下条）。
- `generation`：回写类迁移带 **Ga**（`action_generation`）；服务比对当前 Ga，不一致 → STALE_GENERATION。
- `decision`（可选）：裁决驱动的收口才传；函数内先 `UPDATE decisions SET ... WHERE decision_id = ? AND revision = ? AND status IN ('pending','acknowledged','blocked_for_human')`，受影响行数为 0 → `DECISION_REVISION_CONFLICT`（节点格不动）；随后才做节点 CAS，两笔在同一事务里。
- `policy`（**内部加载，不是参数**）：先按 `node_run_id → run.workflow_version → 不可变模板` 读出 `verification_policy` 与 `evidence_source`，再调 `evaluateEvidence(policy, evidence)`——**证据门在函数内部判，调用方没有传参口**（irreversible 必须强证据、产物哈希覆盖 `requiredHashes`）。人工裁决分两类，不许混：**对副作用的裁决**（`confirm_applied` / `confirm_not_applied`）**必须调同一个 `evaluateEvidence` 并拿到 `evidence_id` 才准迁移**，不许在裁决路径上手写一遍判定；**对开跑事实的证言**（`confirm_started_attested`）**豁免证据门**——人证的是「我看见它开跑」，这是状态事实、不是验证证据，只记 `attestation_id` 与 `action_start_source=human_attested`，**不写 `evidence_id`、也不进 `evaluateEvidence` 的入参**（M-09 锁死）。
- 内部固定顺序：① 幂等查重（report_id）→ ② schema 校验 → ③ 状态与代次 CAS（**status + attempt + generation 三样一起比**，任一不匹配即拒）→ ④ 证据门（内部载入 policy 后调 `evaluateEvidence`） → ⑤ 判定规则求值 → ⑥ 落库（节点行 CAS + report_registry 标 applied + node_run_events 追加 `report_applied`，同一笔 `BEGIN IMMEDIATE`）。
- 返回 `ApplyResult { accepted, reason?, next_status?, registry_state }`；**拒绝也必须落账**（进 report_registry，state=rejected），不许静默丢。

**迟到的 report 与人的裁决冲突时，不许只留账**：旧 attempt 的迟到 report 若与 `confirm_not_started`（人确认没开跑）冲突——人判了「没开跑」，旧 attempt 却回来说「我做完了」——**生成 `report_contradicted` decision**（kind 见 §9 的固定清单），**节点停在当前格不迁出**（只可能是 `startup_unknown` 或 `indeterminate_side_effect`），格上记 `hang_reason = report_contradicted` 与 `contradiction_decision_id`。**挂起期间新 attempt 不许先跑**（否则同一笔副作用会被执行两次，账上却只记了一次「重试」）；`unknown_watchdog` 与既有裁决时限照走，到点只生成各自的 decision，**不改变「冲突未决」这个事实**。这条 decision 只有两条 resolution：**`uphold_report`**——以那条迟到 report 为准，调 `applyReport(node_run_id, attempt, report, expected_status={startup_unknown, indeterminate_side_effect}, generation=Ga, decision={decision_id, revision, resolution: uphold_report})`，按同一套 schema / 判定 / 证据门收口 `done` / `failed`（证据门不过则这个 resolution 不可用，只能转 `uphold_decision`）；函数内先 CAS `decisions` 行（revision + 活跃状态），冲突即拒、节点格不动；**`uphold_decision`**——维持原裁决 D1，原裁决照常走 `superseded` / `failed`：幂等 → 旧行 `superseded` + 新建 `queued` 新行，不可重试 → `failed`（执行细节见 §8 的 `uphold_decision` 行与 M-60），迟到 report **永久标 stale**（`report_registry.state=stale`，只留账、不重放、不覆盖原裁决）。**这条 decision 不设「过期即释放」**：超过 24 小时无人裁决只升级 `blocked_for_human` 并推送，再过一个 24 小时也**不自动落任何一边**（节点留在原格、run 保持 paused、新 attempt 继续被挡），**只能由人收口**；它的终态只有 `uphold_report` / `uphold_decision` 两条路，`expired` 对它无效。节点已进终态时，允许人工回填 / 修正（改写终态事实要留事件，不许静默改），但**不许自动改写**——`report_contradicted` 一律走人裁决收口。**挂起期间普通出口一律被闸门挡住**：从 `startup_unknown` / `indeterminate_side_effect` 迁出的每一行 CAS 都额外带 `AND hang_reason IS NULL`，唯一例外是本条的两条 resolution 与迁往 `paused_bridge_missing` 的桥断边。

**超时分两件事，别混成一件**：一是「宣告超时」——立围栏、从此收不到新的 report；二是「动作停下」——executor 与外部动作真的不再动了。第二件做不到时，第一件就不该做。**所以顺序是「先问能不能停，再决定立不立围栏」**：

- 动作**可中断**（pure / compensable / 已声明可中断的 tool）：先 `executor.cancel`，拿到 `cancel_result=interrupted` 才 CAS 到 `timing_out` 立围栏 → 30 秒宽限 → `whenIdle` → 迁 `timeout` 或 `indeterminate_side_effect`。迟到 report 撞上 timing_out 一律 STALE_ATTEMPT，**但会被存进 report_registry**（state=rejected；非当前 attempt 的记录标 stale；围栏撤销时按当前 attempt 的队头重放一次，见第 3 条）。**`whenIdle` 必须带超时**（默认 30 秒，与宽限同长）：超时不等于「已确认停止」，按「未确认停止」处理——走 `timing_out → stopping`（延长 `action_deadline_at`、生成 decision），**不得判 `indeterminate_side_effect`**（它的前提是「executor 已确认停止」，whenIdle 没返回不算）。**`cancel_result` 的取值只有四个**：`interrupted` / `not_interruptible` / `already_stopped` / `unknown`（§1.1），本节与 §8 迁移表用**同一套取值**，不另立说法——`interrupted` 才立围栏；`not_interruptible` 与 `unknown` 一律不立围栏、改进 `stopping`（`unknown` 回执不明，保守按 `not_interruptible` 处理）；`already_stopped` 表示动作已停，按「executor 已停」那一支判定（状态未知 → indeterminate_side_effect，有结论 → done / failed），**不进 timing_out**。
- 动作**不可中断**（已声明 not_interruptible 的 irreversible 工具）：`cancel_result=not_interruptible`（或 `unknown`）时**不立围栏**，改为延长 `deadline_at`（记 `action_deadline_at` = 动作真正开跑那刻 + 该工具的 maxSec），并 CAS 到 `stopping`。
- **围栏已立才发现停不下**：迁 `timing_out → stopping`，记一条围栏撤销事件，节点回到 executor 手上（§8 迁移表）。先立围栏再问，围栏就会把还在跑的动作关在门外——report 被挡、节点只能被误判 timeout 或 indeterminate_side_effect。**撤销围栏时必须把被挡下的 report 接回来**：服务读 report_registry 里**当前 attempt** 的队头（seq 最小、state=rejected），用同一 report_id 重放一次（幂等，重放前先验哈希链），重放后按 stopping 的规则重新求值（自然完成就收口，否则继续跟）。不接回来，围栏一立一撤之间真实发生的完成就凭空丢了。**撤围栏的补 cancel 同样只认那四个取值**：`cancel_result ∈ {not_interruptible, unknown}`（或 whenIdle 超时 / 恢复期查得动作仍在跑）是撤围栏的三个来源，§8 的 `transition_reason` 必须把三者分开记——`already_stopped` **不进**这条边（动作已停就按判定收口，不撤围栏）；`interrupted` 也不进（真停下来了就按 §8 的 timing_out → timeout / indeterminate_side_effect 判定收口）。

**时限分两层，别混成一层**：一层管「还没开跑」，一层管「已经在跑」。
- **启动层（等 tool.start 事件）**：唯一计时器 `startup_timeout`（节点级可配，默认 60 秒），从 dispatched_at 起算。**到点只说明「等不到 tool.start 事件」，不等于「动作没开跑」**——桥有缓冲也有重放，事件可能只是还没送达。所以判定分三种，前提是**先拿到事实**：
  1. **`executor.state` 明确回报「尚未发出任何 tool.call」**（靠新增的 `has_tool_call` / `tool_call_seq`，或用 `fromSeq` + ack 证明没有 tool.call）→ 才走可中断路径：**先发 `executor.cancel` 并读回执**，`cancel_result = interrupted` 才准迁 `timeout`（**仅幂等节点可自动重试**）；回执 `not_interruptible` / `unknown`（保守按 not_interruptible 处理）**不许**迁 timeout，改走 `dispatched / started → stopping`（不立围栏，延长 `action_deadline_at`）；回执 `already_stopped` 视为动作已停，按「executor 已停」那一支判定（状态未知 → indeterminate_side_effect，有结论 → done / failed）。这一步与 §8 的 `dispatched / started → timeout` 行是**同一套 cancel 口径**（该行 CAS 带 `cancel_result = interrupted`）。
  2. **回报不明** → 迁**新半态 `startup_unknown`**（不是 stopping）：动作**可能根本没开跑**，所以这一格**不生成 `action_deadline_at`**（没有开跑时刻就没有动作时限），也不声称「还在跑」。它**可能**挂一条 decision（kind=`startup_unknown`）等人裁决——挂不挂取决于 executor 还活着没有（见下面），出口在原三个之上再补两条（第十七轮补，见下面）：`confirm_not_started`（人确认没开跑 → 幂等节点旧行落 `superseded`、新行重试，不可重试节点按 failed）、`confirm_started`（人确认已开跑 → 进 `stopping`，此时按「有 tool_start_at 就用它；没有就以裁决时刻 now 为锚点」起算动作时限，并记 `action_start_source=human_confirmed`）、`abandon`（放弃 → `abandoned_unverified`）。**irreversible 或 `idempotent=false` 的节点一律不许自动重试**——宁可问一次，也不要拿一次重复副作用换一个自动恢复。**confirm_started 服务端也要拦**：`last_known_phase=called_no_start`（没有开跑证据）时，UI 不开放、服务端收到也拒（RESOLUTION_NOT_AVAILABLE）——人不能凭空宣布一个没观测到的动作开跑了。

   **进 `startup_unknown` 先分两情况，别一律挂 decision**：**executor 已失联**（**桥可用时** `executor.state` 查不到、已是 deleted、或状态回报不明）→ 挂 startup_unknown decision 等人裁决；**executor 仍活**（桥订阅还在、executor 还在跑）→ **不挂 decision**，保留桥订阅、节点留在 executor 手上，等动作完成后 report 落回来（回写边见 §8：`startup_unknown → done / failed`，CAS 带 status + attempt + action_generation = Ga + report_id，且**只调 `applyReport(node_run_id, attempt, report, expected_status={startup_unknown}, generation=Ga)`**）——人证开跑不成立时，动作真做完了就该照常收口，不该惊动人。**这一格只有一个钟：`unknown_watchdog`**（节点级默认 120 秒，落点 `startup_unknown_deadline_at`）。进格时只写 `unknown_reason = startup_deadline`（或 none）：**本格只由启动层 `startup_timeout` 到点进入**；桥断超预算不迁入本格——节点留在 `paused_bridge_missing`，只挂一条 `unknown_reason = bridge_absence` 的 decision。`unknown_reason` 一旦写入不许被另一支覆盖，同一 tick 只生成一条 decision。这一支不挂 decision、不生成 `action_deadline_at`，若不另配时钟，它会永远停在 `startup_unknown`，run 还会显示 running，没有人被叫起来。**到点怎么办**：生成 `startup_unknown` decision 交人工裁决（节点仍留在 `startup_unknown`，不算收口）；此刻桥已断 → 节点按 §7 转 `paused_bridge_missing`（decision 留着），不留在本格。**这一格也在 `paused_bridge_missing` 的覆盖之内**（§7）：桥断即转 `paused_bridge_missing`，恢复时按 `resume_state=startup_unknown` 重入，**不重置 `startup_unknown_deadline_at`**（不许用恢复动作给未知态续命）；**但若该字段为空**（从未写过，或被某个出口清空后没补写），恢复时**补写**——有 `startup_unknown_paused_at` 就按它 + 120 秒还原原钟的到期点，连它也没有才补写 now + 120 秒，并在同一笔 CAS 里 `rearm_generation` Gr+1（**空钟不是无限钟**）。**所有离开 `startup_unknown` 的出口都要显式清空 `startup_unknown_deadline_at`**（迁出即清空，见 §8 每行的 CAS 条件）；不清空的话，同一节点重投后会被上一个 attempt 的旧钟立刻打死。

   **「executor 已失联」再拆三支，别笼统写「失联」**：① **executor 已 deleted**（`executor.state` 回报 deleted）→ 动作状态未知且**无对象可 reattach**，裁决出口只到 `indeterminate_side_effect` 或 `abandoned_unverified`；② **executor 状态未知**（桥可用但查不到 executor / 状态回报不明）→ 不许硬 reattach，先重查状态再定，裁决出口同 ①；③ **桥断**（桥不可用，事实查不到）→ 转 `paused_bridge_missing`，桥回来重查 `executor.state` 再定去路。**`continue_tracking` 只对「executor 仍活且桥可用」这一支开放**——watchdog 到点但 executor 仍活、桥订阅还在，才能续跟；**「桥断但 executor 未删」不开放**：桥断即转 `paused_bridge_missing`（§7），节点已不在 `startup_unknown`，续跟无从谈起，桥回来按 `resume_state=startup_unknown` 重入后再定。deleted 的 executor 没有桥订阅，「保持桥订阅、等 report」是空话；② 状态不明也不许选；**这三支只能走裁决出口**，**唯一例外是 `confirm_not_started` 的 deleted 支**：无对象可查时按人证接受（状态事实、不是验证证据；幂等 → 旧行 `superseded` + 新行重试，不可重试 → `failed`），② 状态不明仍只到 `indeterminate_side_effect` / `abandoned_unverified`，③ 桥断按上一句先转 `paused_bridge_missing`。

   **「已失联」那一支的出口再补两条，别把人裁决的结果堵在门外**：`confirm_started_attested`（人证开跑——**只作状态事实、不作验证证据**，标 `action_start_source=human_attested` 并记 `attestation_id`，**不写 `evidence_id`**，进 `stopping`）与 `continue_tracking`（保持 `startup_unknown`，**重写 `unknown_watchdog`** 并允许 report 落回，**受 `unknown_watchdog` 约束**：续跟只是延长观察窗口，不是无限续命，超时照样生成 decision；**这一格从不生成 `action_deadline_at`**，续跟也不挂动作时限）。**`confirm_started` 与 `confirm_started_attested` 共用同一个 `executor.state` 前置检查**（不许一条查一条不查）：`deleted` → 动作状态未知，转 `indeterminate_side_effect`（或由人放弃转 `abandoned_unverified`）；`unloaded` → 先 resume 再 reattach；状态未知 → 先重查再定，重查仍不明 → RESOLUTION_NOT_AVAILABLE（只余 indeterminate_side_effect / abandoned_unverified）；桥断 → 转 `paused_bridge_missing`。**这四个分支在 §8 迁移表里各有自己的一行目标迁移**（`deleted` 与「桥断」不再只写在条件列里，要能一眼查到迁到哪儿去），§9 的裁决出口副作用表也用同一套。

   **离开 `startup_unknown` 的每一条出口都要清钟**：`startup_unknown_deadline_at` 在迁出时**显式清空**（迁到 `paused_bridge_missing` 时清空并记 `startup_unknown_paused_at = now`，钟暂停、桥预算接管，恢复时按 paused_at + 120 秒还原）——旧钟留着，重投后的新 attempt 会被上一个 attempt 的余钟立刻打死。

   **`continue_tracking` 重写钟**：本支**不迁出**，但**要把钟显式重写**为 `startup_unknown_deadline_at = now + 120 秒`（不是沿用旧值），并在**同一笔 CAS** 里 `rearm_generation` Gr+1——续跟是把观察窗口**重新延长一次**，不是无限续命；到期照样生成 startup_unknown decision。
  3. **已观测到 tool.call 但 tool.start 未到** → 同样归 `startup_unknown`，但 `last_known_phase = called_no_start`（**语义是 unknown，不是 executing**：模型发出调用不等于工具开跑）。此时 `confirm_started` 不开放（没有开跑证据），只能 `confirm_not_started`（若工具确实没跑过）、`confirm_started_attested`（人证开跑）、`continue_tracking`（继续跟踪、重写 `unknown_watchdog` 等 report，**同样受 `startup_unknown_deadline` 约束**，只允许「executor 仍活且桥可用」一支——桥断已转 `paused_bridge_missing`，不在此列）或 `abandon`——**人已经裁决的，不能让节点无处可去**。

  为什么不能直接转 stopping：stopping 的语义是「动作还在跑」，它的三个出口（继续等 / 认定已发生 / 放弃）全都建立在「有个在跑的动作」之上；而启动层到点的节点，动作可能压根没启动过。混在一起会让「继续等」等一个不存在的动作，让「认定已发生」在没有任何动作的情况下签成 applied。
- **动作层（动作已经在跑）**：计时锚点是 `tool.start` 事件里的 tool_start_at（工具真正开跑的时刻）。模型「发出调用」不等于「动作开始」，慢启动的工具会在 tool_start_at 之前耗掉一段启动时间——那段归启动层管。所以 `action_deadline_at = tool_start_at + 该工具 maxSec`。若 tool.call 已出现但 tool.start 迟迟不来（宿主在调用中途崩了），按 §6 的 last_known_phase 分流（执行中且已停止 → indeterminate_side_effect）。

**stopping 是执行期状态，节点必须留在 executor 手上。** 它记 `cancel_requested_at`、`cancel_result=not_interruptible`、`tool_start_at`、`action_deadline_at`、`last_heartbeat_at`、`wait_extensions`、`action_generation`（Ga）、`rearm_generation`（Gr）。**节点停在 stopping 的期间，executor 一直被桥盯着**：动作后续自然完成，report 照常 accepted（CAS 认 `status=stopping AND action_generation = Ga`，**迟到完成也收**，不受 deadline 约束），节点正常迁 done / failed；桥断了则落 paused_bridge_missing，桥回来继续盯。**stopping 不迁 blocked_post**——blocked_post 是「动作已完、结果待裁决」，它不依赖 executor；把还在跑的动作塞进去，等于账上先收口而现实里还在动，这正是第十三轮判定为 blocker 的那处。`action_deadline_at` 到点仍不停，引擎**就地生成 decision**（节点保持 stopping，decision 挂在该 node_run 上），人裁决后才定终态。

**继续等必须重新武装**：人点「继续等」时，引擎重算 `action_deadline_at` = 现在 + 该工具的 maxSec（**不是从原锚点顺延**），`wait_extensions += 1`，**`rearm_generation` += 1**（Gr，防旧定时器回头改状态，见 §8），续期记进 node_run_events。续期次数有上限 `max_wait_extensions`（默认 3）；超上限就不再让「继续等」可选。**续期不动 `action_generation`**——动作没重启，回写用的 Ga 不变，所以续期前发出的那条合法迟到回写照样收得下（这正是把两种代次拆开的原因，见 §3.4f 第 1 条）。

**三条裁决出口，都要合法落点**：
1. **继续等**：节点留在 stopping，重新武装（如上）。
2. **认定已发生**：需要前置条件——executor 已确认停止，或已有足够 evidence（policy 要求的命令已产出可核对的产物哈希）。**动作还在跑时这个选项不开放**，否则节点会被写成 done/applied，而那个动作可能继续产生副作用。`startup_unknown` 走的是 `confirm_started`（另一个出口），不是这一条——那一格还没有任何开跑证据。
3. **放弃并标未知**：人放弃继续跟踪这个动作。**它不能写成 indeterminate_side_effect**——indeterminate_side_effect 的前提是「executor 已确认停止」，动作还在跑就不满足。它有自己的一格 `abandoned_unverified`：**动作可能仍在运行，副作用未经验证**。该格是节点终态，但 run 不许因此自动进 succeeded——它挂一条 run 级 decision（kind=abandon_ack）要人签字；签字前 run 的 paused_reasons 保留 `unverified_side_effect`，`resume` 遇此节点一律停下。该动作登记进账本的「未验证副作用」清单。**签字只解裁决门，不解「动作仍在跑」**：abandon_ack 批准后 `unverified_side_effect` 理由**不因签字而自动消失**——**只有该动作的副作用被核实为「没发生」（`side_effect_verified_none = true` 且带 `stop_evidence`）这条理由才消失**：`stopped_at` 只证明「动作停了」，**不证明「副作用没发生」，单独存在时只能支撑 `succeeded_with_unverified`**（口径唯一，见 §8 终态 CAS 第六条）。否则 run 的终态只能落 `succeeded_with_unverified`，不许落 `succeeded`（§8）。**「独立确认停止」要落到字段上，不许只停在一句话里**：这两个事实写在 node_run 行上（`stopped_at` / `side_effect_verified_none`），并带 `stop_evidence`（引用 evidence_id 或确认来源）；run 终态 CAS 的第六条直接读这两个字段（§8），不再靠人脑判断「算不算已确认停止」；**其中只有 `side_effect_verified_none = true` 能让「未验证副作用」这条理由消失**，`stopped_at` 只能让理由不被误清，不能让它消失。没有它们，第六条永远算「未验证副作用」，`succeeded` 那一支到不了；反过来 executor 后来 idle 了，也没有路径把事实写回账。

**4. 终态与半态**：**node_run 的终态集合只在 §8 写一份，这里不另列清单**（§2 / §7 / §9 / §11 / §14 一律引用 §8，不另写同义词）；run 另有 settling。半态有五格：`blocked_pre`（执行前的前置门）、`blocked_post`（执行后的结果待裁决）、`stopping`（已请求停止、动作仍在跑）、`indeterminate_side_effect`（动作已停、状态未知）、`startup_unknown`（**启动层到点、动作是否开跑不明——可能根本没开跑，因此不生成 action_deadline_at；executor 仍活那一支不挂 decision、靠 `unknown_watchdog` 到点再挂，executor 已失联那一支挂 startup_unknown 决策等人工确认**）。五格的共同点：都不是终态，都必须有明确出口，出口分别对应 decision 或回写——**每一格都要有自己的时钟**：startup_unknown 的钟是 `unknown_watchdog`（落点 `startup_unknown_deadline_at`；`startup_timeout` 管进格、`unknown_watchdog` 管在格，`unknown_reason` 记是哪一支点的灯），没有钟的半态会永远停在那里。**`verifying` 也有自己的钟**：`verify_timeout`（节点级可配，默认 120 秒，落点 `verify_deadline_at`）——verifier 活着却一直不回 verdict 时，节点到点进 `blocked_post` 并生成 kind=verify_human 的 decision 交人工，不许永远挂在 verifying 上把 run 拖住（§8 有对应行，§7 sweep 同步）。另有一格 `abandoned_unverified`（动作可能仍在跑、人主动放弃跟踪、副作用未验证；**「动作是否已停」记在 `stopped_at`，「副作用是否被核实为没发生」记在 `side_effect_verified_none`——只有后者能让未验证副作用这条理由消失，口径见 §8 终态 CAS 第六条**）——它是节点终态，但要等 run 级 abandon_ack 签字才让 run 收尾，且任何 resume 必停。

**5. 超时路径（先问能不能停，再决定立不立围栏）**：动作层到点 → 发 `executor.cancel`（只发中止信号，不销毁现场）→ 按 `cancel_result` 分流：`interrupted` → CAS 到 `timing_out` 立围栏 → 30 秒宽限 → `whenIdle` → 判定（pure 与 compensable 判 timeout；irreversible 按 §6 规则判 indeterminate_side_effect）；`not_interruptible` / `unknown` → 不立围栏，CAS 到 `stopping`，延长 `action_deadline_at` 继续跟（动作自然完成照常 accepted）。启动层到点按上面的启动层判定二分。**围栏只能在确认停得下来的时候立**。

**6. 重试、副作用与不可逆围栏**：

- 节点声明 side_effect_policy——pure / compensable（需声明补偿动作）/ irreversible（写库、发消息、推远端）。irreversible 执行前必须过前置审批。
- **原子性边界**：外部动作与 SQLite 提交不可能同事务，irreversible_applied 只是记录，不是围栏。真正的围栏是 indeterminate_side_effect + 人工裁决。
- **indeterminate_side_effect 只在一种情况下触发**：executor 已确认停止（whenIdle 确认或进程退出），而动作状态仍未知。慢不算未知；**whenIdle 没返回也不算确认停止**——那种情况属于 `stopping`，等它自己结束或等人裁决。
- **`abandoned_unverified` 是另一格，不与 indeterminate_side_effect 混**：indeterminate_side_effect = 动作已停、状态未知（等人工裁决后确认发生或没发生）；abandoned_unverified = 人主动放弃跟踪、动作可能仍在跑、副作用未经验证（要人签字才让 run 收尾）。动作还在跑的时候只有这一格能接「放弃」，没有别的合法目标——第十三轮指出的「放弃后无处可去」就是这么补上的。
- **心跳独立于 runner 主循环**：runner 的 progress 回调由独立线程（或宿主侧定时回调）发，即使 runner 卡在同步工具调用里，心跳照发。心跳续期活动期限并记 last_heartbeat_at。
- **不可逆动作的时限按风险定，不是一个全局常数**：节点与工具级声明 `irreversible_deadline { defaultSec, maxSec, heartbeatExtendable }`。迁移期默认 defaultSec=900、maxSec=3600；长迁移类工具自己声明 defaultSec=7200；卡死类声明 defaultSec=300。不可中断的动作（cancel 到不了）**不立超时围栏**，改为延长 `action_deadline_at` 并进 `stopping`，按心跳续期（§3）。
- **cancel 分级**：动作可中断才 cancel 并立围栏；不可中断的只停调度、进 `stopping`、不杀执行，等它自然结束或到 `action_deadline_at` 转人工裁决。
- 节点已 started、executor 已停、动作状态未知 → indeterminate_side_effect，run 进 paused，生成 decision 问人「到底发生了没有」：确认已发生（`resolution=confirm_applied` → 迁 done、标 applied、把这个动作从 pending 派生集合移出）、确认没发生（`resolution=confirm_not_applied` → 幂等节点**旧行落 `superseded`、新行重试**并**新 attempt + 新 executor**，不可重试节点落 failed；旧行不在原地改 attempt）、继续查证据（派 verifier 取证）。所有 resume 遇 indeterminate_side_effect 停下。**indeterminate_side_effect 不是死胡同**：它有三条出边（→ done / → superseded 或 failed / → abandoned_unverified，前者旧行落 superseded、新行另建），每条都带 decision_id + revision + `rearm_generation` Gr（裁决收口类用 Gr，不用 Ga），见 §8。**`confirm_not_applied` 开工前先过 `report_contradicted` 检查**（§3 回写段）：旧 attempt 的迟到 report 与本裁决冲突时，节点先挂起等那条 decision 收口，**新 attempt 不许先跑**——否则同一笔副作用做两遍，账上只记一次重试。
- 补偿与 resume 二选一：选补偿就新建 attempt 从该节点重跑；选 resume 只从确认干净的断点继续。

**tool 崩溃按 last_known_phase 分流**：命令前崩 → failed 可重试；执行中且已停止 → indeterminate_side_effect。**新增一格 `called_no_start`**：模型已经发出 tool.call，但 tool.start 没来（宿主在调用中途崩了）——**这既不是「没调用」也不是「执行中」，语义是 unknown**：irreversible 走 indeterminate_side_effect（不自动重试）；pure / compensable 只在 `idempotent=true` 且无任何开跑证据时才可重试。把 called_no_start 写成 executing，会让本可安全重试的节点被过度判成状态未知；写成「没调用」，则会把可能已经改过世界的动作当成干净重来——两边都是把「没观测到」当「没发生」。

**7. 生命周期、重启与孤儿**：

sweep 覆盖全部非终态，每一态都有明确的恢复动作（这张表与 §8 的迁移表一一对应；**node_run 的终态集合见 §8，这里不另列**）：

| 非终态 | 恢复动作 |
| --- | --- |
| queued | 重新入队，不重置 queued_at |
| leased | 租约过期则回 queued |
| dispatched | 查执行桥；活着 reattach；确认死了 → **可重放**落 orphaned（节点终态，等重投；重投新建 node_run，并把新行 id 回写旧行的 `replacement_node_run_id`）、**不可重放**直接落 failed 并上报 |
| started / verifying | 同上；verifying 用 verifier_agent_id 判活；**verifying 还有自己的钟**：`verify_timeout` 到点（`verify_deadline_at`）→ 迁 blocked_post 并生成 kind=verify_human 的 decision（默认不判失败）；节点声明 fail_on_timeout 才落 failed / failed_with_unverified（**副作用已被核实为没发生才落 failed，否则落 failed_with_unverified**，§8 终态 CAS 第六条）；**桥断期间这个钟停走，恢复时按暂停时长补时**（§3 桥断时钟矩阵） |
| timing_out | 重启后补 cancel → whenIdle（**whenIdle 带超时；超时按未确认停止** → 迁 stopping，不判 indeterminate_side_effect）→ 迁 timeout 或 indeterminate_side_effect（动作不可中断的不会进这一格）；**并重放被挡下的 report**（读 report_registry 里当前 attempt 的队头） |
| stopping | 重启后查执行桥：动作还在跑 → 先看 action_deadline_at 是否已到（到点就生成 decision，不许继续等），未到才继续等心跳；已停且状态未知 → indeterminate_side_effect；已停且有结论 → 迁 done / failed；**围栏撤销后被挡下的 report 要重放一次**（读 report_registry 里当前 attempt 的队头） |
| startup_unknown | 分两情况。**executor 已失联** → 重启后**不自动重试、不自动取消**，挂 startup_unknown decision 等人裁决（confirm_not_started / confirm_started / confirm_started_attested / continue_tracking / abandon）；**「已失联」再拆三支**：① executor 已 deleted → 无对象可 reattach，裁决出口只到 indeterminate_side_effect 或 abandoned_unverified（**唯一例外是 `confirm_not_started`：无对象可查时按人证接受，见本行末段**）；② executor 状态未知（桥可用但查不到）→ 不许硬 reattach，先重查再定，出口同 ①；③ 桥断 → 转 paused_bridge_missing，桥回来重查 executor.state 再定。裁决为 confirm_not_started 且节点幂等 → 旧行落 `superseded`，新 attempt 新建 node_run（`origin_node_run_id` 指向旧行，旧行 `replacement_node_run_id` 回写新行，**新 executor**），不可重试 → failed；**confirm_not_started 的前置共五条：`has_tool_call=true` 闸门只拒本 resolution；四个 `executor.state` 分支与 confirm_started 对称，各有落点**：`has_tool_call=true` → 拒（RESOLUTION_NOT_AVAILABLE）；`deleted` → 无对象可查，按人证接受（幂等 → 新行重试；不可重试 → failed）；`unloaded` → 先 resume 查 `has_tool_call`，为 true 拒；状态未知 → 先重查再定，不许凭猜落 superseded；重查仍不明 → RESOLUTION_NOT_AVAILABLE，只余 indeterminate_side_effect / abandoned_unverified；桥断 → 先转 paused_bridge_missing 等事实；**迁出前先过 `report_contradicted` 检查**（旧 attempt 的迟到 report 与本裁决冲突 → 节点先挂起等那条 decision 收口，新 attempt 不许先跑，§3）；**confirm_started 与 confirm_started_attested 共用同一 executor.state 前置检查**（deleted → indeterminate_side_effect 或 abandoned_unverified；unloaded → resume 后再 reattach；状态未知 → 先重查；桥断 → paused_bridge_missing），再回 stopping（锚点取 tool_start_at 或裁决时刻）；confirm_started_attested → 回 stopping 并记 action_start_source=human_attested；continue_tracking → 保持本格、重写 unknown_watchdog 允许 report 落回，**只对「executor 仍活且桥可用」开放**（桥断已转 paused_bridge_missing，不在此列）（钟重写为 now + 120 秒、Gr+1；本格不生成 action_deadline_at）；abandon → abandoned_unverified 并挂 run 级 abandon_ack。**executor 仍活** → 保留桥订阅、不挂 decision，等 report 落回来直接走 startup_unknown → done / failed（只调 `applyReport(node_run_id, attempt, ...)`，CAS 带 status + attempt + action_generation = Ga + report_id 三元组）；**这一支由 unknown_watchdog（落点 `startup_unknown_deadline_at`，默认 120 秒）兜底**——到点生成 startup_unknown decision（节点留在本格），此刻桥若已断则按「已失联」第 ③ 支走。**离开本格的每条出口都显式清空 `startup_unknown_deadline_at`**（迁到 paused_bridge_missing 时清空并记 `startup_unknown_paused_at`，恢复时按 paused_at + 120 秒还原） |
| waiting | 走 inbox 谓词与过期，不看 agent |
| blocked_pre | 走 decision 状态；批准则重新排队派发，未批则 failed |
| blocked_post | 走 decision 状态 |
| indeterminate_side_effect | 走 decision，等人工裁决，绝不自动续；**冲突挂起时（`hang_reason = report_contradicted`）先等那条 decision 收口，任何裁决与新 attempt 都排在它后面** |
| paused_bridge_missing | 覆盖 executor-bound 的六种（dispatched / started / verifying / timing_out / stopping / **startup_unknown**）；桥恢复后按 resume_state 逐态重入——**只有 dispatched / started / verifying 才重置心跳计时**；**启动层 `startup_timeout` 一律不重置**（桥抖不能给启动层续命）；**startup_unknown 恢复时不重置这个钟**（不许用恢复给未知态续命）：恢复后按 resume_state=startup_unknown 重入并查 executor.state 再定去路，**`startup_unknown_deadline_at` 为空时按 `startup_unknown_paused_at + 120 秒` 还原、连 paused_at 也没有才补写 now + 120 秒并 Gr+1**（空钟不是无限钟）；timing_out 的围栏不重置（围栏已宣告，不能被恢复动作撤销）；stopping 的重新武装计入 wait_extensions 且受 max_wait_extensions 约束，超限只生成 decision；桥断累计由**同一个 unknown_watchdog 预算**（默认 120 秒）管，用 `bridge_absence_accumulated` / `bridge_down_since` 记账（**不再有第二个 120 秒预算**；**清零语义唯一：每次桥断事件各自计、各自清零，不跨桥断事件累加**，见 §3 桥断时钟矩阵），超预算按状态分治（**节点一律留在本格，只生成 decision，不迁 startup_unknown**）：dispatched / started / startup_unknown → 挂一条 `startup_unknown` decision 并置 `unknown_reason = bridge_absence`（同一次桥断只一条，唯一键去重）；stopping / verifying / timing_out → 生成各自的 decision 并保留 action_deadline_at，不许倒退到 startup_unknown。**所有桥恢复迁移的 CAS 带 `rearm_generation = Gr`；凡重新武装 action_deadline_at 的路径（桥恢复、继续等、围栏撤销）在同一笔 CAS 里 Gr+1 写回** |

**paused_bridge_missing 覆盖 executor-bound 的六态**（dispatched / started / verifying / timing_out / stopping / **startup_unknown**）。`waiting` 与 `blocked_pre` / `blocked_post` 本来不依赖 executor，桥断了也照走 inbox 与 decision，不该被拖进暂停。恢复边逐态列明（**恢复类迁移一律带 `rearm_generation = Gr`；凡重新武装 action_deadline_at 的路径在同一笔 CAS 里 Gr+1 写回**）：resume_state=dispatched → 只重连、不重发指令；=started → 只重连并等后续事件，不重投；=verifying → 用 verifier_agent_id 判活后重连；=timing_out → 重连后补 cancel → whenIdle 再迁（whenIdle 超时按未确认停止走 stopping，并重放被挡下的 report）；=stopping → **先重连查 `executor.state`**，再按实际状态决定：动作还在跑 → 看 action_deadline_at 是否已到（到点直接生成 decision），未到才继续等心跳并重新武装 action_deadline_at（**这次武装计入 wait_extensions**，已达上限就不许再续，改生成 decision；**同一笔 CAS 里 `rearm_generation` += 1（Gr+1）**）；已停且状态未知 → 迁 indeterminate_side_effect；已停且有结论 → 迁 done / failed；**=startup_unknown → 重连后查 `executor.state` 再定去路**（已 deleted → 迁 indeterminate_side_effect 或 abandoned_unverified；仍活 → 回 startup_unknown 等 report 落回，**`startup_unknown_deadline_at` 不重置**——为空时按 `startup_unknown_paused_at + 120 秒` 还原，连 paused_at 也没有才补写 now + 120 秒并 Gr+1；状态未知 → 先重查再定），**恢复动作不许给未知态续命**。**桥恢复不许重置启动计时**——启动层只跑那一个 `startup_timeout`，桥一抖就重起等于给「可能根本没开跑」的节点无限续命；**本次**桥断累计并入同一个 unknown_watchdog 预算（用 `bridge_absence_accumulated` 记账，**每次桥断事件各自计、各自清零**，见 §3 桥断时钟矩阵），超预算按状态分治（**一律留在 paused_bridge_missing，只生成 decision，不迁 startup_unknown**：dispatched / started / startup_unknown → 一条 `startup_unknown` decision 且 `unknown_reason = bridge_absence`；stopping / verifying / timing_out 走各自的 decision，且保留 action_deadline_at）。

**stopping 也依赖桥**：它要问 executor.state、cancel、whenIdle，桥断了就问不到——所以 stopping 必须落在 paused_bridge_missing 的覆盖里（或单列 stopping_bridge_missing 子态，语义相同），不能让它在桥断时悬着没人收。**startup_unknown 同样依赖桥**（它要问 executor.state、要不要 reattach、report 回不回得来），所以也在 paused_bridge_missing 的覆盖里；这一格的恢复不许重置 `startup_unknown_deadline`（§3）。

run 级：`settling` 进启动对账——pending_irreversible_children 为空即补终态事件。

**orphaned 是节点终态**（终态集合见 §8）：判活确认死亡且**可重放** → 本行落 orphaned 并封存，重投时**新建 node_run**（`origin_node_run_id` 指向本行）并把新行的 id 回写本行的 `replacement_node_run_id`——**旧行不迁出**（它已经是终态），新行接的是新账，但旧账上有指针，两边接得上；判活确认死亡且**不可重放**（irreversible / `idempotent=false`）→ 本行**直接落 failed 并上报**，不许假装着它在等（这一支**不经 orphaned**）。run 的终态 CAS 前置条件「无非终态 node_run」因此能被满足（orphaned 与 failed 都是终态），run 才收得了尾。

**8. 状态机与迁移表**（这张表就是验收用例）：

node_run 迁移，每行给出「从 → 到」「条件」「触发者」「CAS 字段」：

| 从 | 到 | 条件 | 触发者 | CAS 字段 |
| --- | --- | --- | --- | --- |
| （建） | queued | 无空闲 slot | 调度器 | node_run_id + epoch |
| queued | leased | 抢到 slot | 调度器 | status=queued |
| leased | dispatched | 指令已投给 executor（send 返回）——**Ga 的自增点唯一，就是本行**：**首次派发写 1；此后每一个新 attempt / 重开动作一律 Ga+1**（CAS 带的是读到的旧 Ga，成功后新值 = 旧 Ga + 1，**不许把 Ga 重置回 1**——重置成 1 会让旧 attempt 发出的 report 撞上新一代的栅栏） | 执行桥 | lease_id + status=leased + **action_generation = 旧 Ga（首次为空）→ 新值 = 旧 Ga + 1（首次即 1）** |
| dispatched | started | **观测到该 attempt 的第一个 step / turn boundary 或第一次工具调用** | 执行桥事件流 | attempt + lease_id + status=dispatched + **action_generation = Ga**（回写类迁移用 Ga，见代次矩阵） |
| dispatched / started | startup_unknown | **启动层 startup_timeout 到点**：等不到 tool.start 事件（**不等于动作没开跑**）；已观测到 tool.call 但无 tool.start → 归此格；**桥断不归此格**（节点转 paused_bridge_missing）；**本格不生成 action_deadline_at**；**executor 已失联才挂 startup_unknown decision 等人裁决，executor 仍活则不挂 decision、保留桥订阅等 report 落回**（见 §3）；**本格只有一个钟 `unknown_watchdog`（落点 `startup_unknown_deadline_at`，默认 120 秒）**：executor 仍活那一支写入并置 `unknown_reason = startup_deadline`；桥断超预算不迁入本格（节点留在 paused_bridge_missing，只挂一条 decision）——到点生成 startup_unknown decision（节点留在本格）；**本格也在 paused_bridge_missing 覆盖内**，桥断按「executor 已失联」分支处置 | 计时器 | 同上 + status=dispatched / started + startup_state=unknown + **startup_unknown_deadline_at**（executor 仍活那一支写入；executor 已失联那支不写）+ **unknown_reason**（startup_deadline / none；bridge_absence 只属于桥断 decision，不随节点迁入本格）+ **rearm_generation = Gr** |
| startup_unknown | superseded | 人确认没开跑（resolution=confirm_not_started）且节点幂等 → **旧行落 `superseded` 终态**，新 attempt 新建 node_run（`origin_node_run_id` 指向本行，本行 `replacement_node_run_id` 回写新行；`attempt = 旧 attempt + 1`、**新 executor**）——**旧行不在原地改 attempt**；**新 attempt 的 Ga 在重新派发时 +1**（自增点是 `queued → leased → dispatched` 那笔 CAS，**新 attempt 一律 Ga+1，不许回到 1**，见 §8 代次段）；**开工前先过两道闸**：① `executor.state` 查得 `has_tool_call=true` → **服务端拒绝该 resolution**（RESOLUTION_NOT_AVAILABLE，不许把「已发出调用」当「没开跑」）；**`confirm_not_started` 的前置共五条：`has_tool_call` 闸门 + 四个 `executor.state` 分支；四个分支与 confirm_started 对称，`has_tool_call=true` 闸门只对 confirm_not_started 生效**：`deleted` → 无对象可查，按人证接受（幂等走本行、不可重试走 failed）；`unloaded` → 先 resume 查 `has_tool_call`，为 true 拒；状态未知 → 先重查再定，不许凭猜落 superseded；重查仍不明 → RESOLUTION_NOT_AVAILABLE，只余 indeterminate_side_effect / abandoned_unverified；桥断 → 先迁 `paused_bridge_missing` 等事实；② `report_contradicted` 检查——旧 attempt 的迟到 report 与本裁决冲突时，节点先挂起等那条 decision 收口，**新 attempt 不许先跑**（§3） | 服务 | 同上 + status=startup_unknown + decision_id + revision + **startup_unknown_deadline_at IS NULL（出口清空这个钟）** + **replacement_node_run_id（新行建好后回写）** + **hang_reason IS NULL** + **rearm_generation = Gr** |
| startup_unknown | failed | 人确认没开跑但节点不可重试（resolution=confirm_not_started） | 服务 | 同上 + status=startup_unknown + decision_id + revision + **startup_unknown_deadline_at IS NULL（出口清空这个钟）** + **hang_reason IS NULL** + **rearm_generation = Gr** |
| （建） | queued | **重投 / 重试的新 attempt 行**：由 `superseded` 或 `orphaned` 旧行发起；`origin_node_run_id` = 旧行，`attempt` = 旧行 + 1，新 executor 新租约；同一旧行只许建一行（`node_runs_origin_uq` 兜底） | 服务 | node_run_id + epoch + **origin_node_run_id + attempt** + status=queued |
| startup_unknown | stopping | 人确认已开跑（resolution=confirm_started）→ 进 stopping 并起算动作时限（锚点：有 tool_start_at 用它，否则用裁决时刻）；**与 confirm_started_attested 共用同一 executor.state 前置检查**（不许一条查一条不查）：**executor 仍活** → 走本行；unloaded → 先 resume 再 reattach 后走本行；**状态未知 → 先重查 executor.state 再定，不许硬 reattach；重查仍不明 → RESOLUTION_NOT_AVAILABLE，只余 indeterminate_side_effect / abandoned_unverified**；**executor 已 deleted → 走下面单独的 `startup_unknown → indeterminate_side_effect` 行**；**桥断 → 走下面单独的 `startup_unknown → paused_bridge_missing` 行**（此时属「已失联」第 ③ 支） | 服务 | 同上 + status=startup_unknown + decision_id + revision + **startup_unknown_deadline_at IS NULL（出口清空这个钟）** + **hang_reason IS NULL** + **rearm_generation = Gr**（起算动作时限 = 重新武装，同一笔 CAS 里 Gr+1 写回） |
| startup_unknown | abandoned_unverified | 人放弃（resolution=abandon）：动作可能仍在跑、副作用未验证；**executor 已 deleted 只说明「没有对象可 reattach」，不等于动作已停**——「独立确认停止」的事实只能由 `stopped_at` / `side_effect_verified_none` 两个字段承载（§3、§8 终态 CAS 第六条），**executor 已删不作为「确定已停」的依据**；executor 未删时更不许假设它停了 | 服务 | 同上 + status=startup_unknown + decision_id + revision + **startup_unknown_deadline_at IS NULL（出口清空这个钟）** + **hang_reason IS NULL** + **rearm_generation = Gr** |
| startup_unknown | done / failed | **executor 仍活**：动作完成后 report 落回来（启动层事实未明，不妨碍回写收口）；**回写边只调 `applyReport(node_run_id, attempt, report, expected_status={startup_unknown}, generation=Ga)`**——同一套 schema 校验、同一套判定规则、同一套证据门（irreversible 动作必须带强证据），**不许因为起点是 startup_unknown 就放宽一格**；**迟到的 report 一律入 report_registry**（落败也入队，state=rejected；节点已迁出则只留账不重放，§3） | 执行器回写 | 同上 + status=startup_unknown + attempt + **action_generation = Ga** + report_id + **startup_unknown_deadline_at IS NULL（出口清空这个钟）** + **hang_reason IS NULL** |
| startup_unknown | stopping | 人证开跑（resolution=confirm_started_attested）→ 进 stopping 并起算动作时限；**只作状态事实、不作验证证据**，记 `action_start_source=human_attested` 与 `attestation_id`、**不写 `evidence_id`**；**与 confirm_started 共用同一 executor.state 前置检查**（executor 仍活 → 走本行；unloaded → 先 resume 再 reattach 后走本行；状态未知 → 先重查，重查仍不明 → RESOLUTION_NOT_AVAILABLE（只余 indeterminate_side_effect / abandoned_unverified）；**executor 已 deleted → 走下面单独的 `startup_unknown → indeterminate_side_effect` 行**；桥断 → 走下面单独的 `startup_unknown → paused_bridge_missing` 行） | 服务 | 同上 + status=startup_unknown + decision_id + revision + **startup_unknown_deadline_at IS NULL（出口清空这个钟）** + **hang_reason IS NULL** + **rearm_generation = Gr**（起算动作时限 = 重新武装，同一笔 CAS 里 Gr+1 写回） |
| startup_unknown | startup_unknown | 人点「继续跟踪」（resolution=continue_tracking）：保持本格、重写 `unknown_watchdog` 并允许 report 落回（**本格不生成 `action_deadline_at`**——没有开跑时刻就没有动作时限）；**只许「executor 仍活且桥可用」那一支**（桥断时节点已转 `paused_bridge_missing`，不在此列；deleted 的 executor 没有桥订阅，等 report 是空话；executor 状态未知那一支须先重查），**且受 `unknown_watchdog` 约束**——续跟只是延长观察窗口，不是无限续命：钟重写为 `startup_unknown_deadline_at = now + 120 秒`，到点照样生成 startup_unknown decision | 服务 | 同上 + status=startup_unknown + decision_id + revision + **startup_unknown_deadline_at = now + 120s（重写钟）** + **hang_reason IS NULL** + **rearm_generation = Gr**（重写 unknown_watchdog，同一笔 CAS 里 Gr+1 写回） |
| startup_unknown | indeterminate_side_effect | **「已失联」① / ② 两支**（executor 已 deleted，或状态未知查不实）人裁决「不追了，但动作可能仍在跑」→ 转 indeterminate_side_effect（动作状态未知格），不许在 startup_unknown 里硬收口；**这条边也是 confirm_started / confirm_started_attested 在 executor 已 deleted 时的目标迁移** | 服务 | 同上 + status=startup_unknown + decision_id + revision + **startup_unknown_deadline_at IS NULL（出口清空这个钟）** + **hang_reason IS NULL** + **rearm_generation = Gr** |
| startup_unknown | startup_unknown | executor 已 unloaded（**未 deleted**）→ 先 resume 加载再 reattach，节点留在本格继续等 report（不算迁出）；**钟照旧**——`startup_unknown_deadline_at` 为空时按 `startup_unknown_paused_at + 120 秒` 还原，连 paused_at 也没有才补写 now + 120 秒（并 Gr+1） | 服务 | 同上 + status=startup_unknown + **startup_unknown_deadline_at（空则按 paused_at + 120s 还原，都空才 now + 120s）** + **hang_reason IS NULL** + **rearm_generation = Gr** |
| startup_unknown | paused_bridge_missing | **「已失联」③ 支（桥断）** → 挂起等桥；**这条边也是 confirm_started / confirm_started_attested 在桥断时的目标迁移**；桥恢复后按 resume_state=startup_unknown 重入并查 executor.state 再定去路，**不重置 `startup_unknown_deadline_at`**（不许用恢复给未知态续命） | 服务 | 同上 + status=startup_unknown + resume_state + **startup_unknown_deadline_at IS NULL（清钟）+ startup_unknown_paused_at = now（钟暂停，桥预算接管）** + **rearm_generation = Gr** |
| started | verifying | 节点需外部验证，verifier 已派；**verifying 有自己的钟**：起算 `verify_started_at` 与 `verify_deadline_at = now + verify_timeout`（节点级可配，默认 120 秒），**不许永远挂 verifying 拖住 run**（到点走下面 `verifying → blocked_post`） | 服务 | 同上 + status=started + **verify_started_at + verify_deadline_at = now + verify_timeout** + **rearm_generation = Gr** |
| verifying | done / failed | verdict 通过 / 不通过（**verifier 的 verdict 算执行器回写类**，只调 `applyReport(node_run_id, attempt, verdict, expected_status={verifying}, generation=Ga)`：同一套 schema 校验、同一套判定、同一套证据门，irreversible 需强证据） | 执行器回写（verifier 的 verdict） | 同上 + status=verifying + verdict_id + **attempt（回写三元组之一）** + **action_generation = Ga（回写三元组之二）** + **report_id（回写三元组之三；verdict 自带 report_id）** + **verify_started_at IS NULL AND verify_deadline_at IS NULL（离开 verifying 显式清钟）** |
| verifying | blocked_post | **verify_timeout 到点**（`verify_deadline_at` 过期）→ 结果仍待人工裁决，**默认不判失败**：挂 blocked_post 并生成 kind=verify_human 的 decision 等人收口，**不许让节点永远挂在 verifying 拖住 run** | 计时器 | 同上 + status=verifying + **verify_deadline_at <= now** + **verify_started_at IS NULL AND verify_deadline_at IS NULL（离开 verifying 显式清钟）** + **rearm_generation = Gr** |
| verifying | failed / failed_with_unverified | **verify_timeout 到点且节点策略 fail_on_timeout = true** → 判失败；**「到」列是两个互斥落点，不靠条件描述猜**：该动作的副作用**已被核实为没发生**（`side_effect_verified_none = true` 且带 `stop_evidence`）→ 落 `failed`；该动作的副作用**未被核实为没发生**（`stopped_at` 非空也不算核实——口径唯一见 §8 终态 CAS 第六条）→ 落 `failed_with_unverified`，**不许落 failed**（§8 终态 CAS 第七条；下一行是这一支的独立迁移行） | 计时器 | 同上 + status=verifying（**旧值 verifying → 新值 failed 或 failed_with_unverified**）+ **verify_deadline_at <= now** + **fail_on_timeout = true** + **verify_started_at IS NULL AND verify_deadline_at IS NULL（离开 verifying 显式清钟）** + **rearm_generation = Gr（Gr 不 +1）** |
| verifying | failed_with_unverified | **verify_timeout 到点（`verify_deadline_at <= now`）且节点策略 `fail_on_timeout = true`，且该动作的副作用未被核实为「没发生」**（`side_effect_verified_none` 不为 true；`stopped_at` 只证明「动作停了」，不证明「副作用没发生」，口径唯一见 §8 终态 CAS 第六条）→ **落 `failed_with_unverified`，不许落 `failed`**——这笔未验证副作用必须留在账上（§8 终态 CAS 第七条失败支）；**`failed` 那支只在副作用已被核实为未发生时成立**（见上一行） | 计时器 | status=verifying（**旧值 verifying → 新值 failed_with_unverified**）+ **verify_deadline_at <= now** + **fail_on_timeout = true** + **verify_started_at IS NULL AND verify_deadline_at IS NULL（离开 verifying 显式清钟）** + **attempt（不变：这是同一次尝试的失败，不换 attempt）** + **action_generation = Ga（同一 attempt 的代次，防旧 report 撞上）** + **rearm_generation = Gr（Gr 不 +1：失败判定不重新武装任何时限）**；**幂等键 = (node_run_id, attempt, verify_deadline_at)**——同一个到期点只落一次，不重复上报 |
| started | waiting | wait 语义节点 | 服务 | 同上 + status=started + **rearm_generation = Gr** |
| waiting | dispatched | 事件命中且抢到 slot | 服务 | 同上 + status=waiting + **rearm_generation = Gr** |
| waiting | timeout | max_wait 到 / event_timeout | 计时器 | 同上 + status=waiting + **rearm_generation = Gr** |
| started | timing_out | deadline 到（围栏）——**先问停不停得下来**：先发 `executor.cancel`，**回执 `cancel_result=interrupted` 才立围栏**（not_interruptible / unknown 一律不立围栏，改迁 stopping） | 服务（cancel 回执） | 同上 + status=started + **cancel_result = interrupted** + **rearm_generation = Gr** |
| timing_out | timeout | cancel 完成（`cancel_result=interrupted`）且纯 / 可补偿 | 服务（cancel 回执 + whenIdle 回执） | 同上 + status=timing_out + **cancel_result = interrupted** + **rearm_generation = Gr** |
| timing_out | indeterminate_side_effect | cancel 完成（`cancel_result=interrupted`）且 irreversible 且动作状态未知（whenIdle 确认 executor 已停） | 服务（cancel 回执 + whenIdle 回执） | 同上 + status=timing_out + **cancel_result = interrupted** + **rearm_generation = Gr** |
| timing_out | stopping | **围栏已立才发现停不下**：**先补一次 cancel**（cancel 回执 `cancel_result ∈ {not_interruptible, unknown}`，或恢复期查得动作仍在跑）**或 whenIdle 超时（未确认停止）** → 撤销围栏、重放被挡下的 report，节点回 executor 手上 | 服务（cancel 回执） | 同上 + status=timing_out + **cancel_result ∈ {not_interruptible, unknown}** + **transition_reason ∈ {not_interruptible, unknown, whenIdle_timeout, observed_still_running}**（两种来源必须分得开，否则恢复后分不清是「停不下」还是「没等到」）+ **rearm_generation = Gr**（围栏撤销后重新武装 action_deadline_at 时，同一笔 CAS 里 Gr+1 写回） |
| dispatched / started | stopping | **动作确已开跑**（观测到 tool.start，tool_start_at 有值；或人裁决 confirm_started / confirm_started_attested）且**停不下来**（cancel 回执 `cancel_result ∈ {not_interruptible, unknown}`，不立围栏，延长 action_deadline_at） | 服务（cancel 回执） | 同上 + 当前状态 + action_deadline_at + action_generation = Ga + **cancel_result ∈ {not_interruptible, unknown}** + **rearm_generation = Gr**（延长动作时限 = 重新武装，同一笔 CAS 里 Gr+1 写回） |
| dispatched / started | timeout | **启动层到点且已确认未开跑**：executor.state 回报 `has_tool_call=false`（或 fromSeq + ack 证明没有 tool.call）→ 才走这条边，**只允许幂等节点走**（不可重试节点按 failed）；**收口前先走 cancel 四取值判定**（§3）：`cancel_result=interrupted` → 才立围栏并走本行；`not_interruptible / unknown` → 不立围栏，改迁 stopping；`already_stopped` → 走「已停」判定（写 `stopped_at`），不进 timing_out | 计时器 | 同上 + status=dispatched / started + has_tool_call = false + **cancel_result = interrupted** + **rearm_generation = Gr** |
| dispatched / started | done / failed | **`cancel_result=already_stopped` 且动作结论可核对**（`report_registry` 当前 attempt 队头有可应用 report，或 `executor.state` 给出终局）：动作早已停下、只是引擎没收到——**按「已停」收口，绝不立围栏、不进 `timing_out`**；写 `stopped_at` 与 `stop_evidence`（来源 = `executor.state` 或迟到 report 的完成事件） | 服务（cancel 回执 + 已停事实） | 同上 + 当前状态 + **cancel_result = already_stopped** + **stopped_at** + **stop_evidence** + **action_generation = Ga** + **report_id（有结论 report 时必须带）** + **rearm_generation = Gr（Gr 不 +1，已停就没有可重新武装的时限）** |
| dispatched / started | indeterminate_side_effect | **`cancel_result=already_stopped` 但动作状态未知**（无可核对的 report、`executor.state` 也答不出终局）：**已确认停止 + 状态未知**，正好是 indeterminate_side_effect 的定义，交人裁决；**不许因为「已停」就落 timeout / failed** | 服务（cancel 回执） | 同上 + 当前状态 + **cancel_result = already_stopped** + **stopped_at** + **stop_evidence** + **rearm_generation = Gr（Gr 不 +1）**；**幂等键 = (node_run_id, attempt, already_stopped)** |
| dispatched / started | startup_unknown | **启动层到点但「未观测 ≠ 未发生」**：回报不明，或已发出调用 → **一律进 startup_unknown，不进 stopping**（stopping 只认观测到 tool.start（tool_start_at 有值）或人裁决 confirm_started / confirm_started_attested） | 计时器 | 同上 + status=dispatched / started + startup_state=unknown + **rearm_generation = Gr** |
| stopping | done / failed | 动作自然完成（**迟到也接受**，不再受 deadline 约束）；**只调 `applyReport(node_run_id, attempt, report, expected_status={stopping}, generation=Ga)`** | 执行器回写 | 同上 + status=stopping + **attempt（回写三元组之一）** + **action_generation = Ga（回写三元组之二）** + **report_id（回写三元组之三）** |
| stopping | done | **人裁决「确实发生了」**（resolution=confirm_applied，§9）：动作已停、但副作用确实产生 → 落 done 并标 applied；**前置条件**：有 `stopped_at`（动作确实停了）**且**有已验证的 applied 证据（evidence_id）——**光有「动作停了」不够，还要有「副作用发生了」的证据** | 服务（人裁决） | 同上 + status=stopping + decision_id + revision + **stopped_at** + **evidence_id** + **rearm_generation = Gr** |
| stopping | stopping | 人点「继续等」，重新武装 | 服务 | 同上 + status=stopping + **rearm_generation = Gr**（成功后 Gr+1 写回；**action_generation 不变**） |
| stopping | indeterminate_side_effect | executor 已停且动作状态未知 | 服务 | 同上 + status=stopping + **rearm_generation = Gr**（裁决类迁移用 Gr，不用 Ga——见代次矩阵） |
| stopping | abandoned_unverified | 人放弃跟踪（动作可能仍在跑、副作用未验证），须 run 级 abandon_ack 签字 | 服务 | 同上 + status=stopping + **rearm_generation = Gr** + decision_id |
| abandoned_unverified | stopping | abandon_ack 被驳回（要继续跟）→ 节点回 executor 手上并重新武装 | 服务 | 同上 + status=abandoned_unverified + abandon_ack decision_id + **rearm_generation = Gr**（迁移成功后 Gr+1 写回） |
| abandoned_unverified | abandoned_unverified | **「独立确认停止」落到字段上**：executor 确认已停 → 写 `stopped_at`（附 `stop_evidence`，注明确认来源或 evidence_id）；证据核实到副作用没生效 → 写 `side_effect_verified_none = true`（附 `stop_evidence`）；**这两个字段只能由确认动作写**——迟到 report 不自动写 `stopped_at`（迟到 report 只入 report_registry 留账，见 §3） | 服务 | 同上 + status=abandoned_unverified + **stopped_at** / **side_effect_verified_none** + **stop_evidence** + **rearm_generation = Gr** |
| queued / leased | blocked_pre | 该节点有不可逆动作且需前置审批（**发生在 send 之前**） | 服务 | 同上 + 当前状态 + **rearm_generation = Gr**；进入时**清空 lease_id（置 null）并释放 slot**，resume_state=queued |
| blocked_pre | queued | pre_execution decision 批准 | 服务 | 同上 + status=blocked_pre + decision_id + **lease_id IS NULL**（旧租约已释放，不复用）+ **rearm_generation = Gr** |
| blocked_pre | failed | 前置审批被拒 / 超时按默认动作 | 服务 | 同上 + status=blocked_pre + decision_id + **rearm_generation = Gr** |
| started / verifying | blocked_post | 结果需人工裁决 | 服务 | 同上 + 当前状态 + **verify_started_at IS NULL AND verify_deadline_at IS NULL（离开 verifying 那一支显式清钟）** + **rearm_generation = Gr** |
| blocked_post | done / failed | decision 收口 | 服务 | 同上 + status=blocked_post + decision_id + **rearm_generation = Gr** |
| started | done | report 通过 schema 与判定；**只调 `applyReport(node_run_id, attempt, report, expected_status={started}, generation=Ga)`** | 执行器回写 | 同上 + status=started + **now <= effective_deadline_at（`effective_deadline_at` = 有 `action_deadline_at` 就用它，否则用 `deadline_at`）** + **attempt（回写三元组之一）** + **action_generation = Ga（回写三元组之二）** + **report_id（回写三元组之三）** |
| dispatched / started / verifying / timing_out / stopping / **startup_unknown** | paused_bridge_missing | 执行桥不可用（executor-bound **六态**）；**resume_state=startup_unknown 的那一支：本迁出清空 `startup_unknown_deadline_at` 并记 `startup_unknown_paused_at = now`**（钟暂停，桥预算接管）；**verifying 那一支：本迁出清空 `verify_started_at` / `verify_deadline_at`**（验证窗在桥断期间停走，恢复时按 §3 桥断时钟矩阵按暂停时长补时） | 服务 | 同上 + 当前状态 + resume_state + **startup_unknown_deadline_at IS NULL（仅 startup_unknown 那一支清钟）+ startup_unknown_paused_at = now** + **verify_started_at IS NULL AND verify_deadline_at IS NULL（仅 verifying 那一支清钟——验证窗在桥断期间停走，恢复时按 §3 桥断时钟矩阵按暂停时长补时）** + **rearm_generation = Gr** |
| paused_bridge_missing | dispatched / started / verifying / timing_out / stopping / **startup_unknown** | 桥恢复，按 resume_state 逐态重入（**startup_unknown 重入时不重置 `startup_unknown_deadline_at`**：为空时按 `startup_unknown_paused_at + 120 秒` 还原，连 paused_at 也没有才补写 now + 120 秒并 Gr+1） | 服务 | 同上 + status=paused_bridge_missing + resume_state + **startup_unknown_deadline_at（空则按 paused_at + 120s 还原，都空才 now + 120s）** + **verify_started_at = now、verify_deadline_at = now + verify_timeout + 本次桥断时长（仅 resume_state=verifying 那一支写；按暂停时长补时，§3 桥断时钟矩阵）** + **rearm_generation = Gr**（**凡重新武装 action_deadline_at 的路径（桥恢复、继续等、围栏撤销）在同一笔 CAS 里 Gr+1 写回**） |
| 任意非终态 | orphaned | 判活确认死亡、**且该节点可重放** → 落 orphaned（**节点终态**，封存留账）；可重放指动作幂等或可用补偿重做 | sweep | 同上 + 当前状态 + **verify_started_at IS NULL AND verify_deadline_at IS NULL（离开 verifying 那一支显式清钟）** + **rearm_generation = Gr** |
| 任意非终态 | failed | 判活确认死亡、**且该节点不可重放** → 直接落 failed（**不经 orphaned**，没有替代动作可挂） | sweep | 同上 + 当前状态 + **verify_started_at IS NULL AND verify_deadline_at IS NULL（离开 verifying 那一支显式清钟）** + **rearm_generation = Gr** |
| orphaned | orphaned | **重投挂账**：orphaned 节点重投时**新建 node_run**（`origin_node_run_id` 指向旧行），并把新行 id 回写旧行的 `replacement_node_run_id`（旧行是终态，**不迁出**）——旧行的责任链由此可追 | 服务 | 同上 + status=orphaned + **replacement_node_run_id** + **rearm_generation = Gr** |
| 任意非终态 | indeterminate_side_effect | executor 已停、动作未知 | 服务 | 同上 + 当前状态 + **verify_started_at IS NULL AND verify_deadline_at IS NULL（离开 verifying 那一支显式清钟）** + **rearm_generation = Gr** |
| indeterminate_side_effect | done | **人裁决「确实发生了」**（resolution=confirm_applied）：动作状态未知但副作用确实产生 → 落 done 并标 applied、移出 pending 派生集合 | 服务（人裁决） | 同上 + status=indeterminate_side_effect + decision_id + revision + **evidence_id** + **hang_reason IS NULL** + **rearm_generation = Gr** |
| indeterminate_side_effect | superseded / failed | **人裁决「确实没发生」**（resolution=confirm_not_applied，**必须带 `evidence_id`**——对副作用的裁决走 `evaluateEvidence`，缺证据即拒）：**开工前先过 `report_contradicted` 检查**（旧 attempt 的迟到 report 与本裁决冲突 → 先挂起等那条 decision 收口，§3）；确认没发生且节点幂等 → **旧行落 `superseded`**、新 attempt 新建 node_run（`origin_node_run_id` 指向本行、`replacement_node_run_id` 回写，**新 executor**；**新 attempt 的 Ga 在重新派发时 +1——自增点在 `queued → leased → dispatched` 那笔 CAS，新 attempt 一律 Ga+1，不许回到 1**），不可重试 → failed | 服务（人裁决） | 同上 + status=indeterminate_side_effect + decision_id + revision + **evidence_id** + **rearm_generation = Gr** + **hang_reason IS NULL** |
| startup_unknown / indeterminate_side_effect | done / failed | **`uphold_report`**：冲突裁决以迟到 report 为准，调 `applyReport(..., expected_status={startup_unknown, indeterminate_side_effect}, generation=Ga, decision={decision_id, revision, resolution: uphold_report})`；证据门不过即不可用，只能转 uphold_decision；report 走同一套 schema / 判定 / 证据门 | 服务（人裁决） | 同上 + 当前状态 + attempt + **action_generation = Ga** + **report_id** + **decision_id = D2 + revision = D2.revision**（裁决行 D2 的 CAS；D1 = 原裁决、挂起期间一直记在节点上，不动）+ **resolution=uphold_report** + 清 `hang_reason` / `contradiction_decision_id` + **来源为 `startup_unknown` 时清 `startup_unknown_deadline_at`** |
| startup_unknown / indeterminate_side_effect | superseded / failed | **`uphold_decision`**：维持原裁决 D1，驳回迟到 report。**先定义两个 id**：D1 = 原裁决（挂起前已确认的 `confirm_not_started` 或 `confirm_not_applied`，节点上记 `decision_id + revision`），D2 = 冲突裁决（`contradiction_decision_id` 指向的 `report_contradicted` decision）。**挂起期间节点上的 `decision_id + revision` 保持 D1，D2 只记在 `contradiction_decision_id`，不覆盖 D1。** **同笔事务**先把 D2 从活跃态 CAS 到 `rejected + closed`（带 D2 的 `decision_id + revision` 与状态白名单，冲突返回 `DECISION_REVISION_CONFLICT`，节点格不动），再按 D1 的 resolution 收口节点：D1 为 `confirm_not_started` / `confirm_not_applied` 且节点幂等 → 旧行落 `superseded`、新建 attempt 新行（`origin_node_run_id` 指向本行，`replacement_node_run_id` 回写，新 executor）；不可重试 → `failed`。**节点 CAS 带** `status IN (startup_unknown, indeterminate_side_effect)` + `hang_reason = report_contradicted` + `contradiction_decision_id = D2` + `decision_id = D1` + `revision = D1.revision` + `resolution=uphold_decision` + 清 `hang_reason` / `contradiction_decision_id`；来源为 `startup_unknown` 时同时清 `startup_unknown_deadline_at`。迟到 report 永久标 `stale`，只留账、不重放、不覆盖原裁决 | 服务（人裁决） | 同上 + 当前状态 + `decision_id = D1` + `revision = D1.revision` + `resolution=uphold_decision` + `rearm_generation = Gr` + 清 `hang_reason` / `contradiction_decision_id` + 来源 startup_unknown 时 `startup_unknown_deadline_at IS NULL` + superseded 支回写 `replacement_node_run_id` |
| indeterminate_side_effect | abandoned_unverified | **人放弃**（resolution=abandon）：动作状态未知、副作用未验证 → 落 abandoned_unverified 并挂 run 级 abandon_ack | 服务（人裁决） | 同上 + status=indeterminate_side_effect + decision_id + revision + **hang_reason IS NULL** + **rearm_generation = Gr** |
| indeterminate_side_effect / abandoned_unverified | failed_with_unverified | **补偿执行失败**（触发事件 `compensation.failed`）：补偿动作执行失败、或描述符里的 `verify` 没通过 → **这笔副作用退不回去**，节点落 `failed_with_unverified`（**不是 failed**，§11 事件名与证据字段）；**条件要求两条同时成立**：事件行带 `compensation_id`（幂等键 hash(node_run_id + attempt + descriptor_version)）**且**补偿的 `verify` 证据不成立（`compensation_evidence.verify` 不通过）——只发 `compensation.failed` 而没有 verify 结论的，不许直接落这一支 | 补偿执行器（事件 `compensation.failed`） | status=当前状态（**旧值 indeterminate_side_effect / abandoned_unverified → 新值 failed_with_unverified**）+ **compensation_id（必带，幂等键）** + **compensation_evidence.verify = 不成立（补偿的 verify 证据不成立才落这一支）** + **attempt（不变：补偿失败不换 attempt）** + **action_generation = Ga（同一 attempt 的代次）** + **hang_reason IS NULL** + **rearm_generation = Gr（Gr 不 +1：补偿失败不重新武装任何时限）**；**幂等键 = compensation_id**——同一 compensation_id 只落一次，不重复上报、不重复执行补偿 |
| failed / indeterminate_side_effect | failed_with_unverified | **compensable 节点发现无可执行补偿**：节点声明 compensable，但补偿描述符在运行时不可执行（补偿工具未注册 / 参数不可解析 / 描述符缺失）→ 副作用退不回去，**不许按 failed 收口**——失败的账不许把未验证副作用一笔勾销（§11）；**与上一行分得开**：上一行是「补偿执行了但失败」（有 `compensation.failed` 事件），本行是「补偿根本没执行成」（**没有 compensation_id**） | 服务（补偿计划器） | status=当前状态（**旧值 failed / indeterminate_side_effect → 新值 failed_with_unverified**）+ **compensation_id IS NULL（没有可执行的补偿，故无补偿幂等键）** + **attempt（不变：不换 attempt）** + **action_generation = Ga（同一 attempt 的代次）** + **hang_reason IS NULL** + **rearm_generation = Gr（Gr 不 +1）**；**幂等键 = (node_run_id, attempt, "no_executable_compensation")**——同一 attempt 只判一次，不重复上报 |

**node_run 的终态集合（唯一权威，全文只有这一份）**：`{ done, failed, timeout, abandoned_unverified, failed_with_unverified, orphaned, superseded }`。**其它章节（§2 / §3 / §7 / §9 / §11 / §14）一律只引用这一行，不许另列清单、不许另造同义词**（`unverified` / `partial` / `abandoned` 之类一律不认）。**`superseded` 的语义写死**：被新 attempt 取代，自身既不算成功也不算失败；run 级判定把它当**中性终态**——`pending_irreversible_children` 自然为空，失败类判定不把它算进去，全 done 判定把它视同 done 一侧；它只带 `replacement_node_run_id`，不再承接任何回写。

**迁移表的统一前置条件（`report_contradicted` 挂起闸门）**：凡从 `startup_unknown` 或 `indeterminate_side_effect` 迁出的行，CAS 额外带 `AND hang_reason IS NULL`（逐行已内联，不只靠本总则）；挂起时（`hang_reason = report_contradicted`）唯一能走的是两条 resolution 行（`uphold_report` / `uphold_decision`）与桥断边（共三处路径） `→ paused_bridge_missing`，其余出口一律 STALE_HANG。收口时同笔事务清 `hang_reason` 与 `contradiction_decision_id`。

**行 → 幂等键 / 唯一约束对照表（幂等不许只靠应用层「查一下再写」，每一行都要有数据库兜底）**：

| 迁移 / 写入行 | 幂等键或唯一约束 | 重放时的行为 |
| --- | --- | --- |
| report 接受（任意 → done / failed） | `report_registry.report_id` PRIMARY KEY | 同一 report 重放命中同一行，返回原 `ApplyResult`，不重复执行、不覆盖已落 state |
| report 队头与跳过判定 | `UNIQUE(node_run_id, attempt, seq)` | 同一 attempt 同一 seq 只一条；重放取队头，缺号即卡住，不许跳读 |
| decision revision 追加（含 continue_wait） | `UNIQUE(decision_id, revision)` | 同一 revision 重放命中原行，不新增 revision；冲突走 `DECISION_REVISION_CONFLICT` 拒绝，不静默覆盖 |
| 同 node_run + kind 的活跃 decision | partial unique index `decisions_node_kind_uq` | 冲突即合并到原行、revision+1，不新建第二行 |
| run 级 decision（abandon_ack 等） | partial unique index `decisions_run_kind_uq` | 同上；`node_run_id IS NULL` 的行不许撞键 |
| 节点迁移事件 | `node_run_events.event_seq` UNIQUE | 同一事件重放不追加第二条；seq 由服务端单调分配 |
| 同一节点行的 attempt | `UNIQUE(run_id, node_id, attempt)` + `CREATE UNIQUE INDEX node_runs_origin_uq ON node_runs(origin_node_run_id) WHERE origin_node_run_id IS NOT NULL` | 同一 run / node / attempt 只许一行；新 attempt 必换 `node_run_id`（服务端生成），换 id 也躲不过 UNIQUE；同一旧行只许建一行新行，第二行被 `node_runs_origin_uq` 拒。重试时旧行先落 `superseded` 终态，再建新行（`origin_node_run_id` / `replacement_node_run_id` 成对回写）；旧行仍是非终态就建新行 = 违反「无非终态 node_run」的收口条件 |
| 补偿执行 | `compensation_id = hash(node_run_id + attempt + descriptor_version)` UNIQUE | 同一补偿重放命中同一 `compensation_evidence`，不重复执行、不重复上报 failed |

**迁移表逐行用例清单（M-01…M-61；编号按新增顺序追加，不按表内行序；M-01…M-55 与 M-57 逐行对应，M-56 是跨行闸门、M-58 是重试建行、M-59 是 uphold_report 收口、M-60 是 uphold_decision 收口、M-61 是 confirm_started 在 `has_tool_call=true` 时必须接受；断言列写的是必须落库的字段，光改内存状态不算通过）**：

| 用例 | 迁移行 | 场景 | 断言 |
| --- | --- | --- | --- |
| M-01 | （建）→ queued | 无空闲 slot | `status=queued`；`epoch` 写入；不得提前占 lease |
| M-02 | queued → leased | 抢到 slot | `status=leased`、`lease_id` 非空；CAS 带 `status=queued` |
| M-03 | leased → dispatched | send 返回 | `status=dispatched`；`action_generation = 旧值 + 1`（首次 = 1），不许重置回 1 |
| M-04 | dispatched → started | 观测到首个 step / turn boundary 或 tool.call | `status=started`；`attempt` + `lease_id` + `action_generation=Ga` 三项同带 |
| M-05 | dispatched / started → startup_unknown | `startup_timeout` 到点且事实不明 | 不生成 `action_deadline_at`；`startup_unknown_deadline_at` 与 `unknown_reason` 二选一写入；`rearm_generation=Gr` |
| M-06 | startup_unknown → superseded | `confirm_not_started` 且幂等，`has_tool_call=false`（happy path） | 服务端先查 `executor.state`（`has_tool_call=true` 拒 + deleted / unloaded / 未知 / 桥断四个 `executor.state` 分支，共五条，各有落点）；**`has_tool_call=true` 必须返回 RESOLUTION_NOT_AVAILABLE，不得落 superseded**；清 `startup_unknown_deadline_at`；`decision_id + revision` 落库；旧行 `status=superseded` 且**不再改 attempt**；`replacement_node_run_id` 回写新行；旧 Ga 保留，新 attempt 重新派发时 +1 |
| M-07 | startup_unknown → failed | `confirm_not_started` 且不可重试 | 清钟；`decision_id + revision` 落库；不走重试分支 |
| M-08 | startup_unknown → stopping | `confirm_started` | 查 `executor.state`；清钟；起算 `action_deadline_at` 且 `Gr+1`；`action_start_source` 写入 |
| M-09 | startup_unknown → stopping | `confirm_started_attested` | 与 M-08 共用前置检查；`action_start_source=human_attested`；`human_attested` 不得写进 `evidence_id` |
| M-10 | startup_unknown → abandoned_unverified | `resolution=abandon` | 清钟；`decision_id`；挂 run 级 `abandon_ack`；不得凭 executor 已删写 `stopped_at` |
| M-11 | startup_unknown → done / failed | executor 仍活、迟到 report 落回 | 只走 `applyReport(..., expected_status={startup_unknown}, generation=Ga)`；强证据门不放宽；清钟；report 入 registry（含 rejected） |
| M-12 | startup_unknown → indeterminate_side_effect | executor 已 deleted 或状态查不实 | 清钟；`decision_id`；不得在 startup_unknown 里硬收口 |
| M-13 | startup_unknown → startup_unknown | executor unloaded | 先 resume 再 reattach；钟为空按 `paused_at + 120s` 还原，都空才 `now + 120s` 且 `Gr+1` |
| M-14 | startup_unknown → paused_bridge_missing | 桥断 | 清 `startup_unknown_deadline_at`、记 `startup_unknown_paused_at=now`；`resume_state=startup_unknown` |
| M-15 | started → verifying | verifier 已派 | `verify_started_at` 与 `verify_deadline_at=now+verify_timeout` 同写；`Gr` 不变（这条是派发不是续期） |
| M-16 | verifying → done / failed | verdict 到达 | 只走 `applyReport(..., expected_status={verifying}, generation=Ga)`；`verdict_id` + `report_id` 落库；清 verify 钟 |
| M-17 | verifying → blocked_post | `verify_timeout` 到点 | 生成 `verify_human` decision；清 `verify_started_at` / `verify_deadline_at`；默认不判失败 |
| M-18 | verifying → failed | `fail_on_timeout=true` 且 `side_effect_verified_none=true` | 落 `failed`；`stop_evidence` 非空；不得落 `failed_with_unverified` |
| M-19 | verifying → failed_with_unverified | `fail_on_timeout=true` 且副作用未核实为没发生 | 落 `failed_with_unverified`；`stopped_at` 非空也不能改判 failed |
| M-20 | started → waiting | wait 语义节点 | `status=waiting`；`Gr` 写入；动作时限按 wait 语义处理 |
| M-21 | waiting → dispatched | 事件命中且抢到 slot | `status=dispatched`；`Gr` 写入；不得复用旧 lease |
| M-22 | waiting → timeout | `max_wait` / `event_timeout` 到点 | `status=timeout`；`Gr` 写入；走节点终态 |
| M-23 | started → timing_out | deadline 到点且 `cancel_result=interrupted` | 只有 interrupted 才立围栏；`Gr` 写入；`not_interruptible` / `unknown` 必须改迁 stopping |
| M-24 | timing_out → timeout | 已停且纯 / 可补偿 | `cancel_result=interrupted`；`Gr` 写入；围栏保持 |
| M-25 | timing_out → indeterminate_side_effect | 已停、irreversible 且状态未知 | `Gr` 写入；`stopped_at` 如无可核事实则不写 |
| M-26 | timing_out → stopping | 停不下或 whenIdle 超时 | 撤围栏、重放被挡 report；`transition_reason` 四值之一；`action_deadline_at` 重新武装且 `Gr+1` |
| M-27 | dispatched / started → stopping | 已观测 tool.start 但停不下来 | 不立围栏；`cancel_result ∈ {not_interruptible, unknown}`；`action_deadline_at` 延长且 `Gr+1` |
| M-28 | dispatched / started → timeout | `has_tool_call=false` 且 cancel interrupted | 只许幂等节点；`cancel_result=interrupted`；`Gr` 写入；不可重试节点改走 failed |
| M-29 | dispatched / started → done / failed | `already_stopped` 且有可核对结论 | 写 `stopped_at` + `stop_evidence`；带 `report_id`；`Gr` 不 +1；不进 timing_out |
| M-30 | dispatched / started → indeterminate_side_effect | `already_stopped` 但结论不可核对 | 写 `stopped_at` + `stop_evidence`；`Gr` 不 +1；不得落 timeout / failed |
| M-31 | dispatched / started → startup_unknown | 启动层到点但未观测 | 与 M-05 同；不得进 stopping |
| M-32 | stopping → done / failed | 动作自然完成（含迟到） | 只走 `applyReport(..., expected_status={stopping}, generation=Ga)`；不受 deadline 约束；`report_id` 落库 |
| M-33 | stopping → done | `confirm_applied` | `stopped_at` 与 `evidence_id` 缺一不可；`Gr` 写入；从 pending 派生集合移出 |
| M-34 | stopping → stopping | `continue_wait` | 同一 decision 行追加 revision；`wait_extensions+1`、`Gr+1`、`Ga` 不变；行状态保持 pending / acknowledged |
| M-35 | stopping → indeterminate_side_effect | 已停且状态未知 | `Gr` 写入；不得写 applied |
| M-36 | stopping → abandoned_unverified | `resolution=abandon` | `Gr` 写入；`decision_id`；挂 run 级 `abandon_ack` |
| M-37 | abandoned_unverified → stopping | `abandon_ack` 被驳回 | `abandon_ack decision_id` 写入；`Gr+1`；节点回 executor 手上 |
| M-38 | abandoned_unverified → abandoned_unverified | 确认已停 / 核实无副作用 | 只由确认动作写 `stopped_at` / `side_effect_verified_none`，迟到 report 不得自动写 |
| M-39 | queued / leased → blocked_pre | 不可逆动作需前置审批 | 清 `lease_id`、释放 slot；`resume_state=queued`；`Gr` 写入 |
| M-40 | blocked_pre → queued | 审批通过 | `lease_id IS NULL` 后才允许重新排队；不复用旧租约 |
| M-41 | blocked_pre → failed | 审批拒绝 / 超时默认动作 | `decision_id` 落库；`Gr` 写入 |
| M-42 | started / verifying → blocked_post | 结果待人工裁决 | 离开 verifying 必须清 `verify_started_at` / `verify_deadline_at`；`Gr` 写入 |
| M-43 | blocked_post → done / failed | decision 收口 | `decision_id` 落库；`Gr` 写入 |
| M-44 | started → done | report 通过 schema 与判定 | 只走 `applyReport(..., expected_status={started}, generation=Ga)`；`attempt` + `Ga` + `report_id` 三元组齐 |
| M-45 | 六态 → paused_bridge_missing | 桥不可用 | 写 `resume_state`；startup_unknown 支清钟并记 `paused_at`；verifying 支清 verify 钟 |
| M-46 | paused_bridge_missing → 六态 | 桥恢复 | 按 `resume_state` 重入；startup 支不重置钟（空则按 `paused_at+120s`）；verifying 支按桥断时长补时 |
| M-47 | 任意非终态 → orphaned | 判活死亡且可重放 | 封存留账；离开 verifying 清 verify 钟；`Gr` 写入 |
| M-48 | 任意非终态 → failed | 判活死亡且不可重放 | 不经 orphaned；`Gr` 写入；清 verify 钟 |
| M-49 | orphaned → orphaned | 重投 | 新建 node_run 并写 `origin_node_run_id`；旧行 `replacement_node_run_id` 回写；旧行不迁出 |
| M-50 | 任意非终态 → indeterminate_side_effect | executor 已停、动作未知 | `Gr` 写入；清 verify 钟；不得猜「没发生」 |
| M-51 | indeterminate_side_effect → done | `confirm_applied` | `evidence_id` 必带；`decision_id + revision` 落库；移出 pending 派生集合 |
| M-52 | indeterminate_side_effect → superseded / failed | `confirm_not_applied` 且带 `evidence_id` | 先过 `report_contradicted`；旧行 `status=superseded`；新行 `origin_node_run_id` 指向旧行、`attempt=旧+1`；新 attempt 重新派发时 Ga+1；旧 Ga 保留在旧行 |
| M-53 | indeterminate_side_effect → abandoned_unverified | `resolution=abandon` | `decision_id + revision`；挂 run 级 `abandon_ack` |
| M-54 | indeterminate_side_effect / abandoned_unverified → failed_with_unverified | `compensation.failed` 且 verify 不成立 | `compensation_id` 必带且幂等；`attempt` 不变；`Gr` 不 +1；不许落 failed |
| M-55 | failed / indeterminate_side_effect → failed_with_unverified | 无可执行补偿 | `compensation_id IS NULL`；幂等键 `(node_run_id, attempt, no_executable_compensation)`；`Gr` 不 +1 |
| M-56 | report_contradicted 挂起（跨行闸门，不对应单行） | 迟到 report 与人裁决冲突 | 节点留在原格；`hang_reason=report_contradicted` + `contradiction_decision_id`；**所有普通出口带 `hang_reason IS NULL`，冲突时一律 STALE_HANG**；新 attempt 被挡；只认 `uphold_report` / `uphold_decision`，`expired` 无效 |
| M-57 | startup_unknown → startup_unknown（continue_tracking） | executor 仍活且桥可用，人点继续跟 | 不迁出；钟重写为 `now + 120s` 且 `Gr+1`；不生成 `action_deadline_at`；桥断 / deleted / 状态未知三支拒绝（RESOLUTION_NOT_AVAILABLE） |
| M-58 | （建）→ queued（重试新行） | 旧行 superseded / orphaned 后重投 | 新行 `origin_node_run_id` 指向旧行、`attempt=旧+1`；旧行 `replacement_node_run_id` 回写；同一旧行只建一行；**同 `run_id / node_id / attempt` 换新 `node_run_id` 插入必须被 `UNIQUE(run_id, node_id, attempt)` 拒**；同一 `origin_node_run_id` 建第二行必须被 `node_runs_origin_uq` 拒 |
| M-59 | startup_unknown / indeterminate_side_effect → done / failed（uphold_report） | 人裁决以迟到 report 为准 | `decision_id = D2 + revision = D2.revision`（D2 = `contradiction_decision_id` 指向的冲突裁决，由 applyReport 第 6 参收口）与 `resolution=uphold_report` 落库；D1（原裁决）在节点上不动；applyReport 先 CAS decisions（revision + 活跃状态），冲突 `DECISION_REVISION_CONFLICT` 且节点格不动；节点 CAS 带 `expected_status={startup_unknown, indeterminate_side_effect}` + `action_generation=Ga` + `report_id`；证据门不过 → RESOLUTION_NOT_AVAILABLE，只能转 uphold_decision；成功后清 `hang_reason` / `contradiction_decision_id`，来源为 `startup_unknown` 时 `startup_unknown_deadline_at IS NULL`，decision 落 approved 并 closed（resolved） |
| M-60 | startup_unknown / indeterminate_side_effect → superseded / failed（uphold_decision） | 人裁决维持原裁决 D1、驳回迟到 report | D2 落 `rejected + closed`；节点按 D1 的 `decision_id + revision` 收口（`rearm_generation=Gr` 且不 +1，不占 Ga）；D2 与节点 CAS 同事务；清 `hang_reason` / `contradiction_decision_id`；来源为 `startup_unknown` 时清 `startup_unknown_deadline_at`；superseded 支：新建行 `origin_node_run_id = 旧行.node_run_id`、`attempt = 旧 attempt + 1`、旧行 `replacement_node_run_id` 回写；failed 支：`status=failed`、不建新行；迟到 report 标 stale；D2 revision 过期时节点一个字节不动 |
| M-61 | startup_unknown → stopping（confirm_started，且 `has_tool_call=true`） | 已观测 tool.start，人确认已开跑 | `has_tool_call=true` 只拒 confirm_not_started，不得拒 confirm_started；节点迁 stopping，`action_start_source=human_confirmed`；清 `startup_unknown_deadline_at`；`Gr+1`；旧 executor 保留 |


**run 级结果判定（run 落终态前必须先跑一遍，优先级写死，先看子节点、再定 run）**：run 的终态**不许**只看「该 run 下没有非终态 node_run」就落 `succeeded`——失败子节点（`failed` / `timeout` / `failed_with_unverified`）与失联子节点（`orphaned`）**都是节点终态**，照样满足「无非终态 node_run」，run 却会因此落 succeeded，账就假收口了。所以 run 落终态前**必须**先跑下面三条判定，**从上到下取第一条命中的**：

1. **有失败类子节点**（该 run 下存在子节点落 `failed` / `timeout` / `failed_with_unverified`）→ run **只能落** `failed` 或 `failed_with_unverified`（具体哪一个由第七条按「有没有未验证副作用」分叉），**不许落** `succeeded` / `succeeded_with_unverified`。
2. **有未被替换的 `orphaned` 子节点**（该 run 下存在 `orphaned` 且其 `replacement_node_run_id` 为空）→ run **只能落** `orphaned`，或**留在 paused** 等人处理（等重投的新行接上、旧行的 `replacement_node_run_id` 被写上之后，这条 orphaned 才算被替换掉，见 §8 `orphaned → orphaned` 行）；**不许落** `succeeded`。**`orphaned` 是节点终态，但不是「事情做完了」**——它的责任链还没接上。
3. **全部子节点 `done` 或 `superseded`**（或已核实无副作用的放弃：`abandoned_unverified` 且 `side_effect_verified_none = true`）→ **才允许** run 落 `succeeded`。**`superseded` 是中性终态**：旧 attempt 被新行取代，新行才是这条责任链的当前尝试；判定时只看新行，不把旧行算成功也不算失败。

这三条判定在**同一笔事务**里与 run 终态 CAS 一起跑（见下方终态 CAS 的前置条件），**顺序不可调：先 1 再 2 再 3**。**run 的终态取值一律引用本节 run 迁移那行的枚举（唯一权威），这里只写判定顺序，不另列清单。**

`dispatched → started` 只认 step / turn boundary 或第一次工具调用的观测；`orchestra_started` 回执只记 claimed_started_at，不参与计时、不触发迁移。

**代次要分两种，混成一种就会把合法回写挡掉**：**`action_generation`（Ga）跟着动作走**——**自增点唯一：`leased → dispatched` 派发那一笔 CAS**。**首次派发写 1；此后每一个新 attempt 或重开动作一律 Ga+1**（CAS 带的是读到的旧 Ga，成功后新值 = 旧 Ga + 1），**新 attempt 一律 Ga+1，绝不许把 Ga 重置回 1**——重置成 1 会让旧 attempt 发出的 report（带着旧 Ga）撞上新一代的栅栏，栅栏就白设了。同一 attempt 内不重新武装动作时不 +1（续期只动 Gr，不动 Ga），**回写用它**；**`rearm_generation`（Gr）跟着续期走**——每次「继续等」重新武装 +1，**定时器到点、decision 收口、sweep 恢复用它**。所有 stopping 相关 CAS 都必须带 `AND <对应代次> = 读到的值`：定时器类带 Gr，回写类带 Ga；re-arm 之后旧定时器手里的 Gr 已过期，它的 CAS 落空（STALE_REARM），不会把人刚点下的「继续等」提前推走。**为什么不能合成一个**：续期时动作没重启，Ga 不变——若把 Gr 也拿去挡回写，续期前发出的那条合法迟到回写会被判 STALE_GENERATION 而丢掉，账上停在 stopping，现实里动作其实已经做完了；反过来若改成「服务读当前代次」，旧回写每次都匹配，栅栏等于没有（§3.4f 第 1 条）。

**迁移类型 → 代次矩阵（写死，不许逐行现想）**：

| 迁移类型 | 用哪个代次 | 典型迁移 |
| --- | --- | --- |
| 执行器回写类（report 到达） | **Ga** | dispatched → started；started → done；stopping → done / failed；verifying → done / failed（**verifier 的 verdict 归这一类**——它由 verifier 执行器回写，不归「服务裁决」，所以带 Ga 不带 Gr）；startup_unknown → done / failed（executor 仍活那一支）；**uphold_report（带 decision 的迟到 report 回写）也走 Ga** |
| 定时器到点类 | **Gr** | action_deadline 到点生成 decision；startup_timeout 到点；**verifying → blocked_post（verify_timeout 到点，默认不判失败）**；**verifying → failed（fail_on_timeout 策略）** |
| 裁决收口类（decision 落地） | **Gr** | stopping → indeterminate_side_effect；stopping → abandoned_unverified；**stopping → done（confirm_applied）**；**indeterminate_side_effect → done（confirm_applied）**；**indeterminate_side_effect → superseded / failed（confirm_not_applied，旧行落 superseded、新行另建）**；**indeterminate_side_effect → abandoned_unverified（abandon）**；abandoned_unverified → stopping（并 Gr+1）；blocked_pre → queued / failed；startup_unknown 的裁决出口（**需要重新武装时限的出口——stopping / continue_tracking / 以及钟为空需补写的重入——并 Gr+1；终态出口只 CAS Gr，不 +1**） |
| 恢复类（sweep / 桥恢复） | **Gr** | paused_bridge_missing → 各态；timing_out → stopping；startup_unknown 的三个出口 |

**每行 CAS 都要显式写清代次，不许用「同上」带过**：§8 迁移表已逐行补齐——回写类带 `action_generation = Ga`，其余（定时器 / 裁决 / 恢复 / 引擎判定）带 `rearm_generation = Gr`，一条迁移一行代次，逐行现想就会漏。**回写类的 CAS 还必须带齐 attempt + Ga + report_id 三元组**（attempt 挡「哪一次尝试」、Ga 挡「这一代动作」、report_id 挡「同一次回写被收两遍」），三条一行都不许少——§8 五组回写边已逐行补齐。**凡重新武装 `action_deadline_at` 的路径（继续等、桥恢复、围栏撤销、startup_unknown 落 stopping），在**同一笔 CAS** 里 Gr+1 写回**——CAS 带的是读到的旧 Gr，成功后新值是 Gr+1；不写回的话，旧定时器手里的 Gr 还能撞上这条路径，把人刚点下的「继续等」提前推走。

一句话判据：**凡是「人裁决或引擎判定」驱动的迁移用 Gr，凡是「执行器回写」驱动的迁移用 Ga**（verifier 的 verdict 由 verifier 执行器回写，算 Ga 这一边）。**唯一例外是 `uphold_report`：它虽然由人裁决触发，节点 CAS 仍是 report 回写语义，用 Ga；decision 行用 `decision_id + revision` 收口，不重新武装任何时限，不占 Gr。**续期只动 Gr、不动 Ga——这条一旦混用，续期前发出的旧定时器就能从一条看起来合法的路径把节点推走，而账上还会显示它是在正常收口（§3.4g 第 1 条）。

**前置审批的时序**：前置门在 `send` 之前，所以入口只有 `queued` / `leased`，没有 `dispatched → blocked_pre`。进入 blocked_pre 时**释放 lease 与 slot**——人工审批可能等两小时，三个并发位不能被几个前置门占死，租约也不该在这两小时里空转过期。批准后回到 `queued`，重新抢 slot 走 `queued → leased → dispatched`，attempt 号不变（它还没执行过）。驳回或超时按节点定义的默认动作走，默认 failed。

**不可中断动作的格**：`stopping` 承接「已宣告要停、但动作还在跑」。它不是 timeout：动作在 action_deadline_at 内自然完成就正常收，不算超时失败；只有 executor 真停了、动作状态未知，才进 indeterminate_side_effect。

**前置审批批准后走原 attempt 还是新 attempt**：走**原 attempt**（attempt 不变），因为它尚未执行过。进入 blocked_pre 时 lease_id 已置 null、slot 已释放，所以批准后**从 `queued` 重新起**：queued → leased（重抢 slot）→ dispatched，不复用旧租约、不从 leased 直接派发。审批驳回 → failed（或按节点定义起新 attempt）。

**run 状态不用单个 enum，用三组标志**：`running`（有活动节点）、`paused_reasons`（集合，可同时含 decision / bridge_missing / indeterminate_side_effect / action_deadline / unverified_side_effect）、`settling`（还有未结算的 irreversible 子节点）。一个 parallel run 既可能有未结算的 irreversible 子节点（settling）又有等裁决的 decision（paused），单 enum 表达不了。

**这三组标志一律派生，不手工置位**：每次涉及 run 的迁移，在**同一笔事务**里调 `derive_run_state(run_id)` 重算 `running` / `paused_reasons` / `settling` / `pending_irreversible_children` / `display_status` / `reasons[]` 并写回；任何写路径都不许手工清某个 reason。派生规则写死：`pending_irreversible_children` = 该 run 下 `side_effect_policy = irreversible` 且 `status NOT IN (<§8 的 node_run 终态集合>)` 的 node_run 集合（**终态集合只从 §8 引用，不在这里另列**），节点一进终态即移出（与状态迁移同事务）；`paused_reasons` 里的 `action_deadline` / `unverified_side_effect` 由这批节点派生。**属性测试**：任意一次迁移之后，投影字段必须等于重新 derive 的结果（逐条迁移跑一遍不变量测试），不允许出现「标志说 running、实际还有未结算」的窗口。**性能口径（不许全量扫描）**：derive_run_state 不许每次迁移都全表扫 node_runs 与 decisions——维护增量计数与部分索引（按 run_id + status 的计数、pending_irreversible_children 的增量集合），只更新**变化的**投影字段；面板读路径可以现算，终态 CAS 走轻量摘要（计数 + EXISTS 判定），不触发全量重算。**规模测试**：N=100 / N=1000 的 parallel 扇出下，单次迁移的写入次数与耗时必须随 N 线性增长，不是平方。

run 迁移：running → succeeded / failed；running → settling → succeeded / failed；settling ↔ paused 可双向叠加；paused → running（decision 收口且理由清空）；paused → failed（decision 驳回或过期）；paused → succeeded；**paused → succeeded_with_unverified**（该 run 下仍有 abandoned_unverified **且其副作用尚未被核实为没发生**（`side_effect_verified_none` 不为 true；**`stopped_at` 不算核实**，口径唯一见终态 CAS 第六条）——**终态只能落它，不许落 succeeded**）；**paused → failed_with_unverified**（该 run 下有节点落 failed，**且**另有节点停在 abandoned_unverified / failed_with_unverified 未验证——「失败 + 有未验证副作用」不许折成 failed）；任意 → orphaned。**run 落终态前必须先跑一遍本节上方的 run 级结果判定（优先级写死：失败类子节点 → 未被替换的 orphaned 子节点 → 全 done），不许只看「没有非终态 node_run」就落 succeeded。****run 的终态枚举以本行为准：{succeeded, failed, succeeded_with_unverified, failed_with_unverified, orphaned}**——其它地方（面板、API、事件、文档）只许引用这五个名字，不许另造同义词（`success_with_unverified` / `partial` 之类一律不认）。**succeeded_with_unverified 是独立终态，不等于 succeeded**：它表示「该做的都做完了，但有一笔副作用没验证过」，面板与 API 都要显式显示这个区别，不许折进 succeeded。**failed_with_unverified 同理**：它表示「这次没成，而且有一笔副作用没验证过」——**失败的账不许因为「反正失败了」就把未验证副作用一笔勾销**（节点层与 run 层同名同义，见 §8 终态集合与本节）。**按 decision kind 特判**：`abandon_ack` 这类「签字确认未验证副作用」的 decision 过期时**留在 paused**，不迁 failed——过期不是默认放行，一笔没验证的副作用不许靠超时消失；其余 kind 的过期按定义默认动作收口。

**对外投影（面板与 API 都读这个）**：面板不直接显示三组标志，显示派生字段 `display_status` 与 `reasons[]`。
- `display_status`：**先判终态**——run 已进终态（succeeded / failed / **succeeded_with_unverified** / **failed_with_unverified** / orphaned）→ 直接显示该终态名，**不再派生 paused / settling / running**（终态优先，免得账上已经收口、面板还在说 blocked）；非终态才按下面派生：`paused_reasons` 非空 → `blocked`；否则 `settling` 非空 → `settling`；否则 `running` 非空 → `running`；全空 → 终态。**blocked 优先于 settling，但 settling 标记仍保留**，面板同时显示两组——不能因为在等裁决，就让人看不见还有未结算的不可逆动作。终态那一支里 `succeeded_with_unverified` **单独显示、不折成 succeeded**（面板与 API 都要能让使用者看见「有一笔副作用没验证过」）；**`failed_with_unverified` 同样单独显示**，而且它比 `failed` 更刺眼——失败的那一笔还带着未验证副作用，看板上必须把「未验证副作用」的提示挂在旁边，不许只显示一个 failed 就让人以为账已经清干净。
- `reasons[]`：paused_reasons 的可读副本（decision / bridge_missing / indeterminate_side_effect / action_deadline / unverified_side_effect 及对应 id）。
- **`action_deadline` 与 `unverified_side_effect` 是派生理由，不是手工置位**：只要还有节点停在 stopping（动作超出声明上限），或有节点在 abandoned_unverified **且其副作用尚未被核实为未发生**（**判据只看 `side_effect_verified_none = true`**（且带 `stop_evidence`）——**`stopped_at` 不算核实**、签字不算核实、decision 的措辞不算核实；口径唯一，见 §8 终态 CAS 第六条），run 的 paused_reasons 就含这两项。所以「裁决完就恢复 running」不会发生——动作还在跑，账上就必须显示还在等风险。
- **迁入与投影必须同事务**：节点迁到 `abandoned_unverified` 与 run 的 `paused_reasons` 增 `unverified_side_effect` 写在同一笔事务里（节点行 CAS + run 行 revision 更新同笔）。否则中间那一瞬会出现「节点已放弃、run 却显示 running」——面板让人以为一切正常，账上却压着一笔没验证的副作用。
- 事件：`run.paused`（带 reasons[]）、`run.settling`、`run.resumed`、**`run.succeeded_with_unverified`**（run 落该终态时发一次，带未验证副作用的 node_run_id 列表）、**`run.failed_with_unverified`**（run 落该终态时发一次，同样带未验证副作用的 node_run_id 列表）。**`run.resumed` 只在 reasons 清空 且 settling=false 且 没有「副作用未验证」的 abandoned_unverified 时才发**（签字不算验证）——清掉一条 reason 就发一次 resumed 会让人以为全好了；理由未清空时只更新 `run.paused` 的 reasons；parallel run 还有未结算的不可逆子节点时，reasons 清空也不发 resumed，改发 run.settling。事件顺序固定：先 run.paused（加/减 reasons），再 run.settling，全部条件满足才 run.resumed。**run 落任一终态都要有对应事件**（`run.succeeded_with_unverified` 与 `run.failed_with_unverified` 都不许省——没有事件，面板与外部订阅者就看不见这次收口）。

**终态 CAS 的统一前置条件**（paused → failed、paused → succeeded、paused → succeeded_with_unverified、paused → failed_with_unverified、settling → succeeded / failed / failed_with_unverified、running → succeeded / failed / failed_with_unverified 全走这一条）：`paused_reasons` 为空 且 `settling` 为 false 且 `pending_irreversible_children` 为空 且 该 run 下无非终态 node_run。四条有一条不满足就不许进终态，留在原地（paused 就继续挂着，settling 就继续等）。**第五条（直接查事实，不靠派生集合）**：该 run 下**没有活跃 decision**——`NOT EXISTS (SELECT 1 FROM decisions WHERE run_id = ? AND status IN ('pending','acknowledged','blocked_for_human'))`。前四条看的是派生集合，万一某条写路径漏清或早清（手工置空、bug），活跃 decision 还在，run 也进不了终态。`running` 标志由前四条派生，不单独存——避免出现「标志说 running、实际全停了」的自相矛盾。**第六条（唯一权威口径：停止 ≠ 结算；只约束「要落 `succeeded` 的那一支」）**：**`succeeded` 只认 `side_effect_verified_none = true` 且带 `stop_evidence`（强证据）这一条**——`stopped_at` 只证明「动作停了」，**不证明「副作用没发生」**；`stopped_at` 单独存在时**只能支撑 `succeeded_with_unverified`**。所以凡是要落 `succeeded` 的 run，该 run 下**不许存在任何未验证副作用**：判据直接读节点行上的事实字段——**`side_effect_verified_none = true`（证据核实到副作用没生效）且带 `stop_evidence`（引用 evidence_id 或确认来源）**；**`stopped_at` 非空不算数**（停止不等于结算）。**`unverified_side_effect` 这条派生理由不得因 `stopped_at` 而消失**——它只在副作用被**核实为未发生**（`side_effect_verified_none = true`）时才消失；人签字、decision 的措辞、人的口述、「executor 后来 idle 了」、动作已停，都**不算核实**，一律算「未验证副作用」。没有 `side_effect_verified_none = true` 的行，就算其余一切齐备也一律算「未验证副作用」。只要还有一笔未验证副作用，`succeeded` 这一支就走不了，改走第七条的分叉。**本条是全文唯一权威口径**：§3 裁决出口、§3 终态与半态、§7 sweep、§9 abandon_ack、本节第七条与 run 级结果判定**一律引用本条**，不许另写一套判据（尤其是「`stopped_at` OR `side_effect_verified_none`」这种把两件事混成一件的写法，不许再出现）。

**第七条（成功 / 失败两支都按「有没有未验证副作用」分叉）**：**成功支**——该 run 下存在 `abandoned_unverified` 节点、且其副作用**尚未被核实为未发生**（`side_effect_verified_none` 不为 true；**签字不算核实、`stopped_at` 也不算核实**，判据唯一见第六条）时，终态**只能落 `succeeded_with_unverified`，不许落 `succeeded`**。**失败支**——该 run 下有节点落 failed（或 failed_with_unverified），**且**仍有未验证副作用时（未验证 = 尚未被核实为未发生，判据见第六条），终态**只能落 `failed_with_unverified`，不许落 `failed`**：失败的账不许因为「反正失败了」就把未验证副作用一笔勾销，**节点层与 run 层同名同义**（节点落 failed_with_unverified = 补偿失败且未验证副作用清单保留；run 有一节点 failed、另一节点停在 abandoned_unverified → run 落 failed_with_unverified）。这两个终态里 `paused_reasons` 允许**只剩** `unverified_side_effect` 一条（其余 reason 必须为空，且 settling=false、pending_irreversible_children 为空、无非终态 node_run、无活跃 decision），它作为终态快照里的风险说明留在 run 行上——**它是风险的说明，不是没干完的活**。

decision 迁移：

| 从 | 到 | 条件 | 触发者 |
| --- | --- | --- | --- |
| pending | acknowledged | 有人接了 | 人工或核心大脑 |
| pending | approved / rejected | 直接批复 | 人工或核心大脑 |
| acknowledged | approved / rejected | 批复 | 人工或核心大脑 |
| pending / acknowledged | pending / acknowledged（追加 revision，状态不变） | **续期（resolution=continue_wait）**：人点「继续等」→ **在同一行上追加一条 revision**（resolution=continue_wait、wait_extensions=N、revision+1），行的状态**保持 pending / acknowledged**，历史留在 revisions 里；**continue_wait 不经过 `approved`**——它不是「结论」，因此**不触发「结论落地即 closed」**（下一行的 closed 规则只对 approved / rejected / expired 生效） | 服务 |
| pending / acknowledged | blocked_for_human | 满 2 小时未决 | 计时器 |
| blocked_for_human | approved / rejected / expired | 人工批复；或再满 24 小时。**`report_contradicted` 只许 approved / rejected，`expired` 对它无效**（kind 级例外，见下方专段） | 人工或计时器 |
| blocked_for_human（`report_contradicted`） | approved / rejected | 人工收口：`uphold_report` → `approved`；`uphold_decision` → `rejected`；**没有 expired 这条路** | 人工 |
| pending / acknowledged / blocked_for_human | closed | **run 进终态**，同事务关闭 | 服务（closed_by=system，closed_reason=run_terminal） |
| pending / acknowledged / blocked_for_human | closed | **所属 node_run 进节点终态**（node_terminal），同事务关闭 | 服务（closed_by=system，closed_reason=node_terminal） |
| pending / acknowledged / blocked_for_human | closed | **同一 node_run + kind 产生了新的活跃 decision**，旧条自动让位 | 服务（closed_by=system，closed_reason=superseded） |
| approved / rejected / expired | closed | **结论已落地，收口**（同事务）：closed_reason=resolved（approved / rejected）或 expired_final（expired）；**「结论」只指 approved / rejected / expired 三者**——`continue_wait` 不是结论（它只是同一行上追加的一条 revision，行的状态保持 pending / acknowledged），**「结论落地即 closed」是 decision 收口的唯一口径** | 服务（closed_by=system） |

**closed 是 decision 的正式终态**，带 closed_at、closed_by=system、closed_reason（run_terminal / node_terminal / superseded / expired_final）；关闭时同事务撤通知、关 UI 待办，避免人再被叫起来批一个已经结束的 run。ack 与批是两笔不同的状态迁移，两条路都能直接到结论。**decision 的终态集合固定为 {approved, rejected, expired, closed}**——approved / rejected / expired 是**结论**，closed 是**收口**（run 进终态或所属节点进终态时同事务关闭）；不许有「结论了但没人收口」的悬空行。结论落地后同事务 closed（closed_reason=resolved / expired_final），所以「有结论」的行最终一定是 closed。**`continue_wait` 不是结论**——它只在同一行上追加一条 revision，行保持活跃（pending / acknowledged），**不走「结论落地即 closed」**；这类行由 run / node 进终态、或被别的 decision 取代时按 closed 规则收口（closed_reason=run_terminal / node_terminal / superseded，见上表）。

**唯一例外是 `report_contradicted`：它不落 `expired`。** 这类 decision 到 24 小时只升级 `blocked_for_human` 并推送，再过 24 小时也保持活跃（节点留在原格、run 保持 paused、新 attempt 继续被挡），**只能由 `uphold_report` / `uphold_decision` 收口**；`expired` 对它无效。**两条 resolution 与结论的映射写死**：`uphold_report` → `approved`，`uphold_decision` → `rejected`；两者都带 `resolution`，结论落地同事务 `closed`（closed_reason=resolved），并清节点上的 `hang_reason` / `contradiction_decision_id`。

**decision 要合并，不能一个异常一条**：① 同一 (node_run, kind) **只保留一行**（唯一键），续期与重开都在这一行上追加 revision，**不新建行**；② run 级聚合：面板按 run 聚合显示「N 条待裁决」，裁决可批量作用于选中的同 kind decision；③ 同一 run 活跃 decision 超阈值（默认 20）时，同 kind 的 decision 合并成一条 bulk decision（带 affected[] 列表），一次裁决多条；④ kind 固定八种：pre_execution（前置审批）、action_overrun（动作超上限）、abandon_ack（放弃跟踪的签字）、verify_human（证据不足转人工）、audit_result（记忆审计结论）、rule_ambiguous（分支或规则收不住）、**startup_unknown（启动层事实不明，等人确认开没开跑）**、**report_contradicted（迟到 report 与既有裁决互相矛盾，等人定哪一边为准）**。**run 级 decision（如 abandon_ack）用 (run_id, kind) 作唯一键并带 affected[] 列表**——签字单要一次覆盖多个被放弃的节点，不许撞键也不许只覆盖其中一个。**唯一键在 SQLite 上要写成 partial unique index，普通 UNIQUE 撑不住**：`node_run_id` 可空，而普通 UNIQUE 允许多个 NULL 并存（两行 NULL 不算重复），run 级唯一键会形同虚设。写死两条：**`CREATE UNIQUE INDEX decisions_run_kind_uq ON decisions(run_id, kind) WHERE node_run_id IS NULL`** 与 **`CREATE UNIQUE INDEX decisions_node_kind_uq ON decisions(node_run_id, kind) WHERE node_run_id IS NOT NULL`**——run 级与 node 级各管各的，NULL 与非 NULL 互不干扰。

**decision 的结论要带 resolution**：光有 approved / rejected / expired 装不下「继续等 / 认定已发生 / 放弃」三个出口。约定 `approved` 时必须带 `resolution`：**`continue_wait` 不再是 approved 行的 resolution**——它是对 `pending` / `acknowledged` 行追加的 revision（§8 决策迁移表的 continue_wait 行），不经过 approved，因此也不按「结论落地即 closed」收口：
- `resolution=continue_wait`（继续等）：节点迁回 `stopping` 并重新武装 `action_deadline_at`（**`rearm_generation += 1`**）。**这一条既不新建 decision 行、也不把旧行 closed、也不经过 `approved`**：同一 (node_run, kind) 只有一行，续期就在**这一行**上追加一条 revision（`resolution=continue_wait`、`wait_extensions=N`、revision+1），行的状态**保持 `pending` / `acknowledged`**（§8 决策迁移表的 continue_wait 行），历史留在 revisions 里可读——三次续期后这一行能读出 N=3。**`continue_wait` 不是「结论」**，所以不触发「结论落地即 closed」（§8 的 closed 规则是唯一收口口径）；这一行由 run / node 进终态、或被另一个活跃 decision 真正取代时，才 `closed`（closed_reason=run_terminal / node_terminal / superseded，并写 `superseded_by`）。
- `resolution=confirm_applied`（认定已发生）：节点迁 `done`，标 applied，并把该动作从 pending 派生集合移出（与状态迁移同事务）、把证据记进账本。**适用两个起点**：`stopping`（§8 `stopping → done`）与 `indeterminate_side_effect`（§8 `indeterminate_side_effect → done`）——**前置都要有「动作停了」的事实（`stopped_at`）**加「副作用确实发生了」的证据（evidence_id）；**光有 `stopped_at` 不够**（停止不等于结算：账上写着动作停了，不等于副作用没发生，§8 终态 CAS 第六条唯一权威口径）。
- `resolution=confirm_not_applied`（认定没发生）：适用起点 `indeterminate_side_effect`（§8 `indeterminate_side_effect → superseded / failed`）——**开工前先过 `report_contradicted` 检查**（旧 attempt 的迟到 report 与本裁决冲突 → 节点先挂起等那条 decision 收口，新 attempt 不许先跑，§3）；确认没发生且节点幂等 → 旧行落 `superseded`、新 attempt 新建行（`origin_node_run_id` 指向旧行，**新 executor**），不可重试 → `failed`；**对副作用的裁决必须带 `evidence_id`**（`confirm_not_applied` 与 `confirm_applied` 同一道证据门）。
- `resolution=abandon`（放弃）：节点迁 `abandoned_unverified`，并挂 run 级 `abandon_ack` decision 等签字。
- `resolution=confirm_not_started` / `confirm_started` / `confirm_started_attested` / `continue_tracking`（**`startup_unknown` 专用**）：confirm_not_started → **先过 `report_contradicted` 检查**（旧 attempt 的迟到 report 与本裁决冲突 → 节点先挂起等那条 decision 收口，**新 attempt 不许先跑**，§3），无冲突才动；**confirm_not_started 的前置共五条：`has_tool_call=true` 只拒本 resolution；四个 `executor.state` 分支与 confirm_started 对称**（`has_tool_call` 闸门：true 拒（仅 confirm_not_started）；再加四个 `executor.state` 分支：`deleted` 按人证接受、`unloaded` 先 resume 再查、状态未知先重查、桥断先 paused_bridge_missing；重查仍不明 → RESOLUTION_NOT_AVAILABLE，只余 indeterminate_side_effect / abandoned_unverified）；幂等节点旧行落 `superseded`、新建行重试，否则 failed（**新 attempt + 新 executor**，见下表）；confirm_started → 迁 `stopping`，锚点取「有 `tool_start_at` 就用它，没有就用裁决时刻 `now`」并记 `action_start_source=human_confirmed`；**服务端在 `last_known_phase=called_no_start` 或无任何开跑证据时拒绝 confirm_started**（UI 不开放，API 也拒，返回 RESOLUTION_NOT_AVAILABLE）——**这时人若确实看见动作开跑，走 `confirm_started_attested`**：迁 `stopping`，锚点取裁决时刻 `now`，记 `action_start_source=human_attested` 与 `attestation_id`，**不写 `evidence_id`**；**它只作状态事实、不作验证证据**（不算 tool.start 观测，不许拿来当「已验证」）；**confirm_started 与 confirm_started_attested 共用同一 executor.state 前置检查**（deleted / unloaded / 状态未知 / 桥断四个分支，见下表，一条不许查一条不查；`has_tool_call=true` 不是它们的拒绝条件——已观测 `tool.start` 时该值本就为 true）；`continue_tracking` → **保持 `startup_unknown` 不迁出**，重写 `unknown_watchdog` 并允许后续 report 到达（**本格不生成 `action_deadline_at`**）（人没看见开跑也没放弃，只是要继续跟）——**只许「executor 仍活且桥可用」这一支，且受 `unknown_watchdog` 约束**（钟重写为 `startup_unknown_deadline_at = now + 120 秒`，续跟不是无限续命，到点照样生成 decision；桥断 / deleted / 状态未知一律拒绝）。
- `resolution=uphold_report` / `uphold_decision`（**`report_contradicted` 专用，两个值互斥**）：`uphold_report` → 以那条迟到 report 为准，调 `applyReport(..., decision={decision_id, revision, resolution: uphold_report})`，按同一套 schema / 判定 / 证据门收口 `done` / `failed`（证据门不过则这个 resolution 不可用，只能转 `uphold_decision`）；**decision 行落 `approved`**；`uphold_decision` → 维持原裁决 D1，原裁决照常走 `superseded` / `failed`：幂等 → 旧行 `superseded` + 新建 `queued` 新行，不可重试 → `failed`（执行细节见 §8 的 `uphold_decision` 行与 M-60），迟到 report **永久标 stale**（`report_registry.state=stale`，只留账、不重放、不覆盖原裁决）。**这类 decision 不自动过期释放**：超过 24 小时只升级 `blocked_for_human` 并推送，再过 24 小时也不自动落任何一边，**只能由人收口**；`expired` 对它无效（§3、§8）。

**裁决出口的副作用，逐个写死**（只写目标状态，会留下 slot 被占、旧 executor 还活着的坑；第十七轮在原三个出口外补了 `confirm_started_attested` 与 `continue_tracking` 两行）：

| 出口 | 目标状态 | slot / lease | executor | attempt | report_registry |
| --- | --- | --- | --- | --- | --- |
| confirm_not_started（确认没开跑） | superseded（幂等，旧行终态；新行重试）/ failed（不可重试） | **释放 slot**，lease_id 置 null | **dispose 旧 executor**（这次 attempt 没开跑，现场无价值）——**dispose 之后已无可 reattach 的对象**，所以重试走**新 attempt + 新 executor**，「后来确认已开跑再 reattach」不再是退路。**执行本出口前必须先查 `executor.state`；`confirm_not_started` 的前置共五条——`has_tool_call` 闸门 + 四个 `executor.state` 分支，四个分支与 confirm_started 对称，`has_tool_call` 闸门只对 confirm_not_started 生效**：`has_tool_call=true` → 拒绝该 resolution（RESOLUTION_NOT_AVAILABLE）；`deleted` → 无对象可查，按人证接受（幂等 → superseded + 新行；不可重试 → failed）；`unloaded` → 先 resume 查 `has_tool_call`；状态未知 → 先重查再定，重查仍不明 → RESOLUTION_NOT_AVAILABLE（只余 indeterminate_side_effect / abandoned_unverified）；桥断 → 先转 `paused_bridge_missing` 等事实，不许凭猜落 superseded | 幂等重试：**旧行落 superseded、新行 attempt+1**（这是一次新尝试）；failed 不变 | 清空 |
| confirm_started（确认已开跑） | stopping | 保留 slot 与 lease（动作还在跑） | **先查 `executor.state` 再决定**（**与 confirm_started_attested 共用同一前置检查，一条不许查一条不查**）：`deleted` → 无对象可 reattach，转 `indeterminate_side_effect`（动作状态未知）或按人裁决转 `abandoned_unverified`（人放弃跟踪）；`unloaded` → **先 resume 加载再 reattach**；**状态未知（桥可用但查不到）→ 先重查 `executor.state` 再定，不许硬 reattach；重查仍不明 → RESOLUTION_NOT_AVAILABLE，只余 indeterminate_side_effect / abandoned_unverified**；仍在跑 → **reattach**（同一 attempt 继续跟）；**桥断则转 paused_bridge_missing** | 不变 | 保留 |
| confirm_started_attested（人证已开跑） | stopping | 保留 slot 与 lease（动作还在跑） | **与 confirm_started 共用同一 `executor.state` 前置检查**：`deleted` → `indeterminate_side_effect` 或 `abandoned_unverified`；`unloaded` → 先 resume 再 reattach；状态未知 → 先重查，重查仍不明 → RESOLUTION_NOT_AVAILABLE（只余 indeterminate_side_effect / abandoned_unverified）；仍在跑 → **reattach**（同一 attempt；锚点取裁决时刻 `now`，`action_start_source=human_attested`，记 `attestation_id`、**不写 `evidence_id`**）；桥断则转 paused_bridge_missing | 不变 | 保留 |
| continue_tracking（继续跟） | startup_unknown（**不迁出**） | 保留 slot 与 lease | **不 dispose**（保持桥订阅，等后续 report 到达）；**重写 `unknown_watchdog`（本格不挂 `action_deadline_at`）**；**只许「executor 仍活且桥可用」这一支**（桥断时节点已转 `paused_bridge_missing`；deleted 的 executor 没有桥订阅，等 report 是空话；状态未知那支须先重查 `executor.state`），**且受 `unknown_watchdog` 约束**：钟重写为 `startup_unknown_deadline_at = now + 120 秒`（同一笔 CAS 里 Gr+1） | 不变 | 保留 |
| abandon（放弃跟踪） | abandoned_unverified | 释放 slot，lease_id 置 null | **保留现场不 dispose**（动作可能还在跑，还要留证据）；只在节点终态后才 dispose | 不变 | 保留 |

**这张表只列「裁决出口」，§8 的迁移表才是全量权威**，两者一一对应：confirm_not_started → `startup_unknown → superseded / failed`，再由 `（建）→ queued` 建新行；confirm_started / confirm_started_attested → `startup_unknown → stopping`（executor 仍活）、`startup_unknown → indeterminate_side_effect`（executor 已 deleted）、`startup_unknown → paused_bridge_missing`（桥断）——**三种前置各有自己那一行，不许在裁决里现想**；continue_tracking → `startup_unknown → startup_unknown`（钟重写 now + 120 秒、Gr+1）；abandon → `startup_unknown → abandoned_unverified`。**离开 `startup_unknown` 的每条出口都要显式清空 `startup_unknown_deadline_at`**（迁 `paused_bridge_missing` 时改记 `startup_unknown_paused_at = now`）——**半态不许留着一个不再有人看的钟**。

**abandon_ack 的三个出口必须闭环**：这条 decision 是「放弃跟踪后，人来签字确认后果」的关口。
- `approved`（签字接受「副作用未验证」）：**同一笔事务**里把 affected[] 里的节点全部标记为「已签字」，**重算派生状态**（`settling` 与 `pending_irreversible_children` 按派生规则自动重算，**不手工摘集合**——原集合只含非终态节点，abandoned_unverified 本来就不在其中），**关闭这条 decision**（结论落地即收口，§8）；但该动作在「未验证副作用」清单里**长期留痕**，不许抹掉。**签字只解裁决门，不解「动作仍在跑」**：`unverified_side_effect` 理由**不因签字而自动消失**——**只有该动作的副作用被核实为「没发生」（`side_effect_verified_none = true` 且带 `stop_evidence`）这条理由才消失**；`stopped_at` 只证明「动作停了」，**不证明「副作用没发生」，单独存在时只能支撑 `succeeded_with_unverified`**（判据唯一，见终态 CAS 第六条 / 第七条，§8）；**若该 run 同时有节点落 failed，则终态落 `failed_with_unverified` 而不是 `failed`**（第七条失败支：失败的账不许把未验证副作用一笔勾销）。
- `rejected`（不签字，要继续跟）：affected[] 里的节点迁回 `stopping` 并重新武装 `action_deadline_at`（迁移表补 `abandoned_unverified → stopping` 边，CAS 带 abandon_ack decision_id + rearm_generation = Gr，迁移成功后 Gr+1），run 的理由**重新派生**——节点回到 stopping 后 `unverified_side_effect` 自然消失、理由切回 `action_deadline`（还在等动作时限），不手工置位。**驳回不是终态**——它把人拉回「继续跟」的那条路上。
- `expired`（24 小时未决）：默认动作 = **维持未验证状态**——run **不许**进 succeeded（终态 CAS 的第六条 / 第七条挡住了它：终态只能落 `succeeded_with_unverified` 或 `failed_with_unverified`），**run 停在 paused 不迁 failed**（按 kind 特判），通知升级到人工；不许拿「过期」当默认放行。这条 decision 随后 `closed`（closed_reason=expired_final），账上留「未验证副作用未签字」的痕迹。

**签字不是最后一道门**：签字只解除「挡住 run 收尾」这一项，run 仍要满足终态 CAS 的前置条件（§8）；**而且签字只解裁决门，不解「动作仍在跑」**——有未验证副作用时终态落 `succeeded_with_unverified`（或 `failed_with_unverified`），不是 `succeeded` / `failed`。

**跨行不变量**：run 进入终态的同一笔事务里，把该 run 下所有未决 decision 一并迁 closed。

**9. 判定是声明式的**：只允许 JSON Schema 加白名单算子（eq / ne / in / gt / gte / lt / lte / exists / match）加显式 and / or / not。编译期校验，不许 eval、脚本、读文件。

**10. 版本不漂移**：runs 存不可变 workflow_version，进行中的 run 按旧版本解释；改定义只产生新版本。

**11. 身份、验证与账本的可信度**：

- 回写工具按 agent scope 注入，只持 node_run_id 与 attemptId，处理器由服务端解析，不把引擎实例闭包进工具。**回写还要带 `action_generation`（Ga）**：服务在动作启动时把当时的 Ga 写进 node_run，回写工具每次回写都带上自己看到的 Ga；服务比对当前 Ga，不一致 → STALE_GENERATION（旧一轮动作发出的 report 不算数）。只靠「服务读当前 Ga」是不够的——那等于把旧 report 当成新 Ga 接受，栅栏只挡了定时器、没挡执行器。**Ga 与 Gr 分开**：Ga 跟动作走、回写用它；Gr 跟续期走、定时器与 decision 收口用它（§8）。
- **副作用等级由工具注册表的 capability 派生，不许节点作者口头声明**：注册表里每个工具带 `capability ∈ {read_only, mutating, compensating}`；**`mutating` 只决定「进不进三值推导」，不直接定级**——带可执行补偿描述符的 mutating 节点是 `compensable`，无描述符的才是 `irreversible`（推导见下）。节点把 mutating 声明成 `pure` → **加载期 SIDE_EFFECT_UNDECLARED**；把更严的推导声明成更宽的一侧同样拒——**引擎不采信作者的降级声明**。否则作者把一条写命令声明成「只读」，就能用弱证据通过不可逆节点的校验——闸门与被闸的东西都在作者手里，就等于没有闸门。**这条闸门按「节点实际可用的工具集」算，不只管 tool 节点**：agent 节点的 toolPolicy、任务会话模板的 allow、trigger 适配器都要过同一道门——任何一处含 mutating 工具，该节点 / 模板的前向 effective capability 就按下面的推导算，作者声明不许覆盖它；注册表里查不到的工具一律加载期拒（TOOL_NOT_REGISTERED），不许「先放行再说」。**前向 effective capability 的推导规则写死（三个值：pure / compensable / irreversible）**：① 前向工具集**只含 read_only** → **pure**；② 前向工具集**含 mutating，且该节点有可执行的补偿描述符**（描述符里的 tool 在注册表里且 capability=compensating，见下一条）→ **compensable**；③ 前向工具集含 mutating 且**没有**可执行补偿描述符 → **irreversible**。**作者声明只许往更严的一侧写，不许往更宽的一侧写**——声明 pure 而推导是 mutating（compensable / irreversible）→ **加载期拒（SIDE_EFFECT_UNDECLARED）**；声明 compensable 而推导是 irreversible（补偿描述符不可执行）→ 拒；声明 compensable 而推导是 pure → 拒（纯读节点没有可回退的东西）；**声明 irreversible 而推导是 compensable 或 pure → 接受，按更严的 irreversible 算**（从宽到严允许，不许声明降级）。**`compensating` 是第三种能力位，只许出现在补偿描述符里**：补偿动作本身是 mutating，若不单列，现规则会把 §3.2 的 compensation { tool, args, verify } 判成 SIDE_EFFECT_UNDECLARED，**带补偿描述符的节点根本加载不进去**。规则写死：① `capability=compensating` 的工具**只许**在节点的 compensation 描述符里被引用，出现在前向执行路径（tool 节点、agent toolPolicy、模板 allow、trigger 适配器）里一律加载期拒（COMPENSATION_TOOL_IN_FORWARD_PATH）；② 节点的**前向 effective capability 不把补偿工具计入**——补偿是事后回退，不改变节点本身的副作用等级，compensable 节点按**前向**工具集判级；③ **补偿工具本身单独校验、单独落证据**（注册表里有、capability=compensating、参数可核、执行后落独立 evidence 与事件行），不许借前向工具的证据顶替。**加载期用例写死五组**：① mutating + 可执行补偿描述符 → 通过、按 `compensable`；② mutating + 无描述符 → 通过、按 `irreversible`；③ 声明 `pure` 但前向工具集含 mutating → **SIDE_EFFECT_UNDECLARED**；④ 声明 `compensable` 但描述符不可执行 → **SIDE_EFFECT_UNDECLARED**（另报 COMPENSATION_UNEXECUTABLE）；⑤ 声明 `compensable` 而推导是 `pure` → **SIDE_EFFECT_UNDECLARED**。
- **闸门要盖住全部执行面，不许只盖 tool 节点**：① **verifier 的 toolPolicy 强制只读工具集**——verifier 里出现 mutating 工具（哪怕「只用来核对」）一律加载期拒（VERIFIER_TOOL_POLICY_MUTATING），否则 verifier 自己就能顺手写盘，证据链断在验证这一步；② **runTool 只接受注册表里 capability=read_only 的命令**——命令不在注册表、或注册表标着 mutating / compensating，调用期拒（RUN_TOOL_NOT_READ_ONLY），宿主只读身份不是万能挡箭牌；③ **trigger 适配器只允许注册过的 effect 原语**——适配器自己发的外部写（webhook、消息、文件落盘）必须命中注册表里的 effect 原语；没注册的写默认按 **irreversible** 处理并要求前置审批，不许按「适配器不算工具」放过去；④ **subworkflow 里的这些面在加载期递归校验**——子流程的 verifier toolPolicy、runTool 命令、trigger effect 原语、补偿描述符都要过同一道门，子流程不得成为绕过闸门的洞（加载期报出是哪一层、哪个节点）。
- **compensable 必须带可执行的补偿描述符**：节点声明 `compensation { tool, args, verify }`，由 tool_runner 执行并落证据；只有一句「可补偿」而无描述符 → **加载期 COMPENSATION_UNEXECUTABLE**（**注意：这条同时决定前向 effective capability 推导落在 compensable 还是 irreversible，见上一条的推导规则**）。**描述符里的 tool 必须在注册表里且 capability=compensating**——指向 mutating 工具 → **加载期 COMPENSATION_TOOL_NOT_COMPENSATING**；指向未注册工具 → TOOL_NOT_REGISTERED；补偿工具出现在前向路径 → COMPENSATION_TOOL_IN_FORWARD_PATH。补偿执行失败 → **节点落 `failed_with_unverified`**（**不是 failed**：补偿失败意味着「没能把副作用退回去」，这笔未验证副作用必须留在账上，§8 终态集合与终态 CAS 第七条；**§8 有对应的迁移行**：`indeterminate_side_effect / abandoned_unverified → failed_with_unverified`，条件是 `compensation.failed` 事件带 `compensation_id` 且补偿的 verify 证据不成立），并上报，不静默重试；**补偿的执行与证据单独记账**，不与前向动作混在一行里。
- **补偿的事件名与证据字段写死，不许再留白**（补偿是 mutating 动作，账上没有名字就等于没发生）：
  - **事件名固定三个**：`compensation.started`（补偿开始执行，带 `compensation_id` 与 `attempt`）、`compensation.applied`（执行完成且描述符里的 `verify` 通过）、`compensation.failed`（执行失败或 verify 不通过——**节点落 `failed_with_unverified` 并上报，不静默重试**；对应 §8 迁移行 `indeterminate_side_effect / abandoned_unverified → failed_with_unverified`，条件是事件带 `compensation_id` 且补偿的 verify 证据不成立）。**事件行带 `verify` 字段**（verify 这一步的结果与它引用的 evidence_id）——「执行完了」与「验证过了」是两件事，事件行不许只报前者。**没有第四个名字，也不许只发前向事件冒充补偿**。
  - **证据行字段固定**：`compensation_evidence { compensation_id, compensation_for_node_run_id, tool, args_hash, exitCode, stdoutHash, stderrHash, artifactHashes, attempt, verify }`——`compensation_for_node_run_id` 指向**被补偿的那个 node_run**；`verify` 记描述符里 verify 这一步的结果（通过 / 不通过 + 引用的 evidence_id）；补偿的行与前向动作的行分开落，不许合并成一行，也不许借前向动作的证据顶替。
  - **幂等键 `compensation_id = hash(node_run_id + attempt + descriptor_version)`**（`descriptor_version` 是补偿描述符的版本号，描述符一改版本号就变，幂等键跟着变——不然改过描述符的重试会被旧键挡掉）：同一 node_run + 同一 compensation 描述符版本 + 同一 attempt 只许一条补偿记录；重放同一条补偿命中同一条 `compensation_evidence`，**不许重复执行**（补偿动作本身会改世界，重复执行就是把风险加倍）。
  - **强度要求**：补偿动作是 mutating，落不可逆等级时按**强证据**要求——只回 exitCode 不算数，`artifactHashes` 必须非空（或命中描述符要求的哈希），否则 **VERIFICATION_TOO_WEAK**；描述符里的 `verify` 没执行或没通过，只许发 `compensation.failed`，不许发 `compensation.applied`。
  - **强弱标注**：补偿证据落库时同样标强 / 弱（强 = `runTool` 宿主只读身份跑的核对命令；弱 = 模型侧 tool_result），强度由证据来源定，不由节点作者自称。
- **irreversible 的通过凭据必须是产物哈希，不接受仅 exitCode**：`requiredCommands` 走注册表里的 verification profile（固定命令 + 期望产物哈希）；只回一个 exitCode（哪怕是 0）不算验过 → **VERIFICATION_TOO_WEAK**。写操作「成功退出」不代表它写对了东西。
- **证据由桥产出，不由模型转述**：evidence 来自 `executor.runTool`（强证据，宿主只读身份跑命令）与事件流里的 `tool.result`（弱证据，模型侧工具事件），服务直接落库，并在落库时标出证据强弱。
- **evidence 分强弱两级，来源是能力位**：节点声明 `evidence_source ∈ {runTool, tool_result}`。`runTool` 是**强证据**——宿主用受限令牌 + 只读挂载跑固定命令，有 OS 级隔离（环境不支持只读挂载就直接禁用 runTool，不降级）。`tool_result` 是**弱证据**——verifier executor 自己跑的 tool 事件，只有 allowlist / argv / toolPolicy 约束，**进程没有 OS 级只读隔离，命令理论上仍可能写盘**，所以它不能充当不可逆节点的通过凭据。规则：**irreversible 节点必须有强证据**，宿主无只读挂载 → **加载期 EVIDENCE_SOURCE_UNAVAILABLE**；pure / compensable 节点可用弱证据；节点既没声明可用来源也没声明人工裁决 → 同样加载期拒。**证据不足时也不许「没证据也算过」**——改走 verify_human decision 转人工裁决，把风险显式化。
- **verifier 不能自报**：节点与模板声明 `verification_policy { requiredCommands, requiredHashes, passCondition }`；verdict 必须引用满足该 policy 的 evidence_id，引用不存在的 evidence → VERDICT_UNSUPPORTED；引用了但不满足 policy → VERDICT_POLICY_UNMET；两者都拒。
- **policy 的基线由模板定，节点只能往上加**：模板给 mandatory baseline（每个模板自带最小要求），节点声明可以追加，**删减模板里的必填项在加载期就报错**。否则节点作者把 requiredCommands 写成空、passCondition 写成 true，evidence「存在」但什么也没验，引擎拦不住。
- **passCondition 必须引用 evidence 字段**：它是最后真正决定通过与否的那一行，只写 true 等于没验。**字段要分清两族**：`policy.requiredHashes` 是策略侧声明（要求哪些哈希），`evidence.hashes` 是证据侧产出（实际有哪些哈希）；passCondition 引用的是**证据族**——`evidence.exitCode` / `evidence.stdoutHash` / `evidence.stderrHash` / `evidence.hashes`（集合，用 contains 之类算子）/ `evidence.producedAt`，**引用 policy.requiredHashes 属非法字段**（它是要求不是事实）。引擎另外负责核对：evidence.hashes 是否覆盖 policy.requiredHashes，没覆盖 → VERDICT_POLICY_UNMET。编译期检查：passCondition 至少引用一个证据族字段，**纯 `true` 只允许无风险的 pure 节点**（无外部副作用、产物确定）；模板的 passCondition 同样是 mandatory baseline，节点只能**用 and 追加**，不能替换或覆盖。引擎做类型与引用校验：引用了不在证据白名单里的字段 → 加载期拒；条件为空 → 加载期拒。
- **引擎按节点类型校验最低要求**：irreversible 节点至少要有产物哈希或命令退出码；走 verifier 的节点至少要一条可复现命令；tool 节点至少要退出码。低于基线 → 加载期拒。
- **requiredCommands 的命令走固定 allowlist + argv，不过 shell**；带 `;`、管道、重定向的写法加载期即报错；执行身份与 cwd 限制见 §1.1 的 runTool 条目。
- **verifier 判活用谁**：node_run 增 verifier_agent_id / verifier_session_id，verifying 态的 sweep 用 verifier_agent_id 判活，不用 executor 的 id。
- **账本可被改，只做非对抗性校验**（措辞降级，不再声称防篡改）：把哈希链放到 append-only 的 `node_run_events` 表，每次状态迁移写一行，`prev_hash` 指向前一条事件；node_run 只存当前状态与 last_event_hash。用服务持有的 HMAC 密钥签，验证者只验签。**同用户同权限可读密钥，所以这是非对抗性校验，不是防篡改边界**；真正的边界是不给任务会话与 executor 读写 storages 目录的工具（deny 规则），降低绕过概率而非杜绝。面板对每条节点同时显示「声明状态」与「已验证证据」，让人能看出哪些只是自报。**report_registry 只是投影，不在链上**：它存的是 report 的当前状态（rejected / replayed / applied / stale），**三类状态迁移（rejected → replayed → applied）各自追加一条 node_run_events 进哈希链**（事件类型 report_rejected / report_replayed / report_applied，带 report_id 与 seq），registry 那行只是这份链的投影；**重放前先验链**（校验 last_event_hash 连得上、事件里有这条 report_id 的上一状态），链断或对不上就不许重放。理由：registry 是普通辅助表，能被 UPDATE 绕过，只有把状态迁移写进 append-only 链，它才是可审计的事实。**HMAC 仍定位为非对抗性校验**（同用户同权限可读密钥），不当安全边界。

**12. payload 契约**：每节点绑定 schema，来源是共享 schema 库与节点模板（schema 库带版本号，加载期按引用版本校验）；加载期 lint（规则上限、必填、算子类型、限长、引用完整）。默认 64KB，超限截断并记录。raw payload 不进带工具权限的 agent；文件与网页来的字段带来源标记与转义。

**13. 上下文预算**：任务会话只存目标、计划、产物引用；节点在 executor 子会话跑，回传有界 payload；每条 node_run 记 token 与压缩次数；超预算滚动摘要。

**14. 存储实况**：单写者，一条写连接加若干读连接，busy_timeout 5000 毫秒，短事务，写路径串行入队且有上限与溢出策略。日常 checkpoint 用 PASSIVE，TRUNCATE 只在空闲或关闭时做。索引：tasks(status, updated_at)、tasks(updated_at)、runs(task_id, started_at)、node_runs(run_id, seq)、node_runs(run_id, status)（派生计数与 pending 集合用）、decisions(status, priority, created_at)、**decisions 的两个 partial unique index**（`ON decisions(run_id, kind) WHERE node_run_id IS NULL` 与 `ON decisions(node_run_id, kind) WHERE node_run_id IS NOT NULL`——普通 UNIQUE 允许多个 NULL 并存，run 级唯一键撑不住）、**report_registry(node_run_id, attempt, state)**（当前 attempt 的队头与 stale 判定用）、events(seq)、events(run_id, seq)、events(node_run_id, seq)、events(decision_id, seq)、artifacts(run_id, created_at)；**decisions 另加 `priority` / `priority_reason` / `expiry_effect` / `expiry_effect_reason` 四列（第四段读模型需要，v26 起进 DDL；由服务写，面板只读）**；**行级唯一约束（幂等靠数据库兜底，不靠应用层查后写）：`report_registry(report_id PRIMARY KEY)`、`UNIQUE(node_run_id, attempt, seq)`；`decisions(decision_id, revision)` 唯一；`node_run_events(event_seq)` 唯一；`node_runs(run_id, node_id, attempt)` 唯一，另加 `CREATE UNIQUE INDEX node_runs_origin_uq ON node_runs(origin_node_run_id) WHERE origin_node_run_id IS NOT NULL`（同一旧行只许建一行新行）**。**DDL 验收用例**：同一 `report_id` 第二次插入必须被拒（SQLITE_CONSTRAINT），同一 `(run_id, node_id, attempt)` 重复插入必须被拒（SQLITE_CONSTRAINT）——重试要建新行就必须换 attempt；换一个新 `node_run_id` 但 `run_id / node_id / attempt` 不变，同样被 UNIQUE 拒；同一 `origin_node_run_id` 建第二行必须被 `node_runs_origin_uq` 拒；同一 `(node_run_id, attempt, seq)` 的**重复插入**（不是重放）同样必须被 UNIQUE 拒，重放走查重命中同一行、不得新增；`decision_id + revision` 重复只能走冲突分支，`event_seq` 重复不得追加第二条。备份用 backup API 或 VACUUM INTO。

**14.1 第四段新增存储落点（v26）**：`node_runs` 补 `seq INTEGER NOT NULL CHECK (seq >= 0)`（节点拓扑序号，来自工作流版本；同一 `node_id` 的多个 attempt 共用同一个 `seq`，只用于排序）；新增 `attestations(attestation_id PRIMARY KEY, run_id, node_run_id, attempt, claim, attested_by, attested_at, action_start_source, summary, created_at)`，索引 `attestations(node_run_id, attempt, created_at)`，只插不改，纠错新建一条；`NodeRunView.attestation_id` 取该 attempt 最新一条。新增 `unverified_resolutions(node_run_id PRIMARY KEY, run_id, resolution_basis, evidence_id, decision_id, stop_evidence, resolved_at)`，`resolution_basis ∈ {verified_none, evidence, decision}`，分别要求 `stop_evidence` / `evidence_id` / `decision_id` 非空；只由 §9 收口事务插入，不更新；`resolved` / `resolved_at` / `resolution_basis` 以这张表为唯一来源，不在 `node_runs` 上另存结论。索引另加 `unverified_resolutions(run_id, resolved_at)`。

**14.2 第四段命令回执行（v27）**：`inbox` 的 command 行至少含 `operation_id TEXT`、`kind TEXT NOT NULL`、`payload_hash TEXT`、`result_state TEXT`、`receipt_json TEXT`、`completed_at TEXT`、`created_at TEXT NOT NULL`；`idempotency_key` 取 `operation_id`。用表级 CHECK 约束 command 行：`CHECK (kind <> 'command' OR (operation_id IS NOT NULL AND payload_hash IS NOT NULL AND result_state IN ('in_flight','applied','rejected')))`，event 行这些列可为空。唯一约束写成 partial unique index：`CREATE UNIQUE INDEX inbox_command_operation_uq ON inbox(idempotency_key) WHERE kind='command'`，只作用于 command 行，event 行不受影响。`receipt_json` 在 `in_flight` 时为空，终态必须非空；`completed_at` 在终态必须非空。回执可查窗口 7 天，command 行不物理删除（只清 `receipt_json`），过期后 `get_operation` 与任何同 `operation_id` 的复放都返回 `OPERATION_EXPIRED`，不重新执行；要重做必须由人核对现状后换新 `operation_id`。

**15. 与原生对账**：账本做跨工作流查询与审计，执行态以执行桥的 state / whenIdle 为准。会话存活分 loaded / unloaded / deleted：unloaded 走 resume 或跳过，不判死；deleted 才标 session_gone。启动一次、其后低频对账（默认五分钟）。

**15.1 与原生 workflowEngine 的边界**：DSH 自带 `ctx.workflowEngine`（`@deepseek-ai/dsh-workflow`），它执行的是「编排脚本」——一段 plain-JS 脚本加一个 meta 块，脚本里用 `agent()` / `phase()` / `log()` / `parallel()` / `pipeline()` 组织子智能体；它的 run 是宿主持有的一次性活对象（有 cancel / dispose），`workflow/*` 事件明确是**只观察、不给运行控制**，没有持久账本、没有断点续跑、没有人工审批节点、没有等外部事件节点。它和本插件的九节点图不是同一种东西：**编排脚本是「一次性的多智能体编排」，编排插件是「可追溯、可恢复、可裁决的长任务」**。因此：v1 不把编排脚本嵌进节点内部（那是第二套状态机，账本会漂，正是第十一轮否掉的「双账本」坑）；原生 workflowEngine 继续服务临时脚本，我们只做两件事——① 面板可订阅 `workflow/*` 事件作为旁路视图；② 未来若要复用，只复用它的 agent() 派生子智能体路径（也就是本插件的 executor 子会话），不复用它的 run 控制。

**16. 事件与回执**：events 带单调 seq，发布走事务内 outbox；订阅者各有 cursor 与 ack，重启从 cursor 重放，at-least-once + 幂等键去重。入站事件另走 inbox。run 级事件按 run_id 发，节点级按 decision_id 发。上报核心大脑要 ack，ack 必须是一笔状态迁移。记忆写入带 idempotency key。

**三类存储的保留期分开算**：`events` 是通知流，默认 30 天；`node_run_events` 是节点级审计流水（状态迁移、tool.result、evidence 引用），保留到「run 终态 + 180 天」；`artifacts` 与 evidence 实体同样从 run 终态起算，保留期 180 天，覆盖重试、人工裁决与复盘窗口。桥缓冲只是传输层，服务 ack（fromSeq）后即可丢，executor 归档时强制清空——但**归档的前置条件是 `service_ack_seq >= bridge_last_seq`**，不满足就先等 ack，或把未 ack 的事件先落库再归档，不许先丢证据。**spill 落盘的事件先落库再丢**：高水位溢出的缓冲先写进 node_run_events 并标 spill_from_seq（服务不可用时落本地 spool 目录，恢复后按 seq 补进账本），**不许用「反正会重放」当理由丢证据**。**旧 attempt 的证据不靠桥缓冲保管**，它已经在服务账本里。run 结案后回看证据走 node_run_events 与 artifacts，不走桥。

**17. 任务会话与引擎事件的来源分离**（补旧账）：任务会话的**用户对话输入**与**引擎事件**是两条不同的通道——对话进 sessions，由人自己说；引擎事件（run 状态、decision、异常）只经事件订阅注入，不由用户在会话里「转达」给引擎。引擎判定「这轮结束了但没回写」只认引擎侧信号（回写、桥观测、租约），会话里的话不算数。

## 第三段 九种节点：推进方式、产出契约与交付批次（v23）

### 3.0 两类契约，与 artifact 的类型联合

入口契约（trigger 专用）与执行契约分开，字段支持 required / optional / not_applicable，按类型声明并加载期校验。

**入口契约**：来源类型、过滤条件、幂等键算法、失败策略、是否允许重复触发。

**执行契约**：输入（目标摘要、上游 artifact 引用、约束）、产出 schema、判定规则、side_effect_policy、超时、重试策略、要不要审批。

**产出三件套**：payload（按 schema，默认 64KB）、artifact 引用、有界摘要（≤800 字）。artifact 是类型联合：`artifact_ref { uri, sha256 }` / `decision_ref { decisionId }`（只留 id）/ `none`。

**消费者接受矩阵**（加载期校验）：agent、tool、subworkflow 接受三种全部；approval 产出 decision_ref、接受 artifact_ref；parallel 产出 artifact_ref 或 none；policy、branch 产 none。

### 3.1 能力矩阵：门禁按能力，不按类型

| 节点类型 | 批一能力 | 批二追加 | 超界时报 |
| --- | --- | --- | --- |
| trigger | human、session.event、cron（映射 DSH 原生 schedule） | external.webhook、external.file | TRIGGER_SOURCE_NOT_SUPPORTED |
| agent | 全部 | — | — |
| tool | 只读与写、命令级 allowlist | — | TOOL_NOT_ALLOWED |
| policy | 全部 | — | — |
| branch | 静态出边与运行期求值 | — | BRANCH_AMBIGUOUS |
| approval | 面板与 QQ 双端 | — | — |
| parallel | 不注册 | all / any / quorum 与取消语义 | NODE_NOT_SUPPORTED |
| wait | 不注册 | source ∈ {human, run.completed} | WAIT_SOURCE_NOT_SUPPORTED |
| subworkflow | 不注册 | max_depth = 2 | SUBWORKFLOW_DEPTH_EXCEEDED |

批一只六种进生产（trigger、agent、tool、policy、branch、approval，正好是记忆审计那条链）；其余批二一次做完再进生产，不做部分可用；未注册类型加载期即拒引用。

**subworkflow 深度的加载期解析**：visited key 用 `(workflow_id, pinned_version)`；引用必须 pin 版本否则加载期报错；路径 DFS 判环返回 SUBWORKFLOW_CYCLE；按 `(id, version)` memo 最深层数；加节点数与扇出上限。**subworkflow 里的执行面在加载期递归校验**——子流程每个节点的 verifier toolPolicy、runTool 命令、trigger effect 原语、补偿描述符都要过 §11 的同一道 capability 闸门（子流程不得成为绕过闸门的洞）；报错要指明是哪一层、哪个节点。

### 3.2 九种各自的推进

**一、trigger。** 入口。批一三种来源：人工（面板或一句话）、会话事件（关键词 / 正则）、定时（cron 映射 DSH 原生 schedule）。批二加 webhook 与文件出现。带幂等键去重；失败进事件表但不开 run，同类触发连续三次失败上报核心大脑。trigger 适配器（webhook / file）必须声明 side_effect_policy：外部事件适配器默认 pure，但它若会写外部系统（回调通知、落库确认），**必须命中注册表里已注册的 effect 原语**（webhook.post / notify.send / file.write 这类白名单原语）——**没注册的外部写默认按 irreversible 处理并要求前置审批**，不许按「适配器不算工具」放过去；命中的原语按注册表 capability 判级（mutating 原语 → 节点按 irreversible 算；compensating 原语不许出现在 trigger 的前向路径）。

**二、agent。** 引擎通过执行桥创建 executor 子智能体，注入目标摘要、上游产物（按 schema 截取、有界）、这次要交什么；不继承主会话历史；工具集按声明 allow / deny，未声明默认不给；回写不过 schema 按 PAYLOAD_SCHEMA 退回重报。**agent 节点按它实际能用的工具集算 effective capability**（三值推导规则见 §11）：toolPolicy 的 allow 里只要有一个 mutating 工具，这个节点就按推导判级——**有可执行的补偿描述符 → compensable，没有 → irreversible**；声明成 pure 一律加载期拒（SIDE_EFFECT_UNDECLARED）；allow 里出现注册表没有的工具 → 加载期 TOOL_NOT_REGISTERED；allow 里出现 capability=compensating 的工具 → 加载期 COMPENSATION_TOOL_IN_FORWARD_PATH（补偿工具只许在 compensation 描述符里用，不进前向路径）；**补偿工具不计入节点的 effective capability**——补偿是事后回退，不改变节点本身的副作用等级。

**三、tool。** tool 节点由 tool_runner 执行，runner 是薄适配器：无状态、无重试、无通用 shell、无自建状态机、不直接开 DB 连接，只认固定类型化工具注册表。派发、超时、重试、状态迁移全由服务持有。

- 归属：优先复用 DSH 原生工具执行服务；原生不具备时才自带，进程归属 orchestra-service。
- 崩溃分流：命令前崩 → failed 可重试；执行中且已停止 → indeterminate_side_effect；**已发出 tool.call 但无 tool.start → `called_no_start`，语义是 unknown**（不是 executing）：irreversible 走 indeterminate_side_effect，pure / compensable 仅在 `idempotent=true` 且无开跑证据时才可重试。
- **副作用等级由注册表 capability 派生**：工具在注册表里带 `capability ∈ {read_only, mutating, compensating}`；**mutating 的工具只能落在 mutating 一侧**——节点写 pure 是把宽的写成窄 → 加载期 SIDE_EFFECT_UNDECLARED；写成 compensable 则看**有没有可执行的补偿描述符**：有 → 推导为 compensable（对），没有 → 推导为 irreversible，声明与推导不符 → 加载期 SIDE_EFFECT_UNDECLARED（**三值推导规则见 §11**）。反过来，只读工具可以被声明为 irreversible（从宽到严允许），但不能把宽的写成窄的。**compensating 是第三种能力位，只许出现在 compensation 描述符里**（§11）：补偿动作本身是 mutating，单列一位才不至于把带补偿描述符的节点判成 SIDE_EFFECT_UNDECLARED；compensating 工具出现在前向执行路径 → 加载期 COMPENSATION_TOOL_IN_FORWARD_PATH；**前向 effective capability 不计补偿工具**，但补偿工具本身要单独校验、单独落证据。
- **补偿执行器**：compensable 节点带 `compensation { tool, args, verify }`，由 tool_runner 执行并落证据；无描述符 → 加载期 COMPENSATION_UNEXECUTABLE；描述符里的 tool 必须在注册表里且 capability=compensating（指向 mutating 工具 → 加载期 COMPENSATION_TOOL_NOT_COMPENSATING；未注册 → TOOL_NOT_REGISTERED）；补偿的执行与证据**单独记账**，不与前向动作混在一行里。**补偿的事件名与证据字段在 §11 写死**：`compensation.started` / `compensation.applied` / `compensation.failed` 三个事件（事件行带 `verify` 字段），证据行 `compensation_evidence { compensation_id, compensation_for_node_run_id, tool, args_hash, exitCode, stdoutHash, stderrHash, artifactHashes, attempt, verify }`，幂等键 `compensation_id = hash(node_run_id + attempt + descriptor_version)`，落不可逆等级时按强证据要求（光有 exitCode 不算数）。**补偿执行失败 → 节点落 `failed_with_unverified`**（不是 failed：没退回去的副作用必须留在账上，§11、§8；§8 有对应的迁移行：`indeterminate_side_effect / abandoned_unverified → failed_with_unverified`，条件是 `compensation.failed` 事件带 `compensation_id` 且补偿的 verify 证据不成立）。
- 工具事件要分两段记：`tool.call`（模型发出调用）与 `tool.start`（工具真正开跑，带 tool_start_at）。动作计时锚点取 tool_start_at。
- 心跳由独立线程发，runner 主循环阻塞也照发；心跳续期活动期限。
- 落库：command、args、cwd、env 白名单、输出哈希、exitCode、耗时、artifact_ref；不可逆动作成功经记录 API 登记 irreversible_applied。
- 沙箱：命令级 allowlist + argv（不过 shell，带 `;`、管道、重定向一律拒），cwd 限定工作区，命令取自注册表枚举。
- 只读 tool 步骤固定走 runner；verifier 只产 verdict，且 verdict 必须挂满足 policy 的 evidence。**verifier 的 toolPolicy 强制只读工具集**——verifier 里出现 mutating 工具（哪怕「只用来核对」）一律加载期拒（VERIFIER_TOOL_POLICY_MUTATING），否则 verifier 自己就能顺手写盘，证据链断在验证这一步。
- **runTool 与 tool_runner 共用同一套命令 allowlist、argv 约束、cwd 限制与只读身份机制**（§1.1）；runTool 的 command 只能来自注册表枚举，args 逐项校验，evidence 落库前核对命令哈希与 policy 一致。**runTool 只接受注册表里 capability=read_only 的命令**——命令标着 mutating / compensating 一律调用期拒（RUN_TOOL_NOT_READ_ONLY），宿主只读身份不是万能挡箭牌。

**四、approval。** 审批是 first-class decision，两种来源共用一张表：

- **显式 approval 节点**：图里的一个节点，产出 decision_ref，结论进 decisions 表，桌面与 QQ 双端通知。
- **引擎自动插入的前置审批**（irreversible 节点必需）：kind=pre_execution，绑定 node_run_id。节点在 `send` 之前停在 `blocked_pre`（入口只有 queued / leased），**进入时释放 lease 与 slot、lease_id 置 null**（人工审批可能等两小时，并发位不能被前置门占死，租约也不能空转过期）。批准后由**引擎**把它放回 `queued`，重新抢 slot 走 `queued → leased → dispatched`，attempt 号不变（它还没执行过）；未批准按节点定义的默认动作走（默认 failed）。

两者共用：状态机（§8）、artifact 契约（decision_ref）、超时默认动作（升级链路）。用例：无显式 approval 节点 + irreversible agent/tool → 断言引擎自动生成前置 decision，节点停在 blocked_pre；批准 → 重新 queued → leased → dispatched（attempt 不变）；驳回 → failed；**审批等两小时期间 slot 不被占**；**租约过期后批准仍能重新派发**。

**五、policy。** 纯声明式求值，输出 matched / ruleId / 依据字段，artifact=none，无模型参与。

**六、branch。** 静态同标签重复 = 加载期错误；运行期多命中 = BRANCH_AMBIGUOUS。每条出边须声明 priority 或 default；收不住就生成 decision 并进 blocked_post（带命中 ruleId 列表）。

**七、parallel（批二）。** 扇出 N 个子节点，join：all 等齐（含 waiting 子节点迁出）、any 首个成功且无未结算 irreversible、quorum(k) 只数 done。

- 取消按副作用分级：pure 与 compensable 可取消并补偿；irreversible 不许取消。
- 组结果带 pending_children；run 记 pending_irreversible_children，**它是派生集合**（该 run 下 `side_effect_policy = irreversible` 且 `status NOT IN (<§8 的 node_run 终态集合>)` 的 node_run，终态集合只从 §8 引用），非空时不得进 succeeded / failed，留在 settling，最后一个子节点结算再补终态事件。**pending 非空时还要拦住后继节点的派发**——不可逆的子节点还在跑，就不许沿着图往下走；只有 settling 挡住 run 终态而不挡工作流前进，等于让账本说「还在收尾」而流程已经跑了下一段。
- `allow_irreversible_children` 默认 false，any / quorum 要开得显式声明并在面板标注。
- children[] 带状态、cancel_reason、partial_artifact。
- 组超时只算执行时间，另设 decision deadline；组超时标 timed_out，不可取消的子节点继续挂 run 的 pending 集合；组结束同步取消组内 wait_registration。

**八、wait（批二）。** 事件路径：先落 inbox（seq + cursor），再匹配；wait_registrations 与状态迁移同事务，注册后从 cursor 重放，并回扫注册之前的 inbox（按节点创建时间或 run 起点），补成水平触发。

进入 waiting 释放 executor 租约；唤醒按优先级队列重抢 slot，记 woke_at 与 queued_at，唤醒到派发计入总 deadline。`event_timeout` 与 `wake_dispatch_starvation` 分开记，后者保留事件可重试或人工重放。匹配到的 payload 持久化进 wait_registrations。sweep 按谓词过期，不看 agent 存活。

**九、subworkflow（批二）。** 有效 side_effect_policy 取子工作流所有节点的最大值；最大值为 irreversible 时，本节点强制走前置审批，artifact 与审批项不许填 N/A。子 run 补偿按逆序执行 compensable 并逐条记录，置 irreversible_already_applied 标志；**补偿失败 → 该节点落 `failed_with_unverified`**（不是 failed：没退回去的副作用要留在账上；§8 有对应的迁移行：`indeterminate_side_effect / abandoned_unverified → failed_with_unverified`，条件是 `compensation.failed` 事件带 `compensation_id` 且补偿的 verify 证据不成立），上报，不静默重试。父 node_run 存 pin 版本与 resume_from，重试默认 resume，只有声明 restart 才重跑整个子 run；resume 遇子 run 内任何 indeterminate_side_effect 必须停。有序调用栈落库并跨重启继承；max_depth=2 加载期强制。

### 3.3 升级链路：终态要真终态

decision 状态机见 §8：pending → acknowledged → approved / rejected 有直接边；满 2 小时未决迁 blocked_for_human（记 escalated_at）；blocked_for_human 从 escalated_at 起算满 24 小时迁 expired，按定义默认动作收口（例外：`report_contradicted` 不落 `expired`，保持挂起等裁决，24 小时只升级通知；见 §8）；run 进终态时同事务把未决 decision 迁 closed（closed_by=system，closed_reason=run_terminal，撤通知、关待办）。

wait 过期、approval 超时、审计失败、indeterminate_side_effect 四条异常路径都走这条链路。

**indeterminate_side_effect 的面板呈现按风险聚合**：按 run 聚合显示「N 条待裁决 · 最长等待 X · 最高风险 Y · 最后心跳 Z」，人工一次进一批。

### 3.4 第十轮修订清单（历史条目，部分已被后续轮次取代，以 §3.4o 为准）

1. 执行桥补 `executor.cancel`（只发中止信号，不销毁现场）与 `executor.runTool`（只读证据）；事件订阅带 executorAgentId + attempt + fromSeq，桥端缓冲可重放；spawn 返回即订阅生效，send 必须排在 subscribe 之后；事件类型补 tool.result（含 exitCode 与输出哈希）。
2. sweep 表补齐：paused_bridge_missing（带 resume_state / resume_at，桥回来重入并重置计时）、timing_out（重启后补 cancel → whenIdle 再迁）、run.settling（启动对账时补终态）；三张表的非终态一一映射到恢复动作。
3. blocked 拆成 blocked_pre 与 blocked_post；迁移表补 blocked_pre → dispatched（批准，原 attempt 不变）与 blocked_pre → failed（驳回或超时）。
4. 控制面交接补 service.state（原子 rename + 文件锁）、drain 顺序（拒新请求 → 等节点 → 撤 cron → 删 endpoint/secret → 关 DB 释放锁 → 退出）、新服务先拿锁再写 endpoint、watchdog 遇 ORCHESTRA_ALREADY_RUNNING 退避重连而非反复拉起。
5. 不可逆时限改为节点/工具级策略 { defaultSec, maxSec, heartbeatExtendable }，迁移期默认 900/3600；心跳由独立线程发；cancel 分级（不可中断只停调度）；面板显示最后心跳、阶段、已运行时长。
6. decision 加 closed 终态（closed_by=system、closed_reason=run_terminal），同事务撤通知。
7. 证据由桥的 runTool 与 tool.result 产出，服务直接落库；节点声明 verification_policy { requiredCommands, requiredHashes, passCondition }；verdict 引用不存在的 evidence → VERDICT_UNSUPPORTED，不满足 policy → VERDICT_POLICY_UNMET；node_run 增 verifier_agent_id / verifier_session_id，verifying 的 sweep 用它判活。
8. 哈希链移到 append-only 的 node_run_events 表，用服务持有的 HMAC 密钥签；措辞降级为非对抗性校验，不再声称防篡改边界；任务会话与 executor 的工具集排除 storages 目录读写。
9. 任务会话的对话输入与引擎事件来源分离：引擎判定只认引擎侧信号，不认会话里的话。

### 3.4b 第十至十一轮修订清单（历史条目，部分已被后续轮次取代，以 §3.4o 为准）

1. 超时拆成「立围栏」与「动作停下」两件事：新增 `stopping` 格。动作不可中断时不立围栏，改为延长 `action_deadline_at` 并进 stopping；动作在期限内自然完成照常 accepted；到点转人工裁决；只有 executor 真停且状态未知才进 indeterminate_side_effect。report 的 CAS 改用 `effective_deadline_at`。补三组用例：不可中断动作跨 deadline 后成功、whenIdle 永久不返回、maxSec 到点。
2. `paused_bridge_missing` 收窄到 executor-bound 四态（dispatched / started / verifying / timing_out），恢复边按 resume_state 逐态列明（started → started 只重连不重发）；waiting 与 blocked_* 走 inbox 与 decision。补三条用例。（第十一轮后 stopping 也纳入覆盖，见 §3.4c）
3. `blocked_pre` 入口改为只有 queued / leased，进入时释放 lease 与 slot、resume_state=queued；批准后重新 queued → leased → dispatched，attempt 不变；删掉 dispatched → blocked_pre 那条边。补两条用例：审批期间 slot 不被占、租约过期后批准仍能重派。
4. run 状态从单 enum 改成三组标志（running / paused_reasons 集合 / settling），补 paused → failed、paused → succeeded、settling ↔ paused；终态 CAS 前置条件写死（paused_reasons 空、pending_irreversible_children 空、无非终态 node_run）。补两条用例。
5. verification_policy 定基线：模板给 mandatory baseline，节点只能追加，删减即加载期报错；引擎按节点类型校验最低要求（irreversible 至少产物哈希或退出码、verifier 至少一条可复现命令、tool 至少退出码）；requiredCommands 走固定 allowlist + argv 不过 shell。补三条用例：空 policy、节点删模板要求、命令带 `;` 与重定向。
6. 桥缓冲定位为传输层：服务 ack（fromSeq）后可丢，executor 归档强制清空；旧 attempt 的证据落在服务 node_run_events / artifacts / tool.result，保留期与通用 events 分开（events 30 天，节点级审计与 evidence 到 run 终态 + 180 天）。补两条用例。
7. 任务会话默认不给工具：协调位不带手，人要动手走主聊天或新 run；确需带工具则模板显式 allow / deny，且任务会话的工具调用记入 run 事件、面板可见；storages 读写一律 deny。补一条用例：人在任务会话里让协调 agent 改文件或发消息，断言被拦下或转成新 run。
8. runTool 边界写细：命令来自注册表枚举、args 逐项校验且不过 shell、cwd 限定工作区、只读身份是受限令牌 + 只读挂载（不支持就禁用而非降级）、与 tool_runner 共用 allowlist、evidence 落库前核对命令哈希。补三条用例：命令带重定向与管道、cwd 越界、只读身份下写文件。

### 3.4c 第十二轮修订清单（历史条目，部分已被后续轮次取代，以 §3.4o 为准）

1. **stopping 的计时锚点改掉**：action_deadline_at 不再从 dispatched_at 起算，改为「第一次 tool.call 观测时刻 → 无则 started_at → 再无则 last_heartbeat_at」；三者都拿不到就不进 stopping，照普通超时处理。理由：不可中断动作常在 executor 启动、模型想完之后才真跑，用 dispatched_at 会让慢启动的动作没跑够 maxSec 就被推去人工。补用例：慢启动的不可中断动作在跑满 maxSec 前不产生 decision。（**第十三轮再改**：锚点改为 `tool.start` 的 tool_start_at——tool.call 只是「发出调用」的时刻，不是动作开跑的时刻，见 §3.4d 第 6 条）
2. **「继续等」必须重新武装**：人点继续等时重算 action_deadline_at = 现在 + maxSec，wait_extensions += 1，记进 node_run_events；上限 max_wait_extensions（默认 3），超限只留「放弃并标未知」「认定已发生」两条路。补用例：连续点三次继续等，第四次不再提供该选项。
3. **「认定已发生」加前置条件**：只在 executor 已确认停止、或已有足够 evidence 时可选；动作还在跑时该选项不开放（避免节点被写成 done/applied 而动作继续产生副作用），此时人只有继续等与放弃并标未知两条路。补用例：动作仍在跑时裁决面板不提供该选项。
4. **迁移表修一条非法边**：stopping → paused 改为 stopping → blocked_post（paused 是 run 级状态，node_run 没有这一格）；stopping 到点进人工裁决时 run 同步进 paused_reasons={action_deadline}。（**第十三轮再改**：stopping 根本不迁 blocked_post，节点留在 executor 手上，见 §3.4d 第 4 条）
5. **run 对外投影定下来**：派生 display_status（paused_reasons 非空 → blocked，优先；否则 settling 非空 → settling；否则 running）与 reasons[] 可读副本；面板同时显示 paused 与 settling 两组，不因在等裁决就藏起未结算的不可逆动作。补用例：parallel run 同时有未结算 irreversible 子节点与待裁决 decision 时，面板两项都在。
6. **事件语义定下来**：run.paused（带 reasons[]）、run.settling、run.resumed；resumed 只在 reasons 清空时才发，清掉一条 reason 不发 resumed；理由未清空只更新 run.paused 的 reasons。补用例：清掉一个理由时事件流里不出现 resumed。
7. **passCondition 受约束**：必须引用 evidence 字段（requiredHashes / exitCode / stdoutHash 等），纯 true 只允许无风险 pure 节点；模板 passCondition 是 mandatory baseline，节点只能 and 追加不能替换；引擎做类型与引用校验（引用非法字段或条件为空 → 加载期拒）。补用例：节点写 passCondition=true 被拒、节点删模板条件被拒、节点追加 and 条件被接受。（**第十三轮再改**：requiredHashes 是策略侧声明、不是证据字段，passCondition 只能引用证据族字段，见 §3.4d 第 13 条）
8. **stopping 也依赖桥**：stopping 纳入 paused_bridge_missing 的 executor-bound 五态覆盖（或同义的 stopping_bridge_missing 子态）；恢复时先重连查 executor.state，再决定继续等心跳 / 转 indeterminate_side_effect / done / failed。补用例：桥在 stopping 期间断掉，重连后按实际状态正确收口。
9. **blocked_pre 的 lease CAS 写死**：进入 blocked_pre 时 lease_id 置 null、slot 释放；blocked_pre → queued 的 CAS 带 lease_id IS NULL；删掉旧句「resume_state 保留原 queued/dispatched 位，批准后从 leased 直接派发」，改为从 queued 重抢 slot。补用例：旧租约已释放仍能批准并重新派发、批准后从 queued 重抢 slot。
10. **保留期口径统一**：node_run_events 与 artifacts / evidence 统一写「run 终态 + 180 天」，删掉未定义的「审计保留期」。补一条用例：run 结案 180 天后清理节点级审计流水。
11. **dispose 的先后写死**：executor.dispose 前置条件 service_ack_seq >= bridge_last_seq，不满足先等 ack 或先把未 ack 事件落库再归档，不许先丢 tool.result。补用例：dispose 早于 ack 时未确认事件仍在账本里。
12. **终态 CAS 前置条件统一**：paused → failed / succeeded、settling → 终态、running → 终态全走同一条（paused_reasons 空 且 settling=false 且 pending_irreversible_children 空 且无非终态 node_run）；running 标志由这三条派生，不单独存。补用例：还有未结算子节点时 run 进不了终态。
13. **evidence 来源改成能力位**：节点声明 evidence_source ∈ {runTool, tool_result}；宿主无只读挂载时退到 tool_result（verifier executor 只读 toolPolicy 跑固定命令，同一套 allowlist / argv / 只读身份，服务直接落 evidence）；两者都不可用 → 加载期 EVIDENCE_SOURCE_UNAVAILABLE，不静默降级。补用例：无只读挂载时 tool_result 出 evidence、两者皆无时加载期拒。（**第十三轮再改**：evidence 分强弱，irreversible 节点必须要强证据，弱证据不得充当通过凭据，见 §3.4d 第 12 条）**（第二十轮再改**：强/弱两档不变，但**每个半态各有自己的证据门**——verifying 的证据门由 verify_timeout 与 verify_human decision 兜住，startup_unknown 与其它半态的回写走 applyReport 同一条证据门路径，补偿的 verify 字段写进 compensation_evidence；判据仍只读事实字段，不读推测，见 §3.4j 开头与第 1、4 条）**

### 3.4d 第十三轮修订清单（历史条目，部分已被后续轮次取代，以 §3.4o 为准）

1. **插件卸载改成只断连，不 drain**：三个生命周期分开（插件加载周期 / 宿主退出 / 服务存活）。卸载钩子只关桥连接、撤面板订阅、挂起通知目标；不 drain、不杀 executor、不抢锁、不删 endpoint。drain 归 profile 关闭流程。补用例：热重载插件后所有在跑节点照旧、事件按 cursor 补齐。
2. **宿主退出要有可观测信号**：两条通道并行——profile 关闭流程调 `service.requestDrain()` 走固定顺序 drain；DSH 与服务之间的 duplex pipe 断开即判定宿主已死，进入 host_gone（不候未收口节点，直接把未收口不可逆节点标 indeterminate_side_effect、run 进 paused、生成 decision，释放锁后退出）。Windows 上加 Job Object 兜底强杀。补用例：强杀 DSH 后服务不留孤儿进程占锁。
3. **watchdog 迁出插件**：守护职责归服务自带的 supervisor 进程（服务异常退出即退避拉起，拉起后立刻 sweep）；插件只是观察者与客户端。启动时先读 service.state 里的 pid——活着就连接、不抢锁，死了才接管清理。补用例：插件卸载后服务崩了仍能被拉起、第二次启动不撞 ORCHESTRA_ALREADY_RUNNING。
4. **stopping 不迁 blocked_post**：节点停在 stopping 期间 executor 一直被桥盯着，动作自然完成照常 accepted（CAS 仍认 status=stopping）；`action_deadline_at` 到点就地生成 decision，节点保持在 stopping，不再有那条危险迁移。补用例：动作超上限后自然完成，节点正常迁 done；桥断期间节点也不脱离 executor 监管。（**第十四轮再改**：迟到完成的 report 必须收得下——CAS 去掉 deadline 约束，见 §3.4e 第 2 条）
5. **新增 `abandoned_unverified` 格**：作为「放弃并标未知」的合法落点——动作可能仍在跑、副作用未经验证；它是节点终态，但要挂 run 级 abandon_ack decision 签字，签字前 run 的 paused_reasons 保留 unverified_side_effect，resume 必停。补用例：放弃后 run 不会自动 succeeded、签字后仍留「未验证副作用」记录。
6. **时限分两层**：启动层从 dispatched_at 起算（默认 60 秒），期内没等到 tool.start 说明动作没开跑，走可中断路径迁 timeout（可重试），不进 stopping、不需要人工裁决；动作层锚点取 tool.start 的 tool_start_at，`action_deadline_at = tool_start_at + maxSec`。补用例：慢启动的不可中断工具在启动层超时后按 timeout 重试，且没有人工裁决单。（**第十四轮再改**：启动层到点只说明「等不到 tool.start」，不等于「动作没开跑」；未观测 ≠ 未发生，只有 executor 明确回报未开跑才可自动重试，见 §3.4e 第 3 条）
7. **事件补 tool.start**：带 tool_start_at，跟模型发出调用的时刻分开记。补用例：tool.call 与 tool.start 间隔很久时，动作计时仍从 tool.start 起算。
8. **stopping_generation 栅栏**：每次「继续等」重新武装时 generation + 1；所有 stopping 相关 CAS（定时器、report、decision 收口、sweep 恢复）都带 `AND stopping_generation = G`，旧定时器 CAS 落空（STALE_GENERATION）。补用例：点「继续等」后旧的到期定时器触发，节点不被提前推走。（**第十四轮再改**：回写与续期共用一个代次会把合法的迟到回写当成旧代次丢掉，拆成 action_generation 与 rearm_generation 两种，见 §3.4f 第 1 条）
9. **sweep 与桥恢复的纪律**：stopping 恢复先看 action_deadline_at 是否已到（到点生成 decision，不许继续等）；paused_bridge_missing 恢复只有 dispatched / started / verifying 重置计时；timing_out 的围栏不重置；stopping 的重新武装计入 wait_extensions 且受 max_wait_extensions 约束。补用例：桥抖动十次也不能把不可中断动作无限延期。
10. **run 投影补派生理由**：`action_deadline` 与 `unverified_side_effect` 由节点状态派生（还有节点在 stopping 或有未签字的 abandoned_unverified 就一直在）；`run.resumed` 需 reasons 空 且 settling=false 且无未签字 abandon 三者同时满足；事件顺序固定 run.paused → run.settling → run.resumed。补用例：裁决完仍有节点在 stopping 时不出现 resumed。
11. **decision 合并**：同一 node_run + 同一 kind 只留一条活跃 decision（重开即更新）；面板按 run 聚合并支持批量裁决；单 run 活跃 decision 超 20 条时同 kind 合并成带 affected[] 的 bulk decision；kind 固定六种。补用例：parallel 下十个不可中断节点超时只产生一条 bulk decision 且一次批完。
12. **evidence 分强弱**：runTool 是强证据（宿主只读隔离），tool_result 是弱证据（只有 allowlist / argv / toolPolicy，进程无 OS 级只读隔离）；irreversible 节点必须有强证据，宿主无只读挂载 → 加载期 EVIDENCE_SOURCE_UNAVAILABLE；证据不足不改判通过，改走 verify_human 转人工裁决。补用例：无只读挂载且节点是不可逆时加载期被拒、纯节点可用弱证据通过。
13. **passCondition 字段分族**：`policy.requiredHashes` 是要求、`evidence.hashes` 是事实；passCondition 只能引用证据族字段，引用策略字段加载期拒；引擎另行核对 evidence.hashes 是否覆盖 requiredHashes，没覆盖 → VERDICT_POLICY_UNMET。补用例：节点在 passCondition 里引用 requiredHashes 被拒、覆盖不足被拒。
14. **跨行线性化与 epoch 持久化**：决策收口与 run 终态判定在同一笔事务内完成（decisions 用 revision 的 UPDATE 先判冲突，runs 用 run 级 revision + 派生条件），用例写成同事务两条写；instance_epoch 持久化在 service_meta 表，启动读旧值 +1 写回（跨重启严格递增），insert 的 epoch 校验在同一事务里 SELECT 比对，结果确定。补用例：decision 过期与 run 终态并发时只有一条线性化结果。

### 3.4e 第十四轮修订清单（历史条目，部分已被后续轮次取代，以 §3.4o 为准）

1. **超时路径改成「先问能不能停，再决定立不立围栏」**：`cancel_result` 决定迁移——`interrupted` 才 CAS 到 `timing_out` 立围栏；`not_interruptible` / `unknown` 一律不立围栏，改进 `stopping`；围栏已立才发现停不下，走 `timing_out → stopping` 撤销围栏。补用例：cancel 回 not_interruptible 时节点不进 timing_out，report 仍收得到；围栏已立后撤销围栏，节点回到 executor 手上。
2. **stopping 的 report 放宽 deadline 约束**：CAS 只看 `status=stopping AND stopping_generation = G`，不再带 `now <= effective_deadline_at` / `now <= action_deadline_at`——迟到完成是自然收口路径，上一版的规则把它挡在了门外。补用例：动作超上限后自然完成，节点正常迁 done（这条用例上一轮被自己的规则卡住）。
3. **启动层判定二分**：到点只说明「等不到 tool.start 事件」，不等于「动作没开跑」；`executor.state` 明确回报尚未发出任何 tool.call 才迁 `timeout`，且**只允许幂等节点走这条自动重试边**；回报不明或已发出调用 → 转 `stopping` + 人工裁决（**第十七轮再改**：此句已被取代——回报不明 / 已发出调用一律进 `startup_unknown`，不进 `stopping`，见 §3.4h 第 2 条），irreversible / `idempotent=false` 一律不许自动重试。补用例：不可逆节点启动层到点不被自动重试，而是生成人工裁决单。
4. **回写带 `stopping_generation`**：服务在节点进 stopping 时把当前 G 写进 node_run，回写工具每次带上自己看到的 G，服务比对不一致 → STALE_GENERATION；「服务读当前 G」等于把旧 report 当新 G 接受，栅栏只挡了定时器没挡执行器。补用例：续期前发出的旧 report 被拒，新 report 通过。
5. **桥是业务通道，保活通道独立**：宿主与服务之间的 duplex 由宿主启动服务时直接建立、由宿主侧持有，不经插件；插件的 RPC 桥只是业务通道。业务通道断 = 客户端走了，保活通道断 = 宿主没了——否则「插件卸载」与「宿主死亡」永远分不开。补用例：插件卸载后服务继续跑且不误判宿主死亡。
6. **decision 带 resolution，abandon_ack 三出口闭环**：`approved` 必须带 `resolution ∈ {continue_wait, confirm_applied, abandon}`；继续等之后那条 decision 自动 closed（closed_reason=superseded），同 node_run + kind 的新 decision 才活跃；abandon_ack 的 `approved` 在同一笔事务里摘节点、清 settling、移除 `unverified_side_effect` 理由但清单留痕；`rejected` 让节点迁回 stopping 并重新武装；`expired` 维持未验证、run 不许 succeeded。补用例：签字后 run 才可能收尾；过期不被当成默认放行；旧 decision 不挡住下一次。
7. **迁入 abandoned_unverified 与 run 投影同事务**：节点行 CAS 与 run 行 revision 更新写在同一笔，避免中间那一瞬面板显示 running。补用例：迁入瞬间面板不出现 running 状态。
8. **启动层计时器统一**：只留 `startup_timeout`（节点级可配，默认 60 秒），§2、§3、§8 三处口径一致，不再有 `never_started` 的第二套 60 秒。补用例：同一节点只有一套启动计时，谁先写有唯一答案。
9. **历史清单改标题**：§3.4 / §3.4b / §3.4c / §3.4d 标为历史条目并指向取代它的清单，§3.4c 第 1 条与第 7 条补「第十三轮再改」注，§3.4d 第 4 条与第 6 条补「第十四轮再改」注。补一条检查：全文搜「已在正文生效」只剩 §3.4e 一处。（**第十五轮再改**：该检查项的基准改为 §3.4f，见 §3.4f 第 12 条）（**第十九轮再改**：该检查项的基准改为 §3.4i，且改成机器可判定口径——标题行正则 `^### .*（已在正文生效）$` 只许命中当前清单一条，历史正文里作为旧检查项被引述的字样不参与计数，见 §3.4i 第 10 条）
10. **版本号统一**：文件头状态行与第三段标题同步到 v13。（**第十五轮再改**：已同步到 v14，见 §3.4f 第 12 条）（**第十九轮再改**：已同步到 v17，见 §3.4i 第 10 条）

### 3.4f 第十五轮修订清单（历史条目，部分已被后续轮次取代，以 §3.4o 为准）

1. **代次拆成两种**：`action_generation`（Ga，跟动作走，回写用它）与 `rearm_generation`（Gr，跟续期走，定时器与 decision 收口用它）。续期时动作没重启，Ga 不变——若拿 Gr 去挡回写，续期前发出的那条合法迟到回写会被判 STALE_GENERATION 丢掉，账上停在 stopping 而现实里动作已经做完；反过来「服务读当前代次」则旧回写每次都匹配，栅栏等于没有。补用例：点「继续等」后动作完成，那条回写被接受且只被接受一次。
2. **围栏撤销有回写通道、whenIdle 有超时出口**：timing_out 下收到的 report 不丢，存 `last_rejected_report_id`，围栏撤销时用同一 report_id **重放一次**（幂等，上限 1）（**第十七轮再改**：改存 `report_registry`，不再有 `last_rejected_report_id` 标量，重放只取当前 attempt 的队头，见 §3.4h 第 6 条）；`whenIdle` 必须带超时（默认 30 秒），超时按「未确认停止」走 `timing_out → stopping`，**不得判 indeterminate_side_effect**（indeterminate_side_effect 的前提是 executor 已确认停止）。补用例：whenIdle 永久不返回；撤销围栏后迟到 report 仍收得到。
3. **启动层三分为「未开跑 / 不明 / 已调用未见开跑」**：新增半态 `startup_unknown`——动作可能根本没开跑，所以不生成 `action_deadline_at`、也不声称「还在跑」；挂 kind=startup_unknown 的 decision，三出口 `confirm_not_started` / `confirm_started` / `abandon`。**已观测到 tool.call 但无 tool.start** 归此格且 `last_known_phase=called_no_start`（语义 unknown，不是 executing），此时 `confirm_started` 不开放。补用例：启动层到点不生成 action_deadline_at；调用已现而无 tool.start 时只能确认未开跑或放弃。
4. **executor.state 给出「有没有发出过 tool.call」**：新增 `tool_call_seq` 与 `has_tool_call` 两个事实（或用 fromSeq + ack 证明没有 tool.call）；只有这个事实为 false 才允许走启动层自动重试。**桥恢复不许重置 `startup_timeout`**（另设 `bridge_absence_budget`，节点级默认 120 秒，超预算 → `startup_unknown`）。补用例：unknown 不得走自动重试；桥抖十次也不延长启动计时。
5. **continue_wait 在同一行上追加 revision**：同一 (node_run, kind) 只保留一行，续期不新建行也不 closed，追加 `resolution=continue_wait` 与 `wait_extensions=N` 的 revision，状态回 pending / acknowledged；只有被另一个活跃 decision 真正取代时才 closed（superseded）。补用例：三次续期后同一行读得出 N=3。
6. **abandon_ack 三出口闭环**：补 `abandoned_unverified → stopping` 反向边（CAS 带 abandon_ack decision_id）；run 迁移按 kind 特判——abandon_ack 过期时留在 paused、不迁 failed；decision 终态集合固定为 {approved, rejected, expired, closed}，并补 node_terminal 关闭边。补用例：驳回后节点回 stopping；过期不是默认放行；已批 decision 有明确收口。
7. **终态 CAS 直接查活跃 decision**：前置条件加第五条 `NOT EXISTS (SELECT 1 FROM decisions WHERE run_id = ? AND status IN ('pending','acknowledged','blocked_for_human'))`；前四条看的是派生集合，漏清或早清时这条直接挡住。补用例：活跃 decision 还在时 run 进不了终态。
8. **未结算风险只留一个派生函数**：`running` / `paused_reasons` / `settling` / `pending_irreversible_children` / `display_status` / `reasons[]` 全部由 `derive_run_state` 在同一笔事务里重算，任何写路径不许手工置清；node_run 字段表补 schema_version 与各时间戳、代次字段；**属性测试**：任意一次迁移后投影等于重新计算的结果。补用例：任意迁移后不出现「标志说 running、实际还有未结算」。
9. **闸门不再由作者声明**：`side_effect_policy` 与证据强度从工具注册表 `capability` 派生（mutating 即 irreversible，声明成 pure/compensable → 加载期 SIDE_EFFECT_UNDECLARED）；compensable 必须带可执行补偿描述符（否则 COMPENSATION_UNEXECUTABLE）；irreversible 的通过凭据必须是产物哈希，只回 exitCode → VERIFICATION_TOO_WEAK。补用例：写命令伪装成 pure 被拒；无补偿执行器的 compensable 被拒；echo ok 不能过不可逆 policy。
10. **called_no_start 归 unknown**：模型已发出 tool.call 但 tool.start 未到，不算「没调用」也不算「执行中」；irreversible 走 indeterminate_side_effect，pure/compensable 仅在 idempotent 且无开跑证据时可重试。补用例：tool.call 与 tool.start 之间杀宿主，phase=unknown。
11. **桥缓冲有界**：每 executor 缓冲加字节上限（默认 8MB）与高水位（默认 4MB）背压；超限可落盘 spill，但 spill 事件先落库再丢，不许丢证据；dispose 在上限内先落库再归档。补用例：服务离线时灌入大输出，宿主内存有界，恢复后事件可重放。
12. **版本号统一**：文件头状态行与第三段标题同步到 v14；历史清单 §3.4 / §3.4b / §3.4c / §3.4d / §3.4e 均标为历史条目并指向本清单。补一条检查：全文搜「已在正文生效」只剩 §3.4f 一处。（**第十六轮再改**：版本同步到 v15，历史清单再增 §3.4f，「已在正文生效」的基准改为 §3.4g，见 §3.4g 第 12 条）（**第十九轮再改**：版本同步到 v17，历史清单再增 §3.4h 与 §3.4i，「已在正文生效」的基准改为 §3.4i，检查口径改成标题行正则，见 §3.4i 第 10 条）

### 3.4g 第十六轮修订清单（历史条目，部分已被后续轮次取代，以 §3.4o 为准）

1. **代次按迁移类型固定**：回写类用 Ga，定时器 / 裁决 / 恢复类用 Gr；补「迁移类型 → 代次」矩阵；`stopping → indeterminate_side_effect`、`stopping → abandoned_unverified` 改用 Gr；`abandoned_unverified → stopping` 补 Gr+1。补用例：续期前发出的旧 decision 落空，唯一能推动节点的是新 Gr。
2. **被挡回写有幂等账**：新增 `report_registry(node_run_id, attempt, report_id, state, rejected_at, replayed_at, applied_at)`，report_id 唯一键锁死；被挡 report 排队不覆盖，重放只允许一次，接受后永久标 applied。补用例：同一 report 重放两次只收一次；两份不同 report 都保留。
3. **timing_out 的恢复与围栏撤销同步**：sweep 的 timing_out 行补 whenIdle 超时 → stopping（不得判 indeterminate_side_effect）与 report 重放；`timing_out → stopping` 的 CAS 加 transition_reason 区分来源。补用例：服务在 timing_out 中重启，动作已完成，恢复后走 stopping 并收口。
4. **continue_wait 有合法回边**：decision 迁移表补 `approved → pending（reopened）`（条件 resolution=continue_wait 且 revision+1），同一行从结论状态回到活跃状态不再无路可走。补用例：三次续期后同一行状态可读、历史不丢。
5. **结论态有收口边**：补 `approved / rejected / expired → closed`（closed_reason=resolved / expired_final），已结论的行最终一定 closed，不留悬空。补用例：批复后 run 收尾，decision 行最终为 closed。
6. **startup_unknown 补齐 kind 与出口**：kind 固定清单加 startup_unknown（合计七种）；迁移表补 `startup_unknown → queued / failed / stopping / abandoned_unverified` 四行，CAS 带 decision_id + revision；sweep 行同步。补用例：三个出口各走一次，节点都落到表内状态。
7. **桥预算只作用于没开跑的节点**：bridge_absence_budget 超预算时，dispatched / started → startup_unknown；stopping / verifying / timing_out → 各自的 decision 并保留 action_deadline_at，不许倒退语义。补用例：stopping 节点桥断超预算不被改成 startup_unknown。
8. **confirm_started 的锚点与拒绝规则**：有 tool_start_at 就用它，没有就用裁决时刻 now 并记 action_start_source=human_confirmed；服务端在 called_no_start 或无开跑证据时拒绝该 resolution。补用例：无 tool.start 的 startup_unknown 确认开跑后 deadline 从确认时刻起算。
9. **abandon_ack 改成 run 级键**：run 级 decision 用 (run_id, kind) 唯一键并带 affected[]；approved 时重算派生状态（不手工摘集合）；rejected 后节点回 stopping，理由重新派生为 action_deadline。补用例：两个 abandoned 节点一次签字全部覆盖；驳回后理由正确切换。
10. **三个出口的副作用写死**：confirm_not_started 释放 slot、清 lease、dispose executor、attempt+1、清 last_rejected_report_id；confirm_started 保留 slot 与 lease、reattach，桥断转 paused_bridge_missing（**第十七轮再改**：confirm_not_started 改走新 attempt + 新 executor，confirm_started 先查 executor.state（deleted / unloaded / 桥断三条分支），report 账目改看 report_registry，见 §3.4h 第 5、6 条）；abandon 释放 slot 但保留现场与证据。补用例：confirm_not_started 后下一个节点抢得到 slot；confirm_started 时 executor 失联走 paused_bridge_missing。
11. **capability 闸门覆盖全部节点类型**：按节点实际可用的工具集算 effective capability——agent 的 toolPolicy、任务会话模板的 allow、trigger 适配器都过同一道门；含 mutating 即提升为 irreversible，声明 pure / compensable 加载期拒（SIDE_EFFECT_UNDECLARED）；注册表查不到的工具加载期拒（TOOL_NOT_REGISTERED）。补用例：agent 带 mutating 工具声明 pure 被拒；任务会话 allow 写工具被拒。
12. **派生不许全量扫描**：derive_run_state 走增量计数与部分索引，只更新变化的投影字段；面板读路径现算，终态 CAS 走轻量摘要；补 N=100 / N=1000 的规模测试，写入次数与耗时随 N 线性增长。补用例：千节点并行迁移不呈平方增长。**版本同步到 v15，历史清单 §3.4 / §3.4b / §3.4c / §3.4d / §3.4e / §3.4f 均标为历史条目并指向本清单；检查基准改为全文搜「已在正文生效」只剩 §3.4g。（第十七轮再改：版本同步到 v16，历史清单再增 §3.4g，「已在正文生效」的基准改为 §3.4h，见 §3.4h 第 12 条）**（第十九轮再改：版本同步到 v17，历史清单再增 §3.4h 与 §3.4i，「已在正文生效」的基准改为 §3.4i，检查口径改成标题行正则 `^### .*（已在正文生效）$` 只命中当前清单一条，见 §3.4i 第 10 条）**（第二十轮再改：版本同步到 v18，历史清单再增 §3.4j，§3.4–§3.4i 全部标为历史条目并指向 §3.4j；「已在正文生效」的基准改为 §3.4j，标题行正则 `^### .*（已在正文生效）$` 仍只命中当前清单一条，见 §3.4j 第 10 条与开头）**

### 3.4h 第十七轮修订清单（历史条目，部分已被后续轮次取代，以 §3.4o 为准）

1. **startup_unknown 拆成「executor 已失联」与「executor 仍活」**：前者挂 decision 交人工，后者保留桥订阅，并补 `startup_unknown → done / failed` 的执行器回写边（CAS 带 status + attempt + action_generation = Ga + report_id）——桥断期间动作完成，report 仍能落到节点上，不至于无处可落；§7 sweep 行同步区分这两种恢复动作。补用例：桥断期间动作完成，report 能落到节点上。
2. **「回报不明 / 已发出调用」一律进 startup_unknown，不进 stopping**：迁移表里 dispatched / started → stopping 只认两种凭据——观测到 tool.start（tool_start_at 有值）或人裁决 confirm_started / confirm_started_attested；启动层到点但未观测 ≠ 未发生。补用例：动作未观测到开跑时绝不进 stopping。
3. **run 终态补 succeeded_with_unverified**：该 run 下仍有 abandoned_unverified 且其副作用未被独立确认停止时，**终态只能落到它，不许落 succeeded**；签字只解裁决门，不解动作仍在跑——unverified_side_effect 理由不因签字而自动消失。补用例：签字后 run 收尾显示 succeeded_with_unverified，不显示 succeeded。
4. **注册表补 `compensating` 能力位**：只许出现在 compensation 描述符里（出现在前向路径 → COMPENSATION_TOOL_IN_FORWARD_PATH）；节点的**前向 effective capability 不计补偿工具**，补偿工具本身单独校验、单独落证据。补用例：带补偿描述符的节点加载期通过，补偿工具被单独记账。
5. **三个出口的 executor 落点写死**：confirm_not_started 删掉「后来确认已开跑才 reattach」，改为 dispose 旧 executor + **新 attempt + 新 executor**；confirm_started 先查 executor.state——deleted → indeterminate_side_effect（动作状态未知）或 abandoned_unverified（人放弃），unloaded → resume 加载之后再 reattach，桥断 → paused_bridge_missing。补用例：confirm_not_started 后重试拿到的是新 executor；confirm_started 遇到 deleted 的 executor 走 indeterminate_side_effect，不硬 reattach。
6. **report 的账只有一份**：删掉 last_rejected_report_id 标量，registry 加 seq 与 (node_run_id, attempt, state) 索引及 state 约束，重放只取**当前 attempt 的队头**，旧 attempt 的记录标 stale。补用例：两份不同 report 都保留；旧 attempt 的队头不挡当前 attempt。
7. **每行 CAS 显式写代次**：回写类带 Ga，其余（定时器 / 裁决 / 恢复）带 Gr；凡重新武装 action_deadline_at 的路径（继续等、桥恢复、围栏撤销、startup_unknown 落 stopping）在**同一笔 CAS 里 Gr+1**。补用例：旧定时器撞新 Gr 落空；旧 report 撞新 Gr 落空；桥恢复与到期交错时只有一条路径赢。
8. **report 的查重、应用、标 applied 在同一笔事务**：同一笔 BEGIN IMMEDIATE 里做 registry 的 state 条件更新（rejected → replayed → applied）+ 节点 CAS + node_run_events 追加；正常接受的 report 也写一条 report_applied 事件，report_id 作幂等键覆盖两条路径。补用例：崩在事务中间时同一 report 不会被收两次。
9. **人证开跑有出口**：新增 confirm_started_attested（人证，只作状态事实、不作验证证据，标 action_start_source=human_attested）→ stopping，以及 continue_tracking（保持 startup_unknown，挂 action_deadline 并允许 report）——人已经裁决的，不能让节点无处可去。补用例：人证开跑后节点从 startup_unknown 走到 stopping；继续跟时后续 report 仍收得到。
10. **capability 闸门盖住全部执行面**：verifier 强制只读工具集（带写工具加载期拒）、runTool 只接受 capability=read_only 的注册命令、trigger 适配器只允许注册过的 effect 原语（否则默认按 irreversible 并要求前置审批）、subworkflow 加载期递归校验这些面。补用例：verifier 带 mutating 工具被拒；runTool 调 mutating 命令被拒；未注册 effect 原语的 trigger 触发前置审批。
11. **decision 唯一键写成 partial unique index**：普通 UNIQUE 允许多个 NULL 并存，run 级 (run_id, kind) 撑不住——写死 `ON decisions(run_id, kind) WHERE node_run_id IS NULL` 与 `ON decisions(node_run_id, kind) WHERE node_run_id IS NOT NULL`。补用例：同一 run 两条同 kind 的 run 级 decision 建不进第二条。
12. **report_registry 只存投影**：rejected / replayed / applied 三类状态迁移各自追加进 node_run_events 的哈希链，重放前先验链；HMAC 仍定位为非对抗性校验，不当安全边界。补用例：registry 被直接改写后，重放前验链失败即拒绝重放。**版本同步到 v16，历史清单 §3.4 / §3.4b / §3.4c / §3.4d / §3.4e / §3.4f / §3.4g 均标为历史条目并指向本清单；检查基准改为：全文搜「已在正文生效」，标题行只剩 §3.4h 一处（历史条目里作为旧检查项被引述的地方不算）。**（**第十九轮再改**：版本同步到 v17，历史清单再增 §3.4i，§3.4–§3.4h 全部标为历史条目并指向 §3.4i；检查基准改为 §3.4i，且口径机器可判定——标题行正则 `^### .*（已在正文生效）$` 只许命中当前清单一条，历史条目正文里作为旧检查项被引述的字样不参与计数，见 §3.4i 第 10 条）

### 3.4i 第十九轮修订清单（历史条目，部分已被后续轮次取代，以 §3.4o 为准）

本清单已成历史：**第十九轮审计的 9 条致命 + 3 条重大**已在 v18 落进正文；**第二十轮审计的 10 条致命 + 2 条重大**由 §3.4j（v19）取代；当前生效清单见 §3.4o（v23）。两轮计数各自成立，不许混成一轮。下面每条保留原文，供回溯「当时为什么这么改」。

1. **[致命] startup_unknown 的「executor 仍活」分支补时钟**：加 `startup_unknown_deadline`（unknown_watchdog，默认 120 秒）。落在 §2 字段表、§3 启动层、§7 sweep 表、§8 迁移表。规则：executor 仍活那一支起算 `startup_unknown_deadline`，**到点是生成一条 startup_unknown decision，不是直接迁出**；这一格纳入 `paused_bridge_missing` 覆盖，桥恢复不重置这个钟；`continue_tracking` 也受同一个钟约束。补用例：executor 仍活且 120 秒内不回 report → 自动生成 startup_unknown decision；桥断后恢复，该钟继续走、不被重置。
2. **[致命] startup_unknown「executor 已失联」分支拆三支闭合**：落在 §3 启动层、§7 sweep 表、§8 迁移表（新增三行）。规则：① executor 已 deleted → 出口只到 indeterminate_side_effect 或 abandoned_unverified；② 状态未知 → 先重查 executor.state 再定，不许直接判停；③ 桥断 → 转 paused_bridge_missing。`continue_tracking` 只许第 ③ 支且 executor 未删；`confirm_started` 与 `confirm_started_attested` **共用同一 executor.state 前置检查**（deleted / unloaded / 状态未知 / 桥断）。补用例：executor 已删时 confirm_started 被拒；状态未知时先重查再定去向；executor 已删时 continue_tracking 被拒。
3. **[致命] abandoned_unverified 的「独立确认停止」落到事实字段**：加 `stopped_at` / `side_effect_verified_none` 与证据 `stop_evidence`。落在 §2 字段表、§3 裁决出口、§8 迁移表、§8 run 终态 CAS 第六条、§9 abandon_ack。规则：run 终态 CAS 第六条**直接读这两个字段**——`stopped_at` 非空或 `side_effect_verified_none = true`，且都要带 `stop_evidence`；字段没有一律算「未确认停止」，run 终态只能落 `succeeded_with_unverified`。补用例：签了字但没填确认字段 → run 落 succeeded_with_unverified；填了 stopped_at + stop_evidence → 未验证副作用理由消失。
4. **[加固] succeeded_with_unverified 与 display_status 不冲突，并补 run 事件**：落在 §8 run 投影、§8 事件行。规则：`display_status` **先判终态**（succeeded / failed / succeeded_with_unverified / orphaned 直接显示终态名，不再派生 paused / settling / running），succeeded_with_unverified 单独显示、不折成 succeeded；run 落任一终态都要有对应事件，其中 `run.succeeded_with_unverified` 带未验证副作用的 node_run_id 列表；**run 终态枚举以 §8 那行为准**，其它地方只许引用这五个名字：`succeeded` / `failed` / `succeeded_with_unverified` / `failed_with_unverified` / `orphaned`。补用例：run 收尾后面板显示 succeeded_with_unverified 且带对应事件；终态不再被 display_status 改写成 running。
5. **[加固] startup_unknown→done/failed 回写边继承 schema / 判定 / 证据门**：落在 §8 迁移表、§3 回写段。规则：这条边**复用 applyReport 的同一验证路径**（同一套 schema 校验、同一套判定、同一套证据门），irreversible 节点在 startup_unknown 格里回写同样需要强证据。补用例：startup_unknown 里的不可逆节点收到只有 exitCode 的 report → 拒；schema 不过 → 退回报。
6. **[加固] 超时路径不许绕开「先问停不停得下来」**：落在 §8 超时相关五行、§7 sweep 表。规则：立围栏前先发 cancel 并读回执，`cancel_result = interrupted` 才 CAS 到 timing_out；`not_interruptible` / `unknown` 一律不立围栏，改进 stopping（触发者写「服务（cancel 回执）」）；timing_out → timeout 与 timing_out → indeterminate_side_effect 同样要求 `cancel_result = interrupted`；timing_out → stopping 是「先补一次 cancel」的结果，CAS 带 `cancel_result ∈ {not_interruptible, unknown}`。补用例：cancel 回 not_interruptible → 节点不进 timing_out；回执 unknown → 走 stopping，不立围栏。
7. **[加固] 迟到 report 有账可入**：落在 §3 回写段、§2 字段表（report_registry）。规则：report_registry 的覆盖面扩到 **startup_unknown 与 abandoned_unverified**——这两个格子里落败的 report 一律入队（state=rejected）；节点已迁出时**只留账不重放**（重放只取当前 attempt 的队头）。补用例：startup_unknown 迁出后迟到的 report 在 registry 里查得到；已迁出的 report 不被重放。
8. **[加固/契约] 补偿的事件名与证据字段写死**：落在 §11、§3.2 补偿执行器。规则：事件固定三个——`compensation.started` / `compensation.applied` / `compensation.failed`；证据行固定 `compensation_evidence { compensation_id, compensation_for_node_run_id, tool, args_hash, exitCode, stdoutHash, stderrHash, artifactHashes, attempt }`；幂等键 `compensation_id`，重放同一条补偿**不许重复执行**；补偿动作本身是 mutating，落不可逆等级时按**强证据**要求（`artifactHashes` 非空，否则 VERIFICATION_TOO_WEAK）；描述符里的 `verify` 没执行或没通过时，只许发 `compensation.failed`。补用例：补偿只有 exitCode → VERIFICATION_TOO_WEAK；同一 compensation_id 重放两次只执行一次。
9. **[小项] verdict 归类全文一致，并写死 Ga 的初始化时点**：落在 §8 迁移表（leased→dispatched）、§8 代次矩阵、§8 代次段。规则：verdict 类回写（verifying → done/failed、stopping → done/failed）统一归 **Ga**——verifier 的 verdict 由 verifier 执行器回写，与 stopping → done/failed 同族，不再两套口径；**Ga 在 leased→dispatched 派发那一刻初始化为 1**。补用例：verifying 迁 done 时 CAS 带 Ga；续期（Gr+1）不动 Ga。
10. **[小项]「已在正文生效」的检查改成机器可判定**：落在 §3.4i 标题、§3.4 – §3.4h 历史条目标题。规则：标题行正则 `^### .*（已在正文生效）$` **只许命中当前清单一条**；当前清单标题另带一个方括号包住的 CURRENT 唯一标记（全文件只出现一次）；历史条目正文里作为旧检查项被引述的「已在正文生效」字样**不参与计数**；历史条目 §3.4 – §3.4h 统一指向 §3.4i；**版本同步 v17**（文件头状态行与第三段标题）。补用例：把 §3.4h 标题里的「（已在正文生效）」去掉后，正则命中数仍为 1；正文里引述再多也不影响计数。
### 3.4j 第二十轮修订清单（历史条目，部分已被后续轮次取代，以 §3.4o 为准）

本清单记录第二十轮的落法；当时生效清单是 §3.4k，当前生效清单见 §3.4o（v23），§3.4 – §3.4i 为更早的历史条目。**第十九轮审计的 9 条致命 + 3 条重大结构性意见**按条落到正文，下面每条写明落在哪一节、规则怎么定、配什么用例。**这一轮的主战场是状态机本身**：半态要有自己的时钟、证据门、迟到回写路径和账目位置；停止不等于结算；终态枚举只留一处权威。

**本清单记录的是 v18 的落法；其中「`applyReport` 带 `policy` 参数」「`report_contradicted` 只有生成 decision、没有挂起格与 resolution」「重试原地 attempt+1」三处已被后续版本取代，以 §3.4o 为准。**

1. **[致命] 每个半态都要有自己的时钟**：`verifying` 原先没有钟（节点能永远挂在 verifying 拖住 run），`startup_unknown` 有两个 120 秒预算（桥断预算与启动预算各算各的）。落在 §2 字段表、§3 启动层、§7 sweep 表、§8 迁移表。规则：① 新增节点级 `verify_timeout`（默认 120 秒），`started → verifying` 时起算 `verify_started_at` / `verify_deadline_at = now + verify_timeout`；② `startup_unknown` 只留**一个**钟 `unknown_watchdog`（落点 `startup_unknown_deadline_at`），删掉独立的桥断 120 秒预算，桥断累计改用 `bridge_absence_accumulated` / `bridge_down_since` 记账；③ `unknown_reason ∈ {startup_deadline, bridge_absence, none}` 记是哪一支点的灯，**桥断优先，同一 tick 只生成一条 decision**。补用例：verifying 挂 120 秒后自动进 blocked_post 并挂 verify_human decision；桥断预算不再有第二个 120 秒。
2. **[致命] 离开半态必须清钟**：半态迁出后如果还留着一个没人看的钟，节点就会靠一个过期时钟被再次推走。落在 §2、§3、§7、§8。规则：**所有离开 `startup_unknown` 的出口都显式清空 `startup_unknown_deadline_at`**（§8 的 CAS 逐行写 `startup_unknown_deadline_at IS NULL`）；迁 `paused_bridge_missing` 时改记 `startup_unknown_paused_at = now`（钟暂停，桥预算接管）；恢复时 `startup_unknown_deadline_at` 为空 → 按 `startup_unknown_paused_at + 120 秒` 还原，连 paused_at 也没有才补写 now + 120 秒并 Gr+1。补用例：节点迁出 startup_unknown 后旧钟不再触发任何 decision；桥恢复后钟按 paused_at 还原而不是无限续命。
3. **[致命] 终态枚举只留一处权威**：node_run 的终态集合原先散在 §2 / §7 / §8 / §14 多处抄，改一处忘一处就漂移。落在 §8（唯一权威）、§2、§7、§9、§11、§14。规则：**node_run 终态集合只在 §8 写一份**（v20 起含 `superseded`）；其它章节一律只引用，不抄集合，不许另造同义词。补用例：全文搜终态清单只命中 §8 一处。
4. **[致命] 回写只走一个入口**：回写边散落在各迁移行里，每行自己写「schema 校验 / 判定 / 证据门」，迟早有一行漏掉证据门。落在 §3 回写段、§8 迁移表。规则：定义单一入口 `applyReport(node_run_id, report, expected_status, generation, policy)`（已作废，见 §3.4m 第 12 条）——`expected_status` 是白名单、`generation=Ga`、`policy` 内含证据门；内部顺序固定：幂等查重 → schema → 状态代次 CAS → 证据门 → 判定 → 落库同笔 BEGIN IMMEDIATE；返回 `ApplyResult{accepted, reason, next_status, registry_state}`；**拒绝也落 report_registry（state=rejected）**。§8 的 started → done / failed、verifying → done / failed、startup_unknown → done / failed、stopping → done / failed 四条回写边全部改调它。补用例：irreversible 节点收到只有 exitCode 的 report → 一律拒，落 registry。
5. **[致命] 迟到 report 与裁决冲突要有去处**：旧 attempt 的迟到 report 撞上 confirm_not_started，如果照收就会把「没开跑」的裁决推翻；如果照丢就凭空消失。落在 §3 回写段、§8 迁移表、§9。规则：新增 `report_contradicted` 规则与 decision kind（第八种）：旧 attempt 的迟到 report 与 `confirm_not_started` 冲突 → 生成该 decision、**新 attempt 先暂停**（不许先跑）；节点已终态时允许人工回填修正，**不许自动改**。`confirm_not_started` 与 `confirm_not_applied` 开工前都要过这道检查。补用例：confirm_not_started 后到达旧 attempt 的 report → 节点挂起等 report_contradicted 收口。
6. **[致命] 停止不等于结算**：`stopped_at` 只证明「动作停了」，不证明「副作用没发生」；原先「停了就等于没有副作用」的推断会让账在现实仍落刀时收口。落在 §8 终态 CAS 第六 / 第七条、§9 confirm_applied、§3 裁决出口。规则：① **第六条重写为只约束「要落 succeeded 的那一支」**——凡要落 `succeeded`，该 run 下不许有未验证副作用，判据直接读 `stopped_at` / `side_effect_verified_none` 两个事实字段；② **新增第七条**：成功支有未验证副作用 → 落 `succeeded_with_unverified`；**失败支有未验证副作用 → 落 `failed_with_unverified`，不许落 `failed`**；③ `confirm_applied` 的前置是「`stopped_at`（动作停了）**且** evidence_id（副作用确实发生了）」——光有 stopped_at 不够。补用例：run 有一节点 failed、另一节点停在 abandoned_unverified → run 落 failed_with_unverified 而非 failed。
7. **[致命] 补偿失败要留在账上**：补偿执行失败原先直接进 failed，那笔没退回去的副作用就从清单里消失了。落在 §11、§3.2 补偿执行器、§8 终态集合。规则：① 新增终态 **`failed_with_unverified`**（节点层与 run 层同名同义）；② 补偿执行失败 → **节点落 `failed_with_unverified`** 并上报，不静默重试；③ `compensation.failed` 事件与 `compensation_evidence` 都要带 `verify` 字段（「执行完了」与「验证过了」是两件事）；④ 幂等键写死 `compensation_id = hash(node_run_id + attempt + descriptor_version)`。补用例：补偿失败后节点终态是 failed_with_unverified，未验证副作用清单里这一笔还在。
8. **[致命] capability 推导要写死三值**：原先「含 mutating 即提升为 irreversible、声明 pure / compensable 一律拒」把带补偿描述符的节点也堵死，补偿机制形同虚设。落在 §11、§3.2（agent / tool / 补偿执行器）。规则：**前向 effective capability 三值推导**——只含 read_only → pure；含 mutating 且有可执行补偿描述符 → compensable；含 mutating 且无 → irreversible；作者声明只许往更严的一侧写（往宽写 → SIDE_EFFECT_UNDECLARED）。补用例：带可执行补偿描述符的 mutating 节点加载期通过、推导为 compensable；声明 pure 的 mutating 节点被拒。
9. **[致命] orphaned 是节点终态**：原先 orphaned 只是「判活确认死亡」的去处，不在终态集合里，run 的「无非终态 node_run」永远不成立。落在 §3、§7、§8。规则：① **orphaned 进 §8 的 node_run 终态集合**；② 可重放 → 落 orphaned 封存，重投**新建 node_run**（`origin_node_run_id`）并把新行 id 回写旧行 `replacement_node_run_id`（旧行是终态、不迁出，另立一行 `orphaned → orphaned` 挂账）；③ **不可重放 → 直接落 failed**（不经 orphaned）。补用例：可重放节点判活死亡后 run 能收口；重投后旧行能查到 replacement_node_run_id。
10. **[结构性·重大] 每条迁移显式写代次，新增边各自归族**：第十九轮审计指出「一条迁移一行代次，逐行现想就会漏」。落在 §8 迁移表与代次矩阵。规则：① 全部回写边带 `action_generation = Ga`，定时器 / 裁决 / 恢复类带 `rearm_generation = Gr`，逐行写明（不许用「同上」带过）；② 新增的边归族写死：`verifying → blocked_post` / `verifying → failed` 属**定时器类**；`stopping → done`（confirm_applied）、`indeterminate_side_effect → done / queued / failed / abandoned_unverified` 属**裁决收口类**；③ 代次矩阵同步补齐这七条。补用例：每条新迁移在矩阵里能查到归族；回写边不带 Gr、计时边不带 Ga。
11. **[结构性·重大] 半态的迟到回写路径与账目位置要写死**：`indeterminate_side_effect` 原先只有一条「任意非终态 → indeterminate_side_effect」的入边，没有出边，节点进去就出不来。落在 §3、§7、§8、§9。规则：① `indeterminate_side_effect` **三条出边**：→ done（confirm_applied）、→ queued / failed（confirm_not_applied，**开工前过 `report_contradicted`**）、→ abandoned_unverified（abandon）；② 新增 `confirm_not_applied` 裁决；③ `continue_tracking` 的钟重写为 `now + 120 秒` 且 Gr+1（§3、§8、§9 三处同一口径）。补用例：indeterminate_side_effect 能被人裁决收口，不会永远挂着。
12. **[结构性·重大] 取消语义全文统一**：`cancel_result` 的四取值原先只在 §1.1 写着，§3 启动层与 §8 迁移表各说各的。落在 §3（超时两件事 / 撤围栏 / 启动层）、§8 超时相关行、§7 sweep 表。规则：**四取值全文统一**——`interrupted` 才立围栏；`not_interruptible` / `unknown` 一律不立围栏、改迁 `stopping`（`unknown` 保守按 `not_interruptible` 处理）；`already_stopped` 走「已停」判定，**不进 timing_out**；`transition_reason` 区分 `not_interruptible` / `unknown` / `whenIdle_timeout` / `observed_still_running`。§3 与 §8 同一口径，`dispatched / started → timeout` 补 cancel 步骤与 `cancel_result = interrupted` 的 CAS。补用例：cancel 回 already_stopped → 走「已停」判定，不进 timing_out。


### 3.4k 第二十一轮修订清单（v19，历史）

本清单已成历史（v19）：**第二十轮审计的 10 条致命 + 2 条重大**按条落到正文；当前生效清单是 §3.4o（v23）。v19 的三条自留产物在这里交代：行 → 幂等键对照表、M-01…M-56 逐行用例（v20 扩到 58）、本节本身。

1. **[致命] startup_unknown 出口闭合（#7）**：只留 `unknown_watchdog` 一个钟；`continue_tracking` 只对「executor 仍活且桥可用」开放；桥断已转 `paused_bridge_missing`，deleted 与状态不明只能走裁决出口；`startup_unknown` 永不生成 `action_deadline_at`。落在 §3、§7 sweep 表、§8 迁移表。补用例：continue_tracking 多次后 watchdog 到点照样生成 decision；deleted 支 continue_tracking 被拒。
2. **[致命] report_contradicted 有挂起格与两条 resolution（#8）**：节点停在原格不迁出，`hang_reason=report_contradicted`，新 attempt 被挡；`uphold_report` / `uphold_decision` 二选一；`expired` 对它无效，24 小时只升级通知、不释放闸门。落在 §3、§8 decision 迁移表、§9。补用例：confirm_not_started 后旧 report 到达 → 节点不迁出、新 attempt 不跑；超过 48 小时仍保持 paused。
3. **[致命] 证据门只有一个入口（#9）**：`applyReport(node_run_id, attempt, report, expected_status, generation, decision?)`；`policy` 由函数内部按 `run.workflow_version` 载入，不是调用方参数；人工 confirm_applied / confirm_not_applied 必须走 `evaluateEvidence` 并拿到 `evidence_id`；confirm_started_attested 豁免——只记 `attestation_id` 与 `action_start_source=human_attested`，不写 `evidence_id`，也不得充当验证证据。落在 §3、§9。补用例：调用方伪造 policy 无法放宽证据门；人工裁决缺 evidence_id 被拒。
4. **[致命] capability 三值推导可执行（#10）**：mutating 只决定是否进推导——有可执行补偿描述符 → compensable，无 → irreversible；作者只能往更严写；加载期五组用例写死。落在 §11、§3.2。补用例：mutating + 补偿 → compensable 通过；mutating 声明 pure → SIDE_EFFECT_UNDECLARED。
5. **[致命] already_stopped 有合法落点（#11）**：新增 `dispatched / started → done / failed`（有可核对结论，写 `stopped_at` + `stop_evidence`，`Gr` 不 +1）与 `→ indeterminate_side_effect`（无结论）两行；confirm_not_started 前置 `executor.state`：`has_tool_call=true` → 拒（RESOLUTION_NOT_AVAILABLE），桥断 → 先 paused_bridge_missing。落在 §8、§9。补用例：cancel 回 already_stopped 且报告已到 → 直接 done，不进 timing_out；has_tool_call=true 时 confirm_not_started 被拒。
6. **[致命] 行级唯一约束进 DDL（#12）**：`report_registry(report_id PRIMARY KEY)`、`UNIQUE(node_run_id, attempt, seq)`、`decisions(decision_id, revision)`、`node_run_events(event_seq)`、`node_runs(run_id, node_id, attempt)` + `origin_node_run_id` 部分唯一索引；补 DDL 验收用例。落在 §14。补用例：同一 report_id 二次插入被拒（SQLITE_CONSTRAINT）。
7. **[结构性·重大] 行 → 幂等键对照表**：§8 终态集合下方新增，逐行给出数据库兜底。补用例：删掉任何一个唯一键，对应 M 用例必须失败。
8. **[结构性·重大] 迁移表逐行用例 M-01…M-59**：每条用例对应一行迁移或一类跨行操作，断言落到字段与 CAS 代次；M-56 是跨行闸门，M-57/M-58 是 v20 新增的续跟与重试建行，M-59 是 v21 新增的 uphold_report 收口。补用例：59 条全绿才算迁移表验收。**v22 已扩到 M-01…M-61（见 §3.4n 第 6 条），以新清单为准。**
9. **[加固] dispose 前置与 confirm_not_started 对齐**：dispose 条件改为「该 attempt 已收口或已确定不再使用」；confirm_not_started 走新 attempt 时旧 executor 可立即 dispose，不必等节点终态。落在 §1.1、§9。
10. **[加固] §7 sweep 与 §3 同口径**：startup_unknown 行、indeterminate_side_effect 行同步「一个钟 / 不生成 action_deadline / 冲突挂起」；sweep 不许另写一套出口。落在 §7。
11. **[加固] §9 resolution 清单补两个值**：`uphold_report` / `uphold_decision` 与裁决出口副作用对齐；continue_tracking 的钟写法同步。落在 §9。
12. **[小项] 版本与历史指向**：文件头与第三段标题升 v20；§3.4 – §3.4k 标题统一指向 §3.4l；「已在正文生效」正则只命中 §3.4l。补用例：标题行正则 `^### .*\[CURRENT\]` 只命中 §3.4l；搜 `applyReport` 旧五参签名（带 policy 参数）只出现在 §3.4j 历史记录里。**v21 起由 §3.4m 第 12 条取代，v23 起再由 §3.4o 取代：唯一 `[CURRENT]` 是 §3.4o。**

### 3.4l 第二十二轮修订清单（v20，历史）

本清单记录 v20 的落法，已被 §3.4m 取代，仅作历史条目。**第二十一轮审计的 6 条致命 + 4 条重大 + 4 条措辞**逐条落到正文，版本升 v20。这一轮只改状态机的两件事模型：**重试不再原地改 attempt**，改「旧行落 `superseded` 终态、新 attempt 新建 node_run」，于是「run 下无非终态 node_run」这条收口条件第一次可满足；**桥断不再迁 `startup_unknown`**，节点留在 `paused_bridge_missing` 等事实，超预算只生成一条 decision，`continue_tracking` 只对「executor 仍活且桥可用」开放。v20 的四件自留产物在这里交代：`superseded` 的中性终态语义、`origin_node_run_id` / `replacement_node_run_id` 双指针、§8 的「迁移表统一前置条件（`report_contradicted` 挂起闸门）」段、M-57 / M-58。

1. **[致命] 重试一律新建行（原致命 5）**：`node_run_id` 是行标识，`attempt` 不许在同一行上原地改写；旧 attempt 的行要留史，就不能靠 `attempt+1` 把它顶掉。规则写死：**旧行先落 `superseded` 终态，再建新行**（`origin_node_run_id` 指向旧行，旧行 `replacement_node_run_id` 回写新行，`attempt = 旧 + 1`），同一旧行只许建一行；`superseded` 是**中性终态**——不算成功也不算失败，`pending_irreversible_children` 自然为空，run 级判定把它视同 done 一侧。迁移表 `startup_unknown → queued` 改 `→ superseded`、`indeterminate_side_effect → queued / failed` 改 `→ superseded / failed`，新增 `（建）→ queued` 行；M-06 / M-52 改断言，新增 M-58（M-57 见第 2 条）。落在 §2、§7、§8、§9、§14。补用例：旧行仍是非终态时建新行必须被拒；旧行的 attempt 一个字节都不改；run 判定不把 `superseded` 算进失败类。

2. **[致命] 桥断只有一个出口（原致命 1）**：`continue_tracking` 原先对「executor 仍活」与「桥断但 executor 未删」两支开放，后者会把节点留在 `startup_unknown`，同时撞上「桥断 → `paused_bridge_missing`」与 watchdog 暂停两条既有规则——同一个节点被三套口径同时推。规则写死：**桥断一律先转 `paused_bridge_missing`，`continue_tracking` 只对「executor 仍活且桥可用」开放**；桥断 / deleted / 状态未知三支一律拒绝（RESOLUTION_NOT_AVAILABLE）。落在 §3、§7、§8、§9。补用例：桥断时点 continue_tracking 被拒且节点已在本格；桥恢复后节点从 `paused_bridge_missing` 按事实续判，不从 `startup_unknown` 重开。

3. **[致命] 人工证据门按事实分档（原致命 2）**：原先 `confirm_started_attested` 被要求走 `evaluateEvidence` 拿 `evidence_id`，它又只被允许作「状态事实」——同一份字段既是证据又不是证据。规则写死：**`confirm_applied` / `confirm_not_applied` 必须走 `evaluateEvidence` 并落 `evidence_id`**（对副作用成立与不成立的裁决都要证据）；**`confirm_started_attested` 豁免**——只记 `attestation_id` 与 `action_start_source=human_attested`，**不写 `evidence_id`**，只支撑「动作已开跑」的状态迁移，永远不能拿来当「副作用已验证」。落在 §3、§9。补用例：attested 能过状态门、过不了验证门；`confirm_not_applied` 缺 `evidence_id` 被拒。

4. **[致命] `report_contradicted` 挂起闸门全文生效（原致命 3）**：L139 说挂起时节点停原格，但 §8 普通出口没有闸门，§9 的 `uphold_report` 也没有落点。规则写死：**凡从 `startup_unknown` 或 `indeterminate_side_effect` 迁出，CAS 一律带 `AND hang_reason IS NULL`**；挂起时只认两条 resolution 行与桥断边 `→ paused_bridge_missing`，其余出口返回 STALE_HANG。`applyReport` 增第 6 个可选参数 `decision {decision_id, revision, resolution}`，先 CAS `decisions`，冲突 `DECISION_REVISION_CONFLICT`；`uphold_report` 从两格迁出一律调它并带 `expected_status`。落在 §2、§3、§8、§9。补用例：挂起时普通 report 落库返回 STALE_HANG；decision revision 过期时 applyReport 不改 node_run。

5. **[致命] decision 表补映射与封锁（原致命 4）**：`blocked_for_human` 允许再满 24 小时落 `expired`，与「`report_contradicted` 不落 expired」直接冲突；表里也没有 `uphold_*` 到结论的映射。规则写死：**`report_contradicted` 只许 `approved` / `rejected`，`expired` 对它无效**；新增专行——`uphold_report → approved`、`uphold_decision → rejected`，两者都带 `resolution`，同事务 `closed` 并清节点上的 `hang_reason` / `contradiction_decision_id`。落在 §8。补用例：contradicted decision 到 48 小时仍活跃；两条 resolution 各落对应结论，不留悬空行。

6. **[致命] `confirm_not_started` 与 `confirm_started` 对称查 executor（原致命 6）**：原先只写 `has_tool_call=true` 拒、桥断 paused，缺 deleted / unloaded / 状态未知三支，可能把已发出调用的 attempt 重排。规则写死五条（`has_tool_call` 闸门 + 四个 `executor.state` 分支）：**`has_tool_call=true` → 拒（RESOLUTION_NOT_AVAILABLE）；`deleted` → 无对象可查，按人证接受（幂等 → superseded + 新行，不可重试 → failed）；`unloaded` → 先 resume 查 `has_tool_call`；状态未知 → 先重查再定；桥断 → 先转 `paused_bridge_missing`**。落在 §7、§8、§9、§14。补用例：unloaded 且实有 `tool_call` → 拒；deleted 且幂等 → 旧行 superseded、新行建出。

7. **[重大] 终态清单只留一处权威（原重大 7）**：§3.4j 第 3 条又完整抄了一遍终态集合。规则：**§3.4j 改为指向 §8，不抄集合**；§8 的集合补 `superseded` 并写中性语义，全文只此一份。落在 §3.4j、§8。补用例：全文搜终态清单只命中 §8 一处；§3.4j 搜不到第二份花括号清单。

8. **[重大] §14 唯一约束用例补全（原重大 8）**：五类行级唯一约束只测了四类。规则：**补 `node_runs(run_id, node_id, attempt)` 重复插入必须被拒（SQLITE_CONSTRAINT）**；换新 `node_run_id` 但 `run_id / node_id / attempt` 不变同样被拒；同一 `origin_node_run_id` 建第二行被部分唯一索引拒；`(node_run_id, attempt, seq)` 的重复插入同样被 UNIQUE 拒，重放另走查重、不得新增。落在 §14。补用例：删掉任一唯一键，对应 M 用例必须失败；重试建新行必须换 attempt。

9. **[重大] M 用例覆盖到跨行操作（原重大 9）**：`M-56` 是跨行挂起，不对应单行；`continue_tracking` 原无用例。规则：**M 总数先扩到 58**——M-56 标「跨行闸门」并加 STALE_HANG 断言，新增 M-57（continue_tracking）、M-58（重试建行）；清单头说明编号按新增顺序、不按表内行序。**v21 再补 M-59（uphold_report 收口）**，总数到 59。落在 §8。补用例：M-01…M-59 全绿才算迁移表验收。**v22 已扩到 M-01…M-61（见 §3.4n 第 6 条），以新清单为准。**

10. **[重大] 一个半态只有一个时间基（原重大 10）**：`unknown_watchdog` 与桥断预算两个 120 秒可分别触发。规则写死：**桥断时 watchdog 停走，累计只记在 `bridge_absence_accumulated`**；超预算只生成一条 `startup_unknown` decision（同 `decisions_node_kind_uq ON decisions(node_run_id, kind)` partial unique index 去重；`unknown_reason` 不是 decisions 列），节点留在 `paused_bridge_missing`，桥断期间不迁 `startup_unknown`。落在 §2、§3、§7、§8。补用例：桥断 120 秒后只有桥断 decision，没有 watchdog decision；同一次桥断只一条 decision。

11. **[措辞] 「四组用例」改「五组」**：§11 capability 段与 §3.4k 第 4 条实际列了五组。规则：并列写全五组——mutating + 可执行补偿描述符 → compensable；mutating + 无描述符 → irreversible；声明 pure 但含 mutating → SIDE_EFFECT_UNDECLARED；声明 compensable 但描述符不可执行 → SIDE_EFFECT_UNDECLARED（另报 COMPENSATION_UNEXECUTABLE）；声明 compensable 而推导是 pure → SIDE_EFFECT_UNDECLARED。落在 §9、§3.4k。

12. **[措辞] 两轮审计分开计数**：第十九轮是 9 致命 + 3 重大（落 v18），第二十轮是 10 致命 + 2 重大（落 v19），原先被写成同一轮。规则：§3.4i 头注与 §3.4k 引言各写各的轮次与计数，不再合并。落在 §3.4i、§3.4k。

13. **[措辞] run 终态是五个名字不是四个**：`{succeeded, failed, succeeded_with_unverified, failed_with_unverified, orphaned}`。规则：§3.4i 的「这四个名字」改五个并列出，run 终态枚举仍以 §8 那行为准。落在 §3.4i、§8。

14. **[措辞] 调度错误名还给调度**：decision revision 冲突不再借 `schedule_conflict`。规则：`continue_wait` / 任何 decision revision 冲突一律 `DECISION_REVISION_CONFLICT`。落在 §8。

### 3.4m 第二十二轮审计修订清单（v21，历史）

本清单记录 v21 的落法，已被 §3.4n 与 §3.4o 相继取代，仅作历史条目。§3.4 – §3.4l 同样为历史条目。**第二十二轮审计的 3 条致命 + 5 条重大 + 4 条措辞**逐条落到正文，版本升 v21。这一轮不新增状态格、不改重试模型，只把上一轮落进正文但没落全的四类缝隙补死：行级唯一约束要对得上「attempt 必换行」这个事实；桥断不许再从任何入口漏进 `startup_unknown`；`hang_reason` 闸门要逐行内联，不能只写在总则；裁决收口要有自己的用例与单一结果。

1. **[致命] 行级唯一约束改成真约束（原致命 1）**：`UNIQUE(node_run_id, attempt)` 是伪约束——`node_run_id` 本身就是行标识，新 attempt 必换行，这个键恒真。规则写死：**`node_runs` 上加 `UNIQUE(run_id, node_id, attempt)`**，并对重试双指针加 `CREATE UNIQUE INDEX node_runs_origin_uq ON node_runs(origin_node_run_id) WHERE origin_node_run_id IS NOT NULL`（同一旧行只许建一行新行）；`report_registry(report_id PRIMARY KEY)`、`UNIQUE(node_run_id, attempt, seq)`、`decisions(decision_id, revision)`、`node_run_events(event_seq)` 不变。M-58 改测「同 `run_id / node_id / attempt`、换新 `node_run_id` 插入必须被拒」。落在 §8 行→幂等键表、§14 DDL、M-58。补用例：删掉任一唯一键，对应 M 用例必须失败；重试建新行必须换 attempt。

2. **[致命] 桥断不许从任何入口进 `startup_unknown`（原致命 2）**：§3 桥断矩阵的启动层行原先写「恢复后已过期就按启动层到点判（进 startup_unknown）」，§3 启动层与 §8 的 `startup_unknown` 行又留了「桥断拿不到事实」与「由桥断累计超预算转进来」两个入口。规则写死：**桥断一律先转 `paused_bridge_missing`；`startup_unknown` 只由 `startup_timeout` 一个入口进入**。桥恢复时先查 `executor.state` 再判去路，不许凭「桥断过」直接迁入；桥断累计超预算时**节点留在 `paused_bridge_missing`，只生成一条 `startup_unknown` decision**（`unknown_reason = bridge_absence` 只是 decision 行上的标记），节点不迁入 `startup_unknown`。落在 §3 桥断矩阵、§3 启动层、§7 sweep、§8 迁移表。补用例：桥断 120 秒后节点仍在 `paused_bridge_missing`；桥恢复后先查 executor.state，事实不明才进 `startup_unknown`。

3. **[致命] `hang_reason` 闸门逐行内联（原致命 3）**：§8 的「统一前置条件」只写了总则，逐行 CAS 只有两行带 `AND hang_reason IS NULL`。规则写死：**凡从 `startup_unknown` 或 `indeterminate_side_effect` 迁出的普通出口，逐行 CAS 都必须带 `AND hang_reason IS NULL`**；挂起时唯一能走的是 `uphold_report` / `uphold_decision` 两条 resolution 行与桥断边 `→ paused_bridge_missing`，其余出口返回 STALE_HANG。例外共三处（v22 补正）：`uphold_report` 收口行、`uphold_decision` 收口行（两条 resolution 行都在同笔事务清 `hang_reason` 与 `contradiction_decision_id`）与桥断边。落在 §8 每一行迁移。补用例：挂起时普通 report 落库返回 STALE_HANG；两条 resolution 行收口后 `hang_reason` 与 `contradiction_decision_id` 都为空。

4. **[重大] `uphold_report` 补 M-59（原重大 1）**：M-56 只是跨行挂起闸门，没有断言 `applyReport` 带 decision、revision CAS 与目标 `done` / `failed`。规则：**新增 M-59**——断言 `applyReport(node_run_id, attempt, report, expected_status, generation, decision)` 的第 6 参带 `{decision_id, revision, resolution=uphold_report}`，先 CAS `decisions`（冲突返回 `DECISION_REVISION_CONFLICT`），再按报告落 `done` / `failed`，同笔清 `hang_reason` 与 `contradiction_decision_id`，原写 `rearm_generation=Gr`（v22 起不占 Gr，历史条目以此注为准）。M 总数改 **M-01…M-59**（v22 已扩到 M-01…M-61，见 §3.4n 第 6 条）。落在 §8 用例清单与 M-59。补用例：decision revision 过期时 node_run 一个字节不动；收口后节点不在 `startup_unknown` / `indeterminate_side_effect`。

5. **[重大] 状态未知重查要有闭合落点（原重大 2）**：§7 sweep 与 §9 裁决出口只写「状态未知 → 先重查再定」，重查仍不明没有落点。规则写死：**重查仍不明 → RESOLUTION_NOT_AVAILABLE，只余 `indeterminate_side_effect` / `abandoned_unverified` 两个出口**，与 §3 启动层、§8 相关行同一口径；不许凭猜落 `superseded`、`done` 或 `failed`。落在 §3、§7、§8、§9。补用例：重查两次仍不明时 confirm_not_started 被拒；节点只能在两个合法出口里选。

6. **[重大] report CAS 用 `effective_deadline_at`（原重大 3）**：`started → done` 行原先写 `deadline_at > now`，与 §3 回写段的时限口径不一致。规则写死：**所有 report 回写 CAS 一律用 `now <= effective_deadline_at`**；`effective_deadline_at` 的定义保持「有 `action_deadline_at` 就用它，否则用 `deadline_at`」。除本条解释外，全文搜 `deadline_at > now` 为 0。落在 §8 迁移表。补用例：动作时限已延长时，旧 `deadline_at` 到点不误拒合法 report。

7. **[重大] decision 唯一键只留一套（原重大 4）**：一处写 `(node_run_id, attempt, kind, unknown_reason)`，另一处写 `(node_run_id, kind)` partial unique index，且 `unknown_reason` 不是 `decisions` 列。规则写死：**统一为 `decisions_node_kind_uq ON decisions(node_run_id, kind) WHERE node_run_id IS NOT NULL`**；run 级用 `decisions_run_kind_uq ON decisions(run_id, kind) WHERE run_id IS NOT NULL`。`unknown_reason` 只作 decision 行标记，不进唯一键。落在 §2、§3、§8、§14。补用例：同一次桥断重复 tick 只递增 `revision`，不新增第二行。

8. **[重大] M-06 补拒绝路径（原重大 5）**：M-06 只测 `has_tool_call=false` 的 happy path。规则：**M-06 必须同时断言 `has_tool_call=true` → RESOLUTION_NOT_AVAILABLE，不得落 `superseded`**；并覆盖 `deleted` / `unloaded` / 状态未知 / 桥断四个 `executor.state` 分支（共五条）。落在 §8 M-06。补用例：`has_tool_call=true` 时旧行 attempt 与 status 都不动；`deleted` 且幂等时旧行 `superseded`、新行建出。

9. **[措辞] 旧「四条」措辞统一改五条（原措辞 1）**：`confirm_not_started` 的闸门实际是 `has_tool_call` 闸门 + `deleted` / `unloaded` / 状态未知 / 桥断四个 `executor.state` 分支。规则：**§7、§8、§9、§14 与 §3.4l 相关条目一律写「`has_tool_call` 闸门 + 四个 `executor.state` 分支（共五条）」**，不再写旧的四条说法。补用例：搜旧措辞的计数为 0（本条解释除外）。

10. **[措辞] 历史清单里的行号改对（原措辞 2）**：§3.4l 第 4 条引「L138」应为 `L139`（§3 `report_contradicted` 挂起段在 L139）。落在 §3.4l 第 4 条。

11. **[措辞] capability 五组用例在 §11（原措辞 3）**：§3.4l 第 11 条写「§9 capability 段」，实际五组用例在 §11。规则：改为「§11 capability 段」，与 §3.4k 第 4 条一致。落在 §3.4l 第 11 条。

12. **[措辞] 旧五参签名标作废（原措辞 4）**：§3.4j 历史条目里仍留 `applyReport(node_run_id, report, expected_status, generation, policy)`，读者会以为它还能用。规则：**该行加「（已作废，见 §3.4m 第 12 条）」**；生效签名是 §3 回写段的 `applyReport(node_run_id, attempt, report, expected_status, generation, decision?)`。补用例：搜旧五参签名只出现在 §3.4j 历史记录且带作废标记。

### 3.4n [HISTORY] 第二十三轮审计修订清单（v22，已被 §3.4o 取代）

本清单记录 v22 的落法，已被 §3.4o 取代，§3.4 – §3.4m 全部为更早的历史条目。**第二十三轮审计的 3 条致命 + 3 条重大 + 2 条措辞**逐条落到正文，版本升 v22。这一轮不新增状态格、不改重试模型，只把冲突裁决的另一半补成可执行路径，并把「对称」与「代次」两处写反的口径纠正。**其中第 1 条旧的 `action_generation = Ga` 与 M-60 旧断言已在 v23 修正，以 §3.4o 为准。**

1. **[致命] `uphold_decision` 补独立收口行与 M-60（原致命 1）**：v21 的 §8 只有 `uphold_report` 一条 resolution 行，`uphold_decision` 没有独立迁移行、没有清钟、没有执行类用例。规则写死：**新增一行 `startup_unknown / indeterminate_side_effect → superseded / failed（uphold_decision）`**，D1=原裁决、D2=`contradiction_decision_id` 指向的冲突裁决；**同一笔事务**先把 D2 落 `rejected + closed`（带 D2 的 `decision_id + revision` 与活跃状态白名单，冲突返回 `DECISION_REVISION_CONFLICT`，节点格不动），再按 D1 的 `decision_id + revision` 收口节点；节点 CAS 带 `hang_reason = report_contradicted` + `contradiction_decision_id = D2` + `rearm_generation = Gr`，清 `hang_reason` / `contradiction_decision_id`，来源为 `startup_unknown` 时清 `startup_unknown_deadline_at`；幂等 → 旧行 `superseded` + 新建 attempt 行（双指针回写），不可重试 → `failed`；迟到 report 标 `stale`。落在 §8 迁移表与 M-60。补用例：D2 revision 过期时节点一个字节不动；收口后节点不在 `startup_unknown` / `indeterminate_side_effect`。
2. **[致命] 旧 `queued` 口径清零（原致命 2）**：§3 L139 与 §9 L443 仍写 `uphold_decision` 后「原裁决照常迁 `queued` / `failed`」，与 §8 的 `superseded` / `failed` 目标冲突。规则写死：**两处统一改成「原裁决照常走 `superseded` / `failed`：幂等 → 旧行 `superseded` + 新建 `queued` 新行，不可重试 → `failed`」**，并指向 §8 的 `uphold_decision` 行与 M-60。落在 §3、§9。
3. **[致命] `has_tool_call=true` 只拒 `confirm_not_started`（原致命 3）**：v21 把「`has_tool_call` 闸门 + 四个 `executor.state` 分支（共五条）」整体说成与 `confirm_started` 对称，照字面实现会把已观测 `tool.start` 的合法 `confirm_started` 误拒。规则写死：**四个 `executor.state` 分支与 `confirm_started` 对称；`has_tool_call=true` 闸门只对 `confirm_not_started` 生效**；`confirm_started` / `confirm_started_attested` 仍只拒 `called_no_start` 或无开跑证据。新增 **M-61**：已观测 `tool.start` 且 `has_tool_call=true` 时 `confirm_started` 必须接受，迁 `stopping` 并清 `startup_unknown_deadline_at`。落在 §7、§8、§9、M-61。
4. **[重大] `uphold_report` 迁出 `startup_unknown` 要清钟（原重大 1）**：L280 的 CAS 与 M-59 只清 `hang_reason` / `contradiction_decision_id`，没有清 `startup_unknown_deadline_at`。规则写死：**来源为 `startup_unknown` 时，L280 CAS 加「清 `startup_unknown_deadline_at`」；M-59 加断言 `startup_unknown_deadline_at IS NULL`**。落在 §8 L280 与 M-59。
5. **[重大] `uphold_report` 的代次例外写死（原重大 2）**：L280 用 `Ga`，§3.4h 的代次矩阵却把「裁决收口类」统写 `Gr`，实现者无法判断旧定时器该不该被挡。规则写死：**`uphold_report` 是 report 回写边，节点 CAS 用 `Ga`；decision 行用 `decision_id + revision` 收口，不重新武装任何时限，不占 `Gr`**。§3.4h 的执行器回写类与一句话判据各补这一条例外。落在 §3.4h。
6. **[重大] `uphold_decision` 补执行类用例（原重大 3）**：M-56 只断言「只认两条 resolution」，M-59 只测 `uphold_report`，`uphold_decision` 无执行面覆盖。规则：**新增 M-60，覆盖 D2 收口、D1 收口、同笔事务、清 hang 与清钟、superseded 双指针（M-60 断言新行 origin_node_run_id 与 attempt）、failed 支不建新行、stale 标记**；M 清单头与验收口径改 **M-01…M-61，61 条全绿**（M-60 见第 1 条，M-61 见第 3 条）。落在 §8 用例清单与 M-60。
7. **[措辞] `uphold_decision` 行数与例外数对齐（原措辞 1）**：v21 的 L287 / L798 说「两条 resolution 行」，例外却只列了 `uphold_report` 与桥断边两处。规则写死：**例外共三处——`uphold_report` 收口行、`uphold_decision` 收口行与桥断边**；两处措辞与 §8 实际行数一致。落在 §8 总则与 §3.4m 第 3 条。
8. **[措辞] `startup_unknown` 的 Gr+1 只给需要重新武装的出口（原措辞 2）**：v21 的 L385 把「`startup_unknown` 的裁决出口（并 Gr+1）」写成所有出口一律 +1，与逐行 CAS 不一致——终态出口不再重新武装时限。规则写死：**需要重新武装时限的出口（`stopping` / `continue_tracking` / 钟为空需补写的重入）并 `Gr+1`；终态出口（`superseded` / `failed` / `abandoned_unverified`）只 CAS `Gr`，不 +1**。落在 §3.4h 代次矩阵。

### 3.4o [HISTORY] 第二十四轮审计修订清单（v23，历史条目）

本清单是 v23 当时的生效清单，现由 §3.4p 取代；§3.4 – §3.4n 全部为更早的历史条目。**第二十四轮审计的 1 条致命 + 1 条重大 + 2 条措辞**逐条落到正文，版本升 v23。这一轮不新增状态格、不改 M 总数（仍 M-01…M-61），只修裁决终态出口的代次冲突与 M-60 的执行面缺口。

1. **[致命] 裁决终态出口只 CAS `Gr`，不再带旧 `Ga`（第二十四轮致命 1）**：L231 / L279 / L281 三行与 M-60、§3.4n 第 1 条在 v22 里都曾把 `action_generation = Ga` 写进人裁决驱动的终态出口，与 §3.4h「裁决收口类用 `Gr`、唯一例外是 `uphold_report`」冲突；同一迁移两套互斥规范，实现按 §3.4h 会过不了 M-60。规则写死：**`startup_unknown` / `indeterminate_side_effect` 的 `superseded` / `failed` 终态出口只 CAS `rearm_generation = Gr`（不 +1），删除 `action_generation = Ga`；`uphold_report` 的 Ga 例外不变。** 落在 §8 L231/L279/L281、M-60 L366、§3.4n 第 1 条。补断言：M-60 的节点 CAS 不含 Ga；旧 Ga 围栏只属于 report 回写边。

2. **[重大] M-60 补齐 origin 指针、attempt 与 failed 支断言（第二十四轮重大 1）**：M-60 原只断言 `superseded` 支回写 `replacement_node_run_id`，缺新行 `origin_node_run_id`、`attempt = 旧 attempt + 1` 与 `failed` 支。规则写死：**M-60 的 `superseded` 支断言新行 `origin_node_run_id = 旧行.node_run_id`、`attempt = 旧 attempt + 1`、旧行 `replacement_node_run_id` 回写；`failed` 支断言 `status=failed` 且不建新行。** 落在 M-60 与 §3.4n 第 6 条（双指针由 M-60 断言）。补断言：failed 支错误建新行时 M-60 必须失败。

3. **[措辞] `report_contradicted` 总则的路径数补成三处（第二十四轮措辞 1）**：L288 说「两条 resolution 行」与桥断边，但没写「共三处路径」，与 §3.4m 第 3 条的「例外共三处」字面不一致。规则写死：**L288 补「（共三处路径：`uphold_report`、`uphold_decision` 与桥断边）」。**

4. **[措辞] §3.4m 第 4 条的历史 M-59 代次补注（第二十四轮措辞 2）**：L803 仍写 M-59「并写 `rearm_generation=Gr`」，与 v22 起 M-59 不占 Gr 的现行口径不一致。规则写死：**在 L803 该句后补「（v22 起不占 Gr，历史条目以此注为准）」。**

### 3.4p [CURRENT] 第二十八轮审计修订清单（v27，已在正文生效）

本清单是当前唯一生效清单，§3.4 – §3.4o 全部为历史条目。**第二十八轮审计的 0 条致命 + 1 条重大**逐条落到正文，版本升 v27。这一轮不新增状态格、不改 M 总数（仍 M-01…M-61），只修「高风险 decision.resolve 的两阶段确认」与「inbox 幂等账」的先后顺序。

1. **[重大] 预检不占幂等账，challenge 先验于冲突判定（第二十八轮重大 1）**：原 L1137 要求每条命令先落 inbox，L1138 / L1139 的幂等与冲突判定又排在 challenge 校验之前；高风险 resolve 的第一次预检因此会占掉 operation_id，第二次带 challenge 的请求要么被当成重放、要么在换 payload 时先报 OPERATION_ID_CONFLICT，Q-15 的 CONFIRMATION_MISMATCH 永远走不到。规则写死：**第一次不带 challenge 的高风险 resolve 只做预检，不落 command 行、不写回执、不占 operation_id；第二次带 challenge 的请求先看终结回执与在途行，没有才验 challenge 绑定；终结回执的复放优先于 challenge 过期 / 消费检查；落行靠 operation_id 唯一键兜底，并发撞键重读后按回执复放或 COMMAND_BUSY 处理。**「预检之后、正式执行之前」换 payload / resolution / operation_id → CONFIRMATION_MISMATCH；执行成功后换 payload → OPERATION_ID_CONFLICT。落在 §4.6.2、§4.6.3、Q-15。补断言：Q-15 的换 payload 分支必须命中 CONFIRMATION_MISMATCH 且 inbox 无 command 行；成功后的同 payload 重发命中 replayed=true；成功后的换 payload 命中 OPERATION_ID_CONFLICT。

### 3.5 本段最容易被低估的一处

超时不是一个事件，是两件事：「我已经宣告它超时了」和「它真的停了」。把两件事合成一件，不可中断的动作就会被自己的围栏判死——动作还在跑，节点却已经收不到任何回写，最后只能一路拖到 indeterminate_side_effect。这不是取消失败，是状态机少了一格：宣告之后还得有「已请求停止、仍在跑」这一格，让它自己跑完、或者由人裁决。

同一类毛病还有一处对称的：任务会话如果带着工具，它就能替人动手，账上却只记着引擎的状态。协调位就该没有手。

第十三轮又挖出两处同源的错，性质一样：**把两件事当成一件**。一是生命周期——插件卸载、宿主退出、服务存活本是三件事，混成一件就会出现「重载插件顺手停了服务、宿主被强杀后服务占着锁不让下次启动」。二是状态归属——「动作还在跑」和「动作已经停了」是两件事，把前者塞进后者专用的格子（blocked_post、indeterminate_side_effect），账上就先收了口，现实里那把刀还在落。最危险的不是报错，是账本在事情没做完的时候说它做完了。

所以这一轮的规矩是：**还可能在动的东西，不能进不依赖执行器的格子；不能自证的东西，不能当证据用。**

第十四轮挖出来的是同一族的第三种错：**把「没观测到」当成「没发生」，把「签了字」当成「副作用已结算」**。启动层超时曾被当成「动作没开跑」，于是引擎自动重试了一个可能已经开跑的不可逆动作——账上干净，副作用再来一次；而 abandon_ack 签了字曾被当成收尾，于是一笔没验证的副作用从清单里消失了。所以这一轮的规矩是：**没观测到，不等于没发生；签了字，只是人接下了后果，不等于副作用已被验证。**

第十五轮挖出来的是同一族的第四种：**把两种不同的代次当成一种，把「作者说的话」当成「事实」**。代次混用，会把动作已经做完的那条合法回写当成旧代次丢掉——账上还在等，现实里早已收工；而副作用等级与证据强度若由作者声明，闸门就握在被闸的人手里，写命令声明成「只读」便能一路通行。所以这一轮的规矩是：**一道栅栏只管一件事；闸门的判据必须来自系统观测，不能来自当事人的自我描述。**

第十六轮挖出来的是同一族的第五种：**代次靠人记、状态靠人写、闸门只管一种节点**。代次混用，会让一条看起来合法的旧路径把节点推走，账上还显示它在正常收口；被挡下的回写没有幂等账，迟到的完成会凭空消失或被收两遍；capability 闸门只挡住 tool 节点，agent 与任务会话照样能把写操作带进来。所以这一轮的规矩是：**每种迁移用哪个代次，写进矩阵不靠记；每份被挡的回写，先有账再谈重放；闸门要盖住所有能动手的入口，不许只查一处。**

第十七轮挖出来的是同一族的第六种：**把「裁决了」当成「收口了」，把「没观测到」当成「没开跑」，把「账本结了」当成「现实结了」**。人证开跑若没有落点，裁决完了节点反而无处可去；启动层未观测到 tool.start 却迁进 stopping，一个可能根本没跑的动作会被写成正在停；而 run 落成 succeeded 的那一刻，现实里的动作可能还在落刀——签字只解了裁决门，没解「动作仍在跑」。所以这一轮的规矩是：**账本先收口、现实还在动——签字只解裁决门，不解动作仍在跑；人已经裁决的，不能让节点无处可去。**

第十八轮挖出来的是同一族的第七种：**把「一种情况」当成「一种情况」，把「事实」当成「将来会有」**。半态只写了一种情况，另一种情况就没有时钟、没有证据门、没有迟到回写的去处——节点既等不到收口，账上也接不住它的回写；而「独立确认停止」若不落成事实字段，run 的终态 CAS 就没有可读的事实，只能靠推测收口；补偿若没有写死事件名与证据字段，账上就看不出补偿到底发生过。所以这一轮的规矩是：**半态拆成几支，每支都要自己的时钟、证据门、迟到回写和账目位置；终态只读事实字段，不读推测；契约里的事件名与字段要写死，不要留给实现时再定。**

第十九轮挖出来的是同一族的第八种：**把「停了」当成「结算了」，把「抄一份」当成「定一份」**。半态的钟有两个 120 秒各走各的，离开半态后旧钟还留着没人看的火；「动作停了」被当成「副作用没发生」，于是账在现实仍落刀时先收了口；终态清单抄在好几处，改一处忘一处就漂移；回写边各写各的证据门，迟早有一行漏掉。所以这一轮的规矩是：**每个半态都要有自己的时钟、证据门、迟到回写路径和账目位置；停止不等于结算——账上写着动作停了，不等于副作用没发生；终态枚举只留一处权威，其它章节一律引用不改写。**

## 第四段 面板与查询（v2）

### 4.0 范围与四条硬边界

本段只回答三个问题：人从哪里看、能看到什么、能做什么。状态机、代次、证据门、桥断时钟都在第二、三段；本段只引用，不改写。**v2 的改动全部是读模型与展示契约，不碰状态机。**

**四条硬边界（实现时按这个顺序检查）：**

1. **面板不写库。** 面板、查询工具、订阅者都不打开 orchestra.db；读写一律经服务。面板进程即使能读到文件，也不许 `ATTACH` / `sqlite3` 直连。
2. **状态只由服务派生。** `display_status`、`reasons[]`、计数、`attention` 都由服务在响应里给出；面板不拿 `status` 自己拼，不在本地维护第二套状态机。服务没给 `display_status` 就显示 `status` 原文并标 `projection_missing`，不猜。
3. **事件只作失效信号，不作真值。** 面板收到事件后按 `seq` 校验连续性；连续则刷新受影响实体，断号则整页重取。事件 payload 可以展示，但不能拿它直接改本地状态。
4. **命令不做乐观更新。** 点下按钮只进入 `submitting`；服务确认后才改显示。超时不是失败，先按同一 `operation_id` 查回执，不许换新 id 重发。

**本段不新增的东西：** 不新增 node_run 状态、不新增 run 迁移、不新增 decision kind、不改终态集合、不改证据门。`pause` / `cancel` / `retry` 这类动作若没有第二、三段的迁移与命令契约，面板不提供入口；本版控制面只开 `decision.acknowledge` 与 `decision.resolve` 两个口。

### 4.1 三类读者与入口

| 读者 | 入口 | 能做什么 | 不能做什么 |
|---|---|---|---|
| 人 | 侧栏面板 | 浏览任务/run/节点、看证据、处理裁决、跳任务会话 | 直接写库；绕过服务改状态 |
| 主聊天与子智能体 | 只读查询工具 | 查任务、run、节点、裁决、事件、产物 | 发控制命令；代签裁决 |
| 外部订阅者 | 事件流 | 按 cursor 收事件、做告警/镜像 | 回写状态；读未脱敏 payload |

**任务会话跳转是导航，不是命令。** 面板只拿 `tasks.session_id` 调 DSH 的会话跳转；跳过去之后人说什么，仍走 DSH 自己的入口。任务会话默认没有工具（§1），面板不替它加。

**主聊天不代发命令。** 聊天里可以查到「哪条裁决卡着」，并给出面板深链；真正的裁决必须人在面板上点。这样 prompt injection 拿不到控制面。

### 4.2 读模型

所有响应统一信封：

```json
{
  "ok": true,
  "schema_version": 1,
  "as_of_seq": 12345,
  "generated_at": "2026-11-11T20:00:00Z",
  "data": {}
}
```

`as_of_seq` 是这次读取所见的最大事件 seq；不是「服务器当前时间」，也不是「客户端已确认」。错误信封同形，`data` 换成 `error`：

```json
{"ok": false, "schema_version": 1, "as_of_seq": 12345,
 "error": {"code": "DECISION_REVISION_CONFLICT", "message": "...", "retryable": false,
           "details": {"current_revision": 43}}}
```

**实体视图（字段名固定，后续只许加字段）：**

| 视图 | 关键字段 | 说明 |
|---|---|---|
| `TaskSummary` | task_id, title, workflow_id, workflow_version, status, display_status, current_run_id, session_id, run_count, open_decision_count, unverified_count, current_run_done, current_run_total, oldest_open_decision_age_seconds, max_side_effect_level, max_heartbeat_age_ms, attention, attention_reason, updated_at | `session_id` 只用于跳转；`current_run_done` / `current_run_total` 是当前 run 的进度，没有当前 run 时为空；三个聚合字段供任务行直接显示，不能只藏在 run 详情里 |
| `RunSummary` | run_id, task_id, workflow_version, status, display_status, reasons[], settling, counts{}, total, open_decision_count, unverified_count, oldest_open_decision_age_seconds, max_side_effect_level, max_heartbeat_age_ms, attention_reason, revision, started_at, ended_at, last_event_seq | `counts` 按节点状态分组，`counts` 之和必须等于 `total`；不把 `settling` 折进 `blocked`；三个 max 字段由服务聚合，用于 Q-09 |
| `NodeRunView` | node_run_id, node_id, seq, node_type, attempt, parent_node_run_id, origin_node_run_id, status, display_status, side_effect_policy, declared_effect, verified_effect, evidence_strength, evidence_state, action_start_source, attestation_id, executor{}, hang_reason, decision_id, started_at, deadline_at, action_deadline_at, heartbeat_age_ms | `display_status` 是服务给的展示映射，不替代 `status`；`evidence_strength` 只取 `strong` / `weak`；`attestation_id` 只进人证栏；`seq` 是节点拓扑序号，同一 `node_id` 的多个 attempt 共用同一个 `seq`，与 `report_registry` 的报告队列 `seq` 不是一回事 |
| `DecisionView` | decision_id, run_id, node_run_id, kind, status, priority, priority_reason, age_seconds, expires_at, expiry_effect, expiry_effect_reason, allowed_resolutions[], required_evidence[], current_revision, target_summary, confirm_required | `allowed_resolutions` 由服务给，面板不硬编码；`required_evidence[]` 只用于展示，不决定放行；`expiry_effect_reason` 是服务给的一句人话，缺默认动作时写「默认动作未定义」 |
| `EventView` | seq, event_id, type, occurred_at, run_id, node_run_id, decision_id, actor, summary, payload_redacted, payload_ref | `payload` 默认脱敏；原文走 artifact |
| `ArtifactView` | artifact_id, kind, media_type, bytes, sha256, created_at, retention_until, download | `download` 是短时签名句柄，不是本地路径 |
| `EvidenceView` | evidence_id, strength, source, observed_at, summary, artifact_id | `strength` 只取 `strong` / `weak`；本视图不承载人证 |
| `AttestationView` | attestation_id, claim, attested_by, attested_at, action_start_source, summary | 只证明「人看见动作开跑」这一状态事实；**不是证据，不进证据强弱，不支撑「已验证」** |
| `UnverifiedEffectView` | run_id, node_run_id, action, side_effect_policy, stopped_at, side_effect_verified_none, stop_evidence, evidence, last_known_phase, resolved, resolved_at, resolution_basis, age_seconds | 「已停止」与「已确认没发生」分两列；`resolved` 的派生式见 4.5.5；`resolved` / `resolved_at` / `resolution_basis` 来自 §14 的 `unverified_resolutions` 表，不在 `node_runs` 上另存 |

`DecisionView` 的 `priority` / `priority_reason` / `expiry_effect` / `expiry_effect_reason` 是 `decisions` 表列，v26 起进 §14 DDL；四列都由服务写，面板只读，不按 kind 前端推导。

`TaskSummary.attention` 是服务给的排序权重：`decision` > `unverified` > `failed` > `orphaned` > `running` > `none`；失败排在没人接手之前，因为它可能已经产生副作用；面板只按它排，不自己算。每一档同时带 `attention_reason`（一句人话），面板原样显示。

**`generated_at` 与 `as_of_seq` 必须成对显示。** 面板标题栏写「数据截至 HH:MM:SS · seq N」；不许写「实时」。超过 10 秒没新事件或 SSE 断开，加「可能已过期」横幅。

### 4.3 查询 API

#### 4.3.1 传输、认证、版本

- 服务在 `orchestra.endpoint` 公布命名管道或 `127.0.0.1` 随机端口；查询走同一个本地控制面，不另开公网端口。
- 插件读 `orchestra.secret` 后替面板附 token；**面板 JS 不持有原始 token**。面板只跟插件的本地路由说话，插件再转发给服务。
- 所有请求带 `protocolVersion` 与 `schema_version`；`hello` 返回 `capabilities[]`，面板按能力启用页面，不支持的入口显示「服务版本不支持」，不静默降级。
- 只接受当前用户 SID；拒绝其他本机用户；`Origin` 只允许 DSH 自己的 webview；`Cache-Control: no-store`。
- 认证主体就是命令的 `actor` 来源；请求体里的 `client.surface` 只作诊断，不参与授权。

#### 4.3.2 查询清单

| 查询 | 参数 | 返回 | 约束 |
|---|---|---|---|
| `list_tasks` | status?, attention?, query?, sort?, limit?, cursor? | TaskSummary[] + next_cursor | limit ≤ 100；`query` 只匹配标题子串；`attention` 取值含 `decision` / `unverified` / `orphaned` / `failed` / `running` / `none` |
| `get_task` | task_id | TaskSummary + 最近 10 个 run + 当前 run 摘要 | 单事务 |
| `list_runs` | task_id?, status?, display_status?, has_open_decisions?, has_unverified?, limit?, cursor? | RunSummary[] + next_cursor | limit ≤ 100 |
| `get_run` | run_id | RunSummary + counts + 最多 20 条 attention + 最多 20 条未决裁决 + 最多 20 条未验证副作用 | 单事务；完整列表走分页查询 |
| `list_nodes` | run_id, status?, node_type?, attention?, limit?, cursor? | NodeRunView[] + next_cursor | limit ≤ 200；按 seq、attempt 排；`node_type` 来自节点模板，不新增 `stage` 列 |
| `get_node` | node_run_id | NodeRunView + attempt 链 + 最近 50 条事件 + 证据/产物 + 人证 + 关联裁决 | 单事务；证据与人证分字段返回 |
| `list_decisions` | status?, kind?, run_id?, node_run_id?, min_age_seconds?, priority?, limit?, cursor? | DecisionView[] + next_cursor | limit ≤ 100 |
| `get_decision` | decision_id | DecisionView + target + allowed_resolutions + required_evidence + 最近 20 条事件 | 高风险时只给 `confirm_required=true`；`confirm_challenge` 在 `decision.resolve` 第一步返回，不随查询下发 |
| `list_unverified_side_effects` | run_id?, state?, limit?, cursor? | UnverifiedEffectView[] + next_cursor | `state` 取 `open`（默认）/ `resolved` / `all`；不可「忽略」；`resolved` 的派生式见 4.5.5 |
| `list_events` | after_seq?, before_seq?, run_id?, node_run_id?, decision_id?, types?, limit? | EventView[] + next_after_seq | limit ≤ 200；按 seq 升序 |
| `get_artifact` | artifact_id | ArtifactView | 下载句柄 5 分钟有效；不返回本地路径 |
| `get_evidence` | evidence_id | EvidenceView | 原文走 artifact，不内联大段 stdout；人证不在此接口 |
| `get_attestation` | attestation_id | AttestationView | 人证单独取；不参与证据门 |
| `verify_ledger` | run_id, from_event_seq?, to_event_seq? | valid, checked, head_hash, first_bad_event_seq? | 单次 ≤ 2000 条；这里的 seq 一律指 `node_run_events.event_seq`，不是 `events.seq`；超限报 `RANGE_TOO_LARGE` |
| `get_operation` | operation_id | 命令回执（status / result / error） | 只读；7 天内返回回执，过期返回 `OPERATION_EXPIRED` |

**分页口径写死：**

- `cursor` 是不透明字符串，至少含 `v`、`kind`、`filter_hash`、`last_key`、`last_id`、`as_of_seq`；服务端校验 `filter_hash`，换了过滤条件必须从第一页重取，返回 `CURSOR_FILTER_MISMATCH`。
- `cursor` 10 分钟过期，过期返回 `CURSOR_EXPIRED`；面板回到第一页，不拼接旧页。
- **单次响应强一致，跨页不承诺同一快照。** 每页都带自己的 `as_of_seq`；面板按 `id` 去重，后页覆盖前页，不把两页当成一张冻结快照。`as_of_seq` 只是「这批数据看到哪」的展示/诊断标记，不参与 cursor 有效性判断，也不作命令 CAS 依据（命令有 `expected.revision`）。
- `events` 的分页是例外：`after_seq` 是稳定游标，不按时间排序，不走 10 分钟过期；超过 30 天保留期返回 `CURSOR_EXPIRED`，带 `oldest_seq`。

#### 4.3.3 一致性、性能与错误

- 每个查询在**一个 SQLite 读事务**里完成；事务开头 `SELECT COALESCE(MAX(seq),0) FROM events` 得 `as_of_seq`，后续读都在这张快照上。`get_run` / `get_node` 不许把多次查询拼成一个响应。
- 读连接 `PRAGMA query_only=ON`；服务不把写连接借给查询层。
- 性能目标：`list_tasks` 1 万任务 p95 < 100ms；`get_run` 1000 节点 p95 < 150ms；`list_nodes` 单页 200 条 p95 < 80ms；`list_events` 单页 200 条 p95 < 50ms。达不到先加索引/减字段，不许把全表扫描藏进「分页」。
- `get_run` 只读摘要与 top-N，不把所有节点塞进一个响应；1000 节点 run 的完整视图必须走 `list_nodes` 分页。
- 查询超时 5 秒；超时返回 `QUERY_TIMEOUT`，面板显示错误与重试，不显示半页当完整。

查询错误码至少覆盖：`UNAUTHORIZED`、`PROTOCOL_VERSION_MISMATCH`、`SCHEMA_VERSION_UNSUPPORTED`、`NOT_FOUND`、`CURSOR_EXPIRED`、`CURSOR_FILTER_MISMATCH`、`RANGE_TOO_LARGE`、`QUERY_TIMEOUT`、`SERVICE_UNAVAILABLE`。命令类错误码见 4.6.3 的映射表；4.3.3 不重复列，避免两处漂移。

### 4.4 状态与可信度怎么显示

**先分清两套状态：run 的 `display_status` 与 node_run 的 `display_status` 不是同一张表。** run 只有五个终态加三个运行态；node_run 有二十个状态（十三个非终态 + 七个终态），半态不能折成 run 的三态，也不能折成「等待中 / 已开跑 / 已完成」。两张表都由服务派生，面板只渲染，不自己映射。

**run 的 `display_status`（只此八值）：**

| run display_status | 含义 | 颜色 |
|---|---|---|
| `succeeded` | 做完了，且副作用已核实 | 绿 |
| `failed` | 没做成，且没有未验证副作用 | 红 |
| `succeeded_with_unverified` | 做完了，但有一笔副作用没验证 | 黄 / 斜纹 |
| `failed_with_unverified` | 没做成，且有一笔副作用没验证 | 深红 + 风险角标 |
| `orphaned` | 有子节点成了孤儿，没有新 attempt 接手 | 灰 / 红边 |
| `running` | 正在跑 | 蓝 |
| `settling` | 正在结算未验证副作用 | 蓝灰 |
| `blocked` | 停住等人或等外部条件 | 琥珀 |

**node_run 的 `display_status`（展示映射，不改 `status` 原文）：**

| node status | 面板文案 | 颜色 | 必须同时显示 |
|---|---|---|---|
| `queued` | 排队中，还没派给执行者 | 灰 | 排队时长 |
| `leased` | 已分到执行位，等执行者接手 | 灰 | 租约是否快过期 |
| `dispatched` | 已派出，等执行者启动 | 蓝 | 已等待多久 |
| `started` | 已开跑，等回写 | 蓝 | 最后心跳 |
| `verifying` | 等验证 | 蓝灰 | 验证时限；到期会转人工 |
| `waiting` | 等外部条件 | 灰蓝 | 等的是什么条件 |
| `timing_out` | 已请求停止，正在确认停没停 | 琥珀 | **不代表已停**；围栏已立 |
| `stopping` | 已请求停止，动作可能还在跑 | 琥珀 | **不代表已停**；最后心跳 |
| `startup_unknown` | 启动情况不明——可能没开跑，也可能已开跑 | 琥珀 / 红边 | **不得显示「等待中」或「已开跑」**；不生成动作时限 |
| `indeterminate_side_effect` | 动作已停，副作用是否发生不明 | 红 | 已停的事实 + 等你决定 |
| `blocked_pre` | 执行前被挡住，等人处理 | 琥珀 | 挡它的是哪条前置 |
| `blocked_post` | 执行完了，结果等人定 | 琥珀 | 等你决定的事项 |
| `paused_bridge_missing` | 桥断了，先暂停跟踪 | 灰 | 桥断累计时长；不是终态 |
| `done` | 已完成 | 绿 | 证据强弱；无证据时不得显示「已验证」 |
| `failed` | 没做成 | 红 | 失败原因 |
| `timeout` | 超时收口 | 红 | 超时依据 |
| `abandoned_unverified` | 已放弃跟踪，副作用未核实 | 深红 | 未验证原因；签字不等于已核实 |
| `failed_with_unverified` | 没做成，且有副作用未核实 | 深红 | 未验证原因 |
| `orphaned` | 没有新 attempt 接手 | 灰 / 红边 | 为什么没接手 |
| `superseded` | 已被新 attempt 取代 | 灰 | 新 attempt 的 node_run_id |

**证据、状态、人证分四列，不许合成一个绿灯：**

| 列 | 字段 | 取值 | 约束 |
|---|---|---|---|
| 声明状态 | `status` / `display_status` / `reasons[]` | 上面两张表的原文 | 面板不改写，不合并 |
| 证据强弱 | `evidence_strength` | `strong` / `weak` / `—` | 只承载 §11 的强、弱两级；没有证据显示 `—`，**不显示 `none`** |
| 证据状态 | `evidence_state` | `none` / `not_required` | `none` = 策略要求证据但没有；`not_required` = 策略不要求。两者都不等于「已验证」 |
| 人证 | `action_start_source` / `attestation_id` | `human_attested` / `—` | 只证明「人看见动作开跑」这一状态事实；**不是证据，不进证据强弱，不支撑「已验证」** |

规则：

1. **run 终态优先。** run 的 `display_status` 只可能是上表八值；`succeeded_with_unverified` 与 `failed_with_unverified` 单独显示，绝不折成 `succeeded` / `failed`；`orphaned` 不许折成 `failed`。
2. **没有证据不许绿。** `succeeded` 可以绿；`succeeded_with_unverified` 用黄色/斜纹并带「有一笔副作用未验证」；`failed_with_unverified` 深红并带风险角标；`done` 节点 `evidence_state=none` 时只能显示「已完成，但缺验证证据」，不能显示绿色「已验证」；`evidence_state=not_required` 显示「已完成，按策略不要求验证证据」，同样不得标成绿色「已验证」。
3. **节点半态不许折。** 上表每一行是一种独立文案；`startup_unknown` 不得显示成「等待中」，`stopping` / `timing_out` 不得显示成「已停止」，`indeterminate_side_effect` 不得显示成「失败」。面板详情永远把 `status` 原文放在 `display_status` 旁边。
4. **`reasons[]` 必须露出来。** 每条给 `code + 一句人话 + 关联 id`；不许只放 tooltip。`blocked` 与 `settling` 同时存在时两个都显示。
5. **声明与验证分栏。** 节点详情固定两栏：左边「节点声明会做什么」（`declared_effect` / `side_effect_policy`），右边「系统观测到什么」（`verified_effect` / `evidence_strength` / `evidence_state`）。两边不一致时高亮，并链到相关裁决。
6. **停止不等于结算。** `stopped_at` 非空只显示「已停止」；只有 `side_effect_verified_none = true` 且带 `stop_evidence` 才显示「已确认未发生」。签字只显示「人已签字」，不显示「已验证」。
7. **人证单独一行。** `human_attested` 只出现在「人证」列，文案固定为「人证，不是系统证据」；它不能把 `evidence_strength` 从 `—` 变成 `strong`，也不能让节点变成绿色。
8. **未知不补零。** 拿不到计数显示「—」，不显示 0；拿不到状态显示 `status` 原文 + `projection_missing`，不猜 running；出现表外的新状态，同样显示原文并标「面板版本过旧」，不自行映射。

### 4.5 面板信息架构

**一级导航：任务 / 待你决定（裁决收件箱）/ 待核实（未验证副作用）。** 事件时间线、节点详情、证据与产物都是二级视图。界面用「你」和「等」，不用「裁决」「副作用」这类内部词；正式字段名只在悬停说明与开发者视图出现。

#### 4.5.1 任务列表（首页）

- 默认排序：`attention` 降序，再 `updated_at` 降序。
- 行：标题、工作流与版本、`display_status`、当前 run 进度（`current_run_done` / `current_run_total`）、未决裁决数、未验证副作用数、三个聚合字段（最久未决决定、最高副作用等级、最久心跳间隔）、`attention_reason`（一句人话，例如「有一个决定等你 8 分钟」）、最后更新时间。
- 过滤：`attention`（等你决定 / 待核实 / 已失败 / 没人接手 / 运行中 / 全部）、状态、工作流、标题搜索。`orphaned` 单列在「没人接手」，不能并进「已失败」。
- Q-09 要求的三个聚合字段在任务行与 run 头都能看到：最久未决决定等了多久、最高副作用等级、最久心跳间隔。
- 空态分两种：「还没有任务」（引导新建）与「当前过滤没有任务」（清过滤），不混。
- 点行进任务详情；不直接进 run，避免人只看一个 run 忘了任务历史。

#### 4.5.2 任务详情与 run 视图

- 顶部：任务标题、工作流版本、任务会话跳转、run 选择器（默认当前 run）。
- run 头：`display_status` 大标识、`reasons[]`、计数条（`total` + `counts{}`，按 status 分组）、开始/结束、`revision`、`last_event_seq`；右侧单列三个聚合：`oldest_open_decision_age_seconds`（显示成「最久的决定等了 8 分钟」）、`max_side_effect_level`、`max_heartbeat_age_ms`（显示成「最久 42 秒没心跳」）。
- 节点按 `seq` 升序、`attempt` 升序分阶段排列；每张卡片显示 `node_id`、`node_type`、attempt、`display_status`、副作用等级、证据强弱（`strong` / `weak` / `—`）、证据状态（`none` / `not_required`）、是否挂裁决。人证不在节点卡上占证据位，只在详情「人证」块出现。
- 右侧固定「风险栏」：未决裁决、未验证副作用、孤儿节点、桥断/超时理由；点条目打开抽屉，不跳走当前 run。
- 1000 节点 run 分页/虚拟滚动；首屏只取 `get_run` 的 top-N，滚动到边界再 `list_nodes`。

#### 4.5.3 节点详情抽屉

- 头部：`node_id`、`node_type`、attempt、`status` 与 `display_status`、副作用等级、`decision_id`、`hang_reason`。
- 五块：声明与验证、attempt 链、事件（最近 50 条，可展开）、证据与产物、人证。证据与人证必须是两个块，不能并成一个「证据」列表。
- `startup_unknown` 顶部固定横幅：「启动情况不明，不代表没开跑，不要据此重跑不可逆动作。」不显示「等待中」或「已开跑」。
- `stopping` / `timing_out` 横幅：「已请求停止，动作可能还在跑；确认停稳前不要重试。」不显示「已停止」。
- `indeterminate_side_effect` 横幅：「动作已停，但副作用有没有发生还不知道；已转人工，别自行重跑。」
- 不可逆节点没有 `verified_effect` 时，顶部固定黄色横幅：「该节点声明为不可逆，尚未看到验证证据。」
- `report_contradicted` 挂起时，横幅写「报告与裁决冲突，节点未迁出；新 attempt 被挡」，链到裁决。
- 人证块固定一句：「人证，不是系统证据；只证明有人看见动作开跑，不证明结果。」

#### 4.5.4 裁决收件箱（「待你决定」）

- 默认按 `priority` 降序、`age_seconds` 降序；服务给 `priority_reason`，面板不按 kind 硬编码顺序。
- 每张卡：目标 run/node、kind、当前状态、为什么卡住、`allowed_resolutions[]`、`required_evidence[]`、`expiry_effect`、`expiry_effect_reason`、`current_revision`。`required_evidence[]` 只展示「需要什么证据」，**不决定放行**；放行由 §9 裁决函数按 policy 判。
- **本版面板批量只允许 `acknowledge`。** `resolve` 一次一条；不同 kind 不合并，高风险不批量。§9 允许同 kind 批量裁决；若后续开放批量 resolve API，回执必须带 `affected[]`（`decision_id` / `revision` / `result`），部分失败逐条列出，不许只回一个总数。
- 卡上直接写「超时后会发生什么」：`expiry_effect` 只有 `auto_resolve` / `escalate_only` / `none` 三值，由服务按 kind 给人话（自动按默认结论收口 / 只升级通知不自动收口 / 超时不动作），面板不自己映射、不按 kind 前端推导。`report_contradicted` 固定显示「不会自动收口，只能人工处理」。**缺默认动作的 kind 一律返回 `escalate_only` 并在 `expiry_effect_reason` 写「默认动作未定义」，不许返回 `auto_resolve`；`auto_resolve` 只在 §9 对该 kind 写死了过期结论时出现。**
- 没有「忽略」按钮；不想处理就保持未决，收件箱继续显示。

#### 4.5.5 未验证副作用（「待核实」）

- 独立一级页，不藏在 run 里。
- 列：run、node、动作摘要、副作用等级、`stopped_at`、`last_known_phase`、验证状态、证据、年龄、`resolved` 与 `resolution_basis`。
- **`resolved` 的唯一判定规则（写死，别处不另算；§9 收口事务判一次后落 `unverified_resolutions` 表）：**
  1. `side_effect_verified_none = true` 且 `stop_evidence` 非空 → 已确认没发生，`resolution_basis = verified_none`；或
  2. 有证据或裁决核实副作用**已经发生**，且 §9 收口事务在 `unverified_resolutions` 表写入 `resolution_basis = evidence | decision` 与对应 `evidence_id` / `decision_id`。
- **读模型只认表：** `unverified_resolutions` 没有该 `node_run_id` 的行就是 `resolved=false`；读到行就是 `resolved=true`，`resolved_at` / `resolution_basis` 直接取该行，不在查询时重算。
- run 进终态只「承接」未验证标记（`succeeded_with_unverified` / `failed_with_unverified`），**不消项、不改写 `resolved`**；已解决的可以按 run 查，但不从历史消失。
- 没有「关闭/忽略」；只能走上面两条路。
- 顶部固定一句：「签字只表示人接下了后果，不表示副作用已消失。」

#### 4.5.6 事件时间线

- 按 `seq` 升序；支持按 run/node/decision/type 过滤；每行显示 seq、时间、type、actor、一句摘要、`payload_redacted` 标记。
- 事件详情抽屉展示脱敏 payload；原文走 artifact 下载，不在面板内联大段 stdout。
- 顶部徽章写清对象：「**本 run 的 `node_run_events` 链校验结果**」（`valid` / `first_bad_event_seq` / 未验证）。`events` 表只有单调 `seq` 与 outbox，**没有哈希链**；不许把 `events` 说成链，也不许拿 `verify_ledger` 的结果给 `events` 背书。
- 未验证不显示绿灯；校验没跑过就显示「未校验」。

#### 4.5.7 证据与产物

- 证据卡只放：`evidence_id`、`strength`（`strong` / `weak`，没有证据显示 `—`）、来源、观测时间、摘要、artifact 链接。`none` / `not_required` 属于证据状态，单独一列，不混进强度。
- 人证卡单独放：`attestation_id`、谁、何时、看见什么（`claim`）、`action_start_source`，固定标「人证，不是系统证据」。
- 产物卡：类型、大小、sha256、保留到何时；下载按钮拿短时句柄，不在页面里放本地路径。
- 超过保留期的产物显示「已过保留期」，下载按钮禁用并说明原因。

### 4.6 操作命令

#### 4.6.1 统一信封

```json
{
  "operation_id": "018f...",
  "command": "decision.resolve",
  "target": {"decision_id": "dec_..."},
  "expected": {"revision": 42},
  "payload": {"resolution": "confirm_applied", "evidence_ids": ["ev_..."], "note": "..."},
  "client": {"surface": "panel", "version": "1.0.0"}
}
```

- 信封**不带 `actor`**。`actor` 由服务从认证主体派生（DSH 当前用户 SID + 面板会话绑定），客户端自报的 `client.surface` 只作诊断，不作授权依据。
- `operation_id` 由面板生成 UUIDv7；同一笔操作重试必须复用，不许换新。
- `expected.revision` 必填；服务用它做 CAS，不匹配返回 `DECISION_REVISION_CONFLICT`，并在 `details` 带当前 revision 与 status。
- 服务端只接受 `command` 白名单；本版只有 `decision.acknowledge` 与 `decision.resolve`。
- 命令处理只调用 §9 已有的裁决函数，不在命令层复制状态机；裁决函数与 inbox 回执在同一事务提交。

#### 4.6.2 幂等与回执

- **不变式：一个 `operation_id` 最多一条 `kind='command'` 行；预检不产生 command 行；终结回执只由执行阶段写一次。**
- 每条**进入执行阶段**的命令先在 `inbox` 落一行 `kind='command'`，`idempotency_key = operation_id`，`payload_hash = SHA256(JCS(payload))`（RFC 8785 规范化 JSON；键序、数字、字符串转义都按该规范，不用普通 `JSON.stringify`）。**高风险 `decision.resolve` 的第一次预检是唯一例外**：不带 `confirm_challenge` 时只走 §4.6.3 的预检，不落 command 行、不写回执、不占 `operation_id`。
- 幂等判定先看**终结回执**（`applied` / `rejected`）：同一 `operation_id` + 同一 `payload_hash` → 返回已存回执，`replayed=true`，不重复执行；同一 `operation_id` + 不同 `payload_hash` → `OPERATION_ID_CONFLICT`，一个字节不改。终结回执的复放不受 challenge 过期或已消费影响，先命中回执就直接返回。
- 没有终结回执、但 `inbox` 里已有同一 `operation_id` 的非终结行（另一请求正在写）：返回 `COMMAND_BUSY`，不覆盖、不并行执行。落 command 行时由 `operation_id` 唯一键兜底；并发插入撞唯一键的请求重读该行：已有终结回执按复放返回，仍是非终结行返回 `COMMAND_BUSY`。
- 没有终结回执、也没有非终结行时：带 `confirm_challenge` 的请求**先验 challenge**（签名、过期、`decision_id` / `revision` / `resolution` / `payload_hash` / `operation_id` 绑定），通过后再落 command 行并执行；绑定不符 `CONFIRMATION_MISMATCH`，过期 `CONFIRMATION_EXPIRED`，revision 不符 `DECISION_REVISION_CONFLICT`。这样「预检之后、正式执行之前」换 payload / resolution / operation_id 会报 `CONFIRMATION_MISMATCH`，不会被 `OPERATION_ID_CONFLICT` 抢先。
- 不带 challenge 且该命令需要确认：只做预检并签发 challenge，不落 command 行；不需要确认的命令直接落 command 行并执行。预检不做幂等复放：重复预检每次签发新 challenge，旧 challenge 未使用仍有效至过期，但同一 operation_id 最终只能执行一次。
- 持久化的 command 行只有 `in_flight` / `applied` / `rejected` 三种 `result_state`；面板的「结果未知」是查询态，不是第四种落库状态。回执可查窗口 7 天；command 行本身不物理删除（只清 `receipt_json`），过期后 `get_operation` 与任何同 `operation_id` 的复放都返回 `OPERATION_EXPIRED`，不重新执行；要重做必须由人核对现状后换新 `operation_id`。过期判定优先于复放与冲突判定。
- `inbox` 的 `kind='command'` 行不参与 §7 的 wait 匹配；wait 只读 `kind='event'`。
- 命令成功后追加 `command.applied` 事件，并把该 inbox 行落为 `applied` 终态；进入执行阶段的命令校验失败时，追加 `command.rejected`（`operation_id`、错误码、actor），把该行落为 `rejected` 终态，但不写业务状态。`inbox` command 行的字段（至少 `operation_id`、`payload_hash`、`result_state`、`receipt_json`、`completed_at`）与唯一键在 §14.2 DDL 收口，唯一键只作用于 `kind='command'` 行；本节只定语义。

#### 4.6.3 确认与证据

- `decision.acknowledge` 只改 `pending → acknowledged`，不需要证据；它不解除阻塞。
- `decision.resolve` 的 `payload` 必须带服务在 `allowed_resolutions[]` 里给的值；面板不拼、不猜。
- **证据门在 §9 裁决函数内部，policy 由服务加载。** 第四段只把 `required_evidence[]` 拿来展示，**不用它决定放行**；面板更不许拿它拼请求。是否放行、要什么证据、证据够不够，全在 `evaluateEvidence` 里判。
- `confirm_applied` / `confirm_not_applied` 必须走 `evaluateEvidence` 并带 `evidence_ids[]`（至少一个有效 `evidence_id`）；缺证据或证据不合法都返回 `VERIFICATION_TOO_WEAK`，`details.reason` 区分 `missing` / `invalid`，不自造新的证据错误码。
- `confirm_started_attested` 只收 `attestation_id`，不收 `evidence_id`；服务不得把它当验证证据，也不得写 `evidence_strength`。
- payload 字段按 resolution 写死：`acknowledge` 不带 payload；`confirm_applied` / `confirm_not_applied` 必须带 `evidence_ids[]`；`confirm_started_attested` 必须带 `attestation_id` 且禁止 `evidence_ids`；其它 resolution 只收 §9 声明的字段，多余字段整笔拒绝。
- **`required_evidence[]` 为空不等于放行。** 是否调用 `evaluateEvidence`、按什么 policy 判，由 §9 的 resolution 契约决定，不由数组空不空决定。
- 命令类错误码映射（面板按表显示，不自行发挥）：

| 错误码 | HTTP | 触发 | 面板动作 |
|---|---|---|---|
| `VERIFICATION_TOO_WEAK` | 409 | `evaluateEvidence` 判证据不足；`details.reason=missing/invalid` | 显示缺什么证据，不重试 |
| `VERDICT_UNSUPPORTED` | 422 | 当前 kind 不支持该 resolution | 刷新 `allowed_resolutions[]`，不重发 |
| `VERDICT_POLICY_UNMET` | 409 | policy 明确拒绝该 verdict | 原样显示 policy 理由 |
| `RESOLUTION_NOT_AVAILABLE` | 409 | resolution 不在 `allowed_resolutions[]` | 刷新裁决卡 |
| `STALE_HANG` | 409 | 停止/恢复类命令与当前 hang 状态不符 | 刷新节点后再决定 |
| `DECISION_REVISION_CONFLICT` | 409 | `expected.revision` 不匹配 | 刷新后重选 |
| `CONFIRMATION_REQUIRED` | 409 | 高风险 resolve 第一步未带 challenge；未改状态、未落 command 行、未写回执 | 用 `details.confirm_challenge` 重发同一请求 |
| `CONFIRMATION_MISMATCH` | 409 | 预检之后、正式执行之前，challenge 与 decision_id / resolution / payload_hash / operation_id 任一不符 | 不执行，重新取 challenge |
| `CONFIRMATION_EXPIRED` | 409 | challenge 过期 | 重新取 challenge |
| `OPERATION_ID_CONFLICT` | 409 | 同一 operation_id 换了 payload，且已有终结回执 | 不重试，人工核查 |
| `OPERATION_EXPIRED` | 410 | 回执可查窗口 7 天已到期；同 operation_id 不再执行 | 先 `get_decision` 核对现状；要重做换新 operation_id，不盲重试 |
| `COMMAND_BUSY` | 503 | 同一 operation_id 已有非终结行，或写锁等待超过 5 秒 | 可重试，必须复用同一 operation_id |

- **高风险裁决的确认分两步，challenge 必须绑定具体动作。** 第一次 `decision.resolve` 不带 `confirm_challenge` 时，服务只校验请求与 policy（含 `expected.revision`），通过则返回 `CONFIRMATION_REQUIRED`，`details.confirm_challenge` 是一次性 HMAC 签名，覆盖 `decision_id`、`revision`、`resolution`、`payload_hash`、`operation_id` 与过期时间（120 秒）；**预检不是命令**：不改状态、不落 command 行、不写回执、不占 `operation_id`。第二次用同一 `operation_id`、同一组字段带 challenge 重发；服务**先查终结回执与在途行，没有才验 challenge**，任一字段不符返回 `CONFIRMATION_MISMATCH`，challenge 过期返回 `CONFIRMATION_EXPIRED`，revision 变了返回 `DECISION_REVISION_CONFLICT`。challenge 只能用一次，消费与 inbox 终态在同一事务提交；成功后的重放先命中终结回执，返回 `replayed=true`，不重复执行，也不因 challenge 已消费或过期而失败。
- 确认弹窗必须展示：目标、当前状态、将执行的 resolution、会写什么状态、不可逆副作用提示、超时后果。只显示「确定吗」不算确认。

#### 4.6.4 失败与超时

- 命令 **10 秒是客户端响应超时**；超时后面板显示「结果未知」，**不显示失败**，并用 `get_operation(operation_id)` 查回执。
- 服务端写事务是短事务，`busy_timeout = 5000ms`；锁等待超过 5 秒返回 `COMMAND_BUSY`（503，`retryable=true`），面板重试必须复用同一 `operation_id`。客户端 10 秒与服务端 5 秒不是同一个超时：前者管「等响应多久」，后者管「等锁多久」。
- 回执为 `applied` → 刷新目标实体；`rejected` → 显示错误；`in_flight` 或查不到回执 → 保持「结果未知」，允许用同一 `operation_id` 重发；重发命中在途行返回 `COMMAND_BUSY`，不会重复执行。
- `409` 类冲突不自动重试。
- 命令进行中禁用按钮；同一 decision 同时只允许一个面板命令在飞。

### 4.7 实时更新

- 首选 SSE：`GET /v1/events/stream?after_seq=N`，事件 `id` 就是 `seq`；`Last-Event-ID` 支持断线续传。命令仍走 HTTP POST，不混在流里。
- **SSE 由插件代理。** 面板连插件的本地路由，插件持 `orchestra.secret` 转发服务在 `127.0.0.1` 回环端口上的 SSE 端点；面板 JS 不持 token。服务只提供 HTTP SSE，命名管道不支持 SSE；插件代理不可用时按本节末尾降级轮询。
- 连接顺序：先 `get_run` 拿 `as_of_seq`，再订阅 `after_seq=as_of_seq`；这样快照与流之间没有空窗。
- 每个事件带 `seq`、`event_id`、`type`、`run_id`、`node_run_id`、`decision_id`。客户端只在 `seq == last_seq + 1` 时接收；断号立即停止应用、整页重取，不从事件 payload 猜中间状态。
- 重复事件按 `event_id` 去重；at-least-once 允许重复，不允许乱序。
- 事件只作失效信号：`run.*` 刷新 run 摘要，`node.*` 刷新节点，`decision.*` 刷新收件箱与目标；高频事件 100ms 合并一次刷新。
- 心跳 15 秒一次；30 秒没心跳标 `stale`，60 秒断开重连（指数退避，上限 30 秒）。重连从 `last_seq` 续；`CURSOR_EXPIRED` 则整页重取。
- 服务端缓冲有上限；慢客户端不无限堆积，直接发 `resync_required`，客户端重取快照。
- SSE 不可用时降级为 5 秒轮询 `get_run` / `list_decisions`，页面标「降级轮询」，不许标「实时」。

### 4.8 查询一致性与性能

- 单响应强一致，跨页最终一致；面板按 id 去重，后页覆盖前页。
- `as_of_seq` 只用于说明「这批数据看到哪」，不作为客户端 CAS 依据；命令的 CAS 用 `revision`。
- 所有列表必须有 `limit` 上限；没有 `offset`，只走 cursor。禁止 `SELECT *` 无 `LIMIT` 的查询进入面板路径。
- 索引至少覆盖：`tasks(status, updated_at)`、`tasks(updated_at)`、`runs(task_id, started_at)`、`node_runs(run_id, seq)`、`node_runs(run_id, status)`、`decisions(status, priority, created_at)`、`attestations(node_run_id, attempt, created_at)`、`unverified_resolutions(run_id, resolved_at)`、`events(run_id, seq)`、`events(node_run_id, seq)`、`events(decision_id, seq)`、`artifacts(run_id, created_at)`。
- `get_run` 的计数走增量计数/部分索引，不每次全量扫 `node_runs`；1000 节点 run 的 p95 目标 150ms。
- `verify_ledger` 单次最多 2000 条；面板全量校验按 1000 条一段串行，遇 `first_bad_event_seq` 立即停并高亮。
- 查询超时 5 秒；超时返回错误，不返回半页。服务端记录慢查询（去掉参数值，只留查询名、耗时、行数）。
- 以上索引与 `decisions.priority` / `priority_reason` / `expiry_effect` / `expiry_effect_reason` 四列由 §14 统一落 DDL；§14 清单必须与本节逐项对齐，第四段不再另立 schema。

### 4.9 权限与安全

- 控制面只绑本机命名管道或 `127.0.0.1`；token 文件 ACL 限当前用户；拒绝其他 SID。
- 面板不持有原始 token；插件代理查询与命令。面板 iframe 只允许 DSH 自身 origin，拒绝 `Origin: null` 与外部页面。
- 查询工具是只读能力；执行子智能体、verifier、任务会话都拿不到 `decision.resolve`。
- 命令路由只在面板上下文注册：校验 DSH webview origin + 一次性 nonce；工具层不暴露 `decision.resolve`。服务从认证主体派生 `actor`，不读客户端自报身份。
- 所有面板文本按纯文本渲染；标题、节点名、事件摘要、错误消息都不可当 HTML。链接只允许 `https:` 与 DSH 内部深链；`javascript:` / `file:` 一律拒绝。
- artifact 下载用 5 分钟签名句柄；服务端校验 artifact_id 与路径映射，不接受客户端传路径。下载内容按 `Content-Disposition: attachment`，不在页面内联执行。
- 证据与事件 payload 默认脱敏；`payload_redacted=true` 时只显示摘要，原文需显式下载 artifact。**脱敏只作用于响应与展示，不改 events 原文，也不改 node_run_events 的链。**
- 命令审计：`operation_id`、actor、decision_id、resolution、结果、时间写入事件；不记录证据原文，只记 evidence_id。
- 面板不提供「删除事件/产物/裁决」的入口；保留期由服务端 job 管。

### 4.10 空态、错误与降级

| 场景 | 面板行为 |
|---|---|
| 没有任务 | 显示引导「新建任务」；不显示 0 计数表 |
| 没有等你决定的事项 | 显示「当前没有等你决定的事项」，不报错 |
| 没有待核实的操作 | 显示「没有待核实的操作」，不显示绿色「全部安全」徽章（没验证过不等于安全） |
| `startup_unknown` | 显示「启动情况不明，不代表没开跑」，不显示等待中/已开跑 |
| `stopping` / `timing_out` | 显示「已请求停止，动作可能还在跑」，不显示已停止 |
| 服务未连接 | 保留最后一次快照，标 `stale` 与「服务未连接」；禁用命令；不把旧数据当当前 |
| 协议/版本不匹配 | 全屏「服务与面板版本不一致，请重启 DSH」；不半兼容 |
| 查询失败 | 显示错误码与重试；不显示空白页，不把失败当空列表 |
| 命令超时 | 显示「结果未知」，保留 `operation_id`，提供「查询回执」；不显示「失败」 |
| 事件断号 | 立即停止应用，整页重取；不跳着拼 |
| 未知新状态 | 显示原文 + 「面板版本过旧」；不映射成已知状态 |
| 保留期外 artifact | 显示「已过保留期」，禁用下载并说明 |

### 4.11 验收用例（Q-01…Q-34）

1. **Q-01** `list_tasks` 按 `attention` 排序，待裁决任务排在运行中任务前；同权重按 `updated_at` 降序；`orphaned` 单列在「没人接手」过滤里，不并进失败。
2. **Q-02** `list_tasks` 分页时插入新任务，面板按 task_id 去重、后页覆盖前页，不出现重复行。
3. **Q-03** `get_run` 的 run、counts、top-N 节点来自同一读事务；响应里的 `as_of_seq` 等于该事务看到的最大 events.seq。
4. **Q-04** run 已 `succeeded` 时 `display_status` 仍是 `succeeded`，不因 `settling` 旧值改回 `settling`。
5. **Q-05** `succeeded_with_unverified` 在面板显示为独立黄色状态，不被折成 `succeeded`；run 卡上带未验证数量。
6. **Q-06** `failed_with_unverified` 显示为深红并带未验证角标，不被折成 `failed`。
7. **Q-07** `blocked` 且 `settling=true` 时，面板同时显示「等你决定」和「仍有未结算不可逆动作」，不只显示 blocked。
8. **Q-08** 节点详情左栏 `declared_effect` 与右栏 `verified_effect` 不一致时高亮，并链到相关 decision。
9. **Q-09** 一个含 `indeterminate_side_effect` 子节点的 run，在任务列表显示「N 条等你决定 · 最长等待 X · 最高风险 Y · 最后心跳 Z」；X = 该 run 未决 decision 的 `max(age_seconds)`，Y = §11 三值能力等级的 `max`（按 pure < compensable < irreversible 排序），Z = 子节点 `max(heartbeat_age_ms)`。三个数都来自服务聚合，不由前端算；run 自身状态仍按 4.4 的八值表显示，不出现 `indeterminate_side_effect` 这个 run 状态。
10. **Q-10** 裁决收件箱按服务给的 `priority` 排序；`report_contradicted` 显示「不会自动收口，只能人工处理」，不显示自动收口倒计时。
11. **Q-11** `get_decision` 返回的 `allowed_resolutions[]` 与 §9 当前 kind 一致；面板不出现服务没给的 resolution。
12. **Q-12** 用过期 `revision` 调 `decision.resolve` 返回 `DECISION_REVISION_CONFLICT`，`details.current_revision` 正确，decision 与 node_run 一个字节不变。
13. **Q-13** 同一 `operation_id` + 同一 payload 重发，返回 `replayed=true` 与原结果，只产生一条 `command.applied` 事件；重算 `payload_hash` 必须走 JCS。
14. **Q-14** 已有终结回执后，同一 `operation_id` + 不同 payload 返回 `OPERATION_ID_CONFLICT`，不执行第二次；预检之后、正式执行之前的换 payload 走 Q-15 的 `CONFIRMATION_MISMATCH`。
15. **Q-15** 高风险裁决第一次 `decision.resolve` 不带 challenge 返回 `CONFIRMATION_REQUIRED` 与绑定 `decision_id` / `revision` / `resolution` / `payload_hash` / `operation_id` 的 challenge，状态不变、inbox 不落 command 行；**预检之后、正式执行之前**，用同一 challenge 换 resolution、payload_hash 或 operation_id 重发返回 `CONFIRMATION_MISMATCH`，不执行；challenge 过期返回 `CONFIRMATION_EXPIRED`；revision 变了返回 `DECISION_REVISION_CONFLICT`；**执行成功后**同一 `operation_id` + 同一 payload 重发返回 `replayed=true`，换 payload 返回 `OPERATION_ID_CONFLICT`。
16. **Q-16** 命令响应丢失后，`get_operation(operation_id)` 返回 `applied`；面板刷新后显示新状态，不重复写。
17. **Q-17** SSE 从 `as_of_seq` 续传，中间提交的事件全部补到；断号时客户端整页重取，不应用缺口后的事件；面板经插件代理连流，JS 不持 token。
18. **Q-18** 同一事件重复投递两次，面板按 event_id 去重，时间线只出现一行。
19. **Q-19** 节点处于 `started` / `dispatched` / `verifying` 且心跳超过 30 秒（心跳 15 秒一次），面板显示「心跳已停 X 秒」，状态仍是原状态，不自行改 `failed` / `orphaned`；该标记只影响显示。
20. **Q-20** 服务停止后，面板显示最后一次快照 + `stale`，命令按钮禁用；不显示「运行中」假象。
21. **Q-21** 服务 `protocolVersion` 不匹配时，面板全屏阻断，不半兼容展示。
22. **Q-22** 面板进程无 orchestra.db 写权限也能正常工作；静态检查确认面板代码没有 sqlite 直连。
23. **Q-23** 任务标题含 `<img onerror=...>` 时按纯文本显示，不执行脚本。
24. **Q-24** `get_artifact` 传伪造 id / 路径穿越返回 `NOT_FOUND`，不泄露文件系统路径。
25. **Q-25** 篡改某 run 第 100 条 `node_run_events` 的 `summary` 后，`verify_ledger` 返回 `valid=false` 且 `first_bad_event_seq=100`（`event_seq` 口径）；面板红显，不显示绿。
26. **Q-26** 1000 节点 run 的 `get_run` p95 < 150ms，`list_nodes` 单页 200 条 p95 < 80ms；数据集固定 1000 节点，SQLite 3.45+，单机 SSD，预热 3 次取第 4 次；SQL 计划不含全表扫描。
27. **Q-27** 1 万任务的 `list_tasks` 首屏 p95 < 100ms；数据集固定 1 万任务，SQLite 3.45+，单机 SSD，预热 3 次取第 4 次；过滤 + 排序走索引。
28. **Q-28** 改变过滤条件复用旧 cursor 返回 `CURSOR_FILTER_MISMATCH`；10 分钟后返回 `CURSOR_EXPIRED`；`as_of_seq` 只展示，不参与 cursor 校验。
29. **Q-29** `stopped_at` 非空但 `side_effect_verified_none` 不为 true 时，待核实页仍显示「未验证」，不显示「已确认未发生」。
30. **Q-30** 任何 `done` 节点，若策略要求证据（`evidence_state != not_required`）却没有 `verified_effect`，面板不显示绿色「已验证」，证据栏显示 `evidence_state=none` 并给出原因，不得把 `none` 当证据强度；策略不要求证据的 done 节点显示 `not_required`，不得误判成 `none`。
31. **Q-31** 4.4 节点表每一行在面板都有唯一文案：依次注入 20 种 node 状态，断言 `startup_unknown` ≠ 等待中、`stopping` ≠ 已停止、`indeterminate_side_effect` ≠ 失败，且 20 行不折叠、不合并成 run 三态。
32. **Q-32** `resolved` 只按 4.5.5 的两条判定规则，并由 §14 的 `unverified_resolutions` 表唯一落库：`side_effect_verified_none=true` 且带 `stop_evidence`，或 `resolution_basis=evidence|decision` 且带对应 id；`node_runs` 上不得另存这三项；run 进 `succeeded_with_unverified` / `failed_with_unverified` 后，未解决项仍为未解决，不被终态消项。
33. **Q-33** `human_attested` 不出现在 `evidence_strength`，也不出现在「已验证」列；`get_evidence` 不返回人证，人证只能走 `get_attestation`，且固定标「人证，不是系统证据」。
34. **Q-34** 子智能体持同一 `orchestra.secret` 调 `decision.resolve` 被拒（路由只注册在面板上下文，校验 webview origin + 一次性 nonce，工具层无此命令）；服务记录的 actor 是认证主体，不是子智能体自报的 surface。

### 4.12 与其它段的边界

- 状态、迁移、终态集合、代次、桥断时钟、证据门：第二、三段。第四段只引用，不改写；面板显示的 `status` 是服务原文，不改名。
- 裁决 kind 与 resolution 清单：§9。第四段只渲染 `allowed_resolutions[]`，不维护第二份清单；`required_evidence[]` 也只展示，证据门在 §9。
- 记忆插件对接：第五段。第五段复用本段的查询/事件接口，不直连 DB；审计服务要读 `decision` / `event`，走同一套读模型。
- 分阶段落地与验收：第六段。v2 面板做任务、run、节点、待你决定、待核实、事件、证据/产物七块；导出、告警规则、跨 run 看板留到后续。第四段 v2 只扩读模型与展示契约，状态机仍只引用第二、三段。
- spec 阶段把本段的查询/命令契约展开成接口定义、错误码表与 Q-01…Q-34 的自动化用例；本段不写实现代码。

**一句话收口：** 面板是账本的读者和人的手，不是第二个引擎；它只显示服务派生的事实，只提交带 revision 与 operation_id 的命令，任何「看起来好了」都必须有证据。
