import { expect } from 'vitest';
import { appendedSystemPrompt, appendedSystemPrompts, flagValues, isCommand, stdinPrompts, wireArgv, wireRecord, type SessionWire } from '../../workflows/native-session-wire.testkit.ts';

type Block = { type?: string; text?: string };
const blocksOf = (row: Parameters<typeof wireRecord>[0]) => wireRecord(row)?.blocks as Block[] | undefined;

/** How the Claude mock's recorded command lines show a session, a turn and its effort; its stdin
 *  messages carry the prompts, and a skill trigger is a message whose last text block is `/name args`. */
export const CLAUDE_SESSION_WIRE: SessionWire = {
  resumed: wire => flagValues(wire, '--resume'),
  freshSessions: wire => flagValues(wire, '--session-id').length,
  started: wire => wire.some(row => wireArgv(row)?.includes('--output-format') === true),
  effort: wire => flagValues(wire, '--effort').at(-1),
  prompts: stdinPrompts,
  steers: () => [],
  systemPrompt: appendedSystemPrompt,
  systemPrompts: appendedSystemPrompts,
  skillTriggers: ({ args, stdin }, name) => [...args, ...stdin].flatMap(row => {
    const blocks = blocksOf(row);
    const command = blocks?.at(-1)?.text;
    const invoked = name === undefined ? command?.startsWith('/') === true : isCommand(command, `/${name}`);
    return invoked ? [blocks!.map(block => block.text ?? '').join('\n')] : [];
  }),
  expectSkillTrigger: ({ args, stdin }, { name, args: skillArgs, context }) => {
    const message = [...args, ...stdin].map(blocksOf).find(Boolean)!;
    expect(message.at(-1)).toEqual({ type: 'text', text: `/${name} ${skillArgs}` });
    if (context) expect(message.slice(0, -1)).toContainEqual({ type: 'text', text: context });
  },
  expectCiWire: (rows) => {
    expect(wireArgv(rows[0]!)).toContain('--mcp-config');
  },
  expectSquawkToolAdmission: (rows, { serverName, expectedTools, exact }) => {
    const argv = wireArgv(rows[0]!)!;
    const allowed = argv[argv.indexOf('--allowedTools') + 1]!.split(',');
    const prefix = `mcp__${serverName}__`;
    const actual = allowed.filter(name => name.startsWith(prefix));
    const expected = expectedTools.map(name => `${prefix}${name}`);
    expect(actual).toEqual(exact ? expected : expect.arrayContaining(expected));
  },
};
