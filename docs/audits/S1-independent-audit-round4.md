# S1 独立审计（第四轮）：G1 与门/签名机制

## 审计对象与 HEAD

- 仓库：D:/aboutAI/dsh-orchestra
- 审计对象 HEAD：f572984140437cfc4e9149f9b71ebb721caa5e12（f572984，docs(audit): 归档 S1 第三轮与 S2 第七轮独立审计报告）
- 范围：docs/gates/G1.md、scripts/gate-check.ts、scripts/sign-gate.ts、docs/gates/evidence/G1/*、docs/gates/G2.md 的链字段，以及 d3ab0a4 对 auditConclusionOf 的加固。
- 工作树：审计开始时 git status --porcelain 为空。审计期间另一并发审计新增了未跟踪的 docs/audits/S2-independent-audit-round8.md，本审计未触碰；本审计只新增本报告。
- 当前 G1 是待签状态：audit_round=1、audit_report=docs/audits/S1-independent-audit.md、audit_report_sha256=64 个 0；3 份证据在上次签后因 c4f7b35/d3ab0a4 过期。待签状态的哈希过期不作为缺陷，单独列在“重签前字段”里。
- 基线：第三轮报告 docs/audits/S1-independent-audit-round3.md 判 pass，列 G-08、G-15、audit_report 绑定三条 P2；本轮从头复核，不采信其描述。

## 实测命令与结果

| 命令 | 结果 |
| --- | --- |
| D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit | exit 0，无输出 |
| D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run | 32 个测试文件，1 failed / 31 passed；290 例，10 failed / 280 passed |
| D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md | exit 1，停在 scripts/gate-check.ts:521 的审计报告 sha256 占位 |
| D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/gate-check.spec.ts | 30 例，10 failed / 20 passed；10 红全部是 sha256 占位，不是解析逻辑失败 |
| D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/integration/g1.spec.ts | 6/6 通过 |
| D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/write-queue.spec.ts | 2/2 通过；tests/write-queue.spec.ts:42 断言 HTTP 503，:43 断言 SERVICE_UNAVAILABLE，:45 断言 warning |
| 相关单测 auth / backup / config / hash-chain / db-open / migrate | 12 / 6 / 11 / 7 / 8 / 6 例全绿 |

### d3ab0a4 结论解析复核

| 样例 | auditConclusionOf | 说明 |
| --- | --- | --- |
| 单行 `结论：通过率 60%，未达门槛` | null | 修复有效，未被当成通过 |
| 围栏内 `结论：pass` 加围栏外 `结论：fail` | fail | 围栏跳过有效 |
| `结论：pass` 行加 `结论：fail，仍有 1 个 P0 未闭合` 行 | pass | P1-1：未收口的 fail 行被静默忽略 |
| 唯一 `结论：fail` | fail | 正常 |
| `结论：pass，但仍有 P0` | null | 正常拒绝 |
| 四空格缩进 `结论：pass` | pass | trim 的设计行为 |
| 行内引用 `本文引用结论：pass` | null | 只认行首 |

### 端到端克隆实验

所有克隆都在系统临时目录，不碰本仓库；每个实验只改 G1 的 audit_round、audit_report 和目标报告。

- 脏树签名：只改 G1 未提交就运行 sign-gate，exit 1，assertClean 报“工作树有未提交改动，门记录不能对着脏树签：M docs/gates/G1.md”。
- 真 fail 报告：报告唯一行 `结论：fail`，sign-gate exit 1，checkAuditAnchor 报“报告=fail，门记录=pass”，未写入。
- P1-1：报告两行 `结论：pass` 与 `结论：fail，仍有 1 个 P0 未闭合`，sign-gate 成功（artifact_hash=61352d9f9f1e…，body_hash=ed6ab1eab8c3…），提交后 gate-check 通过。
- P2-1：报告唯一行 `结论：pass`，正文证据表把 ev-g15 行替换成 ev-g08 行（ev-g08 两次、ev-g15 零次），不变量表把 I10 行替换成 I1 行（I1 两次、I10 零次），sign-gate 成功（artifact_hash=89c2362326b1…，body_hash=c26ab7c32944…），gate-check 通过。
- P2-4 旧轮：audit_round=3，指向 S1 round3 报告（报告写明审计对象 c4f7b35），sign-gate 成功（artifact_hash=faf45b3f6fb5…，body_hash=fd466c9e640c…），gate-check 通过。
- P2-4 同轮另一门：audit_round=4，指向实验用的 docs/audits/S2-independent-audit-round4.md（内容只有一行 `结论：pass`），sign-gate 成功（artifact_hash=0fb51534f184…，body_hash=cf8face15452…），gate-check 通过。

## P0/P1/P2 清单

P0：无。

### P1-1 审计锚的唯一结论校验仍可被绕过

- 位置：scripts/gate-check.ts:476-499（auditConclusionOf），其中 :493 对未匹配严格后缀的行直接 continue；:497 只统计已解析结论；scripts/gate-check.ts:524-528 才比较报告结论与门记录结论。
- 证据：报告同时写 `结论：pass` 与 `结论：fail，仍有 1 个 P0 未闭合` 两行时，auditConclusionOf 返回 pass；克隆实验中 sign-gate 成功写入，提交后 gate-check 通过。现有 tests/gate-check.spec.ts 只测了单行“结论：fail 但仍有风险未排除”返回 null，没有测“该行再加一行 pass”的组合。
- 理由：唯一结论不变量只对“能解析的结论行”计数，行首的“结论：fail…”因为后缀未收口被静默丢弃，剩下的 pass 行成为唯一结论。含 fail/P0 陈述的报告因此可以签成 pass 门记录。
- 影响：审计锚是报告与门记录之间唯一的自动绑定；该路径不需要改任何哈希或证据，直接绕过审计结论。按“重大 P1”定级。
- 修复建议：以 结论/判定 开头且含 pass/fail/通过/不通过 token 但未匹配严格后缀的行，应视为歧义并返回 null；或统计所有行首结论候选，要求恰好一个且必须匹配。补“pass 行 + 未收口 fail 行”组合负例。

### P2-1 正文证据表与不变量表只做单向核对

- 位置：scripts/gate-check.ts:366-383（checkBodyEvidenceTable）与 :405-422（checkBodyInvariants）。:372 与 :411 只比行数，:373 与 :412 建 map，:378-381 与 :415-420 只校验“行里的 id 在 artifact 中存在且字段一致”。
- 证据：克隆中删掉 ev-g15 行、用第二行 ev-g08 补足 13 行；删掉 I10 行、用第二行 I1 补足 4 行；sign-gate 成功，gate-check 通过。
- 理由：检查的是 rows 是 artifact 的子集且行数相等，没有检查 artifact 的每个 id 都出现、也没有拒绝重复 id；重复行可以掩盖缺行。
- 影响：机器证据仍全量校验，但正文人类可读表可以缺一行而门照过，“正文表与 evidence-index 同源”的声明不成立。按 P2 定级。
- 修复建议：收集行 id 的 Set，要求无重复且与 artifact id 集合完全相等；不变量表同样处理。

### P2-2 G-08 证据仍缺 503 与 warning

- 位置：docs/gates/evidence/G1/G-08.md:20；scripts/gate-check.ts:76-90 的 evidenceFiles 固定映射；tests/write-queue.spec.ts:42-45。
- 证据：G-08 对账只写“队列溢出码：SERVICE_UNAVAILABLE”，没有 HTTP 503 与 warning；tests/write-queue.spec.ts 真实断言了 503、SERVICE_UNAVAILABLE、warning 与 appended=0，但该文件不在 G1 的 13 份证据里。
- 理由：G1-08 的必过内容明确写“队列溢出报 503”，现有证据只证明应用错误码，没有证明 HTTP 状态与日志行为。
- 状态：第三轮 P2，仍存在；全量用例能补证，但门记录没有固定它，按 P2 保持。

### P2-3 G-15 证据仍含绝对临时路径

- 位置：docs/gates/evidence/G1/G-15.md:3；docs/gates/G1.md:206。
- 证据：参数里仍是 C:\Users\ASUS\AppData\Local\Temp\orchestra-g1-UPjRtV\backup-g15；G1.md:206 写明“证据参数里的临时目录统一写成 <tmp>”。
- 理由：声明与证据不一致，绝对路径降低可复现性，也把本机路径带进门记录。
- 状态：第三轮 P2，仍存在；按 P2 保持。

### P2-4 审计报告未绑定门标识与候选 HEAD

- 位置：scripts/gate-check.ts:503-529（checkAuditAnchor）。只校验 docs/audits 单层路径、文件名 round 与 audit_round 一致、HEAD 字节 sha256、结论一致。
- 证据：旧轮 S1 round3 报告（正文写明审计对象 c4f7b35）在 HEAD f572984 被成功复用重签；同轮另一门实验用的 S2 round4 pass 报告也被成功复用。两次 sign-gate 与 gate-check 都通过。
- 理由：报告路径不含门标识，检查也不读报告里的门与候选 HEAD；任何轮次相同、结论为 pass 的 docs/audits 报告都能当本门依据。
- 影响：审计锚可借壳；与 P1-1 组合时可以进一步掩盖结论。第三轮已列 P2，本轮不升级；单靠这一条还不足以把 fail 报告签成 pass。
- 修复建议：报告头固定“门：G1”和“审计对象 HEAD/candidate_hash”，checkAuditAnchor 解析并与 spec.gate 和候选哈希比对；或把门标识写进报告文件名并纳入检查。

第三轮三条 P2 的现状：G-08 仍缺 503/warning 与 write-queue 证据；G-15 仍含绝对路径；audit_report 仍可复用同轮另一门或旧轮报告。三条都仍存在，均不升级；本轮新增 P1-1 与 P2-1。

## 13 项与证据核对表

必过表 13 行，编号、顺序、内容与 GATE_SPECS.G1.items 完全一致；每项 result=pass，证据列与固定 evidenceMap 一致；artifact.must_pass_items 13 项同源。下面按 HEAD 重算证据哈希。

| 编号 | 必过内容 | 证据 | 哈希 |
| --- | --- | --- | --- |
| G1-01 | 迁移空库可重复 | ev-migrate | STALE（实际 6ec799698b70…） |
| G1-02 | 迁移中途杀可重入 | ev-g14 | STALE（实际 44351757aa24…） |
| G1-03 | 进程杀不丢已提交事件 | ev-g02 | MATCH（5fedb2e7539b…） |
| G1-04 | 备份独立目录行数与哈希一致 | ev-backup | MATCH（8b8d54130252…） |
| G1-05 | 损坏备份可检出 | ev-g15 | MATCH（db16d844f912…） |
| G1-06 | 认证拒匿名写 | ev-auth | MATCH（13f123174be3…） |
| G1-07 | 阶段开关拒未知值 | ev-phase | MATCH（d2175cc5f420…） |
| G-01 | 事务 COMMIT 前杀进程 | ev-g01 | MATCH（f2626b30f9eb…） |
| G-02 | COMMIT 后未投递被杀 | ev-g02 | MATCH（5fedb2e7539b…） |
| G-08 | 长事务读不拖死、写 busy、溢出 503 | ev-g08 | MATCH（a50e5a17eafd…），证据缺 503/warning（P2-2） |
| G-09 | 订阅者离线重放 | ev-g09 | MATCH（e944a2b6bd29…） |
| G-14 | 迁移一半杀后重跑 | ev-g14 | STALE（实际 44351757aa24…） |
| G-15 | 备份截断可检出、恢复拒、线上库不变 | ev-g15 | MATCH（db16d844f912…），含绝对路径（P2-3） |

证据表 13 行，文件与 evidenceFiles 固定映射一致，无重复 id；10 份 MATCH，3 份 STALE。ev-chain、ev-epoch、ev-gatecheck 不在必过项里，只在不变量表使用：I1→ev-epoch（MATCH 78263f1c…）、I10→ev-gatecheck（STALE，实际 184ead77fb3a…）、I2→ev-chain（MATCH e15bb381…）、I3→ev-g01/ev-g02（MATCH）。

### 四个哈希与待签字段

| 哈希 | 记录值 | HEAD 实测 | 状态 |
| --- | --- | --- | --- |
| candidate_hash | bbd322cf9d4e… | f81b97dda44a… | STALE，89 个候选文件；d3ab0a4 改了 scripts/gate-check.ts、tests/gate-check.spec.ts、src/executor/run-node.ts、tests/runtime.spec.ts |
| change_scope_hash | ea15eaba761c… | 248737b6264e… | STALE，89 条路径 |
| evidence_index_hash | fad4d531d22e… | 00ade886e4dc… | 记录值与记录版索引自洽；按 HEAD 刷新 3 份证据后应为 00ade886…，重签会改写 |
| invariants_hash | 6f75465bfb0e… | 6f75465bfb0e… | MATCH |
| artifact_hash | 1ce80f6080fb… | f54dcae873f3… | STALE；c4f7b35 在签后追加 audit_report_sha256=0，属于待签字段变更 |
| body_hash | 446357f9e00e… | aea5ac30bdb7… | STALE；同上，待签字段变更导致正文自锚变化 |
| audit_report_sha256 | 64 个 0 | 50ba1b13cdf1… | 占位；当前指向的 S1-independent-audit.md 的 HEAD 字节哈希 |

3 份证据 STALE 的原因：ev-g14 与 ev-migrate 在 c4f7b35 被改过；ev-gatecheck 在 d3ab0a4 被改过。其余 10 份 MATCH。当前 gate-check 在审计报告 sha256 处早退，没有再走到证据与 artifact 校验；上面的 MATCH/STALE 是独立脚本按 HEAD 字节重算的结果，不把早退当通过。

重签前需要改的字段与顺序：

- 若本轮是 pass 报告：把 audit_round 改为 4、audit_report 指向 docs/audits/S1-independent-audit-round4.md、audit_report_sha256 清零；先提交报告和 G1 字段，再运行 sign-gate。sign-gate 会自动刷新 3 份证据哈希、evidence_index_hash、candidate_hash、change_scope_hash、artifact_hash、body_hash 与 audit_report_sha256。
- 实际路径：本轮报告是 fail，不能用来签 pass。修完 P1-1 与 P2-1 后做第五轮独立审计，拿到 pass 报告，再把 audit_round 改为 5、audit_report 指向 round5 报告、sha 清零，提交后重签。
- scripts/gate-check.ts:221-230 的 assertClean 不忽略 docs/gates，所以 G1 字段改动必须先提交；审计报告也必须在 HEAD，sign-gate 只从 HEAD 读报告与证据。脏树签名已被实验拒绝。
- G1 重签后 artifact_hash 会变；G2.md:309 的 previous_artifact_hash=1ce80f60 必须由 G2 重签刷新。G2 自身也是未签状态（audit_round=4、audit_report 指向 S2 round4 的 fail 报告、sha 全 0），需要先有自己的 pass 报告。顺序是先 G1、后 G2。

## 门机制评价

固定清单、固定 evidenceFiles 映射、HEAD 字节取证据、LF 归一重算、candidate/change_scope、evidence_index/invariants、body_hash、审计锚与前序链这些环节都在 scripts/gate-check.ts:570-648 的 verifyGateRecord 里串起来了；sign-gate 在写回前调用同一套校验（scripts/sign-gate.ts:81-82），脏树会被 assertClean 拒绝，真 fail 报告会被 checkAuditAnchor 拒绝。这些是有效的。

未闭合的是审计锚的结论解析（P1-1）和正文两表的单向核对（P2-1）。前者已经端到端签出 pass 门记录，后者也已端到端签过；两者都不需要改哈希或换证据文件。证据换绑方面，本轮没有找到绕过固定映射的路径：sign-gate 按 evidence-index 的文件字段从 HEAD 取字节，写前 verify 会用 evidenceFiles 固定映射拒绝未知 id/文件；正文重复行只影响人类可读表，不影响机器证据全量校验。

前序链检查（scripts/gate-check.ts:458-472）只比较本门 previous_artifact_hash 与前序门记录里的 artifact_hash 锚点，不重跑前序门。它不构成 fail 报告签 pass 的路径，但意味着 G2 可以在 G1 过期时单独重签；本轮把这点记为观察项，不计 P2。

## 未闭合项与是否阻断 S1

- P1-1 阻断 S1：含 fail/P0 陈述的报告可以被签成 pass 门记录，审计锚失效；在修复并重新独立审计为 pass 之前，G1 不能批准。
- P2-1 应在重签前修掉，否则正文表与 artifact 的“同源”只是单向的；它单独不阻断，但属于门机制完整性缺口。
- P2-2、P2-3、P2-4 是第三轮遗留，仍存在；按标准只有 P2 可以 pass，但本轮已有 P1，整体不能 pass。
- 当前 G1 本身未签（sha 全 0、证据过期），所以它现在没有对外声称 pass；本轮判 fail 的对象是门机制与 G1 第四轮审计结论，不是把待签哈希过期当缺陷。
- S1 是否阻断：是。需要先修 P1-1（并补组合负例），再处理 P2-1，取得第五轮独立审计 pass 报告后，按上面的字段与顺序重签 G1；G1 通过后再处理 G2 链。

结论：fail
