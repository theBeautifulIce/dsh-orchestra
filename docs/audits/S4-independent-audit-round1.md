# S4 独立审计 · 第 1 轮（4e751de）

门：G4
候选提交：4e751de6cf8fb681e7b7c4f40061400cabab0408

结论：fail（P0 0 项、P1 2 项、P2 1 项；必过项 13/14，G4-13 失败）。

按《工程可靠性收敛审计规范》第十节第 6 条口径即「未通过」：S4 的业务实现（两层校验、四命令、发布事务、幂等、task_local 归属、依赖闭包、HTTP 六入口）经代码走查与全量实测成立，13/14 必过项通过；但 G4-13「S4 全量测试与构建全绿」的证据在候选上不可复现——`pnpm typecheck` 确定性失败 11 处，且 `docs/gates/evidence/G4/full-suite.md` 声称的 `typecheck exit 0` 与 build 体积与实测不符（P1-1）。另有 P1-2：带拓扑的 run 里 `readinessOf` 前置判定有两个缺口（换 attempt 后读到旧 `superseded` 行、前置非成功终态无处置），后置节点没有任何收口出口，run 永停 `running`，只能人工取消兜底；兜底后 `runs.status` 只能落 `cancelled`，业务失败只能从 `run.terminal` 事件的 `outcome` 字段读出。两个 P1 修复并换候选复验前，G4 不具备签发条件。

## 一、审计基准

| 项 | 值 |
| --- | --- |
| 主线 HEAD | `4e751de6cf8fb681e7b7c4f40061400cabab0408`（与候选同一提交，工作树干净，候选之后无代码变动） |
| 本轮候选提交 | `4e751de6cf8fb681e7b7c4f40061400cabab0408`（`test(s4): pin the event type in the missing-pred defence case`，父 `e9bd353`） |
| 检查范围 | `scripts/gate-check.ts` 的 `GATE_SPECS.G4`（scopeBase `9fbecdd`，排除 docs/gates 门记录自身、docs/audits、docs/reviews、handoff.md）：`src/core/workflow-doc.ts`、`src/service/commands/workflows.ts`、`src/service/commands/idempotency.ts`、`src/service/runs.ts`、`src/service/dispatcher.ts`、`src/service/commands/subworkflow.ts`、`src/service/server.ts`、`src/service/schemas.ts`、`src/index.ts` 装配层，及 `tests/**` 与 `scripts/check-evidence-repro.ts`、`scripts/fault-inject.ts` |
| 本轮变化 | S4 首轮正式审计，无上一轮报告；对 9fbecdd 之后 23 个提交的实现整体独立复核，不默认已修好 |
| 使用文档 | `审计要求.md`（§1/§4/§5/§6）、`GLOSSARY.md`、`docs/gates/G4.md`、`docs/gates/evidence/G4/{G-10.md,full-suite.md}`、`src/core/audit-verdict.ts`、`scripts/gate-check.ts` |
| 未能确认的范围 | SQLite 写锁等待与 busy 行为（G4-08 只证业务串行化，门记录措辞已如实限定）；S5 面板对 task_local 创建的可信上下文注入尚无实现，本轮只按服务层口径审 |
| 审计期间工作树变动 | 候选之后无新提交（HEAD 仍为 `4e751de`）；审计进行期间工作树出现针对本轮发现的在途未提交改动（`src/service/dispatcher.ts`、`tests/gate/gate-check.spec.ts`、`tests/integration/workflow-g4.spec.ts`、`docs/gates/G4.md` 等）。本报告全部实测与结论只对候选提交 `4e751de` 负责，在途改动属于候选之后的修复，须并入下一轮候选重新审计 |

## 二、已知历史问题复验

| 历史问题 | 状态 | 核验依据 |
| --- | --- | --- |
| task_local 生命周期闭环（预留 task → owner → 子流程派发继承） | 已修复并验证 | `src/service/runs.ts:51-68` 预留任务；`src/service/commands/workflows.ts:179-189` owner 必须是未消费预留任务；`src/service/runs.ts:151-167` 根入口禁起 + CAS 绑定预留（一个预留只消费一次）；`src/service/commands/subworkflow.ts:329` 子流程派发以父 run 的 task_id 过归属闸；用例 `tests/integration/workflow-g4.spec.ts:321`、`:403`、`tests/integration/workflow-commands.spec.ts:343`、`:395` 全绿 |
| HTTP 不接受自报 owner | 已修复并验证 | `src/service/schemas.ts:432-439` `workflowCreateCommandSchema` 无 `owner_task_id` 字段（注释明确不接受自报）；`src/service/server.ts:260-268` 不透传 owner；用例 `tests/contract/workflow-routes.spec.ts:105`（HTTP 建 task_local 必失败、UUIDv4 一律 400）全绿 |
| nodeIds 依赖闭包 | 已修复并验证（闭包与缺前置防御）；相邻缺口另立 P1-2 | `src/service/runs.ts:99-131` 缺前置拒建并列出缺谁；`src/service/dispatcher.ts:102-119`、`:151-154` 前置不在 run 里按 `SCHEMA_VERSION_UNSUPPORTED` 可观测失败；用例 `tests/integration/workflow-g4.spec.ts:444`、`:492` 全绿。但同一条依赖闸只处理了「前置行缺失」，「前置落到非成功终态」无收口出口，见 P1-2 |
| worker 屏障（G4-08 真并发） | 已修复并验证 | `tests/integration/workflow-g4.spec.ts:226-` 双 `worker_threads` 独立连接 + Atomics 屏障放行后同抢一张草稿，恰好一个成功；`docs/gates/G4.md:13` 措辞已如实限定「未单独验证 SQLite 写锁等待与 busy 行为」 |
| draftHash 旧数据兼容 | 已修复并验证 | `src/service/commands/workflows.ts:86-87`、`:303-307` changed 判定按当前文档重算、不信旧 stored hash；用例 `tests/integration/workflow-commands.spec.ts:355`（旧格式草稿 hash 兼容）全绿 |
| G4-06 双证据映射 | 部分修复 | `scripts/gate-check.ts:324` 固定映射 `['ev-g4-06','ev-g4-14']` 与 `tests/gate/gate-check.spec.ts:1750-1753` 钉住、`docs/gates/G4.md:24` 正文表已双证据；但 `docs/gates/G4.md:112-117` artifact 的 G4-06 仍只绑 `ev-g4-06`、`:195-267` evidence-index 缺 `ev-g4-14`，见 P2-1 |
| gate-check.spec 的 G4 注册测试 | 部分修复（引入回归） | `tests/gate/gate-check.spec.ts:1735-1761` 注册测试已加且运行时通过（vitest 不做类型检查）；但这些用例直接访问 `GATE_SPECS.G4`，在 `Record<string, GateSpec>` + `noUncheckedIndexedAccess` 下类型为 `GateSpec \| undefined`，`pnpm typecheck` 11 处报错，见 P1-1 |

## 三、实测命令与退出码

全部在候选工作树实跑；跑下列命令时工作树与候选提交一致（审计后期工作树出现未提交在途修复，见基准表，不影响本节数字）。

| 命令 | 退出码 | 实测结果 |
| --- | --- | --- |
| `pnpm typecheck` | 2 | 11 处 TS 错误，全部在 `tests/gate/gate-check.spec.ts:1737-1759`（TS18048 ×10、TS2532 ×1） |
| `pnpm test` | 0 | 78 files，1022 passed \| 1 skipped（1023），11.78s |
| `pnpm build` | 0 | ESM `lib/index.js` 344.38 kB / gzip 82.64 kB、`lib/index.d.ts` 26.10 kB；CJS `lib/client.js` 0.29 kB；复跑一次体积一致 |
| `pnpm vitest run`（workflow-doc-save / workflow-doc-publish / operation-id / workflow-commands / workflow-g4 / workflow-routes / gate-check 七个指定文件） | 0 | 7 files，250 passed \| 1 skipped |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 证据复现成立：29 份，每份重跑两遍都与 HEAD 字节一致（含 G3/G4 注入摘要） |
| `node --experimental-strip-types scripts/fault-inject.ts --case G-10 --out tmp/g10-verify-{a,b}`（两遍） | 0 | 两遍输出递归 diff 无差异（md5 `759e854e…` 一致）；归一化后与 `docs/gates/evidence/G4/G-10.md` 正文一致（仅差 repro-sha256 摘要行）；tmp 探针已删 |
| `node --no-warnings scripts/gate-check.ts docs/gates/G4.md` | 1 | 预签态下被 P2-1 拦住：`必过项 G4-06 的证据与固定映射不一致（换绑证据不许重签）：ev-g4-06 != ev-g4-06,ev-g4-14` |
| `node --experimental-strip-types tmp/s4r1-probe-pred-failed.ts`（审计探针，已删） | 0 | P1-2 复现：a→b 链 a 落 `failed` 后 dispatch 两轮 + sweep 一轮，`a:failed,b:queued,run:running` 不变、outcomes 为空；cancelRun + sweep 后 `b:superseded,run:cancelled` |

full-suite.md 声称的 `78 files，1022 passed | 1 skipped` 与 `check-evidence-repro 29/29` 属实；`typecheck exit 0` 与 `lib/index.js 343.00 kB、gzip 82.29 kB` 与实测不符（P1-1）。

## 四、必过项 14 项

| 编号 | 结果 | 依据 |
| --- | --- | --- |
| G4-01 | pass | `tests/integration/workflow-commands.spec.ts:45-96`（命令路径 404、草稿分流）、`tests/integration/workflow-g4.spec.ts:103`（based_on_version 断言）实跑全绿 |
| G4-02 | pass | `tests/integration/workflow-g4.spec.ts:87`（已消费草稿优先 DRAFT_NOT_OPEN）、`tests/integration/workflow-commands.spec.ts:372`（changed=false）实跑全绿 |
| G4-03 | pass | `tests/unit/workflow-doc-save.spec.ts`（id/边/坐标/标题/名称/自环/重复边/超限拒绝码）实跑全绿 |
| G4-04 | pass | `tests/unit/workflow-doc-publish.spec.ts`（子流程 pin 已发布版本、深度 2、成环拒）实跑全绿 |
| G4-05 | pass | `tests/integration/workflow-g4.spec.ts:54`（在途 run 固定旧版本）、`:122`（版本行不可变）实跑全绿 |
| G4-06 | pass | `tests/integration/workflow-g4.spec.ts:321`、`:403`（预留→owner→绑定起 run 闭环、二次绑定 STALE_GENERATION）、`tests/integration/workflow-commands.spec.ts:343`、`:395`（owner 成对与真实性、根入口禁起）、`tests/contract/workflow-routes.spec.ts:105`（HTTP 不接受自报 owner）全绿；证据双映射的门记录绑定缺口见 P2-1 |
| G4-07 | pass | `tests/integration/workflow-commands.spec.ts:98`（插版本、上调 current_version、消费草稿、写事件同笔）、`:243`（失败整笔回滚、inbox 不留 running）、`:206`（重放拿原回执）全绿 |
| G4-08 | pass | `tests/integration/workflow-g4.spec.ts:227`（双 worker 真并发抢一张草稿，恰好一个成功，失败方业务冲突）全绿 |
| G4-09 | pass | `tests/integration/workflow-g4.spec.ts:54`（旧 run 固定 v1、新 run 用 v2）全绿 |
| G4-10 | pass | `tests/unit/workflow-doc-save.spec.ts`（保存层结构性拒）与 `tests/unit/workflow-doc-publish.spec.ts`、`tests/contract/workflow-routes.spec.ts:150`（发布层全量图语义拒、错误带 path）全绿 |
| G4-11 | pass | `tests/integration/workflow-g4.spec.ts:122`、`:54`（版本不可变与 run 固定两条一起断言）全绿 |
| G4-12 | pass | `tests/contract/workflow-routes.spec.ts:51`、`:59`、`:88`、`:105`、`:125`、`:150`（六入口与 UUIDv7 幂等协议）、`tests/unit/operation-id.spec.ts` 全绿 |
| G4-13 | fail | `pnpm typecheck` 退出 2（11 处 TS 错误）；`docs/gates/evidence/G4/full-suite.md:5`、`:10` 声称的 `typecheck exit 0` 与 build 体积 `343.00 kB / gzip 82.29 kB` 与实测（344.38 kB / 82.64 kB）不符；测试数与证据复现数属实，但「全量测试与构建全绿」在候选上不成立 |
| G-10 | pass | `docs/gates/evidence/G4/G-10.md` 的 repro-sha256 经 `check-evidence-repro` 29/29 核过；本轮双跑字节一致，在途 run 记 v1、新 run 记 v2，发布不影响在途 run |

## 五、P1（阻断）

| 编号 | 问题 | 位置 | 复现与影响 |
| --- | --- | --- | --- |
| P1-1 | `pnpm typecheck` 在候选上确定性失败 11 处，`pnpm check` 三步自检中断；且 G4-13 的证据 `full-suite.md` 声称 `typecheck exit 0`、`lib/index.js 343.00 kB / gzip 82.29 kB` 与实测（exit 2、344.38 kB / 82.64 kB）不符，证据在候选上不可复现 | `tests/gate/gate-check.spec.ts:1737-1759`（`GATE_SPECS.G4` 裸访问 ×11）；`scripts/gate-check.ts:53`（`Record<string, GateSpec>`）；`tsconfig.json`（`noUncheckedIndexedAccess`）；`docs/gates/evidence/G4/full-suite.md:5`、`:10` | `pnpm typecheck` → exit 2；`pnpm build` 复跑两次均 344.38 kB / 82.64 kB（确定性） |

影响：G4-13「S4 全量测试与构建全绿」无法按证据成立（13/14）；按《审计要求》§3 通用退出条件 8「不存在尚未解释的重大测试、构建或兼容性问题」，S4 不能收口。若按现状签门，ev-g4-13 的哈希将把「typecheck exit 0」的不实主张固化进门记录，违反 §4.4 证据门自洽。这是上一项历史修复（补 G4 注册测试）未经 `pnpm check` 全量验证引入的回归：vitest 不做类型检查，用例运行时通过掩盖了 tsc 失败。

修复建议：给 `tests/gate/gate-check.spec.ts` 的 `GATE_SPECS.G4` 访问加非空断言（或在 `scripts/gate-check.ts` 导出具名 `G4_SPEC` 常量），`pnpm typecheck` 归零后重跑 typecheck/test/build/check-evidence-repro 四命令，按实测更新 `full-suite.md` 的结果行与运行顺序（测试数 1022、证据复现 29/29 已核对一致可保留）。验证：`pnpm check` 三步全绿且 full-suite.md 每个数字都可复现。因改动落在候选范围内，须换候选重审。

| P1-2 | `readinessOf` 的前置状态判定有两个缺口，症状相同：带拓扑（edges）的 run 里后置节点永滞 `queued`、run 无法收口。面 A（旧挡新，S3 r21 P2-5b 同源）：M-60 换 attempt 后同一 `(run_id,node_id)` 有两行（旧行 `superseded` + 新行 `done`），候选查询 `.get()` 无 ORDER BY、无有效行过滤，稳定读到旧行，把已 done 的前置当成没跑；面 B（非成功终态无处置）：前置落到 `failed`/`timeout` 等非成功终态时后置只长等、不结算。closeRun 要求全节点终态，sweep 无 queued 清道夫，唯一出口是人工 run 级取消，取消兜底后 `runs.status` 只能落 `cancelled` 而非 `failed`（失败事实保留在 `run.terminal` 事件的 `outcome` 字段，但「按 failed 自动收口」这条正常路径不存在）。这是 S4「执行拓扑进定义」激活的真实路径，节点失败与重试换 attempt 都是常态场景，非极端条件 | 候选查询 `SELECT status FROM node_runs WHERE run_id = ? AND node_id = ?`（无 ORDER BY/有效行过滤，`git show 4e751de:src/service/dispatcher.ts` 的 `readinessOf`，工作树行号 `src/service/dispatcher.ts:106-118`）、`:144-155`（仅 missingPreds 走 `failQueuedNode`）；`src/service/commands/nodes.ts:253-280`（换 attempt 产生双行，旧行写 `replacement_node_run_id`）、`src/core/state-machine.ts:205`（M-60 作废旧行）；`src/service/commands/run-close.ts:42`（任一非终态节点即拒收口）；`src/service/sweep.ts:393-398`（只对 running run 调 closeRun，不清 queued） | 面 B 探针（`tmp/s4r1-probe-pred-failed.ts`，已删）：create/publish `t→a→b`、startRun、`a` 置 `failed` 后 `dispatchRun` 两轮 + `sweep` 一轮，终态 `a:failed,b:queued,run:running`、outcomes 为空；`cancelRun` + sweep 后 `b:superseded,run:cancelled`。面 A 数据层探针（`tmp/s4r1-probe-stale-row.ts`，已删）：旧行 `superseded` + 新行 `done` 时候选 `.get()` 10/10 读到 `superseded`，`ORDER BY attempt DESC` 读到 `done` |

影响：任何多节点拓扑 run 在节点失败、或前置经换 attempt 重试后，都会让 run 永久滞留 `running`，监控与收口全线失真——「run 停在 running 且没有自动出口」本身就足以定 P1（与 S3 第 9 轮 P1-1 同口径）。且缺「按 failed 自动收口」路径：正常收口本应在后置结算后由 closeRun 落 `failed`，如今只能人工取消兜底，`runs.status` 落 `cancelled`；业务失败事实在 `run.terminal` 事件的 `outcome` 字段仍可读（`src/service/commands/run-close.ts:80-90` 明确设计为「调用方判业务成败看 outcome，不看 runs.status」），但状态列与业务结果分离，按状态列读监控的调用方会漏判失败。违反《审计要求》§3 通用退出条件 6「重要异常路径有合理的失败处理与恢复策略」——该路径当前没有恢复策略。不在 14 项必过项覆盖内，但按门禁 `P0/P1=0` 的口径阻断重签。

修复建议：`readinessOf` 两个面一起修——(A) 前置按有效行判定（`ORDER BY attempt DESC` 取最大 attempt，或排除已被 `replacement_node_run_id` 接班的旧行），换 attempt 后按新行状态放行；(B) 区分「前置在途（继续等）」与「前置已到非成功终态（立刻结算后置）」，后者走既有 `failQueuedNode` 机制把后置节点收成终态（failed/superseded，带 `dispatch.failed` 事件与明确 error_code），或在 `dispatchRun`/sweep 里对「全部前置均为非成功终态」的 queued 节点统一结算。保持不变量：前置在途时后置仍不派发；缺前置防御（`SCHEMA_VERSION_UNSUPPORTED`）不受影响；run 失败后应能按 `closeRun` 收成 `failed` 而不是只能 `cancelled`。补两条用例（`tests/integration/workflow-g4.spec.ts` 防御面 describe）：「a failed → b 收终态留事件 → run 收口 failed」；「a 换 attempt 双行（旧行 superseded、新行 done）→ b 正常放行」。

## 六、P2（可延期，重签前须处理）

| 编号 | 问题 | 位置 | 复现与影响 |
| --- | --- | --- | --- |
| P2-1 | G4-06 双证据映射在门记录里只修了一半：正文表已写 `ev-g4-06, ev-g4-14`，但 artifact 的 `must_pass_items` G4-06 仍只绑 `ev-g4-06`、evidence-index 块缺 `ev-g4-14`（正文证据表 15 行 vs 索引 14 条）；`sign-gate` 与 `gate-check` 都会拒，G4 门按现状签不出来 | `docs/gates/G4.md:112-117`、`:195-267`（对照 `:24`、`:63`）；校验点 `scripts/gate-check.ts:671-678`、`:576-599`、`:522-553`；`scripts/sign-gate.ts:81`（签门前 `verifyGateRecord`） | `node --no-warnings scripts/gate-check.ts docs/gates/G4.md` → exit 1：`必过项 G4-06 的证据与固定映射不一致（换绑证据不许重签）：ev-g4-06 != ev-g4-06,ev-g4-14` |

影响与延期理由：fail-closed——检查器点名拒签，不会把错误绑定写进正式门记录；`docs/gates/G4.md` 在候选范围外，修复不影响候选哈希与本报告绑定，属签发前的门记录补正。但 §7 收口流程第 5/6 步（签门、过门）在修复前无法完成，故列入重签前待办。

## 七、结构性裁决

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G4",
  "audit_round": 1,
  "candidate_commit": "4e751de6cf8fb681e7b7c4f40061400cabab0408",
  "conclusion": "fail",
  "p0": 0,
  "p1": 2,
  "p2": 1,
  "must_pass_total": 14,
  "must_pass_passed": 13,
  "must_pass_ids": ["G4-01", "G4-02", "G4-03", "G4-04", "G4-05", "G4-06", "G4-07", "G4-08", "G4-09", "G4-10", "G4-11", "G4-12", "G4-13", "G-10"],
  "failed_items": ["G4-13"],
  "notes": "S4 业务实现与 13 项必过项经实测成立；G4-13 因 typecheck 11 处 TS 错误与 full-suite.md 失实数字（typecheck exit 0、343.00 kB）未过。P1-2：readinessOf 前置判定两缺口（M-60 换 attempt 后 .get() 读到旧 superseded 行、前置非成功终态无处置），后置永滞 queued、run 永停 running，双探针复现。P2-1 为 G4.md 的 G4-06 双证据绑定缺口，签门前补正。两个 P1 修复后须换候选重审。"
}
```
<!-- audit-verdict:end -->

## 八、落盘前自检

用 `src/core/audit-verdict.ts` 与 `scripts/gate-check.ts` 的四个函数对本报告文本独立复核（探针已随 tmp 清理）：

| 检查 | 结果 |
| --- | --- |
| `parseAuditVerdict` | 返回 `{verdict}`，无 error；schema、轮次、40 位候选、计数与 14 项 `must_pass_ids` 结构合法，无重复、无规格外项 |
| `proseVerdictClashes`（verdict=fail，14 项，auditRound=1） | 返回空：结论行唯一且与裁决同为 fail，无溢出列、无隐藏判定；fail 裁决下必过项表格扫描按设计豁免 |
| `auditConclusionOf` | 返回 `fail`，与裁决块一致（唯一结论行 `结论：fail（…）`） |
| `verdictProblems` | 结构类检查（gate/round/commit 对账、must_pass 覆盖与总数、去重、无规格外项）全部通过；返回 4 条均为 fail 裁决签名：`审计结论是 fail`、`还有 2 个 P1`、`必过项没过完：13/14`、`failed_items 不为空：G4-13`——这是 fail 报告应有的放行阻断签名，`gate-check` 将据本报告拒绝对 G4 签门，与本轮结论一致 |

说明：`verdictProblems` 的空结果仅在 pass 裁决下可能；本轮有证据充分的 P1，按规范只能给 fail 裁决，故 problems 以「fail 签名四条、零结构问题」收口，写明于此。探针 `tmp/s4r1-selfcheck.ts` 复核输出 `SELFCHECK: OK`，已随 tmp 清理。

## 九、重签前待办

1. 修 P1-1：`tests/gate/gate-check.spec.ts` 的 `GATE_SPECS.G4` 访问加非空断言或改用具名常量，`pnpm typecheck` 归零；重跑四命令并按实测更新 `docs/gates/evidence/G4/full-suite.md`。
2. 修 P1-2（两个面一起）：`readinessOf` 前置按有效行判定（`ORDER BY attempt DESC` 或排除被接班旧行）并对非成功终态前置结算后置节点（走既有 `failQueuedNode` 机制留事件），补「a failed → b 收终态 → run 收口 failed」与「换 attempt 双行 → b 正常放行」两条回归用例。
3. 修 P2-1：`docs/gates/G4.md` 的 artifact 给 G4-06 的 `evidence_ids` 补 `ev-g4-14`、evidence-index 块补 `ev-g4-14` 条目（候选范围外，不触发重审）。
4. 两个 P1 的修复都落在候选范围内：换候选后重审（一轮快审），复验通过再按 §7 流程签门过门；G4 若过，建议结束 S1–S4 收敛审计，转入 S5 面板与记忆开发。
