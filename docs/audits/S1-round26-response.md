# S1 第二十六轮审计对照表

审计报告：docs/audits/S1-independent-audit-round26.md（结论 fail，P0=8 / P1=2 / P2=2，候选 e717293）
本对照表对应整改候选。

## P0 八条：同一套穷举连接词被继续绕过

八条载荷：

1. 门正文 本门记录尚不具备准入条件。
2. 门正文 本门记录不能作为准入依据。
3. 报告 本次审计结论：通过，但准入条件尚未满足。
4. 报告 本次审计原则上认为本报告已通过，但尚不具备放行条件。
5. 报告 This audit, generally speaking, does not clear the gate.
6. 报告 本次审计总体而言不推荐通过本报告。
7. 报告 本次审计原则上认为本报告尚未完成整改。
8. 报告 本次审计总体而言不予推荐本报告。

共同机制是：扫描器先找主语、再逐词吃连接词，连接词表穷举不完；一旦句中多一个“认为/作为/但/总体而言/generally speaking”，或者否定谓词与对象不在表里，否定句就被当成普通叙述。

整改：

- 新增分句尾部否定（scripts/gate-check.ts:969）：把每行按标点拆成分句，只要某个分句以“否定词 + 可选填充词 + 通过类谓词 + 可选对象”收口，即判否决。不再依赖主语和语气副词是否在连接词表里。
- FAIL_FILLERS 补 作为/作為、完全/完全地/彻底/徹底/根本/真正。
- FAIL_PASS_STEMS 补 具备/具備。
- FAIL_OBJECTS 补 依据/依據、整改/整改工作/修复/修复工作、the gate/this gate。
- FAIL_CONNECTORS 补 generally speaking 等英文插入语，兜住带逗号的英文句。
- 八条载荷现在 auditConclusionOf 全为 null、bodyConclusionOf 全为 fail；同族安全正句（本门记录具备准入条件、本次审计通过且准入条件已满足、This audit, generally speaking, clears the gate）仍为 pass。

## P1：备份 busy 与事件链删除

- 备份在并发 WAL 快照下忽略 wal_checkpoint 的 busy 返回，会生成 malformed 副本并让 verify 报“备份缺清单或清单坏了”。这与“备份坏了要显式失败”一致，但没有把 busy 当作可重试状态处理。
- node_run_events 的哈希链尾删除或整链删除后 verifyChain 返回 null，且表上没有 append-only 触发器、没有外部链头。

两条都是失败关闭，本轮不改协议；已记入后续 S3 前置项：备份遇 busy 要重试或显式标记不可用，事件链需要外部锚点与 append-only 约束。审计 pass 前不扩大改动面。

## P2：预签态与错误信息

- G1.md 仍是 pre-sign，11 个 gate-check 用例红是既定状态；所有审计 pass 后重签即消。
- 统一错误信息排障性差：错误码已能定位到缺失/不符字段，但上下文（哪份证据、哪一行）还不够；后续在 gate-check 的错误里补文件名与行号。

## 验证

- tsc --noEmit → exit 0。
- 全量 vitest → 33 文件 / 374 例，362 passed / 12 failed；12 红 = 11 个 G1 预签态 + 1 个“body_hash 被改时拒绝”被更早的审计报告锚点校验挡在前面，均非解析器回归。
- 新增 S1 第二十六轮用例：八条载荷 audit null / body fail，三条安全正句 pass。
