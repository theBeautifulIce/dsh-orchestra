# Windows 宿主与值班补验

2026-11-21，在 Windows `10.0.26300.0` 核对开发工作树和既有冻结候选 `709d798`。所用桌面环境为隔离 profile。五套定向测试在默认沙箱首跑 12/18，涉及网络的 6 项失败，获准使用本机回环后同组通过 18/18。此记录只包含合成数据和脱敏回执。

| 项目 | 输入与预期 | 实际结果与判定 |
| --- | --- | --- |
| F11 本机回退传输 | 从已绑定 DSH 工作区和会话读取并订阅，交叉换用会话，尝试未经认证的后端请求，断开后按序号恢复。预期代理只连接回环，未授权请求拒绝，事件补齐。 | 代理合同覆盖拒绝非本机 authority、错误工作区、归档会话和非白名单接口，以及私有请求头由宿主生成、响应只透传公开头。用实际 SQLite/HTTP 的合同覆盖另一工作区空结果、交叉会话 403 与后端无凭据 401。冻结候选 G-09 实际断开 600.002 秒，425 条补页为 200、200、25，核对 429 条账本事件。判定回环和 SSE 符合，优先运输口径见下。 |
| N4 当前默认部署 | 空 profile 不启用 `sampleFile` 或 `allowWorkspaceListing`，要求宿主无只读能力时拒绝强证据。另用登记工具、未知工具、mutating 工具、覆盖 argv 和越界 cwd 作对照。 | Desktop 默认不提供工作区只读工具，单测在宿主不可用时返回 `EVIDENCE_SOURCE_UNAVAILABLE`，未知/可写工具拒绝，越界 cwd 拒绝，底层收到固定登记 argv。判定默认安全停用与应用守卫符合。Windows 受限进程和只读挂载正例仍待验。 |
| P47 正常用户入口 | 使用 Desktop 随附 `dsh plugin` CLI 从空 profile 装候选，再打开同一真实 Desktop 宿主提供的已鉴权 Web UI，核对侧栏、版本、权限和样本交付。 | `0.2.2-rc.5` 冷装 Orchestra `0.1.0`，75 个已安装文件逐字节匹配。侧栏自动注册，绑定工作区 HTTP 200，错误工作区 403。可信合成模型支持样本运行和本次报告预览。按 [P47 条文](../product.md#L70) 的正常用户入口可采证。Electron 原生欢迎页交互没有采样。 |
| T15 隔离回执和入流 | 伪造、缺失、无效 QQ 编号和错误 inbox；重启后让告警越过 30 分钟，测试在途排空、未经授权确认、陈旧 revision、有效确认后恢复。 | 隔离定向两项通过。仅已知传输调用和合法消息编号能登记，登记幂等，人工 ack 独立，逾期暂停新运行、在途能结束、确认后须由已认证人按当前 revision 恢复。对外发送 0 条。历史真实 QQ 走通来自既有人工确认，本候选的真实出站与人证尚缺。 |

## 适用依据和剩余证据

- **F11**。[需求 F11](../../../requirements.md#L72) 写明命名管道优先。[设计稿](../../../orchestra-design-draft.md#L86) 明确允许回退至 `127.0.0.1` 随机端口，[控制面注册](../../../orchestra-design-draft.md#L1099) 允许二者，[订阅](../../../orchestra-design-draft.md#L1407) 明确 SSE 用插件代理的 HTTP 回环，[ACL/SID](../../../orchestra-design-draft.md#L1429) 给出本机身份约束。当前生产服务直接监听 `127.0.0.1` 随机端口，个人代理在宿主持有凭据。现有材料没有命名管道承载控制面的实装原件或优先探测与回退记录，也未做第二个 Windows SID 对照。回环回退可验收，命名管道优先口径需实现或采用有授权的规格决议。
- **N4**。[需求 N4](../../../requirements.md#L83) 和[设计决定](../../../design-notes.md#L99) 要求 OS 级隔离用于强证据，缺能力时禁用。当前个人宿主配置 `sampleFile` 或 `allowWorkspaceListing` 后会以活动会话为条件报告 `readonlyAvailable()`，实际转给 DSH `workspaceFiles.read/list`，而应用 runner 会将成功结果标为 `run_tool`。该接线提供固定操作的读取能力，无法据此证明受限令牌或只读挂载。Windows 正例至少需要受控且另行装配的受限身份、只读工作区，以及真实受控读成功、写和越界拒绝的回执。本轮未提权、修改 ACL 或变更真实安全策略。
- **P47**。现有正式接受条件写的是正常用户入口，随宿主分发的 CLI 属于该路径。完整运行原件见[冷装回执](closeout-onboarding/cold-cli-install.json)及[桌面验证](closeout-onboarding/README.md)。冷装归档与其中的桌面原件对应候选 `709d798`。
- **T15**。[历史回顾](../reliability.md#L48) 与[当日值班交接](../../S6-2026-11-20-local-audit.md#L26) 支持先前真实 QQ 演练、插件 `dsh-onebot-qq@0.10.0` 的接口形状，以及当前候选证据边界。[值班手册](../../../runbook.md#qq-通知与确认) 要求当班人确认渠道和发送权限。最终包需补受控别名通道的 `sent`、真实 `messageId`、inbox 关联、具名人证以及暂停和恢复记录。

[G-09 冻结断连回执](closeout-g09-709d798.json) · [此前定向 40/40](../../../../tmp/closeout-evidence/platform-baseline.json) · [本轮回环报告 18/18](../../../../tmp/closeout-platform/windows-platform-loopback.json) · [沙箱首跑](../../../../tmp/closeout-platform/windows-platform-vitest.json) · [宿主代理合同](../../../../tests/integration/local-dsh-host.spec.ts) · [只读工具单测](../../../../tests/unit/run-tool.spec.ts) · [值班合同](../../../../tests/contract/oncall-runbook.spec.ts)
