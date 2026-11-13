门：G2
候选提交：e7a3fa4ef0e9d4ae970e506d90c863d6910b25c3

# S2/G2 独立审计（第二十七轮）

- 审计对象：D:/aboutAI/dsh-orchestra，G2 门，候选提交 e7a3fa4ef0e9d4ae970e506d90c863d6910b25c3。
- 审计时间：2026-11-14，Asia/Shanghai。
- 审计方式：只读审计。所有攻击复现都在临时 clone 内完成，不改主仓库源码，不签主仓库的门，不提交、不 push。
- 审计开始状态：主仓库 HEAD=e7a3fa4，工作树干净（git status --porcelain 无输出）。
- 审计期间状态：主仓库 HEAD 被并发 S1 工作推进到 d1dfe12；本报告的结论只针对候选 e7a3fa4，不把 d1dfe12 当候选。详见 P2-3。
- 本审计写入主仓库的文件只有 docs/audits/S2-independent-audit-round27.md；审计结束时工作树里另有并发改动，见 P2-3。

**总体判定**：fail（P0=2、P1=0、P2=3）。

## 环境与命令

- 操作系统：Windows；node：D:/NodeJs/node.exe，v26.13.1；不使用 pnpm。
- 主仓库：D:/aboutAI/dsh-orchestra。
- 审计 clone：D:/aboutAI/dsh-orchestra-audit27、-b、-c、-d；均为 git clone --no-hardlinks，node_modules 用目录联接挂入主仓库 node_modules；攻击前统一 git reset --hard e7a3fa4。
- 合成控制提交：audit27 的 b84c40e。它只存在于 clone，内含合成报告 docs/audits/S2-independent-audit-round27.md（门：G2、候选提交 e7a3fa4、结论为 pass）和已签的 G2；干净状态下 gate-check exit 0。
- 类型检查：

    cd D:/aboutAI/dsh-orchestra-audit27-b
    D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit

- 全量测试：

    cd D:/aboutAI/dsh-orchestra-audit27-b
    D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run

## 已复核项

### 1. 第二十六轮 10 条载荷已闭合

在基准报告（已有合法的「结论：pass」行）上逐条追加下列 10 条载荷，用真实导出的 auditConclusionOf 与 bodyConclusionOf 复跑：

- 本次审计结论为否决。
- 驳回。
- 拒绝。
- 反对。
- 未采纳。
- 拒收。
- 不接收。
- 繁體结论行「結論：fail」
- 本次審計結論為否決。
- 本次審計結論為駁回。

结果：10 条全部 auditConclusionOf=null、bodyConclusionOf=fail，不再被当成 pass。

端到端也用同一批载荷跑了 sign-gate 与 gate-check：10 条全部 sign-gate exit 1，错误为「审计报告里找不到唯一结论行，不能拿它当门记录依据: docs/audits/S2-independent-audit-round27.md」；gate-check exit 1，错误为「审计报告 sha256 与记录不符（报告改过就重新审计再签）」。每次攻击前后 docs/gates/G2.md 的 sha256 相同，门字节未被改写。

### 2. ev-g2-14 四路并发与 ev-g2-12/13/15 复跑

四个独立 clone（audit27、-b、-c、-d）固定在 e7a3fa4，并发跑：

    D:/NodeJs/node.exe --no-warnings scripts/fault-inject.ts --case ev-g2-14

四份 docs/gates/evidence/G2/ev-g2-14.md 的 sha256 全部为：

    12e34ba8fd59c17322b364a122a5f265af87d353e10a13b6b4328049ceb6b39f

与 G2 表第 83 行一致。第二十六轮 P1-1 的并发 revision 字节漂移已闭合。

ev-g2-12、ev-g2-13、ev-g2-15 各复跑两次，结果稳定且与 G2 表一致：

    ev-g2-12  5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe
    ev-g2-13  a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc
    ev-g2-15  7648abe92c2026e4c5739c5f5714f448a2ce8864fc07a129f607675af415643f

revision 归一没有误改这三份证据的字节。

### 3. P2-1/P2-2：null 产物与重复产物

用真实 evaluateEvidence 探针（与 applyReport 的调用路径一致，src/service/commands/apply-report.ts:254-257）复跑：

| 场景 | output / required_hashes | 结果 |
| --- | --- | --- |
| A | output.artifact=null，期望 sha256(canonicalJson(null)) | ok=false，reason=verification_too_weak |
| B | required_hashes=[artifact,bundle]，两份 key 的产物为同一个字符串 | ok=false，reason=verification_too_weak |
| B2 | required_hashes=[artifact,bundle]，两份 key 的产物为同一个对象 | ok=false，reason=verification_too_weak |
| C | required_hashes=[artifact,bundle]，两份产物不同 | ok=true，strength=strong |
| D | output.artifact=undefined，配任意期望哈希 | ok=false |
| E | output 里缺少 required key | ok=false |
| F | required_hashes=[artifact,artifact]，重复 key | ok=false |

src/core/policy.ts:57-61 的 null/undefined 拒绝、:66-71 的按 key 产物摘要唯一性都在候选上生效。tests/apply-report.spec.ts:417-427、:429-439、:441-452 分别覆盖同哈希拒绝、null 产物拒绝、两份独立产物通过。

### 4. G2 门记录独立复核

在 e7a3fa4 的 clone 内，不调用 verifyGateRecord，按 G2 规格独立复算：

- 必过项：19 项，顺序为 G2-01…G2-07、G-03、G-04、G-05、G-07、G2-08…G2-15；内容、结果、证据映射与 GATE_SPECS.G2 完全一致，artifact 内 19 项全为 pass，failed_items 为空。
- 证据：19 份，id 与文件映射唯一；正文证据表与 evidence-index 一致；每份都按 git show HEAD:证据文件路径 取字节、LF 归一后重算 sha256，19 份全部等于表中值。代表值：ev-g2-01 f10efac98f2d0d91bfc83d0e1bacb3c2a5111c11bc7223de6464a057a744d88b；ev-g2-12 5c2d543f…；ev-g2-13 a5260693…；ev-g2-14 12e34ba8…；ev-g2-15 7648abe9…。
- 不变量：11 条，block、正文表、规格三者一致。
- artifact 与正文同源：两处必过项表、证据表、不变量表都按同一顺序和同一哈希生成；artifact_hash 与 body_hash 的锚点位置正确。
- G1 previous_artifact_hash：1ce80f6080fb2271ae7ba958c61127962951cb49262b75e5b1d8e7d161b82084，等于 docs/gates/G1.md 的 artifact_hash 锚。
- 治理字段：producer=human、approver=human:啸春、approved_at=2026-11-13T05:54:00.000Z、gate_run_id=null（run_terminal=not_applicable）、schema_version=1、三条 proposed exceptions、rollback 字段齐全。
- 候选范围：88 个改动文件；candidate_hash=8bc739719d089f20ac4da9d0b382644d0cb53ec5ec5ff6b958942442d4c68047，change_scope_hash=b4811c33ac596c2580c7268812fa1e79fbe12ad2f9257bacdd8fb88fd5648778。
- 独立复算的另两个原像：evidence_index_hash=1a221b945449b1e68b7811ba110ac022f25c9004438204dcdeae0f02a3068898，invariants_hash=925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304。
- 独立复算的 artifact_hash=ea3dff4caa8de38d5336388e32eb4af4867998308a28a6b010d180d8d85c291a，body_hash=558c01b7728d8ccee58ea3eae749879d0eff5989a5b7df1d1d6fc67da2d59b5f。

这些值与当前 G2 正文里记录的预签旧值不同，原因见 P2-1；结构本身没有换绑、截断或正文/artifact 不同源。

### 5. tsc 与全量 vitest

在 e7a3fa4 的干净 clone 内：

- tsc --noEmit：exit 0，无诊断。
- vitest run：Test Files 1 failed | 31 passed（32 个文件）；Tests 11 failed | 351 passed（362 个用例）；无 skipped，exit 1。
- 11 个失败全部在 tests/gate-check.spec.ts，且第一条失败都是「审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…」。没有第 12 个失败，也没有 G2 候选代码的失败。
- G1 是预签态：docs/gates/G1.md 的 annotation round=1、report=docs/audits/S1-independent-audit.md、audit_report_sha256=0*64；该报告实际的 LF 归一 sha256 是 50ba1b13cdf1b84d5a948b2bc6deb25c7ec9963b4435154a5487683329390003。11 个失败都由这个预签锚引起，不是 e7a3fa4 的回归。

### 6. 干净阳性对照

在 clone 的干净控制提交 b84c40e 上：

    D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G2.md

exit 0，输出：

    重签完成：证据 19 份，candidate=8bc739719d08…，artifact_hash=785da2e78f72…，body_hash=efd33db26a05…，改动文件 88 个

    D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md

exit 0，输出：

    gate G2 通过（19 项必过、19 份证据哈希复核，artifact_hash=785da2e78f72… body_hash=efd33db26a05…）

完整锚点：artifact_hash=785da2e78f724d85c7f2564f124d99d9b4c4eafa8dd629bb5a1fe8bdc75d3634，body_hash=efd33db26a056ce62947f1c48fb2f2d3e014510299907903c5ba400daec9cb37。sign-gate 是幂等重写；若它把 G2 写脏，必须先把签好的 G2 提交，gate-check 才会通过，否则会以「工作树有未提交改动」拒绝。这是签门流程的先后关系，不是本次候选的代码缺陷。

## P0

### P0-1 可见中文宾语否决句被漏检：报告写 pass、正文可见拒收句仍能签过

位置：scripts/gate-check.ts:817-850（scanFailStatement），裁决词后的边界在 :830-831 与 :835-836；FAIL_OBJECTS 在 :769-771，只含 验收、标准、审批、评审、审核、考核、许可、批准、认可（及繁體），不含 报告、本报告、本次审计、该报告、审计组 等宾语/受事。auditConclusionOf（:869-908）与 bodyConclusionOf（:913-929）共用这个扫描器。

影响：在合法的「结论：pass」报告里追加一句可见的「本次审计结论为拒收本报告。」，扫描器在裁决词「拒收」后遇到「本」就停止，不把后面的宾语纳入判定；auditConclusionOf 返回 pass，bodyConclusionOf 也返回 pass。结果是人读报告能看到明确的拒收句，门记录却仍是 pass，并且可以签过。第二十六轮修的只是裸裁决词（否决、驳回、拒绝等）；带中文宾语的同义写法没有闭合。

复现命令（clone 内，全部在 e7a3fa4 的合成控制 b84c40e 上）：

    cd D:/aboutAI/dsh-orchestra-audit27
    git reset --hard b84c40e
    # 在 docs/audits/S2-independent-audit-round27.md 末尾追加下列载荷
    git add docs/audits/S2-independent-audit-round27.md
    git commit -m "audit27 p0-1 payload"
    D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G2.md
    git add docs/gates/G2.md
    git commit -m "audit27 p0-1 signed"
    D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md

复现载荷（每条都单独跑过，均签过）：

    本次审计结论为拒收本报告。
    本报告未通过本次审计。
    本次审计结论为：拒绝该报告。
    本次审计结论为：拒收该报告。
    本次审计否决该报告。
    审计组决定拒收本报告。
    本报告不予接收。
    本次审计不予采纳本报告。
    本次审计不推荐通过本报告。
    本次审计结论为拒收​本报告。     （拒与收之间有一个 U+200B）
    本次审计结论为：拒收报告。
    **本次审计结论为拒收本报告。**
    > 本次审计结论为拒收本报告。
    | 审计 | 本次审计结论为拒收本报告。 |

实际输出（以「本次审计结论为拒收本报告。」为例）：

    SIGN_EXIT=0
    重签完成：证据 19 份，candidate=8bc739719d08…，artifact_hash=5065465d828e…，body_hash=945c864e164d…，改动文件 88 个
    CHECK_EXIT=0
    gate G2 通过（19 项必过、19 份证据哈希复核，artifact_hash=5065465d828e… body_hash=945c864e164d…）

完整 artifact_hash=5065465d828e0d829bff1da2ae26aeeb3fc70c1d5fe691334ffd02b6a447c55c；签后 G2 文件 sha256=9a2b3f59b60edb1490caab0e2d7b0188bc7111898bf51321b389cecc9d413b9a。

另外两条的签后 artifact_hash 分别为 c30df52fa3bd…（本报告未通过本次审计。）和 e9b7bf3beadb…（本次审计结论为：拒绝该报告。），gate-check 同样 exit 0。

渲染差异也测过：Markdown 强调、引用、表格行、全角冒号、零宽字符都不会把上述否决句变成可识别；跨行拆词「本次审计结论为拒收」+「本报告。」反而会被全文拼接抓到（audit=null、body=fail），说明问题不在换行，而在裁决词后的中文宾语边界。HTML 注释、链接定义 title、围栏代码块中的否决句不可见，按可见性设计不计入本次 P0。

最小回归断言（建议加到 tests/gate-check.spec.ts）：

    const report = passReport + "\n本次审计结论为拒收本报告。\n"
    assert.notEqual(auditConclusionOf(report), "pass")   // 现在返回 pass
    assert.equal(bodyConclusionOf(report), "fail")       // 现在返回 pass
    // 端到端：sign-gate 必须 exit != 0，且攻击前后 G2 字节相同

### P0-2 可见英文否决句与英文结论行被漏检

位置：FAIL_SUBJECTS 在 scripts/gate-check.ts:637-650，英文主语只有 audit、review、auditor、reviewer，没有 report；FAIL_VERDICTS 在 :652-679 虽有 reject/rejected，但裁决词后的边界 :830-831 只接受行尾、| 或 需/应/已/的/了，所以「rejects」的 s 会把匹配截断；auditConclusionOf 的严格结论正则 :900 与 bodyConclusionOf 的正则 :918 只认中文 结论/結論/判定，不认 CONCLUSION。

影响：报告正文已有合法的「结论：pass」，再追加一句可见英文否决句，auditConclusionOf 与 bodyConclusionOf 都返回 pass，sign-gate exit 0，gate-check exit 0。英文结论行「CONCLUSION: FAIL」单独出现时 auditConclusionOf 为 null（不会被当结论），但和合法 pass 结论并存时不会触发任何冲突，门记录照样 pass。

复现命令与 P0-1 相同：在 b84c40e 合成报告的 pass 结论行后追加载荷，提交报告，签 G2，提交 G2，跑 gate-check。

复现载荷与实际输出：

- 「This audit rejects the report.」：sign-gate exit 0，artifact_hash=f154e9f4eef2…，body_hash=1127bde6b644…，gate-check exit 0；签后 G2 sha256=e0df3770c2eb2c52808399f284b6d193c46d5122a6afbd17a188b6df3a891b16。
- 「CONCLUSION: FAIL」：sign-gate exit 0，artifact_hash=da799d56bbd4…，body_hash=5720312c66b5…，gate-check exit 0；签后 G2 sha256=e67958e317425a6498966d8031aaed3eb76f6eeb4a46116d1d747ccc908fc53b。
- 同义否定「本次审计不推荐通过本报告。」：sign-gate exit 0，artifact_hash=092a42e7cba0…，body_hash=fa4925a8dc97…，gate-check exit 0；签后 G2 sha256=5c0c53e66c6f638f79f95cb72cc64dbb350ed97f7cff4289b91a8b9090cf63b9。

最小回归断言：

    const report = passReport + "\nThis audit rejects the report.\n"
    assert.notEqual(auditConclusionOf(report), "pass")   // 现在返回 pass
    assert.equal(bodyConclusionOf(report), "fail")       // 现在返回 pass

    const report2 = passReport + "\nCONCLUSION: FAIL\n"
    assert.notEqual(auditConclusionOf(report2), "pass")  // 现在返回 pass
    // 端到端：sign-gate 必须 exit != 0，且 G2 字节不变

修复方向应同时覆盖三处：裁决词后的边界要能消费中文宾语/受事；英文主语补 report/the report；结论语法要么只认中文并显式拒绝可见英文结论行，要么把英文 CONCLUSION 也纳入同一套唯一结论判定。

## P1

无。第二十六轮 P1-1 已由 ev-g2-14 四路并发验证闭合；未发现新的 P1。

## P2

### P2-1 G2 当前是预签态

docs/gates/G2.md 在 e7a3fa4 上仍是预签态：artifact.audit_round=4，audit_report=docs/audits/S2-independent-audit-round4.md，audit_report_sha256=0*64；四个原像、artifact_hash、body_hash 都是上一轮的旧值。把 HEAD 的 19 份证据按 LF 归一重算后，实际值如下：

| 项 | artifact 记录（预签） | HEAD 重算 |
| --- | --- | --- |
| candidate_hash | f11d0fb8751ce561df6d24379ad083f12c4bc60c866f87ec7f523858e32c0af8 | 8bc739719d089f20ac4da9d0b382644d0cb53ec5ec5ff6b958942442d4c68047 |
| change_scope_hash | 33a82c417c33b950fe40f332f398018a29eebf5f2ed1242bb3772064f9626927 | b4811c33ac596c2580c7268812fa1e79fbe12ad2f9257bacdd8fb88fd5648778 |
| evidence_index_hash | bcaaaa3e85d1dea69d323c9a03040f0bc7586445d5d833169b3768ac487b6347 | 1a221b945449b1e68b7811ba110ac022f25c9004438204dcdeae0f02a3068898 |
| invariants_hash | 77708d4b54f29a676481b6c2755a241171c2cfab1231ef6e621f184fc68cedd5 | 925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304 |
| artifact_hash 锚 | b5615b8b5725c5b2df88b9231b13885635940ef7db9f7fe802bc162c651c7a0a | ea3dff4caa8de38d5336388e32eb4af4867998308a28a6b010d180d8d85c291a |
| body_hash 锚 | ef21bb456813786ab878abae2824a873f6e7d470e257d2bcadfb9eb73282dfd3 | 558c01b7728d8ccee58ea3eae749879d0eff5989a5b7df1d1d6fc67da2d59b5f |

在 HEAD 的干净 clone 上跑 gate-check，预期 exit 1：

    门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != c9cef2e419c91711…

这不是本次候选的代码缺陷，而是门还没重签：预签态下 candidate_hash 还没有绑定 e7a3fa4。按 P0-1/P0-2 修完并写好本轮报告后，需要在 e7a3fa4 的 clone 里重签 G2；重签后的门检查已在本审计的干净阳性对照中 exit 0（P2-1 只要求给出这个证据，不要求主仓库现在就签）。

### P2-2 11 个 G1 预签态失败与全量计数

全量 vitest 为 32 个测试文件、362 个用例，11 failed / 351 passed；失败全部在 tests/gate-check.spec.ts，且都停在 G1 的 audit_report_sha256 预签锚：artifact 里是 0000000000000000…，实际报告 LF 归一 sha256 是 50ba1b13cdf1b84d…。G1 的 13 项必过项与 artifact_hash 锚 1ce80f60… 本身没有变化；没有发现第 12 个失败，也没有发现候选 e7a3fa4 引起的失败。这里对不上的不是 candidate_hash，而是 G1 的审计报告字节哈希；把 G1 重签后这 11 个用例应恢复。

### P2-3 审计期间主仓库 HEAD 已推进，报告需固定在候选上

审计开始时主仓库 HEAD=e7a3fa4、工作树干净。审计期间并发 S1 工作把 HEAD 推进到 d1dfe12（4f63116「Close S1 round22 historical swallow and approval negations」、d1dfe12「Record S1 round22 remediation evidence」），改动集中在 docs/audits/S1-independent-audit-round22.md、docs/audits/S1-round22-response.md、handoff.md、scripts/gate-check.ts（+39/-5）和 tests/gate-check.spec.ts（+30）。审计结束时主仓库 HEAD=d1dfe12，工作树不是完全干净：本审计新增 docs/audits/S2-independent-audit-round27.md；另有并发工作留下的未提交改动（审计结束检查时为 M scripts/gate-check.ts、M tests/gate-check.spec.ts）与未跟踪的 docs/audits/S2-independent-audit-round28.md。这些不是本审计写入，本审计没有回退、修改或提交它们；本报告只对 e7a3fa4 的已提交字节负责。

本报告仍按任务指定的候选 e7a3fa4 写；所有攻击都在 e7a3fa4 的 clone 内复现。主仓库当前 HEAD d1dfe12 上复跑 P0 载荷仍然签过（例如「本次审计结论为拒收本报告。」与「This audit rejects the report.」仍是 audit=pass、body=pass），S1 的改动没有触及本报告指出的宾语边界与英文结论语法。若要把门签到 d1dfe12 或当前脏工作树，需要另行独立审计并重新签，不能直接复用本报告。

## 复现资产

- clone：D:/aboutAI/dsh-orchestra-audit27、-b、-c、-d；均固定 e7a3fa4，node_modules 为目录联接。
- 合成控制：D:/aboutAI/dsh-orchestra-audit27 的 b84c40e。
- 探针：D:/aboutAI/_g2audit27/attack-loop.mjs（第二十六轮 10 条载荷端到端）、bypass-loop.mjs（中文宾语）、bypass2-loop.mjs（英文与同义否定）、probe-visible-27.mjs（可见性变体）、probe-p2-final-27.mjs（null/重复产物）、recompute-g2-candidate-27.mjs（G2 独立复算）。
- 合成报告、攻击载荷与所有中间提交只存在于 clone，没有带入主仓库。

结论：fail
