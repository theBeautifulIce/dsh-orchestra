# S1 / G1 独立审计（第二十六轮）

门：G1
候选提交：e7172935d1f93ba7ec1cb7d2a48e9b2b1428bbca
审计日期：2026-11-14
审计方式：只读；主仓源码、门记录、证据未改；攻击与重签只在临时克隆内进行。

## 范围与方法

本轮以候选提交的 G1 门记录、审计报告结论解析、账本/迁移/哈希链/备份/单写者锁与 epoch 栅栏/时钟为对象。所有结论来自实跑：临时克隆 D:/aboutAI/audit-s1-r26 里写夹具并重签，再用自写载荷逐条攻击 sign-gate 与 gate-check，记录两个退出码、门记录字节变化与 artifact/body 哈希；技术核查在 D:/aboutAI/audit-s1-r26-tech 进行。

工具链：Windows，Node v26.13.1（D:/NodeJs/node.exe），仓库 package.json 为 type=module，门脚本用 node 直接跑 TypeScript，pnpm 不可用。主仓审计开始时 git status --porcelain 为空，HEAD 即候选提交。

审计期间主仓工作树出现未提交改动：M scripts/gate-check.ts、M tests/gate-check.spec.ts、?? docs/audits/S1-independent-audit-round25.md、?? docs/audits/S1-round25-response.md（修改时间 2026-11-14 04:56–04:58）。这些改动不是本审计代理所写，本审计未清理、未纳入候选；候选始终按 e7172935 固定。本报告的 P0/P1/P2 只针对 e7172935，未评估这些未提交改动。

## 夹具与基线（仅存在于克隆）

候选提交本身的 G1.md 是 pre-sign 状态：artifact 的 audit_round=1、audit_report 指向 docs/audits/S1-independent-audit.md、audit_report_sha256 为 64 个零。为了让 G1 在克隆内进入可验证的已签状态，先做一份只用于克隆的夹具：

- 新增 docs/audits/S1-independent-audit-round26.md。内容只含三件事：第一行写门代号 G1；一行写候选提交的 40 位哈希；一行写一条 pass 判定。正文明确注明这是夹具，真实报告以主仓同名文件为准。
- 把 docs/gates/G1.md 的 artifact 改成 audit_round=26，audit_report 指向上述夹具路径，其余字段不动。
- 在克隆内提交夹具锚点（6e4d701），再跑 sign-gate（ab36fad）。

夹具重签后基线值：

```text
artifact_hash=101200040d2f5a4c0496fcb2b4f061d73dad0ddd5f5851dee3461ab41b6280db
body_hash=89ef4799dc8e6cd97135f45f5077f9c4469abe4ed92220967bb371251fbc858e
audit_report_sha256=80c7ffa7d729fc85e6b0431a10b3e1eaba6bcee45debd312fc15fb5dd5295bbe
candidate_hash=3163bd98b7339acaf7b63a662371fe2f159326c6ed85612728f3fd294eed3199
change_scope_hash=83793fffc1fb10e1c1818eaf192171210853a5d7219965c8157727a0891744d4
evidence_index_hash=c4da9202cfc9535cc99cd9810858344989c8ed9032bce065f8c41b350eb6efd3
invariants_hash=6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6
G1.md sha256=a6d8f09540577d4a510b4febf7d19d816b2316f78ba882f726da63fc9abbdf40
```

sign-gate 基线输出：重签完成：证据 13 份，candidate=3163bd98b733…，artifact_hash=101200040d2f…，body_hash=89ef4799dc8e…，改动文件 115 个；退出码 0。gate-check 基线输出：gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=101200040d2f… body_hash=89ef4799dc8e…）；退出码 0。

## P0：门与报告可被显式否定语句签过

以下每一条都在克隆内从基线 ab36fad 重新开始，载荷先提交，再跑 sign-gate 与 gate-check。八条全部 sign-gate 退出 0、gate-check 退出 0，门记录被实际重签（sha 变化），artifact 仍为 pass。

### P0-1 门记录正文：尚不具备准入条件

```text
本门记录尚不具备准入条件。
```

实跑（提交 bd27865 → sign 98867f6）：sign-gate 退出 0，gate-check 退出 0。G1.md sha 从 a6d8f09540577d4a510b4febf7d19d816b2316f78ba882f726da63fc9abbdf40 变为 acf861f304cf77662f5d629b1a21ce877d65498d8c0a212e7a443f37083d15c7（载荷）再变为 f61b047d9908458c12dd89f449f5b19ba39d397818eb1ecddfd63a589c553807（重签）；artifact_hash=101200040d2f5a4c0496fcb2b4f061d73dad0ddd5f5851dee3461ab41b6280db，body_hash=fda730b77ea60a094ea4f7b8af6be70170f9d751663c1c1fa56d5204c3404913。

### P0-2 门记录正文：不能作为准入依据

```text
本门记录不能作为准入依据。
```

实跑（提交 a17406b → sign 10e580d）：sign-gate 退出 0，gate-check 退出 0。G1.md sha 从 a6d8f095… 变为 57f31f36ed27d66cb4a1be9814e019854c8d4afacf3d154d0f36c967f7ab57db（载荷）再变为 6d946c56d65f3db68b947e19f73dc58ea457517bc2b26c9aae72ab39787c25ac（重签）；artifact_hash=101200040d2f…，body_hash=c691272bcc5c7af3bdcde85057346f9ad1795ee9835072a2ef359bb912e62ff6。

### P0-3 报告：通过，但准入条件尚未满足

```text
本次审计结论：通过，但准入条件尚未满足。
```

实跑（报告提交 0604d13 → sign 91f1655）：sign-gate 退出 0，gate-check 退出 0。G1.md sha 从 a6d8f095… 变为 04ad5e019df3804e44aedfa432f5d9b969e945006994de2c71a1d21c8ecd3f2f；artifact_hash=958e70d856e3ee9111c6fff1e6833f6473be975bcd29af7e02389f62c9d5d42e，body_hash=6ed4ad52c4ff0f8cb91da547c6b2687694fffd359bb1f5a8c21d390a912a6cfb。

### P0-4 报告：已通过，但尚不具备放行条件

```text
本次审计原则上认为本报告已通过，但尚不具备放行条件。
```

实跑（报告提交 bb5e6da → sign c0e1546）：sign-gate 退出 0，gate-check 退出 0。G1.md sha 从 a6d8f095… 变为 1dff0044b4acf7a3b8217a06062b4b95e4b82b2dec8d12fecefec0304dbab0dd；artifact_hash=57a1d6ccf3f81de5d6b86fc60ac5b02660c087602d36d1f65f4d6bb7ed6a08f3，body_hash=ecd21c03229a3094aa1ac421b7a82957a0fdbfd79c64b30487316330ac244aca。

### P0-5 报告：generally speaking 否定句

```text
This audit, generally speaking, does not clear the gate.
```

实跑（提交 78c4817 → sign 81ee4de）：sign-gate 退出 0，gate-check 退出 0。G1.md sha 从 a6d8f095… 变为 51c5c63fc01a0379e4064c53d8a1e57e0786d24c43296aea081480044102dcaa；artifact_hash=c604f64ef2e2b784913686afca6f4df0c5a2ded9524c2aaac749f65efb5431c3，body_hash=f40fe4e7f59cb86a401ce11cf5927513e8e364f4a9afb64b48703c3299cbf7ce。

### P0-6 报告：总体而言不推荐通过

```text
本次审计总体而言不推荐通过本报告。
```

实跑（提交 472c630 → sign df31067）：sign-gate 退出 0，gate-check 退出 0。G1.md sha 从 a6d8f095… 变为 5f2d55ba88b7b1cb6aea5742a104fda34827fd7dc315e49cc89154817a5a0616；artifact_hash=51990d02bb6c3b6297b043f1af8dacec51c76b5e1a050f650acd066321622dad，body_hash=a5c05a225d913e213d6f2d6d112daa98053d4b059f962560a93d6c660e825e93。

### P0-7 报告：原则上认为尚未完成整改

```text
本次审计原则上认为本报告尚未完成整改。
```

实跑（提交 04fbba9 → sign ebd72dd）：sign-gate 退出 0，gate-check 退出 0。G1.md sha 从 a6d8f095… 变为 f0773ad635958b171f732347fe17ad22a2ee92311991f8e965d85aafa057c035；artifact_hash=e6aadf2dc73f09891599ad2cd8b06a8979ab223d0e5e66579fb0e63ca7a15478，body_hash=8e2657163eba12a8c623fe6ecec5c6853ded504ff4fb622be280feaf932d0488。

### P0-8 报告：总体而言不予推荐

```text
本次审计总体而言不予推荐本报告。
```

实跑（提交 8b683c3 → sign 0e4494c）：sign-gate 退出 0，gate-check 退出 0。G1.md sha 从 a6d8f095… 变为 3cca41abb6dea36d1882701c2947bdfb2d28e12f82faaee42520f50cad5d8095；artifact_hash=0b515aea9c286302d428bcb9d51d7039ae7f4389f60487844322f8faadd3a181，body_hash=4ceb87720e8bf6d52d1fc3b554b8a261f5be149694909193f95ea3d9522434fd。

### P0 共同机制

结论解析仍是离散词表加短链扫描，负向语义一旦换词就漏：认为、作为、推荐、满足、具备、依据等词不在否定谓词或对象表里；总体而言、generally speaking 不在连接副词表里；整体否定句因此被当成普通叙述，再由夹具里一条干净 pass 判定行把报告判成 pass。门记录正文同理：本门记录 + 尚不具备准入条件 / 不能作为准入依据，均未进入 fail 分支。

按重点分类：句内语气副词在 P0-5、P0-6、P0-8；连续谓词在 P0-3、P0-4；整改完成度否定在 P0-7；门记录正文否定在 P0-1、P0-2；引用定义与隐藏定义在 S2-P2-1 复测中仍被挡住。

对照：S2 第三十轮的既有载荷在 G1 入口仍被挡住（见下一节），说明修复只覆盖了那几条固定句式，没有覆盖同一语义族的变体。

## S2 第三十轮八条 P0 与 P2 的 G1 复测

全部在克隆内实跑。P0-1 至 P0-6 与 P2-1 是报告载荷；P0-7、P0-8 是门记录正文载荷。

| 编号 | sign-gate | gate-check | 门字节 | artifact/body |
| --- | --- | --- | --- | --- |
| S2-P0-1 本次审计原则上不推荐通过本报告。 | 1 | 1 | 未变 | 基线 101200040d2f…/89ef4799dc8e… |
| S2-P0-2 This audit, on the whole, does not endorse the report. | 1 | 1 | 未变 | 基线 |
| S2-P0-3 本次审计不予采信并退回本报告。 | 1 | 1 | 未变 | 基线 |
| S2-P0-4 本次审计结论为：不予准入。 | 1 | 1 | 未变 | 基线 |
| S2-P0-5 整改工作尚未完成。 | 1 | 1 | 未变 | 基线 |
| S2-P0-6 This audit does not consider the report ready. | 1 | 1 | 未变 | 基线 |
| S2-P0-7 本门记录不具备准入条件。 | 1 | 1 | 载荷后 4e188758…，sign 未再写 | 基线 |
| S2-P0-8 本门记录未达到准入条件。 | 1 | 1 | 载荷后 9651dc1b…，sign 未再写 | 基线 |
| S2-P2-1 链接定义藏 fail 判定 | 1 | 1 | 未变 | 基线 |

失败原因：报告六条与 P2-1 均停在 checkAuditAnchor 的“审计报告里找不到唯一结论行”；P0-7、P0-8 停在 verifyGateRecord 的“门记录正文结论与 GateArtifact 不符：正文=fail，artifact=pass”。八条 P0 与 P2 在 G1 入口全部被挡住，但同族新变体（上一节）全部漏过。

## P1

### P1-1 备份在并发读快照下生成坏副本

复现：D:/aboutAI/audit-s1-r26-tech/probe-backup.ts。库内 tasks 已有 t1；另一连接 BEGIN 并 SELECT 持有 WAL 快照；写入 t2 后，backup 先执行 PRAGMA wal_checkpoint(TRUNCATE)。实测返回：

```text
S1 checkpoint= [{"busy":1,"log":60,"checkpointed":58}]
S1 live= 2 backup_error=database disk image is malformed verify_error=备份缺清单或清单坏了
S2 no_reader manifest_tasks= 2 verify= pass
S3 main_only copy err= no such table: tasks
```

根因在 src/infra/backup.ts:31-41：checkpoint 的 busy/log/checkpointed 返回值被忽略，随后直接 copyFileSync 主库文件，不复制 WAL、不用 SQLite backup API、也不校验线上表与副本表摘要是否一致。备份会以“没有清单”的坏目录形式失败，verifyBackup 能挡住恢复，但备份可用性没有保证；G1 证据 ev-backup 只覆盖串行场景，未覆盖并发读。

### P1-2 哈希链尾部截断与整链删除检测不到

复现：D:/aboutAI/audit-s1-r26-tech/probe-core.ts。追加 seq 1/2/3 后直接 DELETE 尾行：

```text
A delete_tail_changes= 1 rows= 2 verify= null
A2 delete_all_changes= 2 rows= 0 verify= null
B events_update= events 只追加，不许改 | events_delete= events 只追加，不许删
```

中间删除会被 prev_hash 不接上一条抓住（tests/hash-chain.spec.ts 已覆盖），但尾部与整链删除后 verifyChain 返回 null；verifyLedger 的 node_run 清单又来自幸存行（src/service/queries/verify_ledger.ts:14），被整链删掉的 node_run 不可见。node_run_events 表没有 append-only 触发器（005_append_only_events.sql 只给 events 建了 trg_events_no_update/no_delete），也没有外部链头锚点。G1 不变量 I2 的“哈希链能检出篡改”在尾部截断场景不成立。

## P2

P2-1 候选提交的 G1.md 本身是 pre-sign 状态（audit_report_sha256 为 64 个零，指向旧报告），因此候选树上 11 个 gate-check 测试红、gate-check 退出 1。这与 docs/audits/S1-round24-response.md 的 P2-1 说明一致，属于待重签而非新缺陷；但意味着候选提交不能直接当“全绿”证据引用。

P2-2 报告结论解析对多数否定载荷只给出统一的“找不到唯一结论行”，不说明是含糊、隐藏块还是词表未命中，排障成本偏高；失败方向是 fail-closed，未构成本轮放行风险。

P2-3 围栏代码块中的判定行按设计不计入结论（S1 第二十四轮 P1-1 已确认），本轮未改；这是既定口径，记录以便后续审计不再重复报。

## 技术核查

- 类型检查：D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit，退出 0。
- 全量测试：32 个文件、370 例，359 通过、11 失败；11 例全在 tests/gate-check.spec.ts，失败原因均为候选 G1.md 未重签（审计报告 sha 为 64 个零），与 P2-1 同一件事。其余 31 个文件通过，含 tests/integration/g1.spec.ts 的 G-01/G-02/G-08/G-09/G-14/G-15。
- 迁移：001 至 005 连续无缺号；已执行迁移改内容报 SCHEMA_VERSION_UNSUPPORTED；中途失败可重入；G-14 证据显示重跑只补 [902]，schema_migrations 为 [1,2,3,4,5,901,902]。
- 账本：events 的 UPDATE/DELETE 被触发器拒绝；node_run_events 的中间删除/改 payload 能被哈希链抓住；尾部删除见 P1-2。
- 单写者锁与 epoch 栅栏：tests/db-open.spec.ts 通过（bumpEpoch 1→2；旧 epoch 写报 STALE_GENERATION；新 epoch 正常写；第二把锁 ELOCKED，释放后可再拿）。别名路径实测（probe-lock.ts）：同路径、盘符大小写变体、带 sub/../ 的路径全部被 proper-lockfile 归一化并返回 ELOCKED，未发现别名绕过。
- 时钟：tests/clock.spec.ts 通过（同 boot pending/expired、墙钟前后跳 10 分钟均 uncertain/clock_drift、容差 2000ms 内按单调钟、跨 boot uncertain/boot_changed、跨 boot 预算 20s→40s 与 90s→0）。
- 门检查：夹具基线 gate-check 退出 0；13 项必过、13 份证据哈希复核通过。

## 复现命令

```bash
git clone D:/aboutAI/dsh-orchestra D:/aboutAI/audit-s1-r26
cd D:/aboutAI/audit-s1-r26
git checkout e7172935d1f93ba7ec1cb7d2a48e9b2b1428bbca
# 按“夹具与基线”一节写夹具报告，并改 G1.md 的 audit_round=26、audit_report 指向夹具
git -c user.name=audit -c user.email=audit@local commit -am "fixture: G1 round26 report and artifact anchor"
D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G1.md
git -c user.name=audit -c user.email=audit@local commit -am "fixture: sign G1 round26"
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md
```

单条载荷复现：

```bash
git reset --hard ab36fad
# 把载荷写进报告或插到 G1.md 证据索引之前，提交
git -c user.name=audit -c user.email=audit@local commit -am "attack <编号>"
D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G1.md; echo sign=$LASTEXITCODE
git -c user.name=audit -c user.email=audit@local commit -am "sign <编号>"
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md; echo check=$LASTEXITCODE
```

本轮使用的批量脚本与原始结果：D:/aboutAI/audit-s1-r26-attack/attack3.mjs、attack4.mjs，结果在 results3.jsonl、results4.jsonl；S2 复测在 results2.jsonl。技术探针在 D:/aboutAI/audit-s1-r26-tech/probe-core.ts、probe-backup.ts、probe-lock.ts。

## 限制

只在 Windows 上实测；攻击目标是门记录与报告解析，未对全部 Unicode 归一化路径做穷举模糊测试；主仓只新增本报告，源码、门记录、证据未动，克隆内结论不能替代人类对修复方案的复核。

## 最终判定

结论：fail
