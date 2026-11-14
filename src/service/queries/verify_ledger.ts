// 账本校验：重算每个 node_run 的哈希链、跟链头投影对账，返回第一个断点；完好时给链数与条目数
import { type Db } from '../../infra/sqlite/driver.ts'
import { type ChainRow } from '../../core/hash-chain.ts'
import { chainBreakOf } from '../../infra/db/ledger.ts'

// 一个结构缺口：哪条链、哪个位置、为什么不对
export type LedgerGap = {
  node_run_id: string
  seq: number
  reason: string
}

export type LedgerVerify = {
  ok: boolean
  chains: number
  entries: number
  break: LedgerGap | null
  // 所有缺口（不只第一个）：链被截断、整条链没了、链头缺失、节点该有链却没有、链挂在不存在的节点上
  gaps: LedgerGap[]
}

type HeadRow = {
  node_run_id: string
  last_seq: number
  last_hash: string
  event_count: number
}

export function verifyLedger(db: Db, secret: string): LedgerVerify {
  const gaps: LedgerGap[] = []
  // 链的集合要同时看账本和链头：只看账本的话，整条链被删掉就查不出来，校验等于没做
  const ids = new Set<string>()
  for (const row of db.raw.prepare('SELECT DISTINCT node_run_id FROM node_run_events').all() as { node_run_id: string }[]) {
    ids.add(row.node_run_id)
  }
  const heads = new Map<string, HeadRow>()
  for (const row of db.raw.prepare('SELECT node_run_id, last_seq, last_hash, event_count FROM node_run_chain_heads').all() as HeadRow[]) {
    heads.set(row.node_run_id, row)
    ids.add(row.node_run_id)
  }

  let entries = 0
  for (const nodeRunId of [...ids].sort()) {
    const rows = db.raw.prepare(
      'SELECT node_run_id, seq, type, prev_hash, hash, payload FROM node_run_events WHERE node_run_id = ? ORDER BY seq ASC')
      .all(nodeRunId) as ChainRow[]
    entries += rows.length
    const head = heads.get(nodeRunId)
    if (rows.length === 0) {
      // 链一条不剩：链头还留着，就说明这里少了一整条链
      if (head) {
        gaps.push({
          node_run_id: nodeRunId,
          seq: head.last_seq,
          reason: '整条链在账本里没了：链头记着 ' + String(head.event_count) + ' 条，账本里一条都不剩',
        })
      }
      continue
    }
    if (!head) {
      gaps.push({
        node_run_id: nodeRunId,
        seq: rows[0]!.seq,
        reason: '链头记录缺失：账本里有这条链，却查不到它记到哪一条',
      })
    }
    // 先查链本身：中间事件被删或被改，这里就能指出断在哪一条
    const brk = chainBreakOf(secret, rows)
    if (brk) gaps.push(brk)
    if (head) {
      const last = rows[rows.length - 1]!
      if (rows.length !== head.event_count) {
        gaps.push({
          node_run_id: nodeRunId,
          seq: last.seq,
          reason: '链的条数与链头记录对不上：链头记 ' + String(head.event_count) + ' 条，账本里 ' + String(rows.length) + ' 条',
        })
      }
      if (last.seq !== head.last_seq) {
        gaps.push({
          node_run_id: nodeRunId,
          seq: last.seq,
          reason: '链尾序号与链头记录对不上：链头记 seq=' + String(head.last_seq) + '，账本里最后一条 seq=' + String(last.seq),
        })
      }
      if (last.hash !== head.last_hash) {
        gaps.push({
          node_run_id: nodeRunId,
          seq: last.seq,
          reason: '链尾哈希与链头记录对不上：链尾的内容被改过，或链尾被截掉了',
        })
      }
    }
  }

  // 节点侧：动过的节点必须有链，链也不能挂在账本里没有的节点上
  const nodeRuns = db.raw.prepare('SELECT node_run_id, status FROM node_runs').all() as { node_run_id: string; status: string }[]
  const nodeRunIds = new Set(nodeRuns.map((row) => row.node_run_id))
  for (const row of nodeRuns) {
    // queued 是刚建还没派发，本来就没有链；离开 queued 还没链就是账本缺了一块
    if (row.status === 'queued') continue
    if (!ids.has(row.node_run_id)) {
      gaps.push({
        node_run_id: row.node_run_id,
        seq: 0,
        reason: '节点已经动过却没有链：节点状态 ' + String(row.status) + '，账本里找不到它的链',
      })
    }
  }
  for (const nodeRunId of ids) {
    if (!nodeRunIds.has(nodeRunId)) {
      gaps.push({
        node_run_id: nodeRunId,
        seq: 0,
        reason: '链挂在账本里没有的节点上：node_runs 里查不到这个节点',
      })
    }
  }

  return {
    ok: gaps.length === 0,
    chains: ids.size,
    entries,
    break: gaps[0] ?? null,
    gaps,
  }
}
