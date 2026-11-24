import { skillMockRunners } from './mock-skill-runners.testkit.ts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const { captures } = await import(/* @vite-ignore */ new URL('../../scripts/mock-skill-trigger-data.mjs', import.meta.url).href) as { captures: Record<string, unknown> };
import { createClaudeUiState, mapClaudeMessage } from '../runners/claude/claude-ui-mapper.ts';
import { createCodexUiState, mapCodexNotification } from '../runners/codex/codex-ui-mapper.ts';
import { createOpencodeUiState, mapOpencodeEvent } from '../runners/opencode/opencode-ui-mapper.ts';
import { createPiUiState, mapPiRpcMessage } from '../runners/pi/pi-ui-mapper.ts';
import { createAntigravityUiState, mapAntigravityFrame } from '../runners/antigravity/antigravity-ui-mapper.ts';
import type { UiEvent } from './ui-events.ts';
import { matchesSkillPrompt } from './pi-rpc-wire.ts';
import { slashSkillPrompt, validSkillMessage } from './skill-trigger.ts';

it('ships a trigger capture for every runner whose mock serves skills, and none for another', () => {
  expect(Object.keys(captures).sort()).toEqual(skillMockRunners().sort());
});
for (const runner of skillMockRunners()) it(`${runner}: packaged mock capture equals its real CLI fixture`, () => {
  expect(captures[runner]).toEqual(JSON.parse(readFileSync(new URL(`../runners/${runner}/__fixtures__/skill-trigger.json`, import.meta.url), 'utf8')));
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

/** These native user echoes must stay out of the UI: Squawk already saved the human input.
 * Omp emits a display item instead; the transcript's full-history tests reconcile that item. */
function mappedSkillEcho<State>(runner: string, state: State, map: (value: unknown, state: State) => { state: State; events: UiEvent[] }): UiEvent[] {
  const frames = JSON.parse(readFileSync(new URL(`../runners/${runner}/__fixtures__/skill-trigger.json`, import.meta.url), 'utf8')) as unknown[];
  return frames.flatMap(frame => {
    const mapped = map(frame, state);
    state = mapped.state;
    return mapped.events;
  });
}

it.each([
  ['claude', () => mappedSkillEcho('claude', createClaudeUiState(), mapClaudeMessage)],
  ['codex', () => mappedSkillEcho('codex', createCodexUiState(), mapCodexNotification)],
  ['opencode', () => mappedSkillEcho('opencode', createOpencodeUiState(), mapOpencodeEvent)],
  ['pi', () => mappedSkillEcho('pi', createPiUiState(), mapPiRpcMessage)],
  ['antigravity', () => mappedSkillEcho('antigravity', createAntigravityUiState(), mapAntigravityFrame)],
] as const)('%s native skill expansion does not duplicate the saved human input', (_runner, events) => {
  expect(events().filter(event => 'item' in event && event.item.kind === 'message' && event.item.role === 'user')).toEqual([]);
});


it.each(['', 'trailing spaces  ', 'literal </skill> args  '])('binds pi native expansion with normalized args %j', args => {
  const prompt = `/skill:probe-project${args ? ` ${args}` : ''}`;
  const content = `<skill name="probe-project" location="/tmp/SKILL.md">body</skill>\n\n${args.trim()}`;
  expect(matchesSkillPrompt({ role: 'user', content }, prompt)).toBe(true);
  expect(matchesSkillPrompt({ role: 'assistant', content }, prompt)).toBe(false);
});
