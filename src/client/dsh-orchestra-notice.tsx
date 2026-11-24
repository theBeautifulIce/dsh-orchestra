import type { ReactElement } from 'react'
import { ORCHESTRA_MESSAGE_SOURCE } from '../core/dsh-message-source.ts'

const noticeKind = 'orchestra-notice'
const slotName = 'conversation.chat.turnTail'

type Notice = { id: string; seq: number; title: string; text: string }
type Event = { type: string; seq: number; surfaceOp?: unknown; data?: unknown }
type Match = { event: Event; location: unknown }
type NoticeContext = { key: string; id: string; start?: Match; state?: Notice }
type Observable<T> = { getSnapshot(): T; subscribe(listener: () => void): () => void }
type TailProps = {
  turn: { turn: number; end?: { data?: { reason?: { kind?: string } } }; data: { get(key: string): unknown } }
  useNotices(turn: string): readonly Notice[] | undefined
}

function readNotice(event: Event): Notice | undefined {
  if (event.type !== 'user/message' || event.surfaceOp !== 'append' || !event.data || typeof event.data !== 'object') return
  const data = event.data as { id?: unknown; source?: unknown; content?: unknown }
  if (!data.source || typeof data.source !== 'object' || !Array.isArray(data.content) || typeof data.id !== 'string') return
  const source = data.source as { kind?: unknown; form?: unknown; summary?: unknown }
  if (source.kind !== ORCHESTRA_MESSAGE_SOURCE || source.form !== 'notice') return
  const text = data.content.flatMap((block: unknown) => block && typeof block === 'object'
    && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string'
    ? [(block as { text: string }).text] : []).join('\n')
  if (!text.trim()) return
  return { id: data.id, seq: event.seq, title: typeof source.summary === 'string' ? source.summary : 'Orchestra 任务结果', text }
}

/** DSH rc.5 Conversation projection. The original notice remains the durable source. */
export const orchestraNoticeDefinition = {
  kind: noticeKind,
  target: 'chat',
  match(event: Event) {
    const notice = readNotice(event)
    return notice ? { id: notice.id, role: 'start' as const } : null
  },
  start(_context: NoticeContext, match: Match) { return readNotice(match.event)! },
  update(context: NoticeContext) { return context.state },
  buildViewNode(context: NoticeContext) {
    if (!context.state || !context.start) return null
    return { key: context.key, kind: noticeKind, id: context.id, target: 'chat',
      anchorSeq: context.start.event.seq, location: context.start.location, visibility: 'hidden', data: context.state }
  },
}

/** A closed turn must show its recorded result even when the model never produced a final answer. */
export function OrchestraNoticeTail({ turn, useNotices }: TailProps): ReactElement | null {
  const notices = useNotices(String(turn.turn)) ?? []
  const tail = turn.data.get('turn-tail') as { closing?: { finalNode?: { seq?: number } } | null } | undefined
  const answeredThrough = turn.end?.data?.reason?.kind === 'completed' ? tail?.closing?.finalNode?.seq ?? -1 : -1
  const pending = notices.filter((notice) => notice.seq > answeredThrough)
  if (!turn.end || pending.length === 0) return null
  return <div data-orchestra-notice-fallback>
    {pending.map((notice) => <section key={notice.id} aria-label={notice.title} role="status"
      style={{ marginBlock: 12, padding: 16, border: '1px solid #d8dee8', borderRadius: 10, overflowWrap: 'anywhere' }}>
      <strong>{notice.title}</strong>
      <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{notice.text.startsWith(notice.title + '\n')
        ? notice.text.slice(notice.title.length + 1) : notice.text}</div>
    </section>)}
  </div>
}

type Ready = {
  effect(register: () => (() => void) | unknown, label: string): unknown
  sessions: { binding(sessionId: string): unknown }
  uiConversation: {
    events: { register(definition: typeof orchestraNoticeDefinition): () => void }
    binding(binding: unknown): { target(target: string): { getSnapshot(): {
      nodes: { turnDataSource(turn: number, kind: string): Observable<readonly Notice[]> }
    } | undefined } }
  }
  slots: {
    inject(slot: typeof slotName, register: () => unknown): unknown
    register(slot: { name: typeof slotName; id: string; inject(sessionId: string): {
      keyedHooks: { notices(turn: string): Observable<readonly Notice[]> }
    } }, component: typeof OrchestraNoticeTail): unknown
  }
}

export type NativeOrchestraNoticeContext = { inject(names: string[], callback: (ready: Ready) => void): unknown }

export function registerNativeOrchestraNotices(ctx: NativeOrchestraNoticeContext): void {
  ctx.inject(['slots', 'sessions', 'uiConversation'], (ready) => {
    ready.effect(() => ready.uiConversation.events.register(orchestraNoticeDefinition), 'orchestra: durable chat notices')
    ready.slots.inject(slotName, () => ready.slots.register({ name: slotName, id: 'orchestra-notice',
      inject(sessionId) {
        const binding = ready.sessions.binding(sessionId)
        if (!binding) throw new Error('Orchestra notice has no session binding')
        const chat = ready.uiConversation.binding(binding).target('chat')
        return { keyedHooks: { notices(turn) {
          const snapshot = chat.getSnapshot()
          if (!snapshot) throw new Error('Orchestra notice has no chat projection')
          return snapshot.nodes.turnDataSource(Number(turn), noticeKind)
        } } }
      },
    }, OrchestraNoticeTail))
  })
}
