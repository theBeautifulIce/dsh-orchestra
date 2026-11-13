# S1 / G1 第十轮独立审计报告

门：G1
候选提交：9a44739c0d7c5a158c4dca4cab7ebe201d704966

审计对象：HEAD 9a44739（"Close hidden audit conclusions and migration gaps"），工作树干净。审计时主仓库 HEAD 与候选提交一致，工作树无改动；本报告是唯一写回主仓库的文件（未跟踪）。
审计环境：临时 clone `D:/aboutAI/dsh-orchestra-audit-r10/clone`，node_modules 以目录联接指向主仓库；Node v26.13.1（D:\NodeJs\node.exe）。全部重签与攻击试验只在 clone 内进行，主仓库 docs/gates 未改、未签。
运行命令：`node --experimental-strip-types scripts/sign-gate.ts`、`node --experimental-strip-types scripts/gate-check.ts`、`node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/vitest/vitest.mjs run`。

结论：fail

## 总判定

- 计数：P0=0，P1=2，P2=0（第九轮 P2-1..P2-5 复核已闭合，无新增 P2）。
- 第九轮 P1-1 的三种基础攻击（嵌套 details、引用块四空格、空格+Tab）已闭合：sign-gate 均 exit 1，G1 不写盘，gate-check 也拒。
- 但本轮新增的隐藏文本扫描器仍有两类可复现反绕过：都能把「正文写明不通过」的报告签成 G1 pass（13 项必过、13 份证据，gate-check exit 0）。门记录结论与报告里人类可读结论的一致性仍可被绕开，故判 fail。
- 合法 pass 对照在同一 clone 里签过（gate-check exit 0、13/13），证明门本身能正常签过；上述两项不是「签不过」造成的假阳性。

## P0

无。

## P1（阻断）

### P1-1：行内代码/链接里的字面闭合标签让隐藏块提前闭合

位置：

- `scripts/gate-check.ts:637`：`const tag = /<\/?(?:details|pre|script|style|template)\b[^>]*>/gi`
- `scripts/gate-check.ts:643-654`：在原文上做标签配对，读到 `</details>` 字节就把隐藏区间闭合。

原因：扫描器按原始字节找闭合标签，不看 Markdown 行内代码、链接标题/目标、缩进代码；渲染器却把行内代码里的 `</details>` 当文本，`<details>` 元素仍然开着，后面的 pass 结论仍然折叠不可见。jsdom 对等价 HTML 的解析结果是 `open=false`、pass 段落仍在 details 内、code 文本为字面 `</details>`。

端到端结果（clone，分支 attack-d）：

- 报告：`docs/audits/S1-independent-audit-round10-attack-d.md`，可见正文写「本报告结论为不通过。」；唯一结论行在 `<details>` 内，闭合标签以行内代码出现。
- sign-gate exit 0：`重签完成：证据 13 份，candidate=40e019a1d2b3…，artifact_hash=a6892edb5463…，body_hash=4ccdecdd2af8…，改动文件 90 个`
- gate-check exit 0：`gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=a6892edb5463… body_hash=4ccdecdd2af8…）`
- 签后 G1 artifact_hash=`a6892edb54635b837becd59e0c2d146ba64dcc5ecf75a4c60dfc5c2afd7f86e6`；body_hash=`4ccdecdd2af8c6562e2ba39e250e830a44de40ff9f884620fed8cd5744a643c3`。

最小复现（只在临时 clone 里执行；clone 的 HEAD=9a44739、树干净；PowerShell）：

```powershell
$base = '9a44739c0d7c5a158c4dca4cab7ebe201d704966'
git checkout -q -B attack-d $base
$pass = '结' + '论：pass'
$report = @(
  '# 攻击样例 D', '',
  '门：G1',
  '候选提交：' + $base, '',
  '本报告结论为不通过。', '',
  '<details>', '',
  '本报告结论为不通过，下面这处是行内代码里的字面闭合标签。`</details>`', '',
  $pass, '',
  '</details>'
) -join "`n"
Set-Content -NoNewline -Encoding utf8 docs/audits/S1-independent-audit-round10-attack-d.md $report
$t = Get-Content -Raw docs/gates/G1.md
$t = $t.Replace('"audit_round": 1,', '"audit_round": 10,')
$t = $t.Replace('"audit_report": "docs/audits/S1-independent-audit.md"', '"audit_report": "docs/audits/S1-independent-audit-round10-attack-d.md"')
Set-Content -NoNewline -Encoding utf8 docs/gates/G1.md $t
git add -A; git commit -qm attack-d
D:\NodeJs\node.exe --experimental-strip-types scripts/sign-gate.ts    # exit 0
git add -A; git commit -qm signed
D:\NodeJs\node.exe --experimental-strip-types scripts/gate-check.ts  # exit 0
```

同一根因的其它形态（parser 探针 `D:/aboutAI/dsh-orchestra-audit-r10/probe-parser.ts`、`probe-ext.ts`，均返回 pass）：链接 title/destination 里含字面闭合标签、Tab 缩进代码块里含闭合标签、大写闭合标签、CRLF 版本。它们走的是同一个 `scripts/gate-check.ts:637` 扫描。

### P1-2：处理指令/DOCTYPE/CDATA 里的结论未被隐藏

位置：`scripts/gate-check.ts:617-663`。该函数只清 `<!-- -->`（621-633）和 details/pre/script/style/template 五类标签（637），没有处理 `<?...?>`、`<!DOCTYPE...>`、`<![CDATA[...]]>`。

原因：CommonMark 把这些起始的块原样输出为 HTML；浏览器把 `<?`、`<![CDATA[` 当 bogus comment、把 `<!DOCTYPE` 当 doctype，内容不渲染。jsdom 实测三类正文文本都为空（bodyText=""），而 auditConclusionOf 仍把里面的 pass 当顶层结论。门自己在 stripHiddenAuditBlocks 里已经承认注释与 details 属于隐藏文本，这三类没有理由例外。

端到端结果（分支 attack-e，报告 `docs/audits/S1-independent-audit-round10-attack-e.md`）：

- sign-gate exit 0，artifact_hash=34273d9686b9…，body_hash=84e7731196eb…；
- gate-check exit 0，13 项必过、13 份证据哈希复核；
- 签后 G1 artifact_hash=`34273d9686b9ef2e44b0a7829043aa6d93e7d43a17f9040bd53c56ec3f75af9f`。

最小复现：与 P1-1 相同的流程（同一 clone、同一份 G1 改法），把 `$report` 换成：

```powershell
$pass = '结' + '论：pass'
$report = @(
  '# 攻击样例 E', '',
  '门：G1',
  '候选提交：' + $base, '',
  '本报告结论为不通过。', '',
  '<?',
  $pass,
  '?>'
) -join "`n"
Set-Content -NoNewline -Encoding utf8 docs/audits/S1-independent-audit-round10-attack-e.md $report
# 再把 G1.md 的 audit_report 指向 attack-e 后提交、sign-gate、提交、gate-check
```

`<!DOCTYPE html` + pass 行 + `>` 与 `<![CDATA[` + pass 行 + `]]>` 同样能签过（探针结果见附表）。

## 第九轮 P1-1/P1-2/P1-3 复核

### 第九轮 P1-1（三种基础攻击）

在 clone 内分别提交攻击报告并改 G1 的 audit_round/audit_report 后运行 sign-gate：

- 嵌套 `<details><details></details>`：sign-gate exit 1，错误「审计报告里找不到唯一结论行，不能拿它当门记录依据: docs/audits/S1-independent-audit-round10-attack-a.md」；G1 blob 保持 `2663367f…`，未写盘；gate-check exit 1。
- 引用块内四空格：sign-gate exit 1，同一错误；G1 blob 不变；gate-check exit 1。
- 一个空格 + 一个 Tab：sign-gate exit 1，同一错误；G1 blob 不变；gate-check exit 1。
- 把这三份攻击记录的 audit_report_sha256 手工改成本次报告的实际哈希再跑 gate-check：三份仍 exit 1，错误仍是「找不到唯一结论行」，说明拒的是结论解析而不是旧哈希。

### 第九轮 P1-2（绑定与候选提交）

- 代码未动：HEAD 9a44739 的 diff 只改 auditTopLevelLines 的缩进/引用正则与 stripHiddenAuditBlocks；checkAuditAnchor（`scripts/gate-check.ts:724-771`）与 auditBindingOf（557-568）原样保留。
- 绑定要求：唯一门行 + 唯一 40 位候选行（750-757）；候选存在且是 HEAD 祖先（758-764）；候选提交后不得再改候选文件（765-770）。
- 单测：`tests/gate-check.spec.ts:355-363` 覆盖缺绑定、双门行、注释内绑定、短 sha；签后全量测试通过。
- 端到端：合法 pass 对照签后，往 clone 的 HEAD 再提交一笔 `src/infra/db/migrate.ts` 改动，gate-check exit 1，错误「审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：src/infra/db/migrate.ts」。

### 第九轮 P1-3（不变量固定口径）

- `scripts/gate-check.ts:311-343` 的 checkInvariants 逐条比对 statement 与 evidence_ids 的固定口径，并校验 id 集合完整；HEAD diff 未触及。
- `tests/gate-check.spec.ts:149-167` 把 I1 语句削成「epoch 栅栏」并重算 invariants_hash，check 仍抛「固定口径」；签后运行通过。

## 第九轮 P2-1..P2-5 复核（均闭合）

1. P2-1 G-08 证据：`docs/gates/evidence/G1/G-08.md:20` 已含「HTTP 队列满第二笔 HTTP=503 错误码=SERVICE_UNAVAILABLE；warning 原文=warn 写队列满了，拒掉这一笔写 {"pending":1,"max":1}」。在 clone 里重跑 `node --experimental-strip-types scripts/fault-inject.ts --case G-08` 两次：两次生成文件 SHA-256 都是 `2f2a73ddbf25fb59ea9b650635499856e66c94dcde81fca1a12ea3d424176c87`，等于 HEAD blob 的 sha256；生成文件 `git hash-object` 为 `22b8e5a6…`，与 `HEAD:docs/gates/evidence/G1/G-08.md` 相同；`git diff` 为空。
2. P2-2 写者锁：`tests/db-open.spec.ts:81-88` 覆盖「第二把锁 ELOCKED、释放后可再拿」，实测通过。
3. P2-3 append-only：`src/infra/sqlite/migrations/005_append_only_events.sql:3-14` 的 UPDATE/DELETE 触发器 + `tests/migrate.spec.ts:103-111` 的直接拒绝用例，实测通过（/events 只追加/，计数保持 1）。
4. P2-4 缺号：`src/infra/db/migrate.ts:24-46` 的连续性校验 + `tests/migrate.spec.ts:95-101` 的 001+003 负例，实测通过。
5. P2-5 签后测试：`tests/gate-check.spec.ts:149-167` 的 CRLF 不变量块查找与 `209-212` 的 audit_round+1 用例在签后通过；全量 vitest 0 失败（见下）。

## 合法 pass 对照与签后检查

- 对照报告：`docs/audits/S1-independent-audit-round10-control.md`（只用于机械验证，不是本轮审计结论），绑定 G1 + 9a44739，正文一条合法 pass 结论。
- sign-gate exit 0：candidate=40e019a1d2b3…，artifact_hash=b14560bb94e4…，body_hash=beae33413ece…。
- gate-check exit 0：「gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=b14560bb94e4… body_hash=beae33413ece…）」。
- 签后 G1 artifact_hash=`b14560bb94e4d34341338f92c7325f541c33d5db9ecd2776c8fc4db28efa7d48`，body_hash=`beae33413ece68e8266301c564e3cabbcb3fa5a86f350b5291c70b75d57c4a38`；candidate_hash=`40e019a1d2b3e000c059f6b021cf6460c174adf9d2f899de2bb6b08481114e34`。
- 签后 tsc --noEmit exit 0。
- 签后全量 vitest：Test Files 32 passed (32)，Tests 306 passed (306)，exit 0；第九轮遗留的两例（CRLF 不变量块、audit_round+1 自指）已消失。
- 预签基线（对照）：gate-check exit 1 属预期；vitest 11 failed / 295 passed，全部是 gate-check.spec 先撞上 audit_report_sha256=64 个 0 的预签态，不作为失败项。

## 附：反绕过探针与 HTML 解析

parser 探针（`D:/aboutAI/dsh-orchestra-audit-r10/probe-parser.ts`、`probe-ext.ts`，输入均带唯一门行与 40 位候选行、可见正文写不通过）：

| 形态 | auditConclusionOf |
| --- | --- |
| 基线：可见一行「结论冒号 pass」 | pass |
| 嵌套 details、引用块四空格、空格+Tab | null |
| details 内行内代码闭合标签（P1-1） | pass |
| 链接 title/destination 含闭合标签、大写闭合标签、Tab 缩进代码 | pass |
| 处理指令 + pass 行 + 问号大于号（P1-2） | pass |
| DOCTYPE + pass 行 + 大于号（P1-2） | pass |
| CDATA + pass 行 + 方括号闭合（P1-2） | pass |
| 普通 HTML 注释、未闭合 details、自闭合 details、实体编码 | null |

jsdom 对三类 HTML 的文本提取（`require('jsdom')`）：`PI bodyText=""`、`DOCTYPE bodyText=""`、`CDATA bodyText=""`、`COMMENT bodyText=""`；等价 details HTML 为 `open=false`、pass 段落在 details 内、`code` 文本为字面闭合标签。

## 附：临时目录与主仓库状态

- 临时 clone：`D:/aboutAI/dsh-orchestra-audit-r10/clone`（control-pass 分支为合法对照签后状态；attack-a..e 与 diff-guard 为攻击/复核分支）。
- 主仓库：HEAD 9a44739，除新增本报告外无改动；docs/gates、scripts、tests、docs/audits 旧文件均未改。
