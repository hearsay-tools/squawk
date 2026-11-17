import { afterEach, describe, expect, it } from 'vitest'

import {
  clearStartedDraft,
  composerRunModeNote,
  readDraft,
  resetDraft,
  resolveComposerRunMode,
  writeDraft,
} from './new-task-draft'

afterEach(resetDraft)

describe('resolveComposerRunMode', () => {
  const base = {
    hasGit: true,
    planFirst: false,
    explicitAutonomous: null,
    explicitWorktree: null,
    configuredAutonomous: 'source-dependent' as const,
    configuredWorktree: true,
    source: 'workflow' as const,
  }

  it('combines source fallback, configured policy, and explicit values', () => {
    expect(resolveComposerRunMode(base)).toEqual({ autonomous: false, worktree: true })
    expect(resolveComposerRunMode({ ...base, source: 'skill' })).toEqual({ autonomous: true, worktree: true })
    expect(resolveComposerRunMode({
      ...base,
      configuredAutonomous: true,
      configuredWorktree: false,
      explicitAutonomous: false,
      explicitWorktree: true,
    })).toEqual({ autonomous: false, worktree: true })
  })


  it('keeps plan and no-git constraints authoritative', () => {
    expect(resolveComposerRunMode({ ...base, planFirst: true, explicitAutonomous: true }).autonomous).toBe(false)
    expect(resolveComposerRunMode({ ...base, hasGit: false, explicitWorktree: true }).worktree).toBe(false)
  })

  it('keeps explicit and configured Worktree opt-outs authoritative for ordinary workflows', () => {
    expect(resolveComposerRunMode({ ...base, explicitWorktree: false }).worktree).toBe(false)
    expect(resolveComposerRunMode({ ...base, configuredWorktree: false }).worktree).toBe(false)
  })
})

describe('the new-task draft store', () => {
  it('retains completion choices across navigation, reload and successful starts', () => {
    writeDraft({ ...readDraft('other'), text: 'Ship it', archiveWhenDone: true, autoMergePr: true }, 'other')
    expect(readDraft()).toMatchObject({ archiveWhenDone: false, autoMergePr: false })
    clearStartedDraft('other')
    expect(readDraft('other')).toMatchObject({ text: '', archiveWhenDone: true, autoMergePr: true })
    const stored = localStorage.getItem('cez-new-task-draft:other')!
    resetDraft()
    localStorage.setItem('cez-new-task-draft:other', stored)
    expect(readDraft('other')).toMatchObject({ archiveWhenDone: true, autoMergePr: true })
  })

  it('defaults absent and malformed completion choices to off', () => {
    localStorage.setItem('cez-new-task-draft', JSON.stringify({ archiveWhenDone: 'true', autoMergePr: 1 }))
    expect(readDraft()).toMatchObject({ archiveWhenDone: false, autoMergePr: false })
  })

  it('defaults task access on, keeps an explicit off across starts and reloads', () => {
    expect(readDraft()).toMatchObject({ allowWorkers: true, allowMessaging: true })
    writeDraft({ ...readDraft('other'), text: 'Ship it', allowWorkers: false }, 'other')
    expect(readDraft()).toMatchObject({ allowWorkers: true, allowMessaging: true })
    clearStartedDraft('other')
    const stored = localStorage.getItem('cez-new-task-draft:other')!
    resetDraft()
    localStorage.setItem('cez-new-task-draft:other', stored)
    expect(readDraft('other')).toMatchObject({ allowWorkers: false, allowMessaging: true })
  })

  it('reads absent or malformed task access as on', () => {
    localStorage.setItem('cez-new-task-draft', JSON.stringify({ allowWorkers: 'false', allowMessaging: 0 }))
    expect(readDraft()).toMatchObject({ allowWorkers: true, allowMessaging: true })
  })

  it('starts empty with the never-chosen sentinels', () => {
    expect(readDraft()).toEqual({
      text: '',
      source: null,
      runner: null,
      agentProfile: null,
      model: null,
      effort: null,
      planFirst: false,
      worktree: null,
      autonomous: null,
      archiveWhenDone: false,
      autoMergePr: false,
      allowWorkers: true,
      allowMessaging: true,
    })
  })

  it('round-trips a draft through storage and hands out independent copies', () => {
    writeDraft({
      text: 'fix it',
      source: { source: 'skill', ref: 'om-fix' },
      runner: 'codex',
      agentProfile: null,
      model: 'gpt-5-codex',
      effort: 'high',
      planFirst: false,
      worktree: false,
      autonomous: null,
      archiveWhenDone: false,
      autoMergePr: false,
      allowWorkers: true,
      allowMessaging: true,
    })
    const first = readDraft()
    expect(first.text).toBe('fix it')
    expect(first.worktree).toBe(false)
    first.text = 'mutated'
    expect(readDraft().text).toBe('fix it')
    const stored = localStorage.getItem('cez-new-task-draft')!
    resetDraft()
    localStorage.setItem('cez-new-task-draft', stored)
    expect(readDraft()).toMatchObject({ text: 'fix it', source: { source: 'skill', ref: 'om-fix' },
      runner: 'codex', model: 'gpt-5-codex', effort: 'high', worktree: false, planFirst: false,
      autonomous: null, archiveWhenDone: false, autoMergePr: false, allowWorkers: true, allowMessaging: true })
  })

  it('clearStartedDraft spends the text AND the source, keeping the way-of-working pills', () => {
    writeDraft({
      text: 'shipped',
      source: { source: 'skill', ref: 'om-fix' },
      runner: null,
      agentProfile: null,
      model: 'opus',
      effort: 'max',
      planFirst: true,
      worktree: null,
      autonomous: null,
      archiveWhenDone: false,
      autoMergePr: false,
      allowWorkers: true,
      allowMessaging: true,
    })
    clearStartedDraft()
    expect(readDraft()).toEqual({
      text: '',
      // The skill goes with the task it ran: the next `/new` starts with none.
      source: null,
      runner: null,
      agentProfile: null,
      // Runner/model/plan-first are a way of working — they survive, as they always did.
      model: 'opus',
      effort: 'max',
      planFirst: true,
      worktree: null,
      autonomous: null,
      archiveWhenDone: false,
      autoMergePr: false,
      allowWorkers: true,
      allowMessaging: true,
    })
  })

  it('normalizes a malformed/older stored value instead of throwing', () => {
    // A cold read (cache null after resetDraft) hitting bad JSON must degrade to EMPTY.
    resetDraft()
    localStorage.setItem('cez-new-task-draft', 'not json at all')
    expect(readDraft()).toEqual({
      text: '',
      source: null,
      runner: null,
      agentProfile: null,
      model: null,
      effort: null,
      planFirst: false,
      worktree: null,
      autonomous: null,
      archiveWhenDone: false,
      autoMergePr: false,
      allowWorkers: true,
      allowMessaging: true,
    })

    resetDraft()
    localStorage.setItem('cez-new-task-draft', '{"text":42,"variants":1,"source":"nope","worktree":"x"}')
    expect(readDraft()).toEqual({
      text: '',
      source: null,
      runner: null,
      agentProfile: null,
      model: null,
      effort: null,
      planFirst: false,
      worktree: null,
      autonomous: null,
      archiveWhenDone: false,
      autoMergePr: false,
      allowWorkers: true,
      allowMessaging: true,
    })
  })
})

describe('composerRunModeNote (#793)', () => {
  // One line per place the run can land. The header used to print the first one unconditionally,
  // so the other two states read as an outright false promise of isolation.
  const cases: Array<{ worktree: boolean; hasGit: boolean; expected: string }> = [
    {
      worktree: true,
      hasGit: true,
      expected: 'Runs in an isolated worktree — review everything before it lands.',
    },
    {
      worktree: false,
      hasGit: true,
      expected: 'Runs in the repo working tree — your checkout is modified directly.',
    },
    {
      worktree: false,
      hasGit: false,
      expected: 'Runs in place — no git repository detected, so there is no worktree to isolate in.',
    },
  ]

  for (const { worktree, hasGit, expected } of cases) {
    it(`worktree=${worktree}, hasGit=${hasGit}`, () => {
      expect(composerRunModeNote({ worktree, hasGit })).toBe(expected)
    })
  }


})
