import { parentPort, workerData } from 'node:worker_threads'
import { openDb } from '../../src/infra/sqlite/driver.ts'
import { startMemoryRun, type StartMemoryRunParams } from '../../src/service/commands/memory.ts'

const { file, params, barrier, first } = workerData as {
  file: string
  params: StartMemoryRunParams
  barrier: SharedArrayBuffer
  first: boolean
}
const state = new Int32Array(barrier)
const firstLocked = 0
const secondContended = 1
const secondAtBegin = 2
const firstOpen = 3
const secondOpen = 4

function waitFor(peerFlag: number): void {
  if (Atomics.wait(state, peerFlag, 0, 5_000) === 'timed-out') {
    throw new Error('另一个记忆写者未到达同步点')
  }
}

function release(flag: number): void {
  Atomics.store(state, flag, 1)
  Atomics.notify(state, flag)
}

// Opening the file sets journal mode. Complete setup one connection at a time before racing the commands.
if (!first) waitFor(firstOpen)
const db = openDb(file)
const exec = db.raw.exec.bind(db.raw)
let contended = false
if (first) {
  release(firstOpen)
  waitFor(secondOpen)
} else {
  release(secondOpen)
}

db.raw.exec = (sql) => {
  if (sql !== 'BEGIN IMMEDIATE') return exec(sql)
  if (first) {
    waitFor(secondAtBegin)
    exec(sql)
    release(firstLocked)
    waitFor(secondContended)
    return
  }

  release(secondAtBegin)
  waitFor(firstLocked)
  // 此时第一位写者持有事务。用零等待探测实际的 SQLite 写锁冲突，再进入命令的正常取锁路径。
  exec('PRAGMA busy_timeout=0')
  try {
    exec(sql)
    exec('ROLLBACK')
    throw new Error('第二位写者在第一位写者持有事务时未遇到写锁')
  } catch (error) {
    if ((error as { errcode?: number }).errcode !== 5) throw error // SQLITE_BUSY
    contended = true
  } finally {
    exec('PRAGMA busy_timeout=5000')
    release(secondContended)
  }
  exec(sql)
}

try {
  const result = startMemoryRun(db, params)
  db.raw.close()
  parentPort!.postMessage({ result, contended })
} catch (error) {
  db.raw.close()
  throw error
}
