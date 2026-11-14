# dsh-orchestra 接手指引（handoff）

> 面向「任何人（包括三个月后的自己）拿到这个目录就能继续干活」写的。
> 最后更新：2026-11-14 09:30。本文件在项目根目录，遵 dshQQ 硬约束第 5 条。
> 配套：`codebasemap.md`（代码与图谱在哪）、`docs/requirements.md`（主人要什么）、`docs/design-notes.md`（为什么这么设计）。

---

## 0. 一句话

**dsh-orchestra** 是要给 DSH（DeepSeek Harness）做的一个**编排插件**：把「跑一个 agent 任务」这件事变成有状态、可恢复、可审计的节点图，
每个节点的状态、证据、代次都落在 SQLite 账本里，崩溃/断线/宿主退出后能扫回来继续跑。

现在做到哪：**第三段 v23 已在第二十五轮拿到 pass；第四段 v33 已按第三十四轮 pass 收口；第五段 v37 已按第三十八轮 pass 收口，v38 清了两条非阻断措辞；第六段 v44 已在第 45 轮拿到 pass（0 致命 / 0 重大 / 7 条不阻断的措辞），2439 行、505410 bytes；面板原型已迭代到 v20（数字与列表同源；任务卡、抽屉、支线卡的状态用同一句话；健康支线默认收起，只展开有事的；卡面只留「做到 / 结果 / 需要你」，解释收进问号提示；任务页可按状态与时间段查，归档箱只是收起、不改历史；v20 起流程库收成一行可搜下拉，流程再多也不会把顶部挤乱），558042 bytes、7498 行、SHA256 `AEB59E16F9D10F1595311036AB3FAD6564C481E4EF8A1CD608B5B17B3F692873`，提交 `1091673`，等主人评审；实施规格已升 **v1.3**（`docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md`，1493 行 / 106173 bytes / SHA256 `D78E4E2B7F3C569D20F8FEC27564B031240B4E1B947F34E47EF493CE9976F82E`，提交 `26fc1af`），等主人审阅；「工作流内部共享面（黑板）」方案主人判定本任务暂不需要，已作想法留档于 `docs/superpowers/specs/2026-11-12-run-shared-context-addendum.md`（提交 `aea1b24`），未并入规格；规格此前按设计稿 v44 校准升 **v1.1**（1306 行 / 92209 bytes / SHA256 `9B47AB32B7EA122E05148D12088CDD02083170BF6AEA6B069AC7186D6EFCC4A3`，提交 `4e646eb`）：校验分层改成两层、§17.1 错误码由 64 补到 85；实施计划已按 `writing-plans` 写成**总纲 + S1–S6 七份**，落在 `docs/superpowers/plans/`，S1–S6 六份批次计划已全部落盘（提交 `b8352db`），等主人过目后转实施；插件源码还没写。**

---

## 1. 三十秒现状

| 项 | 状态 |
| --- | --- |
| 规则设计稿 `docs/orchestra-design-draft.md` | 2439 行 / 505410 bytes / SHA256 `D534FA8317A74C48286C83A65C994FC80D812B6B26110BCC533A7BA82699B793`；第五段 v38 已过第 38 轮；第六段 v44 已过第 45 轮（0 致命 / 0 重大 / 7 措辞，措辞已落 spec 清） |
| 实施规格 `docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md` | **v1.3**：1493 行 / 106173 bytes / SHA256 `D78E4E2B7F3C569D20F8FEC27564B031240B4E1B947F34E47EF493CE9976F82E`；commit `26fc1af`；v1.2 裁定九处不一致（校验分层两层、§17.1 错误码 85 个、§9.10/§9.11/§11.3/§17.2），v1.3 追加第 18 章（任意会话都是主脑、对话不被任务占用、自治档位、三种批准人；§1–§17 行号零位移）；待主人审阅 |
| 审计台账 `docs/orchestra-audit-ledger.md` | 逐轮记录；第三段第 25 轮 pass；第四段第 31 轮 pass、第 32/33 轮 fail、第 34 轮 pass；第五段第 35/36/37 轮 fail、第 38 轮 pass，v38 清两条措辞已记；第六段第 39 轮 fail（1 致命 / 15 重大 / 5 措辞），21 条已修；第 40 轮 fail（0 致命 / 9 重大 / 4 措辞），v40 已修；第 41 轮 fail（0 致命 / 5 重大 / 5 措辞），v41 已修；第 42 轮 fail（1 致命 / 7 重大 / 4 措辞），v42 已修；第 43 轮 fail（0 致命 / 2 重大 / 8 措辞），v43 已修；第 44 轮 fail（0 致命 / 1 重大 / 8 措辞），v44 已修；第 45 轮 pass（0 致命 / 0 重大 / 7 措辞，已在 spec 清） |
| 实施计划 `docs/superpowers/plans/` | 总纲一份 + S1–S6 六份批次计划（每份含 §0 口径、逐 Task 的 Files/步骤/测试/验收/提交、风险与回退、完成定义、门记录），全部落盘于提交 `b8352db`：S1 账本地基（11 Task，门 G1，1532 行）、S2 单节点闭环（14 Task，门 G2，2852 行）、S3 九节点与状态机（15 Task，门 G3，含起运行命令与自治档位）、S4 流程定义与版本（12 Task，门 G4，736 行）、S5 面板与记忆（17 Task，门 G5，含自治档位与审计留痕显示）、S6 硬化与发布（17 Task，门 G6 + R0/R1/R2 三圈，1223 行）；规格行号引用已按 v1.2 行号全量重校准 468 处（越节引用 0；v1.3 只追加第 18 章、无需再校），迁移编号定案 001/002/010–012/020/030 |
| 原始需求 `docs/requirements.md` | 已写（R1–R23 主人原话 + 拍板口径 + 验收标准） |
| 设计思路 `docs/design-notes.md` | 已写（16 条决策 + 五个坑族 + 风险清单） |
| 代码图谱索引 `codebasemap.md`（根） | 已写（三份参考图谱 + 本项目文档图谱） |
| 参考项目 `references/` | 三份已克隆并建图谱 |
| **源码** | S1 账本地基 + S2 单节点闭环已完成（`4f3ada7` → `ca8cea3`，37 文件 +3145/−16）：`src/core/`（errors/config/canonical/ids/hash-chain/state-machine/report/policy/clock/workflow-def）、`src/infra/`（sqlite、db、lock、logger、backup、service-state、迁移 001/002）、`src/service/`（server、envelope、write-queue、queries、commands/{lease,node-state,apply-report,cancel}、sweep）、`src/executor/`（bridge、tools、session）、`scripts/`（fault-inject、gate-check、sign-gate）、`tests/`（31 spec、272 用例）；G1、G2 门记录均已通过机器复核；第四轮整改 M1–M5 与 N1/N2/N4/N5 已提交 `a7b03cb`，G1/G2 已重签（`8881b9b` / `e3f1fc7`）双门 exit 0，等第五轮独立审计（§11.13） |
| 面板原型 `docs/prototype/panel-v2.html` | v20 单文件浅色原型（核心指挥台：主脑卡 + 支线卡；有事的支线展开、健康支线默认收起；数字等于列表长度；任务卡、抽屉、支线卡状态句同源；任务流内含「执行注意事项」页）；任务看板、任务流程三栏、流程页画布与真实发布门禁、全局搜索、决定弹窗与签字接手；无彩色左侧色条、无可见优先级标签，全部可见字号 ≥12.5px（导航 13px），四档宽度无页面溢出；任务页可按状态与时间段筛选，归档箱只收起不改历史、可随时取回；流程库是一行可搜下拉（按名称 / 说明 / 负责人 / 触发方式 / 版本 / 发布状态查），不再横排铺标签 |
| 图谱 | `pi-harnessmm` 124/294、`dsh-superagent-prototype` 2012/8492、`DS-Bot` 10539/33229、`dsh-orchestra-docs` 97/96 |

---

## 2. 目录地图

```
D:\aboutAI\dsh-orchestra\
├─ handoff.md            ← 你正在读的这份（接手入口）
├─ codebasemap.md        ← 代码/图谱在哪、怎么更新、要看哪块用哪个工具
├─ docs\
│  ├─ orchestra-design-draft.md   ← 规则条文唯一权威（2439 行，v44，第 45 轮 pass）
│  ├─ superpowers\specs\2026-11-11-workflow-orchestration-design.md  ← v44 实施规格（1283 行，自审通过，待主人审阅）
│  ├─ superpowers\plans\        ← 实施总纲 + S1–S6 六份批次计划（写实施就按这份走）
│  ├─ orchestra-audit-ledger.md   ← 逐轮审计台账（见 §五）
│  ├─ prototype\panel-v2.html     ← 面板 v20 单文件原型（主脑卡 + 支线卡，健康支线默认收起，流程库可搜下拉，人话文案）
│  ├─ requirements.md             ← 原始需求与拍板口径
│  └─ design-notes.md             ← 设计思路与决策理由
├─ references\           ← 只读参考，不是本项目代码
│  ├─ DS-Bot\                  (sha 8e0013e0, 35.6MB, github.com/Fei2411/DS-Bot)
│  ├─ dsh-superagent-prototype\(sha 8c32a9d, 3.3MB, github.com/deepseek-ai/dsh-superagent-prototype)
│  └─ pi-harnessmm\             (sha 8d0a9da, 0.3MB, github.com/jlon/pi-harnessmm)
├─ notes\                ← 空，留给后续过程笔记
└─ scripts\              ← 空，留给后续脚本
```

**注意**：`references/` 里的三个项目是**读架构**用的参考，**不是本项目的代码**，不要往里改、也不要照抄。

---

## 3. 接手后怎么读（30 分钟路线）

1. **先读 `docs/requirements.md` §一**（主人原话 R1–R23）→ 你才知道要造什么。
2. **再读 `docs/design-notes.md` §2**（16 条决策，每条含被否方案和代价）→ 你才知道哪些地方别乱改。
3. **然后读 `docs/orchestra-design-draft.md` §8 迁移表（L209–L303）** → 这是整个设计的骨架。
   跳过 L5–L208 是**危险**的：那些是「事实层」规则（node_run 字段全集、代次、证据、生命周期、存储），迁移表每一行都引用它们。
4. **再读 `docs/orchestra-audit-ledger.md` §五** → 告诉你上一轮卡在哪、下一轮要改什么。
5. 想知道代码里怎么找东西 → 读根目录 `codebasemap.md`。

---

## 4. 现在该动手的活（唯一主线）

### 4.1 当前状态：六段全过；spec v1.3 与七份实施计划已落盘，待主人审阅（2026-11-13 09:30）

第三段 v23 已在第二十五轮拿到 **pass**（0 致命 / 0 重大 / 3 条非阻断措辞），三条遗留措辞已在 v24 清理，不再单开第三段轮次。

第四段 v24–v32 已送第二十六至第三十四轮。第三十一轮判 **pass：0 致命 / 0 重大 / 3 条非阻断措辞**，三条已在 v30 清；第三十二轮判 **fail：1 致命 / 6 重大 / 1 措辞**（发布回执晚于业务事务、CAS 与版本触发器顺序、触发器只升、重复边/自环码、空草稿名、已消费草稿优先级、子流程环与 depth、publish_note 范围），八条已逐条修入 v31；第三十三轮判 **fail：1 致命 / 4 重大 / 2 措辞**（发布 CAS 漏 workflow_id、历史指针仍指旧清单、WORKFLOW_NOT_FOUND 未进命令路径、based_on_version 未写入、title/name 未进保存层、保存层摘要与触发器映射措辞），七条已逐条修入 v32，送第三十四轮。

v30 新增「流程定义编辑」写模型：§4.6.5 四个命令、§4.12 定义校验与发布门禁、§14.3 三张表（`workflows` / `workflow_versions` / `workflow_drafts`）、Q-37…Q-42；v31 把发布写成单事务并统一写序，补触发器只升、重复边/自环码、空草稿名、已消费草稿优先级、子流程环与 depth 口径。v32 把三处发布写序收拢到 §4.6.5 一份权威模板（workflow_id + COALESCE、先查 workflow 404、based_on_version、草稿消费 revision + published_version IS NULL、事件与回执同事务），把 title/name 的 1–80 字校验与两个 422 错误码放进保存层，并把所有历史指针统一指向当前 §3.4u。

v33 在第 34 轮 pass 后只清四条收口项：`workflow.open_draft` 的三种草稿分支单独写（已有草稿 → DRAFT_EXISTS；已消费 → 重置 based_on_version、清 published_version、revision+1；从未发布 → NOT_PUBLISHED）；名称校验拆成 create 校验 `payload.name` 与 `definition.name` 一致、update 只校验 `definition.name`；Q-39 补 create 的 `payload.name` 81 字用例；L946 的「逐字一致」改为「语义一致」。终稿 1528 行、387116 bytes、SHA256 `78F9ED9209330B3671219951416DD7778D872295292C92ACA3039504D6266E26`，§3.4u 仍是唯一 `[CURRENT]` 清单，Q 共 42 条。

第五段 v37 把记忆写入拆成两条通道：直接通道保留插件 audit.js 的 fail-open；受控通道由核心大脑发起独立 memory run `sys.memory_write@1`，新增 `memory.evaluate` / `memory.apply_governed` / `memory.inspect_batch` 三个内部端口，固定图 `mem_trigger → mem_prepare → mem_check → mem_route → ready/mem_confirm(audit_result) → mem_apply → mem_report`；新增 memory_batches / memory_items / memory_evaluations / memory_run_requests 四表、Q-43…Q-63；写入只收 decision_id，三道核对、原子、幂等，source 带 orchestra 元数据。v37 已按第 37 轮 fail 的 3 致命 / 4 重大 / 3 措辞修入：哈希原像白名单与 canonical 排序、tool.result 丢失时批次保持 applying 与同批次节点重试、audit_result 复用为 mem_apply 前置批准、toolRef 前缀统一、Q-44c 错误层、批准后 client_key 只读、inspect_batch 计数与三处措辞；v37 终稿 2082 行、447818 bytes、SHA256 `B7D7475B735773A085955CCACD19DB6E5EAFC8A100E89A86DD3031409DCE6C94`；第 38 轮判 pass（0 致命 / 0 重大 / 2 条非阻断措辞），两条已在 v38 清理（inspect_batch 返回体显式带 batch_id、apply 重算引用 canonical_proposal），v38 2081 行、448133 bytes、SHA256 `7872A5442ECE77950CAFDD7A5CF175331E0B10177D4463CAA9D33264578A78B5`；第五段闸门已开，进入第六段。

第六段 v39 已按第 39 轮 fail 的 1 致命 / 15 重大 / 5 措辞逐条修入：线上账本只追加、备份只恢复到独立目录、按事件日志重放（RPO=0）；阶段开关绑能力表；S6 完成口径改为 G6 + R1 + R2，G6 定为发布候选门；G6 双 artifact 交叉核对；G2 用 paused_bridge_missing 派生 blocked；G-04/G-06/G-12 按阶段能力归位；补对比度/p95/隔离区/账本时间/队列/P1 判据；辅门签字规则；I4 终态证据表；I10 收窄；终态集合改指第二段 §8；branch 读 policy；GateArtifact 与门记录八段对齐；双向兼容窗口；F8 十种 resolution；G-14–G-16 三类注入并给 G-01–G-16 逐条回滚动作。终稿 2377 行、482650 bytes、SHA256 `DBB091C39415275C7C2C58E5DACB538CC6872C073AE70B54AE900F3A7ED947EC`；第 40 轮送审中（子代理 `5e2ff1da-4102-4a28-94c2-c35440178bad`，messageId `0b1f4355-500e-4abb-85a4-693ca8898b1c`）。

第六段 v40 已按第 40 轮 fail 的 0 致命 / 9 重大 / 4 措辞修入：门 run 终态沿用第二段 §8 五值、policy 输出 `decision=pass|fail`、I4 证据表覆盖 node_run 与 run、辅门失败只追加补记不改主门结论、GateArtifact 去自指并补四个 canonical 哈希与八段映射、EventView 改 `occurred_at` 并按 boot_id+monotonic_ns+seq 处理时钟跳变、G-01/G-14 改条件回退、补门×注入矩阵与 G2 parallel 拒绝；S6 顺序统一为 R0→G6→R1→R2 且 R0 不计入。终稿 2409 行、487617 bytes、SHA256 `0C5FB3490E9C3FE0061AA1A883ACFFFC3194CC296CC4DF3BA1445003D43D7606`；第 41 轮送审中。

第六段 v41 已按第 41 轮 fail 的 0 致命 / 5 重大 / 5 措辞修入：run 终态由 run 外收口器在门 run 结束后直抄 `runs.status`，run 内节点一律不读本 run 终态，部署脚本同时校验 `conclusion=pass` / `run_terminal=succeeded` / `gate_run_id` 指向的 run 仍为 succeeded；policy 只判 policy 之前节点全部终态且无未验证副作用；I4 的 run succeeded 行只留 done 强证据与 superseded 无副作用证据，abandoned_unverified 归 succeeded_with_unverified；GateArtifact 字段与八段一一对应，`must_pass_items[]` 逐项，`artifact_hash=` 锚点固定在补记之前；G1 无 run，固定 `gate_run_id=null` / `run_terminal=not_applicable` / `producer=human`，仅 G1 允许；canonical_json 集合数组升序去重；截止字段成对带 boot_id/monotonic_ns，跨 boot 用 boots 投影扣 downtime，跳钟/漂移转 timer_uncertain；G-06/G-11 改先保持 applying、对账确认部分写入后才转 indeterminate；W1–W4 与 G1/G-15、G-01/G-14 阶段口径同步。终稿 2437 行、496819 bytes、SHA256 `EE9BBD028B67CF59036F0B3B51D99357DDA11F3C03D688C812C1198B59861EDD`；第 42 轮送审中。

第六段 v42 已按第 42 轮 N1–N12 修入：G1–G5 与 G6 独立 artifact 明确无 run，只有 G6 的 `wf_release_v1` artifact 有 run；run_terminal 唯一来源改为 `runs.status`；I4 放开已核实无副作用的 `abandoned_unverified`；report CAS 改读单调钟；EventView 补 `boot_id` / `monotonic_ns`，`boots` 改投影并写 `clock_uncertain` 生产者；桥断暂停冻结 `startup_unknown_remaining_ns` / `verify_remaining_ns`，恢复按剩余重挂；`node_run` schema_version 升 2（只加两列可空列）；GateArtifact 定义 `exceptions[]` / `rollback{}` 对象；policy 输出固定 payload 并写 `policy.evaluated`；G6 告警与放行拆句；跨 boot 公式统一；G1 的 `gate_run_id` 固定 null。终稿 2437 行、502632 bytes、SHA256 `0E17A01F6BFC1818EE5C4C3B62CED165F3452E17C124CA986FDF14D185B53C65`；已提交 `0f950e6`，第 43 轮已送 subagent `c479b7de-a658-4b81-b0fb-44fb1020e676`。

第六段 v43 已按第 43 轮 0 致命 / 2 重大 / 8 措辞修入：EventView 与 SSE 事件补 `boot_id` / `monotonic_ns`，明确 `events.seq` 与 `node_run_events.event_seq` 不互换；`candidate_hash` 原像统一为 git sha、schema 版本、阶段开关，构建时间只进正文；6.10 第 1 段补 `gate` / `gate_run_id`，第 7 段补回滚对象，`exceptions[]` 增 `rollback_target`，`producer` 按门绑定；654 行改 `event_seq`，新增 §14.0 定义 `node_run_events` 列与 `payload_json` 唯一载体；6.4 标题改「十条不变量」；`clock_uncertain.clear` 命名；`abandoned_unverified` 进 `succeeded` 必须带 `side_effect_verified_none=true`。终稿 2439 行、504087 bytes、SHA256 `AE5B50F92A514FB4A49EAC519B37F97C35B418E5068A3F96A27230F16C8D2E24`；已提交 `6777ea4`，第 44 轮已送 subagent `1f208fe6-fd33-4824-b1c1-015a4e4bf101`。

第六段 v44 已按第 44 轮 0 致命 / 1 重大 / 8 措辞修入：`candidate_hash` 原像改为 `git_sha` + GateArtifact `schema_version` 整数 + 单值 `phase`（S1–S6），删除 `phase_flags`；518 行改 `report_seq`；G2 必过项与矩阵补 G-05；无 run 的 artifact（G1–G5 与 G6 独立 artifact）`gate_run_id` 一律 null，无 run 门结论补固定值；`payload_json` 限定为 `node_run_events` 内结构化事件的唯一持久载体，`occurred_at` 与 `events.occurred_at` 同源同刻、只用于链内排序、不用于截止判断；`change_scope` 原像补 `capability_ids[]` / `touched_paths[]`；2402/2403 分离回滚目标 `rollback_target` 与回滚 target。终稿 2439 行、505410 bytes、SHA256 `D534FA8317A74C48286C83A65C994FC80D812B6B26110BCC533A7BA82699B793`；结构校验 10 围栏、90 标题、Q 69、G 16、48 表 0 列不一致；第 45 轮 pass（0 致命 / 0 重大 / 7 措辞）；7 条措辞只在 spec 修正，设计稿保持 v44 冻结。

实施规格已按 v44 落盘并提交，现为 **v1.3**：`docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md`，1493 行 / 106173 bytes / SHA256 `D78E4E2B7F3C569D20F8FEC27564B031240B4E1B947F34E47EF493CE9976F82E`，commit `26fc1af`。第 45 轮 7 条措辞已在规格第 15 章逐条清；自审覆盖结构、表列、非终态 13 值、GateArtifact 示例与四个哈希原像。2026-11-13 按主人 m09136 口径升 v1.3：只在文末追加第 18 章（任意会话都是主脑、对话不被任务占用、自治档位三档与 escalations 名单、三种批准人、执行纪律六条、与 superagent 七项概念映射、照面板七原则的逐条差异），§1–§17 行号零位移（## 8. 行 607、## 10. 行 855、### 10.1 行 857、### 10.5 行 909、## 17. 行 1282、### 17.3 行 1389），六份计划 468 处规格引用继续有效。

2026-11-12 17:22 主人点名裁定子代理核出的九处规格 / 总纲 / 设计稿不一致，已逐条裁定并落成 v1.2（详见台账尾部「九处不一致逐条裁定」）：新增 §9.10 批次与条目状态枚举、§9.11 记忆三端口字段契约（逐字取设计稿 §5.4 / §5.6 / §5.8）、§11.3 门 artifact 的三类 producer 绑定、§17.2 写队列上限与保留期口径；六份批次计划的 468 处规格行号引用同步重校准，逐条核对引用内容与小节归属均通过。现在等主人审阅，通过后转 `executing-plans` 从 S1 起步。

- 画布与智能体同写一份 `WorkflowDefinition`；草稿可改、发布版本不可变；版本号连续，发布只影响之后新建的 run。
- 图校验分两层：保存层允许不完整草稿，只拒无法解析、超限、重复 id、边端点不存在、坐标非法；发布层要求恰好一个 trigger、全图可达且无环、出度纪律、branch route、subworkflow pin 与深度。
- 读模型补 `WorkflowView.current` 空态、§4.8 索引与 §14.3 对齐；Q-38 / Q-39 补并发发布与扇出用例。

面板原型 `docs/prototype/panel-v2.html` 从 v13 起：浅色、低密度、任务流程三栏（任务 / 步骤 / 现场）、流程页画布与真实发布门禁、全局搜索、决定弹窗与签字接手；无彩色左侧色条、无可见优先级标签。v11 把菜单、表头、卡片元信息、流程节点、抽屉与弹窗的可见字号统一抬到 12.5px 以上，导航 13px；v12 把任务卡下一步写具体（运行中「修订执行」交回后进「交叉审计」；另有 1 件等你决定；暂停的「补证脚本」没通过，等你决定是否接手），设计任务的 run 摘要与步骤状态对齐；v13 把优先级改成「最急 / 尽快 / 常规 / 有空再做」，任务卡去掉重复的下一步与「需要你」里的件数，编排页标题按任务类型切「七七怎么带这一队 / 这次运行怎么走」，状态词统一为「已完成 / 在做 / 等前一步」，并去掉可见的工作流版本号。文件 448946 bytes、5968 行、SHA256 `9D59CE6590CE0CB13E8856FF09249512929796F535F1737941FE23E76D8E63D9`，提交 `63adb98`；内联脚本 `new Function` 解析通过。v13 在 1600/1366/1200/1024 四档实测（over=0、screenOver=0、smallTotal=0、errs=[]）；七任务×四页、七弹窗与代理抽屉的 small/bad/jargon 全空，仅画布与 1024 宽的 `.tw-rail` 保留设计内横向滚动。主人会自己打开看，不再截图。v16（提交 `f3b7e94`）把神经屏从粒子画像改成核心指挥台：顶部主脑卡（身份、状态、使命、产出、等你决定几件事），下方支线卡只写「现在在做什么 / 出了什么结果 / 还需要做什么 / 进度」；全站 286 处带彩色边框的声明统一收为中性 `#e6e7ea`，焦点环改中性深色；文件 527190 bytes、7143 行、SHA256 `E79506B88ED7372D08401F29BD47A873AA12E1A74B1A5371E4DC61917BFA10E5`，提交 `f3b7e94`。v17（提交 `65b69c5`）按主人意见把「共享任务板」从神经总览撤下来，改成「执行注意事项」放进任务流：任务流程页与任务抽屉按任务列出定时任务注意事项、节点踩坑与被打回记录（谁记的、什么时候记的、发生了什么）；统计格数字降到 15–22px/600、说明文字提到 13.5px，注意力不再被数字吃掉；文件 530476 bytes、7198 行、SHA256 `3ea86fe2f746c3996d57d66b033444425202d8c96822a11257f66bf643e3f2fa`，提交 `65b69c5`。v18（提交 `a540e1e`）按 superagent 面板七原则补四项：所有数字改成与点进去的列表同源（待决定 3 / 待核实 2 / 今天记录 12 与各自列表逐条相等）；任务卡「做到」、抽屉「做到」、支线卡状态改用同一个 `runStatus()` 句子；支线默认只展开 running / blocked，其余折成「其余 4 条正常 · 已完成 1 · 等上游 2 · 还没开始 1」；卡面只留「做到 / 结果 / 需要你（进展）」三段，解释收进问号气泡，并去掉「裁决」「优先级」「指纹」等术语；文件 535019 bytes、7257 行、SHA256 `34CCA631F44EAA4A22C3748447D94C794D867532C5D7DD97DBD24002F69B08FB`。v19（提交 `8aa9cef`）按主人对任务查询与归档的意见补两处：任务页加查询条，状态可选「正在做 / 卡住了 / 做完了待核实 / 等排期 / 已暂停 / 已完成 / 排队中」，时间可选今天 / 近 7 天 / 近 30 天 / 自选区间，条件可一键清除；归档箱按「归档不是状态、也不是删除」实现，只有已完成且没有待办的任务给归档入口，收进后从看板与日常列表消失，运行记录、事件、当时的决定全部保留，归档列表按归档时间倒序，随时取回，归档与取回各记一条事件；归档态的类型计数改为按归档集合统计，数字与列表一致。文件 551344 bytes、7414 行、SHA256 `02EEB9BBE769CF2DCA8C5D18AE0D191CEB3091E22905B835D8A1C3CBB5749BCC`。v20（提交 `1091673`）按主人「流程多了会乱」的意见，把流程页顶部横排标签条收成一行可搜下拉：收起时只显示当前流程（名称、版本、共 4 个流程）；展开后顶部搜索框按名称 / 说明 / 负责人 / 触发方式 / 版本 / 发布状态过滤，每行给名称与版本、说明、触发·负责人·步数·运行次数·最近更新、已发布或草稿；当前流程标「当前」，Esc 或点空白处收起，Enter 直接切到第一条；流程再多也只占一行，不再横向溢出。文件 558042 bytes、7498 行、SHA256 `AEB59E16F9D10F1595311036AB3FAD6564C481E4EF8A1CD608B5B17B3F692873`。

### 4.2 下一步：S2 第四轮独立审计，过后开 S3 九节点与状态机

1. 六段设计已全部 pass：第六段 v44 第 45 轮 0 致命 / 0 重大 / 7 条措辞，设计稿保持 v44 冻结（2439 行 / 505410 bytes / SHA `D534FA8317A74C48286C83A65C994FC80D812B6B26110BCC533A7BA82699B793`）。
2. 规格已落 `docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md`（v1.3）：1493 行 / 106173 bytes / SHA256 `D78E4E2B7F3C569D20F8FEC27564B031240B4E1B947F34E47EF493CE9976F82E`，commit `26fc1af`。以设计稿 v44 为权威，第 45 轮 7 条措辞已在规格第 15 章逐条清，设计稿保持冻结；九处不一致已裁定并落成 v1.2，主脑与自治口径落成 v1.3 第 18 章。
3. 规格自审已过：120 标题、章 0–18、14 个表块 0 列不一致、非终态 13 值、全文 0 反引号；GateArtifact 为 G6 有 run 示例，四个哈希原像均为合法 JSON、sha256 全 64 位 hex。v1.2 后重校：六份计划 468 处规格引用逐条核对，内容不一致 0、小节归属不符 0；v1.3 只追加第 18 章、§1–§17 行号零位移，引用无需重校准；§18 表块列数一致、无占位符。等主人审阅。
4. 原型 v20 已提交（`1091673`）并交主人评审：流程页顶部横排标签条换成一行可搜下拉，按名称 / 说明 / 负责人 / 触发方式 / 版本 / 发布状态过滤，当前流程标「当前」，Esc 或点空白收起、Enter 切第一条；任务页可按状态与时间段查，归档箱只收起不改历史、可搜索可取回；状态数字与列表同源、状态句三处同源、健康支线默认收起、卡面只留「做到 / 结果 / 需要你」。
5. 实施计划已写完（总纲 + S1–S6，提交 `f094760`，含规格行号重校准；`26fc1af` 再补 S3 Task 15 起运行命令与自治档位、S5 Task 17 自治档位与审计留痕的显示，总纲 §5 批次表同步为 S3 15 个 Task / S5 17 个 Task）：等主人过目后按 `executing-plans` 或 `subagent-driven-development` 从 S1 起步，先跑 G1 门再进 S2。
6. 每次改稿后同步版本号、SHA256、行数与台账，改完提交 git。
7. **实施进度（2026-11-13 18:09，任务已暂停）**：S1 账本地基与 S2 单节点闭环已实现；第三轮整改已重签两道门（`c13814e` / `a5d0707` / `98dee52`）。**第四轮独立审计已回：G2 判 fail（致命 0 / 重大 5 / 不阻断 5）**，报告 `docs/audits/S2-independent-audit-round4.md`（`71db20c`）；其中 M1–M4 已整改并提交 `ed5c8b8`，M5 与 N1–N5 未做，两道门待重签。**审计判 pass 之前不开 S3**。续跑步骤见 §11.12。

> ⚠️ 第三段内改稿时**不要**新增顶层 `##` 标题（会打乱「三段」的叙事结构）；从第四段起按六段路线新增 `## 第四段 …`，不要改动前三段标题。不要删 §3.4b–§3.4m 的历史清单（它们是审计轨迹），不要在别的章节另写一份终态枚举（**终态集合只在 §8 写一份**）。

---

## 5. 六段路线与当前进度

| 段 | 内容 | 状态 |
| --- | --- | --- |
| 一 | 骨架与落点（桥 / 生命周期 / 控制面） | ✅ 完成（设计稿 L5–L96） |
| 二 | 把「硬」落成规则（17 条：node_run 字段、代次、证据、半态、超时、重试、sweep、迁移表、声明式判定、版本、身份账本、payload、上下文预算、存储、边界、事件、来源分离） | ✅ 完成（L97–L418） |
| 三 | 九节点图（§3.0 两类契约 → §3.5） | ✅ 完成（v23，第二十五轮 pass；§4.1） |
| 四 | 面板与查询 | ✅ 完成（v33，第三十四轮 pass；原型 v20 待主人评审） |
| 五 | 记忆插件对接 memory-audit-v1 | ✅ 完成（v37 第 38 轮 pass；v38 清两条措辞；5.1–5.14，Q-43–Q-63） |
| 六 | 分阶段落地与验收 | ✅ 第 45 轮 pass（0 致命 / 0 重大 / 7 措辞，已在 spec 清） |

六段已全过；规格已升 v1.3（`docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md`，提交 `26fc1af`），实施计划总纲 + S1–S6 已落盘（提交 `b8352db`，`26fc1af` 补 S3/S5 两个 Task），都在等主人审阅；通过后按 S1→S6 顺序实施，每批过门再进下一批。

---

## 6. 硬约束（写在最前面，违反就是返工）

来自主人（L3 记忆，只读不可改）：

1. **GitHub 访问走代理** `http://127.0.0.1:7078`，直连 github.com:443 不通。克隆命令：
   `git -c http.proxy=http://127.0.0.1:7078 -c http.sslVerify=false clone <url>`
2. **每个被维护项目的 `handoff.md` / `codebasemap.md` 写在该项目自己的仓库根目录** ← 本文件与 `codebasemap.md` 就在 `D:\aboutAI\dsh-orchestra\` 根。
3. 改 DSH 相关代码先留回退路径。
4. 踩过的坑写进 pitfall 记事本，别只在脑子里。
5. 主人格言：**「细节决定成败」「要求 100% 完成度」**，标准是「严格严谨」（R6）。
6. 涉及命令、链接的内容**单独成条**发给主人，方便直接复制。
7. 本项目工作目录限定在 `D:\aboutAI\dsh-orchestra`（原 dshQQ 的临时脚本在 `D:\aboutAI\dshQQ\tmp\`，别再往那儿堆东西）。
8. **写 D 盘要用 pwsh 内联脚本**（Write 工具对某些路径会被沙箱拒）；**python stdout 是 GBK**，要中文结果就写 UTF-8 文件再用 read 读。

设计层面的硬约束（`design-notes.md` 有详述，这里只列最容易犯的）：

- **node_run 只存事实，不存派生结论**（派生在 run 层算）。
- **Ga / Gr 是两个代次**，不能混：Ga 派发代次（只增不重置），Gr 续期代次（每次续期 +1）。
- **终态集合只在 §8 写一份**，别处一律引用不改写。
- **停止 ≠ 结算**：账上写着「动作停了」不等于「副作用没发生」。
- **人工裁决也必须过同一个证据门**，不能绕过。
- **报告（report）唯一入口是 `applyReport`**，别处不许直接改 node_run 状态。

---

## 7. 环境与工具

- DSH 本地：Web GUI `http://127.0.0.1:61829`；插件侧端口 8643；代理 7078。
- 图谱：`codebase-memory-mcp` 工具集（`index_repository` / `get_architecture` / `search_graph` / `get_code_snippet` / `trace_path` / `search_code` / `query_graph`）。
  图谱落 `C:\Users\ASUS\.cache\codebase-memory-mcp\<项目名>.db`；共享用 `persistence=true`（产出 `.codebase-memory/graph.db.zst`）。
- Windows 沙箱注意（`pwsh` 工具说明）：只读模式是 ConstrainedLanguage，`.NET` 静态调用、反射、COM 会失败；受限模式下不能用管道捕获子进程 stdout（EPERM），要用 `stdio: 'inherit'` 风格或让脚本自己写文件。

---

## 8. 常见坑（都已在记忆库 pitfall 记事本里）

| 坑 | 记忆条目 |
| --- | --- |
| 记忆条目核对要用 memory_get/search/diff，直读 sqlite 会漂移 | `mem_wags8yo_7931358b` |
| 改长文档必须同步版本号 | `mem_wbqyx5g_d07af920` |
| fstools edit_file 是全批原子语义，一个不匹配就全失败 | `mem_wbsi28i_8c747a93` |
| 审计轮次不收敛的三条判据 | `mem_wbsf89z_3ac546f6` |
| DSH 原生 workflowEngine 边界（observe-only、无持久账本） | `mem_mwbqk5mw_e85a80fd` |
| 先写不变量 + 迁移表 + CAS 三件套，再写叙事 | `mem_mwbr9rw2_60cb07bb` |

---

## 9. 还没人回答 / 悬着的事

1. **主人对节奏的选择**：「按建议节奏推进」还是「第三段多磨几轮」——（m03804 提过，未答）。
2. **记忆库底账**：旧底账 `mem_mwbqav4n_23bd4f8d` 仍是 archived 且内容指向 dshQQ，已改为指向本项目落点。
3. **旧事挂起待主人定夺**：QQ `newMessagePolicy` 改 steer（脚本 `D:\aboutAI\dshQQ\scripts\enable-qq-steer.ps1` 已备好未执行）、记忆插件 0.4.30 tag/release、是否装 DS-Bot、是否换 dsh-tauri 桌面壳。

---

## 9.5 Git 状态

- 仓库已初始化：`D:\aboutAI\dsh-orchestra\.git`，分支 `main`，首个提交 `fc92495`
  （docs: dsh-orchestra 项目落地（设计稿/台账/需求/设计思路/handoff/图谱索引）），共 7 个文件、1787 行。
- `.gitignore` 忽略 `references/`（三份参考项目各自带 `.git`，不并入本仓库）、`.codebase-memory/`、`tmp/`、`.tmp/`、`*.log`、`*.bak`；`docs/prototype/` 只提交 `panel-v2.html`，截图与一次性脚本不入库。
- 关键提交：`f7da467` agent skills 配置、`750c89f` v20 送审、`8b68b44` v21 收口、`d9a0c1e` v22 收口、`bdf9c17` v23 收口（第三段送审版）、`3e7ccc8` v27 送第 29 轮 + 原型 v7、`bb64f0b` 原型 v8 去掉彩色左条、`f7dde5e` v29 送第 31 轮 + 原型 v9、`99ca50e` v32 送第 34 轮、`462bfa9` 原型 v10 字号收口 + 设计 v31、`2136866` 原型 v10 绘图细节、`5f759e7` v33 第四段收口、`ce36151` v35 第五段修第 35 轮 13 条、`5c391b1` v36 第五段修第 36 轮 7 条并送第 37 轮、`33b093e` v37 第五段修第 37 轮 10 条并送第 38 轮、`8bfdc30` v39 第六段送第 39 轮、`3d4f59d` 原型 v11 字号层、`a1afa13` v41 第六段主体、`fd0df0b` G1 无 run 例外、`b747419` 记录重送与 G1、`0f950e6` v42 修第 42 轮 12 条并送第 43 轮、`6777ea4` v43 修第 43 轮 10 条 + 原型 v12、`63adb98` 原型 v13 去掉优先级标签并统一人话文案、`fb7d1f1` v44 修第 44 轮 9 条、`408df76` 记录 v44 送第 45 轮、`b068ca4` 记录第 45 轮 pass 并同步 handoff、`ee17d03` 落 v44 实施规格、`89d8836` 同步 v44 实施规格落盘与待审状态、`aea1b24` 共享面提案留档、`eeb7558` 原型 v15 纯白平面系统、`f3b7e94` 原型 v16 核心指挥台、`65b69c5` 原型 v17 执行注意事项落进任务流并重排数字字号、`b8352db` 落齐 S1–S6 六份批次计划、`f094760` 规格升 v1.2 裁定九处不一致并重校六份计划的规格行号、`26fc1af` 规格升 v1.3 补第十八章主脑与自治档位并为 S3/S5 各加一任务。、`a540e1e` 原型 v18 状态诚实、一处一概念、默认安静、文案收短（数字等于列表长度、状态句三处同源、健康支线默认收起）、`8aa9cef` 原型 v19 任务查询按状态与时间段、归档箱只收起不改历史、`1091673` 原型 v20 流程库改成一行可搜下拉、`c08fa3a` 校正七份计划的依赖与版本事实并清仓库补 GLOSSARY 与 ADR 0001（此提交同时是首次推到远端，`origin/main` 与本地同步）、`80442ac` 记录计划校正与路线、`5f8ad5f` Task 0 插件仓库骨架与工具链（`origin/main` 已同步）。、`c13814e` S2 第三轮整改（四条新故障注入证据 + 幂等单测 + 门检查表头修复 + 21 份证据重生成）、`a5d0707` 重签 G1、`98dee52` 重签 G2（新增 G2-11 必过项）、`71db20c` 落 S2 第四轮独立审计报告（G2 判 fail）、`ed5c8b8` S2 第四轮整改 M1–M4（门候选排除 docs/reviews、工具授权求交、单写者锁与 epoch 接启动路径、执行期租约心跳与续租路由）。
- 每次改设计稿后要提交（主人硬约束：改代码/文档后同步更新版本号并留痕）。

---

## 10. 第一条命令建议

接手先做这两件（不写代码）：

```powershell
# 1. 看设计稿现状与行数
Get-Content D:\aboutAI\dsh-orchestra\docs\orchestra-design-draft.md | Measure-Object -Line

# 2. 看台账最后一节（当前进度与续跑指引）
Get-Content D:\aboutAI\dsh-orchestra\docs\orchestra-audit-ledger.md -Tail 25
```

六段设计全部过审（第三段第 25 轮、第四段第 34 轮、第五段第 38 轮、第六段第 45 轮）；实施规格 v1.3 已落盘待审（`26fc1af`），实施计划总纲 + S1–S6 六份已落盘待审（依赖与版本事实已于 `c08fa3a` 校正）；面板原型 v20 已提交（`1091673`）等主人评审；GitHub 看板已建「dsh-orchestra 实施路线（Task 0 + S1–S6）」地图 + 9 张票；共享面（黑板）提案按主人意见暂不做，留档 `docs/superpowers/specs/2026-11-12-run-shared-context-addendum.md`；下一步路线见 §11。

---

## 11. 2026-11-13 这一轮：把「等审」之前的硬伤先清干净

### 11.1 做了什么

1. **七份计划的依赖与版本事实校正**（提交 `c08fa3a`）：
   - `peerDependencies` 全部补 `@deepseek-ai/` 前缀——`dsh-persistence` 真名是 `@deepseek-ai/dsh-session-persistence`，`dsh-client-ui-locale` 真名是 `@deepseek-ai/dsh-client-locale`；无 scope 的 `dsh-*` 在 npm 上多半 404 或指向无关包。
   - `engines.dsh` 由 `^0.2.1-alpha.2` 改为 `>=0.2.2-0 <0.2.3-0`：宿主实测 0.2.2-rc.1，旧区间不满足，插件会被宿主拒装。
   - `react`/`react-dom` 18.3.28 不存在，改钉宿主冻结的 18.3.1，补 `@types/react` 18.3.31、`@types/react-dom` 18.3.7；react 只作 external，bundle 不自带。
   - `pnpm` 11.7.0 → 12.3.4；删掉 Node 26 上必然失败的 `corepack enable` / `corepack prepare`（Node 26 不再随包分发 corepack）。
   - `tsdown` client 段 `neverBundle` 补 `/^@deepseek-ai\//`：宿主注入的客户端包打进 bundle 会出现两份实例。
   - `dsh.client.inject` 与宿主实包对齐（`dsh-client-locale` / `-ui-settings` / `-ui-renderer` / `-ui-layout` / `-ui-sidebar` / `-ui-workspace` 已在宿主 app.asar 核实存在）。
2. **仓库卫生**：删掉根目录 22 个临时件与误建的 `%SystemDrive%` 空壳目录；`.gitignore` 补 `node_modules/`、`lib/`、`storages/`、`.archify/`、`.local/`、`tmp-*`、`tpl-*`。
3. **域文档（single-context 落地）**：新增根 `GLOSSARY.md`（编排内核 / 主脑与执行 / 面板与记忆三组术语 + 术语纪律）与 `docs/adr/0001-ledger-single-writer-node-sqlite.md`（单库单写者 + node:sqlite + epoch 校验）。
4. **首次推远端**：此前 69 个提交全在本地，现在 `origin/main` 与本地同步在 `c08fa3a`。
5. **GitHub 看板**：在 `theBeautifulIce/dsh-orchestra` 建地图「dsh-orchestra 实施路线（Task 0 + S1–S6）」，下挂 9 张票——Task 0 与 S1–S6 七张 `wayfinder:task` 子票，按 S1←T0、S2←S1 … S6←S5 的阻塞链连边；另两张普通票：待主人拍板的开放参数与桥绑定名、评审队列（规格 v1.3 / 七份计划 / 原型 v20）。仓库标签体系已齐（五 triage + 五 wayfinder），不需要补建。

### 11.2 下一步路线

```
主人审阅（规格 v1.3 + 七份计划 + 原型 v20）
  → Task 0 骨架 → S1 账本 ─G1→ S2 执行桥 ─G2→ S3 节点与决定 ─G3
  → S4 流程版本 ─G4→ S5 面板与记忆 ─G5→ S6 硬化与发布 ─G6→ R0 → R1 → R2
```

- **每批只做三件事**：把对应计划里的 Task 逐条做掉 → 跑该批验收测试 → 写 `docs/gates/G<n>.md` 与 GateArtifact；门没过不往后走。
- **Task 0 已完成**（`5f8ad5f`，验收线全过，见 §11.4）；下一批是 S1 账本与状态机。
- **要主人先拍的三件事**：规格 16.3 六项开放参数、`report_registry` 是否加 `queued_for_replay` 字段、桥 RPC 七方法落到宿主插件 API 的确切绑定名（最后一项卡在 S2 开工前）。

### 11.3 环境现值

- Node `v26.13.1`（`D:\NodeJs\node.exe`）、npm 11.19.1、pnpm 12.3.4；`node:sqlite` 免旗标可用。
- 宿主 DSH `0.2.2-rc.1`；`gh` CLI 未登录，deck 插件后端可用（GitHub）。
- npm registry 与 GitHub 都走本地代理 `http://127.0.0.1:7078`。

### 11.4 Task 0 已完成（2026-11-13 12:00，提交 `5f8ad5f`）

- 落地 11 个文件：`package.json`、`tsconfig.json`、`vitest.config.ts`、`tsdown.config.ts`、`cordis.patch.yml`、`orchestra.config.json`、`src/index.ts`、`src/client/index.tsx`、`tests/smoke.spec.ts`、`.npmrc`、`pnpm-lock.yaml`。
- `.npmrc` 写 `auto-install-peers=false` 与 `strict-peer-dependencies=false`：`@deepseek-ai/*` 与 react 由宿主注入，安装期不该自动拉取。
- 实测（全部 exit 0）：`pnpm install` 9.4s，peer 解析到 `@deepseek-ai/dsh-*` 0.2.2-rc.2（满足 `>=0.2.2-0 <0.2.3-0`）；`pnpm typecheck` 无错；`pnpm test` 1 passed；`pnpm build` 产出 `lib/index.js` 0.10 kB + `lib/index.d.ts` 0.10 kB（ESM）与 `lib/client.js` 0.29 kB（CJS）。
- 产物核读：`lib/client.js` 是 `window.__ModuleLoader__.load({ id: "dsh-orchestra", factory: (require) => { … } });`，内部只有 `exports.clientId = "dsh-orchestra"`，没有任何 `require("react")` 或 `require("@deepseek-ai/…")`。
- 两处与计划原文的偏差：① 总纲 §5 内联的 tsdown 代码块 `neverBundle: [/^@deepseek-ai//, ...]` 是无效正则（斜杠未转义），client 端还漏了 `react/jsx-runtime`，已按 §4.1 权威块执行；② `.gitignore` 在 `c08fa3a` 已补齐 `node_modules/`、`lib/`、`storages/`，本任务无需再改。
- GitHub 票 #8（Task 0）已更新到 100% 并入办上报；S1 不受 §16.3 六项开放参数阻塞，可以开工；S2 起受桥 RPC 绑定名未定影响。

### 11.5 S1 账本地基已完成（2026-11-13 12:47，提交 `4c4fc20` 收口）

**提交链**：`4b47bc3` SQLite 单写者与 epoch 栅栏 → `de283c5` 迁移框架与十张最小表 → `23c6ac9` 事件哈希链与账本写入口 → `98b4905` 服务骨架与认证信封 → `ae2cdf2` 备份校验与恢复 → `46dbeab` 只读查询与游标 → `61b43db` 故障注入与六条 G1 用例 → `4c4fc20` G1 门记录与门检查命令。

**落地面**：`src/core/`（errors/config/canonical/ids/hash-chain）、`src/infra/`（sqlite/driver、db/open·tx·migrate·ledger、lock、logger、backup、service-state）、`src/service/`（server、envelope、write-queue、queries/{cursor,list_events,list_tasks,get_operation,verify_ledger}）、`src/infra/sqlite/migrations/001_init.sql`（十表五索引）、`scripts/fault-inject.ts`、`scripts/gate-check.ts`、`tests/`（14 个 spec，100 条用例）。

**验收（全 exit 0）**：`pnpm check` 全绿（typecheck 0 错 / 100 tests passed / build 产出 `lib/index.js` 0.10 kB、`lib/client.js` 0.29 kB、迁移 SQL 复制到 `lib/infra/sqlite/migrations/001_init.sql`）；`pnpm gate` 输出「gate G1 通过（13 项必过、13 份证据哈希复核，artifact_hash=0dff4bf33d94…）」；六条注入单跑 483–795ms 全过，证据文件重跑不再变化（测试只跑用例，证据只在 `node --no-warnings scripts/fault-inject.ts --case G-XX` 时覆盖生成）。

**G1 门记录**：`docs/gates/G1.md`，13 项必过（G1-01 迁移可重复、G1-02 中途杀可重入、G1-03 杀进程不丢已提交事件、G1-04 备份行数哈希一致、G1-05 损坏备份可检出、G1-06 认证拒匿名写、G1-07 阶段开关拒未知值、G-01/G-02/G-08/G-09/G-14/G-15），无 run、`gate_run_id=null`、`run_terminal=not_applicable`、`producer=human`；`artifact_hash=0dff4bf33d94381d90c06382daad5805d09d16f9d3a1b27d958beec44637874b`，锚点在 GateArtifact 之后，补记只追加；门记录另带 `evidence-index` 与 `invariants` 两个 json 原像块，四个哈希都能用 `pnpm gate` 重算。

**计划偏离七处**：提交顺序 Task 2→1→3；driver 补 `service_meta`/`schema_migrations` BOOTSTRAP；`uuidv7` 用 16 字节；cursor 加 `issued_at`；新增 `src/service/write-queue.ts`；tsdown 用 glob 复制迁移 SQL；证据文件改覆盖写、测试不写证据（否则每次重跑都会改哈希，门记录的 evidence_index_hash 立刻失真）。

**G1 未覆盖、留给 S2 的**：终态证据表（node_run done/failed/timeout 等）与租约、幂等上报；S1 只做到「事件追加 + 链校验 + 备份恢复 + 认证 + 阶段开关」。**S1 禁止项全程未碰**：没有桥 RPC、没有 parallel/subworkflow、没有 `workflow.*` 命令、面板没接真实账本。

**要主人拍**：G1 门记录的批准栏写的是 `human:啸春`、`approved_at` 为签字时刻；这份是自主跑完的卷子，主人认这个结论即是正式过门，要改任何一项我重签 `artifact_hash`。S2 开工仍卡桥 RPC 七方法绑定名（§11.2 第 3 条）。

### 11.6 S1 独立审计与修复（2026-11-13 13:05，提交 `10abcaa` 收口）

**审计**：独立子代理交 `docs/audits/S1-independent-audit.md`，结论「G1 建议不通过」：13 项里 G-08 fail、G-15 存疑、其余 11 pass。

**五处硬伤与修法**：

1. **F1 门检查不校验证据**：原先 `scripts/gate-check.ts` 只验 artifact 自身字段与锚点，给证据文件追加一行仍 exit 0。现在门记录带 `evidence-index` 原像块，门检查逐份重算 sha256（按 LF 归一），不符即点名 `证据文件 sha256 不符: ev-g15`；新增用例覆盖。「测证据被改」的用例在 finally 里恢复文件。
2. **M2 写队列没接服务写路径**：`src/service/server.ts` 的 POST /v1/ledger/events 改为 `await queue.run(...)`，队列由 `startServer` 注入（默认 1000）；`WriteQueue` 加可选 logger，满时记 warning 再抛 503。新增 `tests/write-queue.spec.ts`：max=0 时服务返 503、账本没被写、日志里有 warning。
3. **M3 三个哈希无原像**：`candidate_hash`/`change_scope_hash` 由门检查按 `scopeBase..HEAD` 的 git 内容重算（排除 docs/gates 与 docs/audits，记录本身不进候选）；`evidence_index_hash`/`invariants_hash` 由两个 json 原像块重算。口径写进 G1.md 补记。
4. **M4 必过清单不固定**：`GATE_SPECS` 内嵌 G1 的 13 项 id 序列，截短、改名、增删一律报「必过项清单不符」。用例把清单截成 1 项并重签锚点，仍被拦住。
5. **M5 G-15 自相矛盾**：快照改在关闭连接后取（此前 4096→126976 是 WAL checkpoint 造成的假变化），对账改成 `恢复被拒：true` / `线上库未变：true`，用例同步加这两条断言。

**轻微项**：handoff 的 13 spec → 14；G-01 证据里的临时目录统一写成 `<tmp>`；/v1/events 单页上限 500 → 200，与 `EVENTS_LIMIT_MAX` 一致；游标接进 /v1/events（`cursor` 参数与 `next_cursor`），并对「签发时间在未来」的游标报 `CURSOR_EXPIRED`。

**复验**：`pnpm check` 全绿（14 spec / 100 用例），`pnpm gate` 通过；G1 重签为 `0dff4bf33d94…`。

### 11.7 S2 单节点闭环已完成（2026-11-13 13:21，提交 `ca8cea3` 收口）

**提交链**（`4f3ada7` 之后）：`a48d4de` 账本扩展迁移 002 → `a2f6491` 桥 RPC 七方法 → `05d5eb5` 桥事件缓冲与断号重取 → `e23079c` 工具注册表与前向能力推导 → `130fc40` runTool 强证据 → `a27d148` 租约获取/续期/过期扫描 → `840290b` agent 执行器与输出三件套 → `302d222` 节点状态机（20 键、Ga/Gr 分离）→ `7131316` applyReport 六步 → `11f94b2` 证据门与判定规则 → `6143f7d` 取消四值与超时围栏 → `c9399ac` 单调时钟与维护扫描 → `a1a75bb` S2 阶段开关 → `ca8cea3` G2 用例与四条故障注入 → `d844a0e` G2 门记录与十一条证据。

**落地面**：`src/executor/bridge.ts`（事件缓冲、spill、gap 整页重取、`toolStartAnchor`）、`src/executor/tools.ts`（ToolRegistry、`deriveEffectiveCapability`、`resolveDeclaredPolicy`、`ReadOnlyToolRunner.runTool`、`commandHashOf`、`assertCommandHash`）、`src/executor/session.ts`（工具白名单/黑名单、64 KiB 载荷上限、800 字摘要、`inheritHistory:false`）、`src/service/commands/lease.ts`、`node-state.ts`、`apply-report.ts`、`cancel.ts`、`src/service/sweep.ts`、`src/core/state-machine.ts`、`report.ts`、`policy.ts`、`clock.ts`、`workflow-def.ts`。

**验收（全 exit 0）**：`pnpm check` 全绿（typecheck 0 错 / 27 spec / 211 用例 passed；build `lib/index.js` 0.10 kB、`lib/index.d.ts` 0.10 kB、`lib/client.js` 0.29 kB）；`node scripts/gate-check.ts docs/gates/G2.md` 输出「gate G2 通过（11 项必过、11 份证据哈希复核，artifact_hash=825c6727e55f…）」；G1 因候选范围变化联动重签，`artifact_hash=bf64eba9e608…`，同样复核通过。

**G2 门记录**：`docs/gates/G2.md`，11 项必过为 G2-01..G2-07（单节点 queued→done 三步、重复上报只落一次、租约过期迟到被拒、取消不产生新 attempt、终态必带证据、无裸 blocked、S2 加载 parallel 被拒）与 G-03/G-04/G-05/G-07 四条 S2 故障注入；四条不变量 I1 终态唯一 / I2 账本只追加 / I3 CAS 无副作用 / I4 终态必有证据；证据 11 份在 `docs/gates/evidence/G2/`，硬编码口径写在本批定值表（租约 30 秒、续期 10 秒、动作超时 120 秒、取消宽限 30 秒、桥缓冲 8 MiB / 高水位 4 MiB、`run_tool` 强证据 / `tool_result` 弱证据、`report_seq` 每个 node_run 从 1 起、写队列 1000、回执保留 7 天）。

**计划偏离三处**：① 先写 `src/core/policy.ts` 再写 `apply-report.ts`（六步里要调证据门）；② 计划里的 `rejectReport` 漏了 `now` 参数，导致 `report_registry.created_at` NOT NULL 失败，六个调用点已补；③ Task 14 的 g2 用例把「无裸 blocked」限定 `node_run_id LIKE 'nrun_%'`，因为 S1 seed 的 `nr1` 是遗留 running 夹具，不在 20 键枚举内。

**S2 未覆盖、留给 S3 的**：九节点类型与 `parallel`/`subworkflow` 的调度、决定节点与 inbox、自治档位、面板接真实账本。**S2 禁止项全程未碰**：没有发布流程定义、没有记忆裁判桥、没有面板写入。

**下一步**：按主人要求交独立子代理做 S2 审计（不自测），审计报告落 `docs/audits/S2-independent-audit.md`，结论写进票 #9；审计过再开 S3。

### 11.8 S2 独立审计整改与重签（2026-11-13 13:56，提交 `ac13080` + `234e934`）

**审计结论**：独立子代理给出「G2 建议不通过」，致命 7 条、重大 12 条，11 项必过 pass 2 / fail 8 / 存疑 1。报告在 `docs/audits/S2-independent-audit.md`（191 行）。

**七条致命与改法**（每条都配了回归用例）：

| 编号 | 审计说的 | 改法 |
| --- | --- | --- |
| F-01 | S2 命令与执行器没接生产路径，只有单元测试自证 | 新增 `src/executor/run-node.ts`、`src/service/commands/runtime.ts`、`src/service/workflows.ts`；`src/index.ts` 装配 `createOrchestra`；`server.ts` 挂 `/v1/workflows/load` 与 `/v1/node-runs/{lease,report,cancel}`；`tests/runtime.spec.ts` 从建库一路跑到 done |
| F-02 | 当前 HEAD 的 G1/G2 门检查都 exit 1（candidate_hash 失效） | 候选范围排除 `handoff.md`；门记录正文必过项表与 GateArtifact 做交叉校验（`checkBodyTable`） |
| F-03 | G-03/04/05/07 证据前后两段相同（只 dump events），且随机 id 不可复现 | `scripts/fault-inject.ts` 加 `dumpState`（events + node_runs + node_run_events + report_registry）；`writeEvidence` 归一事件 id 与临时路径，重跑字节一致 |
| F-04 | 重放只查 COUNT(*)，不验链不验队头 | `apply-report.ts` 重放走 attempt 校验 → `chainBreakOf` 断链回 `replay_chain_broken` → `MIN(report_seq)` 队头不符回 `replay_not_head` |
| F-05 | 围栏期间 done 仍被 applied | 围栏 armed 时收口一律拒绝（`fence_armed`），`sweep.ts` 到点撤围栏并取队头重放 |
| F-06 | 桥二次 spill 覆盖同名文件，丢 1..10 | spill 改多段文件 `agentId-first-last.jsonl`，`takeFrom` 合并全部片段与内存、按 seq 去重排序 |
| F-07 | 取消 CAS 没有 status 条件，done 能被改回 timing_out | `cancel.ts` 前置终态判断（`already_stopped` / `terminal_no_out_edge`），CAS 带可取消状态集；重复取消回 `fence_already_armed`；`revokeFence` 要求宽限到点 |

**重大项同步改的**：判定条件合并改成「模板为基线 + 节点同 path 同 op 的不同值两条都留（AND）」；跨 boot 剩余预算按 `min(budget, budget-downtime)` 取；阻塞迁移必须带 `decision_id`（没有就出 `DECISION_REQUIRED` 提案码）；提案码 `LEASE_EXPIRED` / `DECISION_REQUIRED` 记在 G2 的例外表。

**重签结果**：G1 candidate=`0cba89a94232…`、artifact_hash=`b490e301078a…`；G2 candidate=`9d468e8aeda4…`、artifact_hash=`75c41b95f0a8…`。`node scripts/gate-check.ts docs/gates/G1.md` 与 G2 均通过（13 项 / 11 项必过，证据 13 份 / 11 份哈希复核）。`pnpm check` 全绿：typecheck 0 错、29 spec / 227 用例 passed、build `lib/index.js` 48.70 kB + `lib/client.js` 0.29 kB。

**测试与证据口径**：`tests/integration/g2.spec.ts` 13 条（原 11 条 + 阻塞裁决卡 + 已完节点取消）；`tests/runtime.spec.ts` 2 条生产路径；`tests/routes.spec.ts` 2 条命令路由；G2 证据 7 份用例说明 + 4 份故障注入，四份注入重跑后字节不变（G-03 连跑两次 SHA256 相同）。

**下一步**：把这一版交第二轮独立审计（同样不许自测）；若过，S2 收口，开 S3 九节点与状态机。

**未做的**：`workflow_versions` 表与发布流程留给 S4；inbox/裁决卡界面留给 S5；24 小时浸泡留给 S6。

### 11.9 第二轮独立审计整改与重签（2026-11-13 14:57，提交 `e845dfa` + `aa24312` + `f1111aa`）

**审计结论**：第二轮独立审计（`docs/audits/S2-independent-audit-round2.md`，313 行）判 G2 不通过。旧七条里 F-01 未修（生产路径根本不存在），F-04 / F-05 只修了一半路径；新列十一条 N-01…N-11，其中致命四条：N-01 裸卡住绕过 I5、N-02 判定失败永久停在 verifying、N-03 多工具只留最后一个工具的证据、N-04 围栏 + 迟到 unknown 让 sweep 永久 STALE_GENERATION。

**四条 P0 的改法**：

| 编号 | 审计说的 | 改法 |
| --- | --- | --- |
| N-01 | applyReport 能裸写 blocked_post，decisionEvents=0 | 第六步改走 transitionNode；blocking 时 `request.reason` 或 `error_code` 必须有一个非空，否则按 `decision_required` 拒收、节点状态不动；补齐后挂 verify_human 事件 |
| N-02 | runNode 判定失败后永久 verifying，sweep 扫不到 | 进 verifying 写 `verify_deadline_at`（缺省 120000ms），离开清钟；sweep 到点转 blocked_post + verify_human(reason=verify_timeout)；runNode 收口被拒即 markBlocked |
| N-03 | 多工具节点只留最后一个证据，首个工具 exitCode=3 仍报 done | 每工具写 tool_start_at 与 tool_started 事件；报告带 output.evidence_trace；任一工具非零退出即 break，判定用失败证据，不得 done |
| N-04 | 围栏 armed 时 cancel 改状态、sweep 的 revokeFence CAS 落空 | 围栏立着时取消只记结果不改状态（reason fence_pending）；queued/leased 取消转 superseded（不产生新 attempt）；sweep 逐行事务，单行失败不拖垮整批 |

**七条 P1 的改法**：跨节点 report_id 重放抛 SCHEMA_VERSION_UNSUPPORTED（N-05）；同 report_id 的 report_replayed 只追加第一条（N-06）；report.attempt 与节点不符按 attempt_mismatch 拒收（N-07）；server 校验 cancelResult 枚举、非法值 400（N-08）；门候选含删除文件、证据只认 HEAD 字节、工作树必须干净、正文表第 2 列与 exceptions 同源（N-09）；四份手写证据改成脚本从真实入口跑出来（N-10）；例外表补 BRIDGE_ACK_LAG(409)、DECISION_REQUIRED 依据写进 S2 计划末尾「口径补充（第二轮审计后）」（N-11）。

**生产装配补齐（F-01）**：新增 `src/service/runs.ts`（createRun：建 task/run/node_runs）与 `src/service/dispatcher.ts`（dispatchRun：拾 queued 节点走 runNode）；server 挂 `POST /v1/runs` 与 `POST /v1/runs/dispatch`；`tests/production-path.spec.ts` 三条全链路 HTTP 用例。

**提交链**：`e845dfa` 源码与测试 → `aa24312` 证据重写 + 计划口径补充 + 两份审计文档 → `f1111aa` 重签 G1 / G2 门记录。

**重签结果**：G1 candidate=`21587626d731…`、artifact_hash=`1a3d7eb0aa58…`；G2 candidate=`e535a85d7360…`、artifact_hash=`41a299fe330a…`。`node scripts/gate-check.ts docs/gates/G1.md` 与 G2 均通过（13 项 / 11 项必过，证据 13 份 / 11 份哈希复核）。

**验收（全 exit 0）**：`pnpm check` typecheck 0 错、vitest 31 个文件 / 254 用例全绿（8.94s）、build 通过；四份 ev-g2-* 注入证据连跑两次 sha256 一致（3f1e9a5b… / 74c0a947… / cef5cf3d… / 607471ff…）。

**逐条对照表**：`docs/audits/S2-round2-response.md`（旧七条 / N-01…N-11 / 规格一致性五条 / 门记录有效性 / 移交 S3 四条 / 验证命令）。该表是实现者自证，不作放行依据。

**未闭合、移交 S3 的**：F-06（桥 spill 未接生产路径，bridge.ts 仍只在单元层复现）、§七.5（applyReport 仍接受 policy 参数）、四条新路由在规格 §6.1 的落点、DECISION_REQUIRED 与 BRIDGE_ACK_LAG 进规格 17.1。

**下一步**：派第三轮独立审计（独立子代理，不自测）；审计过才开 S3 九节点与状态机。

### 11.10 第三轮独立审计整改与重签（2026-11-13 16:40，提交 `c13814e` + `a5d0707` + `98dee52`）

**审计结论**：第三轮独立审计（`docs/audits/S2-independent-audit-round3.md`）判 G2 不通过 —— 致命四条（R3-01 裸卡住绕过 I5、R3-02 判定失败永久停在 verifying、R3-03 多工具只留最后一个证据、R3-04 围栏加迟到 unknown 让 sweep 永久 STALE_GENERATION）＋重大八条。

**本轮做了什么**：

| 项 | 做法 |
| --- | --- |
| 四条新证据 | `ev-g2-08`…`ev-g2-11` 落到 `docs/gates/evidence/G2/`，全部由 `scripts/fault-inject.ts` 从真实入口跑出，哈希可复算 |
| 新增必过项 | G2 加第 16 条 **G2-11「反复重投同一 report_id 不许把账本刷膨胀」**，不变量表补到 I7 |
| 幂等单测 | `tests/apply-report.spec.ts` 新增两条：成功落账连投三次、被拒报告连投四次 |
| 修门检查自身缺陷 | `scripts/gate-check.ts` 的 `tableRows` 原来把「不变量」表表头当数据行，两道门正文行数比 artifact 多 1；已改为同时跳过首格为「不变量」的表头行（文件 562 行） |
| 证据重生成 | 全部 21 份（G1 6 份 + G2 15 份）重跑，exit 0 |
| 门机制加固 | 门记录加治理字段 `previous_artifact_hash` / `audit_round` / `audit_report`，正文加 `body_hash` 自锚；证据只认 HEAD 字节、必过项清单与 `GATE_SPECS` 常量逐项比对 |

**提交链**：`c13814e` 整改代码与证据 → `a5d0707` 重签 G1 → `98dee52` 重签 G2。

**重签结果**：G1 candidate=`15fd9c509e81…`、artifact_hash=`7c371df81692…`、body_hash=`ba3f37c3e53a…`；G2 candidate=`da60a01647ea…`、artifact_hash=`884a606523f2…`、body_hash=`e6d03e972f28…`。`node scripts/gate-check.ts docs/gates/G1.md` 与 G2 均通过（13 项 / 15 项必过，证据 13 份 / 15 份哈希复核）。

**验收（全 exit 0）**：`tsc --noEmit` 0 错；vitest 31 个文件 / 271 用例全绿（13.69s）。

**逐条对照表**：`docs/audits/S2-round3-response.md`（R3-01…R3-12 逐条：主张 / 改法文件:行 / 证据 / 用例 / 状态；另含审计第 7 节六条未闭合项的真实状态，以及对「verify_remaining_ns 是死列」这处误判的更正）。该表是实现者自证，不作放行依据。

**未闭合、移交 S3 的**（8 条）：F-06（桥 spill 未接生产路径）；applyReport 签名仍收 policy 参数（信任面已闭合：请求体带不进 policy，runtime.ts 由 `catalog.policyFor(run.workflow_version, node_id)` 取；签名收口牵动 15 处调用点 + fault-inject 取证语义，留 S3）；四条新路由在规格 §6.1 无落点；DECISION_REQUIRED 与 BRIDGE_ACK_LAG 进规格 §17.1；verify_remaining_ns 的 remaining 重挂语义；**工具白名单交集**（`run-node.ts` 执行 `p.tools` 前不与 `toolPolicy.allow/deny` 求交集）；**单写者锁与 epoch 没接启动路径**（`createOrchestra` 未调 `acquireDbLock` / `bumpEpoch`）；**续租路由与执行期自动续租缺失**（租约 30 秒 < 动作超时 120 秒）。

**下一步**：第四轮独立审计已派独立子代理（`a749d93d-e165-403e-a87e-0ddf09d4d94c`，不自测）；审计判 pass 之前不开 S3 九节点与状态机。

### 11.11 外部静态评审（2026-11-13）要点与处置

外部评审方按 GitHub 公开仓库做静态审阅（看到的是约 29 spec / 227 用例的旧状态，未本地跑测试）。逐条核实与处置写在 `docs/reviews/2026-11-13-external-architecture-review.md`。要点：

- **成立且要改的三条**（新增，进 S3 开场前的加固）：工具白名单交集（`run-node.ts` 执行 `p.tools` 前不与 `toolPolicy.allow/deny` 求交集，`tests/runtime.spec.ts` 里 allow 为空仍执行 `ro.echo`）；单写者的进程级隔离没接启动路径（`createOrchestra` 未取文件锁、未递增 epoch）；租约生命周期缺口（无续租路由、执行期不续租、`runNode` 复用同一个 `p.now`，而租约 30 秒 < 动作超时 120 秒）。
- **本轮已闭合的**：强证据伪造（系统级证据门 + 痕迹绑定门 + 服务端落库痕迹）、`requiredHashes` 未接入判定流程。
- **已过时的**：维护扫描没自动跑（`serveOrchestra` 里 2 秒一轮，早就有）。
- **本来就登记在册的**：桥未接生产路径（F-06，留 S3）；工作流定义未持久化、只按 `workflow_version` 索引且允许覆盖（留 S4 做 `workflow_versions` 表）。
- **工程细节四条**：WriteQueue 只是 pending 计数、HTTP 入参只做 `requireFields`、`resolveInside` 不查符号链接、配置装配未统一入口 —— 都在 S6 硬化范围；另建议加 GitHub Actions CI（仓库目前没有 `.github/workflows`），把门检查变成合并硬门槛。
- 这三条新缺口已同时交给第四轮独立审计子代理独立核实（不自证），审计结论里会一并给判定。

### 11.12 第四轮独立审计（fail）与整改暂停点（2026-11-13 18:09）

> 本节是暂停点的历史记录，表内「未改」是当时状态；整改已完成，最新状态见 §11.13。

**审计结论**：第四轮独立审计（子代理 `a749d93d-e165-403e-a87e-0ddf09d4d94c`，不自测）判定 **G2 不通过：致命 0 / 重大 5 / 不阻断 5**。报告 `docs/audits/S2-independent-audit-round4.md`，提交 `71db20c`。

| 编号 | 主张（审计要点） | 现状 |
| --- | --- | --- |
| M1 | 门记录与 HEAD 漂移：`docs/reviews/` 进了 G1/G2 候选范围却不在 excludes，两道门在 HEAD 上跑 `node scripts/gate-check.ts` 均 exit 1 | 已改：`scripts/gate-check.ts` 的 G1 excludes（:76）、G2 excludes（:117）、DIRTY_IGNORES（:175）加 `docs/reviews`；**待重签** |
| M2 | 工具白名单在生产路径不生效：`runNode` 执行 `p.tools` 前不与 `toolPolicy.allow/deny` 求交，`tests/runtime.spec.ts` 里 allow 为空仍执行 `ro.echo` | 已改：`src/executor/tools.ts:41-62` 新增 `assertToolsAuthorized`（deny 优先 → FORBIDDEN；未注册 → TOOL_NOT_REGISTERED；不在 allow → FORBIDDEN），`src/executor/run-node.ts:61` 调用 |
| M3 | 单写者锁与 epoch 没接启动路径：`createOrchestra` 未 `acquireDbLock`、未 `bumpEpoch` | 已改：`src/index.ts:104-126` 新增 `openServiceOrchestra`（acquireDbLock → bumpEpoch → openServiceDb → createOrchestra，返回 release），`serveOrchestra` 改走它 |
| M4 | 租约生命周期缺口：无续租路由、执行期不续租，租约 30s < 动作超时 120s | 已改：`src/executor/run-node.ts:35-36` 定 `DEFAULT_LEASE_TTL_MS=30000` / `DEFAULT_LEASE_RENEW_INTERVAL_MS=10000`，`:69-83` setInterval 心跳续租；`src/service/server.ts:195-202` 新增 `POST /v1/node-runs/renew`，`src/index.ts:52` 接 `commands.renewLease`；遗留：`src/service/dispatcher.ts:54` 的 `leaseTtlMs ?? 600000` 还没统一 |
| M5 | `applyReport` 仍收 `policy` 参数，与规格 §4.2:293「policy 不在参数里」冲突（信任面已闭：请求体带不进 policy，runtime 由模板反查） | **未改**，本轮暂停。改签名牵动 15 处调用点；另一条路是改规格并在门记录登记偏差，二选一 |
| N1 | `ev-g2-08` 的 `command_hash` 含临时目录路径，不是字节可复现 | 未改：把 `commandHashOf` 的 cwd 归一为工作区相对路径后重跑证据 |
| N2 | `ADDED_THEN_DELETED` 分支无单测 | 未改 |
| N3 | 门记录无密码学签名；`scripts/gate-check.ts` / `scripts/sign-gate.ts` 自身在候选范围内却无独立锚点 | 未改 |
| N4 | `tests/gate-check.spec.ts:31`「G1 门记录通过」并行满负载超 5000ms 超时（flaky） | 未改：给该用例加 timeout 即可 |
| N5 | `docs/gates/G2.md:80` 复现命令写 `pnpm`，本机不可用 | 未改：换 `node node_modules/typescript/bin/tsc --noEmit` 与 `node node_modules/vitest/vitest.mjs run` |

**本轮已提交**：`ed5c8b8`（M1–M4，8 文件 +162/−43），工作树干净；`handoff.md` 不进候选（DIRTY_IGNORES），改它不挡签门。

**验收（实测）**：
- `D:\NodeJs\node.exe node_modules/typescript/bin/tsc --noEmit` → exit 0。
- `D:\NodeJs\node.exe node_modules/vitest/vitest.mjs run` → 31 文件 / 271 用例，**270 passed / 1 failed**；失败即 N4 的 flaky 超时（单跑 `tests/gate-check.spec.ts` 22 例全过）。
- 干净 clone（HEAD）上两道门都 **exit 1**，原因是 candidate_hash 漂移：G1 `15fd9c509e81…` != `d6ae7bceb9ba…`；G2 `da60a01647ea…` != `325d3d7f73b8…`。这是 M1 的直接后果，**重签后才会回到 0**。

**当时列的续跑步骤（已全部完成，见 §11.13）**：补 M5 → e5 进 S3 计划 → 修 N1–N5 → 写 `docs/audits/S2-round4-response.md` → 重签 G1/G2 → 双门 exit 0 → 派第五轮独立审计。

**环境速查**：node=`D:\NodeJs\node.exe`（v26.13.1）；pnpm 在本机不可用（`cmd.exe /c pnpm.cmd` 报「命令语法不正确」），一律用上面两条 node 命令；GitHub 走 `http://127.0.0.1:7078` 代理；`gh` 没凭据，票走 deck 插件。

### 11.13 第四轮整改收口（2026-11-13 19:20）

**已完成**：M1–M5、N1/N2/N4/N5、e5 全部落点；M5 把判定条件收进 `applyReport` 内部（按 run 的 `workflow_version` 取 `catalog.policyFor`），命令层只传 catalog，19 处调用点全部改完；e5 写进 S3 计划 Task 5 第 5 步（冻结/重挂/跨 boot 公式 + 三例验收）；N1 把 `commandHashOf` 的 cwd 按工作区根归一成相对路径；N2 补「批内新增又删除」用例；N4 门记录用例组 timeout 放宽 30 秒；N5 复现命令改 node 直跑。N3（门记录无密码学签名）按审计要求未修，残余风险留在 `docs/audits/S2-round4-response.md`。

**验收（实测）**：
- `tsc --noEmit` exit 0；`vitest run` 31 文件 / 272 例全绿（14.64s）。
- `gate-check.ts docs/gates/G1.md` exit 0：13 项必过、13 份证据，candidate=`bbd322cf9d4e…`、artifact_hash=`1ce80f6080fb…`、body_hash=`446357f9e00e…`。
- `gate-check.ts docs/gates/G2.md` exit 0：15 项必过、15 份证据，candidate=`f11d0fb8751c…`、artifact_hash=`b5615b8b5725…`、body_hash=`ef21bb456813…`。
- ev-g2-08 连跑两次 sha256 一致：`54e4b0e8…`。

**提交链**：`a7b03cb` 整改 → `ecbd247` G1 重签 → `df7d23a` G2 重签（`8154e18` / `53d36cc` 为收口文档与 codebasemap 同步）。对照表 `docs/audits/S2-round4-response.md`。

**当前关口**：第五轮独立审计子代理 `ff0066da-1d07-4ae9-afc3-27044fc04734` 已派（不自测），结论回来前不开 S3 九节点与状态机。审计若判 pass，下一步按 `docs/superpowers/plans/2026-11-12-dsh-orchestra-s3-nodes-state.md` 开 S3；若再出重大项，回到 §11.12 表逐条整改。

### 11.14 第五轮独立审计整改（2026-11-13 19:35，提交 \`f68e836\`）

**审计结论**：第五轮独立审计（\`docs/audits/S2-independent-audit-round5.md\`）判 G2 fail：致命 1 / 重大 3 / 不阻断 4。致命是门记录拿结论为 fail 的第四轮报告签 pass（P0-1）；重大是同一工作流版本可 reload 改写（P1-1）、工具授权仍由请求体自带（P1-2）、\`createOrchestra\` 能绕过锁与 epoch（P1-3）；不阻断四条是 M4 长动作与续租收口、门检查证据可换绑、ev-g2-10 实体对调、服务端时间基准。

**本轮改法**：

| 项 | 落点 |
| --- | --- |
| P0-1 | \`scripts/gate-check.ts:428\` 的 \`auditConclusionOf\` 读报告结论；\`:436\` 的 \`checkAuditAnchor\` 在结论不一致时拒绝；\`tests/gate-check.spec.ts\` 补六种输入回归 |
| P1-1 | \`src/service/workflows.ts:19\` 的 \`load\` 同版本内容不同抛 \`WORKFLOW_VERSION_IMMUTABLE\`；新增 \`tests/workflows.spec.ts\` 五例 |
| P1-2 | \`runNode\` 不再收 \`toolPolicy\`，由 \`policyForNodeRun\` 按 \`node_run → runs.workflow_version\` 取 \`node.tools\`；请求体策略字段删除；请求 \`args\` 不再覆盖注册表；\`tests/production-path.spec.ts\` 补 deny / 空 allow / 未注册三例，\`tests/runtime.spec.ts\` 补借 \`nodeId\` 越权一例 |
| P1-3 | \`src/index.ts:43\` 模块私有 \`ORCHESTRA_LOCK_PROOF\`；\`createOrchestra\` 无凭证抛 \`FORBIDDEN\`；测试与 \`scripts/fault-inject.ts\` 全部改走 \`openServiceOrchestra\` |
| P2-1 | \`run-node.ts\` 读 \`actionTimeoutMs\`；续租失败写 \`lease_lost\` 事件并按租约丢失收口；长动作用例 3 秒动作 / 2 秒租约 / 500 毫秒续租 |
| P2-3 | \`scripts/fault-inject.ts\` 的 \`normalizeEvidence\` 改为全篇共用一套实体映射，重生成 \`ev-g2-10\` |

**门与证据**：G2 加 G2-12/13/14 三项必过项与 \`ev-g2-12/13/14\` 三份证据，不变量补 I8/I9/I10；G2 表内证据哈希已更新（12 \`5c2d543f…\`、13 \`a5260693…\`、14 \`865fd0b7…\`、10 新 \`76b458ed…\`）。审计锚仍是 round4 fail 报告，等第六轮 pass 报告后改为 \`audit_round=6\` / \`audit_report=docs/audits/S2-independent-audit-round6.md\` 再重签。

**验收（实测）**：\`tsc --noEmit\` exit 0；全量 32 文件 / 281 用例，272 passed / 9 failed，9 个全在 \`tests/gate-check.spec.ts\`，首因全是「审计报告结论与门记录结论不符：报告=fail，门记录=pass」，属 P0-1 生效后的预期，待新报告与重签。

**提交**：\`f68e836\`（21 文件，+743/−103）；工作树干净。对照表 \`docs/audits/S2-round5-response.md\`。

**下一步**：第六轮独立审计与 S1/G1 第二轮独立审计已并行派出（S2 \`83e3bd88-06b0-42e4-8162-a80ceb7e8f7e\`、S1 \`366bec2f-c6e7-4799-ad76-cfd2d21939ad\`），不自测；两份报告都 pass 后改审计锚、重签 G1/G2、双门 exit 0，再开 S3。

### 11.15 第六至第八轮审计、S1 第四轮与门检查加固（2026-11-13 20:30，HEAD f7ebe69）

S2 第六轮判 fail：审计结论解析取全文第一个“结论”、不锚行首；G2 未按 18 项重签；工作流定义只在内存。第七轮再判 fail（审计报告归档与门锚细节），第八轮判 pass：docs/audits/S2-independent-audit-round8.md，P0=0 / P1=0 / P2=8，19 项必过与 19 份证据从 HEAD 重算全对，ev-g2-15 重跑字节一致。

S1 第四轮判 fail：docs/audits/S1-independent-audit-round4.md。P1-1 是 auditConclusionOf 对“结论/判定开头但未收口”的行直接 continue，报告同写 pass 与 fail 时返回 pass；P2-1 是正文证据表/不变量表只查行数与子集，删一行复制另一行仍能签过。另有 P2-2 G-08 缺 503/warning、P2-3 G-15 含绝对临时路径、P2-4 审计报告未绑定门与候选 HEAD。

f7ebe69 改法：
- auditConclusionOf：结论候选行未严格解析时返回 null（歧义），不再跳过；同行同时出现 pass/fail 返回 null；大小写归一。修 P1-1、S2 P2-6/P2-8。
- 正文证据表与不变量表：拒绝重复 id，并要求与 artifact 列表完全覆盖；两个 checker 导出给单测直接调用。修 P2-1。
- docs/gates/evidence/G1/G-15.md 的备份路径改为 <tmp>/backup-g15，消除绝对临时路径（P2-3）。
- docs/gates/G2.md 把“动作总时限读 execution.action_timeout_ms”改为“默认 120 秒，配置接线留 S3”，与代码实际一致（S2 第八轮 P2-1）。
- tests/gate-check.spec.ts 补 4 例：未收口结论候选、大小写/同行相反结论、两表重复行。

验收（实测）：tsc --noEmit exit 0；全量 32 文件 / 294 例，284 passed / 10 failed，10 红全在 tests/gate-check.spec.ts，首因均为 G1 audit_report_sha256 仍是占位 0（待签状态），不是新缺陷。新增 4 例定向运行全过。

当前门状态：G1 仍是 13 项、audit_round=1、audit_report=docs/audits/S1-independent-audit.md（旧 fail 报告）、审计 sha 全 0；G2 是 19 项、audit_round=4、audit_report=docs/audits/S2-independent-audit-round4.md（fail 报告）、审计 sha 全 0。两门都未重签。

下一步（按序）：S1 第五轮（docs/audits/S1-independent-audit-round5.md）与 S2 第九轮（docs/audits/S2-independent-audit-round9.md）独立审计已派出（S1 458ae59f-9bc9-414e-a41e-adf05acc0f8d、S2 f55ae8ed-95d1-4c3b-a532-02d456b0d013）。两份都 pass 后：提交两份报告 → 改 G1 audit_round=5 / audit_report=S1-independent-audit-round5.md，改 G2 audit_round=9 / audit_report=S2-independent-audit-round9.md，审计 sha 清零 → 提交 → sign-gate G1、提交 → sign-gate G2、提交 → 双门 gate-check exit 0 且全量 294/294 → 开 S3 九节点与状态机。任何一份判 fail 都回到对应表逐条整改，不重签、不开 S3。

### 11.16 S1 第五轮 fail 与 S2 第九轮 pass（2026-11-13 20:50，HEAD f7ebe69 + 未提交 P1 修复）

S1 第五轮（docs/audits/S1-independent-audit-round5.md，492 行 / 33,493 字节）判 fail：P0=0 / P1=1 / P2=5。阻断项是 auditConclusionOf 对同一 canonical 结论行的阻塞 caveat 仍读成 pass，例如 `结论：pass — 但仍有 1 个 P0 未闭合`；克隆端到端 sign-gate 与 gate-check 都能 exit 0。P2：列表项/引用块里的“结论：fail”被忽略、同义写法不识别、围栏内 fail 被跳过、G-08 缺 503/warning、审计报告未绑定门与候选 HEAD（旧 round3 pass 报告可重签）。

S2 第九轮（docs/audits/S2-independent-audit-round9.md，27,906 字节）判 pass：P0=0 / P1=0 / P2=9。19 项必过与 19 份证据从 HEAD 按 LF 重算全对，ev-g2-15 重跑 2434 字节、sha256 一致；核心链路无阻断项。P2 未闭合：G2 定值表仍写配置键、lease_lost/action_timeout 缺执行期回归、跨重启未 close/reopen、前序链只比字符串、remember 别名顺序、围栏不配对、结论解析 fail-closed 过宽。

本轮 P1 修复（scripts/gate-check.ts）：verdict=pass 时检查结论 token 后的 tail；tail 出现未闭合/仍未/仍有/尚有/尚存/没闭合/阻塞即返回 null；去掉“0 致命/致命 0/无致命”后仍含致命返回 null；去掉“无 P0/P1”和 P0/P1 接 0 的写法后仍含 P0/P1 返回 null。tests/gate-check.spec.ts 补 7 条断言，覆盖破折号、括号、P0 未闭合、致命 1、P0=0/P1=0、无 P0/P1、仅 P2 遗留。

验收：tsc --noEmit exit 0；定向 5 例全过；全量 32 文件 / 295 例，285 passed / 10 failed，10 红全在 tests/gate-check.spec.ts，首因仍是 G1 audit_report_sha256 占位 0（待签），无新增缺陷。

下一步：提交 P1 修复 + 两份审计报告 → 因 gate-check 已改，S2 第九轮 pass 只作为历史结论，重新派 S1 第六轮（docs/audits/S1-independent-audit-round6.md）与 S2 第十轮（docs/audits/S2-independent-audit-round10.md）独立审计 → 两份 pass 后按 G1 audit_round=6 / G2 audit_round=10 重签、双门 exit 0、全量 295/295，再开 S3。任何一份 fail 都回表整改，不重签、不开 S3。

### 11.17 S2 第十轮 pass、S1 第六轮 fail 与解析器重写（2026-11-13 21:05）

S2 第十轮（docs/audits/S2-independent-audit-round10.md，219 行）判 pass：P0=0 / P1=0 / P2=10。19 项必过与 19 份证据从 HEAD 0919589 按 LF 重算全对；ev-g2-15 两次 2434 字节、sha256 一致；临时 clone 把 G2 改到 round10 后可 sign-gate exit 0、gate-check exit 0。P2 未闭合：action_timeout 配置未接生产、lease_lost/action_timeout 缺执行期回归、跨重启仍是同库 hydrate、前序链只比字符串、remember 别名先写后查、围栏只按行首翻转、结论解析误杀/漏杀、done 后不释放租约、acquireLease 不校验 attempt、traceBindingGate 不校 tool/commandHash。

S1 第六轮（docs/audits/S1-independent-audit-round6.md）判 fail：P0=0 / P1=1 / P2=6。P1-1 是 pass 结论后的破折号允许任意文本，阻塞词表缺重大/阻断/未收口/未解决；在克隆里“结论：pass — 重大 3”与“结论：pass（未收口）”都能让 sign-gate 与 gate-check exit 0（attack C artifact 373560a6bd64…，attack D artifact 929d83bfd289…）。P2：列表/引用/下一行结论、同义结论、围栏规则未入规范、G-08 缺 503/warning、审计报告未绑门与候选、正常清零写法被误杀。
### 11.33 S2 第三十五轮与 S1 第三十轮整改、双门重签（2026-11-14 10:50）

- 触发：S2 第三十五轮 fail（P0=0 / P1=1 / P2=1）。P1-1 是证据复现契约不成立：`scripts/fault-inject.ts` 八处 `leaseTtlMs: 600000` 与 `src/service/schemas.ts` 的 120000 上限冲突，重跑时节点卡在 queued，19 份 G2 证据只有 6 份能字节复现（ev-g2-09 直接 STALE_GENERATION）。P2-1 是正文与裁决的一致性检查可绕过（解析器返回 null 就整段跳过）。
- 整改：八处夹具改 120000；25 份证据（G1 六份 + G2 十九份）重生成；`writeEvidence` 路径归一变通用（临时目录前缀 → `<tmp>/<basename>`）；`normalizeEvidence` 把「线上库 sha <hex>」归一成 `<db_sha>`（sqlite 页布局带随机盐，只保留「线上库未变：true」的结论句）；新增 `scripts/check-evidence-repro.ts`（25 案例各跑两遍，比两遍之间与 HEAD 字节）与 `tests/integration/evidence-repro.spec.ts`；新增导出 `proseVerdictClashes(text, verdict, requiredItems)`，三类背离（结论行不唯一 / 结论行与裁决相反 / 必过项写成未通过）一律拒；`verdictProblems` 加「必过项总数等于门规格项数」与「不许重复 id」（S1 第三十轮 P2-2）；G-14 断言跟实际迁移表走（P2-3）。
- 候选：0e2274fff1a62ea0457cbeb804e2e887142af88e（提交标题 Fix evidence reproducibility and prose-verdict clashes），工作树干净。
- 双门独立审计都 pass：S1 第三十一轮 13/13、P0/P1/P2 = 0/0/4（`docs/audits/S1-independent-audit-round31.md`）；S2 第三十六轮 19/19、0/0/3（`docs/audits/S2-independent-audit-round36.md`）。两路都在干净克隆里走通 sign-gate exit 0 与 gate-check exit 0。
- 重签：G1 artifact audit_round=31 → artifact_hash=`53d08f5b856e…`、body_hash=`1c93f95e6e76…`；G2 audit_round=36 → artifact_hash=`0508d0949b06…`、body_hash=`d85d0826bced…`。两门 `gate-check` exit 0（13 项/13 份、19 项/19 份）。已推送 origin/main：f01581c..3205040。
- 验证（实测）：`tsc --noEmit` exit 0；全量 37 文件 **524 passed | 1 skipped**，跳过的是「门记录没签时必须被拒绝（预签态）」——签完就该跳过，设计使然；`check-evidence-repro` 输出「证据复现成立：25 份」exit 0。
- 审计留的待办（都不阻断签署，下一轮硬化一并收）：S2 第三十六轮 P2-1 是 `proseVerdictClashes` 只扫 prose、丢弃 `rendered.cells`，把判定写进 Markdown 表格单元仍能签过（A4/A5 实测放行），建议对 cells 调 `cellFailStatement` 并补回归；P2-2 告警文案未按结论分支；P2-3 `tests/integration/evidence-repro.spec.ts:8` 注释写「全量 35 份」实为 25 份。S1 第三十一轮的 P2-3 是 `candidateEntries` 对已删除路径刷 fatal 噪声（stderr 可见，不影响 exit code）。
- 状态：G1/G2 已重签并提交，双门 exit 0、全量绿，S3 九节点与状态机可以开；上述四条 P2 作为 S3 第一批硬化项，动手前先补回归。


本轮把 auditConclusionOf 从“tail 正则 + 阻塞词表”改成“唯一结论行 + 结构化尾巴”：
- 全文只接受一行结论；第二行无论同向反向都返回 null；行内引用不算结论；建议行不再当结论。
- 行首可带标题/列表/引用/加粗标记；同义结论支持判定/审计意见/最终判定/最终结论/结果，通过/不通过与 pass/fail 等价。
- 围栏按字符与长度配对，关闭围栏必须同字符且不短于开启围栏。
- 结论 token 后只接受空尾、句末标点、一个括号或一个破折号解释；括号/解释内只允许清零计数（P0=0、无 P0/P1、0 致命、P2 遗留 N 条），其余文字按未收口返回 null。fail 只要求尾巴里没有反向 pass。
- 规格 §11.3 补一条解析契约，写清围栏、唯一结论、建议行与清零计数规则。

tests/gate-check.spec.ts 新增 3 例、更新建议行断言，当前该文件 38 例；定向“审计报告结论”10 例全过，tsc exit 0。全量 32 文件 / 298 例，288 passed / 10 failed；10 红仍全在 tests/gate-check.spec.ts，首因 G1 audit_report_sha256 占位 0，属待签状态，不是新缺陷。

下一步：提交解析器、测试、规格与两份报告 → 因 gate-check 已改，S2 第十轮 pass 只算历史结论，重新派 S1 第七轮与 S2 第十一轮独立审计 → 两份 pass 后按 G1 audit_round=7 / G2 audit_round=11 重签、双门 exit 0、全量 298/298，再开 S3。任何一份 fail 都回表整改，不重签、不开 S3。

### 11.18 S2 第十一轮 fail：关闭围栏带信息串（2026-11-13 21:27）

S2 第十一轮（docs/audits/S2-independent-audit-round11.md，354 行）判 fail：P0=0 / P1=1 / P2=10。P1-1 在 scripts/gate-check.ts:498-503：关闭围栏只要求同字符且长度不短于开启，没要求 marker 后只能有空白；围栏内的 ```js 会被误当关闭围栏，真实结论 fail 的报告可被解析成 pass，临时 clone 里 sign-gate 与 G2 gate-check 都能 exit 0。19 项必过/19 证据/11 不变量、八个哈希、ev-g2-12..15 复跑均一致；测试 10 红仍只来自 G1 待签。

修复：fenceMatch 改为 /^\s*(`{3,}|~{3,})(.*)$/，只有同字符、长度不短于开启围栏、且 marker 后 rest.trim() 为空才关闭；带信息串的行在围栏内按内容跳过。tests/gate-check.spec.ts 新增“关闭围栏必须 marker 后只有空白”一例，覆盖 ` ``js 不关闭、正常关闭带尾随空格、围栏内 pass 不参与判定。

验收：解析器定向 11 例全过；tsc --noEmit exit 0；全量 32 文件 / 299 例，289 passed / 10 failed，10 红仍全在 tests/gate-check.spec.ts，首因 G1 audit_report_sha256=0，属待签。S1 第七轮因 HEAD 即将更新已中断，未出报告；它的审计对象 153353a 已过期。

下一步：提交围栏修复、测试与 S2 第十一轮报告 → 重新派 S1 第八轮（docs/audits/S1-independent-audit-round8.md）与 S2 第十二轮（docs/audits/S2-independent-audit-round12.md）独立审计 → 两份 pass 后按 G1 audit_round=8 / G2 audit_round=12 重签、双门 exit 0、全量 299/299，再开 S3。任何一份 fail 都回表整改，不重签、不开 S3。


### 11.19 S1 第九/十轮、S2 第十二/十三轮与“原始 HTML 一律拒绝”（2026-11-13 22:40，HEAD 9598462）

S1 第九轮（docs/audits/S1-independent-audit-round9.md）fail：P0=0 / P1=1 / P2=5。P1-1 是隐藏文本仍三种绕过：嵌套 details、引用块内四空格、空格+Tab 缩进；克隆里 sign-gate 与 gate-check 均可 exit 0。P2-1..P2-5 已复核：G-08 缺 503/warning 原文、写者锁无直接测试、events 表无 append-only 触发器、迁移缺号无测试、签后测试两例（CLI 围栏查找与 audit_round 自指）。

该轮 P2 全部闭合：scripts/fault-inject.ts 的 caseG08 增加 HTTP 队列满探针（第二笔 503 SERVICE_UNAVAILABLE + warn 原文）；tests/db-open.spec.ts 增加第二把写者锁 ELOCKED；新增 src/infra/sqlite/migrations/005_append_only_events.sql（events BEFORE UPDATE/DELETE RAISE(ABORT)），默认迁移变 [1,2,3,4,5]；src/infra/db/migrate.ts loadSteps 增加编号连续性校验（001+003 负例入 tests/migrate.spec.ts）；tests/gate-check.spec.ts 修 CRLF 与 audit_round+1 自指。提交 9a44739「Close hidden audit conclusions and migration gaps」，12 文件 +275/−29。

S1 第十轮（docs/audits/S1-independent-audit-round10.md）fail：P0=0 / P1=2 / P2=0。P1-1 行内代码/链接/缩进代码里的字面闭合标签让 details 提前闭合（scripts/gate-check.ts:637/:643-654）；P1-2 stripHiddenAuditBlocks 没清 <?...?>、<!DOCTYPE>、<![CDATA[[]]>，jsdom 下不可见但解析器仍把其中 pass 当顶层结论。第九轮三种基础绕过已闭合，绑定/祖先/candidate..HEAD diff/不变量固定口径均未被破坏。

S2 第十二轮（docs/audits/S2-independent-audit-round12.md）pass：P0=0 / P1=0 / P2=9。19 项/19 证据/58 候选；ev-g2-12..15 复跑字节与 sha256 全一致；模拟重签后 G2 gate-check exit 0。报告 19216 字节，sha256=23c569301794fbb76ec3fbef35146c4611790d9a8bc3e3798cba57465f5a05b2。

S2 第十三轮（docs/audits/S2-independent-audit-round13.md）fail：P0=0 / P1=1 / P2=9+新增 P2-10。P1-1 是 stripHiddenAuditBlocks 无条件剥掉整个 details/pre/script/style/template，不看 details open、不保留 summary；div hidden / style=display:none 也不识别。克隆中 details open 可见 fail + 块外可见 pass 仍被解析成 pass，sign-gate 与 gate-check 均 exit 0。P2-10：签后往 evidence 追加一行可绕过（docs/gates 在 spec.excludes 内，候选 diff 不覆盖证据）。

本轮定案：审计报告只接受纯 Markdown，不再猜 HTML 可见性。stripHiddenAuditBlocks 先掩码围栏代码、缩进代码、行内代码、链接目标与 title、HTML 注释、处理指令、CDATA、DOCTYPE；之后仍出现原始 HTML 起始标记就返回哨兵，结论解析为 null，sign-gate 在写盘前拒绝整份报告（fail-closed）。占位符应写反引号或 HTML 实体。

端到端攻击（临时 clone，已删除）：攻击报告可见正文写“本报告结论为不通过”，details open 内藏“结论：pass”，G1 指向它。sign-gate exit 1，错误原文“Error: 审计报告里找不到唯一结论行，不能拿它当门记录依据: docs/audits/S1-independent-audit-round11-attack.md”，G1 前后字节不变。阳性对照：同一 clone 换纯 Markdown pass 报告，sign-gate exit 0（artifact_hash=2eddede1c798…，body_hash=f742b9d513f9…，90 个候选文件），提交签后 G1 后 gate-check exit 0（13 项必过、13 份证据）。证明 fail-closed 不是把正常报告也一刀切。

验收（主仓库）：tsc --noEmit exit 0；全量 32 文件 / 308 例，297 passed / 11 failed；11 红全在 tests/gate-check.spec.ts，首因 G1 门记录 audit_report_sha256 仍为 64 个 0（预签态），无解析器回归。提交 9598462「Reject raw HTML in audit report conclusions」，4 文件 +597/−31，含 S1-round10 与 S2-round13 两份报告。

下一步：S1 第十一轮（docs/audits/S1-independent-audit-round11.md）与 S2 第十四轮（docs/audits/S2-independent-audit-round14.md）独立审计已派出（S1 7fd39d7a-ac2d-4987-ae37-4e2e449e565d、S2 713ecf5c-5e33-407a-ad68-8f16b6d328ad）。两份都 pass 后：提交两份报告 → 改 G1 audit_round=11 / audit_report=S1-independent-audit-round11.md，改 G2 audit_round=14 / audit_report=S2-independent-audit-round14.md，审计 sha 清零 → 提交 → sign-gate G1、提交 → sign-gate G2、提交 → 双门 gate-check exit 0 且全量 308/308 → 开 S3 九节点与状态机。任何一份 fail 都回表整改，不重签、不开 S3。


### 11.20 S1 第十一轮 fail：链接引用定义续行；证据纳入候选范围（2026-11-13 22:46，HEAD 0297b77）

S1 第十一轮（docs/audits/S1-independent-audit-round11.md，sha256=2e43ca1a…）fail：P0=0 / P1=1 / P2=1。P1 是链接引用定义续行：CommonMark 允许 `[x]:` 的目标写在下一行，旧 maskAuditLinkDestinations 只抹定义行，下一行的“结论：pass”被 markdown-it / python-markdown 整体隐藏，但解析器仍读成唯一结论。克隆里 sign-gate 与 gate-check 均 exit 0（artifact_hash=825e642d…）。P2 是证据文件签后追加一行再重签仍能过（与 S2 第十三轮 P2-10 同根因）。同轮复核：12 种原始 HTML/可见性绕过全部 exit 1；阳性对照 pass；绑定与不变量固定口径有效。

修复（scripts/gate-check.ts）：
- maskAuditLinkDestinations 改为逐行处理引用定义；定义行冒号后为空时，连带掩码下一行目标，再下一行若是引号/括号 title 一并掩码；目标同行但 title 换行的也掩码 title 行。
- GATE_SPECS 的 excludes 从 `docs/gates` 改为只排除 `docs/gates/G1.md` 与 `docs/gates/G2.md`；docs/gates/evidence/** 进入候选范围。证据签后改动会使 diff 非空，checkAuditAnchor 以“候选提交之后，候选文件又被改过”拒绝复用旧报告。
- tests/gate-check.spec.ts 新增 2 例：引用定义续行隐藏 pass 必须为 null；临时 git 仓库中证据文件进入候选、门记录自身不进入。gate-check.spec 现 47 例。

端到端验证（临时 clone，已删除）：
- 攻击报告 `[x]:` 换行藏“结论：pass”，G1 指向它：sign-gate exit 1，错误“审计报告里找不到唯一结论行”，G1 前后字节不变。
- 阳性对照：纯 Markdown pass 报告签过，artifact_hash=a01fcb5138d9…、body_hash=1642c2c9e449…、候选 115 个文件，提交签后 G1 后 gate-check exit 0。
- 签后往 docs/gates/evidence/G1/G-01.md 追加一行并提交，再 sign-gate：exit 1，错误“审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：docs/gates/evidence/G1/G-01.md”。

提交 0297b77「Mask multiline link definitions and bind evidence into candidate scope」，3 文件 +196/−6（含 S1 第十一轮报告）。tsc --noEmit exit 0；全量 32 文件 / 310 例，299 passed / 11 failed，11 红仍全在 tests/gate-check.spec.ts 的预签态（G1 audit_report_sha256=0*64），无新增回归。

下一步：S1 第十二轮（docs/audits/S1-independent-audit-round12.md）与 S2 第十五轮（docs/audits/S2-independent-audit-round15.md）独立审计已按 HEAD 0297b77 派出（S1 04fc20e1-1975-4f54-bd76-647fd2b3a1c7、S2 dd007ad7-764a-4247-bd44-cb8519a09071）；S2 第十四轮因 HEAD 已变而中断。两份都 pass 后：提交报告 → 改 G1 audit_round=12 / audit_report=S1-independent-audit-round12.md，G2 audit_round=15 / audit_report=S2-independent-audit-round15.md，审计 sha 清零 → 提交 → sign-gate G1、提交 → sign-gate G2、提交 → 双门 gate-check exit 0 且全量 310/310 → 开 S3。任何一份 fail 都回表整改，不重签、不开 S3。

### 11.21 S2 第二十三轮与 S1 第十九轮整改：证据终态、服务端时钟、可见否定句（2026-11-14 01:50，HEAD 53495fc）

S2 第二十三轮（`docs/audits/S2-independent-audit-round23.md`，288 行，判 fail：P0=4 / P1=1）与 S1 第十九轮（`docs/audits/S1-independent-audit-round19.md`，判 fail：P0=4）同批整改，提交 `53495fc`。

S2 侧：
- P0-1 解析器认裸「审计」、连接号/破折号、英文否定句；英文判定改跑原始行，避免压缩空白后失去词边界。
- P0-2 `traceBindingGate` 查同一 attempt 全部工具行，任一行失败即 `tool_execution_failed`，不再用 `some` 挑一条成功行。
- P0-3 新增 `ServerDeps.now`；`/lease`、`/renew`、`/report`、`/run`、`/cancel` 全部用服务端 `requestNow`，请求体 `now` 不再参与租约判定。
- P0-4 `requiredHashes` 必须是 64 位 hex；证据必须带 `tool`、`commandHash`、`producedAt`，并与 `tool_executions`、`tool_finished` 同 attempt 全等。
- P1-1 `failed`/`timeout` 终态也走 `terminalEvidenceGate`，无证据不许收口。

S1 侧：
- P0-1 `auditConclusionOf` 的邻行拼接改为最多四行的滑动窗口，堵「本报告不 / 通 / 过」。
- P0-2 图片 alt 先用 `markdown-it` 的 `unescapeAll` 解实体，再判可见否定句。
- P0-3 否定句尾部字符类补齐 ASCII/弯/全角/法文引号。
- P0-4 `bodyConclusionOf` 同样做多行滑动窗口，门记录正文与审计报告同一口径。

验收（实测）：`tsc --noEmit` exit 0；全量 32 文件 / 340 例，329 passed / 11 failed；11 红全部是 G1 预签态（`audit_report_sha256=0*64` 对实际 `50ba1b13cdf1b84d…`），无新增回归。`tests/gate-check.spec.ts` 71 例，60 passed / 11 failed；新增 S1 第十九轮两条回归用例只读运行 3 passed / 68 skipped。

对照表：`docs/audits/S2-round23-response.md`、`docs/audits/S1-round19-response.md`。

下一步：按当前 HEAD（整改提交 `53495fc`）重派 S1 第二十轮与 S2 第二十四轮独立审计；两份都 pass 后按既有顺序重签 G1/G2、双门 gate-check exit 0、全量 340/340，再开 S3 九节点与状态机。任何一份 fail 都回表整改，不重签、不开 S3。

### 11.22 S2 第二十四轮与 S1 第二十轮整改：折叠判定器、正文全扫描、证据绑定（2026-11-14 02:20，代码提交 24ffd47）

S2 第二十四轮（`docs/audits/S2-independent-audit-round24.md`，判 fail：P0=1 / P1=2）与 S1 第二十轮（`docs/audits/S1-independent-audit-round20.md`，判 fail：P0=4 / P1=2 / P2=1）同批整改，代码提交 `24ffd47`「Reject hidden audit negatives and bind evidence hashes」，8 文件 +804/−99。

解析器（`scripts/gate-check.ts:637-751`）：
- 删除旧 `FAIL_SUBJECT/FAIL_VERDICT` 与窗口扫描，改为 `foldForVerdict` 全文折叠：NFKC、小写、删撇号、丢弃 Cf/Mn/Me、空白与标点统一映射 `|`；主语/连接词/结论词之间允许任意 `|`，五行拆词、零宽、组合符、引号夹层、U+2011/U+2010/U+2012/U+2043 都能连回。
- `FAIL_SUBJECTS` 增补繁體与「审计报告/审计意见/最终结论」等；`FAIL_VERDICTS` 增补「失败/未成功/未过关/不批准」及英文 fail/failed/failure/not pass/didnt pass 等。
- 图片 alt 先剥标签、`unescapeAll`、`normalizeAuditLine` 再进同一扫描器；`auditConclusionOf` 与 `bodyConclusionOf` 改为全文扫一次，正文不再有 24 字偏移/160 字长度窗口。
- 安全句 `本报告不通过项已全部修复` 等仍 pass；正文裸「结论」不作为默认主语，`门记录拿结论为 fail` 不误杀。

证据门：
- `src/core/policy.ts:16-58`：`evaluateEvidence` 增 `EvidenceGateOptions.trustedHashes`，requiredHashes 的值必须 64-hex 且落在服务端可重算集合内，否则 `verification_too_weak`。
- `src/service/commands/apply-report.ts:245-275`：trusted 集合 = `sha256Hex(canonicalJson(report.output ?? null))` + 匹配工具行的 stdout/stderr/command 哈希。
- `apply-report.ts:345-397`：删除 `terminalEvidenceGate`；`traceBindingGate` 增 `{ allowFailed }`。done 时同 attempt 任一失败行即 `tool_execution_failed`；failed/timeout 允许失败行，但证据必须与某一行及 `tool_finished` 全等。

实测：`tsc --noEmit` exit 0；`tests/policy.spec.ts` + `tests/apply-report.spec.ts` 47 例全过；`tests/gate-check.spec.ts` 74 例 63 passed / 11 failed；全量 32 文件 / 348 例，337 passed / 11 failed。11 红全部是 G1 预签态（`audit_report_sha256=0*64` 对 `50ba1b13cdf1b84d…`），无新增回归。S1 r20 的 21 个载荷、S2 r24 的 36 个载荷在落盘代码上全部 REJECT。

对照表：`docs/audits/S2-round24-response.md`、`docs/audits/S1-round20-response.md`。

下一步：提交本段与两份对照表，按最终 HEAD 重派 S1 第二十一轮与 S2 第二十五轮独立审计；两份都 pass 后按既有顺序重签 G1/G2、双门 gate-check exit 0、全量 348/348，再开 S3 九节点与状态机。任何一份 fail 都回表整改，不重签、不开 S3。



### 11.23 S1 第二十一轮与 S2 第二十五轮整改、e2e 与提交 c818778（2026-11-14 02:50）

S1 第二十一轮（`docs/audits/S1-independent-audit-round21.md`，绑 G1 / 6cb95b3，判 fail：P0 六类 / P1 一类 / P2 两项）与 S2 第二十五轮（`docs/audits/S2-independent-audit-round25.md`，绑 6cb95b3，判 fail：P0=2 / P1=3 / P2=1）同批整改，提交 `c818778`「Close S1 round21 and S2 round25 audit bypasses」，14 文件 +768/−52。

解析器（`scripts/gate-check.ts`）：
- `FAIL_VERDICTS` 补英文缩写否定（doesnt/wont/hasnt/havent/isnt/wasnt）、not passing、繁體未通過驗收/不通過驗收/未通過評審/未通過審核/被駁回/被否決；`FAIL_NEGATIONS` 补 does not/will not/have not 等；`FAIL_PASS_STEMS`/`FAIL_OBJECTS` 补繁體词与验收/标准/审批/评审/审核。
- `matchPrefix` 先跳过前导 `|` 再匹配，修 `is|not|passing` 被词间夹层打断；连接词循环改为 `for (let guard = 0; guard <= folded.length; guard += 1)` 且每次必须前进，重复“的/was”不再受 8 次上限。
- `foldForVerdict` 按字符遍历：汉字之间夹一个 Latin/Cyrillic/Greek 字母时跳过该字母（`未通о过`→`未通过`）；西里尔/希腊同形字经 `HOMOGLYPHS` 归一。
- 新增 `HISTORICAL_REMEDIATION_RES` 与 `stripHistoricalRemediation`：只在可见文本里剔除“上一轮/前一轮/roundN … 本轮已整改/已修复/已收口”这一小段；历史句后另起本轮否定仍会被抓。`bodyConclusionOf` 与报告共用同一扫描器。

证据门（`src/core/policy.ts`、`src/service/commands/apply-report.ts`）：
- `requiredHashes` 改为按 key 绑定 output：每个 required key 必须 64-hex，且等于 `sha256Hex(canonicalJson(output[key] ?? null))`；命令哈希/stdout/整个 output 摘要不能冒充，两个 key 不得共用同一哈希。
- failed/timeout 走 `traceBindingGate({ allowFailed: true, requireFailure: report.status === 'failed' })`：同 attempt 有失败行时成功证据不能覆盖；failed 状态必须有 exit_code≠0 的行，否则 `tool_execution_failed`。
- `scripts/fault-inject.ts` 的 `normalizeEvidence` 把 ISO-8601 时间戳统一为 `<ts>`，ev-g2-14/15 两次重跑 sha256 稳定为 `4e0776e9…` / `7648abe9…`，G2 正文表与 JSON 锚同步。

验收（实测）：
- `tsc --noEmit` exit 0。
- 全量 vitest 32 文件 / 359 例，348 passed / 11 failed；11 红全在 `tests/gate-check.spec.ts` 且全为 G1 预签态（`audit_report_sha256=0*64` 对 `50ba1b13cdf1b84d…`），无新增回归。
- `tests/gate-check.spec.ts` 77 例，66 passed / 11 failed；新增 S1 r21 用例覆盖 16 条 P0 全拒、4 条历史/清零安全句全过、历史句后追加 `本报告不通过。` 仍拒；门正文补繁體与英文缩写否定。
- 证据门定向：policy + apply-report 55 例全过；覆盖 requiredHashes 阳性、命令哈希冒充、缺键、双 key 同哈希、failed 仅成功行、failed/timeout 同 attempt 另有失败行。

端到端（临时 clone `D:/aboutAI/_g1audit-c818778/clone`，HEAD c818778，门 G1 改 audit_round=21 并指向 S1 r21 报告；`node_modules` 用目录联接挂入）：
- 24 例：18 条拒绝、6 条签过；18 条拒绝全部 `g1same=true`（门字节未变），6 条签过全部 `sign-gate exit 0` 且 `gate-check exit 0`。
- 16 条 S1 r21 P0（含繁體、缩写、not approved、被驳回/否决、同形字插入、重复连接词）全部 `sign=1`，错误为“审计报告里找不到唯一结论行”或“门记录正文结论与 GateArtifact 不符”。
- 3 条报告历史叙述 + 1 条清零安全句 `sign=0`；门正文历史句 `sign=0`；门正文“历史句 + 本次审计无法通过” `sign=1`。
- 阳性对照 `sign=0`、`gate-check exit 0`（artifact_hash=`079efbc3abca…`、body_hash=`78eba2e0b19a…`，13 项必过 / 13 份证据）。

对照表：`docs/audits/S1-round21-response.md`、`docs/audits/S2-round25-response.md`。S1 r21 P2-1 是 G1 未签态哈希，留待重签；P2-2 的 11 例预签态噪声本段保留并在计数单列。

下一步：按 HEAD c818778 重派 S1 第二十二轮与 S2 第二十六轮独立审计；两份都 pass 后按既有顺序重签 G1/G2、双门 gate-check exit 0、全量 359/359，再开 S3 九节点与状态机。任何一份 fail 都回表整改，不重签、不开 S3。

### 11.24 S2 第二十六轮整改（2026-11-14 03:20）

S2 第二十六轮（`docs/audits/S2-independent-audit-round26.md`，绑 G2 / ca2b196，判 fail：P0=2 / P1=1 / P2=3）整改完成，对照表 `docs/audits/S2-round26-response.md`。

- P0-1/P0-2：`scripts/gate-check.ts` 的主语、连接词与裁决词表补裸 `否决/驳回/拒绝/反对/未采纳/拒收/不接收`、繁體 `否決/駁回/拒絕/反對/未採納`、`結論` 与 `為`；报告与门正文共用同一扫描器，`結論：fail` 读成 fail，10 条审计载荷不再读到 pass。回归在 `tests/gate-check.spec.ts`。
- P1-1：`scripts/fault-inject.ts:70-73` 把 JSON 里的 `"revision":<数字>` 归一为 `"revision":<n>`；ev-g2-14 顺序两次、四路并发四次 sha256 全为 `12e34ba8fd59c17322b364a122a5f265af87d353e10a13b6b4328049ceb6b39f`；`docs/gates/G2.md:83` 与 `:386` 同步。
- P2-1/P2-2：`src/core/policy.ts:52-72` 拒绝 null/undefined 产物；每个 required key 的产物摘要必须唯一，共用同一份内容返回 verification_too_weak。回归在 `tests/apply-report.spec.ts`。
- 验证：`tsc --noEmit` exit 0；定向 135 例 124 passed / 11 failed；全量 32 文件 / 362 例 351 passed / 11 failed；11 红全部是 G1 预签态（`audit_report_sha256=0*64`），无新增回归。
- 状态：未提交、未重签、未派新审计；S1 第二十二轮仍在跑。两份 pass 后重签 G1/G2、双门 exit 0、全量全绿，再开 S3。


### 11.25 S1 第二十二轮整改与提交 4f63116（2026-11-14 03:32）

S1 第二十二轮（`docs/audits/S1-independent-audit-round22.md`，绑 G1 / ca2b196，判 fail：P0=4 / P1=1 / P2=2；报告 LF sha256=`3bf8f7f1e643e778da6d64228085aadcd13a7ec0b5b44a67bff0a640bcda282b`）整改完成并提交 `4f63116`「Close S1 round22 historical swallow and approval negations」，4 文件 +645/−5。

- P0-1/P0-2：`scripts/gate-check.ts:865-890` 的 `stripHistoricalRemediation` 改为只截掉历史否定本身（`HISTORICAL_NEG_RE` 命中位置之后全部保留），不再整段删除；`:940-958` 的 `bodyConclusionOf` 对含正式 `结论：/結論：/判定：` 的行补一次 `visibleFailStatement`。19 条载荷中 7 条报告正文与 2 条门正文全部拒绝。
- P0-3/P0-4/P1：`:637-652` 补裸主语 `本轮/本輪`；`:654-687` 补 `not approving`、`approval was not granted`、`未获批/没获批/未被批准/未准予通过/不准予通过`、`未整改/未完成整改/未修复/未收口`；`FAIL_CONNECTORS` 补 `approval`，填充词补 `准予/被`，谓词补 `approving/granted/granting/采纳`。
- 回归：`tests/gate-check.spec.ts:346-374` 覆盖报告 17 条与门正文 2 条；历史安全句 `历史记录：上一轮审计未通过，本轮已整改。`、`round20 审计结论为 fail，本轮已整改。` 仍为 pass。
- 验收（实测）：定向用例 1 passed / 78 skipped；`tests/gate-check.spec.ts` 79 例 68 passed / 11 failed（11 红全为 G1 预签态）；`tsc --noEmit` exit 0；全量 32 文件 / 363 例，352 passed / 11 failed。
- 对照表：`docs/audits/S1-round22-response.md`。P2-1 预签基线、P2-2 11 例预签噪声均留到重签时收口；本报告固定审计 ca2b196，不覆盖 4f63116 与工作区修复。
- 状态：S2 第二十七轮仍在 e7a3fa4 上运行；未重签、未开 S3。下一步收 S2 r27 报告，与 S1 r22 一并判读后重派 S1 r23 / S2 r28；两份 pass 后重签 G1/G2、双门 exit 0、全量全绿，再开 S3。

### 11.26 S2 第二十七、二十八轮整改与提交 b92e849（2026-11-14 03:56）

S2 第二十七轮（`docs/audits/S2-independent-audit-round27.md`，绑 G2 / e7a3fa4，fail：P0=2 / P1=0 / P2=3）与第二十八轮（`docs/audits/S2-independent-audit-round28.md`，绑 G2 / d1dfe12，fail：P0=2 / P1=0 / P2=2）合并整改，提交 `b92e849`「Close S2 round27 and round28 verdict parsing gaps」，10 文件 +761/−25。对照表 `docs/audits/S2-round27-response.md`、`docs/audits/S2-round28-response.md`（均随提交入库）。

- 结论解析：`scripts/gate-check.ts` 的裁决词表补 `未通过收口/未过/否/unapproved/disapproved/unaccepted/nonapproved/failing/rejects/denies/refuses/declines/vetoes` 与部分通过、待整改、暂缓、否定等同义族；谓词补 `认同/赞同/受理/接收/接受/acceptable`；宾语补 `本报告/本次审计/审计组/报告`；主语补 `审计组/报告/approval/gate/report`；HOMOGLYPHS 补无点 `ı`。
- 结构：裁决词命中后先消费可选宾语再判句尾；结构否定每层先试谓词再吃填充词，`not acceptable` 不再被 `a` 挡掉。
- 英文结论行：`Conclusion/Verdict/Outcome/Result` 加冒号或破折号后紧跟 pass/fail 才算正式结论；正文里的普通 Conclusion 叙述仍忽略；正文结论写 pass、同行尾巴再写 fail 的一律按 fail 收口。
- 证据门：`src/service/commands/apply-report.ts:233` 失败与超时统一 `requireFailure: true`；`src/core/workflow-def.ts:42-60` 新增 `assertNoDuplicateRequiredHashes`，模板层与节点层重复必留哈希键在加载期抛 `WORKFLOW_VALIDATION_FAILED`。
- 回归：`tests/gate-check.spec.ts:376-415` 覆盖 r27/r28 全部载荷与同族 9 条；`tests/apply-report.spec.ts:511/:522`；`tests/workflows.spec.ts:57`。
- 验证（实测）：`tsc --noEmit` exit 0；`tests/gate-check.spec.ts` 81 例 70 passed / 11 failed；全量 32 文件 / 367 例，356 passed / 11 failed；11 红全部是 G1 预签态（`audit_report_sha256=0*64`），无新增回归。
- 已派 S1 第二十四轮（`a5a88da0-5e4f-4bd4-9d9b-bfa0ea2260fe`）与 S2 第二十九轮（`7c43a174-289b-49bc-b70d-f34a092d639e`），都绑 b92e849，只读、临时克隆内攻击、不签门不提交。
- 状态：G1/G2 未重签，S3 九节点与状态机继续冻结。旧 S1 第二十三轮仍在跑，只作参考；以 S1 r24 与 S2 r29 为准，两份都 pass 后才重签 G1/G2、双门 exit 0、全量全绿，再开 S3。

### 11.27 S2 第二十九、三十轮与 S1 第二十三、二十四轮整改（2026-11-14 04:50，HEAD 998c89b）

- S2 第二十九轮（推荐/采信否定族）提交 `a0b5597`「Close S2 round29 recommendation negations」，对照表 `docs/audits/S2-round29-response.md`。
- S1 第二十三轮（历史通过锚、裁决宾语、副词前缀）提交 `a725238`「Close S1 round23 history-anchor and object gaps」，对照表 `docs/audits/S1-round23-response.md`。
- S1 第二十四轮（放行/clear/fit/release 同义否定）提交 `998c89b`「Close S1 round24 release and gate-body negations」，对照表 `docs/audits/S1-round24-response.md`。
- S2 第三十轮（`docs/audits/S2-independent-audit-round30.md`，绑 G2 / 998c89b，fail：P0=8 / P1=0 / P2=1）整改中：`scripts/gate-check.ts` 的 FAIL_CONNECTORS 补语气副词与并列连接，FAIL_SUBJECTS 补整改/修复，FAIL_VERDICTS 补不予准入/不予采信并退回，FAIL_PASS_STEMS 补准入，FAIL_OBJECTS 补准入条件与报告，FAIL_FILLERS 补 consider/deem/regard/report，填充循环上限由 2 提到 6；入口新增 hiddenDefinitionFailure，引用定义里的隐藏否决按歧义拒绝。对照表 `docs/audits/S2-round30-response.md`。
- 验证（实测）：`tsc --noEmit` exit 0；`tests/gate-check.spec.ts` 84 例 73 passed / 11 failed；全量 32 文件 / 370 例 359 passed / 11 failed；11 红全部是 G1 预签态（audit_report_sha256=0*64）。新增「S2 第三十轮 P0/P2」用例单独运行 1 passed / 83 skipped。
- 状态：S1 第二十五轮（a78007f4）仍在 998c89b 上运行，只作参考；S2 第三十轮已结束。本对照表提交后在新候选上重派 S1 与 S2 独立审计；两份都 pass 后才重签 G1/G2、双门 exit 0、全量全绿，再开 S3。当前未签门、未开 S3。

### 11.28 S1 第二十五、二十六轮与 S2 第三十一轮整改（2026-11-14 05:20，候选 e717293）

- S2 第三十轮整改提交 `e717293`「Close S2 round30 modality and hidden definition gaps」，5 文件 +410/−3，含对照表 `docs/audits/S2-round30-response.md`。
- S1 第二十五轮（`docs/audits/S1-independent-audit-round25.md`，绑 G1 / 998c89b，fail：P0=3 / P1=2 / P2=2）十条可见否定整改：FAIL_CONNECTORS 补验收/复核/评审/审核、被、目前、尚、完成度、进度、in；FAIL_VERDICTS 补不足/未完成/未收口；FAIL_OBJECTS 补放行条件。对照表 `docs/audits/S1-round25-response.md`。
- S1 第二十六轮（`docs/audits/S1-independent-audit-round26.md`，绑 G1 / e717293，fail：P0=8 / P1=2 / P2=2）整改：新增分句尾部否定（`scripts/gate-check.ts:969`），按标点拆句，只要分句以“否定词 + 填充词 + 谓词 + 宾语”收口即判否决，不再依赖主语后连接词穷举；FAIL_FILLERS 补作为/完全/彻底，FAIL_PASS_STEMS 补具备，FAIL_OBJECTS 补依据/整改/the gate，FAIL_CONNECTORS 补 generally speaking 系列英文插入语。对照表 `docs/audits/S1-round26-response.md`。
- S2 第三十一轮（`docs/audits/S2-independent-audit-round31.md`，绑 G2 / e717293，fail：P0=4 组 / P1=1 / P2=2）整改：post-pass 尾巴与门正文“失败项为空，准入条件尚未满足”由同一分句扫描收口；程度否定补完全/彻底/还没有；`hiddenDefinitionFailure`（`scripts/gate-check.ts:1035`）改为定义起始行后三行内非空内容全部扫描，支持无缩进 dest/title、块引用续行与 HTML 实体解码；门正文引用定义入口同步返回 fail。对照表 `docs/audits/S2-round31-response.md`。
- 回归：`tests/gate-check.spec.ts` 新增「S1 第二十六轮 P0」与「S2 第三十一轮 P0」两组用例。
- 验证（实测）：`tsc --noEmit` exit 0；全量 33 文件 / 374 例，362 passed / 12 failed；12 红 = 11 个 G1 预签态（audit_report_sha256=0*64）+ 1 个 body_hash 顺序用例被更早的报告锚点校验挡在前面，均非解析器回归。
- 状态：G1/G2 未重签，S3 冻结。本段整改与三份报告/对照表提交后，在新候选上重派 S1 与 S2 独立审计；两份都 pass 后才重签 G1/G2、双门 exit 0、全量全绿，再开 S3。

### 11.29 S1 第二十七轮与 S2 第三十二轮整改（2026-11-14 06:40，HEAD ec89aec）

- S1 第二十七轮（`docs/audits/S1-independent-audit-round27.md`，绑 G1 / 98032b0，fail：P0=3 / P1=2 / P2=2）与 S2 第三十二轮（`docs/audits/S2-independent-audit-round32.md`，绑 G2 / 98032b0，fail：P0=2 / P1=1 / P2=1）合并整改，提交 `ec89aec`「Close S1 round27 and S2 round32 conclusion gaps」，6 文件 +643/−25。对照表 `docs/audits/S1-round27-response.md`、`docs/audits/S2-round32-response.md` 随提交入库。
- 结论解析：`scripts/gate-check.ts:874-906` 补分句尾裸裁决词与计数语义（N 项中 M 项通过、只完成 80%、尚差 N 项、原则上/基本上有 N 项待补）；FAIL_FILLERS 补 全部/均/都/逐一/逐项/取得/地，FAIL_PASS_STEMS 补 收口/到位/开始/做完/闭环/整改，FAIL_OBJECTS 补 收口/检查/全部准入条件。S1 第二十七轮 18 条“通过但未完成”原文逐条进回归。
- 门正文：`bodyConclusionOf` 的 pass 分支改走 `validConclusionTail`（`scripts/gate-check.ts:1175-1191`），B-06/B-07 门头括号内否定、S2 B1/B2 括号与逗号尾巴全部返回 fail。
- 引用定义：`hiddenDefinitionFailure`（`:1107-1121`）改为整块扫到空行，支持五层块引用/列表嵌套、跨行标签、定义标题第 5 行以后；实体改用 markdown-it `unescapeAll`；定义块同时出现判定词与 pass/fail 直接拒绝，覆盖 `&period;`。
- G2 历史叙述：新增 `stripHistoricalAuditSentence`（`:1055-1063`），只剥“第 N 轮 / round N … 不通过”历史句；直接探针 `bodyConclusionOf(docs/gates/G2.md) = pass`，P1-1 假阳性关闭。
- 回归与验证（实测）：`tsc --noEmit` exit 0；全量 33 文件 / 436 例，425 passed / 11 failed；11 红全部是 G1 预签态 `audit_report_sha256=0*64 != 50ba1b13cdf1b84d…`，无新增回归。新增 62 例：S1 r27 与 S2 r32 载荷组。
- 已派 S1 第二十八轮（`e9f5865b-b1e1-4311-9043-b7dbacc8ccf6`）与 S2 第三十三轮（`20c8fe7f-701b-49c3-afb0-a3ee96af9373`），都绑 ec89aec，只读、临时克隆内攻击、不签主仓门、不开 S3。
- 状态：G1/G2 未重签，S3 九节点与状态机继续冻结。两份新审计都 pass 后才重签 G1/G2、双门 exit 0、全量全绿，再开 S3；任何一份 fail 都回表整改。

### 11.30 S1 第二十八轮与 S2 第三十三轮整改（2026-11-14 07:15，候选 4f87642）

- S1 第二十八轮（`docs/audits/S1-independent-audit-round28.md`，绑 G1 / 4f87642，fail：P0=4 / P1=2 / P2=2）与 S2 第三十三轮（`docs/audits/S2-independent-audit-round33.md`，绑 G2 / 4f87642，fail：P0=5 / P1=0 / P2=2）合并整改。
- 结论解析：`scripts/gate-check.ts` 的 FAIL_FILLERS 补 顺利/正式/全面/整体/一次性/本次/当次，FAIL_OBJECTS 补 本次验收/当次复核检查，FAIL_PASS_STEMS 补 解决/关闭/清零/处理/消除/验收/复核/覆盖/核实/完善/落实/销项；countingFailure 补 N/M 比例、分项通过、未通过 N 项、完成一半、百分之八十、通过率不足，并让 N 项中 M 项通过支持 必过/均/全部/里；BARE_TAIL 与待办分支补 待办/待改进。
- 隐藏定义：`stripDefinitionContainers` 去掉固定 5 层上限，六层引用/列表定义同样进入 hiddenDefinitionFailure。
- 历史叙述：`HISTORICAL_AUDIT_SENTENCE_RE` 只在同句带明确整改说明时剥离，无整改说明的“第 N 轮……不通过”不再当历史；报告侧与门正文共用该剥离。
- 回归：`tests/gate-check.spec.ts` 新增 S1 第二十八轮 54 条与 S2 第三十三轮 52 条正式用例，共 2 个 `it`，载荷逐条断言 null/fail，合法 P2 遗留与清零正控保持 pass。
- 验证（实测）：`tsc --noEmit` exit 0；`tests/gate-check.spec.ts` 151 例，137 passed / 14 failed；全量 33 文件 / 438 例，424 passed / 14 failed；14 红全部是 G1 预签态 `audit_report_sha256=0*64 != 50ba1b13cdf1b84d…`，不是解析器回归。
- 仍留 P2：required_hashes 空清单放行、报告与门/证据只有词法校验、“第 33 轮”带空格的历史叙述误判；均记 S3 前置项，不阻断本轮。
- 状态：G1/G2 未重签，S3 九节点与状态机继续冻结。本段整改与两份报告/对照表提交后，在新候选上重派 S1 与 S2 独立审计；两份都 pass 后才重签 G1/G2、双门 exit 0、全量全绿，再开 S3。

### 11.31 外部评审第一批六项落地、测试分层与门预签态口径（2026-11-14 09:30）

- 触发：2026-11-13 外部架构评审《第二次意见》（已归档为 `docs/reviews/2026-11-13-second-opinion.md`），逐条处置对照表 `docs/reviews/2026-11-13-second-opinion-response.md`。
- 第一批六项落地：
  - 结构化审计裁决：新增 `src/core/audit-verdict.ts`（`AUDIT_VERDICT_SCHEMA` / `parseAuditVerdict` / `validateAuditVerdict` / `verdictProblems`），`scripts/gate-check.ts` 以裁决块为放行权威（`GateSpec.requireVerdict`，G1、G2 都要求），词法解析降为第二道防线；`tests/unit/audit-verdict.spec.ts` 新增。
  - 工具执行唯一性：迁移 `006_tool_executions_tool_seq.sql`（`tool_executions` 主键 `node_run_id+attempt+tool_seq`，`execution_id NOT NULL UNIQUE`）；`src/executor/run-node.ts` 每次执行给 tool_seq 与 execution_id 并绑进 tool_started/tool_finished 事件；`src/service/commands/apply-report.ts` 按 execution_id 核对痕迹行与事件。
  - 目录不可变：`src/core/freeze.ts` 的 `deepFreeze`；`src/service/workflows.ts` 的 `get()` 返深拷贝、先落库再进内存（落库失败不留残影）；三条测试在 `tests/integration/workflows.spec.ts:87/103/114`。
  - HTTP Schema：`src/service/schemas.ts`（Zod + `LIMITS`：租约 TTL 与续租间隔、工具超时、节点数、必留哈希数、attempt 范围、长度上限），`src/service/server.ts` 九条路由统一 `parseBody`。
  - 并发控制：`src/service/execution-scheduler.ts`（默认并发 3、人工名额 1，接 `orchestra.config.json` 的 `concurrency` / `human_slots`）；`src/service/server.ts` 的 `/v1/runs/dispatch` 与 `/v1/node-runs/run` 两个长任务路由不再占写队列名额，续租不再被排队饿死。
  - node_run_events 只追加：迁移 `007_node_run_events_append_only.sql` + `src/service/queries/verify_ledger.ts` 的链头核对（条数、链尾 seq、链尾 hash）。
- 预签态口径（重要，接手先读）：门记录只能签在「最终候选提交上的那一轮独立审计」的报告上，审计之前门记录必然处于预签态（`audit_report_sha256` 是占位值），任何校验都先撞审计锚点检查。`tests/gate/gate-check.spec.ts` 引入 `PRE_SIGNED` 与 `expectRejected()`：预签态下断言「必须被拒」，门重签后自动恢复成「指名是哪一道检查拦下」；另有 `it.skipIf(!PRE_SIGNED)('门记录没签时必须被拒绝（预签态：签门前一律不放行）')` 记录这条口径。
- 门解析器 F4：`scripts/gate-check.ts` 把表格单元格按语义分层（`AuditCell`、结论列判定 `VERDICT_COLUMN_RE`、强/弱失败词表），散文与单元格分开扫；`tests/gate/gate-check.spec.ts` 新增 5 条用例（状态列 blocked_post / decision_required / passed 不误伤；结论列写「不通过」仍拦；状态列整格 blocked 仍拦；正文「本报告不通过。」仍拦）。
- 测试分层：`tests/*.spec.ts` 26 个迁进 `tests/unit|contract|integration|e2e|gate`；断言改动态（迁移条数取 `loadSteps(defaultMigrationsDir())`、表清单取实际）；新增 `tests/README.md` 与 `docs/agents/testing-conventions.md`；`scripts/check-test-layout.mjs` 语法错已修（根因是 `.replace(/\/g, '/')` 这个非法字面量，正确写法是 `/\//g`）。
- 验证（实测）：`tsc --noEmit` exit 0；`pnpm check` 全量 36 文件 / 512 例，511 passed / 1 skipped（跳过的 1 条是预签态下的「G1 门记录通过」）；tsdown 构建通过。
- 仍留（已写进对照表，不含糊）：Bridge 生产接线、事件 ACK 与断号重取、Agent 生命周期、DAG 依赖调度、Run 级聚合 → S3 第二批；「心跳时数据库不可用」故障注入用例 → S3 故障注入批次；workflow_id+version、Decision/Inbox、Compensation、压测与 UI → S4–S6。
- 状态：G1/G2 仍未重签，S3 九节点与状态机继续冻结。本段作为候选提交后，在该候选上重派 S1 与 S2 第四轮独立审计（报告须内嵌结构化裁决块，绑定候选提交）；两份都 pass 才重签 G1/G2、双门 exit 0、全量全绿，再开 S3。

### 11.32 S2 第三十四轮 P1 整改：report_id 判重与裁决一致性（2026-11-14 10:05）

- 触发：S2 第三十四轮独立审计 fail（P0=0 / P1=1 / P2=1，19 项必过 18/19，失败项 G2-11）；S1 第二十九轮 pass（13/13，P2=3）。
- P1-1（G2-11）：`apply-report.ts` 的判重原本在 JSON 文本上拼 LIKE 模式，report_id 带引号被转义后永不匹配，重投能无限追加事件。改为 `countReportEvent()` 按 `json_extract` 列比对（`CASE WHEN json_valid(payload)` 包住，坏 payload 不炸查询）；rejectReport 的同因重复判定同样改成两列同时命中。`schemas.ts` 新增 `reportIdentifier` 字符集（`^[A-Za-z0-9._:-]+$`）接到 `reportSchema.report_id`，入口 400 挡下。
- P2-1（与 S1 第二十九轮 P2 同源）：`checkAuditAnchor` 在裁决核对之后加正文一致性核对，正文结论与裁决不一致即拒；`parseAuditVerdict` 要求裁决块正好一对，多块报错；`verdictProblems` 逐个校验 must_pass_ids 必须在门规格内。
- 证据：`caseEvG211` 增补带引号 report_id 连投两次（两次 HTTP 400、事件不增长），`docs/gates/evidence/G2/ev-g2-11.md` 重新生成，两次重跑 sha256 一致（fb72ef55…）。
- 验证（实测）：tsc --noEmit exit 0；全量 36 文件 / 518 passed | 1 skipped，exit 0；新增回归 apply-report 2 例、routes 1 例、audit-verdict 4 例。
- 状态：G1/G2 未重签；S1 第二十九轮 pass 报告与 S2 第三十四轮 fail 报告都在 docs/audits 未跟踪。本轮候选改动导致候选变更，需在新候选上重派两路审计。
