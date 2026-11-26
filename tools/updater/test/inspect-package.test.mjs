import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { inspectArchive, verifyInstalled } from '../inspect-package.mjs';
import { CLIENT_INJECT_PROTOCOLS, CLIENT_INJECT_ROLES } from '../package-contract.mjs';

const updaterDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Keep all fixtures in this workspace; never depend on or write to shared /tmp.
const temporaryParent = join(updaterDir, '.test-tmp');
mkdirSync(temporaryParent, { recursive: true });
const temporaryRoot = mkdtempSync(join(temporaryParent, 'inspect-package-'));
after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
let sequence = 0;

function manifest() {
  return {
    name: 'dsh-orchestra', version: '0.1.0-beta.1', private: true, type: 'module',
    main: 'lib/index.js', types: 'lib/index.d.ts',
    exports: { '.': { default: './lib/index.js' }, './client': './lib/client.js' },
    dsh: {
      bundle: { patch: './cordis.patch.yml' }, manifestVersion: 1,
      client: { platform: 'web', inject: [...CLIENT_INJECT_PROTOCOLS[CLIENT_INJECT_ROLES.candidate]] },
    },
  };
}

function fixtureEntries(overrides = {}) {
  const contents = {
    'package.json': JSON.stringify({ ...manifest(), ...overrides }),
    'lib/index.js': 'export function serveDshOrchestra() {}\n',
    'lib/index.d.ts': 'export declare function serveDshOrchestra(): void;\n',
    'lib/client.js': 'window.__ModuleLoader__.load;\n',
    'orchestra.config.json': JSON.stringify({ phase: 'S2' }),
    'cordis.patch.yml': '[{}]\n', 'README.md': '# Installation\n',
  };
  for (let version = 1; version <= 57; version++) {
    contents['lib/infra/sqlite/migrations/' + String(version).padStart(3, '0') + '_fixture.sql'] = '-- migration ' + version + '\n';
  }
  return Object.entries(contents).map(([path, content]) => ({ name: 'package/' + path, content: Buffer.from(content), type: '0' }));
}

// A tiny USTAR writer lets tests create duplicate, traversing and non-file
// entries directly, without extracting them or invoking a shell.
function makeTar(entries) {
  const blocks = [];
  for (const { name, content = Buffer.alloc(0), type = '0', link = '' } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100, 8);
    header.write('0000000\0', 108, 8);
    header.write('0000000\0', 116, 8);
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header.write('00000000000\0', 136, 12);
    header.fill(32, 148, 156);
    header.write(type, 156, 1);
    header.write(link, 157, 100);
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    const sum = header.reduce((value, byte) => value + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function writeArchive(entries = fixtureEntries()) {
  const path = join(temporaryRoot, 'fixture-' + sequence++ + '.tgz');
  writeFileSync(path, gzipSync(makeTar(entries)));
  return path;
}

function materialize(entries = fixtureEntries(), { linkedRoot = false } = {}) {
  const profile = join(temporaryRoot, 'profile-' + sequence++);
  const packageRoot = join(profile, 'node_modules', 'dsh-orchestra');
  const actualRoot = linkedRoot
    ? join(profile, 'node_modules', '.pnpm', 'dsh-orchestra@0.1.0-beta.1', 'node_modules', 'dsh-orchestra')
    : packageRoot;
  for (const { name, content } of entries) {
    const path = join(actualRoot, ...name.slice('package/'.length).split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  if (linkedRoot) symlinkSync(actualRoot, packageRoot, process.platform === 'win32' ? 'junction' : 'dir');
  return { profile, packageRoot, actualRoot };
}

const realArchive = process.env.ORCHESTRA_TEST_ARCHIVE
  ? resolve(process.env.ORCHESTRA_TEST_ARCHIVE)
  : null;
if (realArchive && !existsSync(realArchive)) throw new Error('ORCHESTRA_TEST_ARCHIVE does not exist');
test('actual plugin archive passes with its archive and file hashes', {
  skip: !realArchive
    ? 'Set ORCHESTRA_TEST_ARCHIVE to run the real-package integration check' : false,
}, () => {
  const expectedSha256 = createHash('sha256').update(readFileSync(realArchive)).digest('hex');
  const inspected = inspectArchive(realArchive, { expectedSha256 });
  assert.equal(inspected.sha256, expectedSha256);
  assert.equal(inspected.manifest.name, 'dsh-orchestra');
  assert.equal(inspected.clientInjectProtocol, CLIENT_INJECT_ROLES.candidate);
  assert.equal(inspected.migrations.at(-1).version, inspected.migrations.length);
  assert.ok(inspected.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && !file.path.startsWith('package/')));
});

test('standalone inspection uses the shared current protocol with order-independent matching', () => {
  const current = manifest();
  current.dsh.client.inject.reverse();
  assert.equal(inspectArchive(writeArchive(fixtureEntries(current))).clientInjectProtocol, CLIENT_INJECT_ROLES.candidate);
});

test('accepts the packaged README diagrams and verifies their installed bytes', () => {
  const path = 'docs/assets/readme/task-view-zh.svg';
  const entries = [...fixtureEntries(), { name: 'package/' + path, content: Buffer.from('<svg/>'), type: '0' }];
  const inspection = inspectArchive(writeArchive(entries));
  const installed = materialize(entries);
  assert.equal(verifyInstalled(installed.profile, inspection).fileCount, entries.length);
  writeFileSync(join(installed.actualRoot, path), '<SVG/>');
  assert.throws(() => verifyInstalled(installed.profile, inspection), /Installed file SHA256 mismatch: docs\/assets\/readme\/task-view-zh\.svg/);
});

test('standalone inspection rejects every missing current dependency, including all three workbench additions together', () => {
  const current = manifest();
  const inject = current.dsh.client.inject;
  for (const dependency of inject) {
    current.dsh.client.inject = inject.filter((item) => item !== dependency);
    assert.throws(() => inspectArchive(writeArchive(fixtureEntries(current))),
      (error) => error.message.includes('Missing entries: ' + dependency));
  }
  for (const protocol of ['dsh-orchestra/client-inject/slash/v1', 'dsh-orchestra/client-inject/conversation/v1']) {
    current.dsh.client.inject = [...CLIENT_INJECT_PROTOCOLS[protocol]];
    assert.throws(() => inspectArchive(writeArchive(fixtureEntries(current))), (error) =>
      error.message.includes('Manifest matches "' + protocol + '"')
      && error.message.includes('rebuild from current main'));
  }
});

test('standalone inspection rejects duplicate, unknown and non-string dependencies', () => {
  const current = manifest();
  const inject = current.dsh.client.inject;
  for (const [value, error] of [
    [[...inject, inject[0]], /Duplicate entries/],
    [[...inject.slice(0, -1), '@deepseek-ai/dsh-client-ui-unknown'], /Unknown entries/],
    [[...inject.slice(0, -1), null], /Non-string entries/],
    [null, /client.inject must be an array of strings/],
  ]) {
    current.dsh.client.inject = value;
    assert.throws(() => inspectArchive(writeArchive(fixtureEntries(current))), error);
  }
});

test('rejects an incorrect expected digest before interpreting the archive', () => {
  assert.throws(() => inspectArchive(writeArchive(), { expectedSha256: '0'.repeat(64) }), /Archive SHA256 mismatch/);
  assert.throws(() => inspectArchive(writeArchive(), { expectedSha256: 'not a hash' }), /64 hexadecimal/);
});

test('rejects a different package identity', () => {
  assert.throws(() => inspectArchive(writeArchive(fixtureEntries({ name: 'not-dsh-orchestra' }))), /Package manifest/);
});

for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
  test('rejects the ' + script + ' lifecycle script without executing it', () => {
    const entries = fixtureEntries({ scripts: { [script]: 'throw if anyone executes this' } });
    assert.throws(() => inspectArchive(writeArchive(entries)), new RegExp('lifecycle script is forbidden: ' + script));
  });
}

test('rejects duplicate, undeclared, traversing, and whitespace-suffixed paths', () => {
  for (const name of [
    'package/package.json', 'package/extra.js', 'package/../outside', 'package/README.md ',
    'package/node_modules/zod/package.json', 'package/docs/assets/readme/unknown.svg',
  ]) {
    assert.throws(() => inspectArchive(writeArchive([
      ...fixtureEntries(), { name, content: Buffer.from('bad'), type: '0' },
    ])), /duplicate or undeclared paths/);
  }
});

test('rejects symlink and hardlink archive entries', () => {
  for (const type of ['1', '2']) {
    const entries = fixtureEntries().map((entry) => entry.name === 'package/lib/index.js'
      ? { ...entry, type, content: Buffer.alloc(0), link: 'package/lib/client.js' } : entry);
    assert.throws(() => inspectArchive(writeArchive(entries)), /ordinary files only/);
  }
});

test('rejects a missing migration and a repeated migration number', () => {
  const entries = fixtureEntries();
  assert.throws(() => inspectArchive(writeArchive(entries.filter((entry) => !entry.name.includes('/025_')))), /migrations/);
  assert.throws(() => inspectArchive(writeArchive([
    ...entries, { name: 'package/lib/infra/sqlite/migrations/057_second.sql', content: Buffer.from('-- duplicate\n') },
  ])), /migrations/);
});

test('rejects incomplete bundle entries and a non-sequence DSH patch', () => {
  for (const [path, content, expected] of [
    ['lib/client.js', 'export const incomplete = true;', /Packaged entries are incomplete/],
    ['cordis.patch.yml', 'plugins: {}', /top-level sequence/],
  ]) {
    const entries = fixtureEntries().map((entry) => entry.name === 'package/' + path
      ? { ...entry, content: Buffer.from(content) } : entry);
    assert.throws(() => inspectArchive(writeArchive(entries)), expected);
  }
});

test('enforces the 64 MiB expanded archive bound', () => {
  const path = join(temporaryRoot, 'oversized.tgz');
  writeFileSync(path, gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1)));
  assert.throws(() => inspectArchive(path), /64 MiB inspection limit/);
});

test('does not inherit TAR_OPTIONS from the invoking environment', () => {
  const previous = process.env.TAR_OPTIONS;
  process.env.TAR_OPTIONS = '--this-option-does-not-exist';
  try {
    assert.equal(inspectArchive(writeArchive()).version, '0.1.0-beta.1');
  } finally {
    if (previous === undefined) delete process.env.TAR_OPTIONS;
    else process.env.TAR_OPTIONS = previous;
  }
});

test('verifies every installed file with a pnpm-style root symlink', () => {
  const entries = fixtureEntries();
  const inspected = inspectArchive(writeArchive(entries));
  const installed = materialize(entries, { linkedRoot: true });
  const verified = verifyInstalled(installed.profile, inspected);
  assert.equal(verified.fileCount, entries.length);
  assert.equal(verified.realPackageRoot, installed.actualRoot);
  assert.equal(verified.version, inspected.version);
});

for (const linkedDependencies of [false, true]) {
  test('accepts hoisted nested dependencies in a package-root ' + (linkedDependencies ? 'node_modules link' : 'node_modules directory'), () => {
    const entries = fixtureEntries({ dependencies: { zod: '4.4.3' } });
    const inspected = inspectArchive(writeArchive(entries));
    const installed = materialize(entries);
    const topLevelDependency = join(installed.profile, 'node_modules', 'zod');
    mkdirSync(topLevelDependency, { recursive: true });
    writeFileSync(join(topLevelDependency, 'package.json'), JSON.stringify({ name: 'zod', version: '4.4.2' }));
    const dependencyRoot = linkedDependencies
      ? join(installed.profile, 'dependency-store') : join(installed.actualRoot, 'node_modules');
    mkdirSync(join(dependencyRoot, 'zod'), { recursive: true });
    writeFileSync(join(dependencyRoot, 'zod/package.json'), JSON.stringify({ name: 'zod', version: '4.4.3' }));
    writeFileSync(join(dependencyRoot, 'zod/index.js'), 'export const dependencyContent = true;');
    if (linkedDependencies) {
      symlinkSync(dependencyRoot, join(installed.actualRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const verified = verifyInstalled(installed.profile, inspected);
    assert.equal(verified.fileCount, entries.length);
    assert.equal(verified.bytes, inspected.files.reduce((bytes, file) => bytes + file.bytes, 0));
  });
}

test('limits the dependency exception to a directory at the package root', () => {
  const inspected = inspectArchive(writeArchive());
  const nested = materialize();
  mkdirSync(join(nested.actualRoot, 'lib/node_modules'));
  assert.throws(() => verifyInstalled(nested.profile, inspected), /undeclared directory: lib\/node_modules/);
  const regularFile = materialize();
  writeFileSync(join(regularFile.actualRoot, 'node_modules'), 'not a dependency directory');
  assert.throws(() => verifyInstalled(regularFile.profile, inspected), /root node_modules must be a directory/);
});

test('detects same-version and same-length installed content changes', () => {
  const entries = fixtureEntries();
  const inspected = inspectArchive(writeArchive(entries));
  const installed = materialize(entries);
  const client = join(installed.actualRoot, 'lib/client.js');
  const original = readFileSync(client);
  const changed = Buffer.from(original);
  changed[0] ^= 1;
  writeFileSync(client, changed);
  assert.equal(JSON.parse(readFileSync(join(installed.actualRoot, 'package.json'), 'utf8')).version, inspected.version);
  assert.equal(changed.length, original.length);
  assert.throws(() => verifyInstalled(installed.profile, inspected), /Installed file SHA256 mismatch: lib\/client\.js/);
});

test('rejects installed extra and missing files', () => {
  const inspected = inspectArchive(writeArchive());
  const extra = materialize();
  writeFileSync(join(extra.actualRoot, 'extra.js'), 'unexpected');
  assert.throws(() => verifyInstalled(extra.profile, inspected), /undeclared file: extra\.js/);
  const missing = materialize();
  rmSync(join(missing.actualRoot, 'lib/client.js'));
  assert.throws(() => verifyInstalled(missing.profile, inspected), /missing a file: lib\/client\.js/);
});

test('rejects symlinked directories inside an installed package', () => {
  const inspected = inspectArchive(writeArchive());
  const installed = materialize();
  const movedLibrary = join(installed.profile, 'external-lib');
  renameSync(join(installed.actualRoot, 'lib'), movedLibrary);
  symlinkSync(movedLibrary, join(installed.actualRoot, 'lib'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyInstalled(installed.profile, inspected), /internal symlink: lib/);
});

test('does not trust traversal paths supplied in a forged inspection object', () => {
  const inspected = inspectArchive(writeArchive());
  const installed = materialize();
  inspected.files.push({ path: '../outside', bytes: 0, sha256: '0'.repeat(64) });
  assert.throws(() => verifyInstalled(installed.profile, inspected), /duplicate or undeclared paths/);
});
