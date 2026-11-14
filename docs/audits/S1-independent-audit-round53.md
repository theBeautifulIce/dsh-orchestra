# S1 独立审计报告 · 第 53 轮（G1）

门：G1
候选提交：0dbb95024ce2df4476e0cb230209b4cb6497e5f2
审计轮次：53
审计时间：2026-11-14 22:00–22:10（Asia/Shanghai）
审计方式：独立只读审计；未修改代码、未提交、未签门
候选范围：623939d..0dbb950 的代码、测试、脚本与证据；排除 `docs/gates/G1.md`、`docs/gates/G2.md`、`docs/audits`、`docs/reviews`、`handoff.md`；证据文件计入候选
环境：Windows / node v26.13.1 / pnpm 12.3.4

## 一、结论

结论：pass

13 项必过项逐项通过（13/13），P0=0、P1=0、P2=4，failed_items 为空。审计开始时 `git status --porcelain` 为空，HEAD 即候选 0dbb950；审计期间 `docs/audits` 下出现并行 S3 报告与本报告，该目录在候选排除范围，不影响 candidate_hash。G1.md 仍是第 51 轮重签时的锚点，`gate-check` 退出 1 属签署前状态（P2-3），不计入必过项判定。

## 二、实测命令

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc --noEmit` 无输出 |
| `pnpm test` | 0 | 61 个测试文件，843 passed / 1 skipped（844） |
| `pnpm build` | 0 | tsdown 0.22.14；ESM `lib/index.js` 245.34 kB（gzip 59.26 kB），`lib/index.d.ts` 18.04 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 25 份证据各重跑两遍，均与 HEAD 字节一致 |
| `pnpm vitest run tests/integration/g1.spec.ts tests/integration/migrate.spec.ts tests/integration/backup.spec.ts tests/contract/auth.spec.ts tests/unit/config.spec.ts tests/integration/db-open.spec.ts tests/integration/hash-chain.spec.ts tests/gate/gate-check.spec.ts tests/integration/lease.spec.ts` | 0 | 9 个文件，251 passed / 1 skipped；g1.spec 6/6，gate-check 184 passed / 1 skipped，lease 7/7 |
| `pnpm vitest run tests/integration/g1.spec.ts tests/gate/gate-check.spec.ts tests/unit/audit-verdict.spec.ts` | 0 | 3 个文件，209 passed / 1 skipped（210） |
| `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` | 1 | 第 51 轮审计报告锚点滞后（签署前预期，见 P2-3） |

gate-check 原文：

```text
门检查失败（docs/gates/G1.md）：审计报告 sha256 与记录不符（报告改过就重新审计再签）：355a1a582b5584c0… != e3eee74611c3a681…
```

## 三、必过项逐项结论

| 必过项 | 复核内容 | 结果 | 依据 |
| --- | --- | --- | --- |
| G1-01 | 空库迁移可重复，账本无重复记账 | pass | ev-migrate；migrate.spec 三个用例 |
| G1-02 | 迁移中途杀进程后可重入 | pass | ev-g14；G-14 表数 23→25、只补 [902] |
| G1-03 | 进程被杀不丢已提交事件 | pass | ev-g02；G-02 重放拿到 seq=2 |
| G1-04 | 备份独立目录行数与哈希一致 | pass | ev-backup；backup.spec |
| G1-05 | 损坏备份可检出 | pass | ev-g15；G-15 截断检出 |
| G1-06 | 认证前置，匿名写返回 401 | pass | ev-auth；auth.spec |
| G1-07 | 阶段开关未知值返回 SCHEMA_VERSION_UNSUPPORTED | pass | ev-phase；config.spec |
| G-01 | COMMIT 前杀进程不留半条记录 | pass | ev-g01；G-01 未提交事务计数 0 |
| G-02 | COMMIT 后未投递被杀可重放 | pass | ev-g02；G-02 总条数 2 |
| G-08 | 长事务读不阻塞、第二写者 busy、队列溢出 503 | pass | ev-g08；G-08 断言偏弱见 P2-1 |
| G-09 | 订阅者离线重放无断号 | pass | ev-g09；G-09 seq 2,3,4 |
| G-14 | 迁移一半杀后重跑只补一步 | pass | ev-g14；G-14 schema_migrations 1..23,901,902 |
| G-15 | 截断备份可检出、恢复请求被拦下、线上库不变 | pass | ev-g15；G-15 线上库 sha 与事件数不变 |

## 四、关键不变量复核

### 4.1 单写者与 epoch

`src/infra/sqlite/driver.ts` 的 `withTx` 先 `BEGIN IMMEDIATE`，再读 epoch 并与连接持有的 `db.epoch` 比对，不匹配抛 `STALE_GENERATION`；全仓只有该文件导入 `node:sqlite`。`tests/integration/db-open.spec.ts` 覆盖：WAL/foreign_keys/busy_timeout=5000/synchronous=2；只读连接写报 `FORBIDDEN`；bumpEpoch 后旧连接写报 `STALE_GENERATION` 而新连接可写；第二把库锁报 `ELOCKED` 且释放后可重获；事务回滚计数 0；CAS 行数不符回滚且旧值旧版本不变；两连接并发写只落 1 行。新增 `wakeOnEvent`/`cancelRun` 均经 `inTx`，服务端两处新路由都在 `authenticate` 之后并走 `queue.run`，没有绕开单写通道。

### 4.2 租约

`src/service/commands/lease.ts`：acquire 要求 queued，CAS 按 status+attempt+revision 置 leased 并递增 action_generation，再 CAS 置 dispatched，插入 leases 行并追加 `lease_acquired`；renew 按 revision+lease_id CAS，更新 leases 过期时间与 revision，不改 action_generation；release 清租约字段并把 leases 过期时间置为 now；`assertLeaseValid` 在边界时刻抛 `LEASE_EXPIRED`（proposed=true）；`sweepExpiredLeases` 把 dispatched 收成 stopping、started 收成 startup_unknown，清租约并追加 `lease_expired`，未过期节点不动。`tests/integration/lease.spec.ts` 7 个用例全部通过。

### 4.3 哈希链只追加

migration 007 的 `trg_node_run_events_no_update` / `trg_node_run_events_no_delete` 在触发器存在时拦截直接 UPDATE/DELETE；`tests/integration/hash-chain.spec.ts` 覆盖首条 prev_hash=ZERO_HASH、三条链 seq 1/2/3、篡改 seq2 报 hash 对不上、删除 seq2 后 seq3 报 prev_hash 接不上、换密钥报哈希不匹配、字段顺序无关、双链独立、uuidv7 版本位。

### 4.4 门检查能重算证据与固定清单

`scripts/gate-check.ts` 的 `checkEvidence` 从 HEAD 读证据、按 LF 归一化重算 sha256，并对照固定 `evidenceFiles` 清单逐项检查 id/路径与缺失；`checkInvariants`、`checkBodyTable`、`checkBodyEvidenceTable`、`checkBodyInvariants` 把清单内容、行序、结果列、证据列与不变量陈述都钉成常量；`checkEvidenceMap` 钉每项证据映射；`verifyGateRecord` 在末尾重算 candidate_hash 与 body_hash。独立重算：13 份证据中 12 份与 G1.md 记录一致，ev-g14 记录仍是旧值（P2-3）；evidence_index_hash 与 invariants_hash 可重算，invariants_hash 与记录一致。

### 4.5 审计裁决一致性同时扫散文与表格

`src/core/audit-verdict.ts` 的 `verdictProblems` 校验 gate/round/commit、结论、P0/P1 计数、must_pass_total 与 passed 相等、ids 无重复且覆盖固定必过项、failed_items 为空。`scripts/gate-check.ts` 的 `proseVerdictClashes` 同时扫散文结论行、点名必过项的散文句、表格结论列、显式结论标记格、跨格拆开的否决词与原始 Markdown 溢出列；历史表格行只在存在轮次列、轮次严格早于当前审计轮、且无「本轮/当前轮」标记时豁免。`tests/gate/gate-check.spec.ts` 184 passed / 1 skipped，覆盖 A4/A5/A6/A7/A8/A8b/A9 系列表格攻击与历史轮次豁免；`tests/unit/audit-verdict.spec.ts` 20 个用例覆盖重复、未知、缺失与多块裁决。

### 4.6 证据复现

`node --no-warnings scripts/check-evidence-repro.ts` 退出 0：25 份证据每份重跑两遍都与 HEAD 字节一致。G1 的 6 份注入证据（G-01、G-02、G-08、G-09、G-14、G-15）均在其中；G-14 的表数、迁移区间与幂等重跑数字也与 G1.md 正文一致。

## 五、证据哈希复核

按 HEAD 字节、LF 归一化重算，前 12 位如下：

| 证据 | HEAD 前 12 位 | G1.md 记录前 12 位 | 比对结果 |
| --- | --- | --- | --- |
| ev-auth | d8593aff1f15 | d8593aff1f15 | 一致 |
| ev-backup | 3c1b2f975dc4 | 3c1b2f975dc4 | 一致 |
| ev-chain | cf2d60dd505d | cf2d60dd505d | 一致 |
| ev-epoch | 19be1852c1fb | 19be1852c1fb | 一致 |
| ev-g01 | f2626b30f9eb | f2626b30f9eb | 一致 |
| ev-g02 | 5fedb2e7539b | 5fedb2e7539b | 一致 |
| ev-g08 | 2f2a73ddbf25 | 2f2a73ddbf25 | 一致 |
| ev-g09 | e944a2b6bd29 | e944a2b6bd29 | 一致 |
| ev-g14 | c1da546054be | ec2b935dddae | 滞后（P2-3） |
| ev-g15 | 1699f60368dd | 1699f60368dd | 一致 |
| ev-gatecheck | ed7e65aeeec5 | ed7e65aeeec5 | 一致 |
| ev-migrate | 376dc6d6e087 | 376dc6d6e087 | 一致 |
| ev-phase | 1702657cdb40 | 1702657cdb40 | 一致 |

## 六、候选范围与哈希

- `candidateEntries(GATE_SPECS.G1)` 得到 225 个路径；`candidate_hash` 重算为 `48ce126ffde3f03a5b539853cc4a17844c121d4d422decf149fb391dcf8de0ed`，`change_scope_hash` 重算为 `50df1f462a4c845f973d87a361ec830dace12698d8107970d6f9f76cc9fc43ba`。
- G1.md 第 4 行的排除声明与 `scripts/gate-check.ts:109` 的 `GATE_SPECS.G1.excludes` 完全一致：只排 `docs/gates/G1.md`、`docs/gates/G2.md`、`docs/audits`、`docs/reviews`、`handoff.md`；30 份证据文件在候选内。
- `artifact_hash` 重算为 `6b059c8ab09be42d881ff1380d42d094d72e1a5d63d75a7ca22c9bf2fa0962ea`，`body_hash` 重算为 `de722fe99c7d360882a173a725fb2107954850814ac9b92d130fcb9c09dd9acd`，`evidence_index_hash` 重算为 `e6d07c3b84b86590c847f2a0a416f78f97b6a5a5621e95e7bc97b40125c7da22`，`invariants_hash` 重算为 `6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6`。
- 候选包含 `docs/gates/G3.md` 与 G2/G3 的 24 份证据；G1 候选范围声明本身与实现一致，跨门耦合见 P2-4。

## 七、P0 / P1

P0=0，P1=0。本轮没有需要给出文件行号与复现命令的 P0/P1 项。

## 八、P2

| 编号 | 级别 | 位置 | 说明 | 复现 |
| --- | --- | --- | --- | --- |
| P2-1 | P2 | `scripts/fault-inject.ts:289` | G-08 的 busy 判据取 `busy.length > 0`；本意是 SQLITE_BUSY，实现上任意异常都会置真。建议断言错误码或消息含 busy/SQLITE_BUSY。 | `node --experimental-strip-types --no-warnings scripts/fault-inject.ts --case G-08 --out <临时目录>` |
| P2-2 | P2 | `tests/integration/evidence-repro.spec.ts:11-14`、`package.json` scripts | vitest 复现用例覆盖 G1/G-01 与 G2/ev-g2-11 两条，`check-evidence-repro.ts` 覆盖 25 条；`test`/`check` 链路只跑 typecheck、vitest、build，复现脚本由审计命令手动执行。用例注释写「全量 35 份」，脚本实际 25 份。建议全量接入 CI/nightly 并修正注释。 | 读 `package.json` 的 scripts；跑 `node --no-warnings scripts/check-evidence-repro.ts` |
| P2-3 | P2 | `docs/gates/G1.md` 证据表与 artifact 块 | 候选/证据/报告锚点仍是第 51 轮重签值，HEAD 已前移：candidate_hash 记录 85dccd92…、重算 48ce126f…；change_scope_hash 0079ed78… / 50df1f46…；evidence_index_hash 3ac6049c… / e6d07c3b…；artifact_hash 1c090377… / 6b059c8a…；body_hash e3b7a0dd… / de722fe9…；audit_report_sha256 355a1a58… / 实际 e3eee746…；ev-g14 ec2b935d… / c1da5460…。G1.md:49 仍写「本机 pnpm 不可用」，实测 pnpm 12.3.4 可直接跑。签署时由 `sign-gate.ts` 统一重算即可。 | `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` |
| P2-4 | P2 | G1 候选范围 | G1 候选包含 `docs/gates/G3.md` 与 30 份证据（G2 20、G3 4）；其他门记录/证据的改动会改变 G1 的 candidate_hash。建议签署窗口内冻结，或把其他门的记录与证据排除出 G1 候选。 | 打印 `candidateEntries(GATE_SPECS.G1)` 并过滤 `docs/gates` |

## 九、裁决

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 53,
  "candidate_commit": "0dbb95024ce2df4476e0cb230209b4cb6497e5f2",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 4,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": [
    "G1-01",
    "G1-02",
    "G1-03",
    "G1-04",
    "G1-05",
    "G1-06",
    "G1-07",
    "G-01",
    "G-02",
    "G-08",
    "G-09",
    "G-14",
    "G-15"
  ],
  "failed_items": [],
  "notes": "证据复现 25/25 与 HEAD 字节一致；候选 225 个路径，G1/G2 门记录自身排除、证据计入；typecheck/test/build 退出码均为 0；P2 为弱 busy 断言、复现覆盖不足、签署前锚点滞后与跨门证据耦合。"
}
```
<!-- audit-verdict:end -->
