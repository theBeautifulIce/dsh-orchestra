# DSH Orchestra 更新器：宿主安装接口

核对日期：2026-11-25。官方代码固定到 `deepseek-ai/deepseek-harness` 的 `dsh-v0.2.2-rc.5`；下列是安装接口依据，实际验证范围另记在交付包的 `verification.json`。

## Desktop 安装入口

本地 `.tgz` 通过 Desktop 自带的 CLI 安装：

```powershell
$DshDesktopCommand = 'D:\aboutAI\deepseekharness-desktop\resources\runtime\cli\bin\dsh.cmd'
& $DshDesktopCommand plugin --profile desktop add '<安装包绝对路径>'
```

首次使用先正常打开 Desktop 初始化其配置，再从托盘或应用菜单完整退出。安装完成后重新打开。关闭窗口可能只隐藏应用。Desktop 当前没有 README 旧说明所称的本地 `.tgz` 文件选择安装入口。

| 事实 | 官方依据 |
| --- | --- |
| Desktop 自带命令支持关闭应用后的插件管理；要求配置已初始化 | [Desktop bundled command runtime](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/desktop/README.md#bundled-command-runtime) |
| Windows 包装器通过 Electron Node 模式执行 Desktop 的 CLI | [apps/desktop/cli/dsh.cmd](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/desktop/cli/dsh.cmd) |
| Desktop 命令启用 `manageDesktopProfile` 并选用随附包管理器 | [apps/desktop-host/src/cli.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/desktop-host/src/cli.ts) |
| `plugin` 读取 `--profile`，将后续 `add <tgz>` 交给包管理器 | [apps/cli/src/args.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/src/args.ts)、[plugin.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/src/plugin.ts) |
| 包操作保留 profile 写锁和兼容性校验 | [packages/boot/plugin-manager/src/operations.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/plugin-manager/src/operations.ts) |

npm 全局 `dsh` 不能替代 Desktop 自带命令管理 `desktop`。更新器不修改 `manageDesktopProfile`、安装归属或兼容性豁免。自建 Web 使用其已有 CLI 和独立的 `web` 配置。

数据目录必须与目标宿主一致。更新器接受 `--dsh-home`，否则使用当前 `DSH_HOME`，未设置时为用户目录下的 `.dsh`。配置不存在时拒绝，不因为路径误填而新建空 Desktop 配置。

## 同版本更新和内容核验

Orchestra 后续构建可能保留相同 npm 版本。更新器将候选包放到 `orchestra-updater/packages/<SHA256>/dsh-orchestra.tgz`，由官方 `plugin add` 更新同名依赖，并逐文件核对已安装内容。

持久目录是 profile 的本地依赖来源，不能当作操作结束即可删除的缓存。仅当已装文件全部匹配、profile 依赖也指向同一持久包时，才返回 `already-current`。

当前客户端注入名单由 `package-contract.mjs` 与仓库包检查共用。独立工具默认只接受当前 12 项精确协议；旧 7/9 项只用于诊断。原 npm 版本号不足以区分旧协议和误删字段的新包，因此不自动降级校验。

## 备份、失败和恢复

- 安装前保存旧插件与 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`（存在时）。
- 源码构建或验包失败不会调用 DSH 安装。`inspect` 失败的回执保留 `candidatePackage`。
- 安装命令非零，或返回零但实际字节不匹配，均返回失败并保留日志与备份。
- `recovery.json` 提供经同一官方入口恢复旧包的参数；工具不声称所有安装失败都已自动回滚。
- 若新代码已运行并迁移账本，恢复旧包前必须依据项目运维手册核对兼容性；安装备份不包含运行账本。
- 正常完整退出宿主是更新前提。Windows 进程检查能发现正在运行的 Desktop；包管理写锁只协调包操作，不能普遍替代退出应用。

逐文件安装核验不等同于启动宿主后的功能验收。Linux 上的隔离 CLI 验证不等同于 Windows Desktop 实装验证；报告分别说明。
