import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/client/api/client.ts'
import { submitThenReceipt } from '../../src/client/api/commands.ts'

describe('submitThenReceipt', () => {
  it('回执查询因网络异常失败时统一返回结果暂不可确认', async () => {
    await expect(submitThenReceipt(
      async () => { throw new ApiError('OPERATION_OUTCOME_UNKNOWN', 'unknown', true) },
      async () => { throw new TypeError('network disconnected') },
      'op-1',
    )).rejects.toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN', details: { operation_id: 'op-1', receipt_error: 'NETWORK_ERROR' } })
  })
})
