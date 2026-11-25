import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandSpec, parseArgs, update } from '../update-dsh-orchestra.mjs';
import { inspectArchive } from '../inspect-package.mjs';
import { CLIENT_INJECT_ROLES } from '../package-contract.mjs';

const updaterRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryParent = join(updaterRoot, '.test-tmp');
const candidate = process.env.ORCHESTRA_TEST_ARCHIVE ? resolve(process.env.ORCHESTRA_TEST_ARCHIVE) : null;
if (candidate && !existsSync(candidate)) throw new Error('ORCHESTRA_TEST_ARCHIVE does not exist');
const skip = candidate ? false : 'Set ORCHESTRA_TEST_ARCHIVE to a built dsh-orchestra .tgz to run real-package contract tests';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  mkdirSync(temporaryParent, { recursive: true });
  const root = mkdtempSync(join(temporaryParent, 'updater-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home with spaces');
  const profile = join(home, 'profiles', 'desktop');
  const dsh = join(root, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  mkdirSync(profile, { recursive: true });
  mkdirSync(dirname(dsh), { recursive: true });
  // This fixture is only read as a supported-carrier marker. It is never executed.
  writeFileSync(dsh, '@echo off\nset "ELECTRON_RUN_AS_NODE=1"\nrem dsh-desktop-host\n');
  const manifest = {
    name: 'dsh-profile-desktop', private: true,
    dependencies: { 'dsh-orchestra': 'file:previous.tgz' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-orchestra'] } },
  };
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  const options = parseArgs(['--package', candidate ?? join(root, 'unprovided.tgz'), '--dsh', dsh, '--dsh-home', home, '--json']);
  return { root, home, profile, dsh, manifest, options };
}

function seedPackage(target) {
  const staging = join(dirname(target), 'unpack');
  mkdirSync(staging, { recursive: true });
  execFileSync('tar', ['-xzf', candidate, '-C', staging], { env: { ...process.env, TAR_OPTIONS: '' } });
  mkdirSync(dirname(target), { recursive: true });
  renameSync(join(staging, 'package'), target);
  rmSync(staging, { recursive: true });
}

test('Desktop package plan does not create updater state or invoke the installer', { skip }, async t => {
  const f = fixture(t);
  const original = readFileSync(join(f.profile, 'package.json'));
  let called = false;
  const result = await update({ ...f.options, plan: true }, {
    runCommand: async () => { called = true; throw new Error('must not execute'); },
  });
  assert.equal(result.status, 'plan');
  assert.equal(result.dshHome, f.home);
  assert.equal(result.dshCommand, f.dsh);
  assert.equal(result.updaterVersion, '1.1.0');
  assert.equal(result.clientInjectProtocol, CLIENT_INJECT_ROLES.candidate);
  assert.equal(called, false);
  assert.equal(existsSync(join(f.home, 'orchestra-updater')), false);
  assert.deepEqual(readFileSync(join(f.profile, 'package.json')), original);
});

test('Desktop refuses a global-style dsh launcher before any update writes', async t => {
  const f = fixture(t);
  const globalDsh = join(f.root, 'global', 'dsh.cmd');
  mkdirSync(dirname(globalDsh));
  writeFileSync(globalDsh, '@echo off\nnode dsh.js %*\n');
  await assert.rejects(update({ ...f.options, dsh: globalDsh }, {
    runCommand: async () => { throw new Error('must not execute'); },
  }), /Desktop requires its installed/);
  assert.equal(existsSync(join(f.home, 'orchestra-updater')), false);
});

test('failed package installation retains a verified recovery package and persistent candidate', { skip }, async t => {
  const f = fixture(t);
  const installed = join(f.profile, 'node_modules', 'dsh-orchestra');
  seedPackage(installed);
  const client = join(installed, 'lib', 'client.js');
  const oldClient = Buffer.concat([readFileSync(client), Buffer.from('\n// previous local build\n')]);
  writeFileSync(client, oldClient);
  const originalProfile = readFileSync(join(f.profile, 'package.json'));
  let seen;
  const result = await update(f.options, {
    runCommand: async (file, args, context) => {
      seen = { file, args, home: context.env.DSH_HOME };
      // A failed pnpm operation can have changed files; recovery must not be claimed.
      writeFileSync(client, 'partial failed install');
      throw new Error('simulated package-manager failure');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'install');
  assert.equal(result.updaterVersion, '1.1.0');
  assert.equal(result.candidatePackage, candidate);
  assert.equal(result.clientInjectProtocol, CLIENT_INJECT_ROLES.candidate);
  assert.match(result.error, /simulated package-manager failure/);
  assert.equal(result.restartRequired, undefined);
  assert.equal(seen.file, f.dsh);
  assert.deepEqual(seen.args.slice(0, 4), ['plugin', '--profile', 'desktop', 'add']);
  assert.equal(seen.home, f.home);
  assert.equal(seen.args[4], result.package);
  assert.match(result.package, /orchestra-updater[/\\]packages[/\\][a-f0-9]{64}[/\\]dsh-orchestra\.tgz$/);
  assert.equal(hash(readFileSync(result.package)), result.sha256);
  assert.deepEqual(readFileSync(join(result.backup.directory, 'package.json')), originalProfile);
  const previous = inspectArchive(result.backup.previous.archive, {
    expectedSha256: result.backup.previous.sha256,
  });
  assert.equal(previous.files.find(file => file.path === 'lib/client.js').sha256, hash(oldClient));
  const recovery = JSON.parse(readFileSync(join(result.operationDir, 'recovery.json')));
  assert.equal(recovery.command, f.dsh);
  assert.deepEqual(recovery.args.slice(0, 4), ['plugin', '--profile', 'desktop', 'add']);
  assert.equal(recovery.args[4], result.backup.previous.archive);
  assert.match(recovery.condition, /operator-directed/);
  assert.equal(readFileSync(client, 'utf8'), 'partial failed install');
  assert.equal(existsSync(join(f.home, 'orchestra-updater', 'desktop.update-lock')), false);
  assert.equal(JSON.parse(readFileSync(result.receipt)).status, 'failed');
});

test('verified repeated package invocation skips install and keeps its persistent source', { skip }, async t => {
  const f = fixture(t);
  seedPackage(join(f.profile, 'node_modules', 'dsh-orchestra'));
  const digest = hash(readFileSync(candidate));
  const permanent = join(f.home, 'orchestra-updater', 'packages', digest, 'dsh-orchestra.tgz');
  mkdirSync(dirname(permanent), { recursive: true });
  copyFileSync(candidate, permanent);
  f.manifest.dependencies['dsh-orchestra'] = 'file:' + permanent;
  writeFileSync(join(f.profile, 'package.json'), JSON.stringify(f.manifest));
  let called = false;
  const result = await update(f.options, {
    runCommand: async () => { called = true; throw new Error('must not execute'); },
  });
  assert.equal(result.status, 'already-current');
  assert.equal(result.ok, true);
  assert.equal(result.restartRequired, false);
  assert.equal(result.updaterVersion, '1.1.0');
  assert.equal(result.candidatePackage, candidate);
  assert.equal(result.clientInjectProtocol, CLIENT_INJECT_ROLES.candidate);
  assert.equal(result.backup, undefined);
  assert.equal(called, false);
  assert.equal(result.package, permanent);
  assert.equal(hash(readFileSync(permanent)), digest);
});

test('batch launcher arguments cannot contain cmd variable expansion or quote delimiters', () => {
  const launcher = 'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd';
  for (const path of ['C:\\%TEMP%\\plugin.tgz', 'C:\\!NAME!\\plugin.tgz', 'C:\\with"quote\\plugin.tgz']) {
    assert.throws(() => commandSpec(launcher, ['plugin', '--profile', 'desktop', 'add', path], 'win32'), /cannot contain/);
  }
  const spec = commandSpec(launcher, ['plugin', '--profile', 'desktop', 'add', 'C:\\Builds & Tests (current)\\plugin.tgz'], 'win32');
  assert.equal(spec.windowsVerbatimArguments, true);
  assert.deepEqual(spec.args.slice(0, 4), ['/d', '/v:off', '/s', '/c']);
  assert.ok(spec.args[4].startsWith('""' + launcher + '" '));
  assert.ok(spec.args[4].endsWith('"C:\\Builds & Tests (current)\\plugin.tgz""'));
});
