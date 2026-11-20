import { BUILT_IN_RUNNER_IDS } from '../../runners/ids.ts';
import { describe, expect, it } from 'vitest';
import { applyTemplate, resumeNotice, withResumeContext } from './prompts.ts';
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
    for (const runner of BUILT_IN_RUNNER_IDS) expect(notice).not.toMatch(new RegExp(`\\b${runner}\\b`, 'i'));
    expect(withResumeContext('Continue.', checkpoint)).toBe(`${notice}\nContinue.`);
  });

  it('adds nothing to a Continue without a failure or restart', () => {
    expect(resumeNotice({ ...checkpoint, resumeContext: undefined })).toBeUndefined();
    expect(withResumeContext('Continue.', undefined)).toBe('Continue.');
  });
});

describe('restart resume names the cut-off work (hearsay-tools/squawk#3909)', () => {
  const restarted = { id: 'continue-2', text: 'Continue.', createdAt: '2026-11-18T00:00:00Z',
    resumeContext: { restarted: true as const, cutOff: { tools: ['Bash: Ran npm run prepr'], subagents: ['Agent: Docs sweep'] } } };

  it('names each tool call without a result and each lost subagent', () => {
    const notice = resumeNotice(restarted)!;
    expect(notice).toContain('The restart cut off these tool calls, which have no result: Bash: Ran npm run prepr.');
    expect(notice).toContain('These native subagents were still running and stopped: Agent: Docs sweep.');
  });

  it('keeps the general restart notice when nothing was cut off', () => {
    const notice = resumeNotice({ ...restarted, resumeContext: { restarted: true } })!;
    expect(notice).toContain('process restarted while you were working');
    expect(notice).not.toContain('cut off');
  });
});
