// 流程草稿编辑屏：只改草稿；保存与发布都走控制面命令，结果一律凭回执确认。
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../api/client.ts'
import type { WorkflowView } from '../api/types.ts'
import type {
  CommandValidationIssue,
  WorkflowCommandOutcome,
  WorkflowCommandsApi,
} from '../api/workflow-commands.ts'
import { COLOR, FONT_PX } from './tokens.ts'

export type WorkflowEditorProps = {
  commands: WorkflowCommandsApi
  workflow: WorkflowView
  onRefresh: () => void
}

// 规格 8.5 行 657：画布与智能体共用同一份定义、同一套 workflow.update 命令。
const DEFINITION_NOTE = '画布和智能体改的是同一份定义，保存都走 workflow.update'
const CONFLICT_TEXT = '草稿已被别的修订改动，这次改动没有生效。你的草稿还在，请重新加载后再保存。'

type Busy = 'opening' | 'saving' | 'publishing' | null

type ReceiptState = {
  title: string
  summary: string
  outcome: WorkflowCommandOutcome<unknown>
}

export function WorkflowEditor({ commands, workflow, onRefresh }: WorkflowEditorProps) {
  const draft = workflow.draft
  const draftRevision = draft?.revision ?? null
  const definitionRef = useRef<unknown>(null)
  definitionRef.current = draft?.definition ?? null
  const syncedRef = useRef<number | null>(null)

  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [busy, setBusy] = useState<Busy>(null)
  const [receipt, setReceipt] = useState<ReceiptState | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [structural, setStructural] = useState<CommandValidationIssue[]>([])
  const [quality, setQuality] = useState<CommandValidationIssue[]>([])
  const [parseError, setParseError] = useState<string | null>(null)
  const [note, setNote] = useState('')

  // 只盯草稿修订号：修订变了才重置编辑区；用户改过就只提示冲突，绝不覆盖手里的草稿。
  useEffect(() => {
    if (draftRevision === null) {
      dirtyRef.current = false
      setDirty(false)
      syncedRef.current = null
      setText('')
      return
    }
    if (draftRevision === syncedRef.current) return
    if (dirtyRef.current) {
      setConflict(CONFLICT_TEXT)
      return
    }
    dirtyRef.current = false
    setDirty(false)
    syncedRef.current = draftRevision
    setText(formatDefinition(definitionRef.current))
  }, [draftRevision])

  const structuralIssues = useMemo(
    () => mergeIssues(workflow.validation.errors as CommandValidationIssue[], structural),
    [workflow.validation.errors, structural],
  )
  const qualityIssues = useMemo(
    () => mergeIssues(workflow.validation.warnings as CommandValidationIssue[], quality),
    [workflow.validation.warnings, quality],
  )
  const changes = useMemo(
    () => describeChanges(workflow.current?.definition ?? null, draft?.definition ?? null),
    [workflow.current, draft],
  )
  const targetVersion = (workflow.workflow.current_version ?? 0) + 1
  const publishBlocked = structuralIssues.length > 0

  function markDirty(value: string) {
    dirtyRef.current = true
    setDirty(true)
    setText(value)
    setParseError(null)
  }

  function parseDefinition(): { ok: true; value: unknown } | { ok: false; message: string } {
    const trimmed = text.trim()
    if (trimmed === '') return { ok: false, message: '流程定义不能为空' }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'JSON 解析失败' }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: '流程定义必须是一个 JSON 对象' }
    }
    return { ok: true, value: parsed }
  }

  function reportError(error: unknown) {
    if (!(error instanceof ApiError)) {
      setCommandError('命令失败：未知的错误')
      return
    }
    const details = error.details as { errors?: CommandValidationIssue[] } | undefined
    const issues = Array.isArray(details?.errors) ? details.errors : []
    if (
      error.code === 'WORKFLOW_REVISION_CONFLICT'
      || error.code === 'WORKFLOW_VERSION_CONFLICT'
      || error.code === 'WORKFLOW_DRAFT_NOT_OPEN'
    ) {
      setConflict(`${CONFLICT_TEXT}（${error.code}）`)
      return
    }
    // 结构性问题进结构校验块；质量意见只来自保存成功的 hints，不阻断保存。
    if (issues.length > 0) setStructural(issues)
    setCommandError(`${error.code}：${error.message}`)
  }

  async function save() {
    if (!draft || busy !== null) return
    const parsed = parseDefinition()
    if (!parsed.ok) {
      setParseError(parsed.message)
      return
    }
    setBusy('saving')
    setConflict(null)
    setCommandError(null)
    setStructural([])
    try {
      const outcome = await commands.updateWorkflowDraft({
        workflow_id: workflow.workflow.workflow_id,
        revision: draft.revision,
        definition: parsed.value,
      })
      dirtyRef.current = false
      setDirty(false)
      syncedRef.current = outcome.result.revision
      setQuality(outcome.result.validation?.errors ?? [])
      setReceipt({
        title: '保存',
        summary: `新修订 ${outcome.result.revision}；${outcome.result.changed ? '定义已更新' : '定义没有变化'}`,
        outcome,
      })
      onRefresh()
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(null)
    }
  }

  async function publish() {
    if (!draft || busy !== null) return
    const trimmedNote = note.trim()
    if (trimmedNote.length < 1 || trimmedNote.length > 500) {
      setCommandError('发布说明要写 1–500 字')
      return
    }
    setBusy('publishing')
    setConflict(null)
    setCommandError(null)
    try {
      const outcome = await commands.publishWorkflow({
        workflow_id: workflow.workflow.workflow_id,
        revision: draft.revision,
        base_version: workflow.workflow.current_version ?? 0,
        publish_note: trimmedNote,
      })
      setNote('')
      setReceipt({
        title: '发布',
        summary: `已发布 v${outcome.result.version}`,
        outcome,
      })
      onRefresh()
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(null)
    }
  }

  async function openDraft() {
    if (busy !== null) return
    setBusy('opening')
    setConflict(null)
    setCommandError(null)
    try {
      const outcome = await commands.openWorkflowDraft({
        workflow_id: workflow.workflow.workflow_id,
        base_version: workflow.workflow.current_version ?? 0,
      })
      setReceipt({
        title: '打开草稿',
        summary: `草稿修订 ${outcome.result.revision}`,
        outcome,
      })
      onRefresh()
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(null)
    }
  }

  function reloadDraft() {
    dirtyRef.current = false
    setDirty(false)
    syncedRef.current = null
    setConflict(null)
    onRefresh()
  }

  return <section aria-labelledby="workflow-editor-title" style={cardStyle}>
    <h2 id="workflow-editor-title" style={sectionTitleStyle}>草稿编辑</h2>
    {draft === null ? (
      <div>
        <p style={mutedStyle}>当前没有未发布草稿。</p>
        <button type="button" style={buttonStyle} disabled={busy !== null} onClick={() => { void openDraft() }}>打开草稿</button>
      </div>
    ) : (
      <div>
        <p style={mutedStyle}>
          草稿修订 {draft.revision}；基线 {draft.based_on_version === null ? '尚未发布' : `v${draft.based_on_version}`}
          {draft.definition_hash ? `；定义摘要 ${draft.definition_hash}` : ''}
        </p>
        <label htmlFor="workflow-definition-editor" style={labelStyle}>流程定义 JSON</label>
        <textarea
          id="workflow-definition-editor"
          style={editorStyle}
          rows={16}
          value={text}
          onChange={(event) => markDirty(event.target.value)}
        />
        <p style={mutedStyle}>{DEFINITION_NOTE}</p>
        {parseError && <p role="alert" style={errorTextStyle}>定义 JSON 解析失败：{parseError}</p>}
        <button type="button" style={buttonStyle} disabled={busy !== null} onClick={() => { void save() }}>保存草稿</button>
        {dirty && <p style={mutedStyle}>有未保存的改动。</p>}
      </div>
    )}
    <ValidationGroups title="结构校验" issues={structuralIssues} tone="error" emptyText="结构校验没有发现问题。" />
    <ValidationGroups title="计划质量意见" issues={qualityIssues} tone="warning" emptyText="计划质量意见：没有项目。" />
    {draft !== null && (
      <div style={{ marginTop: 18 }}>
        <h3 style={sectionTitleStyle}>发布</h3>
        <PublishConfirm
          targetVersion={targetVersion}
          changes={changes.lines}
          addsIrreversible={changes.addsIrreversible}
          affectsOnlyNewRuns
        />
        <label htmlFor="workflow-publish-note" style={labelStyle}>发布说明</label>
        <input
          id="workflow-publish-note"
          style={inputStyle}
          value={note}
          placeholder="这次发布改了什么"
          onChange={(event) => setNote(event.target.value)}
        />
        {publishBlocked && <p style={mutedStyle}>有结构错误时发布按钮不可点。</p>}
        <button
          type="button"
          style={buttonStyle}
          disabled={busy !== null || publishBlocked}
          onClick={() => { void publish() }}
        >确认发布</button>
      </div>
    )}
    {conflict && (
      <div role="alert" style={conflictStyle}>
        <span>{conflict}</span>
        <button type="button" style={buttonStyle} onClick={reloadDraft}>重新加载</button>
      </div>
    )}
    {commandError && <p role="alert" style={errorTextStyle}>{commandError}</p>}
    {receipt && (
      <div style={receiptStyle}>
        <h3 style={sectionTitleStyle}>{receipt.title}回执</h3>
        <p style={mutedStyle}>{receipt.summary}</p>
        <dl style={detailGridStyle}>
          <dt>operation_id</dt><dd>{receipt.outcome.operation_id}</dd>
          <dt>kind</dt><dd>{receipt.outcome.kind}</dd>
          <dt>回执状态</dt><dd>{receipt.outcome.receipt?.status ?? '未取到回执'}</dd>
          <dt>重放</dt><dd>{receipt.outcome.replayed ? '是（同一 operation_id 的原回执）' : '否'}</dd>
        </dl>
      </div>
    )}
  </section>
}

export type ValidationGroup = {
  kind: 'node' | 'edge' | 'workflow'
  items: Array<{ id: string; message: string }>
}

const GROUP_LABEL: Record<ValidationGroup['kind'], string> = {
  node: '节点',
  edge: '连线',
  workflow: '整体',
}

/** 检查面板按节点与连线分组（规格 8.5 行 657）。 */
export function groupIssues(issues: CommandValidationIssue[]): ValidationGroup[] {
  const node: ValidationGroup = { kind: 'node', items: [] }
  const edge: ValidationGroup = { kind: 'edge', items: [] }
  const workflow: ValidationGroup = { kind: 'workflow', items: [] }
  for (const issue of issues) {
    const item = { id: issue.path || '流程', message: `${issue.code}：${issue.message}` }
    if (issue.path.startsWith('/nodes')) node.items.push(item)
    else if (issue.path.startsWith('/edges')) edge.items.push(item)
    else workflow.items.push(item)
  }
  return [node, edge, workflow].filter((group) => group.items.length > 0)
}

export function ValidationGroups({
  title,
  issues,
  tone,
  emptyText,
}: {
  title: string
  issues: CommandValidationIssue[]
  tone: 'error' | 'warning'
  emptyText: string
}) {
  const groups = groupIssues(issues)
  return <div data-validation-group={title} style={{ marginTop: 16 }}>
    <h3 style={{ ...sectionTitleStyle, color: tone === 'error' ? COLOR.danger : COLOR.warning }}>{title}（{issues.length}）</h3>
    {issues.length === 0 && <p style={mutedStyle}>{emptyText}</p>}
    {groups.map((group) => (
      <div key={group.kind}>
        <h4 style={groupTitleStyle}>{GROUP_LABEL[group.kind]}（{group.items.length}）</h4>
        <ul>{group.items.map((item, index) => <li key={`${item.id}-${index}`}><strong>{item.id}</strong> · {item.message}</li>)}</ul>
      </div>
    ))}
  </div>
}

/** 发布确认写四件事：目标版本、改动、是否新增不可逆节点、只影响之后新建的 run。 */
export function PublishConfirm({
  targetVersion,
  changes,
  addsIrreversible,
  affectsOnlyNewRuns,
}: {
  targetVersion: number
  changes: string[]
  addsIrreversible: boolean
  affectsOnlyNewRuns: boolean
}) {
  return <div style={confirmStyle}>
    <p>发布到 v{targetVersion}</p>
    <ul>{changes.map((change) => <li key={change}>{change}</li>)}</ul>
    <p>{addsIrreversible ? '这次新增了不可逆节点' : '这次没有新增不可逆节点'}</p>
    <p>{affectsOnlyNewRuns ? '只影响之后新建的 run' : '会影响在途的 run'}</p>
  </div>
}

function formatDefinition(definition: unknown): string {
  if (definition === null || definition === undefined) return ''
  return JSON.stringify(definition, null, 2)
}

function mergeIssues(
  base: CommandValidationIssue[],
  extra: CommandValidationIssue[],
): CommandValidationIssue[] {
  const seen = new Set<string>()
  const merged: CommandValidationIssue[] = []
  for (const issue of [...base, ...extra]) {
    const key = `${issue.path}|${issue.code}|${issue.message}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(issue)
  }
  return merged
}

type NodeSummary = { node_id: string; irreversible: boolean; fingerprint: string }

function readNodes(definition: unknown): NodeSummary[] {
  if (!definition || typeof definition !== 'object') return []
  const nodes = (definition as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return []
  const out: NodeSummary[] = []
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue
    const node = raw as Record<string, unknown>
    out.push({
      node_id: typeof node.node_id === 'string' ? node.node_id : '',
      irreversible: declaresIrreversible(node),
      fingerprint: JSON.stringify(node),
    })
  }
  return out
}

/** 不可逆按节点契约里的声明算：contract/config 的 side_effect_policy = irreversible。 */
function declaresIrreversible(node: Record<string, unknown>): boolean {
  const contract = node.contract && typeof node.contract === 'object'
    ? (node.contract as Record<string, unknown>)
    : {}
  const config = node.config && typeof node.config === 'object'
    ? (node.config as Record<string, unknown>)
    : {}
  const declared = contract.side_effect_policy ?? config.side_effect_policy
  return declared === 'irreversible'
}

function describeChanges(
  published: unknown,
  draft: unknown,
): { lines: string[]; addsIrreversible: boolean } {
  const before = readNodes(published)
  const after = readNodes(draft)
  const beforeById = new Map(before.map((node) => [node.node_id, node]))
  const afterById = new Map(after.map((node) => [node.node_id, node]))
  const lines: string[] = []
  let addsIrreversible = false
  for (const node of after) {
    const previous = beforeById.get(node.node_id)
    if (!previous) {
      lines.push(`新增节点 ${node.node_id}`)
      if (node.irreversible) addsIrreversible = true
    } else if (previous.fingerprint !== node.fingerprint) {
      lines.push(`修改节点 ${node.node_id}`)
      if (node.irreversible && !previous.irreversible) addsIrreversible = true
    }
  }
  for (const node of before) {
    if (!afterById.has(node.node_id)) lines.push(`删除节点 ${node.node_id}`)
  }
  if (lines.length === 0) lines.push('定义没有变化')
  return { lines, addsIrreversible }
}

const cardStyle = { minWidth: 0, padding: 18, border: `1px solid ${COLOR.line}`, borderRadius: 9, background: COLOR.surface } as const
const sectionTitleStyle = { margin: 0, fontSize: 16 } as const
const groupTitleStyle = { margin: '10px 0 4px', fontSize: 14 } as const
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body } as const
const labelStyle = { display: 'block', margin: '12px 0 4px', fontSize: FONT_PX.body } as const
const editorStyle = {
  width: '100%',
  minHeight: 220,
  padding: 12,
  borderRadius: 8,
  border: `1px solid ${COLOR.line}`,
  background: COLOR.canvas,
  color: COLOR.ink,
  fontSize: FONT_PX.helper,
  fontFamily: 'monospace',
} as const
const inputStyle = {
  width: '100%',
  minHeight: 34,
  padding: '0 8px',
  borderRadius: 7,
  border: `1px solid ${COLOR.line}`,
  background: COLOR.surface,
  color: COLOR.ink,
  fontSize: FONT_PX.body,
} as const
const buttonStyle = { minHeight: 36, justifySelf: 'start' as const, padding: '0 12px', border: `1px solid ${COLOR.line}`, borderRadius: 7, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer' } as const
const conflictStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 14, color: COLOR.danger, background: '#fff1f0', borderRadius: 8 } as const
const errorTextStyle = { margin: '10px 0 0', padding: 12, color: COLOR.danger, background: '#fff1f0', borderRadius: 8, fontSize: FONT_PX.body } as const
const receiptStyle = { marginTop: 18, padding: 14, border: `1px solid ${COLOR.line}`, borderRadius: 8, background: COLOR.canvas } as const
const confirmStyle = { margin: '10px 0 0', padding: 12, borderRadius: 8, background: COLOR.canvas, fontSize: FONT_PX.body } as const
const detailGridStyle = { display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: '8px 12px', margin: '12px 0 0', fontSize: FONT_PX.body } as const
