# S2 第五轮独立审计报告（门 G2）

第五轮独立审计（G2，实际 HEAD 644af53；任务书 e3f1fc7，src/tests 未变）结论：fail。致命 1 / 重大 3 / 不阻断 4。现在不具备开 S3 的条件。

P0（致命）：G2 以结论 fail 的第四轮报告为 audit_report 仍签 pass。G2.md:5 结论 pass，:266-267 audit_round=4 / audit_report=docs/audits/S2-independent-audit-round4.md；该报告第 3 行结论 fail，并要求再提第五轮复审。scripts/gate-check.ts:422-431 只核对文件名轮次、不读报告结论，所以 gate-check G2 仍 exit 0，形成自证循环。G2 正文 :13-17 只写到第三轮，没有第四轮整改说明。复现：node scripts/gate-check.ts docs/gates/G2.md -> exit 0；再读 round4 报告 -> fail。

P1（重大）：
1) M5 残余：applyReport 已去掉 policy 参数（apply-report.ts:104-109），但 WorkflowCatalog.load 同版本直接覆盖（workflows.ts:19-34），applyReport 在报告到来时才 policyFor（:91-109），POST /v1/workflows/load（server.ts:154-159）可在 run 在飞时改写 pass_conditions。实测：版本 1 条件 exitCode eq 99 -> 建 run -> 启动 700ms 工具 -> 200ms 后同版本 reload 为 eq 0 -> run 返回 200 done；反向 eq0->eq99 返回 422 blocked。违反规格 :293 不可变模板。
2) M2 残余：runNode 的 assertToolsAuthorized 真的生效（deny 优先、未注册拒、allow 空集拒；tools=[] 会 evidence_missing blocked；args 可覆盖注册表），但策略与 tools 都来自同一 HTTP body（index.ts:85-86、dispatcher.ts:50-51、server.ts:171-185/213-229）；workflow-def.ts:11 的 node.tools 全仓无读取，是死字段。即这是调用方自洽闸，不是模板授权边界；仓内也没有 deny/空 allow/未注册的 production-path 用例。越权面限于只读工具；若项目把 HTTP secret 当唯一信任边界，可降为 P2，但需在门记录显式登记偏差。
3) M3 残余：openServiceOrchestra 机制实测成立（第二写者 ELOCKED；外部 bumpEpoch 后旧连接 withTx 抛 STALE_GENERATION；新进程 epoch+1）。但 createOrchestra 仍公开且直接 openDb、不拿锁/不 bump（index.ts:43-45）；两个 createOrchestra 实例实测 epochs=0,0，两个都写成功。serveOrchestra 仓内零调用，全部门证据/tests/fault-inject 走 createOrchestra（tests/production-path.spec.ts:6,28；fault-inject.ts:21,417,547），所以门证据没有覆盖单写者路径。

M1：两门 exit0、docs/reviews 已排除、audit_round=4，机械漂移闭合；语义被 P0 破坏。M4：renew 路由与 10s 心跳生效（3s 动作/2s 租约/500ms 续租不误判，done；不续租则 startup_unknown；续租失败被吞后停在 verifying，最终 verify_timeout），但长动作回归用例缺失，action_timeout_ms 无读点，失败收口理由误标（P2）。N1 闭合（ev-g2-08 两次 54e4b0e8... 字节一致）；N2 闭合（gate-check.spec.ts:165-186）；N3 未修已承认；N4 闭合（30s，31 文件/272 例全过）；N5 闭合（G2.md:80 用 node 直跑）；e5 的 S3 计划落点存在（plans/2026-11-12-dsh-orchestra-s3-nodes-state.md:387），S2 未实现属约定。

验收（HEAD 644af53，干净树）：tsc exit 0；vitest 31 文件/272 例全过 12.32s；G1 exit 0（artifact 1ce80f6080fb... / body 446357f9e00e...）；G2 exit 0（artifact b5615b8b5725... / body ef21bb456813...）。门检查能过，但它是 P0 的自证循环。

15 项核对：15 项 = G2-01..07、G-03/04/05/07、G2-08..11；15 份证据哈希由 gate-check 全部重算通过；抽读 ev-g2-01/05/08/10/11，内容有实质 HTTP/账本输出，未见单份证据靠文案过关。问题在门级：15 项全是旧基线，没有一项覆盖 M2-M5；重签只改审计锚/候选字段，等于用旧证据给新整改背书。

其他 P2：gate-check 证据 file 路径可换绑（checkEvidence:208-233；checkEvidenceMap:394-402）；前序链只比字符串（405-419）；body_hash 对反引号 64hex 占位（371-378）；ev-g2-10 因 normalizeEvidence 每段各建映射导致 nrun_1/nrun_2 对调（fault-inject.ts:41-66,68-76）；server 所有 now 取 body，sweep 用墙钟（server.ts:161-237；index.ts:140-146）。

判定：G2 fail。先修 P0/P1，补 M4 长动作用例、M2/M3 生产路径用例与门检查空洞；再由独立审计出结论 pass 的报告并重签 G2（不得再以 fail 报告签 pass），才可开 S3。
