# S1/G1 第十三轮独立审计报告

门：G1
候选提交：14383fa3e5484a28fe922e3a315bd911e150651f

结论：fail

## 结论摘要

P0=0，P1=1，P2=0。候选提交堵住了第十二轮点名的 B1-B6 六种引用定义隐藏，阳性对照也通过；但引用标签本身允许跨行这一点没有覆盖，构造跨行标签的引用定义仍可把隐藏的 pass 送进结论解析。端到端实测 sign-gate exit 0、提交签后门记录后 gate-check exit 0，属可复现 fail-open，故判 fail。

## 审计对象与只读约束

- 审计对象：D:/aboutAI/dsh-orchestra，候选提交 14383fa3e5484a28fe922e3a315bd911e150651f，父提交 0297b77。
- 源码、测试与文档逐项核对；端到端攻击在临时 clone D:/aboutAI/dsh-orchestra-audit-r13-tmp 内进行，基线同为 14383fa。
- 主仓库除本报告外未写入、未提交；未在主仓库运行 sign-gate。
- 环境：Windows，D:/NodeJs/node.exe（v26.13.1），git 2.47.1，临时 clone 的 node_modules 以 junction 复用主仓库依赖。

## P1-1：跨行引用标签绕过掩码（fail-open）

### 攻击构造

- 报告可见正文只写一行“本报告可见正文的结论为不通过。”。
- 空行后放入一个 CommonMark 引用定义：标签在物理行上拆成两行，目标在后续行，title 用双引号跨多行，被隐藏的结论声明放在 title 内。
- 精确正文（`\n` 表示实际换行）：`本报告可见正文的结论为不通过。\n\n[x\ny]: https://example.com\n"title\n结论：pass\n"`。
- 该正文被渲染器当成一个引用定义消费，页面只出现“不通过”那段；markdown-it-py 4.0.0 按 CommonMark 渲染后 HAS_PASS_IN_HTML 为 false，隐藏的 pass 文本不在 HTML 里。

### 根因

- `scripts/gate-check.ts:699` 的 `maskAuditLinkDestinations` 先按换行切成物理行；`scripts/gate-check.ts:722` 只用 `/^\[((?:[^\]\n\\]|\\.)+)\]:/` 逐行匹配“标签加冒号”。
- 跨行标签的首行只有 `[x`，次行只有 `y]: …`，两行都不匹配，因此 `scripts/gate-check.ts:725-730` 的整段掩码不会启动。
- pass 行原样进入 `auditTopLevelLines`，`scripts/gate-check.ts:533-553` 的 `auditConclusionOf` 返回 pass。CommonMark 允许标签内换行，所以渲染器隐藏而门解析器可见。
- 新增用例 `tests/gate-check.spec.ts:378-403` 只覆盖单行标签的 B1、B2、B6、引用块、列表项与转义右括号，没有一条把标签本身拆到两行，因此测试全绿但绕过仍在。

### 端到端复现

1. 在 clone 内把 `docs/audits/S1-independent-audit-round12.md` 覆盖为上面的攻击正文，把 `docs/gates/G1.md` 的 artifact 元数据改成 `audit_round=12`、`audit_report=docs/audits/S1-independent-audit-round12.md`，提交。
2. 运行 `node --no-warnings scripts/sign-gate.ts docs/gates/G1.md`：exit 0，输出“重签完成：证据 13 份，candidate=6b737e96e184…，artifact_hash=efbda339578e…，body_hash=6e548c8d90b9…，改动文件 115 个”。
3. 提交签后的 G1（clone 内提交 34401f523509896c00a23430d331a53580dba101）。
4. 运行 `node --no-warnings scripts/gate-check.ts docs/gates/G1.md`：exit 0，输出“gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=efbda339578e… body_hash=6e548c8d90b9…）”。

攻击报告的可视结论是不通过，门记录却以 pass 签过并复检通过。这与第十二轮 B1-B6 同类，只是入口换成跨行标签。

### B1-B6 回归复测

| 用例 | 构造 | sign-gate | 结果 |
| --- | --- | --- | --- |
| B1 | 同行目标加多行引号 title | exit 1 | 报找不到唯一结论行，G1 字节不变 |
| B2 | 目标换行加多行引号 title | exit 1 | 同上 |
| B3 | 引用块内定义加多行 title | exit 1 | 同上 |
| B4 | 列表项内定义加多行 title | exit 1 | 同上 |
| B5 | 标签内转义右方括号加多行 title | exit 1 | 同上 |
| B6 | 左括号多行 title | exit 1 | 同上 |

六例的 sign-gate stderr 首条业务错误均为“审计报告里找不到唯一结论行，不能拿它当门记录依据”，抛错位置为 `scripts/gate-check.ts:937`；签名前后 G1 文件 sha256 与 HEAD 中的 G1 完全一致。

### 阳性对照

- 报告写 `[x]: https://example.com`，空行后写一行 `结论：pass`；sign-gate exit 0，提交签后门记录（clone 内提交 d46204dc2acdee1d31688480f96417a5c07844f4），gate-check exit 0。
- 说明 `scripts/gate-check.ts:727` 的空行边界生效，空行后的可见结论没有被吞掉。

### 既有关键攻击复跑

| 攻击 | sign-gate | gate-check | 结果 |
| --- | --- | --- | --- |
| 原始 HTML 四类（details、summary、div hidden、span style） | exit 1 | 未跑 | 报找不到唯一结论行，G1 字节不变 |
| 门名绑错 | exit 1 | 未跑 | 报“报告=G2，记录=G1” |
| 假候选 | exit 1 | 未跑 | 报“候选提交不是 HEAD 的祖先或不存在” |
| 不变量固定语句篡改 | exit 1 | 未跑 | 报“不变量 I3 的语句与固定口径不一致”，未写回 G1 |
| 签后改证据再签 | exit 1 | exit 1 | 报“候选提交之后，候选文件又被改过” |
| 工作树脏证据 | 未签 | exit 1 | 报“工作树有未提交改动，门记录不能对着脏树签” |

对应源码位置：结论错误 `scripts/gate-check.ts:937`，门名绑定 `scripts/gate-check.ts:947`，证据范围 `scripts/gate-check.ts:960`，不变量固定口径 `scripts/gate-check.ts:327`。所有失败用例签名前后 G1 字节不变。

## 静态检查与测试

- `git diff 0297b77..14383fa -- scripts/gate-check.ts tests/gate-check.spec.ts`：只把旧的逐行掩码改成 stripContainers 加整段掩码，标签正则加入转义右括号支持；测试只新增两组用例，没有删除断言，没有放宽证据表、不变量、候选范围与门名绑定。
- `D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit`：exit 0。
- 全量 vitest：Test Files 1 failed、31 passed（32）；Tests 11 failed、301 passed（312）。11 条全部在“门记录校验”组，Received 统一为“审计报告 sha256 与记录不符（报告改过就重新审计再签）：000000… != 50ba1b13…”，根因是候选提交的门记录仍为预签态，`audit_report_sha256` 是 64 个 0；这 11 条不是本次改动引入的回归，逐条为：G1 门记录通过；改 candidate_hash 但锚点不动时报哈希不符；证据文件的哈希对不上时指名哪一份；evidence_index_hash 被改时指名证据索引不符；candidate_hash 改成别处的值时指名与候选文件不符；正文必过项的内容列被改时指名不一致；正文证据表的哈希被改时拒绝；正文不变量说明被改时拒绝；不变量语句被削短后即使重算哈希也拒绝；证据文件与固定文件映射不一致时拒绝；正文自锚 body_hash 被改时拒绝。
- 只跑引用定义相关用例：3 passed、46 skipped，新增的 B1、B2、B6、引用块、列表项与转义右括号用例通过；跨行标签仍无用例。

## 缺陷计数

- P0=0。
- P1=1：跨行引用标签绕过，证据见 P1-1。
- P2=0。

## 最终判定

本轮判 fail。候选提交没有完成第十二轮 P1-1 的收口，门仍可被隐藏 pass 签过，不能进入下一阶段。
