export const COPY = {
  emptyTasks: '还没有任务，新建一个就能开始',
  emptyDecisions: '暂无待处理审批',
  emptyEffects: '没有待核实的操作',
  serviceDown: '服务未连接',
  staleNotice: '显示的是最后一次拿到的数据',
  protocolMismatch: '服务与面板版本不一致，请重启 DSH',
  queryFailed: '查询失败',
  commandUnknown: '结果未知',
  retry: '重试',
  refresh: '刷新后重试',
  oldPanel: '面板版本过旧，无法识别这个状态',
  // 等你决定：有待裁决的事项要人拍板。
  awaitingDecision: '待审批',
  // 仍有未结算不可逆动作：settling 里还挂着没结算的不可逆动作。
  pendingIrreversible: '仍有未结算不可逆动作',
  // 心跳已停：心跳超过阈值，只影响显示，不改节点状态。
  heartbeatStopped: '心跳已停',
  // 未验证终态的独立文案：不折叠进「已完成」或「未成功」。
  succeededWithUnverified: '执行完成，外部操作待核验',
  failedWithUnverified: '执行失败，外部操作待核验',
  // 未验证角标的后缀，前面跟数量。
  unverifiedBadge: '项未验证',
} as const
