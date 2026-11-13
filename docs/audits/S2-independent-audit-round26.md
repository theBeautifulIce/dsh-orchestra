门：G2
候选提交：ca2b196e351552b8a055450fb81ed6653aff2197

本报告审计 D:/aboutAI/dsh-orchestra 候选提交 ca2b196e351552b8a055450fb81ed6653aff2197 的 G2 门记录、源码、证据与可复现命令。攻击复现只在 D:/aboutAI/dsh-orchestra-audit26 临时 clone 内进行，主仓库除本文件外未改。

结论：fail

## 审计环境与复现命令

- 环境：node=D:/NodeJs/node.exe（v26.13.1），pnpm=cmd.exe /c "C:\\Users\\ASUS\\AppData\\Roaming\\npm\\pnpm.cmd"（12.3.4），仓库工作树起始干净。
- 门检查：D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md
- 类型检查：D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit
- 全量用例：D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run --reporter=dot
- 定向用例：D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/db-open.spec.ts tests/workflows.spec.ts tests/runtime.spec.ts tests/production-path.spec.ts tests/lease.spec.ts tests/sweep.spec.ts --reporter=dot
- 证据重跑：cd D:/aboutAI/dsh-orchestra-audit26，然后 D:/NodeJs/node.exe --no-warnings scripts/fault-inject.ts --case ev-g2-12（再分别跑 ev-g2-13、ev-g2-14、ev-g2-15）

实际退出码：tsc=0；定向用例 6 个文件 42 例全过，exit=0；G2 门检查与全量用例在 HEAD 的结果见 P2-3 的实测输出块（预签态，原因同 P2-3）。

## 已复核项

- G2 必过项 19 项：docs/gates/G2.md:25-45 与 artifact.must_pass_items 的编号和顺序一致，19 项 result 均为 pass；artifact.failed_items 为空。
- 证据 19 份：docs/gates/G2.md:70-88 的 19 行文件路径与 artifact evidence-index 固定映射一致；我用 git show HEAD:对应路径 逐份重算 LF 归一后的 sha256，19 份全部与表内记录一致。
- 证据索引复算：evidence_index_hash 实际为 b2f626a6fe29ffa8162859f4ff6640fc2d4258cff958884d7fa98689f8ab0b10（记录值 bcaaaa3e… 是预签态旧值）。
- 不变量 11 条：docs/gates/G2.md:115-127 与 invariants 块逐条一致；invariants_hash 实际为 925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304（记录值 77708d4b… 是预签态旧值）。
- 候选范围：4f3ada7..HEAD 共 88 个改动文件；candidate_hash=d6d7cacfe462270bed05a33d032a62e1756e214f750cae4c0e49733ff41b8941，change_scope_hash=b4811c33ac596c2580c7268812fa1e79fbe12ad2f9257bacdd8fb88fd5648778。这两个值与我用 canonicalJson 独立复算一致，并在 clone 重签后由 scripts/gate-check.ts 复核通过。
- 正文表与 artifact 同源：evidence-index、invariants、必过项正文表、例外表在 clone 重签后由 checkBodyTable / checkBodyEvidenceTable / checkBodyExceptions / checkBodyInvariants 全部通过（gate G2 通过，19 项必过、19 份证据）。
- 证据重跑：ev-g2-12 两次均为 5c2d543f…；ev-g2-13 两次均为 a5260693…；ev-g2-14 两次顺序重跑均为 4e0776e9…；ev-g2-15 两次均为 7648abe9…；ev-g2-12/13/15 各四路并发仍稳定。ev-g2-14 并发下不稳定，见 P1-1。
- 证据时间戳归一：ev-g2-14/15 全文已无 20xx-xx-xxT 形态的时间戳，运行时刻统一归一为 ts 占位符；ev-g2-14 的剩余不稳定来自 revision，不是时间戳。
- 单写者锁与 epoch：自建探针结果 {"unproven":"FORBIDDEN","secondLock":"ELOCKED","firstEpoch":1,"nextEpoch":2,"staleWrite":"STALE_GENERATION","release":"ok"}。createOrchestra 无凭证被拒；第二写者 ELOCKED；bumpEpoch 后老连接写被 STALE_GENERATION 挡住。源码位置：src/index.ts:42-49、:112-134，src/infra/lock.ts:4-6，src/infra/sqlite/driver.ts:75-92。
- 工具白名单：runNode 先从 node_run JOIN runs 取 workflow_version，再按账本 node_id 取 node.tools；node_id 不符抛 STALE_GENERATION，未注册/越权/deny 在租约前被拒。源码位置：src/executor/run-node.ts:56-65、:101-115，src/executor/tools.ts:41-56。tests/runtime.spec.ts:71-84、tests/production-path.spec.ts:102-120 覆盖。
- 租约续期：runNode 按 leaseRenewIntervalMs 定时 renewNodeLease，续租失败写 lease_lost 并在收口前 markBlocked；renewLease 用 revision+lease_id CAS 并先 assertLeaseValid。源码位置：src/executor/run-node.ts:73-97、:223-226，src/service/commands/lease.ts:86-99、:115-124。tests/runtime.spec.ts:144-171 覆盖长动作不被 2.5 秒扫描误判。
- 门记录候选绑定：docs/gates/G2.md:4 的候选范围、:5 的结论、:131-314 的 artifact、:316-414 的 evidence-index、:416-504 的 invariants 均存在且结构完整；克隆内用合成 pass 报告重签 G2 后 exit=0，随后再签 G1 并重签 G2，G1 13 项、G2 19 项均 exit=0，全量 vitest 359/359 通过。合成报告只用于验证重签链路，不是本轮真实结论。

## P0

### P0-1 审计报告解析放过裸裁决词与繁體裁决词

位置：scripts/gate-check.ts:652-676（FAIL_VERDICTS 没有裸 否决/驳回/拒绝/反对/未采纳/拒收/不接收 等词），scripts/gate-check.ts:637-650（FAIL_SUBJECTS 没有裸 結論），scripts/gate-check.ts:866-906（auditConclusionOf 只认统一写法的行首结论行，全文扫描又必须先命中主语表）。

影响：审计报告可以在写下 结论：pass 的同时，再写一行表达否决的可见句子；auditConclusionOf 仍返回 pass，checkAuditAnchor 因此可以把它当成本轮 pass 依据。这不是编码混淆，是正常中文句子。

复现命令：`D:/NodeJs/node.exe --no-warnings D:/aboutAI/_g2audit26/probe-parser2.mjs`（繁體三条用 `probe-parser3.mjs`；两条命令 exit=0）。

复现载荷：

```text
本次审计结论为否决。
本次审计结论为驳回。
本次审计结论为拒绝。
本次审计结论为反对。
本次审计结论为未采纳。
本次审计结论为拒收。
本次审计结论为不接收。
結論：fail
本次審計結論為否決。
本次審計結論為駁回。
```

最小回归断言：

```ts
const payloads = [
  '本次审计结论为否决。',
  '本次审计结论为驳回。',
  '本次审计结论为拒绝。',
  '本次审计结论为反对。',
  '本次审计结论为未采纳。',
  '本次审计结论为拒收。',
  '本次审计结论为不接收。',
  '結論：fail',
  '本次審計結論為否決。',
  '本次審計結論為駁回。',
]
for (const p of payloads) {
  expect(auditConclusionOf('结论：pass\n\n' + p)).not.toBe('pass')
}
```

实际输出：以上 10 条逐条运行 auditConclusionOf('结论：pass\n\n' + p)，10 条全部返回 pass；其中前 7 条同时让 bodyConclusionOf('结论：pass\n\n' + p) 返回 pass。对照三条已修复的同类写法（见下）均返回 null。

```text
本次审计无法通过。
本次审计被否决。
本次审计 fаil。
```

端到端复现：在 clone 内给 docs/audits/S2-independent-audit-round26.md 追加 P0-1 的首条载荷后执行 sign-gate G2（exit=0），再执行 gate-check G2（exit=0，输出 gate G2 通过）；同一份报告用 auditConclusionOf 读仍为 pass。这说明该 P0 不是单元函数层面的边角，而是可以实际签过门。

### P0-2 门记录正文解析同样放过裸裁决词

位置：scripts/gate-check.ts:910-926（bodyConclusionOf 复用同一套 FAIL_VERDICTS/FAIL_SUBJECTS），scripts/gate-check.ts:921 的 visibleFailStatement(join, {bareConclusion:'never'}) 只排除了裸 结论/判定 主语，没有补裸裁决词。

影响：门记录正文可以在 结论：pass 之外再写一行上述否决句，bodyConclusionOf 仍返回 pass；签出的 G2 记录正文与 artifact.conclusion 自相矛盾，gate-check 却 exit=0。

复现命令：在 clone 内执行 `D:/NodeJs/node.exe --no-warnings D:/aboutAI/_g2audit26/insert-body-veto.mjs`，再执行 `D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G2.md`，最后执行 `D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md`。

复现载荷：

```text
本次审计结论为否决。
本次审计结论为驳回。
```

最小回归断言：

```ts
const body = '结论：pass\n\n## 必过项与证据\n\n本次审计结论为否决。'
expect(bodyConclusionOf(body)).toBe('fail')
```

实际输出：bodyConclusionOf 返回 pass。端到端复现：在 clone 的 docs/gates/G2.md 正文 必过项与证据 之前插入上述否决句，sign-gate G2 exit=0，gate-check G2 exit=0，输出 gate G2 通过；该行在文件里可见。

## P1

### P1-1 ev-g2-14 证据在并发下不是重跑同字节

位置：scripts/fault-inject.ts:69-74（normalizeEvidence 只归一 ISO 时间戳、evt/lease/实体 id，没有归一 revision），scripts/fault-inject.ts:1245-1281（caseEvG214 每 500 毫秒续租一次，revision 每次 +1），docs/gates/evidence/G2/ev-g2-14.md:23（记录 revision 9），docs/gates/G2.md:83（记录 sha256 4e0776e9…），docs/gates/G2.md:11（声称可由 fault-inject 重跑出同样的字节）。

复现命令：cd D:/aboutAI/dsh-orchestra-audit26 后按环境段第 15 行分别执行；四个并发目录为 D:/aboutAI/_g2audit26/stress14/run1..run4，输出在各自 docs/gates/evidence/G2/ev-g2-14.md。四次 exit 均为 0，sha256 分别为：

```text
run1 4e0776e96e91cc6d486ceb43504e7596c6d251bda2eb9f3ad5b3929c09fc982c
run2 1dadfe238bd66c6b4174c8a9785453c2ba162800e58989cc71523d45e21dbc64
run3 1dadfe238bd66c6b4174c8a9785453c2ba162800e58989cc71523d45e21dbc64
run4 4e0776e96e91cc6d486ceb43504e7596c6d251bda2eb9f3ad5b3929c09fc982c
```

差异只在 node_runs.revision（9 与 10）及对账查询里的同一字段；时间戳仍是 ts 占位符。这说明当前归一化只解决了时间戳，没有解决租约续期次数这个环境噪声，证据字节依赖调度时序。

最小回归测试：把 ev-g2-14 的生成函数跑四路并发，断言四份输出 sha256 全等；或先让 normalizeEvidence 把 node_runs.revision 归一成占位符，再做字节比对。当前实现会失败。

## P2

### P2-1 requiredHashes 接受 output 同键为 null 的产物

位置：src/core/policy.ts:52-59，关键行 :57 用 outputObject[h] ?? null 计算期望哈希。output 里存在同名键但值为 null 时，哈希按 null 计算，证据可以通过。

复现命令：`D:/NodeJs/node.exe --no-warnings D:/aboutAI/_g2audit26/probe-evidence.mjs`，输出行 label=null-artifact。

复现：构造 output={artifact:null}、hashes.artifact=sha256(canonicalJson(null))，其余字段满足强证据与轨迹绑定；applyReport 返回 {"accepted":true,"next_status":"done","registry_state":"applied"}。这说明键存在性检查成立，但产物为空仍可收口；这是“缺 key 必须拒”之外的边界，需明确 null 是否算有效产物。

### P2-2 两个 required key 在产物值相同时可以共用一个哈希

位置：src/core/policy.ts:56-58 只把证据值绑定到 output[h] 的哈希，没有跨 key 的唯一性校验。

复现命令：`D:/NodeJs/node.exe --no-warnings D:/aboutAI/_g2audit26/probe-evidence.mjs`，输出行 label=two-keys-identical-values-same-hash。

复现：required_hashes=[artifact,bundle]，output={artifact:ART,bundle:ART}，hashes={artifact:H(ART),bundle:H(ART)}；applyReport 返回 accepted=true。开发方用例 tests/apply-report.spec.ts:417-427 只覆盖两个产物值不同的情况（会拒），没有覆盖值相同的情况。若规格要求两个 key 证明两份不同产物，这里仍是缺口；若允许同一份产物复用，需要写明口径。

### P2-3 候选上的门记录审计锚与全量用例基线

位置：docs/gates/G1.md:191-193（audit_round=1、audit_report=docs/audits/S1-independent-audit.md、audit_report_sha256=64 个 0），docs/audits/S1-independent-audit.md:146-148（该报告对 G1 的建议与本轮门记录方向相反），docs/gates/G2.md:310-312（audit_round=4、round4 报告、sha256=64 个 0），scripts/gate-check.ts:1513-1538（审计锚先验报告哈希，再验 auditConclusionOf）。

实际：G2 门检查在 HEAD exit=1；全量 vitest 的计数与 sign-gate G1 的报错见下。原因是候选处于重签前状态，且 G1 声明的 S1 报告本身无法被 auditConclusionOf 解析（其正文的建议与门记录方向相反）。在 clone 内用合成 pass 报告重签 G1、再重签 G2 后，G1 13 项、G2 19 项门检查均 exit=0，全量 vitest 359/359 通过；若直接用 G1 现有声明的报告执行 sign-gate G1，exit=1，报错信息见下。这是门链/重签流程的未闭合边界，不是本批 G2 代码回归，但需要人工决定 G1 的审计锚如何收口；G2 的 previous_artifact_hash 只比 G1 的 artifact_hash 锚，不能证明 G1 的审计结论有效。

```text
G2 gate-check: exit=1，审计报告 sha256 与记录不符
vitest: Tests 11 failed | 348 passed (359)
sign-gate G1: exit=1，审计报告里找不到唯一结论行
```

## 未闭合边界

- G2 的 artifact 四个索引哈希在 HEAD 仍是预签态旧值；重签后 candidate_hash=d6d7cacf…、change_scope_hash=b4811c33…、evidence_index_hash=b2f626a6…、invariants_hash=925a7768…，与本报告复算一致。本轮真实判定见第 6 行，因此 G2 停在审计阶段；需修复 P0/P1 后开新一轮审计。
- 证据 19 份的当前字节与表一致，但 ev-g2-14 的并发不稳定意味着这份证据的“可重跑”声明只在顺序/低负载下成立。
- G2 的正文表、证据表、不变量表、例外表在 clone 重签后全部通过；P0/P2 修复会改动 scripts/gate-check.ts 与 src/core/policy.ts，需要重新生成受影响证据并重新审计。
- 租约续期本身经源码与 tests/runtime.spec.ts:144-171 复核仍有效；P1-1 是证据生成的可复现性问题，不是续租逻辑失效。
