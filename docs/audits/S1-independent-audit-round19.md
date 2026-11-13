# G1 第 19 轮独立审计报告

门：G1
候选提交：1e83391d2bd59656824fcdeb8e86c3ecb36ebe11

计数：P0=4，P1=0，P2=0。

## 审计范围与方法

审计对象为 `D:/aboutAI/dsh-orchestra` 的候选提交 `1e83391d2bd59656824fcdeb8e86c3ecb36ebe11`（HEAD）。审计开始时工作树干净。审计只读主仓，写操作全部在临时 clone `C:/Users/ASUS/AppData/Local/Temp/dsh-audit-r19` 与临时目录 `C:/Users/ASUS/AppData/Local/Temp/g1-audit19` 完成；主仓唯一写入是本报告。

覆盖内容：`AGENTS.md`、S1 计划、`docs/gates/G1.md`、`scripts/gate-check.ts`、`scripts/sign-gate.ts`、`tests/gate-check.spec.ts`、G1 的 13 份证据；候选文件哈希、四个锚点哈希、13 份证据 sha256（LF 归一）、必过项固定映射、正文三张表均由本审计独立重算，不引用门记录自述。

## 独立重算

预签态下，按 `scopeBase 623939d4c0a7123835b525287035588ee291ccbe..HEAD` 加 excludes 独立枚举得到 115 个候选路径，与导出实现逐路径一致。

```text
candidate_hash
  record bbd322cf9d4ef5fb44a836ac8fd6edeb56b7c95ad34d1f80f29fe349fc4cc69e
  calc   e595f3c2786bb1ba671cbaa0661005b75a4fe367d77dc99af2bf5a380022bce4
change_scope_hash
  record ea15eaba761c24c70ff1b724251b125c65fc9ba17f15f4bdb1dfc35ff646f4fb
  calc   83793fffc1fb10e1c1818eaf192171210853a5d7219965c8157727a0891744d4
evidence_index_hash
  record fad4d531d22eef2968c6b7d5dce997f46162fa9fda12a98b1abf1aa6640a8d07
  calc   fad4d531d22eef2968c6b7d5dce997f46162fa9fda12a98b1abf1aa6640a8d07
invariants_hash
  record 6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6
  calc   6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6
artifact_hash
  record 1ce80f6080fb2271ae7ba958c61127962951cb49262b75e5b1d8e7d161b82084
  calc   f54dcae873f34a988ca7d6fbf5bd0b29ce68558acfd4007f0b477e49b65cc4ec
body_hash
  record 446357f9e00e384a35d7a4b77be48f0720cceebb61a4b5e1c4a9e8e27f17450c
  calc   111ce311f354ff5822db0ff282adb2bfdf0f9efdd93be876f69ef866e6144118
```

13 份证据按 HEAD 内容、CRLF 换 LF 后重算：7 份一致，6 份不一致。

```text
ev-epoch
  record 78263f1ca785f67e78adb70f874657c8bd5d137b99d486827c02e913ba3b91ed
  calc   61623a675fa33ce39dc91ee3b54bac5eee04c6c639e4185d7613dedc6ce9c044
ev-g08
  record a50e5a17eafda7c0c782e3dc56d0c1e70d6b879cf566b5500b0a84dd260ef44a
  calc   2f2a73ddbf25fb59ea9b650635499856e66c94dcde81fca1a12ea3d424176c87
ev-g14
  record 3b2e37d9a0f6c6e49054dc4a27966e914755a56e6e8b9491d51ca3d213545169
  calc   7869d3d1c5b84ad267a9ca304c6420abdfd3597deb3c9f2119129331f56f0bc2
ev-g15
  record db16d844f912cac0bedd81139a8238919b0d3f120469a6bdcfbcf7c73397cb0e
  calc   334f26fb748d4013bdb0243f4a0e9d4ddd1e573fc4071114d9dffc0bb7dc03a3
ev-gatecheck
  record c61262506e81f9bfb89f00afc55662a18a722ed1ed447f9dd8220f88ab8f93b2
  calc   2770f8baa70ecab00d7f2c026806e4e29fa348e0a6315ba6edfae69a1eb71905
ev-migrate
  record b3ad3fbde1ef16392af16b68cbab36d440ffd23b9a6e19a74fd6132da61d6ff1
  calc   80ca96027bde4b8ac65f66c7e9c2528bb8481cde00d07df70745ae6eabe80ab0
```

上述 candidate/scope/artifact/body 与 6 份证据的偏差属于预签态：`docs/gates/G1.md` 最后一次改动之后，`e35eb6e`、`6b65bfa`、`1e83391` 又改了 `scripts/` 与 `tests/`，门记录尚未重签；`sign-gate` 会从 HEAD 重算并回填。此项按审计委托口径不计缺陷。签后 clone 中 13 份证据全部复核通过。

正文三张表按代码里的固定常量独立比对，全部一致：

```text
必过项表：13 行；编号序列 = G1-01..G1-07, G-01, G-02, G-08, G-09, G-14, G-15
内容列：13/13 与 GATE_SPECS.G1.content 完全相等
结果列：13/13 为 pass
证据列：13/13 与 evidenceMap 完全相等
证据文件表：13 行；id/file 13/13 与 evidenceFiles 完全相等；表内 sha 与 evidence-index 13/13 相等
不变量表：4 行；I1/I10/I2/I3 语句与证据集合 4/4 与固定常量完全相等
GateArtifact.must_pass_items：13 项顺序与证据映射均与固定清单相等
```

## P0 问题

### P0-1 三行拆词可见否定句被解析为通过

位置：`scripts/gate-check.ts:658`（`auditConclusionOf`），邻行拼接只在 `:676-681` 做一次。

载荷（写入审计报告正文、放在唯一结论行之后）：

```text
本报告不
通
过
```

实测：`auditConclusionOf` 返回 `pass`；`sign-gate` exit 0；签后 `gate-check` exit 0（artifact_hash `0db3511703a0...`，body_hash `eca3883335bd...`）。三行分别不命中，任意相邻两行拼接也不命中，但渲染后连续阅读是明确否定。

期望：返回 `null`（或 `fail`），`sign-gate` 与 `gate-check` 均 exit 1。

### P0-2 图片 alt 的实体与引号变体绕过

位置：`scripts/gate-check.ts:607-610`（图片 alt 用 Markdown 源文本直接判毒，未做 HTML 实体解码）；收尾边界在 `:634`。

载荷与实测（全部 `auditConclusionOf` 返回 `pass`，`sign-gate` exit 0）：

```text
![本报告不通过&#xFF08;P0 1 条&#xFF09;](x.png)
![本报告不&nbsp;通过](x.png)
![结论&colon;fail](x.png)
![&#26412;&#25253;&#21578;&#19981;&#36890;&#36807;](x.png)
!["本报告不通过"](x.png)
!['本报告不通过'](x.png)
![‘本报告不通过’](x.png)
![&quot;本报告不通过&quot;](x.png)
```

其中第一条跑通全链路：`sign-gate` exit 0，签后 `gate-check` exit 0（artifact_hash `5cbdc25c3f46...`，body_hash `b4e063145382...`）。渲染后的图片可见 alt 是明确的否定句，实体解码后同样可见。

期望：返回 `null` / exit 1；图片 alt 应按渲染文本判毒并先解码实体。

### P0-3 可见引号包裹的否定句与形似边界绕过

位置：`scripts/gate-check.ts:634`（`FAIL_VERDICT` 的尾部 lookahead 只接受空白、句读、右括号、右引号 `”`、`》`、`>` 等，不收 ASCII 双引号、ASCII 单引号、弯单引号、全角引号、法文引号）。

载荷与实测（独立可见行；`auditConclusionOf` 返回 `pass`，`sign-gate` exit 0）：

```text
"本报告不通过"
'本报告不通过'
‘本报告不通过’
＂本报告不通过＂
«本报告不通过»
"结论：fail"
```

其中第一条跑通全链路：签后 `gate-check` exit 0（artifact_hash `63ee62463f25...`，body_hash `276374bc4b01...`）。弯双引号包裹（`“本报告不通过”`）被 `:634` 的右引号 `”` 接住，已正确拒绝；其余引号形态仍放行。

期望：返回 `null` / exit 1；可见否定句不因外层引号形态而改变语义。

### P0-4 门记录正文的可见否定句绕过

位置：`scripts/gate-check.ts:711-721`（`bodyConclusionOf`），逐行调用 `visibleFailStatement` 在 `:719`，没有邻行拼接、不检查图片 alt、不做实体解码。正文结论校验在 `verifyGateRecord` 的 `:1427-1431`。

载荷（插入 `docs/gates/G1.md` 正文的正式结论行之后，并重算 body_hash）：

```text
本报告不
通
过
```

```text
"本报告不通过"
```

```text
![本报告不通过&#xFF08;P0 1 条&#xFF09;](x.png)
```

实测：

```text
前两条：verifyGateRecord 返回 PASS（artifact_hash 1957d16a6887...）
        sign-gate exit 0（body_hash 分别为 2b1b28504ef3...、c00de37391e8...）
        签后 gate-check exit 0
第三条：verifyGateRecord 返回 PASS；未跑 sign 全链
```

同一位置的正确拒绝对照（均先重算 body_hash 再 verify）：

```text
顶部结论改为 fail 或 不通过
  -> 门记录正文结论与 GateArtifact 不符：正文=fail，artifact=pass
插入“- 复核意见 本报告不通过（P0 1 条）”
  -> 门记录正文结论与 GateArtifact 不符：正文=fail，artifact=pass
插入裸行“本报告不通过（P0 1 条）”
  -> 门记录正文结论与 GateArtifact 不符：正文=fail，artifact=pass
只改正文、不更新 body_hash
  -> body_hash 与正文不符：96bbb5c26e3e0d2d... != 14774f2e57ea9ace...（正文改过就重签）
```

期望：上述三条绕过载荷均应被 `bodyConclusionOf` 判为可见否定，`verifyGateRecord` 拒绝，`sign-gate` / `gate-check` exit 1。

## 绑定、候选不可改与防篡改复核

审计报告绑定（clone 中逐例修改报告并跑 `sign-gate`，均 exit 1）：

```text
重复一行“门：G1”
  -> auditBindingOf 返回 null；审计报告缺少唯一的「门：G1」与「候选提交：<40 位 commit>」绑定行
门改为 G2
  -> 审计报告绑定的门与门记录不符：报告=G2，记录=G1
重复一行“候选提交：...”
  -> auditBindingOf 返回 null；缺少唯一绑定行
候选改为 aaaa...（40 位不存在）
  -> 审计报告的候选提交不是 HEAD 的祖先或不存在
候选改为 623939d4c0a7123835b525287035588ee291ccbe（旧祖先）
  -> 审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：codebasemap.md
```

候选提交后候选文件不可改：干净签后 `gate-check` exit 0；给 `tests/auth.spec.ts` 追加注释并提交后再跑，exit 1，错误为 `门检查失败：审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：tests/auth.spec.ts`。

前序门哈希链、证据索引、必过项清单常量、正文自锚 `body_hash` 的篡改复核（`verifyGateRecord` 均拒绝）：

```text
previous_artifact_hash 改为非 0
  -> 第一道门的 previous_artifact_hash 必须是 64 个 0
证据索引中 ev-auth sha 改为 0
  -> 证据文件 sha256 不符: ev-auth（记录 0000000000000000... 实际 13f123174be3f02a...）
artifact.evidence_index_hash 改为 2222...
  -> evidence_index_hash 与证据索引不符：2222... != 68446a5927ccbd73...
改写 I1 语句
  -> 不变量 I1 的语句与固定口径不一致（改写或削短都要重新审计）
must_pass_items[0].id 改为 G1-99
  -> 必过项清单不符：期望 G1-01,...,G-15，实际 G1-99,...
must_pass_items[0].evidence_ids 改为 ev-auth
  -> 必过项 G1-01 的证据与固定映射不一致（换绑证据不许重签）：ev-auth != ev-migrate
candidate_hash 改为 3333...
  -> candidate_hash 与候选文件不符：3333... != e595f3c2786bb1ba...
change_scope_hash 改为 4444...
  -> change_scope_hash 与改动清单不符：4444... != 83793fffc1fb10e1...
audit_report_sha256 改为 5555...
  -> 审计报告 sha256 与记录不符（报告改过就重新审计再签）：5555... != 5bb1352defbb9873...
audit_round 改为 2
  -> audit_round 与审计报告的轮次不一致: 2 != 1
```

## 合法阳性对照

clone 中准备只含绑定行、空行与唯一 `结论：pass` 的干净报告，执行：

```text
cd C:/Users/ASUS/AppData/Local/Temp/dsh-audit-r19
node --no-warnings scripts/sign-gate.ts docs/gates/G1.md
node --no-warnings scripts/gate-check.ts docs/gates/G1.md
```

结果：`sign-gate` exit 0，输出 `重签完成：证据 13 份，candidate=e595f3c2786b...，artifact_hash=1957d16a6887...，body_hash=96bbb5c26e3e...，改动文件 115 个`；签后 `gate-check` exit 0，输出 `gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=1957d16a6887... body_hash=96bbb5c26e3e...）`。说明门检查主路径可用，上述 P0 是可见否定句解析的缺口，不是整条门链失效。

攻击矩阵其余用例（中文否定、8 种包裹、5 种收尾符、空白/实体空白/CR/VT/FF/U+2028/U+2029、形似冒号、引用块 0-4 空格与惰性续行、行内代码拆词、setext、表格单元格、链接 title/定义、原始 HTML/details 等）均返回 `null`、`sign-gate` exit 1；隐藏对照 `link-title`、`link-def`、`html-comment-only`、`fenced`、`indented` 返回 `pass`、`sign-gate` exit 0，属正确放行。

## 环境注记

审计期间主仓出现并发未提交改动（`scripts/gate-check.ts`、`src/core/policy.ts`、`src/core/report.ts`、`src/executor/tools.ts`、`src/service/commands/apply-report.ts`、`src/service/server.ts`、`tests/apply-report.spec.ts`、`tests/integration/g2.spec.ts` 与未跟踪的 `docs/audits/S2-independent-audit-round23.md`），疑似并行 G2 审计；HEAD 未变，本审计未触碰、未回滚。主仓 `gate-check` 现在先在脏树检查处 exit 1；用 `allowDirty` 直接校验仍得到预签态预期的审计 sha 错误 `0000000000000000... != 50ba1b13cdf1b84d...`。此项不计 G1 缺陷。

## 判定依据

四项 P0 都是“渲染后可见的否定句被解析成通过”，且均已端到端签成 `pass` 或通过正文校验：三行拆词绕过 `auditConclusionOf`，图片 alt 实体/引号与可见引号包裹绕过收尾边界，三行拆词与带引号否定句绕过 `bodyConclusionOf`。这些路径直接违反“可见 fail 不能被解析成 pass”的门禁目标；按 P0/P1 为 0 才可通过的判据，本轮判 `fail`。P1=0，P2=0。

结论：fail
