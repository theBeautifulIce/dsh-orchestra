# S5 副作用核实与结算契约（附录）

> 工作包：S5-A（只写契约，不实现写入口）。
> 性质：本文件是《工作流编排设计规格 v1.3》（`docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md`）§4.5.5 / §8.2 / §9 的**补充附录**，不改动既有编号章节正文（那会打断六份计划共 468 处规格行号引用）。先例：`docs/superpowers/specs/2026-11-12-run-shared-context-addendum.md`。
> 适用范围：`unverified_resolutions` 表的写入语义、结算判定矩阵、事务与幂等规则、读模型可见性、错误码。
> 不在本文件范围：面板形态（§8.5，工作包 S5-C/S5-I）、记忆受控写入（§9，工作包 S5-E…S5-I）、G5 门记录。

## 0. 术语与真相源

| 术语 | 定义 |
| --- | --- |
| 结算（resolution） | 在 `unverified_resolutions` 落一行，表示「该节点这次尝试的副作用后果已被核实为**已发生**或**已确认没发生**」 |
| 真相源 | `unverified_resolutions` 表。读模型只认表：有行 = `resolved=true`，无行 = `resolved=false`；`resolved_at` / `resolution_basis` 直取，不在查询时重算 |
| 停 | 动作被要求停止或已停止的事实（`stopped_at` / `stop_evidence`）。停**不是**结算 |
| 签字 | 人接下了后果（`abandon_ack.approved`）。签字**不是**结算，只解裁决门 |
| 人证 | `attestations` 行（`action_start_source='human_attested'`）、人的 claim、模型自述。人证**不是**系统证据 |
| 系统证据 | `tool_executions` 行 + 同 attempt 的 `tool_finished` 节点事件 + 有效事件链。证据 ID = `tool_executions.execution_id` |
| 强/弱证据 | 强 = `runTool` 只读身份产生的系统证据（`evaluateEvidence` 返回 `strength='strong'`）；弱 = 模型侧 `tool_result` |

硬约束（来自既有设计与迁移，不可协商）：

- `node_runs` 上不得另存 `resolved` / `resolved_at` / `resolution_basis`（Q-32）；结算状态只由表行表达。
- 缺列不得用空值或布尔伪造：`node_runs` 没有 `stopped_at` / `last_known_phase` / `evidence` 列，读模型不得凭空造列。
- 一个 `node_run_id` 只能有一条结算行（主键 + 禁改删触发器）。
- 人工裁决也必须过同一个证据门，不许在裁决路径上手写一遍判定。

## 1. 三条结算路径

| basis | 结论 | 依据字段 | 依据来源 |
| --- | --- | --- | --- |
| `verified_none` | 已确认**没发生** | `stop_evidence`（与 `node_runs.stop_evidence` 逐字节相同） | 系统确认（从未执行 / 执行但未生效），或人工裁决 + 同一道证据门 |
| `evidence` | 系统证据证明**已发生** | `evidence_id` = `tool_executions.execution_id` | 宿主只读工具痕迹 |
| `decision` | 人工裁决认定**已发生** | `decision_id`（证据引用记在 `decisions.payload_json`，因 029 的 CHECK 强制 decision 分支的 `evidence_id` 为 NULL） | 人工裁决卡（带通过证据门的证据引用） |

三条路径互斥（029 的三分支互斥 CHECK）。**「没发生」永不落 `decision` 分支**（schema 结构性规定）；**「已发生」可落 `evidence` 或 `decision`**。

## 2. 判定矩阵

### 2.1 `evidence` 分支（已发生，系统证据）

可接受条件（全部满足）：

- E1 `evidence_id` 命中 `tool_executions.execution_id`；
- E2 该行 `node_run_id` = 目标节点、`run_id` 相同、`attempt` = `node_runs.attempt`（**当前代次**）、`finished_at` 非空；
- E3 存在匹配该 `execution_id` 的 `tool_finished` 节点事件，且 payload 的 `tool` / `attempt` / `exit_code` / `stdout_hash` / `stderr_hash` / `command_hash` / `finished_at` 与行逐字相符；
- E4 该节点的**事件链有效**：写事务用账本密钥校验 `chainBreakOf(secret, chain) === null`（031 注释已写明：事件链验证属于服务写事务，SQL trigger 不能验证哈希）；
- E5 证据强度 = `strong`（`evaluateEvidence` 的 `ev.source === 'run_tool'`）；弱证据不构成结算依据；
- E6 目标节点 `side_effect_policy <> 'pure'`；
- E7 目标节点在 `unverified_resolutions` 无行。

### 2.2 `decision` 分支（已发生，人工裁决）

允许作依据的决定：

- D1 `decisions.kind IN ('verify_human', 'action_overrun')`；
- D2 决定是**节点级**：`decisions.node_run_id` = 目标节点；
- D3 `status = 'resolved'`；
- D4 `closed_reason = 'approved'`（**不是** `rejected` / `expired_final` / `expired`）；
- D5 `decided_at` 非空；
- D6 `payload_json.effect_verdict = 'applied'`（本次裁决对副作用的结论 = 已发生）；
- D7 `payload_json.evidence_ids` 非空数组，且每条按 §2.1 的 E1–E5 **全部**通过（同一道证据门）；
- D8 目标节点 `side_effect_policy <> 'pure'`；
- D9 目标节点在 `unverified_resolutions` 无行。

**明确不可作结算依据**（逐条给出理由，防止后续实现按「status=resolved 就行」放行）：

| 情形 | 为什么不作结算依据 |
| --- | --- |
| `abandon_ack`（任何 resolution，含 `approved`） | 签字只表示人接下了后果，不表示副作用已消失；签字后该动作在未验证副作用清单里长期留痕，不许抹掉 |
| `startup_unknown` 的 `confirm_started` / `confirm_started_attested` | 只证明有人看见动作开跑，是人证状态事实，不是副作用结论 |
| `closed_reason IN ('rejected','expired_final')` | 结论是「不成立 / 过期」，不是「副作用已发生」 |
| `status != 'resolved'` 或 `decided_at` 为空 | 决定还没收口，结论未定；`confirm_applied` / `confirm_not_applied` 这类非收口写法只推进 `revision`，不写 `decided_at`，不构成收口结论 |
| `report_contradicted` 的 `uphold_report` | 走 applyReport 的同一道证据门并按 M-59 收口，结算 basis 记 `evidence`，不记 `decision` |
| `pre_execution` / `audit_result` / `rule_ambiguous` | 与副作用结论无关 |
| `payload.effect_verdict` 缺失或不是 `applied` | 无副作用结论，只有「批准了这张卡」 |

### 2.3 `verified_none` 分支（已确认没发生）

- V1 目标节点 `side_effect_policy <> 'pure'`；
- V2 目标节点 `side_effect_verified_none = 1`；
- V3 `node_runs.stop_evidence` 非空，且只能是下面两种之一：
  - **N1 账本事实**：该 attempt 从未开跑（账本中无 `tool_started` 事件），或执行器确认动作已停且未生效。取值必须能定位到具体事实，前缀 `no_tool_started:` 或 `stopped_confirmed:` 加 `<node_run_id>:<attempt>[:<event_seq>]`；
  - **N2 强证据**：一条证明动作未生效的强证据 `tool_executions.execution_id`，且该证据按 §2.1 的 E1–E5 全部通过。
  - **禁止**：空串；「已核实」「无副作用」「已确认没问题」这类无信息量文本；人证 claim 或 `attestation_id`。
- V4 结算行 `stop_evidence` 与 `node_runs.stop_evidence` **逐字节相同**（029 触发器 `unverified_resolution_scope_guard` 强制）；
- V5 结算行 `evidence_id` 与 `decision_id` 均为 NULL（029 CHECK 强制）；
- V6 目标节点在 `unverified_resolutions` 无行；
- V7 目标节点状态在允许集内（见 §3）。

写入纪律：结算 `verified_none` 时**必须同事务**写 `node_runs.side_effect_verified_none = 1` 与 `node_runs.stop_evidence`（因为 V4 要求两者一致）。因此该路径不能只写结算表；先写节点字段，再写结算行，让 029/031 触发器看到一致状态。

### 2.4 拒绝与错误码

| 条件 | 错误码 |
| --- | --- |
| E1 / E2 / E3（证据不命中、代次不符、未结束） | `RESOLUTION_NOT_AVAILABLE` |
| E4（事件链断裂 / 无匹配 `tool_finished` 事件） | `EVIDENCE_SOURCE_UNAVAILABLE` |
| E5（弱证据） | `VERIFICATION_TOO_WEAK` |
| E6 / V1（`side_effect_policy='pure'`） | `SIDE_EFFECT_UNDECLARED` |
| D1–D9 任一条不满足（决定 kind / 收口态 / payload 不合 / 证据不过门） | `RESOLUTION_NOT_AVAILABLE` |
| 目标节点已在 `unverified_resolutions` 有行，但 basis 或依据与本次不同 | `EFFECT_RESOLUTION_CONFLICT`（**新增**，409） |
| 目标节点已在表中有行且 basis 与依据**完全相同** | 不报错：按幂等回执重放（`replayed=true`），不新增行 |
| 节点 `revision` / `status` 对不上 | `STALE_GENERATION` |
| 决定 `revision` 对不上 | `DECISION_REVISION_CONFLICT` |
| 无权限 | `FORBIDDEN` |
| 载荷不合 | `PAYLOAD_SCHEMA_INVALID` |

## 3. 节点状态 × basis 相容矩阵

结算**不改节点状态**。节点状态迁移仍由既有迁移表负责（M-33 / M-35 / M-36 / M-38 / M-51 / M-52 / M-59 等）；若业务同时需要迁移，必须与结算在同一事务里完成。

| 节点状态 | `verified_none` | `evidence` | `decision` | 说明 |
| --- | --- | --- | --- | --- |
| `failed` | ✅ | ❌ | ❌ | 动作未执行 → 确认没发生 |
| `stopping` | ✅ | ✅ | ✅ | 停止待确认；裁决卡通常挂在此 |
| `indeterminate_side_effect` | ✅ | ✅ | ✅ | 效果不确定；已发生走 M-51，没发生走 M-52 |
| `abandoned_unverified` | ✅ | ❌ | ❌ | 已放弃的节点不再产生「已发生」的新证据 |
| `failed_with_unverified` | ✅ | ✅ | ✅ | 失败但副作用未核实 |
| `done` | ❌ | ✅ | ❌ | 已完成节点的「已发生」结论由 applyReport 的 done 收口事务同事务落表 |
| `running` / `waiting` / `blocked_pre` / `verifying` / `superseded` / 其它 | ❌ | ❌ | ❌ | 不接受结算：动作还没到可核实的状态，或已终结且结论应在其收口事务里落表 |

规则：

- V-A 可结算状态集按 basis 如上；不在集内一律 `RESOLUTION_NOT_AVAILABLE`。
- V-B 结算不改节点状态；需要迁移时与结算同事务走既有迁移边。
- V-C `abandoned_unverified` 只允许 `verified_none`。

## 4. 事务步骤（每个结算写事务）

同一笔 `BEGIN IMMEDIATE` 内按序执行：

1. **幂等**：`runIdempotentCommand(tx, { kind: 'effect.resolve', operationId, requestHash: sha256Hex(canonicalJson({command, target, expected, payload})), now }, apply)`。
   - `kind` 固定 `effect.resolve`；一个 `operation_id` 最多一条 inbox 行；
   - 回执窗口 7 天（规格 §3.7）；过期先判 `OPERATION_EXPIRED`；
   - 业务失败整笔回滚，inbox 行不残留，可用同一 `operation_id` 重试。
2. **schema 校验**：`basis` / `node_run_id` / 依据字段必填；`expected.revision`（节点 revision）必填。
3. **作用域**：节点存在、`run_id` 与请求一致、`side_effect_policy <> 'pure'`。
4. **CAS**：
   - 结算表：已有行 → 同 basis 同依据走幂等重放；否则 `EFFECT_RESOLUTION_CONFLICT`；
   - 节点：`UPDATE node_runs ... WHERE node_run_id = ? AND revision = ? AND status IN (<允许集>)`，`changes != 1` → `STALE_GENERATION`；
   - 决定：`status IN ('pending','acknowledged','blocked_for_human')` 且 `revision = expected.decision_revision`，`changes != 1` → `DECISION_REVISION_CONFLICT`。
5. **证据门**（按 basis，§2）：evidence → E1–E5；decision → D1–D7（每条 evidence_ids 逐条走 E1–E5）；verified_none → V2–V3 与 N1/N2 判定。
6. **落库**：
   - `verified_none`：先写 `node_runs.side_effect_verified_none = 1` 与 `stop_evidence`，再写结算行（`stop_evidence` 同值、`evidence_id`/`decision_id` 为 NULL）；
   - `evidence`：写结算行（`evidence_id` = `execution_id`，`decision_id`/`stop_evidence` 为 NULL）；
   - `decision`：写结算行（`decision_id`，其余为 NULL）。
7. **事件**：`appendNodeRunEvent(tx, secret, node_run_id, 'effect.resolved', payload)` 写节点链（payload 至少含 `node_run_id` / `run_id` / `resolution_basis` / `resolved_at` / `revision` / `evidence_id?` / `decision_id?` / `stop_evidence?`）；
   `appendEvent(tx, { runId, nodeRunId, type: 'effect.resolved', payload })` 写 run 级事件供 SSE 失效信号（EventInput 字段为 camelCase，见 `src/infra/db/ledger.ts:7-16`）。事件只作失效信号，不作数据源。
   - **人工「没发生」裁决时**，结算行按 029 CHECK 不存 `decision_id`，故 `effect.resolved` 事件 payload **必须**带 `decision_id`，保证审计可回溯到那张裁决卡。
8. **回执**：`receipt_json = { node_run_id, resolution_basis, resolved_at, node_revision, evidence_id?, decision_id?, stop_evidence? }`。
9. **失败**：任一步抛错 → 整笔回滚（节点字段与结算行都不留半成品）。

**人工裁决的收口编码**（S5-C 必须按此实现）：

- 面板仍只用 §8.4 的六个命令，**不新增面板写命令**。结算的写入口是服务命令：
  - `evidence` 分支：由 applyReport 的 done 收口事务内部写入（证据门已过、`traceBindingGate` 已对齐同 attempt 的工具痕迹）；
  - `decision` 分支：由 `resolveDecision` 的收口事务内部写入；
  - `verified_none` 分支：由服务内部结算命令写入（宿主 / 执行器确认路径），普通 Agent 不可调用。
- `decision` 分支的收口编码：`resolveDecision(resolution='approved', payload = { effect_verdict: 'applied', evidence_ids: [...] })` **同事务**写结算行。
  - 理由：031 的 `unverified_resolution_basis_guard` 要求 decision 分支的决定必须 `status='resolved'` 且 `decided_at` 非空；只有收口写法（`approved`/`rejected`/`expired`/`uphold_report`/`uphold_decision`）才写 `status='resolved'` 与 `decided_at`；`confirm_applied`/`confirm_not_applied` 是非收口写法（只推进 `revision`），不能单独触发结算。
  - `payload` 合并语义是累积的（`{...current.payload_json, ...req.payload}`），因此先以 `confirm_applied` 记录中间结论、再以 `approved` 收口的写法也成立，但**结算必须发生在收口的那一笔**。
  - 人工认定「没发生」时：同一笔里先写 `node_runs.side_effect_verified_none=1` + `stop_evidence`（取该裁决引用的强证据 `execution_id`，即 N2），再写 `verified_none` 结算行（`stop_evidence` 同值），并在 `effect.resolved` 事件里带 `decision_id`。

## 5. 权限

- 结算写入口只允许人（human actor）或具备 `orchestra.audit` capability 的 agent 调用，沿用 `assertApprover` 的档位；决定的 `approver` 决定谁可以收口。
- **普通 Agent 无权结算**，也不得通过任何工具直接写 `unverified_resolutions` / `node_runs.side_effect_verified_none`（与 §9 记忆写入口同一纪律：唯一写入口受控）。
- `evidence` 分支的写入者是服务内部（applyReport 事务），不经外部写入口。

## 6. 错误优先级（多个条件同时不满足时）

1. operation 层：`OPERATION_EXPIRED` → `OPERATION_ID_CONFLICT` → `COMMAND_BUSY`（沿用 `src/service/commands/idempotency.ts` 既有顺序：过期判断先于回执存在性判断）。
2. 载荷：`PAYLOAD_SCHEMA_INVALID`。
3. 作用域：`NOT_FOUND`（节点 / 决定不存在）→ `SIDE_EFFECT_UNDECLARED`（`policy='pure'`）。
4. 冲突：`EFFECT_RESOLUTION_CONFLICT` → `DECISION_REVISION_CONFLICT` → `STALE_GENERATION`。
5. 政策与证据：`RESOLUTION_NOT_AVAILABLE` → `EVIDENCE_SOURCE_UNAVAILABLE` → `VERIFICATION_TOO_WEAK` → `FORBIDDEN`。
6. 其余异常一律冒泡（不吞、不降级）。

## 7. 读模型可见性

- 待核实清单（`listUnverifiedEffects`）只认表：节点一旦有结算行，就**不再出现在待核实清单**（工作包 S5-C 的验收口径「已核实记录只有在合法同事务结算后消失」）。清单内 `resolved` 恒为 `false`、`resolved_at`/`resolution_basis` 恒为 `null`。
- 结算不抹痕：结算行留在 `unverified_resolutions`（只追加、禁改删），事件留在节点链与 run 事件表。
- run 进终态**不消项**：未结算的项仍是未结算；已结算的项不改写历史。
- **run 终态判定口径必须改**（S5-C 责任）：`src/service/commands/run-close.ts:60` 现口径为 `side_effect_policy <> 'pure' AND side_effect_verified_none <> 1`，既不检查 `stop_evidence` 非空，也完全不看 `unverified_resolutions` 表 —— 结果是「已核实为已发生」的节点仍被算成未验证，run 只能进 `succeeded_with_unverified`。改为：
  - 节点有非 pure 副作用策略，且 **既没有** `side_effect_verified_none = 1`（且 `stop_evidence` 非空）**也没有**结算行 → 才算未验证。
  - 改后，「已发生且已核实」的节点不再阻塞 `succeeded`（与 §4.8「不许存在**未验证**副作用」的原意一致）。
  - **不回填历史**：已收口 run 的终态事件不改写；新口径只对变更后新收口的 run 生效（S5-C 必须显式测试这一点并在报告里写明）。
- `UnverifiedEffectView` 的 `stopped_at` / `last_known_phase` / `evidence` 三列在 `node_runs` 上无对应列：**不许用 `started_at` 顶替 `stopped_at`、不许用布尔伪造 `evidence`**。S5-C 若要在面板显示这三列，必须先补列（迁移）或在读模型里返回 `null` 并在 UI 上标「未知」，不得推断。

## 8. 人工声明的边界（不可伪装成系统证据）

- 人证只能进 `attestations` 表；不得出现在 `evidence_id`、不得作为结算依据、不得写进 `tool_executions`。
- `action_start_source='human_attested'` 的记录只作状态事实（动作是否开跑），不支撑「已验证」。
- 模型的 `tool_result`、自然语言声明、面板按钮都不是证据行。
- 人证卡在 UI 上固定标「人证，不是系统证据」（§4.5.7）；签字只显示「人已签字」。
- 顶部固定句：「签字只表示人接下了后果，不表示副作用已消失。」

## 9. 新增错误码（登记到 `src/core/errors.ts` 与规格 §17.1）

- `EFFECT_RESOLUTION_CONFLICT`（409）：目标节点已有结算行，且 basis 或依据与本次不同。

其余全部复用既有码（`RESOLUTION_NOT_AVAILABLE` / `EVIDENCE_SOURCE_UNAVAILABLE` / `VERIFICATION_TOO_WEAK` / `SIDE_EFFECT_UNDECLARED` / `DECISION_REVISION_CONFLICT` / `STALE_GENERATION` / `FORBIDDEN` / `PAYLOAD_SCHEMA_INVALID` / `NOT_FOUND`）。本包只登记，不实现。

## 10. 故障案例与对应测试名（S5-C 的验收清单）

建议落点 `tests/integration/effect-resolution.spec.ts`（S5-C 建立）。

| # | 场景 | 期望 | 测试名 |
| --- | --- | --- | --- |
| 1 | 证据 `execution_id` 不存在 | `RESOLUTION_NOT_AVAILABLE` | `rejects_unknown_evidence_id` |
| 2 | 证据 attempt 不是节点当前代次 | `RESOLUTION_NOT_AVAILABLE` | `rejects_stale_attempt_evidence` |
| 3 | 证据 `finished_at` 为空 | `RESOLUTION_NOT_AVAILABLE` | `rejects_unfinished_execution` |
| 4 | 无匹配 `tool_finished` 事件 | `EVIDENCE_SOURCE_UNAVAILABLE` | `rejects_missing_tool_finished_event` |
| 5 | 节点事件链断裂 | `EVIDENCE_SOURCE_UNAVAILABLE` | `rejects_broken_event_chain` |
| 6 | 弱证据（模型侧 `tool_result`） | `VERIFICATION_TOO_WEAK` | `rejects_weak_evidence` |
| 7 | `side_effect_policy='pure'` 的节点 | `SIDE_EFFECT_UNDECLARED` | `rejects_pure_policy_node` |
| 8 | 以 `abandon_ack.approved` 作依据 | `RESOLUTION_NOT_AVAILABLE` | `rejects_abandon_ack_as_basis` |
| 9 | 决定 `closed_reason='rejected'` | `RESOLUTION_NOT_AVAILABLE` | `rejects_rejected_decision_as_basis` |
| 10 | 决定未收口（status 活跃） | `RESOLUTION_NOT_AVAILABLE` | `rejects_unresolved_decision_as_basis` |
| 11 | 决定 payload 缺 `evidence_ids` | `RESOLUTION_NOT_AVAILABLE` | `rejects_decision_without_evidence` |
| 12 | 把 `attestation_id` 当 `evidence_id` | `RESOLUTION_NOT_AVAILABLE` | `rejects_attestation_as_evidence` |
| 13 | 节点状态不在允许集（如 `running`） | `RESOLUTION_NOT_AVAILABLE` | `rejects_ineligible_node_status` |
| 14 | 已有结算行且依据不同 | `EFFECT_RESOLUTION_CONFLICT` | `conflicts_with_existing_resolution` |
| 15 | 同 basis 同依据重复提交 | 回执 `replayed=true`，表行不增 | `replays_same_resolution` |
| 16 | 同 `operation_id` 不同 payload | `OPERATION_ID_CONFLICT` | `operation_id_conflict` |
| 17 | 节点 revision 过期 | `STALE_GENERATION` | `rejects_stale_node_revision` |
| 18 | 决定 revision 过期 | `DECISION_REVISION_CONFLICT` | `rejects_stale_decision_revision` |
| 19 | `verified_none` 的停证据与节点字段不一致 | 事务回滚，无结算行 | `verified_none_requires_identical_stop_evidence` |
| 20 | 结算中途失败不留半成品 | 节点字段回滚、无结算行、无事件 | `rolls_back_partial_resolution` |
| 21 | 结算后该节点不在待核实清单 | 清单不含该节点 | `settlement_removes_from_unverified_list` |
| 22 | 结算后 run 终态不再把该节点算未验证 | run 可进 `succeeded` | `run_close_treats_settled_node_as_verified` |
| 23 | 结算写入口无权限 | `FORBIDDEN` | `forbids_unauthorized_resolution` |
| 24 | 结算后账本链完整 | `/v1/ledger/verify` 通过 | `ledger_chain_intact_after_resolution` |
| 25 | 事件只追加一条 | `effect.resolved` 恰好一条 | `appends_single_effect_resolved_event` |
| 26 | 人工「没发生」裁决 | 结算行 basis=`verified_none`，事件带 `decision_id` | `human_not_applied_settles_verified_none` |
| 27 | 弱证据不得结算 | `VERIFICATION_TOO_WEAK` | `weak_evidence_cannot_settle` |

## 11. 实现约束（S5-C 须知）

- `PATCH_COLUMNS` 白名单（`src/service/commands/nodes.ts:16-62`）当前含 `side_effect_policy`、`side_effect_verified_none`，**不含 `stop_evidence`**。结算事务必须显式扩展白名单或走专用 UPDATE，并补「`stop_evidence` 不得被普通 report 路径改写」的守卫。
- `stop_evidence` 取值格式必须固定前缀（N1: `no_tool_started:` / `stopped_confirmed:`；N2: `tex_...` 的 `execution_id`），禁止自由文本。
- 结算事件类型固定 `effect.resolved`（节点链 + run 级各一条）。
- 结算命令的 `kind` 固定 `effect.resolve`（inbox 幂等键）。
- `unverified_resolutions` 是只追加表：结算只 INSERT，不 UPDATE、不 DELETE。

## 12. 未决项与假设（不阻塞 S5-C）

- **A1**：结算的服务 HTTP 形态由 S5-C 决定（是否新增 `POST /v1/effects/resolve`）。面板控制面 §8.4 的六个命令不变；结算不新增面板写命令。
- **A2**：历史 run 终态不回填（§7）。
- **A3**：`stop_evidence` 前缀格式在 S5-C 落地后即为事实标准，后续不得再改。
- **A4**：本附录只追加不改动规格正文；若 §17.1 错误码总表需要同步，只加 `EFFECT_RESOLUTION_CONFLICT` 一条，且以附录形式记录，避免打断既有行号引用。

## 13. 与既有文档的关系

- 本文件关闭 S5 计划 Task 3「仍待补齐」段中的两项：结算判定口径（各 decision kind 的允许 resolution、证据引用、幂等规则）与结算落表位置（同一裁决事务内）。
- 本文件**不**授权任何核实写入口的实现；写入口属于工作包 S5-C。
- 本文件**不**触碰 G5 门；G5 由工作包 S5-K 在独立审计通过后签。
