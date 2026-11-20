import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client.ts'
import type { ModelEscalationApi } from '../api/model-escalation.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import type { NodeRunView } from '../api/types.ts'
import { PanelCommandButton } from './shell.tsx'

type View = Awaited<ReturnType<ModelEscalationApi['get']>>['data']
const classifications = {
  model_capability: '模型能力不足', model_efficiency: '模型执行效率低',
  waiting_external: '等待外部条件', other: '其他原因', insufficient: '证据不足',
}
const triggers = { prolonged_runtime: '运行时间较长', execution_blocked: '执行受阻', repeated_rework: '两次有效打回' }

export function ModelEscalation({ api, node, reloadVersion }: { api: ModelEscalationApi; node: NodeRunView; reloadVersion: number }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const operation = useRef<string>()
  useEffect(() => {
    if (!open) return
    let current = true
    void api.get(node.run_id, node.node_run_id).then(({ data }) => {
      if (current) setView(data)
    }, (err: unknown) => {
      if (current) setError(err instanceof ApiError ? err.message : '暂时无法读取主脑诊断')
    })
    return () => { current = false }
  }, [api, node.run_id, node.node_run_id, open, reloadVersion, refresh])

  async function assess() {
    if (!view?.precondition || busy) return
    setBusy(true)
    setError('')
    operation.current ??= newOperationId()
    try {
      const { data } = await api.assess(view.precondition, operation.current)
      setView((previous) => previous ? { ...previous, item: data } : previous)
      operation.current = undefined
    } catch (err) {
      if (err instanceof ApiError && !['OPERATION_TIMEOUT','OPERATION_OUTCOME_UNKNOWN','SERVICE_UNAVAILABLE'].includes(err.code)) operation.current = undefined
      setError(err instanceof ApiError ? err.message : '暂时无法完成主脑诊断')
    } finally {
      setBusy(false)
      setRefresh((value) => value + 1)
    }
  }

  const opinion = view?.item
  const dispatch = view?.dispatch
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>主脑模型诊断</summary>
    {open && !view && !error && <p role="status">正在读取诊断…</p>}
    {view && !opinion && <p>{view.precondition ? '可请主脑根据当前执行记录诊断。' : '当前没有模型诊断记录。'}</p>}
    {opinion && <div>
      <p>{triggers[opinion.trigger]} · {classifications[opinion.classification]}</p>
      <p>{opinion.reason}</p>
      {opinion.outcome === 'kept' && <p>主脑建议沿用当前模型。</p>}
      {opinion.outcome === 'no_higher_model' && <p>宿主没有已批准且能力更高的可用模型。</p>}
      {opinion.outcome === 'recommended' && <p>建议下一次尝试使用 {opinion.model_ref}。</p>}
      {opinion.outcome === 'recommended' && (dispatch
        ? <p>{dispatch.provider && dispatch.model ? '已回读实际模型' : dispatch.state === 'rejected' ? '宿主未确认建议模型'
          : dispatch.state === 'selected' ? '已选定，等待宿主确认' : '宿主已确认配置，等待实际模型回读'}
          {' · '}{dispatch.provider && dispatch.model ? dispatch.provider + ' / ' + dispatch.model : dispatch.model_ref}</p>
        : <p>{view.successor_node_run_id ? '后续尝试尚无采纳记录。' : '等待已授权的重试或返工。'}</p>)}
    </div>}
    {view?.precondition && <PanelCommandButton disabled={busy} onClick={() => { void assess() }}>
      {busy ? '主脑正在诊断…' : '请主脑诊断模型'}
    </PanelCommandButton>}
    {error && <p role="status">{error}</p>}
  </details>
}
