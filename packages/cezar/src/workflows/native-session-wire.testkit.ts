// What a runner's mock records on its wire (`CEZ_MOCK_ARGS_FILE`, one JSON row per line), and the
// shape of the reader each runner keeps in `runners/<id>/session-wire.testkit.ts`. Read by
// `native-session-continue.test.ts`.

/** One recorded row: an argv array (a launch) or an object (a JSON-RPC or HTTP request). */
export type WireRow = Record<string, unknown> | unknown[];

/** How a runner's native wire shows a resumed session, a fresh one, a started turn and its effort. */
export interface SessionWire {
  resumed(wire: WireRow[]): string[];
  freshSessions(wire: WireRow[]): number;
  started(wire: WireRow[]): boolean;
  effort(wire: WireRow[]): string | undefined;
}

export function wireRecord(row: WireRow): Record<string, unknown> | undefined {
  return Array.isArray(row) ? undefined : row;
}

export function wireArgv(row: WireRow): string[] | undefined {
  return Array.isArray(row) ? row.map(String) : undefined;
}

/** Each value of `flag` across the recorded command lines. */
export function flagValues(wire: WireRow[], flag: string): string[] {
  return wire.flatMap((row) => {
    const args = wireArgv(row);
    const at = args?.indexOf(flag) ?? -1;
    return at >= 0 ? [args![at + 1]!] : [];
  });
}
