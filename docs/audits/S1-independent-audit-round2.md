# S1 独立审计报告（第二轮）

- 审计对象：`D:\aboutAI\dsh-orchestra`，HEAD `f68e836471e820355bc23b3bcce2f8a7e345b1bf`
- 结论：**fail**
- 计数：致命 0；重大 2；不阻断 2（另 1 条观察，不计入）

## 一、审计范围与方式

本轮只读源码、测试、门记录与 HEAD 字节：未修改任何源码、测试、门记录或证据，未执行 `git add` / `git commit`。所有哈希均用 `git show HEAD:<path>` 取原始字节、按 LF 归一后重算；所有测试与门检查均用 `D:/NodeJs/node.exe` 直接运行，未使用 pnpm。

审计期间工作树已有并行 S2 改动：`M docs/audits/S2-round5-response.md`、`M handoff.md`、未跟踪的 `docs/audits/S2-independent-audit-round6.md`；非本轮产生，本轮未触碰。G1 门检查按 HEAD 读取，证据与候选哈希不受这些工作树改动影响；`scripts/sign-gate.ts:12` 的 `assertClean` 会拦下当前脏树的重签，实际重签需先提交或清理这些改动。

审计对象是 HEAD 的门记录与 S1 交付；当前 G1 记录签于更早的 HEAD（候选行写 `10abcaa2dfc8b81a4a2d11f499839c7896042d06`），本轮先判断 S1 的五个原问题与 13 项必过项是否仍成立，再判断门检查本身是否还有可绕过的结构缺口。原五项均已闭合，但门检查仍有两项新的重大绕过；按“0 致命且 0 重大才 pass”的口径，本轮判 **fail**。

## 二、原 S1 五项逐条复核

| 原项 | 判定 | 证据与实测 |
| --- | --- | --- |
| F1 门检查不验证据文件 | 闭合 | `scripts/gate-check.ts:214-239` 的 `checkEvidence` 逐份读 HEAD 文件，LF 归一后重算 sha256，与 evidence-index 比，再按 id 排序重算 `evidence_index_hash`；`tests/gate-check.spec.ts:68-75` 覆盖“改 ev-g15 哈希后点名报错”。独立重算 13 份证据，12 份与 G1.md 表内值一致；`ev-gatecheck` 因 HEAD 已前进到 f68e836 而不一致（记录 `c6126250…`，实际 `66660a9f…`），说明检查会拦住过期记录，需重签。 |
| M4 必过清单不固定 | 闭合 | `GATE_SPECS.G1.items` 是 13 项常量（`scripts/gate-check.ts:43`），`verifyGateRecord` 在 515-518 行用 `canonicalJson(gotIds)` 与 spec.items 全等比对；`tests/gate-check.spec.ts:60-66` 把清单截成 1 项后期望 `必过项清单不符`。当前该用例被更前面的审计锚拦下，未走到断言；代码路径本身成立。 |
| M3 三个哈希无原像 | 闭合 | `checkEvidence` 重算 `evidence_index_hash`；`checkInvariants`（241-262）重算 `invariants_hash`；`checkCandidate`（453-463）重算 `candidate_hash` 与 `change_scope_hash`；`bodyHashInput`（378-384）与 `checkBodyHash`（390-397）重算正文自锚；`artifact_hash` 由 artifact 的 canonicalJson 重算。独立重算 `artifact_hash` 与 `body_hash` 均与 G1.md 锚一致；`candidate_hash` / `change_scope_hash` / `evidence_index_hash` 因 HEAD 前进与记录不一致，属待重签，不是“无原像”。 |
| M2 G-08 写队列未接服务写路径 | 闭合 | `src/service/server.ts:6` 引入 `WriteQueue`，`startServer` 在 260 行创建默认 `new WriteQueue(1000, log)`，`/v1/ledger/events` 在 245-249 行走 `queue.run(() => deps.appendLedgerEvent(...))`；`workflows/load`、`runs`、`dispatch`、`lease`、`renew`、`report`、`run`、`cancel` 共 8 条命令路由也走 `queue.run`。`src/service/write-queue.ts:23-34` 在 pending 达到上限时记 warning 并抛 `SERVICE_UNAVAILABLE`；`tests/write-queue.spec.ts:20-49` 用真实 `startServer` 断言 HTTP 503、错误码、`appended=0` 与 warning 日志。G-08.md 本身仍是模块级证据（见下文不阻断项），但生产写路径已接。 |
| M5 G-15 证据与标题矛盾 | 闭合 | G-15.md 现在写“损坏检出、恢复被拒：true、线上库未变：true、线上库 sha ca48b472d6da、线上事件数 1”，与标题一致；`tests/integration/g1.spec.ts:39-44` 逐字断言“截断”“恢复被拒：true”“线上库未变：true”；`tests/backup.spec.ts:69-76` 覆盖截断报 `(db_file)`，`90-107` 覆盖 restore 到新文件且线上 size/sha 不变；`src/infra/backup.ts:84-88` 的 restore 先 `verifyBackup` 再复制到新文件。G1.md:205 的 `<tmp>` 声明与 G-15.md:3 的绝对路径不一致，属证据卫生问题，不影响 M5 的机制结论。 |

## 三、G1 十三项必过项核对

| 项 | 证据 | 判定 |
| --- | --- | --- |
| G1-01 迁移空库可重复 | ev-migrate（`tests/migrate.spec.ts`） | 支持。6 例覆盖空库应用、重复应用、checksum 不符、半途坏步骤；全量 vitest 中该文件通过。 |
| G1-02 迁移中途杀可重入 | ev-g14（G-14.md） | 支持。重跑只补 [902]，`schema_migrations=[1,2,3,901,902]`，表 13→15；integration G-14 断言相同内容。 |
| G1-03 进程杀不丢已提交事件 | ev-g02（G-02.md） | 支持。COMMIT 后、投递前杀，恢复后事件仍在，按 fromSeq 重放拿回 1 条；integration G-02 断言 `evt_committed` 与 `inject.g02`。 |
| G1-04 备份独立目录行数与哈希一致 | ev-backup（`tests/backup.spec.ts`） | 支持。6 例覆盖 manifest、逐表 rows/sha、db_sha256、restore；全量 vitest 中该文件通过。 |
| G1-05 损坏备份可检出 | ev-g15（G-15.md） | 支持。截断备份后 verifyBackup 检出，restore 被拒，线上库未变；integration G-15 与 backup.spec 双重覆盖。 |
| G1-06 认证拒匿名写 | ev-auth（`tests/auth.spec.ts`） | 支持。12 例覆盖 /health 免认证、缺/错密钥 401、匿名 POST /v1/ledger/events 401、actor 由密钥推导；全量 vitest 中该文件通过。 |
| G1-07 阶段开关拒未知值 | ev-phase（`tests/config.spec.ts`） | 支持。11 例覆盖未知 phase、未知顶层/嵌套键、越界配置、坏 JSON；全量 vitest 中该文件通过。 |
| G-01 事务 COMMIT 前杀进程 | ev-g01（G-01.md） | 支持。COMMIT 前杀，前后 events 均为 1，未提交事务不留半条记录；integration G-01 断言 `未提交事务不留半条记录：true`。 |
| G-02 COMMIT 后未投递被杀 | ev-g02（G-02.md） | 支持。同上，事件可重放，总条数 2。 |
| G-08 长事务期间读不被拖死、写报 busy、队列溢出报 503 | ev-g08（G-08.md） | 支持，但证据链有缺口。G-08.md:20 有“读路径返回 1 条”“第二个写者报 busy：true”“队列溢出码：SERVICE_UNAVAILABLE”；HTTP 503 与 warning 由 `tests/write-queue.spec.ts` 覆盖，但该文件未列入 evidence-index，G-08.md 本身不展示 503。 |
| G-09 订阅者离线重放 | ev-g09（G-09.md） | 支持。重放 seq=2,3,4，连续无断号；integration G-09 断言 `连续无断号：true`。 |
| G-14 迁移一半杀后重跑 | ev-g14（G-14.md） | 支持。只补 [902]，第一步不重复；integration G-14 断言 `重跑只补了 [902]` 与 schema_migrations。 |
| G-15 备份截断能检出、恢复被拒、线上库不变 | ev-g15（G-15.md） | 支持。与标题一致，integration G-15 断言三个关键短语；G-15.md:3 的绝对临时路径见不阻断项。 |

13 项的证据都在 HEAD 内，且每项都能在代码或测试中找到对应路径；没有“只写 pass、没有可验证内容”的项。12/13 的证据哈希与 G1.md 表内值一致；`ev-gatecheck` 因 f68e836 改动 `tests/gate-check.spec.ts` 而失配，属当前记录过期。

## 四、验收命令实测

### 4.1 类型检查

```
D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit
exit 0，无输出
```

### 4.2 全量测试

```
D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run
Test Files  1 failed | 31 passed (32)
Tests       9 failed | 272 passed (281)
exit 1
```

9 个失败全部在 `tests/gate-check.spec.ts`，首例是“G1 门记录通过”，其余 8 例因同一个前置错误没有走到各自的断言：

```
AssertionError: expected [Function] to throw error matching /…/ but got
'审计报告结论与门记录结论不符：报告=fail，门记录=pass'
（scripts/gate-check.ts:449）
```

根因是 G1.md 仍锚 `docs/audits/S1-independent-audit.md`（结论 fail），而 G1 记录写 conclusion=pass；`checkAuditAnchor` 在 `checkEvidence` 与 `checkCandidate` 之前执行，所以先报这一条。G1 重签为 pass 报告后，这 9 例应恢复；本轮未改 G1，未实测重签后的结果。

### 4.3 证据哈希

从 HEAD 字节按 LF 归一重算，13 份中 12 份与 G1.md 表内值一致：ev-auth、ev-backup、ev-chain、ev-epoch、ev-g01、ev-g02、ev-g08、ev-g09、ev-g14、ev-g15、ev-migrate、ev-phase。唯一不一致：

| 证据 | 文件 | G1.md 记录 | HEAD 实际 |
| --- | --- | --- | --- |
| ev-gatecheck | `tests/gate-check.spec.ts` | `c61262506e81f9bfb89f00afc55662a18a722ed1ed447f9dd8220f88ab8f93b2` | `66660a9f726f185f8c50a01f85db48c97aa788140fb6fa5ba014c5c510d8e17b` |

按 `canonicalJson` 重算的 `evidence_index_hash` 是 `832bbcde665083a2c38d1f0cd1c0fc8441c2ac3f88e8a7b568fc0c6f0a616548`，G1.md 记录为 `fad4d531d22eef2968c6b7d5dce997f46162fa9fda12a98b1abf1aa6640a8d07`。`artifact_hash` 与 `body_hash` 重算仍与锚一致（因为 G1.md 自身字节未变）。

### 4.4 候选哈希

用 `gate-check.ts` 的 `candidateEntries` 对 `623939d..HEAD` 重算：候选文件 88 个，`candidate_hash=9e3355548433e279e752455d4091be25e24585b75c4052a786a3b6b5ee9f81c7`，`change_scope_hash=6fd86967e246b970edc591dd173282e8dc9e1c0ffbd9935302bb19be21bd560b`。G1.md 记录为 `bbd322cf9d4ef5fb44a836ac8fd6edeb56b7c95ad34d1f80f29fe349fc4cc69e` / `ea15eaba761c24c70ff1b724251b125c65fc9ba17f15f4bdb1dfc35ff646f4fb`，均不一致。

### 4.5 门检查

```
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md
门检查失败：审计报告结论与门记录结论不符：报告=fail，门记录=pass
exit 1
```

这是当前 G1 记录的真实状态，不是本轮修改造成。按代码顺序，修掉审计锚后，下一条会先命中 `ev-gatecheck` 的哈希不符，再命中 `candidate_hash` / `change_scope_hash` 不符；三个问题都指向同一件事：G1 需要在新 HEAD 重签。G2 当前也因锚 S2 round5 fail 报告而 exit 1，属 S2 范围，本轮不判。

## 五、新发现问题

### 5.1 重大：证据 id 到文件没有固定映射，换绑文件后重签仍可过门

位置：

- `scripts/gate-check.ts:59-73` 的 `GATE_SPECS.G1.evidenceMap` 只固定“必过项 → 证据 id”，没有固定“证据 id → 文件”。
- `scripts/gate-check.ts:399-408` 的 `checkEvidenceMap` 只比较 `item.evidence_ids` 与 `want`；它不读 evidence-index 的 `file`。
- `scripts/gate-check.ts:214-239` 的 `checkEvidence` 对 evidence-index 当前写的 `file` 取 HEAD 字节并重算哈希；`checkBodyEvidenceTable`（318-336）只把正文表与 evidence-index 对齐。
- `scripts/sign-gate.ts:27-41` 也是按 evidence-index 里的 `file` 重算并改写哈希，没有固定文件校验。

可复现路径（静态构造，受审计约束未改原门记录）：

1. 把 evidence-index 中 `ev-g15` 的 `file` 从 `docs/gates/evidence/G1/G-15.md` 改成 `docs/gates/evidence/G1/G-01.md`，正文证据表的文件列同步改。
2. 运行 `sign-gate.ts`；它按新文件重算 sha256，改写正文表、evidence-index、`evidence_index_hash`、`artifact_hash`、`body_hash`。
3. `checkEvidenceMap` 仍通过，因为 G1-05 与 G-15 的 `evidence_ids` 仍是 `ev-g15`；`checkEvidence` 通过，因为 G-01.md 的哈希与新记录一致；正文表也一致。
4. 结果是 G1-05“损坏备份可检出”和 G-15“备份截断能检出”都拿 G-01（未提交事务）当证据，门检查仍 pass。

影响：门检查能发现“文件内容被改但哈希没重签”，但发现不了“把证据 id 指向另一个 HEAD 文件后重签”。这与 `checkEvidenceMap` 上方注释“换绑证据重签会被挡住”不符；`tests/gate-check.spec.ts:128-135` 只改了 `evidence_ids`，没有改 evidence-index 的 `file`，所以测不到这条路径。

建议：在 `GateSpec` 增加固定的 `evidenceFiles`（id → 仓库路径），`checkEvidenceMap` 同时核对 evidence-index 的 `file`；补一条“改 evidence-index 的 file 后应报错”的测试。这样才真正满足“每项都有固定证据映射”。

### 5.2 重大：审计锚只校验路径轮次与结论正则，不绑定报告字节，也不限制在 docs/audits

位置：`scripts/gate-check.ts:428-451`。

- `auditConclusionOf` 用正则从报告文本里找“结论：pass/fail/通过/不通过”，没有报告哈希。
- `checkAuditAnchor` 只要求 `audit_report` 在 HEAD、路径含 `round(N)` 时轮次一致；没有要求路径以 `docs/audits/` 开头，也没有把报告内容纳入 `candidate_hash` 或 `body_hash`。
- G1.md 自身第 5 行就是“结论：**pass**”。把 `audit_report` 改成 `docs/gates/G1.md`、`audit_round` 保持 1，重签 `artifact_hash` / `body_hash` 后，`checkAuditAnchor` 会把门记录本身当成审计报告并通过。
- 同理，新建 `docs/gates/G1-round2.md`，只写“结论：pass”，再把 `audit_report` 指向它，也能通过；`docs/gates` 在 candidate 的 excludes 里，不会进 `candidate_hash`。
- 报告字节不在任何哈希里，签完之后改报告正文（例如把一份真报告替换成另一份同样含“结论：pass”的文本）不会被门检查发现。

影响：审计锚只能证明“HEAD 里有一个含 pass 结论的文件”，不足以证明它是独立审计报告，也不足以证明签门时的报告内容就是现在的内容。这正好是可被用来把 pass 门记录挂到非审计文件上的结构缺口。

建议：`checkAuditAnchor` 要求 `audit_report` 以 `docs/audits/` 开头，并增加 `audit_report_sha256` 字段（对 HEAD 报告按 LF 归一后重算），在 artifact 与正文中都校验；补两条测试：指向 G1.md 自身应报错，签后改报告字节应报错。

### 5.3 不阻断：G-08 证据只到模块级，503 与 warning 未进入 evidence-index

`docs/gates/evidence/G1/G-08.md:20` 只有“读路径返回 1 条”“第二个写者报 busy：true”“队列溢出码：SERVICE_UNAVAILABLE”，没有 HTTP 503，也没有 warning 文本。`scripts/fault-inject.ts:203-244` 的 `caseG08` 直接 `new WriteQueue(2)`，没有经过 `startServer`。服务级 503 与 warning 已由 `tests/write-queue.spec.ts:20-49` 覆盖，但该文件不在 G1 的 evidence-index 里；`tests/integration/g1.spec.ts:22-26` 也只断言 busy 与错误码，没有断言 `readOk`。

结论：G-08 的生产路径已经接上，M2 闭合；但 G1 的 G-08 证据链不完整。建议把 `tests/write-queue.spec.ts` 加入证据索引并映射到 G-08，或让 G-08 走真实 HTTP 入口重生成，附 503 与 warning。

### 5.4 不阻断：G1.md:205 的 `<tmp>` 声明与 G-15 证据不一致

G1.md:205 写“证据参数里的临时目录统一写成 `<tmp>`”，但 G-15.md:3 仍保留 `C:\Users\ASUS\AppData\Local\Temp\orchestra-g1-UPjRtV\backup-g15`。根因在 `scripts/fault-inject.ts:78`：`JSON.stringify` 的 replacer 只把 `key === 'db'` 替换成 `<tmp>/orchestra.db`，`backup` 键没有替换。建议把 replacer 扩展到 `backup` 等临时路径，重生成 G-15 后重签；这不影响 G-15 的机制结论，但门记录里的声明应与证据一致。

### 5.5 观察（不计入）：body_hash 掩码所有反引号 64 位十六进制

`bodyHashInput`（378-384）把所有反引号包裹的 64hex 都替换成占位符，因此正文中任何未被其他检查交叉核对的这类哈希都不受 `body_hash` 保护。当前 G1 的证据表哈希、artifact 哈希、invariants 哈希都有独立核对，没有实际缺口；但后续门记录若新增自由哈希，这条掩码会偏宽。建议只掩码自锚点，或对正文中每个 64hex 都建立独立核对。

### 5.6 观察（不计入）：GATE_SPECS 与门检查同仓同候选，没有外部信任根

`GATE_SPECS` 在 `scripts/gate-check.ts:41-105`，而 `scripts/gate-check.ts` 本身在候选范围。改 `items` 或 `evidenceMap` 后重签，`candidate_hash` 会变，但门检查没有独立于候选的 spec 锚；一个能改源码并重签的人可以让任意清单通过。当前 G1 的 13 项与 spec 一致，且 `verifyGateRecord:515-518` 会拦住门记录里的清单截短；这条属于信任根限制，不是本轮实际缺口。若要更强的保证，可把 spec 的哈希写进人工批准的 release 记录或独立配置文件，并在门检查中比对。

## 六、当前 G1 记录状态与重签

G1.md 当前记录：

- 候选行 `10abcaa2dfc8b81a4a2d11f499839c7896042d06`；HEAD 是 `f68e836471e820355bc23b3bcce2f8a7e345b1bf`。
- `candidate_hash` 记录 `bbd322…`，HEAD 重算 `9e3355…`；`change_scope_hash` 记录 `ea15ea…`，HEAD 重算 `6fd869…`。
- `evidence_index_hash` 记录 `fad4d5…`，HEAD 重算 `832bbc…`；`ev-gatecheck` 记录 `c61262…`，HEAD 实际 `66660a…`。
- `audit_report` 指向 `docs/audits/S1-independent-audit.md`，该报告结论是 fail；G1 记录结论是 pass。`gate-check` 因此 exit 1，9 个 gate-check 用例随之失败。

结论：当前 G1 记录在 HEAD 不自洽，门检查红灯是正确的，不应用改门记录的方式绕过。上述 5.1 与 5.2 两项重大修复后，需要做第三轮独立审计；只有第三轮报告结论为 pass，才能把 G1 的 `audit_round` 改为 3、`audit_report` 指向第三轮报告，先提交报告，再运行 `sign-gate.ts` 重签。

本轮报告结论是 fail，按 `checkAuditAnchor` 只能与 fail 门记录匹配，因此不构成 G1 的 pass 审计锚；本轮报告也不构成 pass 的 G1 审计依据。这正是审计锚应有的行为。

## 七、总评

原 S1 的 F1、M4、M3、M2、M5 五项均已从机制上闭合，G1 的 13 项也都有 HEAD 内证据、测试或真实注入记录支撑；G-15 的证据与标题已经一致，G-08 的生产写路径已经接上。当前红灯主要来自 G1 记录过期，而不是原五项回退。

但门检查仍有两个结构缺口：证据 id 到文件没有固定映射，换绑文件后重签仍可过门；审计锚不绑定报告字节、也不限制在 docs/audits，门记录自身就能被当成“pass 报告”。这两项都能让一个缺乏真实证据或真实审计的门记录通过门检查，属于重大。按本轮判定口径，结论为 **fail**。
