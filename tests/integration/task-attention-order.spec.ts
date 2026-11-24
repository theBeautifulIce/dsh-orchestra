import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { openDb, withTx, type Db, type Tx } from '../../src/infra/sqlite/driver.ts'
import { attentionWeight, type Attention } from '../../src/service/queries/attention.ts'
import { getTaskSummarySnapshot, listTaskSummaries } from '../../src/service/queries/tasks.ts'

const started = '2026-11-18T00:00:00.000Z'
const later = '2026-11-18T00:10:00.000Z'
const now = Date.parse(started)

const addTask = (tx: Tx, task: string, run: string, status: string, archived: string | null = null) => {
  tx.run('INSERT INTO tasks(task_id,title,status,current_run_id,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,?)',
    [task, task, status, run, started, started, archived])
  tx.run('INSERT INTO runs(run_id,task_id,status,created_at,updated_at) VALUES(?,?,?,?,?)', [run, task, status, started, started])
}

function storedRank(db: Db, task: string) {
  return (db.raw.prepare('SELECT attention_weight FROM task_attention_order WHERE task_id = ?').get(task) as { attention_weight: number }).attention_weight
}

function expectRank(db: Db, task: string, attention: Attention) {
  expect(storedRank(db, task)).toBe(attentionWeight(attention))
  expect(getTaskSummarySnapshot(db, task, now).item.attention).toBe(attention)
}

it('迁移已有任务并维护同事务排序，读快照、时间变化和回滚保持旧查询语义', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-attention-order-'))
  const db = openDb(join(dir, 'orchestra.sqlite'))
  try {
    const migrations = loadSteps(defaultMigrationsDir())
    applySteps(db, migrations.filter((step) => step.version < 59))
    withTx(db, (tx) => {
      addTask(tx, 'a', 'r', 'running')
      addTask(tx, 'b', 'b-run', 'succeeded')
      addTask(tx, 'archived', 'archived-run', 'failed', later)
      tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,side_effect_policy,heartbeat_at,created_at,updated_at) VALUES('n','r','exec',1,'agent','started','compensable',?,?,?)",
        [started, started, started])
      tx.run("INSERT INTO decisions(decision_id,run_id,node_run_id,kind,status,revision,payload_json,created_at) VALUES('d','r','n','verify_human','pending',1,'{}',?)", [started])
    })
    applySteps(db, migrations)
    expectRank(db, 'a', 'decision')
    expectRank(db, 'b', 'none')
    expectRank(db, 'archived', 'failed')
    expect(listTaskSummaries(db, { archived: true }).items.map((task) => task.task_id)).toEqual(['archived'])
    const first = listTaskSummaries(db, { limit: 1, now })
    expect(first.items[0]?.task_id).toBe('a')
    expect(listTaskSummaries(db, { limit: 1, now, cursor: first.next_cursor! }).items.map((task) => task.task_id)).toEqual(['b'])
    const laterDetail = getTaskSummarySnapshot(db, 'a', Date.parse(later)).item
    expect(laterDetail.attention_reason).toContain('10 分钟')
    expect(laterDetail.max_heartbeat_age_ms).toBe(600000)

    const resolveDecision = "UPDATE decisions SET status='resolved',decided_at=? WHERE decision_id='d'"
    expect(() => withTx(db, (tx) => {
      tx.run(resolveDecision, [later])
      expect(tx.get('SELECT attention_weight FROM task_attention_order WHERE task_id = ?', ['a']))
        .toMatchObject({ attention_weight: 5 })
      expect(getTaskSummarySnapshot(db, 'a', now).item.attention).toBe('decision')
      throw new Error('abort write')
    })).toThrow('abort write')
    expectRank(db, 'a', 'decision')
    withTx(db, (tx) => tx.run(resolveDecision, [later]))
    expectRank(db, 'a', 'unverified')
    withTx(db, (tx) => {
      tx.run("INSERT INTO unverified_resolutions(node_run_id,run_id,resolution_basis,decision_id,resolved_at) VALUES('n','r','decision','d',?)", [later])
    })
    expectRank(db, 'a', 'running')
    withTx(db, (tx) => tx.run("UPDATE runs SET status='failed' WHERE run_id='r'"))
    expectRank(db, 'a', 'failed')
    withTx(db, (tx) => tx.run("UPDATE runs SET status='orphaned' WHERE run_id='r'"))
    expectRank(db, 'a', 'orphaned')
    withTx(db, (tx) => {
      tx.run("UPDATE tasks SET status='succeeded', current_run_id='b-run', updated_at=? WHERE task_id='a'", [later])
    })
    expectRank(db, 'a', 'none')
    expect(listTaskSummaries(db, { status: 'succeeded' }).items.map((task) => task.task_id)).toEqual(['a', 'b'])
    const persistedFacts = 'SELECT task_id, status, trigger_kind, updated_at, archived_at, current_run_status, trigger_enabled, attention_weight FROM task_attention_order'
    expect(db.raw.prepare('SELECT * FROM task_attention_facts EXCEPT ' + persistedFacts).all()).toEqual([])
    expect(db.raw.prepare(persistedFacts + ' EXCEPT SELECT * FROM task_attention_facts').all()).toEqual([])
  } finally {
    db.raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('子流程、记忆写入补偿和交付重验只刷新受影响的当前运行', () => {
  const db = openDb(':memory:')
  try {
    applySteps(db, loadSteps(defaultMigrationsDir()))
    withTx(db, (tx) => {
      addTask(tx, 'root', 'r', 'succeeded')
      addTask(tx, 'memory', 'm', 'succeeded')
      tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,side_effect_policy,side_effect_verified_none,created_at,updated_at) VALUES('n','r','child',1,'subworkflow','done','compensable',1,?,?)",
        [started, started])
      tx.run("INSERT INTO runs(run_id,task_id,status,parent_run_id,parent_node_run_id,created_at,updated_at) VALUES('c','root','running','r','n',?,?)", [started, started])
      tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,side_effect_policy,created_at,updated_at) VALUES('apply','m','mem_apply',1,'agent','done','compensable',?,?)",
        [started, started])
      tx.run("INSERT INTO memory_batches(batch_id,task_id,source_run_id,memory_run_id,apply_node_run_id,attempt,status,approved_proposal_hash,approved_item_hashes_json,created_at,updated_at) VALUES('batch','memory','r','m','apply',1,'applying','hash','[]',?,?)",
        [started, started])
    })
    expectRank(db, 'root', 'unverified')
    expectRank(db, 'memory', 'unverified')
    withTx(db, (tx) => tx.run("UPDATE runs SET status='succeeded' WHERE run_id='c'"))
    expectRank(db, 'root', 'none')
    expectRank(db, 'memory', 'unverified')
    withTx(db, (tx) => tx.run("UPDATE memory_batches SET status='applied',outcome='written' WHERE batch_id='batch'"))
    expectRank(db, 'memory', 'none')
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status='superseded' WHERE node_run_id='apply'")
      tx.run("INSERT INTO decisions(decision_id,run_id,node_run_id,kind,status,revision,payload_json,created_at,decided_at) VALUES('d','m','apply','verify_human','resolved',1,'{}',?,?)",
        [started, later])
      tx.run("INSERT INTO memory_write_recoveries(node_run_id,batch_id,evidence_id,stopped_at,decision_id,status) VALUES('apply','batch','ev',?,'d','inspected')", [later])
    })
    expectRank(db, 'memory', 'unverified')
    withTx(db, (tx) => tx.run("UPDATE memory_write_recoveries SET status='confirmed_not_applied' WHERE node_run_id='apply'"))
    expectRank(db, 'memory', 'none')

    const acceptanceSql = "INSERT INTO run_acceptance_results(result_id,run_id,plan_id,content_hash,rule_version,deliverable_key,kind,outcome,evidence_json,evaluated_at) VALUES('accept','r','p','hash','v1','deliverable','artifact',?,'{}',?) ON CONFLICT(result_id) DO UPDATE SET outcome=excluded.outcome"
    withTx(db, (tx) => {
      tx.run("INSERT INTO task_plans(plan_id,created_by,input_json,proposal_json,quality_json,content_hash,launch_operation_id,created_at) VALUES('p','tester','{}','{}','{}','hash','op',?)", [started])
      tx.run(acceptanceSql, ['failed', later])
    })
    expectRank(db, 'root', 'failed')
    withTx(db, (tx) => tx.run(acceptanceSql, ['unverifiable', later]))
    expectRank(db, 'root', 'unverified')
    withTx(db, (tx) => tx.run(acceptanceSql, ['passed', later]))
    expectRank(db, 'root', 'none')
    expectRank(db, 'memory', 'none')
  } finally {
    db.raw.close()
  }
})

it('任务触发启停与纯节点孤儿化立即更新可索引筛选范围', () => {
  const db = openDb(':memory:')
  try {
    applySteps(db, loadSteps(defaultMigrationsDir()))
    withTx(db, (tx) => {
      addTask(tx, 'scheduled', 'r', 'succeeded')
      tx.run("UPDATE tasks SET trigger_kind='scheduled' WHERE task_id='scheduled'")
      tx.run("INSERT INTO workflows(workflow_id,name,current_version,created_by,updated_by,created_at,updated_at) VALUES('w','sample','1','tester','tester',?,?)",
        [started, started])
      tx.run("INSERT INTO workflow_versions(workflow_id,version,content_hash,definition_json,created_at) VALUES('w','1','hash','{}',?)", [started])
      tx.run("INSERT INTO task_triggers(trigger_id,task_id,workflow_id,workflow_version,kind,daily_time,time_zone,created_by,created_at,updated_at) VALUES('t','scheduled','w','1','scheduled','10:00','Asia/Shanghai','tester',?,?)",
        [started, started])
      tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,side_effect_policy,created_at,updated_at) VALUES('n','r','exec',1,'agent','done','pure',?,?)", [started, started])
    })
    expect(listTaskSummaries(db, { trigger_kind: 'scheduled', lane: 'upcoming' }).items.map((task) => task.task_id)).toEqual(['scheduled'])
    withTx(db, (tx) => tx.run("UPDATE task_triggers SET enabled=0 WHERE trigger_id='t'"))
    expect(listTaskSummaries(db, { lane: 'finished' }).items.map((task) => task.task_id)).toEqual(['scheduled'])
    withTx(db, (tx) => tx.run("UPDATE node_runs SET status='orphaned' WHERE node_run_id='n'"))
    expectRank(db, 'scheduled', 'orphaned')
    expect(listTaskSummaries(db, { attention: 'orphaned' }).items.map((task) => task.task_id)).toEqual(['scheduled'])
    withTx(db, (tx) => tx.run("DELETE FROM node_runs WHERE node_run_id='n'"))
    expectRank(db, 'scheduled', 'none')
  } finally {
    db.raw.close()
  }
})

it('把子流程决定、成果留验与未派发的可补偿步骤分别投影到人读任务', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-attention-human-'))
  const db = openDb(join(dir, 'orchestra.sqlite'))
  try {
    applySteps(db, loadSteps(defaultMigrationsDir()))
    withTx(db, (tx) => {
      // p：子流程里的人工决定要算到父任务，运行次数只算根启动（T02）。
      addTask(tx, 'p', 'p-root', 'running')
      tx.run(`INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,side_effect_policy,created_at,updated_at)
        VALUES('p-sub','p-root','sub',1,'subworkflow','started','pure',?,?)`, [started, started])
      tx.run(`INSERT INTO runs(run_id,task_id,parent_run_id,parent_node_run_id,status,created_at,updated_at)
        VALUES('p-child','p','p-root','p-sub','running',?,?)`, [started, started])
      tx.run(`INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,side_effect_policy,created_at,updated_at)
        VALUES('p-step','p-child','collect',1,'agent','started','pure',?,?)`, [started, started])
      tx.run(`INSERT INTO decisions(decision_id,run_id,node_run_id,kind,status,revision,payload_json,created_at)
        VALUES('p-decision','p-child','p-step','verify_human','pending',1,'{}',?)`, [started])

      // q：已完成步骤上有人工留验，即使还没有登记文件也是待办（T01/D06）。
      addTask(tx, 'q', 'q-run', 'running')
      tx.run(`INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,side_effect_policy,created_at,updated_at)
        VALUES('q-step','q-run','write',1,'agent','done','pure',?,?)`, [started, started])
      tx.run(`INSERT INTO delivery_review_holds(run_id,node_id,node_run_id,owner_actor,status,updated_at)
        VALUES('q-run','write','q-step','human:a','held',?)`, [started])

      // r：只有排队中的可补偿步骤，没有派发记录，不能报成“外部操作待核验”（T03）。
      addTask(tx, 'r', 'r-run', 'running')
      tx.run(`INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,side_effect_policy,created_at,updated_at)
        VALUES('r-step','r-run','pay',1,'agent','queued','compensable',?,?)`, [started, started])

      // s：只领到租约、既没开始执行也没有工具记录，同样不能报成对外动作待核实（T03）。
      addTask(tx, 's', 's-run', 'running')
      tx.run(`INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,side_effect_policy,created_at,updated_at)
        VALUES('s-step','s-run','pay',1,'agent','leased','compensable',?,?)`, [started, started])

      // t：真的开始执行过、结果未明，两个入口都要计 1（T03 正例）。
      addTask(tx, 't', 't-run', 'running')
      tx.run(`INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,side_effect_policy,started_at,created_at,updated_at)
        VALUES('t-step','t-run','pay',1,'agent','started','compensable',?,?,?)`, [started, started, started])
    })
    const person = getTaskSummarySnapshot(db, 'p', now).item
    expect(person.run_count).toBe(1)
    expect(person.open_decision_count).toBe(1)
    expect(person.attention).toBe('decision')
    expect(person.lane).toBe('attention')
    // 子流程上的决定给出精确目标：任务行不用知道步骤号也能直接打开（T02）。
    expect(person.next_action).toMatchObject({ kind: 'decision', decision_id: 'p-decision', run_id: 'p-child' })

    const review = getTaskSummarySnapshot(db, 'q', now).item
    expect(review.delivery_review_count).toBe(1)
    expect(review.attention).toBe('decision')
    expect(review.attention_reason).toContain('成果待验收')
    // 留验还没交文件：动作是打开验收区，而不是假装有一份文件可点（T01/D06）。
    expect(review.next_action).toMatchObject({ kind: 'review', node_run_id: 'q-step', run_id: 'q-run' })
    expect(storedRank(db, 'q')).toBe(attentionWeight('decision'))

    const queued = getTaskSummarySnapshot(db, 'r', now).item
    expect(queued.unverified_count).toBe(0)
    expect(queued.attention).not.toBe('unverified')
    expect(queued.attention_reason ?? '').not.toContain('不可逆')
    expect(queued.next_action).toBeUndefined()

    const leased = getTaskSummarySnapshot(db, 's', now).item
    expect(leased.unverified_count).toBe(0)
    expect(leased.attention).not.toBe('unverified')
    expect(storedRank(db, 's')).toBe(attentionWeight('running'))

    const startedEffect = getTaskSummarySnapshot(db, 't', now).item
    expect(startedEffect.unverified_count).toBe(1)
    expect(startedEffect.attention).toBe('unverified')
  } finally { db.raw.close() }
})

it('keeps an unlaunched task-local plan out of the task board until it really starts (P01)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-plan-draft-'))
  const db = openDb(join(dir, 'orchestra.sqlite'))
  try {
    applySteps(db, loadSteps(defaultMigrationsDir()))
    withTx(db, (tx) => {
      addTask(tx, 'draft', 'draft-run', 'reserved')
      tx.run(`INSERT INTO task_plans (plan_id, created_by, input_json, proposal_json, quality_json, content_hash,
        launch_operation_id, owner_task_id, created_at) VALUES ('plan-1','human:a','{}','{}','{}','hash','op-1','draft',?)`,
      [started])
    })
    // 只有计划、没有启动记录：任务表里看不到它。
    expect(getTaskSummarySnapshotOrNull(db, 'draft')).toBeNull()
    expect(listTaskSummaries(db).items.map((item) => item.task_id)).not.toContain('draft')
    withTx(db, (tx) => tx.run(`INSERT INTO start_run_operations (operation_id, task_id, run_id, started_by, created_at)
      VALUES ('op-1','draft','draft-run','human:a',?)`, [started]))
    // 真正启动后回到任务表。
    expect(getTaskSummarySnapshotOrNull(db, 'draft')).not.toBeNull()
  } finally { db.raw.close() }
})

function getTaskSummarySnapshotOrNull(db: Db, taskId: string) {
  try { return getTaskSummarySnapshot(db, taskId, now).item } catch { return null }
}
