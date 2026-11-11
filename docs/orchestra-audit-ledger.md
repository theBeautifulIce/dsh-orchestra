# dsh-orchestra 设计审计台账

用途：把每一轮独立审计的结论按统一口径记下来，好看清「问题是在变多、变少，还是只是变难」。统计口径说明在末尾。

## 一、逐轮记录

| 轮次 | 审的范围 | 结论 | 致命 | 加固 | 小项 | 这一轮挖出来的主要性质 |
|---|---|---|---|---|---|---|
| 1 | 第一、二段 | fail | — | — | 11 条 | 骨架级硬伤：回写「接收/接受」不分、超时从派发起算、重启只救已超时、上下文随节点数平方增长、回写身份无防、payload 自由文本、判定规则无执行模型、重试打回语义缺、SQLite 读写分离误解、与原生双账本、接入无回执契约 |
| 2 | 第一、二段 | fail | 2 | 10 | — | 执行载体自相矛盾、orphan sweep 覆盖不全、received 阶段多余、started 靠模型自报、外部验证与「引擎不执行工具」冲突、重试缺副作用策略、会话存活未分三态、事件投递语义缺失、checkpoint 与实例锁不成立、payload 契约过重 |
| 3 | 第一、二段 | **pass**（附四条在案） | 0 | 0 | 0 | 会话池上限与归档、活跃数由 slot 租约限制、ctx.agents.get 空值按「判不准即 orphan」、补两类并发测试 |
| 4 | 第三段 v1 | fail | 1 | 8 | — | 批次边界按类型切应改按来源、tool_runner 成第二执行组件、wait 唤醒排队丢事件、parallel 与单活跃投递互斥、decision 缺 N/A、子工作流递归哈希、branch 措辞 |
| 5 | 第三段 v1 | fail | 2 | 6 | 2 | resume 不看不可逆标志会重放、工具闭包绑旧引擎、子图 visited key 未定义、wait 事件丢失、parallel 无未结算语义、slot 无心跳、decision 缺「等人」态、artifact 缺类型分支 |
| 6 | 第三段 v1 | fail | 3 | 5 | — | 独立进程缺宿主锚点与收尸、代次没进 CAS 的 WHERE、原子性边界自欺、能力矩阵未校验声明与实现、wait 边沿触发、parallel 无 run 级结算、never_started 计时混排队、sweep 漏 indeterminate |
| 7 | 第三段 v1 | fail | 3 | 5 | — | 缺 executor.cancel 与事件重放、三个态未进恢复表、blocked 缺回派边、watchdog 与 drain 无交接、60 分钟写成全局常数、decision 缺终态、verifier 证据半闭合、prev_hash 不是真链 |
| 8 | 第三段 v1 | fail | 3 | 5 | — | 桥缺 cancel 与事件重放、三个态未进恢复表、blocked 缺回派边、watchdog 与 drain 只有锁没有交接、不可逆 60 分钟全局化且心跳依赖主循环、decision 缺终态、verifier 缺证据来源、哈希链可重算 |
| 9 | 第三段 v1 | fail | 3 | 5 | — | 引擎改独立进程后的所有权与收尸、代次进 WHERE、原子性边界写实、能力矩阵校验、wait 边沿触发、parallel 的 run 级结算、启动计时与排队计时混、sweep 漏 indeterminate |
| 10 | 第三段 v1 | fail | 3 | 5 | — | 桥 RPC 表补全（cancel/runTool/事件订阅）、sweep 恢复表逐态映射、blocked 拆前后两条边、控制面加 service.state、不可逆时限按节点/工具级、心跳独立线程、decision 加终态、证据与核验策略分离、哈希链移到 append-only 事件表 |
| 11 | 第三段 v1 | fail | 2 | 8 | — | 超时把「立围栏」与「动作停下」混成一件、恢复表一一映射没闭合、blocked_pre 入口与租约写错、run 单枚举表达不了并存状态、核验基线可被作者写空、桥缓冲归档后归属、任务会话仍带工具、runTool 边界只写四个字 |
| 12 | 第三段 v1 | fail | 2 | 5 | 1 | stopping 的计时锚点与兜底、blocked_pre 的租约与 CAS、run 对外投影、passCondition 未受约束、stopping 依赖桥、保留期与 dispose-ack 口径、run 终态前置条件、runTool 禁用后的证据链 |
| 13 | 第三段 v1 | fail | 5 | 6 | — | 插件卸载与宿主死亡分不开、stopping 迁出后脱离监管、「放弃」无合法目标、计时锚点仍未落在真起跑时刻、弱证据可被作者滥用、sweep 恢复不查期限、旧定时器仍能推走节点、桥恢复可无限延期、run.resumed 条件不全、跨行线性化与代次持久化、证据分强弱、裁决合并去重 |
| 14 | 第三段 v1 | fail | 5 | 4 | — | 先问能不能停再决定立围栏、迟到完成被自己的时限挡掉、代次没进执行器回写、插件与宿主死亡仍无法区分、abandon_ack 三出口没闭环、启动层把「没观测到」当「没发生」、裁决出口没进状态机、两个 60 秒并存、版本残留 |
| 15 | 第三段 v1 | fail | 5 | 6 | 1 | 代次双重语义、围栏撤销无回写通道且 whenIdle 无出口、启动层「不明」被塞进 stopping、executor 报不出「没发过 tool.call」、continue_wait 与 decision 行自相矛盾、abandon_ack 与迁移表冲突、终态 CAS 不查活跃 decision、未结算集合生命周期、派生无单一来源、弱证据闸门可绕、called_no_start 被当执行中、桥缓冲无上限 |
| 16 | 第三段 v1 | fail | 7 | 4 | 1 性能项 | 代次矩阵化、被挡回写要有幂等账、timing_out 恢复同步、continue_wait 回边、结论态收口边、startup_unknown 补齐 kind 与出口、桥预算只作用于没开跑的节点、confirm_started 锚点与拒绝、abandon_ack 改 run 级键、三个出口的副作用、capability 覆盖全部节点、派生不许全量扫描 |
| 17 | 第三段 v1 | fail | 4 | 6 | 2 | startup_unknown 缺执行器回写边、迁移表与启动层判定冲突、abandoned_unverified 与 run succeeded 可同时成立、capability 与 compensable 自相矛盾、三个出口的 executor 落点没写完、registry 与旧标量双来源、恢复路径缺代次自增、registry 查重与应用未同事务、confirm_started 是死路、capability 仍漏执行面、run 级唯一键在 SQLite 下不成立、registry 不在哈希链上 |
| 18 | 第三段 v16 | fail | 3 | 5 | 2 | startup_unknown「仍活」分支无时钟也不在 paused_bridge_missing 五态内、「已失联」分支未拆到 deleted/未知/桥断、abandoned_unverified 的独立确认停止无迁移也无字段、display_status 与 succeeded_with_unverified 冲突且无 run 事件、startup_unknown→done/failed 不继承 schema/判定/证据门、超时表绕过「先问停不停得下来」、startup_unknown 的迟到 report 无账可入、补偿证据只有要求没有事件名与字段、verdict 归类与 Ga 初始化时点不一致、「已在正文生效」检查口径要改成机器可判定 |
| 19 | 第三段 v17 | fail | 9 | 3 | 0 | indeterminate_side_effect 无出边、orphaned 未列终态也无 replacement、verifying 没有时钟、startup_unknown 四支的钟与出口清理没写全、两个 120 秒钟没有先后且桥预算无持久字段、stopping 缺人裁决行（confirm_applied 无迁移）、stopped_at 被当成 succeeded 的通行证、pending_irreversible_children 只硬编码四态、compensable 的前向动作过不了能力闸门、applyReport 只有文字复用没有单一入口、迟到 report 只留账不阻断会重复副作用、succeeded_with_unverified 与 failed 的边界没写死 |
| 20 | 第三段 v18 | fail | 10 | 2 | 0 | failed_with_unverified 只进终态集合没有入边、stopped_at 仍被当成副作用没发生的通行证、run 终态 CAS 不按子节点结果分叉、applyReport 缺 attempt 且新 attempt 把 Ga 重置成 1、continue_wait 的 approved→pending 与结论落地即 closed 互相抵消、verifying 与 timing_out 在桥断期间钟没口径且 verify_* 未清、startup_unknown 出口仍有两处不闭合、report_contradicted 只有 kind 没有挂起态与过期规则、证据门不是统一可执行路径且人工裁决可绕过、capability 规则自相矛盾致 compensable 不可达 |
| 21 | 第三段 v19 | fail | 6 | 4 | 4 | 重试行模型自相矛盾（同一行 attempt+1 与「新 attempt 必新行」并存）；桥断口径三套（continue_tracking 两支、watchdog 暂停与桥断预算两个时间基、paused_bridge_missing 与 startup_unknown 互撞）；人工证据门自相矛盾（attested 既要 evidence_id 又说不作验证证据）；report_contradicted 有挂起格却没有出口闸门，decision 表也没有 uphold_report / uphold_decision 的落点；confirm_not_started 缺 executor 三支；终态集合四处重复；另有三条措辞口径 |
| 22 | 第三段 v20 | fail | 3 | 5 | 4 | 约束写成了句子而不是数据库：UNIQUE(node_run_id, attempt) 在新 attempt 必换行时形同虚设；桥断仍从三处漏进 startup_unknown；hang_reason IS NULL 只在总则、逐行漏十处。另有三处落点缺失（uphold_report 无用例、状态未知重查不明无处可去、started→done 的时点判反）与一处键冲突（decision 四列键撞既有 partial index）；M-06 缺 has_tool_call 拒绝路径；四条措辞把五条分支写成四条 |
| 23 | 第三段 v21 | fail | 3 | 3 | 2 | 冲突裁决的另一半没写死：uphold_decision 无独立迁移行、无执行用例、目标仍写 queued；uphold_report 从 startup_unknown 迁出不清钟；裁决收口代次把 uphold_report 统写 Gr；confirm_started 被错误对称成 has_tool_call=true 即拒（应只拒 confirm_not_started）；另有「两条 resolution 行」例外只列两处、Gr+1 包住终态出口两条措辞 |
| 24 | 第三段 v22 | fail | 1 | 1 | 2 | 裁决终态出口代次互斥：L231/L279/L281/M-60/§3.4n 第 1 条仍带 Ga，与 §3.4h「裁决收口类只 Gr、唯一例外 uphold_report」冲突；M-60 缺新行 origin_node_run_id、attempt=旧+1 与 failed 支断言；另两处措辞（L288 路径数、L803 历史 M-59 代次） |
| 25 | 第三段 v23 | **pass** | 0 | 0 | 3 条措辞观察 | v23 按第 24 轮 4 条落稿：L231/L279/L281/M-60/§3.4n 第 1 条删终态出口的 Ga，只留 Gr；M-60 补 origin_node_run_id、attempt=旧+1、failed 支 status=failed 且不建新行；L288 补「共三处路径」，L803 补「v22 起不占 Gr」；§3.4n 降 HISTORY，新增 §3.4o [CURRENT] 四条清单；版本升 v23（866 行）；第二十五轮 7 项全过，判 pass（0 致命 / 0 重大 / 3 条非阻断措辞） |

## 二、几件能算出来的事

**轮次与问题数不是一条下降曲线。** 第一段三轮收敛（第三轮 pass）；第三段从第 4 轮起一路 fail 到第 17 轮，致命项在 1–7 之间摆动，加固项长期在 4–8 之间。总数不减。

**原因不是「没改对」，是范围一直在长。** 每写一段新内容就回头和前面所有规则对照，新旧撞车本身是新问题；每加一个状态格就多一对要核对的边。第 13 轮之后新增的 startup_unknown、stopping、abandoned_unverified、report_registry，全是为了让规则可执行才长出来的格子——格子刚长出来时干净，长到十几轮才被看出毛病。

**性质在变硬。** 早期挖的是「两段话自相矛盾」；中后期挖的是边界与竞态：旧 attempt 的队头挡住当前 attempt、旧定时器推走已续期的节点、SQLite 里带 NULL 的唯一约束不生效。这类要跑起来才碰得到，纯纸面想只会越想越细。

**致命项的来源在换。** 第 11–17 轮的致命项几乎都出在「人裁决之后节点去哪」「不可中断动作还在跑怎么办」「代次与围栏谁说了算」这三处——它们不是新设计出来的，是前面每一轮修一处、就挤出一处。第 18 轮又集中到另一族：「半态的时钟与出口没写全」——startup_unknown 一旦拆成两支，两支各自都要时钟、证据门、迟到回写与账目位置，第十八轮把这一族一次挖出三条致命。

**第 18 轮之后仍不能收口。** 审计给出的收敛判断是：结构性/致命 8 条（含 1 条补偿证据契约）、措辞/口径 2 条、性能 0 条，尚未到可进第四段。性能这一类从第 16 轮起已经清零，说明剩下的确实集中在语义而不是速度上；致命项集中在 startup_unknown 这一个半态的两支上，而这一支是第 15 轮才长出来的格子，到第 18 轮才被审到四层不齐（时钟、证据门、迟到回写、账目位置）。

**第 19 轮之后仍不能收口。** 审计给出的收敛判断是：结构性/致命 12 条（9 条致命 + 3 条重大结构性）、措辞/性能/文档卫生 0 条，仍未到可进第四段。最易低估的风险是：`stopped_at` 只证明动作不再跑、不证明副作用没发生，把它当 `succeeded` 的通行证，会让一笔已写出、只是不再动的副作用从 `succeeded_with_unverified` 里消失。这一轮的致命项开始成族地落在同一件事上——**半态没有自己的时钟、证据门、迟到回写路径和账目位置**：indeterminate_side_effect 无出边、orphaned 未列终态、verifying 无时钟、startup_unknown 四支清理不齐，都是这一族。主人 15:39 的口径「状态机啃得更死一点，毕竟这是流程的核心」正是对症的：审计火力从措辞转向状态机本身，第十四条硬教训里的「半态要有出口」「超时是两件事」「恢复表逐态闭合」「时限分层」「证据分强弱」在这一轮被逐条兑现成检查项。

**第 20 轮之后仍不能收口。** 审计给出的收敛判断是：结构性/致命 10 条、契约/高优先 2 条、措辞/性能/文档卫生 0 条，仍未到可进第四段。这一轮的致命项不再分散在「半态时钟」一族，而是**收尾判据**一族——`failed_with_unverified` 只进了终态集合没有入边、`stopped_at` 仍被当成「副作用没发生」的通行证、run 终态 CAS 不按子节点结果分叉、capability 规则自相矛盾导致 compensable 分支不可达、证据门由调用方传 policy 所以人工裁决可绕过。审计点出的最易低估风险是一句话：**「节点终态」不等于「run 可以成功」**——`failed / timeout / orphaned / failed_with_unverified` 都是终态，若 run 只查「无非终态 node_run」，账本会在工作失败或失联时收成 `succeeded`；叠加 `stopped_at` 只证明动作停了、不证明副作用没发生，就会在现实仍可能落刀时把账做平。这与第十四条硬教训里的「停止不等于结算」「证据分强弱」同源，但此前都停在字段级，没有落成一条可执行的判定。

**第 20 轮之后，v19 已按 12 条落稿。** 2026-11-11 19:08 设计稿升 v19（769 行，SHA256 前缀 4C50EB6B41732026），#7–#12 逐条落进正文：startup_unknown 只留 unknown_watchdog 一个钟、report_contradicted 有挂起格与两个 resolution、applyReport 内部加载 policy 且人工裁决同走 evaluateEvidence、capability 三值推导与加载期用例、already_stopped 两条出边与 confirm_not_started 闸门、§14 行级唯一约束；另补行→幂等键对照表与 M-01…M-56 逐行用例。第二十一轮审计已送，等结论；未过之前不动第四段。

**第 21 轮之后 v19 被判 fail。** 结论是 6 致命 + 4 重大 + 4 措辞。这一轮的性质不是新格子不够，而是同一件事被写成了两三套：重试一处写旧行 attempt+1、一处写新 attempt 必新行；桥断期间 continue_tracking、watchdog 暂停与桥断预算各有一套时间基；人工证据门对 attested 既要求 evidence_id 又说只作状态事实；report_contradicted 造了挂起格却没有出口闸门，decision 表也没有 uphold_report / uphold_decision 的落点；confirm_not_started 的 executor 闸门比 confirm_started 少了三支；终态集合在 §8 与 §3.4j 各写了一份；§14 只覆盖四类行级唯一约束。

**v20 已按 14 条落稿。** 2026-11-11 19:27 设计稿升 v20（809 行，SHA256 前缀 0C90060F7D0ACFCC；19:24 落稿后自检又修正回写边计数与 deleted 例外三处）：重试一律新建行、旧行落中性终态 superseded；桥断只走 bridge_absence_accumulated 一个时间基、continue_tracking 只对 executor 仍活且桥可用开放；confirm_applied / confirm_not_applied 必须走 evaluateEvidence，confirm_started_attested 豁免只记 attestation_id；两格迁出一律带 hang_reason IS NULL；applyReport 加第 6 参 decision、decision 表补 uphold 映射；confirm_not_started 补四支 executor.state；终态集合只在 §8 写一份并含 superseded（run 级五个名字）；另补 §3.4l [CURRENT] 十四条清单。第二十二轮审计待送。

**第 22 轮之后 v20 被判 fail。** 结论是 3 致命 + 5 重大 + 4 措辞。性质是「约束写的是句子，不是数据库」：UNIQUE(node_run_id, attempt) 在新 attempt 必换行时形同虚设；桥断从三处仍能进 startup_unknown；hang_reason 闸门只写在总则、逐行漏了十处。另有三处落点缺失（uphold_report 没有用例、状态未知重查不明无处可去、started→done 的时点判反）与一处键冲突（decision 四列键撞既有 partial index）。

**v21 已按 12 条落稿。** 2026-11-11 20:05 设计稿升 v21（838 行，SHA256 全值 AE771DB18D7CFBEC30C5832D3416D69DA7D873BC239120ADAFA34F9DF4D885B0）：唯一约束改 UNIQUE(run_id, node_id, attempt) 并补 origin_node_run_id 部分唯一索引，M-58 加「换新 node_run_id 仍被拒」；桥断入口从三处删除，只留 startup_timeout；hang_reason IS NULL 逐行内联十三处，例外仅清 hang 与桥断边；M 扩到 M-59；状态未知重查不明统一落 RESOLUTION_NOT_AVAILABLE；started→done 改 now <= effective_deadline_at；decision 唯一键统一 (node_run_id, kind) partial index；M-06 补 has_tool_call=true 的五条分支；四条措辞与三处引用订正；另新增 §3.4m [CURRENT] 十二条清单，§3.4l 降为 v20 历史。第二十三轮已送，未过之前不动第四段。

**第 23 轮之后 v21 被判 fail。** 结论是 3 致命 + 3 重大 + 2 措辞。性质是「冲突裁决的另一半没有落成可执行路径」：uphold_decision 只有一句「维持原裁决」，没有独立迁移行、没有清钟、没有执行用例，目标还写着旧 queued；uphold_report 从 startup_unknown 迁出不清 startup_unknown_deadline_at；裁决收口的代次矩阵把 uphold_report 统写成 Gr；confirm_started 被错误对称成 has_tool_call=true 即拒，实际该闸门只作用于 confirm_not_started。

**v22 已按 8 条落稿。** 2026-11-11 20:0x 设计稿升 v22（854 行，SHA256 全值 0A73DB61550D462797AFA1511AD58A9959F5566FA19C8C54F399FF478B65FE1B）：新增 uphold_decision 独立收口行与 M-60，D2 落 rejected+closed、节点按 D1 的 decision_id+revision 收口，清 hang 与 startup 钟，幂等落 superseded 并回写双指针、不可重试 failed、迟到 report 标 stale；uphold_report 的 CAS 补「来源 startup_unknown 时清钟」，M-59 加断言；代次矩阵与一句话判据补 uphold_report 走 Ga 的例外；L139/L443 改成「旧行 superseded + 新建 queued 新行 / 不可重试 failed」；has_tool_call=true 只拒 confirm_not_started，补 M-61；「两条 resolution 行」例外改三处；Gr+1 只给需重新武装的出口；M 扩到 M-01…M-61；新增 §3.4n [CURRENT] 八条清单，§3.4m 降为 v21 历史。第二十四轮已送，未过之前不动第四段。

**第 24 轮之后 v22 被判 fail。** 结论是 1 致命 + 1 重大 + 2 措辞。性质不是新规则缺，而是同一迁移的 CAS 代次写成两套：L231/L279/L281 三个人裁决终态出口、M-60 与 §3.4n 第 1 条都带 action_generation=Ga，而 §3.4h 明写裁决收口类用 Gr、唯一例外是 uphold_report；照 §3.4h 实现会过不了 M-60，照 M-60 实现又违反矩阵。M-60 还只断言 superseded 支回写 replacement_node_run_id，缺新行 origin_node_run_id、attempt=旧+1 与 failed 支不建新行。

**v23 已按 4 条落稿。** 2026-11-11 19:59 设计稿升 v23（866 行，SHA256 全值 2E529CDC209F8A2D538F3C5A987D429244040E8F54450708FAE7A2338150B054）：L231/L279/L281/M-60/§3.4n 第 1 条删掉终态出口的 Ga，只留 rearm_generation=Gr；M-60 补 origin_node_run_id、attempt=旧+1、failed 支 status=failed 且不建新行；L288 补「共三处路径」，L803 补「v22 起不占 Gr」；§3.4n 降 HISTORY，新增 §3.4o [CURRENT] 四条清单；M 总数仍 M-01…M-61。第二十五轮已送，未过之前不动第四段。

**第 25 轮 pass。** 2026-11-11 20:04 收到结论：7 项全过，0 致命、0 重大，只有 3 条非阻断措辞（旧历史标题仍指 §3.4n、L803 同句仍写 Gr、§3.3 未带 report_contradicted 不落 expired 例外）。第三段达到收口条件，按主人口径进第四段；措辞留到第四段一并清理。

**审计子代理的任务就是挑刺**，它会一直找下去。其中「加固项」本质是加保险而非缺陷，保险没有归零的那天，这条线就不该按「清零」验收。

## 三、收敛判据（自定，用于第四段起的门禁）

不按「条数归零」验收，改按这三条：

1. 连续两轮没有新的致命项（剩下的只有措辞、命名与性能口径）；
2. 致命项必须落在实现期能验证的点上（有明确用例、能写成测试），而不是需要靠读文档想象才能判断；
3. 纸面审计的边际收益低于真实运行的边际收益时，把风险挪到实现期——先落最小可用（一个 trigger + 一个 agent 节点 + 记忆审计工作流），用真实运行暴露剩下的。

## 四、统计口径

- 「致命」= 会让账本与现实不一致、或让流程卡死无出口的错；「加固」= 健壮性与性能层面的改进，不改也不至于出错；「小项」= 措辞、命名、索引、事务边界一类。
- 第 1 轮原始记录未分严重度，记在「小项」列的 11 条里，但实际含致命项，故只作参考，不计入趋势判断。
- 第 3 轮是 pass（附四条在案），是第一、二段的收敛点。
- 第 4 轮起审的是第三段（九种节点），轮次编号沿用全局计数。

## 五、当前进度与续跑指引（2026-11-11 20:04 记）

- 设计稿：D:\aboutAI\dsh-orchestra\docs\orchestra-design-draft.md，当前 866 行（SHA256 全值 2E529CDC209F8A2D538F3C5A987D429244040E8F54450708FAE7A2338150B054，文件头与第三段标题均已升 v23，§3.4o 为唯一 [CURRENT] 清单）。第二十五轮由 a8f7647d 判 **pass**（0 致命 / 0 重大 / 3 条非阻断措辞），第三段已收口，可进第四段（面板与查询）；3 条措辞留到第四段一并清理。

- 项目已于 2026-11-11 16:50 整体迁到 D:\aboutAI\dsh-orchestra（设计稿、台账、requirements.md、design-notes.md、根目录 handoff.md 与 codebasemap.md、references\ 三份参考项目、四份 codebase-memory 图谱）；旧址 D:\aboutAI\dshQQ\docs\ 保留同内容副本，后续只改新址。
- 第二十轮审计已出结论：fail，10 致命 + 2 重大结构性，措辞/性能 0 条。最易低估的风险：「节点终态」不等于「run 可以成功」；叠加 stopped_at 只证明动作停了、不证明副作用没发生。
- v19 落定的 12 条（第二十轮原文要点，v20 在其上加固）：
  1. failed_with_unverified 只有终态集合没有入边 → 补「verifying → failed_with_unverified」、补偿失败来源 → failed_with_unverified、compensable 无可执行补偿 → failed_with_unverified 三条显式迁移行；L229 那行的「到」列改成条件二选。
  2. stopped_at 被当成副作用没发生的通行证 → succeeded 只认 side_effect_verified_none=true 且带 stop_evidence；stopped_at 单独存在只能支撑 succeeded_with_unverified；unverified_side_effect 不得因 stopped_at 消失。L297 / L301 / L303 统一引用这一句。
  3. run 终态 CAS 不按子节点结果分叉 → 存在 failed / timeout / failed_with_unverified 子节点则 run 只能 failed 或 failed_with_unverified；存在未被 replacement_node_run_id 替换的 orphaned 子节点则 run 只能 orphaned 或留 paused；全部 done 才允许 succeeded。
  4. applyReport 缺 attempt、新 attempt 把 Ga 重置成 1 → 签名加 attempt，所有回写 CAS 带「attempt + Ga + report_id」；首次 Ga=1，其余一律 Ga+1，删掉 leased→dispatched 硬写 1。
  5. continue_wait 的 approved → pending 与「结论落地即 closed」互斥 → 只留一套（推荐：对 pending / acknowledged 追加 revision 保持活跃、不经过 approved）。
  6. verifying 与 timing_out 在桥断期间的钟无口径、verify_* 未清 → 补桥断时钟矩阵表（每钟 × 桥断行为 × 恢复处理）、写死 bridge_absence_accumulated 清零语义、每条离开 verifying 的行显式清 verify_started_at / verify_deadline_at。
  7. startup_unknown 出口两处不闭合 → 只保留 unknown_watchdog 一个钟；continue_tracking 只对「executor 仍活且桥可用」开放（v20 起桥断已转 paused_bridge_missing）；deleted 支出口按 L139 收窄或改 L139。
  8. report_contradicted 只有 kind → 补挂起状态与理由、resolution 取值与节点迁移、围栏规则、过期只落账不释放围栏。
  9. 证据门可绕过 → applyReport 不收调用方 policy，按 node_run_id + workflow_version 从不可变模板加载；落成 evaluateEvidence(policy, evidence) → {pass, reason}；所有人工裁决迁移行必须调同一函数。
  10. capability 规则自相矛盾致 compensable 不可达 → 删掉「mutating 只能是 irreversible」，写死「mutating + 可执行 compensation → compensable；无 compensation → irreversible；作者声明只能更严」。
  11. already_stopped 无合法目标行、confirm_not_started 的 dispose 违反「只在节点终态后 dispose」→ 补 already_stopped 行并写 stopped_at；dispose 前置改为「该 attempt 已收口或重试已落库」；confirm_not_started 加 executor 已删且桥断已确认的前置检查。
  12. report_registry.report_id 唯一键只在正文不在 DDL → §14 写 report_id PRIMARY KEY 或 UNIQUE 索引；补「行 → 幂等键」对照表（report_id / decision_id+revision / event_seq / attempt+Ga）；补一条 DDL 验收用例。
- 执行者自留 7 处：第二十轮判 6 条必须补（policy 判定落成 evaluateEvidence、行→幂等键对照 + report_id DDL、桥断时钟矩阵、settling 与 failed_with_unverified 逐行对齐、补偿描述符注册校验落 §2、迁移表逐行生成用例清单）、1 条可接受（§3.5 标题已补回）。
- 收敛判据（§三）不按条数归零验收。状态机这一族已在第二十五轮清零（0 致命 0 重大，只剩 3 条非阻断措辞），按主人口径收口进第四段（面板与查询）。
- 按主人 2026-11-11 15:39 口径「审计这一步，没通过、没获得正确结果前，就不能往后走」：第三段在 2026-11-11 20:04 拿到 pass，闸门已开，可进第四段。
- 换会话不影响进度：设计稿、本台账、记忆底账（asset 记事本 mem_mwbqav4n_23bd4f8d）与在办条目（L5 mem_mwbq9pys_9139830f）都落在磁盘上，换会话后按这四处接手即可。
- 审计口径的复用条目：pitfall mem_wbsf89z_3ac546f6（审计轮次不收敛的三条收敛判据）；记忆分层口径 L4 mem_wbtckln_5dd4de9f（项目细节进记事本，长期记忆只留一个待办和索引）。
- 2026-11-11 23:19 第二十七轮已送：v25，1274 行，SHA256 CCF1FD9D…DB672，收件子代理 a8f7647d-1f41-49f7-90d2-fa38a3c3bce7，messageId d45b99b9-b9de-49b0-9cb2-aacbbdc7971e；只读复核第二十六轮 2 致命 / 9 重大 / 7 措辞，待回包。v24 备份 `.v24.bak` 未跟踪，尚未提交。

- 2026-11-11 23:25 第二十八轮已送：v26，1279 行，SHA256 62B9F857…F555，收件同一子代理 a8f7647d-1f41-49f7-90d2-fa38a3c3bce7，messageId 6e785359-bc9d-46f9-a1b9-58c479cc5279；只读复核第二十七轮 2 致命 / 4 重大 / 3 措辞与 v26 新增存储落点，待回包。第二十七轮回包判 fail：F1/F2 遗留、M1–M4 新增、W1–W3 措辞；第二十六轮旧 2 致命已修好。

- 2026-11-11 23:54 第二十八轮回包判 fail：0 致命 / 1 重大（两阶段确认与 inbox 幂等未接上）/ 0 措辞。第二十九轮已送：v27，1289 行，SHA256 AE360E98…86B0，收件同一子代理 a8f7647d-1f41-49f7-90d2-fa38a3c3bce7，messageId 663edcf9-fd46-4cfd-bd4c-d69639ce36a3；只读复核「预检不落 command 行、challenge 先验于冲突、并发唯一键兜底、7 天回执窗口」与 §14.2 command 行 DDL，待回包。

- 2026-11-12 00:00 第二十九轮回包判 fail：1 致命 / 3 重大 / 2 措辞（终态回执过期无承载字段、command 行 CHECK 遇 NULL 放行、唯一索引建在 idempotency_key、payload_hash 未覆盖 target/expected、回执窗口与过期优先未限定、MISMATCH 误含 revision）。v28 已修：新增 receipt_expired_at；request_hash = SHA256(JCS({command,target,expected,payload}))；CHECK 三支显式判 NULL；唯一索引改 operation_id；7 天窗口从 completed_at 起算；错误码与 Q-13/14/15/35 同步；§3.4q 为唯一 CURRENT。v28 1307 行，SHA256 02AB845F…2F8B，第三十轮已送：收件同一子代理 a8f7647d-1f41-49f7-90d2-fa38a3c3bce7，messageId bb8191bb-7fcf-4fa0-8805-74a7c981e257；待回包。

- 2026-11-12 00:26 第三十轮回包判 fail：0 致命 / 1 重大（in_flight 的 10 分钟超时只有起算、没有收口，调用方会一直收到 COMMAND_BUSY）/ 1 措辞（OPERATION_ID_CONFLICT 只写窗口内终结回执，漏了同 operation_id 的非终结行）。v29 已修：§4.6.2 增加维护扫描每分钟 CAS 置 rejected、写 completed_at 与 receipt_json=OPERATION_TIMEOUT、追加 command.rejected、不改业务状态；执行侧 applied 用同一 CAS，败方整笔回滚；错误码表新增 OPERATION_TIMEOUT（504），OPERATION_ID_CONFLICT 触发补非终结行；§4.6.4 面板行为与 §14.2 DDL 交叉引用同步；补 Q-36，Q 总数 36；§3.4r 为唯一 CURRENT，§3.4q 转历史。v29 1317 行、345529 bytes、SHA256 C7F91FC438993116FEFAF2093E31F60BF7EA14B81CE2001EE1E1D63852787F8F。

- 2026-11-12 00:26 第三十一轮已送：收件同一子代理 a8f7647d-1f41-49f7-90d2-fa38a3c3bce7，messageId 958d7fc7-79d0-4560-a0bf-6a0c33fdadf7；只读复核 v29 的在途超时闭环、OPERATION_TIMEOUT 与 OPERATION_ID_CONFLICT 分界、Q-36、§14.2 CHECK，以及 10 分钟与 7 天两个窗口是否互相打架；待回包。

- 2026-11-12 00:55 第三十一轮回包判 **pass**：0 致命 / 0 重大 / 3 条非阻断措辞（v29 L1175 在途超时收口未写明同一事务；L1175 与 L504 两个维护扫描同名不同周期；L856 的 [历史] 与 L850 的 [HISTORY] 不一致）。审查对象 v29 1317 行、SHA256 C7F91FC438993116FEFAF2093E31F60BF7EA14B81CE2001EE1E1D63852787F8F；三条措辞已在 v30 清。

- 2026-11-12 00:55 第三十二轮已送：v30，1495 行；送审后补 open_draft 的 base_version 必须等于 current_version、publish 错误优先级（先 DRAFT_NOT_OPEN 后 VERSION_CONFLICT），终稿 371142 bytes、SHA256 5B39674E606D7E4C7F09ED61080050F880456E2E54A465DC7CD8FF00C4A7BF9B；收件同一子代理 a8f7647d-1f41-49f7-90d2-fa38a3c3bce7，messageId 85952d82-ad4e-4a32-b362-6f7970703622，补正 messageId 6dbabbe4-9a92-4544-8b42-7f1ad819282a。本轮新增流程定义三表 DDL（§14.3）、四个 workflow 命令（§4.6.5）、定义校验与发布门禁（§4.12）、Q-37…Q-42、§3.4s 当前清单；只读复核流程定义写模型，并查读模型/索引/结构回归，待回包。
