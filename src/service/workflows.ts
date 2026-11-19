// src/service/workflows.ts —— 工作流定义目录（规格 2.4 行 122、6.1 行 837-844）
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { requireCapability, type Phase } from '../core/config.ts'
import { deepFreeze } from '../core/freeze.ts'
import { mergePassConditions, type PassCondition } from '../core/policy.ts'
import { assertDefinitionAllowed, SUBWORKFLOW_MAX_DEPTH, type WorkflowDefinition, type WorkflowNodeDef } from '../core/workflow-def.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'

// 旧版本号没有工作流命名空间：读旧库、旧 run、旧 API 全部归到这个默认空间
export const DEFAULT_WORKFLOW_ID = 'default'

export type LoadWorkflowResult = {
  workflow_id: string
  workflow_version: string
  nodes: { node_id: string; type: string; pass_conditions: PassCondition[] }[]
}

type WorkflowVersionRow = { workflow_id: string; version: string; content_hash: string; definition_json: string }

export function workflowIdOf(def: WorkflowDefinition): string {
  return String(def.workflow_id ?? DEFAULT_WORKFLOW_ID)
}

// 命名空间与版本号会进主键、事件和日志：只收有界、无首尾空白的标识，
// 避免 " a" 与 "a"、带换行的版本号在库里成为两条看起来一样的身份（第48轮 S1 P2）。
const WORKFLOW_ID_MAX = 128
const WORKFLOW_VERSION_MAX = 64
const WORKFLOW_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

function assertIdentity(kind: 'workflow_id' | 'workflow_version', value: string, max: number): string {
  const text = String(value)
  if (text.length === 0 || text.length > max || !WORKFLOW_IDENTITY_PATTERN.test(text)) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', '工作流身份不合法，只收字母、数字与 . _ : -', {
      field: kind,
      value: text,
      max,
    })
  }
  return text
}

function assertDefinitionIdentity(workflowId: string, version: string): void {
  assertIdentity('workflow_id', workflowId, WORKFLOW_ID_MAX)
  assertIdentity('workflow_version', version, WORKFLOW_VERSION_MAX)
}

function keyOf(workflowId: string, version: string): string {
  return `${workflowId}\u0000${version}`
}

// 定义只许从入口加载：加载期就按阶段拒越界能力，别等到派发才发现
// 传了 db 就落 workflow_versions：跨重启同版本改内容必须被拒，在飞 run 的判定条件不跟着变（第六轮审计 P1-1）
export class WorkflowCatalog {
  private readonly defs = new Map<string, WorkflowDefinition>()
  private readonly phase: Phase
  private readonly db?: Db

  private readonly isReadOnlyTool?: (tool: string) => boolean

  constructor(phase: Phase, db?: Db, isReadOnlyTool?: (tool: string) => boolean) {
    this.phase = phase
    this.db = db
    this.isReadOnlyTool = isReadOnlyTool
  }

  initialAgentEffect(node: WorkflowNodeDef): 'pure' | 'compensable' | 'irreversible' {
    if (node.type !== 'agent' || node.side_effect_policy === undefined) return 'compensable'
    if (node.side_effect_policy !== 'pure') return node.side_effect_policy
    const denied = new Set(node.tools?.deny ?? [])
    const allowed = (node.tools?.allow ?? []).filter(tool => !denied.has(tool))
    // Only the host registry can corroborate a publisher's pure declaration.
    return this.isReadOnlyTool && allowed.every(this.isReadOnlyTool) ? 'pure' : 'compensable'
  }

  // 启动时把已落库的定义装回内存；落库内容同样过阶段校验，旧库里的越界定义不能借重启复活
  hydrate(): number {
    if (!this.db) return 0
    const rows = this.db.raw.prepare('SELECT workflow_id, version, content_hash, definition_json FROM workflow_versions ORDER BY workflow_id ASC, version ASC').all() as WorkflowVersionRow[]
    for (const row of rows) {
      // 快照化：落库文本先还原成独立对象，校验、哈希、进目录都只认这份快照
      const snapshot = snapshotOf(JSON.parse(row.definition_json) as WorkflowDefinition)
      this.validateDefinition(snapshot)
      // 行键与快照必须指向同一个身份：011 升级时旧定义可能内嵌过 workflow_id，
      // 直接按 default 装回会把 wf-a 的定义挂到 default 名下，建 run 时再串到别的命名空间。
      const snapshotId = workflowIdOf(snapshot)
      const snapshotVersion = String(snapshot.workflow_version)
      assertDefinitionIdentity(row.workflow_id, row.version)
      if (snapshotId !== row.workflow_id || snapshotVersion !== row.version) {
        throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '工作流定义的行键与快照身份不一致，库被改过', {
          row_workflow_id: row.workflow_id,
          row_version: row.version,
          snapshot_workflow_id: snapshotId,
          snapshot_version: snapshotVersion,
        })
      }
      if (definitionHashOf(snapshot) !== row.content_hash) {
        throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '工作流定义的落库哈希对不上，库被改过', {
          workflow_id: row.workflow_id,
          workflow_version: row.version,
        })
      }
      this.remember(row.workflow_id, row.version, snapshot)
    }
    return rows.length
  }

  /**
   * 发布事务提交后把新版本装进内存目录：同一进程立刻可起 run，不必等重启 hydrate（审计 P1-1）。
   * 哈希对不上就拒：内存定义必须和库内版本一字不差。
   */
  adopt(def: WorkflowDefinition, expectedHash: string): void {
    const snapshot = snapshotOf(def)
    this.validateDefinition(snapshot)
    const workflowId = workflowIdOf(snapshot)
    const key = String(snapshot.workflow_version)
    if (definitionHashOf(snapshot) !== expectedHash) {
      throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '注册到目录的定义与库内哈希不一致', {
        workflow_id: workflowId,
        workflow_version: key,
      })
    }
    this.remember(workflowId, key, snapshot)
  }

  /** 发布前沿用目录的阶段限制和运行配置校验，避免提交目录无法加载的版本。 */
  validateDefinition(def: WorkflowDefinition): void {
    this.requireWorkflowCapability(workflowIdOf(def))
    assertDefinitionAllowed(def, this.phase)
  }

  requireWorkflowCapability(workflowId: string | undefined): void {
    if (workflowId === 'wf_release_v1') requireCapability(this.phase, 'release')
  }

  load(def: WorkflowDefinition): LoadWorkflowResult {
    // 快照化：canonical_json 走一遍再解析，拿到的是与调用方彻底断开的独立副本；
    // 调用方之后再改原对象（哪怕改嵌套的 tools.allow）也影响不到目录里的定义（第二次意见 P1 问题 A）
    const snapshot = snapshotOf(def)
    this.validateDefinition(snapshot)
    const workflowId = workflowIdOf(snapshot)
    const key = String(snapshot.workflow_version)
    assertDefinitionIdentity(workflowId, key)
    const hash = definitionHashOf(snapshot)
    // 同一 workflow 的同一版本号只能对应一份定义：reload 改写已建 run 的判定条件，就是绕过不可变模板（第五轮审计 P1-1）
    const persisted = this.db?.raw.prepare(
      'SELECT workflow_id, version, content_hash, definition_json FROM workflow_versions WHERE workflow_id = ? AND version = ?',
    ).get(workflowId, key) as WorkflowVersionRow | undefined
    if (persisted && persisted.content_hash !== hash) {
      throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '同一工作流版本不许改写定义，要改请升版本号', {
        workflow_id: workflowId,
        workflow_version: key,
      })
    }
    const existing = this.defs.get(keyOf(workflowId, key))
    if (existing) {
      if (definitionHashOf(existing) !== hash) {
        throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '同一工作流版本不许改写定义，要改请升版本号', {
          workflow_id: workflowId,
          workflow_version: key,
        })
      }
      return summarize(workflowId, snapshot)
    }
    // 版本号别名撞车要在落库之前判：先写库再报错，库里会多出一行没通过检查的定义
    this.assertAliasFree(workflowId, key, snapshot)
    // 先落库再进内存：事务失败就整份定义没进目录，内存不留未经持久化的残影（第二次意见 P1 问题 B）
    if (this.db && !persisted) {
      try {
        withTx(this.db, (tx) => {
          tx.run(
            'INSERT INTO workflow_versions (workflow_id, version, content_hash, definition_json, created_at) VALUES (?, ?, ?, ?, ?)',
            [workflowId, key, hash, canonicalJson(snapshot), new Date().toISOString()],
          )
        })
      } catch (err) {
        throw new OrchError('SERVICE_UNAVAILABLE', '工作流定义落库失败，这份定义没有进目录', {
          workflow_id: workflowId,
          workflow_version: key,
          cause: err instanceof Error ? err.message : String(err),
        })
      }
    }
    this.remember(workflowId, key, snapshot)
    // 发布期能查的先查：闭包内子流程都已加载时，环与深度在这里就报，不留到派发。
    // 子流程尚未发布的合法顺序（先父后子）交给派发期的强校验，不在这里误拒。
    this.assertSubworkflowClosure(workflowId, key)
    return summarize(workflowId, snapshot)
  }

  /**
   * 只在“引用的版本都已经加载”时做环/深度校验：
   * 缺版本说明这个子流程还没发布，此时无法判断整图，强校验放在派发路径（assertSubworkflowGraphFor）。
   */
  private assertSubworkflowClosure(workflowId: string, version: string): void {
    const stack = new Set<string>()
    const walk = (id: string, ver: string, depth: number): void => {
      let def: WorkflowDefinition
      try {
        def = this.internal(id, ver)
      } catch {
        return
      }
      const key = keyOf(id, ver)
      if (stack.has(key)) {
        throw new OrchError('SUBWORKFLOW_CYCLE', '子流程引用成环', { workflowId: id, pinnedVersion: Number(ver) })
      }
      if (depth > SUBWORKFLOW_MAX_DEPTH) {
        throw new OrchError('SUBWORKFLOW_DEPTH_EXCEEDED', '子流程深度超过 max_depth=2', {
          workflowId: id,
          pinnedVersion: Number(ver),
          depth,
          maxDepth: SUBWORKFLOW_MAX_DEPTH,
        })
      }
      stack.add(key)
      for (const node of def.nodes) {
        if (node.type !== 'subworkflow' || !node.subworkflow) continue
        walk(node.subworkflow.workflow_id, String(node.subworkflow.pinned_version), depth + 1)
      }
      stack.delete(key)
    }
    walk(workflowId, version, 0)
  }

  // 两参：按 (workflow_id, version) 精确取；单参：向后兼容，要求这个版本号在所有工作流里唯一
  get(workflowIdOrVersion: string | number, maybeVersion?: string | number): WorkflowDefinition {
    // 交出去的是深拷贝：调用方拿到的是能随便改的独立副本，目录里的本体不受影响（第二次意见 P1 问题 A）
    return snapshotOf(this.resolve(workflowIdOrVersion, maybeVersion))
  }

  // run 绑定的定义哈希：收口时拿它和当前目录比，跨重启改内容的一律拒
  definitionHash(workflowIdOrVersion: string | number, maybeVersion?: string | number): string {
    return definitionHashOf(this.resolve(workflowIdOrVersion, maybeVersion))
  }

  // 节点可用的只读工具：只从加载过的定义里取，请求体不能自带（第五轮审计 P1-2）
  toolPolicyFor(workflowIdOrVersion: string | number, versionOrNodeId: string | number, maybeNodeId?: string): { allow: string[]; deny: string[] } {
    if (maybeNodeId === undefined) {
      const version = String(workflowIdOrVersion)
      const node = this.nodeOf(this.resolve(version), undefined, version, String(versionOrNodeId))
      return { allow: [...(node.tools?.allow ?? [])], deny: [...(node.tools?.deny ?? [])] }
    }
    const workflowId = String(workflowIdOrVersion)
    const version = String(versionOrNodeId)
    const node = this.nodeOf(this.resolve(workflowId, version), workflowId, version, maybeNodeId)
    return { allow: [...(node.tools?.allow ?? [])], deny: [...(node.tools?.deny ?? [])] }
  }

  // 节点收口用的判定条件：模板条件为基线，节点条件按 AND 追加（规格 6.1 行 837）
  policyFor(workflowIdOrVersion: string | number, versionOrNodeId: string | number, maybeNodeId?: string): { passConditions: PassCondition[]; requiredHashes: string[] } {
    const single = maybeNodeId === undefined
    const workflowId = single ? undefined : String(workflowIdOrVersion)
    const version = single ? String(workflowIdOrVersion) : String(versionOrNodeId)
    const nodeId = single ? String(versionOrNodeId) : maybeNodeId
    const def = this.resolve(workflowIdOrVersion, single ? undefined : version)
    const node = this.nodeOf(def, workflowId, version, nodeId)
    // 必留哈希：模板要求与节点要求取并集，缺一个都不许收口（规格 4.7 行 380）
    const requiredHashes = Array.from(new Set([...(def.required_hashes ?? []), ...(node.required_hashes ?? [])]))
    return {
      passConditions: mergePassConditions(def.pass_conditions ?? [], node.pass_conditions ?? []),
      requiredHashes,
    }
  }

  // 目录本体：只有目录自己用，拿到的是冻结的那一份
  private internal(workflowId: string, version: string): WorkflowDefinition {
    this.requireWorkflowCapability(workflowId)
    const direct = this.defs.get(keyOf(workflowId, version))
    if (direct) return direct
    // workflow_version 在账本里是整数列：'01' 这类版本号读回来是 1，按同一命名空间的别名兜住
    if (/^\d+$/.test(version)) {
      const alias = this.defs.get(keyOf(workflowId, String(Number(version))))
      if (alias) return alias
    }
    throw new OrchError('NOT_FOUND', '工作流版本没加载过', { workflow_id: workflowId, workflow_version: version })
  }

  // 单参兼容：同一个版本号只能命中一份定义；两个工作流各有一份就必须显式给 workflow_id
  private resolve(workflowIdOrVersion: string | number, maybeVersion?: string | number): WorkflowDefinition {
    if (maybeVersion !== undefined) return this.internal(String(workflowIdOrVersion), String(maybeVersion))
    const requested = String(workflowIdOrVersion)
    const matches: WorkflowDefinition[] = []
    const seen = new Set<WorkflowDefinition>()
    for (const def of this.defs.values()) {
      if (seen.has(def)) continue
      seen.add(def)
      const actual = String(def.workflow_version)
      const same = actual === requested || (/^\d+$/.test(requested) && /^\d+$/.test(actual) && Number(actual) === Number(requested))
      if (same) matches.push(def)
    }
    if (matches.length === 1) return matches[0]!
    if (matches.length === 0) throw new OrchError('NOT_FOUND', '工作流版本没加载过', { workflow_version: requested })
    throw new OrchError('WORKFLOW_VERSION_CONFLICT', '这个版本号同时存在于多个工作流，必须带 workflow_id', {
      workflow_version: requested,
      workflow_ids: matches.map((d) => workflowIdOf(d)),
    })
  }

  private nodeOf(def: WorkflowDefinition, workflowId: string | undefined, version: string, nodeId: string): WorkflowNodeDef {
    const node = def.nodes.find((n) => n.node_id === nodeId)
    if (!node) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '节点不在这个工作流版本里', {
        ...(workflowId === undefined ? {} : { workflow_id: workflowId }),
        workflow_version: version,
        nodeId,
      })
    }
    return node
  }

  // 别名预检：账本里 workflow_version 是整数列，'01' 落库后与 '1' 是同一份定义，撞上另一份就要拒
  private assertAliasFree(workflowId: string, key: string, def: WorkflowDefinition): void {
    if (!/^\d+$/.test(key)) return
    const alias = String(Number(key))
    if (alias === key) return
    const hit = this.defs.get(keyOf(workflowId, alias))
    if (hit && definitionHashOf(hit) !== definitionHashOf(def)) {
      throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '版本号别名撞上了另一份定义', {
        workflow_id: workflowId,
        workflow_version: key,
        alias,
      })
    }
  }

  private remember(workflowId: string, key: string, def: WorkflowDefinition): void {
    // 冻结后进目录：外部拿到过这份引用也改不动它
    const frozen = deepFreeze(def)
    // 别名撞车先判再落 Map：撞上了整份定义就不进目录，不留半份（原来先落 Map 再抛，目录里会多一份没通过检查的定义）
    this.assertAliasFree(workflowId, key, frozen)
    this.defs.set(keyOf(workflowId, key), frozen)
    // 账本里 workflow_version 是整数列：'01' 这类版本号存进去会变成 1，别名兜住它
    if (/^\d+$/.test(key)) {
      this.defs.set(keyOf(workflowId, String(Number(key))), frozen)
    }
  }
}

export function definitionHashOf(def: WorkflowDefinition): string {
  // default 是旧数据的命名空间，不是定义内容：显式写 default 与省略 id 必须得到同一个哈希。
  // 非 default 的 workflow_id 参与哈希，两个工作流各自版本 1 的内容从此彼此独立。
  const copy = { ...def }
  if (copy.workflow_id === undefined || String(copy.workflow_id) === DEFAULT_WORKFLOW_ID) {
    delete (copy as { workflow_id?: string }).workflow_id
  } else {
    copy.workflow_id = String(copy.workflow_id)
  }
  return sha256Hex(canonicalJson(copy))
}

// 快照：canonical_json 走一遍再解析，得到的副本与来源彻底断开，也统一成规范键序
function snapshotOf(def: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(canonicalJson(def)) as WorkflowDefinition
}

function summarize(workflowId: string, def: WorkflowDefinition): LoadWorkflowResult {
  return {
    workflow_id: workflowId,
    workflow_version: String(def.workflow_version),
    nodes: def.nodes.map((n) => ({
      node_id: n.node_id,
      type: n.type,
      pass_conditions: mergePassConditions(def.pass_conditions ?? [], n.pass_conditions ?? []),
    })),
  }
}
