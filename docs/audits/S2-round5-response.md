# S2 第五轮独立审计整改对照表

审计报告：`docs/audits/S2-independent-audit-round5.md`（结论 fail：致命 1 / 重大 3 / 不阻断 4）。
本表逐条说明改法、落点与验证。判定口径未变：审计没过不开 S3。

## 一、致命

### P0-1 门记录拿结论为 fail 的审计报告签 pass

- 改法：门检查读审计报告正文里的结论行，报告结论与门记录结论不一致就拒绝；认 `结论：pass/fail/通过/不通过` 与 `建议：通过/不通过`，也认结论后换行再写结论词；找不到结论行同样拒绝。
- 落点：`scripts/gate-check.ts:428` 的 `auditConclusionOf`，`scripts/gate-check.ts:436` 的 `checkAuditAnchor` 在轮次与 HEAD 校验后调用，`scripts/gate-check.ts:532` 进入校验链。
- 回归：`tests/gate-check.spec.ts` 新增「审计报告结论必须与门记录一致（第五轮审计 P0-1）」，覆盖 pass、fail、不通过、通过、只写建议、找不到结论六种输入。
- 待办顺序：新审计给出结论为 pass 的报告后，G2 的 `audit_round` / `audit_report` 指向该报告并重签；G1 同样要换成 S1 第二轮复核的 pass 报告。门记录不会再拿 fail 报告充数。

## 二、重大

### P1-1 同一工作流版本 reload 改写 run 的在飞判定

- 改法：同一版本号只允许一份定义。再次 load 时比较规范化 JSON，内容不同抛 `WORKFLOW_VERSION_IMMUTABLE`（409）；内容相同返回摘要，不覆盖。纯数字版本号的别名也做同样比对。
- 落点：`src/service/workflows.ts:19` 的 `load`，异常码在 `src/core/errors.ts:40`。
- 回归：新增 `tests/workflows.spec.ts` 五例：同内容重复加载、改判定条件即拒、改工具授权即拒、授权返回副本、节点不存在报错。

### P1-2 工具授权仍由调用方请求体自带

- 改法：
  1. 执行器不再收 `toolPolicy`。`runNode` 按 `node_run → runs.workflow_version` 反查目录，取该节点定义里的 `tools.allow/deny`；调用方传别的 `nodeId` 借不到另一节点的授权（`src/executor/run-node.ts:101` 的 `policyForNodeRun`，身份以账本 `node_runs.node_id` 为准）。
  2. HTTP `/v1/node-runs/run` 与派发器、`RunNodeParams` 不再有 `toolPolicy` 字段（`src/service/server.ts`、`src/service/dispatcher.ts`、`src/executor/run-node.ts`）。
  3. 只读执行的参数只认注册表固定数组，请求里的 `args` 不再覆盖（`src/executor/tools.ts:199`）。
- 回归：`tests/production-path.spec.ts` 新增「授权只认定义」：定义 allow 只有 `ro.echo` 时跑 `ro.fail` → `FORBIDDEN`；allow 为空 → `FORBIDDEN`；allow 未注册的 `ro.ghost` → `TOOL_NOT_REGISTERED`；三种都在租约前被拒，节点仍 queued；请求体即使带更宽的 `toolPolicy` 也不生效。`tests/runtime.spec.ts` 新增「传别的 nodeId 借不到授权」，断言 `STALE_GENERATION` 且节点仍 queued。`tests/run-tool.spec.ts` 改为断言请求 `args` 被忽略。
- 证据：`ev-g2-12`，必过项 G2-12。

### P1-3 createOrchestra 绕过单写者锁与 epoch

- 改法：`createOrchestra` 增加模块私有锁凭证参数。只有 `openServiceOrchestra` 在 `acquireDbLock → bumpEpoch → openServiceDb` 之后能把凭证传进来；外部直接调用抛 `FORBIDDEN`。
- 落点：`src/index.ts:43` 的 `ORCHESTRA_LOCK_PROOF`，`src/index.ts:47` 的断言，`src/index.ts:119` 内部传凭证。
- 连带：测试与故障注入全部改走 `openServiceOrchestra`（`tests/runtime.spec.ts`、`tests/routes.spec.ts`、`tests/production-path.spec.ts`、`scripts/fault-inject.ts`），收尾释放锁。
- 证据：`ev-g2-13`，必过项 G2-13。实测首个写者 epoch=1、第二把锁 `ELOCKED`、外部 bump 到 2 后老连接写 `STALE_GENERATION`。

## 三、不阻断

### P2-1 M4 长动作、动作超时与续租失败收口

- 改法：
  1. 动作总时限读 `actionTimeoutMs`（默认 `DEFAULT_ACTION_TIMEOUT_MS = 120_000`），单条工具超时取剩余额度与工具自身超时的较小值；额度用光按 `action_timeout` 收口（`src/executor/run-node.ts:144` 起）。
  2. 续租失败不再空吞：写 `lease_lost` 事件并保留标记，动作结束后按租约丢失 `markBlocked('lease_lost')`，不再误标 `verify_timeout`（`src/executor/run-node.ts:75-90`、`:224`）。
  3. 租约与续租间隔可从 HTTP 下传，长动作用例可配 2 秒租约、500 毫秒续租（`src/service/server.ts`、`src/service/dispatcher.ts`、`src/index.ts`）。
- 回归：`tests/runtime.spec.ts` 新增「长动作：心跳把租约续上，2.5 秒时的扫描不判过期」：动作 3 秒、租约 2 秒，2.5 秒扫描时节点仍 started、无 `lease_expired`，最终 done。
- 证据：`ev-g2-14`，必过项 G2-14。

### P2-3 ev-g2-10 实体 ID 对调

- 改法：证据规范化时全篇共用一套实体映射，`params` / `before` / `after` / `reconcile` 不再各自建映射（`scripts/fault-inject.ts` 的 `normalizeEvidence` 与 `writeEvidence`）。
- 结果：重生成 `ev-g2-10` 后，恢复片段与对账查询一致：`nrun_1` 在前三段为 verifying、`nrun_2` 为 done，登记表与工具痕迹同向；哈希在 G2 表更新。

## 四、仍未闭合、登记留 S3

- P2-2 门检查的证据文件仍可由门记录换绑；前序门只做字符串比较；`body_hash` 归一化把反引号里的 64 位十六进制替换为占位符。这是门工具的加固缺口，当前记录未发现实际换绑，留 S3 做证据路径固定映射、前序 artifact 重算与正文哈希归一化收紧。
- P2-4 服务端命令的 `now` 仍取请求体，sweep 用主机墙钟。S2 的测试与故障注入依赖脚本化时间，统一时钟要连带改测试夹具，留 S3 做「服务端取时 + 拒绝明显偏离」。
- N3 门记录无密码学签名，沿用既有登记。

## 五、验收

- 类型检查：`D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit` exit 0。
- 全量用例：待跑；`tests/gate-check.spec.ts` 在换 pass 报告与重签前会红，这是 P0-1 生效后的预期。
- 证据：`ev-g2-12/13/14` 已生成，各连跑两次 sha256 一致；`ev-g2-10` 已按统一映射重生成。
- 门记录：G2 已加 G2-12/13/14 三项、三份证据、I8/I9/I10 三条不变量；G1/G2 的审计锚与哈希待第六轮独立审计给出 pass 报告后重签。
