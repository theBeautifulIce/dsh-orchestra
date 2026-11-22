import { ORCHESTRA_APPROVAL_HEADING } from '../core/chat-approval-text.ts'

// DSH renders the approval reason as text in its native card's headline.
// Identify only Orchestra's structured headlines and leave the native card controls in place.
const headlineSelector = 'div[class$="_headline"]'
const structuredAttribute = 'data-orchestra-approval'

export function formatNativeOrchestraApprovalCards(document: Document) {
  const style = document.createElement('style')
  style.textContent = `[${structuredAttribute}] { white-space: pre-line; overflow-wrap: anywhere; min-width: 0; }`
  document.head.append(style)

  function mark(headline: Element) {
    const title = headline.textContent ?? ''
    headline.toggleAttribute(structuredAttribute, (title.startsWith(ORCHESTRA_APPROVAL_HEADING + '\n任务　')
      || title.startsWith(ORCHESTRA_APPROVAL_HEADING + ' · 二次确认\n任务　')))
  }

  for (const headline of document.querySelectorAll(headlineSelector)) mark(headline)
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const owner = record.target instanceof Element ? record.target : record.target.parentElement
      const title = owner?.closest(headlineSelector)
      if (title) mark(title)
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.matches(headlineSelector)) mark(node)
        for (const headline of node.querySelectorAll(headlineSelector)) mark(headline)
      }
    }
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true })
  return () => {
    observer.disconnect()
    style.remove()
    for (const headline of document.querySelectorAll(`[${structuredAttribute}]`)) headline.removeAttribute(structuredAttribute)
  }
}
