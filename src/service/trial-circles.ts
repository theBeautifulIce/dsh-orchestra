import { realpathSync } from 'node:fs'
import { OrchError } from '../core/errors.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { makeTx, withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'
import { resolveInside } from '../executor/tools.ts'

export type Circle = 'R0' | 'R1' | 'R2'
type Workspace = { id: string; kind: 'synthetic' | 'repository' | 'sandbox' }
type Flow = { id: string; hash: string }
export type TrialScope = { workspaces: Workspace[]; flows: Flow[]; tools: string[] }
type RecordState = { candidate: string; circle: Circle; revision: number; since: string; scope: TrialScope; halted: boolean }
type Transition = { candidate: string; from: Circle; to: Circle; revision: number; since: string; scope: TrialScope }
export type TrialOptions = {
  candidate: string
  workspace: Workspace & { root: string }
  /** Installed host verifies bound operator, expiry, scope, G6 and actual observation records. */
  authorize: (proof: string, transition: Readonly<Transition>) => {
    actor: string; expiresAt: string; observationFrom: string; observationTo: string; evidenceId: string; gateG6: boolean
  } | null
  authenticateOperator: (proof: string, action: 'stop' | 'restart') => string | null
  now?: () => string
}
const metaKey = 's6_trial_circle'
const hosts = new WeakMap<Db['raw'], { workspace: Workspace & { root: string }; candidate: string }>()
const day = 86_400_000
const deny = (message: string): never => { throw new OrchError('FORBIDDEN', message) }
const emptyScope = (): TrialScope => ({ workspaces: [], flows: [], tools: [] })

function read(tx: Tx): RecordState | null {
  const row = tx.get<{ value: string }>('SELECT value FROM service_meta WHERE key=?', [metaKey])
  return row ? JSON.parse(row.value) as RecordState : null
}
function save(tx: Tx, state: RecordState, actor: string, evidence: string, at: string) {
  tx.run('INSERT INTO service_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    [metaKey, JSON.stringify(state), at])
  appendEvent(tx, { type: 'release.trial_circle', payload: { ...state, actor, evidence_id: evidence } })
}
function requireWorkspace(tx: Tx, state: RecordState) {
  const host = hosts.get(tx.raw)
  if (!host || state.halted || host.candidate !== state.candidate) return deny('试用账本要求已登记的运行宿主，当前圈可能已暂停')
  if (state.circle === 'R0' ? host.workspace.kind !== 'synthetic' :
    !state.scope.workspaces.some((w) => w.id === host.workspace.id && w.kind === host.workspace.kind)) return deny('当前工作区未获本圈授权')
  return host
}

/** All normal root and nested run paths call this with the pinned definition from the ledger. */
export function requireTrialFlow(tx: Tx, id?: string | null, hash?: string | null) {
  const state = read(tx)
  if (!state) return
  requireWorkspace(tx, state)
  if (state.circle !== 'R0' && !state.scope.flows.some((flow) => flow.id === id && flow.hash === hash)) deny('流程版本不在本圈受信清单')
}
export function requireTrialTool(tx: Tx, tool: string, cwd: string, capability: string, nodeId?: string) {
  const state = read(tx)
  if (!state) return
  const host = requireWorkspace(tx, state)
  if (nodeId && state.circle !== 'R0') {
    const pinned = tx.get<{ id: string; hash: string }>('SELECT r.workflow_id AS id,r.workflow_definition_hash AS hash FROM runs r JOIN node_runs n ON n.run_id=r.run_id WHERE n.node_run_id=?', [nodeId])
    if (!pinned || !state.scope.flows.some((f) => f.id === pinned.id && f.hash === pinned.hash)) deny('该工具所属的流程版本不在当前试用圈清单')
  }
  if (state.circle !== 'R0' && (capability !== 'read_only' || !state.scope.tools.includes(tool))) deny('当前试用圈仅开放登记的只读工具')
  resolveInside(host.workspace.root, realpathSync(resolveInside(host.workspace.root, cwd)))
}
export function requireTrialMemoryApply(tx: Tx) {
  const state = read(tx)
  if (!state) return
  requireWorkspace(tx, state)
  if (state.circle !== 'R0') deny('当前试用圈只开放记忆提议')
}
export function trialAllowsMemoryApply(db: Db): boolean {
  try { requireTrialMemoryApply(makeTx(db.raw)); return true }
  catch (error) { if (error instanceof OrchError && error.code === 'FORBIDDEN') return false; throw error }
}

function validateScope(to: Circle, scope: TrialScope, current: RecordState) {
  const ids = new Set(scope.workspaces.map((w) => w.id))
  if (ids.size !== scope.workspaces.length || !scope.workspaces.every((w) => w.id.trim() && ['repository','sandbox'].includes(w.kind))
    || !scope.flows.length || !scope.tools.length || !scope.tools.every((tool) => tool.trim())
    || !scope.flows.every((f) => f.id.trim() && /^[a-f0-9]{64}$/.test(f.hash))) deny('试用工作区、流程摘要与只读工具必须逐项登记')
  if (scope.workspaces.filter((w) => w.kind === 'repository').length !== 1) deny('试用圈需要一个登记的仓库工作区')
  if (to === 'R1' && scope.workspaces.length !== 1) deny('R1 限一个仓库工作区')
  if (to === 'R2' && (!scope.workspaces.some((w) => w.kind === 'sandbox') ||
    !scope.workspaces.some((w) => w.kind === 'repository' && w.id === current.scope.workspaces[0]?.id))) deny('R2 必须保留 R1 工作区并登记受控沙箱')
}

export function bindTrialHost(db: Db, options: TrialOptions, runnerRoot?: string) {
  const root = realpathSync(options.workspace.root)
  if (runnerRoot && realpathSync(runnerRoot) !== root) deny('宿主工作区与执行器实际根目录不符')
  if (!/^[0-9a-f]{40}$/.test(options.candidate) || !options.workspace.id.trim()) deny('试用需要完整候选与工作区绑定')
  const now = options.now ?? (() => new Date().toISOString())
  withTx(db, (tx) => {
    const previous = read(tx)
    if (previous) {
      if (previous.candidate !== options.candidate) deny('当前账本属于其他候选')
      return
    }
    if (options.workspace.kind !== 'synthetic') deny('第一个试用圈需要隔离的合成宿主')
    const at = now()
    save(tx, { candidate: options.candidate, circle: 'R0', revision: 1, since: at, scope: emptyScope(), halted: false }, 'host', 'synthetic-workspace-bound', at)
  })
  hosts.set(db.raw, { workspace: { ...options.workspace, root }, candidate: options.candidate })
  return {
    get: () => read(makeTx(db.raw))!,
    advance(proof: string, to: 'R1' | 'R2', scope: TrialScope, revision: number) {
      return withTx(db, (tx) => {
        const state = read(tx)!
        requireWorkspace(tx, state)
        if (revision !== state.revision || (state.circle === 'R0' ? to !== 'R1' : state.circle !== 'R1' || to !== 'R2')) deny('试用只可从当前修订逐圈申请')
        validateScope(to, scope, state)
        const at = now()
        const atMs = Date.parse(at)
        const initial = Date.parse(state.since)
        const required = (to === 'R1' ? 3 : 7) * day
        const grant = options.authorize(proof, { candidate: state.candidate, from: state.circle, to, revision, since: state.since, scope: structuredClone(scope) })
        if (!grant?.actor?.trim() || !grant.evidenceId?.trim() || grant.gateG6 !== true
          || ![atMs, initial, Date.parse(grant.expiresAt), Date.parse(grant.observationFrom), Date.parse(grant.observationTo)].every(Number.isFinite)
          || Date.parse(grant.expiresAt) <= atMs || Date.parse(grant.observationFrom) < initial
          || Date.parse(grant.observationTo) > atMs || Date.parse(grant.observationTo) - Date.parse(grant.observationFrom) < required) deny('缺少本候选的有效升圈批准、G6 或连续观察回执')
        const next = { ...state, circle: to, revision: revision + 1, since: at, scope: structuredClone(scope) }
        save(tx, next, grant!.actor, grant!.evidenceId, at)
        return next
      })
    },
    stop(proof: string, reason: string) {
      const actor = options.authenticateOperator(proof, 'stop')
      if (!actor || !reason.trim()) deny('退圈需要获准的值班人和事故原因')
      return withTx(db, (tx) => {
        const state = read(tx)!
        const at = now()
        const next: RecordState = { ...state, circle: 'R0', halted: true, scope: emptyScope(), since: at, revision: state.revision + 1 }
        save(tx, next, actor!, reason, at)
        return next
      })
    },
    restartSynthetic(proof: string, reason: string, revision: number) {
      const actor = options.authenticateOperator(proof, 'restart')
      if (!actor || !reason.trim() || options.workspace.kind !== 'synthetic') deny('重开基础圈需要获准的合成宿主和恢复原因')
      return withTx(db, (tx) => {
        const state = read(tx)!
        if (!state.halted || state.circle !== 'R0' || revision !== state.revision) deny('基础圈状态已变更')
        const at = now()
        const next = { ...state, halted: false, revision: revision + 1, since: at }
        save(tx, next, actor!, reason, at)
        return next
      })
    },
  }
}
