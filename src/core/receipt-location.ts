import { z } from 'zod'

const id = z.string().min(1).max(256)
const scope = { workspaceId: id, sessionId: id, taskId: id, runId: id }

/**
 * 回执里唯一可信的导航目标（T16）：由服务端从受信绑定与已核验结果生成，
 * 客户端只按它重读对象，不接受模型或元数据自报的标识。
 */
export const receiptLocation = z.discriminatedUnion('kind', [
  z.strictObject({ ...scope, kind: z.literal('task') }),
  z.strictObject({ ...scope, kind: z.literal('decision'), decisionId: id }),
  z.strictObject({ ...scope, kind: z.literal('artifact'), artifactId: id, sha256: z.string().regex(/^[0-9a-f]{64}$/u) }),
])
export type ReceiptLocation = z.infer<typeof receiptLocation>
