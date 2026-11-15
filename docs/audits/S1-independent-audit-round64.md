# S1 独立审计报告 · G1 第 64 轮

门：G1
候选提交：4ade819b49db726d0a99f5087ffdae04bd95888e
审计日期：2026-11-15
审计方式：独立审计；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 64,
  "candidate_commit": "4ade819b49db726d0a99f5087ffdae04bd95888e",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 2,
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
  "notes": "本批把取消/围栏/等待的时钟判定改为只认单调锚点（缺钟或无锚点一律不自动推进），并静音候选枚举的 git 噪声。G1 地基 13 项全过，注入证据逐字节复现。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 2；必过项 13/13。

## 2. 实测

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 64 files；911 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 289.25 kB，gzip 69.85 kB |
| `check-evidence-repro` | 0 | 28 份，两遍一致 |

## 3. 13 项必过项

| 必过项 | 要求 | 结果 |
| --- | --- | --- |
| G1-01 / G1-02 | 迁移空库可重复、中途杀可重入 | pass |
| G1-03 / G-01 / G-02 | 事件不丢、COMMIT 前后被杀可恢复 | pass |
| G1-04 / G1-05 / G-15 | 备份行数哈希、损坏检出、恢复拒绝 | pass |
| G1-06 / G1-07 | 认证拒匿名写、阶段开关拒未知值 | pass |
| G-08 / G-09 / G-14 | 长事务与队列 503、离线重放、迁移重入 | pass |

## 4. 不阻断问题（P2）

| 编号 | 位置 | 说明 |
| --- | --- | --- |
| P2-1 | `src/service/clock-recovery.ts` | 剩余预算用墙钟估算，事件里留 `remaining_ms` 供复核 |
| P2-2 | `src/service/commands/subworkflow.ts:388` | 父 run 缺定义哈希时起子流程被拒，属既有 fail-closed 边界 |

## 5. 结论

G1 地基未受影响，13 项全过。
