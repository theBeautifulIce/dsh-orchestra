import { OrchError } from '../core/errors.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'

const key = 's6_run_intake'
const maxWaitMs = 30 * 60_000
type IntakeAction = 'pause' | 'resume' | 'page' | 'ack'
type State = {
  revision: number; paused: boolean; reason: string; actor: string | null
  awaiting: { id: string; sent_at: string; deadline: string; inbox_id?: string; channel?: 'dsh-onebot-qq' } | null
}

function read(tx: ReadTx): State {
  const row = tx.get<{ value: string }>('SELECT value FROM service_meta WHERE key=?', [key])
  if (!row) return { revision: 0, paused: false, reason: '', actor: null, awaiting: null }
  const saved = JSON.parse(row.value) as State
  if (!Number.isSafeInteger(saved.revision) || typeof saved.paused !== 'boolean'
    || saved.awaiting !== null && !Number.isFinite(Date.parse(saved.awaiting.deadline))) {
    throw new OrchError('SERVICE_UNAVAILABLE', '无法核实新运行接入状态')
  }
  return saved
}

function timedOut(state: State, now: number): boolean {
  return state.awaiting !== null && now >= Date.parse(state.awaiting.deadline)
}

/** Latch elapsed pages so a later clock correction or process restart cannot reopen intake. */
export function sweepIntake(db: Db, now: string) {
  const entry = db.raw.prepare('SELECT value FROM service_meta WHERE key=?').get(key)
  if (!entry) return
  const previous = JSON.parse(String(entry.value)) as State
  if (previous.paused || !timedOut(previous, Date.parse(now))) return
  withTx(db, (tx) => {
    const state = read(tx)
    if (state.paused || !timedOut(state, Date.parse(now))) return
    state.paused = true
    state.reason = '值班告警超过 30 分钟未确认'
    state.revision++
    tx.run('UPDATE service_meta SET value=?,updated_at=? WHERE key=?', [JSON.stringify(state), now, key])
    appendEvent(tx, { type: 'release.intake_timeout', payload: { page_id: state.awaiting?.id, revision: state.revision } })
  })
}

/** Called inside the business transaction before inserting a new root run. */
export function requireRunIntake(tx: Tx): void {
  const state = read(tx)
  if (state.paused || timedOut(state, Date.now())) {
    throw new OrchError('SERVICE_UNAVAILABLE', '新运行已暂停，现有运行继续收口', { revision: state.revision })
  }
}

export type IntakeOptions = {
  /** The installed host resolves an authenticated operator for this particular action. */
  authenticate: (proof: string, action: IntakeAction) => string | null
  /** Resolve a recorded, real tool invocation for the configured on-call chat in this workspace. */
  lookupQqDelivery?: (inboxId: string, invocationId: string) => {
    plugin: string; tool: string; sentAt: string; sent: boolean; messageId: string | null
  } | null
  now?: () => string
}

export function createIntakeControl(db: Db, options: IntakeOptions) {
  const nowAt = options.now ?? (() => new Date().toISOString())
  function change(action: IntakeAction, proof: string, reason: string, pageId?: string, expectedRevision?: number,
    delivery?: { inboxId: string; sentAt: string; actor: string }) {
    const actor = delivery?.actor ?? options.authenticate(proof, action)
    if (!actor) throw new OrchError('FORBIDDEN', '当前身份不能管理新运行接入')
    const note = reason.trim()
    if (!note || note.length > 500) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '请填写不超过 500 字的操作原因')
    const at = nowAt()
    const ms = Date.parse(at)
    if (!Number.isFinite(ms)) throw new OrchError('SERVICE_UNAVAILABLE', '无法读取可信时钟')
    return withTx(db, (tx) => {
      const previous = read(tx)
      if (expectedRevision !== undefined && expectedRevision !== previous.revision) throw new OrchError('STALE_GENERATION', '接入状态已变更')
      const state: State = { ...previous, revision: previous.revision + 1, actor, reason: note }
      if (action === 'page') {
        if (!pageId || pageId.length > 128) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '请提供实际告警回执编号')
        if (pageId.startsWith('qq:') && !delivery) throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', 'QQ 回执需从宿主调用记录核验')
        if (delivery) {
          const deliveryKey = 's6_oncall_' + pageId
          const earlier = tx.get<{ value: string }>('SELECT value FROM service_meta WHERE key=?', [deliveryKey])
          if (earlier?.value === delivery.inboxId) return previous
          if (earlier) throw new OrchError('STALE_GENERATION', '这张 QQ 回执已经关联其他面板告警')
          tx.run('INSERT INTO service_meta(key,value,updated_at) VALUES(?,?,?)', [deliveryKey, delivery.inboxId, at])
        }
        if (previous.awaiting?.id === pageId && previous.awaiting.inbox_id === delivery?.inboxId) return previous
        if (previous.awaiting) throw new OrchError('COMMAND_BUSY', '上一次告警仍在等待响应')
        const sentAt = delivery?.sentAt ?? at
        const deadline = Date.parse(sentAt) + maxWaitMs
        state.awaiting = { id: pageId, sent_at: sentAt, deadline: new Date(deadline).toISOString(),
          ...(delivery ? { inbox_id: delivery.inboxId, channel: 'dsh-onebot-qq' as const } : {}) }
        state.paused ||= ms >= deadline
      } else if (action === 'ack') {
        if (!pageId || previous.awaiting?.id !== pageId) throw new OrchError('STALE_GENERATION', '确认与待响应告警不一致')
        state.paused ||= timedOut(previous, ms)
        state.awaiting = null
      } else if (action === 'resume') {
        if (previous.awaiting) throw new OrchError('CONFIRMATION_REQUIRED', '恢复前须确认原告警')
        state.paused = false
      } else {
        state.paused = true
      }
      tx.run('INSERT INTO service_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
        [key, JSON.stringify(state), at])
      appendEvent(tx, { type: 'release.intake_' + action, payload: { revision: state.revision, actor, reason: note, page_id: pageId ?? null, paused: state.paused, deadline: state.awaiting?.deadline ?? null,
        ...(delivery ? { inbox_id: delivery.inboxId, channel: 'dsh-onebot-qq', sent_at: delivery.sentAt } : {}) } })
      return state
    })
  }
  return {
    get: () => withReadTx(db, ({ tx }) => {
      const state = read(tx)
      return { ...state, paused: state.paused || timedOut(state, Date.parse(nowAt())) }
    }),
    pause: (proof: string, reason: string, revision?: number) => change('pause', proof, reason, undefined, revision),
    resume: (proof: string, reason: string, revision?: number) => change('resume', proof, reason, undefined, revision),
    page: (proof: string, pageId: string, reason: string) => change('page', proof, reason, pageId),
    recordQqDelivery(proof: string, inboxId: string, invocationId: string, reason: string) {
      const actor = options.authenticate(proof, 'page')
      if (!actor) throw new OrchError('FORBIDDEN', '当前身份不能登记值班通知')
      if (![inboxId, invocationId].every((id) => typeof id === 'string' && id.trim() === id && id.length > 0 && id.length <= 128)) {
        throw new OrchError('PAYLOAD_SCHEMA_INVALID', '请提供对应的面板告警和宿主调用编号')
      }
      const receipt = options.lookupQqDelivery?.(inboxId, invocationId)
      if (receipt?.plugin !== 'dsh-onebot-qq' || receipt.tool !== 'qq_send_text' || receipt.sent !== true
        || typeof receipt.messageId !== 'string' || !/^-?\d{1,20}$/.test(receipt.messageId) || ['0', '-1'].includes(receipt.messageId)
        || !Number.isFinite(Date.parse(receipt.sentAt)) || Date.parse(receipt.sentAt) > Date.parse(nowAt())) {
        throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '未核实这条告警在指定 QQ 会话的真实发送回执')
      }
      return change('page', proof, reason, 'qq:' + receipt.messageId, undefined, { inboxId, sentAt: receipt.sentAt, actor })
    },
    ack: (proof: string, pageId: string, reason: string) => change('ack', proof, reason, pageId),
  }
}
