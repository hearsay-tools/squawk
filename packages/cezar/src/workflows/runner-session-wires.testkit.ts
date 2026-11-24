import { existsSync } from 'node:fs';
import { runnerDataRows } from '../core/runner-data-rows.testkit.ts';
import { readMockRecords } from '../mock-records.testkit.ts';
import { FIXTURE_SESSION_WIRE } from '../runners/fixture/session-wire.testkit.ts';
import type { NativeRecording, SessionWire, WireRow } from './native-session-wire.testkit.ts';

// Each built-in runner's reader of its mock's wire (`runners/<id>/session-wire.testkit.ts`). A
// runner without one loads as undefined, so only a test that reads that runner's wire fails, and
// its message names the file to add. This module is apart from `native-session-wire.testkit.ts`,
// which each reader imports: a top-level await in that cycle would never settle.
const SESSION_WIRES: Readonly<Record<string, SessionWire | undefined>> = {
  fixture: FIXTURE_SESSION_WIRE,
  ...(await runnerDataRows<SessionWire | undefined>('session-wire.testkit.ts', id =>
    existsSync(new URL(`../runners/${id}/session-wire.testkit.ts`, import.meta.url))
      ? import(`../runners/${id}/session-wire.testkit.ts`)
      : Promise.resolve({ missing: undefined }))),
};

/** How `runner`'s mock records a session, its prompts and its native skill triggers. */
export function sessionWire(runner: string): SessionWire {
  const wire = SESSION_WIRES[runner];
  if (!wire) throw new Error(`Runner ${runner} has no runners/${runner}/session-wire.testkit.ts: add one that reads how its mock records a session, a turn, its effort, its prompts and its native skill triggers.`);
  return wire;
}

/** Both files a mock recorded; a missing file reads as no rows. */
export function nativeRecording(argsFile: string, stdinFile: string): NativeRecording {
  return { args: readMockRecords<WireRow>(argsFile), stdin: readMockRecords<WireRow>(stdinFile) };
}
