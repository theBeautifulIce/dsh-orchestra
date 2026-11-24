import type { ReactElement } from 'react'
import { DshDeliveryReviewCard, type DshDeliveryReview } from './dsh-delivery-review-card.tsx'
import { isDshLocalShell, type DshLocalPanelSources } from './dsh-local-panel.tsx'
import { ReceiptAction } from './receipt-action.tsx'
import { chatArtifactLink, receiptLocation } from '../core/receipt-location.ts'
import { ArtifactLinks, type OpenChatArtifact } from './dsh-artifact-links.tsx'

const slotName = 'tool.call.toolview'
const toolName = 'orchestra_task'

// Desktop's renderer spreads the slot owner directly onto the registered row.
type ToolOwner =
  | { phase: 'preparing' | 'start' }
  | { phase: 'result'; block: { isError?: boolean; meta?: unknown } }
type ToolRow = (owner: ToolOwner) => ReactElement

export type NativeOrchestraToolViewContext = {
  effect(register: () => Generator<unknown, void, unknown>, label: string): unknown
  slots: {
    inject(slot: typeof slotName, register: () => unknown): unknown
    register(slot: { name: typeof slotName; key: typeof toolName }, row: ToolRow): unknown
  }
}

function summaryOf(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object' || !Object.hasOwn(meta, 'summary')) return undefined
  const { summary } = meta as { summary: unknown }
  return typeof summary === 'string' && summary.trim() ? summary.trim() : undefined
}

function OrchestraToolRow(owner: ToolOwner, sources?: DshLocalPanelSources, openArtifact?: OpenChatArtifact, downloadArtifact?: OpenChatArtifact) {
  const result = owner.phase === 'result' ? owner.block : undefined
  const isError = result?.isError === true
  const review = result?.meta && typeof result.meta === 'object'
    ? (result.meta as { deliveryReview?: DshDeliveryReview }).deliveryReview : undefined
  if (!isError && review && Array.isArray(review.reviews) && review.reviews.length && sources
    && typeof window !== 'undefined' && isDshLocalShell(window.location.href)) {
    return <DshDeliveryReviewCard scope={review} sources={sources} />
  }
  const text = result ? summaryOf(result.meta) ?? (isError
    ? 'Orchestra 未能完成这次操作。请在 Orchestra 面板确认任务状态后再试。'
    : '请在 Orchestra 面板查看这次操作的结果。')
    : 'Orchestra 正在处理这次操作…'
  // 服务端签发过定位对象时给一个只读入口；没有就保持原纯文字路径（T16）。
  const target = result?.meta && typeof result.meta === 'object' && 'location' in result.meta
    ? receiptLocation.safeParse((result.meta as { location?: unknown }).location) : undefined
  const linkable = !isError && target?.success && sources && typeof window !== 'undefined' && isDshLocalShell(window.location.href)
  const artifacts = chatArtifactLink.array().max(50).safeParse(result?.meta && typeof result.meta === 'object'
    ? (result.meta as { artifactLinks?: unknown }).artifactLinks : undefined)
  return <>
    <p role={isError ? 'alert' : 'status'} style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</p>
    {linkable && <ReceiptAction location={target.data} sources={sources} />}
    {!isError && artifacts.success && <ArtifactLinks artifacts={artifacts.data} openArtifact={openArtifact} downloadArtifact={downloadArtifact} />}
  </>
}

export function registerNativeOrchestraToolView(ctx: NativeOrchestraToolViewContext,
  reviewSources?: () => DshLocalPanelSources | undefined, openArtifact?: OpenChatArtifact, downloadArtifact?: OpenChatArtifact) {
  return ctx.effect(function* () {
    yield ctx.slots.inject(slotName, () => ctx.slots.register({ name: slotName, key: toolName }, (owner) =>
      OrchestraToolRow(owner, reviewSources?.(), openArtifact, downloadArtifact)))
  }, 'orchestra: native chat tool row')
}
