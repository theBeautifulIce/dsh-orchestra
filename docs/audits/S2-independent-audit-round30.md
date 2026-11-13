# S2 独立审计报告（第三十轮）

- 审计对象：`998c89bba27aaf299e9ea6eff941048103803a96`
- 审计范围：G2（S2 执行引擎与证据门）
- 审计方式：只读；候选克隆到 `D:/aboutAI/audit-r30`，在克隆内用夹具报告重签 G1/G2，再跑两道门
- 审计时间：2026-11-14
- 门：G2
- 候选提交：998c89bba27aaf299e9ea6eff941048103803a96

## 一、结论

结论：fail

G2 判 **fail**：P0 八条、P1 零条、P2 一条。

八条 P0 都是同一类缺陷的两个入口：结论解析词表与门正文注入。六条从审计报告入口绕过（副词前缀、英文插入语、采信/退回、准入、完成度否定、英文 consider ready），两条从门正文入口绕过（本门记录不具备准入条件 / 未达到准入条件）。八条都让 `sign-gate` 与 `gate-check` 双双 exit 0，门判决保持 pass。

P1 为零。P2 一条：链接定义里的隐藏否定不参与结论判定（隐藏文本attack的加固项，不单独改变本轮结论）。

## 二、重签基线与门检查

主仓审计时 HEAD 干净、等于候选。克隆从候选 998c89b 建出，夹具提交 45a0d3f 只动了 `docs/audits` 两份夹具报告与 G1/G2 的 `audit_round` / `audit_report` 字段，没有改源码与证据。

| 门 | 证据/必过 | sign-gate exit | gate-check exit | artifact_hash | body_hash |
| --- | --- | --- | --- | --- | --- |
| G1 | 13 / 13 | 0 | 0 | `63f2483a33a467bd12eb26866750dd17c6d840cc8e2533e17c1323d5ea820587` | `fbb44f94a5e73bf7daa9be76fbb56a119bb9ce96758ade7e7d59aa2b23ef4793` |
| G2 | 19 / 19 | 0 | 0 | `00285bbebff1a31c57c46310288a449f2e2725dac579b9d26e27c89b7264ac35` | `a10d64ff358e642858445e3e7bce1b84753e8601adc3b62bd33d29d04b64d2ce` |

G2 基线门文件 CRLF→LF 归一后的 sha256 为 `ee44f74c1e44059e255d24d2472d76b233b6826eef6523fb1fe5bfeb7487e15c`；G1 为 `036e5f3e5496342a4a41569773b2745ad603ea0d5999fa316c41ef4ecad7767a`。下文所有“门字节是否变化”都以此为基准，且一律先做 CRLF→LF 归一。

## 三、P0 载荷

### P0-1 副词/插入语前缀吃掉否定

根因：`FAIL_CONNECTORS` 不含“原则上”，主语后遇到它连接词遍历就停下；句首裸否定扫描又因行首是主语不触发。

```
本次审计原则上不推荐通过本报告。
```

| sign-gate | gate-check | artifact_hash | body_hash | G2.md LF sha256 | 门字节变化 | 签署提交 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | `ee2f9fd756d77e5cbcffff6b0987176c4dfc9023210c341f0efbce8e80b6c2d3` | `b4f9eb66a9dd6470b2038c68249b0431f5df933849c128125bb0b5824ccfeb29` | `8f7e533028a4cd44c69e0022047014aca371db519812e496cae4c57128e696d8` | 是 | `7b6466b` |

### P0-2 英文插入语中断否定遍历

根因：`This audit` 后遇到 `, on the whole,`，连接词遍历在 `on` 处停止，否定短语没有被检查。

```
This audit, on the whole, does not endorse the report.
```

| sign-gate | gate-check | artifact_hash | body_hash | G2.md LF sha256 | 门字节变化 | 签署提交 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | `758b07a92776215a92532c3b11fc2ec9285a97e40620283b76c6e53368a3705c` | `fd1406c8473588621a823f341d92495dbaf025a2c5fede5f8598b920e1f16a4d` | `ae92e4c1c97d7daac5f32850777691134f67b1495e67b052008b968279422d0b` | 是 | `c809867` |

### P0-3 采信/退回同义否定

根因：`不予采信` 的“采信”不在裁决词族，`退回`也不在宾语族；整句被当作历史叙述。

```
本次审计不予采信并退回本报告。
```

| sign-gate | gate-check | artifact_hash | body_hash | G2.md LF sha256 | 门字节变化 | 签署提交 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | `c5bfa4fb996f31dd438cc1373b4b1015551e87a89b880b581c7eec59fb4a34a0` | `54f6facc4e038ccadfb0a91d6d7587e9de9822c3a7b9d69c79a5db28df1b187a` | `f8f8b0f56eb229b8b552111405fa53683774715d45db7ce5c75d87825ca8435b` | 是 | `0bf0c5f` |

### P0-4 准入同义否定

根因：`不予` 后的检查要求谓词命中 `FAIL_PASS_STEMS`，准入不在其中；`不予准入` 的尾字“准”也不在允许尾字符集合。

```
本次审计结论为：不予准入。
```

| sign-gate | gate-check | artifact_hash | body_hash | G2.md LF sha256 | 门字节变化 | 签署提交 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | `7818f416f74c79a4807626699d3bcccf727bc796500d4deaec2a99c32220a03c` | `6467a2766a7b7c284377591b15289b351f5dff9cc620edd1d1d0cd79dbb0bec6` | `683a44b7eadd2564d2265774e9c3461b9b282cba9ff6bdf53bc259b6de78620c` | 是 | `f05adbc` |

### P0-5 无主语的完成度否定

根因：行首既不是裁决词也不是 `FAIL_SUBJECTS`，句首裸否定扫描只看否定词/裁决词开头，“整改工作”开头就漏掉；完成度词族也没覆盖“尚未完成”。

```
整改工作尚未完成。
```

| sign-gate | gate-check | artifact_hash | body_hash | G2.md LF sha256 | 门字节变化 | 签署提交 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | `9cc282ee15b6a92b9db00352a6f3e3b856e554db01484f24126e02dfa5afa8b7` | `494b20fb6cd949e9e84414c3abf69f624e6fa69fa919acd5fb0b81552ede4056` | `3c125e55c5329380f58272aa9ca1d3ff1d61193e364ec93a394ca286e51cdc33` | 是 | `d5a4364` |

### P0-6 英文 consider ready

根因：`does not consider the report ready` 不在英文否定族；结构否定只认 `not` / `does not` 直接接谓词，中间插了 `consider`。

```
This audit does not consider the report ready.
```

| sign-gate | gate-check | artifact_hash | body_hash | G2.md LF sha256 | 门字节变化 | 签署提交 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | `36380e8b72cc2ef9bfb2ff79e760063530fbf253fb915780764a04ac1883dc2e` | `7e29c9da332700f400107b3c7b862bd898c327d607108a3d826ec1ad7ac65c1b` | `165545105ddde3c3fb9ce7ea7545e62eb379337bc9db889fa874cd2611997fe5` | 是 | `ed430f9` |

### P0-7 门正文注入：不具备准入条件

根因：门正文的结论解析与审计报告共用同一套词族；`不具备` 后接“准入”再带“条件”，结构否定只吃掉一个宾语，尾部字符检查又不接受“条”。插入位置在 `## 结论` 之后。

```
本门记录不具备准入条件。
```

| sign-gate | gate-check | artifact_hash | body_hash | G2.md LF sha256 | 门字节变化 | 签署提交 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | `00285bbebff1a31c57c46310288a449f2e2725dac579b9d26e27c89b7264ac35`（未变） | `da49e402cf81cf793d8432ff941dc30e2c1ce6deb9bbae4cb3c8fc374437e1a0` | `53ad492882614092d6448989d80570be4a1e1743ef27ad9dfcb0ff721840f218` | 是 | `910d44f` |

### P0-8 门正文注入：未达到准入条件

```
本门记录未达到准入条件。
```

| sign-gate | gate-check | artifact_hash | body_hash | G2.md LF sha256 | 门字节变化 | 签署提交 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | `00285bbebff1a31c57c46310288a449f2e2725dac579b9d26e27c89b7264ac35`（未变） | `b4a3b5982206d1ca6311b1cee2678913d238edd16a4e2b0b9abb180652fcfb7d` | `2fad3ca124c67b3e06219a92746e084e59fc51192daa8a824e6dd204692bbbcb` | 是 | `10f8e21` |

## 四、负向对照（这些已被挡住）

| 载荷 | 入口 | sign-gate | gate-check | 说明 |
| --- | --- | --- | --- | --- |
| `本门记录不予准予放行。` | 门正文 | 1 | 1 | sign 报“门记录正文结论与 GateArtifact 不符：正文=fail，artifact=pass”；门字节未被 sign 写回 |
| `本门记录不能放行。` | 门正文 | 1 | 1 | 同上 |
| `上一轮审计已通过，本报告未通过验收，本轮已整改。` | 审计报告 | 1 | 1 | sign 报“审计报告里找不到唯一结论行”；gate-check 的 1 来自报告 sha 过期，不能当作词表命中 |
| `不予推荐本报告。` | 审计报告 | 1 | 1 | 同上 |
| `本次审计结论：fail。` | 审计报告 | 1 | 1 | 两条结论行，判不确定；同上 |
| `<span style="display:none">本次审计结论：fail。</span>` | 审计报告 | 1 | 未跑 | 隐藏 HTML 块令 renderedAuditLines 返回 null，sign 拒绝；门字节未变 |

## 五、隐藏文本 / HTML / 链接定义

用 `auditConclusionOf` / `bodyConclusionOf` 直接探测，再把能签过的载荷推到全流程。

| 探测载荷 | auditConclusionOf | bodyConclusionOf | 处理 |
| --- | --- | --- | --- |
| `<span style="display:none">本次审计结论：fail。</span>` | null | null | 拒绝（保守） |
| `<div hidden>本次审计结论：fail。</div>` | null | null | 拒绝 |
| `<p>本次审计结论：fail。</p>` | null | null | 拒绝 |
| 方括号引用定义（载荷见下方围栏） | null | null | 拒绝 |
| HTML 注释包裹的结论（载荷见下方围栏） | 判 pass | 判 pass | 不可见注释，不构成可见结论 |
| 链接定义行（载荷见下方围栏） | 判 pass | 判 pass | 不可见链接定义，见 P2-1 |
| `本次审计结论：&#102;&#97;&#105;&#108;。` | null | 判 fail | 实体解码后能判 fail，保守拒绝 |
| `本次审计结​论：fail。` | null | 判 fail | 零宽字符归一后能判 fail |
| `本次审计结论：通过，但准入条件尚未满足。` | 判 pass | 判 pass | 尾巴“尚未满足”未收口，属同族残留，并入 P0-4 说明 |

### P2-1 链接定义里的隐藏否定被忽略

```
[1]: https://example.com "本次审计结论：fail"
```

全流程：插入该行后 sign-gate exit 0，提交门后 gate-check exit 0。artifact `19409e8d1808b5727b7613dff5cb7d51adc3b989af65f928c40fef07dd8e8429`，body `97c83146cbaee6e1acd537b1eb20641d1ea878ae854035e6205f293e97d205d4`，G2.md LF sha256 `ec9708076f590e0fd860a27bdb39cf67dc0e08e41af93d81e975795c23c96fad`，门字节变化：是，签署提交 `1c176f3`。可见文本仍是 pass，危害低于 P0；但同一份报告里容器类隐藏文本（HTML 块）被拒绝、链接定义被静默忽略，策略不一致，建议统一收口。

## 六、必核项逐条

| 必核项 | 结果 | 依据 |
| --- | --- | --- |
| 证据门（弱证据/伪造痕迹/失败行/timeout/不可验证） | 符合 | `src/service/commands/apply-report.ts:228-267,318-326,345-405`；弱来源、exitCode 非数字、非零 exitCode 分别落 verification_too_weak / evidence_missing / tool_execution_failed；done 要求 tool_executions 行与 tool_finished 事件逐字段对齐，对不上 evidence_unverifiable；failed/timeout 走 allowFailed+requireFailure，必须有失败行 |
| verify 单调钟 | 符合 | `src/core/clock.ts:52-62` 先比 boot_id，再判 2 秒漂移，再比单调纳秒；`src/executor/run-node.ts:145-149,252-254,277-289` 的截止、锚点、账本时刻都走单调钟；9 个 clock 用例、101 个测试全过 |
| lease 与单写者围栏 | 符合 | `src/domain/lease.ts:48-152` 的 CAS 取租/续租/过期扫描；`src/infra/lock.ts:4-7` 用 proper-lockfile；`src/infra/sqlite/driver.ts:75-92` 在 BEGIN IMMEDIATE 后复核 epoch；G2-13 证据给出 ELOCKED 与 STALE_GENERATION |
| 工具授权 deny 优先 | 符合 | `src/executor/tools.ts:43-62` 顺序为 deny → registry.require → allow，deny 先挡；runner 只跑注册表固定参数，请求 args 不生效；9 个 tools 用例 |
| node-run 生命周期 | 符合 | `src/executor/run-node.ts:56-98,224-265` 先按 workflow 定义授权再取租，续租失败记 lease_lost 并按丢失收口，工具失败 blocked_post，最后才 verifying + submitReport；状态机不允许 started 直落 done |
| applyReport 签名收口 | 通过（附观察） | `src/service/commands/apply-report.ts:14-22` 参数固定；判定条件由 `policyForReport` :91-113 从 run 绑定的 workflow_version 与 workflow_definition_hash 取，调用方传不进 policy；HTTP 入口 `src/service/server.ts:213-221` 的 expectedStatus 由调用方给，但仍受当前状态、迁移表、租约与证据门约束，本轮未找到绕过 |
| required_hashes 真实接入 | 符合 | `src/service/workflows.ts:92-101` 取模板与节点 required_hashes 并集；`src/core/policy.ts:46-68` 逐键校验 64hex、output 同名产物存在、sha256(canonicalJson(product)) 等于键值、产物互异；apply-report.spec.ts 有伪造值/命令哈希冒充/空产物等 6 组正反用例 |
| 门记录与候选绑定 | 符合 | `scripts/gate-check.ts:1657-1704` 校验报告路径、轮次、报告 sha、唯一结论、门/候选绑定、候选祖先与候选文件未变。负向：提交改报告 → exit 1 `审计报告 sha256 与记录不符（报告改过就重新审计再签）：9b54a610720029bf… != a01a0600fc87bf7f…`；提交改 README → exit 1 `审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：README.md`。未提交的工作区改报告不拦，因为绑定对象是 HEAD 字节，符合提交式门记录的设计 |
| 六类哈希独立复算 | 符合 | 自写 `docs/audits/recompute.mjs`，不 import gate-check，按 git 原像独立算：candidate `cdea71d354349e541ea1494869efd89b8d9c465d933632ce898b5d8c352fd459`、change_scope `b4811c33ac596c2580c7268812fa1e79fbe12ad2f9257bacdd8fb88fd5648778`、evidence_index `1a221b945449b1e68b7811ba110ac022f25c9004438204dcdeae0f02a3068898`、invariants `925a77687f527e48c4d6cd97acfd55d9b9097f5ff6299822f94f8e46eef50304`、artifact `00285bbebff1a31c57c46310288a449f2e2725dac579b9d26e27c89b7264ac35`、body `a10d64ff358e642858445e3e7bce1b84753e8601adc3b62bd33d29d04b64d2ce`，全部吻合；候选 88 文件、证据 19 份、不变量 11 条 |
| 证据 sha256（LF 归一） | 符合 | sign-gate 与 gate-check 都按 HEAD 字节 CRLF→LF 后算 sha；独立复算 19 份全部吻合；提交篡改 ev-g2-01 后 gate-check exit 1（先被候选文件变更拦下，同样拒绝） |
| 正文证据表 | 符合 | `scripts/gate-check.ts:409-433` 要求正文 19 行与 artifact 的 id/file/sha 一一对应且不许缺项；独立重算 body_hash 与 evidence_index_hash 均吻合 |

测试命令（主仓只读执行）：

```
npx vitest run tests/apply-report.spec.ts tests/clock.spec.ts tests/lease.spec.ts tests/tools.spec.ts tests/runtime.spec.ts tests/sweep.spec.ts tests/integration/g2.spec.ts
```

结果：7 个文件 101 个用例全过；apply-report 46、g2 14、sweep 9、clock 9、tools 9、lease 7、runtime 7。

## 七、可复现命令

### 7.1 克隆与基线夹具

```
git clone D:/aboutAI/dsh-orchestra D:/aboutAI/audit-r30
git -C D:/aboutAI/audit-r30 checkout 998c89bba27aaf299e9ea6eff941048103803a96
```

两份夹具报告按下面字节写入（末尾保留一个换行），再跑 `fixture.mjs` 改两个 artifact 的 `audit_round` 与 `audit_report`：

```
# S1 基线审计报告（round30）

门：G1
候选提交：998c89bba27aaf299e9ea6eff941048103803a96

本报告是克隆内重签门记录用的审计夹具。核对范围：建库、迁移、哈希链、备份、权限与配置。必过项逐条对应本表证据，证据哈希按 HEAD 字节复核，门记录与候选绑定一致。

结论：pass
```

```
# S2 基线审计报告（round30）

门：G2
候选提交：998c89bba27aaf299e9ea6eff941048103803a96

本报告是克隆内重签门记录用的审计夹具。核对范围：单 agent 节点闭环、执行器、租约、工具授权与证据门。必过项逐条对应本表证据，证据哈希按 HEAD 字节复核，门记录与候选绑定一致。

结论：pass
```

```
import fs from 'node:fs'
for (const [gate, report] of [['G1', 'docs/audits/S1-baseline-round30.md'], ['G2', 'docs/audits/S2-baseline-round30.md']]) {
  const f = 'docs/gates/' + gate + '.md'
  let t = fs.readFileSync(f, 'utf8')
  t = t.replace(/"audit_round": \d+/, '"audit_round": 30')
       .replace(/"audit_report": "[^"]*"/, '"audit_report": "' + report + '"')
  fs.writeFileSync(f, t)
}
```

```
git add docs/audits docs/gates
git commit -m "gate fixture"
node --experimental-strip-types scripts/sign-gate.ts docs/gates/G1.md
git add docs/gates/G1.md && git commit -m "sign G1"
node --experimental-strip-types scripts/sign-gate.ts docs/gates/G2.md
git add docs/gates/G2.md && git commit -m "sign G2"
node --experimental-strip-types scripts/gate-check.ts docs/gates/G1.md
node --experimental-strip-types scripts/gate-check.ts docs/gates/G2.md
```

预期两道门 exit 0，G2 artifact `00285bbe…`、body `a10d64ff…`。

### 7.2 审计报告载荷

```
git reset --hard 45a0d3f
node -e "const fs=require('fs');let t=fs.readFileSync('docs/audits/S2-baseline-round30.md','utf8');t=t.replace('结论：pass','本次审计原则上不推荐通过本报告。\n\n结论：pass');fs.writeFileSync('docs/audits/S2-baseline-round30.md',t)"
git add docs/audits/S2-baseline-round30.md && git commit -m "payload"
node --experimental-strip-types scripts/sign-gate.ts docs/gates/G2.md
git add docs/gates/G2.md && git commit -m "sign payload"
node --experimental-strip-types scripts/gate-check.ts docs/gates/G2.md
```

另一条直接替换载荷行即可（例如 `本次审计不予采信并退回本报告。`、`整改工作尚未完成。`）。P0-2/P0-6 用英文载荷替换同一位置。

### 7.3 门正文载荷

```
git reset --hard 45a0d3f
node -e "const fs=require('fs');let t=fs.readFileSync('docs/gates/G2.md','utf8');t=t.replace(/## 结论\r?\n/,'## 结论\n\n本门记录不具备准入条件。\n');fs.writeFileSync('docs/gates/G2.md',t)"
git add docs/gates/G2.md && git commit -m "gate body payload"
node --experimental-strip-types scripts/sign-gate.ts docs/gates/G2.md
git add docs/gates/G2.md && git commit -m "sign gate body payload"
node --experimental-strip-types scripts/gate-check.ts docs/gates/G2.md
```

### 7.4 六哈希独立复算

```
node docs/audits/recompute.mjs D:/aboutAI/audit-r30 docs/gates/G2.md
```

输出七个 OK、`files=88 evidence=19 invariants=11`。

## 八、P0/P1/P2 汇总

- P0：8（P0-1 至 P0-8）
- P1：0
- P2：1（P2-1 隐藏链接定义否定）
- 门结论为 fail

