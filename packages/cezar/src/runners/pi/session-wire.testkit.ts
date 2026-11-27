import { expect } from 'vitest';
import { appendedSystemPrompt, appendedSystemPrompts, expectSlashSkillTrigger, flagValues, slashSkillTriggers, stdinPrompts, wireArgv, type SessionWire } from '../../workflows/native-session-wire.testkit.ts';

/** How the pi mock's recorded command lines show a session, a turn and its effort; its stdin
 *  messages carry the prompts, and a skill trigger is a `/skill:name args` message. */
export const PI_SESSION_WIRE: SessionWire = {
  resumed: wire => flagValues(wire, '--session'),
  freshSessions: wire => flagValues(wire, '--session-id').length,
  started: wire => wire.some(row => wireArgv(row)?.includes('--mode') === true),
  effort: wire => flagValues(wire, '--thinking').at(-1),
  prompts: stdinPrompts,
  steers: () => [],
  systemPrompt: appendedSystemPrompt,
  systemPrompts: appendedSystemPrompts,
  skillTriggers: slashSkillTriggers,
  expectSkillTrigger: expectSlashSkillTrigger,
  expectCiWire: (rows) => {
    expect(wireArgv(rows[0]!)!.filter(item => item === '--extension')).toHaveLength(4);
  },
  expectSquawkToolAdmission: (rows, { expectedTools, exact }) => {
    const argv = wireArgv(rows[0]!)!;
    // hearsay-tools/cezarion#1305: pi's default list sends no allowlist, so the extension's tools stay active.
    if (!argv.includes('--tools')) { expect(argv).toContain('--no-builtin-tools'); return; }
    const actual = argv[argv.indexOf('--tools') + 1]!.split(',').filter(name => name.startsWith('cezar_'));
    expect(actual).toEqual(exact ? expectedTools : expect.arrayContaining([...expectedTools]));
  },
};
