# dsh-orchestra 接手指引（handoff）

> 面向「任何人（包括三个月后的自己）拿到这个目录就能继续干活」写的。
> 最后更新：2026-11-11 20:05。本文件在项目根目录，遵 dshQQ 硬约束第 5 条。
> 配套：`codebasemap.md`（代码与图谱在哪）、`docs/requirements.md`（主人要什么）、`docs/design-notes.md`（为什么这么设计）。

---

## 0. 一句话

**dsh-orchestra** 是要给 DSH（DeepSeek Harness）做的一个**编排插件**：把「跑一个 agent 任务」这件事变成有状态、可恢复、可审计的节点图，
每个节点的状态、证据、代次都落在 SQLite 账本里，崩溃/断线/宿主退出后能扫回来继续跑。

现在做到哪：**规则设计已写到第三段（九种节点图），v21 已按第二十二轮审计修完并送第二十三轮审计；代码一行没写。**

---

## 1. 三十秒现状

| 项 | 状态 |
| --- | --- |
| 规则设计稿 `docs/orchestra-design-draft.md` | 838 行 / SHA256 `AE771DB18D7CFBEC30C5832D3416D69DA7D873BC239120ADAFA34F9DF4D885B0`；v21 已落稿，第二十三轮审计待回 |
| 审计台账 `docs/orchestra-audit-ledger.md` | 99 行；已跑 22 轮，第 22 轮判 **fail**（3 致命 + 5 重大 + 4 措辞），第 23 轮已送待回 |
| 原始需求 `docs/requirements.md` | 已写（R1–R23 主人原话 + 拍板口径 + 验收标准） |
| 设计思路 `docs/design-notes.md` | 已写（16 条决策 + 五个坑族 + 风险清单） |
| 代码图谱索引 `codebasemap.md`（根） | 已写（三份参考图谱 + 本项目文档图谱） |
| 参考项目 `references/` | 三份已克隆并建图谱 |
| **源码** | **没有。还没开始写。** |
| 图谱 | `pi-harnessmm` 124/294、`dsh-superagent-prototype` 2012/8492、`DS-Bot` 10539/33229、`dsh-orchestra-docs` 97/96 |

---

## 2. 目录地图

```
D:\aboutAI\dsh-orchestra\
├─ handoff.md            ← 你正在读的这份（接手入口）
├─ codebasemap.md        ← 代码/图谱在哪、怎么更新、要看哪块用哪个工具
├─ docs\
│  ├─ orchestra-design-draft.md   ← 规则条文唯一权威（838 行，v21）
│  ├─ orchestra-audit-ledger.md   ← 逐轮审计台账（99 行）
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

### 4.1 当前状态：第三段 v21 已送第二十三轮审计（2026-11-11 20:05）

第二十二轮审计判 **fail**，给了 3 致命 + 5 重大 + 4 措辞，逐条性质与最小改法见台账 §一 第 22 行、§二 20:05 段。v21 已把 12 条修法逐条落进正文，并新增 `§3.4m [CURRENT]` 十二条清单；§3.4l 降为 v20 历史，全文 `[CURRENT]` 只剩 §3.4m。

修法主线（读稿先认这五条）：

- **唯一约束落到数据库**：`UNIQUE(run_id, node_id, attempt)` 守同一节点同一代次，跨行替换由 `origin_node_run_id` 部分唯一索引守；M-58 测「换新 node_run_id 仍被拒」，§14 补同 origin 建第二行被拒。
- **桥断不进 startup_unknown**：桥断一律转 `paused_bridge_missing`，`startup_unknown` 只由 `startup_timeout` 进入；恢复先查 executor.state，桥断期间只累积 `bridge_absence_accumulated`。
- **hang 闸门逐行内联**：两格所有普通出口都带 `hang_reason IS NULL`，例外只有清 hang（uphold_report）与桥断边。
- **状态未知必须收口**：重查仍不明一律落 `RESOLUTION_NOT_AVAILABLE`，只有 `indeterminate_side_effect` / `abandoned_unverified` 两类留独立人工确认。
- **五条分支与三个新落点**：`has_tool_call` 闸门 + 四个 executor.state 分支（共五条）；`started→done` 用 `now <= effective_deadline_at`；`decision` 唯一键统一 `(node_run_id, kind)` partial index；M 扩到 M-59（uphold_report）；`applyReport(node_run_id, attempt, report, expected_status, generation, decision?)` 为唯一入口，policy 内部加载。

### 4.2 审计回包后的动作

1. 逐条核 verdict；有致命/重大就按「最小改法」落 v22，重复「改稿 → 自检 → 送审」直到 pass 或只剩措辞。
2. 台账补第 24 行结论（pass/fail、分类计数、性质），§二 补结论段，§五 改当前状态与下一轮派发对象。
3. 审计 pass 后才动第四段（面板与查询）；主人 2026-11-11 15:39 口径：「审计这一步，没通过、没获得正确结果前，就不能往后走」。
4. 每次改稿后同步版本号、SHA256 与行数；改完提交 git。

> ⚠️ 改稿时**不要**新增顶层 `##` 标题（会打乱「三段」的叙事结构），不要删 §3.4b–§3.4m 的历史清单（它们是审计轨迹），不要在别的章节另写一份终态枚举（**终态集合只在 §8 写一份**）。

---

## 5. 六段路线与当前进度

| 段 | 内容 | 状态 |
| --- | --- | --- |
| 一 | 骨架与落点（桥 / 生命周期 / 控制面） | ✅ 完成（设计稿 L5–L96） |
| 二 | 把「硬」落成规则（17 条：node_run 字段、代次、证据、半态、超时、重试、sweep、迁移表、声明式判定、版本、身份账本、payload、上下文预算、存储、边界、事件、来源分离） | ✅ 完成（L97–L418） |
| 三 | 九节点图（§3.0 两类契约 → §3.5） | 🔄 v21 已送第二十三轮审计（§4.1） |
| 四 | 面板与查询 | ⛔ 未开始（要审计通过） |
| 五 | 记忆插件对接 memory-audit-v1 | ⛔ 未开始 |
| 六 | 分阶段落地与验收 | ⛔ 未开始 |

三段全过之后才写 `docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md`、自审、提交 git、交主人审阅，再转 `writing-plans`。

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
- `.gitignore` 忽略 `references/`（三份参考项目各自带 `.git`，不并入本仓库）、`.codebase-memory/`、`tmp/`、`*.log`。
- 关键提交：`f7da467` agent skills 配置、`750c89f` v20 送审、v21 收口提交（本轮 HEAD）。
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

然后按 §4.1 的五条主线读 v21 → 等第二十三轮审计回包 → 按 §4.2 处置。
