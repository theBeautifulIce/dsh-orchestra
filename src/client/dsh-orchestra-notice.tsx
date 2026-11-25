import type { ReactElement } from 'react'
import { ORCHESTRA_MESSAGE_SOURCE } from '../core/dsh-message-source.ts'
import { artifactVersionKey, chatArtifactLink, chatAttentionLink, type ChatArtifactLink, type ChatAttentionLink, type PanelReceiptLocation } from '../core/receipt-location.ts'
import { ArtifactLinks, downloadChatArtifact, openChatArtifact, type ArtifactBrowser, type OpenChatArtifact } from './dsh-artifact-links.tsx'
import type { DshLocalPanelSources } from './dsh-local-panel.tsx'
import { ReceiptAction } from './receipt-action.tsx'
import type { OpenPanelReceipt } from './dsh-panel-navigation.ts'
import { COLOR, FONT_PX } from './panel/tokens.ts'

const noticeKind = 'orchestra-notice'
const slotName = 'conversation.chat.turnTail'

type Notice = { id: string; seq: number; title: string; text: string; artifacts?: ChatArtifactLink[]; attentionLinks?: ChatAttentionLink[]; final?: true }
type Event = { type: string; seq: number; surfaceOp?: unknown; data?: unknown }
type Match = { event: Event; location: unknown }
type NoticeContext = { key: string; id: string; start?: Match; state?: Notice }
type Observable<T> = { getSnapshot(): T; subscribe(listener: () => void): () => void }
type TailProps = {
  turn: { turn: number; end?: { data?: { reason?: { kind?: string } } }; data: { get(key: string): unknown } }
  useNotices(turn: string): readonly Notice[] | undefined
  openArtifact?: OpenChatArtifact
  downloadArtifact?: OpenChatArtifact
  sources?: DshLocalPanelSources
  openLocation?: OpenPanelReceipt
}

function readNotice(event: Event): Notice | undefined {
  if (event.type !== 'user/message' || event.surfaceOp !== 'append' || !event.data || typeof event.data !== 'object') return
  const data = event.data as { id?: unknown; source?: unknown; content?: unknown }
  if (!data.source || typeof data.source !== 'object' || !Array.isArray(data.content) || typeof data.id !== 'string') return
  const source = data.source as { kind?: unknown; form?: unknown; summary?: unknown; artifacts?: unknown; attentionLinks?: unknown; final?: unknown }
  if (source.kind !== ORCHESTRA_MESSAGE_SOURCE || source.form !== 'notice') return
  const text = data.content.flatMap((block: unknown) => block && typeof block === 'object'
    && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string'
    ? [(block as { text: string }).text] : []).join('\n')
  if (!text.trim()) return
  const artifacts = chatArtifactLink.array().max(50).safeParse(source.artifacts)
  const attention = chatAttentionLink.array().max(13).safeParse(source.attentionLinks)
  return { id: data.id, seq: event.seq, title: typeof source.summary === 'string' ? source.summary : 'Orchestra 任务结果', text,
    ...(artifacts.success && { artifacts: artifacts.data }), ...(attention.success && { attentionLinks: attention.data }),
    ...(source.final === true && { final: true }) }
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
      anchorSeq: context.start.event.seq, location: context.start.location,
      visibility: context.state.final || context.state.attentionLinks?.length ? 'visible' : 'hidden', data: context.state }
  },
}

/** The host only mounts turnTail after turn/end. Attention owns a visible node during the active turn. */
export function OrchestraAttentionNotice({ node, turnProcess, sources, openLocation, openArtifact, downloadArtifact }: {
  node: { data: Notice; location?: unknown }; turnProcess?: { foldable?: boolean } | null
  sources?: DshLocalPanelSources; openLocation?: OpenPanelReceipt
  openArtifact?: OpenChatArtifact; downloadArtifact?: OpenChatArtifact
}) {
  const notice = node.data
  const location = node.location as { turn?: { end?: unknown } } | undefined
  const tailOwnsLinks = Boolean(location?.turn?.end || turnProcess?.foldable)
  if (!notice.final && !notice.attentionLinks?.length) return null
  return <section aria-label={notice.title} role="status" data-orchestra-attention
    style={{ marginBlock: 12, padding: 16, border: `1px solid ${COLOR.line}`, borderRadius: 10,
      background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.body, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
    <strong>{notice.title}</strong>
    <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{notice.text.startsWith(notice.title + '\n')
      ? notice.text.slice(notice.title.length + 1) : notice.text}</div>
    {sources && notice.attentionLinks?.map(link => <div key={JSON.stringify(link.location)} style={{ marginTop: 12 }}>
      <span style={{ color: COLOR.inkMuted }}>{link.title}</span>
      <ReceiptAction location={link.location} sources={sources} openLocation={openLocation} />
    </div>)}
    {notice.final && !tailOwnsLinks && <ArtifactLinks artifacts={notice.artifacts ?? []} openArtifact={openArtifact} downloadArtifact={downloadArtifact} />}
  </section>
}

/** A closed turn must show its recorded result even when the model never produced a final answer. */
export function OrchestraNoticeTail({ turn, useNotices, openArtifact, downloadArtifact, sources, openLocation }: TailProps): ReactElement | null {
  const notices = useNotices(String(turn.turn)) ?? []
  const tail = turn.data.get('turn-tail') as { closing?: { finalNode?: { seq?: number } } | null } | undefined
  const answeredThrough = turn.end?.data?.reason?.kind === 'completed' ? tail?.closing?.finalNode?.seq ?? -1 : -1
  // Attention already owns a visible node; never duplicate it at the completed-turn tail.
  const pending = notices.filter((notice) => !notice.final && !notice.attentionLinks?.length && turn.end && notice.seq > answeredThrough)
  // The final answer may replace a fallback summary. It must never hide the actual deliverables.
  const artifacts = turn.end ? [...new Map(notices.flatMap(notice => notice.artifacts ?? [])
    .map(artifact => [artifactVersionKey(artifact.location), artifact])).values()] : []
  // After turn/end the Desktop hides process nodes in a collapsed group. The
  // tail is still visible, and opening an old receipt rechecks its ownership.
  const links = turn.end && sources ? [...new Map(notices.flatMap(notice => notice.attentionLinks ?? [])
    .map(link => [JSON.stringify(link.location), link])).values()] : []
  if (pending.length === 0 && (!turn.end || artifacts.length === 0) && !links.length) return null
  return <div data-orchestra-notice-fallback>
    {pending.map((notice) => <section key={notice.id} aria-label={notice.title} role="status"
      style={{ marginBlock: 12, padding: 16, border: `1px solid ${COLOR.line}`, borderRadius: 10,
        background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.body, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
      <strong>{notice.title}</strong>
      <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{notice.text.startsWith(notice.title + '\n')
        ? notice.text.slice(notice.title.length + 1) : notice.text}</div>
    </section>)}
    {sources && links.map(link => <div key={JSON.stringify(link.location)}>
      <span>{link.title}</span><ReceiptAction location={link.location} sources={sources} openLocation={openLocation} />
    </div>)}
    <ArtifactLinks artifacts={artifacts} openArtifact={openArtifact} downloadArtifact={downloadArtifact} />
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
    inject(slot: typeof slotName | 'conversation.chat.node', register: () => unknown): unknown
    register(slot: { name: typeof slotName | 'conversation.chat.node'; id?: string; key?: string; inject(sessionId: string): {
      sources?: DshLocalPanelSources; openLocation?: OpenPanelReceipt
      keyedHooks?: { notices(turn: string): Observable<readonly Notice[]> }
    } }, component: typeof OrchestraNoticeTail | typeof OrchestraAttentionNotice): unknown
  }
}

export type NativeOrchestraNoticeContext = { inject(names: string[], callback: (ready: Ready & ArtifactBrowser) => void): unknown }

export function registerNativeOrchestraNotices(ctx: NativeOrchestraNoticeContext,
  sources?: () => DshLocalPanelSources | undefined, openLocation?: OpenPanelReceipt) {
  let browser: ArtifactBrowser | undefined
  const openArtifact: OpenChatArtifact = (artifact, signal) => openChatArtifact(artifact, sources?.(), browser, signal)
  const downloadArtifact: OpenChatArtifact = (artifact, signal) => downloadChatArtifact(artifact, sources?.(), signal)
  ctx.inject(['slots', 'sessions', 'uiConversation'], (ready) => {
    ready.effect(() => ready.uiConversation.events.register(orchestraNoticeDefinition), 'orchestra: durable chat notices')
    const attentionProps = (sessionId: string) => ({ sources: sources?.(),
      openArtifact: async (artifact: ChatArtifactLink, signal?: AbortSignal) => {
        if (artifact.location.sessionId !== sessionId) throw new Error('此成果不属于当前会话。')
        return openArtifact(artifact, signal)
      }, downloadArtifact: async (artifact: ChatArtifactLink, signal?: AbortSignal) => {
        if (artifact.location.sessionId !== sessionId) throw new Error('此成果不属于当前会话。')
        return downloadArtifact(artifact, signal)
      }, openLocation: openLocation
      ? async (location: PanelReceiptLocation, signal?: AbortSignal) => {
        if (location.sessionId !== sessionId) throw new Error('这项待办不属于当前会话。')
        return openLocation(location, signal)
      } : undefined })
    ready.slots.inject('conversation.chat.node', () => ready.slots.register({
      name: 'conversation.chat.node', key: noticeKind, inject: attentionProps,
    }, OrchestraAttentionNotice))
    ready.slots.inject(slotName, () => ready.slots.register({ name: slotName, id: 'orchestra-notice',
      inject(sessionId) {
        const binding = ready.sessions.binding(sessionId)
        if (!binding) throw new Error('Orchestra notice has no session binding')
        const chat = ready.uiConversation.binding(binding).target('chat')
        return { ...attentionProps(sessionId), keyedHooks: { notices(turn) {
          const snapshot = chat.getSnapshot()
          if (!snapshot) throw new Error('Orchestra notice has no chat projection')
          return snapshot.nodes.turnDataSource(Number(turn), noticeKind)
        } } }
      },
    }, OrchestraNoticeTail))
  })
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (ready) => {
    ready.effect(() => {
      browser = ready
      return () => { if (browser === ready) browser = undefined }
    }, 'orchestra: native artifact browser')
  })
  return { openArtifact, downloadArtifact }
}
