import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertG5History, G5_REWRITTEN_COMMIT, G5_SIGNED_COMMIT, g5HistoryAncestor, g6CommitRange, hasG5History } from '../../scripts/gate-g6.ts'

const source = fileURLToPath(new URL('../..', import.meta.url))
function git(root: string, args: string[], input?: string | Buffer): Buffer {
  return execFileSync('git', args, { cwd: root, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}
function text(root: string, ...args: string[]) { return git(root, args).toString('utf8').trim() }
function withHistory(anchor: string, run: (root: string) => void, originalObjects = true) {
  const root = mkdtempSync(join(tmpdir(), 'g5-history-test-'))
  try {
    git(root, ['init', '--quiet', '--initial-branch=main'])
    if (originalObjects) {
      const objects = text(source, 'rev-parse', '--path-format=absolute', '--git-path', 'objects')
      writeFileSync(join(root, '.git', 'objects', 'info', 'alternates'), objects.replace(/\\/g, '/') + '\n')
    } else {
      // Fetch only the rewritten ancestry, as in a checkout without release tags.
      git(root, ['fetch', '--quiet', '--no-tags', source, anchor])
    }
    git(root, ['update-ref', 'refs/heads/main', anchor])
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
function addCommit(root: string, tree: string, parent?: string) {
  return text(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'isolated history fixture')
}

it('原始历史仍绑定原 G5，改写历史仅绑定固定的同树祖先', () => {
  withHistory(G5_SIGNED_COMMIT, (root) => {
    expect(g5HistoryAncestor(root)).toBe(G5_SIGNED_COMMIT)
    expect(hasG5History(root)).toBe(true)
  })
  withHistory(G5_REWRITTEN_COMMIT, (root) => {
    expect(() => git(root, ['merge-base', '--is-ancestor', G5_SIGNED_COMMIT, 'HEAD'])).toThrow()
    const next = addCommit(root, text(root, 'rev-parse', 'HEAD^{tree}'), G5_REWRITTEN_COMMIT)
    git(root, ['update-ref', 'refs/heads/main', next])
    expect(g5HistoryAncestor(root)).toBe(G5_REWRITTEN_COMMIT)
    expect(g5HistoryAncestor(root, next)).toBe(G5_REWRITTEN_COMMIT)
    expect(g5HistoryAncestor(root, G5_REWRITTEN_COMMIT + '^')).toBeUndefined()
  })
})

it('同树复制或仅保存标签不能替代固定 G5 的祖先关系', () => {
  withHistory(G5_REWRITTEN_COMMIT, (root) => {
    const copied = addCommit(root, text(root, 'rev-parse', 'HEAD^{tree}'))
    git(root, ['update-ref', 'refs/heads/main', copied])
    git(root, ['update-ref', 'refs/tags/original-g5', G5_SIGNED_COMMIT])
    git(root, ['update-ref', 'refs/tags/rewritten-g5', G5_REWRITTEN_COMMIT])
    expect(hasG5History(root)).toBe(false)
    expect(() => assertG5History(root)).toThrow(/无法证明正式 G5/)
  })
})

it('G6 范围从实际 G5 祖先计算，且候选、证据、独审和批准必须独立有序', () => {
  for (const anchor of [G5_SIGNED_COMMIT, G5_REWRITTEN_COMMIT]) {
    withHistory(anchor, (root) => {
      const tree = text(root, 'rev-parse', 'HEAD^{tree}')
      const C = addCommit(root, tree, anchor)
      const E = addCommit(root, tree, C)
      const A = addCommit(root, tree, E)
      const tip = addCommit(root, tree, A)
      git(root, ['update-ref', 'refs/heads/main', tip])
      // No file changed after G5. Using the original SHA across rewritten
      // ancestry would incorrectly include earlier commits in touched_paths.
      expect(g6CommitRange(root, C, E, A, tip)).toEqual({ base: anchor, paths: [] })
      expect(() => g6CommitRange(root, anchor, E, A, tip)).toThrow(/依次提交的独立事实/)
      expect(() => g6CommitRange(root, C, A, E, tip)).toThrow(/依次提交的独立事实/)
      expect(() => g6CommitRange(root, C, E, E, tip)).toThrow(/依次提交的独立事实/)
    })
  }
})

it('缺少原 G5 对象时不能把改写提交当作已验证的签门快照', () => {
  withHistory(G5_REWRITTEN_COMMIT, (root) => {
    expect(() => git(root, ['cat-file', '-e', G5_SIGNED_COMMIT])).toThrow()
    expect(hasG5History(root)).toBe(false)
    expect(() => assertG5History(root)).toThrow(/无法证明正式 G5/)
  }, false)
})

it('固定别名内容被替换或历史不完整时仍拒绝核验', () => {
  withHistory(G5_REWRITTEN_COMMIT, (root) => {
    const emptyTree = git(root, ['hash-object', '-t', 'tree', '-w', '--stdin'], '').toString('utf8').trim()
    const replacement = addCommit(root, emptyTree)
    git(root, ['replace', G5_REWRITTEN_COMMIT, replacement])
    expect(hasG5History(root)).toBe(false)
    expect(() => assertG5History(root)).toThrow(/无法证明正式 G5/)
    git(root, ['replace', '-d', G5_REWRITTEN_COMMIT])
    writeFileSync(join(root, '.git', 'shallow'), G5_REWRITTEN_COMMIT + '\n')
    expect(() => assertG5History(root)).toThrow(/无法证明正式 G5/)
  })
})
