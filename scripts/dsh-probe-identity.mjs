import { randomUUID } from 'node:crypto'

export function probePhase() {
  const phase = process.env.ORCHESTRA_DSH_PROBE_PHASE ?? 'S5'
  if (phase !== 'S5' && phase !== 'S6') throw new Error('ORCHESTRA_DSH_PROBE_PHASE must be S5 or S6')
  return phase
}

export function probeOperator(agent, id = 'fixture:dsh-host-operator') {
  const token = randomUUID()
  const name = 'x-orchestra-fixture-operator'
  const sessionId = agent.session.id
  return {
    id,
    headers: { [name]: token },
    resolveHttpHuman: (req) => req.headers[name] === token && agent.session.id === sessionId && agent.status !== 'unloaded'
      ? { id } : null,
    evidence: { actor: id, source: 'isolated host callback bound to live DSH parent session', session_id: sessionId, synthetic: true },
  }
}
