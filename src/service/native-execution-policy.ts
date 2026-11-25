import { OrchError } from '../core/errors.ts'
import { mergeRequirementsContracts, type RequirementsContract } from '../core/task-requirements.ts'
import { SUBWORKFLOW_MAX_DEPTH } from '../core/workflow-def.ts'
import type { Db } from '../infra/sqlite/driver.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'
import { readApprovedTaskPlanForRun } from './task-planning.ts'

/** Ancestor restrictions apply to both native tools and the host's project-context reader. */
export function readRunRequirementsContract(tx: Pick<ReadTx, 'get'>, initialRunId: string) {
  const contracts: RequirementsContract[] = []
  const seen = new Set<string>()
  let runId: string | null = initialRunId
  let taskId: string | undefined
  while (runId) {
    if (seen.has(runId) || seen.size > SUBWORKFLOW_MAX_DEPTH) {
      throw new OrchError('FORBIDDEN', '无法核验子流程的任务权限边界')
    }
    seen.add(runId)
    const run: { task_id: string; parent_run_id: string | null } | undefined = tx.get(
      'SELECT task_id,parent_run_id FROM runs WHERE run_id=?', [runId])
    if (!run || (taskId !== undefined && taskId !== run.task_id)) {
      throw new OrchError('FORBIDDEN', '子流程不属于同一项已授权任务')
    }
    taskId = run.task_id
    const plan = readApprovedTaskPlanForRun(tx, runId)
    if (plan?.brief.requirements_contract) contracts.push(plan.brief.requirements_contract)
    runId = run.parent_run_id
  }
  return contracts.reverse().reduce<RequirementsContract | undefined>((previous, current) =>
    previous ? mergeRequirementsContracts(previous, current) : current, undefined)
}

/** Read authority from the persisted node and approved plans, never from the executor's input. */
export function readNativeExecutionPolicy(db: Db, nodeRunId: string) {
  return withReadTx(db, ({ tx }) => {
    const node = tx.get<{ run_id: string; side_effect_policy: string }>(
      "SELECT run_id,side_effect_policy FROM node_runs WHERE node_run_id=? AND node_type='agent'", [nodeRunId])
    if (!node || !['pure', 'compensable', 'irreversible'].includes(node.side_effect_policy)) {
      throw new OrchError('FORBIDDEN', '执行节点没有可核验的工具权限策略')
    }
    const sideEffectPolicy = node.side_effect_policy as 'pure' | 'compensable' | 'irreversible'
    const requirementsContract = readRunRequirementsContract(tx, node.run_id)
    return { sideEffectPolicy, ...(requirementsContract ? { requirementsContract } : {}) }
  })
}
