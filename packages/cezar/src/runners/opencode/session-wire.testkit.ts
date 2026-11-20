import { expect } from 'vitest';
import { joinedParts, wireRecord, type WireRow, type SessionWire } from '../../workflows/native-session-wire.testkit.ts';

const urlOf = (row: WireRow) => { const url = wireRecord(row)?.url; return typeof url === 'string' ? url : ''; };
const bodyOf = (row: WireRow) => wireRecord(row)?.body as { parts?: unknown; command?: string; arguments?: string; variant?: string } | undefined;

/** How the OpenCode server mock's recorded HTTP requests show a session, a turn and its effort;
 *  `message` and `prompt_async` bodies carry the prompts, and a skill trigger is a `command` request. */
export const OPENCODE_SESSION_WIRE: SessionWire = {
  resumed: wire => wire.flatMap((row) => {
    const rec = wireRecord(row);
    const match = rec?.method === 'GET' && typeof rec.url === 'string' ? /^\/session\/([^/]+)$/.exec(rec.url) : null;
    return match ? [match[1]!] : [];
  }),
  freshSessions: wire => wire.filter(row => wireRecord(row)?.method === 'POST' && wireRecord(row)?.url === '/session').length,
  started: wire => wire.some(row => urlOf(row).includes('prompt_async')),
  effort: wire => wire.flatMap(row => urlOf(row).includes('prompt_async') ? [bodyOf(row)!.variant] : []).at(-1),
  prompts: ({ args }) => args.flatMap(row => /\/(message|prompt_async)$/.test(urlOf(row)) && bodyOf(row)?.parts ? [joinedParts(bodyOf(row)!.parts)] : []),
  // In-thread: the system prompt opens the first prompt.
  steers: () => [],
  systemPrompt: recording => OPENCODE_SESSION_WIRE.prompts(recording)[0] ?? '',
  skillTriggers: ({ args, stdin }, name) => [...args, ...stdin].flatMap(row =>
    urlOf(row).endsWith('/command') && (name === undefined || bodyOf(row)?.command === name) ? [bodyOf(row)!.arguments ?? ''] : []),
  expectSkillTrigger: ({ args, stdin }, { name, args: skillArgs, context }) => {
    const rows = [...args, ...stdin];
    const command = bodyOf(rows.find(row => urlOf(row).endsWith('/command'))!);
    expect(command).toMatchObject({ command: name, arguments: expect.stringContaining(skillArgs) });
    if (context) expect(command!.arguments).toContain(context);
    expect(rows.some(row => urlOf(row).endsWith('/prompt_async'))).toBe(false);
  },
};
