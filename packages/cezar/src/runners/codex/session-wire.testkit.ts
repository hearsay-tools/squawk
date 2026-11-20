import { wireRecord, type SessionWire } from '../../workflows/native-session-wire.testkit.ts';

/** How the Codex app-server mock's recorded JSON-RPC requests show a thread, a turn and its effort. */
export const CODEX_SESSION_WIRE: SessionWire = {
  resumed: wire => wire.flatMap(row => wireRecord(row)?.method === 'thread/resume'
    ? [String((wireRecord(row)!.params as { threadId?: string }).threadId)] : []),
  freshSessions: wire => wire.filter(row => wireRecord(row)?.method === 'thread/start').length,
  started: wire => wire.some(row => wireRecord(row)?.method === 'turn/start'),
  effort: wire => wire.flatMap(row => wireRecord(row)?.method === 'turn/start'
    ? [(wireRecord(row)!.params as { effort?: string }).effort] : []).at(-1),
};
