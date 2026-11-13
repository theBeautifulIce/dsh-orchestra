# S1 第十九轮审计整改对照表

- 审计报告：`docs/audits/S1-independent-audit-round19.md`（审计对象 HEAD `1e83391`）
- 整改提交：`53495fc`「Bind terminal evidence, server clock, and visible fail windows」
- 本表用途：逐条对应 P0、改法、回归用例。**本表不作为放行依据**——G1 是否过关由下一轮独立审计决定。

## P0-1 三行拆词可见否定句

- 根因：`auditConclusionOf` 只把当前可见行与下一行拼接一次，三行以上的拆词（本报告不 / 通 / 过）不在任何一次拼接里。
- 改法：`scripts/gate-check.ts:677-687` 改为从当前行起做 2 到 4 行的滑动拼接，分别用无分隔与空格拼接后调用 `visibleFailStatement`；任一命中即记 `inlineFail`，与干净 pass 结论同时出现时返回 `null`。
- 用例：`tests/gate-check.spec.ts`「S1 第十九轮 P0-1/P0-2/P0-3」首条载荷 `本报告不\n通\n过`。

## P0-2 图片 alt 的实体与引号变体

- 根因：图片 token 的 `content` 是 Markdown 源文本，没有做 HTML 实体解码；`&#xFF08;`、`&nbsp;`、`&colon;` 与数字实体都能把否定句拆到关键词匹配之外。
- 改法：`scripts/gate-check.ts:609` 先调 `AUDIT_MARKDOWN.utils.unescapeAll(child.content)` 解码实体与反斜杠转义，再交给 `visibleFailStatement`；命中即把整份报告标为歧义。
- 用例：同一用例覆盖 `&#xFF08;`、`&nbsp;`、`&colon;`、`&#26412;…`、`&quot;`、ASCII/弯单引号七种 alt。

## P0-3 引号包裹的否定句

- 根因：`FAIL_VERDICT` 的尾部 lookahead 只接受中文右引号 `”` 等少数收尾符，ASCII 双/单引号、弯单引号、全角引号、法文引号都让否定句判不成句。
- 改法：`scripts/gate-check.ts:634` 的四处尾部字符类统一加入 `" ' ‘ ’ ＂ « » ‹ ›`；否定句外层套哪种引号都不改变语义。
- 用例：同一用例覆盖 `"本报告不通过"`、`'本报告不通过'`、`‘本报告不通过’`、`＂本报告不通过＂`、`«本报告不通过»`、`"结论：fail"`。

## P0-4 门记录正文的可见否定句

- 根因：`bodyConclusionOf` 逐行调用 `visibleFailStatement`，没有多行拼接；图片 alt 的实体解码也只修了审计报告一侧。
- 改法：`scripts/gate-check.ts:721-735` 对门记录正文同样做 1 到 4 行滑动窗口判定，窗口参数沿用 `maxStart=24 / maxLength=160`；图片 alt 经 `renderedAuditLines` 解码后已进入同一判定，歧义时整段返回 `null`，`verifyGateRecord` 报「门记录正文结论行缺失或不唯一」。
- 用例：`tests/gate-check.spec.ts`「门记录正文的三行拆词、引号包裹与图片 alt 否定句也要拒绝」三条载荷，均先插入正文再走 `verifyGateRecord`。

## 验收

- `tsc --noEmit` → `TSC_EXIT=0`。
- `tests/gate-check.spec.ts` → 71 例，60 passed / 11 failed；11 红全部是 G1 预签态（`audit_report_sha256=0*64` 对实际 `50ba1b13…`），无解析器回归。
- 全量 `vitest` → 32 文件 / 340 例，329 passed / 11 failed，仍全部是上述预签态。
- 新增两条回归用例只读运行均通过（`-t "第十九轮"` → 3 passed / 68 skipped，含门正文用例）。

## 未做与边界

- G1/G2 未重签；当前门记录仍是预签态，不能拿本表当放行依据。
- 本轮只修 S1 第十九轮列出的 P0；S2 第二十三轮的 P0/P1 整改见 `docs/audits/S2-round23-response.md`。
