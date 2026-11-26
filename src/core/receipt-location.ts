import { z } from 'zod'

const id = z.string().min(1).max(256)
const scope = { workspaceId: id, sessionId: id, taskId: id, runId: id }

export const artifactReceiptLocation = z.strictObject({ ...scope, kind: z.literal('artifact'),
  artifactId: id, sha256: z.string().regex(/^[0-9a-f]{64}$/u) })
export type ArtifactReceiptLocation = z.infer<typeof artifactReceiptLocation>

/** Durable chat links identify one recorded version. Browser access URLs are never persisted. */
export const chatArtifactLink = z.strictObject({
  title: z.string().min(1).max(500), fileName: z.string().min(1).max(500), location: artifactReceiptLocation,
})
export type ChatArtifactLink = z.infer<typeof chatArtifactLink>

/** A bounded quotation for the operator. It cannot supply a mailbox state or authorize a read. */
export const chatResultExcerpts = z.array(z.strictObject({
  title: z.string().min(1).max(500), text: z.string().max(4800), truncated: z.boolean(),
})).max(20)
export type ChatResultExcerpt = z.infer<typeof chatResultExcerpts>[number]

export function artifactVersionKey(location: ArtifactReceiptLocation): string {
  return JSON.stringify([location.workspaceId, location.sessionId, location.taskId,
    location.runId, location.artifactId, location.sha256])
}

/**
 * 回执里唯一可信的导航目标（T16）：由服务端从受信绑定与已核验结果生成，
 * 客户端只按它重读对象，不接受模型或元数据自报的标识。
 */
export const panelReceiptLocation = z.discriminatedUnion('kind', [
  z.strictObject({ ...scope, kind: z.literal('task') }),
  z.strictObject({ ...scope, kind: z.literal('decision'), decisionId: id }),
])
export type PanelReceiptLocation = z.infer<typeof panelReceiptLocation>

export const receiptLocation = z.discriminatedUnion('kind', [
  ...panelReceiptLocation.options,
  artifactReceiptLocation,
])
export type ReceiptLocation = z.infer<typeof receiptLocation>

/** A read-only route to an item needing attention. It carries no authorization or resolution. */
export const chatAttentionLink = z.strictObject({
  title: z.string().min(1).max(500), location: panelReceiptLocation,
})
export type ChatAttentionLink = z.infer<typeof chatAttentionLink>
