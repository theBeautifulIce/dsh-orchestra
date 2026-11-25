/** A failed projection or delivery must not starve other runs from the same conversation.
 * The caller owns the durable delivery checkpoint; an exception never acknowledges a report.
 */
export async function visitChatReports<T>(receipts: readonly T[], isCurrent: () => boolean,
  visit: (receipt: T) => Promise<'stop' | void>): Promise<void> {
  for (const receipt of receipts) {
    if (!isCurrent()) return
    try {
      if (await visit(receipt) === 'stop') return
    } catch {
      // Leave the failed receipt pending. The next scan can retry its deterministic ID.
      // Do not carry an exception across the boundary into the next run.
      if (!isCurrent()) return
    }
  }
}
