# DSH Orchestra

DSH Orchestra 在本地 SQLite 账本中保存工作流版本、运行、审批、执行证据和产物。DSH 宿主提供已授权的工作区、会话、模型和工具。

## 从面板完成第一项任务

1. 打开「设置」，确认服务已连接，协议版本一致。在「子智能体模型分配」给模型填写具体用途，例如“擅长跨表重算，适合财务复核”。为常规、中等、进阶、复杂、专家五档选择默认模型，或者保留自动选择。
2. 在「任务 → 用自然语言规划任务」输入目标和验收条件，例如“汇总两张表，交付 summary.md，并核对两张表的合计”。核对计划的交付物、工具、步骤与模型，确认后启动。也可从已发布流程创建任务。
3. 点击启动回执上的「查看本次运行」。在「步骤」查看每次尝试和模型，在「结果」查看产物。预览或下载使用该运行登记的受管内容；只有元数据的旧产物会提示缺少内容。
4. 要保留已验证的经验，在成功运行的「结果 → 整理为记忆」写下希望复用的内容，在审批中心核对建议。「记忆」页展示审批、写入结果、条目及来源。宿主需要提供记忆插件。
5. 两个步骤需要交叉检查时，在「协作核验 → 选择可相互核验的步骤」填写名称，选择任务运行、参与步骤和有效期。原执行者提交带证据的发现及问题后，主理人授权请求。接收方独立执行并提交证据，主理人随后采纳或驳回结论。
6. 新建任务时，「自主执行」默认提醒你处理需要人的决定，例如不可逆操作前的批准、记忆写入和你点名的事项。「协助执行」也会提醒你处理可以接手的普通决定，到期按该决定的规则处理。「人工监督」会等待明确处理。打开「审批中心 → 全部进行中」可主动查看其余决定，卡片列出有资格处理的人或审计角色。

## 安装与宿主接入

开发环境使用仓库锁文件及 package.json 声明的 pnpm、Node 和 DSH 版本。构建与打包命令如下。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm pack --pack-destination <已有的输出目录>
```

在目标 DSH profile 安装生成的 tgz，例如运行 `dsh plugin --profile web add <tgz的绝对路径>`。包内的 Cordis patch 注册 `dsh-orchestra` 双端插件行，Web 冷启动时加载 `./client`。实际工作区的服务与鉴权传输由受信宿主装配。

### 本机 DSH Desktop 个人使用

用 DSH Desktop 的插件管理安装包。在本机 profile 的 Cordis patch 为该插件启用个人宿主。

```yaml
- id: dsh-orchestra
  config:
    local:
      enabled: true
      modelCapacity: standard
      allowWorkspaceListing: true
```

重启后在 Orchestra 选择已添加到 DSH 工作区且未归档的会话。宿主在 DSH 模型目录校验会话已选模型，未选择时使用目录的默认模型。`modelCapacity` 是此 profile 允许该模型承担的最高档位，按实际能力配置。`allowWorkspaceListing` 只授权列出工作区根目录中的非隐藏条目。确需读取用户明确选定的非敏感验收文本时，在 `local.sampleFile` 写入该文件的绝对路径，例如 `D:/work/acceptance-sample.txt`。仅该文件所在的 DSH 工作区可以读取它，最多 200 行且不超过 16 KiB。

个人宿主通过「用自然语言规划任务」生成并确认可派发的规格。使用现有流程时，在目标中写明流程名称，并写清验收文件名和条件。确认后可在「结果」预览实际登记的产物。

个人账本按工作区与会话隔离，默认保存在 DSH 数据目录的 `orchestra/personal`。S6 的人工动作绑定本机登录操作人。个人宿主不接入共享试用圈、记忆或 QQ。

### 自管受信宿主

- 服务端在受信 Cordis 插件中调用 `serveDshOrchestra`。传入隔离的数据路径、实际阶段、服务密钥和账本接口，以及 DSH 上下文、按节点解析获准主会话的函数、模型目录、工具注册表和执行器。自然语言规划另提供 `dshPlanner`。按需装配 `memory` 和 `collaboration`。随包配置是 S2 样例，服务实际阶段在健康页可见。宿主退出时调用服务的 `close()`。
- 在同一 DSH Web Cordis 服务作用域中，由受信客户端适配器提供 `orchestraPanelTransport`。`baseUrl` 指向宿主为获准工作区提供的接口，`fetcher` 使用宿主已验证的登录会话。宿主在服务端持有服务密钥。事件流沿用同一会话。面板等待传输服务并在适配器卸载时移除侧栏与页面。
- 面板的服务与能力状态来自实际 `/health`。主脑模型、执行模型、记忆写入能力与工作区权限由宿主提供。开发用 DSH 探针使用独立 profile 和回环模型服务，便于复验模型及协作链路。
- S6 宿主通过 `resolveHttpHuman(request)` 将经验证的当前 DSH 登录会话绑定到实际操作人。为审批、返工和协作授权提供同一受信会话，未登录时返回 `null`。值班 QQ 发送回执与当班人确认分别登记。R1/R2 可从本圈已授权流程的成功运行发起记忆提议。[值班手册](docs/runbook.md) · [试用圈](docs/trial-circles.md)

在现有受信 DSH 客户端适配器的 `apply(ctx)` 中取得工作区接口和鉴权传输后，登记 Cordis 服务。

```js
ctx.provide('orchestraPanelTransport', { baseUrl, fetcher })
```

Cordis 将服务及面板挂载绑定到适配器的生命周期。自管面板装配的宿主仍可使用 `registerDshOrchestraPanel(ctx, { baseUrl, fetcher })`。同一个 Web 实例选择一种接线方式。
