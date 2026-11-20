// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync, fork } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createElement, type ComponentType } from 'react'
import { expect, it } from 'vitest'
import { inspectPackage } from '../../scripts/package-acceptance.ts'
import { renderPanel } from '../client/harness.ts'
import type { DshPanelContext } from '../../src/client/dsh-sidebar.tsx'

const installed = process.env.ORCHESTRA_PACKAGE_INSTALLED_DIR
const tarball = process.env.ORCHESTRA_PACKAGE_TEST_ARCHIVE
const sha = process.env.ORCHESTRA_PACKAGE_TEST_SHA256

it('包声明保留私有发布、默认阶段和显式宿主注入', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  expect(manifest).toMatchObject({ private: true, exports: { '.': { default: './lib/index.js' }, './client': './lib/client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: expect.arrayContaining([
      '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-layout',
    ]) } } })
  expect(JSON.parse(readFileSync('orchestra.config.json', 'utf8')).phase).toBe('S2')
  expect(readFileSync('cordis.patch.yml', 'utf8').replace(/^\s*#.*$/gm, '').trim()).toBe('[]')
})

it.runIf(Boolean(installed && tarball && sha))('实装 tarball 的服务、迁移、产物与受信侧栏注册同时可用', async () => {
  const receipt = inspectPackage(tarball!, { expectedSha256: sha! })
  expect(receipt.migrations.at(-1)!.version).toBeGreaterThan(57)
  const installedPath = installed!
  for (const file of ['lib/index.js', 'lib/client.js']) {
    expect(readFileSync(join(installedPath, file))).toEqual(execFileSync('tar', ['-xOf', tarball!, 'package/' + file]))
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
    runInNewContext(bundle, { window: { __ModuleLoader__: { load(value: { id: string; factory: (load: NodeJS.Require) => typeof client }) {
      expect(value.id).toBe('dsh-orchestra')
      client = value.factory(require)
    } } }, document, navigator, AbortController, URL, Headers, TextEncoder, TextDecoder, setTimeout, clearTimeout },
      { filename: 'installed-dsh-orchestra-client.js' })
    const components: Array<{ slot: Parameters<DshPanelContext['slots']['register']>[0]; component: ComponentType }> = []
    const host: DshPanelContext = {
      effect(factory) { for (const apply of factory()) (apply as () => void)() },
      slots: {
        inject(_slot, apply) { return apply },
        register(slot, component) { components.push({ slot, component }) },
      },
    }
    const fetcher: Parameters<typeof client.createPanelHost>[0]['fetcher'] = (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('x-orchestra-secret', secret)
      return fetch(input, { ...init, headers })
    }
    client.registerDshOrchestraPanel(host, { baseUrl: data.endpoint, fetcher, initialRoute: 'settings' })
    expect(components.map(({ slot }) => slot)).toEqual([
      { name: 'main', key: 'dsh-orchestra' },
      { name: 'sidebar.panellist', id: 'dsh-orchestra', order: 20, label: expect.any(Function) },
    ])
    const view = await renderPanel(createElement(components[0]!.component))
    try {
      await view.flush()
      expect(view.text()).toContain('设置')
      expect(view.text()).toContain('S6')
      expect(view.text()).toContain('服务已连接')
    } finally { view.unmount() }
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
