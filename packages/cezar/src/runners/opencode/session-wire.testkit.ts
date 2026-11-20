import { wireRecord, type SessionWire } from '../../workflows/native-session-wire.testkit.ts';

/** How the OpenCode server mock's recorded HTTP requests show a session, a turn and its effort. */
export const OPENCODE_SESSION_WIRE: SessionWire = {
  resumed: wire => wire.flatMap((row) => {
    const rec = wireRecord(row);
    const match = rec?.method === 'GET' && typeof rec.url === 'string' ? /^\/session\/([^/]+)$/.exec(rec.url) : null;
    return match ? [match[1]!] : [];
  }),
  freshSessions: wire => wire.filter(row => wireRecord(row)?.method === 'POST' && wireRecord(row)?.url === '/session').length,
  started: wire => wire.some(row => typeof wireRecord(row)?.url === 'string' && String(wireRecord(row)!.url).includes('prompt_async')),
  effort: wire => wire.flatMap((row) => {
    const rec = wireRecord(row);
    return typeof rec?.url === 'string' && rec.url.includes('prompt_async') ? [(rec.body as { variant?: string }).variant] : [];
  }).at(-1),
};
