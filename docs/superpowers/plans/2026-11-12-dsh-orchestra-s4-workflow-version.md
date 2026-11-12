# S4 流程定义与版本实施计划（门 G4）

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

## Goal

把工作流定义做成账本里的一等对象：`workflows`/`workflow_versions`/`workflow_drafts` 三张表、`workflow.create`/`workflow.open_draft`/`workflow.update`/`workflow.publish` 四条命令、同一套校验在保存层与发布层各走一遍、发布在一个事务里生成不可变版本、运行固定在具体版本上，画布与面板用同一份定义文档。本批只以门 G4 为出口。

## Architecture

落在总纲 §3 的四层里：

- 引擎层（`src/core` + `src/service`）：`src/core/workflow-def.ts` 放定义类型、两层校验与 `definition_hash` 计算，纯函数、不引 IO；`src/service/commands/workflows.ts` 放四条命令与发布事务，写路径统一走 `src/infra/sqlite/driver.ts` 的 `withTx`。
- 存储层（`src/infra`）：新增迁移 `src/infra/sqlite/migrations/NNN-workflow-tables.sql`，建三张表与版本不可变触发器（规格 §3.8 第 221–252 行）。
- 执行层（`src/executor`）：不改桥；只让运行侧按 `(workflow_id, workflow_version)` 读不可变版本，不回退到最新草稿（规格 §6.4）。
- 接入层：智能体侧给 `workflow_create`/`workflow_open_draft`/`workflow_update`/`workflow_publish`/`workflow_get`/`workflow_list` 六个工具；画布侧复用同一份定义文档与同一条保存接口。规格 §11.1 第 842 行禁止「面板接真实账本」，所以本批画布只发命令信封，不做读模型查询。

阶段闸门按规格 §2.4（第 117–122 行）：`workflow.publish` 从 S4 起才允许，S3 运行期加载到发布命令要报错；未知 phase 拒绝启动。

## Tech Stack

总纲 §4.1 的那套，不新增依赖：TypeScript 6.0.3（ESM、NodeNext，导入写 `.ts` 后缀）、Node `^22.19.0 || >=24.0.0`、pnpm 11.7.0、vitest 4.1.8、tsdown 0.22.14、zod 4.4.3、SQLite（`node:sqlite`）。脚本：`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm check`、`pnpm gate`。

## 本批能做什么

- 工作流定义文档：字段、约束、拓扑序与 `definition_hash`（规格 §3.8）。
- 两层校验：保存层拒结构性问题，发布层拒图语义问题，错误项形状固定为 `{path, code, message}`，path 是 RFC 6901 JSON Pointer，最多 100 条（规格 §6.1 与设计稿 §4.12）。
- 四条命令与发布事务（规格 §6.1–§6.3）。
- 版本固定：发布只影响之后新建的 run，在途 run 固定旧版本（规格 §6.4、§12.1 的 I5）。
- 智能体工具接口与画布同源定义、保存接口（规格 §14.4 第 1075–1076 行）。
- Q-37 到 Q-42 用例与 G-10 注入。

## 本批不能做什么

规格 §11.1 阶段能力表（第 842 行）原文：

> | S4 | 流程定义与版本 | 面板接真实账本、记忆写入 |

据此本批明确不做：

1. 不做读模型与面板六屏；面板不读真实账本（规格 §8 属 S5，门 G5）。
2. 不做记忆写入链路（memory_* 四表、写入端口与审批属 S5/S6）。
3. 不做九节点运行时的扩展（S3 已定稿，本批只改「运行按哪个版本解释」这一处）。
4. 不做 `wf_release_v1` 发布包、值班手册与升级回滚（S6，门 G6）。
5. 不做 R1/R2 受控圈。

## 门 G4 必过项

规格 §11.2 第 854 行原文：

> G4 必过：Q-37 到 Q-42、发布事务与回执同笔、并发发布只有一个版本、在途 run 固定旧版本、非法图与空名称拒、回滚发布不影响已固定 run、G-10。

逐条落到本批任务：

| 必过项 | 覆盖任务 |
| --- | --- |
| Q-37 到 Q-42 | Task 12 |
| 发布事务与回执同笔 | Task 8、Task 9 |
| 并发发布只有一个版本 | Task 8 |
| 在途 run 固定旧版本 | Task 10 |
| 非法图与空名称拒 | Task 2、Task 3 |
| 回滚发布不影响已固定 run | Task 10 |
| G-10 | Task 12 |

门记录按规格 §11.3（第 860–891 行）：G4 属无 run 门（`gate_run_id=null`、`run_terminal='not_applicable'`、`producer='human'`），正文结论后固定锚点 `artifact_hash=SHA256(canonical_json(artifact))`（总纲 §4.5）；四个哈希原像按规格 §15.2。

## 未决参数

规格没定、必须走总纲 §7 的项，本批只登记不发明：

1. 事件与证据保留期（总纲 §7 第 2 项；影响已发布版本的可见期限与「已过保留期」显示）。
2. 值班人与升级联系人（总纲 §7 第 4 项；G4 人工门的 `approver` 需要它）。
3. 写队列上限与溢出策略（第 1 项）、记忆裁判模型与提示词版本（第 3 项）、R1/R2 工作区白名单（第 5 项）、24h 浸泡采样频率与判定脚本（第 6 项）——本批不涉及，登记以示边界。

实现层未决两条：

- `OrchError` 的构造签名以 S1 落地的 `src/core/errors.ts` 为准；本计划按 `new OrchError({ code, message, retryable, details })` 书写（总纲 §4.2 的字段口径）。
- 错误码只允许规格 §17.1（第 1189–1277 行）那一套。设计稿 §4.12 给「缺入口、多入口、有环、不可达、出度纪律、branch route、节点类型未注册、config 缺失、子流程深度超限」各起了细分码；规格 v1.1 已按设计稿 §4.12 把这批码补进 §17.1（`WORKFLOW_DEFINITION_INVALID`、`WORKFLOW_NODE_ID_INVALID`、`WORKFLOW_NODE_ID_DUPLICATE`、`WORKFLOW_EDGE_ENDPOINT_MISSING`、`WORKFLOW_LAYOUT_INVALID`、`WORKFLOW_NO_TRIGGER`、`WORKFLOW_MULTIPLE_TRIGGERS`、`WORKFLOW_TRIGGER_HAS_INBOUND`、`WORKFLOW_TRIGGER_FANOUT`、`WORKFLOW_NODE_FANOUT_INVALID`、`WORKFLOW_NODE_UNREACHABLE`、`WORKFLOW_GRAPH_CYCLE`、`WORKFLOW_BRANCH_ROUTE_INVALID`、`WORKFLOW_BRANCH_PRIORITY_DUPLICATE`、`WORKFLOW_BRANCH_DEFAULT_DUPLICATE`、`NODE_NOT_SUPPORTED`、`WORKFLOW_NODE_CONFIG_INVALID`、`TOOL_NOT_ALLOWED`、`PAYLOAD_SCHEMA_INVALID`、`WORKFLOW_SUBWORKFLOW_VERSION_MISSING`、`SUBWORKFLOW_DEPTH_EXCEEDED`），本批照细分码回，不再一律降级。已收录的码照原样用：`WORKFLOW_TITLE_INVALID`、`WORKFLOW_NAME_INVALID`、`WORKFLOW_DEFINITION_TOO_LARGE`、`WORKFLOW_EDGE_SELF_LOOP`、`WORKFLOW_EDGE_DUPLICATE`、`SUBWORKFLOW_CYCLE`、`WORKFLOW_VERSION_NOT_FOUND`、`WORKFLOW_NOT_FOUND`、`WORKFLOW_REVISION_CONFLICT`、`WORKFLOW_VERSION_CONFLICT`、`WORKFLOW_DRAFT_NOT_OPEN`、`WORKFLOW_DRAFT_EXISTS`、`WORKFLOW_NOT_PUBLISHED`、`WORKFLOW_VERSION_IMMUTABLE`。
- 迁移脚本编号接续既有迁移（本批从 020 起，若实际不同则顺延），路径按总纲 §4.1.1 放 `src/infra/sqlite/migrations/NNN-name.sql`。

## 任务

### Task 1：工作流定义类型与 schema

目标：把 `WorkflowDefinition` 的形状与字段约束写成 zod schema，定义层不再靠手写解析。

**Files:**

- `src/core/workflow-def.ts` — 定义类型、节点类型枚举、zod schema（新建）
- `tests/workflow-def.spec.ts` — schema 正反用例（新建）

步骤：

1. 新建 `src/core/workflow-def.ts`，写 schema。node_id 规则、title/name 长度、position 范围、route 结构照规格 §3.8：

```ts
import { z } from 'zod';

export const NodeTypeSchema = z.enum([
  'trigger', 'agent', 'tool', 'policy', 'branch', 'approval', 'parallel', 'wait', 'subworkflow',
]);

export const NodeIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const PositionSchema = z.object({
  x: z.number().int().min(0).max(20000),
  y: z.number().int().min(0).max(20000),
});

export const RouteSchema = z.object({
  priority: z.number().int().min(0).max(999).optional(),
  default: z.boolean().optional(),
});

export const NodeSchema = z.object({
  node_id: NodeIdSchema,
  type: NodeTypeSchema,
  title: z.string().min(1).max(80),
  position: PositionSchema,
  config: z.record(z.string(), z.unknown()),
  contract: z.record(z.string(), z.unknown()),
});

export const EdgeSchema = z.object({
  from: NodeIdSchema,
  to: NodeIdSchema,
  route: RouteSchema.optional(),
});

export const WorkflowDefinitionSchema = z.object({
  schema_version: z.literal(1),
  name: z.string().min(1).max(80),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
```

2. 在同文件加 `definitionHash(definition)`：对 canonical_json 取 SHA256；布局字段也进 hash（规格 §6.4 与设计稿 §4.12 的版本真值口径），哈希工具复用 `src/core/canonical.ts`。

3. 加 `topologicalOrder(definition)`：Kahn 算法，同层按 node_id 升序，生成 node 的 seq（规格 §3.8）。

4. `tests/workflow-def.spec.ts`：断言 node_id 非法、title 超 80 字、position 超 20000 被 schema 拒；断言拓扑序在同层按 node_id 升序。

测试：

- `tests/workflow-def.spec.ts`：断言 `definition_hash` 相同输入必相同、改 position 即变；断言 seq 只由拓扑序与 node_id 决定，与坐标无关。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：typecheck 无错；vitest 全绿。

提交：`feat(core): 定义 WorkflowDefinition 结构与 schema`

### Task 2：保存层校验

目标：把「保存时就该拒」的结构性问题拦在草稿之外，其余问题只作提示。

**Files:**

- `src/core/workflow-def.ts` — 保存层校验（修改）
- `tests/workflow-save-validation.spec.ts` — 保存层用例（新建）

步骤：

1. 在 `src/core/workflow-def.ts` 加错误项类型与返回形状：path 是 RFC 6901 JSON Pointer，最多 100 条，超出在 `details.truncated=true` 与 `details.total` 报总数。

```ts
export type ValidationIssue = { path: string; code: string; message: string };

export type ValidationReport = {
  errors: ValidationIssue[];
  truncated: boolean;
  total: number;
};

export function report(issues: ValidationIssue[]): ValidationReport {
  return { errors: issues.slice(0, 100), truncated: issues.length > 100, total: issues.length };
}
```

2. 实现 `validateSaveLayer(definition, opts)`：检查顶层字段类型、node_id 格式与版本内唯一、边两端都在本版本节点里、无自环、无重复 `(from,to)`、position 是 0–20000 整数、节点 title 1–80 字、流程 name 1–80 字、`workflow.create` 的 `payload.name` 与 `definition.name` 一致、定义 JSON 不超过 1 MiB。

3. 错误码映射（规格 §17.1 v1.1）：定义不可解析写 `WORKFLOW_DEFINITION_INVALID`；node_id 格式写 `WORKFLOW_NODE_ID_INVALID`、重复写 `WORKFLOW_NODE_ID_DUPLICATE`；边端点缺失写 `WORKFLOW_EDGE_ENDPOINT_MISSING`；position 越界写 `WORKFLOW_LAYOUT_INVALID`；title 写 `WORKFLOW_TITLE_INVALID`；name 写 `WORKFLOW_NAME_INVALID`；自环写 `WORKFLOW_EDGE_SELF_LOOP`；重复边写 `WORKFLOW_EDGE_DUPLICATE`；超过 1 MiB 抛 `WORKFLOW_DEFINITION_TOO_LARGE`（HTTP 413）；其余归到 `WORKFLOW_VALIDATION_FAILED`。

4. 缺入口、多入口、有环、branch 没配路由、节点契约不合法不阻断保存，只进 `validation.errors[]`（规格 §6.1 与设计稿 §4.12 的分层口径）。

5. `tests/workflow-save-validation.spec.ts`：逐条断言上面每种拒绝码；断言缺入口/有环的图能保存并返回 errors。

测试：

- `tests/workflow-save-validation.spec.ts`：断言 title 81 字报 `WORKFLOW_TITLE_INVALID`；断言 name 81 字报 `WORKFLOW_NAME_INVALID`；断言 payload.name 与 definition.name 不一致报 `WORKFLOW_NAME_INVALID`；断言自环与重复边各自报对应码。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(core): 实现保存层结构校验`

### Task 3：发布层校验

目标：把图语义问题拦在发布前，发布层不许放过保存层已拒的图。

**Files:**

- `src/core/workflow-def.ts` — 发布层校验（修改）
- `tests/workflow-publish-validation.spec.ts` — 发布层用例（新建）

步骤：

1. 在 `src/core/workflow-def.ts` 加 `validatePublishLayer(definition, ctx)`，ctx 提供「已注册节点类型」「已发布版本查询」「工具注册表」等外部事实的只读回调：

```ts
export type PublishContext = {
  isNodeTypeRegistered: (type: string) => boolean;
  findPublishedVersion: (workflowId: string, version: number) => boolean;
  knownToolIds: ReadonlySet<string>;
};

export function validatePublishLayer(definition: WorkflowDefinition, ctx: PublishContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(definition.nodes.map((n) => [n.node_id, n]));
  const triggers = definition.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) {
    issues.push({ path: '/nodes', code: triggerCount === 0 ? 'WORKFLOW_NO_TRIGGER' : 'WORKFLOW_MULTIPLE_TRIGGERS', message: '必须恰好有一个 trigger 节点' });
  }
  for (const edge of definition.edges) {
    if (edge.from === edge.to) {
      issues.push({ path: '/edges', code: 'WORKFLOW_EDGE_SELF_LOOP', message: '边不许自环' });
    }
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      issues.push({ path: '/edges', code: 'WORKFLOW_EDGE_ENDPOINT_MISSING', message: '边端点不在本版本节点里' });
    }
  }
  for (const node of definition.nodes) {
    if (!ctx.isNodeTypeRegistered(node.type)) {
      issues.push({ path: '/nodes/' + node.node_id, code: 'NODE_NOT_SUPPORTED', message: '节点类型未注册' });
    }
  }
  return issues;
}
```

2. 补齐其余发布项：入口无入边、全图可达、无环、出度纪律（trigger 出度恰为 1，parallel/branch 至少 1，其他至多 1）、branch 出边必须带 route 且同层不重复、节点必填 config 齐全、子流程 pin 版本必须已发布、子流程无环且深度不超过 2。

3. 子流程环用 `SUBWORKFLOW_CYCLE`；pin 版本不存在或未发布用 `WORKFLOW_SUBWORKFLOW_VERSION_MISSING`；深度超限用 `SUBWORKFLOW_DEPTH_EXCEEDED` 并在 message 写明 max_depth=2。

4. 能力矩阵校验：节点声明的 `side_effect_policy` 不得比推导更宽；含 mutating 工具且声明 pure 的报 `SIDE_EFFECT_UNDECLARED`；工具不在注册表报 `TOOL_NOT_REGISTERED`；无只读证据来源报 `EVIDENCE_SOURCE_UNAVAILABLE`。

5. `tests/workflow-publish-validation.spec.ts`：断言缺 trigger、多 trigger、trigger 两条出边、普通节点两条出边、不可达节点、有环、branch 缺 route、子流程深度 3 各被拒；断言修好后发布层通过。

测试：

- `tests/workflow-publish-validation.spec.ts`：断言 issues 的 `path` 能定位到具体节点或边；断言同一份定义在保存层通过、在发布层被拒的情形被正确区分。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(core): 实现发布层图语义校验`

### Task 4：三张表与版本不可变触发器

目标：把工作流身份、版本与草稿落成三张表，版本行只插不改。

**Files:**

- `src/infra/sqlite/migrations/020-workflow-tables.sql` — 三表与触发器（新建）
- `tests/workflow-tables.spec.ts` — 表结构与触发器用例（新建）

步骤：

1. 新建迁移 `src/infra/sqlite/migrations/020-workflow-tables.sql`：

```sql
CREATE TABLE workflows (
  workflow_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  current_version INTEGER,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workflow_versions (
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  based_on_version INTEGER,
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  publish_note TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  published_by TEXT NOT NULL,
  PRIMARY KEY (workflow_id, version)
);

CREATE TRIGGER workflow_versions_immutable_update
BEFORE UPDATE ON workflow_versions
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_VERSION_IMMUTABLE');
END;

CREATE TRIGGER workflow_versions_immutable_delete
BEFORE DELETE ON workflow_versions
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_VERSION_IMMUTABLE');
END;

CREATE TABLE workflow_drafts (
  workflow_id TEXT PRIMARY KEY REFERENCES workflows(workflow_id),
  revision INTEGER NOT NULL,
  based_on_version INTEGER,
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  published_version INTEGER,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

2. `tests/workflow-tables.spec.ts`：断言对 `workflow_versions` 的 UPDATE 与 DELETE 都被触发器拒，错误信息含 `WORKFLOW_VERSION_IMMUTABLE`；断言 `workflow_drafts` 一行草稿、发布后标 `published_version` 不物理删除。

测试：

- `tests/workflow-tables.spec.ts`：断言 `current_version` 只增不减的约束由写路径保证（见 Task 8）；断言草稿 `revision` 与 `published_version` 的初始值。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(infra): 建立工作流三表与版本不可变触发器`

### Task 5：workflow.create 命令

目标：建工作流身份与第一份草稿，名称与定义同名。

**Files:**

- `src/service/commands/workflows.ts` — 四条命令入口（新建）
- `tests/workflow-create.spec.ts` — create 用例（新建）

步骤：

1. 新建 `src/service/commands/workflows.ts`，写命令信封处理骨架：`{operation_id, command, target, expected, payload, client{kind,version}}`，actor 由认证主体派生不从 payload 取（规格 §3.7）。

2. 实现 `workflow.create`：`target` 为空、`expected` 固定 `{revision: 0}`；建 `workflows` 行与 `workflow_drafts` 行（revision=1）；`payload.name` 必须与 `definition.name` 一致，否则报 `WORKFLOW_NAME_INVALID`；不自动发布。

3. `definition` 省略时按设计稿 §4.6.5 的固定空图建草稿：`{schema_version:1, name: payload.name, nodes: [], edges: []}`。

4. 在同一事务里追加 `workflow.created` 事件，带 workflow_id、revision、actor 与 surface。

5. `tests/workflow-create.spec.ts`：断言创建后 `workflow_drafts.revision=1`、`workflows.current_version` 为 NULL；断言名称不一致被拒；断言对不存在的 workflow_id 调用 update/publish 会先查 workflows 行。

测试：

- `tests/workflow-create.spec.ts`：断言 payload.name 与 definition.name 不一致报 `WORKFLOW_NAME_INVALID` 且不落草稿。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(service): 实现 workflow.create 命令`

### Task 6：workflow.open_draft 命令

目标：以当前版本为基打开草稿，已消费、未发布、已有草稿三条分流各自有明确错误码。

**Files:**

- `src/service/commands/workflows.ts` — open_draft（修改）
- `tests/workflow-open-draft.spec.ts` — 分流用例（新建）

步骤：

1. 实现 `workflow.open_draft`：`target` 为 `{workflow_id}`，`expected` 为 `{base_version: N}`。

```ts
export function openDraft(tx: Tx, args: { workflowId: string; baseVersion: number; actor: string }): { draftRevision: number; basedOnVersion: number | null } {
  const wf = tx.prepare('SELECT workflow_id, current_version FROM workflows WHERE workflow_id = ?').get(args.workflowId);
  if (!wf) {
    throw new OrchError({ code: 'WORKFLOW_NOT_FOUND', message: '工作流不存在', retryable: false, details: { workflowId: args.workflowId } });
  }
  if ((wf.current_version ?? 0) !== args.baseVersion) {
    throw new OrchError({ code: 'WORKFLOW_VERSION_CONFLICT', message: 'base_version 与当前版本不一致', retryable: false, details: { baseVersion: args.baseVersion, currentVersion: wf.current_version } });
  }
  if (wf.current_version === null) {
    throw new OrchError({ code: 'WORKFLOW_NOT_PUBLISHED', message: '从未发布过', retryable: false, details: { workflowId: args.workflowId } });
  }
  const draft = tx.prepare('SELECT revision, published_version FROM workflow_drafts WHERE workflow_id = ?').get(args.workflowId);
  if (draft && draft.published_version === null) {
    throw new OrchError({ code: 'WORKFLOW_DRAFT_EXISTS', message: '已有未消费草稿', retryable: false, details: { workflowId: args.workflowId } });
  }
  const nextRevision = draft ? draft.revision + 1 : 1;
  tx.prepare('INSERT INTO workflow_drafts (workflow_id, revision, based_on_version, definition_json, definition_hash, published_version, updated_by, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT (workflow_id) DO UPDATE SET revision = ?, based_on_version = ?, definition_json = ?, definition_hash = ?, published_version = NULL, updated_by = ?, updated_at = ?')
    .run(args.workflowId, nextRevision, wf.current_version, '{}', '', args.actor, Date.now(),
      nextRevision, wf.current_version, '{}', '', args.actor, Date.now());
  return { draftRevision: nextRevision, basedOnVersion: wf.current_version };
}
```

2. 草稿已消费时重置草稿：revision 加一、`based_on_version=current_version`；已消费草稿重复打开不新建版本。

3. 在同一事务追加 `workflow.draft_opened` 事件。

4. `tests/workflow-open-draft.spec.ts`：断言四条分流——工作流不存在（`WORKFLOW_NOT_FOUND`）、base_version 不等（`WORKFLOW_VERSION_CONFLICT`）、从未发布（`WORKFLOW_NOT_PUBLISHED`）、已有未消费草稿（`WORKFLOW_DRAFT_EXISTS`）。

测试：

- `tests/workflow-open-draft.spec.ts`：断言 open_draft 不落任何 `workflow_versions` 行。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(service): 实现 workflow.open_draft 命令`

### Task 7：workflow.update 命令

目标：整份替换草稿定义，revision 匹配才动，内容没变不递增。

**Files:**

- `src/service/commands/workflows.ts` — update（修改）
- `tests/workflow-update.spec.ts` — update 用例（新建）

步骤：

1. 实现 `workflow.update`：`target` 为 `{workflow_id}`，`expected` 为草稿 `{revision: R}`；草稿不存在报 `WORKFLOW_DRAFT_NOT_OPEN`，revision 不匹配报 `WORKFLOW_REVISION_CONFLICT` 且不覆盖。

2. 先跑保存层校验（Task 2），有结构性问题就整份拒；其余图语义问题只写进返回的 `validation.errors[]`，草稿照存。

3. 内容 hash 未变时 `changed=false`、revision 不动；变化时 revision 加一并写 `definition_json` 与 `definition_hash`。

4. 同一事务追加 `workflow.draft_saved` 事件，带 workflow_id、revision、actor 与 surface。

5. `tests/workflow-update.spec.ts`：断言两个面板同用 revision 2 改同一草稿时先到落 revision 3、后到报 `WORKFLOW_REVISION_CONFLICT` 且 details 带 current_revision；断言内容 hash 未变时 revision 不动。

测试：

- `tests/workflow-update.spec.ts`：断言 update 只校验 `definition.name`（不要求与 payload.name 一致）；断言非法图能保存并返回 errors 数组。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(service): 实现 workflow.update 命令`

### Task 8：workflow.publish 发布事务

目标：一笔事务里完成校验、插版本、抬 current_version、消费草稿、写事件与回执。

**Files:**

- `src/service/commands/workflows.ts` — publish 事务（修改）
- `tests/workflow-publish.spec.ts` — 发布事务用例（新建）

步骤：

1. 实现 `workflow.publish`：`target` 为 `{workflow_id}`，`expected` 为 `{revision: R, base_version: B}`（规格 §6.1 v1.1：base_version 是必填项，从未发布时按 0）；`payload.publish_note` 必填 1–500 字，空值报 `WORKFLOW_VALIDATION_FAILED`。

2. 发布事务严格按规格 §6.2 的顺序在 `withTx` 里执行，任何一步失败整笔回滚：

```ts
export function publishWorkflow(tx: Tx, args: {
  workflowId: string; revision: number; publishNote: string; actor: string; ctx: PublishContext;
}): { version: number; definitionHash: string } {
  const wf = tx.prepare('SELECT workflow_id, current_version FROM workflows WHERE workflow_id = ?').get(args.workflowId);
  if (!wf) {
    throw new OrchError({ code: 'WORKFLOW_NOT_FOUND', message: '工作流不存在', retryable: false, details: { workflowId: args.workflowId } });
  }
  const draft = tx.prepare('SELECT revision, based_on_version, definition_json, published_version FROM workflow_drafts WHERE workflow_id = ?').get(args.workflowId);
  if (!draft) {
    throw new OrchError({ code: 'WORKFLOW_DRAFT_NOT_OPEN', message: '没有可发布的草稿', retryable: false, details: { workflowId: args.workflowId } });
  }
  if (draft.published_version !== null) {
    throw new OrchError({ code: 'WORKFLOW_DRAFT_NOT_OPEN', message: '草稿已消费', retryable: false, details: { workflowId: args.workflowId } });
  }
  if (draft.revision !== args.revision) {
    throw new OrchError({ code: 'WORKFLOW_REVISION_CONFLICT', message: '草稿版本不匹配', retryable: false, details: { expected: args.revision, currentRevision: draft.revision } });
  }
  const base = draft.based_on_version ?? 0;
  if ((wf.current_version ?? 0) !== base) {
    throw new OrchError({ code: 'WORKFLOW_VERSION_CONFLICT', message: '当前版本与草稿基线不一致', retryable: false, details: { currentVersion: wf.current_version, basedOnVersion: base } });
  }
  const definition = JSON.parse(draft.definition_json) as WorkflowDefinition;
  const issues = validatePublishLayer(definition, args.ctx);
  if (issues.length > 0) {
    throw new OrchError({ code: 'WORKFLOW_VALIDATION_FAILED', message: '定义校验未通过', retryable: false, details: report(issues) });
  }
  const version = base + 1;
  const hash = definitionHash(definition);
  tx.prepare('INSERT INTO workflow_versions (workflow_id, version, based_on_version, definition_json, definition_hash, publish_note, published_at, published_by) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(args.workflowId, version, base === 0 ? null : base,
    draft.definition_json, hash, args.publishNote, Date.now(), args.actor);
  tx.prepare('UPDATE workflows SET current_version = ?, updated_by = ?, updated_at = ? WHERE workflow_id = ? AND (current_version IS NULL OR current_version = ?)')
    .run(version, args.actor, Date.now(), args.workflowId, base);
  tx.prepare('UPDATE workflow_drafts SET published_version = ? WHERE workflow_id = ? AND revision = ? AND published_version IS NULL')
    .run(version, args.workflowId, args.revision);
  return { version, definitionHash: hash };
}
```

3. 同一事务里追加 `workflow.published` 事件，并写命令 applied 回执（Task 9 的回执写入与这里是同一笔）。

4. 并发发布：两个 publish 同用同一个草稿 revision 时，靠「草稿 revision + published_version IS NULL」的条件命中保证只有一个赢家；败方读到 `published_version` 非空，报 `WORKFLOW_DRAFT_NOT_OPEN`，不生成重复版本。

5. `tests/workflow-publish.spec.ts`：断言首发版本 1 的 `based_on_version` 为 NULL、第二次发布版本 2 的 `based_on_version` 为 1；断言版本 1 的 `definition_json` 与 `definition_hash` 一字节未变；断言两个并发 publish 只生成一个版本。

测试：

- `tests/workflow-publish.spec.ts`：断言发布后 update 报 `WORKFLOW_DRAFT_NOT_OPEN`；断言发布失败（校验不过）时 `current_version` 不变且 `workflow_versions` 不新增行。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(service): 实现 workflow.publish 发布事务`

### Task 9：命令幂等与回执接入

目标：四条命令共用同一套幂等判定与回执窗口，重复提交不产生第二个版本。

**Files:**

- `src/service/commands/workflows.ts` — 幂等与回执（修改）
- `src/service/envelope.ts` — 信封与 request_hash（修改）
- `tests/workflow-idempotency.spec.ts` — 幂等用例（新建）

步骤：

1. 在 `src/service/envelope.ts` 实现 `request_hash`：`SHA256(JCS({command, target, expected, payload}))`，不含 `operation_id`/`confirm_challenge`/`client`（规格 §3.7）。

2. 实现幂等判定顺序：先看 `receipt_expired_at`；未过期且已终结则重放回执并置 `replayed=true`；同 id 不同 hash 报 `OPERATION_ID_CONFLICT`；非终结同 hash 报 `COMMAND_BUSY`。

3. 回执窗口 7 天从 `completed_at` 起算；in_flight 行按 `created_at` 起算 10 分钟在途超时，维护扫描每分钟 CAS 置 rejected、写 `completed_at` 与 `receipt_json=OPERATION_TIMEOUT`、追加 `command.rejected`，不改业务状态。

4. 发布回执与业务写入同事务（Task 8 的事务里追加 `command.applied` 事件并写 `receipt_json`），保证「发布事务与回执同笔」。

5. `tests/workflow-idempotency.spec.ts`：断言同 operation_id + 同 request_hash 重发返回 `replayed=true` 且不递增 revision；断言同 operation_id 不同 payload 报 `OPERATION_ID_CONFLICT`；断言回执过期后同 id 复放返回 `OPERATION_EXPIRED`。

测试：

- `tests/workflow-idempotency.spec.ts`：断言在途重复提交报 `COMMAND_BUSY`；断言超时收口只改回执行不改业务状态。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(service): 接入命令幂等与回执窗口`

### Task 10：版本固定与执行面按版本载入

目标：发布只影响之后新建的 run，在途 run 固定旧版本。

**Files:**

- `src/service/commands/workflows.ts` — 新建 run 时固定版本（修改）
- `src/executor/session.ts` — 按版本载入模板（修改）
- `tests/workflow-version-pinning.spec.ts` — 版本固定用例（新建）

步骤：

1. 新建 run 时在同一事务里读 `workflows.current_version` 并写 `runs.workflow_id` 与 `runs.workflow_version`；`current_version` 为空报 `WORKFLOW_NOT_PUBLISHED`。

2. 执行面只按 `(workflow_id, workflow_version)` 读 `workflow_versions`，读不到报 `WORKFLOW_VERSION_NOT_FOUND`，不许回退到最新版本。

3. 节点模板、`verification_policy`、`evidence_source` 一律按固定版本载入，不读最新草稿（规格 §6.4）。

4. 版本只增不减：`current_version` 不允许回退或置 NULL；最近 20 个版本可查。

5. `tests/workflow-version-pinning.spec.ts`：断言已启动的 run 仍读版本 1、新建 run 读版本 2；断言子流程 pin 指向旧版本不漂移；断言回滚发布不影响已固定 run。

测试：

- `tests/workflow-version-pinning.spec.ts`：断言 `runs.workflow_version` 写的是建 run 当时的版本；断言版本 1 的 `definition_hash` 在版本 2 发布后不变。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(service): 固定运行版本并按版本载入模板`

### Task 11：智能体工具接口与画布同源定义

目标：编排主控会话能走工具完成建改发布，画布用同一份定义文档与同一条保存接口。

**Files:**

- `src/executor/tools.ts` — 六个工作流工具（修改）
- `src/client/api/workflow-api.ts` — 命令信封构造（新建）
- `src/client/panel/canvas-definition.ts` — 画布同源定义（新建）
- `tests/workflow-tools.spec.ts` — 工具与面板同源用例（新建）

步骤：

1. 在 `src/executor/tools.ts` 加六个工具：`workflow_create`、`workflow_open_draft`、`workflow_update`、`workflow_publish`、`workflow_get`、`workflow_list`。工具只做参数形状校验、生成或复用 `operation_id`、把信封转给命令层；不直连 DB、不复制校验规则；超时必须把回传的 `operation_id` 交给调用方重试复用。

2. 工具可见性：编排主控会话有这六个工具，executor 子会话与任务会话拿不到。

3. 新建 `src/client/api/workflow-api.ts`：只负责组装写命令信封（`operation_id`、`command`、`target`、`expected`、`payload`、`client`）并发给命令层，不在客户端做校验判断。

4. 新建 `src/client/panel/canvas-definition.ts`：画布编辑的就是 `WorkflowDefinition` 本身（节点、边、布局、route），保存走 `workflow.update` 的同一封信封；已发布版本只读，拖动不生效；节点 seq 由拓扑序决定，画布按 seq 排布而不是按坐标。

5. `tests/workflow-tools.spec.ts`：断言工具与面板走同一命令层并写同一条审计事件（同一 actor 与 surface）；断言 `workflow_publish` 不带 `publish_note` 被拒；断言工具超时后复用同一 `operation_id` 重试只生成一个版本。

测试：

- `tests/workflow-tools.spec.ts`：断言 executor 子会话拿不到工作流工具；断言画布保存后的 `definition_hash` 与命令层计算一致。

验收：

```powershell
pnpm typecheck
pnpm test
```

期望：全绿。

提交：`feat(client): 接入工作流工具与画布同源定义`

### Task 12：Q-37…Q-42 用例、G-10 注入与 G4 门记录

目标：把六条用例、并发与注入跑成可复现脚本，并产出 G4 门记录与 GateArtifact。

**Files:**

- `tests/workflow-cases.spec.ts` — Q-37 到 Q-42 用例（新建）
- `scripts/fault-inject.ts` — G-10 注入（修改）
- `docs/gates/G4.md` — 门记录与 artifact_hash 锚点（新建）

步骤：

1. 新建 `tests/workflow-cases.spec.ts`，逐条实现 Q-37 到 Q-42：

- Q-37：create 建出草稿 revision 1；update 改成可发布图；publish 以 base_version=0 生成版本 1，`based_on_version IS NULL`；发布后再 update 报 `WORKFLOW_DRAFT_NOT_OPEN`；open_draft 以 base_version=1 复制草稿再发布得版本 2，`based_on_version = 1`；版本 1 的 `definition_json` 与 `definition_hash` 一字节未变；已启动的 run 仍读版本 1，新建 run 读版本 2；对不存在的 workflow_id 调 publish 返回 `WORKFLOW_NOT_FOUND`。
- Q-38：两个面板同用 revision 2 改同一草稿，先到落 revision 3、后到报 `WORKFLOW_REVISION_CONFLICT` 且 details 带 current_revision；同 operation_id 同 request_hash 重发 `replayed=true`；内容 hash 未变的 update `changed=false`；两个 publish 同用 base_version=1 时只生成版本 2，另一个报 `WORKFLOW_DRAFT_NOT_OPEN`；草稿未消费但 base_version 与 current_version 不等时报 `WORKFLOW_VERSION_CONFLICT`。
- Q-39：无 trigger、有环、branch 缺 route 的草稿可保存并返回 `validation.errors[]`；publish 返回 `WORKFLOW_VALIDATION_FAILED` 且 `current_version` 不变、`workflow_versions` 不新增行；trigger 两条出边与普通节点两条出边各被拒且 path 指向该节点；重复边与自环报 `WORKFLOW_EDGE_DUPLICATE`/`WORKFLOW_EDGE_SELF_LOOP`；title 与 name 各 81 字报对应码。
- Q-40：子流程 pin 指向不存在的版本被拒；深度 2 通过、深度 3 被拒；两个互相引用的已发布定义在加载期复核报 `SUBWORKFLOW_CYCLE`；子流程后来发布新版本，父流程已发布版本仍按 pinned version 解释。
- Q-41：只拖动节点不改边时 `definition_hash` 变化并生成新版本；节点 seq 仍按拓扑序与 node_id 排，不按坐标；已发布画布只读拖动不生效；版本 1 的 run 结果不因版本 2 布局变化而变。
- Q-42：主控会话用 `workflow_create`/`workflow_update`/`workflow_publish` 完成与面板相同的建改发布，审计事件同 actor 同 surface；executor 子会话与任务会话拿不到这些工具；`workflow_publish` 不带 publish_note 被拒；工具超时后复用 operation_id 重试只生成一个版本。

2. 在 `scripts/fault-inject.ts` 加 G-10：在途 run 时发布新版本，断言在途 run 仍按旧版本解释、新 run 用新版本；留注入参数、前后账本片段与对账查询。

3. 新建 `docs/gates/G4.md`：正文写必过项逐条证据、failed_items（空）、conclusion、approver、approved_at，结论后固定锚点 `artifact_hash=SHA256(canonical_json(artifact))`；artifact 按规格 §11.3 的固定字段集，G4 属无 run 门。

4. 跑 `pnpm gate` 校验门记录与 artifact 一致。

测试：

- `tests/workflow-cases.spec.ts`：Q-37 到 Q-42 六组用例。
- `scripts/fault-inject.ts`：G-10 一条注入。

验收：

```powershell
pnpm check
pnpm gate
```

期望：typecheck/test/build 全绿；`pnpm gate` 输出 G4 必过项全 pass、failed_items 为空，并校验 `docs/gates/G4.md` 的 `artifact_hash` 与 canonical_json(artifact) 相符。

提交：`test(gates): 补齐 Q-37 至 Q-42 用例与 G4 门记录`

## 风险与回退

- 风险：保存层与发布层的分层口径在规格 §6.1 与设计稿 §4.12 之间表述不一致（本计划按设计稿落地：结构性问题保存层拒，图语义问题发布层拒）。缓解：Task 2/Task 3 各写一组对照用例，把两层边界钉死；实施前若主人另有口径，改 Task 2/Task 3 的用例即可，不动命令层。
- 风险：图语义问题的细分码在规格 §17.1 v1.1 才补齐（`WORKFLOW_NO_TRIGGER`、`WORKFLOW_GRAPH_CYCLE`、`SUBWORKFLOW_DEPTH_EXCEEDED` 等）。缓解：本批已按细分码落；若主人审阅时改回「一律 WORKFLOW_VALIDATION_FAILED」，只需改这一处映射表，其余步骤不受影响。
- 风险：并发发布可能插出两个版本。缓解：靠「草稿 revision + published_version IS NULL」的单次 CAS 命中，败方读到已消费草稿后报 `WORKFLOW_DRAFT_NOT_OPEN`；Q-38 用例专门盯这条。
- 风险：发布事务与回执分两笔写会留下「版本已出、回执没出」的缝。缓解：回执写入与业务写入同事务（Task 8、Task 9）。
- 风险：版本固定写松会让在途 run 漂到新版本。缓解：建 run 时同事务读 `current_version` 并写 `runs.workflow_version`；执行面读不到指定版本一律报 `WORKFLOW_VERSION_NOT_FOUND`，不回退。
- 回退：S4 只新增三张表与新命令，不改 S3 的运行语义；出问题可停在 S3 阶段继续跑已发布之外的路径（规格 §11.2 第 906 行的阶段回滚口径：S4 撤问题版本、不动已固定 run）。已发布的版本行受不可变触发器保护，回退靠停用问题版本而不是改行。
- 一致性提醒（只报告不自行改）：规格 §6.1 表里 `workflow.publish` 的 `expected` 只写「草稿 revision」，设计稿 §4.6.5 写 `{revision, base_version}`；本计划以 `revision` 为必需字段，版本一致性按规格 §6.2 第 4 步用 `current_version` 与草稿 `based_on_version` 比对。

## 完成定义

- 规格 §11.1 第 842 行的 S4 能力全部落地：流程定义与版本。
- Q-37 到 Q-42 六组用例全绿；发布事务与回执同笔；并发发布只有一个版本；在途 run 固定旧版本；非法图与空名称被拒；回滚发布不影响已固定 run。
- G-10 注入跑通并留注入脚本、参数、前后账本片段与对账查询。
- `docs/gates/G4.md` 存在，含逐项证据、failed_items 为空、conclusion、approver、approved_at，结论后有 `artifact_hash=SHA256(canonical_json(artifact))` 锚点。
- `pnpm check` 与 `pnpm gate` 均通过。
- 本批没有面板读模型、没有记忆写入代码、没有发布包。
