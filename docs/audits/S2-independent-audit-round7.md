# S2 第七轮独立审计报告

## 一、审计对象与边界

- 审计对象：D:/aboutAI/dsh-orchestra（本地 git 仓库）
- HEAD：c4f7b35ff96ed219d1a39ef40d9392f781706383（提交说明“S2 第六轮整改：工作流定义跨重启落库、证据门与 S1 门加固”）
- 审计范围：src/、tests/、scripts/、docs/gates/、docs/audits/ 与本轮相关的证据文件
- 审计边界：只读代码、测试、证据与文档；本轮只写本报告文件，不改 src/、tests/、scripts/
- 审计开始时 git status --porcelain 为空。审计进行中发现工作树出现未跟踪文件 docs/audits/S1-independent-audit-round3.md（2026-11-13 20:03:56 创建），来自并行审计任务，不是本轮写入；本报告不把它计入候选代码或缺陷。本报告自身写入后也会成为未跟踪文件，这是审计产物的预期状态。
- G1/G2 门记录当前未重签：audit_report_sha256 仍是占位，gate-check 集成用例因此红。这是审计通过后才做的事，本轮按预期待签状态记录，不作为缺陷依据。

## 二、执行命令与实测输出

### 2.1 类型检查

命令：

    D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit

实测：exit 0，无输出（脚本末尾打印 tsc_exit=0）。

### 2.2 全量测试

命令：

    D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run

实测输出末段：

    Test Files  1 failed | 31 passed (32)
         Tests  10 failed | 278 passed (288)
      Duration  4.12s

10 个红全部在 tests/gate-check.spec.ts，首因均为审计报告 sha256 与记录不符（G1 未重签）：

    AssertionError: expected [Function] to throw error matching /body_hash/
    but got '审计报告 sha256 与记录不符（报告改过就重新审计再签）：
    0000000000000000… != 50ba1b13cdf1b84d…'

这 10 例分别是：G1 门记录通过；改 candidate_hash 但锚点不动；证据文件哈希不符；evidence_index_hash 被改；candidate_hash 与候选文件不符；正文必过项内容列被改；正文证据表哈希被改；正文不变量说明被改；证据文件与固定映射不一致；正文自锚 body_hash 被改。除这 10 例外，其余 278 例全绿。

另单跑本轮重点四文件：

    D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/workflows.spec.ts tests/runtime.spec.ts tests/apply-report.spec.ts tests/routes.spec.ts

实测：4 files passed，45 tests passed（workflows 6、runtime 7、apply-report 28、routes 4）。

### 2.3 G2 门检查

命令：

    D:/NodeJs/node.exe scripts/gate-check.ts docs/gates/G2.md

实测：

    门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：
    0000000000000000… != c9cef2e419c91711…
    gate_exit=1

这是预期待签状态：G2 artifact 的 audit_report 仍指向 docs/audits/S2-independent-audit-round4.md，audit_report_sha256 仍是 64 个 0。检查在审计锚这一层早退，尚未走到四个哈希、证据表和候选清单。注意：round4 报告自身结论是 fail，即使只把 sha256 补上，审计报告结论与门记录结论 pass 仍不一致，门仍会拒绝；重签必须换成一份结论为 pass 的审计报告。

### 2.4 G2 证据重算

从 HEAD 逐份读取 19 份证据，按 LF 归一后的字节重算 sha256，与 docs/gates/G2.md:70-88 的证据表逐行对照：

    19 行全部 OK，bad=0

19 份为 ev-g2-01 到 ev-g2-15（含 G2-05 复用 ev-g2-10、G-07 复用 ev-g2-09）以及 ev-g2-g03、ev-g2-g04、ev-g2-g05、ev-g2-g07。ev-g2-15 记录值是 db1c814f8935e1779440aec12c5a229a6ec8636a0e6ccc7f86d2ac834e037038。

### 2.5 G2-15 字节复现

在两个不同的临时工作目录分别执行：

    D:/NodeJs/node.exe D:/aboutAI/dsh-orchestra/scripts/fault-inject.ts --case ev-g2-15

（用临时 cwd 是为了不覆盖仓库里的证据文件。）两次均 exit=0，生成 ev-g2-15.md 的原字节 SHA256 都是：

    DB1C814F8935E1779440AEC12C5A229A6EC8636A0E6CCC7F86D2AC834E037038

两次输出内容一致：重启后定义表只有 version 1 / content_hash 206681cf…；POST /v1/workflows/load 同版本改写返回 HTTP=409、WORKFLOW_VERSION_IMMUTABLE；在飞节点仍为 verifying；弱证据 done 收口返回 accepted=false、reason=verification_too_weak、registry_state=rejected。G2-15 字节稳定且可复现。

### 2.6 审计结论解析探针

直接 import scripts/gate-check.ts 的 auditConclusionOf 实测：

| 输入 | 解析结果 |
| --- | --- |
| # 报告 / 门记录结论：pass / 结论：fail | fail |
| # 报告 / 结论：pass / 结论：fail | null |
| # 报告 / 门记录结论：pass | null |
| ### **结论：fail** | fail |
| 结论：通过率 60%，未达门槛 | pass（问题） |
| 结论：pass 的条件见下 | pass（问题） |
| 正文 / 本报告结论：fail / fenced code 里一行 结论：pass | pass（问题） |
| 结论：pass or fail | pass（问题） |
| 结论：未通过 | null |

第六轮 P0-1 的直接场景已经修好：行内“门记录结论：pass”不再被当成结论，多个不同结论返回 null。但解析器仍有同类残留，见 P1-1。

## 三、逐项核验

### 3.1 P0-1 门记录审计结论解析

实现位置：scripts/gate-check.ts:476-489 的 auditConclusionOf，scripts/gate-check.ts:493-519 的 checkAuditAnchor。

已确认成立的部分：

- 逐行解析，trim 后去掉行首 # 与 **，只匹配行首的 结论/判定/审计结论。
- 全文出现两个不同结论时返回 null，不会任取第一个。
- checkAuditAnchor 限定 docs/audits/ 下的 Markdown、路径不含 ..、不能指向门记录自身、报告必须在 HEAD、文件名 roundN 必须等于 audit_round、audit_report_sha256 必须等于报告在 HEAD 里的 LF 归一字节哈希、审计报告结论必须等于 artifact.conclusion。
- 证据 id 与文件路径固定映射在 scripts/gate-check.ts:265-274；证据也从 HEAD 读取并重算哈希。证据换绑已闭合。

仍有问题：正则 scripts/gate-check.ts:480 的结尾是 (?![a-zA-Z])，没有要求结论 token 后就是行尾；scripts/gate-check.ts:478-485 也没有跳过 fenced code block。因此“结论：通过率 60%，未达门槛”会被读成 pass，“结论：pass 的条件见下”同样会被读成 pass，代码块里单独一行“结论：pass”也会被计入。这不是理论问题：只要 fail 报告没有另起一行写“结论：fail”，门就能把这份 fail 报告当成 pass 的报告签进 G2。详见 P1-1。

### 3.2 G2 19 项与证据闭合

- 必过项表：docs/gates/G2.md:25-45 共 19 行，与 scripts/gate-check.ts:98 的 GATE_SPECS.G2.items 顺序、数量完全一致。
- 内容列：19 行的内容逐条等于 scripts/gate-check.ts:99-119 的 spec.content。
- 证据映射：表里的证据列与 spec.evidenceMap（scripts/gate-check.ts:120-140）逐项排序后一致；G2-05 的 ev-g2-05,ev-g2-10 与 G-07 的 ev-g2-09,ev-g2-g07 都对得上。
- artifact.must_pass_items：19 项，id 与顺序同 spec.items，每项 evidence_ids 同 spec.evidenceMap。
- evidence-index：19 条，id、file 与 spec.evidenceFiles（scripts/gate-check.ts:141-161）逐一一致；19 条 sha256 与 docs/gates/G2.md:70-88 的表一致，且都能从 HEAD 字节重算出来。
- invariants：docs/gates/G2.md:113-127 的 11 行与 artifact 的 invariants 区块 11 项一致；I1-I11 的 evidence_ids 都存在于 evidence-index，且每份证据至少被一个必过项或不变量引用。
- 证据字节：见 2.4，19/19 OK，bad=0。
- G2-15：见 2.5，两次运行同字节，且覆盖真重启、同版本改写 409、在飞节点仍 verifying、弱证据收口被拒。

待签状态（不计缺陷）：docs/gates/G2.md 的 artifact 仍是旧锚。记录值与当前 HEAD 实算值如下：

| 锚点 | 记录值 | 当前 HEAD 实算值 |
| --- | --- | --- |
| candidate_hash | f11d0fb8751ce561df6d24379ad083f12c4bc60c866f87ec7f523858e32c0af8 | 9674bc6167a49fbb9f7ea9b498fc691db512e250ac1a4cda4c190e244c7bceeb（57 个路径） |
| change_scope_hash | 33a82c417c33b950fe40f332f398018a29eebf5f2ed1242bb3772064f9626927 | fc570cab664365d4347ac5e009be3cb3a10f11f87567c71640d5ec881788f63c |
| evidence_index_hash | bcaaaa3e85d1dea69d323c9a03040f0bc7586445d5d833169b3768ac487b6347 | 106e1c362e7d4312e647580a99b3cfc01eb604546af9fd42167af4bbce6b8fd0 |
| invariants_hash | 77708d4b54f29a676481b6c2755a241171c2cfab1231ef6e621f184fc68cedd5 | 925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304 |
| artifact_hash | b5615b8b5725c5b2df88b9231b13885635940ef7db9f7fe802bc162c651c7a0a | ea3dff4caa8de38d5336388e32eb4af4867998308a28a6b010d180d8d85c291a |
| body_hash | ef21bb456813786ab878abae2824a873f6e7d470e257d2bcadfb9eb73282dfd3 | 95eed39b14eff54db8d92db68e6015a7175b93222f934d54edb4e91c5f5bb01e |

重签时不能只补四个哈希：audit_round、audit_report、audit_report_sha256、artifact_hash、body_hash 也要一起更新。本轮报告结论为 fail，不能作为 G2 的 pass 锚；必须先修完 P1-1，再出一份结论为 pass 的下一轮报告，才能重签。

### 3.3 工作流定义跨重启（P1-1）

代码链已实际接上：

- src/service/workflows.ts:18-41：WorkflowCatalog 可持有 db，hydrate 从 workflow_versions 读回定义，逐条过 assertDefinitionAllowed、比对 content_hash，再装回内存。
- src/service/workflows.ts:43-70：load 先查 workflow_versions 里同版本的定义，content_hash 不同即抛 WORKFLOW_VERSION_IMMUTABLE；内存里已有同版本且哈希不同也拒；新版本才落库。
- src/infra/sqlite/migrations/004_workflow_versions.sql：建 workflow_versions（version、content_hash、definition_json、created_at），并给 runs 加 workflow_definition_hash。
- src/index.ts 启动装配：new WorkflowCatalog(phase, db) 后调用 catalog.hydrate()，不是只建空目录。
- src/service/runs.ts:52-61：建 run 时写 definitionHashOf(def)。
- src/service/commands/apply-report.ts:96-113：先拒绝 workflow_version / workflow_definition_hash 为 null 的 run，再在 policyFor 之前比对 catalog.definitionHash(run.workflow_version) 与 runs.workflow_definition_hash，不符抛 WORKFLOW_VERSION_IMMUTABLE。

G2-15 证据是真正的端到端：同一个库起两次服务，第一次建 run 并报 started+verifying，close；第二次 hydrate 后同版本改写 409，在飞节点仍 verifying，弱证据收口被 verification_too_weak 拒。字节可复现（2.5）。

测试层缺口：tests/workflows.spec.ts:45-55 的“跨重启”用例仍在同一个 open db 上 new 第二个 WorkflowCatalog 后 hydrate，没有 close 后 reopen；tests/runtime.spec.ts、tests/apply-report.spec.ts、tests/routes.spec.ts 也没有“真重启 + 同版本改写后收口”的自动化用例。G2-15 证据锚定了行为，但静态证据不会在代码回归时自动变红。这是 P2-3。

### 3.4 上一轮其余项

- action_timeout 执行路径：src/executor/run-node.ts:144 取 p.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS（120000）；:155-158 每个工具前算 remaining，用光就 markBlocked('action_timeout') 并抛 OPERATION_TIMEOUT；:173 单工具 timeout 取 min(tool.timeoutMs, remaining)。执行器内部确实接了超时。
- action_timeout 配置链：execution.action_timeout_ms 只在 src/core/config.ts:40 定义；全仓没有生产调用方把它传给 runNode。rg -n "actionTimeoutMs" src 只命中 src/executor/run-node.ts:32,144，rg -n "action_timeout_ms" src 只命中 src/core/config.ts:40。server.ts 路由、src/index.ts、dispatcher.ts 都不传，实际恒用 120000。G2.md:17 写“动作总时限读 execution.action_timeout_ms”，与当前代码不符。这是 P2-1。
- lease_lost：src/executor/run-node.ts:75-90 续租失败记 leaseState.lost 并 appendNodeRunEvent('lease_lost')；:223-225 动作结束后若 lost，markBlocked('lease_lost') 并抛 LEASE_EXPIRED。代码路径存在，但 tests/ 没有 runNode 执行期续租失败的用例。这是 P2-2。
- deny：src/executor/tools.ts:43-56 的 assertToolsAuthorized 先查 deny（FORBIDDEN），再 registry.require（TOOL_NOT_REGISTERED），再查 allow；deny 优先成立。tests/session.spec.ts:23-25 只测 resolveToolSet 的 allow 减 deny；tests/production-path.spec.ts:108-135 只覆盖 allow 不含、allow 空、未注册，没有 deny 命中的 runNode/HTTP 端到端。这是 P2-2。
- 工具授权只认工作流定义：成立。src/executor/run-node.ts:57-65 从 policyForNodeRun 取定义策略，node_id 以账本为准；server.ts 的 /v1/runs/dispatch 不传 body.toolPolicy，/v1/node-runs/run 的 tools 只是被检查的请求集，不能覆盖 policy。
- 证据换绑：成立。scripts/gate-check.ts:265-274 固定 id 到 file、只读 HEAD 字节、重算 sha256，并要求每个固定 id 都出现在 evidence-index。
- 审计报告路径/字节绑定：路径白名单、目录白名单、HEAD、轮次、sha256 都成立；结论解析残留见 P1-1。
- 前序门链：scripts/gate-check.ts:467-471 只从上一道门的 HEAD 文本里正则取 artifact_hash 字符串，与 previous_artifact_hash 比；没有重算上一道门的 artifact canonical hash 或 body_hash。仍是不重算的旧 P2，见 P2-4。
- 非空请求 args：src/executor/run-node.ts:178-180 对非空 tool.args 用请求里的 args 算期望 commandHash，而 ReadOnlyToolRunner 实际按 registry descriptor.command.args 执行；两者不一致时 fail-closed 成 VERIFICATION_TOO_WEAK，不是绕过，但功能口径不一致。这是 P2-5。

## 四、问题清单

### P1-1（重大）审计结论解析仍可把 fail 报告读成 pass

位置：scripts/gate-check.ts:480（正则），:478-485（逐行收集），:487（唯一性判断）。

复现一：

    D:/NodeJs/node.exe --input-type=module -e "const {auditConclusionOf}=await import('./scripts/gate-check.ts'); console.log(auditConclusionOf('结论：通过率 60%，未达门槛'))"

实测输出：pass。一个明确说“未达门槛”的 fail 报告，被读成 pass。

复现二（代码块）：

    D:/NodeJs/node.exe --input-type=module -e "const {auditConclusionOf}=await import('./scripts/gate-check.ts'); const f=String.fromCharCode(96).repeat(3); console.log(auditConclusionOf(['## 正文','本报告结论：fail',f,'结论：pass',f].join(String.fromCharCode(10))))"

实测输出：pass。真实结论不在行首时，代码块里的示例行“结论：pass”会被当作全文唯一结论。

为什么是问题：

- 正则结尾只排除 ASCII 字母，不要求结论 token 后就是行尾；“通过率”以中文字符开头，“pass 的…”以空格开头，都能通过。
- 解析器没有跳过 fenced code block，代码块里的示例也会被计入。
- found.size === 1 只防止两个不同结论并存，不能防止“唯一但错误”的结论。
- 后果是门可以拿一份实际上判 fail 的报告去支持 G2 的 pass 结论，正好是第六轮 P0-1 要堵的口子。

建议修法：结论 token 后要求行尾（允许尾随标点或 **），并跳过 fenced code block；再加一个“结论：通过率 60%，未达门槛”和代码块场景的回归用例。

### P2-1（不阻断）action_timeout 配置链未接生产路径

位置：src/executor/run-node.ts:144、:155-158；src/core/config.ts:40；docs/gates/G2.md:17。

复现：

    rg -n "actionTimeoutMs" src
    rg -n "action_timeout_ms" src

实测：前者只命中 src/executor/run-node.ts:32,144；后者只命中 src/core/config.ts:40。没有任何生产调用方把配置值传给 runNode。

为什么是问题：执行器内部有超时逻辑，但配置 execution.action_timeout_ms 实际不生效，生产恒用 120000；G2.md:17 声称“动作总时限读 execution.action_timeout_ms”，与代码不符。默认值下行为碰巧一致，改配置时就会失真。属 P2，不影响本次致命/重大判定。

### P2-2（不阻断）lease_lost、action_timeout、deny 的执行期测试缺口

位置：src/executor/run-node.ts:75-90、:223-225；src/executor/tools.ts:43-56；tests/session.spec.ts:23-25；tests/production-path.spec.ts:108-135；tests/integration/g2.spec.ts:192-205。

复现：

    rg -n "lease_lost|action_timeout" tests

实测：只命中 tests/config.spec.ts:11 与 tests/migrate-s2.spec.ts:32,94 的配置字段，没有 runNode 执行期 lease_lost/action_timeout 用例。deny 只有 resolveToolSet 的单测与 allow 缺省的 HTTP 用例，没有 deny 命中的 runNode/HTTP 端到端。

为什么是问题：三条路径都在代码里存在，但回归保护不足；后续改动可能静默破坏 lease_lost 收口、动作超时或 deny 优先。属 P2。

### P2-3（不阻断）工作流真重启只有证据，没有自动化用例

位置：tests/workflows.spec.ts:45-55；tests/runtime.spec.ts、tests/apply-report.spec.ts、tests/routes.spec.ts。

复现：

    D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/workflows.spec.ts

实测：6 例全绿；但“跨重启”用例在同一个 open db 上 new 第二个 WorkflowCatalog 后 hydrate，没有 close 后 reopen，也没有在飞 run 的收口断言。G2-15 证据是端到端的，但它是静态文件，代码回归不会自动让它变红。

为什么是问题：跨重启不可变是本轮 P1-1 的核心，自动化层只覆盖了内存目录重建，未覆盖真实重开库。属 P2。

### P2-4（不阻断）前序门链不重算上一道门的密码闭合

位置：scripts/gate-check.ts:467-471。

复现：读该函数可见它只做 /artifact_hash=([0-9a-f]{64})/ 取字符串并与 previous_artifact_hash 比。

为什么是问题：上一道门的 artifact 内容、artifact_hash、body_hash 没有被重新计算；当前门只信上一道门文本里的一个字符串。要伪造就同时改上一道门和当前门的 previous_artifact_hash，虽然还要过当前门的审计锚，但这不是密码学闭合。属 P2。

### P2-5（不阻断）非空请求 args 与 registry args 的 commandHash 口径不一致

位置：src/executor/run-node.ts:178-180。

复现：构造一个 tool.args 非空且与 registry descriptor.command.args 不同的 runNode 请求，执行器按请求 args 算期望哈希，runner 按 registry args 执行，最终 fail-closed 为 VERIFICATION_TOO_WEAK。

为什么是问题：不是授权绕过，但正常请求只要带了非空 args 就可能被误拒；执行与校验的口径应统一。属 P2。

### P2-6（不阻断）WorkflowCatalog 仍保存调用方引用，加载失败会留半套状态

位置：src/service/workflows.ts:52-59（内存先 remember 再落库）、:104-114（先 set 再校验别名、直接保存 def 引用）、:43-47（未校验 workflow_version 的键类型）。

复现：

    D:/NodeJs/node.exe --input-type=module -e "const {WorkflowCatalog}=await import('./src/service/workflows.ts'); const d={workflow_version:'1',pass_conditions:[{path:'evidence.exitCode',op:'eq',value:0}],nodes:[{node_id:'check',type:'agent',tools:{allow:['ro.echo'],deny:['ro.rm']}}]}; const c=new WorkflowCatalog('S2'); c.load(d); const h1=c.definitionHash('1'); d.pass_conditions[0].value=99; console.log('mutated='+(h1!==c.definitionHash('1'))+' value='+c.policyFor('1','check').passConditions[0].value)"

实测：mutated=true value=99。load 后 catalog 内的定义随调用方对象一起变。

另一个复现：先 load 版本 1，再 load 一个版本号为 01、内容不同的定义，别名检查抛 WORKFLOW_VERSION_IMMUTABLE 后，get('01') 仍能拿到刚被拒绝的定义（实测 leaked=ro.echo）。

为什么是问题：Catalog 是“不可变定义”的边界，却把调用方对象引用直接存进内存；调用方在 load 后改对象就能改内存里的判定条件和 definitionHash。加载失败也会留下已写入的键。当前主要表现是 fail-closed（在飞 run 的收口哈希会对不上），不是稳定绕过，但这是上一轮已列的防御性缺口，属 P2。

## 五、待签状态与重签提醒

- G1/G2 当前未重签，gate-check 集成用例 10 红是预期状态，不作为 fail 依据。
- G2 artifact 仍是 audit_round=4、audit_report=docs/audits/S2-independent-audit-round4.md、audit_report_sha256=64 个 0；四个哈希与 artifact_hash、body_hash 都是旧值（见 3.2 表）。
- 当前 HEAD 的实算值已列在 3.2。重签时六处一起改，并把 audit_round 改为下一轮、报告指向一份结论为 pass 的审计报告。
- 本轮报告结论是 fail，不能作为 G2 的 pass 锚。必须先修 P1-1，再进入下一轮独立审计。

## 六、结论

致命 0 / 重大 1 / 不阻断 6。

结论：fail
