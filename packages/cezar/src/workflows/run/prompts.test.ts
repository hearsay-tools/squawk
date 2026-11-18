import { describe, expect, it } from 'vitest';
import { applyTemplate, resumeNotice, withResumeContext } from './prompts.ts';
import { RUNNER_IDS } from '../../core/agent-runner.ts';

describe('applyTemplate (hearsay-tools/squawk#1207)', () => {
  it('fills every {{task}} with the task text byte for byte, $ patterns included', () => {
    const task = 'a $& $$ $1 $` $\' b';
    expect(applyTemplate('X {{task}} Y {{task}}', task)).toBe(`X ${task} Y ${task}`);
  });
});

describe('resume notice (hearsay-tools/squawk#3882)', () => {
  const checkpoint = { id: 'continue-1', text: 'Continue.', createdAt: '2026-11-18T00:00:00Z',
    resumeContext: { failure: { stepId: 'continue-4', error: 'Credit balance is too low' } } };

  it('tells the agent that subagents stopped and shell commands may have, without naming a runner', () => {
    const notice = resumeNotice(checkpoint)!;
    expect(notice).toContain('The previous step "continue-4" failed: Credit balance is too low');
    expect(notice).toContain('Subagents it started stopped with it. Shell commands it started may have stopped.');
    for (const runner of RUNNER_IDS) expect(notice).not.toMatch(new RegExp(`\\b${runner}\\b`, 'i'));
    expect(withResumeContext('Continue.', checkpoint)).toBe(`${notice}\nContinue.`);
  });

  it('adds nothing to a Continue without a failure or restart', () => {
    expect(resumeNotice({ ...checkpoint, resumeContext: undefined })).toBeUndefined();
    expect(withResumeContext('Continue.', undefined)).toBe('Continue.');
  });
});
