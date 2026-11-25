import { chatArtifactLink, type ArtifactReceiptLocation, type ChatArtifactLink } from '../core/receipt-location.ts'
import { chatDeliveryPreference, originalTitleKey as titleKey } from '../core/chat-delivery-preference.ts'
import type { Db } from '../infra/sqlite/driver.ts'
import { getArtifact } from './queries/artifacts.ts'
import { withReadTx } from './queries/read-tx.ts'
import type { RunDeliveryCheck } from './queries/runs.ts'
import { readApprovedTaskPlanForRun } from './task-planning.ts'

type Scope = Pick<ArtifactReceiptLocation, 'workspaceId' | 'sessionId'>
type ResultSelector = { ordinal: number } | { title: string }
type ResultRequest = 'single' | 'all' | 'unclear' | ResultSelector[]

/** A presentation preference from the human sources of the confirmed plan. It grants no read authority. */
export function chatResultPresentation(db: Db, runId: string) {
  const brief = withReadTx(db, ({ tx }) => readApprovedTaskPlanForRun(tx, runId)?.brief)
  const sources = brief?.requirements_contract?.sources.map(source => source.text) ?? (brief ? [brief.goal] : [])
  return chatDeliveryPreference(sources)
}

/** This manifest is shared by the conversation links and subsequent ordinal reads. */
export function acceptedChatResults(db: Db, run: { run_id: string; task_id: string; delivery_checks: RunDeliveryCheck[] },
  scope: Scope, requestedNames: readonly string[], linksOnly = false): ChatArtifactLink[] {
  const rank = (check: RunDeliveryCheck) => requestedNames.indexOf(titleKey(check.title ?? check.file_name ?? ''))
  const sorted = run.delivery_checks.filter(check => check.outcome === 'passed' && check.artifact_id
    && (check.kind === 'artifact' || check.kind === 'chat/text_result')).sort((a, b) => {
    const left = rank(a), right = rank(b)
    return (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right)
      || (a.item_index ?? Infinity) - (b.item_index ?? Infinity)
  })
  const seen = new Set<string>()
  const links: ChatArtifactLink[] = []
  for (const check of sorted) {
    const id = check.artifact_id!
    if (seen.has(id) || (linksOnly && requestedNames.length && rank(check) < 0
      && /(?:总结|汇总|摘要).{0,12}(?:链接|清单)|summary.{0,20}links/iu.test(check.title ?? ''))) continue
    try {
      const item = getArtifact(db, id)
      if (item.expired || item.run_id !== run.run_id || !item.file_name || (check.sha256 && check.sha256 !== item.sha256)) continue
      const link = chatArtifactLink.safeParse({ title: requestedNames[rank(check)] ?? (check.title || item.file_name), fileName: item.file_name,
        location: { kind: 'artifact', workspaceId: scope.workspaceId, sessionId: scope.sessionId,
          taskId: run.task_id, runId: run.run_id, artifactId: id, sha256: item.sha256 } })
      if (link.success) { links.push(link.data); seen.add(id) }
    } catch { /* Continue listing the other readable versions. */ }
  }
  return links
}

function ordinal(text: string): number {
  if (/^\d+$/u.test(text)) return Number(text)
  const digits = '零一二三四五六七八九'
  const parts = text.replace('两', '二').split('十')
  return parts.length === 1 ? digits.indexOf(parts[0]!) : (parts[0] ? digits.indexOf(parts[0]) : 1) * 10 + (parts[1] ? digits.indexOf(parts[1]) : 0)
}

const readVerb = /^(?:(?:请|帮我|麻烦)(?:帮我)?\s*)?(?:读取|读一下|查看|查阅|打开)|^(?:please\s+)?(?:read|show|open)\b/iu
const hostLocation = /工作区|本地|目录|文件夹|网页|网址|https?:\/\/|file:\/\/|[a-z]:[\\/]|(?:^|\s)\.{1,2}[\\/]|\b(?:workspace|local file|folder|website)\b/iu
function readSubject(text: string) {
  return text.trim().split(/[。！？\n!?]|\.\s|[,，；;]\s*(?:请|告诉|说明|并|再|不要|不用|无需|then\b|tell\b|and tell\b)/iu, 1)[0] ?? ''
}

/** A direct host-resource read remains available even when automatic dispatch is enabled. */
export function isHostResourceRead(text: string): boolean {
  const subject = readSubject(text)
  return readVerb.test(subject) && hostLocation.test(subject)
    && !/(?:执行|创建|启动|安排|派发|编排)(?:.{0,6})(?:任务|代理)|\b(?:start|create|run) (?:a |an )?(?:task|agent|workflow)\b/iu.test(text)
}

/** Route an explicit read of one previously delivered original before task admission. */
export function previousResultRequest(text: string): ResultRequest | undefined {
  const clause = readSubject(text)
  if (!readVerb.test(clause)
    || !/(?:刚才|刚刚|之前|此前|上次|上一|刚交付|已交付|已登记|原件|原文)|\b(?:previous|last|original|delivered)\b/iu.test(clause)) return
  if (!/[《「“]|(?:报告|成果|产物|原件|原文|正文|文档|文件|第.{1,4}[份篇])|\b(?:reports?|artifacts?|results?|originals?|documents?|files?)\b/iu.test(clause)) return
  const subject = clause
  if (hostLocation.test(subject)) return
  // A previously mentioned host file is not necessarily an Orchestra artifact.
  // Claim the request only when the operator refers to delivery or identifies a report.
  if (!/成果|产物|原件|交付|登记|第.{1,6}[份篇].{0,4}报告|[《「“][^》」”]+[》」”].{0,3}报告|\b(?:artifact|artifacts|delivered|originals?|(?:first|second|third|last) report)\b/iu.test(subject)) return
  const named = [...subject.matchAll(/[《「“]([^》」”\r\n]{1,200})[》」”]/gu)]
  if (named.length) return named.map(match => ({ title: match[1]! }))
  // With an abbreviated range, ask for names rather than selecting the wrong end.
  if (/[一二两三四五六七八九十\d]\s*[、和与及到至]\s*第?[一二两三四五六七八九十\d]/u.test(subject)) return 'unclear'
  const numbers = [...subject.matchAll(/第\s*([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*[份篇项个]/gu)]
  if (numbers.length) return numbers.map(match => ({ ordinal: ordinal(match[1]!) }))
  const english = [...subject.matchAll(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))\b/giu)]
  if (english.length) return english.map(match => {
    const token = match[1]!.toLowerCase()
    return { ordinal: /^\d/u.test(token) ? parseInt(token, 10) : ['first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth'].indexOf(token) + 1 }
  })
  return /(?:全部|所有|每一份|每份)|\ball\b/iu.test(subject) ? 'all' : 'single'
}

export function selectChatResults(links: ChatArtifactLink[], request: ResultRequest, names: readonly string[]) {
  if (request === 'unclear' || request === 'single' && (links.length !== 1 || names.length > 1)) return []
  if (request === 'single') return links
  const selectors = request === 'all' ? names.map(title => ({ title })) : request
  if (request === 'all' && !selectors.length) return links
  const found = new Set<ChatArtifactLink>()
  for (const selector of selectors) {
    const title = 'title' in selector ? selector.title : names[selector.ordinal - 1]
    if (!title) return []
    const matches = links.filter(link => titleKey(link.title) === titleKey(title) || link.fileName === title)
    if (matches.length !== 1) return []
    found.add(matches[0]!)
  }
  return [...found]
}
