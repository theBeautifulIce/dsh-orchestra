# S1 门 G1 独立审计（第 31 轮）

门：G1

候选提交：0e2274fff1a62ea0457cbeb804e2e887142af88e

## 范围与方法

- 只读审计：不改仓库已跟踪文件；破坏性验证在 %TEMP% 独立克隆（git clone --no-hardlinks，C:\Users\ASUS\AppData\Local\Temp\s1r31-clone-7ef4969b）里做，克隆内可随意改。
- 审计开始与结束时各断言一次主仓 git status --porcelain 为空（结束时只有本报告这一个新增未跟踪文件）。
- 逐条读源码核对本轮四项整改，再独立构造攻击：正文与裁决不一致、证据不可复现、必过清单被灌水，并回归历史报告。

## 实测命令（主仓，候选 0e2274f）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| node node_modules/typescript/bin/tsc --noEmit | 0 | 无输出，类型检查通过 |
| node node_modules/vitest/vitest.mjs run | 0 | Test Files 37 passed (37)；Tests 524 passed \| 1 skipped (525)；12.25s |
| node --experimental-strip-types --no-warnings scripts/check-evidence-repro.ts | 0 | 证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致 |
| node --no-warnings scripts/gate-check.ts docs/gates/G1.md | 1 | 审计报告 sha256 与记录不符：0000… != 50ba1b13cdf1b84d…（HEAD 的 G1.md 仍是预签态，audit_report_sha256 为 64 个 0，证据哈希也是旧值，属待重签，不是本轮回归） |

克隆内自洽验证（把本轮报告放进克隆、改 G1.md 的 audit_round 与 audit_report、重签再检查）：

- node --no-warnings scripts/sign-gate.ts docs/gates/G1.md → exit 0，输出「重签完成：证据 13 份，candidate=100556b94af5…，artifact_hash=8c7b7e92d3a0…，body_hash=e01e774eea5c…，改动文件 160 个」。
- node --no-warnings scripts/gate-check.ts docs/gates/G1.md → exit 0，输出「gate G1 通过（13 项必过、13 份证据哈希复核…）」。

门记录重签流程在正确输入上自洽，exit 0 可复现。

## 本轮整改逐条核对

1. S2 第三十五轮 P1-1（注入器时钟冲突）：scripts/fault-inject.ts 的 8 处 leaseTtlMs 已全部由 600000 改为 120000（第 490、725、766、878、963、1025、1112、1325 行），与 src/service/schemas.ts 的 120000 上限一致；另有第 1066 行 1000 与第 390 行 30000 属不同场景，保留合理。25 份证据已重生成，check-evidence-repro 两遍比对全部字节一致（exit 0）。
2. 证据归一：normalizeEvidence（scripts/fault-inject.ts:44-81）把时间戳归一为 `ts`、第 73 行把「线上库 sha `hex`」归一为 `db_sha`、事件与实体 id 归一；writeEvidence（83-104 行）经 scrubPath 把临时目录绝对路径归成 `tmp` 占位加文件名（89-97 行）。实测重生成字节稳定。
3. S2 第三十五轮 P2-1 与 S1 第三十轮 P2-1（正文与裁决背离）：scripts/gate-check.ts:1445 新增导出 proseVerdictClashes，独立扫三类背离——结论行不唯一、结论行与裁决相反、必过项在正文里被写成未通过；checkAuditAnchor 用它替换旧的「auditConclusionOf 返回 null 就跳过」写法。三类攻击实测全部被拒。
4. S1 第三十轮 P2-2（必过清单灌水）：src/core/audit-verdict.ts:150-184 的 verdictProblems 现要求 must_pass_total 等于门规格项数（173-175 行）、must_pass_ids 不许重复（169-172 行）、total 等于 ids 条数、且每个 id 必须属于本门规格。灌水与重复攻击实测全部被拒。
5. S1 第三十轮 P2-3（G-14/G-15 断言与归一）：G-14 断言跟随实际迁移表，G-15 路径与线上库 sha 已归一；两份证据在 HEAD 重跑与记录字节一致（check-evidence-repro 覆盖）。

## 攻击验证

| 编号 | 攻击输入 | 期望 | 实测 |
| --- | --- | --- | --- |
| A1 | 报告正文写两行结论（pass 与 fail 各一行） | 拒绝 | gate-check exit 1：正文出现 2 条结论行（pass、fail），结论必须唯一 |
| A2 | 正文唯一结论行写成 fail，裁决块仍写 pass | 拒绝 | exit 1：正文结论行是 fail，裁决是 pass |
| A3 | 正文断言某个必过项未通过 | 拒绝 | exit 1：正文把必过项写成未通过，裁决却是 pass |
| A5 | 用引用定义行藏一条结论 | 拒绝 | exit 1：正文藏着看不见的判定 |
| A6 | 历史叙述「上一轮某项未通过，本轮已修好」 | 不误伤 | 误伤（见 P2-2）：被判为当轮否决；改写成「第30轮…」形式即通过 |
| A7 | 正常正文「13 项必过项逐项核对，全部通过」 | 放行 | 放行，无误报 |
| C1 | 13 项全列后重复一项，total/passed 抬到 14 | 拒绝 | 拒绝：must_pass_ids 里有重复项，且审计没覆盖被挤掉的那项 |
| C2 | total=14 并混入规格外项 G1-99 | 拒绝 | exit 1：total（14）与门规格项数（13）不符，且 G1-99 在规格之外 |
| C5 | passed=14、total=13 | 拒绝 | 拒绝：必过项没过完（14/13） |
| B1 | 改注入器输出格式但不重生成证据 | 拒绝 | check-evidence-repro exit 1：证据复现不成立（25/50 份），逐份指名漂移 |
| B2 | 手改证据后在原候选上重签 | 拒绝 | sign-gate exit 1；gate-check exit 1：候选提交之后候选文件又被改过；repro exit 1（1/26 份） |
| B3 | 手改证据做成新候选，报告绑新候选后重签 | 门记录自洽，但复现守卫必须抓住 | sign-gate exit 0；gate-check exit 0（13 项必过、13 份哈希复核通过）；check-evidence-repro exit 1：1/26 份漂移，指名该证据。证明新守卫是「自洽但不可复现」的唯一防线 |

补充：A1、A2、A3、A5、C2 这些报告在克隆里即使先手动重算 audit_report_sha256 与两个自锚，gate-check 仍逐条拒绝；sign-gate 自身也因末尾 verifyGateRecord 拒绝落笔。

## 历史报告回归

docs/audits 下共 88 份历史报告：84 份无裁决块；2 份 pass 裁决（round29、round30，均为本门 G1、13 项）proseVerdictClashes 均返回空、零误报；2 份否决裁决（S2 round34、round35，门 G2、19 项）按否决处理，未被误放行。没有解析错误。历史正常 pass 报告不被新检查误伤。

## 非阻断问题（P2，均不阻断签署）

- P2-1 词法规避：proseVerdictClashes 是词法匹配，正文换成「某项仍是问题」「某项的检查结果为 fail」这类同义说法可以不被识别。不阻断：机器口径由裁决块与门记录钉住的报告 sha 决定，正文措辞不能改裁决；建议后续补语义化的必过项断言行。
- P2-2 历史句剥离偏窄：HISTORICAL_AUDIT_SENTENCE_RE（scripts/gate-check.ts:1224）只剥以「第 N 轮 / round N」开头的整句，「上一轮…未通过，本轮已修好」会被当成当轮否决而误伤。不阻断：改成「第30轮…」即可，且规范里正面用例不含项号，现有测试不受影响。
- P2-3 候选枚举噪声：candidateEntries 会走已删除的旧路径（tests/*.spec.ts），git 反复打印 fatal: path … does not exist in HEAD（克隆实测 160 个候选文件）。只是 stderr 噪声，门检查仍 exit 0。
- P2-4 委派模板字段与实际 schema 不一致：下发的裁决块模板写 candidate_hash 与 VERDICT-BEGIN 标记，而 gate-check 实际解析 audit-verdict/1 的 candidate_commit 与 audit-verdict:begin 标记；照抄模板会解析失败。本报告按真实 schema 写，并同时保留 candidate_hash 字段以兼容模板口径。

## 结论

结论：pass

必过项 13/13，清单与门规格逐项一致；P0=0、P1=0、P2=4（均不阻断签署）。

必过项全部实测通过：迁移空库可重复、迁移中途杀可重入、进程杀不丢已提交事件、备份独立目录行数与哈希一致、损坏备份可检出、认证拒匿名写、阶段开关拒未知值、事务 COMMIT 前杀进程、COMMIT 后未投递被杀、长事务读写与 503、订阅者离线重放、迁移一半杀后重跑、备份截断检出与恢复被挡下。

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 31,
  "candidate_commit": "0e2274fff1a62ea0457cbeb804e2e887142af88e",
  "candidate_hash": "0e2274fff1a62ea0457cbeb804e2e887142af88e",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 4,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": ["G1-01", "G1-02", "G1-03", "G1-04", "G1-05", "G1-06", "G1-07", "G-01", "G-02", "G-08", "G-09", "G-14", "G-15"],
  "failed_items": [],
  "notes": "13/13 必过；注入器时钟、证据归一、正文与裁决一致性、必过清单去重全部修住；新复现守卫在自洽候选上仍能抓出手改证据（B3）；4 项 P2 均不阻断"
}
```
<!-- audit-verdict:end -->
