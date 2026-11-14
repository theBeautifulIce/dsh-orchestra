# S1 独立审计报告 · 第 56 轮（G1）

门：G1
候选提交：af3970b35aadd38f1dc79fa88f631ae55f0f1fc1
审计轮次：56
审计时间：2026-11-14 22:48–23:10（Asia/Shanghai）
审计方式：独立只读审计；在系统临时目录建 detached worktree 检出候选，审计结束即删除；未改动原工作树、未提交、未签门
候选范围：623939d..af3970b 的 src、tests、scripts 与证据；排除 `docs/gates/G1.md`、`docs/gates/G2.md`、`docs/audits`、`docs/reviews`、`handoff.md`；证据文件计入候选
环境：Windows / node v26.13.1 / pnpm 12.3.4

审计摘要：结论 pass；P0=0、P1=0、P2=3；failed_items 为空；13 项必过项逐项实跑通过；上一轮对 e0f9650 提出的两条 P1，本轮在独立探针上复现为已处置。

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 56,
  "candidate_commit": "af3970b35aadd38f1dc79fa88f631ae55f0f1fc1",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 3,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": [
    "G1-01",
    "G1-02",
    "G1-03",
    "G1-04",
    "G1-05",
    "G1-06",
    "G1-07",
    "G-01",
    "G-02",
    "G-08",
    "G-09",
    "G-14",
    "G-15"
  ],
  "failed_items": [],
  "notes": "wait/subworkflow 唤醒收口与纯控制节点终态两条 P1 已处置；P2：M-64 前提旁路、auditConclusionOf 历史表格缺豁免、G1 记录锚在第 51 轮"
}
```
<!-- audit-verdict:end -->

## 一、结论

结论：pass

13 项必过项逐项实跑通过，P0=0、P1=0、P2=3，failed_items 为空。上一轮 S1 第 55 轮对 e0f9650 的两条 P1 都在本候选上复现为已处置：wait / subworkflow 控制节点在唤醒、超时、取消、子流程终结四条路径上都会把 run 收口，run 终态按子 run 结果落 done、superseded 或 cancelled，不再长期停在 running；控制节点建行即标 `side_effect_policy='pure'`，`closeRun` 的副作用判据不再把纯控制节点算进待核范围，终态不再落到 succeeded_with_unverified。三条 P2 分别是 M-64 的 requires 在合并规则下不参与校验（纵深防御）、报告解析器 `auditConclusionOf` 的表格分支缺少历史轮次豁免、以及 G1 记录仍锚在第 51 轮（`gate-check` 因此退出 1，重签即消除）。

## 二、实测命令

| 命令 | 退出码 | 输出摘要 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc --noEmit` 无输出 |
| `pnpm test` | 0 | 61 个测试文件，852 passed / 1 skipped（853），11.28s |
| `pnpm build` | 0 | tsdown；ESM `lib/index.js` 250.29 kB（gzip 59.95 kB），`lib/index.d.ts` 18.05 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 25 份证据各重跑两遍，均与 HEAD 字节一致 |
| `pnpm vitest run`（9 个 G1 相关文件） | 0 | 9 个文件，325 passed / 1 skipped（326），3.25s |
| `pnpm vitest run`（G1 证据 7 文件） | 0 | 7 个文件，61 passed（auth 12、backup 6、hash-chain 8、db-open 9、migrate 9、config 11、g1 6） |
| `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` | 1 | 审计报告 sha256 与记录不符（见 P2-3） |
| `node --no-warnings tmp/probe-r56.ts` | 1 | 12 项收口/取消/子流程/兜底闸探针，11 项符合预期，第 12 项命中 P2-1 |
| `node --no-warnings tmp/probe-r56b.ts` | 1 | 10 项收口边界与幂等探针，8 项符合预期，2 项是围栏设计的运行中状态 |
| `node --no-warnings tmp/probe-r56c.ts` | 1 | 7 项 `proseVerdictClashes` 探针，6 项符合预期，第 1 项由 `auditConclusionOf` 兜住 |
| `node --no-warnings tmp/probe-r56d.ts` | 1 | 6 项 `auditConclusionOf` 探针，5 项符合预期，第 5 项命中 P2-2 |

探针在临时 worktree 内运行，随 worktree 一起删除；它们覆盖的行为在 af3970b 新增或改动的 `tests/integration/{run-close,subworkflow,sweep,wait}.spec.ts` 与 `tests/unit/execution-scheduler.spec.ts` 里有对应用例，全量 `pnpm test` 已一并跑过；P2-1 与 P2-2 的最小复现代码见附录 A、B。

gate-check 原文：

```text
门检查失败（docs/gates/G1.md）：审计报告 sha256 与记录不符（报告改过就重新审计再签）：355a1a582b5584c0… != e3eee74611c3a681…
```

## 三、必过项逐项结论

| 必过项 | 复核内容 | 结果 | 依据 |
| --- | --- | --- | --- |
| G1-01 | 空库迁移可重复，账本无重复记账 | pass | ev-migrate；`migrate.spec.ts` 全过 |
| G1-02 | 迁移中途杀进程后可重入 | pass | ev-g14；`check-evidence-repro` 重跑字节一致 |
| G1-03 | 进程被杀不丢已提交事件 | pass | ev-g02；证据重放拿到 seq=2 |
| G1-04 | 备份独立目录行数与哈希一致 | pass | ev-backup；`backup.spec.ts` 全过 |
| G1-05 | 损坏备份可检出 | pass | ev-g15；截断检出 |
| G1-06 | 认证前置，匿名写返回 401 | pass | ev-auth；`auth.spec.ts` 全过 |
| G1-07 | 阶段开关未知值返回 SCHEMA_VERSION_UNSUPPORTED | pass | ev-phase；`config.spec.ts` 全过 |
| G-01 | COMMIT 前杀进程不留半条记录 | pass | ev-g01；未提交事务计数 0 |
| G-02 | COMMIT 后未投递被杀可重放 | pass | ev-g02；总条数 2 |
| G-08 | 长事务读不阻塞、第二写者 busy、队列溢出 503 | pass | ev-g08；对账行通过 |
| G-09 | 订阅者离线重放无断号 | pass | ev-g09；连续无断号 |
| G-14 | 迁移一半杀后重跑只补一步 | pass | ev-g14；schema_migrations 表对账一致 |
| G-15 | 截断备份可检出、恢复请求被拦下、线上库不变 | pass | ev-g15；线上库未变 |

## 四、六项必查的复核结果

### 4.1 两条入口共用同一个调度闸，兜底闸仍有并发上限

`src/service/server.ts:255` 的 `/v1/runs/dispatch` 调 `deps.commands.dispatch`，`:298` 的 `/v1/node-runs/run` 调 `deps.commands.runNode`。两个命令最终都走 `src/index.ts:111-112` 的同一个 `executeScheduled`：dispatch 在 `:211` 把 `executeNode: executeScheduled` 交给 `dispatchRun`，runNode 在 `:224` 直接调用它。`src/service/dispatcher.ts:3` 的注释与 `:56-72` 的实现都表明 dispatcher 不再持有 scheduler，只处理 queued 节点，不会二次排队占名额。

兜底闸在 `src/service/execution-scheduler.ts:234`：模块级 `const fallbackScheduler = createExecutionScheduler()`，`:236` 改成 `(scheduler ?? fallbackScheduler).run(fn, opts)`；旧实现在没有 scheduler 时直接执行，等于没有上限，本轮已消除。三处验证都用真实并发数而不是调用次数：`tests/unit/execution-scheduler.spec.ts` 用 `DEFAULT_EXECUTION_CONCURRENCY + 3` 个任务断言 `maxActive === DEFAULT_EXECUTION_CONCURRENCY`；`tests/contract/execution-concurrency.spec.ts` 用上限 2 的真实 scheduler，从两条 HTTP 入口各发 3 个节点，断言 `started=6`、`maxActive=2`；我的探针在不传 scheduler 时并发 6 个任务，实测 `maxActive=3`。

### 4.2 `proseVerdictClashes` 同时覆盖散文与 Markdown 表格，历史行按轮次豁免

`scripts/gate-check.ts:1790-1878` 先按 `renderedAuditLines` 拆散文逐行判（`:1802`），再按 `tableIndex:rowIndex` 逐行分格判（`:1840-1870`）；`:1715-1735` 的 `historicalTableRows` 只在三种条件同时满足时豁免：行内没有「本轮 / 当前轮 / this round」标记、表头有轮次列（含 轮 / round / 审计 / 历史）、轮次数字严格小于 `auditRound`。探针 7 项：表格结论列取负值被点名、历史行（50 < 56）豁免、本轮行（56）被点名、历史行加「本轮」标记后不豁免、必过项 id 单格加相邻格否决被拆格规则拦下、溢出列被拦下、裁决取负值时不产生自相矛盾告警。单测侧 `tests/gate/gate-check.spec.ts` 的 `:1407`、`:1439`、`:1454`、`:1493`、`:1505`、`:1517`、`:1529`、`:1554`、`:1568`、`:1592` 覆盖了同一批边界。

### 4.3 门检查重算证据、清单与四个哈希，不只验自身字段

证据：`scripts/gate-check.ts:375-407` 对每份证据从 HEAD 取字节、按 LF 归一后重算 sha256，与 evidence-index 比对，id 必须在固定的 `evidenceFiles` 映射里且路径一致，缺 id 或路径漂移都报错；`evidence_index_hash` 由排序后的 canonicalJson 重算。不变量：`:409-449` 逐条比对 statement 与 evidence_ids 并重算 `invariants_hash`。候选：`:2575-2585` 从 `scopeBase..HEAD` 且排除范围里取文件重算 `candidate_hash` 与 `change_scope_hash`。门记录：`:2614-2697` 校验必过项清单等于 `spec.items`（顺序敏感）、`failed_items` 为空、`conclusion=pass`、`artifact_hash` 与 `body_hash` 从正文重算、审计报告 sha256 从 HEAD 字节重算、门记录必须在 HEAD 且与磁盘一致。实测 `check-evidence-repro` 退出 0；`gate-check` 退出 1 的首个报错点是审计报告哈希对不上，不是「只验自身字段」放行。

### 4.4 迁移只新增不改历史，M-64/M-65 的 requires 可达

`git show --stat af3970b` 里没有任何 `.sql` 变更，`src/infra/sqlite/migrations/001…021` 未动；`src/core/state-machine.ts` 只追加两个新 trigger（控制节点结束与取消两类）与 M-64、M-65 两行，既有 63 条迁移规则逐字未改，`MIGRATION_CASE_IDS` 顺序追加。`tests/integration/migration-cases.spec.ts` 用 68 个断言覆盖 65 个 id（`:27`）、每条规则的每个来源×目标（`:53`）、每条 requires 规则的反例（`:67`）、终态源的 `allowTerminal`（`:97`）。

可达性：`src/service/commands/wait.ts:136-151`（waiting→done）、`src/service/commands/subworkflow.ts:411-426`（waiting 到 done、superseded 或错误终态）、`src/service/commands/cancel.ts:78-109`（waiting→superseded）都在调用 `applyTransition` 时传 `controlCompletion: true`，探针实测三条路径都能落终态并收口 run。伪造性：M-65 是 waiting→superseded 唯一命中的规则，缺前提被拒（探针实测节点留在 waiting）；M-63 同样是单一命中；M-64 存在旁路，见 P2-1。

### 4.5 报告生成器不把测试结果自行转 PASS

仓库里没有生成门记录的脚本：`scripts/` 只有 `check-evidence-repro.ts`、`check-test-layout.mjs`、`fault-inject.ts`、`gate-check.ts`、`sign-gate.ts`。`scripts/sign-gate.ts` 只重算哈希字段（证据、索引、候选、前序门、审计报告、artifact、body），正文的 `conclusion` 与 `failed_items` 由审计者写，脚本不赋值；`src/service/commands/apply-report.ts:462-464` 的裁决由 `evaluatePassConditions(policy.passConditions, evidence.normalized)` 对报告证据字段求值，`src/core/policy.ts:100-110` 的 `mergePassConditions` 把模板条件当 mandatory baseline、节点只能 and 追加，测试输出文本不参与这条判定。

### 4.6 设计与记录正文无自相矛盾

`docs/gates/G1.md` 首部结论行是 pass、13 行必过项表全 pass、artifact 里 `conclusion` 也是 pass，三处一致；正文叙述的历史轮次（第 30、31 轮）与实际报告一致。单测覆盖表格分格、历史轮次豁免、拆格、溢出、隐藏注释、攻击行只豁免描述格。报告解析器这一侧有一处口径分叉（P2-2），记录与 HEAD 的锚定有一处滞后（P2-3），两者都不改变本候选的代码结论。

## 五、发现

**P2-1（纵深防御）合并规则让 M-64 的前提不参与校验。** `src/service/commands/nodes.ts:96` 只有「命中的规则全部带 requires」时才校验 context；控制节点从 waiting 迁到错误终态时同时命中 `src/core/state-machine.ts:167` 的 M-64（requires `controlCompletion`）与 `:195` 的 M-48（NON_TERMINAL 到错误终态，无 requires），`every()` 为 false，M-64 的前提因此被跳过。复现：把附录 A 存为 `tmp/probe-m64.ts` 后执行 `node --no-warnings tmp/probe-m64.ts`，退出 1，打印行显示 threw=false、节点已迁到错误终态。影响：控制节点可被内部调用推离 waiting 而不带控制节点完成标记；生产路径 `src/service/commands/subworkflow.ts:411-426` 始终传 true，当前只有内部调用才走得到这里。建议把 `applyTransition` 改成「每个命中的带 requires 规则逐条校验」，或给 M-48 补上 requires。

**P2-2（报告解析口径分叉）`auditConclusionOf` 的表格分支没有历史轮次豁免。** `scripts/gate-check.ts:1628-1700` 对散文先做 `stripHistoricalAuditSentence`，对表格行没有对应处理；而 `:1715-1735` 的 `proseVerdictClashes` 有完整豁免。复现：把附录 B 存为 `tmp/probe-b.ts` 后执行，输出 null、退出 1（本候选实测即如此）。影响：带历史失败表格的合法 pass 报告在签署时会被判成结论无法确定（fail-closed，挡住合法报告，不放过坏报告）；两个单测 `tests/gate/gate-check.spec.ts:1407`、`:1439` 只调 `proseVerdictClashes`，`auditConclusionOf` 这一侧没有对应用例。建议让 `auditConclusionOf` 的表格路径复用 `historicalTableRows`。

**P2-3（记录锚点滞后）G1 记录仍锚在第 51 轮。** `docs/gates/G1.md` 的 `audit_round: 51`、`audit_report: docs/audits/S1-independent-audit-round51.md`、`audit_report_sha256=355a1a58…`，而 HEAD 上该报告字节哈希是 `e3eee746…`；evidence-index 里 `ev-g14` 记的是 `ec2b935d…`，HEAD 上 `docs/gates/evidence/G1/G-14.md` 是 `c1da5460…`。复现：`node scripts/gate-check.ts docs/gates/G1.md` 退出 1，输出即第二节引用的那一行；审计时把 13 份证据逐个重算 sha256 与记录里的 evidence index 比对，只有 ev-g14 一处滞后（对 `docs/gates/evidence/G1/G-14.md` 重算 sha256 即可复核）。这两处都早于本轮代码（ev-g14 在更早的提交被重生成），重签会重算报告哈希、证据哈希与候选锚点，P2-3 随重签消失。

其他观察（不计入 P2）：`src/core/state-machine.ts:142` 与 `:256` 的注释仍写「M-01…M-63」，规则已到 M-65，属陈旧注释；`src/service/commands/wait.ts:293` 的唤醒路径无条件调 `closeRun`，半截收口靠 `src/service/commands/run-close.ts:39` 的节点守门挡住（探针 B 已实测另一节点在跑时 run 保持 running）；`src/service/sweep.ts:350-351` 每轮扫全部 running run，当前量级没问题，量大时可加索引或批处理。

## 六、结论与建议

本轮候选可以重签 G1。上一轮两条 P1 已在独立探针上复现为已处置，13 项必过项逐项实跑通过，六项必查全部落到源码行与实测证据上。重签步骤：先把本报告与另两份第 55 轮报告提交；改 `docs/gates/G1.md` 的 `audit_round=56` 与 `audit_report=docs/audits/S1-independent-audit-round56.md`；跑 `node --no-warnings scripts/sign-gate.ts docs/gates/G1.md`（会重算 ev-g14、审计报告 sha 与候选锚点）；再跑 `node scripts/gate-check.ts docs/gates/G1.md` 与全量 `pnpm test`。P2-1、P2-2 记为后续整改项，不落在 13 项必过项上，不阻塞本次重签。

## 七、附注：审计期间原工作树的并发改动

本报告的结论只覆盖候选 `af3970b`。审计收尾时，原工作树 `D:\aboutAI\dsh-orchestra` 上出现了与本候选无关的未提交改动（写成报告时已见 `M src/service/commands/cancel.ts`、`M src/service/commands/subworkflow.ts`、`M src/service/dispatcher.ts` 与 `M tests/integration/cancel.spec.ts`、`M tests/integration/subworkflow.spec.ts`，另有未跟踪的 `docs/audits/S2-independent-audit-round56.md`、`docs/audits/S3-independent-audit-round8.md`），且这批改动仍在继续。这些内容不在 `af3970b` 的树里（本次审计在 detached worktree 上进行，那里 `git status` 为空），因此不参与本次判定。若要把它们并进同一次重签，请先单独提交，再重新审计并重新签门：`scripts/sign-gate.ts` 开头的 `assertClean` 也要求工作树干净。

## 附录 A：M-64 前提旁路的最小复现

放进 `tmp/` 后执行 `node --no-warnings tmp/probe-m64.ts`，退出码 1 表示旁路仍在。

```ts
import { openDb, withTx } from '../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../src/infra/db/migrate.ts'
import { applyTransition } from '../src/service/commands/nodes.ts'

const NOW = '2026-11-14T12:00:00.000Z'
const d = openDb(':memory:')
applySteps(d, loadSteps(defaultMigrationsDir()))
withTx(d, (tx) => {
  tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1','x','running',1,?,?)", [NOW, NOW])
  tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1','t1','running',1,?,?)", [NOW, NOW])
  tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, side_effect_policy, created_at, updated_at) VALUES ('n1','r1','n1',1,'wait',1,'waiting',1,'pure',?,?)", [NOW, NOW])
})
let threw = false
withTx(d, (tx) => {
  try {
    applyTransition(tx, { nodeRunId: 'n1', from: ['waiting'], to: 'failed', attempt: 1, now: NOW, context: { hasToolCall: false, cancelResult: null, hangReason: null, sideEffectVerifiedNone: true, controlCompletion: false } })
  } catch { threw = true }
})
const status = (d.raw.prepare("SELECT status FROM node_runs WHERE node_run_id='n1'").get() as { status: string }).status
console.log('threw=' + threw + ', node=' + status)
process.exit(threw && status === 'waiting' ? 0 : 1)
```

## 附录 B：`auditConclusionOf` 历史表格行复现

```ts
import { auditConclusionOf } from '../scripts/gate-check.ts'
const text = '审计结论：pass\n\n| 轮次 | 项 | 结论 |\n| --- | --- | --- |\n| 50 | G1-01 | 未通过 |\n'
console.log(auditConclusionOf(text))
process.exit(auditConclusionOf(text) === 'pass' ? 0 : 1)
```
