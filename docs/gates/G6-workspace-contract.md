# G6 受信发布工作区

## 当前状态

本仓库已提供专用发布运行、冻结证据判卷、运行外双份比较、正式签署与核验器。已按脚本实际生成的文件名预登记 22 项检查、10 条不变量和 6 项定值所用的原件路径。登记表可在冻结前修订。真实采样、隔离发布账本、独立判卷及正式授权回执须在各自阶段取得。G6 尚未放行。[证据登记表](G6-evidence-registry.json)

## 运行与授权入口

S6 宿主通过 Orchestra 的 release 选项安装发布工作区，提供已登记的 wf_gate_check_v1 只读工具、六个独立检查目录及 authorizeStart、frozenEvidence、verifyGroup、verifyApproval 四个受信回调。release.start 绑定既定候选和证据并创建运行，release.advance 执行固定检查组，release.approve 验证与同一判卷绑定的实名二次确认。正常任务 HTTP 的共享服务认证不能用作实名发布批准。

命令行通过 DSH_G6_WORKSPACE_PROVIDER 载入工作区外已授权的宿主模块。模块导出 createG6TrustProvider，返回上一已签安装包摘要、verifyProof 与 withLedger。验证器应按职责核查主体、有效授权和完整证明内容。withLedger 用宿主已有账本校验能力只读打开传入的隔离账本原始字节。宿主可以保留密钥，无需向其他组件提供密钥文件。有离线签署设施时，可另用 DSH_G6_TRUST_FILE 加载外部配置并做 Ed25519 验证。两条入口都要求可信工作区、独立执行、独审和正式批准证明确切绑定材料。仓库不内置授权公钥或账本密钥。

## 冻结文件

候选提交 C 必须包含 `docs/gates/G6-evidence-registry.json`。它按 `dsh-g6-registry/1` 固定 manifest、isolated_ledger、frozen_package、install_receipt 四个相对路径，每个 evidence_id 的路径、强度要求与来源，以及各检查和不变量实际引用的证据。每个文件均在 `docs/gates/evidence/G6` 下有唯一位置。该目录以原始字节进入 Git，保留 SQLite、包、文本及回执摘要。采样后为登记项计算摘要，构造绑定 C 的 manifest，通过 T12 的 frozenEvidence 提供同一原件。登记表仅规划来源和去向，签署时逐个读取已提交的原件。

证据提交 E 提交登记表内的全部原始输出。固定候选为 C，清单中的变更范围应等于 G5 正式签署提交到 C 的改动范围。原始证据按 Git blob 的字节取 SHA-256。不得把候选 SHA 改成证据、报告、签署提交的 SHA。冻结后只允许预登记输出、独审、正式批准包及三份签署文件。

- 故障证据使用 fault-inject 的 report.json 与报告登记的原始文件。核验器重新执行只读对账查询并比较实际行。
- 控制面性能证据使用 perf-report.json。核验器重算样本、查询计划与四项规约。
- 事件滞后可用正式浸泡原始事实或单独的 lag-samples.json。两种方式均检查每个窗口，不用汇总数字替代样本。
- 正式浸泡保留 `launch.json`、`detached.json`、`host.json`、`soak-config.json`、`workspace/sample.txt`、`manifest.json`、`points.ndjson`、`events.ndjson`、`end.json`、`soak-report.json`、`ledger.db` 和 `hashes.json`。核验器检查启动身份、命令与配置、封存原件的哈希，重新判定整个窗口并从数据库核对事件及终点健康状态。
- 升级、负载回滚和值班演练的 g6-operations/1 按固定顺序记录执行步骤及其独立原件引用。I1–I10 的 g6-invariant/1 绑定实际对照结果的原件摘要。受信执行登记与独立核验负责确认这些记录的实践语义。
- §16.3 六项定值各有自己的 g6-parameter/1 原件。其证据 source 为 g6-parameter 加对应参数名。R0 必须绑定最终候选、连续满三天、零 P1。

## 联检和封存

冻结证据之后，独立审计提交 A。A 首次包含本轮 S6 独审报告，正文与结构化裁决均须通过，报告记录 C 与完整 G6 必过项。

已有真实审批时，在 A 的后继提交保存 docs/gates/G6-release-input.json。格式为 dsh-g6-settlement/1，绑定 C、E、A、发布 run、独审轮次与报告路径，以及职责分离的 workspace、independent、audit、approval 四个证明。正式批准再绑定原始证据、独审字节、上一安装包、两份待封存工件和批准时刻。文本中的人名和裁决不能代替正式批准。

在干净工作树上运行 node --no-warnings scripts/sign-gate.ts docs/gates/G6.md，提交生成的 G6.md、G6-independent.json、G6-release.json。随后分别运行 pnpm gate 和 node --no-warnings scripts/gate-check.ts docs/gates/G6.md。历史 G1–G5 使用固定签署快照中的核验器，另查当前工作树及提交未替换原门记录。G6 的核验结果不发送部署、发布、试用或推广命令。
