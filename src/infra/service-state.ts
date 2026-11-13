// service.state：pid / endpoint / secret / epoch 的落盘点（规格 2.3 行 116）
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

export type ServiceState = { pid: number; endpoint: string; secret: string; epoch: number; started_at: string }

export function readServiceState(path: string): ServiceState | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServiceState>
    if (typeof raw.pid !== 'number' || typeof raw.endpoint !== 'string' || typeof raw.secret !== 'string' || typeof raw.epoch !== 'number') return null
    return { pid: raw.pid, endpoint: raw.endpoint, secret: raw.secret, epoch: raw.epoch, started_at: raw.started_at ?? '' }
  } catch {
    return null
  }
}

export function writeServiceState(path: string, state: ServiceState): void {
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8')
}

export function clearServiceState(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true })
}

// 活着就连接（别抢），死了才接管
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
