import { describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BridgeClient, BridgeEventBuffer, refillPage, type BridgeEvent } from '../../src/executor/bridge.ts'
import { fakeBridge } from '../fixtures/bridge.ts'

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

  it('迟到的缺号事件补洞：先收 2 再收 1，连续位推进到 2', () => {
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: tmp(), agentId: 'a1' })
    expect(buf.push(ev(2)).gapFrom).toBe(1)
    expect(buf.push(ev(1)).gapFrom).toBeNull()
    expect(buf.lastContiguousSeq).toBe(2)
    expect(buf.takeFrom(1).map((e) => e.seq)).toEqual([1, 2])
  })

  it('收到 5 缺 3/4：暂存 5、补 3/4 后连续位到 5', () => {
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: tmp(), agentId: 'a1' })
    buf.push(ev(1))
    buf.push(ev(2))
    buf.ack(1, 1)
    buf.ack(2, 2)
    expect(buf.push(ev(5)).gapFrom).toBe(3)
    expect(buf.lastContiguousSeq).toBe(2)
    expect(buf.push(ev(3)).gapFrom).toBe(4)
    expect(buf.push(ev(4)).gapFrom).toBeNull()
    expect(buf.lastContiguousSeq).toBe(5)
    expect(buf.pendingCount).toBe(0)
    expect(buf.takeFrom(3).map((e) => e.seq)).toEqual([3, 4, 5])
  })

  it('缺口未补时重复收到 5：accepted=false，但仍返回 gapFrom=3', () => {
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: tmp(), agentId: 'a1' })
    buf.push(ev(1))
    buf.push(ev(2))
    buf.ack(1, 1)
    buf.ack(2, 2)
    expect(buf.push(ev(5)).gapFrom).toBe(3)
    expect(buf.push(ev(5))).toEqual({ accepted: false, gapFrom: 3 })
    expect(buf.pendingCount).toBe(1)
  })

  it('重启后同 seq 不同 payload 仍判冲突；只有 at 变化按幂等', () => {
    const persisted = ev(2)
    const buf = new BridgeEventBuffer(
      { limitBytes: 8192, highWaterBytes: 4096, spillDir: tmp(), agentId: 'a1' },
      { lastPersistedAckSeq: 2, lookupPersisted: (seq) => (seq === 2 ? persisted : undefined) },
    )
    expect(() => buf.push({ ...ev(2), payload: { seq: 2, changed: true } })).toThrowError(/协议冲突/)
    expect(buf.push({ ...ev(2), at: '2026-01-01T00:00:09Z' }).accepted).toBe(false)
    expect(buf.push(ev(3)).gapFrom).toBeNull()
  })

  it('重启后认回本 attempt 的 spill，并恢复连续位', () => {
    const dir = tmp()
    const first = new BridgeEventBuffer(
      { limitBytes: 1024, highWaterBytes: 1, spillDir: dir, agentId: 'a1', attempt: 1, nodeRunId: 'nr1' },
    )
    for (let i = 1; i <= 6; i += 1) first.push(ev(i))
    expect(first.spilled).toBe(true)
    const second = new BridgeEventBuffer(
      { limitBytes: 1024, highWaterBytes: 300, spillDir: dir, agentId: 'a1', attempt: 1, nodeRunId: 'nr1' },
      { lastPersistedAckSeq: 0 },
    )
    expect(second.takeFrom(1).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(second.lastContiguousSeq).toBe(6)
  })

  it('不同 attempt 的 spill 文件互不追加、互不串读', () => {
    const dir = tmp()
    const opts = { limitBytes: 1024, highWaterBytes: 300, spillDir: dir, agentId: 'a1', nodeRunId: 'nr1' }
    const a1 = new BridgeEventBuffer({ ...opts, attempt: 1 })
    const a2 = new BridgeEventBuffer({ ...opts, attempt: 2 })
    for (let i = 1; i <= 6; i += 1) a1.push({ ...ev(i), payload: { seq: i, attempt: 1 } })
    for (let i = 1; i <= 6; i += 1) a2.push({ ...ev(i), payload: { seq: i, attempt: 2 } })
    expect(a1.takeFrom(1).every((e) => (e.payload as { attempt: number }).attempt === 1)).toBe(true)
    expect(a2.takeFrom(1).every((e) => (e.payload as { attempt: number }).attempt === 2)).toBe(true)
    expect(readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length).toBeGreaterThanOrEqual(2)
  })

  it('事件自带 attempt/agent 与当前缓冲不一致 → 拒绝，不落内存', () => {
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: tmp(), agentId: 'a1', attempt: 1 })
    expect(() => buf.push({ ...ev(1), attempt: 2 })).toThrowError(/attempt 与当前缓冲不一致/)
    expect(() => buf.push({ ...ev(1), executorAgentId: 'a2' })).toThrowError(/executorAgentId 与当前缓冲不一致/)
    expect(buf.lastReceivedSeq).toBe(0)
  })

  it('同 seq 不同 payload → BRIDGE_SEQ_CONFLICT；相同 payload 幂等', () => {
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: tmp(), agentId: 'a1' })
    buf.push(ev(1))
    expect(buf.push(ev(1)).accepted).toBe(false)
    expect(() => buf.push({ ...ev(1), payload: { seq: 999 } })).toThrowError(/协议冲突/)
  })

  it('确认位只能逐条推进，且不能超过连续收到位', () => {
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: tmp(), agentId: 'a1' })
    buf.push(ev(1))
    buf.push(ev(2))
    expect(() => buf.ack(2, 2)).toThrowError(/逐条推进/)
    expect(() => buf.ack(1, 0)).toThrowError(/尚未落账/)
    buf.ack(1, 1)
    expect(buf.lastPersistedAckSeq).toBe(1)
    expect(() => buf.ack(3, 3)).toThrowError(/连续收到位/)
    buf.ack(2, 2)
    expect(buf.lastPersistedAckSeq).toBe(2)
  })

  it('有持久确认位但没有已落账回查 → 构造直接拒绝', () => {
    expect(() => new BridgeEventBuffer(
      { limitBytes: 8192, highWaterBytes: 4096, spillDir: tmp(), agentId: 'a1' },
      { lastPersistedAckSeq: 3 },
    )).toThrowError(/必须注入已落账事件回查/)
  })

  it('重启后从持久确认位恢复：已确认事件重复推送幂等，后续从 ack+1 接上', () => {
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: tmp(), agentId: 'a1' }, { lastPersistedAckSeq: 3, lookupPersisted: () => undefined })
    expect(buf.lastContiguousSeq).toBe(3)
    expect(buf.push(ev(2)).accepted).toBe(false)
    expect(buf.push(ev(3)).accepted).toBe(false)
    expect(buf.push(ev(4)).gapFrom).toBeNull()
    expect(buf.lastContiguousSeq).toBe(4)
  })

  it('spill 末尾半行 → 重启跳过残行，完整事件仍可恢复', () => {
    const dir = tmp()
    const buf = new BridgeEventBuffer({ limitBytes: 4096, highWaterBytes: 1, spillDir: dir, agentId: 'a1' })
    for (let i = 1; i <= 3; i += 1) buf.push(ev(i))
    const file = readdirSync(dir).find((f) => f.endsWith('.jsonl'))!
    appendFileSync(join(dir, file), '{"seq":4')
    const reopened = new BridgeEventBuffer({ limitBytes: 4096, highWaterBytes: 1, spillDir: dir, agentId: 'a1' })
    expect(reopened.takeFrom(1).map((e) => e.seq)).toEqual([1, 2, 3])
    rmSync(dir, { recursive: true, force: true })
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
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    expect(files.length).toBeGreaterThanOrEqual(1)
    // 文件名带起止序号，二次 spill 不许覆盖上一段
    expect(files[0]).toMatch(/^nr-a1-a0-\d+-\d+\.jsonl$/)
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

describe('多次落盘不丢早期事件（审计 F-06）', () => {
  it('连续多次 spill 后 takeFrom(1) 仍取回全部', () => {
    const dir = tmp()
    const buf = new BridgeEventBuffer({ limitBytes: 4096, highWaterBytes: 120, spillDir: dir, agentId: 'a2' })
    for (let i = 1; i <= 20; i += 1) buf.push(ev(i))
    expect(buf.spillCount).toBeGreaterThanOrEqual(2)
    expect(buf.takeFrom(1).map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(buf.toolStartAnchor()).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})
