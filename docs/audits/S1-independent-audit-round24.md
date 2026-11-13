# S1 / G1 独立审计（第二十四轮）

门：G1
候选提交：b92e8497d7a09685630465f6d24ccafa4ac812a8

- 审计时间：2026-11-14（Asia/Shanghai）。
- 审计对象：b92e849 的工作流编排门禁，不是 UI。
- 攻击环境：系统临时目录克隆 C:/Users/ASUS/AppData/Local/Temp/g1audit-r24，从 b92e849 检出；依赖目录是指向主仓 node_modules 的 junction。
- 只读边界：本审计未改主仓源码、tests、docs/gates/G1.md；G1 未重签；本报告未提交。
- 主仓状态说明：审计期间主工作树被外部推进到 4c4ee82，并出现未提交的 scripts/gate-check.ts、tests/gate-check.spec.ts 改动和未跟踪的 S2 第二十九轮报告；这些不在本报告范围。本报告只对 b92e849 的字节负责。

## 一、材料与基线

已读：AGENTS.md、docs/gates/G1.md、docs/superpowers/plans/2026-11-12-dsh-orchestra-s1-ledger.md、docs/audits/S1-independent-audit-round22.md、docs/audits/S1-round22-response.md、docs/audits/S2-round27-response.md、docs/audits/S2-round28-response.md，以及 docs/audits 下 S1 第二至二十二轮与 S2 第二十三至二十八轮记录。

docs/audits 下没有 S1 第二十三轮报告；S1 最新独立审计是 round22，S2-round28-response.md:49 写“S1 第二十三轮报告未回”。这是流程状态，不是源码缺陷。

G1 基线（clone，b92e849）：

````text
$ D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md
门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 50ba1b13cdf1b84d…
exit=1
````

G1 头部写 pass、13 项必过全 pass；但 artifact 的 audit_round=1、audit_report=docs/audits/S1-independent-audit.md、audit_report_sha256=64 个 0。也就是说，b92e849 的 G1 是预签态，不是一份被门检查背书的有效 pass。第二十二轮把同一状态记为 P2-2，本轮沿用该口径。

门检查自身的测试（clone，b92e849）：

````text
Test Files  1 failed (1)
Tests  11 failed | 70 passed (81)
````

11 例全部停在同一个审计报告 sha256 预签锚（期望 50ba1b13…，实际 000000…），不是 11 个独立解析缺陷。测试套件在候选提交上是红的，因此不能拿“测试通过”当 G1 的通过证据。

## 二、G1 必过项与源码逐项核对

| 检查面 | 结果 | 依据 |
| --- | --- | --- |
| 账本 append-only | 源码成立 | src/infra/sqlite/migrations/005_append_only_events.sql 建 trg_events_no_update / trg_events_no_delete，RAISE(ABORT)；src/infra/db/ledger.ts 的 appendEvent 只 INSERT；appendNodeRunEvent 计算 chainHash(secret, prev, body) 后 INSERT；tests/migrate.spec.ts:103-108、tests/hash-chain.spec.ts:34-71 覆盖改/删/错密钥 |
| 单写者 | 源码成立 | src/infra/lock.ts:6 acquireDbLock 用 proper-lockfile（dbFile+'.lock'，stale 10000，realpath false）；src/index.ts:116-121 顺序为 acquireDbLock → bumpEpoch → openServiceDb → createOrchestra；src/index.ts:47-48 无 ORCHESTRA_LOCK_PROOF 抛 FORBIDDEN；tests/db-open.spec.ts:79-86 覆盖第二把锁拿不到 |
| epoch | 源码成立 | src/infra/db/open.ts:7-19 bumpEpoch 递增 service_meta.instance_epoch；src/infra/sqlite/driver.ts:80-84 withTx 先 BEGIN IMMEDIATE，再比对 readEpoch(raw) 与 db.epoch，不等抛 STALE_GENERATION；tests/db-open.spec.ts:59-71 覆盖旧进程写失败、新进程写成功 |
| CAS | 源码成立 | src/infra/db/tx.ts:5-9 runCas 要求 res.changes === expected.rows，否则 STALE_GENERATION；tests/db-open.spec.ts:105-119 覆盖错 revision 回滚与正确 revision 生效 |
| 证据表 | 数据成立 | 13 个 ev-* 的 id/file 与 G1 固定映射一致；sign-gate 从 HEAD 读取并按 LF 归一重算 sha256；签后证据 13 份 |
| 候选哈希 | 机制成立 | candidateEntries 以 scopeBase 623939d4c0a7123835b525287035588ee291ccbe 为界，排除 docs/gates/G1.md、docs/gates/G2.md、docs/audits、docs/reviews、handoff.md；签后 115 个文件，candidate_hash=b746050b69853c5a1a9c322b7462cc90afe336c5b52e7cfeae17a1e9ebd0ac5f，change_scope_hash=83793fffc1fb10e1c1818eaf192171210853a5d7219965c8157727a0891744d4。候选提交后改源码会被 checkAuditAnchor 的 diff 拒绝（见负向对照）。 |
| 审计报告锚 | 机制成立 | scripts/gate-check.ts:1589-1675：报告必须在 docs/audits 下、轮次等于 audit_round、sha256 与 HEAD 字节一致、auditBindingOf 唯一绑定门与候选、候选是 HEAD 祖先、候选到 HEAD 的候选文件差为空 |
| 结论解析 | 不成立 | 见 P0：报告或门正文里的可见同义否定句可被签成 pass，sign-gate 与 gate-check 都是 exit 0 |

G1 记录里的 candidate_hash=bbd322cf…、change_scope_hash=ea15aba7… 是预签旧值，不等于 b92e849 签后重算的 b746050b… / 83793fff…；在本轮攻击里所有成功签出的门记录都使用后者。前者不能作为 b92e849 的候选哈希通过证据。

## 三、P0-1：可见同义否定句仍可签成 pass

根因在 b92e849 的 scripts/gate-check.ts：

- FAIL_PASS_STEMS（scripts/gate-check.ts:784-793）是 通过、批准、达标、合格、成功、过关、许可、认可、同意、否决、驳回、拒绝、approval、approved、approve、passing、passed、succeed、succeeded、success、accepted、accept、pass、meet、met、approving、granted、granting、acceptable、采纳、採納、认同、認同、赞同、贊同、首肯、受理、接收、接受、通過、達標、過關、許可、認可、否決、駁回、拒絕、獲批、获批。没有 放行，也没有 release、clear、fit、advance。
- matchStructuralNegative（scripts/gate-check.ts:827-846）只认“否定词 + 至多两个填充词 + FAIL_PASS_STEMS 谓词 + 可选宾语”。超过词表的谓词一律不成立。
- scanFailStatement（scripts/gate-check.ts:856-892）只有在主语之后命中 FAIL_VERDICTS，或命中上述结构化否定，并且后续字符是空、分隔符或“需应已的了”时才返回 true（:873、:878）。
- auditConclusionOf（scripts/gate-check.ts:931-1003）只把一行正式结论当裁决；全文预扫描（:967）与逐行扫描（:969）复用同一个词表。于是“结论：pass”加一句词表外的可见否定，仍返回 pass。
- bodyConclusionOf（scripts/gate-check.ts:979-1002）同样复用该词表；它只额外检查正式结论行和含“结论/結論/判定 + 冒号”的行，词表外否定照样漏。

以下每条都是完整端到端夹具：报告顶部有唯一的门 G1 与候选 b92e849 绑定行，正文有一行 结论：pass 和一条否定载荷；把报告提交进 clone 的 HEAD，把 G1 artifact 的 audit_round 改为 24、audit_report 改为 docs/audits/S1-independent-audit-round24.md，提交后运行 scripts/sign-gate.ts，成功则提交签后 G1 再运行 scripts/gate-check.ts。

### A-cn-release

````text
本报告不能放行。
````

````text
sign-gate exit=0
gate-check exit=0
artifact_hash=fdf7a79ae7d4ab94c513a2e4e51e0e37569154b467c84eb8fc3da9ba7e03e966
audit_report_sha256=a9d843da7969f1de0c2fd1afa7277ba3914135d4c6d9e39ed9de4fcf48e7d99f
signed commit=c7eacd598c71ab78182e44b1b2c71ed8cd833e63
````

### B-cn-condition

````text
本次审计未达到放行条件。
````

````text
sign-gate exit=0
gate-check exit=0
artifact_hash=a7c7bb37560ef5f7cb2342168a493bf6ac67d671075d275dae8a07862576a71e
audit_report_sha256=34dbc2646c456e240ea00b6c5a090148de7b2cb2fb3b9f722779dbbfb8965aa5
signed commit=d46c137cce2ad0aeff79381c1e5434ee1f1135e6
````

### C-en-clear

````text
This audit does not clear the gate.
````

````text
sign-gate exit=0
gate-check exit=0
artifact_hash=3dcbd286149a732923744aa19819dd81bbd5cf0315d38c6f24176254ef62dfee
audit_report_sha256=7ee0399b596cb4c49097c8519f488622f4087ea37539539b282aac9bb12f085c
signed commit=50a69f005cdd2f6eede3bb15f74dea441a71f4a1
````

### D-en-fit

````text
The gate is not fit to advance.
````

````text
sign-gate exit=0
gate-check exit=0
artifact_hash=0e23e7ae0932805e86fe3208da1304a307ea0f259355a5832b483efcd639ee1e
audit_report_sha256=f0b2e6e6fba82a382797638ba0f5d6aaccf4517baeacb3a9d867e8abcb6d3f88
signed commit=715d7c18f0fc5be0acc47cdb355de107a8372f07
````

### E-split

````text
本报告
不能
放行。
````

````text
sign-gate exit=0
gate-check exit=0
artifact_hash=14c78914c7d5092b5c17b875817edc93928a599bd77ef925e86dada4c047cacc
audit_report_sha256=23a6e2a627bafa40a20ed318ee15ebdf09b3c745ee2f3b7ff003fb061161938d
signed commit=33efdd67cbf38cbe176b94553a51ff8363c132d5
````

### F-hist

````text
上一轮审计未通过，本轮已整改。本报告不能放行。
````

````text
sign-gate exit=0
gate-check exit=0
artifact_hash=aa0c66e74908e615beed769399809a7a262af0ce525f4b3d46645e77c55e0247
audit_report_sha256=2bdd34e121767c82062b26f65c0857dd93b9c111c691cf66a98a633d7055d7be
signed commit=214598ccaec54efedd521e3d267a9099aee6eb1a
````

### G-cn-not-granted

````text
本次审计未获放行。
````

````text
sign-gate exit=0
gate-check exit=0
artifact_hash=103779c7067c679fbdf02b5bcc77d1b359a480c453046785fe3a20594e6b796c
audit_report_sha256=b3afb2f61c072b5f7e6c4ffac82c40cd0b0e5df16a39b42387d208615bcd4e06
signed commit=f56a932f35e9c5761588157de9f201a521cf4d5a
````

### H-en-release

````text
The gate cannot be released.
````

````text
sign-gate exit=0
gate-check exit=0
artifact_hash=105909b0ed3daa6875115ae50ec4f7157f45e03fcb08955f43dba4ed14f50147
audit_report_sha256=a94fc1cbe924fba84b74dae5d14fd6f2bc2486ad12a1fb5a78c5bf0145e707bf
signed commit=c0ae2323e5549ec8ed773df5776e479d2d72404c
````

这 8 条的共同性质：人读一遍就知道结论是否定，但词表里没有 放行/release/clear/fit/advance，所以扫描器不命中；唯一正式结论行仍是 pass。

## 四、P0-2：门正文注入同样可以保留 pass

把同样语义的句子插在 docs/gates/G1.md 的“## 证据索引（gates 用）”之前，再用干净报告签门。sign-gate 会重算 body_hash，gate-check 的 bodyConclusionOf 只看正式结论行、全文扫描和含“结论/判定 + 冒号”的行；词表外否定三者都漏。

### G-body-cn

````text
本门记录不能放行。
````

````text
sign-gate exit=0
gate-check exit=0
artifact_hash=eef4705180e605f1e7af315e4a2821d8d00c945d6dff3d37068f0bbf140f6a3c
body_hash=ec6d31113c3f7808b23c6fcb70cc2a39b2d8e5dac7a1eb9078be15f8ce6aa75a
audit_report_sha256=ad65226ddcd802bef4640ae967cd86fd29f2021576ab97daf1aa20e90cfe3833
signed commit=f180cb43be4c2c9b6bed0051aca2f0e8467dd0c3
````

### H-body-en

````text
The gate is not fit to advance.
````

````text
sign-gate exit=0
gate-check exit=0
artifact_hash=2a50ca5dca2c09468e2751bf9c1041a4a3df7de3ce643b61dc925be7982cfb0b
body_hash=9ac6586b797efb59cfe3ea1cfe433060d4bc9810933e002f88f3c734e4a96213
audit_report_sha256=0a8b2bf65b3ed4c97a581802fca17d27d54159914ad9ba3219abe54e865fb017
signed commit=7c9b5424a28c2e9b4a0f3a4c379fb6bcfe8cfe84
````

这两例的审计报告也带了同一句（测试夹具把载荷同时写进报告与门正文），报告侧同样漏过；所以 exit 0 不是“报告干净、只有正文脏”造成的，而是同一词表缺口在两条路径上都成立。

## 五、可见性边界与 P1/P2

### P1-1 围栏代码块里的可见 fail 结论

````text
```text
结论：fail
```
````

````text
sign-gate exit=0
gate-check exit=0
artifact_hash=2879a08c87b5938fceacae1da947cf7411236e3a223e181328b0fdde78832f71
audit_report_sha256=e2c6840549eb47f3b6e5af6e6199c1aeab24e1b43749d1fa173f974f2c5ac78a
signed commit=d54127ec3b6ef1af53d2ab59fddf4909e0683e84
````

renderedAuditLines 在 scripts/gate-check.ts:589-591 对 fence/code_block 直接 flush 后跳过，所以渲染后仍可见的代码块 fail 不参与判定。历史测试把“围栏代码块里的示例结论不参与判定”当既定口径；本轮按 P1 记录，不按新的 P0 记，因为它需要载荷被明确标成代码块。若要严格做到“人眼可见即算”，这一条仍需收口。

### P0-1 的链接包装变体

````text
[本报告不能放行](https://example.invalid/x)
````

````text
sign-gate exit=0
gate-check exit=0
artifact_hash=82ee539609e001c818dbf343f5ce3477db94e4449817dc558c8622db9fe93e6a
audit_report_sha256=75935e348e2f10acf67cef6709a08742015da1883d9df0616d93c2f4c208cf5b
signed commit=a43dcfb7ec3a07fb9c8cc772953184e702ed1ecd
````

链接文字会被 renderedAuditLines 追加到可见 buffer（link_open/link_close 只置 paragraphHasLink），所以这不是“链接把文字藏掉”，而是 P0-1 词表缺口在链接形态上的复现；段落没有“结论：”前缀，也不会触发 :552 的歧义分支。

### 负向对照：隐藏与原始 HTML

````html
<!-- 本报告不能放行 -->
````

````text
sign-gate exit=0
gate-check exit=0
artifact_hash=216653939a615660210a27d7c9e94c2b6901459ebbe0cf886d996f3f04470be3
audit_report_sha256=7d82f5298d94560189ba9f9f55ea8d3efe0108bcbf3305b7ddef7240de4b5608
signed commit=418be369aa38908fac01d04e88864a7bc8dcbdb4
````

HTML 注释按不可见处理，gate-check 不据此判 fail 是正确行为，不作为缺陷。

````html
<span>本报告不能放行</span>
````

````text
sign-gate exit=1
unchanged=true
error: 审计报告里找不到唯一结论行，不能拿它当门记录依据: docs/audits/S1-independent-audit-round24.md
at scripts/gate-check.ts:1611
````

原始 HTML 可见标签被 renderedAuditLines 在 :598-601 直接判 null；这是 fail-closed 的负向对照。

### P2-1 G1 仍是预签态，测试套件在候选上为红

已在第一节给出：gate-check exit=1（0000… != 50ba1b13…），tests 11 failed / 70 passed。原因是 G1 没签；这不是新的解析漏洞，但说明 b92e849 的门记录本身还不能作为 pass 证据。按第二十二轮 P2-2 的口径记为 P2。

### P2-2 S1 第二十三轮审计报告缺失

docs/audits 下只有 S1 round22；S2-round28-response.md:49 明说 S1 第二十三轮未回。G1 的审计链在 S1 侧停在 round22，而本轮是 round24。流程上应补齐或明确跳过理由；本轮不把缺失本身算成伪造 pass。

### P2-3 主工作树在审计期间被外部推进

审计开始时 HEAD 是 b92e849，结束时是 4c4ee82，且有未提交的 scripts/gate-check.ts / tests/gate-check.spec.ts 和未跟踪的 S2 round29 报告。本报告固定 b92e849；4c4ee82 的改动不在本轮结论内。报告写入主仓 docs/audits 后不提交。

## 六、负向对照：结论词表确实能挡住一部分写法

以下三例说明“找到 fail 词”时 sign-gate 会停在审计锚，而不是签成 pass；但三例的拒绝理由都是“报告里出现第二个结论行”，不是词表正确识别了语义，不能拿来证明 P0 已闭合。

````text
本次审计未通过。
````

````text
sign-gate exit=1
unchanged=true
error: 审计报告里找不到唯一结论行，不能拿它当门记录依据: docs/audits/S1-independent-audit-round24.md
at scripts/gate-check.ts:1611
````

````text
This audit did not pass.
````

````text
sign-gate exit=1
unchanged=true
same error at scripts/gate-check.ts:1611
````

````text
本门记录结论：fail。
````

````text
sign-gate exit=1
unchanged=true
same error at scripts/gate-check.ts:1611
````

第三例的夹具把载荷同时写进报告与门正文，报告侧先形成第二个结论行，所以没有走到 bodyConclusionOf；它不能证明门正文检查能识别这条句子。

### 候选与报告锚的负向对照

签后改源码再提交：

````text
exit=1
门检查失败：审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：src/index.ts
````

签后改审计报告再提交（docs/audits 被候选范围排除，但报告 sha 仍被钉住）：

````text
exit=1
门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：2bdd34e121767c82… != bb8ffcaf07262ff9…
````

这两条说明候选后改动与报告后改动都能 fail-closed；它们不覆盖结论词表。

## 七、结论

本报告判定 G1 / b92e849 不能 pass：8 条报告正文载荷和 2 条门正文载荷都在人读为否定的情况下签出 exit 0、gate-check exit 0；根因是 b92e849 的 FAIL_PASS_STEMS 缺 放行/release/clear/fit/advance，而扫描器只认“否定词 + 词表谓词”。这属于可伪造 pass 的 P0。另有 1 条围栏代码块可见 fail（P1）、G1 预签态与测试套件红（P2）、S1 round23 缺失（P2）。

结论：fail

建议：在词表或结构化语义层补上“放行/release/clear/fit/advance”这一谓词族，并为本报告 A-H 与两例门正文载荷补回归；补齐前不重签 G1。
