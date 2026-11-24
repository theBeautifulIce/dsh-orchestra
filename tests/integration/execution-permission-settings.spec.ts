import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createExecutionPermissionSettings } from '../../src/service/execution-permission-settings.ts'

it('四种权限设置跨会话和重启保留，旧版本或无效模式不覆盖当前值', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'orchestra-execution-settings-'))
  try {
    const settings = createExecutionPermissionSettings(profile)
    expect(settings.read()).toEqual({ mode: 'full', revision: 0 })
    for (const [index, mode] of ['inherit', 'brain', 'user', 'full'].entries()) {
      expect(settings.save({ mode: mode as 'inherit', expected_revision: index })).toEqual({ mode, revision: index + 1 })
      expect(createExecutionPermissionSettings(profile).read()).toEqual({ mode, revision: index + 1 })
    }
    expect(() => settings.save({ mode: 'user', expected_revision: 0 })).toThrow('执行权限设置已更新')
    expect(() => settings.save({ mode: 'invalid' as 'user', expected_revision: 4 })).toThrow()
    expect(settings.read()).toEqual({ mode: 'full', revision: 4 })
    await writeFile(join(profile, 'orchestra', 'execution-settings.sqlite'), 'corrupt')
    expect(() => settings.read()).toThrow('无法读取执行权限设置')
  } finally { await rm(profile, { recursive: true, force: true }) }
})
