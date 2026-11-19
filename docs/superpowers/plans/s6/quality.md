# T07–T11 容量、浸泡与安全边界

[返回派工入口](../2026-11-19-s6-execution.md)。下列命令供 2026-11-20 起按卡执行。

<a id="t07"></a>

## T07｜控制面读性能与生产 SQL 计划

- **输入与依赖**：主规格 §8.3、§12.4，设计稿 Q-26/Q-27，`docs/reviews/S5-perf-budget.md`、`docs/gates/evidence/G5/Q-26.md`、`Q-27.md`，S5 独立审计第 3 轮 §4。使用冻结候选、文件型 SQLite 完整迁移链、可重造的种子和生产查询装配。S5 的 Q-27 延时证据有效，证据尾注说明辅助 EXPLAIN 沿用历史 SQL。S6 的计划结论取候选实际 SQL。旧 Task 7 的单次第 4 轮口径保留为兼容观测，基准沿用 S5 已落地的预热 5 轮、测量 30 轮、nearest-rank p95，保留首个规定采样和全部测量值。
- **现有路径 / 拟新增**：`src/index.ts` → `src/service/server.ts` → `src/service/queries/{tasks,runs,nodes,list_events,read-tx}.ts`；`withReadTx` 已做独立只读连接、`query_only=ON`、快照内取 `as_of_seq`，有同步 SQLite 耗时超限后整页丢弃的现行语义。生产任务列表使用 `listTaskSummaries` 的注意力排序与物化分页，另外有较早的 `list_tasks.ts`，两者分开标记。基准从 `tests/integration/perf-budget.spec.ts` 和 `tests/fixtures/ledger.ts` 延展，补候选四路脚本或独立 `tests/integration/perf.spec.ts`，由实现者在开工时二选一并登记实际入口。默认无新迁移。
- **互斥**：T07 独占读查询与基准源。迁移或投影变更先向升级/回滚卡登记 DDL 编号、补填、持久投影更新边界和前后兼容性，再串行实施。T08 用 T07 提供的生产探针与报告格式测有写负载的读路径。共享 `src/index.ts`、`src/service/server.ts` 只在各自装配区串行改。
- **步骤**：
  1. 固定运行树、Node/pnpm/SQLite 版本、磁盘、CPU、隔离方式、配置哈希、种子与 reset 方法。复用 S5 的 1 万任务（含关联 run、节点、审批和不同注意力）、1 千节点 run（含审批、事件、工具证据），补足稳定的 200 节点页和 200 事件切页，保留多样数据与大于页长的候选。预先声明独立隔离窗口、负载校验、分位计算和无效规则。
  2. 在生产 HTTP 装配核实入口、默认任务首屏 50 条、`get_run` 的 1000 节点统计及 top 列表、`list_nodes` 和 `list_events` 的 200 条边界、过滤与游标。正式按同一生产查询函数含读连接开销测量，另外单列 HTTP/序列化诊断；构造真实需要过滤、后续页与混合状态的路径。无写基准和 T08 同负载读结果分开登记。
  3. 在原有调用链捕获实际执行 SQL、占位参数形状和真实库的 `EXPLAIN QUERY PLAN`，逐条枚举实际打点路径的主语句、相关子查询及绝对数量。识别基表全表扫描和有限中间结果扫描，Q-27 单独判过滤与注意力排序是否走索引。若当前 SQL 仍对大表做扫描/临时排序，先保留反例，定位实测瓶颈后做最小修复。若需要维护投影，先评审原命令事务、CAS、并发、历史数据补齐、清理与失败回滚，再重测，不用旧 SQL、孤立的基表查询或空数据掩盖生产行为。
  4. 测量进程应可脱离会话，证据目录里持续检查候选、机器负载和窗口完整性。掉线只重连查看同一运行；进程退出、标定无效、证据缺段保留原轮与原因，重新开完整窗口。同一候选的有效失败轮保留且参与结论，不按速度选最好的一轮。清理前保留合成种子脚本、SQL 与必要配置摘要，关闭读连接、生产服务和监听器，再清理本轮隔离副本。
- **正反断言**：任务总量 10000 的首屏 p95 <100ms，1000 节点的 `get_run` <150ms，实际 200 条的 `list_nodes` <80ms，实际 200 条的 `list_events` <50ms，等值为失败。实际基表查询无全表扫描，Q-27 检查过滤和排序索引，临时排序与物化层逐条分类并附界限依据。单页记录与 `as_of_seq` 同快照，跨页保持现有无同快照保证。错规模、错路由、旧 SQL、样本少/非有限、失败或 skip 被统计为通过、游标混用/跨过滤或退化成仅查询原始任务表，应得到失败或不可判定。
- **未来定向命令**：`pnpm exec vitest run tests/integration/perf-budget.spec.ts --disableConsoleIntercept --reporter=verbose`（已有三路基线，需要新增第四路）；`pnpm exec vitest run tests/integration/workflow-queries.spec.ts tests/integration/queries.spec.ts`；若选用新增基准入口，同时执行 `pnpm exec vitest run tests/integration/perf.spec.ts --disableConsoleIntercept --reporter=verbose`。冻结候选必须由严格判定器按四路全部实测样本重算，未命中、超限或跳过均不能通过。旧基准在超限时可能 ctx.skip 且进程退出 0；它的退出码只作诊断。
- **交付与未达处理**：每路记录环境、种子、查询/参数形状、条数和返回语义、原始轮次、p50/p95/max、实际计划、退出码、候选哈希、SHA256 和独立重跑指针。缺 `list_events`、基表计划不通过或时延超标时，该项不通过，回到查询/索引所有者修复后重新冻结和复测。S1 末轮的 026 存量时间单位判定交升级卡独立核对，任务数据规模以 §8.3 与当前基准种子为准。

<a id="t08"></a>

## T08｜事件滞后、写队列和回传上限

- **输入与依赖**：主规格 §8.4、§12.4、§15.4、§16.3、§17.2，G1 写队列定值，`docs/reviews/S6-entry-fault-baseline.md` 的 G-08（仅小容量示例），S4 末轮锁等待 P2。先与 T07 对齐读入口与基准数据；将度量契约、窗口和流端点交给 T09。G6 写队列默认 1000（进行中的一笔计入）、满拒绝 503 `SERVICE_UNAVAILABLE`、warning；`busy_timeout` 5000ms。§17.2 明确队列上限不进配置。若压测明显恶化，2000 是另一个需记录理由、重新跑 G1 并重签的候选值；当前以 1000 验收。
- **现有路径 / 拟新增**：`src/service/events/stream.ts` 管 SSE 轮询、Last-Event-ID、缓冲与重同步，`src/client/api/{sse,event-stream}.ts` 管客户端降级与重取，`src/service/queries/list_events.ts` 读账本，`src/infra/db/ledger.ts` 追加主事件；`src/service/write-queue.ts` 为真实 FIFO，`src/service/server.ts` 装配默认上限，`src/infra/sqlite/driver.ts`、`src/infra/db/open.ts` 是 DB 入口；`src/executor/session.ts` 已定义 64 KiB 与 800 字回传边界。现行 `orchestra.config.json` 为 S2 发布样例且写明 `service.busy_timeout_ms: 5000`。拟补最小的观测/判定模块及 `tests/integration/lag.spec.ts`，不另起队列、轮询协议或改 wire 事件成数据源。
- **互斥**：T08 所有 SSE、写队列与观测模块。T10 持有权限入口及会话策略修改，T11 持有日志和导出；如需改 `server.ts`、`index.ts`、`executor/session.ts` 的公共接线，先共享接口后串行。T01–T06 仍持有注入器，T08 复用其 G-08 证据；写队列 1000/1001 和真实并发读由本卡验。
- **步骤**：
  1. 提交窗口契约。用同进程单调时钟或经验证的同一时钟基准，以可追溯的实际账本提交时刻关联订阅端首次收到同 seq 的失效帧。源码的 `occurred_at` 是账本事件发生时间，启用前证明它与提交锚点关系；测试注入的延迟事件、历史补读和时钟漂移另记来源。采样保留预定探针、seq、窗口边界、候选、提交/观察时标及状态。只观察服务端 `res.write` 不能证明消费者已收到。客户端重取及轮询恢复作为单独证据，SSE 无载荷语义保持。
  2. 固定窗口切片、分位方法、预期订阅者和流量、时间覆盖及验收前置。全窗与约定的连续子窗口都检验 `p95 <=2000ms` 和 `max <=10000ms`，逐事件原始样本用来检出一次超最大值。运维在任一阈超出连续 10 分钟时必须告警，按记录中的时间持续量判断。采样缺失、空窗、有提交但未送达、时钟不明，标记不完整并阻止放行；已知越限事实保留。探针观察面只在隔离、本机、受信身份使用，证据不输出原事件 payload。SSE 重连、断号、压背触发重同步、回退到轮询均保留原 seq 缺口与恢复时间。
  3. 在文件库、真实默认服务路由和合成只读探针上，同时送入 1000 笔可控待办并确定地持住第一笔，再验证第 1001 笔 HTTP 503 和 warning。区分队列背压和 SQLite 文件锁等待，验证第二写者不能改库、真实 `busy_timeout` 与等待结果、FIFO/失败后前进/最终清空、长 Agent 动作在调度器而非持有写队列名额。放开屏障之前读能够成功且按 T07 口径留下时延。区分原测试容量 1/2 与此次实际门值。
  4. 通过合法回传入口校核 65536 字节及超 1 字节，多字节 UTF-8、摘要 800 及超预算场景。检查原有效证据引用保留、完整正文未借旁路写进摘要/日志，将传输 payload 的硬上限与上下文预算分开测。按 §10.5/§12.4 验证超预算时滚动摘要保留最近结论和证据引用，核 token 与压缩次数。单纯截断或拒绝只能记录现状；缺少滚动证据时标明具体缺口及实现责任人。关闭订阅、释放故意排队的处理器、停止隔离写入与服务，结尾读锁、队列、回执与事件 seq。
- **正反断言**：阈等值通过；单个 11 秒、任何子窗口 p95 超标、序列丢失、持续 10 分钟的超阈而无告警、空数据计算为零、计时倒退，均有独立失败断言。短暂超阈即使没达到告警期限或随后恢复，G6 窗口仍失败。第 1001 笔未生成成功副作用；读通路、已受理的合法写入、收口与复位各有可核对结果。
- **未来定向命令**：`pnpm exec vitest run tests/contract/write-queue.spec.ts tests/unit/event-stream-server.spec.ts tests/client/event-stream.spec.ts tests/client/panel-stream-integration.spec.tsx tests/unit/session.spec.ts tests/unit/config.spec.ts`；新增后跑 `pnpm exec vitest run tests/integration/lag.spec.ts` 并在候选窗口真实执行探针。对 G-08 复用 T01 的实际 CLI，先验当前子命令契约。
- **交付与未达处理**：提交分位与告警判断规则、真实窗口逐 seq 数据、锁/队列时序、读时延、退出码和 SHA256。进程掉线但证据持续写入时以运行 ID 恢复观察；窗口不足、写库锁未释放、读路在饱和时失败或边界不符时封存并修复重测，不用短夹具替代满容量。

<a id="t09"></a>

## T09｜24 小时浸泡的可恢复执行与证据

- **输入与依赖**：主规格 §11.2、§11.6、§12.4、§15.4、§16.3。依赖 T07 的生产数据/读取方法、T08 的窗口及订阅端上报合同、T10/T11 的边界就绪、T01 的可执行只读对账；候选冻结后才可生成 G6 证据。§16.3 明定 30 秒 / 2880 点和独立 `scripts/soak.ts`、`soak-report.json`，取代旧计划的 60 秒与 `fault soak`。本任务只指定以后开工的执行口径；正式窗口在 R0 合成授权范围内，使用真实服务装配和真实墙钟，合成任务及隔离账本。R0 三天记录、24h 浸泡、后续 R1/R2 各自签证据。
- **现有路径 / 拟新增**：`src/index.ts` 的服务生命周期，`src/service/sweep.ts` 收口路径，`src/service/queries/read-tx.ts` 独立只读连接，`src/infra/sqlite/driver.ts` 连接入口及 T08 SSE 度量。拟新增 `scripts/soak.ts`、`tests/integration/soak.spec.ts`、隔离证据包；优先在观测层和独立只读连接收集，只有缺可观测字段时才补最小生产观测。短跑/注入、判定单测、正式 24h 三种输出明确使用不同运行类型，门消费只认正式类型和完整证据。
- **互斥**：独占 soak 脚本、计划/采样格式和长跑目录。T11 持有保留语义，T09 与 T11 若共触 `sweep.ts` 先冻结接口再串行，优先 T09 无修改。运行中禁止对该候选、配置、连接采样语义和同一数据库做升级、压测、故障注入或部署；其它任务使用独立工作树/隔离数据，不共享目录、端口与写锁。
- **启动及权限**：
  1. 值班/执行角色登记候选版本及配置哈希、工作区/临时 profile 隔离路径、合成数据种子及流量脚本、故障停止条件和长期宿主的可用空间/权限；清除全局代理/用户配置的意外继承，测试服务只绑回环。合成授权主体、假执行器或隔离 DSH fixture、临时文件库、最小只读观察者、受控写入角色、独立的证据读取角色均单独登记。生产库、用户会话、真实记忆写、真实凭据和真实工作区明确排除在该窗口。
  2. 将进程 PID、启动时刻/候选、监督方式和输出路径登记到本轮启动清单；使用持久进程监督及持续落盘，终端断开不会停止。监控进程只查询运行清单、心跳与末次有效样本，两实例不得占同一目录。负载方案包含合成任务、单节点 run、持续 SSE、面板真实读/轮询，同时核对产品补充的产物验收与返工/旧 attempt 可见性等现有能力可在单独的确定性合成场景取代表数据。受控退出前保持完整常规负载和证据。
  3. 在基线和正式结束端点额外记进程/连接/资源基线，并在一段连续 24 小时内每 30 秒记录一个正式采样位共 2880，可约定 t+30s 到 t+24h；用单调时标判覆盖，不用系统显示的日历差值。每条含实际时间、位序、PID/boot、账本 head、负载计数、run/node_run 对账、未收口事件、事件窗口 p95/max 与缺失数、SQLite 读写连接/活跃语句、SSE/定时器等关键句柄、服务与受控子进程 RSS、WAL 与 DB/产物磁盘；收集原始时序和可复算对账结果。按事务层不变量区分正常待办与孤儿或未收口，账本只读核验，不把在途项强制清零或以最终扫描掩盖窗口反例。
  4. 先提交趋势判定定义和反例，报 RSS/WAL 无单调增长、连接和句柄不增长；对正常 checkpoint、稳态活跃量和数据增长分开归因，展示原始点、背景计数、查询、趋势算法版本、最后收尾值。不沿用前后 10% 均值作为唯一判断，不新增未经确认的放宽百分比。全窗保留 T08 的逐事件滞后和短窗口结果，任何样本缺失/重复/越序、非空账本的采样突然变空、假进程场地或不明资源增长皆能独立识别。
- **掉线、失败与清理**：观察会话掉线后凭运行 ID、PID/epoch、预定与实际时钟、样本位和最新 heartbeat 复核后接回，运行及证据连续可沿同一窗口继续。被测服务/进程重启、数据无法落盘、缺采样位或负载断流时将旧窗口标记失败或无效，保留前缀、退出事件、原因与诊断，从新目录新开连续 24h；不拼接、不回填、不压缩时间。遇风险先停新合成任务，合法关闭或收口本轮在途，封存必要证据再按本轮绝对路径关服务/订阅/子进程、确认 SQLite 写锁与句柄释放、端口解绑，最小权限清理隔离临时副本。完成窗口后由独立只读判定重算原始点、验报告和退出码，再核验最终账本与负载收尾。
- **正反断言**：真实 24 小时、2880 有效原始点、期望负载与证据链完整；孤儿 run/node_run 与未收口事件皆 0，p95≤2s/max≤10s，RSS/WAL 符合趋势且连接/句柄无增长。分别提供掉终端可继续、子进程退出导致窗口无效、缺点/重复/时钟回拨、11 秒尖峰、峰值恢复但有失败、连接泄漏、长期单增与合法 WAL checkpoint 的可复算 fixture；短跑无论成功与否都不能生成正式通过。
- **未来定向命令与交付**：`pnpm exec vitest run tests/integration/soak.spec.ts tests/integration/sweep.spec.ts`；拟定正式入口 `node --no-warnings scripts/soak.ts --hours 24 --evidence-dir <本轮隔离证据目录>`，实现卡先自行用 `--help` 验参数，保存真实命令与监督启动记录。提交启动清单、完整原始点及逐事件样本、趋势与只读对账、`soak-report.json`、资源清理核对、原文件哈希与复算命令。中途失败即时留证并处理，候选修复后开新窗口；证据不足标 blocked/incomplete，G6 不得引用为 pass。


<a id="t10"></a>

## T10｜安全边界及权限契约验收

- **输入与依赖**：主规格 §12.5、§13.4、§17.1，设计稿 §4.9 / Q-34、S5 effect-resolution 补充及返工与产品验收。以冻结候选在隔离回环/临时台账做有界防御验收，所有主体、密钥、工具和数据均用合成夹具；产物仅当本机授权身份可读，测试将真实运行装配与纯 fixture 结果分栏。资格来自已登记的宿主绑定/权限，审批记录本身不授予宿主任何新权限。继续遵守当前执行只读能力和 §16.3 的 R2 仅受控沙箱只读检查白名单。
- **现有路径 / 拟新增**：`src/service/server.ts` 的认证和命令分发，`src/index.ts` 与 `src/executor/dsh-host.ts` 的宿主装配，`src/service/workflows.ts`/ `src/service/commands/workflows.ts` 的加载与发布，`src/executor/{session,tools,run-node}.ts` 的固定定义和注册表，`src/service/task-trigger-dispatch.ts` 的触发执行，`src/core/memory-graph.ts` 与 `src/service/commands/memory-permission.ts` 的三入口写工具闸，`src/service/rework-{coordinator,runtime}.ts` 的主体与代次约束。旧计划指的 `src/service/commands/router.ts` 由当前装配路径替代，`src/core/policy.ts` 现主要负责条件求值，先查真正缺口再选择修补层。补 `tests/contract/s6-security.spec.ts` 或分别扩展现行契约；不复刻权限系统。
- **互斥**：T10 持有人/Agent/服务主体、加载/启动/发布判定与工具权限路径。公共 `server.ts`、`index.ts`、`executor/session.ts` 同 T08/T11 和发布卡协调，只串行落公共接线。T11 负责导出/日志敏感字段与过期内容，T10 供认证契约和最小证据面。T10 发现 I1–I9、安全边界或真实凭据问题立即暂停对应启用和候选放行，交审计与值班角色处置。
- **步骤及八项验收**：
  1. 匿名写和越权命令作为一组登记两条拒绝：普通写入口、适用的审批/协作/返工入口、宿主 API 分开验证。无主体 401 `UNAUTHORIZED`，合法认证但无所需绑定/能力 403 `FORBIDDEN`；用一条已授权同域命令做阳性对照。共享 HTTP 服务秘密只能按当前服务主体映射，面板/Agent 侧权限由宿主绑定，服务主体不能当人工批准。
  2. actor 由认证或宿主绑定取得。请求声明的 actor/角色/作用域不得改变最终账本主体；形状拒绝时不得写入。核对 Agent 的 `node_run_id + attempt + action_generation`、有权顾问与实际批准者分离、不能为自己证据批准、人工档只能人工。返工核对源运行、权限、固定版本、会话代次、授权原规格，不新增绕过普通 Agent 合同的审核角色。
  3. executor 有效 allow 含已注册 mutating 工具且自称 pure，在加载校验拒 `SIDE_EFFECT_UNDECLARED` 422；注册表查不到拒 `TOOL_NOT_REGISTERED` 422；allow/deny 优先级与空集合有只读正例，失败不发布新版本、不启动节点。把固定定义、宿主目录校验、旧兼容加载和启动复核列出，按实际入口明确错误在哪层产生。
  4. verifier 工具策略含 mutating，在加载期拒 `VERIFIER_TOOL_POLICY_MUTATING` 422；已注册只读验证工具成功走与签名定义绑定的路径。对于只能由宿主装配再得出的能力，加双层入口合同与提前拒绝覆盖，避免只有假目录测试通过。
  5. `runTool` 只读调用对 mutating/compensating/未知注册项拒 `RUN_TOOL_NOT_READ_ONLY` 403，宿主未被调用；没有只读挂载则走现行强证据不可用口径，有隔离只读挂载的正例能取得真实退出码/证据。仅使用无害已登记测试工具。
  6. trigger 未注册 effect 原语在政策层按 irreversible，要求新鲜的准确动作审批；原草案的 `SIDE_EFFECT_UNDECLARED` 422 / `CONFIRMATION_REQUIRED` 428 分别映射到声明及实际确认端点，先以当前错误表及行为分层核实。例如 decision.resolve 的确认挑战当前为 409；应按实际端点断言，不套用 428。工具注册仍缺失时不允许派发，即便已有批准。只在合成数据验证判定、确认和无运行写副作用，使用只读已登记正例校核触发路径。
  7. 任务会话默认工具 allow 为空，真实 DSH 装配与执行器分别拒绝对临时 storages 的读/写，归为 403 `FORBIDDEN` 或宿主原生权限拒绝并核对对应映射。验证权限携带至返工/重启恢复路径；已明确允许的只读非 storages 资源仍可按权限使用。HMAC 链提供非对抗性一致性校验，安全证据来自宿主权限卡口。
  8. 固定工作流定义、自定义执行器及任务会话三条 allow 来源在对应入口拒绝直接记忆写工具；发布前拒 `MEMORY_WRITE_TOOL_FORBIDDEN` 422，覆盖已有别名和 `memory.search` 正例。账本与受控记忆写入计数证明无直接写，原有经过明确批准的受控通道仍用既有 S5 契约单测。
- **反例、运行与交付**：每组留请求类型和去敏主体、加载/调用/发布阶段、错误码和实际 HTTP/宿主结果、写前后对账、是否产生回执/已发布版本/派发记录；合法授权所留下的账本事实独立核对。发现边界未落在真实入口时先记录 owning file，然后补真实入口契约和最小实现。用例失败保留证据，缺本机 DSH 宿主或回环授权标 blocked，完整关闭本轮监听、回收进程、撤掉合成授权并清理已核对的临时目录。真实 DSH + 回环 fixture 的证据范围参照 11-19 产品验收，不扩张为外部模型或真实工作区结论。
- **未来定向命令**：`pnpm exec vitest run tests/contract/auth.spec.ts tests/contract/routes.spec.ts tests/contract/workflow-routes.spec.ts tests/unit/run-tool.spec.ts tests/unit/tools.spec.ts tests/unit/session.spec.ts tests/integration/memory-permission.spec.ts tests/integration/task-trigger-execution-readiness.spec.ts tests/integration/rework-manual-dispatch.spec.ts tests/e2e/production-path.spec.ts`；若新建文件，补 `pnpm exec vitest run tests/contract/s6-security.spec.ts`。生产 DSH 真桥的只读验证或权限再验证单独记录实际命令、候选、宿主版本、退出码、scope 和 SHA256。禁止依赖本轮未采集的宿主权限证据签署该项。

<a id="t11"></a>

## T11｜保留期、产物访问、默认脱敏与命令审计

- **输入与依赖**：主规格 §12.5、§16.3、§17.2，设计稿 §4.9，S1 的回执窗口，`docs/reviews/2026-11-19-dsh-model-and-product-acceptance.md`、`docs/design/rework-orchestration.md` 及 S5 修复验收。现行样例只含 `retention.receipt_days: 7` 和 `in_flight_timeout_minutes: 10`；§16.3 的定案是 events 永久保留、evidence/artifact 不自动删除、artifact 到期仅标记过期。保留期全局天数待 S6 真实体量后定，先提交量级、来源和可核对利弊给负责角色确认。默认先保留事实与字节，按已登记的 `retain_until` 控制 artifact 内容读取；不添加空值清理任务或编造天数。即使随后定天数，任何清理语义需明确授权、规格与变更门记录。
- **现有路径 / 拟新增**：`src/core/config.ts`、`orchestra.config.json`、`src/service/sweep.ts`、`src/service/commands/idempotency.ts`、`src/service/artifact-store.ts`、`src/service/queries/artifacts.ts`、`src/client/panel/artifact-content.tsx`、`src/infra/logger.ts`、`src/infra/db/ledger.ts` 及 `src/service/commands/decisions.ts`。现有登记绑定 run/节点与 hash，内容 API 检查保留期/哈希；UI 已有“已超过保留期限。仍可查看登记记录。”文字，按规格核对“已过保留期”及预览/下载禁用。logger 对部分结构化键递归脱敏且深度受限，消息文本与所有证据/导出边沿要核查。按真实调用点建立证据导出清单，缺受限导出时优先给门证据生成器加字段白名单，明确区分默认审计导出与经认证的产品产物内容下载。
- **互斥**：T11 持有 logger、导出投影、artifact 查询/UI 和保留策略。T09 优先只读巡检，公共 `sweep.ts` 串行；公共 `server.ts` 或 `index.ts` 装配需在认证与观测接口合并后串行。只在本卡涉及的保留/脱敏处调整配置，发布样例 phase 由发布卡处理。
- **步骤**：
  1. 以自管回环、隔离 DB 和带授权的两类合成身份覆盖现有、过期、无内容旧行及不同归属的 artifact。在到期前/等于到期/到期后、哈希相符与不符、不可解析保留期、内容过期但元数据保留和用户加载后的缓存等情况下同时核对客户端和认证内容接口。保留数据库的 artifact/evidence/event 行对账、链完整性、原产物 hash 和归属字段。产物验收、返工预览旧/新产物和源 attempt 一致；过期产品验收以现有 `unverifiable/artifact_retain_until_expired` 作基线，执行事实仍可见。
  2. 回执在 7 天窗口可按原 `operation_id` 重放且幂等，在途 10 分钟边界保持现有收口/拒绝语义；过期回执与在途超时分别校核，核对操作事实与 `events.seq`。用受控时间和真实文件库，避免等候或修改宿主时钟。测试 sweep 并核对全量不变事实；若配置的已存在键接线存在缺口，在本卡明确修复归属。
  3. 枚举结构化日志（info/warn/error、消息文本与异常 details）、故障/浸泡/升级及门证据导出、审计事件投影等边沿。通过白名单与摘要/引用保留明确字段，缺来源时记录原因，不把数据库原始行完整序列化再事后删字段。安全合成哨兵覆盖凭据、密钥、完整 payload、executor 全量 transcript、嵌套记录、旧版拼法、大小写与异常文本；仅公布命中类别和位置，批准的最小字段仍可追溯。若既有 API 有授权查看的产品工件内容，另测其认证、归属、保留期和哈希，不能把其内容导进默认日志与审计包。
  4. 命令审计从认证主体及业务裁决结果生成，核对 `operation_id`、actor、`decision_id`、resolution、结果、时间和 `evidence_id` 引用。原文不作为命令审计结果落盘；查成功、拒绝、回执重放各自约定留痕，保留预检无业务写入契约。对跨人、跨 run、跨 attempt 均带合成归属的拒绝对照。记录安全审计部署与现场排查所用的最小可见面。
- **正反断言**：合法未过期 artifact 可走受管预览/下载；过期直接向 API 请求也拒绝，账本事实、索引引用和元数据仍可读。缺/坏 hash、过期标记缺失、保留/回执边界偏移、清理删事实或字节、合成哨兵出现在任一默认日志与导出，以及缺命令审计关联，均明确记录失败。匿名/不同归属读写按 T10 的认证主体和实际授权范围验证。留痕中能够找到由服务确认的主体及证据 ID，无需暴露源正文。
- **未来定向命令**：`pnpm exec vitest run tests/unit/config.spec.ts tests/contract/artifact-content.spec.ts tests/client/artifact-content.spec.tsx tests/integration/run-acceptance.spec.ts tests/integration/sweep.spec.ts tests/integration/ledger-integrity.spec.ts tests/contract/decision-memory-confirmation.spec.ts`；新建覆盖时执行 `pnpm exec vitest run tests/integration/retention.spec.ts`，并对生成的实际默认日志和去敏导出做哨兵核验。至少留证：路径和标识脱敏清单、保留前后只读查询、链校验、真实 UI/认证 API 结果、命令审计样本、代码/候选/证据哈希及退出码。出现场地掉线先用同一候选补观测，证据边沿缺失标 blocked；关掉孤立导出、服务和临时 DB，核对只清理本轮隔离副本。若真实体量还未取得，在门记录如实写主规格现行不自动清理策略、未知体量和天数决策状态，避免把未获确认的天数包装成已定。

#### T07–T11 结构与跨阶段复核依据

- 结构发现使用 S5 根目录图 `D-aboutAI-dsh-orchestra`，索引 2026-11-19T14:34:59Z。覆盖查询对相关路径报告元数据变化，结论以 S6 工作树的实际源码和入口为准，图只定位结构。
- S1 末轮承接 r69 P2-2～P2-5：旧 026、量级、断链只记事件及派发结果持久化，其中旧版本兼容与毫秒／纳秒量级判定交升级卡，断链只记事件和派发结果交注入/维护卡。S2 末轮承接 r69 的旧 `hang_reason` 迁移和续租同时钟证据交升级卡并作为 T09 误判隔离反例。S3 末轮四个断链 P2 交注入与维护处置；T09 使用完全独立的被测库。S4 末轮双 worker 后的锁等待语义交 T08；旧构建体积交升级卡。S5 末轮的 Q-27 诊断 SQL 交 T07，收口/投影终态清单复核由 T09 的对账与拥有者核验，`acquireLease` 迁移 CAS 核对留相关维护与升级卡。各卡保留审计原编号、证据位置和关闭/延期理由，由汇总卡统一登记。
