# S2 第三十轮审计对照表

审计报告：docs/audits/S2-independent-audit-round30.md（结论 fail，P0=8 / P1=0 / P2=1）
审计对象：候选 998c89b；本对照表对应整改候选。

## P0 八条

八条在整改前都能让 sign-gate 与 gate-check 双双 exit 0。根因集中在两处：结论扫描的连接词/填充词表太窄，以及否定谓词与宾语表缺少同义族。

| # | 载荷 | 根因 | 整改 |
| --- | --- | --- | --- |
| P0-1 | 本次审计原则上不推荐通过本报告。 | FAIL_CONNECTORS 不认“原则上”，主语后遍历即停 | 补 原则上/原则上/总体上/基本上/大体上/整体上/总的来说/一般而言/on the whole/in general/overall/generally/basically |
| P0-2 | This audit, on the whole, does not endorse the report. | 英文插入语在 on 处中断 | 同上；补英文连接词 and/then |
| P0-3 | 本次审计不予采信并退回本报告。 | 采信/退回不在否定谓词族，结构否定只吃一个谓词 | FAIL_VERDICTS 补 不予采信并退回 及繁體；补 并/並/且/又/同时 作为句内连接 |
| P0-4 | 本次审计结论为：不予准入。 | 准入不在肯定谓词表，否定尾字不接受“准” | FAIL_PASS_STEMS 补 准入/準入；FAIL_VERDICTS 补 不予准入/不准入/未准入 及繁體 |
| P0-5 | 整改工作尚未完成。 | 行首既非裁决词也非旧主语，完成度否定没有入口 | FAIL_SUBJECTS 补 整改工作/整改/修复工作/修复 及繁體 |
| P0-6 | This audit does not consider the report ready. | 否定与谓词之间插入 consider，遍历深度只有 2 | FAIL_FILLERS 补 consider/deem/regard/think/find/report 各形态；填充循环上限由 2 提到 6 |
| P0-7 | 本门记录不具备准入条件。 | 结构否定只吃一个宾语，尾部“条件”不在允许集合 | FAIL_OBJECTS 补 准入条件/准入條件；准入加入肯定谓词表；填充循环加深 |
| P0-8 | 本门记录未达到准入条件。 | 同上 | 同上 |

八条载荷已写入 tests/gate-check.spec.ts 的「S2 第三十轮 P0/P2」用例，断言 auditConclusionOf 为 null、bodyConclusionOf 为 fail。

## P2：引用定义里的隐藏否定

载荷：

```
[1]: "本次审计结论：fail"

结论：pass
```

渲染器会丢弃引用定义，旧实现只读渲染后的可见行，所以定义里的否决完全消失。整改在 auditConclusionOf 与 bodyConclusionOf 的入口增加 hiddenDefinitionFailure(text)：扫描原始文本的引用定义起始行与缩进续行，命中否定句即按歧义拒绝（audit 返回 null，body 返回 fail）。定义里写 pass、普通 URL、URL 路径含 fail 均不误伤。

回归同在这条用例里，包含：

- [1]: "本次审计结论：fail" / [1]: "结论：不通过" / [1]: "审计未通过"
- 正控：[1]: https://example.com 与 [1]: "本次审计结论：pass" 仍判 pass

## 验证

- node node_modules/typescript/bin/tsc --noEmit → exit 0。
- tests/gate-check.spec.ts → 84 例，73 passed / 11 failed；11 红全部是 G1 预签态（audit_report_sha256 为 64 个 0），不是解析器回归。
- 全量 vitest → 32 文件 / 370 例，359 passed / 11 failed；红点同上。
- 新增用例单独运行 1 passed / 83 skipped。
- 八条 P0 与三条隐藏定义在临时探针上均为 audit=null、body=fail；四条同族安全正句均为 body=null，未误伤。

## 提交与复审

本对照表、第三十轮报告、scripts/gate-check.ts 与 tests/gate-check.spec.ts 一起提交；提交后重派 S2 第三十一轮，并在新候选上重派 S1 审计。审计 pass 前不签门、不开 S3。
