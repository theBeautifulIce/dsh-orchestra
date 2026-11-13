# S1 / G1 第九轮独立审计报告

门：G1
候选提交：379fd22f40f9aa0e5c401219cd10d073ee708bc1

结论：fail

## 审计范围与方法

- 对象：S1/G1 门记录 docs/gates/G1.md、scripts/gate-check.ts、scripts/sign-gate.ts、tests/gate-check.spec.ts 及 13 份必过项证据。
- 候选提交 379fd22f40f9aa0e5c401219cd10d073ee708bc1 即审计时主仓库 HEAD，工作树干净；本轮未改主仓库代码、测试、docs/gates。
- 唯一写回主仓库的文件是本报告。全部试验在临时 clone D:/aboutAI/_audit_s1_r9/clone 进行，node_modules 以目录联接指向主仓库；审计结束后临时目录已删除。
- 运行环境 Node v26.13.1；sign/check 命令为 node --no-warnings scripts/sign-gate.ts docs/gates/G1.md 与 node --no-warnings scripts/gate-check.ts docs/gates/G1.md。
- 当前 HEAD 的 G1 仍是旧审计（audit_round=1、旧报告、audit_report_sha256 为 64 个 0），属预期的预签状态，gate-check 当前 exit 1 不作为 P1。

## 判定口径与结果

- P0=0，P1=1，P2=5。
- 模拟重签的阳性对照（合法 pass 报告）gate-check exit 0；对 fail 报告执行同一流程时 sign-gate 按设计拒绝，不能签成 pass。
- 全量测试未全绿（见 P2-5），且 P1-1 仍可绕过，故判 fail。

## P0

无。

## P1

### P1-1 隐藏文本仍可绕过，S1 第八轮 P1-4 未修全

代码位置：scripts/gate-check.ts:571-605（auditTopLevelLines）、scripts/gate-check.ts:577（缩进跳过只认 4 个以上空格或行首 Tab）、scripts/gate-check.ts:578-591（引用块只跟踪引用围栏，不跟踪引用内的缩进代码）、scripts/gate-check.ts:614-638（stripHiddenAuditBlocks 用非贪婪正则循环替换 details/pre/script/style/template，嵌套时先匹配到内层闭合）。

复现方式：在临时 clone 中把 G1 的 audit_round 改为 9、audit_report 指向 docs/audits/S1-independent-audit-round9.md、audit_report_sha256 置为 64 个 0；报告先写可见的 fail 文案，再放入下面的隐藏 pass；提交后依次运行 sign-gate 与 gate-check。

1. 嵌套 details：

```
<details>
<details>
</details>
（此处放一行以结论加冒号开头的 pass 文案）
</details>
```

结果：sign-gate exit 0（artifact_hash=764dc691a0ad…），gate-check exit 0。

2. 引用块内 4 空格缩进：

```
>    （一行以结论加冒号开头的 pass 文案）
```

结果：sign-gate exit 0（artifact_hash=01632155feab…），gate-check exit 0。

3. 空格加 Tab 缩进：

```
（一个空格 + 一个 Tab，后接一行以结论加冒号开头的 pass 文案）
```

结果：sign-gate exit 0（artifact_hash=25ed52d08e00…），gate-check exit 0。

对照：普通 HTML 注释、普通 details、恰好 4 个空格缩进、引用围栏、两行不同结论、同行相反结论（pass 与 fail 写在同一行）都被拒，sign/check 均 exit 1，错误为「审计报告里找不到唯一结论行，不能拿它当门记录依据」。说明修复覆盖了常见形态，但没有覆盖嵌套与混合缩进。

测试缺口：tests/gate-check.spec.ts:331-338 的隐藏块用例只覆盖普通注释/details/恰好 4 空格/引用围栏，未覆盖上述三种形态；因此现有测试全绿也不能证明 P1-4 已闭合。

## P1-2 与 P1-3 复核：已修复

P1-2（报告复用别门/别轮）：scripts/gate-check.ts:557 的 auditBindingOf 只认顶层且唯一的门行与 40 位候选提交行；scripts/gate-check.ts:699 的 checkAuditAnchor 要求绑定门名等于 artifact.gate、候选提交存在且是 HEAD 祖先、候选提交之后无候选文件改动。实测：

- 指向 S2 的 round12 报告（无 G1 绑定）：sign/check 均 exit 1，错误「审计报告缺少唯一的「门：G1」与「候选提交：<40 位 commit>」绑定行: docs/audits/S2-independent-audit-round12.md」。
- 绑定 orphan commit d76a1d7f2409d01378115e074de281d55495e909：sign/check 均 exit 1，错误「审计报告的候选提交不是 HEAD 的祖先或不存在」。
- 候选提交后修改 src/index.ts 再提交：check exit 1，错误「审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：src/index.ts」。
- 短 sha、重复门绑定行、门名写 G2：分别被拒，错误为「缺少唯一绑定行」与「审计报告绑定的门与门记录不符：报告=G2，记录=G1」。

P1-3（不变量语句可被削短）：scripts/gate-check.ts:311 的 checkInvariants 要求 statement 精确等于 GATE_SPECS 固定文案、证据 id 排序后逐项等于固定集合、id 集合完全一致，并重算 invariants_hash。tests/gate-check.spec.ts:149-164 构造了削短 I1 且重算哈希的用例，仍被拒。该项已闭合。

## G1 规格、13 项必过项与四哈希

- G1 规格固定 13 项必过项（G1-01..G1-07、G-01、G-02、G-08、G-09、G-14、G-15）与 13 份证据的 id→文件映射，G1.md 的 must_pass_items 与正文表均为 13 行，正向对照 gate-check 输出「13 项必过、13 份证据哈希复核」。
- 固定不变量 4 条（I1、I10、I2、I3）；正文不变量表 4 行与 JSON invariants 4 条一致，invariants_hash 记录值与重算值均为 6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6。
- 当前预签态的其余四个哈希均为旧值，重算不一致：candidate 记录 bbd322cf…、实际 72a72d0a10bb41bb2631a90b83923bd67512eaaeafeb748b926d2cdfff9cf553；change_scope 记录 ea15eaba…、实际 248737b6264e7b36ea9a9788235a16986c76225242b3b497540b78ad5f7fc65b；evidence_index 记录 fad4d531…、实际 259a3d048fc1f429a422bab794cefd738b8150a6c332c55f104ab7ba1a5a9097；artifact_hash 记录 1ce80f60…、实际 f54dcae873f34a988ca7d6fbf5bd0b29ce68558acfd4007f0b477e49b65cc4ec；body_hash 记录 446357f9…、实际 111ce311f354ff5822db0ff282adb2bfdf0f9efdd93be876f69ef866e6144118。
- 证据索引中有 4 份与 HEAD 字节不符：ev-g14、ev-g15、ev-gatecheck、ev-migrate（记录值分别为 3b2e37d9…、db16d844…、c6126250…、b3ad3fbd…；实际值分别为 44351757…、334f26fb…、efa97e84…、6ec79969…）。这与预签态一致，由 sign-gate 重算，不单独判 P1。
- 校验顺序：verifyGateRecord 在 scripts/gate-check.ts:787-865 依次做 assertClean、JSON 块与字段、schema、必过项、门规格、证据映射、失败项、conclusion、run_terminal、治理、前序链、auditAnchor、artifact_hash、证据、不变量、正文表、候选、body_hash、门记录在 HEAD。auditAnchor 排在 artifact_hash 之前，因此报告 sha 不符会在更具体的哈希检查前先报错；这是报错顺序问题，不是放行路径。

## 模拟重签

### 阳性对照（合法 pass 报告）

在 clone 中把 G1 的 audit_round 改为 9、audit_report 指向 docs/audits/S1-independent-audit-round9.md，报告写门名 G1、候选提交 379fd22…、结论 pass，提交后 sign-gate，再提交签后的 G1，运行 gate-check：

- sign-gate exit 0：candidate=72a72d0a10bb…，artifact_hash=2bb40f7dd3c2…，body_hash=5f265743a2a9…，改动文件 89 个。
- gate-check exit 0：「gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=2bb40f7dd3c2… body_hash=5f265743a2a9…）」。
- 该结果证明门禁机制本身可以签过，P1-1 的绕过不是「签不过」造成的假阳性。

### 用本报告（fail）重签

按同一流程把本报告复制进 clone、G1 的 audit_report_sha256 置 64 个 0、提交后运行 sign-gate：

- sign-gate exit 1，错误「审计报告结论与门记录结论不符：报告=fail，门记录=pass」（checkAuditAnchor，scripts/gate-check.ts:723）。
- 随后 gate-check exit 1，首个错误「审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 报告实际哈希」（数值随报告版本变化）。
- 这是 fail 报告不能签成 pass 的预期行为，不为了让门过而改报告结论。

## P2

1. G-08 证据对 503/warning 的覆盖不充分。docs/gates/evidence/G1/G-08.md:20 只写「第二个写者报 busy：true；队列溢出码：SERVICE_UNAVAILABLE」，没有直接记录 HTTP 503 与 warning 日志；tests/write-queue.spec.ts:20-42 有「满时 503、记 warning、不落账本」的测试，但 G-08.md 未引用该断言的证据。建议把 503 响应与 warning 原文补进 G-08 证据。
2. I1 单写者锁缺少直接测试。src/infra/lock.ts:4 用 proper-lockfile 实现 acquireDbLock，但 tests 目录按 lock、单写者、writer、proper-lockfile 检索无命中；没有覆盖「第二个进程拿锁失败/释放后可再拿」的用例，I1 的证据目前主要落在 epoch 栅栏与并发写测试上。
3. 事件表 append-only 没有 DB 层约束。src/infra/sqlite/migrations/001_init.sql:61-75 的 events 表只有普通列与唯一约束，没有阻止 UPDATE/DELETE 的触发器或约束；哈希链能检出篡改，但不能在数据库层拒绝改写。与 I2 的「只追加」表述存在口径差。
4. 迁移缺号没有测试。tests/migrate.spec.ts:87-93 只测编号重复（001_a 与 001_b）会抛 SCHEMA_VERSION_UNSUPPORTED，没有测 001 后直接 003 的缺号场景；loadSteps 是否拒绝缺号未被固定。
5. 全量测试未全绿。在 round9 已签的阳性对照状态运行 vitest：Test Files 1 failed | 31 passed（32 个），Tests 2 failed | 301 passed（303 个）。两例都在 tests/gate-check.spec.ts：:151 用 indexOf 查找三个反引号加 json invariants 的围栏头，在 CRLF 检出下匹配不到不变量块，报「G1 里没有 invariants 块」；:206-208 把 audit_round 篡改为 9，但在 round9 状态下等于没改，于是不抛错。tsc --noEmit exit 0。该两例是测试自身的 CRLF 与轮次假设问题，不构成门校验绕过，但按「全量测试全绿」口径本轮不能给 pass。

## 附：主仓库与临时目录状态

- 临时目录 D:/aboutAI/_audit_s1_r9 及其中的 clone 已删除。
- 主仓库除新增本报告 docs/audits/S1-independent-audit-round9.md 外无改动；docs/gates、scripts、tests 未改。
