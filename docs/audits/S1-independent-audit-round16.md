# S1 独立审计（第十六轮）

- 门：G1
- 候选提交：074158eea2af4bdfea9a21230391f4d46f63db40

结论：fail

## 对象、范围与方法

本轮候选为 `074158eea2af4bdfea9a21230391f4d46f63db40`（074158e），相对上一轮 `c6ffc20` 只改 `scripts/gate-check.ts` 与 `tests/gate-check.spec.ts`。主仓只写本报告，未修改代码、未签门、未提交、未 `git add`。所有攻击、测试与签门验证都在主仓之外的临时 clone 中进行：`git clone --no-hardlinks D:/aboutAI/dsh-orchestra <tmp>`，checkout 候选，`node_modules` 用 junction 指向主仓；渲染对照用 markdown-it-py 4.0.0 的 CommonMark 模式，可见文本提取跳过 pre/code 代码块。

基线：候选 clone 内 `D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit` exit 0；`D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/gate-check.spec.ts` 为 11 failed / 49 passed（60 例），11 例失败均为预签态 `audit_report_sha256=0*64` 与测试夹具的差异，非候选回归。在阳性对照的已签 clone 内同一测试为 60 passed / 0 failed，exit 0。

## P0

无。

## P1

### P1-1 列表项首行开围栏时，门把围栏里的隐藏通过结论读成顶层结论

**位置**：`scripts/gate-check.ts:633-640`（`fenceMarkerOf`）、`:643-673`（`maskFencedAuditCode`）、`:679-721`（`maskIndentedAuditCode`）、`:586-619`（`auditTopLevelLines`）。

**机制**：`fenceMarkerOf` 只匹配行首 0–3 个空格的围栏标记，不识别列表标记或引用前缀。CommonMark 允许 `- ~~~`、有序列表标记加三反引号、`> - ~~~` 等在列表项/引用容器内开围栏，续行只缩进 2–3 空格；渲染器把这些续行放进 pre/code 代码块，门却不认为这是围栏，也不把 2–3 空格当缩进代码，于是 `  结论：pass` 被 `auditTopLevelLines` 读成顶层结论。若列表项内还有闭合围栏，门还会把闭合行误当开启围栏，吞掉其后正文（方向为过严，见 P2-1）。

**单元实测**（`auditConclusionOf` + 渲染核对）：`orderedDotUnclosed=pass`、`orderedParenUnclosed=pass`、`listBlockquoteFence=pass`、`quoteNestedListFence=pass`、`listQuoteBacktickClosed=pass`。上述载体渲染后的可见文本都只有散文「本报告可见正文的结论为不通过。」，通过结论在 pre/code 代码块内。对照：`standardFenceHiddenFail=pass`（正常）；`listFenceHiddenFail=null`（过严，见 P2-1）。

**端到端**（clone `C:\Users\ASUS\AppData\Local\Temp\dsh-audit-r16`）：

- 攻击报告 `docs/audits/S1-independent-audit-round16-attack.md`，sha256=`31c10057eae24f5fac68f365b09234b9a724004939d5d0f961afcc22dedaadb0`。关键内容为标题、门、候选、散文失败声明，以及 `- ~~~` 换行后两空格缩进的「结论：pass」；渲染后通过结论不可见。
- 报告提交 `bfcd19bdca127bcae427392c061c04d678682d27`；G1 签前 sha256=`0f5ffa31c007a116f2ff4df89a067c9e14dca62028f5d8d5f07966f532368118`。
- `D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G1.md` → exit 0；G1 签后 sha256=`f1cfc81c8f68ce55f5af254c7843f41d552e92a1fb4bfc41d4f0e83df56aa14e`，artifact_hash=`79c37944e8bee20a59d4675f7efefd43fce0529987af67876edaf66a9e814a5c`，body_hash=`69380090ef987bbbe590f61115b4c796b56605ba373b5f39110a95a92d7c416c`；签后提交 `b567102fb35f815063dd1850c80f6e25c71dc996`。
- `D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md` → exit 0（13 项必过、13 份证据），门记录被改写且放行。
- 根因判定：隐藏的通过结论被读成唯一结论，门据此签门并改写记录；属 fail-open。

**复现**：见文末命令段；攻击报告文本为标题三行、空行、散文失败声明、空行、`- ~~~`、换行、两空格加「结论：pass」。

### P1-2 引用定义后的缩进行被无条件跳过，渲染可见的失败结论被抹掉

**位置**：`scripts/gate-check.ts:832-853`（`visibleTextOfLinkParagraph`）；`:855-895`（`maskAuditLinkDestinations`）；`:840` 的定义识别正则。关键判断与正则如下（围栏代码不参与正文判定）：

```ts
if (inDefinition && /^[ \t]+/.test(line)) continue
/^[ \t]*(?:>[ \t]*)*\[[^\]]+\]:/
```

**机制**：段落首行被识别为引用定义（方括号标签、冒号、URL）后，函数把其后所有缩进行都当作定义续行跳过，未校验该行是否可能是合法 title，也未校验定义是否已结束。CommonMark 中，一行引用定义之后直接缩进一行普通文字，定义已结束，该行是新段落并渲染可见；`maskAuditLinkDestinations` 因段落含方括号整段隐藏，用重建的可见文本（该行已被跳过，为空）替换，且未触发毒化，于是可见的失败结论被静默抹掉，只剩前面的可见通过结论。

**单元实测**：`def2SpaceTrailing=pass`、`defTitleTrailing=pass`、`defEmptyDestTrailing=pass`；三者渲染后的可见文本同时包含「结论：pass」与「结论：fail」。对照：`def4SpaceTrailing=null`（四空格渲染为缩进代码，失败不可见）、`defNoDest=null`、`defInList=null`、`defValidOnly=pass`。

**端到端**（clone `C:\Users\ASUS\AppData\Local\Temp\dsh-audit-r16-attack2`）：

- 报告 `docs/audits/S1-independent-audit-round16-attack2.md`，sha256=`fcbc806ec727483f37ec846f2b04a98a59e3587c1196669eb3a3347e026bbde4`。其正文逐字如下（围栏只是本报告的展示容器；实际攻击文件没有外层围栏）：

```text
# S1 独立审计（第十六轮）

- 门：G1
- 候选提交：074158eea2af4bdfea9a21230391f4d46f63db40

本报告可见正文的结论为不通过。

结论：pass

[foo]: /url
  结论：fail
```

- markdown-it 渲染可见文本同时含 pass 与 fail；`auditConclusionOf` 返回 pass。
- 报告提交 `07be1db1e932df235a64538c77c454a1c96b4ef5`；G1 签前 sha256=`C0CDDEA37547FA019D5D48A9309EBB27E3EA2ECD8F2C8268A5EA0DE053BCDEDB`。
- `sign-gate` → exit 0；G1 签后 sha256=`234AA990713FA7F63E71A35B25177C42E01C624B000E6D979D62E482F7A94033`，artifact_hash=`f586aa424b4dd401a0432f5c0a8be6ed13ac2b1ed15f231d52dd1b3c7cc05cd0`，body_hash=`9770fda54bb680ca6e101d5d170f2c2c77f8f7f3aa98b129cc0398d842aa0685`。
- 签后先直接跑 gate-check，因 G1 尚未提交、工作树脏，返回 exit 1（`门检查失败：工作树有未提交改动…`）；提交签后 G1（`4eb30bd67ebf8207b3a8838386ea6749d261a82b`）后重跑，exit 0（13 项必过、13 份证据哈希复核）。失败只来自脏树门槛，不是门拒绝该记录。
- 根因判定：可见失败结论被隐藏段吞掉后，门以可见通过结论签门并改写记录；属 fail-open。

## P2

### P2-1 列表容器围栏内的隐藏失败结论被毒化，报告判 null

正文可见 pass、`- ~~~` 内藏 fail 时，`listFenceHiddenFail=null`；渲染可见只有 pass。根因与 P1-1 相同，方向是过严，不阻断签门，计 P2。

### P2-2 引用定义后的缩进隐藏内容被过度毒化，报告判 null

`def4SpaceTrailing`（引用定义行后四空格缩进的 fail，渲染为代码不可见）与 `defNoDest`（无目标定义后四空格 fail）均返回 null，而可见文本只有正文 pass。根因与 P1-2 同段，方向是过严，计 P2。

## 第十五轮复验

| 复验项 | 攻击形态 | auditConclusionOf | 渲染可见 | 判定 |
| --- | --- | --- | --- | --- |
| P1-B | 可见 fail + 围栏内 pass + 反引号后 U+00A0 关闭 + 段后 pass | null | 只有 fail | 已闭合（由 pass 收紧为 null） |
| P1-B | 同上，关闭后缀 U+3000 | null | 只有 fail | 已闭合 |
| P1-B | 同上，关闭后缀 U+FEFF | null | 只有 fail | 已闭合 |
| P1-C | 列表项四空格续行「结论」「：fail」分两行 | null | pass 与 fail 同时可见 | 已闭合（不再放行） |
| P1-C | 列表项空行后四空格「结论：fail」 | null | pass 与 fail 同时可见 | 已闭合（不再放行） |
| P2 | 真正多行缩进代码含 pass，正文另写可见 pass | pass | 只有正文 pass | 已闭合（不再过度毒化） |
| 正文 pass + 隐藏 fail | 可见 pass + 标准围栏内 fail | pass | 只有 pass | 符合预期 |
| 正文 pass + 隐藏 fail | 可见 pass + 四空格缩进 fail | pass | 只有 pass | 符合预期 |

三种非 ASCII 关闭后缀下，隐藏段不再被读成结论；返回 null 属 fail-closed 收紧，不构成放行。P1-C 的两种原始形态也不再返回 pass。P2 的原始形态恢复为 pass，只读可见正文。

## 阳性对照与负向对照

**阳性对照**（clone `C:\Users\ASUS\AppData\Local\Temp\dsh-audit-r16-pos`）：报告 `docs/audits/S1-independent-audit-round16.md` 只含纯 Markdown 可见「结论：pass」，sha256=`08e3f80a768f7091d72891a68ef46a51d095326fd4f8c5cfe151dd5cc6304ace`，报告提交 `cb4342ae4f5b2fa001c9d1b53f7f0fad3d6a00a6`；G1 签后 sha256=`0C425E78F8BD8C789E37C47C2744C66992B18F5A40C6D9438886AA0C1E358398`；sign-gate exit 0，artifact_hash=`f71ad3719c6692ddedeffcbf7ceab4a191dfc7a0542efc6eb5254ffe9b2fb6cd`，body_hash=`49d606a99b93dd2d68b766882adf075ede469e221e9b01ad54b78958386e9db5`；签后提交 `d31abb3f99515490bee7c021d6850ccfebffd779`；gate-check exit 0（13 项必过、13 份证据）。该 clone 内 tsc exit 0，vitest 60 passed / 0 failed。

**负向对照**（clone `C:\Users\ASUS\AppData\Local\Temp\dsh-audit-r16-neg`）：报告只含可见「结论：fail」，sha256=`69e7c8191c44a3a30428652ee05aa36e9c580b7092289685681ab91f8ac654b6`；G1 sha256 签前为 `6EE23B7AF9DE108F658B6ECE9D09A5B59609410709BEFFB55FC700645B0371B8`，sign-gate exit 1 后不变；报错为 `Error: 审计报告结论与门记录结论不符：报告=fail，门记录=pass`（`scripts/gate-check.ts:1109`、`scripts/sign-gate.ts:81`）。门记录未被改写。

## 其他主动探测

- 纯引用围栏（`> ~~~`、`> 三反引号`，含闭合）藏 pass：null，未构成放行。
- pre 标签、div 标签、未闭合 HTML 注释、已闭合 HTML 注释藏 pass：null。
- 图片 alt、引用式图片 alt、链接 title、链接文本中的 pass：均为 null；未发现新的隐藏 pass 被读成结论路径。
- 列表内嵌套引用围栏（`- > 三反引号` 加续行）返回 pass，归入 P1-1 的容器前缀根因。

## 证据与复现命令

```text
git clone --no-hardlinks D:/aboutAI/dsh-orchestra %TEMP%\dsh-audit-r16-attack2
cd /d %TEMP%\dsh-audit-r16-attack2
git checkout 074158eea2af4bdfea9a21230391f4d46f63db40
cmd /c mklink /J node_modules D:\aboutAI\dsh-orchestra\node_modules
D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G1.md
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md
```

单元复现用 Node 直接导入候选的 `scripts/gate-check.ts`，调用 `auditConclusionOf` 并配合 markdown-it-py 的 CommonMark 渲染核对可见文本。两条 P1 的端到端报告与提交、签前/签后 G1 sha256、artifact_hash/body_hash、sign-gate 与 gate-check 的 exit code 已列在对应小节。

## 计数与临时目录

- P0=0，P1=2（P1-1、P1-2），P2=2（P2-1、P2-2）。
- 临时 clone 全部位于 `C:\Users\ASUS\AppData\Local\Temp\dsh-audit-r16*`，审计结束后删除：`dsh-audit-r16`、`dsh-audit-r16-pos`、`dsh-audit-r16-neg`、`dsh-audit-r16-attack2`。
- 主仓仅新增本报告（未跟踪），未改代码、未签门、未提交、未 `git add`；主仓 G1 保持审计前状态。
