# S2 独立审计报告（第三十一轮）

审计对象：`D:/aboutAI/dsh-orchestra`
候选提交：`e7172935d1f93ba7ec1cb7d2a48e9b2b1428bbca`
审计门：G2
审计方式：独立只读；主仓源码、门记录、证据未改；全部重签与攻击在临时克隆内完成
审计时间：2026-11-14

## 0. 主仓状态（只读）

主仓 HEAD 为候选提交 `e7172935d1f93ba7ec1cb7d2a48e9b2b1428bbca`。工作树在审计开始时即非干净，以下 S1 改动不是本审计所为，本审计未清理：

```text
 M scripts/gate-check.ts
 M tests/gate-check.spec.ts
?? docs/audits/S1-independent-audit-round25.md
?? docs/audits/S1-independent-audit-round26.md
?? docs/audits/S1-round25-response.md
```

其中 `scripts/gate-check.ts` 的 `M` 与候选提交 `e717293` 无关，属于别的 S1 轮次在途改动；`S1-independent-audit-round26.md` 是审计过程中并行出现的 S1 文件，本审计未创建、未清理。本审计只使用主仓已提交对象克隆，未使用脏工作树。

本报告自身以 `?? docs/audits/S2-independent-audit-round31.md` 出现在状态里，这是任务要求的交付物，未提交；除它之外没有本审计造成的主仓改动。

## 1. 夹具内容与克隆内重签

### 1.1 自写审计夹具

在克隆内新建两份夹具报告，正文除门号外完全相同：

```text
# S1 基线审计报告（round31）

门：G1
候选提交：e7172935d1f93ba7ec1cb7d2a48e9b2b1428bbca

本报告是克隆内重签门记录用的审计夹具。核对范围：单 agent 节点闭环、执行器、租约、工具授权与证据门。必过项逐条对应本表证据，证据哈希按 HEAD 字节复核，门记录与候选绑定一致。

结论：pass
```

S2 夹具把标题与门号换成 `# S2 基线审计报告（round31）` 与 `门：G2`，其余相同。夹具只用于让门记录绑定候选提交，不冒充真实审计结论；本轮真实审计结论在本文末尾。

另用一次性 `fixture.mjs` 只改两份 GateArtifact 的两个字段：

- G1：`audit_round` 1 → 31；`audit_report` `S1-independent-audit.md` → `S1-baseline-round31.md`
- G2：`audit_round` 4 → 31；`audit_report` `S2-independent-audit-round4.md` → `S2-baseline-round31.md`
- 两份 `audit_report_sha256` 先留零值，由 `sign-gate` 按 HEAD 报告字节重算

夹具提交为 `2f7d869`，随后签 G1（`9573671`）、签 G2（`d502b90`）。G2 基线值为：

```text
artifact_hash=4f0d3ce085ae71bf8701bf66da92980791f6a5a978cf13118a12750b0fccc885
body_hash=ce96c18015645beb678e2c8d2938c6ed962053f0825bb5824efb62edb746ec05
docs/gates/G2.md LF sha256=6c80ac7c270e25f462e7802a39efdb3f5cb8891378ee345caff474ec3376f6bb
```

两条基线 `gate-check` 均为 exit 0；G2 为 19 项必过、88 个改动文件，G1 为 13 份证据、115 个改动文件。

### 1.2 可复现命令

```powershell
git clone D:/aboutAI/dsh-orchestra D:/aboutAI/audit-r31
git -C D:/aboutAI/audit-r31 checkout e7172935d1f93ba7ec1cb7d2a48e9b2b1428bbca

# 放入夹具并执行一次性字段修改后
git -C D:/aboutAI/audit-r31 add -A
git -C D:/aboutAI/audit-r31 -c user.name=audit -c user.email=audit@local commit -m "fixture round31"

node --experimental-strip-types scripts/sign-gate.ts docs/gates/G1.md
git add -A; git -c user.name=audit -c user.email=audit@local commit -m "sign G1"
node --experimental-strip-types scripts/sign-gate.ts docs/gates/G2.md
git add -A; git -c user.name=audit -c user.email=audit@local commit -m "sign G2"

node --experimental-strip-types scripts/gate-check.ts docs/gates/G1.md; $LASTEXITCODE
node --experimental-strip-types scripts/gate-check.ts docs/gates/G2.md; $LASTEXITCODE
```

以上命令在克隆根目录执行；`sign-gate` 与 `gate-check` 对候选版本直接以 `node --experimental-strip-types` 运行，不需要编译。

## 2. 攻击协议与复现入口

每个载荷都走同一条闭环，不采信代码自述：

1. `git reset --hard d502b90` 回到基线；
2. 写入载荷并提交；
3. 记录攻击前 `docs/gates/G2.md` 的 LF 归一 sha256；
4. 执行 `sign-gate`，记录退出码与攻击后门文件字节；
5. 若 `sign-gate` 退出 0，提交签名后的门文件；
6. 执行 `gate-check`，记录退出码；
7. 从门文件提取 `artifact_hash` / `body_hash`，并独立重算：GateArtifact 按 `canonicalJson` 重算，正文按 `gate-check.ts` 的 `bodyHashInput` 规则重算（CRLF→LF；`artifact_hash=` / `body_hash=` 常量替换；反引号 64 位十六进制替换为 `<SELF>`）。

复现脚本与结果文件：

```text
D:/aboutAI/audit-r31-harness.mjs   → D:/aboutAI/audit-r31-results.json   （报告 20 例 + 门正文 5 例）
D:/aboutAI/audit-r31b-harness.mjs  → D:/aboutAI/audit-r31b-results.json  （定义续行 6 例）
D:/aboutAI/audit-r31c-harness.mjs  → D:/aboutAI/audit-r31c-results.json  （干净尾巴与定义 7 例）
D:/aboutAI/probe-r31.mjs           （auditConclusionOf / bodyConclusionOf 直接探针，21 条新变体）
D:/aboutAI/probe-r31-strict.mjs    （隔离单结论的 strict 尾巴探针）
D:/aboutAI/probe-required-hashes.mjs（required_hashes 生产路径探针）
```

核心循环如下，可逐例重放：

```powershell
git -C $clone reset --hard d502b90
# 写入本节围栏中的载荷
git -C $clone add -A; git -C $clone commit -m "payload <name>"
$before = node -e "const fs=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync('docs/gates/G2.md','utf8').replace(/\r\n/g,'\n')).digest('hex'))"
node --experimental-strip-types scripts/sign-gate.ts docs/gates/G2.md; $sign=$LASTEXITCODE
$after = node -e "const fs=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync('docs/gates/G2.md','utf8').replace(/\r\n/g,'\n')).digest('hex'))"
if ($sign -eq 0) {
  git -C $clone add -A; git -C $clone commit -m "sign <name>"
  node --experimental-strip-types scripts/gate-check.ts docs/gates/G2.md; $check=$LASTEXITCODE
}
```

下文表中 `sign` / `check` 两列为退出码，`门文件` 列为攻击前后 LF sha256 的前 12 位，`artifact` / `body` 为独立重算后的完整值。凡 `sign=0, check=0` 且门文件字节改变者，均为可签可过的绕过。

## 3. P0 清单

### P0-1 “通过，但准入条件尚未满足”这类尾巴仍可签可过（报告与门正文两个入口）

报告侧载荷（放在基线 `结论：pass` 之前）：

```text
本次审计结论：通过，但准入条件尚未满足。

结论：pass
```

门正文侧载荷（替换 G2 正式结论行中的“失败项为空”）：

```text
- 结论：**pass**（19 项必过全过，失败项为空，准入条件尚未满足，无 run）
```

实测：

| 用例 | 入口 | sign | check | 门文件 | artifact | body |
|---|---|---:|---:|---|---|---|
| r-new-1 | 报告 | 0 | 0 | 6c80ac7c270e→fbdf22671561 | 757af59ed13c272604a6e1df0351316814360db84ded98b799e4869702f59889 | ea904c202d1c5dba4bc6567bfee4c4ac697f519649836e35cf13dec03eb1cfa3 |
| r-clean-pass-but-unmet | 报告 | 0 | 0 | 6c80ac7c270e→5f3be0710c1a | 6390f4d652d0dfbb6ac43a126470bf611b03e8c50ce8324a0d1a7f13ee3636a3 | a46bde936df18324d3fd1b693e1ed223c045f78031b8f5cf845ccd4b67b51e5b |
| b-new-1 | 门正文 | 0 | 0 | 9400b3a6d185→c48dfa277440 | 4f0d3ce085ae71bf8701bf66da92980791f6a5a978cf13118a12750b0fccc885 | a2c5f74d3fe0fa9ba117bd958e38eff2c0028d37c1cae026c57e728d3140cc8e |
| b-clean-pass-but-unmet | 门正文 | 0 | 0 | 109f967c6a90→225c85783c26 | 4f0d3ce085ae71bf8701bf66da92980791f6a5a978cf13118a12750b0fccc885 | 9dd2339e701737bb69abf7daa82e3288a2865f7073792baa1eec168fba3c55f3 |

同族直接探针（`auditConclusionOf` / `bodyConclusionOf` 均返回 `pass`，尚未逐条签门）还包括：

```text
本次审计结论：通过（准入条件尚未满足）。
本次审计结论：通过。准入条件尚未满足。
本次审计结论：通过，但准入未经核验。
本次审计结论：通过，但准入条件仍未达成。
本次审计结论：通过，然而准入条件不满足。
本次审计结论：通过，但尚未达到准入条件。
本次审计结论：通过，准入条件待补。
本次审计认定通过，但准入条件尚未满足。
```

隔离探针显示 strict 形式 `结论：pass（准入条件尚未满足）` 会被 `validConclusionTail` / `onlyCleanCounts` 拒（`auditConclusionOf` 返回 null）；`sign-gate` 对该形式报“审计报告里找不到唯一结论行”，门字节不变。缺口在非 strict 行与门正文：

- `scripts/gate-check.ts:904` `scanFailStatement` 先找 `FAIL_SUBJECTS` 的主语，再吃连接词。`本次审计结论：通过` 中的 “本次审计” 后面接 “结论”，不在连接词表里，扫描停止；`准入条件` 不是主语，`尚未满足` 也不在 `FAIL_VERDICTS` 里。
- `scripts/gate-check.ts:1083` `bodyConclusionOf` 只要正式行以 pass 开头就接受；`:1087` 的 fail 词表不含 `尚未满足` / `未经核验` / `待补`；`:1094` 只扫裸结论词，`:1096` 只对结论行做 `lineFailure`。
- `validConclusionTail`（`:1647`）只接在 `auditConclusionOf` 的 strict 行路径上，门正文没有同等校验。

### P0-2 句内语气副词与框式结构绕过连接词表

```text
本次审计从原则上讲不推荐通过本报告。
本次审计整体而言不推荐通过本报告。
本次审计既不予采信，也不予推荐。
```

| 用例 | sign | check | 门文件 | artifact | body |
|---|---:|---:|---|---|---|
| r-new-4 从原则上讲 | 0 | 0 | 6c80ac7c270e→4b4fa46031db | fd187f0c57e359cac9ea6741a47ace5af5bfce6da8d2498347c775b6f4af0ac5 | 1a034c052a02c8a784ad45f2af85595fa7e27d90b6c6e99ebe25da6d90619503 |
| r-new-5 整体而言 | 0 | 0 | 6c80ac7c270e→a8131192927c | 22e7103ce1449cfb3d51a0288a4267f988e2a03e9e01f1438c4dccd45100f25f | c5fea650511ff28a0e018c816691588a5a8ab05c82c4768a5190d53fb0d8a8c6 |
| r-new-6 既…也不 | 0 | 0 | 6c80ac7c270e→766030c10b16 | 828249865cfff33e47ce6ed6a6cfc6eecfcad9bcf408bcdcf1b33cef66f68417 | 7c970136be4deccc2f3fd743e84c31c09650c47ebe57244d4a8861a88ae4933c |

同族直接探针 `本次审计不仅未通过验收，而且未完成整改。` 也返回 `audit=pass`。根因：

- `scripts/gate-check.ts:715-734` 的 `FAIL_CONNECTORS` 是穷举表，只收连续连接词。`从原则上讲` 被 `从` 截断；`整体而言` 与表里的 `整体上` 不同；`既…也不`、`不仅…而且` 被逗号/句法隔开，表内没有 `既` / `也不` / `不仅` / `而且`。
- `scanFailStatement` 在主语后只吃当前位置的连接词，遇到未知虚词即停止，没有“跳过语气副词后再找谓词”的路径。

### P0-3 整改完成度的程度否定绕过

```text
整改工作未完全完成。
整改工作还没有完成。
```

| 用例 | sign | check | 门文件 | artifact | body |
|---|---:|---:|---|---|---|
| r-new-7 未完全完成 | 0 | 0 | 6c80ac7c270e→44badc024626 | cbe294e5cd717726b843a0eedb54dec4fea070f8951a0de7959503d3c86783d1 | 3cb4911d8addad06e23b1d50f63833dbaf0e85a4d142a2fb64a8c9919b4242a9 |
| r-new-8 还没有完成 | 0 | 0 | 6c80ac7c270e→209b455d7e65 | e5ec58a3ebaca24c7281d122f6becfd95b08f2f1ad2b84ce55f80198788dc44a | fda389ee892cc127c1b966da4977de1da34ebae1d36a188a7cfe38c4dc12e0a5 |

同族直接探针还显示以下形式 `audit=pass`：

```text
整改工作未全部完成。
整改工作没有彻底完成。
整改工作尚未真正完成。
整改工作仍不到位。
```

根因：`scripts/gate-check.ts:798-812` 的 `FAIL_FILLERS` 不含 `完全` / `全部` / `彻底` / `真正` / `还` / `仍`；`FAIL_NEGATIONS` 有 `还没` 但没有 `还没有`。`matchStructuralNegative`（`:871`）在否定词后先试谓词，再逐层吃填充词；遇到 `完全` 这类未登记副词即失败，后面的 `完成` 永远到不了。

### P0-4 `hiddenDefinitionFailure` 只覆盖同行引用定义，续行/块引用/实体仍藏 fail

报告侧载荷：

```text
[1]: /url
"本次审计结论：fail"
```

```text
[1]:
/url
"本次审计结论：fail"
```

```text
> [1]: /url
> "本次审计结论：fail"
```

```text
[1]: /url "本次审计结论：&#102;ail"
```

门正文侧载荷（追加到 G2 末尾）：

```text
[1]:
"结论：fail"
```

实测：

| 用例 | 入口 | sign | check | 门文件 | artifact | body |
|---|---|---:|---:|---|---|---|
| r-def-1 dest 行 + title 行 | 报告 | 0 | 0 | 6c80ac7c270e→8669a4837648 | 8050dc07e9c7087d3d66d82b296cfc813e736cd0cbe1b15119aca9a8e24c88bd | 39b95c74ed3ee57938f47befe29eabbd7ecfae1649f5d61aa1ab1761907e7195 |
| r-def-2 label 行 + dest + title | 报告 | 0 | 0 | 6c80ac7c270e→52d9e7adfcb1 | f39fb9ea324e6435ebc24371ce977344049a81a2fc01adfeef30fb8350c3faf6 | fac3620a73a7f929b325be7f84f6762677a4d01eb15edaa8fd867218c63f4522 |
| r-def-3 块引用续行 | 报告 | 0 | 0 | 6c80ac7c270e→f78d0e5360c9 | fb6d0d8cedc85c13f804e4ebe2c5630613ada7a1f055eba5a5fce100fe162ccc | 3c279032fe831123b867f44d6880187b507954d4337d7faca773e13a18b22900 |
| r-def-4 实体编码 title | 报告 | 0 | 0 | 6c80ac7c270e→a3360a91b94d | c8a27ada47980e274394a954d8507be5089624c1bb9eccd6e4b7a33370378521 | 9276d2dbd0eb60e41f16b73e623150da201c140d7ecfbc1a96203d3de9c8083a |
| b-def-label-line | 门正文 | 0 | 0 | a5a874cfd33e→e25ba71d28d7 | 4f0d3ce085ae71bf8701bf66da92980791f6a5a978cf13118a12750b0fccc885 | 38db9e229f4db25aa0b69434ede49e9aa5ba8f6994442a327de70bd0aee6dd39 |

同一载荷在另一个克隆复测，`r-def-dest-line` 签出 artifact `4750b657e3da20e9cf139ac18f4aee78e0df1bc2061f23fc02aae9f926c3ce33`、body `d5c8083fe17672a47ab2da9ca48961aca393500e4a8a551c4162f612792c4f24`；块引用三空格续行签出 artifact `6ab6c82638ce9f7b036cf0bb309da353270a3d944fe834361e84d9b1dc7a21f1`、body `19032e11e8a98579b24044c893cf7cc7bf021a66d206b8e95c87e3638df7958e`，均 exit 0。

第三十轮的同行 P2 形态已挡：

| 用例 | sign | check | 门文件 |
|---|---:|---:|---|
| r-def-old 同行定义 | 1 | 1 | 6c80ac7c270e→6c80ac7c270e |

根因：`scripts/gate-check.ts:1012` 的 `hiddenDefinitionFailure` 只认两种行：以 `[label]:` 开头的起始行，或原始行以空白开头的续行（`/^[ \t]+/`）。markdown 引用定义的 destination/title 可以是不缩进的下一行；块引用续行以 `>` 开头而非空白；实体 `&#102;ail` 在原始行里不含字面 `fail`。这三类都被 markdown-it 渲染吃掉，`renderedAuditLines` 看不到，而 `hiddenDefinitionFailure` 也没扫到，`auditConclusionOf` 与 `bodyConclusionOf` 都只看到正式的 pass 行。

## 4. 第三十轮八条 P0 复测

六条报告侧与两条门正文侧旧 P0 全部被挡：`sign=1`、`check=1`、门文件字节未变、artifact/body 保持基线 `4f0d3ce0…` / `ce96c180…`。

| 旧 P0 | 载荷 | sign | check |
|---|---|---:|---:|
| R30-P0-1 | 本次审计原则上不推荐通过本报告。 | 1 | 1 |
| R30-P0-2 | This audit, on the whole, does not endorse the report. | 1 | 1 |
| R30-P0-3 | 本次审计不予采信并退回本报告。 | 1 | 1 |
| R30-P0-4 | 本次审计结论为：不予准入。 | 1 | 1 |
| R30-P0-5 | 整改工作尚未完成。 | 1 | 1 |
| R30-P0-6 | This audit does not consider the report ready. | 1 | 1 |
| R30-P0-7（门正文） | 本门记录不具备准入条件。 | 1 | 1 |
| R30-P0-8（门正文） | 本门记录未达到准入条件。 | 1 | 1 |

结论：第三十轮的八条 P0 与同行引用定义 P2 的旧字面形态已经修复；但修复是对旧字面的补词，不是对解析路径的收口。同族变体仍可复现绕过，第三十轮整改不能视为完成。

## 5. P1 清单

### P1-1 `required_hashes` 在生产单 agent 闭环里无法满足

实测：加载模板级 `required_hashes: ["artifact"]` 的工作流，节点允许 `ro.echo`，经 `/v1/workflows/load` → `/v1/runs` → `/v1/runs/dispatch` 走生产执行器。结果：

```text
dispatch data[0].status = failed
error_code = VERDICT_POLICY_UNMET
node_runs.status = blocked_post
report_registry.state = rejected
node_run_events: report_rejected reason=verification_too_weak
```

根因：`src/executor/run-node.ts:260` 的 done 报告固定传 `{ evidence_trace: trace }`；`src/service/commands/apply-report.ts:257` 调 `evaluateEvidence(report, policy.requiredHashes, { output: report.output })`；`src/core/policy.ts:46-68` 要求 `output` 里有与 required key 同名的产物，且值等于 `sha256(canonicalJson(output[key]))`。执行器从不产出 `output.artifact`，所以任何声明 `required_hashes` 的工作流都无法通过生产单 agent 路径收口。

这是失败关闭（不会误放行），故列 P1，不列 P0。需要二选一：让执行器把工具产物/哈希按契约并入 `output`，或在加载期拒绝自动上报节点声明 `required_hashes`；并补生产路径用例。现有 `tests/apply-report.spec.ts` 的 6 组 required_hashes 用例只直接调 `applyReport` 并手工提供 `output`，没有覆盖生产执行器。

## 6. P2 清单

### P2-1 新测试只覆盖同行引用定义，没有覆盖续行、块引用、实体

候选在 `tests/gate-check.spec.ts` 新增的用例只构造 `[1]: /url "本次审计结论：fail"` 这类同行定义与正控；没有 `[1]: /url` 换行 title、`[1]:` 换行 destination、块引用续行、实体编码 title。`hiddenDefinitionFailure` 的续行分支因此没有被测试钉住。

### P2-2 门正文没有与审计报告同级的结论尾巴校验

`auditConclusionOf` 的 strict 行走 `validConclusionTail`（只允许空、标点、一个括号或一个破折号解释；pass 的括号内容还要 `onlyCleanCounts`），`bodyConclusionOf` 没有同等校验。于是同一个 caveat 在报告 strict 行被拒，在门正文正式行被接受。两处应复用同一个结论尾巴校验器，并补“正文 pass + caveat 必须拒”的用例。

### P2-3 `required_hashes` 没有生产路径回归

`src/service/workflows.ts:92-101` 已把模板与节点的 `required_hashes` 并入策略，但测试只覆盖 `applyReport` 单点；生产链路缺一条“加载含 required_hashes 的定义 → 派发 → 收口”的回归，导致 P1-1 这种“单元正确、生产不可达”的缺口没有被发现。

## 7. 重点子系统核对（未发现 P0 的部分）

以下均为候选 `e717293` 的只读代码核对与实跑，不采信代码自述：

- 单 agent 节点闭环：`queued → leased → dispatched → started → verifying → done` 的正常路径可走通；`failed` / `timeout` 报告走 `traceBindingGate(requireFailure)`；终态无出边；`applyReport` 的幂等、attempt/status/generation CAS、`assertLeaseValid`、状态机顺序未被绕过。
- 执行器：`src/executor/run-node.ts:58-65` 先取服务端策略、派生 pure、`assertToolsAuthorized`；`:74-97` 心跳失败置 `lease_lost`；`:153-216` 每个工具先写 `tool_started`、核对 `assertCommandHash`、再落 `tool_executions` 与 `tool_finished`；`:224-239` 租约丢失或工具失败落 `blocked_post`，没有直接落 done 的路径。
- 租约：`src/service/commands/lease.ts:48-82` 两次 CAS + revision + 尝试次数；`:86-99` 续租不推进 `action_generation`；`:115-124` 过期即拒；`:127-151` sweep 过期转 `startup_unknown` / `stopping`。未发现过期租约收口。
- 工具授权 deny 优先：`src/executor/tools.ts:43-62` 先查 deny，再 `registry.require`，再查 allow；`ReadOnlyToolRunner`（`:166-218`）只允许 `capability=read_only`、宿主只读可用、argv 取注册表固定数组、cwd `resolveInside`；越权与未注册均在租约前拒。
- 证据门：`apply-report.ts:318-326` 无证据、来源非 `run_tool`、`exitCode != 0` 一律拒；`:345-405` 对 `tool_executions` 与 `tool_finished` 同 attempt 全等，含 `commandHash`；`evaluateEvidence` 的 requiredHashes 绑定 output 同键产物、拒绝 null、拒绝两键同摘要。未发现弱证据直达 done。
- `required_hashes` 单元语义：伪造 64hex、命令哈希冒充、缺键、null 产物、两键同摘要均被拒；`tests/apply-report.spec.ts` 46 例、`tests/policy.spec.ts` 12 例通过。
- 测试实跑：`npx vitest run tests/apply-report.spec.ts tests/clock.spec.ts tests/lease.spec.ts tests/tools.spec.ts tests/runtime.spec.ts tests/sweep.spec.ts tests/integration/g2.spec.ts tests/policy.spec.ts tests/workflows.spec.ts tests/production-path.spec.ts`，10 个文件 124 例全过，exit 0。

## 8. 最终结论

候选提交修复了第三十轮八条 P0 的旧字面形态，也在同行引用定义上加了拦截；但 G2 结论解析仍存在四族可签可过的 P0 绕过：post-pass 准入尾巴、句内语气副词/框式结构、整改完成度程度否定、引用定义续行与实体隐藏。另有 `required_hashes` 生产路径不可达的 P1。按“审计没通过就不能往后走”的口径，本轮不放行。

结论：fail
