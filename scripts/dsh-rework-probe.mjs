// Run after pnpm build, passing the installed DSH CLI entry (dsh/lib/bin.js).
// Set ORCHESTRA_DSH_PROBE_PHASE=S6 and ORCHESTRA_DSH_REWORK_ESCALATION=1 for the escalation scenario.
// Use ORCHESTRA_DSH_REWORK_ESCALATION=automatic to require diagnosis during normal dispatch.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { uuidv7 } from '../src/core/ids.ts'
import { probeOperator, probePhase } from './dsh-probe-identity.mjs'

const self = fileURLToPath(import.meta.url)
const PROVIDER = 'orchestra-rework-probe'
const PARENT = 'probe-lead'
const SOURCE = 'probe-source'
const TARGET = 'probe-verifier'
const PLANNER = 'probe-diagnostic-planner'
const FLOW = 'native-rework-probe'
const TOOL = 'ro.verify_fixture'
const REJECTION_NOTES = ['第三章把毫秒误作秒，必须按测量单位重新核对', '第三章仍未标明测量时间，无法核对同一份原始读数']
const escalationMode = process.env.ORCHESTRA_DSH_REWORK_ESCALATION
const escalationEnabled = escalationMode === '1' || escalationMode === 'automatic'

export const name = 'orchestra-rework-probe'
export const inject = ['agents', 'tools', 'llm', 'appExit']

export function apply(context) {
  void verifyInDsh(context).then((proof) => {
    console.log('ORCHESTRA_REWORK_PROBE ' + JSON.stringify(proof))
    context.get('appExit')(0)
  }, (error) => {
    console.error(error?.stack ?? error)
    context.get('appExit')(1)
  })
}


async function verifyInDsh(context) {
  const stage = probePhase()
  const escalate = escalationEnabled
  if (escalate && stage !== 'S6') throw new Error('Escalation probe requires S6')
  const entry = process.env.ORCHESTRA_DSH_TEST_ENTRY
  const { serveDshOrchestra, ToolRegistry, ReadOnlyToolRunner } = await import(entry ? pathToFileURL(entry).href : '../lib/index.js')
  const cwd = process.cwd(), secret = randomUUID(), uses = []
  const parent = await context.agents.create({ sessionId: randomUUID(), meta: { cwd }, agentOptions: { provider: PROVIDER, model: PARENT } })
  const operator = probeOperator(parent.agent)
  const otherSession = stage === 'S6'
    ? await context.agents.create({ sessionId: randomUUID(), meta: { cwd }, agentOptions: { provider: PROVIDER, model: PARENT } }) : null
  const otherOperator = otherSession ? probeOperator(otherSession.agent, 'fixture:dsh-non-owner') : null
  const registry = new ToolRegistry()
  const measurement = [
    "const { createHash } = require('node:crypto')",
    'const bytes = Buffer.alloc(1024 * 1024, 65)',
    'const sample_id = Date.now()',
    'const start = process.hrtime.bigint()',
    "const digest = createHash('sha256').update(bytes).digest('hex')",
    'const latency_ms = Number(process.hrtime.bigint() - start) / 1e6',
    'process.stdout.write(JSON.stringify({sample_id, latency_ms, digest}))',
  ].join(';')
  registry.register({ name: TOOL, capability: 'read_only', command: { bin: process.execPath, args: ['-e', measurement] } })
  const runner = new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true, async run({ bin, args, cwd, timeoutMs }) {
    return { ...await promisify(execFile)(bin, args, { cwd, timeout: timeoutMs, windowsHide: true }), exitCode: 0 }
  } }, cwd)
  let service
  try {
    service = await serveDshOrchestra({ dbFile: join(cwd, 'orchestra.sqlite'), secret, phase: stage, tools: { registry, runner },
      ...(stage === 'S6' ? { resolveHttpHuman: (req) => operator.resolveHttpHuman(req) ?? otherOperator.resolveHttpHuman(req) } : {}),
      ...(escalate ? { dshPlanner: { parent: () => parent.agent, model: { provider: PROVIDER, model: PLANNER } } } : {}),
      dsh: { context, parentForNode: () => parent.agent, models: [{ ref: 'approved/source', capacity: 'routine', provider: PROVIDER, model: SOURCE },
        ...(escalate ? [{ ref: 'approved/stronger', capacity: 'expert', provider: PROVIDER, model: TARGET }] : [])],
        recommend: () => ({ complexity: 'routine', reason: '真实返工工具验收' }), onModelUse: usage => uses.push(usage) },
      asOfSeq: () => Number(service?.orchestra.db.raw.prepare('SELECT MAX(seq) AS seq FROM events').get().seq ?? 0),
      listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => {} })
    const call = async (path, body, bind = true) => {
      const response = await fetch(new URL(path, service.endpoint), { headers: { 'x-orchestra-secret': secret, 'content-type': 'application/json',
        ...(stage === 'S6' && bind ? (bind === 'other' ? otherOperator.headers : operator.headers) : {}) },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
      const envelope = await response.json()
      if (!envelope.ok) throw Object.assign(new Error(path + ': ' + JSON.stringify(envelope.error)), { code: envelope.error?.code })
      return envelope.data
    }
    assert.equal((await call('/health')).phase, stage)
    const nodes = async run => (await call('/v1/node-runs?run_id=' + run)).items
    const latest = async (run, id) => (await nodes(run)).filter(n => n.node_id === id).sort((a,b) => b.attempt-a.attempt)[0]
    const artifacts = async run => (await call('/v1/artifacts?run_id=' + run)).items
    const artifactOf = async (run, node) => (await artifacts(run)).find(a => a.source_node_run_id === node.node_run_id)
    const poll = async (read, predicate, message) => {
      for (let i=0;i<75;i++) { const value = await read(); if(predicate(value))return value; await new Promise(r=>setTimeout(r,200)) }
      throw new Error(message)
    }
    const run = (node, phase) => call('/v1/node-runs/run', { nodeRunId: node.node_run_id, nodeId: node.node_id, attempt: node.attempt,
      input: { probe_phase: phase }, outputSchema: { type: 'object' }, tools: [{ command: TOOL, args: [], cwd, timeoutMs: 15000 }],
      ownerEpoch: service.orchestra.db.epoch, leaseTtlMs: 30000 })
    const definition = { name: '原生 DSH 反馈修订报告', nodes: [ { node_id: 'trigger', type: 'trigger', title: '发起', position: {x:0,y:0} },
      ...['a','b','c'].map((node_id,i) => ({ node_id, type: 'agent', title: node_id.toUpperCase(), position: {x:i*200,y:100},
        config: { tools: { allow: [TOOL] }, side_effect_policy: 'pure', pass_conditions: [{ path:'evidence.exitCode',op:'eq',value:0 }] } })) ],
      edges: [{from:'trigger',to:'a'},{from:'a',to:'b'},{from:'b',to:'c'}] }
    const draft = await call('/v1/workflows',{workflow_id:FLOW,name:definition.name,definition,operation_id:uuidv7()})
    assert.equal((await call('/v1/workflows/test',{workflow_id:FLOW,revision:draft.revision})).passed,true)
    await call('/v1/workflows/publish',{workflow_id:FLOW,base_version:0,revision:draft.revision,publish_note:'返工闭环隔离验收',operation_id:uuidv7()})
    const started = await call('/v1/runs/start',{workflowId:FLOW,workflowVersion:'1',taskTitle:definition.name,operationId:uuidv7()})
    const runId = started.run_id
    const c1 = await latest(runId,'c')
    let launchActor
    if (stage === 'S6') {
      launchActor = service.orchestra.db.raw.prepare('SELECT started_by FROM start_run_operations WHERE run_id=?').get(runId).started_by
      assert.equal(launchActor, operator.id)
      const withoutOwner = (identity) => call('/v1/rework/hold',
        { operation_id: uuidv7(), run_id: runId, node_run_id: c1.node_run_id, action: 'hold' }, identity)
      await assert.rejects(withoutOwner(false), { code: 'FORBIDDEN' })
      await assert.rejects(withoutOwner('other'), { code: 'FORBIDDEN' })
    }
    await call('/v1/rework/hold',{operation_id:uuidv7(),run_id:runId,node_run_id:c1.node_run_id,action:'hold'})
    const a1 = await latest(runId,'a')
    assert.equal((await run(a1,'A1')).final_status,'done')
    const v1 = await artifactOf(runId,a1)
    assert.ok(v1)
    const b1 = await latest(runId,'b')
    await assert.rejects(run(b1,'B1'), { code: 'STALE_GENERATION' })
    assert.equal((await call('/v1/node-runs/get?node_run_id='+b1.node_run_id)).status, 'superseded')
    let first = (await call('/v1/rework?run_id='+runId)).items[0]
    assert.equal(first.status,'scheduled')
    assert.equal((await latest(runId,'a')).attempt,2)
    assert.equal((await call('/v1/node-runs/get?node_run_id='+a1.node_run_id)).status,'done')
    const a2 = await latest(runId,'a')
    assert.equal((await run(a2,'A2')).final_status,'done')
    first = await poll(async () => (await call('/v1/rework/get?request_id='+first.request_id)).item.request, r=>r.status==='awaiting_review','A2 never became reviewable')
    const b2 = await latest(runId,'b')
    assert.equal(b2.attempt,2)
    assert.equal((await run(b2,'B2')).final_status,'done')
    assert.equal((await call('/v1/rework/get?request_id='+first.request_id)).item.request.status,'closed')
    assert.equal((await run(c1,'C1')).final_status,'done')
    const report1 = await artifactOf(runId,c1)
    const reportNode = await latest(runId,'c')
    let human = await call('/v1/rework/request',{operation_id:uuidv7(),run_id:runId,target_node_run_id:reportNode.node_run_id,
      source_artifact_id:report1.artifact_id,source_artifact_hash:report1.sha256,expected_revision:reportNode.revision,
      reason:'第三章缺少真实性能对比图说明',expected_result:'第三章补充真实数据对照，保留其他章节',preserve_requirements:['保留第一、二章'],suggested_scope:'targeted_revision',evidence_ids:[]})
    if (human.status==='proposed') human=await call('/v1/rework/review',{operation_id:uuidv7(),request_id:human.request_id,expected_revision:human.revision,action:'authorize',note:'同意定向修改第三章'})
    const c2=await latest(runId,'c')
    assert.equal(c2.attempt,2)
    assert.equal((await run(c2, escalate ? 'C2_REJECTED' : 'C2')).final_status,'done')
    human=await poll(async () => (await call('/v1/rework/get?request_id='+human.request_id)).item.request,r=>r.status==='awaiting_review','C2 never became reviewable')
    const report2=await artifactOf(runId,c2)
    let finalNode = c2, finalArtifact = report2, escalation
    if (escalate) {
      const rejected = []
      let explicitDiagnosis
      for (const [index, note] of REJECTION_NOTES.entries()) {
        const review = (action, note, artifact) => call('/v1/rework/review', { operation_id: uuidv7(), request_id: human.request_id,
          expected_revision: human.revision, action, note,
          ...(artifact ? { artifact_id: artifact.artifact_id, artifact_hash: artifact.sha256 } : {}) })
        human = await review('request_changes', note, finalArtifact)
        assert.equal(human.status, 'proposed')
        rejected.push({ attempt: finalNode.attempt, node_run_id: finalNode.node_run_id,
          artifact_id: finalArtifact.artifact_id, sha256: finalArtifact.sha256, note })
        if (index === 1 && escalationMode !== 'automatic') {
          const diagnosticPath = '/v1/model-escalation'
          const { precondition } = await call(diagnosticPath + '?run_id=' + runId + '&node_run_id=' + finalNode.node_run_id)
          assert.ok(precondition && precondition.expected_attempt === 3)
          explicitDiagnosis = await call(diagnosticPath, { ...precondition, operation_id: uuidv7() })
          assert.equal(explicitDiagnosis.model_ref, 'approved/stronger')
        }
        human = await review('authorize', '授权修订这份交付')
        assert.equal(human.status, 'scheduled')
        finalNode = await latest(runId, 'c')
        assert.equal(finalNode.attempt, index + 3)
        const result = await run(finalNode, index === 0 ? 'C3_REJECTED' : 'C4_ESCALATED')
        assert.equal(result.final_status, 'done', JSON.stringify(result))
        human = await poll(async () => (await call('/v1/rework/get?request_id=' + human.request_id)).item.request,
          (item) => item.status === 'awaiting_review', 'Revision never became reviewable')
        finalArtifact = await artifactOf(runId, finalNode)
        assert.ok(finalArtifact)
      }
      assert.notEqual(rejected[0].artifact_id, rejected[1].artifact_id)
      assert.notEqual(rejected[0].sha256, rejected[1].sha256)
      const diagnosis = await call('/v1/model-escalation?run_id=' + runId + '&node_run_id=' + rejected[1].node_run_id)
      assert.equal(diagnosis.item.outcome, 'recommended')
      assert.equal(diagnosis.item.trigger, 'repeated_rework')
      assert.equal(diagnosis.item.model_ref, 'approved/stronger')
      assert.equal(diagnosis.successor_node_run_id, finalNode.node_run_id)
      assert.deepEqual(diagnosis.dispatch, { model_ref: 'approved/stronger', state: 'confirmed', provider: PROVIDER, model: TARGET })
      const history = (await call('/v1/rework/get?request_id=' + human.request_id)).item
      const reviews = history.reviews.filter(({ action }) => action === 'request_changes')
      for (const item of rejected) {
        const review = reviews.find(({ artifact_id }) => item.artifact_id === artifact_id)
        assert.ok(review && review.artifact_hash === item.sha256 && review.note === item.note)
        assert.equal(review.reviewer_actor, operator.id)
        assert.ok(diagnosis.item.evidence_ids.includes(review.review_id))
        item.review_id = review.review_id
      }
      const session = uses.find(({ nodeRunId }) => nodeRunId === finalNode.node_run_id)
      assert.ok(session && session.model === TARGET && session.attempt === 4)
      assert.equal(uses.filter(({ model }) => model === TARGET).length, 1)
      if (explicitDiagnosis) assert.equal(diagnosis.item.decided_at, explicitDiagnosis.decided_at)
      escalation = { assessment_path: explicitDiagnosis ? 'operator-confirmed HTTP diagnosis' : 'automatic pre-dispatch diagnosis',
        rejected, diagnosis, stronger_session: session }
    }
    await call('/v1/rework/review',{operation_id:uuidv7(),request_id:human.request_id,expected_revision:human.revision,action:'accept',note:'第三章修改符合要求',artifact_id:finalArtifact.artifact_id,artifact_hash:finalArtifact.sha256})
    assert.equal((await call('/v1/runs/get?run_id='+runId)).status,'running','manual hold must prevent premature success')
    await call('/v1/rework/hold',{operation_id:uuidv7(),run_id:runId,node_run_id:finalNode.node_run_id,action:'accept',artifact_id:finalArtifact.artifact_id,sha256:finalArtifact.sha256})
    await call('/v1/runs/dispatch',{runId,nodes:{}})
    const closed=await call('/v1/runs/get?run_id='+runId)
    assert.equal(closed.status,'succeeded')
    const before=await call('/v1/artifacts/content?run_id='+runId+'&artifact_id='+v1.artifact_id+'&mode=preview')
    const after=await call('/v1/artifacts/content?run_id='+runId+'&artifact_id='+finalArtifact.artifact_id+'&mode=preview')
    const baseline = /^sample_id,latency_ms\n(\d+),([\d.]+)$/.exec(before.text)
    assert.ok(baseline && Number(baseline[2]) > 0)
    const all=await nodes(runId)
    const firstHistory=(await call('/v1/rework/get?request_id='+first.request_id)).item
    const humanHistory=(await call('/v1/rework/get?request_id='+human.request_id)).item
    assert.equal(firstHistory.reviews.at(-1).action,'accept')
    assert.equal(humanHistory.reviews.at(-1).action,'accept')
    if (stage === 'S6') assert.equal(humanHistory.reviews.at(-1).reviewer_actor, operator.id)
    assert.ok(uses.length>=6)
    assert.equal(new Set(uses.map(u=>u.sessionId)).size,escalate ? 8 : 6,'each attempt must use a fresh native DSH session')
    assert.notEqual(report1.artifact_id,finalArtifact.artifact_id)
    const preserved = '第一章：目标\n第二章：对 1 MiB 数据计算 SHA-256\n'
    assert.equal(after.text, preserved + '第三章：实测耗时 ' + baseline[2] + ' ms，采样时间 ' + new Date(Number(baseline[1])).toISOString())
    return {phase:stage,...(stage === 'S6' ? { identity: operator.evidence, launchActor, nonOwner: otherOperator.evidence,
      deniedWithoutBinding: 'FORBIDDEN', deniedAsNonOwner: 'FORBIDDEN' } : {}),
      runId,agentRequest:first.request_id,humanRequest:human.request_id,oldArtifact:v1.artifact_id,revisedReport:finalArtifact.artifact_id,
      ...(escalation ? { escalation } : {}),
      nodes:all.map(n=>({id:n.node_id,attempt:n.attempt,status:n.status})),dshSessions:new Set(uses.map(u=>u.sessionId)).size,
      modelUseObservations:uses.length,sampleLatencyMs:Number(baseline[2]),status:closed.status}
  } finally { try { await service?.close() } finally { await Promise.all([parent.dispose(), otherSession?.dispose()]) } }
}
function parseToolReply(message) {
  const text=Array.isArray(message.content)?message.content.map(b=>b.text??'').join(''):message.content
  const value=JSON.parse(text)
  return typeof value?.text==='string' && value.text.trimStart().startsWith('{') ? JSON.parse(value.text) : value
}
const proof = () => ['orchestra_read_tool',{tool:TOOL,args:[]}]
const feedback=(action,args={})=>['orchestra_rework',{action,...args}]
function stepsFor(phase,ctx) {
  const publish=(text,file_name)=>()=>feedback('publish',{...(phase==='C1'?{}:{operation_id:uuidv7()}),file_name,text})
  const readInput = () => feedback('read',{artifact_id:ctx.inputs[0].artifact_id,artifact_hash:ctx.inputs[0].artifact_hash})
  if(phase==='A1')return [proof,([e])=>{
    const sample = JSON.parse(e.stdout)
    assert.ok(sample.latency_ms > 0 && sample.digest.length === 64)
    return publish('sample_id,latency_ms\n' + sample.sample_id + ',' + sample.latency_ms,'data.csv')()
  }]
  if(phase==='B1') {
    assert.equal(ctx.inputs.length,1)
    const source=ctx.inputs[0]
    return [()=>feedback('read',{artifact_id:source.artifact_id,artifact_hash:source.artifact_hash}),proof,
      ([,e])=>feedback('request',{operation_id:uuidv7(),run_id:ctx.run_id,target_node_run_id:source.upstream_node_run_id,source_artifact_id:source.artifact_id,
        source_artifact_hash:source.artifact_hash,expected_revision:source.expected_revision,reason:'缺少 timestamp 字段，无法分析时序',expected_result:'补充实际采集时间，保留 latency_ms',preserve_requirements:['保留 latency_ms'],suggested_scope:'targeted_revision',evidence_ids:[e.evidenceId]})]
  }
  if(phase==='A2') {
    assert.match(ctx.revision.reason,/timestamp/)
    return [()=>feedback('read',{artifact_id:ctx.revision.source_artifact_id,artifact_hash:ctx.revision.source_artifact_hash}),proof,([source])=>{
      const [id, latency] = source.text.split('\n')[1].split(',')
      return publish('sample_id,latency_ms,timestamp\n'+[id,latency,new Date(Number(id)).toISOString()].join(','),'data.csv')()
    }]
  }
  if(phase==='B2') {
    assert.ok(ctx.review)
    return [()=>feedback('read',{artifact_id:ctx.review.result_artifact_id,artifact_hash:ctx.review.result_artifact_hash}),proof,
      ([content,e])=>{assert.match(content.text,/timestamp/);return feedback('accept',{operation_id:uuidv7(),request_id:ctx.review.request_id,expected_revision:ctx.review.revision,artifact_id:ctx.review.result_artifact_id,artifact_hash:ctx.review.result_artifact_hash,note:'新数据有真实采集时间，可以继续分析',evidence_ids:[e.evidenceId]})},([content])=>{
        const [, latency, at] = content.text.split('\n')[1].split(',')
        return publish('实测耗时 '+latency+' ms，采样时间 '+at,'analysis.txt')()
      }]
  }
  if(phase==='C1')return [readInput,proof,publish('第一章：目标\n第二章：对 1 MiB 数据计算 SHA-256\n第三章：待完善','report.txt')]
  assert.ok(['C2','C2_REJECTED','C3_REJECTED','C4_ESCALATED'].includes(phase), phase)
  assert.match(ctx.revision.reason,/第三章/)
  return [()=>feedback('read',{artifact_id:ctx.revision.source_artifact_id,artifact_hash:ctx.revision.source_artifact_hash}),readInput,proof,
    ([old,analysis])=>{
      const measured = phase === 'C2_REJECTED' ? analysis.text.replace(' ms', ' 秒')
        : phase === 'C3_REJECTED' ? analysis.text.split('，')[0] : analysis.text
      return publish(old.text.replace(/第三章：.*/, '第三章：'+measured),'report.txt')()
    }]
}

async function main(bin) {
  if (!bin) throw new Error('Pass the installed DSH CLI entry path.')
  const root = await mkdtemp(join(tmpdir(), 'orchestra-dsh-rework-'))
  const trace = []
  const modelInputs = []
  const failures = []
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const request = JSON.parse(raw)
      const serialized = request.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
      const phase = /\"probe_phase\"\s*:\s*\"(A1|A2|B1|B2|C1|C2|C2_REJECTED|C3_REJECTED|C4_ESCALATED)\"/.exec(serialized)?.[1]
      let delta, hasTool = false
      if (request.model === PLANNER) {
        const diagnosis = serialized.split('\n').map(line => {
          try { return JSON.parse(line) } catch { return null }
        }).find((message) => message?.purpose === 'model_escalation')
        assert.ok(diagnosis)
        assert.equal(diagnosis.trigger, 'repeated_rework')
        assert.equal(diagnosis.node_id, 'c')
        assert.equal(diagnosis.attempt, 3)
        const rejected = diagnosis.facts.filter(({ kind }) => kind === 'artifact_rejected')
        assert.deepEqual(rejected.map(({ detail }) => detail.note).sort(), [...REJECTION_NOTES].sort())
        assert.ok(diagnosis.available_upgrades.some(({ ref, model, capacity }) =>
          ref === 'approved/stronger' && model === TARGET && capacity === 'expert'))
        modelInputs.push({ trigger: diagnosis.trigger, node_id: diagnosis.node_id, attempt: diagnosis.attempt, rejected,
          available_models: diagnosis.available_upgrades })
        delta = { role: 'assistant', content: JSON.stringify({ classification: 'model_capability', model_ref: 'approved/stronger',
          reason: '两次修订先误读测量单位，后遗漏同一测量的时间，需更强模型核对源材料与交付约束。',
          evidence_ids: rejected.map(({ id }) => id) }) }
      } else {
        assert.ok(phase, serialized)
        const marker = serialized.lastIndexOf('本次运行的成果与修订上下文：')
        assert.ok(marker >= 0, 'trusted execution context missing')
        const context = JSON.parse(serialized.slice(marker).split('\n')[0].slice('本次运行的成果与修订上下文：'.length))
        const steps = stepsFor(phase, context)
        assert.equal(request.model, phase === 'C4_ESCALATED' ? TARGET : SOURCE)
        const replies = request.messages.filter((item) => item.role === 'tool').map(parseToolReply)
        const call = steps[replies.length]?.(replies)
        if (call) assert.ok(request.tools?.some((tool) => tool.function.name === call[0]), 'expected registered tool')
        trace.push([phase, call?.[1].action ?? call?.[0] ?? 'done', request.model])
        hasTool = Boolean(call)
        delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'probe_step_' + replies.length, type: 'function',
          function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
          : { role: 'assistant', content: '{"status":"done","output":{"ok":true}}' }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: hasTool ? 'tool_calls' : 'stop' }]) {
        res.write('data: ' + JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, ...choice }] }) + '\n\n')
      }
      res.end('data: [DONE]\n\n')
    } catch (error) {
      failures.push(String(error))
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  await new Promise((done) => provider.listen(0, '127.0.0.1', done))
  try {
    const patch = join(root, 'probe.patch.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'headless-runner', disabled: true },
      { id: 'llm-pi-ai', config: { providers: { [PROVIDER]: {
        api: 'openai-completions', apiKeyEnv: 'ORCHESTRA_DSH_PROBE_KEY', baseURL: 'http://127.0.0.1:' + provider.address().port + '/v1',
        models: [PARENT, SOURCE, TARGET, PLANNER].map((id) => ({ id, contextWindow: 32768, maxTokens: 8192, input: ['text'] })),
      } } } },
      { insert: [{ id: name, name: self.replaceAll('\\', '/') }] },
    ]))
    const result = await promisify(execFile)(process.execPath, [resolve(bin), '--profile', 'headless', '--patch', patch, 'Orchestra rework probe'], {
      cwd: root, timeout: 115_000, windowsHide: true, env: { ...process.env, DSH_HOME: join(root, 'dsh'), ORCHESTRA_DSH_PROBE_KEY: 'loopback-fixture' },
    }).catch((error) => {
      throw new Error(String(error.stderr) + '\n' + String(error.stdout) + '\n' + failures.join('\n'), { cause: error })
    })
    const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith('ORCHESTRA_REWORK_PROBE '))
    assert.ok(line, result.stdout + '\n' + result.stderr)
    assert.ok(trace.some(t => t[0] === 'B1' && t[1] === 'request'))
    assert.ok(trace.some(t => t[0] === 'B2' && t[1] === 'accept'))
    console.log(line)
    console.log('Native DSH tool actions: ' + JSON.stringify(trace))
    if (escalationEnabled) {
      assert.ok(modelInputs.length > 0 && trace.some(t => t[0] === 'C4_ESCALATED' && t[2] === TARGET))
      console.log('Native DSH planner input: ' + JSON.stringify(modelInputs))
    }
  } finally {
    await new Promise((done) => provider.close(done))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === self) await main(process.argv[2])
