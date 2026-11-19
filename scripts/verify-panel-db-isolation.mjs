#!/usr/bin/env node
// Build the browser bundle, then run service and panel with different unprivileged Linux UIDs.
// node scripts/verify-panel-db-isolation.mjs build <public_bundle_path>
// node scripts/verify-panel-db-isolation.mjs service <linux_temp_dir> <public_bundle_path>
// node scripts/verify-panel-db-isolation.mjs panel <chromium_path> < ready.json
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { constants, closeSync, openSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { uuidv7 } from '../src/core/ids.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const READS = new Set([
  '/health', '/v1/events', '/v1/events/stream', '/v1/runs', '/v1/task-plans/by-task',
  '/v1/task-plans/capability', '/v1/tasks', '/v1/tasks/get', '/v1/workspace/overview',
])

async function waitFor(callback, description, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const value = await callback()
    if (value) return value
    await delay(40)
  }
  throw new Error('等待超时：' + description)
}

async function buildPanel(outFile) {
  const { build } = await import('tsdown')
  await build({
    cwd: ROOT, config: false, entry: ['tests/fixtures/panel-isolation-entry.tsx'],
    outDir: dirname(outFile), format: 'iife', platform: 'browser', target: 'es2020',
    dts: false, clean: false, sourcemap: false, silent: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    outputOptions: { entryFileNames: basename(outFile) },
  })
  assert.ok((await stat(outFile)).size > 0)
}

function authHeaders(secret) {
  return { 'x-orchestra-secret': secret, 'content-type': 'application/json' }
}

async function runService(dir, bundle) {
  const uid = process.getuid()
  assert.notEqual(uid, 0)
  assert.equal((await stat(dir)).uid, uid)
  const privateDir = join(dir, 'db')
  await mkdir(privateDir, { mode: 0o700 })
  const dbFile = join(privateDir, 'orchestra.db')
  const secret = randomBytes(32).toString('hex')
  const hostToken = randomBytes(32).toString('hex')
  const title = 'Q-22 ' + randomUUID()
  const { serveOrchestra } = await import('../lib/index.js')
  let service
  const unavailable = () => { throw new Error('Q-22 预期走生产 S5 API') }
  service = await serveOrchestra({
    dbFile, secret, phase: 'S5',
    asOfSeq: () => Number(service?.orchestra.db.raw.prepare('SELECT MAX(seq) AS seq FROM events').get().seq ?? 0),
    listTasks: unavailable, listEvents: unavailable, appendLedgerEvent: unavailable,
  })
  try {
    await runPanelGateway(dir, bundle, service, { dbFile, uid, secret, hostToken, title })
  } finally {
    await service.close()
  }
}

async function runPanelGateway(dir, bundle, service, { dbFile, uid, secret, hostToken, title }) {
  const db = service.orchestra.db.raw
  await chmod(dbFile, 0o600)
  const owner = await stat(dbFile)
  assert.equal(owner.uid, uid)
  assert.equal(owner.mode & 0o777, 0o600)
  const fixture = await fetch(new URL('/v1/tasks/reserve', service.endpoint), {
    method: 'POST', headers: authHeaders(secret),
    body: JSON.stringify({ title, operation_id: uuidv7() }),
  }).then((response) => response.json())
  assert.equal(fixture.ok, true, JSON.stringify(fixture.error))
  const taskId = fixture.data.task_id
  const archiveRow = () => db.prepare('SELECT archived_at FROM tasks WHERE task_id = ?').get(taskId).archived_at
  assert.equal(archiveRow(), null)
  const javascript = await readFile(bundle)
  const outcome = { archive: null, requests: [], panelConfirmed: false }

  const gateway = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.destroyed) return
      if (!res.headersSent) res.writeHead(500)
      res.end(error.message)
    })
  })
  async function handle(req, res) {
    const request = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && request.pathname === '/' && request.searchParams.get('session') === hostToken) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'set-cookie': 'panel_session=' + hostToken + '; HttpOnly; SameSite=Strict; Path=/',
      })
      res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/panel.js"></script>')
      return
    }
    if (req.headers.cookie !== 'panel_session=' + hostToken) { res.writeHead(403).end(); return }
    if (req.method === 'GET' && request.pathname === '/panel.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(javascript)
      return
    }
    if (req.method === 'POST' && request.pathname === '/q22-complete' && outcome.archive) {
      outcome.panelConfirmed = true
      res.writeHead(204).end()
      return
    }
    const archive = req.method === 'POST' && request.pathname === '/v1/tasks/archive'
    if (!archive && !(req.method === 'GET' && READS.has(request.pathname))) { res.writeHead(404).end(); return }
    let body
    let command
    if (archive) {
      const chunks = []
      let length = 0
      for await (const chunk of req) {
        length += chunk.length
        if (length > 4096) { res.writeHead(413).end(); return }
        chunks.push(chunk)
      }
      body = Buffer.concat(chunks).toString('utf8')
      command = JSON.parse(body)
      if (command.task_id !== taskId || command.archived !== true || command.expected_archived_at !== null) {
        res.writeHead(403).end()
        return
      }
    }
    const abort = new AbortController()
    res.once('close', () => abort.abort())
    const upstream = await fetch(new URL(request.pathname + request.search, service.endpoint), {
      method: req.method, headers: authHeaders(secret), body, signal: abort.signal,
    })
    outcome.requests.push({ method: req.method, path: request.pathname, status: upstream.status })
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    if (archive) {
      const response = await upstream.text()
      const envelope = JSON.parse(response)
      if (envelope.ok) outcome.archive = { operation_id: command.operation_id, ...envelope.data }
      res.end(response)
    } else if (upstream.body) {
      const source = Readable.fromWeb(upstream.body)
      source.on('error', () => res.destroy())
      source.pipe(res)
    } else {
      res.end()
    }
  }

  try {
    gateway.listen(0, '127.0.0.1')
    await once(gateway, 'listening')
    const origin = 'http://127.0.0.1:' + gateway.address().port
    const denied = await fetch(origin + '/v1/tasks')
    assert.equal(denied.status, 403)
    const ready = { origin, hostToken, title, taskId, uid, dbFile }
    await writeFile(join(dir, 'ready.json'), JSON.stringify(ready), { mode: 0o600, flag: 'wx' })
    const archive = await waitFor(() => outcome.archive, '面板归档 API 回执', 35_000)
    await waitFor(() => outcome.panelConfirmed, '面板显示归档成功', 5000)
    assert.equal(archive.task_id, taskId)
    assert.equal(archiveRow(), archive.archived_at)
    const receipts = db.prepare('SELECT kind, status, receipt_json FROM inbox WHERE operation_id = ?').all(archive.operation_id)
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].status, 'applied')
    assert.equal(receipts[0].kind, 'task.archive')
    assert.deepEqual(JSON.parse(receipts[0].receipt_json).result, { task_id: taskId, archived_at: archive.archived_at })
    const archiveEvents = db.prepare("SELECT seq FROM events WHERE type = 'task.archived' AND json_extract(payload_redacted, '$.task_id') = ?").all(taskId)
    assert.equal(archiveEvents.length, 1)
    assert.ok(outcome.requests.some((request) => request.method === 'GET' && request.path === '/v1/tasks' && request.status === 200))
    assert.ok(outcome.requests.some((request) => request.method === 'GET' && request.path === '/v1/tasks/get' && request.status === 200))
    console.log('Q-22 SERVICE ' + JSON.stringify({ uid, dbOwner: owner.uid, dbMode: '0600', unauthenticated: denied.status, taskId,
      operationId: archive.operation_id, archivedAt: archive.archived_at, eventSeq: archiveEvents[0].seq, requests: outcome.requests }))
  } finally {
    gateway.closeAllConnections()
    gateway.close()
  }
}

let nextDevtoolsId = 0
async function chromeCommand(socket, method, params) {
  const id = ++nextDevtoolsId
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', result)
      reject(new Error('浏览器未响应 ' + method))
    }, 5000)
    const result = (event) => {
      const response = JSON.parse(event.data)
      if (response.id !== id) return
      socket.removeEventListener('message', result)
      clearTimeout(timeout)
      if (response.error || response.result.exceptionDetails) reject(new Error(JSON.stringify(response)))
      else resolve(response.result)
    }
    socket.addEventListener('message', result)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function runPanel(browser) {
  const ready = JSON.parse(readFileSync(0, 'utf8'))
  const uid = process.getuid()
  assert.notEqual(uid, 0)
  assert.notEqual(uid, ready.uid)
  assert.throws(() => closeSync(openSync(ready.dbFile, constants.O_RDWR)), { code: 'EACCES' })
  const profile = await mkdtemp(join(tmpdir(), 'orchestra-q22-browser-'))
  const child = spawn(browser, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run',
    '--user-data-dir=' + profile, '--remote-debugging-port=0',
    'about:blank',
  ], { env: { ...process.env, XDG_CONFIG_HOME: profile }, stdio: ['ignore', 'ignore', 'pipe'] })
  const finished = once(child, 'exit')
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  let socket
  try {
    await once(child, 'spawn')
    const browserIds = /^Uid:[ \t]+(.+)$/m.exec(readFileSync('/proc/' + child.pid + '/status', 'utf8'))?.[1]
    assert.deepEqual(browserIds?.trim().split(/[ \t]+/).map(Number), [uid, uid, uid, uid])
    const cdpPort = await waitFor(() => {
      if (child.exitCode !== null) throw new Error('Chromium 提前退出：' + stderr)
      return /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)?.[1]
    }, 'Chromium DevTools')
    const page = await waitFor(async () => {
      const tab = await fetch('http://127.0.0.1:' + cdpPort + '/json/list').then((response) => response.json())
      return tab.find((target) => target.type === 'page' && target.url === 'about:blank')
    }, '浏览器打开面板')
    const version = await fetch('http://127.0.0.1:' + cdpPort + '/json/version').then((response) => response.json())
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await once(socket, 'open')
    const evaluate = async (expression) => (await chromeCommand(socket, 'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true })).result.value
    const navigation = await chromeCommand(socket, 'Page.navigate', { url: ready.origin + '/?session=' + ready.hostToken })
    assert.equal(navigation.errorText, undefined)
    const click = (label) => waitFor(() => evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(
        (element) => element.textContent.trim() === ${JSON.stringify(label)} && !element.disabled)
      if (!button) return false
      button.click()
      return true
    })()`), label).catch(async (error) => {
      const visible = await evaluate('document.body.innerText.slice(0, 1500)')
      throw new Error(error.message + '\n' + visible, { cause: error })
    })
    await click(ready.title)
    await click('归档任务')
    await click('确认归档')
    const notice = '已归档，运行记录仍可查看。'
    await waitFor(() => evaluate('document.body.innerText.includes(' + JSON.stringify(notice) + ')'), '真实面板显示归档成功')
    assert.equal(await evaluate("fetch('/q22-complete', { method: 'POST' }).then(response => response.status)"), 204)
    console.log('Q-22 PANEL ' + JSON.stringify({ uid, browserUid: uid, browser: version.Browser,
      node: process.versions.node, databaseOpen: 'EACCES', taskId: ready.taskId, title: ready.title, notice }))
  } finally {
    socket?.close()
    child.kill()
    await finished
    await rm(profile, { recursive: true, force: true })
  }
}

const [mode, first, second] = process.argv.slice(2)
if (mode === 'build' && first) await buildPanel(resolve(first))
else if (mode === 'service' && first && second) await runService(resolve(first), resolve(second))
else if (mode === 'panel' && first) await runPanel(resolve(first))
else throw new Error('用法见脚本开头。构建服务产物需先运行 pnpm build。')
