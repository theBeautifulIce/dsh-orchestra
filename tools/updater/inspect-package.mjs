import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, openSync,
  readdirSync, readSync, realpathSync, statSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assertClientInject, PACKAGE_GUIDES, PUBLIC_PACKAGE_FILES } from './package-contract.mjs';

const UNPACK_LIMIT = 64 * 1024 * 1024;
// Bound the input too, while leaving room for gzip framing on an incompressible tar.
const ARCHIVE_LIMIT = UNPACK_LIMIT + 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/i;
const BASE_FILES = new Set([
  'package.json', 'lib/index.js', 'lib/index.d.ts', 'lib/client.js',
  'cordis.patch.yml', 'orchestra.config.json',
]);
const PUBLIC_FILES = new Set(PUBLIC_PACKAGE_FILES);
const MIGRATION_PATH = /^lib\/infra\/sqlite\/migrations\/(\d{3})_[a-z0-9_]+\.sql$/;
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function allowedPath(path) {
  return typeof path === 'string'
    && (BASE_FILES.has(path) || PUBLIC_FILES.has(path) || MIGRATION_PATH.test(path));
}

function checkFilePaths(paths) {
  if (!paths.length || new Set(paths).size !== paths.length || paths.some((path) => !allowedPath(path))) {
    throw new Error('Package has duplicate or undeclared paths');
  }
  for (const required of [...BASE_FILES, 'README.md']) {
    if (!paths.includes(required)) throw new Error('Missing package file: ' + required);
  }
  const migrations = paths.filter((path) => MIGRATION_PATH.test(path)).sort().map((path) => ({
    path, version: Number(MIGRATION_PATH.exec(path)[1]),
  }));
  if (migrations.length < 57 || migrations.some(({ version }, index) => version !== index + 1)) {
    throw new Error('Packaged SQLite migrations are incomplete or not consecutive');
  }
  return migrations;
}

function readArchive(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Archive must be a regular file');
    if (stat.size > ARCHIVE_LIMIT) throw new Error('Archive exceeds the bounded inspection input limit');
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const length = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!length) throw new Error('Archive changed while reading');
      offset += length;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) || statIdentity(fstatSync(fd)) !== statIdentity(stat)) {
      throw new Error('Archive changed while reading');
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function runTar(tarBytes, args, purpose) {
  // TAR_OPTIONS can otherwise add commands/options despite execFileSync using no shell.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.toUpperCase() !== 'TAR_OPTIONS'));
  env.LC_ALL = 'C';
  try {
    return execFileSync('tar', args, {
      input: tarBytes, shell: false, windowsHide: true, env,
      maxBuffer: UNPACK_LIMIT, timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('System tar was not found; it is required to inspect the package');
    throw new Error('Cannot ' + purpose + ' with system tar: ' + String(error.message).slice(0, 2000), { cause: error });
  }
}

function lines(bytes) {
  // Do not trim paths: whitespace is part of an archive entry's name.
  const output = bytes.toString('utf8');
  if (!output) return [];
  return output.replace(/\r?\n$/, '').split(/\r?\n/);
}

function parseJson(bytes, path) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('Invalid JSON in ' + path, { cause: error });
  }
}

function checkManifest(manifest, phase) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.name !== 'dsh-orchestra' || manifest.private !== true || manifest.type !== 'module'
    || manifest.main !== 'lib/index.js' || manifest.types !== 'lib/index.d.ts'
    || manifest.exports?.['.']?.default !== './lib/index.js' || manifest.exports?.['./client'] !== './lib/client.js'
    || manifest.dsh?.bundle?.patch !== './cordis.patch.yml' || manifest.dsh?.manifestVersion !== 1
    || manifest.dsh?.client?.platform !== 'web' || phase !== 'S2'
    || typeof manifest.version !== 'string' || !manifest.version.length || /[\s\x00-\x1f]/.test(manifest.version)) {
    throw new Error('Package manifest, advertised DSH client or default phase has changed');
  }
  const clientInjectProtocol = assertClientInject(manifest.dsh.client.inject, 'candidate');
  if (manifest.scripts !== undefined) {
    if (!manifest.scripts || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts)) {
      throw new Error('Package scripts must be an object');
    }
    for (const script of LIFECYCLE_SCRIPTS) {
      if (Object.hasOwn(manifest.scripts, script)) {
        throw new Error('Package lifecycle script is forbidden: ' + script);
      }
    }
  }
  return clientInjectProtocol;
}

/**
 * Inspect a local tar/tgz without executing package code or extracting to disk.
 * Every returned path is relative to the npm package root (without "package/").
 */
export function inspectArchive(absolutePath, { expectedSha256 } = {}) {
  if (typeof absolutePath !== 'string' || !isAbsolute(absolutePath)) {
    throw new Error('inspectArchive requires an absolute archive path');
  }
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256))) {
    throw new Error('Expected SHA256 must be exactly 64 hexadecimal characters');
  }
  const archive = readArchive(absolutePath);
  const sha256 = hash(archive);
  if (expectedSha256 !== undefined && expectedSha256.toLowerCase() !== sha256) {
    throw new Error('Archive SHA256 mismatch');
  }
  let tarBytes;
  try {
    tarBytes = archive[0] === 0x1f && archive[1] === 0x8b
      ? gunzipSync(archive, { maxOutputLength: UNPACK_LIMIT }) : archive;
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error('Package exceeds the 64 MiB inspection limit', { cause: error });
    }
    throw new Error('Cannot decompress package archive', { cause: error });
  }
  if (tarBytes.length > UNPACK_LIMIT) throw new Error('Package exceeds the 64 MiB inspection limit');

  const entries = lines(runTar(tarBytes, ['-tf', '-'], 'list package entries'));
  if (entries.some((entry) => !entry.startsWith('package/'))) {
    throw new Error('Package has duplicate or undeclared paths');
  }
  const paths = entries.map((entry) => entry.slice('package/'.length)).sort();
  const migrations = checkFilePaths(paths);
  const metadata = lines(runTar(tarBytes, ['-tvf', '-'], 'read package entry types'));
  if (metadata.length !== entries.length || metadata.some((line) => !line.startsWith('-'))) {
    throw new Error('Package must contain ordinary files only');
  }

  const contents = new Map();
  const read = (path) => {
    if (!allowedPath(path) || !paths.includes(path)) throw new Error('Uninspected package path: ' + path);
    if (!contents.has(path)) {
      contents.set(path, runTar(tarBytes, ['-xOf', '-', '--', 'package/' + path], 'read package file ' + path));
    }
    return contents.get(path);
  };
  const manifest = parseJson(read('package.json'), 'package.json');
  const config = parseJson(read('orchestra.config.json'), 'orchestra.config.json');
  const clientInjectProtocol = checkManifest(manifest, config?.phase);
  if (Array.isArray(manifest.files)) {
    for (const guide of PACKAGE_GUIDES) {
      if (manifest.files.includes(guide) && !paths.includes(guide)) {
        throw new Error('Missing declared package guide: ' + guide);
      }
    }
  }
  const patch = read('cordis.patch.yml').toString('utf8').replace(/^\s*#.*$/gm, '').trim();
  if (!patch.startsWith('[')) throw new Error('DSH bundle patch must contain a top-level sequence');
  if (!read('lib/client.js').toString('utf8').includes('window.__ModuleLoader__.load')
    || !read('lib/index.js').toString('utf8').includes('serveDshOrchestra')) {
    throw new Error('Packaged entries are incomplete');
  }
  let contentBytes = 0;
  const files = paths.map((path) => {
    const bytes = read(path);
    contentBytes += bytes.length;
    if (contentBytes > UNPACK_LIMIT) throw new Error('Package exceeds the 64 MiB inspection limit');
    return { path, sha256: hash(bytes), bytes: bytes.length };
  });
  if (hash(readArchive(absolutePath)) !== sha256) throw new Error('Package changed during inspection');
  return { sha256, bytes: archive.length, manifest, version: manifest.version, clientInjectProtocol, files, migrations };
}

function statIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function inspectInstalledTree(root, allowedDirectories, expectedFiles) {
  const found = new Map();
  const directories = new Map();
  const visit = (relative) => {
    const absolute = relative ? join(root, ...relative.split('/')) : root;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Installed package contains a symlink or non-directory: ' + (relative || '.'));
    }
    directories.set(relative, statIdentity(stat));
    for (const entry of readdirSync(absolute)) {
      const path = relative ? relative + '/' + entry : entry;
      const entryAbsolute = join(absolute, entry);
      const entryStat = lstatSync(entryAbsolute);
      if (!relative && entry === 'node_modules') {
        // A hoisted install can keep conflicting dependency versions here.
        // This package-manager-owned subtree is not part of the inspected tgz.
        let isDependencyDirectory = entryStat.isDirectory();
        if (entryStat.isSymbolicLink()) {
          try {
            isDependencyDirectory = statSync(entryAbsolute).isDirectory();
          } catch {
            isDependencyDirectory = false;
          }
        }
        if (!isDependencyDirectory) {
          throw new Error('Installed package root node_modules must be a directory or a link to a directory');
        }
        continue;
      }
      if (entryStat.isSymbolicLink()) throw new Error('Installed package contains an internal symlink: ' + path);
      if (entryStat.isDirectory()) {
        if (!allowedDirectories.has(path)) throw new Error('Installed package has an undeclared directory: ' + path);
        visit(path);
      } else {
        if (!entryStat.isFile()) throw new Error('Installed package file is not a regular file: ' + path);
        if (!expectedFiles.has(path)) throw new Error('Installed package has an undeclared file: ' + path);
        found.set(path, statIdentity(entryStat));
      }
    }
  };
  visit('');
  if (found.size !== expectedFiles.size) {
    const missing = [...expectedFiles.keys()].find((path) => !found.has(path));
    throw new Error('Installed package is missing a file: ' + missing);
  }
  return { files: found, directories };
}

/**
 * Verify installed package payload files against inspected per-file digests.
 * The package root may be pnpm's symlink. Its top-level node_modules subtree
 * belongs to the package manager and is excluded; other internal links fail.
 */
export function verifyInstalled(profileDir, inspection) {
  if (typeof profileDir !== 'string' || !profileDir.length) throw new Error('A profile directory is required');
  if (!inspection || !Array.isArray(inspection.files)) throw new Error('A package inspection is required');
  const paths = inspection.files.map((file) => file?.path);
  checkFilePaths(paths);
  let totalBytes = 0;
  for (const file of inspection.files) {
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > UNPACK_LIMIT
      || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) {
      throw new Error('Invalid inspected file metadata: ' + file.path);
    }
    totalBytes += file.bytes;
  }
  if (totalBytes > UNPACK_LIMIT) throw new Error('Inspected files exceed the 64 MiB inspection limit');

  const packageRoot = join(resolve(profileDir), 'node_modules', 'dsh-orchestra');
  const rootStat = lstatSync(packageRoot);
  if (!rootStat.isDirectory() && !rootStat.isSymbolicLink()) throw new Error('Installed package root must be a directory');
  const realPackageRoot = realpathSync(packageRoot);
  const expectedFiles = new Map(inspection.files.map((file) => [file.path, file]));
  const allowedDirectories = new Set();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) allowedDirectories.add(parts.slice(0, i).join('/'));
  }
  const before = inspectInstalledTree(realPackageRoot, allowedDirectories, expectedFiles);
  const buffer = Buffer.alloc(64 * 1024);
  for (const file of inspection.files) {
    const absolute = join(realPackageRoot, ...file.path.split('/'));
    const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error('Installed package file is not a regular file: ' + file.path);
      if (statIdentity(stat) !== before.files.get(file.path)) {
        throw new Error('Installed package changed during verification: ' + file.path);
      }
      if (stat.size !== file.bytes) throw new Error('Installed file size mismatch: ' + file.path);
      const digest = createHash('sha256');
      let readBytes = 0;
      let length;
      while ((length = readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
        readBytes += length;
        if (readBytes > file.bytes) throw new Error('Installed file size mismatch: ' + file.path);
        digest.update(buffer.subarray(0, length));
      }
      if (readBytes !== file.bytes || digest.digest('hex') !== file.sha256.toLowerCase()) {
        throw new Error('Installed file SHA256 mismatch: ' + file.path);
      }
      if (statIdentity(fstatSync(fd)) !== before.files.get(file.path)) {
        throw new Error('Installed package changed during verification: ' + file.path);
      }
    } finally {
      closeSync(fd);
    }
  }
  if (realpathSync(packageRoot) !== realPackageRoot || statIdentity(lstatSync(packageRoot)) !== statIdentity(rootStat)) {
    throw new Error('Installed package root changed during verification');
  }
  const after = inspectInstalledTree(realPackageRoot, allowedDirectories, expectedFiles);
  for (const kind of ['files', 'directories']) {
    if (before[kind].size !== after[kind].size
      || [...before[kind]].some(([path, identity]) => identity !== after[kind].get(path))) {
      throw new Error('Installed package changed during verification');
    }
  }
  return { packageRoot, realPackageRoot, version: inspection.version, fileCount: paths.length, bytes: totalBytes };
}
