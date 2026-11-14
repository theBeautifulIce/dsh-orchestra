// B06 独立进程：工具已经产生副作用、还没回传结果时被 SIGKILL。
// 这个子进程只负责把 outbox 停到 pending，然后挂住等父进程杀；恢复逻辑在父进程测试里。
import { writeFileSync } from 'node:fs'
import { openDb } from '../../src/infra/sqlite/driver.ts'
import { ToolRegistry, ReadOnlyToolRunner, type HostRunner } from '../../src/executor/tools.ts'
import { EvidenceCollector } from '../../src/executor/evidence-collector.ts'

const [dbFile, marker, nodeRunId, secret, root] = process.argv.slice(2)
if (!dbFile || !marker || !nodeRunId || !secret || !root) {
  throw new Error('crash-collector-child: 参数不足')
}

const db = openDb(dbFile, { busyTimeoutMs: 10_000 })
const registry = new ToolRegistry()
registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
const host: HostRunner = {
  readonlyAvailable: () => true,
  run: async () => {
    // 副作用先发生，outbox 仍是 pending；父进程在这之后杀我。
    writeFileSync(marker, 'ran')
    await new Promise<never>(() => {})
    return { exitCode: 0, stdout: 'ok\n', stderr: '' }
  },
}
const collector = new EvidenceCollector({
  db,
  secret,
  registry,
  runner: new ReadOnlyToolRunner(registry, host, root),
  policy: { allow: ['ro.echo'], deny: [], declaredPolicy: 'pure' },
  allowedTools: ['ro.echo'],
  nodeRunId,
  attempt: 1,
  executorAgentId: 'agent_1',
  nowAt: () => '2026-11-13T03:00:00.000Z',
})
await collector.collect({ callId: 'call_child', tool: 'ro.echo', args: [], cwd: '.', timeoutMs: 60_000 })
