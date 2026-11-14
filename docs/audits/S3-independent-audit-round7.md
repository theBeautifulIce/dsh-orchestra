# S3 独立审计报告（第 7 轮）

## 结论

**fail**。P0 1 项、P1 4 项、P2 8 项；failed_items：`G3-07`、`G3-08`、`G-16`。

`e0f9650` 修掉了第 6 轮的两个节点级死循环：woken 的 wait 不再回 `queued` 重派，子流程父节点也不再 `waiting→queued` 循环，两条都改成控制节点直接 `waiting→done`（M-63，`controlCompletion=true`）。但“直接 done”只解决了节点出口，没有补 run 收口触发：`wait` 唤醒、`wait` 超时、子流程收口、run 级取消、补偿结算这些生产路径都不调用 `closeRun`，`sweep` 也不调用。结果是控制节点已终态、run 永久停在 `running`，只有再发一次空 `POST /v1/runs/dispatch` 才会落终态。取消路径还额外出现“取消记成功、失败子流程记成功、取消后事件 409 且事件丢失”。

## 候选与工作树

- 候选 SHA：`e0f96507add0021aa8c18a36d87c933f3c0f30cb`（`e0f9650 fix(service): complete control nodes without redispatch`）
- 审计开始时 `git status --porcelain` 为空，`HEAD=e0f9650`。
- 审计过程中（22:35）工作树出现并发写入的未跟踪文件 `docs/audits/S1-independent-audit-round55.md`；22:41 又出现 7 个并发修改（`src/service/commands/wait.ts`、`src/service/dispatcher.ts`、`src/service/execution-scheduler.ts`、`src/service/sweep.ts`、`tests/integration/sweep.spec.ts`、`tests/integration/wait.spec.ts`、`tests/unit/execution-scheduler.spec.ts`）。这些都不是本次审计产物，审计一律不读、不测、不改。
- 按约定另建干净 worktree `tmp/audit-r7-clean`（detached HEAD `e0f9650`，`node_modules` 用 junction 指向主工作树），五项必做实测全部在该干净 worktree 重跑；报告以此为准，审计后已删除该 worktree。
- 生产链路探针在主工作树运行；运行时源码仍是候选 `e0f9650`（并发改动检测于探针之后），不影响 HTTP/SQL 观测。
- 本轮未改 `src/`、`tests/`、`docs/gates/`；唯一新增交付是本报。当前主工作树的并发改动与未跟踪文件不属于本候选，等待其负责人自行处理。

## 方法

1. 在干净 worktree 重跑 typecheck / test / build / 证据复现 / G3 门检查。
2. 读 `state-machine.ts`、`wait.ts`、`subworkflow.ts`、`sweep.ts`、`run-close.ts`、`dispatcher.ts`、`cancel.ts`、`runtime.ts`、`index.ts` 与对应测试。
3. 用真实 HTTP 生产入口做两组探针（`tmp/audit-r7/probe.ts`、`probe2.ts`）：`openServiceOrchestra({phase:'S3', executor})` + `startServer`，只走 `/v1/workflows/load`、`/v1/runs`、`/v1/runs/dispatch`、`/v1/wait/events`、`/v1/runs/cancel`；`sweepNow` 驱动生产 sweep；SQL 只读观察。子 run 终态由真实 `closeRun` 产生，未种 `done`。
4. 逐份核对 G3 证据与 `full-suite.md` 记录。

## 实跑结果

| 命令（干净 worktree） | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 61 files passed；844 passed，1 skipped（845）；10.22s |
| `pnpm build` | 0 | ESM `lib/index.js` 245.86 kB / gzip 59.37 kB；`lib/index.d.ts` 18.04 kB；CJS `lib/client.js` 0.29 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | “证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致” |
| `node scripts/gate-check.ts docs/gates/G3.md` | 1 | “审计报告 sha256 与记录不符：0000000000000000… != 4876a98892db4661…” |

- 干净 worktree 首次跑证据复现时，`pnpm` 尚在补装依赖，`ev-g2-15` 报 `ERR_MODULE_NOT_FOUND`；依赖完成后原命令复跑 exit 0。主工作树同一命令也已 exit 0。
- G3.md 仍是预签态（`audit_round=3`，`audit_report_sha256` 与五个哈希全 0），gate-check exit 1 属预期；本报告不把门记录当完成证据。

## 重点复验

### 1. G3-07：`/v1/wait/events` → `wakeOnEvent` → 节点 done

| 场景 | 实测 |
| --- | --- |
| 首次匹配 | `woken=1`，节点 `done`，`wait.woken=1`，登记 `woken`，run 仍 `running` |
| 同一 idempotencyKey 重复 | `eventSeq=1`、`woken=0`、inbox 1 行，节点仍 done |
| 换 key 同类型再发 | `woken=0`，节点仍 done，不再改写 |
| 无匹配事件 | `woken=0`，节点 `waiting`，登记 `active`，`cursor_seq` 推进到 4 |
| 超时（maxWaitMs=1） | 节点 `timeout`，登记 `timed_out`，`wait.event_timeout=1`，run 仍 `running`；再次 dispatch 不重派 |
| 唤醒后连续两次 sweep | run 仍 `running`；再发空 dispatch 才变 `succeeded_with_unverified` |

节点级语义（早到回扫、幂等、无匹配、超时分记）成立；**run 级收口不成立**，生产上没有触发点。

取消后的等待链路另有硬伤：对 `waiting` 节点发 `/v1/runs/cancel`（interrupted）后节点进 `timing_out`，但 `wait_registrations` 仍是 `active`；随后发匹配事件返回 **409 `STALE_GENERATION`**（`node_run 迁移 CAS 未命中`，from `waiting` to `done`），且 `wait_event_inbox` 为 **0 行**——事件没有“先落 inbox”，整笔事务被回滚。再 sweep 后节点转 `stopping`，空 dispatch 后 run 仍 `running`。

### 2. G3-08：子流程建 run → 真实终态 → sweep 收口；run 级取消

| 场景 | 实测 |
| --- | --- |
| 子 run 成功 | 子节点 done 后 `closeRun` 落 `succeeded_with_unverified`；sweep 后父节点 `done`、`subworkflow.finished=1`，父 run 仍 `running`；空 dispatch 后父 run `succeeded_with_unverified` |
| 子 run 失败 | 子节点改 failed（非种 done）→ 空 dispatch 收成 `failed_with_unverified`；sweep 后父节点仍无条件 `done`；父 run 收口为 **`succeeded_with_unverified`** |
| 父 run 取消（子节点正常） | 子节点 `superseded`；空 dispatch 收子 run 为 **`succeeded_with_unverified`**；父节点 `timing_out→stopping`，`subworkflow.finished=0`；父 run 永远 `running` |
| 父 run 取消（子节点 irreversible） | `cancelledRuns` 含子 run，`cancelledNodes` 含父节点，`skippedIrreversible` 含子节点；父节点进 `timing_out`，子节点仍 `queued` |

结论：子流程“建 run、pin、深度/环、向子 run 传播取消”成立；“失败子流程→父 done”“取消后父节点收不了口”“取消的子 run 判成功”三处不成立。`finishSubworkflowChild` 只认父节点 `waiting`，而取消把 `waiting` 打成 `timing_out/stopping`，两条路径互斥。

### 3. M-63 与 run-close 触发

- M-63 定义在 `src/core/state-machine.ts:163`：`waiting→done`，`trigger='wait-completed'`，`requires controlCompletion=true`；只有 `wait.ts` 与 `subworkflow.ts` 传这个上下文，普通节点走不到，守卫本身成立。
- `closeRun` 全仓调用点只有四处：`src/index.ts:167`（裁决拒绝/过期）、`src/index.ts:234`（`/v1/node-runs/run` 后）、`src/service/dispatcher.ts:70`（dispatch 批末）、`src/service/commands/decisions.ts:219`（裁决过期）。
- `sweep.ts:329-341` 收口子流程父节点后不调用 `closeRun`；`wakeOnEvent`（`src/index.ts:187-193`）不调用；`/v1/runs/cancel`（`src/index.ts:194-201`）不调用；补偿 settle 也不调用。
- `serveOrchestra` 每 2 秒只跑 `sweepNow`（`src/index.ts:294-302`），所以没有任何后台路径能收 run。控制节点链路要么靠宿主额外发空 dispatch，要么永久 `running`。
- 控制节点没有报告阶段，M-63 直接 done 不会跳过 report/apply；但 `wait_done` 后 run 收口确实被跳过（见上）。

### 4. G3-11：桥断/恢复/执行器失联

- `src/service/commands/runtime.ts:63-96`：信号仍从 `bridge_stream_cursors` 生产派生，不读内存。`missing` = 绑定态节点 `MAX(c.updated_at) < now-10min` 且 `started_at` 也早于 cutoff；`restored` = `paused_bridge_missing` 且 `c.updated_at >= cutoff`；`lost` = `dispatched/started` 且无 cursor、`started_at < cutoff`。三个方向都有 `tests/integration/runtime.spec.ts:582-611` 的真实 sweep 用例覆盖。
- `BRIDGE_BOUND` 含 `waiting`，规格 §4.4 的 executor-bound 六态不含 `waiting`；当前 `waiting` 节点没有 cursor，实际不可达，属口径漂移。
- 10 分钟静默是 `BRIDGE_SILENCE_MS` 硬编码，既不是 `execution.lease_ttl_ms`，也没有配置项；与“租约/静默阈值”这一问的答案是：**用固定静默阈值，不用租约 TTL**，部署不可调。

### 5. 其余门项与证据

- G3-01/02/03：迁移 63 条全表覆盖（`migration-cases.spec.ts:27-33`），CAS 与半态时钟走全量测试，未发现新问题。
- G3-04/05/06/09/10/12/13：审批往返、policy/branch、并行汇聚、补偿幂等、报告冲突、起运行、批准人三档均由全量用例覆盖并通过；未做生产入口逐条复跑，未发现新 P0/P1。补偿 settle 的 run 收口缺口归入 P0-1。
- G-01/02/04/06/12：`fault-inject` 证据存在且 `check-evidence-repro` 覆盖。
- G-16：传播与跳过不可逆节点成立；但“父 run 不先收口、子 run 收敛后再判”没有生产路径：取消后父节点卡在 `stopping`、`subworkflow.finished=0`，子 run 还被判成功。G-16 证据只断言传播摘要，不验收敛，见 P1-2/P1-4、P2-7。
- 证据：`check-evidence-repro` 的 25 份 = G1 6 份（G-01/02/08/09/14/15）+ G2 19 份（G-03/04/05/07 + ev-g2-01..15），**不含 G3 的 G-06/G-12/G-16/full-suite**。G3 四份证据当前 sha256：`full-suite.md f9b4b9e2…`、`G-06.md 5dffd870…`、`G-12.md 213aeccc…`、`G-16.md b4de4387…`；G3.md 的 evidence-index 20 条 sha256 全为 0（预签态）。`full-suite.md` 的 844 passed / 1 skipped、245.86 kB / 59.37 kB / 18.04 kB 与实测逐项一致。

## G3 必过项逐项

| 编号 | 内容 | 结果 | 证据 |
| --- | --- | --- | --- |
| G3-01 | M-01 到 M-62 逐条迁移用例，非法迁移全拒（实际表已扩到 M-63） | pass | migration-cases.spec.ts（63 id 全覆盖） |
| G3-02 | 所有节点迁移走 CAS，迟到 attempt 不污染新行 | pass | full-suite + node-runs.spec.ts |
| G3-03 | 半态时钟与桥断冻结矩阵 | pass | half-state.spec.ts |
| G3-04 | blocked_pre 审批往返 | pass | approval.spec.ts |
| G3-05 | policy 九算子与 branch 路由 | pass | policy-branch.spec.ts |
| G3-06 | 并行汇聚 all/any/quorum 与不可逆闸 | pass | parallel.spec.ts、parallel.ts:120-170 |
| G3-07 | wait 先落 inbox 再匹配；早到、幂等、超时分记 | **fail** | 探针 A/B/C/G：取消后事件 409 且 inbox 0；唤醒/超时后 run 不收口 |
| G3-08 | 子流程 pin、深度/环、父取消向子 run 传播 | **fail** | 探针 D/E/H：失败子流程父节点 done；取消后父节点卡死；取消子 run 判成功 |
| G3-09 | 补偿按 compensation_id 幂等一次 | pass | compensation.spec.ts；settle 不收 run 见 P0-1 |
| G3-10 | 报告冲突与 uphold 收口 | pass | apply-report.spec.ts |
| G3-11 | 恢复扫描可重入；桥断挂起、启动未知转未知态 | pass | runtime.ts:63-96、runtime.spec.ts:582-611 |
| G-01 | 事务 COMMIT 前杀进程 | pass | fault-inject + 证据复现 |
| G-02 | COMMIT 后未投递被杀 | pass | fault-inject + 证据复现 |
| G-04 | 租约到期后迟到上报被拒 | pass | fault-inject + 证据复现 |
| G-06 | tool.result 丢失只重发结果 | pass | G-06.md、g3-faults.spec.ts |
| G-12 | 审批双击同 revision 只赢一笔 | pass | G-12.md、g3-faults.spec.ts |
| G-16 | 父取消向子 run 传播且跳过不可逆节点；子 run 收敛后父 run 再判 | **fail** | 传播与跳过成立；但父节点卡 `stopping`、`subworkflow.finished=0`，子 run 判 `succeeded_with_unverified`（探针 H） |
| G3-12 | 起运行固定版本、自治档位、operation_id 幂等 | pass | start-run.spec.ts |
| G3-13 | 批准人三档 | pass | approver.spec.ts |
| G3-14 | S3 全量测试与构建全绿 | pass | 844 passed / 1 skipped；245.86 kB / 59.37 kB / 18.04 kB |

## P0

### P0-1 控制节点链路的 run 终态不可达

- **现象**：`wait` 唤醒、`wait` 超时、子流程成功、补偿结算、run 级取消之后，节点已终态，run 仍 `running`；只有额外发一次空 `POST /v1/runs/dispatch` 才会落 `succeeded_with_unverified` / `failed_with_unverified`。
- **证据**：探针 A（唤醒后两次 sweep 仍 running，空 dispatch 才 succeeded_with_unverified）、D（子 run 真实 succeeded_with_unverified，父节点 done、父 run running）、K（timeout 后 run running，空 dispatch 才 failed_with_unverified）。
- **根因**：`closeRun` 只在 `src/index.ts:167`、`:234`、`src/service/dispatcher.ts:70`、`src/service/commands/decisions.ts:219` 被调用；`sweep.ts` 收口子流程后不调用，wait/cancel/compensation 入口也不调用。后台 2 秒定时器只跑 `sweepNow`。
- **影响**：任何含 wait / subworkflow / 补偿的控制节点 run 在真实宿主上永不结束，依赖 run 终态的下游（门、面板、清理）全部悬空。全量用例与 e2e 都没有断言 run 终态，所以 844 全绿没有暴露它。

## P1

### P1-1 取消等待节点后事件丢失并返回 409

- 取消 `waiting` 节点走 `timing_out`（`cancel.ts:75-113`），但 `cancelWait`（`wait.ts:352`）全仓无调用点，登记仍 `active`。
- 再发匹配事件时 `scanRegistration` 先改登记 `woken`，随后 `applyTransition(from waiting→done)` CAS 失败，整笔事务回滚：HTTP 409 `STALE_GENERATION`，`wait_event_inbox` 0 行。事件既没留下，也无法重试成功。

### P1-2 子流程父节点取消后永远收不了口

- `propagateRunCancellation` 把 `waiting` 父节点按 `interrupted` 打进 `timing_out`，围栏到期后 sweep 转 `stopping`；`finishSubworkflowChild` 只接受 `node.status==='waiting'`（`subworkflow.ts:357-365`）。两条路径互斥，`subworkflow.finished=0`，父 run 永久 `running`。
- 探针 H 复现：父节点 `stopping`，子 run 已收敛，父 run 仍 `running`。

### P1-3 失败子流程被当成成功收口

- `finishSubworkflowChild` 对 child 任何 `RUN_TERMINAL` 都执行 `waiting→done`（`subworkflow.ts:366-379`），不看 `failed_with_unverified`。
- 探针 E/I：子 run `failed_with_unverified` → 父节点 `done` → 父 run 收口 `succeeded_with_unverified`。失败事实只留在子 run，父账本显示成功。

### P1-4 取消的子 run 被判成功

- 取消把子 run 内 `queued` 节点置 `superseded`，随后空 dispatch 调 `closeRun`；`closeRun`（`run-close.ts:23-63`）不读 `cancel_requested_at/cancel_result`，全 `superseded` 节点按“无失败、无未验证”落到 `succeeded_with_unverified`。
- 探针 H：`cancel_requested_at` 已写、`cancel_result=interrupted`，run 仍是 `succeeded_with_unverified`；账本无法区分“取消”与“成功”。

## P2

| 编号 | 类型 | 内容 | 证据 |
| --- | --- | --- | --- |
| P2-1 | 新增 | G3.md 正文与不变量仍写 `M-01…M-62`，实际迁移表已 63 条（M-63），门记录自身未更新 | `G3.md:11`、`:21`、`:55`、`:144`；`state-machine.ts:163` |
| P2-2 | 新增 | G3 四份证据不在 `check-evidence-repro` 的 CASES 内，G3 证据字节复现只能靠测试与人工；第 6 轮 P2-7 未收 | `scripts/check-evidence-repro.ts:12-15` |
| P2-3 | 遗留 | G3 evidence-index 20 条 sha256 全 0、五个 GateArtifact 哈希全 0；预签态可解释，但重签前必须重算，不能作为“证据已封” | `G3.md:71-74`、`:113`、`:117-140` |
| P2-4 | 遗留 | `BRIDGE_BOUND` 含 `waiting`，规格 §4.4 executor-bound 只列六态；`BRIDGE_SILENCE_MS=10min` 硬编码，不进配置、不读 `lease_ttl_ms` | `runtime.ts:63-96` |
| P2-5 | 新增 | 测试缺口：wait/subworkflow/control-dispatch 与 `production-path` 都不断言 run 终态，空 dispatch 成为唯一收口手段却不入规格 | `wait.spec.ts`、`subworkflow.spec.ts`、`control-dispatch.spec.ts`、`production-path.spec.ts:79-160` |
| P2-6 | 新增 | `finishSubworkflowChild` 注释仍写“只允许 waiting→dispatched”，实现已改 `waiting→done` | `subworkflow.ts:338-340` |
| P2-7 | 遗留 | G-16 证据只断言传播与 `skippedIrreversible`，不验“子 run 收敛后再判”、父/子 run 终态；失败子流程与取消记成功因此漏检 | `G-16.md`、`g3-faults.spec.ts` |
| P2-8 | 遗留 | `dispatch` 未装 executor 时一律 `EVIDENCE_SOURCE_UNAVAILABLE`，control-only 的 wait/subworkflow 也被挡；`serveOrchestra` 却每 2 秒只跑 sweep | `src/index.ts:202-205`、`:294-302` |

## failed_items

- `G3-07`
- `G3-08`
- `G-16`

## 收口建议

1. 把 run 收口接进收口类事件：`sweep` 处理完 wait 超时、子流程 finish、围栏撤销后调用 `closeRun`，或在 `sweepNow` 末尾对“所有节点已终态、无活跃 decision”的 run 统一收口；`wakeOnEvent`、`/v1/runs/cancel`、补偿 settle 同样补触发。验收必须断言 run 终态，禁止把空 dispatch 当唯一收口路径。
2. 取消时同时撤销等待登记（`cancelWait`）或允许 `timing_out` 节点收口；子流程父节点取消后要落终态或写“已收口”持久标记，`finishSubworkflowChild` 不能只认 `waiting`。
3. `finishSubworkflowChild` 按 child 终态映射父节点：成功→`done`，失败/超时→`failed`/`failed_with_unverified`，取消→`superseded` 或专用收口；不能一律 `done`。
4. `closeRun` 读 `cancel_requested_at/cancel_result`：取消的 run 不得落 `succeeded*`，要么有独立取消终态，要么按 `superseded` 收口并写清原因。
5. 重签 G3 前更新 `G3.md` 的 M-63、审计轮次、五个哈希与 evidence-index；把 G3 四份证据纳入 `check-evidence-repro`；补 wait/子流程/取消的 run 终态回归。
6. 本轮未签门、未改源码、未提交；`docs/audits/S3-independent-audit-round7.md` 为唯一新增文件。

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 7,
  "candidate_commit": "e0f96507add0021aa8c18a36d87c933f3c0f30cb",
  "conclusion": "fail",
  "p0": 1,
  "p1": 4,
  "p2": 8,
  "must_pass_total": 20,
  "must_pass_passed": 17,
  "must_pass_ids": ["G3-01", "G3-02", "G3-03", "G3-04", "G3-05", "G3-06", "G3-07", "G3-08", "G3-09", "G3-10", "G3-11", "G-01", "G-02", "G-04", "G-06", "G-12", "G-16", "G3-12", "G3-13", "G3-14"],
  "failed_items": ["G3-07", "G3-08", "G-16"],
  "notes": "M-63 修掉 waiting→queued 循环，但控制节点 done 后无 closeRun 触发，wait/subworkflow/timeout/cancel 的 run 永久 running；取消 wait 后事件 409 且 inbox 0；失败子流程与取消子 run 均被判 succeeded_with_unverified；取消子流程后父节点卡 stopping，G-16 的“子 run 收敛后再判”未成立。"
}
```
<!-- audit-verdict:end -->
