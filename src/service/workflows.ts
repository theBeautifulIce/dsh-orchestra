// src/service/workflows.ts —— 工作流定义目录（规格 2.4 行 122、6.1 行 837-844）
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import type { Phase } from '../core/config.ts'
import { deepFreeze } from '../core/freeze.ts'
import { mergePassConditions, type PassCondition } from '../core/policy.ts'
import { assertDefinitionAllowed, type WorkflowDefinition, type WorkflowNodeDef } from '../core/workflow-def.ts'
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
      // 快照化：落库文本先还原成独立对象，校验、哈希、进目录都只认这份快照
      const snapshot = snapshotOf(JSON.parse(row.definition_json) as WorkflowDefinition)
      assertDefinitionAllowed(snapshot, this.phase)
      if (definitionHashOf(snapshot) !== row.content_hash) {
        throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '工作流定义的落库哈希对不上，库被改过', { workflow_version: row.version })
      }
      this.remember(row.version, snapshot)
    }
    return rows.length
  }

  load(def: WorkflowDefinition): LoadWorkflowResult {
    // 快照化：canonical_json 走一遍再解析，拿到的是与调用方彻底断开的独立副本；
    // 调用方之后再改原对象（哪怕改嵌套的 tools.allow）也影响不到目录里的定义（第二次意见 P1 问题 A）
    const snapshot = snapshotOf(def)
    assertDefinitionAllowed(snapshot, this.phase)
    const key = String(snapshot.workflow_version)
    const hash = definitionHashOf(snapshot)
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
      return summarize(snapshot)
    }
    // 版本号别名撞车要在落库之前判：先写库再报错，库里会多出一行没通过检查的定义
    this.assertAliasFree(key, snapshot)
    // 先落库再进内存：事务失败就整份定义没进目录，内存不留未经持久化的残影（第二次意见 P1 问题 B）
    if (this.db && !persisted) {
      try {
        withTx(this.db, (tx) => {
          tx.run(
            'INSERT INTO workflow_versions (version, content_hash, definition_json, created_at) VALUES (?, ?, ?, ?)',
            [key, hash, canonicalJson(snapshot), new Date().toISOString()],
          )
        })
      } catch (err) {
        throw new OrchError('SERVICE_UNAVAILABLE', '工作流定义落库失败，这份定义没有进目录', {
          workflow_version: key,
          cause: err instanceof Error ? err.message : String(err),
        })
      }
    }
    this.remember(key, snapshot)
    return summarize(snapshot)
  }

  get(version: string | number): WorkflowDefinition {
    // 交出去的是深拷贝：调用方拿到的是能随便改的独立副本，目录里的本体不受影响（第二次意见 P1 问题 A）
    return snapshotOf(this.internal(version))
  }

  // run 绑定的定义哈希：收口时拿它和当前目录比，跨重启改内容的一律拒
  definitionHash(version: string | number): string {
    return definitionHashOf(this.internal(version))
  }

  // 节点可用的只读工具：只从加载过的定义里取，请求体不能自带（第五轮审计 P1-2）
  toolPolicyFor(version: string | number, nodeId: string): { allow: string[]; deny: string[] } {
    const node = this.nodeOf(this.internal(version), version, nodeId)
    return { allow: [...(node.tools?.allow ?? [])], deny: [...(node.tools?.deny ?? [])] }
  }

  // 节点收口用的判定条件：模板条件为基线，节点条件按 AND 追加（规格 6.1 行 837）
  policyFor(version: string | number, nodeId: string): { passConditions: PassCondition[]; requiredHashes: string[] } {
    const def = this.internal(version)
    const node = this.nodeOf(def, version, nodeId)
    // 必留哈希：模板要求与节点要求取并集，缺一个都不许收口（规格 4.7 行 380）
    const requiredHashes = Array.from(new Set([...(def.required_hashes ?? []), ...(node.required_hashes ?? [])]))
    return {
      passConditions: mergePassConditions(def.pass_conditions ?? [], node.pass_conditions ?? []),
      requiredHashes,
    }
  }

  // 目录本体：只有目录自己用，拿到的是冻结的那一份
  private internal(version: string | number): WorkflowDefinition {
    const def = this.defs.get(String(version))
    if (!def) throw new OrchError('NOT_FOUND', '工作流版本没加载过', { workflow_version: String(version) })
    return def
  }

  private nodeOf(def: WorkflowDefinition, version: string | number, nodeId: string): WorkflowNodeDef {
    const node = def.nodes.find((n) => n.node_id === nodeId)
    if (!node) throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '节点不在这个工作流版本里', { workflow_version: String(version), nodeId })
    return node
  }

  // 别名预检：账本里 workflow_version 是整数列，'01' 落库后与 '1' 是同一份定义，撞上另一份就要拒
  private assertAliasFree(key: string, def: WorkflowDefinition): void {
    if (!/^\d+$/.test(key)) return
    const alias = String(Number(key))
    if (alias === key) return
    const hit = this.defs.get(alias)
    if (hit && definitionHashOf(hit) !== definitionHashOf(def)) {
      throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '版本号别名撞上了另一份定义', { workflow_version: key, alias })
    }
  }

  private remember(key: string, def: WorkflowDefinition): void {
    // 冻结后进目录：外部拿到过这份引用也改不动它
    const frozen = deepFreeze(def)
    // 别名撞车先判再落 Map：撞上了整份定义就不进目录，不留半份（原来先落 Map 再抛，目录里会多一份没通过检查的定义）
    this.assertAliasFree(key, frozen)
    this.defs.set(key, frozen)
    // 账本里 workflow_version 是整数列：'01' 这类版本号存进去会变成 1，别名兜住它
    if (/^\d+$/.test(key)) {
      this.defs.set(String(Number(key)), frozen)
    }
  }
}

export function definitionHashOf(def: WorkflowDefinition): string {
  return sha256Hex(canonicalJson(def))
}

// 快照：canonical_json 走一遍再解析，得到的副本与来源彻底断开，也统一成规范键序
function snapshotOf(def: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(canonicalJson(def)) as WorkflowDefinition
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
