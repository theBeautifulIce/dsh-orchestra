import { ApiError, unwrap, type FetchLike } from './client.ts'

export type SubmitResult<T = unknown, Receipt = unknown> =
  | { replayed: false; receipt: T }
  | { replayed: true; receipt: Receipt }

/** Ambiguous command transport failures are resolved through the receipt; never blindly resubmit here. */
export async function submitThenReceipt<T = unknown, Receipt = unknown>(
  post: (operationId: string) => Promise<Response>,
  getOperation: (operationId: string) => Promise<Response>,
  operationId: string,
): Promise<SubmitResult<T, Receipt>> {
  try {
    const result = await unwrap<T>(await post(operationId))
    return { replayed: false, receipt: result.data }
  } catch (error) {
    if (!(error instanceof ApiError) || !['OPERATION_TIMEOUT', 'OPERATION_OUTCOME_UNKNOWN', 'SERVICE_UNAVAILABLE'].includes(error.code)) throw error
    try {
      const receipt = await unwrap<Receipt>(await getOperation(operationId))
      return { replayed: true, receipt: receipt.data }
    } catch (receiptError) {
      if (!(receiptError instanceof ApiError) || ['NOT_FOUND', 'SERVICE_UNAVAILABLE', 'OPERATION_TIMEOUT', 'OPERATION_OUTCOME_UNKNOWN'].includes(receiptError.code)) {
        throw new ApiError('OPERATION_OUTCOME_UNKNOWN', '操作结果暂不可确认；请稍后查询回执，不要重新提交', true, {
          operation_id: operationId,
          receipt_error: receiptError instanceof ApiError ? receiptError.code : 'NETWORK_ERROR',
        })
      }
      throw receiptError
    }
  }
}

export function operationReceiptRequest(fetcher: FetchLike, baseUrl: string, operationId: string): Promise<Response> {
  const url = new URL('v1/operations/get', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  url.searchParams.set('operation_id', operationId)
  return fetcher(url, { method: 'GET', headers: { accept: 'application/json' } })
}
