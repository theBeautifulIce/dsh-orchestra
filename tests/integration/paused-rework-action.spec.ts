import { expect, it } from 'vitest'
import { sha256Hex } from '../../src/core/canonical.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { openDb, withTx } from '../../src/infra/sqlite/driver.ts'
import { registerRunArtifact } from '../../src/service/artifact-store.ts'
import { resolveDecision } from '../../src/service/commands/decisions.ts'
import { expireOrdinaryAbandon, openOrdinaryRecoveryDecision } from '../../src/service/decision/ordinary-recovery.ts'
import { getTaskSummarySnapshot, listTaskSummaries } from '../../src/service/queries/tasks.ts'
import { createReworkHost } from '../../src/service/rework-coordinator.ts'

it('stops offering a rework action when production abandonment expiry pauses its run, while retaining unresolved effect attention', () => {
  const db=openDb(':memory:')
  const at='2026-11-24T02:00:00.000Z', requested='2026-11-24T03:00:00.000Z', expired='2026-11-25T02:00:00.000Z'
  const secret='paused-rework-action',owner='service:'+sha256Hex(secret).slice(0,8)
  try {
    applySteps(db,loadSteps(defaultMigrationsDir()))
    withTx(db,tx=>{
      tx.run("INSERT INTO tasks(task_id,title,status,current_run_id,created_at,updated_at) VALUES('task','待修改报告','running','root',?,?)",[at,at])
      tx.run("INSERT INTO runs(run_id,task_id,status,workflow_id,workflow_version,created_at,updated_at) VALUES('root','task','running','workflow','1',?,?)",[at,at])
      tx.run('INSERT INTO workflow_versions(workflow_id,version,content_hash,definition_json,created_at) VALUES(?,?,?,?,?)',
        ['workflow','1','hash',JSON.stringify({nodes:[{node_id:'draft',type:'agent'},{node_id:'independent-effect',type:'agent'}],edges:[]}),at])
      tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,revision,side_effect_policy,created_at,updated_at) VALUES('draft-attempt','root','draft',1,'agent','done',1,'pure',?,?)",[at,at])
      tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,revision,side_effect_policy,executor_agent_id,created_at,updated_at) VALUES('effect','root','independent-effect',2,'agent','indeterminate_side_effect',1,'irreversible','executor',?,?)",[at,at])
      appendNodeRunEvent(tx,secret,'draft-attempt','seed',{})
      appendNodeRunEvent(tx,secret,'effect','seed',{})
      expect(openOrdinaryRecoveryDecision(tx,secret,'effect','verify_human',at,'effect-card')).toBe(true)
      resolveDecision(tx,secret,{decisionId:'effect-card',revision:1,resolution:'abandon',actor:{kind:'human',id:owner},now:at})
    })
    const artifact=registerRunArtifact(db,{artifactId:'report',runId:'root',nodeRunId:'draft-attempt',fileName:'report.md',bytes:Buffer.from('original')},at)
    const host=createReworkHost(db,secret)
    const request=host.request({operation_id:uuidv7(),run_id:'root',target_node_run_id:'draft-attempt',expected_revision:1,
      source_artifact_id:artifact.artifact_id,source_artifact_hash:artifact.sha256,reason:'补齐报告',expected_result:'补齐缺少的条目',suggested_scope:'rerun_node'},owner,requested)
    expect(getTaskSummarySnapshot(db,'task',Date.parse(requested),owner).item).toMatchObject({rework_count:1,open_decision_count:1})
    const ack=withTx(db,tx=>tx.get<{decision_id:string;run_id:string;node_run_id:null;kind:string;payload_json:string}>("SELECT * FROM decisions WHERE kind='abandon_ack'")!)
    // This is the production pause writer, not a fixture UPDATE to an invented run state.
    expect(withTx(db,tx=>expireOrdinaryAbandon(tx,secret,ack,expired))).toBe(true)
    host.recover(expired)
    expect(host.get(request.request_id,owner).item.request.status).toBe('proposed')
    expect(()=>host.review({operation_id:uuidv7(),request_id:request.request_id,expected_revision:request.revision,
      action:'authorize',note:'授权返工'},owner,expired)).toThrow(/返工只允许操作活动运行/)
    const summary=getTaskSummarySnapshot(db,'task',Date.parse(expired),owner).item
    expect(summary).toMatchObject({current_run_status:'paused',rework_count:0,open_decision_count:0,
      unverified_count:1,lane:'attention',attention:'unverified',next_action:{kind:'progress',label:'查看进度',run_id:'root'}})
    expect(listTaskSummaries(db,{actor:owner,now:Date.parse(expired)}).items[0]?.next_action).toEqual(summary.next_action)
    expect(db.raw.prepare("SELECT attention_weight FROM task_attention_order WHERE task_id='task'").get()).toMatchObject({attention_weight:5})
  } finally {db.raw.close()}
})
