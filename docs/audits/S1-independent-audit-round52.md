# S1 独立审计 · G1 · 第 52 轮

- 门：G1
- 候选提交：4e431c64ee4f382238901a2a04956ae8a8d70e0d
- 候选标题：docs(gates): refresh G2 sweep evidence shape
- 审计轮次：52
- 审计时间：2026-11-14
- 审计方式：只读审计候选 commit 的 HEAD 内容；只写本报告，不签门、不改 G1.md、不提交
- 候选范围：`623939d4c0a7123835b525287035588ee291ccbe..4e431c6`。按 `scripts/gate-check.ts` 的 G1 规则重算为 225 个文件，其中 `docs/gates/` 31 个（G1 证据 6、G2 证据 20、G3 证据 4、G3.md 1）；G1.md/G2.md 不在候选，docs/audits、docs/reviews、handoff.md 不在候选。G1.md 第 4 行的声明与 `GATE_SPECS.G1.excludes` 一致：只排除 G1.md/G2.md 门记录自身，证据文件计入候选。
- 环境：node v26.13.1；pnpm `C:\Users\ASUS\AppData\Roaming\npm\pnpm.cmd`。G1.md 第 49 行仍写「本机 pnpm 不可用」，本轮实测 pnpm 可用；`pnpm exec vitest` 因 bin 未链接报 `Command "vitest" not found`，单文件用 `node node_modules/vitest/vitest.mjs` 直跑。

## 一、命令与退出码

| 命令 | 退出码 | 实际结果 |
| --- | --- | --- |
| `git rev-parse HEAD`、`git status --porcelain` | 0 | HEAD = 4e431c6；审计开始时工作树干净 |
| `git diff --stat 10fb8fa..HEAD` | 0 | 2 个文件、2 行增、2 行删，只涉及 G2/G-05.md 与 G2/ev-g2-14.md |
| `pnpm typecheck` | 0 | `tsc --noEmit` 无输出 |
| `pnpm test` | 0 | 61 个测试文件通过；838 passed \| 1 skipped（839）；10.41s |
| `pnpm build` | 0 | tsdown v0.22.14；CJS `lib/client.js` 0.29 kB；ESM `lib/index.js` 235.96 kB / gzip 57.01 kB；`lib/index.d.ts` 17.57 kB / gzip 4.30 kB；约 925 ms |
| `node node_modules/vitest/vitest.mjs run tests/integration/g1.spec.ts` | 0 | 6 个测试、6 passed，2.79s |
| `pnpm exec vitest run tests/integration/g1.spec.ts` | 1 | `Command "vitest" not found`；pnpm exec 未链接 bin，改用上一行的 node 直跑 |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | `证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致` |
| `node --no-warnings scripts/fault-inject.ts --case G-14 --out <tmp>` | 0 | beforeTables 23；`重跑只补了 [902]；schema_migrations=[1..23,901,902]；表数 23→25，第一步没重复执行` |
| `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` | 1 | 签署前状态：`审计报告 sha256 与记录不符…355a1a58… != e3eee746…`；属第 51 轮记录未重签，见 P2-3 |
| 候选重算（import `candidateEntries(GATE_SPECS.G1)`） | 0 | 225 个文件；candidate_hash `058b3640…`；change_scope_hash `50df1f46…` |
| 迁移链独立探针（临时脚本，不写入仓库） | 0 | 23 个迁移文件，区间 [1,23]，applied [1..23]，schema_migrations [1..23]，业务表 22 |

## 二、结论

**pass。P0 = 0，P1 = 0，P2 = 4，failed_items 为空。**

证据复现 25/25 与 HEAD 字节一致（G1 6/6）；G-14 的表数、迁移区间、幂等重跑三组数字与证据一致；候选范围声明与 `gate-check.ts` 实现一致，G1.md/G2.md 排除、证据计入、G3.md 与 G2/G3 证据按声明进入候选；13 项必过项逐项通过；typecheck、test、build 均为退出码 0。剩余四项 P2 是守卫强度、覆盖范围、签署前哈希与跨门证据耦合，不构成本轮 P1。

## 三、13 项逐项结论

| 必过项 | 证据/测试 | 独立核验 | 结论 |
| --- | --- | --- | --- |
| G1-01 | ev-migrate；`tests/integration/migrate.spec.ts:38`、`:50` | 空库跑一次核心表齐、迁移记账与目录一致；再跑返回空数组、记账不重复 | pass |
| G1-02 | ev-g14；`tests/integration/migrate.spec.ts:68` | 重跑生成与 HEAD 字节一致；beforeTables 23，schema_migrations [1..23,901,902]，表数 23→25，只补 [902] | pass |
| G1-03 | ev-g02；G-02 | 首轮 1 条 `task.created evt_1`；提交后 2 条；fromSeq=1 重放拿到 1 条 `2 evt_committed`，总数 2 | pass |
| G1-04 | ev-backup；`tests/integration/backup.spec.ts:47` | 备份目录含库与清单；每张表行数、哈希与线上一致 | pass |
| G1-05 | ev-g15；`tests/integration/backup.spec.ts:69` | 截断备份被识别为损坏；恢复被拒；线上库哈希与事件数不变 | pass |
| G1-06 | ev-auth；`tests/contract/auth.spec.ts:97` | 匿名 POST `/v1/ledger/events` 返回 401 | pass |
| G1-07 | ev-phase；`tests/unit/config.spec.ts:41` | 未知 phase S7 返回 `SCHEMA_VERSION_UNSUPPORTED` | pass |
| G-01 | ev-g01；`tests/integration/g1.spec.ts` | 单事件可见；未提交事务不留半条记录：true | pass |
| G-02 | ev-g02；同上 | 重放不重复、不丢事件；总数 2 | pass |
| G-08 | ev-g08；同上 | 第二个写者报 busy：true；队列溢出码 `SERVICE_UNAVAILABLE`；HTTP 503；弱断言见 P2-1 | pass |
| G-09 | ev-g09；同上 | 重放拿到 seq=2,3,4；连续无断号：true | pass |
| G-14 | ev-g14；同上 | beforeTables 23；23→25；只补 [902]；第一步未重复执行 | pass |
| G-15 | ev-g15；同上 | 损坏检出；恢复被拒：true；线上库未变：true；线上事件数 1 | pass |

## 四、13 份证据重算

按 LF 归一化后对 HEAD 字节重算 sha256，13 份均与当前文件一致；其中 12 份与 G1.md 表内记录一致，ev-g14 的记录值仍是旧哈希（P2-3，签署时会重算）。

| 证据 | 文件 | 重算 sha256（前 12 位） | 与文件一致 | 与 G1.md 记录一致 |
| --- | --- | --- | --- | --- |
| ev-auth | docs/gates/evidence/G1/ev-auth.md | d8593aff1f15 | 是 | 是 |
| ev-backup | docs/gates/evidence/G1/ev-backup.md | 3c1b2f975dc4 | 是 | 是 |
| ev-chain | docs/gates/evidence/G1/ev-chain.md | cf2d60dd505d | 是 | 是 |
| ev-epoch | docs/gates/evidence/G1/ev-epoch.md | 19be1852c1fb | 是 | 是 |
| ev-g01 | docs/gates/evidence/G1/ev-g01.md | f2626b30f9eb | 是 | 是 |
| ev-g02 | docs/gates/evidence/G1/ev-g02.md | 5fedb2e7539b | 是 | 是 |
| ev-g08 | docs/gates/evidence/G1/ev-g08.md | 2f2a73ddbf25 | 是 | 是 |
| ev-g09 | docs/gates/evidence/G1/ev-g09.md | e944a2b6bd29 | 是 | 是 |
| ev-g14 | docs/gates/evidence/G1/ev-g14.md | c1da546054be | 是 | 否（记录 ec2b935d…） |
| ev-g15 | docs/gates/evidence/G1/ev-g15.md | 1699f60368dd | 是 | 是 |
| ev-gatecheck | docs/gates/evidence/G1/ev-gatecheck.md | ed7e65aeeec5 | 是 | 是 |
| ev-migrate | docs/gates/evidence/G1/ev-migrate.md | 376dc6d6e087 | 是 | 是 |
| ev-phase | docs/gates/evidence/G1/ev-phase.md | 1702657cdb40 | 是 | 是 |

## 五、G1.md 自锚与候选复核

| 检查项 | 记录值 | 重算/实况 | 判定 |
| --- | --- | --- | --- |
| G1.md 正文 | 与 10fb8fa 相同 | `git diff 10fb8fa..HEAD -- docs/gates/G1.md` 为空 | 一致 |
| 候选范围声明 | 第 4 行：排除 G1.md/G2.md 门记录、docs/audits、docs/reviews、handoff.md；证据计入 | `GATE_SPECS.G1.excludes` 正是这五项 | 一致 |
| 候选文件数 | 未记录 | 225；docs/gates 31（6 G1 证据、20 G2 证据、4 G3 证据、G3.md） | 声明可解释 |
| 门记录自身 | 应排除 | G1.md/G2.md 不在候选；G3.md 在候选 | 一致 |
| 证据文件 | 应计入 | 30 份证据全部在候选，含 G1 6、G2 20、G3 4 | 一致 |
| candidate_hash | 85dccd92… | 058b3640f23b274b96e263498f1c59d850c2d4f68994058165a5bca03c198f60 | 签署前待更新（P2-3） |
| change_scope_hash | 0079ed78… | 50df1f462a4c845f973d87a361ec830dace12698d8107970d6f9f76cc9fc43ba | 签署前待更新（P2-3） |
| evidence_index_hash | 3ac6049c… | e6d07c3b84b86590c847f2a0a416f78f97b6a5a5621e95e7bc97b40125c7da22 | 签署前待更新（P2-3） |
| invariants_hash | 6f75465b… | 6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6 | 一致 |
| artifact_hash | 1c090377… | 6b059c8ab09be42d881ff1380d42d094d72e1a5d63d75a7ca22c9bf2fa0962ea | 签署前待更新（P2-3） |
| body_hash | e3b7a0dd… | de722fe99c7d360882a173a725fb2107954850814ac9b92d130fcb9c09dd9acd | 签署前待更新（P2-3） |
| audit_report_sha256 | 355a1a58… | 第 51 轮报告实际 LF 哈希 e3eee746… | 未对齐（P2-3） |
| 候选可达性 | 候选须为 HEAD 祖先 | 4e431c6 即 HEAD；`git diff --name-only 4e431c6..HEAD` 为空 | 一致 |
| 证据索引 | 13 个 G1 id | 13 个 G1 证据文件逐一对应 | 一致 |

## 六、迁移链

- 迁移目录 `migrations/` 共 23 个文件，编号 001..023 连续；空库应用后 applied [1..23]，schema_migrations [1..23]。
- 业务表 22 张；ev-g14 的 23 是 `sqlite_master` 口径含 `sqlite_sequence`，再加 `half_a`、`half_b` 两张半成品表，得 23→25。
- 901/902 是测试用的记账标记，不是迁移文件；重跑只补 902，说明已提交步骤没有重复执行。
- 独立探针结果与 ev-g14、`migrate.spec.ts:38/:50/:68` 三处数字一致。

## 七、守卫攻击矩阵

| 攻击 | 观察 | 结论 |
| --- | --- | --- |
| G-01 未提交事务崩溃 | 事件数 1；未提交事务不留半条记录 true | 守住 |
| G-02 重复投递/重放 | fromSeq=1 拿到 1 条；总数 2；无重复 | 守住 |
| G-08 并发写与队列溢出 | busy true；溢出码 SERVICE_UNAVAILABLE；HTTP 503 | 守住（断言偏弱，P2-1） |
| G-09 事件断号 | 重放 seq=2,3,4；连续无断号 true | 守住 |
| G-14 迁移中途失败重入 | 23→25；只补 902；第一步未重复 | 守住 |
| G-15 备份被改/截断 | 损坏检出；恢复被拒；线上库未变 | 守住 |

## 八、证据复现与测试边界

- `check-evidence-repro.ts` 25 份全部字节一致：G1 6 份、G2 19 份。10fb8fa 时 G2/G-05 与 G2/ev-g2-14 曾因 sweep 新增字段漂移；4e431c6 正好只刷新这两份，现已闭合。
- `pnpm test` 61 个文件、838 passed、1 skipped；`g1.spec.ts` 6/6。`tests/gate/gate-check.spec.ts` 184 项通过、1 跳过，含「证据文件进入候选范围，门记录自身不进入」。
- 证据复现守卫只抽 2/25（G1/G-01、G2/ev-g2-11），且未接入 `pnpm test`/`pnpm check`（P2-2）。
- `pnpm exec vitest` 因 pnpm 未链接 bin 报错，node 直跑通过；`pnpm build` 的 tsdown 输出正常。
- 审计期间仓库同时有 S2/S3 审计写入，工作树出现未跟踪报告与 `src/index.ts`、`src/service/schemas.ts`、`src/service/server.ts` 等修改；本报告结论按候选 commit 4e431c6 的 HEAD 内容判定，`git diff 4e431c6..HEAD` 为空。签署前需等这些并行写入收口、工作树回到干净状态。

## 九、P0/P1/P2

**P0：0 项。**

**P1：0 项。** 第 51 轮的两项 P1 已按第 51 轮报告给出的第二种处置收敛：G1.md 第 4 行声明改成与 `gate-check.ts` 一致，4e431c6 把两份 G2 证据刷新收进候选；当前证据复现 25/25，候选锚点无候选之后的改动。

**P2-1：G-08 的 busy 断言过弱。** `scripts/fault-inject.ts:289` 用 `busy.length > 0` 判断，任何错误都会被当成 busy。建议断言错误码/错误类型，而不只是「有异常」。

**P2-2：证据复现覆盖不足且未进测试闸。** `tests/integration/evidence-repro.spec.ts:11-14` 只守 G1/G-01 与 G2/ev-g2-11 两条；`package.json` 的 `test`/`check` 未调用 `check-evidence-repro.ts`。另外脚本失败时的分母写成 `checked + problems`，25 份里 2 份不一致会打印 2/27（`scripts/check-evidence-repro.ts` 末尾）。建议把 25 份全量接进 CI 或 nightly，并修正分母。

**P2-3：签署前哈希与锚点未更新。** G1.md 记录 candidate_hash 85dccd92…、change_scope_hash 0079ed78…、evidence_index_hash 3ac6049c…、ev-g14 ec2b935d…、artifact_hash 1c090377…、body_hash e3b7a0dd…、audit_report_sha256 355a1a58…；重算分别为 058b3640…、50df1f46…、e6d07c3b…、c1da5460…、6b059c8a…、de722fe9…，audit_report_sha256 应指向本轮报告。`gate-check.ts docs/gates/G1.md` 当前退出 1 就是这处未对齐；提交本轮报告与记录后由 `sign-gate.ts` 统一重算即可。G1.md 第 49 行「本机 pnpm 不可用」也已过期。

**P2-4：跨门证据耦合仍在。** G1 候选包含 `docs/gates/G3.md` 与 30 份证据（G2 20、G3 4）；以后任何 G2/G3 证据改动都会改变 G1 的 candidate_hash 并使锚点失效，10fb8fa→4e431c6 就是一次实例。当前 HEAD 即候选，不阻断本轮；建议把其他门的记录/证据排除出 G1 候选，或在签署窗口内冻结。

## 十、裁决

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 52,
  "candidate_commit": "4e431c64ee4f382238901a2a04956ae8a8d70e0d",
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
  "notes": "证据复现 25/25 与 HEAD 字节一致；候选 225 个文件，G1/G2 门记录自身排除、证据计入；typecheck/test/build 全绿；P2 为弱断言、覆盖不足、签署前哈希未更新与跨门证据耦合。"
}
```
<!-- audit-verdict:end -->
