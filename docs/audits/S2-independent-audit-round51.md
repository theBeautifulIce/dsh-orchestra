# S2 独立审计 · G2 · 第 51 轮

- 门：G2
- 候选提交：68fa92bf9bd6257eedfba6494b654b7de08639e7
- 审计时间：2026-11-14
- 审计范围：候选范围 `4f3ada7..68fa92b`（222 个提交、288 个文件、+44915/−414），排除 `docs/gates`、`docs/audits`、`docs/reviews`、`handoff.md`。HEAD 为 `eb19872`，相对候选只改 `docs/gates/evidence/G3/full-suite.md`（4+/4−）。
- 审计方式：只读。未改源码、未签门、未 commit；唯一写入为本报告。干净复核在 detached worktree `tmp/audit-s2-r51`（HEAD=68fa92b）进行，`node_modules` 以 Junction 复用主仓依赖。

## 一、命令与结果

| # | 命令 | 工作目录 | 退出码 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | `pnpm typecheck`（`tsc --noEmit`） | 主仓 | 0 | 无输出 |
| 2 | `pnpm test`（`vitest run`） | 主仓 | 1 | 60 files，829 passed / 2 failed / 1 skipped；两条失败均在 `tests/gate/gate-check.spec.ts`，报“审计报告不在 HEAD 里，先提交审计报告: docs/audits/S1-independent-audit-round51.md”。根因是另一 agent 在同一工作树把 `docs/gates/G1.md` 的 `audit_round` 改为 51 并指向尚不存在的报告（未提交），与候选代码无关 |
| 3 | `node node_modules/typescript/bin/tsc --noEmit` | 干净树 | 0 | 无输出 |
| 4 | `node node_modules/vitest/vitest.mjs run` | 干净树 | 0 | 60 files，831 passed / 1 skipped，832 total |
| 5 | 必过 6 文件：`g2.spec.ts`、`runtime.spec.ts`、`contract/routes.spec.ts`、`e2e/production-path.spec.ts`、`sweep.spec.ts`、`apply-report.spec.ts` | 干净树 | 0 | 6 files，139 passed（14+23+21+5+15+61） |
| 6 | 桥闭环 6 文件：`agent-lifecycle.spec.ts`、`bridge-ledger.spec.ts`、`unit/bridge-buffer.spec.ts`、`runtime.spec.ts`、`production-path.spec.ts`、`contract/execution-concurrency.spec.ts` | 干净树 | 0 | 6 files，**71 passed**（13+10+19+23+5+1） |
| 7 | `node --experimental-strip-types --no-warnings scripts/check-evidence-repro.ts` | 干净树 | 1 | “证据复现不成立（5/30 份）”：`G1/G-14.md`、`G2/G-05.md`、`G2/ev-g2-01.md`、`G2/ev-g2-10.md`、`G2/ev-g2-14.md` 重跑与 HEAD 字节不一致。分母写错，实际是 5/25 |
| 8 | `pnpm build`（`tsdown`） | 主仓 | 0 | ESM `lib/index.js` 201.79 kB（gzip 49.07）、`lib/index.d.ts` 16.23 kB、CJS `lib/client.js` 0.29 kB |
| 9 | `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` | 干净树 | 1 | “审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：codebasemap.md”。HEAD 里的 G2 记录仍是第 50 轮（候选 `bad3326`）的预签态，属预期，不作为缺陷 |
| 10 | 对第 7 项点名的 5 份证据逐份重生成并 `diff` | 干净树 + 临时目录 | — | 5 份均为**语义字段漂移**，不是生成器不确定（脚本先比较同一次生成的两遍，未报“生成器不确定”） |

计数口径：候选代码全量 831 passed / 1 skipped；必过集合 139 passed；桥闭环集合 71 passed。主仓的 2 failed 只出现在被并发改脏的 `docs/gates/G1.md` 相关用例上，干净树不存在。

## 二、结论

**结论：fail。P0=0，P1=1，P2=3。**

20 项必过的**行为**全部复跑通过，候选代码没有发现 P0/P1 级行为缺陷；判 fail 的 P1 落在**证据复现契约**：G2 门记录与 `ev-g2-16` 明写“重跑出同样的字节”，而候选 `68fa92b` 上 `G-05`、`ev-g2-01`、`ev-g2-10`、`ev-g2-14` 四份 G2 证据重跑后与 HEAD 字节不一致，`scripts/check-evidence-repro.ts` 直接 exit 1。这与第 35 轮 P1-1（19 份只有 6 份字节复现）同类：行为对，证据账本对不上，门不能按 pass 重签。

修复路径明确：在候选上重生成这四份证据（连同 G1 的 `G-14`），重跑复现守卫到 25/25，再按新哈希重签 G2。

## 三、逐项结论

| 必过项 | 要求 | 行为结论 | 证据复现 | 本轮依据 |
| --- | --- | --- | --- | --- |
| G2-01 | 单节点 queued 到终态一条路径（走生产装配） | pass | **漂移** | `ev-g2-01` 从 HTTP `load → runs → dispatch` 真跑，节点 `nrun_1` 到 `done`、`evidence_source=run_tool`、`report_registry=applied`；重生成多出 `autonomy` 与 `run.terminal`，字节不一致 |
| G2-02 | 重复上报只落一次 | pass | 一致 | `ev-g2-02` 哈希与字节复现通过，`g2.spec.ts` / `apply-report.spec.ts` 通过 |
| G2-03 | 租约过期迟到上报被拒 | pass | 一致 | `ev-g2-03` 复现通过；`apply-report.spec.ts` 租约用例通过 |
| G2-04 | 取消后不产生新 attempt | pass | 一致 | `ev-g2-04` 复现通过；`g2.spec.ts` 与 `sweep.spec.ts` 通过 |
| G2-05 | 终态必带证据 | pass | 一致（`ev-g2-05`）/ 漂移（`ev-g2-10`） | 系统级证据门与痕迹绑定代码在 `apply-report.ts:541/608`，`ev-g2-05` 复现通过；`ev-g2-10` 的对照 run 终态字段漂移 |
| G2-06 | 无裸 blocked（没裁决卡不许卡住） | pass | 一致 | `ev-g2-06` 复现通过；`decision_required` 拒无凭据的 blocked |
| G2-07 | S2 加载 parallel 被拒 | pass | 一致 | `ev-g2-07` 复现通过；`production-path.spec.ts` “定义没加载 404 / 越权在租约前拒”通过 |
| G-03 | 同一 report_id 上报两次只落一次 | pass | 一致 | `G-03.md` 复现通过；`report_registry` 去重 |
| G-04 | 租约到期后原执行器迟到上报被拒 | pass | 一致 | `G-04.md` 复现通过；迟到上报被租约/epoch 拦 |
| G-05 | 工具执行中取消只立一次围栏 | pass | **漂移** | 手工重生成仍只有 1 条 `fence_armed`、第二次 `fence_already_armed`、围栏期间上报被拒、宽限到点 `fence_revoked`；但新增 sweep 字段与 `deadline_at` 非空，字节不再一致 |
| G-07 | 墙钟跳变不误判截止 | pass | 一致 | `G-07.md` 复现通过；`ev-g2-09` 同源证明时限只认 `boot_id` + 单调纳秒 |
| G2-08 | 工具失败不许落完成（系统判失败并挂凭据） | pass | 一致 | `ev-g2-08` 复现通过；`apply-report.ts` 失败终态 `requireFailure:true` |
| G2-09 | 判定时限只认 boot_id 与单调纳秒 | pass | 一致 | `ev-g2-09` 复现通过 |
| G2-10 | 报告入口系统级证据门（弱证据与伪造痕迹一律拒） | pass | **漂移** | 重生成仍拒伪造 `run_tool`（`evidence_unverifiable`）、弱来源（`verification_too_weak`）、空证据（`evidence_missing`）；对照 run 新增 `run.terminal` 且由 running 变 `succeeded_with_unverified` |
| G2-11 | 反复重投同一 report_id 不许把账本刷膨胀 | pass | 一致 | `ev-g2-11` 复现通过；`report_seq` 去重 |
| G2-12 | 工具授权只认 workflow 定义，请求体策略不参与 | pass | 一致 | `ev-g2-12` 复现通过；`production-path.spec.ts` 越权/未注册在租约前拒 |
| G2-13 | 单写者锁与 epoch 围栏：第二写者拿不到锁，旧 epoch 写不进 | pass | 一致 | `ev-g2-13` 复现通过；CAS 带 `action_generation` / `rearm_generation` |
| G2-14 | 长动作靠心跳续租，扫描不误判过期 | pass | **漂移** | 重生成仍显示 2.5 秒扫描不判过期；sweep 结果多出新增字段，字节不一致 |
| G2-15 | 同一工作流的同一版本跨重启不可改写，在飞 run 的判定条件不跟着变 | pass | 一致 | `ev-g2-15` 复现通过；`policyForReport` 比对版本与 `definition_hash`，不符抛 `WORKFLOW_VERSION_IMMUTABLE` |
| G2-16 | Agent Bridge 生产闭环：B01–B10 可复现，工具证据只来自宿主执行 | pass | 手写汇总（不在复现脚本内） | 桥 6 文件 71 passed；B06 独立子进程 SIGKILL → `EVIDENCE_SOURCE_UNAVAILABLE`；工具证据只认 `ReadOnlyToolRunner.runTool()` 落账 |

行为 20/20 通过；证据复现 4 项漂移（`G2-01`、`G2-10`、`G2-14`、`G-05`），所以 `must_pass_passed` 记 20、`failed_items` 留空，P1 单列在证据契约层。这是按第 35 轮同类裁决的口径：P1 不落在单项行为上时，不把行为项改判 fail。

## 四、证据哈希重算

从 `git show HEAD:<path>` 取字节，按 LF 归一后算 sha256，20 份全部与 `docs/gates/G2.md` 的证据表一致（mismatch=0）。

| 证据 | 文件 | sha256（LF 归一） | 与记录 |
| --- | --- | --- | --- |
| ev-g2-01 | `docs/gates/evidence/G2/ev-g2-01.md` | `71825a7db387884c2b9148dc991dc1415b2bb0d0605d05fb780a0990626a76a6` | OK |
| ev-g2-02 | `docs/gates/evidence/G2/ev-g2-02.md` | `346af5813c653ba967af948a74aba27201b9ac906f13e54f4e588f8b18ea70e1` | OK |
| ev-g2-03 | `docs/gates/evidence/G2/ev-g2-03.md` | `5929f803fadbbeabe0a9f9b5b0b65d2d52b429017eaceab56388f165d83d29be` | OK |
| ev-g2-04 | `docs/gates/evidence/G2/ev-g2-04.md` | `65946e22958ef8764415d2af693245f8dc8da33e585ba4cee094e36f56ac71a6` | OK |
| ev-g2-05 | `docs/gates/evidence/G2/ev-g2-05.md` | `6f3b44cf5589ddc059b77f3640e5a23f93eef8351d9c5fba9dd6510abc26e2ba` | OK |
| ev-g2-06 | `docs/gates/evidence/G2/ev-g2-06.md` | `cef5cf3de601985af216cb935334414d56ff9f3f296871f709332f9e16b1f91c` | OK |
| ev-g2-07 | `docs/gates/evidence/G2/ev-g2-07.md` | `64fa6c33ed9f4b33f5f8cc2306a8ad618d99d06ce1698e7aa1c8b537beeae05d` | OK |
| ev-g2-08 | `docs/gates/evidence/G2/ev-g2-08.md` | `86e30ab3215755f2a791614dce667b295a41c0afebce0a7f286920e23e0d9225` | OK |
| ev-g2-09 | `docs/gates/evidence/G2/ev-g2-09.md` | `f43b50982b67843db87e1cae9b36b0048eca372d9734904d3e1090fc97b8d8b2` | OK |
| ev-g2-10 | `docs/gates/evidence/G2/ev-g2-10.md` | `3f3ba0999a89c2986d382e974a68357d1da1e3d015681ea5b7c4f0af5bd543ab` | OK |
| ev-g2-11 | `docs/gates/evidence/G2/ev-g2-11.md` | `fb72ef55124d1b210ff4bf73ad1122cf067ecb93f96265e1fdfbdd050fc815dd` | OK |
| ev-g2-12 | `docs/gates/evidence/G2/ev-g2-12.md` | `5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe` | OK |
| ev-g2-13 | `docs/gates/evidence/G2/ev-g2-13.md` | `a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc` | OK |
| ev-g2-14 | `docs/gates/evidence/G2/ev-g2-14.md` | `61e9c435b7d6b652e87889190af7e932ff54799f4d21d4e2b538f5ec3f050896` | OK |
| ev-g2-15 | `docs/gates/evidence/G2/ev-g2-15.md` | `8c21ebd8e00ea8563f910fd2f3b3beb96b678812260620c9d0f05480e1f7ca6d` | OK |
| ev-g2-16 | `docs/gates/evidence/G2/ev-g2-16.md` | `8caea691cb48306c222f05fef387f96a5a5abf984cf05bb926eb420328575a76` | OK |
| ev-g2-g03 | `docs/gates/evidence/G2/G-03.md` | `514f9754fda67b8e1522d086fc6079301e00bd0185f9cca6dddec502c412ab70` | OK |
| ev-g2-g04 | `docs/gates/evidence/G2/G-04.md` | `a30155a2446531f5c5cd2677946805ca9a78f407cfc4626147f20fcd446eb961` | OK |
| ev-g2-g05 | `docs/gates/evidence/G2/G-05.md` | `d400f29ddeb1e0578c132e0a9abef1e0e3fc123179bfd90a692f526564285f4c` | OK |
| ev-g2-g07 | `docs/gates/evidence/G2/G-07.md` | `de51ca56aba24af02f7c1ef2c0bfba5248da11b5aaa7ba163aafacf9d8e0746a` | OK |

“哈希一致”只说明存下来的字节没被改；**不说明这些字节还能由当前代码重跑出来**。第 7 项命令正是在补这个缺口，它点名了 5 份。

## 五、门自锚复核

对 HEAD 里的 `docs/gates/G2.md`（第 50 轮记录，`audit_round=50`，报告指向 `S2-independent-audit-round50.md`）重算：

| 哈希 | 结果 |
| --- | --- |
| `artifact_hash` = `c5b4564a...501f4d5a` | 由 GateArtifact 的 canonical JSON 重算一致 |
| `body_hash` = `daec42cc...0132a4a` | 按正文归一化（两个自锚点、反引号内 64 位 sha256 换占位符）重算一致 |
| `evidence_index_hash` = `45cb5d6d...6140239` | 由 20 行证据表按 id 升序重算一致 |
| `invariants_hash` = `6a7adcb0...38768e` | 由 12 条不变量表重算一致 |
| `candidate_hash` / `change_scope_hash` | 仍锚在第 50 轮候选 `bad3326`，与本轮候选 `68fa92b` 不同 |

也就是说：记录自身的哈希链是闭合的，但它是**本轮候选之前**签的，不能直接复用到本轮；`gate-check` 在干净树报“候选之后文件又被改过”属预签态，不是门的失败。本轮报告落地后，需要按新候选重算 `candidate_hash` / `change_scope_hash`，并在证据重生成后更新证据表与 `evidence_index_hash`。

另记：审计期间另一 agent 在同一主工作树把 G1/G2/G3 的 `audit_round` 改成 51、报告路径指向 round51（未提交）。本报告只审 HEAD 的已提交记录，不把工作树里的未提交编辑计入候选。

## 六、专题复核

### 6.1 单 agent 生产闭环

`tests/e2e/production-path.spec.ts` 走真实 `openServiceOrchestra` + `startServer`，用 HTTP 完成 `POST /v1/workflows/load → POST /v1/runs → POST /v1/runs/dispatch`，节点由真实 dispatcher 拾起、真实 `runNode` 执行、真实 `applyReport` 六步收口，账本与 `report_registry` 都是生产表。5 个用例覆盖：全链路 done、定义未加载 404、授权只认定义（越权/未注册在租约前拒、节点保持 queued）、省略 agents 走 `bridge.spawn` 兜底、节点缺工具配置 skipped 不动状态。

替身只在宿主边界：e2e 的 `HostRunner` 直接返回 `exitCode 0 / stdout "ok\n"`，agent 用 `tests/fixtures/agent-bridge.ts` 的 fake client。命令层、状态机、证据门、工具执行器 `ReadOnlyToolRunner` 都是生产代码；`src` 内检索 `fake|fixtures` 无命中，生产代码不引用测试假件。真实宿主执行由 `ev-g2-16` 的 B06 独立子进程覆盖（SIGKILL 后 `EVIDENCE_SOURCE_UNAVAILABLE`）。

### 6.2 工具执行唯一身份（execution_id / tool_seq）

- 迁移 `src/infra/sqlite/migrations/006_tool_executions_tool_seq.sql`：主键 `(node_run_id, attempt, tool_seq)`，`execution_id TEXT NOT NULL UNIQUE DEFAULT ('tex_'||...)`，旧行按 `row_number` 补 `tool_seq` 与 `texm_` 前缀。
- `src/executor/evidence-collector.ts:162` `nextToolSeq()` 取 `MAX(tool_seq)+1`，`:163` 生 `executionId`，`:169-178` 写 `tool_started`（带两者），`:180` 调 `runner.runTool(...)`，`:194-203` 生成 trace，`:208-235` 写 `tool_executions` 与 `tool_finished`（同 `execution_id`），并更新 `bridge_tool_outbox`。
- `src/service/commands/apply-report.ts:608` 的 `traceBindingGate` 取同 attempt 的工具执行行，报告 `evidence_trace.executionId` 必须按 `execution_id` + `toolSeq` 命中，哈希逐字段全等；`:670-690` 还要求 `tool_finished` 事件带同一个 `execution_id`。伪造 trace 在 `ev-g2-10` 被 `evidence_unverifiable` 拒。

### 6.3 强证据与产物哈希

`systemEvidenceGate`（`apply-report.ts:541`）只认 `source='run_tool'` 且 `exitCode=0`；done 还必须过痕迹绑定、`requiredHashes` 与 `passConditions`，失败/超时走 `traceBindingGate({allowFailed:true, requireFailure:true})`。产物哈希用 canonical JSON 计算，空证据、弱来源、伪造来源三条路径在 `ev-g2-10` 分别得到 `evidence_missing` / `verification_too_weak` / `evidence_unverifiable`。

### 6.4 scope / 租约 / 迟到回写

节点写入统一走 `src/service/commands/nodes.ts` 的 `applyTransition`：单条 CAS，`WHERE` 带 `status IN`、`attempt`、`revision`、`action_generation`、`rearm_generation`，`hang_reason IS NULL`（仅 `allowHung` 可绕），`patch` 只认 `PATCH_COLUMNS`，`changes!==1` 抛 `STALE_GENERATION`。租约 30 秒、心跳 10 秒；过期后的迟到上报在 `ev-g2-03` / `G-04` 被拒，重复 `report_id` 只落一次（`ev-g2-02` / `G-03`），重投不刷膨胀（`ev-g2-11`）。

### 6.5 报告六步

`apply-report` 的顺序是：查 `report_registry` 去重 → schema 校验 → status/attempt/generation CAS + 租约 → done 强证据门 → 判定条件（`passConditions` / `requiredHashes`）→ `transitionNode`。`policyForReport` 从 run 行取 `workflow_id` / `workflow_version` / `definition_hash`，与目录当前定义比对，版本被改写抛 `WORKFLOW_VERSION_IMMUTABLE`（`ev-g2-15`）。

### 6.6 终态、收口与取消

`src/service/commands/run-close.ts` 的 `closeRun`：非终态、空节点、活跃 decision、`assertRunCanTerminal` 失败都返回 null；终态优先级 `failed_with_unverified/failed > orphaned（无 replacement）> 未验证副作用 > succeeded`，写 `run.terminal` 事件。单节点入口 `index.ts:181-183` 与 dispatcher `dispatcher.ts:58` 都会在派发后收口，这是 `ev-g2-01` / `ev-g2-10` 新增 `run.terminal` 的来源。

取消统一走 `src/service/commands/cancel.ts` 的 `applyCancel`，各分支经 `applyTransition`：终态 → `already_stopped` 不写状态；queued/leased → `superseded`（M-62）；interrupted → `timing_out` 并立 fence（已有 armed 则 `fence_already_armed`）；围栏期间迟到上报被拒，工具落地后收口 `STALE_GENERATION`；宽限到点 `revokeFence` 只撤一次。`G-05` 重生成仍只有一条 `fence_armed`，行为成立。

### 6.7 桥生命周期与 G2-16

B01/B02/B03/B07/B08/B09/B10 在 `tests/integration/agent-lifecycle.spec.ts`，B04/B05 在 `bridge-ledger.spec.ts`，B06 在 `runtime.spec.ts:369`（独立子进程 SIGKILL，标记只出一次），B03 另有 `tests/unit/bridge-buffer.spec.ts`。6 文件实测 **71 passed**。`ev-g2-16` 是手写汇总，不在 `check-evidence-repro.ts` 的 CASES 内，所以它的“70 项”不会被脚本抓出来（见 P2-1）。

### 6.8 G-03 / G-04 / G-05 / G-07 可重跑性

`G-03`、`G-04`、`G-07` 三份字节复现通过；`G-05` 失败。失败不是环境差异：复现脚本每份跑两遍，先互比（两遍相同），再对 HEAD 比，所以是**生成器输出随代码变化而漂移**：

- `G-05`：sweep 结果新增 `chain_broken` / `startup_unknown_expired` / `bridge_paused` / `bridge_restored` / `wait_timed_out=0`；节点 `deadline_at` 由 `null` 变具体时间（`revokeFence` 重武装动作截止）。
- `ev-g2-01`：建 run 响应多 `autonomy:"autonomous"`；事件多 `run.terminal`；run 由 running 变 `succeeded_with_unverified`。
- `ev-g2-10`：对照 run_2 由 running 变 `succeeded_with_unverified` 并多 `run.terminal`；sweep 结果同样多字段。
- `ev-g2-14`：sweep 结果多同批字段。

另：G1 的 `G-14` 也从 18 张表漂到 23 张（014..023 迁移），不在 G2 候选范围，但同属“代码前进、证据没重生成”的同一类问题，建议一并重签。

### 6.9 生产路径是否绕过测试假件

没有。`src` 内无 `fake` / `fixtures` 引用；e2e 用的是真实 HTTP 入口、真实 SQLite 账本、真实命令层与证据门。宿主执行器在 e2e 是替身，但这是宿主边界，不是 S2 的判定逻辑；真实宿主由 B06 的独立子进程验证。可以接受，前提是报告里不把 e2e 的 run 终态当作“真实宿主已验证”。

## 七、攻击矩阵

| 攻击 | 结果 | 证据 |
| --- | --- | --- |
| 伪造 `source=run_tool` 证据 | 拒，`evidence_unverifiable` | ev-g2-10 |
| 弱来源（`tool_result`）冒充强证据 | 拒，`verification_too_weak` | ev-g2-10 |
| 空证据落 done | 拒，`evidence_missing` | ev-g2-10 |
| 租约过期后原执行器迟到上报 | 拒 | ev-g2-03 / G-04 |
| 同一 `report_id` 重投 | 只落一次，不刷账本 | ev-g2-02 / G-03 / ev-g2-11 |
| 工具执行中取消 | 只立一次围栏，迟到写回 `STALE_GENERATION` | G-05 |
| 墙钟跳变 / 跨 boot 判超时 | 不误判 | G-07 / ev-g2-09 |
| 同版本改写工作流定义 | 拒，`WORKFLOW_VERSION_IMMUTABLE` | ev-g2-15 |
| 第二写者 / 旧 epoch 写入 | 拿不到锁 / 写不进 | ev-g2-13 |
| 桥进程 SIGKILL 后重连 | 不盲目重跑，`EVIDENCE_SOURCE_UNAVAILABLE` | B06 |
| 请求体自带工具策略越权 | 不参与判定，租约前拒 | ev-g2-12 |

## 八、加固建议

1. **先修 P1**：在 `68fa92b` 上重生成 `G-05`、`ev-g2-01`、`ev-g2-10`、`ev-g2-14`（以及 G1 的 `G-14`），提交证据，跑 `check-evidence-repro.ts` 到全绿，再重算证据表与 `evidence_index_hash`，最后重签 G2。顺序不能反：`sign-gate.ts` 要求工作树干净，且证据哈希只认 HEAD 字节。
2. **修 `check-evidence-repro.ts` 的分母**：现在是 `problems.length + checked`，5 个问题报成 5/30；应报 5/25。纯文案问题，但会误导“还有 25 份没查”的判断。
3. **对齐 G2-16 计数**：`ev-g2-16.md` 与 `G2.md` 的“70 项”改为 71；顺带把“42 files / 624 passed”的旧全量数改为当前 60 files / 831 passed。
4. **补一个 run 终态断言**：`production-path.spec.ts` 现在只断言节点 done，不断言 run 的终态；而迁移 017 把 `side_effect_policy` 默认设为 `compensable`，`src` 内没有代码写这一列或 `side_effect_verified_none`，生产 run 实际恒为 `succeeded_with_unverified`。要么把工作流定义的策略接进建节点 INSERT，要么在门记录里写清“生产 run 一律未验证副作用”，并给 e2e 加断言。
5. 重签时同步更新 `G2.md` 的审计锚点与本报告 sha256，避免出现“报告在 HEAD、门记录仍指旧轮次”的中间态。

## 九、P0 / P1 / P2

**P0：无。**

**P1-1（证据复现契约不成立）**

`G2.md` 第 11 行与复现命令段明写“重跑出同样的字节”，`check-evidence-repro.ts` 也在重签前跑。候选 `68fa92b` 上：

```
证据复现不成立（5/30 份）：
 - docs/gates/evidence/G1/G-14.md：重跑与 HEAD 字节不一致，证据已漂移，重生成并重签
 - docs/gates/evidence/G2/G-05.md：同上
 - docs/gates/evidence/G2/ev-g2-01.md：同上
 - docs/gates/evidence/G2/ev-g2-10.md：同上
 - docs/gates/evidence/G2/ev-g2-14.md：同上
```

四份 G2 证据的行为仍成立（我逐份重跑对账：G-05 仍一条围栏、ev-g2-01 仍全链路 done、ev-g2-10 仍三拒、ev-g2-14 仍不误判过期），但字节已随 S3 的 `closeRun` / sweep 字段 / `revokeFence` 重武装变化。门记录若按当前字节签 pass，等于把“旧代码的快照”当成“新代码的证据”。按第 35 轮同类裁决，判 P1、conclusion fail；修复是重生成并重签，不是改行为。

**P2-1（G2-16 计数过期）** `ev-g2-16.md` 与 `G2.md` 写“6 files, 70 tests”，实测 71；同段“pnpm test 42 files 624 passed”也早于当前 60 files 831 passed。行为通过，数字失修。

**P2-2（生产 run 终态覆盖缺口）** 迁移 017 的 `side_effect_policy` 默认 `compensable`，`src` 内无写入点，`side_effect_verified_none` 也无人写；`closeRun` 的 `unverified` 恒真，生产 run 只会收口为 `succeeded_with_unverified`。`run-close.spec.ts` 显式设 `pure` 才测到 `succeeded`，`production-path.spec.ts` 不断言 run 终态。行为不违反 G2 必过项（G2-01 是节点级），但终态语义与覆盖需要补。

**P2-3（复现守卫分母文案错）** `check-evidence-repro.ts:56` 用 `checked + problems.length` 当分母，5 个问题报成“5/30”，实际检查 25 份。只影响报错可读性。

## 十、裁决

<!-- audit-verdict:begin -->
```json
{"schema":"audit-verdict/1","gate":"G2","audit_round":51,"candidate_commit":"68fa92bf9bd6257eedfba6494b654b7de08639e7","conclusion":"fail","p0":0,"p1":1,"p2":3,"must_pass_total":20,"must_pass_passed":20,"must_pass_ids":["G2-01","G2-02","G2-03","G2-04","G2-05","G2-06","G2-07","G-03","G-04","G-05","G-07","G2-08","G2-09","G2-10","G2-11","G2-12","G2-13","G2-14","G2-15","G2-16"],"failed_items":[],"notes":"20/20 必过行为复跑通过；P1 落在证据契约：G-05/ev-g2-01/ev-g2-10/ev-g2-14 重跑漂移（另 G1/G-14），check-evidence-repro exit 1（5/25）。需重生成证据并重签。P2：G2-16 写 70 实测 71；生产 run 恒为 succeeded_with_unverified 且 e2e 未断言；复现守卫分母 5/30 应为 5/25。"}
```
<!-- audit-verdict:end -->
