# S2 独立审计（第二十轮）

门：G2
候选提交：074158eea2af4bdfea9a21230391f4d46f63db40

结论：fail

## 总判

候选 `074158ee` 把定义删除限制到段落起始、修了围栏 NBSP 关闭与列表四空格续行，但判定仍建立在“行形状”而非 CommonMark 实际块/行内解析上。本轮 13 条攻击全部端到端通过：sign-gate 采信了同时含可见 pass 与可见 fail 的报告（exit 0），G2 门记录被改写，签后 gate-check 以 exit 0 放行（19 项必过、19 份证据哈希复核）。同一份报告经 markdown-it CommonMark 渲染，可见文本同时出现 pass 与 fail，属于“不可见 pass 被采信”的 P0。P0=13，P1=0，P2=2。

根因四类：引用定义按形状整行删除、伪链接/伪图片按正则整行删除、链接段与缩进续行的毒化不按渲染结果解码 HTML 实体、结论归一化不处理 Unicode 格式字符（Cf）。每条攻击都在主仓之外的临时 clone 内完成：写报告、改 G2 的 audit_round/audit_report、提交、sign-gate、再提交签名并跑 gate-check。

## P0（13 条，均可让不可见 pass 被采信且门记录被改写）

### P0-A 引用定义按形状删除正文（3 条）

- `def-trailing`：段首一行形如引用定义（方括号标签、冒号、URL、引号标题），但尾部多出可见文字，按 CommonMark 是普通段落、整行可见；gate 在段首按形状整行删除，渲染后可见 fail。
- `def-invalid-dest`：目标位置含空格，整行不是定义、字面可见；gate 仍整行删除。
- `def-then-indent`：定义行后以单空格起始的新段落是可见文字；gate 因 inDefinition 且行首空白把它删掉。

### P0-B 伪链接、伪图片、未定义引用按正则删除（4 条）

- `fake-link-spaces`：方括号加圆括号目标的行，目标含空格，按 CommonMark 不是链接、整行字面可见；gate 按链接正则删掉目标与标题。
- `fake-link-bare-title`：目标后直接跟裸标题，同样非法，可见 fail 被删。
- `fake-ref-undefined`：引用标签未定义，第二组方括号字面可见；gate 删第二个标签。
- `image-fake-dest`：感叹号加方括号的伪图片，目标含空格，整行可见；gate 的图片分支先删。

### P0-C 链接段/缩进续行毒化不解码实体（5 条）

- `entity-link-para`：含方括号标签的段落整体被掩，重建可见文字做毒化判定时不解码 `&#65306;`，可见 fail 漏网。
- `entity-heading-after-link`：与链接行无空行间隔的 ATX 标题被并入链接段整段隐藏，实体 fail 不解码。
- `entity-list-after-link`：同上，列表行并入链接段。
- `entity-indented-list`：列表四空格续行走 maskIndentedAuditCode 的毒化，同样不解码实体。
- `setext-entity`：链接段落加 setext 下划线，整段按链接段隐藏，实体 fail 漏网。

补充探针（同根因，未单列端到端）：`&#58;`、`&colon;` 在链接段内均让 gate 返回 pass 而渲染可见 fail；`结论<ZWSP>：fail` 放在链接段内同效。

### P0-D Unicode 格式字符未归一（1 条）

- `zwsp-colon`：`结论<ZWSP>：fail` 在渲染中 ZWSP 为零宽，人眼读作“结论：fail”；gate 不剥 Cf 字符，只认行首 ASCII 空白与冒号，顶层仍识别出唯一的 `结论：pass` 并签名放行。NBSP（U+00A0）与全角空格（U+3000）变体则被 gate 判 null 拒绝，方向安全但同一缺陷。

## P1

无。

## P2

1. 过拒：引用定义行后接四空格标题（`def-four-indent-after`）在 CommonMark 下标题不可见、可见结论只有 pass，gate 却返回 null 拒绝。方向安全，但说明定义判定仍按形状而非解析结果。
2. 结论识别只归一 ASCII 空白：结论两字与冒号之间夹 NBSP/全角空格时 gate 判 null（拒绝）而非识别为一条结论，属同一归一化缺口的安全侧表现。

## 复验项（第十九、十八轮载体）

- 第十九轮 P0 三载体：正文段落后、列表项内、引用块内加三空格缩进的引用定义行（标题里带可见 fail），gate 均返回 null 拒绝；markdown-it 渲染可见 fail，确认已修复。
- 第十八轮 title P0：列表项/引用块内单反引号非法 title 载体，gate 均返回 null 拒绝，确认已修复。
- 候选声称的“真正缩进代码不毒化”：该形态渲染不产生可见 fail，但 gate 仍以 null 拒绝（见 P2-1），不构成放行路径。

## 阳性对照

纯可见 pass 报告（`门：G2`、`候选提交：074158e…`、单行 `结论：pass`），clone 内提交 `1db012c180d94cb2e8d27bd574805f7bc5938e09`，报告 LF 归一 sha256 `6c04f0848d6bea02ecd827c62b08f450bc8af4e871be4f5cf9d53f6ee67046b1`。sign-gate exit 0，G2 sha256 由 `b30cd6bb…` 变为 `f9dd6625…`，artifact_hash=`7523bd4e55d802fb612178130a548fcbdcbe13ca328dcb695e479a737669898b`，body_hash=`226051fbbe73c2c0ababe5d6da7099cafb81c53c7f17784cec8614678579c147`；提交签名 `e6aa7091bb1486e8ba25760e80cd1f96f4906626` 后 gate-check exit 0，输出“gate G2 通过（19 项必过、19 份证据哈希复核）”。

## 阴性对照

报告顶层同时写两条结论行（一条 pass、一条 fail）后提交，sign-gate exit 1，G2 sha256 前后均为 `b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d`（未被改写），报错为“审计报告里找不到唯一结论行，不能拿它当门记录依据”。

## 13 条端到端攻击的退出码与改写事实

| # | 攻击 | 报告提交 | sign-gate | G2 被改写 | 签后 gate-check |
|---|---|---|---|---|---|
| 1 | def-trailing | `e0cf5e74` | 0 | 是 | 0 |
| 2 | def-invalid-dest | `9b98c664` | 0 | 是 | 0 |
| 3 | def-then-indent | `9c509315` | 0 | 是 | 0 |
| 4 | fake-link-spaces | `c792378a` | 0 | 是 | 0 |
| 5 | fake-link-bare-title | `629d694a` | 0 | 是 | 0 |
| 6 | fake-ref-undefined | `499f94b1` | 0 | 是 | 0 |
| 7 | entity-link-para | `ce51331d` | 0 | 是 | 0 |
| 8 | entity-heading-after-link | `f8a91487` | 0 | 是 | 0 |
| 9 | entity-list-after-link | `ebe24e4b` | 0 | 是 | 0 |
| 10 | entity-indented-list | `d48cb50d` | 0 | 是 | 0 |
| 11 | zwsp-colon | `3ed57152` | 0 | 是 | 0 |
| 12 | image-fake-dest | `fcc59b3e` | 0 | 是 | 0 |
| 13 | setext-entity | `32181ec9` | 0 | 是 | 0 |

所有行：sign_exit=0、g2_changed=True、gate_check_exit=0；G2 sha256 均由 `b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d` 变为各行不同的新值（见下方哈希清单）。

哈希清单（报告 sha256 按 LF 归一；G2 前值均为 `b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d`）：

```text
def-trailing
  report_commit=e0cf5e740c1e845b43a9696ff8f366f2d302f085
  report_sha256=0a15d348a8cc5b81ebb350ca6cb88f0cc2dcde2a2f5f1c9287a1046f54fb0474
  sign_exit=0 gate_check_exit=0 g2_changed=true
  g2_before=b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d
  g2_after=43a73e62f5798d2c1d1b0c2c2cfdfa208c5fed7355ba10d0654c4c4a1660cf4c
  artifact_hash=fbde9828dbdc0b6e78caccb190a4050d2ad23b72b44a9206f3f7f4bac982a9bb
  body_hash=2d2e83932e4f25685031475c90cc8551e4a380fa5328b911069a0d6615cd3de2
def-invalid-dest
  report_commit=9b98c664f798579927dade20d2b111ace2921d1f
  report_sha256=a7280378c91d6cba764267f9c6f6014696bacfea3b46f2cc774fa4cbf8141120
  sign_exit=0 gate_check_exit=0 g2_changed=true
  g2_before=b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d
  g2_after=e804c1e8791cfe63cc077cc11f4863f5e670c4c6754507de130de0d9241576a0
  artifact_hash=93af457046ed0ecd8ec15bc59a0897ddd711e57ebdf1f618551d5ea58ed30f2e
  body_hash=f8e856f4a41959bd71df58ce13a709474a887af87ceda487b1f852085e4e1625
def-then-indent
  report_commit=9c50931538580ecbd1ba5ceea8b7c3db7dd062aa
  report_sha256=1ea63f9ad902bd11273767c12a0293a915430c9a011892f51d32c75a1daea585
  sign_exit=0 gate_check_exit=0 g2_changed=true
  g2_before=b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d
  g2_after=700a58e1d6154e5854851a11a6829dff1e77274abdd2f11b933e0a6bc211ae97
  artifact_hash=74faa08c834b635ed0325d86e10a9d31c85284219f3a009b9f82c986d8529c04
  body_hash=f8ea89139c8a75e36dfeeb2eec2f16b890bc4a8dfec3a7df3515fc9986bff78c
fake-link-spaces
  report_commit=c792378a3e6e52b69ac338659ec797ffcccfa5fb
  report_sha256=d44e87eec7a74c0f7ac0cd36e4f2a51174a347315159c309a2a71e902fe0ea13
  sign_exit=0 gate_check_exit=0 g2_changed=true
  g2_before=b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d
  g2_after=f602f5c5878428899c2043f9e0f6e5180690416433226e1c4f134bb2b775a45a
  artifact_hash=b74f36f1a399bf74a3d1a05a6da06de26780605cd3d0e98905589098bfc86f45
  body_hash=c730d52eaba31ab223adff179599759a1b5e152eb13c9cf26c378b256083b114
fake-link-bare-title
  report_commit=629d694ac07309dc17131a021c4f4fa9b49ab1dd
  report_sha256=9ac7fca1e81f339cb41204748b8bc02a2d3af872fffb29d80617b58b81c2fde4
  sign_exit=0 gate_check_exit=0 g2_changed=true
  g2_before=b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d
  g2_after=723c2efcf80af051a5706e4454e07136fbcf30c8b410c4e7fc451d7bbb948660
  artifact_hash=0b625dad609dd8ec37b716ac97adff7d352e5aa6c05925fb0dd9dbff48c646e1
  body_hash=85ca7088f7f6d13043c4979705e25202ad133aef9311506d5fe68f74ce5227d9
fake-ref-undefined
  report_commit=499f94b1e4215196e7e85518f877acd0a47323f3
  report_sha256=44358e25526dbc48ae54e43d137be6c185a4b11fce2c8fea90d4393b3dc4386e
  sign_exit=0 gate_check_exit=0 g2_changed=true
  g2_before=b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d
  g2_after=3e8f001b7d5f06dbac693af9a95158ac0b64430041ed681ed47d87e467b0d43e
  artifact_hash=06af1dd75ce7da808534ed4d2e2a185e36c26f01d792cead8ea4623f7e9a2e42
  body_hash=de8aba552979ae5b4bb49dfe4b0f9d91447f30b75de55e6f2d558f33e24f22de
entity-link-para
  report_commit=ce51331d3f37ee818017c128f2f425bc795fe9c9
  report_sha256=60d11432156402dc122e26079369371b560e8f90354f29585355e45bd49b5652
  sign_exit=0 gate_check_exit=0 g2_changed=true
  g2_before=b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d
  g2_after=abf280bc98d37f23fd5b158835e9a2ee1bd23107fb8f23468b5a16ec0437282c
  artifact_hash=1ad4d7ea31f7e7662bb80149b2fac854a25d3ab22da56dfa8dfe446d88fa938c
  body_hash=70a2d004360e5a50ee534255f23de3e6d11a63d930c354f019acf5fe00a73d64
entity-heading-after-link
  report_commit=f8a91487ffada755fbb6f40774eb32bc83691aff
  report_sha256=04e986886dd571cd02094a91b7bdc2232618ce67d82f8eaed5117863e0f7e508
  sign_exit=0 gate_check_exit=0 g2_changed=true
  g2_before=b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d
  g2_after=8d6c0638debf891f0d5f4f6770ba96b06156ffb5c192257bf7729b7545d1e65c
  artifact_hash=83628ccb4100ef23d672fdde4a87359c203a4c463bdc26230320ac919145752f
  body_hash=852f9cc596bf28f7e42af1e0e760a6d345c30290611a52767d67cc5bc9dec6da
entity-list-after-link
  report_commit=ebe24e4bbb0febc7684bc9f3617dfb21a587e9c7
  report_sha256=176a8ed62fecdb4c41261066569ed6c2f6a6672fbc73ed7b48b147d7fb80d23e
  sign_exit=0 gate_check_exit=0 g2_changed=true
  g2_before=b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d
  g2_after=eab3583ee0d7a25a391e256cf8b5231cd6abc973c913fa6edd46f013981f654b
  artifact_hash=49c49454ec054a14212ff6a332631daaa8cbed942a11fa5cfa9cea46b06cfb5a
  body_hash=eebc1c095e961a382031f7dc2038c2c489ab41a6bfd04f4e0ee5868469a574b5
entity-indented-list
  report_commit=d48cb50d000e841c302e8a56344db56574aec082
  report_sha256=6fb03df38a65909c9f20516e976451f718c1a7bf4fde008b2f505c25288c5807
  sign_exit=0 gate_check_exit=0 g2_changed=true
  g2_before=b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d
  g2_after=5c4f56cce77f7f2939f9679438373ba16e4e7e0694925ac2d0e7d43308b8d14e
  artifact_hash=95039aebf7c439ec32cbc719142708ceed9b80e77643c2746a5e2f999621d408
  body_hash=5b3a6df6dc563d1c9d902aa1d7e27cc0939d1829e4b96b42c9e6f4b9f5907ee6
zwsp-colon
  report_commit=3ed571522f6b6718d3b8d67f750f28529c734502
  report_sha256=a2531be2b36cce1880916b094aab583eeecd579b6f52e9c4e989ed6d04f62405
  sign_exit=0 gate_check_exit=0 g2_changed=true
  g2_before=b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d
  g2_after=762814e7cd79d77bccd76b16ef5e1efe7c42b05ddaa35e099d6c9834029e5253
  artifact_hash=6bf281c378c3d765f3b841527bce785a0374c5f0eea64c12c13fa90946090cbe
  body_hash=5be9ea3f7f9e392276594d4a435c2ff80d6a5d9ec04841f2157f1a757e379e98
image-fake-dest
  report_commit=fcc59b3ece53fc495680ca1bab6de2d3de8c48ef
  report_sha256=f39a05f33bf0ecbfcf1388d09d82ec743de3fffe5ad597b44d174cd177e35e1d
  sign_exit=0 gate_check_exit=0 g2_changed=true
  g2_before=b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d
  g2_after=6b79200cc51804a5a3f397bbcce343d342880950a5241a793caa173a0410bdac
  artifact_hash=eac59225630e015131db7d14a2145f0de40ed10193dcd5b69c07201011f8f901
  body_hash=1ce411cb3a2a0e260fd50e12f9d56a4aabd53359e51df404aa26f8ee14134f37
setext-entity
  report_commit=32181ec9580ea451c31bd92fe382f368dd28fb30
  report_sha256=56d2088865748dcce06a45a5d4340edd89048b9896d8b810d57552c669f13f82
  sign_exit=0 gate_check_exit=0 g2_changed=true
  g2_before=b30cd6bb1e1f6c388d1978e20cc7e8bca1c5214bad02a9339a9f5a0c6de1693d
  g2_after=2e76997a6f7ceb20eed1d74270a41ad35908c17dc4f5d4a720114ab9f490ece9
  artifact_hash=4980f0dfe0d733df3c338c4a15fa969583b15a45be2322e5ced07a9d84986b71
  body_hash=202aabc8158fadf931137c2f87cffc80d0ac612e09e7d1ee975c9da699789dba
```

## 证据与基线

- 候选期 G2 与证据自 `e63c36f` 未改：`git diff --stat e63c36f 074158e -- docs/gates docs/gates/evidence` 为空；G2.md blob 在两端均为 `5d4c9c1ae3c6fd667951ae0cebc2acc9d99d06a8`。`docs/audits` 的唯一差异是既有 S1 第十四轮报告，不在 G2 证据链内。
- G2 规格：19 项必过、19 份证据、11 条不变量；scopeBase=4f3ada7，排除 docs/gates/G1.md、docs/gates/G2.md、docs/audits、docs/reviews、handoff.md。
- clone 内 tsc exit 0；vitest gate-check.spec 为 11 failed | 49 passed（60 例），11 例均为已知预签态 G1 夹具失败（报告 sha256 全零 vs 50ba1b13cdf1b84d），与候选前一致。
- 主仓未改代码、未签门、未提交；唯一写入是本报告 `docs/audits/S2-independent-audit-round20.md`（未 git add/commit）。

## 复现命令

```powershell
git clone --no-hardlinks D:/aboutAI/dsh-orchestra D:/aboutAI/_audit_s2_r20
Set-Location D:/aboutAI/_audit_s2_r20
git checkout 074158eea2af4bdfea9a21230391f4d46f63db40
# 写报告 docs/audits/S2-independent-audit-round20.md（见下方载荷），
# 把 docs/gates/G2.md 的 audit_round 改为 20、audit_report 改为该路径，提交
D:/NodeJs/node.exe --no-warnings scripts/sign-gate.ts docs/gates/G2.md   # 攻击期望 exit 0（实际即被采信）
git add docs/gates/G2.md; git commit -m "Signed attack"
D:/NodeJs/node.exe --no-warnings scripts/gate-check.ts docs/gates/G2.md  # exit 0
```

每条攻击的报告头均为 `门：G2`、`候选提交：074158eea2af4bdfea9a21230391f4d46f63db40`、`结论：pass`，其后放载荷；下面 13 段载荷经 markdown-it CommonMark 渲染可同时看到 pass 与 fail：

```text
== def-trailing ==
结论：pass

[x]: https://example.com "t" 结论：fail

== def-invalid-dest ==
结论：pass

[x]: not a url "结论：fail"

== def-then-indent ==
结论：pass

[x]: https://example.com
 结论：fail

== fake-link-spaces ==
结论：pass

[a](not a url "结论：fail")

== fake-link-bare-title ==
结论：pass

[a](https://e.com 结论：fail)

== fake-ref-undefined ==
结论：pass

[a][结论：fail]

== image-fake-dest ==
结论：pass

![a](not a url "结论：fail")

== entity-link-para ==
结论：pass

见[证据](https://e.com)，结论&#65306;fail

== entity-heading-after-link ==
结论：pass

[x](https://e.com)
# 结论&#65306;fail

== entity-list-after-link ==
结论：pass

[x](https://e.com)
- 结论&#65306;fail

== entity-indented-list ==
结论：pass

- 列表项
    结论&#65306;fail

== setext-entity ==
结论：pass

[x](https://e.com)
结论&#65306;fail
---

== zwsp-colon ==
结论：pass

见下段：结论<ZWSP>：fail
```
