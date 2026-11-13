# S2 执行器/服务与 G2 门第十三轮独立审计

门：G2
候选提交：9a44739c0d7c5a158c4dca4cab7ebe201d704966

- 审计对象：HEAD 9a44739c0d7c5a158c4dca4cab7ebe201d704966（短哈希 9a44739），提交信息 "Close hidden audit conclusions and migration gaps"
- 审计范围：S2 执行器与服务、G2 门记录、19 份证据、门脚本、相关测试与迁移
- 审计方式：只读主仓库源码、证据与门记录；攻击复现、模拟重签与全量测试在仓库外临时 clone 中进行；主仓库未修改源码，未签 G1/G2
- 审计时间：2026-11-13

结论：fail

## 总览

P0=0，P1=1，P2=9（仍存；P2-9 已修复，单列，不计入这 9 条）。

G2 的 19 项必过、19 份证据、正文证据表、evidence-index 与 11 条不变量结构完整；19/19 证据按 HEAD 的 LF 字节重算 sha256 与记录一致；候选清单 61 个文件与记录一致；ev-g2-01..15 与 G-03/04/05/07 共 23 次复跑全部 exit 0、字节与 sha256 稳定；签后 tsc 0 错、全量 vitest 306 例 0 失败。门机制的主要链路没有因本轮改动回退。

本轮仍判 fail 的原因是一条可复现的解析绕过：scripts/gate-check.ts 的 stripHiddenAuditBlocks 无条件剥掉整个 details/pre/script/style/template 块，连 details open 的展开内容和 summary 也一起剥掉，且不识别 div 的 hidden/display:none。于是报告里可以同时存在两条人眼可见的结论——details open 内是 fail、块外是 pass——解析器只读到 pass，sign-gate 与 gate-check 都能 exit 0。这违反全文只能有一条顶层可见结论的契约，属于签门绕过，定 P1。第十二轮的九条 P2 中，P2-9 已在本轮 HEAD 修好；P2-1..P2-8 仍存；另新增 P2-10（签后改证据可重签通过，证据内容不受审计绑定的跨提交保护）。

主仓库当前仍是预签态：直接跑 gate-check 会 exit 1，首条是审计报告 sha256 与记录不符（0000… != c9cef2e4…）。这是签前事实，不作为本轮缺陷。

## 一、审计对象与预签状态

- 主仓库 HEAD 与任务给定一致，审计开始时工作树干净，只有未跟踪的 docs/audits/S1-independent-audit-round10.md；审计报告写入后，本报告也是未跟踪文件。审计期间主仓库出现了未提交的 scripts/gate-check.ts 与 tests/gate-check.spec.ts 改动（非本审计写入，属并行修复）；本报告只针对 HEAD 9a44739，不把这两处工作树改动纳入结论。
- G2.md 的 artifact 仍是预签值：audit_round=4、audit_report=docs/audits/S2-independent-audit-round4.md、audit_report_sha256 为 64 个 0；正文 artifact_hash=b5615b8b…、body_hash=ef21bb45… 是旧值；previous_artifact_hash=1ce80f60… 与预签 G1.md 的 artifact_hash 相同。
- 直接跑 D:/NodeJs/node.exe --no-warnings --experimental-strip-types scripts/gate-check.ts docs/gates/G2.md，exit 1，首条输出：门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != c9cef2e419c91711…。
- 该失败由预签字段导致，不是机制缺陷；本轮结论不拿它当依据。所有签门验证都在 clone 中完成。

## 二、G2 结构复核

- 19 项必过项与 GATE_SPECS.G2.items 固定清单完全一致，顺序为 G2-01..G2-07、G-03、G-04、G-05、G-07、G2-08..G2-15；19 项 result 均为 pass 且都有 evidence_ids。
- 19 份证据 id 与文件路径的固定映射一致：ev-g2-01..15、ev-g2-g03、ev-g2-g04、ev-g2-g05、ev-g2-g07；磁盘 docs/gates/evidence/G2 恰好 19 个文件，集合一致，无换绑、无缺行。
- 正文证据表 19 行、evidence-index 块 19 条、artifact.evidence 19 项三处同源；正文必过项表 19 行与 artifact 的顺序、内容、结果、证据一致；11 条不变量 I1–I11 的正文表与 invariants 块一致，statement、evidence_ids、id 集合均与 spec.invariants 相同。
- 19/19 证据按 HEAD 的 LF 归一字节重算 sha256 与 G2.md:68-88 记录逐项一致，mismatch=[]。
- 候选清单 61 个文件；candidate_hash 与 change_scope_hash 可按 G2 spec 重算，签后值与重算值一致。
- G2 spec 的 scopeBase=4f3ada7，excludes 为 docs/gates、docs/audits、docs/reviews、handoff.md；这个排除范围对 P2-10 有直接影响。

### 八个锚的预签值与签后值

| 锚 | 预签记录或正文 | 签后（阳性对照） |
| --- | --- | --- |
| artifact_hash | b5615b8b5725c5b2df88b9231b13885635940ef7db9f7fe802bc162c651c7a0a | fb5972df03075dbfcfa4b27f7becd469fce3cbd2bf7a9a3f4e2997205e9263dd |
| body_hash | ef21bb456813786ab878abae2824a873f6e7d470e257d2bcadfb9eb73282dfd3 | 808f1dafd62a918e6c12abdde4b4137542d0b66add9ce3a4ff7cbeedb577f340 |
| evidence_index_hash | bcaaaa3e85d1dea69d323c9a03040f0bc7586445d5d833169b3768ac487b6347 | 106e1c362e7d4312e647580a99b3cfc01eb604546af9fd42167af4bbce6b8fd0 |
| invariants_hash | 77708d4b54f29a676481b6c2755a241171c2cfab1231ef6e621f184fc68cedd5 | 925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304 |
| candidate_hash | f11d0fb8751ce561df6d24379ad083f12c4bc60c866f87ec7f523858e32c0af8 | 60820bf84e902dbf497a700f3842b38137b7d1136c8b2cf6622c2f17ac4a83ae |
| change_scope_hash | 33a82c417c33b950fe40f332f398018a29eebf5f2ed1242bb3772064f9626927 | 899370b0d3164da1b8cb2b8a104b615a6e9de42d3f448b4381ff54da60a96aeb |
| previous_artifact_hash | 1ce80f6080fb2271ae7ba958c61127962951cb49262b75e5b1d8e7d161b82084 | f7df81f1dd0e4028b89e33c57216e9937f1df7ddaf9ed489f0aee3cad5bddbca |
| audit_report_sha256 | 0000000000000000000000000000000000000000000000000000000000000000 | 6f45ae944efcb5f80dd560fbc6279cd569d314081f871c9b135852f0c7899a8c |

预签记录里的 candidate_hash 与 change_scope_hash 是旧值，但按 HEAD 重算的实际值与签后值一致；这不是本轮缺陷。签后值来自 clone 中的阳性对照状态，见第四节。

## 三、G2 证据复跑

复跑命令统一为 D:/NodeJs/node.exe --no-warnings --experimental-strip-types scripts/fault-inject.ts --case <ID>；每次重跑后按工作树文件的 LF 归一字节重算 sha256，再与门记录比对。结果文件在 D:/aboutAI/_audit_s2_round13/evidence-rerun.json。

| 用例 | 次数 | 复跑 sha256（LF） | 结果 |
| --- | --- | --- | --- |
| ev-g2-01 | 1 | f10efac98f2d0d91bfc83d0e1bacb3c2a5111c11bc7223de6464a057a744d88b | exit 0，match |
| ev-g2-02 | 1 | 346af5813c653ba967af948a74aba27201b9ac906f13e54f4e588f8b18ea70e1 | exit 0，match |
| ev-g2-03 | 1 | 784e44b65d6642404d0f7664bda64e48337292101a102f1403aef4caee4a6db5 | exit 0，match |
| ev-g2-04 | 1 | 65946e22958ef8764415d2af693245f8dc8da33e585ba4cee094e36f56ac71a6 | exit 0，match |
| ev-g2-05 | 1 | 74c0a94705a24494d435c995317d6a29f40e089a992e9c75afa5e0735b35adb1 | exit 0，match |
| ev-g2-06 | 1 | cef5cf3de601985af216cb935334414d56ff9f3f296871f709332f9e16b1f91c | exit 0，match |
| ev-g2-07 | 1 | 607471ff9e475eaa30e3a83376b4c93aed12b6e209b7bd2601678737cf934a34 | exit 0，match |
| ev-g2-08 | 1 | 54e4b0e8415abd5bc65ce885c407245d91ec099390e64a2b3188c89cb1144cbf | exit 0，match |
| ev-g2-09 | 1 | f43b50982b67843db87e1cae9b36b0048eca372d9734904d3e1090fc97b8d8b2 | exit 0，match |
| ev-g2-10 | 1 | 76b458edf0f4f24a4408be4bf429b4a9025399aa002c52b6c50676a5f4f45e8b | exit 0，match |
| ev-g2-11 | 1 | 05c1c8ea1ab5796a24adc50931a3a1b3d6d085af56975b47f6c9a113f7f233c7 | exit 0，match |
| ev-g2-12 | 2 | 5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe（两次同值） | exit 0，match |
| ev-g2-13 | 2 | a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc（两次同值） | exit 0，match |
| ev-g2-14 | 2 | 865fd0b7bca1193256dedee74f30a18c8903f5e0fa4c2d119cad6e41b50ada02（两次同值，约 3.2s） | exit 0，match |
| ev-g2-15 | 2 | db1c814f8935e1779440aec12c5a229a6ec8636a0e6ccc7f86d2ac834e037038（两次同值） | exit 0，match |
| G-03 | 1 | 514f9754fda67b8e1522d086fc6079301e00bd0185f9cca6dddec502c412ab70 | exit 0，match |
| G-04 | 1 | fb68366d1292bb80e9ae59febf7fd5ad1e28e580ecfc2883e99b18edb2e6eca9 | exit 0，match |
| G-05 | 1 | 2f7da35abe9c1484143b85a0226da8a0ebd095994c8e2aa492dd88f726b51904 | exit 0，match |
| G-07 | 1 | 8898db1323c191c8ca0acd51d2dde5458355b7b25f3b0c96f868ec38d8ef730e | exit 0，match |

23 次全部 exit 0，unstable=0。ev-g2-15 的跨重启用例仍 exit 0，traceBindingGate 与 applyReport 证据门没有因本轮 gate-check 隐藏块扫描、事件表 005 触发器、迁移缺号校验的改动回退；ev-g2-15 的「同进程关开而非独立 OS 进程」问题仍按 P2-8 记录。迁移缺号校验由 tests/migrate.spec.ts 与 tests/migrate-s2.spec.ts 覆盖，事件表 005 触发器由 tests 与 G-03/04/05 的相关用例覆盖；全量 vitest 见第四节。

## 四、模拟重签与测试（阳性对照）

本轮审计结论是 fail，这份报告不能用于签门。按任务要求，在 clone 中另写两份只用于机制测试的阳性对照报告，均绑定门与候选 9a44739，正文明确写「只用于机制测试，不是独立审计结论」，唯一可见结论为 pass：docs/audits/S1-round13-positive-control.md 与 docs/audits/S2-round13-positive-control.md。先用 S1 对照签 G1，再用 S2 对照签 G2；G1 必须先签，因为全量 vitest 的 gate-check.spec 会读 G1 门记录。

签门步骤（clone 内）：

~~~text
D:/NodeJs/node.exe --no-warnings --experimental-strip-types scripts/sign-gate.ts docs/gates/G1.md
git add docs/gates/G1.md && git commit -m "sign G1 positive control"
D:/NodeJs/node.exe --no-warnings --experimental-strip-types scripts/sign-gate.ts docs/gates/G2.md
git add docs/gates/G2.md && git commit -m "sign G2 positive control"
D:/NodeJs/node.exe --no-warnings --experimental-strip-types scripts/gate-check.ts docs/gates/G1.md
D:/NodeJs/node.exe --no-warnings --experimental-strip-types scripts/gate-check.ts docs/gates/G2.md
~~~

运行记录：

- G1：13 项必过 / 13 份证据，sign-gate exit 0，gate-check exit 0；artifact_hash=f7df81f1dd0e4028b89e33c57216e9937f1df7ddaf9ed489f0aee3cad5bddbca，body_hash=e39f7f163e27218406d7c236e9430e9afb12723d5e529f9e36757ca989d800d7，candidate=40e019a1d2b3e000c059f6b021cf6460c174adf9d2f899de2bb6b08481114e34。
- G2：19 项必过 / 19 份证据，sign-gate exit 0，gate-check exit 0；artifact_hash=fb5972df03075dbfcfa4b27f7becd469fce3cbd2bf7a9a3f4e2997205e9263dd，body_hash=808f1dafd62a918e6c12abdde4b4137542d0b66add9ce3a4ff7cbeedb577f340，candidate=60820bf84e902dbf497a700f3842b38137b7d1136c8b2cf6622c2f17ac4a83ae，previous_artifact_hash=f7df81f1dd0e4028b89e33c57216e9937f1df7ddaf9ed489f0aee3cad5bddbca，audit_report_sha256=6f45ae944efcb5f80dd560fbc6279cd569d314081f871c9b135852f0c7899a8c，audit_round=13。
- 签后 tsc --noEmit exit 0；全量 vitest 32 个文件 / 306 例全过，0 失败；gate-check.spec 43 例全过，包含 G1 门记录、CRLF 与 audit_round 用例。

这些数字只证明签门与测试链路在当前 HEAD 上能跑通，不是本轮审计结论。本轮真实审计报告是 fail，没有也不会写入 clone 的门记录；G2 的 fb5972df… 只属于阳性对照状态。

## 五、P1

### P1-1 details open、summary 与 div hidden 的可见性绕过，让可见 fail 报告签成 pass

- 位置：scripts/gate-check.ts:533-553（auditConclusionOf）、scripts/gate-check.ts:571-608（auditTopLevelLines）、scripts/gate-check.ts:617-663（stripHiddenAuditBlocks，关键正则 :637）。
- 根因：stripHiddenAuditBlocks 的标签正则只认 details、pre、script、style、template，匹配后按 depth 把整块内容替换为空白。它不检查 details 的 open 属性，也不单独保留 summary；summary 在 HTML 里始终可见，details open 的内容默认展开可见。div 的 hidden 属性与 style="display:none" 也不在识别范围内，反而被当成可见内容。
- 可利用形态一：报告正文里放一个 details open，内容中有一行可见的 fail 结论；块外再放一行可见的 pass 结论。解析器把 details 整块剥掉，只读到块外的 pass；auditConclusionOf 返回 pass，sign-gate exit 0，gate-check exit 0。实测攻击用例 details-open-fail-then-pass：artifact_hash=b0330f2229b0…，audit_round=97，audit_report=docs/audits/attack-round97.md，audit_report_sha256=c82b6d0bc75be37175e883b3b8b6d435ca5d5a77a073654738462acfb5006cf8，sign-gate 输出「重签完成：证据 19 份…改动文件 61 个」。
- 可利用形态二：details 的 summary 里放可见 fail，块外用 div hidden 放 pass。summary 被人眼看到的是 fail，解析器把 summary 和整个 details 一起剥掉，只剩 div 里的 pass，签门同样 exit 0。
- 可利用形态三：div hidden 或 div style="display:none" 里放唯一的 pass；人眼看到的是隐藏内容，解析器却把它当可见结论，签门 exit 0。
- 最小复现解析（不签门，直接调 auditConclusionOf）：

~~~ts
const t = [
  'title',
  '门：G2',
  '候选提交：' + commit,
  '<details open>',
  '结论：fail',
  '</details>',
  '结论：pass'
].join('\n');
console.log(auditConclusionOf(t)); // 实际输出 pass
~~~

- 端到端最小复现：在 clone 的 HEAD 9a44739 上写一份含上述两行结论的报告到 docs/audits/attack-round97.md，把 G2.md 的 audit_round 改成 97、audit_report 指向该文件，提交；跑 scripts/sign-gate.ts docs/gates/G2.md（exit 0）；提交后跑 scripts/gate-check.ts docs/gates/G2.md（exit 0）。原始攻击脚本在 D:/aboutAI/_audit_s2_round13/attacks.cjs 的 details-open 用例，另有 D:/aboutAI/_audit_s2_round13/attack-details-open.cjs。
- 影响：门检查的核心契约是「全文只能有一条顶层可见结论」（scripts/gate-check.ts:530-532、:539-540）。现在一份人眼可见 fail 的报告可以被机器读成 pass 并签过，门记录会把 fail 结论的审计报告与 pass 门绑在一起。这是签门绕过，不是显示问题。
- 修复方向：把 details 的可见性拆开处理——summary 始终按可见文本扫描；details 无 open 时只隐藏其非 summary 内容；details open 的内容按可见处理；div[hidden]、div[style*=display:none] 按隐藏处理。无法可靠判定可见性时 fail-closed，拒绝整份报告，而不是默认可见或默认隐藏。修完后应把 details-open、summary-fail+div-pass、div-hidden-only 三例加入 tests/gate-check.spec.ts，并重跑本报告的攻击脚本。

## 六、P2

### P2-1 action_timeout 仍未接生产，门正文两处口径不一致

- 位置：src/service/dispatcher.ts:43-54、src/index.ts:87-98、src/executor/run-node.ts:144、src/core/config.ts:40、docs/gates/G2.md:17、docs/gates/G2.md:55。
- 现象：runNode 支持 actionTimeoutMs，但 dispatcher 与 index 的生产装配都不传；运行时永远落到 DEFAULT_ACTION_TIMEOUT_MS=120000（src/executor/run-node.ts:32-38）。execution.action_timeout_ms 只有配置校验，没有生产调用方。G2.md:17 写「配置接线留 S3（本轮只有默认值生效）」，G2.md:55 的定值表仍列 execution.action_timeout_ms=120000，两处口径不一致。
- 复现：在 src/service/dispatcher.ts:43-54 与 src/index.ts:87-98 检索 actionTimeoutMs，0 命中；把配置文件 execution.action_timeout_ms 改为 1000，派发一个 3 秒动作，动作仍按 120 秒额度执行，不会在 1 秒时 markBlocked('action_timeout')。
- 影响：运维改配置不会改变动作总时限，配置项产生虚假安全感；门正文的定值表与实现不一致。属 S3 接线债，不阻断本轮。

### P2-2 lease_lost 与 action_timeout 缺执行期回归

- 位置：src/executor/run-node.ts:75-91、src/executor/run-node.ts:144-159、src/executor/run-node.ts:223-227、tests/。
- 现象：实现有续租失败写 lease_lost、动作额度耗尽 markBlocked('action_timeout') 并抛 OPERATION_TIMEOUT、租约丢失后拒收 done 的分支，但全仓测试没有真正让续租失败或让动作额度耗尽的用例。lease_lost 在 tests 下 0 命中；action_timeout/OPERATION_TIMEOUT 只出现在配置、迁移与错误映射用例（tests/config.spec.ts:11、tests/errors.spec.ts:41、tests/migrate-s2.spec.ts:32/94）。
- 复现：rg -n "lease_lost|OPERATION_TIMEOUT|action_timeout" tests 只得到上述配置/迁移/错误映射命中；没有 runNode 级别的失败注入。
- 影响：长动作与租约围栏的关键收口缺回归，后续重构静默改坏也不会被测试发现。

### P2-3 节点 done 后不释放租约

- 位置：src/service/commands/lease.ts:102-112、src/service/commands/apply-report.ts:274-298、docs/gates/evidence/G2/ev-g2-14.md:37。
- 现象：releaseLease 已实现但 src 内没有调用方；done 收口没有调用 releaseLease，租约字段保留。ev-g2-14 的恢复后账本片段里节点已 done、revision=9，lease_expires_at 仍是 2026-11-13T03:00:04.000Z；节点事件以 report_applied 结束，没有 release 事件。
- 复现：重跑 D:/NodeJs/node.exe --no-warnings --experimental-strip-types scripts/fault-inject.ts --case ev-g2-14，看「恢复后账本片段」的 node_runs 行与节点事件；或完成一次正常 done 后查 node_runs.lease_expires_at。
- 影响：终态节点保留过期租约字段，账本可读性变差，外部巡检容易把终态节点误读成仍被占用；不影响状态机正确性。

### P2-4 acquireLease 不校验调用方 attempt

- 位置：src/service/commands/lease.ts:34-39、src/service/commands/lease.ts:48-83、src/executor/run-node.ts:101-115。
- 现象：AcquireLeaseParams 只有 nodeRunId、ownerEpoch、leaseTtlMs、now；acquireLease 不接收也不比对调用方声明的 attempt，CAS 使用库里的 row.attempt。runNode 的 p.attempt 只在后续 started 迁移与 report 里使用。
- 复现：对一个当前 attempt=1 的 queued 节点，用同一个 nodeRunId 从旧调用方（自认为 attempt=0）发 lease 请求；租约仍会按库里的 attempt=1 领取。随后旧调用方的 started 迁移会因 attempt 不符被拒，但租约已经被领走。
- 影响：错代调用方可以短暂占住租约，增加无谓重试与诊断噪声；写权限仍由后续 CAS 与状态机拦住，未升级为 P1。

### P2-5 traceBindingGate 只绑 exitCode/stdoutHash，不绑 tool/commandHash

- 位置：src/service/commands/apply-report.ts:303-311、src/service/commands/apply-report.ts:314-323、src/core/policy.ts 的 ALLOWED_EVIDENCE_FIELDS。
- 现象：done 收口时系统证据门只要求 source==='run_tool' 且 exitCode===0；traceBindingGate 只 SELECT exit_code, stdout_hash，再按这两值匹配。报告里的 tool 名与 commandHash 不参与绑定，tool_executions 里已有的 tool/command_hash 列也不读。
- 复现：在同一 node_run_id+attempt 下，直接写一条 tool_executions（exit_code=0、stdout_hash 与报告一致，但 tool/command_hash 指向另一个命令），再提交 done 报告；收口会通过。经 HTTP 报告入口无法插入这条行，故利用面要求账本写权限或执行器被替换。
- 影响：证据只能证明「这个 attempt 有一条成功 stdout 哈希相同的执行」，不能证明「它是被授权的那个工具与命令」；与 G2-10/G2-12 声称的强绑定有差距。属 P2，因为正常生产路径由 runNode 写入且 commandHash 已在执行期校验。

### P2-6 checkPreviousChain 只比字符串，不重算前序门

- 位置：scripts/gate-check.ts:514-528。
- 现象：前序门链校验从 HEAD 的 G1.md 里抓第一个 artifact_hash 字符串，与 G2 的 previous_artifact_hash 比对；不重算 G1 的 artifact，也不对 G1 跑 verifyGateRecord。
- 复现（本轮实测）：在 clone 建 signed-state 分支，把 docs/gates/G1.md 的 artifact_hash 文本从 f7df… 改成 c 重复 64 位的字符串，提交；跑 sign-gate G2，exit 0，G2 的 previous_artifact_hash 变成 c…；提交后跑 gate-check G2，exit 0；同一状态跑 gate-check G1，exit 1，报「artifact_hash 与正文不符：cccc… != f7df81f1…」。随后 git reset --hard signed-state，clone 回到 e27b205，G1/G2 gate-check 均 0。
- 影响：前序门链是「文本相等」而非「内容哈希相等」，前序门被改后只要同步改链值就能接受；当前 G1 仍有人工评审与 G1 自身门检查兜底，属 P2。

### P2-7 WorkflowCatalog 先写内存后写库，别名冲突会留脏缓存

- 位置：src/service/workflows.ts:104-113、src/service/workflows.ts:43-70。
- 现象：remember 先在 src/service/workflows.ts:105 this.defs.set(key, def)，再在 109-111 对纯数字键做别名（01→1）；别名冲突抛 WORKFLOW_VERSION_IMMUTABLE 时，主键已留在内存。load 也是先 remember，再在 :61-68 做 DB INSERT。
- 复现（本轮实测）：运行 D:/aboutAI/_audit_s2_round13/repro-workflows.ts（import clone/src/service/workflows.ts）。先 load workflow_version='1'，再 load 内容不同的 '01'；抛「版本号别名撞上了另一份定义」；随后 c.get('01') 仍返回被拒定义，pass_conditions=[{"path":"evidence.exitCode","op":"eq","value":99}]，cachedKeys=[["1","1"],["01","01"]]。
- 影响：内存里可能短暂存在未被数据库确认的定义，跨重启不变量在别名冲突边界上不成立；正常版本号路径不受影响。

### P2-8 跨重启证据是同进程关开服务，不是独立 OS 进程重启

- 位置：docs/gates/evidence/G2/ev-g2-15.md:3、src/index.ts:53-54、src/service/workflows.ts:29-41。
- 现象：ev-g2-15 的参数仍写「POST /v1/workflows/load × 2（同一库重启）」；同一测试进程里连续 openServiceOrchestra 两次、第一次 close 后第二次对同一库 hydrate，没有 spawn 独立 node 进程，也没有真正的进程退出后重开。
- 复现：读 ev-g2-15 的步骤与 tests/integration/g2.spec.ts 对应用例；两次服务共享模块级状态与同一进程的 SQLite 连接生命周期。
- 影响：数据库落库与 hydrate 逻辑被覆盖，但进程级缓存、文件锁释放、崩溃恢复等真实重启面没有被覆盖；证据强度低于「跨重启」字面承诺。

### P2-9 已修复：解析器不再把行首「结果：」当结论

- 位置：scripts/gate-check.ts:536 的 strict 前缀已从「结果」移出，只保留 (?:审计)?(?:结论|判定|审计意见|最终判定|最终结论)。
- 实测：用 D:/aboutAI/_audit_s2_round13/parse-report.mjs 直接调 auditConclusionOf：
  - 「结果：fail + 结论：pass」→ conclusion=pass（「结果：」被忽略）；
  - 「结果：pass + 结论：fail」→ conclusion=fail；
  - 「审计结果：pass + 结论：fail」→ conclusion=fail。
- 第十二轮的 P2-9 不再列为仍存项。该修复只影响解析前缀，不改变本轮 P1 的结论。

### P2-10 签后改证据可重签通过，证据内容不受审计绑定保护

- 位置：scripts/gate-check.ts:186（G2 spec.excludes 含 docs/gates）、scripts/gate-check.ts:765（checkAuditAnchor 的 commit..HEAD diff 按 excludes 过滤）、scripts/sign-gate.ts:29-31（证据从 HEAD 逐份重算）。
- 现象：在一份已签的 G2 记录上，往 docs/gates/evidence/G2/ev-g2-01.md 追加一行，提交；跑 sign-gate G2，exit 0；提交后再跑 gate-check G2，exit 0。旧证据 LF sha=22ac9703da8c22285eb74f269be719f0c32c98c109b3d997aaeb2c5912284c09，新证据 sha=69856b7626f44015f00dbf4b3b6fcafa284e8c0528de9ded9192da69c9095710；audit_report、audit_report_sha256、candidate_hash 三项前后不变，新的 artifact_hash=7ae2802d899d…。
- 复现：在已签 G2 的 clone 中执行上述追加、提交、sign-gate、提交、gate-check；每一步都检查 exit code 与 G2 的审计报告字段。原始脚本在 D:/aboutAI/_audit_s2_round13/attack-evidence-rewrite.cjs。
- 影响：代码候选仍被 candidate_hash/change_scope_hash 锁住（代码改动会改变候选哈希，签门会重算；审计绑定的 commit..HEAD 也会拦住代码改动），但证据文件在 docs/gates 下，既不在候选清单也不在审计绑定的 diff 范围。审计后改证据、重签即可让未经本轮审计的证据内容进门记录。属 P2，因为要执行 sign-gate 这一受信动作，且代码未变；但它削弱了「证据内容经过审计」的保证。

## 七、攻击面与锚定顺序复核

### S1 第九轮三种隐藏 pass 形态

在 clone 中分别构造 nested-details、引用块内 4 空格缩进、一个空格加一个 Tab 缩进三种报告，每种都让唯一可见的 pass 藏在旧解析器会漏掉的位置，并同时保留一条可见 fail。结果三例全部被拒：auditConclusionOf 返回 fail 或 null，sign-gate exit 1，G2 字节未变。S1r9 的修复没有在 HEAD 回退；tests/gate-check.spec.ts 也覆盖了这三种形态。

### 本轮新攻击面

details open、details summary、div hidden、div style="display:none" 四类可见性没有在 stripHiddenAuditBlocks 里正确处理，形成 P1-1 的三种可利用形态。它们与 S1r9 的三种不同：S1r9 是「隐藏 pass 被漏读」，本轮是「可见 fail 被剥掉」和「隐藏 pass 被读成可见」。这两种方向都要按 fail-closed 处理，不能只补其中一个方向。

### 六锚、audit_report_sha256 与 previous_artifact_hash 的校验顺序

- sign-gate 在一次运行内依次从 HEAD 重算：证据表与 evidence-index、invariants_hash、candidate/change_scope、previous_artifact_hash、audit_report_sha256、artifact_hash、body_hash，最后 verifyGateRecord(selfCheck) 通过才写盘。单进程内「先改证据再改锚」不能绕过，因为最终自检会按同一份 HEAD 字节重算并比对六锚；改内存对象也会被 text.replace 的第一个匹配与后续自检拦住。
- 跨提交的缺口有两个：P2-6（previous_artifact_hash 只比 G1.md 里的字符串，不重算 G1）与 P2-10（docs/gates 证据不在审计绑定的 diff 范围，签后改证据可重签）。两者都不改变代码候选的锁定，但都让「门记录里的审计绑定」覆盖不到相应内容。
- 审计报告本身的绑定是有效的：报告必须在 HEAD、路径在 docs/audits/、文件名轮次等于 audit_round、LF sha 等于 audit_report_sha256、结论等于 artifact.conclusion、绑定门等于 artifact.gate、绑定 commit 是 HEAD 祖先，且 commit..HEAD 的候选 diff 为空。P1-1 不是这套绑定失效，而是结论解析对「可见」的判定失效。

## 八、判定

本轮 G2 不能判 pass。P1-1 是一条可复现的签门绕过：人眼可见 fail 的审计报告可以被解析成 pass 并签过，直接违反「全文只能有一条顶层可见结论」的契约。P0=0；P1=1；P2=9 仍存（P2-1..P2-8、P2-10）；P2-9 已修复，单列不计入。G2 的结构、19/19 证据、23 次证据复跑、阳性对照签门、tsc 与全量测试都没有回退，但这些不能抵消 P1-1。

建议的最小收口顺序：先修 details/summary/div 的可见性判定并补三例回归，重跑本报告的 P1 攻击脚本；再排期 P2-10 与 P2-6 的跨提交绑定，最后处理 P2-1..P2-8 的接线与回归。修复后需要重新审计本轮 HEAD 之后的提交，不能直接把本报告的 fail 改成 pass。
