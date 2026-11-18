# S5 · G5 面板侧八项就绪矩阵补丁（WP-A）

> 目的：给 Lead 一张「WP-A 负责的八条 G5 必过项 × 代码位置 × 证明用例」的补丁矩阵，只覆盖面板侧。
> 判定语逐字照抄 `scripts/gate-check.ts` 的 `GATE_SPECS.G5.content`（`docs/reviews/S5-g5-item-map.md` 是其拷贝），未改写、未新增、未删减。
> 证据 id 规则 `ev-g5-<item-id 小写>`，固定路径 `docs/gates/evidence/G5/<ITEM-ID>.md`（由 Lead 后续跑 `scripts/gen-g5-evidence.ts --matrix docs/reviews/S5-g5-item-map-wpa.md` 生成；本会话不创建任何 `docs/gates/**` 文件）。
> 判定语里的每个子句都有断言，「证明用例」列的命令可在仓库根直接执行且当前通过。

| 编号 | 判定语 | 证明用例 | 状态 | 缺口与建议 |
| --- | --- | --- | --- | --- |
| Q-02 | 分页途中插入新任务时面板按 task_id 去重、后页覆盖前页 | `pnpm vitest run tests/client/panel-status.spec.tsx -t "Q-02"` | proved | 无 |
| Q-05 | succeeded_with_unverified 在面板是独立黄色状态并带未验证数量 | `pnpm vitest run tests/client/panel-status.spec.tsx -t "Q-05"` | proved | 无 |
| Q-06 | failed_with_unverified 深红显示并带未验证角标 | `pnpm vitest run tests/client/panel-status.spec.tsx -t "Q-06"` | proved | 无 |
| Q-07 | blocked 且 settling 时同时显示「等你决定」与「仍有未结算不可逆动作」 | `pnpm vitest run tests/client/panel-status.spec.tsx -t "Q-07"` | proved | 无（「等你决定」由任务级 `open_decision_count` 触发、「仍有未结算不可逆动作」由任务级 `unverified_count` 触发，不是 settling 专属；blocked 且 settling 的场景已被用例同时断言到两条文案） |
| Q-19 | 心跳超 30 秒显示「心跳已停 X 秒」，节点状态保持原值 | `pnpm vitest run tests/client/panel-status.spec.tsx -t "Q-19"` | proved | 无（`NodeRunView` 只有 `heartbeat_at`，秒数在 `src/client/panel/task-detail-screen.tsx` 内就地按 `heartbeat_at` 与当前时间算；终态节点不再提示心跳，状态文字一个字不改） |
| Q-20 | 服务停止后面板显示最后一次快照加 stale，命令按钮禁用 | `pnpm vitest run tests/client/panel-screens.spec.tsx -t "Q-20"` | proved | 无（实现原已在 `src/client/panel/shell.tsx`，本轮只补断言：服务停止时快照仍在、`stale` 提示在、命令按钮 `disabled`，并用服务正常分支证明按钮不是常灰） |
| Q-22 | 面板无 orchestra.db 写权限也能工作，静态检查无 sqlite 直连 | `pnpm vitest run tests/unit/panel-no-sqlite.spec.ts -t "Q-22"` | proved | 无（静态检查脚本 `scripts/check-panel-no-sqlite.mjs` 扫 `src/client/**` 的 `sqlite`、`orchestra.db`、`node:sqlite`、`better-sqlite3`、`:memory:` 痕迹，命中打印文件行号并退出 1，干净退出 0；用例同时喂了一份含 `orchestra.db` 的假目录证明脚本会真抓出来，不是空壳断言） |
| Q-23 | 任务标题里的 HTML 按纯文本显示 | `pnpm vitest run tests/client/panel-status.spec.tsx -t "Q-23"` | proved | 无 |

## 本轮改动位置

- `src/client/panel/tasks-screen.tsx`：分页合并去重 `mergeByTaskId`、未验证终态独立文案与色板 `UNVERIFIED_STATUS` / `statusView` / `unverifiedStatusView`、未验证角标、待裁决与未结算动作提示。
- `src/client/panel/task-detail-screen.tsx`：运行状态独立标签 `RunStatusLabel`、待裁决与未结算动作并列 `PendingNotices`、心跳停摆提示 `heartbeatNotice`（只影响显示）。
- `src/client/panel/copy.ts`：新增「等你决定」「仍有未结算不可逆动作」「心跳已停」与两种未验证终态文案、未验证角标后缀。
- `scripts/check-panel-no-sqlite.mjs`（新建）、`tests/unit/panel-no-sqlite.spec.ts`（新建）、`tests/client/panel-status.spec.tsx`（新建）、`tests/client/panel-screens.spec.tsx`（补 Q-20 断言）、`tests/client/harness.ts`（补 `runSummary` / `nodeRunView` 夹具）。

## 复跑

- 全量：`pnpm vitest run`（本轮：109 个测试文件全过，1335 passed / 2 skipped）。
- 类型：`pnpm typecheck`（退出码 0）。