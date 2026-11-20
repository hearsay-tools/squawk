import { flagValues, wireArgv, type SessionWire } from '../../workflows/native-session-wire.testkit.ts';

/** How the OMP mock's recorded command lines show a session, a turn and its effort. */
export const OMP_SESSION_WIRE: SessionWire = {
  resumed: wire => flagValues(wire, '--resume'),
  freshSessions: wire => wire.filter(row => wireArgv(row)?.includes('--mode') === true && !wireArgv(row)!.includes('--resume')).length,
  started: wire => wire.some(row => wireArgv(row)?.includes('--mode') === true),
  effort: wire => flagValues(wire, '--thinking').at(-1),
};
