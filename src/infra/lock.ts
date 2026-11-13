// 进程所有权：账本同一时刻只该有一个写者进程（proper-lockfile，锁文件与库同目录）
import lockfile from 'proper-lockfile'

export async function acquireDbLock(dbFile: string): Promise<() => Promise<void>> {
  const release = await lockfile.lock(dbFile + '.lock', { realpath: false, stale: 10000 })
  return async () => { await release() }
}
