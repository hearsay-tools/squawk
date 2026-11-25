import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { describe, expect, it } from 'vitest';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { registerBundledRunners } from '../core/bundled-runners.testkit.ts';
import type { RunRecord } from '../runs/store.ts';
import { runAccountFor } from './run-accounts.ts';
import { providerForExistingRun } from './provider-action-gate.ts';

await registerBundledRunners();
sealTestRunners();

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-1',
  title: 'Task',
  workflow: 'quick-task',
  task: 'Task',
  status: RUN_STATUS.done,
  createdAt: '2026-11-23T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...overrides,
});

/** The start gate checks the account the engine continues on (hearsay-tools/squawk#4116). */
describe('runAccountFor', () => {
  it('uses the run account for a fresh turn on the run runner after another runner held the session', () => {
    const mixed = run({
      runner: 'claude',
      agentProfile: 'work',
      steps: [{ id: 'b', name: 'B', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 0, tokensUsed: 0, backend: 'codex', sessionId: 's-codex', startedAt: '2026-11-23T00:01:00.000Z' }],
   });
    expect(runAccountFor(mixed, 'claude')).toBe('work');
    // The run account differs from the codex session's (`default`): a switch to codex starts fresh.
    expect(runAccountFor(mixed, 'codex')).toBeUndefined();
    // Without a run account a switch to the session's runner resumes on the session's account.
    expect(runAccountFor({ ...mixed, agentProfile: undefined }, 'codex', { original: 'claude', target: 'codex' })).toBe('default');
  });

  it('resumes the session account, and the run account when it differs', () => {
    const steps = [{ id: 'a', name: 'A', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 0, tokensUsed: 0, backend: 'claude', sessionId: 's1', profileId: 'old', startedAt: '2026-11-23T00:01:00.000Z' }];
    expect(runAccountFor(run({ runner: 'claude', steps}), 'claude')).toBe('old');
    expect(runAccountFor(run({ runner: 'claude', agentProfile: 'work', steps}), 'claude')).toBe('work');
  });

  it('uses the project selection when a runner switch starts a fresh session', () => {
    // The run account differs from the codex session's account: the engine starts fresh and a runner
    // switch clears the run account, so codex runs on the project's selection.
    const switched = run({
      runner: 'claude',
      agentProfile: 'work',
      steps: [{ id: 'b', name: 'B', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 0, tokensUsed: 0, backend: 'codex', sessionId: 's-codex', profileId: 'x', startedAt: '2026-11-23T00:01:00.000Z' }],
    });
    const toCodex = { original: 'claude', target: 'codex' };
    expect(runAccountFor(switched, 'codex', toCodex)).toBeUndefined();
    expect(runAccountFor({ ...switched, agentProfile: undefined }, 'codex', toCodex)).toBe('x');
  });

  it('applies the runner switch before resolving an untouched workflow\'s steps', () => {
    // The switch clears the run account, so an explicit claude step runs on the project's selection.
    const untouched = run({ runner: 'claude', agentProfile: 'work' });
    const toCodex = { original: 'claude', target: 'codex' };
    expect(runAccountFor(untouched, 'claude', toCodex)).toBeUndefined();
    expect(runAccountFor(untouched, 'codex', toCodex)).toBeUndefined();
    // Without a switch the run's runner keeps the run account.
    expect(runAccountFor(untouched, 'claude', { original: 'claude', target: 'claude' })).toBe('work');
  });

  it('leaves any other provider to the project selection', () => {
    expect(runAccountFor(run({ runner: 'claude', agentProfile: 'work' }), 'codex')).toBeUndefined();
  });

  it('uses the continued worker step runner and account on a mixed-account worker chain', () => {
    const worker = run({
      runner: 'codex',
      agentProfile: 'default',
      delegation: {
        role: 'worker',
        parentRunId: '11111111-2222-4333-8444-555555555555',
        permissions: ['inspect'],
        workspace: {
          kind: 'owned-isolated',
          ownerRunId: 'run-1',
          resourceId: 'res-1',
          path: '/repo/.worktrees/run-1',
          branch: 'cez/run-1',
          baselineSha: '0123456789abcdef0123456789abcdef01234567',
        },
      },
      workflowDef: {
        name: 'mixed',
        source: 'file',
        steps: [
          { id: 'implement', prompt: 'impl', runner: 'codex', agentProfile: 'default' },
          { id: 'review', prompt: 'rev', runner: 'claude', agentProfile: 'work', model: 'opus' },
        ],
      },
      workflowCursor: { mode: 'resume', stepId: 'review' },
      steps: [
        { id: 'implement', name: 'Implement', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 1, tokensUsed: 0, backend: 'codex', profileId: 'default', sessionId: 's-codex', startedAt: '2026-11-23T00:01:00.000Z' },
        { id: 'review', name: 'Review', kind: STEP_KIND.agent, status: STEP_STATUS.failed, iterations: 1, tokensUsed: 0, backend: 'claude', profileId: 'work', startedAt: '2026-11-23T00:02:00.000Z' },
      ],
    });
    expect(providerForExistingRun(worker)).toBe('claude');
    expect(runAccountFor(worker, 'claude')).toBe('work');
    expect(runAccountFor(worker, 'claude', { original: 'codex', target: 'claude' }, true)).toBe('work');
    expect(runAccountFor(worker, 'codex', { original: 'codex', target: 'codex' }, true)).toBe('default');
  });
});
