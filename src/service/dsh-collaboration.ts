import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import { uuidv7 } from '../core/ids.ts'
import {
  collaborationFindingSchema, collaborationHandleSchema, collaborationRequestSchema,
  type CollaborationBinding, type CollaborationHost,
} from './collaboration.ts'

export function callDshCollaboration(host: CollaborationHost, binding: CollaborationBinding, input: unknown) {
  const { action, ...body } = z.looseObject({ action: z.string() }).parse(input)
  const now = new Date().toISOString()
  switch (action) {
    case 'inbox':
      return { memberships: host.listMemberships(binding, now).items, outgoing: host.listOutgoing(binding).items, ...host.listInbox(binding, now) }
    case 'finding':
      return host.reportFinding(binding, collaborationFindingSchema.parse(body), now)
    case 'request':
      return host.requestVerification(binding, collaborationRequestSchema.parse(body), now)
    case 'delivered':
    case 'accept':
    case 'reject':
    case 'complete':
      return host.handle(binding, collaborationHandleSchema.parse({ ...body, action, operation_id: body.operation_id ?? uuidv7() }), now)
    default:
      throw new OrchError('PAYLOAD_SCHEMA_INVALID', '未知的核验操作')
  }
}
