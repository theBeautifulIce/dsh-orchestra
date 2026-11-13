# dsh-orchestra S1 账本地基 实施计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 落地可写的账本地基——单写者 SQLite 服务、迁移框架、事件哈希链、epoch 栅栏、认证与信封、备份恢复、只读查询，并交出 G1 门记录。没有这一层，后面五批的每一条不变量都没有落脚点。

**Architecture:** 引擎层 orchestra-service 是独立 Node 进程，只做确定性的记账与查询，不碰节点正文、不调模型、不调工具。存储层是单个 SQLite 库（node:sqlite 内置驱动），账本唯一写者是服务，所有写事务走 BEGIN IMMEDIATE 并在事务内校验 instance_epoch，任何其他进程只能通过服务 API 写。事件既是事实来源也是对外流：`events` 表全局单调 seq 只追加，`node_run_events` 每个 node_run 一条 HMAC 哈希链。接入层这一批只留一个只读 HTTP 端口与共享密钥，写通道留到 S2 起。

**Tech Stack:** TypeScript 6.0.3（ESM / NodeNext）· Node `^22.19.0 || >=24.0.0` · pnpm 12.3.4 · vitest 4.1.8 · zod 4.4.3 · proper-lockfile 4.1.2 · node:sqlite（内置 DatabaseSync）

---

## 0. 前置、边界与口径

前置：总纲 `docs/superpowers/plans/2026-11-12-dsh-orchestra-overview.md` 的 Task 0（仓库骨架）已完成，`pnpm install` 与 `pnpm check` 通过。本批所有路径都从总纲 §3 的目录布局派生。

**本批能做什么**：服务骨架、配置与阶段闸、认证、单写者连接、迁移框架与最小表、事件哈希链、epoch 栅栏、备份与恢复、损坏检出、只读查询、G1 用例与门记录。

**本批不能做什么**（规格 11.1 行 934 的 S1 禁止项，逐条照抄）：真实桥、并行、发布流程、面板接真实账本。因此：不建桥 RPC 客户端，不实现 parallel / subworkflow 节点，不实现 workflow.* 四个命令，不让面板读真实账本。

**对应门 G1 必过项**（规格 11.2 行 943，原文引用）：

> G1 必过：迁移空库可重复、中途杀可重入、进程杀不丢已提交事件、备份独立目录行数与哈希一致、损坏备份可检出、认证拒匿名写、阶段开关拒未知值、G-01 / G-02 / G-08 / G-09 / G-14 / G-15。

每条注入用例都要留三样东西（规格 12.3 行 1077 原文口径）：注入脚本与参数、前后账本片段、恢复后对账查询。没有对账查询的注入不算通过。

**口径说明（两处总纲内部小歧义，本批合并定案）**：

- 总纲 §3 把存储文件列在 `src/infra/db/`，§4.1.1 把驱动与迁移脚本列在 `src/infra/sqlite/`。本批合并为一套：驱动与迁移脚本放 `src/infra/sqlite/`（`driver.ts`、`migrations/NNN-name.sql`），连接、事务与迁移执行器放 `src/infra/db/`（`open.ts`、`tx.ts`、`migrate.ts`）。两套目录不并存。
- 总纲 4.1.1 写的 `execSchema(db, statements)` 少了版本号与校验和两个必需字段，本批落成 `execSchema(db, steps)`，`steps` 每项带 `version`、`name`、`checksum`、`statements`；迁移文件枚举仍由 `src/infra/db/migrate.ts` 负责。
- 规格 17.1 没有专门的「配置非法」错误码。本批配置加载失败统一用 `SCHEMA_VERSION_UNSUPPORTED`（422，规格 17.1 行 1291），并在 `details` 里带上具体字段。若 S6 复查认为需要独立错误码，先改规格 17.1 再改代码。

**S1 定值（规格未定的项在本批定值，并写进 G1 门记录，总纲 §7 口径）**：写队列上限 1000 条，超限返回 `SERVICE_UNAVAILABLE`（503）并记 warning，读路径不受影响；回执窗口 7 天、在途超时 10 分钟（取规格 17.2 的 retention 默认值）。

---

## Task 1：配置 schema 与阶段闸

**目标：** 把 `orchestra.config.json` 变成带类型、带边界、带阶段判定的唯一配置源；未知 phase、未知键、越界值一律拒绝启动，不用默认值掩盖配置错误（规格 17.2 行 1385）。

**Files:**
- Create: `src/core/config.ts` —— 配置 schema、加载、阶段闸。
- Modify: `orchestra.config.json` —— 保持规格 17.2 样例形状，phase 起点 `S1`。
- Create: `tests/config.spec.ts` —— 配置与阶段闸的用例。

**步骤：**

1. 定义阶段枚举与阶段能力表。

```ts
// src/core/config.ts
export const PHASES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const
export type Phase = (typeof PHASES)[number]

export function phaseIndex(phase: Phase): number {
  return PHASES.indexOf(phase)
}

// 规格 11.1 行 934-939 的阶段能力表；S1 只放行账本、迁移、备份、只读查询。
export const PHASE_CAPABILITIES: Record<Phase, readonly string[]> = {
  S1: ['ledger', 'migration', 'backup', 'readonly_query'],
  S2: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node'],
  S3: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node', 'all_nodes', 'decision', 'approval', 'parallel', 'wait', 'subworkflow', 'compensation'],
  S4: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node', 'all_nodes', 'decision', 'approval', 'parallel', 'wait', 'subworkflow', 'compensation', 'workflow_publish'],
  S5: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node', 'all_nodes', 'decision', 'approval', 'parallel', 'wait', 'subworkflow', 'compensation', 'workflow_publish', 'panel', 'memory'],
  S6: ['ledger', 'migration', 'backup', 'readonly_query', 'bridge', 'agent_node', 'all_nodes', 'decision', 'approval', 'parallel', 'wait', 'subworkflow', 'compensation', 'workflow_publish', 'panel', 'memory', 'release'],
}
```

2. 用 zod 定义配置 schema，全部对象 `.strict()`（未知键直接失败），数值给下界，跨字段关系单独校验。

```ts
import { z } from 'zod'

const positiveInt = (min: number) => z.number().int().min(min)

export const configSchema = z.object({
  phase: z.enum(PHASES),
  service: z.object({
    db_path: z.string().min(1),
    busy_timeout_ms: positiveInt(100),
  }).strict(),
  execution: z.object({
    concurrency: positiveInt(1),
    human_slots: positiveInt(1),
    startup_timeout_ms: positiveInt(0),
    unknown_watchdog_ms: positiveInt(0),
    verify_timeout_ms: positiveInt(0),
  }).strict(),
  bridge: z.object({
    buffer_high_water_bytes: positiveInt(1024),
    buffer_limit_bytes: positiveInt(1024),
  }).strict(),
  retention: z.object({
    receipt_days: positiveInt(1),
    in_flight_timeout_minutes: positiveInt(1),
  }).strict(),
  memory: z.object({
    bridge_id: z.string().min(1),
    eval_timeout_ms: positiveInt(0),
    judge_content_limit: positiveInt(1),
    approval_ttl_hours: positiveInt(1),
  }).strict(),
}).strict().superRefine((cfg, ctx) => {
  if (cfg.bridge.buffer_high_water_bytes >= cfg.bridge.buffer_limit_bytes) {
    ctx.addIssue({ code: 'custom', path: ['bridge', 'buffer_high_water_bytes'], message: '必须小于 buffer_limit_bytes' })
  }
})
```

3. 写加载函数：读文件 → JSON.parse → schema.parse；失败统一抛配置错误并带字段路径。同时提供阶段闸。

```ts
import { readFileSync } from 'node:fs'
import { OrchError } from './errors.ts'

export type OrchestraConfig = z.infer<typeof configSchema>

export function loadConfig(path: string): OrchestraConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '配置文件读不出来或不是合法 JSON', { path, cause: String(err) })
  }
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '配置不合法，拒绝启动', { issues: parsed.error.issues })
  }
  return parsed.data
}

// 加载期与启动期都按 min_phase 拒越阶段能力（规格 2.4 行 122）。
export function requirePhase(current: Phase, needed: Phase): void {
  if (phaseIndex(current) < phaseIndex(needed)) {
    throw new OrchError('FORBIDDEN', '当前阶段不提供这个能力', { current, needed })
  }
}

export function requireCapability(current: Phase, capability: string): void {
  if (!PHASE_CAPABILITIES[current].includes(capability)) {
    throw new OrchError('FORBIDDEN', '当前阶段不提供这个能力', { current, capability })
  }
}
```

4. 写用例：见下面「测试」。

**测试：**

- Create: `tests/config.spec.ts`
  - 规格样例配置能加载，phase 解析为 `S1`。
  - 未知 phase（如 `S7`）→ 抛 `SCHEMA_VERSION_UNSUPPORTED`。
  - 未知键（顶层或嵌套）→ 抛错且 `details.issues` 里带该键路径。
  - 越界值（`busy_timeout_ms: 0`、`busy_timeout_ms: 5000.5`）→ 抛错。
  - 跨字段（`buffer_high_water_bytes >= buffer_limit_bytes`）→ 抛错。
  - `requirePhase('S1', 'S2')` 抛 `FORBIDDEN`；`requirePhase('S2', 'S1')` 不抛。
  - `requireCapability('S1', 'workflow_publish')` 抛 `FORBIDDEN`（S1 禁止发布流程）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/config.spec.ts
```

期望：typecheck 无错误；该文件用例全绿。再手工验证一次拒绝启动：把 `orchestra.config.json` 的 phase 改成 `S9`，运行加载入口应打印配置错误并以非零码退出，随后改回 `S1`。

**提交：**

```powershell
git add src/core/config.ts orchestra.config.json tests/config.spec.ts
git commit -m "feat(core): 加配置 schema 与阶段闸"
```

---
## Task 2：错误码表与统一信封

**目标：** 把规格 17.1 的错误码表固化成代码里的唯一真源，并给出成功/失败两种统一信封（规格 8.1）。后面每一批的错误都从这里出，不新增码。

**Files:**
- Create: `src/core/errors.ts` —— 错误码表、`OrchError`、信封构造。
- Create: `tests/errors.spec.ts` —— 错误码与信封的用例。

**步骤：**

1. 抄规格 17.1 的码与 HTTP 状态映射，一字不改地落成常量表。

```ts
// src/core/errors.ts
export const ERROR_STATUS = {
  UNAUTHORIZED: 401, FORBIDDEN: 403, PROTOCOL_VERSION_MISMATCH: 409, SCHEMA_VERSION_UNSUPPORTED: 422,
  NOT_FOUND: 404, CURSOR_EXPIRED: 410, CURSOR_FILTER_MISMATCH: 409, RANGE_TOO_LARGE: 413,
  QUERY_TIMEOUT: 504, SERVICE_UNAVAILABLE: 503, OPERATION_ID_CONFLICT: 409, OPERATION_EXPIRED: 410,
  OPERATION_TIMEOUT: 504, COMMAND_BUSY: 409, CONFIRMATION_REQUIRED: 428, CONFIRMATION_MISMATCH: 409,
  CONFIRMATION_EXPIRED: 410, DECISION_REVISION_CONFLICT: 409, RESOLUTION_NOT_AVAILABLE: 422,
  VERIFICATION_TOO_WEAK: 422, VERDICT_UNSUPPORTED: 422, VERDICT_POLICY_UNMET: 422, STALE_GENERATION: 409,
  STALE_HANG: 409, BRIDGE_NOT_SUBSCRIBED: 409, TOOL_NOT_REGISTERED: 422, RUN_TOOL_NOT_READ_ONLY: 403,
  SIDE_EFFECT_UNDECLARED: 422, COMPENSATION_UNEXECUTABLE: 422, COMPENSATION_TOOL_NOT_COMPENSATING: 422,
  COMPENSATION_TOOL_IN_FORWARD_PATH: 422, EVIDENCE_SOURCE_UNAVAILABLE: 422, VERIFIER_TOOL_POLICY_MUTATING: 422,
  WORKFLOW_NOT_FOUND: 404, WORKFLOW_VERSION_NOT_FOUND: 404, WORKFLOW_REVISION_CONFLICT: 409,
  WORKFLOW_VERSION_CONFLICT: 409, WORKFLOW_VERSION_IMMUTABLE: 409, WORKFLOW_DRAFT_NOT_OPEN: 409,
  WORKFLOW_DRAFT_EXISTS: 409, WORKFLOW_NOT_PUBLISHED: 409, WORKFLOW_VALIDATION_FAILED: 422,
  WORKFLOW_TITLE_INVALID: 422, WORKFLOW_NAME_INVALID: 422, WORKFLOW_DEFINITION_TOO_LARGE: 413,
  WORKFLOW_EDGE_SELF_LOOP: 422, WORKFLOW_EDGE_DUPLICATE: 422, BRANCH_AMBIGUOUS: 422, SUBWORKFLOW_CYCLE: 422,
  MEMORY_BATCH_TOO_LARGE: 413, MEMORY_PROPOSAL_INVALID: 422, MEMORY_BATCH_CONFLICT: 409,
  MEMORY_BATCH_NOT_FOUND: 404, MEMORY_EVAL_INVALID_OUTPUT: 502, MEMORY_EVAL_TIMEOUT: 504,
  MEMORY_EVAL_UNAVAILABLE: 503, MEMORY_EVAL_DISABLED: 503, MEMORY_BATCH_NOT_APPROVED: 409,
  MEMORY_APPLY_BINDING_INVALID: 403, MEMORY_APPLY_CONFLICT: 409, MEMORY_APPLY_FAILED: 500,
  MEMORY_RUN_ACTIVE: 409, MEMORY_SOURCE_RUN_NOT_SETTLED: 409, MEMORY_WRITE_TOOL_FORBIDDEN: 422,
} as const

export type OrchErrorCode = keyof typeof ERROR_STATUS

const RETRYABLE: ReadonlySet<OrchErrorCode> = new Set([
  'QUERY_TIMEOUT', 'SERVICE_UNAVAILABLE', 'OPERATION_TIMEOUT', 'COMMAND_BUSY',
])
```

2. 写错误类与信封构造。

```ts
export class OrchError extends Error {
  readonly code: OrchErrorCode
  readonly retryable: boolean
  readonly details: Record<string, unknown>

  constructor(code: OrchErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'OrchError'
    this.code = code
    this.retryable = RETRYABLE.has(code)
    this.details = details
  }

  get httpStatus(): number {
    return ERROR_STATUS[this.code]
  }
}

export type ReadEnvelope = {
  ok: true
  schema_version: 1
  as_of_seq: number
  generated_at: string
  data: unknown
}

export type FailEnvelope = {
  ok: false
  schema_version: 1
  as_of_seq: number
  error: { code: OrchErrorCode; message: string; retryable: boolean; details: Record<string, unknown> }
}

export function okEnvelope(asOfSeq: number, data: unknown, now = new Date()): ReadEnvelope {
  return { ok: true, schema_version: 1, as_of_seq: asOfSeq, generated_at: now.toISOString(), data }
}

export function failEnvelope(asOfSeq: number, err: OrchError): FailEnvelope {
  return {
    ok: false,
    schema_version: 1,
    as_of_seq: asOfSeq,
    error: { code: err.code, message: err.message, retryable: err.retryable, details: err.details },
  }
}
```

**测试：**

- Create: `tests/errors.spec.ts`
  - 码表条目数与规格 17.1 一致（写死一个期望条数，改规格时同步改这里）。
  - 每个码的 HTTP 状态与规格 17.1 一致（抽样核对全表）。
  - `OrchError` 的 `retryable` 只对四个可重试码为 true。
  - `okEnvelope` / `failEnvelope` 字段与规格 8.1 的两个 JSON 形状逐字段相等。
  - 非 `OrchError` 的异常被包成 `SERVICE_UNAVAILABLE` 时不会泄漏堆栈给调用方（details 里只有 message）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/errors.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/core/errors.ts tests/errors.spec.ts
git commit -m "feat(core): 固化规格 17.1 错误码表与统一信封"
```

---

## Task 3：canonical JSON 与哈希

**目标：** 给哈希链、产物哈希、回执 request_hash 提供唯一的序列化口径（总纲 4.3）。

**Files:**
- Create: `src/core/canonical.ts` —— canonical_json、SHA256、HMAC。
- Create: `tests/canonical.spec.ts` —— 序列化与哈希的用例。

**步骤：**

1. 写 canonical_json：对象键按 Unicode 码点升序、无多余空白、数字用最短表示、字符串按 JSON 标准转义；集合数组的排序去重由调用方在传入前完成。

```ts
// src/core/canonical.ts
import { createHash, createHmac } from 'node:crypto'

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical_json 不接受非有限数字')
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']'
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}'
  }
  throw new TypeError('canonical_json 不接受这个类型: ' + typeof value)
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export function hmacSha256Hex(secret: string | Buffer, input: string | Buffer): string {
  return createHmac('sha256', secret).update(input).digest('hex')
}
```

2. 写用例，见下。

**测试：**

- Create: `tests/canonical.spec.ts`
  - 键顺序不同但内容相同的两个对象，canonical 结果逐字相等。
  - 键排序按码点升序（用中文键与 ASCII 键混排验证）。
  - 嵌套对象与数组里的对象同样按键排序。
  - `undefined` 字段被丢掉；`NaN` / `Infinity` 抛错。
  - `sha256Hex('abc')` 等于 `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`。
  - HMAC 用 RFC 4231 测试用例 1：key 为 20 字节 0x0b，data 为 `'Hi There'`，期望 `b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7`。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/canonical.spec.ts
```

期望：全绿。

**提交：**

```powershell
git add src/core/canonical.ts tests/canonical.spec.ts
git commit -m "feat(core): 加 canonical JSON 与哈希原语"
```

---

## Task 4：SQLite 驱动、单写者连接与 epoch 栅栏

**目标：** 打开唯一一条数据库连接，设好 PRAGMA，拿进程文件锁声明所有权，用 `service_meta.instance_epoch` 做进程内栅栏：每次启动 epoch 加一，所有写事务在 `BEGIN IMMEDIATE` 之后校验当前 epoch，旧进程复活也写不进去（规格 2.2 行 105）。

**Files:**
- Create: `src/infra/sqlite/driver.ts` —— 仓库里唯一允许 import node:sqlite 的文件。
- Create: `src/infra/db/open.ts` —— 服务连接：锁、epoch 递增、句柄。
- Create: `src/infra/db/tx.ts` —— 业务侧事务封装与 CAS 辅助。
- Create: `src/infra/lock.ts` —— proper-lockfile 进程所有权。
- Create: `tests/db-open.spec.ts` —— 连接、epoch、并发写用例。

**步骤：**

1. 写驱动。只有这个文件 import node:sqlite，对外只暴露 openDb / withTx / execSchema（总纲 4.1.1）。

```ts
// src/infra/sqlite/driver.ts —— 仓库里唯一允许 import node:sqlite 的文件
import { DatabaseSync } from 'node:sqlite'
import { OrchError } from '../../core/errors.ts'

export type Db = {
  raw: DatabaseSync
  file: string
  epoch: number
  readonly: boolean
}

export type Tx = {
  raw: DatabaseSync
  exec(sql: string): void
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number }
}

export function openDb(file: string, opts?: { readonly?: boolean }): Db {
  const raw = new DatabaseSync(file, { readOnly: opts?.readonly === true })
  raw.exec('PRAGMA journal_mode=WAL')
  raw.exec('PRAGMA foreign_keys=ON')
  raw.exec('PRAGMA busy_timeout=5000')
  raw.exec('PRAGMA synchronous=FULL')
  return { raw, file, epoch: readEpoch(raw), readonly: opts?.readonly === true }
}

function hasServiceMeta(raw: DatabaseSync): boolean {
  const hit = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'service_meta'").get()
  return hit !== undefined
}

function readEpoch(raw: DatabaseSync): number {
  if (!hasServiceMeta(raw)) return 0
  const row = raw.prepare("SELECT value FROM service_meta WHERE key = 'instance_epoch'").get() as { value?: string } | undefined
  return row?.value ? Number(row.value) : 0
}

export function withTx<T>(db: Db, fn: (tx: Tx) => T): T {
  if (db.readonly) throw new OrchError('FORBIDDEN', '只读连接不许写')
  db.raw.exec('BEGIN IMMEDIATE')
  try {
    // epoch 栅栏：连只读 INSERT 前也校验，旧进程写不进来（规格 2.2 行 105）
    const current = hasServiceMeta(db.raw)
      ? Number((db.raw.prepare("SELECT value FROM service_meta WHERE key = 'instance_epoch'").get() as { value?: string } | undefined)?.value ?? 0)
      : 0
    if (current !== db.epoch) {
      throw new OrchError('STALE_GENERATION', 'epoch 不匹配，这个进程已经不是账本写者', { expected: db.epoch, actual: current })
    }
    const result = fn(makeTx(db.raw))
    db.raw.exec('COMMIT')
    return result
  } catch (err) {
    try { db.raw.exec('ROLLBACK') } catch { /* 回滚失败时保留原异常 */ }
    throw err
  }
}

export type SchemaStep = { version: number; name: string; checksum: string; statements: string[] }

// 迁移执行器：已执行版本不重跑；内容改了必须新开编号（总纲 4.1.1）
export function execSchema(db: Db, steps: SchemaStep[]): number[] {
  const applied: number[] = []
  for (const step of steps) {
    const row = db.raw.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(step.version) as { checksum?: string } | undefined
    if (row) {
      if (row.checksum !== step.checksum) {
        throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '已执行的迁移被改了，要新开编号', { version: step.version })
      }
      continue
    }
    // 每步一个事务：中途被杀时这步整体没提交，重跑可重入（规格 12.3 G-14）
    withTx(db, (tx) => {
      for (const sql of step.statements) tx.exec(sql)
      tx.run('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        [step.version, step.name, step.checksum, new Date().toISOString()])
    })
    applied.push(step.version)
  }
  return applied
}
```

2. 写事务封装与 CAS 辅助：所有状态迁移用 `UPDATE … WHERE <条件>`，受影响行数必须恰为 1，否则抛错并回滚（总纲 4.4、规格不变量 I3）。

```ts
// src/infra/db/tx.ts
import { OrchError } from '../../core/errors.ts'
import { type Db, type Tx, withTx } from '../sqlite/driver.ts'

export function runCas(tx: Tx, sql: string, params: unknown[], expected: { rows: number; what: string }): void {
  const res = tx.run(sql, params)
  if (res.changes !== expected.rows) {
    throw new OrchError('STALE_GENERATION', 'CAS 没命中，条件不满足', { what: expected.what, changes: res.changes })
  }
}

export function inTx<T>(db: Db, fn: (tx: Tx) => T): T {
  return withTx(db, fn)
}
```

3. 写进程锁与连接装配。

```ts
// src/infra/lock.ts
import lockfile from 'proper-lockfile'

export async function acquireDbLock(dbFile: string): Promise<() => Promise<void>> {
  const release = await lockfile.lock(dbFile + '.lock', { realpath: false, stale: 10000 })
  return async () => { await release() }
}
```

```ts
// src/infra/db/open.ts
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { openDb, withTx, type Db } from '../sqlite/driver.ts'

export function bumpEpoch(file: string): number {
  const db = openDb(file)
  try {
    return withTx(db, (tx) => {
      const row = tx.get<{ value?: string }>("SELECT value FROM service_meta WHERE key = 'instance_epoch'")
      const next = Number(row?.value ?? 0) + 1
      tx.run("INSERT INTO service_meta (key, value, updated_at) VALUES ('instance_epoch', ?, ?) "
        + "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [String(next), new Date().toISOString()])
      return next
    })
  } finally {
    db.raw.close()
  }
}

export function openServiceDb(file: string, epoch: number): Db {
  mkdirSync(dirname(file), { recursive: true })
  const db = openDb(file)
  return { ...db, epoch }
}
```

4. 写用例，见下。

**测试：**

- Create: `tests/db-open.spec.ts`
  - 打开新库后 PRAGMA 取值符合预期（journal_mode=wal、foreign_keys=1、busy_timeout=5000、synchronous=2）。
  - `bumpEpoch` 两次得 1、2；`service_meta` 里存的是字符串形式的整数。
  - epoch 栅栏：连接 A 打开后被 bump 到新 epoch，A 的 `withTx` 抛 `STALE_GENERATION`；B 的写正常。
  - `withTx` 内抛错时事务回滚：写入的行数不变。
  - 并发写：两个连接同时 `BEGIN IMMEDIATE`，只有一个成功，另一个等到 busy_timeout 后失败，不产生半条记录。
  - `runCas` 行数不等于期望时抛 `STALE_GENERATION` 且事务回滚。
  - 仓库里只有 `src/infra/sqlite/driver.ts` import node:sqlite（写一条 grep 断言脚本或在测试里读源码扫一遍）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/db-open.spec.ts
pnpm check
```

期望：全绿，且 `pnpm check` 三步（typecheck + test + build）都过。

**提交：**

```powershell
git add src/infra/sqlite/driver.ts src/infra/db/open.ts src/infra/db/tx.ts src/infra/lock.ts tests/db-open.spec.ts
git commit -m "feat(service): 建立 SQLite 单写者连接与 epoch 栅栏"
```

---
## Task 5：迁移框架与最小表

**目标：** 建可重入的迁移框架，并把规格 14.1 行 1150 点名的十张最小表一次落齐（`service_meta`、`tasks`、`runs`、`node_runs`、`events`、`node_run_events`、`inbox`、`leases`、`artifacts`、`report_registry`）。

**Files:**
- Create: `src/infra/db/migrate.ts` —— 迁移执行器：枚举、校验、按序执行、记账。
- Create: `src/infra/sqlite/migrations/001_init.sql` —— 最小表与索引。
- Create: `tests/migrate.spec.ts` —— 迁移幂等与可重入的用例。

**步骤：**

1. 定迁移文件约定：放 `src/infra/sqlite/migrations/NNN-name.sql`，按编号升序执行；文件内语句以单独一行分号分隔；已执行版本不重跑，内容改了必须新开编号（总纲 4.1.1）。
2. 写迁移执行器：算文件 sha256 作为 checksum；已存在且 checksum 一致就跳过，checksum 不一致直接报错（防止改了老迁移）。

```ts
// src/infra/db/migrate.ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from '../../core/canonical.ts'
import { OrchError } from '../../core/errors.ts'
import { execSchema, type Db } from '../sqlite/driver.ts'

export type SchemaStep = { version: number; name: string; checksum: string; statements: string[] }

export function loadSteps(dir: string): SchemaStep[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  return files.map((file) => {
    const m = /^(\d{3})_(.+)\.sql$/.exec(file)
    if (!m) throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '迁移文件名不合规', { file })
    const body = readFileSync(join(dir, file), 'utf8')
    const statements = body.split(/^;\s*$/m).map((s) => s.trim()).filter(Boolean)
    return { version: Number(m[1]), name: m[2], checksum: sha256Hex(body), statements }
  })
}

export function applySteps(db: Db, steps: SchemaStep[]): number[] {
  return execSchema(db, steps)
}
```

3. 写最小表。列名全小写下划线（总纲 §3 命名约定），所有写路径都带 `revision` 以备 CAS。

```sql
-- src/infra/sqlite/migrations/001_init.sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS service_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workflow_id TEXT,
  workflow_version INTEGER,
  session_id TEXT,
  status TEXT NOT NULL,
  display_status TEXT,
  current_run_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  workflow_id TEXT,
  workflow_version INTEGER,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  last_event_seq INTEGER,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS node_runs (
  node_run_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  node_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  node_type TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  owner_epoch INTEGER,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  started_at TEXT,
  deadline_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  boot_id TEXT,
  monotonic_ns INTEGER,
  run_id TEXT,
  node_run_id TEXT,
  decision_id TEXT,
  payload_redacted TEXT,
  payload_ref TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS node_run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (node_run_id, seq)
);
;
CREATE TABLE IF NOT EXISTS inbox (
  inbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  receipt_expired_at TEXT
);
;
CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  node_run_id TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  evidence_index TEXT,
  retain_until TEXT,
  created_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS report_registry (
  report_id TEXT PRIMARY KEY,
  node_run_id TEXT,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
;
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
;
CREATE INDEX IF NOT EXISTS idx_node_runs_run ON node_runs(run_id, seq, attempt);
;
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
;
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, seq);
;
CREATE INDEX IF NOT EXISTS idx_node_run_events_chain ON node_run_events(node_run_id, seq);
```

4. 写用例，见下。

**测试：**

- Create: `tests/migrate.spec.ts`
  - 空库跑一次：十张表与 `schema_migrations` 都在，`schema_migrations` 一行（版本 1）。
  - 再跑一次：`applySteps` 返回空数组，`schema_migrations` 还是一行（空库可重复，规格 11.2 G1 第一项）。
  - 改了已执行迁移文件内容 → 抛 `SCHEMA_VERSION_UNSUPPORTED`。
  - 中途失败可重入：在 `applySteps` 抛错后重跑，已提交步骤不重复执行（`schema_migrations` 行数与各表行数都不重复增长）。
  - 迁移文件名不合规（缺编号）→ 抛错。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/migrate.spec.ts
pnpm check
```

期望：全绿。

**提交：**

```powershell
git add src/infra/db/migrate.ts src/infra/sqlite/migrations/001_init.sql tests/migrate.spec.ts
git commit -m "feat(db): 建迁移框架与十张最小表"
```

---

## Task 6：事件哈希链与账本写入口

**目标：** 让每个 node_run 拥有一条不可改写的哈希链，并给账本一个唯一写入口（规格 3.1 行 137、规格 12.1 不变量 I2）。

**Files:**
- Create: `src/core/ids.ts` —— UUIDv7 与各类 id 前缀。
- Create: `src/core/hash-chain.ts` —— 链哈希计算与校验。
- Create: `src/infra/db/ledger.ts` —— 事件追加、链追加、链读取与校验。
- Create: `tests/hash-chain.spec.ts` —— 链的追加与篡改检出用例。

**步骤：**

1. 写 id 生成：UUIDv7 用毫秒时间前缀加随机；各实体 id 带可读前缀。

```ts
// src/core/ids.ts
import { randomBytes } from 'node:crypto'

export function uuidv7(): string {
  const ms = BigInt(Date.now())
  const bytes = randomBytes(10)
  bytes[0] = Number((ms >> 40n) & 0xffn)
  bytes[1] = Number((ms >> 32n) & 0xffn)
  bytes[2] = Number((ms >> 24n) & 0xffn)
  bytes[3] = Number((ms >> 16n) & 0xffn)
  bytes[4] = Number((ms >> 8n) & 0xffn)
  bytes[5] = Number(ms & 0xffn)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
}

export const eventId = (): string => 'evt_' + uuidv7().replace(/-/g, '')
export const nodeRunId = (): string => 'nrun_' + uuidv7().replace(/-/g, '')
export const decisionId = (): string => 'dec_' + uuidv7().replace(/-/g, '')
export const runId = (): string => 'run_' + uuidv7().replace(/-/g, '')
export const taskId = (): string => 'tsk_' + uuidv7().replace(/-/g, '')
```

2. 写链哈希：`hash = HMAC-SHA256(serviceSecret, prev_hash || canonical_json(event))`，`prev_hash` 初始为 64 个 0（总纲 4.3）。

```ts
// src/core/hash-chain.ts
import { canonicalJson, hmacSha256Hex } from './canonical.ts'

export const ZERO_HASH = '0'.repeat(64)

export function chainHash(secret: string, prevHash: string, event: unknown): string {
  return hmacSha256Hex(secret, prevHash + canonicalJson(event))
}

export type ChainRow = { node_run_id: string; seq: number; type: string; prev_hash: string; hash: string; payload: string }

export type ChainBreak = { node_run_id: string; seq: number; reason: string }

export function verifyChain(secret: string, rows: ChainRow[]): ChainBreak | null {
  let prev = ZERO_HASH
  for (const row of rows) {
    if (row.prev_hash !== prev) return { node_run_id: row.node_run_id, seq: row.seq, reason: 'prev_hash 不接上一条' }
    const expect = chainHash(secret, prev, { type: row.type, payload: row.payload, seq: row.seq, node_run_id: row.node_run_id })
    if (expect !== row.hash) return { node_run_id: row.node_run_id, seq: row.seq, reason: 'hash 对不上，内容被改过' }
    prev = row.hash
  }
  return null
}
```

3. 写账本写入口（唯一写者服务内部用）。

```ts
// src/infra/db/ledger.ts
import { type Tx } from '../sqlite/driver.ts'
import { chainHash, ZERO_HASH, verifyChain, type ChainBreak, type ChainRow } from '../../core/hash-chain.ts'
import { eventId } from '../../core/ids.ts'

export type EventInput = {
  type: string
  runId?: string | null
  nodeRunId?: string | null
  decisionId?: string | null
  payload?: unknown
  idempotencyKey?: string | null
  bootId?: string | null
  monotonicNs?: number | null
}

export function appendEvent(tx: Tx, input: EventInput): { seq: number; event_id: string } {
  const now = new Date().toISOString()
  const id = eventId()
  const res = tx.run(
    'INSERT INTO events (event_id, type, occurred_at, boot_id, monotonic_ns, run_id, node_run_id, decision_id, payload_redacted, idempotency_key, created_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.type, now, input.bootId ?? null, input.monotonicNs ?? null, input.runId ?? null,
     input.nodeRunId ?? null, input.decisionId ?? null, JSON.stringify(input.payload ?? {}),
     input.idempotencyKey ?? null, now])
  return { seq: res.lastInsertRowid, event_id: id }
}
```

seq 取 `tx.run` 返回的 `lastInsertRowid`，不要用 `changes` 推算。追加 node_run 事件时同理：

```ts
export function appendNodeRunEvent(tx: Tx, secret: string, nodeRunId: string, type: string, payload: unknown): { seq: number; hash: string } {
  const last = tx.get<{ seq: number; hash: string }>(
    'SELECT seq, hash FROM node_run_events WHERE node_run_id = ? ORDER BY seq DESC LIMIT 1', [nodeRunId])
  const prev = last?.hash ?? ZERO_HASH
  const seq = (last?.seq ?? 0) + 1
  const body = { node_run_id: nodeRunId, seq, type, payload }
  const hash = chainHash(secret, prev, body)
  tx.run('INSERT INTO node_run_events (node_run_id, seq, type, prev_hash, hash, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [nodeRunId, seq, type, prev, hash, JSON.stringify(payload), new Date().toISOString()])
  return { seq, hash }
}

export function readChain(tx: Tx, nodeRunId: string): ChainRow[] {
  return tx.all<ChainRow>('SELECT node_run_id, seq, type, prev_hash, hash, payload FROM node_run_events WHERE node_run_id = ? ORDER BY seq ASC', [nodeRunId])
}

export function chainBreakOf(secret: string, rows: ChainRow[]): ChainBreak | null {
  return verifyChain(secret, rows)
}
```

4. 写用例，见下。

**测试：**

- Create: `tests/hash-chain.spec.ts`
  - 追加三条后 `readChain` 的 seq 是 1、2、3，首条 `prev_hash` 是 64 个 0。
  - `verifyChain` 对未改动的链返回 null。
  - 改掉第 2 条的 `payload` → `verifyChain` 报 `seq=2` 且理由是「hash 对不上」。
  - 删掉第 2 条 → 报 `prev_hash 不接上一条`。
  - 换一把 secret 校验 → 报 hash 对不上。
  - `canonicalJson` 的键序不影响哈希：同一事件对象键序不同、拼出的 hash 相同。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/hash-chain.spec.ts
pnpm check
```

期望：全绿。

**提交：**

```powershell
git add src/core/ids.ts src/core/hash-chain.ts src/infra/db/ledger.ts tests/hash-chain.spec.ts
git commit -m "feat(ledger): 加 node_run 事件哈希链与账本写入口"
```

---
## Task 7：服务骨架、认证与统一信封

**目标：** 把服务起起来：读配置、拿锁、抢 epoch、写 `service.state`、开一个只监听 127.0.0.1 的 HTTP 端口；所有写路径必须带认证主体，匿名写一律拒（规格 12.5 行 1091）。

**Files:**
- Create: `src/infra/logger.ts` —— 结构化日志与脱敏。
- Create: `src/infra/service-state.ts` —— `service.state` 读写（pid / endpoint / secret / epoch）。
- Create: `src/service/envelope.ts` —— 命令信封 schema 与 `request_hash`。
- Create: `src/service/server.ts` —— HTTP 入口、认证、路由。
- Create: `tests/auth.spec.ts` —— 认证与信封用例。

**步骤：**

1. 写日志：JSON 行、默认脱敏（不打印 token、密钥、完整 payload、executor 全量 transcript，规格 12.5 行 1094）。

```ts
// src/infra/logger.ts
const SECRET_KEYS = new Set(['secret', 'token', 'authorization', 'payload', 'transcript'])

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[深度截断]'
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? '[已脱敏]' : redact(v, depth + 1)
    }
    return out
  }
  return value
}

export type Logger = { info(msg: string, fields?: Record<string, unknown>): void; error(msg: string, fields?: Record<string, unknown>): void }

export function createLogger(stream: { write(line: string): void }): Logger {
  const line = (level: string, msg: string, fields?: Record<string, unknown>) => {
    stream.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(fields ? (redact(fields) as object) : {}) }) + '\n')
  }
  return { info: (m, f) => line('info', m, f), error: (m, f) => line('error', m, f) }
}
```

2. 写 `service.state` 与启动顺序（规格 2.3 行 116 原文口径：先读 pid，活着就连接，死了才接管；先拿数据库锁，再写 endpoint / secret / state）。

```ts
// src/infra/service-state.ts
import { readFileSync, writeFileSync } from 'node:fs'

export type ServiceState = { pid: number; endpoint: string; secret: string; epoch: number; started_at: string }

export function readServiceState(path: string): ServiceState | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ServiceState
  } catch {
    return null
  }
}

export function writeServiceState(path: string, state: ServiceState): void {
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8')
}
```

3. 写命令信封与 `request_hash`（规格 3.7 行 205-216）。actor 由认证主体派生，不由 payload 自报。

```ts
// src/service/envelope.ts
import { z } from 'zod'
import { canonicalJson, sha256Hex } from '../core/canonical.ts'

export const commandEnvelopeSchema = z.object({
  operation_id: z.string().uuid(),
  command: z.string().min(1),
  target: z.record(z.unknown()).default({}),
  expected: z.record(z.unknown()).default({}),
  payload: z.record(z.unknown()).default({}),
  client: z.object({ kind: z.string().min(1), version: z.string().min(1) }).strict(),
}).strict()

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>

// request_hash 不含 operation_id、confirm_challenge、client（规格 3.7 行 216）
export function requestHash(env: CommandEnvelope): string {
  return sha256Hex(canonicalJson({
    command: env.command,
    target: env.target,
    expected: env.expected,
    payload: env.payload,
  }))
}
```

4. 写 HTTP 入口：只监听 127.0.0.1；`/health` 不需要认证，其余路径都要带 `x-orchestra-secret`。

```ts
// src/service/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { OrchError, failEnvelope, okEnvelope } from '../core/errors.ts'

export type ServerDeps = {
  secret: string,
  phase: string,
  epoch: number,
  asOfSeq: () => number,
  listTasks: (limit: number) => unknown[],
  listEvents: (fromSeq: number, limit: number) => unknown[],
  appendLedgerEvent: (body: unknown, actor: string) => { seq: number; event_id: string },
}

function authenticate(req: IncomingMessage, secret: string): string {
  const got = req.headers['x-orchestra-secret']
  if (typeof got !== 'string' || got.length === 0) {
    throw new OrchError('UNAUTHORIZED', '没有认证主体', { reason: 'missing_secret' })
  }
  if (got !== secret) {
    throw new OrchError('UNAUTHORIZED', '认证主体无效', { reason: 'bad_secret' })
  }
  // actor 由认证主体派生；payload 里的 actor 字段一律忽略
  return 'service:' + sha256Hex(got).slice(0, 8)
}

export function startServer(deps: ServerDeps): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => { void handle(req, res, deps) })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        endpoint: 'http://127.0.0.1:' + port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}
```

路由与错误映射：`GET /health` 直接回 `{ok:true,phase,epoch}`；`GET /v1/tasks`、`GET /v1/events` 需要认证，缺密钥或错密钥回 401 `UNAUTHORIZED`；`POST /v1/ledger/events` 是服务内部写入口（S1 只给注入脚本与测试用），必须认证，主体从密钥派生。所有响应都套统一信封，异常统一转 `failEnvelope`。

5. 写用例，见下。

**测试：**

- Create: `tests/auth.spec.ts`
  - `/health` 无密钥 200，返回 phase 与 epoch。
  - `GET /v1/tasks` 无密钥 → 401 且错误码 `UNAUTHORIZED`。
  - 错密钥 → 401。
  - 对密钥 → 200，信封字段齐全（`ok`、`schema_version`、`as_of_seq`、`generated_at`、`data`）。
  - `POST /v1/ledger/events` 无密钥 → 401（认证拒匿名写，规格 11.2 G1 必过项）。
  - 对密钥写一条事件 → 200，body 里塞了 `actor: 'someone-else'` 也不影响派生主体：写入记录的 actor 仍是密钥派生的那个。
  - `requestHash`：`operation_id` 与 `client` 不同、其余相同 → hash 相同；`payload` 不同 → hash 不同。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/auth.spec.ts
pnpm check
```

期望：全绿。

**提交：**

```powershell
git add src/infra/logger.ts src/infra/service-state.ts src/service/envelope.ts src/service/server.ts tests/auth.spec.ts
git commit -m "feat(service): 起服务骨架并做认证与统一信封"
```

---

## Task 8：备份、恢复与损坏检出

**目标：** 账本能独立备份、能在独立目录里校验出损坏、能在恢复时不污染线上账本（规格 11.2 G1 的备份三项，规格 12.3 G-15）。

**Files:**
- Create: `src/infra/backup.ts` —— 备份、校验、恢复。
- Create: `tests/backup.spec.ts` —— 备份与损坏检出的用例。

**步骤：**

1. 备份：把库复制到独立目录，附一份 manifest 记录每张表的行数与内容哈希。

```ts
// src/infra/backup.ts
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, type Db } from '../sqlite/driver.ts'
import { OrchError } from '../core/errors.ts'

export type BackupManifest = {
  created_at: string
  db_file: string
  db_sha256: string
  tables: { name: string; rows: number; sha256: string }[]
}

const TABLES = ['service_meta', 'tasks', 'runs', 'node_runs', 'events', 'node_run_events',
  'inbox', 'leases', 'artifacts', 'report_registry']

export function backup(dbFile: string, destDir: string): BackupManifest {
  mkdirSync(destDir, { recursive: true })
  const copy = join(destDir, 'orchestra.db')
  copyFileSync(dbFile, copy)
  const db = openDb(copy, { readonly: true })
  try {
    const tables = TABLES.map((name) => {
      const rows = db.raw.prepare('SELECT * FROM ' + name).all() as unknown[]
      const hash = createHash('sha256')
      for (const row of rows) hash.update(JSON.stringify(row) + '\n')
      return { name, rows: rows.length, sha256: hash.digest('hex') }
    })
    const manifest: BackupManifest = {
      created_at: new Date().toISOString(),
      db_file: 'orchestra.db',
      db_sha256: sha256File(copy),
      tables,
    }
    writeFileSync(join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    return manifest
  } finally {
    db.raw.close()
  }
}
```

2. 校验：`verifyBackup(dir)` 逐表比对行数与哈希，并对库文件算 sha256；任何一项对不上就抛错并说明是哪一项损坏。

```ts
export function verifyBackup(dir: string): BackupManifest {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as BackupManifest
  const copy = join(dir, manifest.db_file)
  if (sha256File(copy) !== manifest.db_sha256) {
    throw new OrchError('SERVICE_UNAVAILABLE', '备份文件被改过或截断', { dir, table: '(db_file)' })
  }
  const db = openDb(copy, { readonly: true })
  try {
    for (const t of manifest.tables) {
      const rows = db.raw.prepare('SELECT * FROM ' + t.name).all() as unknown[]
      const hash = createHash('sha256')
      for (const row of rows) hash.update(JSON.stringify(row) + '\n')
      if (rows.length !== t.rows || hash.digest('hex') !== t.sha256) {
        throw new OrchError('SERVICE_UNAVAILABLE', '备份内容与清单不一致', { dir, table: t.name })
      }
    }
    return manifest
  } finally {
    db.raw.close()
  }
}
```

3. 恢复：恢复到新文件，不碰线上库；恢复后先 `verifyBackup` 再对账。

```ts
export function restore(dir: string, targetFile: string): void {
  verifyBackup(dir)
  mkdirSync(join(targetFile, '..'), { recursive: true })
  copyFileSync(join(dir, 'orchestra.db'), targetFile)
}
```

4. 写用例，见下。

**测试：**

- Create: `tests/backup.spec.ts`
  - 备份目录里有 `orchestra.db` 与 `manifest.json`；manifest 每张表行数与哈希跟线上库一致（备份独立目录行数与哈希一致，G1 必过项）。
  - `verifyBackup` 对刚做的备份返回 manifest（不抛错）。
  - 截断 `orchestra.db`（去掉一半字节）→ `verifyBackup` 抛错且 details 指出 `db_file`（损坏备份可检出）。
  - 改 `manifest.json` 里一张表的 rows → 抛错且 details 指出那一张表。
  - 恢复到一个新文件 → 新库内容与备份一致；线上库文件字节数与 sha256 在恢复前后不变（不污染线上账本，G-15）。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/backup.spec.ts
pnpm check
```

期望：全绿。

**提交：**

```powershell
git add src/infra/backup.ts tests/backup.spec.ts
git commit -m "feat(infra): 加账本备份、校验与恢复"
```

---
## Task 9：只读查询与账本校验

**目标：** 给服务一条只读面：任务、运行、节点、事件、回执的分页查询，加一个 `verify_ledger` 用来核对哈希链。S1 只实现 G1 证据需要的这一部分，其余查询在 S5 补齐。

**Files:**
- Create: `src/service/queries/cursor.ts` —— 不透明游标的编码与解码。
- Create: `src/service/queries/list_tasks.ts`、`list_events.ts`、`get_operation.ts`、`verify_ledger.ts`。
- Create: `tests/queries.spec.ts` —— 查询与游标的用例。

**步骤：**

1. 游标：字段含 v、kind、filter_hash、last_key、last_id、as_of_seq；10 分钟过期；filter 变了报 `CURSOR_FILTER_MISMATCH`（规格 8.3 行 638）。

```ts
// src/service/queries/cursor.ts
import { canonicalJson, sha256Hex } from '../../core/canonical.ts'
import { OrchError } from '../../core/errors.ts'

export type Cursor = { v: 1; kind: string; filter_hash: string; last_key: string; last_id: string; as_of_seq: number }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(canonicalJson(c), 'utf8').toString('base64url')
}

export function decodeCursor(raw: string, kind: string, filter: unknown, now = Date.now()): Cursor {
  let c: Cursor
  try {
    c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor
  } catch {
    throw new OrchError('CURSOR_EXPIRED', '游标解不开', { raw })
  }
  if (c.v !== 1) throw new OrchError('PROTOCOL_VERSION_MISMATCH', '游标版本不认识', { v: c.v })
  if (c.kind !== kind) throw new OrchError('CURSOR_FILTER_MISMATCH', '游标与当前查询不是一个种类', { kind, got: c.kind })
  if (sha256Hex(canonicalJson(filter)) !== c.filter_hash) {
    throw new OrchError('CURSOR_FILTER_MISMATCH', '过滤条件变了，游标要重来', { kind })
  }
  if (now - c.as_of_seq > 10 * 60 * 1000) {
    throw new OrchError('CURSOR_EXPIRED', '游标过期了', { kind })
  }
  return c
}
```

2. 查询实现：单页强一致，跨页不承诺同一快照；limit 上限 tasks / events 各自按规格 8.3 行 637（tasks 100、events 200），超限报 `RANGE_TOO_LARGE`。

```ts
// src/service/queries/list_events.ts
import { type Db } from '../../infra/sqlite/driver.ts'
import { OrchError } from '../../core/errors.ts'

export const EVENTS_LIMIT_MAX = 200

export function listEvents(db: Db, opts: { fromSeq?: number; limit?: number }): { rows: unknown[]; as_of_seq: number } {
  const limit = opts.limit ?? 50
  if (limit > EVENTS_LIMIT_MAX) {
    throw new OrchError('RANGE_TOO_LARGE', '一次最多要 ' + EVENTS_LIMIT_MAX + ' 条', { limit })
  }
  const from = opts.fromSeq ?? 0
  const rows = db.raw.prepare(
    'SELECT seq, event_id, type, occurred_at, boot_id, monotonic_ns, run_id, node_run_id, decision_id, payload_redacted, payload_ref '
    + 'FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(from, limit)
  const head = db.raw.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }
  return { rows, as_of_seq: head.seq }
}
```

3. `verify_ledger`：重算每个 node_run 的链，返回第一个断点；链完好时返回每条链的条目数。

```ts
// src/service/queries/verify_ledger.ts
import { type Db } from '../../infra/sqlite/driver.ts'
import { chainBreakOf } from '../../infra/db/ledger.ts'

export type LedgerVerify = { ok: boolean; chains: number; entries: number; break: { node_run_id: string; seq: number; reason: string } | null }

export function verifyLedger(db: Db, secret: string): LedgerVerify {
  const ids = db.raw.prepare('SELECT DISTINCT node_run_id FROM node_run_events').all() as { node_run_id: string }[]
  let entries = 0
  for (const { node_run_id } of ids) {
    const rows = db.raw.prepare(
      'SELECT node_run_id, seq, type, prev_hash, hash, payload FROM node_run_events WHERE node_run_id = ? ORDER BY seq ASC')
      .all(node_run_id) as any[]
    entries += rows.length
    const brk = chainBreakOf(secret, rows)
    if (brk) return { ok: false, chains: ids.length, entries, break: brk }
  }
  return { ok: true, chains: ids.length, entries, break: null }
}
```

4. 用例，见下。

**测试：**

- Create: `tests/queries.spec.ts`
  - `list_events` 按 seq 升序返回，`as_of_seq` 是当前最大 seq。
  - limit 超上限 → `RANGE_TOO_LARGE`。
  - 游标往返：`encodeCursor` 后 `decodeCursor` 拿到同值。
  - 过期游标（把 as_of_seq 改老）→ `CURSOR_EXPIRED`。
  - 过滤条件变了 → `CURSOR_FILTER_MISMATCH`。
  - 游标版本不认识 → `PROTOCOL_VERSION_MISMATCH`。
  - `verify_ledger`：链完好 `ok=true`；改一条 payload 后 `ok=false` 且 `break.seq` 指到那条。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/queries.spec.ts
pnpm check
```

期望：全绿。

**提交：**

```powershell
git add src/service/queries tests/queries.spec.ts
git commit -m "feat(query): 加只读查询、游标与账本校验"
```

---

## Task 10：故障注入脚本与 G1 用例

**目标：** 把 G1 的七条用例与六条注入（G-01 / G-02 / G-08 / G-09 / G-14 / G-15）跑成可重复的脚本，每条都留下注入参数、前后账本片段与恢复后的对账查询（规格 12.3 行 1077）。

**Files:**
- Create: `scripts/fault-inject.ts` —— 按 case 跑注入并打印账本前后片段。
- Create: `tests/integration/g1.spec.ts` —— G1 全部门必过项的用例。
- Create: `tests/fixtures/ledger.ts` —— 起临时库、跑迁移、造样本数据的辅助。

**步骤：**

1. 写测试夹具：在临时目录起一个库、跑迁移、造一条 task / run / node_run 与几条事件，供注入用例复用。

```ts
// tests/fixtures/ledger.ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, loadSteps } from '../../src/infra/db/migrate.ts'

export const TEST_SECRET = 'test-secret-for-g1'

export function freshLedger(): { dir: string; file: string; db: Db } {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-g1-'))
  const file = join(dir, 'orchestra.db')
  const db = openDb(file)
  applySteps(db, loadSteps('src/infra/sqlite/migrations'))
  return { dir, file, db }
}
```

2. 写注入脚本，按 case 分支。S1 的 outbox 就是 `events` 表本身：事件先入库、再推给订阅者；杀进程后未投递的事件仍在表里，重放按 `fromSeq` 取（与 G-09 同一条机制）。

```ts
// scripts/fault-inject.ts —— 用法：pnpm tsx scripts/fault-inject.ts --case G-01
import { appendFileSync, mkdirSync } from 'node:fs'

export type InjectionCase = 'G-01' | 'G-02' | 'G-08' | 'G-09' | 'G-14' | 'G-15'

export type InjectionResult = {
  case: InjectionCase
  params: Record<string, unknown>
  before: string
  after: string
  reconcile: string
}

export function writeEvidence(dir: string, result: InjectionResult): void {
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, result.case + '.md'),
    '# ' + result.case + '\n\n- 参数：' + JSON.stringify(result.params) + '\n'
    + '\n## 注入前账本片段\n\n```\n' + result.before + '\n```\n'
    + '\n## 恢复后账本片段\n\n```\n' + result.after + '\n```\n'
    + '\n## 对账查询\n\n```\n' + result.reconcile + '\n```\n', 'utf8')
}
```

3. 六条注入的实现口径（在 `tests/integration/g1.spec.ts` 里逐条落成用例）：

- **G-01**（事务 COMMIT 前杀进程）：开一个子进程执行写入事务，在 COMMIT 前由父进程杀掉；重启后断言该事务没提交、库里没有半条记录。
- **G-02**（COMMIT 后未投递杀）：子进程先 COMMIT 写事件、还没推给订阅者就被杀；重启后断言事件仍在 `events` 表、订阅者按 `fromSeq` 能补到。
- **G-08**（写锁长事务，队列 1000）：一个连接持有长事务，另一个连接排队 1000 次写请求；断言读路径不被拖死（读在长事务期间仍能返回），超限的写请求返回 `SERVICE_UNAVAILABLE`（S1 定值：队列上限 1000，溢出报错不阻塞）。
- **G-09**（订阅者离线十分钟重连）：订阅者记下 `fromSeq` 后断开，账本继续追加；重连时按 `fromSeq` 重放，条数与断号检查都对得上，不丢证据。
- **G-14**（迁移一半杀后重跑）：迁移执行到一半杀进程，重启后重跑迁移，已提交步骤不重复执行、表行数不重复增长。
- **G-15**（备份截断/篡改后恢复）：备份后截断或篡改备份库，`verifyBackup` 必须检出；恢复到临时库后线上账本字节不变。

4. 另外三条 G1 非注入用例：迁移空库可重复（Task 5 已覆盖，这里再从空库路径跑一遍）、进程杀不丢已提交事件（G-01 / G-02 覆盖）、阶段开关拒未知值（Task 1 覆盖，这里从服务入口再验一次启动被拒）。

**测试：**

- Create: `tests/integration/g1.spec.ts`
  - 上面六条注入逐条一个用例，用例名与注入编号一致（便于门记录逐项点名）。
  - 每条用例都跑一次对账查询，把结果写进 `docs/gates/evidence/G1` 目录。

**验收：**

```powershell
pnpm typecheck
pnpm test tests/integration/g1.spec.ts
pnpm check
pnpm tsx scripts/fault-inject.ts --case G-01
```

期望：全部通过；`docs/gates/evidence/G1/` 下出现 G-01 到 G-15 的证据文件（每个文件里有参数、前后片段、对账查询三段）。

**提交：**

```powershell
git add scripts/fault-inject.ts tests/integration/g1.spec.ts tests/fixtures/ledger.ts docs/gates/evidence/G1
git commit -m "test(gate): 补 G1 故障注入与门必过用例"
```

---

## Task 11：G1 门记录与门检查命令

**目标：** 交出 G1 的门记录与 GateArtifact，并给一把命令去校验任何一份门记录（规格 11.3）。

**Files:**
- Create: `scripts/gate-check.ts` —— 校验 GateArtifact 的字段、结论规则与哈希锚点。
- Create: `docs/gates/G1.md` —— G1 门记录正文 + GateArtifact + `artifact_hash` 锚点。

**步骤：**

1. 写门检查命令：读门记录里的 GateArtifact JSON，核对字段齐全、`must_pass_items` 全 pass、`failed_items` 为空、`conclusion=pass` 的规则成立（规格 11.3 行 982），再核对正文锚点 `artifact_hash=SHA256(canonical_json(artifact))`（规格 11.3 行 984）。G1 无 run，所以 `gate_run_id=null`、`run_terminal=not_applicable`、`producer=human`。

```ts
// scripts/gate-check.ts —— 用法：pnpm tsx scripts/gate-check.ts docs/gates/G1.md
import { readFileSync } from 'node:fs'
import { canonicalJson, sha256Hex } from '../src/core/canonical.ts'

const text = readFileSync(process.argv[2] ?? '', 'utf8')
const m = /```json\n([\s\S]*?)\n```/.exec(text)
if (!m) throw new Error('门记录里找不到 GateArtifact 的 json 块')
const artifact = JSON.parse(m[1]) as Record<string, unknown>

for (const field of ['gate', 'schema_version', 'gate_run_id', 'candidate_hash', 'change_scope_hash',
  'evidence_index_hash', 'invariants_hash', 'must_pass_items', 'failed_items', 'conclusion',
  'run_terminal', 'exceptions', 'rollback', 'approver', 'approved_at', 'producer']) {
  if (!(field in artifact)) throw new Error('GateArtifact 缺字段: ' + field)
}
const items = artifact.must_pass_items as { id: string; result: string }[]
if (items.some((i) => i.result !== 'pass')) throw new Error('must_pass_items 有没过项')
if ((artifact.failed_items as unknown[]).length !== 0) throw new Error('failed_items 不为空')
if (artifact.conclusion !== 'pass') throw new Error('conclusion 不是 pass')
if (artifact.gate_run_id !== null && artifact.run_terminal !== 'succeeded') {
  throw new Error('有 run 的门，run_terminal 必须是 succeeded')
}

const anchor = /artifact_hash=([0-9a-f]{64})/.exec(text)
if (!anchor) throw new Error('门记录里找不到 artifact_hash 锚点')
const expect = sha256Hex(canonicalJson(artifact))
if (anchor[1] !== expect) throw new Error('artifact_hash 与正文不符：' + anchor[1] + ' != ' + expect)

console.log('gate ' + artifact.gate + ' 通过')
```

2. 写门记录正文：结论段 + 逐项必过项与证据 ID + 失败项（空）+ 回滚说明 + 批准人 + GateArtifact JSON 块 + `artifact_hash` 锚点。锚点之后的补记只追加，不移动锚点、不算进哈希（规格 11.3 行 984）。
3. 跑门检查命令，确认通过。

**测试：**

- Create: `tests/gate-check.spec.ts`
  - 对 `docs/gates/G1.md` 跑一遍校验逻辑 → 通过。
  - 把 artifact 里某个 `must_pass_items.result` 改成 `fail` → 校验失败并指出是哪一项。
  - 改 `candidate_hash` 但不改正文锚点 → 校验失败并报哈希不符。
  - 缺字段 → 校验失败并点名缺哪个字段。

**验收：**

```powershell
pnpm tsx scripts/gate-check.ts docs/gates/G1.md
pnpm test tests/gate-check.spec.ts
pnpm check
```

期望：命令输出 `gate G1 通过`；测试全绿。

**提交：**

```powershell
git add scripts/gate-check.ts tests/gate-check.spec.ts docs/gates/G1.md
git commit -m "docs(gate): 交 G1 门记录与 GateArtifact"
```

---

## 风险与回退

- **迁移改动风险**：已执行的迁移文件不许改，要改就新开编号（Task 5 用例守着）。真出事了，回退方式是回到上一过门构建并用备份恢复，回滚动作写进 `docs/gates/G1.md` 的 `rollback` 段。
- **node:sqlite 版本风险**：内置模块随 Node 版本变。锁 Node 下限 `^22.19.0 || >=24.0.0`，升级 Node 前先跑 `pnpm check` 与 G1 全套用例。
- **哈希链密钥风险**：`serviceSecret` 换了，旧链就验不过。密钥写进 `service.state` 且不入日志；轮换密钥按「新建链版本」处理，不要就地换（旧链保留原密钥校验结果），这一点留到 S6 硬化定案，本批按「密钥与库同生命周期」处理。
- **写入放大风险**：`synchronous=FULL` 加 `WAL` 会拖慢写入。S1 写入量小，可接受；S6 性能批次按实测调。
- **队列上限是本批定值**：1000 条队列上限与溢出策略（溢出报 `SERVICE_UNAVAILABLE`）写在门记录里；S6 若要改，先改门记录再改代码。
- **回退目标**：上一过门构建（S1 之前没有过门构建，则回退到「不装插件」，即只停服务、保留账本文件）。

## 完成定义

本批完成时，下列每一条都为真：

1. `pnpm check` 全绿（typecheck + test + build）。
2. 十张最小表存在，迁移空库跑两次结果一致（`schema_migrations` 一行）。
3. epoch 栅栏有效：旧进程写不进去，报 `STALE_GENERATION`。
4. 哈希链可验：改一条 payload，`verify_ledger` 报断点。
5. 认证拒匿名写：无密钥的写请求 401。
6. 未知 phase 拒绝启动。
7. 备份与线上库行数哈希一致，截断与篡改都能检出，恢复不污染线上库。
8. G1 的七条用例与六条注入全过，证据文件在 `docs/gates/evidence/G1/`。
9. `docs/gates/G1.md` 写好，`pnpm tsx scripts/gate-check.ts docs/gates/G1.md` 通过。
10. 本批没有出现 S1 禁止项：没有桥、并行、流程发布、面板接真实账本。
