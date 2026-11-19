# DSH 模型分配与控制面接入

## DSH 宿主装配

在 DSH Cordis 插件中调用 `serveDshOrchestra`。宿主提供工作区的主脑会话、可信的节点与会话映射、获准的执行模型清单，以及既有只读工具注册表和执行器。作用域内的模型选择适用于每一次节点尝试。

- `dsh.context` 使用插件实际所在的 Cordis 上下文。 `dsh.parentForNode(nodeRunId)` 返回对该节点有授权且仍在线的主脑 Agent。
- `dsh.models` 每项提供 `ref`、`provider`、`model` 与 `capacity`。档位取 `routine`、`standard`、`complex`。使用 DSH 已装载 provider 目录中的模型 ID。
- `dsh.recommend` 为来自普通流程或触发器的节点提供复杂度和理由。已确认计划中的逐节点建议优先于宿主回调。
- 需要自然语言入口时提供 `dshPlanner.parent` 与 `dshPlanner.model`。规划调用实际 DSH 工具受限的子会话。返回固定流程版本及任务简报后，系统检查覆盖、可核验交付物、工具、依赖和风险，再由用户确认。
- 需要协作时启用 `collaboration: true`。主理人在面板授权显式节点范围。节点侧工具使用宿主绑定的尝试与派发代次，接收方独立取证。到期和采纳都有单独状态。
- 定时和事件触发在服务内持久创建固定版本运行。需要触发后自动执行时提供 `resolveTriggerNodeSpecs`，从可信宿主配置为相应流程返回执行参数。事件来源调用带认证的触发入口。
- 交付方调用 `registerRunArtifact` 登记归属运行、文件名与实际字节。现有仅有元数据的产物显示内容未登记。面板通过认证接口预览文本和下载受管内容，读取时核对摘要与保留期。

## 操作模型

打开「设置 → 子智能体模型分配」，为常规、中等、复杂三档分别指定模型，或保留「自动选择」。指定值来自宿主批准清单，能力必须满足当前档位。保存使用配置修订和操作回执。设置变更从下一次派发起生效。指定模型退出清单或宿主回读不一致会阻塞派发，用户可在设置重新选择。运行步骤显示复杂度依据、宿主确认以及有请求证据时的实际执行模型。

## 隔离验收

`scripts/dsh-model-routing-probe.mjs` 启动本机安装的 DSH CLI，并将真实 DSH 会话的模型请求发送到回环测试服务。它创建独立 profile 与 SQLite 数据库，使用确定性的测试输出，可核对 DSH 实际发送的模型 ID、节点证据和用户配置修订。测试环境以「本机 DSH + 回环模型服务」为界。部署环境仍需装配真实模型清单、主脑会话解析和工作区权限。

```powershell
pnpm build
$dshCli = Join-Path (npm root -g) '@deepseek-ai/dsh/lib/bin.js'
node scripts/dsh-model-routing-probe.mjs $dshCli
node --no-warnings scripts/dsh-collaboration-probe.mjs $dshCli
```

模型验收的回环请求依次为 `route-probe-planner`、`route-probe-fast-custom` 两次、`route-probe-complex` 两次。常规执行用了设置中保存的第二个候选模型，两步都由只读工具证据收口。协作验收在同一类隔离环境启动不同的 DSH 子会话，覆盖原发现、授权、送达、接手、独立取证、核验完成及采纳。
