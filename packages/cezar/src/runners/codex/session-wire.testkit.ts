import { expect } from 'vitest';
import { joinedParts, systemFromPrepended, wireRecord, type WireRow, type SessionWire } from '../../workflows/native-session-wire.testkit.ts';

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
  systemPrompts: ({ args }) => args.flatMap(row => {
    const text = turnInput(row)?.[0]?.text;
    return typeof text === 'string' ? [systemFromPrepended(text)] : [];
  }),
  skillTriggers: ({ args, stdin }, name) => [...args, ...stdin].flatMap(row => {
    const input = turnInput(row);
    return input?.some(item => item.type === 'skill' && (name === undefined || item.name === name)) ? [joinedParts(input)] : [];
  }),
  expectSkillTrigger: ({ args, stdin }, { name, args: skillArgs, context }) => {
    const input = [...args, ...stdin].map(turnInput).find(items => items?.some(item => item.type === 'skill'))!;
    expect(input).toContainEqual(expect.objectContaining({ type: 'skill', name, path: expect.stringContaining('SKILL.md') }));
    expect(input[0]!.text).toContain(skillArgs);
    if (context) expect(input[0]!.text).toContain(context);
  },
  expectCiWire: (rows, { descriptor, resume, governed }) => {
    const method = resume ? 'thread/resume' : 'thread/start';
    const config = (rows.map(wireRecord).find(row => row?.method === method)?.params as { config?: Record<string, unknown> } | undefined)?.config;
    expect(config).toBeDefined();
    if (governed) expect(config!['features.agent_message_board']).toBe(false);
    // hearsay-tools/cezarion#1294: Codex asks before every MCP tool call unless the
    // server's mode is `approve`; approval_policy stays the user's (#381).
    expect(config![`mcp_servers.${descriptor.name}`]).toEqual({
      command: descriptor.command, args: descriptor.args,
      env_vars: ['CEZ_TOOL_TOKEN', 'CEZ_TOOL_SOCKET', 'CEZ_AUTOMATIONS'],
      default_tools_approval_mode: 'approve',
    });
    expect(config).not.toHaveProperty('approval_policy');
  },
  expectSquawkToolAdmission: () => {},
  expectGovernedWire: (ordinary, governed, resume) => {
    const method = resume ? 'thread/resume' : 'thread/start';
    const normal = ordinary.map(wireRecord).find(row => row?.method === method)!.params as Record<string, unknown>;
    const controlled = governed.map(wireRecord).find(row => row?.method === method)!.params as Record<string, unknown>;
    expect(controlled.config).toEqual({ 'features.agent_message_board': false });
    const { config: _config, ...rest } = controlled;
    expect(rest).toEqual(normal);
    expect(normal).not.toHaveProperty('config');
  },
};
