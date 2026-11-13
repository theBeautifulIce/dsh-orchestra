# dsh-orchestra 工作流编排插件设计规格

- 规格版本：1.4
- 状态：自审通过，第一章至第十八章已定稿；v1.4 把 §16.3 六项开放参数按主人 2026-11-13 口径定值；v1.3 补第十八章（任意会话都是主脑、对话不被任务占用、自治档位与执行纪律）；v1.2 已裁定九处规格／总纲／设计稿不一致，结论一律回到设计稿 v44
- 日期：2026-11-12
- 修订：v1.2（2026-11-12）按九处不一致裁定补齐：§9.10 批次与条目状态枚举、§9.11 三端口字段契约、§11.3 门 artifact 的三类 producer 绑定、§17.2 写队列上限与保留期定值口径。来源是设计稿 v44 §5.4（行 1618-1727）、§5.6（行 1807-1865）、§5.8（行 1922-1963）、§6.8（行 2296 与 2404）；结论一律回到设计稿 v44，冻结稿未改。v1.3（2026-11-13）不改前文任何一行，只在文末追加第 18 章；来源是主人 2026-11-13 的对话口径与 superagent 面板七原则、执行纪律。v1.4（2026-11-13）只改 §16.3 与 §17.2 两处定值说明：六项开放参数按主人「就按你说的那样」拍定，正文其余行不动。
- 设计来源：docs/orchestra-design-draft.md v44，2439 行 / 505410 bytes / SHA256 D534FA8317A74C48286C83A65C994FC80D812B6B26110BCC533A7BA82699B793
- 实施目录：D:/aboutAI/dsh-orchestra
- 目标插件名：dsh-orchestra

本规格把六段设计收成一份可直接排期的实施契约。设计稿保留全部论证、逐行迁移表与验收用例；本规格保留不可变的行为契约、字段、错误码、门禁与顺序。两者冲突时以本规格为准，并回写设计稿修订说明。规格不替代实现，也不把未验证的假设写成既成事实。

## 0. 阅读方式与术语

### 0.1 三层读者

- 排期与验收的人：读第 1、10、11、12、14 章，确认范围、阶段、门与验收口径。
- 实现者：读第 2 至 9 章，按接口、状态机、事务顺序与错误码实现。
- 审阅者：读第 13 至 16 章，按用例矩阵与追溯表核对每条需求是否落到实现与测试。

### 0.2 工程术语与人话对照

| 工程术语 | 界面上怎么说 | 含义 |
| --- | --- | --- |
| task / 任务 | 任务 | 人提出的一件要办的事，跨多次运行存在 |
| workflow / 流程 | 流程 | 可复用的步骤定义，有版本 |
| run / 运行 | 这次运行 | 某任务按某个流程版本跑的一遍 |
| node_run / 节点运行 | 这一步 | 一次运行里的一个步骤，有尝试次数 |
| decision / 裁决 | 等你决定 | 系统停下来等人给结论的事项 |
| side effect / 副作用 | 对外改动 | 写文件、发消息、调外部接口这类会改变世界的事 |
| unverified side effect / 未验证副作用 | 有一笔改动没核实 | 动作可能发生了，但账上没有证据证明它发生或没发生 |
| gate / 门 | 验收门 | 一个阶段结束前必须通过的检查集合 |
| phase / 阶段 | 阶段 | S1 到 S6 的落地阶段，只能逐级抬 |
| lease / 租约 | 接手凭据 | 某个执行者当前有权推进这一步的凭据，会过期 |
| attempt / 尝试 | 第几次尝试 | 同一步因为失败或重启重新跑的次数 |

界面上不出现 session_id、agent_id、node_run_id、batch_id、evaluation_id、proposal_hash、token、SQL、插件路径。这些只在开发者视图与日志里出现。

### 0.3 口径优先级

1. 安全与不变量优先于便利：任何会破坏账本一致性、证据完整性、阶段边界的便利路径都不做。
2. 账本优先于模型叙述：模型说做完了不算，账本与证据说做完才算。
3. 服务优先于面板：面板不写库，所有写操作经服务。
4. 人工优先于自动放行：需要人批的事不自动批，过期不等于同意。
5. 失败要留痕：失败、超时、放弃、未验证都要有终态与证据，不许静默重试把痕迹抹掉。

## 1. 目标、范围与非目标

### 1.1 目标

R1 在 DSH 插件层提供工作流编排，不依赖某个具体模型或某个业务插件。

R2 一个流程可以跨插件、跨智能体、跨会话执行；任务与运行持久化，DSH 重启后可恢复。

R3 提供插件层的「核心大脑」角色：它负责选流程、建流程、起运行、读摘要、在卡点处做决定，但不直接改账本、不直接执行写操作。

R4 用严格状态机与事件账本保证：一个节点运行最多一个终态；一个运行最多一个终态；最终状态唯一且可解释。

R5 支持九种节点：trigger、agent、tool、policy、branch、approval、parallel、wait、subworkflow。

R6 证据必须客观：副作用等级由工具注册表能力推导；不可逆动作要有强证据与产物哈希；模型自报不算通过。

R7 面板只读，展示「做到哪一步、发生了什么、结果是什么、现在要你做什么」，默认信息密度低，浅色主题。

R8 所有外部入口统一：面板、核心大脑、主聊天、子智能体、外部订阅者都读同一套查询模型；写操作走命令信封与回执。

R9 最终固化成可发布插件：有安装、升级、回滚、值班手册与三圈试用。

### 1.2 明确不做

- 不在节点里内嵌任意编排脚本，不执行用户提供的 JS / Python 编排代码。
- 不做与 DSH 原生 workflowEngine 的半兼容层；边界见 1.4。
- 不让模型侧做最终裁决；模型可以建议，结论由状态机与证据门给出。
- 不接受节点作者口头声明副作用等级；等级由工具注册表与前向工具集推导。
- 不做节点层的跨节点业务判断；节点只按自己的输入、输出与判定规则工作。
- 不做全自动兜底放行；没有证据就转人工或停在半态。
- 不在 v1 做记忆删除、跨运行补偿、跨工作区共享账本。
- 不把执行器全量 transcript 交给核心大脑；大脑只读有界摘要与索引。

### 1.3 参考项目

- DS-Bot：队列、侧边对话、并行派活、上下文管家，用作交互与调度参考。
- deepseek-ai/dsh-superagent-prototype：超级智能体与子节点的职责分工、任务板参考。
- jlon/pi-harnessmm：harness 层的执行与事件参考。
- 不参考 dsh-go；它不是本项目点名的参考对象。

### 1.4 与 DSH 原生 workflowEngine 的边界

原生 workflowEngine 负责单会话内的轻量步骤；dsh-orchestra 负责跨会话、跨插件、持久账本、可恢复的长流程。两者不互相嵌套，不共享状态机。dsh-orchestra 不接管原生 workflow 的调度；原生 workflow 也不写 orchestra 的账本。需要串联时，通过一个显式的 trigger 适配器进入 orchestra，适配器必须命中注册过的 effect 原语。

## 2. 总体架构

### 2.1 四层

| 层 | 组件 | 职责 | 不做什么 |
| --- | --- | --- | --- |
| 引擎层 | orchestra-service 独立进程 | 确定性状态机、记账、事务、租约、扫描、事件、查询 | 不碰节点正文，不调模型，不调工具，不做业务判断 |
| 存储层 | SQLite 单库 | workflows / tasks / runs / node_runs / decisions / events / artifacts / inbox / leases / report_registry 等 | 不被面板直接写，不被执行器直接读写 |
| 执行层 | DSH 宿主内的 executor | 一任务一具名会话，1:1 绑定 sessionId；节点作业由 executor 子智能体执行 | 不直接改账本，不绕过桥，不自报完成 |
| 接入层 | 工具面、面板、记忆审计、外部订阅 | 只跟服务说话；读查询模型，写命令信封 | 不写库，不做乐观更新，不直接调记忆插件写接口 |

### 2.2 进程与所有权

- 账本只有一个写者：orchestra-service。任何其他进程只能通过服务 API 写。
- 服务用操作系统文件锁声明进程所有权；数据库内 service_meta.instance_epoch 作为进程内栅栏。每次启动把 epoch 旧值加一；所有写事务 BEGIN IMMEDIATE 且带当前 epoch，连 INSERT 也校验 epoch，防止旧进程复活后继续写。
- 行级 CAS 加运行 / 裁决 revision 是线性化点。裁决收口与运行终态在同一事务里完成。
- 任务与执行器是 1:1：一个任务一个具名会话，sessionId 落在 tasks 行。一个任务可以有多条 run；同一时刻默认只允许一条活跃 run，除非流程显式允许并行 run（v1 不允许）。
- 执行器子智能体按 node_run 创建，不继承主会话历史，只拿节点输入、工具策略与输出 schema。任务会话默认不给工具；storages 目录读写 deny。任何 allow 里出现 mutating 工具的模板，加载期报 SIDE_EFFECT_UNDECLARED。

### 2.3 生命周期

- 插件重载：服务与执行器都保留；接入层按 fromSeq 重放事件，不重建运行。
- 宿主正常退出：先拒新请求，等在途节点到安全点，撤 cron，删 endpoint / secret / service.state，关数据库解锁，再退出。
- 宿主强杀：走 host_gone 恢复。未收口的不可逆动作标 indeterminate_side_effect，运行 paused，生成 decision；服务由 supervisor 拉起后 sweep。
- 插件卸载：只断业务桥，不 drain 账本，不删数据。
- 服务启动：先读 service.state 的 pid；活着就连接，死了才接管。先拿数据库锁，再写 endpoint / secret / state。

### 2.4 阶段开关

- 唯一开关是 orchestra.config.json 的 phase，取值只许 S1 到 S6。
- 未知值拒绝启动；只能逐级抬；降级只允许回到上一过门阶段。
- 加载期与启动期都按 min_phase 拒越阶段能力。例如 S2 加载 parallel 节点必须被拒；S5 启动 wf_release_v1 必须被拒。
- 阶段不是功能开关的堆叠，而是验收顺序：前一阶段没过门，后一阶段的能力不许上线。

## 3. 领域模型与账本

### 3.1 实体关系

| 实体 | 关键关系 | 说明 |
| --- | --- | --- |
| workflows | 1:N workflow_versions；1:0..1 workflow_drafts | 流程身份；已发布版本不可变；草稿只有一行 |
| tasks | N:1 workflow；1:N runs | 人提出的一件事；绑定一个任务会话 |
| runs | N:1 task；N:1 workflow_version；1:N node_runs | 一次运行，固定在某个流程版本上 |
| node_runs | N:1 run；可自引用 parent / origin / replacement | 一步的一次尝试；同一步多 attempt 共用 seq |
| decisions | N:1 run；可挂 node_run | 八种需要人或核心大脑给结论的事项 |
| events | 全局单调 seq；可挂 run / node_run / decision | 对外事件流，只追加 |
| node_run_events | 每个 node_run 一条哈希链 | 状态迁移与报告事实，append-only |
| artifacts | 挂 run，节点产出引用 | 产物哈希、保留期、证据索引 |
| inbox | 命令回执与事件去重 | command 行以 operation_id 幂等；event 行以 idempotency_key 去重 |
| leases | node_run 的租约 | 带 owner_epoch、过期时间、CAS 依据 |
| report_registry | report 的当前状态投影 | rejected / replayed / applied / stale；状态迁移进哈希链 |
| memory_batches / memory_items / memory_evaluations / memory_run_requests | 记忆受控写入 | 批次、条目、评估、源运行到记忆运行的幂等映射 |

### 3.2 任务

- 字段至少：task_id、title、workflow_id、workflow_version、status、session_id、created_at、updated_at、created_by。
- 任务状态只表达任务本身的活着 / 归档，不表达运行进度；进度读 run。
- 任务不直接持有节点；节点属于 run。
- 同一任务的多条 run 按 started_at 降序；默认只显示最近一条，历史可展开。

### 3.3 运行

- 字段至少：run_id、task_id、workflow_id、workflow_version、status、started_at、ended_at、revision、last_event_seq、paused_reasons_json、settling、pending_irreversible_children_json、boot_id。
- 运行不存一个手工维护的 running 标志；running / blocked / settling 由派生规则算。
- 运行的状态集合与展示状态分开：内部用事实字段，展示用 display_status。
- 运行终态唯一：succeeded、failed、succeeded_with_unverified、failed_with_unverified、orphaned。paused 与 settling 不是终态。

### 3.4 节点运行

node_run schema_version = 2。相对 v1 只新增两个可空列：startup_unknown_remaining_ns、verify_remaining_ns；默认 null，不回填旧行。

核心字段分六组：

- 身份与位置：node_run_id、run_id、node_id、seq、attempt、parent_node_run_id、origin_node_run_id、replacement_node_run_id。
- 执行者：executor_session_id、executor_agent_id、verifier_agent_id、verifier_session_id、owner_epoch、lease_id。
- 时间：queued_at、dispatched_at、claimed_started_at、started_at、tool_start_at、deadline_at、action_deadline_at、cancel_requested_at、cancel_result、stopped_at、last_heartbeat_at、resume_state、resume_at。
- 启动层：startup_state、startup_unknown_deadline_at、unknown_reason、startup_unknown_paused_at、startup_unknown_remaining_ns、bridge_absence_accumulated、bridge_down_since。
- 验证层：verify_timeout、verify_started_at、verify_deadline_at、verify_remaining_ns、indeterminate_side_effect、side_effect_verified_none、stop_evidence、action_start_source、attestation_id。
- 冲突与挂起：hang_reason、contradiction_decision_id。

所有截止时间成对存：展示用的墙钟字段加 boot_id 与 monotonic_ns。截止判定只读 boot_id + monotonic_ns；墙钟只用于展示。跨 boot 时按 boots 投影换算；停机时间不计入预算；时钟不确定或漂移超过 2 秒，置 timer_uncertain 转 blocked，不自动判超时。

seq 是拓扑序号，来自流程版本；同一 node_id 的多个 attempt 共用同一个 seq，只用于排序，不参与 CAS。

### 3.5 节点运行状态

非终态十三种：queued、leased、dispatched、started、waiting、verifying、timing_out、stopping、startup_unknown、paused_bridge_missing、blocked_pre、blocked_post、indeterminate_side_effect。

终态七种（唯一权威）：done、failed、timeout、abandoned_unverified、failed_with_unverified、orphaned、superseded。

- superseded 是中性终态：旧行被新 attempt 取代，只带 replacement_node_run_id；它不表示成功也不表示失败。
- abandoned_unverified 是人主动放弃跟踪，动作可能仍在跑；它不是「没发生」。
- failed_with_unverified 是失败且带未验证副作用；它比 failed 更严重，面板必须同时显示未验证提示。
- timeout 是宣告超时后的终态；已经停下但状态不明走 indeterminate_side_effect，不直接 timeout。
- orphaned 是执行者失联且无法确认；只有被替换后才不影响运行终态。

### 3.6 决策

kind 固定八种：pre_execution、action_overrun、abandon_ack、verify_human、audit_result、rule_ambiguous、startup_unknown、report_contradicted。

状态：pending、acknowledged、blocked_for_human、approved、rejected、expired、closed。

- 结论只指 approved、rejected、expired 三者；结论落地同事务 closed，closed_reason=resolved 或 expired_final。
- continue_wait 不是结论：只在同一行追加一条 revision，状态保持 pending / acknowledged，不经过 approved，不触发结论收口。
- 满 2 小时未决升级 blocked_for_human；再满 24 小时 expired。report_contradicted 例外：永不 expired，只能由 uphold_report / uphold_decision 收口。
- 同一 (node_run, kind) 只保留一行；同一 run 级 kind 只保留一行，用 partial unique index 实现，不能靠普通 UNIQUE（NULL 不冲突）。
- 同一 run 活跃 decision 超过 20 条时，同 kind 合并为 bulk decision，带 affected[]；一次裁决可覆盖多条。
- 所有 decision 都必须能回答：为什么卡、谁能解、可选结论、需要什么证据、过期会怎样、当前 revision。

### 3.7 命令与回执

命令信封固定：

    {
      "operation_id": "UUIDv7",
      "command": "decision.resolve",
      "target": {"decision_id": "dec_01J9Z6K4T3R8M2Q7"},
      "expected": {"revision": 7},
      "payload": {},
      "client": {"kind": "panel", "version": "1"}
    }

- actor 由认证主体派生，不由 payload 自报。
- operation_id 全局唯一，重试复用同一个；一个 operation_id 最多一条 kind=command 的 inbox 行。
- expected 至少一个 CAS 字段：裁决用 revision；workflow.create 用 0；workflow.update / publish 用草稿 revision；open_draft 用 base_version。
- request_hash = SHA256(JCS({command,target,expected,payload}))，不含 operation_id、confirm_challenge、client。
- 幂等判定顺序：先看 receipt_expired_at；未过期且已终结 → 重放回执（replayed=true）；同 id 不同 hash → OPERATION_ID_CONFLICT；非终结同 hash → COMMAND_BUSY；高风险 resolve 第一次预检不落 command 行、不占 operation_id，确认后才落。
- 回执窗口 7 天，从 completed_at 起算；in_flight 行没有 completed_at，在途超时 10 分钟，从 created_at 起算。
- 在途超时由维护扫描每分钟 CAS 置 rejected，写 completed_at 与 receipt_json=OPERATION_TIMEOUT，追加 command.rejected，不改业务状态。
- 回执过期后 get_operation 与同 operation_id 复放都返回 OPERATION_EXPIRED；要重做必须换新 operation_id。

### 3.8 工作流定义与版本

WorkflowDefinition 结构：

    {
      "schema_version": 1,
      "name": "发布验收",
      "nodes": [
        {"node_id": "start", "type": "trigger", "title": "开始", "position": {"x": 0, "y": 0}, "config": {}, "contract": {}}
      ],
      "edges": [
        {"from": "start", "to": "check", "route": {"priority": 0}}
      ]
    }

约束：

- node_id 匹配 ^[a-z][a-z0-9_]{0,63}$，全图唯一。
- title 1 到 80 字；流程 name 1 到 80 字。
- position 的 x / y 是 0 到 20000 的整数，只作布局，不参与语义。
- 单 trigger 入口；入口没有入边；全图可达；无环。
- trigger 出度恰为 1；parallel / branch 出度至少 1；其他节点出度至多 1。
- branch 出边必须带 route：priority 0 到 999，或 default=true；同层 route 不许重复。
- 边不许自环与重复；同一 from/to 只许一条。
- seq 由 Kahn 拓扑序生成，同层按 node_id 升序。
- 定义 JSON 不超过 1 MiB；超过报 WORKFLOW_DEFINITION_TOO_LARGE。

三张表：

- workflows：流程身份、名称、状态、当前版本、创建与更新人。
- workflow_versions：已发布版本，只插不改；BEFORE UPDATE / DELETE 触发器直接 RAISE(ABORT, 'WORKFLOW_VERSION_IMMUTABLE')。字段含 based_on_version、definition_json、definition_hash、publish_note（1 到 500 字）、published_at、published_by。
- workflow_drafts：一行草稿，带 revision、based_on_version、definition_json、definition_hash、published_version。发布后标记 published_version，不物理删除。

### 3.9 记忆表

- memory_batches：batch_id 主键；source_run_id、memory_run_id、prepare / confirm / apply 的 node_run_id、attempt、status、outcome、proposal_hash、approved_proposal_hash、approved_item_hashes_json、policy_json、evaluation_id、decision_id、applied_count、skipped_count、error_code、error_message、时间字段。唯一键 (source_run_id, attempt)。
- memory_items：item_id 主键；batch_id、client_key、action、target_id、layer、title、content、tags_json、questions_json、key、importance、ttl_days、quote、reason、content_hash、approved_content_hash、status、verdict、confidence、judge_reason、applied_item_id。唯一键 (batch_id, client_key)。
- memory_evaluations：evaluation_id 主键；batch_id、eval_attempt、request_hash、模型信息、response_json（不超过 64 KiB）、recommendation、duration_ms、error_code。唯一键 (batch_id, eval_attempt)。
- memory_run_requests：(source_run_id, request_key) 联合主键；memory_run_id 唯一；created_at。用于源运行到记忆运行的原子幂等映射。


## 4. 执行契约与状态机

### 4.1 执行入口与执行契约分开

每个节点都有两份契约，不许混成一份：

- 入口契约：来源类型、过滤条件、幂等键算法、失败策略、是否允许重复触发。
- 执行契约：输入 schema、产出 schema、判定规则、side_effect_policy、超时、重试、审批要求。

产出固定三件套：payload（默认不超过 64 KiB）、artifact 引用、有界摘要（不超过 800 字）。artifact 是联合类型：artifact_ref{uri,sha256}、decision_ref{decisionId}、none。payload 超过上限时截断并记录，不许静默丢字段。

消费者矩阵：

| 产出方 | 可消费 artifact_ref | 可消费 decision_ref | 可消费 none |
| --- | --- | --- | --- |
| agent | 是 | 是 | 是 |
| tool | 是 | 是 | 是 |
| subworkflow | 是 | 是 | 是 |
| approval | 是 | 是 | 否（必须产 decision_ref） |
| parallel | 是 | 否 | 是 |
| policy | 否（artifact 固定 none） | 否 | 是 |
| branch | 否 | 否 | 是 |

### 4.2 applyReport：唯一回写入口

签名：

    applyReport(node_run_id, attempt, report, expected_status, generation, decision?)

- 第六参只在 confirm_applied、confirm_not_applied、uphold_report 三个出口上传，形如 {decision_id, revision, resolution}；同一事务 CAS decisions。
- policy 不在参数里。服务按 node_run_id 找到 run 的 workflow_version，再载入不可变模板的 verification_policy 与 evidence_source，调用方不能自带策略。
- 内部固定顺序：
  1. report_id 幂等查重。
  2. schema 校验。
  3. status + attempt + generation 三样 CAS。
  4. evaluateEvidence。
  5. 按模板判定规则求值。
  6. 节点 CAS + registry 标 applied + 追加 node_run_events 的 report_applied，六步在同一笔 BEGIN IMMEDIATE 里。
- 返回 ApplyResult{accepted, reason?, next_status?, registry_state}。
- 拒绝也要落 report_registry(state=rejected)，并把拒绝事实追加进哈希链；不许因为拒绝就不留痕。
- report_registry 主键 report_id；字段 node_run_id、attempt、report_seq、state。state 只许 rejected、replayed、applied、stale。
- 只有当前 attempt 的队头报告可以重放；重放前先验哈希链，链断或上一状态对不上就不许重放。
- registry 只是投影：三次状态迁移 rejected → replayed → applied 各自追加一条 node_run_events，事件类型 report_rejected / report_replayed / report_applied，带 report_id 与 report_seq（即 registry 的 seq）。

### 4.3 Ga 与 Gr

- action_generation（Ga）跟动作走。动作启动时把当时的 Ga 写进 node_run；回写工具每次回写都带自己看到的 Ga；服务比对当前 Ga，不一致返回 STALE_GENERATION。只靠服务读当前 Ga 会把旧报告当成新动作接受，栅栏必须挡在回写入口。
- rearm_generation（Gr）跟续期走。重新武装截止时间、裁决续期、桥恢复补满预算时 Gr 加一；定时器与 decision 收口用 Gr。Ga 与 Gr 不许合并成一个数。
- 每次重新派发或新 attempt，在 queued → leased → dispatched 那笔事务里 Ga 加一；首次为 1，不重置。

### 4.4 半态与时钟

半态五格：blocked_pre、blocked_post、stopping、indeterminate_side_effect、startup_unknown。另有一个特殊终态 abandoned_unverified。

| 半态 | 什么时候进 | 谁在等 | 离开条件 | 钟 |
| --- | --- | --- | --- | --- |
| blocked_pre | 不可逆动作执行前等审批 | 人 | 批准后回 queued，attempt 不变；驳回走 failed 或 superseded | 无动作钟 |
| blocked_post | 执行后判定不足或规则收不住 | 人或验证者 | 补证据、转人工、或按裁决收口 | 无动作钟 |
| stopping | 已请求取消，但动作还没确认停下 | 执行器 | interrupted 才进 timing_out；已停按事实判定 | 动作时限继续走，到点按未确认停止生成 decision，续期受 wait_extensions 上限 |
| indeterminate_side_effect | 执行器已确认停止，但动作状态未知 | 人 | confirm_applied / confirm_not_applied / abandon | 无新动作钟 |
| startup_unknown | 已派发，但不知道动作开没开跑 | 人 | confirm_started / confirm_not_started / continue_tracking / abandon | unknown_watchdog 120 秒 |
| abandoned_unverified | 人主动放弃跟踪，动作可能还在跑 | 人签字 | 签字只解裁决门；核实未发生才清未验证标记 | 无动作钟；保留现场 |

规则：

- 进入半态必须挂钟或明确「本格不挂钟」；离开半态必须清钟。半态不许留着一个不再有人看的定时器。
- timing_out 不是半态，也不独立收口：只有 cancel_result=interrupted 才立围栏，表示动作已接受中断、执行器尚未确认停下。围栏内 30 秒宽限等 whenIdle，桥断暂停不累计；宽限到点仍未见停止，撤销围栏回 stopping，按未确认停止继续等，不直接进 indeterminate。围栏已立后才发现动作停不下，同样撤销围栏回 stopping，并重放围栏期间被挡的 report。
- paused_bridge_missing 不是半态：桥断时由 executor-bound 六态 dispatched / started / verifying / timing_out / stopping / startup_unknown 迁入，记 resume_state。桥恢复按 resume_state 重入；startup_timeout 继续走、不重置；unknown_watchdog 与 verify_timeout 按 remaining 重挂，remaining 为 null 才补满额并 Gr 加一；timing_out 围栏不重置；stopping 重新武装截止时间计入 wait_extensions；恢复迁移 CAS 带 Gr。
- 启动层唯一超时是 startup_timeout，默认 60 秒，从 dispatched_at 起算。
- 未知态唯一看门狗是 unknown_watchdog，默认 120 秒，落点 startup_unknown_deadline_at。
- verifying 有独立 verify_timeout，默认 120 秒；到点默认 blocked_post + verify_human；只有模板显式 fail_on_timeout 才按 side_effect_verified_none 分叉 failed / failed_with_unverified。
- 桥断时钟矩阵：
  - startup_timeout 继续走。
  - unknown_watchdog 暂停并冻结 remaining。
  - action_deadline 继续走。
  - verify_timeout 暂停并冻结 remaining。
  - timing_out 的 30 秒宽限暂停，不累计。
  - 桥断预算继续累计，用于判断是不是桥长期不可用。
- 桥恢复只按 remaining 重挂；remaining 为 0 立即到点；只有 null 才补满额并 Gr 加一。
- 跨 boot 公式统一为：remaining = (deadline_monotonic_ns - prev.last_event_monotonic_ns) - (current_boot.started_at - prev.last_event_at)；重挂锚点为 current_boot.started_monotonic_ns + remaining。

### 4.5 取消与超时

超时不是「时间到了就判失败」，分两件事：宣告超时、确认动作停下。

1. 到点先发 cancel。
2. cancel 返回四值之一：
   - interrupted：确认被中断，才立 timing_out。
   - not_interruptible：不可中断，延长 action_deadline_at 并进 stopping，继续等。
   - already_stopped：已经停了，按已停的事实判定，不进 timing_out。
   - unknown：状态不明，进 stopping；再查 executor.state，仍不明则按未确认停止处理。
3. whenIdle 必须带超时，默认 30 秒。interrupted 后先进 timing_out 等 whenIdle；宽限到点仍未见停止，撤销围栏回 stopping，按未确认停止继续等，不直接判 indeterminate。
4. stopping 留在 executor 手上；迟到完成也接受，CAS 只认 status=stopping + Ga。
5. 「继续等」重算 action_deadline_at = now + maxSec，wait_extensions 加一、Gr 加一，不动 Ga；默认上限 3 次。
6. indeterminate_side_effect 只在 executor 已确认停止且动作状态未知时进入；abandoned_unverified 是人主动放弃、动作可能仍在跑，两者不许混用。
7. 围栏已立时收到的 report 进 report_registry(state=rejected) 排队，不丢也不提前收口；围栏撤销后只重放当前 attempt 的队头（seq 最小、state=rejected），重放前验哈希链；旧 attempt 的 report 标 stale。

### 4.6 报告冲突

- 迟到 report 与人的裁决冲突时，生成 report_contradicted decision。
- 节点留在 startup_unknown 或 indeterminate_side_effect，记 hang_reason=report_contradicted 与 contradiction_decision_id。
- 新 attempt 不许先跑；所有普通出口的 CAS 都带 hang_reason IS NULL。
- 只认两个 resolution：uphold_report、uphold_decision；expired 对它无效。
- uphold_report：以迟到 report 为准，按同一 schema、判定与证据门收口 done / failed；decision 行落 approved。
- uphold_decision：维持原裁决 D1，原裁决照常走 superseded / failed；迟到 report 永久标 stale（report_registry.state=stale），只留账、不重放、不覆盖原裁决。

### 4.7 证据与副作用

side_effect_policy 三值：pure、compensable、irreversible。

- irreversible 执行前必须有前置审批。
- compensable 必须有可执行补偿描述符 compensation{tool,args,verify}；补偿工具 capability=compensating，只许在补偿描述符里出现，出现在前向路径一律加载期拒（COMPENSATION_TOOL_IN_FORWARD_PATH）。
- 补偿失败或 verify 不通过，节点落 failed_with_unverified，不落 failed；未验证副作用必须留在账上。
- 补偿事件固定三个：compensation.started、compensation.applied、compensation.failed。事件行带 verify 字段，执行完了与验证过了是两件事。
- 补偿证据固定：compensation_evidence{compensation_id, compensation_for_node_run_id, tool, args_hash, exitCode, stdoutHash, stderrHash, artifactHashes, attempt, verify}。
- compensation_id = hash(node_run_id + attempt + descriptor_version)，同一组合只许一条补偿记录；重放命中同一条证据，不许重复执行。

证据强弱由来源决定：

- 强证据：executor.runTool 用宿主只读身份跑固定命令，有 OS 级隔离。
- 弱证据：模型侧 tool_result，只有 allowlist / argv / toolPolicy 约束，不能充当不可逆节点的通过凭据。
- 不可逆动作的通过凭据必须是产物哈希，仅 exitCode 不算，报 VERIFICATION_TOO_WEAK。
- 宿主没有只读挂载，加载期 EVIDENCE_SOURCE_UNAVAILABLE，不降级。
- verifier 的 toolPolicy 强制只读；出现 mutating 工具，加载期 VERIFIER_TOOL_POLICY_MUTATING。
- runTool 只接受注册表 capability=read_only 的命令；不在注册表或标着 mutating / compensating，调用期 RUN_TOOL_NOT_READ_ONLY。
- trigger 适配器自己发的外部写必须命中注册过的 effect 原语；没注册的写按 irreversible 处理并要求前置审批。
- subworkflow 的 verifier toolPolicy、runTool 命令、trigger effect 原语、补偿描述符在加载期递归校验。
- passCondition 只能引用证据族字段：evidence.exitCode、evidence.stdoutHash、evidence.stderrHash、evidence.hashes、evidence.producedAt。引用 policy.requiredHashes 非法。模板的 passCondition 是 mandatory baseline，节点只能用 and 追加，不能替换或覆盖。
- 证据不足时转 verify_human，不许「没证据也算过」。

前向 effective capability 推导：

1. 前向工具集只含 read_only → pure。
2. 含 mutating 且有可执行补偿描述符 → compensable。
3. 含 mutating 且无可执行补偿描述符 → irreversible。

作者声明只许往更严的一侧写：声明 pure 但推导是 mutating，拒；声明 compensable 但描述符不可执行，拒；声明 compensable 但推导是 pure，拒；声明 irreversible 而推导更宽，接受并按 irreversible 算。注册表查不到的工具一律加载期 TOOL_NOT_REGISTERED。

### 4.8 终态判定

节点终态只从七值集合取。运行终态按下列顺序判定：

1. 有 failed / timeout / failed_with_unverified 子节点：运行只能 failed 或 failed_with_unverified。
2. 有未被替换的 orphaned：运行只能 orphaned 或 paused。
3. 其余再按未验证副作用与 pending_irreversible_children 判 succeeded / succeeded_with_unverified；settling 挡住运行终态，pending 非空拦后继派发。

运行进终态的 CAS 前置：

1. paused_reasons 为空。
2. settling=false。
3. pending_irreversible_children 为空。
4. 该运行下没有非终态 node_run。
5. 该运行下没有活跃 decision（pending / acknowledged / blocked_for_human）。
6. 要落 succeeded 时，不许存在未验证副作用：只认 side_effect_verified_none=true 且带 stop_evidence；stopped_at 不算核实，人签字不算核实。
7. 分叉：有 abandoned_unverified 且未核实 → succeeded_with_unverified；有 failed 且有未验证副作用 → failed_with_unverified。

终态 Snapshot 允许 paused_reasons 只剩 unverified_side_effect 一条，它是风险说明，不是没干完的活。

展示状态先判终态，再按 blocked（paused_reasons 非空）> settling > running 派生；终态不再派生 blocked / settling / running。

### 4.9 恢复与扫描

- 服务启动时先拿锁，再跑恢复扫描；恢复前先校验 node_run_events 哈希链。
- 扫描分类处理：租约过期的 dispatched / started 置 startup_unknown 或 stopping；executor 失联的置 orphaned 候选；桥断的置 paused_bridge_missing 并记 resume_state；timing_out 保留围栏，恢复后先等 whenIdle，不重置 30 秒宽限；到期的未知态生成 startup_unknown decision；到期的动作生成 action_overrun；到期的 verify 转 verify_human；回执过期清 receipt_json。
- 所有扫描都走 CAS，不直接 UPDATE 后覆盖。
- 同一 node_run 同时命中多条扫描时，优先级：终态已定 → 跳过；report_contradicted → 保持挂起；indeterminate → 保持；stopping → 继续等；timing_out → 继续等围栏；paused_bridge_missing → 等桥恢复；startup_unknown → 按钟；其余按租约。
- sweep 必须可重入、可重复执行；重复执行不产生第二个终态、不新增第二条同义 decision。
- 恢复决策必须留痕：写 node_run_events，带扫描原因与前后状态。

## 5. 九种节点

### 5.1 trigger

- 批一支持 human、session.event、cron；批二支持 webhook、file。
- 入口契约定义来源类型、过滤、幂等键算法、失败策略、是否允许重复触发。
- 触发失败进事件表，不开 run；同类连续三次失败上报核心大脑。
- trigger 出度恰为 1；它是唯一入口，不允许有入边。
- 外部适配器写外部必须命中 effect 原语，否则按 irreversible 并前置审批。

### 5.2 agent

- 通过桥创建 executor 子智能体，不继承主会话历史。
- 工具集按 allow / deny 给；未声明默认不给。任何 allow 里出现 mutating 工具，按前向能力推导；声明 pure 会加载期拒。
- 任务会话模板默认不给工具，storages 读写 deny。
- agent 的输出是三件套；有界摘要不超过 800 字。
- agent 不能自报完成；完成由 applyReport 按证据与判定规则收口。

### 5.3 tool

- 由无状态 tool_runner 执行，不重试、不通用 shell、不直连数据库。
- 命令必须命中注册表，参数是数组，不过 shell；cwd 限定工作区。
- tool.call 与 tool.start 分开记；动作计时锚点是 tool_start_at。
- 崩溃恢复按 last_known_phase：
  - 命令前失败：failed，可重试。
  - 执行中且已停：indeterminate_side_effect；不可逆动作走 indeterminate。
  - called_no_start：unknown；pure / compensable 只有 idempotent=true 且无开跑证据才可重试。
- 副作用等级由注册表 capability 派生，不由节点作者声明。
- tool 节点至少要退出码；低于基线加载期拒。

### 5.4 policy

- 纯声明式，只允许 JSON Schema 加白名单算子：eq、ne、in、gt、gte、lt、lte、exists、match，加显式 and / or / not。编译期校验；不许 eval、脚本、读文件。
- 输出固定 payload：

    {
      "schema_version": 1,
      "matched": true,
      "ruleId": "gate.g5",
      "decision": "pass",
      "must_pass_items": [{"id": "Q-01", "result": "pass", "evidence_ids": ["ev-1"]}],
      "failed_items": [],
      "evidence_ids": ["ev-1"],
      "reason": "全部必过项通过"
    }

- artifact 固定 none。
- 每次求值追加 policy.evaluated 到 node_run_events，不镜像进 events。
- 收口器只读该门 run 中最后一条终态 policy 节点的 payload，不从 agent 摘要或草稿反推。
- policy 不能读本 run 的终态；门 run 的终态由 run 外收口器在 run 结束后直抄 runs.status。

### 5.5 branch

- 出边必须带 route：priority 0 到 999，或 default=true。
- 静态重复标签加载期报错；运行期多命中报 BRANCH_AMBIGUOUS。
- 所有分支都不命中且没有 default，进 blocked_post，生成 rule_ambiguous decision。
- branch 的判定只读上游 payload 与静态配置；需要读运行终态的场景不许用 branch，改用 run 外收口器。

### 5.6 approval

- approval 是 first-class decision，不是节点里的一个布尔字段。
- 显式 approval 节点产 decision_ref；节点停 blocked_pre，释放 lease 与 slot；批准后回 queued，attempt 不变。
- irreversible 动作自动插 pre_execution 审批；mem_apply 的 pre_execution 复用 mem_confirm 的 audit_result，不新建第二张卡。
- approval 的默认批准 / 驳回 payload 是空对象；只有异常出口才要求 resolution。
- approval 过期按 decision 规则：24 小时未决 expired；report_contradicted 不 expired。

### 5.7 parallel

- 扇出支持 all、any、quorum；子节点可以是任意批二允许的类型。
- 取消按副作用分级：irreversible 子节点不许取消；其他按策略取消。
- 组结果带 pending_children；运行记派生集合 pending_irreversible_children。
- pending_irreversible_children 非空时，运行不得 succeeded / failed，留在 settling，并拦后继派发。
- allow_irreversible_children 默认 false；开启要显式配置并进门禁用例。
- 并行分支的终态必须全部可解释；有 indeterminate 子节点时父运行不能收口。

### 5.8 wait

- 先落 inbox（seq + cursor）再匹配，避免事件早到丢失。
- wait_registrations 与状态迁移同一事务；注册后按 cursor 重放并回扫。
- 进入 waiting 释放 executor 租约。
- event_timeout 与 wake_dispatch_starvation 分开记：前者是等的事件没来，后者是事件来了但派发不动。
- 唤醒必须带幂等键；重复唤醒只落一条。

### 5.9 subworkflow

- 引用必须 pin 版本；不允许「跟随最新」。
- max_depth=2；depth 是从根到叶经过的 subworkflow 边数，根为 0。
- visited key=(workflow_id, pinned_version)，DFS 判环；环报 SUBWORKFLOW_CYCLE。
- 有效 side_effect_policy 取子图最大；irreversible 强制前置审批。
- 子运行补偿按逆序；补偿失败落 failed_with_unverified。
- 父运行存 pin 版本与 resume_from；重试默认 resume；遇 indeterminate 停，不自动重跑。
- 子流程的 verifier、runTool、trigger effect、补偿描述符递归过闸门，子流程不得成为绕过洞。


## 6. 工作流写模型与发布

### 6.1 四个流程命令

| 命令 | target | expected | payload | 结果 |
| --- | --- | --- | --- | --- |
| workflow.create | 无 | 0 | name、definition、publish_note 可选 | 建 workflows 行与草稿 revision=1；名称与 definition.name 必须一致 |
| workflow.open_draft | workflow_id | base_version | 无 | 以 current_version 为基打开草稿；已有草稿、已消费、从未发布的处理见 6.3 |
| workflow.update | workflow_id | draft revision | definition | 保存层校验后写草稿并返回 validation.errors[]，revision 加一；图语义问题不阻断保存 |
| workflow.publish | workflow_id | draft revision + base_version | publish_note（1 到 500 字） | 生成不可变版本，current_version 上调，消费草稿 |

校验分两层。保存层（workflow.create / workflow.update）只保证这份草稿还能被打开与继续改：拒绝不可解析、超限、节点 id 格式与重复、边端点缺失、坐标非法、自环与重复边、节点标题与流程名非法；缺入口、多入口、有环、branch 缺路由、节点契约不合法这些不阻断保存，作为 validation.errors[] 返回，错误项带 RFC 6901 path。发布层（workflow.publish）做全量校验（恰好一个 trigger、trigger 无入边、出度纪律、全图可达、无环、branch 路由、节点类型已注册、节点必填 config、契约与能力与证据源与 payload schema 闸门、subworkflow 版本与深度），任一不通过返回 WORKFLOW_VALIDATION_FAILED（422，details.errors[] 带 path），不插版本、不改 current_version、不消费草稿。保存层拒绝的项，发布层照拒不误。
保存层拒绝码：WORKFLOW_DEFINITION_INVALID / WORKFLOW_DEFINITION_TOO_LARGE / WORKFLOW_NODE_ID_INVALID / WORKFLOW_NODE_ID_DUPLICATE / WORKFLOW_EDGE_ENDPOINT_MISSING / WORKFLOW_LAYOUT_INVALID / WORKFLOW_EDGE_SELF_LOOP / WORKFLOW_EDGE_DUPLICATE / WORKFLOW_TITLE_INVALID / WORKFLOW_NAME_INVALID；发布层另有 WORKFLOW_VALIDATION_FAILED / WORKFLOW_NO_TRIGGER / WORKFLOW_MULTIPLE_TRIGGERS / WORKFLOW_TRIGGER_HAS_INBOUND / WORKFLOW_TRIGGER_FANOUT / WORKFLOW_NODE_FANOUT_INVALID / WORKFLOW_NODE_UNREACHABLE / WORKFLOW_GRAPH_CYCLE / WORKFLOW_BRANCH_ROUTE_INVALID / WORKFLOW_BRANCH_PRIORITY_DUPLICATE / WORKFLOW_BRANCH_DEFAULT_DUPLICATE / NODE_NOT_SUPPORTED / WORKFLOW_NODE_CONFIG_INVALID / TOOL_NOT_ALLOWED / PAYLOAD_SCHEMA_INVALID / WORKFLOW_SUBWORKFLOW_VERSION_MISSING / SUBWORKFLOW_CYCLE / SUBWORKFLOW_DEPTH_EXCEEDED / MEMORY_WRITE_TOOL_FORBIDDEN，以及版本冲突与事务错误。

### 6.2 发布事务顺序

发布成功路径必须按这个顺序、在同一笔事务里完成：

1. BEGIN IMMEDIATE。
2. 读 workflows 行；不存在返回 WORKFLOW_NOT_FOUND（404）。
3. 读草稿：workflow_id + revision + published_version IS NULL。草稿不存在：已消费返回 WORKFLOW_DRAFT_NOT_OPEN（409）；否则 WORKFLOW_REVISION_CONFLICT（409）。
4. 读 current_version；必须等于 expected.base_version（从未发布时按 0），否则 WORKFLOW_VERSION_CONFLICT（409）。
5. 全量校验 definition：节点、边、route、可达性、无环、名称、长度、大小。
6. 插 workflow_versions，version = base + 1；based_on_version = CASE WHEN base = 0 THEN NULL ELSE base END。
7. UPDATE workflows，语句必须带 workflow_id 且用 COALESCE 处理首发 NULL：current_version 只许从 NULL 或 base 上调到 base+1，不许回退。
8. UPDATE workflow_drafts，语句必须带 workflow_id + revision + published_version IS NULL，写 published_version = base+1。
9. 追加 workflow.published 事件。
10. 写 command applied 回执、receipt_json、completed_at，追加 command.applied。
11. COMMIT。

任何一步失败整笔回滚；不许先提交业务、再写回执。

触发器与错误映射：workflow_versions 的 BEFORE UPDATE / DELETE 触发 WORKFLOW_VERSION_IMMUTABLE；current_version 只许上调；映射时版本序列冲突为 409，版本不存在为 404。

### 6.3 草稿分流

- open_draft：workflow 不存在 → 404；已有未消费草稿 → WORKFLOW_DRAFT_EXISTS；草稿已消费 → 重置草稿、revision 加一、based_on_version=current_version；从未发布 → WORKFLOW_NOT_PUBLISHED（409）。
- update / publish：草稿存在且 revision 匹配才动；草稿已消费 → WORKFLOW_DRAFT_NOT_OPEN；revision 不匹配 → WORKFLOW_REVISION_CONFLICT。
- create 的 payload.name 必须与 definition.name 一致；update 只校验 definition.name；两者都 1 到 80 字。
- 发布只影响之后新建的 run；在途 run 固定旧版本，不改解释。

### 6.4 版本固定

- runs 存 workflow_version；节点模板、verification_policy、evidence_source 按该版本载入，不读最新草稿。
- 发布不迁移在途 run；要换版本只能新建 run。
- 版本只增不减；current_version 不允许回退或置 NULL。
- 最近 20 个版本可查；更早版本仍在库中，按需查询。

## 7. 执行桥与宿主集成

### 7.1 桥的定位

桥是业务通道，不是保活通道。保活由宿主直连 duplex pipe 负责；插件卸载只断业务桥。桥断了不等于执行器死了，也不等于动作没跑。

### 7.2 RPC

- executor.spawn({nodeRunId, attempt, input, outputSchema, toolPolicy}) → {sessionId, agentId}。返回时订阅已生效，执行器待指令。
- subscribe({executorAgentId, attempt, fromSeq})：按序号重放事件；断线重连用同一个 fromSeq。
- send({executorAgentId, attempt, instruction, attemptId})：必须在 subscribe 确认之后调用；未确认就发，返回 BRIDGE_NOT_SUBSCRIBED。
- cancel({executorAgentId, attempt}) → interrupted / not_interruptible / already_stopped / unknown。只有 interrupted 才能立围栏进 timing_out；其余按 4.5 处理。
- dispose({executorAgentId}) 的前置是 service_ack_seq >= bridge_last_seq；不满足不许 dispose，否则会丢未确认事件。
- state({executorAgentId}) → loaded / unloaded / deleted / running / idle，另带 tool_call_seq 与 has_tool_call。
- whenIdle({executorAgentId, timeoutMs})：必须带超时；超时按未确认停止处理，不判 indeterminate。
- runTool({command, args, cwd, timeoutMs})：只读身份、固定命令、argv 不过 shell、cwd 限定工作区；命令必须命中注册表且 capability=read_only；产出强证据；落库前核对命令哈希。
- 事件类型固定：step、turn、tool.call、tool.start、tool.result。tool.call 与 tool.start 分开，动作计时锚点是 tool_start_at。

### 7.3 缓冲与丢失

- 桥缓冲上限 8 MiB，高水位 4 MiB；超限可以 spill 到磁盘，但不许丢证据。
- 事件按 seq 单调；接入层发现 seq 断号，整页重取，不做增量补洞。
- tool.result 丢失时，不许当成「没发生」：按事故留痕，节点进入 indeterminate_side_effect 或保持 startup_unknown，先对账。
- dispose 之前必须确认所有事件已被服务确认；否则宁可保留现场。

### 7.4 executor 生命周期

- 一任务一具名会话，1:1 落 tasks.session_id。
- 每个 node_run 一个 executor 子智能体；同一步重试默认新建 executor，不复用旧现场。
- confirm_not_started 后必须 dispose 旧 executor；之后重试走新 attempt + 新 executor，不许「后来确认已开跑再 reattach」。
- 父运行终态后不再创建子运行；取消向子运行传播。
- 任务会话只存目标、计划、产物引用；节点在子会话跑，回传有界 payload；每条 node_run 记 token 与压缩次数，超预算滚动摘要。

## 8. 读模型、命令面与面板

### 8.1 统一信封

成功：

    {"ok": true, "schema_version": 1, "as_of_seq": 12345, "generated_at": "2026-11-12T03:52:00Z", "data": {}}

失败：

    {"ok": false, "schema_version": 1, "as_of_seq": 12345, "error": {"code": "NOT_FOUND", "message": "找不到这条任务", "retryable": false, "details": {}}}

错误码至少：UNAUTHORIZED、PROTOCOL_VERSION_MISMATCH、SCHEMA_VERSION_UNSUPPORTED、NOT_FOUND、CURSOR_EXPIRED、CURSOR_FILTER_MISMATCH、RANGE_TOO_LARGE、QUERY_TIMEOUT、SERVICE_UNAVAILABLE。

### 8.2 关键读视图

- TaskSummary：task_id、title、workflow_id、workflow_version、status、display_status、current_run_id、session_id、run_count、open_decision_count、unverified_count、current_run_done、total、oldest_open_decision_age_seconds、max_side_effect_level、max_heartbeat_age_ms、attention、attention_reason、updated_at。
- RunSummary：run 基础字段 + reasons[]、settling、counts、total、revision、last_event_seq。
- WorkflowView：draft{revision,based_on_version,definition,definition_hash}、current{version,definition,definition_hash,publish_note,published_at}、validation、versions[]。
- NodeRunView：node_run_id、node_id、seq、node_type、attempt、parent_node_run_id、origin_node_run_id、status、display_status、side_effect_policy、declared_effect、verified_effect、evidence_strength、evidence_state、action_start_source、attestation_id、executor{}、hang_reason、decision_id、started_at、deadline_at、action_deadline_at、heartbeat_age_ms。
- DecisionView：decision_id、run_id、node_run_id、kind、status、priority、priority_reason、age_seconds、expires_at、expiry_effect、expiry_effect_reason、allowed_resolutions[]、required_evidence[]、current_revision、target_summary、confirm_required。
- EventView：seq、event_id、type、occurred_at、boot_id、monotonic_ns、run_id、node_run_id、decision_id、payload_redacted、payload_ref。
- UnverifiedEffectView：run_id、node_run_id、action、side_effect_policy、stopped_at、side_effect_verified_none、stop_evidence、evidence、last_known_phase、resolved、resolved_at、resolution_basis、age_seconds。

attention 排序权重：decision > unverified > failed > orphaned > running > none。

### 8.3 查询

查询列表：list_tasks、get_task、list_workflows、get_workflow、get_workflow_version、list_runs、get_run、list_nodes、get_node、list_decisions、get_decision、list_unverified_side_effects、list_events、get_artifact、get_evidence、get_attestation、verify_ledger、get_operation。

- limit 上限：tasks / workflows / runs / decisions 100；nodes / events 200。
- cursor 不透明，含 v、kind、filter_hash、last_key、last_id、as_of_seq；10 分钟过期；filter 变更报 CURSOR_FILTER_MISMATCH。
- 单页强一致；跨页不承诺同一快照，光标带 as_of_seq 供页面提示。
- 性能目标：list_tasks 1 万条 p95 小于 100ms；get_run 1000 节点 p95 小于 150ms；list_nodes 200 条 p95 小于 80ms；list_events 200 条 p95 小于 50ms。

### 8.4 面板控制面

只开六个命令：decision.acknowledge、decision.resolve、workflow.create、workflow.open_draft、workflow.update、workflow.publish。

- 面板不写库，不做乐观更新；提交后按 operation_id 查回执；超时先查回执，不重复提交。
- 事件只作失效信号；面板收到事件后按 as_of_seq 重取，不把事件当数据源。
- 多端同时操作以 revision CAS 为准；冲突提示刷新后重试，不覆盖别人的改动。

### 8.5 六屏

1. 任务列表：按 attention 降序，再按 updated_at 降序。每行只给人话结论：标题、流程与版本、这次运行到哪一步、等你决定几条、有几笔改动没核实、更新时间。过滤六类：等你决定、待核实、已失败、没人接手、运行中、全部。
2. 任务详情：顶部任务标题、流程版本、会话跳转、run 选择；run 头显示大状态、原因、进度、开始结束；节点按 seq 与 attempt 排列；右侧风险栏挂未决裁决、未验证副作用、孤儿、桥断。点开抽屉不跳走。
3. 待你决定：按 priority 与 age 降序；每卡写清为什么卡、你能选什么、需要什么证据、过期会怎样；本版批量只允许 acknowledge，resolve 一次一条；没有「忽略」。
4. 待核实：独立一级页；列运行 / 节点 / 动作摘要 / 副作用等级 / stopped_at / 最后已知阶段 / 验证状态 / 证据 / 年龄 / 是否已解决 / 解决依据；顶部固定一句话：签字只表示人接下了后果，不表示副作用已消失。
5. 流程列表：名称、当前版本、草稿状态、节点数、在跑任务、最近发布；可新建、打开草稿、发布。
6. 流程画布：只有草稿可拖动、连线、增删；已发布只读；从节点条拖九种节点，右侧圆点拉边，双击空白加一步，整理按拓扑重排；检查面板按节点 / 连线分组，有错时发布不可点；发布确认写目标版本、改动、是否新增不可逆节点、只影响之后新建 run；抽屉展示同一份 WorkflowDefinition JSON，旁注「画布和智能体改的是同一份定义，保存都走 workflow.update」。

### 8.6 视觉与可读性硬门槛

- 浅色主题，不用黑色底；禁止菜单左侧彩色条这类装饰性色块。
- 正文不小于 13px；辅助文字不小于 12px；左侧菜单与顶部导航不小于 12.5px。这是计算后的实际字号，不许只靠覆盖层把局部抬上去而基础样式仍大量小于下限。
- 浅色对比度：正文至少 4.5:1；大字与 UI 控件至少 3:1。
- 1600×1000 与 1366×900 两个视口无横向溢出；长标题截断带完整提示。
- 信息密度低：一屏只回答「做到哪一步、发生了什么、结果是什么、现在要你做什么」；默认不显示 session_id、agent_id、node_run_id、event_id、batch_id。
- 说人话：用「等你决定」「待核实」「这一步」「这次运行」，不用「裁决」「副作用」「算子」作为界面主词。
- 状态颜色只表达语义，不做装饰；未验证副作用与失败必须同屏可见，不许只显示一个绿色成功。

## 9. 记忆插件受控写入 memory-audit-v1

### 9.1 一句话边界

核心大脑只发起，裁判只建议，人只批准，记忆插件只执行受控写入。

三条硬边界：

1. executor / agent / 任务会话模板的 allow 出现 memory_write 或 memory_update → 发布期 MEMORY_WRITE_TOOL_FORBIDDEN。
2. 没有批准批次，一条不写；唯一写入口是 memory.apply_governed，要求批次 approved、audit_result 已批准未过期、批次哈希逐字相符。
3. 审计没跑成就不写（fail-closed）；正常失败不产生半条记忆。

### 9.2 内部端口

| 端口 | 能力 | 补偿 | 暴露范围 |
| --- | --- | --- | --- |
| memory.evaluate | read_only | 无 | 只给编排服务；不注册为 executor 工具 |
| memory.apply_governed | mutating | 无，按 irreversible | 只给编排服务；不注册为 executor 工具 |
| memory.inspect_batch | read_only | 无 | 只给编排服务 |

bridge_id = memory-audit-v1；toolRef 前缀 memory_bridge: 走独立注册表，不与其他工具混查。
三端口的请求与响应字段见 §9.11。

### 9.3 固定图

    mem_trigger
      → mem_prepare（agent，allow memory.search / memory.get）
      → mem_check（tool，memory.evaluate，只读）
      → mem_route（branch：ready / empty / blocked）
    ready → mem_confirm（approval，kind=audit_result，同时是 mem_apply 的 pre_execution 批准）
          → mem_apply（tool，memory.apply_governed，irreversible）
          → mem_report
    empty → mem_report_empty
    blocked → mem_report_blocked

### 9.4 发起与幂等

- memory_start_run(source_run_id, reason, request_key, retry?)；request_key 1 到 64 字。
- memory_run_requests 以 (source_run_id, request_key) 为主键，memory_run_id 唯一；源运行行锁下同事务查映射 / 查活跃运行 / 建运行插映射。
- 同 key 返回同一 run_id 与 attempt，replayed=true；同源已有未终结记忆运行且换 key → MEMORY_RUN_ACTIVE（409）。
- 只有源运行 succeeded 才能发起；否则 MEMORY_SOURCE_RUN_NOT_SETTLED（409）。
- retry=true 才 attempt 加一。

### 9.5 提议与评估

- mem_prepare 输出严格 JSON，items 不超过 20 条；content 不超过 64 KiB；整批不超过 256 KiB；title 1 到 120 字；quote 1 到 1000 字；reason 1 到 500 字；questions 不超过 4 条；tags 不超过 12 个。
- 超限报 MEMORY_BATCH_TOO_LARGE（413）或 MEMORY_PROPOSAL_INVALID（422）。
- 校验通过后同事务写 memory_batches、memory_items 与节点 done；prepare_node_run_id 由引擎注入，不由执行器自报。
- 评估只做四件事：按 prepare_node_run_id 找批次、确定性查重与冲突、调裁判、返回逐条建议；不写记忆，不写 audit store。
- 裁判只看提议、相似条目、源运行摘要；无工具；正文超过 4000 字只给前 4000 字加哈希并标 truncated=true。
- 判定：任一条 needs_user → blocked；无 needs_user 且至少一条 approve / merge → ready；全 reject → empty。
- truncated=true 且 verdict 不是 needs_user，服务端直接 MEMORY_EVAL_INVALID_OUTPUT（502），不许把截断内容当完整判断。
- 失败：超时 120 秒 → MEMORY_EVAL_TIMEOUT（504）；解析失败 → INVALID_OUTPUT（502）；端口不可用 → UNAVAILABLE（503）；开关关闭 → DISABLED（503）。批次与运行都 failed，不写。
- 评估唯一键 (batch_id, eval_attempt)；响应 JSON 不超过 64 KiB。
批次与条目的状态枚举、终态与不变式见 §9.10。

### 9.6 审批

- 只有 recommendation=ready 才生成审批卡，挂 mem_confirm，kind=audit_result。
- allowed_resolutions 为空；resolve payload 为空对象；只产生 approved / rejected。
- 卡片标题是「这几条要写进记忆，你看看」；第一行写这次整理出 N 条 / 建议写入 M 条 / 不写 K 条；每条一行层、标题、摘要、裁判理由；按钮「按这个方案写入」「这次不写」；展开「为什么记这条」。
- 不展示 session_id、node_run_id、batch_id；开发者视图才显示 batch_id、evaluation_id、proposal_hash、decision_id。
- 批准 = 按方案写，reject 条跳过；驳回 = 一条不写，批次 declined，mem_confirm 按 approval 默认动作 failed，运行 failed，任务运行不受影响。
- 过期 = 24 小时未确认，批次 expired，不自动放行。
- 批准同事务写 approved_proposal_hash、approved_item_hashes_json、approved_content_hash；之后这些字段只读。

### 9.7 写入

- memory.apply_governed 只收 decision_id。
- 三道核对：
  1. decision 存在、kind=audit_result、status=approved、未过期、node_run_id 等于批次 confirm_node_run_id。
  2. 批次 approved，批准快照存在；按当前 items 重算 canonical_proposal，proposal_hash 与批准快照比；按 client_key 升序展开 (client_key, content_hash) 与快照逐项比；每条 content_hash 等于 approved_content_hash；无增删改序。
  3. 当前 mem_apply 属于同一记忆运行，批次 source_run_id 与源运行一致，白名单只许 memory.apply_governed。
- 判定顺序：批次不存在 / 不属于该运行 → MEMORY_BATCH_NOT_FOUND（404）；批次不是 approved 或 decision 不是 approved / 已过期 → MEMORY_BATCH_NOT_APPROVED（409）；归属不符 → MEMORY_APPLY_BINDING_INVALID（403）；快照缺失或哈希 / 集合不符 → BINDING_INVALID（403）；同 (batch_id, client_key) 已存在且 content_hash 不同 → MEMORY_APPLY_CONFLICT（409）；其余写失败 → MEMORY_APPLY_FAILED（500）。
- 原子：先校验全部，再一次性持久化；任一条失败整批不落。
- 幂等键 (batch_id, client_key)；重放同 hash 返回 already_applied，不同 hash 报 CONFLICT。
- 三种落点：
  1. 插件返回失败：批次 failed，approved 条目 failed，节点 failed，不生成未验证副作用。
  2. tool.result 丢失：批次保持 applying、outcome NULL，节点 indeterminate；先对账，同批次重跑 apply（节点 attempt 加一，批次仍 applying）。
  3. 对账确认部分写入：批次 indeterminate，已写 applied，未写 approved，节点 indeterminate + verify_human，运行 paused，allowed_resolutions 只给 abandon；签字后运行 succeeded_with_unverified，批次保持 indeterminate，不补写不回滚。
- v1 不删除记忆；不做跨运行补偿。

### 9.8 canonical 与哈希

- canonical_item 只取：client_key、action、target_id、layer、title、content、tags、questions、key、importance、ttl_days、quote、reason。tags 升序去重；questions 保序。
- content_hash = SHA256(JCS(canonical_item))；不含自身与 status。
- canonical_proposal(items) 按 client_key 升序；proposal_hash = SHA256(JCS(canonical_proposal(items)))；status 不入原像。
- 批准后 memory_items 禁止 INSERT / DELETE；除 status 与 applied_item_id 外，其余提议字段只读。即使绕过触发器，apply 重算哈希与快照比对也会失败，报 MEMORY_APPLY_BINDING_INVALID。

### 9.9 记忆面板

只答四个问题：这次记了什么、还有什么没定、哪条没写成为什么、要不要现在记。

状态文案只用：正在整理 / 管家在看有没有重复 / 有 N 条等你确认 / 开始写入 / 正在写入 / 写了 N 条 / 这次没有需要写的 / 有 1 条拿不准，这次没写 / 你选择先不写 / 超过 24 小时没确认，这次没写 / 没写成：裁判没给出结果 / 写到一半，等你确认。

### 9.10 批次与条目状态枚举

批次状态 memory_batches.status：draft / evaluating / awaiting_human / approved / applying / applied / empty / blocked / declined / expired / failed / indeterminate。

- 非终态五种：draft、evaluating、awaiting_human、approved、applying；这五种状态 outcome 必须为 NULL。
- 终态七值与 outcome 一一对应（CHECK 约束）：applied→written、empty→nothing_to_write、blocked→blocked、declined→declined、expired→expired、failed→failed、indeterminate→indeterminate；不许出现「status=applying 但 outcome=written」这类组合。
- 同一源运行的下一次尝试必须新建批次（attempt 加一），不复活旧行；批次内某次 apply 因 tool.result 丢失而重试时不新建批次，节点 attempt 加一。
- 批次终态不变式：批次进入终态时不得留 proposed 条目；empty / blocked / declined / expired / failed 在收口事务里把剩余 proposed 全部迁 skipped，verdict 保留供查看。indeterminate 是唯一允许留 approved 的终态（已写 applied、未写 approved），但同样不得留 proposed。

条目状态 memory_items.status：proposed / approved / skipped / applied / failed；applied、skipped、failed 是终态。条目评估结论 memory_items.verdict：approve / reject / merge / needs_user。评估结论 memory_evaluations.recommendation：ready / empty / blocked。

- 批准后条目正文、层级、client_key、content_hash 与 approved_content_hash 一律只读；indeterminate 批次里已写入的条目保持 applied、未写入的保持 approved，不自动补写、不自动回滚。
- 批次状态是 run / node / decision / apply 事件的投影，不新增 run 状态；唯一写者是编排服务的 memory bridge，面板、executor、agent 只读；每次迁移与对应事件同事务提交，另一条路径不得直接改行。

### 9.11 三端口字段契约

三个端口的请求与响应字段固定如下；字段名以本节为准，实施可加内部字段，不得改名、不得改语义。

memory.evaluate（只读，评估端口）请求：

    {
      "batch_id": "01J...",
      "prepare_node_run_id": "nr_...",
      "source": {
        "run_id": "run_...",
        "task_title": "……",
        "goal": "……",
        "result_summary": "……",
        "evidence_refs": ["artifact:...", "decision:..."]
      },
      "policy": {
        "allowed_layers": ["L2", "L4", "L5", "L6"],
        "max_items": 20,
        "max_content_bytes": 65536,
        "allow_update": true,
        "require_quote": true,
        "judge_content_limit": 4000
      },
      "items": [
        {
          "client_key": "audit-fail-closed",
          "action": "create",
          "target_id": null,
          "layer": "L4",
          "title": "……",
          "content": "……",
          "content_hash": "sha256:...",
          "quote": "……",
          "similar": [
            {"id": "mem_...", "title": "……", "summary": "……", "score": 0.82}
          ]
        }
      ]
    }

响应：

    {
      "ok": true,
      "batch_id": "01J...",
      "recommendation": "ready",
      "items": [
        {
          "client_key": "audit-fail-closed",
          "verdict": "approve",
          "confidence": 0.86,
          "reason": "和已有条目主题一致，但结论更新，建议写入",
          "conflict_with": null
        }
      ],
      "summary": "3 条建议写入，1 条和已有记忆重复",
      "model": {"provider": "spawn", "name": "default", "prompt_version": "memory-audit-v1"},
      "duration_ms": 4210
    }

memory.apply_governed（写入端口）：入参只有 decision_id 一个字段，批次、条目、哈希都由服务按 decision_id 反查，执行器传不进第二套内容。响应：

    {
      "ok": true,
      "batch_id": "01J...",
      "outcome": "written",
      "applied_count": 2,
      "skipped_count": 1,
      "already_applied": false,
      "items": [
        {"client_key": "audit-fail-closed", "applied_item_id": "mem_...", "status": "applied"},
        {"client_key": "old-note", "status": "skipped", "reason": "裁判建议不写"}
      ]
    }

memory.inspect_batch（只读，对账端口）：入参只有 batch_id；返回体带同一个 batch_id 与每条 client_key 在插件里的状态（applied / skipped / missing / conflict）、applied_item_id 与 content_hash，并返回本次对账的 written_count、missing_count、partial 与 evidence_id（写进事件账本，供 confirm_applied / confirm_not_applied 引用）；计数必须能由逐条状态重算，不许与逐条状态矛盾。它不写、不修复、不猜。
## 10. 超级大脑：计划、执行、记忆三个循环

### 10.1 核心大脑是什么

核心大脑是一个带 orchestra.author / orchestra.operator 能力的 agent 角色。它不是一个绕过状态机的「总控脚本」，而是编排服务的一个授权客户端。它的权力来自能力位与命令面，不来自它可以写库。工作区内任意会话默认具备该能力位，见 §18.1。

### 10.2 三个循环

计划循环：

1. 人给出目标。
2. 大脑读现有流程与版本，决定复用还是新建。
3. 需要新建时，通过 workflow.create / open_draft / update 起草；画布与大脑改的是同一份定义。
4. 发布前读 validation；有错不发布。
5. 建任务、起运行；起运行必须固定 workflow_version。

执行循环：

1. 服务按状态机调度 executor、tool、approval、parallel、wait、subworkflow。
2. 每个节点只拿自己的输入与工具策略；执行器不继承主会话历史。
3. 事件回账本；大脑读运行摘要、节点摘要、裁决卡、产物索引，不读全量 transcript。
4. 遇到卡点，服务生成 decision；大脑可以建议，但不能替人批准，也不能绕过证据门。
5. 大脑需要推进时，发命令并带 operation_id 与 expected CAS；服务接受才生效。

记忆循环：

1. 源运行收口后，大脑发起 memory_start_run。
2. 记忆运行按固定图跑：提议、评估、人批、写入、汇报。
3. 大脑只读批次结论与写入条数，不直接调 memory_write / memory.apply。
4. 一次任务的多条记忆只占一张审批卡；写入结果回写任务详情。

### 10.3 权力边界

可以做：

- 调 workflow.create / open_draft / update / publish。
- 调 orchestration.start_run（核心大脑专用，不在面板控制面）。
- 调 memory_start_run。
- 读任务、运行、节点、裁决、产物索引、批次结果。
- 在 decision 上给建议、认领、提交人已经明确给出的结论。

不可以做：

- 直接改账本或数据库。
- 直接调 memory_write / memory_update / memory.apply_governed。
- 读 executor 全量 transcript。
- 替人批准，或用自然语言宣布完成而不看账本。
- 绕过证据门、阶段门、容量门。
- 把「我觉得完成了」写成运行终态。

### 10.4 指挥链

人 → 核心大脑（选流程、起运行、读摘要、提建议）→ 编排服务（状态机、账本、证据门）→ executor 子智能体（执行单节点）→ tool_runner / 子流程 / 等待 / 审批。指挥链上每一跳都有契约与回执；没有回执的「已安排」不算安排。

### 10.5 上下文预算

- 任务会话只存目标、计划、产物引用。
- 节点在 executor 子会话跑，回传有界 payload 与不超过 800 字摘要。
- 每条 node_run 记 token 与压缩次数；超预算滚动摘要，保留最近结论与证据引用。
- 大脑看到的是摘要与索引，不是执行器全文；需要细节时按 evidence_id 取证据，不把全文灌回上下文。对话不被任务占用见 §18.2。
- 压缩不改变账本事实；摘要写短了要重写，不许把关键结论压没。

## 11. 阶段、门与发布

### 11.1 六阶段

| 阶段 | 名称 | 内容 | 门 |
| --- | --- | --- | --- |
| S1 | 账本地基 | 服务、SQLite、迁移、事件哈希链、认证、备份恢复 | G1 |
| S2 | 单节点闭环 | 仅 agent；桥、租约、上报、终态、取消、证据、超时 | G2 |
| S3 | 九节点与状态机 | 迁移、CAS、八种 decision、审批、并行、等待、子流程、补偿 | G3 |
| S4 | 流程定义与版本 | 四命令、校验、发布、版本固定 | G4 |
| S5 | 面板与记忆 | 查询、SSE、六屏、memory 全链路 | G5 |
| S6 | 硬化与发布 | 故障注入、性能、安全、升级回滚、手册、R0、G6、R1、R2 | G6 + R1 + R2 |

阶段能力表：

| 阶段 | 允许 | 禁止 |
| --- | --- | --- |
| S1 | 账本、迁移、备份、只读查询 | 真实桥、并行、发布流程、面板接真实账本 |
| S2 | 单 agent 节点闭环 | parallel、subworkflow、workflow 发布 |
| S3 | 九节点、状态机、补偿 | workflow 发布、面板接真实账本 |
| S4 | 流程定义与版本 | 面板接真实账本、记忆写入 |
| S5 | 面板、记忆全链路 | R2 受控圈 |
| S6 | 硬化、发布、三圈 | 越过 G6 直接进 R2 |

### 11.2 六道门

G1 必过：迁移空库可重复、中途杀可重入、进程杀不丢已提交事件、备份独立目录行数与哈希一致、损坏备份可检出、认证拒匿名写、阶段开关拒未知值、G-01 / G-02 / G-08 / G-09 / G-14 / G-15。

G2 必过：单节点 queued 到终态一条路径、重复上报只落一次、租约过期迟到上报被拒、取消后不产生新 attempt、终态必带证据、无裸 blocked、S2 加载 parallel 被拒、G-03 / G-04 / G-05 / G-07。

G3 必过：M-01 到 M-61 全过、非法迁移全拒、并发只有一个赢家、并行扇出与汇聚一致、子流程环与深度拒、补偿不重复、取消向子 run 传播、G-01 / G-02 / G-04 / G-06 / G-12 / G-16。

G4 必过：Q-37 到 Q-42、发布事务与回执同笔、并发发布只有一个版本、在途 run 固定旧版本、非法图与空名称拒、回滚发布不影响已固定 run、G-10。

G5 必过：Q-01 到 Q-36 与 Q-43 到 Q-63（含 43b / 43c / 44b / 44c / 47b / 52b）、两个视口无横向溢出、正文不小于 13px、辅助不小于 12px、菜单与顶导不小于 12.5px、浅色对比度正文 4.5:1、大字与 UI 3:1、记忆部分写入可对账、S5 启动 wf_release_v1 被拒、G-06 / G-11 / G-12。

G6 必过：G-01 到 G-16 全过、控制面 p95 达 8.3、事件滞后 p95 不大于 2 秒且最大不大于 10 秒、24 小时浸泡无泄漏无孤儿、从上一版升级成功、双向兼容窗口内负载回滚成功、值班手册演练通过、两份 artifact 的 candidate_hash / evidence_index_hash / conclusion 一致。

### 11.3 门记录 GateArtifact

字段固定：

    {
      "gate": "G6",
      "schema_version": 1,
      "gate_run_id": "run_01J9Z6K4T3R8M2Q7",
      "candidate_hash": "9f2c7a1b4d8e6f0a3c5b7d9e1f2a4c6b8d0e2f4a6c8b0d2e4f6a8c0b2d4e6f8a",
      "change_scope_hash": "1a3c5e7f9b0d2f4a6c8e0b1d3f5a7c9e2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a",
      "evidence_index_hash": "3f7a9c1e5b8d2f4a6c0e8b1d5f9a3c7e2b6d4f8a0c1e5b9d3f7a2c6e4b8d0f1a",
      "invariants_hash": "5b8d2f4a6c0e8b1d3f7a9c5e2b6d4f8a0c3e7b9d1f5a2c6e8b0d4f7a9c3e1b5d",
      "must_pass_items": [{"id": "G-01", "result": "pass", "evidence_ids": ["ev-g01"]}, {"id": "G-16", "result": "pass", "evidence_ids": ["ev-g16"]}],
      "failed_items": [],
      "conclusion": "pass",
      "run_terminal": "succeeded",
      "exceptions": [],
      "rollback": {"target": "上一过门构建", "action": "回退并验证", "duration_s": 600, "verification": "冒烟与账本回放通过"},
      "approver": "human:啸春",
      "approved_at": "2026-11-12T03:52:00Z",
      "producer": "wf_release_v1"
    }

规则：

- 有 run 的门：收口器在 run 终态后写，gate_run_id 指向门 run，run_terminal 直抄 runs.status。
- 无 run 的门：gate_run_id=null，run_terminal=not_applicable；G1 到 G5 的主 artifact producer=human（这几道门由人按同一张卷子手工跑）；G6 的独立 artifact producer 取 human 或 s5_build（S5 过门构建，按实际执行者）；G6 的发布大脑 artifact producer=wf_release_v1，是唯一有 run 的门。G1 到 G5 与 G6 的独立 artifact 都是无 run。
- conclusion=pass 当且仅当 must_pass_items 全 pass、failed_items 为空、run_terminal=succeeded（无 run 为 not_applicable 且 gate_run_id=null）。
- run 内节点（含 policy / branch / 收口草稿）一律不读本 run 终态；运行终态由 run 外收口器注入。
- artifact 内部不放 record_hash / artifact_hash 自指字段；S*.md 正文结论后固定锚点 artifact_hash=SHA256(canonical_json(artifact))，补记只追加在锚点后，不移动锚点、不算进哈希。
- exceptions 只作风险说明，不改变 must_pass_items / failed_items / conclusion；例外不能把 fail 改成 pass。
- 审计报告结论只认行首唯一一行 `结论：pass` 或 `结论：fail`（标题、列表、引用、加粗标记可剥）；`判定/审计意见/最终判定/最终结论/结果` 与“通过/不通过”等价。围栏代码块里的示例结论不参与判定，关闭围栏必须同字符且不短于开启围栏；结论 token 后只接受句末标点、一个括号或一个破折号解释，括号/解释内只允许清零计数（`P0=0`、`无 P0/P1`、`0 致命`、`P2 遗留 N 条`），其余文字按未收口处理；`建议：` 行不得当结论。多个结论行视为没有结论。
- rollback 字段描述回滚目标、动作、预计耗时与验证方式；回滚对象是上一过门构建。

### 11.4 发布大脑 wf_release_v1

- 只在 S6 启用；G1 到 G5 由人按同一张卷子跑，G6 另有一份独立 artifact。
- run 形状：trigger → agent（只排检查组，不执行、不写账本、不批准）→ parallel 扇出六组检查命令 wf_gate_check_v1（迁移恢复 / 单节点 / 状态机并发 / 版本发布 / 面板记忆 / 性能安全）→ 子流程 tool 跑命令与注入、agent 只读写摘要、产出 evidence → wait 等收口（超时 paused=blocked，写清哪组没回来）→ policy 确定性判必过项与阈值（不读 agent 摘要）→ approval 人批（绑定候选哈希与证据集合，证据变则失效）→ run 外收口器写 GateArtifact → branch 只读 policy decision 分流，部署脚本另判 conclusion / run_terminal / gate_run_id。
- 面板只显示一张门卡：阶段与门、一句结论、谁在等、下一步一个动作；默认不显示 run_id / node_run_id / event_id。

### 11.5 回滚与升级

- 账本只追加，线上不回退；回滚的是构建与路由。
- 备份只恢复到独立目录做校验；线上按事件日志重放，RPO=0。
- 破坏性迁移先扩展再收缩；回滚要在负载中演练。
- 触发：I1 到 I9 破坏；同类 P1 24 小时两次或跨工作区；事件滞后超阈十分钟且扩容无效；迁移后状态无法用账本解释；安全边界突破。
- 值班人可先停新 run、关路由；回退构建由阶段负责人十分钟内拍板。
- 阶段回滚：S1 停服务保留账本；S2 关桥、在途 agent 置 paused_bridge_missing（显示 blocked）；S3 停新 run、等在途收口，默认前滚，只有旧构建读新账本用例过才换旧引擎；S4 撤问题版本、不动已固定 run；S5 关面板与记忆路由、引擎账本继续；S6 按手册退上一过门构建，仅双向兼容窗口。
- 升级七步：备份 → 副本迁移校验 → 停新 run 等到安全点 → 起新构建健康检查与只读回放 → 合成单节点 run → 恢复新 run 观察十分钟 → 不对按表回滚并记录现场。

### 11.6 三圈试用

R0 合成圈：开发与审计，假执行器与沙箱，全部注入，不上真实工作区；连续 3 天无 P1，G1 到 G5 对应项通过，回滚演练通过。

R1 只读圈：一个受信工作区与值班人，真实账本、只读工具、真实面板，记忆只到提议；连续 1 周无 P1，停点可读，提议无越权。

R2 受控圈：白名单工作区与流程，allowlist 写工具、人工批准、每日复盘；连续 2 周无 P1，事故 30 分钟内定位，手册演练通过。

升圈只升一级；出现 I1 到 I9 破坏或安全边界突破，直接回 R0。


## 12. 不变量、故障注入与非功能要求

### 12.1 十条不变量

I1 一个 node_run 与一个 run 最多一个终态。任何迁移都带 CAS；已终态的行不再接受普通出口。

I2 账本只追加；已提交事件不改写；事件序号单调。node_run_events 的哈希链随每次状态迁移追加。

I3 所有迁移带 CAS；CAS 失败不产生副作用。写路径不许「先查后写」而不带 revision / attempt / generation / epoch。

I4 每个终态有对应证据；不可逆动作必须有强证据加产物哈希。终态证据表见 12.2。

I5 一条 run 只在一个 workflow 版本上跑；发布不改在途 run。

I6 审批绑定内容哈希与有效期；内容变则失效；批准后只读。

I7 记忆批次按条目原子；request_key 幂等；部分写入只进 indeterminate 并对账。

I8 父 run 终态后不产生新子 run；取消向子 run 传播。

I9 恢复决策确定且留痕；同一现场重复恢复得到同一结论。

I10 没有门记录与批准人不得进下一阶段；例外不覆盖 I1 到 I9。

### 12.2 终态证据表

| 层级 | 终态 | 证据 |
| --- | --- | --- |
| node_run | done | tool.result 或产物哈希加强证据回执；不可逆节点要强证据与产物哈希 |
| node_run | failed | 失败输出 / 错误码 / 执行器报告 |
| node_run | timeout | deadline 事件加最后心跳加取消结果 |
| node_run | abandoned_unverified | abandon decision 加签字加 stop_evidence；没有 side_effect_verified_none=true 时不许当成功 |
| node_run | failed_with_unverified | compensation.failed 加 verify 失败或无补偿证据 |
| node_run | orphaned | 扫描事件加最后心跳加 executor 身份 |
| node_run | superseded | 迁移事件加 replacement_node_run_id 加旧行未产生不可逆副作用的证据 |
| run | succeeded | 所有子节点终态；收口事件；每个不可逆子节点有分叉证据：done 强证据加产物哈希，superseded 未产生副作用证据，已核实的 abandoned_unverified 要 side_effect_verified_none=true 且带 stop_evidence；没有 indeterminate |
| run | failed | 至少一个 failed / timeout 子节点；无未验证副作用 |
| run | failed_with_unverified | 失败分支存在未验证副作用 |
| run | succeeded_with_unverified | 成功分支存在未验证副作用 |
| run | orphaned | 孤儿节点未被替换；有扫描与心跳证据 |

### 12.3 故障注入

| 编号 | 注入 | 期望 |
| --- | --- | --- |
| G-01 | 事务 COMMIT 前杀进程 | 重启后事务未提交，无半条记录；有旧构建则回退，无旧构建停当前阶段修复 |
| G-02 | COMMIT 后 outbox 未投递杀 | 重启后事件补投；业务状态与账本一致 |
| G-03 | 同 report_id 上报两次 | 第二次命中幂等，只落一次；registry 为 replayed |
| G-04 | 租约到期后原执行器迟到上报 | 迟到报告被拒；节点不被旧执行器推进；晚到 tool.result 只进隔离区 |
| G-05 | 工具执行中取消 | 只有 confirmed interrupt 才立 timing_out；其余进 stopping；不产生第二终态 |
| G-06 | tool.result 丢失 | 节点进 indeterminate 或保持 applying，先对账；不许当没发生 |
| G-07 | 墙钟前后跳十分钟并覆盖重启 | 截止按 boot_id + monotonic_ns，不因墙钟跳变误判；不确定转 timer_uncertain |
| G-08 | 写锁长事务，队列 1000 | 写路径有上限与溢出策略；读不被拖死；超限有明确错误 |
| G-09 | 订阅者离线十分钟重连 | 按 fromSeq 重放；断号整页重取；不丢证据 |
| G-10 | 在途 run 时发布新版本 | 在途 run 仍按旧版本解释；新 run 用新版本 |
| G-11 | 记忆批次写一半杀 | 批次 applying；对账确认部分写入后才转 indeterminate；签字后 run succeeded_with_unverified |
| G-12 | 审批双击 / 同决定重复提交 | 同 operation_id 重放回执；不同 operation_id 同 revision 只一个赢家 |
| G-13 | 升级 / 回滚时仍有在途 run | 安全点等待与回滚表生效；在途 run 不被新构建改写 |
| G-14 | 迁移一半杀后重跑 | 迁移可重入；已提交步骤不重复；无旧构建时停 S1 修复 |
| G-15 | 备份截断 / 篡改后恢复 | 独立目录校验能检出；不污染线上账本 |
| G-16 | 父 run 取消子 run 仍在跑 | 取消向子 run 传播；父 run 不先收口；子 run 收敛后再判 |

每条注入都要留：注入脚本与参数、前后账本片段、恢复后对账查询。没有对账查询的注入不算通过。

### 12.4 性能与容量

- 控制面读：见 8.3。
- 写路径：单写者；短事务；busy_timeout 5000ms；写队列有上限与溢出策略。
- 事件滞后：p95 大于 2 秒或最大大于 10 秒，持续十分钟必须告警；告警不等于放行。G6 放行要求全程 p95 不大于 2 秒且最大不大于 10 秒。
- 24 小时浸泡：无连接泄漏、无孤儿 run、无未收口事件、无持续增长的内存或磁盘异常。
- 上下文：单节点回传 payload 默认 64 KiB；摘要不超过 800 字；超预算滚动摘要，保留结论与证据引用。

### 12.5 安全与保留

- 任务会话默认不给工具；storages 读写 deny。
- executor 工具集按 allow / deny；未声明默认不给；注册表查不到拒。
- 认证：写操作必须有主体；actor 由认证主体派生，不由 payload 自报。匿名写拒绝。
- 账本哈希链用服务持有 HMAC 密钥；定位为非对抗性校验，不声称防篡改。真正的边界是不给任务会话与 executor 读写 storages 的工具。
- 保留期：事件与证据按配置保留；artifact 过期后显示「已过保留期」，不删账本事实。回执 7 天；in_flight 10 分钟。
- 导出与日志默认脱敏：不打印 token、密钥、完整 payload、executor 全量 transcript。

## 13. 测试与验收

### 13.1 单元与契约测试

- 状态迁移逐行用例：合法迁移接受，非法迁移拒绝；每次拒绝不产生副作用。
- applyReport 六步顺序：幂等、schema、CAS、证据、判定、收口；任一步失败不落半条。
- 哈希与 canonical：字段白名单、tags 升序去重、questions 保序、集合数组升序去重；原像变化必然改变哈希。
- 工作流校验：node_id 格式、重复边、自环、不可达、多入口、trigger 出度、branch route、名称长度、1 MiB 上限。
- 发布事务：并发发布只有一个赢家；在途 run 固定旧版本；回执与业务同笔。
- 命令幂等：同 operation_id 同 hash 重放；不同 hash 冲突；过期回执拒绝；在途超时收口。
- 记忆：request_key 幂等、批次状态迁移、批准快照、部分写入对账、四类错误码优先级。

### 13.2 并发与恢复测试

- 同一节点两个执行器同时上报：只有一个赢家；败方整笔回滚。
- 裁决收口与 run 终态同事务：不会出现 run 已终态但 decision 还活跃。
- 租约过期、桥断、宿主强杀、插件重载、服务崩溃五类恢复各跑一遍。
- 事件断号、订阅者离线、outbox 未投递、回执写入失败各跑一遍。
- 并行扇出 all / any / quorum；不可逆子节点取消；子流程环与深度；父取消传播。

### 13.3 面板验收

- 1600×1000 与 1366×900 无横向溢出。
- 正文计算字号不小于 13px；辅助不小于 12px；菜单与顶导不小于 12.5px；不是只靠覆盖层局部达标。
- 浅色主题；正文对比度不小于 4.5:1；大字与 UI 不小于 3:1；无黑底、无菜单彩色左条。
- 六屏逐屏走查：任务列表、任务详情、待你决定、待核实、流程列表、流程画布。
- 默认视图不出现 session_id、agent_id、node_run_id、event_id、batch_id；开发者视图才出现。
- 每个卡点都能回答：为什么卡、谁能解、可选什么、需要什么证据、过期会怎样。
- 空态、错误态、加载态、断线态都有文案；断线不显示假数据。
- 事件只作失效信号；页面重取后与账本一致。

### 13.4 安全验收

- 匿名写拒绝；越权命令拒绝；actor 不可伪造。
- executor allow 含 mutating 且声明 pure，加载期拒。
- verifier toolPolicy 含 mutating，加载期拒。
- runTool 非只读命令，调用期拒。
- trigger 未注册 effect 原语，按 irreversible 并要求审批。
- 任务会话读写 storages 被拒。
- 记忆直接写工具出现在 allow，发布期拒。

### 13.5 门禁验收

- 每道门都有 GateArtifact；G1 到 G5 与 G6 独立 artifact 无 run；G6 发布大脑 artifact 有 run。
- must_pass_items 逐项有证据；failed_items 为空才能 pass。
- G6 两份 artifact 三字段一致：candidate_hash、evidence_index_hash、conclusion。
- 门 run 的终态由 run 外收口器写；run 内节点不读本 run 终态。
- 门记录缺失、批准人缺失、证据缺失，任一情况不得进下一阶段。

## 14. 实施顺序

### 14.1 第一批：S1 账本地基

1. 建服务骨架、配置、日志、认证、单写者连接。
2. 建迁移框架与最小表：service_meta、tasks、runs、node_runs、events、node_run_events、inbox、leases、artifacts、report_registry。
3. 事件哈希链、epoch 栅栏、备份与恢复、损坏检测。
4. G1 用例与 GateArtifact。

### 14.2 第二批：S2 单节点闭环

1. 桥 RPC 最小集：spawn、subscribe、send、cancel、dispose、state、whenIdle。
2. agent 节点、租约、上报、applyReport、终态、取消、超时。
3. 证据强弱、runTool 最小只读命令、S2 阶段开关。
4. G2 用例。

### 14.3 第三批：S3 九节点与状态机

1. 补全九节点与全部迁移。
2. decision 八种、审批、并行、等待、子流程、补偿。
3. 半态、时钟、冲突、恢复扫描。
4. M-01 到 M-61、G3 用例。

### 14.4 第四批：S4 流程定义与版本

1. 三表、四命令、校验、发布事务、版本固定。
2. 画布同源定义与保存接口。
3. Q-37 到 Q-42、G4 用例。

### 14.5 第五批：S5 面板与记忆

1. 读模型、查询、SSE、六屏。
2. 记忆三端口、固定图、四张表、审批与写入。
3. 视觉门槛、字号审计、对比度审计。
4. Q-01 到 Q-36、Q-43 到 Q-63、G5 用例。

### 14.6 第六批：S6 硬化与发布

1. G-01 到 G-16 注入、性能、24 小时浸泡。
2. wf_release_v1、GateArtifact、值班手册、升级回滚。
3. R0、G6、R1、R2。
4. 发布包与安装说明。

## 15. 七条措辞澄清（设计稿第 45 轮 pass 留下）

### 15.1 人工门是什么

人工门是没有 orchestra run 的门。producer=human（G6 独立 artifact 可以是 s5_build），gate_run_id=null，run_terminal=not_applicable。人工门同样要有 must_pass_items、逐项证据、failed_items、conclusion、approver、approved_at；证据是可复现命令与输出、审计记录、截图或账本片段。人工门不是「人说过了就算」，没有证据索引与必过项清单，不算门记录。

### 15.2 四个哈希原像给合法 JSON

candidate_hash 原像：

    {"git_sha":"0123456789abcdef0123456789abcdef01234567","schema_version":1,"phase":"S6"}

change_scope_hash 原像：

    {"capability_ids":["panel.read","memory.apply_governed"],"touched_paths":["src/service","docs/gates"]}

evidence_index_hash 原像：

    {"evidence_index":[{"evidence_id":"ev-1","sha256":"3f7a9c1e5b8d2f4a6c0e8b1d5f9a3c7e2b6d4f8a0c1e5b9d3f7a2c6e4b8d0f1a","strength":"strong","source":"runTool"}]}

invariants_hash 原像：

    {"invariants":[{"id":"I1","method":"counterexample","result":"pass"}]}

以上都先做 canonical_json：UTF-8、对象键按 Unicode 码点升序、无多余空白；集合数组先升序去重；再对字节做 SHA256。伪 JSON、带注释的 JSON、把键顺序留给人猜的写法都不算定义。

### 15.3 G6 双 artifact 的「一致」范围

只指三个字段：candidate_hash、evidence_index_hash、conclusion。approver、approved_at、run_terminal、gate_run_id、exceptions、rollback 允许不同，不要求逐字一致。不一致时以独立人工或 S5 构建那份为准。

### 15.4 G6 告警与放行分开

告警阈值：事件滞后 p95 大于 2 秒，或最大大于 10 秒，持续十分钟，必须告警。告警是运维动作，不等于验收通过，也不等于验收失败。

放行要求：G6 测量窗口全程 p95 不大于 2 秒，且最大不大于 10 秒。窗口内任何一次超过上限，都不满足放行条件；不许用「平均下来没事」或「告警后恢复了」替代。

### 15.5 G5 用例补 Q-52b

G5 的必过清单必须包含 Q-52b：批准后对 memory_items 做 INSERT / DELETE / 非 content 字段 UPDATE / 换序，四种篡改都要被拒；apply 重算 canonical_proposal 与批准快照比对失败，报 MEMORY_APPLY_BINDING_INVALID。只列 Q-52 不列 Q-52b，G5 不算完整。

### 15.6 例外写入门记录

exceptions[] 是 GateArtifact 的字段，写在 artifact 内，随 artifact 一起被 artifact_hash 覆盖。例外只作风险说明：不改变 must_pass_items、failed_items、conclusion。某个必过项失败，就是 failed_items 有它、conclusion=fail；例外不能把它改成 pass，也不能让门进入下一阶段。例外的 scope、expires_at、compensation、rollback_target、approver 必须齐全；缺一项视为无效例外。

### 15.7 artifact 哈希与证据文件哈希分开叫

artifact_hash 只指 GateArtifact 的锚点哈希：SHA256(canonical_json(artifact))，写在 S*.md 正文结论后的固定锚点，补记不移动锚点、不算进哈希。

证据文件哈希、节点产物哈希一律叫 sha256 或 artifact_ref.sha256，放在 evidence_index 或产物引用里，不叫 artifact_hash。面板与 API 也不许把两者混成一个字段。

## 16. 追溯与开放项

### 16.1 需求到章节

| 需求 | 章节 |
| --- | --- |
| R1 插件层编排 | 2、7 |
| R2 跨插件 / agent / 会话，重启恢复 | 2、4.9、7 |
| R3 核心大脑 | 10 |
| R4 状态机与唯一终态 | 3.3 到 3.5、4.8 |
| R5 九节点 | 5 |
| R6 客观证据 | 4.7、12.2 |
| R7 面板 | 8 |
| R8 统一入口 | 3.7、8.1 到 8.4 |
| R9 可发布插件 | 11、14 |

### 16.2 设计稿到规格

| 设计稿 | 规格 |
| --- | --- |
| §1 定位与架构 | 1、2 |
| §2 执行单元与状态机 | 3、4 |
| §3 九节点 | 5 |
| §4 面板与查询 | 8 |
| §5 记忆对接 | 9 |
| §6 阶段与门 | 11 |
| §7 错误与恢复 | 4.9、12 |
| §8 迁移与用例 | 4、12、13 |
| §9 裁决出口 | 4.6、4.8 |
| §11 证据与身份 | 4.7、12.5 |

### 16.3 开放项（2026-11-13 已定值）

六项已按主人 2026-11-13 的口径拍定，取值如下；对应门记录随阶段落地，配置键在用到该值的阶段写进 `orchestra.config.json`：

| 项 | 定值 | 落地 |
| --- | --- | --- |
| 写队列上限与溢出策略 | 1000 条；队列满返 `SERVICE_UNAVAILABLE`（503）并记 warning，读路径不受阻塞。S6 压测若明显恶化再抬到 2000，改值须重跑 G1 | G1 门记录；`src/service/write-queue.ts` |
| 事件与证据保留期 | 不自动清理：events 永久保留；evidence 与 artifact 不删，过期只标注「已过保留期」。S6 有真实体量后再定天数并进门记录 | 不启用清理任务；§12.5 |
| 记忆裁判的模型与提示词版本 | 桥 `memory-audit-v1`；提示词版本 `mem-judge-1`；模型名在 S5 装桥时按宿主可用模型填，并写进 G5 | S5 配置与 G5 |
| 值班人与升级联系人 | 值班人 `human:啸春`；升级链：面板 inbox → QQ；超过 30 分钟未响应自动停新 run（在跑的不杀） | S6 配置与 G6 |
| R1 / R2 工作区白名单 | R1：本仓库工作区、只读工具、记忆只到提议；R2：再开受控沙箱工作区与只读检查类流程白名单；先跑满 R0 合成圈 3 天再逐级开 | S6 配置与 G6 |
| 24 小时浸泡的采样频率与判定脚本 | 30 秒采样共 2880 点；`scripts/soak.ts` 判定并产出 `soak-report.json`；判据=无孤儿 run/node_run、无未收口事件、事件滞后 p95≤2s 且最大≤10s、RSS 与 WAL 无单调增长、连接与句柄不增长 | S6 脚本与 G6 |

定值之后不再以「还没定」放行；要改值，重跑对应门并重签 `artifact_hash`。

## 17. 附录

### 17.1 错误码总表

| 错误码 | HTTP 或通道 | 含义 |
| --- | --- | --- |
| UNAUTHORIZED | 401 | 未认证或主体无效 |
| FORBIDDEN | 403 | 有主体但无权做这件事 |
| PROTOCOL_VERSION_MISMATCH | 409 | 协议版本不匹配 |
| SCHEMA_VERSION_UNSUPPORTED | 422 | schema 版本不支持 |
| NOT_FOUND | 404 | 对象不存在 |
| CURSOR_EXPIRED | 410 | 游标过期 |
| CURSOR_FILTER_MISMATCH | 409 | 游标与当前过滤不一致 |
| RANGE_TOO_LARGE | 413 | 查询范围过大 |
| QUERY_TIMEOUT | 504 | 查询超时 |
| SERVICE_UNAVAILABLE | 503 | 服务不可用 |
| OPERATION_ID_CONFLICT | 409 | 同 operation_id 不同请求 |
| OPERATION_EXPIRED | 410 | 回执已过窗口 |
| OPERATION_TIMEOUT | 504 | 在途超时已收口 |
| COMMAND_BUSY | 409 | 同 operation_id 仍在途 |
| CONFIRMATION_REQUIRED | 428 | 高风险操作需要二次确认 |
| CONFIRMATION_MISMATCH | 409 | 确认内容不匹配 |
| CONFIRMATION_EXPIRED | 410 | 确认过期 |
| DECISION_REVISION_CONFLICT | 409 | 裁决 revision 冲突 |
| RESOLUTION_NOT_AVAILABLE | 422 | 当前状态不允许这个出口 |
| VERIFICATION_TOO_WEAK | 422 | 证据强度不足 |
| VERDICT_UNSUPPORTED | 422 | 结论引用了不存在的证据 |
| VERDICT_POLICY_UNMET | 422 | 结论不满足策略 |
| STALE_GENERATION | 409 | 旧动作代际的回写 |
| STALE_HANG | 409 | 冲突已解除或过期 |
| BRIDGE_NOT_SUBSCRIBED | 409 | 未订阅就发指令 |
| TOOL_NOT_REGISTERED | 422 | 工具未注册 |
| RUN_TOOL_NOT_READ_ONLY | 403 | runTool 命令不是只读 |
| SIDE_EFFECT_UNDECLARED | 422 | 副作用声明比推导更宽 |
| COMPENSATION_UNEXECUTABLE | 422 | 补偿描述符不可执行 |
| COMPENSATION_TOOL_NOT_COMPENSATING | 422 | 补偿工具能力位不对 |
| COMPENSATION_TOOL_IN_FORWARD_PATH | 422 | 补偿工具出现在前向路径 |
| EVIDENCE_SOURCE_UNAVAILABLE | 422 | 没有强证据来源 |
| VERIFIER_TOOL_POLICY_MUTATING | 422 | verifier 工具策略可写 |
| WORKFLOW_NOT_FOUND | 404 | 流程不存在 |
| WORKFLOW_VERSION_NOT_FOUND | 404 | 流程版本不存在 |
| WORKFLOW_REVISION_CONFLICT | 409 | 草稿 revision 冲突 |
| WORKFLOW_VERSION_CONFLICT | 409 | 当前版本冲突 |
| WORKFLOW_VERSION_IMMUTABLE | 409 | 已发布版本被改写（触发器拒绝） |
| WORKFLOW_DRAFT_NOT_OPEN | 409 | 草稿已消费 |
| WORKFLOW_DRAFT_EXISTS | 409 | 已有草稿 |
| WORKFLOW_NOT_PUBLISHED | 409 | 从未发布 |
| WORKFLOW_VALIDATION_FAILED | 422 | 定义校验失败（details.errors[] 带 RFC 6901 path） |
| WORKFLOW_TITLE_INVALID | 422 | 节点标题非法 |
| WORKFLOW_NAME_INVALID | 422 | 流程名称非法 |
| WORKFLOW_DEFINITION_TOO_LARGE | 413 | 定义超过 1 MiB |
| WORKFLOW_EDGE_SELF_LOOP | 422 | 自环 |
| WORKFLOW_EDGE_DUPLICATE | 422 | 重复边 |
| WORKFLOW_DEFINITION_INVALID | 422 | 定义不可解析或顶层字段类型错 |
| WORKFLOW_NODE_ID_INVALID | 422 | 节点 id 格式非法 |
| WORKFLOW_NODE_ID_DUPLICATE | 422 | 节点 id 在版本内重复 |
| WORKFLOW_EDGE_ENDPOINT_MISSING | 422 | 边的端点不在本版本节点里 |
| WORKFLOW_LAYOUT_INVALID | 422 | 节点坐标不是 0–20000 整数 |
| WORKFLOW_NO_TRIGGER | 422 | 流程没有触发节点 |
| WORKFLOW_MULTIPLE_TRIGGERS | 422 | 流程有多个触发节点 |
| WORKFLOW_TRIGGER_HAS_INBOUND | 422 | 触发节点有入边 |
| WORKFLOW_TRIGGER_FANOUT | 422 | 触发节点出度不是 1 |
| WORKFLOW_NODE_FANOUT_INVALID | 422 | 节点出度不合规 |
| WORKFLOW_NODE_UNREACHABLE | 422 | 节点从入口不可达 |
| WORKFLOW_GRAPH_CYCLE | 422 | 全图有环 |
| WORKFLOW_BRANCH_ROUTE_INVALID | 422 | 分支出边缺路由或路由重复 |
| WORKFLOW_BRANCH_PRIORITY_DUPLICATE | 422 | 同源分支优先级重复 |
| WORKFLOW_BRANCH_DEFAULT_DUPLICATE | 422 | 默认路由多于一条 |
| NODE_NOT_SUPPORTED | 422 | 节点类型未注册 |
| WORKFLOW_NODE_CONFIG_INVALID | 422 | 节点必填配置缺失或不合法 |
| TOOL_NOT_ALLOWED | 422 | 工具不在节点允许集内 |
| PAYLOAD_SCHEMA_INVALID | 422 | 负载 schema 不合法 |
| WORKFLOW_SUBWORKFLOW_VERSION_MISSING | 422 | 子流程引用的版本不存在或未发布 |
| SUBWORKFLOW_DEPTH_EXCEEDED | 422 | 子流程层级超过上限 |
| BRANCH_AMBIGUOUS | 422 | 分支多命中 |
| SUBWORKFLOW_CYCLE | 422 | 子流程环 |
| MEMORY_BATCH_TOO_LARGE | 413 | 记忆批次超限 |
| MEMORY_PROPOSAL_INVALID | 422 | 提议格式非法 |
| MEMORY_BATCH_CONFLICT | 422 | 批次冲突 |
| MEMORY_BATCH_NOT_FOUND | 404 | 批次不存在 |
| MEMORY_EVAL_INVALID_OUTPUT | 502 | 评估输出非法 |
| MEMORY_EVAL_TIMEOUT | 504 | 评估超时 |
| MEMORY_EVAL_UNAVAILABLE | 503 | 评估端口不可用 |
| MEMORY_EVAL_DISABLED | 503 | 评估开关关闭 |
| MEMORY_BATCH_NOT_APPROVED | 409 | 批次未批准 |
| MEMORY_APPLY_BINDING_INVALID | 403 | 写入绑定不符 |
| MEMORY_APPLY_CONFLICT | 409 | 写入冲突 |
| MEMORY_APPLY_FAILED | 500 | 写入失败 |
| MEMORY_RUN_ACTIVE | 409 | 同源已有未终结记忆运行 |
| MEMORY_SOURCE_RUN_NOT_SETTLED | 409 | 源运行未收口 |
| MEMORY_WRITE_TOOL_FORBIDDEN | 422 | 前向路径出现记忆写工具 |

### 17.2 配置样例

    {
      "phase": "S1",
      "service": {"db_path": "storages/dsh-orchestra/orchestra.db", "busy_timeout_ms": 5000},
      "execution": {"concurrency": 3, "human_slots": 1, "startup_timeout_ms": 60000, "unknown_watchdog_ms": 120000, "verify_timeout_ms": 120000},
      "bridge": {"buffer_high_water_bytes": 4194304, "buffer_limit_bytes": 8388608},
      "retention": {"receipt_days": 7, "in_flight_timeout_minutes": 10},
      "memory": {"bridge_id": "memory-audit-v1", "eval_timeout_ms": 120000, "judge_content_limit": 4000, "approval_ttl_hours": 24}
    }

未知 phase、未知键、越界值一律拒绝启动；不用默认值掩盖配置错误。
写队列上限：S1 定值 1000 条，队列满返回 SERVICE_UNAVAILABLE（503）并记 warning，读路径不受阻塞；该值写进 G1 门记录，不进配置键（§16.3 已于 2026-11-13 定值）。
事件与证据保留期：§16.3 已于 2026-11-13 定值为不自动清理，artifact 过期只显示「已过保留期」，不删账本事实（规格 12.5）。

### 17.3 验收清单（提交前逐项勾）

- 规格结构完整：0 到 18 章齐全，无占位符。
- 设计稿 v44 的六段结论都能在本规格找到落点。
- 七条措辞澄清逐条落地。
- 状态机、终态集合、半态、时钟、Ga/Gr、applyReport 顺序、发布事务顺序与设计稿一致。
- 九节点每种的输入、输出、边界、失败模式都有。
- 记忆三条硬边界、四张表、三个端口、固定图、批准快照、部分写入对账都有。
- 读模型、六屏、视觉门槛、字号门槛都有。
- S1 到 S6、G1 到 G6、GateArtifact、回滚、三圈都有。
- 错误码、配置样例、测试矩阵、追溯表都有。
- 规格没有把未验证的实现写成已完成；没有把设计稿冻结的 v44 改成新结论。

## 18. 主脑用法、自治档位与执行纪律

本章回答三件事：装上插件之后谁在指挥（18.1）；跟你说话时任务在后台跑，怎么做到不打断（18.2）；什么时候必须停下来问你（18.3、18.4）。18.5 是执行纪律，18.6 是跟 superagent 的对照表，18.7 是面板照它七条原则落下来的差异，18.8 是对既有计划与总纲的增量。

### 18.1 任意会话都是主脑

- 插件装上之后，这个工作区里任何一个会话都默认带 orchestra.author 能力位。不需要先进面板、也不存在只有某个会话能派活的白名单。
- 能力位只决定它能发什么命令，不改变 §10.3 的红线：仍然不能写库、不能替人批准、不能绕过证据门。
- 面板与对话是同一份账本的两个视图：面板上点的是命令，对话里说的是命令意图，最终都落到同一个 operation_id 语义上，谁也不比谁高一级。
- 只有一件事与「是不是主脑」无关：这个任务允许跑多自主，由 18.3 的自治档位决定。

### 18.2 对话不被任务占用

这一条是硬要求：做任务不能把你和我的对话卡住。

- 接单三步在同一个回合内完成：立单（orchestration.start_run）→ 回执（operation_id 与「到哪看」）→ 放后台。回合结束就结束，不等运行。
- 超过 5 秒才有结果的动作一律转后台，回合里只给回执编号与查看位置（对齐 superagent 的 5 秒纪律）。
- 单个回合的对话答复上限 30 分钟；到点必须回一句「跑到哪、卡在哪」，不许占着对话干等（对齐 superagent 的 30 分钟后台上限）。
- 一次只问一件事：回合里最多带一个待确认问题，其余进收件箱，不叠在对话里催。
- 你插话优先于运行：任务跑到一半你开口，先把话接住（可引用当前运行摘要作答），再决定是否改任务；不要求运行先停下来才回话。
- 执行在 executor 子会话（§7.4 一任务一具名会话），对话会话只存目标、计划、产物引用（§10.5）；运行的重活不进对话上下文。
- 后台进度靠收件箱与任务卡呈现，不在对话里刷进度；健康态不主动汇报（18.5 安静纪律）。

### 18.3 自治档位（创建任务时定，默认自治）

orchestration.start_run 增两个可选字段：autonomy 与 escalations[]。

| autonomy | 含义 | 谁会收到 decision |
| --- | --- | --- |
| autonomous（默认） | 全部节点自主跑，只有硬性例外到人 | 不可逆动作前置审批（§5.6）、记忆写入审批（§9.6）、escalations 点名的情形 |
| assisted | 每个 decision 都可以到人，但服务仍按超时自动收口 | 全部 decision 可见可批，过期按默认动作 |
| supervised | 每个 decision 都必须人批，无默认动作 | 全部 decision，唯一会卡住的档位，必须显式选 |

- escalations 是名单不是开关：写「发布流程版本要问我」「改外部系统要问我」这类话，服务把它翻成对应 decision 的 confirm_required=true。
- 档位在任务上，不在节点上；单个节点要额外留口，用 approval 节点显式声明（§5.6），不改任务档位。
- 运行时改档位不追溯已生成的 decision；改档要留事件，回执里写明从哪条 decision 之后生效。
- 你的话优先于默认值：说「这个你自己定」就按 autonomous 起；说「这一步等我」就只把这一步抬成 confirm_required，不把整个任务降成 supervised。

### 18.4 独立审计与三种批准人

decision 增 approver 字段，取值三档：

| approver | 谁能收口 | 用在哪 |
| --- | --- | --- |
| agent:<role> | 带 orchestra.audit 能力位的独立审计智能体 | 技术性结论：测试过没过、证据齐不齐、产物合不合 schema |
| human | 人 | 对外承诺、不可逆外部写、花钱、发布给别人用的流程版本 |
| either | 先到先收口，留痕写明是谁 | 低风险确认，谁在谁批 |

- 独立审计智能体只能读证据、给结论、在 decision 上提交结论；不能改账本，也不能批准自己的产出（同一 agent 不得既产证据又批结论）。
- 人只收 approver=human 那一档；被审计智能体收口的 decision 在收件箱里留一条「已由审计通过」，可回看、不可代批。
- 现有 confirm_required 语义不变：它管「要不要停下来」，approver 管「谁来批」。

### 18.5 执行纪律

- 5 秒转后台：命令面 5 秒内没拿到回执就转后台，先把 operation_id 给人。
- 30 分钟上限：单回合答复不超过 30 分钟；超时必须给进度与卡点，不静默。
- 失败冻结：同一任务连续 3 次失败或同一节点 attempt 达上限，冻结自动重试并进收件箱；冻结不删账本，不自动放宽策略。
- 重试要说清三件事：上次做到哪、这次从哪接、哪些副作用还不确定。
- 并发与留位：并发上限由配置 max_parallel_nodes 决定，始终给人留一个执行位，面板与对话的命令不会被跑满的任务饿死。
- 安静纪律：健康态不占空间；只报需要人动作的事；一次一条；一次性网络错误不进收件箱。

### 18.6 与 superagent 的概念映射

| superagent | 本设计 | 差别 |
| --- | --- | --- |
| Trigger | run | 本设计的 run 固定 workflow_version，可重放 |
| Ticket | task | 本设计的 task 挂账本与账本序号，不是聚合体文档 |
| Assignment | node_run | 本设计一个 node_run 一个 executor，attempt 独立 |
| Report | report / 节点产出 | 本设计要求 evidence_ref，报告冲突走 uphold |
| Decision | decision | 本设计 decision 有 revision、CAS 与过期语义 |
| Mandate | 能力位（orchestra.author / operator / audit） | 本设计能力位由服务校验，不由 prompt 约束 |
| Source | 入口适配器 | 本设计先做对话与面板两个入口，外部 Source 留到后续 |

### 18.7 面板照 superagent 七条原则的差异

superagent 面板的原则（docs/005-panel.md）：只答三个问题、定义可检验、一处一概念、用域词、状态诚实、默认安静、控件一致。逐条对照本设计：

- 只答三个问题：本设计六屏已有三问的落点（任务列表答「要不要我」、任务详情答「这一件事的来龙去脉」、流程列表答「系统里有什么」），但抬头没有把三问写成一句话，缺一个「现在要不要我做」的结论行。
- 一处一概念：本设计把「待你决定」与「待核实」拆成两级页是对的；但运行状态在任务卡、详情页、收件箱三处各写一遍，需要统一由服务端给同一句话。
- 用域词：本设计 §8.6 已定「等你决定／待核实／这一步／这次运行」，面板实现里仍要逐字执行，不许回退成裁决、副作用、算子。
- 状态诚实：本设计 §12 已有 as_of_seq 与不折叠未观测态的要求；面板补一条硬规矩——凡是数字，必须等于点进去列表的长度。
- 默认安静：本设计缺「健康态不占空间」的显式条款，18.5 已补。
- 定义可检验：本设计 display_status 由服务端给全（§8.2），面板不许自己映射，这条比 superagent 更严。
- 控件一致：本设计 §8.6 的浅色主题、字号、对比度、无彩色装饰条已覆盖，剩下的靠实现逐条验。

### 18.8 对既有计划与总纲的增量

- S3 增一个 Task：orchestration.start_run 命令（建任务、固定 workflow_version、写 autonomy/escalations、幂等与回执、事件留痕、用例：默认档位、assisted 超时收口、supervised 不自动收口、改档不追溯）。
- S5 的任务读视图与任务卡增 autonomy 与 escalations 两个显示字段；待你决定卡片增 approver 与「已由审计通过」留痕。
- 总纲 §3 目录树补 src/service/commands/start-run.ts；§5 批次表 S3 任务数由 14 改为 15。

