import { describe, expect, it } from 'vitest'
import { BridgeClient, bridgeHostAgentFactory } from '../../src/executor/bridge.ts'
import { OrchError } from '../../src/core/errors.ts'
import { defaultBridgeReply, fakeBridge } from '../fixtures/bridge.ts'

const spawnParams = { nodeRunId: 'nr1', attempt: 1, input: {}, outputSchema: {}, toolPolicy: {}, inheritHistory: false as const }
const sendParams = { executorAgentId: 'agent_1', attempt: 1, instruction: '开工', attemptId: 'a1' }

describe('桥 RPC 客户端', () => {
  it('spawn 回 sessionId/agentId，并记成已订阅；缺 agentId 抛协议不合', async () => {
    const transport = fakeBridge(() => defaultBridgeReply('executor.spawn'))
    const client = new BridgeClient(transport)
    const res = await client.spawn(spawnParams)
    expect(res).toEqual({ sessionId: 'sess_1', agentId: 'agent_1' })
    expect(client.isSubscribed('agent_1')).toBe(true)
    expect(transport.calls[0]?.params).toEqual(spawnParams)

    const bad = new BridgeClient(fakeBridge(() => ({ sessionId: 's1' })))
    await expect(bad.spawn(spawnParams)).rejects.toMatchObject({ code: 'PROTOCOL_VERSION_MISMATCH' })
  })

  it('listen 透传 fromSeq 与 signal，作为持续事件流入口', () => {
    const transport = fakeBridge(defaultBridgeReply)
    const client = new BridgeClient(transport)
    const ac = new AbortController()
    const stream = client.listen({ executorAgentId: 'agent_1', attempt: 1, fromSeq: 4 }, ac.signal)
    expect(transport.lastCall('executor.listen')?.params).toEqual({ executorAgentId: 'agent_1', attempt: 1, fromSeq: 4 })
    expect(stream[Symbol.asyncIterator]).toBeTypeOf('function')
  })

  it('subscribe 透传 fromSeq，重连两次用同一个 fromSeq 参数一致', async () => {
    const transport = fakeBridge(() => ({ subscribed: true, fromSeq: 7, lastSeq: 9 }))
    const client = new BridgeClient(transport)
    await client.subscribe({ executorAgentId: 'agent_1', attempt: 1, fromSeq: 7 })
    await client.subscribe({ executorAgentId: 'agent_1', attempt: 1, fromSeq: 7 })
    expect(transport.calls.map((c) => c.params)).toEqual([
      { executorAgentId: 'agent_1', attempt: 1, fromSeq: 7 },
      { executorAgentId: 'agent_1', attempt: 1, fromSeq: 7 },
    ])
  })

  it('未确认订阅前 send 抛 BRIDGE_NOT_SUBSCRIBED；确认后透传 instruction 与 attemptId', async () => {
    const transport = fakeBridge((method) => defaultBridgeReply(method))
    const client = new BridgeClient(transport)
    let err: unknown
    try {
      await client.send(sendParams)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(OrchError)
    expect((err as OrchError).code).toBe('BRIDGE_NOT_SUBSCRIBED')
    expect((err as OrchError).details.executorAgentId).toBe('agent_1')
    expect(transport.calls.length).toBe(0)

    await client.subscribe({ executorAgentId: 'agent_1', attempt: 1, fromSeq: 0 })
    await client.send(sendParams)
    expect(transport.lastCall('executor.send')?.params).toEqual(sendParams)
  })

  it('dispose 时 ack 落后抛 BRIDGE_ACK_LAG（proposed=true）；相等则成功且之后不许 send', async () => {
    const transport = fakeBridge(defaultBridgeReply)
    const client = new BridgeClient(transport)
    await client.spawn(spawnParams)
    let err: unknown
    try {
      await client.dispose({ executorAgentId: 'agent_1', serviceAckSeq: 3, bridgeLastSeq: 4 })
    } catch (e) {
      err = e
    }
    expect((err as OrchError).code).toBe('BRIDGE_ACK_LAG')
    expect((err as OrchError).details.proposed).toBe(true)
    expect((err as OrchError).httpStatus).toBe(409)

    await client.dispose({ executorAgentId: 'agent_1', serviceAckSeq: 4, bridgeLastSeq: 4 })
    expect(transport.lastCall('executor.dispose')?.params).toEqual({ executorAgentId: 'agent_1' })
    await expect(client.send(sendParams)).rejects.toMatchObject({ code: 'BRIDGE_NOT_SUBSCRIBED' })
  })

  it('whenIdle 缺超时或给 0 抛 SCHEMA_VERSION_UNSUPPORTED；30000 透传', async () => {
    const transport = fakeBridge(defaultBridgeReply)
    const client = new BridgeClient(transport)
    for (const timeoutMs of [undefined, 0, 1.5]) {
      let err: unknown
      try {
        await client.whenIdle({ executorAgentId: 'agent_1', timeoutMs: timeoutMs as number })
      } catch (e) {
        err = e
      }
      expect((err as OrchError).code).toBe('SCHEMA_VERSION_UNSUPPORTED')
      expect((err as OrchError).details.field).toBe('timeoutMs')
    }
    await client.whenIdle({ executorAgentId: 'agent_1', timeoutMs: 30000 })
    expect(transport.lastCall('executor.whenIdle')?.params).toEqual({ executorAgentId: 'agent_1', timeoutMs: 30000 })
  })

  it('cancel 四个合法值原样返回；宿主回 weird 抛协议不合', async () => {
    for (const value of ['interrupted', 'not_interruptible', 'already_stopped', 'unknown'] as const) {
      const client = new BridgeClient(fakeBridge(() => value))
      await expect(client.cancel({ executorAgentId: 'agent_1', attempt: 1 })).resolves.toBe(value)
    }
    const bad = new BridgeClient(fakeBridge(() => 'weird'))
    await expect(bad.cancel({ executorAgentId: 'agent_1', attempt: 1 })).rejects.toMatchObject({ code: 'PROTOCOL_VERSION_MISMATCH' })
  })

  it('state 透传 toolCallSeq/hasToolCall；state=halted 抛协议不合', async () => {
    const client = new BridgeClient(fakeBridge(() => ({ state: 'running', toolCallSeq: 5, hasToolCall: true })))
    await expect(client.state({ executorAgentId: 'agent_1' })).resolves.toEqual({ state: 'running', toolCallSeq: 5, hasToolCall: true })
    const bad = new BridgeClient(fakeBridge(() => ({ state: 'halted', toolCallSeq: 0, hasToolCall: false })))
    await expect(bad.state({ executorAgentId: 'agent_1' })).rejects.toMatchObject({ code: 'PROTOCOL_VERSION_MISMATCH' })
  })

  it('生产宿主工厂走 bridge.spawn，并显式声明不继承历史', async () => {
    const transport = fakeBridge(() => defaultBridgeReply('executor.spawn'))
    const factory = bridgeHostAgentFactory(new BridgeClient(transport))
    await expect(factory.create({
      nodeRunId: 'nr1', attempt: 1, input: {}, outputSchema: {}, toolPolicy: { allow: ['ro.echo'] }, inheritHistory: false,
    })).resolves.toEqual({ agentId: 'agent_1', sessionId: 'sess_1' })
    expect(transport.calls[0]).toMatchObject({
      method: 'executor.spawn',
      params: { nodeRunId: 'nr1', attempt: 1, input: {}, outputSchema: {}, toolPolicy: { allow: ['ro.echo'] }, inheritHistory: false },
    })
  })
})
