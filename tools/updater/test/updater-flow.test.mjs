import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectArchive, verifyInstalled } from '../inspect-package.mjs'
import { CLIENT_INJECT_PROTOCOLS, CLIENT_INJECT_ROLES } from '../package-contract.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const archive = process.env.ORCHESTRA_TEST_ARCHIVE ? resolve(process.env.ORCHESTRA_TEST_ARCHIVE) : null
const available = archive !== null && existsSync(archive)
if (process.env.ORCHESTRA_TEST_ARCHIVE && !available) throw new Error('ORCHESTRA_TEST_ARCHIVE does not exist')
const skip = available ? false : 'Set ORCHESTRA_TEST_ARCHIVE to a built dsh-orchestra .tgz to run the updater process tests'

const fakeHost = String.raw`
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,appendFileSync,rmSync,renameSync} from 'node:fs';
import {join,relative} from 'node:path';
const args=process.argv.slice(2);
if(args.length!==5 || args[0]!=='plugin' || args[1]!=='--profile' || args[2]!=='web' || args[3]!=='add') process.exit(29);
const profile=join(process.env.DSH_HOME,'profiles','web');
appendFileSync(join(process.env.DSH_HOME,'calls.jsonl'),JSON.stringify({args,home:process.env.DSH_HOME})+'\n');
if(process.env.ORCHESTRA_FAKE_INSTALL_FAILURE==='1') process.exit(19);
if(process.env.ORCHESTRA_FAKE_KEEP_OLD!=='1') {
 const stage=join(profile,'fake-unpack'); mkdirSync(stage);
 execFileSync('tar',['-xzf',args[4],'-C',stage],{env:{...process.env,TAR_OPTIONS:''}});
 mkdirSync(join(profile,'node_modules'),{recursive:true});
 rmSync(join(profile,'node_modules','dsh-orchestra'),{recursive:true,force:true});
 renameSync(join(stage,'package'),join(profile,'node_modules','dsh-orchestra')); rmSync(stage,{recursive:true});
}
const path=join(profile,'package.json'); const metadata=JSON.parse(readFileSync(path,'utf8'));
metadata.dependencies['dsh-orchestra']='file:'+relative(profile,args[4]).replaceAll('\\','/');
writeFileSync(path,JSON.stringify(metadata));
`

function fixture(t) {
  const parent = join(root, '.test-tmp')
  mkdirSync(parent, { recursive: true })
  const dir = mkdtempSync(join(parent, 'flow-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const home = join(dir, 'home with spaces & symbols')
  const profile = join(home, 'profiles', 'web')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'test-profile', dependencies: { 'dsh-orchestra': 'file:old.tgz', unrelated: '1.2.3' }, dsh: { profile: { bundles: ['base', 'dsh-orchestra', 'other'] } } }))
  writeFileSync(join(profile, 'pnpm-lock.yaml'), 'saved old lock\n')
  const unpack = join(dir, 'unpack'); mkdirSync(unpack)
  execFileSync('tar', ['-xzf', archive, '-C', unpack], { env: { ...process.env, TAR_OPTIONS: '' } })
  const installed = join(profile, 'node_modules', 'dsh-orchestra')
  return { dir, home, profile, unpack, installed }
}

// Keep fixture setup synchronous so every subprocess has a fully prepared profile.
function prepared(t) {
  const f = fixture(t)
  renameSync(join(f.unpack, 'package'), f.installed)
  const client = join(f.installed, 'lib', 'client.js')
  const old = readFileSync(client); old[old.length - 2] ^= 1; writeFileSync(client, old)
  const cli = join(f.dir, 'fake dsh.mjs'); writeFileSync(cli, fakeHost)
  const input = join(f.dir, 'input same beta.tgz'); copyFileSync(archive, input)
  const ledger = join(f.home, 'workspaces', 'user', 'ledger.sqlite'); mkdirSync(dirname(ledger), { recursive: true }); writeFileSync(ledger, 'existing user data must stay intact')
  return { ...f, cli, input, ledger, old }
}

function invoke(f, extraEnv = {}, source = null) {
  const args = [join(root, 'update-dsh-orchestra.mjs'), ...(source ? ['--repo', source] : ['--package', f.input]), '--profile', 'web', '--dsh', f.cli, '--dsh-home', f.home, '--json']
  const process = spawnSync(globalThis.process.execPath, args, { encoding: 'utf8', env: { ...globalThis.process.env, ...extraEnv }, timeout: 60_000 })
  assert.equal(process.error, undefined, process.error?.message)
  const result = JSON.parse(process.stdout.trim())
  return { process, result }
}

test('real updater subprocess replaces same-version bytes, preserves other choices and reuses persistent package', { skip }, t => {
  const f = prepared(t)
  const first = invoke(f)
  assert.equal(first.process.status, 0, first.process.stderr + first.process.stdout)
  assert.equal(first.result.status, 'installed-verified')
  assert.equal(first.result.updaterVersion, '1.1.1')
  assert.equal(first.result.candidatePackage, f.input)
  assert.equal(first.result.clientInjectProtocol, CLIENT_INJECT_ROLES.candidate)
  assert.equal(first.result.verifiedFiles, inspectArchive(f.input).files.length)
  assert.notEqual(first.result.package, f.input)
  assert.equal(existsSync(first.result.package), true)
  const receipt = JSON.parse(readFileSync(first.result.receipt, 'utf8'))
  assert.equal(receipt.updaterVersion, first.result.updaterVersion)
  assert.equal(receipt.candidatePackage, f.input)
  assert.equal(receipt.clientInjectProtocol, CLIENT_INJECT_ROLES.candidate)
  assert.equal(receipt.backup.previous.version, receipt.version)
  const backup = inspectArchive(receipt.backup.previous.archive)
  assert.notEqual(backup.sha256, receipt.sha256)
  verifyInstalled(f.profile, inspectArchive(f.input))
  const profile = JSON.parse(readFileSync(join(f.profile, 'package.json')))
  assert.deepEqual(profile.dsh.profile.bundles, ['base', 'dsh-orchestra', 'other'])
  assert.equal(profile.dependencies.unrelated, '1.2.3')
  assert.equal(readFileSync(f.ledger, 'utf8'), 'existing user data must stay intact')
  rmSync(f.input)
  f.input = first.result.package
  const second = invoke(f)
  assert.equal(second.process.status, 0)
  assert.equal(second.result.status, 'already-current')
  assert.equal(readFileSync(join(f.home, 'calls.jsonl'), 'utf8').trim().split('\n').length, 1)
  assert.equal(existsSync(join(f.home, 'orchestra-updater', 'web.update-lock')), false)
})

test('installer exit zero with unchanged old bytes is a verification failure, never success', { skip }, t => {
  const f = prepared(t)
  const { process, result } = invoke(f, { ORCHESTRA_FAKE_KEEP_OLD: '1' })
  assert.equal(process.status, 1)
  assert.equal(result.status, 'failed')
  assert.equal(result.stage, 'verify')
  assert.match(result.error, /mismatch|content|SHA|bytes/iu)
  assert.equal(existsSync(result.backupDirectory), true)
  assert.equal(readFileSync(f.ledger, 'utf8'), 'existing user data must stay intact')
  assert.equal(existsSync(join(f.home, 'orchestra-updater', 'web.update-lock')), false)
})

test('installer nonzero exit remains failed and releases the lock for a later retry', { skip }, t => {
  const f = prepared(t)
  const failed = invoke(f, { ORCHESTRA_FAKE_INSTALL_FAILURE: '1' })
  assert.equal(failed.process.status, 1)
  assert.equal(failed.result.stage, 'install')
  assert.equal(failed.result.restartRequired, undefined)
  assert.equal(existsSync(join(f.home, 'orchestra-updater', 'web.update-lock')), false)
  const retried = invoke(f)
  assert.equal(retried.process.status, 0, retried.process.stderr)
  assert.equal(retried.result.status, 'installed-verified')
})

test('source build failure never invokes DSH or changes installed bytes', { skip: skip || (process.platform === 'win32' ? 'This local executable fixture uses a POSIX shebang' : false) }, t => {
  const f = prepared(t)
  const source = join(f.dir, 'checkout'); mkdirSync(source)
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dsh-orchestra', version: '0.1.0-beta.1' }))
  writeFileSync(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  const bin = join(f.dir, 'bin'); mkdirSync(bin)
  const pnpm = join(bin, 'pnpm')
  writeFileSync(pnpm, '#!/usr/bin/env node\nprocess.exit(process.argv[2] === "build" ? 23 : 0)\n'); chmodSync(pnpm, 0o755)
  const { process, result } = invoke(f, { PATH: bin + ':' + globalThis.process.env.PATH }, source)
  assert.equal(process.status, 1)
  assert.equal(result.stage, 'build')
  assert.equal(existsSync(join(f.home, 'calls.jsonl')), false)
  assert.deepEqual(readFileSync(join(f.installed, 'lib', 'client.js')), f.old)
  assert.equal(existsSync(join(result.operationDir, 'temporary')), false)
})

test('source mode runs locked install, typecheck, build and pack before installing the produced archive', { skip: skip || (process.platform === 'win32' ? 'This local executable fixture uses a POSIX shebang' : false) }, t => {
  const f = prepared(t)
  const source = join(f.dir, 'checkout'); mkdirSync(source)
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dsh-orchestra', version: '0.1.0-beta.1' }))
  writeFileSync(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  const bin = join(f.dir, 'bin'); mkdirSync(bin)
  const pnpm = join(bin, 'pnpm')
  writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(pnpm, `#!/usr/bin/env node
const fs=require('node:fs'); const path=require('node:path');
const args=process.argv.slice(2);
fs.appendFileSync(path.join(process.cwd(),'build-calls.jsonl'),JSON.stringify(args)+'\\n');
if(args[0]==='pack') fs.copyFileSync(process.env.ORCHESTRA_FIXTURE_ARCHIVE,path.join(args[2],'candidate.tgz'));
`)
  chmodSync(pnpm, 0o755)
  const { process, result } = invoke(f, { PATH: bin + ':' + globalThis.process.env.PATH, ORCHESTRA_FIXTURE_ARCHIVE: archive }, source)
  assert.equal(process.status, 0, process.stderr + process.stdout)
  assert.equal(result.status, 'installed-verified')
  assert.equal(result.updaterVersion, '1.1.1')
  assert.equal(result.clientInjectProtocol, CLIENT_INJECT_ROLES.candidate)
  assert.equal(result.candidatePackage, join(result.operationDir, 'packed', 'candidate.tgz'))
  const calls = readFileSync(join(source, 'build-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls.slice(0, 3), [['install', '--frozen-lockfile'], ['typecheck'], ['build']])
  assert.equal(calls[3][0], 'pack')
  verifyInstalled(f.profile, inspectArchive(result.package))
  assert.equal(existsSync(join(result.operationDir, 'temporary')), false)
})

test('source inspection failure records the rejected candidate and never invokes the installer', {
  skip: skip || (process.platform === 'win32' ? 'This local executable fixture uses a POSIX shebang' : false),
}, t => {
  const f = prepared(t)
  const beforeProfile = readFileSync(join(f.profile, 'package.json'))
  const stage = join(f.dir, 'invalid-package'); mkdirSync(stage)
  execFileSync('tar', ['-xzf', archive, '-C', stage], { env: { ...globalThis.process.env, TAR_OPTIONS: '' } })
  const manifestPath = join(stage, 'package', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  // This is also exactly the legacy nine-entry set: never infer a legacy role.
  manifest.dsh.client.inject = [...CLIENT_INJECT_PROTOCOLS['dsh-orchestra/client-inject/conversation/v1']]
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const badArchive = join(f.dir, 'missing-workbench-clients.tgz')
  const entries = inspectArchive(archive).files.map(file => 'package/' + file.path)
  execFileSync('tar', ['-czf', badArchive, '-C', stage, ...entries], { env: { ...globalThis.process.env, TAR_OPTIONS: '' } })
  const source = join(f.dir, 'checkout'); mkdirSync(source)
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dsh-orchestra', version: manifest.version }))
  writeFileSync(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  const bin = join(f.dir, 'bin'); mkdirSync(bin)
  const pnpm = join(bin, 'pnpm')
  writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(pnpm, `#!/usr/bin/env node
const fs=require('node:fs'); const path=require('node:path');
const args=process.argv.slice(2);
if(args[0]==='pack') fs.copyFileSync(process.env.ORCHESTRA_FIXTURE_ARCHIVE,path.join(args[2],'candidate.tgz'));
`)
  chmodSync(pnpm, 0o755)
  const { process, result } = invoke(f, { PATH: bin + ':' + globalThis.process.env.PATH, ORCHESTRA_FIXTURE_ARCHIVE: badArchive }, source)
  assert.equal(process.status, 1, process.stderr + process.stdout)
  assert.equal(result.status, 'failed')
  assert.equal(result.stage, 'inspect')
  assert.equal(result.updaterVersion, '1.1.1')
  assert.equal(result.candidatePackage, join(result.operationDir, 'packed', 'candidate.tgz'))
  assert.equal(existsSync(result.candidatePackage), true)
  assert.equal(result.clientInjectProtocol, null)
  assert.match(result.error, /workbench\/v1.*Manifest matches.*conversation\/v1.*rebuild from current main/)
  assert.equal(result.backupDirectory, undefined)
  assert.equal(existsSync(join(f.home, 'calls.jsonl')), false)
  assert.deepEqual(readFileSync(join(f.profile, 'package.json')), beforeProfile)
  assert.deepEqual(readFileSync(join(f.installed, 'lib', 'client.js')), f.old)
  assert.equal(readFileSync(f.ledger, 'utf8'), 'existing user data must stay intact')
  const receipt = JSON.parse(readFileSync(result.receipt, 'utf8'))
  assert.equal(receipt.updaterVersion, result.updaterVersion)
  assert.equal(receipt.candidatePackage, result.candidatePackage)
  assert.equal(receipt.stage, 'inspect')
  assert.equal(receipt.backup, undefined)
  assert.equal(existsSync(join(f.home, 'orchestra-updater', 'web.update-lock')), false)
})
