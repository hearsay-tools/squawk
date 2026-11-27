import { expect } from 'vitest';
import { runnerGolden, shippedScriptPath } from '../../core/runner-golden.testkit.ts';
import { joinedParts, systemFromPrepended, wireRecord, type WireRow, type SessionWire } from '../../workflows/native-session-wire.testkit.ts';

const urlOf = (row: WireRow) => { const url = wireRecord(row)?.url; return typeof url === 'string' ? url : ''; };
const bodyOf = (row: WireRow) => wireRecord(row)?.body as { parts?: unknown; command?: string; arguments?: string; variant?: string; permission?: unknown } | undefined;

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
  systemPrompts: ({ args }) => args.flatMap(row => {
    const url = urlOf(row);
    if (url.endsWith('/command')) {
      const argsText = bodyOf(row)?.arguments;
      return typeof argsText === 'string' ? [argsText] : [];
    }
    if (url.includes('prompt_async')) {
      const parts = bodyOf(row)?.parts as Array<{ text?: string }> | undefined;
      const text = parts?.[0]?.text;
      return typeof text === 'string' ? [systemFromPrepended(text)] : [];
    }
    return [];
  }),
  skillTriggers: ({ args, stdin }, name) => [...args, ...stdin].flatMap(row =>
    urlOf(row).endsWith('/command') && (name === undefined || bodyOf(row)?.command === name) ? [bodyOf(row)!.arguments ?? ''] : []),
  expectSkillTrigger: ({ args, stdin }, { name, args: skillArgs, context }) => {
    const rows = [...args, ...stdin];
    const command = bodyOf(rows.find(row => urlOf(row).endsWith('/command'))!);
    expect(command).toMatchObject({ command: name, arguments: expect.stringContaining(skillArgs) });
    if (context) expect(command!.arguments).toContain(context);
    expect(rows.some(row => urlOf(row).endsWith('/prompt_async'))).toBe(false);
  },
  expectCiWire: (rows, { descriptor, governed, backend }) => {
    const config = rows.map(wireRecord).find(row => row?.type === 'runtime-config')?.config as { mcp?: Record<string, { command?: unknown }>; plugin?: unknown } | undefined;
    expect(config?.mcp?.[descriptor.name]?.command).toEqual([descriptor.command, ...descriptor.args]);
    if (governed) expect(config?.plugin).toEqual(runnerGolden(backend, 'runtimePlugins').map(shippedScriptPath));
  },
  expectSquawkToolAdmission: () => {},
  expectGovernedWire: (ordinary, governed, _resume, backend) => {
    // A runtime plugin (OpenCode's task scope) rides the runtime config; no session rule is sent.
    const config = governed.map(wireRecord).find(row => row?.type === 'runtime-config')?.config as { plugin?: unknown } | undefined;
    expect(config?.plugin).toEqual(runnerGolden(backend, 'runtimePlugins').map(shippedScriptPath));
    expect(ordinary.some(row => wireRecord(row)?.type === 'runtime-config')).toBe(false);
    const requests = (rows: WireRow[]) => rows.filter(row => wireRecord(row)?.type !== 'runtime-config');
    expect(requests(governed)).toEqual(requests(ordinary));
    expect(governed.filter(row => wireRecord(row)?.method === 'PATCH')).toEqual([]);
    expect(governed.filter(row => wireRecord(row)?.method === 'POST' && wireRecord(row)?.url === '/session').every(row => bodyOf(row)?.permission === undefined)).toBe(true);
  },
};
