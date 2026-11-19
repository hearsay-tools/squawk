import { STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it } from 'vitest';
import { executionAccount } from './execution-account.ts';

/** A usage limit closes the account a step RAN on, which a mixed-runner workflow can set apart from
 *  the task-level `runner` (hearsay-tools/cezarion#1236). */
describe('executionAccount', () => {
  const step = (backend: 'claude' | 'codex', profileId?: string) =>
    ({ id: `s-${backend}`, name: 's', kind: STEP_KIND.agent, status: STEP_STATUS.failed, iterations: 1, tokensUsed: 0, sessionId: `sess-${backend}`, backend, profileId });

  it('reads the latest session step, not the task-level runner', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: undefined, steps: [step('codex'), step('claude', 'second')] }))
      .toEqual({ runner: 'claude', agentProfile: 'second' });
  });

  it('reads a newer session step saved without a backend as the run runner\'s, on that step\'s account', () => {
    // A step from before backend affinity belongs to the run's runner, as `latestSession` reads it.
    const codex = { ...step('codex', 'old'), startedAt: '2026-11-16T00:00:01Z' };
    const legacy = { id: 's-legacy', name: 's', kind: STEP_KIND.agent, status: STEP_STATUS.failed, iterations: 1, tokensUsed: 0,
      sessionId: 'sess-legacy', profileId: 'legacy-account', startedAt: '2026-11-16T00:00:02Z' };
    expect(executionAccount({ runner: 'claude', agentProfile: 'work', steps: [codex, legacy] }))
      .toEqual({ runner: 'claude', agentProfile: 'legacy-account' });
  });

  it('falls back to the record before any session exists', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: 'work', steps: [] })).toEqual({ runner: 'codex', agentProfile: 'work' });
  });

  it('takes a continuation that switches backend at its word, on the run account', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: undefined, steps: [step('codex', 'other')] }, { backend: 'claude' }))
      .toEqual({ runner: 'claude', agentProfile: undefined });
  });

  it('takes the account a Continue selected on the same backend, which starts a new session', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: 'new', steps: [step('codex', 'old')] }, { backend: 'codex' }))
      .toEqual({ runner: 'codex', agentProfile: 'new' });
  });

  it('takes the account of the session a continuation resumes', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: 'new', steps: [step('codex', 'old')] }, { backend: 'codex', sessionId: 'sess-codex' }))
      .toEqual({ runner: 'codex', agentProfile: 'old' });
  });

  it('prefers a live session\'s own settings', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: undefined, steps: [step('codex')] }, undefined, { runner: 'claude', agentProfile: 'default' }))
      .toEqual({ runner: 'claude', agentProfile: 'default' });
  });
});
