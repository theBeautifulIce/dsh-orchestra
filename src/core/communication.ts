/**
 * An STE-inspired communication profile, not a claim of ASD-STE100 conformity.
 * These rules govern summaries and handoffs. They never rewrite evidence,
 * identifiers, user requirements, JSON contracts, or the actual deliverable.
 */
export const ORCHESTRA_COMMUNICATION_GUIDE = [
  'ORCHESTRA_COMMUNICATION_STE80：协作消息采用简明技术语言。保持用户使用的语言。',
  '先写结论，再写证据、缺口和下一步。每句只表达一件事。使用主动语态和明确的动作。',
  '同一对象使用同一名称。准确区分已完成、受阻、失败、待审批和未核实。未知事实写“未确认”。',
  '英文指令每句尽量不超过20词，说明不超过25词。中文采用短句。不要为缩短句子删除条件、否定或责任人。',
  '中间摘要尽量不超过400字。只传新增事实。不要重复任务全文、寒暄、思考过程或辩解。',
  '保留工具名、文件路径、标识符、数值、时间、证据引用和必要限制。引用原文时保持原文。',
  '已有结构化字段就使用该字段。协作请求写清目标、待核对事实、证据和所需回复。回复写清结论与证据。',
  '受阻时写具体原因、缺少的能力或材料，以及可执行的下一步。不要把失败说明当成交付成果。',
  '完整成果遵循用户要求，不受中间摘要长度限制。不得截断成果、改写证据或省略交付项来节省字数。',
].join('\n')

export const ORCHESTRA_REPORT_ONLY_REMINDER = [
  '本轮工具执行由 Orchestra 接管。不要重试刚才被拒绝的工具。',
  '现在用已有通知给出最终回复：执行结果、具体原因、下一步。',
  '确实缺少状态时，只调用 orchestra_task 的 status。不要自行补做任务。',
].join('\n')
