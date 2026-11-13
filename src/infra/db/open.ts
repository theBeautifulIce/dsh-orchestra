// 服务侧连接装配：锁声明所有权、epoch 自增、句柄（不直接碰 node:sqlite）
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { openDb, withTx, type Db } from '../sqlite/driver.ts'

export function bumpEpoch(file: string): number {
  const db = openDb(file)
  try {
    return withTx(db, (tx) => {
      const row = tx.get<{ value?: string }>("SELECT value FROM service_meta WHERE key = 'instance_epoch'")
      const next = Number(row?.value ?? 0) + 1
      tx.run("INSERT INTO service_meta (key, value, updated_at) VALUES ('instance_epoch', ?, ?) "
        + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        [String(next), new Date().toISOString()])
      return next
    })
  } finally {
    db.raw.close()
  }
}

export function openServiceDb(file: string, epoch: number): Db {
  mkdirSync(dirname(file), { recursive: true })
  const db = openDb(file)
  return { ...db, epoch }
}
