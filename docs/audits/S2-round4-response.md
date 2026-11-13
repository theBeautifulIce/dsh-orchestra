# S2 第四轮独立审计整改对照

- 审计报告：`docs/audits/S2-independent-audit-round4.md`（致命 0 / 重大 5 / 不阻断 5）
- 整改范围：M1–M5、N1–N5、e5
- 门：G1 / G2 重签后见 `docs/gates/G1.md`、`docs/gates/G2.md`

## 重大项

| 编号 | 审计指出的问题 | 整改 | 落点 |
| --- | --- | --- | --- |
| M1 | 门记录与 HEAD 漂移：`docs/reviews` 进了候选却不在排除表，HEAD 上两门 exit 1 | 把 `docs/reviews` 加进 G1/G2 的 excludes 与 dirty 例外表 | `scripts/gate-check.ts` |
| M2 | 工具白名单在生产路径没生效，策略与实际执行集没有交集 | 新增 `assertToolsAuthorized`：deny 优先、必须已注册、必须落在 allow 集；`runNode` 执行前调用 | `src/executor/tools.ts:43-62`、`src/executor/run-node.ts:61` |
| M3 | 单写者锁与 epoch 没接启动路径 | 新增 `openServiceOrchestra`：acquireDbLock → bumpEpoch → openServiceDb → createOrchestra，服务启动即走它 | `src/index.ts:104-126` |
| M4 | 租约 30 秒小于动作超时 120 秒，执行期间不续租 | 新增 `POST /v1/node-runs/renew`，`runNode` 每 10 秒续租、收口时清定时器；租约与续租间隔成为常量 | `src/service/server.ts:195-202`、`src/executor/run-node.ts:35-36,69-83` |
| M5 | `applyReport` 仍收 policy 参数，判定条件可由调用方给 | 判定条件改由 `applyReport` 内部按 run 的 `workflow_version` 与节点 id 从 `WorkflowCatalog` 取；命令层只传 catalog | `src/service/commands/apply-report.ts`、`src/service/commands/runtime.ts` |

## 不阻断项

| 编号 | 处理 |
| --- | --- |
| N1 | `commandHashOf` 的 cwd 按工作区根归一成相对路径，同一命令在不同临时目录不再算出不同哈希；ev-g2-08 重生成后连跑两次字节一致（`54e4b0e8415abd5b…`） |
| N2 | 新增「批内新增又删除的文件留在候选清单里」用例，断言占位字节 `ADDED_THEN_DELETED\n` 的哈希 |
| N3 | 未修。门记录仍靠人工签署 + HEAD 字节校验，没有密码学签名；残余风险如实留着，建议在 S3 开放真实执行权限前评估 |
| N4 | `tests/gate-check.spec.ts` 的门记录用例组超时放宽到 30 秒 |
| N5 | G1/G2 复现命令改成 `D:/NodeJs/node.exe` 直跑，并注明本机 pnpm 不可用 |

## e5

`verify_remaining_ns` 与 `startup_unknown_remaining_ns` 不再留死列：S3 计划 Task 5 第 5 步定为必做，要求进半态冻结剩余量、恢复时按 `now + remaining` 重挂（0 立即到点，NULL 才补满额并升 Gr），并补三例测试。

## 验收（实测）

- `tsc --noEmit`：exit 0
- `vitest run`：31 文件 / 272 例全过（14.64s，exit 0）
- `gate-check.ts docs/gates/G1.md`：exit 0（13 项必过、13 份证据，artifact_hash=`18088365050c…`、body_hash=`d99ba65f3744…`）
- `gate-check.ts docs/gates/G2.md`：exit 0（15 项必过、15 份证据，artifact_hash=`2b90f0fde3ca…`、body_hash=`3bed7c14d24b…`）
- ev-g2-08 连跑两次 sha256 一致：`54e4b0e8415abd5bc65ce885c407245d91ec099390e64a2b3188c89cb1144cbf`
- 提交：`a7b03cb`（整改）、`8881b9b`（G1 重签）、`e3f1fc7`（G2 重签）
