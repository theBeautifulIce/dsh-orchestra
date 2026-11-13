# GLOSSARY

> dsh-orchestra 的领域词汇表（single-context：一仓库一份，术语与规格同源）。
> 初稿 v1，供评审；规格为准：docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md（v1.3）。
> 改词先改这里，再回头改规格与计划；架构决定记 docs/adr/。

## 编排内核

| 词 | 含义 |
| --- | --- |
| 编排账本 | SQLite 单库，唯一事实源，只追加不改写 |
| 运行（run） | 一次流程执行；v1 一任务同时只允许一条活跃运行 |
| 节点作业（node_run） | 运行里一个节点的执行记录；与运行最多一个终态（不变量 I1） |
| 流程（workflow） | 可发布、可回滚的流程定义 |
| 流程版本（workflow_version） | 流程定义的一次发布快照；在途运行固定旧版本 |
| 决定（decision） | 需要人拍板的事项；三种批准人分别对应自动化档位 |
| 回执（receipt） | 命令执行结果，按 operation_id 查回 |
| 证据（evidence） | 支撑终态与门结论的物证，统一 sha256 |
| 门（gate） | 批次放行关卡，产出 docs/gates/G<n>.md 与 GateArtifact |
| 租约（lease） | 节点作业的执行时限；过期后的迟到上报一律被拒 |
| 代次（epoch） | 服务实例代号；事务以 service_meta.instance_epoch 校验，跨代写入被拒 |
| 迁移（migration） | 带 CAS 的库结构变更；编号分段 001/002/010-019/020-029/030-039/040-049 |
| 阶段（phase） | orchestra.config.json 的 phase 开关，决定启用哪些批次能力 |
| 圈（R0/R1/R2） | 放行半径：R0 仅本地自用，R1 白名单工作区，R2 开放 |

## 主脑与执行

| 词 | 含义 |
| --- | --- |
| 主脑（superagent） | 任意会话都可以担任的编排大脑；只给目标与约束，不替节点做最终决定 |
| 执行器（executor） | 在宿主内跑节点正文的子智能体；只拿该节点的输入与授权 |
| 桥（bridge） | 宿主侧与编排服务之间的调用与事件通道，方法集见规格 §7.2 |
| 具名会话 | 一任务一具名会话；插件重载按 fromSeq 重放事件续跑 |

## 面板与记忆

| 词 | 含义 |
| --- | --- |
| 控制面 | 面板写操作走的命令信封；读操作只经读模型 |
| 读模型 | 账本投影出的七种视图：TaskSummary / RunSummary / WorkflowView / NodeRunView / DecisionView / EventView / UnverifiedEffectView |
| 未观测副作用 | 效果不确定且不可逆的动作；记 indeterminate_side_effect，运行转 paused |
| 记忆通道 | 记忆提议→评估→审批→写入→回执的固定链，唯一写入口是 memory.apply_governed |

## 术语纪律

- 裁决、仲裁一律不用，写成决定与批准人。
- 未观测到的东西有自己的名字，不许折叠进正常档。
- 状态词只从规格枚举里取，不自造同义词。