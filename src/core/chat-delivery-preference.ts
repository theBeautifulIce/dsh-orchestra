export function originalTitleKey(title: string): string {
  return title.trim().match(/^[《「“]([^》」”]+)[》」”](?:\s*(?:完整)?(?:报告正文|正文|原件))?$/u)?.[1] ?? title.trim()
}

/** Read presentation preferences from the authenticated request. They never grant access to a result. */
export function chatDeliveryPreference(sources: readonly string[]) {
  const names: string[] = []
  let linksOnly = false
  for (const source of sources) {
    for (const match of source.matchAll(/^\s*(?:\d{1,2}|[一二三四五六七八九十]+)\s*[.)）、．]\s*[《「“]([^》」”\r\n]{1,200})[》」”]/gmu))
      if (!names.includes(match[1]!)) names.push(match[1]!)
    const linked = /链接|\blinks?\b/iu.test(source)
    const concise = /简[短洁要].{0,5}(?:总结|概述|摘要|汇总)|只.{0,8}(?:摘要|链接)|(?:不要|无需|不用).{0,10}(?:粘贴|贴出|重复|展示|展开).{0,8}(?:全文|正文)|\b(?:brief|concise|short)\s+summar(?:y|ies)\b|\blinks?\s+only\b/iu.test(source)
    if (linked && concise) linksOnly = true
    const clauses = source.split(/[，,。.!！？?\n；;]/u)
    if (clauses.some(clause => /(?:不要|不用|无需)(?:提供|给出|附上)?链接|\bno links\b/iu.test(clause)
      || (!/(?:不要|无需|不用|不需要)|\b(?:not|never)\b|n't\b/iu.test(clause)
        && /(?:请|需要|要求)(?:在.{0,8}(?:聊天|会话))?(?:直接)?(?:粘贴|贴出|展示)(?:全部|完整)?正文|\bpaste the full text\b/iu.test(clause)))) linksOnly = false
  }
  return { names, linksOnly }
}
