# S2 独立审计第 25 轮

结论：fail

门：G2
候选提交：6cb95b3840e8a88ff605d23f49f73c5c39b6b066

## 范围与方法

- 审计对象：`D:/aboutAI/dsh-orchestra`，候选 `6cb95b3`；主仓工作树干净，本报告是唯一新增文件。
- 独立 clone：`D:/aboutAI/_g2audit25/clone`，`git checkout 6cb95b3`；`node_modules` 为指向主仓的 junction。阳性对照另建 `D:/aboutAI/_g2audit25/pc`。
- 已读：`AGENTS.md`、`docs/gates/G2.md`、`scripts/gate-check.ts`、`scripts/sign-gate.ts`、`src/core/policy.ts`、`src/service/commands/apply-report.ts`、`src/service/server.ts`、`src/service/commands/lease.ts`，以及相关测试、证据与 `handoff.md`。
- 证据复核：用 `git show HEAD:path` 取字节，按 LF 归一重算 SHA-256；`ev-g2-14` / `ev-g2-15` 用 `runCase` + `writeEvidence` 各跑两遍，再用 CLI 复跑一遍确认后 `git checkout --` 恢复 clone。
- 阳性对照：在 `pc` 中先签 G1，再签 G2，然后跑门检查；命令与输出记录在下面。

## 复核结果

- `docs/gates/G2.md:25-45` 的 19 项（`G2-01`..`G2-07`、`G-03` / `G-04` / `G-05` / `G-07`、`G2-08`..`G2-15`）逐项核对内容列与证据映射，记录中的结果列均为 `pass`；`must_pass_items` 与正文表、`evidenceMap` 完全对应。
- `docs/gates/G2.md:70-88` 的 19 份证据逐份按 HEAD 字节 LF 归一重算 SHA-256，19/19 与表和 evidence-index 相同；`ev-g2-12`、`ev-g2-13` 重跑两次字节稳定（见下）。
- `docs/gates/G2.md:115-127` 的 `I1`..`I11` 与 artifact 的 `invariants` JSON、正文表同源；固定语句与证据映射无差异。
- `6cb95b3` 上 G2 记录仍是预签态：`audit_round=4`、`audit_report=docs/audits/S2-independent-audit-round4.md`、`audit_report_sha256=0*64`；在 clone 上跑门检查 exit=1，先点名审计报告哈希不符。预签态记录的 `artifact_hash=b5615b8b5725...` / `body_hash=ef21bb456813...` 与 HEAD 复算 `ea3dff4caa8d...` / `8a446dab7906...` 不一致，属于未重签状态。
- 用干净报告重签后：`candidate_hash=137b0f6286ae077f8dcae5ef8e0c5bcedcf5a8ce737a0c6909113dc5b649c4c2`（88 个改动文件）、`change_scope_hash=b4811c33ac596c2580c7268812fa1e79fbe12ad2f9257bacdd8fb88fd5648778`、`evidence_index_hash=106e1c362e7d4312e647580a99b3cfc01eb604546af9fd42167af4bbce6b8fd0`、`invariants_hash=925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304`，与 `artifact_hash=e5f4459cebb713f9c228408b6d0a4fc034ec62f21e4eeb6f4824917d860bb8cd`、`body_hash=4dd6514d7bdc42246bd62582264b2fb78fde508568c7aa505b6362064855dd6a` 同源一致。
- 阳性对照：G1 重签 exit=0，门检查 exit=0，`artifact_hash=b3e130869464...`、`body_hash=29dfca724984...`；G2 重签 exit=0，`artifact_hash=e5f4459cebb7...`、`body_hash=4dd6514d7bdc...`，门检查 exit=0。`candidate_hash=137b...` 与我独立用 `canonicalJson` 复算的值相同。
- 候选未签时全量测试：32 个文件、348 例，`337 passed / 11 failed`，11 个红例全部先报 `audit_report_sha256=0*64` 不符；这是预签态。`pc` 签后同一套：`348/348 passed`，exit=0。
- `tests/gate-check.spec.ts --reporter=verbose` 在候选上为 `11 failed / 63 passed`，11 个红例全是门记录校验类；`S1` 第二十轮 21 例、`S2` 第二十四轮 36 例，以及 `S1` 第十七/十八/十九轮、`S2` 第二十/二十三轮载荷全部 ✓。本轮新增否定词不在这些用例里，回归绿不等于闭合。
- 时钟：`src/service/server.ts:135-136` 每请求取一次 `requestNow`，`/lease`、`/renew`、`/report` 都用它；请求体 `now` 不参与。探针：`/lease` 请求体 `now=2000-01-01` 仍返回服务端 `2026-11-13T03:10:00.000Z`；`/renew` 在服务端 `03:20` 返回 409 `LEASE_EXPIRED`；过期后直接 `applyReport` 抛「租约已过期，执行器迟到上报被拒」。未发现客户端控钟。
- `docs/gates/G2.md:13/15/17/19/21` 的旧轮次历史叙述含 `不通过` 字样，多次重签均未被误杀；误杀风险本轮未复现。

## 定级发现

### P0-1 审计报告解析器漏掉常见否定式，报告可见写 `本次审计无法通过。` 仍可签成 `pass`

- 位置：`scripts/gate-check.ts:651-663` 的 `FAIL_VERDICTS` 没有 `无法通过`、`不予通过`、`未获批准`、`未达标`、`否决`、`cannot pass`、`unable to pass`、`not approved`、`did not approve`；`:719-747` 的 `scanFailStatement` 只认表内词，命中后还要求下一字符为空、`|`、`需应已的了`，带宾语的 `未通过验收` 也漏。
- 直接调用 `auditConclusionOf`（报告有唯一 `结论：pass`，正文追加一行）：`本次审计无法通过。` => `pass`；`本次审计不予通过。` => `pass`；`本报告未获批准。` => `pass`；`本次审计未达标。` => `pass`；`本次审计被否决。` => `pass`；`This review cannot pass.` => `pass`；`The audit was unable to pass.` => `pass`；`The audit was not approved.` => `pass`；`The auditor did not approve.` => `pass`。
- 对照：`本次审计不通过。`、`The audit failed.`、`结论：pass 但本报告不通过`、第二行 `结论：fail`、图片 alt 否定、HTML 注释内否定均返回 null 或被隐藏处理。
- 端到端：在 `pc` 的候选上，把 `docs/audits/S2-independent-audit-round25.md` 设成唯一 `结论：pass`，追加 `本次审计无法通过。`，commit 后跑 `node scripts/sign-gate.ts docs/gates/G2.md` => exit=0；再 commit 后跑 `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` => exit=0。随后追加五行（`本次审计无法通过。`、`本次审计不予通过。`、`本报告未获批准。`、`本次审计未达标。`、`本次审计被否决。`）重签，`artifact_hash=93ab1fca5f9c...`、`body_hash=e950bc738d78...`，两次 exit 均为 0。
- 影响：G2 的审计锚只认可见行首的 `pass`，正文中的否定句不参与；报告的人读含义与门记录相反，但门检查仍放行。
- 最小复现：`pc` 分支 `bypass` 的 `5d400f0`；`git show 5d400f0` 可看到报告与门记录改动。

### P0-2 G2 门记录正文同一缺口：正文写 `本次审计无法通过。` 仍可签成 `pass`

- 位置：`scripts/gate-check.ts:797-813` 的 `bodyConclusionOf` 用 `visibleFailStatement(..., {bareConclusion: never})`，只排除了裸 `结论` / `判定` 主语；`FAIL_VERDICTS` 的缺口与 P0-1 相同。
- 端到端：在 `pc` 的 `docs/gates/G2.md` 正文 `## 必过项与证据` 前插入一行 `本次审计无法通过。`，commit 后重签 exit=0；再 commit 后门检查 exit=0。artifact 仍是 `2d6edb29778a...`，`body_hash=f19b54342e72...`，artifact JSON 里的 `conclusion=pass` 未变。
- 影响：门记录正文可以可见地写审计未过，而 artifact 仍为 `pass`；门检查只验正文锚与 artifact 的一致性，不拒绝同一门记录内的反向叙述。
- 最小复现：`pc` 分支 `bypass` 的 `5d400f0` 之后的重签提交；插入点与上述一致。

### P1-1 `requiredHashes` 只校验值属于可信集合，不校验键的语义

- 位置：`src/core/policy.ts:44-62` 对每个 required key 只检查 `ev.hashes[key]` 是 64-hex 且小写后落在 `options.trustedHashes` 内，再要求 `strength=strong`；`src/service/commands/apply-report.ts:252-255` 把 `sha256(canonicalJson(report.output ?? null))` 和匹配工具行的 stdout/stderr/command 哈希都放进可信集合。
- 探针（`probe-apply.ts`）：A1 `hashes.artifact=a*64` => accepted=false，reason=`verification_too_weak`；A2 只给键名 => false 同因；A3 `hashes.artifact=commandHash` => accepted=true，node=`done`；A4 `hashes.artifact=sha256(canonicalJson({}))` 且 `report.output={}` => accepted=true；A5 `hashes.artifact=stdoutHash` => accepted=true；M1 `requiredHashes=[artifact,bundle]` 两键填同一个 commandHash => accepted=true。
- 测试已经把这个行为固化成阳性对照：`tests/apply-report.spec.ts:378-387` 的 `hashes.artifact=CMD` 期望 accepted=true。规格侧 `docs/requirements.md:129` 与 `docs/orchestra-design-draft.md:509` / `:2190` 要求的是产物哈希。
- 影响：`artifact` 这个 required key 可以由命令哈希、stdout 哈希或 report.output 摘要冒充，产物本身没有被验证；G2-10 所称「伪造痕迹一律拒」只覆盖了值不在可信集合的情况，不覆盖键语义错配。
- 最小复现：`D:/aboutAI/_g2audit25/probe-apply.ts` 的 A3/A4/A5/M1。

### P1-2 `failed` / `timeout` 可用成功行收口，同 attempt 有异常行也放行

- 位置：`src/service/commands/apply-report.ts:229-234` 对 `failed` / `timeout` 只跑 `traceBindingGate({allowFailed:true})`，失败即拒，随后直接迁移；`:362` 注释写「失败/超时终态本身就要对失败行」，但 `:363` 只在 `!allowFailed` 时检查 `rows.some(exit_code !== 0)`，`:365-374` 的匹配也不要求 `exit_code !== 0`。注释与实现相反。
- 探针（`probe-apply.ts`）：B1 `failed` 仅给成功行/成功 `tool_finished` => accepted=true，node=`failed`；B1b 同 attempt 另有异常行/事件仍 accepted=true；B2 无轨迹 => false，reason=`evidence_unverifiable`；B3 证据 `exitCode=1` 但只有成功行 => false 同因；B4 失败行/事件对照 => true；B5 `timeout` 成功行/事件且另有异常行 => true；B6 `timeout` 仅成功行/事件 => true。
- 影响：执行器可以把 `failed` / `timeout` 终态绑到一条成功工具行上，终态证据与终态语义不对齐；G2-10 的终态证据要求没有覆盖这一组合。
- 最小复现：`probe-apply.ts` 的 B1/B1b/B5/B6。

### P1-3 `ev-g2-14` / `ev-g2-15` 证据重跑字节不稳定

- 位置：`scripts/fault-inject.ts:1243-1279` 的 `ev-g2-14` 与 `:1281-1335` 的 `ev-g2-15` 从真实服务与真实库取 `tool_start_at`、`lease_expires_at`、`verify_deadline_at`；生成器只归一事件 id 与实体 id，不归一这些墙钟字段。
- 记录值：`ev-g2-14` 的 LF SHA-256 为 `865fd0b7bca1193256dedee74f30a18c8903f5e0fa4c2d119cad6e41b50ada02`；两次重跑为 `8dfb82ad2b5a102b5eba30033f8fccffb4daab28418a7e6e18ff83ade88e10c6` 与 `2096d3a85ea54b5f7e79709954b67394e7d4b5cbced9025f3ef586cbc73cab26`。`ev-g2-15` 的记录值为 `db1c814f8935e1779440aec12c5a229a6ec8636a0e6ccc7f86d2ac834e037038`；两次重跑为 `f51fa4724c3abc4eb01565be2d706105953e10f81749e8ebac13b00eb6f72252` 与 `cb5095c86b1cbbb1dbbce15f219fa5a9840ffc17c56c64a46954e68cddb8af05`。
- 差异点：`ev-g2-14` 第 23 行 `tool_start_at` 与第 37 行 `lease_expires_at` / `tool_start_at` 随运行时刻变化；`ev-g2-15` 第 23 行 `verify_deadline_at` 随运行时刻变化。CLI 直接重跑 `node scripts/fault-inject.ts --case ev-g2-14` / `--case ev-g2-15` 也得到不同字节，随后已用 `git checkout --` 恢复。
- 对照：`ev-g2-12` 两次均为 `5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe`；`ev-g2-13` 两次均为 `a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc`，与记录值相同。
- 影响：`docs/gates/G2.md:11` 说证据可由 `scripts/fault-inject.ts` 重跑出同样字节；14/15 两份不成立。门检查只测 HEAD 字节与表内哈希，重签会把当前字节写进表，因此这个不稳定不会被门检查发现。
- 最小复现：`D:/aboutAI/_g2audit25/evidence-stability.ts`，或直接跑两次 `node scripts/fault-inject.ts --case ev-g2-14` 后比较 `sha256sum`。

### P2-1 同一词表缺口仍有残余变体与同形字绕过

- 已拦住：`本次审计未获通过。`、`本次审计未能通过。`、`本次审计没通过。` 均返回 null；`本次审计不通过。`、`The audit failed.` 也返回 null。
- 仍漏（报告有唯一 `结论：pass`，正文追加一行）：`本次审计没能通过。` => `pass`；`本次审计被驳回。` => `pass`；`本次审计遭否决。` => `pass`；`本次审计无法予以通过。` => `pass`；`本次审计不获批准。` => `pass`；`本次审计不予批准。` => `pass`；`本次审计未通过验收。` => `pass`；`本次审计不通过验收。` => `pass`；`本次审计未达到通过标准。` => `pass`；`本次审计 fаil。`（西里尔字母 `а`） => `pass`。
- 影响：修掉 P0-1 列出的五个词后，这些变体仍可让报告正文出现可见否定句而门锚保持 `pass`；同形字还绕过了 `NFKC` 与 `Cf` 归一。
- 最小复现：`D:/aboutAI/_g2audit25/probe-parser2.ts`。

## 计数

- P0：2
- P1：3
- P2：1

## 边界

- 本报告是主仓唯一新增文件；没有改源码、测试、门记录或证据，没有提交。
- clone 中的证据 CLI 重跑已恢复，`git status --porcelain` 为空；阳性对照的提交只在 `pc`，不在主仓。
