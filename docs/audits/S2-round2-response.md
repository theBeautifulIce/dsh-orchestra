# S2 第二轮审计整改对照表

- 审计报告：`docs/audits/S2-independent-audit-round2.md`（313 行，审计对象 HEAD `b42a479`）
- 本表用途：逐条对应审计提出的问题、这批的改法、拿什么证据说明改到了。**本表不作为放行依据**——G2 是否过关由第三轮独立审计决定。
- 审计判定口径（沿用审计自己的）：声称验了但实际未验到 = fail；测试通过但性质未覆盖 = fail；门证据与断言路径不符 = fail。

## 一、旧七条（F-01–F-07）

### F-01 生产路径：未修 → 已修

- 改法：新建 `src/service/runs.ts`（`createRun`：定义未加载报 NOT_FOUND、节点不在定义内报 SCHEMA_VERSION_UNSUPPORTED，事务内 INSERT tasks/runs/node_runs，节点状态 queued，追加 `task.created` / `run.created` 事件）；新建 `src/service/dispatcher.ts`（`dispatchRun`：按 seq 拾 queued 节点，无工具配置记 `skipped/no_node_spec`，否则调 `runNode`）；`src/service/server.ts:158-183` 新增 `POST /v1/runs` 与 `POST /v1/runs/dispatch`；`src/index.ts` 的 commands 增 `createRun` / `dispatch`。
- 证据：`docs/gates/evidence/G2/ev-g2-01.md`——从 `POST /v1/workflows/load` 起，经 `/v1/runs`、`/v1/runs/dispatch` 走到节点 done；账本片段与对账查询由 `node scripts/fault-inject.ts --case ev-g2-01` 重跑复现，连跑两次字节一致。
- 用例：`tests/production-path.spec.ts` 三条（一条路走完 / 定义没加载 404 / 节点缺工具配置跳过）。

### F-02 候选范围与 handoff：已修 → 仍成立，并按 N-09 加固

候选范围仍排除 `docs/gates`、`docs/audits`、`handoff.md`；删除文件已按 N-09 进入候选哈希（见下）。

### F-03 注入证据可复现：已修 → 仍成立

G-03 / G-04 / G-05 / G-07 四份证据由 `scripts/fault-inject.ts` 生成，各连跑两次字节一致；G-05 与 G-07 按 N-10 改成真实路径（见下）。

### F-04 重放验链/验队头：部分修 → 已闭合

- 改法：`src/service/commands/apply-report.ts:94-101`——registry 里同一 `report_id` 已属别的 `node_run_id` 时按结构错拒（`SCHEMA_VERSION_UNSUPPORTED`，details 给出 registered / requested），跨节点重放不再能改写别的节点。
- 用例：`tests/apply-report.spec.ts`「report_id 已属于别的节点 → 跨节点重放按结构错拒」。

### F-05 围栏期间 done 落账：部分修 → 已闭合

- 改法：围栏立着时取消（`not_interruptible` / `already_stopped` / `unknown`）只记取消结果、不改状态（`src/service/commands/cancel.ts:76-86`、`98-107`、`118-128`），不再出现「stopping 但仍 armed」的双主人状态；`revokeFence` 的 CAS 条件与状态不再互相打架。
- 用例：`tests/sweep.spec.ts`「围栏立着时再收 unknown：状态不动、围栏还在，宽限到点才撤围栏回 stopping」。

### F-06 桥二次 spill 丢早期事件：已修（单元层）→ **仍未闭合**

审计自己划的边界仍然成立：桥事件缓冲只在单元层复现，`src/executor/bridge.ts` 未接进 `runNode` 与服务生产路径。**这批没补**，列入 S3 前必须补的清单（见第五节）。

### F-07 终态取消改状态：已修 → 仍成立，并补上 queued 边界

终态取消仍返回 `already_stopped` / `terminal_no_out_edge` 且不写库；queued 取消按 N-08 补成 `superseded`。

## 二、新缺陷（N-01–N-11）

### N-01 致命：applyReport 绕过 I5，裸写 blocked_post → 已修

- 改法：`src/service/commands/apply-report.ts:201-231`——第六步改为走 `transitionNode`；阻塞类上报（`blocked_post` / `blocked_pre`）必须带凭据：`report.output.request.reason` 或 `report.error_code` 去空白非空即成立，取其一作 `verify_human.reason`，`request.missing` 取 `verify_human.missing`；两样都没有按 `reason='decision_required'` 拒收，**节点状态不动**（不再裸写 blocked_post）。
- 证据：`docs/gates/evidence/G2/ev-g2-06.md`——裸阻塞被拒 `decision_required`，带凭据的阻塞 accepted 并落 `blocked_post`，`verify_human` 事件 1 条；由 `node scripts/fault-inject.ts --case ev-g2-06` 重跑复现。
- 用例：`tests/apply-report.spec.ts` 三条（带请求理由落 blocked_post + verify_human 事件 / 什么理由都没有 → rejected + decision_required + 节点留在 verifying / 只带 error_code → 凭据成立）、`tests/integration/g2.spec.ts`「无裸 blocked」「带凭据的阻塞才算数」。

### N-02 致命：runNode 判定失败后永久 verifying → 已修

- 改法：`src/service/commands/node-state.ts:8-28` 增 `verifyTimeoutMs?`，进 `verifying` 时写 `verify_deadline_at = now + 预算`（缺省 `DEFAULT_VERIFY_TIMEOUT_MS = 120000`），离开半态清钟；`src/executor/run-node.ts:117-147` 收口被拒时转 `blocked_post` 并留 `verify_human`（`markBlocked`），不再留在 verifying 死等；`src/service/sweep.ts:35-58` 增加 verifying 超时扫描，到点转 `blocked_post` + `verify_human(reason='verify_timeout')`，逐行事务、单行失败不拖垮整批。
- 证据：`docs/gates/evidence/G2/ev-g2-05.md`——上报 started → verifying 后报 done（不带证据）被拒 `evidence_missing`，节点停在 verifying 且 `verify_deadline_at=2026-11-13T03:02:00.000Z`；由 `node scripts/fault-inject.ts --case ev-g2-05` 重跑复现。
- 用例：`tests/sweep.spec.ts`「判定时限到点：verifying 转 blocked_post 并留 verify_human；没到点不动」、`tests/runtime.spec.ts` 两条（进 verifying 挂钟、离开半态清钟）。

### N-03 致命：多工具节点只保留最后一个工具的 evidence → 已修

- 改法：`src/executor/run-node.ts:76-110` 每个工具落一条轨迹（`tool` / `exitCode` / `stdoutHash` / `stderrHash` / `commandHash`），整条列表写进报告的 `output.evidence_trace`；任一工具 `exitCode ≠ 0` 即中断后续工具，判定用的 `evidence` 就是那条失败证据，节点因此不可能落 `done`（转 `blocked_post` + `verify_human`）。口径登记在 S2 计划「口径补充」第 4 节。
- 用例：`tests/integration/g2.spec.ts` 与 `tests/runtime.spec.ts` 覆盖（详见提交说明）；轨迹字段见 `report.output.evidence_trace`。

### N-04 致命：围栏 + 迟到 unknown 导致 sweep 永久失败 → 已修

- 改法：见 F-05（围栏立着时取消不改状态）；另外 `src/service/sweep.ts:29-58` 改为逐行处理——围栏撤销与判定超时都按行 try/catch，单行失败跳过这一行并继续下一行，围栏撤销与 verifying 超时互不影响。
- 用例：`tests/sweep.spec.ts` 五条（围栏 + unknown、围栏期间上报排队与队头、扫描可重入、租约过期两种落位、判定时限到点）。

### N-05 重大：跨节点 report_id 重放 → 已修

见 F-04。

### N-06 重大：重复 replayed 事件无上限 → 已修

- 改法：`src/service/commands/apply-report.ts:112-126`——同一 `report_id` 的 `report_replayed` 事件只追加第一条，重复次数不再写进账本；`rejectReport`（`:58-65`）对同一条报告同因重复被拒也只更新 registry，不追加事件。
- 用例：`tests/apply-report.spec.ts`「同一条已 applied 报告反复重发：report_replayed 只留一条」「同一条报告重复被拒只更新 registry，不再追加事件」。

### N-07 重大：report.attempt 被忽略 → 已修

- 改法：`src/service/commands/apply-report.ts:161-167`——`report.attempt` 与请求 `attempt` 不一致（或节点当前 attempt 不一致）一律 `reason='attempt_mismatch'` 拒收，节点不动；registry 落库统一用 `report.attempt`。口径登记在 S2 计划「口径补充」第 3 节。
- 用例：`tests/apply-report.spec.ts`「report.attempt 与请求不一致 → attempt_mismatch，节点不动」。

### N-08 重大：queued 取消抛错；非法 cancelResult 被当 unknown → 已修

- 改法：`src/service/commands/cancel.ts:40-53`——queued / leased 取消直接落 `superseded`，不进围栏、不产生新 attempt；`src/service/server.ts:67`、`220-232`——HTTP 边界校验 `cancelResult ∈ {interrupted, not_interruptible, already_stopped, unknown}`，非法值按 `PAYLOAD_SCHEMA_INVALID` 拒（400），不再被当成 unknown 静默接受。
- 用例：`tests/cancel.spec.ts`「queued 取消直接变 superseded，不进围栏」、`tests/routes.spec.ts` 边界用例。

### N-09 重大：门候选范围忽略删除，证据/签名可被重做 → 已修

- 改法：`scripts/gate-check.ts`——候选文件清单改为 `git diff --name-only base..HEAD`（含删除；删除的文件把「DELETED\n」与删除前内容并进哈希）；证据哈希一律从 HEAD 的字节读（工作树里改了没提交的证据不能签门）；签门前要求工作树干净（排除 `docs/gates`、`docs/audits`、`handoff.md`）；新增治理字段校验（exceptions 的 code/type/status/note、rollback 的 target/action/耗时/验证、approver 必须 `human:<名字>`、producer 必须 `human` 或 `agent:<名字>`）；正文必过项表的第 2 列内容按固定清单逐项比对。
- 用例：`tests/gate-check.spec.ts` 新增五条（正文内容列被改、approver 非法、例外项类型非法、回滚缺可执行动作、工作树脏）。

### N-10 重大：门证据与断言路径不符 → 已修

- 改法：`scripts/fault-inject.ts` 新增四个 HTTP 夹具用例，证据从真实入口跑出来（每次重跑字节一致）：

| 证据 | 真实入口 | 断言口径 |
| --- | --- | --- |
| ev-g2-01 | load → /v1/runs → /v1/runs/dispatch | 节点 done、registry applied、事件链完整 |
| ev-g2-05 | load → 建 run → lease → report(started) → report(verifying) → report(done 无证据) | rejected/evidence_missing，节点停在 verifying 且挂着判定时限 |
| ev-g2-06 | load → 建 run → lease → report(started) → report(blocked_post 裸) → report(blocked_post 带凭据) | 裸阻塞 rejected/decision_required；带凭据 accepted/blocked_post 且有 verify_human 事件 |
| ev-g2-07 | load parallel 定义 / load agent 定义 / 用被拒版本建 run | 403 FORBIDDEN / 200 / 404 NOT_FOUND |

- G-05 改成工具执行中取消（工具在飞时立围栏，第二次取消 `fence_already_armed`，围栏期间上报 `fence_armed`，收口撞 `STALE_GENERATION`，宽限到点撤围栏并挑出队头）；G-07 改成先给节点真锚点（`deadline_at` + `boot_id` + 单调纳秒）再跳时钟（pending / uncertain(clock_drift) / uncertain(boot_changed)）。
- 复现命令：`node --no-warnings scripts/fault-inject.ts --case ev-g2-01`（ev-g2-05 / ev-g2-06 / ev-g2-07 同理；G-03 / G-04 / G-05 / G-07 换编号）。

### N-11 重大：G2 例外表与规格/计划不一致 → 已修

- 改法：`docs/gates/G2.md` 例外表补 `BRIDGE_ACK_LAG`(409)；`DECISION_REQUIRED`(422) 的依据补进 S2 计划末尾的「口径补充（第二轮审计后，2026-11-13）」第 1 节（提案码理由、落点、凭据两种形态），计划里同时补上服务侧 HTTP 入口口径、报告 attempt 一致性、多工具证据口径、判定时限与扫描口径四节。计划正文的历史部分不改。
- 规格 17.1 本身没有改：规格行号被六份计划引用 468 处，改动会引发大面积行号位移，因此提案码的落点先记在计划与门记录里，等规格修订时一并收录。

## 三、规格一致性（审计第七节五条）

1. **四条路由没有规格/计划依据** → 已在 S2 计划「口径补充」第 2 节登记这组服务侧路由的完整清单、必填字段与边界（它们不实现规格 §6.1 的 workflow 命令语义）。
2. **`DECISION_REQUIRED` 无依据** → 见 N-11。
3. **计划 :38 的 verify_human 未实现** → 已实现（见 N-01 / N-02）：阻塞必须挂凭据，凭据落成 `verify_human` 事件。
4. **`report.attempt` 与规格信封不一致** → 已修（见 N-07），口径登记在「口径补充」第 3 节。
5. **`applyReport` 仍接受 policy 参数** → **未收口**，留给 S3：模块导出层保留弱策略入口，生产路径（`submitReport`）已按 `runs.workflow_version` 从目录取判定条件。这条是内部 API 偏差，不阻断 G2，但 S3 开工前要收。

## 四、门记录自身有效性（审计第八节）

- 仍然有效的部分：门检查能过、11 项必过与 11 份证据同源、四份哈希可从候选与原像块重算；注入证据可重跑复现；正文表与 artifact 交叉校验能发现篡改。
- 这批补上的：候选范围含删除；证据只认 HEAD 字节；签门前工作树必须干净；正文第 2 列内容按固定清单比对；exceptions / approver / rollback 按治理字段校验。
- 这批改写的声明：`G2.md` 结论段不再声称「createOrchestra → 命令路由 → runNode」是一条想当然的路径，而是指向 ev-g2-01 这份从 HTTP 入口跑出来的账本片段。

## 五、残留与移交 S3

1. **F-06 桥 spill 未接生产路径**：多段 spill 与去重只在单元层验证，生产路径的桥事件缓冲没接线。S3 接桥时必须补生产路径用例。
2. **§七.5 applyReport 的 policy 参数**：模块导出层保留弱策略入口，S3 收口。
3. **spec 17.1 尚未收录三个提案码**：`LEASE_EXPIRED` / `BRIDGE_ACK_LAG` / `DECISION_REQUIRED`，等规格修订；在此之前以 G2 例外表登记。
4. **规格里的 HTTP 契约**：这批的路由是服务装配入口，规格 §6.1 的 workflow 命令语义仍在 S3 及以后。

## 六、验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm run typecheck` | exit 0 |
| `pnpm vitest run` | 31 个文件 / 254 用例全绿 |
| `node scripts/fault-inject.ts --case ev-g2-0{1,5,6,7}` | 四个 exit 0；各连跑两次 sha256 一致 |
| `node scripts/fault-inject.ts --case G-0{3,4,5,7}` | 四个 exit 0；各连跑两次 sha256 一致 |
| `node scripts/gate-check.ts docs/gates/G1.md` / `G2.md` | 重签后 exit 0 |

本表的测试是实现者自证，只证明「改动按声明落地」；G2 是否放行以第三轮独立审计的结论为准。
