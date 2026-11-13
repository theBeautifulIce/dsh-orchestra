import { describe, expect, it } from 'vitest'
import { runCase, type InjectionCase } from '../../scripts/fault-inject.ts'

const TIMEOUT = 60000

async function run(name: InjectionCase) {
  return runCase(name)
}

describe('G1 故障注入', () => {
  it('G-01 事务 COMMIT 前杀进程：不留半条记录', async () => {
    const out = await run('G-01')
    expect(out.reconcile).toContain('未提交事务不留半条记录：true')
  }, TIMEOUT)

  it('G-02 COMMIT 后未投递被杀：事件仍在，能按 fromSeq 重放', async () => {
    const out = await run('G-02')
    expect(out.reconcile).toContain('evt_committed')
    expect(out.after).toContain('inject.g02')
  }, TIMEOUT)

  it('G-08 长事务期间读不被拖死，写报 busy，队列溢出报 SERVICE_UNAVAILABLE', async () => {
    const out = await run('G-08')
    expect(out.reconcile).toContain('第二个写者报 busy：true')
    expect(out.reconcile).toContain('SERVICE_UNAVAILABLE')
  }, TIMEOUT)

  it('G-09 订阅者离线后重放：断号检查通过', async () => {
    const out = await run('G-09')
    expect(out.reconcile).toContain('连续无断号：true')
  }, TIMEOUT)

  it('G-14 迁移一半被杀后重跑：已提交步骤不重复执行', async () => {
    const out = await run('G-14')
    expect(out.reconcile).toContain('重跑只补了 [902]')
    expect(out.reconcile).toContain('schema_migrations=[1,2,901,902]')
  }, TIMEOUT)

  it('G-15 备份被截断能检出、恢复被拒、线上库不变', async () => {
    const out = await run('G-15')
    expect(out.reconcile).toContain('截断')
    expect(out.reconcile).toContain('恢复被拒：true')
    expect(out.reconcile).toContain('线上库未变：true')
  }, TIMEOUT)
})
