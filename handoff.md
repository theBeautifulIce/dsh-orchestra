# dsh-orchestra 接手指引（handoff）

> 面向「任何人（包括三个月后的自己）拿到这个目录就能继续干活」写的。
> 最后更新：2026-11-12 02:39。本文件在项目根目录，遵 dshQQ 硬约束第 5 条。
> 配套：`codebasemap.md`（代码与图谱在哪）、`docs/requirements.md`（主人要什么）、`docs/design-notes.md`（为什么这么设计）。

---

## 0. 一句话

**dsh-orchestra** 是要给 DSH（DeepSeek Harness）做的一个**编排插件**：把「跑一个 agent 任务」这件事变成有状态、可恢复、可审计的节点图，
每个节点的状态、证据、代次都落在 SQLite 账本里，崩溃/断线/宿主退出后能扫回来继续跑。

现在做到哪：**第三段（九种节点图）v23 已在第二十五轮审计拿到 pass；第四段（面板与查询）设计稿 v33 已按第三十四轮 pass 收口；第五段（记忆插件对接）v37 已按第三十八轮 pass 收口，v38 清了两条非阻断措辞；第六段（分阶段落地与验收）v41 已按第 41 轮 5 重大 / 5 措辞修入，2437 行、496260 bytes，待第 42 轮送审；面板原型 v11 已把全部可见字号抬到 12.5px 以上（导航 13px），1600/1366/1200/1024 共 56 个上下文无页面溢出、无报错，只保留画布与窄屏任务侧栏的横向滚动区，等主人评审；插件源码还没写。**

---

## 1. 三十秒现状

| 项 | 状态 |
| --- | --- |
| 规则设计稿 `docs/orchestra-design-draft.md` | 2437 行 / 496260 bytes / SHA256 `E047DFD0292F8703AFAB3FB650B0D37BE581B1A1A5B58D9FA4E93EEBD6CF56C2`；第五段 v38 已过第 38 轮；第六段 v41 已修第 41 轮 5 重大 / 5 措辞，待第 42 轮送审 |
| 审计台账 `docs/orchestra-audit-ledger.md` | 逐轮记录；第三段第 25 轮 pass；第四段第 31 轮 pass、第 32/33 轮 fail、第 34 轮 pass；第五段第 35/36/37 轮 fail、第 38 轮 pass，v38 清两条措辞已记；第六段第 39 轮 fail（1 致命 / 15 重大 / 5 措辞），21 条已修；第 40 轮 fail（0 致命 / 9 重大 / 4 措辞），v40 已修；第 41 轮 fail（0 致命 / 5 重大 / 5 措辞），v41 已修，待第 42 轮送审 |
| 原始需求 `docs/requirements.md` | 已写（R1–R23 主人原话 + 拍板口径 + 验收标准） |
| 设计思路 `docs/design-notes.md` | 已写（16 条决策 + 五个坑族 + 风险清单） |
| 代码图谱索引 `codebasemap.md`（根） | 已写（三份参考图谱 + 本项目文档图谱） |
| 参考项目 `references/` | 三份已克隆并建图谱 |
| **源码** | **没有。还没开始写。** |
| 面板原型 `docs/prototype/panel-v2.html` | v11 单文件浅色原型；任务看板、任务流程三栏（任务 / 步骤 / 现场）、流程页画布与真实发布门禁、全局搜索、决定弹窗与签字接手；无彩色左侧色条，全部可见字号 ≥12.5px（导航 13px），四档宽度无页面溢出 |
| 图谱 | `pi-harnessmm` 124/294、`dsh-superagent-prototype` 2012/8492、`DS-Bot` 10539/33229、`dsh-orchestra-docs` 97/96 |

---

## 2. 目录地图

```
D:\aboutAI\dsh-orchestra\
├─ handoff.md            ← 你正在读的这份（接手入口）
├─ codebasemap.md        ← 代码/图谱在哪、怎么更新、要看哪块用哪个工具
├─ docs\
│  ├─ orchestra-design-draft.md   ← 规则条文唯一权威（2437 行，v41，第六段待第 42 轮送审）
│  ├─ orchestra-audit-ledger.md   ← 逐轮审计台账（见 §五）
│  ├─ prototype\panel-v2.html     ← 面板 v10 单文件原型（浅色、可点击、字号已抬）
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

### 4.1 当前状态：第五段第 38 轮 pass；第六段 v41 已修第 41 轮 5 重大 / 5 措辞，待第 42 轮送审（2026-11-12 03:02）

第三段 v23 已在第二十五轮拿到 **pass**（0 致命 / 0 重大 / 3 条非阻断措辞），三条遗留措辞已在 v24 清理，不再单开第三段轮次。

第四段 v24–v32 已送第二十六至第三十四轮。第三十一轮判 **pass：0 致命 / 0 重大 / 3 条非阻断措辞**，三条已在 v30 清；第三十二轮判 **fail：1 致命 / 6 重大 / 1 措辞**（发布回执晚于业务事务、CAS 与版本触发器顺序、触发器只升、重复边/自环码、空草稿名、已消费草稿优先级、子流程环与 depth、publish_note 范围），八条已逐条修入 v31；第三十三轮判 **fail：1 致命 / 4 重大 / 2 措辞**（发布 CAS 漏 workflow_id、历史指针仍指旧清单、WORKFLOW_NOT_FOUND 未进命令路径、based_on_version 未写入、title/name 未进保存层、保存层摘要与触发器映射措辞），七条已逐条修入 v32，送第三十四轮。

v30 新增「流程定义编辑」写模型：§4.6.5 四个命令、§4.12 定义校验与发布门禁、§14.3 三张表（`workflows` / `workflow_versions` / `workflow_drafts`）、Q-37…Q-42；v31 把发布写成单事务并统一写序，补触发器只升、重复边/自环码、空草稿名、已消费草稿优先级、子流程环与 depth 口径。v32 把三处发布写序收拢到 §4.6.5 一份权威模板（workflow_id + COALESCE、先查 workflow 404、based_on_version、草稿消费 revision + published_version IS NULL、事件与回执同事务），把 title/name 的 1–80 字校验与两个 422 错误码放进保存层，并把所有历史指针统一指向当前 §3.4u。

v33 在第 34 轮 pass 后只清四条收口项：`workflow.open_draft` 的三种草稿分支单独写（已有草稿 → DRAFT_EXISTS；已消费 → 重置 based_on_version、清 published_version、revision+1；从未发布 → NOT_PUBLISHED）；名称校验拆成 create 校验 `payload.name` 与 `definition.name` 一致、update 只校验 `definition.name`；Q-39 补 create 的 `payload.name` 81 字用例；L946 的「逐字一致」改为「语义一致」。终稿 1528 行、387116 bytes、SHA256 `78F9ED9209330B3671219951416DD7778D872295292C92ACA3039504D6266E26`，§3.4u 仍是唯一 `[CURRENT]` 清单，Q 共 42 条。

第五段 v37 把记忆写入拆成两条通道：直接通道保留插件 audit.js 的 fail-open；受控通道由核心大脑发起独立 memory run `sys.memory_write@1`，新增 `memory.evaluate` / `memory.apply_governed` / `memory.inspect_batch` 三个内部端口，固定图 `mem_trigger → mem_prepare → mem_check → mem_route → ready/mem_confirm(audit_result) → mem_apply → mem_report`；新增 memory_batches / memory_items / memory_evaluations / memory_run_requests 四表、Q-43…Q-63；写入只收 decision_id，三道核对、原子、幂等，source 带 orchestra 元数据。v37 已按第 37 轮 fail 的 3 致命 / 4 重大 / 3 措辞修入：哈希原像白名单与 canonical 排序、tool.result 丢失时批次保持 applying 与同批次节点重试、audit_result 复用为 mem_apply 前置批准、toolRef 前缀统一、Q-44c 错误层、批准后 client_key 只读、inspect_batch 计数与三处措辞；v37 终稿 2082 行、447818 bytes、SHA256 `B7D7475B735773A085955CCACD19DB6E5EAFC8A100E89A86DD3031409DCE6C94`；第 38 轮判 pass（0 致命 / 0 重大 / 2 条非阻断措辞），两条已在 v38 清理（inspect_batch 返回体显式带 batch_id、apply 重算引用 canonical_proposal），v38 2081 行、448133 bytes、SHA256 `7872A5442ECE77950CAFDD7A5CF175331E0B10177D4463CAA9D33264578A78B5`；第五段闸门已开，进入第六段。

第六段 v39 已按第 39 轮 fail 的 1 致命 / 15 重大 / 5 措辞逐条修入：线上账本只追加、备份只恢复到独立目录、按事件日志重放（RPO=0）；阶段开关绑能力表；S6 完成口径改为 G6 + R1 + R2，G6 定为发布候选门；G6 双 artifact 交叉核对；G2 用 paused_bridge_missing 派生 blocked；G-04/G-06/G-12 按阶段能力归位；补对比度/p95/隔离区/账本时间/队列/P1 判据；辅门签字规则；I4 终态证据表；I10 收窄；终态集合改指第二段 §8；branch 读 policy；GateArtifact 与门记录八段对齐；双向兼容窗口；F8 十种 resolution；G-14–G-16 三类注入并给 G-01–G-16 逐条回滚动作。终稿 2377 行、482650 bytes、SHA256 `DBB091C39415275C7C2C58E5DACB538CC6872C073AE70B54AE900F3A7ED947EC`；第 40 轮送审中（子代理 `5e2ff1da-4102-4a28-94c2-c35440178bad`，messageId `0b1f4355-500e-4abb-85a4-693ca8898b1c`）。

第六段 v40 已按第 40 轮 fail 的 0 致命 / 9 重大 / 4 措辞修入：门 run 终态沿用第二段 §8 五值、policy 输出 `decision=pass|fail`、I4 证据表覆盖 node_run 与 run、辅门失败只追加补记不改主门结论、GateArtifact 去自指并补四个 canonical 哈希与八段映射、EventView 改 `occurred_at` 并按 boot_id+monotonic_ns+seq 处理时钟跳变、G-01/G-14 改条件回退、补门×注入矩阵与 G2 parallel 拒绝；S6 顺序统一为 R0→G6→R1→R2 且 R0 不计入。终稿 2409 行、487617 bytes、SHA256 `0C5FB3490E9C3FE0061AA1A883ACFFFC3194CC296CC4DF3BA1445003D43D7606`；第 41 轮送审中。

第六段 v41 已按第 41 轮 fail 的 0 致命 / 5 重大 / 5 措辞修入：run 终态由 run 外收口器在门 run 结束后直抄 `runs.status`，run 内节点一律不读本 run 终态，部署脚本同时校验 `conclusion=pass` / `run_terminal=succeeded` / `gate_run_id` 指向的 run 仍为 succeeded；policy 只判 policy 之前节点全部终态且无未验证副作用；I4 的 run succeeded 行只留 done 强证据与 superseded 无副作用证据，abandoned_unverified 归 succeeded_with_unverified；GateArtifact 字段与八段一一对应，`must_pass_items[]` 逐项，`artifact_hash=` 锚点固定在补记之前；canonical_json 集合数组升序去重；截止字段成对带 boot_id/monotonic_ns，跨 boot 用 boots 投影扣 downtime，跳钟/漂移转 timer_uncertain；G-06/G-11 改先保持 applying、对账确认部分写入后才转 indeterminate；W1–W4 与 G1/G-15、G-01/G-14 阶段口径同步。终稿 2437 行、496260 bytes、SHA256 `E047DFD0292F8703AFAB3FB650B0D37BE581B1A1A5B58D9FA4E93EEBD6CF56C2`；待第 42 轮送审。

- 画布与智能体同写一份 `WorkflowDefinition`；草稿可改、发布版本不可变；版本号连续，发布只影响之后新建的 run。
- 图校验分两层：保存层允许不完整草稿，只拒无法解析、超限、重复 id、边端点不存在、坐标非法；发布层要求恰好一个 trigger、全图可达且无环、出度纪律、branch route、subworkflow pin 与深度。
- 读模型补 `WorkflowView.current` 空态、§4.8 索引与 §14.3 对齐；Q-38 / Q-39 补并发发布与扇出用例。

面板原型 `docs/prototype/panel-v2.html` 已到 v11：浅色、低密度、任务流程三栏（任务 / 步骤 / 现场）、流程页画布与真实发布门禁、全局搜索、决定弹窗与签字接手；无彩色左侧色条。v11 把菜单、表头、卡片元信息、流程节点、抽屉与弹窗的可见字号统一抬到 12.5px 以上，导航 13px；`@media (max-width:1180px)` 下任务列表改四列并隐藏时间列，流程行改成可换行，流程大脑统计独占一行，消灭了 1024 宽的挤压。`.tmp/audit-v11.js` 在 1600×1000、1366×900、1200×900、1024×900 实测 56 个上下文：over=0、screenOver=0、smallTotal=0、errs=[]；仅画布 `.wf-canvas-shell` 与 1024 宽的任务侧栏 `.tw-rail` 保留横向滚动，这是设计本身。`.tmp/modal-audit.js` 另测七个弹窗（评审记录、新建任务、新建工作流、试运行、新版本、设置、智能体接口）：small=[]、bad=[]；只有智能体接口的代码块保留自身横向滚动。主人会自己打开看，不再截图。

### 4.2 下一步：送第六段第 42 轮并等回包，原型继续等主人评审

1. 第六段 v41 已修第 41 轮 5 重大 / 5 措辞，待送第 42 轮；pass 前不写 spec。
2. 原型按主人评审意见继续改：浅色、低密度、人话、任务做到哪一步/发生了什么/结果/下一步；主人自己打开，不再截图。
3. 第六段 pass 后六段全过，才写 spec、自审、提交、交主人审。
4. 每次改稿后同步版本号、SHA256、行数与台账，改完提交 git。

> ⚠️ 第三段内改稿时**不要**新增顶层 `##` 标题（会打乱「三段」的叙事结构）；从第四段起按六段路线新增 `## 第四段 …`，不要改动前三段标题。不要删 §3.4b–§3.4m 的历史清单（它们是审计轨迹），不要在别的章节另写一份终态枚举（**终态集合只在 §8 写一份**）。

---

## 5. 六段路线与当前进度

| 段 | 内容 | 状态 |
| --- | --- | --- |
| 一 | 骨架与落点（桥 / 生命周期 / 控制面） | ✅ 完成（设计稿 L5–L96） |
| 二 | 把「硬」落成规则（17 条：node_run 字段、代次、证据、半态、超时、重试、sweep、迁移表、声明式判定、版本、身份账本、payload、上下文预算、存储、边界、事件、来源分离） | ✅ 完成（L97–L418） |
| 三 | 九节点图（§3.0 两类契约 → §3.5） | ✅ 完成（v23，第二十五轮 pass；§4.1） |
| 四 | 面板与查询 | ✅ 完成（v33，第三十四轮 pass；原型 v11 待主人评审） |
| 五 | 记忆插件对接 memory-audit-v1 | ✅ 完成（v37 第 38 轮 pass；v38 清两条措辞；5.1–5.14，Q-43–Q-63） |
| 六 | 分阶段落地与验收 | 🔄 v41 已修第 41 轮 5 重大 / 5 措辞，待第 42 轮送审 |

六段全过之后才写 `docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md`、自审、提交 git、交主人审阅，再转 `writing-plans`。

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
- 关键提交：`f7da467` agent skills 配置、`750c89f` v20 送审、`8b68b44` v21 收口、`d9a0c1e` v22 收口、`bdf9c17` v23 收口（第三段送审版）、`3e7ccc8` v27 送第 29 轮 + 原型 v7、`bb64f0b` 原型 v8 去掉彩色左条、`f7dde5e` v29 送第 31 轮 + 原型 v9、`99ca50e` v32 送第 34 轮、`462bfa9` 原型 v10 字号收口 + 设计 v31、`2136866` 原型 v10 绘图细节、`5f759e7` v33 第四段收口、`ce36151` v35 第五段修第 35 轮 13 条、`5c391b1` v36 第五段修第 36 轮 7 条并送第 37 轮、`33b093e` v37 第五段修第 37 轮 10 条并送第 38 轮。
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

第四段 v33 已收口；第五段 v34 初稿已送审，待回包；按 §4.2 等审计，并收原型反馈。
