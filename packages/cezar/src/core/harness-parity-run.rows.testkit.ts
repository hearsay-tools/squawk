import { expect } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import { exemptionFor, HARNESS_ADAPTERS, type HarnessAdapter } from './harness-parity-core.testkit.ts';
import type { CellBody, HarnessGroup, HarnessRegistrar, ObservedCell } from './harness-parity-registrar.testkit.ts';
import { PROVIDER_HOLD_ROW_IDS, RUN_ROWS } from './harness-parity-rows.testkit.ts';
import { runRows, type RunRowCell } from './harness-parity-run-tier.rows.testkit.ts';
import type { RunObservation } from './workflow-parity-core.testkit.ts';

/** The opencode skill and provider failures that stay fatal, fresh and continued. */
export const OPENCODE_FATAL_SCENARIOS = ['unscoped-provider-failure', 'scoped-skill-failure', 'scoped-frontmatter-failure'] as const;
export type OpencodeFatalScenario = typeof OPENCODE_FATAL_SCENARIOS[number];

/** What R50 reads: the parked run after a headless open, after a restart, and after its answer. */
export type OwnerObservation = { afterHeadless: string | undefined; afterRestart: string | undefined; answered: { ok: boolean; error?: string }; final: RunRecord | undefined };

/** The run part's cell bodies, which `harness-parity-run.cells.testkit.ts` holds, by row id. */
export type RunCells = {
  readonly R44: (backend: string) => ObservedCell<RunObservation>;
  readonly R45: (backend: string) => ObservedCell<RunObservation>;
  readonly R46: (backend: string) => CellBody;
  readonly opencodeFatal: (continuation: boolean, scenario: OpencodeFatalScenario) => CellBody;
  readonly runRow: RunRowCell;
  readonly R15: (backend: string) => CellBody;
  readonly R77: (backend: string) => CellBody;
  readonly R26: (backend: string, ask: HarnessAdapter['askResumeCases'][number]) => CellBody;
  readonly R130: (backend: string) => CellBody;
  readonly R36: (backend: string) => CellBody;
  readonly R37: (backend: string) => CellBody;
  readonly R38: (backend: string) => CellBody;
  readonly R39: (backend: string) => CellBody;
  readonly R40: (backend: string) => CellBody;
  readonly PR1: (backend: string) => CellBody;
  readonly PR2: (backend: string) => CellBody;
  readonly R50: (backend: string) => ObservedCell<OwnerObservation>;
};

/** The run part's groups, apart from its bodies so a registration guard loads no run engine. */
export function runGroups(cells: RunCells) {
  return {
    diagnostics(r: HarnessRegistrar) {
      const { describeRunners, runners, it, scope, parityRow } = r;
      describeRunners('diagnostics', 'harness parity — recoverable skill diagnostics (hearsay-tools/cezarion#723, hearsay-tools/cezarion#1265)', () => {
        for (const backend of runners) {
          for (const continuation of [false, true]) {
            const id = continuation ? 'R45' : 'R44';
            const cell = cells[id](backend);
            parityRow<RunObservation>(backend, {
              id, name: `${id} ${continuation ? 'continued' : 'fresh'} skill warnings preserve successful completion`, scenario: 'skill-warning',
              assert: cell.assert,
            }, cell.observe);
          }
          it(`${backend} R46 continued provider failures stay fatal and actionable`, cells.R46(backend), 45_000);
        }
        if (scope === 'once') {
          for (const continuation of [false, true]) for (const scenario of OPENCODE_FATAL_SCENARIOS) {
            it(`opencode ${continuation ? 'continued' : 'fresh'} ${scenario} remains fatal`, cells.opencodeFatal(continuation, scenario), 45_000);
          }
        }
      }, true);
    },

    run(r: HarnessRegistrar) {
      const { describeRunners } = r;
      describeRunners('run', 'harness parity — run tier', () => runRows(r, RUN_ROWS.filter(row => !PROVIDER_HOLD_ROW_IDS.includes(row.id)), cells.runRow));
    },

    // #121/#401: release native child frames only AFTER the manager has parked.
    // Waiting for the final wire-derived event prevents a green test that returned
    // before the late frames were read. A runner whose golden says `postParkChildFrames:
    // "discarded"` (OpenCode) drops closed child scopes; its mock's passive usage barrier
    // (total 424242) proves those frames crossed the transport.
    child(r: HarnessRegistrar) {
      const { describeRunners, runners, it } = r;
      describeRunners('child', 'harness parity — late child attention', () => {
        for (const backend of runners) {
          const exempt = exemptionFor('R15', backend);
          if (exempt) {
            it(`${backend} is exempt from R15 — ${exempt.reason}`, () => {
              expect(exempt.kind).toBe('scenario-unconstructible');
              expect(HARNESS_ADAPTERS[backend]!.scenarios['subagent-after-park']!).toBeUndefined();
            });
            continue;
          }
          it(`${backend} R15 keeps its monitoring wake after post-park child items`, cells.R15(backend), 60_000);
        }
      });
    },

    // #961: native hook frames reach the event log and nothing else. A hook that
    // completes after the run parked (Squeal's async `waiter`) must neither wake the
    // run, move its wake time, nor open a turn; the mid-turn hook must not end one.
    hooks(r: HarnessRegistrar) {
      const { describeRunners, runners, it } = r;
      describeRunners('hooks', 'harness parity — hooks never move run state', () => {
        for (const backend of runners) {
          const exempt = exemptionFor('R77', backend);
          if (exempt) {
            it(`${backend} is exempt from R77 — ${exempt.reason}`, () => {
              expect(exempt.kind).toBe('scenario-unconstructible');
              expect(HARNESS_ADAPTERS[backend]!.scenarios['hook-after-park']!).toBeUndefined();
            });
            continue;
          }
          it(`${backend} R77 keeps a parked run parked through mid-turn and late hook items`, cells.R77(backend), 60_000);
        }
      });
    },

    // #398: a native answer's turn boundary must not ask the human to prompt again.
    // R6 deliberately tests markerless owned-input draining; it cannot prove completion.
    answer(r: HarnessRegistrar) {
      const { describeRunners, runners, it } = r;
      describeRunners('answer', 'harness parity — answer to completion run tier', () => {
        for (const backend of runners) {
          const exempt = exemptionFor('R26', backend);
          if (exempt) {
            it(`${backend} is exempt from R26 — ${exempt.reason}`, () => {
              expect(exempt.kind).toBe('scenario-unconstructible');
              expect(HARNESS_ADAPTERS[backend]!.askResumeCases).toEqual([]);
              expect(HARNESS_ADAPTERS[backend]!.scenarios['ask-resume']!).toBeUndefined();
            });
            continue;
          }
          for (const ask of HARNESS_ADAPTERS[backend]!.askResumeCases) {
            it(`${backend} R26 completes after ${ask.kind} without another needs-you park`, cells.R26(backend, ask), 45_000);
          }
        }
        // hearsay-tools/squawk#1293: the parent's answer reopens the closed worker through a
        // continuation, and the mock asks again in the answer's turn: natively where nativeAsk is
        // answerable, through cezar_ask otherwise. That question waits on its own human wait.
        for (const backend of runners) {
          it(`${backend} R130 a question asked in its answer's turn gets its own human wait`, cells.R130(backend), 45_000);
        }
      });
    },

    // #399 incident: issue Agent context, run 3a3c1ffa (original history unavailable).
    // Prompt delivery is the contract under test; these offline wires cannot prove
    // that a live model follows the instruction. Markerless output must still wait.
    // hearsay-tools/cezarion#1234: every runner honors squawkTools, so every session here is taught
    // the lifecycle tools instead of the markers.
    monitoring(r: HarnessRegistrar) {
      const { describeRunners, runners, it } = r;
      describeRunners('monitoring', 'harness parity — monitoring wrap-up contract (#399)', () => {
        for (const backend of runners) {
          for (const continued of [false, true]) {
            it(`${backend} ${continued ? 'R37 Continue' : 'R36 fresh'} receives the shared monitoring wrap-up contract`, cells[continued ? 'R37' : 'R36'](backend), 60_000);
          }
          it(`${backend} R38 restart recovery receives the shared monitoring wrap-up contract`, cells.R38(backend), 60_000);
          // A cezar_wait timer's wake reaches each native message channel as its result text with the
          // next-step instruction, never as a user message (hearsay-tools/cezarion#2397: the marker
          // monitoring park this cell drove is gone; MONITORING_WAKE_NUDGE now answers only Claude's
          // ScheduleWakeup and the live-workers timer).
          it(`${backend} R39 a timer wake delivers its result and next-step instruction on the native message channel`, cells.R39(backend), 60_000);
          it(`${backend} R40 completion prose without a marker still parks waiting`, cells.R40(backend), 60_000);
        }
      });
    },

    // hearsay-tools/cezarion#922: every task-owned declaration, through each native runner wire.
    prs(r: HarnessRegistrar) {
      const { describeRunners, runners, it } = r;
      describeRunners('prs', 'harness parity — multi-pr collection', () => {
        for (const backend of runners) {
          for (const continuation of [false, true]) {
            it(`${backend} ${continuation ? 'PR2' : 'PR1'} multi-pr retains fresh and continued declarations`, cells[continuation ? 'PR2' : 'PR1'](backend), 150_000);
          }
        }
      });
    },

    // hearsay-tools/cezarion#779 plan step 3: `serve` and a headless `cez run` open one runs.db.
    // A headless open (no keepLive) must leave a parked run owned by another live process alone.
    owner(r: HarnessRegistrar) {
      const { describeRunners, runners, parityRow } = r;
      describeRunners('owner', 'harness parity — a second process leaves a parked run to its owner (hearsay-tools/cezarion#779)', () => {
        for (const backend of runners) {
          const cell = cells.R50(backend);
          parityRow<OwnerObservation>(backend, {
            id: 'R50', name: 'R50 a headless open beside the owner leaves its parked run waiting, and a restart still answers it', scenario: 'ask',
            assert: cell.assert,
          }, cell.observe);
        }
      });
    },
  } satisfies Readonly<Record<string, HarnessGroup>>;
}
