import { z } from 'zod'
import { sha256Hex } from './canonical.ts'
import { OrchError } from './errors.ts'
import type { MustPassItem } from './gate-artifact.ts'

export const RELEASE_WORKFLOW_ID = 'wf_release_v1'
export const RELEASE_CHECK_WORKFLOW_ID = 'wf_gate_check_v1'
export const RELEASE_COORDINATOR_ID = 'gate_coordinator'
export const RELEASE_VERSION = '1'
export function isReleaseWorkflow(workflowId: string | undefined) {
  return workflowId === RELEASE_WORKFLOW_ID || workflowId === RELEASE_CHECK_WORKFLOW_ID
}
export const RELEASE_GROUPS = {
  migration_recovery: ['G-01', 'G-02', 'G-07', 'G-13', 'G-14', 'G-15', 'upgrade', 'load_rollback'],
  single_node: ['G-03', 'G-04', 'G-05', 'G-06'],
  state_concurrency: ['G-08', 'G-12', 'G-16'],
  version_publication: ['G-10'],
  panel_memory: ['G-09', 'G-11'],
  performance_safety: ['control_p95', 'event_lag', 'soak_24h', 'oncall_drill'],
} as const
export const RELEASE_ITEMS = Object.values(RELEASE_GROUPS).flat()
export const RELEASE_INVARIANTS = Array.from({ length: 10 }, (_, index) => 'I' + (index + 1))
export type ReleaseGroup = keyof typeof RELEASE_GROUPS
export type ReleaseItem = typeof RELEASE_ITEMS[number]

const identifier = z.string().trim().min(1).max(128)
const validUnicode = (value: string) => !/[\uD800-\uDFFF]/u.test(value)
const relativePath = z.string().min(1).max(512).refine((path) => validUnicode(path)
  && !/[\\:\x00-\x1f]/.test(path) && path.split('/').every((segment) => segment && segment !== '.' && segment !== '..'))
const sha256 = z.string().regex(/^[0-9a-f]{64}$/).refine((value) => !/^0+$/.test(value))
const gitSha = z.string().regex(/^[0-9a-f]{40}$/).refine((value) => !/^0+$/.test(value))
const candidate = z.strictObject({ git_sha: gitSha, schema_version: z.literal(1), phase: z.literal('S6') })
const evidenceEntry = z.strictObject({ evidence_id: identifier, sha256, strength: z.enum(['strong','weak']), source: identifier, file: relativePath })
const binding = z.strictObject({ id: z.enum(RELEASE_ITEMS), evidence_ids: z.array(identifier).min(1).max(64) })
const invariant = z.strictObject({ id: z.enum(RELEASE_INVARIANTS), method: identifier, evidence_ids: z.array(identifier).min(1).max(64) })
const manifest = z.strictObject({
  candidate, change_scope: z.strictObject({ capability_ids: z.array(identifier).min(1).max(1000), touched_paths: z.array(relativePath).min(1).max(10000) }),
  evidence: z.array(evidenceEntry).min(1).max(1000), items: z.array(binding).length(RELEASE_ITEMS.length),
  invariants: z.array(invariant).length(RELEASE_INVARIANTS.length),
})
export type FrozenReleaseManifest = z.infer<typeof manifest>
export type ReleaseEvidenceEntry = z.infer<typeof evidenceEntry>

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new OrchError('PAYLOAD_SCHEMA_INVALID', message, details)
}

function unicodeOrder(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function canonicalReleaseJson(value: unknown): string {
  if (typeof value === 'string' && !validUnicode(value)) return invalid('G6 原像包含无效 Unicode')
  if (typeof value === 'number' && !Number.isFinite(value)) return invalid('G6 原像包含非有限数值')
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (typeof value !== 'object') return invalid('G6 原像包含不可序列化字段')
  if (Array.isArray(value)) return '[' + value.map(canonicalReleaseJson).join(',') + ']'
  const row = value as Record<string, unknown>
  return '{' + Object.keys(row).sort(unicodeOrder).map((key) => canonicalReleaseJson(key) + ':' + canonicalReleaseJson(row[key])).join(',') + '}'
}

export function releaseHash(value: unknown) {
  return sha256Hex(canonicalReleaseJson(value))
}

function orderedSet(values: readonly string[]) {
  if (values.some((value) => !validUnicode(value)) || new Set(values).size !== values.length) return invalid('G6 清单包含重复或无效标识')
  return [...values].sort(unicodeOrder)
}

function orderedRows<T>(values: readonly T[], getId: (value: T) => string) {
  orderedSet(values.map(getId))
  return [...values].sort((left, right) => unicodeOrder(getId(left), getId(right)))
}

export function normalizeReleaseManifest(input: unknown): FrozenReleaseManifest {
  const parsed = manifest.safeParse(input)
  if (!parsed.success) return invalid('G6 冻结清单缺项或结构无效')
  const { candidate, change_scope, evidence, items, invariants } = parsed.data
  const entries = orderedRows(evidence, (entry) => entry.evidence_id)
  orderedSet(entries.map((entry) => entry.file))
  const expected = new Set(entries.map((entry) => entry.evidence_id))
  const used = new Set<string>()
  const withEvidence = <T extends { evidence_ids: string[] }>(row: T): T => {
    const evidence_ids = orderedSet(row.evidence_ids)
    for (const id of evidence_ids) {
      if (!expected.has(id)) invalid('G6 条目指向清单外证据', { evidence_id: id })
      used.add(id)
    }
    return { ...row, evidence_ids }
  }
  const mustPass = orderedRows(items, (item) => item.id).map(withEvidence)
  const invariantRows = orderedRows(invariants, (item) => item.id).map(withEvidence)
  if (used.size !== expected.size) return invalid('G6 冻结清单包含未登记用途的证据')
  return { candidate, change_scope: { capability_ids: orderedSet(change_scope.capability_ids), touched_paths: orderedSet(change_scope.touched_paths) },
    evidence: entries, items: mustPass, invariants: invariantRows }
}

const zero = z.literal(0)
const milliseconds = z.number().finite().nonnegative()
const faultReceipt = z.strictObject({ kind: z.literal('fault'), exit_code: zero,
  injection: z.literal(true), before_ledger: z.literal(true), after_ledger: z.literal(true), reconciled: z.literal(true) })
const observation = z.discriminatedUnion('kind', [
  faultReceipt,
  z.strictObject({ kind: z.literal('control_p95'), list_tasks_rows: z.number().int().min(10_000), list_tasks_ms: milliseconds.lt(100),
    get_run_nodes: z.number().int().min(1000), get_run_ms: milliseconds.lt(150), list_nodes_rows: z.number().int().min(200),
    list_nodes_ms: milliseconds.lt(80), list_events_rows: z.number().int().min(200), list_events_ms: milliseconds.lt(50) }),
  z.strictObject({ kind: z.literal('event_lag'), windows: z.array(z.strictObject({
    p95_ms: milliseconds.max(2000), max_ms: milliseconds.max(10000), samples: z.number().int().positive(),
  })).min(1).max(10000) }).refine(({ windows }) => windows.every((window) => window.p95_ms <= window.max_ms)),
  z.strictObject({ kind: z.literal('soak_24h'), duration_ms: milliseconds.min(86_400_000), samples: z.number().int().min(2880),
    orphaned: zero, unsettled: zero, leaks: zero, rss_growth: z.literal(false), wal_growth: z.literal(false),
    p95_ms: milliseconds.max(2000), max_ms: milliseconds.max(10000) }).refine(({ p95_ms, max_ms }) => p95_ms <= max_ms),
  z.strictObject({ kind: z.literal('upgrade'), previous_build: sha256, healthy: z.literal(true), ledger_replayed: z.literal(true) }),
  z.strictObject({ kind: z.literal('load_rollback'), previous_build: sha256, under_load: z.literal(true), old_reads_new: z.literal(true),
    new_reads_old: z.literal(true), ledger_replayed: z.literal(true) }),
  z.strictObject({ kind: z.literal('oncall_drill'), acknowledged_by: z.string().regex(/^human:.+/), rollback_verified: z.literal(true) }),
  z.strictObject({ kind: z.literal('invariant'), id: z.enum(RELEASE_INVARIANTS), method: identifier, result: z.literal('pass') }),
])
export type ReleaseObservation = z.infer<typeof observation>

/** Host plumbing must resolve each evidence ID to the frozen bytes and re-derive the check from the original source. */
export type ReleaseEvidenceReader = {
  read(entry: ReleaseEvidenceEntry): Uint8Array | undefined
  observe(request: { id: string; candidate: FrozenReleaseManifest['candidate'];
    evidence: readonly { entry: ReleaseEvidenceEntry; bytes: Uint8Array }[] }): unknown
}

export type ReleasePolicyResult = ReturnType<typeof judgeReleaseEvidence>
export function judgeReleaseEvidence(input: unknown, reader: ReleaseEvidenceReader) {
  const frozen = normalizeReleaseManifest(input)
  const byId = new Map<string, { entry: ReleaseEvidenceEntry; bytes: Uint8Array }>()
  for (const entry of frozen.evidence) {
    const raw = reader.read(entry)
    const bytes = raw && new Uint8Array(raw)
    if (bytes && entry.strength === 'strong' && entry.sha256 === sha256Hex(Buffer.from(bytes))) byId.set(entry.evidence_id, { entry, bytes })
  }
  function observe(id: string, evidenceIds: string[]) {
    const evidence = evidenceIds.flatMap((entry) => byId.get(entry) ?? [])
    if (evidence.length !== evidenceIds.length) return undefined
    const response = observation.safeParse(reader.observe({ id, candidate: frozen.candidate, evidence }))
    return response.success ? response.data : undefined
  }
  const must_pass_items: MustPassItem[] = frozen.items.map(({ id, evidence_ids }) => {
    const expected = id.startsWith('G-') ? 'fault' : id
    return { id, evidence_ids, result: observe(id, evidence_ids)?.kind === expected ? 'pass' : 'fail' }
  })
  const invariants = frozen.invariants.map(({ id, method, evidence_ids }) => {
    const result = observe(id, evidence_ids)
    return { id, method, result: result?.kind === 'invariant' && result.id === id && result.method === method ? 'pass' : 'fail' }
  })
  const conclusion: 'pass' | 'fail' = must_pass_items.every((item) => item.result === 'pass') && invariants.every((item) => item.result === 'pass') ? 'pass' : 'fail'
  const evidence_index = frozen.evidence.map(({ evidence_id, sha256, strength, source }) => ({ evidence_id, sha256, strength, source }))
  return { candidate_hash: releaseHash(frozen.candidate), change_scope_hash: releaseHash(frozen.change_scope),
    evidence_index_hash: releaseHash({ evidence_index }), invariants_hash: releaseHash({ invariants }),
    manifest_hash: releaseHash(frozen), must_pass_items, invariants, conclusion }
}
