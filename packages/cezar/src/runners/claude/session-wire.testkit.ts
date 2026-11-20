import { expect } from 'vitest';
import { appendedSystemPrompt, flagValues, stdinPrompts, wireArgv, wireRecord, type SessionWire } from '../../workflows/native-session-wire.testkit.ts';

type Block = { type?: string; text?: string };
const blocksOf = (row: Parameters<typeof wireRecord>[0]) => wireRecord(row)?.blocks as Block[] | undefined;

/** How the Claude mock's recorded command lines show a session, a turn and its effort; its stdin
 *  messages carry the prompts, and a skill trigger is a `/name args` text block. */
export const CLAUDE_SESSION_WIRE: SessionWire = {
  resumed: wire => flagValues(wire, '--resume'),
  freshSessions: wire => flagValues(wire, '--session-id').length,
  started: wire => wire.some(row => wireArgv(row)?.includes('--output-format') === true),
  effort: wire => flagValues(wire, '--effort').at(-1),
  prompts: stdinPrompts,
  steers: () => [],
  systemPrompt: appendedSystemPrompt,
  skillTriggers: ({ args, stdin }, name) => [...args, ...stdin].flatMap(row => {
    const blocks = blocksOf(row);
    return blocks?.some(block => block.text?.startsWith(`/${name}`)) ? [blocks.map(block => block.text ?? '').join('\n')] : [];
  }),
  expectSkillTrigger: ({ args, stdin }, { name, args: skillArgs, context }) => {
    const message = [...args, ...stdin].map(blocksOf).find(Boolean)!;
    expect(message.at(-1)).toEqual({ type: 'text', text: `/${name} ${skillArgs}` });
    if (context) expect(message.slice(0, -1)).toContainEqual({ type: 'text', text: context });
  },
};
