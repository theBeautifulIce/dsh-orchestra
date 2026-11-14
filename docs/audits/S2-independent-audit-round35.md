# S2 第三十五轮独立审计报告（G2）

门：G2

候选提交：51cf4d3f89a774d3d2ddfc77fc333fffc33da1c3

- 审计日期：2026-11-14
- 审计对象：D:\aboutAI\dsh-orchestra（编排引擎：SQLite 单写者 + CAS + Ga/Gr 双代次 + append-only ledger + evidence gate）
- 审计方式：只读复核。唯一写入是本报告文件；签名与攻击实验在 %TEMP% 克隆（51cf4d3 检出）里做，主仓工作树保持干净。
- 候选提交说明：委派单给的 51cf4d3531f0a74c9d8b1a31f4f0c5be8d2e0a71 在仓库里不存在（git cat-file 取不到对象），只有前 7 位相同。按委派单「以真实 HEAD 为准」的口径，本报告绑定真实 HEAD 51cf4d3f89a774d3d2ddfc77fc333fffc33da1c3，并已在结构化裁决块里同步。

## 一、总体判定

本轮重点复核第三十四轮 P1-1（report_id 带引号时判重失效）、P2-1（正文结论与结构化裁决互补一致），以及 S1 第二十九轮三条 P2（多裁决块、must_pass_ids 混入规格外 id、有裁决块时正文不参与判定）。

三项修复都成立：带引号/反斜杠/空格的 report_id 在 HTTP 入口被 400 挡下且不落事件；同一 id 反复重投被拒报告只留一条 report_rejected 与一条 report_replayed；多裁决块与规格外 id 都被拒；正文写明确结论时与裁决不符会被签门拦下。19 项必过项的功能行为全部成立，全量用例 518 通过 1 跳过，类型检查通过。

阻断来自新的 P1：门记录正文与 ev-g2-02 等证据都承诺「重跑字节不变」，但在当前 HEAD 上 19 份证据只有 6 份能重跑出同样字节，12 份生成出不同内容，ev-g2-09 的复现命令直接 exit 1。根因是 scripts/fault-inject.ts 仍发 leaseTtlMs: 600000，而 HTTP schema 上限 120000（59fe18d 起），节点因此停在 queued、后续报告全被 status_mismatch 拒。门检查只比对已存字节，看不到这道漂移；若按现状重签，门会把无法复现的证据签成 pass。

另有一条 P2：正文一致性检查在结论不可判定时静默跳过，报告正文可以写「G2-11 未通过」而仍配 pass 裁决签过门（已实测放行）。

结论：fail

## 二、必过项核对（19/19）

| 编号 | 核对要点 | 实测 |
| --- | --- | --- |
| G2-01 | 单节点从 queued 到终态走生产装配 | pass：ev-g2-01 账本片段与 HTTP 链路一致；当前 HEAD 重跑与存档只差 JSON 键序 |
| G2-02 | 重复上报只落一次 | pass：tests/integration/apply-report.spec.ts 覆盖；证据需按 P1 重生成 |
| G2-03 | 租约过期迟到上报 | pass：迟到上报被租约拦住，attempt 不推进 |
| G2-04 | 取消不产生新 attempt | pass：取消不改已完节点 |
| G2-05 | 终态必带强证据 | pass：不可逆节点只给 exitCode 被拒 verification_too_weak |
| G2-06 | 卡住必须挂凭据、无裸 blocked | pass：裸卡住按 decision_required 拒收，节点留 verifying |
| G2-07 | parallel 被应用层拒 | pass：ev-g2-07 重跑字节一致 |
| G-03 | 同 id 两次只落一次 | pass：ev-g2-g03 重跑字节一致 |
| G-04 | 迟到上报被拒 | pass：注入参数与前后账本齐全；当前 HEAD 重跑仅键序/时间归一差异 |
| G-05 | 取消只立一次围栏 | pass：围栏状态与事件数一致 |
| G-07 | 墙钟跳变不误判 | pass：判定只读 boot_id 与单调纳秒 |
| G2-08 | 工具失败不落完成 | pass：exitCode 非零由系统判失败并卡 blocked_post |
| G2-09 | 单调纳秒判时限 | pass：单元与集成用例覆盖；但复现命令当前 exit 1（见 P1） |
| G2-10 | 报告入口证据门 | pass：弱来源、伪造痕迹、空证据一律拒 |
| G2-11 | 反复重投被拒报告不刷膨胀账本 | pass：见第三节实测；重投 4 次只落 1 条 report_rejected + 1 条 report_replayed |
| G2-12 | 工具授权只认定义 | pass：runNode 按 node_run → runs.workflow_version 取 node.tools |
| G2-13 | 单写者锁与 epoch | pass：第二写者 ELOCKED、旧 epoch STALE_GENERATION |
| G2-14 | 心跳续租 | pass：ev-g2-14 重跑字节一致，续租失败落 lease_lost |
| G2-15 | 版本跨重启不可改写 | pass：workflow_versions 落表，同版本改写 409 |

说明：19 项的功能判定依据是「证据内容 + 对应单元/集成用例 + 本轮针对性复跑」。证据文件不可复现的问题单列为 P1，不改变各必过项行为判定，但会阻断重签。

## 三、本轮修复复核

### 3.1 report_id 判重与入口字符集（第三十四轮 P1-1）

- 判重 SQL（src/service/commands/apply-report.ts:50-57）改为 `json_valid(payload)` + `json_extract(payload, '$.report_id')`，报告 id 作为绑定参数，不再拼接字符串；因此带引号、反斜杠的 id 不会再让判重失效。
- 入口约束（src/service/schemas.ts:89-94）：report_id 只允许 `[A-Za-z0-9._:-]+`，长度 1..128。引号、反斜杠、空格在 HTTP 入口即 400，且不写账本、不建 registry 行。
- 实测：`['rep_"quote', 'rep_\\back', 'rep_ sp ace']` 三例均 400 并点名 report.report_id（tests/contract/routes.spec.ts 有对应用例）；ev-g2-11 里带引号 id 连投 2 次均 400，report_rejected 仍为 1。
- 服务层同 id 重投（绕过 HTTP 直接投喂）也有回归：带引号 id 的 applied 与 rejected 重投各只落一条事件（tests/integration/apply-report.spec.ts）。
- G2-11 现在真的成立：4 次重投实测返回 accepted:false reason status_mismatch，账本为 report_applied=0、report_replayed=1、report_rejected=1，registry 只有一行。

### 3.2 正文结论与裁决绑定（第三十四轮 P2-1）

- 明确结论的场景已绑住：把正文改成「结论：fail」而裁决写 pass，签门报「审计报告正文结论与结构化裁决不符：正文=fail，裁决=pass」。
- 但一致性检查只在 auditConclusionOf 返回非 null 时生效（scripts/gate-check.ts:2095-2107）。两行结论、或正文含否定句时该函数返回 null，检查被跳过（见 P2-1）。

### 3.3 S1 第二十九轮三条 P2

- 多裁决块：sign-gate 报「裁决块必须正好一个（找到 2 个开始标记、2 个结束标记）」，拒绝。
- must_pass_ids 混入规格外 id：verdictProblems 逐项比对门规格，未知 id 报「must_pass_ids 里有门规格之外的项」，拒绝（tests/unit/audit-verdict.spec.ts 覆盖）。
- 有裁决块时正文参与判定：明确结论时生效（3.2），歧义时失效（P2-1）。

## 四、P1-1 证据复现契约在当前 HEAD 上不成立

现象（在 51cf4d3 克隆里逐案例重跑 scripts/fault-inject.ts，与 HEAD blob 的 git hash-object 比对）：

- 字节一致 6 份：ev-g2-07、ev-g2-11、ev-g2-12、ev-g2-13、ev-g2-14、G-03。
- 字节不一致 12 份：ev-g2-01、ev-g2-02、ev-g2-03、ev-g2-04、ev-g2-05、ev-g2-06、ev-g2-08、ev-g2-10、ev-g2-15、G-04、G-05、G-07。
- 直接 exit 1 1 份：ev-g2-09 抛 STALE_GENERATION（details: {"what":"transitionNode","changes":0}，位置 scripts/fault-inject.ts:878）。

根因：scripts/fault-inject.ts 有 8 处 `leaseTtlMs: 600000`（:477、:712、:753、:865、:950、:1012、:1099、:1312），而 src/service/schemas.ts:17-18 规定 leaseTtlMs 上限 120000（59fe18d 批次引入的 Zod 约束）。HTTP 返回 400「拿租约校验没过：leaseTtlMs 大于上限 120000」，节点停在 queued，后续报告全部 status_mismatch；ev-g2-09 则因节点没进到可转移状态而在 anchorVerifying 处 0 行更新。

定量验证：只把 8 处 600000 改成 120000（不动业务代码）后重跑，19 个案例全部 exit 0；ev-g2-02、ev-g2-04、ev-g2-06、ev-g2-09、ev-g2-15 立即与存档字节一致，其余 8 份只差 JSON 键序与 `<ts>` 时间归一（行为等价）。说明漂移全部来自注入器夹具，不是裁决行为变化。

危害：门记录正文第 11 行写「证据可由 scripts/fault-inject.ts 重跑出同样的字节」，第 92 行的复现命令也写「重跑字节不变」；按文档跑一遍会把 12 份证据改写成与存档不同的内容，ev-g2-09 还会中断。gate-check 的证据检查只读 HEAD 已存字节（scripts/gate-check.ts checkEvidence），因此看不到这道漂移——重签会把不可复现的证据锁成 pass。

整改建议：把 fault-inject 的租约时限改为读取 LIMITS 上限内的值（或直接 120000），重生成全部 19 份证据；在测试或 CI 里加一条「逐案例重跑并与 HEAD 证据比对字节」的守卫，避免夹具再随 schema 改动静默漂移。

## 五、P2-1 正文一致性检查可被歧义正文绕开

scripts/gate-check.ts:2095-2107 只在 prose !== null 时比对；而 auditConclusionOf 在以下情形返回 null：两行结论、正文出现否定句且裁决为 pass（:1437）、渲染歧义。实测：

- A7：正文先写「结论：pass」再写「结论：fail」，裁决写 pass → 签名成功，gate-check 通过。
- A8：正文写「G2-11 未通过，仍需整改。」，裁决写 pass → 签名成功，gate-check 通过。

这使「正文若写结论必须与 conclusion 一致」的约束可被一行文字绕过。整改建议：当裁决为 pass 且正文出现任何否定性判定（inlineFail 为真）或结论行不唯一时，直接拒绝，而不是当作「没有正文结论」放行；老报告（无裁决块）走词法兜底的分支不受影响。

## 六、攻击矩阵（%TEMP% 克隆，51cf4d3 检出）

| 编号 | 攻击 | 结果 |
| --- | --- | --- |
| A0 | 脏树改证据 / 改门正文 | 拦住：「工作树有未提交改动，门记录不能对着脏树签」 |
| A1 | 提交后再改证据一个字节 | 拦住：「审计报告的候选提交之后，候选文件又被改过：docs/gates/evidence/G2/ev-g2-07.md」 |
| A2 | 提交后再改门正文一个字节 | 拦住：「body_hash 与正文不符」 |
| A3 | 删掉必过项表一行 G2-05 | 拦住：「正文必过项表有 18 行，artifact 有 19 项」 |
| A4 | 审计报告换绑 scopeBase 4f3ada7 | 拦住：「候选提交之后，候选文件又被改过：codebasemap.md」 |
| A5 | 追加第二个裁决块（pass + fail 各一） | 拦住：「裁决块必须正好一个（找到 2 个开始标记、2 个结束标记）」 |
| A6 | 正文「结论：fail」配裁决 pass | 拦住：「正文结论与结构化裁决不符：正文=fail，裁决=pass」 |
| A7 | 两行结论（pass、fail）配裁决 pass | 放行：签名成功、gate-check 通过（P2-1） |
| A8 | 正文写「G2-11 未通过」配裁决 pass | 放行：签名成功、gate-check 通过（P2-1） |

A4 说明：换绑到 scopeBase 后，范围里出现 codebasemap.md 等候选文件改动，被候选范围检查拦下；换绑到 HEAD 自身则范围为空，属于正常用法，不算攻击。

## 七、实测量化

- `node node_modules/typescript/bin/tsc --noEmit`：exit 0。
- `node node_modules/vitest/vitest.mjs run`：Test Files 36 passed (36)；Tests 518 passed | 1 skipped (519)；vitestExit 0。
- 主仓 `git status --porcelain`：跑测试与类型检查后仍为空，只新增本报告。
- 主仓 `node scripts/gate-check.ts` 停在「审计报告 sha256 与记录不符 000… != …」：预签态设计使然，不是缺陷；门记录当前 audit_round=4、audit_report_sha256=0*64。
- 证据重算：19 份按 HEAD 字节 LF 归一重算的哈希与门记录表内值多处不同（表内是第 4 轮旧值），重签会重算；这不是缺陷，但重算后只能固定「已存字节」，固定不了「能否重跑出来」（见 P1-1）。
- 签名流程验证：用本报告格式的 pass 草稿在克隆里签过一次，gate-check exit 0，确认格式（绑定行、单一裁决块、19 项清单、文件名轮次）符合门检查要求。

## 八、判据与整改建议

1. 先修 P1-1：fault-inject 的 8 处租约时限降到 schema 上限内，重生成 19 份证据，并加逐案例字节复现守卫；否则重签等于给不可复现的证据背书。
2. 再修 P2-1：裁决为 pass 时，正文出现否定判定或结论行不唯一应直接拒绝，而不是跳过一致性检查。
3. 两项修完后重签 G2，并重跑 tsc、全量 vitest、19 份证据复现与 gate-check。

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 35,
  "candidate_commit": "51cf4d3f89a774d3d2ddfc77fc333fffc33da1c3",
  "conclusion": "fail",
  "p0": 0,
  "p1": 1,
  "p2": 1,
  "must_pass_total": 19,
  "must_pass_passed": 19,
  "must_pass_ids": ["G2-01", "G2-02", "G2-03", "G2-04", "G2-05", "G2-06", "G2-07", "G-03", "G-04", "G-05", "G-07", "G2-08", "G2-09", "G2-10", "G2-11", "G2-12", "G2-13", "G2-14", "G2-15"],
  "failed_items": [],
  "notes": "G2-11 判重修复成立；门自带证据复现契约在 12/19 份上不成立（P1），正文一致性检查可被歧义正文绕开（P2）"
}
```
<!-- audit-verdict:end -->
