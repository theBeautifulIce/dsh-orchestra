# S1 第四十四轮 G1 独立审计

门：G1
候选提交：3cc55a4735601f18eba100480213644fed00e863
审计轮次：44
审计员：s1-audit-r44
审计时间：2026-11-14
审计目录：D:\aboutAI\_audit-r44-s1（从主仓 clone，未改动主仓与其 node_modules）

结论：pass

## 结论与缺陷计数

- P0：0
- P1：0
- P2：1（sign-gate 回执噪声，不阻断，见文末）
- G1 十三项必过项在本候选上全部通过；25 份生成证据逐份重算一致；六项哈希可独立重算。
- 正式 G1/G2 仍绑第 31/36 轮旧候选，`gate-check` 对两门均 exit 1，属预期；本报告不签署正式门。

## 审计方法

1. 从 `D:\aboutAI\dsh-orchestra` clone 到全新目录，checkout `3cc55a4`，在克隆内 `pnpm install --frozen-lockfile`，全程只用克隆内依赖。
2. 用独立脚本重算 candidate/change_scope/evidence_index/invariants/artifact/body 六项哈希与 25 份生成证据的 LF 归一 sha256，不 import 仓库的哈希实现。
3. 在克隆内构造临时 G1（只改 artifact 的 audit_round 与 audit_report，不签正式门），逐条投递第四十三轮 P1 的残留载荷与正向对照，记录 sign-gate 退出码与首行错误。
4. 临时门签过后提交 G1.md，再跑 `gate-check` 与门内 13 项/13 份证据核对。
5. 全量 typecheck/test/build/证据复现，另做调度背压、停机、双入口并发与任务异常时释放名额的定向复跑。

## 第四十三轮 P1 复测结果

11 条攻击载荷全部被拒签（sign-gate exit 1），错误首行均为：

```text
Error: 审计报告正文与结构化裁决不一致：审计报告表格把必过项 G1-01 写成未通过，裁决却是 pass（<报告路径>）
```

| 用例 | 载荷 | 期望退出码 | 实际退出码 | 错误摘要 |
| --- | --- | --- | --- | --- |
| p1-ordinary | 普通表，备注格写本轮否定句 | 1 | 1 | 正文与结构化裁决不一致 |
| p1-attack-row | 攻击行，备注格写本轮否定句 | 1 | 1 | 正文与结构化裁决不一致 |
| p1-double-label | 双标签前缀 | 1 | 1 | 正文与结构化裁决不一致 |
| p1-dangxiang | 该项限定前缀 | 1 | 1 | 正文与结构化裁决不一致 |
| p1-split-cells | 普通表内前缀与否定词拆到相邻格 | 1 | 1 | 正文与结构化裁决不一致 |
| p1-attack-split | 攻击行内前缀与否定词拆到相邻格 | 1 | 1 | 正文与结构化裁决不一致 |
| defer-plain | 延迟类状态词 | 1 | 1 | 正文与结构化裁决不一致 |
| defer-round | 延迟类状态词带本轮限定 | 1 | 1 | 正文与结构化裁决不一致 |
| trad-verdict | 繁体结论列与备注列 | 1 | 1 | 正文与结构化裁决不一致 |
| trad-remark | 繁体备注带本轮限定 | 1 | 1 | 正文与结构化裁决不一致 |
| history-cn-future | 历史表写未来轮次 | 1 | 1 | 表格结论与裁决冲突 |

对应载荷原文（围栏内仅为审计载荷，不参与判定）：

```text
p1-ordinary
| 必过项 | 结论 | 备注 |
| --- | --- | --- |
| G1-01 | 通过 | 必过项 G1-01（本轮）未通过 |

p1-attack-row
| 用例编号 | 必过项 | 期望 | 备注 |
| --- | --- | --- | --- |
| A1 | G1-01 | 拒 | 必过项 G1-01（本轮）未通过 |

p1-double-label
| 必过项 | 结论 | 备注 |
| --- | --- | --- |
| G1-01 | 通过 | 必过项 必过项 G1-01 未通过 |

p1-dangxiang
| 必过项 | 结论 | 备注 |
| --- | --- | --- |
| G1-01 | 通过 | 该项（本轮）未通过 |

p1-split-cells
| 必过项 | 结论 | 备注 | 补充 |
| --- | --- | --- | --- |
| G1-01 | 通过 | 本轮 | 未通过 |

p1-attack-split
| 用例编号 | 必过项 | 期望 | 备注 | 补充 |
| --- | --- | --- | --- | --- |
| A1 | G1-01 | 拒 | 本轮 | 未通过 |

defer-plain
| 必过项 | 结论 | 备注 |
| --- | --- | --- |
| G1-01 | 通过 | 暂缓 |

defer-round
| 必过项 | 结论 | 备注 |
| --- | --- | --- |
| G1-01 | 通过 | 暂缓（本轮） |

trad-verdict
| 必过项 | 结论 | 备注 |
| --- | --- | --- |
| G1-01 | 通過 | 本項未通過 |

trad-remark
| 必过项 | 结论 | 备注 |
| --- | --- | --- |
| G1-01 | 通过 | 未通過（本輪） |

history-cn-future
| 轮次 | 结论 |
| --- | --- |
| 第四十五轮 | fail |
```

### 正向对照

| 用例 | 载荷 | 期望退出码 | 实际退出码 |
| --- | --- | --- | --- |
| cover-round36 | 第 36 轮合法覆盖行 | 0 | 0 |
| clearing-table | 普通清零表 | 0 | 0 |
| history-cn-past | 历史中文轮次表（第三十五轮） | 0 | 0 |
| fenced-table | 围栏内表格 | 0 | 0 |
| clean-pass | 干净 pass 报告 | 0 | 0 |

```text
cover-round36
| 必过项 | 覆盖点 | 结论 |
| --- | --- | --- |
| G2-07 | S2 加载 parallel 被拒 | 通过 |
```

```text
clearing-table
| 必过项 | 结论 | 备注 |
| --- | --- | --- |
| G1-01 | 通过 | 未通过项为空 |
```

```text
history-cn-past
| 轮次 | 结论 |
| --- | --- |
| 第三十五轮 | fail |
```

````text
fenced-table（外层为审计围栏，内层为被围栏的示例表格）
以下仅为示例，不是本轮判定：

```md
| 必过项 | 结论 | 备注 |
| --- | --- | --- |
| G1-01 | 通过 | 必过项 G1-01（本轮）未通过 |
```
````

根因与修复：`bc1005a` 在 `scripts/gate-check.ts` 里给 `isBareFailureCell` 增加前导分隔符剥离，并把 `residualAfterRequiredItems` 的前缀剥离改为最多三轮、每轮先剥前导分隔符。第四十三轮 P1 的假阴性来自去掉必过项 id 后残留的分隔符与重复前缀：旧实现只剥一次，残留仍带分隔符，未被识别为裸否定。本轮 11 条载荷全部命中，正向对照 5 条全部放行。

## 其余一致性与解析回归

在 `tests/gate/gate-check.spec.ts` 上定向复跑：183 passed | 1 skipped，exit 0。覆盖 A6/A7/A8/A8b/A9/A9b/A9c 七个拆分与隐藏载荷、繁体字形表格、延迟类状态词不被前缀剥离吞掉、历史中文数字轮次与未来轮次、围栏代码块与引用/缩进围栏、历史叙述与清零正句不误伤。

## 调度与并发交叉

定向复跑 3 个文件：20 passed，exit 0。

| 检查 | 证据 |
| --- | --- |
| 真实 HTTP 双入口共用并发上限 | execution-concurrency：6 个节点同时提交，`maxActive=2`，`started=6`，收尾 `inFlight=0`、`waiting=0` |
| 调度背压 | 排队上限满直接 SERVICE_UNAVAILABLE；服务写入口满时 503、记 warning、不落账本 |
| 停机 | drain:true 停收新任务并跑完排队；drain:false 立即拒掉排队、在跑收尾后关闭 |
| 异常释放名额 | 任务抛错也释放名额，后续任务照跑；写队列一笔中断不阻塞链尾 |
| 人工名额 | 人工名额独立限制，且不把普通任务堵死 |
| 装配接线 | dispatcher 只调注入的已调度执行函数，不重复排队 |

## 六项哈希独立重算

独立脚本按仓库口径重算（candidate 为 `[{path,sha256}]` 升序、change_scope 为 path 升序、evidence/invariants 按 id 升序、artifact 为 GateArtifact、body 为自锚点替换后的 LF 归一正文）。

| 哈希 | 正式 G1 记录（第 31 轮） | 独立重算（3cc55a4） | 临时门（第 44 轮） |
| --- | --- | --- | --- |
| candidate_hash | 100556b9… | 5276620c… | 5276620c… |
| change_scope_hash | 7f2ee36d… | c7759fb5… | c7759fb5… |
| evidence_index_hash | d1f7bcca… | d1f7bcca… | 1d563cc1… |
| invariants_hash | 6f75465b… | 6f75465b… | 6f75465b… |
| artifact_hash | 53d08f5b… | 53d08f5b… | 410337e4… |
| body_hash | 1c93f95e… | 1c93f95e… | dae65bde… |

正式记录是第 31 轮旧候选的产物，candidate/change_scope 与当前候选不同属预期；临时门由第 44 轮自测签出，六项与独立重算逐项一致。完整值：

```text
candidate_hash     5276620ce4958529eb1efba431a8afc8f0acb7b3502231bad621ee4ecd884ab6
change_scope_hash  c7759fb5f37d81aa59309990707bfeb0f8ca26665b9cf37634302587b0fddae7
evidence_index_hash(临时门) 1d563cc1b48def9aa34ce3ac993206a1e380a5f5d584be50ce8f8b67b7bacb52
invariants_hash    6f75465bfb0ecf3a6894ca1fe04537abf909b414efb93cbb2f66321f58ec6bf6
artifact_hash(临时门) 410337e45b1cbde40d5cb90c3698851dd6e1d30f87a9a2bc7e75e738def2403f
body_hash(临时门)     dae65bdee09c200aa3d307b0d7a068d3525d8cedcae6f3073b21475fd9bd8f95
```

## 交付证据核对

- 正式 G1 的 13 份门证据：12/13 与 HEAD 的 LF 归一 sha256 一致；`ev-gatecheck` 因第 43 轮修复改动了 `tests/gate/gate-check.spec.ts` 而旧记录过期，属旧候选预签态，重新签署时会重算。
- 临时门 13 份门证据：13/13 与 HEAD 一致。
- 25 份生成证据：25/25 逐份按 LF 归一重算（6 份 G1 + 19 份 G2）：

| 证据文件 | sha256（LF 归一） |
| --- | --- |
| docs/gates/evidence/G1/G-01.md | f2626b30f9eb472f1268b71047893be8f1d42a933438e43cd30af35d3318a129 |
| docs/gates/evidence/G1/G-02.md | 5fedb2e7539b1d410b7ff3c964ea36d77764fd037c4f4e40badbd67b7038b196 |
| docs/gates/evidence/G1/G-08.md | 2f2a73ddbf25fb59ea9b650635499856e66c94dcde81fca1a12ea3d424176c87 |
| docs/gates/evidence/G1/G-09.md | e944a2b6bd299faed3f9ce98c72647ceb8580eaae412a997d7be6cdcc5376625 |
| docs/gates/evidence/G1/G-14.md | 9cb900ea3cd3fe8e50f39907bd1cc148e19c0d965849809dea7021712bf7ac4d |
| docs/gates/evidence/G1/G-15.md | 1699f60368dd5b07e0771f20e3d689b38f7af11afb9dfe9587529248098b24a0 |
| docs/gates/evidence/G2/G-03.md | 514f9754fda67b8e1522d086fc6079301e00bd0185f9cca6dddec502c412ab70 |
| docs/gates/evidence/G2/G-04.md | a30155a2446531f5c5cd2677946805ca9a78f407cfc4626147f20fcd446eb961 |
| docs/gates/evidence/G2/G-05.md | 4775123a6d34878572d6b400b853a5b5fd6d782934186b729b52877c32b05d7f |
| docs/gates/evidence/G2/G-07.md | de51ca56aba24af02f7c1ef2c0bfba5248da11b5aaa7ba163aafacf9d8e0746a |
| docs/gates/evidence/G2/ev-g2-01.md | 0f06a14171f2eacc93429b3e062fdb0103b8219bd340fd8fda8971851ec422d4 |
| docs/gates/evidence/G2/ev-g2-02.md | 346af5813c653ba967af948a74aba27201b9ac906f13e54f4e588f8b18ea70e1 |
| docs/gates/evidence/G2/ev-g2-03.md | 0548e3d839680a548f007ce1bb2be4dfb087a8b8a62b0e18864568d9240c4e7b |
| docs/gates/evidence/G2/ev-g2-04.md | 65946e22958ef8764415d2af693245f8dc8da33e585ba4cee094e36f56ac71a6 |
| docs/gates/evidence/G2/ev-g2-05.md | 6f3b44cf5589ddc059b77f3640e5a23f93eef8351d9c5fba9dd6510abc26e2ba |
| docs/gates/evidence/G2/ev-g2-06.md | cef5cf3de601985af216cb935334414d56ff9f3f296871f709332f9e16b1f91c |
| docs/gates/evidence/G2/ev-g2-07.md | 607471ff9e475eaa30e3a83376b4c93aed12b6e209b7bd2601678737cf934a34 |
| docs/gates/evidence/G2/ev-g2-08.md | efb9c18ae992da700c48662b136fc4d78837708d85dc9a5395257ca80ef9c758 |
| docs/gates/evidence/G2/ev-g2-09.md | f43b50982b67843db87e1cae9b36b0048eca372d9734904d3e1090fc97b8d8b2 |
| docs/gates/evidence/G2/ev-g2-10.md | 30ab7abff7eaa4989bc7a5f339d3278b8ad79cc1932d0b94cc83465515c5cdb3 |
| docs/gates/evidence/G2/ev-g2-11.md | fb72ef55124d1b210ff4bf73ad1122cf067ecb93f96265e1fdfbdd050fc815dd |
| docs/gates/evidence/G2/ev-g2-12.md | 5c2d543fed703a7c388f029bc697c2591d99cb89296731cbe36b29a95b3584fe |
| docs/gates/evidence/G2/ev-g2-13.md | a5260693bb4f92e3463a92c6154a5ab7da21d89644733e8eef06c7241602a4bc |
| docs/gates/evidence/G2/ev-g2-14.md | 12e34ba8fd59c17322b364a122a5f265af87d353e10a13b6b4328049ceb6b39f |
| docs/gates/evidence/G2/ev-g2-15.md | 7648abe92c2026e4c5739c5f5714f448a2ce8864fc07a129f607675af415643f |

## 命令与退出码

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| pnpm install --frozen-lockfile | 0 | 克隆内安装完成（pnpm 12.3.4，Node v26.13.1） |
| pnpm typecheck | 0 | tsc --noEmit 通过 |
| pnpm test | 0 | 38 文件，552 passed / 1 skipped |
| pnpm build | 0 | tsdown 构建通过 |
| node --no-warnings scripts/check-evidence-repro.ts | 0 | 25 份证据各重跑两遍与 HEAD 字节一致 |
| node --no-warnings scripts/gate-check.ts docs/gates/G1.md（候选提交上） | 1 | 旧候选预签态，预期 |
| node --no-warnings scripts/gate-check.ts docs/gates/G2.md（候选提交上） | 1 | 旧候选预签态，预期 |
| 临时门 sign-gate（干净 pass 报告） | 0 | 13/13 必过项、13/13 证据 |
| 临时门 gate-check | 0 | 临时门可过 |
| 11 条攻击载荷 sign-gate | 1 | 全部拦下 |
| 5 条正向对照 sign-gate | 0 | 全部放行 |
| 定向 vitest（gate-check.spec.ts） | 0 | 183 passed / 1 skipped |
| 定向 vitest（调度 3 文件） | 0 | 20 passed |

## 临时门自测

临时门只改克隆内 G1.md 的 artifact 的 `audit_round` 与 `audit_report`，未签正式门：

- sign-gate exit 0，gate-check exit 0。
- `must_pass_items`：13 项全部 pass，`failed_items=[]`，`audit_round=44`。
- 13 份门证据逐份重算 13/13 一致。
- artifact_hash=`410337e45b1cbde40d5cb90c3698851dd6e1d30f87a9a2bc7e75e738def2403f`
- body_hash=`dae65bdee09c200aa3d307b0d7a068d3525d8cedcae6f3073b21475fd9bd8f95`
- candidate_hash=`5276620ce4958529eb1efba431a8afc8f0acb7b3502231bad621ee4ecd884ab6`

## 克隆与主仓隔离

- 克隆基线 HEAD：3cc55a4735601f18eba100480213644fed00e863（候选）。
- 主仓 `D:\aboutAI\dsh-orchestra` 未提交、未改文件、未使用其 node_modules；所有命令均在克隆内执行。
- 克隆工作树在报告提交前保持干净；临时门改动已丢弃，正式 G1/G2 仍是旧候选预签态。

## P2 明细

P2-1：`scripts/gate-check.ts` 的候选清单在遇到批内删除/移动的旧测试路径时，`git show` 的 fatal 行直接漏到 stderr（单次签署约五十行）。判定与哈希不受影响，但审计回执被噪声污染。建议在内容读取的 `execFileSync` 上吞掉 stderr，或对删除路径先判存在再读取。

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 44,
  "candidate_commit": "3cc55a4735601f18eba100480213644fed00e863",
  "candidate_hash": "5276620ce4958529eb1efba431a8afc8f0acb7b3502231bad621ee4ecd884ab6",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 1,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": [
    "G1-01",
    "G1-02",
    "G1-03",
    "G1-04",
    "G1-05",
    "G1-06",
    "G1-07",
    "G-01",
    "G-02",
    "G-08",
    "G-09",
    "G-14",
    "G-15"
  ],
  "failed_items": []
}
```
<!-- audit-verdict:end -->
