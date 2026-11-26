#!/usr/bin/env node
// Offline package updater. Uses DSH's public plugin command; never edits host code or ledgers.
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, delimiter, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { inspectArchive, verifyInstalled } from './inspect-package.mjs'

const PACKAGE = 'dsh-orchestra'
export const UPDATER_VERSION = '1.1.1'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const HELP = `DSH Orchestra updater ${UPDATER_VERSION} (Node >= 22.19)

Build and update from an existing checkout:
  node update-dsh-orchestra.mjs --repo "D:\\aboutAI\\dsh-orchestra" [--dsh "...\\resources\\runtime\\cli\\bin\\dsh.cmd"]
Install a previously built package:
  node update-dsh-orchestra.mjs --package "D:\\packages\\dsh-orchestra.tgz" [--sha256 HEX]

Options:
  --repo DIR          Build this local checkout (default: current directory).
  --package FILE      Install this local .tgz; mutually exclusive with --repo.
  --dsh FILE          DSH command. Desktop requires its bundled dsh.cmd/dsh.
  --dsh-home DIR      DSH_HOME used by the intended installation.
  --profile NAME      Existing profile; default desktop.
  --test              Run the full project test suite before building.
  --plan              Read-only preview: no builds, backups or installation.
  --json              One JSON result on stdout; progress/logs on stderr.
  --help              Show this help.

Fully quit Desktop from the tray/application menu before updating.
The script does not pull/reset Git, stop Desktop, restart it, or roll back a ledger.
`;

export function parseArgs(args) {
  const options = { profile: 'desktop', json: false, plan: false, test: false }
  const values = new Set(['repo', 'package', 'dsh', 'dsh-home', 'profile', 'sha256'])
  const flags = new Set(['json', 'plan', 'test', 'help'])
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : ''
    if (!values.has(key) && !flags.has(key)) throw new Error(`Unknown argument: ${args[i]}`)
    if (seen.has(key)) throw new Error(`Duplicate argument: --${key}`)
    seen.add(key)
    if (flags.has(key)) options[key] = true
    else {
      const value = args[++i]
      if (!value || value.startsWith('--') || /[\0\r\n]/u.test(value)) throw new Error(`Missing or invalid value for --${key}`)
      options[key] = value
    }
  }
  if (options.repo && options.package) throw new Error('Use --repo or --package, not both')
  if (options.sha256 && !options.package) throw new Error('--sha256 requires --package')
  if (options.package && options.test) throw new Error('--test requires source mode (--repo)')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/u.test(options.profile) || options.profile.toLowerCase() === 'node_modules') {
    throw new Error('Invalid profile name')
  }
  if (options.profile.toLowerCase() === 'desktop') options.profile = 'desktop'
  return options
}

function expandPath(input) {
  if (input === '~') return homedir()
  if (/^~[/\\]/u.test(input)) return resolve(homedir(), input.slice(2))
  return resolve(input)
}

function findOnPath(name, env = process.env) {
  const names = process.platform === 'win32' ? [name + '.exe', name + '.cmd', name + '.bat', name] : [name]
  const found = []
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const candidate of names) {
      const path = resolve(directory.replace(/^"|"$/gu, ''), candidate)
      if (existsSync(path) && statSync(path).isFile() && !found.includes(path)) found.push(path)
    }
  }
  return found
}

export function commandSpec(file, args, currentPlatform = process.platform) {
  if (currentPlatform === 'win32' && /\.(cmd|bat)$/iu.test(file)) {
    // cmd expands % even inside quotes. Reject these rare characters instead of guessing an escape.
    for (const value of [file, ...args]) {
      if (/["%!\r\n\0]/u.test(value)) throw new Error('Windows batch command paths/arguments cannot contain quotes, %, ! or line breaks; choose another path')
    }
    const line = '"' + [file, ...args].map(value => '"' + value + '"').join(' ') + '"'
    return { file: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/v:off', '/s', '/c', line], windowsVerbatimArguments: true }
  }
  if (/\.(mjs|cjs|js)$/iu.test(file)) return { file: process.execPath, args: [file, ...args] }
  return { file, args }
}

function bundledDesktopCommand(path) {
  if (!existsSync(path) || !statSync(path).isFile()) return false
  const normalized = path.replaceAll('\\', '/')
  if (!/\/resources\/runtime\/cli\/bin\/dsh(?:\.cmd)?$/iu.test(normalized)) return false
  const text = readFileSync(path, 'utf8')
  return text.includes('ELECTRON_RUN_AS_NODE') && text.includes('dsh-desktop-host')
}

function resolveDsh(options, env) {
  if (options.dsh) {
    const explicit = expandPath(options.dsh)
    if (!existsSync(explicit) || !statSync(explicit).isFile()) throw new Error(`DSH command not found: ${explicit}`)
    if (options.profile === 'desktop' && !bundledDesktopCommand(explicit)) {
      throw new Error('Desktop requires its installed resources/runtime/cli/bin/dsh.cmd (or dsh); npm/global dsh is not supported for desktop')
    }
    return explicit
  }
  const candidates = [...(env.DSH_DESKTOP_COMMAND ? [expandPath(env.DSH_DESKTOP_COMMAND)] : []), ...findOnPath('dsh', env)]
  if (process.platform === 'win32') {
    for (const parent of [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      candidates.push(join(parent, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh')
  }
  const chosen = candidates.find(path => options.profile === 'desktop' ? bundledDesktopCommand(path) : existsSync(path))
  if (!chosen) throw new Error('Cannot locate the appropriate DSH command. Supply --dsh with the Desktop bundled dsh.cmd/dsh, or your existing non-Desktop CLI command.')
  return chosen
}

function desktopMustBeClosed() {
  if (process.platform !== 'win32') return
  const text = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  if (/^"DeepSeek Harness\.exe",/imu.test(text)) {
    throw new Error('DSH Desktop is still running. Use Quit/Exit in its tray or application menu, then retry; closing the window may only hide it.')
  }
}

function jsonFile(path) { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')) }

function snapshotTree(source, destination) {
  const records = []
  let bytes = 0
  function walk(root, rel = '') {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!rel && entry.name === 'node_modules') continue // Package-manager dependencies are restored from the manifest/lock, not copied into the tarball.
      if (entry.name === 'node_modules' || entry.name === '.git') throw new Error('The existing plugin looks like a linked development checkout; update its installation explicitly instead of snapshotting it as a packaged plugin')
      const next = rel ? join(rel, entry.name) : entry.name
      const input = join(source, next)
      const info = lstatSync(input)
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`Unexpected link/special file in installed plugin: ${next}`)
      if (info.isDirectory()) { mkdirSync(join(destination, next), { recursive: true }); walk(input, next) }
      else {
        bytes += info.size
        if (bytes > 64 * 1024 * 1024) throw new Error('Existing plugin snapshot exceeds 64 MiB')
        const content = readFileSync(input)
        mkdirSync(dirname(join(destination, next)), { recursive: true })
        writeFileSync(join(destination, next), content, { flag: 'wx', mode: 0o600 })
        records.push({ path: next, sha256: sha256(content) })
      }
    }
  }
  mkdirSync(destination, { recursive: true })
  walk(source)
  for (const file of records) {
    if (sha256(readFileSync(join(source, file.path))) !== file.sha256) throw new Error('Installed plugin changed during backup; stop other writers and retry')
  }
  return records
}

function backupInstallation(profileDir, operationDir) {
  const backup = join(operationDir, 'backup')
  mkdirSync(backup, { recursive: true, mode: 0o700 })
  const saved = []
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const path = join(profileDir, name)
    if (existsSync(path)) {
      if (!lstatSync(path).isFile()) throw new Error(`Profile metadata is not a regular file: ${name}`)
      copyFileSync(path, join(backup, name))
      saved.push(name)
    }
  }
  const installed = join(profileDir, 'node_modules', PACKAGE)
  let previous = null
  if (existsSync(installed)) {
    const previousRoot = realpathSync(installed)
    const metadata = jsonFile(join(previousRoot, 'package.json'))
    if (metadata.name !== PACKAGE) throw new Error('Installed package identity mismatch')
    const files = snapshotTree(previousRoot, join(backup, 'previous', 'package'))
    const tar = execFileSync('tar', ['-cf', '-', '-C', join(backup, 'previous'), ...files.map(file => 'package/' + file.path.replaceAll('\\', '/'))],
      { maxBuffer: 68 * 1024 * 1024, env: { ...process.env, TAR_OPTIONS: '' } })
    const bytes = gzipSync(tar)
    const archive = join(backup, 'previous-plugin.tgz')
    writeFileSync(archive, bytes, { flag: 'wx', mode: 0o600 })
    previous = { version: metadata.version, archive, sha256: sha256(bytes), files }
  }
  return { directory: backup, profileFiles: saved, previous }
}

async function runCommand(file, args, { cwd, env, log, quiet }) {
  const spec = commandSpec(file, args)
  await new Promise((resolveDone, reject) => {
    const child = spawn(spec.file, spec.args, { cwd, env, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log.write(chunk); if (!quiet) process.stderr.write(chunk) })
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 ? resolveDone() : reject(new Error(`${basename(file)} failed (${signal ?? `exit ${code}`}); inspect operation.log`)))
  })
}

function persistJson(path, value) {
  const temp = path + '.new'
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, path)
}

function pointsAtArchive(spec, profileDir, archive) {
  if (typeof spec !== 'string' || !spec.startsWith('file:')) return false
  try {
    const path = spec.startsWith('file://') ? fileURLToPath(spec) : resolve(profileDir, spec.slice(5))
    return process.platform === 'win32' ? path.toLowerCase() === archive.toLowerCase() : path === archive
  } catch { return false }
}

export async function update(options, dependencies = {}) {
  const env = { ...process.env, ...dependencies.env }
  const execute = dependencies.runCommand ?? runCommand
  const dshHome = expandPath(options['dsh-home'] ?? (env.DSH_HOME?.trim() || join(homedir(), '.dsh')))
  env.DSH_HOME = dshHome
  const profileDir = join(dshHome, 'profiles', options.profile)
  const profileFile = join(profileDir, 'package.json')
  if (!existsSync(profileFile)) throw new Error(`Profile is not initialized: ${profileDir}. Open the intended DSH installation once, then quit it; check --dsh-home if using a custom home.`)
  const before = jsonFile(profileFile)
  if (!before.dsh?.profile || !Array.isArray(before.dsh.profile.bundles)) throw new Error('Existing profile metadata does not contain dsh.profile.bundles')
  const dsh = resolveDsh(options, env)
  const source = options.package ? null : expandPath(options.repo ?? process.cwd())
  let sourceManifest
  if (source) {
    sourceManifest = jsonFile(join(source, 'package.json'))
    if (sourceManifest.name !== PACKAGE) throw new Error('--repo must be the dsh-orchestra checkout')
    if (!existsSync(join(source, 'pnpm-lock.yaml'))) throw new Error('Source checkout has no pnpm-lock.yaml')
  }
  const input = options.package ? expandPath(options.package) : null
  const inspected = input ? inspectArchive(input, { expectedSha256: options.sha256 }) : null
  const plan = { updaterVersion: UPDATER_VERSION, profile: options.profile, dshHome, profileDir, dshCommand: dsh, source, package: input,
    candidatePackage: input, clientInjectProtocol: inspected?.clientInjectProtocol ?? null,
    version: inspected?.version ?? sourceManifest.version,
    steps: source ? ['install locked source dependencies', 'typecheck', ...(options.test ? ['full tests'] : []), 'build', 'pack', 'inspect', 'backup', 'DSH plugin add', 'verify installed bytes'] : ['inspect', 'backup', 'DSH plugin add', 'verify installed bytes'] }
  if (options.plan) return { ok: true, status: 'plan', ...plan }
  if (options.profile === 'desktop') desktopMustBeClosed()

  const state = join(dshHome, 'orchestra-updater')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  const lock = join(state, options.profile + '.update-lock')
  try { mkdirSync(lock) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another update may be active: ${lock}. Do not remove its lock until that updater process has stopped.`)
    throw error
  }
  const operationDir = join(state, 'operations', new Date().toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID())
  const receipt = { ok: false, status: 'running', ...plan, operationDir, startedAt: new Date().toISOString(), stage: 'prepare', profileBundlesBefore: before.dsh.profile.bundles }
  let log
  let logError
  let receiptPath
  try {
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }))
    mkdirSync(operationDir, { recursive: true, mode: 0o700 })
    receiptPath = join(operationDir, 'receipt.json')
    log = createWriteStream(join(operationDir, 'operation.log'), { flags: 'a', mode: 0o600 })
    log.on('error', error => { logError = error })
    const step = async (name, file, args, cwd) => {
      receipt.stage = name; persistJson(receiptPath, receipt)
      process.stderr.write(`[${name}]\n`)
      log.write(`\n[${name}] ${JSON.stringify({ command: file, args })}\n`)
      await execute(file, args, { cwd, env, log, quiet: options.json })
      if (logError) throw new Error(`Cannot write the operation log: ${logError.message}`)
    }
    let archive = input
    if (source) {
      const pnpm = findOnPath('pnpm', env)[0]
      if (!pnpm) throw new Error('pnpm is not available on PATH. Install the package manager declared by this checkout before building.')
      // Keep all build/test scratch outside the shared system tmp.
      env.TMPDIR = env.TMP = env.TEMP = join(operationDir, 'temporary')
      mkdirSync(env.TMPDIR, { recursive: true })
      await step('dependencies', pnpm, ['install', '--frozen-lockfile'], source)
      await step('typecheck', pnpm, ['typecheck'], source)
      if (options.test) await step('tests', pnpm, ['exec', 'vitest', 'run', '--maxWorkers=1', '--reporter=verbose'], source)
      await step('build', pnpm, ['build'], source)
      const packed = join(operationDir, 'packed')
      mkdirSync(packed)
      await step('pack', pnpm, ['pack', '--pack-destination', packed], source)
      const archives = readdirSync(packed).filter(name => name.endsWith('.tgz'))
      if (archives.length !== 1) throw new Error('Expected exactly one new .tgz from pnpm pack')
      archive = join(packed, archives[0])
    }
    receipt.stage = 'inspect'
    receipt.candidatePackage = archive
    persistJson(receiptPath, receipt)
    const inspection = inspected ?? inspectArchive(archive)
    receipt.clientInjectProtocol = inspection.clientInjectProtocol
    const packageDir = join(state, 'packages', inspection.sha256)
    mkdirSync(packageDir, { recursive: true })
    const permanentArchive = join(packageDir, `${PACKAGE}.tgz`)
    if (existsSync(permanentArchive)) {
      if (sha256(readFileSync(permanentArchive)) !== inspection.sha256) throw new Error('Persistent package path contains different bytes; refusing to overwrite it')
    } else {
      copyFileSync(archive, permanentArchive)
      if (sha256(readFileSync(permanentArchive)) !== inspection.sha256) throw new Error('Archive changed while copying')
    }
    receipt.package = permanentArchive
    receipt.version = inspection.version
    receipt.sha256 = inspection.sha256
    receipt.migrations = inspection.migrations.length
    let match = null
    try { match = verifyInstalled(profileDir, inspection) } catch { /* A different installed package needs an update. */ }
    if (match && pointsAtArchive(before.dependencies?.[PACKAGE], profileDir, permanentArchive)) {
      receipt.ok = true; receipt.status = 'already-current'; receipt.verification = match
    } else {
      receipt.stage = 'backup'
      if (options.profile === 'desktop') desktopMustBeClosed()
      receipt.backup = backupInstallation(profileDir, operationDir)
      persistJson(receiptPath, receipt)
      const recovery = receipt.backup.previous ? {
        command: dsh, args: ['plugin', '--profile', options.profile, 'add', receipt.backup.previous.archive],
        dshHome, archiveSha256: receipt.backup.previous.sha256,
        condition: 'For operator-directed package recovery after an installation failure. Fully quit the host. If the new plugin has already run/migrated a ledger, assess schema compatibility before using an old package. Never overwrite a live ledger with this installation snapshot.'
      } : { condition: 'No previous plugin package was installed; inspect the DSH package-manager log before recovery.' }
      persistJson(join(operationDir, 'recovery.json'), recovery)
      // The supported host command retains its own shared profile lock and compatibility checks.
      await step('install', dsh, ['plugin', '--profile', options.profile, 'add', permanentArchive], operationDir)
      receipt.stage = 'verify'
      const after = jsonFile(profileFile)
      if (!after.dependencies?.[PACKAGE]) throw new Error('DSH returned success but the profile does not declare dsh-orchestra')
      receipt.verification = verifyInstalled(profileDir, inspection)
      receipt.profileBundlesAfter = after.dsh?.profile?.bundles
      if (!Array.isArray(receipt.profileBundlesAfter)) throw new Error('DSH profile bundle metadata is missing after installation')
      receipt.ok = true; receipt.status = 'installed-verified'
    }
    receipt.stage = 'complete'
    receipt.restartRequired = receipt.status === 'installed-verified'
    receipt.message = receipt.status === 'already-current' ? 'The installed files already match this package.' : 'Installation and file verification completed. Reopen the intended DSH profile to load the update.'
    receipt.finishedAt = new Date().toISOString()
    receipt.receipt = receiptPath
    persistJson(receiptPath, receipt)
    return receipt
  } catch (error) {
    receipt.ok = false; receipt.status = 'failed'; receipt.error = String(error.message ?? error)
    receipt.finishedAt = new Date().toISOString()
    if (receiptPath) {
      receipt.receipt = receiptPath
      try { persistJson(receiptPath, receipt) } catch (saveError) { receipt.receiptWriteError = String(saveError.message ?? saveError) }
    }
    return receipt
  } finally {
    if (log) await new Promise(resolveDone => log.end(resolveDone))
    for (const path of [join(operationDir, 'temporary'), lock]) {
      try { rmSync(path, { recursive: true, force: true }) }
      catch (error) { (receipt.warnings ??= []).push(`Cleanup could not finish for ${path}: ${error.message}`) }
    }
    if (receipt.warnings && receiptPath) {
      try { persistJson(receiptPath, receipt) } catch { /* Keep the result available on stdout even if storage has failed. */ }
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options
  let result
  try {
    options = parseArgs(argv)
    if (options.help) { process.stdout.write(HELP); return 0 }
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major < 22 || (major === 22 && minor < 19)) throw new Error('Node 22.19+ is required')
    result = await update(options)
  } catch (error) { result = { ok: false, status: 'failed', updaterVersion: UPDATER_VERSION, stage: 'preflight', error: String(error.message ?? error) } }
  if (options?.json || argv.includes('--json')) {
    const summary = result.status === 'plan' ? result : Object.fromEntries(
      ['ok', 'status', 'updaterVersion', 'stage', 'profile', 'version', 'sha256', 'clientInjectProtocol', 'dshHome', 'profileDir', 'dshCommand', 'package', 'candidatePackage', 'operationDir', 'receipt', 'restartRequired', 'message', 'error', 'receiptWriteError', 'warnings']
        .filter(key => result[key] !== undefined).map(key => [key, result[key]]))
    if (result.verification) summary.verifiedFiles = result.verification.fileCount
    if (result.backup) summary.backupDirectory = result.backup.directory
    process.stdout.write(JSON.stringify(summary) + '\n')
  }
  else {
    process.stdout.write(`${result.ok ? 'OK' : 'FAILED'}: ${result.message ?? result.error ?? result.status}\n`)
    if (result.status === 'plan') process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (result.receipt) process.stdout.write(`Receipt: ${result.receipt}\n`)
    if (result.package) process.stdout.write(`Package: ${result.package}\n`)
    if (result.backup) process.stdout.write(`Backup: ${result.backup.directory}\n`)
    for (const warning of result.warnings ?? []) process.stdout.write(`Warning: ${warning}\n`)
  }
  return result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
