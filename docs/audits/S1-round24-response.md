# S1 第二十四轮审计对照表

审计报告：docs/audits/S1-independent-audit-round24.md（结论 fail，P0=2 / P1=1 / P2=1，候选 b92e849）
本对照表对应整改候选。

## P0-1：放行/clear/fit/release 同义否定仍可签成 pass

八条报告载荷整改前 sign-gate 与 gate-check 都是 exit 0：本报告不能放行。／本次审计未达到放行条件。／This audit does not clear the gate.／The gate is not fit to advance.／本报告\n不能\n放行。／上一轮审计未通过，本轮已整改。本报告不能放行。／本次审计未获放行。／The gate cannot be released.

根因：FAIL_PASS_STEMS 没有 放行/release/clear/fit/advance；结构否定只认否定词加词表谓词；「未达到放行条件」的「条件」也不在宾语表。

整改：FAIL_PASS_STEMS 补 放行/release/released/releases/clear/clears/cleared/fit/advance；FAIL_OBJECTS 补 条件/條件。拆行写法由统一折行扫描覆盖；历史整改句后面的当前否定不再被历史豁免吞掉。

## P0-2：门正文注入同一族否定

载荷：本门记录不能放行。／The gate is not fit to advance.

整改：FAIL_SUBJECTS 补 本门记录/本門記錄/门记录/門記錄/本门/本門/the gate/this gate/gate record，门正文逐行扫描能命中。

## P1-1：围栏代码块里的结论行

renderedAuditLines 的既定契约是跳过围栏代码块、HTML 注释与缩进代码，这些内容在渲染后不可见。围栏里的「结论：fail」不进入裁决解析，属于设计内不可见载体，不作为缺陷整改；可见正文里的结论与否定仍全部参与扫描。

## P2-1：G1 预签态

预期状态。本轮整改提交后重签时消除。

## 验证

- 九条载荷进入 tests/gate-check.spec.ts 新用例，断言 auditConclusionOf 为 null、bodyConclusionOf 为 fail。
- 合法句「本轮已整改，未发现新的阻断项。」在报告与门正文里仍为 pass。
- tsc --noEmit exit 0；tests/gate-check.spec.ts 83 例 72 passed / 11 failed，11 红全部是 G1 预签态。
- G1.md 与 G2.md 的 bodyConclusionOf 均为 pass。

审计 pass 前不签门、不开 S3。
