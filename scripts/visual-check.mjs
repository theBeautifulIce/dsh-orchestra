#!/usr/bin/env node
// S5-J 视觉门槛实测：在 1600×1000 与 1366×900 两个视口下，用无头 Chrome 真跑面板，
// 量 document.documentElement.scrollWidth <= clientWidth 是否成立。
//
// 用法：node scripts/visual-check.mjs [--keep]
// 退出码：0 = 两个视口都通过；1 = 有视口未通过；2 = 环境不可用（找不到浏览器 / 构建失败）。
//
// 不新增依赖：构建用仓库自带的 tsdown，浏览器用本机 Chrome/Edge，CDP 走 Node 内置 WebSocket。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORK_DIR = join(REPO_ROOT, 'node_modules', '.cache', 'dsh-visual-check')
const PAGE_FILE = join(WORK_DIR, 'panel.html')
const BUNDLE_FILE = join(WORK_DIR, 'panel.bundle.js')
const ENTRY_FILE = join(WORK_DIR, 'entry.tsx')

const VIEWPORTS = [
  { name: '1600x1000', width: 1600, height: 1000 },
  { name: '1366x900', width: 1366, height: 900 },
]

const BROWSER_CANDIDATES = [
  process.env.DSH_VISUAL_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

const ENTRY_SOURCE = `import { createRoot } from 'react-dom/client'
import React from 'react'
import { PanelHost } from '../../../src/client/panel-host.tsx'

// 页面挂载入口：把面板挂到指定容器，用页面给的 fetch 拉数据。
globalThis.__dshVisual = {
  mount(fetcher: unknown, containerId: string) {
    const container = document.getElementById(containerId)
    if (!container) throw new Error('找不到容器：' + containerId)
    createRoot(container).render(
      React.createElement(PanelHost, {
        baseUrl: 'http://127.0.0.1:8787',
        fetcher: fetcher,
        panelVersion: '0.1.0-visual-check',
      }),
    )
  },
}
`

const PAGE_SOURCE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DSH Orchestra 面板视觉实测</title>
<style>html,body{margin:0;padding:0;background:#ffffff}#root{min-height:100vh}#visual-result{display:none}</style>
</head>
<body>
<div id="root"></div>
<div id="visual-result" data-state="pending">PENDING</div>
<script src="./panel.bundle.js"></script>
<script>
(function () {
  var LONG_TITLE = '这是一个刻意写得很长很长的任务标题，用来检验面板在窄视口下会不会把整页撑出横向滚动条，也用来检验标题被截断之后还能不能通过 title 提示拿到全文';
  var TASKS = [
    {
      task_id: 't-1', title: '短标题任务', workflow_id: 'wf-1', workflow_version: 1,
      status: 'running', display_status: 'running', current_run_id: 'run-1', session_id: null,
      run_count: 2, open_decision_count: 0, oldest_open_decision_age_seconds: null,
      unverified_count: 0, max_side_effect_level: 'compensable', max_heartbeat_age_ms: 900,
      attention: 'running', attention_reason: '任务仍在执行', updated_at: '2026-11-18T00:00:00.000Z'
    },
    {
      task_id: 't-2', title: LONG_TITLE, workflow_id: 'wf-1', workflow_version: 1,
      status: 'running', display_status: 'running', current_run_id: 'run-2', session_id: null,
      run_count: 5, open_decision_count: 1, oldest_open_decision_age_seconds: 120,
      unverified_count: 0, max_side_effect_level: 'compensable', max_heartbeat_age_ms: 900,
      attention: 'running', attention_reason: '任务仍在执行', updated_at: '2026-11-18T00:00:00.000Z'
    }
  ];

  function envelope(data, seq) {
    return { ok: true, schema_version: 1, as_of_seq: seq || 1, data: data };
  }
  function jsonResponse(body) {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: function () { return Promise.resolve(body); }
    };
  }
  function stubFetch(input) {
    var url = new URL(String(input));
    var path = url.pathname;
    if (path === '/health') {
      return Promise.resolve(jsonResponse(envelope({ ok: true, phase: 'S5', epoch: 7 })));
    }
    if (path === '/v1/tasks') {
      return Promise.resolve(jsonResponse(envelope({ items: TASKS, next_cursor: null })));
    }
    if (path === '/v1/events') {
      return Promise.resolve(jsonResponse(envelope({ items: [] })));
    }
    if (path.indexOf('/v1/events/stream') === 0) {
      return Promise.resolve({
        ok: false, status: 503, headers: new Headers(),
        json: function () { return Promise.resolve(envelope({})); }
      });
    }
    return Promise.resolve(jsonResponse(envelope({ items: [] })));
  }

  function hasDirectText(el) {
    for (var i = 0; i < el.childNodes.length; i += 1) {
      var node = el.childNodes[i];
      if (node.nodeType === 3 && node.textContent && node.textContent.trim()) return true;
    }
    return false;
  }
  function parseColor(value) {
    var text = String(value || '');
    var open = text.indexOf('(');
    var close = text.indexOf(')');
    if (open < 0 || close <= open) return null;
    var parts = text.slice(open + 1, close).split(',').map(function (part) { return parseFloat(part); });
    return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts.length > 3 ? parts[3] : 1 };
  }
  function colorSpread(value) {
    var color = parseColor(value);
    if (!color || color.a === 0) return null;
    var max = Math.max(color.r, color.g, color.b);
    var min = Math.min(color.r, color.g, color.b);
    return { r: color.r, g: color.g, b: color.b, max: max, min: min, delta: max - min };
  }
  function collectFonts() {
    var min = null;
    var minText = null;
    var below12 = [];
    var histogram = {};
    var nodes = document.querySelectorAll('#root *');
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (!hasDirectText(el)) continue;
      var size = parseFloat(getComputedStyle(el).fontSize);
      if (isNaN(size)) continue;
      histogram[size] = (histogram[size] || 0) + 1;
      if (min === null || size < min) {
        min = size;
        minText = (el.textContent || '').trim().slice(0, 20);
      }
      if (size < 12) {
        below12.push({ tag: el.tagName, size: size, text: (el.textContent || '').trim().slice(0, 20) });
      }
    }
    return { min: min, minText: minText, below12: below12.slice(0, 10), histogram: histogram };
  }
  function collectOffenders(clientWidth) {
    var out = [];
    var nodes = document.querySelectorAll('#root *');
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      var rect = el.getBoundingClientRect();
      if (rect.width > clientWidth + 1 || rect.right > clientWidth + 1) {
        out.push({
          tag: el.tagName,
          width: Math.round(rect.width),
          right: Math.round(rect.right),
          text: (el.textContent || '').trim().slice(0, 24)
        });
      }
    }
    return out.slice(0, 10);
  }
  function collectLongTitle() {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('#root main button[title]'));
    var target = null;
    for (var i = 0; i < buttons.length; i += 1) {
      if ((buttons[i].getAttribute('title') || '').length > 60) { target = buttons[i]; break; }
    }
    if (!target) return { found: false };
    var cs = getComputedStyle(target);
    var title = target.getAttribute('title') || '';
    return {
      found: true,
      titleAttributeLength: title.length,
      textLength: (target.textContent || '').length,
      textMatchesTitle: target.textContent === title,
      textOverflow: cs.textOverflow,
      overflow: cs.overflow,
      whiteSpace: cs.whiteSpace,
      renderedWidth: Math.round(target.getBoundingClientRect().width),
      scrollWidth: target.scrollWidth,
      clientWidth: target.clientWidth,
      truncated: target.scrollWidth > target.clientWidth
    };
  }
  function collectSidebarColors() {
    var aside = document.querySelector('#root aside');
    var out = [];
    if (!aside) return out;
    var nodes = aside.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i += 1) {
      var bg = getComputedStyle(nodes[i]).backgroundColor;
      if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
      var spread = colorSpread(bg);
      out.push({ tag: nodes[i].tagName, background: bg, rgb: spread, delta: spread ? spread.delta : null });
    }
    return out.slice(0, 10);
  }
  function measure(label) {
    var de = document.documentElement;
    var body = document.body;
    var root = document.getElementById('root');
    var navButton = document.querySelector('#root aside nav button');
    var header = document.querySelector('#root header');
    var app = document.querySelector('#root > div');
    var payload = {
      label: label,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      noHorizontalOverflow: de.scrollWidth <= de.clientWidth,
      rootScrollWidth: root ? root.scrollWidth : null,
      rootClientWidth: root ? root.clientWidth : null,
      offenders: collectOffenders(de.clientWidth),
      fonts: collectFonts(),
      navFontSize: navButton ? parseFloat(getComputedStyle(navButton).fontSize) : null,
      headerFontSize: header ? parseFloat(getComputedStyle(header).fontSize) : null,
      longTitle: collectLongTitle(),
      appFontSize: app ? parseFloat(getComputedStyle(app).fontSize) : null,
      appBackground: app ? getComputedStyle(app).backgroundColor : null,
      bodyBackground: getComputedStyle(body).backgroundColor,
      sidebarColors: collectSidebarColors(),
      navLabels: Array.prototype.map.call(
        document.querySelectorAll('#root aside nav button'),
        function (button) { return button.textContent; }
      ),
      mainPresent: !!document.querySelector('#root main')
    };
    var target = document.getElementById('visual-result');
    target.textContent = JSON.stringify(payload);
    target.setAttribute('data-state', 'done');
  }

  try {
    window.__dshVisual.mount(stubFetch, 'root');
  } catch (error) {
    document.getElementById('visual-result').textContent = JSON.stringify({ mountError: String(error) });
    document.getElementById('visual-result').setAttribute('data-state', 'error');
    return;
  }
  [0, 120, 400, 1000, 2000].forEach(function (delay) {
    setTimeout(function () { measure('t+' + delay + 'ms'); }, delay);
  });
})();
</script>
</body>
</html>
`

function sleep(ms) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms) })
}

function log(line) {
  console.log(line)
}

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

/** 用仓库自带的 tsdown 把面板打成一个自包含的浏览器包（React 一并打进去，页面不用模块加载器）。 */
async function buildBundle() {
  mkdirSync(WORK_DIR, { recursive: true })
  writeFileSync(ENTRY_FILE, ENTRY_SOURCE, 'utf8')
  await build({
    cwd: REPO_ROOT,
    config: false,
    entry: [ENTRY_FILE],
    outDir: WORK_DIR,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    dts: false,
    clean: false,
    minify: false,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    silent: true,
    outputOptions: { entryFileNames: 'panel.bundle.js' },
  })
  if (!existsSync(BUNDLE_FILE)) throw new Error('构建结束但找不到产物：' + BUNDLE_FILE)
  return statSync(BUNDLE_FILE).size
}

/** 连 DevTools WebSocket：CDP 用来精确设置视口，而不是靠窗口尺寸猜。 */
function connectCdp(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    const listeners = []
    let nextId = 1
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (message.id !== undefined) {
        const entry = pending.get(message.id)
        if (!entry) return
        pending.delete(message.id)
        if (message.error) entry.reject(new Error(message.error.message || 'CDP 调用失败'))
        else entry.resolve(message.result)
        return
      }
      for (const listener of listeners) listener(message)
    })
    socket.addEventListener('error', () => { rejectPromise(new Error('DevTools WebSocket 连接失败')) })
    socket.addEventListener('close', () => {
      for (const entry of pending.values()) entry.reject(new Error('DevTools WebSocket 已关闭'))
      pending.clear()
    })
    socket.addEventListener('open', () => {
      resolvePromise({
        send(method, params = {}, sessionId) {
          const id = nextId++
          const message = { id, method, params }
          if (sessionId) message.sessionId = sessionId
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej })
            socket.send(JSON.stringify(message))
          })
        },
        on(listener) { listeners.push(listener) },
        close() { try { socket.close() } catch { /* 忽略 */ } },
      })
    })
  })
}

async function waitForDevToolsEndpoint(profileDir, timeoutMs) {
  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const lines = readFileSync(portFile, 'utf8').split(/\r?\n/)
      if (lines.length >= 2 && lines[0] && lines[1]) return 'ws://127.0.0.1:' + lines[0] + lines[1]
    }
    await sleep(100)
  }
  throw new Error('等不到 Chrome 的 DevTools 端口文件：' + portFile)
}

function toFileUrl(path) {
  return 'file:///' + path.replace(/\\/g, '/')
}

/** 在一个视口下真跑一次面板，把页面自己量出来的数据取回来。 */
async function measureViewport(browserPath, viewport, pageUrl) {
  const profileDir = join(WORK_DIR, 'profile-' + viewport.name)
  try {
    rmSync(profileDir, { recursive: true, force: true })
  } catch (error) {
    log('清理旧的浏览器 profile 失败（继续用新 profile）: ' + (error && error.message ? error.message : String(error)))
  }
  const args = [
    '--headless',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--user-data-dir=' + profileDir,
    '--remote-debugging-port=0',
    'about:blank',
  ]
  const child = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const commandLine = [browserPath, ...args].join(' ')
  let client = null
  try {
    const endpoint = await waitForDevToolsEndpoint(profileDir, 30000)
    client = await connectCdp(endpoint)
    const consoleErrors = []
    client.on((message) => {
      if (message.method === 'Runtime.consoleAPICalled' && message.params && message.params.type === 'error') {
        consoleErrors.push((message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' '))
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params && message.params.exceptionDetails
        consoleErrors.push('uncaught: ' + ((details && (details.exception && details.exception.description)) || (details && details.text) || 'unknown'))
      }
    })
    const created = await client.send('Target.createTarget', { url: 'about:blank' })
    const attached = await client.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
    const sessionId = attached.sessionId
    await client.send('Page.enable', {}, sessionId)
    await client.send('Runtime.enable', {}, sessionId)
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId)
    await client.send('Page.navigate', { url: pageUrl }, sessionId)

    let payload = null
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const evaluated = await client.send('Runtime.evaluate', {
        expression: "(function () { var el = document.getElementById('visual-result'); return el ? el.textContent : ''; })()",
        returnByValue: true,
      }, sessionId)
      const text = evaluated && evaluated.result ? evaluated.result.value : ''
      if (typeof text === 'string' && text.startsWith('{')) {
        try {
          const parsed = JSON.parse(text)
          payload = parsed
          if (parsed.label === 't+2000ms') break
        } catch { /* 还没写完，继续等 */ }
      }
      await sleep(200)
    }
    return { commandLine, payload, consoleErrors, endpoint }
  } finally {
    if (client) {
      try { await client.send('Browser.close') } catch { /* 忽略 */ }
      client.close()
    }
    child.kill()
  }
}

/** 逐条判定视觉门槛（门槛来自规格 §8.6 行 659-667）。 */
function judge(viewport, result) {
  const payload = result.payload
  if (!payload) {
    return { pass: false, reasons: ['页面没有产出测量结果（30 秒内 #visual-result 仍是 PENDING）'], checks: [] }
  }
  const reasons = []
  const checks = []
  function check(gate, ok, detail) {
    checks.push({ gate, ok: !!ok, detail })
    if (!ok) reasons.push(gate + '：' + detail)
  }

  check('G0-面板已渲染', !payload.mountError && payload.mainPresent,
    payload.mountError ? ('挂载失败：' + payload.mountError) : ('main ' + (payload.mainPresent ? '存在' : '缺失')))
  check('G1-视口尺寸精确', payload.innerWidth === viewport.width && payload.innerHeight === viewport.height,
    '实测 ' + payload.innerWidth + '×' + payload.innerHeight + '，目标 ' + viewport.width + '×' + viewport.height)
  check('G2-无横向溢出', payload.noHorizontalOverflow === true,
    'documentElement.scrollWidth ' + payload.scrollWidth + ' vs clientWidth ' + payload.clientWidth +
    '；根容器 scrollWidth/clientWidth ' + payload.rootScrollWidth + '/' + payload.rootClientWidth +
    '；越界元素 ' + JSON.stringify(payload.offenders))
  check('G3-正文基础字号≥13px', typeof payload.appFontSize === 'number' && payload.appFontSize >= 13,
    '面板根容器计算字号 ' + payload.appFontSize + 'px')
  check('G4-辅助文字≥12px', !!payload.fonts && payload.fonts.below12.length === 0,
    '渲染文本最小 ' + (payload.fonts ? payload.fonts.min : 'n/a') + 'px（' + (payload.fonts ? payload.fonts.minText : '') +
    '）；小于 12px 的元素 ' + JSON.stringify(payload.fonts ? payload.fonts.below12 : []))
  check('G5-菜单与顶导≥12.5px',
    typeof payload.navFontSize === 'number' && payload.navFontSize >= 12.5 &&
    typeof payload.headerFontSize === 'number' && payload.headerFontSize >= 12.5,
    '左侧菜单 ' + payload.navFontSize + 'px，顶部导航 ' + payload.headerFontSize + 'px')
  const longTitle = payload.longTitle || {}
  check('G6-长标题截断且 title 承载全文',
    longTitle.found === true && longTitle.textMatchesTitle === true &&
    longTitle.textOverflow === 'ellipsis' && longTitle.overflow === 'hidden' && longTitle.whiteSpace === 'nowrap',
    longTitle.found === true
      ? ('title ' + longTitle.titleAttributeLength + ' 字 / 文本 ' + longTitle.textLength + ' 字，一致=' + longTitle.textMatchesTitle +
        '；text-overflow=' + longTitle.textOverflow + '，overflow=' + longTitle.overflow + '，white-space=' + longTitle.whiteSpace +
        '；本视口是否被截断=' + longTitle.truncated)
      : '页面上没有找到带 title 的超长标题')
  const dark = payload.appBackground ? /rgb\((\d+), (\d+), (\d+)\)/.exec(payload.appBackground) : null
  const maxChannel = dark ? Math.max(Number(dark[1]), Number(dark[2]), Number(dark[3])) : null
  check('G7-浅色底不用黑色', maxChannel !== null && maxChannel >= 200,
    '面板底色 ' + payload.appBackground + '，页面底色 ' + payload.bodyBackground)
  const sidebar = payload.sidebarColors || []
  const maxDelta = sidebar.reduce((acc, item) => (typeof item.delta === 'number' && item.delta > acc ? item.delta : acc), 0)
  check('G8-菜单无装饰性彩条', maxDelta <= 40,
    '侧栏元素底色最大通道差 ' + maxDelta + '（阈值 40）；' + JSON.stringify(sidebar))
  check('G9-页面无运行时错误', result.consoleErrors.length === 0,
    result.consoleErrors.length === 0 ? '无 console error / uncaught' : ('页面报错：' + result.consoleErrors.join(' | ')))

  return { pass: reasons.length === 0, reasons, checks }
}

async function main() {
  const keep = process.argv.includes('--keep')
  log('== S5-J 视觉门槛实测（无头 Chrome，两个视口） ==')
  log('工作目录: ' + WORK_DIR)
  const browserPath = findBrowser()
  if (!browserPath) {
    log('环境不可用：找不到 Chrome/Edge，可执行文件候选：')
    for (const candidate of BROWSER_CANDIDATES) log('  - ' + candidate)
    log('可以用 DSH_VISUAL_BROWSER 环境变量指定可执行文件路径。')
    process.exitCode = 2
    return
  }
  log('浏览器: ' + browserPath)

  let bundleSize = 0
  try {
    bundleSize = await buildBundle()
  } catch (error) {
    log('环境不可用：面板浏览器包构建失败 —— ' + (error && error.message ? error.message : String(error)))
    process.exitCode = 2
    return
  }
  writeFileSync(PAGE_FILE, PAGE_SOURCE, 'utf8')
  log('构建: tsdown -> ' + BUNDLE_FILE + ' (' + bundleSize + ' bytes)')
  log('页面: ' + PAGE_FILE)

  const pageUrl = toFileUrl(PAGE_FILE)
  const results = []
  for (const viewport of VIEWPORTS) {
    log('')
    log('---- 视口 ' + viewport.name + ' ----')
    let result
    try {
      result = await measureViewport(browserPath, viewport, pageUrl)
    } catch (error) {
      log('实测失败: ' + (error && error.message ? error.message : String(error)))
      results.push({ viewport, pass: false, reasons: ['实测过程报错'], payload: null })
      continue
    }
    log('命令: ' + result.commandLine)
    log('CDP: Emulation.setDeviceMetricsOverride width=' + viewport.width + ' height=' + viewport.height + ' deviceScaleFactor=1')
    log('页面: ' + pageUrl)
    log('原始测量: ' + JSON.stringify(result.payload))
    if (result.consoleErrors.length > 0) log('页面控制台错误: ' + JSON.stringify(result.consoleErrors))
    const verdict = judge(viewport, result)
    for (const item of verdict.checks) log('  [' + (item.ok ? '通过' : '未通过') + '] ' + item.gate + ' —— ' + item.detail)
    log('判定: ' + (verdict.pass ? '通过' : '未通过') + (verdict.reasons.length > 0 ? ' —— ' + verdict.reasons.join('；') : ''))
    results.push({ viewport, pass: verdict.pass, reasons: verdict.reasons, payload: result.payload })
  }

  log('')
  const failed = results.filter((item) => !item.pass)
  if (failed.length === 0) {
    log('结论: 两个视口都通过（scrollWidth <= clientWidth，且视口尺寸与目标一致）')
    process.exitCode = 0
  } else {
    log('结论: 未通过 —— ' + failed.map((item) => item.viewport.name + ' ' + item.reasons.join('；')).join(' | '))
    process.exitCode = 1
  }
  if (!keep) {
    // 清理失败（例如 Chrome 仍占用工作目录）不该改判定结论：只提示，不动退出码。
    try {
      rmSync(WORK_DIR, { recursive: true, force: true })
    } catch (error) {
      log('清理工作目录失败（不影响判定）: ' + (error && error.message ? error.message : String(error)))
    }
  } else log('保留工作目录: ' + WORK_DIR)
}

await main()
