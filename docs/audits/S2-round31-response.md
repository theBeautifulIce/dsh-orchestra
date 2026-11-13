# S2 第三十一轮审计对照表

审计报告：docs/audits/S2-independent-audit-round31.md（结论 fail，P0=4 组 / P1=1 / P2=2，候选 e717293）
本对照表对应整改候选。

## P0-1：post-pass 尾巴

报告侧载荷“本次审计结论：通过，但准入条件尚未满足。”与门正文侧“失败项为空，准入条件尚未满足，无 run”都被签过。

整改：分句尾部否定（scripts/gate-check.ts:969）逐分句检查否定收口，不再要求否定词前必须有已知主语；“通过。准入条件尚未满足。”与“通过（准入条件尚未满足）”同样判 null/fail。门正文的正式结论行之外也走同一条扫描，不再只看结论行本身。

## P0-2：句内语气副词与框式

载荷：本次审计从原则上讲不推荐通过本报告；本次审计整体而言不推荐通过本报告；本次审计既不予采信，也不予推荐。

整改：分句尾部否定使“从原则上讲/整体而言”不再是拦截条件；“既……也不……”按逗号拆开后，后一分句“也不予推荐”以否定谓词收口，直接判否决。英文插入语 generally speaking 另补进连接词表，兜住带逗号的英文句。

## P0-3：整改程度否定

载荷：整改工作未完全完成；整改工作还没有完成。

整改：FAIL_FILLERS 补 完全/完全地/彻底/徹底/根本/真正，FAIL_NEGATIONS 补 还没有/還沒有。两条现在 audit null / body fail；“整改工作已完成”仍 pass。

## P0-4：跨行引用定义、块引用续行与实体编码

载荷为两种写法：第一行 [1]:，第二行 /url，第三行带引号的“本次审计结论：fail”；块引用版本每行以 > 开头；第三种是同行定义加 title 里的实体编码 \u0026#102;ail。

整改：hiddenDefinitionFailure（scripts/gate-check.ts:1035）不再只认“缩进续行”，定义起始行之后最多三行非空内容都按定义块扫描，块引用前缀不再中断；扫描前先按渲染结果解码 HTML 实体。门正文的 [1]: 加下一行 fail 也走同一入口，返回 fail 而不是 pass。

## P1：required_hashes 生产路径不可达

加载 required_hashes:["artifact"] 后派发 ro.echo，run-node 的 output 固定为 {evidence_trace}，apply-report 要求同名产物，dispatch 返回 failed，node_runs 落 blocked_post，report_registry 落 rejected，事件 reason=verification_too_weak。

判定：这是失败关闭，不是越权成功；但生产路径确实产不出任意命名产物。接受为 S3 前置项：要么在 run-node 契约里明确可产出的产物名，要么把 required_hashes 限制为服务端可签发集合。审计 pass 前不移除现有保护。

## P2：门正文与测试覆盖

- 门正文的 post-pass 尾巴已由同一扫描覆盖，并新增“结论：pass（准入条件尚未满足）”断言。
- required_hashes 的生产回归列入 S3 前置项，不在本轮补一条只测夹具的假阳性用例。

## 验证

- tsc --noEmit → exit 0。
- 全量 vitest → 33 文件 / 374 例，362 passed / 12 failed；12 红 = 11 个 G1 预签态 + 1 个被更早锚点校验挡住的 body_hash 顺序用例，均非解析器回归。
- 新增 S2 第三十一轮用例：post-pass 分句、两层语气副词、程度否定、三形态跨行定义与门正文定义全部拒绝；三条安全正句 pass。
