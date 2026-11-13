# S2 第二十三轮审计整改对照表

- 审计报告：`docs/audits/S2-independent-audit-round23.md`（288 行，审计对象 HEAD `1e83391`）
- 整改提交：`53495fc`「Bind terminal evidence, server clock, and visible fail windows」
- 本表用途：逐条对应 P0、改法、回归用例。**本表不作为放行依据**——G2 是否过关由下一轮独立审计决定。

## P0-1 报告可见否定句仍被读成肯定

- 根因：`FAIL_SUBJECT` 不认裸「审计」；压缩字符集不删连接号/破折号；没有英文否定判定。
- 改法：`scripts/gate-check.ts:633` 的 `FAIL_SUBJECT` 增加 `|审计`；`:639` 的压缩字符集增加 `-—–―−`；`:650` 增加英文判定 `/\b(?:the\s+)?(?:audit|review)\b[^.\n]{0,30}\b(?:failed|not\s+passed|did\s+not\s+pass)\b/i`。英文判定直接跑原始行，不跑压掉空白的 `compact`，否则 `The audit failed.` 会变成 `Theauditfailed.` 而失去词边界。
- 用例：`tests/gate-check.spec.ts`「S2 第二十三轮 P0-1」，覆盖 `审计未通过`、`结论 - fail`、`结论—fail`、`The audit failed.`、`The review did not pass.`；保留 `审计未通过项为 0` 不误杀的阳性对照。

## P0-2 同一 attempt 已有失败工具行，done 仍被接受

- 根因：`traceBindingGate` 只查 `exit_code, stdout_hash`，并用 `some` 找一条匹配行；同一 attempt 里另一条失败工具行被忽略。
- 改法：`src/service/commands/apply-report.ts:331-348` 查同 `node_run_id + attempt` 的全部 `tool_executions`；空表 `evidence_unverifiable`；任一行 `exit_code !== 0` 直接 `tool_execution_failed`；证据必须与某一行 `tool/exit_code/stdout_hash/stderr_hash/command_hash` 全等。
- 用例：`tests/apply-report.spec.ts` 新增「同 attempt 有失败工具行时 done 被拒」；夹具同时写 `tool_executions` 与 `tool_finished`。

## P0-3 租约用客户端 now 可回拨

- 根因：`/lease`、`/renew`、`/report`、`/run`、`/cancel` 都把 `body.now` 原样传给命令层，租约过期判定因此可被请求体回拨。
- 改法：`src/service/server.ts:26-32` 增可选 `ServerDeps.now`；`:72-75` 增 `serverNow(deps)`，生产缺省读系统墙钟；`handle` 每个请求只取一次 `requestNow`，上述路由全部改用它。`requireFields` 同步去掉 `now`，客户端发来的 `now` 不再进入判定；测试通过注入固定时钟保留既有固定时刻用例。
- 用例：`tests/routes.spec.ts`「上报时间以服务端时钟为准，body.now 不能回拨租约」：租约 ttl=1000，服务端时钟推进到 `2026-11-13T03:00:02.000Z`，report 仍带 `now=NOW`，HTTP 非 200 且 `error.code=LEASE_EXPIRED`。

## P0-4 证据强度只绑键名与部分字段

- 根因：`evaluateEvidence` 的 `requiredHashes` 只查 `Object.keys`；`traceBindingGate` 不查 `command_hash`、工具名、`producedAt`、`tool_finished`。
- 改法：
  - `src/core/policy.ts:33-45`——`requiredHashes` 每一项必须是 64 位 hex，值写 `not-a-real-hash` 或只给键名一律 `verification_too_weak`。
  - `src/core/report.ts:10-12`、`src/executor/tools.ts:140-142/:214`——证据结构增 `tool`、`commandHash`，执行器落库时同时写入。
  - `apply-report.ts:319-329`——证据必须带 `tool`、64 hex `commandHash`、可解析 `producedAt`。
  - `apply-report.ts:350-369`——还要求同 attempt 存在 `tool_finished` 事件，payload 的 `tool/exit_code/stdout_hash/stderr_hash/command_hash` 与证据全等，否则 `evidence_unverifiable`。
- 用例：`tests/apply-report.spec.ts` 新增 `requiredHashes` 假值、`commandHash` 不与账本对齐、`tool_finished` 缺失三类拒绝；`tests/integration/g2.spec.ts` 的 `goodReport` 补齐 `tool/commandHash`，夹具的 `tool_executions` 与 `tool_finished` 的 stderr 哈希同步为 `HASH_B`。

## P1-1 失败/超时终态无证据也可收口

- 根因：证据与判定门只包在 `report.status === 'done'` 分支里，`failed`/`timeout` 不带证据也能落终态。
- 改法：`apply-report.ts:226-233` 在 done 分支前新增 `terminalEvidenceGate`：无证据 `evidence_missing`；source 不是 `run_tool` `verification_too_weak`；exitCode 不是数字 `evidence_missing`。失败终态允许非 0 退出码，但证据必须存在且可核对。
- 用例：`tests/apply-report.spec.ts` 新增「failed 缺证据被拒」「failed 带证据可收口」两例。

## 验收

- `tsc --noEmit` → `TSC_EXIT=0`。
- `tests/integration/g2.spec.ts` + `tests/apply-report.spec.ts` → 2 文件 / 47 例全过（定向）。
- `tests/gate-check.spec.ts` → 71 例，60 passed / 11 failed；11 红全部是 G1 预签态（`audit_report_sha256=0*64` 对实际 `50ba1b13…`），无新增解析器回归。
- 全量 `vitest` → 32 文件 / 340 例，329 passed / 11 failed，仍全部是预签态。
- `tests/routes.spec.ts` → 5 passed（含新增服务端时钟用例）。

## 未做与边界

- G1/G2 未重签；当前门记录仍是预签态，不能拿本表当放行依据。
- `docs/audits/S1-round19-response.md` 记录同批 S1 第十九轮的四条解析器 P0。
