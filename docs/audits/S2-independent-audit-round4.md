# S2 第四轮独立审计报告（门 G2 复核）

**结论：fail** —— 致命 0 / 重大 5 / 不阻断 5。第三轮 R3-01…R3-12 十二条问题在本轮复核为「闭合 11 / 部分闭合 1」，但 G2 门在当前仓库状态下**放不了**：两道门的门检查都跑不过（`node scripts/gate-check.ts docs/gates/G1.md` 与 `… G2.md` 均 exit 1），且存在 4 条本轮新认定的重大缺口（工具白名单未生效、单写者锁与 epoch 未接启动路径、租约心跳未实现、门记录与 HEAD 漂移）未在门记录中披露。

| 分级 | 条数 | 编号 |
| --- | --- | --- |
| 致命 | 0 | — |
| 重大 | 5 | M1 门记录与 HEAD 漂移（两道门当前均不过）、M2 工具白名单 allow/deny 未生效、M3 单写者锁与 epoch 栅栏未接启动路径、M4 租约心跳未实现（lease_ttl 30s < action_timeout 120s）、M5 `applyReport` 仍收 policy 参数（规格 §4.2:293 明文要求「policy 不在参数里」，第三轮已登记、声明移交 S3） |
| 不阻断 | 5 | N1 ev-g2-08 不是字节可复现、N2 ADDED_THEN_DELETED 恢复路径无单测、N3 门记录无密码学签名且校验脚本自身无独立锚点、N4 tests/gate-check.spec.ts「G1 门记录通过」在并行全量下超时（flaky）、N5 门记录复现命令写 `pnpm`，本机 pnpm 不可用 |

放行口径是「0 致命、0 重大」。本轮致命为 0，重大为 5，**结论 fail**。即使把 M5（已登记延后项）单独剔出去，M1–M4 四条仍然构成阻断。

> 一处必须先说明的事实偏差：任务书写 HEAD=98dee52，实际审计时 HEAD=`c290a7d`。`7689778`、`c290a7d` 两笔只动文档（`handoff.md` 与 `docs/reviews/2026-11-13-external-architecture-review.md`），不动代码，但 `c290a7d` 新增的文档落在两道门的候选范围内（`scripts/gate-check.ts:116-118` 的 `excludes` 只有 `docs/gates`、`docs/audits`、`handoff.md`），因此两道门的 candidate_hash 全部漂移。这是 M1 的根因。

---

## 一、审计范围与方法

### 1.1 基线

| 项 | 值 |
| --- | --- |
| 仓库 / 分支 | D:\aboutAI\dsh-orchestra，main |
| 审计时 HEAD | `c290a7d`（`git log --oneline -3`：c290a7d / 7689778 / 98dee52） |
| 提交链 | `4f3ada7`（范围基线 + 规格 v1.4）→ `c13814e`（第三轮整改代码与证据）→ `a5d0707`（重签 G1）→ `98dee52`（重签 G2）→ `7689778`（handoff）→ `c290a7d`（外部静态评审留档） |
| 工作树 | 审计开始时干净（`git status --porcelain` 为空）；审计全程只写 `docs/audits/S2-independent-audit-round4.md` |

### 1.2 读了什么

- 审计对象：`docs/audits/S2-independent-audit-round3.md`（285 行，第三轮：致命 3 条 R3-01/02/03、重大 9 条 R3-04…R3-12）。
- 实现方自证：`docs/audits/S2-round3-response.md`（只作线索，不作放行依据；每条结论都另做独立验证）。
- 计划与规格：`docs/superpowers/plans/2026-11-12-dsh-orchestra-s2-agent-loop.md`、`docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md`（重点 §4.2 行 286-305、§4.4 行 313-342、§5.2 行 444-445、§5.3 行 452-460、§6.1 行 528-538、§17.1 行 1286-1309、行 105）。
- 门记录：`docs/gates/G1.md`（313 行）、`docs/gates/G2.md`（415 行）。
- 实现与测试：`src/executor/run-node.ts`、`src/executor/session.ts`、`src/executor/tools.ts`、`src/executor/bridge.ts`、`src/core/clock.ts`、`src/core/policy.ts`、`src/core/errors.ts`、`src/core/state-machine.ts`、`src/core/config.ts`、`src/core/workflow-def.ts`、`src/service/sweep.ts`、`src/service/server.ts`、`src/service/workflows.ts`、`src/service/dispatcher.ts`、`src/service/commands/{apply-report,node-state,runtime,lease,cancel}.ts`、`src/infra/lock.ts`、`src/infra/db/open.ts`、`src/infra/sqlite/driver.ts`、`src/index.ts`，以及 `tests/` 下 31 个 spec 与 `scripts/{gate-check,sign-gate,fault-inject}.ts`。

### 1.3 怎么验的（每条结论的取证方式）

1. **改法是否在生产路径**：只认生产装配（`src/index.ts` → `src/service/server.ts` / `src/service/dispatcher.ts` → `runNode` / `applyReport` / `sweep`）上可达的代码；只存在于单测里的改法一律判未闭合。
2. **回退可测性**：对每条 R3 条目找出会因回退而失败的用例，并核对该用例确在生产装配上跑（不是 mock 出来的假路径）。
3. **证据可复算**：对 `docs/gates/evidence/**` 每份文件按 LF 归一后重算 sha256，与 G2 的正文表（`G2.md:60-76`）、evidence-index 块（`G2.md:270-349`）、`artifact.evidence_map` 三方逐份比对；G1 同理（`G1.md:33-45`）。
4. **门可绕过检查**：逐行读 `scripts/gate-check.ts` 的校验链，并在临时克隆上跑 10 条篡改向量（见 5.4）。
5. **全量验证**：`tsc --noEmit`、`vitest run`（记录真实文件数与用例数）。
6. **门检查实跑**：G1、G2 各跑一次，记录真实退出码与输出。
7. **证据可复现**：把门记录声明「重跑字节不变」的 12 个 case 全部重跑，逐份 `git diff` 比对，跑完 `git checkout -- docs/gates/evidence` 还原。

---

## 二、R3-01…R3-12 逐条复核表

| 编号 | 第三轮说的 | 我验到的（文件:行 / 命令输出） | 判定 |
| --- | --- | --- | --- |
| R3-01（致命） | 工具 exitCode≠0 仍可能落 node done；判定只查 `evaluatePassConditions([])`；证据痕迹没进账本 | 生产路径已改：`src/executor/run-node.ts:135` 退出非 0 即 break，`:143-153` 由系统判失败 → `markBlocked(deps,p,'tool_execution_failed')` + `throw OrchError('VERDICT_POLICY_UNMET', …)`（`:148`），痕迹同时入 `tool_executions` 表与 `tool_finished` 事件（`:111-134`）。回退可测：`tests/runtime.spec.ts:64-152`「判定条件不满足：exitCode 不是 0 就不许 done」断言节点停在 `blocked_post` 且 verify_human 理由为 `tool_execution_failed`；回退 `:143-153` 即失败。证据 `ev-g2-08` 重跑出同样的账本片段与 `VERDICT_POLICY_UNMET` | 闭合 |
| R3-02（致命） | 判定时限拿墙钟比，墙钟 +10 分钟会误判 verifying→blocked_post；迁移 002 缺 boot_id/单调纳秒配对 | 判定已改为只认锚点：`src/service/commands/node-state.ts:77-88` 进 verifying 时写 `verify_deadline_boot_id` / `verify_deadline_monotonic_ns`（墙钟列只作展示），离开时四个字段全清；`src/service/sweep.ts:86-93` 用锚点建截止，`:57-62` 缺锚点即 `timer_uncertain`，`src/core/clock.ts:52-62` boot 变→`boot_changed`、漂移>2000ms→`clock_drift`、否则按 remaining 判 `expired`。回退可测：`tests/sweep.spec.ts:181,193,208` 三条 `timer_uncertain` 用例。证据 `ev-g2-09` 重跑字节不变 | 闭合（规格 §4.4:330/341/342 的「按 remaining 重挂」仍未实现，见遗留 e5） |
| R3-03（致命） | 生产 HTTP 上报入口接受弱/空证据即可落 done；账本只存 evidence_digest，伪造不可辨 | 入口已加两道系统级门：`src/service/commands/apply-report.ts:274-282`（无证据→`evidence_missing`；source≠`run_tool`→`verification_too_weak`；exitCode 非 0→`tool_execution_failed`）与 `:285-295`（按 `tool_executions` 的 exit_code+stdout_hash 反查痕迹，对不上→`evidence_unverifiable`）；策略由服务端解析：`src/service/workflows.ts:43-53` `policyFor` 合并模板与节点的 `required_hashes`，`src/service/commands/runtime.ts:38-57` 从 run 的 workflow_version 反查，调用方带不进策略。回退可测：`tests/apply-report.spec.ts:243-303`（伪造强证据、弱来源、空证据三例）。证据 `ev-g2-10` 重跑字节不变 | 闭合 |
| R3-04（重大） | `report_replayed` 事件无界，rejected↔replayed 循环每次追加 | 三处追加点均加了幂等守卫 `hasNodeRunEvent(tx, nodeRunId, 'report_replayed', report_id)`：`src/service/commands/apply-report.ts:111-123`（applied→replayed）、`:124-134`（replayed）、`:135-160`（rejected→重放）。回退可测：`tests/apply-report.spec.ts:143-149`、`:243-264`「report_replayed 只留一条」。证据 `ev-g2-11` 账本片段显示四次 HTTP 均 200、`report_replayed` 只有 1 条、`report_applied` 0 条，且重跑字节不变 | 闭合 |
| R3-05（重大） | G2 artifact 的 producer=`agent:七七`，规格 11.3 要求 G1–G5 为 human；门检查只对 G1 强制 human | `scripts/gate-check.ts:469` 现在对所有门强制 `producer === 'human'`（规格 11.3 行 981），G1/G2 记录均为 `"producer": "human"`（`G2.md:264`、G1 同）。篡改实测：把 G2 的 producer 改成 `agent:七七` → 「门检查失败：producer 必须是 human（规格 11.3 行 981）: agent:七七」 | 闭合 |
| R3-06（重大） | 门检查只验 evidence-index JSON 与 artifact.exceptions，不验正文「证据文件与哈希」表与「例外」表 | `scripts/gate-check.ts:313-330` `checkBodyEvidenceTable`（逐行比对 id/文件/sha256）、`:333-349` `checkBodyExceptions`（比对码/类型/HTTP/说明）。篡改实测：正文表 sha256 全改 0 → 「正文证据表里 ev-g2-01 的 sha256 与 artifact 不一致（证据被改过或表没跟着改）」；例外表 HTTP 409→200 → 「正文例外表里 LEASE_EXPIRED 的 HTTP 与 artifact 不一致: 200 != 409」 | 闭合 |
| R3-07（重大） | 门检查不拦脏工作树，`DIRTY_IGNORES` 含 `docs/gates` | `scripts/gate-check.ts:175` `DIRTY_IGNORES = ['docs/audits','handoff.md']`，`:177-184` `assertClean` 用 `git status --porcelain`（含未跟踪文件）。篡改实测：改一个字不提交 → 「工作树有未提交改动，门记录不能对着脏树签：M docs/gates/G2.md」；放一个未跟踪文件同样被拦 | 闭合 |
| R3-08（重大） | 重签可换 producer、可换绑证据到别的必过项，无签名、无前序链、无证据↔断言语义校验 | `scripts/gate-check.ts:394-402` `checkEvidenceMap`（必过项↔证据固定映射）、`:405-419` `checkPreviousChain`（前序门 artifact_hash 取自 HEAD）、`:422-431` `checkAuditAnchor`（审计报告须在 HEAD、路径里的 round 数与 `audit_round` 相符）、`:372-391` 正文 `body_hash` 自锚、`:446-470` 治理字段（approver 必须 `human:<名>`、approved_at ISO、producer=human）。篡改实测：换绑 G2-01→ev-g2-02 后重签被拒「必过项 G2-01 的证据与固定映射不一致（换绑证据不许重签）：ev-g2-02 != ev-g2-01」（`scripts/gate-check.ts:400`，经 `scripts/sign-gate.ts:75` 抛出）；改 `previous_artifact_hash` → 「previous_artifact_hash 与前序门记录的 artifact_hash 不符（重签链断了）」；改 `body_hash` → 「body_hash 与正文不符：0000… != e6d03e972f289651…（正文改过就重签）」 | 闭合 |
| R3-09（重大） | candidate 清单漏掉「批内新增后又删除」的文件（51 vs 52 条路径） | 恢复逻辑在 `scripts/gate-check.ts:162-169`（`git log --name-only --diff-filter=A,D`）与 `:195-206` `candidateEntries`（HEAD 无字节时写 `DELETED`/`ADDED_THEN_DELETED` 占位）。探针实测：在临时克隆上于 98dee52 之上「新增 probe 文件」再「删除 probe 文件」两笔提交，门检查报「candidate_hash 与候选文件不符：da60a01647eac9c8… != d2e87bec17b9709a…」→ 候选集合确实变了（多出一条批内新增又删除的路径），且 `git log --diff-filter=AD` 的报错被占位逻辑兜住、脚本不崩。**但** `tests/` 全仓递归 grep `ADDED_THEN_DELETED` 零命中 → 机制有效却无单测护栏（记 N2） | 闭合（缺单测，记不阻断） |
| R3-10（重大·偏轻） | 计划写 cancelResult 非法值返 400，实现返 422 | 实现与计划现已一致：`src/service/server.ts:220-224` 枚举校验失败抛 `PAYLOAD_SCHEMA_INVALID`（`src/core/errors.ts:68` = 422），S2 计划 `2881` 行已改为「cancelResult 只许四个枚举值，非法值 422」。HTTP 层有 422 断言（`tests/routes.spec.ts:111-117`），但该用例针对「缺字段」而非 cancelResult 枚举——枚举分支无专门用例（记入本条不另开条目） | 闭合 |
| R3-11（重大） | G-07 证据只覆盖动作时限；G2-05 证据只覆盖缺字段不覆盖弱/空证据；不变量 I4 指向无关证据；ev-g2-02/03/04 只是单测指针 | 必过项由 11 条扩到 15 条（`G2.md:23-37`）：新增 G2-08…G2-11，G-07 改绑 `ev-g2-09`（`G2.md:33`），G2-05 改绑 `ev-g2-05,ev-g2-10`（`G2.md:27`）。不变量 I4=ev-g2-05/08/10/g07、I6=ev-g2-09、I7=ev-g2-11（`G2.md:105-111`，指向已存在证据）。G2-02/03/04 已改由 HTTP 真实入口重跑重生成。15 份证据的 sha256 我逐份重算，与正文表、evidence-index 块、磁盘字节三方一致；声明可字节复现的 12 个 case 全部重跑字节不变 | 闭合 |
| R3-12（重大） | `BRIDGE_ACK_LAG` 只在 `src/executor/bridge.ts:95` 抛出，而 `bridge.ts` 无任何生产装配引用，S2 内不可复现 | 登记口径已闭合：`G2.md:91` 例外表明确写「S2 生产路径未接桥调用，本轮不可复现，留 S3（F-06）」，三个提案码统一由 `src/core/errors.ts:92-96` 的 `proposedError` 出、`details.proposed=true`。代码口径未闭合：全仓递归 grep 确认 `src/executor/bridge.ts` 未被任何生产模块 import，`BRIDGE_ACK_LAG` 唯一抛出点仍是 `bridge.ts:95` | 部分闭合（登记已披露且不与任何必过项挂钩 → 不阻断；代码路径可移交 S3，见遗留 e1） |

**小结**：R3-01…R3-12 共 12 条 → 闭合 11、部分闭合 1（R3-12，仅剩代码路径与 F-06 一并移交 S3）。第三轮的三条致命与九条重大，从「是否真在生产路径、是否可被回退测出来、证据是否可复算」三个角度都复验通过。第三轮列出的十条门绕过向量，本轮在临时克隆上逐条实测**全部被拦**（见 5.4）。

---

## 三、新发现问题

### 3.1 重大（放行阻断）

**M1 门记录与 HEAD 漂移，两道门当前都跑不过（可机械修复）**

- 现象：`node scripts/gate-check.ts docs/gates/G1.md` 与 `… docs/gates/G2.md` 均 exit 1，报「candidate_hash 与候选文件不符」。
- 根因：门记录在 98dee52 签定，`c290a7d` 又提交了 `docs/reviews/2026-11-13-external-architecture-review.md`；该路径不在 `scripts/gate-check.ts:117` 的 `excludes` 里，候选集合由 53 条变 54 条，`candidate_hash`、`change_scope_hash` 随之变。
- 复现：
  ```
  > node scripts/gate-check.ts docs/gates/G1.md
  门检查失败：candidate_hash 与候选文件不符：15fd9c509e817a10… != d6ae7bceb9ba396b…   (exit 1)
  > node scripts/gate-check.ts docs/gates/G2.md
  门检查失败：candidate_hash 与候选文件不符：da60a01647eac9c8… != 325d3d7f73b8f4b2…   (exit 1)
  ```
  我按项目自己的 `candidateEntries` 重算：paths=54，candidate=325d3d7f73b8f4b2c1527731f616a7023206d5406261d53b75f4ba06cc2ddcbe，scope=dc3b194c46e72490db1d5f28e1ccf0f3259845f056730d5b9983d21089d370cd；记录里签的是 da60a01647ea… / 4ec3a3f5…。
- 判定：候选绑定机制本身是对的（漂移被检出，不是被绕过），但门记录处于「结论写着 pass、检查却不过」的状态——这正是「把未验证的结论当已验证」。必须在按本轮结论重签后才能放行。位置：`scripts/gate-check.ts:433-443` `checkCandidate`、`:534` 调用点。

**M2 工具白名单 allow/deny 在生产路径上不生效**

- 现象：编排侧执行节点时，只校验「声明的策略」是否 pure，不校验实际执行的那个工具是否在 allow 内、是否在 deny 内。
- 位置：`src/executor/run-node.ts:50` `checkToolPolicy(deps.registry, p.toolPolicy)` 只针对声明；真正执行是 `:81` `for (const tool of p.tools)` → `:98` `deps.registry.require(tool.command)`；deny 在这条路径上从未被查询。`src/executor/session.ts:25-33` 的 `resolveToolSet`（allow 减 deny）只服务于 executor 子智能体（`:113-129`），编排侧执行器不走它。
- 生产路径证据：`tests/runtime.spec.ts:48,73,91,110,137` 全部传 `toolPolicy { allow: [], deny: [], declaredPolicy: 'pure' }`，却照样执行 `ro.echo` / `ro.fail`。
- 与规格冲突：规格 `行 445`「工具集按 allow / deny 给；未声明默认不给」、`行 1090` 同义；S2 计划 1144-1146 / 1165-1172 同口径。
- 影响面（不夸大）：`src/executor/tools.ts:155-163` 仍要求「命中注册表且 capability 必须是 read_only」，因此越权面限于只读工具；但**未声明的、或者被 deny 的只读工具，今天是可以被执行的**。仓库自己那份外部静态评审（`docs/reviews/2026-11-13-external-architecture-review.md`）也把它记为 P0。

**M3 单写者锁与 epoch 栅栏未接启动路径**

- 现象：规格行 105 明文要求「服务用操作系统文件锁声明进程所有权；每次启动把 epoch 旧值加一；所有写事务……带当前 epoch」，但这两样都没进启动链。
- 位置：`src/infra/lock.ts:4` `acquireDbLock`、`src/infra/db/open.ts:6` `bumpEpoch`、`:22` `openServiceDb` 在 `src/` 内**零引用**（只在 `tests/db-open.spec.ts:54-71` 用过）；`src/index.ts:42` `createOrchestra` 走的是 `src/infra/sqlite/driver.ts:27` `openDb`，而 `driver.ts:45-49` 只**读** `instance_epoch`。epoch 栅栏本身在 `driver.ts:75-92` 的 `withTx` 里（不匹配就抛 `STALE_GENERATION`），但没有任何生产代码会递增 epoch ⇒ 两个进程同时打开同一个库会读到同一个 epoch，双双通过栅栏。
- 判定：规格强制项未实现，属实现与规格不一致；外部评审同样记为 P0。

**M4 租约心跳未实现，lease_ttl 30s < action_timeout 120s**

- 现象：配置声明了 10 秒心跳，代码里没有任何一处按心跳续租；节点执行期间也不续租。
- 位置：`src/service/commands/lease.ts:86-99` `renewLease`（写 `lease_expires_at`/`heartbeat_at`）存在，但 `src/service/server.ts` 的路由表里**没有续租路由**（全部路由见 `server.ts:133-233`：tasks / events / workflows/load / runs / runs/dispatch / node-runs/lease / node-runs/report / node-runs/run / node-runs/cancel / ledger/events）；`src/index.ts:134` 只是把 `renewNodeLease` 再导出，没有任何调用方；`src/executor/run-node.ts` 执行期只用 `p.now`，不续租。
- 后果（可复算）：`G2.md:45` lease_ttl_ms=30000，`G2.md:47` action_timeout_ms=120000；`src/service/commands/lease.ts:127-153` 的 `sweepExpiredLeases` 对 status∈(dispatched,started) 且租约过期的行改判 `stopping`/`startup_unknown`，`src/service/sweep.ts:31-33` 每 2 秒跑一次（`src/index.ts:108-115`）⇒ 任何超过 30 秒的合法动作必然被判租约过期。S2 计划 `行 17` 把「节点租约与心跳」列进本批范围，`行 2827` 自己写了「若实测中模型执行普遍超过 30 秒没回心跳，就会出现『节点在跑但被判过期』」，并定值「心跳 10 秒」——心跳没实现。
- 附带：HTTP 派发允许客户端自带 TTL（`src/service/server.ts:215` `body.leaseTtlMs`），配置里的 `lease_ttl_ms` 没接进派发路径。

**M5 `applyReport` 仍收 policy 参数（规格 §4.2:293 明文「policy 不在参数里」）**

- 位置：`src/service/commands/apply-report.ts:90-95` `applyReport(tx, secret, params, policy)`；规格 `行 290` 的签名没有 policy，`行 293` 写「policy 不在参数里。服务按 node_run_id 找到 run 的 workflow_version，再载入不可变模板的 verification_policy 与 evidence_source，调用方不能自带策略」。
- 已闭合的部分（信任面）：生产调用方 `src/service/commands/runtime.ts:38-57` 确实按 workflow_version 反查策略，HTTP 调用方带不进策略 ⇒ **安全面已闭合**，只剩签名面未按规格收口。
- 判定：按口径属「实现与规格不一致」= 重大；第三轮审计 §7.5 已登记、声明移交 S3（`G2.md:15` 亦写明），本轮不作为新增阻断项单独计一条，但复审时必须明确它在 S3 的落点。

### 3.2 不阻断（记录，不挡放行）

| 编号 | 内容 | 位置 / 复现 |
| --- | --- | --- |
| N1 | `ev-g2-08` 不是字节可复现：工具行的 `command_hash` 把临时工作目录路径算进哈希（`src/executor/tools.ts:136-138` `commandHashOf(command,args,cwd)`，cwd 由 `resolveInside(workspaceRoot, tool.cwd)` 得到，workspaceRoot 是每次新建的临时目录），两次重跑得到两个不同值（138713b3… 与 f0c18f18…）。其余字段（stdout_hash、状态、事件、`VERDICT_POLICY_UNMET` 文案、verify_human 理由、report_registry）完全一致。门记录 `G2.md:80` 的「重跑字节不变」只声明 ev-g2-02/03/04/05/06/07/11 与 G-03/04/05/07，**未**声明 ev-g2-08 ⇒ 措辞不假，但绑定必过项 G2-08 的证据不是逐字节可复现的 | `node scripts/fault-inject.ts --case ev-g2-08` 后 `git diff --stat docs/gates/evidence` → 仅 `ev-g2-08.md` 变 |
| N2 | `ADDED_THEN_DELETED` 恢复路径没有任何单测（`tests/` 递归 grep 零命中），只有本轮探针实测过 | `scripts/gate-check.ts:162-169,195-206` |
| N3 | 门记录没有密码学签名（`approver` 只是字符串 `human:啸春`）；更值得注意的是 `scripts/gate-check.ts` 与 `scripts/sign-gate.ts` 本身就在候选范围内，却没有被任何锚点哈希单独钉住，只靠 `candidate_hash`（任何审计者都能重算）间接绑定 | `G2.md:264`、`scripts/gate-check.ts:41-121` |
| N4 | `tests/gate-check.spec.ts` 的「G1 门记录通过」在并行全量下超时失败（vitest 默认 5000ms，实测 6137ms），单独跑该文件 22 例全过（4049ms）⇒ flaky 用例，非断言失败 | 见 5.3 |
| N5 | 门记录复现命令写 `pnpm check` / `pnpm vitest`（`G2.md:80`），本机 pnpm 不可用（cmd.exe /c pnpm.cmd 报「命令语法不正确」）；改用 `D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit` 与 `node_modules/vitest/vitest.mjs run` 才跑得通 | `G2.md:80` |

### 3.3 第三轮遗留五条的移交核对（任务书第二·7）

| 遗留 | 现状（我实测） | 能否本轮闭合 | 是否挡 G2 |
| --- | --- | --- | --- |
| e1 F-06 桥 spill 未接生产路径 | `src/executor/bridge.ts` 在 `src/` 内无任何 import；`BRIDGE_ACK_LAG` 唯一抛出点 `bridge.ts:95`；门记录例外行已披露（S2 不可复现，留 S3） | 否（S2 不接桥是范围决定） | 否（已披露） |
| e2 `applyReport` 仍收 policy 参数 | 签名仍带 policy（`apply-report.ts:90-95`），但信任面已闭（`runtime.ts:38-57`） | 否（要改签名与全部调用点） | 否（M5 计入重大，按口径判 fail，可随 S3 闭合） |
| e3 四条新路由在规格 §6.1 无落点 | 属实：规格 §6.1（行 528-538）是「四个流程命令」workflow.create/open_draft/update/publish，属 S4-S6 发布模型；全文检索 `POST /v1` **零命中** ⇒ S2 的 HTTP 路由只由 S2 计划（`行 2878-2881`）定义 | 否（要改规格） | 否 |
| e4 DECISION_REQUIRED / BRIDGE_ACK_LAG 未进规格 §17.1 | 属实：§17.1（行 1286-1309+）无这三个码；实现走 `src/core/errors.ts:92-96` 的 `proposedError`，强制 `details.proposed=true`；门记录例外表已登记三码及 HTTP | 否（要改规格） | 否（已按提案码登记） |
| e5 `verify_remaining_ns` 的 remaining 重挂语义 | **仍是死列**：全仓递归 grep 显示它只在 `src/service/commands/node-state.ts:81,87` 被写/清、`scripts/fault-inject.ts:853` 被打印、`tests/migrate-s2.spec.ts:49` 断言列存在，没有任何判定路径读它；规格 §4.4:330/341/342 要求的「按 remaining 重挂、remaining 为 null 才补满额并 Gr 加一」与跨 boot 的 remaining 公式没有生产实现（`src/core/clock.ts:92-98` `remainingAcrossBoot` 只被 `tests/clock.spec.ts:61,65` 用）。现状是超时按固定 budget 判 `verify_timeout` | 否（属 S3 范畴） | 否（但须写进 S3 范围，否则 R3-02 的语义只闭了一半） |

结论：五条遗留**都可以移交 S3**，其中 e5 需要在 S3 计划里点名「remaining 重挂语义」为必做项；本轮没有发现「其实已能闭合」或「会挡 G2」的项（e2 按口径计入重大 M5）。

---

## 四、复现命令与实际输出

### 4.1 类型检查与全量用例

```
> D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit
（无输出，exit 0，0 类型错误）

> D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run
 Test Files  1 failed | 30 passed (31)
      Tests  1 failed | 270 passed (271)
   Duration  18.67s
 ❯ tests/gate-check.spec.ts (22 tests | 1 failed) 17682ms
 × G1 门记录通过 6137ms
   Error: Test timed out in 5000ms.
```

失败项是超时不是断言失败：单跑该文件 `D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/gate-check.spec.ts` → 22 例全过，「✓ G1 门记录通过 4049ms」。→ N4。

### 4.2 门检查（当前 HEAD = c290a7d）

```
> node scripts/gate-check.ts docs/gates/G1.md
门检查失败：candidate_hash 与候选文件不符：15fd9c509e817a10… != d6ae7bceb9ba396b…   (exit 1)

> node scripts/gate-check.ts docs/gates/G2.md
门检查失败：candidate_hash 与候选文件不符：da60a01647eac9c8… != 325d3d7f73b8f4b2…   (exit 1)
```

同一命令在重签时的基线（98dee52，工作树干净）下是：

```
> node scripts/gate-check.ts docs/gates/G2.md
gate G2 通过（15 项必过、15 份证据哈希复核，artifact_hash=884a606523f2… body_hash=e6d03e972f28…）   (exit 0)
> node scripts/gate-check.ts docs/gates/G1.md
gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=7c371df81692… body_hash=ba3f37c3e53a…）   (exit 0)
```

### 4.3 证据哈希复算（LF 归一）

对 `docs/gates/evidence/**` 逐份重算 sha256，与 `G2.md:60-76` 正文表、`G2.md:270-349` evidence-index 块、`artifact.evidence_map` 三方比对：**15/15 一致**（ev-g2-01 f10efac9… / 02 346af581… / 03 784e44b6… / 04 65946e22… / 05 74c0a947… / 06 cef5cf3d… / 07 607471ff… / 08 c4e9c529… / 09 f43b5098… / 10 d82a2248… / 11 05c1c8ea… / g03 514f9754… / g04 fb68366d… / g05 2f7da35a… / g07 8898db13…）。G1 的 13 项（含 6 份证据 + 7 个测试文件）同样全部一致。正文表、`artifact.must_pass_items`、`GATE_SPECS.evidenceMap` 三者条目数、顺序、内容、绑定的证据全部同源，无多无缺、无绑错。

### 4.4 门绕过矩阵（在临时克隆 %TEMP%\orch-audit4-tamper 的 98dee52 上逐条实跑，每条后 `git reset --hard 98dee52` 还原）

| 向量 | 结果 |
| --- | --- |
| 基线（干净树） | gate G2 通过（exit 0） |
| T1 正文证据表 sha256 → 全 0 | 被拦：正文证据表里 ev-g2-01 的 sha256 与 artifact 不一致（证据被改过或表没跟着改） |
| T2 例外表 HTTP 409 → 200 | 被拦：正文例外表里 LEASE_EXPIRED 的 HTTP 与 artifact 不一致: 200 != 409 |
| T3 证据文件改 1 字节 | 被拦：证据文件 sha256 不符: ev-g2-01（记录 f10efac98f2d0d91… 实际 29655bd8995d63af…） |
| T4 evidence-index 块 sha256 → 0 | 被拦：证据文件 sha256 不符: ev-g2-01（记录 0000000000000000… 实际 f10efac98f2d0d91…） |
| T5 必过项内容列改字 | 被拦：正文表里 G2-01 的内容与固定表不一致：单节点 queued 到终态一条路径 != 单节点 queued 到终态一条路径（走生产装配） |
| T6 producer → agent:七七 | 被拦：producer 必须是 human（规格 11.3 行 981）: agent:七七 |
| T7 换绑证据（G2-01→ev-g2-02）后重签 | 重签被拒：必过项 G2-01 的证据与固定映射不一致（换绑证据不许重签）：ev-g2-02 != ev-g2-01（`scripts/gate-check.ts:400`），重签后再检查同样不过 |
| T8 脏工作树（改一个字不提交） | 被拦：工作树有未提交改动，门记录不能对着脏树签：M docs/gates/G2.md（放未跟踪文件同样被拦） |
| T9 `body_hash` 自锚改 | 被拦：body_hash 与正文不符：0000… != e6d03e972f289651…（正文改过就重签） |
| T10 `previous_artifact_hash` 改 | 被拦：previous_artifact_hash 与前序门记录的 artifact_hash 不符（重签链断了） |

（过程说明：第一次用内联命令跑这十条时，反引号在命令传输里被吞掉，十条篡改其实没落到文件上；改用写好的 .ps1 脚本重跑后，十条全部真实生效并全部被拦。上表是脚本化重跑的结果。）

### 4.5 证据可复现（逐个重跑 + `git diff` 比对，跑完 `git checkout -- docs/gates/evidence` 还原）

```
ev-g2-01: exit=0 BYTE-IDENTICAL     ev-g2-02: exit=0 BYTE-IDENTICAL
ev-g2-03: exit=0 BYTE-IDENTICAL     ev-g2-04: exit=0 BYTE-IDENTICAL
ev-g2-05: exit=0 BYTE-IDENTICAL     ev-g2-06: exit=0 BYTE-IDENTICAL
ev-g2-07: exit=0 BYTE-IDENTICAL     ev-g2-11: exit=0 BYTE-IDENTICAL
G-03:     exit=0 BYTE-IDENTICAL     G-04:     exit=0 BYTE-IDENTICAL
G-05:     exit=0 BYTE-IDENTICAL     G-07:     exit=0 BYTE-IDENTICAL
ev-g2-08: exit=0 但字节不一致（仅 command_hash 随临时目录变化；未被 G2.md:80 声明为字节不变）
```

还原后 `git status --porcelain` 为空；本轮未提交任何证据改动。

---

## 五、给门记录的建议结论句

本轮结论是 **fail**，因此本节不给「可直接写进 `docs/gates/G2.md`」的通过结论句，改为给出**复审通过所需的条件清单**（实现方按此修完，再提第五轮复审）：

1. **M1**：`c290a7d` 之后新增的文档落进了门的候选范围，导致两道门记录失效。要么把 `docs/reviews/` 纳入 `scripts/gate-check.ts:117` 的 `excludes`（并说明理由），要么在代码/文档定稿后按本轮结论重新签 G1、G2（`scripts/sign-gate.ts`），使 `node scripts/gate-check.ts docs/gates/G1.md` 与 `… G2.md` 同时 exit 0；G2 的 `audit_round` 须改为 4、`audit_report` 指向 `docs/audits/S2-independent-audit-round4.md`（`scripts/gate-check.ts:422-431` 会核对轮次与文件是否在 HEAD）。
2. **M2**：把 `src/executor/run-node.ts:81` 的执行集与 `p.toolPolicy.allow` 取交集、扣掉 `p.toolPolicy.deny`（可复用 `src/executor/session.ts:25-33` 的 `resolveToolSet`），并补一条「未声明/被 deny 的工具不可执行」的生产路径用例。
3. **M3**：把 `src/infra/lock.ts:4` `acquireDbLock` 与 `src/infra/db/open.ts:6,22`（bumpEpoch + openServiceDb）接进 `src/index.ts:41-46` 的启动链，让每次启动 epoch 旧值加一、写事务带当前 epoch（规格 行 105）。
4. **M4**：把租约续租接到生产路径（HTTP 续租路由 + 执行期按 `lease_renew_interval_ms` 心跳续租），并让 `lease_ttl_ms` 大于一次动作的合理时长（当前 30s < 120s，见 `G2.md:45,47`），补一条「长动作不被误判租约过期」的用例。
5. **M5**：按规格 §4.2:290/293 收掉 `applyReport` 的 policy 参数（策略一律服务端反查），或修改规格并在门记录里显式登记这条偏差——两者取其一，写在 S3 计划里。
6. **e5**：在 S3 计划里点名「按 remaining 重挂 + 跨 boot remaining 公式（规格 §4.4:330/341/342）」为必做项，消灭 `verify_remaining_ns` 死列。
7. **不阻断项**（不挡放行，但建议同批修）：ev-g2-08 的 `command_hash` 去随机化（把 cwd 归一为仓库相对路径，N1）、给 `ADDED_THEN_DELETED` 补单测（N2）、把 `tests/gate-check.spec.ts` 的超时用例放宽或提速（N4）、把 `G2.md:80` 的 `pnpm` 换成可直接执行的 node 命令（N5）。

复审触发条件：M1–M4 修完且 `tsc --noEmit` 与 `vitest run` 全绿、两道门检查 exit 0、M5 与 e5 有明确落点，本轮即可复审。

---

*审计员：第四轮独立审计（只读复核，未改 src/、scripts/、tests/、docs/gates/ 任何文件；本次提交只含本报告）*
