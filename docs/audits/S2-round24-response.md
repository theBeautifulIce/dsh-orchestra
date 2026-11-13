# S2 第二十四轮审计整改对照表

- 审计报告：`docs/audits/S2-independent-audit-round24.md`（审计对象 HEAD `638605c`）
- 整改提交：`24ffd47`「Reject hidden audit negatives and bind evidence hashes」
- 本表用途：逐条对应 P0/P1、改法与回归用例。**本表不作为放行依据**——G2 是否过关由下一轮独立审计决定。

## P0-1 报告可见否定句仍被读成肯定

- 根因：引号夹在主语与结论词之间时匹配中断；折叠只删有限连接号，不含 U+2011/U+2010/U+2012；结论词表不含「失败」。
- 改法：`scripts/gate-check.ts:637-751` 改为折叠扫描。`foldForVerdict` 先 NFKC、小写、删撇号，再丢弃 Cf/Mn/Me、空白映射 `|`，标点/符号映射 `|`，所有 token 之间允许任意 `|`；`FAIL_SUBJECTS` 含「本次审计」「审计报告」「审计」「结论」等简繁写法，`FAIL_VERDICTS` 含「不通过/未通过/失败/未成功/未过关/不批准」及英文 fail/failed/failure/not pass/didnt pass 等。
- 图片 alt 也先剥离标签、`unescapeAll`、`normalizeAuditLine` 再进同一扫描器（`scripts/gate-check.ts:607-613`），零宽字符、组合符与 `<wbr>` 不再打断。
- 正文结论门 `bodyConclusionOf`（`scripts/gate-check.ts:797`）改用全文折叠扫描，不再有 24 字偏移或 160 字长度窗口，长行与前置偏移否定句都会被读出。
- 用例：`tests/gate-check.spec.ts:737`「S2 第二十四轮 P0-1」覆盖 36 个载荷（引号、括号、逗号、省略号、同义否定、U+2011/U+2010/U+2012/U+2043、失败、全角 fail、英文变体），并保留两条安全句阳性对照；`tests/gate-check.spec.ts:869` 覆盖门正文长行与偏移。

## P1-1 requiredHashes 只验形态，伪造 `a*64` 仍可收口

- 根因：`evaluateEvidence` 只看值是否 64 位十六进制；服务端没有任何「这个哈希来自哪份产物」的绑定。
- 改法：`src/core/policy.ts:16-58` 的 `evaluateEvidence` 增加 `EvidenceGateOptions.trustedHashes`；requiredHashes 的每个值必须同时满足 64-hex 与落在 trusted 集合内，否则 `verification_too_weak`。
- `src/service/commands/apply-report.ts:245-275`：done 收口时 trusted 集合由两项组成——`sha256Hex(canonicalJson(report.output ?? null))`，以及 `traceBindingGate` 匹配到的同 attempt 工具行 stdout/stderr/command 哈希。
- 用例：`tests/policy.spec.ts`「形态合法的伪造哈希不算证据」；`tests/apply-report.spec.ts`「required_hashes 的 64 位伪造值不在服务端可核验集合 → verification_too_weak」与「真实工具痕迹哈希 → 正常收口」。

## P1-2 失败/超时终态证据只查存在性

- 根因：`terminalEvidenceGate` 只检查证据存在、来源与 exitCode 是数字；没有和同 attempt 的 `tool_executions` / `tool_finished` 对齐，失败终态可拿一条自报 exitCode 收口。
- 改法：删除 `terminalEvidenceGate`；`traceBindingGate` 增加 `{ allowFailed?: boolean }`（`src/service/commands/apply-report.ts:345-397`）。done 时缺省拒绝同 attempt 任一失败行；failed/timeout 时允许失败行，但证据的 `tool/exitCode/stdoutHash/stderrHash/commandHash` 必须与某一行全等，且该行必须有匹配的 `tool_finished` 事件。
- 用例：`tests/apply-report.spec.ts` 新增「证据与轨迹退出码矛盾 → evidence_unverifiable」「没有工具痕迹 → evidence_unverifiable」「失败行与 tool_finished 对齐 → 正常收口」三例；原阳性夹具补失败行与事件。

## 验收

- `node node_modules/typescript/bin/tsc --noEmit` → exit 0。
- `tests/policy.spec.ts` + `tests/apply-report.spec.ts` → 2 文件 / 47 例全过。
- `tests/gate-check.spec.ts` → 74 例，63 passed / 11 failed；11 红全部是 G1 预签态（`audit_report_sha256=0*64` 对实际 `50ba1b13cdf1b84d…`），无新增解析器回归。
- 全量 `vitest` → 32 文件 / 348 例，337 passed / 11 failed，仍全部是预签态。
- S1 第二十轮 21 个载荷与 S2 第二十四轮 36 个载荷在落盘代码上重新探针，全部返回 null；安全句仍返回 pass。

## 未做与边界

- G1/G2 未重签；当前门记录仍是预签态，不能拿本表当放行依据。
- S1 第二十轮的同批 P0/P1 见 `docs/audits/S1-round20-response.md`。
