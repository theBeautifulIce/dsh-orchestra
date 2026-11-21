import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { sha256Hex } from '../../src/core/canonical.ts'
import {
  ToolRegistry, ReadOnlyToolRunner, assertCommandHash, commandHashOf, resolveInside,
  type HostRunner, type ToolDescriptor,
} from '../../src/executor/tools.ts'

const ROOT = resolve('D:/tmp/ws')
const roTool: ToolDescriptor = { name: 'git', capability: 'read_only', command: { bin: 'git', args: ['status'] } }

function setup(over?: Partial<HostRunner>, tool: ToolDescriptor = roTool) {
  const reg = new ToolRegistry()
  reg.register(tool)
  const run = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }))
  const host: HostRunner = { readonlyAvailable: () => true, run, ...over }
  return { reg, host, run, runner: new ReadOnlyToolRunner(reg, host, ROOT) }
}

describe('runTool 只读执行与强证据', () => {
  it('命令没注册 → RUN_TOOL_NOT_READ_ONLY，宿主未调用', async () => {
    const { runner, run } = setup()
    await expect(runner.runTool({ command: 'nope', args: [], cwd: '.', timeoutMs: 1000, workspaceRoot: ROOT }))
      .rejects.toMatchObject({ code: 'RUN_TOOL_NOT_READ_ONLY' })
    expect(run).not.toHaveBeenCalled()
  })

  it('注册了但 mutating / compensating → RUN_TOOL_NOT_READ_ONLY 且 details.capability 有值', async () => {
    const mut: ToolDescriptor = { name: 'git', capability: 'mutating', command: { bin: 'git', args: [] } }
    const { runner } = setup({}, mut)
    try {
      await runner.runTool({ command: 'git', args: [], cwd: '.', timeoutMs: 1000, workspaceRoot: ROOT })
      expect.unreachable()
    } catch (e: any) {
      expect(e.code).toBe('RUN_TOOL_NOT_READ_ONLY')
      expect(e.details.capability).toBe('mutating')
    }
  })

  it('宿主没有只读挂载 → EVIDENCE_SOURCE_UNAVAILABLE，不返回降级证据', async () => {
    const { runner } = setup({ readonlyAvailable: () => false })
    await expect(runner.runTool({ command: 'git', args: [], cwd: '.', timeoutMs: 1000, workspaceRoot: ROOT }))
      .rejects.toMatchObject({ code: 'EVIDENCE_SOURCE_UNAVAILABLE' })
  })

  it('cwd 越出工作区 → FORBIDDEN', async () => {
    const { runner } = setup()
    await expect(runner.runTool({ command: 'git', args: [], cwd: '../outside', timeoutMs: 1000, workspaceRoot: ROOT }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(() => resolveInside(ROOT, '../outside')).toThrowError(/cwd 越出工作区/)
  })

  it('正常执行：强证据字段齐、哈希与命令哈希对得上，请求里的 args 不覆盖注册表', async () => {
    const { runner, run } = setup()
    const res = await runner.runTool({ command: 'git', args: ['rm', '-rf', '.'], cwd: 'sub', timeoutMs: 5000, workspaceRoot: ROOT })
    expect(res.evidence.source).toBe('run_tool')
    expect(res.evidence.boundary).toBeUndefined()
    expect(res.evidence.exitCode).toBe(0)
    expect(res.evidence.stdoutHash).toBe(sha256Hex('ok'))
    expect(res.evidence.stderrHash).toBe(sha256Hex(''))
    expect(res.evidence.hashes.stdout).toBe(sha256Hex('ok'))
    expect(res.evidence.producedAt.length).toBeGreaterThan(0)
    expect(res.evidence.commandHash).toBe(commandHashOf('git', ['status'], resolve(ROOT, 'sub'), ROOT))
    expect(run).toHaveBeenCalledWith({ bin: 'git', args: ['status'], cwd: resolve(ROOT, 'sub'), timeoutMs: 5000 })
  })

  it('args 为空时同样用注册表的固定参数', async () => {
    const { runner, run } = setup()
    await runner.runTool({ command: 'git', args: [], cwd: '.', timeoutMs: 1000, workspaceRoot: ROOT })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ bin: 'git', args: ['status'] }))
  })

  it('assertCommandHash：对不上 → VERIFICATION_TOO_WEAK；对得上通过', async () => {
    const { runner } = setup()
    const { evidence } = await runner.runTool({ command: 'git', args: [], cwd: '.', timeoutMs: 1000, workspaceRoot: ROOT })
    expect(() => assertCommandHash(evidence, 'deadbeef')).toThrowError(/证据不作数/)
    expect(() => assertCommandHash(evidence, evidence.commandHash)).not.toThrow()
  })
})
