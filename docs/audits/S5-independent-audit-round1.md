# S5 第 1 轮独立可靠性审计

门：G5
候选提交：e141ea2c5a5774210601c5ce63b0e639156ac181

结论：fail（未通过，58 项有逐项证据，15 项尚缺完整验证）。

## 范围与口径

审查基线为 `be2f2b4bb4dc190b0797972e65d136aff2ef967e`，冻结生产代码、测试、迁移与固定证据共涉及 126 个文件。差异可用 `git diff --name-status be2f2b4..e141ea2` 查阅。送审时 `origin/main` 仍为基线。独立审计员未参与本轮实现。本文由主代理转录复核结果，发布后的文档提交与被审代码候选分别记录在交接文件。

对照[上一轮局部审查](S5-rework-development-audit-2026-11-19.md)、[六项历史 P1 与三项 P2](S5-p1-fix-round-2026-11-19.md)及[副作用与恢复跟踪](S5-development-audit-2026-11-18.md)。上一轮返工审查无遗留 P0/P1，留有一项无可复用流程时自动生成的端到端回归缺口。

## 复核记录

| 路径 | 本轮核对与修复 |
| --- | --- |
| Workflow 与自然语言规划 | 空候选由宿主明确传入，候选和固定版本绑定，草稿在事务内按实际运行目录校验。无效定义不留已发布版本或成功回执。普通入口与受信的 task_local 入口分别验证，S5 拒绝发布、加载及启动保留给 S6 的发布流程。发布前覆盖三个记忆写工具白名单来源，草稿测试结果写明模拟范围。 |
| 记忆写入与恢复 | 宿主返回时在写事务内验证租约和 owner epoch。迟到成功、零写入、写端哈希冲突均有回归，独立对账保留原始写入事实。跨运行批次先验证归属。 |
| 跨节点核验 | 在授权范围内有候补时可以重新指派，旧 attempt 不能接收或完成新请求，历史交付可查。新接收者必须关联独立证据。 |
| 业务证据与节点读模型 | 宿主核验器对固定动作实例及其真实只读结果签发结论，普通工具完成或人工声明不足以自动结算。部署缺核验器时继续待核实。停止时间只取已观测事实，节点声明与验证结论分别展示。 |
| 审批与分页 | 高风险确认绑定操作、请求、主体、对象和版本。审批与专业核验路径对权限、证据和回执的要求分别验证。审批优先级取自开卡时服务端事实，索引与游标覆盖整个列表，同级等待时间长者在前。 |
| 面板与 SSE | 拒绝迟到快照、已关闭订阅及旧轮询回调。断号后按账本水位重取。过期或断线时禁写，从设置页也能恢复，不依赖切换路由。任务列表展示等待、风险和心跳。验链返回首个坏节点与链内序号。 |
| 门证据和历史文档 | 逐条对照 `GATE_SPECS.G5` 的编号、判定语以及文件映射。区分已实现、证明用例、证据归档和正式签署。旧工作包文档已指回完整矩阵。 |

独立审计在冻结前指出两项 P2，分别是设置页断号后无法重新开放写入，以及证据型裁决的合法 HTTP 路径被错误拒绝。冻结候选已在真实面板与 HTTP 路径复验。后一项同时验证缺证、证据属于其他节点和结论相反时，裁决、结算与回执保持原状。

## 核验与遗留

- 独立复跑 34 个文件，567 项通过，1 项跳过。首次沙箱禁止回环监听，复跑使用可监听本地端口的环境。浏览器实测 1600×1000 与 1366×900 两个视口各通过 10 项断言。
- 主代理另跑 `pnpm check` 和冻结提交的 Vitest JSON 报告。139 个文件、1525 项通过、0 项失败、2 项跳过。Q-27 独立性能复测 p95 为 72.729 ms。另一项跳过来自既有 G1 门测试的分支选择。类型检查、构建及 `git diff --check` 通过。
- 真实记忆插件 v0.4.29 / Go 的全写入、零写入、部分写入对账均复跑通过。独立 DSH 宿主探针验证模型路由、两子会话独立核验与六子会话定向返工。DSH 推理流量走本地 fixture。这些数据由主代理采集。
- 逐项清单、复现命令及 58 份固定证据见 [G5 复核矩阵](../reviews/S5-g5-item-map.md)。下列 15 个编号尚缺完整验收证据。统计将缺证计入未过门项，缺证本身不计为生产代码缺陷。
- 读模型、隔离及命令验证尚缺 Q-01、Q-03、Q-04、Q-22、Q-31、Q-36。记忆并发、输入、裁判、审批生命周期尚缺 Q-43c、Q-45、Q-47、Q-48、Q-49、Q-51。插件原子失败、冲突优先级及恢复界面端到端联验尚缺 Q-61、Q-62、Q-63。
- 默认 `pnpm gate` 检查 G1–G4，退出码 1。四门均报告 `32517a5` 之后的候选文件 `codebasemap.md` 已变。G5 门记录尚待签署。

## 历史事项与不变量

- 历史 P1-01 至 P1-06 均已修复并验证，覆盖已确认任务停用后的派发、记忆续租与失权、任务专属流程生成与准入、手动任务的根运行绑定、交付验收与执行终态分离，以及缺执行器时的触发处置。11 月 18 日登记的记忆不确定写入恢复与业务证据风险已在插件恢复和动作绑定的宿主证据路径上复验。
- 复核八类不变量涉及状态迁移及 CAS、动作与重武装代次、时钟恢复路径、候选与证据绑定、系统终态、坏链隔离、不可逆动作和外部写入边界。证据型裁决在写事务内完成核验，旧租约不会覆盖对账结论，错误证据不会关闭卡片。
- 三项故障注入均独立复验。G-06 工具执行一次、同调用重送结果，运行生成的 UUID 归一后证据一致。G-11 和 G-12 的 LF 原始文件分别与仓库文件一致。G-11 SHA-256 为 `63a596a20a31a5111241cd456ab5053e978b9dd4216683ebf927291121294e7c`。
- 独立复审的遗留计数为 **P0 0、P1 0、P2 0**。另有两处既有 P3 维护偏差。`run-close.ts`、节点查询与核心终态枚举保留内容一致的重复清单；`acquireLease` 在同一事务内用等价的 CAS 条件完成两次迁移。后续改动这些路径时应核对枚举与迁移表。当前阶段退出仍取决于上列 15 项验证及前置门的一致性处理。

<details>
<summary>独立复跑的 34 文件命令（需要本地回环端口）</summary>

```text
pnpm vitest run tests/contract/task-planning.spec.ts tests/contract/routes.spec.ts tests/contract/decision-memory-confirmation.spec.ts tests/contract/s5-control-routes.spec.ts tests/client/panel-stream-contract.spec.tsx tests/client/panel-stream-integration.spec.tsx tests/client/decision-panel.spec.tsx tests/client/model-routing-settings.spec.tsx tests/client/panel-visual.spec.tsx tests/integration/task-plan-dispatch-after-disable.spec.ts tests/integration/task-local-root.spec.ts tests/integration/task-run-binding.spec.ts tests/integration/run-acceptance.spec.ts tests/integration/task-trigger-execution-readiness.spec.ts tests/integration/memory-lease-renewal.spec.ts tests/integration/memory-approval.spec.ts tests/integration/memory-runtime.spec.ts tests/integration/memory-permission.spec.ts tests/integration/memory-g11.spec.ts tests/integration/effect-resolution.spec.ts tests/integration/collaboration.spec.ts tests/integration/decision-priority-pagination.spec.ts tests/integration/recovery-uncertain.spec.ts tests/integration/recovery-action-checkpoint.spec.ts tests/integration/clock-recovery.spec.ts tests/integration/chain-guard-entries.spec.ts tests/integration/chain-guard-execution.spec.ts tests/integration/migration-cases.spec.ts tests/integration/transition-rules.spec.ts tests/integration/compensation.spec.ts tests/integration/cancel.spec.ts tests/integration/g3-faults.spec.ts tests/gate/gate-g5.spec.ts tests/gate/gate-check.spec.ts --reporter=dot
```

</details>

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G5",
  "audit_round": 1,
  "candidate_commit": "e141ea2c5a5774210601c5ce63b0e639156ac181",
  "conclusion": "fail",
  "p0": 0,
  "p1": 0,
  "p2": 0,
  "must_pass_total": 73,
  "must_pass_passed": 58,
  "must_pass_ids": [
    "Q-01",
    "Q-02",
    "Q-03",
    "Q-04",
    "Q-05",
    "Q-06",
    "Q-07",
    "Q-08",
    "Q-09",
    "Q-10",
    "Q-11",
    "Q-12",
    "Q-13",
    "Q-14",
    "Q-15",
    "Q-16",
    "Q-17",
    "Q-18",
    "Q-19",
    "Q-20",
    "Q-21",
    "Q-22",
    "Q-23",
    "Q-24",
    "Q-25",
    "Q-26",
    "Q-27",
    "Q-28",
    "Q-29",
    "Q-30",
    "Q-31",
    "Q-32",
    "Q-33",
    "Q-34",
    "Q-35",
    "Q-36",
    "Q-43",
    "Q-43b",
    "Q-43c",
    "Q-44",
    "Q-44b",
    "Q-44c",
    "Q-45",
    "Q-46",
    "Q-47",
    "Q-47b",
    "Q-48",
    "Q-49",
    "Q-50",
    "Q-51",
    "Q-52",
    "Q-52b",
    "Q-53",
    "Q-54",
    "Q-55",
    "Q-56",
    "Q-57",
    "Q-58",
    "Q-59",
    "Q-60",
    "Q-61",
    "Q-62",
    "Q-63",
    "G5-VIEWPORT-NARROW",
    "G5-VIEWPORT-WIDE",
    "G5-FONT-BODY",
    "G5-FONT-MENU",
    "G5-CONTRAST-LIGHT",
    "G5-MEMORY-RECONCILE",
    "G5-PHASE-RELEASE",
    "G-06",
    "G-11",
    "G-12"
  ],
  "failed_items": [
    "Q-01",
    "Q-03",
    "Q-04",
    "Q-22",
    "Q-31",
    "Q-36",
    "Q-43c",
    "Q-45",
    "Q-47",
    "Q-48",
    "Q-49",
    "Q-51",
    "Q-61",
    "Q-62",
    "Q-63"
  ],
  "notes": "15 项尚缺完整定向验证或固定证据。G1–G4 候选绑定另需复核。"
}
```
<!-- audit-verdict:end -->
