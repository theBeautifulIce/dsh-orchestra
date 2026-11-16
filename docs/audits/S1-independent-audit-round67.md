# S1 独立审计报告 · G1 第 67 轮

门：G1
候选提交：dcee53d3c3c25dda230cf8dc3bf800d223ff1b58
审计日期：2026-11-16
审计方式：独立只读审计；未签门、未改任何生产代码/测试/证据/门记录

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 67,
  "candidate_commit": "dcee53d3c3c25dda230cf8dc3bf800d223ff1b58",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 4,
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
  "notes": "G1 地基 13 项全过，无 P0/P1。台账 P1-2026-11-16-01 已修复并有针对性用例；断链执行侧旁路已封。4 条 P2 记录在案：迁移 026 识别口径不命中真实旧行、bridgeRestored 仍留空检查点、控制面入口不验链、断链节点缺只读查询且派发结果与库内状态分叉。"
}
```
<!-- audit-verdict:end -->

## 1. 审计基准

- 审计开始时主线 HEAD、本轮候选提交、报告绑定提交三者同为 `dcee53d3c3c25dda230cf8dc3bf800d223ff1b58`，工作树干净，唯一未跟踪文件是并发写出的 `docs/audits/S3-independent-audit-round19.md`（`docs/audits` 不进候选范围）。
- 本轮 diff 范围 `5098847..dcee53d`，生产代码实际变化只有六处：`src/service/commands/lease.ts`（租约入口先验链）、`src/infra/sqlite/migrations/026_recovery_units.sql`（一次性数据修复）、`src/service/clock-recovery.ts`（按锚点刷新检查点）、`src/service/commands/confirm-start.ts` 与 `cancel.ts`（锚点与检查点同笔写）、`src/service/{commands,queries}/recovery.ts` + `server.ts` + `schemas.ts` + `index.ts`（不确定态的查询与确认入口）；另有 `sweep.ts` 的断链跳过集、`dispatcher.ts` 的派发码白名单与重试指令。剩余 diff 是文档、证据与测试。
- 上一轮 r66 只有一条 P2（门记录仍绑旧候选），属批次预期；r66 无 P0/P1 遗留。
- 本轮没有做全局重审：只沿本轮改动直接影响到的调用路径展开，并对 G1 的 13 项逐项对账。
- 重要提醒：§2 的实测是在工作树干净时（与候选同字节）跑的；报告落盘时工作树又出现了未提交改动（`src/index.ts`、`src/service/commands/*`、`sweep.ts`、`dispatcher.ts` 共 14 个文件，内容是把 `applyTransition` / `closeRun` 批量加 `secret` 形参）。本报告与全部行号均绑定 `dcee53d`；这批改动若并入候选，本报告立即失效，需要重审。

## 2. 实测（本人亲自执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出（日志 15 字节，仅 pnpm 回显） |
| `npx vitest run` | 0 | 69 files 全过；935 passed / 1 skipped |
| `pnpm build` | 0 | ESM `lib/index.js` 299.67 kB（gzip 72.32 kB）、`lib/index.d.ts` 24.43 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 28 份证据每份重跑两遍与 HEAD 字节一致 |
| `node --no-warnings scripts/gate-check.ts` | 1 | 三门均报「候选提交之后候选文件又被改过：codebasemap.md」，属待重签状态，不是代码缺陷 |

另用四个只读探针（`tmp/`，交付前已删）核对迁移 026 与重启判定的真实行为、以及控制面对断链节点的实际效果，结果见 §6 的 P2-1 与 P2-3。

## 3. 上一轮问题与跨门整改复核

| 编号 | 来源 | 状态 | 依据 |
| --- | --- | --- | --- |
| 门记录绑定旧候选 | r66 P2-1 | 待重签 | 本候选改动了 `codebasemap.md` 等候选文件，G1/G2/G3 必须按 r67/r68/r19 重算 `artifact_hash` |
| P1-2026-11-16-01（锚点写了、检查点没写导致重启判不确定） | `审计要求.md` §8 | 已修复并验证 | `confirm-start.ts:62-71`、`cancel.ts:136-142`、`160-166`、`185-193`、`296-306` 均在写锚点的同一笔里写 `action_remaining_ns`；`clock-recovery.ts:159-177` 改成只按「锚点非空」补检查点；`tests/integration/recovery-action-checkpoint.spec.ts` 三例覆盖确认启动、无围栏取消、NULL 行补值；探针复核 NULL 行在首轮扫描被补成 20s |
| 断链子 run 推父节点、wait 超时收口 run（S2 r67 P1-1a/P1-1b） | 跨门整改 `d85b09d` | 已修复并验证 | `sweep.ts:97-104` 计算 `skipNodes`/`taintedRuns`，`377-380` 拦父节点推进，`388`、`391-393` 拦决策与 run 收口；`wait.ts:349-350` 收口前查 `skipRunIds`；新增用例「断链父节点 + 已完成子 run」「断链子 run + 已完成子流程」「wait 超时 + 断链节点」「run 里含断链终态节点」 |

三项整改都没有削弱既有断言：被替换掉的「30 秒确认窗口」用例改成了「按检查点续算、墙钟前跳不误判」，断言强度不低于原来。

## 4. 本轮改动逐项审查

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| `lease.ts:64-69` 租约入口先验链 | 正确 | 链断直接 `FORBIDDEN`（`reason: chain_broken`），不改状态、不建租约、不追加事件；同名用例同时证明健康节点照常拿租约，闸门只拦坏账本 |
| 迁移 026 | 识别口径有偏差 | 见 P2-1；迁移编号 026 紧跟 025，`loadSteps` 的连续性与单步事务都不受影响，可重入 |
| `clock-recovery.ts:159-177` 刷新检查点 | 正确 | 只处理本 boot 的行；不再要求检查点已非空，NULL 行能被补上；停机期间不递减 |
| `confirm-start.ts` / `cancel.ts` 补检查点 | 正确 | 三处写入（确认启动、无围栏取消、撤围栏重挂）都与锚点同笔 |
| `/v1/recovery/uncertain`、`/v1/recovery/resolve` | 基本正确，控制面未验链 | 认证在路由之前统一执行，写请求走写队列，`revision` CAS 与 M-50 语义正确；但控制面入口不验链（P2-3） |
| `dispatcher.ts` 错误码白名单与 `retryDirective` | 正确 | 未登记码一律收敛为空串，宿主不再看到自造码；`storage_error` 的三种重试指令由单表钉死并有单测 |
| `sweep.ts` 统一跳过集 | 正确 | 断链与不确定节点都不再被自动推进，所在 run 不被收口 |

## 5. 13 项必过项

| 必过项 | 要求 | 结果与证据 |
| --- | --- | --- |
| G1-01 | 迁移空库可重复 | 满足；`migrate.spec.ts` 全过，026 在 `schema_migrations` 记账后重跑不再执行 |
| G1-02 | 迁移中途杀可重入 | 满足；每步一个事务，证据 G-14 重生成后 28/28 复现一致 |
| G1-03 | 进程杀不丢已提交事件 | 满足；`g1.spec.ts` 的 G-02 用例与证据 `ev-g02` 同时成立 |
| G1-04 | 备份独立目录行数与哈希一致 | 满足；备份整文件复制 + 核心 10 表摘要，`backup.spec.ts` 全过 |
| G1-05 | 损坏备份可检出 | 满足；`backup.spec.ts` 覆盖清单/文件/表摘要三类不一致 |
| G1-06 | 认证拒匿名写 | 满足；`auth.spec.ts` 全过，新增 POST 路由位于 `authenticate()` 之后 |
| G1-07 | 阶段开关拒未知值 | 满足；`config.spec.ts` 全过 |
| G-01 | 事务 COMMIT 前杀进程 | 满足；`g1.spec.ts` G-01 用例与证据 `ev-g01` 一致 |
| G-02 | COMMIT 后未投递被杀 | 满足；`g1.spec.ts` G-02 用例与证据 `ev-g02` 一致 |
| G-08 | 长事务读不拖死、写 busy、队列溢出 503 | 满足；`g1.spec.ts` G-08 用例全过，写队列未被本轮改动触及 |
| G-09 | 订阅者离线重放 | 满足；证据 `ev-g09` 复现一致 |
| G-14 | 迁移一半杀后重跑 | 满足；证据 G-14 已更新为 24→26 张表，`check-evidence-repro` 一致 |
| G-15 | 备份截断可检出、恢复被拒、线上库不变 | 满足；证据 `ev-g15` 与 `backup.spec.ts` 一致 |

## 6. 不阻断问题（P2）

| 编号 | 位置 | 说明 | 影响与延期理由 |
| --- | --- | --- | --- |
| P2-1 | `src/infra/sqlite/migrations/026_recovery_units.sql:23-26,40-45` | 识别口径是「`startup_unknown_remaining_ns` 非空 + `startup_unknown_monotonic_ns` 为空」，但写毫秒的那条旧路径（`88c194e..5098847` 的 `lease.ts`）四列同写，`monotonic` 非空；而所有非空写入都发生在 `88c194e` 之后，所以该口径命中不了任何生产旧行。探针实测：同形旧行（`remaining=120000`、`monotonic` 非空）在 026 之后仍是 120000，`recovery_unit_fixes` 只有测试构造的空锚点行；升级后首轮扫描把它当 0.12ms 可信剩余，第二轮扫描即转 `indeterminate_side_effect`。测试 `recovery-unit-migration.spec.ts:32-42` 构造的是空锚点形状，与生产写路径不一致 | 影响限「升级前写入过旧单位行的库」，且终态与既有「缺锚点旧行按不确定收口」同一口径，可经报告冲突链继续收口，不阻碍下一阶段；数据修复本身只覆盖空锚点行，等于一条无效修复，建议下一批把口径改为「有锚点但剩余量落在毫秒量级」或直接让 `remainingAfterRestart` 对不可信的小检查点判不确定 |
| P2-2 | `src/service/sweep.ts:250-260` | 桥恢复把 `startup_unknown` 重挂后把 `startup_unknown_remaining_ns` 显式置空（`259`），刷新要等下一轮扫描（≤2s）才补回。若进程在这 2 秒内退出，重启时检查点为空，节点被标 `recovery_uncertain`，所在 run 不再收口 | 与刚修复的 P1-2026-11-16-01 同类，但窗口只有一个扫描周期，且有 `/v1/recovery/uncertain` + `/v1/recovery/resolve` 处置；建议把检查点与锚点同笔写，顺手消掉这一类 |
| P2-3 | `src/service/commands/recovery.ts:35-79`；`src/service/commands/cancel.ts:39-146`（由 `subworkflow.ts:703` 的取消传播调用） | 控制面入口不验哈希链：探针实测，对断链节点调用 `applyCancel`（`cancelResult=interrupted`）后节点从 `started` 推到 `timing_out`、并向断链追加了第 3 条事件，链仍报 `seq 1 hash 对不上`；`/v1/recovery/resolve` 同构，会把断链且不确定的节点推到 `indeterminate_side_effect`。自动路径（`sweep`/`lease`/`wait`/`decisions`/`finishedChildren`）都已加闸，控制面没有 | 断链意味着账本被改过或丢过数据，人工取消正是「可人工处置」那一半，停住执行符合操作意图；断链事实仍能被 `verify` 检出，事件追加不会把旧断点洗掉，故不阻断。建议在文档里写明「取消/确认是断链节点的合法人工出口」，或给这两处加一次 `chainBreakOf` 并把结果并入事件负载 |
| P2-4 | `src/service/dispatcher.ts:196-204`；`src/service/sweep.ts:404` | 断链节点拿不到租约，派发结果返回 `failed` + `FORBIDDEN`，但库里仍是 `queued`，调用方会看到「结果失败、库内排队」的分叉；`sweep` 已把 `chain_broken` 回填到结果，但没有只读查询把断链节点列给运维 | 断链需要人来看，分叉不造成数据损坏；建议补一个只读查询（或把 `chain_broken` 并入 `/v1/verify` 的返回），并把派发结果的 `status` 改成 `skipped` 之类的非失败语义 |

## 7. 一般建议（不计数）

- `GLOSSARY.md:22` 的迁移分段（S3=010-019、S4=020-029、S5=030-039）与 `migrate.ts:37-42` 的连续编号校验冲突：当前 001–026 连续所以无碍，但按计划新增 `030_memory.sql` 会在启动时抛「迁移编号不连续」。建议在进入下一个分段前统一口径（要么补 027–029，要么把校验改成按段）。
- `5098847` 的提交说明写「S2 r65 P1-1」，但 S2 r65 报告的 P1 数为 0；属口径漂移，建议后续引用审计编号时以报告为准。
- `clock-recovery.ts:173-176` 把 `clock.bootId` 拼进 SQL 字符串；当前来源是 `randomUUID()`，无注入面，建议后续统一改参数绑定。

## 8. 测试与质量证据

- 已实测：§2 的五条命令、四个只读探针（迁移 026 识别口径、升级后首轮扫描、拆分复核、断链取消）、以及 §3/§4 中逐处引用的用例（`chain-guard-execution`、`recovery-action-checkpoint`、`recovery-uncertain`、`recovery-unit-migration`、`clock-recovery`、`dispatch-retry`）。
- 未实测：多实例并发与长时间浸泡；仓库内没有运行库（`storages/` 不存在），所以迁移 026 对真实历史库的影响只能用构造库确认，真实库中是否存在旧单位行未能确认。这一限制不影响 13 项必过项的判定，但影响 P2-1 的实际严重度评估。
- 测试缺口单独记录：迁移 026 的用例没有覆盖生产旧行的真实形状（带 `monotonic` + 毫秒剩余），这正是 P2-1 长期没被发现的原因；它降低的是「数据修复有效性」的保障，不是生产写路径的保障。

## 9. 阶段结论

结论：通过。G1 的 13 项必过项全部达成，本轮未发现 P0/P1 阻断问题；台账 P1-2026-11-16-01 与跨门的断链旁路整改均已修复且有针对性用例支撑。4 条 P2 已登记影响与建议，均不阻碍进入下一阶段。

建议：结束本轮 G1 收敛审计，按 G1→G2→G3 顺序重签三门后转入下一阶段开发；下一批优先把 P2-1 的迁移口径修对（或改为在恢复判定侧兜底），并在新增 027–029 之前把迁移编号口径统一。
