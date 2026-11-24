/** Exact conversational acknowledgments avoid a model call without granting execution. */
const ordinary = new Set(['你好', '您好', '早上好', '下午好', '晚上好', '谢谢', '多谢', '收到', '好的', '嗯', 'hello', 'hi', 'thanks', 'thank you', 'ok', 'okay'])
export function isOrdinaryChat(text: string): boolean {
  return ordinary.has(text.trim().normalize('NFKC').toLowerCase().replace(/[.!。！]+$/u, ''))
}

/** A public command has a fixed grammar. Its body still receives semantic interpretation. */
export function orchestraCommand(text: string): string | undefined {
  return /^\/orchestra(?:\s+([\s\S]*))?$/u.exec(text.trim())?.[1]?.trim()
    ?? (text.trim() === '/orchestra' ? '' : undefined)
}

/** Existing narrow operator phrases authorize the two read-only note capabilities. */
export function explicitNotesRequest(text: string): 'notes' | 'brain_notes' | undefined {
  if (/^(?:请\s*)?(?:审阅|分类)主脑专属便条(?:$|[：:，,\s])|^(?:please\s+)?(?:review|classify)\s+(?:the\s+)?private run notes\b/iu.test(text.trim())) return 'brain_notes'
  if (/^(?:(?:请|能否|可否|帮我|麻烦你?)(?:帮我)?\s*)?(?:读(?:取|一下)?|查看|查询|列出).{0,120}(?:便条|运行注记)|^(?:please\s+)?(?:read|list|show|check)\s+.{0,120}\brun notes?\b/iu.test(text.trim())) return 'notes'
}
