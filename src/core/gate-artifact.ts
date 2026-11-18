// G5 门闸工件：类型、结论推导与哈希原像。
// 哈希口径以 scripts/gate-check.ts 的门检查实现为权威（脚本第 6-10 行口径注释、683-692 行 candidateEntries、
// 723 行证据索引、765 行不变量、900-910 行正文自锚、2898-2899 行候选与改动清单、2984 行工件自锚）：
//   candidate_hash      = SHA256(canonical_json([{path, sha256}]，按 path 升序))
//   change_scope_hash   = SHA256(canonical_json([path ...]，按升序))
//   evidence_index_hash = SHA256(canonical_json([{id, file, sha256}]，按 id 升序))
//   invariants_hash     = SHA256(canonical_json([{id, statement, evidence_ids}]，按 id 升序))
//   body_hash           = SHA256(bodyHashInput(text))
//   artifact_hash       = SHA256(canonical_json(artifact))
// 工件字段与脚本 GATE_FIELDS（第 27-32 行）的 20 项一一对应；工件内不放 record_hash / artifact_hash 自指字段。
import { canonicalJson, sha256Hex } from './canonical.ts'
import { OrchError } from './errors.ts'

/** 必过项：结论 + 指向的证据 id。 */
export type MustPassItem = {
  id: string
  result: 'pass' | 'fail'
  evidence_ids: string[]
}

/** 例外项：门检查要求 code / type(proposed|accepted) / status(4xx-5xx) / note 齐全。 */
export type GateException = {
  code: string
  type: 'proposed' | 'accepted'
  status: number
  note: string
}

/** 回滚方案：脚本接受 duration_s 或 max_seconds，verification 或 verify。 */
export type GateRollback = {
  target: string
  action: string
  duration_s?: number
  max_seconds?: number
  verification?: string
  verify?: string
}

/** 门闸工件：字段固定为 GATE_FIELDS 的 20 项；不含 record_hash / artifact_hash 自指字段。 */
export type GateArtifact = {
  gate: string
  schema_version: 1
  gate_run_id: string | null
  candidate_hash: string
  change_scope_hash: string
  evidence_index_hash: string
  invariants_hash: string
  must_pass_items: MustPassItem[]
  failed_items: string[]
  conclusion: 'pass' | 'fail'
  run_terminal: string
  exceptions: GateException[]
  rollback: GateRollback
  approver: string
  approved_at: string
  producer: string
  previous_artifact_hash: string | null
  audit_round: number
  audit_report: string
  audit_report_sha256: string
}

/** 无 run 的门（G1-G5 人工门）：gate_run_id=null、run_terminal=not_applicable、producer=human。 */
export const NO_RUN_GATE = {
  gate_run_id: null,
  run_terminal: 'not_applicable',
  producer: 'human',
} as const

/** 工件里禁止出现的自指哈希字段（artifact_hash 是正文锚点，不能进工件）。 */
const SELF_REFERENTIAL_FIELDS = ['record_hash', 'artifact_hash'] as const

/** buildGateArtifact 的入参：结论与失败清单由函数推导，调用方不传。 */
export type GateArtifactInput = Omit<GateArtifact, 'conclusion' | 'failed_items'>

/**
 * 推导门闸结论：failed_items = 必过项里 result 不是 pass 的 id；
 * conclusion 当且仅当 failed_items 为空且 run_terminal 不是 failed 时才是 pass。
 */
export function buildGateArtifact(input: GateArtifactInput): GateArtifact {
  for (const field of SELF_REFERENTIAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'GateArtifact 里不能放自指哈希字段: ' + field, {
        field,
      })
    }
  }
  const failed_items = input.must_pass_items
    .filter((item) => item.result !== 'pass')
    .map((item) => item.id)
  const conclusion: GateArtifact['conclusion'] =
    failed_items.length === 0 && input.run_terminal !== 'failed' ? 'pass' : 'fail'
  return { ...input, failed_items, conclusion }
}

/** 候选文件条目：与脚本 candidateEntries 的 files 元素同形。 */
export type CandidateFile = { path: string; sha256: string }

/** 证据索引条目：与脚本 evidence-index 块里的 {id, file, sha256} 同形。 */
export type EvidenceIndexEntry = { id: string; file: string; sha256: string }

/** 不变量条目：与脚本 invariants 块里的 {id, statement, evidence_ids} 同形。 */
export type InvariantEntry = { id: string; statement: string; evidence_ids: string[] }

function byKey<T>(list: readonly T[], key: (item: T) => string): T[] {
  return [...list].sort((a, b) => {
    const left = key(a)
    const right = key(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/** 候选哈希原像：[{path, sha256}] 按 path 升序（脚本第 2898 行）。 */
export function candidateHashOf(files: readonly CandidateFile[]): string {
  return sha256Hex(canonicalJson(byKey(files, (file) => file.path)))
}

/** 变更范围哈希原像：[path ...] 去重升序（脚本第 2899 行）。 */
export function changeScopeHashOf(paths: readonly string[]): string {
  return sha256Hex(canonicalJson([...new Set(paths)].sort()))
}

/** 证据索引哈希原像：[{id, file, sha256}] 按 id 升序（脚本第 723 行）。 */
export function evidenceIndexHashOf(entries: readonly EvidenceIndexEntry[]): string {
  return sha256Hex(canonicalJson(byKey(entries, (entry) => entry.id)))
}

/** 不变量哈希原像：[{id, statement, evidence_ids}] 按 id 升序（脚本第 765 行）。 */
export function invariantsHashOf(invariants: readonly InvariantEntry[]): string {
  return sha256Hex(canonicalJson(byKey(invariants, (item) => item.id)))
}

/** 正文自锚归一：与脚本 bodyHashInput 同一口径（脚本第 900-906 行）。 */
export function bodyHashInput(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/artifact_hash=[0-9a-f]{64}/g, 'artifact_hash=<SELF>')
    .replace(/body_hash=[0-9a-f]{64}/g, 'body_hash=<SELF>')
    .replace(/`[0-9a-f]{64}`/g, '`<SELF>`')
}

/** 正文哈希：SHA256(bodyHashInput(text))（脚本第 908-910 行）。 */
export function bodyHashOf(text: string): string {
  return sha256Hex(bodyHashInput(text))
}

/** 工件自身锚点哈希：SHA256(canonical_json(artifact))（脚本第 2984 行）。 */
export function artifactHashOf(artifact: GateArtifact): string {
  return sha256Hex(canonicalJson(artifact))
}
