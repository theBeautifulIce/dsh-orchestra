import { expect, it } from 'vitest'
import { sha256Hex } from '../../src/core/canonical.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { registerRunArtifact } from '../../src/service/artifact-store.ts'
import { createReworkHost, type ReworkRequest } from '../../src/service/rework-coordinator.ts'
import { createDeliveryReviewHost } from '../../src/service/delivery-review.ts'
import { callDshRework } from '../../src/service/dsh-rework.ts'
import { latestReworkFiles, type ReworkFile, type ReworkFileManifest } from '../../src/service/rework-manifest.ts'
import { listChatDeliveryReviews } from '../../src/service/chat-delivery-review.ts'
import { snapshotArtifactInputs } from '../../src/service/rework-runtime.ts'
import { freshLedger, TEST_SECRET } from '../fixtures/ledger.ts'

const NOW='2026-11-24T01:00:00.000Z', LATER='2026-11-24T01:00:01.000Z'
const OWNER='service:'+sha256Hex(TEST_SECRET).slice(0,8)
function fixture() {
  const {db}=freshLedger()
  withTx(db,tx=>{
    tx.run("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','多文件报告','running',?,?)",[NOW,NOW])
    tx.run("INSERT INTO runs(run_id,task_id,status,workflow_id,workflow_version,created_at,updated_at) VALUES('r','t','running','wf','1',?,?)",[NOW,NOW])
    tx.run('INSERT INTO workflow_versions(workflow_id,version,content_hash,definition_json,created_at) VALUES(?,?,?,?,?)',
      ['wf','1','hash',JSON.stringify({nodes:[{node_id:'draft',type:'agent'},{node_id:'consumer',type:'agent'}],edges:[{from:'draft',to:'consumer'}]}),NOW])
    for(const [id,node,status] of [['old','draft','done'],['consumer','consumer','queued']]) {
      tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,revision,action_generation,side_effect_policy,created_at,updated_at) VALUES(?,'r',?,?,'agent',?,1,1,'pure',?,?)",[id,node,id==='old'?1:2,status,NOW,NOW])
      appendNodeRunEvent(tx,TEST_SECRET,id!,'seed',{})
    }
  })
  const put=(id:string,name:string,text:string)=>({
    ...registerRunArtifact(db,{artifactId:id,runId:'r',nodeRunId:'old',fileName:name,bytes:Buffer.from(text)},NOW),file_name:name})
  const original=put('original','report.md','old report'), preserved=put('preserved','data.csv','name,value\nA,1')
  const removed=put('removed','obsolete.txt','outdated notes')
  const manifest:ReworkFileManifest={originals:[
    {artifact_id:original.artifact_id,sha256:original.sha256,file_name:'report.md',action:'revise'},
    {artifact_id:preserved.artifact_id,sha256:preserved.sha256,file_name:'data.csv',action:'keep'},
    {artifact_id:removed.artifact_id,sha256:removed.sha256,file_name:'obsolete.txt',action:'remove'},
  ],attachments:['audit.md']}
  const body={operation_id:uuidv7(),run_id:'r',target_node_run_id:'old',source_artifact_id:'original',source_artifact_hash:original.sha256,
    expected_revision:1,reason:'更正报告并提供核对记录',expected_result:'保留数据，撤去过期说明，提交报告与核对记录',file_manifest:manifest}
  const host=createReworkHost(db,TEST_SECRET)
  return {db,host,manifest,body,preserved,removed}
}
function start(db:Db,row:ReworkRequest) {
  withTx(db,tx=>tx.run("UPDATE node_runs SET status='started',lease_id='test-lease',lease_expires_at='2026-11-24T02:00:00.000Z' WHERE node_run_id=?",[row.new_node_run_id]))
  return db.raw.prepare('SELECT node_run_id,attempt,action_generation FROM node_runs WHERE node_run_id=?').get(row.new_node_run_id!) as {node_run_id:string;attempt:number;action_generation:number}
}
function publish(db:Db,host:ReturnType<typeof createReworkHost>,binding:ReturnType<typeof start>,name:string,text:string) {
  return callDshRework(db,host,binding,{action:'publish',operation_id:uuidv7(),file_name:name,text},NOW,TEST_SECRET)
}
function done(db:Db,row:ReworkRequest) {withTx(db,tx=>tx.run("UPDATE node_runs SET status='done',revision=revision+1 WHERE node_run_id=?",[row.new_node_run_id]))}
function result(db:Db,row:ReworkRequest) {return withTx(db,tx=>latestReworkFiles(tx,'r',row.new_node_run_id!))}
function accept(host:ReturnType<typeof createReworkHost>,row:ReworkRequest,file:ReworkFile) {
  return host.review({operation_id:uuidv7(),request_id:row.request_id,expected_revision:row.revision,action:'accept',
    artifact_id:file.artifact_id,artifact_hash:file.sha256,note:'已逐份读取核对'},OWNER,LATER)
}

it('freezes every original and attachment, enforces native publication, resumes and accepts every exact version',()=>{
  const {db,host,body,manifest,preserved,removed}=fixture()
  let reopened:Db|undefined
  try {
    const scheduled=host.request(body,OWNER,NOW)
    expect(scheduled.status).toBe('scheduled')
    expect(JSON.parse(host.get(scheduled.request_id,OWNER).item.attempts[0]!.file_manifest_json!)).toEqual(manifest)
    const binding=start(db,scheduled)
    expect(()=>publish(db,host,binding,'unexpected.md','unapproved attachment')).toThrow(/未在本轮/)
    expect(()=>publish(db,host,binding,'data.csv','changed kept file')).toThrow(/未在本轮/)
    expect(()=>callDshRework(db,host,binding,{action:'read',artifact_id:removed.artifact_id,artifact_hash:removed.sha256},NOW)).toThrow(/输入范围/)
    expect(callDshRework(db,host,binding,{action:'read',artifact_id:preserved.artifact_id,artifact_hash:preserved.sha256},NOW)).toMatchObject({text:'name,value\nA,1'})
    publish(db,host,binding,'report.md','corrected report')
    publish(db,host,binding,'audit.md','checked every row')
    done(db,scheduled)
    reopened=openDb(db.file)
    const resumed=createReworkHost(reopened,TEST_SECRET)
    resumed.recover(LATER);resumed.recover(LATER)
    let row=resumed.get(scheduled.request_id,OWNER).item.request
    const files=result(reopened,row)
    expect(files.map(file=>file.file_name)).toEqual(['audit.md','data.csv','report.md'])
    expect(files.find(file=>file.file_name==='data.csv')!.sha256).toBe(preserved.sha256)
    expect(files.find(file=>file.file_name==='data.csv')!.artifact_id).not.toBe(preserved.artifact_id)
    expect(listChatDeliveryReviews(reopened,'r',OWNER,Date.parse(LATER)).map(item=>item.artifact!.artifact_id).sort()).toEqual(files.map(file=>file.artifact_id).sort())
    const stale=row
    row=accept(resumed,row,files[0]!)
    expect(row.status).toBe('awaiting_review')
    expect(listChatDeliveryReviews(reopened,'r',OWNER,Date.parse(LATER)).some(item=>item.artifact?.artifact_id===files[0]!.artifact_id)).toBe(false)
    expect(()=>accept(resumed,stale,files[1]!)).toThrow(/版本/)
    expect(reopened.raw.prepare('SELECT COUNT(*) AS n FROM rework_impacts WHERE released_at IS NULL').get()).toMatchObject({n:1})
    row=accept(resumed,row,files[1]!)
    expect(row.status).toBe('awaiting_review')
    row=accept(resumed,row,files[2]!)
    expect(row.status).toBe('closed')
    expect(JSON.parse(resumed.get(row.request_id,OWNER).item.attempts[0]!.accepted_files_json!)).toHaveLength(3)
    expect(reopened.raw.prepare('SELECT COUNT(*) AS n FROM rework_impacts WHERE released_at IS NULL').get()).toMatchObject({n:0})
    registerRunArtifact(reopened,{artifactId:'late-report',runId:'r',nodeRunId:row.new_node_run_id!,fileName:'report.md',bytes:Buffer.from('unreviewed later version')},LATER)
    const consumed=withTx(reopened,tx=>snapshotArtifactInputs(tx,'consumer',[row.new_node_run_id!],LATER))
    expect(consumed.map(file=>file.artifact_id).sort()).toEqual(files.map(file=>file.artifact_id).sort())
    expect(()=>reopened!.raw.prepare("UPDATE rework_attempts SET file_manifest_json='{}'").run()).toThrow(/immutable rework file manifest/)
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM artifact_contents WHERE node_run_id=\'old\'').get()).toMatchObject({n:3})
  } finally {reopened?.raw.close();db.raw.close()}
})

it('rejects missing originals and unapproved outputs, and preserves other files through another requested revision',()=>{
  const {db,host,body,manifest}=fixture()
  try {
    expect(()=>host.request({...body,file_manifest:{...manifest,originals:manifest.originals.slice(0,1)}},OWNER,NOW)).toThrow(/逐份覆盖/)
    const scheduled=host.request(body,OWNER,NOW), binding=start(db,scheduled)
    publish(db,host,binding,'report.md','corrected report');publish(db,host,binding,'audit.md','review log');done(db,scheduled)
    host.recover(LATER)
    let row=host.get(scheduled.request_id,OWNER).item.request
    const files=result(db,row), report=files.find(file=>file.file_name==='report.md')!
    row=host.review({operation_id:uuidv7(),request_id:row.request_id,expected_revision:row.revision,action:'request_changes',note:'补齐结论',artifact_id:report.artifact_id,artifact_hash:report.sha256},OWNER,LATER)
    const next=JSON.parse(row.file_manifest_json!) as ReworkFileManifest
    expect(next.originals.filter(file=>file.action==='keep').map(file=>file.file_name)).toEqual(['audit.md','data.csv'])
    row=host.review({operation_id:uuidv7(),request_id:row.request_id,expected_revision:row.revision,action:'authorize',note:'批准这一轮文件方案'},OWNER,LATER)
    publish(db,host,start(db,row),'report.md','full corrected conclusion');done(db,row);host.recover(LATER)
    row=host.get(row.request_id,OWNER).item.request
    expect(row.status).toBe('awaiting_review')
    expect(result(db,row).filter(file=>file.file_name!=='report.md').map(file=>file.sha256).sort()).toEqual(files.filter(file=>file.file_name!=='report.md').map(file=>file.sha256).sort())
  } finally {db.raw.close()}
})

it.each(['missing','unexpected','tampered'] as const)('keeps downstream blocked when the actual result is %s',kind=>{
  const {db,host,body}=fixture()
  try {
    const scheduled=host.request(body,OWNER,NOW), binding=start(db,scheduled)
    publish(db,host,binding,'report.md','revised report')
    if(kind!=='missing')publish(db,host,binding,'audit.md','audit')
    if(kind==='unexpected')registerRunArtifact(db,{artifactId:'unexpected',runId:'r',nodeRunId:binding.node_run_id,fileName:'extra.md',bytes:Buffer.from('unapproved')},NOW)
    if(kind==='tampered')withTx(db,tx=>tx.run("UPDATE artifact_contents SET bytes=? WHERE node_run_id=? AND file_name='data.csv'",[Buffer.from('corrupt'),binding.node_run_id]))
    done(db,scheduled);host.recover(LATER)
    expect(host.get(scheduled.request_id,OWNER).item.request.status).toBe('escalated')
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rework_impacts WHERE released_at IS NULL').get()).toMatchObject({n:1})
  } finally {db.raw.close()}
})

it('binds delivery acceptance to the displayed hold and the latest same-name version, ignoring obsolete expiry',()=>{
  const {db}=fixture()
  try {
    // Use a single filename so the successful latest revision can complete this hold.
    withTx(db,tx=>tx.run("UPDATE artifacts SET retain_until=? WHERE artifact_id='original'",[NOW]))
    registerRunArtifact(db,{artifactId:'latest',runId:'r',nodeRunId:'old',fileName:'report.md',bytes:Buffer.from('latest report')},LATER)
    const review=createDeliveryReviewHost(db,TEST_SECRET)
    const hold=review.change({operation_id:uuidv7(),run_id:'r',node_run_id:'old',action:'hold'},OWNER,NOW)
    const command={operation_id:uuidv7(),run_id:'r',node_run_id:'old',action:'accept' as const,artifact_id:'latest',sha256:sha256Hex('latest report')}
    expect(()=>review.change(command,OWNER,LATER)).toThrow(/留验身份/)
    const accepted=review.change({...command,hold_id:hold.hold_id,expected_revision:hold.revision},OWNER,LATER)
    expect(accepted.status).toBe('held')
    expect('pending' in accepted && accepted.pending).toEqual(['data.csv','obsolete.txt'])
    expect(()=>review.change({...command,operation_id:uuidv7(),hold_id:hold.hold_id,expected_revision:hold.revision},OWNER,LATER)).toThrow(/留验已更新/)
  } finally {db.raw.close()}
})
