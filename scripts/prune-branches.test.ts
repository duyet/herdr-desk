import { describe, expect, test } from 'bun:test'
import { classifyBranch, type Pr } from './prune-branches'

const pr = (number: number, over: Partial<Pr> = {}): Pr => ({
  number,
  headRefName: 'feat/x',
  state: 'MERGED',
  mergedAt: '2026-10-25T07:00:00Z',
  ...over,
})

describe('classifyBranch', () => {
  test('guard 3: protected and release-please branches are never candidates', () => {
    for (const b of ['main', 'master', 'develop', 'release-please--branches--main--components--herdr-desk']) {
      expect(classifyBranch(b, [], null)).toEqual({ action: 'keep', why: 'protected' })
    }
    expect(classifyBranch('desk/desk-github-issues', [], null)).toEqual({
      action: 'keep',
      why: 'desk manager worktree',
    })
  })

  test('guard 1: no merged PR keeps the branch, even when an open PR references it', () => {
    expect(classifyBranch('feat/wip', [pr(5, { state: 'OPEN', mergedAt: null })], 0)).toEqual({
      action: 'keep',
      why: 'no merged PR (in-flight or unpushed work)',
    })
  })

  test('guard 2: an open PR on top of a merged one keeps the branch', () => {
    expect(classifyBranch('feat/reused', [pr(5), pr(9, { state: 'OPEN', mergedAt: null })], 0)).toEqual({
      action: 'keep',
      why: 'open PR #9',
    })
  })

  test('guard 4: a squash-merged branch is deletable — patch-id would call it ahead forever', () => {
    // Real data from #112 (feat/auto-upgrade): GitHub merged the PR at
    // 06:57:30Z, and the squash commit on main rewrote every patch-id, so
    // `git cherry` reported the branch as 1 commit ahead. The tip predates
    // the merge, so the work is landed and the branch is dead.
    expect(
      classifyBranch(
        'feat/auto-upgrade',
        [pr(112, { mergedAt: '2026-10-25T06:57:30Z' })],
        Date.parse('2026-10-25T13:53:42+07:00'),
      ),
    ).toEqual({ action: 'delete', why: '#112' })
  })

  test('guard 4: a commit pushed after the merge is unlanded work — keep', () => {
    expect(
      classifyBranch('feat/reused', [pr(5, { mergedAt: '2026-10-25T07:00:00Z' })], Date.parse('2026-10-25T08:00:00Z')),
    ).toEqual({ action: 'keep', why: 'tip commit is newer than the last merged PR' })
  })

  test('guard 4: an unreadable tip date keeps the branch', () => {
    expect(classifyBranch('feat/x', [pr(5)], null)).toEqual({
      action: 'keep',
      why: 'tip commit date unreadable',
    })
  })

  test('guard 4: with several merged PRs, the latest merge is the one that counts', () => {
    const prs = [pr(5, { mergedAt: '2026-10-01T00:00:00Z' }), pr(9, { mergedAt: '2026-10-25T00:00:00Z' })]
    // A tip dated between the two merges was part of the later PR's head and
    // landed with #9's squash.
    expect(classifyBranch('feat/reused', prs, Date.parse('2026-10-10T00:00:00Z'))).toEqual({
      action: 'delete',
      why: '#5, #9',
    })
    // A tip dated after the latest merge was pushed afterwards: unlanded.
    expect(classifyBranch('feat/reused', prs, Date.parse('2026-11-01T00:00:00Z'))).toEqual({
      action: 'keep',
      why: 'tip commit is newer than the last merged PR',
    })
  })

  test('guard 4: an unreadable merged-PR date keeps the branch', () => {
    expect(classifyBranch('feat/x', [pr(5, { mergedAt: 'not-a-date' })], 0)).toEqual({
      action: 'keep',
      why: 'merged PR date unreadable',
    })
  })

  test('delete reason lists the merged PR numbers, for the audit log', () => {
    expect(classifyBranch('feat/x', [pr(112), pr(113)], 0).why).toBe('#112, #113')
  })
})
