# S1 独立审计第二十轮报告

门：G1
候选提交：638605c42d3ca4545fb1ad7e29b381a2a4cf6df9

结论：fail

本轮判定为 `fail`：前轮四类精确载荷已 fail-closed，但同性质的邻近变体仍可签过，且门正文的 160 字窗口另有独立绕过。P0=4、P1=2、P2=1。

## 审计范围与方法

- 仓库：D:/aboutAI/dsh-orchestra；候选 HEAD 638605c42d3ca4545fb1ad7e29b381a2a4cf6df9；审计开始时工作树干净。
- 只读审计；未改源码、门记录、测试；未提交、未签主仓门。唯一写入为本报告。
- 端到端攻击在临时 clone D:/aboutAI/_g1audit-r20/clone 进行：每例 `git reset --hard 638605c`、`git clean -fd`，只改 G1 artifact 的 `audit_round`、`audit_report`，再写攻击报告或把载荷插到门正文 `## 必过项与证据` 之前；提交后跑 `scripts/sign-gate.ts`，签成功再跑 `scripts/gate-check.ts`。
- 主仓跑 `tsc --noEmit` 与全量 `vitest run`；并用独立脚本重算证据、正文表与四个哈希。
- 审计过程中工作树出现外部未跟踪文件 `docs/audits/S2-independent-audit-round24.md`；不属于本审计产物，未参与 G1 绑定，也未改动。

## 前轮 P0 逐项复核

r19 的精确载荷全部被拒绝；但拒绝路径并不等于性质覆盖。报告侧多数首错是 `gate-check.ts:1345` 的“审计报告里找不到唯一结论行”，属于把载荷标成歧义后的 fail-closed，不是逐词命中。

| r19 类别 | 精确载荷 | 报告侧 E2E | 门正文侧 E2E |
|---|---|---|---|
| 三行拆词 | `本报告不` / `通` / `过` | exit 1，G1 不变 | exit 1，G1 不变；首错 1445“正文=fail，artifact=pass” |
| 图片 alt 实体 | `&#xFF08;`、`&nbsp;`、`&colon;`、数字实体、`&quot;` | 5 例全部 exit 1，G1 不变 | `&#xFF08;` 例 exit 1，G1 不变；首错 1443“结论行缺失或不唯一” |
| 引号包裹 | ASCII 双/单引号、弯单引号、全角引号、法文引号 | 6 例全部 exit 1，G1 不变 | 正文引号直接探针返回 fail |
| 门记录正文注入 | 三行拆词、图片 alt 实体 | — | 2 例均 exit 1，G1 不变 |

复核结果为：r19 列出的精确载荷已修复；但下面是同一判定性质上未覆盖的邻近变体。

## P0

### P0-1 五行拆词：报告与门正文都可签过

载荷（报告正文或门正文均可）：

```text
本
报
告不
通
过
```

- 报告侧 E2E `new-5line-split`：sign-gate exit 0，签后 gate-check exit 0；artifact_hash=fc74bc0ee1be…，body_hash=c1e43cef93bd…。
- 门正文侧 E2E `body-new-5line`：sign-gate exit 0，gate-check exit 0；body_hash=9eae7a0ad273…。
- 直接探针 `new-5line-spaces`（行间带空格）同样返回 pass。
- 根因：`scripts/gate-check.ts:679-683` 的报告侧滑动拼接只做 span 2..4，`726-732` 的正文侧同样只做 2..4；五行从任何起点都拼不出完整句子。六行单字符反而被表格单元格规则捕获，所以这不是“行数越多越安全”。
- 性质：可见的否定句写在连续行上，签名器仍判 pass；这是门核心不变量“可见 fail 必须阻断签名”的直接违反。

### P0-2 图片 alt 的不可见字符与组合符

报告侧 E2E `new-img-zwsp`：

```markdown
![本报告不&#8203;通过](x.png)
```

- sign-gate exit 0，签后 gate-check exit 0；artifact_hash=d4f0204ce4d6…，body_hash=fdecc3a7da09…。
- 门正文侧同一载荷 `body-new-img-zwsp`：sign-gate exit 0，gate-check exit 0；body_hash=13f90d7c3737…。
- 直接探针另外确认：`&ZeroWidthSpace;`、原始 U+200B、组合符 U+0301、`<wbr>` 均返回 pass。
- 根因：`scripts/gate-check.ts:609` 对图片 alt 只调 `AUDIT_MARKDOWN.utils.unescapeAll(child.content)`，随后直接交给 `visibleFailStatement`；没有走 `normalizeAuditLine`（`1254-1271`，会剥 `Cf`/`Mn`/`Me`）。零宽字符或组合符把“不通过”拆成不可匹配的文本，alt 又不进入 buffer，于是既不算可见 fail，也不触发歧义。
- 性质：图片 alt 是渲染文本的一部分；在 alt 里写可见否定句并夹一个不可见字符，签名器仍判 pass。

### P0-3 收尾引号与 emoji 尾部：德式/〝〞/｢｣/🚫

报告侧 E2E：

```text
„本报告不通过“
本报告不通过🚫
```

- `new-quote-german`：sign-gate exit 0，gate-check exit 0；artifact_hash=24250dadbb19…，body_hash=74cb64081d71…。
- `new-emoji-tail`：sign-gate exit 0，gate-check exit 0；artifact_hash=a4e9ab665433…，body_hash=27a5ec098782…。
- 门正文侧 `body-new-german`、`body-new-emoji`：均 sign-gate exit 0、gate-check exit 0；body_hash 分别为 29e5597e5e3d…、cf180ae8fb63…。
- 直接探针还确认 `〝本报告不通过〞`、`｢本报告不通过｣` 返回 pass。
- 根因：`scripts/gate-check.ts:634` 的 `FAIL_VERDICT` 尾部 lookahead 字符类补了 ASCII/弯/全角/法文引号，但不含 U+201C（德式右引号）、U+301E、U+FF63、emoji。正则要求“不通过”后面紧跟允许的收尾字符，收尾字符不在类里就整条不匹配。
- 性质：同一句“本报告不通过”，换个常见收尾符号即可签过；r19 的引号修复是枚举式补字符，没有覆盖收尾字符集。

### P0-4 门正文的 160 字长行与 24 字偏移窗口

门正文侧 E2E：

```text
复核补充：本报告不通过，详见附录。注注……（共 160 个“注”）
复核补充：前前……（25 个“前”）本报告不通过
```

- `body-new-longline`：sign-gate exit 0，gate-check exit 0；body_hash=81a0dee3a8a4…。
- `body-new-offset`：sign-gate exit 0，gate-check exit 0；body_hash=b7feb78aba55…。
- 根因：`scripts/gate-check.ts:648` 在跑正则前先判 `line.length > maxLength` 直接 `return false`；`652` 再判 `m.index > maxStart` 直接 `return false`；`bodyWindow` 在 `721` 定义为 `{maxStart:24,maxLength:160}`。超长行整行不检查，否定词出现在第 25 个字符之后也不检查。
- 性质：只要把可见否定句放在长行尾部或向右偏移，门正文的 fail 检测就看不到；报告侧没有这个窗口，所以这是门正文独立的一类绕过。

## P1

### P1-1 主语与谓语的邻近同义写法仍返回 pass

直接对 clone 的 `auditConclusionOf` 做探针（基座为 `结论：pass`，结果由 D:/aboutAI/_g1audit-r20/probe-conclusion.mjs 输出）：

```text
审计报告不通过 -> pass
本报告没有通过 -> pass
本报告并未通过 -> pass
本报告未获通过 -> pass
本报告不通過 -> pass
本报告结论为ｆａｉｌ -> pass
本报告不（通过） -> pass
```

根因：`633` 的 `FAIL_SUBJECT` 只有“本报告/本次审计/……/审计”，后面没有“报告”；`634` 的 `FAIL_VERDICT` 只认 `fail`、`不通过`、`未通过`、`不合格`，不认“没有通过”“并未通过”“未获通过”、繁体“通過”、全角 `ｆａｉｌ` 和括号插入。这里只做到解析器级复现，未做端到端签名；一旦排版成行首可见句，性质与 P0 相同。

### P1-2 回归测试只覆盖精确载荷，测试绿不等于性质覆盖

`tests/gate-check.spec.ts:690-722` 只覆盖 r19 的精确三行拆词、六种引号、alt 的 `&#xFF08;`/`&nbsp;`/`&colon;`/数字实体/`&quot;`。没有覆盖：五行拆词、alt 的 U+200B/零宽实体/组合符、德式与 `〝〞`/`｢｣`、emoji 尾、门正文 160 字长行和 24 字偏移。因此“gate-check 71 例 60 过 11 允许失败、全量 340 例 329 过 11 允许失败”只能证明已有断言通过，不能证明上述性质被覆盖；本轮 4 个 P0 正是在这些空白处签过。

## P2

### P2-1 预签态 G1 的 artifact、证据与候选锚也是旧值

主仓 G1 当前是预签态：`audit_report_sha256=0*64`，`audit_round=1`，`audit_report=docs/audits/S1-independent-audit.md`。独立重算发现 13 份证据中 6 份与记录不符：ev-epoch、ev-g08、ev-g14、ev-g15、ev-gatecheck、ev-migrate；`artifact_hash` 实算 f54dcae873f34a98…、记录 1ce80f6080fb2271…；`body_hash` 实算 111ce311f354ff58…、记录 446357f9e00e384a…；`candidate_hash` 实算 d26b7be241097255…、记录 bbd322cf9d4ef5fb…；`change_scope_hash` 实算 83793fffc1fb10e1…、记录 ea15eaba761c24c7…。

这不是 sign-gate 缺陷：合法签过一次后，sign-gate 会刷新这些字段；签后独立复核 36/36 项通过。它说明“预签态只补 `audit_report_sha256` 就能过”不成立，预签 G1 只能作为 fail-closed 夹具，不能当作其余字段都正确的近通过样例。

## 合法阳性对照与绑定复核

- `positive-clean`：干净 pass 报告（绑定行 + `结论：pass` + artifact `audit_round=20`、`audit_report=docs/audits/S1-independent-audit-round20.md`）sign-gate exit 0，签后 gate-check exit 0；artifact_hash=7472e64f8b35…，body_hash=ef5a55d47f03…，candidate=d26b7be24109…，改动 115 文件。证明 fail-closed 没有误杀正常报告。
- 签后独立复核（clone HEAD 860b2def8b12）：36/36 OK。13 份证据按 LF 归一重算全对，正文证据表 13/13 对；evidence_index_hash=6bfcd058827051b9…、invariants_hash=6f75465bfb0ecf3a…、artifact_hash=7472e64f8b3556f0…、body_hash=b7feb78aba557d0e…、candidate_hash=d26b7be241097255…、change_scope_hash=83793fffc1fb10e1…；报告 SHA256=3325d0e4bc66d91d…。
- 报告绑定：签后报告“门：G1”与“候选提交：…”各恰好 1 行；候选 638605c 是 HEAD 祖先；`git diff` 排除 `docs/gates`、`docs/audits`、`docs/reviews`、`handoff.md` 后为空，候选后候选文件未被改动。
- 门记录正文结论与 artifact 一致：签后 gate-check exit 0，body_hash 与正文重算一致；门正文必过项表、证据表、不变量表均通过 `verifyGateRecord`。
- 证据逐份 sha256：13/13 份按 CRLF→LF 归一重算一致；这不是只验自身字段，而是从文件字节重算。

## 主仓检查

- `tsc --noEmit`：exit 0。
- 全量 vitest：32 个 test suite（31 过 1 败）、340 例（329 过 11 败）。11 败全部是预签态 G1 的 `audit_report_sha256=0*64` 造成，首错均为“审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…”；没有其他失败。JSON 报告：D:/aboutAI/_g1audit-r20/vitest.json。
- 主仓直接 `gate-check.ts docs/gates/G1.md`：exit 1，首错同为上述 sha 不符；这是预签态允许的失败，不是本轮新发现。
- 除预签态 11 例外，没有 tsc、测试或门检查的其他失败。

## 复现命令

报告侧 E2E（17 例，含 1 阳性对照、12 个 r19 回归、4 个新绕过）：

```powershell
D:/NodeJs/node.exe --no-warnings D:/aboutAI/_g1audit-r20/run-e2e.mjs
# 结果：D:/aboutAI/_g1audit-r20/results.json
```

门正文侧 E2E（8 例，含 2 个 r19 回归、6 个新绕过）：

```powershell
D:/NodeJs/node.exe --no-warnings D:/aboutAI/_g1audit-r20/run-body.mjs
# 结果：D:/aboutAI/_g1audit-r20/body-results.json（8 例完整）
```

解析器探针（五行、主语/谓语同义写法、alt 不可见字符）：

```powershell
D:/NodeJs/node.exe --no-warnings D:/aboutAI/_g1audit-r20/probe-conclusion.mjs
D:/NodeJs/node.exe --no-warnings D:/aboutAI/_g1audit-r20/probe-body-quote.mjs
```

签后独立复核与主仓预签态复核：

```powershell
D:/NodeJs/node.exe --no-warnings D:/aboutAI/_g1audit-r20/verify-signed.mjs
D:/NodeJs/node.exe --no-warnings D:/aboutAI/_g1audit-r20/verify-evidence2.mjs
```

单例复现最小步骤（以五行拆词为例）：

```powershell
Set-Location D:/aboutAI/_g1audit-r20/clone
git reset --hard 638605c42d3ca4545fb1ad7e29b381a2a4cf6df9
git clean -fd
# 1) 把 G1 artifact 改为 audit_round=20、audit_report=docs/audits/S1-independent-audit-round20.md
# 2) 报告写入：
#    门：G1
#    候选提交：638605c42d3ca4545fb1ad7e29b381a2a4cf6df9
#
#    结论：pass
#
#    本
#    报
#    告不
#    通
#    过
# 3) 提交后：
D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G1.md
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md
# 期望：sign-gate exit 1、G1 字节不变；实际：exit 0，gate-check exit 0
```

## 判定

前轮四类精确载荷已 fail-closed，合法干净报告也能签过；但五行拆词、alt 不可见字符、德式/emoji 收尾、门正文长行/偏移仍能签过，说明修复是按载荷枚举而不是按性质收口。按本轮判据“测试通过但性质未覆盖 = fail”，本轮不予放行。
