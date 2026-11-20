import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootBuild, completeRun, ensureRehearsalWorkflow, startRun, verifyRuntime } from '../../scripts/upgrade-host.ts'

const [installed, root, secret] = process.argv.slice(2)
if (!installed || !root || !secret || !process.send) throw new Error('Expected isolated test package host')
const module = await import(pathToFileURL(join(installed, 'lib/index.js')).href) as typeof import('../../src/index.ts')
const service = await bootBuild(module, join(root, 'isolated.db'), secret, 'S6')
try {
  await ensureRehearsalWorkflow(service, secret, 'isolated-package-test')
  const run = await startRun(service, secret, 'isolated-package-test', 'source')
  await completeRun(service, secret, run)
  module.registerRunArtifact(service.orchestra.db, { artifactId: 'fixture', runId: run,
    fileName: 'managed.txt', bytes: Buffer.from('installed package artifact') })
  const { state } = await verifyRuntime(service, secret, 'S6')
  process.send({ endpoint: service.endpoint, run_id: run, migrations: state.migrations.length })
  await new Promise<void>((resolve) => {
    process.once('disconnect', resolve)
    process.once('message', resolve)
  })
} finally { await service.close() }
