// 门记录校验：读 S*.md 里的 GateArtifact，核字段、结论规则、必过项清单、证据文件哈希与四个哈希的原像（规格 11.3 行 978-986）
// 用法：node --no-warnings scripts/gate-check.ts [可选：门记录路径…]；无参按 defaultGatePaths 校验
// G1–G4 是无参检查的固定路径，G5 由当前工作树与 HEAD 历史决定。
export const DEFAULT_GATE_PATHS = ['docs/gates/G1.md', 'docs/gates/G2.md', 'docs/gates/G3.md', 'docs/gates/G4.md']
//
// 哈希口径（门记录里的值都能重算，不是手写数）：
//   candidate_hash      = SHA256(canonical_json([{path, sha256}]，按 path 升序))，取 HEAD 上候选范围内的文件内容
//   change_scope_hash   = SHA256(canonical_json([path ...]，按升序))，取候选范围内的改动文件清单
//   evidence_index_hash = SHA256(canonical_json([{id, file, sha256}]，按 id 升序))，sha256 是证据文件当前字节的 SHA256
//   invariants_hash     = SHA256(canonical_json([{id, statement, evidence_ids}]，按 id 升序))
//   body_hash           = SHA256(正文归一化文本)，归一化只把两个自锚点与反引号里的 64 位 sha256 换成占位符
// 候选范围 = GATE_SPECS[gate].scopeBase..HEAD 的改动，按 GATE_CANDIDATE_EXCLUDES 排除路径。
// 防重签口径（第三轮审计 R3-05…R3-09）：
//   producer 必须是 human（规格 11.3 行 981，G1 到 G5 的主 artifact 由人手工跑）
//   必过项与证据是固定映射（evidenceMap），换绑证据重签会被挡住
//   正文两张表（证据文件与哈希、例外）必须与 artifact 同源，正文改动由 body_hash 抓住
//   previous_artifact_hash 指向前序门记录的 artifact_hash，重签链断了会被挡住
//   audit_round / audit_report 指向本轮独立审计，审计报告必须已在 HEAD
//   门记录本身必须在 HEAD 里（改了没提交不算数），工作树脏文件（含 docs/gates）一律不许签
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import MarkdownIt from 'markdown-it'
import { canonicalJson, sha256Hex } from '../src/core/canonical.ts'
import { parseAuditVerdict, verdictProblems, VERDICT_BEGIN, VERDICT_END } from '../src/core/audit-verdict.ts'

export const GATE_FIELDS = [
  'gate', 'schema_version', 'gate_run_id', 'candidate_hash', 'change_scope_hash',
  'evidence_index_hash', 'invariants_hash', 'must_pass_items', 'failed_items', 'conclusion',
  'run_terminal', 'exceptions', 'rollback', 'approver', 'approved_at', 'producer',
  'previous_artifact_hash', 'audit_round', 'audit_report', 'audit_report_sha256',
] as const

export type InvariantSpec = { statement: string; evidence_ids: string[] }

export type GateSpec = {
  items: string[]
  content: Record<string, string>
  invariants: Record<string, InvariantSpec>
  // 每道门固定一张必过项清单：少了、多了、改名都算没过（审计 M4）；正文表的内容列也按这张表核对（审计 N-09）
  evidenceMap: Record<string, string[]>
  // 证据 id 与文件路径也是固定映射：只固定 id 还能把文件换绑后重签（S1 第二轮审计）
  evidenceFiles: Record<string, string>
  scopeBase: string
  excludes: string[]
  prevGate: string | null
  gateFile: string
  // 这道门的审计报告必须带结构化裁决块（第二次意见 P0）：有裁决块时以它为放行依据，
  // 词法解析器退成兜底；没要求裁决块的旧门才走词法路径
  requireVerdict?: boolean
}

// 门记录独立于候选范围，后续签门不会改变前序门的候选哈希。
// handoff 是活文档，每次收尾都会改（审计 F-02）。
const GATE_CANDIDATE_EXCLUDES = [
  'docs/gates/G1.md',
  'docs/gates/G2.md',
  'docs/gates/G3.md',
  'docs/gates/G4.md',
  'docs/gates/G5.md',
  'docs/audits',
  'docs/reviews',
  'handoff.md',
] as const

export const GATE_SPECS: Record<string, GateSpec> = {
  G1: {
    items: ['G1-01', 'G1-02', 'G1-03', 'G1-04', 'G1-05', 'G1-06', 'G1-07', 'G-01', 'G-02', 'G-08', 'G-09', 'G-14', 'G-15'],
    content: {
      'G1-01': '迁移空库可重复',
      'G1-02': '迁移中途杀可重入',
      'G1-03': '进程杀不丢已提交事件',
      'G1-04': '备份独立目录行数与哈希一致',
      'G1-05': '损坏备份可检出',
      'G1-06': '认证拒匿名写',
      'G1-07': '阶段开关拒未知值',
      'G-01': '事务 COMMIT 前杀进程',
      'G-02': 'COMMIT 后未投递被杀',
      'G-08': '长事务期间读不被拖死、写报 busy、队列溢出报 503',
      'G-09': '订阅者离线重放',
      'G-14': '迁移一半杀后重跑',
      'G-15': '备份截断能检出、恢复被拒、线上库不变',
    },
    // 不变量语句与证据也钉死在代码里：只比对 invariants_hash 的话，改写语句后重签仍能过（S1 第八轮 P1-3）
    invariants: {
      I1: { statement: '单写者与 epoch 栅栏：同一个库只有一条写路径，越代次写被拒', evidence_ids: ['ev-epoch'] },
      I10: { statement: '无门记录不进阶：门检查固定必过项清单并重算证据哈希', evidence_ids: ['ev-gatecheck'] },
      I2: { statement: '事件只追加且哈希链能检出篡改', evidence_ids: ['ev-chain'] },
      I3: { statement: '事务失败不留半条记录，CAS 失败无副作用', evidence_ids: ['ev-g01', 'ev-g02'] },
    },
    evidenceMap: {
      'G1-01': ['ev-migrate'],
      'G1-02': ['ev-g14'],
      'G1-03': ['ev-g02'],
      'G1-04': ['ev-backup'],
      'G1-05': ['ev-g15'],
      'G1-06': ['ev-auth'],
      'G1-07': ['ev-phase'],
      'G-01': ['ev-g01'],
      'G-02': ['ev-g02'],
      'G-08': ['ev-g08'],
      'G-09': ['ev-g09'],
      'G-14': ['ev-g14'],
      'G-15': ['ev-g15'],
    },
    evidenceFiles: {
      'ev-auth': 'tests/contract/auth.spec.ts',
      'ev-backup': 'tests/integration/backup.spec.ts',
      'ev-chain': 'tests/integration/hash-chain.spec.ts',
      'ev-epoch': 'tests/integration/db-open.spec.ts',
      'ev-g01': 'docs/gates/evidence/G1/G-01.md',
      'ev-g02': 'docs/gates/evidence/G1/G-02.md',
      'ev-g08': 'docs/gates/evidence/G1/G-08.md',
      'ev-g09': 'docs/gates/evidence/G1/G-09.md',
      'ev-g14': 'docs/gates/evidence/G1/G-14.md',
      'ev-g15': 'docs/gates/evidence/G1/G-15.md',
      'ev-gatecheck': 'tests/gate/gate-check.spec.ts',
      'ev-migrate': 'tests/integration/migrate.spec.ts',
      'ev-phase': 'tests/unit/config.spec.ts',
    },
    scopeBase: '623939d4c0a7123835b525287035588ee291ccbe',
    requireVerdict: true,
    excludes: [...GATE_CANDIDATE_EXCLUDES],
    prevGate: null,
    gateFile: 'docs/gates/G1.md',
  },
  G2: {
    items: ['G2-01', 'G2-02', 'G2-03', 'G2-04', 'G2-05', 'G2-06', 'G2-07', 'G-03', 'G-04', 'G-05', 'G-07', 'G2-08', 'G2-09', 'G2-10', 'G2-11', 'G2-12', 'G2-13', 'G2-14', 'G2-15', 'G2-16'],
    content: {
      'G2-01': '单节点 queued 到终态一条路径（走生产装配）',
      'G2-02': '重复上报只落一次',
      'G2-03': '租约过期迟到上报被拒',
      'G2-04': '取消后不产生新 attempt',
      'G2-05': '终态必带证据',
      'G2-06': '无裸 blocked（没裁决卡不许卡住）',
      'G2-07': 'S2 加载 parallel 被拒',
      'G-03': '同一 report_id 上报两次只落一次',
      'G-04': '租约到期后原执行器迟到上报被拒',
      'G-05': '工具执行中取消只立一次围栏',
      'G-07': '墙钟跳变不误判截止',
      'G2-08': '工具失败不许落完成（系统判失败并挂凭据）',
      'G2-09': '判定时限只认 boot_id 与单调纳秒（墙钟跳变不误判）',
      'G2-10': '报告入口系统级证据门（弱证据与伪造痕迹一律拒）',
      'G2-11': '反复重投同一 report_id 不许把账本刷膨胀',
      'G2-12': '工具授权只认 workflow 定义，请求体策略不参与',
      'G2-13': '单写者锁与 epoch 围栏：第二写者拿不到锁，旧 epoch 写不进',
      'G2-14': '长动作靠心跳续租，扫描不误判过期',
      'G2-15': '同一工作流的同一版本跨重启不可改写，在飞 run 的判定条件不跟着变',
      'G2-16': 'Agent Bridge 生产闭环：B01–B10 可复现，工具证据只来自宿主执行',
    },
    invariants: {
      I1: { statement: '一个 node_run 最多一个终态：所有迁移带 CAS，终态不再接受普通出口', evidence_ids: ['ev-g2-01', 'ev-g2-02', 'ev-g2-04', 'ev-g2-05'] },
      I2: { statement: '账本只追加：已提交事件不改写，节点迁移都留事件', evidence_ids: ['ev-g2-04', 'ev-g2-g05'] },
      I3: { statement: '所有迁移带 CAS，CAS 失败不产生副作用', evidence_ids: ['ev-g2-03', 'ev-g2-g04'] },
      I4: { statement: '每个终态有对应证据，证据不足不入完成账', evidence_ids: ['ev-g2-05', 'ev-g2-08', 'ev-g2-10', 'ev-g2-g07'] },
      I5: { statement: '卡住必须挂裁决卡；没有决策卡就不许阻塞', evidence_ids: ['ev-g2-06'] },
      I6: { statement: '判定时限只认 boot_id 与单调纳秒：墙钟跳变、跨 boot、没有锚点都判不确定，不自动判超时', evidence_ids: ['ev-g2-09'] },
      I7: { statement: '同一 report_id 的同类事件只留一条：重试不许把账本刷膨胀', evidence_ids: ['ev-g2-11'] },
      I8: { statement: '工具授权只认 workflow 定义：请求体带来的策略不参与判定，越权与未注册在租约前被拒', evidence_ids: ['ev-g2-12'] },
      I9: { statement: '单写者锁与 epoch 围栏：第二写者拿不到锁，旧 epoch 的连接写不进', evidence_ids: ['ev-g2-13'] },
      I10: { statement: '长动作靠心跳续租：租约 2 秒、动作 3 秒时 2.5 秒扫描不判过期', evidence_ids: ['ev-g2-14'] },
      I11: { statement: '工作流定义跨重启落库：同一版本改写被拒，在飞 run 的判定条件不跟着变', evidence_ids: ['ev-g2-15'] },
      I12: { statement: 'Agent Bridge 生产闭环：事件先落账再确认，工具强证据只来自宿主执行，取消先确认停止，崩溃恢复不盲目重跑', evidence_ids: ['ev-g2-16'] },
    },
    evidenceMap: {
      'G2-01': ['ev-g2-01'],
      'G2-02': ['ev-g2-02'],
      'G2-03': ['ev-g2-03'],
      'G2-04': ['ev-g2-04'],
      'G2-05': ['ev-g2-05', 'ev-g2-10'],
      'G2-06': ['ev-g2-06'],
      'G2-07': ['ev-g2-07'],
      'G-03': ['ev-g2-g03'],
      'G-04': ['ev-g2-g04'],
      'G-05': ['ev-g2-g05'],
      'G-07': ['ev-g2-g07', 'ev-g2-09'],
      'G2-08': ['ev-g2-08'],
      'G2-09': ['ev-g2-09'],
      'G2-10': ['ev-g2-10'],
      'G2-11': ['ev-g2-11'],
      'G2-12': ['ev-g2-12'],
      'G2-13': ['ev-g2-13'],
      'G2-14': ['ev-g2-14'],
      'G2-15': ['ev-g2-15'],
      'G2-16': ['ev-g2-16'],
    },
    evidenceFiles: {
      'ev-g2-01': 'docs/gates/evidence/G2/ev-g2-01.md',
      'ev-g2-02': 'docs/gates/evidence/G2/ev-g2-02.md',
      'ev-g2-03': 'docs/gates/evidence/G2/ev-g2-03.md',
      'ev-g2-04': 'docs/gates/evidence/G2/ev-g2-04.md',
      'ev-g2-05': 'docs/gates/evidence/G2/ev-g2-05.md',
      'ev-g2-06': 'docs/gates/evidence/G2/ev-g2-06.md',
      'ev-g2-07': 'docs/gates/evidence/G2/ev-g2-07.md',
      'ev-g2-g03': 'docs/gates/evidence/G2/G-03.md',
      'ev-g2-g04': 'docs/gates/evidence/G2/G-04.md',
      'ev-g2-g05': 'docs/gates/evidence/G2/G-05.md',
      'ev-g2-g07': 'docs/gates/evidence/G2/G-07.md',
      'ev-g2-08': 'docs/gates/evidence/G2/ev-g2-08.md',
      'ev-g2-09': 'docs/gates/evidence/G2/ev-g2-09.md',
      'ev-g2-10': 'docs/gates/evidence/G2/ev-g2-10.md',
      'ev-g2-11': 'docs/gates/evidence/G2/ev-g2-11.md',
      'ev-g2-12': 'docs/gates/evidence/G2/ev-g2-12.md',
      'ev-g2-13': 'docs/gates/evidence/G2/ev-g2-13.md',
      'ev-g2-14': 'docs/gates/evidence/G2/ev-g2-14.md',
      'ev-g2-15': 'docs/gates/evidence/G2/ev-g2-15.md',
      'ev-g2-16': 'docs/gates/evidence/G2/ev-g2-16.md',
    },
    scopeBase: '4f3ada7',
    requireVerdict: true,
    excludes: [...GATE_CANDIDATE_EXCLUDES],
    prevGate: 'G1',
    gateFile: 'docs/gates/G2.md',
  },
  G3: {
    items: [
      'G3-01', 'G3-02', 'G3-03', 'G3-04', 'G3-05', 'G3-06', 'G3-07', 'G3-08', 'G3-09', 'G3-10',
      'G3-11', 'G-01', 'G-02', 'G-04', 'G-06', 'G-12', 'G-16', 'G3-12', 'G3-13', 'G3-14',
    ],
    content: {
      'G3-01': 'M-01 到 M-65 逐条迁移用例，非法迁移全拒',
      'G3-02': '所有节点迁移走 CAS，迟到 attempt 不污染新行',
      'G3-03': '半态时钟与桥断冻结矩阵：跨 boot 剩余量不计停机、回拨夹零',
      'G3-04': 'blocked_pre 审批往返：旧租约清除、内容哈希绑定、拒绝和超时不回 queued',
      'G3-05': 'policy 九算子与 branch 路由：多命中不猜、无命中有凭据落 blocked_post',
      'G3-06': '并行汇聚 all/any/quorum 与不可逆子节点闸',
      'G3-07': 'wait 先落 inbox 再匹配：早到回扫、唤醒幂等、超时与饥饿分记',
      'G3-08': '子流程 pin 版本、深度与环检测、父取消向子 run 传播',
      'G3-09': '补偿按 compensation_id 幂等一次，失败落 failed_with_unverified',
      'G3-10': '报告冲突与 uphold 收口：挂起节点只认两条裁决出口',
      'G3-11': '恢复扫描可重入：断链跳过、桥断挂起、启动未知到点转未知态',
      'G-01': '事务 COMMIT 前杀进程',
      'G-02': 'COMMIT 后未投递被杀',
      'G-04': '租约到期后原执行器迟到上报被拒',
      'G-06': 'tool.result 丢失后同 callId 只重发结果、不重跑工具',
      'G-12': '审批双击同 revision 只赢一笔',
      'G-16': '父取消向子 run 传播且跳过不可逆节点',
      'G3-12': '起运行固定版本、自治档位与 operation_id 幂等',
      'G3-13': '批准人三档：审计能力位、不得批准自己证据、human 档不被 Agent 代批',
      'G3-14': 'S3 全量测试与构建全绿',
    },
    invariants: {
      I1: { statement: 'M-01 到 M-65 是唯一迁移口径：每条规则有独立用例，非法迁移和终态普通出口都拒', evidence_ids: ['ev-g3-01', 'ev-g3-02'] },
      I2: { statement: '所有节点迁移带 CAS：迟到 attempt、旧 revision、挂起节点都不能被普通出口改写', evidence_ids: ['ev-g3-02', 'ev-g3-10'] },
      I3: { statement: '子流程先 pin 版本再执行：深度、环、父取消都按运行关系判定，父 run 不得先于子 run 收口', evidence_ids: ['ev-g3-08'] },
      I4: { statement: '补偿只执行一次：失败或未核验落 failed_with_unverified，不落普通 failed', evidence_ids: ['ev-g3-09'] },
      I5: { statement: 'wait 先落 inbox 再按谓词匹配：早到事件可回扫，唤醒与超时都幂等', evidence_ids: ['ev-g3-07'] },
      I6: { statement: '报告冲突只走 uphold_report 或 uphold_decision：普通出口遇 hang_reason 一律 STALE_HANG', evidence_ids: ['ev-g3-10'] },
      I7: { statement: '自治档位在任务上：supervised 不自动收口，autonomous/assisted 按默认动作过期；改档不追溯', evidence_ids: ['ev-g3-12'] },
      I8: { statement: '批准人三档不可绕过：agent 必须有 orchestra.audit，且不能批准自己产出的证据', evidence_ids: ['ev-g3-13'] },
    },
    evidenceMap: {
      'G3-01': ['ev-g3-01'],
      'G3-02': ['ev-g3-02'],
      'G3-03': ['ev-g3-03'],
      'G3-04': ['ev-g3-04'],
      'G3-05': ['ev-g3-05'],
      'G3-06': ['ev-g3-06'],
      'G3-07': ['ev-g3-07'],
      'G3-08': ['ev-g3-08'],
      'G3-09': ['ev-g3-09'],
      'G3-10': ['ev-g3-10'],
      'G3-11': ['ev-g3-11'],
      'G-01': ['ev-g3-g01'],
      'G-02': ['ev-g3-g02'],
      'G-04': ['ev-g3-g04'],
      'G-06': ['ev-g3-g06'],
      'G-12': ['ev-g3-g12'],
      'G-16': ['ev-g3-g16'],
      'G3-12': ['ev-g3-12'],
      'G3-13': ['ev-g3-13'],
      'G3-14': ['ev-g3-14'],
    },
    evidenceFiles: {
      'ev-g3-01': 'tests/integration/migration-cases.spec.ts',
      'ev-g3-02': 'tests/integration/node-runs.spec.ts',
      'ev-g3-03': 'tests/integration/half-state.spec.ts',
      'ev-g3-04': 'tests/integration/approval.spec.ts',
      'ev-g3-05': 'tests/integration/policy-branch.spec.ts',
      'ev-g3-06': 'tests/integration/parallel.spec.ts',
      'ev-g3-07': 'tests/integration/wait.spec.ts',
      'ev-g3-08': 'tests/integration/subworkflow.spec.ts',
      'ev-g3-09': 'tests/integration/compensation.spec.ts',
      'ev-g3-10': 'tests/integration/apply-report.spec.ts',
      'ev-g3-11': 'tests/integration/sweep.spec.ts',
      'ev-g3-g01': 'docs/gates/evidence/G1/G-01.md',
      'ev-g3-g02': 'docs/gates/evidence/G1/G-02.md',
      'ev-g3-g04': 'docs/gates/evidence/G2/G-04.md',
      'ev-g3-g06': 'docs/gates/evidence/G3/G-06.md',
      'ev-g3-g12': 'docs/gates/evidence/G3/G-12.md',
      'ev-g3-g16': 'docs/gates/evidence/G3/G-16.md',
      'ev-g3-12': 'tests/unit/start-run.spec.ts',
      'ev-g3-13': 'tests/unit/approver.spec.ts',
      'ev-g3-14': 'docs/gates/evidence/G3/full-suite.md',
    },
    scopeBase: 'c296d72',
    requireVerdict: true,
    excludes: [...GATE_CANDIDATE_EXCLUDES],
    prevGate: 'G2',
    gateFile: 'docs/gates/G3.md',
  },
  G4: {
    items: [
      'G4-01', 'G4-02', 'G4-03', 'G4-04', 'G4-05', 'G4-06', 'G4-07', 'G4-08',
      'G4-09', 'G4-10', 'G4-11', 'G4-12', 'G4-13', 'G-10',
    ],
    content: {
      'G4-01': 'Q-37 命令路径 404、草稿分流与 based_on_version 断言',
      'G4-02': 'Q-38 已消费草稿优先 DRAFT_NOT_OPEN，内容未变返回 changed=false',
      'G4-03': 'Q-39 保存层拒绝码：id/边/坐标/标题/名称/自环/重复边/超限',
      'G4-04': 'Q-40 子流程 pin 已发布版本、深度 2 与成环拒',
      'G4-05': 'Q-41 版本只增不减、版本行不可变、在途 run 固定旧版本',
      'G4-06': 'Q-42 task_local 归属：预留任务、owner 真实性与根入口禁起',
      'G4-07': '发布事务与回执同笔：版本插入、current_version 上调、草稿消费与 command.applied',
      'G4-08': '并发发布只有一个版本（双 worker 真并发抢一张草稿）',
      'G4-09': '在途 run 时发布新版本：旧 run 固定 v1、新 run 用 v2',
      'G4-10': '非法图与空名称拒：保存层结构性拒绝，发布层全量图语义拒',
      'G4-11': '回滚发布不影响已固定 run：版本不可变与 run 固定两条一起断言',
      'G4-12': 'HTTP 六入口与 UUIDv7 operation_id 幂等协议',
      'G4-13': 'S4 全量测试与构建全绿',
      'G-10': '在途 run 时发布新版本',
    },
    invariants: {
      I1: { statement: '发布只影响之后新建的 run：在途 run 永远按创建时的版本解释', evidence_ids: ['ev-g4-05', 'ev-g4-09', 'ev-g4-g10'] },
      I2: { statement: '已发布版本不可变：只插不改不删，回滚只能发新版本', evidence_ids: ['ev-g4-05', 'ev-g4-11'] },
      I3: { statement: '发布事务与回执同笔：失败整笔回滚，重放拿原回执不产生第二份副作用', evidence_ids: ['ev-g4-07', 'ev-g4-08'] },
      I4: { statement: 'task_local 只归属预留任务：owner 必须真实未消费，根入口不许起', evidence_ids: ['ev-g4-06'] },
      I5: { statement: '校验分两层：保存层只拒结构问题，发布层拒全部图语义问题且错误带 path', evidence_ids: ['ev-g4-03', 'ev-g4-10'] },
    },
    evidenceMap: {
      'G4-01': ['ev-g4-01'],
      'G4-02': ['ev-g4-02'],
      'G4-03': ['ev-g4-03'],
      'G4-04': ['ev-g4-04'],
      'G4-05': ['ev-g4-05'],
      'G4-06': ['ev-g4-06', 'ev-g4-14'],
      'G4-07': ['ev-g4-07'],
      'G4-08': ['ev-g4-08'],
      'G4-09': ['ev-g4-09'],
      'G4-10': ['ev-g4-10'],
      'G4-11': ['ev-g4-11'],
      'G4-12': ['ev-g4-12'],
      'G4-13': ['ev-g4-13'],
      'G-10': ['ev-g4-g10'],
    },
    evidenceFiles: {
      'ev-g4-01': 'tests/integration/workflow-commands.spec.ts',
      'ev-g4-02': 'tests/integration/workflow-commands.spec.ts',
      'ev-g4-03': 'tests/unit/workflow-doc-save.spec.ts',
      'ev-g4-04': 'tests/unit/workflow-doc-publish.spec.ts',
      'ev-g4-05': 'tests/integration/workflow-g4.spec.ts',
      'ev-g4-06': 'tests/integration/workflow-g4.spec.ts',
      'ev-g4-07': 'tests/integration/workflow-commands.spec.ts',
      'ev-g4-08': 'tests/integration/workflow-g4.spec.ts',
      'ev-g4-09': 'tests/integration/workflow-g4.spec.ts',
      'ev-g4-10': 'tests/unit/workflow-doc-save.spec.ts',
      'ev-g4-11': 'tests/integration/workflow-g4.spec.ts',
      'ev-g4-12': 'tests/contract/workflow-routes.spec.ts',
      'ev-g4-13': 'docs/gates/evidence/G4/full-suite.md',
      'ev-g4-g10': 'docs/gates/evidence/G4/G-10.md',
      'ev-g4-14': 'tests/integration/workflow-commands.spec.ts',
    },
    scopeBase: '9fbecdd',
    requireVerdict: true,
    excludes: [...GATE_CANDIDATE_EXCLUDES],
    prevGate: 'G3',
    gateFile: 'docs/gates/G4.md',
  },
  G5: {
    items: [
      'Q-01', 'Q-02', 'Q-03', 'Q-04', 'Q-05', 'Q-06', 'Q-07', 'Q-08',
      'Q-09', 'Q-10', 'Q-11', 'Q-12', 'Q-13', 'Q-14', 'Q-15', 'Q-16',
      'Q-17', 'Q-18', 'Q-19', 'Q-20', 'Q-21', 'Q-22', 'Q-23', 'Q-24',
      'Q-25', 'Q-26', 'Q-27', 'Q-28', 'Q-29', 'Q-30', 'Q-31', 'Q-32',
      'Q-33', 'Q-34', 'Q-35', 'Q-36', 'Q-43', 'Q-43b', 'Q-43c', 'Q-44',
      'Q-44b', 'Q-44c', 'Q-45', 'Q-46', 'Q-47', 'Q-47b', 'Q-48', 'Q-49',
      'Q-50', 'Q-51', 'Q-52', 'Q-52b', 'Q-53', 'Q-54', 'Q-55', 'Q-56',
      'Q-57', 'Q-58', 'Q-59', 'Q-60', 'Q-61', 'Q-62', 'Q-63', 'G5-VIEWPORT-NARROW',
      'G5-VIEWPORT-WIDE', 'G5-FONT-BODY', 'G5-FONT-MENU', 'G5-CONTRAST-LIGHT', 'G5-MEMORY-RECONCILE', 'G5-PHASE-RELEASE', 'G-06', 'G-11',
      'G-12'
    ],
    content: {
      'Q-01': 'list_tasks 按 attention 排序：待裁决在运行中前，同权重按 updated_at 降序',
      'Q-02': '分页途中插入新任务时面板按 task_id 去重、后页覆盖前页',
      'Q-03': 'get_run 的 run、counts 与 top-N 节点同属一个读事务，as_of_seq 等于该事务最大 events.seq',
      'Q-04': 'run 已 succeeded 时 display_status 仍是 succeeded，不被旧 settling 值改回',
      'Q-05': 'succeeded_with_unverified 在面板是独立黄色状态并带未验证数量',
      'Q-06': 'failed_with_unverified 深红显示并带未验证角标',
      'Q-07': 'blocked 且 settling 时同时显示「等你决定」与「仍有未结算不可逆动作」',
      'Q-08': 'declared_effect 与 verified_effect 不一致时高亮并链到相关 decision',
      'Q-09': '任务列表显示待裁决条数、最长等待、最高风险与最后心跳',
      'Q-10': '裁决收件箱按 priority 排序，report_contradicted 不给自动收口倒计时',
      'Q-11': 'get_decision 的 allowed_resolutions 与当前 kind 一致',
      'Q-12': '过期 revision 调 decision.resolve 报 DECISION_REVISION_CONFLICT 且状态不变',
      'Q-13': '同 operation_id 与同 request_hash 重放返回 replayed=true，只落一条 command.applied',
      'Q-14': '终结回执后同 operation_id 换 request_hash 报 OPERATION_ID_CONFLICT',
      'Q-15': '高风险裁决不带 challenge 报 CONFIRMATION_REQUIRED',
      'Q-16': '命令响应丢失后 get_operation 返回 applied，面板刷新不重复写',
      'Q-17': 'SSE 从 as_of_seq 续传补齐事件，断号时整页重取',
      'Q-18': '同一事件重复投递时按 event_id 去重，时间线只出现一行',
      'Q-19': '心跳超 30 秒显示「心跳已停 X 秒」，节点状态保持原值',
      'Q-20': '服务停止后面板显示最后一次快照加 stale，命令按钮禁用',
      'Q-21': 'protocolVersion 不匹配时面板全屏阻断',
      'Q-22': '面板无 orchestra.db 写权限也能工作，静态检查无 sqlite 直连',
      'Q-23': '任务标题里的 HTML 按纯文本显示',
      'Q-24': 'get_artifact 传伪造 id 或路径穿越返回 NOT_FOUND 且不泄露文件系统路径',
      'Q-25': '篡改 node_run_events 后 verify_ledger 返回 valid=false 与 first_bad_event_seq',
      'Q-26': '1000 节点 run 的 get_run p95 < 150ms、list_nodes 单页 200 条 p95 < 80ms',
      'Q-27': '1 万任务 list_tasks 首屏 p95 < 100ms',
      'Q-28': '换过滤条件复用 cursor 报 CURSOR_FILTER_MISMATCH，超时 10 分钟报 CURSOR_EXPIRED',
      'Q-29': 'stopped_at 非空但 side_effect_verified_none 不为 true 时仍显示「未验证」',
      'Q-30': 'done 节点缺 verified_effect 时证据栏显示 evidence_state=none',
      'Q-31': '节点表 20 种状态各有唯一文案，不折叠合并成 run 三态',
      'Q-32': 'resolved 按两条判定规则落进 unverified_resolutions 表',
      'Q-33': 'human_attested 不进 evidence_strength 也不进「已验证」列，get_evidence 不返回人证',
      'Q-34': '子智能体调 decision.resolve 被拒，actor 记为认证主体',
      'Q-35': '回执满 7 天置 receipt_expired_at，get_operation 返回 OPERATION_EXPIRED',
      'Q-36': 'command 卡在 in_flight：10 分钟内重发报 COMMAND_BUSY，超时扫描置 rejected',
      'Q-43': '对未结算源 run 调 memory_start_run 报 MEMORY_SOURCE_RUN_NOT_SETTLED',
      'Q-43b': '同 request_key 重试返回第一次已建的 run，memory_run_requests 只有一行',
      'Q-43c': '并发同 (source_run_id, request_key) 只建一条 run，重启后同 key 仍命中',
      'Q-44': 'executor 白名单含 memory_write 或 memory_update 时发布报 MEMORY_WRITE_TOOL_FORBIDDEN',
      'Q-44b': 'agent 节点 toolPolicy.allow 与会话模板 allow 写 memory_update 时发布报 MEMORY_WRITE_TOOL_FORBIDDEN',
      'Q-44c': '加载期校验 toolRef 前缀与能力声明，不符时报 TOOL_NOT_REGISTERED 或 SIDE_EFFECT_UNDECLARED',
      'Q-45': 'mem_prepare 的批量过大、正文超 64 KiB、client_key 重复、layer=L3 各报对应错误码',
      'Q-46': '同 target_id 两条不同内容报 MEMORY_BATCH_CONFLICT，同内容合并为 skipped_duplicate',
      'Q-47': '裁判输出非 JSON、缺 items、verdict=maybe 时报 MEMORY_EVAL_INVALID_OUTPUT 且批次 failed',
      'Q-47b': '裁判对 truncated=true 给 approve 报 MEMORY_EVAL_INVALID_OUTPUT，needs_user 才放行',
      'Q-48': '裁判给 needs_user 时不生成审批卡，批次 outcome=blocked 且一条未写',
      'Q-49': '人批准后只写建议写入的条目，其余条目 skipped，批次 outcome=written',
      'Q-50': '人驳回审批卡：批次 declined、run failed、记忆条目数不变',
      'Q-51': '审批卡超 24 小时未确认：decision=expired、批次 expired、无写入',
      'Q-52': '错批次 decision_id 或改 content 后 apply 报 MEMORY_APPLY_BINDING_INVALID 且一条不写',
      'Q-52b': '批准后对 memory_items 的 INSERT / DELETE / 非 content 字段 UPDATE / 换序四种篡改都被拒，报 MEMORY_APPLY_BINDING_INVALID',
      'Q-53': '同批次连续两次 apply：第二次 already_applied=true 且不产生新的 memory.applied 事件',
      'Q-54': 'apply 的 tool.result 丢失时批次保持 applying，inspect_batch 能对账三条走向',
      'Q-55': '源 run A 的批次用源 run B 的 decision_id 写入报 MEMORY_APPLY_BINDING_INVALID',
      'Q-56': '写入后条目能追回 source_run_id、memory_run_id、batch_id、decision_id 与 client_key',
      'Q-57': '不存在或不属该记忆 run 的 batch_id 报 MEMORY_BATCH_NOT_FOUND',
      'Q-58': '批次未 approved 时 apply 报 MEMORY_BATCH_NOT_APPROVED 且优先于绑定与冲突判定',
      'Q-59': '同 (batch_id, client_key) 内容哈希不同报 MEMORY_APPLY_CONFLICT，相同则 already_applied',
      'Q-60': '评估端口超时 / 不可用 / 开关关闭分别报 MEMORY_EVAL_TIMEOUT / UNAVAILABLE / DISABLED',
      'Q-61': '插件原子写入失败报 MEMORY_APPLY_FAILED，一条不写且同批次不自动重试',
      'Q-62': '错误码优先级：未 approved 优先于归属不符，快照不符优先于同键哈希不同',
      'Q-63': '批次 indeterminate 后面板显示「写到一半，等你确认」，放弃写入后 run 落 succeeded_with_unverified',
      'G5-VIEWPORT-NARROW': '面板在 1366×900 视口无横向溢出',
      'G5-VIEWPORT-WIDE': '面板在 1600×1000 视口无横向溢出',
      'G5-FONT-BODY': '正文不小于 13px，辅助文字不小于 12px',
      'G5-FONT-MENU': '左侧菜单与顶部导航不小于 12.5px',
      'G5-CONTRAST-LIGHT': '浅色主题正文对比度 4.5:1，大字与 UI 3:1',
      'G5-MEMORY-RECONCILE': '记忆批次部分写入能对账：已写入与未写入逐条可查',
      'G5-PHASE-RELEASE': 'S5 阶段能力表不含 release，S5 启动 wf_release_v1 被拒',
      'G-06': 'tool.result 丢失后同 callId 只重发结果，工具不重跑',
      'G-11': '记忆批次写一半杀进程后可对账并恢复到确定终态',
      'G-12': '审批双击与同决定重复提交只赢一笔',
    },
    invariants: {
      I1: { statement: '面板读模型与命令层口径一致：Q-01 到 Q-36 逐条覆盖排序、去重、幂等与安全边界', evidence_ids: ['ev-g5-q-01', 'ev-g5-q-02', 'ev-g5-q-13', 'ev-g5-q-24'] },
      I2: { statement: '记忆写入受审批与绑定约束：Q-43 到 Q-63 逐条覆盖幂等、归属、快照绑定与错误码优先级', evidence_ids: ['ev-g5-q-52', 'ev-g5-q-52b', 'ev-g5-q-62', 'ev-g5-g-11'] },
      I3: { statement: '阶段能力不越界：S5 不提供 release，S5 启动 wf_release_v1 被拒', evidence_ids: ['ev-g5-g5-phase-release'] },
      I4: { statement: '视觉门槛达标：两个视口无横向溢出，正文、辅助、菜单与顶导字号及浅色对比度都过线', evidence_ids: ['ev-g5-g5-viewport-narrow', 'ev-g5-g5-viewport-wide', 'ev-g5-g5-font-body', 'ev-g5-g5-font-menu', 'ev-g5-g5-contrast-light'] },
      I5: { statement: '三条必过注入都跑过并留下对账查询：G-06、G-11、G-12', evidence_ids: ['ev-g5-g-06', 'ev-g5-g-11', 'ev-g5-g-12'] },
      I6: { statement: '记忆部分写入可对账：已写入、未写入与批次状态三方可对上账', evidence_ids: ['ev-g5-g5-memory-reconcile', 'ev-g5-q-54', 'ev-g5-q-63'] },
    },
    evidenceMap: {
      'Q-01': ['ev-g5-q-01'],
      'Q-02': ['ev-g5-q-02'],
      'Q-03': ['ev-g5-q-03'],
      'Q-04': ['ev-g5-q-04'],
      'Q-05': ['ev-g5-q-05'],
      'Q-06': ['ev-g5-q-06'],
      'Q-07': ['ev-g5-q-07'],
      'Q-08': ['ev-g5-q-08'],
      'Q-09': ['ev-g5-q-09'],
      'Q-10': ['ev-g5-q-10'],
      'Q-11': ['ev-g5-q-11'],
      'Q-12': ['ev-g5-q-12'],
      'Q-13': ['ev-g5-q-13'],
      'Q-14': ['ev-g5-q-14'],
      'Q-15': ['ev-g5-q-15'],
      'Q-16': ['ev-g5-q-16'],
      'Q-17': ['ev-g5-q-17'],
      'Q-18': ['ev-g5-q-18'],
      'Q-19': ['ev-g5-q-19'],
      'Q-20': ['ev-g5-q-20'],
      'Q-21': ['ev-g5-q-21'],
      'Q-22': ['ev-g5-q-22'],
      'Q-23': ['ev-g5-q-23'],
      'Q-24': ['ev-g5-q-24'],
      'Q-25': ['ev-g5-q-25'],
      'Q-26': ['ev-g5-q-26'],
      'Q-27': ['ev-g5-q-27'],
      'Q-28': ['ev-g5-q-28'],
      'Q-29': ['ev-g5-q-29'],
      'Q-30': ['ev-g5-q-30'],
      'Q-31': ['ev-g5-q-31'],
      'Q-32': ['ev-g5-q-32'],
      'Q-33': ['ev-g5-q-33'],
      'Q-34': ['ev-g5-q-34'],
      'Q-35': ['ev-g5-q-35'],
      'Q-36': ['ev-g5-q-36'],
      'Q-43': ['ev-g5-q-43'],
      'Q-43b': ['ev-g5-q-43b'],
      'Q-43c': ['ev-g5-q-43c'],
      'Q-44': ['ev-g5-q-44'],
      'Q-44b': ['ev-g5-q-44b'],
      'Q-44c': ['ev-g5-q-44c'],
      'Q-45': ['ev-g5-q-45'],
      'Q-46': ['ev-g5-q-46'],
      'Q-47': ['ev-g5-q-47'],
      'Q-47b': ['ev-g5-q-47b'],
      'Q-48': ['ev-g5-q-48'],
      'Q-49': ['ev-g5-q-49'],
      'Q-50': ['ev-g5-q-50'],
      'Q-51': ['ev-g5-q-51'],
      'Q-52': ['ev-g5-q-52'],
      'Q-52b': ['ev-g5-q-52b'],
      'Q-53': ['ev-g5-q-53'],
      'Q-54': ['ev-g5-q-54'],
      'Q-55': ['ev-g5-q-55'],
      'Q-56': ['ev-g5-q-56'],
      'Q-57': ['ev-g5-q-57'],
      'Q-58': ['ev-g5-q-58'],
      'Q-59': ['ev-g5-q-59'],
      'Q-60': ['ev-g5-q-60'],
      'Q-61': ['ev-g5-q-61'],
      'Q-62': ['ev-g5-q-62'],
      'Q-63': ['ev-g5-q-63'],
      'G5-VIEWPORT-NARROW': ['ev-g5-g5-viewport-narrow'],
      'G5-VIEWPORT-WIDE': ['ev-g5-g5-viewport-wide'],
      'G5-FONT-BODY': ['ev-g5-g5-font-body'],
      'G5-FONT-MENU': ['ev-g5-g5-font-menu'],
      'G5-CONTRAST-LIGHT': ['ev-g5-g5-contrast-light'],
      'G5-MEMORY-RECONCILE': ['ev-g5-g5-memory-reconcile'],
      'G5-PHASE-RELEASE': ['ev-g5-g5-phase-release'],
      'G-06': ['ev-g5-g-06'],
      'G-11': ['ev-g5-g-11'],
      'G-12': ['ev-g5-g-12'],
    },
    evidenceFiles: {
      'ev-g5-q-01': 'docs/gates/evidence/G5/Q-01.md',
      'ev-g5-q-02': 'docs/gates/evidence/G5/Q-02.md',
      'ev-g5-q-03': 'docs/gates/evidence/G5/Q-03.md',
      'ev-g5-q-04': 'docs/gates/evidence/G5/Q-04.md',
      'ev-g5-q-05': 'docs/gates/evidence/G5/Q-05.md',
      'ev-g5-q-06': 'docs/gates/evidence/G5/Q-06.md',
      'ev-g5-q-07': 'docs/gates/evidence/G5/Q-07.md',
      'ev-g5-q-08': 'docs/gates/evidence/G5/Q-08.md',
      'ev-g5-q-09': 'docs/gates/evidence/G5/Q-09.md',
      'ev-g5-q-10': 'docs/gates/evidence/G5/Q-10.md',
      'ev-g5-q-11': 'docs/gates/evidence/G5/Q-11.md',
      'ev-g5-q-12': 'docs/gates/evidence/G5/Q-12.md',
      'ev-g5-q-13': 'docs/gates/evidence/G5/Q-13.md',
      'ev-g5-q-14': 'docs/gates/evidence/G5/Q-14.md',
      'ev-g5-q-15': 'docs/gates/evidence/G5/Q-15.md',
      'ev-g5-q-16': 'docs/gates/evidence/G5/Q-16.md',
      'ev-g5-q-17': 'docs/gates/evidence/G5/Q-17.md',
      'ev-g5-q-18': 'docs/gates/evidence/G5/Q-18.md',
      'ev-g5-q-19': 'docs/gates/evidence/G5/Q-19.md',
      'ev-g5-q-20': 'docs/gates/evidence/G5/Q-20.md',
      'ev-g5-q-21': 'docs/gates/evidence/G5/Q-21.md',
      'ev-g5-q-22': 'docs/gates/evidence/G5/Q-22.md',
      'ev-g5-q-23': 'docs/gates/evidence/G5/Q-23.md',
      'ev-g5-q-24': 'docs/gates/evidence/G5/Q-24.md',
      'ev-g5-q-25': 'docs/gates/evidence/G5/Q-25.md',
      'ev-g5-q-26': 'docs/gates/evidence/G5/Q-26.md',
      'ev-g5-q-27': 'docs/gates/evidence/G5/Q-27.md',
      'ev-g5-q-28': 'docs/gates/evidence/G5/Q-28.md',
      'ev-g5-q-29': 'docs/gates/evidence/G5/Q-29.md',
      'ev-g5-q-30': 'docs/gates/evidence/G5/Q-30.md',
      'ev-g5-q-31': 'docs/gates/evidence/G5/Q-31.md',
      'ev-g5-q-32': 'docs/gates/evidence/G5/Q-32.md',
      'ev-g5-q-33': 'docs/gates/evidence/G5/Q-33.md',
      'ev-g5-q-34': 'docs/gates/evidence/G5/Q-34.md',
      'ev-g5-q-35': 'docs/gates/evidence/G5/Q-35.md',
      'ev-g5-q-36': 'docs/gates/evidence/G5/Q-36.md',
      'ev-g5-q-43': 'docs/gates/evidence/G5/Q-43.md',
      'ev-g5-q-43b': 'docs/gates/evidence/G5/Q-43b.md',
      'ev-g5-q-43c': 'docs/gates/evidence/G5/Q-43c.md',
      'ev-g5-q-44': 'docs/gates/evidence/G5/Q-44.md',
      'ev-g5-q-44b': 'docs/gates/evidence/G5/Q-44b.md',
      'ev-g5-q-44c': 'docs/gates/evidence/G5/Q-44c.md',
      'ev-g5-q-45': 'docs/gates/evidence/G5/Q-45.md',
      'ev-g5-q-46': 'docs/gates/evidence/G5/Q-46.md',
      'ev-g5-q-47': 'docs/gates/evidence/G5/Q-47.md',
      'ev-g5-q-47b': 'docs/gates/evidence/G5/Q-47b.md',
      'ev-g5-q-48': 'docs/gates/evidence/G5/Q-48.md',
      'ev-g5-q-49': 'docs/gates/evidence/G5/Q-49.md',
      'ev-g5-q-50': 'docs/gates/evidence/G5/Q-50.md',
      'ev-g5-q-51': 'docs/gates/evidence/G5/Q-51.md',
      'ev-g5-q-52': 'docs/gates/evidence/G5/Q-52.md',
      'ev-g5-q-52b': 'docs/gates/evidence/G5/Q-52b.md',
      'ev-g5-q-53': 'docs/gates/evidence/G5/Q-53.md',
      'ev-g5-q-54': 'docs/gates/evidence/G5/Q-54.md',
      'ev-g5-q-55': 'docs/gates/evidence/G5/Q-55.md',
      'ev-g5-q-56': 'docs/gates/evidence/G5/Q-56.md',
      'ev-g5-q-57': 'docs/gates/evidence/G5/Q-57.md',
      'ev-g5-q-58': 'docs/gates/evidence/G5/Q-58.md',
      'ev-g5-q-59': 'docs/gates/evidence/G5/Q-59.md',
      'ev-g5-q-60': 'docs/gates/evidence/G5/Q-60.md',
      'ev-g5-q-61': 'docs/gates/evidence/G5/Q-61.md',
      'ev-g5-q-62': 'docs/gates/evidence/G5/Q-62.md',
      'ev-g5-q-63': 'docs/gates/evidence/G5/Q-63.md',
      'ev-g5-g5-viewport-narrow': 'docs/gates/evidence/G5/G5-VIEWPORT-NARROW.md',
      'ev-g5-g5-viewport-wide': 'docs/gates/evidence/G5/G5-VIEWPORT-WIDE.md',
      'ev-g5-g5-font-body': 'docs/gates/evidence/G5/G5-FONT-BODY.md',
      'ev-g5-g5-font-menu': 'docs/gates/evidence/G5/G5-FONT-MENU.md',
      'ev-g5-g5-contrast-light': 'docs/gates/evidence/G5/G5-CONTRAST-LIGHT.md',
      'ev-g5-g5-memory-reconcile': 'docs/gates/evidence/G5/G5-MEMORY-RECONCILE.md',
      'ev-g5-g5-phase-release': 'docs/gates/evidence/G5/G5-PHASE-RELEASE.md',
      'ev-g5-g-06': 'docs/gates/evidence/G5/G-06.md',
      'ev-g5-g-11': 'docs/gates/evidence/G5/G-11.md',
      'ev-g5-g-12': 'docs/gates/evidence/G5/G-12.md',
    },
    scopeBase: '6d4ca1a',
    requireVerdict: true,
    excludes: [...GATE_CANDIDATE_EXCLUDES],
    prevGate: 'G4',
    gateFile: 'docs/gates/G5.md',
  },
}

export type GateItem = { id: string; result: string; evidence_ids?: string[] }
export type EvidenceEntry = { id: string; file: string; sha256: string }
export type InvariantEntry = { id: string; statement: string; evidence_ids: string[] }
export type CheckResult = { gate: string; artifactHash: string; bodyHash: string; items: number; evidence: number }

type Block = { tag: string; body: string; value: unknown }

function jsonBlocks(text: string): Block[] {
  const out: Block[] = []
  const re = /```json[ \t]*([^\r\n]*)\r?\n([\s\S]*?)\r?\n```/g
  for (const m of text.matchAll(re)) {
    try {
      out.push({ tag: (m[1] ?? '').trim(), body: m[2] ?? '', value: JSON.parse(m[2] ?? '') })
    } catch (err) {
      throw new Error('门记录里的 json 块不是合法 JSON（' + ((m[1] ?? '').trim() || '未标注') + '）：' + (err instanceof Error ? err.message : String(err)))
    }
  }
  return out
}

function blockOf(blocks: Block[], tag: string): Block {
  const hit = blocks.find((b) => b.tag === tag)
  if (!hit) throw new Error('门记录里找不到 ' + tag + ' 的 json 块')
  return hit
}

function git(root: string, args: string[]): Buffer {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
}

function changedFiles(root: string, spec: { scopeBase: string; excludes: string[] }): string[] {
  // 删除也是候选改动：--diff-filter 不能把 D 漏掉（审计 N-09）
  const range = spec.scopeBase + '..HEAD'
  const pathspec = ['--', '.']
  for (const dir of spec.excludes) pathspec.push(':(exclude)' + dir)
  const set = new Set<string>()
  for (const line of git(root, ['diff', '--name-only', range, ...pathspec]).toString('utf8').split(/\r?\n/)) {
    if (line.length > 0) set.add(line)
  }
  // 批内新增后又删除的文件在树差异里看不见，要从提交历史里捞回来（审计 R3-09）
  for (const filter of ['A', 'D']) {
    const out = git(root, ['log', '--format=', '--name-only', '--diff-filter=' + filter, '-z', range, ...pathspec]).toString('utf8')
    for (const p of out.split('\u0000')) {
      const trimmed = p.trim()
      if (trimmed.length > 0) set.add(trimmed)
    }
  }
  return Array.from(set).sort()
}

// 门记录只能对着干净的 HEAD 签：脏文件不进 candidate_hash，却可能被当成本次候选（审计 N-09、R3-07）
// docs/gates 不在忽略清单里：门记录自己脏了就是没签完，不许继续往下走
const DIRTY_IGNORES = ['docs/audits', 'docs/reviews', 'handoff.md']

export function assertClean(root: string): void {
  const args = ['status', '--porcelain', '--', '.']
  for (const dir of DIRTY_IGNORES) args.push(':(exclude)' + dir)
  const dirty = git(root, args).toString('utf8').trim()
  if (dirty.length > 0) {
    throw new Error('工作树有未提交改动，门记录不能对着脏树签：' + dirty.split(/\r?\n/)[0])
  }
}

function contentAt(root: string, ref: string, path: string): Buffer | null {
  try {
    // git show 对批内新增又删除的路径会打 fatal 噪声；这些路径按 ADDED_THEN_DELETED 处理，stderr 不必外泄（S1 r63 P2-1）
    return execFileSync('git', ['show', ref + ':' + path], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

// 候选文件的哈希原像一律取 HEAD；删除的文件把「删除」和删除前内容一起并进哈希
export function candidateEntries(root: string, spec: { scopeBase: string; excludes: string[] }): { paths: string[]; files: { path: string; sha256: string }[] } {
  const paths = changedFiles(root, spec)
  const files = paths.map((path) => {
    const head = contentAt(root, 'HEAD', path)
    if (head) return { path, sha256: sha256Hex(head) }
    const base = contentAt(root, spec.scopeBase, path)
    if (base) return { path, sha256: sha256Hex(Buffer.concat([Buffer.from('DELETED\n'), base])) }
    // 批内新增又删除的文件在基准与 HEAD 都没有内容，用固定原像占位，保证它留在候选清单里（审计 R3-09）
    return { path, sha256: sha256Hex(Buffer.from('ADDED_THEN_DELETED\n')) }
  })
  return { paths, files }
}

function checkEvidence(blocks: Block[], artifact: Record<string, unknown>, root: string, spec: GateSpec): { entries: EvidenceEntry[]; hash: string } {
  const raw = blockOf(blocks, 'evidence-index').value
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('evidence-index 为空')
  const entries: EvidenceEntry[] = []
  const seen = new Set<string>()
  for (const e of raw as EvidenceEntry[]) {
    if (typeof e.id !== 'string' || typeof e.file !== 'string' || !/^[0-9a-f]{64}$/.test(String(e.sha256))) {
      throw new Error('evidence-index 的项要有 id / file / 64 位 sha256：' + JSON.stringify(e))
    }
    if (seen.has(e.id)) throw new Error('evidence-index 里 id 重复: ' + e.id)
    seen.add(e.id)
    // id 的文件路径固定：只固定 id 的话，换一份同名文件再重签仍能过（S1 第二轮审计）
    const expectedFile = spec.evidenceFiles[e.id]
    if (!expectedFile) throw new Error('证据 id 不在固定映射里: ' + e.id)
    if (e.file !== expectedFile) throw new Error('证据 ' + e.id + ' 的文件与固定映射不一致（换绑证据不许重签）：' + e.file + ' != ' + expectedFile)
    // 证据也读 HEAD：工作树里改证据但没提交，不能拿来签门（审计 N-09）
    const head = contentAt(root, 'HEAD', e.file)
    if (!head) throw new Error('证据文件不在 HEAD 里，先提交证据再签门: ' + e.id)
    // 证据按 LF 归一的字节算哈希：仓库 checkout 的换行风格不同也得到同一个值
    const actual = sha256Hex(head.toString('utf8').replace(/\r\n/g, '\n'))
    if (actual !== e.sha256) throw new Error('证据文件 sha256 不符: ' + e.id + '（记录 ' + e.sha256.slice(0, 16) + '… 实际 ' + actual.slice(0, 16) + '…）')
    entries.push({ id: e.id, file: e.file, sha256: actual })
  }
  for (const id of Object.keys(spec.evidenceFiles).sort()) {
    if (!seen.has(id)) throw new Error('固定证据映射里的 ' + id + ' 没有出现在 evidence-index')
  }
  const sorted = entries.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const hash = sha256Hex(canonicalJson(sorted))
  if (artifact.evidence_index_hash !== hash) {
    throw new Error('evidence_index_hash 与证据索引不符：' + String(artifact.evidence_index_hash).slice(0, 16) + '… != ' + hash.slice(0, 16) + '…')
  }
  return { entries, hash }
}

function checkInvariants(blocks: Block[], artifact: Record<string, unknown>, entries: EvidenceEntry[], spec: GateSpec): { used: Set<string>; hash: string; list: InvariantEntry[] } {
  const raw = blockOf(blocks, 'invariants').value
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('invariants 为空')
  const list: InvariantEntry[] = []
  const used = new Set<string>()
  const seen = new Set<string>()
  for (const e of raw as InvariantEntry[]) {
    if (typeof e.id !== 'string' || typeof e.statement !== 'string' || !Array.isArray(e.evidence_ids) || e.evidence_ids.length === 0) {
      throw new Error('invariants 的项要有 id / statement / evidence_ids：' + JSON.stringify(e))
    }
    if (seen.has(e.id)) throw new Error('invariants 里 id 重复: ' + e.id)
    seen.add(e.id)
    // 语句与证据按固定口径比对：只核哈希等于让改写后的清单自己证明自己（S1 第八轮 P1-3）
    const want = spec.invariants[e.id]
    if (!want) throw new Error('不变量 id 不在固定口径里: ' + e.id)
    if (e.statement !== want.statement) {
      throw new Error('不变量 ' + e.id + ' 的语句与固定口径不一致（改写或削短都要重新审计）')
    }
    const wantEvidence = want.evidence_ids.slice().sort()
    const givenEvidence = e.evidence_ids.slice().sort()
    if (givenEvidence.length !== wantEvidence.length || givenEvidence.some((id, i) => id !== wantEvidence[i])) {
      throw new Error('不变量 ' + e.id + ' 的证据与固定口径不一致')
    }
    for (const id of e.evidence_ids) {
      if (!entries.some((x) => x.id === id)) throw new Error('不变量引用了不存在的证据: ' + id)
      used.add(id)
    }
    list.push({ id: e.id, statement: e.statement, evidence_ids: givenEvidence })
  }
  const expectedIds = Object.keys(spec.invariants).sort()
  const givenIds = list.map((x) => x.id).sort()
  if (givenIds.length !== expectedIds.length || givenIds.some((id, i) => id !== expectedIds[i])) {
    throw new Error('不变量清单与固定口径不一致：要有 ' + expectedIds.join(', '))
  }
  const sorted = list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const hash = sha256Hex(canonicalJson(sorted))
  if (artifact.invariants_hash !== hash) {
    throw new Error('invariants_hash 与不变量清单不符：' + String(artifact.invariants_hash).slice(0, 16) + '… != ' + hash.slice(0, 16) + '…')
  }
  return { used, hash, list: sorted }
}

// 正文表与 GateArtifact 交叉校验（审计 F-02）：表里写的必过项、结果、证据必须和 artifact 同源
function checkBodyTable(text: string, items: GateItem[], spec: { content: Record<string, string> }): void {
  const start = text.indexOf('## 必过项与证据')
  if (start < 0) throw new Error('门记录里找不到「## 必过项与证据」表')
  const rest = text.slice(start + 1)
  const end = rest.indexOf('\n## ')
  const section = end < 0 ? rest : rest.slice(0, end)
  const rows: { id: string; content: string; result: string; evidence: string[] }[] = []
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 4) continue
    const id = cells[0] ?? ''
    if (id === '编号' || /^-+$/.test(id)) continue
    rows.push({ id, content: cells[1] ?? '', result: cells[2] ?? '', evidence: (cells[3] ?? '').split(/[,，\s]+/).filter((s) => s.length > 0 && s !== '无') })
  }
  if (rows.length !== items.length) throw new Error('正文必过项表有 ' + String(rows.length) + ' 行，artifact 有 ' + String(items.length) + ' 项')
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('正文必过项表有重复编号')
  for (let i = 0; i < items.length; i += 1) {
    const row = rows[i]
    if (!row) throw new Error('正文必过项表缺第 ' + String(i + 1) + ' 行')
    const item = items[i] as GateItem
    if (row.id !== item.id) throw new Error('正文必过项第 ' + String(i + 1) + ' 行是 ' + row.id + '，artifact 是 ' + item.id)
    // 第 2 列内容按固定表核对：改字、换说法都不许悄悄过关（审计 N-09）
    const wantContent = spec.content[row.id]
    if (!wantContent) throw new Error('没有为必过项 ' + row.id + ' 定义正文固定内容')
    if (row.content !== wantContent) throw new Error('正文表里 ' + row.id + ' 的内容与固定表不一致：' + row.content + ' != ' + wantContent)
    if (row.result !== 'pass') throw new Error('正文表里 ' + row.id + ' 的结果不是 pass：' + row.result)
    const want = (item.evidence_ids ?? []).slice().sort().join(',')
    const got = row.evidence.slice().sort().join(',')
    if (want !== got) throw new Error('正文表里 ' + row.id + ' 的证据与 artifact 不一致：' + got + ' != ' + want)
  }
}

// 正文里的表统一读法：取某个二级标题下的表格行，单元格去掉反引号
function tableRows(text: string, heading: string): string[][] {
  const start = text.indexOf(heading)
  if (start < 0) throw new Error('门记录里找不到「' + heading + '」表')
  const rest = text.slice(start + 1)
  const end = rest.indexOf('\n## ')
  const section = end < 0 ? rest : rest.slice(0, end)
  const rows: string[][] = []
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 2) continue
    if (/^-+$/.test(cells[0] ?? '')) continue
    // 表头行不算数据行：证据表头是「证据」、例外表头是「码」、不变量表头是「不变量」
    if (cells[0] === '证据' || cells[0] === '码' || cells[0] === '不变量') continue
    rows.push(cells.map((c) => c.replace(/^`([^`]*)`$/, '$1')))
  }
  return rows
}

// 正文的「证据文件与哈希」表必须与 evidence-index 同源：改了 sha256 列或改了文件都会被点名（审计 R3-06）
export function checkBodyEvidenceTable(text: string, entries: EvidenceEntry[]): void {
  const rows = tableRows(text, '## 证据文件与哈希')
  if (rows.length === 0) {
    if (entries.length !== 0) throw new Error('正文「证据文件与哈希」表是空的，但 artifact 列了 ' + String(entries.length) + ' 份证据')
    return
  }
  if (rows.length !== entries.length) throw new Error('正文证据表有 ' + String(rows.length) + ' 行，artifact 列了 ' + String(entries.length) + ' 份证据')
  const map = new Map(entries.map((e) => [e.id, e]))
  const seen = new Set<string>()
  for (const row of rows) {
    const id = row[0] ?? ''
    const file = row[1] ?? ''
    const sha = row[2] ?? ''
    if (seen.has(id)) throw new Error('正文证据表里证据重复: ' + id)
    seen.add(id)
    const e = map.get(id)
    if (!e) throw new Error('正文证据表里有 artifact 没有的证据: ' + id)
    if (e.file !== file) throw new Error('正文证据表里 ' + id + ' 的文件与 artifact 不一致: ' + file + ' != ' + e.file)
    if (e.sha256 !== sha) throw new Error('正文证据表里 ' + id + ' 的 sha256 与 artifact 不一致（证据被改过或表没跟着改）')
  }
  // 只查行数和“表里每行都能在 artifact 找到”还不够：删一行再复制另一行，行数不变但证据被换掉（S1 第四轮审计 P2-1）
  for (const e of entries) {
    if (!seen.has(e.id)) throw new Error('正文证据表缺 artifact 里的证据: ' + e.id)
  }
}

// 正文的「例外」表必须与 artifact.exceptions 同源：例外说明改了字也会被抓（审计 R3-06）
function checkBodyExceptions(text: string, exceptions: unknown): void {
  const list = (Array.isArray(exceptions) ? exceptions : []) as { code: string; type: string; status: number; note: string }[]
  const rows = tableRows(text, '## 例外')
  if (rows.length === 0) {
    if (list.length !== 0) throw new Error('正文「例外」表是空的，但 artifact 列了 ' + String(list.length) + ' 条例外')
    return
  }
  if (rows.length !== list.length) throw new Error('正文例外表有 ' + String(rows.length) + ' 行，artifact 列了 ' + String(list.length) + ' 条')
  for (let i = 0; i < list.length; i += 1) {
    const row = rows[i] as string[]
    const e = list[i] as { code: string; type: string; status: number; note: string }
    if ((row[0] ?? '') !== e.code) throw new Error('正文例外表第 ' + String(i + 1) + ' 行的码与 artifact 不一致: ' + (row[0] ?? '') + ' != ' + e.code)
    if ((row[1] ?? '') !== e.type) throw new Error('正文例外表里 ' + e.code + ' 的类型与 artifact 不一致: ' + (row[1] ?? '') + ' != ' + e.type)
    if (Number(row[2] ?? '') !== e.status) throw new Error('正文例外表里 ' + e.code + ' 的 HTTP 与 artifact 不一致: ' + (row[2] ?? '') + ' != ' + String(e.status))
    if ((row[3] ?? '') !== e.note) throw new Error('正文例外表里 ' + e.code + ' 的说明与 artifact 不一致')
  }
}

// 正文的「不变量」表必须与 invariants 块同源：说明改了字也会被抓（审计 R3-06）
export function checkBodyInvariants(text: string, list: InvariantEntry[]): void {
  const rows = tableRows(text, '## 不变量')
  if (rows.length === 0) {
    if (list.length !== 0) throw new Error('正文「不变量」表是空的，但 artifact 列了 ' + String(list.length) + ' 条')
    return
  }
  if (rows.length !== list.length) throw new Error('正文不变量表有 ' + String(rows.length) + ' 行，artifact 列了 ' + String(list.length) + ' 条')
  const map = new Map(list.map((i) => [i.id, i]))
  const seen = new Set<string>()
  for (const row of rows) {
    const id = row[0] ?? ''
    if (seen.has(id)) throw new Error('正文不变量表里不变量重复: ' + id)
    seen.add(id)
    const item = map.get(id)
    if (!item) throw new Error('正文不变量表里有 artifact 没有的不变量: ' + id)
    if ((row[1] ?? '') !== item.statement) throw new Error('正文不变量表里 ' + id + ' 的说明与 artifact 不一致')
    const got = (row[2] ?? '').split(/[,，\s]+/).filter((s) => s.length > 0 && s !== '无').slice().sort().join(',')
    const want = item.evidence_ids.slice().sort().join(',')
    if (got !== want) throw new Error('正文不变量表里 ' + id + ' 的证据与 artifact 不一致: ' + got + ' != ' + want)
  }
  // 同上：删一行再复制另一行会骗过行数核对（S1 第四轮审计 P2-1）
  for (const item of list) {
    if (!seen.has(item.id)) throw new Error('正文不变量表缺 artifact 里的不变量: ' + item.id)
  }
}

// 正文自锚：除两个自锚点与反引号里的 sha256 外，正文任何改动都会改掉 body_hash（审计 R3-08）
export function bodyHashInput(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/artifact_hash=[0-9a-f]{64}/g, 'artifact_hash=<SELF>')
    .replace(/body_hash=[0-9a-f]{64}/g, 'body_hash=<SELF>')
    .replace(/`[0-9a-f]{64}`/g, '`<SELF>`')
}

export function bodyHash(text: string): string {
  return sha256Hex(bodyHashInput(text))
}

function checkBodyHash(text: string): string {
  const anchor = /body_hash=([0-9a-f]{64})/.exec(text)
  if (!anchor) throw new Error('门记录里找不到 body_hash 锚点')
  const expect = bodyHash(text)
  const got = anchor[1] ?? ''
  if (got !== expect) throw new Error('body_hash 与正文不符：' + got.slice(0, 16) + '… != ' + expect.slice(0, 16) + '…（正文改过就重签）')
  return expect
}

// 必过项与证据是固定映射：换绑证据重签会被挡住（审计 R3-08）
function checkEvidenceMap(items: GateItem[], spec: GateSpec): void {
  for (const item of items) {
    const want = spec.evidenceMap[item.id]
    if (!want) throw new Error('没有为必过项 ' + item.id + ' 定义固定证据映射')
    const got = (item.evidence_ids ?? []).slice().sort().join(',')
    const expected = want.slice().sort().join(',')
    if (got !== expected) throw new Error('必过项 ' + item.id + ' 的证据与固定映射不一致（换绑证据不许重签）：' + got + ' != ' + expected)
  }
}

// 重签链：本门要指向前序门记录在 HEAD 里的 artifact_hash（审计 R3-08）
function checkPreviousChain(artifact: Record<string, unknown>, spec: GateSpec, root: string): void {
  const prev = String(artifact.previous_artifact_hash ?? '')
  if (!/^[0-9a-f]{64}$/.test(prev)) throw new Error('previous_artifact_hash 必须是 64 位 sha256')
  if (!spec.prevGate) {
    if (prev !== '0'.repeat(64)) throw new Error('第一道门的 previous_artifact_hash 必须是 64 个 0')
    return
  }
  const prevSpec = GATE_SPECS[spec.prevGate]
  if (!prevSpec) throw new Error('没有前序门的校验规格: ' + spec.prevGate)
  const head = contentAt(root, 'HEAD', prevSpec.gateFile)
  if (!head) throw new Error('前序门记录不在 HEAD 里，先提交前序门记录: ' + prevSpec.gateFile)
  const m = /artifact_hash=([0-9a-f]{64})/.exec(head.toString('utf8'))
  if (!m) throw new Error('前序门记录里找不到 artifact_hash 锚点: ' + prevSpec.gateFile)
  if (m[1] !== prev) throw new Error('previous_artifact_hash 与前序门记录的 artifact_hash 不符（重签链断了）')
}

// 审计报告正文里的结论：只认顶层、未被隐藏的结论行，且全文只能有一个结论。
// 可见性：HTML 注释、details/pre/script/style/template、围栏代码、四空格缩进、引用围栏都不参与；
// 普通引用块里的结论仍可见（S1 第八轮 P1-4）。
// 用真实 Markdown 解析器取“渲染后可见的正文行”：链接目标/title、围栏代码、
// 缩进代码、引用定义、原始 HTML 都不进正文；实体与 Unicode 由解析器归一。
// 之前靠正则模拟 CommonMark，S2 第二十轮 13 条 P0 全是渲染差异；这里直接对齐渲染器。
const AUDIT_MARKDOWN = new MarkdownIt({ html: true, linkify: false, typographer: false })

export interface AuditCell {
  text: string
  tableIndex: number
  rowIndex: number
  columnIndex: number
  header: string
  // 表头单元格只提供列名，既不是散文也不是结论格。
  headerOnly?: boolean
}

export interface RenderedAudit {
  lines: string[]
  cells: (AuditCell | null)[]
}

// 表格单元格是片段，不是完整句子：判定时必须按“散文行”和“单元格”分层，
// 否则「无裸 blocked」「LEASE_EXPIRED」这类单元格内容会被当成散文裁决词（S2 第四轮整改）。
function renderedAuditWithCells(text: string): RenderedAudit | null {
  const lines: string[] = []
  const cells: (AuditCell | null)[] = []
  let buffer = ''
  let ambiguous = false
  let paragraphHasLink = false
  const openStack: string[] = []
  const tableHeaders: Record<number, Record<number, string>> = {}
  let tableIndex = -1
  let rowIndex = -1
  let columnIndex = -1
  const inCell = (): boolean => openStack.includes('td_open') || openStack.includes('th_open')
  const flush = (): void => {
    if (buffer.trim() === '') {
      buffer = ''
      paragraphHasLink = false
      return
    }
    // 链接所在段落里出现“结论：”时，可见正文可能只剩前缀而方括号已被解析掉；
    // 这类段落按歧义处理，不能让另一段干净 pass 过门（S1 第十三轮 P1）。
    if (paragraphHasLink && /(?:结论|結論|判定|审计意见|最终判定|最终结论|最終結論|(?:audit\s+)?(?:conclusions?|verdict|outcomes?|results?))\s*[：:—–-]/i.test(buffer)) ambiguous = true
    const isCell = inCell()
    for (const piece of buffer.split('\n')) {
      const norm = normalizeAuditLine(piece)
      lines.push(norm)
      if (!isCell) {
        cells.push(null)
        continue
      }
      if (rowIndex === 0) {
        // 表头行只记列名，不参与裁决判定。
        const table = (tableHeaders[tableIndex] ??= {})
        table[columnIndex] = table[columnIndex] ? table[columnIndex] + ' ' + norm : norm
        cells.push({ text: norm, tableIndex, rowIndex, columnIndex, header: '', headerOnly: true })
        continue
      }
      cells.push({ text: norm, tableIndex, rowIndex, columnIndex, header: tableHeaders[tableIndex]?.[columnIndex] ?? '' })
    }
    buffer = ''
    paragraphHasLink = false
  }
  const invisibleHtml = (html: string): boolean | null => {
    const body = html.trimStart()
    if (body.startsWith('<!--')) {
      const end = body.indexOf('-->')
      // 注释后面同一块里若还有正文，渲染器会显示，不能整块当隐藏。
      return end < 0 ? null : body.slice(end + 3).trim() === '' ? true : null
    }
    if (body.startsWith('<?')) {
      const end = body.indexOf('?>')
      return end < 0 ? null : body.slice(end + 2).trim() === '' ? true : null
    }
    if (body.startsWith('<![CDATA[')) {
      const end = body.indexOf(']]>')
      return end < 0 ? null : body.slice(end + 3).trim() === '' ? true : null
    }
    if (/^<!DOCTYPE\b/i.test(body)) return /^<!DOCTYPE[^>]*>\s*$/i.test(body.trim()) ? true : null
    return false
  }
  // 单独一两个反引号是未闭合的行内代码，渲染器会把它当字面量，
  // 但跨块的结论行不能被它“证明可见”；按歧义拒绝（S1 第十四轮补）。
  if (/(?:^|\n)[ \t]*`{1,2}[ \t]*(?=\n[ \t]*\n)/.test(text)) return null
  // 引用块里的缩进是否可见由 markdown-it 自己判：引用标记吃掉一个空格后，
  // 剩 3 个空格仍是引用段落（可见），剩 4 个才是缩进代码。手工清行会把
  // `> 引用\n>    结论：fail` 这种续行误藏（S1 第十七轮 P1-A）。
  const source = text.replace(/\r\n/g, '\n')
  const tokens = AUDIT_MARKDOWN.parse(source, {})
  for (const token of tokens) {
    if (token.type === 'html_block') {
      const hidden = invisibleHtml(token.content)
      if (hidden === true) continue
      return null
    }
    if (token.type === 'fence' || token.type === 'code_block') {
      flush()
      continue
    }
    // 表格结构靠开闭标签栈还原：单元格内容也是 inline token，
    // 没有栈就分不清“表格里的一格”与“正文里的一段”。
    if (token.type === 'table_open') {
      flush()
      openStack.push(token.type)
      tableIndex += 1
      rowIndex = -1
      columnIndex = -1
      continue
    }
    if (token.type === 'table_close') {
      flush()
      openStack.pop()
      continue
    }
    if (token.type === 'tr_open') {
      flush()
      openStack.push(token.type)
      rowIndex += 1
      columnIndex = -1
      continue
    }
    if (token.type === 'th_open' || token.type === 'td_open') {
      flush()
      openStack.push(token.type)
      columnIndex += 1
      continue
    }
    if (token.type.endsWith('_open') || token.type.endsWith('_close')) {
      flush()
      if (token.type.endsWith('_close')) openStack.pop()
      continue
    }
    if (token.type !== 'inline') {
      if (token.type === 'hr') flush()
      continue
    }
    for (const child of token.children ?? []) {
      if (child.type === 'html_inline') {
        const hidden = invisibleHtml(child.content)
        if (hidden === true) continue
        return null
      }
      if (child.type === 'code_inline') {
        // 行内代码在渲染里是可见文字；把内容并回可见行，
        // 不能让「结论\`:\`fail」「结\`论\`：fail」被拆开漏掉（S1 第十七轮 P1-B）。
        buffer += child.content
      } else if (child.type === 'image') {
        // 图片加载失败时浏览器会显示 alt 文本；alt 里出现 fail 结论按歧义拒绝。
        // alt 里的实体要先解码，标签（如 <wbr>）和不可见字符不能把结论拆开（S1 第二十轮 P0-2）。
        const alt = normalizeAuditLine(
          AUDIT_MARKDOWN.utils.unescapeAll(child.content).replace(/<[^>]*>/g, ''),
        )
        if (visibleFailStatement(alt)) ambiguous = true
        paragraphHasLink = true
      } else if (child.type === 'link_open' || child.type === 'link_close') {
        paragraphHasLink = true
      } else if (child.type === 'text' || child.type === 'text_special') {
        buffer += child.content
      } else if (child.type === 'softbreak') {
        // 门记录按“源码行”核对结论与绑定；软换行保留为行边界，和既有报告格式一致。
        flush()
      } else if (child.type === 'hardbreak') {
        flush()
      }
      // code_inline / image / link_open / link_close / 强调标记都不产生可见正文。
    }
  }
  flush()
  return ambiguous ? null : { lines, cells }
}

// 只要可见正文行：表格单元格也按渲染后的样子给出行。
export function renderedAuditLines(text: string): string[] | null {
  const rendered = renderedAuditWithCells(text)
  return rendered === null ? null : rendered.lines
}

// 可见正文里的“本报告不通过 / 本次审计结论为 fail”这类判断句。
// 先做 NFKC、去撇号、丢不可见字符，把空白与标点统一成 |，再让主语/连接词/
// 结论词允许任意 | 夹层；这样五行拆词、零宽、全角、连接号、引号都不能绕过。
// 结论词后只接受结尾、分隔符或「需应已的了」，所以「不通过项」「未通过验收」
// 这类叙述仍不误杀（S1 第十八至二十轮）。
const FAIL_SUBJECTS = [
  '本次独立审计', '审计意见', '审核意见', '复核意见', '评审意见',
  '审计结论', '审核结论', '复核结论', '评审结论',
  '审计结果', '审核结果', '复核结果', '评审结果',
  '最终结论', '最终判定', '审计报告', '审核报告', '复核报告', '评审报告',
  '本报告', '本次审计', '本轮审计', '本次复核', '本次评审', '该报告', '此报告', '本审计',
  // 繁體主语同样不做简繁转换（S1 第二十轮 P1-1）。
  '本報告', '本次審計', '本輪審計', '本次復核', '本次評審', '該報告', '此報告', '本審計',
  '審計報告', '審核報告', '復核報告', '評審報告', '審計意見', '審核意見', '復核意見', '評審意見',
  '審計結論', '審核結論', '復核結論', '評審結論', '審計結果', '審核結果', '復核結果', '評審結果',
  '最終結論', '最終判定',
  '审计', '审核', '复核', '评审', '结论', '結論', '判定', '審計', '審核', '復核', '評審', 'audit', 'review',
  'auditor', 'reviewer', '審計師',
  // 英文报告本身也能作否定句主语（S2 第二十七轮 P0-2）。
  'the report', 'this report', 'the audit report', 'audit report', 'report', 'reports',
  // 本轮未整改/未完成整改这类“完成度”否定没有“审计”二字，仍要能挂在裸主语上（S1 第二十二轮 P1）。
  '本轮', '本輪', '审计组', '审计小组', '審計組', '審計小組', '报告', '報告', 'approval', 'gate',
  // 完成度否定可以没有“审计”二字（S2 第三十轮 P0-5）。
  '整改工作', '整改任務', '整改任务', '整改', '修复工作', '修復工作', '修复', '修復',
  // 门正文的否定主语：本门记录不能放行（S1 第二十四轮 P0-2）。
  '本门记录', '本門記錄', '门记录', '門記錄', '本门', '本門', 'the gate', 'this gate', 'gate record',
  'recommendation', 'recommendations',
].sort((a, b) => b.length - a.length)

const FAIL_VERDICTS = [
  '未得到通过', '没有得到通过', '未能通过', '没有通过', '并未通过', '未获通过', '未予通过',
  '不能通过', '不是通过', '通不过', '不通过', '未通过', '没通过',
  // 繁體否定词：NFKC 不做简繁转换，必须单独列出（S1 第二十轮 P1-1）。
  '未得到通過', '沒有得到通過', '未能通過', '沒有通過', '並未通過', '未獲通過', '未予通過',
  '不能通過', '不是通過', '通不過', '不通過', '未通過', '沒通過',
  '不合格', '未成功', '不成功', '未过关', '没过', '不批准', '未批准', '失败',
  '未過關', '沒過', '失敗',
  'not successful', 'not succeeded', 'not succeed', 'not passed', 'not pass',
  'didnt pass', 'didnt succeed', 'wasnt pass', 'isnt pass',
  'unsuccessful', 'failure', 'failed', 'fails', 'failing', 'fail',
  'rejected', 'reject', 'denied', 'deny', 'no pass',
  'refused', 'refusal', 'rejects', 'denies', 'refuses', 'declines', 'vetoes',
  // 无法/不予/未获批准/未达标/被否决/被驳回等常见否定式（S2 第二十五轮 P0-1/P2-1）。
  '无法予以通过', '无法通过', '不予通过', '不获通过', '未获批准', '不获批准', '不予批准',
  '未达到通过标准', '未达标', '不达标', '未达标准', '未達標準', '未达要求', '未達要求', '未通过验收', '不通过验收', '未获审批', '不获审批',
  '被否决', '遭否决', '被驳回', '遭驳回', '被拒绝', '没能通过',
  // 裸裁决词：结论为否决/驳回/拒绝/反对，或未采纳/拒收/不接收（S2 第二十六轮 P0-1）。
  '未采纳', '未採納', '反对通过', '反對通過', '拒收', '不接收',
  '否决', '驳回', '拒绝', '反对', '否決', '駁回', '拒絕', '反對',
  'cannot pass', 'unable to pass', 'not approved', 'not approve', 'did not approve',
  'failed to pass', 'refused to pass', 'no approval', 'denied approval',
  // S1 第二十一轮 P0：缩写否定、批准类否定与繁體带宾语写法。
  'doesnt pass', 'doesnt approve', 'wont pass', 'wont approve', 'hasnt passed',
  'hasnt approved', 'havent passed', 'isnt passing', 'isnt approved', 'wasnt approved',
  'didnt approve', 'not passing', 'not approved',
  '未通過驗收', '不通過驗收', '未通過評審', '未通過審核', '被駁回', '被否決',
  // S1 第二十二轮：英文进行时否定、批准被动否定与中文缩写否定。
  'approval was not granted', 'approval is not granted', 'approval has not been granted',
  'approval not granted', 'approval not given', 'not approving', 'isnt approving', 'not granted', 'not given',
  '未获批', '没获批', '未被批准', '未准予通过', '不准予通过', '未获批通过',
  // 整改完成度否定：本轮未整改 / 本报告未完成整改（S1 第二十二轮 P1）。
  '未完成整改', '整改未完成', '未完成修复', '未整改', '未修复', '未收口',
  // S2 第二十八轮 P0-1/P0-2：同义否定与无点 i、收口宾语。
  '未通过收口', '未通過收口', 'unapproved', 'disapproved', 'unaccepted', 'nonapproved',
  '未过', '未過', '否',
  // 同义结论族：部分通过、有条件通过、待整改/暂缓都不是 clean pass（S2 第二十八轮 P0-1 扩展）。
  '部分通过', '部分通過', '有条件通过', '有條件通過', '附条件通过', '附條件通過',
  '未受理', '不予受理', '未接收', '不接受', '不予接受', '未接受',
  '待整改', '需整改', '仍需整改', '尚未整改', '有待整改', '待修复', '需修复',
  '暂缓', '暫緩', '搁置', '擱置', '待定', '悬置', '懸置', '否定', '负面', '負面',
  'negative', 'unfavorable', 'unfavourable', 'declined', 'vetoed', 'turned down',
  'unacceptable', 'noncompliant',
  // 不推荐/不予采信/不建议通过这类收口语（S2 第二十九轮 P0）。
  '不予推荐', '不推荐', '不建议', '不予采信', '不采信', '未予推荐', '未推荐',
  'recommend against', 'not recommend', 'does not recommend',
  // 常见负面结果词：阻断、未定、不足、不完整、未就绪（S1 第二十四轮后的系统性补强）。
  'blocked', 'inconclusive', 'insufficient', 'unsatisfactory', 'inadequate', 'incomplete',
  'unready', 'not ready', 'no-go', 'nogo', 'on hold', 'red',
  '不予放行', '不放行', '不予晋级', '不晋级', '未就绪', '不具备', '不充分', '未达成', '未满足', '不满足', '未符合', '不符合', '不完整', '待补', '退回', '打回', '悬而未决',
  '不予准入', '不准入', '未准入', '不予準入', '不準入', '未準入',
  '不足', '不够', '不夠', '未完成', '未收口',
  // 留有余地的结论同样不是 clean pass（S1 第二十八轮 P0-1）。
  '不齐全', '不齊全', '结论保留', '結論保留', '保留意见', '保留意見', '待观察', '待觀察',
  '不予采信并退回', '不予採信並退回', '不予采信并退回本报告', '不予採信並退回本報告',
].sort((a, b) => b.length - a.length)

const FAIL_CONNECTORS = [
  '审计意见', '审核意见', '复核意见', '评审意见',
  '审计结论', '审核结论', '复核结论', '评审结论',
  '审计结果', '审核结果', '复核结果', '评审结果',
  '最终结论', '最终判定', 'conclusions', 'conclusion', 'outcome',
  '结果', '结论', '結論', '判定', '意见', '经过', '审计', '审核', '复核', '评审', 'verdict', 'verdicts', '建议', '建議', '推荐', '推薦',
  '报告', '報告', '最终', '最終', '依然', '还是', '总的', 'results', 'result', 'report', 'review', 'approval',
  // 整改/修复/收口是完成度陈述的中间词：本报告整改尚未完成（S1 第二十三轮 P1-2）。
  '整改', '整改工作', '修复', '修复工作', '收口', 'remediation', 'remediations',
  '審計', '審核', '復核', '評審', '結果', '意見',
  'audit', 'was', 'were', 'has', 'have', 'had', 'been', 'did', 'does', 'do',
  'remains', 'remain', 'remained', 'still', 'continues', 'continue', '继续', '繼續', '仍然',
  'is', 'are', 'to', 'the', 'a', 'an', '经', '后', '仍', '为', '為', '是', '的',
  // 原则上/总体上/on the whole 这类语气副词不改变否定方向（S2 第三十轮 P0-1/P0-2）。
  '原则上', '原則上', '总体上', '總體上', '总体', '總體', '基本上', '大体上', '大體上',
  '整体上', '整體上', '总的来说', '總的來說', '一般而言', '一般而論',
  'on the whole', 'in general', 'overall', 'generally', 'basically',
  // 英文插入语不是主语的一部分：This audit, generally speaking, does not clear the gate（S2 第三十一轮 P0）。
  'generally speaking', 'strictly speaking', 'broadly speaking', 'practically speaking',
  'speaking', 'in practice', 'as a whole', 'on balance', 'all things considered',
  // 并列否定：不予采信并退回本报告（S2 第三十轮 P0-3）。
  '并且', '並且', '并', '並', '且', '又', '同时', '同時', 'and', 'then',
  // 主语与谓词之间的对象名词、副词、被动标记与状态介词（S1 第二十五轮 P0）。
  '验收', '驗收', '复核', '復核', '评审', '評審', '审核', '審核',
  '被', '目前', '當前', '当前', '暂时', '暫時', '尚', '尚且', '完成度', '完成率', '进度', '進度', 'in',
].sort((a, b) => b.length - a.length)

function regexEscape(ch: string): string {
  return ch.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')
}

// 允许任意不可见/标点夹层：每个字符之间插 \|*。
function sepPattern(token: string): string {
  return Array.from(token).filter((ch) => !/\s/u.test(ch)).map(regexEscape).join('(?:\\|_*)*')
}

const HOMOGLYPHS: Record<string, string> = {
  // 西里尔/希腊同形字：先把“看起来是拉丁字母”的码位折回 ASCII，
  // 否则 fаil、pаss 这类写法会绕过词表（S2 第二十五轮 P2-1）。
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
  'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ӏ': 'l',
  // 无点 i 不是同形折叠能覆盖的：NFKC 保留 ı，词表匹配不到 fail（S2 第二十八轮 P0-1）。
  'ı': 'i',
  // ß 不是 NFKC 折叠能覆盖的同形字：paß 会绕过 pass 词表（S1 第二十三轮 P2-2）。
  'ß': 'ss',
  'α': 'a', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'κ': 'k', 'χ': 'x', 'ι': 'i',
  'ε': 'e', 'τ': 't', 'υ': 'u', 'γ': 'y',
}

function foldHomoglyphs(text: string): string {
  return Array.from(text).map((ch) => HOMOGLYPHS[ch] ?? ch).join('')
}

function foldForVerdict(raw: string): string {
  const text = foldHomoglyphs(raw.normalize('NFKC').toLowerCase()).replace(/[\u2019\u00B4']/g, '')
  let out = ''
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!
    if (/[\p{Cf}\p{Mn}\p{Me}]/u.test(ch)) continue
    // 汉字中间夹一个同形拉丁/西里尔/希腊字母时（未通о过），按汉字词处理：
    // 不把它当成分隔符，否则一个字符就能把“未通过”拆开（S1 第二十一轮 P0-5）。
    if (/[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u.test(ch)
      && /[\u4e00-\u9fff]$/u.test(out)
      && /[\u4e00-\u9fff]/u.test(chars[i + 1] ?? '')) continue
    // 修饰字母形的冒号/连接号（U+02D0、U+A789）属于 Lm，不能当普通字母留下。
    if ('\u02D0\uA789\u2236\uFE13\uFE55\uFF1A:\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE63\uFF0D\u2043'.includes(ch)) {
      out += '|'
      continue
    }
    if (/\s/u.test(ch)) {
      out += '|'
      continue
    }
    // 下划线是标识符的一部分（blocked_post / lease_expired），不能当分隔符拆词，
    // 否则会把它拆成独立裁决词误伤正文（S2 第四轮整改）。
    if (/[\p{L}\p{N}_]/u.test(ch)) {
      out += ch
      continue
    }
    out += '|'
  }
  return out.replace(/\|+/g, '|').replace(/^\|+|\|+$/g, '')
}

const FAIL_VERDICT_RE = new RegExp('^(?:' + FAIL_VERDICTS.map(sepPattern).join('|') + ')')
const FAIL_CONNECTOR_RES = FAIL_CONNECTORS.map((token) => ({ token, re: new RegExp('^' + sepPattern(token)) }))

// 结构化否定：否定词 + 可选填充词 + 通过类谓词 + 可选对象。
// 这样“未达到通过标准”“无法予以通过”“被驳回”不必逐条入表，
// 同时“未通过项为 0”仍因尾部不是句末而放行。
const FAIL_NEGATIONS = [
  'refused to', 'failed to', 'unable to', 'did not', 'didnt', 'was not', 'wasnt',
  'is not', 'isnt', 'has not', 'hasnt', 'have not', 'havent', 'does not', 'doesnt',
  'will not', 'wont', 'do not', 'dont', 'cannot', 'cant', 'never',
  '无法', '没能', '没有', '未能', '未获', '未獲得', '未获得', '没有获得', '沒有獲得', '未取得', '未予', '不予', '不获', '不得', '不能', '不可',
  '尚未', '还没有', '還沒有', '还没', '還沒', '暂未', '暫未', '仍未', '从未', '從未', '并未', '並未',
  '不是', '并非', '並非', '遭', '被', '未', '不', '没', '沒', '无', '無', 'not', 'no',
].sort((a, b) => b.length - a.length)
const FAIL_FILLERS = [
  'be able to', 'able to', '得到', '获得', '予以', '能够', '达到', '经过',
  '获', '獲', '能', '准予', '被', 'be', 'to', 'the', 'a', 'yet', 'been', '达', '達',
  // does not consider the report ready：consider / report 是评价动词与评价对象（S2 第三十轮 P0-6）。
  'consider', 'considers', 'considered', 'deem', 'deems', 'deemed', 'regard', 'regards', 'regarded',
  'think', 'thinks', 'find', 'finds', 'report', 'reports',
  // 作为准入依据 / 作为放行条件（S1 第二十六轮 P0）。
  '作为', '作為',
  // 程度副词不改变否定方向：未完全完成 / 未彻底整改（S2 第三十一轮 P0）。
  '完全', '完全地', '彻底', '徹底', '根本', '真正',
  // 量词与副词作填充：尚未全部完成 / 未逐一通过 / 没有取得全部认可（S1 第二十七轮 P0-1、S2 第三十二轮 P0-1）。
  '全部', '全都', '均', '都', '逐一', '逐项', '逐項', '取得', '地',
  // 判定系动词与范围词：不能视为通过 / 不能认定通过 / 并非所有必过项都通过（S1 第二十八轮 P0-1）。
  '视为', '視為', '认定', '認定', '视作', '視作', '算作',
  '所有', '每项', '每項', '各项', '各項', '必过项', '必過項',
  // 按规范执行：未按规范执行（S1 第二十八轮 P0-1）。
  '按', '按照', '依照', '依', '根据', '根據', '规范', '規範',
  // 程度/方式副词与限定语：未能顺利通过 / 未正式收口 / 未一次性通过 / 未获全面通过（S2 第三十三轮 P0-1）。
  '顺利', '順利', '正式', '全面', '整体', '整體', '一次性', '本次', '当次', '當次',
].sort((a, b) => b.length - a.length)
const FAIL_PASS_STEMS = [
  // 标准/標准必须排在达标/達標前：未达标准不能被截成“未达标”后留下“准”。
  '标准', '標準', '通过', '批准', '达标', '合格', '成功', '过关', '许可', '认可', '同意',
  '否决', '驳回', '拒绝', 'approval', 'approved', 'approve', 'passing', 'passed',
  'succeed', 'succeeded', 'success', 'accepted', 'accept', 'pass', 'meet', 'met',
  'approving', 'granted', 'granting', 'acceptable', '采纳', '採納',
  // 完成度本身也是可被否定的谓词：整改尚未完成 / remediation is not complete（S1 第二十三轮 P1-2）。
  '完成', 'complete', 'completed', 'completion',
  // 收口/到位/开始/做完/闭环/整改同样是可被否定的完成度谓词（S1 第二十七轮 P0-1）。
  '收口', '到位', '开始', '開始', '做完', '闭环', '閉環', '整改',
  // 问题状态谓词：问题未解决 / 缺陷未关闭 / P0 未清零 / 整改未结束（S1 第二十八轮 P0-1）。
  '解决', '解決', '关闭', '關閉', '清零', '处理', '處理', '消除', '结束', '結束',
  // 修复/修復是完成度谓词：未修复完毕（S1 第二十八轮 P0-1）。
  '修复', '修復',
  // 验证与覆盖谓词：证据未核实 / 部分项未验证 / 范围未覆盖（S1 第二十八轮 P0-1）。
  '验收', '驗收', '复核', '復核', '覆盖', '覆蓋', '核实', '核實', '验证', '驗證', '核验', '核驗',
  // 整改动作谓词：未落实 / 未完善 / 未开展 / 未销项（S1 第二十八轮 P0-1）。
  '完善', '落实', '落實', '开展', '開展', '销项', '銷項', '执行', '執行',
  // “未达要求/未达标准”里的对象本身就是被否定的准入谓词（S1 第二十八轮 P0-1）。
  '要求', '标准', '標準',
  // 放行/放行条件/clear/fit 同义收口语（S1 第二十四轮 P0）。
  '放行', 'release', 'released', 'releases', 'clear', 'clears', 'cleared', 'fit', 'advance',
  '晋级', '晉級', '就绪', '就緒', '满足', '滿足', '符合', '完整', 'ready', 'eligible', 'qualified', 'satisfactory', 'sufficient', 'adequate', 'green',
  '准入', '準入',
  // 具备/具備同样是可被否定的准入谓词（S1 第二十六轮 P0）。
  '具备', '具備',
  // “不获认同”这类谓词不在旧表里（S2 第二十八轮 P0-1）。
  '认同', '認同', '赞同', '贊同', '首肯', '受理', '接收', '接受',
  // 推荐/建议/采信/支持/背书同样是可被否定的肯定谓词（S2 第二十九轮 P0）。
  '推荐', '推薦', '建议', '建議', '采信', '採信', '赞成', '贊成', '支持', '背书', '背書',
  'recommend', 'recommends', 'recommended', 'endorse', 'endorses', 'endorsed',
  'support', 'supports', 'supported',
  // 繁體谓词（S1 第二十一轮 P0-1）。
  '通過', '達標', '過關', '許可', '認可', '否決', '駁回', '拒絕', '獲批', '获批',
].sort((a, b) => b.length - a.length)
const FAIL_OBJECTS = ['最终验收', '最终驗收', '专家评审', '專家評審', '专家复核', '專家復核',
  '验收', '标准', '审批', '评审', '审核', '复核', '复查', '复审', '审查', '核查', '确认', '考核', '许可', '批准', '认可',
  '驗收', '標準', '審批', '評審', '審核', '復核', '復查', '復審', '審查', '核查', '確認', '許可', '認可',
  '通过', '通過',
  // 否决的宾语也可以是报告本身或本次审计（S2 第二十七轮 P0-1）。
  '本次独立审计', '本次审计', '本轮审计', '本审计', '审计组', '审计小组', '本报告', '该报告', '此报告', '报告本身', '报告',
  '本次審計', '本輪審計', '本審計', '審計組', '審計小組', '本報告', '該報告', '此報告', '報告本身', '報告',
  '全部准入条件', '全部準入條件', '条件', '條件', '准入条件', '准入條件', '放行条件', '放行條件', '要求', '门槛', '門檻', '准入', '準入', '基线', '基準', '资格', '資格',
  '依据', '依據', '整改', '整改工作', '修复', '修复工作', '收口', '检查', '檢查',
  // 谓词后接范围宾语：未覆盖全部节点 / 未核验全部必过项（S1 第二十八轮 P0-1）。
  '全部', '节点', '節點', '必过项', '必過項',
  // 谓词后接完成补语：未复核完毕 / 未整改完成（S1 第二十八轮 P0-1）。
  '完毕', '完畢', '完成',
  // 带限定的验收宾语：未通过本次验收 / 未通过当次复核检查（S2 第三十三轮 P0-1）。
  '本次验收', '本次驗收', '当次复核检查', '當次複核檢查', '本次复核', '本次覆核', '本次检查', '本次檢查',
  'the audit report', 'this report', 'the report', 'audit report', 'the gate', 'this gate',
  '放行', 'release', 'clear', '晋级', '晉級',
  '驗收', '標準', '審批', '評審', '審核', '許可', '認可']
  .sort((a, b) => b.length - a.length)

function prefixRes(tokens: readonly string[]): { token: string; re: RegExp }[] {
  return tokens.map((token) => ({ token, re: new RegExp('^' + sepPattern(token)) }))
}
const FAIL_NEG_RES = prefixRes(FAIL_NEGATIONS)
const FAIL_FILLER_RES = prefixRes(FAIL_FILLERS)
const FAIL_STEM_RES = prefixRes(FAIL_PASS_STEMS)
const FAIL_OBJECT_RES = prefixRes(FAIL_OBJECTS)

// 分句末尾的固有否定词：不带主语也能独立收口（S1 第二十七轮 P0-1）。
// 不放裸 fail："攻击结果：fail" 是攻击载荷描述，不是审计结论（既有正控）。
const BARE_TAIL_VERDICTS = [
  '待补', '待補', '待整改', '待修复', '待修復', '未整改', '未修复', '未修復',
  '未收口', '未完成', '部分通过', '部分通過', '有条件通过', '有條件通過', '附条件通过', '附條件通過',
  '不予采信', '不予採信', '不予受理', '不予准入', '不予準入', '未获准入', '未獲准入',
  // 待确认/待观察：既不 clean pass 也不显式否定，按句尾未收口处理（S1 第二十八轮 P0-1）。
  '待确认', '待確認', '尚待确认', '待观察', '待觀察', '待完善', '待复核', '待覆核', '待落实', '待落實',
  // 待办/待改进同样是未收口事实（S2 第三十三轮 P0-3）。
  '待办', '待辦', '待改进', '待改進',
].sort((a, b) => b.length - a.length)
const BARE_TAIL_RE = new RegExp('^(?:' + BARE_TAIL_VERDICTS.map(sepPattern).join('|') + ')')

// 计数/比例不足同样是失败：13 项中 12 项通过 / 只完成 80% / 尚差 2 项（S1 第二十七轮 P0-1）。
function positiveCount(token: string): boolean {
  if (/^\d+$/.test(token)) return Number(token) > 0
  return token !== '零' && token !== '〇'
}

function countingFailure(raw: string): boolean {
  const text = raw.normalize('NFKC').toLowerCase().replace(/[\s*_]+/g, '')
  // 计数不足：13 项中有 12 项通过 / 13 项中只有 12 项 pass / 13 项里 12 项通过。
  for (const m of text.matchAll(/(\d{1,3})\s*(?:项|個|个|條|条)(?:必过|必過|通过项|通過項)?\s*(?:中|裡|里|当中|當中)(?:有|只有|仅有|僅有|其中|还有|還有)?\s*(\d{1,3})\s*(?:项|個|个|條|条)?\s*(?:均|都|全部|全|已|为|為)?\s*(?:通过|通過|达标|達標|合格|pass(?:ed|ing)?|成功|完成|收口)/g)) {
    if (Number(m[2]) < Number(m[1])) return true
  }
  // 比例式：通过 18/19 项 / 只完成 18/19 项必过（S2 第三十三轮 P0-2）。
  for (const m of text.matchAll(/(\d{1,3})\s*\/\s*(\d{1,3})\s*(?:项|個|个|條|条)(?!\s*(?:必过|必過)?(?:全过|全過|全部通过|全部通過|均通过|均通過))/g)) {
    if (Number(m[1]) < Number(m[2])) return true
  }
  // 分项式：通过 18 项，1 项未过 / 未通过 1 项（S2 第三十三轮 P0-2）。
  for (const m of text.matchAll(/(\d{1,3})\s*(?:项|個|个|條|条)[^。\n]{0,8}?(?:通过|通過|达标|達標|合格)[^。\n]{0,8}?(\d{1,3})\s*(?:项|個|个|條|条)[^。\n]{0,6}?(?:未过|未過|未通过|未通過|没过|沒過)/g)) {
    if (Number(m[2]) > 0) return true
  }
  for (const m of text.matchAll(/(?:未通过|未通過|未过|未過)\s*(\d{1,3})\s*(?:项|個|个|條|条)/g)) {
    if (Number(m[1]) > 0) return true
  }
  // 完成一半 / 只完成了百分之八十（S2 第三十三轮 P0-2）。
  if (/完成(?:了)?(?:一半|半数|半數)/.test(text)) return true
  if (/百分之[一二三四五六七八九十]/.test(text)) return true
  // 通过率不足 100%（S2 第三十三轮 P0-2）。
  for (const m of text.matchAll(/通过率(?:为|為)?\s*(\d{1,3}(?:\.\d+)?)\s*%/g)) {
    if (Number(m[1]) < 100) return true
  }
  // 完成度只有 80%：名词形式不跟“只完成”。
  const level = /(?:完成度|完成率|进度|進度)(?:只|仅|僅)?(?:有|为|為)?\s*(\d{1,3}(?:\.\d+)?)%/.exec(text)
  if (level && Number(level[1]) < 100) return true
  const ratio = /(?:只|仅|僅|仅仅|僅僅)(?:完成|完成了|通過|通过|整改|收口|达标|達標)[^。\n]{0,24}?(?:(\d{1,3}(?:\.\d+)?)%|一半|半数|半數)/.exec(text)
  if (ratio) {
    if (ratio[1] === undefined) return true
    if (Number(ratio[1]) < 100) return true
  }
  // 剩余量本身即未完成：尚有 2 项 / 遗留 2 项 / 缺少 2 项证据。
  for (const m of text.matchAll(/(?:仍有|还有|還有|尚有|尚余|尚餘|遗留|遺留|尚差|还差|還差|仍差|尚缺|仍缺|还缺|還缺|仍欠|尚欠|欠缺|缺少|缺)(\d{1,3})\s*(?:项|個|个|條|条)/g)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 8)
    // “仍有 19 项通过”是清零正句，不按剩余项判。
    if (/^(?:通过|通過|pass|合格|达标|達標)/.test(after)) continue
    // P2/P3 与“不阻断”是允许的遗留项，不影响 pass 结论（既有正控）。
    if (/(?:p2|p3|不阻断|不阻斷)/i.test(text.slice(Math.max(0, m.index - 8), m.index))) continue
    if (Number(m[1]) > 0) return true
  }
  // 待办量词族：原则上有 3 项待完善 / 尚有 2 项待复核 / 有一项必过项未核验 / 复核发现 2 项未覆盖。
  const pending = /([一二三四五六七八九十百两兩几幾\d]{1,3})\s*(?:项|個|个|條|条)[^。\n]{0,18}?(?:待补|待補|待整改|待修复|待修復|待复核|待覆核|待完善|待落实|待落實|待确认|待確認|待观察|待觀察|待办|待辦|待改进|待改進|未完成|未收口|未整改|未修复|未修復|未解决|未解決|未关闭|未關閉|未清零|未处理|未處理|未消除|未验收|未驗收|未复核|未復核|未覆盖|未覆蓋|未核实|未核實|未验证|未驗證|未核验|未核驗|未落实|未落實|未开展|未開展|未结束|未結束|未销项|未銷項|未达标|未達標|未达要求|未达标准|未达標準)/.exec(text)
  if (pending && positiveCount(pending[1]!)) {
    // P2/P3 遗留可以不计入，但“P2 待办”仍是未收口（S2 第三十三轮 P0-3）。
    const before = text.slice(Math.max(0, pending.index - 8), pending.index)
    const allowedRemainder = /(?:p2|p3|不阻断|不阻斷)/i.test(before)
      && !/(?:待办|待辦|待改进|待改進)/.test(pending[0])
    if (!allowedRemainder) return true
  }
  // 没有数字的部分项：部分必过项未验证。
  if (/部分[^。\n]{0,12}?(?:未验证|未驗證|未核验|未核驗|未覆盖|未覆蓋|未核实|未核實|未解决|未解決|未完成)/.test(text)) return true
  // 无主语的“原则上有 3 项待补”与“原则上 3 项待完善”都已在 pending 覆盖。
  // 存在未完成项：否定项本身是名词，不能靠谓词否定表；前字为 不/无/没/未 时是清零正句。
  for (const m of text.matchAll(/(?:存在|仍有|还有|還有|尚有|发现|發現)(?:未完成项|未完成項|未收口项|未收口項|待整改项|待整改項)/g)) {
    const before = text.slice(Math.max(0, m.index - 1), m.index)
    if (!/[不无沒没未]/.test(before)) return true
  }
  return false
}

function matchPrefix(rest: string, resources: { token: string; re: RegExp }[]): string | null {
  // 词与词之间允许任意 | 夹层：先跳过夹层再匹配，否则
  // “is not passing”“未|通过|验收”会在第二个词前被 | 挡住（S1 第二十一轮 P0-3）。
  const lead = /^\|*/.exec(rest)?.[0].length ?? 0
  const body = rest.slice(lead)
  for (const resource of resources) {
    const match = resource.re.exec(body)
    if (match) return rest.slice(0, lead) + match[0]
  }
  return null
}

function matchStructuralObject(rest: string): number {
  const obj = matchPrefix(rest, FAIL_OBJECT_RES)
  return obj ? obj.length : 0
}

function matchStructuralNegative(rest: string): string | null {
  const neg = matchPrefix(rest, FAIL_NEG_RES)
  if (!neg) return null
  let pos = neg.length
  // 每吃一个填充词前都先试谓词：not acceptable 里的 a 不能被当成填充词吃掉，
  // 否则 not able to pass 这类写法仍然要能匹配（S2 第二十七轮 P0-2 同族）。
  for (let depth = 0; depth <= 6; depth += 1) {
    const pred = matchPrefix(rest.slice(pos), FAIL_STEM_RES)
    if (pred) {
      pos += pred.length
      // 谓词后可跟不止一个宾语：不推荐通过本报告 = 推荐 + 通过 + 本报告。
      for (let objDepth = 0; objDepth < 3; objDepth += 1) {
        const obj = matchPrefix(rest.slice(pos), FAIL_OBJECT_RES)
        // 宾语跨了分隔符（换行/拆词）就不算同一句，不能让它顶掉收口判据。
        if (!obj || obj.startsWith('|')) break
        pos += obj.length
      }
      return rest.slice(0, pos)
    }
    if (depth === 6) break
    const filler = matchPrefix(rest.slice(pos), FAIL_FILLER_RES)
    if (!filler) break
    pos += filler.length
  }
  return null
}
const FAIL_SUBJECT_RE = new RegExp(FAIL_SUBJECTS.map(sepPattern).join('|'), 'g')
const FAIL_SUBJECT_NO_BARE_RE = new RegExp(
  FAIL_SUBJECTS.filter((s) => s !== '结论' && s !== '結論' && s !== '判定').map(sepPattern).join('|'),
  'g',
)

type FailScan = { bareConclusion?: 'any' | 'never'; bareVerdict?: 'any' | 'never' }

function scanFailStatement(folded: string, scan: FailScan): boolean {
  if (folded.length === 0) return false
  const subjectRe = scan.bareConclusion === 'never' ? FAIL_SUBJECT_NO_BARE_RE : FAIL_SUBJECT_RE
  subjectRe.lastIndex = 0
  let sm: RegExpExecArray | null
  while ((sm = subjectRe.exec(folded)) !== null) {
    let pos = sm.index + sm[0].length
    // 连接词不限次数：只要求每次真的前进，长度有限所以必然收敛（S1 第二十一轮 P0-6）。
    for (let guard = 0; guard <= folded.length; guard += 1) {
      while (folded[pos] === '|') pos += 1
      const rest = folded.slice(pos)
      const vm = FAIL_VERDICT_RE.exec(rest)
      if (vm) {
        // 裁决词本身可以带宾语（拒收本报告 / rejects the report），宾语属于同一句否定，
        // 不能因为紧跟名词就当作叙述放行（S2 第二十七轮 P0-1）。
        // 跨行/跨词的宾语不算同一句：'本报告不|通|过|必过项与证据' 里 '必过项'
        // 是下一行的标题词，被当成宾语吃掉会让收口判据失效（S1 第十九轮 P0-4）。
        const afterVerdict = rest.slice(vm[0].length)
        const object = afterVerdict.startsWith('|') ? 0 : matchStructuralObject(afterVerdict)
        const next = folded[pos + vm[0].length + object] ?? ''
        if (next === '' || next === '|' || /[需应已的了]/.test(next)) return true
      }
      const structural = matchStructuralNegative(rest)
      if (structural) {
        const next = folded[pos + structural.length] ?? ''
        if (next === '' || next === '|' || /[需应已的了]/.test(next)) return true
      }
      let advanced = false
      for (const connector of FAIL_CONNECTOR_RES) {
        const cm = connector.re.exec(rest)
        if (cm) {
          pos += cm[0].length
          advanced = true
          break
        }
      }
      if (!advanced) break
    }
  }
  // 裸裁决词与分句尾部否定只在散文行里生效：单元格是片段，
  // 表格里的领域词（blocked / LEASE_EXPIRED）不是裁决（S2 第四轮整改）。
  if (scan.bareVerdict === 'never') return false
  return bareVerdictFailure(folded)
}

// 没有主语支撑的裁决词也算否决：句首裸否定、句尾裁决词、分句尾部否定。
function bareVerdictFailure(folded: string): boolean {
  // 句首没有主语、直接以否定或裁决词开头的句子（“不予采信本报告。”）也要算否定，
  // 否则会被当成普通叙述漏掉（S2 第二十九轮 P0）。
  const lead = /^\|*/.exec(folded)?.[0].length ?? 0
  const bare = folded.slice(lead)
  const bareStructural = matchStructuralNegative(bare)
  if (bareStructural) {
    const next = folded[lead + bareStructural.length] ?? ''
    if (next === '' || next === '|' || /[需应已的了]/.test(next)) return true
  }
  const bareVerdict = FAIL_VERDICT_RE.exec(bare)
  if (bareVerdict) {
    const object = matchStructuralObject(bare.slice(bareVerdict[0].length))
    const next = folded[lead + bareVerdict[0].length + object] ?? ''
    if (next === '' || next === '|' || /[需应已的了]/.test(next)) return true
  }
  // 分句尾部否定：无论主语和语气副词怎么堆，只要某个分句以否定谓词收口就是否决。
  // 这样不必为每一个新副词/对象补连接词（S1 第二十六轮八条 P0 的共同机制）。
  for (const clause of folded.split('|')) {
    if (clause.length === 0) continue
    for (let i = 0; i < clause.length; i += 1) {
      // 词内命中不算裁决（与上面的句尾裁决词同一口径）。
      if (i > 0 && /[A-Za-z0-9_]/.test(clause[i - 1]!)) continue
      const neg = matchStructuralNegative(clause.slice(i))
      if (neg && /^[。．.！!？?；;，,、\s*_]*$/.test(clause.slice(i + neg.length))) return true
      // 固有否定词单独收口：仍有 3 项致命待补 / 原则上有 2 项待补（S1 第二十七轮 P0-1）。
      const tailVerdict = BARE_TAIL_RE.exec(clause.slice(i))
      if (tailVerdict && /^[。．.！!？?；;，,、\s*_]*$/.test(clause.slice(i + tailVerdict[0].length))) return true
      // 无主语的句尾裁决词：证据不充分 / 方案不合格（S1 第二十八轮 P0-1）。
      // 但“算没过 / 视为未通过”是归类规则，不是本轮判定（G1.md:205 误伤）。
      const tailFailure = FAIL_VERDICT_RE.exec(clause.slice(i))
      if (tailFailure && !/^(?:pass|fail)$/i.test(tailFailure[0]) && !/(?:算|视为|视為|视作|視作|认定|認定|算作|记作|記作|记为|記為|属于|屬於|归为|歸為)$/.test(clause.slice(0, i)) && /^[。．.！!？?；;，,、\s*_]*$/.test(clause.slice(i + tailFailure[0].length))) return true
    }
  }
  return false
}

// 历史叙述不是本轮意见：只剔除“上一轮/前一轮/roundN … 本轮已整改”这一小段，
// 同一行里剩余的否定句仍照常扫描（S1 第二十一轮 P1）。
const HISTORICAL_REMEDIATION_RES = [
  /(?:历史记录\s*[：:]?\s*)?(?:上一轮|前一轮|round\s*\d{1,3})\s*(?:审计|審計|检查|复核|评审)?[^。\n]{0,120}?(?:本轮已整改|本轮已修复|本轮已收口|本轮已处理|本轮修复|已整改|已修复|已收口)/gi,
  /(?:the\s+)?previous\s+audit[^.\n]{0,120}?(?:this\s+round\s+is\s+(?:clean|fixed)|remediated)/gi,
]
// 历史句子只抹掉“上一轮……未通过”本身，保留它后面的全部文字。
// 这样“上一轮未通过，本轮审计未通过验收，本轮已整改”只能消掉前半句，
// 本轮否定与“结论：fail”仍会进入统一扫描器（S1 第二十二轮 P0-1/P0-2）。
const HISTORICAL_NEG_RE = new RegExp(
  ['failed to pass', 'did not pass', 'did not approve', 'not approved', 'not pass',
    '未获批准', '未能通过', '未获通过', '没有通过', '未获批', '未达标',
    '未通过收口', '未受理', '不予受理', '未接收', '不接受', '不予接受', '未接受',
    '部分通过', '有条件通过', '附条件通过', '待整改', '需整改', '仍需整改',
    '尚未整改', '有待整改', '待修复', '需修复', '暂缓', '搁置', '待定',
    '被否决', '被驳回', '未通过', '不通过', '没通过', '未过', 'fail']
    .sort((a, b) => b.length - a.length).map(regexEscape).join('|'),
  'i',
)
// 历史锚本身是“通过”时，匹配段里的第一个否定属于当前轮，不能当历史否定截掉
// （S1 第二十三轮 P0-1：上一轮已通过，本报告未通过验收）。
const HISTORICAL_POSITIVE_RE = /通过|通過|passing|passed|approved?/i
// 门正文里的历史段落：以“第N轮独立审计/round N audit”开头、含当轮否决的整句，
// 是在记录过去，不是本门当前结论（S1 第二十七轮 P1-1）。只剥整句，句后的本轮说明照常扫描。
// 只有带本轮整改说明的历史句才是叙述；裸写“第 N 轮判不通过”仍按本轮否决算
// （S1 第二十八轮 P0-4：历史剥离不能吞掉本轮 fail）。
const HISTORICAL_AUDIT_SENTENCE_RE = /^(?:[ \t]*[-*+][ \t]+)?(?:第[一二三四五六七八九十百\d]{1,4}轮|round\s*\d{1,3}(?:\s+audit)?)[^\n]*?(?:不通过|未通过|fail)[^\n]*?(?:这版|這一版|这一版|本轮已|本輪已|已整改|已修复|已修復|已收口|逐条整改|逐條整改|按[^\n]{0,40}整改)[^\n]*/i
function stripHistoricalAuditSentence(line: string): string {
  return line.replace(HISTORICAL_AUDIT_SENTENCE_RE, '')
}
function stripHistoricalRemediation(text: string): string {
  let out = text
  for (const re of HISTORICAL_REMEDIATION_RES) {
    out = out.replace(re, (match) => {
      const negative = HISTORICAL_NEG_RE.exec(match)
      if (negative) {
        const before = match.slice(0, negative.index)
        // 历史锚已经是通过态：否定只能算当前轮，整段保留给统一扫描器。
        if (HISTORICAL_POSITIVE_RE.test(before)) return match
        return match.slice(negative.index + negative[0].length)
      }
      // 没识别出历史否定时不整段删除，避免豁免范围失控。
      return match
    })
  }
  return out
}

function visibleFailStatement(line: string, scan: FailScan = {}): boolean {
  const text = stripHistoricalRemediation(line)
  // 计数不足与“存在未完成项”不是一个谓词否定，先在原文上判一次（S1 第二十七轮 P0-1、S2 第三十二轮 P0-1）。
  if (countingFailure(text)) return true
  return scanFailStatement(foldForVerdict(text), scan)
}
// 单元格强否决词：结论列里出现在格首或标点边界就算否决。
// 「无失败项」里的“失败”不在边界上，不会误伤；「不通过（3 项待补）」在格首，会被拦下。
const CELL_FAIL_VERDICTS_STRONG = [
  '不通过', '未通过', '没通过', '不能通过', '未能通过', '没有通过', '未得到通过',
  '未获通过', '未予通过', '通不过', '不是通过', '不合格', '未合格',
  '不成功', '未成功', '未达标', '不达标', '不批准', '未批准', '不获批准',
  '未获批准', '不予批准', '不予通过', '未获批', '未被批准', '未获审批', '不获审批',
  '未通过验收', '不通过验收', '未通过收口', '被否决', '否决', '已否决', '被驳回', '驳回',
  '已驳回', '被拒绝', '拒绝', '已拒绝', '被拒', '已拒', '不予采信', '不采信', '未完成整改', '整改未完成',
  '未完成修复', '未整改', '未修复', '未收口', '未受理', '不予受理',
  '未接收', '不接收', '未接受', '不予接受', '不接受', '不予放行', '不放行',
  '不予晋级', '不予准入', '不准入', '未准入', '失败', '退回', '已退回', '打回', '已打回',
  '被退回', '被打回',
  'fail', 'fails', 'failed', 'failing', 'failure', 'rejected', 'denied',
  'refused', 'vetoed', 'not pass', 'not passed', 'not successful', 'not succeeded',
  'not approved', 'no pass', 'unapproved', 'disapproved', 'unaccepted',
  'no approval', 'failed to pass', 'not recommend', 'recommend against',
  // 繁體表格与简体走同一张表，避免正文拦得住、表格拦不住。
  '未通過', '不通過', '沒通過', '不能通過', '未能通過', '沒有通過', '未得到通過',
  '未獲通過', '未予通過', '通不過', '不是通過', '未達標', '不達標', '不批准', '未批准',
  '不獲批准', '未獲批准', '不予批准', '不予通過', '未獲批', '未被批准', '未獲審批', '不獲審批',
  '未通過驗收', '不通過驗收', '未通過收口', '被否決', '否決', '已否決', '被駁回', '駁回', '已駁回',
  '被拒絕', '拒絕', '已拒絕', '被拒', '已拒', '不予採信', '不採信', '未完成整改', '整改未完成',
  '未完成修復', '未整改', '未修復', '未收口', '未受理', '不予受理', '未接收', '不接收', '未接受',
  '不予接受', '不接受', '不予放行', '不放行', '不予晉級', '不予准入', '不准入', '未准入', '失敗',
  '退回', '已退回', '打回', '已打回', '被退回', '被打回',
]
// 单元格弱裁决词：状态词，只有整格就是这个词才算数。
// blocked / incomplete / red / on hold 在门正文表格里常常是领域词（节点状态、错误码）。
const CELL_FAIL_VERDICTS_WEAK = [
  'blocked', 'incomplete', 'insufficient', 'inconclusive', 'no-go', 'nogo',
  'on hold', 'red', 'negative', 'partial', 'partially passed', 'conditional pass',
  'conditionally passed', 'pending',
  '部分通过', '有条件通过', '附条件通过', '暂缓', '搁置', '待定', '待整改',
  '需整改', '待修复', '需修复', '未完成', '不足', '不够', '不完整',
  '未就绪', '悬而未决', '保留意见', '待观察', '存疑', '有疑',
  // 繁體弱否决：表格与散文同一口径。
  '部分通過', '有條件通過', '附條件通過', '暫緩', '擱置', '待整改', '需整改',
  '待修復', '需修復', '未完成', '不足', '不夠', '不完整', '未就緒', '懸而未決',
  '保留意見', '待觀察', '存疑', '有疑',
  'declined', 'turned down', 'unsatisfactory', 'inadequate', 'unacceptable',
  'noncompliant', 'unready', 'not ready',
]
// 结论列的列名归一：这些列里的值就是结论本身。
// 允许「历史结论/本轮结论」这类前缀：历史行另有整行豁免，前缀不影响当前行判定。
const VERDICT_COLUMN_RE = /^(?:(?:历史|歷史|本轮|本輪|当前|當前|本次|当期|當期|审计|審計)\s*)?(?:结果|結果|结论|結論|判定|裁决|裁決|状态|狀態|verdicts?|conclusions?|results?|outcomes?|status|grade|是否通过|通過與否)$/i
// 非结论列里只有出现显式结论标记才按结论判。
const CELL_CONCLUSION_MARKER_RE = /(?:结论|結論|判定|审计意见|审计结论|最终结论|verdict|conclusion|outcome|result)s?\s*[：:—–-]/i

function isVerdictColumn(header: string): boolean {
  const normalized = header.trim().replace(/[*_]/g, '').replace(/\s+/g, '')
  if (normalized === '') return false
  return VERDICT_COLUMN_RE.test(normalized)
}

function cellStrongFail(folded: string): boolean {
  const haystack = folded.toLowerCase()
  for (const word of CELL_FAIL_VERDICTS_STRONG) {
    if (haystack.startsWith(word)) return true
    let index = haystack.indexOf(word)
    while (index > 0) {
      if (haystack[index - 1] === '|') return true
      index = haystack.indexOf(word, index + 1)
    }
  }
  return false
}

function cellWeakFail(folded: string): boolean {
  return CELL_FAIL_VERDICTS_WEAK.includes(folded.toLowerCase())
}

function matchesFailureWord(text: string): boolean {
  for (const word of [...CELL_FAIL_VERDICTS_STRONG, ...CELL_FAIL_VERDICTS_WEAK]) {
    const target = word.toLowerCase()
    if (text === target) return true
    // 同一格内的词间空白/标点会被 foldForVerdict 折成 |：未 通过、未|通过、未通过（本轮）
    // 都还是裸否决；「未通过项为空」在失败词后还有实词，不匹配。
    const body = Array.from(target)
      .map((ch) => (/[\p{L}\p{N}]/u.test(ch) ? regexEscape(ch) : '\\|*'))
      .join('\\|*')
    if (new RegExp('^' + body + '(?:\\||$)').test(text)) return true
  }
  return false
}

// 整格只有一个失败裁决词（允许前缀限定、括号说明或冒号理由，允许尾随标点）：
// 不管列名叫「结论」「备注」还是别的，它都不是描述性文字，攻击矩阵不能靠改列名把它豁免掉。
// 「未通过项为空」「失败项为空」这类名词短语不算裸裁决。
function isBareFailureCell(folded: string): boolean {
  let text = folded
    .trim()
    .replace(/[。；;，,、.!！?？]+$/g, '')
    .trim()
    .toLowerCase()
    .replace(/^\|+/, '')
  if (text === '') return false
  // 先按原样匹配：暂缓、暫緩 这类本身就是完整弱否决词，不能被单字前缀「暂/暫」剥成「缓」。
  if (matchesFailureWord(text)) return true
  for (let i = 0; i < 3; i += 1) {
    const next = text
      .replace(
        /^(?:本轮|本輪|当前|當前|本次|当期|當期|最终|最終|审计|審計|该审计|該審計|本报告|本報告|该项|本项|此项|此項|本項|該項|该门|該門|本门|本門|暂|暫|尚|仍|并|並|也|还|還|均|都)\s*/,
        '',
      )
      .replace(/^\|+/, '')
    if (next === text) break
    text = next
    if (matchesFailureWord(text)) return true
  }
  return false
}

function isExpectationColumn(header: string): boolean {
  return /(?:期望|预期|expected|expectation|should)/i.test(header)
}

// 攻击矩阵的描述/载荷列可以引用失败文案（例如“被拒文案：未通过”），
// 但「备注/说明/附注」不是描述列：里面若出现必过项否决，仍要判。
function isAttackDescriptionCell(cell: AuditCell): boolean {
  return /(?:攻击|用例|场景|输入|载荷|样本|案例|case|attack|scenario|payload|input)/i.test(cell.header)
    || /(?:被拒文案|拒绝文案|驳回文案|被拒载荷|已拒载荷|被拒原因|拒绝原因|拦截|拦下|攻击载荷|载荷|输入|尝试|样例|样本|应被拒|期望拒绝|被\s*blocked|blocked\s*by)/i.test(cell.text)
}

function isZeroFailurePhrase(folded: string): boolean {
  const compact = folded.replace(/\|/g, '')
  return /^(?:未通过|不通过|失败)项为(?:空|0)$/.test(compact)
}

function residualAfterRequiredItems(folded: string, requiredItems: string[]): string {
  let out = folded.toLowerCase()
  for (const id of requiredItems) {
    for (const needle of new Set([id.toLowerCase(), foldForVerdict(id).toLowerCase()])) {
      if (needle !== '') out = out.split(needle).join('|')
    }
  }
  out = out.replace(/\|+/g, '|').replace(/^\|+|\|+$/g, '')
  for (let i = 0; i < 3; i += 1) {
    const next = out
      .replace(/^\|+/, '')
      .replace(/^(?:必过项|必過項|通过项|通過項|该项|本项|此项|本項|該項|该门|本门|該門|本門)\|+/, '')
    if (next === out) break
    out = next
  }
  return out.replace(/^\|+|\|+$/g, '')
}

// 失败词被拆到相邻单元格：逐格都干净，拼起来才是“未通过”。
// 只认跨过单元格边界的那部分，整词落在单格里的仍交给 cellFailStatement，
// 避免把“未通过项为空”这类正常说明当成否决（S1 第三十七轮 P0）。
function splitFailureAcrossCells(row: AuditCell[]): boolean {
  const joined = row.map((cell) => cell.text).join('')
  const boundaries = new Set<number>()
  let offset = 0
  for (const cell of row) {
    offset += cell.text.length
    boundaries.add(offset)
  }
  for (const word of [...CELL_FAIL_VERDICTS_STRONG, ...CELL_FAIL_VERDICTS_WEAK]) {
    const re = new RegExp(regexEscape(word), 'gi')
    let match: RegExpExecArray | null
    while ((match = re.exec(joined)) !== null) {
      const start = match.index
      const end = start + match[0].length
      for (let at = start + 1; at < end; at += 1) {
        if (boundaries.has(at)) return true
      }
      if (match[0].length === 0) re.lastIndex += 1
    }
  }
  return false
}

// 单元格失败判定：表格单元格是片段，不是完整句子，只有两种情况算矛盾：
// (a) 单元格里出现显式结论行（“结论：fail”）；
// (b) 结论列里整格是强否决词，或整格是一个状态裁决词。
function cellFailStatement(cell: AuditCell): boolean {
  const folded = foldForVerdict(cell.text)
  if (isVerdictColumn(cell.header)) {
    if (visibleFailStatement(cell.text, { bareConclusion: 'any', bareVerdict: 'never' })) return true
    if (cellStrongFail(folded)) return true
    return cellWeakFail(folded)
  }
  if (!CELL_CONCLUSION_MARKER_RE.test(cell.text)) return false
  return visibleFailStatement(cell.text, { bareConclusion: 'any', bareVerdict: 'never' })
}

// 攻击/用例矩阵里的“拒 + 被拒文案”不是本轮否决：第 36 轮报告的攻击表写
// “G2-05 未通过 | 拒 | sign exit 1…”，整行拼接会把它当成当前必过项失败。
// 只豁免同时满足三点的行：表头是攻击/用例/场景、结论列是拒绝态、首格是攻击编号。
function isRejectedAttackRow(row: AuditCell[]): boolean {
  if (row.length === 0) return false
  const headerText = row.map((cell) => cell.header).join(' ')
  if (!/攻击|attack|用例|case|场景|scenario/i.test(headerText)) return false
  // 攻击矩阵常把“拒”写在「期望」列，而不是「结果」列；两列都认。
  const rejected = row.some((cell) => /期望|expected|预期|结果|结论|判定/i.test(cell.header)
    && /^(?:(?:期望|预期|应|应被|必须|需要|要求|expected?|should)\s*)?(?:拒|拒绝|已拒|已拒绝|禁止通过|拦下|拦截|blocked|rejected|denied)(?:\s*[（(][^）)]*[）)])?$/i.test(cell.text.trim()))
  if (!rejected) return false
  return /^(?:[A-Za-z]{1,4}[-_]?\d+[a-z]?|\d+)$/.test((row[0]?.text ?? '').trim())
}

// 散文行与表格单元格分层：散文按整句判，单元格按片段判。
function splitProseAndCells(visible: string[], cells: (AuditCell | null)[]): { prose: string[]; tableCells: AuditCell[] } {
  const prose: string[] = []
  const tableCells: AuditCell[] = []
  for (let i = 0; i < visible.length; i += 1) {
    const cell = cells[i] ?? null
    const text = visible[i] ?? ''
    if (cell === null) {
      prose.push(text)
      continue
    }
    if (cell.headerOnly) continue
    tableCells.push({ ...cell, text })
  }
  return { prose, tableCells }
}

// 单行内的否定：先只认句首裸否定；结论词开头的行再按完整主语扫一遍。
// 这样既能抓“不予采信本报告。”，又不会把历史审计叙述（第五轮……不通过）当成本轮否决。
function lineFailure(line: string): boolean {
  if (visibleFailStatement(line, { bareConclusion: 'never' })) return true
  const conclusionLead = /^(?:审计|audit\s+)?(?:结论|結論|判定|审计意见|最终判定|最终结论|最終結論|conclusions?|verdict|outcomes?|results?)/i
  return conclusionLead.test(line) && visibleFailStatement(line)
}

// 引用定义（[1]: …）不参与渲染，但里面藏着的否决不能因此消失：
// 定义块里出现正式的“结论：fail/不通过”等按歧义拒绝（S2 第三十轮 P2）。
const DEFINITION_DEST = '<[^>]*>|(?:https?://|/|\\.{1,2}/)[^\\s]*|[\\w.-]+\\.[a-z]{2,4}\\b[^\\s]*'
function stripDefinitionContainers(line: string): string {
  let out = line
  // 容器层数不设固定上限：每一轮至少吃掉一个标记，长度有限所以必然收敛。
  for (;;) {
    const next = out.replace(/^[ \t]*(?:>[ \t]*|[-*+][ \t]+|\d+[.)][ \t]+)/, '')
    if (next === out) break
    out = next
  }
  return out.trim()
}
function stripDefinitionDestination(line: string): string {
  return line.replace(new RegExp('^(\\[[^\\]]*\\]\\s*:\\s*)(?:' + DEFINITION_DEST + ')', 'i'), '$1')
}
// HTML 注释在渲染视图里不可见，但把“结论：fail”藏进注释仍是隐藏判定（S1 第三十七轮 P1-2）。
// 只拦“结论词 + 失败词”同现的注释：普通说明性注释、结构化裁决标记不误伤。
function hiddenCommentFailure(text: string): boolean {
  // 围栏代码里的注释是示例，不是正文，先掩掉再扫。
  const masked = maskFencedAuditCode(text)
  const comment = /<!--([\s\S]*?)-->/g
  const bodies: string[] = []
  let match: RegExpExecArray | null
  while ((match = comment.exec(masked)) !== null) {
    bodies.push(decodeHtmlEntitiesForInspection(match[1] ?? ''))
  }
  // 多条注释要合起来看：把“结论词”和“fail”拆到两条注释里同样是隐藏判定
  // （S1/S2 第三十八轮 P2）。只写“必过项 G1-01 未通过”、不写结论词的注释也拦。
  const all = bodies.join('\n')
  const hasConclusion = /(?:结论|結論|判定|审计意见|审计結論|最终判定|最终结论|最終結論|(?:audit\s+)?(?:conclusions?|verdict|outcomes?|results?))/i.test(all)
  const hasFailure = /(?:\b(?:fail(?:ed|ure|s)?|reject(?:ed|s)?|den(?:y|ied|ies))\b|不通过|未通过|没通过|否决|驳回|失败|不合格)/i.test(all)
  const hasMustPass = /(?:必过项|必過項|must[- ]?pass|G\d+-\d+)/i.test(all)
  return hasFailure && (hasConclusion || hasMustPass)
}

function hiddenDefinitionFailure(text: string): boolean {
  if (hiddenCommentFailure(text)) return true
  const lines = text.split(/\r?\n/)
  let inBlock = false
  for (const raw of lines) {
    const line = stripDefinitionContainers(raw)
    if (line === '') { inBlock = false; continue }
    if (!inBlock) {
      if (/^\[[^\]]+\]:/.test(line) || /^\[[^\]]+$/.test(line)) inBlock = true
      else continue
    }
    const body = /^\[[^\]]+\]:/.test(line) ? stripDefinitionDestination(line) : line
    const decoded = decodeHtmlEntitiesForInspection(body)
    // 引用定义本身不可见：定义块里只要同时出现判定词与 pass/fail，无论中间是冒号、
    // 句点还是别的分隔，都按隐藏结论拒绝（S1 第二十七轮 P2-2、R-H4）。
    if (/(?:结论|結論|判定|审计意见|最終結論|最终结论|conclusions?|verdict|outcomes?|results?)/i.test(decoded)
      && /(?:\b(?:pass|fail(?:ed|ure|s)?|reject(?:ed|s)?|den(?:y|ied|ies))\b|不通过|未通过|通过|否决|驳回)/i.test(decoded)) return true
    if (lineFailure(decoded) || visibleFailStatement(decoded, { bareConclusion: 'any' })) return true
  }
  return false
}

export function auditConclusionOf(text: string): 'pass' | 'fail' | null {
  if (hiddenDefinitionFailure(text)) return null
  const rendered = renderedAuditWithCells(text)
  if (rendered === null) return null
  // 报告侧同样只剥“历史轮次 + 本轮已整改”的叙述，保持与门正文同口径（S1 第二十八轮 P1-2）。
  const visible = rendered.lines.map(stripHistoricalAuditSentence)
  // 散文行与表格单元格分层判定：单元格是片段，不能当散文裁决（S2 第四轮整改）。
  const { prose, tableCells } = splitProseAndCells(visible, rendered.cells)
  let verdict: 'pass' | 'fail' | null = null
  let inlineFail = false
  // 英文审计报告同样用 Conclusion/Verdict/Outcome 开结论行（S2 第二十七轮 P0-2）。
  const conclusionText = /(?:结论|結論|判定|审计意见|最终判定|最终结论|最終結論|(?:audit\s+)?(?:conclusions?|verdict|outcomes?|results?))\s*[：:—–-]/i
  const conclusionWord = /^(?:审计|audit\s+)?(?:结论|結論|判定|审计意见|最终判定|最终结论|最終結論|conclusions?|verdict|outcomes?|results?)$/i
  // 先把所有可见行按行边界拼起来做一次全文扫描：跨越任意多行的拆词都能命中。
  if (visibleFailStatement(prose.join('|'))) inlineFail = true
  // 句首无主语的否定（“不予采信本报告。”）只在单行内成立；拼行扫描看不到行首，补一遍逐行。
  for (const line of prose) if (lineFailure(line)) inlineFail = true
  // 表格单元格另按单元格口径判定：只有结论列里的否决词与显式结论行才算矛盾。
  for (const cell of tableCells) if (cellFailStatement(cell)) inlineFail = true
  for (let visibleIndex = 0; visibleIndex < prose.length; visibleIndex += 1) {
    const line = prose[visibleIndex]!
    // 中文结论行即使值不合法也要按歧义拒绝；英文只在紧跟 pass/fail 时才当正式结论，
    // 避免把正文里的 “Conclusion: the design is sound” 误判成结论行。
    const strict = /^(?:审计)?(?:结论|結論|判定|审计意见|最终判定|最终结论|最終結論)\s*[：:—–-]/.test(line)
      || /^(?:audit\s+)?(?:conclusions?|verdict|outcomes?|results?)\s*[：:—–-]\s*(?:pass|fail)\b/i.test(line)
    const bare = /^(?:pass|fail|通过|不通过)$/i.test(line)
    if (!strict && !bare) {
      // 全文扫描已经在循环外完成；这里只保留链接定义与“结论”/“：fail”拆行的歧义判定。
      // 链接/引用定义段落里的可见“结论：”不能靠另一段干净 pass 洗掉（S2 第二十轮 def-*）；
      // 普通正文里提到“结论：”只是行内引用，不影响后面的正式结论行。
      if (line.includes('[') && conclusionText.test(line)) return null
      // 结论词被换行拆成“结论” + “：fail”时，下一行以冒号开头，按歧义处理。
      if (conclusionWord.test(line.trim())) {
        const next = prose[visibleIndex + 1] ?? ''
        if (/^\s*[：:]/.test(next)) return null
      }
      continue
    }
    // 只允许一行结论：第二行无论同向还是反向都按歧义处理。
    if (verdict !== null) return null
    if (bare) {
      verdict = rawVerdict(line)
      continue
    }
    const m = /^(?:审计|audit\s+)?(?:结论|結論|判定|审计意见|最终判定|最终结论|最終結論|conclusions?|verdict|outcomes?|results?)\s*[：:—–-]\s*(?:\*\*)?\s*(pass|fail|通过|不通过)(.*)$/i.exec(line)
    if (!m) return null
    const raw = (m[1] ?? '').toLowerCase()
    const v = raw === 'pass' || raw === '通过' ? 'pass' : 'fail'
    if (!validConclusionTail(m[2] ?? '', v)) return null
    verdict = v
  }
  if (verdict === 'pass' && inlineFail) return null
  return verdict
}

// 表格里的历史审计记录不是本轮结论（S2 第三十七轮 P0-02）：
// 轮次列 + 轮次数字，且没有「本轮/当前轮」标记，才按历史行跳过。
// 给了当前轮次时只认严格更早的轮次，防止把「Round 37 | fail」藏进历史表。
// 中文数字轮次（第三十五轮）也要认，否则历史行会被当成本轮（S1 第三十七轮 P2）。
function chineseNumber(text: string): number | null {
  const digits: Record<string, number> = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
  }
  let total = 0
  let current = 0
  let seen = false
  for (const ch of text) {
    const digit = digits[ch]
    if (digit !== undefined) { current = digit; seen = true; continue }
    if (ch === '十') { total += (current === 0 ? 1 : current) * 10; current = 0; seen = true; continue }
    if (ch === '百') { total += (current === 0 ? 1 : current) * 100; current = 0; seen = true; continue }
    return null
  }
  return seen ? total + current : null
}

function tableRoundNumber(cell: AuditCell): number | null {
  const text = cell.text.trim()
  const arabic = /^(?:第\s*)?(\d{1,3})\s*轮$/i.exec(text) ?? /^round\s*(\d{1,3})(?:\s+audit)?$/i.exec(text)
  if (arabic) return Number(arabic[1])
  const chinese = /^第\s*([零〇一二三四五六七八九十百两]+)\s*[轮輪]$/.exec(text)
  if (chinese) return chineseNumber(chinese[1] ?? '')
  if (/轮次|轮|round|审计|history|历史/i.test(cell.header) && /^\d{1,3}$/.test(text)) return Number(text)
  return null
}

function historicalTableRows(cells: AuditCell[], auditRound?: number): Set<string> {
  const rows = new Map<string, AuditCell[]>()
  for (const cell of cells) {
    const key = String(cell.tableIndex) + ':' + String(cell.rowIndex)
    const list = rows.get(key)
    if (list) list.push(cell)
    else rows.set(key, [cell])
  }
  const historical = new Set<string>()
  for (const [key, row] of rows) {
    const text = row.map((cell) => cell.text).join(' | ')
    // 自己写了「本轮/当前轮」的行不能按历史放行。
    if (/本轮|本輪|当前轮|當前輪|本次审计|本次審計|this\s+round|current\s+round/i.test(text)) continue
    const rounds = row.map(tableRoundNumber).filter((n): n is number => n !== null)
    if (rounds.length === 0) continue
    if (!row.some((cell) => /轮次|轮|round|审计|history|历史|previous/i.test(cell.header))) continue
    const newest = Math.max(...rounds)
    if (auditRound === undefined || newest < auditRound) historical.add(key)
  }
  return historical
}

// 原始 Markdown 表格行不受渲染器截列影响：3 列表头写 4 格时，markdown-it 会丢掉第 4 格，
// 但原文仍在，按渲染结果检查就会漏（S1 第三十七轮 P1-1）。这里直接按源码数格。
function splitTableRowCells(line: string): string[] {
  let body = line.trim().replace(/^(?:>\s*)+/, '')
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!
    if (ch === '\\' && body[i + 1] === '|') { current += '|'; i += 1; continue }
    if (ch === '|') { cells.push(current); current = ''; continue }
    current += ch
  }
  cells.push(current)
  return cells
}

function isTableDelimiterRow(line: string): boolean {
  const cells = splitTableRowCells(line)
  // GFM 的分隔行只要求每格至少一个连字符；markdown-it 对 `| - | - | - |` 同样渲染成表格。
  // 只认三个以上会让这种写法绕过源码数格，溢出列又被渲染器丢掉（S1/S2 第三十八轮 P1）。
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()))
}

function rawTableOverflowIssues(text: string): string[] {
  const lines = maskHtmlComments(maskFencedAuditCode(text)).split('\n')
  const issues: string[] = []
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const header = lines[i]!
    if (!header.includes('|') || !isTableDelimiterRow(lines[i + 1]!)) continue
    const headerCount = splitTableRowCells(header).length
    let j = i + 2
    while (j < lines.length && lines[j]!.trim() !== '' && lines[j]!.includes('|')) {
      if (!isTableDelimiterRow(lines[j]!)) {
        const count = splitTableRowCells(lines[j]!).length
        if (count > headerCount) {
          issues.push('审计报告表格第 ' + String(j + 1) + ' 行有 ' + String(count) + ' 格，超过表头的 ' + String(headerCount) + ' 格')
        }
      }
      j += 1
    }
    i = j - 1
  }
  return [...new Set(issues)]
}

// 裁决块写 pass 时正文不能同时唱反调（S2 第三十五轮 P2-1）：
// 以前只在 auditConclusionOf 返回非 null 时才比对，正文写成「两行结论」或「某项未通过」时
// 该函数返回 null，一致性检查被静默跳过，改正文就能签过门。这里独立扫四类背离：
// 结论行不唯一、结论行与裁决相反、必过项在散文里被写成未通过、
// 表格单元格（结论列/必过项/显式结论标记）与裁决相反（S2 第三十六轮 A4/A5）。
// 必过项与表格扫描只在 verdict === 'pass' 时执行：fail 裁决下这些内容不构成矛盾（P2-2）。
export function proseVerdictClashes(
  text: string,
  verdict: 'pass' | 'fail',
  requiredItems: string[],
  opts: { auditRound?: number } = {},
): string[] {
  const clashes: string[] = []
  if (hiddenDefinitionFailure(text)) return ['正文藏着看不见的判定']
  // 溢出列不是在渲染视图里被截掉就算没事：原文有、表头没写，按畸形表格直接拒。
  for (const issue of rawTableOverflowIssues(text)) clashes.push(issue)
  const rendered = renderedAuditWithCells(text)
  if (rendered === null) return ['正文渲染失败，无法核对结论']
  const visible = rendered.lines.map(stripHistoricalAuditSentence)
  const { prose, tableCells } = splitProseAndCells(visible, rendered.cells)
  const strictLead = /^(?:审计)?(?:结论|結論|判定|审计意见|最终判定|最终结论|最終結論)\s*[：:—–-]\s*(?:\*\*)?\s*(pass|fail|通过|不通过)/i
  const englishLead = /^(?:audit\s+)?(?:conclusions?|verdict|outcomes?|results?)\s*[：:—–-]\s*(?:\*\*)?\s*(pass|fail)\b/i
  const bareLead = /^(?:pass|fail|通过|不通过)$/i
  const seen: ('pass' | 'fail')[] = []
  for (const line of prose) {
    const raw = strictLead.exec(line)?.[1] ?? englishLead.exec(line)?.[1] ?? (bareLead.test(line.trim()) ? line.trim() : undefined)
    if (raw === undefined) continue
    seen.push(/^(?:pass|通过)$/i.test(raw) ? 'pass' : 'fail')
  }
  if (seen.length > 1) clashes.push('正文出现 ' + String(seen.length) + ' 条结论行（' + seen.join('、') + '），结论必须唯一')
  else if (seen.length === 1 && seen[0] !== verdict) clashes.push('正文结论行是 ' + String(seen[0]) + '，裁决是 ' + verdict)
  if (verdict === 'pass') {
    for (const line of prose) {
      const hit = requiredItems.filter((id) => line.includes(id))
      if (hit.length === 0) continue
      if (lineFailure(line) || visibleFailStatement(line, { bareConclusion: 'any' })) {
        clashes.push('正文把必过项 ' + hit.join('、') + ' 写成未通过，裁决却是 ' + String(verdict))
      }
    }
    // 表格单元格以前整批被丢掉，A4/A5 因此能签过（S2 第三十六轮 P2-1）。
    // 只判三类格：结论列、带显式结论标记的格、点名必过项的格；领域词与故障场景不误伤。
    // 必过项可能写在同行另一格（A4：必过项 G2-11 | 结果 未通过），所以按整行收集命中的 id。
    const historical = historicalTableRows(tableCells, opts.auditRound)
    const rows = new Map<string, AuditCell[]>()
    for (const cell of tableCells) {
      const key = String(cell.tableIndex) + ':' + String(cell.rowIndex)
      const list = rows.get(key)
      if (list) list.push(cell)
      else rows.set(key, [cell])
    }
    for (const [key, row] of rows) {
      if (historical.has(key)) continue
      // 攻击矩阵只豁免“描述攻击”的普通格；结论列仍然要判，否则
      // `| A1 | G2-11 | 拒 | 未通过 |` 会把当前否决藏进用例表（S2 第三十九轮 P1）。
      const rejectedAttack = isRejectedAttackRow(row)
      // 同一行内去掉分隔符再拼一次：否定词与必过项 id 被拆到相邻格时，逐格判各自都干净。
      // 行内点名了必过项、且失败词被单元格边界切开时，按矛盾拒（S1 第三十七轮 P0）。
      const joined = row.map((cell) => cell.text).join('')
      const hit = requiredItems.filter((id) => joined.includes(id))
      // 只把“失败词被单元格边界切开”当作跨格矛盾；整行再跑一遍失败扫描会把
      // 要求列里的领域词（例如「无裸 blocked」）和正常的「通过」拼成假否决（S2 第三十八轮 P2）。
      const joinedFail = !rejectedAttack && splitFailureAcrossCells(row)
      if (joinedFail && hit.length > 0) {
        clashes.push('审计报告表格把必过项 ' + hit.join('、') + ' 写成未通过，裁决却是 ' + String(verdict))
      } else if (joinedFail && row.some((cell) => isVerdictColumn(cell.header) || CELL_CONCLUSION_MARKER_RE.test(cell.text))) {
        clashes.push('审计报告表格结论与裁决 ' + String(verdict) + ' 冲突：' + joined.slice(0, 60))
      }
      for (const cell of row) {
        const conclusionCell = isVerdictColumn(cell.header) || CELL_CONCLUSION_MARKER_RE.test(cell.text)
        if (hit.length === 0 && !conclusionCell) continue
        // 攻击行的描述/证据格可以引用失败文案；但结论列不能被整行豁免。
        // 列名可以改，「备注」里只写「未通过」这种裸否决仍要判。
        const bareFailure = isBareFailureCell(foldForVerdict(cell.text))
        const expectationCell = isExpectationColumn(cell.header)
        const descriptionCell = !conclusionCell && isAttackDescriptionCell(cell)
        const zeroFailure = isZeroFailurePhrase(foldForVerdict(cell.text))
        if (rejectedAttack && (expectationCell || descriptionCell || zeroFailure)) continue
        // 非结论列里点名必过项的否决：先去掉 id，再看剩余部分是否仍是整格裁决。
        // 这样「G2-07 | S2 加载 parallel 被拒 | 通过」这种覆盖点描述不会被当成否决，
        // 「G2-11 未通过」仍会被拦下（S1 第四十二轮 P1-1/P1-2）。
        const residual = residualAfterRequiredItems(foldForVerdict(cell.text), requiredItems)
        const residualFail = residual !== '' && isBareFailureCell(residual)
        const cellFails = cellFailStatement(cell)
          || (bareFailure && (rejectedAttack || conclusionCell || hit.length > 0))
          || (!conclusionCell && hit.length > 0 && residualFail)
        if (cellFails) {
          clashes.push(hit.length > 0
            ? '审计报告表格把必过项 ' + hit.join('、') + ' 写成未通过，裁决却是 ' + String(verdict)
            : '审计报告表格结论与裁决 ' + String(verdict) + ' 冲突：' + cell.text.slice(0, 60))
        }
      }
    }
  }
  return [...new Set(clashes)]
}

// 门记录正文顶部的结论行必须与 GateArtifact 的 conclusion 一致：
// 防止 artifact 写 pass、人读正文却看到 fail（S1 第十七轮 P2-1）。
export function bodyConclusionOf(text: string): 'pass' | 'fail' | null {
  if (hiddenDefinitionFailure(text)) return 'fail'
  const rendered = renderedAuditWithCells(text)
  if (rendered === null) return null
  // 历史审计叙述不是本门当前结论：整句剥掉后再扫（S1 第二十七轮 P1-1）。
  const visible = rendered.lines.map(stripHistoricalAuditSentence)
  // 散文行与表格单元格分层判定：单元格是片段，不能当散文裁决（S2 第四轮整改）。
  const { prose, tableCells } = splitProseAndCells(visible, rendered.cells)
  const found: Array<'pass' | 'fail'> = []
  for (const line of prose) {
    const m = /^(?:审计|audit\s+)?(?:结论|結論|判定|审计意见|最终判定|最终结论|最終結論|conclusions?|verdict|outcomes?|results?)\s*[：:—–-]\s*(?:\*\*)?\s*(pass|fail|通过|不通过)([\s\S]*)$/i.exec(line)
    if (m) {
      const v = rawVerdict(m[1] ?? '')
      // 门正文结论行的尾巴必须与报告侧同源校验：pass 后面再挂 caveat 不能签过（S1 第二十七轮 P0-2、S2 第三十二轮 P1-1）。
      if (!validConclusionTail(m[2] ?? '', v)) return 'fail'
      // 正文结论写 pass、同一行尾巴再写 fail/否决的，按 fail 收口（S2 第二十七轮 P0-2 同族）。
      if (v === 'pass' && /\b(?:fail|failed|failure)\b|不通过|未通过|未过|否决|驳回|拒绝|拒收|不予|未获|未予/i.test(line)) return 'fail'
      found.push(v)
    }
  }
  // 正文不再按 160 字/24 字偏移截窗：长行和靠后的否定句同样能签过（S1 第二十轮 P0-4）。
  // 历史段落里“门记录拿结论为 fail”这类叙述用裸“结论”会误杀，所以全文扫描排除
  // 裸结论主语；历史前缀截掉后，正文里出现正式“结论：fail”的行再补一次精确判定。
  if (visibleFailStatement(prose.join('|'), { bareConclusion: 'never' })) return 'fail'
  // 句首无主语的否定同样要在门正文里算数（S2 第二十九轮 P0 的 A2 门正文注入）。
  for (const line of prose) if (lineFailure(line)) return 'fail'
  for (const line of prose) {
    // 历史前缀已经在 strip 阶段截掉；剩余正文里出现正式的“结论：fail”
    // 就是本轮否决，即使它前面还有别的文字（S1 第二十二轮 P0-2）。
    if (/(?:结论|結論|判定)\s*[：:]/.test(line) && visibleFailStatement(line)) return 'fail'
  }
  // 表格单元格按单元格口径判定：只有结论列里的否决词与显式结论行才算门正文失败。
  for (const cell of tableCells) if (cellFailStatement(cell)) return 'fail'
  return found.length === 1 ? found[0]! : null
}

// 审计报告绑定门名与候选提交：只读顶层可见行，防止拿别轮/别门的 pass 报告复用。
// 报告必须各出现一次「门：G1」与「候选提交：<40 位 commit>」（S1 第八轮 P1-2）。
export function auditBindingOf(text: string): { gate: string; commit: string } | null {
  const visible = renderedAuditLines(text)
  if (visible === null) return null
  const gates: string[] = []
  const commits: string[] = []
  for (const line of visible) {
    const gate = /^(?:门|gate)\s*[：:]\s*(G[1-5])\s*$/i.exec(line)
    if (gate) gates.push((gate[1] ?? '').toUpperCase())
    const commit = /^(?:候选提交|候选|candidate_commit|candidate)\s*[：:]\s*([0-9a-f]{40})\s*$/i.exec(line)
    if (commit) commits.push((commit[1] ?? '').toLowerCase())
  }
  if (gates.length !== 1 || commits.length !== 1) return null
  return { gate: gates[0] as string, commit: commits[0] as string }
}

// Markdown 会把 HTML 实体渲染成字符；判定前先按渲染结果解码，否则
// '&#32467;&#35770;&#65306;fail' 这种可见结论会被漏掉（S1 第十五轮补）。
function decodeHtmlEntitiesForInspection(line: string): string {
  // markdown-it 的 unescapeAll 覆盖全部命名实体与数字实体（S2 第三十二轮 P0-2）。
  return AUDIT_MARKDOWN.utils.unescapeAll(line)
    .replace(/&(amp|lt|gt|quot|apos|nbsp|colon|newline|tab);/gi, (m, name: string) => {
      const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', colon: ':', newline: '\n', tab: '\t' }
      return map[name.toLowerCase()] ?? m
    })
}

// 只返回顶层可见行：去掉隐藏块，跳过围栏/缩进代码/引用围栏，保留普通引用与列表。
function auditTopLevelLines(text: string): string[] {
  const lines = stripHiddenAuditBlocks(text).split(/\r?\n/)
  const out: string[] = []
  let fence: { char: string; length: number } | null = null
  let quoteFence: { char: string; length: number } | null = null
  for (const rawLine of lines) {
    // Markdown 缩进代码：最多 3 个空格后接 Tab，或 4 个以上空格（空格+Tab 也算）。
    if (/^(?: {0,3}\t| {4,})/.test(rawLine)) continue
    const quote = /^\s*>( ?)([\s\S]*)$/.exec(rawLine)
    if (quote) {
      const inner = quote[2] ?? ''
      // 引用块内的缩进代码同样不可见；引用标记后已吃掉一个空格，剩 3 个空格也算代码。
      if (/^(?: {0,3}\t| {3,})/.test(inner)) continue
      const qf = fenceMarkerOf(inner)
      if (qf) {
        if (!quoteFence) quoteFence = { char: qf.char, length: qf.length }
        else if (qf.char === quoteFence.char && qf.length >= quoteFence.length && qf.rest.trim() === '') quoteFence = null
        continue
      }
      if (quoteFence) continue
    } else if (quoteFence) {
      quoteFence = null
    }
    const fm = fenceMarkerOf(rawLine)
    if (fm) {
      if (!fence) fence = { char: fm.char, length: fm.length }
      else if (fm.char === fence.char && fm.length >= fence.length && fm.rest.trim() === '') fence = null
      continue
    }
    if (fence) continue
    for (const decoded of decodeHtmlEntitiesForInspection(rawLine).split('\n')) out.push(normalizeAuditLine(decoded))
  }
  return out
}

function blankPreservingLines(text: string): string {
  let n = 0
  for (const ch of text) if (ch === '\n') n += 1
  return '\u0000' + '\n'.repeat(n)
}

// CommonMark 的空行只认空格与 Tab；U+00A0、U+2003、U+3000、BOM 等都不是空行。
function isMarkdownBlankLine(line: string): boolean {
  return /^[ \t]*$/.test(line)
}

// 反引号围栏的 info string 里不能出现反引号；这种行在 CommonMark 里不是围栏。
function fenceMarkerOf(body: string): { char: string; length: number; rest: string } | null {
  const m = /^( {0,3})(\x60{3,}|~{3,})(.*)$/.exec(body)
  if (!m) return null
  const marker = m[2] ?? ''
  const rest = m[3] ?? ''
  if (marker.charAt(0) === '\x60' && rest.includes('\x60')) return null
  return { char: marker.charAt(0), length: marker.length, rest }
}

// 围栏可以开在列表项或引用块里：`- ~~~`、`1. \x60\x60\x60`、`> - ~~~` 的首行
// 去掉容器前缀后才是围栏标记。只对“开栏”去掉列表标记；关栏时不能去，
// 否则围栏内容里的 `- ~~~` 会被误当成关栏，后面的隐藏段落就会漏出来（S1 第十六轮 P1-1）。
function stripQuoteContainer(line: string): string | null {
  const q = /^ {0,3}> ?/.exec(line)
  return q ? line.slice(q[0].length) : null
}

function stripListContainer(body: string): string | null {
  const l = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(body)
  return l ? body.slice(l[0].length) : null
}

function openingFenceInContainer(line: string): { char: string; length: number; quoted: boolean } | null {
  let body = line
  let quoted = false
  const quotedBody = stripQuoteContainer(body)
  if (quotedBody !== null) {
    quoted = true
    body = quotedBody
  }
  for (let depth = 0; depth < 8; depth += 1) {
    const inner = stripListContainer(body)
    if (inner === null) break
    body = inner
  }
  const marker = fenceMarkerOf(body)
  return marker ? { char: marker.char, length: marker.length, quoted } : null
}

function closesFenceInContainer(
  line: string,
  fence: { char: string; length: number; quoted: boolean },
): boolean {
  let body = line
  if (fence.quoted) {
    const quotedBody = stripQuoteContainer(body)
    if (quotedBody === null) return false
    body = quotedBody
  } else if (stripQuoteContainer(body) !== null) {
    // 未加引用的围栏内容里，以 `>` 开头的行仍是内容，不是关栏。
    return false
  }
  const marker = fenceMarkerOf(body)
  // 关闭围栏的后缀只允许空格或 Tab；NBSP、U+3000、U+FEFF 都不是 CommonMark 空白。
  return marker !== null
    && marker.char === fence.char
    && marker.length >= fence.length
    && /^[ \t]*$/.test(marker.rest)
}

// 围栏代码整段不可见：里面的字面标签不能参与 HTML 配对（S1 第十轮 P1-1）。
function maskFencedAuditCode(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fence: { char: string; length: number; quoted: boolean } | null = null
  for (const line of lines) {
    if (fence) {
      if (fence.quoted && stripQuoteContainer(line) === null) {
        fence = null
      } else {
        out.push(blankPreservingLines(line))
        if (closesFenceInContainer(line, fence)) fence = null
        continue
      }
    }
    const opening = openingFenceInContainer(line)
    if (opening) {
      fence = opening
      out.push(blankPreservingLines(line))
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

// 缩进代码里的标签同样只是字面文本。
// 但四空格缩进在列表项里只是续行，渲染器仍显示；段落中间的四空格也不是代码。
// 只有“空行之后、且不在列表里”的缩进块才是确定的代码块；其余缩进块里出现结论行
// 就不能静默藏掉，否则可见的 fail 会被另一段 pass 洗掉（S1 第十五轮 P1-C）。
function maskIndentedAuditCode(text: string): { masked: string; poisoned: boolean } {
  const lines = text.split('\n')
  const out: string[] = []
  let poisoned = false
  let inList = false
  let previousBlank = true
  let pending: string[] = []
  let pendingPoisonable = false
  const flush = (): void => {
    if (pending.length === 0) return
    if (pendingPoisonable) {
      const joined = pending.join('\n')
      if (/(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]/.test(joined) || pending.some((l) => /^(?:pass|fail|通过|不通过)$/i.test(l))) poisoned = true
    }
    pending = []
  }
  for (const line of lines) {
    const quote = /^\s*>\s?/.exec(line)
    const body = quote ? line.slice(quote[0].length) : line
    const blank = isMarkdownBlankLine(line)
    const indented = /^(?: {0,3}\t| {4,})/.test(body)
    if (!indented) {
      flush()
      if (!blank) {
        if (/^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/.test(body)) {
          inList = true
        } else if (previousBlank && /^[^ \t]/.test(body)) {
          // 空行后回到顶格的普通段落/标题，列表已经结束。
          inList = false
        }
      }
      previousBlank = blank
      out.push(line)
      continue
    }
    if (pending.length === 0) pendingPoisonable = inList || !previousBlank
    pending.push(normalizeAuditLine(body))
    previousBlank = false
    out.push(blankPreservingLines(line))
  }
  flush()
  return { masked: out.join('\n'), poisoned }
}

// 行内代码会把标签转义成字面文本；先整段抹掉，避免假的闭合标签提前收掉隐藏块。
function maskInlineCodeInParagraph(text: string): { masked: string; poisoned: boolean } {
  let out = ''
  let poisoned = false
  let i = 0
  while (i < text.length) {
    if (text.charAt(i) !== '\x60') {
      out += text.charAt(i)
      i += 1
      continue
    }
    let j = i
    while (text.charAt(j) === '\x60') j += 1
    const width = j - i
    let k = j
    let close = -1
    while (k < text.length) {
      if (text.charAt(k) === '\x60') {
        let q = k
        while (text.charAt(q) === '\x60') q += 1
        if (q - k === width) {
          close = q
          break
        }
        k = q
      } else {
        k += 1
      }
    }
    if (close < 0) {
      out += text.slice(i, j)
      i = j
      continue
    }
    // 反引号跨行时，CommonMark 仍可能因块边界把两端拆开；一旦这段被判成代码，
    // 里面的结论行就会被藏掉。跨行代码段里只要出现结论行就毒化，宁可不可判定，
    // 也不让被藏起来的 fail 输给另一段可见的 pass（S1 第十五轮补）。
    const raw = text.slice(i, close)
    if (raw.includes('\n')) {
      for (const line of raw.split('\n')) {
        const normalized = normalizeAuditLine(line)
        if (/(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]/.test(normalized) || /^(?:pass|fail|通过|不通过)$/i.test(normalized)) {
          poisoned = true
          break
        }
      }
    }
    out += blankPreservingLines(raw)
    i = close
  }
  return { masked: out, poisoned }
}

// 行内代码不能跨空行；先按 CommonMark 段落切开，再在段内配对反引号。
// 否则前段一个孤立反引号会和后段链接 title 里的反引号配对，把真实的 '[' 一起抹掉（S1 第十四轮 P1-2）。
function maskInlineAuditCode(text: string): { masked: string; poisoned: boolean } {
  const lines = text.split('\n')
  const out: string[] = []
  let paragraph: string[] = []
  let poisoned = false
  const flush = (): void => {
    if (paragraph.length === 0) return
    const part = maskInlineCodeInParagraph(paragraph.join('\n'))
    out.push(...part.masked.split('\n'))
    poisoned = poisoned || part.poisoned
    paragraph = []
  }
  for (const line of lines) {
    if (isMarkdownBlankLine(line)) {
      flush()
      out.push(line)
    } else {
      paragraph.push(line)
    }
  }
  flush()
  return { masked: out.join('\n'), poisoned }
}

// 合法 CDATA 段不参与渲染；检查隐藏段里的结论字样时先剔掉这些段，
// 否则 CDATA 里的 pass 会被误判为毒化（S1 第十四轮 P2-1）。
function stripCdataSpansForInspection(lines: string[]): string[] {
  const text = lines.join('\n')
  const lower = text.toLowerCase()
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const start = lower.indexOf('<![cdata[', cursor)
    if (start < 0) {
      out += text.slice(cursor)
      break
    }
    const end = lower.indexOf(']]>', start + 9)
    // 未闭合的 CDATA 不剔除：保留原文，让毒化逻辑兜底，避免隐藏段里的 fail 被静默放过。
    if (end < 0) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, start)
    const hidden = text.slice(start, end + 3)
    out += '\n'.repeat((hidden.match(/\n/g) ?? []).length)
    cursor = end + 3
  }
  return out.split('\n')
}

// 链接目标、title、图片 alt 与引用定义都不参与正文渲染，里面写标签也不能生效。
// 这些结构都只能在同一个段落内跨行（CommonMark 不允许空行），所以按段落整体隐藏：
// 宁可把同段的可见文字也藏掉，也不把渲染器隐藏的结论放进来（fail-closed）。
function visibleTextOfLinkParagraph(text: string): string {
  const kept: string[] = []
  let inDefinition = false
  let atParagraphStart = true
  for (const line of text.split('\n')) {
    // CommonMark 只把段落开头的方括号定义当引用定义；段落中间同形状的行是可见正文，
    // 不能整行删掉，否则 title 里写结论的可见 fail 会被静默洗掉（S2 第十九轮 P0）。
    if (atParagraphStart && /^[ \t]*(?:>[ \t]*)*\[[^\]]+\]:/.test(line)) {
      inDefinition = true
      continue
    }
    if (inDefinition && /^[ \t]+/.test(line)) continue
    inDefinition = false
    if (line.trim() !== '') atParagraphStart = false
    kept.push(line)
  }
  return kept.join('\n')
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/\[([^\]]*)\]/g, '$1')
}

function maskAuditLinkDestinations(text: string): { masked: string; poisoned: boolean } {
  const lines = text.split('\n')
  const inspectionLines = stripCdataSpansForInspection(lines)
  let start = 0
  let poisoned = false
  for (let i = 0; i <= lines.length; i += 1) {
    if (i < lines.length && !isMarkdownBlankLine(lines[i]!)) continue
    if (i > start) {
      let hide = false
      for (let k = start; k < i; k += 1) {
        // 所有链接、图片与引用定义都必须出现 ASCII 的 '['；带 '[' 的段落整体隐藏。
        // 这样跨行 label/title/alt、全引用 [text][ref]、空格分隔的引用标签也一并覆盖。
        if (lines[k]!.includes('[')) {
          hide = true
          break
        }
      }
      if (hide) {
        // 先按渲染后的可见文字重建这一段：链接只保留 label，目标/title 丢弃。
        // 这样 `[结论](url)：fail` 会还原成 `结论：fail`，而普通含链接的说明段
        // 不会因为出现“结论”二字就被误毒化。
        const visible = visibleTextOfLinkParagraph(inspectionLines.slice(start, i).join('\n'))
        for (let k = start; k < i; k += 1) lines[k] = blankPreservingLines(lines[k]!)
        for (const line of visible.split('\n')) {
          const normalized = normalizeAuditLine(line)
          const cleanPass = /^(?:审计)?(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]\s*(?:\*\*)?\s*(?:pass|通过)(.*)$/i.exec(normalized)
          const hasConclusionText = /(?:结论|結論|判定|审计意见|最终判定|最终结论|最終結論|(?:audit\s+)?(?:conclusions?|verdict|outcomes?|results?))\s*[：:—–-]/i.test(normalized)
          if (hasConclusionText) {
            if (cleanPass === null || !validConclusionTail(cleanPass[1] ?? '', 'pass')) poisoned = true
          } else if (/^(?:fail|不通过)$/i.test(normalized)) {
            poisoned = true
          }
        }
      }
    }
    start = i + 1
  }
  // poison 行由 stripHiddenAuditBlocks 在 HTML 掩码之后统一追加，
  // 避免未闭合的注释/处理指令/doctype 把 poison 一起吞掉（S1 第十四轮 P1-3）。
  return { masked: lines.join('\n'), poisoned }
}

function maskHtmlComments(text: string): string {
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('<!--', cursor)
    if (start < 0) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, start)
    const end = text.indexOf('-->', start + 4)
    if (end < 0) {
      out += blankPreservingLines(text.slice(start))
      break
    }
    out += blankPreservingLines(text.slice(start, end + 3))
    cursor = end + 3
  }
  return out
}

// 处理指令、文档类型、CDATA 在 HTML 里都不渲染；未闭合一律隐藏到文末（fail-closed）。
function maskHtmlProcessingInstructions(text: string): string {
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('<?', cursor)
    if (start < 0) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, start)
    const end = text.indexOf('?>', start + 2)
    if (end < 0) {
      out += blankPreservingLines(text.slice(start))
      break
    }
    out += blankPreservingLines(text.slice(start, end + 2))
    cursor = end + 2
  }
  return out
}

function maskHtmlCdata(text: string): string {
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const start = text.toLowerCase().indexOf('<![cdata[', cursor)
    if (start < 0) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, start)
    const end = text.indexOf(']]>', start + 9)
    if (end < 0) {
      out += blankPreservingLines(text.slice(start))
      break
    }
    out += blankPreservingLines(text.slice(start, end + 3))
    cursor = end + 3
  }
  return out
}

// doctype 允许带内部子集，找到配对的 > 再收；找不到就隐藏到文末。
function maskHtmlDoctype(text: string): string {
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const start = text.toLowerCase().indexOf('<!doctype', cursor)
    if (start < 0) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, start)
    let quote = ''
    let brackets = 0
    let end = -1
    for (let i = start + 9; i < text.length; i += 1) {
      const ch = text.charAt(i)
      if (quote) {
        if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '[') {
        brackets += 1
      } else if (ch === ']') {
        brackets = Math.max(0, brackets - 1)
      } else if (ch === '>' && brackets === 0) {
        end = i
        break
      }
    }
    if (end < 0) {
      out += blankPreservingLines(text.slice(start))
      break
    }
    out += blankPreservingLines(text.slice(start, end + 1))
    cursor = end + 1
  }
  return out
}

// 审计报告只接受纯 Markdown。原始 HTML 的可见性取决于标签、属性、内联样式与宿主 CSS，
// 无法在门检查里可靠重算；一律拒绝整份报告（fail-closed），而不是猜哪些内容可见。
function stripHiddenAuditBlocks(text: string): string {
  let masked = text.replace(/\r\n/g, '\n')
  masked = maskFencedAuditCode(masked)
  const indented = maskIndentedAuditCode(masked)
  masked = indented.masked
  // 链接必须先于行内代码：行内代码若先吃掉链接的方括号，链接掩码就看不到这段，
  // title 里的结论行会漏成顶层（S2 第十八轮 P0）。链接段里的合法 CDATA 在毒化
  // 检查时剔除，避免误毒（S1 第十四轮 P2-1）。
  const links = maskAuditLinkDestinations(masked)
  masked = links.masked
  const inline = maskInlineAuditCode(masked)
  masked = inline.masked
  masked = maskHtmlComments(masked)
  masked = maskHtmlProcessingInstructions(masked)
  masked = maskHtmlCdata(masked)
  masked = maskHtmlDoctype(masked)
  // poison 必须在所有 HTML 掩码之后追加，否则会被未闭合结构吞掉（S1 第十四轮 P1-3）。
  if (links.poisoned || inline.poisoned || indented.poisoned) masked += '\n结论：'
  // 代码与链接目标已抹掉；剩下的任何标签、注释、处理指令都视为未支持的原始 HTML。
  if (/<(?=[A-Za-z/!?])/.test(masked)) return '\u0000'
  return masked
}

function normalizeAuditLine(raw: string): string {
  // 渲染不可见的字符不能把“结论”拆开：格式控制符（Cf）、组合记号（Mn/Me）
  // 以及几个无字形的 Lo 填充符都先剥掉（S1 第十七轮 P1-C）。
  let line = raw
    .replace(/[\p{Cf}\p{Mn}\p{Me}]/gu, '')
    .replace(/[\u115F\u1160\u17B4\u17B5\u180E\u2800\u3164\uFFA0]/g, '')
    .trim()
  // U+FE55 小冒号、U+FE13 竖排冒号在视觉上就是冒号，归一后再判定（S1 第十七轮 P2-3）。
  line = line.replace(/[\uFE13\uFE55]/g, ':')
  line = line.replace(/^>\s?/, '')
  line = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '')
  // 任务列表的复选框不产生可见文字，判定前剥掉，避免「本报告不通过」被前缀挡住。
  line = line.replace(/^\[[ xX]\]\s+/, '')
  line = line.replace(/^#{1,6}\s*/, '')
  // 强调标记不改变可见文字；判定前一律剥掉，避免 `**结论**：fail` 被漏掉。
  line = line.replace(/(?:\*\*?|__?|~~)/g, '')
  return line.trim()
}

function rawVerdict(token: string): 'pass' | 'fail' {
  return /^(?:pass|通过)$/i.test(token) ? 'pass' : 'fail'
}

// 结论 token 后的尾巴：只接受空、标点、一个括号、一个破折号解释。
// fail 只要求尾巴里没有反向 pass（fail 不会放行门）；pass 还要把括号/解释里的
// 计数清零说明全部剥掉，剩余任何文字都视为未收口的 caveat。
function validConclusionTail(tail: string, verdict: 'pass' | 'fail'): boolean {
  let t = tail.trim().replace(/^\*\*/, '').trim()
  t = t.replace(/[。．.！!？?；;，,、\s]+$/, '')
  if (t.length === 0) return true
  let content = ''
  if (/^[—–-]/.test(t)) {
    content = t.replace(/^[—–\-\s]+/, '')
  } else if (/^[（(]/.test(t)) {
    const open = t[0]
    const close = open === '（' ? '）' : ')'
    if (!t.endsWith(close)) return false
    content = t.slice(1, -1)
  } else {
    return false
  }
  const hasPass = /(?:^|[^不])通过|\bpass\b/i.test(content)
  if (verdict === 'fail') return !hasPass
  if (hasPass || /\bfail\b/i.test(content)) return false
  return onlyCleanCounts(content)
}

function onlyCleanCounts(content: string): boolean {
  let rest = content.replace(/\s+/g, '')
  // 标准结论尾巴“N 项必过全过，失败项为空，无 run”是清零说明，不是 caveat（S2 第三十二轮 P1-1）。
  rest = rest.replace(/\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?(?:项|項)?必过(?:项|項)?(?:全过|全過|全部通过|全部通過|均通过|均通過|通过|通過)/g, '')
  rest = rest.replace(/(?:失败项|失敗項)(?:为|為|是)?(?:空|0|零)/g, '')
  rest = rest.replace(/无run/g, '')
  rest = rest.replace(/[。．.！!？?；;，,、：:（）()\[\]【】]/g, '')
  rest = rest.replace(/0\s*(?:个|项|条)?\s*致命/gi, '')
  rest = rest.replace(/致命\s*(?:为|=|＝)?\s*0\s*(?:个|项|条)?/gi, '')
  rest = rest.replace(/重大\s*(?:为|=|＝)?\s*0\s*(?:个|项|条)?/gi, '')
  rest = rest.replace(/0\s*(?:个|项|条)?\s*重大/gi, '')
  rest = rest.replace(/(?:阻断|风险)\s*(?:为|=|＝)?\s*0\s*(?:个|项|条)?/gi, '')
  rest = rest.replace(/0\s*(?:个|项|条)?\s*(?:阻断|风险)/gi, '')
  rest = rest.replace(/P[01](?:已|均|都)?\s*(?:清零|清空|归零)/gi, '')
  rest = rest.replace(/无\s*(?:致命|重大|阻断|风险)(?:缺陷|问题)?/gi, '')
  rest = rest.replace(/无\s*P[01](?:\s*[\/、,，与和]\s*P[01])*/gi, '')
  rest = rest.replace(/P[01](?:\s*[\/、,，与和]\s*P[01])*\s*(?:均|都)?\s*(?:为|=|＝)?\s*0\s*(?:个|项|条)?/gi, '')
  rest = rest.replace(/P[01](?:\s*[\/、,，与和]\s*P[01])*\s*(?:均|都)?\s*无/gi, '')
  rest = rest.replace(/0\s*(?:个|项|条)?\s*P[01]/gi, '')
  rest = rest.replace(/P2\s*(?:=|＝|为)?\s*(?:遗留|剩余|待办|未闭合)?\s*\d+\s*(?:条|项|个)?/gi, '')
  rest = rest.replace(/[与和及均为都是项个条无均都]/g, '')
  return rest.length === 0
}

// 本轮独立审计的锚：报告在 HEAD、路径在白名单目录、轮次对得上、字节哈希固定，结论与门记录一致
// 只绑结论不绑字节，签后改报告正文不会被发现；门记录自身也不能当审计报告自指通过（S1 第二轮审计）
function checkAuditAnchor(artifact: Record<string, unknown>, spec: GateSpec, root: string): void {
  const round = artifact.audit_round
  if (!Number.isInteger(round) || (round as number) < 1) throw new Error('audit_round 必须是正整数')
  const report = String(artifact.audit_report ?? '')
  if (report.length === 0) throw new Error('audit_report 不能空')
  if (!/^docs\/audits\/[^/]+\.md$/.test(report) || report.includes('..')) {
    throw new Error('audit_report 必须是 docs/audits/ 下的 Markdown 报告: ' + report)
  }
  if (report === spec.gateFile) throw new Error('audit_report 不能指向门记录自身')
  const head = contentAt(root, 'HEAD', report)
  if (!head) throw new Error('审计报告不在 HEAD 里，先提交审计报告: ' + report)
  const m = /round(\d+)/.exec(report)
  const fileRound = m ? Number(m[1]) : 1
  if (fileRound !== round) throw new Error('audit_round 与审计报告的轮次不一致: ' + String(round) + ' != ' + String(fileRound))
  const expectedHash = String(artifact.audit_report_sha256 ?? '')
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error('audit_report_sha256 必须是 64 位 sha256')
  const actualHash = sha256Hex(head.toString('utf8').replace(/\r\n/g, '\n'))
  if (actualHash !== expectedHash) {
    throw new Error('审计报告 sha256 与记录不符（报告改过就重新审计再签）：' + expectedHash.slice(0, 16) + '… != ' + actualHash.slice(0, 16) + '…')
  }
  const text = head.toString('utf8')
  // 报告必须自己写清门名与候选提交：只有路径和轮次时，别轮/别门的 pass 报告能直接拿来签（S1 第八轮 P1-2）
  const binding = auditBindingOf(text)
  if (!binding) {
    throw new Error('审计报告缺少唯一的「门：G1」与「候选提交：<40 位 commit>」绑定行: ' + report)
  }
  // 结论以结构化裁决块为准（第二次意见 P0）：报告里的自然语言结论只当兜底
  const parsed = parseAuditVerdict(text)
  if (parsed && 'error' in parsed) {
    throw new Error('审计报告的结构化裁决块无效：' + parsed.error + '（' + report + '）')
  }
  if (parsed) {
    const problems = verdictProblems(parsed.verdict, {
      gate: String(artifact.gate),
      auditRound: Number(artifact.audit_round),
      commit: binding.commit,
      requiredItems: spec.items,
    })
    if (problems.length > 0) throw new Error('审计报告的结构化裁决不通过：' + problems.join('；'))
    // 裁决与正文自述不能互相打脸（第三十四轮 P2-1 / 第三十五轮 P2-1）：
    // 正文写 fail 要拦，正文写多行结论或把必过项写成未通过同样要拦——这些情况以前返回 null 就被跳过了。
    const clashes = proseVerdictClashes(text, parsed.verdict.conclusion, spec.items, { auditRound: Number(artifact.audit_round) })
    if (clashes.length > 0) {
      throw new Error('审计报告正文与结构化裁决不一致：' + clashes.join('；') + '（' + report + '）')
    }
  } else if (spec.requireVerdict) {
    throw new Error('审计报告缺少结构化裁决块（' + VERDICT_BEGIN + ' … ' + VERDICT_END + '），这道门要求机器可判的结论: ' + report)
  } else {
    const actual = auditConclusionOf(text)
    if (!actual) throw new Error('审计报告里找不到唯一结论行，不能拿它当门记录依据: ' + report)
    if (actual !== artifact.conclusion) {
      throw new Error('审计报告结论与门记录结论不符：报告=' + actual + '，门记录=' + String(artifact.conclusion))
    }
  }
  if (binding.gate !== String(artifact.gate)) {
    throw new Error('审计报告绑定的门与门记录不符：报告=' + binding.gate + '，记录=' + String(artifact.gate))
  }
  const commit = binding.commit
  try {
    git(root, ['cat-file', '-e', commit + '^{commit}'])
    git(root, ['merge-base', '--is-ancestor', commit, 'HEAD'])
  } catch {
    throw new Error('审计报告的候选提交不是 HEAD 的祖先或不存在: ' + commit)
  }
  const afterArgs = ['diff', '--name-only', commit + '..HEAD', '--', '.']
  for (const dir of spec.excludes) afterArgs.push(':(exclude)' + dir)
  const after = git(root, afterArgs).toString('utf8').trim()
  if (after.length > 0) {
    throw new Error('审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：' + after.split(/\r?\n/)[0])
  }
}

function checkCandidate(artifact: Record<string, unknown>, spec: { scopeBase: string; excludes: string[] }, root: string): void {
  const { paths, files } = candidateEntries(root, spec)
  const candidate = sha256Hex(canonicalJson(files))
  const scope = sha256Hex(canonicalJson(paths))
  if (artifact.candidate_hash !== candidate) {
    throw new Error('candidate_hash 与候选文件不符：' + String(artifact.candidate_hash).slice(0, 16) + '… != ' + candidate.slice(0, 16) + '…')
  }
  if (artifact.change_scope_hash !== scope) {
    throw new Error('change_scope_hash 与改动清单不符：' + String(artifact.change_scope_hash).slice(0, 16) + '… != ' + scope.slice(0, 16) + '…')
  }
}

// 门的治理字段也要验：例外得写清码/类型/HTTP，回滚得能执行，批准人和产出者不能空（审计 N-09）
function checkGovernance(artifact: Record<string, unknown>): void {
  const exceptions = artifact.exceptions
  if (!Array.isArray(exceptions)) throw new Error('exceptions 必须是数组')
  for (const raw of exceptions) {
    const e = raw as Record<string, unknown>
    if (typeof e.code !== 'string' || e.code.length === 0) throw new Error('例外项缺 code: ' + JSON.stringify(raw))
    if (e.type !== 'proposed' && e.type !== 'accepted') throw new Error('例外项 type 只能是 proposed / accepted: ' + String(e.type))
    if (!Number.isInteger(e.status) || (e.status as number) < 400 || (e.status as number) > 599) throw new Error('例外项 status 必须是 4xx/5xx 整数: ' + String(e.status))
    if (typeof e.note !== 'string' || e.note.length === 0) throw new Error('例外项缺 note: ' + e.code)
  }
  const rollback = artifact.rollback
  if (!rollback || typeof rollback !== 'object' || Array.isArray(rollback)) throw new Error('rollback 必须是对象')
  const rb = rollback as Record<string, unknown>
  if (typeof rb.target !== 'string' || rb.target.length === 0) throw new Error('rollback 缺 target')
  if (typeof rb.action !== 'string' || rb.action.length === 0) throw new Error('rollback 缺 action')
  const duration = rb.duration_s ?? rb.max_seconds
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new Error('rollback 的耗时必须是正数')
  const verification = rb.verification ?? rb.verify
  if (typeof verification !== 'string' || verification.length === 0) throw new Error('rollback 缺验证方法')
  if (typeof artifact.approver !== 'string' || !/^human:\S+$/.test(artifact.approver)) throw new Error('approver 必须是 human:<名字>')
  const approvedAt = Date.parse(String(artifact.approved_at))
  if (!Number.isFinite(approvedAt)) throw new Error('approved_at 必须是 ISO 时间: ' + String(artifact.approved_at))
  // G1 到 G5 的主 artifact 由人手工跑，产出者必须是 human（规格 11.3 行 981；审计 R3-05）
  if (artifact.producer !== 'human') throw new Error('producer 必须是 human（规格 11.3 行 981）: ' + String(artifact.producer))
}

export function verifyGateRecord(text: string, opts: { root?: string; allowDirty?: boolean; path?: string; selfCheck?: boolean } = {}): CheckResult {
  const root = resolve(opts.root ?? process.cwd())
  if (!opts.allowDirty && !opts.selfCheck) assertClean(root)
  const blocks = jsonBlocks(text)
  const artifactBlock = blocks.find((b) => b.value !== null && typeof b.value === 'object' && typeof (b.value as { gate?: unknown }).gate === 'string')
  if (!artifactBlock) throw new Error('门记录里找不到 GateArtifact 的 json 块')
  const artifact = artifactBlock.value as Record<string, unknown>
  for (const field of GATE_FIELDS) {
    if (!(field in artifact)) throw new Error('GateArtifact 缺字段: ' + field)
  }
  if (artifact.schema_version !== 1) throw new Error('schema_version 必须是 1')
  const items = artifact.must_pass_items as GateItem[]
  if (!Array.isArray(items) || items.length === 0) throw new Error('must_pass_items 为空')
  for (const item of items) {
    if (typeof item.id !== 'string' || item.id.length === 0) throw new Error('must_pass_items 里有项没有 id')
    if (item.result !== 'pass') throw new Error('必过项没过: ' + item.id)
    if (!Array.isArray(item.evidence_ids) || item.evidence_ids.length === 0) {
      throw new Error('必过项缺证据: ' + item.id)
    }
  }
  const gate = String(artifact.gate)
  if (opts.path) {
    const recordPath = relative(root, resolve(root, opts.path)).replace(/\\/g, '/')
    const registered = Object.entries(GATE_SPECS).find(([, gateSpec]) => gateSpec.gateFile === recordPath)
    if (registered && registered[0] !== gate) {
      throw new Error('门记录路径与 GateArtifact 门号不符：' + recordPath + ' 应为 ' + registered[0] + '，实际 ' + gate)
    }
  }
  const spec = GATE_SPECS[gate]
  if (!spec) throw new Error('没有这道门的校验规格: ' + gate)
  const gotIds = items.map((i) => i.id)
  if (canonicalJson(gotIds) !== canonicalJson(spec.items)) {
    throw new Error('必过项清单不符：期望 ' + spec.items.join(',') + '，实际 ' + gotIds.join(','))
  }
  checkEvidenceMap(items, spec)
  const failed = artifact.failed_items as unknown[]
  if (!Array.isArray(failed) || failed.length !== 0) throw new Error('failed_items 不为空')
  if (artifact.conclusion !== 'pass') throw new Error('conclusion 不是 pass')
  const bodyVerdict = bodyConclusionOf(text)
  if (bodyVerdict === null) throw new Error('门记录正文结论行缺失或不唯一')
  if (bodyVerdict !== artifact.conclusion) {
    throw new Error('门记录正文结论与 GateArtifact 不符：正文=' + bodyVerdict + '，artifact=' + String(artifact.conclusion))
  }
  const hasRun = artifact.gate_run_id !== null
  if (hasRun && artifact.run_terminal !== 'succeeded') {
    throw new Error('有 run 的门 run_terminal 必须是 succeeded，实际 ' + String(artifact.run_terminal))
  }
  if (!hasRun && artifact.run_terminal !== 'not_applicable') {
    throw new Error('无 run 的门 run_terminal 必须是 not_applicable，实际 ' + String(artifact.run_terminal))
  }
  checkGovernance(artifact)
  checkPreviousChain(artifact, spec, root)
  checkAuditAnchor(artifact, spec, root)

  const anchor = /artifact_hash=([0-9a-f]{64})/.exec(text)
  if (!anchor) throw new Error('门记录里找不到 artifact_hash 锚点')
  const expect = sha256Hex(canonicalJson(artifact))
  if (anchor[1] !== expect) throw new Error('artifact_hash 与正文不符：' + anchor[1] + ' != ' + expect)
  const evidence = checkEvidence(blocks, artifact, root, spec)
  const invariants = checkInvariants(blocks, artifact, evidence.entries, spec)
  checkBodyEvidenceTable(text, evidence.entries)
  checkBodyExceptions(text, artifact.exceptions)
  const used = new Set<string>()
  for (const item of items) {
    for (const id of item.evidence_ids ?? []) {
      if (!evidence.entries.some((x) => x.id === id)) throw new Error('必过项 ' + item.id + ' 引用了不存在的证据: ' + id)
      used.add(id)
    }
  }
  for (const id of invariants.used) used.add(id)
  const unused = evidence.entries.map((e) => e.id).filter((id) => !used.has(id))
  if (unused.length > 0) throw new Error('有证据没被任何必过项或不变量引用: ' + unused.join(','))
  checkBodyTable(text, items, spec)
  checkBodyInvariants(text, invariants.list)
  checkCandidate(artifact, spec, root)
  // 正文自锚放在最后：语义错误先报，改过正文的兜底检查最后再兜（审计 R3-08）
  const body = checkBodyHash(text)

  // 门记录本身必须在 HEAD 里：改了没提交的门记录不算数（审计 R3-07）
  if (opts.path && !opts.selfCheck) {
    const head = contentAt(root, 'HEAD', opts.path)
    if (!head) throw new Error('门记录不在 HEAD 里，先提交门记录再校验: ' + opts.path)
    const onDisk = readFileSync(opts.path, 'utf8')
    if (onDisk !== text) throw new Error('校验的正文与磁盘上的门记录不一致: ' + opts.path)
    if (onDisk.replace(/\r\n/g, '\n') !== head.toString('utf8').replace(/\r\n/g, '\n')) {
      throw new Error('门记录与 HEAD 不一致，先提交门记录再校验: ' + opts.path)
    }
  }

  return { gate, artifactHash: expect, bodyHash: body, items: items.length, evidence: evidence.entries.length }
}

export const G5_GATE_PATH = 'docs/gates/G5.md';

export function defaultGatePaths(root: string): string[] {
  // G5 一旦进入 HEAD 可达历史，即使被删，无参检查也必须报告缺失。
  const hasG5 = existsSync(resolve(root, G5_GATE_PATH)) ||
    git(root, ['log', '-1', '--full-history', '--format=%H', 'HEAD', '--', ':(top,literal)' + G5_GATE_PATH]).length > 0
  return hasG5 ? [...DEFAULT_GATE_PATHS, G5_GATE_PATH] : [...DEFAULT_GATE_PATHS]
}

export function verifyG5GateRecord(
  text: string,
  opts: { root?: string; allowDirty?: boolean; path?: string; selfCheck?: boolean } = {},
): CheckResult {
  const blocks = jsonBlocks(text);
  const artifactBlock = blocks.find(
    (b) => b.value !== null && typeof b.value === 'object' && typeof (b.value as { gate?: unknown }).gate === 'string',
  );
  const gate = artifactBlock ? String((artifactBlock.value as { gate: string }).gate) : '';
  if (gate !== 'G5') throw new Error('这份门记录不是 G5 门：' + (gate || '找不到 GateArtifact'));
  return verifyGateRecord(text, opts);
}
if (process.argv[1] && /gate-check\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const paths = process.argv.length > 2 ? process.argv.slice(2) : defaultGatePaths(process.cwd())
  for (const path of paths) {
    try {
      const out = verifyGateRecord(readFileSync(path, 'utf8'), { path })
      console.log('gate ' + out.gate + ' 通过（' + String(out.items) + ' 项必过、' + String(out.evidence) + ' 份证据哈希复核，artifact_hash=' + out.artifactHash.slice(0, 12) + '… body_hash=' + out.bodyHash.slice(0, 12) + '…）')
    } catch (err) {
      console.error('门检查失败（' + path + '）：' + (err instanceof Error ? err.message : String(err)))
      process.exitCode = 1
    }
  }
}
