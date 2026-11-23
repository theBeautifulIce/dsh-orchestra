# Beta 审计清单修复状态

对照《DSH-Orchestra-beta-审计与优化清单》（2026-11-23，基线 `a076439`）逐项记录。
分支 `lilium/v0.1.0-beta.1`。每个已完成项都带一条可重复的用例；未完成项保留原清单的改法与验收条件。

状态用词：**已修**＝代码与用例一起落地；**待办**＝本轮未改；**受限**＝需要宿主尚未提供的能力。

## 第一批　保证能用

| 编号 | 状态 | 落地位置与说明 |
| --- | --- | --- |
| H01 | 已修 | `src/infra/db/migrate.ts`、`src/infra/sqlite/driver.ts`、`.gitattributes`、`tests/unit/migrate-eol.spec.ts`。摘要改为按 LF 归一；已发行版本（≤68）另接受同文本的 LF/CRLF 历史摘要，SQL 真改动仍拒绝；迁移文件行尾固定为 LF。 |
| H02 | 已修 | `README.md` 安装第一步改为直链 `.tgz` 与预发行页，写明已验证的 Desktop `0.2.2-rc.5` 与安装后的预期反应；源码构建移到最后。 |
| H03 | 已修 | `src/service/local-dsh-host.ts`、`src/service/chat-display.ts`、`tests/integration/local-dsh-host.spec.ts`。服务按会话租用，关闭且无在跑运行的会话会被回收；第 9 个会话得到容量原因，不再提示检查会话或默认模型。 |
| H04 | 已修 | `src/client/dsh-local-panel.tsx`。把调用方的 `AbortSignal` 直接交给最终 `fetch`，切会话后旧 SSE 确实被取消；`tests/client/dsh-local-panel.spec.tsx` 由失败转为通过。 |
| C08 | 受限 | DSH `0.2.2` 未向插件提供“针对原请求的进度区”。当前只能在预规划结束后给出第一条回执。要满足“规划中即时状态”，需要宿主开放 step 内进度事件；在此之前不引入“先返回后启动”的异步放行，以免破坏确定性接单。 |

## 第二批　任务表改版

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| C01 | 已修 | `src/service/chat-native.ts`、`tests/integration/chat-native.spec.ts`。工具守卫只在已接管、来源回报与便条回合生效；普通问答交回宿主授权。 |
| C02 | 已修 | 同上。同一批多条消息各占一轮，其余显式放回宿主下一轮，各自保留来源与幂等键；新增批次用例断言一次运行一条消息。 |
| C04 | 已修 | `chat-native.ts`、`chat-display.ts`。附件未纳入、只有附件、目标为空、超出字数分别给出可操作原因。 |
| C05 | 已修 | `src/service/chat-task-intent.ts`。保护条件（不要改原件、不要执行命令）不再被当成整项延期；补齐“审计/排查/梳理/清点”动作词。三个原反例与“先不要执行”都有用例。 |
| C03 C06 C07 C09 C10 C11 | 待办 | 澄清草稿续接、拒绝启动后的状态、完整计划查看、材料入口、会话内停止、触发器写入口。 |
| P01 P02 P03 P05 P06 | 待办 | 未启动计划占表、手选流程约束、选流程先截断、文字交付类型、子流程能力声明。 |
| P04 | 待办 | 计划复核页把执行标识当人工解释。 |
| T01 T02 T03 | 已修 | 新迁移 `069_task_human_work_projection.sql` + `queries/tasks.ts` + `queries/attention.ts` + 任务卡。当前根运行的整棵运行树纳入人工事项：子流程决定计数、成果留验与返工都进“等你处理”；运行次数只算根启动；未派发（queued/blocked_pre/waiting/dispatched）的可补偿步骤不再算外部操作待核验。 |
| T04 T05 T06 T07 T08 T09 | 待办 | 步骤/尝试口径、200 条尝试分页、51 份成果游标、实时刷新保持位置、看板未加载与暂无任务、正常等待分组。 |
| T10 T11 T12 T13 T14 T15 T16 | 待办 | 任务表人读行、结果首屏、步骤标题兜底、来源字段、窄屏摘要、会话范围提示、回执直达入口。 |

## 第三批　交付与返工

| 编号 | 状态 | 落地位置与说明 |
| --- | --- | --- |
| D01 | 已修 | `src/service/task-planning.ts`、`src/service/chat-display.ts`、`tests/contract/task-planning.spec.ts`。计划阶段按宿主生产器能力校验：二进制扩展名不得当作文本交付；会话回执明确“自动核对只覆盖登记、大小与有效期”。 |
| D02 | 已修 | 同上。同一节点超过 8 份、单份最低字节超过 65536 时不可 ready，并给出具体文件、需求值与能力值。 |
| D04 | 已修 | `src/service/delivery-review.ts`、`tests/contract/s6-run-ownership.spec.ts`。验收与撤销都按 `status='held'` 比较并交换，旧页面拿不同操作号提交会收到 `STALE_GENERATION`，已提交结论不被覆盖。 |
| D06 | 部分 | 任务表/看板已把无文件留验投影成“成果待验收”（迁移 069），不再出现“阻塞但无待办”；会话审核卡仍按“必须有文件”渲染，补交/撤销出口待做。 |
| D07 | 部分 | 返工进入 `proposed/needs_human_approval/escalated` 时已计入任务关注与看板分组；原会话的主动提醒仍待做。 |
| D03 D05 D10 | 待办 | 多文件同组验收、多文件返工出口、终态后修订入口。需要先落“当轮应审清单”这一层数据。 |
| D08 D09 D11 | 待办 | 未读先通过的门控、最终版按验收绑定解析、Markdown 安全预览。 |

## 已知环境限制

- `tests/e2e/package-install.spec.ts` 在本机（Git Bash，GNU tar 1.35）用 `C:\` 绝对路径打 tgz 会报 `Cannot connect to C: resolve failed`，与本轮改动无关；换 bsdtar 或 WSL 环境再跑。
- 全量套件在本机并行执行时，个别 5 秒级用例（`fault-s6`、`native-chat-routing-settings`）会因机器负载超时，单独执行均通过。

## 下一步建议

1. 先做 T01–T03 与 D03/D06/D07 共用的“人工事项投影”读模型：它是任务表、会话通知与审批中心三处口径一致的根。
2. 再做 C03/C05 的澄清草稿与限制语解析，它们共享同一段消息分类。
3. D05/D10 需要“当轮应审清单 + 终态修订任务”两个结构，建议与 D03 一起设计，避免两次改表。
