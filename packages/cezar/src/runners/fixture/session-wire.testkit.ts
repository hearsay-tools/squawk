import { appendedSystemPrompt, appendedSystemPrompts, flagValues, stdinPrompts, wireArgv, type SessionWire } from '../../workflows/native-session-wire.testkit.ts';

/** How the fixture mock's recorded command lines and stdin messages show a session and its prompts. */
export const FIXTURE_SESSION_WIRE: SessionWire = {
  resumed: wire => flagValues(wire, '--resume'),
  freshSessions: wire => flagValues(wire, '--session-id').length,
  started: wire => wire.some(row => wireArgv(row) !== undefined),
  effort: () => undefined,
  prompts: stdinPrompts,
  steers: () => [],
  systemPrompt: appendedSystemPrompt,
  systemPrompts: appendedSystemPrompts,
  skillTriggers: () => [],
  expectSkillTrigger: () => { throw new Error('The fixture runner has no native skill trigger'); },
  expectCiWire: () => {},
  expectSquawkToolAdmission: () => {},
};
