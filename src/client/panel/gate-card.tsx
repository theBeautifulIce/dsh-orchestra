import type { ReleaseGateCardState } from '../../service/release-workflow.ts'

const content = {
  idle: ['等待冻结证据', '发布负责人', '从受信工作区启动核验'],
  checking: ['检查组正在核验', '发布执行器', '等待六组检查完成'],
  approval: ['判卷通过，等待人工确认', '获授权的审批人', '在受信工作区完成二次确认'],
  blocked: ['检查组证据尚未收齐', '发布负责人', '核对缺失的检查组'],
  failed: ['本次核验未通过', '发布负责人', '查看未通过的必过项'],
  confirmed: ['运行已确认，等待独立联检', '独立核验人', '核对独立判卷与发布判卷'],
} as const

export function GateCard({ state }: { state: ReleaseGateCardState }) {
  const [conclusion, waitingOn, nextAction] = content[state]
  return <section aria-labelledby="release-gate-title" className="ops-surface">
    <header className="ops-surface-head"><h2 id="release-gate-title">S6 · G6 发布门</h2></header>
    <p>{conclusion}</p>
    <dl>
      <div><dt>当前负责人</dt><dd>{waitingOn}</dd></div>
      <div><dt>下一步</dt><dd>{nextAction}</dd></div>
    </dl>
  </section>
}
