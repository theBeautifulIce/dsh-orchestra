# S2 独立审计（第 44 轮）：G2 门与 G1 residual 交叉复核

门：G2
候选提交：3cc55a4735601f18eba100480213644fed00e863
审计轮次：44
审计者：s2-audit-r44（独立克隆 `D:\aboutAI\_audit-r44-s2`）
时间：2026-11-14

结论：pass

P0=0，P1=0，P2=0。19 项必过逐项复核通过，19 份 G2 证据与 6 份 G1 物理证据逐份按 LF 归一重算 sha256 一致，25 份复现用例两遍字节一致；正式 G1/G2 记录仍绑定旧候选，属预签态，exit 1 为预期。

## 一、范围与隔离

- 主仓 `D:\aboutAI\dsh-orchestra` 的 HEAD 为 `3cc55a4735601f18eba100480213644fed00e863`（"Record round43 audit remediation in handoff"）。审计只读主仓，未改主仓文件、未动主仓 node_modules、未在主仓提交。
- 审计克隆 `D:\aboutAI\_audit-r44-s2` 由主仓 `git clone --no-hardlinks` 得到，checkout 到同一提交；克隆内独立执行 `pnpm install --frozen-lockfile`（exit 0，3.1s），全部命令只使用克隆内 node_modules。
- 门规格来自 `scripts/gate-check.ts` 的 `GATE_SPECS.G2`：items 19 条、scopeBase=`4f3ada7`、requireVerdict=true、excludes 为 docs/gates/G1.md、docs/gates/G2.md、docs/audits、docs/reviews、handoff.md。
- 正式门记录 `docs/gates/G2.md` 仍绑定旧候选（artifact 的 candidate_hash 为 e780fd2e…，与当前候选不符），正式 G1 同样为旧候选预签态；因此 `gate-check` 对两份正式记录 exit 1 属预期，本轮按“先临时门自测、不签正式门”的口径验证。

## 二、命令与退出码

| 命令（克隆内） | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 依赖安装完成，lockfile 未改动 |
| `pnpm typecheck` | 0 | 无类型错误 |
| `pnpm test` | 0 | Test Files 38 passed；Tests 552 passed \| 1 skipped；Duration 10.01s |
| `pnpm build` | 0 | tsdown 构建成功，lib/index.js 110.19 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致 |
| `node --no-warnings scripts/gate-check.ts docs/gates/G2.md` | 1 | 审计报告的候选提交之后，候选文件又被改过（预签旧候选，预期） |
| `node --no-warnings scripts/gate-check.ts docs/gates/G1.md` | 1 | 同上（预签旧候选，预期） |
| `npx vitest run tests/gate/gate-check.spec.ts -t "A6\|A7\|A8b\|A9\|第四十三轮\|覆盖点\|历史表用中文\|历史审计轮次表"` | 0 | 10 passed \| 174 skipped |
| 临时调度/HTTP 用例 `tests/zz-audit-r44.spec.ts`（7 条，未提交） | 0 | 7 passed，308ms |

## 三、调度背压与停机

本轮用临时用例直接驱动 `createExecutionScheduler`，并对真实服务装配做 HTTP 实测：

- 默认 `maxWaiting=1000`：并发 1，占住 1 个在跑任务后排满 1000 个等待任务，第 1002 个提交以 `SERVICE_UNAVAILABLE` 被拒，统计里 `maxWaiting=1000`。
- `maxWaiting=2`：1 个在跑 + 2 个排队后，第 4 个提交被拒。
- `close({drain:true})`：排队任务全部跑完；`close({drain:false})`：排队任务全部以“调度器已关闭，排队任务已取消”被拒，close 的 Promise 等在跑任务收尾后才 resolve。
- 重复 `close` 返回同一个 Promise；任务抛错会释放并发名额，后续任务可继续；close 之后新提交被拒。
- 装配期参数：`maxWaiting`、`concurrency`、`humanSlots` 传 0 / -1 / 1.5 / NaN / Infinity 均抛“执行调度的参数不合法”；生产配置 `orchestra.config.json` 省略该键时 `max_waiting=1000`，1 / 2 / 5000 / 10000 正常，0 / 10001 / 1.5 抛“配置不合法，拒绝启动”。
- 真实 HTTP 双入口：`/v1/runs/dispatch` 3 个节点与 `/v1/node-runs/run` 3 个节点并发，`started=6`、`maxActive=2`，结束后 `inFlight=0`、`waiting=0`；注入 runner 抛错时该节点返回 503（code=`SERVICE_UNAVAILABLE`），名额归零，下一节点 200 且 `final_status=done`；关闭服务并释放单写者锁后，对同一 dbFile 重新 `openServiceOrchestra` 成功。

## 四、门交叉载荷（sign-gate 实测）

为避免改动正式门，载荷全部放在克隆的临时门与临时报告上（均在候选范围外），逐条 `sign-gate`：

```text
G1 普通表：| 必过项 | 结论 | 备注 | 中 | G1-01 | 通过 | 必过项 G1-01（本轮）未通过 |
  → sign-gate exit 1：正文把必过项 G1-01 写成未通过；表格把必过项 G1-01 写成未通过
G1 攻击行：| A1 | G1-01 | 拒 | 必过项 G1-01（本轮）未通过 |
  → sign-gate exit 1：表格把必过项 G1-01 写成未通过
A6 否定词拆到相邻格：| G2-11 | 迁移空库可重复 | pass | 未 | 通过 |
  → sign-gate exit 1：表格把必过项 G2-11 写成未通过
A7 必过项 id 拆到相邻格：| G2- | 11 | pass | 未通过 |
  → sign-gate exit 1：表格把必过项 G2-11 写成未通过
A8b 单连字符分隔行溢出：表头 3 列，数据行 4 格
  → sign-gate exit 1：表格第 11 行有 4 格，超过表头的 3 格
A9 HTML 注释隐藏判定：<!-- 结论：fail；必过项 G2-11 未通过 -->
  → sign-gate exit 1：正文藏着看不见的判定
覆盖行 + 清零正句 + 中文历史轮次表：G2-07 覆盖行、未通过项为空、第三十五轮 fail / 第三十六轮 pass（audit_round=44）
  → sign-gate exit 0；随后 gate-check exit 0（19 项必过、19 份证据）
```

结论：round43 的“去 id 后本轮限定与双标签仍算裸否决”修复在 G1 载荷上成立；A6/A7/A8b/A9 四条表格/隐藏判定旁路均被拒；覆盖行、清零正句与早于本轮的中文历史轮次表不误伤。

## 五、独立重算（六项哈希）

以 HEAD 字节重算，结果如下（正式记录仍是旧候选预签值）：

| 项 | 本轮实测 |
| --- | --- |
| candidate_hash | d1fe5007e2d5072d8eae55a55628462f8e4c7d26ede1068a8f5eee71cd5b209d |
| change_scope_hash | f6bc7b64061b6d7236c01cd79da2f8fa7258fc9e89804bb8b71a36d855c710f2 |
| evidence_index_hash | 0595636482719fa14a91d50783a2069fc01366c724eba3481efa02472fe86122 |
| invariants_hash | 925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304 |
| artifact_hash | 0508d0949b06b359183edaac9a11cecc9124c02203a40f28058e25ffaabc3607 |
| body_hash | d85d0826bced4795a2f7be822cb1107419a37ca6503fb1322ec33e23e9c4f77f |

- candidate 涉及 136 个文件（含批内新增又删除的路径占位）。
- 前两项与记录里的 e780fd2e… / 6dde709a… 不同，原因是记录绑定的是更早的候选；后四项与记录完全一致，说明 `docs/gates/G2.md` 自上次签署后本体未被动过，差异只在候选代码。
- 正式记录对当前候选仍是旧锚，因此 `gate-check` 的 exit 1 是锚点校验正常拦截，不是哈希算法漂移。

## 六、证据核对（25 份逐份 LF 归一）

19 份 G2 证据（与门记录 evidence-index 逐项一致）：

| 证据 id | sha256（LF 归一） |
| --- | --- |
| ev-g2-01 | 0f06a14171f2eacc93429b3e062fdb0103b8219bd340fd8fda8971851ec422d4 |
| ev-g2-02 | 346af5813c653ba967af948a74aba27201b9ac906f13e54f4e588f8b18ea70e1 |
| ev-g2-03 | 0548e3d839680a548f007ce1bb2be4dfb087a8b8a62b0e18864568d9240c4e7b |
| ev-g2-04 | 65946e22958ef8764415d2af693245f8dc8da33e585ba4cee094e36f56ac71a6 |
| ev-g2-05 | 6f3b44cf5589ddc059b77f3640e5a23f93eef8351d9c5fba9dd6510abc26e2ba |
| ev-g2-06 | cef5cf3de601985af216cb935334414d56ff9f3f296871f709332f9e16b1f91c |
| ev-g2-07 | 607471ff9e475eaa30e3a83376b4c93aed12b6e209b7bd2601678737cf934a34 |
| ev-g2-08 | efb9c18ae992da700c48662b136fc4d78837708d85dc9a5395257ca80ef9c758 |
| ev-g2-09 | f43b50982b67843db87e1cae9b36b0048eca372d9734904d3e1090fc97b8d8b2 |
| ev-g2-10 | 30ab7abff7eaa4989bc7a5f339d3278b8ad79cc1932d0b94cc83465515c5cdb3 |
| ev-g2-11 | fb72ef55124d1b210ff4bf73ad1122cf067ecb93f96265e1fdfbdd050fc815dd |
| ev-g2-12 | 5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe |
| ev-g2-13 | a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc |
| ev-g2-14 | 12e34ba8fd59c17322b364a122a5f265af87d353e10a13b6b4328049ceb6b39f |
| ev-g2-15 | 7648abe92c2026e4c5739c5f5714f448a2ce8864fc07a129f607675af415643f |
| ev-g2-g03 | 514f9754fda67b8e1522d086fc6079301e00bd0185f9cca6dddec502c412ab70 |
| ev-g2-g04 | a30155a2446531f5c5cd2677946805ca9a78f407cfc4626147f20fcd446eb961 |
| ev-g2-g05 | 4775123a6d34878572d6b400b853a5b5fd6d782934186b729b52877c32b05d7f |
| ev-g2-g07 | de51ca56aba24af02f7c1ef2c0bfba5248da11b5aaa7ba163aafacf9d8e0746a |

6 份 G1 物理证据（check-evidence-repro 的其余 6 份）：

| 证据 id | sha256（LF 归一） |
| --- | --- |
| ev-g01 | f2626b30f9eb472f1268b71047893be8f1d42a933438e43cd30af35d3318a129 |
| ev-g02 | 5fedb2e7539b1d410b7ff3c964ea36d77764fd037c4f4e40badbd67b7038b196 |
| ev-g08 | 2f2a73ddbf25fb59ea9b650635499856e66c94dcde81fca1a12ea3d424176c87 |
| ev-g09 | e944a2b6bd299faed3f9ce98c72647ceb8580eaae412a997d7be6cdcc5376625 |
| ev-g14 | 9cb900ea3cd3fe8e50f39907bd1cc148e19c0d965849809dea7021712bf7ac4d |
| ev-g15 | 1699f60368dd5b07e0771f20e3d689b38f7af11afb9dfe9587529248098b24a0 |

19 + 6 = 25 份；`check-evidence-repro.ts` 每份重跑两遍均与 HEAD 字节一致（exit 0）。

## 七、必过项 19/19

| 必过项 | 复核要点 | 结论 |
| --- | --- | --- |
| G2-01 | 单节点 queued 到终态一条路径（生产装配） | 通过 |
| G2-02 | 重复上报只落一次 | 通过 |
| G2-03 | 租约过期迟到上报被拒 | 通过 |
| G2-04 | 取消后不产生新 attempt | 通过 |
| G2-05 | 终态必带证据（ev-g2-05 / ev-g2-10） | 通过 |
| G2-06 | 无裸 blocked | 通过 |
| G2-07 | S2 加载 parallel 被拒 | 通过 |
| G-03 | 同一 report_id 两次只落一次 | 通过 |
| G-04 | 租约到期后迟到上报被拒 | 通过 |
| G-05 | 工具执行中取消只立一次围栏 | 通过 |
| G-07 | 墙钟跳变不误判截止 | 通过 |
| G2-08 | 工具失败不落完成 | 通过 |
| G2-09 | 判定时限只认 boot_id 与单调纳秒 | 通过 |
| G2-10 | 报告入口系统级证据门 | 通过 |
| G2-11 | 反复重投同一 report_id 不刷膨胀账本 | 通过 |
| G2-12 | 工具授权只认 workflow 定义 | 通过 |
| G2-13 | 单写者锁与 epoch 围栏 | 通过 |
| G2-14 | 长动作心跳续租 | 通过 |
| G2-15 | 工作流版本跨重启不可改写 | 通过 |

## 八、临时门自测

在克隆内以本报告作为审计报告，复制一份临时 G2 记录（`docs/audits/round44-gate-final.md`，仅存在于克隆、候选范围外），把 artifact 的 `audit_round` 置 44、`audit_report` 指向本报告，执行：

```text
node --no-warnings scripts/sign-gate.ts docs/audits/round44-gate-final.md
  → exit 0，重签完成：证据 19 份，selfCheck 通过
node --no-warnings scripts/gate-check.ts docs/audits/round44-gate-final.md
  → exit 0，gate G2 通过（19 项必过、19 份证据哈希复核）
```

临时门的 artifact_hash 与 body_hash 由本轮签后回执记录，不写入本报告（会改变报告自身哈希，造成自指漂移）。正式 G1/G2 未签，也未修改。

## 九、结论

- 候选 `3cc55a4` 在独立克隆内通过 typecheck、全量测试（552 passed | 1 skipped）、构建与 25 份证据复现。
- G2 的 19 项必过、19 份证据与六项哈希独立重算一致；正式记录为旧候选预签态，exit 1 属预期。
- round43 G1 residual 修复与 A6/A7/A8b/A9 表格/隐藏判定旁路均按预期拒签；覆盖行、清零正句与中文历史轮次表按预期放行。
- P0=0，P1=0，P2=0；建议按既定顺序在正式仓重签 G1、G2（先 G1 后 G2）。

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 44,
  "candidate_commit": "3cc55a4735601f18eba100480213644fed00e863",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 0,
  "must_pass_total": 19,
  "must_pass_passed": 19,
  "must_pass_ids": ["G2-01", "G2-02", "G2-03", "G2-04", "G2-05", "G2-06", "G2-07", "G-03", "G-04", "G-05", "G-07", "G2-08", "G2-09", "G2-10", "G2-11", "G2-12", "G2-13", "G2-14", "G2-15"],
  "failed_items": [],
  "notes": "独立克隆审计；正式 G1/G2 为旧候选预签态，exit 1 属预期。"
}
```
<!-- audit-verdict:end -->
