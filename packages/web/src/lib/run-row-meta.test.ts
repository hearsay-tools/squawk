import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit';
import { WAIT_KIND } from '@open-mercato/cezar-api-client/contract/wait-factories.testkit';
import { describe, expect, it } from 'vitest'
import type { RunSummary } from '@open-mercato/cezar-api-client'
import { deriveAttention, type Attention, type AttentionRung } from '@/lib/attention'
import { metaStateWord, runRowMeta, runRowTitle } from '@/lib/run-row-meta'
import { summaryOf } from '@/test/run-summary-fixture'

const NOW = Date.parse('2026-07-14T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const ahead = (ms: number) => new Date(NOW + ms).toISOString()

function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    ...summaryOf({
      id: 'r1',
      title: 'Task',
      workflow: 'default',
      task: 'task',
      status: RUN_STATUS.done,
      createdAt: ago(60_000),
      tokensUsed: 0,
      archived: false,
      steps: [],
    }),
    ...over,
  }
}

/** The rung of each label below: the state word decides on the rung and prints the label. */
const RUNG_OF: Record<string, AttentionRung> = {
  'needs you': 'needs-you', done: 'done', cancelled: 'cancelled', failed: 'failed', running: 'running',
  'needs review': 'needs-review', 'needs permission': 'needs-permission', 'waiting on 2 workers': 'waiting-on-workers',
  'waiting on worker replies': 'waiting-on-workers', 'waiting on parent reply': 'waiting-on-workers', queued: 'queued',
  'usage limit': 'usage-limit', monitoring: 'monitoring', 'waiting for a command': 'waiting-for-command',
  'waiting for CI': 'waiting-for-ci', 'waiting for merge': 'waiting-for-merge', 'waiting for capacity': 'waiting-for-capacity',
}

/** Only `rung` and `label` are read by the state word; the rest of an attention is the dot's business. */
const labelled = (label: string): Attention => ({ rung: RUNG_OF[label]!, bucket: 'none', tone: 'neutral', shape: 'ring', pulse: false, label })

/** The clock text the meta line prints for a time: the time alone on today's date, the date too otherwise. */
function clockText(at: string): string {
  const sameDay = new Date(at).toDateString() === new Date(NOW).toDateString()
  return new Intl.DateTimeFormat(undefined, sameDay ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at))
}

const timer = (at: string) => ({ kind: WAIT_KIND.timer, waitId: '00000000-0000-4000-8000-0000000000d1', at })
const commandWait = (deadline: string) => ({ kind: WAIT_KIND.process, waitId: '00000000-0000-4000-8000-0000000000d2', pid: 4242, deadline })

describe('metaStateWord (#617: the states the dot alone cannot say)', () => {
  const plain = run()

  it.each(['needs you', 'done', 'cancelled'])('says nothing for %s: the dot is the whole story', (label) => {
    expect(metaStateWord(labelled(label), null, plain, NOW)).toBeUndefined()
  })

  it.each([
    ['failed', 'Failed'],
    ['running', 'Running'],
    ['needs review', 'Needs review'],
    ['needs permission', 'Needs permission'],
    ['waiting on 2 workers', 'Waiting for 2 workers'],
    ['waiting on worker replies', 'Waiting for worker replies'],
    ['waiting on parent reply', 'Waiting for parent reply'],
    ['waiting for CI', 'Waiting for CI'],
    ['waiting for merge', 'Waiting for merge'],
    ['waiting for capacity', 'Waiting for capacity'],
  ])(
    'says the canonical attention label for %s',
    (label, expected) => {
      expect(metaStateWord(labelled(label), null, plain, NOW)).toBe(expected)
    },
  )

  describe('queued', () => {
    it.each([
      [1, 'Queued #1'],
      [2, 'Queued #2'],
      [null, 'Queued'],
    ])('with position %s reads %j', (position, word) => {
      expect(metaStateWord(labelled('queued'), position, plain, NOW)).toBe(word)
    })
  })

  describe('usage limit', () => {
    it.each([
      ['a resume time in the future', ahead(12 * 60_000), 'Usage limit, resumes in 12m'],
      ['a resume time already due', ago(60_000), 'Usage limit'],
      ['no resume time', undefined, 'Usage limit'],
      ['an unreadable resume time', 'soon', 'Usage limit'],
    ])('with %s', (_name, autoResumeAt, word) => {
      expect(metaStateWord(labelled('usage limit'), null, run({ autoResumeAt }), NOW)).toBe(word)
    })
    it('names a provider-error hold (hearsay-tools/squawk#3337)', () => {
      expect(metaStateWord(labelled('usage limit'), null, run({ autoResumeAt: ahead(12 * 60_000), autoResumeReason: 'provider-error' }), NOW))
        .toBe('Provider error, resumes in 12m')
    })
  })

  describe('monitoring', () => {
    it.each([
      ['a timer wait with a readable time', timer(ahead(5 * 60_000)), `Monitoring, next check ${clockText(ahead(5 * 60_000))}`],
      ['a timer wait with an unreadable time', timer('later'), 'Monitoring'],
      ['a wait that is not a timer', commandWait(ahead(60_000)), 'Monitoring'],
      ['no wait at all', undefined, 'Monitoring'],
    ])('with %s', (_name, waitingOn, word) => {
      expect(metaStateWord(labelled('monitoring'), null, run({ waitingOn }), NOW)).toBe(word)
    })

    it.each([undefined, ahead(60_000)])('uses the plugin summary without a timer label for deadline %s', (deadline) => {
      const record = run({ status: RUN_STATUS.waiting, waitingOn: { kind: WAIT_KIND.plugin, pluginKind: 'deploy', waitId: '00000000-0000-4000-8000-0000000000d3', summary: 'Waiting for staging', ...(deadline ? { deadline } : {}) } })
      expect(metaStateWord(deriveAttention(record), null, record, NOW)).toBe('Waiting for staging')
    })

    it('names the timer only for the monitoring label', () => {
      expect(metaStateWord(labelled('running'), null, run({ waitingOn: timer(ahead(5 * 60_000)) }), NOW)).toBe('Running')
    })
  })

  describe('waiting for a command', () => {
    it.each([
      ['a process wait with a readable deadline', commandWait(ahead(30 * 60_000)), `Waiting for command, until ${clockText(ahead(30 * 60_000))}`],
      ['a process wait with an unreadable deadline', commandWait('later'), 'Waiting for command'],
      ['a wait that is not a process', timer(ahead(60_000)), 'Waiting for command'],
      ['no wait at all', undefined, 'Waiting for command'],
    ])('with %s', (_name, waitingOn, word) => {
      expect(metaStateWord(labelled('waiting for a command'), null, run({ waitingOn }), NOW)).toBe(word)
    })

    it('names the deadline only for that label', () => {
      expect(metaStateWord(labelled('running'), null, run({ waitingOn: commandWait(ahead(30 * 60_000)) }), NOW)).toBe('Running')
    })
  })

  it('reads the label of a derived attention, not a literal', () => {
    const failed = run({ status: RUN_STATUS.failed })
    expect(metaStateWord(deriveAttention(failed), null, failed, NOW)).toBe('Failed')
  })
})

describe('runRowMeta (#617, #729: what the meta line is made of)', () => {
  const base = { queuePosition: null, inWorkingGroup: false, scope: null, now: NOW }
  const meta = (over: Partial<Parameters<typeof runRowMeta>[0]> & { run: RunSummary }) =>
    runRowMeta({ attention: deriveAttention(over.run), ...base, ...over })

  describe('the age', () => {
    it('counts from creation while the run is unfinished', () => {
      expect(meta({ run: run({ status: RUN_STATUS.running, createdAt: ago(5 * 60_000) }) }).age).toBe('5m')
    })

    it('counts from the finish once there is one', () => {
      expect(meta({ run: run({ createdAt: ago(3 * 3_600_000), finishedAt: ago(2 * 60_000) }) }).age).toBe('2m')
    })

    it('is empty for a queued row, whose position rides in the state word', () => {
      const queued = run({ status: RUN_STATUS.queued })
      expect(meta({ run: queued, queuePosition: 3 })).toMatchObject({ age: '', stateWord: 'Queued #3' })
    })
  })

  describe('the state word', () => {
    it.each([
      ['a running row elsewhere', false, 'running', 'Running'],
      ['a running row in the Working group, where the group says it', true, 'running', undefined],
      ['a row that is not running, in the Working group', true, 'monitoring', 'Monitoring'],
    ])('for %s', (_name, inWorkingGroup, label, word) => {
      const attention = labelled(label)
      expect(meta({ run: run({ status: RUN_STATUS.running }), attention, inWorkingGroup }).stateWord).toBe(word)
    })

    it('is the state word of the attention', () => {
      const failed = run({ status: RUN_STATUS.failed })
      expect(meta({ run: failed }).stateWord).toBe(metaStateWord(deriveAttention(failed), null, failed, NOW))
    })
  })

  describe('the references', () => {
    // A row from the all-projects list carries its project even though `RunSummary` does not type it.
    const numbered = Object.assign(run({ prNumber: 594, issueNumber: 12 }), { projectId: 'own' })

    it('lists the pull request before the issue', () => {
      expect(meta({ run: numbered }).references.map((ref) => `${ref.kind} ${ref.number}`)).toEqual(['PR 594', 'Issue 12'])
    })

    it('belongs to the run\'s own project when the row has no explicit scope', () => {
      expect(meta({ run: numbered, scope: null }).references.map((ref) => ref.projectId)).toEqual(['own', 'own'])
    })

    it('belongs to the row\'s explicit scope, for a non-active project\'s row', () => {
      expect(meta({ run: numbered, scope: 'other' }).references.map((ref) => ref.projectId)).toEqual(['other', 'other'])
    })

    it('is empty for a run that references nothing', () => {
      expect(meta({ run: run() }).references).toEqual([])
    })
  })

  describe('the key that tells the line its content changed', () => {
    it.each([
      ['age', {}, { finishedAt: ago(5 * 60_000) }],
      ['pull request', {}, { prNumber: 594 }],
      ['pull request number', { prNumber: 594 }, { prNumber: 595 }],
      ['issue number', { issueNumber: 12 }, { issueNumber: 13 }],
      ['issue beside a pull request', { prNumber: 594 }, { prNumber: 594, issueNumber: 12 }],
      ['reference URL', { prNumber: 594 }, { prNumber: 594, pullRequestUrl: 'https://github.com/acme/repo/pull/594' }],
      ['hand-off', {}, { notify: true }],
    ] satisfies Array<[string, Partial<RunSummary>, Partial<RunSummary>]>)('changes when the %s changes', (_name, before, after) => {
      expect(meta({ run: run(after) }).key).not.toBe(meta({ run: run(before) }).key)
    })

    it('changes with the state word', () => {
      const running = run({ status: RUN_STATUS.running })
      const failed = run({ status: RUN_STATUS.failed, createdAt: running.createdAt })
      expect(meta({ run: running }).key).not.toBe(meta({ run: failed }).key)
    })
  })
})

describe('runRowTitle (#788, option C: the reference replaces the NNN: prefix)', () => {
  it('drops the prefix when the reference is the same number', () => {
    expect(runRowTitle(run({ title: '594: Fix the login bug', prNumber: 594 }))).toEqual({
      title: '594: Fix the login bug',
      displayTitle: 'Fix the login bug',
    })
  })

  it('keeps the prefix when the reference is another number: an issue that shipped as a different PR', () => {
    expect(runRowTitle(run({ title: '788: Fix the login bug', prNumber: 790 })).displayTitle).toBe('788: Fix the login bug')
  })

  it('keeps the prefix when the run has no reference', () => {
    expect(runRowTitle(run({ title: '594: Fix the login bug' })).displayTitle).toBe('594: Fix the login bug')
  })

  it('leaves a title with no prefix alone', () => {
    expect(runRowTitle(run({ title: 'fix: the login bug', prNumber: 594 })).displayTitle).toBe('fix: the login bug')
  })

  it('titles the row with the summary where there is one, and strips the prefix from that', () => {
    const titled = run({ title: 'raw', titleSummary: '594: Fix the login bug', titleOrigin: 'user', prNumber: 594 })
    expect(runRowTitle(titled)).toEqual({ title: '594: Fix the login bug', displayTitle: 'Fix the login bug' })
  })
})
