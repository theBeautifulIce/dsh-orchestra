# S2 独立审计第 29 轮报告（G2）

门：G2

候选提交：b92e8497d7a09685630465f6d24ccafa4ac812a8

结论：fail

- 审计对象：工作流编排引擎门禁体系（S2 / G2），不含 UI
- 审计方式：只读审计；攻击与重签实验全部在系统临时目录的克隆里进行
- 审计日期：2026-11-14
- 候选短号：b92e849
- 审计完成时主仓 HEAD：4c4ee82（只新增 handoff.md 14 行，位于 G2 候选排除清单内；源码树与 b92e849 相同）

G2 的结论锚仍可被可见文本中的否决句绕过。审计报告正文明确写“不推荐 / 不予采信 / 不建议 / 不予推荐 / does not recommend / 未予推荐”时，`sign-gate.ts` 仍以 pass 签 G2，`gate-check.ts` 仍 exit 0；把同一句注入 G2 门正文也放行。7 条载荷全部 sign exit 0 + gate-check exit 0，因此 G2 在本候选上不能视为通过。

本轮的 P0 只有一类：`scripts/gate-check.ts` 的结论解析词表缺少“推荐 / 建议 / 采信 / recommend”的否定族，`matchStructuralNegative` 无词可吃，`auditConclusionOf` 与 `bodyConclusionOf` 都把它当成没有否决。

## 攻击环境与基线

- 临时克隆：`C:/Users/ASUS/AppData/Local/Temp/g2audit-r29-20261114-035959/base`
- 候选：`b92e8497d7a09685630465f6d24ccafa4ac812a8`
- Node：v26.13.1；命令统一用 `D:/NodeJs/node.exe` 直跑
- 基线提交（克隆内）：`1e2f44dbafdd08ac100a137649b6f425015f2002`
- 基线流程：先提交审计报告与 G2 锚点，再跑 `sign-gate.ts`，提交签后的 G2，最后跑 `gate-check.ts`
- 基线结果：`sign exit 0`，`gate-check exit 0`（19 项必过、19 份证据哈希复核）

基线签后值：

```text
artifact_hash=7cce29a15d967ba84755e3805e9178f1deb103c416de9c761d3739db78aa2a28
body_hash=feacaff60263e532a00077995550aeeee277ab2752267aaf5cbc37592514b3e9
G2.md sha256=e4c80c84e2320912023dd723ccac76511f2bf51128d7f6b5977480ab29aadda6
```

每条载荷都从基线 `git reset --hard` 开始，保证唯一变量是注入的那句话。

## 攻击载荷与结果

### A1：注入审计报告（报告结论行仍为 pass）

| 编号 | 追加到审计报告正文的句子 | sign exit | gate-check exit | artifact_hash | body_hash |
| --- | --- | ---: | ---: | --- | --- |
| A1-不推荐 | 本次审计不推荐通过本报告。 | 0 | 0 | `439f7fffea225dbfc128f76d317b10c5ab59d43e2ab0fa03e46b1ace6b235e91` | `8403d31a21941d8a0b709b7210f87b27394402581c9e5f30660099e7a47ea26b` |
| A1-不予采信 | 本次审计不予采信本报告。 | 0 | 0 | `8c5b11209b74eeab47079236c3a1b27209884b17144509b8c6a95e5fca4bd323` | `9480c862a34b92c9c6ed9bebc842845706f1c8497a16fa72b453a29daf7d52bb` |
| A1-不建议 | 本次审计不建议通过本报告。 | 0 | 0 | `8b20d2c19614e5660b7371caa39b54ed20588edafa1a4190e75fad50818252fc` | `b006a470b58a4b85d939697f8c8caf3fcf634c8201c59aff75d8e46c595222e8` |
| A1-结论不予推荐 | 本次审计结论为：不予推荐。 | 0 | 0 | `85b6f61bbfc3789c74c4953ed937cf85ab1bdbe54d9dcf320658cb0c2a62c981` | `044b607b918c7cae590229b4795956fa4b45fe737fe5601e09c05ed553867fa6` |
| A1-英文 recommend | This audit does not recommend the report. | 0 | 0 | `a896c16a9bbcef84c3e67af9074ab4158dab7d1e13349b8797525b21ba8f5daa` | `8039bcd6e5990152631f380302d561a451ee082924ab8271ff3f17c1b541cd5b` |
| A1-未予推荐 | 本次审计未予推荐本报告。 | 0 | 0 | `086bd4887dc70d1da8e731aba49801bdc0eabfc52b54175e2fdeca786431b397` | `6445fa2bf576500623de7d6b410250967e71c5d372a66d6a29e114d7aca93bd9` |

六条载荷签后的 G2 文件 sha256 依次为：

```text
58a2a4736741362032de9f8c6aa74a622fc8e7e72c1d5c267c4f0a37f3df5766
3aed34f359fe47c15823cc26c024a9dfc874a6b8ebf6c38dd21402498f849081
82a918bce02d1868272f7e9ae311cbef02776f85c9f49cd5e55999a89b7edd95
5c598eca944ad71e0b8f7d38af2559e82689b5ae9320b918c33a09c4bee123f5
57e15904f6823d8cfa948b4856f245211765509b5d0d29097e5bfa99e8ecdb3b
cf2d4dadc4d9001b3b5ed6fd86bb827d0ee270c069835fba2bcd359f95439e90
```

对应载荷提交：`fbdcdbbaaf6aafdf63ef911dd8bda2590b54beeb`、`2bafa4048eb29c39da9cfe4536dd06bfe8e9a17a`、`ec6c5f29310e969ea5a9092618478bc7a87d4494`、`d2526dd09bc7a8942e6ed6ad31f7a53062e2a790`、`277e2fcc749052e4f39be1222bf11a0126d5e4fd`、`74c751f38fd5f008f92b6607297300a06b1b62d4`。

每条的 gate-check 输出均为：

```text
gate G2 通过（19 项必过、19 份证据哈希复核，artifact_hash=… body_hash=…）
exit 0
```

### A2：注入 G2 门正文

把“本次审计不推荐通过本报告。”插在 `docs/gates/G2.md` 的“## 必过项与证据”之前，artifact 内容不变，重新签：

```text
sign exit=0
gate-check exit=0
artifact_hash=7cce29a15d967ba84755e3805e9178f1deb103c416de9c761d3739db78aa2a28
body_hash=f91e387cce422d6bb018f76fa4e528f0477c4a4753698d806e7649c0d110c5b6
G2.md sha256=70c09eb9276fa15c70d829a5dc9f86a622b858d57e219e7b21321900dff943b9
payload commit=a65d69343404ee7aceceae709b56da2cf215936a
```

门正文里的可见否决句没有让 `bodyConclusionOf` 返回 fail，说明门正文锚与审计报告锚漏的是同一族词。

### 回归对照：round28 六条载荷

在 b92e849 上复跑上一轮报告的六条载荷（未过 / 否 / faıl / 未通过收口 / 不获认同 / unapproved），全部被拒：

```text
R28-未过、R28-否、R28-faıl、R28-未通过收口、R28-不获认同、R28-unapproved
sign exit=1
gateChanged=false（G2.md 字节未变，artifact 仍为 7cce29a1…）
```

完整错误（R28-未过）：

```text
Error: 审计报告里找不到唯一结论行，不能拿它当门记录依据: docs/audits/S2-independent-audit-round29.md
    at checkAuditAnchor (scripts/gate-check.ts:1611:22)
    at verifyGateRecord (scripts/gate-check.ts:1722:3)
    at scripts/sign-gate.ts:81:1
SIGN_EXIT=1
```

结论：b92e849 对 round28 六变体的修复有效；本轮 P0 是同一结论锚上未覆盖的另一族词，不是 round28 的回归。

## 根因（按 HEAD 字节）

`scripts/gate-check.ts`：

- `FAIL_SUBJECTS`（637-654）含“本次审计 / 本报告 / report / the report”等主语。
- `FAIL_VERDICTS`（656-699）含“未过 / 否 / unapproved / 未通过收口 / 未受理 / 待整改 / 暂缓 / 否决 / 拒收”等，但没有“推荐 / 建议 / 采信 / recommend”的否定形式。
- `FAIL_PASS_STEMS`（784-793）含“通过 / 批准 / 达标 / 合格 / 成功 / 许可 / 认可 / 同意 / 采纳 / 认同 / 赞同 / 首肯 / 受理 / 接收 / 接受 / approval / approved / approve / pass / accepted / acceptable”等，同样没有“推荐 / 建议 / 采信 / recommend”。
- `matchStructuralNegative`（827-847）只把 `FAIL_STEM_RES` 当谓词吃。遇到“不推荐”“不予采信”“不建议”“does not recommend”，否定词后面的词不在谓词表里，整个结构不命中。
- `scanFailStatement`（856-893）在否定结构不命中后，也找不到连接词可继续，直接放弃该主语位点。
- `auditConclusionOf`（931-975）因此得到 `inlineFail=false`；看到“结论：pass”就返回 pass。
- `checkAuditAnchor`（1609-1614）只要求 `auditConclusionOf` 非 null 且等于 `artifact.conclusion`，于是 pass 被接受。
- `bodyConclusionOf`（979-1002）的 pass 行尾否决词只覆盖“fail / failed / failure / 不通过 / 未通过 / 未过 / 否决 / 驳回 / 拒绝 / 拒收 / 不予 / 未获 / 未予”，漏“不推荐 / 不予推荐 / 不予采信 / 不建议 / does not recommend”，所以 A2 也放行。

这不是“报告里出现了 fail 字样”的误报问题；六条载荷都只有一个明确的“不推荐/不采信”结论，报告自己的正式结论行仍是 pass，门检查把两者都读成了 pass。

## 逐项核对

### 1. node-run 生命周期

- 生产路径：`POST /v1/workflows/load` → `POST /v1/runs` → `POST /v1/runs/dispatch` → `runNode` → `applyReport`。
- `src/executor/run-node.ts:56-98`：先按账本 `run.workflow_version` 与 `node_id` 取定义工具策略，再 `acquireNodeRun`；节点身份以账本为准，`row.node_id !== p.nodeId` 抛 `STALE_GENERATION`。
- `run-node.ts:229-239`：任一工具 `exitCode !== 0` → `markBlocked(tool_execution_failed)` 并抛 `VERDICT_POLICY_UNMET`，不许 done。
- `run-node.ts:241-273`：`started → verifying` 带 `verifyAnchor`（boot_id + 单调纳秒），`submitReport` 被拒则 `blocked_post`。
- 相关用例通过：`tests/integration/g2.spec.ts` 14 条、`tests/runtime.spec.ts` 7 条、`tests/production-path.spec.ts` 4 条。

该项未发现可利用绕过。

### 2. 工具授权

- `src/service/workflows.ts:84-89` 的 `toolPolicyFor` 只从 `def.nodes[].tools` 取 allow/deny。
- `src/executor/tools.ts:43-62` 的 `assertToolsAuthorized`：deny 优先、必须注册、必须 allow；`deriveEffectiveCapability` 只接受 pure。
- 请求体不参与策略；G2-12 证据显示三套定义下“请求体故意带 allow”仍分别以 `FORBIDDEN / TOOL_NOT_REGISTERED` 拒绝，`lease_acquired` 条数 0。
- 相关用例通过：`tests/run-tool.spec.ts` 7 条、`tests/tools.spec.ts` 9 条、`tests/workflows.spec.ts:57-63`。

该项未发现可利用绕过。

### 3. 证据门

- `src/service/commands/apply-report.ts:241-266`：done 顺序为 `policyForReport → systemEvidenceGate → traceBindingGate → evaluateEvidence → evaluatePassConditions`。
- `systemEvidenceGate`：无证据 `evidence_missing`；`source !== run_tool` 或 `exitCode !== 0` 一律拒。
- `traceBindingGate`：按 `node_run_id + attempt` 回查 `tool_executions`，逐项对齐 tool / exitCode / stdout / stderr / commandHash，并要求同 attempt 的 `tool_finished` 事件。
- failed / timeout 统一走 `requireFailure: true`（`apply-report.ts:228-238`），超时不能拿成功行收口。
- 弱证据直达 done 被两层挡住：`systemEvidenceGate` 先拒 `tool_result`，`traceBindingGate` 再拒无痕迹证据。
- 相关用例通过：`tests/apply-report.spec.ts` 中弱证据、伪造哈希、失败行、timeout、共用摘要等 46 条。

该项未发现可利用绕过。

### 4. verify 单调钟

- `src/core/clock.ts:52-62`：boot 不同 → `uncertain:boot_changed`；墙钟漂移超过 2000ms → `uncertain:clock_drift`；同 boot 只比单调纳秒；`remaining <= 0` → expired。
- `remainingAcrossBoot` 扣停机时间并夹到 0；`SystemClock` 同时取 `Date.now` 与 `process.hrtime.bigint`。
- G-07 证据：向前/向后跳十分钟均判 `uncertain:clock_drift`，跨 boot 判 `uncertain:boot_changed`，不判 expired。
- 相关用例通过：`tests/clock.spec.ts` 9 条（含跨 boot、停机扣减、连跑两次扫描）。

该项未发现可利用绕过。

### 5. lease

- `src/service/commands/lease.ts:48-83`：`queued → leased → dispatched` 同事务，Ga 每次 +1，CAS 带 attempt + revision。
- `renewLease` 只动租约、不动 Ga；`assertLeaseValid` 过期抛 proposed `LEASE_EXPIRED`；`sweepExpiredLeases` 把过期 dispatched → stopping、started → startup_unknown。
- `run-node.ts` 每 10s 续租，续租失败记 `lease_lost`，收口前拒绝 done。
- 长动作心跳：`tests/runtime.spec.ts`“长动作：心跳把租约续上，2.5 秒时的扫描不判过期”通过；`tests/lease.spec.ts` 7 条、`tests/sweep.spec.ts` 9 条通过。
- `lease.ts:116` 在无 `lease_expires_at` 时直接 return，释放后的迟到上报由状态机、attempt CAS 与 report_registry 拦截；现有用例未发现可绕过路径。

该项未发现可利用绕过。

### 6. 报告收口

- `apply-report.ts` 六步：幂等/重放 → attempt CAS → status CAS → generation → `assertLeaseValid` → `canTransition`。
- blocked 必须有 `request.reason` 或 `error_code`，否则 `decision_required` 拒收；终态写 `report_registry` 与 `report_applied`（含 `evidence_digest`）。
- 重复上报只落一次；同 report_id 重发只更新 registry；围栏 armed 时拒收；跨节点重放按结构错拒。`tests/apply-report.spec.ts` 46 条覆盖。

该项未发现可利用绕过。

### 7. 必过项与证据哈希

- G2 的 19 项必过项与 `GATE_SPECS.G2.items` 顺序完全一致（`gate-check.ts` 的 `checkEvidenceMap` / `checkBodyTable` 在签后基线通过）。
- 19 份证据的固定映射与正文表一致；没有换绑、无未引用证据。
- 独立复算（自写 `independent-recompute.mjs`，不复用 gate-check 代码；对 HEAD 字节做 CRLF→LF 归一）：

```text
evidence_entries 19, mismatch 0
artifact_hash 7cce29a15d967ba84755e3805e9178f1deb103c416de9c761d3739db78aa2a28 = recorded
body_hash feacaff60263e532a00077995550aeeee277ab2752267aaf5cbc37592514b3e9 = recorded
evidence_index_hash 1a221b945449b1e68b7811ba110ac022f25c9004438204dcdeae0f02a3068898 = recorded
invariants_hash 925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304 = recorded
```

### 8. 候选哈希

- 在签后基线上独立复算：`candidate_hash=4e5b2af7ead5ba7631fbcd581e825aefb58ea8744cef6396fb9a2f9726ff8503`，`change_scope_hash=b4811c33ac596c2580c7268812fa1e79fbe12ad2f9257bacdd8fb88fd5648778`，均与记录一致。
- 主仓当前 G2 的 `candidate_hash=f11d0fb8…` 是旧候选值，与该提交的 HEAD 不一致，属预签态，见 P2-1。

## 测试与类型检查

在 `b92e849` 上跑全量：

```text
tsc --noEmit                                        exit 0
tests/apply-report.spec.ts + policy + workflows     65 passed
runtime / lease / clock / state-machine /           119 passed
run-tool / tools / cancel / sweep / runtime /
production-path / routes / integration/g2 / ...
其余 14 个测试文件                                102 passed
tests/gate-check.spec.ts                            11 failed | 70 passed
全量 31 文件 367 用例                              356 passed | 11 failed
```

11 条失败全部是同一个预签态前置断言，不是解析逻辑失败：

```text
门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：
0000000000000000… != 50ba1b13cdf1b8…
```

测试先被这一条挡住，没有走到各自要验证的字段。`tests/gate-check.spec.ts:166/196/217` 是其中三例。

## P0 / P1 / P2

### P0（阻断）

- **P0-1 结论解析漏“推荐/建议/采信/recommend”否定族，审计报告与门正文的可见否决都能被签成 pass。**
  - 影响：G2 的结论锚失效。报告正文可以写“本次审计不推荐通过本报告”，artifact 与门正文仍以 `conclusion: pass` 签名并通过 `gate-check`，本轮 7 条载荷实测均 exit 0。
  - 位置：`scripts/gate-check.ts` 的 `FAIL_VERDICTS`（656-699）、`FAIL_PASS_STEMS`（784-793）、`matchStructuralNegative`（827-847）、`auditConclusionOf`（931-975）、`bodyConclusionOf`（979-1002）。
  - 复现：见“攻击载荷与结果”A1 六条与 A2 一条；每条都有 sign exit、gate-check exit、artifact_hash、body_hash、签后 G2 sha256。

### P1（重大）

无。evidence gate、timeout/失败行、弱证据直达 done、required_hashes 同层重复、lease、单调钟、工具授权均未发现可复现的放行绕过。

### P2（不阻断）

- **P2-1 G2 在候选 b92e849 上是预签态。** `gate-check.ts` 在主仓 exit 1：`audit_report_sha256=0000…` 与报告实际 `c9cef2e419c91711…` 不符；`body_hash` 锚点 `ef21bb456813…` 与实际 `558c01b7728d…` 不符；`artifact_hash` 锚点 `b5615b8b5725…` 与实际 `ea3dff4caa8d…` 不符。git 历史显示最后一次 BODY_OK 是 `df7d23a`，之后多个提交继续改 G2.md 未重签。11 条 `gate-check.spec` 失败由此而来。
- **P2-2 跨层同键 `required_hashes` 仍被静默合并。** `src/service/workflows.ts:97` 用 `Array.from(new Set([...template, ...node]))` 取并集；同层重复已由 `src/core/workflow-def.ts:42-50` 拒绝，跨层同键仍折叠。因同一个键只要求同一份产物，未见放行削弱，但“重复键必拒”的口径目前只覆盖同层。
- **P2-3 解析回归缺这一族词。** `tests/gate-check.spec.ts` 中没有“不推荐 / 采信 / 不建议 / recommend”的用例（grep 无命中），所以修复 round28 六变体后仍漏掉本轮七条载荷；建议把七条载荷固化成回归，并补“赞成 / 支持 / 背书”等同族词。
- **P2-4 审计窗口内主仓 HEAD 推进。** 审计开始于 `b92e849`，完成前主仓 HEAD 变为 `4c4ee82`（`handoff.md` +14 行，`git diff --name-status b92e849 4c4ee82` 仅 `M handoff.md`）。该文件在 G2 的 `excludes` 内，候选哈希不受影响，源码树也未变；本报告所有源码、测试与攻击结论仍以 `b92e849` 树为准。

## 修复建议

1. 在 `FAIL_PASS_STEMS` 或独立的否决词族中加入“推荐 / 建议 / 采信 / 赞成 / 支持 / 背书 / recommend”，让 `matchStructuralNegative` 能识别“不推荐 / 不予采信 / 不建议 / does not recommend”。
2. 在 `bodyConclusionOf` 的 pass 行尾否决词中加入同一族词，避免门正文注入绕过。
3. 把本轮 A1 六条与 A2 一条固化为 `tests/gate-check.spec.ts` 回归：断言 sign 阶段即 exit 1，且 G2 字节不变。
4. 对“本次审计 + 否定 + 任意谓词”做更保守的 fail-closed 处理：当主语是审计主体、出现否定且找不到明确肯定谓词时，结论解析返回 null（不确定即拒），而不是落到 pass。
5. 修完后重签 G2，并让 `gate-check.spec` 的预签态前置断言恢复。

## 复现入口

- 攻击结果：`C:/Users/ASUS/AppData/Local/Temp/g2audit-r29-20261114-035959/r29-attacks-results.jsonl`
- 独立复算：`C:/Users/ASUS/AppData/Local/Temp/g2audit-r29-20261114-035959/independent-recompute.mjs`
- 克隆基线：`C:/Users/ASUS/AppData/Local/Temp/g2audit-r29-20261114-035959/base`，基线提交 `1e2f44dbafdd08ac100a137649b6f425015f2002`
- 门检查命令：`D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md`
- 重签命令：`D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G2.md`

本报告不提交、不签 G2；主仓源码、门记录、测试与提交均未改动。
