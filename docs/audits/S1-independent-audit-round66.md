# S1 独立审计报告 · G1 第 66 轮

门：G1
候选提交：5098847a60bc4f487fe1a12bcb839e98c647781d
审计日期：2026-11-15
审计方式：独立审计；未签门、未改生产代码

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 66,
  "candidate_commit": "5098847a60bc4f487fe1a12bcb839e98c647781d",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 1,
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
  "notes": "本批根治 startup_unknown_remaining_ns 单位分裂（lease 写 ms / node-state 写 ns），统一为纳秒；另夹紧 recovery 预算、补断链守卫。G1 地基 13 项全过。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：pass

P0 = 0，P1 = 0，P2 = 1；必过项 13/13。

## 2. 实测

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 64 files；915 passed / 1 skipped |
| `pnpm build` | 0 | `lib/index.js` 291.85 kB，gzip 70.39 kB |
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
| P2-1 | `docs/gates/G1.md` | 门记录仍绑 d248f3b，属批次预期 |

## 5. 结论

G1 地基未受影响，13 项全过。
