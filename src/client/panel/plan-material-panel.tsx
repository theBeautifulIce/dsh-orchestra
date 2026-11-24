import { useEffect, useRef, useState } from 'react'
import type { TaskPlanView } from '../../service/task-planning.ts'
import type { ResourcesApi } from '../api/resources.ts'
import type { TaskCommands } from '../api/task-commands.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import { PanelCommandButton } from './shell.tsx'
import { MaterialPicker } from './material-picker.tsx'

export function PlanMaterialList({ plan, api }: { plan: TaskPlanView; api: ResourcesApi }) {
  const [revoked, setRevoked] = useState<string[]>([])
  const [pending, setPending] = useState<string[]>([])
  const [failure, setFailure] = useState('')
  const [now, setNow] = useState(Date.now)
  const generation = useRef(0)
  const locks = useRef(new Set<string>())
  useEffect(() => {
    generation.current++
    locks.current.clear()
    setRevoked([])
    setPending([])
    setFailure('')
    return () => { generation.current++ }
  }, [plan.plan_id, api])
  useEffect(() => {
    const next = Math.min(...(plan.brief.materials ?? []).map(item => item.expires_ms).filter(expiry => expiry > now))
    if (!Number.isFinite(next)) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(1, next - Date.now())))
    return () => clearTimeout(timer)
  }, [plan, now])

  async function revoke(id: string) {
    if (locks.current.has(id)) return
    locks.current.add(id)
    setPending(items => [...items, id])
    const current = generation.current
    try {
      await api.revokePlanMaterial(plan.plan_id, plan.content_hash, id)
      if (current === generation.current) setRevoked(items => [...new Set([...items, id])])
    } catch (error) {
      if (current === generation.current) setFailure(error instanceof Error ? error.message : '暂时无法撤回授权')
    } finally {
      if (current === generation.current) {
        locks.current.delete(id)
        setPending(items => items.filter(item => item !== id))
      }
    }
  }
  if (!plan.brief.materials?.length) return null
  return <section aria-label="本次已授权材料">
    <strong>本次已授权材料</strong>
    <ul>{plan.brief.materials.map(item => {
      const stored = plan.material_states?.find(state => state.id === item.id)
      const expiry = stored?.expires_ms ?? item.expires_ms
      const state = revoked.includes(item.id) || stored?.state === 'revoked' ? 'revoked'
        : stored?.state === 'expired' || expiry <= now ? 'expired' : 'active'
      const recipients = item.nodes.map(id => plan.proposal.steps.find(step => step.node_id === id)?.description ?? '未找到已绑定步骤')
      return <li key={item.id}>
        <strong>{item.name}</strong> · {state === 'revoked' ? '已撤回' : state === 'expired' ? '已到期' : '授权有效'}
        <p>可读步骤：{recipients.join('、')}。到期时间：{new Date(expiry).toLocaleString('zh-CN', {
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
        })}。</p>
        {state === 'active' && <PanelCommandButton disabled={pending.includes(item.id)} onClick={() => { void revoke(item.id) }}>
          {pending.includes(item.id) ? '正在撤回…' : '撤回授权'}
        </PanelCommandButton>}
      </li>
    })}</ul>
    <p>授权到期或撤回后，后续读取将被拒绝。已交给执行步骤的内容仍可能用于当前结果。</p>
    {!plan.launch && <p>材料失效后，请重新授权，或调整目标并重新规划后再启动。</p>}
    {failure && <p role="alert">{failure}</p>}
  </section>
}

export function PlanMaterialPanel({ plan, api, commands, onPlan, onBusy }: {
  plan: TaskPlanView; api: ResourcesApi; commands: TaskCommands
  onPlan: (plan: TaskPlanView) => void; onBusy: (busy: boolean) => void
}) {
  const [nodes, setNodes] = useState<string[]>([])
  const operation = useRef<{ body: string; id: string } | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    generation.current++
    setNodes([])
    operation.current = null
    return () => { generation.current++ }
  }, [plan.plan_id, api, commands])
  const eligible = plan.proposal.steps.filter(step => plan.material_recipients?.includes(step.node_id))

  return <details>
    <summary>为本次任务补充材料</summary>
    <p>先选择可读取材料的步骤，再选择文件或粘贴文本。授权后请核对更新的计划。同名材料会替换本计划中的旧授权。执行模型由当前模型设置选择。</p>
    <fieldset>
      <legend>允许读取的步骤</legend>
      {eligible.map(step => <label key={step.node_id} style={{ display: 'block' }}>
        <input type="checkbox" checked={nodes.includes(step.node_id)} onChange={event => setNodes(current => event.target.checked
          ? [...current, step.node_id] : current.filter(id => id !== step.node_id))} />
        {step.description} · {step.preferred_model_ref ? '建议模型：' + step.preferred_model_ref : '模型按执行设置选择'}
      </label>)}
    </fieldset>
    <MaterialPicker recipients={eligible.filter(step => nodes.includes(step.node_id)).map(step => step.description)}
      onGrant={async items => {
        const current = generation.current
        const body = JSON.stringify({ plan: plan.plan_id, nodes: [...nodes].sort(), items })
        if (operation.current?.body !== body) operation.current = { body, id: newOperationId() }
        onBusy(true)
        try {
          const updated = await commands.grantPlanMaterials(plan.plan_id, plan.content_hash, nodes, items, operation.current.id)
          if (current === generation.current) onPlan(updated)
        } finally {
          if (current === generation.current) onBusy(false)
        }
      }} />
    <PlanMaterialList plan={plan} api={api} />
  </details>
}
