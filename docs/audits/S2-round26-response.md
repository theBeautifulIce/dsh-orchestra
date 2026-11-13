# S2 第二十六轮审计整改对照

- 审计报告：docs/audits/S2-independent-audit-round26.md（结论 fail，P0=2 / P1=1 / P2=3）
- 审计候选：ca2b196e351552b8a055450fb81ed6653aff2197
- 整改状态：P0-1、P0-2、P1-1、P2-1、P2-2 已改并补回归；P2-3 属于重签前状态，按流程留到双门重签时收口
- 本表不构成放行依据：G1/G2 仍未重签，S1 第二十二轮未回，S3 未开

## P0-1 审计报告放过裸裁决词与繁體裁决词

改法：
- scripts/gate-check.ts:637-681 主语表补 `結論`，连接词表补 `結論` 与繁體 `為`；裁决词表补裸 `否决/驳回/拒绝/反对/未采纳/拒收/不接收` 及繁體 `否決/駁回/拒絕/反對/未採納`，并补 `反对通过/反對通過`。
- scripts/gate-check.ts:869-905 的行首结论正则接受 `結論`，链接定义检测与拆行歧义判定同步接受繁體；scripts/gate-check.ts:810-812 的全文扫描排除裸主语时同时排除 `結論`。
- 结果：`結論：fail` 直接读成 fail；其餘 9 条「结论：pass + 追加裁决句」不再读到 pass。

回归：tests/gate-check.spec.ts:346-365「S2 第二十六轮 P0-1/P0-2」逐条使用审计报告给出的 10 条载荷，全部 `not.toBe('pass')`。

## P0-2 门记录正文同样放过裸裁决词

改法：
- scripts/gate-check.ts:913-925 的 `bodyConclusionOf` 接受 `結論`，全文扫描排除裸主语时同步排除 `結論`，并在以 `结论/結論/判定` 开头的行上补一次完整否定扫描。
- 门正文写入「本次审计结论为否决。」或「本次審計結論為否決。」时返回 fail，不再与 artifact.conclusion=pass 并存。

回归：同一用例的门正文断言，含 `本次审计结论为否决。`、`本報告結論為駁回。` 与安全句 `本次审计否决项为 0。`。

## P1-1 ev-g2-14 并发重跑不同字节

根因：scripts/fault-inject.ts:69-74 只归一 ISO 时间戳与 id，没有归一续租造成的 node_runs.revision 抖动。

改法：scripts/fault-inject.ts:70-73 在 id 归一前把 JSON 里的 `"revision":<数字>` 统一写成 `"revision":<n>`。revision 是调度噪声，不是行为事实。

验证：
- 顺序重跑两次：12e34ba8fd59c17322b364a122a5f265af87d353e10a13b6b4328049ceb6b39f。
- 四路并发重跑四次：四份均为 12e34ba8fd59c17322b364a122a5f265af87d353e10a13b6b4328049ceb6b39f。
- docs/gates/G2.md:83 与 :386 的旧值 4e0776e9… 已同步为 12e34ba8…；docs/gates/evidence/G2/ev-g2-14.md 已重生成。

## P2-1 requiredHashes 接受 output 同键为 null

改法：src/core/policy.ts:57-61 在键存在之后继续要求产物不是 null/undefined；空产物不能拿 `sha256(canonicalJson(null))` 当凭据。

回归：tests/apply-report.spec.ts:429-442「required_hashes 的产物为 null 时不能拿 sha256(null) 通过」，断言 verification_too_weak。

## P2-2 两个 required key 产物值相同可共用哈希

改法：src/core/policy.ts:64-72 对每个 required key 的产物摘要做唯一性校验；两个键指向同一份内容时返回 verification_too_weak。审计报告同时指出这条需要明确口径：本仓按“每个 required key 必须对应一份独立产物”收口。

回归：tests/apply-report.spec.ts:444-457 独立产物阳性对照；原有“两个 key 共用同一哈希”用例仍拒绝。

## P2-3 候选上的门记录审计锚与全量基线

不在本批改代码：这是重签前状态。G1 仍声明 audit_round=1 与旧报告，G2 仍声明 round4 与全 0 哈希，因此 G2 gate-check 与全量 11 例预签态失败是预期现象。按既定流程，S1 r22 与 S2 r27 都 pass 后再重签 G1/G2，并让双门 exit 0、全量全绿。

## 本轮验证

- `D:\NodeJs\node.exe node_modules/typescript/bin/tsc --noEmit`：exit 0。
- 定向 `tests/policy.spec.ts tests/apply-report.spec.ts tests/gate-check.spec.ts`：135 例，124 passed / 11 failed；11 红全部是 tests/gate-check.spec.ts 的 G1 预签态（audit_report_sha256=0*64），无新增解析器或证据门回归。
- 全量 `vitest run`：32 文件 / 362 例，351 passed / 11 failed；11 红同一预签态。
- `scripts/fault-inject.ts --case ev-g2-14`：顺序两次、并发四路，五份哈希全为 12e34ba8…。
- 新增解析器回归 1 例（10 条载荷）与证据门回归 2 例（null 产物、独立产物阳性对照）。

## 未收口

- S1 第二十二轮报告未回；回来后逐条整改并一并提交。
- 提交后重派 S1 r23 / S2 r27；两份 pass 后重签 G1/G2。
- G1/G2 当前不是可放行状态，S3 九节点与状态机继续冻结。
