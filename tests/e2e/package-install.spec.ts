// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, fork } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import { createElement, type ComponentType } from 'react'
import { expect, it } from 'vitest'
import { inspectPackage } from '../../scripts/package-acceptance.ts'
import { renderPanel } from '../client/harness.ts'
import type { DshPanelContext } from '../../src/client/dsh-sidebar.tsx'
import type { NativeOrchestraToolViewContext } from '../../src/client/dsh-orchestra-toolview.tsx'

const installed = process.env.ORCHESTRA_PACKAGE_INSTALLED_DIR
const tarball = process.env.ORCHESTRA_PACKAGE_TEST_ARCHIVE
const sha = process.env.ORCHESTRA_PACKAGE_TEST_SHA256

it('包声明保留私有发布、默认阶段和显式宿主注入', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  expect(manifest).toMatchObject({ private: true, exports: { '.': { default: './lib/index.js' }, './client': './lib/client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: expect.arrayContaining([
      '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-input-trigger',
      '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-chat',
    ]) } } })
  expect(JSON.parse(readFileSync('orchestra.config.json', 'utf8')).phase).toBe('S2')
  expect(readFileSync('cordis.patch.yml', 'utf8')).toMatch(/id: dsh-orchestra, name: dsh-orchestra/)
})

it('安装指南指向同一份带版本的预发行工件，也给出摘要文件名', () => {
  const docs = ['README.md', 'README.en.md'].map(name => readFileSync(name, 'utf8'))
  const target = /https:\/\/github\.com\/theBeautifulIce\/dsh-orchestra\/releases\/download\/v([^/\s]+)\/dsh-orchestra-([^)]*)\.tgz/u
  const assets = docs.map(doc => {
    const match = doc.match(target)
    expect(match).toBeTruthy()
    expect(match![1]).toBe(match![2])
    expect(doc).toContain('SHA256SUMS.txt')
    return match![0]
  })
  expect(assets[0]).toBe(assets[1])
})

it('验包要求完整且唯一的客户端依赖，并继续接受已签旧版清单', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-package-inject-'))
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  const candidate = manifest.dsh.client.inject as string[]
  const addedClients = ['@deepseek-ai/dsh-client-ui-input-trigger',
    '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-chat']
  const previous = candidate.filter((dependency) => !addedClients.includes(dependency))
  const files: Record<string, string> = {
    'package/package.json': '',
    'package/lib/index.js': 'export function serveDshOrchestra() {}',
    'package/lib/index.d.ts': 'export declare function serveDshOrchestra(): void',
    'package/lib/client.js': 'window.__ModuleLoader__.load({})',
    'package/cordis.patch.yml': '[]',
    'package/orchestra.config.json': '{"phase":"S2"}',
    'package/README.md': 'Install the fixture',
    'package/docs/runbook.md': 'Runbook fixture',
    'package/docs/trial-circles.md': 'Trial fixture',
  }
  for (let version = 1; version <= 57; version++) {
    files['package/lib/infra/sqlite/migrations/' + String(version).padStart(3, '0') + '_fixture.sql'] = 'SELECT 1;'
  }
  function pack(name: string, inject: string[]) {
    const archive = join(root, name + '.tgz')
    writeFileSync(join(root, 'package/package.json'), JSON.stringify({
      ...manifest, dsh: { ...manifest.dsh, client: { ...manifest.dsh.client, inject } },
    }))
    writeFileSync(archive, execFileSync('tar', ['-czf', '-', '-C', root, ...Object.keys(files)]))
    return archive
  }
  try {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), content)
    }
    const valid = pack('candidate', [...candidate].reverse())
    expect(candidate).toHaveLength(9)
    expect(new Set(candidate).size).toBe(9)
    expect(inspectPackage(valid).migrations).toHaveLength(57)
    expect(() => inspectPackage(valid, { previous: true })).toThrow('DSH client inject must contain exactly')
    files['package/docs/assets/readme/extra.txt'] = 'extra'
    mkdirSync(join(root, 'package/docs/assets/readme'), { recursive: true })
    writeFileSync(join(root, 'package/docs/assets/readme/extra.txt'), 'extra')
    expect(() => inspectPackage(pack('extra', candidate))).toThrow('undeclared paths')
    delete files['package/docs/assets/readme/extra.txt']
    const legacy = pack('previous', previous)
    expect(inspectPackage(legacy, { previous: true }).migrations).toHaveLength(57)
    expect(() => inspectPackage(legacy)).toThrow('DSH client inject must contain exactly')
    for (const dependency of addedClients) {
      expect(() => inspectPackage(pack('missing-client', candidate.filter(item => item !== dependency))))
        .toThrow('DSH client inject must contain exactly')
    }
    expect(() => inspectPackage(pack('wrong-dependency', [...candidate.slice(0, -1), '@deepseek-ai/dsh-client-ui-unknown'])))
      .toThrow('DSH client inject must contain exactly')
    expect(() => inspectPackage(pack('duplicate-dependency', [...candidate.slice(0, -1), candidate[0]!])))
      .toThrow('DSH client inject must contain exactly')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it.runIf(Boolean(tarball && sha))('验包拒绝缺少清单声明的任一发布指南', () => {
  const receipt = inspectPackage(tarball!, { expectedSha256: sha! })
  const root = mkdtempSync(join(tmpdir(), 'orch-package-guides-'))
  try {
    execFileSync('tar', ['-zxf', '-', '-C', root], { input: readFileSync(tarball!) })
    const manifest = JSON.parse(readFileSync(join(root, 'package/package.json'), 'utf8'))
    for (const guide of ['docs/runbook.md', 'docs/trial-circles.md']) {
      if (!manifest.files?.includes(guide)) continue
      const archive = join(root, 'missing-' + guide.slice('docs/'.length) + '.tgz')
      writeFileSync(archive, execFileSync('tar', ['-czf', '-', '-C', root, ...receipt.entries.filter((name) => name !== 'package/' + guide)], { maxBuffer: 64 * 1024 * 1024 }))
      expect(() => inspectPackage(archive)).toThrow('Missing declared package guide: ' + guide)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it.runIf(Boolean(installed && tarball && sha))('实装 tarball 的服务、迁移、产物与受信侧栏注册同时可用', async () => {
  const receipt = inspectPackage(tarball!, { expectedSha256: sha! })
  expect(receipt.migrations.at(-1)!.version).toBeGreaterThan(57)
  const installedPath = installed!
  for (const file of ['lib/index.js', 'lib/client.js']) {
    const installedBytes = readFileSync(join(installedPath, file))
    const packedBytes = execFileSync('tar', ['-zxOf', '-', 'package/' + file], { input: readFileSync(tarball!),
      maxBuffer: Math.max(1024 * 1024, installedBytes.length + 1),
    })
    expect(installedBytes.equals(packedBytes)).toBe(true)
  }
  const root = mkdtempSync(join(tmpdir(), 'orch-package-e2e-'))
  const secret = 'packed-install-ledger-fixture'
  const hostProcess = fork(resolve('tests/fixtures/package-install-host.ts'),
    [installedPath, root, secret], { execArgv: ['--no-warnings'], windowsHide: true, silent: true })
  let diagnostics = ''
  hostProcess.stderr?.on('data', (chunk) => { diagnostics += String(chunk) })
  try {
    const data = await new Promise<{ endpoint: string; run_id: string; migrations: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Installed package host did not become ready: ' + diagnostics)), 10_000)
      hostProcess.once('message', (message) => { clearTimeout(timer); resolve(message as never) })
      hostProcess.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Installed package host exited ${code}: ${diagnostics}`)) })
      hostProcess.once('error', (error) => { clearTimeout(timer); reject(error) })
    })
    expect(data.migrations).toBe(receipt.migrations.length)
    const content = await fetch(data.endpoint + '/v1/artifacts/content?mode=preview&artifact_id=fixture&run_id=' + data.run_id, {
      headers: { 'x-orchestra-secret': secret },
    })
    expect(content.ok).toBe(true)
    expect(await content.text()).toContain('installed package artifact')

    const require = createRequire(resolve('package.json'))
    let client!: typeof import('../../src/client/index.tsx')
    const bundle = readFileSync(join(installedPath, 'lib/client.js'), 'utf8')
    runInNewContext(bundle, { window: { localStorage: window.localStorage,
      addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
      __ModuleLoader__: { load(value: { id: string; factory: (load: NodeJS.Require) => typeof client }) {
      expect(value.id).toBe('dsh-orchestra')
      client = value.factory(require)
    } } }, document, navigator, AbortController, URL, Headers, TextEncoder, TextDecoder, setTimeout, clearTimeout },
      { filename: 'installed-dsh-orchestra-client.js' })
    type Slot = Parameters<DshPanelContext['slots']['register']>[0] | Parameters<NativeOrchestraToolViewContext['slots']['register']>[0]
    const components: Array<{ slot: Slot; component: ComponentType }> = []
    const host = new Context()
    const slots = {
      inject(_slot: Slot['name'], mount: () => unknown) { return mount() },
      register(slot: Slot, component: ComponentType) {
        const entry = { slot, component }
        components.push(entry)
        return () => { components.splice(components.indexOf(entry), 1) }
      },
    }
    host.provide('slots', slots)
    const product = host.plugin(client as unknown as Plugin)
    await product.await()
    const nativeToolSlot = { name: 'tool.call.toolview', key: 'orchestra_task' }
    expect(components.map(({ slot }) => slot)).toEqual([nativeToolSlot])

    const fetcher: NonNullable<Parameters<typeof client.createPanelHost>[0]['fetcher']> = (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('x-orchestra-secret', secret)
      return fetch(input, { ...init, headers })
    }
    const transport = { baseUrl: data.endpoint, fetcher, initialRoute: 'settings' as const }
    const connect = (ctx: Context) => { ctx.provide('orchestraPanelTransport', transport) }
    const adapter = host.plugin(connect)
    await adapter.await()
    await expect.poll(() => components.length).toBe(3)
    const legacy = host.plugin({ inject: ['slots'], apply(ctx: Context) {
      client.registerDshOrchestraPanel(ctx as unknown as DshPanelContext, transport)
    } })
    await legacy.await()
    expect(components.map(({ slot }) => slot)).toEqual([
      nativeToolSlot,
      { name: 'main', key: 'dsh-orchestra' },
      { name: 'sidebar.panellist', id: 'dsh-orchestra', order: 20, label: expect.any(Function) },
    ])
    const view = await renderPanel(createElement(components.find(({ slot }) => slot.name === 'main')!.component))
    try {
      await expect.poll(async () => {
        await view.flush()
        return view.text()
      }, { timeout: 4000 }).toContain('S6')
      expect(view.text()).toContain('设置')
      expect(view.text()).toContain('服务已连接')
    } finally { view.unmount() }
    await legacy.dispose()
    await adapter.dispose()
    await expect.poll(() => components.map(({ slot }) => slot)).toEqual([nativeToolSlot])
    const replacement = host.plugin(connect)
    await replacement.await()
    await expect.poll(() => components.length).toBe(3)
    await product.dispose()
    await expect.poll(() => components.length).toBe(0)
    await replacement.dispose()
  } finally {
    if (hostProcess.exitCode === null && hostProcess.signalCode === null) {
      const exited = once(hostProcess, 'exit')
      if (hostProcess.connected) hostProcess.disconnect()
      else hostProcess.kill()
      await exited
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
