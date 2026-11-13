// src/service/workflows.ts —— 工作流定义目录（规格 2.4 行 122、6.1 行 837-844）
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import type { Phase } from '../core/config.ts'
import { mergePassConditions, type PassCondition } from '../core/policy.ts'
import { assertDefinitionAllowed, type WorkflowDefinition } from '../core/workflow-def.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'

export type LoadWorkflowResult = {
  workflow_version: string
  nodes: { node_id: string; type: string; pass_conditions: PassCondition[] }[]
}

type WorkflowVersionRow = { version: string; content_hash: string; definition_json: string }

// 定义只许从入口加载：加载期就按阶段拒越界能力，别等到派发才发现
// 传了 db 就落 workflow_versions：跨重启同版本改内容必须被拒，在飞 run 的判定条件不跟着变（第六轮审计 P1-1）
export class WorkflowCatalog {
  private readonly defs = new Map<string, WorkflowDefinition>()
  private readonly phase: Phase
  private readonly db?: Db

  constructor(phase: Phase, db?: Db) {
    this.phase = phase
    this.db = db
  }

  // 启动时把已落库的定义装回内存；落库内容同样过阶段校验，旧库里的越界定义不能借重启复活
  hydrate(): number {
    if (!this.db) return 0
    const rows = this.db.raw.prepare('SELECT version, content_hash, definition_json FROM workflow_versions ORDER BY version ASC').all() as WorkflowVersionRow[]
    for (const row of rows) {
      const def = JSON.parse(row.definition_json) as WorkflowDefinition
      assertDefinitionAllowed(def, this.phase)
      if (definitionHashOf(def) !== row.content_hash) {
        throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '工作流定义的落库哈希对不上，库被改过', { workflow_version: row.version })
      }
      this.remember(row.version, def)
    }
    return rows.length
  }

  load(def: WorkflowDefinition): LoadWorkflowResult {
    assertDefinitionAllowed(def, this.phase)
    const key = String(def.workflow_version)
    const hash = definitionHashOf(def)
    // 同一版本号只能对应一份定义：reload 改写已建 run 的判定条件，就是绕过不可变模板（第五轮审计 P1-1）
    const persisted = this.db?.raw.prepare('SELECT version, content_hash, definition_json FROM workflow_versions WHERE version = ?').get(key) as WorkflowVersionRow | undefined
    if (persisted && persisted.content_hash !== hash) {
      throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '同一工作流版本不许改写定义，要改请升版本号', { workflow_version: key })
    }
    const existing = this.defs.get(key)
    if (existing) {
      if (definitionHashOf(existing) !== hash) {
        throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '同一工作流版本不许改写定义，要改请升版本号', { workflow_version: key })
      }
      return summarize(def)
    }
    this.remember(key, def)
    // 新定义落库：库是跨重启的事实来源，内存只是当前进程的读缓存
    if (this.db && !persisted) {
      withTx(this.db, (tx) => {
        tx.run(
          'INSERT INTO workflow_versions (version, content_hash, definition_json, created_at) VALUES (?, ?, ?, ?)',
          [key, hash, canonicalJson(def), new Date().toISOString()],
        )
      })
    }
    return summarize(def)
  }

  get(version: string | number): WorkflowDefinition {
    const def = this.defs.get(String(version))
    if (!def) throw new OrchError('NOT_FOUND', '工作流版本没加载过', { workflow_version: String(version) })
    return def
  }

  // run 绑定的定义哈希：收口时拿它和当前目录比，跨重启改内容的一律拒
  definitionHash(version: string | number): string {
    return definitionHashOf(this.get(version))
  }

  // 节点可用的只读工具：只从加载过的定义里取，请求体不能自带（第五轮审计 P1-2）
  toolPolicyFor(version: string | number, nodeId: string): { allow: string[]; deny: string[] } {
    const def = this.get(version)
    const node = def.nodes.find((n) => n.node_id === nodeId)
    if (!node) throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '节点不在这个工作流版本里', { workflow_version: String(version), nodeId })
    return { allow: [...(node.tools?.allow ?? [])], deny: [...(node.tools?.deny ?? [])] }
  }

  // 节点收口用的判定条件：模板条件为基线，节点条件按 AND 追加（规格 6.1 行 837）
  policyFor(version: string | number, nodeId: string): { passConditions: PassCondition[]; requiredHashes: string[] } {
    const def = this.get(version)
    const node = def.nodes.find((n) => n.node_id === nodeId)
    if (!node) throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '节点不在这个工作流版本里', { workflow_version: String(version), nodeId })
    // 必留哈希：模板要求与节点要求取并集，缺一个都不许收口（规格 4.7 行 380）
    const requiredHashes = Array.from(new Set([...(def.required_hashes ?? []), ...(node.required_hashes ?? [])]))
    return {
      passConditions: mergePassConditions(def.pass_conditions ?? [], node.pass_conditions ?? []),
      requiredHashes,
    }
  }

  private remember(key: string, def: WorkflowDefinition): void {
    this.defs.set(key, def)
    // 账本里 workflow_version 是整数列：'01' 这类版本号存进去会变成 1，别名兜住它
    if (/^\d+$/.test(key)) {
      const alias = String(Number(key))
      const hit = this.defs.get(alias)
      if (hit && definitionHashOf(hit) !== definitionHashOf(def)) {
        throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '版本号别名撞上了另一份定义', { workflow_version: key, alias })
      }
      this.defs.set(alias, def)
    }
  }
}

export function definitionHashOf(def: WorkflowDefinition): string {
  return sha256Hex(canonicalJson(def))
}

function summarize(def: WorkflowDefinition): LoadWorkflowResult {
  return {
    workflow_version: String(def.workflow_version),
    nodes: def.nodes.map((n) => ({
      node_id: n.node_id,
      type: n.type,
      pass_conditions: mergePassConditions(def.pass_conditions ?? [], n.pass_conditions ?? []),
    })),
  }
}
