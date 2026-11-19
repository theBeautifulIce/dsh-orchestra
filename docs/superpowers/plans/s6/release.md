# T12–T17 发布候选、双工件与试用

[返回派工入口](../2026-11-19-s6-execution.md)。下列命令供 2026-11-20 起按卡执行。

### 交接顺序与停点

1. **开发与演练准备。** T12、T13 开发流程与收口；T14–T16 准备升级、值班、试用；T17 先完成门检查器、候选包与安装冒烟入口。T01–T11 的生产路径、证据口径及 I1–I10 纳入候选；X02 按受影响的既有能力提供回归。脚本测试夹具、预签拒绝、确定性时钟和 dry-run 仅记作开发证据。
2. **冻结候选 C。** 从正式已签基线进入 S6。冻结源码、测试、故障与测量脚本、工具组登记、evidence ID 映射、迁移、配置、包清单、README、试用手册及核验器。登记完整 C、基线、改动范围、宿主版本、安装工件摘要及工作区边界。冻结后从 C 构建并保留同一 .tgz，校验安装，运行 G-01–G-16、控制面/事件延迟测量、24h 浸泡、负载升级回滚和值班演练，并完成 R0 连续 3 天。可在资源隔离且负载口径符合时并行采样；24h 和 3 天分别计算。应保留失败记录，修代码或变更影响验收的候选输入后重新冻结、重做受影响的验收，连续观察须覆盖最终候选。
3. **先取得事实，再出审计报告。** 独立人员或经验证的 S5 过门构建按同卷独立核验原始证据并锁定结果；同候选在隔离环境中的真实 G6 run 通过确定性 policy、经认证人工审批、branch 和 run 终态。run 外收口器形成不可变运行快照并重算双份候选结果；这两份预签材料与机械比对结果作为独立审计输入。独立审计绑定 C，完成后单独提交报告 A，报告及其摘要不参加 C 或 run 的输入。独审应按审计要求核清上一轮 P0/P1、测试范围、实际未验证项、I1–I10 与通用九条退出条件，并登记台账。G6 正式批准由具名授权人对 C、证据冻结集、报告 A、终态回执和两份待封存结果另行明确给出。
4. **正式收口与联检。** 签署工具从已提交的候选、报告及证据重算全部摘要，校验授权及实际批准时间，在干净的后继提交提交 G6 正文与两份 JSON。候选 SHA 永远是 C，不能写成 A 或签署提交自己的 SHA。在已签提交执行默认和显式联检，并检查从 C 到签署提交只增加预登记的阶段证据、独审和签署记录；任何候选文件漂移、缺失或证据更换撤销该次放行。故障现场、部分通过和缺权限均有真实记录，状态保持未过门。
5. **门后逐级启用。** 签署 G6 只允许授权人考虑开放 R1。另核 R0 门前观察、R1 环境隔离与值班条件后才启用 R1。R1 完整 1 周观察与批准后才启用 R2。R2 完整 2 周、事故定位及手册复验属于 S6 最终收口；未到观察周期只报告已完成的门和当前圈。安装验证在本地隔离宿主，真实试用、任何共享环境部署、注册表发布及对外分发各需实际授权。发布仅推广冻结 .tgz 原件。

历史链固定在正式 G5 签署提交 `8abbf0f0bc14c0a9e006625528d38e7288ccefba`，其中五门的代码/测试冻结候选为 `2f07617a2cfe1b5b8a069c0b1b3d73aad24549ce`，报告提交为 `4580aab18a11380d6ae45625e7c84e4c334d4247`。历史联检使用历史提交的验证器、门文件和依赖，另核 S6 对该历史的祖先关系与 G6 指向的完整 G5 artifact_hash `f57b6ac7f423ede6d9ab9f8e1eac5cef0c0d5ca117b85b3892d1dd8a9c66526a`。源依据是 `docs/reviews/G1-G5-signing-dependencies.md` 的正式回执。S6 工作树目前包含回执后提交与硬化改动。旧检查器按 HEAD 重算候选，因此只用它在新 HEAD 上报出的旧候选漂移不能判断旧门失效。S6 联检为旧门增加显式、固定快照验证，并核对当前可见旧记录及其历史锚点未被替换或删除。保留历史独立调用语义、报告、证据和排除名单，历史链变更须另行审批。回执所录 `human:啸春` 的 2026-11-19 批准只覆盖 G1–G5。

<a id="t12"></a>

## T12 · 在 S6 运行 `wf_release_v1`

- **输入与边界。** 规格 §11.4、§12.1/12.2、§13.5；实现先用 T01–T11 的项目编号与证据接口、T13 的预定格式；正式运行才消费冻结 SHA、完整的测量结果与清单。调用真实工作流、命令、执行器和账本入口。门工作区只对获授权发布身份开放，所有 tool 仅运行受信固定命令或登记好的故障工具，参数语义受限，沙箱隔离，不用 shell 拼接、真实租户存储、未登记流程或审批代办。
- **所有权。** 现有 `src/core/config.ts`、`src/service/workflows.ts` 有 S6 release 能力与目录检查，发布事务在 `src/service/commands/workflows.ts`，启动鉴权的实际写入口包含 `src/service/commands/start-run.ts`。复用 `src/service/commands/{parallel,wait}.ts`、`src/core/policy.ts`、`src/executor/{bridge,dsh-host}.ts`，仅在已验证缺口处改动。定向修改 `src/index.ts` 专用登记入口及与 T16 对齐的启动鉴权；拟新增 `src/core/wf-release-v1.ts`、`src/service/release-workflow.ts`、`src/client/panel/gate-card.tsx`，接 `src/client/panel/overview-screen.tsx` 现有只读视图；新增 `tests/integration/wf-release-v1.spec.ts`、`tests/client/gate-card.spec.tsx`。保留业务工作流与在途固定版本行为。
- **实现前先画映射。** 检查 `src/service/commands/workflows.ts` 的 `runtimeProjection` 与 `src/core/workflow-def.ts` 的运行类型，逐一写出逻辑角色、已支持的定义表示、实际执行入口、身份与证据。trigger 是图入口；工具工作走受限 executor；policy、approval、branch 应明确各自的确定性判定、人工命令、只读边选择和验证路径。覆盖从发布文档到投影、启动、终态的往返，禁止仅靠类型断言让未知节点过关。若缺运行语义，拆最小适配并先由主代理核定写域，保持旧版本投影。
- **动作。** 受信 trigger → 只排列六组的 agent → parallel 通过 `wf_gate_check_v1` 扇出迁移恢复、单节点、状态机并发、版本发布、面板记忆、性能安全 → 只读摘要及 tool 的强证据回执 → wait → policy → approval → branch → 父 run 达到终态 → 外部收口器。每组固定必过项、不可伪造登记身份和应回齐的证据类型，迟到或重复上报由既有租约、幂等与 CAS 约束。wait 超时用已落库的暂停、带原因阻塞与事件记录列缺组，消费到的回执可追查，禁止补造结果。policy 校验数据与阈值，同一原像重跑结果一致。审批使用真实认证主体、有效期、候选和完整证据集合摘要，配合二次确认规则；候选、组合同、证据集合、字节或批准内容变更后要失效。branch 只读 policy decision，禁止承载批准/部署命令；外部发布入口另判双份结果、实际 `runs.status`、run ID、授权和 G6 联检。门卡只露阶段/门、一句结论、谁在等和一个下一动作，默认隐藏内部 ID。
- **正反断言。** 正向真实六组通过、指定子流程执行工具、正常审批后精确 run 终态；读侧刷新和重启不重复派发。反向覆盖 S1–S5 直接加载、草稿发布、启动和入口别名，S6 非授权主体/客户端自报 actor，agent 拼装工具命令或代批，摘要翻转，漏组/缺证/重复且冲突的回执、超时等候、证据字节或候选漂移、审批过期、会话重启旧身份和分支误部署。S5 回归用现有 G5 的既定负证据，测试环境再次验证拒绝。
- **定向命令。** `pnpm exec vitest run tests/integration/wf-release-v1.spec.ts tests/integration/parallel.spec.ts tests/integration/wait.spec.ts tests/integration/approval.spec.ts tests/integration/policy-branch.spec.ts tests/integration/workflows.spec.ts tests/client/gate-card.spec.tsx --reporter=dot`。
- **证据与退出。** 留版本哈希、工具登记命令和退出码、节点/审批/branch/终态账本片段、负对照及门卡截屏。先以可审样例验证路径；正式真实门 run 由获授权人于冻结后启动/审批，通过 T13/T17 复核才可记为放行证据。

<a id="t13"></a>

## T13 · 两份 GateArtifact 与可独立重算的收口

- **输入与边界。** 规格 §11.3、§13.5、§15.1–15.7；开发阶段先与 T12/T17 约定输入清单、原像、状态与错误，使用明确标识的夹具；正式封存才需要 T12 真实 policy/审批/终态回执、独立执行登记及已提交独审。现有 `src/core/gate-artifact.ts` 有 G1–G5 特有 20 字段、以文件摘要为原像的口径，且已有 builder 仅排除字面 `failed`，不能原样用于 G6。
- **所有权。** 在 `src/core/gate-artifact.ts` 深化门号分派，保持历史函数与摘要兼容；拟新增 `src/service/release-gate.ts` 作为运行外收口器、`tests/integration/gate-artifact.spec.ts`，配合 T17 对接核验器。数据库只读终态读取与受信导出复用生产查询或仓储，不为生成证据补写 runs。
- **动作。** G6 固定 §15.2 四个原像：候选 `{git_sha,schema_version,phase}`、变更范围 `{capability_ids,touched_paths}`、证据 `{evidence_index:[{evidence_id,sha256,strength,source}]}`、不变量 `{invariants:[{id,method,result}]}`。加入非 BMP 与 BMP 字符交叉排列测试，按 G6 约定核对键以及路径集合排序；旧门摘要保持逐字节兼容。路径、ID、强度、来源逐项映射到冻结清单和实际文件，哈希前采用 UTF-8、按 Unicode 码点排序、集合稳定排序，重复 ID/同键冲突拒绝。artifact 内容哈希在外部锚点存放。回滚四字段齐全，G6 例外必须具备 scope、expires_at、compensation、rollback_target、approver，无效例外拦截，例外均不能改结论或绕过 I1–I10。
- **共用原始事实，独立判卷。** 固定共用原始证据 E0；独立执行者与发布 policy 各自读取、定位、重算、判卷并留已认证来源。独立复跑输出另留可查凭证，可以有不同采样/时间；只有按同一输入清单另行判定的源证据引用参加三字段比较，禁止两侧直接拷一份结论冒充独立核验。将两侧都可读取的原始输入 E0 固定为门前索引。policy 只判 E0 的事实项，审批绑定候选和 E0 的完整摘要。双份三字段的最终比较属于门外联检，此时记为待验；不得让 policy、证据或批准依赖尚未产生的终态或最终比较结果。run 结束后只读抓取真实终态及账本链，分别从独立判卷、发布 policy 和来源回执构建两份实体，重算并比较三字段。总门仅在实际比较相等且两份结论都是 pass 时通过，双 fail 相等也须拒绝。最终比较回执单独保存在门正文/报告旁，引用两份哈希但不回灌 E0；禁止用预比较、占位 SHA 或假造成功终态作正式比较。
- **收口与判定。** 无 run 的那份只能是有真实执行来源的 `human` 或 `s5_build`，且 run 字段为 null / not_applicable；发布那份用 `wf_release_v1` 与实际唯一父 run ID，终态严格匹配账本。满清单、零失败和规定终态同时成立才为 pass；paused、未验证副作用、orphaned、失败、非终态、错 run 均不能放行。两份只比较 candidate_hash、evidence_index_hash、conclusion；其余字段依权限/来源独立验证，允许合法差异。不一致时独立判卷结果作为处置依据，总门明确失败，停止推广。审批之后再有清单变动，保留现场后重新批准与封存，禁止修补摘要覆盖。
- **正反断言。** 同原像跨顺序可重算，证据来源独立、双份三字段配对通过、终态直抄，签署重跑幂等。反向分别篡改三字段、入组映射、证据、终态、审批、归档/重复、上报代次、无效例外及 JSON 自锚；没有运行或独立执行登记时不得生成正式 pass。
- **定向命令。** `pnpm exec vitest run tests/integration/gate-artifact.spec.ts tests/integration/wf-release-v1.spec.ts tests/gate/gate-check.spec.ts tests/gate/gate-g5.spec.ts --reporter=dot`。
- **证据与退出。** 留可重算的四类原像、E0 及其索引、独立观察签认、policy 输出、审批绑定、run 终态事件和最终比较回执；程序及夹具先可审，真正双份正式输出等 A 与正式 G6 批准。报告 A 可登记预签三字段和终态证据，正式签署只补治理绑定与锚点，严禁改动三字段。

<a id="t14"></a>

## T14 · 七步升级与带负载回滚

- **输入与边界。** §11.5、§12.3 的 G-13、G-15，上一正式过门构建与 C 的确切版本/工件摘要，事件链校验工具、演练数据与受管成果、上/下兼容窗口的迁移矩阵。旧构建经验证读不了新状态就停止入流、隔离故障路由并前滚处置，保持数据现场。
- **所有权。** 现有 `src/infra/backup.ts`、`src/infra/db/migrate.ts`、`src/infra/sqlite/migrations/`、`tests/integration/backup.spec.ts`。新增 `scripts/upgrade.ts` 作为独立操作入口、`tests/integration/upgrade.spec.ts`，避免把现有只读门检查脚本变成运行态运维入口。与 T16 先对接入流控制契约；备份实现和 backup.spec.ts 的改动只由 T06a 持有，T14 调用并给出失败复现。向 T06b 公布 plan.json 字段、两个真实包与兼容窗口标识、可重放的步骤回执。迁移只由真实缺口驱动。
- **动作。** 按 receipt 串联 ① 一致性备份数据库和受管成果，验证隔离目录、行数、摘要和 WAL 一致性 ② 副本迁移后分别验证新读旧/旧读新、账本重放和固定版本，标明窗口界限 ③ 停新 run 等安全点，检查现役租约、未收口副作用、返工和队列，保存账本水位 ④ 起新构建、健康检查和只读回放核对 ⑤ 源于真实入口的合成单节点 run ⑥ 恢复入流并实测连续十分钟 ⑦ 根据实际状态保留现场或按阶段表回滚；负载演练须明确地触发故障再实跑第七步，记录授权与回滚验证。每步同一演练 ID、候选、配置和目标栅栏，记录开始/结束、状态水位、失败、恢复/人工批准，允许同一身份重查/恢复，乱序、交叉演练与过期回执拒绝。
- **备份与迁移约束。** 目前备份由 checkpoint 后复制文件，需核活跃写者是否令拷贝跨越提交，将发现的跨提交拷贝或覆盖原库问题交 T06a 修复后再复跑。线上只用实时账本重放，RPO=0；备份只用于独立目录校验，含符号链接/目录别名和已存在目标的拒绝；`events.seq` 和历史哈希链不删改。破坏性迁移按扩展再收缩，并在窗口关闭之后才收缩。按 `docs/design/rework-orchestration.md` 迁移 047–055 核真任务、固定版本、输入快照、消费与返工请求/尝试、已授权的重启续跑、角色与留验等。若现场存在旧构建不理解的开放返工、未验证副作用或可重派动作，隔离/阻塞，待安全处置后再重试兼容判断。
- **正反断言。** 真实上一版升级、包加载、只读回放、合成 run、带负载恢复接单和带在途回滚有与 SQL/服务账本相符的回执。跳步、篡改水位、旧版不识别返工、备份损坏或目标落在 live、恢复重复调度、固定版本漂移、链损坏及未授权回退均拒；账本序号继续增加，服务不得写回旧库覆盖正式数据。
- **定向命令。** 拟新增 `node --no-warnings scripts/upgrade.ts dry-run --plan <plan.json>`、`node --no-warnings scripts/upgrade.ts step <backup|verify-copy|quiesce|healthcheck|synthetic-run|observe|rollback-table> --plan <plan.json>`。以两个各自真实构建包、独立宿主/数据目录与持续负载执行每步。`pnpm exec vitest run tests/integration/upgrade.spec.ts tests/integration/backup.spec.ts tests/integration/workflow-identity.spec.ts tests/integration/rework-process-restart.spec.ts --reporter=dot`。
- **证据与退出。** 保留七步 receipts、两构建/迁移兼容矩阵、正常演练与反向故障前后账本水位和回放对账、十分钟观测、授权者以及可执行回滚表。仅带负载且双向窗口验证成功的记录计入 G6。

<a id="t15"></a>

## T15 · 值班手册、执行权限与依例演练

- **输入与边界。** §11.5、§14.6、§16.3；T14 七步、T16 停新 run 控制、T1–T11 客观告警和故障输出。规格已定值班人 `human:啸春`、面板 inbox → QQ 升级、超过 30 分钟无人响应自动停止新 run。需真实人员确认当前值班窗口、升级派发及阶段负责人、代班备援和可达渠道，角色冲突由授权负责人解决。历史批准、联系方式占位、测试通知及模拟身份只用于各自语境；QQ 或其他实际消息仅经明确授权可发。
- **所有权。** 新增 `docs/runbook.md`、`tests/contract/oncall-runbook.spec.ts`；现有 `orchestra.config.json`、`src/core/config.ts` 与 T16 协作，入流状态由 T16 提供。使用 T14 实际脚本、T11 或对应告警任务提供的脱敏导出，勿复制实现。
- **动作。** 写适用构建与数据目录、值班交接、触发器、七步、阶段回滚表、到人决策与演练记录。触发含 I1–I9 破坏、同类 P1 24h 内两次或跨工作区、延迟超阈持续十分钟且扩容无效、迁移后解释不了状态、安全边界突破。当班人先停新 run、关受影响路由，保全已跑作业；构建回退由阶段负责人收到升级后十分钟内拍板。告警记录十分钟规则、升级记录三十分钟自动暂停规则，分别保留实际触发、ACK、重启持久化与恢复权限。
- **阶段表。** S1 停服务保留账本；S2 关桥，将在途 agent 置 `paused_bridge_missing` 并显示 blocked；S3 停新 run 等在途，优先前滚，旧读新用例已过才换旧引擎；S4 撤问题版本并保留已固定 run；S5 关闭面板与记忆路由，引擎账本继续；S6 仅双向窗口内切回上一过门构建。每步写真实命令、验收与失败处置。
- **正反断言。** 实际参与者可照手册定位、确认、止血、回退并复核；持久化 30 分钟控制重启后仍按原时钟，不取消在途或误开入流。缺实名覆盖、不可达、越权降级/恢复、告警误计验收、仅 dry-run、伪造或缺失回执均不能当实践证据。使用夹具与假时钟测试时间分支，另有真实接收和带负载演练。
- **定向命令。** `pnpm exec vitest run tests/contract/oncall-runbook.spec.ts tests/integration/upgrade.spec.ts --reporter=dot`，依手册由值班者执行 T14 命令并用 T16 入流检查验证，记录渠道 ACK。
- **证据与退出。** 预案、真实角色授权、可核验渠道与时窗、触发到 ACK/拍板各时间、事件与演练记录及待处理问题，门记录只留受保护联系人引用，凭实测与角色确认关闭值班项。

<a id="t16"></a>

## T16 · 三圈准入、入流控制与持续观察

- **输入与边界。** §11.6、§14.6、§16.3。先向 T14/T15 提供入流守卫接口，使用模拟圈状态验收守卫；R0 实跑消费 T14 回滚回执和 T15 值班准备；R1 实际启用才依赖 T17 已签 G6。工作区/流程注册与可信认证主体须可查。R1 规格定为本仓库的一个受信工作区、只读工具、记忆只到提议。当前 R2 只加入受控沙箱工作区与只读检查类流程白名单；执行者以 §16.3 已定范围配置。§11.6 关于 allowlist 写工具的通用规则不授予本轮写权限；若将来扩大范围，需另行批准并复核相应门。实际工作区 ID、绑定的宿主、流程、工具和批准人当场确认登记。
- **所有权。** 新增 `docs/trial-circles.md`、`src/service/trial-access.ts`、`tests/contract/trial-circle.spec.ts`。在既有 `src/index.ts`、`src/core/config.ts`、`orchestra.config.json`、`src/service/task-trigger-dispatch.ts` 和服务启动与工具/记忆写入口接中央状态判定，接入时和 T12/T15 划清配置/鉴权提交。测试覆盖 UI、HTTP、agent tool、调度与恢复后的间接入口；无需把面板当权威守卫。
- **动作。** R0 合成沙箱、假执行器、全部注入、禁止真实工作区；连续 3 天无 P1、历史 G1–G5 对应项复核、带负载回滚演练通过。签 G6 后、并经实际 R1 授权，开放单一只读工作区；连续 1 周无 P1，验证真实账本、面板停点可读、记忆提议无越权。连贯符合且单独批准后进入 R2，白名单收紧，保留每日复盘、写入审批及完整审计；连续 2 周无 P1，事故 30 分钟内能定位，手册演练复验。观察区间以真实 UTC、运行负载、事件/值班不中断记录为依据，按实际入圈时点开始，不回填或者靠短窗推断。遇 I1–I9 或安全边界破坏直接退 R0，停新入流、限制路由，按手册保留在途处置及审计。
- **正反断言。** 授权逐级、每阶段真实有效边界；真状态与重启后检查一致。缺 G6 或前置证据、跨级、过期批准、伪造 workspace、空/错白名单、R1 越权写/记忆 apply、R2 越界写、只改客户端配置及回退后自动重开皆拒。实际观测周期使用真时钟，单测的时间加速仅覆盖逻辑。按三个圈的顺序，观察期本身最少 24 个自然日，另加签署、环境切换和必要的重跑时间。
- **定向命令。** `pnpm exec vitest run tests/contract/trial-circle.spec.ts tests/contract/oncall-runbook.spec.ts tests/contract/auth.spec.ts --reporter=dot`，实圈按手册对有授权的宿主执行启用、例会和下圈演练。
- **证据与退出。** 每一圈分别登记授权、实际上下文、起止、负载、空窗/P1/越权巡检、定位时长、回退及其账本记录。开发完成以守卫及手册验收，G6 以前只有 R0 结果，S6 产品收口待 R2 观察完成。

<a id="t17"></a>

## T17 · 候选包、G6 正式记录与推广

- **输入与边界。** §11.2–11.6、§13.5、§14.6、§15、§16.3。打包脚手架先做；正式签门消费 T01–T16 的门前交付及真实授权。T16 未来的 R1/R2 观察不作签 G6 的输入。清单应固定 G-01–G-16 各单项、控制面读取 §8.3 的四条预算、事件滞后窗口、24 小时浸泡、升级成功、双向负载回滚、值班演练、双份一致。I1–I10 必须可查，任何聚合项必须可追到每一独立测试、数据与真实结论。
- **所有权。** 现有 `scripts/{gate-check,sign-gate}.ts`、`src/core/audit-verdict.ts`、`package.json`、`tsdown.config.ts`、`cordis.patch.yml`、`orchestra.config.json`。新增根 `README.md`、`tests/gate/gate-g6.spec.ts`、`tests/e2e/package-install.spec.ts`；候选冻结前提交所有生成/校验实现。具名授权后再产出 `docs/gates/G6.md`、`docs/gates/G6-independent.json`、`docs/gates/G6-release.json`；独审报告走 `docs/audits/S6-independent-audit-round<NN>.md`。保留 G1–G5 的旧语义、原始快照与前序链。
- **候选包动作。** `package.json` 当前已有 `private: true`、清单 `lib/cordis.patch.yml/orchestra.config.json/README.md`、ESM server/types、`./client` CJS 宿主模块、DSH patch/client 六注入，`tsdown` 已复制 SQLite SQL 到 `lib/infra/sqlite/migrations`。补安装说明及可重复 pack 流程，保持私有包配置，发布渠道权限按独立授权决定。README 从实际隔离安装记录反推命令，注明 Node `^22.19.0 || >=24.0.0`、DSH `>=0.2.2-0 <0.2.3-0`、构建 pnpm 12.3.4、配置/数据存储、阶段及圈切换与回滚。根配置目前默认 S2，升级/安装不能悄悄开放真实 S6 权限。核 tarball 文件清单及摘要，无账本、密钥、临时文件、测试夹具或审计散落件；从 tarball 在独立 profile 实装实际 DSH，测试宿主加载、迁移、资源、面板/菜单与无旧状态依赖。
- **产品安装验收。** 在目标 DSH 从正常入口完成隔离安装和既有路径冒烟，核对精确运行、面板、成果与证据。X01 的新导航、完整新用户旅程单独交付；只有明确合入本候选的改动或能定位到 §11.2 的回归才影响对应门项。复核 S5 产品差距记录和最新已完成路径，复用 S5 真宿主与合成记录的边界；用 S5 结算附录核强证据与人工 basis 的真实语义，用返工文档复跑受限制的工作流和还原历史、留验与版本围栏。仓库已有 `scripts/dsh-rework-probe.mjs` 能在隔离 DSH/fixture provider 验证桥和生产 HTTP，对实际宿主安装、真实模型和真实工作区分别留来源。缺宿主、受控插件/模型、隔离工作区或认证只能按实际环境标待办。
- **门检查动作。** 用门号专属 G6 路径检查程序，分开开发预检与正式放行。候选 C 之后只允许预登记的 G6 原始证据输出精确路径、独立报告、门正文与两份 artifact 等收口文件；候选仍覆盖生成程序、代码、测试、工作区/治理策略、固定证据映射和安装组件。路径、类型和内容按冻结清单验证，不得整体排除 `docs/gates/evidence`，禁止补记藏改动。报告 A 必须已经入库且唯一绑定 C/G6/真实轮次，结构化裁决清单与 G6 规格完全相等，正文结论一致。签署绑定报告字节、正式批准人和实际 UTC、上一签门构建、固定 G5 锚、各项阈值及 §16.3 六参数的真实定值和证据。两份 artifact 的各自 canonical_json 分别形成正文结论后的固定锚点，正文锁范围截止锚点，锚后补记不得改动当轮绑定。统一整理跨轮问题台账，预签不生成假 hash 或占位 pass。
- **正反断言。** 正向从 C 的确切包实装，运行、审批、收口、取两份实际身份/终态、重算两锚并保持旧门历史联检。缺件、脏树、陈旧报告、双份漂移、锚前改字、错人/错批准时间、把已签 G5 作为 G6 授权、候选/产物替换、缺正式浸泡证据、prev 链断、报告改动、审批输入变或假证据一律失败；锚后附记不改固定摘要。缺正式历史环境如 Git shallow 或版本依赖不可用时报告无法证明，不退化取模板文字。
- **定向命令。** 开发先 `pnpm exec vitest run tests/gate/gate-g6.spec.ts tests/gate/gate-check.spec.ts tests/gate/gate-g5.spec.ts tests/e2e/package-install.spec.ts --reporter=dot`，后 `pnpm check`、`pnpm pack --pack-destination <outside-candidate>`、`tar -tf <artifact.tgz>`、`Get-FileHash -Algorithm SHA256 <artifact.tgz>` 及实际隔离 DSH 安装。旧门复核在历史干净目录执行 `pnpm gate` 和 `node --no-warnings scripts/gate-check.ts docs/gates/G1.md docs/gates/G2.md docs/gates/G3.md docs/gates/G4.md docs/gates/G5.md`。拟扩展的正式入口按授权执行 `node --no-warnings scripts/sign-gate.ts docs/gates/G6.md`，同一干净签署 HEAD 执行 `pnpm gate` 和 `node --no-warnings scripts/gate-check.ts docs/gates/G6.md`，结果与冻结 C 及历史基线逐项核对。签署工具须先通过签署负对照，禁止测试把正式批准或实际安装当作夹具。
- **证据与退出。** 留 C、A、签署提交、旧末门、两锚点、包 SHA、实际宿主版本、证据/账本/负对照、审计及可追查授权。完成代码与本地包验证可以先报告，§14.6 的执行次序为 R0 → G6 → R1 → R2；按 §11.6 记录 R0 连续 3 天的实绩，再做正式 G6 签发。G6 机器判卷的固定项（含真 24 小时）、独审与具名签署单独核验，R1/R2 的未来观察不写进当前结论，R1/R2 和外部发布另在各自真实时窗及授权之后才能执行。任何未完成项须具名描述依赖或受阻原因。
