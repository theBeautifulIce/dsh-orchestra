# DSH Orchestra 自动更新工具 1.1.1

给日常使用者和执行智能体共用。支持把**当前本地源码**自动构建、打包并更新到 DSH，也支持安装一个已经生成的 `.tgz`。

本版 1.1.1 为 beta.3 的 README 配图加入八个具名 SVG 路径，并在检查与安装后逐字节核对这些文件。beta.2 随附的更新器 1.1.0 不认识这些新路径，会拒绝 beta.3 包；更新器 1.1.1 仍接受 beta.2 的旧文件集合。两版都使用相同的 12 项客户端注入契约。仓库验包脚本与更新器共用 `package-contract.mjs`，文件清单只有一处定义。

适用于当前 Orchestra 的插件包格式；更新通过 DSH 官方 `plugin --profile … add …` 完成。工具不改 DSH 宿主代码。Desktop 安装必须使用该 Desktop 自带的命令，不能拿 npm 全局 `dsh` 代替。

## 1. Windows：从源码一条命令更新

仓库内入口位于 `tools/updater/`。也可解压完整工具包使用；请保留整个目录，尤其是以下文件：

- `Update-Orchestra.ps1`：Windows PowerShell 入口。
- `update-dsh-orchestra.mjs`：执行逻辑，智能体可直接调用。
- `inspect-package.mjs`：包与安装内容校验。
- `package-contract.mjs`：与仓库验包共用的协议；`package-contract.d.mts` 为其类型声明。

先在 DSH 的托盘或应用菜单中选择**退出**。窗口右上角的 × 可能只是隐藏窗口。

从仓库使用时，先在本地 `main` 拉取远端更新并确认成功：

```powershell
git -C 'D:\aboutAI\dsh-orchestra' pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw '源码拉取失败，请先处理 Git 输出。' }
```

在工具目录（仓库的 `tools/updater/` 或完整解压目录）打开 PowerShell，执行：

```powershell
.\Update-Orchestra.ps1 `
  -Repo 'D:\aboutAI\dsh-orchestra' `
  -Dsh 'D:\aboutAI\deepseekharness-desktop\resources\runtime\cli\bin\dsh.cmd'
```

`-Repo` 改为你实际的 Orchestra 源码目录。示例 `-Dsh` 来自项目既有 Desktop 验收记录；如果你的安装位置不同，请改成该安装目录下的 `resources\runtime\cli\bin\dsh.cmd`。

工具会先尝试 PATH、`DSH_DESKTOP_COMMAND` 和常见 Desktop 安装位置。能找到正确入口时可以省略 `-Dsh`。存在多个 Desktop 安装或自定义安装目录时，明确传入更可靠。

正常源码流程为：

1. `pnpm install --frozen-lockfile`。
2. `pnpm typecheck`。
3. `pnpm build`。
4. 在本次操作的独立目录运行 `pnpm pack`。
5. 检查实际包名、入口、清单、归档内容和迁移连续性。
6. 备份现有插件与包管理清单。
7. 调用所选 DSH 的官方插件管理命令。
8. 逐文件核对实际安装内容，输出结果和回执。

需要把整库测试也放进这次更新时，加 `-Test`：

```powershell
.\Update-Orchestra.ps1 -Repo 'D:\aboutAI\dsh-orchestra' -Dsh 'D:\aboutAI\deepseekharness-desktop\resources\runtime\cli\bin\dsh.cmd' -Test
```

它在构建前运行 `pnpm exec vitest run --maxWorkers=1 --reporter=verbose`。测试使用本次操作专属的临时目录，结束后尝试清理该目录。

安装成功后重新打开 DSH，再打开 Orchestra 看板或执行一条简短任务，确认宿主已加载更新。

## 2. 已有 tgz：直接更新

```powershell
.\Update-Orchestra.ps1 `
  -Package 'D:\packages\dsh-orchestra-0.1.0-beta.3.tgz' `
  -Dsh 'D:\aboutAI\deepseekharness-desktop\resources\runtime\cli\bin\dsh.cmd'
```

这个模式不需要源码或 pnpm，只需要 Node、系统 tar 和目标 DSH 的命令。Desktop 的插件安装使用其自带 pnpm。

如果你已经拿到可信的包摘要，可加 `-Sha256 '<64位SHA256>'`。工具始终计算包摘要；传入预期值时还会检查二者相等。

同一个插件版本号下的新内容也能更新。工具按实际字节检查，不只比较版本号；候选包保存在带内容哈希的持久目录。

## 3. 智能体调用

Node 入口不依赖 PowerShell，支持 Windows、macOS 和 Linux 的相应 DSH 命令。

```powershell
node .\update-dsh-orchestra.mjs `
  --repo 'D:\aboutAI\dsh-orchestra' `
  --dsh 'D:\aboutAI\deepseekharness-desktop\resources\runtime\cli\bin\dsh.cmd' `
  --json
```

`--json` 在 stdout 只输出一份简洁 JSON；进度和子命令输出另存日志，阶段进度在 stderr。退出码成功为 `0`，失败为 `1`。

回执中的 `updaterVersion` 应为 `1.1.1`。成功验包还会记录 `clientInjectProtocol`；源码模式的 `inspect` 失败会记录 `candidatePackage`，便于找到已生成的包。

关键状态：

| status | 含义 |
| --- | --- |
| `plan` | 只读预览完成，没有构建、备份或安装 |
| `installed-verified` | 官方安装命令成功，实际安装的包文件全部匹配；重新打开目标 profile 后生效 |
| `already-current` | 已装字节和持久包来源均匹配，没有重复安装 |
| `failed` | 预检查、构建、安装或内容校验失败；看 `stage`、`error` 和 `receipt` |

如果安装器返回 `0` 却没有替换到正确内容，工具仍返回 `failed`。它不会把“命令成功”当作“内容已更新”。

智能体实施要求见 `AGENT-INSTRUCTIONS.txt`。

## 4. 只读预览、自定义目录和其它 profile

只想检查目录与将执行的步骤，用 `-Plan` 或 `--plan`。预览时 DSH 可以保持打开：

```powershell
.\Update-Orchestra.ps1 -Repo 'D:\aboutAI\dsh-orchestra' -Dsh 'D:\aboutAI\deepseekharness-desktop\resources\runtime\cli\bin\dsh.cmd' -Plan
```

Desktop 默认 profile 是 `desktop`，数据目录读取当前终端的 `DSH_HOME`，未设置时使用 `%USERPROFILE%\.dsh`。如果你的启动器给 DSH 配置了另一个 home，必须传入同一个目录：

```powershell
.\Update-Orchestra.ps1 -Package 'D:\packages\plugin.tgz' -Dsh 'D:\apps\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' -DshHome 'D:\DSH-data'
```

脚本要求 profile 已存在，不会因选错 home 而新建空 profile。第一次使用 DSH 时，先正常打开它完成初始化。

自管 Web profile 可使用已有的 CLI，例如：

```bash
node update-dsh-orchestra.mjs --package /srv/packages/dsh-orchestra.tgz --profile web --dsh /usr/local/bin/dsh --dsh-home /srv/dsh --json
```

更新前正常停止目标 Web profile。工具交由 DSH 自身的 profile 写锁和兼容性检查协调安装，不绕过这些检查。

## 5. 包、日志与备份在哪里

默认位于你实际的 `<DSH_HOME>/orchestra-updater/`：

- `packages/<SHA256>/dsh-orchestra.tgz`：长期保存的已校验候选包。
- `operations/<本次编号>/operation.log`：构建与安装命令日志。
- `operations/<本次编号>/receipt.json`：详细结果、实际目录、包摘要、版本和校验结果。
- `operations/<本次编号>/backup/`：此前的 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`（存在时）及旧插件文件、旧插件 tgz。
- `operations/<本次编号>/recovery.json`：恢复候选包的命令参数及适用条件。

**不要把 `packages/` 当临时缓存清空。** profile 的 `file:` 依赖会指向其中的 tgz，后续修复安装还可能使用它。旧包也保留，以便核对和恢复。

备份中的旧插件只包含包本体；包管理器安置的嵌套依赖由清单与锁文件管理，不塞进旧插件 tgz。工具没有读取或覆盖工作区账本、会话和用户材料。

源码目录按你当前的工作树构建。工具不自动 `git pull`、切分支或重置代码，所以本地已修好但未提交的内容也会进入本次构建；安装前由你或智能体确认这个目录正是希望安装的版本。

## 6. 失败处理

- 构建或包检查失败：停止，不调用 DSH 安装。
- DSH 仍在运行：正常完整退出后重试。工具会检查 Windows Desktop 进程；包管理写锁只协调包操作，不能替代退出宿主。工具不强制结束正在工作的宿主。
- 官方安装器失败：保留候选、备份和日志，返回失败，不自动打开宿主。
- 文件校验不符：返回失败，即使安装器的退出码是 `0`。
- 重复更新：只有内容和托管包来源均一致才跳过。
- 文件占用导致临时目录清理失败：报告 `warnings`，不把已经核验成功的安装误报为安装失败。

**备份不是无条件的数据库回滚按钮。** 如果仅发生安装失败，仍未运行新插件，可依据 `recovery.json` 用同一官方入口恢复旧包并重新核验。如果新插件已经启动、执行任务或迁移账本，先按项目升级运行手册检查兼容性，不能直接降级旧代码或拿安装备份覆盖数据库。

工具不会修改兼容性豁免、删除整个 `node_modules`、清空 pnpm store，或预先卸载 Orchestra。DSH 如拒绝兼容性，应处理实际版本问题。

## 7. 运行条件与验证范围

- Node 22.19 或以上，推荐使用项目已验证的 Node 24。
- `tar` 在 PATH。较新的 Windows 10/11 通常自带；可先运行 `tar --version`。
- 源码模式需要项目约定的 pnpm 和锁文件；tgz 模式不需要源码 pnpm。
- Desktop 的命令必须是该安装自带的 `resources/runtime/cli/bin/dsh.cmd`/`dsh`。
- Windows batch 入口拒绝带引号、`%`、`!`、换行的命令路径/参数，以避免 cmd 的变量展开改变目标；普通空格、中文、`&`、括号路径受引号保护。

本次完成了 Linux/Node 24 的包检查与更新流程离线测试，包括真实 Orchestra 包、模拟宿主命令进程、同版本内容更新、重复运行、构建失败、安装器失败、安装器假成功和已装内容不符。Windows PowerShell wrapper 与 cmd 参数完成静态和结构验证；没有在你的实际 Windows/DSH 上执行更新。准确用例数见 `verification.json` 与 `updater-tests.log`。

当前客户端注入协议由 `package-contract.mjs` 统一维护，仓库的 `scripts/package-acceptance.ts` 与更新器均调用它。默认候选必须完整且唯一地声明当前 12 项依赖。旧 7/9 项协议会给出过时协议说明并停止；不能把当前包缺少新增项误当成旧版自动放行。历史 Beta 如需安装，请按其版本说明使用官方 CLI。其他清单、路径、哈希、迁移与生命周期检查继续生效。

官方接口依据：

- [DSH Desktop 命令与安装归属](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/desktop/README.md)
- [Windows 自带 dsh.cmd](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/desktop/cli/dsh.cmd)
- [CLI 插件管理](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/reference/README.md)

## 8. 本次故障与后续更新

用户回执在 `inspect` 报 `DSH client inject must contain exactly`，所列为旧 9 项。当前包新增了以下 3 项：

- `@deepseek-ai/dsh-client-ui-sidebar-right`
- `@deepseek-ai/dsh-client-ui-sidebar-browser`
- `@deepseek-ai/dsh-client-ui-commands`

该次更新器尚未进入备份或 DSH 安装。新工具继续严格检查完整协议，不通过删掉校验或忽略错误安装。以后优先从 `main` 的 `tools/updater/` 运行，拉取源码时一并获得当前工具；独立工具包使用本包自带的完整文件集合。

如果新回执已进入 `install` 或 `verify` 后失败，请同时提供 `receipt.json` 和同目录的 `operation.log`。它是新的失败阶段，应依据实际错误处理。
