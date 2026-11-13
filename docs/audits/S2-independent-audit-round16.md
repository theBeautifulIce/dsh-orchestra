# S2 门 G2 第十六轮独立审计报告

门：G2

候选提交：14383fa3e5484a28fe922e3a315bd911e150651f

结论：fail

计数：P0 1 条、P1 1 条、P2 1 条。

## P0-1 行内链接 title、图片 alt 与多行 label 引用定义仍可把可见结论为不通过的报告签成 pass

位置：`scripts/gate-check.ts:699-734`（`maskAuditLinkDestinations`）、`scripts/gate-check.ts:533-553`（`auditConclusionOf`）、`scripts/gate-check.ts:841-854`（`stripHiddenAuditBlocks`）。

机理：

- `scripts/gate-check.ts:701` 只把 `](` 到当前行尾的内容抹掉。链接 title 跨到下一行时，下一行的 `结论：pass` 不在被抹范围内，`auditConclusionOf` 仍把它当顶层结论行。
- `scripts/gate-check.ts:722` 的引用定义正则要求 label 在同一行内闭合。CommonMark 允许 label 跨行，`[a` 换行 `b]:` 不会被识别成定义，整段掩码不触发，后面的 `结论：pass` 留在顶层。
- 图片 alt 完全没进掩码。`auditConclusionOf` 只看行首文本，不读渲染树；结论字符串落在 alt 属性里也算唯一结论。
- CommonMark 渲染后，三种写法的结论都只出现在链接 title 属性、图片 alt 属性、或被消费的引用定义里，正文可见内容只有「本报告结论为不通过。」（markdown-it-py 4.0.0 实测）。

复现（临时 clone，基线 `14383fa`；逐例重置工作区，把攻击报告写到 `docs/audits/S2-independent-audit-round15.md`，把 G2 artifact 的 `audit_round` 改成 15、`audit_report` 指向它、`conclusion` 写 `pass`，提交后签门）：

1. 行内链接多行 title：报告尾部写 `[a](https://example.com "title\n结论：pass\n")`。`sign-gate` exit 0（`artifact_hash=734d641357f3…`），生成提交 `f4a18901588e57c1cba61bd6b62cf4bc5da2d6bf`，G2 被重写为 blob `485505d71a335f44a5af369bd97407f8ab733d14`；随后 `gate-check` exit 0（19 项必过、19 份证据）。
2. 多行 label 引用定义：`[a\nb]: /url "t\n结论：pass\n"`。`sign-gate` exit 0（`artifact_hash=a3406254b5ba…`），生成提交 `edaaa05791830992d666179825f60097db803426`，G2 blob `d585ea42ea33b1fc6553ed13166ddae56021dd04`；`gate-check` exit 0。
3. 图片多行 alt：`![alt\n结论：pass\n](https://example.com/i.png)`。`sign-gate` exit 0（`artifact_hash=d77cc3fc130a…`），生成提交 `566e20e2d099c4b884225767f6871d5ea702561c`，G2 blob `d4b52edcc16160053913810b9da59813a09c9c79`；`gate-check` exit 0。

复现命令：

- `D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G2.md`
- `D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md`

影响：报告正文（渲染后）明确写不通过，门记录 `conclusion` 是 pass，`audit_report_sha256` 绑定这份报告，`sign-gate` 与 `gate-check` 都返回 0。与第五轮 P0-1「拿结论为 fail 的报告签 pass」同类。第十五轮修的是引用定义整段与容器前缀，没有按渲染可见文本判定，行内链接 title 与图片 alt 这条面还开着。

## P1-1 回归用例只覆盖引用定义的单行形态，跨行 title 与 alt 没有进测试

位置：`tests/gate-check.spec.ts:378`、`tests/gate-check.spec.ts:396`、`scripts/gate-check.ts:722`。

- 新用例只断言 `[x]:`、`> [x]:`、`- [x]:`、`[a\]]:` 等引用定义形态，以及引用定义里的多行 title；没有断言行内链接的多行 title、图片跨行 alt、跨行 label 的定义。
- 所以 B1-B6 全绿仍漏掉同一渲染面。建议按 CommonMark 渲染树只取可见文本（排除属性与被消费的定义），或显式拒绝跨行 title、跨行 alt、跨行 label；两条路都要补对应的攻击用例。

## P2-1 注释声称 fail-closed，与实现的局部掩码范围不符

位置：`scripts/gate-check.ts:700`、`scripts/gate-check.ts:724`。

- 注释写「整行剩余部分一起隐藏（fail-closed）」「宁可多藏」，实现却只隐藏到当前行尾，跨行 title 与 alt 没有隐藏；引用定义块掩码也只在单行 label 正则命中后启动。
- 口径与实现不一致会让下一轮审计误判覆盖面。建议把注释改成精确范围，或补上跨行结构的处理。

## 已通过的验证

### 引用定义六形态与转义/容器前缀

- B1 目标在定义行、title 跨行；B2 label 单行、目标与多行 title 在续行；B3 引用块内定义；B4 列表项内定义；B5 转义右方括号 label 加续行目标；B6 括号 title 续行。
- A1 `[a\]]:`；A2 `> [x]:`；A3 `> [a\]]:`；A4 `[a\]b\]]:`。
- 以上十例 `sign-gate` 全部 exit 1，报错 `审计报告里找不到唯一结论行，不能拿它当门记录依据`；G2 blob 始终停在被改 artifact 后的 `c7a6f4933701d953b46c196618fb909e72612860`，没有发生重写。

### 隐藏、绑定与候选范围

- 带内联样式的 div 标签报告、围栏代码块里的 `结论：pass`、HTML 注释包裹的 `结论：pass`：全部 exit 1，报错同上，G2 不变。
- 报告写 `门：G1`、记录是 G2：exit 1，报错 `审计报告绑定的门与门记录不符：报告=G1，记录=G2`。
- 假候选 40 位 a：exit 1，报错 `审计报告的候选提交不是 HEAD 的祖先或不存在: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`。
- 先签门成功，再往 `docs/gates/evidence/G2/ev-g2-08.md` 追加内容并提交，重签 exit 1：`审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：docs/gates/evidence/G2/ev-g2-08.md`；`gate-check` 同样 exit 1；签好的 G2 blob 保持 `c80503296afe8f2c5fdd48d44a5c230abc494140`。证据已进入候选范围，这条成立。

### 阳性对照

- 纯 Markdown pass 报告，绑定 `14383fa`：`sign-gate` exit 0，输出 `重签完成：证据 19 份，candidate=d1c65b3fcea8…，artifact_hash=18dcf2287512…，body_hash=bcf1c585ebd6…，改动文件 86 个`；提交签后 G2 再跑 `gate-check` exit 0，输出 `gate G2 通过（19 项必过、19 份证据哈希复核）`。

### G2 记录结构

- artifact 的 19 项必过项、19 份证据与正文两张表，在签后由 `gate-check` 全量校验通过；19 份证据按 HEAD 字节、LF 归一的 sha256 与正文证据表、`evidence_index` 全部一致。
- 预签态：主仓 G2 的 `audit_report_sha256=0` 共 64 位，四个聚合哈希仍是旧值，直接跑 `gate-check` 在 `scripts/gate-check.ts:933` 报 `审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != c9cef2e419c91711…`。这是任务说明的预签状态，签门时由 `sign-gate` 重算；不作为本轮缺陷。
- 证据索引重算为 `106e1c362e7d4312e647580a99b3cfc01eb604546af9fd42167af4bbce6b8fd0`；预签 artifact 里仍是 `bcaaaa3e85d1dea69d323c9a03040f0bc7586445d5d833169b3768ac487b6347`，签后 `gate-check` 复核通过。

### 可复现证据

| 证据 | 重跑命令的 case 参数 | 重跑后 sha256（LF 归一） | 与记录 |
| --- | --- | --- | --- |
| ev-g2-08 | ev-g2-08 | 54e4b0e8415abd5bc65ce885c407245d91ec099390e64a2b3188c89cb1144cbf | 一致 |
| ev-g2-12 | ev-g2-12 | 5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe | 一致 |
| ev-g2-13 | ev-g2-13 | a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc | 一致 |
| ev-g2-14 | ev-g2-14 | 865fd0b7bca1193256dedee74f30a18c8903f5e0fa4c2d119cad6e41b50ada02 | 一致 |
| ev-g2-15 | ev-g2-15 | db1c814f8935e1779440aec12c5a229a6ec8636a0e6ccc7f86d2ac834e037038 | 一致 |

- 命令：`D:/NodeJs/node.exe --no-warnings scripts/fault-inject.ts --case ev-g2-08`（其余四例换编号），在临时 clone 里逐例重置后执行，全部 exit 0；生成文件与正文表登记值逐字节一致（按 LF 归一）。

### 类型检查与全量用例

- `D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit`：exit 0。
- 全量 vitest：32 个文件、312 例，301 通过、11 失败。11 例全部在 `tests/gate-check.spec.ts`，根错误都是 G1 预签态 `audit_report_sha256=0` 与 `50ba1b13cdf1b84d…` 不符（`scripts/gate-check.ts:933`）。`docs/gates/G1.md` 在 `0788dfb..14383fa` 没有改动，因此这是预签态环境失败，不是本提交新增回归。
- 新增用例定向跑：`-t "引用定义"` 3 例通过，`-t "HTML"` 2 例通过；第十六轮新增的引用定义与 HTML 拒绝用例都通过。

### diff 审视

- `git diff --stat 0788dfb..14383fa` 只动四份文件：两份历史审计报告正文、`scripts/gate-check.ts`（+46/−20）、`tests/gate-check.spec.ts`（+27）。
- `scripts/gate-check.ts` 的改动只在 `maskAuditLinkDestinations`；`checkEvidence`、`checkInvariants`、`checkBodyEvidenceTable`、`checkCandidate`、`checkAuditAnchor` 没有被放宽，证据清单、候选排除范围没有缩小，没有跳过证据。
- 综合判断：没有为了让本轮通过而放宽既有校验、跳过证据或缩小候选范围；但新掩码本身不完整，见 P0-1 与 P1-1。

## 审计环境

- 主仓 HEAD `14383fa3e5484a28fe922e3a315bd911e150651f`，除本报告外工作树在审计前后干净；攻击与阳性对照都在临时 clone（同基线）里完成，主仓源码与门记录未改。
- 本报告用门自身的 `auditConclusionOf` 与 `auditBindingOf` 复核：结论唯一为 fail，门绑定唯一为 G2，候选提交唯一为 `14383fa3e5484a28fe922e3a315bd911e150651f`。
- 临时 clone 与探针目录在审计结束后删除；攻击提交只存在于临时 clone，不进入主仓历史。
