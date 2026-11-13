# S2 独立审计第 28 轮报告（G2）

门：G2

候选提交：d1dfe12faa17cdab7cd36f427d0e1331e2a12bf3

结论：fail

## 一、范围与方法

- 仓库：D:/aboutAI/dsh-orchestra；被审提交 d1dfe12faa17cdab7cd36f427d0e1331e2a12bf3（HEAD）。主仓保持只读，仅新增本报告一份文件；源码、门记录、证据、测试均未改动。
- 临时 clone：D:/aboutAI/_g2audit-r28（干净基线）、sign-attack（伪造审计锚）、body-inject（门正文注入）、tamper（篡改矩阵）、runtime（运行时探针）。各 clone 的 node_modules 用目录联接挂主仓 node_modules。
- 环境：Windows，D:/NodeJs/node.exe，git 可用，无网络。
- 判据：任何可让 scripts/sign-gate.ts exit 0 并改写 G2、或 scripts/gate-check.ts 放行的绕过，即判 fail；没有才 pass。
- 本报告只按真实退出码、真实输出和可复算哈希下判断，不采信 r26 响应里的自述结论。

## 二、基线

| 检查 | 命令 | 退出码 | 计数/结果 |
|---|---|---|---|
| G2 门检查（签名前） | `D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md` | 1 | 签名前预期状态，审计报告 sha256 锚点未更新 |
| 类型检查 | `D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit` | 0 | 无诊断 |
| 全量测试 | `D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run` | 1 | 32 文件 / 363 例；11 失败 / 352 通过 |
| 定向测试 | `D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/apply-report.spec.ts tests/policy.spec.ts tests/workflows.spec.ts` | 0 | 3 文件 / 63 例全通过 |

全量测试日志：D:/aboutAI/_g2audit-r28/vitest-baseline.log。11 例失败均为签名前 G1 锚点/哈希不一致（r26 已记录的预签状态），不是 G2 新回归。

签名前门检查的原始 stderr：

```text
门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != c9cef2e419c91711…
```

## 三、S2 r26 五项与 S1 r22 修复复核

| 项 | 复核结果 | 判定 |
|---|---|---|
| 1. 结论解析 | r26 列出的六类裸否决词仍被拦截；六个同义变体未被拦截（载荷见本节围栏），A1 可绕过 | 未闭合（P0-1） |
| 2. 门正文结论 | bodyConclusionOf 与 auditConclusionOf 共用同一词表缺口，A2 可绕过 | 未闭合（P0-2） |
| 3. requiredHashes 键语义 | 缺 key、null 产物、两个不同 key 共用同一摘要、把 commandHash 当产物哈希、伪造 64 位哈希均被拒；重复 key 名在 catalog 层被静默去重 | 基本闭合（P2-2） |
| 4. failed/timeout 证据绑定 | failed 仅成功行、failed/timeout 有失败行但证据改用成功行均被拒；timeout 仅有成功行可通过 | 留口（P2-1） |
| 5. ev-g2-14/15 重跑稳定性 | 各 5 次，全部 exit 0，sha256 全部一致并与 G2 记录相同 | 成立 |

S1 r22 修复在 G2 上逐项复测：证据表 sha 篡改、证据文件追加、不变量语句改写、必过项证据换绑、候选源码改动、审计报告改结论、前序链改锚，七类均被 gate-check 以 exit 1 拒绝。原始错误见 A9–A15。

解析器复核的原始载荷与返回值（全部在围栏内）：

```text
已拦截（null 或 fail）：
未予认可 / 未予采纳 / 未予批准 / 不通过（P0 未闭合） / 未获认可 / fail-fast

仍放行（返回 pass）：
本次审计结论为未过。          -> audit=pass body=pass
本次审计结论为否。            -> audit=pass body=pass
本次审计结论为 faıl。         -> audit=pass body=pass
本次审计结论为未通过收口。    -> audit=pass body=pass
本次审计结论为不获认同。      -> audit=pass body=pass
本次审计结论为 unapproved。   -> audit=pass body=pass
```

## 四、独立攻击矩阵

| 编号 | 攻击 | 执行位置 | 真实退出码 | 结果 |
|---|---|---|---|---|
| A1 | 伪造审计报告：结论行写 pass，正文写同义否定 | sign-attack | sign-gate 0 / gate-check 0 | 绕过成立（P0-1） |
| A2 | 门正文注入同义否定后重签 | body-inject | sign-gate 0 / gate-check 0 | 绕过成立（P0-2） |
| A3 | 伪造 commandHash / stdout | 定向 vitest | 0（63 例全过） | 被 policy 拒绝 |
| A4 | 两个不同 required key 共用同一产物摘要 | 定向 vitest | 0（63 例全过） | 被 policy 拒绝 |
| A5 | 缺 required key | 定向 vitest | 0（63 例全过） | 被 policy 拒绝 |
| A6 | null 产物 | 定向 vitest | 0（63 例全过） | 被 policy 拒绝 |
| A7 | failed 仅用成功行收口 | 定向 vitest | 0（63 例全过） | 被 apply-report 拒绝 |
| A8 | timeout 仅用成功行收口 | runtime 自定义探针 | 0（3 例全过） | 通过，P2-1 |
| A9 | 正文证据表 sha 篡改（T1） | tamper | gate-check 1 | 被拒 |
| A10 | 证据文件追加（T2） | tamper | gate-check 1 | 被拒 |
| A11 | 不变量 I1 语句改写（T3） | tamper | gate-check 1 | 被拒 |
| A12 | 必过项证据换绑（T4） | tamper | gate-check 1 | 被拒 |
| A13 | 候选源码改动（T5） | tamper | gate-check 1 | 被拒 |
| A14 | 审计报告改结论（T6） | tamper | gate-check 1 | 被拒 |
| A15 | 前序链改锚（T7） | tamper | gate-check 1 | 被拒 |
| A16 | 跨重启 WorkflowCatalog | runtime，ev-g2-15 | 0（5/5） | 稳定；同版本改写被 409 拒绝 |
| A17 | 重复 requiredHashes 键名 | runtime 自定义探针 | 0（3 例全过） | 通过，P2-2 |

### A1 伪造审计报告绕过

clone：D:/aboutAI/_g2audit-r28/sign-attack，基点 d1dfe12。审计报告 docs/audits/S2-independent-audit-round28.md 的正式结论行写 pass，正文再写一句同义否定；G2 artifact 改为 audit_round 28、audit_report 指向该文件。提交 a5946e0 后执行 sign-gate，得到签名提交 2e9302f。

报告载荷（为保持本报告绑定行唯一，正式结论行在下方写作 `结论行：pass`；实际文件是结论前缀加全角冒号再加 pass，门与候选提交两行也与正式报告相同。实际文件的 LF 归一化 sha256 为 1da149515422eb249668d27412d6e5749cfd33ae53017d75ce973fdb0bc99fb7）：

```diff
+ # S2 独立审计第 28 轮（攻击复现）
+ [绑定行：本门与候选提交各一行，实际内容与被签记录一致]
+ 结论行：pass
+ 本次审计结论为未过。
```

签名与门检查的真实输出：

```text
$ D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G2.md
重签完成：证据 19 份，candidate=cffc3526b774…，artifact_hash=eabc824f593c…，body_hash=c848f8468d0b…，改动文件 88 个
[SIGN_EXIT=0]

$ D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md
gate G2 通过（19 项必过、19 份证据哈希复核，artifact_hash=eabc824f593c… body_hash=c848f8468d0b…）
[GATE_EXIT=0]
```

签名后 G2 关键字段：

```text
"audit_round": 28
"audit_report": "docs/audits/S2-independent-audit-round28.md"
"audit_report_sha256": "1da149515422eb249668d27412d6e5749cfd33ae53017d75ce973fdb0bc99fb7"
artifact_hash=eabc824f593c6f36e359a47cb75c985cc912f28824616e48ec857ed22e7a89d7
body_hash=c848f8468d0b9d0475dc6d7e21cc517397eeb10af412a48b9aa76cb18f367b4e
```

对这份实际报告调用两个解析函数，返回值：

```text
auditConclusionOf(report) = pass
bodyConclusionOf(report) = pass
```

### A2 门正文注入绕过

clone：D:/aboutAI/_g2audit-r28/body-inject，基点 2e9302f（A1 的签名提交）。在 G2 正文、artifact/body 锚点之前插入一行同义否定，提交 3007d5c；重签后得到 52af187。

注入与结果：

```text
注入行：本次审计结论为未过。
[SIGN_EXIT=0] artifact_hash=eabc824f593c… body_hash=85840f157d40…
[GATE_EXIT=0] body_hash=85840f157d40330117b57b2165c783791180c75e13cd1797a3a90f669d548e41
```

对注入后的 G2 正文调用 bodyConclusionOf，返回 pass。

### A3–A7 证据门与 failed 收口

定向命令与计数：

```text
$ D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/apply-report.spec.ts tests/policy.spec.ts tests/workflows.spec.ts
3 files / 63 tests passed / EXIT=0
```

覆盖并通过的拒绝路径：伪造 commandHash、把 commandHash 当产物哈希、伪造 64 位产物哈希、缺 output key、null 产物、两个不同 key 共用同一摘要、failed 仅成功行、failed 有失败行但证据用成功行、timeout 有失败行但证据用成功行，以及对应的正例控制。

### A8 timeout 仅成功行收口

runtime 自定义探针 D:/aboutAI/_g2audit-r28/runtime/tests/_r28-audit.spec.ts，3 例全过。真实返回：

```text
timeout + 仅成功行 -> accepted=true, next_status=timeout, node.status=timeout, registry=applied
```

该路径没有绑定失败工具行，属于失败溯源缺口；它不能把节点收口为 done，故列为 P2。

### A9–A15 篡改矩阵

clone：D:/aboutAI/_g2audit-r28/tamper，基点 2e9302f。基线 gate-check exit 0；每例提交后跑 gate-check，再 git reset --hard 2e9302f。七例全部 exit 1，原始错误：

```text
T1 门检查失败：正文证据表里 ev-g2-01 的 sha256 与 artifact 不一致（证据被改过或表没跟着改）
T2 门检查失败：审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：docs/gates/evidence/G2/ev-g2-01.md
T3 门检查失败：不变量 I1 的语句与固定口径不一致（改写或削短都要重新审计）
T4 门检查失败：必过项 G2-01 的证据与固定映射不一致（换绑证据不许重签）：ev-g2-02 != ev-g2-01
T5 门检查失败：审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：src/core/policy.ts
T6 门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：1da149515422eb24… != 674871bde8f9e2a2…
T7 门检查失败：previous_artifact_hash 与前序门记录的 artifact_hash 不符（重签链断了）
```

### A16 跨重启 WorkflowCatalog

ev-g2-15 连续 5 次运行，全部 exit 0；sha256 均为 7648abe92c2026e4c5739c5f5714f448a2ce8864fc07a129f607675af415643f，与 G2 记录一致。ev-g2-14 同样 5/5，sha256 均为 12e34ba8fd59c17322b364a122a5f265af87d353e10a13b6b4328049ceb6b39f。

ev-g2-15 证据内的关键观测：首次加载 HTTP=200；验收到 verifying HTTP=200；重启前/后绑定 workflow_definition_hash 206681cf51becb770748c437ebd0e9133ed831e691f76684c70567a5b4545256；改写同版本 HTTP=409 WORKFLOW_VERSION_IMMUTABLE；节点 status=verifying、attempt=1、revision=3；弱证据收口 HTTP=200、accepted=false、reason=verification_too_weak。

### A17 重复 requiredHashes 键名

runtime 探针把 catalog 的 required_hashes 设为 ["artifact","artifact"]，只提供一个产物，节点仍 accepted=true 并 done。原因在 src/service/workflows.ts:97 的 Array.from(new Set([...])) 去重。直接调用 evaluateEvidence 时重复键会被拒，但经过 catalog 的策略已被静默折叠。

## 五、P0/P1/P2

### P0-1 auditConclusionOf 可见否定绕过

- 位置：scripts/gate-check.ts 的 auditConclusionOf / scanFailStatement / FAIL_VERDICTS。
- 载荷：结论行写 pass，正文写同义否定；六个变体均可让 auditConclusionOf 返回 pass。
- 实测：sign-gate exit 0，gate-check exit 0，G2 被改写为 audit_round 28，artifact_hash=eabc824f593c…。
- 根因：FAIL_VERDICTS 未覆盖三个同义词族（含英文）；判定词尾部遇到未列入的后续词时提前收口；点无 i 的变体未归一。
- 修复：补齐否定词与英文词，处理词尾和 Unicode 归一；对每个变体加回归用例；修复后重新审计、重新签名。

### P0-2 bodyConclusionOf 可见否定绕过

- 位置：scripts/gate-check.ts 的 bodyConclusionOf。
- 载荷：在 G2 正文插入一行同义否定，重签后 body_hash=85840f157d40…。
- 实测：sign-gate exit 0，gate-check exit 0；bodyConclusionOf 返回 pass。
- 根因：与 P0-1 同一词表缺口，门正文扫描直接复用。
- 修复：与 P0-1 同步补齐词表，并让正文扫描对任何可见否定结论直接拒绝；补回归用例。

### P1

本轮未发现 P1。

### P2-1 timeout 仅成功行收口

- timeout 节点可以只绑定一条 exit 0 的成功工具行就收口，没有失败行也能 accepted=true。
- 影响：失败溯源不完整，审计侧无法从 timeout 证据确认失败工具；不影响 done 的门禁。
- 建议：timeout 也要求至少一条 failed 工具行，或在证据里显式记录 kill/超时来源。

### P2-2 重复 requiredHashes 键名被静默去重

- src/service/workflows.ts:97 用 Set 合并模板与节点要求，重复键名折叠为一个。
- 影响：策略作者写重复键名时不会得到报错，实际要求少于字面数量；不同键名共用摘要仍会被 policy 拒绝，故不构成放行绕过。
- 建议：在 catalog 构建阶段拒绝重复键名，或至少在诊断里显式告警。

### 非发现

- 签名前 artifact 的 candidate_hash=f11d0fb8… 与当前树重算值 cffc3526b774… 不同；sign-gate 在签名时按候选树重算，属预期刷新，且 checkAuditAnchor 仍会拦截 d1dfe12 之后的候选文件改动（T2/T5 已验证）。
- 证据表、证据文件、不变量表、必过项映射、前序链、审计报告哈希六类锚点本轮均未被绕过。

## 六、关键复现命令与计数

```text
# 基线
cd D:/aboutAI/_g2audit-r28
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md        # exit 1（签名前）
D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit                   # exit 0
D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run                         # 32 files / 363 tests；11 failed / 352 passed；exit 1

# A1
cd D:/aboutAI/_g2audit-r28/sign-attack
D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G2.md        # exit 0
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md       # exit 0

# A2
cd D:/aboutAI/_g2audit-r28/body-inject
D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G2.md        # exit 0
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md       # exit 0

# 定向证据门
cd D:/aboutAI/_g2audit-r28
D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/apply-report.spec.ts tests/policy.spec.ts tests/workflows.spec.ts  # 63 passed / exit 0

# 运行时探针
cd D:/aboutAI/_g2audit-r28/runtime
D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/_r28-audit.spec.ts  # 3 passed / exit 0
```

计数：P0=2，P1=0，P2=2。

按任务判据，A1/A2 均可让 sign-gate exit 0 并改写 G2，且随后 gate-check exit 0；判据触发，本轮为 fail。修复 P0-1/P0-2、补回归用例并重新审计前，G2 不应被签。
