import { readFileSync } from 'node:fs'
import { it, expect } from 'vitest'
import { openDb,withTx } from '../../src/infra/sqlite/driver.ts'
import { beginPlanningProgress,advancePlanning,listPlanning } from '../../src/service/chat-planning-progress.ts'
import { saveMaterials,bindMaterials,readMaterial } from '../../src/service/plan-materials.ts'
it('材料跨会话/过期与进度重投：真实 SQLite 事务', () => {
 const db=openDb(':memory:')
 try {
  db.raw.exec("CREATE TABLE runs(run_id TEXT PRIMARY KEY); INSERT INTO runs VALUES('run-a')")
  db.raw.exec(`CREATE TABLE chat_task_receipts(request_key TEXT,input_hash TEXT,plan_id TEXT);
    CREATE TABLE task_plans(plan_id TEXT,created_by TEXT,launch_operation_id TEXT);
    CREATE TABLE start_run_operations(operation_id TEXT,run_id TEXT);
    INSERT INTO chat_task_receipts VALUES ('req','h','p');
    INSERT INTO task_plans VALUES ('p','A','o');
    INSERT INTO start_run_operations VALUES ('o','run-a');`)
  db.raw.exec(readFileSync(new URL('../fixtures/entry-materials.sql',import.meta.url),'utf8'));db.raw.exec(readFileSync(new URL('../fixtures/entry-progress.sql',import.meta.url),'utf8'))
  withTx(db,tx=>{
   const g={scope:'session-a',actor:'A',draft:'draft-a'}
   const [p] = saveMaterials(tx,g,[{name:'income.csv',body:'value\n10'}],0)
   bindMaterials(tx,g,[{...p!,nodes:['collect']}],'run-a',1)
   expect(readMaterial(tx,g,'run-a','collect',p!,2)).toBe('value\n10')
   expect(()=>readMaterial(tx,{...g,scope:'session-b'},'run-a','collect',p!,2)).toThrow()
   expect(()=>readMaterial(tx,g,'run-a','collect',p!,30*60_000)).toThrow()
   expect(()=>readMaterial(tx,g,'run-a','other',p!,2)).toThrow()
   expect(() => bindMaterials(tx,g,[{...p!,nodes:['collect','other']}],'run-a',2)).toThrow()
   const key={actor:'A',scope:'s',request:'req',hash:'h'}
   beginPlanningProgress(tx,key,0);beginPlanningProgress(tx,key,1)
   expect(listPlanning(tx,'A','s',0)).toHaveLength(1)
   expect(listPlanning(tx,'A','other',0)).toHaveLength(0)
   expect(advancePlanning(tx,key,'cancelled',null,2)).toBe(1)
   expect(advancePlanning(tx,key,'approval',null,3)).toBe(0)
   expect(advancePlanning(tx,key,'started','other-run',4)).toBe(0)
   expect(advancePlanning(tx,key,'started','run-a',5)).toBe(1)
   expect(advancePlanning(tx,key,'started','run-a',6)).toBe(0)
  })
 } finally {db.raw.close()}
})
