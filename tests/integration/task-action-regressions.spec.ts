import { afterEach, expect, it } from 'vitest'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { openDb, withTx, type Db, type Tx } from '../../src/infra/sqlite/driver.ts'
import { registerRunArtifactInTx } from '../../src/service/artifact-store.ts'
import { getTaskSummarySnapshot, listTaskSummaries, getWorkspaceOverview } from '../../src/service/queries/tasks.ts'
import { applyCancel } from '../../src/service/commands/cancel.ts'
import { listNodes } from '../../src/service/queries/nodes.ts'
import { TEST_CLOCK } from '../fixtures/clock.ts'

const at = '2026-11-18T00:00:00.000Z'
const later = '2026-11-18T00:10:00.000Z'
const now = Date.parse(later)
const closers: Db[] = []
afterEach(() => { for (const db of closers.splice(0)) db.raw.close() })
function database() {
  const db = openDb(':memory:'); closers.push(db)
  applySteps(db, loadSteps(defaultMigrationsDir()))
  withTx(db, tx => {
    tx.run("INSERT INTO tasks(task_id,title,status,current_run_id,created_at,updated_at) VALUES('task','待审报告','running','root',?,?)", [at,at])
    tx.run("INSERT INTO runs(run_id,task_id,status,created_at,updated_at) VALUES('root','task','running',?,?)", [at,at])
  })
  return db
}
function node(tx: Tx, id: string, run='root', status='done', policy='pure', seq=1) {
  tx.run('INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,attempt,status,revision,side_effect_policy,created_at,updated_at) VALUES(?,?,?,?,\'agent\',1,?,1,?,?,?)',
    [id,run,id,seq,status,policy,at,at])
}
function file(tx: Tx, id: string, attempt: string, name: string, created=at, run='root') {
  const result = registerRunArtifactInTx(tx,{artifactId:id,runId:run,nodeRunId:attempt,fileName:name,bytes:Buffer.from(id)},created)
  return {artifact_id:id,sha256:result.sha256,file_name:name}
}
const read = (db: Db, actor: string) => getTaskSummarySnapshot(db,'task',now,actor).item
const rank = (db: Db) => db.raw.prepare("SELECT attention_weight FROM task_attention_order WHERE task_id='task'").get() as {attention_weight:number}

it('T01/T10 主动作按当前操作者与精确版本读取；同名更新和封存记录各有明确目标', () => {
  const db = database()
  withTx(db,tx => {
    node(tx,'report')
    file(tx,'old-report','report','报告.md')
    file(tx,'new-report','report','报告.md',later)
    tx.run("INSERT INTO delivery_review_holds(run_id,node_id,node_run_id,owner_actor,status,updated_at) VALUES('root','report','report','human:alice','held',?)",[at])
  })
  expect(read(db,'human:alice').next_action).toMatchObject({kind:'review',artifact_id:'new-report',file_name:'报告.md'})
  expect(read(db,'human:bob').next_action).toBeUndefined()
  expect(listTaskSummaries(db,{actor:'human:bob',now}).items[0]?.next_action).toBeUndefined()
  withTx(db,tx => {
    const old = tx.get<{artifact_id:string;sha256:string}>('SELECT artifact_id,sha256 FROM artifacts WHERE artifact_id=?',['old-report'])!
    tx.run('UPDATE delivery_review_holds SET review_set_json=?, accepted_json=\'[]\'', [JSON.stringify([{...old,file_name:'报告.md'}])])
  })
  expect(read(db,'human:alice').next_action).toMatchObject({kind:'review',artifact_id:'old-report'})
})

it('T01/T02 子孙运行本轮返工多文件进入待办，跳过已验版本；历史根运行不插队', () => {
  const db=database()
  let pending: {artifact_id:string;sha256:string;file_name:string}
  withTx(db,tx => {
    node(tx,'sub')
    tx.run("INSERT INTO runs(run_id,task_id,parent_run_id,parent_node_run_id,status,created_at,updated_at) VALUES('child','task','root','sub','running',?,?)",[at,at])
    node(tx,'sub-child','child')
    tx.run("INSERT INTO runs(run_id,task_id,parent_run_id,parent_node_run_id,status,created_at,updated_at) VALUES('grandchild','task','child','sub-child','running',?,?)",[at,at])
    node(tx,'old-attempt','grandchild')
    node(tx,'revised-attempt','grandchild', 'done','pure',2)
    const source=file(tx,'source','old-attempt','报告.md',at,'grandchild')
    const accepted=file(tx,'approved-report','revised-attempt','报告.md',later,'grandchild')
    pending=file(tx,'pending-appendix','revised-attempt','附件.md',later,'grandchild')
    tx.run(`INSERT INTO rework_requests(request_id,run_id,requester_actor,owner_actor,target_node_run_id,target_attempt,
      source_artifact_id,source_artifact_hash,reason,expected_result,preserve_requirements_json,suggested_scope,status,new_node_run_id,evidence_ids_json,expires_at,created_at,updated_at)
      VALUES('rework','grandchild','human:alice','human:alice','old-attempt',1,?,?,'补全报告','齐备','[]','targeted_revision','awaiting_review','revised-attempt','[]','9999-01-01',?,?)`,
      [source.artifact_id,source.sha256,at,later])
    tx.run(`INSERT INTO rework_attempts(attempt_id,request_id,round_no,old_node_run_id,new_node_run_id,source_artifact_id,source_artifact_hash,
      result_artifact_id,result_artifact_hash,status,feedback,created_at,result_manifest_json,accepted_files_json)
      VALUES('round-1','rework',1,'old-attempt','revised-attempt',?,?,?,?,'awaiting_review','补全',?,?,?)`,
      [source.artifact_id,source.sha256,accepted.artifact_id,accepted.sha256,at,JSON.stringify([accepted,pending]),JSON.stringify([accepted])])
    tx.run("INSERT INTO runs(run_id,task_id,status,created_at,updated_at) VALUES('history','task','running',?,?)",[at,later])
    node(tx,'historic-review','history')
    file(tx,'historic-file','historic-review','旧任务.md',later,'history')
    tx.run("INSERT INTO delivery_review_holds(run_id,node_id,node_run_id,owner_actor,status,updated_at) VALUES('history','historic-review','historic-review','human:alice','held',?)",[later])
  })
  expect(read(db,'human:alice')).toMatchObject({delivery_review_count:1,attention:'decision',lane:'attention',
    next_action:{kind:'review',run_id:'grandchild',node_run_id:'revised-attempt',request_id:'rework',...pending!}})
  expect(rank(db).attention_weight).toBe(6)
  expect(read(db,'human:bob').next_action).toBeUndefined()
  withTx(db,tx => tx.run("UPDATE rework_attempts SET status='accepted' WHERE attempt_id='round-1'"))
  expect(read(db,'human:alice').delivery_review_count).toBe(0)
  expect(read(db,'human:alice').next_action).toBeUndefined()
  expect(rank(db).attention_weight).toBe(2)
})

it('T03 实际派发前取消不能变成对外动作；未知结果保留待核实且排序同时更新', () => {
  const db=database()
  withTx(db,tx => { node(tx,'never-dispatched','root','queued','irreversible'); node(tx,'only-leased','root','leased','compensable',2) })
  expect(read(db,'human:alice').unverified_count).toBe(0)
  for(const id of ['never-dispatched','only-leased']) {
    const result=withTx(db,tx=>applyCancel(tx,'audit-secret',{clock:TEST_CLOCK,nodeRunId:id,attempt:1,revision:1,cancelResult:'interrupted',now:later,graceMs:30000}))
    expect(result.reason).toBe('cancelled_before_dispatch')
  }
  expect(read(db,'human:alice').unverified_count).toBe(0)
  expect(getWorkspaceOverview(db).item.unverified_effects).toBe(0)
  expect(rank(db).attention_weight).toBe(2)
  withTx(db,tx=>node(tx,'unknown-outcome','root','superseded','compensable',3))
  expect(read(db,'human:alice').unverified_count).toBe(1)
  expect(rank(db).attention_weight).toBe(5)
})

it('T05 节点分页游标绑定 attention 筛选，不能混用普通页的位置', () => {
  const db=database()
  withTx(db,tx=> { node(tx,'blocked-1','root','blocked_pre'); node(tx,'blocked-2','root','blocked_post','pure',2); node(tx,'queued','root','queued','pure',3) })
  const page=listNodes(db,'root',1,undefined,undefined,'attention')
  expect(page.next_cursor).toBeTruthy()
  expect(()=>listNodes(db,'root',1,undefined,page.next_cursor!)).toThrow()
  expect(listNodes(db,'root',1,undefined,page.next_cursor!,'attention').items).toHaveLength(1)
})

it('T01 先留验后交付的纯步骤进入待处理列，不仅仅改变即时摘要', () => {
  const db=database()
  withTx(db,tx => {
    node(tx,'planned-review','root','queued')
    tx.run("INSERT INTO delivery_review_holds(run_id,node_id,node_run_id,owner_actor,status,updated_at) VALUES('root','planned-review','planned-review','human:alice','held',?)",[at])
  })
  expect(rank(db).attention_weight).toBe(2)
  withTx(db,tx => tx.run("UPDATE node_runs SET status='done' WHERE node_run_id='planned-review'"))
  expect(read(db,'human:alice')).toMatchObject({delivery_review_count:1,attention:'decision',lane:'attention'})
  expect(listTaskSummaries(db,{lane:'attention',actor:'human:alice',now}).items).toHaveLength(1)
  expect(rank(db).attention_weight).toBe(6)
})

it('078 升级立即修复旧物化排序，不要求再点开或再次写任务', () => {
  const db=openDb(':memory:'); closers.push(db)
  const steps=loadSteps(defaultMigrationsDir())
  applySteps(db,steps.filter(step=>step.version<78))
  withTx(db,tx => {
    tx.run("INSERT INTO tasks(task_id,title,status,current_run_id,created_at,updated_at) VALUES('task','报告','running','root',?,?)",[at,at])
    tx.run("INSERT INTO runs(run_id,task_id,status,created_at,updated_at) VALUES('root','task','running',?,?)",[at,at])
    node(tx,'no-execution','root','queued','irreversible')
    applyCancel(tx,'audit-secret',{clock:TEST_CLOCK,nodeRunId:'no-execution',attempt:1,revision:1,cancelResult:'interrupted',now:later,graceMs:30000})
  })
  expect(rank(db).attention_weight).toBe(5)
  applySteps(db,steps)
  expect(rank(db).attention_weight).toBe(2)
  expect(read(db,'human:alice').unverified_count).toBe(0)
})
