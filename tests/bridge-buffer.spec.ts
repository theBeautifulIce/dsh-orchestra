import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BridgeClient, BridgeEventBuffer, refillPage, type BridgeEvent } from '../src/executor/bridge.ts'
import { fakeBridge } from './fixtures/bridge.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'orch-buf-'))

function ev(seq: number, type: BridgeEvent['type'] = 'step', toolStartAt: string | null = null): BridgeEvent {
  return { seq, type, at: '2026-01-01T00:00:0' + String(seq % 10) + 'Z', toolStartAt, payload: { seq } }
}

describe('桥事件缓冲', () => {
  it('类型不在五类清单里 → SCHEMA_VERSION_UNSUPPORTED', () => {
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: tmp(), agentId: 'a1' })
    expect(() => buf.push({ ...ev(1), type: 'tool.done' as BridgeEvent['type'] })).toThrowError(/固定清单/)
    try { buf.push({ ...ev(1), type: 'tool.done' as BridgeEvent['type'] }) } catch (e: any) { expect(e.code).toBe('SCHEMA_VERSION_UNSUPPORTED') }
  })

  it('连续推 1/2/3 gapFrom 都是 null；跳到 6 时 gapFrom=4', () => {
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: tmp(), agentId: 'a1' })
    expect(buf.push(ev(1)).gapFrom).toBeNull()
    expect(buf.push(ev(2)).gapFrom).toBeNull()
    expect(buf.push(ev(3)).gapFrom).toBeNull()
    expect(buf.push(ev(6)).gapFrom).toBe(4)
  })

  it('重复推同一 seq 幂等：accepted=false，事件数不变', () => {
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: tmp(), agentId: 'a1' })
    buf.push(ev(1))
    buf.push(ev(2))
    expect(buf.push(ev(2))).toEqual({ accepted: false, gapFrom: null })
    expect(buf.takeFrom(1).length).toBe(2)
  })

  it('序号倒退 → SCHEMA_VERSION_UNSUPPORTED', () => {
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: tmp(), agentId: 'a1' })
    buf.push(ev(2))
    expect(() => buf.push(ev(1))).toThrowError(/序号倒退/)
  })

  it('过高水位自动 spill：spilled=true、内存清空、文件在、takeFrom(1) 取回全部', () => {
    const dir = tmp()
    const buf = new BridgeEventBuffer({ limitBytes: 1024, highWaterBytes: 300, spillDir: dir, agentId: 'a1' })
    let bytesAtSpill: number | null = null
    for (let i = 1; i <= 6; i += 1) {
      buf.push(ev(i))
      // 落盘那一刻内存必须清空；之后再来事件会重新占内存，所以只认第一次落盘时的值
      if (buf.spilled && bytesAtSpill === null) bytesAtSpill = buf.bufferedBytes
    }
    expect(buf.spilled).toBe(true)
    expect(bytesAtSpill).toBe(0)
    const file = join(dir, 'a1-1.jsonl')
    expect(readFileSync(file, 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(1)
    expect(buf.takeFrom(1).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    rmSync(dir, { recursive: true, force: true })
  })

  it('tool.call 与 tool.start 分开记；锚点取 tool.start 的时间', () => {
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: tmp(), agentId: 'a1' })
    buf.push(ev(1, 'tool.call', null))
    buf.push(ev(2, 'tool.start', '2026-01-01T00:00:02Z'))
    const events = buf.takeFrom(1)
    expect(events.map((e) => e.type)).toEqual(['tool.call', 'tool.start'])
    expect(events[0]?.toolStartAt).toBeNull()
    expect(events[1]?.toolStartAt).toBe('2026-01-01T00:00:02Z')
    expect(buf.toolStartAnchor()).toBe('2026-01-01T00:00:02Z')
  })

  it('重取页里序号不连续 → SCHEMA_VERSION_UNSUPPORTED', async () => {
    const client = new BridgeClient(fakeBridge(() => ({ events: [ev(5), ev(7)] })))
    const got: BridgeEvent[] = []
    await expect(refillPage(client, { executorAgentId: 'a1', attempt: 1, gapFrom: 5 }, (e) => got.push(...e))).rejects.toMatchObject({ code: 'SCHEMA_VERSION_UNSUPPORTED' })
    expect(got.map((e) => e.seq)).toEqual([5])
  })
})
