# S1 独立审计报告 · G1 第 68 轮

门：G1
候选提交：fd2173bb719068e94c3713e5b08703ea932dd08d
审计日期：2026-11-16
审计方式：独立只读审计；未签门、未改任何生产代码/测试/证据/门记录

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 68,
  "candidate_commit": "fd2173bb719068e94c3713e5b08703ea932dd08d",
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
  "notes": "G1 地基 13 项全过，无 P0/P1。r67 的 4 条 P2 中 P2-1/P2-2/P2-3 已落实整改并有用例，P2-4 未改仍成立。新增统一断链闸门（applyTransition / transitionNode / closeRun）不误伤正常节点，健康链照常推进；台账 P1-2026-11-16-02 的四个外部入口均有回归。4 条 P2 记录在案：迁移 026 就地改写对已应用旧版库的升级隐患、026 量级口径的真纳秒小值放大风险、断链闸门覆盖面与人工出口口径、派发失败节点仍留 queued。"
}
```
<!-- audit-verdict:end -->

## 1. 审计基准

- 审计开始时主线 HEAD、候选提交、报告绑定提交三者同为 `fd2173bb719068e94c3713e5b08703ea932dd08d`，工作树干净（`git status --short` 无输出）；本轮只读，没有改动任何候选文件。
- 上一轮基线为 `dcee53d3c3c25dda230cf8dc3bf800d223ff1b58`（S1 r67 判 pass）。本轮 diff 范围 `dcee53d..fd2173b`，另有文档提交 `7a1e48b`、`140dd18`、`3001538` 类收口记录。
- 三门门记录当前仍绑 `audit_round` 66/66/18（对应 `5098847`），尚未按 r67/r68/r19 重签；因此本次审计只对候选字节负责，不改门记录、不签门。
- 本轮生产代码实际变化集中在四类：统一断链闸门（`ledger.ts` 新增 `assertChainIntact`，装到 `applyTransition` / `transitionNode` / `closeRun`）、迁移 026 识别口径改写、桥恢复写回预算检查点、控制面恢复与 reanchor 的收尾修补。其余 diff 是把 `applyTransition` / `closeRun` / `resolveDecision` 批量加 `secret` 形参的机械改动、测试与文档。
- 未做全局重审：只沿本轮改动直接影响的调用路径展开，并对 G1 的 13 项逐项对账。

## 2. 实测（本人亲自执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc --noEmit` 通过，无诊断输出 |
| `npx vitest run` | 0 | 70 files 全过；940 passed / 1 skipped（共 941）；总耗时 11.24s |
| `pnpm build` | 0 | ESM `lib/index.js` 300.94 kB（gzip 72.62 kB）、`lib/index.d.ts` 24.43 kB；CJS `lib/client.js` 0.29 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 28 份证据每份重跑两遍与 HEAD 字节一致 |

另用两个只读探针（`tmp/s1r68_*`，交付前已删）确认迁移 026 的真实行为与升级兼容性，结果见 §6 的 P2-1 / P2-2。

## 3. 上一轮 4 条 P2 逐条复核

| 编号 | 上轮问题 | 本轮判定 | 依据 |
| --- | --- | --- | --- |
| P2-1 | 迁移 026 识别口径不命中真实旧行 | 已修复，留边界残留 | 口径改为按数值量级判定；用例 `recovery-unit-migration.spec.ts:32-42` 现构造「四列同写、锚点有值、值=120000 毫秒」的真实旧形态，断言被换成 1.2e11；探针复核旧毫秒行 120000→1.2e11。边界问题另记本轮 P2-2 |
| P2-2 | 桥恢复重挂后把检查点显式置空 | 已修复 | `sweep.ts:260`、`273` 改为 `Math.round(remaining * 1e6)` 写回新预算检查点，不再清空；`sweep.spec.ts` 的桥恢复用例仍通过 |
| P2-3 | 取消/恢复控制面入口不验链 | 已修复（口径随之改变） | `assertChainIntact` 装进 `applyTransition`，`cancel.ts` 与 `recovery.ts` 的写路径均经它；`chain-guard-entries.spec.ts` 4 例覆盖上报主干、执行器迁移、run 收口、等待唤醒。代价是断链节点的「人工确认/取消出口」被一并拒绝，另记本轮 P2-3 |
| P2-4 | 断链派发失败节点仍留 queued、缺只读查询 | 未改，仍成立 | `dispatcher.ts:196-204` 仍把异常收成 `failed` 结果而不落库；`queued` 节点链断时 `acquireLease` 抛 `FORBIDDEN`，被 catch 吞成结果，库内状态不变。按 P2 继续登记 |

三项已整改项都没有削弱既有断言：被机械改签名替换的用例（`transition-guard`、`control-transition-guard`）断言动作与期望完全保留，只多传了一个 `secret`。

## 4. 本轮改动逐项审查（G1 视角）

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| `ledger.ts:98-108` 新增 `assertChainIntact` | 正确 | 读整条链并 `verifyChain`，断链抛 `FORBIDDEN`（`reason: chain_broken`，带 `seq` 与 `detail`），不写状态、不追加事件；空链 `verifyChain([])` 返回 `null`，首条事件前的首次迁移不受影响 |
| `applyTransition`（`nodes.ts:123-128`）装闸门 | 正确 | 正常节点的健康链能通过；`chain-guard-entries` 与全量用例证明没有误伤派发、裁决、等待、补偿等既有路径 |
| `transitionNode`（`node-state.ts:39`）装闸门 | 正确 | 执行器/上报走的是这条独立 CAS 入口，不与 `applyTransition` 共用，必须单独装；用例覆盖 `dispatched→started` 被拒且行不变 |
| `closeRun`（`run-close.ts:53-57`）逐节点验链 | 正确 | 放在全部早退之后，只有真要收口时才做整链校验，不给每轮扫描加固定开销；用例证明任一节点断链就不写 `run.terminal`、run 保持 `running` |
| 迁移 026 口径改量级 | 逻辑成立，边界留残留 | 真实旧毫秒行能被命中；`<1e6` 与模糊带、`>=1e9` 三档划分自洽，审计表覆盖可处置的三类，`>=1e9` 与 NULL 不记账；边界见 P2-2 |
| 桥恢复写回检查点（`sweep.ts:260,273`） | 正确 | 纳秒→毫秒→纳秒往返为恒等（整数 ns 经 `round` 不变），紧接着再重启仍有可信剩余 |
| `reanchorInTx` 跳过更多终态（`clock-recovery.ts:96`） | 正确 | 补齐 `timeout`/`abandoned_unverified`，与 7 个节点终态全集对齐（另含的 run 级态不影响）；用例「终态行不会被打成不确定」通过 |
| `resolveRecoveryUncertain` 收掉等待登记（`recovery.ts:50-51`） | 正确 | 与 `applyTransition` 同笔；`recovery-uncertain.spec.ts` 断言登记变 `cancelled`，避免后续 `wakeOnEvent` 整笔回滚 |

断链闸门对 G1 地基的影响结论：备份、迁移、单写者三条路径都不经过这三个入口，闸门不会让它们退化；正常节点（含空链的新节点）推进不受影响。

## 5. 13 项必过项

| 必过项 | 要求 | 结果与证据 |
| --- | --- | --- |
| G1-01 | 迁移空库可重复 | 满足；`migrate.spec.ts` 与 `recovery-unit-migration.spec.ts` 全过，026 在 `schema_migrations` 记账后重跑不再执行 |
| G1-02 | 迁移中途杀可重入 | 满足；每步一个事务（`driver.ts:108-113`），证据 G-14 重生成后 28/28 复现一致 |
| G1-03 | 进程杀不丢已提交事件 | 满足；`g1.spec.ts` 的 G-02 用例与证据 `ev-g02` 同时成立 |
| G1-04 | 备份独立目录行数与哈希一致 | 满足；`backup.spec.ts` 全过，本轮未触及备份路径 |
| G1-05 | 损坏备份可检出 | 满足；`backup.spec.ts` 覆盖清单/文件/表摘要三类不一致 |
| G1-06 | 认证拒匿名写 | 满足；`auth.spec.ts` 全过；本轮未新增路由，认证顺序不变 |
| G1-07 | 阶段开关拒未知值 | 满足；`config.spec.ts` 全过 |
| G-01 | 事务 COMMIT 前杀进程 | 满足；`g1.spec.ts` G-01 用例与证据 `ev-g01` 一致 |
| G-02 | COMMIT 后未投递被杀 | 满足；`g1.spec.ts` G-02 用例与证据 `ev-g02` 一致 |
| G-08 | 长事务读不拖死、写 busy、队列溢出 503 | 满足；`g1.spec.ts` G-08 用例全过，写队列未被本轮改动触及 |
| G-09 | 订阅者离线重放 | 满足；证据 `ev-g09` 复现一致 |
| G-14 | 迁移一半杀后重跑 | 满足；证据 G-14 覆盖 24→26 张表，`check-evidence-repro` 一致 |
| G-15 | 备份截断可检出、恢复被拒、线上库不变 | 满足；证据 `ev-g15` 与 `backup.spec.ts` 一致 |

## 6. 不阻断问题（P2）

| 编号 | 位置 | 说明 | 影响与延期理由 |
| --- | --- | --- | --- |
| P2-1 | `src/infra/sqlite/migrations/026_recovery_units.sql`（`0fda6ab` 就地改写）；`src/infra/sqlite/driver.ts:101-105` | 026 在引入后的下一批被原地改写。任何应用过旧 026 的库（`2bf9c07..7a1e48b` 区间，含 r67 候选 `dcee53d`）升级到本候选时，`applySteps` 会因校验和不符抛 `SCHEMA_VERSION_UNSUPPORTED`，服务无法启动。探针实测：先按 `dcee53d` 的旧 026 执行并记账，再跑当前 `loadSteps`，抛「已执行的迁移被改了，要新开编号」 | 当前三门仍绑 `5098847`（该基线无 026），仓库内无任何持久库（无 `storages/`、无 `.db` 文件），故 026 属未发布迁移，本条按 P2 记。**若团队确认 `dcee53d` 曾被实际部署，本条应升为 P1**。建议：要么确认无旧 026 库后保留改写，要么把 026 恢复原文并新开 027 承载修正后的数据修复 |
| P2-2 | `src/infra/sqlite/migrations/026_recovery_units.sql:22-28,50-54` | `<1e6` 档不区分「旧毫秒」与「真纳秒小值」，一律乘 1e6。探针实测：真纳秒 999999（距到期不足 1ms）被放大成 999999000000（约 16.6 分钟）；模糊带 `1e6..1e9` 对 `watchdogMs` 大于约 16.7 分钟的旧毫秒行保留原值，会按约毫秒级的纳秒值被读成接近到期 | 真纳秒 `<1e6` 只能来自 `refreshCheckpointsInTx`（`6bb4132` 引入，晚于已签 `5098847`、早于 026），即仅两个未签中间提交可达；已签基线不能写出该形状，故不改 13 项判定。建议在 027 里对 `<阈值` 一律按「已到期/不确定」处理，或加一道运行期可信度判断 |
| P2-3 | `src/service/commands/cancel.ts:166,207,216,228`；`src/service/commands/subworkflow.ts:781`；`src/service/commands/recovery.ts:64` | 断链闸门是「入口级」：`applyTransition` / `transitionNode` / `closeRun` 三处覆盖了状态推进与 run 收口，但若干只记事件的 append（取消时围栏已立的分支、`blocked_post` 取消传播）仍直接 `appendNodeRunEvent` 不验链；它们不改 `status`、不收口 run，断链事实仍可被 `verify` 检出。反向地，断链且不确定的节点调用 `/v1/recovery/resolve` 会经 `applyTransition` 被 `FORBIDDEN` 拒绝，r67 描述过的「人工确认出口」不再可用 | 系统侧所有置不确定的路径（`sweep.ts:88-97` 的 `skipNodes` 集合）都已跳过断链节点，故「断链+不确定」只能由「先置不确定、后账本被改」的外部篡改造出；此时冻结并转人工核账符合完整性意图，不构成正常流程卡死。建议把闸门下沉到 `appendNodeRunEvent` 统一兜底（或在文档写明只记事件的 append 不纳入闸门），并在文档写明断链节点的人工出口是账本核对而非 `resolve` |
| P2-4 | `src/service/dispatcher.ts:196-204`；`src/service/sweep.ts` 派发结果回填 | 断链 `queued` 节点拿不到租约，派发结果返回 `failed` + `FORBIDDEN`，但库里仍是 `queued`；`sweep` 已把 `chain_broken` 回填到结果，但没有只读查询把断链节点列给运维 | 断链需要人工处理，分叉不造成数据损坏，且 r67 已按 P2 登记；本轮未改，沿用。建议补一个只读断链清单（或并入 `/v1/verify` 返回），并把派发结果语义改成非失败态 |

## 7. 一般建议（不计数）

- `applyTransition` / `transitionNode` 现在每次迁移都读整条链并重新 `HMAC` 校验，累计为 O(n²)；当前用例规模无感，但长链节点与高频扫描下会放大开销。建议后续加「链头已验过」的会话级缓存，或只在真正写事件前校验一次。
- `tests/integration/recovery-unit-migration.spec.ts:2` 的注释仍写「只修『缺单调锚点 + 值落在毫秒量级』」，与新的量级口径不符，属注释漂移，建议顺手更新。
- `closeRun` 与 `assertChainIntact` 的整链校验只验事件行之间能否接上，不比对链头投影；整段尾部连同链头一起回滚的删除仍不会被这条闸门拦住（`verifyLedger` 的缺口检查才管这个）。这是既有口径，不是本轮引入，仅作说明。

## 8. 测试与质量证据

- 已实测：§2 的四条命令、§6 的两个只读探针（迁移 026 量级行为、旧 026 升级兼容）、以及 §3/§4 逐处引用的用例（`chain-guard-entries`、`recovery-unit-migration`、`recovery-uncertain`、`recovery-action-checkpoint`、`clock-recovery`、`migrate`）。
- 测试缺口单独记录：新增的 `chain-guard-entries.spec.ts` 覆盖了「上报/执行器迁移/run 收口/等待唤醒」四条主干，但没有覆盖「断链+不确定节点的 `resolve`」与「取消时围栏已立的分支」，这正是 P2-3 长期不易被发现的原因；它降低的是「闸门覆盖面」的保障，不是健康路径的保障。
- 未实测：多实例并发与长时间浸泡；仓库内没有运行库，P2-1 的实际严重度取决于是否曾有库应用过旧 026。

## 9. 阶段结论

结论：通过。G1 的 13 项必过项全部达成，本轮无 P0/P1 阻断问题；r67 的 P2-1/P2-2/P2-3 已落实为代码与用例，台账 P1-2026-11-16-02 的四个外部入口都有针对性回归，统一断链闸门没有误伤正常节点，也没有让备份/迁移/单写者路径退化。

建议：结束本轮 G1 收敛审计，按 G1→G2→G3 顺序重签三门后转入下一阶段开发。下一批优先处理 P2-1：确认没有任何库应用过旧 026——若有，则把 026 恢复原文、改为新开 027 承载修正后的数据修复，避免升级到本候选时启动即被迁移校验和拦住。
