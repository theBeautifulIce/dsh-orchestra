import { execFileSync, spawnSync } from 'node:child_process'
import { createPublicKey, verify } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { sha256Hex } from '../src/core/canonical.ts'
import { parseAuditVerdict, verdictProblems, VERDICT_BEGIN, VERDICT_END } from '../src/core/audit-verdict.ts'
import { normalizeReleaseManifest, releaseHash, RELEASE_ITEMS } from '../src/core/wf-release-v1.ts'
import { openDb, type Db } from '../src/infra/sqlite/driver.ts'
import { releaseDefinitionHash } from '../src/service/release-workflow.ts'
import { PRIOR_GATE_HASH, sealReleasePair } from '../src/service/release-gate.ts'
import type { ReleaseGovernance } from '../src/core/gate-artifact.ts'
import { createG6FileEvidenceReader, withG6Scratch } from './g6-file-evidence.ts'
import { R0_ORIGINALS, verifyR0Observation } from './r0-observe.ts'

export const G6_GATE_PATH = 'docs/gates/G6.md'
export const G6_INPUT_PATH = 'docs/gates/G6-release-input.json'
export const G6_REGISTRY_PATH = 'docs/gates/G6-evidence-registry.json'
export const G6_INDEPENDENT_PATH = 'docs/gates/G6-independent.json'
export const G6_PUBLICATION_PATH = 'docs/gates/G6-release.json'
export const G5_SIGNED_COMMIT = '8abbf0f0bc14c0a9e006625528d38e7288ccefba'
const oldGatePaths = ['G1','G2','G3','G4','G5'].map((gate) => 'docs/gates/' + gate + '.md')
const outputs = [G6_GATE_PATH, G6_INDEPENDENT_PATH, G6_PUBLICATION_PATH]
const hash = z.string().regex(/^[a-f0-9]{64}$/).refine((value) => !/^0+$/.test(value))
const commit = z.string().regex(/^[a-f0-9]{40}$/).refine((value) => !/^0+$/.test(value))
const path = z.string().min(1).max(512).refine((value) =>
  !/[\\:\x00-\x1f]/.test(value) && value.split('/').every((part) => part && part !== '.' && part !== '..'))
const identity = z.string().trim().min(1).max(128)
const human = z.string().regex(/^human:\S.*$/)
const registrySchema = z.strictObject({
  schema: z.literal('dsh-g6-registry/1'), manifest: path, isolated_ledger: path, frozen_package: path, install_receipt: path,
  evidence: z.array(z.strictObject({ evidence_id: identity, file: path, strength: z.literal('strong'), source: identity })).min(1),
  items: z.record(z.string(), z.array(identity).min(1)),
  invariants: z.record(z.string(), z.array(identity).min(1)),
})
const signed = z.strictObject({ key: identity, payload: z.unknown(), signature: z.string().min(1).max(8192) })
const packetSchema = z.strictObject({
  schema: z.literal('dsh-g6-settlement/1'), candidate_commit: commit, evidence_commit: commit, audit_commit: commit,
  run_id: identity, audit_report: path, audit_round: z.number().int().positive(),
  independent: signed, workspace: signed, audit: signed, approval: signed,
})
const signer = z.strictObject({ key: identity, principal: identity, public_key: z.string().min(1).max(8192),
  role: z.enum(['independent','workspace','audit','approval']) })
const trustSchema = z.strictObject({ schema: z.literal('dsh-g6-trust/1'), previous_installation_sha256: hash,
  ledger_secret_file: z.string().min(1), authorities: z.array(signer).min(4) })
type Role = z.infer<typeof signer>['role']
type TrustedSigner = z.infer<typeof signer>
type Envelope = z.infer<typeof signed>
export type G6TrustProvider = {
  previous_installation_sha256: string
  /** Verify role, exact payload and current registered principal using a trusted workspace credential. */
  verifyProof(envelope: Envelope, role: Role): { principal: string }
  /** Open the exact supplied isolated SQLite bytes read-only, using the host's ledger verifier. */
  withLedger<T>(bytes: Uint8Array, read: (db: Db, secret: string) => T): T
}
const installSchema = z.strictObject({
  schema: z.literal('dsh-g6-install/1'), candidate_commit: commit, package_sha256: hash, dsh_version: z.string().regex(/^0\.2\.2(?:[-+][\w.-]+)?$/),
  workspace: identity, installed_at: z.iso.datetime(), isolated: z.literal(true),
  observations: z.strictObject({ plugin_loaded: z.literal(true), migrations_applied: z.literal(true), panel_loaded: z.literal(true), smoke_run_succeeded: z.literal(true) }),
})
const workspaceSchema = z.strictObject({
  schema: z.literal('dsh-g6-workspace/1'), workspace: identity, run_id: identity, candidate_commit: commit, manifest_sha256: hash,
  ledger_sha256: hash, package_sha256: hash, install_sha256: hash,
})
const auditSchema = z.strictObject({
  schema: z.literal('dsh-g6-audit/1'), principal: human, candidate_commit: commit, audit_commit: commit, audit_sha256: hash,
  manifest_sha256: hash, audit_round: z.number().int().positive(),
})
const requiredValues = z.strictObject({
  queue: z.strictObject({ maximum: z.literal(1000), overflow_http: z.literal(503), warning: z.literal(true), evidence_id: identity }),
  retention: z.strictObject({ automatic_cleanup: z.literal(false), evidence_id: identity }),
  memory_judge: z.strictObject({ bridge: z.literal('memory-audit-v1'), prompt: z.literal('mem-judge-1'), model: identity, evidence_id: identity }),
  oncall: z.strictObject({ primary: z.literal('human:啸春'), escalation: z.literal('panel_inbox_to_qq'), cutoff_ms: z.literal(1_800_000), evidence_id: identity }),
  trial: z.strictObject({ r1_read_only: z.literal(true), r1_proposal_only: z.literal(true), r2_isolated: z.literal(true),
    r0_started_at: z.iso.datetime(), r0_ended_at: z.iso.datetime(), r0_p1: z.literal(0), evidence_id: identity }),
  soak: z.strictObject({ sample_ms: z.literal(30_000), samples: z.literal(2880), evidence_id: identity }),
})
const approvalSchema = z.strictObject({
  schema: z.literal('dsh-g6-approval/1'), principal: human, approved_at: z.iso.datetime(), expires_at: z.iso.datetime(),
  candidate_commit: commit, evidence_commit: commit, audit_commit: commit, previous_artifact_hash: z.literal(PRIOR_GATE_HASH),
  previous_installation_sha256: hash, publication_body_hash: hash, independent_body_hash: hash,
  audit_sha256: hash, independent_receipt_hash: hash, workspace_receipt_hash: hash, audit_receipt_hash: hash,
  params: requiredValues, governance: z.strictObject({ publication: z.unknown(), independent: z.unknown() }),
})

function reject(message: string): never { throw new Error(message) }

const utf8 = new TextDecoder('utf-8', { fatal: true })
const json = (bytes: Uint8Array): unknown => JSON.parse(utf8.decode(bytes))
const normalizedText = (text: string) => text.replace(/\r\n/g, '\n')
const checks = [...RELEASE_ITEMS, 'artifact_match']

function git(root: string, args: string[]) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
}
function head(root: string) { return git(root, ['rev-parse','--verify','HEAD']).toString('utf8').trim() }
function ancestor(root: string, first: string, second: string) {
  return spawnSync('git', ['merge-base','--is-ancestor',first,second], { cwd: root, stdio: 'ignore' }).status === 0
}
function trackedBlob(root: string, ref: string, file: string) {
  const result = git(root, ['ls-tree','-z', ref, '--', ':(top,literal)' + file]).toString('utf8')
  if (!/^(?:100644|100755) blob [a-f0-9]+\t[^\0]+\0$/.test(result)) return reject('缺少已提交的常规文件 ' + file)
  return git(root, ['show', ref + ':' + file])
}
function present(root: string, ref: string, file: string) {
  return git(root, ['ls-tree','-z',ref,'--', ':(top,literal)' + file]).length > 0
}
function changed(root: string, base: string, target: string) {
  const range = base + '..' + target
  const tree = git(root, ['diff','--name-only','--no-renames','-z',range]).toString('utf8')
  const transit = git(root, ['log','--full-history','-m','--format=','--name-only','--no-renames','-z',range]).toString('utf8')
  return [...new Set([...tree.split('\0'), ...transit.split('\0')].filter(Boolean))]
}
function sameSet(left: string[], right: string[]) {
  return new Set(left).size === left.length && new Set(right).size === right.length
    && left.length === right.length && left.every((item) => right.includes(item))
}

export function authenticateG6Proof(envelope: Envelope, role: Role, authorities: readonly TrustedSigner[]) {
  const key = authorities.find((item) => item.key === envelope.key && item.role === role)
  if (!key) return reject('没有授权的 G6 ' + role + ' 签署身份')
  const publicKey = createPublicKey(key.public_key)
  if (publicKey.asymmetricKeyType !== 'ed25519') return reject('G6 签署需要 Ed25519 公钥')
  const proofHash = releaseHash({ domain: 'dsh-orchestra/g6', role, key: envelope.key, payload: envelope.payload })
  if (!/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)
    || !verify(null, Buffer.from(proofHash, 'hex'), publicKey, Buffer.from(envelope.signature, 'base64'))) {
    return reject('G6 ' + role + ' 签署证明与原件不符')
  }
  return key
}

function outside(root: string, file: string) {
  if (!isAbsolute(file)) return reject('G6 信任配置和账本密钥必须使用工作区外的绝对路径')
  const actual = realpathSync(file)
  const boundary = realpathSync(root)
  const from = relative(boundary, actual)
  if (from !== '..' && !from.startsWith('..' + sep) && !isAbsolute(from)) {
    return reject('G6 信任配置不得由候选仓库自行定义')
  }
  return actual
}

function readOfflineTrust(root: string, trustFile: string): G6TrustProvider {
  const trust = trustSchema.parse(json(readFileSync(outside(root, trustFile))))
  const unique = trust.authorities.map((identity) => createPublicKey(identity.public_key).export({ type: 'spki', format: 'der' }).toString('base64'))
  if (new Set(unique).size !== unique.length || new Set(trust.authorities.map((identity) => identity.key)).size !== trust.authorities.length) {
    return reject('G6 签署身份不能复用密钥或 ID')
  }
  const secret = normalizedText(readFileSync(outside(root, trust.ledger_secret_file), 'utf8')).trim()
  if (secret.length < 24) return reject('缺少发布工作区的正式账本校验密钥')
  return { previous_installation_sha256: trust.previous_installation_sha256,
    verifyProof: (envelope, role) => authenticateG6Proof(envelope, role, trust.authorities),
    withLedger: (bytes, read) => withG6Scratch((directory) => {
      const file = join(directory, 'isolated-release.db')
      writeFileSync(file, bytes, { flag: 'wx' })
      const db = openDb(file, { readonly: true })
      try { return read(db, secret) }
      finally { db.raw.close() }
    }),
  }
}

async function resolveTrust(root: string) {
  const provider = process.env.DSH_G6_WORKSPACE_PROVIDER
  if (provider) {
    const module = await import(pathToFileURL(outside(root, provider)).href) as { createG6TrustProvider?: () => G6TrustProvider }
    const trust = module.createG6TrustProvider?.()
    if (!trust || !hash.safeParse(trust.previous_installation_sha256).success
      || typeof trust.verifyProof !== 'function' || typeof trust.withLedger !== 'function') return reject('G6 宿主未提供可验证授权及账本能力')
    return trust
  }
  const offline = process.env.DSH_G6_TRUST_FILE
  if (offline) return readOfflineTrust(root, offline)
  return reject('缺少已登记的正式 G6 工作区授权验证器')
}

let verifiedHistoryRoot: string | undefined
export function hasG5History(root: string) { return ancestor(root, G5_SIGNED_COMMIT, 'HEAD') }

function copyHistoricalDependency(name: string, location: string, modules: string, lock: string, versions: Map<string, string>) {
  let directory = dirname(createRequire(location).resolve(name))
  let metadata: { name?: string; version?: string; dependencies?: Record<string, string> } = {}
  for (;;) {
    const packageFile = join(directory, 'package.json')
    if (existsSync(packageFile)) metadata = json(readFileSync(packageFile)) as typeof metadata
    if (metadata.name === name) break
    const parent = dirname(directory)
    if (parent === directory) return reject('无法定位历史验证依赖 ' + name)
    directory = parent
  }
  if (!metadata.version || !lock.includes('\n  ' + name + '@' + metadata.version + ':')) {
    return reject('历史验证依赖不在固定锁文件中 ' + name)
  }
  const previous = versions.get(name)
  if (previous && previous !== metadata.version) return reject('历史验证依赖版本冲突 ' + name)
  if (previous) return
  versions.set(name, metadata.version)
  cpSync(directory, join(modules, name), { recursive: true, dereference: true })
  for (const dependency of Object.keys(metadata.dependencies ?? {})) {
    copyHistoricalDependency(dependency, join(directory, 'package.json'), modules, lock, versions)
  }
}

export function assertG5History(root: string) {
  if (!hasG5History(root) || git(root, ['rev-parse','--is-shallow-repository']).toString('utf8').trim() !== 'false') {
    return reject('无法证明正式 G5 历史与当前候选的祖先关系')
  }
  for (const file of oldGatePaths) {
    const historic = trackedBlob(root, G5_SIGNED_COMMIT, file)
    if (!trackedBlob(root, 'HEAD', file).equals(historic)) return reject('历史门记录被改动或替换 ' + file)
  }
  const anchor = utf8.decode(trackedBlob(root, G5_SIGNED_COMMIT, 'docs/gates/G5.md'))
  if (!new RegExp('^- artifact_hash=' + PRIOR_GATE_HASH + '$', 'm').test(normalizedText(anchor))) return reject('上一签门工件锚已漂移')
  if (verifiedHistoryRoot === root) return
  withG6Scratch((directory) => {
    const target = join(directory, 'history')
    mkdirSync(target)
    git(target, ['init','--quiet'])
    const objects = git(root, ['rev-parse','--path-format=absolute','--git-path','objects']).toString('utf8').trim()
    writeFileSync(join(target, '.git','objects','info','alternates'), objects.replace(/\\/g, '/') + '\n', { flag: 'wx' })
    git(target, ['-c','core.hooksPath=.git/nohooks','-c','core.autocrlf=false','checkout','--detach',G5_SIGNED_COMMIT])
    const modules = resolve(process.env.DSH_G5_DEPENDENCIES ?? join(root, 'node_modules'))
    const installed = json(readFileSync(join(modules, 'markdown-it', 'package.json'))) as { version?: string }
    const historicalLock = utf8.decode(trackedBlob(root, G5_SIGNED_COMMIT, 'pnpm-lock.yaml'))
    const lockedVersion = /(^|\n)\s{6}markdown-it:\r?\n\s{8}specifier:[^\r\n]+\r?\n\s{8}version: ([^\r\n]+)/.exec(historicalLock)?.[2]
    if (!lockedVersion || installed.version !== lockedVersion) return reject('历史门验证依赖与固定历史构建不一致')
    const destination = join(target, 'node_modules')
    mkdirSync(destination)
    copyHistoricalDependency('markdown-it', join(dirname(modules), 'package.json'), destination, historicalLock, new Map())
    const outcome = spawnSync(process.execPath, ['--no-warnings', 'scripts/gate-check.ts', ...oldGatePaths],
      { cwd: target, encoding: 'utf8', timeout: 600_000, stdio: ['ignore','inherit','pipe'] })
    if (outcome.status !== 0) return reject('历史 G1–G5 核验失败：' + (outcome.stderr?.trim() || outcome.error?.message || outcome.status))
  })
  verifiedHistoryRoot = root
}

function expectClean(root: string) {
  if (git(root, ['status','--porcelain','--untracked-files=all']).length !== 0) return reject('G6 必须从干净且已提交的工作树核验')
}

function registryOf(root: string, candidate: string) {
  const registry = registrySchema.parse(json(trackedBlob(root, candidate, G6_REGISTRY_PATH)))
  const names = [registry.manifest, registry.isolated_ledger, registry.frozen_package, registry.install_receipt, ...registry.evidence.map((entry) => entry.file)]
  if (new Set(names).size !== names.length || !registry.frozen_package.endsWith('.tgz')
    || names.some((name) => !/^docs\/gates\/evidence\/G6\/[^.]/.test(name))) {
    return reject('G6 冻结输出必须逐文件有唯一证据路径')
  }
  return { registry, names }
}

export function g6Body(values: {
  candidate: string; evidence: string; audit: string; auditSha: string; approver: string; approval: string; independentHash: string; publicationHash: string
}) {
  const prefix = ['# G6 发布门记录', '', '结论：pass', '', 'candidate_commit=' + values.candidate,
    'evidence_commit=' + values.evidence, 'audit_commit=' + values.audit, 'audit_report_sha256=' + values.auditSha,
    'previous_artifact_hash=' + PRIOR_GATE_HASH, 'approver=' + values.approver, 'approved_at=' + values.approval,
    'independent_artifact_hash=' + values.independentHash, 'release_artifact_hash=' + values.publicationHash].join('\n') + '\n'
  const bodyHash = sha256Hex(prefix + 'body_hash=<SELF>\n')
  return { body: prefix + 'body_hash=' + bodyHash + '\n\n<!-- g6-appendices -->\n', bodyHash }
}

export function assertG6Body(text: string, expected: string) {
  const actual = normalizedText(text)
  if (!actual.startsWith(expected)) return reject('G6 正文锚前内容与重算结果不符')
  if (/^(?:(?:candidate_commit|evidence_commit|audit_commit|audit_report_sha256|previous_artifact_hash|approver|approved_at|independent_artifact_hash|release_artifact_hash|body_hash)=|结论[：:])/m
    .test(actual.slice(expected.length))) {
    return reject('G6 附记含治理锚点覆写')
  }
}

type AuditReader = (text: string) => 'pass' | 'fail' | null
export function assertG6R0Evidence(entries: readonly { source: string; file: string }[], blob: (file: string) => Uint8Array,
  expected: { candidate: string; archiveSha256: string; startedAt: string; endedAt: string }) {
  const sources = entries.filter(({ source }) => source.startsWith('r0-observation:'))
  const files = new Map(sources.map(({ source, file }) => [source, file]))
  if (sources.length !== R0_ORIGINALS.length || files.size !== sources.length || new Set(files.values()).size !== files.size
    || R0_ORIGINALS.some((name) => !files.has('r0-observation:' + name))) return reject('R0 机器观察原件缺失或来源重复')
  const observed = withG6Scratch((directory) => {
    for (const name of R0_ORIGINALS) {
      const target = join(directory, name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, blob(files.get('r0-observation:' + name)!), { flag: 'wx' })
    }
    return verifyR0Observation(directory, expected)
  })
  if (observed.from_utc !== expected.startedAt || observed.to_utc !== expected.endedAt) {
    return reject('R0 实际观察起止与具名批准不一致')
  }
}

function loadSignedInput(root: string, trust: G6TrustProvider, readConclusion: AuditReader, allowOutputs: boolean) {
  const tip = head(root)
  const packet = packetSchema.parse(json(trackedBlob(root, tip, G6_INPUT_PATH)))
  const C = packet.candidate_commit
  const E = packet.evidence_commit
  const A = packet.audit_commit
  if (new Set([G5_SIGNED_COMMIT, C, E, A, tip]).size !== 5
      || ![[G5_SIGNED_COMMIT,C],[C,E],[E,A],[A,tip]].every(([from, to]) => ancestor(root, from!, to!))) {
    return reject('G6 候选、冻结证据、独审和批准须是依次提交的独立事实')
  }
  if (packet.audit_report !== 'docs/audits/S6-independent-audit-round' + packet.audit_round + '.md') {
    return reject('G6 独审报告路径必须对应本轮')
  }
  const reportBytes = trackedBlob(root, A, packet.audit_report)
  const reportHash = sha256Hex(reportBytes)
  const report = utf8.decode(reportBytes)
  if (present(root, A + '^', packet.audit_report) || !trackedBlob(root, tip, packet.audit_report).equals(reportBytes)
    || readConclusion(report) !== 'pass' || report.split(VERDICT_BEGIN).length !== 2 || report.split(VERDICT_END).length !== 2) {
    return reject('独审报告不是当前候选的唯一已提交通过报告')
  }
  const verdict = parseAuditVerdict(report)
  if (!verdict || !('verdict' in verdict)) return reject('缺少 G6 结构化独审裁决')
  const problems = verdictProblems(verdict.verdict, { gate: 'G6', auditRound: packet.audit_round, commit: C, requiredItems: checks })
  if (problems.length) return reject(problems.join('；'))

  const { registry, names } = registryOf(root, C)
  const allowed = new Set([...names, packet.audit_report, G6_INPUT_PATH, ...(allowOutputs ? outputs : [])])
  const unexpected = changed(root, C, tip).filter((file) => !allowed.has(file))
  if (unexpected.length) return reject('冻结候选之后的未登记改动 ' + unexpected[0])
  const afterEvidence = new Set(changed(root, E, tip))
  if (afterEvidence.has(packet.audit_report) && changed(root, A, tip).includes(packet.audit_report)) {
    return reject('独审提交后报告被改动')
  }
  for (const file of names) {
    if (present(root, C, file) || afterEvidence.has(file) || !trackedBlob(root, E, file).equals(trackedBlob(root, tip, file))) {
      return reject('冻结证据已换绑或在审计后发生变化 ' + file)
    }
  }
  const blob = (file: string) => trackedBlob(root, E, file)
  const manifestBytes = blob(registry.manifest)
  const manifest = normalizeReleaseManifest(json(manifestBytes))
  const candidateScope = changed(root, G5_SIGNED_COMMIT, C)
  if (manifest.candidate.git_sha !== C || !sameSet(manifest.change_scope.touched_paths, candidateScope)
    || !sameSet(Object.keys(registry.items), manifest.items.map((item) => item.id))
    || !sameSet(Object.keys(registry.invariants), manifest.invariants.map((item) => item.id))) return reject('冻结清单与候选提交或必过范围不符')
  const expected = new Map(registry.evidence.map((entry) => [entry.evidence_id, entry]))
  if (expected.size !== registry.evidence.length || manifest.evidence.length !== expected.size
    || manifest.evidence.some(({ sha256, ...entry }) => releaseHash(entry) !== releaseHash(expected.get(entry.evidence_id) ?? null)
      || sha256Hex(blob(entry.file)) !== sha256)
    || manifest.items.some((item) => !sameSet(item.evidence_ids, registry.items[item.id] ?? []))
    || manifest.invariants.some((item) => !sameSet(item.evidence_ids, registry.invariants[item.id] ?? []))) {
    return reject('G6 证据映射和 Git 原始字节不一致')
  }

  const checkedWorkspace = trust.verifyProof(packet.workspace, 'workspace')
  const workspace = workspaceSchema.parse(packet.workspace.payload)
  const packageBytes = blob(registry.frozen_package)
  if (packageBytes[0] !== 0x1f || packageBytes[1] !== 0x8b || packageBytes[2] !== 8) return reject('登记的安装工件不是原始 .tgz')
  const ledgerBytes = blob(registry.isolated_ledger)
  const installBytes = blob(registry.install_receipt)
  const install = installSchema.parse(json(installBytes))
  if (checkedWorkspace.principal !== workspace.workspace || workspace.candidate_commit !== C || workspace.manifest_sha256 !== sha256Hex(manifestBytes)
    || workspace.run_id !== packet.run_id || workspace.package_sha256 !== sha256Hex(packageBytes) || workspace.ledger_sha256 !== sha256Hex(ledgerBytes)
    || workspace.install_sha256 !== sha256Hex(installBytes) || install.package_sha256 !== workspace.package_sha256
    || install.candidate_commit !== C || install.workspace !== workspace.workspace || Date.parse(install.installed_at) > Date.now()) {
    return reject('安装包、隔离安装、发布工作区或账本绑定不符')
  }
  const checkedAudit = trust.verifyProof(packet.audit, 'audit')
  const audit = auditSchema.parse(packet.audit.payload)
  if (checkedAudit.principal !== audit.principal || audit.candidate_commit !== C || audit.audit_commit !== A || audit.audit_sha256 !== reportHash
    || audit.manifest_sha256 !== workspace.manifest_sha256 || audit.audit_round !== packet.audit_round) return reject('独审身份与已提交报告绑定不符')
  const independentSigner = trust.verifyProof(packet.independent, 'independent')
  const independent = packet.independent.payload as { principal?: string; producer?: string; build_artifact_hash?: string } | null
  if (!independent || (independent.producer === 'human' && independent.principal !== independentSigner.principal)
    || (independent.producer === 's5_build' && independentSigner.principal !== 's5_build:' + trust.previous_installation_sha256)) {
    return reject('独立执行签署身份与实际执行者不符')
  }

  const validAuthority = trust.verifyProof(packet.approval, 'approval')
  const approval = approvalSchema.parse(packet.approval.payload)
  const roles = [validAuthority.principal, checkedAudit.principal, independentSigner.principal, checkedWorkspace.principal]
  if (new Set(roles).size !== roles.length || approval.principal !== validAuthority.principal || approval.candidate_commit !== C
    || approval.evidence_commit !== E || approval.audit_commit !== A || approval.previous_installation_sha256 !== trust.previous_installation_sha256
    || approval.audit_sha256 !== reportHash || approval.independent_receipt_hash !== releaseHash(packet.independent)
    || approval.workspace_receipt_hash !== releaseHash(packet.workspace) || approval.audit_receipt_hash !== releaseHash(packet.audit)
    || Date.parse(approval.approved_at) > Date.now() || Date.parse(approval.expires_at) <= Date.parse(approval.approved_at)
    || (!allowOutputs && Date.parse(approval.expires_at) <= Date.now())) return reject('G6 正式批准不具备有效身份、时限或绑定')
  if (Object.entries(approval.params).some(([parameter, { evidence_id, ...values }]) => {
    const source = expected.get(evidence_id)
    if (source?.source !== 'g6-parameter:' + parameter) return true
    const recorded = json(blob(source.file))
    return releaseHash(recorded) !== releaseHash({ schema: 'dsh-g6-parameter/1', candidate: C, parameter, values })
  })
    || Date.parse(approval.params.trial.r0_ended_at) - Date.parse(approval.params.trial.r0_started_at) < 72 * 60 * 60 * 1000
    || Date.parse(approval.params.trial.r0_ended_at) > Date.parse(approval.approved_at)) return reject('六项定值或 R0 连续观察没有完整证据')
  assertG6R0Evidence(registry.evidence, blob, { candidate: C, archiveSha256: workspace.package_sha256,
    startedAt: approval.params.trial.r0_started_at, endedAt: approval.params.trial.r0_ended_at })
  return { packet, manifest, blob, ledgerBytes, approval, reportHash, independent, packageSha: workspace.package_sha256 }
}

export function recomputeG6(root: string, opts: { verify: boolean; readConclusion: AuditReader; trust: G6TrustProvider }) {
  expectClean(root)
  const signingHead = head(root)
  const { trust } = opts
  assertG5History(root)
  const frozen = loadSignedInput(root, trust, opts.readConclusion, opts.verify)
  const { packet, manifest, blob, ledgerBytes, approval, reportHash, independent } = frozen
  const recomputed = trust.withLedger(ledgerBytes, (db, secret) => {
      if (db.raw.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') return reject('隔离发布账本未通过完整性检查')
      const input = { manifest, publication: createG6FileEvidenceReader((entry) => blob(entry.file), frozen.packageSha),
        independent: createG6FileEvidenceReader((entry) => blob(entry.file), frozen.packageSha) }
      const authority = { readReceipt: () => independent, isSignedS5Build: (digest: string) => digest === trust.previous_installation_sha256 }
      const artifacts = sealReleasePair({ db, secret, runId: packet.run_id, expectedDefinitionHash: releaseDefinitionHash, input, authority }, (prepared) => {
        if (releaseHash(prepared.publication) !== approval.publication_body_hash
          || releaseHash(prepared.independent) !== approval.independent_body_hash) return reject('批准所绑定的双份待封存工件已改变')
        const governance = approval.governance as { publication: ReleaseGovernance; independent: ReleaseGovernance }
        for (const record of [governance.publication, governance.independent]) {
          if (record.audit_round !== packet.audit_round || record.audit_report !== packet.audit_report
            || record.audit_report_sha256 !== reportHash) return reject('正式工件治理记录与具名批准不符')
        }
        if (governance.publication.approver !== approval.principal || governance.publication.approved_at !== approval.approved_at
          || (governance.independent.approver === approval.principal
            ? governance.independent.approved_at !== approval.approved_at
            : prepared.independent_source.producer !== 'human'
              || governance.independent.approver !== prepared.independent_source.principal
              || Date.parse(governance.independent.approved_at) > Date.parse(approval.approved_at))) {
          return reject('发布与独立工件批准来源不符')
        }
        return governance
      })
      const body = g6Body({ candidate: packet.candidate_commit, evidence: packet.evidence_commit, audit: packet.audit_commit, auditSha: reportHash,
        approver: approval.principal, approval: approval.approved_at,
        independentHash: artifacts.comparison.independent_hash, publicationHash: artifacts.comparison.publication_hash })
      return { ...body, artifacts, evidenceCount: manifest.evidence.length }
  })
  if (head(root) !== signingHead) return reject('核验期间 HEAD 发生变化，请重新核对冻结候选')
  expectClean(root)
  return { ...recomputed, signingHead }
}

export async function verifyG6(root: string, readConclusion: AuditReader) {
  expectClean(root)
  const out = recomputeG6(root, { verify: true, readConclusion, trust: await resolveTrust(root) })
  assertG6Body(utf8.decode(trackedBlob(root, out.signingHead, G6_GATE_PATH)), out.body)
  for (const [file, artifact] of [[G6_INDEPENDENT_PATH, out.artifacts.independent], [G6_PUBLICATION_PATH, out.artifacts.publication]] as const) {
    if (releaseHash(json(trackedBlob(root, out.signingHead, file))) !== releaseHash(artifact)) return reject('提交的双份工件与核验结果不一致 ' + file)
  }
  return out
}

export async function signG6(root: string, readConclusion: AuditReader) {
  if (outputs.some((file) => existsSync(join(root, file)))) return reject('G6 工件已存在，不能覆盖既有收口记录')
  expectClean(root)
  const out = recomputeG6(root, { verify: false, readConclusion, trust: await resolveTrust(root) })
  const created: string[] = []
  try {
    for (const [file, content] of [
      [G6_INDEPENDENT_PATH, JSON.stringify(out.artifacts.independent, null, 2) + '\n'],
      [G6_PUBLICATION_PATH, JSON.stringify(out.artifacts.publication, null, 2) + '\n'],
      [G6_GATE_PATH, out.body],
    ] as const) {
      const destination = join(root, file)
      writeFileSync(destination, content, { flag: 'wx' })
      created.push(destination)
    }
  } catch (error) {
    for (const file of created) unlinkSync(file)
    throw error
  }
  return out
}
