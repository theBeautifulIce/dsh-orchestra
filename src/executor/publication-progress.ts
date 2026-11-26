import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'

export type PublicationTargets = { texts: { index: number; title: string; fileName: string }[]; files: string[] }
type ReceiptMessage = Extract<ReturnType<Session['deriveMessages']>[number], { role: 'tool' }>

/** Only a host result actually committed to this child can retire a publication slot. */
export function publicationProgress(loadTargets: () => PublicationTargets | null) {
  const issued = new Map<string, { text: string; target: string | number }>()
  const confirmed = new Set<string | number>()
  let plan: PublicationTargets | null | undefined
  let applied = 0
  return {
    allowsFile(name: string) { return !plan || plan.files.includes(name) },
    issued(callId: string, target: string | number, receipt: unknown, text: string) {
      if (plan === null || !receipt || typeof receipt !== 'object' || !('publication_status' in receipt)
        || receipt.publication_status !== 'registered' || !('artifact_id' in receipt) || typeof receipt.artifact_id !== 'string'
        || !('sha256' in receipt) || typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256)) return
      const matches = typeof target === 'number' ? 'deliverable_index' in receipt && receipt.deliverable_index === target
        : 'file_name' in receipt && receipt.file_name === target
      if (matches) issued.set(callId, { target, text })
    },
    observe(message: ReceiptMessage) {
      const receipt = issued.get(message.toolCallId)
      if (!receipt) return
      issued.delete(message.toolCallId)
      const [content] = message.content
      if (!message.isError && message.content.length === 1 && content?.type === 'text' && content.text === receipt.text) {
        confirmed.add(receipt.target)
      }
    },
    finishStep(): PublicationTargets | undefined {
      // All calls for this step have settled. A lost or replaced receipt leaves its slot open for replay.
      issued.clear()
      if (!confirmed.size || confirmed.size === applied) return
      if (plan === undefined) {
        // A temporarily unreadable plan cannot invalidate a successful registration or its normal retry path.
        try { plan = loadTargets() } catch { return }
      }
      applied = confirmed.size
      if (!plan) return
      const texts = plan.texts.filter(item => !confirmed.has(item.index))
      const files = plan.files.filter(name => !confirmed.has(name))
      if (texts.length === plan.texts.length && files.length === plan.files.length) return
      return { texts, files }
    },
  }
}

export function reworkToolPresentation(remaining?: PublicationTargets): Pick<ToolDefinition, 'parameters' | 'description'> {
  const textAllowed = !remaining || remaining.texts.length > 0
  const fileAllowed = !remaining || remaining.files.length > 0
  // file_name also confirms the approved title or internal name of a text slot on older clients.
  const names = remaining && [...new Set([...remaining.files, ...remaining.texts.flatMap(item => [item.title, item.fileName])])]
  return {
    description: [
      ...(fileAllowed ? ['登记文件(publish，传 file_name 和 text)。'] : []),
      ...(textAllowed ? ['登记会话正文(publish_text_result，传 deliverable_index 和 text，标题从计划取得)。'] : []),
      ...(textAllowed || fileAllowed ? ['登记可省略 operation_id。'] : []),
      ...(remaining ? ['已登记原件保留当前版本。新发现写入简短报告，需要更正原件时走正式返工。'] : []),
      '读取上游版本(read)，查询反馈(inbox/get)，提出修改(request)，验收修订(accept/request_changes)。其他写操作复用同一 UUIDv7。',
    ].join(''),
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: [...(fileAllowed ? ['publish'] : []), ...(textAllowed ? ['publish_text_result'] : []),
        'read','read_material','inbox','get','request','accept','request_changes','escalate'] },
      operation_id: { type: 'string' }, run_id: { type: 'string' }, target_node_run_id: { type: 'string' },
      source_artifact_id: { type: 'string' }, source_artifact_hash: { type: 'string' }, expected_revision: { type: 'integer' },
      reason: { type: 'string' }, expected_result: { type: 'string' }, preserve_requirements: { type: 'array', items: { type: 'string' } },
      suggested_scope: { type: 'string' }, evidence_ids: { type: 'array', items: { type: 'string' } }, verification_request_id: { type: 'string' },
      file_manifest: { type: 'object', properties: {
        originals: { type: 'array', items: { type: 'object', properties: {
          artifact_id: { type: 'string' }, sha256: { type: 'string' }, file_name: { type: 'string' },
          action: { type: 'string', enum: ['revise','keep','remove'] },
        }, required: ['artifact_id','sha256','file_name','action'], additionalProperties: false } },
        attachments: { type: 'array', items: { type: 'string' } },
      }, required: ['originals','attachments'], additionalProperties: false },
      request_id: { type: 'string' }, artifact_id: { type: 'string' }, artifact_hash: { type: 'string' },
      material_id: { type: 'string' }, digest: { type: 'string' },
      ...(textAllowed ? { deliverable_index: { type: 'integer', minimum: 0, maximum: 19, ...(remaining && { enum: remaining.texts.map(item => item.index) }) } } : {}),
      ...(fileAllowed || textAllowed ? {
        file_name: { type: 'string', ...(names && { enum: names }), ...(remaining && textAllowed && {
          description: (fileAllowed ? 'publish 的剩余文件名为 ' + JSON.stringify(remaining.files) + '。' : '')
            + 'publish_text_result 可省略此字段，若提供则须与该编号的正式标题或内部文件名一致。',
        }) }, text: { type: 'string' },
      } : {}),
      offset: { type: 'integer' }, note: { type: 'string' },
    }, required: ['action'], additionalProperties: false },
  }
}
