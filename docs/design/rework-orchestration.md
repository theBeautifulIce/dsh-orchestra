# 跨节点反馈、定向返工与运行级局部规划

实施基线为 `bd15daa`。本轮保持发布 Workflow 的固定版本，增加同一 Run 内的反馈、修订、验收及受限局部规划。下面描述当前实现；最终提交 SHA、全量检查和独立审计结果由本轮交付记录补齐，不以局部测试代替签门。

## 运行协议与状态所有权

`Rework Coordinator` 是确定性服务，写入复用单写者事务、UUIDv7 操作号、CAS、账本和幂等回执。人工身份来自认证宿主；Agent 身份来自宿主绑定的 `node_run_id + attempt + action_generation`，请求体不能选择其他主体。普通执行 Agent、审核 Agent 使用同一个 `orchestra_rework` 工具和依赖权限规则。主脑没有数据库写权或派发权。

目标必须是当前已完成的 Agent attempt，原成果必须在同一运行内、由该 attempt 登记且实际字节与 SHA-256 一致。Agent 反馈还须证明当前主体与上游存在依赖，并附自己的可信执行证据。独立核验请求不能授权重启；关联的核验依据须经过已确认、已采纳和同运行来源检查。

请求的实际生命周期为：`proposed / needs_human_approval → scheduled → awaiting_review → closed`，另有 `escalated / declined / cancelled`。自动授权是请求事务中的确定性处理；`authorized` 不作为独立长期排队点。`request_changes` 保存当前精确版本的意见，增加轮数并回到 `proposed`，下一轮需明确授权。默认三轮、三个修订执行额度；请求有持久过期时间。达到次数、预算、执行安全或产物完整性边界时保留围栏并升级。

- `targeted_revision`：保留原成果，传入原文件、修改意见、保留要求和验收要求；安全边界明确时允许自动授权。同一 attempt 有多个成果时，不自动声称已完整保留其他成果。
- `rerun_node`：同样创建新 attempt，要求负责人显式授权；只执行当前节点及必要受影响部分。
- `replan_subgraph`：主脑只提交候选。负责人按提案哈希和请求修订批准后，服务重新校验范围、状态、纯度、预算、依赖无环和授权快照。

已完成 A1 不改回 queued。A2 通过专用接班协议创建，A1 的 done、产物、报告和证据保留。已消费旧输入的活动下游被围栏，旧执行主体不能再提交有效完成。A2 完成后只为原反馈角色准备新的候选验收 attempt；其他受影响路径继续等待。该角色读取 A2、取得本轮新证据并验收后，Orchestra 才恢复其他路径。执行原始目标、职责和输入简报持久化，修订不依赖旧 DSH 会话存活。

## 消费版本、放行与运行收口

`input_snapshots` 标记某 attempt 已固定输入；`artifact_consumptions` 不可变地绑定上游 attempt、artifact 和 hash。影响分析优先使用实际消费关系。旧数据没有快照时按固定拓扑及已批准运行依赖保守保护，不把未知消费当成未消费；无关分支保持原 attempt。

Dispatcher、直接拿租约、运行报告和 Run 收口均检查返工围栏。未解决反馈、候选成果待验收或人工留验会阻止成功收口。Run 取消后禁止继续授权和派发，维护恢复将开放请求转为 cancelled。维护与启动恢复读取持久请求，创建过的后继 attempt 不重复创建。模型超时、缺失产物或损坏修订字节会留下可查询原因，不能把异常静默变成成功。

纯度不是 Agent 自报事实：发布投影保留已签名的 `config.side_effect_policy`，启动及子运行准入以真实工具注册表核验有效 allow 清单。返工拒绝有未确认外部副作用或不满足 pure 边界的执行。显式 `reject_final` 由负责人触发现有取消传播和副作用结算路径，不把质量不满意伪装成执行失败或已安全停止。

## 受限的局部拓扑能力

候选方案允许 `changes:[{node_id,instruction}]`、`preserved_node_ids`、`additional_edges:[{from,to}]`，以及最多两个 `insert_steps:[{node_id,before_node_id,instruction}]`。插入步骤只能放在受影响、未绑定输入、仍 queued 的原始 pure Agent 步骤之前；`rw_` 名称有严格格式。新步骤继承指定原始角色的已签名工具、模型和契约，通过原 Dispatcher、租约、报告和证据核验执行。服务持久保存原角色、请求、提案哈希及固定定义哈希，并在重启后重新校验来源。

这是运行级的已批准依赖扩展，不改写发布版本，也不把反馈画成固定 DAG 反向边。当前没有任意删除步骤、替换任意角色、任意改模型/工具或通用图编辑能力。新增边仍须无环并遵守受影响范围。新增步骤等待返工验收通过后执行；超出这些约束的方案拒绝并留待人工处理。

## HTTP、Agent 工具与面板

所有写接口带 `operation_id`；请求使用目标节点 `expected_revision`，审核和规划使用返工请求 `expected_revision`。成果验收需 `artifact_id + artifact_hash` 精确匹配本轮修订；留验接口使用 `artifact_id + sha256`。

| 接口 | 当前用途 |
| --- | --- |
| `GET /v1/rework?run_id=…`、`GET /v1/rework/get?request_id=…` | 负责人范围内的请求及 attempts/reviews/impacts；detail 在 `data.item` |
| `POST /v1/rework/request` | 原成果、意见、期望结果、保留要求、范围和证据；可附受控核验来源 |
| `POST /v1/rework/review` | `authorize / reject / accept / request_changes / escalate / reject_final`；未执行请求可拒绝，执行过的修订不能靠 decline 解除保护 |
| `POST /v1/rework/plan`、`GET /v1/rework/plan?request_id=…` | 生成、读取无执行权限的候选；写命令保留原操作号回执 |
| `POST /v1/rework/plan/approve` | 精确 `plan_hash` 的负责人批准 |
| `GET /v1/rework/topology?run_id=…` | 已批准新增边/步骤、反馈目标/状态/轮次、受影响 logical node IDs |
| `POST /v1/rework/inspect`、`GET /v1/rework/inspections?run_id=…` | 主脑检查精确版本的完整 UTF-8 文本；PASS 只记录意见，不代替人工验收、不解除留验；缺陷转统一反馈 |
| `POST /v1/rework/hold`、`GET /v1/rework/holds?run_id=…` | 结束前留验、精确接受当前成果、withdraw 撤销留验；撤销不是验收通过 |

`orchestra_rework` 提供 `publish/read/inbox/get/request/accept/request_changes/escalate`。publish 只登记本 attempt 的 UTF-8 文本，不接受任意宿主路径；read 只读取本执行已绑定的输入或已授权修订原成果。反馈上下文包含原目标与职责、版本引用、修改意见、保留要求、轮次/预算、候选验收和获批局部指令。写命令的主体仍由宿主绑定。

审批中心的成果卡与执行前批准卡分开。用户可输入意见、选择初次修改范围、授权、再次验收、升级及显式终止；可对照旧/新产物、逐行预览比较、查询版本/轮次/审核人历史。行比较按行号展示，并提示预览截断，不宣称语义等价或完整文档 diff。任务详情和任务流程图将运行拓扑合入真实画布：新增步骤、蓝色虚线依赖、最新有效 attempt、来源角色、反馈轮次与等待返工标记可直接查看。步骤列表与图共享 attempt 选择，HTTP 返回顺序不能让旧 attempt 覆盖新 attempt。已发布 Workflow 编辑画布仍显示固定版本。

连接能力来自 `/health` 的 `rework_enabled`、`rework_planner_enabled`。结果不明时客户端只查同一个操作号回执，并锁住该次动作；不会自动换号重发。模型检查仅接收不超过 64 KiB 的完整 UTF-8 文本，不读取截断摘要冒充完整质量审核。

## 数据迁移与回滚

新增迁移按现有编号链执行：

| 迁移 | 持久事实 |
| --- | --- |
| 047 | `rework_requests / rework_attempts / rework_reviews`，活动目标唯一及历史不可变约束 |
| 048 | `input_snapshots / artifact_consumptions / rework_impacts` |
| 049 | 局部规划候选、人工交付留验 |
| 050 | 已批准运行级新增依赖 |
| 051 | 主脑成果检查意见及来源 |
| 052 | 新增步骤的精确批准与角色来源 |
| 053 | 原始执行目标、职责与输入简报 |
| 054 | 已由运行级派发授权的手动运行规格，绑定固定定义、原输入和工具登记，可在重启后校验 |

部署前备份数据库及受管成果。回退前停止接收新反馈、处理或可靠取消开放请求并停止服务。含未解决返工的账本不可交给不理解版本围栏的旧服务继续派发；本轮没有提供破坏性 down migration。已有成果不补造内容，旧消费历史未知时保守保护。

## R01–R20 证据映射

以下为真实命名测试的定位。集成测试使用持久 SQLite 与服务命令，部分初始化使用受控 fixture；原生 DSH 探针额外覆盖完整生产桥和工具执行。表内说明覆盖边界，最终执行结果以本轮测试日志为准。

| 编号 | 测试文件与实际用例名 | 证明范围 |
| --- | --- | --- |
| R01 | `rework-coordinator.spec.ts` — `human targeted revision preserves v1 and old terminal attempt, binds exact acceptance and replays receipts` | 人工反馈持久化、修订和验收 |
| R02 | 同文件 — `agent feedback requires same-run dependency, bound generation and strong evidence; fresh reviewer accepts v2` | 普通执行 Agent 在依赖范围内反馈 |
| R03 | 同 R02；`dsh-rework-probe.mjs` B2 | 审核角色使用同一绑定工具与验收协议；没有另设可绕过权限的审核 Agent 特权 |
| R04 | 同 R01；`rework-runtime.spec.ts` — `preserves done history, invalidates the diamond and leaves unrelated attempts intact` | 保留 done 并创建后继 attempt |
| R05 | 同 R01；原生探针旧 A 成果字节断言 | 原成果及原 attempt 保留，新成果精确登记 |
| R06 | 同 R02；原生探针 B2 accept → C1 | 新版本验收及下游恢复 |
| R07 | `rework-coordinator.spec.ts` — `repeated changes retain attempts, stop at round budget, and never release unresolved inputs`；runtime — `creates a new reviewer per revision round without reusing the invalidated session` | 多轮历史、新验收会话 |
| R08 | 同 R07 | 三轮后升级，仍保留依赖保护 |
| R09 | coordinator — `unsafe effects fail closed, request duplicates cannot create extra attempts, and recovery survives restart`；`rerun authorization is owner-bound CAS and rejects stale target revisions or hashes` | 单写事务下活动目标去重和过期授权；不是多进程并发压力测试 |
| R10 | 同 R01；panel — `recovers an applied receipt after one ambiguous POST without sending again` | 持久命令重放及丢响应恢复 |
| R11 | runtime — `preserves done history, invalidates the diamond and leaves unrelated attempts intact` | 菱形消费关系及影响范围 |
| R12 | runtime — `fences stale running completion and resumes the requester in a fresh candidate-review session` | 旧输入执行无法完成，新 attempt 验收 |
| R13 | coordinator — `run cancellation blocks late authorization and recovery cancels unresolved feedback`；runtime — `cancellation blocks authorizing and direct lease acquisition` | 取消后拒绝授权与拿租约 |
| R14 | `rework-process-restart.spec.ts` 强制终止授权事务已提交的写进程，在新 epoch 重放请求和授权；`rework-manual-dispatch.spec.ts` 重开服务并执行已授权后继 | 回执逐字一致，唯一新 attempt，旧成果、下游围栏和账本链均保留 |
| R15 | 同 R09；runtime — `refuses unbounded legacy topology and preserves multi-artifact sources` | 副作用及无法界定的成果保护 |
| R16 | 同 R02 | 无关节点、旧代际和无可信证据被拒绝 |
| R17 | planning — `validates the local planner scope before writes, pins approval, and injects only the approved instructions`；`adds a scoped check before an affected step, preserves pinned topology and rejects cyclic or privileged changes` | 非法主脑方案不获得执行权 |
| R18 | runtime — `preserves done history, invalidates the diamond and leaves unrelated attempts intact` 中开放返工的 closeRun 断言；planning — `holds a final delivery before close, rejects stale bytes and closes on explicit acceptance`；原生探针人工留验断言 | 开放返工和待验收均不成功收口 |
| R19 | 同 R04/R11；runtime — `keeps immutable actual snapshots across replay and protects legacy unknown consumers` | 无关 attempt 保持，未知消费保守处理 |
| R20 | 同 R09 的 stale revision/hash；inspection — `parallel inspection of one version is bounded and snapshot mutation during a call prevents persistence` | CAS 与异步模型期间快照变化拒绝写入 |

负责人终止与过期未执行反馈另由 coordinator 的 `expired unstarted feedback can be declined, while executed escalation requires explicit owner run termination` 定位；是否已通过以最终测试日志为准。

文件均位于 `tests/integration/`，panel 用例在 `tests/client/rework-panel.spec.tsx`。另外 `tests/client/runtime-topology.spec.tsx` 覆盖真实查询契约到任务两处画布、步骤/图同选新 attempt、固定编辑图不被修改、拓扑不可用诊断；`tests/integration/rework-extra-steps.spec.ts` 的 `dispatches an actually approved inserted step through inherited signed tools and report verification` 验证新步骤实际进入执行器，而非仅把候选文字展示为已执行。

## 原生 DSH 复现与已观察证据

在安装 DSH CLI 的 Windows 主机运行：

```powershell
pnpm build
$dshBin = Join-Path (npm root -g) '@deepseek-ai/dsh/lib/bin.js'
node --no-warnings scripts/dsh-rework-probe.mjs $dshBin
```

探针创建独立临时库、独立 DSH 配置和 localhost OpenAI 兼容 fixture provider，不访问用户正在运行的 DSH 会话。fixture 决定模型输出，用真实 DSH 子会话、真实工具桥、只读命令证据和生产 HTTP/命令链核对编排；它不证明商业模型在开放任务中的判断质量。Windows 沙箱若限制 localhost，需要正常申请该回环测试权限，不能关闭校验绕过。

2026-11-19 已观察到运行 `run_01a1f358d0a17126bb2f7c436fe31df9` 成功：A1 done → B1 反馈且被 superseded → A2 done → B2 读取修订数据、取得新证据并 accept → C1 报告 → 人工反馈 → C2 修改 → 人工 accept → 解除精确版本留验 → succeeded。六个独立 DSH 会话有六条实际模型使用观察。Agent 请求 `rework_01a1f358-d260-7d30-9d84-cdc812036a51`，人工请求 `rework_01a1f358-da6e-7846-8a6e-e648ef742b49`。旧数据内容和 C2 保留第一、二章均有精确字节断言。

本机证据目录 `C:/Users/ASUS/AppData/Local/Temp/orchestra-dsh-rework-NKz5xm` 包含当次 SQLite 和 DSH 会话，属于可清理临时证据，不保证部署主机存在。脚本可复跑生成自己的操作号和证据。此成功记录发生于随后拓扑 UI、检查和终止补充之前，不能代替最终候选的全量复测或独立审计。

面板烟测：在未结束运行的详情先选最终报告角色设留验；待成果出现后选精确版本并提出意见；确认审批中心独立卡片、旧/新预览及历史；修订完成后明确验收，再接受留验成果。对于局部规划，先检查候选新增步骤/依赖与来源角色，批准后到任务「编排」和流程图核对实际新增节点、最新 attempt、依赖线和待验收标记；发布 Workflow 固定版本画布不得被改写。主脑 PASS 只显示检查意见，不能自动接受人工留验。

手动运行如需自动续跑，应通过运行级派发提交原角色的授权规格。服务重启后，原调度器按固定定义、输入、工具和权限校验这些规格。单节点调试入口保持逐步控制。局部方案按修改角色与受影响执行尝试中的较大数量，加上插入步骤数扣除额度。一次批准只扣一次。
