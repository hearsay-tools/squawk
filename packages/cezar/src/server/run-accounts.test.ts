import { describe, expect, it } from 'vitest';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { registerBuiltInRunners } from '../runners/built-in.ts';
import type { RunRecord } from '../runs/store.ts';
import { runAccountFor } from './run-accounts.ts';

registerBuiltInRunners();

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
    // Without a run account the session's provider resumes on the session's account.
    expect(runAccountFor({ ...mixed, agentProfile: undefined }, 'codex')).toBe('default');
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
    expect(runAccountFor(switched, 'codex')).toBeUndefined();
    expect(runAccountFor({ ...switched, agentProfile: undefined }, 'codex')).toBe('x');
  });

  it('leaves any other provider to the project selection', () => {
    expect(runAccountFor(run({ runner: 'claude', agentProfile: 'work' }), 'codex')).toBeUndefined();
  });
});
