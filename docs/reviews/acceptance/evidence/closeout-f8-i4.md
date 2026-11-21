# F8 裁决出口与 I4 终态证据复验

各行按 [裁决出口和迁移规则](../../../orchestra-design-draft.md#L449) 与 [终态证据表](../../../orchestra-design-draft.md#L2201) 取组合。合同在本机随机端口启动 S6，使用独立合成账本和宿主认证夹具。

## F8 裁决出口

| 卡种 | 正式或现行有效组合 | 实测及缺口 |
| --- | --- | --- |
| `pre_execution` | `approved` → `queued`（M-40）；`rejected` → `failed`（M-41）；到期按审批配置收口 | 真实 HTTP 验证批准、驳回、旧修订、同回执并发、跨主体重放拒绝及重启重放。独立审批合同覆盖到期。 [裁决矩阵](../../../../tests/contract/decision-exit-matrix.spec.ts) · [独立审批](../../../../tests/contract/workflow-approval-node.spec.ts) |
| `action_overrun` | `continue_wait` → 停止中、限三次续期且 Gr+1（M-34）；核实已发生 → `done`（M-33）；`abandon` → `abandoned_unverified`（M-36） | 带宿主核验证据的 `approved` 可走现行效果结算写入，缺证据保持原卡和节点。`continue_wait` 仅有内部卡片续修订功能，公开入口继续阻断。尚缺原工具获准时限、当前尝试授权和跨恢复计数的生产绑定。普通放弃与对应状态出口仍待实现。 [证据裁决](../../../../tests/contract/routes.spec.ts) · [内部续修订](../../../../tests/integration/decisions.spec.ts) |
| `verify_human` | 副作用已发生 → `done`（M-33／M-51）；未发生 → 根据重跑条件 `superseded`／`failed`（M-52）；放弃（M-53） | 现行 `approved` 包含 `effect_verdict` 和证据 ID，验证并记录副作用结算。普通出口的节点迁移和原十值完整接线仍缺。公开入口缺证据的批准保持原卡和节点。 [证据裁决](../../../../tests/contract/routes.spec.ts) · [缺证据对照](../../../../tests/contract/decision-exit-matrix.spec.ts) |
| `abandon_ack` | 普通放弃后人签字；驳回可迁回 `stopping`（M-37）；签字与已无副作用是独立事实 | 普通无绑定卡拒绝关闭。记忆对账有专用证据与权限路径，普通运行的签字和恢复出口仍缺。 [普通卡拒绝](../../../../tests/contract/decision-exit-matrix.spec.ts) · [记忆裁决命令](../../../../src/service/commands/memory-recovery.ts) |
| `audit_result` | `approved`／`rejected`；关联记忆批次时走批次快照和试用圈权限 | 普通审计卡真实 HTTP 批准、驳回、幂等及绑定身份通过。关联批次有独立确认与试用圈对照。 [裁决矩阵](../../../../tests/contract/decision-exit-matrix.spec.ts) · [记忆批准对照](../../../../tests/contract/decision-memory-confirmation.spec.ts) |
| `rule_ambiguous` | 与实际阻塞分支绑定时选择已发布目标，或驳回收口失败 | 发布与真实分支执行合同覆盖授权收口。无运行分支绑定的普通旧卡保持待办。 [生产分支](../../../../tests/contract/workflow-branch-node.spec.ts) · [旧卡对照](../../../../tests/contract/decision-exit-matrix.spec.ts) |
| `startup_unknown` | `confirm_not_started`、`confirm_started`、`confirm_started_attested`、`continue_tracking`、`abandon`；出口受启动观测与宿主状态约束 | 真实 HTTP 逐值复验。前两种、续跟和放弃均保持未决，人证启动值被现行请求模式拒绝。普通 UI 缺少宿主状态核验与原裁决收口能力。 [启动待决对照](../../../../tests/contract/decision-exit-matrix.spec.ts) |
| `report_contradicted` | `uphold_report`（M-59）；`uphold_decision`（M-60）；24 小时只升级 | 快照绑定当前修订、报告摘要、尝试、动作代次和原裁决。采纳正反证据、事务回滚和重复操作通过。维持原裁决在已有闭合的启动否定裁决且同一 Gr 时可用，纯步骤新建一次尝试，不可安全重跑的步骤落失败并保留效果未核实记录。两路都保留原裁决。只登记报告 ID 的历史卡保持待办。普通启动裁决的创建仍属前行缺口。 [冲突真实 HTTP](../../../../tests/contract/report-conflict-approval.spec.ts) · [审批中心提交](../../../../tests/client/decision-panel.spec.tsx) |

M-60 合同以已经裁完的 D1 历史记录为输入。它在合成账本准备由服务签名的 D1 节点链事件与闭合状态，随后由真实 S6 HTTP 完成报告登记、卡片升级、重启读取、人工确认与落库。取消先成为运行事实时，维持原裁决被拒且没有建立新尝试。对照通过通用账本入口写入同名全局裁决事件，报告仍无法挂上人工冲突卡。

普通效果结算命令保留当前节点状态。M-33、M-51、M-52 和 M-53 的节点迁移还需要独立的执行器停止事实与动作策略。其中 M-51 至 M-53 现有执行用法依赖记忆写入围栏与逐条对账证明。普通执行节点尚无对应的停止时刻与证据读取契约。

## I4 同一合同的终态证据

| 运行终态 | 输入与实际证据 | 判定 |
| --- | --- | --- |
| `succeeded` | 不可逆 `done` 同尝试的 `tool_finished`、宿主业务证明、受管产物字节和固定工作流要求的内容哈希；`unverified_resolutions.resolution_basis=evidence` 指向执行证据；账本写唯一 `run.terminal` | 所测强证据组合通过 |
| `succeeded_with_unverified` | 不可逆 `done` 的报告、工具痕迹和产物哈希一致，业务效果未单独结算；终态事件保留未核节点 | 所测待核分支通过 |
| `failed` | 纯步骤失败报告对齐同尝试的非零退出工具执行与事件；终态事件保留失败节点 | 所测失败证据通过 |
| `failed_with_unverified` | 不可逆 `failed` 与 `timeout` 分别经过非零退出、工具执行和对应事件。超时准备了 deadline、取消结果以及最后心跳。运行事件同时保留失败与未核节点 | 两个所测分支通过 |
| `orphaned` | 维护入口接收显式执行器失联通知，写 `recovery.executor_lost`；旧节点保留最后心跳及执行器身份；终态事件列出孤儿节点 | 所测有失联证据的分支通过 |
| `cancelled` | HTTP 宿主认证取消，未启动纯节点作废；运行事件分别记录取消状态与业务结果 | 所测取消分支通过 |

所有上报用例先提交空证据、弱回执与伪造命令摘要，完成用例另替换产物本体。服务逐次拒绝，节点不迁移，运行保持进行中。阳性收口后验证节点链头与哈希链，重复请求保留唯一终态事件。证据脚手架记录了报告以前的工具痕迹、已核实效果及超时现场。 [终态证据矩阵](../../../../tests/contract/terminal-evidence-matrix.spec.ts)
