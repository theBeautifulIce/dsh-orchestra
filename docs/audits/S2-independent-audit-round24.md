# dsh-orchestra G2 独立审计报告（round 24）

门：G2
候选提交：638605c42d3ca4545fb1ad7e29b381a2a4cf6df9

结论：fail

P0=1，P1=2，P2=0

## 范围与现场

- 审计对象：`D:/aboutAI/dsh-orchestra`，HEAD `638605c42d3ca4545fb1ad7e29b381a2a4cf6df9`，审计开始时工作树干净（`git status --porcelain` 为空）。
- 候选历史：`638605c` 为文档提交；整改提交为 `53495fc`（Bind terminal evidence, server clock, and visible fail windows）；上一轮候选为 `1e83391`。
- 门现场：`docs/gates/G2.md` 处于预签态，`audit_report_sha256` 为 64 个 `0`，`audit_round=4`，`audit_report` 指向 `docs/audits/S2-independent-audit-round4.md`，`conclusion` 为 `pass`，19 个必过项。
- 审计方式：阅读源码、测试与门记录；在 `D:/aboutAI/_g2audit24` 的临时 clone 中执行 sign-gate 端到端。本次审计只在主仓新增本报告；审计期间工作树另出现 `docs/audits/S1-independent-audit-round20.md`（非本审计写入，未触碰）。源码、门记录与测试无改动，未提交、未签门。
- 对照材料：`docs/audits/S2-independent-audit-round23.md`（上一轮 P0=4 / P1=1）与 `docs/audits/S2-round23-response.md`（整改说明）。

## 复核总表

| 编号 | 等级 | 复核结论 | 摘要 |
| --- | --- | --- | --- |
| P0-1（对应 R23 P0-1） | P0 | 未闭合 | 引号、括号、逗号、省略号、同义否定词、其他 Unicode 连接号、英文变体仍可让 sign-gate 把可见否定报告签成肯定 |
| P0-2（对应 R23 P0-2） | — | 已修复 | 同 attempt 存在任一 `exit_code != 0` 的 `tool_executions` 行时，done 必被拒，reason=`tool_execution_failed` |
| P0-3（对应 R23 P0-3） | — | 已修复 | 租约与上报使用服务端时钟，客户端 `body.now` 回拨不再延长租约 |
| P1-1（对应 R23 P0-4） | P1 | 部分修复 | 具名假值、commandHash 不符、缺 `tool_finished`、缺 `producedAt` 均被拒；但 `requiredHashes` 值仍只校验 64 位十六进制形态，未与产物比对 |
| P1-2（对应 R23 P1-1） | P1 | 部分修复 | failed/timeout 无证据被拒，带 `run_tool` 证据可收口；但证据只查存在性，未绑定同 attempt 的 `tool_executions` 与 `tool_finished` |

## P0 发现

### P0-1 可见否定句仍可签成肯定（第二十三轮 P0-1 未闭合）

第二十三轮点名的五个载荷已被修复，但修复方式是固定词表补丁，不是结构化识别；同一类可见否定句仍可绕过。

#### 端到端复核（临时 clone2，HEAD `638605c`）

fixture：把 `docs/gates/G2.md` 的 `audit_round` 改为 24、`audit_report` 改为 `docs/audits/S2-independent-audit-round24.md`，报告正文除被测行外带一行 `结论：pass`、一行 `门：G2` 与一行候选提交。每例提交报告后运行 `node --no-warnings scripts/sign-gate.ts docs/gates/G2.md`，记录 exit code、G2 文件哈希与签后 `audit_report_sha256`。

| 用例 | 可见文本 | 期望 exit | 实际 exit | G2 是否变化 | 签后 audit_report_sha256 |
| --- | --- | --- | --- | --- | --- |
| positive-control | 无否定句 | 0 | 0 | 是 | `97212896c0dfa4e040622aebd5d28c2a8a63a5fe55667435553569361d739c05` |
| plain-visible-fail | `本次审计未通过。` | 1 | 1 | 否 | — |
| three-line-split | `本次审计` / `最终结论` / `为不通过` | 1 | 1 | 否 | — |
| image-alt-plain | `![本次审计未通过](x.png)` | 1 | 1 | 否 | — |
| en-failed | `The audit failed.` | 1 | 1 | 否 | — |
| quote-cn-verdict | `本次审计“未通过”` | 1 | **0** | **是** | `0c50544429b515f1c2ad3f32f50c605a8500e7970ce04c72e5337416a83b8b73` |
| alt-dash-U2011 | `本次审计‑未通过` | 1 | **0** | **是** | `fe8955e89b83470cce91274483c976736294ac9adf859415eb1e67a04475f741` |
| cn-shibai | `本次审计失败。` | 1 | **0** | **是** | `0d6823de3a3268273b17cd4a1dde2abcecc17f7236fdecf5a04f18cb2e2d56dc` |

G2 初始哈希为 `06fd779dbb2f2943eb7cced50d4ae84b0d01be4198df45b06dec4b810162cd43`。三例绕过分别把 G2 改为 `9164ed0f2c548416f75609d86b96152165be6e515190987b82ba44f216361b10`、`e73128ddbf24fdbf89b37bfc1f921cf6f46886427a9213bf90dd5aab06a88133`、`3f020fdc667a5dcf55c649fb09e6c8453328c12cb49671077fd55498282bd372`，并写入对应的 `audit_report_sha256`。日志：`D:/aboutAI/_g2audit24/e2e25.log`。

这直接违反本轮第 7 项：引号变体期望 exit 1，实际 exit 0，且门字节被改。

#### 第二十三轮具名载荷复核

在 clone2 用同一 fixture 复跑第二十三轮的五个载荷，五例全部 exit 1，G2 哈希保持 `06fd779d…` 不变，错误都停在 `scripts/gate-check.ts:1345`（`审计报告里找不到唯一结论行`）。日志：`D:/aboutAI/_g2audit24/e2e26.log`。

- `审计未通过`
- `结论 - fail`
- `结论—fail`
- `The audit failed.`
- `The review did not pass.`

复核判断：点名的五句已修复；“裸审计”“连接号”“英文 failed/not passed”这一组性质没有完全修复，只有点名的字符和词形被覆盖。

#### 直接解析矩阵（`auditConclusionOf`）

把可见否定行放在一行正式 `结论：pass` 之后，直接调用 `scripts/gate-check.ts` 的 `auditConclusionOf`；返回 `pass` 即表示 sign-gate 会把该报告读成肯定。

返回 `pass`（绕过）的载荷：

```text
本次审计“未通过”
本次审计结论为“不通过”
本次审计"未通过"
![本次审计“未通过”](x.png)
本次审计（未通过）
本次审计，未通过。
本次审计...未通过
审计没通过
审计未获通过
审计未能通过
审计没有通过
审核未通过
复核未通过
总的审计意见：未通过
本次审计‑未通过      (U+2011)
本次审计﹣未通过      (U+FE63)
本次审计－未通过      (U+FF0D)
本次审计‐未通过      (U+2010)
本次审计⁃未通过      (U+2043)
本次审计失败。
本次审计未予通过。
本次审计未得到通过。
本次审计未过关。
本次审计没过。
本次审计通不过。
本次审计不能通过。
本次审计不是通过。
审计ｆａｉｌ
Audit: fail.
The audit fails.
The audit was unsuccessful.
The audit didn't pass.
The audit did fail.
Audit result: fail.
The audit is a failure.
The audit was not successful.
The audit did not succeed.
```

返回 `null`（被拒）的对照：

```text
本次审计未通过
审计：未通过
审计—未通过
本次审计 / 最终结论 / 为不通过（三行）
审 / 计 / 未通过（三行拆词）
![本次审计未通过](x.png)
本报告结论是未通过
The audit has not passed.
The audit did not pass.
The audit failed.
The review failed.
The audit has failed.
The audit failed to pass.
| 审计未通过 |
> 审计未通过
- 审计未通过
# 审计未通过
[审计未通过](x)
<span>审计未通过</span>
审​计未通过（零宽空格）
审­计未通过（软连字符）
```

阳性对照（返回 `pass`，未被误杀）：`审计未通过项为 0`、`本报告不通过项已全部修复`。

证据：`D:/aboutAI/_g2audit24/parser-matrix.log`、`D:/aboutAI/_g2audit24/parser-extra.log`。

#### 根因

- `scripts/gate-check.ts:639` 的 `compact` 只删除空白和 `-—–―−` 五个连接号码位；`U+2011 U+FE63 U+FF0D U+2010 U+2043` 原样保留，主语与 `未通过` 之间出现一个未被删除的字符，正则不再邻接。
- `scripts/gate-check.ts:642` 的主正则只允许主语和判定之间出现固定的 `的/经/经过/审计/复核/评审/后/最终/仍/依然/还是/结论/判定/审计意见/最终判定/最终结论/结果/为/是`，不允许引号、括号、逗号、省略号；`本次审计“未通过”`、`本次审计（未通过）`、`本次审计，未通过。` 因此漏检。
- `scripts/gate-check.ts:634` 的判定词只有 `fail|不通过|未通过|不合格`，没有 `失败/未予通过/未得到通过/未过关/没过/通不过/不能通过/不是通过`。
- `scripts/gate-check.ts:633` 的主语表没有 `审核`，也没有裸 `复核`；`审核未通过`、`复核未通过` 漏检。
- `scripts/gate-check.ts:650` 的英文正则只覆盖 `failed / not passed / did not pass`，没有 `fail / fails / unsuccessful / didn't / did fail / failure / not successful / did not succeed`。
- 全角 `ｆａｉｌ` 没有折叠，未命中英文正则，也未命中中文判定词。

#### 测试覆盖缺口

`tests/gate-check.spec.ts:677-688` 只覆盖第二十三轮点名的五句；`:690` 之后覆盖整句引号（`"本报告不通过"` 等），但没有覆盖“主语 + 引号包裹的判定词”这一形态。全量测试 329 例通过不能证明这一类性质；本轮判定按“测试通过但性质未覆盖”处理。

## P1 发现

### P1-1（第二十三轮 P0-4 残留）requiredHashes 只校验形态，不与产物比对

- `src/core/policy.ts:34-42`：`requiredHashes` 的每个值只要是字符串并匹配 `/^[0-9a-f]{64}$/i` 即通过；没有任何代码把该值与实际产物、证据文件或门记录中的哈希比对。
- 对抗矩阵结果：
  - `requiredHashes: ['artifact']`，`hashes: {artifact:'not-a-real-hash'}` → `accepted=false`，reason=`verification_too_weak`。
  - 只给键名 `{artifact: undefined}` → `accepted=false`，reason=`verification_too_weak`。
  - `{artifact:'a'.repeat(64)}` → `accepted=true`，`next_status=done`，节点 revision 从 11 到 12。
  - `{artifact:'A'.repeat(64)}` → `accepted=true`，`next_status=done`。
- 第二十三轮报告第 154 行明确期望“requiredHashes 的哈希值要与可核验产物比对”；整改说明第 29 行只增加了 64 位十六进制格式校验。具名假值被拒，但一个伪造的合法形态哈希仍可满足完成条件。
- 定为 P1：不影响本次门签名，但它让“完成”所依赖的证据可以凭空构造；当前 ledger 没有 artifacts 表，需要先确定产物来源，再做绑定。

### P1-2（第二十三轮 P1-1 残留）失败/超时证据只查存在性，未绑定 trace

- `src/service/commands/apply-report.ts:320-328` 的 `terminalEvidenceGate` 只检查：evidence 存在、`source === 'run_tool'`、`exitCode` 是 number；没有调用 `traceBindingGate`，没有核对同 attempt 的 `tool_executions`，没有核对 `tool_finished`，也不要求 `producedAt`。
- 对抗矩阵：同一 attempt 的 `tool_executions` 行是 `exit_code=0`、`tool_finished` 也是 `exit_code=0`，上报 evidence 为 `{source:'run_tool', exitCode:2}` 时，`accepted=true`，`next_status=failed`，节点 revision 从 11 到 12。矛盾的失败证据被收下。
- HTTP 复核：节点为 `verifying`、无租约、无 `tool_executions` 行时，failed 上报带 `{source:'run_tool', exitCode:1}` → `accepted=true`，`next_status=failed`；不带 evidence → `accepted=false`，reason=`evidence_missing`。日志：`D:/aboutAI/_g2audit24/p03-clock.log`。
- 整改说明第 38 行写“证据必须存在且可核对”；“可核对”没有落到实现或测试里。
- 定为 P1：失败终态不直接签门，但它会留下与执行轨迹矛盾的失败记录；如果下游按失败终态做补偿或重试，依据不可信。

## 已确认修复的项

### 第二十三轮 P0-2 同 attempt 失败行必拒

矩阵三例，全部符合预期：

| 场景 | 结果 |
| --- | --- |
| 同 attempt 一条 `exit_code=2` 失败行 + 一条 `exit_code=0` 成功行/事件 + 成功 evidence | `accepted=false`，reason=`tool_execution_failed`，节点保持 `verifying`，revision=11 |
| 同 attempt 只有失败行 | `accepted=false`，reason=`tool_execution_failed` |
| 失败行在 attempt 3，成功行与 evidence 在 attempt 2 | `accepted=true`，`next_status=done`（attempt 作用域正确） |

实现位置：`src/service/commands/apply-report.ts:341-386`，先查同 `node_run_id + attempt` 的全部 `tool_executions`，任一 `exit_code !== 0` 即拒。日志：`D:/aboutAI/_g2audit24/p024-matrix.log`。

### 第二十三轮 P0-3 服务端时钟

直接打 HTTP 接口，未注入 `now`，使用真实服务端时钟：

- `POST /v1/node-runs/lease`，body `now=1999-01-01T00:00:00.000Z`，`leaseTtlMs=600000` → HTTP 200，`expires_at=2026-11-13T18:07:53.079Z`（墙钟 `17:57:53.065Z` + 600 秒），`action_generation=1`。客户端 `now` 被忽略。
- `POST /v1/node-runs/renew`，body `now=1999-01-01`，`leaseTtlMs=1000` → HTTP 200，`expires_at=2026-11-13T17:57:54.090Z`（墙钟 + 1 秒），不是 1999。
- 等待 1.6 秒后，`POST /v1/node-runs/report`，body `now=1999-01-01` → HTTP 409，`code=LEASE_EXPIRED`，message=`租约已过期，执行器迟到上报被拒`。回拨 `body.now` 没有复活租约。

实现位置：`src/service/server.ts:26-28`（`ServerDeps.now`）、`:76`（`serverNow`）、`:136`（`requestNow`）；lease/renew/report/run/cancel 路由都取 `requestNow`。日志：`D:/aboutAI/_g2audit24/p03-clock.log`。

### 第二十三轮 P0-4 具名载荷

以下均被拒，节点保持 `verifying`，revision=11：

- `requiredHashes` 值为 `not-a-real-hash` → `verification_too_weak`。
- `requiredHashes` 只给键名、没有值 → `verification_too_weak`。
- `evidence.commandHash='f'.repeat(64)` 与 `tool_executions.command_hash` 不符 → `evidence_unverifiable`。
- 缺 `tool_finished` 事件 → `evidence_unverifiable`。
- 缺 `producedAt` → `evidence_missing`；`producedAt` 不可解析 → `evidence_missing`。
- `tool` 缺失、`tool` 不符、`stdoutHash` 不符、`stderrHash` 与行内 `NULL` 不符、`hashes.stdout` 不符、无 `tool_executions` 行 → 均为 `evidence_unverifiable`。
- `tool_finished` 的 attempt 不符、`exit_code` 类型不是 number、`command_hash` 不符 → 均为 `evidence_unverifiable`。

实现位置：`src/service/commands/apply-report.ts:341-386`；证据必须与同 attempt 的 `tool_executions` 行在 `tool/exit_code/stdout_hash/stderr_hash/command_hash` 上全等，并与该 node run 的 `tool_finished` 事件在 `attempt/tool/exit_code/stdout_hash/stderr_hash/command_hash` 上全等。日志：`D:/aboutAI/_g2audit24/p024-matrix.log`。

### 第二十三轮 P1-1 具名要求

- failed 无证据 → `accepted=false`，reason=`evidence_missing`。
- timeout 无证据 → `accepted=false`，reason=`evidence_missing`。
- failed 的 `source` 不是 `run_tool` → `verification_too_weak`。
- failed 的 `exitCode` 是字符串 `'2'` → `evidence_missing`。
- failed 带 `{source:'run_tool', exitCode:2}` → `accepted=true`，`next_status=failed`。
- timeout 带 `{source:'run_tool', exitCode:2}` → `accepted=true`，`next_status=timeout`。

具名要求满足；残留在 P1-2（未做 trace 绑定）。日志：`D:/aboutAI/_g2audit24/p024-matrix.log`。

## 构建与测试

- `pnpm exec tsc --noEmit`：exit 0，无类型错误。
- `pnpm exec vitest run`：32 个测试文件，340 例，11 失败 / 329 通过。
- 11 例失败全部在 `tests/gate-check.spec.ts` 的“门记录校验”组，错误都是 G1 预签锚点不匹配：

```text
审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…
```

  这 11 例是本轮允许的 G1 预签失败；没有其他失败。日志：`D:/aboutAI/_g2audit24/vitest.log`。

- 测试计数的边界：`tests/gate-check.spec.ts:677-688` 只锁定第二十三轮五个载荷；`:690` 之后没有覆盖“主语 + 引号包裹判定词”。因此 329 例通过不能推出 P0-1 性质已覆盖。

## 复现命令

主仓（只读）：

```powershell
cd D:/aboutAI/dsh-orchestra
git status --porcelain
pnpm exec tsc --noEmit
pnpm exec vitest run
node --no-warnings scripts/gate-check.ts docs/gates/G2.md
```

预签态下 `gate-check` 非 0 属于预期；不要在主仓执行 sign-gate。

审计脚本（`D:/aboutAI/_g2audit24`）：

```powershell
cd D:/aboutAI/_g2audit24
node --no-warnings p024-matrix.mjs
node --no-warnings p03-clock.mjs
node --no-warnings parser-matrix.mjs
node --no-warnings parser-extra.mjs
```

sign-gate 端到端（clone2，fixture 已建立；`e2e25.mjs` 在干净 clone 上一次性建立 fixture 后跑 8 例）：

```powershell
cd D:/aboutAI/_g2audit24/clone2
node --no-warnings D:/aboutAI/_g2audit24/e2e26.mjs
```

`e2e25.mjs` 的结果在 `D:/aboutAI/_g2audit24/e2e25.log`；`e2e26.mjs` 的结果在 `D:/aboutAI/_g2audit24/e2e26.log`。两个脚本只在临时 clone 中改 `docs/gates/G2.md` fixture 并提交 `docs/audits`，主仓门记录未被触碰。

## 结论与建议

候选 `638605c` 不满足 G2 的肯定条件：P0-1 仍可用可见否定句签成肯定，且P0-4 与 P1-1 各留一条可核对性缺口。P0-2、P0-3 已真实修复；第二十三轮点名的 P0-4 假值与 P1-1 无证据载荷已修复，但性质没有完全覆盖。

修复建议按优先级：

1. 不再扩固定词表。先把可见行做结构化归一：所有 Unicode `Pd` 连接号折叠为同一字符；引号、括号、逗号、省略号、间隔号等标点在“主语—判定”之间不阻断判定；对整句做否定极性判断，而不是只匹配邻接词。
2. 补齐否定词与主语：中文覆盖 `失败/未予通过/未得到通过/未过关/没过/通不过/不能通过/不是通过`、`审核/复核`；英文覆盖 `fail/fails/failed/failure/unsuccessful/not successful/didn't/did fail/did not succeed`；全角字母先做 NFKC。
3. `requiredHashes` 的值要与可核验产物绑定（先确定产物表或证据文件来源），不能只校验 64 位十六进制。
4. failed/timeout 的 `terminalEvidenceGate` 复用 `traceBindingGate`，要求同 attempt 的 `tool_executions` 与 `tool_finished` 全等，禁止与轨迹矛盾的失败证据。
5. 补测试：引号、括号、逗号、省略号、其他 `Pd`、同义否定词、英文变体各至少一例；`requiredHashes` 伪造 64 位值必须被拒；failed/timeout 的矛盾证据必须被拒。

修复后建议复跑：`e2e25` 的 `quote-cn-verdict`、`alt-dash-U2011`、`cn-shibai` 三例必须 exit 1 且 G2 字节不变；`p024-matrix` 的两个伪造哈希用例必须 `accepted=false`；全量 `vitest` 仍只允许那 11 例 G1 预签失败。

本轮最终计数：P0=1，P1=2，P2=0。
