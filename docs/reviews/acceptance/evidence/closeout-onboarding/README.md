# 新用户入口复验

2026 年 11 月 21 日，本机 DSH Desktop 0.2.2-rc.5 从独立空目录启动。初始配置没有直接插件依赖。使用随 Desktop 分发的官方 `dsh plugin --profile desktop add` 离线安装 0.1.0 候选，75 个包内文件逐一与归档校验一致。重启后，通过同一 Electron Desktop 进程提供的已鉴权本机 Web 界面，打开自动注册的 Orchestra 侧栏。原生欢迎页未操作。

| 验收项 | 实测 |
| --- | --- |
| P47 安装、启用与权限 | 侧栏出现 Orchestra，面板显示「实时更新」。当前绑定的工作区读取健康检查为 200，替换为不存在的工作区后被拒绝为 403。只配置独立的本机合成模型，无账号登录、外部模型调用或 ACL 修改。 |
| P24 未配置模型 | 从实际界面请求生成计划，提示「DSH 模型目录不包含指定模型」，任务仍为 0。 |
| P24 同名历史、复用和专属 | 两个同名历史运行均完成。保留「已完成」筛选，点名已发布的可复用流程 v2，以及由计划生成 task_local v1。分别确认、打开「查看本次运行」，预览当前的 `reused-current.md`（101.25）与 `local-current.md`（133.75），返回后筛选保持。四个同名任务的任务、运行和产物哈希均独立。 |
| P24 个人宿主入口修复 | 旧包的「从流程新建任务 → 创建并排队」被宿主安全规则拒绝。开发版改为「从流程规划任务 → 用此流程规划任务」。浏览器实测预填所选流程和版本，人工确认后启动同一工作流，打开本次产物且返回保持筛选。普通宿主保留直接启动，由客户端回归测试覆盖。 |

[冷安装回执](cold-cli-install.json) · [原宿主完整链路](onboarding.json) · [无模型](no-model-planning-result.png) · [复用成果](reused-results.png) · [专属成果](local-results.png) · [返回筛选](return-retained-filter.png) · [原入口拒绝](reusable-direct-rejected.png) · [修复后预填](guided-prefill.png) · [修复后结果](guided-result.png) · [修复回执](guided-workflow.json)
