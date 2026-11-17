import { ApiError, unwrap, type FetchLike } from './client.ts'

export type SubmitResult<T = unknown, Receipt = unknown> =
  | { replayed: false; receipt: T }
  | { replayed: true; receipt: Receipt }

/** A timeout is resolved through the operation receipt; never blindly resubmit here. */
export async function submitThenReceipt<T = unknown, Receipt = unknown>(
  post: (operationId: string) => Promise<Response>,
  getOperation: (operationId: string) => Promise<Response>,
  operationId: string,
): Promise<SubmitResult<T, Receipt>> {
  try {
    const result = await unwrap<T>(await post(operationId))
    return { replayed: false, receipt: result.data }
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'OPERATION_TIMEOUT') throw error
    const receipt = await unwrap<Receipt>(await getOperation(operationId))
    return { replayed: true, receipt: receipt.data }
  }
}

export function operationReceiptRequest(fetcher: FetchLike, baseUrl: string, operationId: string): Promise<Response> {
  const url = new URL('v1/operations/get', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  url.searchParams.set('operation_id', operationId)
  return fetcher(url, { method: 'GET', headers: { accept: 'application/json' } })
}
