# S2 独立审计（第 21 轮）

门：G2
候选提交：e8ebafe94f9c3442c9b195a9f40f560672316ebe

结论：fail

## 总判

第二十轮的 13 条 P0 载荷在当前提交上全部返回 `null`（拒绝），回归通过。本轮另造 58 条载荷（含引用块、惰性续行、列表、HTML 实体、软换行、setext、链接定义、行内代码、Unicode Cf、原始 HTML、poison 追加时机），其中 19 组同根因载荷让「可见的 fail 结论」被解析器当作不可见内容删掉，解析器仍返回 `pass` 并允许签门。

根因是 `scripts/gate-check.ts:581-585` 的引用块预清洗：正则 `/^(\s*>\s?)([\s\S]*)$/` 只剥掉 `>` 后一个空格，随后第 583 行 `/^(?: {0,3}\t| {3,})/` 在剩余内容以 3 个及以上空格开头时整行抹空。CommonMark 在引用块内需要 4 个空格才是缩进代码；以引用块加四个空格开头的可见结论行实际只留下 3 个内容空格，markdown-it 渲染为可见段落，解析器却当作代码删除。

端到端在临时 clone 复现：写一份正文可见不通过结论的报告，解析器判 `pass`，sign-gate 以 exit 0 重签并改写 G2 记录，签后 gate-check 以 exit 0 放行（19 项必过、19 份证据哈希复核）。这不是理论风险，签门路径已 fail-open。

计数：P0=1，P1=0，P2=2。

## P0（1 条）

### P0-1 引用块四空格预清洗差一格，可见不通过被当作代码删除

位置：`scripts/gate-check.ts:581-585`，关键在 `:583` 的空格分支 `{3,}`；同一行的反引号与表分支 ` {0,3}\t` 未受影响。

机制：`>` 后只允许剥一个空格（`\s?`），CommonMark 的引用块标记后最多一个空格算标记的一部分，剩余 4 个空格才是缩进代码。当前用 `{3,}` 把「剩余 3 个空格」的普通段落也抹掉：markdown-it 15.0.3 实测把该行渲染为引用块段落，解析器却因预清洗把整行删掉，只读到基准通过结论，返回 `pass`。

载荷与实测（基准报告为标题、门、候选提交、空行、基准通过结论行、空行、载荷；解析器结果均为 `pass`，渲染器均可见不通过字样）。为免载荷原文被报告解析器当成第二条结论，下面把逐条原文放进代码块：

```text
Q1  >    结论：fail
Q2  >    fail
Q3  >    <ZWSP>结论：fail
Q4  >    # 结论：fail
Q5  >    - 结论：fail
Q6  >    结论：fail
    >    ---
Q7  >    >    结论：fail
Q9  > <TAB>结论：fail
Q10 >  <TAB> 结论：fail
Q11 >    **结论**：fail
Q12 >    &#32467;&#35770;&#65306;fail
惰性续行 8 组：> 前言 加 >    结论：fail（含 ZWSP、链接、尾行、列表载体、前导 3 空格等变体）
```

- Q1–Q7、Q9–Q12 的渲染结果依次为：引用块段落、引用块段落（裸 fail 也会被解析器的裸结论分支识别）、零宽字符后的段落、引用块内标题、引用块内列表项、引用块内 setext 标题、嵌套引用块段落、制表符后的段落、段落、强调标记段落、实体解码后的段落。
- 惰性续行的 8 组渲染均为引用块内可见段落或列表项；解析器均返回 `pass`。

对照（不构成 P0）：5 个空格时渲染为引用块内缩进代码，`pass` 安全；3 个总空格被拒绝；带 `[x]` 的行因保留方括号被拒绝。

端到端复现（临时 clone，未改主仓）：

- clone 路径 `C:\Users\ASUS\AppData\Local\Temp\s2r21\clone`，基线提交 `1bde4b1705b5b42cf878e928aee3a228bf120220`。
- 攻击报告正文（节选）：

```text
# S2 独立审计（第 21 轮）
门：G2
候选提交：e8ebafe94f9c3442c9b195a9f40f560672316ebe

（基准通过结论行，略）

## 审计意见

>    结论：fail

其余检查略。
```

- markdown-it 渲染节选：`<h2>审计意见</h2><blockquote><p>…</p></blockquote>`（引用块段落内为 fail 字样），正文同时可见基准通过结论与该 fail 结论。
- 解析器：`auditConclusionOf` 返回 `pass`，`auditBindingOf` 返回门 `G2`、提交 `e8ebafe94f9c3442c9b195a9f40f560672316ebe`。
- 把 clone 内 G2 记录的 `audit_round` 改为 21、`audit_report` 指向该报告后，sign-gate exit 0，输出：`重签完成：证据 19 份，candidate=11d551a0118e…，artifact_hash=1fd4e47ff5d5…，body_hash=c1cabe8f712c…，改动文件 88 个`。
- 提交签名后 HEAD `e338e6f26cbbf3947f9f6e22b7884e467676af35`，gate-check exit 0，输出：`gate G2 通过（19 项必过、19 份证据哈希复核，artifact_hash=1fd4e47ff5d5… body_hash=c1cabe8f712c…）`。
- 签后记录独立复算：`audit_report_sha256=9546a2537037dd53e64476d31e4655d61484d486f4a9c3761bd96f63aabd21f8`，报告结论仍解析为 `pass`，绑定提交是 HEAD 祖先，提交后候选范围差异为空。

影响：任何能写 `docs/audits/*.md` 并提交的人，都可以让审计报告在渲染上明确写「不通过」，同时让门解析成「通过」，再由 sign-gate 正常签名。审计结论的可见性与门记录脱钩，G2 的结论门不再可信。

修复方向：把 `:583` 的空格分支改为 `{4,}`（至少先止血）；更稳的做法是直接按 markdown-it 的 token 流判断引用块内的 `code_block`，删掉这层按行形状的预清洗。回归测试至少加入 Q1、Q2、Q4、Q5、Q6、Q12 与一个惰性续行用例，并补一条「可见 fail + sign-gate 必须拒绝」的端到端用例。

## P1

无。

## P2（2 条）

### P2-1 单测固化了错误的引用块缩进认知

位置：`tests/gate-check.spec.ts:384-385`。注释写「引用块内的四空格缩进是代码块，不是顶层结论」，断言一段「基准为不通过结论、随后是引用块四空格 pass 结论」的文本返回 `null`。markdown-it 实际把第二行渲染成引用块段落，不是代码；该断言之所以为 `null`，是因为预清洗把整行删掉后全文没有任何可解析结论，而不是因为渲染隐藏。这个用例没有覆盖「基准 pass + 引用块可见 fail」，因此锁不住 P0-1。

### P2-2 旧掩码实现成为死代码，留下两套可见性判定

位置：`scripts/gate-check.ts:700-1181`（`auditTopLevelLines` 起至 `stripHiddenAuditBlocks` 一带）。本轮改为 `renderedAuditLines` 后，`auditTopLevelLines`、`stripHiddenAuditBlocks` 及 `mask*` 系列不再被 `auditConclusionOf` / `auditBindingOf` 调用，只在彼此之间引用。约 480 行并行实现留在同一文件里，后续维护容易改错分支，也扩大审计面。建议删除或明确标注弃用；本轮不阻断。

## 不计入计数的观察

- 行内代码：三例把 fail 结论写进行内代码（普通行内代码、行内代码链接、引用块内行内代码），解析器返回 `pass`，渲染器在 `<code>` 元素里显示这些字。项目既定口径把行内代码视为非正文隐藏位置，故不计 P0/P1；但它与「渲染器可见性」的字面口径仍有张力，建议在口径文档里写明。
- 软换行拆词：`结` 换行 `论：fail` 解析器返回 `pass`，渲染为「结 论：fail」（软换行在浏览器折叠为空格），不是精确关键词，风险低，不计。
- 图片 alt、链接 title、链接定义、HTML 注释、CDATA、原始 HTML、Unicode Cf 变体：本轮矩阵均按预期拒绝或隐藏，未发现新的放行路径。

## 复验：第二十轮 13 条 P0 载荷

以下 13 条在当前 HEAD 上逐条复跑，`auditConclusionOf` 全部返回 `null`（拒绝），无「可见 fail 被 pass 盖住」：

- `def-trailing`、`def-invalid-dest`、`def-then-indent`、`fake-link-spaces`、`fake-link-bare-title`、`fake-ref-undefined`、`image-fake-dest`。
- `entity-link-para`、`entity-heading-after-link`、`entity-list-after-link`、`entity-indented-list`、`setext-entity`、`zwsp-colon`。
- 复跑脚本 `C:\Users\ASUS\AppData\Local\Temp\s2r21\probe2.mjs`，exit 0；`tests/gate-check.spec.ts:525` 的 13 条回归用例在 vitest verbose 下也是通过（✓）。
- 说明：其中 12 条在 markdown-it 渲染里仍能看到 fail 字样，但解析器返回 `null` 会拒绝整份报告，签门不会放行，符合「必须全部返回 null」的验收口径。

## 复验：G2 记录、证据与哈希

- 固定范围：`GATE_SPECS.G2` 在 `scripts/gate-check.ts:108-190`；19 项为 `G2-01` 至 `G2-07`、`G-03`、`G-04`、`G-05`、`G-07`、`G2-08` 至 `G2-15`；19 份证据为 `ev-g2-01` 至 `ev-g2-15` 加 `ev-g2-g03/g04/g05/g07`；11 条不变量 I1-I11 的语句与证据 id 钉死在代码里。
- 主仓 G2 仍是预签态：`audit_round=4`，报告指向 `docs/audits/S2-independent-audit-round4.md`，`audit_report_sha256` 为 64 个 0；`docs/gates/G2.md` 自锚 `artifact_hash=b5615b8b5725c5b2df88b9231b13885635940ef7db9f7fe802bc162c651c7a0a`、`body_hash=ef21bb456813786ab878abae2824a873f6e7d470e257d2bcadfb9eb73282dfd3`。这是本轮审计开始前的状态，按用户口径不算缺陷。
- 预签记录与 HEAD 的自洽性：记录里的 `candidate_hash=f11d0f…`、`change_scope_hash=33a82c…`、`evidence_index_hash=bcaaaa…`、`invariants_hash=77708d…`、`artifact_hash`、`body_hash` 均来自更早的签名态，与 e8ebafe 重算值（`11d551…`、`b4811c…`、`106e1c…`、`925a77…`、`ea3dff…`、`8a446d…`）不一致。sign-gate 会整体重算，主仓直接跑 gate-check 在审计 sha 处 exit 1（`0000… != c9cef2e4…`），属 fail-closed。
- previous_artifact_hash 链：G2 记录值为 `1ce80f6080fb2271ae7ba958c61127962951cb49262b75e5b1d8e7d161b82084`，与 `docs/gates/G1.md:197` 的 G1 自锚一致。
- 签名态独立复算（clone 的 `e338e6f…`）：19 项 id 与顺序、19 份证据文件映射、19 份证据 LF 归一 sha256、`evidence_index_hash=106e1c362e7d4312e647580a99b3cfc01eb604546af9fd42167af4bbce6b8fd0`、`invariants_hash=925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304`、`candidate_hash=11d551a0118e386d0ffc6fe3fd43d0bf5cbdbf0103b05e18096b13d211d06c58`（88 个文件）、`change_scope_hash=b4811c33ac596c2580c7268812fa1e79fbe12ad2f9257bacdd8fb88fd5648778`、`artifact_hash=1fd4e47ff5d5a3cfbcd08dcb622a7b27080ed65d1e01386e1baefca3b0f6f3b1`、`body_hash=c1cabe8f712c688401d90ad034eef6bc7d71c03aae6969f7304f3e5dc61e5720` 全部吻合；`audit_report_sha256=9546a253…` 与报告字节（LF 归一）吻合；`audit_round=21` 与文件名轮次一致；绑定提交是 HEAD 祖先；提交后候选范围差异为空。gate-check exit 0。
- 签门路径未见第二处独立的 fail-open：`scripts/sign-gate.ts:81` 在 `writeFileSync` 之前调用 `verifyGateRecord(..., { selfCheck: true })`，证据哈希、索引、候选、正文表、不变量、审计锚都会重算；本轮 P0 是审计结论解析这一处被绕过，签门其余自检仍按 fail-closed 工作。

## 复验：S2 核心不变量

本轮提交只改 6 个文件：两份审计报告、`package.json`、`pnpm-lock.yaml`、`scripts/gate-check.ts`、`tests/gate-check.spec.ts`；`src/` 零改动。因此五项核心不变量不是「被本轮改动破坏」，而是需要确认实现仍在、测试仍通过：

- 工具授权只认 workflow 定义：`src/executor/run-node.ts:57-65` 先经 `policyForNodeRun` 从账本反查 `workflow_version` 与 `node_id`，`:107` 对 node_id 不一致抛 `STALE_GENERATION`，`:113` 再调 `catalog.toolPolicyFor`；`src/service/workflows.ts:84-89` 只从已加载定义取 allow/deny；`src/executor/tools.ts:43-62` 的 `assertToolsAuthorized` 在租约前执行，deny 优先、未注册拒绝。测试 `tests/runtime.spec.ts:71`、`tests/workflows.spec.ts:29` 通过。
- 单写者锁与 epoch 围栏：`src/service/commands/lease.ts:63-64` 的获取更新带 `WHERE ... status='queued' ... revision=...` 的 CAS，并写入 `owner_epoch`；`tests/db-open.spec.ts:54-72` 的 epoch 栅栏与 `tests/db-open.spec.ts:81` 的第二把锁用例通过。
- 心跳续租：`src/executor/run-node.ts:73-97` 在动作执行期间用定时器调用 `renewNodeLease`，失败留 `lease_lost` 事件并按租约丢失收口；`src/service/commands/lease.ts:86-99` 的续期带 `lease_id` CAS；`tests/runtime.spec.ts:144` 的「2.5 秒扫描不判过期」通过。
- 工作流版本跨重启绑定：`src/service/workflows.ts:28-68` 的 `hydrate` 校验落库 `content_hash`，`load` 对同版本改写抛 `WORKFLOW_VERSION_IMMUTABLE`；`tests/workflows.spec.ts:45` 与 `tests/apply-report.spec.ts:275` 的跨重启用例通过。
- applyReport 系统级证据门：`src/service/commands/apply-report.ts:232-239` 先 `evaluateEvidence` 再 `systemEvidenceGate`；`:303-311` 对空证据、非 `run_tool`、非数字 exitCode、非 0 exitCode 分别拒绝；`:314-323` 的 `traceBindingGate` 再对 `tool_executions` 的 exit_code/stdout_hash 绑定，伪造痕迹拒绝。
- 定向测试：`tests/runtime.spec.ts`、`tests/workflows.spec.ts`、`tests/lease.spec.ts`、`tests/apply-report.spec.ts`、`tests/db-open.spec.ts` 共 5 个文件 57 例，exit 0。

## 命令与退出码

- `D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit`：exit 0。
- `D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/gate-check.spec.ts --reporter=dot`：exit 1，11 failed | 50 passed（61 例）。11 例失败全部是预签态 G1 fixture 在 `checkAuditAnchor` 的审计 sha 零值处早退：`G1 门记录通过`、`改 candidate_hash 但锚点不动时报哈希不符`、`证据文件的哈希对不上时指名哪一份（审计 F1）`、`evidence_index_hash 被改时指名证据索引不符`、`candidate_hash 改成别处的值时指名与候选文件不符`、`正文必过项的内容列被改时指名不一致（审计 N-09）`、`正文证据表的哈希被改时拒绝（审计 R3-06）`、`正文不变量说明被改时拒绝（审计 R3-06）`、`不变量语句被削短后即使重算哈希也拒绝（S1 第八轮 P1-3）`、`证据文件与固定文件映射不一致时拒绝（S1 第二轮审计）`、`正文自锚 body_hash 被改时拒绝（审计 R3-08）`。
- 全量 vitest：exit 1，11 failed | 313 passed（324 例），1 个失败文件 | 31 个通过文件。没有预期之外的失败；失败集合与上面 11 例相同。
- 定向 5 文件：exit 0，57 passed（57 例）。
- 主仓 `scripts/gate-check.ts docs/gates/G2.md`：exit 1，报「审计报告 sha256 与记录不符：0000… != c9cef2e4…」，预签态预期；同一命令对 G1 亦 exit 1（零值 != `50ba1b13…`）。
- 端到端攻击：sign-gate exit 0；签后 gate-check exit 0。这是 P0 的放行证据，不是通过证据。

## 审计边界

- 主仓只写本文件 `docs/audits/S2-independent-audit-round21.md`；未改代码、未签门、未提交。
- 审计期间主仓工作树出现未提交的 `scripts/gate-check.ts` 改动与 `docs/audits/S1-independent-audit-round17.md`，非本审计所为；HEAD 仍是 e8ebafe，本报告结论只对该提交负责，未把工作树改动纳入。签门前的 `assertClean` 会拒绝这种脏工作树（`docs/audits` 虽在忽略列表，`scripts/` 不在）。
- 所有攻击与哈希复算在 `%TEMP%\s2r21` 下的临时 clone 完成；主仓 G2 记录未动。
- 复跑载荷脚本：`probe2.mjs`（70 组，含 13 条回归）、`probe3.mjs`（引用块惰性续行 10 组）、`verify-signed.mjs`（签名态全量哈希复算），均 exit 0。
