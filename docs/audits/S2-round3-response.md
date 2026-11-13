# S2 第三轮审计整改对照表（round-3 response）

- 对应审计：`docs/audits/S2-independent-audit-round3.md`（audit_round=3，285 行）
- 整改范围：致命 3 条（R3-01…R3-03）+ 重大 9 条（R3-04…R3-12）
- 口径：每条写「审计主张 / 改法（文件:行） / 证据 / 用例 / 状态」。状态只有三种：已闭合、部分闭合（写明留到哪批）、留待后续批次（写明理由）。
- 门的变化：G2 必过项 11 项 → 15 项；新增证据 `ev-g2-08`、`ev-g2-09`、`ev-g2-10`、`ev-g2-11`；新增迁移 `003_s2_round3.sql`（002 一行不动）。
- 迁移口径：本表记录的是「改了什么、凭什么算闭合」，不改规格正文；规格要动的部分统一列在第六节「留给 S3」。

## 一、致命项

### R3-01 工具失败仍可落 done

- 审计主张：工具 exitCode≠0 时，`runNode` 只在证据不足分支标阻塞，节点仍能被推成 done。
- 改法：`src/executor/run-node.ts`
  - 工具跑完落痕迹（`tool_executions` 表 + `tool_finished` 事件，~L109-135），给收口时核对证据用。
  - 系统级判失败（~L142-152）：任一工具 exitCode≠0 就 `markBlocked('tool_execution_failed')` 并抛 `VERDICT_POLICY_UNMET`，后续工具不再执行（break）。
- 证据：`docs/gates/evidence/G2/ev-g2-08.md` — 派发 HTTP 返回 `status=failed`，节点落 `blocked_post`，`verify_human` 理由 `tool_execution_failed`，痕迹 `exit_code=1`，上报登记为空。
- 用例：`tests/executor/run-node.spec.ts`（工具失败不许落完成）。
- 状态：**已闭合**。

### R3-02 verify 截止用纯墙钟

- 审计主张：`sweep` 用 `Date.parse(verify_deadline_at)` 与墙钟比，墙钟一改就误判超时。
- 改法：
  - `src/core/clock.ts`（~L99-176）新增 `ClockProvider`、`SystemClock`（生产：墙钟与单调钟同时取样，漂移超 2 秒判不确定）、`ScriptedClock`（测试与注入脚本可编排墙钟跳变、跨 boot、单调推进）。
  - `src/infra/sqlite/migrations/003_s2_round3.sql`：`node_runs` 增 `verify_deadline_boot_id`、`verify_deadline_monotonic_ns`。
  - `src/service/commands/node-state.ts`（~L57-88）：进 verifying 时写判定锚点（boot_id + 单调纳秒），墙钟只留展示列；没有锚点就只留墙钟，判定列留空。
  - `src/service/sweep.ts`：判定只读 boot_id + 单调纳秒；墙钟跳变、跨 boot、没有锚点一律记 `uncertain` 转 `blocked_post`（理由 `timer_uncertain`），不自动判超时。
  - `src/index.ts`（~L46-48）：生产装配注入 `SystemClock`。
- 证据：`docs/gates/evidence/G2/ev-g2-09.md` — 墙钟跳十分钟不误判（转 uncertain）、预算走完才超时、跨 boot 转 uncertain、没有锚点转 uncertain。
- 用例：`tests/sweep.spec.ts`（墙钟跳变 / 跨 boot / 没锚点 / 正常超时四个用例）。
- 状态：**已闭合**。

### R3-03 生产 report 入口弱证据直达 done

- 审计主张：`applyReport` 只按模板 `requiredHashes` 判证据，弱证据（模型侧 tool_result）、空证据、工具失败都能直落 done。
- 改法：
  - `src/service/commands/apply-report.ts`
    - `systemEvidenceGate`（~L273-283）：无证据 → `evidence_missing`；`source !== 'run_tool'` → `verification_too_weak`；exitCode 非数字 → `evidence_missing`；exitCode≠0 → `tool_execution_failed`。
    - `traceBindingGate`（~L285-296）：`tool_executions` 里没有 exit_code/stdout_hash 对得上的行 → `evidence_unverifiable`（伪造的 done 与真跑出来的 done 分得开）。
  - `src/core/workflow-def.ts`（~L16-17、~L24-25）：工作流定义新增模板级与节点级 `required_hashes`。
  - `src/service/workflows.ts`（`policyFor`，~L43-53）：必留哈希按并集合并。
- 证据：`docs/gates/evidence/G2/ev-g2-10.md` — 伪造强证据 → `evidence_unverifiable`；弱来源证据 → `verification_too_weak`；空证据 → `evidence_missing`；同批正常派发对照 → `done`。
- 用例：`tests/apply-report.spec.ts`（`describe('系统级证据门与痕迹绑定（审计 R3-03）')`）。
- 状态：**已闭合**。

## 二、重大项

### R3-04 重放事件无上限

- 审计主张：同一 report_id 反复重投会不断追加 `report_replayed` / `report_rejected` 事件，账本被刷膨胀。
- 改法：`src/service/commands/apply-report.ts` 新增 `hasNodeRunEvent`（~L47-55），三个落点（applied→replayed、replayed→replayed、rejected→replayed）都改成「同一 report_id 的同类事件已存在就不追加」。
- 证据：`docs/gates/evidence/G2/ev-g2-11.md` — 同一 report_id 连投四次：`report_rejected` 1 条、`report_replayed` 1 条、`report_applied` 0 条，registry 恒 1 行、report_seq 恒为 1。
- 用例：`tests/apply-report.spec.ts`（`describe('同一 report_id 的同类事件只留一条（审计 R3-04）')`，两条：成功落账后连投 3 次、被拒报告连投 4 次）。
- 状态：**已闭合**。

### R3-05 门记录的 producer 可写机器

- 审计主张：producer 字段没有约束，谁都能写机器产出充人审。
- 改法：`scripts/gate-check.ts` 的 `checkGovernance` 强制 producer=`'human'`、approver=`'human:<名字>'`，例外项必须带 code/type/status/note，rollback 必须有 target/action/耗时/验证。
- 证据：G1.md、G2.md 的 artifact 块里 producer=`human`、approver=`human:啸春`；`tests/gate-check.spec.ts` 有对应反例用例。
- 状态：**已闭合**。

### R3-06 正文表与 artifact 可各说各话

- 审计主张：正文里的证据表、例外表、必过项表、说明列与 artifact 各写各的，校验只看 artifact。
- 改法：`scripts/gate-check.ts` 新增 `checkBodyEvidenceTable`（逐行对 id、文件、sha256）、`checkBodyExceptions`、`checkBodyTable`（逐行对编号、固定文案、result=pass、证据列）、`checkBodyInvariants`（逐行对编号、说明、证据）。
- 用例：`tests/gate-check.spec.ts`（正文证据表哈希被改、正文不变量说明被改、正文必过项内容列被改，均指名拒绝）。
- 状态：**已闭合**。

### R3-07 门记录可在脏树上签

- 审计主张：门记录签核前不校验工作树，脏文件不进候选却可能被当成本次候选。
- 改法：`scripts/gate-check.ts` 的 `assertClean` 只豁免 `docs/audits` 与 `handoff.md`（`docs/gates` 不豁免）；`scripts/sign-gate.ts` 签名前先 `assertClean`；门记录必须在 HEAD 且与磁盘字节一致（`verifyGateRecord` 的 path 分支）。
- 状态：**已闭合**。

### R3-08 换绑证据重签可过

- 审计主张：证据绑定、哈希链、审计锚点都可以换掉重签。
- 改法（`scripts/gate-check.ts`）：
  - `checkEvidenceMap`：必过项 → 证据 id 是固定映射，换绑即拒（「换绑证据不许重签」）。
  - `checkPreviousChain`：本门 `previous_artifact_hash` 必须等于前序门记录在 HEAD 里的 `artifact_hash`。
  - `checkAuditAnchor`：audit_round 与审计报告文件名的轮次一致，且报告必须在 HEAD。
  - `artifact_hash` 锚点 + `body_hash` 正文自锚（`bodyHashInput`：除两个自锚点与反引号里的 sha256，正文任何改动都改掉 body_hash）。
- 用例：`tests/gate-check.spec.ts`（候选哈希改值、正文自锚 body_hash 被改，均指名拒绝）。
- 状态：**已闭合**。

### R3-09 批内新增又删除的文件不进候选

- 审计主张：基准与 HEAD 都查不到内容的文件会被候选清单漏掉。
- 改法：`scripts/gate-check.ts` 的 `candidateEntries` 对这类文件用固定原像 `ADDED_THEN_DELETED\n` 占位，保证它留在候选清单里。
- 状态：**已闭合**。

### R3-10 计划口径与实现口径不一致

- 审计主张：计划写 HTTP 400，实现是 422。
- 改法：`docs/superpowers/plans/2026-11-12-dsh-orchestra-s2-agent-loop.md` 两处改成与实现一致的 422。
- 状态：**已闭合**。

### R3-11 门证据与断言覆盖不全

- 审计主张：门的必过项覆盖不到第三轮新增的三条致命行为。
- 改法：G2 必过项从 11 项扩到 15 项：
  - `G2-08` 工具失败不许落完成（系统判失败并挂凭据） → `ev-g2-08`
  - `G2-09` 判定时限只认 boot_id 与单调纳秒（墙钟跳变不误判） → `ev-g2-09`
  - `G2-10` 报告入口系统级证据门（弱证据与伪造痕迹一律拒） → `ev-g2-10`
  - `G2-11` 反复重投同一 report_id 不许把账本刷膨胀 → `ev-g2-11`
  - `G-07`（墙钟跳变不误判截止）的证据补挂 `ev-g2-09`。
  - `scripts/gate-check.ts` 的 `GATE_SPECS.G2.items`、`content`、`evidenceMap` 与 `docs/gates/G2.md` 正文表、证据表、不变量表、artifact 同步。
- 状态：**已闭合**。

### R3-12 例外码不可复现

- 审计主张：例外表里的 `BRIDGE_ACK_LAG` 在 S2 生产路径上复现不出来。
- 现状与处置：桥未接生产路径（见第三节第 1 条），本轮仍不可复现。门记录例外表按「提案码」登记，note 写明「S2 生产路径未接桥调用，本轮不可复现，留 S3（F-06）」，`details.proposed=true`；`DECISION_REQUIRED` 同口径登记。
- 状态：**部分闭合**（登记口径已闭合，码本身留 S3）。

## 三、审计第 7 节「未闭合项清单」的真实状态

1. **F-06 桥 spill 未接生产路径** —— **仍未闭合**：`src/executor/bridge.ts` 未被 runNode / dispatcher / 生产装配引用，所以 `BRIDGE_ACK_LAG` 仍不可复现。归属：S3。
2. **§七.5 applyReport 的 policy 参数** —— **部分闭合**：信任面已闭合（请求体带不了 policy；`src/service/commands/runtime.ts` 由 `catalog.policyFor(run.workflow_version, node_id)` 取），签名仍收 policy 参数，内部 API 残留。本轮补的断言：判定条件逐条 `validateCondition`，引用非 evidence 字段直接拒（`src/core/policy.ts` 的 `evaluatePassConditions`）。签名收口（「policy 由函数内部按 run 取」）随 S3 生产装配一起做。归属：S3。
3. **四条新路由的规格落点** —— **未做**：规格正文本轮不动，避免 S3 语义分叉；计划口径已声明这组路由是 S2 服务装配入口，不实现也不声称实现规格 §6.1 的 workflow 命令语义。归属：S3（规格补「S2 服务侧 HTTP 入口」一节）。
4. **DECISION_REQUIRED / BRIDGE_ACK_LAG 进规格 §17.1** —— **未做**：门记录按提案码登记并写明不可复现，符合规格「exceptions 只作风险说明」的约束。归属：S3。
5. **本轮新增未闭合（R3-01…R3-12）** —— 全部处理，状态见第一、二节。
6. **迁移死列 verify_remaining_ns** —— **审计结论需要更正**：该列有写入（`src/service/commands/node-state.ts`：进 verifying 时写、离开时清空），并非死列。真正未实现的是规格行 330/338/342 的 remaining 重挂语义。归属：S3。

## 四、门与证据的变化

- 新增证据文件：`docs/gates/evidence/G2/ev-g2-08.md`、`ev-g2-09.md`、`ev-g2-10.md`、`ev-g2-11.md`。
- 新增迁移：`src/infra/sqlite/migrations/003_s2_round3.sql`（新增 `verify_deadline_boot_id`、`verify_deadline_monotonic_ns` 两列与 `tool_executions` 表；002 一行不动）。
- G1 也要重签：门检查新增治理字段（`previous_artifact_hash` / `audit_round` / `audit_report`）与正文自锚 `body_hash`，且 G1 的证据（账本快照）随 003 迁移与新代码重生成；不对着新 HEAD 重签，门检查会直接拒。
- 门检查自身发现并修掉的一个缺陷：`scripts/gate-check.ts` 的 `tableRows` 把「不变量」表的表头当成数据行，正文行数比 artifact 多 1，会把两道门都误判成不一致；现已把表头行排除。

## 五、复现命令

```bash
# 全量类型检查与测试
pnpm check

# 逐份重生成门证据（写回 docs/gates/evidence/<G1|G2>/）
node scripts/fault-inject.ts --case ev-g2-08
node scripts/fault-inject.ts --case ev-g2-09
node scripts/fault-inject.ts --case ev-g2-10
node scripts/fault-inject.ts --case ev-g2-11

# 重签与复核（顺序：先 G1 后 G2，G2 的 previous_artifact_hash 取 G1 在 HEAD 的 artifact_hash）
node scripts/sign-gate.ts docs/gates/G1.md
node scripts/sign-gate.ts docs/gates/G2.md
node scripts/gate-check.ts docs/gates/G1.md
node scripts/gate-check.ts docs/gates/G2.md
```

## 六、留给 S3 的清单

1. 桥 spill 接生产路径，`BRIDGE_ACK_LAG` 变成可复现码并进规格 §17.1。
2. `applyReport` 签名收口：policy 由函数内部按 run 取。
3. 规格补「S2 服务侧 HTTP 入口」一节，锁住这四条路由的语义。
4. `DECISION_REQUIRED` 进规格 §17.1（提案码转正）。
5. remaining 重挂语义（规格行 330/338/342）。
