# S3 独立审计报告（第 6 轮）

## 结论

**fail**。G3 的 20 项必过项中 18 项通过，`failed_items = ["G3-07", "G3-08"]`；P0 = 0，P1 = 2，P2 = 16。判定只依据候选 `c431cc8` 的代码与本次实跑；`docs/gates/G3.md` 的预签正文与历史审计结论均不作通过依据。

候选把 S2 round53 的 P1 首跳修对了：wait 事件唤醒与子流程收口现在都落 `queued` 并清租约，节点重新进了派发队列。但复验继续往下走一步就断：woken 的 wait 登记不可复用，节点再次派发时在 `acquireNodeRun` 之后抛 `RESOLUTION_NOT_AVAILABLE`，停在 `dispatched` 持租约；子流程父节点收口成 `queued` 后，下一次派发又无条件进 `waiting`，已终态的子 run 让维护扫描再次收口，形成 `waiting→queued→waiting` 循环。两条都命中本轮点名要复验的 G3-07/G3-08，按规则判 fail。

## 候选与工作树

- 候选：`c431cc8af1570b240f423e1d0376354142609890`（`fix(service): rearm woken nodes to queued`），父提交 `0dbb950`。
- 门记录声明的范围：`c296d72..HEAD`，排除 G1/G2/G3 门记录自身、`docs/audits`、`docs/reviews`、`handoff.md`；证据文件计入候选。
- 工作树：审计开始时 `git status --porcelain` 为空；全部跑测与探针完成后仍为空（探针 `tests/integration/tmp-audit-r6.spec.ts` 与 `tmp-*-r6.log` 被 `.gitignore:32` 的 `tmp-*` 覆盖，已删除）。本报告是唯一新增文件。
- 候选改动：14 文件 +457/−56，源码只动 `src/core/state-machine.ts`、`src/service/commands/wait.ts`、`src/service/commands/subworkflow.ts`、`src/service/sweep.ts`。

## 方法

1. 固定 HEAD 与工作树干净后，实跑 typecheck、全量测试、build、证据复现与门检查，记录退出码。
2. 对四条改动逐段追「HTTP 路由/维护扫描 → 生产装配 → service 命令 → `applyTransition` 与事务」，再用一次性探针复验唤醒后的第二次派发、收口后的第二次派发与 run 级取消，不以新增测试通过代替行为验证。
3. 逐条判定 20 项必过项；P2 单列并标出上轮状态。
4. 历史审计表格行只在「有轮次列、轮次严格早于本轮」时豁免；本轮不引用其结论。

## 实跑结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 61 files passed；**844 passed \| 1 skipped (845)**；9.96s |
| `pnpm build` | 0 | ESM `lib/index.js` **245.47 kB**、gzip **59.25 kB**；`lib/index.d.ts` **18.04 kB** |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 25 份，每份重跑两遍与 HEAD 字节一致 |
| `node --no-warnings scripts/gate-check.ts` | 1 | G1/G2/G3 三条审计报告 sha 失配（见 P2-1） |

全量计数与 `docs/gates/evidence/G3/full-suite.md` 声明的 61 files / 844 passed / 1 skipped、245.47 kB / 59.25 kB / 18.04 kB 逐项一致。

## S2 round53 P1 复验

### 首跳：已修

- wait：`src/service/commands/wait.ts:135-150` 把唤醒迁到 `waiting→queued`（M-63），并清 `lease_id/lease_expires_at/executor_session_id/executor_agent_id/wait_deadline_at`。实跑唤醒后节点为 `{status:'queued', lease_id:null, lease_expires_at:null, wait_deadline_at:null}`，`wait.woken` 一条。
- 子流程：`src/service/commands/subworkflow.ts:353-374` 把父节点迁 `waiting→queued` 并清租约；`src/service/sweep.ts:337` 只在 `out.status === 'queued'` 时记 `subworkflow.finished`，重复扫描不会重复记。
- 迁移表：`src/core/state-machine.ts` 新增 M-63（`waiting→queued`，trigger `wait-rearmed`），`MIGRATION_CASE_IDS` 63 条；`tests/integration/migration-cases.spec.ts:26-34` 断 63 个 id 全覆盖，`:36-49` 指纹随 60 条状态规则重算。

### 第二次派发：wait 停在 dispatched 持租约（P1-1）

复验步骤与结果：

1. 唤醒后节点 `queued`、租约空（符合声明）。
2. `commands.dispatch` 再派发同一节点，返回 `[{status:'failed', reason:'这个等待登记已经收口，不能复用', error_code:'RESOLUTION_NOT_AVAILABLE'}]`。
3. 节点此时为 `{status:'dispatched', lease_id:'lease_…', lease_expires_at:NOW+60s}`；`acquireNodeRun` 已单独提交，失败没有回滚它。
4. 以 `NOW+61s` 调 `sweepNow`，结果 `lease_expired:['nr1']`，节点转 `stopping`（非终态），run 仍 `running`，`wait.woken` 仍只有 1 条。

根因：`src/service/commands/wait.ts:195-276` 的 `enterWaiting` 对已有 `state='woken'` 登记直接抛 `RESOLUTION_NOT_AVAILABLE`；`src/service/dispatcher.ts:124-203` 的 `dispatchControlNode` 不消费 woken 登记，也没有 `waiting→done` 的出口。全仓只有 `wait.ts` 自己读写 `wait_registrations.state='woken'`，没有消费者。S2 round53 的「唤醒后永久悬空」并没有消失，只是悬空点从 `dispatched→orphaned` 前移到了再次派发。

### 第二次派发：子流程父节点循环（P1-2）

复验步骤与结果：

1. 子 run 置 `done`，`sweepNow` 把父节点从 `waiting` 收口为 `queued`，记一条 `subworkflow.finished`。
2. 再 `dispatch`，`src/service/commands/subworkflow.ts:290-326` 无条件把 `started` 父节点迁回 `waiting` 并再 append `subworkflow.waiting`；`createSubworkflowRun` 按 `parent_node_run_id` 幂等返回同一 child（`created:false`）。
3. 下一轮 `sweepNow` 看到 child 已终态，再收口为 `queued`。连续三轮得到 `subworkflow.waiting=3`、`subworkflow.finished=3`，节点最终仍是 `queued`，父 run 永不终态。

根因：收口只把节点推回 `queued`，没有把「子流程已经收口」持久成节点终态或幂等标记；`startSubworkflowNode` 也不区分「首次启动」与「收口后重派」。`src/service/commands/subworkflow.ts:335` 的注释仍写「只允许 waiting→dispatched；重复调用在看到 dispatched 时幂等返回」，与 queued 实现不一致。

### run 级取消：自身节点覆盖不全（P2-3）

新增的 `propagateRunCancellation`（`src/service/commands/subworkflow.ts:396-448`）先收目标 run 自身 `dispatched/started/waiting/verifying` 节点，再递归子 run；`tests/integration/subworkflow.spec.ts:208-229` 覆盖了 `nr-parent`。但白名单漏掉 `queued/leased`：探针 `cancelRun({runId:'r1',cancelResult:'interrupted',graceMs:0})` 返回 `cancelledNodes=[]`，节点仍 `queued`，run 为 `{status:'running', cancel_result:'interrupted'}`，无法收口。`applyCancel` 本身支持 `queued/leased→superseded`（M-62，`src/service/commands/cancel.ts:53-74`），漏的是调用侧白名单。

## G3 必过项逐项

| 编号 | 内容 | 结果 | 证据 |
| --- | --- | --- | --- |
| G3-01 | M-01 到 M-63 逐条迁移用例，非法迁移全拒 | pass | `migration-cases.spec.ts` 66 tests；63 id 全覆盖，M-63 有正例与错误触发/错误目标拒绝 |
| G3-02 | 所有节点迁移走 CAS，迟到 attempt 不污染新行 | pass | `node-runs.spec.ts` 通过；`applyTransition` 以 status+revision+attempt 为条件 |
| G3-03 | 半态时钟与桥断冻结矩阵 | pass | `half-state.spec.ts` 通过 |
| G3-04 | blocked_pre 审批往返：旧租约清除、内容哈希绑定 | pass | `approval.spec.ts` 通过 |
| G3-05 | policy 九算子与 branch 路由 | pass | `policy-branch.spec.ts` 通过 |
| G3-06 | 并行汇聚 all/any/quorum 与不可逆子节点闸 | pass | `parallel.spec.ts` 通过 |
| G3-07 | wait 先落 inbox 再匹配：早到回扫、唤醒幂等、超时与饥饿分记 | **fail** | 首跳成立；woken 后再次派发抛 `RESOLUTION_NOT_AVAILABLE`，节点停 `dispatched` 持租约，超时转 `stopping`，wait 无法完成（P1-1） |
| G3-08 | 子流程 pin 版本、深度与环检测、父取消向子 run 传播 | **fail** | pin/深度/环/传播用例通过；父节点收口回 queued 后再派发重入 waiting，形成 `waiting→queued` 循环（P1-2）；run 级取消漏 queued/leased 自身节点（P2-3） |
| G3-09 | 补偿按 compensation_id 幂等一次 | pass | `compensation.spec.ts` 通过 |
| G3-10 | 报告冲突与 uphold 收口 | pass | `apply-report.spec.ts` 通过 |
| G3-11 | 恢复扫描可重入：断链跳过、桥断挂起、启动未知到点转未知态 | pass | `sweep.spec.ts` 通过；缺锚点旧行口径见 P2-9 |
| G-01 | 事务 COMMIT 前杀进程 | pass | `docs/gates/evidence/G1/G-01.md`；25/25 字节复现 |
| G-02 | COMMIT 后未投递被杀 | pass | `docs/gates/evidence/G1/G-02.md`；25/25 字节复现 |
| G-04 | 租约到期后原执行器迟到上报被拒 | pass | `docs/gates/evidence/G2/G-04.md`；字节复现 |
| G-06 | tool.result 丢失后同 callId 只重发结果、不重跑工具 | pass | `g3-faults.spec.ts` G-06；断言强度见 P2-5 |
| G-12 | 审批双击同 revision 只赢一笔 | pass | `g3-faults.spec.ts` G-12 |
| G-16 | 父取消向子 run 传播且跳过不可逆节点 | pass | `g3-faults.spec.ts` G-16；`cancelledNodes=["nr_g16a"]`、`skippedIrreversible=["nr_g16b"]`；断言强度见 P2-5 |
| G3-12 | 起运行固定版本、自治档位与 operation_id 幂等 | pass | `tests/unit/start-run.spec.ts` 通过 |
| G3-13 | 批准人三档：审计能力位、不得批准自己证据 | pass | `tests/unit/approver.spec.ts` 通过；HTTP 记账口径见 P2-8 |
| G3-14 | S3 全量测试与构建全绿 | pass | 实跑 844 passed \| 1 skipped；245.47/59.25/18.04 kB 与证据一致 |

## P0 / P1 / P2

### P0

无。

### P1

| 编号 | 缺陷 | 证据 |
| --- | --- | --- |
| P1-1 | woken wait 节点再次派发即失败：`enterWaiting` 拒绝复用 `state='woken'` 登记，`acquireNodeRun` 已提交，节点停在 `dispatched` 持租约，超时转 `stopping`，run 不能收口 | 探针见「第二次派发：wait」；`wait.ts:195-276`、`dispatcher.ts:124-203` |
| P1-2 | 子流程父节点收口成 queued 后可无限重入 waiting：收口不写终态/幂等标记，`startSubworkflowNode` 无条件再迁 waiting，sweep 再收口 | 三轮探针 `waiting=3/finished=3`；`subworkflow.ts:290-326`、`sweep.ts:326-341` |

### P2

| 编号 | 状态 | 缺陷 | 证据 |
| --- | --- | --- | --- |
| P2-1 | 遗留 | G3 门记录仍是预签：四个哈希、`artifact_hash`、`body_hash`、`audit_report_sha256` 全 0，`audit_round=3`，报告指向 round3；`gate-check` exit 1，G1/G2 亦因审计报告 sha 与记录不符而失败 | `docs/gates/G3.md:66-138`；门检查 stderr |
| P2-2 | 新增 | G3 门记录正文仍写「M-01…M-62」（`:11`、`:21`、`:55`、`:144`），候选已加 M-63、证据已断 63 条，门记录与迁移表口径不一致 | `docs/gates/G3.md`、`migration-cases.spec.ts:26-34` |
| P2-3 | 新增 | run 级取消的自身节点白名单漏 `queued/leased`：`cancelRun` 返回空，节点仍 queued，run 保持 running 但已写 `cancel_result` | 探针；`subworkflow.ts:396-448`、`cancel.ts:41-74` |
| P2-4 | 新增 | `subworkflow.ts:335` 注释仍写「waiting→dispatched；看到 dispatched 幂等返回」，与 queued 实现不符 | `src/service/commands/subworkflow.ts:335` |
| P2-5 | 遗留 | G-06 未直接断言宿主实际执行次数，只断账本里 `tool_started`/`tool_finished` 各一条；G-16 的 `skippedIrreversible` 只断 reconcile 摘要字符串（`nr_g16a`/`nr_g16b` 行级状态已断） | `tests/integration/g3-faults.spec.ts:45-53`、`:62-74` |
| P2-6 | 遗留 | 迁移表指纹由测试自己 `JSON.stringify` 生成；`hasRequires` 退化为布尔，建行规则与挂起闸不入指纹 | `migration-cases.spec.ts:36-49` |
| P2-7 | 遗留 | G3 三份注入证据是叙述摘要，`check-evidence-repro.ts` 只覆盖 G1/G2 共 25 份，G-06/G-12/G-16 不可字节复现 | `scripts/check-evidence-repro.ts:12-15` |
| P2-8 | 遗留 | HTTP 决策入口 actor 由共享 secret 派生（`service:<sha8>`），却按 `{kind:'human'}` 记账 | `server.ts:140`、`:234` |
| P2-9 | 遗留 | `startup_unknown` 缺 boot/mono 锚点的旧行直接转 `indeterminate_side_effect`，注释声明保守口径但未给旧行补锚点路径 | `sweep.ts:135-174` |
| P2-10 | 遗留 | `confirm-start` 无 `action_start_source`/`executor.state`，起跑来源与执行器状态不可区分 | 全仓 `rg action_start_source` 无命中 |
| P2-11 | 遗留 | 动作时限直接 `UPDATE node_runs SET hang_reason=...`，未走 `applyTransition` | `sweep.ts:287-293` |
| P2-12 | 遗留 | `dispatch` 在未装配 executor 时一律抛 `EVIDENCE_SOURCE_UNAVAILABLE`，control-only 的 wait/subworkflow 一并被挡 | `src/index.ts:202-205` |
| P2-13 | 遗留 | dispatcher 不校验 `node_runs.node_type` 与 `control.kind`，查询只取 `node_run_id,node_id,seq,attempt` | `dispatcher.ts:57-59` |
| P2-14 | 遗留 | `startSubworkflowNode` 只写 `wait_started_at`，不写 `wait_deadline_at`/`wait_registrations`，父等待无超时与饥饿记录 | `subworkflow.ts:303-324` |
| P2-15 | 遗留 | `lost` 只看 `started_at` 与有无游标，不看租约/心跳；`missing` 把 `waiting/verifying/stopping` 也按静默十分钟计 | `sweep.ts:76-100` |
| P2-16 | 新增 | 子流程收口只按父节点 `waiting` 触发，没有「child 已收口」的持久标记；`queued/dispatched` 早返回只防同一轮并发重复，挡不住重派后再次 waiting（与 P1-2 同源） | `subworkflow.ts:337-374`、`sweep.ts:326-341` |

## failed_items

- `G3-07`
- `G3-08`

## 收口建议

1. 先把 wait 的唤醒后半段补成可收口路径：woken 登记允许再次进入等待时重新激活（新 idempotency key），或给 `waiting` 一个到 `done` 的出口；`dispatchControlNode` 必须在 `acquireNodeRun` 失败时回滚节点，不能留下持租约的 `dispatched`。
2. 子流程父节点收口要么落终态（`done`），要么写「已收口」幂等标记，让 `startSubworkflowNode` 不再重入 `waiting`；补一条「收口后再 dispatch 不产生第二条 `subworkflow.waiting`」的行为用例。
3. run 级取消把 `queued/leased` 纳入自身节点白名单，并断言取消后 run 能落 `cancelled`。
4. 门记录在重签前把 `M-01…M-63`、哈希与审计轮次一次性收口；P2-5..P2-16 按上轮顺序排进 S3 收尾。
5. 本轮未签门、未改源码、未提交；`docs/audits/S3-independent-audit-round6.md` 为唯一新增文件。

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 6,
  "candidate_commit": "c431cc8af1570b240f423e1d0376354142609890",
  "conclusion": "fail",
  "p0": 0,
  "p1": 2,
  "p2": 16,
  "must_pass_total": 20,
  "must_pass_passed": 18,
  "must_pass_ids": ["G3-01", "G3-02", "G3-03", "G3-04", "G3-05", "G3-06", "G3-07", "G3-08", "G3-09", "G3-10", "G3-11", "G-01", "G-02", "G-04", "G-06", "G-12", "G-16", "G3-12", "G3-13", "G3-14"],
  "failed_items": ["G3-07", "G3-08"],
  "notes": "wait 与子流程首跳已回 queued，但 woken wait 不能再次派发、子流程收口后可无限重入 waiting；run 级取消漏 queued/leased 自身节点。"
}
```
<!-- audit-verdict:end -->
