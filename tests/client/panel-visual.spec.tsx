// @vitest-environment jsdom
// S5-J 视觉硬门槛：静态断言 + 渲染断言。每条断言都指回规格 §8.6 的一行门槛。
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { PanelHost } from '../../src/client/panel-host.tsx'
import { COLOR, FONT_FLOOR_PX, FONT_PX } from '../../src/client/panel/tokens.ts'
import { TEXT_PAIRS, contrastRatio } from '../../src/client/panel/contrast.ts'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { SettingsScreen } from '../../src/client/panel/settings-screen.tsx'
import { TaskListScreen } from '../../src/client/panel/tasks-screen.tsx'
import { createFakeService, page, renderPanel, taskSummary, type FakeQuery, type FakeReply } from './harness.ts'

const noop = () => {}

function findRepoRoot(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'src', 'client', 'panel', 'tokens.ts'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('找不到仓库根目录：src/client/panel/tokens.ts 不在上层目录里')
}

const REPO_ROOT = findRepoRoot()
const PANEL_DIR = join(REPO_ROOT, 'src', 'client', 'panel')
const PANEL_FILES = readdirSync(PANEL_DIR).filter((name) => /\.tsx?$/.test(name)).sort()

type FontLiteral = { file: string; value: number; kind: 'fontSize' | 'font-shorthand' }
type WidthLiteral = { file: string; key: string; value: number }

/** 扫描面板源码里的字号字面量：fontSize 属性与 font 简写里的 px 数值。 */
function scanFontLiterals(): FontLiteral[] {
  const found: FontLiteral[] = []
  for (const name of PANEL_FILES) {
    if (name === 'tokens.ts') continue
    const source = readFileSync(join(PANEL_DIR, name), 'utf8')
    for (const match of source.matchAll(/fontSize\s*:\s*(\d+(?:\.\d+)?)/g)) {
      found.push({ file: name, value: Number(match[1]), kind: 'fontSize' })
    }
    for (const match of source.matchAll(/(?:^|[;,{])\s*font\s*:\s*([^;},]+)/g)) {
      const px = /(\d+(?:\.\d+)?)px/.exec(match[1] ?? '')
      if (px) found.push({ file: name, value: Number(px[1]), kind: 'font-shorthand' })
    }
  }
  return found
}

/** 扫描面板源码里的固定宽度与最小宽度（只看数字字面量，百分比与计算值不算）。 */
function scanWidthLiterals(): WidthLiteral[] {
  const found: WidthLiteral[] = []
  for (const name of PANEL_FILES) {
    const source = readFileSync(join(PANEL_DIR, name), 'utf8')
    for (const match of source.matchAll(/(?<![A-Za-z])(minWidth|width)\s*:\s*(\d+(?:\.\d+)?)/g)) {
      found.push({ file: name, key: match[1] ?? 'width', value: Number(match[2]) })
    }
  }
  return found
}

/** 读元素内联样式里声明的字号（font-size 优先，其次 font 简写里的 px）。 */
function inlineFontSize(element: Element): number | null {
  const raw = element.getAttribute('style') ?? ''
  const size = /font-size\s*:\s*(\d+(?:\.\d+)?)px/.exec(raw)
  if (size) return Number(size[1])
  const shorthand = /(?:^|;)\s*font\s*:\s*([^;]+)/.exec(raw)
  if (shorthand) {
    const px = /(\d+(?:\.\d+)?)px/.exec(shorthand[1] ?? '')
    if (px) return Number(px[1])
  }
  return null
}

/** 按 font-size 的继承规则算出元素实际生效的字号。 */
function effectiveFontSize(element: Element): number {
  let current: Element | null = element
  while (current) {
    const size = inlineFontSize(current)
    if (size !== null) return size
    current = current.parentElement
  }
  return 16
}

function apiFrom(handler: (query: FakeQuery) => FakeReply | Promise<FakeReply>) {
  const service = createFakeService(handler)
  return { api: createResourcesApi(createApiClient('http://panel.test', service.fetcher)), service }
}

describe('S5-J 视觉硬门槛', () => {
  it('门槛① 面板源码的字号字面量只剩棘轮清单里的历史项，新代码必须走 tokens.ts', () => {
    // 历史存量（迁移到 tokens.ts 之前不许新增；迁移后要同步改这份清单）：
    const legacyFontLiterals: Record<string, number[]> = {
      'decision-inbox.tsx': [16],
      'memory-panel.tsx': [16],
      'shell.tsx': [16],
      'unverified-effects.tsx': [16],
      'workflow-canvas-view.tsx': [14],
      'workflow-canvas.tsx': [16],
      'workflow-editor.tsx': [14, 16],
    }
    const found = scanFontLiterals()
    const actual: Record<string, number[]> = {}
    for (const item of found) {
      const bucket = actual[item.file] ?? []
      bucket.push(item.value)
      actual[item.file] = bucket
    }
    for (const values of Object.values(actual)) values.sort((a, b) => a - b)
    // 扫描器确实在工作（不是空壳断言）
    expect(found.length).toBeGreaterThanOrEqual(8)
    // 新增一个字面量就红：清单必须与源码逐项对上
    expect(actual).toEqual(legacyFontLiterals)
    // 本次新增的设置屏不得带字号字面量
    expect(found.filter((item) => item.file === 'settings-screen.tsx')).toEqual([])
    // 历史字面量也不许低于正文下限
    for (const item of found) {
      expect(item.value).toBeGreaterThanOrEqual(FONT_FLOOR_PX.body)
    }
  })

  it('门槛② 字号下限：FONT_PX 每项不低于 FONT_FLOOR_PX，且下限本身不低于规格', () => {
    expect(Object.keys(FONT_FLOOR_PX).sort()).toEqual(['body', 'helper', 'menu'])
    for (const key of Object.keys(FONT_FLOOR_PX) as (keyof typeof FONT_FLOOR_PX)[]) {
      expect(FONT_PX[key]).toBeGreaterThanOrEqual(FONT_FLOOR_PX[key])
    }
    expect(FONT_FLOOR_PX.body).toBeGreaterThanOrEqual(13)
    expect(FONT_FLOOR_PX.helper).toBeGreaterThanOrEqual(12)
    expect(FONT_FLOOR_PX.menu).toBeGreaterThanOrEqual(12.5)
  })

  it('门槛③ 对比度：TEXT_PAIRS 每项实测比值不低于其下限', () => {
    const expectedFloors: Record<string, number> = {
      正文: 4.5,
      辅助文字: 4.5,
      成功状态文字: 4.5,
      警告状态文字: 4.5,
      危险状态文字: 4.5,
      链接: 3,
    }
    expect(TEXT_PAIRS.length).toBeGreaterThanOrEqual(6)
    for (const pair of TEXT_PAIRS) {
      const ratio = contrastRatio(pair.fg, pair.bg)
      expect(ratio).toBeGreaterThan(1)
      expect(ratio).toBeLessThan(21)
      expect([4.5, 3]).toContain(pair.floor)
      expect(expectedFloors[pair.label]).toBe(pair.floor)
      expect(ratio).toBeGreaterThanOrEqual(pair.floor)
    }
    expect(COLOR.canvas).toBe('#ffffff')
  })

  it('门槛④ 面板源码没有超过 1366px 的固定宽度或最小宽度', () => {
    const widths = scanWidthLiterals()
    // 扫描器确实在工作（不是空壳断言）
    expect(widths.length).toBeGreaterThanOrEqual(10)
    expect(widths.some((item) => item.key === 'width' && item.value === 236)).toBe(true)
    const tooWide = widths.filter((item) => item.value > 1366)
    expect(tooWide).toEqual([])
  })

  it('门槛⑤ 长标题完整保留、title 承载全文、样式负责截断', async () => {
    const longTitle = '超长任务标题-'.repeat(40)
    const { api } = apiFrom(() => ({ ok: true, data: page([taskSummary({ title: longTitle })]) }))
    const view = await renderPanel(<TaskListScreen api={api} onSelectTask={noop} />)
    await view.flush()
    const button = view.findAll('button').find((item) => (item.getAttribute('title') ?? '').length > 100)
    expect(button).toBeDefined()
    expect(button?.textContent).toBe(longTitle)
    expect(button?.getAttribute('title')).toBe(longTitle)
    const style = button?.getAttribute('style') ?? ''
    expect(style).toContain('text-overflow: ellipsis')
    expect(style).toContain('overflow: hidden')
    expect(style).toContain('white-space: nowrap')
    view.unmount()
  })

  it('门槛② 实测字号：面板渲染出来的文字不低于规格下限', async () => {
    const view = await renderPanel(
      <PanelShell activeRoute="tasks" onNavigate={noop} serviceConnected={true}>
        <div>正文内容</div>
      </PanelShell>,
    )
    const elements = Array.from(view.container.querySelectorAll('*'))
    expect(elements.length).toBeGreaterThan(5)
    for (const element of elements) {
      expect(effectiveFontSize(element)).toBeGreaterThanOrEqual(FONT_FLOOR_PX.helper)
    }
    const navButtons = Array.from(view.container.querySelectorAll('aside nav button'))
    expect(navButtons.length).toBeGreaterThan(0)
    for (const button of navButtons) {
      expect(effectiveFontSize(button)).toBeGreaterThanOrEqual(FONT_FLOOR_PX.menu)
    }
    const header = view.container.querySelector('header')
    expect(header).not.toBeNull()
    expect(effectiveFontSize(header as Element)).toBeGreaterThanOrEqual(FONT_FLOOR_PX.menu)
    view.unmount()
  })

  it('设置屏拿不到状态时显示「未知」，不填猜测值', async () => {
    const view = await renderPanel(<SettingsScreen />)
    const values = Array.from(view.container.querySelectorAll('dd')).map((element) => element.textContent)
    expect(values).toEqual(['未知', '未知', '未知', '未知', '未知', '未知'])
    view.unmount()
  })

  it('设置屏按真实状态显示服务连接、协议、快照、事件流、阶段与版本', async () => {
    const view = await renderPanel(
      <SettingsScreen
        serviceConnected={true}
        protocolMismatch={false}
        snapshotStale={false}
        streamStatus="live"
        phase="S5"
        panelVersion="0.1.0"
      />,
    )
    const values = Array.from(view.container.querySelectorAll('dd')).map((element) => element.textContent)
    expect(values).toEqual(['已连接', '与服务一致', '最新', '实时更新', 'S5', '0.1.0'])
    for (const label of Array.from(view.container.querySelectorAll('dt'))) {
      expect(effectiveFontSize(label)).toBeGreaterThanOrEqual(FONT_FLOOR_PX.menu)
    }
    for (const value of Array.from(view.container.querySelectorAll('dd'))) {
      expect(effectiveFontSize(value)).toBeGreaterThanOrEqual(FONT_FLOOR_PX.body)
    }
    view.unmount()
  })

  it('宿主一行接入：PanelHost 组装客户端、事件流与面板，设置屏读到真实状态', async () => {
    const service = createFakeService((query) => {
      if (query.path === '/health') return { ok: true, data: { ok: true, phase: 'S5', epoch: 3 } }
      if (query.path === '/v1/tasks') return { ok: true, data: page([taskSummary()]) }
      if (query.path === '/v1/events') return { ok: true, data: { items: [] } }
      return { ok: true, data: {} }
    })
    const view = await renderPanel(<PanelHost baseUrl="http://panel.test" fetcher={service.fetcher} />)
    await view.flush()
    await view.flush()
    const settingsButton = view.findAll('button').find((item) => item.textContent === '设置')
    expect(settingsButton).toBeDefined()
    await view.click(settingsButton as Element)
    await view.flush()
    const values = Array.from(view.container.querySelectorAll('dd')).map((element) => element.textContent)
    expect(values[0]).toBe('已连接')
    expect(values[1]).toBe('与服务一致')
    expect(values[4]).toBe('S5')
    expect(service.calls.some((call) => call.path === '/health')).toBe(true)
    view.unmount()
  })
})
