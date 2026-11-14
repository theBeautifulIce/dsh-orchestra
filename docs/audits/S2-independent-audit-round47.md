# S2 独立审计（第 47 轮）：G2 门

门：G2
候选提交：c17a0c76ed342364daf8972684e283290a3fbd00
审计轮次：47
审计者：s2-audit-r47（独立克隆 `D:\aboutAI\dsh-orchestra\tmp\audit-s2-r47`）
时间：2026-11-14

结论：pass

本报告只写进独立克隆，未改主工作树、未提交、未运行 sign-gate、未改 `docs/gates`。第 46 轮在 9cefb87 给出 P1=1（P0=0/P1=1/P2=3）的裁决，本候选声称修三处：ev-g2-03 用真实服务端时钟复现租约过期、G2.md 桥闭环计数与复现路径对齐、ev-g2-16 收窄真实进程表述并补 B10 落点。以下全部为独立复跑与重算结果，不采信主仓自述。

## 一、隔离与基线

- 主仓 `D:\aboutAI\dsh-orchestra` 的主工作树干净，HEAD 与 origin/main 都是 `c17a0c76ed342364daf8972684e283290a3fbd00`，父提交 `9cefb87`。
- 审计克隆由主仓 `git clone --no-hardlinks . tmp\audit-s2-r47` 建立（先删旧目录），再 `git checkout --detach c17a0c7…`；克隆 HEAD 同为候选，初始 `git status --porcelain` 为空。
- 安装、类型检查、全量用例、桥闭环用例、构建、证据复现、故障注入、门检查全部在克隆内执行；克隆内 `node_modules` 独立。探针脚本与注入输出只写克隆的 `tmp/`（gitignore）。故障注入自建 SQLite 于系统 `%TEMP%` 是该脚本的固有行为，不写主仓。
- 候选改动仅 4 个文件：`scripts/fault-inject.ts`、`docs/gates/G2.md`、`docs/gates/evidence/G2/ev-g2-03.md`、`docs/gates/evidence/G2/ev-g2-16.md`；`src/` 未改，说明处置落在注入夹具而不是放松门禁。

## 二、命令与退出码

| 命令（克隆内） | 结果 | 退出码 |
| --- | --- | --- |
| `git rev-parse HEAD` / `git status --porcelain` | HEAD=c17a0c76…；工作树空 | 0 |
| `pnpm install --frozen-lockfile` | 安装完成，4.4s | 0 |
| `pnpm typecheck` | `tsc --noEmit` 通过 | 0 |
| `pnpm test`（第 1 次） | 41 files，607 passed \| 1 skipped，15.07s | 0 |
| `pnpm test`（第 2 次） | 41 files，607 passed \| 1 skipped，14.60s | 0 |
| `pnpm test`（第 3 次） | 41 files，607 passed \| 1 skipped，14.48s | 0 |
| 桥闭环 6 文件命令（第 1 次） | 6 files，70 tests | 0 |
| 桥闭环 6 文件命令（第 2 次） | 6 files，70 tests | 0 |
| 桥闭环 6 文件命令（第 3 次） | 6 files，70 tests | 0 |
| 桥闭环 6 文件命令（第 4 次） | 6 files，70 tests | 0 |
| 必过用例与生产路径 6 文件命令 | 6 files，124 tests | 0 |
| `pnpm build` | 构建完成（`lib/index.js` 149.00 kB 等） | 0 |
| `node --no-warnings scripts/check-evidence-repro.ts` | 25 份，每份重跑两遍与 HEAD 字节一致 | 0 |
| `node --no-warnings scripts/fault-inject.ts --case ev-g2-03 --out tmp/probe-ev03` | 见第三节 | 0 |
| `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` | 预签态输出见第八节 | 1（预期） |

桥闭环 6 文件命令为 `tests/integration/agent-lifecycle.spec.ts`、`tests/integration/bridge-ledger.spec.ts`、`tests/unit/bridge-buffer.spec.ts`、`tests/integration/runtime.spec.ts`、`tests/e2e/production-path.spec.ts`、`tests/contract/execution-concurrency.spec.ts`；四次均为 6 files / 70 tests，与 G2.md 和 ev-g2-16 的 70 项声明一致。

## 三、ev-g2-03 独立复现（本轮重点）

`scripts/fault-inject.ts` 的修复是给 `HttpBootOpts` 增加 `now?: () => string`，`bootHttp` 把它传给 `startServer`；`caseEvG203` 以 `Date.parse(EV_NOW)` 起真实服务端时钟，迟到上报前把时钟推进 5 秒。独立复跑输出（节选）：

```
租约 HTTP=200 到期=2026-11-13T03:00:01.000Z；迟到上报 HTTP=409 错误={"code":"LEASE_EXPIRED","message":"租约已过期，执行器迟到上报被拒","retryable":false,"details":{"node_run_id":"nrun_01a1d9804da477aa999dd1750502bf7a","lease_expires_at":"2026-11-13T03:00:01.000Z","now":"2026-11-13T03:00:05.000Z","proposed":true}}；report_applied 条数=0；节点行=[{"node_run_id":"nrun_01a1d9804da477aa999dd1750502bf7a","status":"dispatched","attempt":1,"revision":1,"action_generation":1,"lease_expires_at":"2026-11-13T03:00:01.000Z"}]；上报登记=[]；节点事件=[{"seq":1,"type":"lease_acquired"}]
```

由此独立确认：迟到上报返回 409、`code=LEASE_EXPIRED`、`retryable=false`、`details.proposed=true`；`report_applied=0`；节点仍为 `dispatched`、`attempt=1`、`revision=1`；`report_registry` 为空；事件只有 `lease_acquired`。与 G2-03 必过项“租约过期迟到上报被拒”方向一致。

字节一致性：注入产物 `tmp/probe-ev03-report/G2/ev-g2-03.md` 为 1472 字节（LF），LF 归一 sha256=`5929f803fadbbeabe0a9f9b5b0b65d2d52b429017eaceab56388f165d83d29be`，与 `docs/gates/evidence/G2/ev-g2-03.md` 的 HEAD blob（`git hash-object`=`10f2c2ab1bb7e15d883c60fb33ffc92b34a6589b`）及门记录哈希完全一致。工作树文件为 1504 字节仅因 `core.autocrlf=true` 存成 CRLF；按门记录口径做 LF 归一后字节相同，不是内容差异。

这项修复针对的是第 46 轮 P1 的根因：旧证据在 `serverNow` 忽略请求体 `now` 的情况下仍把迟到上报记为 `accepted:true` 并落库。本候选没有改生产时钟代码，而是让夹具驱动真实服务端时钟，再用真实 HTTP 入口取到 409；这是正确方向，也没有把必过项改成“夹具里判断”。

## 四、桥闭环 70/70 与 B01/B03/B06/B07

- 桥闭环 6 文件命令连跑 4 次，每次 6 files / 70 tests，无抖动；全量 `pnpm test` 三次都是 41 files / 607 passed | 1 skipped。
- B01（`tests/integration/agent-lifecycle.spec.ts:57`）：订阅返回 `subscribed:false` 时 `lifecycle.run` 抛 `BRIDGE_NOT_SUBSCRIBED`，断言未调用 `executor.send`，stop 后 cancel 与 dispose 各恰一次。
- B03（`:345`）：缓冲先收到 seq 3 时触发 `fetchPage(fromSeq=1)` 补 1/2；真实 SQLite 账本断言 `bridge_event_receipts` 为 `[1,2,3]`、`bridge_stream_cursors.last_persisted_ack_seq=3` 且 `last_handled_seq=3`。
- B06（`tests/integration/runtime.spec.ts:349`）：真实独立子进程运行 `tests/fixtures/crash-collector-child.ts`，先把 outbox 停到 pending 并写 marker，再挂住；父进程 SIGKILL 后 `EvidenceCollector.collect` 抛 `EVIDENCE_SOURCE_UNAVAILABLE`，marker 仍只有一次，证明未盲目重跑。
- B07（`tests/integration/agent-lifecycle.spec.ts:229`）：真实 `spawn(process.execPath,['-e','setInterval(() => {}, 1000)'])` 子进程，`executor.cancel` 内 SIGKILL，等到退出后断言 `exitCode` 或 `signalCode` 非空，dispose 恰一次且发生在退出之后。
- B10：`agent-lifecycle.spec.ts:380` 两轮重连从账本确认位重放；`bridge-ledger.spec.ts:169` 的 onEvent 处理异常只推进已落账位。ev-g2-16 已把两处都列为落点。
- 生产路径：`tests/e2e/production-path.spec.ts:91` 断言 `evidence_source==='run_tool'`，并校验 `node_runs.status=done`、`report_registry.state=applied`、事件含 `lease_acquired/tool_started/tool_finished/report_applied`。双入口并发由 `tests/contract/execution-concurrency.spec.ts:30` 断言 `started=6`、`maxActive=2`、`scheduler.inFlight=0`、`scheduler.waiting=0`，共用同一个调度闸。

## 五、20 项必过逐项复核

| 项 | 必过内容 | 独立复核要点 | 结论 |
| --- | --- | --- | --- |
| G2-01 | 单节点 queued 到终态一条路径（生产装配） | 生产 HTTP 链 load→run→dispatch 全 200；节点 done；`evidence_source=run_tool`；9 条事件含 tool_started/tool_finished/report_applied；registry applied | pass |
| G2-02 | 重复上报只落一次 | 同 report 三投：首投 accepted，后二投 already_applied/already_replayed；applied=1、replayed=1；registry replayed | pass |
| G2-03 | 租约过期迟到上报被拒 | 独立注入复跑：409 LEASE_EXPIRED、report_applied=0、节点 dispatched；证据字节 LF 归一一致 | pass |
| G2-04 | 取消后不产生新 attempt | 未派发取消为 superseded/not_interruptible，attempt=2 上报返回 attempt_mismatch；派发后取消 interrupted、fence 只立一次；无新 attempt | pass |
| G2-05 | 终态必带证据 | done 无证据返回 evidence_missing，节点留 verifying；report_applied 2 条、rejected 1 条 | pass |
| G2-06 | 无裸 blocked | 裸 blocked_post 返回 decision_required；带凭据 accepted 并 verify_human 恰一次 | pass |
| G2-07 | S2 加载 parallel 被拒 | 加载 parallel 定义 403 FORBIDDEN；agent 定义 200；未加载版本建 run 404；账本空 | pass |
| G-03 | 同一 report_id 两次只落一次 | 第二次 accepted:false、state=replayed；applied=1；registry n=1；事件 report_replayed | pass |
| G-04 | 租约到期后原执行器迟到上报被拒 | 迟到 2 天返回 LEASE_EXPIRED；节点仍 dispatched、attempt=1、action_generation=1，lease_expires_at 有值 | pass |
| G-05 | 工具执行中取消只立一次围栏 | fence_armed 恰一次，第二次 fence_already_armed；围栏期上报被拒；宽限扫描 revoke | pass |
| G-07 | 墙钟跳变不误判截止 | 墙钟跳 600000ms→uncertain/clock_drift；跨 boot→boot_changed；节点仍 dispatched，无超时误判 | pass |
| G2-08 | 工具异常不许落完成 | 工具 exitCode=1 → 节点 blocked_post + verify_human，error_code=VERDICT_POLICY_UNMET，不落 done | pass |
| G2-09 | 判定时限只认 boot_id 与单调纳秒 | 跳钟/跨 boot/无锚点均 uncertain 且 blocked_post；预算走完为 verify_timeout；无自动收口 | pass |
| G2-10 | 报告入口系统级证据门 | 伪造 run_tool→evidence_unverifiable；弱来源 tool_result→verification_too_weak；空证据→evidence_missing；真派发 done/run_tool 对照 | pass |
| G2-11 | 反复重投同一 report_id 不刷膨胀 | 同一 report 四投各 200 status_mismatch，report_rejected=1、report_replayed=1、applied=0，节点仍 queued；带引号 report_id 两投 400 PAYLOAD_SCHEMA_INVALID | pass |
| G2-12 | 工具授权只认 workflow 定义 | 请求体 toolPolicy 不参与；三定义分别 FORBIDDEN/FORBIDDEN/TOOL_NOT_REGISTERED；lease_acquired=0，节点仍 queued | pass |
| G2-13 | 单写者锁与 epoch 围栏 | 首写 epoch=1；第二把锁 ELOCKED；外部 epoch→2 后老连接写 STALE_GENERATION；账本仍空 | pass |
| G2-14 | 长动作靠心跳续租 | 租约 2s/动作 3s/500ms 续租；2.5s 扫描 lease_expired=0；节点最终 done | pass |
| G2-15 | 同版本跨重启不可改写 | 同版本改写 409 WORKFLOW_VERSION_IMMUTABLE；跨重启 binding hash 206681cf…45256 不变；弱证据收口 rejected | pass |
| G2-16 | Bridge 生产闭环：B01–B10 可复现，工具证据只来自宿主 | 6 文件 70 项连跑 4 次一致；B01/B03/B06/B07 真实进程与真账本断言见第四节；生产路径 evidence_source=run_tool；双入口 started=6/maxActive=2；B10 双落点 | pass |

20/20 必过项通过，未发现与必过项相反的证据。

## 六、20 份证据的 LF 归一 sha256

逐份用 `[IO.File]::ReadAllText` 读入、把 CRLF 归一为 LF、按 UTF-8 算 SHA256，20/20 与 `docs/gates/G2.md` 证据表和 evidence-index 完全一致。

| 证据 | 文件 | LF 归一 sha256 |
| --- | --- | --- |
| ev-g2-01 | `docs/gates/evidence/G2/ev-g2-01.md` | `05c65facf0e4f4c2f0f42fa488103900f051a4067f5a860e9295219624233502` |
| ev-g2-02 | `docs/gates/evidence/G2/ev-g2-02.md` | `346af5813c653ba967af948a74aba27201b9ac906f13e54f4e588f8b18ea70e1` |
| ev-g2-03 | `docs/gates/evidence/G2/ev-g2-03.md` | `5929f803fadbbeabe0a9f9b5b0b65d2d52b429017eaceab56388f165d83d29be` |
| ev-g2-04 | `docs/gates/evidence/G2/ev-g2-04.md` | `65946e22958ef8764415d2af693245f8dc8da33e585ba4cee094e36f56ac71a6` |
| ev-g2-05 | `docs/gates/evidence/G2/ev-g2-05.md` | `6f3b44cf5589ddc059b77f3640e5a23f93eef8351d9c5fba9dd6510abc26e2ba` |
| ev-g2-06 | `docs/gates/evidence/G2/ev-g2-06.md` | `cef5cf3de601985af216cb935334414d56ff9f3f296871f709332f9e16b1f91c` |
| ev-g2-07 | `docs/gates/evidence/G2/ev-g2-07.md` | `607471ff9e475eaa30e3a83376b4c93aed12b6e209b7bd2601678737cf934a34` |
| ev-g2-08 | `docs/gates/evidence/G2/ev-g2-08.md` | `86e30ab3215755f2a791614dce667b295a41c0afebce0a7f286920e23e0d9225` |
| ev-g2-09 | `docs/gates/evidence/G2/ev-g2-09.md` | `f43b50982b67843db87e1cae9b36b0048eca372d9734904d3e1090fc97b8d8b2` |
| ev-g2-10 | `docs/gates/evidence/G2/ev-g2-10.md` | `3f3ba0999a89c2986d382e974a68357d1da1e3d015681ea5b7c4f0af5bd543ab` |
| ev-g2-11 | `docs/gates/evidence/G2/ev-g2-11.md` | `fb72ef55124d1b210ff4bf73ad1122cf067ecb93f96265e1fdfbdd050fc815dd` |
| ev-g2-12 | `docs/gates/evidence/G2/ev-g2-12.md` | `5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe` |
| ev-g2-13 | `docs/gates/evidence/G2/ev-g2-13.md` | `a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc` |
| ev-g2-14 | `docs/gates/evidence/G2/ev-g2-14.md` | `61e9c435b7d6b652e87889190af7e932ff54799f4d21d4e2b538f5ec3f050896` |
| ev-g2-15 | `docs/gates/evidence/G2/ev-g2-15.md` | `7648abe92c2026e4c5739c5f5714f448a2ce8864fc07a129f607675af415643f` |
| ev-g2-16 | `docs/gates/evidence/G2/ev-g2-16.md` | `4414fae1c349b9e3acadaebc9c63a3e63968565705561e02651c23755537e278` |
| ev-g2-g03 | `docs/gates/evidence/G2/G-03.md` | `514f9754fda67b8e1522d086fc6079301e00bd0185f9cca6dddec502c412ab70` |
| ev-g2-g04 | `docs/gates/evidence/G2/G-04.md` | `a30155a2446531f5c5cd2677946805ca9a78f407cfc4626147f20fcd446eb961` |
| ev-g2-g05 | `docs/gates/evidence/G2/G-05.md` | `d400f29ddeb1e0578c132e0a9abef1e0e3fc123179bfd90a692f526564285f4c` |
| ev-g2-g07 | `docs/gates/evidence/G2/G-07.md` | `de51ca56aba24af02f7c1ef2c0bfba5248da11b5aaa7ba163aafacf9d8e0746a` |

## 七、三方一致性与预签哈希状态

- 证据表 ↔ evidence-index ↔ 20 份证据文件：20/20 一致；每份证据均被正文引用，没有孤立证据。
- 必过项表 20 行与 artifact 的 `must_pass_items` 20 项顺序、结果、证据逐项一致；不变量表 12 行与 invariants 清单一致。
- artifact 内的汇总哈希仍是第 44 轮已签值，因为本候选改了证据表和正文但尚未重签；这是预签态，不是内容缺陷，sign-gate 会重算后写入。独立重算对照：

| 哈希 | artifact 当前存储值 | 按 HEAD 预签态重算值 |
| --- | --- | --- |
| candidate_hash | `d1fe5007e2d5072d8eae55a55628462f8e4c7d26ede1068a8f5eee71cd5b209d` | `669b5abc610fe028b73fa69b4e774fd9b66c0359003729800f7c9822063cc604` |
| change_scope_hash | `f6bc7b64061b6d7236c01cd79da2f8fa7258fc9e89804bb8b71a36d855c710f2` | `ce296355ed065667aff349cbcff557000cdfdd2fb64f67557347dbef3eb078a5` |
| evidence_index_hash | `0595636482719fa14a91d50783a2069fc01366c724eba3481efa02472fe86122` | `89bcc2bf6bc99560eb86b5521789f33394fadd2b92d3de7b4f40852e73feec4f` |
| invariants_hash | `925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304` | `6a7adcb05ef5a2dd645a7b259c7d11098a366dfe2e2cf31cda54f2d95138768e` |
| body_hash | `be3d9b20676b1fd1984cbcbfb78ec9911a82d449566b5d113658131c12ac3f08` | `d162481ecd4747bae52c6d6b7185b185c81c3e8933070843d3428eebba0970c5` |
| artifact_hash | `83eb0680705e1ebb964c35ca961d884aa9bc40dc1603d1f1d422e99f509e941a` | `ff528ddbd56f33b8638469cdc42b24627af40033e311dc684f93acc319db3f2d` |

- 预签态下 `gate-check` 在结构化裁决这一步就停下（见第八节），尚未进入这四个哈希的比对；签名时 `sign-gate` 会把 `audit_round`、`audit_report` 与六个哈希一起重算并写回，因此当前“存储值 ≠ 重算值”属预期流程状态。
- 候选只改 `docs/gates/G2.md` 与两份证据，因此 body/artifact/evidence_index 三个哈希必然变化；candidate/change_scope 也随候选提交变化。没有发现“改了证据却保留旧哈希就宣称通过”的取巧。

## 八、预签态门检查原文

`node --no-warnings scripts/gate-check.ts docs/gates/G2.md`，克隆干净状态下执行，退出码 1：

```
门检查失败：审计报告的结构化裁决不通过：must_pass_total（19）与门规格的必过项数（20）不符；审计没覆盖这些必过项：G2-16
```

artifact 仍为 `audit_round=44`、`audit_report=docs/audits/S2-independent-audit-round44.md`，与预签态旧锚一致；第 44 轮报告只有 19 项，故本条报错属预期。本轮报告补齐 20 项后由签名流程写入 47 轮报告与哈希。

## 九、失败清单与观察项

失败清单：无。P0=0，P1=0，P2=0；20/20 必过项通过，未发现应当阻断签门的问题。

观察项（不计 P，不影响裁决）：

- G2.md 复现命令末尾保留“本机 pnpm 不可用，命令一律用 node 直跑”。本次审计在克隆内 `pnpm install/typecheck/test/build` 均可用且 exit 0，`D:/NodeJs/node.exe` 也存在，node 直跑命令同样可执行；该注记已过时，建议下次改门记录时删掉或改成“两种入口均可”。这不影响任何必过项或复现命令的可执行性。
- 本候选未改 `src/`，ev-g2-03 的修复在注入夹具侧；生产服务端仍只认自己的时钟，这一点已由真实 HTTP 入口的 409 独立证明。
- 预签态 artifact 的六个汇总哈希是旧锚，这是流程状态而非内容问题；签门后应复核哈希已改写。

## 十、结构化裁决

<!-- audit-verdict:begin -->
```json
{"schema":"audit-verdict/1","gate":"G2","audit_round":47,"candidate_commit":"c17a0c76ed342364daf8972684e283290a3fbd00","conclusion":"pass","p0":0,"p1":0,"p2":0,"must_pass_total":20,"must_pass_passed":20,"must_pass_ids":["G2-01","G2-02","G2-03","G2-04","G2-05","G2-06","G2-07","G-03","G-04","G-05","G-07","G2-08","G2-09","G2-10","G2-11","G2-12","G2-13","G2-14","G2-15","G2-16"],"failed_items":[],"notes":"第47轮独立复跑：ev-g2-03 用真实服务端时钟推进 5s，迟到上报 409 LEASE_EXPIRED、report_applied=0、节点仍 dispatched，证据 LF 归一字节一致；桥闭环 6 文件 70 项连跑 4 次一致，全量 41 files/607 passed|1 skipped 连跑 3 次一致；G2 20 份证据 LF 归一哈希与证据表/evidence-index 20/20 一致；预签 artifact 仍为 round44 旧锚，签门时由 sign-gate 重算。"}
```
<!-- audit-verdict:end -->
