// G5 门闸基础设施：G5 规格结构断言 + GateArtifact 结论推导 + 哈希口径对拍 + 阶段闸断言。
// 规格口径：docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md
//   §11.2 行 951（G5 必过清单口径）、§11.3 行 955-987（GateArtifact 与结论规则）；
//   docs/superpowers/plans/2026-11-12-dsh-orchestra-s5-panel-memory.md Task16 行 2212-2325。
// 哈希口径以 scripts/gate-check.ts 的门检查实现为权威，本文件逐一对拍。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_GATE_PATHS,
  GATE_FIELDS,
  GATE_SPECS,
  bodyHash,
  bodyHashInput,
  candidateEntries,
} from '../../scripts/gate-check.ts';
import {
  artifactHashOf,
  bodyHashInput as moduleBodyHashInput,
  bodyHashOf,
  buildGateArtifact,
  candidateHashOf,
  changeScopeHashOf,
  evidenceIndexHashOf,
  invariantsHashOf,
  NO_RUN_GATE,
  type GateArtifactInput,
} from '../../src/core/gate-artifact.ts';
import { PHASE_CAPABILITIES, requireCapability } from '../../src/core/config.ts';
import { canonicalJson, sha256Hex } from '../../src/core/canonical.ts';
import { OrchError } from '../../src/core/errors.ts';

const qMain = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => 'Q-' + String(from + i).padStart(2, '0'));

// 规格 §11.2 行 951 的全量口径：Q-01..Q-36、Q-43..Q-63（含 43b/43c/44b/44c/47b/52b）、
// 两个视口、三条字号与对比度、记忆部分写入可对账、S5 不提供 release、G-06/G-11/G-12。
const EXPECTED_G5_ITEMS: string[] = [
  ...qMain(1, 36),
  'Q-43', 'Q-43b', 'Q-43c', 'Q-44', 'Q-44b', 'Q-44c',
  ...qMain(45, 47), 'Q-47b',
  ...qMain(48, 52), 'Q-52b',
  ...qMain(53, 63),
  'G5-VIEWPORT-NARROW', 'G5-VIEWPORT-WIDE', 'G5-FONT-BODY', 'G5-FONT-MENU',
  'G5-CONTRAST-LIGHT', 'G5-MEMORY-RECONCILE', 'G5-PHASE-RELEASE',
  'G-06', 'G-11', 'G-12',
];

const g5 = GATE_SPECS['G5']!;

describe('G5 门规格注册（scripts/gate-check.ts）', () => {
  it('G5 必过清单就是规格 §11.2 的全量口径，含 Q-52b 与六个子项', () => {
    expect(g5).toBeTruthy();
    expect(g5.items).toEqual(EXPECTED_G5_ITEMS);
    expect(g5.items).toContain('Q-52b');
    for (const sub of ['Q-43b', 'Q-43c', 'Q-44b', 'Q-44c', 'Q-47b', 'Q-52b']) {
      expect(g5.items).toContain(sub);
    }
    for (const injection of ['G-06', 'G-11', 'G-12']) {
      expect(g5.items).toContain(injection);
    }
    for (const id of [
      'G5-VIEWPORT-NARROW', 'G5-VIEWPORT-WIDE', 'G5-FONT-BODY', 'G5-FONT-MENU',
      'G5-CONTRAST-LIGHT', 'G5-MEMORY-RECONCILE', 'G5-PHASE-RELEASE',
    ]) {
      expect(g5.items).toContain(id);
    }
    // 清单里不夹带规格外的项
    expect(g5.items.filter((id) => !EXPECTED_G5_ITEMS.includes(id))).toEqual([]);
  });

  it('每条必过项都有一句中文判定语', () => {
    for (const id of g5.items) {
      const text = g5.content[id];
      expect(text, '缺判定语: ' + id).toBeTruthy();
      expect(text).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it('items / content / evidenceMap / evidenceFiles 一一对应', () => {
    const itemIds = [...g5.items].sort();
    expect(Object.keys(g5.content).sort()).toEqual(itemIds);
    expect(Object.keys(g5.evidenceMap).sort()).toEqual(itemIds);

    const allEvidence = g5.items.flatMap((id) => g5.evidenceMap[id] ?? []);
    expect(allEvidence.length).toBe(g5.items.length);
    expect(new Set(allEvidence).size).toBe(allEvidence.length);
    expect(Object.keys(g5.evidenceFiles).sort()).toEqual([...new Set(allEvidence)].sort());

    for (const id of g5.items) {
      const evidenceIds = g5.evidenceMap[id] ?? [];
      expect(evidenceIds.length).toBeGreaterThan(0);
      for (const evidenceId of evidenceIds) {
        expect(g5.evidenceFiles[evidenceId]).toBe('docs/gates/evidence/G5/' + id + '.md');
      }
    }
  });

  it('不变量至少三条，语句是中文，证据都已在 evidenceFiles 里声明', () => {
    const invariants = Object.values(g5.invariants);
    expect(invariants.length).toBeGreaterThanOrEqual(3);
    const declared = new Set(Object.keys(g5.evidenceFiles));
    for (const one of invariants) {
      expect(one.statement.length).toBeGreaterThan(0);
      expect(one.statement).toMatch(/[\u4e00-\u9fa5]/);
      expect(one.evidence_ids.length).toBeGreaterThan(0);
      for (const evidenceId of one.evidence_ids) {
        expect(declared.has(evidenceId)).toBe(true);
      }
    }
  });

  it('G5 门元数据固定：scopeBase / prevGate / gateFile / requireVerdict / excludes', () => {
    expect(g5.scopeBase).toBe('6d4ca1a');
    expect(g5.prevGate).toBe('G4');
    expect(g5.gateFile).toBe('docs/gates/G5.md');
    expect(g5.requireVerdict).toBe(true);
    for (const gate of ['G1', 'G2', 'G3', 'G4', 'G5']) {
      expect(g5.excludes).toContain('docs/gates/' + gate + '.md');
    }
  });

  it('默认门列表仍只有 G1-G4，G1-G4 规格逐字段未变', () => {
    expect(DEFAULT_GATE_PATHS).toEqual([
      'docs/gates/G1.md',
      'docs/gates/G2.md',
      'docs/gates/G3.md',
      'docs/gates/G4.md',
    ]);
    const pinned: Record<string, { scopeBase: string; prevGate: string | null; gateFile: string; requireVerdict: boolean }> = {
      G1: { scopeBase: '623939d4c0a7123835b525287035588ee291ccbe', prevGate: null, gateFile: 'docs/gates/G1.md', requireVerdict: true },
      G2: { scopeBase: '4f3ada7', prevGate: 'G1', gateFile: 'docs/gates/G2.md', requireVerdict: true },
      G3: { scopeBase: 'c296d72', prevGate: 'G2', gateFile: 'docs/gates/G3.md', requireVerdict: true },
      G4: { scopeBase: '9fbecdd', prevGate: 'G3', gateFile: 'docs/gates/G4.md', requireVerdict: true },
    };
    for (const [gate, fields] of Object.entries(pinned)) {
      const spec = GATE_SPECS[gate]!;
      expect(spec.scopeBase, gate).toBe(fields.scopeBase);
      expect(spec.prevGate, gate).toBe(fields.prevGate);
      expect(spec.gateFile, gate).toBe(fields.gateFile);
      expect(spec.requireVerdict, gate).toBe(fields.requireVerdict);
    }
    expect(GATE_SPECS['G1']!.items).toEqual([
      'G1-01', 'G1-02', 'G1-03', 'G1-04', 'G1-05', 'G1-06', 'G1-07',
      'G-01', 'G-02', 'G-08', 'G-09', 'G-14', 'G-15',
    ]);
    expect(GATE_SPECS['G4']!.items).toEqual([
      'G4-01', 'G4-02', 'G4-03', 'G4-04', 'G4-05', 'G4-06', 'G4-07', 'G4-08',
      'G4-09', 'G4-10', 'G4-11', 'G4-12', 'G4-13', 'G-10',
    ]);
  });
});

const baseInput = (over: Partial<GateArtifactInput> = {}): GateArtifactInput => ({
  gate: 'G5',
  schema_version: 1,
  gate_run_id: null,
  candidate_hash: candidateHashOf([{ path: 'src/core/gate-artifact.ts', sha256: 'a'.repeat(64) }]),
  change_scope_hash: changeScopeHashOf(['src/core/gate-artifact.ts', 'scripts/gate-check.ts']),
  evidence_index_hash: evidenceIndexHashOf([
    { id: 'ev-g5-q-01', file: 'docs/gates/evidence/G5/Q-01.md', sha256: 'b'.repeat(64) },
  ]),
  invariants_hash: invariantsHashOf([
    { id: 'I1', statement: '面板读模型与命令层口径一致', evidence_ids: ['ev-g5-q-01'] },
  ]),
  must_pass_items: [{ id: 'Q-01', result: 'pass', evidence_ids: ['ev-g5-q-01'] }],
  run_terminal: 'not_applicable',
  exceptions: [],
  rollback: { target: 'HEAD~1', action: 'revert', duration_s: 60, verification: 'pnpm typecheck' },
  approver: 'human:lead',
  approved_at: '2026-11-18T00:00:00.000Z',
  producer: 'human',
  previous_artifact_hash: 'f3ce1d1f083ae74c6018bfc9539b5c80e35d1e23de9427dd0ff401baa7a03a79',
  audit_round: 3,
  audit_report: 'docs/audits/S5-independent-audit-round1.md',
  audit_report_sha256: 'c'.repeat(64),
  ...over,
});

describe('GateArtifact 结论推导（src/core/gate-artifact.ts）', () => {
  it('必过项里有一条 fail：结论是 fail，failed_items 记下这条 id', () => {
    const artifact = buildGateArtifact(
      baseInput({
        must_pass_items: [
          { id: 'Q-01', result: 'pass', evidence_ids: ['ev-g5-q-01'] },
          { id: 'Q-52b', result: 'fail', evidence_ids: ['ev-g5-q-52b'] },
        ],
      }),
    );
    expect(artifact.conclusion).toBe('fail');
    expect(artifact.failed_items).toEqual(['Q-52b']);
  });

  it('全 pass 的无 run 门：结论是 pass，failed_items 为空', () => {
    const artifact = buildGateArtifact(baseInput());
    expect(artifact.conclusion).toBe('pass');
    expect(artifact.failed_items).toEqual([]);
  });

  it('run_terminal 是 failed 时，即使必过项全过结论也是 fail', () => {
    const artifact = buildGateArtifact(baseInput({ run_terminal: 'failed' }));
    expect(artifact.conclusion).toBe('fail');
    expect(artifact.failed_items).toEqual([]);
  });

  it('无 run 的门三字段固定：gate_run_id=null、run_terminal=not_applicable、producer=human', () => {
    const artifact = buildGateArtifact(baseInput());
    expect(artifact.gate_run_id).toBeNull();
    expect(artifact.run_terminal).toBe('not_applicable');
    expect(artifact.producer).toBe('human');
    expect(NO_RUN_GATE).toEqual({ gate_run_id: null, run_terminal: 'not_applicable', producer: 'human' });
  });

  it('前序链与审计三字段原样保留：previous_artifact_hash / audit_round / audit_report / audit_report_sha256', () => {
    const artifact = buildGateArtifact(baseInput());
    expect(artifact.previous_artifact_hash).toBe('f3ce1d1f083ae74c6018bfc9539b5c80e35d1e23de9427dd0ff401baa7a03a79');
    expect(artifact.audit_round).toBe(3);
    expect(artifact.audit_report).toBe('docs/audits/S5-independent-audit-round1.md');
    expect(artifact.audit_report_sha256).toBe('c'.repeat(64));
  });

  it('工件里不放 record_hash / artifact_hash 自指字段', () => {
    const artifact = buildGateArtifact(baseInput());
    expect(Object.keys(artifact)).not.toContain('record_hash');
    expect(Object.keys(artifact)).not.toContain('artifact_hash');
    expect(JSON.stringify(artifact)).not.toContain('"artifact_hash":');
    expect(JSON.stringify(artifact)).not.toContain('"record_hash":');
    expect(() =>
      buildGateArtifact({ ...baseInput(), record_hash: 'x' } as unknown as GateArtifactInput),
    ).toThrow(OrchError);
    try {
      buildGateArtifact({ ...baseInput(), artifact_hash: 'x' } as unknown as GateArtifactInput);
      throw new Error('这里本该抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(OrchError);
      expect((err as OrchError).code).toBe('PAYLOAD_SCHEMA_INVALID');
    }
  });
});

describe('哈希原像（门检查脚本口径）', () => {
  it('候选哈希按 [{path, sha256}] 取原像并按 path 升序归一', () => {
    const first = { path: 'src/a.ts', sha256: 'a'.repeat(64) };
    const second = { path: 'src/b.ts', sha256: 'b'.repeat(64) };
    expect(candidateHashOf([second, first])).toBe(sha256Hex(canonicalJson([first, second])));
    expect(candidateHashOf([second, first])).toBe(candidateHashOf([first, second]));
  });

  it('变更范围哈希按 path 去重升序', () => {
    expect(changeScopeHashOf(['src/b.ts', 'src/a.ts', 'src/b.ts'])).toBe(changeScopeHashOf(['src/a.ts', 'src/b.ts']));
    expect(changeScopeHashOf(['src/a.ts'])).not.toBe(changeScopeHashOf(['src/a.ts', 'src/b.ts']));
  });

  it('证据索引哈希按 id 升序', () => {
    const first = { id: 'ev-g5-q-01', file: 'docs/gates/evidence/G5/Q-01.md', sha256: 'a'.repeat(64) };
    const second = { id: 'ev-g5-q-02', file: 'docs/gates/evidence/G5/Q-02.md', sha256: 'b'.repeat(64) };
    expect(evidenceIndexHashOf([second, first])).toBe(evidenceIndexHashOf([first, second]));
    expect(evidenceIndexHashOf([second, first])).toBe(sha256Hex(canonicalJson([first, second])));
  });

  it('不变量哈希按 id 升序', () => {
    const first = { id: 'I1', statement: '口径一致', evidence_ids: ['ev-g5-q-01'] };
    const second = { id: 'I2', statement: '记忆写入受约束', evidence_ids: ['ev-g5-q-52'] };
    expect(invariantsHashOf([second, first])).toBe(invariantsHashOf([first, second]));
    expect(invariantsHashOf([second, first])).toBe(sha256Hex(canonicalJson([first, second])));
  });

  it('正文哈希先把自锚归一再取 SHA256', () => {
    const text = 'artifact_hash=' + 'f'.repeat(64) + '\r\nbody_hash=' + 'a'.repeat(64) + '\r\n`' + 'b'.repeat(64) + '`\r\n';
    expect(bodyHashOf(text)).toBe(sha256Hex(bodyHashInput(text)));
    expect(bodyHashOf(text)).not.toBe(sha256Hex(text));
    expect(bodyHashOf(text)).toBe(bodyHashOf(text.replace(/\r\n/g, '\n')));
  });

  it('artifact_hash = SHA256(canonical_json(artifact))', () => {
    const artifact = buildGateArtifact(baseInput());
    expect(artifactHashOf(artifact)).toBe(sha256Hex(canonicalJson(artifact)));
  });
});

describe('哈希口径对拍（scripts/gate-check.ts ↔ src/core/gate-artifact.ts）', () => {
  // 这个用例要对候选集里每个文件跑一次 git show，串行子进程多；全量并发跑时默认 5 秒会超时
  it('G5 真实候选清单：candidate_hash 与 change_scope_hash 两边一致', () => {
    const { paths, files } = candidateEntries(process.cwd(), g5);
    expect(paths.length).toBeGreaterThan(0);
    // 脚本第 2898-2899 行：直接对 candidateEntries 的输出取 canonical_json
    expect(candidateHashOf(files)).toBe(sha256Hex(canonicalJson(files)));
    expect(changeScopeHashOf(paths)).toBe(sha256Hex(canonicalJson(paths)));
    // 模块内部按 path 升序归一；脚本的候选清单本来就是升序，两边必须落在同一序上
    expect([...paths].sort()).toEqual(paths);
    expect(files.map((file) => file.path)).toEqual(paths);
  }, 120_000);

  it('正文 body_hash：脚本 bodyHash 与模块 bodyHashOf 对同一份正文一致', () => {
    const sample = readFileSync(join(process.cwd(), 'docs/gates/G4.md'), 'utf8');
    expect(bodyHashOf(sample)).toBe(bodyHash(sample));
    expect(moduleBodyHashInput(sample)).toBe(bodyHashInput(sample));
  });

  it('工件字段集合与脚本 GATE_FIELDS 的 20 项一一对应', () => {
    expect(GATE_FIELDS.length).toBe(20);
    const artifact = buildGateArtifact(baseInput());
    expect(Object.keys(artifact).sort()).toEqual([...GATE_FIELDS].sort());
  });
});

describe('阶段闸（src/core/config.ts 的能力表）', () => {
  it('S5 阶段不提供 release 能力：requireCapability 抛 FORBIDDEN', () => {
    expect(() => requireCapability('S5', 'release')).toThrow(OrchError);
    try {
      requireCapability('S5', 'release');
      throw new Error('这里本该抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(OrchError);
      expect((err as OrchError).code).toBe('FORBIDDEN');
      expect((err as OrchError).details).toMatchObject({ current: 'S5', capability: 'release' });
    }
  });

  it('S6 才提供 release 能力', () => {
    expect(() => requireCapability('S6', 'release')).not.toThrow();
    expect(PHASE_CAPABILITIES.S6).toContain('release');
  });

  it('S1 还没有 panel 能力，S5 有 panel 与 memory 但没有 release', () => {
    expect(PHASE_CAPABILITIES.S1).not.toContain('panel');
    expect(PHASE_CAPABILITIES.S1).not.toContain('release');
    expect(PHASE_CAPABILITIES.S5).toContain('panel');
    expect(PHASE_CAPABILITIES.S5).toContain('memory');
    expect(PHASE_CAPABILITIES.S5).not.toContain('release');
  });
});
