# S2 第二十五轮审计整改对照表

- 审计报告：`docs/audits/S2-independent-audit-round25.md`（审计对象 HEAD `6cb95b3`）
- 整改位置：本轮改动尚未提交，工作树内 `scripts/gate-check.ts`、`src/core/policy.ts`、`src/service/commands/apply-report.ts`、`scripts/fault-inject.ts`、`tests/gate-check.spec.ts`、`tests/policy.spec.ts`、`tests/apply-report.spec.ts`、`docs/gates/G2.md`
- 本表用途：逐条对应 P0/P1/P2、改法与回归用例。**本表不作为放行依据**——G2 是否过关由下一轮独立审计决定。

## P0-1 报告保留 `结论：pass`，追加常见否定句仍被读成 pass

- 根因：`FAIL_VERDICTS` 只覆盖「不通过 / 未通过 / 失败」等少数写法，`无法通过 / 不予通过 / 未获批准 / 被否决 / 没能通过 / 被驳回` 都不在表里；尾部判定还要求后接「结束 / | / 需应已了的」，句号与后续正文让命中落空。
- 改法：`scripts/gate-check.ts:652-693` 扩充中英文否定词表（含 `unable to pass`、`not approved`、`did not approve`、`refused to pass` 等）；`scripts/gate-check.ts:694-706` 增加西里尔/希腊同形字映射，`foldForVerdict` 先做同形字归一，`fаil`、`fаіl` 不再绕过。
- 新增结构化否定匹配器 `scripts/gate-check.ts:717-785`：否定词 + 最多两个填充词 + 通过类谓词 + 可选宾语（验收/标准/审批/评审/审核/考核/许可/批准/认可），覆盖「无法予以通过」「未达到通过标准」等未逐一枚举的变体。
- 用例：`tests/gate-check.spec.ts:294` 覆盖 20 条载荷（含同形字与英文），并要求三条安全句（`不通过项为 0`、`未通过验收项为 0`、上一轮历史否定）仍返回 pass。

## P0-2 门记录正文在「必过项与证据」前注入同一否定句仍签过

- 根因：`bodyConclusionOf` 与报告解析器共用同一套词表，P0-1 的漏词同样漏在门正文上。
- 改法：同一扫描器修好后，`bodyConclusionOf`（`scripts/gate-check.ts:877-893`）全文扫描即可命中；导出该函数供回归直接调用。
- 用例：`tests/gate-check.spec.ts:312` 覆盖在 `## 必过项与证据` 前追加「本次审计无法通过」「本报告未获批准」「本次审计未通过验收」三种写法，均须读出 fail；`不通过项为 0` 仍为 pass。

## P1-1 requiredHashes 不按 key 绑定产物，命令哈希/摘要可冒充

- 根因：`trustedHashes` 把 trace 哈希与 output 摘要混成一个集合，任意一个 64-hex 就可以满足任意 required key。
- 改法：`src/core/policy.ts:18-70` 的 `EvidenceGateOptions` 改为 `{ output?: unknown }`。每个 required key 必须同时满足：证据里该 key 是 64-hex；`output` 是非数组对象且自身含同名 key；值等于 `sha256Hex(canonicalJson(output[key] ?? null))`。命令哈希、stdout 哈希、整个 output 的摘要都不能冒充；两个 key 也不允许共用同一哈希。
- `src/service/commands/apply-report.ts:245-255` 删掉 `trustedHashes`，done 收口直接传 `report.output`。
- 用例：`tests/apply-report.spec.ts:381` 阳性对照；`:393` 命令哈希冒充；`:405` output 缺键；`:417` 两个 key 共用一个哈希。`tests/policy.spec.ts` 同步补「命令哈希不能冒充」「output 无同名产物拒绝」。

## P1-2 failed / timeout 仍可拿成功行与成功事件收口

- 根因：`traceBindingGate` 只在候选里找与证据全等的一行，同 attempt 已有失败行时仍可能拿成功行对上。
- 改法：`src/service/commands/apply-report.ts:345-378`。`failedRows = rows.filter(exit_code !== 0)`；done 且存在失败行 → `tool_execution_failed`；`report.status === 'failed'` 时 `requireFailure: true`，没有失败行就拒绝——证据自称成功归 `tool_execution_failed`，证据自称失败则归 `evidence_unverifiable`；只要存在失败行，候选集合只取失败行，成功证据无法收口。
- 用例：`tests/apply-report.spec.ts:459`（failed 只有成功行）、`:470`（failed 同 attempt 另有失败行）、`:486`（timeout 同 attempt 另有失败行）；原「失败行与 tool_finished 对齐 → 正常收口」阳性对照保留。

## P1-3 ev-g2-14 / ev-g2-15 重跑字节不稳定

- 根因：对账文本直接输出 `tool_start_at`、`lease_expires_at`、`verify_deadline_at` 的实时值。
- 改法：`scripts/fault-inject.ts:48-74` 的 `normalizeEvidence` 在实体 id 归一前，把 ISO-8601 时间戳统一写成 `<ts>`；证据仍保留字段名与结构，只去掉运行时刻噪声。
- 复跑：`ev-g2-14` 连跑两次 sha256 均为 `4e0776e96e91cc6d486ceb43504e7596c6d251bda2eb9f3ad5b3929c09fc982c`；`ev-g2-15` 连跑两次均为 `7648abe92c2026e4c5739c5f5714f448a2ce8864fc07a129f607675af415643f`。
- `docs/gates/G2.md` 正文表与 JSON 锚内的两处旧哈希已同步替换；最终重签时再随 artifact 一起重算。

## P2-1 仍漏「未能通过 / 被驳回 / 遭否决 / 未通过验收」与西里尔同形字

- 改法同上：否定词表补齐「本次审计没能通过 / 被驳回 / 遭否决 / 无法予以通过 / 不获批准 / 不予批准 / 未通过验收 / 不通过验收 / 未达到通过标准」，同形字映射覆盖 `а е о р с у х і ј ѕ ԁ һ ӏ` 与希腊字母。
- 旧用例里把「本报告未通过验收」当作安全句的夹具属于旧口径错误：这句话本身就是可见否定，已从安全句移除，并在第二十五轮载荷中断言为 fail。
- `tests/gate-check.spec.ts:294` 四类载荷均覆盖。

## 验收

- `node node_modules/typescript/bin/tsc --noEmit` → exit 0。
- `tests/policy.spec.ts` + `tests/apply-report.spec.ts` → 2 文件 / 55 例全过。
- `tests/gate-check.spec.ts` → 76 例，65 passed / 11 failed；11 红全部是 G1 预签态（`audit_report_sha256=0*64` 对实际 `50ba1b13cdf1b84d…`），无新增解析器回归。
- 全量 `vitest` → 32 文件 / 357 例，346 passed / 11 failed，仍全部是预签态。

## 未做与边界

- G1/G2 未重签；当前门记录仍是预签态，不能拿本表当放行依据。
- S1 第二十一轮审计仍在进行；其结论回来后与 S2 第二十六轮一并整改、提交、重审。
