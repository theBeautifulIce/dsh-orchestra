import { canonicalJson, hmacSha256Hex, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { uuidv7 } from '../core/ids.ts'
import { appendEvent, chainIsIntact, readChain, readChainHead } from '../infra/db/ledger.ts'
import { withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'

export type CoordinationBinding = { node_run_id: string; attempt: number; action_generation: number; executor_session_id: string }
export type CoordinationItem = {
  id: string; kind: 'request' | 'finding' | 'handoff' | 'blocker'; source: string; target: string | null;
  body: string; state: 'pending' | 'recorded' | 'reported' | 'answered' | 'expired' | 'unavailable' | 'withdrawn' | 'acknowledged';
  reply: string | null; reason: string | null; revision: number; created_ms: number; expires_ms: number;
  evidence_strength: 'none';
}
// All text is untrusted reference data. These records are deliberately not acceptance evidence.
type Row = Omit<CoordinationItem, 'source' | 'target' | 'evidence_strength'> & {
  run_id: string; source_node: string; source_attempt: number; source_generation: number; source_session: string;
  target_node: string | null; target_attempt: number | null; target_generation: number | null; target_session: string | null;
  updated_ms: number; dedup: string; mac: string;
}
type Node = { node_run_id: string; node_id: string; run_id: string; attempt: number; action_generation: number; executor_session_id: string }
const MAX_RUN = 64, MAX_SOURCE = 12, MAX_PENDING = 8, MAX_SWEEP = 128
const attentionStates = new Set<CoordinationItem['state']>(['reported', 'expired', 'unavailable'])
const live = `SELECT n.node_run_id,n.node_id,n.run_id,n.attempt,n.action_generation,n.executor_session_id
  FROM node_runs n JOIN runs r USING(run_id)
  WHERE n.node_type='agent' AND n.status='started' AND n.side_effect_policy='pure'
    AND n.replacement_node_run_id IS NULL AND n.executor_session_id IS NOT NULL
    AND n.owner_epoch=? AND n.fence_state IS NULL AND julianday(n.lease_expires_at)>julianday(?)
    AND r.status='running' AND r.cancel_requested_at IS NULL
    AND n.node_run_id=(SELECT latest.node_run_id FROM node_runs latest WHERE latest.run_id=n.run_id AND latest.node_id=n.node_id
      ORDER BY latest.attempt DESC, latest.seq DESC LIMIT 1)`
function invalid(reason: string): never { throw new OrchError('PAYLOAD_SCHEMA_INVALID', reason) }
function forbidden(reason: string): never { throw new OrchError('FORBIDDEN', reason) }
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('协作请求必须是对象')
  return raw as Record<string, unknown>
}
function keys(o: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(o).some(key => !allowed.includes(key))) invalid('协作请求含未支持字段')
}
function text(v: unknown, max: number): string {
  if (typeof v !== 'string' || v.length > max * 2 || !v.trim() || v.includes('\0') || [...v.trim()].length > max) invalid(`协作字段必须为 1–${max} 字`)
  return v.trim()
}
function revision(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) invalid('需提供当前协作修订号')
  return v
}
function sourceBinding(row: Row): CoordinationBinding { return { node_run_id: row.source_node, attempt: row.source_attempt, action_generation: row.source_generation, executor_session_id: row.source_session } }
function targetBinding(row: Row): CoordinationBinding | undefined {
  return row.target_node && row.target_attempt !== null && row.target_generation !== null && row.target_session
    ? { node_run_id: row.target_node, attempt: row.target_attempt, action_generation: row.target_generation, executor_session_id: row.target_session } : undefined
}
function matches(node: Node, b: CoordinationBinding) { return node.node_run_id === b.node_run_id && node.attempt === b.attempt && node.action_generation === b.action_generation && node.executor_session_id === b.executor_session_id }

export function createRunCoordination(db: Db, secret: string, authorize: (tx: ReadTx, actor: string, run: string) => void,
  clock: () => number = Date.now, nameNode: (tx: ReadTx, run: string, node: string) => string = (_tx, _run, node) => node) {
  const mac = (row: Omit<Row, 'mac'> | Row) => { const { mac: _, ...fields } = row as Row; return hmacSha256Hex(secret, 'run-coordination:v1\0' + canonicalJson(fields)) }
  const authentic = (tx: ReadTx, row: Row) => row.mac === mac(row) && Boolean(tx.get(`SELECT 1 FROM events
    WHERE idempotency_key=? AND type='run.coordination' AND run_id=? AND json_extract(payload_redacted,'$.digest')=?`,
    [`coordination:${row.id}:${row.revision}`,row.run_id,row.mac]))
    && !tx.get('SELECT 1 FROM events WHERE idempotency_key=?',[`coordination:${row.id}:${row.revision+1}`])
  const signed = (tx: ReadTx, node: Node) => {
    const chain=readChain(tx,node.node_run_id)
    return chainIsIntact(secret,chain,readChainHead(tx,node.node_run_id),true) && chain.some(event=>{
      if(event.type!=='executor.model_confirmed')return false
      try { const p=JSON.parse(event.payload);return p.state==='confirmed' && p.attempt===node.attempt && p.action_generation===node.action_generation }
      catch { return false }
    })
  }
  function lookup(tx: ReadTx, id: string, now: number): Node | undefined {
    return tx.get<Node>(live + ' AND n.node_run_id=?', [db.epoch, new Date(now).toISOString(), id])
  }
  function current(tx: ReadTx, binding: CoordinationBinding, now: number): Node | undefined {
    const node = lookup(tx, binding.node_run_id, now)
    return node && matches(node, binding) && signed(tx, node) ? node : undefined
  }
  function requireNode(tx: ReadTx, binding: CoordinationBinding, now: number): Node {
    const node = current(tx, binding, now)
    if (!node) forbidden('协作仅限当前已授权、未被围栏的纯执行尝试')
    return node
  }
  // Restrict free-text peer messages for any run with node-scoped materials. A coordination request never grants access.
  const peerAllowed = (tx: ReadTx, run: string) => {
    const ancestry=tx.all<{run_id:string;parent_run_id:string|null}>(`WITH RECURSIVE lineage(run_id,parent_run_id,depth) AS (
      SELECT run_id,parent_run_id,0 FROM runs WHERE run_id=?
      UNION ALL SELECT r.run_id,r.parent_run_id,l.depth+1 FROM runs r JOIN lineage l ON r.run_id=l.parent_run_id WHERE l.depth<16
    ) SELECT run_id,parent_run_id FROM lineage`,[run])
    return ancestry.some(r=>r.parent_run_id===null) && !ancestry.some(r=>tx.get('SELECT 1 FROM plan_materials WHERE run_id=? LIMIT 1',[r.run_id])
      || tx.get('SELECT 1 FROM plan_material_nodes WHERE run_id=? LIMIT 1',[r.run_id]))
  }
  function rows(tx: ReadTx, run: string): Row[] {
    return tx.all<Row>('SELECT * FROM run_coordination WHERE run_id=? ORDER BY created_ms,id LIMIT 64', [run]).filter(row=>authentic(tx,row))
  }
  function item(tx: ReadTx, row: Row): CoordinationItem {
    return { id: row.id, kind: row.kind, source: nameNode(tx, row.run_id, row.source_node),
      target: row.target_node === null ? null : nameNode(tx, row.run_id, row.target_node), body: row.body, state: row.state,
      reply: row.reply, reason: row.reason, revision: row.revision, created_ms: row.created_ms, expires_ms: row.expires_ms, evidence_strength: 'none' }
  }
  function record(tx: Tx, row: Row) {
    appendEvent(tx, { type: 'run.coordination', runId: row.run_id, nodeRunId: row.source_node,
      idempotencyKey: `coordination:${row.id}:${row.revision}`,
      payload: { id: row.id, kind: row.kind, state: row.state, revision: row.revision, target_node: row.target_node, digest: row.mac, evidence_strength: 'none' } })
  }
  function update(tx: Tx, row: Row, state: Row['state'], now: number, reason: string | null, reply = row.reply): Row {
    const next: Row = { ...row, state, reason, reply, revision: row.revision + 1, updated_ms: now, mac: '' }
    next.mac = mac(next)
    const changed = tx.run('UPDATE run_coordination SET state=?,reason=?,reply=?,revision=?,updated_ms=?,mac=? WHERE id=? AND revision=? AND mac=?',
      [state, reason, reply, next.revision, now, next.mac, row.id, row.revision, row.mac]).changes
    if (changed !== 1) throw new OrchError('OPERATION_ID_CONFLICT', '协作事项已变化，请重新读取')
    record(tx, next)
    return next
  }
  function get(tx: ReadTx, id: string, run: string) {
    const row = tx.get<Row>('SELECT * FROM run_coordination WHERE id=? AND run_id=?', [id, run])
    if (!row || !authentic(tx,row)) forbidden('协作事项不存在或记录未通过核验')
    return row
  }
  // A live recipient may record the answer to an existing request after its
  // sender completed normally. This never makes the sender a live peer again.
  function sourceCanReceive(tx: ReadTx, row: Row, now: number): boolean {
    const binding = sourceBinding(row)
    if (current(tx, binding, now)) return true
    const finished = tx.get<Node>(`SELECT n.* FROM node_runs n JOIN runs r USING(run_id)
      WHERE n.node_run_id=? AND n.run_id=? AND n.status='done' AND n.node_type='agent' AND n.side_effect_policy='pure'
        AND n.owner_epoch=? AND n.replacement_node_run_id IS NULL AND n.fence_state IS NULL
        AND r.status='running' AND r.cancel_requested_at IS NULL
        AND n.node_run_id=(SELECT latest.node_run_id FROM node_runs latest WHERE latest.run_id=n.run_id AND latest.node_id=n.node_id
          ORDER BY latest.attempt DESC,latest.seq DESC LIMIT 1)`, [binding.node_run_id, row.run_id, db.epoch])
    if (!finished || !matches(finished, binding) || !signed(tx, finished)) return false
    return Boolean(tx.get(`SELECT 1 FROM node_run_events e JOIN report_registry p ON p.node_run_id=e.node_run_id
      AND p.report_id=json_extract(e.payload,'$.report_id') AND p.report_seq=json_extract(e.payload,'$.report_seq')
      WHERE e.node_run_id=? AND e.type='report_applied' AND p.attempt=? AND p.state IN ('applied','replayed')
        AND json_extract(e.payload,'$.next_status')='done'
        AND e.seq>(SELECT MAX(c.seq) FROM node_run_events c WHERE c.node_run_id=e.node_run_id AND c.type='executor.model_confirmed'
          AND json_extract(c.payload,'$.attempt')=? AND json_extract(c.payload,'$.action_generation')=?)`,
      [finished.node_run_id, finished.attempt, finished.attempt, finished.action_generation]))
  }
  function pendingState(tx: ReadTx, row: Row, now: number): { state: 'expired' | 'unavailable'; reason: string } | undefined {
    if (row.state !== 'pending') return
    if (now >= row.expires_ms || now < row.created_ms) return { state: 'expired', reason: '等待期限已到或时钟变化' }
    const target = targetBinding(row)
    const to=target && lookup(tx,target.node_run_id,now)
    if (!peerAllowed(tx, row.run_id) || !target || !to || !matches(to,target) || !sourceCanReceive(tx,row,now))
      return { state: 'unavailable', reason: '发起方或接收方已结束、失联或不再有协作权限' }
  }
  function reachable(edges: Row[], start: string, target: string) {
    const seen = new Set<string>(), todo = [start]
    while (todo.length) {
      const id = todo.pop()!
      if (id === target) return true
      if (seen.has(id)) continue
      seen.add(id)
      for (const edge of edges) if (edge.source_node === id && edge.target_node) todo.push(edge.target_node)
    }
    return false
  }
  function visible(tx: ReadTx, node: Node, now: number) {
    const peersAllowed = peerAllowed(tx, node.run_id)
    return rows(tx, node.run_id).filter(row => {
      if (row.target_node && !peersAllowed) return false
      if (row.state === 'pending' && pendingState(tx,row,now)) return false
      if (row.source_node === node.node_run_id && matches(node, sourceBinding(row))) return true
      const target = targetBinding(row)
      return !!target && matches(node, target) && row.state === 'pending'
    })
  }
  function create(tx: Tx, node: Node, input: Record<string, unknown>, now: number) {
    keys(input, ['action','kind','body','target_node_run_id','ttl_seconds'])
    const kind = input.kind
    if (kind !== 'request' && kind !== 'finding' && kind !== 'handoff' && kind !== 'blocker') invalid('未知协作类型')
    const body = text(input.body, 500)
    const ttl = input.ttl_seconds ?? 120
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 30 || ttl > 300) invalid('等待期限须为 30–300 秒')
    let target: Node | undefined
    if (kind === 'request' || kind === 'handoff') {
      if (!peerAllowed(tx, node.run_id)) forbidden('本次运行含节点专属材料；请使用原有授权交接或向主脑报告，不得自由转发材料')
      const id = text(input.target_node_run_id, 128)
      target = lookup(tx, id, now)
      if (!target || target.run_id !== node.run_id || target.node_run_id === node.node_run_id || !signed(tx, target)) forbidden('只能联系本次运行中当前可用的其他节点')
    } else if (input.target_node_run_id !== undefined || input.ttl_seconds !== undefined) invalid('向主脑报告不需要接收节点或等待期限')
    const dedup = sha256Hex(canonicalJson([node.run_id,node.node_run_id,node.attempt,node.action_generation,node.executor_session_id,kind,target?.node_run_id ?? null,target?.attempt ?? null,target?.action_generation ?? null,target?.executor_session_id ?? null,body,ttl]))
    const prior = tx.get<Row>('SELECT * FROM run_coordination WHERE dedup=?', [dedup])
    if (prior) { if (!authentic(tx,prior)) forbidden('协作记录未通过核验'); return item(tx, prior) }
    const total = tx.get<{ n: number }>('SELECT count(*) n FROM run_coordination WHERE run_id=?', [node.run_id])!.n
    const perSource = tx.get<{ n: number }>('SELECT count(*) n FROM run_coordination WHERE run_id=? AND source_node=?', [node.run_id,node.node_run_id])!.n
    if (total >= MAX_RUN || perSource >= MAX_SOURCE) throw new OrchError('RANGE_TOO_LARGE', '协作记录已达上限，请合并信息并使用原任务回报')
    const edges = rows(tx, node.run_id).filter(row => row.state === 'pending' && !pendingState(tx,row,now))
    if (target && (edges.length >= MAX_PENDING || reachable(edges, target.node_run_id, node.node_run_id)))
      throw new OrchError('RESOLUTION_NOT_AVAILABLE', '存在循环请求或等待事项过多，请继续原任务或向主脑报告问题')
    const row: Row = { id: uuidv7(), run_id: node.run_id, source_node: node.node_run_id, source_attempt: node.attempt,
      source_generation: node.action_generation, source_session: node.executor_session_id, target_node: target?.node_run_id ?? null,
      target_attempt: target?.attempt ?? null, target_generation: target?.action_generation ?? null, target_session: target?.executor_session_id ?? null,
      kind, body, state: target ? 'pending' : kind === 'blocker' ? 'reported' : 'recorded', reply: null, reason: null,
      created_ms: now, expires_ms: now + ttl * 1000, updated_ms: now, revision: 1, dedup, mac: '' }
    row.mac = mac(row)
    const cols = Object.keys(row) as (keyof Row)[]
    tx.run(`INSERT INTO run_coordination (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(k => row[k]))
    record(tx,row)
    return item(tx,row)
  }
  let sweepCursor=''
  return {
    call(binding: CoordinationBinding, raw: unknown) {
      const input = object(raw), now = clock()
      if (input.action === 'inbox') {
        keys(input,['action'])
        return withReadTx(db, ({tx}) => {
          const node = requireNode(tx,binding,now)
          const peers = peerAllowed(tx,node.run_id) ? tx.all<Node>(live + ' AND n.run_id=? AND n.node_run_id<>? ORDER BY n.seq LIMIT 16',
            [db.epoch,new Date(now).toISOString(),node.run_id,node.node_run_id]).filter(n=>signed(tx,n)).map(n=>({node_run_id:n.node_run_id,title:nameNode(tx,n.run_id,n.node_run_id)})) : []
          return { peers, items: visible(tx,node,now).slice(-12).map(row=>item(tx,row)), advice: '不要等待或轮询；继续原任务。协作不是授权或验收证据。' }
        })
      }
      return withTx(db, tx => {
        const node = requireNode(tx,binding,now)
        if (input.action === 'send') return create(tx,node,input,now)
        if (input.action !== 'reply' && input.action !== 'withdraw') invalid('未知协作操作')
        keys(input,input.action === 'reply' ? ['action','id','revision','body'] : ['action','id','revision'])
        const row = get(tx,text(input.id,128),node.run_id), rev = revision(input.revision)
        const isReply = input.action === 'reply', body = isReply ? text(input.body,500) : null
        const target = targetBinding(row)
        if (isReply ? !target || !matches(node,target) || !peerAllowed(tx,node.run_id) : !matches(node,sourceBinding(row))) forbidden('当前尝试无权处理此协作事项')
        if (row.revision === rev + 1 && (isReply ? row.state === 'answered' && row.reply === body : row.state === 'withdrawn')) return item(tx,row)
        if (row.revision !== rev || (isReply ? row.state !== 'pending' : !['pending','reported'].includes(row.state)))
          throw new OrchError('OPERATION_ID_CONFLICT', '协作事项已变化，请重新读取')
        const unavailable = pendingState(tx,row,now)
        if (isReply && unavailable) return item(tx,update(tx,row,unavailable.state,now,unavailable.reason))
        return item(tx,update(tx,row,isReply ? 'answered' : 'withdrawn',now,null,body))
      })
    },
    updates(binding: CoordinationBinding) {
      const now = clock()
      return withReadTx(db,({tx})=>{
        const node = requireNode(tx,binding,now)
        // Only actionable incoming messages and actual replies/settled requests are pushed into an existing step.
        return visible(tx,node,now).filter(row=>row.target_node===node.node_run_id && row.state==='pending'
          || row.source_node===node.node_run_id && ['answered','expired','unavailable'].includes(row.state)).map(row=>item(tx,row))
      })
    },
    sweep() {
      const now=clock()
      // Read first: avoid an empty write transaction during every event-driven wake.
      const candidates = withReadTx(db,({tx})=>{
        const page=tx.all<Row>(`SELECT * FROM run_coordination WHERE state='pending' AND id>? ORDER BY id LIMIT ${MAX_SWEEP}`,[sweepCursor])
        sweepCursor=page.length===MAX_SWEEP ? page.at(-1)!.id : ''
        return page.filter(row=>authentic(tx,row)).filter(row=>pendingState(tx,row,now))
      })
      if (!candidates.length) return 0
      return withTx(db,tx=>{
        let settled=0
        for (const previous of candidates) {
          const row=tx.get<Row>('SELECT * FROM run_coordination WHERE id=?',[previous.id])
          if (!row || !authentic(tx,row) || row.revision!==previous.revision) continue
          const next=pendingState(tx,row,now)
          if (next) { update(tx,row,next.state,now,next.reason); settled++ }
        }
        return settled
      })
    },
    listHuman(run: string, actor: string) {
      return withReadTx(db,({tx,as_of_seq})=>{
        authorize(tx,actor,run)
        const now=clock()
        return { as_of_seq, items: rows(tx,run).map(row=>{const p=pendingState(tx,row,now);return item(tx,p?{...row,...p}:row)}) }
      })
    },
    attention(run: string, actor: string) {
      return this.listHuman(run,actor).items.filter(row=>attentionStates.has(row.state)).slice(-8)
    },
    acknowledge(run: string, actor: string, raw: unknown) {
      const input=object(raw); keys(input,['id','revision'])
      return withTx(db,tx=>{
        authorize(tx,actor,run)
        const row=get(tx,text(input.id,128),run); const rev=revision(input.revision), now=clock()
        if (row.state==='acknowledged' && row.revision===rev+1) return item(tx,row)
        if (row.revision!==rev) throw new OrchError('OPERATION_ID_CONFLICT','协作事项已变化，请刷新')
        const p=pendingState(tx,row,now)
        if (!attentionStates.has(p?.state ?? row.state)) throw new OrchError('RESOLUTION_NOT_AVAILABLE','此事项不需要人工知悉')
        return item(tx,update(tx,row,'acknowledged',now,p?.reason ?? row.reason))
      })
    },
  }
}
export type RunCoordination = ReturnType<typeof createRunCoordination>
