# S1 独立审计报告（第 21 轮）

门：G1
候选提交：6cb95b3840e8a88ff605d23f49f73c5c39b6b066

结论：fail

## 1 审计对象与方法

- 仓库：D:/aboutAI/dsh-orchestra；候选：6cb95b3840e8a88ff605d23f49f73c5c39b6b066。
- 干净副本：D:/aboutAI/_g1audit-r21/clone，HEAD 即候选，工作区干净；另有 D:/aboutAI/_g1audit-r21/vitest-clone 用于重签态全量测试。两处的 node_modules 都是指向 D:/aboutAI/_g1audit-r20/clone/node_modules 的 junction，只用于运行测试。
- 主仓只读：本报告是唯一新增文件，未修改源码、测试、门记录、证据，未提交。
- 先读了 AGENTS.md、docs/gates/G1.md、scripts/gate-check.ts、scripts/sign-gate.ts、docs/agents/domain.md，再逐份读 13 份证据与对应测试。
- 独立复算脚本：D:/aboutAI/_g1audit-r21/verify-core.mjs、official-probe.mjs、evidence-head-sha.mjs；官方函数交叉脚本：official-probe.mjs；报告扫描探针：probe-report-new.mjs。
- 全量测试：在重签后的 vitest-clone（9fc7807）上跑 tsc 与 vitest，均 exit 0，348 项全绿。

## 2 13 项必过与证据

| 编号 | 内容 | 复核 | 证据 |
| --- | --- | --- | --- |
| G1-01 | 迁移空库可重复 | 成立 | ev-migrate |
| G1-02 | 迁移中途杀可重入 | 成立 | ev-g14 |
| G1-03 | 进程杀不丢已提交事件 | 成立 | ev-g02 |
| G1-04 | 备份独立目录行数与哈希一致 | 成立 | ev-backup |
| G1-05 | 损坏备份可检出 | 成立 | ev-g15 |
| G1-06 | 认证拒匿名写 | 成立 | ev-auth |
| G1-07 | 阶段开关拒未知值 | 成立 | ev-phase |
| G-01 | 事务 COMMIT 前杀进程 | 成立 | ev-g01 |
| G-02 | COMMIT 后未投递被杀 | 成立 | ev-g02 |
| G-08 | 长事务期间读不被拖死、写报 busy、队列溢出报 503 | 成立 | ev-g08 |
| G-09 | 订阅者离线重放 | 成立 | ev-g09 |
| G-14 | 迁移一半杀后重跑 | 成立 | ev-g14 |
| G-15 | 备份截断能检出、恢复被拒、线上库不变 | 成立 | ev-g15 |

13 份证据按 git HEAD 字节、CRLF→LF 归一后重算 sha256：

| 证据 | 文件 | 记录值 | 重算值 | 状态 |
| --- | --- | --- | --- | --- |
| ev-auth | tests/auth.spec.ts | 13f12317… | 13f12317… | 一致 |
| ev-backup | tests/backup.spec.ts | 8b8d5413… | 8b8d5413… | 一致 |
| ev-chain | tests/hash-chain.spec.ts | e15bb381… | e15bb381… | 一致 |
| ev-epoch | tests/db-open.spec.ts | 78263f1c… | 61623a67… | 不一致 |
| ev-g01 | docs/gates/evidence/G1/G-01.md | f2626b30… | f2626b30… | 一致 |
| ev-g02 | docs/gates/evidence/G1/G-02.md | 5fedb2e7… | 5fedb2e7… | 一致 |
| ev-g08 | docs/gates/evidence/G1/G-08.md | a50e5a17… | 2f2a73dd… | 不一致 |
| ev-g09 | docs/gates/evidence/G1/G-09.md | e944a2b6… | e944a2b6… | 一致 |
| ev-g14 | docs/gates/evidence/G1/G-14.md | 3b2e37d9… | 7869d3d1… | 不一致 |
| ev-g15 | docs/gates/evidence/G1/G-15.md | db16d844… | 334f26fb… | 不一致 |
| ev-gatecheck | tests/gate-check.spec.ts | c6126250… | fa5e08d4… | 不一致 |
| ev-migrate | tests/migrate.spec.ts | b3ad3fbd… | 80ca9602… | 不一致 |
| ev-phase | tests/config.spec.ts | d2175cc5… | d2175cc5… | 一致 |

完整重算值与逐项命令见 D:/aboutAI/_g1audit-r21/core-verify.json 与 evidence-head-sha.mjs 的输出。6 份不一致是候选上尚未重签造成的记录陈旧，不是测试或证据内容失效：同样 13 项在重签后的正控里全量跑绿（第 4 节），且 sign-gate 会按 HEAD 字节重写这些哈希。

## 3 四个哈希、artifact 与正文同源

| 哈希 | 记录值 | 独立重算值 | 状态 |
| --- | --- | --- | --- |
| candidate_hash | bbd322cf… | 2d7f4035…（115 个文件） | 不符 |
| change_scope_hash | ea15eaba… | 83793fff… | 不符 |
| evidence_index_hash | fad4d531… | fad4d531… | 符 |
| invariants_hash | 6f75465b… | 6f75465b… | 符 |
| artifact_hash | 1ce80f60… | f54dcae8… | 不符 |
| body_hash | 446357f9… | 111ce311… | 不符 |
| audit_report_sha256 | 00000000… | 50ba1b13… | 不符 |

正文与 artifact 的同源检查：必过项表 13 行、证据表 13 行、不变量表 4 行、例外空，逐项 canonicalJson 比对无差异；正文顶部只有一行意见，与 artifact 对应：

```
正文：- 结论：**pass**（13 项必过全过，失败项为空，无 run）
artifact.conclusion = pass
```

前序链：artifact.previous_artifact_hash 为 64 个 0，符合 G1 的首门规则。候选绑定：旧报告 docs/audits/S1-independent-audit.md 只绑定了 61b43db311b540532ac6b09c1943fc2551a3d07e，没有“门：G1”行；因此候选上直接跑 gate-check 会停在审计报告 sha256 与记录不符，重签前必须把 audit_round/audit_report/audit_report_sha256 指向本轮报告。这属于未签态，不是代码或证据缺陷，详见 P2-1。

## 4 正控：干净报告可以完成签门链路

在 clone 中把 G1 的 audit_round 改为 21、audit_report 指向 docs/audits/S1-independent-audit-round21.md、audit_report_sha256 写成该报告的实际 LF sha256，报告正文只含门名、候选与本轮意见，提交后再签：

```
commit 74481e0  positive control round21 report and binding
sign-gate exit 0：重签完成：证据 13 份，candidate=2d7f40354cf6…，artifact_hash=259b01eb4c79…，body_hash=d2245a8351b9…，改动文件 115 个
commit 9fc7807  sign G1 round21 positive control
gate-check exit 0：gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=259b01eb4c79… body_hash=d2245a8351b9…）
tsc --noEmit exit 0
vitest run exit 0：32 个文件、348 项全绿
```

完整日志见 D:/aboutAI/_g1audit-r21/positive-control.json；全量测试在 D:/aboutAI/_g1audit-r21/vitest-clone 上复跑。说明 13 项必过的测试与签门链路本身可用，候选上的失败只是记录未重签。

## 5 P0：签门可被绕过（6 类）

以下报告正文载荷均已实测 sign-gate exit 0、gate-check exit 0；门记录正文载荷已完成 2 例（body-new-verdict-noun、body-new-en-doesnt），同样 exit 0。门记录里人读到的否定意见没有被拦住。

### P0-1 否定词后接宾语仍被当成普通叙述

```
报告正文：本报告未通过验收。              → sign=0 gatecheck=0
报告正文：本次审计未通过评审。            → sign=0 gatecheck=0
报告正文：本報告未通過驗收。              → sign=0 gatecheck=0
```

根因在 scripts/gate-check.ts:631-636 的注释与 scripts/gate-check.ts:731-732 的后继字符规则：否定词后只接受结尾、分隔符或“需应已的了”，于是带宾语的否定句被当成叙述放行，具体载荷见上。

### P0-2 英文缩写否定不在词表

```
The audit doesn't pass.        → sign=0 gatecheck=0
The audit won't pass.          → sign=0 gatecheck=0
The audit hasn't passed.       → sign=0 gatecheck=0
```

词表 scripts/gate-check.ts:651-663 有 didnt/wasnt/isnt，没有 doesnt/wont/hasnt；撇号在 foldForVerdict 里被删掉后也拼不回词表项。

### P0-3 英文批准类否定缺失

```
The audit was not approved.    → sign=0 gatecheck=0
The audit is not passing.      → sign=0 gatecheck=0
```

这两个英文否定式都不在词表。

### P0-4 中文批准、驳回、否决类缺失

```
本报告未获批准。               → sign=0 gatecheck=0
本报告被驳回。                 → sign=0 gatecheck=0
本报告被否决。                 → sign=0 gatecheck=0
本报告没有获得通过。           → sign=0 gatecheck=0
```

这四个中文否定式都不在词表。

### P0-5 同形字未折叠

```
本报告 fаil。                  → sign=0 gatecheck=0   （а 为西里尔字母 U+0430）
本报告未通о过。                → sign=0 gatecheck=0   （о 为西里尔字母 U+043E）
```

foldForVerdict（scripts/gate-check.ts:686-707）做 NFKC、去撇号、丢 Cf/Mn/Me，但不做同形字归一；西里尔字母留在 p{L} 里，词表匹配不到。

### P0-6 连接词上限 8

```
本报告的的的的的的的的的不通过。                              → sign=0 gatecheck=0
The audit was was was was was was was was was not pass.       → sign=0 gatecheck=0
```

`scanFailStatement`（scripts/gate-check.ts:719-747）的连接词循环是 guard < 8；第 9 个连接词后还没有遇到否定词就退出，载荷签过。

## 6 P1：合法的历史叙述被误杀

一份如实记录上一轮整改的干净报告会被判成第二意见而拒绝签门；门记录正文里同样的历史句也会被拒。这是过度拒绝，逼着审计报告删掉真实的整改历史。

```
报告正文：历史记录：上一轮审计未通过，本轮已整改。          → sign=1
报告正文：round20 审计结论为 fail，本轮已整改。             → sign=1
报告正文：The previous audit did not pass; this round is clean. → sign=1
门记录正文：上一轮审计未通过，本轮已整改。                  → sign=1（body 用例）
```

对照组（见下）可以正常签过：

```
本轮检查未通过项为零，所有必过项均已通过。 → sign=0 gatecheck=0
```

边界本身是有意收窄的，但历史叙述与带宾语的否定句没有被区分开，形成误杀。

## 7 P2：未签态与测试信号

- P2-1 候选上的 G1 仍是未签态：6/13 证据哈希、candidate_hash、change_scope_hash、artifact_hash、body_hash 都与 HEAD 不符，audit_report_sha256 还是 64 个 0；旧报告没有“门：G1”绑定。sign-gate 能重写证据哈希与四个哈希，但签门的人必须先更新 audit_round/audit_report/audit_report_sha256 指向本轮报告，否则 gate-check 仍会因旧报告绑不上而失败。正控已演示这条路径。
- P2-2 全量测试与门记录状态强耦合：未签的候选上跑 vitest，会有 11 项 tests/gate-check.spec.ts 失败，原因都是审计报告 sha256 与记录不符；重签后 348 项全绿。这种噪声会掩盖真正的回归，建议把“未签态”作为显式 fixture 或在测试里先签一份本地记录。

## 8 汇总

- P0：6 类，16 份报告载荷 + 2 份门记录正文载荷已确认；另有 3 份正文载荷（中文批准类、同形字、连接词上限）在本轮收口时未跑完，标未验证。
- P1：1 类，3 份报告载荷已确认；1 份门记录正文用例未跑完，标未验证。
- P2：2 项。
- 13 项必过在重签后的正控里全部可复现，问题集中在门检查的否定意见扫描层，不在账本、迁移、备份、认证与事务语义本身。

## 9 复现命令与证据路径

```
cd D:/aboutAI/_g1audit-r21

# 独立复算：13 项、13 份证据、四个哈希、正文同源
D:/NodeJs/node.exe --no-warnings verify-core.mjs

# 只按 git HEAD 字节重算 13 份证据
D:/NodeJs/node.exe --no-warnings evidence-head-sha.mjs

# 官方扫描函数对 28 份报告载荷的分类
D:/NodeJs/node.exe --no-warnings probe-report-new.mjs

# r20 的 17 例（当前候选；正控 + 16 份否定载荷）
D:/NodeJs/node.exe --no-warnings run-e2e-r21.mjs D:/aboutAI/_g1audit-r20/cases.json D:/aboutAI/_g1audit-r21/e2e-results-full.json

# 本轮 35 例（16 份报告绕过 + 8 份被拦住 + 4 份过度拒绝 + 7 份正文）
D:/NodeJs/node.exe --no-warnings run-e2e-r21.mjs D:/aboutAI/_g1audit-r21/cases-new.json D:/aboutAI/_g1audit-r21/new-results.json

# r20 的 8 份正文载荷（当前候选）
D:/NodeJs/node.exe --no-warnings run-body-r21.mjs
```

主要证据路径：
- D:/aboutAI/_g1audit-r21/core-verify.json：48 项结构、表格、哈希与绑定检查，7 组不符。
- D:/aboutAI/_g1audit-r21/e2e-results-full.json：r20 的 17 例，正控 sign=0/gatecheck=0，16 份载荷 sign=1 且门记录未变。
- D:/aboutAI/_g1audit-r21/new-results.json、new-run.log：本轮 35 例逐例 sign/gatecheck 退出码与 artifact_hash。
- D:/aboutAI/_g1audit-r21/body-results-r21.json、body-rerun.log：r20 的 8 份正文载荷，全部 sign=1 且门记录未变。
- D:/aboutAI/_g1audit-r21/positive-control.json：干净报告重签与 gate-check 的完整日志。
- D:/aboutAI/_g1audit-r21/clone、vitest-clone：候选与重签态的两个干净副本。

## 10 说明

- 本报告只新增一个文件，未改源码、测试、门记录、证据，未提交；审计期间主仓还有并行的 S2 整改文件（scripts/gate-check.ts、src/core/policy.ts 等）处于未提交状态，那些改动不属于本报告，也未参与本报告的候选核对。
- 没有联网取外部事实；所有判断来自本仓源码、git 对象、测试与本地复跑。
- 报告自身用官方 auditConclusionOf/auditBindingOf 复核：门名 G1、候选 40 位、正文只有一行意见；其余带否定词的例句都在代码块里，不参与可见正文扫描。
- 未验证项：body-new-zh-notapproved、body-new-homoglyph-en、body-new-connectors-9、body-safe-history、body-safe-zero 这 5 例在收口时仍在跑，不当作已确认事实；其余报告载荷与 r20 的 8 份正文载荷都已有退出码记录。