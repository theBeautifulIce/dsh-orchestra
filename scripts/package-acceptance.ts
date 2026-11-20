import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256Hex } from '../src/core/canonical.ts'

const baseFiles = new Set([
  'package/package.json', 'package/lib/index.js', 'package/lib/index.d.ts', 'package/lib/client.js',
  'package/cordis.patch.yml', 'package/orchestra.config.json',
])
const migrationPath = /^package\/lib\/infra\/sqlite\/migrations\/(\d{3})_[a-z0-9_]+\.sql$/

export function inspectPackage(path: string, options: { expectedSha256?: string; previous?: boolean } = {}) {
  const archive = resolve(path)
  const bytes = readFileSync(archive)
  const sha256 = sha256Hex(bytes)
  if (options.expectedSha256 && options.expectedSha256 !== sha256) throw new Error('Archive SHA256 mismatch')
  const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/).sort()
  if (new Set(entries).size !== entries.length
    || entries.some((name) => !baseFiles.has(name) && name !== 'package/README.md' && !migrationPath.test(name))) {
    throw new Error('Package has duplicate or undeclared paths')
  }
  const metadata = execFileSync('tar', ['-tvf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/)
  if (metadata.length !== entries.length || metadata.some((line) => !line.startsWith('-'))) {
    throw new Error('Package must contain ordinary files only')
  }
  for (const required of baseFiles) if (!entries.includes(required)) throw new Error('Missing package file: ' + required)
  if (!options.previous && !entries.includes('package/README.md')) throw new Error('Candidate package has no installation README')

  const read = (name: string) => execFileSync('tar', ['-xOf', archive, 'package/' + name], { maxBuffer: 10 * 1024 * 1024 })
  const manifest = JSON.parse(read('package.json').toString('utf8'))
  const config = read('orchestra.config.json')
  const phase = JSON.parse(config.toString('utf8')).phase
  const patch = read('cordis.patch.yml').toString('utf8').replace(/^\s*#.*$/gm, '').trim()
  if (manifest.name !== 'dsh-orchestra' || manifest.private !== true || manifest.type !== 'module'
    || manifest.main !== 'lib/index.js' || manifest.types !== 'lib/index.d.ts'
    || manifest.exports?.['.']?.default !== './lib/index.js' || manifest.exports?.['./client'] !== './lib/client.js'
    || manifest.dsh?.bundle?.patch !== './cordis.patch.yml' || manifest.dsh?.manifestVersion !== 1
    || manifest.dsh?.client?.platform !== 'web' || manifest.dsh?.client?.inject?.length !== 6 || phase !== 'S2') {
    throw new Error('Package manifest, advertised DSH client or default phase has changed')
  }
  if (!options.previous && !patch.startsWith('[')) throw new Error('DSH bundle patch must contain a top-level sequence')
  if (!read('lib/client.js').toString('utf8').includes('window.__ModuleLoader__.load')
    || !read('lib/index.js').toString('utf8').includes('serveDshOrchestra')) throw new Error('Packaged entries are incomplete')

  const migrations = entries.flatMap((name) => {
    const version = migrationPath.exec(name)?.[1]
    return version ? [{ name, version: Number(version) }] : []
  })
  if (migrations.length < 57 || migrations.some(({ version }, index) => version !== index + 1)) {
    throw new Error('Packaged SQLite migrations are incomplete')
  }
  if (sha256Hex(readFileSync(archive)) !== sha256) throw new Error('Package changed during inspection')
  return { archive, sha256, bytes: bytes.length, entries, migrations, default_phase: phase,
    build_version: String(manifest.version), dsh_patch_has_sequence: patch.startsWith('['), config_sha256: sha256Hex(config) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [archive, role] = process.argv.slice(2)
    if (!archive || !['previous', 'candidate'].includes(role ?? '') || process.argv.length !== 4) {
      throw new Error('Usage: node scripts/package-acceptance.ts <tgz> <previous|candidate>')
    }
    process.stdout.write(JSON.stringify(inspectPackage(archive, { previous: role === 'previous' }), null, 2) + '\n')
  } catch (error) {
    process.stderr.write(String(error) + '\n')
    process.exitCode = 1
  }
}
