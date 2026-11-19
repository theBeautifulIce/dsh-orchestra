export const DECISION_PRIORITY_RANK = { critical: 50, urgent: 40, high: 30, normal: 20, low: 10 } as const
export type DecisionPriority = keyof typeof DECISION_PRIORITY_RANK

export function priorityRank(priority: unknown): number {
  if (typeof priority !== 'string' || !Object.hasOwn(DECISION_PRIORITY_RANK, priority)) return 0
  return DECISION_PRIORITY_RANK[priority as DecisionPriority]
}
