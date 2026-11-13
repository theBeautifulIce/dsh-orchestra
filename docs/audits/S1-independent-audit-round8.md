# S1/G1 第八轮独立审计报告

审计对象：D:/aboutAI/dsh-orchestra，HEAD e022af35d6186778fd0daff8a7438888c468e314。审计开始时工作树干净；审计期间出现他人未跟踪文件 docs/audits/S2-independent-audit-round12.md，本报告未把它纳入判断，也未改动它。审计只读源码、HEAD 字节、证据与测试；攻击复现只在仓库外临时 clone 进行，未改主仓库业务代码、docs/gates，未跑 sign-gate，未提交 git。

结论：fail

P0=0，P1=4，P2=6。

## 一、P0

无。

## 二、P1

### P1-1 HEAD 的 G1 门记录与 HEAD 字节不一致，门检查 exit 1

- 位置：docs/gates/G1.md:193（audit_report_sha256）、:80-83（candidate_hash/change_scope_hash/evidence_index_hash/invariants_hash）、:197-198（artifact_hash/body_hash）、:41-44（ev-g14/ev-g15/ev-gatecheck/ev-migrate 哈希）；scripts/gate-check.ts:605、:609。
- 现象：按题目给定命令跑 G1，第一处失败就是审计报告哈希；报告记录为 64 个 0，HEAD 中 docs/audits/S1-independent-audit.md 的 LF 归一哈希是 50ba1b13cdf1b84d5a948b2bc6deb25c7ec9963b4435154a5487683329390003。继续按同样口径独立重算，candidate_hash、change_scope_hash、artifact_hash、body_hash 也与 HEAD 不符；13 份证据中 4 份不符。G1.md 最后一次改动是 c4f7b35，晚于它的解析器提交 d3ab0a4、f7ebe69、0919589、153353a、e022af3 都没有重新签 G1。
- 复现：

~~~
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md
exit 1
stderr: 门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…
~~~

- 独立重算结果：

| 锚点 | 记录值 | HEAD 字节重算 | 结果 |
| --- | --- | --- | --- |
| audit_report | 0000000000000000000000000000000000000000000000000000000000000000 | 50ba1b13cdf1b84d5a948b2bc6deb25c7ec9963b4435154a5487683329390003 | 不符 |
| candidate_hash | bbd322cf9d4ef5fb44a836ac8fd6edeb56b7c95ad34d1f80f29fe349fc4cc69e | 3281d7694bca5eb8dd5fd80dcb589349b261e71e2478fa7852543da609e087cd | 不符，89 个文件 |
| change_scope_hash | ea15eaba761c24c70ff1b724251b125c65fc9ba17f15f4bdb1dfc35ff646f4fb | 248737b6264e7b36ea9a9788235a16986c76225242b3b497540b78ad5f7fc65b | 不符，89 个路径 |
| evidence_index_hash | fad4d531d22eef2968c6b7d5dce997f46162fa9fda12a98b1abf1aa6640a8d07 | fad4d531d22eef2968c6b7d5dce997f46162fa9fda12a98b1abf1aa6640a8d07 | 相符 |
| invariants_hash | 6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6 | 6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6 | 相符 |
| artifact_hash | 1ce80f6080fb2271ae7ba958c61127962951cb49262b75e5b1d8e7d161b82084 | f54dcae873f34a988ca7d6fbf5bd0b29ce68558acfd4007f0b477e49b65cc4ec | 不符 |
| body_hash | 446357f9e00e384a35d7a4b77be48f0720cceebb61a4b5e1c4a9e8e27f17450c | aea5ac30bdb768e4762b29cb36170004360cbfa24faa4da2ae433536c161a2b2 | 不符 |

- 证据 9/13 相符：ev-auth、ev-backup、ev-chain、ev-epoch、ev-g01、ev-g02、ev-g08、ev-g09、ev-phase。4 份不符：

| 证据 | 记录值 | HEAD 字节重算 |
| --- | --- | --- |
| ev-g14 | 3b2e37d9a0f6c6e49054dc4a27966e914755a56e6e8b9491d51ca3d213545169 | 44351757aa246ed7565ee17dae5ac172cf6a949be1d5d6f160945f4b53d83978 |
| ev-g15 | db16d844f912cac0bedd81139a8238919b0d3f120469a6bdcfbcf7c73397cb0e | 334f26fb748d4013bdb0243f4a0e9d4ddd1e573fc4071114d9dffc0bb7dc03a3 |
| ev-gatecheck | c61262506e81f9bfb89f00afc55662a18a722ed1ed447f9dd8220f88ab8f93b2 | 4dd12c13d1db704407762f546e78cb0ffd3093736971c7331f28d7c8ee809406 |
| ev-migrate | b3ad3fbde1ef16392af16b68cbab36d440ffd23b9a6e19a74fd6132da61d6ff1 | 6ec799698b7057df449cf24dfaeec4e3d86cb414da4d315bf86305d0fa1d26cf |

- 影响：HEAD 的 G1 不能签出，也不能作为 S1 已过门的依据；全量 vitest 中 10 个门记录用例都卡在同一处。即便只修审计报告哈希，旧 S1 报告的结论行也会让门检查在 scripts/gate-check.ts:609 失败：docs/audits/S1-independent-audit.md 的可见结论是加粗的 G1 建议：不通过，不是行首结论行；docs/audits/S1-independent-audit-round3.md 有两处候选结论行，解析器返回 null。
- 严重度判断：P1，不是 P0。它让当前门记录不可用，但不造成生产账本数据损坏。

### P1-2 审计报告没有绑定门名与 candidate，旧 pass 报告可以复用

- 位置：scripts/gate-check.ts:587-613（checkAuditAnchor）、scripts/sign-gate.ts:64-68；docs/audits/S2-independent-audit-round8.md:20。
- 现象：checkAuditAnchor 只检查报告路径在 docs/audits 下、在 HEAD 中、文件名轮次等于 audit_round、LF 归一 sha256 等于记录、解析结论等于 artifact.conclusion；它不检查报告正文是否写了 G1，也不检查报告审计的 candidate 是否等于本门 candidate。sign-gate 只把报告字节哈希写进 artifact，不校验报告对象。于是 S2/G2 的 pass 报告可以被拿来给 G1 签字。
- 复现（临时 clone D:/aboutAI/_audit_s1_r8/e2e，审计后删除）：

~~~
git clone D:/aboutAI/dsh-orchestra e2e
# 改 src/core/canonical.ts 加一行注释，制造 G1 candidate 变化
# 把 G1.md 的 audit_round 改为 8，audit_report 改为 docs/audits/S2-independent-audit-round8.md
git commit -am candidate-change
node --no-warnings scripts/sign-gate.ts docs/gates/G1.md
node --no-warnings scripts/gate-check.ts docs/gates/G1.md
~~~

- 观察：sign-gate exit 0，输出 candidate=3c3833196286…、artifact_hash=fbe89f514653…、body_hash=a3c581c89cf4…、改动文件 89 个；签完提交后 gate-check exit 0，输出 gate G1 通过（13 项必过、13 份证据哈希复核）。docs/audits/S2-independent-audit-round8.md 是 27312 字节，line 20 是 结论：pass，其审计对象是 HEAD f572984、candidate 57 个路径，属于 S2/G2，不是 G1。相关 e2e 提交：d4e83c0、5dea59a、7ea3137。
- 影响：G1 可以在候选代码已变、且没有对 G1 做过独立审计的情况下拿到 pass；第六轮 P2-5 的旧 pass 报告复用问题没有修好，本轮按门可绕过定为 P1。

### P1-3 G1 的不变量语句没有被固定，I1 可以被削弱后重签通过

- 位置：docs/gates/G1.md:68（正文 I1 行）、:286（JSON invariants I1 statement）；scripts/gate-check.ts:288-308（checkInvariants）、:412-436（checkBodyInvariants）；scripts/sign-gate.ts:43-44（invariants_hash 直接按当前块重算）。
- 现象：checkInvariants 只要求 id、statement、evidence_ids 非空且证据 id 存在；checkBodyInvariants 只比较正文表与 JSON 块是否一致。GATE_SPECS.G1 没有固定的不变量语句清单。把 I1 从“单写者与 epoch 栅栏：同一个库只有一条写路径，越代次写被拒”改成“epoch 栅栏：越代次写被拒”，同时改正文行和 JSON 语句，sign-gate 会按新块重算 invariants_hash，gate-check 仍然通过。
- 复现（同一临时 clone）：

~~~
# 把 docs/gates/G1.md:68 和 :286 的 I1 语句同时改成更弱的版本
git commit -am weaken-i1
node --no-warnings scripts/sign-gate.ts docs/gates/G1.md
git commit -am signed
node --no-warnings scripts/gate-check.ts docs/gates/G1.md
~~~

- 观察：e2e 提交 50706b4 完成削弱；sign-gate exit 0，输出 candidate=3c3833196286…、artifact_hash=1bb7284bfa4c…、body_hash=dc0fab1730b0…、改动文件 89 个；提交 557a67a 后 gate-check exit 0，输出 gate G1 通过（13 项必过、13 份证据哈希复核）。13 项必过项、13 份证据都没有变，变的是不变量声明本身。
- 影响：门记录可以删掉单写者这一半承诺而继续显示通过；不变量哈希只证明“当前文本自洽”，不证明“文本没有被削弱”。这是门可绕过，P1。

### P1-4 结论解析器接受 HTML 注释、折叠块、缩进代码与引用围栏里的隐藏 pass

- 位置：scripts/gate-check.ts:493-531（auditConclusionOf）、:533-540（normalizeAuditLine）、:549-568（validConclusionTail）、:570-583（onlyCleanCounts）。
- 现象：解析器只识别普通围栏，且不跳过 HTML 注释、details 折叠块、缩进代码块、引用中的围栏。一个报告可以在可见正文写“本报告结论为不通过”，同时在 HTML 注释里放一行结论：pass；解析器会返回 pass。函数级观察：HTML 注释、details、四空格缩进、引用围栏四种写法里的隐藏 pass 都被接受；同一份报告的可见结论不是行首结论行，所以没有第二个候选来抵消。
- 复现（函数级）：

| 输入形态 | auditConclusionOf 观察 |
| --- | --- |
| 可见正文写不通过，HTML 注释内一行结论：pass | pass |
| 可见正文写不通过，details 折叠块内一行结论：pass | pass |
| 可见正文写不通过，四空格缩进的一行结论：pass | pass |
| 可见正文写不通过，引用围栏内一行结论：pass | pass |

- 端到端复现（同一临时 clone）：写 docs/audits/S1-independent-audit-round9.md，可见正文是“本报告结论为不通过：仍有 3 个重大项未闭合”，HTML 注释里放一行结论：pass；把 G1.md 的 audit_round 改为 9、audit_report 指向该文件；提交 6353d28。sign-gate exit 0，输出 artifact_hash=0897dbec8de0…、body_hash=c7177101a6dd…；提交签好的 G1 为 c6716d2；gate-check exit 0，输出 gate G1 通过（13 项必过、13 份证据哈希复核）。
- 影响：一份人眼读到的是 fail 的报告可以被门检查读成 pass；结论解析器仍可被隐藏文本绕过。第六轮 P1-1 的直接同义后缀已修，但这是新的解析器绕过，P1。

## 三、P2

### P2-1 G-08 证据没有写 HTTP 503 与 warning

- 位置：docs/gates/evidence/G1/G-08.md:20；docs/gates/G1.md:22（G-08 内容要求队列溢出报 503）；tests/integration/g1.spec.ts:22-26（只断言 busy 与 SERVICE_UNAVAILABLE）。
- 现象：G-08.md 只写“第二个写者报 busy：true；队列溢出码：SERVICE_UNAVAILABLE”，没有写 HTTP 503，也没有写 warning。实现与测试其实存在：src/service/write-queue.ts:23-34 会记 warning 并抛 SERVICE_UNAVAILABLE，src/core/errors.ts:12 把它映射成 503，tests/write-queue.spec.ts:20-49 断言 HTTP 503、warning 与未追加账本；但 ev-g08 指向的 G-08.md 和 integration/g1.spec.ts 都没有覆盖这两点。
- 复现：读 docs/gates/evidence/G1/G-08.md:20 与 tests/integration/g1.spec.ts:22-26，两处都只有 SERVICE_UNAVAILABLE/busy，没有 503/warning；再读 tests/write-queue.spec.ts:20-49 可见实现侧覆盖。

- 影响：G-08 的证据文本不足以支撑“队列溢出报 503”的门内容；属于证据覆盖缺口，P2。

### P2-2 I1 的单写者锁半部分没有测试覆盖

- 位置：docs/gates/G1.md:36（ev-epoch 指向 tests/db-open.spec.ts）；src/infra/lock.ts:4-6（proper-lockfile）；src/index.ts:116（openServiceOrchestra 取锁）；tests/db-open.spec.ts:107-122。
- 现象：tests 目录里没有任何用例引用 acquireDbLock 或 proper-lockfile；db-open.spec.ts 的“两个连接抢写”是同一个进程内两个连接、靠 SQLite busy_timeout，不是跨进程 proper-lockfile。ev-epoch 能证明 epoch 栅栏、回滚、CAS 和同进程写互斥，但不能证明第二个服务进程拿不到锁。
- 复现：在 tests 目录 grep acquireDbLock/proper-lockfile 为 0 命中；读 tests/db-open.spec.ts:107-122 为同进程两连接 busy_timeout；读 src/infra/lock.ts:4-6 可见锁实现但无对应用例。

- 影响：锁实现目前看起来是接上的，但门证据没有覆盖 I1 的单写者半部分；如果 proper-lockfile 失效，G1 仍可能全绿。属于证据覆盖缺口，P2；不是已复现的锁失效。

### P2-3 事件表只靠代码约定与哈希链检出，数据库层没有 append-only 约束

- 位置：src/infra/db/ledger.ts:17-41（只 INSERT）；schema 中没有禁止 UPDATE/DELETE 的 trigger；tests/hash-chain.spec.ts:50、:65 直接 UPDATE node_run_events、DELETE seq 2。
- 现象：生产 src 里没有更新或删除事件表的路径，append-only 是代码约定；哈希链能检出篡改，但数据库本身允许直写。测试正是用直写来证明链能检出。
- 复现：读 src/infra/db/ledger.ts:17-41 只有 INSERT；读 tests/hash-chain.spec.ts:50、:65 可见测试直接 UPDATE node_run_events、DELETE seq 2，再靠链校验检出。

- 影响：I2 的“只追加”不是数据库强制；拥有库文件写权限的代码或运维可以改历史，只能靠事后校验发现。P2。

### P2-4 迁移版本连续性没有测试，G1 的 [1,2,3,4] 只在当前文件集上成立

- 位置：src/infra/db/migrate.ts:24-39（loadSteps 只校验文件名和重复版本，不校验缺号）；tests/migrate.spec.ts:38-45（空库结果为 [1,2,3,4]、11 张表、重跑为空）。
- 现象：迁移表当前确实是 [1,2,3,4]，但加载器不拒绝 1,2,4 这样的缺号；测试也没有缺号用例。G1 证据层没有单独断言“恰好是 [1,2,3,4] 且不允许跳号”。
- 复现：读 src/infra/db/migrate.ts:24-39 可见无缺号校验；读 tests/migrate.spec.ts:38-45 只断言当前 [1,2,3,4] 与 11 张表，没有 1,2,4 的负例。

- 影响：未来加迁移时编号错误可能不会被单测拦住；当前四份迁移与 G1 声明一致。P2。

### P2-5 结论解析器对常见清零写法与引用/缩进 Markdown 有过严或过松

- 位置：scripts/gate-check.ts:570-583（onlyCleanCounts）；:533-540（normalizeAuditLine）。
- 现象：以下语义上等于零重大/零阻断的写法返回 null：结论：pass（重大 0）、结论：pass（P0 已清零）、结论：pass（P0 全部闭合）、结论：pass — 0 个阻断、结论：pass（不通过 0 项）、结论：pass（fail 0）。这些是误杀，报告作者会被迫改写。引用围栏内的 fail 加围栏外 pass 返回 null；缩进代码里的 fail 加围栏外 pass 返回 null；列表后接引用的“- > 结论：pass”返回 null，而“> - 结论：pass”返回 pass，归一化不一致。另一方面，“结论：pass — 均无”返回 pass，因为 onlyCleanCounts 把“均”“无”都当可剥离字符，语义偏松。
- 复现：用 scripts/gate-check.ts 的 auditConclusionOf 跑上述输入；返回 null/pass 的逐条结果见“已核项”的解析器矩阵。

- 影响：常见 Markdown 写法会造成误杀或误放；隐藏 pass 的绕过已单列为 P1-4，这里只记解析器健壮性。P2。

### P2-6 G1 头部候选仍是旧提交

- 位置：docs/gates/G1.md:4。
- 现象：头部写候选 10abcaa2dfc8b81a4a2d11f499839c7896042d06，不是 HEAD e022af35d6186778fd0daff8a7438888c468e314；scripts/sign-gate.ts 不更新这行，只重算 candidate_hash。门检查用的是 artifact 里的 candidate_hash，所以不是绕过，但人读的头部元数据已经过期。
- 复现：git show HEAD:docs/gates/G1.md 第 4 行写 10abcaa2…，git rev-parse HEAD 是 e022af35…；scripts/sign-gate.ts 只重算 candidate_hash，不更新这一行。

- 影响：人工复核容易被旧候选误导；P2。

## 四、已核项与命令输出摘要

- 仓库状态：git rev-parse HEAD 为 e022af35d6186778fd0daff8a7438888c468e314；审计开始时 git status --short 无输出；审计期间只有他人未跟踪的 docs/audits/S2-independent-audit-round12.md。
- G1 结构：必过项 13 项（G1-01..G1-07、G-01、G-02、G-08、G-09、G-14、G-15），证据文件 13 份，不变量 4 条（I1、I10、I2、I3）；正文证据表、正文不变量表与 JSON 块逐行对应，无重复 id，无缺失 id。13 份证据哈希 9 份相符、4 份不符；四个主哈希中 evidence_index_hash 与 invariants_hash 相符，candidate_hash、change_scope_hash、artifact_hash、body_hash 不符。
- 哈希重算：checkEvidence（scripts/gate-check.ts:254-286）从 HEAD 字节按 LF 归一重算每份证据的 sha256，checkBodyHash（:439-458）归一自锚后重算正文，artifact_hash（:696-699）从 canonicalJson 重算；没有发现“只改表内哈希字符串、不改文件”就能过门的路径。证据索引与不变量块按当前块重算，因此它们只证明块内自洽，不证明语句没有被削弱（见 P1-3）。
- 门检查：D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md，exit 1，第一处失败在 scripts/gate-check.ts:605，错误为审计报告 sha256 不符（0000… != 50ba1b13cdf1b84d…）。即使把审计报告哈希补齐，旧 S1 报告也会在 :609 因找不到唯一结论行失败。
- 类型检查：D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit，exit 0，无输出。
- 全量测试：D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run，32 个测试文件、299 个用例，289 passed、10 failed，exit 1。10 个失败全部在 tests/gate-check.spec.ts，第一处都卡在 scripts/gate-check.ts:605，错误同为 0000… != 50ba1b13cdf1b84d…。单跑 tests/gate-check.spec.ts 为 10 failed、29 passed（39）。
- 解析器必核攻击：结论：pass — 重大 3 返回 null；结论：pass（未收口）返回 null；建议：通过 返回 null；围栏内 fail、围栏外 pass 返回 pass；围栏内 pass、围栏外 fail 返回 fail；关闭围栏带 js 信息串 返回 null；结论：pass（P0=0，P1=0，P2=2）返回 pass；结论：pass — 致命 0、P0=0、P1=0 返回 pass。第六轮 P1-1 的这几类直接后缀绕过已修。
- 解析器复现命令（在仓库根跑）：

~~~
D:/NodeJs/node.exe --no-warnings -e "import('file:///D:/aboutAI/dsh-orchestra/scripts/gate-check.ts').then(m=>{const cs=['结论：pass — 重大 3','结论：pass（未收口）','建议：通过','结论：pass（P0=0，P1=0，P2=2）','结论：pass — 致命 0、P0=0、P1=0']; for(const s of cs) console.log(JSON.stringify(s), '=>', m.auditConclusionOf(s))})"
~~~

观察：依次输出 null、null、null、pass、pass。
- 报告绑定与不变量固定：checkAuditAnchor 没有门名/candidate 绑定；checkInvariants 没有固定语句清单。端到端分别用 S2 pass 报告签 G1、削弱 I1 后重签，sign-gate 与 gate-check 均 exit 0；详见 P1-2、P1-3。
- 隐藏结论：HTML 注释、details、缩进代码、引用围栏中的 pass 都被 auditConclusionOf 接受；端到端用可见 fail、隐藏 pass 的报告签 G1，sign-gate 与 gate-check 均 exit 0；详见 P1-4。
- DB 写路径：src/infra/sqlite/driver.ts 是唯一 import node:sqlite 的 src 文件；withTx 先 BEGIN IMMEDIATE，再读 service_meta.instance_epoch，与连接 epoch 不等抛 STALE_GENERATION；runCas 检查 changes 是否等于期望行数，不等抛 STALE_GENERATION；ledger 只有 appendEvent/appendNodeRunEvent 两条 INSERT；execSchema 校验 schema_migrations 的 checksum。
- 迁移：001_init.sql、002_s2_agent_loop.sql、003_s2_round3.sql、004_workflow_versions.sql；空库测试得到 [1,2,3,4] 与 11 张表；checksum 篡改测试、半途失败重入测试存在；缺号测试不存在。
- 锁：src/infra/lock.ts:4-6 用 proper-lockfile 锁 dbFile + .lock，realpath false、stale 10000；src/index.ts:116 在 openServiceOrchestra 中取锁；tests 目录无 acquireDbLock/proper-lockfile 引用；db-open.spec.ts:107-122 是同进程两连接，不是跨进程锁测试。
- G-08：write-queue 实现与 tests/write-queue.spec.ts:20-49 覆盖 503、warning、未追加账本；G-08.md 与 integration/g1.spec.ts:22-26 没写 503/warning。
- 旧报告：docs/audits/S1-independent-audit.md 的可见结论是加粗 G1 建议：不通过，不是行首结论行；docs/audits/S1-independent-audit-round3.md 有两处候选结论行，解析器返回 null；S1 第四、五、六轮报告为 fail；S2 第八、十轮报告为 pass。S2 第八轮报告被用于 P1-2 的复用攻击。
- sign-gate：只按 HEAD 字节重算证据哈希、证据索引、candidate/scope、artifact/body 哈希，并检查审计报告哈希与结论；不检查报告是否写 G1，不检查报告候选是否等于本门候选，不固定不变量语句。
- 复现脚本：D:/aboutAI/_audit_s1_r8/parser-attack.mjs（解析器矩阵）、hash-audit.mjs（G1 哈希重算）；e2e 克隆 D:/aboutAI/_audit_s1_r8/e2e（报告复用、削弱 I1、隐藏 pass 三次攻击）。这些临时文件在报告写入后删除。

## 五、未核项

- 没有单独重跑 scripts/fault-inject.ts 的 G-01、G-02、G-08、G-09、G-14、G-15 六个 case；只读了证据、integration/g1.spec.ts 和全量 vitest 结果，未做进程级 kill、备份截断/恢复的现场重放。因此这六项的语义正确性只按证据文本与测试覆盖核，未按故障注入现场逐条复验。
- 没有用两个真实服务进程做 proper-lockfile 的跨进程锁测试；仓库里也没有这样的测试。P2-2 是静态覆盖判断，不是锁失效的现场复现。
- 没有逐条独立重跑 13 个必过项的行为；本轮把重点放在门记录字节、证据哈希、解析器、报告绑定、不变量固定和写路径静态检查，并跑了全量 vitest。
- 没有审计 S2/G2 门本身；P1-2 只把 S2 报告当作 G1 的报告复用攻击材料。
- 没有在主仓库跑 sign-gate，也没有改主仓库的 docs/gates 或业务代码；所有签名攻击都在临时 clone 中完成。
- 没有复核 fault-inject 生成的证据是否与当前 HEAD 的注入输出逐字一致；只核了证据文件哈希与门记录、正文表、测试引用是否一致。
