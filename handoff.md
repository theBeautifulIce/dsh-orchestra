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

### 4.2 下一步：R1/R2 已落地，继续 R3–R5，再按第三十七轮独立审计重签

1. 六段设计已全部 pass：第六段 v44 第 45 轮 0 致命 / 0 重大 / 7 条措辞，设计稿保持 v44 冻结（2439 行 / 505410 bytes / SHA `D534FA8317A74C48286C83A65C994FC80D812B6B26110BCC533A7BA82699B793`）。
2. 规格已落 `docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md`（v1.3）：1493 行 / 106173 bytes / SHA256 `D78E4E2B7F3C569D20F8FEC27564B031240B4E1B947F34E47EF493CE9976F82E`，commit `26fc1af`。以设计稿 v44 为权威，第 45 轮 7 条措辞已在规格第 15 章逐条清，设计稿保持冻结；九处不一致已裁定并落成 v1.2，主脑与自治口径落成 v1.3 第 18 章。
3. 规格自审已过：120 标题、章 0–18、14 个表块 0 列不一致、非终态 13 值、全文 0 反引号；GateArtifact 为 G6 有 run 示例，四个哈希原像均为合法 JSON、sha256 全 64 位 hex。v1.2 后重校：六份计划 468 处规格引用逐条核对，内容不一致 0、小节归属不符 0；v1.3 只追加第 18 章、§1–§17 行号零位移，引用无需重校准；§18 表块列数一致、无占位符。等主人审阅。
4. 原型 v20 已提交（`1091673`）并交主人评审：流程页顶部横排标签条换成一行可搜下拉，按名称 / 说明 / 负责人 / 触发方式 / 版本 / 发布状态过滤，当前流程标「当前」，Esc 或点空白收起、Enter 切第一条；任务页可按状态与时间段查，归档箱只收起不改历史、可搜索可取回；状态数字与列表同源、状态句三处同源、健康支线默认收起、卡面只留「做到 / 结果 / 需要你」。
5. 实施计划已写完（总纲 + S1–S6，提交 `f094760`，含规格行号重校准；`26fc1af` 再补 S3 Task 15 起运行命令与自治档位、S5 Task 17 自治档位与审计留痕的显示，总纲 §5 批次表同步为 S3 15 个 Task / S5 17 个 Task）：等主人过目后按 `executing-plans` 或 `subagent-driven-development` 从 S1 起步，先跑 G1 门再进 S2。
6. 每次改稿后同步版本号、SHA256、行数与台账，改完提交 git。
7. **实施进度（2026-11-14 11:30，HEAD 45880b0）**：S1 账本地基与 S2 单节点闭环已实现；G1/G2 曾在候选 `2f034a5` 上按 S1 r31 / S2 r36 重签、双门 exit 0。外部评审（主人 2026-11-14 对 `2f034a5` 的复审）指出两个 P0 旁路，已修成两个独立提交：`c87f18b` 把 `/v1/runs/dispatch` 与 `/v1/node-runs/run` 统一到装配层的 `executeScheduled`（同一次执行只占一个并发名额），新增 `tests/contract/execution-concurrency.spec.ts` 实测并发上限 2；`45880b0` 让 `proseVerdictClashes` 同时检查 Markdown 表格、按 `audit_round` 豁免历史行、只在 `pass` 下扫必过项，补 A4/A5 与历史/未来轮次回归。验证：`tsc --noEmit` exit 0；全量 38 文件 **530 passed | 1 skipped**；`pnpm build` 通过；两处变异都能被新用例咬住。**注意：门现在仍签在旧候选 `2f034a5` 上，新提交不能直接签**，须先在当前候选上派 S1/S2 第三十七轮独立审计，两份 pass 后再按旧流程重签 G1/G2、双门 exit 0。下一步按任务书做 P1-02 Scheduler 背压、R3 账本/工具单调耗时、R4 workflow_id+version 与 Schema；R5 Agent Bridge 单独提交设计再接生产，R1–R4 与 R5 不混提交。

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

### 11.34 外部复审 `2f034a5` 的 P0 旁路整改（2026-11-14 11:30，HEAD 45880b0）

- 触发：主人对 `2f034a5` 的复审（较 `f01581c` 增 9 提交），确认工具执行身份、工作流冻结、账本完整性有实质进展，但指出两个必须立刻修的旁路与四条待办。
- P0-01 调度旁路（`c87f18b`）：根因是 `/v1/node-runs/run` 在 `src/service/server.ts` 直调 `commands.runNode`，而 `src/index.ts` 的 `commands.runNode` 又直调 `runNode`，绕过 `serveOrchestra` 装配的 `ExecutionScheduler`；只有 `/v1/runs/dispatch` 经过 `dispatcher.ts`。修法：在 `src/index.ts` 抽出 `executeNode`（无执行器抛 `EVIDENCE_SOURCE_UNAVAILABLE`）与 `executeScheduled = runThroughScheduler(opts.scheduler, () => executeNode(p), {label:p.nodeId})`；`commands.runNode` 与 `dispatcher.dispatchRun` 共用它。`dispatcher.ts` 的 `DispatchDeps` 改为注入 `executeNode`，自身不再持有 scheduler，避免一次执行重复占两个名额；未注入时串行直调 `runNode` 供单测用。
- P0-01 回归：新增 `tests/contract/execution-concurrency.spec.ts`，concurrency=2，6 个节点（1 次 dispatch 3 个 + 3 次 node-runs/run）同时提交，HostRunner 记录 active/maxActive；实测 6 个 started、maxActive=2、结束后 inFlight/waiting 归零。变异：把 commands.runNode 改回直调 runNode，测试报 `expected 5 to be 2`。
- P0-02 审计表格绕过（`45880b0`）：`scripts/gate-check.ts` 的 `proseVerdictClashes` 原只扫散文、丢 `rendered.cells`，S2 r36 的 A4/A5 可签过。修法：`AuditCell` 增 `rowIndex`；`splitProseAndCells` 同时返回 `tableCells`；按 `tableIndex:rowIndex` 分行，`historicalTableRows(cells, auditRound)` 只豁免「轮次数字严格早于 audit_round 且带轮次列、无本轮标记」的行；`pass` 下对结论列、带显式结论标记、或整行点名必过项的单元格判 `cellFailStatement` / `visibleFailStatement`；`fail` 下不再扫必过项与表格，消除自相矛盾告警；结果去重。`checkAuditAnchor` 传入 `artifact.audit_round`。
- P0-02 回归：`tests/gate/gate-check.spec.ts` 新增 5 例（A4 表格写 G2-11 未通过、A5 结论列 fail、历史 35 fail/36 pass 不误伤且 37 fail 仍拒、fail 裁决零告警、故障场景表不误伤）。变异：把表格循环改成 `continue`，A4/A5/未来轮次三例全红。
- 验证（实测）：`tsc --noEmit` exit 0；全量 38 文件 **530 passed | 1 skipped**（1 skipped 是预签态用例）；`pnpm build` 通过。定向 `tests/gate/gate-check.spec.ts` 164 passed | 1 skipped。
- 尚存/待办：门记录仍绑定旧候选 `2f034a5`，当前提交不是签署候选；须在 `45880b0` 上派 S1/S2 第三十七轮独立审计（不改 r36 报告），两份 pass 后重签。任务书余项：P1-02 Scheduler `max_waiting` 背压与 close、R3 链头同事务/单调耗时、R4 workflow_id+version 与 Schema、R5 Agent Bridge 生产生命周期（单独提交设计，不混进 R1–R4）、P2-04 审计生成器与跨版本审计。

### 11.35 第三十七轮双审计整改：调度背压与审计表格跨格（2026-11-14 12:10，HEAD 6b015c1）

- 触发：在 `fab7c2a` 上派 S1/S2 第三十七轮独立审计，两份都 fail。
  - S1（`docs/audits/S1-independent-audit-round37.md`，克隆 `D:/aboutAI/_audit-r37-s1`）P0=1 / P1=2 / P2=4：P0 是否定词拆到相邻格（`| G1-01 | … | pass | 未 | 通过 |`）仍签过；P1 是 3 列表头写 4 格、溢出列被 markdown-it 丢弃后仍签过，以及 HTML 注释里写 `结论：fail` 不被扫描。
  - S2（`docs/audits/S2-independent-audit-round37.md`，克隆 `D:/aboutAI/_audit-r37-s2`，提交 `f3e0825`）P0=0 / P1=1 / P2=3：P1 是生产调度器无 `max_waiting` 背压、无 `close` 停机语义；P2 是 Agent Bridge 未接生产、工具 `started_at/finished_at` 同刻、围栏/注释内表格被屏蔽。P0-01 并发旁路经真实 HTTP 复测确认修住（双入口 6 节点，maxActive=2，异常后名额归零）。
- 调度背压（`6b015c1`）：`src/service/execution-scheduler.ts` 新增 `DEFAULT_MAX_WAITING=1000` 与 `close({drain})`；`drain:true` 停收新任务并跑完队列，`drain:false` 立即拒排队、在跑任务收尾；`ExecutionScheduler` 接口补 `close`；工厂默认有界，配置工厂传 `cfg.execution.max_waiting`。`src/core/config.ts` 的 `execution` 增 `max_waiting: positiveInt(1).max(10000).default(1000)`。`src/index.ts` 的 `serveOrchestra.close` 先关 HTTP，再 `scheduler.close({drain:true})`，最后释放服务锁。
- 审计表格（`6b015c1`）：`scripts/gate-check.ts` 新增 `splitFailureAcrossCells`（按单元格累计长度建边界，强/弱失败词跨边界即判失败）、`rawTableOverflowIssues`（按源码数格，数据行超过表头直接拒）、`hiddenCommentFailure`（HTML 注释内「结论词 + 失败词」同现按隐藏判定拒）、`chineseNumber`（认 `第三十五轮`）；`proseVerdictClashes` 用无分隔拼接行同时命中被拆开的必过项 id 与失败词，保留原逐格判定与历史行豁免。
- 回归：`tests/gate/gate-check.spec.ts` 新增 A6–A9 与中文轮次 5 例；`tests/unit/execution-scheduler.spec.ts` 新增默认上限、配置接线、`close({drain:true})`、`close({drain:false})` 4 项断言/用例。A6 变异（把边界判断改成 false）实测转红，恢复后全绿。
- 验证（实测）：`tsc --noEmit` exit 0；全量 38 文件 **537 passed | 1 skipped**（1 skipped 是预签态用例）；`pnpm build` 通过；`check-evidence-repro.ts` exit 0（25 份，每份两遍与 HEAD 字节一致）。
- 环境事故：主仓 `node_modules` 被换成指向 S2 克隆的失效 junction，`pnpm` 报 `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR ... 拒绝访问 (os error 5)`；`cmd /c rmdir /s /q node_modules` 后 `pnpm install --frozen-lockfile` 恢复（239 包，1.6s）。后续审计克隆不得改主仓 `node_modules`。
- 状态：门记录仍绑定旧候选 `2f034a5`，`6b015c1` 尚未签署；须在 `6b015c1` 上重派 S1/S2 第三十八轮独立审计，两份 pass 后按 G1→G2 重签、双门 exit 0，再开 S3。任务书余项：R3 链头同事务/工具单调耗时、R4 workflow_id+version 与 Schema、R5 Agent Bridge 生产生命周期（单独提交设计）、P2-04 审计证据引用与跨版本审计。

### 11.36 第三十八轮双审计整改：短分隔行溢出与注释拆段（2026-11-14 12:35，HEAD 99fe7fe）

- 触发：在 `4826d7f` 上派 S1/S2 第三十八轮独立审计，两份都 fail，P1 同源：分隔行每格 1 个连字符时 markdown-it 仍按表格渲染，`isTableDelimiterRow` 只认 `-{3,}`，`rawTableOverflowIssues` 整表跳过，溢出第 4 格被丢弃。S1 探针签过 G1（artifact `7b2da158…` / body `cbc04e52…`）后 reset；S2 端到端签过 G2 后 reset。S1 为 P0=0/P1=1/P2=3，S2 为 P0=0/P1=1/P2=6，19 项必过全过。调度背压与停机由 S2 探针复测修住：40 个不返回任务 waiting≤1000，1002 个任务时第 1002 个拒绝，`maxWaiting=2` 时第 4 个拒绝，drain/close 探针 24+16 全通过；真实 HTTP 双入口 `maxActive=2`，`serveOrchestra.close` 后在跑任务 200 收尾、锁释放。
- 修复 `99fe7fe`：`isTableDelimiterRow` 改为 `^:?-+:?$`（1 个及以上连字符），`rawTableOverflowIssues` 覆盖短分隔行；`hiddenCommentFailure` 合并全部注释体，失败词 +（结论词或必过项引用）即拒，覆盖 A9b/A9c；新增 `isRejectedAttackRow` 豁免攻击/用例矩阵的「拒 + 被拒文案」，避免 round36 报告 G2-05/G2-06 误杀；行级只认 `splitFailureAcrossCells`，非结论列只加 `cellStrongFail`，去掉整行 `visibleFailStatement` 对领域弱词的误判。
- 回归：A8b（1 连字符 + 溢出格）、A9b、A9c、攻击矩阵（A8b 编号）、必过项要求列「无裸 blocked」各 1 例；round36 真实报告探针 `proseVerdictClashes(...,'pass',19项)===[]`。
- 变异：`isTableDelimiterRow` 改回 `-{3,}`，A8b 红「expected '' to match /超过表头/」；恢复后 `tsc --noEmit` 0、全量 38 文件 542 passed | 1 skipped、build 通过、check-evidence-repro 25 份。
- 尚留 P2（不阻断）：Agent Bridge 未接生产、工具 `started_at/finished_at` 同刻、围栏/注释内表格按设计屏蔽、配置非法时静默回落默认调度器（`parseConfig` 本身会拒）。
- 状态：G1/G2 仍绑旧候选（G1 31 轮、G2 36 轮），`99fe7fe` 未签；须在 `99fe7fe` 上重派 S1/S2 第三十九轮独立审计，两份 pass 后按 G1→G2 重签、双门 exit 0，再开 S3。任务书余项：R3 链头同事务/工具单调耗时、R4 workflow_id+version 与 Schema、R5 Agent Bridge 生产生命周期（单独提交设计）、P2-04 审计证据引用与跨版本审计。

### 11.37 第三十九轮 S2 回归整改：攻击矩阵整行豁免（2026-11-14 12:50，HEAD 2cd6a62）

- 触发：S2 第三十九轮在 `920a5dd` 上判 **fail**（P0=0 / P1=1 / P2=5，19/19 必过项实测通过），报告 `D:/aboutAI/_audit-r39-s2/docs/audits/S2-independent-audit-round39.md`，克隆提交 `0b729db2…`。P1 是 `99fe7fe` 引入的回归：`isRejectedAttackRow` 在 `scripts/gate-check.ts:1656` 整行 `continue`，攻击表 `| 用例编号 | 必过项 | 期望 | 结论 |` + `| A1 | G2-11 | 拒 | 未通过 |` 可签过（artifact `0a04e41d…` / body `71557479…`）；首列/首格/期望列任一改动都会 exit 1，确认是整行豁免导致。
- 修复 `6ea145d`：不再整行跳过。`const rejectedAttack = isRejectedAttackRow(row)`；行级 `joinedFail = !rejectedAttack && splitFailureAcrossCells(row)`；逐格循环加 `if (rejectedAttack && !conclusionCell) continue`，攻击描述/证据格可引用失败文案，但结论列与显式结论标记仍逐格判。新增用例 `攻击矩阵只豁免描述格，结论列写未通过仍拒绝`（`tests/gate/gate-check.spec.ts`，表头 `用例编号/必过项/期望/结论`，行 `A1 | G2-11 | 拒 | 未通过`，断言命中 `/G2-11/`）。
- 追加修复 `2cd6a62`：攻击行只豁免描述格还不够，把结论列改名成「备注」、格内只写「未通过」仍会被跳过。新增 `isBareFailureCell`（整格只含强/弱失败词，允许尾随标点），逐格跳过条件改为 `rejectedAttack && !conclusionCell && !bareFailure`；新增用例 `攻击矩阵把结论列改名成备注也不豁免裸否决`，变异把 `bareFailure` 置 false 时红「expected '' to match /G2-11/」，恢复后 4 passed。
- 变异：把条件临时改成 `if (rejectedAttack) continue`，新用例红「expected '' to match /G2-11/」；恢复后定向 `-t "攻击矩阵|A8b"` 4 passed。
- 验证（实测）：`tsc --noEmit` 0；全量 38 文件 **544 passed | 1 skipped**（较上轮 +2）；`pnpm build` 通过；`check-evidence-repro` 25 份字节一致。
- 其余复核：S2 的调度背压/停机 24 项、真实 HTTP 并发/close 16 项全 pass（默认 maxWaiting=1000；第 1002 个拒；maxWaiting=2 第 4 个拒；drain 两分支；同 Promise；失败释放名额；双入口 maxActive=2；异常 503 后归零；close 后拒新、在跑 200 收尾、锁释放）。A8b/A8c/A8dash3、A9b/A9c 均 exit 1；历史行、round36 形攻击矩阵、「无裸 blocked」、干净 pass、围栏内表格不误伤；G2 证据 19 份 LF sha256 与五项哈希一致。
- 尚留 P2：round38 fail 报告被 `hiddenCommentFailure` 误判、Agent Bridge 未接生产、工具 started/finished 同刻、围栏/注释内表格屏蔽、配置非法回落默认调度器。
- 状态：S1 第三十九轮尚未回；G1/G2 仍绑旧候选，`2cd6a62` 未签。S1 回后合并结论，在新候选上重派 S1/S2 第四十轮独立审计，两份 pass 后按 G1→G2 重签、双门 exit 0，再开 S3。任务书余项：R3 链头同事务/工具单调耗时、R4 workflow_id+version 与 Schema、R5 Agent Bridge 生产生命周期（单独提交设计）、P2-04 审计证据引用与跨版本审计。

### 11.38 第三十九轮 S1 同源 P1 与第四十轮候选（2026-11-14 12:56，HEAD 48d4fb3）

- 触发：S1 第三十九轮在 `920a5dd` 上判 **fail**（P0=0 / P1=1 / P2=4），报告 `D:/aboutAI/_audit-r39-s1/docs/audits/S1-independent-audit-round39.md`，克隆提交 `b675ec4`。P1 与 S2 同源但攻击面不同：表头含「用例」、期望格为「拒」的攻击行，把必过项 `G1-01` 的「未通过」写进备注格；`isRejectedAttackRow` 整行 `continue`，`bodyConclusionOf` 也不认非结论列，实测 sign-gate exit 0、gate-check exit 0（临时门 artifact `90a7273f…`、body `db23a6d3…`）。对照：只把「拒」改成「不成立」，同一行 sign-gate exit 1，确认放行由整行豁免直接造成。
- S1 同时确认上一轮两条 P1 已修：1/2/3 连字符分隔行的第 4 格溢出都被 sign-gate 与 gate-check 拒；A6/A7/A9 变体全拒；合法 pass 与中文数字历史表未误伤；六项哈希独立重算一致；并发 15/15、maxActive=2。
- 覆盖：`2cd6a62` 的 `isBareFailureCell` 正是针对该载荷——攻击行可以豁免描述格，但备注格里整格只写「未通过」仍按否决判。新增 S1 精确回归 `S1 第三十九轮 P1：攻击行备注格藏 G1-01 未通过仍拒绝`（`tests/gate/gate-check.spec.ts`，表头 `用例编号/必过项/期望/备注`，行 `A1 | G1-01 | 拒 | 未通过`）。
- 验证（实测）：`tsc --noEmit` 0；全量 38 文件 **545 passed | 1 skipped**；`pnpm build` 通过；`check-evidence-repro` 25 份字节一致。
- S1 P2（不阻断）：①正文行内代码/旧样本里同写 id 与否定词仍会被当本轮判否（误杀，不是绕过）；②`gate-check` 传绝对路径会误报「门记录不在 HEAD 里」，应 normalize 成仓库相对路径；③无结论词、无必过项 id 的隐藏注释不触发扫描；④`sign-gate` 枚举已删除的旧测试路径会向 stderr 打 `fatal: path ... does not exist` 噪声。
- 状态：两路第三十九轮都 fail 在同一攻击矩阵整行豁免；修复已落在 `2cd6a62`，精确回归在 `48d4fb3`。G1/G2 仍绑旧候选，`48d4fb3` 未签；下一步在 `48d4fb3` 上重派 S1/S2 第四十轮独立审计，两份 pass 后按 G1→G2 重签、双门 exit 0，再开 S3。任务书余项：R3 链头同事务/工具单调耗时、R4 workflow_id+version 与 Schema、R5 Agent Bridge 生产生命周期（单独提交设计）、P2-04 审计证据引用与跨版本审计。

### 11.39 第三十九轮补洞：攻击行备注限定词否决（2026-11-14 13:05，HEAD 757b499）

- 主动探针在 `9c75ad1` 上发现第三类旁路：攻击行表头 `用例编号/必过项/期望/备注`、结论列改名 `备注`、备注格写 `未通过（本轮）`、`本轮未通过`、`未通过：证据不足`、`不通过（3 项待补）` 时，sign-gate 与 gate-check 都 exit 0。
- 根因：`foldForVerdict` 把括号、冒号、空格折成 `|`，旧 `isBareFailureCell` 只认整格完全等于失败词；带限定词后既不等于，也不在格首标点边界，逐格检测漏掉。
- 修复 `757b499`：`isBareFailureCell` 先剥前缀「本轮/本輪/当前/當前/本次/当期/當期/最终/最終/审计/審計/本报告/本報告」，失败词后可接 `[|：:（(]` 引导的限定/括号/理由；`cellFails` 增加 `bareFailure && (rejectedAttack || conclusionCell || hit.length > 0)`，确保攻击行备注格与必过项命中格的限定否决进入判定。
- 新增用例「攻击行备注格的限定/括号/冒号否决仍拒绝，名词短语不误伤」：四种攻击载荷全部 exit 1；正控 `未通过项为空`、`失败项为空` 仍 exit 0。
- 验证：`tsc --noEmit` 0；`pnpm test` 38 文件 **546 passed | 1 skipped**（gate 179 tests）；`pnpm build` 成功（CJS 0.29kB、ESM 110.17kB、d.ts 10.76kB）；改动 2 文件 +31/−4。提交 `757b499`「Reject qualified bare failure verdicts in attack-matrix remarks」。
- 追加 `efb3302`「Cover adverbial prefixes before bare failure verdicts」：前缀最多连续剥 3 层，补 `暂/暫/尚/仍/并/並/也/还/還/均/都`，覆盖 `尚未通过`、`暂未通过`、`仍未通过`、`并未通过`、`本轮仍未通过`；全量仍 546 passed | 1 skipped。
- 状态：`s1-audit-r40` / `s2-audit-r40` 仍跑在 `9c75ad1` 上，未覆盖本笔；G1/G2 未签。下一轮审计应绑本 handoff 提交后的新 HEAD，并把四类限定词载荷列为必测。

### 11.40 第四十轮 S1 结论与限定词补洞（2026-11-14 13:12，HEAD 08f3eab）

- 触发：S1 第四十轮在 `9c75ad1` 上判 **fail**（P0=0 / P1=1 / P2=2），报告 `docs/audits/S1-independent-audit-round40.md`，克隆 `D:/aboutAI/_audit-r40-s1`、基线 `c7884ea`、提交 `fd970b8`（报告）与 `b257ad4`（探针）。P1：攻击行备注格 `未通过（本轮）` 等限定写法可签过，因为候选尚未包含 `757b499` 的限定词修复；24 例矩阵中 4 例绕过，追加 7 例中 4 例绕过。S1 也确认 `757b499` 等是候选之后的改动，留待下一轮复核。
- 复核：当前 HEAD 已覆盖 S1 列出的全部变体：`未通过（本轮）`、`未通过（3 项待补）`、`未通过，待整改`、`未通过 - 3 项`、`未通过（见备注）`、`未通过 —— 3 项`、`未通过/待整改`、`待整改`、`已否决（本轮）`。展开后唯一漏网是 `已否决（本轮）`，因为强否决表只有「否决」「被否决」，没有「已否决」。
- 修复 `08f3eab`：`CELL_FAIL_VERDICTS_STRONG` 补 `已否决`、`已驳回`、`已拒绝`、`已退回`、`已打回`；攻击行备注格限定词用例从 9 种扩到 17 种，正控 `未通过项为空`、`失败项为空` 仍为空。定向 1 passed；全量 546 passed | 1 skipped；build 成功。
- S1 其余：A6/A6b/A7/A8/A8b/A9/A9b/A9c、中文数字历史、未来轮次、干净 pass、故障场景、合法攻击描述全部无回退；调度探针 8/8、真实 HTTP 双入口 14 passed、maxActive=2；tsc/全量/build/证据复现 25 份全 0；六项哈希中仅 `ev-gatecheck` 与 candidate/change_scope 属预签态失配。
- S1 的 P2：`docs/audits/S1-independent-audit-round29.md:67` 攻防表里的「结论：fail」被 fail-closed 误报；未签门的 G1 证据漂移。均非本轮 P1。
- 状态：`s2-audit-r40` 仍在跑，同样绑 `9c75ad1`；主仓 HEAD `08f3eab`，工作树干净。G1/G2 未签。

### 11.41 第四十轮 S2 结论与格内拆词/期望列收口（2026-11-14 13:14，HEAD 4154c0e）

- 触发：S2 第四十轮在 `9c75ad1` 上判 **fail**（P0=0 / P1=1 / P2=1），报告 `D:/aboutAI/_audit-r40-s2/docs/audits/S2-independent-audit-round40.md`，克隆提交 `ce5f98a`（当前 `8d48cda`）。P1 与 S1 同源：备注格 `未通过（本轮）`、`本轮未通过`、`未 通过`、`待定`、`blocked` 可签过，`fail` 与裸 `未通过` 被拦。S2 明确主仓 `43badda` 已含同类修复，但 `未 通过` 仍放行，期望列 `blocked` 反而误伤。
- 修复 `58baafc`：`isBareFailureCell` 不再只认整格相等，改为对失败词逐字符生成 `\|*` 连接的正则，词间空白/标点折成的 `|` 仍算同一裁决；词后还有实词（`未通过项为空`）不匹配。新增 `isExpectationColumn`，攻击行的「期望/预期/expected」格不再参与失败扫描，`拒绝`/`rejected`/`blocked` 期望不再误伤。测试补 `未 通过`、`待定`、`blocked` 与期望列三变体；全量 **547 passed | 1 skipped**（gate 180 tests），build 成功。
- 追加 `b7c03d4`：`isBareFailureCell` 的前缀剥离补 `该项/本项/此项/此項/该门/該門/本门/本門/该审计/該審計`，覆盖 `该项未通过`；全量仍 547 passed | 1 skipped。
- 追加 `4154c0e`：期望列用例补 `blocked`，定向 1 passed。
- 追加 `161589d`：攻击行不再「非裸词即跳过」。只跳过期望列、攻击描述/载荷列（表头或正文含被拒/载荷/输入等标记）与 `未通过项为空` 这类零失败短语；「备注/说明/附注」里的 `必过项 G1-01 未通过`、`该项未通过` 都按必过项否决拦截。全量仍 **547 passed | 1 skipped**，证据复现 25 份一致。
- S2 其余：调度探针 24/24（默认 maxWaiting=1000、第 1002 个拒、maxWaiting=2 第 4 个拒、drain 两分支、重复 close 同 Promise、失败释放名额）；真实 HTTP 16/16（双入口 maxActive=2、异常 503 归零、close 后拒新、在跑 200 收尾、锁释放）；tsc/全量/build/证据复现 25 份全 0；独立临时门六项哈希全匹配（candidate `c2ba727a…`、change_scope `c7759fb5…`、evidence_index `9c477151…`、invariants `6f75465b…`、artifact `289473a7…`、body `73c28961…`）。
- 正式 G1/G2 仍预签态：artifact/body 自洽，candidate/change_scope（G1 还含 evidence_index）与 HEAD 不一致，`gate-check` 两门 exit 1「候选提交之后候选文件又被改过」；未签。
- 结论：第四十轮两路 fail 均因候选停在 `9c75ad1`。限定词、格内拆词、期望列、主语前缀这批修复已进 `4154c0e`，需在新候选上重跑 S1/S2 第四十一轮；不得用本轮 fail 报告重签。

### 11.42 第四十一轮 S2：攻击行结论格被描述格豁免（2026-11-14 13:24，HEAD f3a39ac）

- 触发：S2 第四十一轮在 `4bce930` 上判 **fail**（P0=0 / P1=1 / P2=1，19/19 必过实测通过），报告 `D:/aboutAI/_audit-r41-s2/docs/audits/S2-independent-audit-round41.md`，克隆 HEAD `70ff8f4`。P1：攻击行结论格写 `G2-11 已拒绝：证据不足`、`G2-11 被拒绝`、`已拒（本轮）` 时，`isAttackDescriptionCell` 把正文里的 `被拒|已拒` 当描述标记，且整格 `continue` 排在结论列判定之前，`proseVerdictClashes` 返回空；普通表/正文仍能拦住。
- 修复 `f3a39ac`：`isAttackDescriptionCell` 的正文标记收窄为 `被拒文案|拒绝文案|驳回文案|被拒载荷|已拒载荷|被拒原因|拒绝原因|拦截|拦下|攻击载荷|载荷|输入|尝试|样例|样本|应被拒|期望拒绝|被 blocked|blocked by`，不再单凭 `被拒/已拒`；逐格跳过改为 `!conclusionCell && isAttackDescriptionCell(cell)`，结论列永不被描述格豁免。强否决表补 `被拒`、`已拒`。
- P2 修复：`isRejectedAttackRow` 的期望格接受 `期望拒绝`、`已拒绝`、`拒绝（本轮）`、`禁止通过` 等限定写法，避免合法攻击矩阵因期望格不精确而被误判。
- 新增用例：结论列 `G2-11 已拒绝：证据不足`、`G2-11 被拒绝`、`已拒（本轮）` 必须命中；期望列七种写法 + `被拒文案：未通过` 必须不误伤。全量 38 文件 **548 passed | 1 skipped**（gate 181 tests），build 成功，证据复现 25 份一致。
- S2 其余：调度探针 7/7、HTTP 探针 2/2、定向并发 14 passed；默认 maxWaiting=1000、第 1002 个拒、maxWaiting=2 第 4 个拒、drain 两分支、重复 close 同 Promise、异常 503 归零、close 后拒新且锁释放；G2 19 份证据哈希 19/19、四项自哈希/锚点全中；正式门预签态 exit 1 属预期。
- S1 第四十一轮仍在跑，绑 `4bce930`，未覆盖 `f3a39ac`；须在新候选上派第四十二轮。

### 11.40 第四十/四十一轮门解析整改：格内否定、期望列、暂缓与繁体表格（2026-11-14 13:28，HEAD 4a7d4f1）

- 第四十轮双审计：S1 fail（P1=1/P2=2，`未通过（本轮）` 可签）、S2 fail（P1=1/P2=1，`未 通过`/`待定`/`blocked` 可签、期望列 `blocked` 误伤）。报告分别在 `_audit-r40-s1`、`_audit-r40-s2`。
- `58baafc` 把 `isBareFailureCell` 改为按失败词逐字符 `\|*` 连接匹配，同一格内空白/标点折成的 `|` 仍算同一裁决；新增 `isExpectationColumn` 跳过攻击行期望列。`b7c03d4` 补 `该项/本项/此项/该门/本门/该审计` 前缀。`4154c0e` 补期望列 `blocked` 用例。`161589d` 攻击行只跳过期望列、描述/载荷列与零失败短语，`必过项 G1-01 未通过`、`该项未通过` 仍拦。全量 547 passed | 1 skipped。
- 第四十一轮 S2 fail（P1=1/P2=1，19/19 必过）：攻击行结论格 `G2-11 已拒绝：证据不足`、`G2-11 被拒绝`、`已拒（本轮）` 被 `isAttackDescriptionCell` 的 `被拒|已拒` 文本标记当成描述格，结论列判定被 `continue` 绕过。`f3a39ac` 收窄描述标记（`被拒文案/拒绝文案/驳回文案/被拒载荷/已拒载荷/被拒原因/拒绝原因/拦截/拦下/攻击载荷/载荷/输入/尝试/样例/样本/应被拒/期望拒绝/被 blocked/blocked by`），逐格跳过改为 `!conclusionCell && isAttackDescriptionCell(cell)`，强否决表补 `被拒`/`已拒`，期望列接受限定写法。全量 548 passed | 1 skipped。
- 第四十一轮 S1 fail（P1=2/P2=2，13/13 必过）：①`isBareFailureCell` 先剥前缀再匹配，单字 `暂|暫` 把弱词 `暂缓` 剥成 `缓`，`暂缓`、`暂缓（本轮）`、`本轮暂缓`、`该门暂缓`、`暫緩` 全漏；②表格词表只收简体，`未通過`、`未能通過`、`本項未通過`、`駁回`、`否決` 在结论列/备注全放行，散文路径却判 fail。
- `4a7d4f1` 修复：抽出 `matchesFailureWord`，在剥前缀**之前**按原样匹配一次，再循环剥 1–3 层并匹配；`暂缓` 因此先命中，`暂未通过` 仍能剥出 `未通过`。STRONG 表补繁体强否决（`未通過`、`不通過`、`未能通過`、`未獲通過`、`未通過驗收`、`被否決`、`否決`、`被駁回`、`駁回`、`被拒絕`、`拒絕`、`失敗` 等），WEAK 表补 `部分通過`、`有條件通過`、`附條件通過`、`暫緩`、`擱置`、`待整改`、`需整改`、`待修復`、`未完成`、`不完整`、`未就緒`、`懸而未決`、`保留意見`、`待觀察`、`存疑` 等；前缀补 `本項`/`該項`。新增「表格繁体否决与简体同口径，暂缓不被前缀剥离吞掉」与 14 种限定词载荷用例，正控 `通过`、`未通过项为空`、`失败项为空` 保持不误伤。
- 验证（实测）：`tsc --noEmit` 0；全量 38 文件 **549 passed | 1 skipped**（gate 182）；`pnpm build` 成功（CJS 0.29kB、ESM 110.17kB、d.ts 10.76kB）；证据复现 25 份字节一致。
- 尚留 P2（记录，不阻断）：round29 攻防表「结论：fail」误报；`sign-gate` 探测已删除旧路径时 `git()` 未抑制 stderr，打 `fatal: path ... does not exist in 'HEAD'` 噪声；`gate-check` 绝对路径误报；无 id/结论词的隐藏注释不扫；Agent Bridge 未接生产；工具 started/finished 同刻；配置非法回落默认调度器。
- 状态：G1/G2 仍绑第 31/36 轮旧候选，未签；`4a7d4f1` 之后需补本段 handoff 提交作为第四十二轮候选。
- 下一步：在本段提交上派第四十二轮 S1/S2 独立审计，必测暂缓族、繁体表格、攻击行结论格三变体、期望列限定写法，同时复核 A6/A7/A8b/A9、历史行、干净 pass、调度背压/停机、真实 HTTP 并发、六项哈希与 25 份证据；两路 pass 后按 G1→G2 重签、双门 exit 0，再开 S3。任务书余项 R3/R4/R5 与 P2-04 不变。

### 11.41 第四十二轮双审计：S2 pass、S1 覆盖点误伤修复（2026-11-14 13:52，HEAD 6f4e175）

- S2 第四十二轮 **pass**（P0=0 / P1=0 / P2=3），候选 `142104c`，报告 `D:/aboutAI/_audit-r42-s2/docs/audits/S2-independent-audit-round42.md`（sha256 `83232107…`），克隆 HEAD `14f11912…`。P2：`createExecutionScheduler` 未校验直接传入的 `maxWaiting`；正式门仍绑旧候选；`sign-gate` 探测已删除路径时 `git show` 的 `fatal: path ... does not exist` 漏到 stderr。S2 复核 549 passed、build、证据 25 份、调度 20/20、HTTP 11/11、临时门 G1/G2 双 exit 0。
- S1 第四十二轮 **fail**（P0=0 / P1=2 / P2=2），候选 `142104c`，报告 `D:/aboutAI/_audit-r42-s1/docs/audits/S1-independent-audit-round42.md`，克隆 `ae62fb04…`。
  - P1-1：合法 pass 报告 `docs/audits/S2-independent-audit-round36.md:132` 的 `| G2-07 | S2 加载 parallel 被拒 | 通过 |` 被 `cellStrongFail` 当成格内否决，误报「把必过项 G2-07 写成未通过」；`99fe7fe` 引入。
  - P1-2：普通表 `| G1-01 | 通过 | 未通过项为空 |` 也被同一支误判，清零正句只在攻击行豁免，口径不一致。
  - P2：`isAttackDescriptionCell` 用 `被拒|已拒` 子串（`f3a39ac` 已修，审计对象未含）；`sign-gate` 探测已删除旧路径的 stderr 噪声。
- 修复 `6f4e175`「Separate required-item coverage from residual failure verdicts (S1 round42 P1)」：
  - 新增 `residualAfterRequiredItems(folded, requiredItems)`：先小写，按 id 原文与 `foldForVerdict(id)` 两种形态去掉行内必过项 id，压缩 `|`，剥掉格首「必过项/通过项/该项/本项/此项/本項/該項/该门/本门/該門/本門」标签；这样 `foldForVerdict` 把 `G2-11` 折成 `g2|11` 时也能剥净。
  - 表格第三支从 `cellStrongFail(foldForVerdict(cell.text))` 改为 `residual !== '' && isBareFailureCell(residual)`，只判「去掉必过项后整格仍是裁决」；覆盖点描述（`S2 加载 parallel 被拒`）与清零正句（`未通过项为空`）留在残句里但不是裸否决，因此不误伤；`G2-11 未通过` 去 id 后仍是 `未通过`，仍拦。
  - 新增用例「覆盖点里的被拒与清零正句不误伤」，含 round36 行与普通清零表。
  - 顺手补 S2 P2-1：`Scheduler` 构造器对 `maxWaiting` 调 `positive(opts.maxWaiting, 'max_waiting')`，直接传 0 / -1 / 1.5 在装配期抛「执行调度的参数不合法」；新增 1 例。
- 变异：把 `residualFail` 临时固定为 `false`，限定词用例在 `必过项 G2-11 未通过` 上红「expected '' to match /G2-11/」；恢复后通过。
- 验证（实测）：`tsc --noEmit` 0；全量 38 文件 **551 passed | 1 skipped**（gate 183 tests，scheduler 14）；`pnpm build` 成功（CJS 0.29kB、ESM 110.19kB、d.ts 10.76kB）；证据复现 25 份字节一致。
- 状态：G1/G2 仍绑第 31/36 轮旧候选，未签。S2 第 42 轮报告可作 G2 报告，但 G1 没有对应 pass 报告；且 `6f4e175` 已是新候选，需在新 HEAD 上重派 S1/S2 第四十三轮，S1 必须拿 pass 报告才能签 G1。
- 任务书余项：R3 链头 DELETE 触发器/同事务严格 seq/prev_hash、工具真实 startedAt/finishedAt 与单调 durationNs；R4 workflow_id+version 复合身份与 WorkflowDefinitionSchema.parse 统一 hydrate；R5 Agent Bridge 生产生命周期（单独提交设计）；P2-04 审计证据引用与跨版本审计。

### 11.42 第四十三轮双审计：S2 pass、S1 residual 假阴性（2026-11-14 14:20，HEAD bc1005a）

- 候选 `f6e10e6` 上同时派出 S1/S2。S2 第四十三轮 **pass**（P0=0 / P1=0 / P2=2），报告 `D:/aboutAI/_audit-r43-s2/docs/audits/S2-independent-audit-round43.md`，克隆最终 `4c6fa6a`；调度背压 32/32、真实 HTTP 双入口 13/13（6 节点 `maxActive=2`、503 后归零、锁可重取）、临时 G2 sign/check 均 0、19 项必过与 25 份证据全中。P2 仅为 `sign-gate` 探测已删除路径的 stderr 噪声与正式门仍旧候选。
- S1 第四十三轮 **fail**（P0=0 / P1=1 / P2=3），报告 `D:/aboutAI/_audit-r43-s1/docs/audits/S1-independent-audit-round43.md`，克隆 `0b64d27`。P1：`residualAfterRequiredItems` 去掉必过项 id 后只剥一层格首标签，留下 `本轮|未通过`；`isBareFailureCell` 剥掉「本轮」后剩 `|未通过`，前导分隔符让 `matchesFailureWord` 锚首匹配失败。普通表 `| G1-01 | 通过 | 必过项 G1-01（本轮）未通过 |` 与攻击行都能签过（临时门 artifact `c52a1329…` / `47f63d28…`）。P2：双标签 `必过项 必过项 G1-01 未通过` 同根因；`fatal: path ... does not exist` stderr 噪声；正式门仍旧候选。
- 修复 `bc1005a`：`isBareFailureCell` 在初始清洗与每轮前缀剥离后都去掉前导 `|`；`residualAfterRequiredItems` 最多循环 3 次剥格首标签与前导分隔符，双标签也能落到 `未通过`。新增用例 `S1 第四十三轮 P1：去 id 后的本轮限定与双标签仍算裸否决`，覆盖普通表 `必过项 G1-01（本轮）未通过`、`必过项 必过项 G1-01 未通过` 与攻击行同载荷。
- 变异：删掉前缀循环后的 `.replace(/^\|+/, '')`，新用例红；恢复后定向 1 passed、gate spec 183 passed | 1 skipped。
- 验证：`tsc --noEmit` 0；全量 38 文件 **552 passed | 1 skipped**；`pnpm build` 成功（CJS 0.29kB、ESM 110.19kB、d.ts 10.76kB）；证据复现 25 份字节一致。
- 状态：G1/G2 仍绑第 31/36 轮旧候选，未签；`f6e10e6` 的 S2 pass 报告不能复用到 `bc1005a`，G1 也还没有 pass。下一步在 `bc1005a` 上派第四十四轮 S1/S2，重点复测 residual 去 id 后的本轮/双标签载荷、round36 覆盖点与清零正句、暂缓/繁体、A6/A7/A8b/A9、调度背压与真实 HTTP 并发、六项哈希与 25 份证据。

### 11.43 R5-A 协议拍板与 R5-B 事件层落地（2026-11-14 15:30，R5-B 候选）

- 第 44 轮双门仍签在 `caae193`；本次 R5-B 代码提交会改变 candidate，G1/G2 进入待第 45 轮重签状态，正式签署仍以 `caae193` 为准。
- 设计稿 `docs/design/agent-bridge-lifecycle.md` 已从“提议稿”改为拍板稿：事件流用 `AsyncIterable` 的 `BridgeEventSource.listen(params, signal)`；`subscribe()` 只做订阅确认，`fetchPage()` 补洞，`AbortSignal` 结束监听；`subscribe`/`listen` 之间不得丢事件，宿主必须能从 `fromSeq` 重放。
- ACK 以服务端本地持久确认为准：校验、查 receipt、同一 SQLite 事务追加 `node_run_events` + 写 receipt + 推进游标，提交成功后才算确认；`executor.ack` 只是宿主可选显式确认，禁止先 ACK 宿主再写账本。
- 三游标：`lastReceivedSeq`（收到最大，不持久化）、`lastContiguousSeq`（连续收到最大，不持久化）、`lastPersistedAckSeq`（连续落账并提交最大，持久化）。重启只信 `lastPersistedAckSeq`。同 seq 同 payload 幂等，同 seq 不同 payload 抛 `BRIDGE_SEQ_CONFLICT`。
- 迁移 `008_bridge_event_receipts.sql`：新增 `bridge_stream_cursors`（主键 `node_run_id, attempt, executor_agent_id`，`last_persisted_ack_seq`）与 `bridge_event_receipts`（同键 + `bridge_seq`，带 `payload_hash`、`ledger_seq`）。新 attempt 不继承旧游标。
- `BridgeEventBuffer` 改为三游标 + pending 暂存：收到 5 缺 3/4 时暂存 5、不推进连续位；补 3/4 后按 3/4/5 放行；`ack()` 只允许逐条推进且不超过连续收到位；构造时注入持久确认位，重启不从 0 开始。
- 新增 `src/executor/bridge-ledger.ts`：`BridgeLedger.ingest()` 是桥事件落账唯一入口，事务内校验跳号、查 receipt、追加 `bridge.<type>` 事件、写 receipt、推进游标；事务失败全部回滚。
- 测试：`tests/unit/bridge-buffer.spec.ts` 覆盖连续、缺口补洞、幂等/冲突、逐条 ACK、重启恢复；`tests/integration/bridge-ledger.spec.ts` 覆盖连续落账、重复/冲突、跳号、写事务失败、提交后重启、旧 attempt 隔离、宿主显式 ACK 失败不回滚、缺口不落账；`tests/unit/bridge.spec.ts` 补 `listen` 透传。
- 验证：`tsc --noEmit` 0；全量 39 文件 **565 passed | 1 skipped**；`pnpm build` 成功（ESM 110.22kB）。迁移 008 使 G-14 证据漂移，已重生成 `docs/gates/evidence/G1/G-14.md`；提交后用 `check-evidence-repro` 复核 26 份。
- 边界：R5-B 只做事件接收、排序、持久化、恢复，`run-node.ts` 未改；R5-C 才接 AgentLifecycle/BridgeConsumer/EvidenceCollector，R5-D 做 B01–B10，R5-E 第 45 轮独立审计后按 G1→G2 重签。R3 账本链头与单调耗时、R4 workflow 复合身份仍分开提交。

### 11.44 R5-B 独立审计 FAIL 与整改（2026-11-14 15:45，R5-B 复审候选）

- 独立审计 `r5b-auditor` 在 `871f118` 上 verdict **FAIL**：P0=0，P1=4，P2=8。克隆内 `pnpm install --offline --frozen-lockfile`、`pnpm typecheck`、定向 36 用例、全量 565 passed | 1 skipped 均跑过；主仓审计前后无改动，克隆已删。
- P1-1 缺口未补时重复收到 5：`push()` 返回 `gapFrom:null`。已改为所有重复/已确认分支统一 `currentGap()`，pending 非空时始终返回 `lastContiguousSeq + 1`。
- P1-2 重启后同 seq 不同 payload 不报冲突：构造器未查已落账 receipt。`BridgeBufferInit` 增加 `lookupPersisted(seq)`，`findStored()` 在本进程内存/本 attempt spill 之后回查已落账事件，冲突由 `assertSamePayload()` 抛出 `BRIDGE_SEQ_CONFLICT`；只比 `type + payload`，`at` 重建不误伤。
- P1-3 重启不恢复 spill：构造器调用 `loadSpill()`，按 `node_run_id + agentId + attempt` 前缀认回本 attempt 的 JSONL，按 seq 去重、跳过 `lastPersistedAckSeq` 之前的事件，恢复连续位与 pending 缺口。
- P1-4 跨 attempt 共 spill 文件：文件名改为 `spillPrefix()`（nodeRunId+agent+attempt），旧 attempt 不再追加进新 attempt；新增跨 attempt 互不串读用例。
- P2 整改：`ack(seq, persistedAckSeq)` 要求账本已提交位不小于确认位；`BridgeLedger` 的 `payload_hash` 改为 `{type,payload}`；receipt 的 `event_type` 与账本同为 `bridge.<type>`；`BridgeEvent` 增加可选 `attempt`/`executorAgentId`，缓冲与账本在字段存在时校验一致；回滚 trigger 改挂 `bridge_stream_cursors`，宿主显式 ACK 失败用例改成“落账→本地 ACK→宿主 ACK 抛错仍不回滚”；migrate 增补 008 复合主键隔离用例。
- P2-4 处理口径：008 已随 `34548b6` 推送，按“不得修改已发布迁移”不再改它；`CHECK`/外键留后续 010 重建表时补，当前由 `BridgeLedger` 写入前校验 attempt、seq、游标。设计 §6 已与实际 008 对齐，删除 `node_runs.bridge_ack_seq`/`bridge_last_seq`/`bridge_tool_outbox` 的旧描述，outbox 明确放 R5-C 的 009。
- 验证：`pnpm typecheck` 0；全量 39 文件 **572 passed | 1 skipped**；`pnpm build` 成功（ESM 110.22kB）；证据复现 25 份字节一致。
- 状态：R5-B 进入复审；R5-C 仍未开工。G1/G2 仍绑 `caae193`，第 45 轮重签要等 R5-C/D 与复审通过。

### 11.45 R5-B 复审 PASS 与 P2 收口（2026-11-14 15:55，R5-B P2 候选）

- `r5b-auditor` 在 `6d33ef8` 上复审 verdict **PASS**：P0=0、P1=0，四条旧 P1 全部闭合；克隆 `tmp/audit-r5b-r2`，定向 43 passed、探针 15 passed、全量 572 passed | 1 skipped，主仓审计前后 HEAD/工作树未变，克隆已删。
- 复审 P2-1：`lookupPersisted` 不能靠调用方自觉。`BridgeEventBuffer` 构造器现在对 `lastPersistedAckSeq > 0 && !lookupPersisted` 直接抛 `SCHEMA_VERSION_UNSUPPORTED`，避免重启冲突检测静默退化成“已收到”；补构造拒绝用例。
- 复审 P2-2：`readSpill()` 只容错文件末尾没有换行的半行，完整行损坏仍抛错；补“末尾半行后重启仍取回 1..3”用例。
- 复审 P2-4/P2-5：设计 §6 写明 `payload_hash` 前像为 `canonicalJson({ type: 裸 type, payload })`，从 receipt/账本回查先剥 `bridge.`；`listen(params, signal)` 的 `signal` 改为必填，与实现一致。
- P2-3（pending 未计入 `buffer_limit_bytes`）保留给 R5-C，在消费器接管 pending 时一并收紧；008 的 CHECK/外键按已拍板口径留 010。
- 验证：`pnpm typecheck` 0；全量 39 文件 **574 passed | 1 skipped**；`pnpm build` 成功（ESM 110.22kB）；G1/G2 仍绑 `caae193`，候选取本轮代码提交。
- 聚焦复审 `7cba5ca` verdict **PASS**：P0=0、P1=0；P2-1 错误码契约、P2-2 末尾半行、P2-4 哈希前像、P2-5 signal 必填均实测成立。复审克隆 `tmp/audit-r5b-r3`，定向 45 passed，全量 574（扣探针）| 1 skipped，主仓前后干净。
- 复审 P2 补全：`tests/unit/bridge-buffer.spec.ts` 增加 `err.code === 'SCHEMA_VERSION_UNSUPPORTED'` 断言；设计 §5.2 写明 `lastPersistedAckSeq > 0` 必须同时注入 `lookupPersisted(seq)`，缺回调拒绝构造。
- 状态：R5-B 库层、迁移层、测试层收口完成；R5-C 可以开工，接 `runNode()` 时必须注入真实 `lookupPersisted`。

### 11.46 R5-C 生产生命周期接线（2026-11-14 16:20，R5-C 候选）

- `RunNodeDeps` 增加必填 `bridge: BridgeClient` 与可选 `spillDir`；`runNodeActions()` 不再直接遍历 `p.tools` 执行，改为 `AgentLifecycle` 驱动：订阅 → 监听 → send 指令 → 宿主执行 `tool.call` → `toolResult` 回传 → 等结构化 report → 服务端 `submitReport()`。Agent 的自然语言与自报证据都不改账本。
- 新增迁移 `009_bridge_tool_outbox.sql`：`bridge_tool_outbox` 以 `(node_run_id, attempt, executor_agent_id, call_id)` 为主键，状态 `pending/completed/failed`；先插 pending 再执行工具，完成后写 completed，pending/failed 不盲目重跑，completed 幂等重发。
- 新增 `EvidenceCollector`：工具请求重新过 `registry.require` 与 `assertToolsAuthorized`，记录宿主真实 `startedAt/finishedAt`、`tool_started`、`tool_executions`、`tool_finished`，并回填 `execution_id/tool_seq/commandHash`；`traceEntries` 与 `lastEvidence` 只来自宿主执行。
- 新增 `BridgeConsumer`：`receive()` 入缓冲，缺口用 `fillGap()` 整页补，`drain()` 从 `ledger.cursor()+1` 连续落账，先 `ingest()` 再 `onEvent()` 最后 `ack()`；流提前结束且未 abort 时报 `SERVICE_UNAVAILABLE`。
- 新增 `AgentLifecycle`：`run()` 订阅后从持久游标 `listen`、发 `buildInstruction()` 指令、等 `{kind:'report'}`；报告事件不能在自己的 `onEvent` 里等 ACK（会自我等待），改为后台 `flush(5000)` 追平确认位后再 resolve。`stop()` 先 abort，再 `cancel → whenIdle → state → dispose`；`interrupted` 不当作已停止，未确认停止抛 `LEASE_EXPIRED`。
- 测试替身 `tests/fixtures/agent-bridge.ts` 按脚本发 `tool.call`，等 `toolResult` 再继续；每次 `listen` 用独立 `call_<listenIndex>_<n>`，取消不全局中止，避免并发节点串结果。
- 同步改造 `runtime.spec.ts`、`routes.spec.ts`、`execution-concurrency.spec.ts`、`production-path.spec.ts` 与 `scripts/fault-inject.ts`，生产执行路径全部注入桥；`runNode` 不再回退到预定义工具直跑。
- 修掉 Node 26 strip-only 不支持的 TypeScript 参数属性：`AgentLifecycle`、`EvidenceCollector`、`BridgeConsumer`、`BridgeLedger` 改为显式字段赋值，否则证据复现脚本在 `node` 直跑时报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
- 验证：`pnpm typecheck` 0；全量 39 文件 **574 passed | 1 skipped**；`pnpm build` 成功（ESM 136.90kB）；迁移 009 使 G-14 证据漂移，已重生成 `docs/gates/evidence/G1/G-14.md`（表数 18→20、schema_migrations 含 9）。
- 遗留：R5-D 故障注入 B01–B10、pending outbox 崩溃恢复、`buffer_limit_bytes` 计入 pending、R5-E 第 45 轮独立审计与 G1→G2 重签；R3 链头删除/单调耗时、R4 workflow 复合身份仍分开提交。

### 11.47 R5-C 审计整改（2026-11-14 16:35，整改候选）

- 独立审计 `r5c-auditor` 在 `d539e8b` 上 verdict **FAIL**：P0=0，P1=2，P2=7。旧 P1 已修：`lifecycle.stop()` 必须先于 `submitReport()`，停止未确认才能落 `blocked_post`；Agent 创建与 lifecycle 构造放进同一清理作用域，lifecycle 为 null 时按 agentId best-effort `cancel → whenIdle → state → dispose`。
- P2 整改：节点指令只列 `p.tools`，不再泄露 policy 全量工具；outbox completed 读取校验 `request_hash`，同 callId 换 tool/args 拒绝重放；工具起止改用真实墙钟，`tool_started` 带 `started_at`，`tool_finished` 带 `started_at/finished_at/duration_ns`；`stop()` 必须 idle 且 state 为 idle/unloaded/deleted；dispose 成功后清理本 attempt spill，`spillDir` 从 `executor.spillDir ?? opts.spillDir ?? bridgeSpillDirFromConfig(configPath)` 接线。
- 新增回归：stop 未确认时 `blocked_post` 且 `report_applied=0`；Agent 创建后 started 迁移失败仍释放宿主会话；B02 持久 ACK 重放、B03 整页补洞、B08 dispose 拒绝；runtime 的工具时间断言改为可解析且不倒挂，不再要求等于量化 `NOW`。
- 验证：`pnpm typecheck` 0；全量 40 文件 **586 passed | 1 skipped**；`pnpm build` 成功（ESM 140.61kB、d.ts 13.52kB）。B06 仍是事务级重放，不是独立进程强杀；真实宿主 `spawn` 端到端仍未验证。
- 状态：整改待提交；G1/G2 仍绑 `caae193`。下一步提交后请独立审计复审，再进 R5-D B01–B10 收口与 R5-E 第 45 轮重签。
- R5-D 起步补生产 spawn：`bridgeHostAgentFactory(client)` 把 `HostAgentFactory.create` 映射到 `BridgeClient.spawn`；`createOrchestra` 在 executor 没显式给 `agents` 时用它兜底，生产路径不再依赖外部顺手塞宿主工厂。单测断言 spawn 参数与返回值；全量 40 文件 **587 passed | 1 skipped**，build 成功（ESM 141.07kB）。该提交在 R5-C 复审候选之后，复审仍需按新 HEAD 复核 spawn 兜底。

### 11.48 R5-C 复审动作超时 P1 与 R5-D 收口（2026-11-14 16:43，待提交）

- 独立复审 `r5c-reaudit` 在 `d9f8cc1` 上 verdict **FAIL**：P0=0，P1=1，P2=6。4398baf 的两条 P1 与六条 P2 整改全部复核成立；新的 P1 是动作超时只 `abort`，`BridgeConsumer` 在 abort 时正常 return，`consume().catch` 不触发，`await report` 永不 settle，节点会永久停在 `started`。
- P1 修复：`AgentLifecycle.run()` 把 `report` 与 abort 竞速；`abortReason()` 统一把 `OPERATION_TIMEOUT` 原样抛出，超时不再挂在 waiter 上。新增 B11 动作超时回归（50ms，断言 `OPERATION_TIMEOUT`、耗时 <1s、仍走 cancel/dispose）。
- P2-1：`stop()` 改为 `stopTask` 单次入队，首次失败后 finally 再调不重发 cancel/dispose；新增 B12 断言 dispose 只调用一次。
- P2-2：runtime 工具时间断言加 `finished_at >= started_at` 且 `startedAt != NOW`。
- P2-3：`createExecutorAgent` 纳入 try；spawn 回包失败落 `startup_unknown`，不再留 `dispatched`，也不误写 `blocked_post`；新增 runtime 回归。
- P2-4：`bestEffortReleaseAgent` 按 `bridge_stream_cursors.last_persisted_ack_seq` 与 `bridge_event_receipts.MAX(bridge_seq)` 真实取值，不再用 0/0 绕过 `BRIDGE_ACK_LAG`。
- P2-5：`tests/fixtures/agent-bridge.ts` 的 `fakeAgentClient` 暴露 `calls` 并支持 `executor.spawn`；新增 E2E「省略 agents 走 bridge.spawn 兜底跑完 dispatch→done」。
- P2-6：`SpawnParams` 增加 `inheritHistory: false` 并由 `bridgeHostAgentFactory` 显式发送；单测同步断言。
- 验证：`pnpm typecheck` 0；全量 40 文件 **591 passed | 1 skipped**；`pnpm build` 成功（ESM 142.74kB / gzip 35.80kB、d.ts 13.60kB）。
- 状态：本轮整改待提交；G1/G2 仍绑 `caae193`。下一步提交推送后按新 HEAD 做独立复审；B06 仍是事务级重放，B07 外部取消通道仍未接生产，R5-D 尚未收口。

### 11.49 f662902 复审超时边界 P1 收口（2026-11-14 16:50，整改候选）

- 独立复审 `r5c-reaudit` 在 `f662902` 上 verdict **FAIL**：P0=0，P1=1，P2=4。七项复核中六项 PASS：stop 幂等、spawn 回包失败落 `startup_unknown`、bestEffort 使用真实游标、工具时间断言、省略 agents 的 E2E、`inheritHistory:false` 均成立。
- 残留 P1：动作超时只覆盖 `await report`；`subscribe` 与 `send` 自身仍可永久挂起，且 `aborted` 在 subscribe 之后才创建，send 慢于超时时会留下未处理拒绝；`spawn` 也没有应用层超时。探针复现 `PROBE3_SEND`/`PROBE3_SUBSCRIBE` 均 HANG，并出现未处理 `OPERATION_TIMEOUT`。
- `AgentLifecycle.run()`：`aborted` promise 提前到 `subscribe` 之前创建，并挂 `void aborted.catch(() => {})` 吃掉竞速另一侧的拒绝；`guarded()` 用 `Promise.race([task, aborted])` 同时包住 `subscribe`、`send`、`report`，三条路径都能被动作超时打穿。
- `runNode`：新增 `DEFAULT_STARTUP_TIMEOUT_MS = 30_000` 与 `RunNodeParams.startupTimeoutMs?`；`withTimeout()` 包住 `createExecutorAgent`，超时抛 `OPERATION_TIMEOUT` 后落 `startup_unknown`，不再永久停在 `dispatched`。
- P2-2：`bestEffortReleaseAgent` 的 ACK/MAX 查询与 dispose 全部移入同一个 try，查询失败不会覆盖原始 spawn/迁移错误。
- 回归：B13 订阅挂住、B14 发送挂住，均断言 <1s 内 `OPERATION_TIMEOUT` 且仍 cancel/dispose；B12 增加 cancel/idle 各一次断言；runtime 新增「spawn 挂住：启动超时落 startup_unknown」。
- 验证：`pnpm typecheck` 0；全量 40 文件 **594 passed | 1 skipped**；`pnpm build` 成功（ESM 143.34kB / gzip 35.96kB、d.ts 13.63kB）。
- 遗留：`startup_unknown` 仍无自动推进（sweep 只扫 `verifying`）；spawn catch 对确定性错误的分类仍偏宽；B06 仍是事务级重放，B07 外部取消通道仍未接生产。G1/G2 仍绑 `caae193`。

### 11.50 f662902 复审 report 未处理拒绝与配置时限（2026-11-14 16:55，整改候选）

- 独立复审 `r5c-reaudit` 在 `6efcbeb` 上 verdict **FAIL**：P0=0，P1=1，P2=4。六项复核成立：subscribe 超时可打穿、send 超时可打穿、spawn 应用层超时落 `startup_unknown`、B12 cancel/idle/dispose 各一次、bestEffort 游标查询已入 try、B13/B14 主路径通过。
- P1：`report` 在 `send` 挂起期间被 `consume` 拒绝时还没有 handler，形成 `unhandledRejection`；探针 `PROBE7_SEND_REPORT` 实测 `unhandled:1`，Node 默认会因未处理拒绝退出。
- 修复：`report` 创建后立即挂 `void report.catch(() => {})`; 只兜住“send 未返回”这段窗口，后面的 `guarded(report)` 仍然把真实错误抛出，不吞结果。
- 新增 B15：`listen` 立即失败、`send` 挂起，断言最终 `OPERATION_TIMEOUT`、`unhandledRejection` 为空；B13 补 `dispose` 断言；runtime spawn 挂住补“无 blocked_post 事件”断言。
- P2-1 同步收口：`createOrchestra` 新增 `executionLimitsFromConfig()`，把 `execution.action_timeout_ms`、`startup_timeout_ms`、`verify_timeout_ms` 注入 `runNode` 与 `dispatcher` 的节点参数；配置缺失时仍用 `runNode` 默认值。
- 验证：`pnpm typecheck` 0；全量 40 文件 **595 passed | 1 skipped**；`pnpm build` 成功（ESM 143.84kB / gzip 36.05kB、d.ts 13.63kB）。
- 遗留：`startup_unknown` 仍无自动推进；spawn catch 对确定性错误的分类偏宽；B06 仍是事务级重放，B07 外部取消通道仍未接生产。G1/G2 仍绑 `caae193`。

### 11.51 3b8c980 复审 stop RPC 无界 P1 收口（2026-11-14 17:05，整改候选）

- 独立复审 `r5c-reaudit` 在 `3b8c980` 上 verdict **FAIL**：P0=0，P1=1，P2=3。已闭合 report 未处理拒绝、B13/B14/B15、runtime spawn 断言、executionLimits 注入；新 P1 在 stop 路径：`cancel`/`whenIdle`/`state`/`dispose` 都是无界 `await`，`cancel` 永不回包时 `stop()` 永久挂起，节点停在 `started`，心跳继续续租，Agent 不释放。探针 `PROBE9_STOP {"outcome":"HANG","status":"started"}`。
- `AgentLifecycle` 增加 `stopRpcTimeoutMs`（默认 2s）与 `bounded()`，四个收口 RPC 各自限时；超时抛 `OPERATION_TIMEOUT`，后续状态复核不通过仍落 `LEASE_EXPIRED`。B16 覆盖 cancel 挂住：2s 上限后继续用 whenIdle/state 完成确认并 dispose。
- `runNode` 记录 `stopFailure`，stop 失败导致的收口错误归因为 `agent_stop_unconfirmed`，不再误写成 `action_timeout`/`agent_execution_failed`；runtime 新增「state RPC 挂住：限时落 blocked_post，report_applied=0」。
- P2 分类收口：spawn 明确返回 4xx 类 `OrchError` 时落 `blocked_pre`（`agent_spawn_rejected`）并跳过外层 markBlocked，只有超时/传输错误才落 `startup_unknown`；超时后底层 spawn 晚到的会话用 `bestEffortReleaseAgent` 兜底释放。新增 runtime 回归。
- P2 配置收口：`executionLimitsFromConfig()` 改为文件不存在才回退默认值；文件存在但非法时 `loadConfig` 抛错，不再静默吞配置错误。
- 验证：`pnpm typecheck` 0；全量 40 文件 **598 passed | 1 skipped**；`pnpm build` 成功（ESM 145.59kB / gzip 36.45kB、d.ts 13.63kB）。
- 遗留：`startup_unknown` 仍无自动推进（sweep 只扫 `dispatched`/`started` 的租约过期）；B06 仍是事务级重放，B07 外部取消通道仍未接生产。G1/G2 仍绑 `caae193`。

### 11.52 R5-C 复审 PASS（a281e5f，2026-11-14 17:10）

- `r5c-reaudit` 在 `a281e5f` 上 verdict **PASS**：P0=0 / P1=0 / P2=4；克隆 `tmp/audit-r5c-r5`，工作树干净。
- 复核成立：stop 四个 RPC 各自 2s 上限；state/dispose 挂住约 2.07s 落 `blocked_post`、`report_applied=0`、`verify_human.reason=agent_stop_unconfirmed`，state 只调一次、未误 dispose；`stopTask` 保证 finally 二次调用不重发 RPC；spawn 4xx 落 `blocked_pre`、超时落 `startup_unknown`、晚到会话被释放；坏配置 `SCHEMA_VERSION_UNSUPPORTED` fail-fast。
- 复跑：install 0、typecheck 0、定向 44 passed、全量 **598 passed | 1 skipped**、build 0（ESM 145.59kB / gzip 36.45kB、d.ts 13.63kB）。
- P2-1（口径）：cancel 超时后 whenIdle/state 已确认 idle 时节点落 done；按设计第 243-249 行「idle + state 确认」判 P2，若要求 cancel 超时本身即阻断则升 P1。
- P2-2：`bestEffortReleaseAgent` 的 cancel/state/dispose 仍无单次上限；晚到 spawn + cancel 挂住会留宿主会话。
- P2-3：spawn 回包缺 agentId 的 `PROTOCOL_VERSION_MISMATCH` 被归为确定性失败落 `blocked_pre`，宿主可能已建会话。
- P2-4：配置非法时 `openServiceOrchestra` 先开 db，`createOrchestra` 抛错后 db 未关，删除临时目录报 EPERM。
- 已知遗留：`startup_unknown` 仍无自动推进/sweep。
- 状态：R5-C 可进 R5-D；G1/G2 仍绑 `caae193`，未签门。

### 11.53 R5-D 起步：外部取消接生产 + R5-C 复审 P2 清理（2026-11-14 17:14）

- 新增 `src/service/execution-cancels.ts`：`ExecutionCancels.register(nodeRunId, attempt)` 返回 AbortSignal，`abort()` 只打对应 `node_run+attempt`，`release()` 清槽；旧 attempt 的取消不会打断新 attempt。
- `src/index.ts`：`Orchestra.cancels` 暴露注册表；`executeNode` 注册信号后传给 `runNode`，`finally` 释放；`commands.cancel` 在 `submitCancel` 落账后对非 `already_stopped` 结果 `abort` 当前 attempt。
- `src/executor/run-node.ts`：`RunNodeDeps.cancelSignal?`；起跑前已取消直接拒绝；`AgentLifecycle.run` 使用该信号；报告与收口之间再查一次 aborted，取消后不写 done；catch 在 `cancelSignal.aborted` 时跳过 `blocked_post`，已由 cancel 路径落 `timing_out/stopping`。
- R5-C 复审 P2 清理：
  - P2-2：`bestEffortReleaseAgent` 的 cancel/whenIdle/state/dispose 全部包 2s `withTimeout`，晚到会话不再无界挂住。
  - P2-3：`isDeterministicSpawnFailure` 改为显式白名单（FORBIDDEN/TOOL_NOT_ALLOWED/TOOL_NOT_REGISTERED/RUN_TOOL_NOT_READ_ONLY/VERIFIER_TOOL_POLICY_MUTATING/PAYLOAD_SCHEMA_INVALID）；`PROTOCOL_VERSION_MISMATCH` 不再冒充宿主明确拒绝，落 `startup_unknown`。
  - P2-4：`openServiceOrchestra` 在 `createOrchestra` 抛错且 orchestra 未建时关闭已打开的 db，避免临时目录 EPERM。
- 测试：新增 `tests/unit/execution-cancels.spec.ts` 3 tests；runtime 新增「spawn 回包缺 agentId 落 startup_unknown」「runNode 外部取消不写 blocked_post」「commands.cancel 经注册表 abort 正在跑的 runNode」。
- 验证：typecheck 0；全量 **604 passed | 1 skipped**（41 files）；build 成功（ESM 147.74kB / gzip 37.02kB、d.ts 14.00kB）。
- 未完成：B06 仍是事务级重放，不是独立进程强杀；B07 的生产取消已接，但独立 kill 场景仍需补。
- 状态：11d08fd 已提交并推送。

### 11.54 B06 独立进程强杀（2026-11-14 17:15）

- 新增 `tests/fixtures/crash-collector-child.ts`：独立 Node 进程打开同一个账本库，先写 outbox pending 与 `tool_started`，宿主工具写 marker 后挂住；父进程看到 marker 后 `SIGKILL`。
- `tests/integration/runtime.spec.ts` 新增「B06 独立进程：工具副作用已发生、回传前 SIGKILL，恢复时只能人工核实，不能重跑」：子进程被杀后，父进程用同一 callId 重放，命中 pending outbox 抛 `EVIDENCE_SOURCE_UNAVAILABLE`，marker 仍只有一次，证明恢复不会盲目重跑。
- 首次失败是 request_hash 不一致：子进程 `timeoutMs:60_000`，父进程重放 `timeoutMs:5_000`；统一为 60_000 后通过。request_hash 覆盖 tool/args/cwd/timeout，测试两侧必须完全一致。
- 验证：typecheck 0；全量 41 文件 **605 passed | 1 skipped**；build 成功（ESM 147.74kB / gzip 37.02kB、d.ts 14.00kB）。
- 状态：B06 独立进程已覆盖；B07 外部取消已接生产，缺独立进程 kill 场景。G1/G2 仍绑 `caae193`。

### 11.55 B07 真实子进程强杀与 stop 顺序修复（2026-11-14 17:18，f959542）

- `tests/integration/agent-lifecycle.spec.ts` 的 B07 改为真实子进程：`spawn(process.execPath, ['-e', 'setInterval(...)'])` 作为工具进程，宿主 `run` 写 marker 后等 `exit`；`commands.cancel` 发 SIGKILL；`stop` 必须确认 `exitCode` 或 `signalCode` 非空才允许 dispose。
- 首次失败是 `stopInternal` 顺序死锁：先 abort 再 `await this.running`，但 running 卡在工具执行，cancel 永远发不出去。修复为 `abort → bounded(cancel) → bounded(running) → whenIdle/state → dispose`，`bounded(running)` 防工具不响应 abort 时无限等待。这是生产修复，不只测试。
- 第二次失败是 SIGKILL 后 `child.exitCode` 仍为 null，`state` 误判 running；改为 `exitCode === null && signalCode === null` 才 running，断言改为 `exitCode !== null || signalCode !== null`。
- 验证：typecheck 0；全量 41 文件 **605 passed | 1 skipped**；build 成功（ESM 147.78kB / gzip 37.03kB、d.ts 14.00kB）。
- 状态：B06/B07 均已独立进程级；B04/B05 由 bridge-ledger/bridge-buffer 覆盖。G1/G2 仍绑 `caae193`，待 R5-D 全量收口后进 R5-E 第 45 轮独立审计。

### 11.56 R5-E：G2-16 桥生产闭环门项（2026-11-14 17:21，待审计）

- `scripts/gate-check.ts` 的 G2 规格新增 `G2-16`（Agent Bridge 生产闭环：B01–B10 可复现，工具证据只来自宿主执行），必过项 19→20；新增不变量 `I12`（事件先落账再确认、强证据只认宿主 `ReadOnlyToolRunner.runTool()`、取消先确认停止、崩溃恢复不盲目重跑）与证据映射 `ev-g2-16`。
- 新增 `docs/gates/evidence/G2/ev-g2-16.md`：B01–B10 落点矩阵、B06/B07 注入前后状态、对账查询、桥闭环 6 文件 68 passed 与全量 605 的复现命令；LF SHA-256=`a92dae5e96ef7aa990c6f224f0ba06db7941bfd720b4ef80349d60f07919fe51`。
- `docs/gates/G2.md`：顶部结论 20 项；必过表补 G2-16；证据表补 ev-g2-16；不变量表补 I12；GateArtifact 的 `must_pass_items`、`evidence`、`invariants` 三处同步；复现命令补桥闭环定向命令。历史段落仍保留当时轮次的“19 项”。
- 验证：`pnpm typecheck` 0；`pnpm vitest run tests/gate/gate-check.spec.ts` 183 passed | 1 skipped；桥闭环 6 文件 68 passed。
- 状态：G2 的四个哈希与 artifact_hash 仍是旧值，等第 45 轮独立审计通过后再按 G1→G2 顺序重签；G1/G2 正式门仍绑 `caae193`。

### 11.57 第 45 轮 S1/S2 双 FAIL 与整改（2026-11-14 17:36，待第 46 轮复审）

- S1 对 `3b779b6` 判 FAIL（P0=0/P1=2/P2=5）：P1 是 B06 冷态 5s 超时与 ev-g2-16 的 B01 过度声明；P2 是 B03/B06/B07 证据时序与 B07 dispose 顺序未钉。
- S2 对同一候选判 FAIL（P0=0/P1=2/P2=4，20 项 13 pass / 7 fail）：P1 是 5/30 证据重跑漂移（`G-05`、`ev-g2-01/08/10/14`）与 G2-16 的 68 tests 不可复现；P2 是 B03 缺账本断言、桥消费先推进持久游标再 `onEvent`。
- B06 超时根因：`child.kill('SIGKILL')` 之后才挂 `once(child,'exit')`，exit 可能在挂监听前发出；改为 spawn 后立即挂监听，`waitFor(marker,20s)`，kill 后 `await exited`，用例 30s 上限。
- 取消/停止测试补齐：B01 在 run 失败后真正 `stop()` 并断言 cancel/dispose 各一次；B07 在 dispose 回包里断言 `exitCode/signalCode` 已非空；新增“取租约前已取消不产生 lease_acquired”用例。
- S2 P2-4 修复：迁移 `010_bridge_handled_seq.sql` 给 `bridge_stream_cursors` 加 `last_handled_seq`；`BridgeLedger` 新增 `handled()`/`markHandled()`；`BridgeConsumer.drain()` 改成 `ingest → onEvent → markHandled → buffer.ack`，重连与 dispose 都从已处理位取值，不再从已落账位跳过未处理事件。
- 证据重生成：5 份 G2 证据与 `G1/G-14` 按新事件序列/迁移 010 重生成；另发现 `G1/ev-migrate` 指向的 `tests/integration/migrate.spec.ts` 在 R5-B 已变，G1 表哈希一并更新。
- 验证：typecheck 0；6 文件桥闭环 **70 passed**；全量 41 文件 **607 passed | 1 skipped**；build 成功（ESM 149.00kB / gzip 37.18kB、d.ts 14.00kB）；gate 定向 183 passed | 1 skipped。
- 状态：G2 仍绑旧审计，pre-sign gate-check 预期失败；本轮候选只为第 46 轮 S1/S2 复审，审计 pass 后再按 G1→G2 重签。

### 11.58 第 46 轮 S1 PASS / S2 FAIL 与 G2-03 证据时钟修复（2026-11-14 17:51，待第 47 轮复审）

- S1 对 `9cefb87` 判 G1 **PASS**（13/13，P0/P1/P2=0），全量连跑 5 次、桥闭环 4 次均稳定；G2 交叉核查另提两条 P2：G2.md 桥闭环 68→70、ev-g2-16 的 B10 落点漏 `bridge-ledger.spec.ts`。
- S2 对同候选判 G2 **FAIL**（P0=0/P1=1/P2=3）：P1 是 `ev-g2-03` 演示“迟到上报被接受”（accepted:true），与 G2-03“租约过期迟到上报被拒”相反；根因是 `ServerDeps.now` 已存在但 `scripts/fault-inject.ts` 的 `bootHttp()` 未注入时钟，租约与上报实际只差约 5ms。
- 修复提交 `c17a0c7 fix(r5e): drive lease expiry from server clock and align G2 evidence`（4 files，+17/−13，已推）：
  - `HttpBootOpts` 新增 `now?: () => string`，`bootHttp()` 条件式传给 `startServer`。
  - `caseEvG203` 用可变服务端时钟从 `EV_NOW` 推到 `+5000ms`，租约 TTL 1000ms 后上报；重生成后 `HTTP=409 LEASE_EXPIRED`、`report_applied=0`、节点仍 `dispatched`。
  - `docs/gates/evidence/G2/ev-g2-03.md` LF SHA-256=`5929f803fadbbeabe0a9f9b5b0b65d2d52b429017eaceab56388f165d83d29be`。
  - `docs/gates/G2.md` 修 70 项与真实测试路径；`ev-g2-03`/`ev-g2-16` 两处哈希同步；`ev-g2-16` 收窄“真实工具进程”表述并补 B10 的 `bridge-ledger.spec.ts` 落点，新 LF SHA-256=`4414fae1c349b9e3acadaebc9c63a3e63968565705561e02651c23755537e278`。
- 验证：typecheck 0；全量 41 文件 **607 passed | 1 skipped**；build ESM 149.00kB / gzip 37.18kB、d.ts 14.00kB；gate 定向 183 passed | 1 skipped；`check-evidence-repro.ts` 提交后 25/25 全绿。
- 已派 `s1-audit-r47`（G1）与 `s2-audit-r47`（G2），clone `tmp/audit-s1-r47`、`tmp/audit-s2-r47`，候选均 `c17a0c7`；要求全量 3 次、桥闭环 2/4 次、证据复现、build，报告写 round47，不改主树、不签门。
- 状态：G1/G2 正式门仍绑旧候选；两份 round47 报告都 PASS 后，先提交报告，再按 G1→G2 重签并双门 gate-check exit 0。

### 11.59 第 47 轮双审计 PASS 与 G1/G2 重签（2026-11-14 18:04）

- `s1-audit-r47` 对 `c17a0c7` 判 G1 **pass**：13/13，P0/P1/P2=0；全量连跑 3 次 607 passed | 1 skipped，桥闭环 2 次 70 passed，证据复现 25/25，build 0；报告 `docs/audits/S1-independent-audit-round47.md`，LF SHA-256=`5941e387099e8f86b4f9990e61ca225fb966df25e3706610895c67593cae6d4d`。
- `s2-audit-r47` 对同候选判 G2 **pass**：20/20，P0/P1/P2=0；全量 3 次 607，桥闭环 4 次 70，必过路径 124 tests，证据复现 25/25，20 份 G2 证据哈希全一致；报告 `docs/audits/S2-independent-audit-round47.md`。
- 报告已提交 `abcb4f4 docs(audit): record round47 independent audit passes` 并推送。
- G1 重签：`docs/gates/G1.md` 的 `audit_round=47`、`audit_report=docs/audits/S1-independent-audit-round47.md`，提交 `0b0d924` 后跑 `node --no-warnings scripts/sign-gate.ts docs/gates/G1.md`，再提交 `854bbf9`。artifact_hash=`a9c19a59e88807f402f7f3c185744a7bbb02f0b4c4ab1b3118029f3b76606b6b`，candidate=`5c1f4c7249df…`，13 份证据。
- G2 重签：同法改 `audit_round=47`、`audit_report=docs/audits/S2-independent-audit-round47.md`，提交 `ff7676a` 后签名并提交 `f6bddb4`。artifact_hash=`7e9e1c316464…`，candidate=`669b5abc610f…`，20 份证据；`previous_artifact_hash` 取自已提交的 G1。
- `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` → exit 0（13 项必过、13 份证据哈希复核）；G2 → exit 0（20 项必过、20 份证据哈希复核）。
- 签后复跑：`pnpm test` 41 files **607 passed | 1 skipped**，exit 0；`pnpm typecheck` exit 0；`pnpm build` exit 0（ESM 149.00kB / gzip 37.18kB）；`check-evidence-repro.ts` 25/25 exit 0。
- 说明：sign-gate 在候选清单里会探测历史已删除测试路径，stderr 出现若干 `fatal: path ... does not exist`，但退出码 0，随后门检查与全量均通过；不是签名失败。
- 当前正式门：G1 audit_round=47、G2 audit_round=47，双门 exit 0。
- 遗留：R3 链头 DELETE/同事务严格 seq/prev_hash、工具真实耗时；R4 workflow_id+version 复合身份；P2-04 审计证据引用；S3 九节点与状态机未开。

### 11.60 R4 工作流复合身份（2026-11-14 18:20，待第 48 轮审计）

- 问题：`workflow_versions.version` 是主键、`WorkflowCatalog.defs` 按版本单键，两个不同工作流不能各自拥有版本 1；`runs`/`tasks` 虽有 `workflow_id` 列，生产建 run 路径不写，执行器与收口只按版本取目录。
- 迁移 `011_workflow_version_identity.sql`：重建 `workflow_versions`，主键改为 `(workflow_id, version)`；旧数据全部复制为 `workflow_id='default'`；保留 `version` 索引。
- `src/service/workflows.ts`：
  - `DEFAULT_WORKFLOW_ID='default'`、`workflowIdOf(def)`；`WorkflowDefinition.workflow_id?` 可选，缺省即 default。
  - 目录内部键改为 `workflow_id + '\u0000' + version`；两参 `get/definitionHash/toolPolicyFor/policyFor` 精确取，单参保持旧调用，但同版本号跨多个工作流时抛 `WORKFLOW_VERSION_CONFLICT`，不猜。
  - `definitionHashOf` 对 `default`/缺省 id 剥掉 `workflow_id` 再哈希，旧库 content_hash 与 G1 证据不因命名空间改名漂移；非 default 的 id 参与哈希。
- `src/service/runs.ts`：`CreateRunParams.workflowId?`；任务、run、`task.created`/`run.created` 事件都写 `workflow_id`；结果增加 `workflow_id`。`src/service/server.ts` 与 `schemas.ts` 的 `POST /v1/runs` 接可选 `workflowId`，`POST /v1/workflows/load` 接可选 `workflow_id`。
- `src/executor/run-node.ts` 与 `src/service/commands/apply-report.ts`：从 run 读 `workflow_id` 并按其取工具授权/判定条件；旧行 null 归 default。
- 测试：`tests/integration/workflow-identity.spec.ts` 3 例（两工作流同版本建 run 不串、单参歧义拒绝、旧口径归 default）；`workflows.spec.ts` 增复合身份与歧义 2 例；`tests/fixtures/ledger.ts` 的 `bindRunVersion` 同步写 `workflow_id`；runtime 与 G-05 夹具的 `workflow_id` 改成 `default`。
- 证据：迁移 011 使 `G1/G-14`、`ev-g2-01`、`ev-g2-07`、`ev-g2-15` 的 `schema_migrations` 片段变化，已用 `fault-inject.ts` 重生成并连跑两遍字节一致；新 LF SHA-256：G-14=`d655af7e2b77f3736aee6422e2e3e133d4f936a6572a82c98a40a4877740de39`，ev-g2-01=`71825a7db387884c2b9148dc991dc1415b2bb0d0605d05fb780a0990626a76a6`，ev-g2-07=`64fa6c33ed9f4b33f5f8cc2306a8ad618d99d06ce1698e7aa1c8b537beeae05d`，ev-g2-15=`8c21ebd8e00ea8563f910fd2f3b3beb96b678812260620c9d0f05480e1f7ca6d`。G1/G2 表与 artifact 已同步。
- 验证：typecheck 0；全量 42 文件 **612 passed | 1 skipped**；build 成功（ESM 152.60kB / gzip 37.89kB、d.ts 14.30kB）。
- 状态：候选改动未提交，门记录仍绑第 47 轮候选；pre-sign gate-check 预期失败。下一步提交候选，派 S1/S2 第 48 轮审计，pass 后按 G1→G2 重签。
- 遗留：R3 链头 DELETE/同事务严格 seq/prev_hash、工具真实耗时；P2-04 审计证据引用；S3 九节点与状态机未开。

### 11.61 第 48 轮双审计 PASS 与 G1/G2 重签（2026-11-14 18:28）

- `s1-audit-r48` 对 `41a450f` 判 G1 **PASS**：13/13，P0=0/P1=0/P2=6；全量 3 次 612 passed | 1 skipped，桥闭环 2 次 70，evidence-repro 25/25，build 0；报告 `docs/audits/S1-independent-audit-round48.md`，LF SHA-256=`ef14a8abc921a6364a66b786dd3f003acaab0e4d88a604f7e3e7dff0d4211007`。
- `s2-audit-r48` 对同候选判 G2 **PASS**：20/20，P0=0/P1=0/P2=2；全量 3 次 612，桥闭环 4 次 70，必过路径 124 tests，R4 定向探针 29/29，G2 20/20 证据哈希一致；报告 `docs/audits/S2-independent-audit-round48.md`。
- 两份报告已提交 `0a226a6`；S2 报告补了门/候选绑定行与 `audit-verdict` 结构化裁决，LF SHA-256 最终=`da7f2792bddc2a5153f85e1ed9f50096b65230138852d4f8b24610d03a9fbde8`。S2 报告原有 P2-1（ev-g2-16 计数 607→612）与 P2-2（G2-15 写清 workflow_id）仍留在报告里，未在签前改证据；G2-15 固定表文本由 gate-check 常量锁定，不能单独改。
- G1 重签：`audit_round=48`、`audit_report=docs/audits/S1-independent-audit-round48.md`，提交未签版 `a902a72`，签后 `699d717`；artifact_hash=`6a6c010ed83d67ccb0953632dec46c85c9542d16bcd25a995b89ab14708df9d0`，candidate=`014d1fca3a07…`。
- G2 重签：同法改 `audit_round=48`、`audit_report=docs/audits/S2-independent-audit-round48.md`，`previous_artifact_hash` 取已签 G1；中间因 S2 报告缺绑定行/裁决块、证据改动触发候选复用拒绝而回退，最终提交 `9af5fc5`；artifact_hash=`4481775c3a63…`，candidate=`d93fb55325c1…`。
- 双门 gate-check 均 exit 0：G1 13 项必过、13 份证据；G2 20 项必过、20 份证据。签后全量 **42 files 612 passed | 1 skipped**。
- 遗留（P2，未阻断）：S1 六条——hydrate 不交叉校验行键与快照、旧库内嵌 workflow_id 升级边界、workflow_id/version 未限控制字符与首尾空白、011 数据升级缺正式回归测试、契约测试手写 workflow_id、run-node 未复核 run 绑定哈希；S2 两条——ev-g2-16 计数、G2-15 措辞。
- 下一步：R3（012 链头触发器 + `appendNodeRunEvent` 严格化 + 测试/证据），或先补 011 正式迁移回归与 workflow_id 输入约束；R4 已闭合。

### 11.62 R3 链头数据库级保护（2026-11-14 18:30）

- 迁移 `012_node_run_chain_guard.sql` 加四道触发器：事件 INSERT 必须接链头（`seq=last_seq+1`、`prev_hash=last_hash`；无链头则 `seq=1`、零哈希）；链头 INSERT 必须恰好对应 seq=1 的首条事件；链头 UPDATE 只能 `+1` 且必须对上新事件与旧哈希；链头 DELETE 直接拒绝。
- `src/infra/db/ledger.ts` 的 `appendNodeRunEvent`：链头缺失但已有事件时抛 `SCHEMA_VERSION_UNSUPPORTED`，不再凭事件行补写；链头写入由 UPSERT 改为按有无链头分别 INSERT / UPDATE——SQLite 的 UPSERT 冲突时也会先触发 BEFORE INSERT，被新链头守卫误拦（首条后第二次追加即失败），分开写后守卫只拦真正的越权写入。
- 测试 `tests/integration/ledger-integrity.spec.ts` 增 7 例：DELETE 链头、UPDATE 跳号、UPDATE 到无事件、INSERT 跳号事件、链头缺失仍追加、新链首条、无首条事件直接插链头；原「清空链头」用例改为先卸删除触发器再删，验证 `verifyLedger` 报「链头记录缺失」。
- 证据：G-14 的 `schema_migrations` 增加 12，重生成后 LF SHA-256=`afb074b7fe5a087fb62d9f720503a672e21c02e266fca458c6166eeebe8ae18c`，G1.md 表与 artifact 已同步。
- 验证：typecheck 0；全量 **42 files 619 passed | 1 skipped**；build ESM 152.57kB / gzip 37.94kB、d.ts 14.30kB。
- 下一步：提交候选、跑证据复现，派第 49 轮 S1/S2 审计并重签双门；再补 R4 的 011 升级回归与 workflow_id 输入约束。

### 11.63 第 49 轮双审计 PASS 与 G1/G2 重签（2026-11-14 18:48）

- `s1-audit-r49` 对 `ce8c2e6` 判 G1 **PASS**：13/13，P0/P1/P2=0/0/2；全量 3 次 42 files / **619 passed | 1 skipped**，桥闭环 2 次 70 passed，typecheck/build/evidence-repro 均 0；报告 LF SHA-256=`e3efae6e8e8c8fdff3642de09a260d3a826cac51c827b84c455778589a50e7c0`。P2 是门记录待重签与「触发器只校验结构、不校验 HMAC 且可被 DDL 删除」，后者由 `verifyLedger` 兜底。
- `s2-audit-r49` 对同候选判 G2 **PASS**：20/20，P0/P1/P2=0/0/2；全量 3 次 619/1、桥闭环 4 次 70、必过路径 124 tests、证据复现 25/25；报告 LF SHA-256=`463ca76cd980bd46d096dda799ac7356cfc434e3fc2c71d2ba848492da7cad66`。P2：① `INSERT OR REPLACE INTO node_run_chain_heads` 可绕过 DELETE 触发器重置链头，但 `verifyLedger` 会报条数缺口、后续追加会主键冲突；② `ev-g2-16` 辅助的 `pnpm test` 行仍写 41/607，实际 42/619，桥闭环 70 本身四次一致。
- 两份报告已提交 `19827a5`；G1 改 `audit_round=49`、报告路径后提交 `1bdd1f2`，签名再提交 `8d392eb`，artifact_hash=`55093169b74d03d886bb638fa14710bb7cbd174caca7bb1e3b4a1948b239e2f4`；G2 改同两项与 `previous_artifact_hash` 后提交 `a90acfc`，签名再提交 `9947e20`，artifact_hash=`935aaf65ff05…`。
- 双门 `gate-check` 均 exit 0（G1 13/13 证据、G2 20/20 证据）；签后全量 **42 files 619 passed | 1 skipped**、evidence-repro 25/25。
- 下一步：补 R4 的 011 正式升级回归、workflow_id/version 输入约束、run-node 绑定哈希复核；把 `INSERT OR REPLACE` 链头重置与 ev-g2-16 计数放进下一候选；再开 S3 九节点与状态机。
- 遗留：P2-04 审计证据引用；R5 桥闭环已完成，S3 未开。

### 11.64 R4/S2 的 P2 收口与第 50 轮候选预签（2026-11-14 18:55）

- 链头 REPLACE 绕过：新增迁移 `013_node_run_chain_head_replace_guard.sql`，链头 INSERT 时若同 `node_run_id` 已有链头直接 abort，补 012 的 DELETE 守卫看不到的 REPLACE 冲突路径；测试用 seq=1 的 hash 构造能过首条校验的载荷，断言被拒且链头仍是 `last_seq=2, event_count=2`。
- R4 P2：`workflows.ts` 增加 `WORKFLOW_IDENTITY_PATTERN` 与长度上限，`load()` 算哈希前校验；`hydrate()` 交叉校验行键与快照身份，不一致抛 `WORKFLOW_VERSION_IMMUTABLE`；`schemas.ts` 对 `workflow_id`/`workflowId` 与版本号做同一约束；`run-node.ts` 取工具授权前复核 `runs.workflow_definition_hash`，不一致在 spawn 前拒绝。
- 测试：`workflow-identity.spec.ts` 3→6 例（非法身份、hydrate 交叉校验、001–010→011–013 旧库升级），`ledger-integrity.spec.ts` 21 例，`runtime.spec.ts` 23 例；定向 50 tests 全过。
- 证据：`G-14` 更新为 13 步迁移，`ev-g2-16` 计数改 42/624，G2-15 文案改「同一工作流的同一版本」；G-05 注入补齐 `workflow_definition_hash` 绑定。全量 **42 files 624 passed | 1 skipped**、typecheck 0、build ESM 154.88kB / gzip 38.52kB、evidence-repro 25/25。
- 预签：`docs/gates/G1.md`、`G2.md` 的证据索引、candidate、artifact/body 自锚已重算，`audit_round` 仍 49，门检查停在审计锚点，属第 50 轮正式审计前的预期态。候选提交 `c5e0014`。
- 下一步：派 S1/S2 第 50 轮审计；双 PASS 后提交报告并按 G1→G2 正式重签，双门 exit 0。

### 11.65 第 50 轮双审计 PASS 与 G1/G2 重签（2026-11-14 19:05）

- `s1-audit-r50` 对 `bad3326` 判 G1 **PASS**：13/13，P0/P1/P2=0/0/2；全量 3 次 42 files / **624 passed | 1 skipped**，桥闭环 2 次 71 passed，typecheck/build/evidence-repro 均 0；报告 LF SHA-256=`355a1a582b5584c0c4e0d96be69a651b013021b837b396079642d4c4782996f9`。P2：预签态 artifact 仍指第 49 轮；011 升级时旧 definition_json 内嵌非 default workflow_id 会被 hydrate 拒启动（fail-closed）。
- `s2-audit-r50` 对同候选判 G2 **PASS**：20/20，P0/P1/P2=0/0/1；全量 3 次 624/1、桥闭环 4 次 **71**、必过路径 125 tests、证据复现 25/25、20 份 G2 证据哈希一致；报告 LF SHA-256=`b386173930739945624a358f80e5b94365dc462281dc627796898905d9520de7`。P2：`ev-g2-16` 桥闭环计数仍写 70，`runtime.spec.ts` 新增用例后实际 71。
- 报告已提交 `5f9f8e9`；G1 绑定第 50 轮后提交 `2eb7377`，artifact_hash=`1c0903777d79bf86ed0ebc6ff54349965dbd4778e429b155b494fba2b7875b97`，body_hash=`e3b7a0ddcb1ca23d2d0da7d8b42c8d02dbe2a24a6a0c61aca7d32e4b214ba22f`；G2 绑定后提交 `abffd35`，artifact_hash=`c5b4564a40669b44179dd10e01059f6ec92b5816cf2cf15e86046055501f4d5a`，body_hash=`daec42cc20f3d5ee5a57b959502d9dbd9a9ec5072bfe906c383e66bf10132a4a`。
- 双门 `gate-check` 均 exit 0（G1 13/13、G2 20/20 证据复核）；签后全量 3 次 **624 passed | 1 skipped**、build ESM 154.88kB / gzip 38.52kB、evidence-repro 25/25。
- 下一轮 P2：把 `ev-g2-16` 桥闭环计数改 71、必过路径 125（改了要重新生成证据并重签）；补 P2-04；再开 S3 九节点与状态机。

### 11.66 S3 Task 1–5：迁移表、CAS、决策卡、半态时钟（2026-11-14 19:16）

- S3 正式开工。迁移编号顺延到 014/015（计划里的 010/011 已被 R4 与桥迁移占用）。
- `src/core/state-machine.ts` 新增 M-01…M-61 迁移规则表：58 条状态规则 + 2 条建行规则 + 1 条挂起闸门，带触发语义、终态/挂起闸门与半态分叉（M-18/M-19、M-28/M-29/M-30、M-61）。旧 `ALLOWED_TRANSITIONS` 保留，S2 调用方不受影响。
- 迁移 `014_node_run_transitions.sql`：补 `hang_reason`、`contradiction_decision_id`、`origin_node_run_id`、`replacement_node_run_id`，建 attempt 唯一索引与来源唯一索引。
- `src/service/commands/nodes.ts`：单条 CAS `applyTransition`（from 集合、attempt、action_generation、`hang_reason IS NULL`，patch 列白名单）与 `createNodeRun`（新 attempt 接班，旧行只接一次）。
- 迁移 `015_decisions.sql` 与 `src/service/commands/decisions.ts`：八种 decision kind、五种状态、run 级与节点级活跃唯一索引；`resolveDecision` 支持 approved/rejected/expired 收口与 confirm/continue/uphold 续版；`escalateDecisions` 满 2h 升 blocked_for_human、满 24h expired，`report_contradicted` 不参与。
- `src/core/half-state.ts`：半态集合、跨 boot 剩余量（停机不计入、回拨夹 0）、桥断冻结矩阵（startup/action 继续、unknown/verify 冻结、timing_out 不累计）、`rearmFromRemaining`（0 立即到点、NULL 才补满额）。
- 测试新增 `tests/integration/transition-rules.spec.ts`（8）、`node-runs.spec.ts`（6）、`decisions.spec.ts`（6）、`half-state.spec.ts`（5）；提交 `f5149ce`、`63f2266`、`0e1f980`、`e4c2df9`、`1d57249`。
- 验证：typecheck 0；全量 **46 files 649 passed | 1 skipped**；build ESM 155.15kB / gzip 38.57kB、d.ts 14.30kB。
- 缺口（明确未完成）：迁移表尚未接到 `transitionNode` 生产路径；014 的 `verify_remaining_ns`/`startup_unknown_remaining_ns` 读点与恢复重挂尚未接；Task 6–15（审批、policy/branch、并行、wait、子流程、补偿、报告冲突、恢复扫描、G3 故障注入、起运行命令）未做；014/015 已使 G-14 与 ev-g2-16 计数过期，证据与门要等 S3 收口后统一重生成。
- 下一步：Task 6 审批与 blocked_pre 放行；随后按计划 7–15 推进，最后统一重生成证据、派第 51 轮双审计并重签。候选推送待本轮收口。

### 11.67 S3 Task 6：审批往返与不可逆前置审批（2026-11-14 19:17）

- 迁移 `016_approval_binding.sql` 给 `node_runs` 补 `resume_state`/`blocked_decision_id`，给 `decisions` 补 `content_hash`/`expires_at`。
- `decisions.ts` 增 `ensurePreExecutionDecision`：仅 `irreversible` 自动开 `pre_execution` 卡，已有活跃同 kind 复用；`openDecision` 落内容哈希与有效期。
- `nodes.ts` 增 `enterBlockedPre` 与 `resumeFromBlockedPre`：进入时清租约并记 `resume_state`；批准要求卡 `resolved/approved` 且内容哈希一致，回 queued 且 attempt 不变；拒绝或超时落 failed；旧租约、内容漂移、过期批准分别报错。
- 测试 `approval.spec.ts` 7 例；typecheck 0，全量 **47 files 656 passed | 1 skipped**。
- 提交 `efb6d81`（5 files，+433/−4）。

### 11.68 S3 Task 7：policy 求值与 branch 路由（2026-11-14 19:21）

- `src/core/policy.ts` 增九算子、显式 all/any/not、深度 32 与正则校验、固定裁决载荷；`evaluatePolicy` 对数组根按 all 求值，未命中给出 `必过项未通过：<id>`。
- 同文件增 `BranchEdge`/`validateBranchEdges`/`chooseBranch`：多命中不按 priority 猜，零命中有 default 走 default，否则 no_match。
- `src/service/commands/nodes.ts` 增 `applyBranchRoute` 与 `recordPolicyEvaluation`：多命中在动状态前抛 `BRANCH_AMBIGUOUS`；无命中先开 `rule_ambiguous` 卡再落 `blocked_post`；选中只追加 `policy.evaluated`。
- 测试 `tests/integration/policy-branch.spec.ts` 18 例；定向 18/18，typecheck 0，全量 **48 files 674 passed | 1 skipped**，build ESM 155.15kB / gzip 38.57kB、d.ts 14.30kB。
- 缺口：branch 路由尚未接进 `run-node` 执行器；`blocked_post` 的后续人工收口与 `rule_ambiguous` 处置在 Task 8 之后接；证据仍待 S3 收口统一重生成。
- 下一步：提交 Task 7，随后 Task 8 并行分支与 join。

### 11.69 S3 Task 8：并行汇聚与不可逆子节点闸（2026-11-14 19:24）

- 迁移 `017_parallel_groups.sql`：`node_runs.parent_node_run_id`、`side_effect_policy`（pure/compensable/irreversible），`runs.settling` 与 `pending_irreversible_children_json`，父节点索引。
- `src/service/commands/parallel.ts`：all/any/quorum 收敛（quorum 只认 done、缺省过半数）、未收口不可逆子节点派生、默认不许进组、取消分级、`refreshRunSettling` 从账本重算并只在变化时落 `run.settling_changed`、`assertRunCanTerminal` 挡住带未收口不可逆子节点的运行。
- `cancel.ts` 对 `side_effect_policy='irreversible'` 的节点直接 `FORBIDDEN`；`lease.ts` 的 `NodeRunRow` 补父运行与副作用策略。
- 测试 `tests/integration/parallel.spec.ts` 6 例；定向 6/6，typecheck 0，全量 **49 files 680 passed | 1 skipped**，build ESM 155.40kB / gzip 38.63kB、d.ts 14.30kB。
- 缺口：扇出建子节点与 join 尚未接进 `run-node` 执行器；`run.settling_changed` 的读侧与恢复扫描未接；证据仍待 S3 收口统一重生成。

### 11.70 S3 Task 9：wait 事件 inbox、登记与唤醒（2026-11-14 19:26）

- 迁移 `018_wait_registrations.sql`：节点增 `wait_started_at`/`wait_deadline_at`；新建 `wait_event_inbox`（幂等键唯一）与 `wait_registrations`（每节点一条、active/woken/timed_out/cancelled，记 `cursor_seq`、匹配事件与唤醒派发饥饿计数）。
- `src/service/commands/wait.ts`：`recordWaitEvent` 先落 inbox；`enterWaiting` 把 `started→waiting` 与建登记、清 executor 租约、`bumpRearm` 放同一事务，并回扫早到事件；`wakeOnEvent` 先记账再回放全部 active 登记；`scanRegistration` 命中后先 CAS 改 woken 再迁 `waiting→dispatched`，重复调用不落第二条；`markWakeStarvation` 与 `timeoutWaiting` 分记 `wait.wake_dispatch_starvation` / `wait.event_timeout`；`sweepWaitTimeouts` 可重入，`cancelWait` 只撤登记不改节点。
- `src/service/commands/nodes.ts`：`PATCH_COLUMNS` 增 executor 绑定与 wait 时钟列；`TransitionRequest.bumpRearm` 让迁移与 Gr+1 同条 UPDATE。
- 测试 `tests/integration/wait.spec.ts` 6 例；定向 6/6，typecheck 0，全量 **50 files 686 passed | 1 skipped**，build ESM 155.40kB / gzip 38.63kB、d.ts 14.30kB。
- 缺口：wait 尚未接进 `run-node` 执行器；唤醒后的优先级派发与 slot 重抢未接；组结束时撤组内登记未接；证据仍待 S3 收口统一重生成。

### 11.71 S3 Task 10：子流程 pin、深度/环与取消传播（2026-11-14 19:30）

- 迁移 `019_subworkflow_runs.sql`：`runs` 增 `parent_run_id`、`parent_node_run_id`、`root_run_id`、`subworkflow_depth`、`resume_from`、取消请求字段；父节点唯一子运行索引与父 run 索引；旧行回填 `root_run_id = run_id`。
- `src/service/commands/subworkflow.ts`：
  - `assertSubworkflowGraph` 按**递归栈**判环（菱形共享子流程不误报）、深度上限 2、pin 必须正整数，返回子图最大副作用策略（pure < compensable < irreversible）。
  - `createSubworkflowRun` 只按显式 pin 取版本，缺版本报 `WORKFLOW_SUBWORKFLOW_VERSION_MISSING`；同一父节点重复调用幂等返回，换 pin 报 `OPERATION_ID_CONFLICT`；祖先链递归 CTE 再判一次环；库层深度超过 2 直接拒。
  - `startSubworkflowNode` 把子运行创建与 `started→waiting` 放同一事务；`finishSubworkflowChild` 只在子运行终态后唤醒 `waiting→dispatched`，重复调用幂等。
  - `propagateRunCancellation` 把取消请求落到每个子 run，对可取消节点调 `applyCancel`，不可逆节点跳过；`assertNoOpenChildRuns` 挡住未收口子运行。
  - `parallel.ts:assertRunCanTerminal` 同时调用子运行闸，父 run 不再能先于子 run 收口。
- `runs.ts` 新建根 run 时写 `root_run_id = run_id`、`subworkflow_depth = 0`。
- 测试 `tests/integration/subworkflow.spec.ts` 12 例：环、深度 2/3、菱形 DAG、策略取最大、非法 pin、pin 不存在、父节点非 started、运行前祖先环、pin 版本落库与幂等、库层深度、waiting 唤醒、取消传播与终态闸。
- 验证：typecheck 0；定向 12/12；全量 **51 files 698 passed | 1 skipped**；提交 `257c133`。
- 缺口：子流程节点尚未接进 `run-node` 执行器；有效副作用策略还没接到前置审批；子运行补偿逆序留给 Task 11；证据仍待 S3 收口统一重生成。

### 11.72 S3 Task 11：补偿幂等与未验证副作用落账（2026-11-14 19:32）

- `src/core/canonical.ts` 增 `compensationId(nodeRunId, attempt, descriptorVersion)`：canonical_json + SHA256，同组合必得同 id。
- 迁移 `020_compensations.sql`：可执行补偿按 `compensation_id` 唯一；无可执行补偿 `compensation_id` 为 NULL，按 `(node_run_id, attempt)` 唯一标 `kind='none'`；状态 `running/applied/failed/unverified/skipped`。
- `src/service/commands/compensation.ts`：
  - `assertCompensationDescriptor` 缺工具、验证命令或 descriptorVersion 报 `COMPENSATION_UNEXECUTABLE`。
  - `startCompensation` 同一幂等键只插一行、只发一条 `compensation.started`；同版本换工具/参数报 `OPERATION_ID_CONFLICT`。
  - `settleCompensation`：applied 保留节点原状态；failed/unverified 落 `failed_with_unverified`，attempt 与 Gr 都不变，发 `compensation.failed`。
  - `registerNoExecutableCompensation` 以 NULL compensation_id 幂等落账，再落 `failed_with_unverified`，不许落普通 `failed`。
- 测试 `tests/integration/compensation.spec.ts` 9 例：同 id、非法描述符、重放一行一事件、换参数冲突、失败落账、applied 不改状态、终态不可改判、NULL 幂等、done 不被降级。
- 验证：typecheck 0；定向 9/9；全量 **52 files 707 passed | 1 skipped**；build ESM 155.45kB / gzip 38.65kB、d.ts 14.30kB。
- 缺口：补偿执行器尚未接进 `run-node`；`settleCompensation` 的调用方（取消/失败收口）未接；补偿证据的固定字段集与 artifacts 写盘仍待接；证据待 S3 收口统一重生成。

### 11.73 S3 Task 12：报告冲突与 uphold 收口（2026-11-14 19:36）

- `apply-report.ts` 增 `ApplyDecision` 与可选 `decision` 入参；挂起节点（`hang_reason='report_contradicted'`）的普通出口抛 `STALE_HANG`，只认 `uphold_report` / `uphold_decision` 两条路。
- `raiseReportContradiction`：只允许 `startup_unknown` / `indeterminate_side_effect`，复用或新开 `report_contradicted` 决策卡，同一事务写 `hang_reason`、`contradiction_decision_id` 并清 `startup_unknown_deadline_at` / `startup_unknown_remaining_ns`。
- `uphold_report`：先 CAS 决策卡 revision，再走原有 schema/判定/证据门收口 `done`/`failed`，清挂起字段。
- `uphold_decision`：决策卡收口 `uphold_decision`，旧行 `superseded`，新 attempt 从旧行接班为 `queued`，迟到报告落 `stale`。
- `createNodeRun` 增挂起闸：旧行 `hang_reason` 非空时，新 attempt 报 `STALE_HANG`；`uphold_decision` 先清挂起字段再建新行，所以合法。
- `resolveDecision` 把 `uphold_report` 收口为 `closed_reason='approved'`、`uphold_decision` 保留同名原因；`report_contradicted` 仍不参与 2h/24h 自动升级。
- 测试 `tests/integration/apply-report.spec.ts` 新增 6 例：普通出口 `STALE_HANG`、`uphold_report` 清闸落 done、`uphold_decision` superseded+新 attempt、revision 过期节点不动、新 attempt 被挡、冲突卡不过期。
- 验证：typecheck 0；定向 61/61；全量 **52 files 713 passed | 1 skipped**；build ESM 164.32kB / gzip 40.86kB、d.ts 14.30kB。
- 缺口：`confirm_applied` / `confirm_not_applied` 分支尚未实现；`raiseReportContradiction` 尚未接 HTTP 命令与 run-node；uphold 事件与恢复扫描的联动未接；证据待 S3 收口统一重生成。

### 11.74 S3 Task 13：可重入恢复扫描（2026-11-14 19:38）

- `sweep.ts` 改 `SweepParams`：`now`、可选 `clock`、可选 `bridgeMissing`；`SweepResult` 增 `chain_broken`、`startup_unknown_expired`、`bridge_paused`。
- 恢复前逐节点验 `node_run_events` 哈希链，断链节点进入 `chain_broken` 并整轮跳过，租约扫描也不碰。
- 优先级 `recoverySkip`：终态、`hang_reason` 非空、`indeterminate_side_effect`、`stopping`、`timing_out`、`paused_bridge_missing`、`startup_unknown` 不被桥断扫描改写。
- 桥断：只认显式 `bridgeMissing` 信号，`applyTransition` 到 `paused_bridge_missing` 并写 `resume_state=原状态`，事件 `recovery.bridge_missing`；重复扫描不追加。
- `startup_unknown` 到点：`applyTransition` 转 `indeterminate_side_effect`，清启动未知钟，`bumpRearm`，事件 `recovery.startup_unknown_expired`；重复扫描不再动。
- 租约扫描改走 `applyTransition`（普通出口带 `hang_reason IS NULL`），并接受 `skipNodeRunIds`。
- 测试 `tests/integration/sweep.spec.ts` 增 3 例：桥断挂起与幂等、startup_unknown 到点转未知态且不重复、断链节点整轮跳过（临时拆只追加触发器模拟库外破坏）。
- 验证：typecheck 0；定向 12/12；全量 **52 files 716 passed | 1 skipped**。
- 缺口：`bridgeMissing` 尚无生产运行时信号源；executor 失联、动作到期、回执过期三类扫描未接；启动锁仅由 SQLite `BEGIN IMMEDIATE` 提供，未加显式 advisory lock；证据待 S3 收口统一重生成。

### 11.75 S3 Task 14：G3 故障注入与 61 条迁移用例（2026-11-14 19:43）

- `scripts/fault-inject.ts` 增 `G-06`/`G-12`/`G-16`：工具结果丢失后同 callId 重试只重发结果、审批双击同 revision 只赢一笔、父 run 取消向子 run 传播且跳过不可逆节点。
- 修 `injectQueued` 使用独立 `node_id=n2`，避免 014 的 `(run_id,node_id,attempt)` 唯一索引与种子 `nr1/n1` 撞车；G-03/G-04/G-07 同步修好。
- 新增 `tests/integration/g3-faults.spec.ts` 6 例：G-01/G-02/G-04/G-06/G-12/G-16 各自调用 `runCase` 并断言恢复后的账本对账文本。
- 新增 `tests/integration/migration-cases.spec.ts` 62 例：61 个 id 全覆盖、58 条状态规则逐条正例、错误触发/目标拒绝、M-01/M-58 建行规则、M-56 挂起闸、终态源无 allowTerminal 拒绝。
- 验证：typecheck 0；G3 定向 68/68；全量待跑。
- 缺口：`docs/gates/G3.md` 与 `GATE_SPECS.G3` 尚未落，等 Task 15 完成后按第 51 轮独立审计再签；六份 G3 证据尚未写盘。

### 11.76 S3 Task 15：起运行命令与自治档位（2026-11-14 19:50）

- 迁移 `021_start_run_autonomy.sql`：tasks 增 autonomy/escalations_json；decisions 增 approver/resolved_by/confirm_required；新表 start_run_operations 保证 operation_id 幂等。
- `startRun`：workflow_version 必填、operationId 必填，默认 autonomous，越界档位与非法 escalations 直接拒；同 operation_id 重放返回同一 task/run 且 replayed=true，换 id 不合并。
- `setTaskAutonomy`：按 expected_revision CAS，落 task.autonomy_changed 事件；冲突方整笔拒绝。
- 批准人：`defaultApprover` 把 pre_execution/action_overrun/verify_human 与 irreversible 归 human，audit_result 归 either；`assertApprover` 要求 agent 带 orchestra.audit 且不得是证据产出者。
- `openDecision` 生成时按 kind/action_category 写默认 approver，补写 confirm_required；`resolveDecision` 带 actor 时校验批准人并写 resolved_by。
- 超时分档：`timeoutDisposition` 只有 supervised 为 hold_for_human，autonomous/assisted 到 24h 按默认动作 expired_final；`decisionConfirmRequired` 把任务 escalations 翻成 confirm_required。
- 测试：start-run 10 例、approver 5 例；typecheck 0；全量 **56 files 799 passed | 1 skipped**；build ESM 169.20kB / gzip 42.03kB、d.ts 14.47kB。
- 缺口：HTTP 命令面未开（计划明确只建任务与 run）；approver 的加载期能力位授予留 S5；证据待 S3 收口统一重生成。