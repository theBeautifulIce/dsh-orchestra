# T01–T06 故障注入与可执行对账

[返回派工入口](../2026-11-19-s6-execution.md)。下列命令供 2026-11-20 起按卡执行。

<a id="t01"></a>

## T01（原 Task 1）统一注入与可执行对账

- **依赖与所有权**　入场基线用 `df78a19`、`docs/reviews/S6-entry-fault-baseline.md`。已有 `scripts/fault-inject.ts`、`tests/integration/fault-harness.spec.ts`、`src/infra/backup.ts`、`scripts/check-evidence-repro.ts`。本卡负责前两者的 S6 共用入口与格式，拟新增 `scripts/fault-reconcile.ts` 存放注入场景的只读查询执行和严格断言。T01 以固定公共字段交约：half_rows、orphan_runs、missing_events 各给 SQL、绑定值、查得数与期望数，case 专属事实另入 extra，判定写入 passed。复用同义的现有字段时，交一张双向映射。备份实现在 T06 范围内，本卡只消费既有接口。既有 `runCase(name)`、默认 G-01、缺参与未知编号的拒绝和旧目录路由继续由 df78a19 的回归守住。严禁改 G1–G5 证据或重生成到默认目录，禁止创建第二套业务状态机、备份工具、发事件逻辑或迁移执行器。
- **步骤 1**　保留历史分发及 Markdown 字节，给现有命令增加显式 S6 模式（拟新增 `--s6`，要求显式 `--case` 和隔离 `--out`），输出到指定根下的 `G6/<case>`。保留原 stdout/目录习惯给历史调用方。检查输出路径解析后的实址及父路径，使它与源数据库、已签证据和其他案例的输出无交叉。短场景与 T09 的 24 小时入口分别执行。
- **步骤 2**　冻结供 T02–T06 接入的脚本与证据契约。每个场景记录候选 SHA、脚本版本、实际 argv 与参数、运行环境、样本 id 与边界标志、前/断点/恢复快照、可重放的只读 SQL 与绑定参数或产物检查、查询原始行、每条预期和实测、失败原因。以隔离副本执行 SQL，用运行中实际 checkpoint 或关闭后的可读副本保留复核材料。以外键与实体归属核对孤立引用，以目标事务跨表预期核对半写，以预知事件标识与回放序列核对缺失事件，按场景查询定义精确计数。合法业务 orphaned 与孤立数据库引用分别报告。仅数据库中非空、只有报告自述、常量 0、查询未跑或证据查无资料均不能作为通过依据。性能样本、进程信号、外部 writer 文件或构建哈希按各卡保存原始记录。
- **步骤 3**　共用判定按实际结果导出每条 pass/fail，所有必须项执行且结果相符才输出通过。失败或未到故障标记保留诊断并非零退出。缺案例、坏参数在写证据前拒绝。读取/校验失败或缺查询的结果不能写成通过。完整证据以一次执行的独立目录写齐后才交付上下游索引，重复运行使用新目录，禁止并发覆盖同一路径。G6 汇总只认同一候选下 G-01…G-16 的完整独立 evidence，旧的退出码和描述只用于入场对照。
- **定向命令**　现有 `pnpm typecheck`、`pnpm test tests/integration/fault-harness.spec.ts tests/integration/backup.spec.ts tests/integration/evidence-repro.spec.ts`、`node --no-warnings scripts/check-evidence-repro.ts`（历史 29 份各两次，逐字节或 SHA 对 HEAD）。拟新增模式 `node --no-warnings scripts/fault-inject.ts --s6 --case G-01 --out tmp/s6-evidence/T01-smoke`。T01 先复用既有 G-01 实现跑一个最小真实事务样本，再在合成小库做报告正反对照；T02 接手后补齐 G-01 全部故障点及恢复验收。用错查询、错绑定、空证据、预期故意反转、写目标冲突、同案例不同输出根并发分别验证失败与隔离。
- **交付与停办**　交脚本和契约、既有字节复现回执、S6 失败诊断及独立重跑回执。历史字节漂移、缺断点、缺可复核对象或只得退出 0 均停在对应案例。T01 冻结接口后，各组可在独立模块开发，集成者逐组串行登记 `scripts/fault-inject.ts`。如果沿用原文件内扩写，顺序为 T01 → T02 → T03 → T04 → T05 → T06，一次仅一人修改；T06 未具备 G-13 输入时允许先交其余三条。

<a id="t02"></a>

## T02（原 Task 2）G-01–G-03 事务、事件与报告重放

- **依赖与所有权**　T01 契约。已有 `caseG01/02/03`、`tests/integration/g1.spec.ts`、`tests/integration/apply-report.spec.ts`。负责拟新增 `scripts/fault-tx-event.ts`、`tests/integration/fault-tx-event.spec.ts`；共享分发由集成者登记。生产事务、ledger、迁移和报告入口先复用，禁止改已签证据。若发现生产缺口，带失败复现回交集成者，由单独修复卡限定写集。
- **G-01**　现有脚本仅向 `events` 插入标记后杀进程。将真提交点用于可关联的业务变更和 ledger 事件同一事务。记录启动前节点、应写事件及最大 seq；等子进程确认业务行和事件已在事务中排好、尚未 COMMIT，核对 kill 信号与退出后重开。SQL 按节点及事件 id 匹配，目标业务行/状态、旧事件前缀与杀前相同，新事件和半条记录各 0。健康对照放行同事务，业务行和唯一事件同时可见；错过标记或 kill 前已提交须失败。再打开、重复恢复无变化。结合 T14 对照阶段处置决策，有已验证旧构建时只切构建与路由，无可用旧构建则停本阶段修复并留库。
- **G-02**　以同一真实写路径在业务与持久事件提交完成、传输投递之前阻断，凭子进程标志终止。重启后启动正常订阅/回放，以断点前实际最大 seq 作 `fromSeq`。SQL 关联业务变更与事件 id，断点处已同时提交，恢复后同 id/seq 恰好一条，遗漏数 0；多次从同游标读取是允许的交付重放，落在消费者上的同 seq 不重复，账本条数和前缀均不变。保持一个未提交对照不可见。这里的 outbox 是持久事件与投递之间的边界，勿把 `bridge_tool_outbox` 的工具专用行当事件投递真相。
- **G-03**　真实 `applyReport` 入口接受报告后，以相同 report_id 与同一作用域重发，包含一次双请求同步起跑，保留谁先拿到单写者的原始顺序。依 `report_registry.state` 判 `replayed`（没有额外布尔列）；该 report_id 一条登记、一次业务推进、同作用域 `report_applied` 一条，适用的 `report_replayed` 最多一条；多次重发和重启后再查仍成立。旧 attempt 或不同作用域复用报告 id 不增加业务推进。以合法新报告作阳性对照。对账核对 run/节点链、revision/attempt/generation 以及对应事件的 payload 标识。
- **定向命令**　现有 `pnpm test tests/integration/g1.spec.ts tests/integration/apply-report.spec.ts tests/integration/bridge-ledger.spec.ts`。拟新增 `pnpm test tests/integration/fault-tx-event.spec.ts`。完成注册后逐条执行 `node --no-warnings scripts/fault-inject.ts --s6 --case G-01 --out tmp/s6-evidence/T02`，以相同命令替换 G-02、G-03。另跑 T01 的既有证据复现。
- **交付与停办**　按 T01 交两条杀点的 stdout/信号、未提交或已提交 checkpoint、重开与订阅序列、账本 SQL/结果、上报回执和两次复跑对照。业务状态与事件缺任一边、旧前缀漂移、只查总行数或无法证实杀点时，该项保留 fail。

<a id="t03"></a>

## T03（原 Task 3）G-04–G-06 租约、取消与副作用核实

- **依赖与所有权**　T01，T02 的事件与实体取样。已有 `caseG04/05/06`、`src/executor/agent-lifecycle.ts`、`src/executor/evidence-collector.ts`、`src/service/commands/apply-report.ts`、`cancel.ts`、`effects.ts`，以上运行时先只读。负责拟新增 `scripts/fault-executor.ts`、`tests/integration/fault-executor.spec.ts`。T05 所有的 `scripts/g11-memory.ts` 只供读和复用数据契约。禁造隔离表、证据字段、直接更新状态绕过迁移、扩大工具权限或把人证放进系统证据。
- **G-04**　建立真实租约、记旧代次并令过期，随后用同步屏障送入旧 executor 的报告和实际工具晚到结果，分别覆盖尚未换代与新 attempt/generation 已接手。确认报告返回 `LEASE_EXPIRED` 或换代的 `STALE_GENERATION`，报告不能推进当前行；从桥回执/落盘诊断沿旧作用域取隔离事实，证明结果不能成为当前 attempt 证据或触发 `report_applied`/收口。若找不到可追溯的既有隔离入口，报明确生产缺口，禁止编造 `quarantine` 表或用「结果没推进」单独签过。比对 `node_runs`、同代 `tool_executions`、`bridge_tool_outbox`、节点事件和有效新代回执。重放旧包不追加第二个有效结果。
- **G-05**　在工具已入途后发取消。分别用真实协议回执覆盖明确确认中断和拒绝/未答；前者可以进入 `timing_out`，后者不得借取消请求当中断证据，进入或宽限扫到 `stopping`。取两次并发取消和一次晚到旧报告；应只有一道围栏，无新 attempt，旧代收口被拒。沿合法出口使夹具实际进入已约定终态，终态前为 0、后为 1；核对围栏、deadline、最后心跳、取消结果与终态证据。重复扫描/取消只保留最初合法业务结果。记录 G3 P2「宽限制裁后围栏仍 armed」的取样切点，若复现，汇报是否影响本场景的安全出口。
- **G-06**　保留既有 pure 工具 `callId` 重播作为正控（宿主一次、完成态 outbox 同作用域一行、同响应可重发）。新增一个隔离、可观测的非 pure 动作，真实失联切点设在动作可能已提交、可验证完成结果尚未返回。记录工具宿主独立存储、attempt fence、报告和恢复扫描。要求节点 `indeterminate_side_effect` 或底层批次保持 `applying` 待核，未核不能记 `done`、写 `side_effect_verified_none`、自动重执行或从待核清单消失。随后用既有核实入口和作用域一致的强证据走附录 §2–§7，至少覆盖合法结算、原样重放和弱证据/错代次/缺停止事实不结算。以 `tool_executions`、匹配 `tool_finished` 与链验证，及 `unverified_resolutions` 和 run/节点 `effect.resolved` 对账。合法结算后一行且各账本事件一次，已结算项消失；不合法结算无半成品。真实记忆写回清点由 T05；不能以它替代通用工具回传这一条。
- **定向命令**　现有 `pnpm test tests/integration/cancel.spec.ts tests/integration/lease.spec.ts tests/integration/bridge-ledger.spec.ts tests/integration/recovery-uncertain.spec.ts tests/integration/effect-resolution.spec.ts tests/integration/evidence-strength.spec.ts tests/unit/run-tool.spec.ts`。拟新增 `pnpm test tests/integration/fault-executor.spec.ts`。用 T01 S6 命令逐条运行 G-04、G-05、G-06，输出根 `tmp/s6-evidence/T03`。
- **交付与停办**　交各分支的启动/取消/结果帧、不同代次时序、内部只读查询和前后快照、拒绝码、对账前后清单。晚到结果可推进、出现第二终态、无法证明真正丢失结果、存在重写或只跑了 pure 工具时停办相应项。


<a id="t04"></a>

## T04（原 Task 4）G-07–G-09 时钟、背压与订阅

- **依赖与所有权**　T01。性能样本口径与 T07、队列与事件滞后口径与 T08 共用。已有 `caseG07/08/09`、`ScriptedClock`、`WriteQueue`、`listEvents` 和面板重连路径。负责拟新增 `scripts/fault-clock-concurrency.ts`、`tests/integration/fault-clock-concurrency.spec.ts`。服务时钟、队列、订阅客户端与性能公共文件先只读，各生产缺口回交责任卡。禁止更改系统墙钟、修改生产上限或临时提高限额以取得通过。
- **G-07**　同 boot 下只扭墙钟各 ±600 秒，固定单调钟分别验证未到期与到期边界；再以真关重开或不同 boot 的注入夹具，分别给可用检查点和缺失/不可信检查点。可信时以剩余预算续算，两次重启不增加预算；无法确定时正常路径记 `timer_uncertain`，节点不因墙钟进入终态。保存初始与恢复锚点、单调量、扫描前后 revision、事件种类和数量。重复扫描不重复写重锚事件、不生成第二终态；可信到期的合法分支应当实际推进，排除永远不扫的假通过。G2 S2 第 74 轮 P2 的存量 `hang_reason` 清除另由 T14 用旧库验证。
- **G-08**　把持锁者放在独立进程以免 SQLite 同步忙等污染服务事件循环。以受控 barrier 将服务首笔写停在进入 SQLite 之前，使请求仍能入队与读取。保持长事务的同时，以正常服务入口灌满默认 1000 个已受理未完成请求（包含一笔正在执行），编号 1001 的请求读真实 HTTP 503 和 `SERVICE_UNAVAILABLE`，其 SQL/事件改变量为 0。按 barrier 确认达到 1000，再记录 warning 的 pending/max、失败体、等待深度时序。持锁期间按 T07 真实生产读接口及同等规模采样：list_tasks 1 万条 p95 <100 ms、get_run 1000 节点 <150 ms、list_nodes 200 条 <80 ms、list_events 200 条 <50 ms。保存无锁基线与持锁样本、请求成功/错误数、计算方法。持锁期间由受控第二写者发起写入，记录真实等待和超时后的 SQLITE_BUSY。释放后验证队列按 FIFO 收敛、深度归零，先前错误不阻断后继。30 ms 的历史注入超时可留为快测，生产 `busy_timeout=5000ms` 以独立记录验证。另把 G4 P2 的双 worker 锁等待语义交接 T08，区分实际锁等待与版本发布 CAS 的业务结果。
- **G-09**　先从正常订阅获得最后已应用 seq，再断开十分钟；快速用例用可控时钟推进 600 秒，正式验收实际断开连接至少 600 秒，记录断开/重连的时间与期间写入序列；快速用例另存。离线期经正常写路径追加跨至少两页的事件，并在恢复期间继续追加。SSE 订阅凭 `Last-Event-ID` 或 `after_seq` 续传，发现断号后按现有客户端逻辑用 `GET /v1/events?from_seq=...` 重取；在隔离代理或已有 fixture 注入重复帧和一处断号，把整页重取与新游标推进的序列留证。用实际数据库分页 SQL 按 seq 排序，对齐 SSE 去重后的 seq/event_id 与重取页记录；另按归属独立复核节点链/证据文件哈希；缺失、重复应用和错序均 0，老读不得覆盖重取结果。请求结束后再重连一次证明没重复落地；不能用三条直读代替。
- **定向命令**　现有 `pnpm test tests/integration/clock-recovery.spec.ts tests/integration/clock.spec.ts tests/contract/write-queue.spec.ts tests/unit/event-stream-server.spec.ts tests/client/panel-stream-integration.spec.tsx tests/integration/perf-budget.spec.ts`。拟新增 `pnpm test tests/integration/fault-clock-concurrency.spec.ts`。用 T01 S6 命令逐条运行 G-07、G-08、G-09，输出根 `tmp/s6-evidence/T04`。回环连接受限时保存 EACCES 并在具备本机回环的隔离环境补跑。
- **交付与停办**　交锚点与 scan 事件、留锁日志、1000/1001 的真实序列和完整原始延迟样本、离线边界和重取数据。到期/队列饱和/断号从未发生、使用低上限替代生产值、只取成功请求样本或漏证据均不得签通过。

<a id="t05"></a>

## T05（原 Task 5）G-10–G-12 发布钉版、记忆半写与审批双击

- **依赖与所有权**　T01、T03 的副作用契约；G-10 可独立执行。已有 `caseG10/12`，G-11 现有独立进程与滚回路径在 `scripts/g11-memory.ts`。负责其 S6 证据增强，以及拟新增的 `scripts/fault-version-memory.ts`、`tests/integration/fault-version-memory.spec.ts`。先复用 `src/service/commands/workflows.ts`、`memory-recovery.ts`、`decisions.ts` 和共用幂等命令。禁止重作 S5 恢复、替换写入端事实为编排投影、修改历史 G5/G-11。
- **G-10**　走现有 create/update/publish/start 生产装配，让 v1 与 v2 有一项可在下游执行中区分的规则。等 v1 run 已起且未结束，以正常发布命令推出 v2，再并发进入新 run、旧 run 恢复派发，重开服务再次验证 hydrate。断点前后对账 `workflow_versions`、`runs.workflow_version`、`workflow_definition_hash`、实际派发/解释使用的定义和事件，老 run 固定 v1 并作 v1 行为，新 run 用 v2；同版本不同内容被既有不可变保护拒绝。相同发布请求重放回原回执且无额外版本、事件，旧账本前缀保留。G4 P2 的双 worker 等锁另交 T04/T08，版本钉住结论取真实业务写入。
- **G-11**　复用现有独立 SQLite writer、`G11_WRITE_REACHED` 与 SIGKILL。三场分别真写 2/整事务回滚 0/持久部分写 1；保留重启后写端原行和编排分阶段快照。杀后批次 `applying`、outcome NULL，原执行器丢失扫描后 apply 节点 `indeterminate_side_effect`；inspect 有可信可定位 `stopped_at`/证据 id 才以准入条件改变批次。部分写时变 `indeterminate`，已写 `applied`、未写仍 `approved`，旧写端已 fence；错内容哈希、伪证据、坏 revision 或 agent 擅自签字拒绝，不提前变更。全写 `confirm_applied` 后不重复写，零写 `confirm_not_applied` 后旧节点 `superseded`、只起新代次；部分写沿 verify_human 的 `abandon` → `abandon_ack` → `acknowledge_abandon` 走到记忆 run 的 `succeeded_with_unverified`，需有一条真实 `run.terminal`、待核项仍留痕、批次仍 `indeterminate`。已存在 `acked.terminal` 断言，补的是 scoped SQL、实际节点/批次/证据/裁决与终态原始行；旧报告 `source_run: succeeded` 是来源 run。重复 inspect/同操作验回执与事件不增长；尝试旧代重写与第二次活动批次应被拒。
- **G-12**　分开测相同 operation_id 重放和不同 operation_id 同 revision 争用，两者都用 `POST /v1/decisions/resolve`，携带 `operation_id`、`decisionId`、`revision`、`resolution: approved`；生产装配经 `src/index.ts` 进入 `src/service/decision/confirmation.ts` 的 `runDecisionCommand`。先用不要求二次确认的 `pre_execution` 卡锁住基础 CAS，再按现有控制面测试补要求 challenge 的分支，取两份预检 challenge 后争同一 revision。当前直接 `resolveDecision` 夹具保留作核心 CAS 对照。相同 id、相同 payload 只一次决策推进，第二次回原业务回执并标 `replayed`；同 id 不同 payload 返回 `OPERATION_ID_CONFLICT`。不同 id 两请求同起跑，一成一 `DECISION_REVISION_CONFLICT`，决策 revision 增加 1（未预先 acknowledge 的夹具从 1 到 2），恰好一条成功 `decision.resolved` 和一条可持久的完成回执。查 `inbox` 及 `GET /v1/operations/get?operation_id=…` 的真实返回，遵循业务失败的事务语义：若失败回滚，没有失败 inbox 行，以原始 HTTP 冲突回执入证据，不硬造拒绝行。重启后对原批准重放且 revision/事件不再增加。
- **定向命令**　现有 `pnpm test tests/integration/workflow-g4.spec.ts tests/integration/workflow-commands.spec.ts tests/integration/memory-g11.spec.ts tests/integration/memory-batches.spec.ts tests/integration/decisions.spec.ts tests/contract/s5-control-routes.spec.ts tests/unit/commands.spec.ts`。拟新增 `pnpm test tests/integration/fault-version-memory.spec.ts`。用 T01 S6 命令逐条运行 G-10、G-11、G-12，输出根 `tmp/s6-evidence/T05`。
- **交付与停办**　交老/新定义 hash、实派发路径、三场杀点和 writer 原始行、两个 run 的归属及节点事件、两类双击的响应及 inbox 结果。如果缺真实 writer 证据、以 source run 代 memory run、把签字等同已结算，或实际审批未重放，则本组对应条目 fail。

<a id="t06"></a>

## T06（原 Task 6）G-13–G-16 升级、迁移、备份与父子收敛

- **依赖与所有权**　T01。T06a 先验 G-14/15/16，T06b 的 G-13 依赖 T14 的同一升级/回滚驱动、两份可核实的构建、兼容范围和安全点机制，T14 可先借 T06a 的备份/迁移验收成果。已有 `caseG14/15/16`、`src/infra/backup.ts`、`src/infra/db/migrate.ts` 与父子 run 服务。拟新增 `scripts/fault-release.ts`、`tests/integration/fault-release.spec.ts`。G-13 尚未登记。T06a 负责备份/恢复测试与必要的目标路径保护，迁移与子流程生产缺陷另卡串行派工；禁止重写历史迁移、推送/安装真实工作区、用恢复覆盖源账本、另造本地升级运行时或用同一构建冒充双版本。
- **G-14**　复用真实 `applySteps`。现有 901 提交后/902 前终止继续保留；追加一个在后续事务中已经写了测试数据或 DDL、尚未提交的切点，捕获信号后重开。第一次恢复仅补 902，第二次为空；`schema_migrations` 的版本/名字/校验和值按真实字段核对，总集合等于杀前已提交+恰好新增 902，901 的实际操作与记录均一次，902 未提交残余在恢复前为 0。校验和不符、无旧构建均停止并保留库，不能覆盖存量历史。已有旧版 026 的真实存量兼容样本和量级按 T14/G1 S1 第 73 轮随升级证据保存。
- **G-15**　从单写者已停写/检查点确定完成的隔离库取源文件基线，按既有 `backup/verifyBackup/restore/sha256File` 正控，恢复到独立新目标只读核对已登记表。对两个独立副本注入截断和原长翻转字节，再对第三副本注入 manifest 单表行数差；分别用现有 `SERVICE_UNAVAILABLE` 与 `(db_file)` 或实际表名验拒绝。失败时目标不存在或原目标字节未变，来源库与账本逐字节或全量摘要不变；重试坏副本仍拒绝，两个并行副本不共享输出。如果入口未隔离源/目的地，测试路径别名、真实归一和源/副本重叠，恢复不得提供原库为目标。保存注入前后 SHA-256 全值、字节数、manifest、节点事件样本，勿复制带真实凭证的库。
- **G-16**　按真实 pin 与子流程入口关联一个未完成的子 run，包含可停止与不可逆分支。先观察父取消传播、保留不可逆分支待核、父为非终态（如 `cancelling`）；子尚未终态时重复扫描和重复/并发父取消，父 `run.terminal` 为 0、子关系和节点代次不增长。然后沿合法路径关闭所有子节点与子 run，再由收口器关闭父 run；已请求取消的父 run 状态唯一 `cancelled`，事件 `payload.status` 为 `cancelled`；选择业务成功的夹具对照 `payload.outcome` 分别为 `succeeded` 与 `succeeded_with_unverified`，后者有对应 `unverified_nodes`。另以失败节点的快照核对 `failed` 或 `failed_with_unverified` outcome 的真实归属。以 `runs` 父/根关联、精确作用域 `run.terminal` seq（子先父后）、状态、证据和总数对账，父子各一条；父终态后重复恢复一致，禁止新子 run。父或子断链不得因其他分支成功被绕过；该异常另按 G3 P2 归责。
- **G-13**　复用 T14 控制构建和路由的部署驱动，在隔离副本上用经过上一门的版本 A 接入 run，运行到标记后阻断其安全点。分别在升级和回滚的入场试探中验证等待且拒新 run，越过安全点或越过双向兼容窗口的操作必须拒绝，并留路由/进程现场。正控按规格 §11.5 启动备份、在副本迁移校验、停止新 run 并等待安全点，在已观测到等待后释放在途动作，随后完成构建 B 健康与只读回放、合成单节点、恢复入口观察，再按表回退到 A；若已执行 S6 正式负载窗口，引用 T14 的同候选原始样本。需覆盖 B 写入追加数据后 A 在兼容窗内能打开并正确解释，以及无可用兼容旧构建时明确停止、保留账本的负对照。用实际两构建 hash、健康回执、连线/服务 epoch 与写锁归属、迁移清单和账本旧事件前缀，核对在途 run 的钉版、已提交行和 append-only 保留；原流程安全点后的合法迁移可以前进，要按事件与 CAS 归因，禁止用还原数据库做回滚。补 G1 旧 026 升级存量、G2 `hang_reason` 清除验证的交接或引用记录，不能把带风险的历史状态从样本抹掉。
- **定向命令**　现有 `pnpm test tests/integration/migrate.spec.ts tests/integration/migration-cases.spec.ts tests/integration/backup.spec.ts tests/integration/subworkflow.spec.ts tests/integration/g3-faults.spec.ts`。拟新增 `pnpm test tests/integration/fault-release.spec.ts`。用 T01 S6 命令逐条运行 G-14、G-15、G-16，输出根 `tmp/s6-evidence/T06a`。G-13 待 T14 驱动接口冻结，将两套产物路径、约定安全点及兼容矩阵按其实际参数传入 S6 CLI（拟新增，T14 负责公布参数），输出根 `tmp/s6-evidence/T06b`。同时复跑 T01 的既有证据守卫。
- **交付与停办**　交迁移杀点和提交记录、负备份验证、父子终态证明、两构建实址与摘要、升级/回退日志和前缀校验。不具备可验证上一构建或兼容窗口时，G-13 继续待办。发生库被覆盖、前缀被改、父先于子收口，或同一构建代替两个版本即停办。

**前置门 P2 与故障包交接。** G1 S1 第 73 轮和 G2 S2 第 74 轮的旧 026、存量量级及旧 `hang_reason` 由 T06b/T14 用存量样本复核；G1 的直接写事件与派发结果持久化边界、G3 S3 第 25 轮的整链缺失、围栏标记、断链 wait 对同 run、断链与不确定并存，与 T02/T03/T06a 已覆盖的观察点分别交接。对未被本卡主场景覆盖的组合，按维护专项逐项落入审计台账，记录证据、影响、处置人及理由，并检查是否实际挡住已承诺门项。G4 S4 第 5 轮的双 worker 锁等待由 T04/T08 联合复核；旧体积继续作为历史快照。各卡按 `审计要求.md` §3、§6 提交本轮实际执行的命令、候选、可复查输出、异常分层与交接，G6 不凭历史报告代跑。
