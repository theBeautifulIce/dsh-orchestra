# S2 第三十四轮独立审计报告

门：G2

候选提交：59fe18d53c554c788cb04437bffbd5f2df76ad4e

- 审计日期：2026-11-14
- 审计对象：D:\aboutAI\dsh-orchestra（HEAD = 59fe18d53c554c788cb04437bffbd5f2df76ad4e，工作树干净）
- 审计方式：只读复核；唯一写入是本文件。证据复核、签名与攻击实验均在 %TEMP% 下的克隆里进行，主仓未改。

## 一、范围与基线

- 逐行读 scripts/gate-check.ts 的 GATE_SPECS（本门 19 项、invariants、evidenceMap、excludes）、scripts/sign-gate.ts、src/core/*、src/executor/*、src/infra/sqlite/*、src/service/*、tests/**，以及 docs/gates/G2.md 与 docs/gates/evidence/G2/ 下 19 份证据。
- 主仓基线：tsc --noEmit exit 0；全量 vitest 36 个文件 / 512 例 = 511 passed | 1 skipped（预签态下 G1 用例跳过）。
- 主仓当前是预签态（G2.md 的 audit_round 仍为 4、审计报告哈希为 0），因此直接跑门检查按预期失败：
  `门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != c9cef2e419c91711…`，exit 1。
  为验证门本身，我在克隆里补一份 round34 审计报告并按 sign-gate 正式签了一次（exit 0，19 项必过、19 份证据复核通过），再对已签记录做攻击。以下“拦截结果”都是在这个已签克隆上得到的。

## 二、必过项逐项核对

| 项号 | 验收要求 | 核对了什么 | 结论 |
| --- | --- | --- | --- |
| G2-01 | 单节点 queued 到终态一条路径（走生产装配） | 读 ev-g2-01 与 g2.spec.ts 对应用例；核对 src/index.ts 的 serveOrchestra / openServiceOrchestra 装配、executor 路由与状态机迁移 | pass |
| G2-02 | 重复上报只落一次 | 读 ev-g2-02；核对 report_registry 的唯一约束与 apply-report.ts 的回放分支（重复上报返回 already_applied，状态不再推进） | pass |
| G2-03 | 租约过期迟到上报被拒 | 读 ev-g2-03；核对租约到期判定与 ownerEpoch/lease 校验，迟到上报不会拿到新租约 | pass |
| G2-04 | 取消后不产生新 attempt | 读 ev-g2-04；核对 cancel 命令的迁移与取消后不再派生 attempt | pass |
| G2-05 | 终态必带证据 | 读 ev-g2-05、ev-g2-10；核对 apply-report.ts 的终态证据门；克隆里投递无痕迹的 done，实测被拒（evidence_unverifiable） | pass |
| G2-06 | 无裸 blocked（没裁决卡不许卡住） | 读 ev-g2-06；核对 apply-report.ts 对 blocked 上报要求 reason/missing，缺了按 decision_required 拒 | pass |
| G2-07 | S2 加载 parallel 被拒 | 读 ev-g2-07；核对 assertDefinitionAllowed 对阶段与并行度的校验 | pass |
| G-03 | 同一 report_id 上报两次只落一次 | 读 ev-g2-g03；核对 registry 主键与回放语义：应用只发生一次（普通 id） | pass |
| G-04 | 租约到期后原执行器迟到上报被拒 | 读 ev-g2-g04；核对围栏与租约校验，旧执行器上报被拒 | pass |
| G-05 | 工具执行中取消只立一次围栏 | 读 ev-g2-g05；核对 tool_start_at 与 fence 记录只建一次 | pass |
| G-07 | 墙钟跳变不误判截止 | 读 ev-g2-g07、ev-g2-09；核对 sweep 用 boot_id + 单调纳秒判定，缺锚点判 timer_uncertain | pass |
| G2-08 | 工具失败不许落完成（系统判失败并挂凭据） | 读 ev-g2-08；核对 run-node.ts 任一工具 exitCode≠0 即中断并 markBlocked('tool_execution_failed')；克隆里用失败痕迹投 done，实测被拒 | pass |
| G2-09 | 判定时限只认 boot_id 与单调纳秒（墙钟跳变不误判） | 读 ev-g2-09；核对 sweep.ts 的 verifyDeadline/clock.decide 与 clock.ts 的双钟采样 | pass |
| G2-10 | 报告入口系统级证据门（弱证据与伪造痕迹一律拒） | 读 ev-g2-10；核对 systemEvidenceGate → traceBindingGate → evaluateEvidence → pass conditions；克隆里伪造执行身份与无痕迹都被拒 | pass |
| G2-11 | 反复重投同一 report_id 不许把账本刷膨胀 | 读 ev-g2-11（只覆盖普通 id rpt_ev11_retry）；在克隆里用含引号的 report_id 重投：已应用 id 重投 3 次留下 3 条 report_replayed，已拒绝 id 重投 4 次留下 4 条 report_rejected（普通 id 对照均为 1）。去重口径见 P1 | fail |
| G2-12 | 工具授权只认 workflow 定义，请求体策略不参与 | 读 ev-g2-12；核对 run-node.ts 的 policyForNodeRun 只从账本绑定版本取，assertToolsAuthorized 拒绝未授权工具；请求体带 allow 的用例仍按定义判 | pass |
| G2-13 | 单写者锁与 epoch 围栏：第二写者拿不到锁，旧 epoch 写不进 | 读 ev-g2-13；核对 openServiceOrchestra 的取锁→bumpEpoch→建库顺序、createOrchestra 的锁凭证，以及 driver 事务开头的 epoch 比对 | pass |
| G2-14 | 长动作靠心跳续租，扫描不误判过期 | 读 ev-g2-14；核对 run-node.ts 的续租定时器与续租失败落 lease_lost 的收口 | pass |
| G2-15 | 同一工作流版本跨重启不可改写，在飞 run 的判定条件不跟着变 | 读 ev-g2-15；核对 workflows.ts 的 hydrate 内容哈希校验、同版本不同哈希拒绝、先落库再进目录 | pass |

## 三、发现

### P1-1 report_id 含引号/反斜杠/控制字符时，重试去重失效，账本被刷膨胀（G2-11、I7）

- 位置：src/service/commands/apply-report.ts:47-54。`hasNodeRunEvent` 在原始事件 JSON 上用 `payload LIKE '%"report_id":"' + reportId + '"%'` 判重。
- 根因：事件 payload 是 JSON 文本，report_id 里的 `"` 会被转义成 `\"`，拼接出来的 LIKE 模式永远匹配不到，于是“是否已有同类事件”恒为否。已应用报告的重试走回放分支（apply-report.ts:138-160）再追加一条 report_replayed；被拒报告的重试走 rejectReport（:65-87）再追加一条 report_rejected。
- 可达性：src/service/schemas.ts:89 的 `identifier = z.string().min(1).max(128)` 没有字符集约束，reportSchema 第 193 行用它校验 report.report_id，POST /v1/node-runs/report 会原样接收带引号的 id。
- 实测（克隆）：同一已应用报告 `rpt_"quote` 重投 3 次 → report_replayed 3 条；同一被拒报告 `rpt_"rej` 重投 4 次 → report_rejected 4 条；普通 id 对照均为 1 条。节点状态不被推进，但 append-only 账本逐次增长。
- 影响：违反 G2-11 与 I7“同一 report_id 的同类事件只留一条”。持续重试会无限增长 node_run_events，占满磁盘或拖慢回放/扫描；事件条数也不再是幂等事实。
- 现有证据没覆盖：docs/gates/evidence/G2/ev-g2-11.md 只用了普通 id `rpt_ev11_retry`，四次 HTTP 投递后 report_rejected=1、report_replayed=1。schema 接受、但证据没测的输入域里存在反例。
- 修复建议（二选一或并用）：把 report_id 落到列上（report_registry 已有该列）按列判重，或用 `json_extract(payload, '$.report_id') = ?` 与事件类型一起判；同时在 schemas.ts 把 report_id 限成明确字符集（如 `[A-Za-z0-9._:-]{1,128}`），服务层再校验一次。修好后补一条带引号 id 的证据，覆盖“同 id 多次重投仍只有一条事件”。

### P2-1 审计报告正文结论与结构化裁决矛盾时，门检查不报警

- 克隆实验 B1：报告正文写“本次审计结论：fail”，结构化裁决块写 pass（19/19），sign-gate 与 gate-check 都 exit 0。
- 设计上以结构化裁决为准，这本身说得通；但正文与裁决相反时，人读到的是 fail、门读到的是 pass，属于可误导的不一致。建议 sign-gate 在两者都有时做一次一致性检查（或在报告模板里不写自然语言结论），把矛盾当失败拦下。优先级低，不影响本轮结论。

## 四、攻击性验证（已签克隆，每次攻击后 git reset --hard 回基线，工作树均干净）

| 攻击 | 实测 |
| --- | --- |
| 往证据文件追加内容 | 门检查失败：审计报告的候选提交之后，候选文件又被改过 |
| 把正文结论 pass 改成 fail | 门检查失败：门记录正文结论与 GateArtifact 不符 |
| 把 audit_round 从 34 改成 35 | 门检查失败：audit_round 与审计报告的轮次不一致 |
| 改门记录正文其他字句 | 门检查失败：body_hash 与正文不符 |
| 在候选提交后改 src/core/canonical.ts | 门检查失败：候选文件又被改过 |
| 删掉正文必过项表一行 | 门检查失败：正文必过项表行数与 artifact 不符；sign-gate 同样拒绝 |
| 结构化裁决写 pass 但 p0=3 | sign-gate 拒绝：还有 3 个 P0 |
| 正文写 fail、裁决写 pass | 两者都放行（P2-1） |
| 同一 report_id 带引号反复重投 | 未被拦：事件逐次追加（P1-1） |
| 无工具痕迹直接报 done | 拒绝：evidence_unverifiable |
| 用失败的工具痕迹报 done | 拒绝：tool_execution_failed |
| 借用别的 execution_id 报 done | 拒绝：evidence_unverifiable |

## 五、哈希与证据复算

- 用独立脚本按 gate-check 同款口径（git show + LF 归一、canonical JSON 排序键、candidate 文件清单、body 自指替换）复算：主仓 19 份证据文件的 sha256 与证据索引逐份一致。
- 六个锚点（evidence_index、invariants、candidate、change_scope、artifact、body）在主仓与记录不一致，原因是 G2.md 仍处于预签态（audit_round=4、审计报告 sha 为 0），不是实现缺陷。在克隆里按正式流程签出的记录，六个锚点与复算值全部一致（candidate=4fb9a0d0…、scope=bb9a8e17…、artifact=3e42a613…、body=166cab04…），说明重算规则与记录口径一致。
- 本轮结论为 fail，不重签；修好 G2-11 后需要重新审计、重新签，再跑门检查。

## 六、结论

本轮 19 项必过中 18 项通过，G2-11 不通过：report_id 的字符集没有约束，而按 JSON 文本 LIKE 的去重对含引号的 id 失效，重试会把 append-only 账本刷膨胀。该问题可由 HTTP 上报入口触发，现有证据未覆盖这一输入域。另有 P2-1 的报告正文与裁决不一致问题。因此本轮判 fail，候选暂不放行；修复并补证后请安排下一轮独立审计。

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 34,
  "candidate_commit": "59fe18d53c554c788cb04437bffbd5f2df76ad4e",
  "conclusion": "fail",
  "p0": 0,
  "p1": 1,
  "p2": 1,
  "must_pass_total": 19,
  "must_pass_passed": 18,
  "must_pass_ids": ["G2-01", "G2-02", "G2-03", "G2-04", "G2-05", "G2-06", "G2-07", "G2-08", "G2-09", "G2-10", "G2-11", "G2-12", "G2-13", "G2-14", "G2-15", "G-03", "G-04", "G-05", "G-07"],
  "failed_items": ["G2-11"],
  "notes": "P1-1：report_id 含引号时 LIKE 判重失效，重投逐次追加 report_replayed/report_rejected，违反 G2-11 与 I7。P2-1：正文结论与结构化裁决矛盾时门不报警。预签态下锚点不一致属预期，修复后需重审重签。"
}
```
<!-- audit-verdict:end -->
