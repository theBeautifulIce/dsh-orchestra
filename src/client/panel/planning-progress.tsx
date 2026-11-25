import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PlanningProgress } from '../../service/chat-planning-progress.ts'
import type { ResourcesApi } from '../api/resources.ts'
import type { TaskPlanView } from '../../service/task-planning.ts'

const labels = {
  planning: '正在生成计划', approval: '计划已生成，等待确认', started: '已建立运行',
  failed: '规划中断，请重试', declined: '本次未启动，可取回计划', cancelled: '已取消规划', blocked: '计划需要调整',
}

function isProgress(item: unknown): item is PlanningProgress {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false
  const row = item as Record<string, unknown>
  return typeof row.request_key === 'string' && typeof row.title === 'string'
    && typeof row.stage === 'string' && Object.hasOwn(labels, row.stage)
    && typeof row.updated_ms === 'number' && Number.isFinite(row.updated_ms)
    && (row.plan_id === null || typeof row.plan_id === 'string')
    && (row.run_id === null || typeof row.run_id === 'string')
}

export function PlanningProgressPanel({ api, onResume, disabled = false }: {
  api: ResourcesApi; onResume: (plan: TaskPlanView) => void; disabled?: boolean
}) {
  const generation = useRef(0)
  const selection = useRef(0)
  const blocked = useRef(disabled)
  blocked.current = disabled
  const [reading, setReading] = useState<string | null>(null)
  const [items, setItems] = useState<PlanningProgress[]>([])
  const [failure, setFailure] = useState('')
  const [retry, setRetry] = useState(0)
  useLayoutEffect(() => {
    selection.current += 1
    setReading(null)
    return () => { selection.current += 1 }
  }, [api, disabled])
  useEffect(() => {
    const current = ++generation.current
    let timer: ReturnType<typeof setTimeout> | undefined
    setItems([])
    setFailure('')
    async function refresh() {
      try {
        const response = await api.getPlanningProgress()
        if (!Array.isArray(response.data?.items) || !response.data.items.every(isProgress)) {
          throw new Error('Planning progress response is incomplete')
        }
        if (current === generation.current) {
          setItems(response.data.items)
          setFailure('')
        }
      } catch {
        if (current === generation.current) setFailure('暂时无法更新规划进度')
      }
      if (current === generation.current) timer = setTimeout(refresh, 2500)
    }
    void refresh()
    return () => { generation.current++; clearTimeout(timer) }
  }, [api, retry])

  async function resume(planId: string) {
    if (blocked.current) return
    const current = generation.current
    const choice = ++selection.current
    setReading(planId)
    try {
      const result = await api.getTaskPlan(planId)
      if (current !== generation.current || choice !== selection.current || blocked.current) return
      if (result.data?.plan_id !== planId) throw new Error('Returned plan does not match the selected plan')
      onResume(result.data)
    } catch {
      if (current === generation.current && choice === selection.current && !blocked.current) {
        setFailure('未能取回这份计划，请重新读取')
      }
    } finally {
      if (current === generation.current && choice === selection.current) setReading(null)
    }
  }
  const visible = items.filter(item => item.stage !== 'started')
  const row = (item: PlanningProgress) => <li key={item.request_key}>
    {item.title || '本次任务'} · {labels[item.stage]}
    {item.plan_id && item.stage !== 'cancelled' && <button className="ops-button" type="button" disabled={disabled || reading !== null}
      onClick={() => { void resume(item.plan_id!) }}>{reading === item.plan_id ? '正在取回计划…' : '核对这份计划'}</button>}
  </li>
  return <section aria-label="会话规划进度">
    {visible.length > 0 && <>
      <h3>会话规划进度</h3>
      <ul>{visible.slice(0, 3).map(row)}</ul>
      {visible.length > 3 && <details>
        <summary>另外 {visible.length - 3} 条规划记录</summary>
        <ul>{visible.slice(3).map(row)}</ul>
      </details>}
    </>}
    {failure && <p>{failure} <button className="ops-button" type="button" onClick={() => setRetry(n => n + 1)}>重新读取</button></p>}
  </section>
}
