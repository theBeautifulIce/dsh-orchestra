# S1/G1 第五轮独立审计报告

- 审计对象：D:/aboutAI/dsh-orchestra
- 起点 HEAD：f7ebe69c623a2d64cf8686449091070d5cd58565（f7ebe69 Harden gate conclusion parsing and body table coverage）
- 审计范围：S1/G1 门记录与 scripts/gate-check.ts、第四轮 P1-1/P2-1 复核、f7ebe69 回归、类型检查与测试
- 审计方式：只读；未修改业务代码、未签门、未提交；唯一新增文件为本报告
- 审计时间：2026-11-13

结论：fail

## 一、结论摘要

| 级别 | 编号 | 判定 | 位置 | 摘要 |
| --- | --- | --- | --- | --- |
| P0 | 无 | 无 | — | 未发现新的 P0。 |
| P1 | P1-1 | 阻断 | scripts/gate-check.ts:503、:517-520、:524-525 | 同行“pass + 仍有 1 个 P0 未闭合”的 canonical 结论行仍返回 pass，并可端到端签成 G1 pass。 |
| P2 | P2-1 | 不阻断 | scripts/gate-check.ts:501、:507-515 | 列表项与引用块前缀的 fail 结论仍被忽略；正文只有一条 canonical pass 行时，可见的 fail 行不参与判定。 |
| P2 | P2-2 | 不阻断 | scripts/gate-check.ts:504 | “审计意见 / 最终判定 / 结果 / 最终结论”等同义结论未纳入候选；只写同义结论时返回 null（fail-closed），但 canonical pass 加同义 fail 时读成 pass。 |
| P2 | P2-3 | 不阻断 | scripts/gate-check.ts:496-499 | 围栏内的 fail 结论按“示例”设计跳过；canonical pass 加围栏 fail 时读成 pass，建议在文档里明示。 |
| P2 | P2-4 | 不阻断 | docs/gates/evidence/G1/G-08.md:20 | G-08 证据仍只有 SERVICE_UNAVAILABLE，缺 HTTP 503 与 warning 的明确证据；第四轮 P2-2 未闭合。 |
| P2 | P2-5 | 不阻断 | scripts/gate-check.ts:530-555 | 审计报告未绑定门名与候选哈希；旧轮次或同一轮次的 pass 报告可在满足文件名轮次时被复用。第四轮 P2-4 未闭合。 |

第四轮的两条主问题均已有实质修复：P1-1 的原始组合（两行 canonical 结论，一行 pass、一行 fail）现在返回 null 并被 sign-gate 拒绝；P2-1 的两张正文表已能拒绝重复 id、删行复制和集合不一致，正常 G1 表仍通过。残留问题集中在“同一行 canonical pass 后面跟阻塞项 caveat”这一条，影响与第四轮 P1-1 相同，故本轮判 fail。

## 二、P0 清单

无。

## 三、P1 清单

### P1-1 同行阻塞项 caveat 仍可签成 pass

位置：scripts/gate-check.ts:503 的 tail、:517-520 的相反 token 检查、:524-525 的唯一结论返回。

直接函数实测：

~~~
auditConclusionOf('结论：pass — 但仍有 1 个 P0 未闭合')  -> 'pass'
auditConclusionOf('结论：pass（仍有 1 个 P0 未闭合）')    -> 'pass'
~~~

同一行同时出现 pass 与 P0 未闭合，函数返回 pass，而不是 null。原因有两层：

1. scripts/gate-check.ts:503 的 tail 允许破折号后任意文本，也允许括号补充；具体正则允许可选加粗、句末标点、括号补充与破折号尾缀。
2. scripts/gate-check.ts:517-520 的相反 token 检查只认 pass/fail/通过/不通过，不认 P0、P1、致命、未闭合、阻塞。于是“pass — P0 未闭合”没有任何相反 token，被当作合法 pass。

端到端复现（临时克隆 C:/Users/ASUS/AppData/Local/Temp/s1r5/repo，不在真实仓库内）：

1. 审计报告只写一行 `结论：pass — 但仍有 1 个 P0 未闭合`。
2. 运行 sign-gate，exit 0：
   ~~~
   重签完成：证据 13 份，candidate=2728b9604212fa2d…，artifact_hash=8f19922b3440…，body_hash=9751c082ca03…，改动文件 89 个
   ~~~
3. 提交克隆内 G1 后运行 gate-check，exit 0：
   ~~~
   gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=8f19922b3440… body_hash=9751c082ca03…）
   ~~~

这条路径不需要改任何哈希、证据或正文表，只需要报告作者在 canonical pass 行后面加一句“但仍有 1 个 P0 未闭合”。按本项目“P0/P1 阻断 pass”的判定口径，这句话本身已宣告报告不应通过，门却签成 pass，属于审计锚点失效，定 P1。

为什么不是 P2：它不是“行内引用”或“同义写法”的边角，而是 canonical 结论行内部的矛盾；scripts/gate-check.ts:517-520 本来就有同行相反 token 的防御，只是词表没有覆盖阻塞级别。修复范围很小：pass 结论的 tail 出现 P0、P1、致命、未闭合、阻塞等词时返回 null；括号补充同样处理；在 tests/gate-check.spec.ts:234-274 增加同行与括号两条回归。

补充说明：这不是 f7ebe69 引入的新回归。第四轮的原始组合在 f7ebe69 后已被拒绝；本轮发现的是同一防御未覆盖的残留边界。

## 四、P2 清单

### P2-1 列表项与引用块前缀的 fail 结论被忽略

位置：scripts/gate-check.ts:501 只剥行首标题与加粗，:507-515 只把行首 `结论/判定/建议` 当候选。行首为 `-` 或 `>` 的结论行既不被解析，也不触发候选，直接跳过。

端到端实测：

- 报告写 `结论：pass` 加 `- 结论：fail，仍有 1 个 P0 未闭合`：sign-gate exit 0，artifact_hash=4dded0ef723d…，body_hash=fd911449a915…，gate-check exit 0。
- 报告写 `结论：pass` 加 `> 结论：fail，仍有 1 个 P0 未闭合`：sign-gate exit 0，artifact_hash=d97dde77b193…，body_hash=bdef56661c68…，gate-check exit 0。

按 tests/gate-check.spec.ts:235-238 的既定口径，行内引用不算结论，因此这里按 P2 记录；但列表项和引用块是新起一行，人读起来仍是 fail 声明，建议要么把 `-`、`*`、`>` 前缀剥掉后纳入候选，要么在门规范里写明“只有行首无前缀的 canonical 行才算结论”。

### P2-2 同义结论未纳入候选

位置：scripts/gate-check.ts:504 的主正则只认 `(审计)?(结论|判定)`，备用正则只认 `建议`。

实测：

- 只写 `审计意见：不通过`、`最终判定为不通过`、`结果：fail`、`最终结论：fail`：均返回 null。也就是说，单独使用这些同义写法时是 fail-closed，签门会因找不到唯一结论而失败，不会误签 pass。
- 但写 `结论：pass` 再加 `审计意见：不通过`、`最终判定为不通过`、`结果：fail`、`最终结论：fail`：返回 pass，sign-gate 成功（同义报告示例 artifact_hash=a5b113704096…，body_hash=f0d1dc1995f3…）。

影响低于 P1：必须同时写 canonical pass 才会误签；但既然“审计意见 / 最终判定 / 结果”在中文报告里很常见，建议把同义写法纳入候选或明确列为不支持。

### P2-3 围栏内 fail 按“示例”跳过

位置：scripts/gate-check.ts:496-499 在围栏内直接 continue；tests/gate-check.spec.ts:269-273 明确把围栏内容当示例。

实测：报告写 `结论：pass` 加围栏内 `结论：fail`：sign-gate exit 0，artifact_hash=f847c1a5dc9d…，body_hash=4bf426a8efe1…，gate-check exit 0。按“围栏是示例”的设计，这不算缺陷；建议在门规范里补一句“引用旧结论必须放围栏，围栏内容不参与判定”，避免作者误以为围栏里的 fail 会被采纳。

### P2-4 G-08 证据缺 503 与 warning

docs/gates/evidence/G1/G-08.md:20 的对账查询仍只有：

~~~
长事务期间读路径返回 1 条（不为 0 即没被拖死）；第二个写者报 busy：true；队列溢出码：SERVICE_UNAVAILABLE
~~~

没有 HTTP 503 状态码与 warning 字段的明确证据。第四轮 P2-2 未闭合，本轮继续列为 P2。注入脚本确实返回 SERVICE_UNAVAILABLE，但证据文本没有把 503 和 warning 写实，读者无法只凭证据确认这两项。

### P2-5 审计报告未绑定门名与候选哈希

位置：scripts/gate-check.ts:530-555 只校验报告路径在 docs/audits/、文件名轮次、HEAD 字节 sha256 与唯一结论，不校验报告属于哪道门、针对哪个候选。

实测：在临时克隆里把 G1 的 audit_round 改为 3、audit_report 指向 docs/audits/S1-independent-audit-round3.md（一份旧的 pass 报告），重签成功，artifact_hash=cc36740fd3e8…，body_hash=df35cdd70815…，gate-check exit 0。第四轮 P2-4 未闭合。

影响：只要旧报告文件名里的轮次与 audit_round 对上、结论为 pass、且 sha 记录正确，就可以拿旧报告给新候选签门。建议在报告头部或 artifact 里加入门名与 candidate_hash，并在 checkAuditAnchor 里比对。

## 五、第四轮 P1-1 复核矩阵

以下结果来自直接调用 auditConclusionOf 的矩阵脚本（C:/Users/ASUS/AppData/Local/Temp/s1r5/conclusion-matrix.mjs）与克隆端到端签门。返回值列是函数结果；签门列是 end-to-end 结果。

| # | 写法 | 返回值 | 签门结果 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 第四轮原始组合：一行 `结论：pass`，下一行 `结论：fail，仍有 1 个 P0 未闭合` | null | 拒绝：审计报告里找不到唯一结论行 | 已修复 |
| 2 | 加粗 `**结论：fail（P0）**` 与 pass 组合 | null | 拒绝 | 已修复 |
| 3 | 标题 `##结论：fail` 与 pass 组合（# 后无空格） | null | 拒绝 | 已修复 |
| 4 | `结论：pass` 换行 `建议：fail` | null | 拒绝 | 已修复 |
| 5 | `判定：fail` 与 pass 组合 | null | 拒绝 | 已修复 |
| 6 | `审计结论：fail` 与 pass 组合 | null | 拒绝 | 已修复 |
| 7 | `结论：FAIL` 与 pass 组合 | null | 拒绝 | 已修复 |
| 8 | 裸 `pass` 加 `结论：fail` | null | 拒绝 | 已修复 |
| 9 | 两行 canonical 不同结论（任意顺序） | null | 拒绝 | 已修复 |
| 10 | 仅 `结论：pass` | pass | 签成 pass | 正常 |
| 11 | 仅 `结论：fail` | fail | 拒绝签 pass | 正常 |
| 12 | 仅 `结论：通过` | pass | 签成 pass | 正常 |
| 13 | 仅 `结论：不通过` | fail | 拒绝签 pass | 正常 |
| 14 | 仅 `建议：fail` | null | 拒绝 | 正常（不支持裸建议） |
| 15 | 仅同义 `审计意见 / 最终判定 / 结果 / 最终结论` | null | 拒绝 | fail-closed |
| 16 | `结论：fail` 加 `- 结论：pass` | fail | 拒绝签 pass | fail-closed，安全 |
| 17 | `结论：pass` 加同行 `— 但仍有 1 个 P0 未闭合` | pass | 签成 pass | P1-1（本轮） |
| 18 | `结论：pass` 加同行括号 `（仍有 1 个 P0 未闭合）` | pass | 签成 pass | P1-1（本轮） |
| 19 | `结论：pass` 加列表项 `- 结论：fail，仍有 1 个 P0 未闭合` | pass | 签成 pass | P2-1 |
| 20 | `结论：pass` 加引用块 `> 结论：fail，仍有 1 个 P0 未闭合` | pass | 签成 pass | P2-1 |
| 21 | `结论：pass` 加围栏内 `结论：fail` | pass | 签成 pass | P2-3（设计） |
| 22 | `结论：pass` 加 `审计意见：不通过` / `最终判定为不通过` / `结果：fail` / `最终结论：fail` | pass | 签成 pass | P2-2 |
| 23 | `结论：pass` 加行内引用 `门记录结论：pass` 与 `结论：fail` | fail | 拒绝签 pass | 按行内引用规则忽略，安全 |
| 24 | 仅 `> 结论：pass` | null | 拒绝 | 按行内引用规则 |
| 25 | 仅 `- 结论：fail` | null | 拒绝 | 按行内引用规则 |
| 26 | `结论：fail` 换行 `- 结论：pass` | fail | 拒绝签 pass | fail-closed，安全 |
| 27 | 同行 `结论：pass` 与 `结论：fail` | null | 拒绝 | 已修复 |

小结：第四轮报告里的原始组合、加粗、标题、括号、破折号、大小写、判定/建议、多结论、裸结论等写法均已被拒绝；仍能读成 pass 的是第 17、18 行的同行阻塞项 caveat（P1），以及第 19-22 行的列表/引用/围栏/同义写法（P2 或设计边界）。未发现“fail 报告读成 pass”之外的反向问题：pass 报告读成 fail 需要 canonical fail 行，当前只会 fail-closed，不会误签 pass。

## 六、第四轮 P2-1 复核矩阵

对象是真实 G1 文本（13 份证据、4 条不变量），直接调用 checkBodyEvidenceTable 与 checkBodyInvariants。

| # | 变异 | 结果 |
| --- | --- | --- |
| 1 | 基线，不改 | PASS |
| 2 | 证据表 g15 改成 g08（重复 id） | 拒绝：正文证据表里证据重复: ev-g08 |
| 3 | 删 ev-g15 行，复制 ev-g08 行 | 拒绝：正文证据表里证据重复: ev-g08 |
| 4 | 删一行，保留 12 行 | 拒绝：正文证据表有 12 行，artifact 列了 13 份证据 |
| 5 | 加一行，14 行 | 拒绝：正文证据表有 14 行，artifact 列了 13 份证据 |
| 6 | 行数相同，把 ev-g15 换成 ev-unknown | 拒绝：正文证据表里有 artifact 没有的证据: ev-unknown |
| 7 | 改 ev-g15 的文件列 | 拒绝：正文证据表里 ev-g15 的文件与 artifact 不一致: docs/gates/evidence/G1/G-14.md != docs/gates/evidence/G1/G-15.md |
| 8 | 改 ev-g15 的 sha256 | 拒绝：正文证据表里 ev-g15 的 sha256 与 artifact 不一致（证据被改过或表没跟着改） |
| 9 | 证据行换序 | PASS（集合等价，行序不敏感） |
| 10 | 不变量表 I10 改成 I1（重复 id） | 拒绝：正文不变量表里不变量重复: I1 |
| 11 | 删 I10 行，复制 I1 行 | 拒绝：正文不变量表里不变量重复: I1 |
| 12 | 删一行，保留 3 行 | 拒绝：正文不变量表有 3 行，artifact 列了 4 条不变量 |
| 13 | 加一行，5 行 | 拒绝：正文不变量表有 5 行，artifact 列了 4 条不变量 |
| 14 | 行数相同，I10 换成 I3 | 拒绝：正文不变量表里 I3 的说明与 artifact 不一致 |
| 15 | 改 I10 的说明 | 拒绝：正文不变量表里 I10 的说明与 artifact 不一致 |
| 16 | 改 I3 的证据列表 | 拒绝：正文不变量表里 I3 的证据与 artifact 不一致: ev-g01 != ev-g01,ev-g02 |
| 17 | 不变量行换序 | PASS（集合等价，行序不敏感） |
| 18 | 正常 G1 表 | PASS |

小结：第四轮 P2-1 的三个核心攻击（重复 id、删行复制、行数相同集合不同）均已被拒绝；两张表的正常 G1 文本仍通过。行序与证据列表顺序不敏感属于集合比较的预期行为，不构成本轮缺陷。

## 七、G1 门机制逐项复核

复核方式：在临时克隆里构造一份已签 G1 基线（artifact_hash=cc36740fd3e8…，body_hash=df35cdd70815…），然后逐项改坏并调用 verifyGateRecord。基线本身 PASS。该基线的具体哈希与真实 G1 不同，但门机制的代码路径相同，用于验证“该拒的会不会拒”。

### 7.1 13 项固定必过项与证据映射

固定清单顺序为 G1-01、G1-02、G1-03、G1-04、G1-05、G1-06、G1-07、G-01、G-02、G-08、G-09、G-14、G-15：

| 序号 | id | 固定证据 |
| --- | --- | --- |
| 1 | G1-01 | ev-migrate |
| 2 | G1-02 | ev-g14 |
| 3 | G1-03 | ev-g02 |
| 4 | G1-04 | ev-backup |
| 5 | G1-05 | ev-g15 |
| 6 | G1-06 | ev-auth |
| 7 | G1-07 | ev-phase |
| 8 | G-01 | ev-g01 |
| 9 | G-02 | ev-g02 |
| 10 | G-08 | ev-g08 |
| 11 | G-09 | ev-g09 |
| 12 | G-14 | ev-g14 |
| 13 | G-15 | ev-g15 |

证据文件固定映射共 16 项（13 个必过证据加 ev-chain、ev-epoch、ev-gatecheck）：

| 证据 id | 文件 |
| --- | --- |
| ev-auth | tests/auth.spec.ts |
| ev-backup | tests/backup.spec.ts |
| ev-chain | tests/hash-chain.spec.ts |
| ev-epoch | tests/db-open.spec.ts |
| ev-g01 | docs/gates/evidence/G1/G-01.md |
| ev-g02 | docs/gates/evidence/G1/G-02.md |
| ev-g08 | docs/gates/evidence/G1/G-08.md |
| ev-g09 | docs/gates/evidence/G1/G-09.md |
| ev-g14 | docs/gates/evidence/G1/G-14.md |
| ev-g15 | docs/gates/evidence/G1/G-15.md |
| ev-gatecheck | tests/gate-check.spec.ts |
| ev-migrate | tests/migrate.spec.ts |
| ev-phase | tests/config.spec.ts |

实测：删一项或换序均拒绝（必过项清单不符：期望 G1-01,…,G-15）；把 G1-01 的证据由 ev-migrate 换成 ev-backup 拒绝（必过项 G1-01 的证据与固定映射不一致（换绑证据不许重签））。

### 7.2 证据 HEAD 字节 sha256 与 evidence-index

实测：改 evidence-index 里 ev-auth 的文件路径，拒绝（证据 ev-auth 的文件与固定映射不一致）；改 ev-auth 的 sha256，拒绝（证据文件 sha256 不符: ev-auth（记录 000… 实际 13f123174be3…））；改 evidence_index_hash，拒绝（evidence_index_hash 与证据索引不符）；改 invariants_hash，拒绝（invariants_hash 与不变量清单不符：000… != 6f75465bfb0e…）。

证据哈希按 HEAD 读取文件、LF 归一后计算；13 份记录的哈希与实算值见第八节。

### 7.3 audit_report 路径、sha256、轮次与结论

实测：

- audit_report 指向 docs/gates/G1.md：拒绝（必须是 docs/audits/ 下的 Markdown 报告）。
- audit_report 指向 HEAD 不存在的文件：拒绝（审计报告不在 HEAD 里）。
- audit_report_sha256 改错：拒绝（审计报告 sha256 与记录不符）。
- 文件名轮次与 audit_round 不一致：拒绝（audit_round 与审计报告的轮次不一致: 2 != 3）。
- 把 G1 绑到真实 fail 报告 docs/audits/S1-independent-audit-round4.md（audit_round=4，sha 按 HEAD 实算）：拒绝（审计报告结论与门记录结论不符：报告=fail，门记录=pass）。
- 结论行唯一性与结论值相等：本报告第五节的矩阵已覆盖；正常 pass 报告通过，原始 P1-1 组合被拒。

### 7.4 前序链、正文表、candidate / change_scope、body_hash

实测：

- 第一道门的 previous_artifact_hash 非零：拒绝（第一道门的 previous_artifact_hash 必须是 64 个 0）。
- 正文必过项内容列改：拒绝（正文表里 G1-01 的内容与固定表不一致）。
- 正文证据表 sha 改：拒绝（sha256 与 artifact 不一致）。
- 正文不变量说明改：拒绝（说明与 artifact 不一致）。
- candidate_hash 改：拒绝（与候选文件不符）。
- change_scope_hash 改：拒绝（与改动清单不符）。
- body_hash 改：拒绝（body_hash 与正文不符）。
- artifact_hash 改：拒绝（artifact_hash 与正文不符）。
- conclusion 改 fail：拒绝（conclusion 不是 pass）。
- 工作树有未提交改动：拒绝（工作树有未提交改动，门记录不能对着脏树签：?? dirty-probe.txt）。

### 7.5 机制变异矩阵汇总

| # | 变异 | 拒绝信息（摘要） |
| --- | --- | --- |
| 1 | 基线 | PASS |
| 2 | 必过项删一项 | 必过项清单不符：期望 G1-01,…,G-15 |
| 3 | 必过项换序 | 必过项清单不符：期望 G1-01,…,G-15 |
| 4 | G1-01 换绑 ev-backup | 必过项 G1-01 的证据与固定映射不一致（换绑证据不许重签） |
| 5 | evidence-index 改文件 | 证据 ev-auth 的文件与固定映射不一致 |
| 6 | evidence-index 改 sha | 证据文件 sha256 不符: ev-auth |
| 7 | evidence_index_hash 改 | evidence_index_hash 与证据索引不符 |
| 8 | invariants_hash 改 | invariants_hash 与不变量清单不符 |
| 9 | audit_report 指门文件 | 必须是 docs/audits/ 下的 Markdown 报告 |
| 10 | audit_report 不在 HEAD | 审计报告不在 HEAD 里 |
| 11 | audit_report_sha256 错 | 审计报告 sha256 与记录不符 |
| 12 | 轮次不一致 | audit_round 与审计报告的轮次不一致: 2 != 3 |
| 13 | 首门前序非零 | 第一道门的 previous_artifact_hash 必须是 64 个 0 |
| 14 | 正文必过项内容改 | 正文表里 G1-01 的内容与固定表不一致 |
| 15 | 正文证据表 sha 改 | sha256 与 artifact 不一致 |
| 16 | 正文不变量说明改 | 说明与 artifact 不一致 |
| 17 | candidate_hash 改 | 与候选文件不符 |
| 18 | change_scope_hash 改 | 与改动清单不符 |
| 19 | body_hash 改 | body_hash 与正文不符 |
| 20 | artifact_hash 改 | artifact_hash 与正文不符 |
| 21 | conclusion 改 fail | conclusion 不是 pass |
| 22 | 绑真实 fail 报告 | 审计报告结论与门记录结论不符：报告=fail，门记录=pass |
| 23 | 脏树 | 工作树有未提交改动，门记录不能对着脏树签 |

除 P1-1 的同行 caveat 外，7.1-7.4 的机制均按预期拒绝；未发现 13 项清单可截短、证据可换绑、报告可绕过轮次/路径/sha、正文表可少行、哈希可改而不被发现的新路径。

## 八、G1 13 份证据哈希复核

复核方法：对每个证据路径执行 git show HEAD:路径，按 LF 归一，重算 SHA-256；记录值取自 docs/gates/G1.md:33-45 与 evidence-index 块。结果如下（记录与实算均为 64 位十六进制）：

| 证据 id | 文件 | 记录值 | 实算值 | 状态 |
| --- | --- | --- | --- | --- |
| ev-auth | tests/auth.spec.ts | 13f123174be3f02ade0070a764720ed5c892d8b72f58836403c05da5671863c8 | 13f123174be3f02ade0070a764720ed5c892d8b72f58836403c05da5671863c8 | OK |
| ev-backup | tests/backup.spec.ts | 8b8d5413025230565c5137854cdeaf517e3c87e542ee55f33df727f795b4b954 | 8b8d5413025230565c5137854cdeaf517e3c87e542ee55f33df727f795b4b954 | OK |
| ev-chain | tests/hash-chain.spec.ts | e15bb381cd74e028a53a7ea8ced03180c248751b8ff06e8b995c2b7ed785d90f | e15bb381cd74e028a53a7ea8ced03180c248751b8ff06e8b995c2b7ed785d90f | OK |
| ev-epoch | tests/db-open.spec.ts | 78263f1ca785f67e78adb70f874657c8bd5d137b99d486827c02e913ba3b91ed | 78263f1ca785f67e78adb70f874657c8bd5d137b99d486827c02e913ba3b91ed | OK |
| ev-g01 | docs/gates/evidence/G1/G-01.md | f2626b30f9eb472f1268b71047893be8f1d42a933438e43cd30af35d3318a129 | f2626b30f9eb472f1268b71047893be8f1d42a933438e43cd30af35d3318a129 | OK |
| ev-g02 | docs/gates/evidence/G1/G-02.md | 5fedb2e7539b1d410b7ff3c964ea36d77764fd037c4f4e40badbd67b7038b196 | 5fedb2e7539b1d410b7ff3c964ea36d77764fd037c4f4e40badbd67b7038b196 | OK |
| ev-g08 | docs/gates/evidence/G1/G-08.md | a50e5a17eafda7c0c782e3dc56d0c1e70d6b879cf566b5500b0a84dd260ef44a | a50e5a17eafda7c0c782e3dc56d0c1e70d6b879cf566b5500b0a84dd260ef44a | OK |
| ev-g09 | docs/gates/evidence/G1/G-09.md | e944a2b6bd299faed3f9ce98c72647ceb8580eaae412a997d7be6cdcc5376625 | e944a2b6bd299faed3f9ce98c72647ceb8580eaae412a997d7be6cdcc5376625 | OK |
| ev-g14 | docs/gates/evidence/G1/G-14.md | 3b2e37d9a0f6c6e49054dc4a27966e914755a56e6e8b9491d51ca3d213545169 | 44351757aa246ed7565ee17dae5ac172cf6a949be1d5d6f160945f4b53d83978 | STALE |
| ev-g15 | docs/gates/evidence/G1/G-15.md | db16d844f912cac0bedd81139a8238919b0d3f120469a6bdcfbcf7c73397cb0e | 334f26fb748d4013bdb0243f4a0e9d4ddd1e573fc4071114d9dffc0bb7dc03a3 | STALE |
| ev-gatecheck | tests/gate-check.spec.ts | c61262506e81f9bfb89f00afc55662a18a722ed1ed447f9dd8220f88ab8f93b2 | c0883f7a42b4a861ad71a90ffb7aa56fe4dc0c92f17b2bb6391f2aa0a49447ea | STALE |
| ev-migrate | tests/migrate.spec.ts | b3ad3fbde1ef16392af16b68cbab36d440ffd23b9a6e19a74fd6132da61d6ff1 | 6ec799698b7057df449cf24dfaeec4e3d86cb414da4d315bf86305d0fa1d26cf | STALE |
| ev-phase | tests/config.spec.ts | d2175cc5f420b046aa3640af7795055e5a0f4fd05b6e304d0c963fd5ba1d025a | d2175cc5f420b046aa3640af7795055e5a0f4fd05b6e304d0c963fd5ba1d025a | OK |

13 份中 9 份一致、4 份 STALE：ev-g14、ev-g15、ev-gatecheck、ev-migrate。其中 ev-g15 与 ev-gatecheck 可直接归因于 f7ebe69 的改动（G-15.md 改路径、tests/gate-check.spec.ts 加回归）；ev-g14 与 ev-migrate 在本轮起点即已过期，具体引入提交未逐一追溯。四份都属待重签，不作为本轮代码缺陷。

其余锚点复核：

| 锚点 | 记录值 | 实算值 | 状态 |
| --- | --- | --- | --- |
| candidate_hash | bbd322cf9d4ef5fb44a836ac8fd6edeb56b7c95ad34d1f80f29fe349fc4cc69e | 2728b9604212fa2d5665882079be0ea08a6018beda65707eb3be15c15a19447e | STALE |
| change_scope_hash | ea15eaba761c24c70ff1b724251b125c65fc9ba17f15f4bdb1dfc35ff646f4fb | 248737b6264e7b36ea9a9788235a16986c76225242b3b497540b78ad5f7fc65b | STALE |
| evidence_index_hash | fad4d531d22eef2968c6b7d5dce997f46162fa9fda12a98b1abf1aa6640a8d07 | 39b65720f59bf38fb5e9aba23f1d583f684a0493948fa7665e2fdc4e54d96eab | STALE |
| invariants_hash | 6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6 | 6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6 | OK |
| artifact_hash | 1ce80f6080fb2271ae7ba958c61127962951cb49262b75e5b1d8e7d161b82084 | f54dcae873f34a988ca7d6fbf5bd0b29ce68558acfd4007f0b477e49b65cc4ec | STALE |
| body_hash | 446357f9e00e384a35d7a4b77be48f0720cceebb61a4b5e1c4a9e8e27f17450c | aea5ac30bdb768e4762b29cb36170004360cbfa24faa4da2ae433536c161a2b2 | STALE |
| audit_report_sha256 | 0000000000000000000000000000000000000000000000000000000000000000 | 50ba1b13cdf1b84d5a948b2bc6deb25c7ec9963b4435154a5487683329390003 | STALE（待签占位） |

说明：candidate_hash、change_scope_hash、evidence_index_hash、artifact_hash、body_hash 的 STALE 与 G1 未重签一致；invariants_hash 仍准确；audit_report 指向 docs/audits/S1-independent-audit.md，该报告没有唯一结论（auditConclusionOf 返回 null），且 sha 记录是 64 个 0，所以 checkAuditAnchor 会在写报告 sha 的检查处早退。

## 九、类型检查与测试（真实输出）

### 9.1 类型检查

命令：

~~~
D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit
~~~

真实结果：TSC_EXIT=0，无 stdout、无 stderr。

### 9.2 真实仓库的指定测试

命令：

~~~
D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/gate-check.spec.ts tests/integration/g1.spec.ts --reporter=verbose
~~~

真实结果：VITEST_EXIT=1；Test Files 1 failed | 1 passed (2)；Tests 10 failed | 30 passed (40)。

10 个失败用例全部在 tests/gate-check.spec.ts：

1. G1 门记录通过
2. 改 candidate_hash 但锚点不动也要拒
3. 证据文件哈希被改要拒
4. evidence_index_hash 改一处要拒
5. candidate_hash 变了要拒
6. 正文必过项的内容列被改要拒
7. 正文证据表里的哈希被改要拒
8. 正文不变量说明被改要拒
9. 证据文件与固定映射不一致要拒
10. 正文自锚 body_hash 被改要拒

10 例的共同错误是：

~~~
审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…
~~~

原因是 checkAuditAnchor 在 checkEvidence 和正文表之前执行，当前 G1 的 audit_report_sha256 还是 64 个 0，属于 G1 尚未按本报告重签的待签状态，不是本轮代码缺陷。

### 9.3 克隆已签基线的对照

在临时克隆里把 G1 重签成一份合法的 pass 记录（audit_round=3、报告用 docs/audits/S1-independent-audit-round3.md），再跑同一命令：

真实结果：VITEST_EXIT=0；Test Files 2 passed (2)；Tests 40 passed (40)。

这证明真实仓库的 10 个红例由 audit_report_sha256 占位早退导致；重签后应恢复 40/40。另在克隆里用本轮 P1-1 的同行 caveat 报告签成 pass 后，同一套测试仍是 40/40 全绿，说明测试没有覆盖“pass + P0 未闭合”这一变体，这是 P1-1 的测试缺口。

### 9.4 测试 stderr 说明

candidateEntries 的批内增删用例会触发预期内的 git 报错：

~~~
fatal: path 'gone.txt' does not exist in 'HEAD'
fatal: path 'gone.txt' does not exist in '1613…'
~~~

这些来自负例对不存在路径的探测，不影响用例通过，不是新缺陷。

## 十、f7ebe69 回归复核

### 10.1 改动面

~~~
f7ebe69 Harden gate conclusion parsing and body table coverage
 docs/audits/S1-independent-audit-round4.md | 150 +++++++++++++++++
 docs/audits/S2-independent-audit-round8.md | 255 +++++++++++++++++++++++++++++
 docs/gates/G2.md                           |   2 +-
 docs/gates/evidence/G1/G-15.md             |   2 +-
 scripts/gate-check.ts                      |  35 +++-
 tests/gate-check.spec.ts                   |  32 +++-
 6 files changed, 469 insertions(+), 7 deletions(-)
~~~

### 10.2 G-15 绝对临时路径

docs/gates/evidence/G1/G-15.md:3 已改为：

~~~
- 参数：{"db":"<tmp>/orchestra.db","backup":"<tmp>/backup-g15","tamper":"truncate 到一半"}
~~~

对 docs/gates 全目录搜索 AppData、C:/Users、Temp/orchestra 均 0 命中。第四轮 P2-3 已修复。

### 10.3 G2 的 action_timeout 表述

docs/gates/G2.md 的第六轮段落已改为：

~~~
动作总时限默认 120 秒，execution.action_timeout_ms 的配置接线留 S3（本轮只有默认值生效）
~~~

代码 src/executor/run-node.ts:38 为 DEFAULT_ACTION_TIMEOUT_MS = 120_000，:31 注释说明动作超时；表述与代码一致。第四轮指出的“写成读配置”问题已修复。

### 10.4 auditConclusionOf 对正常报告的回归

用本轮脚本对真实报告批跑：

| 报告 | 解析结果 | 说明 |
| --- | --- | --- |
| docs/audits/S1-independent-audit-round3.md | pass | 正常唯一结论 |
| docs/audits/S1-independent-audit-round4.md | fail | 末行 canonical fail |
| docs/audits/S2-independent-audit-round6.md | fail | 正常 fail |
| docs/audits/S2-independent-audit-round7.md | fail | 正常 fail |
| docs/audits/S2-independent-audit-round8.md | pass | 正常 pass |
| docs/audits/S1-independent-audit-round1.md | null | 多条/散文，拒绝 |
| docs/audits/S1-independent-audit-round2.md | null | 多条/散文，拒绝 |
| docs/audits/S2-independent-audit-round3.md | null | 散文式结论，拒绝 |
| docs/audits/S2-independent-audit-round4.md | null | 多条，拒绝 |
| docs/audits/S2-independent-audit-round5.md | null | 散文式判定，拒绝 |

正常的唯一结论报告均按预期解析；第四轮报告仍解析为 fail，没有因为 f7ebe69 的加固而变成 pass 或 null。未发现回归。

### 10.5 其他

- f7ebe69 导出了 checkBodyEvidenceTable 与 checkBodyInvariants，tests/gate-check.spec.ts 新增两表重复/覆盖用例；tsc 0，克隆 40/40 通过。
- 新增的两个审计报告为文档，不参与门计算（docs/audits 在 candidate excludes 内）。
- G-15 与 G2 的文本修改不改变门机制代码；对应的 ev-g15 与 ev-gatecheck 哈希过期属预期待签。

## 十一、待签状态说明

当前 G1 记录（docs/gates/G1.md）的待签事实：

- conclusion 为 pass（docs/gates/G1.md:178），但 audit_round=1、audit_report=docs/audits/S1-independent-audit.md、audit_report_sha256=64 个 0（:191-193）。
- 4 份证据哈希过期：ev-g14、ev-g15、ev-gatecheck、ev-migrate。
- candidate_hash、change_scope_hash、evidence_index_hash、artifact_hash、body_hash 均为旧值；invariants_hash 仍准确。
- gate-check 现在会停在“审计报告 sha256 与记录不符”；10 个测试红例均源于此。

这不是本轮代码缺陷，也不应当作 G1 已通过。重签顺序建议：

1. 先修 P1-1 的同行阻塞项 caveat，并补同行/括号回归；P2-1/P2-2 可按项目取舍一并加固。
2. 由人类维护者给出新的 pass 审计报告，audit_round=5，报告放 docs/audits/ 下，且全篇只有一个行首 canonical 结论。
3. 更新 G1 的 audit_report / audit_report_sha256 / evidence 哈希 / candidate_hash / change_scope_hash / evidence_index_hash / invariants_hash / artifact_hash / body_hash，然后签门并提交 G1。
4. G1 重签后 G2 的 previous_artifact_hash 会从 1ce80f… 变成新值，G2 必须重签，不能只改 G1。

## 十二、剩余风险

1. P1-1 未修前，任何“pass + P0/P1 未闭合”的 canonical 结论行都能签成 pass；这是本轮阻断项。
2. P2-1/P2-2 的列表、引用、同义写法在 canonical pass 存在时仍可制造“报告看得见 fail、门读成 pass”的观感差异；不阻断，但建议在门规范或解析器里收口。
3. P2-4 的 G-08 证据仍缺 503/warning；若后续把 G-08 当作验收证据，读者无法只凭证据确认这两项。
4. P2-5 的旧报告复用风险仍在；同轮次旧 pass 报告可给新候选签门，建议把门名与 candidate_hash 写进报告并校验。
5. 测试缺口：现有 40 例覆盖了原始 P1-1 组合、加粗、围栏、大小写，但没有覆盖“pass + P0 未闭合”的同行/括号变体；P1-1 修复时必须补上。
6. G1 重签会打断 G2 前序链；这是流程风险，不是代码缺陷，排期时要一起处理。
7. 本报告只做只读审计，未签门、未提交；本次审计新增的只有本报告，工作树中另有外部并行改动（handoff.md 修改、docs/audits/S2-independent-audit-round9.md 未跟踪），不属于本次审计操作。

## 附录 A：复核命令与脚本

真实仓库：

~~~
git rev-parse HEAD
git status --porcelain
D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit
D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/gate-check.spec.ts tests/integration/g1.spec.ts --reporter=verbose
git show --stat --oneline f7ebe69
~~~

临时脚本（均在 C:/Users/ASUS/AppData/Local/Temp/s1r5/，不污染仓库）：

- conclusion-matrix.mjs：直接调用 auditConclusionOf 的 27 例矩阵，并批跑真实报告。
- table-matrix.mjs：对真实 G1 文本做证据表/不变量表变异。
- clone-sign-driver.mjs：在临时克隆里用 7 种审计报告端到端签 G1。
- clone-baseline-sign.mjs：在临时克隆里重建已签 G1 基线。
- gate-mechanism-matrix.mjs：已签基线上的 21 个机制变异与脏树拒绝。
- hash-recompute.mjs：从 git show HEAD:路径 重算 13 份证据与六个锚点。

## 附录 B：审计边界

- 只读审计：未修改真实仓库的业务代码、门记录、证据或测试；未运行 sign-gate 对真实 G1 签名；未提交 git。
- 端到端签门与测试只在临时克隆 C:/Users/ASUS/AppData/Local/Temp/s1r5/repo 内进行，克隆的 node_modules 通过 junction 指向真实依赖，不写入真实仓库。
- 本次审计唯一新增文件是 docs/audits/S1-independent-audit-round5.md；写完后工作树中还有外部并行改动（handoff.md 修改、docs/audits/S2-independent-audit-round9.md 未跟踪），不是本次审计操作产生的，未纳入本次审计范围。
