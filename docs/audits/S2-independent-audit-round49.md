# S2 独立审计报告 · 第 49 轮（G2）

- 门：G2
- 候选提交：ce8c2e64360de9a3b057cced13432352971ec719
- 审计轮次：49
- 审计方式：只读审计。在 clone `D:\aboutAI\dsh-orchestra\tmp\audit-s2-r49` 内安装依赖、跑测试、写临时探针；未改主仓、未运行 `sign-gate.ts`、未提交。
- 结论：**pass**（20 项必过全过，失败项为空）

## 一、基线核实

| 项 | 观测 |
| --- | --- |
| `git log -1` | `ce8c2e64360de9a3b057cced13432352971ec719 feat(r3): enforce node run chain guards in sqlite` |
| `git status --porcelain` | 审计开始与结束时均为空（临时探针与日志在 clone 的 `tmp/`，已被忽略；探针文件交付前已删） |
| 候选父提交 | `41a450f`（R4 workflow 复合身份）之上叠加 R3 链头数据库级保护 |
| 依赖安装 | `pnpm install --frozen-lockfile`，退出码 0 |

## 二、命令矩阵

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `pnpm typecheck` | 0 | `tsc --noEmit` 无输出 |
| 2 | `pnpm test` 第 1 次 | 0 | Test Files 42 passed (42)，Tests 619 passed \| 1 skipped (620) |
| 3 | `pnpm test` 第 2 次 | 0 | Test Files 42 passed (42)，Tests 619 passed \| 1 skipped (620) |
| 4 | `pnpm test` 第 3 次 | 0 | Test Files 42 passed (42)，Tests 619 passed \| 1 skipped (620) |
| 5 | 桥闭环 6 文件（agent-lifecycle / bridge-ledger / bridge-buffer / runtime / production-path / execution-concurrency）第 1 次 | 0 | 6 files / 70 tests |
| 6 | 同上第 2 次 | 0 | 6 files / 70 tests |
| 7 | 同上第 3 次 | 0 | 6 files / 70 tests |
| 8 | 同上第 4 次 | 0 | 6 files / 70 tests |
| 9 | 必过路径 6 文件（routes / production-path / sweep / apply-report / g2 / runtime） | 0 | 6 files / 124 tests |
| 10 | `pnpm build` | 0 | tsdown，`lib/index.js` 152.57 kB |
| 11 | `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致 |
| 12 | 临时攻击探针 `zz-audit-r49-probe.spec.ts` | 0 | 1 file / 12 tests |

桥闭环命令复用证据里的六文件命令，四次计数均为 70，与 `ev-g2-16.md` 的桥闭环断言一致。

## 三、候选实现核对

### 3.1 R3：迁移 012 与链头保护

`src/infra/sqlite/migrations/012_node_run_chain_guard.sql` 四道触发器：

- `trg_node_run_events_chain_guard`（BEFORE INSERT `node_run_events`）：`seq < 1` 拒绝；有链头时要求 `NEW.seq = last_seq+1` 且 `NEW.prev_hash = last_hash`；无链头时要求 `seq=1` 且 64 个零哈希。文案分别是「必须接在链头之后」「新链必须从 seq=1 的零哈希开始」。
- `trg_node_run_chain_heads_insert_guard`：新链头必须恰好对应首条事件（`last_seq=1`、`event_count=1`、存在 seq=1 且 `hash=NEW.last_hash`、`prev_hash` 为零哈希）。
- `trg_node_run_chain_heads_update_guard`：`last_seq` 与 `event_count` 只能各加一，且必须存在对应事件、`prev_hash=OLD.last_hash`。
- `trg_node_run_chain_heads_no_delete`：链头禁止 DELETE。

`src/infra/db/ledger.ts:40-79` 的 `appendNodeRunEvent()`：读链头与末条事件；「有事件无链头」抛 `SCHEMA_VERSION_UNSUPPORTED`（「链头缺失但账本里已有事件，不能继续追加」）；事件 INSERT 与链头 INSERT/UPDATE 分开写，避免 UPSERT 触发 BEFORE INSERT guard。`src/service/queries/verify_ledger.ts` 从事件 id 与链头 id 的并集逐链重算，能报「链头记录缺失」「链的条数与链头记录对不上」「整条链在账本里没了」「节点已经动过却没有链」等缺口。

### 3.2 R4：工作流复合身份

- `src/service/workflows.ts`：内部键为 `workflow_id + version`；`definitionHashOf()` 对无 `workflow_id` 的旧定义仍按 `sha256Hex(canonicalJson(def))`，显式 `default` 与省略同哈希，旧定义哈希不漂移；单参 `get()` / `resolve()` 遇到多个工作流同版本（含 `01` 与 `1` 的数字别名）抛 `WORKFLOW_VERSION_CONFLICT`（「这个版本号同时存在于多个工作流，必须带 workflow_id」）。
- `src/service/runs.ts:37,58-92`：建 run 时写 `workflow_id`、`workflow_version`、`workflow_definition_hash`，`task.created` / `run.created` 事件带同一绑定。
- `src/executor/run-node.ts:142-158`：工具策略从 `node_runs JOIN runs` 取 run 绑定；`node_id` 与账本不一致抛 `STALE_GENERATION`；请求参数里没有 workflow / policy 字段。
- `src/service/commands/apply-report.ts:98-121`：判定条件从 `runs` 的绑定取，绑定哈希与当前版本不一致抛 `WORKFLOW_VERSION_IMMUTABLE`；`:201-203` 校验 `report.node_run_id` 与请求一致，`:139-144` 拒绝跨节点 report_id 重放。

## 四、G2 必过项逐项复核

| 编号 | 要求（摘要） | 结果 | 代码/测试落点 | 证据 |
| --- | --- | --- | --- | --- |
| G2-01 | 单节点 queued 到终态一条路径 | pass | `src/service/runs.ts`、`src/executor/run-node.ts`；`tests/integration/g2.spec.ts`、`tests/e2e/production-path.spec.ts` | ev-g2-01 |
| G2-02 | 重复上报只落一次 | pass | `src/service/commands/apply-report.ts`；`tests/integration/g2.spec.ts`、`tests/integration/apply-report.spec.ts` | ev-g2-02 |
| G2-03 | 租约过期迟到上报被拒 | pass | `src/service/commands/apply-report.ts`；`tests/integration/g2.spec.ts`、`tests/integration/apply-report.spec.ts` | ev-g2-03 |
| G2-04 | 取消后不产生新 attempt | pass | `src/service/commands/cancel.ts`；`tests/integration/g2.spec.ts`、`tests/integration/cancel.spec.ts` | ev-g2-04 |
| G2-05 | 终态必带证据 | pass | `src/service/commands/apply-report.ts`；`tests/integration/g2.spec.ts`、`tests/integration/apply-report.spec.ts` | ev-g2-05、ev-g2-10 |
| G2-06 | 无裸 blocked（没裁决卡不许卡住） | pass | `src/service/commands/apply-report.ts`；`tests/integration/g2.spec.ts` | ev-g2-06 |
| G2-07 | S2 加载 parallel 被拒 | pass | `src/core/workflow-def.ts`；`tests/integration/g2.spec.ts`、`tests/integration/workflow-def.spec.ts` | ev-g2-07 |
| G-03 | 同一 report_id 上报两次只落一次 | pass | `src/service/commands/apply-report.ts`；`tests/integration/g2.spec.ts` | ev-g2-g03 |
| G-04 | 租约到期后原执行器迟到上报被拒 | pass | `src/service/commands/apply-report.ts`；`tests/integration/g2.spec.ts` | ev-g2-g04 |
| G-05 | 工具执行中取消只立一次围栏 | pass | `src/service/commands/cancel.ts`；`tests/integration/g2.spec.ts`、`tests/integration/cancel.spec.ts` | ev-g2-g05 |
| G-07 | 墙钟跳变不误判截止 | pass | `src/core/clock.ts`；`tests/integration/g2.spec.ts`、`tests/integration/clock.spec.ts` | ev-g2-09、ev-g2-g07 |
| G2-08 | 工具失败不许落完成（系统判失败并挂凭据） | pass | `src/executor/run-node.ts`、`src/service/commands/apply-report.ts`；`tests/integration/runtime.spec.ts` | ev-g2-08 |
| G2-09 | 判定时限只认 boot_id 与单调纳秒 | pass | `src/core/clock.ts`、`src/service/commands/sweep.ts`；`tests/integration/clock.spec.ts`、`tests/integration/sweep.spec.ts` | ev-g2-09 |
| G2-10 | 报告入口系统级证据门 | pass | `src/service/evidence.ts`、`src/service/commands/apply-report.ts`；`tests/integration/apply-report.spec.ts` | ev-g2-10 |
| G2-11 | 反复重投同一 report_id 不许刷膨胀 | pass | `src/service/commands/apply-report.ts`；`tests/integration/apply-report.spec.ts` | ev-g2-11 |
| G2-12 | 工具授权只认 workflow 定义 | pass | `src/executor/run-node.ts:142-158`；`tests/integration/runtime.spec.ts`、`tests/e2e/production-path.spec.ts` | ev-g2-12 |
| G2-13 | 单写者锁与 epoch 围栏 | pass | `src/infra/db/open.ts`；`tests/integration/db-open.spec.ts` | ev-g2-13 |
| G2-14 | 长动作靠心跳续租，扫描不误判过期 | pass | `src/executor/run-node.ts`、`src/service/commands/sweep.ts`；`tests/integration/sweep.spec.ts`、`tests/integration/runtime.spec.ts` | ev-g2-14 |
| G2-15 | 同一工作流版本跨重启不可改写，在飞 run 的判定条件不跟着变 | pass | `src/service/workflows.ts`、`src/service/commands/apply-report.ts`；`tests/integration/workflows.spec.ts`、`tests/integration/workflow-identity.spec.ts` | ev-g2-15 |
| G2-16 | Agent Bridge 生产闭环：B01–B10 可复现，工具证据只来自宿主执行 | pass | `src/executor/agent-lifecycle.ts`；`tests/integration/agent-lifecycle.spec.ts`、`tests/integration/bridge-ledger.spec.ts`、`tests/unit/bridge-buffer.spec.ts`、`tests/integration/runtime.spec.ts`、`tests/e2e/production-path.spec.ts`、`tests/contract/execution-concurrency.spec.ts` | ev-g2-16 |

计数：20/20 pass。必过路径 6 文件重跑 124 tests 通过；桥闭环 6 文件四次均为 70 tests 通过。

## 五、证据复核

### 5.1 20 份证据的 LF 归一 sha256

逐份按 LF 归一重算，与 `docs/gates/G2.md` 正文证据表、正文 `evidence-index` 块逐项比对，20/20 一致：

| 证据 | sha256（LF 归一） | 正文表 | 索引块 |
| --- | --- | --- | --- |
| ev-g2-01 | `71825a7db387884c2b9148dc991dc1415b2bb0d0605d05fb780a0990626a76a6` | 一致 | 一致 |
| ev-g2-02 | `346af5813c653ba967af948a74aba27201b9ac906f13e54f4e588f8b18ea70e1` | 一致 | 一致 |
| ev-g2-03 | `5929f803fadbbeabe0a9f9b5b0b65d2d52b429017eaceab56388f165d83d29be` | 一致 | 一致 |
| ev-g2-04 | `65946e22958ef8764415d2af693245f8dc8da33e585ba4cee094e36f56ac71a6` | 一致 | 一致 |
| ev-g2-05 | `6f3b44cf5589ddc059b77f3640e5a23f93eef8351d9c5fba9dd6510abc26e2ba` | 一致 | 一致 |
| ev-g2-06 | `cef5cf3de601985af216cb935334414d56ff9f3f296871f709332f9e16b1f91c` | 一致 | 一致 |
| ev-g2-07 | `64fa6c33ed9f4b33f5f8cc2306a8ad618d99d06ce1698e7aa1c8b537beeae05d` | 一致 | 一致 |
| ev-g2-08 | `86e30ab3215755f2a791614dce667b295a41c0afebce0a7f286920e23e0d9225` | 一致 | 一致 |
| ev-g2-09 | `f43b50982b67843db87e1cae9b36b0048eca372d9734904d3e1090fc97b8d8b2` | 一致 | 一致 |
| ev-g2-10 | `3f3ba0999a89c2986d382e974a68357d1da1e3d015681ea5b7c4f0af5bd543ab` | 一致 | 一致 |
| ev-g2-11 | `fb72ef55124d1b210ff4bf73ad1122cf067ecb93f96265e1fdfbdd050fc815dd` | 一致 | 一致 |
| ev-g2-12 | `5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe` | 一致 | 一致 |
| ev-g2-13 | `a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc` | 一致 | 一致 |
| ev-g2-14 | `61e9c435b7d6b652e87889190af7e932ff54799f4d21d4e2b538f5ec3f050896` | 一致 | 一致 |
| ev-g2-15 | `8c21ebd8e00ea8563f910fd2f3b3beb96b678812260620c9d0f05480e1f7ca6d` | 一致 | 一致 |
| ev-g2-16 | `4414fae1c349b9e3acadaebc9c63a3e63968565705561e02651c23755537e278` | 一致 | 一致 |
| ev-g2-g03 | `514f9754fda67b8e1522d086fc6079301e00bd0185f9cca6dddec502c412ab70` | 一致 | 一致 |
| ev-g2-g04 | `a30155a2446531f5c5cd2677946805ca9a78f407cfc4626147f20fcd446eb961` | 一致 | 一致 |
| ev-g2-g05 | `d400f29ddeb1e0578c132e0a9abef1e0e3fc123179bfd90a692f526564285f4c` | 一致 | 一致 |
| ev-g2-g07 | `de51ca56aba24af02f7c1ef2c0bfba5248da11b5aaa7ba163aafacf9d8e0746a` | 一致 | 一致 |

### 5.2 门记录哈希重算

从 `docs/gates/G2.md` 的 artifact / evidence-index / invariants 块独立重算：

| 哈希 | 重算值 | 与记录 |
| --- | --- | --- |
| artifact_hash | `4481775c3a63cb62fa313adcbfde7e38740b41d6859d0eb3b0857750fe393f79` | 一致 |
| body_hash | `bdd3d6918c30d7828ea4d457965e50f50f0649a1c1d348465673c31af2f3d4e9` | 一致 |
| evidence_index_hash | `d1acbb2cb394f2b662e68f5b64916ea3443945ce31c9760d3a72817ef55c8087` | 一致 |
| invariants_hash | `6a7adcb05ef5a2dd645a7b259c7d11098a366dfe2e2cf31cda54f2d95138768e` | 一致 |

第 48 轮审计报告 `docs/audits/S2-independent-audit-round48.md` 的 LF 归一 sha256 重算等于记录值 `da7f2792bddc2a5153f85e1ed9f50096b65230138852d4f8b24610d03a9fbde8`。记录当前仍锚在 `audit_round=48`。

### 5.3 关键证据抽查

- `ev-g2-03.md`：租约 HTTP=200；迟到上报 HTTP=409，`code=LEASE_EXPIRED`，`details.proposed=true`；`report_applied` 条数=0；节点仍为 dispatched attempt=1；上报登记为空；节点事件只有 `lease_acquired`。与必过项要求一致。
- `ev-g2-16.md`：B01–B10 覆盖矩阵完整（B03 有真实账本断言，B06/B07 用真实子进程）；对账为 node done、事件含 lease_acquired/tool_started/tool_finished/report_applied、registry applied、evidence_source=run_tool、双入口 started=6 / maxActive=2 / inFlight=0 / waiting=0；桥闭环复现命令 6 files / 70 tests。四次独立重跑一致。

### 5.4 候选哈希与记录

按当前 HEAD 重算 `candidate_hash = e0fe6a9db460d81ee05d720d70f3ca77533dafff39dfbffc87f40c8d05b1b164`、`change_scope_hash = 4c2805830ca7340092e5edc6745f0ec9ded1a7b055af52556ff7beaaad14d1ec`（137 个改动路径），与记录里的 `d93fb553…` / `bebd05bb…` 不同。这是 HEAD 在第 48 轮签署之后又前进了 `ce8c2e6` 的正常状态；本轮审计完成后由门维护者按本轮报告重签，重签时这两个值会按 HEAD 重算。

## 六、攻击面与交叉面

攻击探针 12 例全部通过；攻击矩阵行只描述攻击，不带必过项编号。

| 攻击 | 观测 |
| --- | --- |
| 事件 seq 正确但 prev_hash 错 | 触发器拦下，文案「必须接在链头之后」 |
| 首条事件 seq=1 但 prev_hash 非零 | 触发器拦下，文案「新链必须从 seq=1 的零哈希开始」 |
| 链头 UPSERT 把 last_seq 一次推高 | BEFORE INSERT guard 拦下，「新链头必须恰好对应首条事件」 |
| 有链头时插入 seq=1 事件 | 拦下，「必须接在链头之后」 |
| 链头 UPDATE 跳号 / 指向不存在的事件 / 末哈希不符 | 三种写法分别被「链头序号必须逐条递增」「链头更新缺少对应事件」拦下 |
| 事件写入后不推进链头 | 账本校验返回 ok=false（条数与链头对不上） |
| 同事务回滚 | 事件与链头一起回滚，随后追加从 seq=1 重新起链，校验通过 |
| 链头零哈希、单据表被清空 | 校验报「链头记录缺失」「整条链在账本里没了」 |
| 两个工作流同版本各自建 run | runs 行 workflow_id 分别为 wf-a / wf-b，定义哈希不同，run.created 事件各带自己的绑定 |
| 单参取同版本号 | `get('1')`、`toolPolicyFor('1','a')` 均抛「必须带 workflow_id」 |
| 跨工作流数字别名（01 / 1） | `get('1')`、`get('01')` 均判歧义；两参取各自版本成功 |
| 旧 default 定义哈希 | 与 R4 前公式逐字节相等，显式 default 亦同哈希 |
| 报告证据按另一个工作流的判定条件收口 | apply-report 只读 run 绑定，跨工作流夹具下仍按本 run 的 pass 条件判定 |
| 调用方传别的 nodeId 借授权 | runNode 抛 `STALE_GENERATION`，节点保持 queued |

桥生命周期 B01/B03/B06/B07/B16 与双入口并发均在六文件套件里；四次 70/70 通过，012 未引入桥侧回归。`tests/integration/ledger-integrity.spec.ts` 的 20 例全部通过，覆盖事件 UPDATE/DELETE 拒绝、链头 DELETE、链头 UPDATE 跳号、事件跳号、缺链头追加、新链起链、链头投影、旧库回填、尾删/整链删/中间篡改/无链节点/未知节点等场景。

## 七、遗留清单

### P0
无。

### P1
无。

### P2

1. **链头可用 `INSERT OR REPLACE` 按回创世条**：SQLite 在 `recursive_triggers` 关闭时，REPLACE 不触发 BEFORE DELETE 触发器，因此把链头按回 `last_seq=1 / event_count=1` 是可行的。后果可检出：账本校验报「条数与链头记录对不上」，后续追加因 seq=2 主键冲突失败，不会静默改写历史。建议连接打开时显式 `PRAGMA recursive_triggers=ON`，或在链头 INSERT guard 里补 `NOT EXISTS (SELECT 1 FROM node_run_events WHERE node_run_id=NEW.node_run_id AND seq > 1)`。
2. **桥闭环证据的辅助全量计数已过期**：该证据正文的辅助 `pnpm test` 行仍写 41 files / 607 passed | 1 skipped，候选实际为 42 files / 619 passed | 1 skipped；桥闭环 6 files / 70 tests 的断言四次重跑一致，因此不影响该必过项。该证据也不在 `scripts/check-evidence-repro.ts` 的 CASES 列表内（19/20 覆盖），建议重生成时一并把辅助行更新，并评估是否纳入复现守卫。

## 八、复签提示

本轮报告写入 `docs/audits/S2-independent-audit-round49.md` 后，门维护者按既有顺序提交报告、更新 `docs/gates/G2.md` 的 artifact 字段（`audit_round=49`、`audit_report`、`audit_report_sha256`，以及按新 HEAD 重算的 `candidate_hash` / `change_scope_hash`）并重签。正文证据表与不变量表无需改动（20 份证据哈希、四个可重算哈希均一致）。

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 49,
  "candidate_commit": "ce8c2e64360de9a3b057cced13432352971ec719",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 2,
  "must_pass_total": 20,
  "must_pass_passed": 20,
  "must_pass_ids": [
    "G2-01",
    "G2-02",
    "G2-03",
    "G2-04",
    "G2-05",
    "G2-06",
    "G2-07",
    "G-03",
    "G-04",
    "G-05",
    "G-07",
    "G2-08",
    "G2-09",
    "G2-10",
    "G2-11",
    "G2-12",
    "G2-13",
    "G2-14",
    "G2-15",
    "G2-16"
  ],
  "failed_items": [],
  "notes": "20 项必过全过；全量 3 次均 42 files / 619 passed | 1 skipped（退出码 0），桥闭环 4 次均 6 files / 70 tests（退出码 0），必过路径 6 files / 124 tests，check-evidence-repro 25 份字节一致。P2 两条：链头 REPLACE 可回创世条但可校验、桥闭环证据辅助全量计数过期。候选哈希与记录值不同属第 48 轮签署后 HEAD 前进的正常状态，重签时重算。"
}
```
<!-- audit-verdict:end -->
