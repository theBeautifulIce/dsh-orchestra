# S1 独立审计报告（第三轮）

- 审计对象：D:/aboutAI/dsh-orchestra
- 审计对象 HEAD：c4f7b35ff96ed219d1a39ef40d9392f781706383
- 审计时间：2026-11-13（Asia/Shanghai）
- 审计性质：独立审计，不实现功能；只读源码、测试、证据与文档，本轮只写本报告文件
- 前序报告：docs/audits/S1-independent-audit-round2.md（判定 fail；致命 0 / 重大 2 / 不阻断 2）
- 本轮重点：S1 第二轮两项重大的整改闭合情况，以及 G1 门记录、证据、门检查实现与重签工具

## 一、执行命令与实测输出

1. `git rev-parse HEAD`
   - 输出：c4f7b35ff96ed219d1a39ef40d9392f781706383
2. `git status --porcelain`
   - 审计开始时输出为空（工作树干净）。
3. `D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit`
   - exit 0，无输出。
4. `D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/gate-check.spec.ts`
   - Test Files 1 failed (1)；Tests 10 failed | 18 passed (28)。
   - 10 个失败全部停在 scripts/gate-check.ts:511 的同一处早退：
     `审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…`
   - 失败用例为：G1 门记录通过（tests/gate-check.spec.ts:34），以及依赖该记录的 9 个变异用例（:46、:68、:77、:84、:100、:137、:143、:154、:175）。与“G1 当前未重签、audit_report_sha256 仍是占位”的预期完全对应。
   - 其余 18 例通过，包含三项审计锚负例（:160、:165、:170）、前序链断裂（:149）、证据换绑（:128）、脏树拒绝（:204）、结论行解析两例（:216、:222）。
5. `D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md`
   - 输出 `门检查失败：审计报告 sha256 与记录不符…`，exit 1；与第 4 条同一根因。
6. `D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run`
   - Test Files 1 failed | 31 passed (32)；Tests 10 failed | 278 passed (288)；退出码 1。
   - 唯一红文件是 tests/gate-check.spec.ts；其余全部通过，包括 tests/integration/g1.spec.ts 6/6、tests/write-queue.spec.ts 2/2、migrate 6、backup 6、auth 12、config 11、runtime 7。未发现“未签”之外的失败。
7. 独立重算（git show HEAD 取字节，按 LF 归一，用 src/core/canonical.ts 的 canonicalJson 复算）：见第三节。

## 二、逐项核验

### 1）证据 id 到文件的固定映射

已闭合。

- scripts/gate-check.ts:254-286 的 checkEvidence 先按 id 查 spec.evidenceFiles（:266），未登记的 id 直接拒绝（:267），文件不一致直接拒绝（:268）；随后才读 HEAD 字节、算哈希（:270-274）。固定映射中的每个 id 都必须出现（:277-279），重复 id 也被拒（:263）。
- scripts/sign-gate.ts:81 在写回之前调用 verifyGateRecord(text, { root, path, selfCheck: true })；selfCheck 只跳过脏树检查（scripts/gate-check.ts:562）和“门记录必须在 HEAD”检查（:627），不会跳过 checkEvidence。写入发生在 :82，因此在 :81 失败时不会落盘。改 evidence-index 的 file 字段再重签，会在 :268 被挡下，无法借重签绕过。
- 测试 tests/gate-check.spec.ts:154-158 构造了把 ev-g15 换绑到 G-01 的文本，断言抛出“文件与固定映射不一致”。该用例当前因未签而先停在 :511，属预期；静态调用链与 sign-gate 的写前校验共同证明映射不可绕过。
- 设计上唯一的外部信任根是 GATE_SPECS 本身（scripts/gate-check.ts:43-...，G1 的 evidenceFiles 在 :76 起）。能改脚本与测试的人也能改映射；这是门检查的自证边界，不是本轮可修的实现缺陷。建议把“改 GATE_SPECS 必须同时改本审计报告并重签”写进流程。

### 2）审计锚

已闭合。

- scripts/gate-check.ts:493-519 的 checkAuditAnchor 依次要求：审计轮次为正整数（:494-495）；报告非空（:496-497）；路径必须是 `docs/audits/<单层文件名>.md` 且不含 `..`（:498-500）；不得指向门记录自身（:501）；报告必须在 HEAD（:502-503）；文件名里的 roundN 必须等于 audit_round（:504-506）；audit_report_sha256 必须是 64 位十六进制（:507-508）；对 HEAD 报告字节按 LF 归一重算并比对（:509-511）；报告正文必须能解析出唯一结论行，且结论等于 artifact.conclusion（:513-518）。
- 签后改报告正文会被发现：门检查读的是 HEAD 字节（:502），存的是字节哈希（:509-511）。签后提交任何正文改动都会使 :510 的比对失败；只改工作树而不提交，则 HEAD 未变，门仍然对“已提交的报告”成立，这与“门记录指向 HEAD”的口径一致。
- “审计报告字节哈希被改”“不在 docs/audits 下”“轮次对不上”三个负例（tests/gate-check.spec.ts:160-173）本轮全部通过，是活证据。
- 自指检查 :501 在当前路径白名单下实际不可达（门记录在 docs/gates，路径校验 :498 已先拒），属冗余防线，不构成缺陷。
- 残余风险（不阻断）：锚只约束“docs/audits 下、轮次相同、结论 pass、字节固定”，没有把报告绑定到具体门标识。若另一道门存在同轮次且结论为 pass 的报告，理论上可把 G1 的 audit_report 指过去并重签。它仍需一份真实的通过报告，且不改变必过项与证据的校验，故列为 P2 观察。

### 3）G1 十三项与证据一致性

已闭合，当前处“待签”状态。

- docs/gates/G1.md:11-25 的必过项表为 13 项；artifact.must_pass_items 为同一组 13 个 id；evidence-index 为 13 份证据；不变量表为 I1/I10/I2/I3 四项。GATE_SPECS.G1 的 items、evidenceMap、evidenceFiles 与上述三处逐项一致（id、顺序、证据归属均一致），未发现截短、改名或换绑。
- 13 份证据都能从 HEAD 逐份重算 sha256。当前 10 份与记录一致，3 份不一致：
  - ev-g14：记录 3b2e37d9a0f6…，实际 44351757aa24…；
  - ev-gatecheck：记录 c61262506e81…，实际 b7378a5d3e59…；
  - ev-migrate：记录 b3ad3fbde1ef…，实际 6ec799698b70…。
  三份都在上次签门之后被提交改过（G-14 重跑、gate-check 与 migrate 测试更新），属未重签的预期差异，不是证据伪造。
- 其余四个锚同样可重算：evidence_index_hash 记录 fad4d531d22e…、重算 a72efa02691f…；invariants_hash 记录与重算一致（6f75465bfb0e…）；artifact_hash 记录 1ce80f6080fb…、重算 f54dcae873f3…；body_hash 记录 446357f9e00e…、重算 aea5ac30bdb7…；candidate_hash 记录 bbd322cf9d4e…、重算 57d112df741a…（89 个文件）；change_scope_hash 记录 ea15eaba761c…、重算 248737b6264e…。previous_artifact_hash 为 64 个 0，符合第一道门。全部差异可归因于未重签。
- G-14 已按新口径重跑：docs/gates/evidence/G1/G-14.md:3 的参数为 beforeTables=14；:20 对账为“重跑只补了 [902]；schema_migrations=[1,2,3,4,901,902]；表数 14→16，第一步没重复执行”。tests/integration/g1.spec.ts:33-37 逐项断言这三个关键值；scripts/fault-inject.ts:269-296 的 caseG14 先只执行 901，再对同一库执行 901+902，机制与证据一致。
- 证据索引与正文证据表、artifact 的 evidence_ids 三方一致；每份证据至少被一个必过项或不变量引用（gate-check.ts:610-619）。G1.md:202 的补记说明“满了返 SERVICE_UNAVAILABLE(503) 并记 warning”，与 G-08 证据正文的出入见 P2-1。

### 4）sign-gate 的可绕过性与四个哈希

未发现手填或绕过路径。

- scripts/sign-gate.ts:12 先 assertClean；:29 证据只从 HEAD 取；:33-44 重算 evidence_index_hash 与 invariants_hash；:50-52 重算 candidate_hash 与 change_scope_hash；:54-61 从前序门记录 HEAD 的 artifact_hash 取链；:65-68 从 HEAD 审计报告重算 audit_report_sha256；:72-79 重写 artifact_hash 与 body_hash；:81 用完整校验复核，:82 才写回。
- 因而门记录里的“手填值”不是信任源：must_pass_items、evidence_ids、audit_round、audit_report、previous_artifact_hash、四个哈希、body_hash 都会在 :81 的完整校验里被重新核对。无法通过手改字段让一个不自洽的记录写回。
- body_hash 的口径见 gate-check.ts:425-435：只掩码两个自锚点和反引号里的 64 位十六进制。正文里反引号形式的人类可读哈希仍需与 evidence-index/artifact 交叉核对（gate-check.ts:608、:620-621），artifact JSON 内的哈希由 artifact_hash 覆盖，未发现可利用的未覆盖哈希。
- DIRTY_IGNORES 为 docs/audits、docs/reviews、handoff.md（scripts/gate-check.ts:221-225），范围合理：docs/gates 不在忽略清单，证据或门记录改而未提交会拒绝签门；候选清单按设计排除 docs/gates 与 docs/audits，证据由 evidence-index 单独绑定，不构成“改了证据却不进候选”的漏洞。
- 边界：sign-gate 与 GATE_SPECS 同属仓库文件，内部没有外部信任根。能同时改脚本、测试和证据的人可以重定义校验本身。这属于人工治理边界，按本轮口径不计为代码缺陷。

### 5）测试结论

- tsc：通过，exit 0。
- tests/gate-check.spec.ts：28 例，10 红 18 绿；10 红全部是未签的预期早退（scripts/gate-check.ts:511），未发现其他原因造成的红。
- 全量：32 个测试文件、288 例，10 红 278 绿；红只集中在 gate-check.spec.ts；集成、迁移、备份、认证、配置、运行时、写队列均绿。
- 结论：测试层面的闭合性成立；待 G1 按流程重签后，预期 28/28 全绿。

## 三、问题分级

### P0（致命）

无。

### P1（重大）

无。第二轮两项重大（证据文件未固定、审计锚未绑字节/目录）均已按上述实现闭合，并有对应负例测试。

### P2（不阻断，遗留或观察）

1. G-08 的证据没有直接展示 HTTP 503 与 warning。
   - 位置：docs/gates/evidence/G1/G-08.md:20；固定证据表在 scripts/gate-check.ts:76 起；断言 503 的 tests/write-queue.spec.ts 不在 evidence-index。
   - 复现：`git show HEAD:docs/gates/evidence/G1/G-08.md` 第 20 行只有“队列溢出码：SERVICE_UNAVAILABLE”，没有 503/warning 字样；`tests/write-queue.spec.ts` 全绿但未被门记录哈希。
   - 为什么是问题：必过项 G1-08 要求的是 503 行为，证据正文只证明了错误码；功能本身由全量测试覆盖，故不阻断，但证据链存在可追溯性缺口。
2. G-15 证据仍保留绝对临时路径，与门记录声明不一致。
   - 位置：docs/gates/G1.md:206 声称“证据参数里的临时目录统一写成 `<tmp>`”；docs/gates/evidence/G1/G-15.md:3 实际为 `C:\Users\ASUS\AppData\Local\Temp\orchestra-g1-UPjRtV\backup-g15`。
   - 复现：`git show HEAD:docs/gates/evidence/G1/G-15.md` 第 3 行。
   - 为什么是问题：门记录正文与证据正文互相矛盾，且绝对路径不利于他人复现；不影响恢复被拒的结论与哈希校验，故不阻断。
3. 审计报告未绑定具体门标识。
   - 位置：scripts/gate-check.ts:493-519。
   - 复现：把 G1 的 audit_report 改成另一道门同轮次、结论为 pass 的 docs/audits 报告，更新 audit_report_sha256 后重签，checkAuditAnchor 只按路径/轮次/结论/字节校验，能通过。
   - 为什么是问题：独立审计的归属可能被跨门复用；但仍需一份真实通过报告，且不改变必过项与证据校验，故列为观察，不阻断。

## 四、待签状态与后续动作

1. 当前 G1 有意未重签：G1.md:191-193 的 audit_round=1、audit_report 指向第一轮报告、audit_report_sha256 为 64 个 0；G2 同类。按用户口径，这是预期状态，不作为 fail 理由。
2. 本报告写入后必须先提交到 HEAD，checkAuditAnchor 只认 HEAD 字节（scripts/gate-check.ts:502）；未提交的报告不能用于签门。
3. 随后把 G1.md 的 audit_round 改为 3、audit_report 改为 docs/audits/S1-independent-audit-round3.md，再运行 `D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G1.md`，提交后用 `D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md` 复核。
4. 重签后应复跑 tests/gate-check.spec.ts，预期由 10 红 18 绿变为 28/28 绿；若仍有非“审计报告 sha256”原因的红，按新缺陷处理。
5. 重签会同时刷新 3 份证据哈希、evidence_index_hash、artifact_hash、body_hash、candidate_hash、change_scope_hash 与 audit_report_sha256；任何一项未刷新，门检查都会拒绝。

## 五、审计边界

- 本轮未做独立的“临时仓库里篡改后重签”实机演练；映射与审计锚的不可绕过性由 sign-gate 的写前完整校验（:81-82）与已通过的三个审计锚负例共同证明。映射负例当前被未签状态遮蔽，重签后应转为绿例。
- 未逐份重跑 G-01/G-02/G-08/G-09/G-14/G-15 的故障注入；集成用例 6/6 通过，证据哈希可逐份重算，G-14 的机制与断言已单独核对。
- 未审计 G1 之外的新功能实现，也未修改 src/、tests/、scripts/ 或任何证据文件。

结论：pass
