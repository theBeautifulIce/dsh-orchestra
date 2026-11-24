# 插件内多文件返工与人工验收

本说明对应 `lilium/v0.1.0-beta.1` 的 `96801aa6c8229648e8825850e2c48ecd20df6e19` 之后的交付修复。实现全部位于 Orchestra 插件；`src/executor/dsh-host.ts` 是插件适配器，未修改 DSH 宿主代码，也不依赖新的宿主文件选择器或卡片动作。

## 数据契约和授权

迁移 `077_rework_file_manifests.sql` 增加四列。执行前按项目迁移流程备份数据库，使用正常启动迁移；在联合补丁中它排在 075、076 后。不要手动跳过已有迁移，也不要为回滚删除已产生的返工历史。

| 位置 | 字段 | 含义 |
| --- | --- | --- |
| `rework_requests` | `file_manifest_json` | 当前待授权的逐份文件方案 |
| `rework_attempts` | `file_manifest_json` | 授权时复制的本轮文件方案，写入后不可改 |
| `rework_attempts` | `result_manifest_json` | 实际完成后冻结的整轮成果，写入后不可改 |
| `rework_attempts` | `accepted_files_json` | 本轮已核对的精确版本，默认 `[]` |

请求和授权 API 支持可选 `file_manifest`。下面的 `artifact_id`、`sha256` 必须来自真实原件元数据，示例中的占位值不能直接提交。

```json
{
  "originals": [
    {"artifact_id":"原报告编号","sha256":"原报告的64位哈希","file_name":"report.md","action":"revise"},
    {"artifact_id":"原数据编号","sha256":"原数据的64位哈希","file_name":"data.csv","action":"keep"},
    {"artifact_id":"旧说明编号","sha256":"旧说明的64位哈希","file_name":"obsolete.txt","action":"remove"}
  ],
  "attachments": ["audit.md"]
}
```

原件清单必须覆盖目标尝试按文件名确定的全部最新版本，包含每份原件的编号、哈希和文件名。遗漏、重复、过期或字节被更改都会拒绝。反馈指向的原件必须修改；其余原件逐份选择修改、保留或移除。移除仅表示不进入新一轮交付，历史文件和审计记录保留。已确认计划中的必交文件与会话正文不能移除。

附件名称必须在授权时明确。不得与任何原件同名，也不得在执行时临时扩充。修改件和新附件受当前文本生产能力限制；原样保留的文件不需要模型重新生成。普通文件和会话正文分别遵守每节点八份的限制，普通文件不能占用本步骤会话正文的生成文件名。

`targeted_revision` 的人工请求可以按既有策略直接授权；智能体提出的多文件清单先等待人工授权。`rerun_node` 在授权请求里提交整份清单。`replan_subgraph` 先通过 `review(action="set_manifest")` 确认文件方案，再按返回的新 `revision` 生成和审核局部执行方案。确认文件方案会使此前的局部方案版本失效，必须重新生成。

## 执行、恢复和验收

1. `schedule()` 校验清单，创建新尝试，并把清单复制进 `rework_attempts`。既有单文件请求和历史数据的 `NULL` 清单继续按单文件规则工作；多份原件不再通过“完整重跑”绕过逐份授权。
2. 执行输入的 `revision.file_manifest_json` 告知智能体要修改哪些文件、保留哪些文件以及必须新增的附件。`read` 只允许读取本轮未移除的精确原件版本。
3. `publish` / `publish_text_result` 校验批准的名称。保留文件由插件读取真实原件字节并重新登记到新尝试，使用确定编号保证恢复幂等。保留会话正文时重新绑定计划编号、交付项和新尝试，不能复用旧正文的执行身份。
4. 保留文件在原生发布和纯成果完成证据链中接线。恢复扫描再次核验来源字节、输出名称集合、内容哈希和保留件的一致性；缺文件、多出未批准文件、改写保留件或损坏内容都保持下游保护并升级处理。
5. 完成后冻结 `result_manifest_json`。其中每项和 `accepted_files_json` 每项都采用 `{artifact_id,sha256,file_name}`。旧字段 `result_artifact_id/result_artifact_hash` 继续保存首份，用于旧读者兼容。
6. 每次验收提交一个精确版本及当前请求 `expected_revision`。只验收一份时保持 `awaiting_review`，增加版本号，不释放下游；全部文件核对后再次核验全部字节，再关闭返工和释放下游。重复操作号返回原回执，旧版本的新操作号被拒绝。
7. 下游输入快照引用本轮冻结的结果版本，后来的同名登记不能替换人工已经核对的版本。再次要求修改时，选中件成为下一轮修改件，其余本轮成果默认保留；下一轮仍需要按现有策略授权。

原件的保留期限继续有效，复制不会延长其期限。已过期或被清理的原件不能伪造为可读文件；需要人工重新提供有效版本。现有纯节点、并行成员、外部副作用、预算和局部图授权限制保持有效。

## 人工界面

`ReworkPanel` 的请求表单和授权卡片展示每份文件及“修改并交付新版 / 原样保留 / 从本轮交付移除”，附件按每行一个文件名填写。表单读取全部成果页和步骤页，避免正式文件被附件数量挤出选择范围。

修订验收只展示尚未核对的冻结版本，显示“本轮已核对 X / Y 份”。前后对比按当前所选文件匹配原件；新附件明确显示没有原件。只有成功获取完整预览，或成功下载并确认核对该版本，才能点击验收。切换文件、哈希或留验身份时清除已读状态。

`initialTarget` 支持 `{node_run_id,artifact_id,sha256,request_id}`，供任务主按钮直达具体审核对象。精确目标自动展开并预览；目标已处理、版本变化时提示刷新，不自动改为另一个版本。尚无文件的留验仍可定位步骤和撤销。

普通留验的验收和撤销必须携带显示时的 `hold_id + expected_revision`。会话卡片不得在点击时重新查询最新身份，再替旧卡片提交结论。多页签重留、部分验收或撤销后，旧页面需重新读取当前结论。

## 回归检查

执行 `pnpm typecheck`、`pnpm build`，以及：

```sh
pnpm exec vitest run --maxWorkers=1 tests/integration/rework-manifest.spec.ts tests/integration/rework-coordinator.spec.ts tests/integration/rework-runtime.spec.ts tests/integration/rework-planning.spec.ts tests/contract/task-planning.spec.ts tests/contract/s6-run-ownership.spec.ts tests/client/rework-panel.spec.tsx tests/client/dsh-delivery-review-card.spec.tsx tests/integration/chat-native.spec.ts
```

核心断言包括：授权缺原件被拒绝、保留/移除件不能被模型发布、未批准附件被拒绝、字节校验、数据库重开恢复、逐份验收的 CAS、完成前不释放下游、下一轮保留其他文件、精确下游版本、八份文件加正文实际发布、保留正文的新尝试证据、同名旧版过期不阻塞新版、旧稿不能借新稿的字节门槛通过，以及界面未读取不能验收。

这些是插件层回归证据，不代替真实 DSH 桌面联调、Windows 打包验证或项目的完整阶段门禁。联合补丁应用后应运行整库测试，并使用实际宿主完成一次“两个原件加一个新附件”的人工验收。
