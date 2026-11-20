import { sha256Hex, canonicalJson } from '../src/core/canonical.ts'
import { parseConfig } from '../src/core/config.ts'
import { FORMAL_SLOT_MS, FORMAL_SLOTS, type Manifest } from './soak-judge.ts'

export const FORMAL_SOAK_ARCHIVE = [
  'launch.json', 'host.json', 'manifest.json', 'points.ndjson', 'events.ndjson', 'end.json',
  'soak-config.json', 'ledger.db', 'workspace/sample.txt', 'detached.json',
] as const

type Launch = {
  schema: number; id: string; kind: string; requestedCandidate: string; slots: number; slotMs: number
  supervisorPid: number; supervision: string; command: string[]; requestedAt: string
}

export function assertFormalSoakArchive(read: (name: string) => Uint8Array, manifest: Manifest) {
  const parse = <T>(name: string): T => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read(name))) as T
  const hashes = parse<Record<string, string>>('hashes.json')
  const matches = (name: string) => {
    const bytes = read(name)
    return sha256Hex(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)) === hashes[name]
  }
  if (Object.keys(hashes).length !== FORMAL_SOAK_ARCHIVE.length
    || !FORMAL_SOAK_ARCHIVE.every(matches)) {
    throw new Error('The formal soak archive hashes do not match all required originals')
  }
  if (manifest.kind !== 'formal' || manifest.supervision !== 'detached' || manifest.clean !== true
    || manifest.slots !== FORMAL_SLOTS || manifest.slotMs !== FORMAL_SLOT_MS) throw new Error('The archive is not a formal continuous run')
  const launch = parse<Launch>('launch.json')
  const detached = parse<{ pid: number; startedAt: string; command: string[] }>('detached.json')
  const scriptIndex = launch.command.findIndex(part => /[\\/]scripts[\\/]soak\.ts$/u.test(part))
  const args = launch.command.slice(scriptIndex + 1)
  const flag = (name: string) => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  if (launch.schema !== 1 || launch.id !== manifest.id || launch.kind !== manifest.kind || launch.supervision !== 'detached'
    || launch.requestedCandidate !== manifest.candidate || launch.slots !== manifest.slots || launch.slotMs !== manifest.slotMs
    || !Number.isSafeInteger(launch.supervisorPid) || launch.supervisorPid <= 0 || launch.supervisorPid === manifest.pid
    || scriptIndex < 1 || canonicalJson(launch.command) !== canonicalJson(manifest.command)
    || args.length !== 6 || flag('--hours') !== '24' || flag('--candidate') !== manifest.candidate || !flag('--evidence-dir')
    || detached.pid !== manifest.pid || !Number.isFinite(Date.parse(launch.requestedAt))
    || !(Date.parse(launch.requestedAt) <= Date.parse(detached.startedAt) && Date.parse(detached.startedAt) <= manifest.startWallMs)
    || canonicalJson(detached.command) !== canonicalJson([launch.command[0], '--no-warnings', launch.command[scriptIndex],
      '--worker', manifest.id, '--evidence-dir', manifest.root])) {
    throw new Error('The formal soak launch is disconnected from its worker or candidate')
  }
  const root = manifest.root.replaceAll('\\', '/')
  const host = parse<{ phase: string; supervision: string; isolatedWorkspace: string; topology: string;
    availableBytes: number; requiredBytes: number; fixture: string }>('host.json')
  const config = parseConfig(parse('soak-config.json'), 'soak-config.json')
  const fixture = 's6 synthetic read-only fixture v1'
  if (!/^(?:[A-Za-z]:)?\//.test(root) || root.includes('/../')
    || config.phase !== 'S6' || hashes['soak-config.json'] !== manifest.configHash
    || config.service.db_path.replaceAll('\\', '/') !== root + '/ledger.db'
    || config.bridge.spill_dir.replaceAll('\\', '/') !== root + '/spill'
    || host.phase !== 'S6' || host.supervision !== 'detached' || host.isolatedWorkspace.replaceAll('\\', '/') !== root + '/workspace'
    || host.topology !== 'one process plus loopback HTTP/SSE; no child executor'
    || !Number.isSafeInteger(host.availableBytes) || host.availableBytes < host.requiredBytes || host.requiredBytes !== 128 * 1024 * 1024
    || host.fixture !== fixture || new TextDecoder().decode(read('workspace/sample.txt')) !== fixture + '\n') {
    throw new Error('The formal soak host, configuration, or fixture differs from the isolated runtime')
  }
}
