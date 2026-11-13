# S2 第八轮独立审计报告：G2 与生产执行链

## 一、审计对象与 HEAD

| 项 | 值 |
| --- | --- |
| 仓库 | D:/aboutAI/dsh-orchestra |
| 审计对象 | HEAD f572984 的 S2 门 G2 与生产执行链 |
| HEAD | f572984140437cfc4e9149f9b71ebb721caa5e12 |
| 修复提交 | d3ab0a4 fix(gate): 结论解析拒绝未收口后缀并跳过代码块 |
| HEAD 附加提交 | f572984 只归档 S1 第三轮与 S2 第七轮独立审计报告，未改生产代码 |
| 候选基准 | 4f3ada7（GATE_SPECS.G2.scopeBase），候选 57 个路径 |
| 前序门 | G1（docs/gates/G1.md） |
| 审计方式 | 只读；仅新增本报告；未修改源码、门记录、证据、测试；未 git commit |
| 审计时间 | 2026-11-13 |
| 审计员 | 独立审计代理（第八轮） |

本次从 HEAD 重新取源码、门记录、证据字节和账本状态，不采信第七轮报告的描述。所有命令在仓库根执行，Node 使用 D:/NodeJs/node.exe。

结论：pass

## 二、实测命令与结果

| 命令 | 实测结果 |
| --- | --- |
| git rev-parse HEAD | f572984140437cfc4e9149f9b71ebb721caa5e12 |
| git status --porcelain（审计开始） | 空 |
| D:/NodeJs/node.exe node_modules/typescript/bin/tsc --noEmit | exit 0，无输出 |
| D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run | Test Files 1 failed ｜ 31 passed (32)；Tests 10 failed ｜ 280 passed (290)；4.21s |
| D:/NodeJs/node.exe node_modules/vitest/vitest.mjs run tests/gate-check.spec.ts --reporter=verbose | Tests 10 failed ｜ 20 passed (30)；1 file failed；1.47s |
| D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md | exit 1；stderr：门检查失败：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != c9cef2e419c91711… |
| 临时 cwd 重跑 scripts/fault-inject.ts --case ev-g2-15 | exit 0；证据 2434 字节；SHA256=DB1C814F8935E1779440AEC12C5A229A6EC8636A0E6CCC7F86D2AC834E037038 |
| 从 HEAD 重算 G2 的 19 份证据 | 19/19 匹配，bad=0；正文证据表 19/19 匹配 |
| 从 HEAD 重算 G2 四个候选哈希与正文锚 | 四个候选哈希均与记录不符；artifact_hash、body_hash 也与记录不符（未重签） |

全量 vitest 的 10 个失败全部在 tests/gate-check.spec.ts，且全部早退于同一句审计报告哈希检查：0000000000000000… != 50ba1b13cdf1b84d…。首个失败用例是「门记录校验 > G1 门记录通过」，位置 tests/gate-check.spec.ts:12、:35，调用 scripts/gate-check.ts:521 的 verifyGateRecord -> checkAuditAnchor（:610）。G1.md:191-193 的 audit_round=1、audit_report=docs/audits/S1-independent-audit.md、audit_report_sha256 为 64 个 0；该报告实际 LF 归一 sha256=50ba1b13cdf1b84d5a948b2bc6deb25c7ec9963b4435154a5487683329390003，所以检查在读到审计锚时早退。其余 9 个失败用例同样没有走到各自要断言的篡改分支，不能把它们算作代码回归。

单跑 gate-check.spec 的 10 个失败用例为：G1 门记录通过；改 candidate_hash 但锚点不动；证据文件哈希不符（ev-g15）；evidence_index_hash 被改；candidate_hash 改成别处的值；正文必过项内容被改；正文证据表哈希被改；正文不变量说明被改；证据文件与固定映射不一致；正文 body_hash 被改。另 20 例通过，含 d3ab0a4 新增的全部结论解析用例。

G2 门检查单跑在审计锚处早退，原因是 G2.md 记录 audit_round=4、审计报告指向 docs/audits/S2-independent-audit-round4.md，而 audit_report_sha256 为 64 个 0；round4 报告实际 LF 归一 sha256=c9cef2e419c91711524e9784900050d988200253d76f3a2fb4e31dfd3872da63，且 auditConclusionOf 读出的结论是 fail。未重签状态下的这个红灯是预期行为，不当作代码缺陷。

ev-g2-15 在临时目录 C:/Users/ASUS/AppData/Local/Temp/audit-ev15-3a41c042163949e3894e9f5d54c2961d 重跑，未在仓库写证据文件；跑完 git status 仍为空。证据字节与 G2.md:79 记录完全一致。

## 三、P0/P1/P2 清单

### P0

未发现致命项。

### P1

未发现重大项。

### P2

#### P2-1 动作总时限与判定时限的配置值没有进入生产装配

- 位置：src/core/config.ts:36（verify_timeout_ms）、:40（action_timeout_ms）；src/executor/run-node.ts:30-32、:144、:155-158、:251；src/index.ts:87-98；src/service/dispatcher.ts:43-54；src/server.ts:53、:66、:183、:227；docs/gates/G2.md:17。
- 证据：config 只定义了两个字段；run-node 有 actionTimeoutMs/verifyTimeoutMs 选项和默认值 120000；但 src 中调用 runNode 的装配点只传 leaseTtlMs、leaseRenewIntervalMs，不传 actionTimeoutMs 与 verifyTimeoutMs。orchestra.config.json 的 execution.action_timeout_ms=120000 恰好等于 DEFAULT_ACTION_TIMEOUT_MS，所以当前行为看不出变化；把配置改小或改大都不生效。G2.md:17 写「动作总时限读 execution.action_timeout_ms」，与实际装配不符。
- 理由：这是配置源断链，不是超时机制缺失。动作循环仍有剩余额度、超时 markBlocked(action_timeout) 与 OPERATION_TIMEOUT，属于 fail-closed；影响是运维无法按配置调整长动作窗口，且门记录正文有一句不实描述。没有观察到由此导致的错误完成或越权，维持 P2。

#### P2-2 lease_lost 与 action_timeout 缺少执行期锚点测试

- 位置：src/executor/run-node.ts:75-97（续租失败置 leaseState.lost 并写 lease_lost）、:155-159（剩余额度小于等于 0 时 markBlocked(action_timeout) 并抛 OPERATION_TIMEOUT）。
- 证据：tests 目录检索 lease_lost 为 0 命中；action_timeout 与 OPERATION_TIMEOUT 只出现在 tests/config.spec.ts、tests/migrate-s2.spec.ts 的配置字段和 tests/errors.spec.ts:41 的错误映射，没有真实续租失败或动作超时的执行期用例。deny 路径有执行期锚点：tests/production-path.spec.ts:111-113 断言 FORBIDDEN/TOOL_NOT_REGISTERED，tests/integration/g2.spec.ts:179 断言 FORBIDDEN，tests/run-tool.spec.ts:46-49、:72 断言 cwd 越界与 commandHash 不符。
- 理由：实现存在且 fail-closed，但关键失败分支没有回归锚，后续改动可能悄悄破坏「租约丢失必须收口」与「超时不得落完成」。属测试覆盖缺口，不构成当前行为错误，维持 P2。

#### P2-3 工作流单测的「跨重启」没有真正 close 后 reopen

- 位置：tests/workflows.spec.ts:45-56。
- 证据：用例在同一个已打开的 db 连接上 new 第二个 WorkflowCatalog，再 second.hydrate()，期望装回 1 条；没有关闭数据库再重新打开。它验证的是同连接上的第二个 Catalog 行为，不是进程/连接重启后的 hydrate。
- 理由：ev-g2-15 用同一个 dbFile 起两次服务，真实覆盖了重启后的定义表恢复与同版本改写拒绝，所以生产行为有证据；缺的是单测层面的真实重启路径。维持 P2。

#### P2-4 前序门链只比较字符串，不重算前序 artifact

- 位置：scripts/gate-check.ts:458-472。
- 证据：checkPreviousChain 只从 G1 HEAD 文本里正则取 artifact_hash，与 G2 的 previous_artifact_hash 比较；不重算 G1 artifact，也不检查 G1 的审计锚、证据、正文。当前 G1.md:197 的锚是 1ce80f6080fb2271ae7ba958c61127962951cb49262b75e5b1d8e7d161b82084，G2 的 previous_artifact_hash 也是 1ce8，字符串相等；但 G1 当前 artifact 的 canonicalJson 实算为 f54dcae873f34a988ca7d6fbf5bd0b29ce68558acfd4007f0b477e49b65cc4ec，与锚不符。G1.md:191-193 的 audit_report_sha256 还是 64 个 0，指向的 S1 报告结论解析为 null（末尾是「**G1 建议：不通过。**」，去一个行首 ** 后仍是「G1 建议：不通过。**」，不匹配 ^建议）。
- 理由：G2 可以在前序 G1 不自洽时通过这一项；这是纵深防御缺口。它需要人工改门记录并重签才能触发，且不改变 G2 自身 19 项证据与生产链行为，维持 P2，不升 P1。该缺口的具体后果落在第七节的未闭合项里。

#### P2-5 WorkflowCatalog 保存调用方引用，别名冲突后仍留下被拒定义

- 位置：src/service/workflows.ts:59、:72-76、:104-115。
- 证据：load 里 remember(key, def) 直接把调用方对象放进 defs；get 返回内部对象而不是副本；remember 先 this.defs.set(key, def)，再检查数字别名，别名冲突抛 WORKFLOW_VERSION_IMMUTABLE 时 key（例如 '01'）已经留在 map 里。测试可复现：load 一个 01 别名冲突的定义失败后，get('01') 仍能拿到被拒定义；load 没有 INSERT，重启后消失。
- 理由：这是内存状态一致性/可变引用问题，可能让被拒定义在进程内继续被 createRun 取到；未发现远程直接利用路径，且重启后自愈，维持 P2。

#### P2-6 结论解析对全大写 PASS 误判为 fail

- 位置：scripts/gate-check.ts:490-495。
- 证据：三处正则都带 i 标志，但 :495 的比较是 raw === 'pass' 或 raw === '通过'，区分大小写。实测「结论：PASS」返回 fail。旧版 d3ab0a4^ 同样用 raw === 'pass'，所以这是既有弱点，不是本次修复引入。
- 理由：方向是误判为 fail，属于 fail-closed，不会把 fail 读成 pass；影响是合规的大写报告读不出。维持 P2。

#### P2-7 围栏翻转只看行首三反引号或三波浪号，不配对围栏类型与长度

- 位置：scripts/gate-check.ts:482-486。
- 证据：任何 trim 后以三反引号或三波浪号开头的行都会翻转 inFence；不区分开围栏与闭围栏，也不区分围栏字符。实测：三反引号围栏内只写一条「结论：fail」，修复后返回 null（旧版会读出 fail）；三反引号围栏内出现一行 ~~~ 会把状态提前翻回 false，形成嵌套误判。把「结论：pass」放在三反引号围栏、把真实「结论：fail」放在随后被误判为围栏的 ~~~ 段，可构造出 pass；但这需要作者刻意混用围栏，且正常报告中真实 fail 行在围栏外时仍会被计数或产生多结论 null。
- 理由：修复为了挡住「代码块内 pass 顶替真实 fail」，付出了「围栏内真实结论读不出」的代价；这是有意的取舍，但围栏配对过宽。没有在正常格式下发现压过真实 fail 的可行路径，维持 P2。

#### P2-8 结论 token 后允许括号与破折号解释，括号内相反结论被忽略

- 位置：scripts/gate-check.ts:489-495。
- 证据：tail 允许一对括号补充和破折号解释，然后必须行尾。实测「结论：pass（上一轮 fail）」返回 pass，「结论：pass——但证据不足」也返回 pass。若同一行同时出现相反结论，解析器只看 token，不看括号内容；若另起一行写相反结论，found.size=2 返回 null。
- 理由：这是报告写法歧义，不会把明确的 fail 行读成 pass；但在报告本身自相矛盾时，结论可能被 token 决定。维持 P2。

## 四、第七轮 P1-1 闭合复核

第七轮报告的 P1-1 是 scripts/gate-check.ts 的 auditConclusionOf 只认前缀、不认行尾、且不跳过围栏代码块；实测「结论：通过率 60%，未达门槛」返回 pass，代码块内的「结论：pass」可以顶替真实 fail。

d3ab0a4 的修复在 :476-499：逐行 trim；行首三反引号或三波浪号翻转 inFence 并跳过；围栏内跳过；去行首 1-6 个 # 与一个行首 **；结论 token 后只允许可选加粗、句末标点、一对括号补充、破折号解释，然后必须行尾；三条匹配式分别覆盖「审计」+结论/判定+冒号、行首直接 pass/fail/通过/不通过、建议+冒号+不通过/通过；found 为 Set，size 不等于 1 返回 null。

直接 import 真函数做对抗实测，结果如下。

| 输入（单行或几行） | 期望 | 实测 | 说明 |
| --- | --- | --- | --- |
| 结论：通过率 60%，未达门槛 | null | null | 后缀未收口，已挡住 |
| 结论：fail，但仍有风险 | null | null | 逗号后解释未收口 |
| 结论：pass，但证据不足 | null | null | 同上 |
| 结论：fail。 | fail | fail | 句末标点允许 |
| **结论：fail** | fail | fail | 整行加粗可读 |
| # 结论：fail | fail | fail | 标题前缀可读 |
| 审计结论：fail | fail | fail | 审计前缀可读 |
| 建议：不通过 | fail | fail | 建议式可读 |
| 结论：pass 与 结论：fail 两行 | null | null | 多结论不裁决 |
| 三反引号围栏内 pass，围栏外真实 fail | fail | fail | 围栏内不计数 |
| 三反引号围栏内只有 pass | null | null | 围栏内不计数 |
| 三反引号围栏内只有 fail | null | null | 新出现的读不出，见 P2-7 |
| 三波浪号围栏内 pass，围栏外真实 fail | fail | fail | 波浪号围栏也跳过 |
| 三反引号围栏内嵌 ~~~，再写 pass 与 fail | null | null | 嵌套误判，见 P2-7 |
| 结论：pass（上一轮 fail） | pass | pass | 括号内相反结论被忽略，见 P2-8 |
| 结论：PASS | pass | fail | 大写误判，见 P2-6 |
| 结论：pass 后无标点解释 | null | null | 未收口 |
| 报告里写「结论：pass」的行内引用 | null | null | 行内有其他文字，不匹配 |
| 结论：通过 | pass | pass | 中文通过 |
| 结论：不通过 | fail | fail | 中文不通过 |

P1-1 的原始假 pass 路径已经闭合：通过率后缀、fail 后带解释、代码块内 pass 顶替真实 fail、多结论、行内引用都返回 null 或按真实 fail 计数；未发现一条在正常报告格式下把真实 fail 读成 pass 的路径。修复也带来了两类新的读不出问题：围栏内的真实结论被跳过（P2-7），以及既有的大写 PASS 与括号内相反结论仍会误判（P2-6、P2-8）。这三项按 P2 记录，不把 P1-1 重新打开。

## 五、G2 19 项与证据核对表

GATE_SPECS.G2.items 为 19 项：G2-01 到 G2-07、G-03、G-04、G-05、G-07、G2-08 到 G2-15。G2.md 正文表 19 行、artifact.must_pass_items 19 项、evidence-index 19 条、evidenceFiles 固定映射 19 个，数量一致。

| 编号 | 内容（G2.md 正文表） | artifact 证据 | 核对 |
| --- | --- | --- | --- |
| G2-01 | 单节点 queued 到终态一条路径（走生产装配） | ev-g2-01 | pass |
| G2-02 | 重复上报只落一次 | ev-g2-02 | pass |
| G2-03 | 租约过期迟到上报被拒 | ev-g2-03 | pass |
| G2-04 | 取消后不产生新 attempt | ev-g2-04 | pass |
| G2-05 | 终态必带证据 | ev-g2-05,ev-g2-10 | pass |
| G2-06 | 无裸 blocked（没裁决卡不许卡住） | ev-g2-06 | pass |
| G2-07 | S2 加载 parallel 被拒 | ev-g2-07 | pass |
| G-03 | 同一 report_id 上报两次只落一次 | ev-g2-g03 | pass |
| G-04 | 租约到期后原执行器迟到上报被拒 | ev-g2-g04 | pass |
| G-05 | 工具执行中取消只立一次围栏 | ev-g2-g05 | pass |
| G-07 | 墙钟跳变不误判截止 | ev-g2-09,ev-g2-g07 | pass |
| G2-08 | 工具失败不许落完成（系统判失败并挂凭据） | ev-g2-08 | pass |
| G2-09 | 判定时限只认 boot_id 与单调纳秒（墙钟跳变不误判） | ev-g2-09 | pass |
| G2-10 | 报告入口系统级证据门（弱证据与伪造痕迹一律拒） | ev-g2-10 | pass |
| G2-11 | 反复重投同一 report_id 不许把账本刷膨胀 | ev-g2-11 | pass |
| G2-12 | 工具授权只认 workflow 定义，请求体策略不参与 | ev-g2-12 | pass |
| G2-13 | 单写者锁与 epoch 围栏：第二写者拿不到锁，旧 epoch 写不进 | ev-g2-13 | pass |
| G2-14 | 长动作靠心跳续租，扫描不误判过期 | ev-g2-14 | pass |
| G2-15 | 同一工作流版本跨重启不可改写，在飞 run 的判定条件不跟着变 | ev-g2-15 | pass |

从 HEAD 取每份证据的字节，按 LF 归一后重算 sha256，19 份全部与 G2.md:70-88 记录一致，bad=0。正文证据表 19 行也逐行一致。

| 证据 | 文件 | HEAD 重算 sha256 | 核对 |
| --- | --- | --- | --- |
| ev-g2-01 | docs/gates/evidence/G2/ev-g2-01.md | f10efac98f2d0d91bfc83d0e1bacb3c2a5111c11bc7223de6464a057a744d88b | 匹配 |
| ev-g2-02 | docs/gates/evidence/G2/ev-g2-02.md | 346af5813c653ba967af948a74aba27201b9ac906f13e54f4e588f8b18ea70e1 | 匹配 |
| ev-g2-03 | docs/gates/evidence/G2/ev-g2-03.md | 784e44b65d6642404d0f7664bda64e48337292101a102f1403aef4caee4a6db5 | 匹配 |
| ev-g2-04 | docs/gates/evidence/G2/ev-g2-04.md | 65946e22958ef8764415d2af693245f8dc8da33e585ba4cee094e36f56ac71a6 | 匹配 |
| ev-g2-05 | docs/gates/evidence/G2/ev-g2-05.md | 74c0a94705a24494d435c995317d6a29f40e089a992e9c75afa5e0735b35adb1 | 匹配 |
| ev-g2-06 | docs/gates/evidence/G2/ev-g2-06.md | cef5cf3de601985af216cb935334414d56ff9f3f296871f709332f9e16b1f91c | 匹配 |
| ev-g2-07 | docs/gates/evidence/G2/ev-g2-07.md | 607471ff9e475eaa30e3a83376b4c93aed12b6e209b7bd2601678737cf934a34 | 匹配 |
| ev-g2-08 | docs/gates/evidence/G2/ev-g2-08.md | 54e4b0e8415abd5bc65ce885c407245d91ec099390e64a2b3188c89cb1144cbf | 匹配 |
| ev-g2-09 | docs/gates/evidence/G2/ev-g2-09.md | f43b50982b67843db87e1cae9b36b0048eca372d9734904d3e1090fc97b8d8b2 | 匹配 |
| ev-g2-10 | docs/gates/evidence/G2/ev-g2-10.md | 76b458edf0f4f24a4408be4bf429b4a9025399aa002c52b6c50676a5f4f45e8b | 匹配 |
| ev-g2-11 | docs/gates/evidence/G2/ev-g2-11.md | 05c1c8ea1ab5796a24adc50931a3a1b3d6d085af56975b47f6c9a113f7f233c7 | 匹配 |
| ev-g2-12 | docs/gates/evidence/G2/ev-g2-12.md | 5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe | 匹配 |
| ev-g2-13 | docs/gates/evidence/G2/ev-g2-13.md | a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc | 匹配 |
| ev-g2-14 | docs/gates/evidence/G2/ev-g2-14.md | 865fd0b7bca1193256dedee74f30a18c8903f5e0fa4c2d119cad6e41b50ada02 | 匹配 |
| ev-g2-15 | docs/gates/evidence/G2/ev-g2-15.md | db1c814f8935e1779440aec12c5a229a6ec8636a0e6ccc7f86d2ac834e037038 | 匹配 |
| ev-g2-g03 | docs/gates/evidence/G2/G-03.md | 514f9754fda67b8e1522d086fc6079301e00bd0185f9cca6dddec502c412ab70 | 匹配 |
| ev-g2-g04 | docs/gates/evidence/G2/G-04.md | fb68366d1292bb80e9ae59febf7fd5ad1e28e580ecfc2883e99b18edb2e6eca9 | 匹配 |
| ev-g2-g05 | docs/gates/evidence/G2/G-05.md | 2f7da35abe9c1484143b85a0226da8a0ebd095994c8e2aa492dd88f726b51904 | 匹配 |
| ev-g2-g07 | docs/gates/evidence/G2/G-07.md | 8898db1323c191c8ca0acd51d2dde5458355b7b25f3b0c96f868ec38d8ef730e | 匹配 |

结构核对结果：

- GATE_SPECS.G2.items 与 G2.md 正文表编号顺序完全一致；正文表 19 行无重复、无缺行。
- 正文表第 2 列内容与 GATE_SPECS.G2.content 19/19 一致；artifact 表逐条核对，无 mismatch。
- 每条 must_pass_items 的 evidence_ids 与 GATE_SPECS.G2.evidenceMap 19/19 一致；G2-05 与 G-07 各引用两份证据，其余各一份。
- artifact.must_pass_items 19 项全部 result=pass，evidence_ids 非空；failed_items 为空；conclusion=pass；gate_run_id 为 null，run_terminal 为 not_applicable。
- evidence-index 19 条，id/file/64 位 sha256 字段齐全；固定映射 19 个 id 全部出现，无多余 id。
- 19 份证据都在 HEAD 中，按 LF 归一重算全部匹配；正文证据表的 id、文件、sha256 三列也全部匹配。
- invariants 共 11 条（I1 到 I11），引用的证据 id 全部存在；I1 与 I4 各引用 4 份证据，I2 引用 ev-g2-04 与 ev-g2-g05，I3 引用 ev-g2-03 与 ev-g2-g04，其余各 1 份；没有未被任何必过项或不变量使用的证据。
- 例外表 3 条（LEASE_EXPIRED 409、BRIDGE_ACK_LAG 409、DECISION_REQUIRED 422，均 proposed），与 artifact 一致；rollback 有 target/action/耗时/验证；approver=human:啸春；producer=human；approved_at=2026-11-13T05:54:00.000Z。
- 前序锚：G2 previous_artifact_hash=1ce80f6080fb2271ae7ba958c61127962951cb49262b75e5b1d8e7d161b82084，与 G1.md:197 的 artifact_hash 字符串相等；但 G1 当前 artifact 实算与这个锚不符，见 P2-4。
- 门记录尚未重签：audit_round=4、audit_report=docs/audits/S2-independent-audit-round4.md、audit_report_sha256=64 个 0；artifact 四个候选哈希与正文 artifact_hash、body_hash 都是旧值。这是预期的未签状态，不据此判 fail。

记录值与 HEAD 重算对照：

| 字段 | G2.md 记录 | HEAD 重算 | 说明 |
| --- | --- | --- | --- |
| candidate_hash | f11d0fb8751ce561df6d24379ad083f12c4bc60c866f87ec7f523858e32c0af8 | 082510479b1a1495d2a5b0a6b308c9e1edc3af694ec9980bfade14a2dcea2e95 | 57 个候选路径；旧值 |
| change_scope_hash | 33a82c417c33b950fe40f332f398018a29eebf5f2ed1242bb3772064f9626927 | fc570cab664365d4347ac5e009be3cb3a10f11f87567c71640d5ec881788f63c | 旧值 |
| evidence_index_hash | bcaaaa3e85d1dea69d323c9a03040f0bc7586445d5d833169b3768ac487b6347 | 106e1c362e7d4312e647580a99b3cfc01eb604546af9fd42167af4bbce6b8fd0 | 旧值 |
| invariants_hash | 77708d4b54f29a676481b6c2755a241171c2cfab1231ef6e621f184fc68cedd5 | 925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304 | 旧值 |
| artifact_hash | b5615b8b5725c5b2df88b9231b13885635940ef7db9f7fe802bc162c651c7a0a | ea3dff4caa8de38d5336388e32eb4af4867998308a28a6b010d180d8d85c291a | 当前 artifact 规范化；重签后会变 |
| body_hash | ef21bb456813786ab878abae2824a873f6e7d470e257d2bcadfb9eb73282dfd3 | 95eed39b14eff54db8d92db68e6015a7175b93222f934d54edb4e91c5f5bb01e | 当前正文；重签后会变 |
| audit_report_sha256 | 0000000000000000000000000000000000000000000000000000000000000000 | round4 报告 c9cef2e419c91711524e9784900050d988200253d76f3a2fb4e31dfd3872da63 | 未签；round4 结论为 fail |
| previous_artifact_hash | 1ce80f6080fb2271ae7ba958c61127962951cb49262b75e5b1d8e7d161b82084 | G1 当前 artifact f54dcae873f34a988ca7d6fbf5bd0b29ce68558acfd4007f0b477e49b65cc4ec | 只与 G1 旧锚字符串相等 |

重签所需六处值：

| 项 | 当前可核对的值 | 状态 |
| --- | --- | --- |
| candidate_hash | 082510479b1a1495d2a5b0a6b308c9e1edc3af694ec9980bfade14a2dcea2e95 | 可直接填 |
| change_scope_hash | fc570cab664365d4347ac5e009be3cb3a10f11f87567c71640d5ec881788f63c | 可直接填 |
| evidence_index_hash | 106e1c362e7d4312e647580a99b3cfc01eb604546af9fd42167af4bbce6b8fd0 | 可直接填 |
| invariants_hash | 925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304 | 可直接填 |
| artifact_hash | 当前 ea3dff4caa8de38d5336388e32eb4af4867998308a28a6b010d180d8d85c291a | 由 sign-gate 在写入 audit_round、报告 sha、四个哈希、previous_artifact_hash 后重算；不能在报告内写死 |
| body_hash | 当前 95eed39b14eff54db8d92db68e6015a7175b93222f934d54edb4e91c5f5bb01e | 由 sign-gate 在正文定稿后重算；不能在报告内写死 |

另有两项虽不在六处之内，但重签时必须同时正确：audit_report_sha256 填本轮报告提交后的 HEAD 字节 LF 归一 sha256；previous_artifact_hash 填 G1 重签后的新 artifact_hash。当前 G1 的锚 1ce8 只对应旧记录，G1 当前 artifact 实算为 f54d，不能直接沿用。

## 六、工作流跨重启链复核

生产链逐段核对：

| 环节 | 位置 | 结论性观察 |
| --- | --- | --- |
| 表结构 | migrations/004_workflow_versions.sql | workflow_versions(version TEXT PRIMARY KEY, content_hash TEXT NOT NULL, definition_json TEXT NOT NULL, created_at TEXT NOT NULL)；同时给 runs 增加 workflow_definition_hash |
| 启动恢复 | src/index.ts:54 | openDb 后 applySteps，再 new WorkflowCatalog(phase, db)，立即 catalog.hydrate() |
| hydrate | src/service/workflows.ts:29-41 | 读 workflow_versions，JSON.parse 后 assertDefinitionAllowed，definitionHashOf(def) 必须等于 row.content_hash，否则 WORKFLOW_VERSION_IMMUTABLE；通过后 remember |
| load | src/service/workflows.ts:43-70 | 先查库同版本 content_hash 不同即抛；再查内存 existing 哈希不同即抛；新版本 remember 后 INSERT canonicalJson(def) |
| 建 run | src/service/runs.ts:52-61 | createRun 把 definitionHashOf(def) 写进 runs.workflow_definition_hash，事件带同一哈希 |
| 收口比对 | src/service/commands/apply-report.ts:91-114 | policyForReport 读 runs.workflow_version 与 workflow_definition_hash；为空返回 VERDICT_UNSUPPORTED；catalog.definitionHash 与绑定值不等返回 WORKFLOW_VERSION_IMMUTABLE（details 带 bound/current）；相等才用 catalog.policyFor |

这条链的方向是对的：hydrate 先验哈希再入内存，load 同版本改写被拒，run 绑定定义哈希，收口时再次比对；重启后定义从库恢复，不会因为内存为空而接受新的同版本定义。

ev-g2-15 用同一个 dbFile 起两次服务，实测覆盖了这条链。证据参数里 db=<tmp>/orchestra.db；第一次 POST /v1/workflows/load 返回 200，节点 nrun_1 在飞时状态 verifying；关闭服务后对同一 dbFile 起第二个服务，hydrate 后 workflow_versions 只有 version 1、content_hash=206681cf51becb770748c437ebd0e9133ed831e691f76684c70567a5b4545256；runs 绑定同一哈希；同版本改写（pass_conditions 置空）返回 HTTP 409 WORKFLOW_VERSION_IMMUTABLE；在飞节点仍为 verifying、attempt=1、revision=3；弱证据收口返回 accepted=false、reason=verification_too_weak、registry_state=rejected。重跑证据 2434 字节，SHA256=DB1C814F8935E1779440AEC12C5A229A6EC8636A0E6CCC7F86D2AC834E037038，与记录一致。

单测层面的缺口见 P2-3：tests/workflows.spec.ts:45-56 的「跨重启」是同一个 open db 上新建第二个 Catalog，不是 close 后 reopen。它不能替代 ev-g2-15，但也不否定生产链的行为。

## 七、未闭合项与是否阻断 S2

- G2 门记录尚未重签：audit_round=4、审计报告指向 round4、audit_report_sha256 为 64 个 0、正文 artifact_hash 与 body_hash 都是旧值。按本轮口径，这不是代码缺陷，不据此判 fail；但 G2 在重签前不能作为通过记录使用。
- G1 前序记录当前不自洽：artifact_hash 锚 1ce8 与当前 artifact 实算 f54d 不符；audit_report_sha256 为 64 个 0；指向的 S1 报告结论解析为 null，且该报告本身建议 G1 不通过。G1 需要按 S1 第三轮报告（docs/audits/S1-independent-audit-round3.md，结论 pass）重签，重签后 G2 的 previous_artifact_hash 必须同步改成新的 G1 锚点。这一项阻断 S2 的形式收口，不是第八轮发现的代码 P0/P1。
- 10 个门记录负向用例当前被未签状态遮蔽：它们都在审计报告 sha256 检查处早退，没有执行各自要断言的篡改分支。这不是代码回归，但也不能声称这些负向断言在 HEAD 实际通过；重签后应恢复为 30/30。
- P2-1 到 P2-8 均未闭合，逐条见第三节；没有一条达到 P0 或重大 P1 的判定门槛。
- 代码与证据层面的 S2 结论：19 项与 19 份证据闭合，生产链关键路径（状态机、证据门、租约、工作流定义绑定）未发现会导致错误完成、越权或不可恢复的缺口。形式收口待 G1 重签、G2 提交本轮报告并运行 sign-gate。

## 八、审计边界与可复现性

本次没有重跑全部 19 个故障注入；证据哈希全部从 HEAD 字节重算，ev-g2-15 在临时目录实跑并逐项核对输出。tsc 与全量 vitest 已跑，测试数字和首个失败原因见第二节。审计期间没有修改仓库文件；ev-g2-15 在系统临时目录运行，避免在仓库写 docs/gates 证据。报告写入后，git status 应只有本报告未跟踪。
