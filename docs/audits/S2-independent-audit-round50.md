# S2 独立审计报告 · 第 50 轮（G2）

门：G2
候选提交：bad33264d5799fffd0baad6ef424d18392aa1301

- 审计角色：独立审计员（只读）
- 审计环境：`D:\aboutAI\dsh-orchestra\tmp\audit-s2-r50`（独立 clone）
- 审计时间：2026-11-14
- 候选范围：`6112572..bad3326`，15 个文件，+197/−31

## 审计结论

结论：pass

P0 = 0，P1 = 0，P2 = 1。20 项必过全部 pass；唯一的 P2 是 G2-16 证据与门记录里的桥闭环计数没有随新增用例从 70 更新到 71，B01–B10 的断言本身全部成立，不影响门判定。

## 环境与预签态

- clone 起始 `git status --porcelain` 为空；`git rev-parse HEAD` = `bad33264d5799fffd0baad6ef424d18392aa1301`；`git log -1` = `bad3326 docs: record round50 candidate hardening`。
- `pnpm install --frozen-lockfile` exit 0（pnpm 12.3.4，node 26.13.1）。
- 预签态：`docs/gates/G2.md` 的 `audit_round` 仍为 49、`audit_report` 仍指向 round49；`node --no-warnings scripts/gate-check.ts docs/gates/G2.md` 在审计锚点处 exit 1（`审计报告的候选提交之后，候选文件又被改过…codebasemap.md`），符合任务说明的预签态，不记为候选缺陷。
- 同步复核：G2 记录里的 `candidate_hash=744dd268…` 与按当前 HEAD 实算的 `8fa91fbb…` 不同，`artifact_hash=68a36b56…`、`body_hash=235b8443…`、`evidence_index_hash=45cb5d6d…`、`invariants_hash=6a7adcb0…`、`change_scope_hash=a66761ea…` 与记录一致；`sign-gate.ts` 签门时会按 HEAD 重算 candidate 与 change_scope，属预签态。

## 命令与退出码

| 命令 | 次数 | 结果 | 退出码 |
| --- | --- | --- | --- |
| `pnpm test` | 3 | 42 files / 624 passed \| 1 skipped | 0 / 0 / 0 |
| 桥闭环 6 文件（agent-lifecycle、bridge-ledger、bridge-buffer、runtime、production-path、execution-concurrency） | 4 | 每次 6 files / 71 passed | 0 / 0 / 0 / 0 |
| 必过路径 6 文件（routes、production-path、sweep、apply-report、g2、runtime） | 1 | 6 files / 125 passed | 0 |
| `pnpm typecheck` | 1 | `tsc --noEmit` 无输出 | 0 |
| `pnpm build` | 1 | ESM `lib/index.js` 154.88 kB / gzip 38.52 kB，d.ts 14.30 kB | 0 |
| `node --no-warnings scripts/check-evidence-repro.ts` | 1 | 25 份证据各重跑两遍，均与 HEAD 字节一致 | 0 |
| `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` | 1 | 预签态审计锚点错误（预期） | 1 |
| `node --no-warnings tmp/r50-hash.mjs` | 1 | 20 份证据重算，mismatch 0 | 0 |

桥闭环与必过路径各比历史基线多 1 项，来源是 `tests/integration/runtime.spec.ts` 新增的「run 绑定定义哈希被换掉 → 不 spawn」用例；两个 6 文件集合都含该文件，因此分别从 70/124 变为 71/125。

## 逐项审计

| 编号 | 内容 | 结果 | 依据 |
| --- | --- | --- | --- |
| G2-01 | 单节点 queued 到终态一条路径（生产装配） | pass | ev-g2-01 字节复现；production-path / routes 用例 |
| G2-02 | 重复上报只落一次 | pass | ev-g2-02 字节复现；apply-report 重投用例 |
| G2-03 | 租约过期迟到上报被拒 | pass | ev-g2-03 字节复现；sweep 用例 |
| G2-04 | 取消后不产生新 attempt | pass | ev-g2-04 字节复现；runtime 取消用例 |
| G2-05 | 终态必带证据 | pass | ev-g2-05、ev-g2-10 字节复现；g2 / apply-report 用例 |
| G2-06 | 无裸 blocked（没裁决卡不许卡住） | pass | ev-g2-06 字节复现；g2 用例 |
| G2-07 | S2 加载 parallel 被拒 | pass | ev-g2-07 字节复现；g2 用例 |
| G-03 | 同一 report_id 上报两次只落一次 | pass | ev-g2-g03 字节复现；apply-report 用例 |
| G-04 | 租约到期后原执行器迟到上报被拒 | pass | ev-g2-g04 字节复现；sweep 用例 |
| G-05 | 工具执行中取消只立一次围栏 | pass | ev-g2-g05 字节复现；fence_armed=1、第二次取消 fence_already_armed、宽限到点 fence_revoked 一次 |
| G-07 | 墙钟跳变不误判截止 | pass | ev-g2-09、ev-g2-g07 字节复现；时钟用例 |
| G2-08 | 工具非零退出不许落完成（系统判定并挂凭据） | pass | ev-g2-08 字节复现；g2 blocked_post 用例 |
| G2-09 | 判定时限只认 boot_id 与单调纳秒 | pass | ev-g2-09 字节复现；g2 用例 |
| G2-10 | 报告入口系统级证据门（弱证据与伪造痕迹一律拒） | pass | ev-g2-10 字节复现；apply-report 证据门用例 |
| G2-11 | 反复重投同一 report_id 不刷膨胀 | pass | ev-g2-11 字节复现；report_replayed 只留一条用例 |
| G2-12 | 工具授权只认 workflow 定义，请求体策略不参与 | pass | ev-g2-12 字节复现；run-node / apply-report 从账本取 policy |
| G2-13 | 单写者锁与 epoch 围栏 | pass | ev-g2-13 字节复现；单写者 / 旧 epoch 用例 |
| G2-14 | 长动作靠心跳续租，扫描不误判过期 | pass | ev-g2-14 字节复现；心跳续租用例 |
| G2-15 | 同一工作流的同一版本跨重启不可改写，在飞 run 的判定条件不跟着变 | pass | ev-g2-15 字节复现；重启后同版本 409、在飞节点仍 verifying、弱证据收口被拒；runtime 绑定哈希被换即不 spawn |
| G2-16 | Agent Bridge 生产闭环：B01–B10 可复现，工具证据只来自宿主执行 | pass | ev-g2-16 文件哈希一致；桥闭环 6 文件 ×4 全 71 pass；B06/B07 真实子进程断言成立（计数文字见 P2-1） |

## 本轮重点核验

### 012/013 链头守卫

- `src/infra/sqlite/migrations/013_node_run_chain_head_replace_guard.sql`：`BEFORE INSERT ON node_run_chain_heads`，同 `node_run_id` 已有链头时直接 ABORT「链头只能由追加创建，不能重复插入或替换」。
- 该守卫补的是 SQLite `INSERT OR REPLACE` 的路径：冲突删除不触发 `BEFORE DELETE`，所以 012 的无条件 DELETE 守卫看不到；013 在插入前看到旧行即拒。
- 与 012 的组合：链头 DELETE 被拒、UPDATE 必须 last_seq+1/event_count+1 且存在匹配事件、事件 UPDATE/DELETE 由 005/007 无条件 ABORT、事件 INSERT 必须接链头；DELETE+INSERT、UPSERT DO NOTHING/DO UPDATE、REPLACE 事件、改 node_run_id 均无可行路径。唯一可行的是正常追加，符合 append-only 语义。
- 正常首条与后续追加不受 013 影响：`src/infra/db/ledger.ts:40` 的 `appendNodeRunEvent` 对无链头走 INSERT、有链头走 UPDATE，均在同一事务内。
- 用例：`tests/integration/ledger-integrity.spec.ts:77-88` 用 `INSERT OR REPLACE` 重置到 `last_seq=1`，断言抛「不能重复插入或替换」且链头仍 `{last_seq:2,event_count:2}`；同文件 63-69 断言正常追加 seq=3 且 `verifyLedger` 成立。
- 迁移顺序：007 的存量回填也写 `INSERT OR REPLACE INTO node_run_chain_heads`，但 007 先于 013 执行且只跑一次；新库此时事件为空，升级库不会重跑，未发现冲突。

### G2-15 文案与固定表

`docs/gates/G2.md:49` 与 `scripts/gate-check.ts:134` 均为「同一工作流的同一版本跨重启不可改写，在飞 run 的判定条件不跟着变」，逐字一致。ev-g2-15 里仍是旧错误消息「同一工作流版本不许改写定义」，属生产错误文案，不是门规格文本。

### G-05 注入与围栏

`scripts/fault-inject.ts` 的 caseG05 先 `catalog.load` 再取 `definitionHash('default','7')`，`INSERT runs` 补 `workflow_definition_hash`；`check-evidence-repro.ts` 的 G2 清单含 G-03/G-04/G-05/G-07 与 ev-g2-01…ev-g2-15，G-05 两遍重生成字节一致。账本行为仍是：`fence_armed` 一条、第二次取消 `fence_already_armed`、围栏期间上报 `accepted:false/reason:fence_armed`、宽限到点 `fence_revoked` 一次且 `replay_heads` 一条。

### B06/B07 与桥闭环

- B06（`tests/integration/runtime.spec.ts:369-398`）：真实子进程写 outbox 与 marker 后 SIGKILL；恢复同一 callId 抛 `EVIDENCE_SOURCE_UNAVAILABLE`，marker 仍为 `ran`，不重跑宿主工具。
- B07（`tests/integration/agent-lifecycle.spec.ts:229-294`）：真实 `node -e setInterval` 子进程，`executor.cancel` 里 SIGKILL，`whenIdle` 等 exit；断言 `exitCode !== null || signalCode !== null` 后才 dispose，且 `disposeCalls === 1`、`disposedAfterExit === true`。
- 桥闭环 6 文件连续 4 次均为 6 files / 71 passed，未观察到抖动。

### R4 复合身份、apply-report 与单参歧义

- `tests/integration/workflow-identity.spec.ts`：两工作流同版本各建各的 run 不串；省略 workflowId 建 run 被拒；旧口径归 default；非法身份在落库前被拒；hydrate 行键与快照交叉校验；011 升级后哈希与内容不变。
- `tests/integration/workflows.spec.ts:126`：两工作流各有版本 1 时，单参 `get('1')` 抛「必须带 workflow_id」，两参取用互不串。
- `src/service/commands/apply-report.ts:98-121`：policy 与定义哈希都从 runs 行读取并校验，不认请求体自报；`src/executor/run-node.ts:145-171` 在 spawn 与工具授权前做同一校验。

## 证据哈希

按 LF 归一重算，全部与 `docs/gates/G2.md` 第 75–94 行记录一致（20/20，mismatch 0）。

| 证据 | 文件 | 重算 sha256（LF） | 对比 |
| --- | --- | --- | --- |
| ev-g2-01 | `docs/gates/evidence/G2/ev-g2-01.md` | `71825a7db387884c2b9148dc991dc1415b2bb0d0605d05fb780a0990626a76a6` | 一致 |
| ev-g2-02 | `docs/gates/evidence/G2/ev-g2-02.md` | `346af5813c653ba967af948a74aba27201b9ac906f13e54f4e588f8b18ea70e1` | 一致 |
| ev-g2-03 | `docs/gates/evidence/G2/ev-g2-03.md` | `5929f803fadbbeabe0a9f9b5b0b65d2d52b429017eaceab56388f165d83d29be` | 一致 |
| ev-g2-04 | `docs/gates/evidence/G2/ev-g2-04.md` | `65946e22958ef8764415d2af693245f8dc8da33e585ba4cee094e36f56ac71a6` | 一致 |
| ev-g2-05 | `docs/gates/evidence/G2/ev-g2-05.md` | `6f3b44cf5589ddc059b77f3640e5a23f93eef8351d9c5fba9dd6510abc26e2ba` | 一致 |
| ev-g2-06 | `docs/gates/evidence/G2/ev-g2-06.md` | `cef5cf3de601985af216cb935334414d56ff9f3f296871f709332f9e16b1f91c` | 一致 |
| ev-g2-07 | `docs/gates/evidence/G2/ev-g2-07.md` | `64fa6c33ed9f4b33f5f8cc2306a8ad618d99d06ce1698e7aa1c8b537beeae05d` | 一致 |
| ev-g2-08 | `docs/gates/evidence/G2/ev-g2-08.md` | `86e30ab3215755f2a791614dce667b295a41c0afebce0a7f286920e23e0d9225` | 一致 |
| ev-g2-09 | `docs/gates/evidence/G2/ev-g2-09.md` | `f43b50982b67843db87e1cae9b36b0048eca372d9734904d3e1090fc97b8d8b2` | 一致 |
| ev-g2-10 | `docs/gates/evidence/G2/ev-g2-10.md` | `3f3ba0999a89c2986d382e974a68357d1da1e3d015681ea5b7c4f0af5bd543ab` | 一致 |
| ev-g2-11 | `docs/gates/evidence/G2/ev-g2-11.md` | `fb72ef55124d1b210ff4bf73ad1122cf067ecb93f96265e1fdfbdd050fc815dd` | 一致 |
| ev-g2-12 | `docs/gates/evidence/G2/ev-g2-12.md` | `5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe` | 一致 |
| ev-g2-13 | `docs/gates/evidence/G2/ev-g2-13.md` | `a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc` | 一致 |
| ev-g2-14 | `docs/gates/evidence/G2/ev-g2-14.md` | `61e9c435b7d6b652e87889190af7e932ff54799f4d21d4e2b538f5ec3f050896` | 一致 |
| ev-g2-15 | `docs/gates/evidence/G2/ev-g2-15.md` | `8c21ebd8e00ea8563f910fd2f3b3beb96b678812260620c9d0f05480e1f7ca6d` | 一致 |
| ev-g2-16 | `docs/gates/evidence/G2/ev-g2-16.md` | `8caea691cb48306c222f05fef387f96a5a5abf984cf05bb926eb420328575a76` | 一致 |
| ev-g2-g03 | `docs/gates/evidence/G2/G-03.md` | `514f9754fda67b8e1522d086fc6079301e00bd0185f9cca6dddec502c412ab70` | 一致 |
| ev-g2-g04 | `docs/gates/evidence/G2/G-04.md` | `a30155a2446531f5c5cd2677946805ca9a78f407cfc4626147f20fcd446eb961` | 一致 |
| ev-g2-g05 | `docs/gates/evidence/G2/G-05.md` | `d400f29ddeb1e0578c132e0a9abef1e0e3fc123179bfd90a692f526564285f4c` | 一致 |
| ev-g2-g07 | `docs/gates/evidence/G2/G-07.md` | `de51ca56aba24af02f7c1ef2c0bfba5248da11b5aaa7ba163aafacf9d8e0746a` | 一致 |

## P0 / P1 / P2

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| P0 | 0 | 无 |
| P1 | 0 | 无 |
| P2 | 1 | G2-16 计数文字未同步 |

### P2-1 G2-16 证据的桥闭环计数仍写 70

- 位置：`docs/gates/evidence/G2/ev-g2-16.md:50-51`、`docs/gates/G2.md:98`。
- 现状：两处写「6 files / 70 tests」「桥闭环 70 项」，本轮同一命令连续 4 次均为 6 files / 71 passed。
- 原因：候选在 `tests/integration/runtime.spec.ts` 新增了 1 个用例，桥闭环集合与必过路径集合都包含该文件，计数同步加 1；ev-g2-16 的辅助全量行已更新为 42 files / 624 passed | 1 skipped，桥闭环行没有跟着更新。
- 影响：B01–B10 的断言全部通过，G2-16 的证据结论本身成立；只是复现文字与实测计数差 1，按前两轮同类处置记为 P2。
- 处置建议：下一轮同步这两处文字（本轮不改候选，避免审计后候选文件变化导致本报告失效）。

## 残余观察（不计入 P0/P1/P2）

- 011 升级边界：若 011 之前的 `definition_json` 里曾内嵌 `workflow_id` 键，升级归入 default 后 hydrate 会因行键与快照身份不一致而拒绝启动。011 之前的公开入口没有这个字段，本轮未发现现实数据受影响，且行为是拒绝启动而非静默改写，列为观察。
- 预签态下的 candidate_hash 差异由签门脚本重算，不属于候选缺陷。

## 裁决

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 50,
  "candidate_commit": "bad33264d5799fffd0baad6ef424d18392aa1301",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 1,
  "must_pass_total": 20,
  "must_pass_passed": 20,
  "must_pass_ids": ["G2-01", "G2-02", "G2-03", "G2-04", "G2-05", "G2-06", "G2-07", "G-03", "G-04", "G-05", "G-07", "G2-08", "G2-09", "G2-10", "G2-11", "G2-12", "G2-13", "G2-14", "G2-15", "G2-16"],
  "failed_items": [],
  "notes": "20 项必过全过；P2 为 ev-g2-16 与 G2.md 的桥闭环计数 70 未同步到实测 71（新增 runtime 用例），B01–B10 断言成立。"
}
```
<!-- audit-verdict:end -->
