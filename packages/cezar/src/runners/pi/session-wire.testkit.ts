import { flagValues, wireArgv, type SessionWire } from '../../workflows/native-session-wire.testkit.ts';

/** How the pi mock's recorded command lines show a session, a turn and its effort. */
export const PI_SESSION_WIRE: SessionWire = {
  resumed: wire => flagValues(wire, '--session'),
  freshSessions: wire => flagValues(wire, '--session-id').length,
  started: wire => wire.some(row => wireArgv(row)?.includes('--mode') === true),
  effort: wire => flagValues(wire, '--thinking').at(-1),
};
