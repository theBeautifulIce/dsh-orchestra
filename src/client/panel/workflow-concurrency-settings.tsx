import { useEffect, useMemo, useState } from 'react'
import { ApiError, type ApiClient } from '../api/client.ts'
import { postWithOperationReceipt } from '../api/commands.ts'
import { createResourcesApi } from '../api/resources.ts'
import type { WorkflowListItem } from '../api/types.ts'
import type { WorkflowConcurrencyView } from '../../service/workflow-concurrency-settings.ts'
import { isReleaseWorkflow } from '../../core/release-workflow-ids.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import { PanelCommandButton } from './shell.tsx'
import { readCanvasDoc, type CanvasNode } from './workflow-canvas-nodes.tsx'

const PATH = '/v1/settings/workflow-concurrency'
const FIELDS = [
  { key: 'run_limit', label: '每次流程运行的并行步骤数', help: '设为 2：同一份报表最多同时跑两个独立步骤。', min: 1, max: 32 },
  { key: 'node_limit', label: '同一步骤跨任务的并发数', help: '设为 2：十份报表到达同一流程的复核步骤时，一次复核两份。', min: 1, max: 32 },
  { key: 'helper_limit', label: '每个步骤内的并行助手数', help: '设为 2：一次复核可以同时使用两个文本助手，其余依次等候。', min: 0, max: 8 },
] as const
type Field = (typeof FIELDS)[number]['key']
type Overrides = WorkflowConcurrencyView['overrides']
type Target = { workflow_id?: string; node_id?: string }
type Draft = { revision: number; values: Overrides }
type SaveCommand = Target & { operation_id: string; expected_revision: number; values: Overrides | null }

function valueLabel(value: number | null | undefined, field: Field): string {
  if (value === undefined) return '待确认'
  if (value === null) return '无独立上限'
  if (field === 'helper_limit' && value === 0) return '0（关闭）'
  return String(value)
}

function selectValue(value: number | null | undefined) {
  if (value === undefined) return ''
  if (value === null) return 'unlimited'
  return String(value)
}

export function WorkflowConcurrencySettings({ client, reloadVersion = 0, onSnapshot }: {
  client: ApiClient; reloadVersion?: number; onSnapshot?: (seq: number) => void
}) {
  const api = useMemo(() => createResourcesApi(client), [client])
  const [workflowId, setWorkflowId] = useState('')
  const [nodeId, setNodeId] = useState('')
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([])
  const [workflowsLoading, setWorkflowsLoading] = useState(true)
  const [workflowError, setWorkflowError] = useState(false)
  const [choiceReload, setChoiceReload] = useState(0)
  const [nodeList, setNodeList] = useState<{ workflowId: string; nodes: CanvasNode[] | null }>()
  const [loaded, setLoaded] = useState<{ key: string; version: string; view: WorkflowConcurrencyView }>()
  const [readError, setReadError] = useState<{ key: string; version: string }>()
  const [drafts, setDrafts] = useState(new Map<string, Draft>())
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ message: string; error?: boolean }>()
  const [pending, setPending] = useState<SaveCommand>()
  const key = JSON.stringify([workflowId, nodeId])
  const version = reloadVersion + ':' + reload
  const draft = drafts.get(key)
  const saved = loaded?.key === key ? loaded.view : undefined
  const ready = Boolean(saved && loaded?.version === version && (readError?.key !== key || readError.version !== version))
  const conflict = Boolean(saved && draft && saved.revision !== draft.revision)
  const editable = ready && !conflict && !busy && !pending
  const helperBlocked = Boolean(saved && !saved.helper_available && (draft?.values.helper_limit ?? 0) > 0)
  const fields = nodeId ? FIELDS.filter(({ key }) => key !== 'run_limit') : FIELDS
  const nodes = nodeList?.workflowId === workflowId ? nodeList.nodes : undefined

  useEffect(() => {
    let active = true
    setWorkflowError(false)
    setWorkflowsLoading(true)
    async function loadWorkflows() {
      const published = new Map<string, WorkflowListItem>()
      let cursor: string | undefined
      do {
        const { data } = await api.listWorkflows({ limit: 100, cursor })
        if (!active) return
        for (const item of data.items) {
          if (item.current_version !== null && !isReleaseWorkflow(item.workflow_id)) published.set(item.workflow_id, item)
        }
        setWorkflows([...published.values()])
        cursor = data.next_cursor ?? undefined
      } while (cursor)
    }
    void loadWorkflows().catch(() => { if (active) setWorkflowError(true) })
      .finally(() => { if (active) setWorkflowsLoading(false) })
    return () => { active = false }
  }, [api, choiceReload, reloadVersion])

  useEffect(() => {
    if (!workflowId) return
    let active = true
    setNodeList(undefined)
    void api.getWorkflow(workflowId).then(({ data }) => {
      if (!active) return
      const nodes = readCanvasDoc(data.current?.definition)?.nodes.filter(({ type }) => type === 'agent') ?? []
      setNodeList({ workflowId, nodes })
    }).catch(() => { if (active) setNodeList({ workflowId, nodes: null }) })
    return () => { active = false }
  }, [api, workflowId, choiceReload, reloadVersion])

  useEffect(() => {
    let active = true
    void client.get<WorkflowConcurrencyView>(PATH, { workflow_id: workflowId || undefined, node_id: nodeId || undefined }).then(({ data, as_of_seq }) => {
      if (!active) return
      setLoaded({ key, version, view: data })
      setReadError(undefined)
      onSnapshot?.(as_of_seq)
    }).catch(() => { if (active) setReadError({ key, version }) })
    return () => { active = false }
  }, [client, key, nodeId, onSnapshot, version, workflowId])

  function removeDraft() {
    setDrafts((current) => {
      const next = new Map(current)
      next.delete(key)
      return next
    })
  }

  function updateField(field: Field, value: string) {
    if (!saved || !editable) return
    const values = { ...(draft?.values ?? saved.overrides) }
    if (value === '') delete values[field]
    else if (field === 'helper_limit') values[field] = Number(value)
    else values[field] = value === 'unlimited' ? null : Number(value)
    if (fields.every(({ key }) => values[key] === saved.overrides[key])) removeDraft()
    else setDrafts((current) => new Map(current).set(key, { revision: saved.revision, values }))
    setNotice(undefined)
  }

  function selectTarget(workflow: string, node: string) {
    if (busy || pending) return
    setWorkflowId(workflow)
    setNodeId(node)
    setLoaded(undefined)
    setReadError(undefined)
    setNotice(undefined)
  }

  async function save(reset: boolean) {
    if (!saved || busy || (!pending && (!editable || (!reset && (!draft || helperBlocked))))) return
    const values = !reset && draft && Object.keys(draft.values).length > 0 ? draft.values : null
    const command = pending ?? {
      operation_id: newOperationId(),
      expected_revision: saved.revision,
      ...(workflowId ? { workflow_id: workflowId } : {}),
      ...(nodeId ? { node_id: nodeId } : {}),
      values,
    }
    setBusy(true)
    setNotice(undefined)
    try {
      await postWithOperationReceipt(client, PATH, 'workflow_concurrency.save', command)
      setPending(undefined)
      removeDraft()
      setNotice({ message: command.values ? '已保存 Workflow 并发设置。' : '已恢复继承或会话默认值。' })
      setReload((value) => value + 1)
    } catch (error) {
      const unresolved = error instanceof ApiError && error.code === 'OPERATION_OUTCOME_UNKNOWN'
      setPending(unresolved ? command : undefined)
      setNotice({ error: true, message: error instanceof Error ? error.message : '暂时无法保存 Workflow 并发设置。' })
      if (!unresolved) setReload((value) => value + 1)
    } finally { setBusy(false) }
  }

  return <section className="ops-surface" aria-labelledby="workflow-concurrency-title">
    <header className="ops-surface-head">
      <h2 id="workflow-concurrency-title" className="ops-settings-anchor" tabIndex={-1}>Workflow 并发</h2>
    </header>
    <form className="ops-inset ops-stack" onSubmit={(event) => { event.preventDefault(); void save(false) }}>
      <p className="ops-meta">在当前会话设默认值，也可单独调整某个流程或步骤。节点同时受总执行名额和以下两项步骤限制。助手名额在步骤开始时确定。</p>
      <div className="ops-context-grid">
        <label className="ops-stack">应用范围
          <select className="ops-field" value={workflowId} disabled={busy || Boolean(pending)}
            onChange={(event) => selectTarget(event.target.value, '')}>
            <option value="">当前会话默认</option>
            {workflowId && !workflows.some(({ workflow_id }) => workflow_id === workflowId)
              && <option value={workflowId}>{workflowId}</option>}
            {workflows.map(({ workflow_id, name }) => <option key={workflow_id} value={workflow_id}>{name} · {workflow_id}</option>)}
          </select>
        </label>
        {workflowId && <label className="ops-stack">已发布步骤
          <select className="ops-field" value={nodeId} disabled={busy || Boolean(pending) || !nodes}
            onChange={(event) => selectTarget(workflowId, event.target.value)}>
            <option value="">整个 Workflow</option>
            {nodeId && !nodes?.some(({ node_id }) => node_id === nodeId) && <option value={nodeId}>{nodeId}</option>}
            {nodes?.map(({ node_id, title }) => <option key={node_id} value={node_id}>{title} · {node_id}</option>)}
          </select>
        </label>}
      </div>
      {(workflowError || workflowId && nodes === null) && <div role="alert" className="ops-actions">
        <span>{workflowError ? '暂时无法完整读取已发布的 Workflow。' : '暂时无法读取这个 Workflow 的已发布步骤。'}</span>
        <button type="button" className="ops-button" onClick={() => setChoiceReload((value) => value + 1)}>重读应用范围</button>
      </div>}
      {workflowsLoading && <p className="ops-meta" role="status">正在读取已发布的 Workflow…</p>}
      {workflowId && nodes === undefined && <p className="ops-meta" role="status">正在读取已发布步骤…</p>}
      {workflowId && nodes?.length === 0 && <p className="ops-meta">这个 Workflow 暂无已发布的智能体步骤。</p>}
      {saved && <div className="ops-context-grid">
        {fields.map(({ key, label, min, max, help }) => <label key={key} className="ops-stack">
          {label}
          <select className="ops-field" value={selectValue((draft?.values ?? saved.overrides)[key])}
            disabled={!editable} onChange={(event) => updateField(key, event.target.value)}>
            <option value="">{workflowId ? '继承' : '使用默认值'}（{valueLabel(saved.inherited?.[key], key)}）</option>
            {key !== 'helper_limit' && <option value="unlimited">无独立上限</option>}
            {Array.from({ length: max - min + 1 }, (_, index) => index + min)
              .map((value) => <option key={value} value={value}
                disabled={key === 'helper_limit' && !saved.helper_available && value > 0}>{valueLabel(value, key)}</option>)}
          </select>
          <span className="ops-meta">{help}</span><span className="ops-meta">{key === 'helper_limit' && !saved.helper_available
            ? '当前宿主未提供受限助手能力' : `当前生效 ${valueLabel(saved.values[key], key)}`}</span>
        </label>)}
      </div>}
      {helperBlocked && <p role="alert">请先将助手数改为继承或关闭，再保存此范围的设置。</p>}
      {conflict && <p role="alert">此目标的设置已被其他操作更新。请舍弃本地修改，再基于最新设置编辑。</p>}
      {readError?.key === key && readError.version === version && <p role="alert">暂时无法读取此目标的 Workflow 并发设置。</p>}
      {!ready && (readError?.key !== key || readError.version !== version) && <p role="status">正在读取 Workflow 并发设置…</p>}
      {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.message}</p>}
      {busy && <p role="status">正在确认操作结果…</p>}
      <div className="ops-actions">
        <PanelCommandButton type="submit" className="ops-button ops-button--primary"
          disabled={busy || (!pending && (!editable || !draft || helperBlocked))}>{pending ? '查询或重试 Workflow 并发保存' : '保存 Workflow 并发'}</PanelCommandButton>
        <PanelCommandButton className="ops-button" disabled={!editable || !Object.keys(saved?.overrides ?? {}).length}
          onClick={() => { void save(true) }}>{workflowId ? '恢复继承' : '恢复会话默认值'}</PanelCommandButton>
        {draft && <button type="button" className="ops-button" disabled={busy || Boolean(pending)} onClick={removeDraft}>舍弃本地修改</button>}
        <button type="button" className="ops-button ops-button--link" disabled={busy || Boolean(pending)}
          onClick={() => { setNotice(undefined); setReload((value) => value + 1) }}>重读 Workflow 并发设置</button>
      </div>
    </form>
  </section>
}
