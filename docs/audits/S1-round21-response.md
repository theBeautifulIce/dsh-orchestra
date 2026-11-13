# S1 第二十一轮审计整改对照表

- 审计报告：`docs/audits/S1-independent-audit-round21.md`（审计对象 HEAD `6cb95b3`，门 G1）
- 整改位置：本轮改动尚未提交，工作树内 `scripts/gate-check.ts`、`tests/gate-check.spec.ts`
- 本表用途：逐条对应 P0/P1/P2、改法与回归用例。**本表不作为放行依据**——G1 是否过关由下一轮独立审计决定。

## P0-1 否定词后接宾语

- 载荷：`本报告未通过验收。` / `本次审计未通过评审。` / `本報告未通過驗收。`
- 根因：谓词表只有「不通过 / 未通过」，没有把「验收 / 评审」等宾语纳入结构化匹配；繁體谓词也未入表。
- 改法：`scripts/gate-check.ts:652-693` 补繁體 `未通過驗收` / `不通過驗收` / `未通過評審` / `未通過審核`；`scripts/gate-check.ts:766` 的 `FAIL_OBJECTS` 补 `驗收 / 標準 / 審批 / 評審 / 審核 / 許可 / 認可`；`scripts/gate-check.ts:759` 的 `FAIL_PASS_STEMS` 补繁體谓词。
- 用例：`tests/gate-check.spec.ts:323` 逐条断言 16 条 P0 载荷全部不是 pass。

## P0-2 英文缩写否定

- 载荷：`The audit doesn't pass.` / `The audit won't pass.` / `The audit hasn't passed.`
- 根因：`foldForVerdict` 去掉撇号后得到 `doesnt / wont / hasnt`，否定词表只有带空格的 `does not` 等形式。
- 改法：`scripts/gate-check.ts:748-758` 的 `FAIL_NEGATIONS` 补 `does not / doesnt / will not / wont / do not / dont / have not / havent`。
- 用例：同 `tests/gate-check.spec.ts:323`。

## P0-3 英文批准类否定

- 载荷：`The audit was not approved.` / `The audit is not passing.`
- 根因：`not approved` 虽在直接词表中，但 `is not passing` 被折成 `is|not|passing` 后，结构否定器的 `matchPrefix` 在 `passing` 前遇到分隔符 `|` 匹配失败。
- 改法：`scripts/gate-check.ts:778-790` 的 `matchPrefix` 先跳过前导 `|` 再匹配，返回值保留跳过的那段，使 `is|not|passing` 能整体命中；`scripts/gate-check.ts:652` 另补 `not passing`。
- 用例：同 `tests/gate-check.spec.ts:323`，门正文另见 `:317`。

## P0-4 中文批准 / 驳回 / 否决

- 载荷：`本报告未获批准。` / `本报告被驳回。` / `本报告被否决。` / `本报告没有获得通过。`
- 根因：否定词后接「获得 / 获 / 被」等填充词再接到谓词时，结构否定器的填充词表与谓词表都不足。
- 改法：`scripts/gate-check.ts:748-766` 补 `没有 / 未获 / 不予 / 不获 / 被 / 遭` 等否定与 `获得 / 予以 / 获` 等填充；`FAIL_PASS_STEMS` 补 `批准 / 驳回 / 否决 / 拒绝 / 获批`。
- 用例：同 `tests/gate-check.spec.ts:323`。

## P0-5 同形字绕过

- 载荷：`本报告 fаil。`（西里尔 а U+0430）/ `本报告未通о过。`（西里尔 о U+043E 插在「通」「过」之间）
- 根因：`HOMOGLYPHS` 只做整字映射；汉字之间夹一个拉丁/西里尔/希腊字母时，该字母被当作普通字母保留，`未通过` 被拆断。
- 改法：`scripts/gate-check.ts:707-745` 的 `foldForVerdict` 改为按字符遍历；当该字符是一个 Latin/Cyrillic/Greek 字母、且前后都是汉字时跳过该字符，再做同形字归一。正常中英混排（如「本轮 fail」）不受影响。
- 用例：同 `tests/gate-check.spec.ts:323`。

## P0-6 连接词重复超过 8 次

- 载荷：`本报告的的的的的的的的的不通过。` / `The audit was was was was was was was was was not pass.`
- 根因：结构否定器连接词循环写死 `for (let guard = 0; guard < 8; guard += 1)`，第 9 个重复词后放弃匹配。
- 改法：`scripts/gate-check.ts:822` 改为 `for (let guard = 0; guard <= folded.length; guard += 1)`，循环内每次必须前进（无进展即 break），不会死循环。
- 用例：同 `tests/gate-check.spec.ts:323`。

## P1 合法历史叙述被误杀

- 载荷：`历史记录：上一轮审计未通过，本轮已整改。` / `round20 审计结论为 fail，本轮已整改。` / `The previous audit did not pass; this round is clean.` / 门正文 `上一轮审计未通过，本轮已整改。`
- 根因：可见正文只要出现否定就毒化 pass，没有区分「历史轮次已整改」与「本轮否定」。
- 改法：`scripts/gate-check.ts:852-860` 新增 `HISTORICAL_REMEDIATION_RES` 与 `stripHistoricalRemediation`：只剔除「上一轮 / 前一轮 / roundN … 本轮已整改 / 已修复 / 已收口」及「previous audit … this round is clean / fixed / remediated」这一小段；`visibleFailStatement`（:862）先 strip 再 fold。历史句之后另起本轮否定仍会被抓。
- 用例：`tests/gate-check.spec.ts:323` 断言 4 条历史/清零安全句为 pass，并断言历史句后追加「本报告不通过」不得 pass；门正文 `:320`。

## P2-1 候选 G1 未签态

- 当前 HEAD 上 G1 仍是预签态（audit_report_sha256=0×64，candidate/scope/artifact/body 均为旧值）。
- 处置：按流程在两份独立审计 pass 后统一重签，本次整改不提前签门。重签后本项自然消失。

## P2-2 未签态下 11 项 gate-check 测试噪声

- 现象：`docs/gates/G1.md` 预签时，11 个已签态负向用例会先在「审计报告 sha256 不符」处失败，掩盖真正的回归。
- 本轮处置：不结构性改动测试夹具，只在验收计数中把这 11 例单列为「预签态噪声」，并确认其余 66 例全过、无新增回归。建议下一轮单独做签名态 fixture（临时 git 仓库内签一份 G1），本轮不改，避免为 P2 引入新的测试基建风险。

## 验证

- `node node_modules/typescript/bin/tsc --noEmit` → exit 0。
- `tests/gate-check.spec.ts` → 77 例，66 passed / 11 failed；11 红全部为上述预签态，无新增解析器回归。
- 探针 `r21` 20 例：16 条 P0 全部 report=null / body=fail；4 条历史与安全句全部 pass。
- 全量测试与签门 e2e 在提交后重跑，结果补记于 handoff。

## 声明

- 本轮没有重签 G1，也没有修改任何门记录或证据文件；门的状态仍由下一轮独立审计判定。
