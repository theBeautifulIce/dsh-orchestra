import type { OrchestraConfig } from '../core/config.ts'
import type { Db } from '../infra/sqlite/driver.ts'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
type Policy = { receiptMs: number; inFlightMs: number }
const DEFAULT_POLICY: Policy = { receiptMs: 7 * DAY_MS, inFlightMs: 10 * MINUTE_MS }
const configured = new WeakMap<Db['raw'], Policy>()

export function configureReceiptRetention(db: Db, retention: OrchestraConfig['retention']): void {
  configured.set(db.raw, {
    receiptMs: retention.receipt_days * DAY_MS,
    inFlightMs: retention.in_flight_timeout_minutes * MINUTE_MS,
  })
}

export function receiptRetention(raw: Db['raw']): Readonly<Policy> {
  return configured.get(raw) ?? DEFAULT_POLICY
}

export function receiptExpired(row: { completed_at: string | null; receipt_expired_at: string | null }, now: number,
  receiptMs: number): boolean {
  return (row.receipt_expired_at !== null && Date.parse(row.receipt_expired_at) <= now)
    || (row.completed_at !== null && Date.parse(row.completed_at) + receiptMs <= now)
}
