# dsh-orchestra 接手指引（handoff）

> 面向「任何人（包括三个月后的自己）拿到这个目录就能继续干活」写的。
> 最后更新：2026-11-13 12:05。本文件在项目根目录，遵 dshQQ 硬约束第 5 条。
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
| **源码** | **没有。还没开始写。** |
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

### 4.2 下一步：交主人审 spec 与七份实施计划，通过后转实施

1. 六段设计已全部 pass：第六段 v44 第 45 轮 0 致命 / 0 重大 / 7 条措辞，设计稿保持 v44 冻结（2439 行 / 505410 bytes / SHA `D534FA8317A74C48286C83A65C994FC80D812B6B26110BCC533A7BA82699B793`）。
2. 规格已落 `docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md`（v1.3）：1493 行 / 106173 bytes / SHA256 `D78E4E2B7F3C569D20F8FEC27564B031240B4E1B947F34E47EF493CE9976F82E`，commit `26fc1af`。以设计稿 v44 为权威，第 45 轮 7 条措辞已在规格第 15 章逐条清，设计稿保持冻结；九处不一致已裁定并落成 v1.2，主脑与自治口径落成 v1.3 第 18 章。
3. 规格自审已过：120 标题、章 0–18、14 个表块 0 列不一致、非终态 13 值、全文 0 反引号；GateArtifact 为 G6 有 run 示例，四个哈希原像均为合法 JSON、sha256 全 64 位 hex。v1.2 后重校：六份计划 468 处规格引用逐条核对，内容不一致 0、小节归属不符 0；v1.3 只追加第 18 章、§1–§17 行号零位移，引用无需重校准；§18 表块列数一致、无占位符。等主人审阅。
4. 原型 v20 已提交（`1091673`）并交主人评审：流程页顶部横排标签条换成一行可搜下拉，按名称 / 说明 / 负责人 / 触发方式 / 版本 / 发布状态过滤，当前流程标「当前」，Esc 或点空白收起、Enter 切第一条；任务页可按状态与时间段查，归档箱只收起不改历史、可搜索可取回；状态数字与列表同源、状态句三处同源、健康支线默认收起、卡面只留「做到 / 结果 / 需要你」。
5. 实施计划已写完（总纲 + S1–S6，提交 `f094760`，含规格行号重校准；`26fc1af` 再补 S3 Task 15 起运行命令与自治档位、S5 Task 17 自治档位与审计留痕的显示，总纲 §5 批次表同步为 S3 15 个 Task / S5 17 个 Task）：等主人过目后按 `executing-plans` 或 `subagent-driven-development` 从 S1 起步，先跑 G1 门再进 S2。
6. 每次改稿后同步版本号、SHA256、行数与台账，改完提交 git。

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
- 关键提交：`f7da467` agent skills 配置、`750c89f` v20 送审、`8b68b44` v21 收口、`d9a0c1e` v22 收口、`bdf9c17` v23 收口（第三段送审版）、`3e7ccc8` v27 送第 29 轮 + 原型 v7、`bb64f0b` 原型 v8 去掉彩色左条、`f7dde5e` v29 送第 31 轮 + 原型 v9、`99ca50e` v32 送第 34 轮、`462bfa9` 原型 v10 字号收口 + 设计 v31、`2136866` 原型 v10 绘图细节、`5f759e7` v33 第四段收口、`ce36151` v35 第五段修第 35 轮 13 条、`5c391b1` v36 第五段修第 36 轮 7 条并送第 37 轮、`33b093e` v37 第五段修第 37 轮 10 条并送第 38 轮、`8bfdc30` v39 第六段送第 39 轮、`3d4f59d` 原型 v11 字号层、`a1afa13` v41 第六段主体、`fd0df0b` G1 无 run 例外、`b747419` 记录重送与 G1、`0f950e6` v42 修第 42 轮 12 条并送第 43 轮、`6777ea4` v43 修第 43 轮 10 条 + 原型 v12、`63adb98` 原型 v13 去掉优先级标签并统一人话文案、`fb7d1f1` v44 修第 44 轮 9 条、`408df76` 记录 v44 送第 45 轮、`b068ca4` 记录第 45 轮 pass 并同步 handoff、`ee17d03` 落 v44 实施规格、`89d8836` 同步 v44 实施规格落盘与待审状态、`aea1b24` 共享面提案留档、`eeb7558` 原型 v15 纯白平面系统、`f3b7e94` 原型 v16 核心指挥台、`65b69c5` 原型 v17 执行注意事项落进任务流并重排数字字号、`b8352db` 落齐 S1–S6 六份批次计划、`f094760` 规格升 v1.2 裁定九处不一致并重校六份计划的规格行号、`26fc1af` 规格升 v1.3 补第十八章主脑与自治档位并为 S3/S5 各加一任务。、`a540e1e` 原型 v18 状态诚实、一处一概念、默认安静、文案收短（数字等于列表长度、状态句三处同源、健康支线默认收起）、`8aa9cef` 原型 v19 任务查询按状态与时间段、归档箱只收起不改历史、`1091673` 原型 v20 流程库改成一行可搜下拉、`c08fa3a` 校正七份计划的依赖与版本事实并清仓库补 GLOSSARY 与 ADR 0001（此提交同时是首次推到远端，`origin/main` 与本地同步）、`80442ac` 记录计划校正与路线、`5f8ad5f` Task 0 插件仓库骨架与工具链（`origin/main` 已同步）。
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
