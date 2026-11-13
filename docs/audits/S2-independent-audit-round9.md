# S2/G2 第九轮独立审计报告

- 审计对象：`D:/aboutAI/dsh-orchestra`，HEAD `f7ebe69c623a2d64cf8686449091070d5cd58565`
- 审计时间：2026-11-13 20:30–20:45（Asia/Shanghai）
- 审计方式：只读；未修改业务代码、门记录、证据、测试；未 `git commit`；唯一新增文件是本报告。
- 复现环境：Windows，`D:/NodeJs/node.exe` v26.13.1；仓库 `package.json` 的 typescript 6.0.3、vitest 4.1.8。
- 审计边界：除在系统临时目录重跑 `ev-g2-15` 外，未跑其余 18 个故障注入；其余 18 份证据按 HEAD 字节复核哈希，并读源码/测试判断链路。

结论：pass

## 零、判定摘要

- P0：0 项。
- P1：0 项。
- P2：9 项。其中 2 项已修（P2-6、P2-8），7 项未闭合（P2-1、P2-2、P2-3、P2-4、P2-5、P2-7、P2-9）。
- G2 当前仍是待重签状态，不是已签通过；本报告不把待签造成的门检查失败算作 S2 代码缺陷。
- 背景判断独立确认：`f7ebe69` 没有改 S2 业务代码与 G2 证据，只改了门检查脚本、门检查用例、G2.md 一句说明、G1/G-15 临时路径，并新增两份审计报告。见第一节。

## 一、审计范围与背景判断的独立确认

`git show --stat f7ebe69` 的实际范围是 6 个文件、+469/−7：

| 文件 | 改动 | 与任务背景的关系 |
| --- | --- | --- |
| `scripts/gate-check.ts` | +35/−7 | 审计结论解析与正文两表校验 |
| `tests/gate-check.spec.ts` | +32 | 对应回归用例 |
| `docs/gates/G2.md` | 2 行 | 只改 action_timeout 表述 |
| `docs/gates/evidence/G1/G-15.md` | 2 行 | 备份参数临时路径改为 `<tmp>/backup-g15` |
| `docs/audits/S1-independent-audit-round4.md` | +150 | 新增报告，任务背景未列举 |
| `docs/audits/S2-independent-audit-round8.md` | +255 | 新增报告，任务背景未列举 |

逐项核对：

- `git diff f572984..f7ebe69 -- src` 为空，S2 业务代码没有改动。
- `git diff f572984..f7ebe69 -- docs/gates/evidence/G2` 为空，G2 的 19 份证据没有改动。
- 任务背景说“此后 f7ebe69 只改了脚本、用例、G2.md 一句、G-15 临时路径”基本准确，但范围要补上两份新增审计报告；这不影响“S2 业务代码与 G2 证据未改”的核心判断。
- 工作树在审计开始时是干净的；审计期间 `handoff.md` 出现父代理写入的交接内容，属于门检查 `DIRTY_IGNORES` 中的 `handoff.md`，不是本审计改动，也不回滚。
- 本报告写入后，工作树预计只有 `handoff.md` 与本报告两处未提交变化；HEAD 仍为 f7ebe69。

## 二、G2 19 项与证据复核

### 2.1 六处清单的一致性

逐项读取 `docs/gates/G2.md`、`scripts/gate-check.ts:97-164`、GateArtifact、evidence-index 与 invariants 块后，结果如下：

| 载体 | 数量 | 核对结果 |
| --- | --- | --- |
| `GATE_SPECS.G2.items` | 19 | 与 artifact 的 19 个 id、顺序完全一致 |
| `GATE_SPECS.G2.content` | 19 | 与正文必过表第 2 列逐字一致 |
| `artifact.must_pass_items` | 19 | 每项 id 对齐，`result` 全为 `pass`，`evidence_ids` 均非空 |
| `GATE_SPECS.G2.evidenceMap` | 19 | 与 artifact/正文的证据集合一致；G-07 的数组顺序为 `[ev-g2-g07, ev-g2-09]`，artifact/正文为 `[ev-g2-09, ev-g2-g07]`，门检查按排序后的集合比较，故不是缺陷 |
| evidence-index 块 | 19 | 与正文“证据文件与哈希”表 19 行逐条一致 |
| invariants 块 | 11 | 与正文不变量表 11 行逐条一致 |

补充说明：`artifact.must_pass_items` 每项只有 `id`、`result`、`evidence_ids`，没有 `content` 字段；正文内容由 `GATE_SPECS.G2.content` 固定。这是 schema 设计，不是 artifact 缺项。

正文必过表 19 行（G2.md:27-45）按 `checkBodyTable` 的读取口径复核：id 顺序、内容、结果、证据全部通过；表头“编号”被正确跳过。正文证据表 19 行与正文不变量表 11 行直接调用 `checkBodyEvidenceTable`、`checkBodyInvariants` 均通过。

### 2.2 19 份证据从 HEAD 重算 sha256

方法：对每个 evidence-index 条目执行 `git show HEAD:<file>` 取字节，按 LF 归一（CRLF→LF），再算 sha256。19 份全部匹配，bad=0：

```text
ev-g2-01 f10efac98f2d0d91bfc83d0e1bacb3c2a5111c11bc7223de6464a057a744d88b OK
ev-g2-02 346af5813c653ba967af948a74aba27201b9ac906f13e54f4e588f8b18ea70e1 OK
ev-g2-03 784e44b65d6642404d0f7664bda64e48337292101a102f1403aef4caee4a6db5 OK
ev-g2-04 65946e22958ef8764415d2af693245f8dc8da33e585ba4cee094e36f56ac71a6 OK
ev-g2-05 74c0a94705a24494d435c995317d6a29f40e089a992e9c75afa5e0735b35adb1 OK
ev-g2-06 cef5cf3de601985af216cb935334414d56ff9f3f296871f709332f9e16b1f91c OK
ev-g2-07 607471ff9e475eaa30e3a83376b4c93aed12b6e209b7bd2601678737cf934a34 OK
ev-g2-08 54e4b0e8415abd5bc65ce885c407245d91ec099390e64a2b3188c89cb1144cbf OK
ev-g2-09 f43b50982b67843db87e1cae9b36b0048eca372d9734904d3e1090fc97b8d8b2 OK
ev-g2-10 76b458edf0f4f24a4408be4bf429b4a9025399aa002c52b6c50676a5f4f45e8b OK
ev-g2-11 05c1c8ea1ab5796a24adc50931a3a1b3d6d085af56975b47f6c9a113f7f233c7 OK
ev-g2-12 5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe OK
ev-g2-13 a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc OK
ev-g2-14 865fd0b7bca1193256dedee74f30a18c8903f5e0fa4c2d119cad6e41b50ada02 OK
ev-g2-15 db1c814f8935e1779440aec12c5a229a6ec8636a0e6ccc7f86d2ac834e037038 OK
ev-g2-g03 514f9754fda67b8e1522d086fc6079301e00bd0185f9cca6dddec502c412ab70 OK
ev-g2-g04 fb68366d1292bb80e9ae59febf7fd5ad1e28e580ecfc2883e99b18edb2e6eca9 OK
ev-g2-g05 2f7da35abe9c1484143b85a0226da8a0ebd095994c8e2aa492dd88f726b51904 OK
ev-g2-g07 8898db1323c191c8ca0acd51d2dde5458355b7b25f3b0c96f868ec38d8ef730e OK
```

注意：这是“证据文件字节与 evidence-index 记录”的匹配；G2 记录里的 `evidence_index_hash`、`invariants_hash` 本身仍是旧值，见 2.4。

### 2.3 ev-g2-15 临时目录重跑

在 `C:/Users/ASUS/AppData/Local/Temp/audit9-ev15-W1bxgp` 下执行：

```text
D:/NodeJs/node.exe --no-warnings D:/aboutAI/dsh-orchestra/scripts/fault-inject.ts --case ev-g2-15
```

结果：exit 0，343 ms；生成 `docs/gates/evidence/G2/ev-g2-15.md` 2434 字节，sha256=`db1c814f8935e1779440aec12c5a229a6ec8636a0e6ccc7f86d2ac834e037038`，与仓库记录 2434 字节、同哈希一致。重跑输出中的关键事实：

- 首次加载 `POST /v1/workflows/load` HTTP=200；进入 verifying HTTP=200。
- 重启前绑定 `{"workflow_version":1,"workflow_definition_hash":"206681cf51becb770748c437ebd0e9133ed831e691f76684c70567a5b4545256"}`。
- 重启后定义表仍为 `[{"version":"1","content_hash":"206681cf51becb770748c437ebd0e9133ed831e691f76684c70567a5b4545256"}]`，同版本改写返回 HTTP=409、`WORKFLOW_VERSION_IMMUTABLE`。
- 节点行仍为 `{"status":"verifying","attempt":1,"revision":3}`；弱证据收口返回 `{"accepted":false,"reason":"verification_too_weak","registry_state":"rejected"}`。
- 临时目录在核对后删除；仓库内未写入证据，`git status` 未因这次重跑发生变化。

### 2.4 记录哈希的待重签状态

按门检查口径重算 G2 的六处哈希，与记录值对照如下：

| 字段 | 记录值（G2.md） | HEAD 重算值 | 说明 |
| --- | --- | --- | --- |
| `candidate_hash` | `f11d0fb8…` | `f15d99db…` | f7ebe69 改了 gate-check.ts 与用例，候选必然变 |
| `change_scope_hash` | `33a82c41…` | `fc570cab…` | 同上 |
| `evidence_index_hash` | `bcaaaa3e…` | `106e1c36…` | 记录停在旧轮次，当前 19 条索引已不同 |
| `invariants_hash` | `77708d4b…` | `925a7768…` | 同上 |
| `artifact_hash` 锚 | `b5615b8b…` | `ea3dff4c…` | artifact 未重签 |
| `body_hash` 锚 | `ef21bb45…` | `8a446dab…` | G2.md 正文改过一句，且自锚未重签 |
| `audit_report_sha256` | 64 个 0 | `c9cef2e4…`（round4 报告） | 待重签 |
| `previous_artifact_hash` | `1ce80f60…` | G1 实算 `f54dcae8…` | G1 待重签，链待更新 |

这些都是“门记录未重签”的表现，不是 S2 运行期回归。`sign-gate.ts` 会重算并写回证据 sha、`evidence_index_hash`、`invariants_hash`、`candidate_hash`、`change_scope_hash`、`previous_artifact_hash`、`audit_report_sha256`、`artifact_hash` 与 `body_hash`；但不改 `audit_round`、`audit_report`、`conclusion`、`approved_at`。

### 2.5 正文两表新校验是否误伤

直接调用 f7ebe69 导出的 `checkBodyEvidenceTable` 与 `checkBodyInvariants` 对真实 G2.md：

- 正文证据表：通过（19 行，id/文件/sha256 全对）。
- 正文不变量表：通过（11 行，statement 与 evidence_ids 集合全对）。
- 按同一口径复刻的 `checkBodyTable`：通过（19 行，表头被跳过）。

负向验证：

- 把正文证据表某一行 id 改成 `ev-g2-01`（逐行替换，制造重复）→ 抛“正文证据表里证据重复: ev-g2-01”。
- 删除 `ev-g2-15` 行再复制 `ev-g2-14` 行（保持行数）→ 抛“正文证据表里证据重复: ev-g2-14”。
- 若只删行不补，循环后的“缺 artifact 里的证据”检查会点名缺失 id。

复核结果是：新校验对正常 G2 表没有误伤，重复行与缺行两类绕过都被拦截。

## 三、f7ebe69 对审计结论解析的影响

### 3.1 解析器改动

`scripts/gate-check.ts:490-526` 的 `auditConclusionOf` 现在：

- 跳过围栏代码块（`gate-check.ts:496-499`，仍是行首三反引号/波浪号简单翻转，未配对，P2-7 未修）。
- 去掉标题与行首加粗后，只认行首“结论/判定：”或行首 pass/fail/通过/不通过。
- 候选行无法严格收口时返回 null（`looksLikeConclusion`，:507-515）。
- 同一行同时出现 pass 与 fail 记号时返回 null（:517-520）。
- 解析成功后 `raw.toLowerCase()`（:521），修复 P2-6 的大写 PASS 误判。

### 3.2 对已有 G2 报告的实际解析

| 报告 | `auditConclusionOf` | 说明 |
| --- | --- | --- |
| `docs/audits/S2-independent-audit-round8.md` | pass | 唯一结论行可读，f7ebe69 未破坏 round8 |
| `docs/audits/S2-independent-audit-round4.md`（G2 当前 audit_report） | null | 首行是带解释的 fail，后文还有未收口的“结论”候选，按歧义返回 null；无论 null 还是 fail，都不能给当前 pass 门签 |
| `docs/audits/S1-independent-audit.md`（G1 当前 audit_report） | null | 没有唯一结论行；G1 不能原样补哈希重签 |

G1/G2 的 `gate-check` 目前都在审计报告 sha256 处早退，错误文本分别是：

```text
G1: 门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…
G2: 门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != c9cef2e419c91711…
```

也就是说，解析器的 P2-9 过宽问题目前没有在 G1/G2 门检查里表现出来，因为更早的 sha 检查先失败；但写报告时仍要避开它。

### 3.3 新回归用例

`tests/gate-check.spec.ts` 新增：

- :146-165 正文证据表重复行、正文不变量重复行；
- :258-261 未收口候选行返回 null；
- :263-267 大写 PASS/FAIL 归一、同行“pass（上一轮 fail）”返回 null；
- :269-272 围栏用例。

这些用例在 G1/G2 待签状态下会被审计 sha 早退遮蔽，不能据此声称已在 HEAD 实测通过；但代码路径本身已读，且 P2-6/P2-8 的行为用直接调用 `auditConclusionOf` 复测通过。

### 3.4 新发现 P2-9：fail-closed 过宽

`looksLikeConclusion` 把任何行首“建议：”都当作结论候选，且同行相反 token 一律拒绝。实测：

```text
结论：pass
建议：补充一条回归用例
=> null
```

```text
结论：pass（对照 round8 的 fail 项已关闭）
=> null
```

```text
结论：pass

## 建议

补一条回归
=> pass（标题“建议”无冒号，不触发候选）
```

影响：不会把 fail 读成 pass，方向是安全的；但合法报告只要多一行“建议：……”或结论行解释里带反义词，就会变成“找不到唯一结论”。本轮报告因此只写一行裸“结论：pass”，全文不出现行首“建议：”，结论行不出现 fail/pass 反义词。

## 四、第八轮 P2 项的当前状态

### P2-1 动作/判定时限配置未进生产装配：未闭合

- `src/index.ts:87-98` 调 `runNode` 时只传 `leaseTtlMs`、`leaseRenewIntervalMs`，没有传 `actionTimeoutMs`、`verifyTimeoutMs`。
- `src/executor/run-node.ts:144`、`:251` 只在参数缺省时使用 `DEFAULT_ACTION_TIMEOUT_MS` / `DEFAULT_VERIFY_TIMEOUT_MS`。
- `src/core/config.ts:36`、`:40` 定义了配置字段，但 `src` 内没有消费 `execution.action_timeout_ms` / `verify_timeout_ms` 的路径。
- G2.md:17 已如实改为“动作总时限默认 120 秒，execution.action_timeout_ms 的配置接线留 S3（本轮只有默认值生效）”，这一点比上一轮诚实；但 G2.md:55 的“本批定值”表仍写“动作超时 `execution.action_timeout_ms` | 120000”，与“配置未接线”存在残留表述不一致。不影响默认值行为，列为 P2 资料项。

### P2-2 lease_lost / action_timeout 执行期回归：未闭合

- `tests` 中没有 `lease_lost` 或动作总时限触发的执行期用例；grep 只命中 `tests/errors.spec.ts:41` 的错误码列表。
- 现有覆盖是：`tests/runtime.spec.ts:86` 工具 exitCode 非 0、`:144` 长动作心跳成功、`:200` `tool_execution_failed`；`tests/integration/g2.spec.ts:86`、`:192` 报告期租约过期；`tests/sweep.spec.ts:133` 扫描期过期。
- `src/executor/run-node.ts:75-90` 的续租失败分支、`:154-159` 的动作超时分支没有失败路径测试。

### P2-3 跨重启测试是否 close/reopen：未闭合

`tests/workflows.spec.ts:45-55` 仍是同一个 `freshLedger` 数据库上新建第二个 `WorkflowCatalog`，第一个 Catalog 未 close，数据库未 reopen。它验证的是同库 hydrate 能读回，不是进程级 close/reopen；真正的跨重启覆盖仍在 `ev-g2-15`（本轮已在临时目录重跑）。

### P2-4 前序链只比字符串：未闭合

`scripts/gate-check.ts:472-486` 的 `checkPreviousChain` 只从 G1 HEAD 文本正则取 `artifact_hash`，与 G2 的 `previous_artifact_hash` 比较；不重算 G1 artifact，也不检查 G1 的审计锚、证据与正文。当前 G1 锚 `1ce80f60…` 与实算 `f54dcae8…` 不符，正说明这条链只认字符串。

### P2-5 WorkflowCatalog 引用/别名：未闭合

`src/service/workflows.ts:104-115` 的 `remember` 先 `this.defs.set(key, def)`，再检查别名冲突；若别名撞定义抛错，key 已留在内存，后续同名 load 会走 existing 分支。属内存残留，不是落库错误。

### P2-6 大写 PASS：已修

`auditConclusionOf` 在 :521 转小写；实测“结论：PASS（0 致命）”=>pass，“结论：FAIL（致命 1）”=>fail；`tests/gate-check.spec.ts:263-267` 有对应用例。

### P2-7 围栏翻转配对：未闭合

`gate-check.ts:496-499` 仍是行首 ```` 或 `~~~` 简单翻转 `inFence`，不比较围栏长度、不检查类型配对、不检测未闭合。未闭合围栏会吞掉后文结论，解析器返回 null（fail-closed）；但“不同长度的三反引号”仍可能被误当闭合。属 P2。

### P2-8 括号内相反结论：已修

`gate-check.ts:517-520` 同一行同时出现 pass 与 fail 记号即返回 null。实测“结论：pass（上一轮 fail）”=>null、“结论：pass——上一轮 fail 已修”=>null；修复方向正确。代价是 P2-9 的合法解释行也会被拒，属 fail-closed 过宽。

### P2-9 结论解析 fail-closed 过宽：本轮新增，未闭合

见 3.4。任何行首“建议：”或结论行带反义词都会返回 null。它不会造成假 pass，但会让合法报告无法签门；后续若要收窄，可在“建议：”后只匹配“通过/不通过”，并把反义词判断限定在括号/破折号解释段，而不是整行。

## 五、S2 核心链路复核

本节以源码与已有证据/用例为主，未重跑全部注入；关键结论都有文件行号或本轮命令/字节证据。

### 5.1 生产装配

- `src/index.ts:110-134`：`acquireDbLock` → `bumpEpoch` → `openServiceDb(epoch)` → `createOrchestra`；`createOrchestra` 只接受 `openServiceOrchestra` 下发的 symbol 凭证（`src/index.ts:42-49` 对无凭证直建抛 `FORBIDDEN`）。
- 创建时开库、迁移、`new WorkflowCatalog(phase, db)`、`hydrate()`、`SystemClock(randomUUID())`；close 时关库（`src/index.ts:50-57`）。
- 相关用例 `tests/production-path.spec.ts` 4 例全绿（全量输出见第六节）。

### 5.2 applyReport 的系统证据门

- `src/service/commands/apply-report.ts:236-250` 对 done 再做系统证据门；`:303-310` 要求 `source=run_tool`、`exitCode` 是 number 且为 0，否则分别给出 `evidence_missing` / `verification_too_weak` / `tool_execution_failed`。
- `:314-323` 的 traceBinding 再核对 `tool_executions` 的 `exit_code` 与 `stdout_hash`；对不上返回 `evidence_unverifiable`。
- `tests/apply-report.spec.ts:291-323` 四例覆盖：无痕迹、弱来源、exitCode 非 0、stdout_hash 不符，全部 accepted=false 且节点停在 verifying。
- 工具失败不落 done：`src/executor/run-node.ts:215` exitCode 非 0 即 break，`:229-239` 由系统 `markBlocked('tool_execution_failed')` 并抛 `VERDICT_POLICY_UNMET`；只有全部成功后 :241-255 才 transition 到 verifying，:257 之后才允许 done。`tests/runtime.spec.ts:86`、`:182-200` 覆盖 blocked/tool_execution_failed。
- 状态机四道门在 `apply-report.ts:210-224`：expectedStatus、generation、lease、canTransition；阻塞凭据与迁移在 :253-283。

### 5.3 boot_id 与单调钟

- `src/core/clock.ts:51-62`：判定只认 `boot_id` + `monotonic_ns`；墙钟漂移超过 2 秒判不确定；`SystemClock:111-125` 用 bootId 与 hrtime；`anchorOf/remaining` 处理跨 boot。
- `src/executor/run-node.ts:252-253` 进入 verifying 时写 `verifyAnchor`；sweep 用 deadline 的 boot 校验。`ev-g2-09` 覆盖墙钟跳变，G2-09/G-07 的 19 项证据可复核。

### 5.4 单写者锁与 epoch

- `src/index.ts:110-134` 先拿锁再开库；`src/infra/sqlite/driver.ts:75-91` 每事务校验 `instance_epoch`，失配抛 `STALE_GENERATION`。
- 第二写者拿不到锁、旧 epoch 写不进的证据是 `ev-g2-13`；该证据字节本轮已从 HEAD 重算匹配。

### 5.5 工具授权只认 workflow 定义

- `src/executor/run-node.ts:56-65` 先 `policyForNodeRun`，`src/executor/run-node.ts:102-114` 从 `node_runs` join `runs` 取 `workflow_version`，再 `catalog.toolPolicyFor`；node_id 与账本不符抛 `STALE_GENERATION`。
- `checkToolPolicy` 只接受 pure，`assertToolsAuthorized` 只认定义里的 allow/deny；`src/service/workflows.ts:84-89` 返回定义策略副本。请求体里的 policy 不参与。证据 `ev-g2-12`。

### 5.6 跨重启 workflow_versions

- `src/service/workflows.ts:29-41` 启动时从 `workflow_versions` hydrate 并复核 `content_hash`；`:43-70` load 先查已落库版本，哈希不同抛 `WORKFLOW_VERSION_IMMUTABLE`，新定义落库。
- `tests/workflows.spec.ts:45-55` 只是同库 hydrate（P2-3）；真正的 close/reopen 由 `ev-g2-15` 覆盖，本轮临时目录重跑输出见 2.3。

### 5.7 租约心跳

- `src/executor/run-node.ts:66-97` acquire 后 `setInterval` renew；失败写 `lease_lost` 事件并置 lost；`:223-227` lost 时 `markBlocked('lease_lost')` 并抛 `LEASE_EXPIRED`。
- `src/service/commands/lease.ts:86-100` 的 renewLease 用 CAS(revision+lease_id) 更新 expires/heartbeat；`src/service/dispatcher.ts:52-53` 传租约参数。
- `tests/runtime.spec.ts:144` 覆盖长动作 2.5 秒不被扫描误判；失败路径的缺失见 P2-2。

### 5.8 markBlocked 的顺序

`src/executor/run-node.ts:298-317` 先 `canTransition` 再 `transition`。动作超时分支在 :156-159 先 `markBlocked('action_timeout')`，随后 catch 再 `markBlocked('tool_execution_failed')` 时被状态机挡住，最终原因保留为 action_timeout；这是读源码得到的结论，失败路径仍缺测试（P2-2）。

## 六、类型检查与测试的真实输出

### 6.1 tsc

命令：

```text
D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit
```

结果：`TSC_EXIT=0`，无 stdout/stderr。

### 6.2 全量 vitest

命令：

```text
D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run
```

本轮结果：

```text
Test Files  1 failed | 31 passed (32)
     Tests  10 failed | 284 passed (294)
  Duration  4.52s
VITEST_EXIT=1
```

10 个失败全部在 `tests/gate-check.spec.ts`，且都早退于 G1 的 `audit_report_sha256` 占位：

```text
FAIL  tests/gate-check.spec.ts > 门记录校验 > G1 门记录通过
FAIL  tests/gate-check.spec.ts > 门记录校验 > 改 candidate_hash 但锚点不动时报哈希不符
FAIL  tests/gate-check.spec.ts > 门记录校验 > 证据文件的哈希对不上时指名哪一份（审计 F1）
FAIL  tests/gate-check.spec.ts > 门记录校验 > evidence_index_hash 被改时指名证据索引不符
FAIL  tests/gate-check.spec.ts > 门记录校验 > candidate_hash 改成别处的值时指名与候选文件不符
FAIL  tests/gate-check.spec.ts > 门记录校验 > 正文必过项的内容列被改时指名不一致（审计 N-09）
FAIL  tests/gate-check.spec.ts > 门记录校验 > 正文证据表的哈希被改时拒绝（审计 R3-06）
FAIL  tests/gate-check.spec.ts > 门记录校验 > 正文不变量说明被改时拒绝（审计 R3-06）
FAIL  tests/gate-check.spec.ts > 门记录校验 > 证据文件与固定文件映射不一致时拒绝（S1 第二轮审计）
FAIL  tests/gate-check.spec.ts > 门记录校验 > 正文自锚 body_hash 被改时拒绝（审计 R3-08）
```

首个错误文本：

```text
AssertionError: expected [Function] to throw error matching /.../ but got
'审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…'
```

单跑 `tests/gate-check.spec.ts` 的结果是 `Test Files 1 failed (1)`、`Tests 10 failed | 24 passed (34)`。

判断：这 10 个红是 G1 待签造成的，不是 S2 代码缺陷。它们没有执行各自要断言的篡改分支，因此也不能据此声称这些负向断言在 HEAD 实际通过；G1 重签后应恢复到 34/34。全量里 S2 运行期相关的 `apply-report`、`runtime`、`integration/g2`、`production-path`、`workflows` 等文件均通过，未见运行期红灯。

### 6.3 两道门检查

```text
G1: 门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…  (exit 1)
G2: 门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != c9cef2e419c91711…  (exit 1)
```

G2 的失败是待重签，不是 G2 业务链在本轮出现回归。

## 七、待签状态与重签顺序

### 7.1 G1

G1 不只是“哈希没填”：

- `docs/gates/G1.md:191-193`：`audit_round=1`、`audit_report=docs/audits/S1-independent-audit.md`、`audit_report_sha256` 全 0、`conclusion=pass`。
- `auditConclusionOf(docs/audits/S1-independent-audit.md)=null`，即当前报告没有唯一可解析结论；即便补上 sha，`checkAuditAnchor` 仍会在“找不到唯一结论行”处拒绝。
- G1 正文证据表 13 行有 4 行已旧：`ev-g14` 记录 `3b2e37d9…`、实算 `44351757…`；`ev-g15` 记录 `db16d844…`、实算 `334f26fb…`；`ev-gatecheck` 记录 `c6126250…`、实算 `c0883f7a…`；`ev-migrate` 记录 `b3ad3fbd…`、实算 `6ec79969…`。
- G1 artifact 实算 `f54dcae873f34a988ca7d6fbf5bd0b29ce68558acfd4007f0b477e49b65cc4ec`，锚为 `1ce80f60…`；body 实算 `aea5ac30…`，锚为 `446357f9…`。

因此 G1 需要先有新的 S1 审计报告（能解析出唯一结论），再重签 G1 并提交；这不是 S2 代码缺陷，但会挡住 G2 的前序链。

### 7.2 G2

G2 当前：

- `audit_round=4`、`audit_report=docs/audits/S2-independent-audit-round4.md`、`conclusion=pass`、`audit_report_sha256` 全 0。
- round4 报告首行可见 fail 且 `auditConclusionOf=null`；当前 G2 若只补 sha，仍会在结论一致性处被拒。
- `evidence_index_hash`、`invariants_hash`、`candidate_hash`、`change_scope_hash`、`artifact_hash`、`body_hash` 均为旧值；`previous_artifact_hash` 还指向旧 G1 锚。
- `sign-gate.ts` 会重算并写回上述哈希，但不会改 `audit_round`、`audit_report`、`conclusion`、`approved_at`；这些字段必须人工改为本轮报告与轮次。

建议的重签顺序（按依赖）：

1. 先处理 G1：新 S1 报告 → 人工把 G1 artifact 的 `audit_round`/`audit_report`/`approved_at` 更新 → `sign-gate.ts docs/gates/G1.md` → 提交。
2. 提交本报告 `docs/audits/S2-independent-audit-round9.md`；未提交前 `checkAuditAnchor` 的 `contentAt(HEAD, report)` 会失败。
3. 人工把 G2 artifact 改为 `audit_round=9`、`audit_report=docs/audits/S2-independent-audit-round9.md`，更新 `approved_at`；`previous_artifact_hash` 由 sign-gate 从 G1 HEAD 锚重算。
4. 运行 `sign-gate.ts docs/gates/G2.md`，再提交 G2.md。
5. 运行两道 `gate-check` 与全量 vitest；G1 的 10 个早退用例应恢复，gate-check 单文件应为 34/34。

重签时不能把 G2 指向 round8 图省事：round8 审计对象是 f572984，当前 HEAD 是 f7ebe69；round8 的结论虽然可解析为 pass，但它没有覆盖 f7ebe69 的 gate-check/用例改动。审计锚只校验报告在 HEAD、轮次、字节与结论，不校验报告声明的被审 commit，这一点需要人工把关。

## 八、剩余风险

- P2-1：配置接线仍在 S3，动作/判定时限只有默认值；G2.md:55 的定值表还写配置键，重签前宜顺手改成“默认 120 秒，配置接线见 S3”。
- P2-2：lease_lost / action_timeout 的真实失败路径仍无执行期回归；当前只有正向心跳与报告期/扫描期过期。
- P2-3：workflows 单测的“跨重启”仍是同库 hydrate；真实 close/reopen 只有 ev-g2-15 一份证据。
- P2-4：前序链只比字符串；G1 锚与实算不符时，G2 仍只会在字符串层面被更新，无法发现 G1 artifact 本身已坏。
- P2-5：WorkflowCatalog 别名冲突后的内存残留未清；不是落库错误，但会让被拒定义在同进程内“看起来已存在”。
- P2-7：围栏只做行首翻转，不配对长度/类型；未闭合时 fail-closed，但不同长度围栏仍可能误判。
- P2-9：合法报告带“建议：”或结论行带反义词会被读成 null；本轮报告已规避，后续报告也要注意。
- 审计锚不绑定被审 commit：重签者必须确认报告正文的 HEAD 与当前候选一致；round8 可解析为 pass，但它的对象是 f572984。
- G1 报告无唯一结论、4 份证据哈希已旧；G1 重签不是简单跑一次 sign-gate。
- 本轮只重跑了 ev-g2-15；其余 18 份证据只做字节哈希复核，未逐案重执行。字节匹配能证明证据未被改动，不能替代对每个注入路径的独立运行。
- 本报告写入后尚未提交；在提交前，G2 不能完成审计锚检查。

## 九、审计执行记录

- 读取：`scripts/gate-check.ts`、`scripts/sign-gate.ts`、`src/index.ts`、`src/executor/run-node.ts`、`src/service/commands/apply-report.ts`、`src/service/workflows.ts`、`src/infra/sqlite/driver.ts`、`src/core/clock.ts`、`G1.md`、`G2.md`、round8 报告与相关测试。
- 运行：`tsc --noEmit`；全量 `vitest run`；`gate-check.ts docs/gates/G1.md`；`gate-check.ts docs/gates/G2.md`；`fault-inject.ts --case ev-g2-15`（临时 cwd）。
- 写入：仅本报告。
- 未做：未修改源码/门记录/证据/测试，未签门，未提交，未跑其余 18 个注入。
