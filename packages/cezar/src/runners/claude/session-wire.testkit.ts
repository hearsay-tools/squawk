import { flagValues, wireArgv, type SessionWire } from '../../workflows/native-session-wire.testkit.ts';

/** How the Claude mock's recorded command lines show a session, a turn and its effort. */
export const CLAUDE_SESSION_WIRE: SessionWire = {
  resumed: wire => flagValues(wire, '--resume'),
  freshSessions: wire => flagValues(wire, '--session-id').length,
  started: wire => wire.some(row => wireArgv(row)?.includes('--output-format') === true),
  effort: wire => flagValues(wire, '--effort').at(-1),
};
