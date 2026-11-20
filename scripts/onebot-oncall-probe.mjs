// Exercise the installed QQ tool and the Orchestra receipt contract using an in-memory chat.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createIntakeControl } from '../src/service/trial-access.ts'
import { freshLedger } from '../tests/fixtures/ledger.ts'

const packageDir = resolve(process.argv[2] ?? '')
const metadata = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
assert.equal(metadata.name, 'dsh-onebot-qq')
const { registerTools } = await import(pathToFileURL(join(packageDir, 'lib/tools.js')).href)
let send
const registry = { register(tool) { if (tool.name === 'qq_send_text') send = tool; return () => {} } }
const calls = []
const bridge = {
  memberToolsAllowed: (id) => id === 'fixture-oncall',
  chatForSession: (id) => id === 'fixture-oncall' ? 'isolated-fixture' : undefined,
  async sendToChat(target, text) {
    assert.equal(target, 'isolated-fixture')
    calls.push(text)
    return ['12345']
  },
}
const dispose = registerTools({ tools: registry }, bridge, {}, {}, () => {})
const dir = mkdtempSync(join(tmpdir(), 'onebot-orchestra-'))
const { db } = freshLedger(dir)
try {
  assert.ok(send)
  const args = { text: '隔离演练：面板告警 demo-01' }
  await assert.rejects(send.execute(args, { agent: { session: { id: 'fixture-member' } } }))
  assert.equal(calls.length, 0)
  const sentAt = new Date().toISOString()
  const receipt = await send.execute(args, { agent: { session: { id: 'fixture-oncall' } } })
  assert.deepEqual(receipt, { sent: true, messageId: '12345' })
  assert.equal(calls.length, 1)
  const intake = createIntakeControl(db, {
    authenticate: proof => proof === 'fixture-operator' ? 'fixture:oncall' : null,
    lookupQqDelivery: (inbox, invocation) => inbox === 'demo-01' && invocation === 'isolated-invocation' ?
      { plugin: metadata.name, tool: send.name, sentAt, ...receipt } : null,
  })
  const paged = intake.recordQqDelivery('fixture-operator', 'demo-01', 'isolated-invocation', '隔离演练')
  assert.equal(paged.awaiting.channel, 'dsh-onebot-qq')
  assert.throws(() => intake.ack('fixture-member', paged.awaiting.id, '确认'))
  assert.equal(intake.ack('fixture-operator', paged.awaiting.id, '隔离人工会话确认').awaiting, null)
  console.log(JSON.stringify({ package: metadata.name, version: metadata.version, tool: send.name, transport: 'in-memory',
    externalMessages: 0, callbackCalls: calls.length, inboxMatched: true, senderPermissionChecked: true,
    transportReceiptRecorded: true, separateFixtureAck: true, liveDrill: false }, null, 2))
} finally { dispose(); db.raw.close(); rmSync(dir, { recursive: true, force: true }) }
