import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const { captures } = await import(/* @vite-ignore */ new URL('../../scripts/mock-skill-trigger-data.mjs', import.meta.url).href) as { captures: Record<string, unknown> };
import { RUNNER_IDS } from './agent-runner.ts';
import { slashSkillPrompt, validSkillMessage } from './skill-trigger.ts';

for (const runner of RUNNER_IDS) it(`${runner}: packaged mock capture equals its real CLI fixture`, () => {
  expect(captures[runner]).toEqual(JSON.parse(readFileSync(new URL(`./__fixtures__/${runner}/skill-trigger.json`, import.meta.url), 'utf8')));
});

describe('skill message boundaries', () => {
  it('keeps the trigger first and refuses a second trigger', () => {
    const skill = { type: 'skill' as const, id: 'probe-project', args: 'args' };
    expect(validSkillMessage([skill, { type: 'text', text: 'context' }])).toBe(true);
    expect(validSkillMessage([{ type: 'text', text: 'context' }, skill])).toBe(false);
    expect(validSkillMessage([skill, skill])).toBe(false);
  });
  it.each(['', '\nnext line', ' \nnext line'])('keeps pi arguments on the trigger line for %j', args => {
    expect(slashSkillPrompt({ id: 'probe-project', args }, 'context')).toMatch(/^\/skill:probe-project Continue\./);
    expect(slashSkillPrompt({ id: 'probe-project', args }, 'context')).toContain('\n\ncontext');
  });
});
