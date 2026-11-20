import { expect } from 'vitest';
import { joinedParts, wireRecord, type WireRow, type SessionWire } from '../../workflows/native-session-wire.testkit.ts';

type InputItem = { type?: string; text?: string; name?: string; path?: string };
/** The input of a recorded `turn/start`, or undefined for any other row. */
const turnInput = (row: WireRow) => wireRecord(row)?.method === 'turn/start'
  ? (wireRecord(row)!.params as { input?: InputItem[] } | undefined)?.input : undefined;

/** How the Codex app-server mock's recorded JSON-RPC requests show a thread, a turn and its effort;
 *  `turn/start` input carries the prompts, and a skill trigger is a `skill` input item. */
export const CODEX_SESSION_WIRE: SessionWire = {
  resumed: wire => wire.flatMap(row => wireRecord(row)?.method === 'thread/resume'
    ? [String((wireRecord(row)!.params as { threadId?: string }).threadId)] : []),
  freshSessions: wire => wire.filter(row => wireRecord(row)?.method === 'thread/start').length,
  started: wire => wire.some(row => wireRecord(row)?.method === 'turn/start'),
  effort: wire => wire.flatMap(row => wireRecord(row)?.method === 'turn/start'
    ? [(wireRecord(row)!.params as { effort?: string }).effort] : []).at(-1),
  prompts: ({ args }) => args.flatMap(row => { const input = turnInput(row); return input ? [joinedParts(input)] : []; }),
  steers: ({ args }) => args.flatMap(row => {
    const input = wireRecord(row)?.method === 'turn/steer' ? (wireRecord(row)!.params as { input?: InputItem[] } | undefined)?.input : undefined;
    return input ? [joinedParts(input)] : [];
  }),
  // In-thread: the system prompt opens the first prompt.
  systemPrompt: recording => CODEX_SESSION_WIRE.prompts(recording)[0] ?? '',
  skillTriggers: ({ args, stdin }, name) => [...args, ...stdin].flatMap(row => {
    const input = turnInput(row);
    return input?.some(item => item.type === 'skill' && item.name === name) ? [joinedParts(input)] : [];
  }),
  expectSkillTrigger: ({ args, stdin }, { name, args: skillArgs, context }) => {
    const input = [...args, ...stdin].map(turnInput).find(items => items?.some(item => item.type === 'skill'))!;
    expect(input).toContainEqual(expect.objectContaining({ type: 'skill', name, path: expect.stringContaining('SKILL.md') }));
    expect(input[0]!.text).toContain(skillArgs);
    if (context) expect(input[0]!.text).toContain(context);
  },
};
