# S2 第六轮独立审计报告（门 G2）
审计对象：HEAD f68e836471e820355bc23b3bcce2f8a7e345b1bf
结论：fail

计数：致命 2 / 重大 1 / 不阻断 6

## 一、审计范围与工作树

- 审计对象为 `f68e836471e820355bc23b3bcce2f8a7e345b1bf`，提交说明为 `fix(s2): close round5 audit P0/P1 findings and add G2-12..14 evidence`。
- 已读 `docs/audits/S2-independent-audit-round5.md`、`docs/audits/S2-round5-response.md`、`docs/gates/G2.md`、`docs/gates/evidence/G2/` 下相关证据，以及 `src/`、`tests/`、`scripts/` 的对应实现。
- 审计开始时工作树有两处未提交文档改动：`docs/audits/S2-round5-response.md` 与 `handoff.md`；源码、测试、门记录、证据均未改。`docs/gates/G2.md` 工作树与 HEAD 一致（blob `053811315109d52b029b8c2d43116a789e8a334e`）。
- 本审计只新建临时探针与最终报告，未执行 `git add` / `git commit`，未改任何源码、测试、门记录或证据；临时探针在审计结束后删除。

## 二、验收命令实测

### 类型检查

```text
D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit
-> exit 0，无输出
```

### 全量用例

```text
D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run
-> Test Files  32 (1 failed | 31 passed)
-> Tests       281 (9 failed | 272 passed)
-> Duration    5.46s
```

9 个失败全部在 `tests/gate-check.spec.ts`，首因均为：

```text
审计报告结论与门记录结论不符：报告=fail，门记录=pass
```

失败用例为：`G1 门记录通过`、`改 candidate_hash 但锚点不动时报哈希不符`、`证据文件的哈希对不上时指名哪一份`、`evidence_index_hash 被改时指名证据索引不符`、`candidate_hash 改成别处的值时指名与候选文件不符`、`正文必过项的内容列被改时指名不一致`、`正文证据表的哈希被改时拒绝`、`正文不变量说明被改时拒绝`、`正文自锚 body_hash 被改时拒绝`。原因是 `checkAuditAnchor` 在 `scripts/gate-check.ts:532` 先于 candidate/body 检查执行；这批失败是当前审计锚仍指向 fail 报告的预期红，不是源码缺陷。

### 门记录指定六文件用例

```text
D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/integration/g2.spec.ts tests/runtime.spec.ts tests/routes.spec.ts tests/production-path.spec.ts tests/sweep.spec.ts tests/apply-report.spec.ts
-> Test Files  6 passed (6)
-> Tests       64 passed (64)
-> Duration    4.98s
-> tests/runtime.spec.ts 的长动作用例 3202ms，通过
```

### 门检查

```text
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md
-> exit 1：门检查失败：审计报告结论与门记录结论不符：报告=fail，门记录=pass

D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md
-> exit 1：门检查失败：审计报告结论与门记录结论不符：报告=fail，门记录=pass
```

G1 的 `audit_round=1` / `audit_report=docs/audits/S1-independent-audit.md`（G1.md:191-192），S1 报告第 148 行是“G1 建议：不通过”；G2 的 `audit_round=4` / `audit_report=docs/audits/S2-independent-audit-round4.md`（G2.md:298-299），round4 报告第 3 行是“结论：fail”。门检查先撞审计锚，符合任务书预期；但 G2 还有本报告第三节指出的签名失效，不能只改审计锚。

### 三份证据两次重跑

按 G2.md:88 的复现命令，用 `D:/NodeJs/node.exe --no-warnings scripts/fault-inject.ts --case ev-g2-1X`，每案连跑两次；每次均 exit 0，重算 LF 归一 sha256 与 G2.md 证据表完全一致，字节未变（重跑覆盖同名证据文件，没有发生字节变化）。

| 证据 | 第一次 LF sha256 | 第二次 LF sha256 | 字节 |
|---|---|---|---|
| `ev-g2-12` | `5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe` | 同左 | 2811 |
| `ev-g2-13` | `a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc` | 同左 | 567 |
| `ev-g2-14` | `865fd0b7bca1193256dedee74f30a18c8903f5e0fa4c2d119cad6e41b50ada02` | 同左 | 2260 |

独立重算全部 18 份证据（按 HEAD 字节、CRLF→LF 后 sha256）：18 份全部与 `docs/gates/G2.md` 的 evidence-index 一致，0 份不符；`ev-g2-10` 为 `76b458edf0f4f24a4408be4bf429b4a9025399aa002c52b6c50676a5f4f45e8b`，与表中一致。证据内容与标题的语义核对见第四节 G2-12/13/14。

## 三、致命：G2 门记录在 HEAD 没有对 18 项重签

这是本轮新发现，且独立于审计锚。`f68e836` 只向 G2 增加了 G2-12/13/14 三项必过项、三份证据与三条不变量（G2.md:244-263、361-373、455-475），但没有更新 GateArtifact 内的 `evidence_index_hash`、`invariants_hash`，也没有更新正文的 `artifact_hash`、`body_hash`。四个锚点仍是 `HEAD~1`（15 项版本）的值：

| 锚点 | G2.md 当前值 | 独立重算（HEAD 18 项版本） | 结论 |
|---|---|---|---|
| `evidence_index_hash`（G2.md:133） | `bcaaaa3e85d1dea69d323c9a03040f0bc7586445d5d833169b3768ac487b6347` | `5fa5eb7f81b3ff89fd27a24c1090127216dded801a5148b610c5ea9c10d699b7` | 旧 15 项值 |
| `invariants_hash`（G2.md:134） | `77708d4b54f29a676481b6c2755a241171c2cfab1231ef6e621f184fc68cedd5` | `25b4e945828f937df5655c94a20417efeece535544fbcd1301544a33f989a59b` | 旧 7 条值 |
| `artifact_hash`（G2.md:481） | `b5615b8b5725c5b2df88b9231b13885635940ef7db9f7fe802bc162c651c7a0a` | `b3225c7905f07deb4930abb24e6f0fa5807b7f02c27bb0283aae504ee9164d46` | 旧 15 项 artifact |
| `body_hash`（G2.md:482） | `ef21bb456813786ab878abae2824a873f6e7d470e257d2bcadfb9eb73282dfd3` | `d210224a19bb38c04a726fd548b94480f6a242d2c3939f1158d0481923607984` | 旧 15 项正文 |

同一脚本对 `HEAD~1` 的 15 项版本重算，四个值全部与当前 G2.md 里这四个锚点相同；对 HEAD 的 18 项版本重算，四个值全部不同。也就是说，`f68e836` 加了内容但没有执行 `scripts/sign-gate.ts` 的完整重签。

影响：`gate-check` 现在先在第 532 行审计锚失败，所以这四个错误锚被遮住；把审计锚换成一份 pass 报告后，会先在 `scripts/gate-check.ts:534-537` 的 `artifact_hash` 失败，即使只改这一处，还会在 `:235` 的 `evidence_index_hash`、`:258-260` 的 `invariants_hash`、`:556` 的 `body_hash` 继续失败。G2 门记录当前不是一份对 18 项内容有效的签名；只改 `audit_round/audit_report` 不足以重签，必须用 `sign-gate.ts` 重算四个哈希。证据文件本身全部对得上，问题在门级签名，不在证据内容。`scripts/gate-check.ts:102-120` 的固定映射（在 `:519` 调用） `G2-12/13/14 -> ev-g2-12/13/14` 与 G2.md 的 item 一致，映射本身没有换绑。

## 四、逐项核对表

| 项 | 结论 | 核对方式与关键发现 |
|---|---|---|
| P0-1 审计结论读取 | **fail** | `auditConclusionOf` 能正确返回 pass/fail/不通过/通过/无结论五种输入（单测与临时探针均验证），但 `scripts/gate-check.ts:429` 用 `exec` 取全文第一个“结论”匹配，不要求行首、不取最后一个。失败报告正文只要更早出现“门记录结论：pass”或“结论：pass”，就会被读成 pass。临时探针实测：`# 第六轮审计\n\n背景：上一轮门记录结论：pass，本轮复核如下。\n\n## 结论\n\nfail` → `pass`；`结论：pass\n\n（草稿）\n\n结论：fail` → `pass`。第五轮 P0-1 的修复仍可被报告正文绕过。 |
| P1-1 工作流版本不可变 | **fail（跨重启）** | 同进程同版本不同内容会抛 `WORKFLOW_VERSION_IMMUTABLE`（409），同内容重复 load 安全；tests/workflows.spec.ts 五例覆盖。但 `WorkflowCatalog` 是纯内存 Map，`src/index.ts:52` 每次启动 `new WorkflowCatalog` 都是空目录，没有版本内容持久化。临时探针：新 catalog 重新 load 同版本、改 `pass_conditions` 被接受；同一份在飞 report 在旧 catalog 下 `accepted:true / next_status:done`，在新 catalog 下 `accepted:false / reason=verdict_unmet:evidence.exitCode`，节点仍 verifying。重启后同版本不同内容会改写同一条在飞 run 的判定。 |
| P1-2 工具授权来源 | **pass（带 P2）** | `policyForNodeRun` 按 `node_runs.node_id` JOIN `runs.workflow_version` 反查 `catalog.toolPolicyFor`（run-node.ts:101-115），身份以账本 `node_runs.node_id` 为准，不一致抛 `STALE_GENERATION`；请求体不再有 `toolPolicy`，dispatch/HTTP 也不处理该字段。`assertToolsAuthorized` 依次拒 deny、未注册、不在 allow；`ReadOnlyToolRunner` 在 tools.ts:199 固定用注册表 `descriptor.command.args`，请求 args 不覆盖实际执行。ev-g2-12 用定义 allow `['ro.echo']`、`[]`、`['ro.ghost']`，请求体故意带 `toolPolicy {allow:['ro.echo','ro.fail']}`，三节点分别在租约前 FORBIDDEN / FORBIDDEN / TOOL_NOT_REGISTERED，lease_acquired=0。缺口：deny 命中、请求体显式注入 toolPolicy、runNode 层非空 args 没有直接断言（P2）。 |
| P1-3 单写者锁与凭证 | **pass（带 P2）** | `src/index.ts:43` 模块私有 `Symbol`；`:46-49` 外部不带凭证调用 `createOrchestra` 抛 FORBIDDEN；`:110-132` `openServiceOrchestra` 串起 `acquireDbLock → bumpEpoch → openServiceDb → createOrchestra(proof)`，失败释放锁。ev-g2-13 实测首个写者 epoch=1、第二把锁 ELOCKED、外部 bumpEpoch 到 2 后旧连接写 STALE_GENERATION、释放后账本空。缺口：没有测试直接调用 `createOrchestra` 验证 FORBIDDEN；ev-g2-13 没有真正启动第二个 service 实例，外部 bumpEpoch 是模拟绕过（P2）。 |
| P2-1 长动作心跳 | **pass（带 P2）** | 临时探针：runner 睡 1200ms、租约 10ms、续租 200ms，runNode 抛 LEASE_EXPIRED，节点 blocked_post，`lease_lost` 事件 1，`verify_timeout` 0，reason=lease_lost；两个工具、每个 150ms、actionTimeoutMs=100，只执行 1 次，OPERATION_TIMEOUT，节点 blocked_post，reason=action_timeout，`verify_timeout` 0。G2-14 的 3s 动作/2s 租约/500ms 续租在 2.5s 扫描时仍 started，最终 done。缺口：全仓测试无 `lease_lost` / `action_timeout` 用例；`execution.action_timeout_ms` 没有生产读点，HTTP/派发路径实际恒用 `DEFAULT_ACTION_TIMEOUT_MS=120000`（P2）。 |
| P2-3 ev-g2-10 实体映射 | **pass** | `scripts/fault-inject.ts:47-72` `normalizeEvidence` 接收 `shared`，`:74-84` 每份证据只建一次映射、params/before/after/reconcile 四段共用。ev-g2-10 恢复段与对账段 `nrun_1/nrun_2` 前后一致，哈希 `76b458ed…` 与 G2.md 表一致。 |
| G2-12 工具授权证据 | **pass（证据）** | 标题“工具授权只认 workflow 定义，请求体策略不参与”与内容一致；定义 allow 三组和请求体 toolPolicy 的对照见上，三节点均租约前拒、仍 queued、节点事件空；哈希两次一致。门记录签名失效见第三节。 |
| G2-13 锁与 epoch 证据 | **pass（证据）** | 标题“第二写者拿不到锁，旧 epoch 写不进”与内容一致：epoch=1、ELOCKED、bump 到 2、旧连接 STALE_GENERATION、释放后账本空；哈希两次一致。证据用外部 `bumpEpoch` 模拟旧 epoch 场景，未启动第二服务。 |
| G2-14 长动作证据 | **pass（证据）** | 标题“长动作靠心跳续租，扫描不误判过期”与内容一致：3s 动作、2s 租约、500ms 续租、2.5s 扫描时节点 started，lease_expired/fence_revoked/verify_timed_out/verify_uncertain/replay_heads 全空，最终 done revision=9；哈希两次一致。 |

## 五、新发现问题

### P0（致命）

1. **P0-1 残余：审计报告结论读取仍可被正文更早的“结论：pass”绕过**（`scripts/gate-check.ts:428-433`、`:446`）。`auditConclusionOf` 的正则用 `exec` 取全文第一个匹配，不锚行首、不取最后一个。失败报告只要在更早的“背景/上轮门记录”处写“结论：pass”，`checkAuditAnchor` 就会把 fail 报告读成 pass。临时探针两种写法都返回 `pass`。这是第五轮唯一致命项的未闭合形式，判致命。建议改为只读固定结论行（例如第三行 `^结论[：:]` 加 `m`）、或取最后一个结论、或要求专用字段；并补 `checkAuditAnchor` 端到端用例（fail 报告 + 更早“结论：pass” + 门记录 pass → 必须拒绝）。

2. **G2 门记录在 f68e836 没有对 18 项重签**（G2.md:133-134、481-482；对比 HEAD~1 全部匹配）。四个锚点仍是 15 项版本的旧值，详见第三节。当前 `gate-check` 先撞审计锚，掩盖了这四处；仅改审计锚会在 `artifact_hash` / `evidence_index_hash` / `invariants_hash` / `body_hash` 继续失败。判致命：门记录声称 18 项 pass，但没有一份覆盖 18 项的有效签名；必须用 `sign-gate.ts` 重算。证据文件本身 18/18 对得上，问题在门级签名。

### P1（重大）

3. **P1-1 残余：工作流版本不可变只在单进程内生效**（`src/service/workflows.ts:19-42`、`src/index.ts:52`、`src/service/commands/apply-report.ts:91-101`）。`WorkflowCatalog` 纯内存，重启后为空；重新 load 同版本不同内容被接受。临时探针用真实账本构造在飞 verifying run，同一份 report 在旧 catalog 下 done、在新 catalog 下 rejected。违反“同版本不可改写”的核心不变量，判重大。建议把每个版本的定义内容哈希持久化到 DB（或在启动时从受信签名目录装载并比对），load 时与库内哈希比对，不一致拒绝；补跨重启/在飞 run 用例。

### P2（不阻断，带条件放行）

1. **action_timeout 配置链未接通**：全仓没有读 `execution.action_timeout_ms` 的代码；`src/core/config.ts:40` 的 `action_timeout_ms` 没有消费点，`src/executor/run-node.ts:144` 只用 `p.actionTimeoutMs ?? 120000`，HTTP/派发都不传 `actionTimeoutMs`。round5-response 的“动作总时限读 execution.action_timeout_ms”与代码不符。功能上 120s 默认仍能兜底，本轮 G2-14 的 3s 动作不受影响。
2. **run-node 请求 args 与注册表 args 哈希口径不一致**：`src/executor/run-node.ts:177-180` 在 `tool.args.length > 0` 时用请求 args 算期望 commandHash，而 `ReadOnlyToolRunner` 在 `src/executor/tools.ts:199` 始终执行注册表固定 args；任何非空请求 args 都会 fail-closed 成 VERIFICATION_TOO_WEAK。没有测试覆盖 runNode 层非空 args。
3. **授权/门检查测试缺口**：`tests/production-path.spec.ts:108-135` 覆盖“allow 不含、allow 空、未注册”三例，未覆盖 deny 命中与请求体显式 `toolPolicy`；`tests/gate-check.spec.ts` 只单测 `auditConclusionOf` 六输入，没有 `checkAuditAnchor` 端到端断言；`tests/runtime.spec.ts:141-168` 覆盖长动作 started，未覆盖 `lease_lost` / `action_timeout`。
4. **锁/凭证测试缺口**：`grep tests` 对 `createOrchestra` 0 命中，外部直接调用 FORBIDDEN 只有代码路径；ev-g2-13 没有启动第二个 `openServiceOrchestra` 实例，ELOCKED 是对 `acquireDbLock` 的直接调用，旧 epoch 是对 `bumpEpoch` 的外部调用。
5. **Catalog 防御性缺口**：`src/service/workflows.ts:31` 先 `defs.set(key, def)` 再做数字别名检查，别名冲突抛错时新 key 已写入（临时探针用 `'1'` + `'01'` 复现 `'01'` 半加载残留，`toolPolicyFor('01','check')` 仍返回 allow `['ro.fail']`）；load 存的是调用方对象引用，加载后外部改 `pass_conditions[0].value` 会改变目录内判定；`workflow_version` 类型/非空未校验。
6. **第五轮遗留 P2 未闭合**：`checkEvidence` 的 `e.file` 未限制在固定证据路径（按 id 映射，file 可换绑）；前序链只从 HEAD 文本正则取 `artifact_hash` 字符串、不重算前序 artifact；`bodyHashInput` 把反引号内 64hex 替换为占位符；服务端 `now` 仍取 body；无密码学签名（N3）。这些不改变本轮致命/重大判定，但仍是开 S3 前应登记或补齐的项。

## 六、G1/G2 门状态与能否开 S3

- G1 当前 `audit_round=1` / `audit_report=docs/audits/S1-independent-audit.md`，S1 报告结论是“不通过”，所以 `gate-check G1` 报“报告=fail，门记录=pass”是代码在正确拦截，不是新缺陷。G1 要重签，需要先有 HEAD 内的 S1 第二轮 pass 报告；当前 HEAD 没有，不能机械改锚。
- G2 当前 `audit_round=4` / `audit_report=docs/audits/S2-independent-audit-round4.md`，round4 结论 fail，同样被正确拦截；此外 G2 还有第三节的四个签名锚点未重签。即使把审计锚换成 pass 报告，也必须用 `sign-gate.ts` 重算 evidence_index_hash/invariants_hash/artifact_hash/body_hash，不能只手改两个字段。
- 本报告结论为 fail，因此不写“按本报告重签 audit_round=6”的放行句；当前不能给 G2 签 pass，也不能开 S3。修复顺序建议：先修 P0-1 的结论解析与 G2 的完整重签流程，再持久化工作流版本不变量并补跨重启在飞用例，再补 action_timeout 接线与 lease_lost/action_timeout/deny/端到端锚点测试；tsc、全量 vitest、六文件用例、三份证据两次重跑全绿后，由第七轮独立审计出 pass 报告，再由 `sign-gate.ts` 重签 G2；G1 待 S1 第二轮 pass 报告出来后再重签。只有 0 致命、0 重大且 G1/G2 双门对 HEAD 重签后可开 S3。

## 七、实际执行命令与关键输出

```text
D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit
exit 0

D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run
Test Files  32 (1 failed | 31 passed)
Tests       281 (9 failed | 272 passed)

D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/gate-check.spec.ts
Test Files  1 failed (1)
Tests       9 failed | 15 passed (24)

D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/integration/g2.spec.ts tests/runtime.spec.ts tests/routes.spec.ts tests/production-path.spec.ts tests/sweep.spec.ts tests/apply-report.spec.ts
Test Files  6 passed (6)
Tests       64 passed (64)

D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G1.md
门检查失败：审计报告结论与门记录结论不符：报告=fail，门记录=pass

D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md
门检查失败：审计报告结论与门记录结论不符：报告=fail，门记录=pass

D:/NodeJs/node.exe --no-warnings scripts/fault-inject.ts --case ev-g2-12   （两次）
D:/NodeJs/node.exe --no-warnings scripts/fault-inject.ts --case ev-g2-13   （两次）
D:/NodeJs/node.exe --no-warnings scripts/fault-inject.ts --case ev-g2-14   （两次）
均 exit 0；LF sha256 两次分别恒为 5c2d543f… / a5260693… / 865fd0b7…
```

临时探针（脚本均在审计结束后删除，未留源码改动）：

```text
auditConclusionOf:
  '## 结论\n\n**pass**' -> pass
  '## 结论\n\n**fail**' -> fail
  '## 结论\n\n不通过'  -> fail
  '## 结论\n\n通过'    -> pass
  无结论                -> null
  'G1 建议：不通过'      -> fail
  失败报告更早写“门记录结论：pass” -> pass（绕过）
  '结论：pass' 后再写 '结论：fail' -> pass（第一次匹配生效）

WorkflowCatalog:
  同进程同版本改 pass_conditions -> WORKFLOW_VERSION_IMMUTABLE
  新 catalog（模拟重启）同版本改值 -> accepted
  在飞 report：旧 catalog -> accepted/done；新 catalog -> rejected/verifying
  '1' + '01' 别名冲突 -> 抛错，但 '01' 残留 allow ['ro.fail']

runNode:
  续租失败（1200ms 动作 / 10ms 租约 / 200ms 续租）
    -> LEASE_EXPIRED、blocked_post、lease_lost=1、verify_timeout=0
  action_timeout（两个 150ms 工具 / 100ms 总时限）
    -> OPERATION_TIMEOUT、只执行 1 次、blocked_post、reason=action_timeout
```

独立哈希重算（`.audit-r6-hash.ts`，已删除）：

```text
HEAD 18 项版本：
  evidence_index_hash 实际 5fa5eb7f81b3ff89fd27a24c1090127216dded801a5148b610c5ea9c10d699b7（G2.md:133 为 bcaaaa3e…）
  invariants_hash     实际 25b4e945828f937df5655c94a20417efeece535544fbcd1301544a33f989a59b（G2.md:134 为 77708d4b…）
  artifact_hash       实际 b3225c7905f07deb4930abb24e6f0fa5807b7f02c27bb0283aae504ee9164d46（G2.md:481 为 b5615b8b…）
  body_hash           实际 d210224a19bb38c04a726fd548b94480f6a242d2c3939f1158d0481923607984（G2.md:482 为 ef21bb45…）
HEAD~1 15 项版本：四个值分别等于 bcaaaa3e… / 77708d4b… / b5615b8b… / ef21bb45…（全部匹配）
全部 18 份证据：0 份 sha256 不符
```

清理后 `git status --porcelain` 实测为：`M docs/audits/S2-round5-response.md`、`M handoff.md`、`?? docs/audits/S2-independent-audit-round6.md`；没有源码、测试、门记录或证据改动。审计期间未执行 `git add` / `git commit`。
