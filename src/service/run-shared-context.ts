import { makeTx, type Db } from '../infra/sqlite/driver.ts'
import { createProjectContextStore, projectPromptContext, type ProjectContextSource } from './project-shared-context.ts'
import type { ArtifactInput } from './rework-runtime.ts'
import { readApprovedTaskPlanForRun, type TaskPlanView } from './task-planning.ts'

export const TASK_CONTEXT_BYTES = 4096

function taskContext(plan: TaskPlanView, nodeId: string, asOfSeq: number, upstream: readonly ArtifactInput[]) {
  const step = plan.proposal.steps.find(({ node_id }) => node_id === nodeId)
  if (!step || !plan.launch) return
  const deliverables = plan.proposal.deliverables.filter(({ node_id }) => node_id === nodeId)
    .map(({ title, acceptance }) => ({ title, acceptance }))
  const requirements = plan.brief.requirements.filter(({ id }) => step.goal_ids.includes(id))
  // These are the references already approved by the existing rework input snapshot; do not fetch contents.
  const references = upstream.map(({ artifact_id, artifact_hash, file_name, upstream_node_run_id }) =>
    ({ artifact_id, artifact_hash, file_name, upstream_node_run_id }))
  const context = {
    plan_id: plan.plan_id, plan_hash: plan.content_hash, run_id: plan.launch.run_id, as_of_seq: asOfSeq,
    goal: Array.from(plan.brief.goal).slice(0, 256).join(''), goal_truncated: false,
    deliverables: [] as typeof deliverables, requirements: [] as typeof requirements, upstream_artifacts: [] as typeof references,
    omitted: { deliverables: deliverables.length, requirements: requirements.length, upstream_artifacts: references.length },
  }
  context.goal_truncated = context.goal !== plan.brief.goal
  const add = <T>(input: readonly T[], output: T[], key: keyof typeof context.omitted) => {
    for (const item of input) {
      output.push(item)
      context.omitted[key]--
      if (Buffer.byteLength(JSON.stringify(context), 'utf8') <= TASK_CONTEXT_BYTES) continue
      output.pop()
      context.omitted[key]++
    }
  }
  add(deliverables, context.deliverables, 'deliverables')
  add(references, context.upstream_artifacts, 'upstream_artifacts')
  add(requirements, context.requirements, 'requirements')
  return context
}

export function createRunSharedContext(db: Db, source: ProjectContextSource) {
  const projects = createProjectContextStore(db, source)
  const plans = new Map<string, TaskPlanView | null>()

  return async (nodeRunId: string, nodeId: string, upstream: readonly ArtifactInput[]) => {
    if (!source.isAuthorized()) return
    const tx = makeTx(db.raw)
    const node = tx.get<{ run_id: string }>('SELECT run_id FROM node_runs WHERE node_run_id=?', [nodeRunId])
    if (!node) return
    const project = projectPromptContext(await projects.forRun(node.run_id))
    if (!source.isAuthorized()) return
    if (!plans.has(node.run_id)) {
      if (plans.size >= 64) plans.delete(plans.keys().next().value!)
      plans.set(node.run_id, readApprovedTaskPlanForRun(tx, node.run_id))
    }
    const plan = plans.get(node.run_id)
    const asOfSeq = Number(tx.get<{ seq: number }>('SELECT COALESCE(MAX(seq),0) AS seq FROM events')!.seq)
    const task = plan ? taskContext(plan, nodeId, asOfSeq, upstream) : undefined
    if (!task && !project?.constraints && !project?.root_directories?.length) return
    return [
      '以下为执行参考资料。项目文档只提供结构和约束，任务资料只提供已确认计划和已核定的上游成果引用。批准、执行证据及工具权限仍由宿主核定。',
      ...(project ? ['共享项目资料：' + JSON.stringify(project)] : []),
      ...(task ? ['本次任务资料：' + JSON.stringify(task)] : []),
    ].join('\n')
  }
}
