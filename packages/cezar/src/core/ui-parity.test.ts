import { mockRows } from './runner-mock-rows.testkit.ts';
import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
/**
 * Backend-parity roll-up — the spec's hard rule made executable.
 *
 * The spec (`.ai/specs/2026-07-14-cockpit-ui-redesign.md` §"Backend parity
 * requirement") demands that every capability in the parity matrix is
 * emitted by EVERY backend, so the GUI degrades per-capability, never
 * per-backend. This table test asserts it over the golden fixtures' expected
 * outputs (the hand-verified wire-faithful contract for each mapper): if a
 * future mapper change drops a capability — or a new fixture set forgets to
 * cover one — a named row fails here.
 *
 * `BACKENDS` lists every backend that owns a wire mapper. Pi uses its documented
 * RPC protocol and therefore has its own wire-faithful fixture set; so does OMP, whose RPC
 * extends Pi's with its own turn boundary and sub-agent frames.
 *
 * This file is one of TWO parity matrices, and they split by axis: this one asks
 * what a mapper EMITS, over the golden fixtures. Its sibling
 * `harness-parity.test.ts` asks what a runner DOES — session lifecycle,
 * provider-failure surfacing, `sendMessage`, ask routing, park declarations —
 * by driving the real runner classes. A new backend must pass both
 * (`AGENT_PROTOCOL.md` §6 and §7).
 */
import '../core/register-all-runners.testkit.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runnersWhere } from './runner-facts.ts';
import type { UiEvent, UiItem } from './ui-events.ts';


const HERE = dirname(fileURLToPath(import.meta.url));
const BACKENDS = BUILT_IN_RUNNER_IDS;

/** Every event across every golden fixture of one backend. */
function fixtureEvents(backend: string): UiEvent[] {
  const dir = join(HERE, '..', 'runners', backend, '__fixtures__');
  const events: UiEvent[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.expected.json')) continue;
    events.push(...(JSON.parse(readFileSync(join(dir, file), 'utf8')) as UiEvent[]));
  }
  return events;
}

function items(events: UiEvent[]): UiItem[] {
  return events
    .filter(
      (e): e is Extract<UiEvent, { type: 'item.started' | 'item.updated' | 'item.completed' }> =>
        e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed',
    )
    .map((e) => e.item);
}

function hasToolStatus(events: UiEvent[], status: string): boolean {
  return items(events).some((item) => item.kind === 'tool' && item.status === status);
}

const BACKGROUND_ROW = 'background sub-agent task items (task_notification / subAgentActivity completed)';

/** The parity matrix (spec §"Backend parity requirement"): capability →
 *  predicate over a backend's full v2 fixture output. */
const CAPABILITIES: ReadonlyArray<[name: string, produced: (events: UiEvent[]) => boolean, criterion?: string]> = [
  [
    'plan.updated with entries (TodoWrite / todoList / todowrite)',
    (events) => events.some((e) => e.type === 'plan.updated' && e.entries.length > 0),
    'UI1',
  ],
  ['tool status: running', (events) => hasToolStatus(events, 'running')],
  ['tool status: completed', (events) => hasToolStatus(events, 'completed')],
  ['tool status: failed', (events) => hasToolStatus(events, 'failed')],
  // Non-empty is the point: a reasoning item with no text renders as a dead
  // "Thinking —" row, so presence alone is not parity (#528).
  [
    'reasoning items (thinking / reasoning items / reasoning parts)',
    (events) => items(events).some((item) => item.kind === 'reasoning' && item.text.trim() !== ''),
  ],
  [
    'structured diffs (Edit input / fileChange.changes / patch parts)',
    (events) => items(events).some((item) => item.kind === 'tool' && (item.diffs?.length ?? 0) > 0),
  ],
  [
    'sub-agent task items (Task / review-mode items / subtask parts)',
    (events) => items(events).some((item) => item.kind === 'tool' && item.toolKind === 'task'),
  ],
  [
    'usage.updated with raw token counts',
    (events) => events.some((e) => e.type === 'usage.updated' && e.usage.total > 0),
  ],
  [
    'turn.completed with per-turn directional usage',
    (events) =>
      events.some(
        (e) => e.type === 'turn.completed' && (e.usage?.input ?? 0) > 0 && (e.usage?.output ?? 0) > 0,
      ),
  ],
  ['turn.completed with a stopReason', (events) => events.some((e) => e.type === 'turn.completed' && e.stopReason !== undefined)],
  ['hook items (hook_response / hook/completed)', (events) => items(events).some((item) => item.kind === 'hook'), 'UI2'],
  // hearsay-tools/cezarion#2431: a child that outlives its spawn call keeps its root task item
  // running, marked `background`, and completes it once when the child ends.
  [BACKGROUND_ROW, (events) => {
    const background = items(events).filter((item): item is Extract<UiItem, { kind: 'tool' }> =>
      item.kind === 'tool' && item.background === true && item.parentItemId === undefined);
    return background.some((item) => item.status === 'running') && background.some((item) => item.status !== 'running');
  }],
] as const;

/** hearsay-tools/cezarion#2431: only a runner whose declared `nativeSubagents` is `reported`
 * reports a backgrounded child's end. On a `turn-held` wire no child outlives a parent turn; on
 * an `unreported` wire no child end arrives, and the run keeps the monitoring timer. The inverse
 * assertion keeps a fabricated background item from erasing the gap.
 */
const NO_BACKGROUND_SUBAGENTS = new Set(runnersWhere(facts => facts.nativeSubagents !== 'reported'));

describe('protocol v2 backend parity (every mapper emits every matrix capability)', () => {
  for (const backend of BACKENDS) {
    const events = fixtureEvents(backend);
    for (const [name, produced, criterion] of CAPABILITIES) {
      const gap = criterion ? mockRows()[backend]!.parityExemptions?.[criterion] : undefined;
      if (gap) {
        it(`${backend} explicitly lacks ${name} (${gap.reason})`, () => {
          expect(gap.kind).toBe('capability-absent');
          expect(produced(events)).toBe(false);
        });
        continue;
      }
      if (name === BACKGROUND_ROW && NO_BACKGROUND_SUBAGENTS.has(backend)) {
        it(`${backend} explicitly lacks ${name} (no child outlives a parent turn on its wire)`, () => {
          expect(produced(events)).toBe(false);
          expect(items(events).some((item) => item.kind === 'tool' && item.background === true)).toBe(false);
        });
        continue;
      }
      it(`${backend} produces ${name}`, () => {
        expect(produced(events)).toBe(true);
      });
    }
  }

  // Sub-agent NESTING rides on parentItemId where the declared `childWork` is `nested`; each
  // runner's facts row names the wire field that attributes child work to its parent call.
  for (const backend of runnersWhere(facts => facts.childWork === 'nested')) {
    it(`${backend} nests sub-agent work via parentItemId`, () => {
      expect(items(fixtureEvents(backend)).some((item) => item.parentItemId !== undefined)).toBe(true);
    });
  }
  // A `none` wire carries no child-session transcript, so nothing can nest.
  for (const backend of runnersWhere(facts => facts.childWork === 'none')) {
    it(`${backend} explicitly lacks sub-agent nesting (its wire has no child-session transcript)`, () => {
      expect(items(fixtureEvents(backend)).some((item) => item.parentItemId !== undefined)).toBe(false);
    });
  }
});
