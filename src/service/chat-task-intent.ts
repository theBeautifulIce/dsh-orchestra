export type ChatTaskIntent = 'conversation' | 'clarify' | 'task'

const request = /^(?:请(?!问|教)(?:你|帮我|替我)?|帮我|替我|麻烦(?:你|帮我)?|给我|能(?:不能|否)?帮我|可(?:不可以|以)帮我|我需要你|please\b|(?:can|could|would) you\b)\s*/iu
const action = /(?:读取|读一下|读(?=当前|本|这)|核对|核算|算一下|计算|统计|整理|归纳|总结|汇总|复核|校对|查阅|检查|分析|比较|对比|提取|筛选|翻译|编(?:制|写|一份)|撰写|写|起草|拟定|填写|生成|制作|导出|交付|输出|列出|发送|发布|提交|删除|覆盖|清空|转账|修(?:复|正|一下)|修改|改掉|\b(?:read|review|reconcile|calculate|summarize|analyse|analyze|compare|extract|draft|write|create|compile|generate|produce|prepare|export|deliver|delete|send|publish|fix)\b)/iu
const discussion = /(?:怎么|怎样|如何|是否|能否|为什么|教我|理解|解释|说明|评估|讨论|提供一些|给我一些|推荐|\b(?:explain|recommend|whether|how to)\b)/iu
const deliverable = /(?:报告|清单|表格|报表|汇总表|文档|纪要|方案|计划|提纲|大纲|摘要|要点|列表|草稿|初稿|简报|结论|时间表|预算|邮件|文案|公告|通知|介绍|回复|短文|文章|周报|月报|日报|净额|总额|小计|缺陷|测试|错别字|保存|\b(?:report|checklist|table|spreadsheet|document|summary|outline|draft|brief|schedule|totals|bug|tests?)\b)/iu
const localInput = /(?:已授权|获准|用户指定|本工作区|当前工作区|工作区(?:中|里)?(?:的|内)|我(?:提供|上传|附上|指定)的|刚(?:给|传|发)你的|授权样本|\b(?:authorized|approved|provided|uploaded)\b)/iu
const file = /[\p{L}\p{N}_-]\.[a-z][a-z0-9]{0,11}(?=$|[^\p{L}\p{N}_])/iu
const indirect = /^(?:请问|什么是|怎么|怎样|如何|为什么|为何|有没有|你(?:能|会|可以)做什么|假如|如果只是|假设|举例|示例|例如|[“「『「"]|```|>|(?:how|what|why|which|who|is it possible)\b)/iu
const deferred = /(?:先(?:别|不要|不用|不必)(?:实际|直接|真的?)?(?:执行|开始|启动|运行|读取|查阅|操作|做|生成|整理|分析|发送|删除|修改)|(?:不要|先别|暂不|不|无需)(?:实际|真的?)?(?:执行|开始|操作|运行|启动)|等[^。！？!?]{0,18}(?:确认|批准|指示|通知|签字)[^。！？!?]{0,7}(?:再|才)(?:开始|执行|启动|处理|操作|运行|做|继续|核对|复核|读取|生成|整理)|仅(?:提供|说明|讨论)(?:做法|思路|建议)|只(?:想知道|问|聊|解释|讨论)|\b(?:do not|don't|not yet|wait for my confirmation)\b)/iu
const management = /^(?:(?:请|帮我|替我|麻烦)\s*)?(?:取消|停止|暂停|批准|拒绝|查看|查询|告诉我)[^。！？!?]{0,28}(?:这次|这个|刚才|当前|已有|上一个|任务|运行|审批|进度|状态|结果)/u
const advice = /^(?:(?:请(?:你)?|帮我|替我|麻烦(?:你|帮我)?|给我)\s*)?(?:教我|指导我|告诉我|解释|说明|介绍一下)|^(?:(?:请|麻烦你)?\s*)?(?:给我|给我们|提供|提些|提一些)[^。！？!?]{0,70}(?:的建议|的写法|的方法|的思路|有什么建议)[。！?？\s]*$|^(?:(?:please|(?:can|could|would) you)\s+)?(?:explain|show me how|tell me (?:how|what|whether|why))\b/iu
const withheld = /^(?:(?:请|麻烦你)\s*)?(?:(?:不要|别|不用|不必|无需|暂不)(?:再|实际|直接)?(?:生成|制作|写|读取|执行|开始|发送|提交|整理|运行)|(?:仅|只)(?:做|作|进行)(?:分析|评估))/u
const reportedSpeech = /(?:^|[。；;\n])\s*(?:[^。；;！？!?\n]{0,48}(?:原话|引述|转述)|(?:以下|下面|如下)[^。；;！？!?\n]{0,28}(?:示例|例子|样例|引用)|[^。；;！？!?\n]{1,30}(?:说|表示|写道|提到)\s*[：:])/u
const operatorPivot = /[。；\n]\s*(?:我的(?:实际)?(?:任务|指令|要求)(?:是|[：:])|我现在(?:需要|想要|要)你|接下来请(?:你|帮我)|现在请(?:你|帮我)|这次请你)\s*[：:]?\s*/u
const labeledBackground = /^(?:(?:以下|下面)是(?:这次|本次|这项)?(?:任务)?背景|(?:项目|任务|本次)?背景\s*[：:])/u
const taskClause = /[。；\n]\s*(?:请(?:你|帮我)?|帮我|替我)\s*/u
const objectFrame = /^(?:把|将|使用|用|按照|按|根据|基于|对照|从|拿|为)[^。！？!?\n]{0,96}$/u
const taskHeader = /^(?:完成|执行|开展|启动|做)[ \t]*(?:一?[项个件][ \t]*)?(?:(?:名为|名叫|称为|叫作|叫做|叫)[^，,。；;：:！？!?\n]{0,64}?的)?(?:任务|工作)[ \t]*(?=$|[，,。；;：:\n])/u
const listPrefix = /^(?:\d+[.、)]|[一二三四五六七八九十]+、|[-*])\s*/u
const taskQualifier = /^(?:先|现在|直接|立即)\s*/u
const actionQualifiers = /^(?:(?:仅|只|独立|分别|并行)\s*)+/u
const actionConsultation = /(?:[,，][ \t]*(?:这(?:个|种|样|么)|是指|(?:你)?(?:能|可以)做到|(?:要|该|应当|应该)(?:用|采用|选择|怎么|怎样|如何|做什么))|是(?:默认行为|规定|惯例))[^。！？!?\n]*\?/u
// A question about performing the proposed work stays in chat even when it names files or deliverables.
const asksAboutExecution = /(?:可行(?:吗|么)|(?:应该|应当|该)?(?:怎么|怎样|如何)(?:做|操作|实现|执行)|[,，]\s*(?:你)?(?:能否|能不能|能|可以|可不可以)?(?:讲讲|解释|说明)(?:一下)?(?:实现)?(?:思路|方法|做法)(?:吗|么)?)\s*\?\s*$/u
const consultationOnly = /(?:我(?:们)?\s*)?只(?:是|想|是想)(?:讨论|了解(?:能力|可行性|怎么|怎样|如何)|问问)|不(?:会|需要)?实际做/u

function actionIsDirect(prefix: string): boolean {
  // A concrete object or source can precede the principal action in Chinese.
  return !prefix || (objectFrame.test(prefix) && !discussion.test(prefix))
}

function isConversationClause(clause: string): boolean {
  return clause.endsWith('?') || indirect.test(clause) || management.test(clause) || advice.test(clause) || withheld.test(clause)
}

function classifyTaskDetails(details: string): ChatTaskIntent {
  const instructions = details.replace(/```[\s\S]*?(?:```|$)/gu, ' ')
  const clauses = (instructions.match(/[^。；;!?\n]+[!?]?/gu) ?? [])
    .map((clause) => clause.trim().replace(listPrefix, '').trim())
  const hasAction = clauses.some((clause) => {
    if (isConversationClause(clause)) return false
    const body = clause.replace(request, '').replace(taskQualifier, '').replace(actionQualifiers, '')
    const predicate = action.exec(body)
    return !!predicate && actionIsDirect(body.slice(0, predicate.index))
  })
  if (!hasAction && clauses.some((clause) => isConversationClause(clause) || discussion.test(clause))) return 'conversation'
  if (hasAction && (deliverable.test(instructions) || file.test(instructions) || localInput.test(instructions))) return 'task'
  return 'clarify'
}

/** Classify an authenticated operator message before the conversation model can act. */
export function classifyChatTask(text: string): ChatTaskIntent {
  const input = text.trim().normalize('NFKC')
  if (!input || deferred.test(input) || withheld.test(input)) return 'conversation'
  const unquoted = input.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/gu, ' ')
  const pivot = operatorPivot.exec(unquoted)
  const reported = reportedSpeech.test(unquoted) || /^(?:这是(?:一个|一条)?测试案例|请看以下示例|假如|假设|例如|例子)/u.test(input)
  if (reported && !pivot) return 'conversation'
  const backgroundTask = !reported && labeledBackground.test(unquoted) ? taskClause.exec(unquoted) : null
  const owned = pivot ?? backgroundTask
  const directive = (owned ? '请' + unquoted.slice(owned.index + owned[0].length) : unquoted)
    .trim().replace(/^(?:最后|现在|接下来|然后|因此)[，,：:\s]*/u, '')
  if (indirect.test(directive) || management.test(directive) || advice.test(directive)) return 'conversation'
  const body = directive.replace(request, '').replace(taskQualifier, '')
  if (!body) return 'conversation'
  const header = taskHeader.exec(body)
  if (header) return classifyTaskDetails(body.slice(header[0].length).replace(/^[，,：:]/u, ''))
  const details = body.replace(actionQualifiers, '')
  if (asksAboutExecution.test(details) || (details !== body && (actionConsultation.test(details) || consultationOnly.test(details)))) return 'conversation'
  const predicate = action.exec(details)
  if (!predicate) return /^(?:处理|做一下|跟进|弄一下|办一下)/u.test(body) && body !== directive ? 'clarify' : 'conversation'
  // Arbitrary prefixes cannot turn a later example or discussed action into an assignment.
  if (!actionIsDirect(details.slice(0, predicate.index))) return 'conversation'
  if (deliverable.test(details) || file.test(input) || localInput.test(details)) return 'task'
  return 'clarify'
}
