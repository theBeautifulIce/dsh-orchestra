# S2 独立审计 · 第 48 轮（R4 workflow_id + version 复合身份）

门：G2

候选提交：41a450f2fc6345345f7654ebe20daeebe58b37de

- 候选：`41a450f2fc6345345f7654ebe20daeebe58b37de`（`feat(r4): scope workflow versions by workflow id`，父提交 `7776df8`）
- 审计范围：G2 门 20 项必过、R4 对生产链路/证据/桥闭环的影响、G1/G2 证据字节一致性、预签态门记录
- 审计克隆：`D:\aboutAI\dsh-orchestra\tmp\audit-s2-r48`（HEAD 同候选，`git status --porcelain` 为空）
- 主仓 `D:\aboutAI\dsh-orchestra` 只读：未修改、未提交、未签门、未推送；`docs/gates` 未改
- 裁决：**PASS**（P0=0，P1=0，P2=2）

## 结论摘要

R4 把工作流身份从「version 单键」改成「(workflow_id, version) 复合键」，读旧口径统一归 `default`，旧哈希算法对 `default` 保持原样。独立复跑与定向探针没有发现跨工作流串用、错误策略执行或证据通道混淆；迁移 011 对旧库是纯重命名/加列，不改 runs/tasks 行，旧 NULL 行在读侧稳定归 `default`。G2 20 项实质全部通过，20 份 G2 证据哈希与 HEAD 字节 20/20 一致，25 份注入证据两遍重生成字节一致。

两处 P2 都是门记录/证据文字层面的过期，不改变必过项结论：ev-g2-16 的全量用例计数仍写 607/41（HEAD 实为 612/42），且该证据不在 `check-evidence-repro` 覆盖清单；G2-15 描述仍用 R4 前的「同一工作流版本」全局口径，未写明按 `workflow_id` 命名空间。建议在重签前顺手修掉。

## 缺陷清单

### P0

无。

### P1

无。

### P2

**P2-1  ev-g2-16 的全量用例计数过期，且不在证据复现守卫覆盖内**

- 位置：`docs/gates/evidence/G2/ev-g2-16.md:54` 与 `scripts/check-evidence-repro.ts:12`
- 证据：ev-g2-16 第 54 行仍写 `-> 41 files passed, 607 passed | 1 skipped`；HEAD 上独立连跑三次 `pnpm test` 都是 **42 files，612 passed | 1 skipped**（见下表）。R4 新增 `tests/integration/workflow-identity.spec.ts`（3 例）与 `tests/integration/workflows.spec.ts` 增例（2 例），同批未重生成 ev-g2-16。`scripts/check-evidence-repro.ts` 的 `CASES` 只列 G2 的 ev-g2-01…15 与 G-03/04/05/07（共 19 份），显式不含 ev-g2-16，所以守卫不会点名这份漂移。
- 影响：G2-16 自身断言（B01–B10、桥闭环 6 文件 70 项、工具证据只来自宿主执行）全部仍可复现（4 次 70 passed），没有被推翻；过期的只是支撑性的全量计数，故列 P2 而非 P1。但它使 HEAD 上这门证据的「命令与输出」有一行不可复现，建议下发前重生成 ev-g2-16（并同步 G2.md 的 `evidence_index_hash`），或把该文件纳入人工复核清单。
- 复核依据：`handoff.md:1088` 已写「全量 42 文件 612 passed | 1 skipped」，说明改动者知道新计数，只是漏改证据文件。

**P2-2  G2-15 的必过项措辞仍是 R4 前的「版本号全局唯一」口径**

- 位置：`docs/gates/G2.md:49`（artifact 内对应 statement 同文）、`docs/gates/evidence/G2/ev-g2-15.md`
- 证据：G2-15 写「同一工作流版本跨重启不可改写」，R4 后语义已变成「同一 `workflow_id` 下的同一版本不可改写；不同工作流可以各有版本 1」。独立探针用 wf-a/wf-b 同版本各自 load/建 run 成功，省略 `workflowId` 才报 `WORKFLOW_VERSION_CONFLICT`；`tests/integration/workflow-identity.spec.ts` 与 `tests/integration/workflows.spec.ts:126,138` 同样固定这一新口径。
- 影响：不是行为缺陷，是门记录措辞可能让后续审计误以为版本号仍全局唯一。建议重签时把必过项文字改成「同一 workflow_id 下同一版本跨重启不可改写，在飞 run 的判定条件不跟着变」，并同步 artifact statement 与正文表（`body_hash` 会随重签重算）。

## R4 逐点核查

### 1. 迁移 011 与旧库语义

- `src/infra/sqlite/migrations/011_workflow_version_identity.sql:5-21`：新建 `workflow_versions_v11`，`PRIMARY KEY (workflow_id, version)`；`INSERT … SELECT 'default', version, content_hash, definition_json, created_at FROM workflow_versions`；`DROP`、`RENAME`、补 `workflow_versions_version_idx(version)`。没有 UPDATE/DELETE 其他表。
- 定向探针（`tmp/probe-r4.ts`）在旧库先跑到第 10 步，再跑 011：只新增一步，`workflow_versions` 主键变为复合键，旧定义全部归 `default` 且 `content_hash` 一字不变，`runs`/`tasks`/`node_runs` 行与列未变，旧 run 的 `workflow_id` 仍是 NULL（读侧归 `default`）。全量迁移再跑一遍 `applySteps` 返回空数组，幂等成立。
- `WorkflowCatalog.hydrate()`（`src/service/workflows.ts:42-58`）按 `workflow_id, version` 读回并逐行重算哈希；探针在不重新 load 的情况下关闭/重开同一 DB，`get('wf-b','1')` 正常，新建 run 的哈希等于 `definitionHashOf(defB)`。
- 老库中若 run 的 `workflow_definition_hash` 为空，`apply-report.ts:104-109` 与 `run-node.ts:152-155` 会以 `VERDICT_UNSUPPORTED` 拒绝，这是既有防线；R4 前 `createRun` 本就写该哈希，正常旧库不会出现空哈希行（探针首轮误造的空哈希行已排除，属夹具错误）。

### 2. 证据哈希与重生成

- 独立脚本 `tmp/verify-hashes.ts`：G2 证据表 20 行、`evidence-index` 20 条，id 集合一致，20/20 的 `sha256` 与 HEAD 字节（CRLF→LF 归一）一致；G1 证据表 6 行、`evidence-index` 13 条也全部一致（G1 表少 7 行是旧布局，不是本轮问题）。
- `node --no-warnings scripts/check-evidence-repro.ts` 退出 0：「证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致」。这覆盖 G1 6 份、G2 19 份，证明证据是重生成而非只改哈希。
- `git show 41a450f -- docs/gates/G2.md` 只有 6 处改动：3 行证据表哈希 + 3 个 `evidence-index` JSON 哈希，必过项、例外表、复现命令文字均未动。三份被重生成的证据（ev-g2-01/07/15）改动只是响应/细节里多了 `workflow_id`，与 R4 语义一致。

### 3. 两个工作流同版本的生产隔离

`tmp/probe-r4.ts` 29 项全 PASS（exit 0），覆盖 HTTP 全链路：

- wf-a、wf-b 各有版本 1，`POST /v1/workflows/load` 均 HTTP=200 且响应带各自 `workflow_id`；省略 `workflowId` 建 run 返回 409 `WORKFLOW_VERSION_CONFLICT`，`runs` 表 0 行（不猜）。
- 两个 run 的 `workflow_id`、`workflow_definition_hash` 互不相同；节点按各自定义生成；wf-a 派发 `ro.echo` → done、`evidence_source=run_tool`，wf-b 派发同一工具 → failed/`FORBIDDEN`、节点仍 queued。
- 更尖锐的同 `node_id` 攻击：wf-c 与 wf-a 同版本、同 `node_id=a`，只把 allow 改成 `ro.fail`；派发 `ro.echo` 被 wf-c 自己的策略拒（failed/`FORBIDDEN`），且建出独立 `node_run`。策略解析确实按 `(run.workflow_id, run.workflow_version, node_id)`，不存在按 node_id 串用。
- 事件隔离：wf-a 节点有 `report_applied`/`tool_finished`，wf-b 节点无 `report_applied`/`tool_started`；两个 `run.created` 各自记录 `workflow_id`。
- 旧 NULL run（补齐哈希后）派发 → done，证明旧行归 `default` 的判定链完整。

代码落点：`runs.ts:37` 二选一取定义、`:64-72` 双表写 `workflow_id`、`:84-92` 事件与返回带 id；`run-node.ts:145-156` 与 `apply-report.ts:99-121` 都从 run 行取 `(workflow_id ?? 'default', workflow_version)`，且 apply-report 还比对 `workflow_definition_hash`。所有 `catalog.*` 调用点只有 `index.ts:74,117`、`runs.ts:37`、`run-node.ts:156`、`apply-report.ts:112,121`，没有漏网的「只按 version 取定义」生产路径。

### 4. 旧 NULL 行归 default 的一致性

- 写侧：R4 起 `tasks`/`runs` 都写 `workflow_id`；读侧：`runNode`、`applyReport`、`hydrate` 对 NULL 统一 `?? 'default'`；旧定义的哈希算法对 `default` 保持旧值（`workflows.ts:224-230` 只在显式非 default id 时才把 id 纳入哈希），所以旧 run 的 `workflow_definition_hash` 仍能对上。
- 观察（不计缺陷）：`GET` 任务列表透传 `tasks.workflow_id`（`src/service/queries/list_tasks.ts:32`），旧任务会显示 `null` 而不是 `default`。这是展示层的历史事实，执行/证据都不依赖该字段；后续消费者仍须沿用 NULL→default 约定。

### 5. G2-16 桥生产闭环在复合身份下

- 6 文件桥闭环命令连跑 4 次：每次 6 files / 70 passed，exit 0；B06/B07 专项计时一次：B06 `131ms`、B07 `53ms`，远低于 5s 上限；四次中 B16 收口 2028ms、runtime 两个长测 2094ms/3113ms，为最接近上限者，均未超时/抖动。
- B08（dispose 前 ACK 落后）与 B10（断线重连）在 `tests/integration/agent-lifecycle.spec.ts` 13 例中全过；B07 真实 `node -e setInterval` 子进程、B06 独立子进程写 outbox+marker 后 SIGKILL 的路径均在 `agent-lifecycle.spec.ts:229`、`runtime.spec.ts:349` 复跑通过。
- 桥协议本身不读工作流版本；R4 只改 run 的身份与策略解析，未改事件/回执/游标结构，桥闭环不受影响。

### 6. 门记录、例外表、复现路径、计数

- 例外表三行（`docs/gates/G2.md:108-110`）与第 47 轮一致：LEASE_EXPIRED / DECISION_REQUIRED 仍为 proposed；BRIDGE_ACK_LAG 仍写「R5 已接桥调用，B08 客户端层可复现，生产端到端待 S3（F-06）」，R4 未触碰该路径，描述未过期。
- 复现命令里的两个计数与实跑一致：桥闭环 70 项 ✓、必过路径 124 tests ✓；全量命令的计数只出现在 ev-g2-16（P2-1）。
- ev-g2-01/07/15 的证据表与 index 哈希已同步重生成；其余 17 份未变且字节一致。
- 结论：G2 门记录文字只有 P2-1/P2-2 两处过期，没有把未复现的结果写成 pass。

### 7. 预签 gate-check 失败归因

- `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` → exit 1，唯一输出：「门检查失败：审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：codebasemap.md」。G1 同样 exit 1、同一句。这是 `scripts/gate-check.ts:2482-2485` 的「审计报告锚定的候选提交之后候选文件又变」检查，因 artifact 仍指向第 47 轮报告（其绑定候选为 `c17a0c7`）而必然先停在这一步，属预签态，不是代码失败。
- 独立重算（`tmp/verify-artifact.ts`，按 sign-gate 同原像）：
  - `candidate_hash` 存储 `669b5abc610f…` vs HEAD 重算 `d93fb55325c19c44d1b238bd95f231f15e2be1a0c5bc155932603a2cfddfe76f`（过期，待重签）
  - `change_scope_hash` 存储 `ce296355ed06…` vs 重算 `bebd05bb119db54168922efcef767cef252936a0b8cf789a089c5800e4ffd3f0`（过期）
  - `evidence_index_hash` 存储 `89bcc2bf6bc9…` vs 重算 `d1acbb2cb394f2b662e68f5b64916ea3443945ce31c9760d3a72817ef55c8087`（过期）
  - `invariants_hash` `6a7adcb05ef5…` 一致；`audit_report_sha256` `cffc6e5fcb89…` 一致（第 47 轮报告字节未变）
  - `artifact_hash` 与 `canonicalJson(artifact)` 自洽；`body_hash` 当前不自洽（R4 改了 evidence-index JSON 块），但 `41a450f^` 的同文件 `body_hash` 自洽为 true，说明只是未重签，不是伪造；重签时 sign-gate 会重算。
- 结论：预签失败只因 artifact 仍锚第 47 轮，未发现绕过门检查的路径（证据哈希、必过项固定清单、四个哈希原像均可重算）。

## G2 20 项逐项

| 必过项 | 结论 | 独立依据 |
| --- | --- | --- |
| G2-01 | pass | 探针 HTTP load→runs→dispatch wf-a 节点 done，`report_applied`、`evidence_source=run_tool`；ev-g2-01 两遍重生成字节一致 |
| G2-02 | pass | ev-g2-02 两遍重生成字节一致；`g2.spec.ts` 与全量 3 次全绿 |
| G2-03 | pass | ev-g2-03 重生成字节一致（真实服务端时钟）；全量 3 次全绿 |
| G2-04 | pass | ev-g2-04 重生成字节一致；取消路径用例全绿 |
| G2-05 | pass | ev-g2-05/ev-g2-10 重生成字节一致；终态证据门用例全绿 |
| G2-06 | pass | ev-g2-06 重生成字节一致；无裸 blocked 用例全绿 |
| G2-07 | pass | ev-g2-07 重生成字节一致（新增 `workflow_id: default` 响应字段）；parallel 拒绝用例全绿 |
| G-03 | pass | G-03 重生成字节一致；重复 report_id 用例全绿 |
| G-04 | pass | G-04 重生成字节一致；迟到上报用例全绿 |
| G-05 | pass | G-05 重生成字节一致；取消围栏用例全绿 |
| G-07 | pass | G-07 重生成字节一致；墙钟跳变用例全绿 |
| G2-08 | pass | ev-g2-08 重生成字节一致；工具失败判失败用例全绿 |
| G2-09 | pass | ev-g2-09 重生成字节一致；boot_id/单调纳秒用例全绿 |
| G2-10 | pass | ev-g2-10 重生成字节一致；系统级证据门用例全绿 |
| G2-11 | pass | ev-g2-11 重生成字节一致；重投不刷膨胀用例全绿 |
| G2-12 | pass | ev-g2-12 重生成字节一致；探针验证派发只认 run 绑定的定义（wf-b 同工具被拒） |
| G2-13 | pass | ev-g2-13 重生成字节一致；单写者锁/epoch 用例全绿 |
| G2-14 | pass | ev-g2-14 重生成字节一致；心跳续租长动作用例全绿（3113ms < 5s） |
| G2-15 | pass | 探针验证同工作流同版本不可改写、别名撞车被拒、两工作流可各持版本 1；ev-g2-15 重生成字节一致（措辞见 P2-2） |
| G2-16 | pass | 桥闭环 6 文件 ×4 均 70 passed；B06 131ms、B07 53ms 不超时；B08/B10 全过；生产路径探针与 `production-path.spec.ts` 5 例全绿 |

## 命令与关键输出

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | Done in 3.6s，lockfile 未变 | 0 |
| `pnpm typecheck` | `tsc --noEmit` 无输出 | 0 |
| `pnpm test` 第 1 次 | 42 files，**612 passed \| 1 skipped**（613） | 0 |
| `pnpm test` 第 2 次 | 42 files，**612 passed \| 1 skipped** | 0 |
| `pnpm test` 第 3 次 | 42 files，**612 passed \| 1 skipped** | 0 |
| `pnpm build` | ESM `lib/index.js` 152.60 kB / gzip 37.89 kB，d.ts 14.30 kB | 0 |
| `node --no-warnings scripts/check-evidence-repro.ts` | 25 份、每份两遍，均与 HEAD 字节一致 | 0 |
| 桥闭环 6 文件 第 1 次 | 6 files，**70 passed** | 0 |
| 桥闭环 6 文件 第 2 次 | 6 files，**70 passed** | 0 |
| 桥闭环 6 文件 第 3 次 | 6 files，**70 passed** | 0 |
| 桥闭环 6 文件 第 4 次 | 6 files，**70 passed** | 0 |
| G2 必过路径 6 文件 | 6 files，**124 passed** | 0 |
| `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` | 仅「审计报告候选之后候选文件又被改过：codebasemap.md」 | 1（预签预期） |
| 同上 `docs/gates/G1.md` | 同一句失败 | 1（预签预期） |
| 补充：B06/B07 计时 | `runtime.spec.ts` B06 131ms、`agent-lifecycle.spec.ts` B07 53ms，35 passed | 0 |
| 补充：R4 定向探针 | 29 项全 PASS（迁移旧库、HTTP 同版本双 wf、同 node_id 攻击、旧 NULL run、重启水合） | 0 |
| 补充：证据哈希复算 | G2 20/20、G1 6 表行 + 13 index 全一致 | 0 |

日志在克隆 `tmp-install.log`、`tmp-typecheck.log`、`tmp-test1..3.log`、`tmp-build.log`、`tmp-repro.log`、`tmp-bridge1..4.log`、`tmp-g2path.log`、`tmp-gatecheck-g1.log`、`tmp-b0607.log`；探针 `tmp/probe-r4.ts`、`tmp/verify-hashes.ts`、`tmp/verify-artifact.ts`。

## 剩余风险

1. **重签顺序**：R4 必须重签 G1→G2；当前 artifact 的四个聚合字段与 `body_hash` 都是第 47 轮值。若先签 G2 会读到旧 G1 锚点。建议先落 P2 修正再签。
2. **ev-g2-16 无复现守卫**：该文件不在 `check-evidence-repro` 的 CASES 中，计数漂移只能靠人工发现；同类漂移以后还会发生，建议纳入人工复核或生成链路。
3. **旧 NULL 行只靠读侧兜底**：`runs.workflow_id` 旧行仍为 NULL（迁移刻意不改写）；所有新消费者都必须沿用 `?? 'default'`，任务列表 API 现在直接透传 null，属展示层不一致。
4. **hydrate 不核对列与定义内的 workflow_id**：`workflow_versions.workflow_id` 与 `definition_json.workflow_id` 未做交叉断言；正常写入路径两者一致，只有手工篡改库才可能不一致，且篡改者本可重算哈希。属加固项，不是可达缺陷。
5. **桥耗时余量**：B16 2028ms、runtime 两个长测 2094/3113ms，离 5s 上限仍有约 1.9–2.9s；B06/B07 本身余量充足（131ms/53ms）。
6. **G1 旧布局**：G1 证据表只列 6 行而 index 有 13 条，gate-check 接受该旧布局；本轮未改 G1 版式，只复核了字节一致性。

## 附：审计边界

- 本报告只写进独立克隆，未改主工作树、未提交、未运行 sign-gate、未改 `docs/gates`。
- 候选完整哈希由 `git rev-parse HEAD` 在克隆内确认：`41a450f2fc6345345f7654ebe20daeebe58b37de`。
- 所有计数均为本机实跑，不采信主仓/handoff 自述；预签 gate-check 的 exit 1 按任务约定不作为代码失败依据。
