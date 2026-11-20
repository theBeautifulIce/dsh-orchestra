import type { ApiClient } from './client.ts'
import type { createModelEscalationHost, ModelEscalationAssessment } from '../../service/model-escalation.ts'
import { newOperationId } from './workflow-commands.ts'

type View = Omit<ReturnType<ReturnType<typeof createModelEscalationHost>['get']>, 'as_of_seq'>
type Precondition = NonNullable<View['precondition']>
const path = '/v1/model-escalation'

export function createModelEscalationApi(client: ApiClient) {
  return {
    get: (run_id: string, node_run_id: string) => client.get<View>(path, { run_id, node_run_id }),
    assess: (precondition: Precondition, operation_id = newOperationId()) =>
      client.post<ModelEscalationAssessment>(path, { ...precondition, operation_id }),
  }
}
export type ModelEscalationApi = ReturnType<typeof createModelEscalationApi>
