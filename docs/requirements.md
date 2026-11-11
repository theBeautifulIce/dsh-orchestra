# dsh-orchestra 编排插件 · 原始需求说明

> 本文件是「为什么做这个插件、做成什么样、哪些是主人拍板不许动的」的唯一事实来源。
> 写法上分三层：**原始需求**（主人原话与意图）→ **口径**（已被拍板的设计约束）→ **验收标准**（怎么算做对了）。
> 决策理由不在这里，去 `design-notes.md`；规则条文不在这里，去 `orchestra-design-draft.md`。

---

## 一、原始需求

### 1.1 主人原话（按时间顺序，逐字）

| 编号 | 原话 | 落点 |
| --- | --- | --- |
| R1 | 「我在想有没有可能在插件这一层实现 workflow，然后让 agent 去实现…」 | 插件层做工作流编排 |
| R2 | 「能不能在插件层实现workflow 跨插件 跨agent 跨会话」，「但如果能在插件层实现 workflow 就能在插件层实现所有能力」 | 编排要跨插件、跨 agent、跨会话 |
| R3 | 「核心brain 只有在 dsh 插件这一层能够发挥最大的能力」 | 插件层是核心大脑的落点 |
| R4 | 「我们dsh 是插件化架构……未来的插件开发就是基于这套编排」 | 编排要成为插件生态的公共底座 |
| R5 | 「工作流总得有个东西去承载它的生命周期」 | 编排必须有承载物（账本） |
| R6 | 「如果真的要做这个那我肯定是以严格严谨的这套标准来做的」 | 严格标准，不是玩具 |
| R7 | 「模型侧是验证实际做成了什么，以客观事实为准」 | 证据来自客观事实，不来自模型自述 |
| R8 | 「最终这个编排得有一个前端，插件得有一个UI，」 | 编排要有 UI |
| R9 | 「插件得有一个交互入口，能够接入其他插件」 | 编排要有对外交互入口 |
| R10 | 「如果是事件驱动的话，那整个世界就都是事件驱动的」 | 事件驱动 |
| R11 | 「在插件层编排，本质上就是事务的状态机加上事件的驱动」 | 状态机 + 事件 |
| R12 | 「那些不是我关注的重点，我关注的是workflow 这个编排加上事务的一致性」 | 一致性优先于炫技 |
| R13 | 「而且还必须得有一个健壮的，完备的状态机」 | 状态机是核心 |
| R14 | 「保证事务一致性，事务最终一致性，和最终状态唯一」 | 三条一致性口径 |
| R15 | 「不能在单节点这一层做判断，所以必须要在编排层来做这个判断」 | 编排层做跨节点判断 |
| R16 | 「保证每个节点本身的这个健壮性，完备性，然后才能保证整个编排的健壮性和完备性」 | 节点级完备 → 整体完备 |
| R17 | 「我们dsh 里已经有一个了，workflowEngine……我看了下它是不可观测的」 | 已知 DSH 原生 workflowEngine 的局限 |
| R18 | 「把这个跑起来并且固化成插件」 | 最终要变成可发布插件 |
| R19 | 「参考 superagent-prototype 与 DS-Bot 两个项目」 | 参考项目清单 |
| R20 | 「用codebasememory做好代码图谱方便学习参考」 | 参考项目要建图谱 |
| R21 | 「写好原始需求和设计思路说明，handoff做好，方便后续继续进行设计和开发，保证开发能随时接手」 | 需求/思路/handoff 三件套 |
| R22 | 「暂停方案审计工作，将项目落到D:\aboutAI\dsh-orchestra进行」 | 项目独立目录 |
| R23 | 「https://github.com/deepseek-ai/dsh-superagent-prototype，你下错了…为什么又在下载dsh-go，没让你下这个」 | 参考项目只有三个 |

### 1.2 一句话需求

**在 DSH 插件层实现一套「可追溯、可恢复、可裁决」的长任务编排引擎**：跨插件、跨 agent、跨会话地组织九种节点的执行图，用持久账本 + 严格状态机 + 事件驱动保证事务一致性（最终一致性、最终状态唯一），并在插件层之上提供核心大脑（core brain）作为裁决与编排入口。

### 1.3 明确不做的事（负面需求）

| 不做 | 原因 |
| --- | --- |
| 不把编排脚本嵌进节点内部 | 原生 workflowEngine 的 run 是一次性活对象，嵌进去就是第二套状态机，账本会漂（第十一轮否掉的「双账本」坑） |
| 不做半兼容 | protocolVersion 不匹配就请求 graceful stop 重启，不搞「尽量能跑」的降级 |
| 不在模型侧做裁决 | 模型自述不算证据；证据只能由桥产出 |
| 不让插件作者口头声明副作用等级 | 闸门与被闸的东西都在作者手里等于没有闸门 |
| 不在节点层做跨节点判断 | 编排层的判断才有全局视野 |
| 不做全自动「兜底放行」 | 一笔没验证的副作用不许靠超时消失 |

---

## 二、需求分解

### 2.1 功能需求

| 编号 | 需求 | 验收标准 |
| --- | --- | --- |
| F1 | 插件层承载工作流生命周期 | 有独立服务进程 + 持久账本（SQLite），宿主退出后能恢复 |
| F2 | 跨插件 / 跨 agent / 跨会话编排 | 执行单元抽象成 node_run；执行侧走执行桥的 executor 会话 |
| F3 | 九种节点类型 | trigger / agent / tool / policy / branch / approval / parallel / wait / subworkflow |
| F4 | 严格状态机 | 每条迁移有「从/到/条件/触发者/CAS 字段」；CAS 带代次（Ga / Gr） |
| F5 | 事务一致性 | 回写统一走 `applyReport` 单入口，六步顺序固定；查重与应用同笔 BEGIN IMMEDIATE |
| F6 | 最终状态唯一 | node_run 终态集合全文只写一份（§8）；其它章节只引用 |
| F7 | 事件驱动 | 事务内 outbox；订阅者有 cursor + ack；at-least-once + 幂等键去重 |
| F8 | 人工裁决闭环 | decision 八种 kind、五种 resolution、出口与迁移表一一对应 |
| F9 | 证据与判定 | 证据分强/弱两级（runTool 强 / tool_result 弱）；irreversible 必须强证据 + 产物哈希 |
| F10 | 插件 UI | 面板读派生投影 `display_status` / `reasons[]`；同时显示「声明状态」与「已验证证据」 |
| F11 | 交互入口 | 编排控制面（命名管道优先）+ 对外事件订阅；供其它插件接入 |
| F12 | 参考与学习 | 三个参考项目入库 + codebase-memory 图谱 + codebasemap.md 定位表 |
| F13 | 可接手 | handoff.md + design-notes.md + requirements.md + 台账四件套齐备 |

### 2.2 非功能需求

| 编号 | 需求 | 具体口径 |
| --- | --- | --- |
| N1 | 单写者 | 一条写连接 + 若干读连接；`busy_timeout=5000`；短事务；写路径串行入队且有上限与溢出策略 |
| N2 | 性能 | `derive_run_state` 不许全表扫；维护增量计数与部分索引；N=100/1000 扇出下写入次数与耗时随 N 线性增长 |
| N3 | 上下文预算 | 任务会话只存目标/计划/产物引用；节点在 executor 子会话跑；回传有界 payload（默认 64KB）；每条 node_run 记 token 与压缩次数 |
| N4 | 安全性 | 桥用只读身份（受限令牌 + 只读挂载，Windows 用受限服务账号或 AppContainer）；命令走注册表 allowlist + argv，不过 shell；cwd 限定工作区 |
| N5 | 存储保留期 | `events` 30 天；`node_run_events` / `artifacts` / evidence = run 终态 + 180 天 |
| N6 | 可审计 | 状态迁移写进 append-only `node_run_events` 哈希链（`prev_hash` + HMAC）；定位为非对抗性校验 |
| N7 | 幂等 | 幂等键：report_id（唯一）、compensation_id（hash(node_run_id+attempt+descriptor_version)）、(node_run_id, attempt, verify_deadline_at)、(node_run_id, attempt, "no_executable_compensation") |

---

## 三、拍板口径（主人定的、不许自行推翻的）

> 这一节是本文件最重要的部分。每条都是审计中出现过分歧、最后由主人或明确逻辑拍死的口径。**改动这里等于改需求，需要主人重新拍板。**

### 3.1 事务一致性（三条）

1. **事务一致性**：单笔事务内完成「状态迁移 + 派生重算 + 事件追加」，不许拆成多笔。
2. **最终一致性**：事件走 outbox；订阅者最终能收到；重放靠 cursor + 幂等键。
3. **最终状态唯一**：同一节点在任一时刻只有一个权威状态；终态集合全文只写一份。

### 3.2 状态机口径

| 口径 | 内容 | 来源 |
| --- | --- | --- |
| SM1 | 半态必须有自己的时钟、证据门、迟到回写路径和账目位置 | 第十三轮/第十九轮 |
| SM2 | 停止不等于结算——`stopped_at` 只证明「动作停了」，不证明「副作用没发生」 | 第十四轮 |
| SM3 | 没观测到 ≠ 没发生；签了字 ≠ 副作用已结算 | 第十四轮 |
| SM4 | 终态枚举只留一处权威（node_run 终态集合在 §8；run 终态枚举在 §8 run 迁移行） | 第十九轮 |
| SM5 | 回写只走一个入口 `applyReport`，六步顺序固定，拒绝也落 registry | 第十九轮 |
| SM6 | 迟到 report 与裁决冲突要有去处：`report_contradicted` kind + 新 attempt 先暂停 | 第十九轮 |
| SM7 | 半态迁出必须清钟（离开 startup_unknown / verifying 都显式清空对应钟） | 第十九轮 |
| SM8 | 每个半态一个钟：启动层只一个 `startup_timeout`；未知态只一个 `unknown_watchdog`；verifying 自己的 `verify_timeout` | 第二十轮 |
| SM9 | 失败子节点 / 失联子节点存在时，run 不许落 succeeded（run 级结果判定三条，顺序不可调） | 第二十轮 |
| SM10 | 节点终态 ≠ run 可以成功 | 第二十轮（最易被低估的风险） |

### 3.3 代次口径（Ga / Gr 分开）

- `action_generation`（Ga）跟动作走：**自增点唯一**（`leased → dispatched` 派发那笔 CAS）；首次写 1，此后每个新 attempt / 重开动作一律 Ga+1，**不许重置回 1**。回写用它。
- `rearm_generation`（Gr）跟续期走：每次「继续等」重新武装 +1。定时器到点、decision 收口、sweep 恢复用它。
- 一句话判据：**人裁决或引擎判定驱动的迁移用 Gr，执行器回写驱动的迁移用 Ga**（verifier 的 verdict 由 verifier 执行器回写，算 Ga）。
- 回写类 CAS 必须带齐 **attempt + Ga + report_id 三元组**，一条不许少。
- 凡重新武装 `action_deadline_at` 的路径，在**同一笔 CAS** 里 Gr+1 写回。

### 3.4 证据与副作用口径

| 口径 | 内容 |
| --- | --- |
| EV1 | 证据强弱由**来源**定，不由作者自称：`runTool`（宿主只读身份跑命令）= 强；`tool_result`（模型侧工具事件）= 弱 |
| EV2 | irreversible 节点必须有强证据；宿主无只读挂载 → 加载期 `EVIDENCE_SOURCE_UNAVAILABLE`，不降级 |
| EV3 | irreversible 的通过凭据必须是**产物哈希**，只回 exitCode（哪怕 0）→ `VERIFICATION_TOO_WEAK` |
| EV4 | `passCondition` 必须引用**证据族字段**（evidence.exitCode / stdoutHash / stderrHash / hashes / producedAt）；引用 `policy.requiredHashes` 属非法字段（那是要求不是事实） |
| EV5 | 模板给 mandatory baseline，节点只能往上加，删减在加载期报错 |
| EV6 | 副作用等级由工具注册表 capability **前向推导**（pure / compensable / irreversible 三值）；作者声明只许往更严一侧写 |
| EV7 | `compensating` 只许出现在补偿描述符里；补偿工具出现在前向路径 → 加载期拒 |
| EV8 | 补偿执行失败 → 节点落 `failed_with_unverified`（**不是 failed**），未验证副作用必须留在账上 |
| EV9 | 补偿事件名固定三个：`compensation.started` / `compensation.applied` / `compensation.failed`，事件行必须带 `verify` 字段 |
| EV10 | 补偿幂等键 `compensation_id = hash(node_run_id + attempt + descriptor_version)`；同键不许重复执行补偿 |
| EV11 | verifier 不能自报：verdict 必须引用满足 policy 的 evidence_id，否则 `VERDICT_UNSUPPORTED` / `VERDICT_POLICY_UNMET` |

### 3.5 生命周期与桥口径

| 口径 | 内容 |
| --- | --- |
| LC1 | 桥是**业务通道**，不是保活通道：业务通道断 = 客户端走了；保活通道断 = 宿主没了 |
| LC2 | 桥缓冲是传输层，不是账本：dispose 前置 `service_ack_seq >= bridge_last_seq`；高水位 spill 先落库再丢 |
| LC3 | 三种退出要分清：插件重载（服务留着）/ 宿主退出（drain 或 host_gone）/ 服务崩溃（supervisor 拉起后立刻 sweep） |
| LC4 | 插件卸载只断连不 drain |
| LC5 | 交接顺序固定；新服务先拿 DB 锁再写文件，拿不到就退避重试 |
| LC6 | 只接受当前用户 SID 的连接；control 通道用随机 token + ACL |
| LC7 | `protocolVersion` 不匹配 → 请求 graceful stop 重启，不做半兼容 |

### 3.6 决策与裁决口径

| 口径 | 内容 |
| --- | --- |
| DC1 | decision 八种 kind：pre_execution / action_overrun / abandon_ack / verify_human / audit_result / rule_ambiguous / startup_unknown / report_contradicted |
| DC2 | resolution 五类：continue_wait / confirm_applied / confirm_not_applied / abandon / confirm_not_started·confirm_started·confirm_started_attested·continue_tracking（startup_unknown 专用） |
| DC3 | `continue_wait` **不是结论**：在同一行追加 revision、行状态保持 pending/acknowledged、不经过 approved、不触发「结论落地即 closed」 |
| DC4 | decision 终态 = {approved, rejected, expired, closed}；approved/rejected/expired 是结论，closed 是收口 |
| DC5 | 同一 (node_run, kind) 只保留一行；run 级用 (run_id, kind) + affected[]；唯一键用 partial unique index（普通 UNIQUE 允许多个 NULL 并存撑不住） |
| DC6 | 同一 run 活跃 decision 超阈值（默认 20）→ 同 kind 合并成 bulk decision |
| DC7 | 升级链路：满 2 小时 → blocked_for_human；再满 24 小时 → expired |
| DC8 | `abandon_ack` 过期时**留在 paused 不迁 failed**（过期不是默认放行）；其余 kind 过期按定义默认动作收口 |
| DC9 | 签字只解裁决门，不解「动作仍在跑」；`unverified_side_effect` 不因签字消失 |

### 3.7 与原生 workflowEngine 的边界（口径）

- DSH 自带 `ctx.workflowEngine` 执行的是**编排脚本**（plain-JS + meta 块，`agent()` / `phase()` / `log()` / `parallel()` / `pipeline()`），其 run 是宿主持有的一次性活对象，`workflow/*` 事件**只观察、不给运行控制**，没有持久账本 / 断点续跑 / 人工审批节点 / 等外部事件节点。
- 结论：**编排脚本 = 一次性多智能体编排；编排插件 = 可追溯、可恢复、可裁决的长任务**。两者不是同一种东西。
- v1 边界：① 面板可订阅 `workflow/*` 事件作为旁路视图；② 未来若复用，只复用 `agent()` 派生子智能体路径（即本插件的 executor 子会话），不复用它的 run 控制。
- **不把编排脚本嵌进节点内部**——那是第二套状态机，账本会漂。

---

## 四、范围与节奏

### 4.1 六段设计法（当前进度）

| 段 | 内容 | 状态 |
| --- | --- | --- |
| 第一段 | 骨架与落点（桥 / 生命周期 / 控制面） | ✅ 已完成 |
| 第二段 | 把「硬」落成规则（17 条：执行单元 / 所有权 / 回写与超时线性化 / 终态与半态 / 超时 / 重试与副作用 / sweep 恢复 / 状态机与迁移表 / 声明式判定 / 版本不漂移 / 身份与账本 / payload 契约 / 上下文预算 / 存储实况 / 与原生对账 / 事件与回执 / 事件来源分离） | ✅ 已完成 |
| 第三段 | 九节点图的推进方式 + 契约 + 能力矩阵 + 升级链路（§3.0–§3.5） | ✅ 完成（v23，第二十五轮 pass） |
| 第四段 | 面板与查询 | 🔄 下一段 |
| 第五段 | 记忆插件对接（memory-audit-v1） | ⛔ 未开始 |
| 第六段 | 分阶段落地与验收 | ⛔ 未开始 |

### 4.2 节奏口径（主人）

- 「审计没通过就不能往后走」——第三段已于 2026-11-11 20:04 拿到 pass，第四段现在开始。
- 「状态机啃得更死一点」——审计允许逐轮加压，不接受「差不多就行」。
- 「严格严谨的这套标准」——不接受玩具级实现。
- 第三段可多磨几轮；收敛判据见台账 §三。

---

## 五、验收标准

### 5.1 状态机验收（第三段的硬门槛）

1. **迁移表逐行闭合**：每条迁移行的入边存在、出边可达；终态集合只有一份（全文搜索只命中 §8 一处）。
2. **每条迁移行能生成一个用例**：`case = (from, to, condition, CAS fields, expected side effects)`。
3. **代次矩阵闭合**：每条迁移行能查到归族（Ga / Gr）；回写边不带 Gr，计时边不带 Ga。
4. **时钟矩阵闭合**：每个钟有「起钟 / 到点 / 离开清钟 / 桥断行为」四要素。
5. **证据门闭合**：所有人工裁决与自动回写走同一个 `evaluateEvidence(policy, evidence)`，policy 由服务端按 `node_run_id + workflow_version` 从不可变模板加载，**不由调用方传入**。
6. **run 级判定闭合**：失败类子节点 / 未被替换的 orphaned / 全 done 三条判定按序取第一条命中。
7. **幂等键闭合**：每条迁移行能查到幂等键；`report_id` 有 UNIQUE 约束（DDL 级）。
8. **账本能自证**：任意一次迁移后，投影字段必须等于重新 derive 的结果（不变量测试，逐条迁移跑一遍）。

### 5.2 交付物验收

| 交付物 | 路径 | 完成标志 |
| --- | --- | --- |
| 原始需求 | `docs/requirements.md` | 本文件 |
| 设计思路 | `docs/design-notes.md` | 每条决策写清「为什么」与被否方案 |
| 设计稿 | `docs/orchestra-design-draft.md` | 规则条文唯一权威；版本号与 `[CURRENT]` 清单同步 |
| 审计台账 | `docs/orchestra-audit-ledger.md` | 逐轮记录 + 收敛判据 + 续跑指引 |
| 代码图谱索引 | `codebasemap.md` | 三份参考图谱 + 本项目图谱，含定位表与更新命令 |
| 接手指引 | `handoff.md` | 新人看完能接着做，能跑起图谱、能定位下一处要改的文件 |

---

## 六、参考项目（主人最终清单）

| 项目 | 仓库 | 角色 |
| --- | --- | --- |
| DS-Bot | https://github.com/Fei2411/DS-Bot.git | 多端 IM bot + 插件化工具集 + 记忆层 + 组队协作的成品实现 |
| dsh-superagent-prototype | https://github.com/deepseek-ai/dsh-superagent-prototype.git | DeepSeek 官方研究原型：ticket / decision / handoff / 通知队列的可运行骨架 |
| pi-harnessmm | https://github.com/jlon/pi-harnessmm.git | 最小可用的「harness + 消息投影 + 准入 + 收据」四件套范式 |

> 注：`dsh-go` **不是**参考项目（曾误克隆，已删除）。主人 2026-11-11 明确更正。

---

## 七、术语

| 词 | 含义 |
| --- | --- |
| 桥 / 执行桥 | 插件与 executor 之间的业务通道；传输层，不是账本 |
| node_run | 一个节点的**一次尝试**的执行单元（事实行，不存派生结论） |
| attempt | node_run 的尝试序号；重试即新 attempt |
| 半态 | 有独立时钟与证据门的中间格：blocked_pre / blocked_post / stopping / indeterminate_side_effect / startup_unknown |
| Ga / Gr | action_generation（跟动作走）/ rearm_generation（跟续期走） |
| 围栏 | 声明「这个动作已判超时」的格子（timing_out），只在确认停得下来时立 |
| 证据强弱 | 强 = runTool 宿主只读身份；弱 = tool_result 模型侧事件 |
| 裁决出口 | decision 落地后的目标状态 + slot/lease/executor/attempt/report_registry 五项副作用 |
| 账本 | 节点状态 / 决策 / 事件的持久存储（SQLite，单写者） |
| 哈希链 | node_run_events 的 append-only prev_hash 链，HMAC 签名（非对抗性校验） |
