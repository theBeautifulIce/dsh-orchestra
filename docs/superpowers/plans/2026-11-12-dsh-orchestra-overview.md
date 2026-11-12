# dsh-orchestra 实施总纲（Overview）

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 在 `D:/aboutAI/dsh-orchestra` 落地一个可发布的 DSH 插件 `dsh-orchestra`，实现跨会话、跨插件、可恢复的工作流编排；本总纲定下工程约定与批次顺序，各批次计划在同目录分文件展开。

**Architecture:** 四层。引擎层 `orchestra-service` 是独立 Node 进程，只做确定性状态机、记账、事务、租约、扫描、事件与查询，不碰节点正文、不调模型、不调工具；存储层是 SQLite 单库，账本唯一写者是服务；执行层在 DSH 宿主内，一任务一具名会话，节点作业由 executor 子智能体执行；接入层（工具面、面板、记忆审计、外部订阅）只与服务的读模型和命令信封说话。

**Tech Stack:** TypeScript 6.0.3 (ESM, NodeNext) · Node `^22.19.0 || >=24.0.0` · pnpm 11.7.0 · vitest 4.1.8 · tsdown 0.22.14 · zod 4.4.3 · proper-lockfile 4.1.2 · @deepseek-ai/cordis 4.0.5-alpha.1 · dsh-* peer `^0.2.1-alpha.2` · SQLite（node:sqlite 内置）· DSH bundle 插件（cordis.patch.yml + client 注入）

---

## 1. 规格来源与硬约束

- 实施规格：`docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md`（1283 行 / SHA256 `73119E7FDC8DC69ED9C9C1F0A57EFF1D1F406C796E2B00EFDBC78F3E99C2F6B9`，commit `ee17d03`）。本计划所有行为契约以该规格为准，规格与本计划冲突时以规格为准并回头修计划。
- 设计稿论证与用例：`docs/orchestra-design-draft.md` v44。
- 不得写的事（规格 1.2 / 10.3）：内嵌编排脚本、与原生 workflowEngine 半兼容、让模型做最终裁决、接受口头副作用等级、节点层跨节点业务判断、自动兜底放行、v1 记忆删除与跨运行补偿、把执行器全量 transcript 给大脑。
- 账本只追加；已提交事件不改写；事件序号单调（不变量 I2）。
- 所有迁移带 CAS；CAS 失败不产生副作用（不变量 I3）。
- 一个 node_run 与一个 run 最多一个终态（不变量 I1）。
- 每道门都要有 GateArtifact；没有门记录与批准人不得进下一阶段（不变量 I10）。

## 2. 六批计划与依赖

| 批次 | 计划文件 | 覆盖 | 门 | 依赖 |
| --- | --- | --- | --- | --- |
| S1 账本地基 | `2026-11-12-dsh-orchestra-s1-ledger.md` | 服务骨架、配置、认证、单写者、迁移、哈希链、epoch 栅栏、备份恢复 | G1 | 无 |
| S2 单节点闭环 | `2026-11-12-dsh-orchestra-s2-agent-loop.md` | 桥 RPC 最小集、agent 节点、租约、applyReport、终态、取消、超时、证据 | G2 | S1 |
| S3 九节点与状态机 | `2026-11-12-dsh-orchestra-s3-nodes-state.md` | 九节点全量迁移、八种 decision、审批、并行、等待、子流程、补偿、恢复扫描 | G3 | S1、S2 |
| S4 流程定义与版本 | `2026-11-12-dsh-orchestra-s4-workflow-version.md` | 三表四命令、校验、发布事务、版本固定、画布同源定义 | G4 | S1、S3 |
| S5 面板与记忆 | `2026-11-12-dsh-orchestra-s5-panel-memory.md` | 读模型、查询、SSE、六屏、记忆全链路、视觉门槛 | G5 | S1–S4 |
| S6 硬化与发布 | `2026-11-12-dsh-orchestra-s6-hardening-release.md` | G-01–G-16 注入、性能、浸泡、wf_release_v1、手册、升级回滚、R0/G6/R1/R2 | G6 | S1–S5 |

每批计划开头都写明：本批能做什么、不能做什么、对应门（G1–G6）的必过项来自规格 11.2。

## 3. 目录与文件布局（全部批次共用）

```
dsh-orchestra/
├─ package.json                # type=module，main=lib/index.js，exports 含 ./client
├─ tsconfig.json               # NodeNext / strict / noUncheckedIndexedAccess
├─ vitest.config.ts            # tests/**/*.spec.{ts,tsx}
├─ tsdown.config.ts            # node 端 esm + client 端 cjs
├─ cordis.patch.yml
├─ orchestra.config.json       # 阶段与运行参数（唯一配置源）
├─ src/
│  ├─ index.ts                 # cordis 插件入口（组合根）
│  ├─ client/
│  │  ├─ index.tsx             # 面板入口
│  │  ├─ panel/                # 六屏组件
│  │  └─ api/                  # 读模型客户端 + SSE
│  ├─ core/                    # 纯领域逻辑，无 IO，可单测
│  │  ├─ config.ts             # 配置 schema + 阶段判定
│  │  ├─ errors.ts             # 错误码表与 OrchError
│  │  ├─ canonical.ts          # canonical_json（JCS）+ sha256/hmac
│  │  ├─ ids.ts                # UUIDv7、node_run_id、decision_id
│  │  ├─ hash-chain.ts         # node_run_events 哈希链
│  │  ├─ state-machine.ts      # node_run 状态集合与合法迁移表
│  │  ├─ workflow-def.ts       # WorkflowDefinition schema 与校验
│  │  ├─ report.ts             # applyReport 六步骨架
│  │  └─ policy.ts             # policy 节点的白名单算子求值
│  ├─ infra/
│  │  ├─ sqlite/             # 唯一允许 import node:sqlite 的目录
│  │  │  ├─ driver.ts          # 单写者连接 + BEGIN IMMEDIATE 事务 + 迁移执行器（busy_timeout 5000、epoch 校验）
│  │  │  └─ migrations/        # 001_init.sql、002_*.sql …（SQL 脚本，按版本号递增）
│  │  ├─ db/                  # 服务侧封装，不直接碰 node:sqlite
│  │  │  ├─ open.ts            # 单写者连接与 epoch 自增
│  │  │  ├─ tx.ts              # CAS 辅助与 runCas
│  │  │  └─ migrate.ts         # 迁移步骤枚举与 applySteps
│  │  ├─ lock.ts               # proper-lockfile 进程所有权
│  │  ├─ backup.ts             # 备份、独立目录校验、损坏检出
│  │  ├─ logger.ts
│  │  └─ service-state.ts      # service.state（pid/endpoint/secret）
│  ├─ service/                 # 编排服务
│  │  ├─ server.ts             # HTTP 入口（127.0.0.1 + 共享密钥）
│  │  ├─ envelope.ts           # 命令信封与回执
│  │  ├─ commands/             # 每个命令一个文件
│  │  ├─ queries/              # 每个查询一个文件
│  │  └─ sweep.ts              # 维护扫描（每分钟）
│  ├─ executor/                # 宿主侧执行器
│  │  ├─ bridge.ts             # 桥 RPC 客户端
│  │  ├─ session.ts            # 子智能体创建与会话绑定
│  │  └─ tools.ts              # 工具注册表与 capability 推导
│  └─ app/
│     ├─ plugin.ts             # cordis 插件装配
│     └─ capabilities.ts       # 能力位与阶段门
├─ tests/
│  ├─ *.spec.ts                # 平铺，命名 <module>.spec.ts
│  ├─ fixtures/
│  └─ integration/
├─ scripts/
│  ├─ gate-check.ts            # 门检查命令
│  └─ fault-inject.ts          # 故障注入脚本
└─ docs/
   ├─ gates/                   # G1–G6 的门记录与 GateArtifact
   └─ superpowers/plans/       # 本计划目录
```

约定：

- 领域逻辑放 `src/core`，不引 IO（不 import node:fs / node:sqlite），单测直接跑。
- 所有对账本与外部系统的访问走 `src/infra`；服务内部业务逻辑放 `src/service`。
- 测试平铺在 `tests/`，命名 `<module>.spec.ts`；跨模块集成放 `tests/integration/`。
- 命名：表与列全小写下划线；导出函数 camelCase；类型 PascalCase；错误码全大写下划线（规格 17.1）。

## 4. 工程约定

### 4.1 包与构建

- `package.json`：`type=module`、`main: lib/index.js`、`types: lib/index.d.ts`、`exports` 含 `.` 与 `./client`、`files: [lib, cordis.patch.yml, README.md]`、`dsh.bundle.patch=./cordis.patch.yml`、`dsh.client.platform=web`、`dsh.client.inject` 六个 dsh-client-ui-* 包、`dsh.manifestVersion=1`。
- scripts：`build=tsdown`、`typecheck=tsc --noEmit`、`test=vitest run`、`check=pnpm typecheck && pnpm test && pnpm build`、`gate=tsx scripts/gate-check.ts`。
- engines：`node: ^22.19.0 || >=24.0.0`、`dsh: ^0.2.1-alpha.2`；packageManager `pnpm@11.7.0`。
- 依赖：`proper-lockfile@4.1.2`、`zod@4.4.3`；peerDeps 为 cordis 与 dsh-* 系列 `^0.2.1-alpha.2`、`@deepseek-ai/schemastery@3.18.5-alpha.1`。
- devDeps：同版本 peer + `typescript@6.0.3`、`vitest@4.1.8`、`tsdown@0.22.14`、`@types/node@22.20.0`、`react@18.3.28`、`react-dom@18.3.28`、`jsdom@29.1.1`。
- tsconfig：`target ES2024`、`module NodeNext`、`moduleResolution NodeNext`、`strict`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`、`rewriteRelativeImportExtensions`、`jsx react-jsx`、include `src/**/*.ts(x)` 与 `tests/**/*.ts(x)`。
- vitest.config.ts：`resolve.dedupe=['react','react-dom']`、`test.include=['tests/**/*.spec.{ts,tsx}']`。
- tsdown.config.ts：照抄参考项目 `references/dsh-superagent-prototype/tsdown.config.ts` 的形状——两段配置（node 端 + client 端），外加一个 `raw` 插件负责 `?raw` 引入 css；client 端用 `outputOptions.banner` 把 `module.exports` 包进 `window.__ModuleLoader__.load(...)`。

```ts
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
// `?raw` imports a file as its text, as Vite and vitest do; tsdown refuses `.css` ids without @tsdown/css, so this loads them.
const raw = { name: 'raw',
  resolveId: (source: string, importer?: string) => source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined,
  load: (id: string) => id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined }
export default defineConfig([
  { entry: { index: 'src/index.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: true, clean: true, deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'proper-lockfile'] } },
  { entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false, plugins: [raw],
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "dsh-orchestra", factory: (require) => {', footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
])
```

package.json 侧对应：`main: lib/index.js`、`types: lib/index.d.ts`、`exports['./client']: './lib/client.js'`、`files: [lib, cordis.patch.yml, README.md]`。

### 4.1.1 存储驱动

- 选型：用 Node 内置 `node:sqlite` 的 `DatabaseSync`，不引第三方 SQLite 包。理由：engines 已把 Node 下限抬到 `^22.19.0 || >=24.0.0`，该版本起 `node:sqlite` 不再需要 `--experimental-sqlite` 旗标；插件跑在 DSH 的 Node 侧，内置模块免编译、免安装、免版本漂移。
- 边界：`src/infra/sqlite/driver.ts` 是仓库里唯一允许 `import { DatabaseSync } from 'node:sqlite'` 的文件，对外只暴露三个函数：
  - `openDb(file: string, opts?: { readonly?: boolean }): Db` —— 开连接并设 `PRAGMA journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`、`synchronous=FULL`；
  - `withTx<T>(db: Db, fn: (tx: Tx) => T): T` —— `BEGIN IMMEDIATE` → 校验 `service_meta.instance_epoch` 等于当前 epoch（连只读 INSERT 前也校验）→ 执行 → `COMMIT`；抛错则 `ROLLBACK` 并原样上抛；
  - `execSchema(db: Db, statements: string[]): void` —— 按顺序跑迁移语句，逐条写 `schema_migrations(version, checksum, applied_at)`。
- 其余模块一律不许直接 import `node:sqlite`，也不许另开第二条连接；跨模块访问只经 `src/infra` 的仓储函数。
- 迁移脚本放 `src/infra/sqlite/migrations/NNN-name.sql`，按编号顺序执行；已执行版本不重跑，内容改动一律新开编号，不改老文件。
### 4.2 错误与信封

- 错误码表以规格 17.1 为准，不新增码；`src/core/errors.ts` 用 zod 枚举固定 code 与 HTTP 状态映射，抛 `OrchError{code,message,retryable,details}`。
- 读接口统一信封：成功 `{ok:true,schema_version:1,as_of_seq,generated_at,data}`，失败 `{ok:false,schema_version:1,as_of_seq,error:{code,message,retryable,details}}`。
- 写接口统一命令信封：`{operation_id,command,target,expected,payload,client{kind,version}}`；actor 由认证主体派生，不从 payload 取。

### 4.3 哈希与 canonical

- `canonical_json`：UTF-8、对象键按 Unicode 码点升序、无多余空白、集合数组先升序去重；再取 SHA256。
- `node_run_events` 链：`hash = HMAC-SHA256(serviceSecret, prev_hash || canonical_json(event))`，`prev_hash` 初始为 64 个 0。
- 产物哈希、证据哈希一律叫 `sha256`；只有 GateArtifact 的锚点哈希叫 `artifact_hash`（规格 15.7）。

### 4.4 CAS 风格

- 所有状态迁移写成 `UPDATE … SET … WHERE <id> AND <expected 条件>`，条件含 `revision` / `attempt` / `generation` / `owner_epoch` 之一以上；受影响行数必须恰为 1，否则抛 `OrchError` 且事务回滚。
- 写事务统一 `withTx(db, fn)`：`BEGIN IMMEDIATE` → 校验 `service_meta.instance_epoch` 等于当前 epoch（连 INSERT 也校验）→ 执行 → `COMMIT`。

### 4.5 提交与验证

- 每个任务一次提交，消息用 `type: description`，例如 `feat(service): 建立 SQLite 单写者连接与 epoch 栅栏`。
- 提交前必须 `pnpm check` 通过（typecheck + test + build）。
- 门记录写 `docs/gates/G<n>.md`，正文结论后固定锚点 `artifact_hash=SHA256(canonical_json(artifact))`，补记只追加在锚点后。

## 5. Task 0：仓库骨架与环境

**Objective:** 建立可运行可测试的插件仓库骨架，锁定工具链版本，确认 Node 版本满足 DSH 要求。

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tsdown.config.ts`
- Create: `cordis.patch.yml`
- Create: `orchestra.config.json`
- Create: `src/index.ts`
- Create: `src/client/index.tsx`
- Create: `tests/smoke.spec.ts`
- Modify: `.gitignore`（追加 `node_modules/`、`lib/`、`storages/`）

骨架任务没有可写的业务单测，验证用类型检查与构建冒烟；这是 writing-plans 格式的唯一例外，已在计划里写明。

- Step 1：确认环境不满足则先装 Node。

```powershell
node -v    # 期望 v22.19.0+ 或 v24.x；本机当前 v22.14.0 不满足 engines
winget install OpenJS.NodeJS.LTS   # 装 24 LTS
node -v    # 期望 v24.x
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm -v    # 期望 11.7.0
```

- Step 2：写骨架文件。

`package.json`（完整内容）：

```json
{
  "name": "dsh-orchestra",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "description": "DSH bundle plugin: cross-session, recoverable workflow orchestration with a deterministic ledger.",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "orchestra.config.json", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-workspace"
      ]
    },
    "manifestVersion": 1
  },
  "scripts": {
    "build": "tsdown",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "check": "pnpm typecheck && pnpm test && pnpm build",
    "gate": "tsx scripts/gate-check.ts"
  },
  "engines": { "node": "^22.19.0 || >=24.0.0", "dsh": "^0.2.1-alpha.2" },
  "packageManager": "pnpm@11.7.0",
  "dependencies": { "proper-lockfile": "4.1.2", "zod": "4.4.3" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "4.0.5-alpha.1",
    "@deepseek-ai/schemastery": "3.18.5-alpha.1",
    "dsh-agent": "^0.2.1-alpha.2",
    "dsh-api-session-controller": "^0.2.1-alpha.2",
    "dsh-client-ui-layout": "^0.2.1-alpha.2",
    "dsh-client-ui-locale": "^0.2.1-alpha.2",
    "dsh-client-ui-renderer": "^0.2.1-alpha.2",
    "dsh-client-ui-settings": "^0.2.1-alpha.2",
    "dsh-client-ui-sidebar": "^0.2.1-alpha.2",
    "dsh-client-ui-workspace": "^0.2.1-alpha.2",
    "dsh-host-webserver": "^0.2.1-alpha.2",
    "dsh-permission-presets": "^0.2.1-alpha.2",
    "dsh-persistence": "^0.2.1-alpha.2",
    "dsh-scope": "^0.2.1-alpha.2",
    "dsh-session": "^0.2.1-alpha.2",
    "dsh-skill": "^0.2.1-alpha.2",
    "dsh-subprocess": "^0.2.1-alpha.2",
    "dsh-tools": "^0.2.1-alpha.2"
  },
  "devDependencies": {
    "@types/node": "22.20.0",
    "jsdom": "29.1.1",
    "react": "18.3.28",
    "react-dom": "18.3.28",
    "tsdown": "0.22.14",
    "typescript": "6.0.3",
    "vitest": "4.1.8"
  }
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "rewriteRelativeImportExtensions": true,
    "jsx": "react-jsx",
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "lib",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx"]
}
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: { include: ['tests/**/*.spec.{ts,tsx}'], environment: 'node' },
})
```

`tsdown.config.ts`：

```ts
import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    dts: true,
    deps: { neverBundle: [/^@deepseek-ai//, 'zod', 'proper-lockfile'] },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    banner: {
      js: 'window.__ModuleLoader__.load({id:"dsh-orchestra",factory:(require)=>{',
    },
    intro: 'return module.exports;}});',
    deps: { neverBundle: ['react', 'react-dom'] },
  },
])
```

`cordis.patch.yml`：

```yaml
# dsh-orchestra bundle patch
```

`orchestra.config.json`（照规格 17.2 的样例，phase 起点 S1）：

```json
{
  "phase": "S1",
  "service": { "db_path": "storages/dsh-orchestra/orchestra.db", "busy_timeout_ms": 5000 },
  "execution": { "concurrency": 3, "human_slots": 1, "startup_timeout_ms": 60000, "unknown_watchdog_ms": 120000, "verify_timeout_ms": 120000 },
  "bridge": { "buffer_high_water_bytes": 4194304, "buffer_limit_bytes": 8388608 },
  "retention": { "receipt_days": 7, "in_flight_timeout_minutes": 10 },
  "memory": { "bridge_id": "memory-audit-v1", "eval_timeout_ms": 120000, "judge_content_limit": 4000, "approval_ttl_hours": 24 }
}
```

`src/index.ts`：

```ts
export const name = 'dsh-orchestra'
export const version = '0.1.0'
```

`src/client/index.tsx`：

```tsx
export const clientId = 'dsh-orchestra'
```

`tests/smoke.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { name, version } from '../src/index.ts'

describe('smoke', () => {
  it('exposes plugin identity', () => {
    expect(name).toBe('dsh-orchestra')
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
```

- Step 3：安装依赖并跑验证。

```powershell
pnpm install
pnpm check
```

期望输出：typecheck 无错误；vitest 报 `1 passed`；tsdown 产出 `lib/index.js`、`lib/index.d.ts`、`lib/client.js`。

- Step 4：提交。

```powershell
git add package.json tsconfig.json vitest.config.ts tsdown.config.ts cordis.patch.yml orchestra.config.json src/index.ts src/client/index.tsx tests/smoke.spec.ts .gitignore
git commit -m "chore(repo): 建立 dsh-orchestra 插件仓库骨架与工具链"
```

## 6. 批次门与验收口径

| 门 | 必过项来源 | 产出 |
| --- | --- | --- |
| G1 | 规格 11.2 G1：迁移空库可重复、中途杀可重入、进程杀不丢已提交事件、备份独立目录行数与哈希一致、损坏备份可检出、认证拒匿名写、阶段开关拒未知值、G-01/G-02/G-08/G-09/G-14/G-15 | `docs/gates/G1.md` + GateArtifact |
| G2 | 规格 11.2 G2：单节点 queued 到终态一条路径、重复上报只落一次、租约过期迟到上报被拒、取消后不产生新 attempt、终态必带证据、无裸 blocked、S2 加载 parallel 被拒、G-03/G-04/G-05/G-07 | `docs/gates/G2.md` |
| G3 | 规格 11.2 G3：M-01–M-61、非法迁移全拒、并发只有一个赢家、并行扇出与汇聚一致、子流程环与深度拒、补偿不重复、取消向子 run 传播、G-01/G-02/G-04/G-06/G-12/G-16 | `docs/gates/G3.md` |
| G4 | 规格 11.2 G4：Q-37–Q-42、发布事务与回执同笔、并发发布只有一个版本、在途 run 固定旧版本、非法图与空名称拒、回滚发布不影响已固定 run、G-10 | `docs/gates/G4.md` |
| G5 | 规格 11.2 G5：Q-01–Q-36、Q-43–Q-63（含 43b/43c/44b/44c/47b/52b）、两视口无横向溢出、正文≥13px、辅助≥12px、菜单与顶导≥12.5px、对比度正文 4.5:1 / 大字与 UI 3:1、记忆部分写入可对账、S5 启动 wf_release_v1 被拒、G-06/G-11/G-12 | `docs/gates/G5.md` |
| G6 | 规格 11.2 G6：G-01–G-16 全过、控制面 p95 达 8.3、事件滞后 p95≤2s 且最大≤10s、24h 浸泡无泄漏无孤儿、升级成功、双向兼容窗口内回滚成功、值班手册演练通过、两份 artifact 的 candidate_hash/evidence_index_hash/conclusion 一致 | `docs/gates/G6.md` |

## 7. 未决参数（规格 16.3 的六个开放项）

写队列上限与溢出策略、事件与证据保留期、记忆裁判模型与提示词版本、值班人与升级联系人、R1/R2 工作区白名单、24h 浸泡采样频率与判定脚本——每一项在对应批次定值并写进门记录；定值前按规格默认值与安全侧行为运行，不许用「还没定」当放行理由。

本轮计划阶段的补充开放项：

- report_registry 语义缺口：规格 §4.2 只许 rejected / replayed / applied / stale 四态，§4.5 要求围栏已立时收到的报告「进 registry(rejected) 排队」，但没有字段区分「排队待重放」与「已拒绝不再重放」。S3 按状态值原样落库、重放规则写进步骤，等主人定是否加字段（如 `queued_for_replay`）。
- 迁移脚本编号序列：总纲未定编号规则，S3/S4 里的 020_、030_ 等是按惯例占位，实际接续既有迁移号，不同则顺延。
- 桥 RPC 与宿主插件 API 的对应名：S2 写的是规格 §7.2 的七个方法名（spawn / subscribe / send / cancel / dispose / state / whenIdle），落到 DSH 插件侧的确切绑定名待宿主侧对齐。
