import { useEffect, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { WorkflowListItem } from '../api/types.ts'
import type { WorkspaceOverview } from '../../service/queries/tasks.ts'
import { ActivityList } from './activity-screen.tsx'
import type { PanelRoute } from './shell.tsx'
import { COLOR, FONT_PX } from './tokens.ts'

type OverviewProps = { api: ResourcesApi; reloadVersion: number; onSnapshot: (seq: number) => void; onNavigate: (route: PanelRoute) => void }

export function OverviewScreen({ api, reloadVersion, onSnapshot, onNavigate }: OverviewProps) {
  const [data, setData] = useState<{ summary: WorkspaceOverview; workflows: WorkflowListItem[] } | null>(null)
  const [failed, setFailed] = useState(false)
  const [retry, refresh] = useState(0)
  useEffect(() => {
    let current = true
    setFailed(false)
    void Promise.all([api.getWorkspaceOverview(), api.listWorkflows({ limit: 4 })]).then(([overview, workflows]) => {
      if (!current) return
      setData({ summary: overview.data, workflows: workflows.data.items })
      onSnapshot(Math.max(overview.as_of_seq, workflows.as_of_seq))
    }).catch(() => { if (current) setFailed(true) })
    return () => { current = false }
  }, [api, onSnapshot, reloadVersion, retry])

  const lanes = data?.summary.lanes
  return <section aria-labelledby="overview-title" className="ops-page">
    <header><h1 id="overview-title">总览</h1></header>
    {failed && <p role="alert">总览读取失败。 <button type="button" style={buttonStyle} onClick={() => refresh((value) => value + 1)}>重试</button></p>}
    {!failed && !data && <p role="status">正在读取总览…</p>}
    {data && lanes && <div style={statsStyle}>
      <button type="button" style={statStyle} onClick={() => onNavigate('tasks')}>
        <strong>{lanes.upcoming + lanes.running + lanes.attention + lanes.finished}</strong><span>未归档任务</span>
      </button>
      <button type="button" style={statStyle} onClick={() => onNavigate('decisions')}>
        <strong>{data.summary.open_decisions}</strong><span>待审批</span>
      </button>
      <button type="button" style={statStyle} onClick={() => onNavigate('effects')}>
        <strong>{data.summary.unverified_effects}</strong><span>待核实</span>
      </button>
    </div>}
    {lanes && <section style={blockStyle} aria-label="任务状态">
      <h2 style={headingStyle}>任务状态</h2>
      <dl style={{ ...statsStyle, margin: 0 }}>
        {([['待执行', lanes.upcoming], ['执行中', lanes.running], ['待处理', lanes.attention], ['已结束', lanes.finished]] as const)
          .map(([label, count]) => <div key={label}><dt>{label}</dt><dd style={{ margin: 0, fontSize: FONT_PX.title, fontWeight: 650 }}>{count}</dd></div>)}
      </dl>
    </section>}
    <div className="ops-context-grid">
      <section style={blockStyle}>
        <header style={sectionHeaderStyle}><h2 style={headingStyle}>近期事件</h2>
          <button type="button" style={buttonStyle} onClick={() => onNavigate('activity')}>全部记录</button></header>
        <ActivityList api={api} reloadVersion={reloadVersion} onSnapshot={onSnapshot} compact />
      </section>
      <section style={blockStyle}>
        <header style={sectionHeaderStyle}><h2 style={headingStyle}>Workflow</h2>
          <button type="button" style={buttonStyle} onClick={() => onNavigate('workflows')}>查看全部</button></header>
        {data?.workflows.length === 0 && <p style={mutedStyle}>当前没有流程。</p>}
        {data?.workflows.map((workflow) => <div key={workflow.workflow_id} style={{ paddingBlock: 9, borderBottom: `1px solid ${COLOR.line}` }}>
          <strong>{workflow.name}</strong><p style={mutedStyle}>{workflow.current_version === null ? '待发布' : `v${workflow.current_version}`} · {workflow.active_task_count} 个活跃任务</p>
        </div>)}
      </section>
    </div>
  </section>
}

const statsStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(135px, 100%), 1fr))', gap: 8 }
const blockStyle = { minWidth: 0, padding: '9px 12px', border: '1px solid #dde4ed', borderRadius: 9, background: COLOR.surface }
const headingStyle = { margin: 0, fontSize: FONT_PX.section }
const mutedStyle = { color: COLOR.inkMuted, margin: '5px 0', fontSize: FONT_PX.body }
const sectionHeaderStyle = { display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 } as const
const buttonStyle = { padding: '6px 10px', border: `1px solid ${COLOR.line}`, background: COLOR.surface, color: COLOR.ink, borderRadius: 6, cursor: 'pointer' }
const statStyle = { ...blockStyle, display: 'flex', flexWrap: 'wrap' as const, alignItems: 'baseline', gap: 8, color: COLOR.ink, fontSize: FONT_PX.body, cursor: 'pointer' }
