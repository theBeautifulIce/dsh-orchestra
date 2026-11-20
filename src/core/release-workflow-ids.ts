export const RELEASE_WORKFLOW_ID = 'wf_release_v1'
export const RELEASE_CHECK_WORKFLOW_ID = 'wf_gate_check_v1'

export function isReleaseWorkflow(workflowId: string | undefined) {
  return workflowId === RELEASE_WORKFLOW_ID || workflowId === RELEASE_CHECK_WORKFLOW_ID
}
