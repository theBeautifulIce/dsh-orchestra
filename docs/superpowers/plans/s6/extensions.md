# 产品任务与既有扩展的 S6 验收

[返回派工入口](../2026-11-19-s6-execution.md)。本页有两项独立委派。X01 是此前明确顺延的新用户任务，可独立开发和交付；X02 是已有能力的发布回归。两者的结果分别登记，原 G5 的 73 项和 G6 §11.2 固定判定语保持各自口径。

## X01 · 在目标 DSH 找到本次运行和正确成果

**目标与输入。** 让第一次使用的人从“安装启用 → 写目标 → 确认计划 → 打开本次运行 → 读取成果”走通。读[宿主装配记录](../../../reviews/2026-11-19-dsh-model-and-product-acceptance.md)、[受控返工设计](../../../design/rework-orchestration.md)和[产品路线](../2026-11-17-product-roadmap.md)。先取实际 DSH、插件、候选包及受信配置版本；使用独立 profile、工作区与 SQLite 库。X01 的代码若拟随本次包交付，须在 T17 冻结**之前**合并和回归；单独交付则保持独立候选。

| 子单 | 所有权与动作 | 完成证据与失败对照 |
| --- | --- | --- |
| X01a 真实启用 | 先只读检查 `package.json`、`cordis.patch.yml`、宿主的 `serveDshOrchestra` 和面板注册来源。用干净 profile 从目标用户的正常入口安装、启用，记录谁提供服务、侧栏、受信模型、工具与授权。对照 T17 的包和安装说明。若外置装配是部署约定，验证并写清步骤；若缺接线，定位第一处失败，凭已存在的受信入口提出最小接线差异，先向 T17 所有者交接。 | 保存真实宿主/包版本、启用步骤、日志、页面及能力清单；再去掉必需模型做对照，界面能说明缺项且无越权派发。探针手动装配、回环模型、组件夹具分别标注。付费推理、测试凭证、硬编码模型均不作安装前提。 |
| X01b 运行导航 | 前置 X01a 已知正常路径或已有可信契约。以 `src/client/panel/task-plan-form.tsx`、`task-start-form.tsx`、`tasks-screen.tsx`、`app.tsx` 为写入域。当前两个表单成功后主要刷新列表；详情已有接收 runId 的导航。核对 `src/client/api/task-commands.ts`、服务响应和重放回执实际返回的 ID，再将它们传至“查看本次运行”。确认前不显示成功；响应未知先走现有 operation_id 回查或幂等重放。 | 自然语言确认、从流程启动各测一次。列表筛“已成功”后新建运行中任务，准备两个同名历史任务，点击必须打开新 task_id/run_id，返回后原筛选仍在。模拟成功响应丢失，再请求只生成一个 run；缺可信模型时无成功链接。扩展现有 `tests/client/panel-screens.spec.tsx`、`tests/contract/task-planning.spec.ts` 或同层相邻用例。 |
| X01c 交付验收 | 消费 a/b 的安装与导航。以一个有客观完成条件的小目标为例，如整理一份受控样本并交付 `summary.md`。分别走可复用流程和无合适候选的 task_local 分支。核对目标、验收条件、固定版本、回执和精确成果；沿用既有 `artifact-content.tsx` 与受管内容 API。 | 验收者从新用户页面记录 task_id/run_id、artifact_id、哈希、受管字节和预览/下载结果。同名不同版本、A 慢响应晚于 B、只有元数据无内容、内容已过期各留结果。前两者只能展示所选版本；后两者给出相应不可用/待核验原因。run 已成功而目标缺证据时仍显示待核验。 |

**执行与交回。** 基础回归用 `pnpm exec vitest run tests/client/panel-screens.spec.tsx tests/client/artifact-content.spec.tsx tests/contract/artifact-content.spec.ts tests/contract/task-planning.spec.ts`。给 T17 的材料包含来自实际目标宿主的安装及两次启动回执、截图或交互录像、同 run 的客观字节校验；夹具可覆盖负例。只有组件测试、仅有源码探针或缺真实目标 DSH，分别将 X01a/c 的真实验收列为待实跑。若发现需要新的系统权限或改变规划契约，记录具体调用、所缺数据和用户影响，由主代理裁决后再扩大写域。

## X02 · 模型、协作、返工与记忆回归

**目标与边界。** S6 改了队列、持久化、权限、恢复或包装配后，检验原工作流仍能按固定版本运行，并把可核验成果交给用户。每个子单可交一名执行者，先在既有用例和独立 profile 跑验证。生产修复回归属卡，S6 主代理确认写入所有权后再动相应模块。

| 子单与责任卡 | 执行动作 | 必须能观察到的正反结果 |
| --- | --- | --- |
| X02a 任务与模型，T07/T10/T17 | 取一个与目标匹配的已发布版本、一个 task_local 候选；走简报、质量评估、确认与派发。测试普通入口与受信 task_local 根入口的 owner、固定版本和原子消费。用服务已核准的三档模型，变更配置后读取下一次派发的实际模型，记录 attempt 与派发代次；重启或定时/事件触发沿原受信映射。 | 一次确认只建一个 run；旧定义不可改写在途 run。指定模型退清单、模型回读不一致、缺可信 resolver、未批准的工具必须阻止对应能力。设置变更不扩大工具权限。核对 `tests/integration/model-routing-settings.spec.ts`、`task-plan-dispatch-after-disable.spec.ts` 和 `task-triggers.spec.ts`。 |
| X02b 协作与生命周期，T03/T04/T10/T12 | 复用现有桥游标、落账再 ACK、曾授权的目标范围和接收者独立核验。重复投递一次、重启一次、撤去所需授权一次。按原发现串起授权、送达、接手、核验、结果和主理人采纳。 | 核验方自己取得证据，重投不重复建工作单元。桥层 ACK、接收方接受、采纳和最终业务验收四个结果可分别核对。过期、越界、旧 attempt 或旧代次不得推进。入口见 `tests/integration/collaboration.spec.ts` 和 `scripts/dsh-collaboration-probe.mjs`。 |
| X02c 返工与版本，T05/T06/T14 | 按 R01–R20 的现有映射定位。正常执行 Agent、审核 Agent 与人工分别反馈到精确版本；演练简单定向返工、主脑提议的局部规划、终态前人工留验或撤销。重启后重放未决命令；审批时切换同名成果 A/B，制造旧预览晚返回。 | 审批载荷与画面对应同一 artifact_id/hash；旧 attempt、旧字节、旧证据和已消费输入可追溯。已批准的局部修改只作用于允许范围，不会改变已发布定义或提升工具权限。新验收 attempt 独立取证，reject_final 走原取消与结算流程。[R01–R20 及 DSH 探针](../../../design/rework-orchestration.md) |
| X02d 副作用与真实插件，T03/T05/T10/T11 | 对 `evidence`、`decision`、`verified_none` 三种互斥结算走实际服务入口，观察 CAS、账本、读模型和同一 run 的面板。沿用真实 Go 插件恢复，用同一个 source_run、memory_run、batch、attempt 和外部条目 ID 追踪部分写入、对账、放弃与人工签认。 | 人工声明不替代系统工具痕迹；不确定时禁止重写；部分写入仅在对账后进入对应状态，签认后核对 memory_run 的终态。未写项未被重试，已写项保留。正例外再测陈旧 revision、错误批次或快照和拒绝后零新增。归档前按 T11 脱敏。[副作用结算附录](../../specs/2026-11-17-s5-effect-resolution-addendum.md) · [真实插件恢复记录](../../../reviews/S5-real-memory-plugin-recovery.md) |

**操作与验收。** 先运行 `pnpm exec vitest run tests/integration/collaboration.spec.ts tests/integration/rework-process-restart.spec.ts tests/integration/rework-runtime.spec.ts tests/integration/effect-resolution.spec.ts tests/client/rework-panel.spec.tsx tests/client/memory-recovery-acceptance.spec.tsx` 及上表所列本卡用例。真实 DSH 联验按[装配步骤](../../../reviews/2026-11-19-dsh-model-and-product-acceptance.md)与 R01–R20 文档，先构建再对实际发现的 DSH CLI 运行 `scripts/dsh-model-routing-probe.mjs`、`scripts/dsh-collaboration-probe.mjs`、`scripts/dsh-rework-probe.mjs`。记录实际版本、命中用例、进程/宿主、回环模型与真实组件边界、退出码、回执与数据来源。升级时对比同一组固定输入的升级前后结果。失败项归到对应 T 卡并明确是否影响 G6 的哪条必过项。

[M0–M5 路线](../2026-11-17-product-roadmap.md)中已交付的 M1/M2/M3a/M3b 由上述卡验证。M3c 预授权、M4 通用写工具策略、M5 预算调度与多工作区保留原有启用条件；现阶段不派这些功能的实现。工作流共享黑板仍是[独立提案](../../specs/2026-11-12-run-shared-context-addendum.md)。已有协调、证据、授权和调度的语义沿用当前生产入口。
