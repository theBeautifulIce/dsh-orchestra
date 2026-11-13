# S1 G1 第十五轮独立审计报告

- 门：G1（S1）
- 候选提交：c6ffc208a76fee26f8e8006ef1272219e46ba16a（“Mask links before inline code so title conclusions cannot escape”）
- 审计方式：独立 clone、只读攻击、端到端签名与门检查
- 审计日期：2026-11-13 至 2026-11-14
- 结论：**fail**
- 计数：**P0 = 0，P1 = 2，P2 = 1**
- fail-open：**存在**。可见正文含 fail 的攻击报告仍被 sign-gate 签成 pass，gate-check 也返回 0。

## 摘要

候选提交修掉了上一轮的三条 P1 与 P2-1：Unicode 空白不再切断链接段，行内反引号按段落配对，链接段毒化行改到 HTML 掩码之后统一追加，合法 CDATA 不再把可见 fail 压成 null。上一轮四类原始攻击现在都返回 null 或 fail，方向正确。

但本轮仍有三处问题：

1. **P1-B：围栏关闭行用 Unicode trim 判定。** CommonMark 关闭围栏后只允许空格或 Tab；``` 后面跟 U+00A0、U+3000、U+FEFF 时，渲染器仍认为围栏开着，gate 却提前收栏，把围栏内第二行的 `结论：pass` 读成顶层结论。
2. **P1-C：列表项的四空格续行仍被当作缩进代码静默抹掉。** 列表项后的续行在渲染后是可见正文，gate 用 `previousBlank` 只覆盖了部分形态；`- 列表项 / 结论 / ：fail` 与空行后的四空格 `结论：fail` 都会被抹掉。没有可见 pass 时只少读 fail，返回 `null`（fail-closed）；与可见 pass 同时出现时 gate 直接返回 `pass`，虽然渲染后 pass 与 fail 都可见；与隐藏 pass 叠加时则把可见 fail 洗掉后签出门，形成 fail-open。
3. **P2：真正的多行缩进代码块被过度毒化。** 代码块首行之后出现 `结论：pass` 时，`previousBlank` 已为 false，整段被判毒化并返回 null；渲染器里这段只在 `<pre><code>` 内，正文另有可见 pass，属于 fail-closed 过严。

端到端攻击把 P1-B 与 P1-C 叠加：报告可见正文写“本报告可见正文的结论为不通过”，另有两个列表项可见 fail，最后用带 NBSP 的围栏藏一个 pass。gate 读出 pass，sign-gate exit 0，gate-check exit 0，artifact_hash 正常写出。渲染核对确认正文可见 fail、无可见 pass。这是本轮判 fail 的直接依据。

## 审计对象与方法

### 对象与工作区

- 本轮审计固定候选 c6ffc20；交付时主仓 HEAD 仍为 c6ffc20，G1.md 仍为预签态（`audit_round=1`、`audit_report=docs/audits/S1-independent-audit.md`、`audit_report_sha256=64 个 0`）。工作树另有本报告与另一代理的未跟踪 S2 报告；候选文件、门记录、证据均未被本轮改动。
- 攻击均在系统临时目录的 `git clone --no-hardlinks` 中完成：`dsh-audit-r15j`（c6ffc20 攻击）、`dsh-audit-r15-pos6`（c6ffc20 阳性对照）、`dsh-audit-r15-neg`（负向对照，基于 22d3760）。
- 主仓源码、门记录、证据均未改动；唯一写入主仓的文件是本报告。

### 渲染对照

- 用 `markdown-it-py 4.0.0` 的 CommonMark 解析器渲染攻击报告。
- 用 `html.parser` 提取可见文本，排除 `<pre>` 与 `<code>` 内的内容；同时检查 HTML 属性、链接 destination/title、引用定义等不参与正文渲染的位置。
- 攻击报告只允许出现渲染后可见的 fail；pass 只能落在链接 destination/title、图片 alt/title、引用定义、行内代码、围栏代码、HTML 注释/PI/CDATA/doctype 等隐藏位置。
- gate 侧直接调用候选 `scripts/gate-check.ts` 的 `auditConclusionOf`，并用 `node --no-warnings scripts/sign-gate.ts` 与 `gate-check.ts` 做端到端。

### 候选范围

- c6ffc20 相对 22d3760 只改 `scripts/gate-check.ts` 与 `tests/gate-check.spec.ts`，把 `maskAuditLinkDestinations` 提到 `maskInlineAuditCode` 之前，修 S2 第十八轮“行内代码吃掉 `[`、title 里 pass 漏成顶层”的 P0。
- `GATE_SPECS`、`evidenceMap`、`evidenceFiles`、`invariants`、`scripts/sign-gate.ts` 未改。
- 主仓其他代理的 S2 审计报告不在本门候选范围内，也不改变 G1 候选文件集合；本轮报告绑定 c6ffc20。

## P1/P2 明细

### P1-B：围栏关闭行把 Unicode 空白当作合法关闭后缀

**位置**：`scripts/gate-check.ts:658`

```ts
if (marker.char === fence.char && marker.length >= fence.length && marker.rest.trim() === '') fence = null
```

**机制**：CommonMark 的关闭围栏只允许 0 至 3 个空格或 Tab 作为后缀；`String.prototype.trim()` 还会去掉 U+00A0、U+3000、U+FEFF 等 Unicode 空白。于是 ```+NBSP 被 gate 当成关闭围栏，渲染器却仍把它当作围栏内容。围栏内后续的 `结论：pass` 在渲染后仍属于 `<pre><code>`，gate 却把它读成顶层结论。

**实测**：

````text
结论：pass

```
结论：pass
``` 
结论：pass
```
````

（上段示意中，围栏关闭行是三个反引号后跟 U+00A0；实际攻击文本用 `String.fromCharCode(0xa0)` 构造。）

- `auditConclusionOf` 返回 `pass`。
- markdown-it 渲染：第一段是可见 pass；从 ``` 到文件尾都在 `<pre><code>` 内，第二个 `结论：pass` 不可见。
- 若在围栏前另写可见 fail，gate 仍返回 pass；这正是端到端攻击的组合方式。
- U+3000、U+FEFF 同样触发；U+2028 因 `fenceMarkerOf` 的 `.` 不匹配行终止符，返回 null，未触发。

**复现**：

```js
import { pathToFileURL } from 'node:url'
const mod = await import(pathToFileURL('scripts/gate-check.ts').href)
const F = String.fromCharCode(96).repeat(3)
const NB = String.fromCharCode(0xa0)
const text = '结论：pass\n\n' + F + '\n结论：pass\n' + F + NB + '\n结论：pass\n'
console.log(mod.auditConclusionOf(text)) // pass
```

### P1-C：列表项四空格续行被静默抹掉

**位置**：`scripts/gate-check.ts:690-693`

```ts
if (!previousBlank) {
  const normalized = normalizeAuditLine(body)
  if (/(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]/.test(normalized) || /^(?:pass|fail|通过|不通过)$/i.test(normalized)) poisoned = true
}
previousBlank = blank
return blankPreservingLines(line)
```

**机制**：`maskIndentedAuditCode` 只把“空行之后”的四空格当确定的缩进代码；列表项后的四空格被视为续行，理论上应毒化。但它逐行判断，且只认单行归一化后的结论词：

- `结论` 一行没有冒号，不命中；下一行 `：fail` 也不命中独立 pass/fail 正则，于是整段被当作代码抹掉，渲染器却把它显示在列表项里。
- 列表项后先有空行、再有四空格时，`previousBlank` 为 true，函数把它当真正的缩进代码直接抹掉，不毒化；渲染器仍把它作为列表项的第二段可见。

**实测 1（续行拆成两行）**：

```text
结论：pass

- 列表项
    结论
    ：fail
```

- `auditConclusionOf` 返回 `pass`。
- markdown-it 渲染为 `<li>列表项\n结论\n：fail</li>`，`结论：fail` 可见。
- gate 抹掉两行缩进后只剩顶层 pass。

**实测 2（空行后四空格）**：

```text
结论：pass

- 列表项

    结论：fail
```

- `auditConclusionOf` 返回 `pass`。
- markdown-it 渲染为 `<li><p>列表项</p><p>结论：fail</p></li>`，fail 可见。
- 空行使 `previousBlank=true`，四空格被当代码块，不毒化。

**判定后果**：实测 1、2 中渲染后同时可见 `结论：pass` 与 `结论：fail`，gate 仍返回 `pass`；按“可见 fail 优先”的判定口径，这是 fail-open。没有可见 pass 时该路径只返回 `null`，属于 fail-closed 少读。

**与 P1-B 叠加的端到端攻击**：

报告正文先写：

```text
本报告可见正文的结论为不通过。
```

再写两个列表 fail（上述两种形态），最后写：

````text
```
结论：pass
``` 
结论：pass
```
````

- gate 读出 `pass`。
- 渲染后可见文本含“本报告可见正文的结论为不通过”与两处“结论：fail”，没有可见的“结论：pass”；pass 只在围栏代码内。
- 这条报告被 sign-gate 以 exit 0 签过，gate-check 也 exit 0。
- 因此不是单纯的 fail-closed 少读，而是可见 fail 被 pass 洗掉后签出门，属于 fail-open。

### P2：真正的多行缩进代码块被过度毒化

**位置**：`scripts/gate-check.ts:688-693`

**机制**：真正的缩进代码块从空行后开始，首行 `previousBlank=true`，不会被毒化；第二行起 `previousBlank=false`，只要行内出现 `结论：pass` 就会被判毒化，尽管它仍在同一个 `<pre><code>` 内。函数没有跟踪“当前是否已进入真正的缩进代码块”，只按前一行的空白状态逐行判断。

**实测**：

```text
    其他
    结论：pass

结论：pass
```

- markdown-it 渲染：前两行在 `<pre><code>` 内，正文只有一个可见的 `结论：pass`。
- `auditConclusionOf` 返回 `null`，sign-gate 会拒绝；这是 fail-closed 过严，计 P2。
- 若 pass 放在代码块首行（`结论：pass\n\n结论：pass`），返回 pass，说明 6615f79 的“真正缩进代码不毒化”只覆盖首行。

**复现**：

```js
const text = '    其他\n    结论：pass\n\n结论：pass\n'
console.log(mod.auditConclusionOf(text)) // null
```

## 已确认堵住的面

以下攻击在 c6ffc20 上均未漏成 pass；括号内为实测返回：

- 上一轮 P1-1：U+00A0、U+2003、U+3000、U+000C、U+000B、U+FEFF 作为段落空行，链接 title 藏 pass，正文可见 fail：全部 `null`。
- 上一轮 P1-2：前段孤立反引号与链接 title 内反引号跨段配对，吞掉真实链接的 `[`：`null`。
- 上一轮 P1-3：链接段毒化行位于未闭合 HTML 注释、处理指令、doctype 之前：`null`。
- 上一轮 P2-1：合法 CDATA 段藏 pass，段外可见 fail：`fail`（不再返回 null）；未闭合 CDATA 仍毒化兜底：`null`。
- 行终止符与 NUL：U+2028、U+2029、U+0085、NUL 混入段落/链接段：`null`。
- 链接 title 里写 `<!--` 后跟可见 fail：`null`。
- `[结论](url)：fail`（链接文本带结论、后跟可见结论词）：`null`。
- `[结论][r]：fail` 加引用定义：`null`。
- 反斜杠转义反引号加链接 title 藏 pass（S2 第十八轮形态）：`null`。
- 正文讨论性文字“见[证据](url)，这里讨论结论”不应误伤：`pass`。
- 纯 Markdown 只有可见 `结论：pass`：`pass`。

## 阳性对照

在独立 clone `dsh-audit-r15-pos6` 中，把 G1 的 `audit_round` 改为 15、`audit_report` 指向只含可见 `结论：pass` 的纯 Markdown 报告，提交后：

- `sign-gate` exit 0
- `gate-check` exit 0
- `artifact_hash=2d1ee916fae0181d772df1e97dd97a0d33c0397284703e7ab88e474a7b9314a8`
- `body_hash=bbcedd524dd38f36a4e1b9fc203924e5013b0dacd9383bdbb691aa74577b9897`

说明 gate 尚未退化为“任何报告都拒绝”；本轮 fail 来自具体的渲染不一致，不是整体阳性通路坏掉。

## 测试与差异

### 主仓测试

- `node_modules/typescript/bin/tsc --noEmit`：exit 0。
- `vitest run tests/gate-check.spec.ts`（主仓预签态）：11 failed / 47 passed。全部 11 条失败都发生在 `checkAuditAnchor`，报错为 `审计报告 sha256 与记录不符：0000… != 50ba1b13…`；原因是主仓 G1 仍是 `audit_report_sha256=64 个 0` 的预签态，测试却按已签记录断言。这是预签态与测试夹具的差异，不是 c6ffc20 的代码回归。
- 在已签名的攻击 clone（G1 指向本轮报告、哈希已写实）中跑同一测试文件：**58 passed / 0 failed**，exit 0。说明测试代码本身在候选上全绿。

### 端到端关键值（攻击 clone `dsh-audit-r15j`）

- 报告提交（签名前）：`11451475ab7f17ef5b287a4e031b0049b718ddd3`
- G1 签前 sha256：`439cae7548de21fb7eff923730a3f1f96beb144c7765fbde66742f0fe5b6657f`
- `sign-gate` 输出：重签完成，证据 13 份，candidate=1071a79bbd32…，artifact_hash=975f0b28956b…；**exit 0**
- G1 签后 sha256：`b814e8e93a547f32da1fb3ab778f8f74ab441b367d035ab34152d062f7c4ca17`（字节已被改写）
- `gate-check`：**exit 0**，且未再改写 G1
- `artifact_hash=975f0b28956bc606e7d0ed4f7e620edfec843dce0f6070300401529a93c2f371`
- `body_hash=278fce42440b3e0fbb30689ee22a83a954786996c7bd7817cdfdf78aa5897ba4`
- `candidate_hash=1071a79bbd32e8f92440081173609c63e42733ea866cac8d3fa33d62483a9abd`
- `audit_report_sha256=e94644f81da4f82294717d96722d3cd4700c452343783c0d62741fcfa974e131`

### 渲染核对

- markdown-it-py CommonMark 渲染后，散文可见文本含：
  - `本报告可见正文的结论为不通过。`
  - `列表项 结论 ：fail`
  - `列表项 结论：fail`
- 可见文本不含 `结论：pass`；pass 只出现在 `<pre><code>` 内。
- 但 gate 的结论是 `pass`，且报告被签过。这是“渲染不可见 pass 被读成唯一结论、可见 fail 被洗掉”的 fail-open。

### 负向对照（clone `dsh-audit-r15-neg`，基于 22d3760）

- 只有可见 fail、没有 pass 的报告：`sign-gate` exit 1，报错“审计报告结论与门记录结论不符：报告=fail，门记录=pass”，G1 不变。
- 报告候选提交后再改证据：`sign-gate` exit 1；先报工作树脏，提交后报“审计报告的候选提交之后，候选文件又被改过”，G1 不变。
- 边界观察：把证据篡改一并提交成新候选、报告绑新候选后，sign-gate 会按新候选重算证据哈希并签过。这不是 c6ffc20 的渲染 fail-open，属于候选定义/证据锚点问题；本轮不计 P0，但说明“候选提交之后证据不可变”这条防线只对同一候选有效，不能替代外部可信基线。

## 复现步骤

1. `git clone --no-hardlinks D:/aboutAI/dsh-orchestra %TEMP%/dsh-audit-r15j`
2. `git -C %TEMP%/dsh-audit-r15j checkout c6ffc208a76f`
3. 确认 `git status --porcelain` 为空。
4. 在 clone 的 `docs/audits/` 写攻击报告：可见 fail 用正文与列表项，pass 用带 NBSP 的围栏藏住；把 `docs/gates/G1.md` 的 `audit_round` 改为 15，`audit_report` 指向该报告。
5. 提交报告，运行 `node --no-warnings scripts/sign-gate.ts docs/gates/G1.md`。
6. 提交签后 G1，运行 `node --no-warnings scripts/gate-check.ts docs/gates/G1.md`。
7. 用 markdown-it-py 渲染该报告，提取 `<pre>/<code>` 之外的可见文本，确认可见 fail 存在、可见 pass 不存在。

## 结论依据

- 候选确实修掉了上一轮 P1-1、P1-2、P1-3 与 P2-1；这些面本轮不再漏。
- 但 P1-B 与 P1-C 仍能让“渲染后可见 fail”的报告被 gate 读成 pass，并被 sign-gate 以 exit 0 签出、gate-check 以 exit 0 放行；端到端已实测，不是理论推演。
- P2 是同一套缩进判定造成的过严分支：合法报告被拒绝，影响可用性，不构成 fail-open。
- 因此本轮结论为 **fail**：P0=0，P1=2，P2=1。
